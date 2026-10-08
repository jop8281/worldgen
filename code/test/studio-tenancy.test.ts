/**
 * Studio tenancy (YOS-187 slice 2, A-344): two signed-in teams share one studio and never see or stop each other's
 * runs, episodes, services or audit lines, while the world library stays shared. The spawner and runner are fakes, so
 * no child starts and no model is called; the studio binds loopback port 0 only.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkWorld, saveWorld, type World } from '#engine';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { parseUsersFile, studioServer, type StudioOptions, type StudioUser } from '../src/studio/server.ts';
import { minimalWorld } from './helpers/world.ts';

type Json = { [k: string]: unknown };

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const ANN = 'ann-token-acme-viewer';
const OTTO = 'otto-token-acme-operator';
const GINA = 'gina-token-globex-operator';
const ADA = 'ada-token-ops-admin';
const USERS: readonly StudioUser[] = [
  { name: 'ann', role: 'viewer', tenant: 'acme', tokenSha256: digest(ANN) },
  { name: 'otto', role: 'operator', tenant: 'acme', tokenSha256: digest(OTTO) },
  { name: 'gina', role: 'operator', tenant: 'globex', tokenSha256: digest(GINA) },
  { name: 'ada', role: 'admin', tenant: 'ops', tokenSha256: digest(ADA) },
];
const TENANT_RULE = 'tenant must be 1 to 63 lowercase letters, digits or dashes, starting with a letter or digit and not with gen-, which names the default tenant\'s generated worlds';
const CODE_DIR = path.resolve(import.meta.dirname, '..');

async function call(base: string, method: 'GET' | 'POST', p: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

type Spawned = { argv: string[]; signals: string[] };

function fakeSpawner(): { spawner: Spawner; spawned: Spawned[] } {
  const spawned: Spawned[] = [];
  const spawner: Spawner = (argv) => {
    const one: Spawned = { argv: [...argv], signals: [] };
    spawned.push(one);
    const child: SpawnedChild = {
      pid: 45000 + spawned.length,
      exited: new Promise<number | null>(() => {}),
      kill(signal) {
        one.signals.push(signal);
        return true;
      },
      output: () => '',
    };
    return child;
  };
  return { spawner, spawned };
}

const runner: Runner = async (argv) => (argv[0] === 'git' ? { code: 0, stdout: 'abc1234\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

type Fixture = { root: string; worldsDir: string; spawned: Spawned[] };

/** A repo with one library dir, hand-beta, that holds one past run and no world yet. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-tenancy-'));
  roots.push(root);
  const worldsDir = path.join(root, 'prod', 'worlds');
  await mkdir(path.join(root, 'code'), { recursive: true });
  await mkdir(path.join(worldsDir, 'hand-beta', 'runs', 'run_shared'), { recursive: true });
  await writeFile(path.join(worldsDir, 'hand-beta', 'runs', 'run_shared', 'events.jsonl'), '{"t":"run_started"}\n');
  return { root, worldsDir, spawned: [] };
}

async function start(f: Fixture, opts: Partial<StudioOptions> = {}): Promise<string> {
  const fake = fakeSpawner();
  f.spawned = fake.spawned;
  const studio = await studioServer({ port: 0, repoRoot: f.root, worldsDir: f.worldsDir, spawner: fake.spawner, runner, users: USERS, maxConcurrentRuns: 100, maxConcurrentEpisodes: 100, ...opts });
  closers.push(() => studio.close());
  return studio.url;
}

/** The only writer of a fixture world.yaml: through checkWorld and saveWorld. */
async function writeWorld(dir: string, world: World): Promise<void> {
  const report = checkWorld(world);
  if (!report.ok) assert.fail(`fixture world failed check:\n${JSON.stringify(report.issues, null, 2)}`);
  await mkdir(dir, { recursive: true });
  await saveWorld(dir, report.world);
}

const gen = (slug: string): Json => ({ kind: 'description', text: 'A tiny app', outSlug: slug });
const EPISODE = { world: 'hand-beta', task: 't1', agent: 'noop' };

/** One past run under a generation's out dir, so /api/runs has a row for it. */
async function writeRun(outDir: unknown, runId: string): Promise<void> {
  assert.equal(typeof outDir, 'string');
  await mkdir(path.join(String(outDir), 'runs', runId), { recursive: true });
  await writeFile(path.join(String(outDir), 'runs', runId, 'events.jsonl'), '{"t":"run_started"}\n');
}

