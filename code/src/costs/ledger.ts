/**
 * The spend ledger: one append-only JSONL file that records every billed model call and every
 * sandbox lifetime, from every process and every account. Shell code: it touches the file
 * system and reads wall time, but only through the injected clock (`deps.now`).
 *
 * Keys never reach this file. `account` must be a key fingerprint (`sha256:` + 12 hex),
 * `claude-cli` or `local`, so a raw key fails validation before anything is written.
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { assertNever } from '#lib/never';
import { costBasisSchema } from './basis.ts';

export const PROVIDERS = ['anthropic', 'claude-cli', 'boat', 'openshell', 'sbx'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const SPEND_KINDS = ['model_call', 'sandbox'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

/** A key fingerprint, the claude CLI transport, or a local sandbox. Anything else is refused. */
export const ACCOUNT_RE = /^(sha256:[0-9a-f]{12}|claude-cli|local)$/;

const count = z.int().nonnegative();
const amount = z.number().nonnegative();
const boatUsageSliceSchema = z.object({ since: z.iso.datetime(), until: z.iso.datetime(), billableSeconds: z.number().finite().nonnegative(),
  listPriceUsd: z.number().finite().nonnegative(), secondsPerDollar: z.number().finite().positive(), sandboxType: z.enum(['small', 'default', 'large']), running: z.literal(false) })
  .refine(r => r.since < r.until && Math.abs(r.listPriceUsd - r.billableSeconds / r.secondsPerDollar) <= 0.000001);

/** What a line costs: exact (a model call's reported usd), estimated (sandbox time at a rate), or unpriced (no rate known, usd null). */
const pricing = z.union([z.boolean(), z.literal('unpriced')]);

/** The note an unpriced boat line carried before `estimated: 'unpriced'` existed, when it was written as usd 0. */
export const LEGACY_UNPRICED_NOTE = 'set BOAT_USD_PER_COMPUTE_HOUR';

/** A legacy boat line priced at $0 for want of a rate is read as unpriced, and a legacy line for a VM left running as a checkpoint. */
function upgradeLegacy(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const legacy = Reflect.get(raw, 'usd') === 0 && Reflect.get(raw, 'estimated') === true && Reflect.get(raw, 'note') === LEGACY_UNPRICED_NOTE;
  const priced = legacy ? { ...raw, usd: null, estimated: 'unpriced' } : raw;
  const note = Reflect.get(priced, 'note');
  // Legacy live checkpoints identify themselves in the note; a failed start alone is not evidence of a live VM.
  const pending = Reflect.get(priced, 'kind') === 'sandbox' && Reflect.get(priced, 'closed') !== true && Reflect.get(priced, 'checkpoint') === undefined &&
    typeof note === 'string' && note.includes('sandbox may still be running');
  return pending ? { ...priced, checkpoint: true } : priced;
}

export const partialModelUsageSchema = z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count.optional(), cacheWrite1hTokens: count.optional(), observedCostUsd: z.number().finite().nonnegative(), costBasis: costBasisSchema.optional() });

/** One line of the ledger. Unknown keys are stripped on read, so older readers accept newer lines. */
export const spendEventSchema = z.preprocess(
  upgradeLegacy,
  z
    .object({
      t: z.iso.datetime(),
      provider: z.enum(PROVIDERS),
      account: z.string().regex(ACCOUNT_RE, 'account must be a key fingerprint (sha256:<12 hex>), claude-cli or local'),
      kind: z.enum(SPEND_KINDS),
      runId: z.string().optional(),
      step: z.string().optional(),
      model: z.string().optional(),
      partialModelUsage: partialModelUsageSchema.optional(),
      inputTokens: count.optional(),
      outputTokens: count.optional(),
      cacheReadTokens: count.optional(),
      cacheWriteTokens: count.optional(), cacheWrite1hTokens: count.optional(),
      sandboxId: z.string().optional(),
      size: z.string().optional(),
      seconds: amount.optional(),
      multiplier: amount.optional(),
      /** null exactly when `estimated` is 'unpriced'. */
      usd: amount.nullable(),
      estimated: pricing,
      costBasis: costBasisSchema.optional(),
      /** True when the call failed but was still billed, or a sandbox lifecycle step failed. */
      failed: z.boolean().optional(),
      checkpoint: z.literal(true).optional(),
      closed: z.literal(true).optional(),
      /** Set by `costs release --usd`: the operator states the claim's final cost, so it replaces the claim's unknown create checkpoints (A-286). */
      stated: z.literal(true).optional(),
      reservationId: z.uuid().optional(),
      entryId: z.uuid().optional(),
      lifetime: z.object({ from: z.iso.datetime(), to: z.iso.datetime(), usdPerComputeHour: amount.nullable() }).optional(),
      boatUsage: boatUsageSliceSchema.safeExtend({ priceBasis: z.literal('provider_list_usage'), inspectionAccount: z.string().regex(/^sha256:[0-9a-f]{12}$/), walletId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional() }).optional(),
      note: z.string().optional(),
      /** The pinned Boat organization (wallet) a sandbox line bills to (A-247): organization metadata, not an invoice. */
      walletId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
      /** Set on read, never written: the admitted bound of a closed model claim whose final billing is unknown. Caps count it; totals do not. */
      exposureUsd: amount.optional(),
    })
    .refine((e) => e.costBasis === undefined || (e.kind === 'model_call' && e.usd !== null && e.estimated === true), { message: 'client model cost bases are estimates, not provider invoice amounts', path: ['costBasis'] })
    .refine(e => e.partialModelUsage === undefined || (e.kind === 'model_call' && e.usd === null && e.estimated === 'unpriced'), { message: 'partial model usage is observed lower-bound evidence, never final spending' })
    .refine(e => e.boatUsage === undefined || (e.provider === 'boat' && e.kind === 'sandbox' && e.estimated === true && e.usd === e.boatUsage.listPriceUsd && e.seconds === undefined && e.multiplier === undefined && e.lifetime === undefined), { message: 'Boat usage is a list-price estimate with billable units, separate from wall-time estimates' })
    .refine((e) => e.closed !== true || (e.kind === 'sandbox' && e.checkpoint !== true), { message: 'confirmed closure applies only to terminal sandbox events', path: ['closed'] })
    .refine((e) => e.lifetime === undefined || (e.kind === 'sandbox' && (e.usd === null) === (e.lifetime.usdPerComputeHour === null)), { message: 'lifetime pricing applies only to sandbox events and must match the cost status', path: ['lifetime'] })
    .refine((e) => (e.usd === null) === (e.estimated === 'unpriced'), { message: "usd is null exactly when estimated is 'unpriced'", path: ['usd'] })
    .refine((e) => e.stated !== true || (e.usd !== null && e.checkpoint !== true), { message: 'a stated cost is a priced close', path: ['stated'] }),
);
export type SpendEvent = Readonly<z.output<typeof spendEventSchema>>;
/** What callers record. The ledger stamps `t` from its clock. */
export type SpendInput = Omit<SpendEvent, 't'>;

