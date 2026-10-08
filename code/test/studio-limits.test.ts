/**
 * The Studio's resource limits (A-375, YOS-208): request bodies, names, budgets and run times, served worlds, the
 * check-and-proof slot pool, the audit log, and the existing limits that had no test hitting them.
 */
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkWorld, saveWorld } from '#engine';
import type { RunResult, Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { AUDIT_FILE, AUDIT_ROTATED_FILE, bucketsOf, studioServer, type StudioOptions, type StudioServer } from '../src/studio/server.ts';
import { RUN_ARCHIVE_FILE, RUN_STORE_FILE } from '../src/studio/runstore.ts';
import { minimalWorld } from './helpers/world.ts';

type Json = { [k: string]: unknown };
type Run = { argv: readonly string[]; timeoutMs: number | undefined };

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(probe: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) assert.fail(`not reached in ${ms} ms`);
    await sleep(5);
  }
}

const ok = (stdout = '{"ok":true}'): RunResult => ({ code: 0, stdout, stderr: '' });
/** git answers a sha, studio-check a valid world, anything else exit 0 with no output. */
const defaultRunner: Runner = async (argv) => (argv[0] === 'git' ? ok('abc1234def\n') : argv.includes('src/cli/studio-check.ts') ? ok() : ok(''));

/** A studio over worlds w01..w<n> (copies of the minimal world), whose spawned children never exit until stopped. */
async function rig(o: { worlds?: number; runner?: Runner; studio?: Partial<StudioOptions>; worldPort?: number; exitAtOnce?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-limits-'));
  roots.push(root);
  const worldsDir = path.join(root, 'prod', 'worlds');
  await mkdir(path.join(root, 'code'), { recursive: true });
  const checked = checkWorld(minimalWorld());
  assert.ok(checked.ok);
  for (let i = 1; i <= (o.worlds ?? 2); i++) await saveWorld(path.join(worldsDir, `w${String(i).padStart(2, '0')}`), checked.world);
  const spawned: string[][] = [];
  let port = 47000;
  const spawner: Spawner = (argv) => {
    spawned.push([...argv]);
    let gone: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => (gone = resolve));
    if (o.exitAtOnce === true) gone(0);
    const world = o.worldPort ?? (port += 2);
    const said = argv[2] === 'serve' ? `{"listening":{"world":${world},"admin":${world + 1}}}\n` : '';
    const child: SpawnedChild = { pid: 45000 + spawned.length, exited, kill: () => (gone(null), true), output: () => said };
    return child;
  };
  const runs: Run[] = [];
  const runner: Runner = async (argv, opts) => {
    runs.push({ argv: [...argv], timeoutMs: opts?.timeoutMs });
    return (o.runner ?? defaultRunner)(argv, opts);
  };
  const studio: StudioServer = await studioServer({
    port: 0, repoRoot: root, worldsDir, spawner, runner, rateLimit: { capacity: 10_000, refillPerSecond: 10_000 }, maxConcurrentRuns: 100, ...o.studio,
  });
  closers.push(() => studio.close());
  const call = async (method: 'GET' | 'POST', p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> => {
    const res = await fetch(`${studio.url}${p}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json) };
  };
  return { studio, root, worldsDir, spawned, runs, call };
}

const errorOf = (r: { status: number; body: Json }): [number, unknown] => [r.status, r.body['error']];
const padTo = (value: unknown, bytes: number): string => {
  const text = JSON.stringify(value);
  return text + ' '.repeat(bytes - Buffer.byteLength(text));
};
const gen = (slug: string, more: Json = {}): Json => ({ kind: 'description', text: 'A tiny app', outSlug: slug, ...more });
const checks = (runs: readonly Run[]): number => runs.filter((r) => r.argv.includes('src/cli/studio-check.ts')).length;

/** A raw POST that sends `bytes` of body and then waits, with or without a content-length; the answer, or 'none' within `ms`. */
function stallingPost(url: string, bytes: number, declared: number | undefined, ms = 1_500): Promise<{ status: number; body: string } | 'none'> {
  return new Promise((resolve) => {
    const u = new URL(`${url}/api/generate`);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...(declared === undefined ? {} : { 'content-length': String(declared) }) } }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', () => undefined);
    const timer = setTimeout(() => {
      req.destroy();
      resolve('none');
    }, ms);
    req.write(Buffer.alloc(bytes, 'a'));
  });
}

describe('request bodies (A-375)', () => {
  it('answers a body declared over 1 MiB with 413 at once, without reading or waiting for the rest', async () => {
    const { studio, spawned } = await rig();
    const r = await stallingPost(studio.url, 1_048_577, 2_000_000);
    assert.notEqual(r, 'none');
    assert.deepEqual(r === 'none' ? null : [r.status, JSON.parse(r.body)], [413, { error: { code: 'body.too_large', message: 'Request body is 2000000 bytes; the most is 1048576' } }]);
    assert.equal(spawned.length, 0);
  });

  it('answers a chunked body with 413 as soon as it passes 1 MiB, though it never ends', async () => {
    const { studio } = await rig();
    const r = await stallingPost(studio.url, 1_048_577, undefined);
    assert.deepEqual(r === 'none' ? r : [r.status, JSON.parse(r.body)], [413, { error: { code: 'body.too_large', message: 'Request body is over 1048576 bytes; the most is 1048576' } }]);
  });

  it('reads a body of exactly 1 MiB and refuses 1 MiB and one byte with the size it declared', async () => {
    const { call, spawned } = await rig();
    assert.equal((await call('POST', '/api/generate', padTo(gen('exactly'), 1_048_576))).status, 200);
    const over = await call('POST', '/api/generate', padTo(gen('over'), 1_048_577));
    assert.deepEqual(errorOf(over), [413, { code: 'body.too_large', message: 'Request body is 1048577 bytes; the most is 1048576' }]);
    assert.equal(spawned.length, 1);
  });

  it('refuses an upload body over 3149824 bytes with 413 and stores nothing', async () => {
    const { call } = await rig();
    const r = await call('POST', '/api/uploads', padTo({ kind: 'csv', name: 'x.csv', content: 'id\n' }, 3_149_825));
    assert.deepEqual(errorOf(r), [413, { code: 'body.too_large', message: 'Request body is 3149825 bytes; the most is 3149824' }]);
    assert.deepEqual((await call('GET', '/api/uploads')).body, { uploads: [] });
  });

  it('refuses an Idempotency-Key over 128 characters and spawns nothing, and takes one of 128', async () => {
    const { call, spawned } = await rig();
    const long = await call('POST', '/api/generate', gen('keyed'), { 'idempotency-key': 'k'.repeat(129) });
    assert.deepEqual(errorOf(long), [400, { code: 'idempotency.key', message: 'Idempotency-Key must be 1 to 128 letters, digits, dots, underscores, colons or dashes' }]);
    assert.equal(spawned.length, 0);
    assert.equal((await call('POST', '/api/generate', gen('keyed'), { 'idempotency-key': 'k'.repeat(128) })).status, 200);
  });
});

describe('names, budgets and run times (A-375)', () => {
  it('bounds a generate: outSlug at 64 characters, budgetUsd at 20 and maxMinutes at 60', async () => {
    const { call, spawned } = await rig();
    assert.deepEqual(errorOf(await call('POST', '/api/generate', gen('a'.repeat(65)))),
      [400, { code: 'generate.slug', message: 'outSlug must be kebab-case of at most 64 characters: lowercase letters, digits and dashes, such as orders-demo' }]);
    assert.deepEqual(errorOf(await call('POST', '/api/generate', gen('rich', { budgetUsd: 20.01 }))),
      [400, { code: 'generate.budget', message: 'budgetUsd must be a positive number of at most 20' }]);
    assert.deepEqual(errorOf(await call('POST', '/api/generate', gen('slow', { maxMinutes: 61 }))),
      [400, { code: 'generate.minutes', message: 'maxMinutes must be a positive integer of at most 60' }]);
    assert.equal(spawned.length, 0);
    assert.equal((await call('POST', '/api/generate', gen('a'.repeat(64), { budgetUsd: 20, maxMinutes: 60 }))).status, 200);
    const argv = spawned[0] ?? [];
    assert.deepEqual([argv[argv.indexOf('--budget-usd') + 1], argv[argv.indexOf('--max-minutes') + 1]], ['20', '60']);
  });

  it('bounds an episode: its task id at 64 characters, maxTurns at a whole 200, budgetUsd at 10 and maxMinutes at 60', async () => {
    const { call, spawned } = await rig();
    const episode = (more: Json): Promise<{ status: number; body: Json }> => call('POST', '/api/episodes', { world: 'w01', task: 'resolve_password_ticket', agent: 'noop', ...more });
    assert.deepEqual(errorOf(await episode({ task: 'a'.repeat(65) })), [400, { code: 'episode.task', message: 'task must be a task id of the world' }]);
    const refused: [Json, string][] = [
      [{ maxTurns: 201 }, 'maxTurns must be a positive integer of at most 200'],
      [{ maxTurns: 1.5 }, 'maxTurns must be a positive integer of at most 200'],
      [{ maxTurns: 0 }, 'maxTurns must be a positive integer of at most 200'],
      [{ budgetUsd: 10.01 }, 'budgetUsd must be a positive number of at most 10'],
      [{ budgetUsd: -1 }, 'budgetUsd must be a positive number of at most 10'],
      [{ maxMinutes: 61 }, 'maxMinutes must be a positive number of at most 60'],
      [{ maxMinutes: 'x' }, 'maxMinutes must be a positive number of at most 60'],
    ];
    for (const [more, message] of refused) assert.deepEqual(errorOf(await episode(more)), [400, { code: 'episode.limits', message }], JSON.stringify(more));
    assert.equal(spawned.length, 0);
    assert.equal((await episode({ maxTurns: 200, budgetUsd: 10, maxMinutes: 60 })).status, 200);
  });
});

describe('served worlds (A-375)', () => {
  it('serves at most 8 worlds per tenant by default, and frees a place when one stops', async () => {
    const { call, spawned } = await rig({ worlds: 9 });
    const ids: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const r = await call('POST', `/api/worlds/w0${i}/serve`, {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      ids.push(String(r.body['id']));
    }
    assert.deepEqual(errorOf(await call('POST', '/api/worlds/w09/serve', {})), [429, { code: 'serve.concurrent_limit', message: 'a tenant serves at most 8 worlds at once; stop one first' }]);
    assert.equal(spawned.length, 8);
    assert.equal((await call('POST', `/api/services/${ids[0]}/stop`, {})).status, 200);
    assert.equal((await call('POST', '/api/worlds/w09/serve', {})).status, 200);
  });

  it('serves at most maxServices worlds in all', async () => {
    const { call } = await rig({ studio: { maxServices: 1 } });
    assert.equal((await call('POST', '/api/worlds/w01/serve', {})).status, 200);
    assert.deepEqual(errorOf(await call('POST', '/api/worlds/w02/serve', {})), [429, { code: 'serve.concurrent_limit', message: 'the studio serves at most 1 worlds at once; stop one first' }]);
  });
});

describe('the check-and-proof slot pool (A-375)', () => {
  it('keeps a world\'s check answer, valid or invalid, until its world.yaml changes: a second visit spawns no child', async () => {
    const { call, runs } = await rig({ runner: async (argv) => (argv.includes('w02') ? { code: 3, stdout: '', stderr: 'world.invalid: no tasks' } : defaultRunner(argv)) });
    assert.equal((await call('GET', '/api/worlds/w01/explorer')).status, 200);
    assert.equal((await call('GET', '/api/worlds/w01/explorer')).status, 200);
    assert.deepEqual(errorOf(await call('GET', '/api/worlds/w02/explorer')), [422, { code: 'world.invalid', message: 'world.invalid: no tasks' }]);
    assert.deepEqual(errorOf(await call('GET', '/api/worlds/w02/explorer')), [422, { code: 'world.invalid', message: 'world.invalid: no tasks' }]);
    assert.equal(checks(runs), 2);
  });

  it('runs 4 checks at once, keeps 16 more waiting, and answers the 21st with 429 studio.busy at once', async () => {
    const releases: (() => void)[] = [];
    const blocking: Runner = (argv) => (argv.includes('src/cli/studio-check.ts') ? new Promise((resolve) => releases.push(() => resolve(ok()))) : defaultRunner(argv));
    const { call, runs } = await rig({ worlds: 21, runner: blocking });
    const answers: { status: number; body: Json }[] = [];
    const pending = Array.from({ length: 21 }, (_, i) => call('GET', `/api/worlds/w${String(i + 1).padStart(2, '0')}/explorer`).then((r) => void answers.push(r)));
    await until(() => answers.length === 1 && checks(runs) === 4);
    assert.deepEqual(errorOf(answers[0]!), [429, {
      code: 'studio.busy', message: 'The studio runs at most 4 world checks and proofs at once, and 16 more may wait 30 s; try again shortly',
    }]);
    // The fifth waits for a slot, and takes the first one freed.
    releases.shift()?.();
    await until(() => checks(runs) === 5);
    assert.equal(answers.length, 2);
    while (answers.length < 21) {
      releases.shift()?.();
      await sleep(5);
    }
    await Promise.all(pending);
    assert.deepEqual(answers.map((a) => a.status).sort(), [...Array(20).fill(200), 429].sort());
    assert.equal(checks(runs), 20);
  });

  it('gives up on a slot after the wait, and a proof shares the same slots', async () => {
    const releases: (() => void)[] = [];
    const blocking: Runner = (argv) => (argv.includes('src/cli/studio-check.ts') ? new Promise((resolve) => releases.push(() => resolve(ok()))) : defaultRunner(argv));
    const { call, runs } = await rig({ worlds: 3, runner: blocking, studio: { childSlots: { size: 1, queue: 1, waitMs: 100 } } });
    const first = call('GET', '/api/worlds/w01/explorer');
    await until(() => checks(runs) === 1);
    const started = Date.now();
    const waited = await call('GET', '/api/worlds/w02/explorer');
    assert.deepEqual([waited.status, (waited.body['error'] as Json)['code'], Date.now() - started >= 90], [429, 'studio.busy', true]);
    assert.deepEqual([(await call('POST', '/api/worlds/w03/proof', {})).status, runs.filter((r) => r.argv.includes('verify')).length], [429, 0]);
    releases.shift()?.();
    assert.equal((await first).status, 200);
  });
});

describe('the audit log (A-375)', () => {
  it('records at most 256 characters of a path, and rotates the file past auditMaxBytes', async () => {
    const { call, worldsDir } = await rig({ studio: { auditMaxBytes: 1_000 } });
    for (let i = 0; i < 10; i++) assert.equal((await call('POST', `/api/${'a'.repeat(1_000)}`, {})).status, 404);
    const lines = readFileSync(path.join(worldsDir, AUDIT_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json);
    assert.equal(String(lines.at(-1)?.['path']).length, 256);
    assert.equal(readFileSync(path.join(worldsDir, AUDIT_FILE)).length < 1_000, true);
    assert.equal(existsSync(path.join(worldsDir, AUDIT_ROTATED_FILE)), true);
  });
});

describe('limits that had no test hitting them', () => {
  it('applies the default caps: 4 generation runs at once, and a burst of 60 POSTs per route', async () => {
    const { call } = await rig({ studio: { maxConcurrentRuns: undefined, rateLimit: undefined, now: () => Date.parse('2026-10-08T12:00:00.000Z') } });
    const statuses: number[] = [];
    let fifth: { status: number; body: Json } | undefined;
    for (const slug of ['a', 'b', 'c', 'd', 'e']) {
      const r = await call('POST', '/api/generate', gen(slug));
      statuses.push(r.status);
      fifth = r;
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
    assert.deepEqual(fifth?.body, { error: { code: 'generate.concurrent_limit', message: 'the studio runs at most 4 generation runs at once; wait for one to finish' } });
    // Five POSTs to /api/generate came first; /api/uploads has its own bucket of 60.
    for (let i = 0; i < 60; i++) assert.equal((await call('POST', '/api/uploads', { kind: 'csv', name: `t${i}.csv`, content: 'id\n' })).status, 201);
    const limited = await call('POST', '/api/uploads', { kind: 'csv', name: 't60.csv', content: 'id\n' });
    assert.deepEqual([limited.status, (limited.body['error'] as Json)['code']], [429, 'studio.rate_limited']);
    assert.match(String((limited.body['error'] as Json)['message']), /^Too many POST \/api\/uploads requests from .*127\.0\.0\.1: the studio allows a burst of 60, refilled 1 per second$/);
  });

  it('keeps at most 1,024 keys in a rate-limit bucket set: the oldest is dropped and comes back full', () => {
    const b = bucketsOf({ capacity: 1, refillPerSecond: 0 }, () => 0);
    b.draw('k0');
    assert.equal(b.wait('k0') > 0, true);
    for (let i = 1; i <= 1_024; i++) b.draw(`k${i}`);
    assert.equal(b.wait('k0'), 0);
  });

  it('runs the Explorer check with the 300 s timeout, and answers 502 when the check is killed', async () => {
    const { call, runs } = await rig({ runner: async (argv) => (argv.includes('src/cli/studio-check.ts') ? { code: 143, stdout: '', stderr: '' } : defaultRunner(argv)) });
    assert.deepEqual(errorOf(await call('GET', '/api/worlds/w01/explorer')), [502, { code: 'check.failed', message: 'the check process failed (exit 143): no output' }]);
    assert.deepEqual(runs.filter((r) => r.argv.includes('src/cli/studio-check.ts')).map((r) => r.timeoutMs), [300_000]);
  });

  it('keeps the last 100 keyed proof replies, and runs the oldest key again', async () => {
    const { call, runs } = await rig();
    const proofs = (): number => runs.filter((r) => r.argv.includes('verify')).length;
    for (let i = 0; i <= 100; i++) assert.equal((await call('POST', '/api/worlds/w01/proof', {}, { 'idempotency-key': `k${i}` })).status, 200);
    assert.equal(proofs(), 101);
    await call('POST', '/api/worlds/w01/proof', {}, { 'idempotency-key': 'k100' });
    assert.equal(proofs(), 101);
    await call('POST', '/api/worlds/w01/proof', {}, { 'idempotency-key': 'k0' });
    assert.equal(proofs(), 102);
  });

  describe('the API console relay', () => {
    /** A world port that answers /big with 1,048,586 bytes and never answers /hang. */
    async function worldPort(): Promise<number> {
      const server: Server = createServer((req, res) => {
        if (req.url === '/big') res.end('a'.repeat(1_048_586));
        else if (req.url !== '/hang') res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      closers.push(() => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }));
      const a = server.address();
      return a !== null && typeof a === 'object' ? a.port : 0;
    }

    it('cuts a world answer over 1 MiB and says so, refuses a call body over 1 MiB, and gives up on a silent world', async () => {
      const port = await worldPort();
      const { call } = await rig({ worldPort: port, studio: { callTimeoutMs: 200 } });
      const served = await call('POST', '/api/worlds/w01/serve', {});
      assert.equal(served.status, 200, JSON.stringify(served.body));
      const svc = String(served.body['id']);
      const big = await call('POST', `/api/services/${svc}/call`, { method: 'GET', path: '/big' });
      assert.deepEqual([big.status, big.body['status'], big.body['truncated'], String(big.body['body']).length], [200, 200, true, 1_048_576]);
      const tooLarge = await call('POST', `/api/services/${svc}/call`, padTo({ method: 'POST', path: '/customers', body: {} }, 1_048_577));
      assert.deepEqual(errorOf(tooLarge), [413, { code: 'body.too_large', message: 'Request body is 1048577 bytes; the most is 1048576' }]);
      const started = Date.now();
      const silent = await call('POST', `/api/services/${svc}/call`, { method: 'GET', path: '/hang' });
      assert.deepEqual([silent.status, (silent.body['error'] as Json)['code'], Date.now() - started < 2_000], [502, 'call.unreachable', true]);
    });
  });
});

describe('registry and disk growth (A-376)', () => {
  it('moves finished jobs past maxFinishedJobs, oldest first, to the append-only archive, and keeps the rest in the registry', async () => {
    const { call, worldsDir } = await rig({ exitAtOnce: true, studio: { maxFinishedJobs: 2 } });
    const ids: string[] = [];
    for (const slug of ['first', 'second', 'third']) {
      const r = await call('POST', '/api/generate', gen(slug));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const id = String(r.body['runId']);
      ids.push(id);
      for (let n = 0; (await call('GET', `/api/generate/${id}`)).body['running'] !== false; n++) {
        if (n > 300) assert.fail(`${id} did not finish`);
        await sleep(10);
      }
    }
    await until(() => existsSync(path.join(worldsDir, RUN_ARCHIVE_FILE)));
    const live = (JSON.parse(readFileSync(path.join(worldsDir, RUN_STORE_FILE), 'utf8')) as { runId: string }[]).map((j) => j.runId);
    const archive = readFileSync(path.join(worldsDir, RUN_ARCHIVE_FILE), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { runId: string; phase: string }));
    assert.deepEqual([live, archive.map((a) => [a.runId, a.phase])], [[ids[1], ids[2]], [[ids[0], 'finished']]]);
  });

  it('refuses a generate and an iterate with 429 shelf.full once the shelf holds maxShelfDirs dirs, and removes nothing', async () => {
    const { call, worldsDir, spawned } = await rig({ studio: { maxShelfDirs: 2 } });
    const refusal = [429, { code: 'shelf.full', message: 'This shelf holds 2 dirs, and the studio adds none past 2; an operator removes old ones first' }];
    assert.deepEqual(errorOf(await call('POST', '/api/generate', gen('more'))), refusal);
    assert.deepEqual(errorOf(await call('POST', '/api/worlds/w01/iterate', { change: 'add a refunds queue' })), refusal);
    assert.deepEqual([spawned.length, readdirSync(worldsDir).filter((e) => !e.startsWith('.')).sort()], [0, ['w01', 'w02']]);
  });

  it('still answers a replay when the shelf is full, and refuses a new start', async () => {
    const { call, worldsDir } = await rig({ studio: { maxShelfDirs: 3 } });
    const first = await call('POST', '/api/generate', gen('kept'), { 'idempotency-key': 'k1' });
    assert.equal(first.status, 200);
    await mkdir(path.join(worldsDir, 'w03'));
    const replay = await call('POST', '/api/generate', gen('kept'), { 'idempotency-key': 'k1' });
    assert.deepEqual([replay.status, replay.body['replayed'], replay.body['runId']], [200, true, first.body['runId']]);
    assert.equal((await call('POST', '/api/generate', gen('another'))).status, 429);
  });

  it('refuses an episode with 429 episode.dirs_full once eval/episodes holds maxEpisodeDirs dirs, and removes nothing', async () => {
    const { call, root, spawned } = await rig({ studio: { maxEpisodeDirs: 1 } });
    await mkdir(path.join(root, 'eval', 'episodes', 'old-run'), { recursive: true });
    const r = await call('POST', '/api/episodes', { world: 'w01', task: 'resolve_password_ticket', agent: 'noop' });
    assert.deepEqual(errorOf(r), [429, { code: 'episode.dirs_full', message: 'eval/episodes holds 1 dirs, and the studio adds none past 1; an operator removes old ones first' }]);
    assert.deepEqual([spawned.length, existsSync(path.join(root, 'eval', 'episodes', 'old-run'))], [0, true]);
  });
});
