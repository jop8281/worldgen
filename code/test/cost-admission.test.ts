import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { capStatus, guard, openLedger, type Ledger, type ReservationInput } from '../src/costs/ledger.ts';

const account = 'sha256:000000000001';
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cost-admission-'));
  dirs.push(dir);
  const file = join(dir, 'costs.jsonl');
  let now = Date.parse('2026-10-06T23:59:00Z');
  return { dir, file, ledger: openLedger(file, { now: () => now }), advance: (ms: number) => { now += ms; } };
}
const input = (over: Partial<ReservationInput> = {}): ReservationInput => ({ provider: 'boat', account, kind: 'sandbox', boundUsd: 0.75, caps: { maxTotalUsd: 1 }, ...over });

function charge(ledger: Ledger, id: string, usd: number, checkpoint = false) {
  return ledger.record({ provider: 'boat', account, kind: 'sandbox', reservationId: id, usd, estimated: true, ...(checkpoint ? { checkpoint: true as const } : {}) });
}

describe('persistent cost admission', () => {
  it('derives the model estimate allowance from its admitted prefix across settled spend, VM holds and applicable caps', () => {
    const { ledger, file } = fixture();
    ledger.record({ provider: 'anthropic', account, kind: 'model_call', usd: 0.2, estimated: true });
    ledger.reserve(input({ boundUsd: 0.3, caps: { maxTotalUsd: 1, maxDailySandboxUsd: 0.4 } }));
    const admitted = ledger.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxDailyLlmUsd: 0.6, maxDailySandboxUsd: 0.01 } });
    assert.equal(admitted.maxCostUsd, 0.4);
    assert.equal(openLedger(file).read().reservations.find(r => r.id === admitted.id)?.maxCostUsd, 0.4);
    ledger.record({ provider: 'claude-cli', account: 'claude-cli', kind: 'model_call', reservationId: admitted.id, usd: 0.1, estimated: true });
    const next = ledger.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
    assert.equal(next.maxCostUsd, 0.4);
    assert.equal(fixture().ledger.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxDailySandboxUsd: 0 } }).maxCostUsd, undefined);
  });

  it('holds pending cost before a VM exists without counting the reservation as billed spend', () => {
    const { ledger } = fixture();
    ledger.reserve(input());
    assert.throws(() => ledger.reserve(input()), /spend cap/);
    assert.deepEqual([ledger.totals().usd, ledger.totals().events, ledger.read().reservations.length], [0, 0, 1]);
    assert.equal(ledger.read().reservations[0]?.remainingUsd, 0.75);
    assert.deepEqual(capStatus(ledger, {}, ledger.now()).lines.maxTotalUsd, { cap: 'maxTotalUsd', capUsd: 1, spentUsd: 0, reservedUsd: 0.75, remainingUsd: 0.25 });
  });

  it('retains binding and remaining exposure in a fresh process ledger after a failed-stop checkpoint', () => {
    const { ledger, file } = fixture();
    const held = ledger.reserve(input());
    ledger.bindReservation(held.id, 'vm-pending');
    charge(ledger, held.id, 0.25, true);
    const reopened = openLedger(file);
    assert.deepEqual(reopened.read().reservations.map(r => [r.sandboxId, r.remainingUsd]), [['vm-pending', 0.5]]);
    assert.throws(() => reopened.reserve(input({ boundUsd: 0.3 })), /spend cap/);
    charge(reopened, held.id, 0.5);
    assert.deepEqual([reopened.totals().usd, reopened.read().reservations.length], [0.75, 0]);
    reopened.reserve(input({ boundUsd: 0.25 }));
  });

  it('keeps active exposure against the new day when a pending VM crosses midnight', () => {
    const { ledger, advance } = fixture();
    ledger.reserve(input({ caps: { maxDailySandboxUsd: 1 } }));
    advance(120_000);
    assert.throws(() => ledger.reserve(input({ caps: { maxDailySandboxUsd: 1 } })), /spend cap/);
    assert.equal(ledger.read().reservations.length, 1);
  });

  it('applies combined caps across meters while preserving separate meter caps', () => {
    const { ledger } = fixture();
    ledger.reserve(input());
    assert.throws(() => ledger.reserve(input({ provider: 'anthropic', kind: 'model_call', boundUsd: 0.3 })), /spend cap/);
    assert.throws(() => ledger.reserve(input({ provider: 'anthropic', kind: 'model_call', boundUsd: 0.3, caps: { maxDailyLlmUsd: 1 } })), /spend cap/);
    const separate = fixture().ledger;
    separate.reserve(input({ caps: { maxDailySandboxUsd: 1 } }));
    separate.reserve(input({ provider: 'anthropic', kind: 'model_call', boundUsd: 0.3, caps: { maxDailyLlmUsd: 1 } }));
    assert.deepEqual(separate.read().reservations.map(r => [r.kind, r.remainingUsd]), [['sandbox', 0.75], ['model_call', 0.3]]);
  });

  it('refuses applicable unknown billing and corrupt records before admission', () => {
    const { ledger, file } = fixture();
    ledger.record({ provider: 'anthropic', account, kind: 'model_call', usd: null, estimated: 'unpriced', failed: true });
    assert.throws(() => ledger.reserve(input()), /billing is unknown/);
    assert.throws(() => guard(ledger, { maxTotalUsd: 1 }, ledger.now(), 'sandbox'), /billing is unknown/);
    assert.deepEqual(capStatus(ledger, { maxTotalUsd: 1 }, ledger.now()).lines.maxTotalUsd, { cap: 'maxTotalUsd', capUsd: 1, spentUsd: 0, unpriced: 1, remainingUsd: 0 });
    ledger.reserve(input({ caps: { maxDailySandboxUsd: 1 } }));
    writeFileSync(file, `${readFileSync(file, 'utf8')}incomplete\n`);
    assert.throws(() => ledger.reserve(input({ caps: { maxDailySandboxUsd: 1 } })), /corrupt or incomplete/);
  });

  it('releases a confirmed non-started request without phantom billed cost', () => {
    const { ledger } = fixture();
    const held = ledger.reserve(input());
    ledger.releaseReservation(held.id);
    ledger.reserve(input());
    assert.deepEqual([ledger.totals().usd, ledger.read().reservations.length], [0, 1]);
  });

  it('bills overlapping checkpoints and a stale terminal request only once', () => {
    const { ledger, advance } = fixture();
    const held = ledger.reserve(input({ boundUsd: 1, caps: { maxTotalUsd: 2 } }));
    ledger.bindReservation(held.id, 'same-vm');
    const from = new Date(ledger.now()).toISOString();
    const bill = (usd: number, seconds: number, checkpoint = false) => ledger.record({
      provider: 'boat', account, kind: 'sandbox', reservationId: held.id, sandboxId: 'same-vm',
      usd, seconds, estimated: true, multiplier: 1,
      lifetime: { from, to: new Date(ledger.now()).toISOString(), usdPerComputeHour: 1 },
      ...(checkpoint ? { checkpoint: true as const } : {}),
    });
    advance(900_000);
    bill(0.25, 900, true);
    advance(900_000);
    bill(0.5, 1800, true);
    advance(900_000);
    bill(0.75, 2700);
    bill(0.75, 2700);
    assert.deepEqual(ledger.read().events.map(e => [e.usd, e.seconds]), [[0.25, 900], [0.25, 900], [0.25, 900]]);
    assert.deepEqual([ledger.totals().usd, ledger.totals().seconds, ledger.read().corrupt, ledger.read().reservations.length], [0.75, 2700, 0, 0]);
  });

  it('coalesces recovery across controllers and holds unknown exposure through midnight until archival', () => {
    const { ledger, file, advance } = fixture();
    const start = new Date(ledger.now() - 36_000).toISOString();
    ledger.record({ provider: 'boat', account, kind: 'sandbox', sandboxId: 'legacy-live', seconds: 36, usd: 0.01, multiplier: 1, estimated: true, checkpoint: true });
    const recovery = { provider: 'boat' as const, account, sandboxId: 'legacy-live', start };
    const first = ledger.recoverLifetime(recovery);
    const second = openLedger(file).recoverLifetime(recovery);
    assert.equal(first, second);
    assert.equal(ledger.read().reservations.length, 1);
    assert.equal(ledger.read().reservations[0]?.remainingUsd, null);
    assert.throws(() => guard(ledger, { maxTotalUsd: 1 }, ledger.now(), 'model_call'), /active spending obligation is unknown/);
    advance(360_000);
    assert.throws(() => guard(ledger, { maxDailySandboxUsd: 1 }, ledger.now(), 'sandbox'), /active spending obligation is unknown/);
    assert.equal(capStatus(ledger, { maxDailySandboxUsd: 1 }, ledger.now()).lines.maxDailySandboxUsd?.unpriced, 1);
    const settled = { provider: 'boat' as const, account, kind: 'sandbox' as const, sandboxId: 'legacy-live', reservationId: first,
      seconds: 396, usd: 0.11, multiplier: 1, estimated: true,
      lifetime: { from: start, to: new Date(ledger.now()).toISOString(), usdPerComputeHour: 1 },
    };
    ledger.record(settled);
    openLedger(file).record(settled);
    assert.deepEqual([ledger.totals().usd, ledger.totals().seconds, ledger.totals().corrupt, ledger.read().reservations.length], [0.11, 396, 0, 0]);
    guard(ledger, { maxTotalUsd: 1 }, ledger.now(), 'sandbox');
  });

  it('allows recovering and settling a VM even when settled spend already exceeds the cap', () => {
    const { ledger, advance } = fixture();
    ledger.record({ provider: 'anthropic', account, kind: 'model_call', usd: 2, estimated: false });
    const start = new Date(ledger.now()).toISOString();
    const id = ledger.recoverLifetime({ provider: 'boat', account, sandboxId: 'cleanup-over-cap', start });
    advance(3_600_000);
    ledger.record({ provider: 'boat', account, kind: 'sandbox', sandboxId: 'cleanup-over-cap', reservationId: id, seconds: 3600, usd: 1, multiplier: 1, estimated: true, lifetime: { from: start, to: new Date(ledger.now()).toISOString(), usdPerComputeHour: 1 } });
    assert.deepEqual([ledger.totals().usd, ledger.read().reservations.length], [3, 0]);
    assert.throws(() => guard(ledger, { maxTotalUsd: 1 }, ledger.now(), 'sandbox'), /spend cap/);
  });

  for (const kind of ['sandbox', 'model_call'] as const) it(`admits exactly one of two simultaneous ${kind} controller processes sharing a one-dollar cap`, async () => {
    const { dir, file, ledger } = fixture();
    const script = join(dir, 'claim.mjs');
    const module = new URL('../src/costs/ledger.ts', import.meta.url).href;
    const claim = kind === 'sandbox' ? `reserve(${JSON.stringify(input())})` : `startModel(${JSON.stringify({ provider: 'anthropic', account, caps: { maxTotalUsd: 1 } })})`;
    writeFileSync(script, `import {openLedger} from ${JSON.stringify(module)};\nprocess.stdout.write('ready\\n');\nprocess.stdin.once('data',()=>{try {openLedger(process.argv[2]).${claim}; console.log('admitted');} catch(e) {if(e.name!=='SpendCapError' && !e.message.includes('active spending obligation is unknown')) throw e;console.log('denied');} process.stdin.destroy();});\n`);
    const workers = [0, 1].map(() => {
      const child = spawn(process.execPath, [script, file], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let error = '';
      let ready: () => void = () => {};
      const started = new Promise<void>(resolve => { ready = resolve; });
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) ready(); });
      child.stderr.on('data', chunk => { error += String(chunk); });
      const done = new Promise<string>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(output.trim().split('\n').at(-1) ?? '') : reject(new Error(error)));
      });
      return { child, started, done };
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const completed = (async () => {
      await Promise.all(workers.map(w => w.started));
      for (const worker of workers) worker.child.stdin.end('start\n');
      return Promise.all(workers.map(w => w.done));
    })();
    const stalled = new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('admission controllers did not finish within 30s')), 30_000); });
    try {
      assert.deepEqual((await Promise.race([completed, stalled])).sort(), ['admitted', 'denied']);
      assert.deepEqual([ledger.read().reservations.length, ledger.read().reservations[0]?.remainingUsd, ledger.totals().usd], [1, kind === 'sandbox' ? 0.75 : null, 0]);
    } finally {
      clearTimeout(watchdog);
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
      await Promise.allSettled(workers.map(w => w.done));
    }
  });
});
