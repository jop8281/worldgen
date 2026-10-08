/**
 * Studio sign-in (YOS-187): the bearer token, the three roles, the startup refusal and the POST audit log. The spawner and
 * runner are fakes, so no child starts; the only bind is loopback port 0.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { AUDIT_FILE, parseUsersFile, studioServer, type StudioServer, type StudioUser } from '../src/studio/server.ts';

const USERS: readonly StudioUser[] = [
  { name: 'vera', role: 'viewer', tenant: 'default', tokenSha256: 'f314e5680966dbe2271774a44be7bb0ddbf8d03612d39be7a19a8d74e285ca2b' },
  { name: 'olga', role: 'operator', tenant: 'default', tokenSha256: '0d8dc9deab36314a0e348de096f11795a300d35258412ffe048c9eecdabb8edd' },
  { name: 'ada', role: 'admin', tenant: 'default', tokenSha256: '86a038a189a3a7d826a98a2a8c1a67489e27c884c7017932b8c70ada02636069' },
];
const VIEWER = 'viewer-token-v1';
const OPERATOR = 'operator-token-o1';
const ADMIN = 'admin-token-a1';

type Reply = { status: number; headers: Headers; body: unknown; text: string };

async function call(base: string, method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${p}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // an HTML page
  }
  return { status: res.status, headers: res.headers, body, text };
}

const errorOf = (r: Reply): unknown => (r.body as { error: unknown }).error;

function fakes(): { spawner: Spawner; runner: Runner; spawned: string[][] } {
  const spawned: string[][] = [];
  const spawner: Spawner = (argv) => {
    spawned.push([...argv]);
    const child: SpawnedChild = { pid: 1, exited: new Promise<number | null>(() => {}), kill: () => true, output: () => '' };
    return child;
  };
  const runner: Runner = async () => ({ code: 0, stdout: '', stderr: '' });
  return { spawner, runner, spawned };
}

const GENERATE = { kind: 'description', text: 'A tiny bookmarks app', outSlug: 'bookmarks' };

describe('studio sign-in', () => {
  let root = '';
  let worldsDir = '';
  let server: StudioServer;
  let base = '';
  const f = fakes();

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-auth-'));
    worldsDir = path.join(root, 'prod', 'worlds');
    await mkdir(worldsDir, { recursive: true });
    server = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: f.spawner, runner: f.runner, users: USERS });
    base = server.url;
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a non-loopback host with no users', async () => {
    const o = fakes();
    await assert.rejects(
      studioServer({ port: 0, host: '0.0.0.0', repoRoot: root, worldsDir, spawner: o.spawner, runner: o.runner }),
      { message: 'studio refuses to bind 0.0.0.0 with no sign-in: it starts worldgen runs. Pass --users <file> or set WORLDGEN_STUDIO_TOKEN, or bind 127.0.0.1' },
    );
  });

  it('refuses a malformed digest and duplicate users at startup', async () => {
    const o = fakes();
    await assert.rejects(
      studioServer({ port: 0, repoRoot: root, worldsDir, spawner: o.spawner, runner: o.runner, users: [{ name: 'x', role: 'admin', tenant: 'default', tokenSha256: 'abc' }] }),
      { message: 'studio user x: tokenSha256 must be 64 hex characters' },
    );
    const vera = USERS[0]!;
    await assert.rejects(
      studioServer({ port: 0, repoRoot: root, worldsDir, spawner: o.spawner, runner: o.runner, users: [vera, { ...vera, name: 'other' }] }),
      { message: 'studio users share a token: other' },
    );
  });

  it('keeps GET /api/health and GET / public', async () => {
    const health = await call(base, 'GET', '/api/health');
    assert.equal(health.status, 200);
    const page = await call(base, 'GET', '/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.text.startsWith('<!DOCTYPE html>'), true);
    assert.equal(page.text.includes('http://'), false);
  });

  it('answers 401 with a challenge to a POST with no token or a wrong one, and spawns nothing', async () => {
    const none = await call(base, 'POST', '/api/generate', { body: GENERATE });
    assert.equal(none.status, 401);
    assert.deepEqual(errorOf(none), { code: 'auth.required', message: 'POST /api/generate needs sign-in: send Authorization: Bearer <token>, or sign in on the page' });
    assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="studio"');
    const wrong = await call(base, 'POST', '/api/generate', { token: 'not-a-token', body: GENERATE });
    assert.equal(wrong.status, 401);
    assert.equal((errorOf(wrong) as { code: string }).code, 'auth.invalid');
    assert.equal(wrong.headers.get('www-authenticate'), 'Bearer realm="studio"');
    assert.equal(f.spawned.length, 0);
  });

  it('lets a viewer read but not post or read the audit', async () => {
    assert.equal((await call(base, 'GET', '/api/worlds', { token: VIEWER })).status, 200);
    assert.deepEqual((await call(base, 'GET', '/api/me', { token: VIEWER })).body, { name: 'vera', role: 'viewer', tenant: 'default', signIn: true });
    const post = await call(base, 'POST', '/api/generate', { token: VIEWER, body: GENERATE });
    assert.equal(post.status, 403);
    assert.deepEqual(errorOf(post), { code: 'auth.forbidden', message: 'POST /api/generate needs the operator role; vera is a viewer' });
    assert.equal(f.spawned.length, 0);
    assert.equal((await call(base, 'GET', '/api/audit', { token: VIEWER })).status, 403);
  });

  it('lets an operator start a run but not read the audit', async () => {
    const r = await call(base, 'POST', '/api/generate', { token: OPERATOR, body: GENERATE });
    assert.equal(r.status, 200);
    assert.equal((r.body as { running: boolean }).running, true);
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0]!.includes('src/cli/worldgen.ts'), true);
    const audit = await call(base, 'GET', '/api/audit', { token: OPERATOR });
    assert.equal(audit.status, 403);
    assert.deepEqual(errorOf(audit), { code: 'auth.forbidden', message: 'GET /api/audit needs the admin role; olga is an operator' });
  });

  it('shows an admin every POST, without tokens', async () => {
    const r = await call(base, 'GET', '/api/audit', { token: ADMIN });
    assert.equal(r.status, 200);
    const { entries, unwritten } = r.body as { entries: Record<string, unknown>[]; unwritten: number };
    assert.equal(unwritten, 0);
    assert.deepEqual(entries.map(({ at, ...rest }) => (typeof at === 'string' ? rest : { at })), [
      { user: null, role: null, tenant: null, method: 'POST', path: '/api/generate', status: 401, code: 'auth.required' },
      { user: null, role: null, tenant: null, method: 'POST', path: '/api/generate', status: 401, code: 'auth.invalid' },
      { user: 'vera', role: 'viewer', tenant: 'default', method: 'POST', path: '/api/generate', status: 403, code: 'auth.forbidden' },
      { user: 'olga', role: 'operator', tenant: 'default', method: 'POST', path: '/api/generate', status: 200 },
    ]);
    const raw = await readFile(path.join(worldsDir, AUDIT_FILE), 'utf8');
    for (const token of [VIEWER, OPERATOR, ADMIN]) assert.equal(raw.includes(token), false);
  });

  it('accepts the Bearer scheme in any case', async () => {
    const res = await fetch(`${base}/api/me`, { headers: { authorization: `bEaReR ${ADMIN}` } });
    assert.deepEqual(await res.json(), { name: 'ada', role: 'admin', tenant: 'default', signIn: true });
  });
});

describe('studio open mode', () => {
  it('makes everyone the local admin and audits as local', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-open-'));
    const worldsDir = path.join(root, 'worlds');
    await mkdir(worldsDir, { recursive: true });
    const f = fakes();
    const server = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: f.spawner, runner: f.runner });
    try {
      assert.deepEqual((await call(server.url, 'GET', '/api/me')).body, { name: 'local', role: 'admin', tenant: 'default', signIn: false });
      const r = await call(server.url, 'POST', '/api/generate', { body: GENERATE });
      assert.equal(r.status, 200);
      assert.equal(f.spawned.length, 1);
      const { entries } = (await call(server.url, 'GET', '/api/audit')).body as { entries: Record<string, unknown>[] };
      assert.deepEqual(entries.map(({ at, ...rest }) => (typeof at === 'string' ? rest : { at })), [
        { user: 'local', role: 'admin', tenant: 'default', method: 'POST', path: '/api/generate', status: 200 },
      ]);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('studio users file and CLI', () => {
  const digest = USERS[0]!.tokenSha256;

  it('parses a valid users file', () => {
    assert.deepEqual(parseUsersFile(JSON.stringify({ users: [{ name: 'vera', role: 'viewer', tenant: 'acme', token_sha256: digest }] })), [
      { name: 'vera', role: 'viewer', tenant: 'acme', tokenSha256: digest },
    ]);
  });

  it('rejects a role outside the three, a non-hex digest and a non-JSON file', () => {
    assert.throws(() => parseUsersFile(JSON.stringify({ users: [{ name: 'x', role: 'root', tenant: 'acme', token_sha256: digest }] })), /users\.0\.role/);
    assert.throws(
      () => parseUsersFile(JSON.stringify({ users: [{ name: 'x', role: 'admin', tenant: 'acme', token_sha256: 'z'.repeat(64) }] })),
      { message: 'users.0.token_sha256: token_sha256 must be 64 lowercase hex characters' },
    );
    assert.throws(() => parseUsersFile('{'), { message: /^not valid JSON: / });
  });

  it('exits 1 with the refusal when bound to 0.0.0.0 with no sign-in', () => {
    const env = { ...process.env };
    delete env['WORLDGEN_STUDIO_TOKEN'];
    const r = spawnSync('bun', ['src/cli/studio.ts', '--host', '0.0.0.0', '--port', '0'], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.includes('studio refuses to bind 0.0.0.0 with no sign-in'), true);
  });
});

type Raw = { status: number; body: unknown };

/** fetch cannot set Host, so the own-names tests speak raw HTTP. */
function raw(port: number, method: string, p: string, headers: Record<string, string>): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // an HTML page
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    if (method === 'POST') req.write(JSON.stringify(GENERATE));
    req.end();
  });
}

