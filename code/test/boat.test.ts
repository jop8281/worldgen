/**
 * boat.dev support: the SDK adapter (src/boat/client.ts) through its fetch seam, and the Boat
 * SandboxBackend (src/sandboxes/boat.ts) through a fake BoatClient. Nothing here reaches
 * boat.dev or reads BOAT_API_KEY from the process: globalThis.fetch is replaced for the whole
 * file and must stay uncalled.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  BoatError,
  boatClient,
  boatClientFromEnv,
  boatKey,
  boatUsageWindow,
  type BoatClient,
  type BoatClientOptions,
  type ExecResult,
  type FetchFn,
} from '../src/boat/client.ts';
import { PendingSandboxError, SandboxError, SandboxStartError } from '../src/sandboxes/backend.ts';
import { BOAT_WORKDIR, TIMED_OUT_EXIT, boatBackend, boatTypeOf } from '../src/sandboxes/boat.ts';
const KEY = 'boat-test-key-0001';
const BASE = 'https://boat.test/api/v1';

let globalFetchCalls = 0;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async () => {
    globalFetchCalls += 1;
    throw new Error('test/boat.test.ts must not touch the network');
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(globalFetchCalls, 0);
});

// ---------------------------------------------------------------------------------------
// client.ts through the fetch seam

type Sent = { method: string; url: string; auth: string | null; body: unknown };
type Reply = { status: number; json: unknown } | { error: Error };

/** A fetch that records each request and answers from `replies` in order. */
function seam(replies: Reply[], sent: Sent[]): NonNullable<BoatClientOptions['fetch']> {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    sent.push({
      method: init?.method ?? 'GET',
      url: String(input),
      auth: headers.get('authorization'),
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('fake fetch: no reply left');
    if ('error' in reply) throw reply.error;
    return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
}

const sandboxJson = (state: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'sb_1', name: 'sb', state, desktopAvailable: false, snapshotAvailable: false, ...extra });
const createdReply: Reply = { status: 201, json: { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: 600, sandbox: sandboxJson('provisioning') } };
const stateReply = (state: string, extra: Record<string, unknown> = {}): Reply =>
  ({ status: 200, json: { ok: true, type: 'sandbox', sandbox: sandboxJson(state, extra) } });
const finishedReply: Reply = { status: 200, json: { ok: true, type: 'command.finished', success: true, exitCode: 0, stdout: 'v22.1.0\n', stderr: '', timedOut: false } };
const startedReply: Reply = { status: 200, json: { ok: true, type: 'command.started', success: true, processId: 7, pid: 1234, command: 'npm run x', startedAt: '2026-10-06T00:00:00Z' } };
const writtenReply: Reply = { status: 200, json: { ok: true, type: 'file.written', success: true, path: '/tmp/a.txt', encoding: 'base64', size: 2 } };
const hostReply: Reply = { status: 200, json: { ok: true, type: 'host', success: true, port: 4000, url: 'https://sb-1-4000.boat.test', access: 'public' } };
const stopReply: Reply = { status: 200, json: { ok: true, type: 'sandbox.stopped', id: 'sb_1', status: 'stopped' } };

function client(replies: Reply[], sent: Sent[], extra: Partial<BoatClientOptions> = {}): ReturnType<typeof boatClient> {
  return boatClient({ apiKey: KEY, org: 'org_test', basePath: BASE, fetch: seam(replies, sent), pollMs: 5, sleep: async () => {}, ...extra });
}

async function rejectsWith(p: Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof BoatError, `expected BoatError, got ${String(e)}`);
    assert.equal(e.message, message);
    return true;
  });
}

