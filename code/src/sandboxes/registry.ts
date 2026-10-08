/**
 * Which backend runs a sandbox, at what size, and how its lifetime is billed. Shell code.
 *
 * `backendFor()` builds OpenShell, sbx or boat with a simple 2-CPU, 4 GB VM unless asked for
 * more (OpenShell `--cpu 2 --memory 4Gi`, sbx `--cpus 2`, boat `small`), and wraps it in
 * meteredSandbox so every lifetime lands in the spend ledger. Live sandboxes are flushed to the
 * ledger when the process exits. A sandbox the `sandbox` CLI leaves running is handed over
 * through a record file, so the `down` in a later process records its whole lifetime once.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertNever } from '#lib/never';
import { boatUsageWindow, boatClientFromEnv, boatKey, boatOrg, MISSING_ORG, type BoatClient, type BoatInspection, type BoatInventorySandbox, type BoatUsage } from '../boat/client.ts';
import { CAP_NAMES, CAPS, capsFromEnv, ledgerPath, openLedger, roundUsd, type Ledger, type Reservation, type SpendEvent, type ReconciliationInput } from '../costs/ledger.ts';
import { boatReceiptsPath, openBoatReceipts } from '../costs/boat-receipts.ts';
import { meteredSandbox, type SandboxMeter } from '../costs/meter.ts';
import { BOAT_SIZES, accountFor, type BoatSize } from '../costs/pricing.ts';
import {
  BACKEND_KINDS,
  SandboxError,
  SandboxStartError,
  nodeRunner,
  reachWorld,
  upWorld,
  type BackendKind,
  type ExecResult,
  type Reach,
  type Runner,
  type SandboxBackend,
  type SandboxSize,
} from './backend.ts';
import { BOAT_WORKDIR, boatBackend } from './boat.ts';
import { collectBundle, dirWorkspace, type Workspace } from './files.ts';
import { openshellBackend } from './openshell.ts';
import { sbxBackend } from './sbx.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** Size names on every backend, from boat's public table: small 2 CPU / 4 GB, default 4 / 8, large 8 / 16. */
export const SIZE_NAMES = ['small', 'default', 'large'] as const satisfies readonly BoatSize[];
/** A simple 2-CPU VM unless the caller asks for more. */
export const DEFAULT_SIZE_NAME: BoatSize = 'small';

export function sizeOf(name: BoatSize): SandboxSize {
  return { cpus: BOAT_SIZES[name].vcpu, memoryGi: BOAT_SIZES[name].memoryGb };
}

export type BackendOptions = {
  readonly size?: BoatSize;
  /** boat only: the VM's time to live. */
  readonly ttlSeconds?: number;
  /** Recorded on every ledger line, so a run's sandbox spend can be summed. */
  readonly runId?: string;
  /** Defaults to the ledger at ledgerPath(env). */
  readonly ledger?: Ledger;
  /** OpenShell and sbx: where the bundle waits on the host. Defaults to dirWorkspace(). */
  readonly workspace?: Workspace;
  /** boat: defaults to boatClientFromEnv(env). Tests pass a fake. */
  readonly boatClient?: BoatClient;
  /** Register the meter with the exit flush. Default true. */
  readonly flushOnExit?: boolean;
};

export type MeteredBackend = {
  readonly kind: BackendKind;
  readonly size: BoatSize;
  /** The backend with up and down metered. `up` without a size gets `size`. */
  readonly backend: SandboxBackend;
  readonly meter: SandboxMeter<SandboxBackend>;
  readonly ledger: Ledger;
};

/** The backend with `size` filled in wherever `up` is called without one. */
function withSize(b: SandboxBackend, size: SandboxSize): SandboxBackend {
  return {
    kind: b.kind,
    ...(b.maxLifetimeSeconds === undefined ? {} : { maxLifetimeSeconds: b.maxLifetimeSeconds }),
    up: (files, opts) => b.up(files, { ...opts, size: opts.size ?? size }),
    exec: (id, cmd, opts) => b.exec(id, cmd, opts),
    start: (id, cmd, opts) => b.start(id, cmd, opts),
    expose: (id, port, opts) => b.expose(id, port, opts),
    down: (id) => b.down(id),
  };
}

function rawBackend(kind: BackendKind, env: Env, runner: Runner, opts: BackendOptions): SandboxBackend {
  switch (kind) {
    case 'openshell':
      return openshellBackend({ runner, workspace: opts.workspace ?? dirWorkspace() });
    case 'sbx':
      return sbxBackend({ runner, workspace: opts.workspace ?? dirWorkspace() });
    case 'boat':
      return boatBackend({
        client: opts.boatClient ?? boatClientFromEnv(env),
        ...(opts.ttlSeconds === undefined ? {} : { ttlSeconds: opts.ttlSeconds }),
      });
    default:
      return assertNever(kind);
  }
}

