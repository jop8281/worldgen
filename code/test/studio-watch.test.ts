/**
 * Studio metrics and alerts (YOS-237): the traffic counter, the alert rules, the traffic GET /api/health reports, and
 * the studio-watch CLI as a program against an in-process studio on loopback. The spawner and runner are fakes, so no
 * child but the watcher starts, and no model, Boat or network call leaves loopback.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { studioServer, type StudioUser } from '../src/studio/server.ts';
import { parseDailyCap, parseHealth, studioAlerts, trafficCounter, type Alert, type CostsObservation, type Observation } from '../src/studio/watch.ts';

const T = Date.parse('2026-10-07T12:00:00.000Z');
const SPAWN_BUDGET = { timeout: 20_000 };
const CODE_DIR = path.resolve(import.meta.dirname, '..');
const RUNTIME_NAME = `bun ${process.versions['bun']}`;

describe('trafficCounter', () => {
  it('keeps totals and drops 10 s buckets older than the 300 s window', () => {
    const c = trafficCounter(T);
    c.record(T, 200);
    c.record(T + 5_000, 502);
    c.record(T + 299_000, 503);
    c.record(T + 299_500, 404);
    const at = (s: number): unknown => c.snapshot(T + s * 1000);
    assert.deepEqual(at(299), { since: '2026-10-07T12:00:00.000Z', requests: 4, errors5xx: 2, windowSeconds: 300, window: { requests: 4, errors5xx: 2 } });
    assert.deepEqual(at(300), { since: '2026-10-07T12:00:00.000Z', requests: 4, errors5xx: 2, windowSeconds: 300, window: { requests: 2, errors5xx: 1 } });
    assert.deepEqual(at(400), { since: '2026-10-07T12:00:00.000Z', requests: 4, errors5xx: 2, windowSeconds: 300, window: { requests: 2, errors5xx: 1 } });
    assert.deepEqual(at(700), { since: '2026-10-07T12:00:00.000Z', requests: 4, errors5xx: 2, windowSeconds: 300, window: { requests: 0, errors5xx: 0 } });
  });

  it('reuses a bucket 300 s later instead of growing, and counts only 500 to 599 as 5xx', () => {
    const c = trafficCounter(T);
    c.record(T, 500);
    c.record(T + 300_000, 599);
    c.record(T + 300_001, 499);
    c.record(T + 300_002, 600);
    assert.deepEqual(c.snapshot(T + 300_002), { since: '2026-10-07T12:00:00.000Z', requests: 4, errors5xx: 2, windowSeconds: 300, window: { requests: 3, errors5xx: 1 } });
  });

  it('counts a request whose clock stepped back in the newest bucket', () => {
    const c = trafficCounter(T);
    c.record(T + 200_000, 200);
    c.record(T + 1_000, 502);
    assert.deepEqual(c.snapshot(T + 200_000), { since: '2026-10-07T12:00:00.000Z', requests: 2, errors5xx: 1, windowSeconds: 300, window: { requests: 2, errors5xx: 1 } });
  });
});

describe('parsing what the watcher reads', () => {
  it('reads build and traffic from a health body and drops the rest', () => {
    const body = { ok: true, build: 'abc1234', runtime: 'bun 1.4.2', worlds: 3, traffic: { since: '2026-10-07T12:00:00.000Z', requests: 9, errors5xx: 1, windowSeconds: 300, window: { requests: 4, errors5xx: 0 } } };
    assert.deepEqual(parseHealth(JSON.stringify(body)), {
      ok: true,
      value: { build: 'abc1234', traffic: { since: '2026-10-07T12:00:00.000Z', requests: 9, errors5xx: 1, windowSeconds: 300, window: { requests: 4, errors5xx: 0 } } },
    });
  });

  it('names why a health body cannot be read: not JSON, or no traffic', () => {
    assert.deepEqual(parseHealth('<html>'), { ok: false, why: 'the body is not JSON' });
    assert.deepEqual(parseHealth('{"ok":true,"build":"old"}'), { ok: false, why: 'traffic: Invalid input: expected object, received undefined' });
  });

  it('reads the daily cap line of a costs body, null when the cap is unset', () => {
    const line = { cap: 'maxDailyUsd', capUsd: 10, spentUsd: 2.5, remainingUsd: 7, reservedUsd: 0.5 };
    assert.deepEqual(parseDailyCap(JSON.stringify({ caps: { day: '2026-10-07', maxTotalUsd: null, maxDailyUsd: line } })), { ok: true, value: { capUsd: 10, spentUsd: 2.5, reservedUsd: 0.5 } });
    assert.deepEqual(parseDailyCap('{"caps":{"day":"2026-10-07","maxDailyUsd":null}}'), { ok: true, value: null });
    assert.deepEqual(parseDailyCap('{"caps":{"day":"2026-10-07"}}'), { ok: false, why: 'caps.maxDailyUsd: Invalid input: expected object, received undefined' });
  });
});

describe('studioAlerts', () => {
  const up = (requests: number, errors5xx: number, costs: CostsObservation): Observation => ({
    health: 'up',
    build: 'abc1234',
    traffic: { since: '2026-10-07T12:00:00.000Z', requests: 500, errors5xx: 40, windowSeconds: 300, window: { requests, errors5xx } },
    costs,
  });
  const spent = (spentUsd: number, more: { reservedUsd?: number; unpriced?: number } = {}): CostsObservation => ({ kind: 'ok', daily: { capUsd: 10, spentUsd, ...more } });

  const table: readonly { name: string; obs: Observation; alerts: Alert[] }[] = [
    { name: 'healthy', obs: up(50, 2, spent(1)), alerts: [] },
    {
      name: 'down after 2 attempts; a down studio carries no costs, so spend is never evaluated',
      obs: { health: 'down', attempts: 2, why: 'connection refused' },
      alerts: [{ code: 'studio.down', text: 'GET /api/health failed 2 times in a row; last: connection refused' }],
    },
    { name: '6 of 50 answered 5xx', obs: up(50, 6, spent(1)), alerts: [{ code: 'studio.5xx_rate', text: '6 of 50 requests in the last 300 s answered 5xx (12%), above 5%' }] },
    { name: '6 of 19 is below the 20-request floor', obs: up(19, 6, spent(1)), alerts: [] },
    { name: 'exactly 5% is not above 5%', obs: up(100, 5, spent(1)), alerts: [] },
    { name: 'exactly 5% at the floor', obs: up(20, 1, spent(1)), alerts: [] },
    { name: '$8.00 of $10 reaches 80%', obs: up(50, 0, spent(8)), alerts: [{ code: 'spend.cap_share', text: '$8.00 of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (80%), at or above 80%' }] },
    { name: '$7.99 of $10 does not', obs: up(50, 0, spent(7.99)), alerts: [] },
    {
      name: 'reserved spend is named',
      obs: up(50, 0, spent(9, { reservedUsd: 0.5 })),
      alerts: [{ code: 'spend.cap_share', text: '$9.00 plus $0.50 reserved of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (95%), at or above 80%' }],
    },
    {
      name: 'reserved spend counts toward the share, as the ledger counts it',
      obs: up(50, 0, spent(2, { reservedUsd: 7 })),
      alerts: [{ code: 'spend.cap_share', text: '$2.00 plus $7.00 reserved of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (90%), at or above 80%' }],
    },
    { name: 'no daily cap', obs: up(50, 0, { kind: 'ok', daily: null }), alerts: [{ code: 'spend.unchecked', text: 'no WORLDGEN_MAX_DAILY_USD cap is set' }] },
    {
      name: 'unpriced entries are unchecked, never $0',
      obs: up(50, 0, spent(0, { unpriced: 2 })),
      alerts: [{ code: 'spend.unchecked', text: "today's WORLDGEN_MAX_DAILY_USD line has 2 entries of unknown cost; settle them with costs release" }],
    },
    {
      name: 'costs failed',
      obs: up(50, 0, { kind: 'failed', why: 'answered 502 costs.failed: costs exited 1: ledger unreadable' }),
      alerts: [{ code: 'spend.unchecked', text: 'GET /api/costs failed: answered 502 costs.failed: costs exited 1: ledger unreadable' }],
    },
    {
      name: 'both problems, studio first',
      obs: up(40, 20, spent(10)),
      alerts: [
        { code: 'studio.5xx_rate', text: '20 of 40 requests in the last 300 s answered 5xx (50%), above 5%' },
        { code: 'spend.cap_share', text: '$10.00 of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (100%), at or above 80%' },
      ],
    },
  ];
  for (const row of table) {
    it(row.name, () => {
      assert.deepEqual(studioAlerts(row.obs), row.alerts);
    });
  }

  it('takes its thresholds from the limits', () => {
    assert.deepEqual(studioAlerts(up(10, 1, spent(5)), { max5xxRate: 0.05, minRequests: 10, spendShare: 0.5 }), [
      { code: 'studio.5xx_rate', text: '1 of 10 requests in the last 300 s answered 5xx (10%), above 5%' },
      { code: 'spend.cap_share', text: '$5.00 of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (50%), at or above 50%' },
    ]);
  });
});

// ---- the studio -----------------------------------------------------------------------------------

function fakeSpawner(): Spawner {
  return () => {
    const child: SpawnedChild = { pid: 1, exited: new Promise<number | null>(() => {}), kill: () => true, output: () => '' };
    return child;
  };
}

const costsRunner = (stdout: string, code = 0): Runner => async () => ({ code, stdout, stderr: code === 0 ? '' : 'ledger unreadable\n' });
const costsJson = (maxDailyUsd: object | null): string => `${JSON.stringify({ caps: { day: '2026-10-07', maxTotalUsd: null, maxDailyUsd, maxDailyLlmUsd: null, maxDailySandboxUsd: null } }, null, 2)}\n`;

async function get(base: string, p: string, method = 'GET'): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${p}`, { method });
  const text = await res.text();
  return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

describe('GET /api/health traffic', () => {
  let root = '';
  let worldsDir = '';
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-watch-'));
    worldsDir = path.join(root, 'prod', 'worlds');
    await mkdir(worldsDir, { recursive: true });
  });
  after(async () => rm(root, { recursive: true, force: true }));

  it('counts every answer but GET /api/health polls, totals since start and the last 300 s', async () => {
    let clock = T;
    const server = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: fakeSpawner(), runner: costsRunner('', 1), build: 'watch-sha', now: () => clock });
    try {
      const statuses: number[] = [];
      for (const p of ['/api/worlds', '/api/inputs', '/', '/api/nope', '/api/costs', '/api/costs', '/api/health', '/api/health?x=1']) {
        statuses.push((await get(server.url, p)).status);
      }
      statuses.push((await get(server.url, '/api/health', 'POST')).status);
      assert.deepEqual(statuses, [200, 200, 200, 404, 502, 502, 200, 200, 405]);
      clock = T + 60_000;
      assert.deepEqual(await get(server.url, '/api/health'), {
        status: 200,
        body: {
          ok: true, build: 'watch-sha', runtime: RUNTIME_NAME, worlds: 0,
          traffic: { since: '2026-10-07T12:00:00.000Z', requests: 7, errors5xx: 2, windowSeconds: 300, window: { requests: 7, errors5xx: 2 } },
        },
      });
      clock = T + 310_000;
      assert.deepEqual(await get(server.url, '/api/health'), {
        status: 200,
        body: {
          ok: true, build: 'watch-sha', runtime: RUNTIME_NAME, worlds: 0,
          traffic: { since: '2026-10-07T12:00:00.000Z', requests: 7, errors5xx: 2, windowSeconds: 300, window: { requests: 0, errors5xx: 0 } },
        },
      });
    } finally {
      await server.close();
    }
  });
});

// ---- the CLI as a program -------------------------------------------------------------------------

type Ran = { code: number | null; stdout: string; stderr: string };

/** Runs studio-watch in a child with exactly PATH plus `env`. */
function watch(args: readonly string[], env: Record<string, string> = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli/studio-watch.ts', ...args], { cwd: CODE_DIR, env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const freedPort = (): Promise<number> => new Promise((resolve) => {
  const probe = createNetServer().listen(0, '127.0.0.1', () => {
    const a = probe.address();
    probe.close(() => resolve(a !== null && typeof a === 'object' ? a.port : 0));
  });
});

