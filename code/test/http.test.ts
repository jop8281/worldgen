import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { after, before, describe, it } from 'node:test';
import { checkWorld, serve, type CheckedWorld, type World, type WorldServer } from '#engine';
import { quietPort } from './helpers/ports.ts';
import { minimalWorld } from './helpers/world.ts';

type Reply = { status: number; body: unknown; text: string; type: string | null };

async function send(base: string, method: string, p: string, body?: string, headers: Record<string, string> = {}): Promise<Reply> {
  const mergedHeaders = { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const res = await fetch(`${base}${p}`, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(Object.keys(mergedHeaders).length === 0 ? {} : { headers: mergedHeaders }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text === '' ? null : JSON.parse(text), type: res.headers.get('content-type') };
}

function checked(world: World): CheckedWorld {
  const report = checkWorld(world);
  if (!report.ok) assert.fail(`world did not pass check:\n${JSON.stringify(report.issues, null, 2)}`);
  return report.world;
}

/** One served minimal world per describe, reset to seed before each case. */
function servedWorld(world: () => World = () => minimalWorld()): {
  srv: () => WorldServer;
  api: (m: string, p: string, b?: string, h?: Record<string, string>) => Promise<Reply>;
  admin: (m: string, p: string, b?: string, h?: Record<string, string>) => Promise<Reply>;
} {
  let server: WorldServer | undefined;
  before(async () => {
    server = await serve(checked(world()), { port: 0 });
  });
  after(async () => {
    await server?.close();
  });
  const srv = (): WorldServer => {
    assert.ok(server, 'server did not start');
    return server;
  };
  return {
    srv,
    api: (m, p, b, h) => send(srv().url, m, p, b, h),
    admin: (m, p, b, h) => send(srv().adminUrl, m, p, b, h),
  };
}

describe('serve: world port', () => {
  const { api, admin } = servedWorld();

  it('serves GET /openapi.json on the world port and never lists admin routes', async () => {
    const r = await api('GET', '/openapi.json');
    assert.equal(r.status, 200);
    assert.equal(r.type, 'application/json; charset=utf-8');
    const doc = r.body as { openapi: string; paths: Record<string, unknown> };
    assert.equal(doc.openapi.startsWith('3.1'), true);
    assert.equal('/tickets' in doc.paths, true);
    assert.deepEqual(Object.keys(doc.paths).filter((p) => p.startsWith('/_world')), []);
  });

  it('R1 answers a list route from the seed with JSON', async () => {
    await admin('POST', '/_world/reset');
    const r = await api('GET', '/tickets?status=pending&limit=2');
    assert.equal(r.status, 200);
    assert.equal(r.type, 'application/json; charset=utf-8');
    const body = r.body as { data: { id: string; status: string }[]; next_cursor: string | null };
    assert.deepEqual(body.data.map((t) => t.id), ['tkt_0002', 'tkt_0005']);
    assert.deepEqual(body.data.map((t) => t.status), ['pending', 'pending']);
    assert.equal(typeof body.next_cursor, 'string');
  });

  it('R1 runs an action and a standard write, and the write is visible to the next read', async () => {
    await admin('POST', '/_world/reset');
    const resolved = await api('POST', '/tickets/tkt_0002/resolve');
    assert.equal(resolved.status, 200);
    assert.equal((resolved.body as { status: string }).status, 'resolved');
    const created = await api('POST', '/customers', JSON.stringify({ name: 'Wayne Corp', tier: 'pro' }));
    assert.equal(created.status, 201);
    assert.equal((created.body as { id: string }).id, 'cus_0006');
    const read = await api('GET', '/customers/cus_0006');
    assert.equal(read.status, 200);
    assert.equal((read.body as { name: string }).name, 'Wayne Corp');
  });

  it('carries Idempotency-Key as a lower-cased ApiRequest header and replays the first POST', async () => {
    await admin('POST', '/_world/reset');
    const body = JSON.stringify({ name: 'Wayne Corp', tier: 'pro' });
    const headers = { 'Idempotency-Key': 'http-customer-1' };

    const first = await api('POST', '/customers', body, headers);
    const second = await api('POST', '/customers', body, headers);
    assert.equal(first.status, 201);
    assert.deepEqual(second.body, first.body);

    const dump = (await admin('GET', '/_world/state')).body as { tables: { customer: { id: string }[] }; counters: { customer: number } };
    assert.equal(dump.tables.customer.length, 6);
    assert.equal(dump.counters.customer, 6);

    const log = (await admin('GET', '/_world/log')).body as {
      calls: { req: { headers?: Record<string, string> }; writes: unknown[] }[];
    };
    assert.equal(log.calls.length, 2);
    assert.equal(log.calls[0]!.req.headers?.['idempotency-key'], 'http-customer-1');
    assert.equal(log.calls[1]!.req.headers?.['idempotency-key'], 'http-customer-1');
    assert.equal(Object.hasOwn(log.calls[0]!.req.headers ?? {}, 'Idempotency-Key'), false);
    assert.equal(log.calls[0]!.writes.length, 1);
    assert.equal(log.calls[1]!.writes.length, 0);
  });

  it('R1 a delete answers 204 with an empty body', async () => {
    await admin('POST', '/_world/reset');
    const created = await api('POST', '/customers', JSON.stringify({ name: 'Wayne Corp', tier: 'pro' }));
    assert.equal(created.status, 201);
    const del = await api('DELETE', '/customers/cus_0006');
    assert.equal(del.status, 204);
    assert.equal(del.text, '');
  });

  it('R9 a malformed JSON body is 400 in the envelope, never reaches the world, and is logged as a failed call (A-145)', async () => {
    await admin('POST', '/_world/reset');
    const before = (await admin('GET', '/_world/state')).body as { hash: string; now: string; counters: unknown };
    const r = await api('POST', '/customers', '{"name": ');
    assert.equal(r.status, 400);
    const err = (r.body as { error: { code: string; message: string } }).error;
    assert.equal(err.code, 'body.invalid');
    assert.match(err.message, /^Request body is not valid JSON: /);
    const log = (await admin('GET', '/_world/log')).body as { calls: { res: { body: { error: { message: string } } } }[] };
    assert.deepEqual(log.calls.map((c) => ({ ...c, res: { ...c.res, body: { error: { ...c.res.body.error, message: '<parse error>' } } } })), [{
      seq: 1,
      at: '2026-01-05T09:00:00.000Z',
      routeId: null,
      req: { method: 'POST', path: '/customers', query: {}, body: null },
      res: { status: 400, body: { error: { code: 'body.invalid', message: '<parse error>' } } },
      writes: [],
      jobsFired: [],
      jobsFailed: [],
    }]);
    assert.deepEqual((await admin('GET', '/_world/state')).body, before);
    assert.deepEqual(before.counters, { customer: 5, ticket: 12 });
  });

  it('R9 a body over 1 MiB is 413 in the envelope and never parsed, and is logged without its body', async () => {
    await admin('POST', '/_world/reset');
    const r = await api('POST', '/customers', `"${'x'.repeat(1_048_576)}"`);
    assert.equal(r.status, 413);
    assert.deepEqual(r.body, { error: { code: 'body.too_large', message: 'Request body is 1048578 bytes; the most is 1048576' } });
    const log = (await admin('GET', '/_world/log')).body as { calls: unknown[] };
    assert.deepEqual(log.calls, [{
      seq: 1,
      at: '2026-01-05T09:00:00.000Z',
      routeId: null,
      req: { method: 'POST', path: '/customers', query: {}, body: null },
      res: { status: 413, body: { error: { code: 'body.too_large', message: 'Request body is 1048578 bytes; the most is 1048576' } } },
      writes: [],
      jobsFired: [],
      jobsFailed: [],
    }]);
  });

  it('R9 an unknown route is 404 in the envelope', async () => {
    const r = await api('GET', '/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: { code: 'route.not_found', message: 'No route matches GET /nope' } });
  });

  it('R8 /_world routes are 404 on the world port, look like any unknown route, and are logged as the agent\'s failed calls (A-145)', async () => {
    await admin('POST', '/_world/reset');
    assert.equal((await api('POST', '/tickets/tkt_0002/resolve')).status, 200);
    const state = await api('GET', '/_world/state');
    assert.equal(state.status, 404);
    assert.deepEqual(state.body, { error: { code: 'route.not_found', message: 'No route matches GET /_world/state' } });
    const reset = await api('POST', '/_world/reset');
    assert.equal(reset.status, 404);
    assert.deepEqual(reset.body, { error: { code: 'route.not_found', message: 'No route matches POST /_world/reset' } });
    assert.equal((await api('POST', '/%5Fworld/clock', '{"advance":"4h"}')).status, 404);
    assert.equal((await api('GET', '/_world')).status, 404);
    const log = (await admin('GET', '/_world/log')).body as { calls: { seq: number; routeId: string | null; req: { method: string; path: string }; res: { status: number } }[] };
    assert.deepEqual(log.calls.map((c) => [c.seq, c.routeId, c.req.method, c.req.path, c.res.status]), [
      [1, 'resolve_ticket', 'POST', '/tickets/tkt_0002/resolve', 200],
      [2, null, 'GET', '/_world/state', 404],
      [3, null, 'POST', '/_world/reset', 404],
      [4, null, 'POST', '/%5Fworld/clock', 404],
      [5, null, 'GET', '/_world', 404],
    ]);
    assert.equal(((await api('GET', '/tickets/tkt_0002')).body as { status: string }).status, 'resolved');
  });

  it('R10 a method the engine does not route is 405 in the envelope', async () => {
    const r = await api('OPTIONS', '/tickets');
    assert.equal(r.status, 405);
    assert.deepEqual(r.body, {
      error: { code: 'method.not_allowed', message: 'OPTIONS is not supported. Use one of GET, POST, PUT, PATCH, DELETE' },
    });
  });

  it('R10 an unsupported method is logged with its own method string, and nothing else about the world changes', async () => {
    await admin('POST', '/_world/reset');
    const before = (await admin('GET', '/_world/state')).body;
    await api('OPTIONS', '/tickets');
    const log = (await admin('GET', '/_world/log')).body as { calls: { req: { method: string; path: string }; res: { status: number }; routeId: string | null }[] };
    assert.deepEqual(log.calls.map((c) => [c.req.method, c.req.path, c.res.status, c.routeId]), [['OPTIONS', '/tickets', 405, null]]);
    assert.deepEqual((await admin('GET', '/_world/state')).body, before);
  });

  it('R10 GET /openapi.json is documentation, not a world call, and stays out of the log', async () => {
    await admin('POST', '/_world/reset');
    assert.equal((await api('GET', '/openapi.json')).status, 200);
    assert.deepEqual((await admin('GET', '/_world/log')).body, { calls: [] });
  });

  it('R10 a request refused on the admin port is not logged, and the logged refusals keep their sequence with later calls', async () => {
    await admin('POST', '/_world/reset');
    assert.equal((await admin('POST', '/_world/clock', 'four hours')).status, 400);
    await api('POST', '/customers', '{"name": ');
    assert.equal((await api('GET', '/tickets/tkt_0001')).status, 200);
    const log = (await admin('GET', '/_world/log')).body as { calls: { seq: number; at: string; res: { status: number } }[] };
    assert.deepEqual(log.calls.map((c) => [c.seq, c.at, c.res.status]), [[1, '2026-01-05T09:00:00.000Z', 400], [2, '2026-01-05T09:00:00.000Z', 200]]);
  });
});

describe('serve: the world error envelope', () => {
  const { api } = servedWorld(() => {
    const w = minimalWorld();
    w.meta.api.error = { status: '$status', message: '$message', kind: 'error:$code' };
    return w;
  });

  it('R9 malformed JSON and an unknown route use the world template', async () => {
    const bad = await api('PATCH', '/tickets/tkt_0001', '{oops}');
    assert.equal(bad.status, 400);
    const body = bad.body as { status: unknown; kind: unknown };
    assert.equal(body.status, 400);
    assert.equal(body.kind, 'error:body.invalid');
    const missing = await api('GET', '/_world/log');
    assert.deepEqual(missing.body, { status: 404, message: 'No route matches GET /_world/log', kind: 'error:route.not_found' });
  });
});

describe('serve: admin port', () => {
  const { api, admin } = servedWorld();

  it('R3 GET /_world/state is the dump of the seeded world', async () => {
    await admin('POST', '/_world/reset');
    const r = await admin('GET', '/_world/state');
    assert.equal(r.status, 200);
    const dump = r.body as { now: string; tables: Record<string, { id: string }[]>; counters: Record<string, number> };
    assert.equal(dump.now, '2026-01-05T09:00:00.000Z');
    assert.deepEqual(dump.counters, { customer: 5, ticket: 12 });
    assert.deepEqual(dump.tables.customer?.map((c) => c.id), ['cus_0001', 'cus_0002', 'cus_0003', 'cus_0004', 'cus_0005']);
    assert.equal(dump.tables.ticket?.length, 12);
  });

  it('R5 GET /_world/log lists each call with its route, request and status', async () => {
    await admin('POST', '/_world/reset');
    assert.equal((await api('POST', '/tickets/tkt_0002/resolve')).status, 200);
    assert.equal((await api('GET', '/tickets/tkt_9999')).status, 404);
    const r = await admin('GET', '/_world/log');
    assert.equal(r.status, 200);
    const calls = (r.body as { calls: { seq: number; at: string; routeId: string; req: { method: string; path: string }; res: { status: number } }[] }).calls;
    assert.deepEqual(calls.map((c) => [c.seq, c.at, c.routeId, c.req.method, c.req.path, c.res.status]), [
      [1, '2026-01-05T09:00:00.000Z', 'resolve_ticket', 'POST', '/tickets/tkt_0002/resolve', 200],
      [2, '2026-01-05T09:00:01.000Z', 'get_ticket', 'GET', '/tickets/tkt_9999', 404],
    ]);
  });

  it('R7 POST /_world/grade/<task> scores the current state', async () => {
    await admin('POST', '/_world/reset');
    const before = (await admin('POST', '/_world/grade/resolve_password_ticket')).body as { task: string; score: number; state: string };
    assert.deepEqual({ task: before.task, score: before.score }, { task: 'resolve_password_ticket', score: 0 });
    assert.match(before.state, /^[0-9a-f]{32}$/);
    assert.equal((await api('POST', '/tickets/tkt_0002/resolve')).status, 200);
    const r = await admin('POST', '/_world/grade/resolve_password_ticket');
    assert.equal(r.status, 200);
    const after = r.body as { task: string; score: number; state: string };
    assert.deepEqual({ task: after.task, score: after.score }, { task: 'resolve_password_ticket', score: 1 });
    assert.notEqual(after.state, before.state);
    assert.equal(after.state, ((await admin('GET', '/_world/state')).body as { hash: string }).hash);
    // The same writes from the same seed end in the same hash.
    await admin('POST', '/_world/reset');
    assert.equal(((await admin('POST', '/_world/grade/resolve_password_ticket')).body as { state: string }).state, before.state);
    await api('POST', '/tickets/tkt_0002/resolve');
    assert.equal(((await admin('POST', '/_world/grade/resolve_password_ticket')).body as { state: string }).state, after.state);
  });

  it('R7 grading an unknown task is 404 naming the known tasks', async () => {
    const r = await admin('POST', '/_world/grade/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {
      error: { code: 'task.unknown', message: 'No task nope. Known tasks: resolve_password_ticket, resolve_initech_pending, escalate_acme' },
    });
  });

  it('R4 POST /_world/reset restores the seed dump and clears the log', async () => {
    await admin('POST', '/_world/reset');
    const seed = (await admin('GET', '/_world/state')).body;
    assert.equal((await api('POST', '/tickets/tkt_0002/resolve')).status, 200);
    assert.equal((await api('POST', '/customers', JSON.stringify({ name: 'Wayne Corp', tier: 'pro' }))).status, 201);
    assert.equal((await admin('POST', '/_world/clock', '{"advance":"1h"}')).status, 200);
    const reset = await admin('POST', '/_world/reset');
    assert.equal(reset.status, 200);
    assert.deepEqual(reset.body, { ok: true, now: '2026-01-05T09:00:00.000Z' });
    assert.deepEqual((await admin('GET', '/_world/state')).body, seed);
    assert.deepEqual((await admin('GET', '/_world/log')).body, { calls: [] });
    assert.equal(((await api('GET', '/tickets/tkt_0002')).body as { status: string }).status, 'pending');
  });

  it('R6 POST /_world/clock moves engine time and fires due jobs', async () => {
    await admin('POST', '/_world/reset');
    const r = await admin('POST', '/_world/clock', '{"advance":"4h"}');
    assert.equal(r.status, 200);
    const body = r.body as { now: string; jobsFired: string[]; jobsFailed: unknown[] };
    assert.equal(body.now, '2026-01-05T13:00:00.000Z');
    assert.equal(body.jobsFired.length, 16);
    assert.deepEqual([...new Set(body.jobsFired)], ['escalate_overdue']);
    assert.deepEqual(body.jobsFailed, []);
    // tkt_0005 was due at 11:00, so the job made it urgent.
    assert.equal(((await api('GET', '/tickets/tkt_0005')).body as { priority: string }).priority, 'urgent');
    // That successful GET is one more 1s tick.
    assert.equal(((await admin('GET', '/_world/state')).body as { now: string }).now, '2026-01-05T13:00:01.000Z');
  });

  it('R6 a bad clock body or duration is 400 and moves nothing', async () => {
    await admin('POST', '/_world/reset');
    const bad = await admin('POST', '/_world/clock', '{"advance":"4x"}');
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { error: { code: 'clock.invalid', message: 'Invalid duration "4x": expected whole numbers with units in the order d, h, m, s, each at most once, such as 15m, 4h or 1d12h' } });
    const missing = await admin('POST', '/_world/clock', '{}');
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: { code: 'clock.invalid', message: 'Body must be {"advance": "<duration>"}, such as {"advance":"4h"}' } });
    const notJson = await admin('POST', '/_world/clock', 'four hours');
    assert.equal(notJson.status, 400);
    assert.equal((notJson.body as { error: { code: string } }).error.code, 'body.invalid');
    assert.equal(((await admin('GET', '/_world/state')).body as { now: string }).now, '2026-01-05T09:00:00.000Z');
  });

  it('R3 a wrong method, an unknown admin route and world routes are refused on the admin port', async () => {
    const wrong = await admin('GET', '/_world/reset');
    assert.equal(wrong.status, 405);
    assert.deepEqual(wrong.body, { error: { code: 'method.not_allowed', message: 'GET /_world/reset is not allowed. Allowed: POST' } });
    const unknown = await admin('GET', '/_world/nope');
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.body, { error: { code: 'route.not_found', message: 'No admin route GET /_world/nope. Admin routes: GET /_world/state, POST /_world/reset, GET /_world/log, GET /_world/openapi, POST /_world/clock, POST /_world/grade/<task>' } });
    assert.equal((await admin('GET', '/tickets')).status, 404);
    assert.equal((await admin('GET', '/_world/grade')).status, 404);
  });

  it('R5 admin calls are not in the call log', async () => {
    await admin('POST', '/_world/reset');
    await admin('GET', '/_world/state');
    await admin('POST', '/_world/grade/resolve_password_ticket');
    assert.deepEqual((await admin('GET', '/_world/log')).body, { calls: [] });
  });
});