export type TotalsFilter = {
  /** ISO date (`2026-10-06`, UTC midnight) or datetime. Events at or after it count. */
  readonly since?: string | undefined;
  readonly provider?: Provider | undefined;
  readonly account?: string | undefined;
};
export type Totals = {
  /** Priced usd only. Unpriced time is never counted as $0; it is in `unpricedSeconds`. */
  readonly usd: number;
  readonly events: number;
  /** Events whose usd is an estimate (sandbox time priced from a configured rate). */
  readonly estimated: number;
  /** Events with no price (usd null). */
  readonly unpriced: number;
  /** Seconds across all events: model call latency, sandbox lifetimes. */
  readonly seconds: number;
  /** Seconds of the unpriced events. */
  readonly unpricedSeconds: number;
  /** Lines skipped because they were not valid spend events. */
  readonly corrupt: number;
};

export type LedgerDeps = {
  /** Epoch milliseconds. Defaults to the wall clock. */
  readonly now?: (() => number) | undefined;
};

export interface Ledger {
  readonly path: string;
  /** The ledger's clock, shared by guard() and the meters so one fake clock drives a test. */
  now(): number;
  /** Validates, stamps `t` and appends one line. Throws on an invalid event; nothing is written then. */
  record(e: SpendInput): SpendEvent;
  /** Validates and appends an event that already has its `t`, such as one recorded inside a sandbox. */
  append(e: SpendEvent): SpendEvent;
  read(): { readonly events: readonly SpendEvent[]; readonly corrupt: number; readonly foreign: number; readonly reservations: readonly Reservation[] };
  reserve(input: ReservationInput): Reservation;
  startModel(input: ModelClaimInput): { readonly id: string; readonly maxCostUsd: number | undefined };
  bindReservation(id: string, sandboxId: string, startedAt?: number): void;
  releaseReservation(id: string): void;
  /**
   * Closes an abandoned claim, such as one whose process was killed: with `usd` as its final cost, or
   * with unknown billing, which caps then count at the claim's bound. Inventory observations refuse.
   */
  releaseClaim(id: string, usd?: number, estimated?: boolean): SpendEvent;
  /** Records a rate decision that prices every earlier unpriced sandbox line of `provider` with recorded seconds. Returns how many it priced. */
  repriceUnpriced(provider: Provider, usdPerComputeHour: number, note: string): number;
  recoverLifetime(input: RecoveryInput): string;
  observeSandbox(input: ObservationInput): string;
  markSandboxClosed(id: string, sandboxId: string): void;
  reconcileSandbox(input: ReconciliationInput): void;
  totals(filter?: TotalsFilter): Totals;
}

/** USD rounded to a billionth of a dollar, the precision costOf in llm.ts uses. */
export const roundUsd = (n: number): number => Math.round(n * 1e9) / 1e9;

/** `WORLDGEN_COSTS_FILE`, else `~/.worldgen/costs.jsonl`. Never inside the repo by default. */
export function ledgerPath(env: Readonly<Record<string, string | undefined>>, home: string = homedir()): string {
  const fromEnv = env['WORLDGEN_COSTS_FILE'];
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : path.join(home, '.worldgen', 'costs.jsonl');
}

/** The UTC calendar day of an epoch-ms instant, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/** Epoch ms of a `since` value. Throws on anything that is not an ISO date or datetime. */
export function parseSince(since: string): number {
  const ms = DATE_RE.test(since) ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`since must be an ISO date like 2026-10-06, got "${since}"`);
  return ms;
}

