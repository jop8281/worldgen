/**
 * `sandbox reconcile-orphans`: owned Boat VMs that nothing will close, with a fake BoatInspection and
 * BoatClient whose inventory reflects stops, and a ledger in a temp directory. No test here reads
 * BOAT_API_KEY from the process or reaches boat.dev.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BoatError, type BoatClient, type BoatInspection, type BoatInventorySandbox } from '../src/boat/client.ts';
import { openLedger, type Ledger } from '../src/costs/ledger.ts';
import { reconcileOrphans, recordsDir, saveRecord } from '../src/sandboxes/registry.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const KEY = 'boat-test-key-0007';
/** sha256('boat-test-key-0007'), first 12 hex. */
const ACCOUNT = 'sha256:ae6f7672b69f';
const NOW = '2026-10-08T03:00:00.000Z';
const PRICING = { size: 'small', multiplier: 0.5, usdPerComputeHour: 1, maxLifetimeSeconds: 1800, idempotentCreate: true } as const;

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
  return { calls, inspection, client };
}

const lines = async (file: string): Promise<unknown[]> => (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
const observation = (ledger: Ledger, id: string) => ledger.read().reservations.find(r => r.origin === 'inventory' && r.sandboxId === id);

describe('reconcile-orphans', () => {
  const mixed = async (name: string) => {
    const f = await fixture(name);
    await saveRecord(recordsDir(f.env), { id: 'sb_record', kind: 'boat', size: 'small', start: Date.parse('2026-10-08T02:00:00.000Z'), workdir: '/tmp/worldgen' });
    await writeFile(path.join(recordsDir(f.env), 'sb_closing.lock'), `${JSON.stringify({ pid: process.pid })}\n`);
    const claim = f.ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    f.ledger.bindReservation(claim.id, 'sb_claim');
    const boat = fakeBoat([
      { id: 'sb_orphan', state: 'running', access: 'owner', createdAt: '2026-10-07T20:00:00.000Z', team: { id: 'org_test' } },
      { id: 'sb_archived', state: 'archived', access: 'owner', createdAt: null },
      { id: 'sb_record', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_closing', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_claim', state: 'running', access: 'owner', createdAt: null },
      { id: 'sb_teammate', state: 'running', access: 'use', createdAt: null },
    ]);
    return { ...f, ...boat, claim, deps: { env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } } };
  };
  const planned = [
    { id: 'sb_orphan', state: 'running', verdict: { kind: 'orphan', evidence: 'untracked', archived: false }, action: 'archive' },
    { id: 'sb_archived', state: 'archived', verdict: { kind: 'archived' }, action: 'none' },
    { id: 'sb_record', state: 'running', verdict: { kind: 'kept', owner: 'record' }, action: 'none' },
    { id: 'sb_closing', state: 'running', verdict: { kind: 'kept', owner: 'closing' }, action: 'none' },
    { id: 'sb_claim', state: 'running', verdict: { kind: 'kept', owner: 'claim', until: '2026-10-08T03:30:00.000Z' }, action: 'none' },
    { id: 'sb_teammate', state: 'running', verdict: { kind: 'not_owner' }, action: 'none' },
  ];

  it('a dry run classifies every VM and changes nothing: no provider mutation, no ledger line, no receipt file', async () => {
    const s = await mixed('dry');
    const before = await readFile(s.file, 'utf8');
    const result = await reconcileOrphans(s.deps, { apply: false });
    assert.deepEqual(result, { wallet: 'org_test', dryRun: true, ledgerCorrupt: 0, receiptsFile: `${s.file}.boat-orphans.jsonl`, rows: planned, receipts: [] });
    assert.deepEqual(s.calls, [['inventory', 'org_test']]);
    assert.equal(await readFile(s.file, 'utf8'), before);
    assert.equal(existsSync(`${s.file}.boat-orphans.jsonl`), false);
    assert.deepEqual((await readdir(recordsDir(s.env))).sort(), ['sb_closing.lock', 'sb_record.json']);
  });

  it('apply archives only the orphan, appends one receipt, closes its observation, and a rerun changes nothing', async () => {
    const s = await mixed('apply');
    const result = await reconcileOrphans(s.deps, { apply: true, org: 'org_other' });
    assert.deepEqual(s.calls, [['inventory', 'org_other'], ['stop', 'sb_orphan'], ['waitStopped', 'sb_orphan']]);
    const observed = observation(s.ledger, 'sb_orphan');
    assert.ok(observed);
    const receipt = { version: 1, sandboxId: 'sb_orphan', action: 'archived', evidence: 'untracked', at: NOW, inspectionAccount: ACCOUNT, walletId: 'org_test', reservationId: observed.id, costBasis: { billing: 'unknown', usd: null } };
    assert.deepEqual(result, { wallet: 'org_other', dryRun: false, ledgerCorrupt: 0, receiptsFile: `${s.file}.boat-orphans.jsonl`, rows: planned, receipts: [receipt] });
    assert.deepEqual(await lines(result.receiptsFile), [receipt]);
    assert.equal(observed.closedAt, NOW);
    assert.deepEqual([s.ledger.totals().events, s.ledger.read().reservations.map(r => r.sandboxId).sort()], [0, ['sb_claim', 'sb_orphan']]);
    assert.deepEqual((await readdir(recordsDir(s.env))).sort(), ['sb_closing.lock', 'sb_record.json']);

    const again = await reconcileOrphans(s.deps, { apply: true, org: 'org_other' });
    assert.deepEqual(s.calls.slice(3), [['inventory', 'org_other']]);
    assert.deepEqual([again.receipts, again.rows[0]], [[], { id: 'sb_orphan', state: 'archived', verdict: { kind: 'archived' }, action: 'none' }]);
    assert.deepEqual(await lines(result.receiptsFile), [receipt]);
  });

  it('closes the observation of a VM Boat already archived without a provider call', async () => {
    const f = await fixture('already');
    const id = f.ledger.observeSandbox({ account: ACCOUNT, sandboxId: 'sb_gone', caps: {} });
    const boat = fakeBoat([{ id: 'sb_gone', state: 'archived', access: 'owner', createdAt: null }]);
    const result = await reconcileOrphans({ env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } }, { apply: true });
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
    assert.deepEqual(result.rows, [{ id: 'sb_gone', state: 'archived', verdict: { kind: 'orphan', evidence: 'tracked', archived: true }, action: 'close' }]);
    const receipt = { version: 1, sandboxId: 'sb_gone', action: 'already_archived', evidence: 'tracked', at: NOW, inspectionAccount: ACCOUNT, reservationId: id, costBasis: { billing: 'unknown', usd: null } };
    assert.deepEqual(result.receipts, [receipt]);
    assert.deepEqual(await lines(result.receiptsFile), [receipt]);
    assert.equal(observation(f.ledger, 'sb_gone')?.closedAt, NOW);
    assert.deepEqual((await reconcileOrphans({ env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } }, { apply: true })).rows[0]?.verdict, { kind: 'archived' });
  });

  it('archives a VM whose admission claim outlived its TTL and settles the claim at the TTL-bounded estimate', async () => {
    const f = await fixture('expired');
    const earlier = f.at('2026-10-08T02:00:00.000Z');
    const claim = earlier.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    earlier.bindReservation(claim.id, 'sb_expired');
    const boat = fakeBoat([{ id: 'sb_expired', state: 'running', access: 'owner', createdAt: null }]);
    const deps = { env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } };
    assert.deepEqual((await reconcileOrphans(deps, { apply: false })).rows, [{ id: 'sb_expired', state: 'running', verdict: { kind: 'orphan', evidence: 'claim_expired', archived: false }, action: 'archive' }]);
    const result = await reconcileOrphans(deps, { apply: true });
    assert.deepEqual(boat.calls, [['inventory', 'org_test'], ['inventory', 'org_test'], ['stop', 'sb_expired'], ['waitStopped', 'sb_expired']]);
    assert.deepEqual(result.receipts, [{ version: 1, sandboxId: 'sb_expired', action: 'archived', evidence: 'claim_expired', at: NOW, inspectionAccount: ACCOUNT, reservationId: claim.id, costBasis: { billing: 'estimated', usd: 0.25 } }]);
    assert.deepEqual([f.ledger.read().reservations.length, f.ledger.totals().usd, f.ledger.totals().seconds, f.ledger.totals().unpriced], [0, 0.25, 1800, 0]);
  });

  it('keeps an untracked VM while an unbound claim within its TTL may be creating it, and not after that TTL', async () => {
    const f = await fixture('pending');
    f.ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    const boat = fakeBoat([{ id: 'sb_unknown', state: 'running', access: 'owner', createdAt: null }]);
    const result = await reconcileOrphans({ env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } }, { apply: true });
    assert.deepEqual([result.rows, result.receipts], [[{ id: 'sb_unknown', state: 'running', verdict: { kind: 'kept', owner: 'pending_create' }, action: 'none' }], []]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
    assert.equal(existsSync(result.receiptsFile), false);

    const stale = await fixture('pending-stale');
    stale.at('2026-10-08T02:00:00.000Z').reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', boundUsd: 0.25, sandboxPricing: PRICING, caps: { maxDailySandboxUsd: 1 } });
    const later = await reconcileOrphans({ env: stale.env, boatInspection: boat.inspection, backendOptions: { ledger: stale.ledger, boatClient: boat.client } }, { apply: false });
    assert.deepEqual(later.rows[0]?.verdict, { kind: 'orphan', evidence: 'untracked', archived: false });
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
    const result = await reconcileOrphans({ env: f.env, boatInspection: inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } }, { apply: true });
    assert.deepEqual([result.rows, result.receipts], [[
      { id: 'sb_new', state: 'running', verdict: { kind: 'kept', owner: 'pending_create' }, action: 'none' },
      { id: 'sb_bound', state: 'running', verdict: { kind: 'kept', owner: 'claim', until: '2026-10-08T03:30:00.000Z' }, action: 'none' },
    ], []]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test']]);
    assert.equal(existsSync(result.receiptsFile), false);
  });

  it('records a failed stop as archive_failed with unknown billing, keeps the observation open, and a rerun archives it', async () => {
    const f = await fixture('failed');
    let refuse = true;
    const boat = fakeBoat([{ id: 'sb_stuck', state: 'running', access: 'owner', createdAt: null }], async () => { if (refuse) throw new BoatError('boat.dev stop failed: HTTP 503\n<html>busy</html>'); });
    const deps = { env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } };
    const failed = await reconcileOrphans(deps, { apply: true });
    const id = observation(f.ledger, 'sb_stuck')?.id;
    assert.ok(id);
    const receipt = { version: 1, sandboxId: 'sb_stuck', action: 'archive_failed', evidence: 'untracked', at: NOW, inspectionAccount: ACCOUNT, reservationId: id, costBasis: { billing: 'unknown', usd: null }, error: 'boat.dev stop failed: HTTP 503' };
    assert.deepEqual(failed.receipts, [receipt]);
    assert.deepEqual(boat.calls, [['inventory', 'org_test'], ['stop', 'sb_stuck']]);
    assert.equal(observation(f.ledger, 'sb_stuck')?.closedAt, undefined);
    refuse = false;
    const retried = await reconcileOrphans(deps, { apply: true });
    assert.deepEqual(retried.rows[0]?.verdict, { kind: 'orphan', evidence: 'tracked', archived: false });
    const archived = { version: 1, sandboxId: 'sb_stuck', action: 'archived', evidence: 'tracked', at: NOW, inspectionAccount: ACCOUNT, reservationId: id, costBasis: { billing: 'unknown', usd: null } };
    assert.deepEqual(retried.receipts, [archived]);
    assert.deepEqual(await lines(failed.receiptsFile), [receipt, archived]);
    assert.equal(observation(f.ledger, 'sb_stuck')?.closedAt, NOW);
  });

  it('refuses apply on a corrupt ledger before any provider call', async () => {
    const f = await fixture('corrupt');
    await appendFile(f.file, 'not json\n');
    const boat = fakeBoat([{ id: 'sb_any', state: 'running', access: 'owner', createdAt: null }]);
    await assert.rejects(reconcileOrphans({ env: f.env, boatInspection: boat.inspection, backendOptions: { ledger: f.ledger, boatClient: boat.client } }, { apply: true }), /corrupt/);
    assert.deepEqual(boat.calls, []);
    assert.equal(existsSync(`${f.file}.boat-orphans.jsonl`), false);
  });
});

describe('bun run sandbox reconcile-orphans', () => {
  const run = (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...(process.versions.bun === undefined ? ['--import', 'tsx'] : []), 'src/cli/sandbox.ts', ...args], { cwd: CODE_DIR, env: { PATH: process.env['PATH'] ?? '' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
      child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

  it('exits 2 on an unknown or repeated option before any credential check', { timeout: 20000 }, async () => {
    for (const args of [['--force'], ['--apply', '--apply'], ['--org'], ['--org', 'a', '--org', 'b']]) {
      const r = await run(['reconcile-orphans', ...args]);
      assert.deepEqual([args.join(' '), r.code, r.stderr.split('\n')[0], r.stdout], [args.join(' '), 2, 'reconcile-orphans accepts --org <wallet> and --apply once each', '']);
    }
  });
});