describe('serve: admin state digests (YOS-183)', () => {
  const { api, admin } = servedWorld();

  it('R1 GET /_world/state answers with the core 128-bit hash and the shell sha-256 digest of the seed dump', async () => {
    await admin('POST', '/_world/reset');
    const r = await admin('GET', '/_world/state');
    assert.equal(r.status, 200);
    const dump = r.body as { hash: string; sha256: string };
    // The core's own hash: the deterministic, non-cryptographic 128-bit stateHash, computed
    // without node:crypto because engine core is pure. 32 hex.
    assert.equal(dump.hash, 'da1f68889b0ebbc7a32f6d72c97f496f');
    // The shell's digest of the same dump: sha-256 of canonicalJson(dump), prefixed with its
    // algorithm. Its hex is the dataset layer's hashState of the same dump (YOS-91).
    assert.equal(dump.sha256, 'sha-256:cd46adbbc9b34c6e634458589851d308fa8979928ed7f0c34d60ce02a77a57fc');
    assert.match(dump.hash, /^[0-9a-f]{32}$/);
    assert.match(dump.sha256, /^sha-256:[0-9a-f]{64}$/);
  });

  it('R2 two resets give the same dump, so the same sha256', async () => {
    await admin('POST', '/_world/reset');
    const first = await admin('GET', '/_world/state');
    await admin('POST', '/_world/reset');
    const second = await admin('GET', '/_world/state');
    // The whole body, sha256 included: the seed dump is identical after each reset.
    assert.deepEqual(second.body, first.body);
  });

  it('R3 a write changes the sha256 with the state', async () => {
    await admin('POST', '/_world/reset');
    const before = (await admin('GET', '/_world/state')).body as { hash: string; sha256: string };
    assert.equal((await api('POST', '/tickets/tkt_0002/resolve')).status, 200);
    const after = (await admin('GET', '/_world/state')).body as { hash: string; sha256: string };
    assert.notEqual(after.sha256, before.sha256);
    assert.notEqual(after.hash, before.hash);
  });

  it('R4 the world port still 404s /_world/*, so the digest stays admin-only', async () => {
    const state = await api('GET', '/_world/state');
    assert.equal(state.status, 404);
    assert.deepEqual(state.body, { error: { code: 'route.not_found', message: 'No route matches GET /_world/state' } });
    const reset = await api('POST', '/_world/reset');
    assert.equal(reset.status, 404);
    assert.deepEqual(reset.body, { error: { code: 'route.not_found', message: 'No route matches POST /_world/reset' } });
  });
});