/** True when the file is non-empty and its last byte is not a newline, i.e. a writer died mid-line. */
function endsMidLine(file: string): boolean {
  if (!existsSync(file)) return false;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function parseLines(text: string): JournalState {
  const events: SpendEvent[] = [];
  let corrupt = 0;
  let foreign = 0;
  const reservations = new Map<string, Reservation>();
  const denied = new Map<string, Error>();
  const ids = new Set<string>();
  const lifecycles = new Map<string, { reservation: Reservation; boundary?: number; closed: boolean; unknownClose?: SpendEvent }>();
  /** Drops the unknown create checkpoints of claim `id` that never named a VM, and says how many there were. */
  const dropUnbound = (id: string): number => {
    let dropped = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const prior = events[i];
      if (prior !== undefined && prior.reservationId === id && prior.usd === null && prior.checkpoint === true && prior.sandboxId === undefined) {
        events.splice(i, 1);
        dropped += 1;
      }
    }
    return dropped;
  };
  const accept = (raw: SpendEvent): void => {
    if (raw.reservationId === undefined) { events.push(raw); return; }
    const life = lifecycles.get(raw.reservationId);
    if (life === undefined || life.reservation.provider !== raw.provider || life.reservation.account !== raw.account || life.reservation.kind !== raw.kind || (raw.sandboxId !== undefined && life.reservation.sandboxId !== undefined && raw.sandboxId !== life.reservation.sandboxId)) { corrupt += 1; return; }
    if (life.closed) {
      // A stated cost also replaces the claim's unknown create checkpoints, which a close made before it left behind (A-286).
      const dropped = raw.stated === true ? dropUnbound(raw.reservationId) : 0;
      // A priced settle after an unknown-cost close is better evidence: it replaces that close and its bound (A-164).
      if (life.unknownClose !== undefined && raw.usd !== null && raw.checkpoint !== true) {
        const at = events.indexOf(life.unknownClose);
        if (at >= 0) events.splice(at, 1, raw);
        delete life.unknownClose;
      } else if (dropped > 0) events.push(raw);
      return;
    }
    if (life.reservation.origin === 'inventory') { corrupt += 1; return; }
    let event = raw;
    if (raw.lifetime !== undefined) {
      const from = Math.max(Date.parse(raw.lifetime.from), life.boundary ?? Date.parse(raw.lifetime.from));
      const to = Date.parse(raw.lifetime.to);
      const seconds = Math.max(0, (to - from) / 1000);
      const rate = raw.lifetime.usdPerComputeHour;
      event = { ...raw, seconds, usd: rate === null ? null : roundUsd(seconds / 3600 * (raw.multiplier ?? 1) * rate) };
      life.boundary = Math.max(life.boundary ?? to, to);
    }
    const closes = event.checkpoint !== true && (event.usd !== null || event.kind === 'sandbox' || life.reservation.kind === 'model_call');
    if (closes && event.usd === null && life.reservation.kind === 'model_call') {
      const bound = claimBound(life.reservation);
      if (bound !== undefined) event = { ...event, exposureUsd: bound };
      life.unknownClose = event;
    }
    events.push(event);
    if (closes) {
      // A priced lifetime from the provider's creation time covers an unknown create, and so does a stated cost (A-286).
      if (event.usd !== null && life.reservation.kind === 'sandbox' && (event.stated === true || (life.reservation.startedAt !== undefined && life.reservation.sandboxPricing?.idempotentCreate === true))) {
        dropUnbound(raw.reservationId);
      }
      life.closed = true;
      reservations.delete(life.reservation.id);
    } else if (event.usd !== null && life.reservation.remainingUsd !== null) {
      life.reservation = { ...life.reservation, remainingUsd: roundUsd(Math.max(0, life.reservation.remainingUsd - event.usd)) };
      reservations.set(life.reservation.id, life.reservation);
    }
  };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    const parsed = spendEventSchema.safeParse(json);
    if (parsed.success) { accept(parsed.data); continue; }
    const operation = reservationOperationSchema.safeParse(json);
    if (!operation.success) {
      // A newer writer's op is foreign, not corrupt (A-201): a new op may only make an older reader more conservative.
      const opName = json !== null && typeof json === 'object' ? Reflect.get(json, 'op') : undefined;
      if (typeof opName === 'string' && !KNOWN_OPS.has(opName)) foreign += 1;
      else corrupt += 1;
      continue;
    }
    const op = operation.data;
    if (op.op === 'reserve' || op.op === 'start_model') {
      if (ids.has(op.id)) { corrupt += 1; continue; }
      ids.add(op.id);
      try {
        if (corrupt > 0) throw new Error('cost admission refused: the ledger contains corrupt or incomplete records');
        const maxCostUsd = checkExposure(events, [...reservations.values()], op.caps, Date.parse(op.t), op.kind, op.op === 'reserve' ? op.boundUsd : 0);
        let reservation: Reservation;
        if (op.op === 'reserve') reservation = { ...op, remainingUsd: op.boundUsd };
        else {
          // A bounded claim is a known obligation, so concurrent capped calls admit while their bounds fit.
          const allowance = op.allowanceUsd === undefined ? undefined : maxCostUsd === undefined ? op.allowanceUsd : Math.min(op.allowanceUsd, maxCostUsd);
          reservation = { ...op, boundUsd: null, remainingUsd: allowance ?? null, maxCostUsd: allowance ?? maxCostUsd };
        }
        reservations.set(op.id, reservation);
        lifecycles.set(op.id, { reservation, closed: false });
      } catch (error) {
        denied.set(op.id, error instanceof Error ? error : new Error('cost admission refused'));
      }
    } else if (op.op === 'observe') {
      if (ids.has(op.id)) { corrupt += 1; continue; }
      ids.add(op.id);
      const existing = [...reservations.values()].find(r => r.provider === op.provider && r.kind === 'sandbox' && r.sandboxId === op.sandboxId);
      if (existing !== undefined) {
        const { closedAt: _closedAt, ...active } = existing;
        const updated = { ...active, caps: effectiveCaps(op.caps, [existing]) };
        reservations.set(existing.id, updated);
        const life = lifecycles.get(existing.id);
        if (life !== undefined) life.reservation = updated;
      } else {
        const reservation: Reservation = { ...op, origin: 'inventory', accountBasis: 'inspection_key', boundUsd: null, remainingUsd: null };
        reservations.set(op.id, reservation);
        lifecycles.set(op.id, { reservation, closed: false });
      }
    } else if (op.op === 'mark_closed') {
      const reservation = reservations.get(op.id);
      if (reservation?.origin !== 'inventory' || reservation.sandboxId !== op.sandboxId || op.t < reservation.t) { corrupt += 1; continue; }
      const updated = { ...reservation, closedAt: reservation.closedAt !== undefined && reservation.closedAt > op.t ? reservation.closedAt : op.t };
      reservations.set(op.id, updated);
      const life = lifecycles.get(op.id);
      if (life !== undefined) life.reservation = updated;
    } else if (op.op === 'reconcile_sandbox') {
      if (ids.has(op.id)) continue;
      ids.add(op.id);
      try {
        if (corrupt > 0) throw new Error('Boat reconciliation refused: the ledger contains corrupt records');
        const reservation = reservations.get(op.reservationId);
        if (reservation === undefined && lifecycles.get(op.reservationId)?.closed === true) continue;
        if (reservation?.origin !== 'inventory' || reservation.sandboxId !== op.sandboxId || reservation.closedAt !== op.closedAt) throw new Error('Boat reconciliation refused: verified closure is missing or changed');
        if ([...reservations.values()].some(r => r.id !== reservation.id && r.provider === 'boat' && r.sandboxId === op.sandboxId)) throw new Error('Boat reconciliation refused: another live claim names this VM');
        const matches = (e: SpendEvent) => e.provider === 'boat' && e.kind === 'sandbox' && e.sandboxId === op.sandboxId;
        const covered = (e: SpendEvent) => e.lifetime === undefined ? e.t >= op.createdAt && e.t <= op.closedAt : e.lifetime.from >= op.createdAt && e.lifetime.to <= op.closedAt;
        if (events.some(e => matches(e) && !covered(e))) throw new Error('Boat reconciliation refused: existing VM events extend outside receipt coverage');
        for (let i = events.length - 1; i >= 0; i -= 1) { const event = events[i]; if (event !== undefined && matches(event)) events.splice(i, 1); }
        for (const receipt of op.receipts) events.push({ t: receipt.since, provider: 'boat', account: op.inspectionAccount, kind: 'sandbox', sandboxId: op.sandboxId, reservationId: op.reservationId,
          usd: receipt.listPriceUsd, estimated: true, boatUsage: { ...receipt, priceBasis: 'provider_list_usage', inspectionAccount: op.inspectionAccount, ...(op.walletId === undefined ? {} : { walletId: op.walletId }) } });
        for (const life of lifecycles.values()) if (life.reservation.provider === 'boat' && life.reservation.sandboxId === op.sandboxId) life.closed = true;
        reservations.delete(reservation.id);
      } catch (error) { denied.set(op.id, error instanceof Error ? error : new Error('Boat reconciliation refused')); }
    } else if (op.op === 'recover') {
      if ([...reservations.values()].some(r => r.origin === 'inventory' && r.provider === op.provider && r.sandboxId === op.sandboxId)) { corrupt += 1; continue; }
      if (ids.has(op.id)) continue;
      ids.add(op.id);
      const previous = events.filter(e => e.kind === 'sandbox' && e.provider === op.provider && e.account === op.account && e.sandboxId === op.sandboxId && e.t >= op.start);
      const closed = previous.some(e => e.checkpoint !== true);
      const boundary = previous.reduce((at, e) => Math.max(at, Date.parse(e.t)), Date.parse(op.start));
      const reservation: Reservation = { ...op, caps: {}, boundUsd: null, remainingUsd: null };
      lifecycles.set(op.id, { reservation, boundary, closed });
      if (!closed) reservations.set(op.id, reservation);
    } else if (op.op === 'settle') {
      accept(op.event);
    } else if (op.op === 'reprice') {
      if (ids.has(op.id)) continue;
      ids.add(op.id);
      for (const [i, e] of events.entries()) {
        if (e.provider !== op.provider || e.kind !== 'sandbox' || e.usd !== null || e.seconds === undefined || e.t > op.t) continue;
        events[i] = {
          ...e, usd: roundUsd(e.seconds / 3600 * (e.multiplier ?? 1) * op.usdPerComputeHour), estimated: true,
          note: `${op.note}: $${op.usdPerComputeHour}/compute-hour applied ${op.t}${e.note === undefined ? '' : `; was ${e.note}`}`,
          ...(e.lifetime === undefined ? {} : { lifetime: { ...e.lifetime, usdPerComputeHour: op.usdPerComputeHour } }),
        };
      }
    } else if (op.op === 'bind') {
      const reservation = reservations.get(op.id);
      if (reservation === undefined) { corrupt += 1; continue; }
      if (reservation.sandboxId !== undefined && reservation.sandboxId !== op.sandboxId) { corrupt += 1; continue; }
      if (op.startedAt !== undefined && (reservation.sandboxPricing?.idempotentCreate !== true || Date.parse(op.startedAt) > Date.parse(op.t) || (reservation.startedAt !== undefined && reservation.startedAt !== op.startedAt))) { corrupt += 1; continue; }
      const bound = { ...reservation, sandboxId: op.sandboxId, ...(op.startedAt === undefined ? {} : { startedAt: op.startedAt }) };
      reservations.set(op.id, bound);
      const life = lifecycles.get(op.id);
      if (life !== undefined) life.reservation = bound;
    } else {
      if (reservations.get(op.id)?.origin === 'inventory') { corrupt += 1; continue; }
      reservations.delete(op.id);
      const life = lifecycles.get(op.id);
      if (life !== undefined) life.closed = true;
    }
  }
  return { events, corrupt, foreign, reservations: [...reservations.values()], denied };
}