const tracked = new Set<SandboxMeter<SandboxBackend>>();
let hooked = false;

/** Records every sandbox still live in any tracked meter. The exit hook calls it. */
export function flushTracked(): SpendEvent[] {
  return [...tracked].flatMap((m) => m.flush());
}

/** Adds the meter to the exit flush. The first call installs one 'exit' hook, and makes SIGINT and SIGTERM exit through it. */
export function flushOnExit(meter: SandboxMeter<SandboxBackend>): void {
  tracked.add(meter);
  if (hooked) return;
  hooked = true;
  process.once('exit', () => void flushTracked());
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
}

/** A metered backend of `kind`. boat needs BOAT_API_KEY in `env` and throws a one-line error naming it otherwise. */
export function backendFor(kind: BackendKind, env: Env, runner: Runner = nodeRunner, opts: BackendOptions = {}): MeteredBackend {
  const size = opts.size ?? DEFAULT_SIZE_NAME;
  const backend = withSize(rawBackend(kind, env, runner, opts), sizeOf(size));
  const ledger = opts.ledger ?? openLedger(ledgerPath(env));
  const caps = capsFromEnv(env);
  const wallet = kind === 'boat' ? boatOrg(env) : undefined;
  const raw: SandboxBackend = { ...backend, async up(files, upOpts) {
    if (kind === 'boat' && wallet === undefined) throw new SandboxStartError(MISSING_ORG, { kind: 'not_started' });
    if (kind === 'boat' && !CAP_NAMES.some(cap => caps[cap] !== undefined && CAPS[cap].kind !== 'model_call')) {
      throw new SandboxStartError('Boat provisioning requires a finite sandbox or combined spend cap: set WORLDGEN_MAX_DAILY_SANDBOX_USD, WORLDGEN_MAX_DAILY_USD or WORLDGEN_MAX_TOTAL_USD', { kind: 'not_started' });
    }
    return backend.up(files, upOpts);
  } };
  const account = kind === 'boat' ? accountFor('boat', boatKey(env)) : accountFor(kind);
  const meter = meteredSandbox(raw, ledger, {
    provider: kind,
    account,
    size,
    caps,
    env,
    ...(wallet === undefined ? {} : { walletId: wallet }),
    ...(opts.runId === undefined ? {} : { runId: opts.runId }),
  });
  if (opts.flushOnExit ?? true) flushOnExit(meter);
  return { kind, size, backend: meter.backend, meter, ledger };
}

export function isBackendKind(s: string): s is BackendKind {
  return BACKEND_KINDS.some((k) => k === s);
}

/** `<prefix>-<6 hex>`, lowercased and slugged so every backend accepts it. */
export function sandboxName(prefix: string, suffix: string = randomBytes(3).toString('hex')): string {
  const slug = prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'world';
  return `${slug}-${suffix}`;
}

// ---------------------------------------------------------------------------------------------
// Sandboxes the CLI leaves running

const recordSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(BACKEND_KINDS),
  size: z.enum(SIZE_NAMES),
  /** Epoch ms when the lifetime started, as the meter saw it. */
  start: z.number().nonnegative(),
  workdir: z.string(),
  url: z.string().optional(),
  runId: z.string().optional(),
});
export type SandboxRecord = z.output<typeof recordSchema>;

/** `<ledger dir>/sandboxes`, next to costs.jsonl. */
export const recordsDir = (env: Env): string => path.join(path.dirname(ledgerPath(env)), 'sandboxes');

const ID_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function recordFile(dir: string, id: string): string {
  if (!ID_FILE.test(id)) throw new SandboxError(`bad sandbox id ${JSON.stringify(id)}`);
  return path.join(dir, `${id}.json`);
}

export async function saveRecord(dir: string, rec: SandboxRecord): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(recordFile(dir, rec.id), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
}

