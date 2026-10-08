/**
 * `bun run studio -- reconcile-jobs` (YOS-233, A-355): Studio jobs whose lease ran out and whose process is gone, found
 * by the studio's own lease rule (`recoveryOf`) on a fake clock and a fake process table, and stopped with receipts.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RECONCILE_JOURNAL, reconcileJobs } from '../src/studio/reconcile.ts';
import { loadRuns, RUN_STORE_FILE, saveRuns, type Processes, type StoredRun } from '../src/studio/runstore.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const NOW = '2026-10-08T04:00:00.000Z';
const EXPIRED = { holder: 'studio-11-dead', expiresAt: '2026-10-08T03:59:00.000Z' };
const LIVE = { holder: 'studio-22-live', expiresAt: '2026-10-08T04:00:30.000Z' };

let tmp = '';
before(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'worldgen-reconcile-jobs-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

const job = (over: Partial<StoredRun> & { readonly runId: string }): StoredRun => ({
  kind: 'generate', tenant: 'default', key: `key-${over.runId}`, fingerprint: 'f', phase: 'running', lease: EXPIRED, outDir: `/tmp/out-${over.runId}`,
  pid: null, knownRuns: [], startedAt: '2026-10-08T03:00:00.000Z', exitCode: null, ...over,
});

const JOBS: readonly StoredRun[] = [
  job({ runId: 'run-leased', pid: 101, lease: LIVE }),
  job({ runId: 'run-alive', pid: 202 }),
  job({ runId: 'run-dead', pid: 303 }),
  job({ runId: 'ep-intent', kind: 'episode', tenant: 'acme', phase: 'intent', episode: { world: 'helpdesk', task: 't1', agent: 'noop' } }),
  job({ runId: 'run-legacy', lease: null, key: 'legacy:run-legacy', fingerprint: '' }),
  job({ runId: 'run-done', phase: 'finished', lease: null, exitCode: 0, pid: 404 }),
];

/** A process table where only `live` pids exist; every lookup is recorded, and nothing may be signalled. */
function table(live: readonly number[], onAlive: (pid: number) => void = () => undefined) {
  const looked: number[] = [];
  const processes: Processes = {
    alive(pid) { looked.push(pid); onAlive(pid); return live.includes(pid); },
    kill() { throw new Error('reconcile-jobs never signals a process'); },
  };
  return { looked, processes };
}

async function registry(name: string, jobs: readonly StoredRun[] = JOBS): Promise<string> {
  const dir = await mkdtemp(path.join(tmp, `${name}-`));
  await saveRuns(dir, jobs);
  return dir;
}

