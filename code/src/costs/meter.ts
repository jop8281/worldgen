/**
 * Metering decorators. They wrap a model or a sandbox backend so every billed call and every
 * VM lifetime lands in the spend ledger, and every call or VM creation is guarded by the spend caps.
 *
 * Structural on purpose: this file does not import worldgen/llm.ts (only run.ts and cli/ may),
 * nor any sandbox backend. Any `Model` (llm.ts) is a `Proposer`, and any object with
 * create/up and stop/down/delete methods is a sandbox backend.
 */
import { z } from 'zod';
import { CAP_NAMES, CAPS, capStatus, guard, partialModelUsageSchema, type Ledger, type SpendCaps, type SpendEvent } from './ledger.ts';
import { BOAT_SIZES, RATE_ENV, computeHourRate, isBoatSize, sandboxUsd } from './pricing.ts';
import { costBasisSchema, type CostBasis } from './basis.ts';

type Env = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------------------------
// Models

/** The slice of llm.ts `Usage` the ledger records. */
export type BilledUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens?: number | undefined;
  readonly cacheWrite1hTokens?: number | undefined;
};
export type Billed = { readonly usage: BilledUsage; readonly costUsd: number; readonly ms: number; readonly costBasis?: CostBasis | undefined };
/** llm.ts `Model` is a `Proposer<ProposeRequest, Proposal>`. */
export interface Proposer<R, P extends Billed> {
  propose(req: R): Promise<P>;
}

export type ModelMeterOptions<R = unknown> = {
  readonly provider: 'anthropic' | 'claude-cli';
  /** accountFor(provider, key): a fingerprint, or `claude-cli`. Never the key. */
  readonly account: string;
  /** The model id, recorded on each line. */
  readonly model?: string | undefined;
  readonly caps?: SpendCaps | undefined;
  readonly runId?: string | undefined;
  /** The stage or step, or a getter read at each call so one wrapper follows a whole run. */
  readonly step?: string | (() => string | undefined) | undefined;
  /** Applies an admitted client-estimate allowance to the transport request. */
  readonly withBudget?: ((req: R, maxCostUsd: number) => R) | undefined;
  /** The most one request may spend. The claim reserves it, so concurrent capped calls admit while their bounds fit (A-164). */
  readonly allowanceOf?: ((req: R) => number | undefined) | undefined;
};

/** A thrown error that was still billed: ModelError when the API answered, StepShareExpired or CallStalled when the stream had reported tokens. */
const billedErrorSchema = z.object({
  usage: z.object({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    cacheReadTokens: z.int().nonnegative(),
    cacheWriteTokens: z.int().nonnegative().optional(),
    cacheWrite1hTokens: z.int().nonnegative().optional(),
  }),
  costUsd: z.number().finite().nonnegative(),
  costBasis: costBasisSchema.optional(),
  ms: z.number().finite().nonnegative().optional(),
});
const notStartedErrorSchema = z.object({ billing: z.object({ kind: z.literal('not_started') }) });
const partialErrorSchema = z.object({ partialModelUsage: partialModelUsageSchema });
const unknownBillingErrorSchema = z.union([
  z.object({ billing: z.object({ kind: z.literal('unknown') }) }),
  z.object({ kind: z.enum(['share_expired', 'stalled', 'cancelled']) }),
  z.object({ name: z.literal('AbortError') }),
]);

/**
 * Before each call, durably claim its unresolved exposure against applicable caps. A pending
 * claim blocks other capped calls until billing settles; it does not bound a single call's bill.
 * After each call: one `model_call` line with the exact
 * tokens and the costUsd the client reported (never recomputed). A failure that carries usage
 * and costUsd is recorded with `failed: true`, then rethrown unchanged.
 */