export async function loadRecord(dir: string, id: string): Promise<SandboxRecord | undefined> {
  const text = await readFile(recordFile(dir, id), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const parsed = recordSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new SandboxError(`${recordFile(dir, id)} is not a sandbox record: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data;
}

export async function removeRecord(dir: string, id: string): Promise<void> {
  await rm(recordFile(dir, id), { force: true });
}

export type UpDetachedOpts = {
  readonly kind: BackendKind;
  readonly codeDir: string;
  readonly worldDir: string;
  readonly port: number;
  readonly size?: BoatSize;
  readonly ttlSeconds?: number;
  readonly name?: string;
  /** Base image for openshell and sbx. */
  readonly image?: string;
};

export type Deps = {
  readonly env: Env;
  readonly boatInspection?: BoatInspection;
  readonly runner?: Runner;
  readonly backendOptions?: BackendOptions;
  /** Checks a public URL from this machine. Defaults to reachWorld. Tests pass a fake. */
  readonly reach?: (url: string) => Promise<Reach>;
};

/**
 * Brings a world up and leaves it running. Only the world port is exposed, publicly on boat and
 * on the host's loopback otherwise. The lifetime is handed to a record file for `downDetached`.
 */
export async function upDetached(o: UpDetachedOpts, deps: Deps): Promise<SandboxRecord> {
  if (o.kind === 'boat') boatKey(deps.env);
  const bundle = await collectBundle(o.codeDir, o.worldDir);
  const m = backendFor(o.kind, deps.env, deps.runner, {
    ...deps.backendOptions,
    ...(o.size === undefined ? {} : { size: o.size }),
    ...(o.ttlSeconds === undefined ? {} : { ttlSeconds: o.ttlSeconds }),
  });
  const name = o.name ?? sandboxName(path.basename(path.resolve(o.worldDir)));
  const isPublic = o.kind === 'boat';
  const up = await upWorld(m.backend, bundle, { name, port: o.port, public: isPublic, ...(o.image === undefined ? {} : { image: o.image }), ...(isPublic ? { reach: deps.reach ?? ((url: string) => reachWorld(url)) } : {}) });
  const handoff = m.meter.release(up.sandbox.id);
  const rec: SandboxRecord = {
    id: up.sandbox.id,
    kind: o.kind,
    size: m.size,
    start: handoff?.start ?? m.ledger.now(),
    workdir: up.sandbox.workdir,
    url: up.url,
  };
  try {
    await saveRecord(recordsDir(deps.env), rec);
  } catch (err) {
    // Without a record downDetached cannot find the VM, so it goes now; the meter records it once.
    m.meter.adopt(rec.id, rec.start);
    await m.backend.down(rec.id).catch(() => undefined);
    throw err;
  }
  return rec;
}

/** Runs a command in a sandbox `upDetached` left running, in its workdir. */
export async function execDetached(id: string, cmd: readonly string[], deps: Deps): Promise<ExecResult> {
  const rec = await loadRecord(recordsDir(deps.env), id);
  if (rec === undefined) throw new SandboxError(`no sandbox ${id} in ${recordsDir(deps.env)}: start one with \`bun run sandbox -- up\``);
  const m = backendFor(rec.kind, deps.env, deps.runner, { ...deps.backendOptions, size: rec.size, flushOnExit: false });
  return m.backend.exec(rec.id, cmd, { workdir: rec.workdir });
}

const lockBodySchema = z.strictObject({ pid: z.int().positive() });

/** The pid a lock names, or undefined when the lock is empty or garbled. */
function holderOf(body: string): number | undefined {
  try {
    const parsed = lockBodySchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.pid : undefined;
  } catch {
    return undefined;
  }
}

const errCode = (err: unknown): unknown => Reflect.get(Object(err), 'code');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM';
  }
}

const lockFile = (dir: string, id: string): string => recordFile(dir, id).replace(/\.json$/, '.lock');

/**
 * Claims the right to close sandbox `id`: `<id>.lock` in `dir`, created whole by link(2) so it is
 * never seen empty. A lock whose process is dead, or that is garbled, is moved aside and taken.
 * Throws SandboxError when a live process holds it. Returns the release.
 */
async function claimClose(dir: string, id: string): Promise<() => Promise<void>> {
  const lock = lockFile(dir, id);
  const body = `${JSON.stringify({ pid: process.pid })}\n`;
  const mine = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(mine, body, { mode: 0o600 });
  const busy = (pid: number | undefined): SandboxError =>
    new SandboxError(`sandbox ${id} is already closing in process ${pid ?? '(unknown)'}; that down records its lifetime once. If no down is running, remove ${lock}`);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const won = await link(mine, lock).then(() => true, (err: unknown) => {
        if (errCode(err) === 'EEXIST') return false;
        throw err;
      });
      if (won) return () => rm(lock, { force: true });
      const held = await readFile(lock, 'utf8').catch(() => undefined);
      if (held === undefined) continue;
      const holder = holderOf(held);
      if (holder !== undefined && isAlive(holder)) throw busy(holder);
      const tomb = `${lock}.stale.${randomBytes(4).toString('hex')}`;
      if (!(await rename(lock, tomb).then(() => true, () => false))) continue;
      const moved = await readFile(tomb, 'utf8').catch(() => held);
      if (moved !== held) {
        // A live claimant replaced the stale lock between the read and the rename: give it back.
        await link(tomb, lock).catch(() => undefined);
        await rm(tomb, { force: true });
        throw busy(holderOf(moved));
      }
      await rm(tomb, { force: true });
    }
    throw new SandboxError(`could not claim ${lock} after 3 attempts; another down keeps taking it`);
  } finally {
    await rm(mine, { force: true });
  }
}