const episodeIds = async (base: string, token: string, q = ''): Promise<unknown[]> => ((await call(base, 'GET', `/api/episodes${q}`, token)).body['episodes'] as Json[]).map((e) => e['runId']);
const serviceRows = async (base: string, token: string, q = ''): Promise<unknown[]> => ((await call(base, 'GET', `/api/services${q}`, token)).body['services'] as Json[]).map((s) => [s['id'], s['name'], s['tenant']]);
const runRows = async (base: string, token: string, q = ''): Promise<unknown[]> => ((await call(base, 'GET', `/api/runs${q}`, token)).body['runs'] as Json[]).map((r) => [r['name'], r['runId'], r['tenant']]);
const worldRows = async (base: string, token: string, q = ''): Promise<unknown[]> => ((await call(base, 'GET', `/api/worlds${q}`, token)).body['worlds'] as Json[]).map((w) => [w['name'], w['tenant']]);

describe('studio tenancy: lists (A-344)', () => {
  it('shows each tenant only its own episodes, services and runs, and the library\'s runs to everyone', async () => {
    const f = await fixture();
    const base = await start(f);
    const ottoRun = await call(base, 'POST', '/api/generate', OTTO, gen('acme-run'));
    const ottoEpisode = await call(base, 'POST', '/api/episodes', OTTO, EPISODE);
    const ginaRun = await call(base, 'POST', '/api/generate', GINA, gen('globex-run'));
    const served = await call(base, 'POST', '/api/worlds/hand-beta/serve', OTTO, { port: 4600 });
    assert.deepEqual([ottoRun.status, ottoEpisode.status, ginaRun.status, served.status], [200, 200, 200, 200]);
    await writeRun(ottoRun.body['outDir'], 'run_acme');
    await writeRun(ginaRun.body['outDir'], 'run_globex');
    const episodeId = ottoEpisode.body['runId'];

    assert.deepEqual(await episodeIds(base, GINA), []);
    assert.deepEqual(await episodeIds(base, GINA, '?tenant=acme'), []);
    assert.deepEqual((await call(base, 'GET', '/api/episodes', ANN)).body['episodes'], [
      { runId: episodeId, running: true, task: 't1', world: 'hand-beta', stop: null, score: null, costUsd: null },
    ]);

    assert.deepEqual(await serviceRows(base, GINA), []);
    assert.deepEqual(await serviceRows(base, ANN), [[served.body['id'], 'hand-beta', 'acme']]);

    assert.deepEqual(await runRows(base, GINA), [['hand-beta', 'run_shared', null], ['gen-globex-run', 'run_globex', 'globex']]);
    assert.deepEqual(await runRows(base, ANN), [['hand-beta', 'run_shared', null], ['gen-acme-run', 'run_acme', 'acme']]);
  });
});

