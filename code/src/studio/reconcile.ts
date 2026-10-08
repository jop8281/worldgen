/**
 * Studio jobs that nothing will finish (YOS-233, A-355): unfinished generation runs and agent episodes in
 * `.studio-runs.json` whose lease ran out and whose process is gone. A studio applies the same rule when it starts
 * (`recoveryOf`, A-335); this applies it without starting one. A dry run reads the registry and the process table only.
 * `apply` stops each such job as a studio would, with an intent receipt before and an outcome receipt after, in a
 * journal beside the registry. A job with a live lease or a live process is never touched.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadRuns, recoveryOf, saveRuns, stoppedRun, type JobKind, type Processes, type StoredRun } from './runstore.ts';

/** The receipt journal's file name, beside the run registry in the worlds directory. */
export const RECONCILE_JOURNAL = '.studio-reconcile.jsonl';

const receiptSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1),
  kind: z.enum(['generate', 'episode']),
  tenant: z.string(),
  /** stop_skipped: the job was no longer stale when it was read again just before the write. */
  action: z.enum(['stop_started', 'stopped', 'stop_skipped', 'stop_failed']),
  reason: z.enum(['process_gone', 'start_unconfirmed']),
  /** The lease holder that left the job, or `legacy`. */
  from: z.string(),
  at: z.iso.datetime(),
  /** The outcome of an intent a crashed run left without one, written once the registry shows the job finished. */
  recovered: z.literal(true).optional(),
  error: z.string().min(1).regex(/^[^\n]*$/).optional(),
}).refine((r) => (r.action === 'stop_failed') === (r.error !== undefined), { message: 'an error belongs to a failed stop only', path: ['error'] })
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
};

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
  for (const run of await loadRuns(opts.worldsDir)) {
    if (run.phase === 'finished' || !mine(run)) continue;
    const decision = recoveryOf(run, listedAt, null, opts.processes);
    const verdict: JobVerdict = decision.kind === 'stop' ? 'stale' : decision.kind === 'resume' ? 'process_live' : 'lease_live';
    rows.push({ runId: run.runId, kind: run.kind, tenant: run.tenant, phase: run.phase, verdict, action: verdict === 'stale' ? 'stop' : 'none' });
  }
  const receipts: JobReceipt[] = [];
  const result = () => ({ worldsDir: opts.worldsDir, dryRun: !opts.apply, tenant: opts.tenant ?? null, journal, rows, receipts });
  if (!opts.apply) return result();

  const intents = await openIntents(journal);
  const finished = new Map((await loadRuns(opts.worldsDir)).filter((r) => r.phase === 'finished').map((r) => [r.runId, r]));
  const recovering = [...intents.values()].filter((i) => mine(i) && finished.get(i.runId)?.recovery?.outcome === 'stopped');
  const stopping = rows.filter((r) => r.action === 'stop');
  if (recovering.length === 0 && stopping.length === 0) return result();
  await mkdir(opts.worldsDir, { recursive: true });
  await appendFile(journal, '', { mode: 0o600 });
  const at = () => new Date(opts.now()).toISOString();
  // A run that crashed between its write and its outcome left an intent alone; the registry now shows the job stopped.
  for (const intent of recovering) {
    const { action: _action, at: _at, error: _error, ...kept } = intent;
    receipts.push(await append(journal, { ...kept, action: 'stopped', at: at(), recovered: true }));
  }
  for (const row of stopping) {
    // The registry is read again just before the write, and only this job changes, so a job a live studio recorded
    // meanwhile survives, and a job it resumed or finished meanwhile is left as it is.
    const fresh = await loadRuns(opts.worldsDir);
    const run = fresh.find((r) => r.runId === row.runId);
    const now = opts.now();
    const decision = run === undefined ? undefined : recoveryOf(run, now, null, opts.processes);
    const base = { version: 1, runId: row.runId, kind: row.kind, tenant: row.tenant, at: at() } as const;
    if (run === undefined || decision?.kind !== 'stop') {
      const open = intents.get(row.runId);
      if (open !== undefined) receipts.push(await append(journal, { ...open, action: 'stop_skipped', at: at() }));
      continue;
    }
    const facts = { ...base, reason: decision.reason, from: decision.from };
    if (!intents.has(row.runId)) receipts.push(await append(journal, { ...facts, action: 'stop_started' }));
    try {
      await saveRuns(opts.worldsDir, fresh.map((r) => (r.runId === row.runId ? stoppedRun(r, decision, now) : r)));
      receipts.push(await append(journal, { ...facts, action: 'stopped', at: at() }));
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]?.trim() || 'stop failed without a message';
      receipts.push(await append(journal, { ...facts, action: 'stop_failed', at: at(), error: message }));
    }
  }
  return result();
}