/**
 * Tears a sandbox down and records its whole lifetime, from the start `upDetached` saved. One
 * down at a time per sandbox: a second concurrent down throws SandboxError ("already closing")
 * and writes nothing. Caps never block a teardown.
 */
export async function downDetached(id: string, deps: Deps): Promise<SandboxRecord | { readonly id: string; readonly kind: 'boat'; readonly billing: 'unknown' }> {
  const dir = recordsDir(deps.env);
  const release = await claimClose(dir, id);
  try {
    let rec = await loadRecord(dir, id);
    const ledger = deps.backendOptions?.ledger ?? openLedger(ledgerPath(deps.env));
    const observed = ledger.read().reservations.find(r => r.origin === 'inventory' && r.sandboxId === id);
    if ((rec === undefined || rec.kind === 'boat') && observed !== undefined) {
      boatKey(deps.env);
      await rawBackend('boat', deps.env, deps.runner ?? nodeRunner, deps.backendOptions ?? {}).down(id);
      ledger.markSandboxClosed(observed.id, id);
      await removeRecord(dir, id);
      return { id, kind: 'boat', billing: 'unknown' };
    }
    if (rec === undefined) {
      const candidates = ledger.read().reservations.filter(r => r.kind === 'sandbox' && r.provider === 'boat' && r.sandboxId === id);
      if (candidates.length > 0) {
        const account = accountFor('boat', boatKey(deps.env));
        const reservation = candidates.find(r => r.account === account);
        const pricing = reservation?.sandboxPricing;
        if (reservation !== undefined && pricing !== undefined) rec = {
          id, kind: 'boat', size: pricing.size, start: Date.parse(reservation.startedAt ?? reservation.t), workdir: BOAT_WORKDIR,
          ...(reservation.runId === undefined ? {} : { runId: reservation.runId }),
        };
      }
    }
    if (rec === undefined) throw new SandboxError(`no sandbox ${id} in ${dir}: nothing to tear down`);
    const m = backendFor(rec.kind, deps.env, deps.runner, {
      ...deps.backendOptions,
      size: rec.size,
      ...(rec.runId === undefined ? {} : { runId: rec.runId }),
      flushOnExit: false,
    });
    m.meter.adopt(rec.id, rec.start);
    await m.backend.down(rec.id);
    await removeRecord(dir, id);
    return rec;
  } finally {
    await release();
  }
}

/** Recovers one admitted create by its provider key and confirms archival before settling it. */
export async function reconcileCreate(id: string, deps: Deps): Promise<string> {
  if (!z.uuid().safeParse(id).success) throw new SandboxError('reconcile-create needs a reservation UUID from costs --json');
  const account = accountFor('boat', boatKey(deps.env));
  const ledger = deps.backendOptions?.ledger ?? openLedger(ledgerPath(deps.env));
  const release = await claimClose(recordsDir(deps.env), `create-${id}`);
  try {
    const state = ledger.read();
    if (state.corrupt > 0) throw new SandboxError('cannot reconcile creation with corrupt ledger records');
    const reservation = state.reservations.find(r => r.id === id && r.provider === 'boat' && r.kind === 'sandbox' && r.account === account);
    if (reservation === undefined) {
      const settled = state.events.find(e => e.reservationId === id && e.provider === 'boat' && e.account === account && e.checkpoint !== true && e.usd !== null && e.sandboxId !== undefined);
      if (settled?.sandboxId !== undefined && !state.events.some(e => e.reservationId === id && e.usd === null)) return settled.sandboxId;
      throw new SandboxError('no pending Boat create for this reservation and account');
    }
    const pricing = reservation.sandboxPricing;
    if (pricing?.idempotentCreate !== true || pricing.maxLifetimeSeconds === undefined) throw new SandboxError('this reservation has no persisted idempotent create payload; retain its unknown exposure');
    let sandboxId = reservation.sandboxId;
    if (reservation.startedAt === undefined || sandboxId === undefined) {
      const age = ledger.now() - Date.parse(reservation.t);
      if (age < 0 || age >= 24 * 60 * 60 * 1000) throw new SandboxError('create key is outside Boat 24-hour retention window; retain its unknown exposure');
      const client = deps.backendOptions?.boatClient ?? boatClientFromEnv(deps.env);
      const receipt = await client.create({ type: pricing.size, ttlSeconds: pricing.maxLifetimeSeconds, idempotencyKey: id });
      ledger.bindReservation(id, receipt.sandboxId);
      sandboxId = receipt.sandboxId;
      if (receipt.startedAt === undefined || !Number.isFinite(receipt.startedAt) || receipt.startedAt < 0 || receipt.startedAt > ledger.now()) {
        await downDetached(sandboxId, deps);
        throw new SandboxError(`recovered and archived sandbox ${sandboxId}, but its creation time is unverified; unknown billing is retained`);
      }
      ledger.bindReservation(id, sandboxId, receipt.startedAt);
    }
    await downDetached(sandboxId, deps);
    return sandboxId;
  } finally { await release(); }
}


