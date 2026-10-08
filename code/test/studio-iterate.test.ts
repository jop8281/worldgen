/**
 * Iterating a world from the studio (YOS-188): the world is copied to <name>-<n>.partial on the caller's shelf, a worldgen
 * child changes the copy, and the copy is published as <name>-<n> only once its run logged done. The source is never
 * written. The spawner is a fake whose worldgen child writes into its --world dir when the test lets it, so no child
 * starts and no model is called; the studio binds loopback port 0 only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkWorld, saveWorld } from '#engine';
import type { Runner, Spawner } from '../src/sandboxes/backend.ts';
import { studioServer, type StudioOptions, type StudioUser } from '../src/studio/server.ts';
import { minimalWorld } from './helpers/world.ts';

type Json = { [k: string]: unknown };

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const ANN = 'ann-token-acme-viewer';
const OTTO = 'otto-token-acme-operator';
const GINA = 'gina-token-globex-operator';
const USERS: readonly StudioUser[] = [
  { name: 'ann', role: 'viewer', tenant: 'acme', tokenSha256: digest(ANN) },
  { name: 'otto', role: 'operator', tenant: 'acme', tokenSha256: digest(OTTO) },
  { name: 'gina', role: 'operator', tenant: 'globex', tokenSha256: digest(GINA) },
];
const CHANGE = 'add a refunds queue';

async function call(base: string, method: 'GET' | 'POST', p: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What a fake worldgen child does to its --world dir once let go, and the code it exits with. */
type Script = (worldDir: string) => Promise<number | null>;
type Child = { argv: string[]; finish: (script: Script) => void };

function fakeSpawner(): { spawner: Spawner; spawned: Child[] } {
  const spawned: Child[] = [];
  const spawner: Spawner = (argv) => {
    let finish: (script: Script) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      finish = (script) => void script(argv[argv.indexOf('--world') + 1]!).then(resolve);
    });
    spawned.push({ argv: [...argv], finish });
    return { pid: 48000 + spawned.length, exited, kill: () => true, output: () => '' };
  };
  return { spawner, spawned };
}

const runner: Runner = async () => ({ code: 0, stdout: '', stderr: '' });