describe('studio tenancy: a foreign record is unknown (A-344)', () => {
  it('answers another tenant\'s run, episode and service exactly like ids that never existed, and signals nothing', async () => {
    const f = await fixture();
    const base = await start(f);
    const runId = String((await call(base, 'POST', '/api/generate', OTTO, gen('acme-run'))).body['runId']);
    const episodeId = String((await call(base, 'POST', '/api/episodes', OTTO, EPISODE)).body['runId']);
    const serviceId = String((await call(base, 'POST', '/api/worlds/hand-beta/serve', OTTO, { port: 4600 })).body['id']);
    assert.equal((await call(base, 'GET', `/api/generate/${runId}`, OTTO)).status, 200);

    const answer = async (method: 'GET' | 'POST', p: string, body?: unknown): Promise<unknown[]> => {
      const r = await call(base, method, p, GINA, body);
      return [r.status, r.body];
    };
    const notFound = (code: string, message: string): unknown[] => [404, { error: { code, message } }];
    assert.deepEqual(await answer('GET', '/api/generate/nope-123'), notFound('run.unknown', 'No run nope-123'));
    assert.deepEqual(await answer('GET', `/api/generate/${runId}`), notFound('run.unknown', `No run ${runId}`));
    assert.deepEqual(await answer('GET', `/api/generate/${runId}/events`), notFound('run.unknown', `No run ${runId}`));
    assert.deepEqual(await answer('POST', `/api/generate/${runId}/stop`), notFound('run.unknown', `No run ${runId}`));

    assert.deepEqual(await answer('GET', '/api/episodes/nope-123'), notFound('episode.unknown', 'No episode run nope-123'));
    assert.deepEqual(await answer('GET', `/api/episodes/${episodeId}`), notFound('episode.unknown', `No episode run ${episodeId}`));
    assert.deepEqual(await answer('POST', '/api/episodes/nope-123/stop'), notFound('episode.unknown', 'No running episode nope-123'));
    assert.deepEqual(await answer('POST', `/api/episodes/${episodeId}/stop`), notFound('episode.unknown', `No running episode ${episodeId}`));

    const request = { method: 'GET', path: '/customers' };
    assert.deepEqual(await answer('POST', '/api/services/svc-99/stop'), notFound('service.unknown', 'No service svc-99'));
    assert.deepEqual(await answer('POST', `/api/services/${serviceId}/stop`), notFound('service.unknown', `No service ${serviceId}`));
    assert.deepEqual(await answer('POST', `/api/services/${serviceId}/call`, request), notFound('service.unknown', `No service ${serviceId}`));

    assert.deepEqual(f.spawned.map((s) => s.signals), [[], [], []]);
  });
});

describe('studio tenancy: idempotency keys per tenant (A-344)', () => {
  it('starts a new job for a key another tenant used, and leaves that tenant\'s job as it was', async () => {
    const f = await fixture();
    const base = await start(f);
    const key = { 'idempotency-key': 'k-1' };
    const first = await call(base, 'POST', '/api/generate', OTTO, gen('keyed'), key);
    const runId = String(first.body['runId']);
    assert.deepEqual([first.status, first.body], [200, { runId, outDir: path.join(f.worldsDir, 'acme', 'gen-keyed'), running: true, replayed: false }]);

    const other = await call(base, 'POST', '/api/generate', GINA, gen('keyed'), key);
    const otherId = String(other.body['runId']);
    assert.deepEqual([other.status, other.body], [200, { runId: otherId, outDir: path.join(f.worldsDir, 'globex', 'gen-keyed'), running: true, replayed: false }]);
    assert.notEqual(otherId, runId);
    assert.equal(f.spawned.length, 2);

    const again = await call(base, 'POST', '/api/generate', OTTO, gen('keyed'), key);
    assert.deepEqual([again.status, again.body], [200, { runId, outDir: path.join(f.worldsDir, 'acme', 'gen-keyed'), running: true, replayed: true }]);
    const job = (await call(base, 'GET', `/api/generate/${runId}`, OTTO)).body['job'] as Json;
    assert.deepEqual([job['key'], job['phase']], ['k-1', 'running']);
    assert.deepEqual(f.spawned.map((s) => s.signals), [[], []]);

    // A derived key is per tenant too: the same episode request from each tenant is two jobs.
    const a = await call(base, 'POST', '/api/episodes', OTTO, EPISODE);
    const b = await call(base, 'POST', '/api/episodes', GINA, EPISODE);
    assert.deepEqual([a.body['replayed'], b.body['replayed'], f.spawned.length], [false, false, 4]);
    assert.notEqual(a.body['runId'], b.body['runId']);
  });
});

