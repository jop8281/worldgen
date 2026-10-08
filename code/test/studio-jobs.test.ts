/**
 * Studio jobs (YOS-231, A-335): an intent on disk before the child, a lease its holder renews, recovery when the holder
 * died, and an idempotency key so a retried or doubled POST never starts a second run. The spawner, the runner and
 * the process table are fakes and the clock is injected, so no child starts and no lease is waited out.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import type { Processes } from '../src/studio/runstore.ts';
import { studioServer, type StudioOptions, type StudioServer } from '../src/studio/server.ts';

type Json = { [k: string]: unknown };

async function json(base: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text === '' ? null : JSON.parse(text)) as Json };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `probe` answers non-null. */
async function until<T>(probe: () => Promise<T | null>, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > end) assert.fail(`nothing after ${ms} ms`);
    await sleep(10);
  }
}

type ChildPlan = { diesOn?: readonly string[]; pid?: number; onSpawn?: (argv: readonly string[]) => void };

function fakeChild(plan: ChildPlan = {}): { child: SpawnedChild; signals: string[]; exitWith: (code: number | null) => void } {
  const signals: string[] = [];
  const diesOn = plan.diesOn ?? ['SIGTERM', 'SIGKILL'];
  let dead = false;
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const child: SpawnedChild = {
    pid: plan.pid ?? 43210,
    exited,
    kill(signal) {
      signals.push(signal);
      if (!dead && diesOn.includes(signal)) {
        dead = true;
        settle(signal === 'SIGKILL' ? null : 0);
      }
      return !dead;
    },
    output: () => '',
  };
  return {
    child,
    signals,
    exitWith(code) {
      dead = true;
      settle(code);
    },
  };
}

type SpawnedCall = { argv: string[]; handle: ReturnType<typeof fakeChild> };

function fakeSpawner(plan: () => ChildPlan = () => ({})): { spawner: Spawner; spawned: SpawnedCall[] } {
  const spawned: SpawnedCall[] = [];
  const spawner: Spawner = (argv) => {
    const one = plan();
    const handle = fakeChild(one);
    spawned.push({ argv: [...argv], handle });
    one.onSpawn?.(argv);
    return handle.child;
  };
  return { spawner, spawned };
}