describe('boatClient: each method is one SDK call with bearer auth', () => {
  it('retains the provider creation timestamp for idempotent recovery', async () => {
    const sent: Sent[] = [];
    const reply: Reply = { status: 201, json: { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: 600, sandbox: sandboxJson('provisioning', { createdAt: '2026-10-06T09:00:00Z' }) } };
    assert.deepEqual(await client([reply], sent).create({ ttlSeconds: 600 }), { sandboxId: 'sb_1', startedAt: 1791277200000 });
  });

  it('sends the durable create identity in the provider idempotency header', async () => {
    const sent: Sent[] = [];
    const fetch = seam([createdReply], sent);
    const headers: (string | null)[] = [];
    const c = boatClient({ apiKey: KEY, org: 'org_test', basePath: BASE, fetch: async (input, init) => {
      headers.push(new Headers(init?.headers).get('idempotency-key'));
      return fetch(input, init);
    } });
    await c.create({ ttlSeconds: 600, idempotencyKey: '6d7d525d-28de-430e-ae91-b2171cf99cf1' });
    assert.deepEqual(headers, ['6d7d525d-28de-430e-ae91-b2171cf99cf1']);
    assert.deepEqual(sent[0]?.body, { noEnv: true, ttlSeconds: 600 });
  });

  it('create posts the ttl to /sandboxes and returns the sandbox id', async () => {
    const sent: Sent[] = [];
    const res = await client([createdReply], sent).create({ ttlSeconds: 600 });
    assert.deepEqual(res, { sandboxId: 'sb_1' });
    assert.deepEqual(sent, [{ method: 'POST', url: 'https://boat.test/api/v1/sandboxes?org=org_test', auth: 'Bearer boat-test-key-0001', body: { noEnv: true, ttlSeconds: 600 } }]);
  });

  it('create passes env and setupScript when given', async () => {
    const sent: Sent[] = [];
    await client([createdReply], sent).create({ ttlSeconds: 60, env: { A: '1' }, setupScript: 'echo hi' });
    assert.deepEqual(sent[0]?.body, { noEnv: true, ttlSeconds: 60, env: { A: '1' }, setupScript: 'echo hi' });
  });

  it('exec posts a synchronous command and returns its result', async () => {
    const sent: Sent[] = [];
    const res = await client([finishedReply], sent).exec('sb_1', 'node -v', { cwd: '/tmp', timeoutSeconds: 30 });
    assert.deepEqual(res, { exitCode: 0, stdout: 'v22.1.0\n', stderr: '', timedOut: false });
    assert.deepEqual(sent, [{ method: 'POST', url: 'https://boat.test/api/v1/sandboxes/sb_1/commands', auth: 'Bearer boat-test-key-0001', body: { command: 'node -v', cwd: '/tmp', timeoutSeconds: 30 } }]);
  });

  it('start posts a detached command and returns its process id', async () => {
    const sent: Sent[] = [];
    const res = await client([startedReply], sent).start('sb_1', 'npm run x', { cwd: '/tmp' });
    assert.deepEqual(res, { processId: 7 });
    assert.deepEqual(sent[0]?.body, { command: 'npm run x', cwd: '/tmp', detached: true });
  });

  it('writeFile puts the content with its encoding', async () => {
    const sent: Sent[] = [];
    await client([writtenReply], sent).writeFile('sb_1', { path: '/tmp/a.txt', content: 'aGk=', encoding: 'base64' });
    assert.deepEqual(sent, [{ method: 'PUT', url: 'https://boat.test/api/v1/sandboxes/sb_1/files', auth: 'Bearer boat-test-key-0001', body: { path: '/tmp/a.txt', content: 'aGk=', encoding: 'base64' } }]);
  });

  it('expose makes the port public and returns its url', async () => {
    const sent: Sent[] = [];
    const res = await client([hostReply], sent).expose('sb_1', 4000, true);
    assert.deepEqual(res, { url: 'https://sb-1-4000.boat.test' });
    assert.deepEqual(sent, [{ method: 'POST', url: 'https://boat.test/api/v1/sandboxes/sb_1/host', auth: 'Bearer boat-test-key-0001', body: { port: 4000, public: true } }]);
  });

  it('create passes the machine type', async () => {
    const sent: Sent[] = [];
    await client([createdReply], sent).create({ type: 'small', ttlSeconds: 60 });
    assert.deepEqual(sent[0]?.body, { noEnv: true, type: 'small', ttlSeconds: 60 });
  });

  it('expose with isPublic false asks for a private port', async () => {
    const sent: Sent[] = [];
    await client([hostReply], sent).expose('sb_1', 4000, false);
    assert.deepEqual(sent[0]?.body, { port: 4000, public: false });
  });

  it('stop posts to /stop', async () => {
    const sent: Sent[] = [];
    await client([stopReply], sent).stop('sb_1');
    assert.deepEqual(sent, [{ method: 'POST', url: 'https://boat.test/api/v1/sandboxes/sb_1/stop', auth: 'Bearer boat-test-key-0001', body: undefined }]);
  });
});

