import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { BoatClient, BoatInspection } from '../src/boat/client.ts';
import { capStatus, groupEvents, openLedger, type ReconciliationInput } from '../src/costs/ledger.ts';
import { downDetached, reconcileBoatUsage } from '../src/sandboxes/registry.ts';

const account = 'sha256:000000000001';
const inspector = 'sha256:000000000002';
const createdAt = '2026-10-06T23:30:00.000Z';
const closedAt = '2026-10-07T01:00:00.000Z';
const midnight = '2026-10-07T00:00:00.000Z';
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture(mark = true, withOther = false) {
  const dir = mkdtempSync(join(tmpdir(), 'boat-reconcile-'));
  dirs.push(dir);
  const file = join(dir, 'costs.jsonl');
  const ledger = openLedger(file, { now: () => Date.parse(closedAt) });
  if (withOther) {
    const other = ledger.reserve({ provider: 'boat', account, kind: 'sandbox', boundUsd: 0.1, caps: {} });
    ledger.bindReservation(other.id, 'sb_other');
  }
  const id = ledger.observeSandbox({ account, sandboxId: 'sb_closed', caps: { maxTotalUsd: 1 } });
  if (mark) ledger.markSandboxClosed(id, 'sb_closed');
  const input: ReconciliationInput = { reservationId: id, sandboxId: 'sb_closed', inspectionAccount: inspector, createdAt, closedAt, receipts: [
    { since: createdAt, until: midnight, billableSeconds: 3600, listPriceUsd: 0.036, secondsPerDollar: 100000, sandboxType: 'large', running: false },
    { since: midnight, until: closedAt, billableSeconds: 7200, listPriceUsd: 0.072, secondsPerDollar: 100000, sandboxType: 'large', running: false },
  ] };
  return { dir, file, ledger, id, input };
}
function inspection(): BoatInspection {
  return {
    async inventory() { return [{ id: 'sb_closed', state: 'archived', access: 'owner', createdAt }]; },
    async usage(sandboxId, window) {
      assert.equal(sandboxId, 'sb_closed');
      assert.ok(window);
      const seconds = window.since === createdAt ? 3600 : 7200;
      return { sandboxId, since: window.since, until: window.until, sandboxType: 'large', billingMultiplier: 2, seconds, dollars: seconds === 3600 ? 0.036 : 0.072, secondsPerDollar: 100000, running: false };
    },
  };
}

