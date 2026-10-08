/**
 * `sandbox reconcile-orphans`: owned Boat VMs that nothing will close, with a fake BoatInspection and
 * BoatClient whose inventory reflects stops, and a ledger in a temp directory. The CLI test serves a fake
 * boat.dev API on loopback. No test here reads BOAT_API_KEY from the process or reaches boat.dev.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BoatError, type BoatClient, type BoatInspection, type BoatInventorySandbox } from '../src/boat/client.ts';
import { openLedger, type Ledger } from '../src/costs/ledger.ts';
import { backendFor, reconcileOrphans, recordsDir, saveRecord, trackBoat } from '../src/sandboxes/registry.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const KEY = 'boat-test-key-0007';
/** sha256('boat-test-key-0007'), first 12 hex. */
const ACCOUNT = 'sha256:ae6f7672b69f';
const OTHER_ACCOUNT = 'sha256:000000000002';
const NOW = '2026-10-08T03:00:00.000Z';
const PRICING = { size: 'small', multiplier: 0.5, usdPerComputeHour: 1, maxLifetimeSeconds: 1800, idempotentCreate: true } as const;
const UNKNOWN = { billing: 'unknown', usd: null } as const;

let tmp = '';
before(async () => { tmp = await mkdtemp(path.join(tmpdir(), 'worldgen-orphans-')); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

async function fixture(name: string) {
  const dir = await mkdtemp(path.join(tmp, `${name}-`));
  const file = path.join(dir, 'costs.jsonl');
  const env = { BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', WORLDGEN_COSTS_FILE: file, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '1' };
  return { dir, file, env, ledger: openLedger(file, { now: () => Date.parse(NOW) }), at: (iso: string) => openLedger(file, { now: () => Date.parse(iso) }) };
}

function fakeBoat(vms: readonly BoatInventorySandbox[], stop: (id: string) => Promise<void> = async () => undefined) {
  const calls: unknown[][] = [];
  const inventory = new Map(vms.map(vm => [vm.id, vm]));
  const refuse = async (): Promise<never> => { throw new Error('reconcile-orphans must only stop VMs'); };
  const inspection: BoatInspection = {
    async inventory(org) { calls.push(['inventory', org]); return [...inventory.values()]; },
    usage: refuse,
  };
  const client: BoatClient = {
    create: refuse, waitReady: refuse, exec: refuse, start: refuse, writeFile: refuse, expose: refuse,
    async stop(id) { calls.push(['stop', id]); await stop(id); },
    async waitStopped(id) {
      calls.push(['waitStopped', id]);
      const vm = inventory.get(id);
      if (vm !== undefined) inventory.set(id, { ...vm, state: 'archived' });
    },
  };
  return { calls, inventory, inspection, client };
}

const lines = async (file: string): Promise<unknown[]> => (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
const observation = (ledger: Ledger, id: string) => ledger.read().reservations.find(r => r.origin === 'inventory' && r.sandboxId === id);
const depsOf = (f: { env: Record<string, string>; ledger: Ledger }, boat: { inspection: BoatInspection; client: BoatClient }) =>
  ({ env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } });

describe('reconcile-orphans', () => {
  const mixed = async (name: string) => {
    const f = await fixture(name);
    await saveRecord(recordsDir(f.env), { id: 'sb_record', kind: 'boat', size: 'small', start: Date.parse('2026-10-08T02:00:00.000Z'), workdir: '/tmp/worldgen' });
    await writeFile(path.join(recordsDir(f.env), 'sb_closing.lock'), `${JSON.stringify({ pid: process.pid })}\n`);
    const claim = f.ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    f.ledger.bindReservation(claim.id, 'sb_claim');
    f.ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', sandboxId: 'sb_settled', usd: 0.1, estimated: true });
    const boat = fakeBoat([
      { id: 'sb_orphan', state: 'running', access: 'owner', createdAt: '2026-10-07T20:00:00.000Z', team: { id: 'org_test' } },
      { id: 'sb_archived', state: 'archived', access: 'owner', createdAt: null },
      { id: 'sb_archiving', state: 'archiving', access: 'owner', createdAt: null },
      { id: 'sb_settled', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_record', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_closing', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_claim', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_teammate', state: 'running', access: 'use', createdAt: null },
    ]);
    return { ...f, ...boat, deps: depsOf(f, boat) };
  };
  const planned = (orphanAction: string) => [
    { id: 'sb_orphan', state: 'running', verdict: { kind: 'orphan', evidence: 'untracked', archived: false }, action: orphanAction },
    { id: 'sb_archived', state: 'archived', verdict: { kind: 'archived' }, action: 'none' },
    { id: 'sb_archiving', state: 'archiving', verdict: { kind: 'archiving' }, action: 'none' },
    { id: 'sb_settled', state: 'running', verdict: { kind: 'settled' }, action: 'none' },
    { id: 'sb_record', state: 'running', verdict: { kind: 'kept', owner: 'record' }, action: 'none' },
    { id: 'sb_closing', state: 'running', verdict: { kind: 'kept', owner: 'closing' }, action: 'none' },
    { id: 'sb_claim', state: 'running', verdict: { kind: 'kept', owner: 'claim', until: '2026-10-08T03:30:00.000Z' }, action: 'none' },
    { id: 'sb_teammate', state: 'running', verdict: { kind: 'not_owner' }, action: 'none' },
  ];

  it('a dry run classifies every VM and changes nothing: no provider mutation, no ledger line, no receipt file', async () => {
    const s = await mixed('dry');
    const before = await readFile(s.file, 'utf8');
    const result = await reconcileOrphans(s.deps, { apply: false });
    assert.deepEqual(result, { wallet: 'org_test', dryRun: true, ledgerCorrupt: 0, receiptsFile: `${s.file}.boat-orphans.jsonl`, rows: planned('needs_id'), receipts: [], next: [] });
    assert.deepEqual(s.calls, [['inventory', 'org_test']]);
    assert.equal(await readFile(s.file, 'utf8'), before);
    assert.equal(existsSync(`${s.file}.boat-orphans.jsonl`), false);
    assert.deepEqual((await readdir(recordsDir(s.env))).sort(), ['sb_closing.lock', 'sb_record.json']);
  });

  it('P1: apply without --id leaves a live VM no metered owner explains, such as an unmetered script VM, running', async () => {
    const s = await mixed('unmetered');
    const before = await readFile(s.file, 'utf8');
    const result = await reconcileOrphans(s.deps, { apply: true });
    assert.deepEqual([result.rows, result.receipts, result.next], [planned('needs_id'), [], []]);
    assert.deepEqual(s.calls, [['inventory', 'org_test']]);
    assert.equal(await readFile(s.file, 'utf8'), before);
    assert.equal(existsSync(result.receiptsFile), false);
  });

  it('apply --id archives the named VM with an intent and an outcome receipt, names reconcile-usage, and a rerun changes nothing', async () => {
    const s = await mixed('named');
    const result = await reconcileOrphans(s.deps, { apply: true, org: 'org_test', ids: ['sb_orphan'] });
    assert.deepEqual(s.calls, [['inventory', 'org_test'], ['stop', 'sb_orphan'], ['waitStopped', 'sb_orphan']]);
    const observed = observation(s.ledger, 'sb_orphan');
    assert.ok(observed);
    const base = { version: 1, sandboxId: 'sb_orphan', evidence: 'untracked', at: NOW, inspectionAccount: ACCOUNT, walletId: 'org_test', reservationId: observed.id, costBasis: UNKNOWN };
    const receipts = [{ ...base, action: 'archive_started' }, { ...base, action: 'archived' }];
    assert.deepEqual(result, { wallet: 'org_test', dryRun: false, ledgerCorrupt: 0, receiptsFile: `${s.file}.boat-orphans.jsonl`, rows: planned('archive'), receipts, next: [`bun run sandbox -- reconcile-usage ${observed.id}`] });
    assert.deepEqual(await lines(result.receiptsFile), receipts);
    assert.equal(observed.closedAt, NOW);
    assert.deepEqual((await readdir(recordsDir(s.env))).sort(), ['sb_closing.lock', 'sb_record.json']);

    const again = await reconcileOrphans(s.deps, { apply: true });
    assert.deepEqual(s.calls.slice(3), [['inventory', 'org_test']]);
    assert.deepEqual([again.receipts, again.rows[0]], [[], { id: 'sb_orphan', state: 'archived', verdict: { kind: 'archived' }, action: 'none' }]);
    assert.deepEqual(await lines(result.receiptsFile), receipts);
  });

  it('a tracked VM that is still running also needs --id, because track observes unmetered VMs too', async () => {
    const f = await fixture('tracked');
    const id = f.ledger.observeSandbox({ account: ACCOUNT, sandboxId: 'sb_tracked', caps: {} });
    const boat = fakeBoat([{ id: 'sb_tracked', state: 'running', access: 'owner', createdAt: null }]);
    const listed = await reconcileOrphans(depsOf(f, boat), { apply: true });
    assert.deepEqual([listed.rows, listed.receipts], [[{ id: 'sb_tracked', state: 'running', verdict: { kind: 'orphan', evidence: 'tracked', archived: false }, action: 'needs_id' }], []]);
    const named = await reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_tracked'] });
    const base = { version: 1, sandboxId: 'sb_tracked', evidence: 'tracked', at: NOW, inspectionAccount: ACCOUNT, reservationId: id, costBasis: UNKNOWN };
    assert.deepEqual([named.receipts, named.next], [[{ ...base, action: 'archive_started' }, { ...base, action: 'archived' }], [`bun run sandbox -- discover  # Boat reports no creation time for sb_tracked, so reconcile-usage ${id} would refuse; rerun it once discover shows one, and until then its billing stays unknown`]]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test'], ['inventory', 'org_test'], ['stop', 'sb_tracked'], ['waitStopped', 'sb_tracked']]);
  });

  it('closes the observation of a VM Boat already archived without a provider call', async () => {
    const f = await fixture('already');
    const id = f.ledger.observeSandbox({ account: ACCOUNT, sandboxId: 'sb_gone', caps: {} });
    const boat = fakeBoat([{ id: 'sb_gone', state: 'archived', access: 'owner', createdAt: null }]);
    const result = await reconcileOrphans(depsOf(f, boat), { apply: true });
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
    assert.deepEqual(result.rows, [{ id: 'sb_gone', state: 'archived', verdict: { kind: 'orphan', evidence: 'tracked', archived: true }, action: 'close' }]);
    const base = { version: 1, sandboxId: 'sb_gone', evidence: 'tracked', at: NOW, inspectionAccount: ACCOUNT, reservationId: id, costBasis: UNKNOWN };
    const receipts = [{ ...base, action: 'close_started' }, { ...base, action: 'already_archived' }];
    assert.deepEqual([result.receipts, result.next], [receipts, [`bun run sandbox -- discover  # Boat reports no creation time for sb_gone, so reconcile-usage ${id} would refuse; rerun it once discover shows one, and until then its billing stays unknown`]]);
    assert.deepEqual(await lines(result.receiptsFile), receipts);
    assert.equal(observation(f.ledger, 'sb_gone')?.closedAt, NOW);
    assert.deepEqual((await reconcileOrphans(depsOf(f, boat), { apply: true })).rows[0]?.verdict, { kind: 'archived' });
  });

  it('P5: archives a VM whose admission claim outlived its TTL, and its receipt keeps billing unknown although the meter settles at the TTL bound', async () => {
    const f = await fixture('expired');
    const earlier = f.at('2026-10-08T02:00:00.000Z');
    const claim = earlier.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    earlier.bindReservation(claim.id, 'sb_expired');
    const boat = fakeBoat([{ id: 'sb_expired', state: 'running', access: 'owner', createdAt: '2026-10-08T02:00:01.000Z' }]);
    assert.deepEqual((await reconcileOrphans(depsOf(f, boat), { apply: false })).rows, [{ id: 'sb_expired', state: 'running', verdict: { kind: 'orphan', evidence: 'claim_expired', archived: false }, action: 'archive' }]);
    const result = await reconcileOrphans(depsOf(f, boat), { apply: true });
    assert.deepEqual(boat.calls, [['inventory', 'org_test'], ['inventory', 'org_test'], ['stop', 'sb_expired'], ['waitStopped', 'sb_expired']]);
    const base = { version: 1, sandboxId: 'sb_expired', evidence: 'claim_expired', at: NOW, inspectionAccount: ACCOUNT, reservationId: claim.id, costBasis: UNKNOWN };
    assert.deepEqual(result.receipts, [{ ...base, action: 'archive_started' }, { ...base, action: 'archived' }]);
    assert.deepEqual(result.next, [`bun run sandbox -- capture-usage --day 2026-10-08  # claim ${claim.id} settled at its TTL bound; its overrun past that bound is unknown and outside the caps, because reconcile-usage refuses an admission claim and capture-usage records evidence only`]);
    assert.deepEqual([f.ledger.read().reservations.length, f.ledger.totals().usd, f.ledger.totals().seconds], [0, 0.25, 1800]);
  });

  it('reports an expired claim of another Boat key and leaves it, run after run', async () => {
    const f = await fixture('foreign');
    const earlier = f.at('2026-10-08T02:00:00.000Z');
    const claim = earlier.reserve({ provider: 'boat', account: OTHER_ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    earlier.bindReservation(claim.id, 'sb_foreign');
    const boat = fakeBoat([{ id: 'sb_foreign', state: 'running', access: 'owner', createdAt: null }]);
    for (let run = 0; run < 2; run += 1) {
      const result = await reconcileOrphans(depsOf(f, boat), { apply: true });
      assert.deepEqual([result.rows, result.receipts], [[{ id: 'sb_foreign', state: 'running', verdict: { kind: 'orphan', evidence: 'claim_expired', archived: false }, action: 'other_key' }], []]);
    }
    assert.deepEqual(boat.calls, [['inventory', 'org_test'], ['inventory', 'org_test']]);
    assert.equal(existsSync(`${f.file}.boat-orphans.jsonl`), false);
  });

  it('P2: skips a VM its owner settled between the inventory and the ledger read, so no unknown hold blocks capped runs', async () => {
    const f = await fixture('settled');
    const t0 = '2026-10-08T02:50:00.000Z';
    const owner = f.at(t0);
    const claim = owner.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    owner.bindReservation(claim.id, 'sb_race');
    const boat = fakeBoat([{ id: 'sb_race', state: 'running', access: 'owner', createdAt: '2026-10-08T02:50:01.000Z', team: { id: 'org_test' } }]);
    const inspection: BoatInspection = {
      ...boat.inspection,
      async inventory(org) {
        const listed = await boat.inspection.inventory(org);
        f.ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', sandboxId: 'sb_race', reservationId: claim.id, size: 'small', multiplier: 0.5, seconds: 600, usd: 0.0833, estimated: true,
          lifetime: { from: t0, to: NOW, usdPerComputeHour: 1 } });
        boat.inventory.set('sb_race', { ...listed[0]!, state: 'archived' });
        return listed;
      },
    };
    const deps = { ...depsOf(f, boat), boatInspection: inspection };
    const result = await reconcileOrphans(deps, { apply: true });
    assert.deepEqual([result.rows, result.receipts], [[{ id: 'sb_race', state: 'running', verdict: { kind: 'settled' }, action: 'none' }], []]);
    assert.equal(observation(f.ledger, 'sb_race'), undefined);
    assert.ok(f.ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.1, caps: { maxDailySandboxUsd: 5 } }).id);
    boat.inventory.set('sb_race', { id: 'sb_race', state: 'running', access: 'owner', createdAt: null });
    await assert.rejects(reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_race'] }), /--id sb_race names a VM reconcile-orphans will not archive \(settled\)/);
    assert.equal(observation(f.ledger, 'sb_race'), undefined);
    assert.deepEqual(boat.calls.filter(c => c[0] === 'stop'), []);
  });

  it('P3: leaves a VM Boat is archiving alone, with no ledger trace or not', async () => {
    const f = await fixture('archiving');
    const boat = fakeBoat([{ id: 'sb_arch', state: 'archiving', access: 'owner', createdAt: null }]);
    const result = await reconcileOrphans(depsOf(f, boat), { apply: true });
    assert.deepEqual([result.rows, result.receipts], [[{ id: 'sb_arch', state: 'archiving', verdict: { kind: 'archiving' }, action: 'none' }], []]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
  });

  it('P4: refuses before any ledger write or stop when the receipt journal cannot be written, then acts once it can', async () => {
    const f = await fixture('journal');
    await mkdir(`${f.file}.boat-orphans.jsonl`, { recursive: true });
    const boat = fakeBoat([{ id: 'sb_lost', state: 'running', access: 'owner', createdAt: null }]);
    await assert.rejects(reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_lost'] }), /EISDIR/);
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
    assert.equal(existsSync(f.file), false);
    await rm(`${f.file}.boat-orphans.jsonl`, { recursive: true });
    const again = await reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_lost'] });
    assert.deepEqual(again.receipts.map(r => r.action), ['archive_started', 'archived']);
    assert.deepEqual(await lines(again.receiptsFile), again.receipts);
  });

  it('keeps an untracked VM while an unbound claim within its TTL may be creating it, and not after that TTL', async () => {
    const f = await fixture('pending');
    f.ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    const boat = fakeBoat([{ id: 'sb_unknown', state: 'running', access: 'owner', createdAt: null }]);
    const result = await reconcileOrphans(depsOf(f, boat), { apply: true });
    assert.deepEqual([result.rows, result.receipts], [[{ id: 'sb_unknown', state: 'running', verdict: { kind: 'kept', owner: 'pending_create' }, action: 'none' }], []]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
    await assert.rejects(reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_unknown'] }), /will not archive \(kept: pending_create\)/);

    const stale = await fixture('pending-stale');
    stale.at('2026-10-08T02:00:00.000Z').reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    const later = await reconcileOrphans(depsOf(stale, boat), { apply: false });
    assert.deepEqual(later.rows[0], { id: 'sb_unknown', state: 'running', verdict: { kind: 'orphan', evidence: 'untracked', archived: false }, action: 'needs_id' });
  });

  it('reads the ledger after the inventory, so a VM created while the inventory is read keeps its claim', async () => {
    const f = await fixture('racing');
    const boat = fakeBoat([
      { id: 'sb_new', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_bound', state: 'running', access: 'owner', createdAt: null },
    ]);
    // The meter reserves before it creates and binds after; both creates land while Boat lists the VMs.
    const inspection: BoatInspection = {
      ...boat.inspection,
      async inventory(org) {
        f.ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
        const bound = f.ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
        f.ledger.bindReservation(bound.id, 'sb_bound');
        return boat.inspection.inventory(org);
      },
    };
    const result = await reconcileOrphans({ ...depsOf(f, boat), boatInspection: inspection }, { apply: true });
    assert.deepEqual([result.rows, result.receipts], [[
      { id: 'sb_new', state: 'running', verdict: { kind: 'kept', owner: 'pending_create' }, action: 'none' },
      { id: 'sb_bound', state: 'running', verdict: { kind: 'kept', owner: 'claim', until: '2026-10-08T03:30:00.000Z' }, action: 'none' },
    ], []]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
  });

  it('records a failed stop as archive_failed with unknown billing, keeps the observation open, and a named rerun archives it', async () => {
    const f = await fixture('failed');
    let refuse = true;
    const boat = fakeBoat([{ id: 'sb_stuck', state: 'running', access: 'owner', createdAt: null }], async () => { if (refuse) throw new BoatError('boat.dev stop failed: HTTP 503\n<html>busy</html>'); });
    const failed = await reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_stuck'] });
    const id = observation(f.ledger, 'sb_stuck')?.id;
    assert.ok(id);
    const first = { version: 1, sandboxId: 'sb_stuck', evidence: 'untracked', at: NOW, inspectionAccount: ACCOUNT, reservationId: id, costBasis: UNKNOWN };
    assert.deepEqual([failed.receipts, failed.next], [[{ ...first, action: 'archive_started' }, { ...first, action: 'archive_failed', error: 'boat.dev stop failed: HTTP 503' }], ['bun run sandbox -- reconcile-orphans --apply --id sb_stuck']]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test'], ['stop', 'sb_stuck']]);
    assert.equal(observation(f.ledger, 'sb_stuck')?.closedAt, undefined);
    refuse = false;
    const retried = await reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_stuck'] });
    const second = { ...first, evidence: 'tracked' };
    assert.deepEqual(retried.receipts, [{ ...second, action: 'archive_started' }, { ...second, action: 'archived' }]);
    assert.deepEqual(await lines(failed.receiptsFile), [...failed.receipts, ...retried.receipts]);
    assert.equal(observation(f.ledger, 'sb_stuck')?.closedAt, NOW);
  });

  it('refuses --apply with an --org other than WORLDGEN_BOAT_ORG before any provider call, and a dry run may list another org', async () => {
    const f = await fixture('org');
    const boat = fakeBoat([{ id: 'sb_elsewhere', state: 'running', access: 'owner', createdAt: null }]);
    await assert.rejects(reconcileOrphans(depsOf(f, boat), { apply: true, org: 'org_other', ids: ['sb_elsewhere'] }),
      /--apply refused: --org org_other differs from WORLDGEN_BOAT_ORG org_test/);
    assert.deepEqual(boat.calls, []);
    assert.equal((await reconcileOrphans(depsOf(f, boat), { apply: false, org: 'org_other' })).wallet, 'org_other');
    assert.deepEqual(boat.calls, [['inventory', 'org_other']]);
  });

  it('refuses an --id that is not in the inventory, or that names a kept VM, before acting on any VM', async () => {
    const s = await mixed('ids');
    await assert.rejects(reconcileOrphans(s.deps, { apply: true, ids: ['sb_orphan', 'sb_missing'] }), /--id sb_missing is not in the Boat inventory of org_test/);
    await assert.rejects(reconcileOrphans(s.deps, { apply: true, ids: ['sb_orphan', 'sb_record'] }), /--id sb_record names a VM reconcile-orphans will not archive \(kept: record\)/);
    assert.deepEqual(s.calls.filter(c => c[0] !== 'inventory'), []);
    assert.equal(observation(s.ledger, 'sb_orphan'), undefined);
  });

  it('H1: keeps a tracked VM while a live metered controller is still creating it, and --id refuses it', async () => {
    const f = await fixture('creating');
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let created!: () => void;
    const createdNow = new Promise<void>((resolve) => { created = resolve; });
    const boat = fakeBoat([]);
    const client: BoatClient = {
      ...boat.client,
      async create() { boat.inventory.set('sb_ci', { id: 'sb_ci', state: 'running', access: 'owner', createdAt: null }); created(); return { sandboxId: 'sb_ci' }; },
      async waitReady() { await gate; },
      async exec(_id, command) { return { exitCode: 0, stdout: command.includes('node') ? 'v22.1.0\n' : '', stderr: '', timedOut: false }; },
      async writeFile() {},
    };
    const env = { ...f.env, WORLDGEN_MAX_DAILY_SANDBOX_USD: '10' };
    const up = backendFor('boat', env, undefined, { size: 'large', ttlSeconds: 7200, ledger: f.ledger, boatClient: client, flushOnExit: false }).backend
      .up([{ path: 'repo.tgz', data: Buffer.from('x') }], { name: 'boat-ci' });
    await createdNow;
    const deps = { env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: client, flushOnExit: false } };
    await trackBoat(deps);
    const result = await reconcileOrphans(deps, { apply: true });
    assert.deepEqual([result.rows, result.receipts], [[{ id: 'sb_ci', state: 'running', verdict: { kind: 'kept', owner: 'pending_create' }, action: 'none' }], []]);
    await assert.rejects(reconcileOrphans(deps, { apply: true, ids: ['sb_ci'] }), /--id sb_ci names a VM reconcile-orphans will not archive \(kept: pending_create\)/);
    assert.deepEqual(boat.calls.filter(c => c[0] === 'stop'), []);
    open();
    await up;
  });

  it('H2: a close recorded before the listing, such as a claim released by hand while its VM runs, does not make the VM settled', async () => {
    const f = await fixture('released');
    const earlier = f.at('2026-10-08T02:00:00.000Z');
    const claim = earlier.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    earlier.bindReservation(claim.id, 'sb_released');
    earlier.releaseClaim(claim.id, 0.1, true);
    const boat = fakeBoat([{ id: 'sb_released', state: 'running', access: 'owner', createdAt: '2026-10-08T02:00:01.000Z' }]);
    const listed = await reconcileOrphans(depsOf(f, boat), { apply: true });
    assert.deepEqual([listed.rows, listed.receipts], [[{ id: 'sb_released', state: 'running', verdict: { kind: 'orphan', evidence: 'untracked', archived: false }, action: 'needs_id' }], []]);
    const named = await reconcileOrphans(depsOf(f, boat), { apply: true, ids: ['sb_released'] });
    assert.deepEqual(named.receipts.map(r => r.action), ['archive_started', 'archived']);
    assert.deepEqual(boat.calls.filter(c => c[0] === 'stop'), [['stop', 'sb_released']]);
  });

  it('H3: the rerun printed for a failed close has no --id, and that rerun closes it', async () => {
    const f = await fixture('close-failed');
    const id = f.ledger.observeSandbox({ account: ACCOUNT, sandboxId: 'sb_gone', caps: {} });
    const boat = fakeBoat([{ id: 'sb_gone', state: 'archived', access: 'owner', createdAt: '2026-10-08T01:00:00.000Z' }]);
    const flaky: Ledger = { ...f.ledger, markSandboxClosed: () => { throw new Error('disk full'); } };
    const failed = await reconcileOrphans(depsOf({ env: f.env, ledger: flaky }, boat), { apply: true });
    assert.deepEqual([failed.receipts.map(r => r.action), failed.next], [['close_started', 'archive_failed'], ['bun run sandbox -- reconcile-orphans --apply']]);
    const rerun = await reconcileOrphans(depsOf(f, boat), { apply: true });
    assert.deepEqual([rerun.receipts.map(r => r.action), rerun.next], [['close_started', 'already_archived'], [`bun run sandbox -- reconcile-usage ${id}`]]);
    assert.equal(observation(f.ledger, 'sb_gone')?.closedAt, NOW);
  });

  it('P4: a run that crashed after the archive and before its outcome gets the outcome written on the next run, once Boat shows the VM archived', async () => {
    const f = await fixture('recover');
    const receiptsFile = `${f.file}.boat-orphans.jsonl`;
    const boat = fakeBoat([{ id: 'sb_lost', state: 'running', access: 'owner', createdAt: null }]);
    const client: BoatClient = { ...boat.client, async waitStopped(id) { await boat.client.waitStopped(id); await chmod(receiptsFile, 0o400); } };
    const deps = { ...depsOf(f, boat), backendOptions: { ledger: f.ledger, boatClient: client } };
    await assert.rejects(reconcileOrphans(deps, { apply: true, ids: ['sb_lost'] }), /EACCES/);
    await chmod(receiptsFile, 0o600);
    assert.deepEqual((await lines(receiptsFile)).map(r => (r as { action: string }).action), ['archive_started']);
    const id = observation(f.ledger, 'sb_lost')?.id;
    assert.ok(id);
    const again = await reconcileOrphans(deps, { apply: true });
    const recovered = { version: 1, sandboxId: 'sb_lost', evidence: 'untracked', at: NOW, inspectionAccount: ACCOUNT, reservationId: id, costBasis: UNKNOWN, action: 'archived', recovered: true };
    assert.deepEqual([again.rows[0]?.verdict, again.receipts], [{ kind: 'archived' }, [recovered]]);
    assert.deepEqual((await lines(receiptsFile)).map(r => (r as { action: string }).action), ['archive_started', 'archived']);
    assert.deepEqual((await reconcileOrphans(deps, { apply: true })).receipts, []);
    assert.deepEqual(boat.calls.filter(c => c[0] === 'stop'), [['stop', 'sb_lost']]);
  });

  it('refuses apply on a corrupt ledger before any provider call', async () => {
    const f = await fixture('corrupt');
    await appendFile(f.file, 'not json\n');
    const boat = fakeBoat([{ id: 'sb_any', state: 'running', access: 'owner', createdAt: null }]);
    await assert.rejects(reconcileOrphans(depsOf(f, boat), { apply: true }), /corrupt/);
    assert.deepEqual(boat.calls, []);
    assert.equal(existsSync(`${f.file}.boat-orphans.jsonl`), false);
  });
});

describe('bun run sandbox reconcile-orphans', () => {
  const run = (args: readonly string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/cli/sandbox.ts', ...args], { cwd: CODE_DIR, env: { PATH: process.env['PATH'] ?? '', ...env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
      child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

  it('exits 2 on an unknown or repeated option before any credential check', { timeout: 20000 }, async () => {
    for (const args of [['--force'], ['--apply', '--apply'], ['--org'], ['--org', 'a', '--org', 'b'], ['--id'], ['--id', 'sb_1', '--id', 'sb_1']]) {
      const r = await run(['reconcile-orphans', ...args]);
      assert.deepEqual([args.join(' '), r.code, r.stderr.split('\n')[0], r.stdout], [args.join(' '), 2, 'reconcile-orphans accepts --org <wallet> and --apply once each, and --id <sandbox-id> per VM', '']);
    }
  });

  it('exits 1 when an archive fails, with the receipts on stdout and the rerun on stderr', { timeout: 20000 }, async () => {
    const dir = await mkdtemp(path.join(tmp, 'cli-'));
    const seen: string[] = [];
    const boat = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://boat.test');
      seen.push(`${req.method} ${url.pathname}`);
      if (req.method === 'GET' && url.pathname === '/v1/sandboxes') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, type: 'sandbox.list', pageInfo: { nextCursor: null, hasMore: false, limit: 200 },
          sandboxes: [{ id: 'sb_cli', name: 'sb_cli', state: 'running', access: 'owner', desktopAvailable: false, snapshotAvailable: false }] }));
        return;
      }
      res.writeHead(url.pathname === '/v1/sandboxes/sb_cli/stop' ? 503 : 404, { 'content-type': 'text/plain' });
      res.end('busy');
    });
    await new Promise<void>((resolve) => boat.listen(0, '127.0.0.1', resolve));
    try {
      const address = boat.address();
      assert.ok(address !== null && typeof address === 'object');
      const r = await run(['reconcile-orphans', '--apply', '--id', 'sb_cli'], {
        BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', WORLDGEN_COSTS_FILE: path.join(dir, 'costs.jsonl'), BOAT_BASE_URL: `http://127.0.0.1:${address.port}/v1`, WORLDGEN_BOAT_LOOPBACK: '1',
      });
      const out = JSON.parse(r.stdout) as { receipts: { action: string; error?: string }[] };
      assert.deepEqual([r.code, out.receipts.map(x => [x.action, x.error ?? null]), r.stderr], [1, [['archive_started', null], ['archive_failed', 'boat.dev stop failed: HTTP 503 busy']], 'next: bun run sandbox -- reconcile-orphans --apply --id sb_cli\n']);
      assert.deepEqual(seen, ['GET /v1/sandboxes', 'POST /v1/sandboxes/sb_cli/stop']);
      assert.equal(r.stdout.includes(KEY) || r.stderr.includes(KEY), false);
    } finally {
      await new Promise<void>((resolve) => boat.close(() => resolve()));
    }
  });
});
