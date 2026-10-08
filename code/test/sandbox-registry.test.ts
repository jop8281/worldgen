/**
 * The Boat path through sandboxes/registry.ts and its spend metering, with a fake BoatClient and
 * a ledger in a temp directory. No test here reads BOAT_API_KEY from the process or reaches boat.dev.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BoatError, type BoatClient, type BoatInspection } from '../src/boat/client.ts';
import { ledgerPath, openLedger } from '../src/costs/ledger.ts';
import { accountFor } from '../src/costs/pricing.ts';
import { SandboxError, nodeRunner } from '../src/sandboxes/backend.ts';
import { GRADER_CANARY, saveCanaryWorld } from './helpers/world.ts';
import { backendFor, discoverBoat, reconcileCreate, downDetached, execDetached, loadRecord, recordsDir, saveRecord, upDetached } from '../src/sandboxes/registry.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const WORLD_DIR = path.resolve(CODE_DIR, '../prod/worlds/helpdesk');
const KEY = 'boat-test-key-0002';

let tmp = '';
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'worldgen-registry-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

type Call = readonly unknown[];

function fakeClient(): { client: BoatClient; calls: Call[]; writes: Map<string, string> } {
  const calls: Call[] = [];
  const writes = new Map<string, string>();
  const client: BoatClient = {
    async create(o) {
      calls.push(['create', o]);
      return { sandboxId: 'sb_9' };
    },
    async waitReady(id) {
      calls.push(['waitReady', id]);
    },
    async exec(id, command) {
      calls.push(['exec', id, command]);
      return { exitCode: 0, stdout: command === 'node -v' ? 'v22.1.0\n' : command.includes('bun-linux-') ? '1.4.2\n' : '', stderr: '', timedOut: false };
    },
    async start(id, command) {
      calls.push(['start', id, command]);
      return { processId: 1 };
    },
    async writeFile(_id, f) { writes.set(f.path, Buffer.from(f.content, 'base64').toString('utf8')); },
    async expose(id, port, isPublic) {
      calls.push(['expose', id, port, isPublic]);
      return { url: `https://sb-9-${port}.boat.test` };
    },
    async stop(id) {
      calls.push(['stop', id]);
    },
    async waitStopped(id) {
      calls.push(['waitStopped', id]);
    },
  };
  return { client, calls, writes };
}

const envFor = (dir: string): Record<string, string> => ({ PATH: process.env['PATH'] ?? '', BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '1', WORLDGEN_COSTS_FILE: path.join(dir, 'costs.jsonl') });

describe('backendFor boat', () => {
  it('archives an observed VM without a handoff record or usable caps while retaining unknown exposure', async () => {
    const dir = await mkdtemp(path.join(tmp, 'observed-close-'));
    const env = envFor(dir);
    const ledger = openLedger(ledgerPath(env));
    const id = ledger.observeSandbox({ account: accountFor('boat', KEY), sandboxId: 'sb_observed', caps: { maxTotalUsd: 0 } });
    const { client, calls } = fakeClient();
    const closed = await downDetached('sb_observed', { env: { ...env, BOAT_USD_PER_COMPUTE_HOUR: 'invalid', WORLDGEN_MAX_TOTAL_USD: 'invalid' }, backendOptions: { boatClient: client, ledger } });
    assert.deepEqual(closed, { id: 'sb_observed', kind: 'boat', billing: 'unknown' });
    assert.deepEqual(calls, [['stop', 'sb_observed'], ['waitStopped', 'sb_observed']]);
    assert.deepEqual([ledger.read().reservations[0]?.id, ledger.read().reservations.length, ledger.totals().events], [id, 1, 0]);
  });

  it('keeps an observed VM handoff record on failed archival and removes it only after confirmation', async () => {
    const dir = await mkdtemp(path.join(tmp, 'observed-close-failure-'));
    const env = envFor(dir);
    const ledger = openLedger(ledgerPath(env));
    ledger.observeSandbox({ account: accountFor('boat', KEY), sandboxId: 'sb_observed_record', caps: {} });
    await saveRecord(recordsDir(env), { id: 'sb_observed_record', kind: 'boat', size: 'small', start: 1, workdir: '/workspace' });
    const { client } = fakeClient();
    const deps = { env, backendOptions: { ledger, boatClient: { ...client, async waitStopped() { throw new BoatError('archive not confirmed'); } } } };
    await assert.rejects(downDetached('sb_observed_record', deps), /archive not confirmed/);
    assert.equal((await loadRecord(recordsDir(env), 'sb_observed_record'))?.id, 'sb_observed_record');
    const closed = await downDetached('sb_observed_record', { ...deps, backendOptions: { ledger, boatClient: client } });
    assert.deepEqual(closed, { id: 'sb_observed_record', kind: 'boat', billing: 'unknown' });
    assert.equal(await loadRecord(recordsDir(env), 'sb_observed_record'), undefined);
    assert.deepEqual([ledger.read().reservations.length, ledger.totals().events], [1, 0]);
  });

  it('refuses paid creation without an explicit finite applicable cap while leaving cleanup available', async () => {
    const dir = await mkdtemp(path.join(tmp, 'mandatory-cap-'));
    const { client, calls } = fakeClient();
    const file = path.join(dir, 'costs.jsonl');
    const env = { BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_COSTS_FILE: file };
    const m = backendFor('boat', env, undefined, { boatClient: client, flushOnExit: false });
    await assert.rejects(m.backend.up([], { name: 'uncapped' }), /finite.*cap/);
    assert.equal(calls.length, 0);
    assert.equal(m.ledger.totals().events, 0);
    const llmOnly = backendFor('boat', { ...env, WORLDGEN_MAX_DAILY_LLM_USD: '1' }, undefined, { boatClient: client, flushOnExit: false });
    await assert.rejects(llmOnly.backend.up([], { name: 'llm-only' }), /finite.*cap/);
    const unpriced = backendFor('boat', { ...env, BOAT_USD_PER_COMPUTE_HOUR: undefined, WORLDGEN_MAX_TOTAL_USD: '1' }, undefined, { boatClient: client, flushOnExit: false });
    await assert.rejects(unpriced.backend.up([], { name: 'unpriced' }), /unpriced/);
    assert.equal(calls.length, 0);
    m.meter.adopt('old-vm', Date.now());
    await m.backend.down('old-vm');
    assert.deepEqual(calls, [['stop', 'old-vm'], ['waitStopped', 'old-vm']]);
    const unknownRate = backendFor('boat', { ...env, BOAT_USD_PER_COMPUTE_HOUR: undefined }, undefined, { boatClient: client, flushOnExit: false });
    unknownRate.meter.adopt('old-unpriced-vm', Date.now());
    await unknownRate.backend.down('old-unpriced-vm');
    assert.deepEqual(calls.slice(-2), [['stop', 'old-unpriced-vm'], ['waitStopped', 'old-unpriced-vm']]);
    assert.equal(m.ledger.read().events.at(-1)?.usd, null);
  });

  it('refuses Boat provisioning without WORLDGEN_BOAT_ORG, and records the pinned wallet on the claim and every line (A-247)', async () => {
    const dir = await mkdtemp(path.join(tmp, 'pinned-wallet-'));
    const { client, calls } = fakeClient();
    const env = { ...envFor(dir), BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_TOTAL_USD: '5' };
    const unpinned = backendFor('boat', { ...env, WORLDGEN_BOAT_ORG: undefined }, undefined, { boatClient: client, flushOnExit: false });
    await assert.rejects(unpinned.backend.up([], { name: 'unpinned' }), /^SandboxStartError: WORLDGEN_BOAT_ORG is not set|WORLDGEN_BOAT_ORG is not set/);
    assert.deepEqual([calls.length, unpinned.ledger.totals().events, unpinned.ledger.read().reservations.length], [0, 0, 0]);
    const m = backendFor('boat', env, undefined, { boatClient: client, flushOnExit: false });
    const sb = await m.backend.up([], { name: 'pinned' });
    assert.deepEqual(m.ledger.read().reservations.map((r) => r.walletId), ['org_test']);
    await m.backend.down(sb.id);
    assert.deepEqual(m.ledger.read().events.map((e) => e.walletId), ['org_test']);
  });

  it('caps late-stop billing at the exact finite provider TTL used for admission', async () => {
    const dir = await mkdtemp(path.join(tmp, 'late-stop-'));
    const env = { ...envFor(dir), BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_TOTAL_USD: '0.3' };
    const ledger = openLedger(path.join(dir, 'costs.jsonl'), { now: () => now });
    let now = Date.parse('2026-10-06T09:00:00Z');
    const start = now;
    const { client } = fakeClient();
    let stops = 0;
    const retry: BoatClient = { ...client, async stop(id) { if (++stops === 1) throw new BoatError('archive unconfirmed'); await client.stop(id); } };
    const m = backendFor('boat', env, undefined, { boatClient: retry, ledger, ttlSeconds: 1800, flushOnExit: false });
    await m.backend.up([], { name: 'bounded' });
    now += 3_600_000;
    await assert.rejects(m.backend.down('sb_9'), /archive unconfirmed/);
    assert.equal(ledger.read().reservations[0]?.remainingUsd, 0);
    now += 3_600_000;
    const reopened = backendFor('boat', env, undefined, { boatClient: retry, ledger: openLedger(ledger.path, { now: () => now }), flushOnExit: false });
    reopened.meter.adopt('sb_9', start);
    await reopened.backend.down('sb_9');
    assert.deepEqual([ledger.totals().seconds, ledger.totals().usd], [1800, 0.25]);
    assert.deepEqual(ledger.read().events.map(e => e.seconds), [1800, 0]);
    assert.equal(ledger.read().reservations.length, 0);
  });

  it('needs BOAT_API_KEY in the given environment and names it in one line', () => {
    assert.throws(() => backendFor('boat', {}, undefined, { flushOnExit: false }), (e: unknown) => e instanceof BoatError && e.message.startsWith('BOAT_API_KEY is not set'));
  });

  it('reserves the priced provider TTL before a second controller can create another VM', async () => {
    const dir = await mkdtemp(path.join(tmp, 'admission-'));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '0.375' };
    const { client } = fakeClient();
    let creates = 0;
    const counted: BoatClient = { ...client, async create(options) {
      assert.deepEqual(options, { type: 'small', ttlSeconds: 1800, idempotencyKey: openLedger(file).read().reservations[0]?.id });
      return { sandboxId: `sb_${++creates}` };
    } };
    const first = backendFor('boat', env, undefined, { boatClient: counted, ledger: openLedger(file), ttlSeconds: 1800, flushOnExit: false });
    const second = backendFor('boat', env, undefined, { boatClient: counted, ledger: openLedger(file), ttlSeconds: 1800, flushOnExit: false });
    await first.backend.up([], { name: 'first' });
    try {
      await assert.rejects(async () => second.backend.up([], { name: 'second' }), /spend cap/);
      assert.equal(creates, 1);
      assert.equal(first.ledger.read().reservations[0]?.remainingUsd, 0.25);
    } finally {
      for (const id of first.meter.live()) await first.backend.down(id);
      for (const id of second.meter.live()) await second.backend.down(id);
    }
  });

  it('holds the budget while provider creation is still pending', async () => {
    const dir = await mkdtemp(path.join(tmp, 'pending-create-'));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '0.375' };
    const { client } = fakeClient();
    let createdResolve: ((value: { sandboxId: string }) => void) | undefined;
    const created = new Promise<{ sandboxId: string }>((resolve) => { createdResolve = resolve; });
    let creates = 0;
    const pending: BoatClient = { ...client, create() { creates += 1; return created; } };
    const first = backendFor('boat', env, undefined, { boatClient: pending, ledger: openLedger(file), flushOnExit: false });
    const second = backendFor('boat', env, undefined, { boatClient: pending, ledger: openLedger(file), flushOnExit: false });
    const starting = first.backend.up([], { name: 'pending' });
    try {
      assert.equal(first.ledger.read().reservations[0]?.sandboxId, undefined);
      await assert.rejects(async () => second.backend.up([], { name: 'blocked' }), /spend cap/);
      assert.equal(creates, 1);
    } finally {
      assert.ok(createdResolve);
      createdResolve({ sandboxId: 'sb_pending' });
      const sandbox = await starting;
      await first.backend.down(sandbox.id);
    }
    assert.equal(first.ledger.read().reservations.length, 0);
  });

  it('prices the requested size and retains that price when another controller adopts it', async () => {
    const dir = await mkdtemp(path.join(tmp, 'requested-size-'));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    const { client } = fakeClient();
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '0.375' };
    const options = { name: 'large-vm', size: { cpus: 8, memoryGi: 16 } };
    let creates = 0;
    const counted: BoatClient = { ...client, async create(o) {
      creates += 1;
      assert.deepEqual(o, { type: 'large', ttlSeconds: 1800, idempotencyKey: openLedger(file).read().reservations[0]?.id });
      return { sandboxId: 'sb_large' };
    } };
    const blocked = backendFor('boat', env, undefined, { boatClient: counted, ledger: openLedger(file), flushOnExit: false });
    await assert.rejects(async () => blocked.backend.up([], options), /spend cap/);
    assert.equal(creates, 0);
    const start = Date.parse('2026-10-06T09:00:00.000Z');
    let now = start;
    const admittedEnv = { ...env, WORLDGEN_MAX_DAILY_SANDBOX_USD: '2' };
    const admitted = backendFor('boat', admittedEnv, undefined, { boatClient: counted, ledger: openLedger(file, { now: () => now }), flushOnExit: false });
    await admitted.backend.up([], options);
    admitted.meter.release('sb_large');
    const recovered = backendFor('boat', { ...admittedEnv, BOAT_USD_PER_COMPUTE_HOUR: '99' }, undefined, { boatClient: counted, ledger: openLedger(file, { now: () => now }), flushOnExit: false });
    recovered.meter.adopt('sb_large', start);
    now += 1_800_000;
    await recovered.backend.down('sb_large');
    assert.equal(openLedger(file).totals().usd, 1);
    assert.equal(openLedger(file).read().events[0]?.size, 'large');
  });

  it('settles a claimed VM once when two reopened controllers stop it concurrently', async () => {
    const dir = await mkdtemp(path.join(tmp, 'concurrent-stop-'));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '1' };
    const { client } = fakeClient();
    const start = Date.parse('2026-10-06T09:00:00.000Z');
    let now = start;
    const original = backendFor('boat', env, undefined, { boatClient: client, ledger: openLedger(file, { now: () => now }), ttlSeconds: 3600, flushOnExit: false });
    await original.backend.up([], { name: 'shared' });
    original.meter.release('sb_9');
    const reopen = () => backendFor('boat', env, undefined, { boatClient: client, ledger: openLedger(file, { now: () => now }), ttlSeconds: 3600, flushOnExit: false });
    const first = reopen();
    const second = reopen();
    first.meter.adopt('sb_9', start);
    second.meter.adopt('sb_9', start);
    now += 3_600_000;
    await Promise.all([first.backend.down('sb_9'), second.backend.down('sb_9')]);
    const ledger = openLedger(file);
    assert.deepEqual([ledger.totals().events, ledger.totals().seconds, ledger.totals().usd, ledger.totals().corrupt], [1, 3600, 0.5, 0]);
    assert.equal(ledger.read().reservations.length, 0);
    assert.deepEqual([first.meter.live(), second.meter.live()], [[], []]);
  });

  it('settles an older unclaimed VM once when two controllers adopt and stop it concurrently', async () => {
    const dir = await mkdtemp(path.join(tmp, 'legacy-stop-'));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1' };
    const { client } = fakeClient();
    const start = Date.parse('2026-10-06T09:00:00Z');
    let now = start + 30_000;
    const ledger = openLedger(file, { now: () => now });
    ledger.record({ provider: 'boat', account: accountFor('boat', KEY), kind: 'sandbox', sandboxId: 'legacy-vm', seconds: 30, multiplier: 0.5, size: 'small', usd: 0.004166667, estimated: true, checkpoint: true });
    const reopen = () => backendFor('boat', env, undefined, { boatClient: client, ledger: openLedger(file, { now: () => now }), flushOnExit: false });
    const first = reopen();
    const second = reopen();
    first.meter.adopt('legacy-vm', start);
    second.meter.adopt('legacy-vm', start);
    now = start + 3_600_000;
    await Promise.all([first.backend.down('legacy-vm'), second.backend.down('legacy-vm')]);
    const actual = openLedger(file);
    assert.deepEqual([actual.totals().seconds, actual.totals().usd, actual.totals().corrupt, actual.read().reservations.length], [3600, 0.5, 0, 0]);
  });

  it('retains the actual VM after setup and cleanup fail, billing the remaining lifetime on confirmed retry', async () => {
    const dir = await mkdtemp(path.join(tmp, 'partial-start-'));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    let now = Date.parse('2026-10-06T09:00:00.000Z');
    const ledger = openLedger(file, { now: () => now });
    const { client } = fakeClient();
    let stops = 0;
    const flaky: BoatClient = {
      ...client,
      async waitReady() {
        now += 30_000;
        throw new BoatError('readiness failed');
      },
      async stop(id) {
        if (++stops === 1) throw new BoatError('archive unconfirmed');
        await client.stop(id);
      },
    };
    const m = backendFor('boat', { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '1' }, undefined, { boatClient: flaky, ledger, ttlSeconds: 3600, flushOnExit: false });
    await assert.rejects(m.backend.up([], { name: 'partial-start' }), /teardown of boat sandbox sb_9 also failed/);
    const pending = m.meter.live();
    assert.equal(ledger.read().reservations[0]?.sandboxId, 'sb_9');
    assert.equal(ledger.read().reservations[0]?.remainingUsd, 0.495833333);
    now += 3_570_000;
    await m.backend.down('sb_9');
    assert.deepEqual([ledger.totals().seconds, ledger.totals().usd], [3600, 0.5]);
    assert.deepEqual(pending, ['sb_9']);
    assert.deepEqual(m.meter.live(), []);
    assert.equal(ledger.read().reservations.length, 0);
    assert.deepEqual(ledger.read().events.map((e) => [e.sandboxId, e.seconds, e.checkpoint]), [['sb_9', 30, true], ['sb_9', 3570, undefined]]);
  });

  it('releases a confirmed non-start without a phantom VM or billing row', async () => {
    const dir = await mkdtemp(path.join(tmp, 'non-start-'));
    const env = { ...envFor(dir), BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '0.375' };
    const { client, calls } = fakeClient();
    const m = backendFor('boat', env, undefined, { boatClient: client, flushOnExit: false });
    await assert.rejects(m.backend.up([], { name: 'INVALID NAME' }), /name/);
    assert.equal(calls.length, 0);
    assert.equal(m.ledger.totals().events, 0);
    assert.equal(m.ledger.read().reservations.length, 0);
    const started = await m.backend.up([], { name: 'valid' });
    await m.backend.down(started.id);
  });

  it('keeps full exposure and unknown billing when the create result is lost', async () => {
    const dir = await mkdtemp(path.join(tmp, 'unknown-create-'));
    const baseEnv = envFor(dir);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '0.375' };
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    let now = Date.parse('2026-10-06T09:00:00Z');
    const { client } = fakeClient();
    let creates = 0;
    const ambiguous: BoatClient = { ...client, async create(opts) { creates += 1; assert.equal(opts.idempotencyKey, openLedger(file).read().reservations[0]?.id); assert.ok(opts.idempotencyKey); now += 30_000; throw new BoatError('synthetic connection lost after create'); } };
    const m = backendFor('boat', env, undefined, { boatClient: ambiguous, ledger: openLedger(file, { now: () => now }), flushOnExit: false });
    await assert.rejects(m.backend.up([], { name: 'unknown', idempotencyKey: 'caller-must-not-reuse-another-claim' }), /connection lost/);
    const state = openLedger(file).read();
    assert.equal(state.reservations[0]?.sandboxPricing?.idempotentCreate, true);
    assert.deepEqual([state.reservations.length, state.reservations[0]?.remainingUsd, state.reservations[0]?.sandboxId], [1, 0.25, undefined]);
    assert.deepEqual([state.events[0]?.usd, state.events[0]?.estimated, state.events[0]?.sandboxId], [null, 'unpriced', undefined]);
    await assert.rejects(async () => backendFor('boat', env, undefined, { boatClient: ambiguous, ledger: openLedger(file, { now: () => now }), flushOnExit: false }).backend.up([], { name: 'another' }), /billing is unknown/);
    assert.equal(creates, 1);
  });

  it('settles the actual VM after setup fails but provider archival is confirmed', async () => {
    const dir = await mkdtemp(path.join(tmp, 'closed-start-'));
    const baseEnv = envFor(dir);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '0.375' };
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    let now = Date.parse('2026-10-06T09:00:00Z');
    const { client, calls } = fakeClient();
    const failed: BoatClient = { ...client, async waitReady() { now += 30_000; throw new BoatError('readiness failed'); } };
    const m = backendFor('boat', env, undefined, { boatClient: failed, ledger: openLedger(file, { now: () => now }), flushOnExit: false });
    await assert.rejects(m.backend.up([], { name: 'closed-start' }), /readiness failed/);
    const state = openLedger(file).read();
    assert.deepEqual([state.reservations.length, state.events[0]?.sandboxId, state.events[0]?.seconds, state.events[0]?.usd, state.events[0]?.checkpoint], [0, 'sb_9', 30, 0.004166667, undefined]);
    assert.deepEqual(calls.filter(c => c[0] === 'stop' || c[0] === 'waitStopped'), [['stop', 'sb_9'], ['waitStopped', 'sb_9']]);
    const another = backendFor('boat', env, undefined, { boatClient: client, ledger: openLedger(file), flushOnExit: false });
    const started = await another.backend.up([], { name: 'another' });
    await another.backend.down(started.id);
  });
});

describe('upDetached and downDetached on boat', () => {
  it('recovers an unconfirmed partial-start VM from the durable claim before any ordinary record exists', async () => {
    const dir = await mkdtemp(path.join(tmp, 'recover-partial-'));
    const baseEnv = envFor(dir);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1', WORLDGEN_MAX_DAILY_SANDBOX_USD: '1' };
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    let now = Date.parse('2026-10-06T09:00:00Z');
    const { client } = fakeClient();
    let stops = 0;
    const partial: BoatClient = { ...client,
      async waitReady() { now += 30_000; throw new BoatError('readiness failed'); },
      async stop(id) { if (++stops === 1) throw new BoatError('archive unconfirmed'); await client.stop(id); },
    };
    const deps = { env, backendOptions: { boatClient: partial, ledger: openLedger(file, { now: () => now }), ttlSeconds: 3600, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
    await assert.rejects(upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'partial' }, deps), /also failed/);
    assert.equal(await loadRecord(recordsDir(env), 'sb_9'), undefined);
    await assert.rejects(downDetached('sb_9', { ...deps, env: { ...env, BOAT_API_KEY: 'different-synthetic-account' } }), /no sandbox/);
    assert.equal(stops, 1);
    assert.equal(openLedger(file).read().reservations.length, 1);
    now += 3_570_000;
    const closed = await downDetached('sb_9', { ...deps, backendOptions: { ...deps.backendOptions, ledger: openLedger(file, { now: () => now }) } });
    assert.equal(closed.id, 'sb_9');
    assert.equal(stops, 2);
    assert.deepEqual([openLedger(file).totals().seconds, openLedger(file).totals().usd, openLedger(file).read().reservations.length], [3600, 0.5, 0]);
  });

  it('uploads the public form of the world by default, and the private world only with private: true (A-377)', async () => {
    const { dir: worldDir } = await saveCanaryWorld(await mkdtemp(path.join(tmp, 'canary-')), 'canary-world');
    const run = async (extra: { private?: boolean }): Promise<Map<string, string>> => {
      const env = envFor(await mkdtemp(path.join(tmp, 'canary-env-')));
      const { client, writes } = fakeClient();
      const deps = { env, runner: nodeRunner, backendOptions: { boatClient: client, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
      await upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir, port: 4000, name: 'canary', ...extra }, deps);
      return writes;
    };
    const pub = await run({});
    const world = [...pub.entries()].find(([p]) => p.endsWith('worlds/canary-world/world.yaml'));
    assert.ok(world, 'the world file is uploaded under worlds/canary-world');
    assert.equal([...pub.values()].some((c) => c.includes(GRADER_CANARY)), false);
    assert.equal(/^\s*grader:/m.test(world[1]), false);
    const priv = await run({ private: true });
    assert.equal([...priv.values()].some((c) => c.includes(GRADER_CANARY)), true);
  });

  it('serves the world on a small VM, exposes only the world port publicly, and records the lifetime once at down', async () => {
    const dir = await mkdtemp(path.join(tmp, 'a-'));
    const env = envFor(dir);
    const { client, calls } = fakeClient();
    const deps = { env, runner: nodeRunner, backendOptions: { boatClient: client, flushOnExit: false }, reach: async () => ({ ok: true as const }) };

    const rec = await upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-a1' }, deps);
    assert.equal(rec.id, 'sb_9');
    assert.equal(rec.kind, 'boat');
    assert.equal(rec.size, 'small');
    assert.equal(rec.workdir, '/tmp/worldgen');
    assert.equal(rec.url, 'https://sb-9-4000.boat.test');
    assert.deepEqual(calls[0], ['create', { type: 'small', ttlSeconds: 1800, idempotencyKey: openLedger(ledgerPath(env)).read().reservations[0]?.id }]);
    assert.deepEqual(calls.filter((c) => c[0] === 'expose'), [['expose', 'sb_9', 4000, true]]);
    const serve = calls.find((c) => c[0] === 'start');
    assert.equal(serve?.[2], '/tmp/worldgen-bun/node_modules/.bin/bun src/cli/worldplay.ts serve worlds/helpdesk --port 4000 --host 0.0.0.0 > /tmp/worldplay.log 2>&1 < /dev/null');
    assert.deepEqual(openLedger(env['WORLDGEN_COSTS_FILE']!).read().events, []);
    assert.deepEqual(await readdir(recordsDir(env)), ['sb_9.json']);

    await downDetached('sb_9', deps);
    assert.deepEqual(calls.slice(-2), [['stop', 'sb_9'], ['waitStopped', 'sb_9']]);
    assert.equal(await loadRecord(recordsDir(env), 'sb_9'), undefined);
    const events = openLedger(env['WORLDGEN_COSTS_FILE']!).read().events;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.provider, 'boat');
  });

  it('checks the public URL from outside, and tears the VM down when it does not answer', async () => {
    const dir = await mkdtemp(path.join(tmp, 'c-'));
    const env = envFor(dir);
    const { client, calls } = fakeClient();
    const urls: string[] = [];
    const reach = async (url: string): Promise<{ ok: false; why: string }> => {
      urls.push(url);
      return { ok: false, why: 'HTTP 502' };
    };
    await assert.rejects(
      upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-c1' }, { env, backendOptions: { boatClient: client, flushOnExit: false }, reach }),
      (e: unknown) => e instanceof SandboxError && e.message.startsWith('https://sb-9-4000.boat.test did not answer /openapi.json (HTTP 502) although the boat sandbox sb_9 listens on port 4000'),
    );
    assert.deepEqual(urls, ['https://sb-9-4000.boat.test']);
    assert.deepEqual(calls.slice(-2), [['stop', 'sb_9'], ['waitStopped', 'sb_9']]);
    assert.deepEqual(await readdir(recordsDir(env)).catch(() => []), []);
  });

  it('exec runs in the recorded workdir, and a missing record is one actionable line', async () => {
    const dir = await mkdtemp(path.join(tmp, 'b-'));
    const env = envFor(dir);
    const { client, calls } = fakeClient();
    const deps = { env, backendOptions: { boatClient: client, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
    await upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-b1' }, deps);
    const res = await execDetached('sb_9', ['ls'], deps);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(calls.at(-1), ['exec', 'sb_9', 'ls']);
    await assert.rejects(execDetached('sb_404', ['ls'], deps), (e: unknown) => e instanceof SandboxError && e.message.startsWith('no sandbox sb_404 in '));
    await downDetached('sb_9', deps);
  });
});

describe('detached lifecycles are metered exactly once', () => {
  it('tears the VM down and records it once when the record cannot be saved, then rethrows the save error', async () => {
    const dir = await mkdtemp(path.join(tmp, 'd-'));
    const env = envFor(dir);
    await writeFile(recordsDir(env), 'not a directory');
    const { client, calls } = fakeClient();
    const deps = { env, backendOptions: { boatClient: client, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
    await assert.rejects(upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-d1' }, deps), { code: 'EEXIST' });
    assert.deepEqual(calls.slice(-2), [['stop', 'sb_9'], ['waitStopped', 'sb_9']]);
    const events = openLedger(env['WORLDGEN_COSTS_FILE']!).read().events;
    assert.deepEqual(events.map((e) => [e.sandboxId, e.failed]), [['sb_9', undefined]]);
  });

  it('a failed teardown resumes the remaining duration on retry without double billing', async () => {
    const dir = await mkdtemp(path.join(tmp, 'e-'));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1' };
    let now = Date.parse('2026-10-06T09:00:00.000Z');
    const ledger = openLedger(file, { now: () => now });
    const { client } = fakeClient();
    let stops = 0;
    const flaky: BoatClient = {
      ...client,
      async stop(id) {
        stops += 1;
        if (stops === 1) throw new BoatError('stop failed: HTTP 503');
        await client.stop(id);
      },
    };
    const deps = { env, backendOptions: { boatClient: flaky, ledger, ttlSeconds: 3600, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
    await upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-e1' }, deps);
    now += 30_000;
    await assert.rejects(downDetached('sb_9', deps));
    now += 3_570_000;
    await downDetached('sb_9', deps);
    assert.equal(await loadRecord(recordsDir(env), 'sb_9'), undefined);
    const events = openLedger(file).read().events;
    assert.deepEqual(events.map((e) => [e.sandboxId, e.failed, e.checkpoint, e.seconds]), [['sb_9', true, true, 30], ['sb_9', undefined, undefined, 3570]]);
    assert.equal(ledger.totals().usd, 0.5);
    assert.equal(ledger.totals().seconds, 3600);
  });
});

describe('concurrent downs close a sandbox once', () => {
  const setup = async (name: string) => {
    const dir = await mkdtemp(path.join(tmp, `${name}-`));
    const baseEnv = envFor(dir);
    const file = baseEnv['WORLDGEN_COSTS_FILE'];
    assert.ok(file);
    const env = { ...baseEnv, BOAT_USD_PER_COMPUTE_HOUR: '1' };
    const clock = { now: Date.parse('2026-10-06T09:00:00.000Z') };
    const ledger = openLedger(file, { now: () => clock.now });
    return { env, file, clock, ledger };
  };

  it('two simultaneous downs write one close line, and the loser reports already closing even with a spend cap reached', async () => {
    const { env, file, clock, ledger } = await setup('race');
    const { client } = fakeClient();
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let stops = 0;
    const slow: BoatClient = {
      ...client,
      async stop(id) {
        stops += 1;
        if (stops === 2) release();
        await gate;
        await client.stop(id);
      },
    };
    const upDeps = { env, backendOptions: { boatClient: slow, ledger, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
    await upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-r1' }, upDeps);
    clock.now += 600_000;
    const downDeps = { ...upDeps, env: { ...env, WORLDGEN_MAX_DAILY_USD: '0' } };
    const downs = [downDetached('sb_9', downDeps), downDetached('sb_9', downDeps)];
    for (const d of downs) d.then(release, release);
    const settled = await Promise.allSettled(downs);
    assert.deepEqual(settled.map((s) => s.status).sort(), ['fulfilled', 'rejected']);
    const lost = settled.find((s) => s.status === 'rejected');
    assert.ok(lost?.status === 'rejected' && lost.reason instanceof SandboxError);
    assert.equal(String(lost.reason.message).startsWith('sandbox sb_9 is already closing in process '), true);
    assert.equal(stops, 1);
    const events = openLedger(file).read().events;
    assert.deepEqual(events.map((e) => [e.sandboxId, e.seconds, e.checkpoint, e.failed]), [['sb_9', 600, undefined, undefined]]);
    assert.equal(ledger.totals().seconds, 600);
    assert.deepEqual(await readdir(recordsDir(env)), []);
  });

  it('a lock left by a dead process is reclaimed, so a crash cannot wedge teardown', async () => {
    const { env, file, clock, ledger } = await setup('stale');
    const { client, calls } = fakeClient();
    const deps = { env, backendOptions: { boatClient: client, ledger, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
    await upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-s1' }, deps);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(path.join(recordsDir(env), 'sb_9.lock'), `${JSON.stringify({ pid: dead })}\n`);
    clock.now += 120_000;
    await downDetached('sb_9', deps);
    assert.deepEqual(calls.slice(-2), [['stop', 'sb_9'], ['waitStopped', 'sb_9']]);
    assert.deepEqual(openLedger(file).read().events.map((e) => [e.sandboxId, e.seconds]), [['sb_9', 120]]);
    assert.deepEqual(await readdir(recordsDir(env)), []);
  });

  it('an empty lock, from a process that died before writing its pid, is reclaimed too', async () => {
    const { env, file, clock, ledger } = await setup('empty');
    const { client } = fakeClient();
    const deps = { env, backendOptions: { boatClient: client, ledger, flushOnExit: false }, reach: async () => ({ ok: true as const }) };
    await upDetached({ kind: 'boat', codeDir: CODE_DIR, worldDir: WORLD_DIR, port: 4000, name: 'helpdesk-t1' }, deps);
    await writeFile(path.join(recordsDir(env), 'sb_9.lock'), '');
    clock.now += 45_000;
    await downDetached('sb_9', deps);
    assert.deepEqual(openLedger(file).read().events.map((e) => [e.sandboxId, e.seconds]), [['sb_9', 45]]);
  });
});

describe('Boat credential preflight', () => {
  it('rejects missing credentials before reading the code or world bundle', async () => {
    await assert.rejects(upDetached({ kind: 'boat', codeDir: '/nonexistent-worldgen-code', worldDir: '/nonexistent-worldgen-world', port: 4000 }, { env: {} }), e => e instanceof BoatError && e.message.startsWith('BOAT_API_KEY is not set:'));
  });
});

describe('npm run sandbox', () => {
  const run = (args: readonly string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...(process.versions.bun === undefined ? ['--import', 'tsx'] : []), 'src/cli/sandbox.ts', ...args], { cwd: CODE_DIR, env: { PATH: process.env['PATH'] ?? '', ...env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
      child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

  it('exits 2 with the problem first and the usage after it on a bad option', { timeout: 20000 }, async () => {
    const r = await run(['up', WORLD_DIR, '--backend', 'boat', '--size', 'huge'], {});
    assert.equal(r.code, 2);
    assert.equal(r.stderr.split('\n')[0], '--size must be one of small, default, large, got huge');
    assert.ok(r.stderr.includes('usage:'));
  });

  it('refuses an invalid discovery day before checking provider credentials', { timeout: 20000 }, async () => {
    const r = await run(['discover', '--day', '2026-02-30'], {});
    assert.equal(r.code, 2);
    assert.equal(r.stderr.split('\n')[0], '--day needs a valid UTC date (YYYY-MM-DD)');
    assert.equal(r.stdout, '');
  });

  it('prints the usage and exits 0 on --help or -h after any subcommand', async () => {
    for (const args of [['--help'], ['up', '--help'], ['up', WORLD_DIR, '--backend', 'boat', '-h'], ['exec', '--help'], ['exec', 'sbx-1', '-h'], ['down', '--help']]) {
      const r = await run(args, {});
      assert.deepEqual([args.join(' '), r.code, r.stdout.split('\n')[0], r.stderr], [args.join(' '), 0, 'usage:', '']);
    }
  });

  it('leaves a --help after exec -- to the command it runs', async () => {
    const r = await run(['exec', 'missing-id', '--', 'ls', '--help'], { WORLDGEN_COSTS_FILE: path.join(tmp, 'cli-costs.jsonl') });
    assert.deepEqual([r.code, r.stdout, r.stderr.startsWith('no sandbox missing-id in ')], [1, '', true]);
  });

  it('exits 1 with the one-line missing-key error before any boat.dev call', { timeout: 20000 }, async () => {
    const r = await run(['up', WORLD_DIR, '--backend', 'boat'], { WORLDGEN_COSTS_FILE: path.join(tmp, 'cli-costs.jsonl') });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'BOAT_API_KEY is not set: create a key at https://boat.dev/dashboard?tab=api-keys and export it\n');
  });

  it('is wired as bun run sandbox, and the SDK is pinned to 1.6.0', async () => {
    const pkg: unknown = JSON.parse(await readFile(path.join(CODE_DIR, 'package.json'), 'utf8'));
    assert.equal(typeof pkg === 'object' && pkg !== null && 'scripts' in pkg ? (pkg as { scripts: Record<string, string> }).scripts['sandbox'] : undefined, 'bun src/cli/sandbox.ts');
    assert.equal((pkg as { dependencies: Record<string, string> }).dependencies['@boatdev/sdk'], '1.6.0');
  });
});


describe('reconcile-create retains admission until provider archival', () => {
  const setup = async (marked = true) => {
    const dir = await mkdtemp(path.join(tmp, 'reconcile-create-'));
    const env = envFor(dir);
    let now = Date.parse('2026-10-06T09:00:00Z');
    const ledger = openLedger(ledgerPath(env), { now: () => now });
    const claim = ledger.reserve({ provider: 'boat', account: accountFor('boat', KEY), kind: 'sandbox', boundUsd: 0.25,
      sandboxPricing: { size: 'small', multiplier: 0.5, usdPerComputeHour: 1, maxLifetimeSeconds: 1800, ...(marked ? { idempotentCreate: true } : {}) }, caps: { maxTotalUsd: 0.25 } });
    ledger.record({ provider: 'boat', account: claim.account, kind: 'sandbox', reservationId: claim.id, usd: null, estimated: 'unpriced', checkpoint: true, note: 'sandbox creation outcome and billing are unknown' });
    const { client } = fakeClient();
    return { env, ledger, claim, client, advance: (ms: number) => { now += ms; }, now: () => now };
  };

  it('recovers a lost create, confirms archive and supersedes unknown canonical billing while preserving the raw journal', async () => {
    const s = await setup();
    s.advance(60_000);
    let creates = 0;
    const client: BoatClient = { ...s.client, async create(opts) {
      creates += 1;
      assert.deepEqual(opts, { type: 'small', ttlSeconds: 1800, idempotencyKey: s.claim.id });
      return { sandboxId: 'sb_recovered', startedAt: Date.parse(s.claim.t) };
    } };
    const deps = { env: { ...s.env, WORLDGEN_MAX_TOTAL_USD: '0' }, backendOptions: { boatClient: client, ledger: s.ledger, flushOnExit: false } };
    assert.equal(await reconcileCreate(s.claim.id, deps), 'sb_recovered');
    assert.deepEqual([s.ledger.totals().usd, s.ledger.totals().seconds, s.ledger.totals().unpriced, s.ledger.read().reservations.length, s.ledger.read().corrupt], [0.008333333, 60, 0, 0, 0]);
    assert.equal((await readFile(s.ledger.path, 'utf8')).includes('sandbox creation outcome and billing are unknown'), true);
    assert.equal(await reconcileCreate(s.claim.id, deps), 'sb_recovered');
    assert.equal(creates, 1);
  });

  it('uses a newly provisioned replay timestamp instead of charging the earlier lost attempt', async () => {
    const s = await setup();
    s.advance(3_600_000);
    const client: BoatClient = { ...s.client, async create() { return { sandboxId: 'sb_new', startedAt: s.now() }; }, async stop() { s.advance(60_000); } };
    await reconcileCreate(s.claim.id, { env: s.env, backendOptions: { boatClient: client, ledger: s.ledger, flushOnExit: false } });
    assert.deepEqual([s.ledger.totals().seconds, s.ledger.totals().usd, s.ledger.totals().unpriced], [60, 0.008333333, 0]);
  });

  it('retains unknown exposure after an unconfirmed archive, then retries the bound identity after the key window', async () => {
    const s = await setup();
    let stops = 0;
    let creates = 0;
    const client: BoatClient = { ...s.client, async create() { creates += 1; return { sandboxId: 'sb_retry', startedAt: s.now() }; }, async waitStopped() { if (++stops === 1) throw new BoatError('archive unconfirmed'); } };
    const deps = { env: s.env, backendOptions: { boatClient: client, ledger: s.ledger, flushOnExit: false } };
    await assert.rejects(reconcileCreate(s.claim.id, deps), /archive unconfirmed/);
    assert.equal(s.ledger.read().reservations.length, 1);
    assert.equal(s.ledger.totals().unpriced, 1);
    s.advance(25 * 3_600_000);
    await reconcileCreate(s.claim.id, deps);
    assert.deepEqual([creates, s.ledger.totals().usd, s.ledger.totals().seconds, s.ledger.totals().unpriced, s.ledger.read().reservations.length], [1, 0.25, 1800, 0, 0]);
  });

  it('keeps the same claim after an in-progress replay response', async () => {
    const s = await setup();
    const client: BoatClient = { ...s.client, async create() { throw new BoatError('409 idempotency_in_progress'); } };
    await assert.rejects(reconcileCreate(s.claim.id, { env: s.env, backendOptions: { boatClient: client, ledger: s.ledger, flushOnExit: false } }), /idempotency_in_progress/);
    assert.deepEqual([s.ledger.read().reservations[0]?.id, s.ledger.read().reservations[0]?.remainingUsd, s.ledger.totals().unpriced], [s.claim.id, 0.25, 1]);
  });

  it('allows only one controller to replay and archive a create claim', async () => {
    const s = await setup();
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    let creates = 0;
    const client: BoatClient = { ...s.client, async create() { creates += 1; entered(); await gate; return { sandboxId: 'sb_serial', startedAt: s.now() }; } };
    const deps = { env: s.env, backendOptions: { boatClient: client, ledger: s.ledger, flushOnExit: false } };
    const first = reconcileCreate(s.claim.id, deps);
    await started;
    try { await assert.rejects(reconcileCreate(s.claim.id, deps), /already closing/); }
    finally { release(); }
    await first;
    assert.deepEqual([creates, s.ledger.read().reservations.length, s.ledger.totals().unpriced], [1, 0, 0]);
  });

  it('refuses wrong accounts, legacy keys and expired unbound keys without provider calls', async () => {
    for (const variant of ['account', 'legacy', 'expired'] as const) {
      const s = await setup(variant !== 'legacy');
      let calls = 0;
      const client: BoatClient = { ...s.client, async create() { calls += 1; throw new Error('must not create'); } };
      if (variant === 'expired') s.advance(24 * 3_600_000);
      const env = variant === 'account' ? { ...s.env, BOAT_API_KEY: 'synthetic-other-account' } : s.env;
      await assert.rejects(reconcileCreate(s.claim.id, { env, backendOptions: { boatClient: client, ledger: s.ledger, flushOnExit: false } }), /no pending|no persisted|retention window/);
      assert.deepEqual([calls, s.ledger.read().reservations.length, s.ledger.totals().unpriced], [0, 1, 1]);
    }
  });

  it('archives a recovered identity while retaining unknown billing when the provider omits its creation time', async () => {
    for (const time of ['missing', 'negative', 'future'] as const) {
      const s = await setup();
      let stops = 0;
      const client: BoatClient = { ...s.client, async create() { return { sandboxId: 'sb_9', ...(time === 'missing' ? {} : { startedAt: time === 'negative' ? -1 : s.now() + 60_000 }) }; }, async stop() { stops += 1; } };
      await assert.rejects(reconcileCreate(s.claim.id, { env: s.env, backendOptions: { boatClient: client, ledger: s.ledger, flushOnExit: false } }), /creation time is unverified/);
      assert.deepEqual([stops, s.ledger.read().reservations.length, s.ledger.totals().unpriced, s.ledger.read().corrupt], [1, 0, 1, 0]);
    }
  });
});


describe('sandbox discover compares provider evidence without changing accounting', () => {
  it('distinguishes pending, historical and unrecorded identities, and queries usage only for explicit owners', async () => {
    const dir = await mkdtemp(path.join(tmp, 'discover-'));
    const env = envFor(dir);
    const ledger = openLedger(ledgerPath(env));
    const claim = ledger.reserve({ provider: 'boat', account: accountFor('boat', KEY), kind: 'sandbox', boundUsd: 0.25, caps: { maxTotalUsd: 1 } });
    ledger.bindReservation(claim.id, 'sb_pending');
    ledger.record({ provider: 'boat', account: claim.account, kind: 'sandbox', sandboxId: 'sb_historical', usd: 0.1, estimated: true });
    const before = await readFile(ledger.path, 'utf8');
    const calls: string[] = [];
    const inspection: BoatInspection = {
      async inventory(org) {
        assert.equal(org, 'personal');
        return [
          { id: 'sb_pending', state: 'running', access: 'owner', createdAt: null },
          { id: 'sb_historical', state: 'ready', access: 'owner', createdAt: null },
          { id: 'sb_new', state: 'idle', access: 'owner', createdAt: null },
          { id: 'sb_teammate', state: 'running', access: 'use', createdAt: null },
          { id: 'sb_unattributed', state: 'ready', access: 'unknown', createdAt: null },
        ];
      },
      async usage(id) {
        calls.push(id);
        return { sandboxId: id, sandboxType: 'small', billingMultiplier: 0.5, since: '2026-10-06T09:00:00.000Z', until: '2026-10-06T10:00:00.000Z', seconds: 1000, dollars: 0.01, secondsPerDollar: 100000, running: true };
      },
    };
    const report = await discoverBoat({ env, boatInspection: inspection, backendOptions: { ledger } }, 'personal');
    assert.deepEqual(report.rows.map(r => [r.id, r.ledger.pending, r.ledger.recorded, r.usage.kind]), [
      ['sb_pending', true, false, 'available'], ['sb_historical', false, true, 'available'], ['sb_new', false, false, 'available'], ['sb_teammate', false, false, 'ownership_unverified'], ['sb_unattributed', false, false, 'ownership_unverified'],
    ]);
    assert.deepEqual(calls, ['sb_pending', 'sb_historical', 'sb_new']);
    assert.deepEqual([report.readOnly, report.priceBasis, report.wallet], [true, 'provider_list_usage', 'personal']);
    assert.equal(await readFile(ledger.path, 'utf8'), before);
  });

  it('requests a UTC day without writing the ledger and validates it before provider work', async () => {
    const dir = await mkdtemp(path.join(tmp, 'discover-day-'));
    let calls = 0;
    const inspection: BoatInspection = {
      async inventory() { calls += 1; return [{ id: 'sb_day', state: 'archived', access: 'owner', createdAt: null }]; },
      async usage(id, window) {
        calls += 1;
        assert.deepEqual(window, { since: '2026-10-06T00:00:00.000Z', until: '2026-10-07T00:00:00.000Z' });
        return { sandboxId: id, sandboxType: 'small', billingMultiplier: 0.5, since: '2026-10-06T09:00:00.000Z', until: '2026-10-06T10:00:00.000Z', seconds: 1000, dollars: 0.01, secondsPerDollar: 100000, running: false };
      },
    };
    const deps = { env: envFor(dir), boatInspection: inspection };
    await assert.rejects(discoverBoat(deps, undefined, '2026-02-30'), BoatError);
    assert.equal(calls, 0);
    const report = await discoverBoat(deps, undefined, '2026-10-06');
    assert.deepEqual(report.requestedUsageWindow, { since: '2026-10-06T00:00:00.000Z', until: '2026-10-07T00:00:00.000Z' });
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(dir), []);
  });

  it('keeps missing usage evidence visible without treating it as zero', async () => {
    const dir = await mkdtemp(path.join(tmp, 'discover-unavailable-'));
    const inspection: BoatInspection = {
      async inventory() { return [{ id: 'sb_unknown', state: 'running', access: 'owner', createdAt: null }]; },
      async usage() { throw new BoatError('private response body must not escape'); },
    };
    const report = await discoverBoat({ env: envFor(dir), boatInspection: inspection });
    assert.deepEqual(report.rows[0]?.usage, { kind: 'unavailable' });
    assert.equal(JSON.stringify(report).includes('private response'), false);
    assert.deepEqual(await readdir(dir), []);
  });
});