describe('studio tenancy: the admin (A-344)', () => {
  it('sees every tenant, narrows with ?tenant=, and refuses a malformed one', async () => {
    const f = await fixture();
    const base = await start(f);
    const ottoRun = await call(base, 'POST', '/api/generate', OTTO, gen('acme-run'));
    const ginaRun = await call(base, 'POST', '/api/generate', GINA, gen('globex-run'));
    const ottoEpisode = String((await call(base, 'POST', '/api/episodes', OTTO, EPISODE)).body['runId']);
    const ginaEpisode = String((await call(base, 'POST', '/api/episodes', GINA, EPISODE)).body['runId']);
    const ottoService = (await call(base, 'POST', '/api/worlds/hand-beta/serve', OTTO, { port: 4600 })).body['id'];
    const ginaService = (await call(base, 'POST', '/api/worlds/hand-beta/serve', GINA, { port: 4602 })).body['id'];
    await writeRun(ottoRun.body['outDir'], 'run_acme');
    await writeRun(ginaRun.body['outDir'], 'run_globex');

    assert.deepEqual((await episodeIds(base, ADA)).sort(), [ottoEpisode, ginaEpisode].sort());
    assert.deepEqual(await episodeIds(base, ADA, '?tenant=acme'), [ottoEpisode]);
    assert.deepEqual(await serviceRows(base, ADA), [[ottoService, 'hand-beta', 'acme'], [ginaService, 'hand-beta', 'globex']]);
    assert.deepEqual(await serviceRows(base, ADA, '?tenant=acme'), [[ottoService, 'hand-beta', 'acme']]);
    assert.deepEqual(await runRows(base, ADA), [['hand-beta', 'run_shared', null], ['gen-acme-run', 'run_acme', 'acme'], ['gen-globex-run', 'run_globex', 'globex']]);
    assert.deepEqual(await runRows(base, ADA, '?tenant=acme'), [['hand-beta', 'run_shared', null], ['gen-acme-run', 'run_acme', 'acme']]);

    const bad = await call(base, 'GET', '/api/episodes?tenant=Bad!', ADA);
    assert.deepEqual([bad.status, bad.body], [400, { error: { code: 'tenant.invalid', message: `?tenant=Bad! is refused: ${TENANT_RULE}` } }]);
    assert.equal((await call(base, 'GET', '/api/episodes?tenant=Bad!', ANN)).status, 200);

    const ottoJob = String(ottoRun.body['runId']);
    const seen = await call(base, 'GET', `/api/generate/${ottoJob}`, ADA);
    assert.deepEqual([seen.status, seen.body['running']], [200, true]);
    const narrowed = await call(base, 'GET', `/api/generate/${ottoJob}?tenant=globex`, ADA);
    assert.deepEqual([narrowed.status, narrowed.body], [404, { error: { code: 'run.unknown', message: `No run ${ottoJob}` } }]);
  });
});

describe('studio tenancy: the audit (A-344)', () => {
  it('records the caller\'s tenant on every POST line, and ?tenant= keeps only that tenant\'s', async () => {
    const f = await fixture();
    const base = await start(f);
    const runId = String((await call(base, 'POST', '/api/generate', OTTO, gen('acme-run'))).body['runId']);
    await call(base, 'POST', '/api/generate', GINA, gen('globex-run'));
    await call(base, 'POST', `/api/generate/${runId}/stop`, GINA);
    const lines = async (q = ''): Promise<unknown[]> => ((await call(base, 'GET', `/api/audit${q}`, ADA)).body['entries'] as Json[]).map(({ at, ...rest }) => (typeof at === 'string' ? rest : { at }));
    const otto = { user: 'otto', role: 'operator', tenant: 'acme', method: 'POST', path: '/api/generate', status: 200 };
    const gina = { user: 'gina', role: 'operator', tenant: 'globex', method: 'POST', path: '/api/generate', status: 200 };
    const ginaStop = { user: 'gina', role: 'operator', tenant: 'globex', method: 'POST', path: `/api/generate/${runId}/stop`, status: 404, code: 'run.unknown' };
    assert.deepEqual(await lines(), [otto, gina, ginaStop]);
    assert.deepEqual(await lines('?tenant=globex'), [gina, ginaStop]);
    assert.deepEqual(await lines('?tenant=acme'), [otto]);
  });
});

describe('studio tenancy: where generations write (A-344)', () => {
  it('writes a tenant\'s generation into its own dir, made on demand', async () => {
    const f = await fixture();
    const base = await start(f);
    const r = await call(base, 'POST', '/api/generate', OTTO, gen('out-acme'));
    const outDir = path.join(f.worldsDir, 'acme', 'gen-out-acme');
    assert.deepEqual([r.status, r.body['outDir']], [200, outDir]);
    const argv = f.spawned[0]!.argv;
    assert.equal(argv[argv.indexOf('--out') + 1], outDir);
    assert.equal((await stat(path.join(f.worldsDir, 'acme'))).isDirectory(), true);
  });

  it('keeps open mode in the old layout, as the local admin of tenant default', async () => {
    const f = await fixture();
    const base = await start(f, { users: [] });
    assert.deepEqual((await call(base, 'GET', '/api/me', undefined)).body, { name: 'local', role: 'admin', tenant: 'default', signIn: false });
    const r = await call(base, 'POST', '/api/generate', undefined, gen('out-open'));
    assert.deepEqual([r.status, r.body['outDir']], [200, path.join(f.worldsDir, 'gen-out-open')]);
  });
});