type DiscoveryUsage = { readonly kind: 'available'; readonly receipt: BoatUsage } | { readonly kind: 'unavailable' } | { readonly kind: 'ownership_unverified' };
type DiscoveredBoat = BoatInventorySandbox & { readonly ledger: { readonly pending: boolean; readonly recorded: boolean; readonly accounts: string[] }; readonly usage: DiscoveryUsage };

/** The wallet label when no organization is pinned: Boat answers for the key's active organization. */
const UNPINNED = 'active (unpinned: set WORLDGEN_BOAT_ORG)';

export async function trackBoat(deps: Deps, org?: string) {
  org ??= boatOrg(deps.env);
  const account = accountFor('boat', boatKey(deps.env));
  const inspection = deps.boatInspection ?? boatClientFromEnv(deps.env);
  const ledger = deps.backendOptions?.ledger ?? openLedger(ledgerPath(deps.env));
  const caps = capsFromEnv(deps.env);
  const inventory = await inspection.inventory(org);
  const tracked: { id: string; reservationId: string }[] = [];
  for (const vm of inventory) {
    if (vm.access !== 'owner' || vm.state === 'archived') continue;
    tracked.push({ id: vm.id, reservationId: ledger.observeSandbox({ account, sandboxId: vm.id, caps }) });
  }
  return { wallet: org ?? UNPINNED, accountBasis: 'inspection_key', billing: 'unknown', tracked };
}

export async function captureBoatUsage(deps: Deps, day: string, org?: string) {
  org ??= boatOrg(deps.env);
  const window = boatUsageWindow(day);
  const account = accountFor('boat', boatKey(deps.env));
  const inspection = deps.boatInspection ?? boatClientFromEnv(deps.env);
  const ledger = deps.backendOptions?.ledger ?? openLedger(ledgerPath(deps.env));
  const journal = openBoatReceipts(boatReceiptsPath(ledger.path), ledger.now);
  const rows: { id: string; status: 'captured' | 'unavailable' | 'ownership_unverified' }[] = [];
  for (const vm of await inspection.inventory(org)) {
    if (vm.access !== 'owner') { rows.push({ id: vm.id, status: 'ownership_unverified' }); continue; }
    let usage: BoatUsage;
    try { usage = await inspection.usage(vm.id, window); }
    catch { rows.push({ id: vm.id, status: 'unavailable' }); continue; }
    if (usage.sandboxId !== vm.id) throw new SandboxError('Boat receipt capture refused: sandbox identity does not match inventory');
    journal.capture({ sandboxId: vm.id, inspectionAccount: account, ...(vm.team === undefined ? {} : { walletId: vm.team.id }),
      requestedWindow: window, returnedWindow: { since: usage.since, until: usage.until }, sandboxType: usage.sandboxType,
      billingMultiplier: usage.billingMultiplier, billableSeconds: usage.seconds, listPriceUsd: usage.dollars,
      secondsPerDollar: usage.secondsPerDollar, running: usage.running });
    rows.push({ id: vm.id, status: 'captured' });
  }
  return { file: journal.path, requestedWindow: window, settledSpendChanged: false, rows, ...journal.read() };
}