export function filterEvents(events: readonly SpendEvent[], filter: TotalsFilter = {}): SpendEvent[] {
  const since = filter.since === undefined ? undefined : parseSince(filter.since);
  return events.filter(
    (e) =>
      (since === undefined || Date.parse(e.t) >= since) &&
      (filter.provider === undefined || e.provider === filter.provider) &&
      (filter.account === undefined || e.account === filter.account),
  );
}

const roundSeconds = (n: number): number => Math.round(n * 1000) / 1000;

export function sumEvents(events: readonly SpendEvent[], corrupt: number): Totals {
  const unpriced = events.filter((e) => e.usd === null);
  return {
    usd: roundUsd(events.reduce((s, e) => s + (e.usd ?? 0), 0)),
    events: events.length,
    estimated: events.filter((e) => e.estimated === true).length,
    unpriced: unpriced.length,
    seconds: roundSeconds(events.reduce((s, e) => s + (e.seconds ?? 0), 0)),
    unpricedSeconds: roundSeconds(unpriced.reduce((s, e) => s + (e.seconds ?? 0), 0)),
    corrupt,
  };
}

/** The two meters, one per spend kind, each with its own totals and its own daily cap. */
export const METERS = {
  model_call: { name: 'llm', one: 'call', many: 'calls' },
  sandbox: { name: 'sandbox', one: 'sandbox', many: 'sandboxes' },
} as const satisfies Record<SpendKind, { name: string; one: string; many: string }>;

export type MeterTotals = { readonly today: Totals; readonly allTime: Totals };
export type MeterReport = { readonly day: string; readonly kinds: Readonly<Record<SpendKind, MeterTotals>>; readonly total: MeterTotals };

/** Today (the UTC day of `now`) and all-time totals per meter, and for both together. */
export function meterReport(events: readonly SpendEvent[], now: number): MeterReport {
  const day = utcDay(now);
  const split = (es: readonly SpendEvent[]): MeterTotals => ({ today: sumEvents(es.filter((e) => e.t.slice(0, 10) === day), 0), allTime: sumEvents(es, 0) });
  const of = (k: SpendKind): MeterTotals => split(events.filter((e) => e.kind === k));
  return { day, kinds: { model_call: of('model_call'), sandbox: of('sandbox') }, total: split(events) };
}

