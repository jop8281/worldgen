/**
 * upWorld for a public sandbox: serve binds 0.0.0.0 so a hosted proxy can reach it (the Boat smoke
 * got 502 with a loopback bind), only the world port is exposed, and the exposed URL is checked
 * from outside. A recording backend stands in for the sandbox; reachWorld gets a fake fetch.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PUBLIC_HOST,
  REACH_PATH,
  SandboxError,
  reachWorld,
  upWorld,
  type ExecResult,
  type Reach,
  type SandboxBackend,
  type WorldBundle,
} from '../src/sandboxes/backend.ts';

const BUNDLE: WorldBundle = { files: [], world: 'worlds/helpdesk' };
const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '' });

function recorder(): { backend: SandboxBackend; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const backend: SandboxBackend = {
    kind: 'boat',
    async up() {
      calls.push(['up']);
      return { id: 'sb_1', workdir: '/tmp/worldgen' };
    },
    async exec(_id, cmd) {
      calls.push(['exec', cmd.join(' ')]);
      return ok(cmd.join(' ').includes('bun-linux-') ? '1.4.2\n' : cmd[0] === 'tail' ? 'Error: listen EADDRNOTAVAIL\n' : '');
    },
    async start(_id, cmd) {
      calls.push(['start', cmd.join(' ')]);
    },
    async expose(_id, port, opts) {
      calls.push(['expose', port, opts.public]);
      return `https://box-${port}.example.test`;
    },
    async down() {
      calls.push(['down']);
    },
  };
  return { backend, calls };
}

describe('upWorld on a public sandbox', () => {
  it('starts serve with --host 0.0.0.0 and exposes only the world port', async () => {
    const { backend, calls } = recorder();
    const up = await upWorld(backend, BUNDLE, { name: 'w1', port: 4000, public: true });
    assert.equal(up.url, 'https://box-4000.example.test');
    assert.deepEqual(calls.find((c) => c[0] === 'start'), ['start', '/tmp/worldgen-bun/node_modules/.bin/bun src/cli/worldplay.ts serve worlds/helpdesk --port 4000 --host 0.0.0.0']);
    assert.deepEqual(calls.filter((c) => c[0] === 'expose'), [['expose', 4000, true]]);
    assert.equal(calls.some((c) => c.some((a) => String(a).includes('4001'))), false);
    assert.equal(String(calls.find((c) => c[0] === 'start')?.[1]).includes('--admin-host'), false);
    assert.equal(PUBLIC_HOST, '0.0.0.0');
  });

  it('binds authenticated Boat URLs for the hosted proxy too', async () => {
    const { backend, calls } = recorder();
    await upWorld(backend, BUNDLE, { name: 'w1', port: 4000 });
    assert.deepEqual(calls.find((c) => c[0] === 'start'), ['start', '/tmp/worldgen-bun/node_modules/.bin/bun src/cli/worldplay.ts serve worlds/helpdesk --port 4000 --host 0.0.0.0']);
    assert.deepEqual(calls.filter((c) => c[0] === 'expose'), [['expose', 4000, false]]);
  });

  it('keeps loopback for a local sandbox that is not public', async () => {
    const { backend, calls } = recorder();
    await upWorld({ ...backend, kind: 'openshell' }, BUNDLE, { name: 'w1', port: 4000 });
    assert.deepEqual(calls.find((c) => c[0] === 'start'), ['start', '/tmp/worldgen-bun/node_modules/.bin/bun src/cli/worldplay.ts serve worlds/helpdesk --port 4000']);
    assert.deepEqual(calls.filter((c) => c[0] === 'expose'), [['expose', 4000, false]]);
  });

  it('checks the exposed URL, and tears down with the serve log when it does not answer', async () => {
    const { backend, calls } = recorder();
    const seen: string[] = [];
    const reach = async (url: string): Promise<Reach> => {
      seen.push(url);
      return { ok: false, why: 'HTTP 502' };
    };
    await assert.rejects(
      upWorld(backend, BUNDLE, { name: 'w1', port: 4000, public: true, reach }),
      (e: unknown) =>
        e instanceof SandboxError &&
        e.message === `https://box-4000.example.test did not answer ${REACH_PATH} (HTTP 502) although the boat sandbox sb_1 listens on port 4000:\nError: listen EADDRNOTAVAIL`,
    );
    assert.deepEqual(seen, ['https://box-4000.example.test']);
    assert.deepEqual(calls.at(-1), ['down']);
  });

  it('returns the URL when the check passes', async () => {
    const { backend } = recorder();
    const up = await upWorld(backend, BUNDLE, { name: 'w1', port: 4000, public: true, reach: async () => ({ ok: true }) });
    assert.equal(up.url, 'https://box-4000.example.test');
  });
});

describe('reachWorld', () => {
  it('fetches /openapi.json and retries a 502 until the world answers', async () => {
    const asked: string[] = [];
    const statuses = [502, 502, 200];
    const slept: number[] = [];
    const res = await reachWorld('https://box.test', 60, {
      fetch: async (u) => {
        asked.push(u);
        return { status: statuses.shift() ?? 200 };
      },
      sleep: async (ms) => void slept.push(ms),
    });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(asked, ['https://box.test/openapi.json', 'https://box.test/openapi.json', 'https://box.test/openapi.json']);
    assert.deepEqual(slept, [1000, 1000]);
  });

  it('does not declare an unavailable OpenAPI endpoint ready', async () => {
    for (const status of [204, 301, 401, 403, 404]) {
      let t = 0;
      assert.deepEqual(await reachWorld('https://box.test', 1, {
        fetch: async () => ({ status }), sleep: async (ms) => void (t += ms), now: () => t,
      }), { ok: false, why: `HTTP ${status}` });
    }
  });

  it('stops without another request when the remaining retry delay expires', async () => {
    let t = 0;
    let requests = 0;
    const slept: number[] = [];
    const res = await reachWorld('https://box.test', 0.25, {
      fetch: async () => { requests++; return { status: 502 }; },
      sleep: async (ms) => { slept.push(ms); t += ms; },
      now: () => t,
    });
    assert.deepEqual(res, { ok: false, why: 'HTTP 502' });
    assert.equal(requests, 1);
    assert.deepEqual(slept, [250]);
  });

  it('aborts a pending request within the remaining readiness budget', async () => {
    let aborted = false;
    let t = 0;
    const res = await reachWorld('https://box.test', 0.02, {
      fetch: async (_url, { signal }) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        aborted = signal.aborted;
        t = 20;
        throw new Error('request timed out');
      },
      now: () => t,
    });
    assert.equal(aborted, true);
    assert.deepEqual(res, { ok: false, why: 'request timed out' });
  });

  it('does not start a request after the budget has expired', async () => {
    let requests = 0;
    assert.deepEqual(await reachWorld('https://box.test', 0, {
      fetch: async () => { requests++; return { status: 200 }; },
    }), { ok: false, why: 'no answer' });
    assert.equal(requests, 0);
  });

  it('gives up after the timeout with the last status', async () => {
    let t = 0;
    const res = await reachWorld('https://box.test', 3, { fetch: async () => ({ status: 502 }), sleep: async (ms) => void (t += ms), now: () => t });
    assert.deepEqual(res, { ok: false, why: 'HTTP 502' });
  });

  it('reports a network failure as the reason', async () => {
    let t = 0;
    const res = await reachWorld('https://box.test', 1, {
      fetch: async () => {
        throw new Error('fetch failed');
      },
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    assert.deepEqual(res, { ok: false, why: 'fetch failed' });
  });
});