const errOf = (r: Raw): unknown => (r.body as { error: unknown }).error;
const stripAt = (entries: Record<string, unknown>[]): unknown[] => entries.map(({ at, ...rest }) => (typeof at === 'string' ? rest : { at }));

describe('studio answers only to its own names', () => {
  let root = '';
  let worldsDir = '';
  let server: StudioServer;
  const f = fakes();

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-names-'));
    worldsDir = path.join(root, 'worlds');
    await mkdir(worldsDir, { recursive: true });
    server = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: f.spawner, runner: f.runner });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const json = { 'content-type': 'application/json' };

  it('refuses a forged Origin on a POST and spawns nothing', async () => {
    const r = await raw(server.port, 'POST', '/api/generate', { host: `127.0.0.1:${server.port}`, origin: 'https://evil.example', ...json });
    assert.equal(r.status, 403);
    assert.deepEqual(errOf(r), {
      code: 'origin.forbidden',
      message: `POST from https://evil.example is refused: a POST must come from the studio page (http://127.0.0.1:${server.port}, http://localhost:${server.port}) or from a client that sends no Origin`,
    });
    const nul = await raw(server.port, 'POST', '/api/generate', { host: `127.0.0.1:${server.port}`, origin: 'null', ...json });
    assert.equal((errOf(nul) as { code: string }).code, 'origin.forbidden');
    assert.equal(f.spawned.length, 0);
  });

  it('refuses a rebinding Host on a POST and on a GET', async () => {
    const r = await raw(server.port, 'POST', '/api/generate', { host: `evil.example:${server.port}`, ...json });
    assert.equal(r.status, 403);
    assert.deepEqual(errOf(r), {
      code: 'host.forbidden',
      message: `Host evil.example:${server.port} is not this studio, which answers to 127.0.0.1:${server.port}, localhost:${server.port}. To reach it by another name, start it with --origin <url>`,
    });
    const g = await raw(server.port, 'GET', '/api/worlds', { host: `evil.example:${server.port}` });
    assert.equal(g.status, 403);
    assert.equal((errOf(g) as { code: string }).code, 'host.forbidden');
    assert.equal(f.spawned.length, 0);
  });

  it('lets a client with no Origin and the studio page through', async () => {
    const none = await raw(server.port, 'POST', '/api/generate', { host: `127.0.0.1:${server.port}`, 'idempotency-key': 'origin-none', ...json });
    assert.equal(none.status, 200);
    assert.equal(f.spawned.length, 1);
    const page = await raw(server.port, 'POST', '/api/generate', { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}`, 'idempotency-key': 'origin-page', ...json });
    assert.equal(page.status, 200);
    const named = await raw(server.port, 'POST', '/api/generate', { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}`, 'idempotency-key': 'origin-named', ...json });
    assert.equal(named.status, 200);
    assert.equal(f.spawned.length, 3);
  });

  it('audits the refused POSTs with their codes', async () => {
    const r = await raw(server.port, 'GET', '/api/audit', { host: `127.0.0.1:${server.port}` });
    const { entries } = r.body as { entries: Record<string, unknown>[] };
    const local = { user: 'local', role: 'admin', tenant: 'default', method: 'POST', path: '/api/generate' };
    assert.deepEqual(stripAt(entries), [
      { ...local, status: 403, code: 'origin.forbidden' },
      { ...local, status: 403, code: 'origin.forbidden' },
      { ...local, status: 403, code: 'host.forbidden' },
      { ...local, status: 200 },
      { ...local, status: 200 },
      { ...local, status: 200 },
    ]);
  });
});