export function openLedger(file: string, deps: LedgerDeps = {}): Ledger {
  const now = deps.now ?? Date.now;
  const read = (): JournalState =>
    existsSync(file) ? parseLines(readFileSync(file, 'utf8')) : { events: [], corrupt: 0, foreign: 0, reservations: [], denied: new Map() };
  const write = (raw: unknown): SpendEvent => {
    const parsed = spendEventSchema.parse(raw);
    const event = parsed.reservationId === undefined ? parsed : { ...parsed, entryId: parsed.entryId ?? randomUUID() };
    if (event.reservationId !== undefined) {
      if (read().reservations.find(r => r.id === event.reservationId)?.origin === 'inventory') throw new Error('inventory exposure needs verified billing reconciliation; estimated settlement cannot clear it');
      operation({ op: 'settle', event });
      const state = read();
      if (state.corrupt > 0) throw new Error('cost settlement refused: the ledger contains corrupt or incomplete records');
      return state.events.find(e => e.entryId === event.entryId) ?? { ...event, seconds: 0, usd: 0, estimated: true, note: 'duplicate settlement ignored' };
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // One appendFile per line: O_APPEND keeps concurrent writers from interleaving within a line.
    const lead = endsMidLine(file) ? '\n' : '';
    appendFileSync(file, `${lead}${JSON.stringify(event)}\n`, { mode: 0o600, flush: true });
    return event;
  };
  const operation = (raw: unknown): void => {
    const row = reservationOperationSchema.parse(raw);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lead = endsMidLine(file) ? '\n' : '';
    appendFileSync(file, `${lead}${JSON.stringify(row)}\n`, { mode: 0o600, flush: true });
  };
  return {
    path: file,
    now,
    record: (e) => write({ ...e, t: new Date(now()).toISOString() }),
    append: (e) => write(e),
    read,
    reserve(input) {
      const id = randomUUID();
      operation({ ...input, op: 'reserve', id, t: new Date(now()).toISOString() });
      const state = read();
      const failure = state.denied.get(id);
      if (failure !== undefined) throw failure;
      if (state.corrupt > 0) throw new Error('cost admission refused: the ledger contains corrupt or incomplete records');
      const reservation = state.reservations.find((r) => r.id === id);
      if (reservation === undefined) throw new Error('cost admission refused: the reservation was not durably recorded');
      return reservation;
    },
    bindReservation(id, sandboxId, startedAt) {
      const t = now();
      const reservation = read().reservations.find(r => r.id === id);
      if (reservation === undefined) throw new Error('no active reservation to bind');
      if (reservation.sandboxId !== undefined && reservation.sandboxId !== sandboxId) throw new Error('reservation already belongs to a different sandbox');
      if (startedAt !== undefined && (reservation.sandboxPricing?.idempotentCreate !== true || !Number.isFinite(startedAt) || startedAt < 0 || startedAt > t || (reservation.startedAt !== undefined && Date.parse(reservation.startedAt) !== startedAt))) throw new Error('invalid or conflicting provider creation timestamp');
      operation({ op: 'bind', id, sandboxId, ...(startedAt === undefined ? {} : { startedAt: new Date(startedAt).toISOString() }), t: new Date(t).toISOString() });
    },
    startModel(input) {
      const id = randomUUID();
      operation({ ...input, op: 'start_model', kind: 'model_call', id, t: new Date(now()).toISOString() });
      const state = read();
      const failure = state.denied.get(id);
      if (failure !== undefined) throw failure;
      if (state.corrupt > 0) throw new Error('cost admission refused: the ledger contains corrupt or incomplete records');
      const reservation = state.reservations.find(r => r.id === id);
      if (reservation === undefined) throw new Error('cost admission refused: the model claim was not durably recorded');
      return { id, maxCostUsd: reservation.maxCostUsd };
    },
    releaseReservation(id) {
      if (read().reservations.find(r => r.id === id)?.origin === 'inventory') throw new Error('inventory exposure needs verified billing reconciliation; release cannot clear it');
      operation({ op: 'release', id, t: new Date(now()).toISOString() });
    },
    releaseClaim(id, usd, estimated) {
      const state = read();
      const open = state.reservations.find(r => r.id === id);
      // A claim already closed with unknown billing can still be settled with a price, which replaces that close (A-164).
      const closedUnknown = open === undefined ? state.events.find(e => e.reservationId === id && e.usd === null) : undefined;
      if (closedUnknown !== undefined) {
        if (usd === undefined) throw new Error(`claim ${id} is already closed with unknown billing; give its cost with --usd`);
        return write({
          t: new Date(now()).toISOString(), provider: closedUnknown.provider, account: closedUnknown.account, kind: closedUnknown.kind, reservationId: id,
          ...(closedUnknown.runId === undefined ? {} : { runId: closedUnknown.runId }), ...(closedUnknown.model === undefined ? {} : { model: closedUnknown.model }),
          usd, estimated: estimated ?? false, failed: true, stated: true, note: 'settled by the operator with a stated cost',
        });
      }
      const claim = open;
      if (claim === undefined) throw new Error(`no open claim ${id}; \`costs --json\` lists the pending ones`);
      if (claim.origin === 'inventory') throw new Error('inventory exposure needs verified billing reconciliation; release cannot clear it');
      const price = usd === undefined ? { usd: null, estimated: 'unpriced' as const } : { usd, estimated: estimated ?? false, stated: true as const };
      return write({
        t: new Date(now()).toISOString(), provider: claim.provider, account: claim.account, kind: claim.kind, reservationId: id,
        ...(claim.runId === undefined ? {} : { runId: claim.runId }), ...(claim.step === undefined ? {} : { step: claim.step }), ...(claim.model === undefined ? {} : { model: claim.model }),
        ...(claim.sandboxId === undefined ? {} : { sandboxId: claim.sandboxId }), ...price, failed: true,
        note: usd === undefined ? 'released by the operator; final billing unknown' : 'released by the operator with a stated cost',
      });
    },
    repriceUnpriced(provider, usdPerComputeHour, note) {
      const unpriced = (): number => read().events.filter((e) => e.provider === provider && e.kind === 'sandbox' && e.usd === null && e.seconds !== undefined).length;
      const before = unpriced();
      operation({ op: 'reprice', id: randomUUID(), t: new Date(now()).toISOString(), provider, kind: 'sandbox', usdPerComputeHour, note });
      if (read().corrupt > 0) throw new Error('reprice recorded, but the ledger contains corrupt records');
      return before - unpriced();
    },
    observeSandbox(input) {
      operation({ ...input, op: 'observe', id: randomUUID(), kind: 'sandbox', provider: 'boat', t: new Date(now()).toISOString() });
      const state = read();
      if (state.corrupt > 0) throw new Error('inventory exposure recorded, but the ledger contains corrupt or incomplete records');
      const reservation = state.reservations.find(r => r.provider === 'boat' && r.kind === 'sandbox' && r.sandboxId === input.sandboxId);
      if (reservation === undefined) throw new Error('inventory exposure was not durably recorded');
      return reservation.id;
    },
    markSandboxClosed(id, sandboxId) {
      const reservation = read().reservations.find(r => r.id === id);
      if (reservation?.origin !== 'inventory' || reservation.sandboxId !== sandboxId) throw new Error('no observed sandbox to mark closed');
      operation({ op: 'mark_closed', id, sandboxId, t: new Date(now()).toISOString() });
      if (read().corrupt > 0) throw new Error('verified archival recorded, but the ledger contains corrupt records');
    },
    reconcileSandbox(input) {
      const id = randomUUID();
      operation({ ...input, op: 'reconcile_sandbox', id, t: new Date(now()).toISOString() });
      const state = read();
      const failure = state.denied.get(id);
      if (failure !== undefined) throw failure;
      if (state.corrupt > 0) throw new Error('Boat reconciliation refused: the ledger contains corrupt records');
    },
    recoverLifetime(input) {
      const parsed = recoverOperationSchema.omit({ op: true, id: true, t: true, kind: true }).parse(input);
      if (read().reservations.some(r => r.origin === 'inventory' && r.provider === parsed.provider && r.sandboxId === parsed.sandboxId)) throw new Error('inventory exposure needs verified billing reconciliation; lifetime recovery cannot replace it');
      const hash = createHash('sha256').update(JSON.stringify([parsed.provider, parsed.account, parsed.sandboxId, parsed.start])).digest('hex');
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      operation({ ...parsed, op: 'recover', id, kind: 'sandbox', t: new Date(now()).toISOString() });
      return id;
    },
    totals(filter = {}) {
      const { events, corrupt } = read();
      return sumEvents(filterEvents(events, filter), corrupt);
    },
  };
}

export const GROUP_BY = ['provider', 'kind', 'account', 'wallet', 'day', 'run'] as const;
export type GroupBy = (typeof GROUP_BY)[number];
export type GroupRow = { readonly key: string; readonly usd: number; readonly events: number; readonly estimated: number; readonly unpriced: number; readonly unpricedSeconds: number };

function groupKey(e: SpendEvent, by: GroupBy): string {
  switch (by) {
    case 'provider':
      return e.provider;
    case 'kind':
      return e.kind;
    case 'account':
      return e.account;
    case 'wallet':
      return e.walletId ?? e.boatUsage?.walletId ?? (e.provider === 'boat' ? '(boat, no wallet recorded)' : '(not boat)');
    case 'day':
      return e.t.slice(0, 10);
    case 'run':
      return e.runId ?? '(no run)';
    default:
      return assertNever(by);
  }
}

/** Totals per group, sorted by key. */
export function groupEvents(events: readonly SpendEvent[], by: GroupBy): GroupRow[] {
  const groups = new Map<string, SpendEvent[]>();
  for (const e of events) {
    const key = groupKey(e, by);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, es]) => {
      const t = sumEvents(es, 0);
      return { key, usd: t.usd, events: t.events, estimated: t.estimated, unpriced: t.unpriced, unpricedSeconds: t.unpricedSeconds };
    });
}