export async function reconcileBoatUsage(reservationId: string, deps: Deps, org?: string) {
  org ??= boatOrg(deps.env);
  if (!z.uuid().safeParse(reservationId).success) throw new SandboxError('reconcile-usage needs an observed reservation UUID from costs --json');
  const ledger = deps.backendOptions?.ledger ?? openLedger(ledgerPath(deps.env));
  const state = ledger.read();
  if (state.corrupt > 0) throw new SandboxError('reconcile-usage refused: the spend ledger contains corrupt records');
  const claim = state.reservations.find(r => r.id === reservationId);
  const settled = state.events.filter(e => e.reservationId === reservationId && e.boatUsage !== undefined);
  if (claim === undefined && settled.length > 0) return { reservationId, priceBasis: 'provider_list_usage', usd: settled.reduce((sum, e) => sum + (e.usd ?? 0), 0), alreadyReconciled: true };
  if (claim?.origin !== 'inventory' || claim.sandboxId === undefined || claim.closedAt === undefined) throw new SandboxError('reconcile-usage requires a tracked VM archived by sandbox down first');
  const account = accountFor('boat', boatKey(deps.env));
  const inspection = deps.boatInspection ?? boatClientFromEnv(deps.env);
  const vm = (await inspection.inventory(org)).find(r => r.id === claim.sandboxId);
  if (vm?.access !== 'owner' || vm.state !== 'archived' || vm.createdAt === null || vm.createdAt >= claim.closedAt) throw new SandboxError('reconcile-usage requires owner, archived state and provider creation time');
  const evidence = openBoatReceipts(boatReceiptsPath(ledger.path)).read();
  if (evidence.corrupt > 0 || evidence.receipts.some(r => r.sandboxId === vm.id && (r.walletStatus === 'conflicting' || r.walletIds.some(id => id !== vm.team?.id)))) throw new SandboxError('reconcile-usage refused: receipt identity evidence is corrupt or conflicting');
  const receipts: ReconciliationInput['receipts'] = [];
  let since = vm.createdAt;
  while (since < claim.closedAt) {
    const nextDay = new Date(Date.parse(`${since.slice(0, 10)}T00:00:00.000Z`) + 86400000).toISOString();
    const until = nextDay < claim.closedAt ? nextDay : claim.closedAt;
    const usage = await inspection.usage(vm.id, { since, until });
    if (usage.sandboxId !== vm.id || usage.since !== since || usage.until !== until || usage.running) throw new SandboxError('reconcile-usage refused: provider receipt does not exactly cover the closed lifetime slice');
    receipts.push({ since, until, billableSeconds: usage.seconds, listPriceUsd: usage.dollars, secondsPerDollar: usage.secondsPerDollar, sandboxType: usage.sandboxType, running: false });
    since = until;
  }
  const confirmed = (await inspection.inventory(org)).find(r => r.id === vm.id);
  if (confirmed?.access !== 'owner' || confirmed.state !== 'archived' || confirmed.createdAt !== vm.createdAt || confirmed.team?.id !== vm.team?.id) throw new SandboxError('reconcile-usage refused: provider identity or archival changed during inspection');
  ledger.reconcileSandbox({ reservationId, sandboxId: vm.id, inspectionAccount: account, createdAt: vm.createdAt, closedAt: claim.closedAt,
    ...(vm.team === undefined ? {} : { walletId: vm.team.id }), receipts });
  return { reservationId, priceBasis: 'provider_list_usage', usd: receipts.reduce((sum, r) => sum + r.listPriceUsd, 0), alreadyReconciled: false };
}

/** A read-only inventory comparison. Provider list prices are usage evidence, not paid invoices. */
export async function discoverBoat(deps: Deps, org?: string, day?: string) {
  org ??= boatOrg(deps.env);
  const window = day === undefined ? undefined : boatUsageWindow(day);
  const inspection = deps.boatInspection ?? boatClientFromEnv(deps.env);
  const ledger = deps.backendOptions?.ledger ?? openLedger(ledgerPath(deps.env));
  const state = ledger.read();
  const inventory = await inspection.inventory(org);
  const rows: DiscoveredBoat[] = [];
  for (const vm of inventory) {
    const pending = state.reservations.filter(r => r.provider === 'boat' && r.sandboxId === vm.id);
    const recorded = state.events.filter(e => e.provider === 'boat' && e.sandboxId === vm.id);
    let usage: DiscoveryUsage;
    if (vm.access === 'owner') {
      try { usage = { kind: 'available', receipt: await inspection.usage(vm.id, window) }; }
      catch { usage = { kind: 'unavailable' }; }
    } else usage = { kind: 'ownership_unverified' };
    rows.push({ id: vm.id, state: vm.state, type: vm.type, access: vm.access, createdAt: vm.createdAt, ...(vm.team === undefined ? {} : { team: vm.team }), ledger: { pending: pending.length > 0, recorded: recorded.length > 0, accounts: [...new Set([...pending, ...recorded].map(r => r.account))] }, usage });
  }
  return { wallet: org ?? UNPINNED, readOnly: true, requestedUsageWindow: window ?? null, ledgerCorrupt: state.corrupt, priceBasis: 'provider_list_usage', rows };
}

// ---------------------------------------------------------------------------------------------
// Owned Boat VMs that nothing will close

/** Boat's stopped states: an archived or removed VM bills nothing more. */
const STOPPED_STATES: ReadonlySet<string> = new Set(['archived', 'cancelled']);

export type OrphanEvidence = 'untracked' | 'tracked' | 'claim_expired';
export type OrphanVerdict =
  | { readonly kind: 'not_owner' }
  | { readonly kind: 'archived' }
  | { readonly kind: 'kept'; readonly owner: 'closing' | 'record' | 'pending_create' }
  | { readonly kind: 'kept'; readonly owner: 'claim'; readonly until: string | null }
  | { readonly kind: 'orphan'; readonly evidence: OrphanEvidence; readonly archived: boolean };
