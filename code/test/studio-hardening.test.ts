/**
 * Studio web hardening (YOS-234, A-339): security headers on every answer, the per-client POST bucket, the caps on
 * unfinished jobs and the sign-in throttle. The spawner and runner are fakes and the clock is injected, so no child
 * starts and nothing is waited out.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { studioPage } from '../src/studio/page.ts';
import { studioServer, type StudioOptions, type StudioServer, type StudioUser } from '../src/studio/server.ts';

type Json = { [k: string]: unknown };
type Answer = { status: number; headers: Headers; body: Json };

async function call(base: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    // an HTML page
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** A POST with a Host and Origin of the test's choosing, which fetch will not send. */
function rawPost(port: number, p: string, host: string, origin: string, body: unknown): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host, origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json }));
    });
    req.on('error', reject);
    req.end(text);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Spawned = { argv: string[]; exitWith: (code: number | null) => void; exited: Promise<number | null> };

function fakeSpawner(): { spawner: Spawner; spawned: Spawned[] } {
  const spawned: Spawned[] = [];
  const spawner: Spawner = (argv) => {
    let settle: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const child: SpawnedChild = { pid: 43000 + spawned.length, exited, kill: () => true, output: () => '' };
    spawned.push({ argv: [...argv], exitWith: settle, exited });
    return child;
  };
  return { spawner, spawned };
}

const runner: Runner = async (argv) => (argv[0] === 'git' ? { code: 0, stdout: 'abc1234\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });

const roots: string[] = [];
const studios: StudioServer[] = [];
after(async () => {
  for (const s of studios) await s.close();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

type Fixture = { root: string; worldsDir: string };

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-hardening-'));
  roots.push(root);
  const worldsDir = path.join(root, 'prod', 'worlds');
  await mkdir(path.join(root, 'code'), { recursive: true });
  await mkdir(path.join(worldsDir, 'w1'), { recursive: true });
  return { root, worldsDir };
}

async function open(f: Fixture, opts: Partial<StudioOptions> = {}): Promise<StudioServer> {
  const studio = await studioServer({ port: 0, repoRoot: f.root, worldsDir: f.worldsDir, spawner: fakeSpawner().spawner, runner, ...opts });
  studios.push(studio);
  return studio;
}

const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const gen = (slug: string): Json => ({ kind: 'description', text: 'A tiny app', outSlug: slug });
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'";
const headersOf = (a: Answer): string[] => ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'content-security-policy'].map((n) => a.headers.get(n) ?? '(missing)');
const SECURE = ['DENY', 'nosniff', 'no-referrer', CSP];

const USERS: readonly StudioUser[] = [
  { name: 'ada', role: 'admin', tenant: 'default', tokenSha256: '86a038a189a3a7d826a98a2a8c1a67489e27c884c7017932b8c70ada02636069' },
];
const ADMIN = { authorization: 'Bearer admin-token-a1' };
const WRONG = { authorization: 'Bearer wrong-token' };
const code = (a: Answer): unknown => (a.body['error'] as Json | undefined)?.['code'];

describe('studio hardening: headers (A-339)', () => {
  it('sends all four on the page, JSON, a 404 and a 401, and keeps the sign-in challenge', async () => {
    const f = await fixture();
    const open1 = await open(f);
    for (const p of ['/', '/api/health', '/api/worlds', '/api/nope']) {
      const a = await call(open1.url, 'GET', p);
      assert.deepEqual([p, a.status === 0, headersOf(a)], [p, false, SECURE]);
    }
    const signed = await open(f, { users: USERS });
    const refused = await call(signed.url, 'GET', '/api/worlds');
    assert.equal(refused.status, 401);
    assert.deepEqual(headersOf(refused), SECURE);
    assert.equal(refused.headers.get('www-authenticate'), 'Bearer realm="studio"');
  });

  it('serves a page the CSP does not break', () => {
    const html = studioPage();
    for (const banned of ['<img', 'data:', 'blob:', 'eval(', 'new Function', '<iframe', 'src="http', 'href="http']) {
      assert.equal(html.includes(banned), false, banned);
    }
  });
});

describe('studio hardening: configured origin (A-339)', () => {
  it('accepts the POST from its own configured https origin', async () => {
    const f = await fixture();
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, origin: 'https://studio.example.com' });
    const r = await rawPost(studio.port, '/api/generate', 'studio.example.com', 'https://studio.example.com', gen('behind-proxy'));
    assert.equal(r.status, 200);
    assert.equal(s.spawned.length, 1);
  });
});

describe('studio hardening: POST bucket (A-339)', () => {
  it('limits each client and route, refills on the injected clock, and never draws for a GET', async () => {
    const f = await fixture();
    let clock = T0;
    const studio = await open(f, { now: () => clock, rateLimit: { capacity: 2, refillPerSecond: 1 } });
    const post = (slug: string) => call(studio.url, 'POST', '/api/generate', gen(slug), { 'idempotency-key': `k-${slug}` });
    assert.equal((await post('a')).status, 200);
    assert.equal((await call(studio.url, 'GET', '/api/worlds')).status, 200);
    assert.equal((await post('b')).status, 200);
    assert.equal((await call(studio.url, 'GET', '/api/health')).status, 200);
    const limited = await post('c');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal(code(limited), 'studio.rate_limited');
    assert.equal((limited.body['error'] as Json)['message'], 'Too many POST /api/generate requests from 127.0.0.1: the studio allows a burst of 2, refilled 1 per second');
    const episode = await call(studio.url, 'POST', '/api/episodes', { world: 'w1', task: 't1', agent: 'noop' });
    assert.equal(episode.status, 200);
    clock += 1000;
    assert.equal((await post('d')).status, 200);
  });
});