export function meteredModel<R, P extends Billed>(model: Proposer<R, P>, ledger: Ledger, opts: ModelMeterOptions<R>): Proposer<R, P> {
  const caps = opts.caps ?? {};
  const step = (): string | undefined => (typeof opts.step === 'function' ? opts.step() : opts.step);
  const write = (reservationId: string, callStep: string | undefined, usage: BilledUsage, costUsd: number, ms: number | undefined, failed: boolean, costBasis?: CostBasis): SpendEvent =>
    ledger.record({
      provider: opts.provider,
      account: opts.account,
      kind: 'model_call',
      reservationId,
      runId: opts.runId,
      step: callStep,
      model: opts.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      ...(usage.cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens: usage.cacheWrite1hTokens }),
      seconds: ms === undefined ? undefined : ms / 1000,
      usd: costUsd,
      estimated: costBasis !== undefined,
      ...(costBasis === undefined ? {} : { costBasis }),
      ...(failed ? { failed: true } : {}),
    });
  return {
    async propose(req) {
      const callStep = step();
      const allowance = opts.allowanceOf?.(req);
      const admission = ledger.startModel({ provider: opts.provider, account: opts.account, caps, ...(opts.runId === undefined ? {} : { runId: opts.runId }), ...(opts.model === undefined ? {} : { model: opts.model }), ...(callStep === undefined ? {} : { step: callStep }), ...(allowance === undefined || !(allowance > 0) ? {} : { allowanceUsd: allowance }) });
      const reservationId = admission.id;
      let admitted = req;
      try {
        if (admission.maxCostUsd !== undefined && opts.withBudget !== undefined) admitted = opts.withBudget(req, admission.maxCostUsd);
      } catch (error) {
        ledger.releaseReservation(reservationId);
        throw error;
      }
      const started = ledger.now();
      let res: P;
      try {
        res = await model.propose(admitted);
      } catch (err) {
        const billed = billedErrorSchema.safeParse(err);
        const partial = partialErrorSchema.safeParse(err);
        if (notStartedErrorSchema.safeParse(err).success) ledger.releaseReservation(reservationId);
        else if (unknownBillingErrorSchema.safeParse(err).success) ledger.record({
          provider: opts.provider, account: opts.account, kind: 'model_call', reservationId, runId: opts.runId, step: callStep, model: opts.model,
          usd: null, estimated: 'unpriced', failed: true, note: 'final model billing is unknown; observed partial usage is a lower bound',
          ...(partial.success ? { partialModelUsage: partial.data.partialModelUsage } : billed.success ? { partialModelUsage: { ...billed.data.usage, observedCostUsd: billed.data.costUsd, ...(billed.data.costBasis === undefined ? {} : { costBasis: billed.data.costBasis }) } } : {}),
        });
        else if (billed.success) write(reservationId, callStep, billed.data.usage, billed.data.costUsd, billed.data.ms, true, billed.data.costBasis);
        else ledger.record({
          provider: opts.provider, account: opts.account, kind: 'model_call', runId: opts.runId,
          reservationId, step: callStep, model: opts.model, seconds: Math.max(0, ledger.now() - started) / 1000,
          usd: null, estimated: 'unpriced', failed: true, note: 'model call failed without confirmed billing',
        });
        throw err;
      }
      write(reservationId, callStep, res.usage, res.costUsd, res.ms, false, res.costBasis);
      return res;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Sandboxes

export const START_METHODS: readonly string[] = ['create', 'up'];
export const STOP_METHODS: readonly string[] = ['stop', 'down', 'delete'];

export type SandboxMeterOptions = {
  readonly provider: 'boat' | 'openshell' | 'sbx';
  /** accountFor(provider, key): the boat key fingerprint, or `local`. */
  readonly account: string;
  /** A boat size (small, default, large). Defaults to `default` for boat. */
  readonly size?: string | undefined;
  /** Overrides the size table. */
  readonly multiplier?: number | undefined;
  /** Overrides BOAT_USD_PER_COMPUTE_HOUR. */
  readonly usdPerComputeHour?: number | undefined;
  readonly caps?: SpendCaps | undefined;
  readonly runId?: string | undefined;
  /** The pinned Boat organization (A-247), recorded on the claim and every line. */
  readonly walletId?: string | undefined;
  /** Where BOAT_USD_PER_COMPUTE_HOUR is read. Defaults to process.env. */
  readonly env?: Env | undefined;
};

export type SandboxMeter<B> = {
  /** The backend with its create/up and stop/down/delete methods metered; everything else passes through. */
  readonly backend: B;
  /** Records every sandbox still live (lifetime up to now) and forgets it. Synchronous, so a process 'exit' handler can call it. */
  flush(): SpendEvent[];
  /** Ids of the sandboxes created and not yet torn down. */
  live(): string[];
  /**
   * Stops tracking a live sandbox without recording it, and returns the start of its unrecorded lifetime.
   * For a sandbox that outlives this process: the caller persists the start, and the process
   * that tears it down calls adopt() with it, so the whole lifetime is recorded once.
   */
  release(id: string): { readonly id: string; readonly start: number } | undefined;
  /**
   * Tracks a sandbox another process created at `start` (epoch ms), so its teardown here is recorded.
   * A completed lifetime is not billed again; checkpoints resume from the last recorded boundary.
   */
  adopt(id: string, start: number): void;
};

/** usdPerComputeHour null: no rate is known, so lifetimes are recorded unpriced. */
type Rate = { readonly size: string | undefined; readonly multiplier: number | undefined; readonly usdPerComputeHour: number | null; readonly note: string | undefined };

function rateOf(opts: SandboxMeterOptions): Rate {
  if (opts.provider !== 'boat') {
    return { size: opts.size, multiplier: opts.multiplier, usdPerComputeHour: 0, note: undefined };
  }
  const size = opts.size ?? 'default';
  let multiplier = opts.multiplier;
  if (multiplier === undefined) {
    if (!isBoatSize(size)) throw new Error(`unknown boat size "${size}": expected one of ${Object.keys(BOAT_SIZES).join(', ')}, or pass a multiplier`);
    multiplier = BOAT_SIZES[size].multiplier;
  }
  if (opts.usdPerComputeHour !== undefined) {
    return { size, multiplier, usdPerComputeHour: opts.usdPerComputeHour, note: undefined };
  }
  const fromEnv = computeHourRate(opts.env ?? process.env);
  return { size, multiplier, usdPerComputeHour: fromEnv.usdPerComputeHour, note: fromEnv.note };
}

/** The ids a value names: itself when a string or number, else its id, sandboxId and name fields. */
function namesOf(v: unknown): string[] {
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (typeof v === 'number') return [String(v)];
  if (typeof v !== 'object' || v === null) return [];
  return ['id', 'sandboxId', 'name'].flatMap((k) => {
    const f: unknown = Reflect.get(v, k);
    return typeof f === 'string' && f !== '' ? [f] : typeof f === 'number' ? [String(f)] : [];
  });
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === 'object' && v !== null && typeof Reflect.get(v, 'then') === 'function';

/**
 * Runs `ok` on the value, or `failed` on the error, after the call settles when it is a promise.
 * `failed` sees the error and the error is rethrown unchanged.
 */
function settle(call: () => unknown, ok: (v: unknown) => unknown, failed: (err: unknown) => void): unknown {
  let result: unknown;
  try {
    result = call();
  } catch (err) {
    failed(err);
    throw err;
  }
  if (!isThenable(result)) return ok(result);
  return Promise.resolve(result).then(ok, (err: unknown) => {
    failed(err);
    throw err;
  });
}

const isAsyncFunction = (fn: unknown): boolean => Object.prototype.toString.call(fn) === '[object AsyncFunction]';

const pendingSandboxErrorSchema = z.object({ pendingSandbox: z.object({ id: z.string().min(1) }) });
const sandboxStartErrorSchema = z.object({ sandboxStart: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_started') }), z.object({ kind: z.literal('unknown') }),
  z.object({ kind: z.literal('closed'), id: z.string().min(1) }), z.object({ kind: z.literal('live'), id: z.string().min(1) }),
]) });
const requestedSizeSchema = z.object({ size: z.object({ cpus: z.number(), memoryGi: z.number() }) });

type Entry = { readonly id: string; start: number; readonly aliases: readonly string[]; readonly reservationId?: string; readonly rate?: Rate; readonly expiresAt?: number };

/**
 * The backend, metered. create/up: guard() first (a cap breach throws, or rejects for an async
 * method, and the backend is not called), then the lifetime starts. stop/down/delete: when the
 * call succeeds, one `sandbox` line with the lifetime in seconds and usd = hours x multiplier x rate.
 * A sandbox is matched by the id, sandboxId or name of what create returned (or of create's
 * argument), against stop's argument; a stop with no id ends the only live sandbox. A handle
 * returned by create that has its own stop/down/delete is metered too.
 */
export function meteredSandbox<B extends object>(backend: B, ledger: Ledger, opts: SandboxMeterOptions): SandboxMeter<B> {
  const wallet = opts.walletId === undefined ? {} : { walletId: opts.walletId };
  const rate = rateOf(opts);
  const caps = opts.caps ?? {};
  const byAlias = new Map<string, Entry>();
  let seq = 0;

  const entries = (): Entry[] => [...new Set(byAlias.values())];

  const recordLifetime = (entry: Entry, note: string | undefined, failed = false, state: 'closed' | 'checkpoint' = 'closed'): SpendEvent => {
    const rate = entry.rate ?? rateOf(opts);
    const observed = ledger.now();
    const now = Math.max(entry.start, Math.min(observed, entry.expiresAt ?? Infinity));
    const seconds = Math.max(0, (now - entry.start) / 1000);
    const notes = [rate.note, note, entry.expiresAt !== undefined && observed > entry.expiresAt ? 'lifetime estimate bounded by provider TTL' : undefined].filter((n): n is string => n !== undefined);
    const price =
      rate.usdPerComputeHour === null
        ? { usd: null, estimated: 'unpriced' as const }
        : { usd: sandboxUsd(seconds, rate.multiplier ?? 1, rate.usdPerComputeHour), estimated: opts.provider === 'boat' };
    const event = ledger.record({
      provider: opts.provider,
      account: opts.account,
      kind: 'sandbox',
      ...wallet,
      runId: opts.runId,
      sandboxId: entry.id,
      size: rate.size,
      seconds,
      multiplier: rate.multiplier,
      ...price,
      ...(failed ? { failed: true } : {}),
      ...(failed && state === 'closed' ? { closed: true as const } : {}),
      ...(state === 'checkpoint' ? { checkpoint: true as const } : {}),
      ...(entry.reservationId === undefined ? {} : { reservationId: entry.reservationId, lifetime: { from: new Date(entry.start).toISOString(), to: new Date(now).toISOString(), usdPerComputeHour: rate.usdPerComputeHour } }),
      note: notes.length === 0 ? undefined : notes.join('; '),
    });
    entry.start = now;
    return event;
  };

  const finish = (entry: Entry, note: string | undefined, failed = false, state: 'closed' | 'checkpoint' = 'closed'): SpendEvent => {
    const event = recordLifetime(entry, note, failed, state);
    for (const a of entry.aliases) byAlias.delete(a);
    return event;
  };

  const entryFor = (arg: unknown): Entry | undefined => {
    const names = namesOf(arg);
    if (names.length === 0) {
      const all = entries();
      return all.length === 1 ? all[0] : undefined;
    }
    for (const n of names) {
      const e = byAlias.get(n);
      if (e !== undefined) return e;
    }
    return undefined;
  };

  /** Failed teardown records accrued time and keeps the remaining lifetime live. */
  const teardown = (target: object, fn: Function, bound: Entry | undefined) =>
    (...args: unknown[]): unknown => {
      const live = (): Entry | undefined => (bound !== undefined ? (byAlias.get(bound.id) === bound ? bound : undefined) : entryFor(args[0]));
      return settle(
        () => Reflect.apply(fn, target, args),
        (v) => {
          const entry = live();
          if (entry !== undefined) finish(entry, undefined);
          return v;
        },
        () => {
          const entry = live();
          if (entry !== undefined) recordLifetime(entry, 'teardown failed; the sandbox may still be running', true, 'checkpoint');
        },
      );
    };

  const meterHandle = (handle: unknown, entry: Entry): unknown => {
    if (typeof handle !== 'object' || handle === null) return handle;
    if (!STOP_METHODS.some((m) => typeof Reflect.get(handle, m) === 'function')) return handle;
    return new Proxy(handle, {
      get(t, prop, receiver) {
        const v: unknown = Reflect.get(t, prop, receiver);
        if (typeof v !== 'function') return v;
        return typeof prop === 'string' && STOP_METHODS.includes(prop) ? teardown(t, v, entry) : v.bind(t);
      },
    });
  };

  const start = (target: object, fn: Function) =>
    (...args: unknown[]): unknown => {
      let reservationId: string | undefined;
      let lifetimeLimit: number | undefined;
      let startRate = rate;
      try {
        const requested = requestedSizeSchema.safeParse(args[1]);
        if (opts.provider === 'boat' && requested.success) {
          const size = Object.keys(BOAT_SIZES).find((size) => isBoatSize(size) && BOAT_SIZES[size].vcpu === requested.data.size.cpus && BOAT_SIZES[size].memoryGb === requested.data.size.memoryGi);
          if (size === undefined || !isBoatSize(size)) throw new Error('boat cost admission requires a supported VM size');
          startRate = rateOf({ ...opts, size });
        }
        const status = capStatus(ledger, caps, ledger.now());
        const relevant = CAP_NAMES.find(c => status.lines[c] !== undefined && (CAPS[c].kind ?? 'sandbox') === 'sandbox');
        const blind = rate.usdPerComputeHour === null ? relevant : undefined;
        if (blind !== undefined) {
          throw new Error(`${CAPS[blind].env} is set but ${opts.provider} sandbox time is unpriced: set ${RATE_ENV} so the cap can be enforced`);
        }
        guard(ledger, caps, ledger.now(), 'sandbox');
        if (opts.provider === 'boat' && relevant !== undefined && rate.usdPerComputeHour !== null) {
          const limit: unknown = Reflect.get(backend, 'maxLifetimeSeconds');
          if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('boat cost admission requires a guaranteed positive finite provider TTL');
          lifetimeLimit = limit;
          if (startRate.size === undefined || !isBoatSize(startRate.size) || startRate.usdPerComputeHour === null) throw new Error('boat cost admission requires priced VM size');
          reservationId = ledger.reserve({ provider: opts.provider, account: opts.account, kind: 'sandbox', ...wallet, boundUsd: sandboxUsd(limit, startRate.multiplier ?? 1, startRate.usdPerComputeHour), sandboxPricing: { size: startRate.size, multiplier: startRate.multiplier ?? 1, usdPerComputeHour: startRate.usdPerComputeHour, maxLifetimeSeconds: limit, idempotentCreate: true }, caps, ...(opts.runId === undefined ? {} : { runId: opts.runId }) }).id;
        }
      } catch (err) {
        if (isAsyncFunction(fn)) return Promise.reject(err);
        throw err;
      }
      const t0 = ledger.now();
      const expiry = lifetimeLimit === undefined ? {} : { expiresAt: t0 + lifetimeLimit * 1000 };
      // A failed start is still a lifecycle: the backend may have run a VM before it gave up.
      const failedStart = (err: unknown): void => {
        const outcome = sandboxStartErrorSchema.safeParse(err);
        if (outcome.success && outcome.data.sandboxStart.kind === 'not_started') {
          if (reservationId !== undefined) ledger.releaseReservation(reservationId);
          return;
        }
        if (outcome.success && outcome.data.sandboxStart.kind === 'closed') {
          const id = outcome.data.sandboxStart.id;
          if (reservationId !== undefined) ledger.bindReservation(reservationId, id);
          finish({ id, start: t0, aliases: [], rate: startRate, ...expiry, ...(reservationId === undefined ? {} : { reservationId }) }, 'start failed; teardown confirmed', true);
          return;
        }
        const pending = pendingSandboxErrorSchema.safeParse(err);
        const pendingId = outcome.success && outcome.data.sandboxStart.kind === 'live' ? outcome.data.sandboxStart.id : pending.success ? pending.data.pendingSandbox.id : undefined;
        if (pendingId !== undefined) {
          const id = pendingId;
          const entry: Entry = { id, start: t0, aliases: [id], rate: startRate, ...expiry, ...(reservationId === undefined ? {} : { reservationId }) };
          if (reservationId !== undefined) ledger.bindReservation(reservationId, id);
          byAlias.set(id, entry);
          recordLifetime(entry, 'start failed; teardown unconfirmed; the sandbox may still be running', true, 'checkpoint');
          return;
        }
        if (opts.provider === 'boat') {
          ledger.record({ provider: opts.provider, account: opts.account, kind: 'sandbox', ...wallet, runId: opts.runId,
            ...(reservationId === undefined ? {} : { reservationId }), usd: null, estimated: 'unpriced', failed: true, checkpoint: true,
            note: 'sandbox creation outcome and billing are unknown',
          });
          return;
        }
        seq += 1;
        const id = args.flatMap(namesOf)[0] ?? `${opts.provider}-${seq}`;
        finish({ id, start: t0, aliases: [], rate: startRate, ...(reservationId === undefined ? {} : { reservationId }) }, 'start failed', true);
      };
      const startOpts = args[1];
      const createArgs = reservationId !== undefined && typeof startOpts === 'object' && startOpts !== null
        ? [args[0], { ...startOpts, idempotencyKey: reservationId }, ...args.slice(2)] : args;
      return settle(() => Reflect.apply(fn, target, createArgs), (v) => {
        const names = [...new Set([...namesOf(v), ...namesOf(args[0])])];
        seq += 1;
        const aliases = names.length === 0 ? [`${opts.provider}-${seq}`] : names;
        const entry: Entry = { id: aliases[0] ?? `${opts.provider}-${seq}`, start: t0, aliases, rate: startRate, ...expiry, ...(reservationId === undefined ? {} : { reservationId }) };
        if (reservationId !== undefined) ledger.bindReservation(reservationId, entry.id);
        // A new sandbox under a live id: the old lifetime is recorded, never silently dropped.
        for (const a of aliases) {
          const old = byAlias.get(a);
          if (old !== undefined) finish(old, 'superseded by a new sandbox with the same id');
        }
        for (const a of aliases) byAlias.set(a, entry);
        return meterHandle(v, entry);
      }, failedStart);
    };

  const proxy = new Proxy(backend, {
    get(t, prop, receiver) {
      const v: unknown = Reflect.get(t, prop, receiver);
      if (typeof prop !== 'string' || typeof v !== 'function') return v;
      if (START_METHODS.includes(prop)) return start(t, v);
      if (STOP_METHODS.includes(prop)) return teardown(t, v, undefined);
      // Bound to the backend itself: private fields keep working, and a backend method that
      // calls this.create() internally is not metered twice.
      return v.bind(t);
    },
  });

  return {
    backend: proxy,
    flush: () => entries().map((e) => finish(e, 'flushed at exit; the sandbox may still be running', false, 'checkpoint')),
    live: () => entries().map((e) => e.id),
    release: (id) => {
      const entry = byAlias.get(id);
      if (entry === undefined) return undefined;
      for (const a of entry.aliases) byAlias.delete(a);
      return { id: entry.id, start: entry.start };
    },
    adopt: (id, start) => {
      if (ledger.read().reservations.some(r => r.origin === 'inventory' && r.provider === opts.provider && r.sandboxId === id)) throw new Error('inventory exposure needs verified billing reconciliation; a configured lifetime estimate cannot adopt it');
      const rows = ledger.read().events.filter((e) => e.kind === 'sandbox' && e.provider === opts.provider &&
        e.account === opts.account && e.sandboxId === id && Date.parse(e.t) >= start);
      if (rows.some((e) => e.checkpoint !== true)) return;
      const unrecorded = rows.reduce((at, e) => Math.max(at, Date.parse(e.lifetime?.to ?? e.t)), start);
      const old = byAlias.get(id);
      if (old !== undefined) {
        old.start = Math.max(old.start, unrecorded);
        return;
      }
      const reservation = ledger.read().reservations.find(r => r.provider === opts.provider && r.account === opts.account && r.kind === 'sandbox' && r.sandboxId === id);
      const pricing = reservation?.sandboxPricing;
      const reservationId = reservation?.id ?? (opts.provider === 'boat' ? ledger.recoverLifetime({ provider: opts.provider, account: opts.account, ...wallet, sandboxId: id, start: new Date(start).toISOString(), ...(opts.runId === undefined ? {} : { runId: opts.runId }) }) : undefined);
      const expiresAt = pricing?.maxLifetimeSeconds === undefined || reservation === undefined ? undefined : Date.parse(reservation.startedAt ?? reservation.t) + pricing.maxLifetimeSeconds * 1000;
      byAlias.set(id, { id, start: unrecorded, aliases: [id], ...(reservationId === undefined ? {} : { reservationId }), ...(pricing === undefined ? {} : { rate: { ...pricing, note: undefined } }), ...(expiresAt === undefined ? {} : { expiresAt }) });
    },
  };
}