export type OrphanAction = 'archive' | 'close' | 'none';

const costBasisSchema = z.discriminatedUnion('billing', [
  z.strictObject({ billing: z.literal('unknown'), usd: z.null() }),
  z.strictObject({ billing: z.literal('estimated'), usd: z.number().finite().nonnegative() }),
]);
const orphanReceiptSchema = z.strictObject({
  version: z.literal(1),
  sandboxId: z.string().regex(ID_FILE),
  action: z.enum(['archived', 'already_archived', 'archive_failed']),
  evidence: z.enum(['untracked', 'tracked', 'claim_expired']),
  at: z.iso.datetime(),
  inspectionAccount: z.string().regex(/^sha256:[0-9a-f]{12}$/),
  walletId: z.string().regex(ID_FILE).optional(),
  reservationId: z.uuid(),
  costBasis: costBasisSchema,
  error: z.string().min(1).regex(/^[^\n]*$/).optional(),
}).refine(r => (r.action === 'archive_failed') === (r.error !== undefined), { message: 'an error belongs to a failed archive only', path: ['error'] })
  .refine(r => r.costBasis.billing === 'unknown' || (r.action === 'archived' && r.evidence === 'claim_expired'), { message: 'only a settled admission claim carries an estimate', path: ['costBasis'] });
export type BoatOrphanReceipt = z.output<typeof orphanReceiptSchema>;
const UNKNOWN_BILLING = { billing: 'unknown', usd: null } as const;

export const boatOrphanReceiptsPath = (ledgerFile: string): string => `${ledgerFile}.boat-orphans.jsonl`;

async function appendOrphanReceipt(file: string, input: z.input<typeof orphanReceiptSchema>): Promise<BoatOrphanReceipt> {
  const row = orphanReceiptSchema.parse(input);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = await readFile(file, 'utf8').catch(() => '');
  await appendFile(file, `${text !== '' && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(row)}\n`, { mode: 0o600, flush: true });
  return row;
}

const observationOf = (reservations: readonly Reservation[], id: string): Reservation | undefined =>
  reservations.find(r => r.origin === 'inventory' && r.provider === 'boat' && r.sandboxId === id);
const admitted = (r: Reservation): boolean => r.origin === undefined && r.provider === 'boat' && r.kind === 'sandbox';
/** Where the meter bounds an admitted VM's lifetime (its provider TTL), or undefined when the claim carries none. */
const claimEnd = (r: Reservation): number | undefined =>
  r.sandboxPricing?.maxLifetimeSeconds === undefined ? undefined : Date.parse(r.startedAt ?? r.t) + r.sandboxPricing.maxLifetimeSeconds * 1000;

async function orphanVerdict(vm: BoatInventorySandbox, reservations: readonly Reservation[], now: number, dir: string): Promise<OrphanVerdict> {
  if (vm.access !== 'owner') return { kind: 'not_owner' };
  const observed = observationOf(reservations, vm.id);
  // An open admission claim on an archived VM is the meter's or reconcile-create's to settle.
  if (STOPPED_STATES.has(vm.state)) return observed !== undefined && observed.closedAt === undefined ? { kind: 'orphan', evidence: 'tracked', archived: true } : { kind: 'archived' };
  const lock = await readFile(lockFile(dir, vm.id), 'utf8').catch(() => undefined);
  const holder = lock === undefined ? undefined : holderOf(lock);
  if (holder !== undefined && isAlive(holder)) return { kind: 'kept', owner: 'closing' };
  // A record that does not parse still names an owner.
  if (await loadRecord(dir, vm.id).then(rec => rec !== undefined, () => true)) return { kind: 'kept', owner: 'record' };
  const ends = reservations.filter(r => admitted(r) && r.sandboxId === vm.id).map(claimEnd);
  if (ends.length > 0) {
    const known = ends.filter((end): end is number => end !== undefined);
    if (known.length < ends.length) return { kind: 'kept', owner: 'claim', until: null };
    if (known.some(end => end > now)) return { kind: 'kept', owner: 'claim', until: new Date(Math.max(...known)).toISOString() };
    return { kind: 'orphan', evidence: 'claim_expired', archived: false };
  }
  if (observed !== undefined) return { kind: 'orphan', evidence: 'tracked', archived: false };
  // A live controller may be creating this very VM.
  if (reservations.some(r => admitted(r) && r.sandboxId === undefined && (claimEnd(r) ?? Infinity) > now)) return { kind: 'kept', owner: 'pending_create' };
  return { kind: 'orphan', evidence: 'untracked', archived: false };
}