const gitRunner: Runner = async (argv) => (argv[0] === 'git' ? { code: 0, stdout: 'abc1234\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });

const T0 = Date.parse('2026-10-07T12:00:00.000Z');
/** A lease holder minted by a studio in this process. 'studio-dead' or 'studio-other' never match it. */
const MINE = new RegExp(`^studio-${process.pid}-[0-9a-f]{8}$`);
const GONE = 'the studio restarted while this run was running and its process is gone; its evidence stays in the <out>.partial directory';
const UNCONFIRMED = 'the studio stopped before it confirmed this run started, so it is never started again: its process may have started, and a paid run must not run twice';
const CLOSED = 'the studio closed before this run finished and sent its process SIGTERM, its clean stop; the run is never started again';

const roots: string[] = [];
const studios: StudioServer[] = [];
after(async () => {
  for (const s of studios) await s.close();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/**
 * `live` pids exist; `starts` is what the OS says each one started as (none: the OS says nothing). `killed` records
 * every signal the studio sends, which reaches no real process.
 */
type Fixture = { root: string; worldsDir: string; live: Set<number>; starts: Map<number, string>; killed: [number, string][]; processes: Processes };

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-jobs-'));
  roots.push(root);
  const worldsDir = path.join(root, 'prod', 'worlds');
  await mkdir(path.join(root, 'code'), { recursive: true });
  await mkdir(path.join(worldsDir, 'w1'), { recursive: true });
  await mkdir(path.join(worldsDir, 'w2'), { recursive: true });
  const live = new Set<number>();
  const starts = new Map<number, string>();
  const killed: [number, string][] = [];
  const processes: Processes = {
    alive: (pid) => live.has(pid),
    startOf: (pid) => (live.has(pid) ? starts.get(pid) ?? null : null),
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      return live.has(pid);
    },
  };
  return { root, worldsDir, live, starts, killed, processes };
}

async function open(f: Fixture, opts: Partial<StudioOptions> = {}): Promise<StudioServer> {
  const studio = await studioServer({ port: 0, repoRoot: f.root, worldsDir: f.worldsDir, spawner: fakeSpawner().spawner, runner: gitRunner, processes: f.processes, ...opts });
  studios.push(studio);
  return studio;
}

const registry = (f: Fixture): string => path.join(f.worldsDir, '.studio-runs.json');
const stored = async (f: Fixture): Promise<Json[]> => JSON.parse(await readFile(registry(f), 'utf8')) as Json[];
const writeRegistry = (f: Fixture, records: readonly Json[]): Promise<void> => writeFile(registry(f), JSON.stringify(records));

/** A generation run a studio that is now gone left running. */
const orphan = (f: Fixture, over: Json = {}): Json => ({
  runId: '20261007T110000Z-orphan', kind: 'generate', key: 'k-orphan', fingerprint: 'f'.repeat(64), phase: 'running',
  lease: { holder: 'studio-dead', expiresAt: '2026-10-07T11:59:00.000Z' }, outDir: path.join(f.worldsDir, 'gen-orphan'),
  pid: 7001, knownRuns: [], startedAt: '2026-10-07T11:00:00.000Z', exitCode: null, ...over,
});

const leaseOf = (body: Json): { holder: string; expiresAt: string } => (body['job'] as { lease: { holder: string; expiresAt: string } }).lease;
/** The job record with this studio's own holder id swapped for 'mine', after checking it is one this process minted. */
function jobWithMine(body: Json): Json {
  const job = body['job'] as Json;
  const lease = job['lease'] as { holder: string; expiresAt: string } | null;
  if (lease === null) return job;
  assert.match(lease.holder, MINE);
  return { ...job, lease: { ...lease, holder: 'mine' } };
}

/**
 * The run id of a generation of `body` that a gone studio left running as process 7701, its lease still live at T0.
 * A studio records the request's derived key and fingerprint, then the file is rewritten as the gone studio left it.
 */
async function leftRunning(f: Fixture, body: Json): Promise<string> {
  const a = await open(f, { now: () => T0 });
  const runId = String((await json(a.url, 'POST', '/api/generate', body)).body['runId']);
  await a.close();
  const [record] = await stored(f);
  await writeRegistry(f, [{ ...record, phase: 'running', lease: { holder: 'studio-dead', expiresAt: '2026-10-07T12:00:30.000Z' }, pid: 7701, exitCode: null }]);
  return runId;
}

describe('studio jobs: idempotent starts (A-335)', () => {
  it('answers a retried POST with the same Idempotency-Key from the first job, and refuses the key for another request', async () => {
    const f = await fixture();
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner });
    const body = { kind: 'description', text: 'T', outSlug: 'keyed' };
    const key = { 'idempotency-key': 'k-1' };
    const first = await json(studio.url, 'POST', '/api/generate', body, key);
    const runId = String(first.body['runId']);
    const outDir = path.join(f.worldsDir, 'gen-keyed');
    assert.match(runId, /^\d{8}T\d{6}Z-keyed-[0-9a-f]{6}$/);
    assert.deepEqual([first.status, first.body], [200, { runId, outDir, running: true, replayed: false }]);
    const again = await json(studio.url, 'POST', '/api/generate', body, key);
    assert.deepEqual([again.status, again.body], [200, { runId, outDir, running: true, replayed: true }]);
    assert.equal(s.spawned.length, 1);

    const other = await json(studio.url, 'POST', '/api/generate', { ...body, text: 'U' }, key);
    assert.deepEqual([other.status, other.body], [422, { error: { code: 'idempotency.mismatch', message: `Idempotency-Key k-1 was used for a different request (job ${runId})` } }]);

    s.spawned[0]!.handle.exitWith(0);
    await s.spawned[0]!.handle.child.exited;
    const late = await json(studio.url, 'POST', '/api/generate', body, key);
    assert.deepEqual([late.status, late.body], [200, { runId, outDir, running: false, replayed: true }]);
    assert.equal(s.spawned.length, 1);

    const bad = await json(studio.url, 'POST', '/api/generate', body, { 'idempotency-key': 'not a key' });
    assert.deepEqual([bad.status, (bad.body['error'] as Json)['code']], [400, 'idempotency.key']);
    assert.equal(s.spawned.length, 1);
  });

  it('starts one job for two identical POSTs with no key, and a new one once the first finished', async () => {
    const f = await fixture();
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner });
    const body = { kind: 'description', text: 'T', outSlug: 'twice' };
    const [a, b] = await Promise.all([json(studio.url, 'POST', '/api/generate', body), json(studio.url, 'POST', '/api/generate', body)]);
    assert.deepEqual([a.status, b.status, b.body['runId'], [a.body['replayed'], b.body['replayed']].sort()], [200, 200, a.body['runId'], [false, true]]);
    assert.equal(s.spawned.length, 1);

    s.spawned[0]!.handle.exitWith(0);
    await s.spawned[0]!.handle.child.exited;
    const rerun = await json(studio.url, 'POST', '/api/generate', body);
    assert.deepEqual([rerun.status, rerun.body['replayed'], s.spawned.length], [200, false, 2]);
    assert.notEqual(rerun.body['runId'], a.body['runId']);
  });

  it('starts the same request with no key anew when its running job belongs to a studio whose process is gone (A-363)', async () => {
    const f = await fixture();
    const body = { kind: 'description', text: 'T', outSlug: 'owner' };
    const stale = await leftRunning(f, body);
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, now: () => T0 });
    const fresh = await json(studio.url, 'POST', '/api/generate', body);
    assert.deepEqual([fresh.status, fresh.body['running'], fresh.body['replayed'], s.spawned.length], [200, true, false, 1]);
    assert.notEqual(fresh.body['runId'], stale);
    const again = await json(studio.url, 'POST', '/api/generate', body);
    assert.deepEqual([again.body['runId'], again.body['replayed'], s.spawned.length], [fresh.body['runId'], true, 1]);
    const old = await json(studio.url, 'GET', `/api/generate/${stale}`);
    assert.deepEqual([(old.body['job'] as Json)['phase'], leaseOf(old.body).holder], ['running', 'studio-dead']);
  });

  it('still replays the same request with no key onto a running job another studio holds while its process lives (A-363)', async () => {
    const f = await fixture();
    const body = { kind: 'description', text: 'T', outSlug: 'owner' };
    const stale = await leftRunning(f, body);
    f.live.add(7701);
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, now: () => T0 });
    const again = await json(studio.url, 'POST', '/api/generate', body);
    assert.deepEqual([again.status, again.body['runId'], again.body['running'], again.body['replayed'], s.spawned.length], [200, stale, true, true, 0]);
  });

  it('records the intent, held by this studio, before it spawns the child', async () => {
    const f = await fixture();
    let seen: Json[] = [];
    const s = fakeSpawner(() => ({ pid: 7301, onSpawn: () => {
      seen = JSON.parse(readFileSync(registry(f), 'utf8')) as Json[];
    } }));
    const studio = await open(f, { spawner: s.spawner, now: () => T0 });
    const post = await json(studio.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'intent' });
    const runId = String(post.body['runId']);
    assert.deepEqual(seen.map((r) => [r['runId'], r['phase'], r['pid'], (r['lease'] as Json)['expiresAt']]), [[runId, 'intent', null, '2026-10-07T12:00:30.000Z']]);
    const holder = String((seen[0]!['lease'] as Json)['holder']);
    assert.match(holder, MINE);

    const status = await json(studio.url, 'GET', `/api/generate/${runId}`);
    const job = status.body['job'] as Json;
    assert.match(String(job['key']), /^derived:[0-9a-f]{64}$/);
    assert.deepEqual([job['kind'], job['phase'], job['lease']], ['generate', 'running', { holder, expiresAt: '2026-10-07T12:00:30.000Z' }]);
    assert.deepEqual((await stored(f)).map((r) => [r['phase'], r['pid']]), [['running', 7301]]);
  });

  it('shares one in-flight proof between two POSTs with one key, keeps its reply, and refuses the key for another world', async () => {
    const f = await fixture();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: Runner = async (argv) => {
      if (argv[0] === 'git') return { code: 0, stdout: 'abc1234\n', stderr: '' };
      calls += 1;
      await gate;
      return { code: 0, stdout: '{"task":"t1","verified":true}\n', stderr: '' };
    };
    const studio = await open(f, { runner });
    const key = { 'idempotency-key': 'p-1' };
    const both = Promise.all([json(studio.url, 'POST', '/api/worlds/w1/proof', undefined, key), json(studio.url, 'POST', '/api/worlds/w1/proof', undefined, key)]);
    await until(async () => (calls === 1 ? true : null));
    await sleep(100);
    release();
    const proof = { world: 'w1', verified: true, tasks: [{ task: 't1', verified: true }] };
    const [a, b] = await both;
    assert.deepEqual([a.status, a.body, b.status, b.body, calls], [200, proof, 200, proof, 1]);

    const later = await json(studio.url, 'POST', '/api/worlds/w1/proof', undefined, key);
    assert.deepEqual([later.status, later.body, calls], [200, proof, 1]);
    const other = await json(studio.url, 'POST', '/api/worlds/w2/proof', undefined, key);
    assert.deepEqual([other.status, (other.body['error'] as Json)['code'], calls], [422, 'idempotency.mismatch', 1]);
  });

  it('refuses to start a job it cannot record, and spawns nothing', async () => {
    const f = await fixture();
    await mkdir(registry(f));
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner });
    const r = await json(studio.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'unrecorded' });
    assert.deepEqual([r.status, r.body], [503, { error: { code: 'job.unrecorded', message: 'The studio could not write .studio-runs.json, so it did not start the job: a job it cannot record could run twice' } }]);
    assert.equal(s.spawned.length, 0);
  });

  it('finishes a job whose spawn threw, so the same request with no key starts again', async () => {
    const f = await fixture();
    let calls = 0;
    const s = fakeSpawner();
    const spawner: Spawner = (argv, o) => {
      calls += 1;
      if (calls === 1) throw new Error('spawn EAGAIN');
      return s.spawner(argv, o);
    };
    const studio = await open(f, { spawner });
    const body = { kind: 'description', text: 'T', outSlug: 'spawn-threw' };
    const first = await json(studio.url, 'POST', '/api/generate', body);
    assert.deepEqual([first.status, (first.body['error'] as Json)['code']], [500, 'studio.error']);
    assert.deepEqual((await stored(f)).map((r) => [r['phase'], r['lease']]), [['finished', null]]);
    const again = await json(studio.url, 'POST', '/api/generate', body);
    assert.deepEqual([again.status, again.body['replayed'], calls, s.spawned.length], [200, false, 2, 1]);
  });
});