describe('studio hardening: job caps (A-339)', () => {
  it('refuses a second run past the cap, never a replay, and accepts one after the first finishes', async () => {
    const f = await fixture();
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, maxConcurrentRuns: 1, now: () => T0 });
    const first = await call(studio.url, 'POST', '/api/generate', gen('one'));
    assert.equal(first.status, 200);
    const noKey = await call(studio.url, 'POST', '/api/generate', gen('one'));
    assert.deepEqual([noKey.status, noKey.body['runId'], noKey.body['replayed']], [200, first.body['runId'], true]);
    const second = await call(studio.url, 'POST', '/api/generate', gen('two'));
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), null);
    assert.deepEqual(second.body, { error: { code: 'generate.concurrent_limit', message: 'the studio runs at most 1 generation runs at once; wait for one to finish' } });
    s.spawned[0]!.exitWith(0);
    await s.spawned[0]!.exited;
    await sleep(100);
    assert.equal((await call(studio.url, 'POST', '/api/generate', gen('two'))).status, 200);
  });

  it('answers a replay of a keyed run with the same job, never 429', async () => {
    const f = await fixture();
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, maxConcurrentRuns: 1, now: () => T0 });
    const first = await call(studio.url, 'POST', '/api/generate', gen('one'), { 'idempotency-key': 'k-one' });
    const again = await call(studio.url, 'POST', '/api/generate', gen('one'), { 'idempotency-key': 'k-one' });
    assert.deepEqual([first.status, again.status, again.body['runId'], again.body['replayed']], [200, 200, first.body['runId'], true]);
    assert.equal(s.spawned.length, 1);
  });

  it('counts an intent another studio holds a live lease on', async () => {
    const f = await fixture();
    await writeFile(path.join(f.worldsDir, '.studio-runs.json'), JSON.stringify([{
      runId: '20261007T110000Z-orphan', kind: 'generate', key: 'k-orphan', fingerprint: 'f'.repeat(64), phase: 'intent',
      lease: { holder: 'studio-other', expiresAt: '2026-10-07T12:10:00.000Z' }, outDir: path.join(f.worldsDir, 'gen-orphan'),
      pid: null, knownRuns: [], startedAt: '2026-10-07T11:00:00.000Z', exitCode: null,
    }]));
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, maxConcurrentRuns: 1, now: () => T0 });
    const r = await call(studio.url, 'POST', '/api/generate', gen('new'));
    assert.deepEqual([r.status, code(r)], [429, 'generate.concurrent_limit']);
    assert.equal(s.spawned.length, 0);
  });

  it('caps episodes on their own count', async () => {
    const f = await fixture();
    const s = fakeSpawner();
    const studio = await open(f, { spawner: s.spawner, maxConcurrentEpisodes: 1, now: () => T0 });
    const body = { world: 'w1', task: 't1', agent: 'noop' };
    assert.equal((await call(studio.url, 'POST', '/api/episodes', body)).status, 200);
    const second = await call(studio.url, 'POST', '/api/episodes', { ...body, task: 't2' });
    assert.deepEqual(second.body, { error: { code: 'episode.concurrent_limit', message: 'the studio runs at most 1 agent episodes at once; wait for one to finish' } });
    assert.equal(second.status, 429);
    assert.equal((await call(studio.url, 'POST', '/api/generate', gen('run-ok'))).status, 200);
  });
});

describe('studio hardening: sign-in throttle (A-339)', () => {
  it('throttles bearers after failed sign-ins, whether right or wrong, and not public routes or a missing bearer', async () => {
    const f = await fixture();
    let clock = T0;
    const studio = await open(f, { users: USERS, now: () => clock, authThrottle: { capacity: 2, refillPerSecond: 0.5 } });
    const get = (headers: Record<string, string>) => call(studio.url, 'GET', '/api/worlds', undefined, headers);
    assert.deepEqual([(await get(WRONG)).status, (await get(WRONG)).status], [401, 401]);
    const third = await get(WRONG);
    assert.deepEqual([third.status, code(third), third.headers.get('retry-after')], [429, 'auth.throttled', '2']);
    assert.equal((third.body['error'] as Json)['message'], 'Too many failed sign-ins from 127.0.0.1: wait 2 s before the next bearer token is checked');
    const valid = await get(ADMIN);
    assert.deepEqual([valid.status, code(valid), valid.headers.get('retry-after')], [429, 'auth.throttled', '2']);
    const none = await get({});
    assert.deepEqual([none.status, code(none)], [401, 'auth.required']);
    assert.equal((await call(studio.url, 'GET', '/api/health')).status, 200);
    clock += 2000;
    assert.equal((await get(ADMIN)).status, 200);
    assert.equal((await get(ADMIN)).status, 200);
    const wrong = await get(WRONG);
    assert.deepEqual([wrong.status, code(wrong)], [401, 'auth.invalid']);
  });
});