describe('verified Boat usage reconciliation', () => {
  it('replaces covered cross-key estimates with one charge per UTC slice and restores admission', () => {
    const f = fixture();
    f.ledger.record({ provider: 'boat', account, kind: 'sandbox', sandboxId: 'sb_closed', seconds: 5400, usd: 0.9, estimated: true, checkpoint: true });
    f.ledger.record({ provider: 'anthropic', account, kind: 'model_call', usd: 0.05, estimated: true });
    f.ledger.reconcileSandbox(f.input);
    const reopened = openLedger(f.file, { now: () => Date.parse(closedAt) });
    assert.deepEqual([reopened.totals().usd, reopened.totals().seconds, reopened.totals().events, reopened.read().reservations.length, reopened.read().corrupt], [0.158, 0, 3, 0, 0]);
    assert.deepEqual(groupEvents(reopened.read().events.filter(e => e.provider === 'boat'), 'day'), [
      { key: '2026-10-06', usd: 0.036, events: 1, estimated: 1, unpriced: 0, unpricedSeconds: 0 },
      { key: '2026-10-07', usd: 0.072, events: 1, estimated: 1, unpriced: 0, unpricedSeconds: 0 },
    ]);
    assert.deepEqual(reopened.read().events.filter(e => e.boatUsage !== undefined).map(e => [e.account, e.boatUsage?.billableSeconds, e.usd, e.boatUsage?.priceBasis]), [[inspector, 3600, 0.036, 'provider_list_usage'], [inspector, 7200, 0.072, 'provider_list_usage']]);
    assert.equal(reopened.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } }).maxCostUsd, 0.842);
    assert.equal(readFileSync(f.file, 'utf8').includes('"usd":0.9'), true);
  });

  it('is idempotent and preserves unrelated VM exposure and unknown model billing', () => {
    const f = fixture(true, true);
    f.ledger.record({ provider: 'anthropic', account, kind: 'model_call', usd: null, estimated: 'unpriced' });
    f.ledger.reconcileSandbox(f.input);
    f.ledger.reconcileSandbox(f.input);
    assert.deepEqual([f.ledger.totals().usd, f.ledger.totals().events, f.ledger.read().reservations.length, f.ledger.read().corrupt], [0.108, 3, 1, 0]);
    assert.equal(f.ledger.read().reservations[0]?.sandboxId, 'sb_other');
    assert.throws(() => f.ledger.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } }), /billing is unknown/);
  });

  it('requires exact gap-free coverage and refuses an unmarked or newly observed lifetime', () => {
    const unmarked = fixture(false);
    assert.throws(() => unmarked.ledger.reconcileSandbox(unmarked.input), /verified closure is missing/);
    const f = fixture();
    const before = readFileSync(f.file, 'utf8');
    const first = f.input.receipts[0];
    assert.ok(first);
    assert.throws(() => f.ledger.reconcileSandbox({ ...f.input, receipts: [first] }), /gap-free UTC slices/);
    assert.throws(() => f.ledger.reconcileSandbox({ ...f.input, receipts: [{ ...first, until: closedAt }] }), /gap-free UTC slices/);
    assert.equal(readFileSync(f.file, 'utf8'), before);
    f.ledger.observeSandbox({ account: inspector, sandboxId: 'sb_closed', caps: {} });
    assert.equal(f.ledger.read().reservations[0]?.closedAt, undefined);
    assert.throws(() => f.ledger.reconcileSandbox(f.input), /verified closure is missing or changed/);
    assert.equal(f.ledger.read().reservations.length, 1);
  });

  it('refuses existing VM evidence outside the verified lifetime without partially replacing it', () => {
    const f = fixture();
    f.ledger.append({ t: '2026-10-06T22:00:00.000Z', provider: 'boat', account, kind: 'sandbox', sandboxId: 'sb_closed', usd: 0.4, estimated: true });
    assert.throws(() => f.ledger.reconcileSandbox(f.input), /outside receipt coverage/);
    assert.deepEqual([f.ledger.totals().usd, f.ledger.totals().events, f.ledger.read().reservations.length], [0.4, 1, 1]);
  });

  it('requests exact creation-to-cutoff slices and replays the specific reconciled claim without new requests', async () => {
    const f = fixture();
    const api = inspection();
    const calls: unknown[] = [];
    const deps = { env: { BOAT_API_KEY: 'synthetic-reconciliation-key' }, backendOptions: { ledger: f.ledger }, boatInspection: { ...api,
      async usage(id: string, window?: { since: string; until: string }) { calls.push(window); return api.usage(id, window); },
    } };
    const result = await reconcileBoatUsage(f.id, deps);
    assert.deepEqual(calls, [{ since: createdAt, until: midnight }, { since: midnight, until: closedAt }]);
    assert.equal(result.alreadyReconciled, false);
    assert.equal((await reconcileBoatUsage(f.id, deps)).alreadyReconciled, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(capStatus(f.ledger, { maxDailySandboxUsd: 1 }, f.ledger.now()).lines.maxDailySandboxUsd, { cap: 'maxDailySandboxUsd', capUsd: 1, spentUsd: 0.072, remainingUsd: 0.928 });
  });

  for (const outcome of ['partial', 'paused', 'identity_change', 'new_observation'] as const) it(`retains exposure on ${outcome} evidence`, async () => {
    const f = fixture();
    const api = inspection();
    let reads = 0;
    const deps = { env: { BOAT_API_KEY: 'synthetic-reconciliation-key' }, backendOptions: { ledger: f.ledger }, boatInspection: { ...api,
      async inventory() {
        reads += 1;
        return [{ id: 'sb_closed', state: outcome === 'paused' ? 'idle' as const : 'archived' as const, access: 'owner' as const, createdAt: outcome === 'identity_change' && reads > 1 ? '2026-10-06T23:00:00.000Z' : createdAt }];
      },
      async usage(id: string, window?: { since: string; until: string }) {
        const receipt = await api.usage(id, window);
        if (outcome === 'new_observation') f.ledger.observeSandbox({ account, sandboxId: 'sb_closed', caps: {} });
        return outcome === 'partial' ? { ...receipt, until: '2026-10-06T23:45:00.000Z' } : receipt;
      },
    } };
    await assert.rejects(reconcileBoatUsage(f.id, deps));
    assert.deepEqual([f.ledger.totals().events, f.ledger.read().reservations.length, f.ledger.read().corrupt], [0, 1, 0]);
  });

  it('records closure only after verified archival while keeping unknown billing unresolved', async () => {
    const f = fixture(false);
    let confirmed = false;
    const unexpected = async () => { throw new Error('unexpected VM operation'); };
    const client: BoatClient = { create: unexpected, waitReady: unexpected, exec: unexpected, start: unexpected, writeFile: unexpected, expose: unexpected,
      async stop() {}, async waitStopped() { if (!confirmed) throw new Error('not archived'); } };
    const deps = { env: { BOAT_API_KEY: 'synthetic-reconciliation-key', WORLDGEN_COSTS_FILE: f.file }, backendOptions: { ledger: f.ledger, boatClient: client } };
    await assert.rejects(downDetached('sb_closed', deps), /not archived/);
    assert.equal(f.ledger.read().reservations[0]?.closedAt, undefined);
    confirmed = true;
    await downDetached('sb_closed', deps);
    assert.equal(f.ledger.read().reservations[0]?.closedAt, closedAt);
    assert.deepEqual([f.ledger.totals().events, f.ledger.read().reservations.length], [0, 1]);
  });
});