describe('serve: admin clock at the Date limit', () => {
  // Without jobs, since a job-bearing world refuses a 97-million-day window (dueJobs firing cap).
  const { admin } = servedWorld(() => ({ ...minimalWorld(), jobs: {} }));

  it('a refused advance is 400 clock.invalid and leaves the clock, state and log unchanged', async () => {
    await admin('POST', '/_world/reset');
    assert.equal((await admin('POST', '/_world/clock', '{"advance":"97000000d"}')).status, 200);
    const near = await admin('POST', '/_world/clock', '{"advance":"2000000d"}');
    assert.equal(near.status, 200);
    assert.equal((near.body as { now: string }).now, '+273078-10-22T09:00:00.000Z');
    const before = (await admin('GET', '/_world/state')).body;
    const refused = await admin('POST', '/_world/clock', '{"advance":"1500000d"}');
    assert.equal(refused.status, 400);
    assert.equal((refused.body as { error: { code: string } }).error.code, 'clock.invalid');
    const after = await admin('GET', '/_world/state');
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, before);
    assert.equal((after.body as { now: string }).now, '+273078-10-22T09:00:00.000Z');
    await admin('POST', '/_world/reset');
  });
});

describe('serve: ports and lifecycle', () => {
  it('R2 the admin port defaults to the world port plus 1', async () => {
    const server = await serve(checked(minimalWorld()), { port: await quietPort(2) });
    try {
      assert.equal(server.adminPort, server.port + 1);
      assert.equal(server.url, `http://127.0.0.1:${server.port}`);
      assert.equal(server.adminUrl, `http://127.0.0.1:${server.port + 1}`);
      assert.equal((await send(server.adminUrl, 'GET', '/_world/state')).status, 200);
    } finally {
      await server.close();
    }
  });

  it('R2 an explicit adminPort wins, and port 0 picks free ports', async () => {
    const adminPort = await quietPort();
    const server = await serve(checked(minimalWorld()), { port: 0, adminPort });
    try {
      assert.equal(server.adminPort, adminPort);
      assert.notEqual(server.port, 0);
      assert.notEqual(server.port, adminPort);
    } finally {
      await server.close();
    }
  });

  it('R1 a port in use rejects with EADDRINUSE and leaves nothing listening', async () => {
    const first = await serve(checked(minimalWorld()), { port: 0 });
    try {
      await assert.rejects(serve(checked(minimalWorld()), { port: 0, adminPort: first.adminPort }), { code: 'EADDRINUSE' });
      await assert.rejects(serve(checked(minimalWorld()), { port: first.port, adminPort: 0 }), { code: 'EADDRINUSE' });
    } finally {
      await first.close();
    }
  });

  it('R1 an out-of-range port is a RangeError', async () => {
    await assert.rejects(serve(checked(minimalWorld()), { port: 65535 }), {
      name: 'RangeError',
      message: 'admin port 65536 is not a port from 0 to 65535. Pass adminPort.',
    });
    await assert.rejects(serve(checked(minimalWorld()), { port: -1 }), { name: 'RangeError', message: 'port -1 is not a port from 0 to 65535' });
  });

  it('R1 close() stops both ports and can be called twice', async () => {
    const server = await serve(checked(minimalWorld()), { port: 0 });
    assert.equal((await send(server.url, 'GET', '/tickets')).status, 200);
    await server.close();
    await server.close();
    await assert.rejects(fetch(`${server.url}/tickets`));
    await assert.rejects(fetch(`${server.adminUrl}/_world/state`));
  });

  it('R1 accepts only a CheckedWorld (checked by the compiler)', () => {
    const unchecked = (): unknown =>
      // @ts-expect-error a World that never went through checkWorld cannot be served
      serve(minimalWorld(), { port: 0 });
    assert.equal(typeof unchecked, 'function');
  });
});