describe('boatClient.waitReady', () => {
  it('polls GET /sandboxes/<id> until the state is ready, sleeping pollMs between polls', async () => {
    const sent: Sent[] = [];
    const sleeps: number[] = [];
    const c = client([stateReply('provisioning'), stateReply('cloning'), stateReply('ready')], sent, { sleep: async (ms) => { sleeps.push(ms); } });
    await c.waitReady('sb_1');
    assert.deepEqual(sent.map((s) => `${s.method} ${s.url}`), [
      'GET https://boat.test/api/v1/sandboxes/sb_1',
      'GET https://boat.test/api/v1/sandboxes/sb_1',
      'GET https://boat.test/api/v1/sandboxes/sb_1',
    ]);
    assert.deepEqual(sleeps, [5, 5]);
  });

  it('accepts idle and running as ready', async () => {
    await client([stateReply('idle')], []).waitReady('sb_1');
    await client([stateReply('running')], []).waitReady('sb_1');
  });

  it('fails at once on a terminal state, with the sandbox error', async () => {
    await rejectsWith(client([stateReply('error', { error: 'boot failed' })], []).waitReady('sb_1'), 'sandbox sb_1 entered state error: boot failed');
    await rejectsWith(client([stateReply('cancelled')], []).waitReady('sb_1'), 'sandbox sb_1 entered state cancelled');
  });

  it('fails after readyTimeoutMs of sleeping without a ready state', async () => {
    const sent: Sent[] = [];
    const c = client([stateReply('provisioning'), stateReply('provisioning'), stateReply('provisioning')], sent, { readyTimeoutMs: 10 });
    await rejectsWith(c.waitReady('sb_1'), 'sandbox sb_1 not ready after 10 ms (state provisioning)');
    assert.equal(sent.length, 3);
  });
});

describe('boatClient.waitStopped', () => {
  it('polls until the sandbox is archived', async () => {
    const sent: Sent[] = [];
    const sleeps: number[] = [];
    await client([stateReply('archiving'), stateReply('archived')], sent, { sleep: async (ms) => void sleeps.push(ms), pollMs: 10 }).waitStopped('sb_1');
    assert.equal(sent.length, 2);
    assert.deepEqual(sleeps, [10]);
  });

  it('treats a 404 as already removed', async () => {
    const sent: Sent[] = [];
    await client([{ status: 404, json: { error: 'not found' } }], sent).waitStopped('sb_1');
    assert.equal(sent.length, 1);
  });

  it('fails when the sandbox ends in error, and when it never stops', async () => {
    await assert.rejects(client([stateReply('error')], []).waitStopped('sb_1'), /error while stopping/);
    const stuck = client([stateReply('running'), stateReply('running'), stateReply('running')], [], { sleep: async () => {}, pollMs: 100, readyTimeoutMs: 200 });
    await assert.rejects(stuck.waitStopped('sb_1'), /not stopped after 200 ms \(state running\)/);
  });
});

describe('boatClient errors', () => {
  it('turns an HTTP error into a BoatError with status and body, and scrubs the key', async () => {
    const reply: Reply = { status: 409, json: { error: 'sandbox_not_ready', message: `no ${KEY}` } };
    await rejectsWith(client([reply], []).exec('sb_1', 'ls'), 'boat.dev command failed: HTTP 409 {"error":"sandbox_not_ready","message":"no [redacted]"}');
    await assert.rejects(client([{ status: 403, json: { code: 'not_org_member' } }], []).create({ ttlSeconds: 60 }), (e: unknown) => e instanceof BoatError && e.status === 403);
  });

  it('turns a network failure into a BoatError naming the cause', async () => {
    await rejectsWith(client([{ error: new TypeError('fetch failed') }], []).create({ ttlSeconds: 60 }), 'boat.dev create failed: fetch failed');
    const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND boat.dev'), { code: 'ENOTFOUND' }) });
    await rejectsWith(client([{ error: dns }], []).create({ ttlSeconds: 60 }), 'boat.dev create failed: fetch failed (ENOTFOUND)');
  });

  it('rejects a command reply of the wrong kind', async () => {
    await rejectsWith(client([startedReply], []).exec('sb_1', 'ls'), 'boat.dev command returned command.started, expected command.finished');
    await rejectsWith(client([finishedReply], []).start('sb_1', 'ls'), 'boat.dev command returned command.finished, expected command.started');
  });

  it('rejects a host reply without a url', async () => {
    const reply: Reply = { status: 200, json: { ok: true, type: 'host', success: true, port: 4000 } };
    await rejectsWith(client([reply], []).expose('sb_1', 4000, true), 'boat.dev hostPort returned no url for port 4000');
  });
});