async function logRun(worldDir: string, ...events: readonly Json[]): Promise<void> {
  await mkdir(path.join(worldDir, 'runs', 'r1'), { recursive: true });
  await writeFile(path.join(worldDir, 'runs', 'r1', 'events.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}
const done: Script = async (dir) => {
  await logRun(dir, { t: 'run_started' }, { t: 'run_finished', result: { kind: 'done' } });
  await appendFile(path.join(dir, 'REPORT.md'), '## Changes\n- example change\n');
  return 0;
};
const timedOut: Script = async (dir) => {
  await logRun(dir, { t: 'run_started' }, { t: 'run_finished', result: { kind: 'stopped', reason: { kind: 'time_exhausted', minutes: 15 } } });
  return 0;
};
const crashed: Script = async (dir) => {
  await logRun(dir, { t: 'run_started' });
  return 1;
};

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

type Fixture = { root: string; worldsDir: string; source: string; spawned: Child[] };

/** A repo whose library holds hand-beta: a checked world.yaml, plan.yaml, REPORT.md and one past run. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-iterate-'));
  roots.push(root);
  const worldsDir = path.join(root, 'prod', 'worlds');
  const source = path.join(worldsDir, 'hand-beta');
  await mkdir(path.join(root, 'code'), { recursive: true });
  const checked = checkWorld(minimalWorld());
  if (!checked.ok) assert.fail(`fixture world failed check:\n${JSON.stringify(checked.issues, null, 2)}`);
  await mkdir(source, { recursive: true });
  await saveWorld(source, checked.world);
  await writeFile(path.join(source, 'plan.yaml'), 'software: a tiny helpdesk\n');
  await writeFile(path.join(source, 'REPORT.md'), '# WorldGen report: a tiny helpdesk\n');
  await mkdir(path.join(source, 'runs', 'r0'), { recursive: true });
  await writeFile(path.join(source, 'runs', 'r0', 'events.jsonl'), '{"t":"run_started"}\n');
  return { root, worldsDir, source, spawned: [] };
}

async function start(f: Fixture, opts: Partial<StudioOptions> = {}): Promise<string> {
  const fake = fakeSpawner();
  f.spawned = fake.spawned;
  const studio = await studioServer({ port: 0, repoRoot: f.root, worldsDir: f.worldsDir, spawner: fake.spawner, runner, ...opts });
  closers.push(() => studio.close());
  return studio.url;
}

/** sha256 of every file under `dir`, by path relative to it. */
async function hashes(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) Object.assign(out, await hashes(path.join(dir, e.name), rel));
    else out[rel] = createHash('sha256').update(await readFile(path.join(dir, e.name))).digest('hex');
  }
  return out;
}

const exists = async (p: string): Promise<boolean> => (await stat(p).catch(() => null)) !== null;
const worldNames = async (base: string, token?: string): Promise<unknown[]> => ((await call(base, 'GET', '/api/worlds', token)).body['worlds'] as Json[]).map((w) => [w['name'], w['tenant']]);

/** The run's status once it is no longer running. */
async function finished(base: string, runId: string, token?: string): Promise<Json> {
  const end = Date.now() + 5_000;
  for (;;) {
    const r = await call(base, 'GET', `/api/generate/${runId}`, token);
    if (r.body['running'] === false) return r.body;
    if (Date.now() > end) assert.fail(`run ${runId} still running after 5 s: ${JSON.stringify(r.body)}`);
    await sleep(10);
  }
}

describe('studio iterate: a run that logged done publishes the copy (YOS-188)', () => {
  it('copies the world\'s own files, runs worldgen --world on the copy, and lists the copy once done, never writing the source', async () => {
    const f = await fixture();
    const before = await hashes(f.source);
    const base = await start(f);
    const r = await call(base, 'POST', '/api/worlds/hand-beta/iterate', undefined, { change: CHANGE });
    const runId = String(r.body['runId']);
    assert.match(runId, /^\d{8}T\d{6}Z-iterate-[0-9a-f]{6}$/);
    assert.deepEqual([r.status, r.body], [200, { runId, outDir: path.join(f.worldsDir, 'hand-beta-2'), running: true, replayed: false }]);
    const partial = path.join(f.worldsDir, 'hand-beta-2.partial');
    assert.deepEqual(f.spawned.map((s) => s.argv), [['bun', 'src/cli/worldgen.ts', CHANGE, '--world', partial]]);
    assert.deepEqual(await hashes(partial), { 'world.yaml': before['world.yaml'], 'plan.yaml': before['plan.yaml'], 'REPORT.md': before['REPORT.md'] });
    assert.deepEqual(await worldNames(base), [['hand-beta', null]]);

    f.spawned[0]!.finish(done);
    const status = await finished(base, runId);
    assert.deepEqual([status['state'], status['exitCode'], status['iterate']], ['done', 0, { source: 'hand-beta', world: 'hand-beta-2', published: true }]);
    assert.deepEqual((await call(base, 'GET', '/api/worlds')).body['worlds'], [
      { name: 'hand-beta', tenant: null, generated: true, taskCount: 3, reportExists: true },
      { name: 'hand-beta-2', tenant: null, generated: true, taskCount: 3, reportExists: true },
    ]);
    const report = await call(base, 'GET', '/api/worlds/hand-beta-2/report');
    assert.deepEqual([report.status, report.body], [200, { name: 'hand-beta-2', report: '# WorldGen report: a tiny helpdesk\n## Changes\n- example change\n' }]);
    assert.equal(await exists(partial), false);
    assert.deepEqual(await hashes(f.source), before);
  });
});

describe('studio iterate: a run that did not log done publishes nothing (YOS-188)', () => {
  it('leaves a stopped run and a crashed run in their .partial dirs, says why, and keeps the source', async () => {
    const f = await fixture();
    const before = await hashes(f.source);
    const base = await start(f);
    const stopped = String((await call(base, 'POST', '/api/worlds/hand-beta/iterate', undefined, { change: CHANGE })).body['runId']);
    f.spawned[0]!.finish(timedOut);
    const a = await finished(base, stopped);
    assert.deepEqual([a['state'], a['reason'], a['iterate']], ['stopped', 'time_exhausted', { source: 'hand-beta', world: 'hand-beta-2', published: false }]);

    // The stopped run's evidence keeps its name taken, so the next copy is -3.
    const crash = await call(base, 'POST', '/api/worlds/hand-beta/iterate', undefined, { change: 'drop the sla job' });
    assert.equal(crash.body['outDir'], path.join(f.worldsDir, 'hand-beta-3'));
    f.spawned[1]!.finish(crashed);
    const b = await finished(base, String(crash.body['runId']));
    assert.deepEqual([b['state'], b['reason'], b['iterate']], ['failed', 'the worldgen process exited 1 before it logged run_finished', { source: 'hand-beta', world: 'hand-beta-3', published: false }]);

    assert.deepEqual(await worldNames(base), [['hand-beta', null]]);
    assert.deepEqual(await Promise.all(['hand-beta-2.partial', 'hand-beta-2', 'hand-beta-3.partial', 'hand-beta-3'].map((d) => exists(path.join(f.worldsDir, d)))), [true, false, true, false]);
    assert.deepEqual(await hashes(f.source), before);
  });
});

describe('studio iterate: tenancy (YOS-188, A-344)', () => {
  it('writes an operator\'s copy of a library world on its own shelf, where no other tenant sees or iterates it', async () => {
    const f = await fixture();
    const before = await hashes(f.source);
    const base = await start(f, { users: USERS });
    const r = await call(base, 'POST', '/api/worlds/hand-beta/iterate', OTTO, { change: CHANGE });
    const runId = String(r.body['runId']);
    assert.deepEqual([r.status, r.body], [200, { runId, outDir: path.join(f.worldsDir, 'acme', 'hand-beta-2'), running: true, replayed: false }]);
    assert.deepEqual(f.spawned.map((s) => s.argv), [['bun', 'src/cli/worldgen.ts', CHANGE, '--world', path.join(f.worldsDir, 'acme', 'hand-beta-2.partial')]]);
    f.spawned[0]!.finish(done);
    assert.deepEqual((await finished(base, runId, OTTO))['iterate'], { source: 'hand-beta', world: 'hand-beta-2', published: true });

    assert.deepEqual(await worldNames(base, OTTO), [['hand-beta', null], ['hand-beta-2', 'acme']]);
    assert.deepEqual(await worldNames(base, GINA), [['hand-beta', null]]);
    const foreign = await call(base, 'POST', '/api/worlds/hand-beta-2/iterate', GINA, { change: CHANGE });
    assert.deepEqual([foreign.status, foreign.body], [404, { error: { code: 'world.unknown', message: `No world hand-beta-2 under ${f.worldsDir}` } }]);
    const run = await call(base, 'GET', `/api/generate/${runId}`, GINA);
    assert.deepEqual([run.status, run.body], [404, { error: { code: 'run.unknown', message: `No run ${runId}` } }]);
    assert.equal(f.spawned.length, 1);
    assert.deepEqual(await hashes(f.source), before);
  });
});

describe('studio iterate: one job per key, one name per copy (YOS-188, A-335)', () => {
  it('answers a doubled POST with one Idempotency-Key from one job', async () => {
    const f = await fixture();
    const base = await start(f);
    const key = { 'idempotency-key': 'k-iterate-1' };
    const pair = await Promise.all([1, 2].map(() => call(base, 'POST', '/api/worlds/hand-beta/iterate', undefined, { change: CHANGE }, key)));
    const [first, second] = pair.sort((x, y) => Number(x.body['replayed']) - Number(y.body['replayed']));
    const runId = String(first!.body['runId']);
    const outDir = path.join(f.worldsDir, 'hand-beta-2');
    assert.deepEqual([first!.status, first!.body, second!.status, second!.body], [200, { runId, outDir, running: true, replayed: false }, 200, { runId, outDir, running: true, replayed: true }]);
    assert.equal(f.spawned.length, 1);
    assert.deepEqual((await readdir(f.worldsDir)).filter((d) => d.startsWith('hand-beta-')), ['hand-beta-2.partial']);
  });

  it('gives two concurrent iterates of one world the names -2 and -3', async () => {
    const f = await fixture();
    const base = await start(f);
    const pair = await Promise.all([CHANGE, 'drop the sla job'].map((change) => call(base, 'POST', '/api/worlds/hand-beta/iterate', undefined, { change })));
    assert.deepEqual(pair.map((r) => [r.status, r.body['replayed']]), [[200, false], [200, false]]);
    assert.deepEqual(pair.map((r) => r.body['outDir']).sort(), [path.join(f.worldsDir, 'hand-beta-2'), path.join(f.worldsDir, 'hand-beta-3')]);
    assert.deepEqual(f.spawned.map((s) => s.argv[4]).sort(), [path.join(f.worldsDir, 'hand-beta-2.partial'), path.join(f.worldsDir, 'hand-beta-3.partial')]);
    assert.deepEqual(f.spawned.map((s) => s.argv[2]).sort(), ['add a refunds queue', 'drop the sla job']);
  });
});

describe('studio iterate: refusals (YOS-188)', () => {
  it('refuses a bad change, a viewer, and a dir with no world.yaml, and spawns nothing', async () => {
    const f = await fixture();
    await mkdir(path.join(f.worldsDir, 'plan-only'), { recursive: true });
    await writeFile(path.join(f.worldsDir, 'plan-only', 'plan.yaml'), 'x: 1\n');
    const base = await start(f, { users: USERS });
    const badChange = [400, { error: { code: 'iterate.change', message: 'the body must be {"change": "<what to change>"}, a non-empty string of at most 4000 characters' } }];
    for (const body of [{}, { change: '   ' }, { change: 7 }, { change: 'x'.repeat(4001) }]) {
      const r = await call(base, 'POST', '/api/worlds/hand-beta/iterate', OTTO, body);
      assert.deepEqual([r.status, r.body], badChange, JSON.stringify(body).slice(0, 40));
    }
    const viewer = await call(base, 'POST', '/api/worlds/hand-beta/iterate', ANN, { change: CHANGE });
    assert.deepEqual([viewer.status, viewer.body], [403, { error: { code: 'auth.forbidden', message: 'POST /api/worlds/hand-beta/iterate needs the operator role; ann is a viewer' } }]);
    const noWorld = await call(base, 'POST', '/api/worlds/plan-only/iterate', OTTO, { change: CHANGE });
    assert.deepEqual([noWorld.status, noWorld.body], [422, { error: { code: 'iterate.no_world', message: 'plan-only has no world.yaml to iterate' } }]);
    assert.equal(f.spawned.length, 0);
    assert.equal(await exists(path.join(f.worldsDir, 'acme')), false);
  });

  it('finishes a job whose copy failed without spawning it, and answers 500 iterate.copy_failed', { skip: process.getuid?.() === 0 ? 'root reads a file of mode 000' : false }, async () => {
    const f = await fixture();
    const base = await start(f);
    const yaml = path.join(f.source, 'world.yaml');
    await chmod(yaml, 0o000);
    try {
      const r = await call(base, 'POST', '/api/worlds/hand-beta/iterate', undefined, { change: CHANGE });
      const error = r.body['error'] as Json;
      assert.deepEqual([r.status, error['code']], [500, 'iterate.copy_failed']);
      assert.match(String(error['message']), /EACCES/);
    } finally {
      await chmod(yaml, 0o644);
    }
    const registry = JSON.parse(await readFile(path.join(f.worldsDir, '.studio-runs.json'), 'utf8')) as Json[];
    assert.deepEqual(registry.map((j) => [j['phase'], j['lease'], j['iterate']]), [['finished', null, { source: 'hand-beta', world: 'hand-beta-2' }]]);
    assert.equal(f.spawned.length, 0);
    // The failed job no longer holds a derived key, and its .partial evidence keeps -2 taken.
    const retry = await call(base, 'POST', '/api/worlds/hand-beta/iterate', undefined, { change: CHANGE });
    assert.deepEqual([retry.status, retry.body['outDir'], retry.body['replayed'], f.spawned.length], [200, path.join(f.worldsDir, 'hand-beta-3'), false, 1]);
  });
});
