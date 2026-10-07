/**
 * Every sandbox backend, built by backendFor() and metered into a temp ledger, records each
 * lifetime without losing usage after a failed teardown. The CLI
 * backends run through a fake Runner and boat through a fake BoatClient, so nothing starts a
 * sandbox or reaches the network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { BoatClient } from '../src/boat/client.ts';
import { openLedger, type Ledger } from '../src/costs/ledger.ts';
import { upWorld, type BackendKind, type Runner } from '../src/sandboxes/backend.ts';
import type { Workspace } from '../src/sandboxes/files.ts';
import { backendFor } from '../src/sandboxes/registry.ts';

type Fail = 'none' | 'start' | 'teardown';

const workspace: Workspace = {
  path: (name) => `/tmp/wg/${name}`,
  write: async (name) => `/tmp/wg/${name}`,
  remove: async () => {},
};

function clock(): { ledger: Ledger; advance: (s: number) => void } {
  let t = Date.parse('2026-10-07T09:00:00.000Z');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'meters-')), 'costs.jsonl');
  return { ledger: openLedger(file, { now: () => t }), advance: (s) => void (t += s * 1000) };
}

const isCreate = (argv: readonly string[]): boolean => argv.includes('create');
const isTeardown = (argv: readonly string[]): boolean => argv.includes('delete') || argv.includes('rm');
const isInstall = (argv: readonly string[]): boolean => argv.includes('install') && argv.includes('--frozen-lockfile');

/** Answers like a healthy CLI, spends 60 s in bun install, and fails the step `fail` names. */
function runner(fail: Fail, advance: (s: number) => void): Runner {
  return async (argv) => {
    if (fail === 'start' && isCreate(argv)) return { code: 1, stdout: '', stderr: 'quota exceeded' };
    if (fail === 'teardown' && isTeardown(argv)) return { code: 1, stdout: '', stderr: 'still busy' };
    if (isInstall(argv)) advance(60);
    return { code: 0, stdout: argv.includes('-v') ? 'v22.1.0\n' : argv.join(' ').includes('bun-linux-') ? '1.4.2\n' : '', stderr: '' };
  };
}

function boatClient(fail: Fail, advance: (s: number) => void): BoatClient {
  return {
    create: async () => ({ sandboxId: 'sb_9' }),
    async waitReady() {
      if (fail === 'start') {
        advance(30);
        throw new Error('sb_9 never became ready');
      }
    },
    async exec(_id, command) {
      if (command.includes('bun install --frozen-lockfile')) advance(60);
      return { exitCode: 0, stdout: command === 'node -v' ? 'v22.1.0\n' : command.includes('bun-linux-') ? '1.4.2\n' : '', stderr: '', timedOut: false };
    },
    start: async () => ({ processId: 1 }),
    writeFile: async () => {},
    expose: async (_id, port) => ({ url: `https://sb-9-${port}.boat.test` }),
    async stop() {
      if (fail === 'teardown') throw new Error('stop refused');
    },
    waitStopped: async () => {},
  };
}

function metered(kind: BackendKind, fail: Fail) {
  const { ledger, advance } = clock();
  const m = backendFor(kind, { BOAT_API_KEY: 'boat-test-key-0003', WORLDGEN_BOAT_ORG: 'org_test', BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '1' }, runner(fail, advance), {
    ledger,
    workspace,
    boatClient: boatClient(fail, advance),
    flushOnExit: false,
  });
  const rows = () => ledger.read().events.map((e) => [e.provider, e.sandboxId, e.seconds, e.usd, e.estimated, e.failed, e.note]);
  return { m, rows, advance };
}

const bundle = { files: [{ path: 'package.json', data: new Uint8Array([123, 125]) }], world: 'worlds/helpdesk' };
const serve = (m: ReturnType<typeof metered>['m']) => upWorld(m.backend, bundle, { name: 'w-1', port: 4000 });

describe('every backend meters each lifecycle exactly once', () => {
  const ok: Record<BackendKind, unknown[]> = {
    openshell: ['openshell', 'w-1', 60, 0, false, undefined, undefined],
    sbx: ['sbx', 'w-1', 60, 0, false, undefined, undefined],
    boat: ['boat', 'sb_9', 60, 0.008333333, true, undefined, undefined],
  };
  for (const kind of ['openshell', 'sbx', 'boat'] as const) {
    it(`${kind}: up then down records one line`, async () => {
      const { m, rows } = metered(kind, 'none');
      const up = await serve(m);
      await m.backend.down(up.sandbox.id);
      await m.backend.down(up.sandbox.id);
      assert.deepEqual(m.meter.flush(), []);
      assert.deepEqual(rows(), [ok[kind]]);
    });
  }

  const startFailed: Record<BackendKind, unknown[]> = {
    openshell: ['openshell', 'w-1', 0, 0, false, true, 'start failed'],
    sbx: ['sbx', 'w-1', 0, 0, false, true, 'start failed'],
    boat: ['boat', 'sb_9', 30, 0.004166667, true, true, 'start failed; teardown confirmed'],
  };
  for (const kind of ['openshell', 'sbx', 'boat'] as const) {
    it(`${kind}: a failed start records one failed line`, async () => {
      const { m, rows } = metered(kind, 'start');
      await assert.rejects(serve(m));
      assert.deepEqual(m.meter.flush(), []);
      assert.deepEqual(rows(), [startFailed[kind]]);
    });
  }

  const teardownFailed: Record<BackendKind, unknown[]> = {
    openshell: ['openshell', 'w-1', 60, 0, false, true, 'teardown failed; the sandbox may still be running'],
    sbx: ['sbx', 'w-1', 60, 0, false, true, 'teardown failed; the sandbox may still be running'],
    boat: ['boat', 'sb_9', 60, 0.008333333, true, true, 'teardown failed; the sandbox may still be running'],
  };
  const flushed: Record<BackendKind, unknown[]> = {
    openshell: ['openshell', 'w-1', 60, 0, false, undefined, 'flushed at exit; the sandbox may still be running'],
    sbx: ['sbx', 'w-1', 60, 0, false, undefined, 'flushed at exit; the sandbox may still be running'],
    boat: ['boat', 'sb_9', 60, 0.008333333, true, undefined, 'flushed at exit; the sandbox may still be running'],
  };
  for (const kind of ['openshell', 'sbx', 'boat'] as const) {
    it(`${kind}: a failed teardown retains the VM and exit flush records the remaining lifetime`, async () => {
      const { m, rows, advance } = metered(kind, 'teardown');
      const up = await serve(m);
      await assert.rejects(m.backend.down(up.sandbox.id));
      assert.deepEqual(m.meter.live(), [up.sandbox.id]);
      advance(60);
      m.meter.flush();
      assert.deepEqual(rows(), [teardownFailed[kind], flushed[kind]]);
      assert.deepEqual(m.meter.live(), []);
    });
  }
});