describe('boatClientFromEnv', () => {
  const missing = 'BOAT_API_KEY is not set: create a key at https://boat.dev/dashboard?tab=api-keys and export it';

  it('throws the one-line missing-key error when BOAT_API_KEY is unset or blank', () => {
    for (const env of [{}, { BOAT_API_KEY: '' }, { BOAT_API_KEY: '   ' }, { BOAT_BASE_URL: BASE }]) {
      assert.throws(() => boatClientFromEnv(env), (e: unknown) => e instanceof BoatError && e.message === missing);
    }
  });

  it('uses BOAT_BASE_URL when set', async () => {
    const sent: Sent[] = [];
    await boatClientFromEnv({ BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', BOAT_BASE_URL: 'https://boat.dev/api/v2' }, { fetch: seam([createdReply], sent) }).create({ ttlSeconds: 60 });
    assert.equal(sent[0]?.url, 'https://boat.dev/api/v2/sandboxes?org=org_test');
    assert.equal(sent[0]?.auth, 'Bearer boat-test-key-0001');
  });

  it('pins WORLDGEN_BOAT_ORG on every request and refuses to create without it (A-247)', async () => {
    const sent: Sent[] = [];
    const headers: (string | null)[] = [];
    const fetchWith = (inner: FetchFn): FetchFn => async (input, init) => { headers.push(new Headers(init?.headers).get('x-boat-org')); return inner(input, init); };
    await boatClientFromEnv({ BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test' }, { fetch: fetchWith(seam([createdReply], sent)) }).create({ ttlSeconds: 60 });
    assert.deepEqual([sent[0]?.url, headers], ['https://boat.dev/api/v1/sandboxes?org=org_test', ['org_test']]);
    await assert.rejects(boatClientFromEnv({ BOAT_API_KEY: KEY }, { fetch: seam([createdReply], []) }).create({ ttlSeconds: 60 }), (e: unknown) =>
      e instanceof Error && e.message.startsWith('WORLDGEN_BOAT_ORG is not set: Boat provisioning needs the one organization (wallet) this machine bills to'));
    assert.throws(() => boatClientFromEnv({ BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org with spaces' }), /WORLDGEN_BOAT_ORG must be a Boat organization id/);
  });

  it('defaults to https://boat.dev/api/v1', async () => {
    const sent: Sent[] = [];
    await boatClientFromEnv({ BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test' }, { fetch: seam([createdReply], sent) }).create({ ttlSeconds: 60 });
    assert.equal(sent[0]?.url, 'https://boat.dev/api/v1/sandboxes?org=org_test');
  });
});

describe('Boat cleanup after removal', () => {
  it('allows repeated backend cleanup when stop and GET report the sandbox removed', async () => {
    const sent: Sent[] = [];
    const removed: Reply = { status: 404, json: { error: 'Sandbox not found' } };
    const backend = boatBackend({ client: client([stopReply, stateReply('archived'), removed, removed], sent) });
    await backend.down('sb_1');
    await backend.down('sb_1');
    assert.deepEqual(sent.map((request) => request.method), ['POST', 'GET', 'POST', 'GET']);
  });

  it('does not confuse a server error containing HTTP 404 with a removed sandbox', async () => {
    await rejectsWith(
      client([{ status: 500, json: { error: 'upstream HTTP 404' } }], []).waitStopped('sb_1'),
      'boat.dev get failed: HTTP 500 {"error":"upstream HTTP 404"}',
    );
  });

  it('verifies archived state after Boat rejects repeated stop with HTTP 400', async () => {
    const sent: Sent[] = [];
    const archived: Reply = { status: 400, json: { code: 'stop_failed', message: 'Sandbox is archived' } };
    const backend = boatBackend({ client: client([stopReply, stateReply('archived'), archived, stateReply('archived'), stateReply('archived')], sent) });
    await backend.down('sb_1');
    await backend.down('sb_1');
    assert.deepEqual(sent.map((request) => request.method), ['POST', 'GET', 'POST', 'GET', 'GET']);
  });

  it('does not accept a rejected stop while GET still reports running', async () => {
    await rejectsWith(
      client([{ status: 400, json: { error: 'cannot stop' } }, stateReply('running')], []).stop('sb_1'),
      'boat.dev stop failed: HTTP 400 {"error":"cannot stop"}',
    );
  });

  it('preserves authorization and server failures from stop', async () => {
    for (const status of [401, 403, 500]) {
      await rejectsWith(
        client([{ status, json: { error: 'HTTP 404 is only body text' } }], []).stop('sb_1'),
        `boat.dev stop failed: HTTP ${status} {"error":"HTTP 404 is only body text"}`,
      );
    }
  });
});

describe('boatKey', () => {
  it('reads BOAT_API_KEY from the given environment and never from a file', () => {
    assert.equal(boatKey({ BOAT_API_KEY: ' k-1 ' }), 'k-1');
    assert.throws(() => boatKey({}), BoatError);
  });
});

// ---------------------------------------------------------------------------------------
// the Boat SandboxBackend through a fake BoatClient

type Call = readonly unknown[];
type FakeScript = {
  readonly exec?: (command: string) => ExecResult;
  /** The HTTP status create fails with, or 0 for a failure with no answer. */
  readonly createFails?: number;
  readonly writeFails?: boolean;
  readonly waitStoppedFails?: boolean;
  readonly stopFails?: boolean;
};

const done = (exitCode: number, stdout = '', stderr = ''): ExecResult => ({ exitCode, stdout, stderr, timedOut: false });

function fakeBoat(script: FakeScript = {}): { client: BoatClient; calls: Call[] } {
  const calls: Call[] = [];
  const log = <T>(name: string, args: Call, value: T): T => {
    calls.push([name, ...args]);
    return value;
  };
  const client: BoatClient = {
    async create(o) {
      if (script.createFails !== undefined) throw new BoatError(`boat.dev create failed: HTTP ${script.createFails}`, script.createFails === 0 ? undefined : script.createFails);
      return log('create', [o], { sandboxId: 'sb_1' });
    },
    async waitReady(id) {
      log('waitReady', [id], undefined);
    },
    async exec(id, command, o) {
      return log('exec', [id, command, o], (script.exec ?? ((c) => (c === 'node -v' ? done(0, 'v22.1.0\n') : done(0))))(command));
    },
    async start(id, command, o) {
      return log('start', [id, command, o], { processId: 7 });
    },
    async writeFile(id, f) {
      if (script.writeFails) throw new BoatError('boat.dev writeFile failed: HTTP 500');
      log('writeFile', [id, f.path, f.encoding, f.content], undefined);
    },
    async expose(id, port, isPublic) {
      return log('expose', [id, port, isPublic], { url: `https://sb-1-${port}.boat.test` });
    },
    async stop(id) {
      if (script.stopFails) throw new BoatError('boat.dev stop failed: HTTP 500');
      log('stop', [id], undefined);
    },
    async waitStopped(id) {
      if (script.waitStoppedFails) throw new BoatError('sandbox sb_1 not stopped after 300000 ms (state running)');
      log('waitStopped', [id], undefined);
    },
  };
  return { client, calls };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('boatBackend.up', () => {
  it('creates a small VM, waits, makes the directories, and uploads base64 under the workdir, in that order', async () => {
    const { client, calls } = fakeBoat();
    const sb = await boatBackend({ client }).up([{ path: 'code/src/a.ts', data: bytes('hi') }, { path: 'world/world.yaml', data: bytes('x') }], { name: 'demo-1' });
    assert.deepEqual(sb, { id: 'sb_1', workdir: '/tmp/worldgen' });
    assert.deepEqual(calls.map((c) => c[0]), ['create', 'waitReady', 'exec', 'exec', 'writeFile', 'writeFile']);
    assert.deepEqual(calls[0], ['create', { type: 'small', ttlSeconds: 1800 }]);
    assert.deepEqual(calls[2], ['exec', 'sb_1', 'node -v', {}]);
    assert.deepEqual(calls[3], ['exec', 'sb_1', 'mkdir -p /tmp/worldgen /tmp/worldgen/code /tmp/worldgen/code/src /tmp/worldgen/world', {}]);
    assert.deepEqual(calls[4], ['writeFile', 'sb_1', '/tmp/worldgen/code/src/a.ts', 'base64', 'aGk=']);
  });

  it('maps sizes to boat types and refuses a size boat does not sell', async () => {
    assert.equal(boatTypeOf({ cpus: 2, memoryGi: 4 }), 'small');
    assert.equal(boatTypeOf({ cpus: 8, memoryGi: 16 }), 'large');
    assert.throws(() => boatTypeOf({ cpus: 3, memoryGi: 4 }), /boat has no 3 CPU, 4 GB type: use small \(2 CPU, 4 GB\), default \(4 CPU, 8 GB\), large \(8 CPU, 16 GB\)/);
  });

  it('refuses an image and a bad name before creating anything', async () => {
    const { client, calls } = fakeBoat();
    const b = boatBackend({ client });
    await assert.rejects(b.up([], { name: 'ok', image: 'ubuntu' }), /boat takes no image/);
    await assert.rejects(b.up([], { name: 'Bad Name' }), /bad sandbox name/);
    assert.deepEqual(calls, []);
  });

  it('stops the VM, waits for it to be archived, and rethrows when an upload fails', async () => {
    const { client, calls } = fakeBoat({ writeFails: true });
    await assert.rejects(boatBackend({ client }).up([{ path: 'a', data: bytes('x') }], { name: 'demo-1' }), /boat.dev writeFile failed: HTTP 500/);
    assert.deepEqual(calls.slice(-2).map((c) => c[0]), ['stop', 'waitStopped']);
  });

  it('names both errors when cleanup also fails, so a leaked sandbox is never silent', async () => {
    const { client } = fakeBoat({ writeFails: true, stopFails: true });
    await assert.rejects(boatBackend({ client }).up([{ path: 'a', data: bytes('x') }], { name: 'demo-1' }), (e: unknown) => {
      assert.ok(e instanceof PendingSandboxError);
      assert.deepEqual(e.pendingSandbox, { id: 'sb_1' });
      assert.equal(e.message, 'boat.dev writeFile failed: HTTP 500\nteardown of boat sandbox sb_1 also failed: boat.dev stop failed: HTTP 500');
      return true;
    });
  });

  it('stops nothing when create itself fails', async () => {
    const { client, calls } = fakeBoat({ createFails: 402 });
    await assert.rejects(boatBackend({ client }).up([], { name: 'demo-1' }), SandboxError);
    assert.deepEqual(calls, []);
  });

  it('reports a create boat.dev refused, such as 403 not_org_member, as not started, and any other failure as unknown (A-286)', async () => {
    const startOf = async (status: number): Promise<string> => {
      const { client } = fakeBoat({ createFails: status });
      const err: unknown = await boatBackend({ client }).up([], { name: 'demo-1' }).then(() => null, (e: unknown) => e);
      return err instanceof SandboxStartError ? err.sandboxStart.kind : `not a SandboxStartError: ${String(err)}`;
    };
    const kinds: string[] = [];
    for (const status of [400, 401, 402, 403, 404, 422, 0, 408, 409, 429, 500, 503]) kinds.push(`${status} ${await startOf(status)}`);
    assert.deepEqual(kinds, [
      '400 not_started', '401 not_started', '402 not_started', '403 not_started', '404 not_started', '422 not_started',
      '0 unknown', '408 unknown', '409 unknown', '429 unknown', '500 unknown', '503 unknown',
    ]);
  });

  it('installs Node 22 from NodeSource when the image has an older node, then checks again', async () => {
    let installed = false;
    const { client, calls } = fakeBoat({
      exec: (c) => {
        if (c === 'node -v') return done(0, installed ? 'v22.1.0\n' : 'v18.19.0\n');
        if (c.includes('setup_22.x')) installed = true;
        return done(0);
      },
    });
    await boatBackend({ client }).up([], { name: 'demo-1' });
    const execs = calls.filter((c) => c[0] === 'exec').map((c) => c[2]);
    assert.deepEqual(execs.slice(0, 3), ['node -v', "sh -c 'if [ \"$(id -u)\" -eq 0 ]; then S=; else S=sudo; fi; curl -fsSL https://deb.nodesource.com/setup_22.x | $S bash - && $S apt-get install -y nodejs'", 'node -v']);
    assert.deepEqual(calls.filter((c) => c[0] === 'exec' && String(c[2]).startsWith('sh -c')).map((c) => c[3]), [{ timeoutSeconds: 600 }]);
  });

  it('installs Node when it is missing, and stops the VM when it is still below 22 afterwards', async () => {
    const { client, calls } = fakeBoat({ exec: (c) => (c === 'node -v' ? done(127, '', 'node: not found') : done(0)) });
    await assert.rejects(boatBackend({ client }).up([], { name: 'demo-1' }), /boat sandbox sb_1 still has no Node 22 after the install/);
    assert.deepEqual(calls.slice(-2).map((c) => c[0]), ['stop', 'waitStopped']);
  });

  it('stops the VM and names the install failure when the NodeSource install fails', async () => {
    const { client, calls } = fakeBoat({ exec: (c) => (c === 'node -v' ? done(0, 'v18.0.0\n') : c.includes('setup_22.x') ? done(1, '', 'curl: (6) could not resolve host') : done(0)) });
    await assert.rejects(boatBackend({ client }).up([], { name: 'demo-1' }), /installing Node 22 in boat sandbox sb_1 failed \(exit 1\): curl: \(6\) could not resolve host/);
    assert.deepEqual(calls.slice(-2).map((c) => c[0]), ['stop', 'waitStopped']);
  });

  it('fails when mkdir exits non-zero', async () => {
    const { client } = fakeBoat({ exec: (c) => (c === 'node -v' ? done(0, 'v22.1.0\n') : done(1, '', 'read-only file system')) });
    await assert.rejects(boatBackend({ client }).up([], { name: 'demo-1' }), /mkdir in boat sandbox sb_1 failed \(exit 1\): read-only file system/);
  });
});

describe('boatBackend.exec, start, expose and down', () => {
  it('exec quotes the words, passes cwd and a capped timeout, and returns the exit code', async () => {
    const { client, calls } = fakeBoat({ exec: () => done(3, 'out', 'err') });
    const res = await boatBackend({ client }).exec('sb_1', ['npm', 'run', 'my script'], { workdir: '/tmp/worldgen/code', timeoutSec: 900 });
    assert.deepEqual(res, { exitCode: 3, stdout: 'out', stderr: 'err' });
    assert.deepEqual(calls[0], ['exec', 'sb_1', "npm run 'my script'", { cwd: '/tmp/worldgen/code', timeoutSeconds: 600 }]);
  });

  it('exec reports a timeout as exit 124 and a signal as exit 1', async () => {
    const timed = fakeBoat({ exec: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
    assert.equal((await boatBackend({ client: timed.client }).exec('sb_1', ['sleep', '9'])).exitCode, TIMED_OUT_EXIT);
    const killed = fakeBoat({ exec: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: false }) });
    assert.equal((await boatBackend({ client: killed.client }).exec('sb_1', ['x'])).exitCode, 1);
  });

  it('start redirects output to the log and launches detached in the workdir', async () => {
    const { client, calls } = fakeBoat();
    await boatBackend({ client }).start('sb_1', ['npm', 'run', 'worldplay', '--', 'serve'], { log: '/tmp/worldplay.log', workdir: '/tmp/worldgen/code' });
    assert.deepEqual(calls[0], ['start', 'sb_1', 'npm run worldplay -- serve > /tmp/worldplay.log 2>&1 < /dev/null', { cwd: '/tmp/worldgen/code' }]);
  });

  it('expose passes the public flag and returns the url', async () => {
    const { client, calls } = fakeBoat();
    assert.equal(await boatBackend({ client }).expose('sb_1', 4000, { public: true }), 'https://sb-1-4000.boat.test');
    assert.deepEqual(calls[0], ['expose', 'sb_1', 4000, true]);
  });

  it('down stops the VM and verifies it is archived', async () => {
    const { client, calls } = fakeBoat();
    await boatBackend({ client }).down('sb_1');
    assert.deepEqual(calls, [['stop', 'sb_1'], ['waitStopped', 'sb_1']]);
  });

  it('down fails as a SandboxError when the stop is not verified', async () => {
    const { client } = fakeBoat({ waitStoppedFails: true });
    await assert.rejects(boatBackend({ client }).down('sb_1'), (e: unknown) => e instanceof SandboxError && e.message === 'sandbox sb_1 not stopped after 300000 ms (state running)');
  });
});

describe('the Boat workdir', () => {
  it('is under /tmp, since the sandbox home directory is unknown', () => {
    assert.equal(BOAT_WORKDIR, '/tmp/worldgen');
  });
});


describe('Boat read-only inventory and usage receipts', () => {
  const page = (rows: unknown[], nextCursor: string | null, hasMore: boolean): Reply => ({ status: 200, json: { ok: true, type: 'sandbox.list', sandboxes: rows, pageInfo: { nextCursor, hasMore, limit: 200 } } });
  const receipt = (extra: Record<string, unknown> = {}): Reply => ({ status: 200, json: { ok: true, type: 'sandbox.usage', sandboxId: 'sb_1', sandboxType: 'small', billingMultiplier: 0.5,
    since: '2026-10-06T09:00:00Z', until: '2026-10-06T10:00:00Z', seconds: 1000, dollars: 0.01, secondsPerDollar: 100000, running: false, ...extra } });

  it('traverses every page in the requested wallet and strips secret-bearing metadata', async () => {
    const sent: Sent[] = [];
    const c = client([page([sandboxJson('running', { access: 'owner', type: 'small', createdAt: '2026-10-06T09:00:00Z', desktopUrl: 'https://private.test/?token=secret', ip: '203.0.113.5', url: 'https://private-machine.test' })], 'next-1', true),
      page([{ ...sandboxJson('archived', { access: 'view' }), id: 'sb_2' }], null, false)], sent);
    const rows = await c.inventory('team-wallet');
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ id: 'sb_1', state: 'running', type: 'small', access: 'owner', createdAt: '2026-10-06T09:00:00.000Z' }, { id: 'sb_2', state: 'archived', access: 'view', createdAt: null }]);
    assert.deepEqual(sent.map(v => [v.method, new URL(v.url).searchParams.get('org'), new URL(v.url).searchParams.get('cursor'), new URL(v.url).searchParams.get('limit')]), [['GET', 'team-wallet', null, '200'], ['GET', 'team-wallet', 'next-1', '200']]);
    assert.equal(JSON.stringify(rows).includes('secret'), false);
  });

  it('refuses missing, contradictory and non-advancing pagination rather than reporting a complete inventory', async () => {
    for (const replies of [
      [{ status: 200, json: { ok: true, type: 'sandbox.list', sandboxes: [] } }],
      [{ status: 200, json: { ok: false, type: 'sandbox.list', sandboxes: [], pageInfo: { nextCursor: null, hasMore: false, limit: 200 } } }],
      [page([], null, true)], [page([], 'unexpected', false)],
      [page([], 'stuck', true), page([], 'stuck', true)],
    ] satisfies Reply[][]) {
      await assert.rejects(client(replies, []).inventory(), /pagination|cursor/);
    }
  });

  it('projects organization identity without organization names, creator identity or private URLs', async () => {
    const rows = await client([page([sandboxJson('running', { access: 'owner', team: { id: 'team_safe', name: 'private organization' }, createdBy: 'person@example.test', createdById: 'private_person', desktopUrl: 'https://private.test/?token=secret' })], null, false)], []).inventory();
    assert.deepEqual(rows[0]?.team, { id: 'team_safe' });
    const text = JSON.stringify(rows);
    for (const privateValue of ['private organization', 'person@example.test', 'private_person', 'secret']) assert.equal(text.includes(privateValue), false);
  });

  it('returns billable machine-seconds as reported, with list-price dollars and stopped periods excluded by the provider', async () => {
    const sent: Sent[] = [];
    const usage = await client([receipt()], sent).usage('sb_1');
    assert.deepEqual(usage, { sandboxId: 'sb_1', sandboxType: 'small', billingMultiplier: 0.5, since: '2026-10-06T09:00:00.000Z', until: '2026-10-06T10:00:00.000Z', seconds: 1000, dollars: 0.01, secondsPerDollar: 100000, running: false });
    assert.equal(sent[0]?.method, 'GET');
    assert.equal(new URL(sent[0]?.url ?? '').pathname, '/api/v1/sandboxes/sb_1/usage');
  });

  it('requests exact UTC-day bounds and retains a provider-clamped partial receipt', async () => {
    assert.deepEqual(boatUsageWindow('2024-02-29'), { since: '2024-02-29T00:00:00.000Z', until: '2024-03-01T00:00:00.000Z' });
    const sent: Sent[] = [];
    const usage = await client([receipt()], sent).usage('sb_1', boatUsageWindow('2026-10-06'));
    const url = new URL(sent[0]?.url ?? '');
    assert.deepEqual([url.searchParams.get('since'), url.searchParams.get('until')], ['2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z']);
    assert.deepEqual([usage.since, usage.until], ['2026-10-06T09:00:00.000Z', '2026-10-06T10:00:00.000Z']);
  });

  it('rejects invalid dates and reversed request windows before HTTP', async () => {
    for (const day of ['2026-02-29', '2026-02-30', '2026-10-06T00:00:00Z', '9999-12-31']) assert.throws(() => boatUsageWindow(day), BoatError);
    const sent: Sent[] = [];
    const c = client([], sent);
    for (const window of [{ since: 'bad', until: '2026-10-07T00:00:00Z' }, { since: '2026-10-07T00:00:00Z', until: '2026-10-06T00:00:00Z' }]) await assert.rejects(c.usage('sb_1', window), /valid increasing UTC window/);
    assert.deepEqual(sent, []);
  });

  it('refuses a receipt that extends outside the requested UTC day', async () => {
    for (const extra of [{ since: '2026-10-05T23:59:59Z' }, { until: '2026-10-07T00:00:01Z' }]) await assert.rejects(client([receipt(extra)], []).usage('sb_1', boatUsageWindow('2026-10-06')), /outside the requested window/);
  });

  it('rejects invalid windows, negative usage and mismatched identities', async () => {
    for (const extra of [{ seconds: -1 }, { secondsPerDollar: 0 }, { dollars: 10 }, { since: '2026-10-07T00:00:00Z' }, { sandboxId: 'sb_other' }]) await assert.rejects(client([receipt(extra)], []).usage('sb_1'), /invalid or mismatched/);
  });

  it('does not expose provider error bodies containing credentials or private URLs', async () => {
    await assert.rejects(client([{ status: 403, json: { error: `${KEY} https://private.test/?token=secret` } }], []).inventory(), (err: unknown) => {
      assert.ok(err instanceof BoatError);
      assert.equal(err.message, 'boat.dev inventory failed (HTTP 403)');
      return true;
    });
  });
});