// ---------------------------------------------------------------------------------------------
// Spend caps

/** Every cap: its env variable, its window, and the meter it limits (undefined: both meters together). */
export const CAPS = {
  maxTotalUsd: { env: 'WORLDGEN_MAX_TOTAL_USD', window: 'total', kind: undefined },
  maxDailyUsd: { env: 'WORLDGEN_MAX_DAILY_USD', window: 'day', kind: undefined },
  maxDailyLlmUsd: { env: 'WORLDGEN_MAX_DAILY_LLM_USD', window: 'day', kind: 'model_call' },
  maxDailySandboxUsd: { env: 'WORLDGEN_MAX_DAILY_SANDBOX_USD', window: 'day', kind: 'sandbox' },
} as const satisfies Record<string, { env: string; window: 'day' | 'total'; kind: SpendKind | undefined }>;
export type CapName = keyof typeof CAPS;
const isCapName = (s: string): s is CapName => Object.hasOwn(CAPS, s);
/** In CAPS order: the total cap is checked first. */
export const CAP_NAMES: readonly CapName[] = Object.keys(CAPS).filter(isCapName);
export type SpendCaps = { readonly [K in CapName]?: number | undefined };

function envCap(env: Readonly<Record<string, string | undefined>>, cap: CapName): number | undefined {
  const name = CAPS[cap].env;
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number of USD, got "${raw}"`);
  return n;
}

const tighter = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/**
 * Caps from the environment (each CAPS entry's env variable) and an explicit object (config).
 * When both set a cap, the lower one wins: a cap can only be tightened, never loosened, by a second source.
 */
export function capsFromEnv(env: Readonly<Record<string, string | undefined>>, explicit: SpendCaps = {}): SpendCaps {
  for (const cap of CAP_NAMES) {
    const v = explicit[cap];
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new Error(`${cap} must be a non-negative number of USD, got ${v}`);
  }
  const caps: { [K in CapName]?: number } = {};
  for (const cap of CAP_NAMES) {
    const v = tighter(envCap(env, cap), explicit[cap]);
    if (v !== undefined) caps[cap] = v;
  }
  return caps;
}

const reserveOperationSchema = z.object({
    op: z.literal('reserve'), id: z.uuid(), t: z.iso.datetime(),
    provider: z.enum(PROVIDERS), account: z.string().regex(ACCOUNT_RE), kind: z.enum(SPEND_KINDS),
    runId: z.string().optional(), boundUsd: z.number().finite().nonnegative(),
    walletId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
    sandboxPricing: z.object({ size: z.enum(['small', 'default', 'large']), multiplier: amount, usdPerComputeHour: amount, maxLifetimeSeconds: z.int().positive().optional(), idempotentCreate: z.literal(true).optional() }).optional(),
    caps: z.object({ maxTotalUsd: amount.optional(), maxDailyUsd: amount.optional(), maxDailyLlmUsd: amount.optional(), maxDailySandboxUsd: amount.optional() }),
  });
const recoverOperationSchema = z.object({
  op: z.literal('recover'), id: z.uuid(), t: z.iso.datetime(), kind: z.literal('sandbox'),
  provider: z.enum(PROVIDERS), account: z.string().regex(ACCOUNT_RE), sandboxId: z.string().min(1), start: z.iso.datetime(), runId: z.string().optional(),
  walletId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
});
const modelClaimSchema = reserveOperationSchema.omit({ op: true, boundUsd: true, sandboxPricing: true, kind: true }).extend({
  op: z.literal('start_model'), kind: z.literal('model_call'), provider: z.enum(['anthropic', 'claude-cli']), model: z.string().optional(), step: z.string().optional(),
  /** The most this call may spend, such as its --max-budget-usd. Without it the claim's cost is unknown until it settles. */
  allowanceUsd: z.number().finite().positive().optional(),
});
const observationSchema = z.object({ op: z.literal('observe'), id: z.uuid(), t: z.iso.datetime(), provider: z.literal('boat'), kind: z.literal('sandbox'), account: z.string().regex(/^sha256:[0-9a-f]{12}$/), sandboxId: z.string().min(1), caps: reserveOperationSchema.shape.caps });
const reconciliationSchema = z.object({ op: z.literal('reconcile_sandbox'), id: z.uuid(), t: z.iso.datetime(), reservationId: z.uuid(),
  sandboxId: z.string().min(1), inspectionAccount: z.string().regex(/^sha256:[0-9a-f]{12}$/), createdAt: z.iso.datetime(), closedAt: z.iso.datetime(),
  walletId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(), receipts: z.array(boatUsageSliceSchema).min(1) })
  .refine(r => r.createdAt < r.closedAt && r.closedAt <= r.t && r.receipts[0]?.since === r.createdAt && r.receipts.at(-1)?.until === r.closedAt &&
    r.receipts.every((s, i) => (i === 0 || r.receipts[i - 1]?.until === s.since) && Date.parse(s.until) <= Date.parse(`${s.since.slice(0, 10)}T00:00:00.000Z`) + 86400000),
  { message: 'Boat reconciliation requires gap-free UTC slices from creation through verified closure' });
/**
 * A user's rate decision for sandbox time recorded without a price (A-164): every earlier unpriced sandbox
 * line of `provider` with recorded seconds is read as estimated spend at this rate. Append-only; later lines are not affected.
 */
const repriceOperationSchema = z.object({ op: z.literal('reprice'), id: z.uuid(), t: z.iso.datetime(), provider: z.enum(PROVIDERS), kind: z.literal('sandbox'),
  usdPerComputeHour: z.number().finite().positive(), note: z.string().min(1) });
const reservationOperationSchema = z.discriminatedUnion('op', [
  reserveOperationSchema,
  recoverOperationSchema,
  modelClaimSchema,
  observationSchema,
  reconciliationSchema,
  z.object({ op: z.literal('mark_closed'), id: z.uuid(), t: z.iso.datetime(), sandboxId: z.string().min(1) }),
  z.object({ op: z.literal('bind'), id: z.uuid(), t: z.iso.datetime(), sandboxId: z.string().min(1), startedAt: z.iso.datetime().optional() }),
  z.object({ op: z.literal('release'), id: z.uuid(), t: z.iso.datetime() }),
  repriceOperationSchema,
  z.object({ op: z.literal('settle'), event: spendEventSchema }),
]);
const KNOWN_OPS: ReadonlySet<string> = new Set(reservationOperationSchema.options.map((o) => o.shape.op.value));
export type ReservationInput = Readonly<Omit<z.output<typeof reserveOperationSchema>, 'op' | 'id' | 't'>>;
export type RecoveryInput = Readonly<Omit<z.output<typeof recoverOperationSchema>, 'op' | 'id' | 't' | 'kind'>>;
export type ModelClaimInput = Readonly<Omit<z.output<typeof modelClaimSchema>, 'op' | 'id' | 't' | 'kind'>>;
export type ObservationInput = Readonly<Omit<z.output<typeof observationSchema>, 'op' | 'id' | 't' | 'kind' | 'provider'>>;
export type ReconciliationInput = Readonly<Omit<z.output<typeof reconciliationSchema>, 'op' | 'id' | 't'>>;
type JournalClaim = (ReservationInput & { readonly remainingUsd: number }) | (RecoveryInput & {
  readonly kind: 'sandbox'; readonly boundUsd: null; readonly remainingUsd: null; readonly caps: SpendCaps; readonly sandboxPricing?: never;
}) | (ModelClaimInput & { readonly kind: 'model_call'; readonly boundUsd: null; readonly remainingUsd: number | null; readonly sandboxPricing?: never });
export type Reservation = ((JournalClaim & { readonly origin?: never; readonly accountBasis?: never }) | (ObservationInput & { readonly provider: 'boat'; readonly kind: 'sandbox'; readonly origin: 'inventory'; readonly accountBasis: 'inspection_key'; readonly boundUsd: null; readonly remainingUsd: null; readonly sandboxPricing?: never })) & {
  readonly runId?: string | undefined;
  /** The pinned Boat organization the claim bills to (A-247), when one was recorded. */
  readonly walletId?: string | undefined;
  readonly id: string;
  readonly t: string;
  readonly sandboxId?: string;
  readonly startedAt?: string;
  readonly closedAt?: string;
  readonly model?: ModelClaimInput['model'];
  readonly step?: ModelClaimInput['step'];
  readonly maxCostUsd?: number | undefined;
};
/** `foreign` counts lines whose op this reader does not know: written by newer code, skipped, never corrupt (A-201). */
type JournalState = { events: SpendEvent[]; corrupt: number; foreign: number; reservations: Reservation[]; denied: Map<string, Error> };

/** After this long an open model claim is abandoned (its process died before settling): it stops blocking and counts at its bound. */
export const MODEL_CLAIM_TTL_MS = 2 * 3600_000;

/** What an abandoned or unknown-cost model claim counts toward caps: its admitted bound, when one is known. */
function claimBound(r: Reservation): number | undefined {
  return r.kind === 'model_call' ? r.remainingUsd ?? r.maxCostUsd : undefined;
}

const abandoned = (r: Reservation, now: number): boolean => r.kind === 'model_call' && Date.parse(r.t) < now - MODEL_CLAIM_TTL_MS;

/** A VM claim keeps the caps it was admitted under binding while it lives. A model claim's caps bind only its own call. */
function effectiveCaps(caps: SpendCaps, reservations: readonly Reservation[]): SpendCaps {
  const effective: { [K in CapName]?: number | undefined } = { ...caps };
  for (const reservation of reservations) {
    if (reservation.kind === 'model_call') continue;
    for (const cap of CAP_NAMES) {
      const bound = tighter(effective[cap], reservation.caps[cap]);
      if (bound !== undefined) effective[cap] = bound;
    }
  }
  return effective;
}

/**
 * One cap's window: settled spend (unknown model billing at its claim's bound), open obligations,
 * and how much in the window has no known bound. Abandoned model claims count as spend at their bound.
 */
function windowExposure(events: readonly SpendEvent[], reservations: readonly Reservation[], cap: CapName, now: number) {
  const day = utcDay(now);
  const def: { window: 'day' | 'total'; kind: SpendKind | undefined } = CAPS[cap];
  const inScope = (kind: SpendKind, t: string): boolean => (def.kind === undefined || kind === def.kind) && (def.window === 'total' || t.slice(0, 10) === day);
  const applicable = events.filter((e) => inScope(e.kind, e.t));
  const live = reservations.filter((r) => (def.kind === undefined || r.kind === def.kind) && !abandoned(r, now));
  const dead = reservations.filter((r) => abandoned(r, now) && inScope(r.kind, r.t));
  const bounded = [...applicable.filter((e) => e.usd === null).map((e) => e.exposureUsd), ...dead.map(claimBound)];
  const spentUsd = roundUsd(sumEvents(applicable, 0).usd + bounded.reduce<number>((sum, b) => sum + (b ?? 0), 0));
  const reservedUsd = roundUsd(live.reduce((sum, r) => sum + (r.remainingUsd ?? 0), 0));
  return { applicable, spentUsd, reservedUsd, unknownSpend: bounded.filter((b) => b === undefined).length, unknownClaims: live.filter((r) => r.remainingUsd === null) };
}

function checkExposure(events: readonly SpendEvent[], reservations: readonly Reservation[], caps: SpendCaps, now: number, kind: SpendKind, additionalUsd: number): number | undefined {
  const day = utcDay(now);
  const effective = effectiveCaps(caps, reservations.filter((r) => !abandoned(r, now)));
  let maxCostUsd: number | undefined;
  for (const cap of CAP_NAMES) {
    const capUsd = effective[cap];
    const def = CAPS[cap];
    if (capUsd === undefined || (def.kind !== undefined && def.kind !== kind)) continue;
    const w = windowExposure(events, reservations, cap, now);
    if (w.unknownSpend > 0) throw new Error(`cost admission refused: ${def.env} cannot be enforced while applicable billing is unknown (see \`costs\`; settle a stale claim with \`costs release <id> --usd <n>\`)`);
    if (w.unknownClaims.length > 0) throw new Error(`cost admission refused: ${def.env} cannot be enforced while an active spending obligation is unknown (claim ${w.unknownClaims[0]?.id}; it expires ${MODEL_CLAIM_TTL_MS / 3600_000} h after it opened, or \`costs release\` it)`);
    const exposure = roundUsd(w.spentUsd + w.reservedUsd);
    if (exposure >= capUsd || roundUsd(exposure + additionalUsd) > capUsd) {
      throw new SpendCapError({ cap, capUsd, spentUsd: roundUsd(exposure + additionalUsd), remainingUsd: 0 }, day);
    }
    const remaining = roundUsd(capUsd - exposure - additionalUsd);
    maxCostUsd = Math.min(maxCostUsd ?? remaining, remaining);
  }
  return maxCostUsd;
}