/** The claim's settled lifetime as an estimate, or unknown while it is open, unpriced in any part, or has no lines. */
function settledBasis(ledger: Ledger, reservationId: string): BoatOrphanReceipt['costBasis'] {
  const { events, reservations } = ledger.read();
  const settled = events.filter(e => e.reservationId === reservationId);
  const usd = settled.reduce<number | null>((sum, e) => sum === null || e.usd === null ? null : sum + e.usd, 0);
  return reservations.some(r => r.id === reservationId) || settled.length === 0 || usd === null ? UNKNOWN_BILLING : { billing: 'estimated', usd: roundUsd(usd) };
}

/**
 * Owned Boat VMs that no live controller, handoff record or admission claim will close. A dry run
 * only reads inventory and local state. `apply` archives each orphan in turn and appends one receipt
 * per VM right after its action, so a crash keeps the receipts of finished VMs.
 */
export async function reconcileOrphans(deps: Deps, opts: { readonly apply: boolean; readonly org?: string }) {
  const org = opts.org ?? boatOrg(deps.env);
  const account = accountFor('boat', boatKey(deps.env));
  const ledger = deps.backendOptions?.ledger ?? openLedger(ledgerPath(deps.env));
  const snapshot = () => {
    const read = ledger.read();
    if (opts.apply && read.corrupt > 0) throw new SandboxError('reconcile-orphans --apply refused: the spend ledger contains corrupt records');
    return read;
  };
  if (opts.apply) snapshot();
  const caps = opts.apply ? capsFromEnv(deps.env) : {};
  const inspection = deps.boatInspection ?? boatClientFromEnv(deps.env);
  const dir = recordsDir(deps.env);
  const inventory = await inspection.inventory(org);
  // Read after the inventory: the meter reserves before it creates, so every listed VM's claim is in this snapshot.
  const state = snapshot();
  const now = ledger.now();
  const plan: { vm: BoatInventorySandbox; verdict: OrphanVerdict }[] = [];
  for (const vm of inventory) plan.push({ vm, verdict: await orphanVerdict(vm, state.reservations, now, dir) });
  const rows = plan.map(({ vm, verdict }) => ({ id: vm.id, state: vm.state, verdict, action: (verdict.kind !== 'orphan' ? 'none' : verdict.archived ? 'close' : 'archive') satisfies OrphanAction }));
  const receiptsFile = boatOrphanReceiptsPath(ledger.path);
  const receipts: BoatOrphanReceipt[] = [];
  const shared: Deps = { ...deps, backendOptions: { ...deps.backendOptions, ledger } };
  for (const { vm, verdict } of opts.apply ? plan : []) {
    if (verdict.kind !== 'orphan') continue;
    let reservationId: string | undefined;
    switch (verdict.evidence) {
      case 'untracked':
        reservationId = ledger.observeSandbox({ account, sandboxId: vm.id, caps });
        break;
      case 'tracked':
        reservationId = observationOf(state.reservations, vm.id)?.id;
        break;
      case 'claim_expired': {
        const claims = state.reservations.filter(r => admitted(r) && r.sandboxId === vm.id);
        reservationId = (claims.find(r => r.account === account) ?? claims[0])?.id;
        break;
      }
      default:
        return assertNever(verdict.evidence);
    }
    if (reservationId === undefined) throw new SandboxError(`reconcile-orphans lost the ledger entry for ${vm.id}`);
    const base = { version: 1, sandboxId: vm.id, evidence: verdict.evidence, inspectionAccount: account, reservationId, ...(vm.team === undefined ? {} : { walletId: vm.team.id }) } as const;
    let receipt: z.input<typeof orphanReceiptSchema>;
    try {
      if (verdict.archived) {
        ledger.markSandboxClosed(reservationId, vm.id);
        receipt = { ...base, action: 'already_archived', at: new Date(ledger.now()).toISOString(), costBasis: UNKNOWN_BILLING };
      } else {
        await downDetached(vm.id, shared);
        receipt = { ...base, action: 'archived', at: new Date(ledger.now()).toISOString(), costBasis: verdict.evidence === 'claim_expired' ? settledBasis(ledger, reservationId) : UNKNOWN_BILLING };
      }
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]?.trim() || 'archive failed without a message';
      receipt = { ...base, action: 'archive_failed', at: new Date(ledger.now()).toISOString(), costBasis: UNKNOWN_BILLING, error: message };
    }
    receipts.push(await appendOrphanReceipt(receiptsFile, receipt));
  }
  return { wallet: org ?? UNPINNED, dryRun: !opts.apply, ledgerCorrupt: state.corrupt, receiptsFile, rows, receipts };
}