const lines = async (file: string): Promise<unknown[]> => (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const byId = async (dir: string): Promise<Map<string, StoredRun>> => new Map((await loadRuns(dir)).map((r) => [r.runId, r]));
const clock = () => Date.parse(NOW);

const PLANNED = [
  { runId: 'run-leased', kind: 'generate', tenant: 'default', phase: 'running', verdict: 'lease_live', action: 'none' },
  { runId: 'run-alive', kind: 'generate', tenant: 'default', phase: 'running', verdict: 'process_live', action: 'none' },
  { runId: 'run-dead', kind: 'generate', tenant: 'default', phase: 'running', verdict: 'stale', action: 'stop' },
  { runId: 'ep-intent', kind: 'episode', tenant: 'acme', phase: 'intent', verdict: 'stale', action: 'stop' },
  { runId: 'run-legacy', kind: 'generate', tenant: 'default', phase: 'running', verdict: 'stale', action: 'stop' },
];
const pair = (runId: string, kind: string, tenant: string, reason: string, from: string) => {
  const facts = { version: 1, runId, kind, tenant, reason, from, at: NOW };
  return [{ ...facts, action: 'stop_started' }, { ...facts, action: 'stopped' }];
};

describe('reconcile-jobs', () => {
  it('a dry run lists every unfinished job with the studio\'s verdict and changes nothing', async () => {
    const dir = await registry('dry');
    const before = await readFile(path.join(dir, RUN_STORE_FILE), 'utf8');
    const { processes } = table([202]);
    const result = await reconcileJobs({ worldsDir: dir, apply: false, now: clock, processes });
    assert.deepEqual(result, { worldsDir: dir, dryRun: true, tenant: null, journal: path.join(dir, RECONCILE_JOURNAL), rows: PLANNED, receipts: [] });
    assert.equal(await readFile(path.join(dir, RUN_STORE_FILE), 'utf8'), before);
    assert.equal(existsSync(path.join(dir, RECONCILE_JOURNAL)), false);
  });

  it('apply stops only the stale jobs as a studio would, never one with a live lease or process, and a rerun converges', async () => {
    const dir = await registry('apply');
    const { looked, processes } = table([202]);
    const result = await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes });
    const receipts = [
      ...pair('run-dead', 'generate', 'default', 'process_gone', EXPIRED.holder),
      ...pair('ep-intent', 'episode', 'acme', 'start_unconfirmed', EXPIRED.holder),
      ...pair('run-legacy', 'generate', 'default', 'process_gone', 'legacy'),
    ];
    assert.deepEqual([result.rows, result.receipts], [PLANNED, receipts]);
    assert.deepEqual(await lines(result.journal), receipts);
    const after = await byId(dir);
    for (const id of ['run-leased', 'run-alive', 'run-done']) assert.deepEqual(after.get(id), JOBS.find((j) => j.runId === id), id);
    assert.deepEqual(['run-dead', 'ep-intent', 'run-legacy'].map((id) => { const r = after.get(id); return [r?.phase, r?.lease, r?.recovery]; }), [
      ['finished', null, { at: NOW, from: EXPIRED.holder, outcome: 'stopped', reason: 'process_gone' }],
      ['finished', null, { at: NOW, from: EXPIRED.holder, outcome: 'stopped', reason: 'start_unconfirmed' }],
      ['finished', null, { at: NOW, from: 'legacy', outcome: 'stopped', reason: 'process_gone' }],
    ]);
    assert.deepEqual([...new Set(looked)].sort(), [202, 303]);

    const again = await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes });
    assert.deepEqual([again.rows.map((r) => [r.runId, r.verdict]), again.receipts], [[['run-leased', 'lease_live'], ['run-alive', 'process_live']], []]);
    assert.deepEqual(await lines(result.journal), receipts);
  });

  it('a lease that has not run out protects a job even with its process gone, and the lease expiring a second later does not', async () => {
    const dir = await registry('edge', [job({ runId: 'run-edge', pid: 505, lease: { holder: 'studio-33', expiresAt: '2026-10-08T04:00:01.000Z' } })]);
    const { processes } = table([]);
    assert.deepEqual((await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes })).receipts, []);
    const later = await reconcileJobs({ worldsDir: dir, apply: true, now: () => Date.parse('2026-10-08T04:00:01.000Z'), processes });
    assert.deepEqual(later.receipts.map((r) => [r.runId, r.action, r.at]), [['run-edge', 'stop_started', '2026-10-08T04:00:01.000Z'], ['run-edge', 'stopped', '2026-10-08T04:00:01.000Z']]);
  });

  it('--tenant lists and stops only that tenant\'s jobs, and its receipts carry the tenant', async () => {
    const dir = await registry('tenant');
    const { processes } = table([202]);
    const result = await reconcileJobs({ worldsDir: dir, apply: true, tenant: 'acme', now: clock, processes });
    assert.deepEqual([result.tenant, result.rows.map((r) => r.runId), result.receipts], ['acme', ['ep-intent'], pair('ep-intent', 'episode', 'acme', 'start_unconfirmed', EXPIRED.holder)]);
    assert.deepEqual([...(await byId(dir)).values()].filter((r) => r.phase === 'finished').map((r) => r.runId), ['ep-intent', 'run-done']);
  });

  it('reads the registry again before each write: a job a studio records meanwhile survives, and one it takes over is left alone', async () => {
    const dir = await registry('race', [job({ runId: 'run-dead', pid: 303 }), job({ runId: 'run-taken', pid: 606 })]);
    let raced = false;
    // A studio writes the registry while reconcile-jobs is still listing: it takes over run-taken and records run-new.
    const { processes } = table([], (pid) => {
      if (raced || pid !== 606) return;
      raced = true;
      const file = path.join(dir, RUN_STORE_FILE);
      const current = JSON.parse(readFileSync(file, 'utf8')) as StoredRun[];
      writeFileSync(file, JSON.stringify([...current.map((r) => (r.runId === 'run-taken' ? { ...r, lease: LIVE } : r)), job({ runId: 'run-new', phase: 'intent', lease: LIVE })]));
    });
    const result = await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes });
    assert.deepEqual(result.rows.map((r) => [r.runId, r.verdict]), [['run-dead', 'stale'], ['run-taken', 'stale']]);
    const taken = { version: 1, runId: 'run-taken', kind: 'generate', tenant: 'default', reason: 'process_gone', from: EXPIRED.holder, at: NOW };
    assert.deepEqual(result.receipts, [...pair('run-dead', 'generate', 'default', 'process_gone', EXPIRED.holder), { ...taken, action: 'stop_started' }, { ...taken, action: 'stop_skipped', why: 'no_longer_stale' }]);
    const after = await byId(dir);
    assert.deepEqual([after.get('run-taken')?.phase, after.get('run-taken')?.lease, after.get('run-new')?.phase], ['running', LIVE, 'intent']);
  });

  it('completes an intent a crashed run left: an outcome once the registry shows the job stopped, never a second intent', async () => {
    const dir = await registry('crash', [job({ runId: 'run-dead', pid: 303 }), job({ runId: 'run-half', pid: 707 })]);
    const journal = path.join(dir, RECONCILE_JOURNAL);
    const facts = (runId: string) => ({ version: 1, runId, kind: 'generate', tenant: 'default', reason: 'process_gone', from: EXPIRED.holder, at: '2026-10-08T03:59:30.000Z' });
    await appendFile(journal, `${JSON.stringify({ ...facts('run-dead'), action: 'stop_started' })}\n${JSON.stringify({ ...facts('run-half'), action: 'stop_started' })}\n`);
    await saveRuns(dir, (await loadRuns(dir)).map((r) => (r.runId === 'run-half' ? { ...r, phase: 'finished', lease: null, recovery: { at: '2026-10-08T03:59:31.000Z', from: EXPIRED.holder, outcome: 'stopped', reason: 'process_gone' } } : r)));
    const { processes } = table([]);
    const result = await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes });
    assert.deepEqual(result.receipts, [
      { ...facts('run-half'), action: 'stopped', at: NOW, recovered: true },
      { ...facts('run-dead'), action: 'stopped', at: NOW },
    ]);
    assert.deepEqual((await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes })).receipts, []);
    assert.deepEqual((await lines(journal)).map((r) => (r as { action: string }).action), ['stop_started', 'stop_started', 'stopped', 'stopped']);
  });

  it('reads liveness before the registry, so a job a studio records while liveness is checked survives the write', async () => {
    const dir = await registry('lost-write', [job({ runId: 'run-dead', pid: 303 })]);
    let checks = 0;
    // The second look at pid 303 is the one made just before the stop is written.
    const { processes } = table([], (pid) => {
      if (pid !== 303 || ++checks !== 2) return;
      const file = path.join(dir, RUN_STORE_FILE);
      writeFileSync(file, JSON.stringify([...(JSON.parse(readFileSync(file, 'utf8')) as StoredRun[]), job({ runId: 'run-b', phase: 'intent', lease: LIVE })]));
    });
    const result = await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes });
    assert.deepEqual(result.receipts, pair('run-dead', 'generate', 'default', 'process_gone', EXPIRED.holder));
    const after = await byId(dir);
    assert.deepEqual([after.get('run-dead')?.phase, after.get('run-b')?.phase, after.get('run-b')?.lease], ['finished', 'intent', LIVE]);
  });

  it('records a stop that a studio write undid as stop_skipped overwritten, not stopped', async () => {
    const dir = await registry('overwritten', [job({ runId: 'run-dead', pid: 303 })]);
    const file = path.join(dir, RUN_STORE_FILE);
    const original = readFileSync(file, 'utf8');
    let undone = false;
    // A studio that read the registry before the stop writes its old copy back right after it.
    const now = (): number => {
      if (!undone && (JSON.parse(readFileSync(file, 'utf8')) as StoredRun[])[0]?.phase === 'finished') {
        undone = true;
        writeFileSync(file, original);
      }
      return Date.parse(NOW);
    };
    const result = await reconcileJobs({ worldsDir: dir, apply: true, now, processes: table([]).processes });
    const facts = { version: 1, runId: 'run-dead', kind: 'generate', tenant: 'default', reason: 'process_gone', from: EXPIRED.holder, at: NOW };
    assert.deepEqual(result.receipts, [{ ...facts, action: 'stop_started' }, { ...facts, action: 'stop_skipped', why: 'overwritten' }]);
    assert.equal((await byId(dir)).get('run-dead')?.phase, 'running');
  });

  it('closes an intent whose job finished by another path, or left the registry, as stop_skipped', async () => {
    const dir = await registry('closed', [job({ runId: 'run-ended', phase: 'finished', lease: null, exitCode: 0, pid: 808 })]);
    const journal = path.join(dir, RECONCILE_JOURNAL);
    const facts = (runId: string) => ({ version: 1, runId, kind: 'generate', tenant: 'default', reason: 'process_gone', from: EXPIRED.holder, at: '2026-10-08T03:59:30.000Z' });
    await appendFile(journal, `${JSON.stringify({ ...facts('run-ended'), action: 'stop_started' })}\n${JSON.stringify({ ...facts('run-gone'), action: 'stop_started' })}\n`);
    const result = await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes: table([]).processes });
    assert.deepEqual(result.receipts, [
      { ...facts('run-ended'), action: 'stop_skipped', why: 'finished_elsewhere', at: NOW },
      { ...facts('run-gone'), action: 'stop_skipped', why: 'missing', at: NOW },
    ]);
    assert.deepEqual((await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes: table([]).processes })).receipts, []);
  });

  it('writes nothing when no registry exists', async () => {
    const dir = await mkdtemp(path.join(tmp, 'empty-'));
    const result = await reconcileJobs({ worldsDir: dir, apply: true, now: clock, processes: table([]).processes });
    assert.deepEqual([result.rows, result.receipts, existsSync(path.join(dir, RUN_STORE_FILE)), existsSync(result.journal)], [[], [], false, false]);
  });
});