describe('studio-watch', () => {
  const TOKEN = 'studio-watch-token-Q7v9s3cr3t';
  let root = '';
  let worldsDir = '';
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-watch-cli-'));
    worldsDir = path.join(root, 'prod', 'worlds');
    await mkdir(worldsDir, { recursive: true });
  });
  after(async () => rm(root, { recursive: true, force: true }));

  async function withStudio(costs: string, users: readonly StudioUser[], f: (url: string) => Promise<void>): Promise<void> {
    const server = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: fakeSpawner(), runner: costsRunner(costs), build: 'watch-sha', users });
    try {
      await f(server.url);
    } finally {
      await server.close();
    }
  }

  it('prints OK lines and exits 0 for a healthy studio', SPAWN_BUDGET, async () => {
    await withStudio(costsJson({ cap: 'maxDailyUsd', capUsd: 10, spentUsd: 1, remainingUsd: 9 }), [], async (url) => {
      assert.deepEqual(await watch([url]), {
        code: 0,
        stdout: 'OK studio: build watch-sha, 0 requests in the last 300 s, 0 answered 5xx\nOK spend: $1.00 of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (10%), alert at 80%\n',
        stderr: '',
      });
    });
  });

  it('prints ALERT spend.cap_share and exits 1 at 90% of the daily cap', SPAWN_BUDGET, async () => {
    await withStudio(costsJson({ cap: 'maxDailyUsd', capUsd: 10, spentUsd: 9, remainingUsd: 1 }), [], async (url) => {
      assert.deepEqual(await watch([url]), {
        code: 1,
        stdout: 'ALERT spend.cap_share: $9.00 of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (90%), at or above 80%\n',
        stderr: '',
      });
    });
  });

  it('prints ALERT spend.unchecked when no daily cap is set', SPAWN_BUDGET, async () => {
    await withStudio(costsJson(null), [], async (url) => {
      assert.deepEqual(await watch([url]), { code: 1, stdout: 'ALERT spend.unchecked: no WORLDGEN_MAX_DAILY_USD cap is set\n', stderr: '' });
    });
  });

  it('prints ALERT studio.down alone after 2 refused attempts', SPAWN_BUDGET, async () => {
    const port = await freedPort();
    assert.deepEqual(await watch([`http://127.0.0.1:${port}`, '--retry-ms', '0']), {
      code: 1,
      stdout: 'ALERT studio.down: GET /api/health failed 2 times in a row; last: connection refused\n',
      stderr: '',
    });
  });

  it('names the timeout when health never answers', SPAWN_BUDGET, async () => {
    const silent: Server = createServer(() => {});
    const port = await new Promise<number>((resolve) => silent.listen(0, '127.0.0.1', () => {
      const a = silent.address();
      resolve(a !== null && typeof a === 'object' ? a.port : 0);
    }));
    try {
      assert.deepEqual(await watch([`http://127.0.0.1:${port}`, '--attempts', '1', '--timeout-ms', '200']), {
        code: 1,
        stdout: 'ALERT studio.down: GET /api/health failed 1 time in a row; last: no answer within 200 ms\n',
        stderr: '',
      });
    } finally {
      await new Promise<void>((resolve) => {
        silent.close(() => resolve());
        silent.closeAllConnections();
      });
    }
  });

  it('reads costs from a signed-in studio with WORLDGEN_STUDIO_TOKEN as the bearer, and never prints it', SPAWN_BUDGET, async () => {
    // The CLI makes WORLDGEN_STUDIO_TOKEN an admin of tenant default, and /api/costs is admin-only (A-344).
    const users: StudioUser[] = [{ name: 'vera', role: 'admin', tenant: 'default', tokenSha256: createHash('sha256').update(TOKEN).digest('hex') }];
    await withStudio(costsJson({ cap: 'maxDailyUsd', capUsd: 10, spentUsd: 1, remainingUsd: 9 }), users, async (url) => {
      const signed = await watch([url], { WORLDGEN_STUDIO_TOKEN: TOKEN });
      assert.deepEqual(signed, {
        code: 0,
        stdout: 'OK studio: build watch-sha, 0 requests in the last 300 s, 0 answered 5xx\nOK spend: $1.00 of the $10.00 WORLDGEN_MAX_DAILY_USD cap spent today (10%), alert at 80%\n',
        stderr: '',
      });
      const anonymous = await watch([url]);
      assert.deepEqual(anonymous, {
        code: 1,
        stdout: 'ALERT spend.unchecked: GET /api/costs failed: answered 401 auth.required: GET /api/costs needs sign-in: send Authorization: Bearer <token>, or sign in on the page\n',
        stderr: '',
      });
    });
  });

  it('scrubs the token from a costs failure that echoes it', SPAWN_BUDGET, async () => {
    const echo: Server = createServer((req, res) => {
      const health = { ok: true, build: 'echo', traffic: { since: '2026-10-07T12:00:00.000Z', requests: 0, errors5xx: 0, windowSeconds: 300, window: { requests: 0, errors5xx: 0 } } };
      const [status, body] = req.url === '/api/health' ? [200, health] : [500, { error: { code: 'echo.auth', message: `saw ${req.headers.authorization ?? 'nothing'}` } }];
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    const port = await new Promise<number>((resolve) => echo.listen(0, '127.0.0.1', () => {
      const a = echo.address();
      resolve(a !== null && typeof a === 'object' ? a.port : 0);
    }));
    try {
      assert.deepEqual(await watch([`http://127.0.0.1:${port}`], { WORLDGEN_STUDIO_TOKEN: TOKEN }), {
        code: 1,
        stdout: 'ALERT spend.unchecked: GET /api/costs failed: answered 500 echo.auth: saw Bearer <token>\n',
        stderr: '',
      });
    } finally {
      await new Promise<void>((resolve) => {
        echo.close(() => resolve());
        echo.closeAllConnections();
      });
    }
  });

  it('exits 2 with the usage on stderr for a bad flag or value', SPAWN_BUDGET, async () => {
    const bogus = await watch(['--bogus']);
    assert.deepEqual([bogus.code, bogus.stdout, bogus.stderr.split('\n')[0], bogus.stderr.split('\n')[1]?.startsWith('usage: bun run studio-watch -- [url]')], [2, '', 'unknown argument --bogus', true]);
    const zero = await watch(['--attempts', '0']);
    assert.deepEqual([zero.code, zero.stdout, zero.stderr.split('\n')[0]], [2, '', '--attempts needs an integer of at least 1, got 0']);
    const scheme = await watch(['ftp://127.0.0.1:8787']);
    assert.deepEqual([scheme.code, scheme.stderr.split('\n')[0]], [2, 'the url must be an http(s) URL such as http://127.0.0.1:8787, got ftp://127.0.0.1:8787']);
  });
});
