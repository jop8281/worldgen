import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { boatReceiptsPath, openBoatReceipts, type BoatReceiptInput } from '../src/costs/boat-receipts.ts';
import { openLedger } from '../src/costs/ledger.ts';
import { captureBoatUsage } from '../src/sandboxes/registry.ts';

const account = 'sha256:000000000001';
const other = 'sha256:000000000002';
const window = { since: '2026-10-06T00:00:00.000Z', until: '2026-10-07T00:00:00.000Z' };
const base: BoatReceiptInput = { sandboxId: 'sb_receipt', inspectionAccount: account, requestedWindow: window,
  returnedWindow: window, sandboxType: 'large', billingMultiplier: 2, billableSeconds: 1200, listPriceUsd: 0.012,
  secondsPerDollar: 100000, running: false };
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'boat-receipts-'));
  dirs.push(dir);
  const file = join(dir, 'costs.jsonl');
  const ledger = openLedger(file, { now: () => Date.parse('2026-10-07T01:00:00Z') });
  return { dir, file, ledger, journal: openBoatReceipts(boatReceiptsPath(file), ledger.now) };
}

describe('durable Boat usage receipts', () => {
  it('keeps one canonical VM/day snapshot across keys without multiplying billable seconds again', () => {
    const { journal } = fixture();
    journal.capture(base);
    journal.capture({ ...base, inspectionAccount: other, billableSeconds: 1500, listPriceUsd: 0.015 });
    const reopened = openBoatReceipts(journal.path);
    assert.deepEqual(reopened.read().receipts.map(r => [r.sandboxId, r.coverage, r.billableSeconds, r.listPriceUsd, r.inspectionAccounts, r.priceBasis]),
      [['sb_receipt', 'full_day', 1500, 0.015, [account, other], 'provider_list_usage']]);
    assert.equal(readFileSync(journal.path, 'utf8').trim().split('\n').length, 2);
  });

  it('retains partial coverage and treats a stopped meter as independent of VM closure', () => {
    const { journal } = fixture();
    journal.capture({ ...base, returnedWindow: { since: '2026-10-06T09:00:00.000Z', until: '2026-10-06T10:00:00.000Z' } });
    assert.deepEqual(journal.read().receipts.map(r => [r.coverage, r.running, r.walletStatus]), [['partial_day', false, 'unverified']]);
  });

  it('does not roll a newer receipt back when an older observation is appended later', () => {
    const { journal } = fixture();
    journal.capture({ ...base, billableSeconds: 1500, listPriceUsd: 0.015 });
    openBoatReceipts(journal.path, () => Date.parse('2026-10-07T00:30:00Z')).capture(base);
    assert.equal(journal.read().receipts[0]?.listPriceUsd, 0.015);
  });

  it('retains conflicting wallet evidence rather than guessing the payer', () => {
    const { journal } = fixture();
    journal.capture({ ...base, walletId: 'team_a' });
    journal.capture({ ...base, inspectionAccount: other, walletId: 'team_b' });
    assert.deepEqual(journal.read().receipts.map(r => [r.walletStatus, r.walletIds]), [['conflicting', ['team_a', 'team_b']]]);
  });

  it('rejects invalid windows, raw keys, nonfinite prices and inconsistent units before writing', () => {
    const { journal } = fixture();
    for (const input of [
      { ...base, inspectionAccount: 'raw-key-must-not-persist' },
      { ...base, listPriceUsd: Infinity },
      { ...base, listPriceUsd: 0.024 },
      { ...base, returnedWindow: { since: '2026-10-05T00:00:00.000Z', until: window.until } },
      { ...base, requestedWindow: { since: window.since, until: '2026-10-08T00:00:00.000Z' } },
      { ...base, returnedWindow: { since: window.until, until: window.since } },
    ]) assert.throws(() => journal.capture(input));
    assert.deepEqual(journal.read(), { receipts: [], corrupt: 0 });
  });

  it('preserves a complete final line without LF, and refuses to append to corrupt evidence', () => {
    const { journal } = fixture();
    journal.capture(base);
    writeFileSync(journal.path, readFileSync(journal.path, 'utf8').trimEnd());
    journal.capture({ ...base, inspectionAccount: other });
    assert.equal(journal.read().corrupt, 0);
    writeFileSync(journal.path, `${readFileSync(journal.path, 'utf8')}truncated`);
    const before = readFileSync(journal.path, 'utf8');
    assert.throws(() => journal.capture(base), /corrupt or incomplete/);
    assert.equal(readFileSync(journal.path, 'utf8'), before);
    assert.equal(journal.read().corrupt, 1);
  });

  it('captures an owner receipt without settling spend or clearing the existing unknown hold', async () => {
    const { ledger, file, journal } = fixture();
    const id = ledger.observeSandbox({ account, sandboxId: 'sb_receipt', caps: { maxTotalUsd: 1 } });
    const before = readFileSync(file, 'utf8');
    const calls: string[] = [];
    const report = await captureBoatUsage({ env: { BOAT_API_KEY: 'synthetic-receipt-key' }, backendOptions: { ledger }, boatInspection: {
      async inventory(org) {
        assert.equal(org, 'personal');
        return [
          { id: 'sb_receipt', access: 'owner', state: 'archived', createdAt: null, team: { id: 'team_safe' } },
          { id: 'sb_shared', access: 'use', state: 'running', createdAt: null },
          { id: 'sb_unavailable', access: 'owner', state: 'running', createdAt: null },
        ];
      },
      async usage(sandboxId, requested) {
        calls.push(sandboxId);
        assert.deepEqual(requested, window);
        if (sandboxId === 'sb_unavailable') throw new Error('private provider error');
        return { sandboxId, sandboxType: 'large', billingMultiplier: 2, seconds: 1200, dollars: 0.012, secondsPerDollar: 100000,
          since: window.since, until: window.until, running: false };
      },
    } }, '2026-10-06', 'personal');
    assert.deepEqual(calls, ['sb_receipt', 'sb_unavailable']);
    assert.deepEqual(report.rows, [{ id: 'sb_receipt', status: 'captured' }, { id: 'sb_shared', status: 'ownership_unverified' }, { id: 'sb_unavailable', status: 'unavailable' }]);
    assert.equal(report.settledSpendChanged, false);
    assert.deepEqual(journal.read().receipts.map(r => [r.billableSeconds, r.listPriceUsd, r.walletStatus]), [[1200, 0.012, 'organization_metadata']]);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual([ledger.read().reservations[0]?.id, ledger.totals().usd, ledger.totals().events], [id, 0, 0]);
    assert.throws(() => ledger.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: {} }), /active spending obligation is unknown/);
  });

  it('deduplicates concurrent controllers inspecting one VM and UTC day', async () => {
    const { dir, journal } = fixture();
    const script = join(dir, 'capture.mjs');
    writeFileSync(script, `import {openBoatReceipts} from ${JSON.stringify(new URL('../src/costs/boat-receipts.ts', import.meta.url).href)};\nopenBoatReceipts(process.argv[2],()=>Date.parse('2026-10-07T01:00:00Z')).capture({...${JSON.stringify(base)},inspectionAccount:process.argv[3]});\n`);
    const children = [account, other].map(key => spawn(process.execPath, [script, journal.path, key], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe'] }));
    try {
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        let err = '';
        child.stderr.on('data', chunk => { err += String(chunk); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error(err)));
      })));
      assert.deepEqual([journal.read().receipts.length, journal.read().corrupt], [1, 0]);
      assert.deepEqual([...(journal.read().receipts[0]?.inspectionAccounts ?? [])].sort(), [account, other]);
    } finally { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }
  });

  it('shows captured evidence separately in the actual costs CLI and requires a day for capture', () => {
    const { file, journal } = fixture();
    journal.capture(base);
    const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli/costs.ts', '--file', file, ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env['PATH'] } });
    const json = cli('--json');
    assert.equal(json.status, 0);
    const out = JSON.parse(json.stdout);
    assert.deepEqual([out.total.usd, out.total.events, out.boatUsageReceipts.receipts[0].listPriceUsd], [0, 0, 0.012]);
    const text = cli();
    assert.equal(text.status, 0);
    assert.equal(text.stdout.includes('list-price estimates, separate from settled spend'), true);
    assert.equal(text.stdout.includes('1200 billable seconds (size multiplier already applied)'), true);
    const missing = spawnSync(process.execPath, ['src/cli/sandbox.ts', 'capture-usage'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {} });
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr.startsWith('capture-usage requires --day YYYY-MM-DD'), true);
  });
});
