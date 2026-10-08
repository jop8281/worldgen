/**
 * Studio web hardening (YOS-234): the security headers on every answer, the CSRF/Origin guard
 * on state-changing POSTs (composed with the own-names guard — host.forbidden, origin.forbidden
 * — which covers what the CSRF rule passes), the per-route token bucket, and the caps on
 * concurrent generation runs and agent episodes. The spawner and runner are fakes (no child,
 * no model), and the limits are overridden small where a test needs a trip, so no test sleeps
 * or floods.
 */
import assert from 'node:assert/strict';
import http, { type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { RunResult, Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { studioServer, type StudioServer } from '../src/studio/server.ts';

// ---- transport --------------------------------------------------------------------------------

async function call(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${base}${p}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** A raw request with full control over the Host and Origin headers, which fetch forbids. */
function raw(base: string, opts: { path: string; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path: opts.path, method: opts.method, headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const GEN_BODY = (slug: string): string => JSON.stringify({ kind: 'description', text: 'A helpdesk with SLA tiers', outSlug: slug });

/** The error code of a JSON refusal, for the port-dependent own-names messages. */
function errorCodeOf(text: string): unknown {
  const body = JSON.parse(text) as { error?: { code?: unknown } };
  return body.error?.code;
}

// ---- fakes: every child is recorded, none is real ------------------------------------------------

function fakeChild(): { child: SpawnedChild; signals: string[] } {
  const signals: string[] = [];
  let dead = false;
  let text = '';
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const child: SpawnedChild = {
    pid: 43210,
    exited,
    kill(signal) {
      signals.push(signal);
      if (!dead && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        dead = true;
        settle(signal === 'SIGKILL' ? null : 0);
      }
      return !dead;
    },
    output: () => text,
  };
  return { child, signals };
}

function fakeSpawner(): Spawner {
  return () => fakeChild().child;
}

/** answers git rev-parse HEAD with a sha for the episode route; costs never runs here. */
const fakeRunner: Runner = async (argv): Promise<RunResult> => (
  argv[0] === 'git' ? { code: 0, stdout: 'cafebabecafebabecafebabecafebabecafebabe', stderr: '' } : { code: 0, stdout: '{}', stderr: '' }
);

const SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
} as const;

describe('studio hardening (YOS-234)', () => {
  let root = '';
  let worldsDir = '';
  let base = '';
  let server: StudioServer;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-hardening-'));
    worldsDir = path.join(root, 'prod', 'worlds');
    await mkdir(path.join(worldsDir, 'helpdesk'), { recursive: true });
    server = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: fakeSpawner(), runner: fakeRunner });
    base = server.url;
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  describe('security headers', () => {
    it('sends the four headers on the page and on every API answer', async () => {
      const cases: readonly (readonly ['GET' | 'POST', string, unknown, number])[] = [
        ['GET', '/', undefined, 200],
        ['POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'headers' }, 200],
        ['GET', '/api/nope', undefined, 404],
      ];
      for (const [method, p, body, want] of cases) {
        const r = await call(base, method, p, body);
        assert.equal(r.status, want, `${method} ${p}`);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
          assert.equal(r.headers.get(name), value, `${method} ${p} ${name}`);
        }
      }
    });

    it('sends them on a refusal too', async () => {
      const r = await raw(base, { path: '/api/generate', method: 'POST', headers: { host: 'evil.example', origin: 'https://evil.example', 'content-type': 'application/json' }, body: GEN_BODY('headers-refused') });
      assert.equal(r.status, 403);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(String(r.headers[name]), value, name);
      }
    });
  });

  describe('the CSRF/Origin guard', () => {
    it('refuses a state-changing POST whose Host and Origin are both non-loopback', async () => {
      const r = await raw(base, { path: '/api/generate', method: 'POST', headers: { host: 'evil.example', origin: 'https://evil.example', 'content-type': 'application/json' }, body: GEN_BODY('csrf-evil') });
      assert.equal(r.status, 403);
      assert.equal(r.text, JSON.stringify({
        error: {
          code: 'studio.csrf_origin',
          message: 'cross-origin POST refused: Host evil.example is not loopback and Origin https://evil.example is not a loopback origin; the studio takes state changes over loopback only',
        },
      }));
    });

    it('passes a state-changing POST with no Origin, on the studio\u2019s own host (curl, scripts)', async () => {
      // No Origin passes the CSRF rule; the loopback host is the studio's own name, so the request runs.
      const r = await raw(base, { path: '/api/generate', method: 'POST', headers: { 'content-type': 'application/json' }, body: GEN_BODY('csrf-curl') });
      assert.equal(r.status, 200, r.text);
    });

    it('composes with the own-names guard: a no-Origin POST and a loopback Origin on a foreign Host are still refused', async () => {
      // Upstream's own-names guard (host.forbidden) covers what the CSRF rule deliberately passes:
      // no Origin at all, and a loopback Origin, on a Host the studio does not answer to.
      const noOrigin = await raw(base, { path: '/api/generate', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: GEN_BODY('csrf-curl-foreign') });
      assert.equal(noOrigin.status, 403);
      assert.equal(errorCodeOf(noOrigin.text), 'host.forbidden');
      const loopbackOrigin = await raw(base, { path: '/api/generate', method: 'POST', headers: { host: 'evil.example', origin: 'http://127.0.0.1:8787', 'content-type': 'application/json' }, body: GEN_BODY('csrf-loopback-origin') });
      assert.equal(loopbackOrigin.status, 403);
      assert.equal(errorCodeOf(loopbackOrigin.text), 'host.forbidden');
    });

    it('composes with the own-names guard: a foreign Origin on the loopback Host is refused as origin.forbidden', async () => {
      // The CSRF rule passes a loopback Host; upstream's own-names guard still refuses a POST
      // whose Origin is not the studio page's own origin.
      const r = await raw(base, { path: '/api/generate', method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: GEN_BODY('csrf-loopback-host') });
      assert.equal(r.status, 403);
      assert.equal(errorCodeOf(r.text), 'origin.forbidden');
    });

    it('lets the studio page POST: the page\u2019s own origin on the own host runs', async () => {
      const port = new URL(base).port;
      const r = await raw(base, { path: '/api/generate', method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: GEN_BODY('csrf-page') });
      assert.equal(r.status, 200, r.text);
    });

    it('leaves GETs alone: a GET with a foreign Origin on the own host is answered, not refused', async () => {
      const r = await raw(base, { path: '/api/health', method: 'GET', headers: { origin: 'https://evil.example' } });
      assert.equal(r.status, 200, r.text);
    });
  });

  describe('the rate limit', () => {
    it('429s a route past its burst, per route, and never touches GETs', async () => {
      const small = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: fakeSpawner(), runner: fakeRunner, rateLimit: { capacity: 3, refillPerSecond: 0 } });
      try {
        const statuses: number[] = [];
        for (const slug of ['rate-a', 'rate-b', 'rate-c', 'rate-d']) {
          const r = await call(small.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: slug });
          statuses.push(r.status);
        }
        assert.deepEqual(statuses, [200, 200, 200, 429]);
        const refused = await call(small.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'rate-e' });
        assert.equal(refused.status, 429);
        assert.equal(refused.text, JSON.stringify({
          error: { code: 'studio.rate_limited', message: 'Too many POST /api/generate requests: the studio allows a burst of 3, refilled 0 per second' },
        }));
        // Each route has its own bucket, and GETs draw from none.
        const serve = await call(small.url, 'POST', '/api/worlds/helpdesk/serve', {});
        assert.equal(serve.status, 200, serve.text);
        for (let i = 0; i < 4; i += 1) assert.equal((await call(small.url, 'GET', '/')).status, 200);
      } finally {
        await small.close();
      }
    });
  });

  describe('the concurrency caps', () => {
    it('refuses the third generation run at cap 2, and frees the slot when one is stopped', async () => {
      const capped = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: fakeSpawner(), runner: fakeRunner, maxConcurrentRuns: 2, runStopWaitMs: 50 });
      try {
        const one = await call(capped.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'cap-run-a' });
        assert.equal(one.status, 200);
        const two = await call(capped.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'cap-run-b' });
        assert.equal(two.status, 200);
        const three = await call(capped.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'cap-run-c' });
        assert.equal(three.status, 429);
        assert.equal(three.text, JSON.stringify({
          error: { code: 'generate.concurrent_limit', message: '2 generation runs are already active; the studio runs at most 2 at once, so stop one first' },
        }));
        const runId = String(JSON.parse(one.text)['runId']);
        const stop = await call(capped.url, 'POST', `/api/generate/${runId}/stop`);
        assert.equal(stop.status, 200, stop.text);
        assert.equal(stop.text, JSON.stringify({ runId, stopped: true, signal: 'SIGTERM' }));
        const after = await call(capped.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'cap-run-d' });
        assert.equal(after.status, 200, after.text);
      } finally {
        await capped.close();
      }
    });

    it('refuses the third episode at cap 2, and frees the slot when one is stopped', async () => {
      const capped = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: fakeSpawner(), runner: fakeRunner, maxConcurrentEpisodes: 2 });
      const start = (i: string): Promise<{ status: number; text: string }> =>
        call(capped.url, 'POST', '/api/episodes', { world: 'helpdesk', task: `task-${i}`, agent: 'noop' });
      try {
        const one = await start('one');
        assert.equal(one.status, 200, one.text);
        const two = await start('two');
        assert.equal(two.status, 200, two.text);
        const three = await start('three');
        assert.equal(three.status, 429);
        assert.equal(three.text, JSON.stringify({
          error: { code: 'episode.concurrent_limit', message: '2 agent episodes are already active; the studio runs at most 2 at once, so stop one first' },
        }));
        const runId = String(JSON.parse(one.text)['runId']);
        const stop = await call(capped.url, 'POST', `/api/episodes/${runId}/stop`);
        assert.equal(stop.status, 200, stop.text);
        assert.equal(stop.text, JSON.stringify({ runId, stopped: true, signal: 'SIGTERM' }));
        const after = await start('four');
        assert.equal(after.status, 200, after.text);
      } finally {
        await capped.close();
      }
    });
  });
});
