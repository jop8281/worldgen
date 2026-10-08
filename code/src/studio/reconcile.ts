/**
 * Studio jobs that nothing will finish (YOS-233, A-355): unfinished generation runs and agent episodes in
 * `.studio-runs.json` whose lease ran out and whose process is gone. A studio applies the same rule when it starts
 * (`recoveryOf`, A-335); this applies it without starting one. A dry run reads the registry and the process table only.
 * `apply` stops each such job as a studio would, with an intent receipt before and an outcome receipt after, in a
 * journal beside the registry. A job with a live lease or a live process is never touched; a pid the OS gave to another
 * process since the job recorded it is not live (A-373). The registry has no lock: a studio that read it before the stop
 * and writes after it undoes the stop, and the outcome then says so. Before a write, a registry `apply` cannot read whole
 * is kept aside, as a studio keeps it.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadRuns, loadRunsToWrite, recoveryOf, saveRuns, stderrLine, stoppedRun, type JobKind, type Processes, type RecoveryDecision, type StoredRun } from './runstore.ts';

/** The receipt journal's file name, beside the run registry in the worlds directory. */
export const RECONCILE_JOURNAL = '.studio-reconcile.jsonl';

const receiptSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1),
  kind: z.enum(['generate', 'episode']),
  tenant: z.string(),
  action: z.enum(['stop_started', 'stopped', 'stop_skipped', 'stop_failed']),
  /**
   * Why a stop was skipped: the job was no longer stale when read again just before the write, a studio's write undid
   * the stop, the job finished by another path, or it left the registry.
   */
  why: z.enum(['no_longer_stale', 'overwritten', 'finished_elsewhere', 'missing']).optional(),
  reason: z.enum(['process_gone', 'start_unconfirmed']),
  /** The lease holder that left the job, or `legacy`. */
  from: z.string(),
  at: z.iso.datetime(),
  /** The outcome of an intent a crashed run left without one, written once the registry shows the job finished. */
  recovered: z.literal(true).optional(),
  error: z.string().min(1).regex(/^[^\n]*$/).optional(),
}).refine((r) => (r.action === 'stop_failed') === (r.error !== undefined), { message: 'an error belongs to a failed stop only', path: ['error'] })
  .refine((r) => (r.action === 'stop_skipped') === (r.why !== undefined), { message: 'a why belongs to a skipped stop only', path: ['why'] })
  .refine((r) => r.recovered === undefined || r.action === 'stopped', { message: 'only a stop is recovered', path: ['recovered'] });
export type JobReceipt = z.output<typeof receiptSchema>;

/** `stale`: lease expired and process gone, so a studio would stop it. The other two are never touched. */
export type JobVerdict = 'lease_live' | 'process_live' | 'stale';
export type JobRow = { readonly runId: string; readonly kind: JobKind; readonly tenant: string; readonly phase: StoredRun['phase']; readonly verdict: JobVerdict; readonly action: 'stop' | 'none' };

export type ReconcileJobsOptions = {
  readonly worldsDir: string;
  readonly apply: boolean;
  /** Only this tenant's jobs; all tenants when absent. */
  readonly tenant?: string | undefined;
  readonly now: () => number;
  readonly processes: Processes;
  /** Where `apply` says it kept a damaged registry aside. Defaults to stderr. */
  readonly log?: ((line: string) => void) | undefined;
};

/** Whether the lease rules stopped this job, here or in a studio. A studio's close stopping its own job is not that (A-363). */
const leaseStopped = (run: StoredRun | undefined): boolean => run?.recovery?.outcome === 'stopped' && run.recovery.reason !== 'studio_closed';

async function append(file: string, input: z.input<typeof receiptSchema>): Promise<JobReceipt> {
  const row = receiptSchema.parse(input);
  const text = await readFile(file, 'utf8').catch(() => '');
  await appendFile(file, `${text !== '' && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(row)}\n`, { mode: 0o600, flush: true });
  return row;
}

/** The last intent of each job that no outcome followed. A line that does not parse is skipped. */
async function openIntents(file: string): Promise<Map<string, JobReceipt>> {
  const open = new Map<string, JobReceipt>();
  for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n')) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    const row = receiptSchema.safeParse(raw);
    if (!row.success) continue;
    if (row.data.action === 'stop_started') open.set(row.data.runId, row.data);
    else open.delete(row.data.runId);
  }
  return open;
}

