import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { capStatus, openLedger } from '../src/costs/ledger.ts';
import { meteredSandbox } from '../src/costs/meter.ts';
import { trackBoat } from '../src/sandboxes/registry.ts';

const account = 'sha256:000000000001';
const other = 'sha256:000000000002';
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'observed-exposure-'));
  dirs.push(dir);
  const file = join(dir, 'costs.jsonl');
  return { dir, file, ledger: openLedger(file, { now: () => Date.parse('2026-10-06T23:59:00Z') }) };
}

describe('observed Boat exposure', () => {
  it('persists one unknown VM across keys, restarts and midnight without inventing spending', () => {
    const { ledger, file } = fixture();
    const id = ledger.observeSandbox({ account, sandboxId: 'sb_live', caps: { maxDailySandboxUsd: 1 } });
    const reopened = openLedger(file, { now: () => Date.parse('2026-10-07T10:00:00Z') });
    assert.equal(reopened.observeSandbox({ account: other, sandboxId: 'sb_live', caps: { maxDailySandboxUsd: 2 } }), id);
    assert.deepEqual(reopened.read().reservations.map(r => [r.account, r.origin, r.accountBasis, r.remainingUsd, r.caps]), [[account, 'inventory', 'inspection_key', null, { maxDailySandboxUsd: 1 }]]);
    assert.deepEqual([reopened.totals().usd, reopened.totals().events, reopened.read().corrupt], [0, 0, 0]);
    assert.deepEqual(capStatus(reopened, {}, reopened.now()).lines.maxDailySandboxUsd, { cap: 'maxDailySandboxUsd', capUsd: 1, spentUsd: 0, remainingUsd: 0, unpriced: 1 });
    assert.throws(() => reopened.reserve({ provider: 'boat', account, kind: 'sandbox', boundUsd: 0.1, caps: {} }), /active spending obligation is unknown/);
    const model = reopened.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxDailyLlmUsd: 0.5 } });
    assert.equal(model.maxCostUsd, 0.5);
    reopened.releaseReservation(model.id);
    assert.throws(() => reopened.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } }), /active spending obligation is unknown/);
  });

  it('preserves an admitted VM and tightens its caps without replacing its finite hold', () => {
    const { ledger } = fixture();
    const held = ledger.reserve({ provider: 'boat', account, kind: 'sandbox', boundUsd: 0.2, caps: { maxTotalUsd: 2 }, sandboxPricing: { size: 'small', multiplier: 0.5, usdPerComputeHour: 1, maxLifetimeSeconds: 60 } });
    ledger.bindReservation(held.id, 'sb_known');
    assert.equal(ledger.observeSandbox({ account: other, sandboxId: 'sb_known', caps: { maxTotalUsd: 1 } }), held.id);
    assert.deepEqual(ledger.read().reservations.map(r => [r.id, r.account, r.origin, r.remainingUsd, r.caps, r.sandboxPricing?.maxLifetimeSeconds]), [[held.id, account, undefined, 0.2, { maxTotalUsd: 1 }, 60]]);
  });

  it('cannot erase unknown observed billing through release, estimates or lifetime adoption', () => {
    const { ledger, file } = fixture();
    const id = ledger.observeSandbox({ account, sandboxId: 'sb_unknown', caps: {} });
    const before = readFileSync(file, 'utf8');
    assert.throws(() => ledger.releaseReservation(id), /verified billing reconciliation/);
    assert.throws(() => ledger.record({ provider: 'boat', account, kind: 'sandbox', reservationId: id, sandboxId: 'sb_unknown', usd: 0, estimated: true }), /verified billing reconciliation/);
    assert.throws(() => ledger.recoverLifetime({ provider: 'boat', account: other, sandboxId: 'sb_unknown', start: '2026-10-06T22:00:00Z' }), /verified billing reconciliation/);
    const meter = meteredSandbox({}, ledger, { provider: 'boat', account: other, usdPerComputeHour: 1 });
    assert.throws(() => meter.adopt('sb_unknown', Date.parse('2026-10-06T22:00:00Z')), /verified billing reconciliation/);
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('tracks only explicit owners outside archived state, without requesting usage or mutating VMs', async () => {
    const { ledger } = fixture();
    let inventoryCalls = 0;
    const report = await trackBoat({ env: { BOAT_API_KEY: 'synthetic-tracking-key', WORLDGEN_MAX_TOTAL_USD: '1' }, backendOptions: { ledger }, boatInspection: {
      async inventory(org) {
        inventoryCalls += 1;
        assert.equal(org, 'personal');
        return [
          { id: 'sb_running', state: 'running', access: 'owner', createdAt: null },
          { id: 'sb_error', state: 'error', access: 'owner', createdAt: null },
          { id: 'sb_archived', state: 'archived', access: 'owner', createdAt: null },
          { id: 'sb_shared', state: 'running', access: 'use', createdAt: null },
          { id: 'sb_unverified', state: 'running', access: 'unknown', createdAt: null },
        ];
      },
      async usage() { throw new Error('tracking must not query usage'); },
    } }, 'personal');
    assert.equal(inventoryCalls, 1);
    assert.deepEqual(report.tracked.map(r => r.id), ['sb_running', 'sb_error']);
    assert.deepEqual([report.wallet, report.accountBasis, report.billing], ['personal', 'inspection_key', 'unknown']);
    assert.deepEqual([ledger.read().reservations.length, ledger.totals().events], [2, 0]);
    await assert.rejects(trackBoat({ env: {}, boatInspection: { async inventory() { throw new Error('must validate key first'); }, async usage() { throw new Error('unused'); } } }), /BOAT_API_KEY/);
  });

  it('deduplicates simultaneous observations by VM identity in the durable journal prefix', async () => {
    const { dir, file, ledger } = fixture();
    const script = join(dir, 'observe.mjs');
    writeFileSync(script, `import {openLedger} from ${JSON.stringify(new URL('../src/costs/ledger.ts', import.meta.url).href)};\nconsole.log(openLedger(process.argv[2]).observeSandbox({account:process.argv[3],sandboxId:'sb_shared',caps:{maxTotalUsd:1}}));\n`);
    const children = [account, other].map(key => spawn(process.execPath, [script, file, key], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] }));
    try {
      const ids = await Promise.all(children.map(child => new Promise<string>((resolve, reject) => {
        let out = ''; let err = '';
        child.stdout.on('data', chunk => { out += String(chunk); });
        child.stderr.on('data', chunk => { err += String(chunk); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
      })));
      assert.equal(ids[0], ids[1]);
      assert.deepEqual([ledger.read().reservations.length, ledger.read().corrupt, ledger.totals().events], [1, 0, 0]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('prints observation provenance without inventing a VM start time or a payer', () => {
    const { ledger, file } = fixture();
    const id = ledger.observeSandbox({ account, sandboxId: 'sb_diagnostic', caps: {} });
    const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli/costs.ts', '--file', file, ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env['PATH'] } });
    const json = cli('--json', '--since', '2099-01-01');
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout).pending, [{ id, kind: 'sandbox', provider: 'boat', account, startedAt: null, origin: 'inventory', accountBasis: 'inspection_key', observedAt: '2026-10-06T23:59:00.000Z', runId: null, model: null, step: null, sandboxId: 'sb_diagnostic', boundUsd: null, remainingUsd: null }]);
    const text = cli();
    assert.equal(text.status, 0);
    assert.equal(text.stdout.includes('observed 2026-10-06T23:59:00.000Z'), true);
    assert.equal(text.stdout.includes('inventory observation; inspection key, payer unverified'), true);
    const invalid = spawnSync(process.execPath, ['src/cli/sandbox.ts', 'track', '--day', '2026-10-06'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {} });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stderr.startsWith('track accepts --org <wallet> once'), true);
  });
});