describe('studio jobs: leases and recovery (A-335)', () => {
  it('resumes a job whose holder died while its process lives, and takes the lease', async () => {
    const f = await fixture();
    await writeRegistry(f, [orphan(f)]);
    f.live.add(7001);
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, now: () => T0 });
    const r = await json(studio.url, 'GET', '/api/generate/20261007T110000Z-orphan');
    const resumed = {
      kind: 'generate', key: 'k-orphan', phase: 'running', lease: { holder: 'mine', expiresAt: '2026-10-07T12:00:30.000Z' },
      recovery: { at: '2026-10-07T12:00:00.000Z', from: 'studio-dead', outcome: 'resumed' },
    };
    assert.deepEqual([r.status, r.body['running'], jobWithMine(r.body)], [200, true, resumed]);
    const [record] = await stored(f);
    assert.deepEqual([record?.['phase'], record?.['lease'], record?.['recovery']], ['running', leaseOf(r.body), resumed.recovery]);
    assert.equal(s.spawned.length, 0);
  });

  it('stops a job whose holder died with its process, as interrupted', async () => {
    const f = await fixture();
    await writeRegistry(f, [orphan(f)]);
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, now: () => T0 });
    const r = await json(studio.url, 'GET', '/api/generate/20261007T110000Z-orphan');
    assert.deepEqual([r.status, r.body], [200, {
      running: false, state: 'interrupted', reason: GONE, exitCode: null, events: [], totals: null,
      job: { kind: 'generate', key: 'k-orphan', phase: 'finished', lease: null, recovery: { at: '2026-10-07T12:00:00.000Z', from: 'studio-dead', outcome: 'stopped', reason: 'process_gone' } },
    }]);
    assert.equal(s.spawned.length, 0);
  });

  // A-373: a pid is the job's process only while it still started as the job recorded; pids get reused.
  it('stops, and never adopts or signals, a job whose pid the OS gave to another process since it was recorded', async () => {
    const f = await fixture();
    await writeRegistry(f, [orphan(f, { processStart: 'Wed Oct  7 11:00:00 2026' })]);
    f.live.add(7001);
    f.starts.set(7001, 'Wed Oct  7 11:59:58 2026');
    const studio = await open(f, { now: () => T0 });
    const r = await json(studio.url, 'GET', '/api/generate/20261007T110000Z-orphan');
    assert.deepEqual([r.body['running'], r.body['state'], r.body['job']], [false, 'interrupted', {
      kind: 'generate', key: 'k-orphan', phase: 'finished', lease: null,
      recovery: { at: '2026-10-07T12:00:00.000Z', from: 'studio-dead', outcome: 'stopped', reason: 'process_gone' },
    }]);
    await studio.close();
    assert.deepEqual(f.killed, []);
  });

  it('resumes a job whose pid still started as recorded, keeps that start, and signals it on close as before', async () => {
    const f = await fixture();
    await writeRegistry(f, [orphan(f, { processStart: 'Wed Oct  7 11:00:00 2026' })]);
    f.live.add(7001);
    f.starts.set(7001, 'Wed Oct  7 11:00:00 2026');
    const studio = await open(f, { now: () => T0 });
    const r = await json(studio.url, 'GET', '/api/generate/20261007T110000Z-orphan');
    assert.deepEqual([r.body['running'], (r.body['job'] as Json)['recovery']], [true, { at: '2026-10-07T12:00:00.000Z', from: 'studio-dead', outcome: 'resumed' }]);
    const [record] = await stored(f);
    assert.deepEqual([record?.['pid'], record?.['processStart']], [7001, 'Wed Oct  7 11:00:00 2026']);
    await studio.close();
    assert.deepEqual(f.killed, [[7001, 'SIGTERM']]);
  });

  it('never signals an adopted job once its pid was reused, even on close', async () => {
    const f = await fixture();
    await writeRegistry(f, [orphan(f, { processStart: 'Wed Oct  7 11:00:00 2026' })]);
    f.live.add(7001);
    f.starts.set(7001, 'Wed Oct  7 11:00:00 2026');
    const studio = await open(f, { now: () => T0 });
    assert.equal((await json(studio.url, 'GET', '/api/generate/20261007T110000Z-orphan')).body['running'], true);
    f.starts.set(7001, 'Wed Oct  7 12:00:01 2026');
    await studio.close();
    assert.deepEqual(f.killed, []);
  });

  it('records what the OS says a child it spawns started as', async () => {
    const f = await fixture();
    f.live.add(43210);
    f.starts.set(43210, 'Wed Oct  7 12:00:00 2026');
    const studio = await open(f, { now: () => T0 });
    const r = await json(studio.url, 'POST', '/api/generate', { kind: 'description', text: 'A small helpdesk', outSlug: 'gen-start' });
    assert.equal(r.status, 200);
    const [record] = await stored(f);
    assert.deepEqual([record?.['pid'], record?.['processStart']], [43210, 'Wed Oct  7 12:00:00 2026']);
  });

  it('stops an intent whose start was never confirmed, and never starts it', async () => {
    const f = await fixture();
    await writeRegistry(f, [orphan(f, { phase: 'intent', pid: null })]);
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, now: () => T0 });
    const r = await json(studio.url, 'GET', '/api/generate/20261007T110000Z-orphan');
    assert.deepEqual([r.status, r.body], [200, {
      running: false, state: 'interrupted', reason: UNCONFIRMED, exitCode: null, events: [], totals: null,
      job: { kind: 'generate', key: 'k-orphan', phase: 'finished', lease: null, recovery: { at: '2026-10-07T12:00:00.000Z', from: 'studio-dead', outcome: 'stopped', reason: 'start_unconfirmed' } },
    }]);
    assert.equal(s.spawned.length, 0);
  });

  it('leaves a job alone while another holder\'s lease is live, recovers it on the tick after it expires, then renews it', async () => {
    const f = await fixture();
    const other = { holder: 'studio-other', expiresAt: '2026-10-07T12:00:01.000Z' };
    await writeRegistry(f, [orphan(f, { pid: 7002, lease: other })]);
    f.live.add(7002);
    let clock = T0;
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, leaseMs: 60, now: () => clock });
    const status = async (): Promise<Json> => (await json(studio.url, 'GET', '/api/generate/20261007T110000Z-orphan')).body;
    const untouched = { kind: 'generate', key: 'k-orphan', phase: 'running', lease: other };
    assert.deepEqual([(await status())['running'], (await status())['job']], [true, untouched]);
    await sleep(100);
    assert.deepEqual((await status())['job'], untouched);

    clock = T0 + 2_000;
    const recovered = await until(async () => {
      const body = await status();
      return (body['job'] as Json)['recovery'] === undefined ? null : body;
    });
    assert.deepEqual(jobWithMine(recovered), {
      kind: 'generate', key: 'k-orphan', phase: 'running', lease: { holder: 'mine', expiresAt: '2026-10-07T12:00:02.060Z' },
      recovery: { at: '2026-10-07T12:00:02.000Z', from: 'studio-other', outcome: 'resumed' },
    });

    clock = T0 + 3_000;
    const renewed = await until(async () => {
      const [record] = await stored(f);
      return record !== undefined && (record['lease'] as Json | null)?.['expiresAt'] === '2026-10-07T12:00:03.060Z' ? record : null;
    });
    assert.equal((renewed['lease'] as Json)['holder'], leaseOf(recovered).holder);
    assert.equal(s.spawned.length, 0);
  });

  it('stops renewing a job once the file names another holder, and leaves its end to that holder', async () => {
    const f = await fixture();
    const s = fakeSpawner(() => ({ pid: 7501, diesOn: [] }));
    const studio = await open(f, { spawner: s.spawner, leaseMs: 60, now: () => T0 });
    const post = await json(studio.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'fenced' });
    const runId = String(post.body['runId']);
    const thief = { holder: 'studio-thief', expiresAt: '2026-10-07T12:10:00.000Z' };
    // Another studio takes the job over. The ticks of this one may overwrite one takeover, so it is written until seen.
    const taken = await until(async () => {
      const records = (await stored(f)).map((r) => ({ ...r, lease: thief }));
      await writeFile(`${registry(f)}.thief.tmp`, JSON.stringify(records));
      await rename(`${registry(f)}.thief.tmp`, registry(f));
      await sleep(50);
      const body = (await json(studio.url, 'GET', `/api/generate/${runId}`)).body;
      return leaseOf(body).holder === 'studio-thief' ? body : null;
    });
    assert.deepEqual([taken['running'], (taken['job'] as Json)['phase'], leaseOf(taken)], [true, 'running', thief]);

    s.spawned[0]!.handle.exitWith(0);
    await s.spawned[0]!.handle.child.exited;
    await sleep(100);
    const after = await json(studio.url, 'GET', `/api/generate/${runId}`);
    assert.deepEqual([after.body['running'], (after.body['job'] as Json)['phase'], leaseOf(after.body)], [true, 'running', thief]);
    assert.deepEqual((await stored(f)).map((r) => [r['phase'], r['lease']]), [['running', thief]]);
  });

  it('records the job a closing studio stops as stopped by the close, writes nothing after, and a restart never resumes it (A-363)', async () => {
    const f = await fixture();
    const s = fakeSpawner(() => ({ pid: 7101, diesOn: [] }));
    let clockA = T0;
    const a = await open(f, { spawner: s.spawner, leaseMs: 60, now: () => clockA });
    const post = await json(a.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'restart' });
    const runId = String(post.body['runId']);
    const holderA = leaseOf((await json(a.url, 'GET', `/api/generate/${runId}`)).body).holder;
    f.live.add(7101);
    clockA = T0 + 500;
    await a.close();
    assert.deepEqual(s.spawned[0]!.handle.signals, ['SIGTERM']);
    const closedFile = await readFile(registry(f), 'utf8');
    const stopped = { at: '2026-10-07T12:00:00.500Z', from: holderA, outcome: 'stopped', reason: 'studio_closed' };
    assert.deepEqual((JSON.parse(closedFile) as Json[]).map((r) => [r['runId'], r['phase'], r['lease'], r['exitCode'], r['recovery']]), [[runId, 'finished', null, null, stopped]]);
    clockA = T0 + 1_000;
    await sleep(100);
    assert.equal(await readFile(registry(f), 'utf8'), closedFile);

    // Its process still lives, but the close stopped the job, so a restarted studio lists it as stopped and adopts nothing.
    const second = fakeSpawner();
    const b = await open(f, { spawner: second.spawner, now: () => T0 + 60_000 });
    const r = await json(b.url, 'GET', `/api/generate/${runId}`);
    const key = String((r.body['job'] as Json)['key']);
    assert.match(key, /^derived:[0-9a-f]{64}$/);
    assert.deepEqual([r.status, r.body], [200, {
      running: false, state: 'interrupted', reason: CLOSED, exitCode: null, events: [], totals: null,
      job: { kind: 'generate', key, phase: 'finished', lease: null, recovery: stopped },
    }]);
    assert.equal(await readFile(registry(f), 'utf8'), closedFile);
    assert.deepEqual([s.spawned.length, second.spawned.length], [1, 0]);
  });

  it('records nothing after the close\'s own write, not even a child that ends after close', async () => {
    const f = await fixture();
    const s = fakeSpawner(() => ({ pid: 7601, diesOn: [] }));
    const studio = await open(f, { spawner: s.spawner, leaseMs: 60, now: () => T0 });
    await json(studio.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'closed' });
    await studio.close();
    assert.deepEqual(s.spawned[0]!.handle.signals, ['SIGTERM']);
    s.spawned[0]!.handle.exitWith(0);
    await s.spawned[0]!.handle.child.exited;
    await sleep(100);
    assert.deepEqual((await stored(f)).map((r) => [r['phase'], r['exitCode'], r['lease'], (r['recovery'] as Json)['reason']]), [['finished', null, null, 'studio_closed']]);
  });

  it('starts an episode once per key, and a restarted studio lists it as the close stopped it and replays its key', async () => {
    const f = await fixture();
    const s = fakeSpawner(() => ({ pid: 7201, diesOn: [] }));
    const a = await open(f, { spawner: s.spawner, now: () => T0 });
    const body = { world: 'w1', task: 't1', agent: 'noop' };
    const key = { 'idempotency-key': 'ep-1' };
    const first = await json(a.url, 'POST', '/api/episodes', body, key);
    const runId = String(first.body['runId']);
    assert.match(runId, /^\d{8}T\d{6}Z-noop-[0-9a-f]{6}$/);
    assert.deepEqual(first.body, { runId, world: 'w1', task: 't1', agent: 'noop', running: true, replayed: false });
    const again = await json(a.url, 'POST', '/api/episodes', body, key);
    assert.deepEqual(again.body, { runId, world: 'w1', task: 't1', agent: 'noop', running: true, replayed: true });
    assert.equal(s.spawned.length, 1);
    const argv = s.spawned[0]!.argv;
    assert.deepEqual([argv[argv.indexOf('--run-id') + 1], argv[argv.indexOf('--out') + 1]], [runId, path.join(f.root, 'eval', 'episodes', runId)]);
    const holderA = leaseOf((await json(a.url, 'GET', `/api/episodes/${runId}`)).body).holder;
    f.live.add(7201);
    await a.close();

    const second = fakeSpawner();
    const b = await open(f, { spawner: second.spawner, now: () => T0 + 60_000 });
    const list = await json(b.url, 'GET', '/api/episodes');
    assert.deepEqual(list.body['episodes'], [{ runId, running: false, task: 't1', world: 'w1', stop: null, score: null, costUsd: null }]);
    const st = await json(b.url, 'GET', `/api/episodes/${runId}`);
    assert.deepEqual(st.body, {
      runId, world: 'w1', task: 't1', agent: 'noop', running: false, exitCode: null,
      job: { kind: 'episode', key: 'ep-1', phase: 'finished', lease: null, recovery: { at: '2026-10-07T12:00:00.000Z', from: holderA, outcome: 'stopped', reason: 'studio_closed' } },
      episode: null, failure: [],
    });
    const late = await json(b.url, 'POST', '/api/episodes', body, key);
    assert.deepEqual(late.body, { runId, world: 'w1', task: 't1', agent: 'noop', running: false, replayed: true });
    assert.equal(second.spawned.length, 0);
  });
});