describe('studio configured origin and wildcard bind', () => {
  it('accepts the configured origin', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-origin-'));
    const f = fakes();
    const server = await studioServer({ port: 0, repoRoot: root, worldsDir: path.join(root, 'worlds'), spawner: f.spawner, runner: f.runner, origin: 'http://127.0.0.1:9000' });
    try {
      const r = await raw(server.port, 'POST', '/api/generate', { host: '127.0.0.1:9000', origin: 'http://127.0.0.1:9000', 'content-type': 'application/json' });
      assert.equal(r.status, 200);
      assert.equal(f.spawned.length, 1);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks Host before the bearer on a wildcard bind', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-wild-'));
    const f = fakes();
    const server = await studioServer({ port: 0, host: '0.0.0.0', repoRoot: root, worldsDir: path.join(root, 'worlds'), spawner: f.spawner, runner: f.runner, users: USERS });
    try {
      const ok = await raw(server.port, 'GET', '/api/me', { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${ADMIN}` });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { name: 'ada', role: 'admin', tenant: 'default', signIn: true });
      const bad = await raw(server.port, 'GET', '/api/me', { host: `evil.example:${server.port}` });
      assert.equal(bad.status, 403);
      assert.equal((errOf(bad) as { code: string }).code, 'host.forbidden');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers to its bracketed name on an IPv6 loopback bind', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-v6-'));
    const f = fakes();
    const server = await studioServer({ port: 0, host: '::1', repoRoot: root, worldsDir: path.join(root, 'worlds'), spawner: f.spawner, runner: f.runner });
    try {
      assert.equal(server.url, `http://[::1]:${server.port}`);
      const res = await fetch(`${server.url}/api/me`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { name: 'local', role: 'admin', tenant: 'default', signIn: false });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an origin with a path at startup', async () => {
    const o = fakes();
    await assert.rejects(
      studioServer({ port: 0, repoRoot: tmpdir(), spawner: o.spawner, runner: o.runner, origin: 'http://127.0.0.1:9000/path' }),
      { message: 'studio origin must be an http(s) origin such as http://127.0.0.1:8787, got http://127.0.0.1:9000/path' },
    );
  });
});

describe('studio under sign-in lists no routes', () => {
  it('answers a bare 404 to an unmatched path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-404-'));
    const f = fakes();
    const server = await studioServer({ port: 0, repoRoot: root, worldsDir: path.join(root, 'worlds'), spawner: f.spawner, runner: f.runner, users: USERS });
    try {
      const r = await call(server.url, 'GET', '/api/nope', { token: VIEWER });
      assert.equal(r.status, 404);
      assert.deepEqual(errorOf(r), { code: 'route.not_found', message: 'No studio route GET /api/nope' });
      assert.equal(r.text.includes('/api/generate'), false);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('studio empty users and --origin on the CLI', () => {
  const cwd = path.resolve(import.meta.dirname, '..');
  const cliEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env['WORLDGEN_STUDIO_TOKEN'];
    delete env['WORLDGEN_STUDIO_ORIGIN'];
    return env;
  };
  const message = 'users: list at least one user: an empty list would turn sign-in off';

  it('refuses an empty users list', () => {
    assert.throws(() => parseUsersFile(JSON.stringify({ users: [] })), { message });
  });

  it('exits 2 on an empty --users file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-empty-'));
    try {
      const file = path.join(dir, 'users.json');
      await writeFile(file, JSON.stringify({ users: [] }));
      const r = spawnSync('bun', ['src/cli/studio.ts', '--users', file], { cwd, env: cliEnv(), encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 2);
      assert.equal(r.stderr.includes(`--users ${file}: ${message}`), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on an --origin that is not an origin', () => {
    const r = spawnSync('bun', ['src/cli/studio.ts', '--origin', 'not-a-url'], { cwd, env: cliEnv(), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.includes('--origin must be an http(s) origin such as http://127.0.0.1:8787, got not-a-url'), true);
  });
});

describe('studio-deploy.sh up guard', () => {
  const cwd = path.resolve(import.meta.dirname, '..');
  const script = path.resolve(cwd, '..', 'scripts', 'studio-deploy.sh');
  let dir = '';
  let log = '';

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'studio-deploy-'));
    log = path.join(dir, 'docker.log');
    await mkdir(path.join(dir, 'bin'));
    const docker = path.join(dir, 'bin', 'docker');
    await writeFile(docker, `#!/bin/sh\necho "$@" >> '${log}'\n[ "$1" = inspect ] && echo healthy\nexit 0\n`);
    await chmod(docker, 0o755);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const up = async (extra: Record<string, string>): Promise<{ status: number | null; stderr: string; calls: string[] }> => {
    await rm(log, { force: true });
    const env = { PATH: `${path.join(dir, 'bin')}:${process.env['PATH']}`, HOME: process.env['HOME'] ?? '', ...extra };
    const r = spawnSync('bash', [script, 'up'], { cwd, env, encoding: 'utf8', timeout: 60_000 });
    const calls = await readFile(log, 'utf8').then((t) => t.split('\n').filter((l) => l !== ''), () => []);
    return { status: r.status, stderr: r.stderr, calls };
  };
  const guard = 'set WORLDGEN_STUDIO_TOKEN, or put WORLDGEN_STUDIO_TOKEN=<token> in STUDIO_ENV_FILE';

  it('refuses with no token anywhere', async () => {
    const r = await up({});
    assert.equal(r.status, 1);
    assert.equal(r.stderr.includes(guard), true);
    assert.deepEqual(r.calls, []);
  });

  it('refuses an env file with no token line', async () => {
    const file = path.join(dir, 'no-token.env');
    await writeFile(file, 'LLM_KEY=abc\n# WORLDGEN_STUDIO_TOKEN=commented\nWORLDGEN_STUDIO_TOKEN=\n');
    const r = await up({ STUDIO_ENV_FILE: file });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.includes(guard), true);
    assert.deepEqual(r.calls, []);
  });

  it('accepts a token line in the env file and never logs it', async () => {
    const file = path.join(dir, 'token.env');
    await writeFile(file, 'LLM_KEY=abc\nWORLDGEN_STUDIO_TOKEN=deploy-token-1\n');
    const r = await up({ STUDIO_ENV_FILE: file });
    assert.equal(r.status, 0);
    const run = r.calls.filter((l) => l.startsWith('run -d'));
    assert.equal(run.length, 1);
    assert.equal(run[0]!.includes(`--env-file ${file}`), true);
    assert.equal(run[0]!.includes('WORLDGEN_STUDIO_ORIGIN=http://127.0.0.1:8787'), true);
    assert.equal(r.calls.some((l) => l.includes('deploy-token-1')), false);
  });

  it('accepts a token in the environment and forwards it by name', async () => {
    const r = await up({ WORLDGEN_STUDIO_TOKEN: 'env-token-2' });
    assert.equal(r.status, 0);
    const run = r.calls.filter((l) => l.startsWith('run -d'));
    assert.equal(run.length, 1);
    assert.equal(run[0]!.includes('-e WORLDGEN_STUDIO_TOKEN '), true);
    assert.equal(r.calls.some((l) => l.includes('env-token-2')), false);
  });
});