describe('bun run studio -- reconcile-jobs', () => {
  const run = (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...(process.versions.bun === undefined ? ['--import', 'tsx'] : []), 'src/cli/studio.ts', 'reconcile-jobs', ...args], { cwd: CODE_DIR, env: { PATH: process.env['PATH'] ?? '' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
      child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

  it('dry-runs, then stops a job whose process is gone with --apply, and exits 2 on a bad argument', { timeout: 20000 }, async () => {
    // No process has this pid: macOS and Linux both cap pids far below it.
    const dir = await registry('cli', [job({ runId: 'run-gone', pid: 2_000_000_000 })]);
    const dry = await run(['--worlds-dir', dir]);
    assert.deepEqual([dry.code, (JSON.parse(dry.stdout) as { rows: { runId: string; action: string }[] }).rows.map((r) => [r.runId, r.action])], [3, [['run-gone', 'stop']]]);
    const applied = await run(['--worlds-dir', dir, '--apply', '--tenant', 'default']);
    assert.deepEqual([applied.code, (JSON.parse(applied.stdout) as { receipts: { action: string }[] }).receipts.map((r) => r.action)], [0, ['stop_started', 'stopped']]);
    assert.equal((await byId(dir)).get('run-gone')?.phase, 'finished');
    assert.equal((await run(['--worlds-dir', dir])).code, 0);
    const bad = await run(['--force']);
    assert.deepEqual([bad.code, bad.stderr.split('\n')[0]], [2, 'reconcile-jobs: unknown or repeated argument --force']);
  });
});