describe('studio tenancy: the library (A-344)', () => {
  it('shares the library, keeps a tenant\'s own worlds to it, and resolves every :name route the same way', async () => {
    const f = await fixture();
    await writeWorld(path.join(f.worldsDir, 'hand-beta'), minimalWorld());
    await writeWorld(path.join(f.worldsDir, 'acme', 'gen-acme-only'), minimalWorld());
    const base = await start(f);

    assert.deepEqual(await worldRows(base, ANN), [['hand-beta', null], ['gen-acme-only', 'acme']]);
    assert.deepEqual(await worldRows(base, OTTO), [['hand-beta', null], ['gen-acme-only', 'acme']]);
    assert.deepEqual(await worldRows(base, GINA), [['hand-beta', null]]);
    assert.deepEqual(await worldRows(base, ADA), [['hand-beta', null], ['gen-acme-only', 'acme']]);
    assert.deepEqual(await worldRows(base, ADA, '?tenant=globex'), [['hand-beta', null]]);

    const report = async (token: string, name: string, q = ''): Promise<unknown[]> => {
      const r = await call(base, 'GET', `/api/worlds/${name}/report${q}`, token);
      return [r.status, r.body];
    };
    const unknown = (name: string): unknown[] => [404, { error: { code: 'world.unknown', message: `No world ${name} under ${f.worldsDir}` } }];
    assert.deepEqual(await report(ANN, 'gen-acme-only'), [200, { name: 'gen-acme-only', report: null }]);
    assert.deepEqual(await report(GINA, 'gen-acme-only'), unknown('gen-acme-only'));
    assert.deepEqual(await report(GINA, 'acme'), unknown('acme'));
    assert.deepEqual(await report(ADA, 'gen-acme-only'), unknown('gen-acme-only'));
    assert.deepEqual(await report(ADA, 'gen-acme-only', '?tenant=acme'), [200, { name: 'gen-acme-only', report: null }]);

    const refused = await call(base, 'POST', '/api/worlds/gen-acme-only/serve', GINA, { port: 4610 });
    assert.deepEqual([refused.status, refused.body], unknown('gen-acme-only'));
    assert.equal(f.spawned.length, 0);
    assert.equal((await call(base, 'POST', '/api/worlds/gen-acme-only/serve', OTTO, { port: 4610 })).status, 200);
    assert.deepEqual(f.spawned.map((s) => s.argv), [['bun', 'src/cli/worldplay.ts', 'serve', path.join(f.worldsDir, 'acme', 'gen-acme-only'), '--port', '4610']]);

    const health = async (token: string | undefined): Promise<unknown> => (await call(base, 'GET', '/api/health', token)).body['worlds'];
    assert.deepEqual([await health(undefined), await health(ANN), await health(ADA)], [1, 1, 1]);
  });
});