export type CapLine = { readonly cap: CapName; readonly capUsd: number; readonly spentUsd: number; readonly remainingUsd: number; readonly reservedUsd?: number; readonly unpriced?: number };
export type CapStatus = { readonly day: string; readonly lines: { readonly [K in CapName]?: CapLine } };

/** Settled spend and pending exposure against each cap; unknown billing has no enforceable remainder. */
export function capStatus(ledger: Ledger, caps: SpendCaps, now: number): CapStatus {
  const day = utcDay(now);
  const { events, reservations } = ledger.read();
  const effective = effectiveCaps(caps, reservations.filter((r) => !abandoned(r, now)));
  const lines: { [K in CapName]?: CapLine } = {};
  for (const cap of CAP_NAMES) {
    const capUsd = effective[cap];
    if (capUsd === undefined) continue;
    const w = windowExposure(events, reservations, cap, now);
    const unpriced = w.unknownSpend + w.unknownClaims.length;
    const { spentUsd, reservedUsd } = w;
    lines[cap] = { cap, capUsd, spentUsd, remainingUsd: unpriced > 0 ? 0 : roundUsd(Math.max(0, capUsd - spentUsd - reservedUsd)), ...(reservedUsd > 0 ? { reservedUsd } : {}), ...(unpriced > 0 ? { unpriced } : {}) };
  }
  return { day, lines };
}

