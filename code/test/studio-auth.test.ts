/**
 * Studio sign-in (YOS-187): the bearer token, the three roles, the startup refusal and the POST audit log. The spawner and
 * runner are fakes, so no child starts; the only bind is loopback port 0.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { AUDIT_FILE, parseUsersFile, studioServer, type StudioServer, type StudioUser } from '../src/studio/server.ts';

const USERS: readonly StudioUser[] = [
  { name: 'vera', role: 'viewer', tokenSha256: 'f314e5680966dbe2271774a44be7bb0ddbf8d03612d39be7a19a8d74e285ca2b' },
  { name: 'olga', role: 'operator', tokenSha256: '0d8dc9deab36314a0e348de096f11795a300d35258412ffe048c9eecdabb8edd' },
  { name: 'ada', role: 'admin', tokenSha256: '86a038a189a3a7d826a98a2a8c1a67489e27c884c7017932b8c70ada02636069' },
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
      studioServer({ port: 0, repoRoot: root, worldsDir, spawner: o.spawner, runner: o.runner, users: [{ name: 'x', role: 'admin', tokenSha256: 'abc' }] }),
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
    assert.deepEqual((await call(base, 'GET', '/api/me', { token: VIEWER })).body, { name: 'vera', role: 'viewer', signIn: true });
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
      { user: null, role: null, method: 'POST', path: '/api/generate', status: 401, code: 'auth.required' },
      { user: null, role: null, method: 'POST', path: '/api/generate', status: 401, code: 'auth.invalid' },
      { user: 'vera', role: 'viewer', method: 'POST', path: '/api/generate', status: 403, code: 'auth.forbidden' },
      { user: 'olga', role: 'operator', method: 'POST', path: '/api/generate', status: 200 },
    ]);
    const raw = await readFile(path.join(worldsDir, AUDIT_FILE), 'utf8');
    for (const token of [VIEWER, OPERATOR, ADMIN]) assert.equal(raw.includes(token), false);
  });

  it('accepts the Bearer scheme in any case', async () => {
    const res = await fetch(`${base}/api/me`, { headers: { authorization: `bEaReR ${ADMIN}` } });
    assert.deepEqual(await res.json(), { name: 'ada', role: 'admin', signIn: true });
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
      assert.deepEqual((await call(server.url, 'GET', '/api/me')).body, { name: 'local', role: 'admin', signIn: false });
      const r = await call(server.url, 'POST', '/api/generate', { body: GENERATE });
      assert.equal(r.status, 200);
      assert.equal(f.spawned.length, 1);
      const { entries } = (await call(server.url, 'GET', '/api/audit')).body as { entries: Record<string, unknown>[] };
      assert.deepEqual(entries.map(({ at, ...rest }) => (typeof at === 'string' ? rest : { at })), [
        { user: 'local', role: 'admin', method: 'POST', path: '/api/generate', status: 200 },
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
    assert.deepEqual(parseUsersFile(JSON.stringify({ users: [{ name: 'vera', role: 'viewer', token_sha256: digest }] })), [
      { name: 'vera', role: 'viewer', tokenSha256: digest },
    ]);
  });

  it('rejects a role outside the three, a non-hex digest and a non-JSON file', () => {
    assert.throws(() => parseUsersFile(JSON.stringify({ users: [{ name: 'x', role: 'root', token_sha256: digest }] })), /users\.0\.role/);
    assert.throws(
      () => parseUsersFile(JSON.stringify({ users: [{ name: 'x', role: 'admin', token_sha256: 'z'.repeat(64) }] })),
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