describe('studio tenancy: users files and startup (A-344)', () => {
  const cliEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env['WORLDGEN_STUDIO_TOKEN'];
    delete env['WORLDGEN_STUDIO_ORIGIN'];
    return env;
  };

  it('refuses a user without a tenant or with a malformed one, and the CLI exits 2 naming it', async () => {
    const d = digest(ANN);
    assert.throws(() => parseUsersFile(JSON.stringify({ users: [{ name: 'ann', role: 'viewer', token_sha256: d }] })), { message: /^users\.0\.tenant: / });
    assert.throws(
      () => parseUsersFile(JSON.stringify({ users: [{ name: 'ann', role: 'viewer', tenant: 'Acme', token_sha256: d }] })),
      { message: `users.0.tenant: ${TENANT_RULE}` },
    );
    // A default user's generation of slug acme writes <worldsDir>/gen-acme, so no tenant may own that dir.
    assert.throws(
      () => parseUsersFile(JSON.stringify({ users: [{ name: 'ann', role: 'viewer', tenant: 'gen-acme', token_sha256: d }] })),
      { message: `users.0.tenant: ${TENANT_RULE}` },
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-tenancy-cli-'));
    roots.push(dir);
    const file = path.join(dir, 'users.json');
    await writeFile(file, JSON.stringify({ users: [{ name: 'ann', role: 'viewer', token_sha256: d }] }));
    const r = spawnSync('bun', ['src/cli/studio.ts', '--users', file], { cwd: CODE_DIR, env: cliEnv(), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.includes(`--users ${file}: users.0.tenant: `), true, r.stderr);
  });

  it('makes the WORLDGEN_STUDIO_TOKEN admin a user of tenant default', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-tenancy-token-'));
    roots.push(dir);
    const env = { ...cliEnv(), WORLDGEN_STUDIO_TOKEN: 'tenancy-token-1' };
    const child = spawn('bun', ['src/cli/studio.ts', '--port', '0', '--repo-root', dir, '--worlds-dir', path.join(dir, 'worlds')], { cwd: CODE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        let err = '';
        const timer = setTimeout(() => reject(new Error(`no studio url after 60 s: ${err}`)), 60_000);
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString('utf8');
          const m = /studio on (http:\/\/\S+) /.exec(out);
          if (m !== null) {
            clearTimeout(timer);
            resolve(m[1]!);
          }
        });
        child.stderr.on('data', (c: Buffer) => {
          err += c.toString('utf8');
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`studio exited ${code}: ${err}`));
        });
      });
      const res = await fetch(`${url}/api/me`, { headers: { authorization: 'Bearer tenancy-token-1' } });
      assert.deepEqual(await res.json(), { name: 'admin', role: 'admin', tenant: 'default', signIn: true });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
    }
  });

  it('refuses at startup a tenant named like a world of the library, and writes nothing', async () => {
    const f = await fixture();
    await writeWorld(path.join(f.worldsDir, 'hand-beta'), minimalWorld());
    const clash: StudioUser = { name: 'hal', role: 'viewer', tenant: 'hand-beta', tokenSha256: digest('hal-token') };
    await assert.rejects(start(f, { users: [...USERS, clash] }), { message: `studio tenant hand-beta is also a world in ${f.worldsDir}; rename the tenant` });
    await assert.rejects(stat(path.join(f.worldsDir, '.studio-runs.json')), { code: 'ENOENT' });
    assert.equal((await call(await start(f), 'GET', '/api/me', ANN)).status, 200);
  });
});