const METER_SCOPE = {
  all: { label: '', spend: 'model calls and sandboxes' },
  model_call: { label: 'LLM ', spend: 'model calls only' },
  sandbox: { label: 'sandbox ', spend: 'sandbox time only' },
} as const satisfies Record<SpendKind | 'all', { label: string; spend: string }>;

/**
 * A reached cap in one line that names its env variable, window and meter, and says the ledger
 * spans every session: `daily spend cap WORLDGEN_MAX_DAILY_USD=$60.00 reached: $60.08 spent today
 * (2026-10-07 UTC), all sessions, model calls and sandboxes`.
 */
export function capReached(cap: CapName, capUsd: number, spentUsd: number, day: string): string {
  const def: { env: string; window: 'day' | 'total'; kind: SpendKind | undefined } = CAPS[cap];
  const scope = METER_SCOPE[def.kind ?? 'all'];
  const window = def.window === 'day' ? { name: 'daily', when: `today (${day} UTC)` } : { name: 'total', when: 'in all time' };
  return `${window.name} ${scope.label}spend cap ${def.env}=$${capUsd.toFixed(2)} reached: $${spentUsd.toFixed(2)} spent ${window.when}, all sessions, ${scope.spend}`;
}

export class SpendCapError extends Error {
  readonly kind = 'spend_cap' as const;
  readonly cap: CapName;
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly day: string;
  constructor(line: CapLine, day: string) {
    super(`${capReached(line.cap, line.capUsd, line.spentUsd, day)}; raise ${CAPS[line.cap].env} to continue`);
    this.name = 'SpendCapError';
    this.cap = line.cap;
    this.capUsd = line.capUsd;
    this.spentUsd = line.spentUsd;
    this.day = day;
  }
}

/**
 * Throws SpendCapError when spend has reached a cap that limits `kind`: the combined caps and
 * that meter's own cap. Call it before every model call (model_call) and before creating a VM (sandbox).
 */
export function guard(ledger: Ledger, caps: SpendCaps, now: number, kind: SpendKind): void {
  const state = ledger.read();
  const effective = effectiveCaps(caps, state.reservations.filter((r) => !abandoned(r, now)));
  if (state.corrupt > 0 && CAP_NAMES.some(cap => effective[cap] !== undefined)) throw new Error('cost admission refused: the ledger contains corrupt or incomplete records');
  checkExposure(state.events, state.reservations, effective, now, kind, 0);
}