const externalIPv4 = Object.values(networkInterfaces()).flat().find((i) => i !== undefined && i.family === 'IPv4' && !i.internal)?.address;

function connectCode(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, host);
    sock.once('connect', () => {
      sock.destroy();
      resolve('connected');
    });
    sock.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
  });
}

describe('serve: bind hosts', () => {
  const start = async (opts: { host?: string; adminHost?: string }): Promise<WorldServer> => serve(checked(minimalWorld()), { port: 0, ...opts });

  it('R12 the default binds both ports to 127.0.0.1', async () => {
    const server = await start({});
    try {
      assert.equal(server.url, `http://127.0.0.1:${server.port}`);
      assert.equal(server.adminUrl, `http://127.0.0.1:${server.adminPort}`);
      assert.equal(await connectCode('127.0.0.1', server.port), 'connected');
      assert.equal(await connectCode('127.0.0.1', server.adminPort), 'connected');
    } finally {
      await server.close();
    }
  });

  it('R12 a public host leaves the admin port on 127.0.0.1', async (t) => {
    const server = await start({ host: '0.0.0.0' });
    try {
      assert.equal(server.adminUrl, `http://127.0.0.1:${server.adminPort}`);
      assert.equal((await send(`http://127.0.0.1:${server.port}`, 'GET', '/openapi.json')).status, 200);
      assert.equal((await send(server.adminUrl, 'GET', '/_world/state')).status, 200);
      if (externalIPv4 === undefined) return t.diagnostic('no non-loopback IPv4 address on this machine; skipped the external bind assertions');
      assert.equal(await connectCode(externalIPv4, server.port), 'connected');
      assert.equal(await connectCode(externalIPv4, server.adminPort), 'ECONNREFUSED');
    } finally {
      await server.close();
    }
  });

  it('R12 adminHost 0.0.0.0 publishes the admin port too', async (t) => {
    const server = await start({ host: '0.0.0.0', adminHost: '0.0.0.0' });
    try {
      assert.equal(server.adminUrl, `http://0.0.0.0:${server.adminPort}`);
      if (externalIPv4 === undefined) return t.diagnostic('no non-loopback IPv4 address on this machine; skipped the external bind assertions');
      assert.equal(await connectCode(externalIPv4, server.adminPort), 'connected');
    } finally {
      await server.close();
    }
  });
});