describe('studio tenancy: costs, ids, buckets and shelves (A-344)', () => {
  it('serves /api/costs to an admin only, because the ledger carries no tenant', async () => {
    const f = await fixture();
    const costsRunner: Runner = async () => ({ code: 0, stdout: '{"total":0}', stderr: '' });
    const base = await start(f, { runner: costsRunner });
    const forbidden = (role: string, article: string, name: string): unknown => [403, { error: { code: 'auth.forbidden', message: `GET /api/costs needs the admin role; ${name} is ${article} ${role}` } }];
    const asPair = async (token: string): Promise<unknown> => {
      const r = await call(base, 'GET', '/api/costs', token);
      return [r.status, r.body];
    };
    assert.deepEqual(await asPair(ANN), forbidden('viewer', 'a', 'ann'));
    assert.deepEqual(await asPair(OTTO), forbidden('operator', 'an', 'otto'));
    const admin = await call(base, 'GET', '/api/costs', ADA);
    assert.deepEqual([admin.status, admin.body], [200, { total: 0 }]);
  });

  it('refuses tenant default in a users file, and the CLI exits 2 naming it', async () => {
    const d = digest(ANN);
    const message = 'users.0.tenant: tenant default is the library\'s own (open mode and the WORLDGEN_STUDIO_TOKEN admin); give each team a tenant of its own';
    assert.throws(() => parseUsersFile(JSON.stringify({ users: [{ name: 'ann', role: 'viewer', tenant: 'default', token_sha256: d }] })), { message });
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-tenancy-default-'));
    roots.push(dir);
    const file = path.join(dir, 'users.json');
    await writeFile(file, JSON.stringify({ users: [{ name: 'ann', role: 'viewer', tenant: 'default', token_sha256: d }] }));
    const env = { ...process.env };
    delete env['WORLDGEN_STUDIO_TOKEN'];
    delete env['WORLDGEN_STUDIO_ORIGIN'];
    const r = spawnSync('bun', ['src/cli/studio.ts', '--users', file], { cwd: CODE_DIR, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.includes(message), true, r.stderr);
  });

  it('mints random ids, so two tenants with one slug in one second share no counter', async () => {
    const f = await fixture();
    await writeWorld(path.join(f.worldsDir, 'hand-beta'), minimalWorld());
    const base = await start(f);
    const a = await call(base, 'POST', '/api/generate', OTTO, gen('same'));
    const b = await call(base, 'POST', '/api/generate', GINA, gen('same'));
    const idA = String(a.body['runId']);
    const idB = String(b.body['runId']);
    assert.match(idA, /^\d{8}T\d{6}Z-same-[0-9a-f]{6}$/);
    assert.match(idB, /^\d{8}T\d{6}Z-same-[0-9a-f]{6}$/);
    assert.notEqual(idA, idB);
    const ep = await call(base, 'POST', '/api/episodes', OTTO, EPISODE);
    assert.match(String(ep.body['runId']), /^\d{8}T\d{6}Z-noop-[0-9a-f]{6}$/);
    const svc = await call(base, 'POST', '/api/worlds/hand-beta/serve', OTTO, { port: 4620 });
    assert.match(String(svc.body['id']), /^svc-[0-9a-f]{8}$/);
  });

  it('keys the POST bucket by address and tenant', async () => {
    const f = await fixture();
    const base = await start(f, { rateLimit: { capacity: 1, refillPerSecond: 0 } });
    const first = await call(base, 'POST', '/api/generate', OTTO, gen('one'));
    const other = await call(base, 'POST', '/api/generate', GINA, gen('two'));
    const second = await call(base, 'POST', '/api/generate', OTTO, gen('three'));
    assert.deepEqual([first.status, other.status, second.status], [200, 200, 429]);
    assert.equal((second.body['error'] as Json)['code'], 'studio.rate_limited');
  });

  it('lets an admin open a tenant\'s world by name with ?tenant=, and only then', async () => {
    const f = await fixture();
    await writeWorld(path.join(f.worldsDir, 'acme', 'gen-acme-only'), minimalWorld());
    const base = await start(f);
    const report = await call(base, 'GET', '/api/worlds/gen-acme-only/report?tenant=acme', ADA);
    assert.deepEqual([report.status, report.body['name']], [200, 'gen-acme-only']);
    assert.equal((await call(base, 'GET', '/api/worlds/gen-acme-only/tasks?tenant=acme', ADA)).status, 200);
    const bare = await call(base, 'GET', '/api/worlds/gen-acme-only/report', ADA);
    assert.deepEqual([bare.status, (bare.body['error'] as Json)['code']], [404, 'world.unknown']);
  });

  it('never shows a removed tenant\'s dir as a world or a run source, and keeps run-only and plan-only dirs', async () => {
    const f = await fixture();
    await writeWorld(path.join(f.worldsDir, 'oldco', 'gen-x'), minimalWorld());
    await mkdir(path.join(f.worldsDir, 'oldco', 'gen-x', 'runs', 'run_old'), { recursive: true });
    await writeFile(path.join(f.worldsDir, 'oldco', 'gen-x', 'runs', 'run_old', 'events.jsonl'), '{"t":"run_started"}\n');
    await mkdir(path.join(f.worldsDir, 'planonly'), { recursive: true });
    await writeFile(path.join(f.worldsDir, 'planonly', 'plan.yaml'), 'x: 1\n');
    const base = await start(f);
    const names = (await worldRows(base, ADA)).map((r) => (r as unknown[])[0]);
    assert.equal(names.includes('oldco'), false);
    assert.equal(names.includes('planonly'), true);
    const gone = await call(base, 'GET', '/api/worlds/oldco/report', ADA);
    assert.deepEqual([gone.status, (gone.body['error'] as Json)['code']], [404, 'world.unknown']);
    assert.equal((await call(base, 'GET', '/api/worlds/planonly/report', ADA)).status, 200);
    const runNames = (await runRows(base, ADA)).map((r) => (r as unknown[])[0]);
    assert.equal(runNames.includes('oldco'), false);
    assert.equal(runNames.includes('hand-beta'), true);
    assert.equal((await call(base, 'GET', '/api/worlds/hand-beta/report', ADA)).status, 200);
  });
});