describe('studio jobs: the registry file (A-329, A-335)', () => {
  it('loads an A-329 registry: an unfinished run is resumed or interrupted from legacy, a finished one stays finished', async () => {
    const f = await fixture();
    const legacy = (runId: string, pid: number, finished: boolean, exitCode: number | null): Json => ({
      runId, outDir: path.join(f.worldsDir, `gen-${runId}`), pid, knownRuns: [], startedAt: '2026-10-07T11:00:00.000Z', exitCode, finished,
    });
    await writeRegistry(f, [legacy('r-live', 7401, false, null), legacy('r-dead', 7402, false, null), legacy('r-done', 7403, true, 0)]);
    f.live.add(7401);
    const studio = await open(f, { now: () => T0 });
    const status = async (id: string): Promise<Json> => (await json(studio.url, 'GET', `/api/generate/${id}`)).body;

    const liveRun = await status('r-live');
    assert.deepEqual([liveRun['running'], jobWithMine(liveRun)], [true, {
      kind: 'generate', key: 'legacy:r-live', phase: 'running', lease: { holder: 'mine', expiresAt: '2026-10-07T12:00:30.000Z' },
      recovery: { at: '2026-10-07T12:00:00.000Z', from: 'legacy', outcome: 'resumed' },
    }]);
    const dead = await status('r-dead');
    assert.deepEqual([dead['running'], dead['state'], dead['job']], [false, 'interrupted', {
      kind: 'generate', key: 'legacy:r-dead', phase: 'finished', lease: null,
      recovery: { at: '2026-10-07T12:00:00.000Z', from: 'legacy', outcome: 'stopped', reason: 'process_gone' },
    }]);
    const done = await status('r-done');
    assert.deepEqual([done['running'], done['exitCode'], done['job']], [false, 0, { kind: 'generate', key: 'legacy:r-done', phase: 'finished', lease: null }]);
  });

  it('loads the registry and ignores a half-written temp file a crash left beside it', async () => {
    const f = await fixture();
    await writeRegistry(f, [orphan(f, { runId: 'r-good', phase: 'finished', lease: null, exitCode: 0 })]);
    await writeFile(`${registry(f)}.99999.tmp`, '[{"runId": "r-half", "ki');
    const studio = await open(f, { now: () => T0 });
    const good = await json(studio.url, 'GET', '/api/generate/r-good');
    assert.deepEqual([good.status, good.body['exitCode'], good.body['job']], [200, 0, { kind: 'generate', key: 'k-orphan', phase: 'finished', lease: null }]);
    assert.equal((await json(studio.url, 'GET', '/api/generate/r-half')).status, 404);
  });

  // A-373: a registry the studio cannot read whole is kept, never overwritten by the next save.
  it('keeps a registry that is not valid JSON as .studio-runs.json.corrupt-<stamp>, says so in one line, and starts empty', async () => {
    const f = await fixture();
    const damaged = '[{"runId": "r-half", "ki';
    await writeFile(registry(f), damaged);
    const lines: string[] = [];
    const studio = await open(f, { now: () => T0, log: (line) => lines.push(line) });
    assert.equal(await readFile(path.join(f.worldsDir, '.studio-runs.json.corrupt-20261007T120000000Z'), 'utf8'), damaged);
    assert.deepEqual(lines, ['.studio-runs.json is not valid JSON: kept as .studio-runs.json.corrupt-20261007T120000000Z, 0 readable jobs loaded']);
    assert.deepEqual(await stored(f), []);
    assert.equal((await json(studio.url, 'GET', '/api/generate/r-half')).status, 404);
  });

  it('keeps a registry with an unreadable record aside too, and loads the records it can read', async () => {
    const f = await fixture();
    const text = JSON.stringify([orphan(f, { runId: 'r-good', phase: 'finished', lease: null, exitCode: 0 }), { runId: 'r-bad', phase: 'sideways' }]);
    await writeFile(registry(f), text);
    const lines: string[] = [];
    const studio = await open(f, { now: () => T0, log: (line) => lines.push(line) });
    assert.equal(await readFile(path.join(f.worldsDir, '.studio-runs.json.corrupt-20261007T120000000Z'), 'utf8'), text);
    assert.deepEqual(lines, ['.studio-runs.json holds 1 unreadable record: kept as .studio-runs.json.corrupt-20261007T120000000Z, 1 readable job loaded']);
    assert.deepEqual((await stored(f)).map((r) => r['runId']), ['r-good']);
    const r = await json(studio.url, 'GET', '/api/generate/r-good');
    assert.deepEqual([r.status, r.body['exitCode']], [200, 0]);
  });
});