describe('serve: public IPv6 world bind', () => {
  it('keeps admin on IPv4 loopback when the public world binds all interfaces', async () => {
    const server = await serve(checked(minimalWorld()), { port: 0, host: '::' });
    try {
      assert.equal((await send(`http://[::1]:${server.port}`, 'GET', '/openapi.json')).status, 200);
      assert.equal((await send(`http://[::1]:${server.port}`, 'GET', '/_world/state')).status, 404);
      await assert.rejects(fetch(`http://[::1]:${server.adminPort}/_world/state`));
      assert.equal((await send(server.adminUrl, 'GET', '/_world/state')).status, 200);
      assert.equal(server.adminUrl, `http://127.0.0.1:${server.adminPort}`);
    } finally {
      await server.close();
    }
  });
});

describe('a request whose Content-Length is shorter than the bytes sent', () => {
  /** A customer needs no field, so `{}` is a valid create: the first 8 bytes of the body are a request that would succeed. */
  const permissive = (): World => {
    const w = structuredClone(minimalWorld()) as unknown as { entities: { customer: { fields: Record<string, Record<string, unknown>> } } };
    for (const f of Object.values(w.entities.customer.fields)) {
      f['required'] = false;
      delete f['unique'];
    }
    return w as unknown as World;
  };
  const w = servedWorld(permissive);

  it('commits only a create that the client receives as accepted before a trailing parse error', async () => {
    const before = await w.admin('GET', '/_world/state');
    const rows = (s: Reply): number => Object.keys((s.body as { tables: { customer: Record<string, unknown> } }).tables.customer).length;
    const raw = await new Promise<string>((resolve, reject) => {
      const port = new URL(w.srv().url).port;
      const sock = connect(Number(port), '127.0.0.1');
      let data = '';
      sock.on('data', (d) => (data += String(d)));
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
      sock.write(`POST /customers HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 8\r\n\r\n${'{}'.padEnd(64, ' ')}`);
      setTimeout(() => sock.destroy(), 1500);
    });
    const statuses = [...raw.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => Number(m[1]));
    const after = await w.admin('GET', '/_world/state');
    if (statuses[0] === 400) {
      assert.deepEqual(statuses, [400]);
      assert.equal(rows(after), rows(before));
      assert.deepEqual(after.body, before.body);
      return;
    }
    assert.deepEqual(statuses, [201, 400]);
    assert.equal(rows(after), rows(before) + 1);
    const bodyAt = raw.indexOf('\r\n\r\n') + 4;
    const length = /content-length: (\d+)/i.exec(raw.slice(0, bodyAt));
    assert.ok(length);
    const accepted = JSON.parse(raw.slice(bodyAt, bodyAt + Number(length[1]))) as Record<string, unknown>;
    assert.deepEqual(accepted, { id: 'cus_0006', updated_at: '2026-01-05T09:00:00.000Z', created_at: '2026-01-05T09:00:00.000Z' });
    const read = await w.api('GET', '/customers/cus_0006');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, accepted);
    const beforeTables = (before.body as { tables: Record<string, unknown[]> }).tables;
    const afterTables = (after.body as { tables: Record<string, unknown[]> }).tables;
    assert.deepEqual(afterTables, { ...beforeTables, customer: [...(beforeTables['customer'] ?? []), accepted] });
    assert.deepEqual((after.body as { counters: Record<string, number> }).counters, { ...(before.body as { counters: Record<string, number> }).counters, customer: 6 });
    assert.equal((before.body as { now: string }).now, '2026-01-05T09:00:00.000Z');
    assert.equal((after.body as { now: string }).now, '2026-01-05T09:00:01.000Z');
  });
});

describe('a JSON body nested past 64 levels (A-245)', () => {
  const { api, admin } = servedWorld();
  const deep = (n: number): string => '['.repeat(n) + ']'.repeat(n);

  it('is refused 400 body.invalid in milliseconds, before any parse or write', async () => {
    await admin('POST', '/_world/reset');
    const before = await admin('GET', '/_world/state');
    for (const body of [deep(100_000), '{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000), `{"subject":${deep(65)}}`]) {
      const t0 = performance.now();
      const r = await api('POST', '/tickets', body, { 'content-type': 'application/json' });
      assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: { code: 'body.invalid', message: 'Request body nests deeper than 64 levels' } });
    }
    assert.deepEqual((await admin('GET', '/_world/state')).body, before.body);
  });

  it('counts brackets only outside strings, and lets depth 64 through to the API', async () => {
    const quoted = await api('POST', '/tickets', JSON.stringify({ subject: '['.repeat(200) }), { 'content-type': 'application/json' });
    assert.notEqual((quoted.body as { error?: { message: string } }).error?.message, 'Request body nests deeper than 64 levels');
    const at64 = await api('POST', '/tickets', `{"subject":${deep(63)}}`, { 'content-type': 'application/json' });
    assert.equal(at64.status, 422);
  });
});