export async function reconcileJobs(opts: ReconcileJobsOptions) {
  const journal = path.join(opts.worldsDir, RECONCILE_JOURNAL);
  const mine = (run: { readonly tenant: string }): boolean => opts.tenant === undefined || run.tenant === opts.tenant;
  const listedAt = opts.now();
  const rows: JobRow[] = [];
  const stale: { readonly row: JobRow; readonly pid: number | null; readonly decision: Extract<RecoveryDecision, { kind: 'stop' }> }[] = [];
  for (const run of await loadRuns(opts.worldsDir)) {
    if (run.phase === 'finished' || !mine(run)) continue;
    const decision = recoveryOf(run, listedAt, null, opts.processes);
    const verdict: JobVerdict = decision.kind === 'stop' ? 'stale' : decision.kind === 'resume' ? 'process_live' : 'lease_live';
    const row: JobRow = { runId: run.runId, kind: run.kind, tenant: run.tenant, phase: run.phase, verdict, action: verdict === 'stale' ? 'stop' : 'none' };
    rows.push(row);
    if (decision.kind === 'stop') stale.push({ row, pid: run.pid, decision });
  }
  const receipts: JobReceipt[] = [];
  const result = () => ({ worldsDir: opts.worldsDir, dryRun: !opts.apply, tenant: opts.tenant ?? null, journal, rows, receipts });
  if (!opts.apply) return result();

  const intents = await openIntents(journal);
  const current = new Map((await loadRuns(opts.worldsDir)).map((r) => [r.runId, r]));
  // An intent left open closes once its job finished: as stopped when the lease rules stopped it, as skipped otherwise.
  const closing = [...intents.values()].filter((i) => mine(i) && !stale.some((s) => s.row.runId === i.runId) && (current.get(i.runId)?.phase ?? 'finished') === 'finished');
  if (closing.length === 0 && stale.length === 0) return result();
  await mkdir(opts.worldsDir, { recursive: true });
  await appendFile(journal, '', { mode: 0o600 });
  const at = () => new Date(opts.now()).toISOString();
  for (const intent of closing) {
    const { action: _action, at: _at, error: _error, why: _why, ...kept } = intent;
    const run = current.get(intent.runId);
    receipts.push(await append(journal, leaseStopped(run)
      ? { ...kept, action: 'stopped', at: at(), recovered: true }
      : { ...kept, action: 'stop_skipped', why: run === undefined ? 'missing' : 'finished_elsewhere', at: at() }));
  }
  for (const { row, pid, decision: listed } of stale) {
    const open = intents.get(row.runId);
    const intent = open ?? await append(journal, { version: 1, runId: row.runId, kind: row.kind, tenant: row.tenant, reason: listed.reason, from: listed.from, action: 'stop_started', at: at() });
    if (open === undefined) receipts.push(intent);
    const facts = { version: 1, runId: row.runId, kind: row.kind, tenant: row.tenant, reason: intent.reason, from: intent.from } as const;
    // Liveness and the pid's start are read first, so nothing but the decision runs between reading the registry and
    // writing it back; a job a live studio recorded meanwhile survives, and one it resumed or finished meanwhile is left as it is.
    const live = pid !== null && opts.processes.alive(pid);
    const started = pid !== null && live ? opts.processes.startOf(pid) : null;
    const asOf: Processes = {
      alive: (p) => (p === pid ? live : opts.processes.alive(p)),
      startOf: (p) => (p === pid ? started : opts.processes.startOf(p)),
      kill: opts.processes.kill,
    };
    const at0 = opts.now();
    let outcome: z.input<typeof receiptSchema>;
    try {
      const fresh = await loadRunsToWrite(opts.worldsDir, { now: opts.now, log: opts.log ?? stderrLine });
      const run = fresh.find((r) => r.runId === row.runId);
      const decision = run === undefined ? undefined : recoveryOf(run, at0, null, asOf);
      if (run === undefined || decision?.kind !== 'stop') {
        outcome = { ...facts, action: 'stop_skipped', why: run === undefined ? 'missing' : run.phase === 'finished' ? 'finished_elsewhere' : 'no_longer_stale', at: at() };
      } else {
        await saveRuns(opts.worldsDir, fresh.map((r) => (r.runId === row.runId ? stoppedRun(r, decision, at0) : r)));
        const doneAt = at();
        const after = (await loadRuns(opts.worldsDir)).find((r) => r.runId === row.runId);
        const held = after?.phase === 'finished' && leaseStopped(after);
        outcome = held
          ? { ...facts, reason: decision.reason, from: decision.from, action: 'stopped', at: doneAt }
          : { ...facts, action: 'stop_skipped', why: 'overwritten', at: doneAt };
      }
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]?.trim() || 'stop failed without a message';
      outcome = { ...facts, action: 'stop_failed', at: at(), error: message };
    }
    receipts.push(await append(journal, outcome));
  }
  return result();
}