describe('studio-deploy.sh rollback and STUDIO_IMAGE (YOS-236)', () => {
  const cwd = path.resolve(import.meta.dirname, '..');
  const script = path.resolve(cwd, '..', 'scripts', 'studio-deploy.sh');
  let dir = '';
  let log = '';

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'studio-rollback-'));
    log = path.join(dir, 'docker.log');
    await mkdir(path.join(dir, 'bin'));
    const docker = path.join(dir, 'bin', 'docker');
    // Healthy at once; `image inspect` of a tag ending in :missing finds no image.
    await writeFile(docker, `#!/bin/sh\necho "$@" >> '${log}'\n[ "$1" = inspect ] && echo healthy\nif [ "$1" = image ] && [ "$2" = inspect ]; then case "$3" in *:missing) exit 1 ;; esac; fi\nexit 0\n`);
    await chmod(docker, 0o755);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const deploy = async (args: readonly string[], extra: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string; calls: string[] }> => {
    await rm(log, { force: true });
    const env = { PATH: `${path.join(dir, 'bin')}:${process.env['PATH']}`, HOME: process.env['HOME'] ?? '', ...extra };
    const r = spawnSync('bash', [script, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
    const calls = await readFile(log, 'utf8').then((t) => t.split('\n').filter((l) => l !== ''), () => []);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
  };
  const TOKEN = { WORLDGEN_STUDIO_TOKEN: 'drill-token-1' };

  it('rollback runs an existing image on the same volumes and never builds', async () => {
    const r = await deploy(['rollback', 'abc1234'], TOKEN);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'studio worldgen-studio:abc1234 healthy on http://127.0.0.1:8787\n');
    assert.equal(r.calls.some((l) => l.startsWith('build')), false);
    assert.equal(r.calls[0], 'image inspect worldgen-studio:abc1234');
    const run = r.calls.filter((l) => l.startsWith('run -d'));
    assert.equal(run.length, 1);
    assert.equal(run[0]!.endsWith('-v worldgen-studio-worlds:/app/prod/worlds -v worldgen-studio-ledger:/home/bun/.worldgen -v worldgen-studio-episodes:/app/eval/episodes worldgen-studio:abc1234'), true);
    const chown = r.calls.filter((l) => l.includes('--entrypoint chown'));
    assert.equal(chown.length, 1);
    assert.equal(chown[0]!.endsWith('worldgen-studio:abc1234 -R bun:bun /app/prod/worlds /home/bun/.worldgen /app/eval/episodes'), true);
    assert.equal(r.calls.some((l) => l.includes('drill-token-1')), false);
  });

  it('rollback refuses a tag with no image before it touches the running container', async () => {
    const r = await deploy(['rollback', 'missing'], TOKEN);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'studio-deploy: no image worldgen-studio:missing here; rollback runs an image built earlier and never builds one\n');
    assert.deepEqual(r.calls, ['image inspect worldgen-studio:missing']);
  });

  it('rollback refuses without a token before any docker call, as up does', async () => {
    const r = await deploy(['rollback', 'abc1234'], {});
    assert.equal(r.status, 1);
    assert.equal(r.stderr.includes('set WORLDGEN_STUDIO_TOKEN, or put WORLDGEN_STUDIO_TOKEN=<token> in STUDIO_ENV_FILE'), true);
    assert.deepEqual(r.calls, []);
  });

  it('up mounts the episodes volume beside worlds and the ledger', async () => {
    const r = await deploy(['up'], TOKEN);
    assert.equal(r.status, 0);
    assert.match(r.calls.filter((l) => l.startsWith('run -d'))[0]!, / -v worldgen-studio-worlds:\/app\/prod\/worlds -v worldgen-studio-ledger:\/home\/bun\/\.worldgen -v worldgen-studio-episodes:\/app\/eval\/episodes worldgen-studio:[0-9a-f]{40}$/);
  });

  it('backup archives the three volumes, episode exports included', async () => {
    const r = await deploy(['backup', path.join(dir, 'drill.tgz')], { STUDIO_VOLUME_PREFIX: 'drill' });
    assert.equal(r.status, 0);
    assert.deepEqual(r.calls, [
      `run --rm --user root --entrypoint tar -v drill-worlds:/backup/worlds:ro -v drill-ledger:/backup/ledger:ro -v drill-episodes:/backup/episodes:ro -v ${dir}:/out worldgen-studio:latest czf /out/drill.tgz -C /backup worlds ledger episodes`,
    ]);
  });

  it('restore empties and refills the three volumes, episode exports included', async () => {
    const file = path.join(dir, 'restore.tgz');
    await writeFile(file, 'not a real archive: the fake docker never reads it');
    const r = await deploy(['restore', file], { STUDIO_VOLUME_PREFIX: 'drill' });
    assert.equal(r.status, 0);
    const run = r.calls.filter((l) => l.startsWith('run --rm'));
    assert.deepEqual(run, [
      `run --rm --user root --entrypoint sh -v drill-worlds:/backup/worlds -v drill-ledger:/backup/ledger -v drill-episodes:/backup/episodes -v ${dir}:/in:ro worldgen-studio:latest -c find /backup/worlds /backup/ledger /backup/episodes -mindepth 1 -delete && tar xzpf /in/restore.tgz -C /backup`,
    ]);
  });

  it('STUDIO_IMAGE names the repository up builds and runs, so a drill never moves worldgen-studio:latest', async () => {
    const r = await deploy(['up'], { ...TOKEN, STUDIO_IMAGE: 'drill-studio' });
    assert.equal(r.status, 0);
    const build = r.calls.filter((l) => l.startsWith('build'));
    assert.equal(build.length, 1);
    assert.match(build[0]!, / -t drill-studio:[0-9a-f]{40} -t drill-studio:latest /);
    assert.equal(r.calls.some((l) => l.includes('worldgen-studio:')), false);
    assert.match(r.calls.filter((l) => l.startsWith('run -d'))[0]!, /drill-studio:[0-9a-f]{40}$/);
  });
});

