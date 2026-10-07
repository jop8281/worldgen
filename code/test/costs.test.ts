import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  SpendCapError,
  capStatus,
  capsFromEnv,
  groupEvents,
  guard,
  ledgerPath,
  meterReport,
  openLedger,
  type Ledger,
  type SpendInput,
} from '../src/costs/ledger.ts';
import { meteredModel, meteredSandbox } from '../src/costs/meter.ts';
import { BOAT_SIZES, accountFor, computeHourRate, fingerprint, sandboxUsd } from '../src/costs/pricing.ts';
import { ModelError, type Model, type Proposal, type ProposeRequest } from '../src/worldgen/llm.ts';
import { SandboxStartError, type SandboxStartOutcome } from '../src/sandboxes/backend.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const KEY = 'sk-test-123';
const ACCOUNT = 'sha256:e0dbaa0c6455';

/** A temp ledger driven by a fake clock that starts at `start` and moves only when told. */
function fixture(start = '2026-10-06T09:00:00.000Z'): { ledger: Ledger; file: string; advance: (seconds: number) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'costs-'));
  const file = path.join(dir, 'nested', 'costs.jsonl');
  let t = Date.parse(start);
  return { ledger: openLedger(file, { now: () => t }), file, advance: (s) => void (t += s * 1000) };
}

const req: ProposeRequest = { system: 's', prompt: 'p', tool: { name: 'submit', description: 'd', inputSchema: { type: 'object' } } };
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 400 };
const proposal: Proposal = { input: { ok: true }, advice: [], usage, costUsd: 0.0123, ms: 1500 };

/** A fake model that runs the scripted replies in order and counts calls. */
function scripted(replies: (() => Promise<Proposal>)[]): Model & { calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    async propose() {
      const r = replies[n];
      n += 1;
      if (r === undefined) throw new Error('script exhausted');
      return r();
    },
  };
}

const modelCall = (usd: number, extra: Partial<SpendInput> = {}): SpendInput => ({
  provider: 'anthropic',
  account: ACCOUNT,
  kind: 'model_call',
  usd,
  estimated: false,
  ...extra,
});

describe('pricing: fingerprint and accounts', () => {
  it('fingerprints a key as sha256: plus 12 hex', () => {
    assert.equal(fingerprint(KEY), 'sha256:e0dbaa0c6455');
  });

  it('refuses to fingerprint a blank key', () => {
    assert.throws(() => fingerprint('  '), { message: 'cannot fingerprint an empty key' });
  });

  it('maps each provider to its account', () => {
    assert.equal(accountFor('anthropic', KEY), 'sha256:e0dbaa0c6455');
    assert.equal(accountFor('boat', KEY), 'sha256:e0dbaa0c6455');
    assert.equal(accountFor('claude-cli'), 'claude-cli');
    assert.equal(accountFor('openshell'), 'local');
    assert.equal(accountFor('sbx'), 'local');
    assert.throws(() => accountFor('boat'), { message: 'boat spend needs the key to fingerprint' });
  });

  it('has the boat.dev size table', () => {
    assert.deepEqual(BOAT_SIZES, {
      small: { vcpu: 2, memoryGb: 4, multiplier: 0.5 },
      default: { vcpu: 4, memoryGb: 8, multiplier: 1 },
      large: { vcpu: 8, memoryGb: 16, multiplier: 2 },
    });
  });

  it('prices sandbox time as hours x multiplier x rate', () => {
    assert.equal(sandboxUsd(1800, 0.5, 0.2), 0.05);
    assert.equal(sandboxUsd(3600, 2, 0.2), 0.4);
    assert.equal(sandboxUsd(7200, 1, 0), 0);
  });

  it('reads the boat rate from the environment, or null with a note when it is missing', () => {
    assert.deepEqual(computeHourRate({ BOAT_USD_PER_COMPUTE_HOUR: '0.2' }), { usdPerComputeHour: 0.2 });
    assert.deepEqual(computeHourRate({}), { usdPerComputeHour: null, note: 'set BOAT_USD_PER_COMPUTE_HOUR' });
    assert.throws(() => computeHourRate({ BOAT_USD_PER_COMPUTE_HOUR: 'cheap' }), {
      message: 'BOAT_USD_PER_COMPUTE_HOUR must be a non-negative number of USD, got "cheap"',
    });
  });
});

describe('ledger', () => {
  it('appends one JSON line per event, stamped by the injected clock, creating its directory', () => {
    const { ledger, file } = fixture();
    ledger.record(modelCall(0.5, { runId: 'r1', model: 'claude-sonnet-5-5' }));
    assert.equal(
      readFileSync(file, 'utf8'),
      '{"t":"2026-10-06T09:00:00.000Z","provider":"anthropic","account":"sha256:e0dbaa0c6455","kind":"model_call","runId":"r1","model":"claude-sonnet-5-5","usd":0.5,"estimated":false}\n',
    );
  });

  it('refuses an account that is not a fingerprint, so a raw key is never written', () => {
    const { ledger, file } = fixture();
    assert.throws(() => ledger.record(modelCall(0.1, { account: KEY })));
    assert.equal(existsSync(file), false);
  });

  it('reads a start-failed sandbox row as a closed lifetime, and still upgrades a legacy teardown row to a checkpoint', () => {
    const { ledger, file } = fixture();
    const row = { t: '2026-10-06T09:00:00.000Z', provider: 'boat', account: ACCOUNT, kind: 'sandbox', sandboxId: 'sb-1', seconds: 12, usd: 0, estimated: true, failed: true };
    const lines = [
      { ...row, note: 'start failed' },
      { ...row, sandboxId: 'sb-2', note: 'teardown failed; the sandbox may still be running' },
      { ...row, sandboxId: 'sb-3', failed: undefined, note: 'flushed at exit; the sandbox may still be running' },
    ];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.deepEqual(ledger.read().events.map((e) => [e.sandboxId, e.failed, e.checkpoint, e.note]), [
      ['sb-1', true, undefined, 'start failed'],
      ['sb-2', true, true, 'teardown failed; the sandbox may still be running'],
      ['sb-3', undefined, true, 'flushed at exit; the sandbox may still be running'],
    ]);
  });

  it('skips and counts corrupt lines without crashing', () => {
    const { ledger, file } = fixture();
    ledger.record(modelCall(0.25));
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n{"t":"x","usd":1}\n\n{"half":`, { flag: 'w' });
    ledger.record(modelCall(0.5));
    const { events, corrupt } = ledger.read();
    assert.equal(events.length, 2);
    assert.equal(corrupt, 3);
    assert.deepEqual(ledger.totals(), { usd: 0.75, events: 2, estimated: 0, unpriced: 0, seconds: 0, unpricedSeconds: 0, corrupt: 3 });
  });

  it('totals filter by since, provider and account', () => {
    const { ledger, advance } = fixture('2026-10-05T23:00:00.000Z');
    ledger.record(modelCall(1));
    advance(3600);
    ledger.record(modelCall(0.1, { provider: 'claude-cli', account: 'claude-cli' }));
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', seconds: 60, usd: 0.02, estimated: true });
    assert.deepEqual(ledger.totals(), { usd: 1.12, events: 3, estimated: 1, unpriced: 0, seconds: 60, unpricedSeconds: 0, corrupt: 0 });
    assert.deepEqual(ledger.totals({ since: '2026-10-06' }), { usd: 0.12, events: 2, estimated: 1, unpriced: 0, seconds: 60, unpricedSeconds: 0, corrupt: 0 });
    assert.deepEqual(ledger.totals({ provider: 'anthropic' }), { usd: 1, events: 1, estimated: 0, unpriced: 0, seconds: 0, unpricedSeconds: 0, corrupt: 0 });
    assert.deepEqual(ledger.totals({ account: ACCOUNT }), { usd: 1.02, events: 2, estimated: 1, unpriced: 0, seconds: 60, unpricedSeconds: 0, corrupt: 0 });
    assert.throws(() => ledger.totals({ since: 'yesterday' }), { message: 'since must be an ISO date like 2026-10-06, got "yesterday"' });
  });

  it('groups by provider, kind, account, day and run', () => {
    const { ledger, advance } = fixture('2026-10-05T23:00:00.000Z');
    ledger.record(modelCall(1, { runId: 'r1' }));
    advance(3600);
    ledger.record(modelCall(0.5, { runId: 'r1' }));
    ledger.record({ provider: 'sbx', account: 'local', kind: 'sandbox', seconds: 10, usd: 0, estimated: false });
    const { events } = ledger.read();
    const z = { estimated: 0, unpriced: 0, unpricedSeconds: 0 };
    assert.deepEqual(groupEvents(events, 'provider'), [
      { key: 'anthropic', usd: 1.5, events: 2, ...z },
      { key: 'sbx', usd: 0, events: 1, ...z },
    ]);
    assert.deepEqual(groupEvents(events, 'kind'), [
      { key: 'model_call', usd: 1.5, events: 2, ...z },
      { key: 'sandbox', usd: 0, events: 1, ...z },
    ]);
    assert.deepEqual(groupEvents(events, 'account'), [
      { key: 'local', usd: 0, events: 1, ...z },
      { key: 'sha256:e0dbaa0c6455', usd: 1.5, events: 2, ...z },
    ]);
    assert.deepEqual(groupEvents(events, 'day'), [
      { key: '2026-10-05', usd: 1, events: 1, ...z },
      { key: '2026-10-06', usd: 0.5, events: 2, ...z },
    ]);
    assert.deepEqual(groupEvents(events, 'run'), [
      { key: '(no run)', usd: 0, events: 1, ...z },
      { key: 'r1', usd: 1.5, events: 2, ...z },
    ]);
  });

  it('lives at WORLDGEN_COSTS_FILE, else under the home directory', () => {
    assert.equal(ledgerPath({ WORLDGEN_COSTS_FILE: '/tmp/x/costs.jsonl' }, '/home/u'), '/tmp/x/costs.jsonl');
    assert.equal(ledgerPath({}, '/home/u'), '/home/u/.worldgen/costs.jsonl');
  });
});

describe('spend caps', () => {
  it('reads caps from the environment, and the lower of env and explicit wins', () => {
    assert.deepEqual(capsFromEnv({ WORLDGEN_MAX_DAILY_USD: '10', WORLDGEN_MAX_TOTAL_USD: '' }), { maxDailyUsd: 10 });
    assert.deepEqual(capsFromEnv({ WORLDGEN_MAX_DAILY_USD: '10' }, { maxDailyUsd: 4, maxTotalUsd: 50 }), { maxTotalUsd: 50, maxDailyUsd: 4 });
    assert.deepEqual(capsFromEnv({ WORLDGEN_MAX_TOTAL_USD: '20' }, { maxTotalUsd: 50 }), { maxTotalUsd: 20 });
    assert.deepEqual(capsFromEnv({ WORLDGEN_MAX_DAILY_LLM_USD: '3', WORLDGEN_MAX_DAILY_SANDBOX_USD: '1.5' }, { maxDailySandboxUsd: 1 }), { maxDailyLlmUsd: 3, maxDailySandboxUsd: 1 });
    assert.throws(() => capsFromEnv({ WORLDGEN_MAX_DAILY_SANDBOX_USD: 'lots' }), {
      message: 'WORLDGEN_MAX_DAILY_SANDBOX_USD must be a non-negative number of USD, got "lots"',
    });
    assert.throws(() => capsFromEnv({ WORLDGEN_MAX_TOTAL_USD: '-1' }), {
      message: 'WORLDGEN_MAX_TOTAL_USD must be a non-negative number of USD, got "-1"',
    });
  });

  it('a daily cap counts only the current UTC day, and reports what is left', () => {
    const { ledger, advance } = fixture('2026-10-05T23:00:00.000Z');
    ledger.record(modelCall(3));
    advance(3600);
    ledger.record(modelCall(0.75));
    const status = capStatus(ledger, { maxDailyUsd: 1, maxTotalUsd: 5 }, ledger.now());
    assert.deepEqual(status, {
      day: '2026-10-06',
      lines: {
        maxDailyUsd: { cap: 'maxDailyUsd', capUsd: 1, spentUsd: 0.75, remainingUsd: 0.25 },
        maxTotalUsd: { cap: 'maxTotalUsd', capUsd: 5, spentUsd: 3.75, remainingUsd: 1.25 },
      },
    });
    guard(ledger, { maxDailyUsd: 1, maxTotalUsd: 5 }, ledger.now(), 'model_call');
  });

  it('a total cap throws a one-line SpendCapError once spend reaches it', () => {
    const { ledger } = fixture();
    ledger.record(modelCall(5));
    assert.throws(() => guard(ledger, { maxTotalUsd: 5 }, ledger.now(), 'sandbox'), {
      name: 'SpendCapError',
      message: 'total spend cap WORLDGEN_MAX_TOTAL_USD=$5.00 reached: $5.00 spent in all time, all sessions, model calls and sandboxes; raise WORLDGEN_MAX_TOTAL_USD to continue',
    });
  });

  it('a meter cap counts and blocks only its own meter', () => {
    const { ledger } = fixture();
    ledger.record(modelCall(2));
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', seconds: 3600, usd: 0.4, estimated: true });
    const caps = { maxDailyLlmUsd: 2, maxDailySandboxUsd: 1 };
    assert.deepEqual(capStatus(ledger, caps, ledger.now()).lines, {
      maxDailyLlmUsd: { cap: 'maxDailyLlmUsd', capUsd: 2, spentUsd: 2, remainingUsd: 0 },
      maxDailySandboxUsd: { cap: 'maxDailySandboxUsd', capUsd: 1, spentUsd: 0.4, remainingUsd: 0.6 },
    });
    assert.throws(() => guard(ledger, caps, ledger.now(), 'model_call'), {
      name: 'SpendCapError',
      message: 'daily LLM spend cap WORLDGEN_MAX_DAILY_LLM_USD=$2.00 reached: $2.00 spent today (2026-10-06 UTC), all sessions, model calls only; raise WORLDGEN_MAX_DAILY_LLM_USD to continue',
    });
    guard(ledger, caps, ledger.now(), 'sandbox');
    assert.throws(() => guard(ledger, { maxDailySandboxUsd: 0.4 }, ledger.now(), 'sandbox'), {
      message: 'daily sandbox spend cap WORLDGEN_MAX_DAILY_SANDBOX_USD=$0.40 reached: $0.40 spent today (2026-10-06 UTC), all sessions, sandbox time only; raise WORLDGEN_MAX_DAILY_SANDBOX_USD to continue',
    });
    guard(ledger, { maxDailySandboxUsd: 0.4 }, ledger.now(), 'model_call');
  });
});

describe('meters and unpriced time', () => {
  it('splits today and all time per meter, and keeps unpriced seconds out of usd', () => {
    const { ledger, advance } = fixture('2026-10-05T12:00:00.000Z');
    ledger.record(modelCall(1, { seconds: 2 }));
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', seconds: 100, usd: null, estimated: 'unpriced' });
    advance(86400);
    ledger.record(modelCall(0.5, { seconds: 3 }));
    ledger.record({ provider: 'sbx', account: 'local', kind: 'sandbox', seconds: 40, usd: 0, estimated: false });
    const r = meterReport(ledger.read().events, ledger.now());
    assert.equal(r.day, '2026-10-06');
    assert.deepEqual(r.kinds.model_call, {
      today: { usd: 0.5, events: 1, estimated: 0, unpriced: 0, seconds: 3, unpricedSeconds: 0, corrupt: 0 },
      allTime: { usd: 1.5, events: 2, estimated: 0, unpriced: 0, seconds: 5, unpricedSeconds: 0, corrupt: 0 },
    });
    assert.deepEqual(r.kinds.sandbox, {
      today: { usd: 0, events: 1, estimated: 0, unpriced: 0, seconds: 40, unpricedSeconds: 0, corrupt: 0 },
      allTime: { usd: 0, events: 2, estimated: 0, unpriced: 1, seconds: 140, unpricedSeconds: 100, corrupt: 0 },
    });
    assert.deepEqual(r.total.allTime, { usd: 1.5, events: 4, estimated: 0, unpriced: 1, seconds: 145, unpricedSeconds: 100, corrupt: 0 });
  });

  it('reads a legacy $0 boat line as unpriced, and refuses a usd that disagrees with its pricing', () => {
    const { ledger, file } = fixture();
    const legacy = { t: '2026-10-06T08:00:00.000Z', provider: 'boat', account: ACCOUNT, kind: 'sandbox', sandboxId: 'sb_1', seconds: 152, usd: 0, estimated: true, note: 'set BOAT_USD_PER_COMPUTE_HOUR' };
    const bad = { ...legacy, note: undefined, usd: 1, estimated: 'unpriced' };
    ledger.record(modelCall(0.1));
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify(legacy)}\n${JSON.stringify(bad)}\n`);
    const { events, corrupt } = ledger.read();
    assert.equal(corrupt, 1);
    assert.deepEqual(events[1], { ...legacy, usd: null, estimated: 'unpriced' });
    assert.throws(() => ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', usd: null, estimated: true }));
  });
});

describe('meteredModel', () => {
  it('forwards the admitted estimate allowance and releases claims when request adaptation fails before transport execution', async () => {
    const { ledger } = fixture();
    ledger.record(modelCall(0.6));
    let requested: ProposeRequest | undefined;
    const inner: Model = { async propose(value) { requested = value; return proposal; } };
    const opts = { provider: 'claude-cli' as const, account: 'claude-cli', caps: { maxTotalUsd: 1 } };
    const model = meteredModel(inner, ledger, { ...opts, withBudget: (value, allowance) => ({ ...value, maxCostUsd: Math.min(value.maxCostUsd ?? 5, allowance) }) });
    await model.propose({ ...req, maxCostUsd: 0.2 });
    assert.equal(requested?.maxCostUsd, 0.2);
    await model.propose(req);
    assert.equal(requested?.maxCostUsd, 0.3877);
    const failure = new Error('synthetic request adaptation failed');
    const before = ledger.totals().events;
    const bad = meteredModel(inner, ledger, { ...opts, withBudget: () => { throw failure; } });
    await assert.rejects(bad.propose(req), e => e === failure);
    assert.deepEqual([ledger.totals().events, ledger.read().reservations.length], [before, 0]);
  });

  it('blocks another capped controller while an unbounded call is pending, but its caps do not bind an uncapped one (A-164)', async () => {
    // Crosses UTC midnight while staying inside the 2 h claim TTL.
    const { ledger, file, advance } = fixture('2026-10-06T23:30:00.000Z');
    let finish: (p: Proposal) => void = () => { throw new Error('pending call has not started'); };
    const pending = new Promise<Proposal>(resolve => { finish = resolve; });
    const inner = scripted([async () => pending, async () => proposal]);
    let phase = 'plan';
    const opts = { provider: 'anthropic' as const, account: ACCOUNT, model: 'claude-sonnet-5-5', runId: 'pending-run', step: () => phase, caps: { maxDailyLlmUsd: 1 } };
    const first = meteredModel(inner, ledger, opts).propose(req);
    assert.deepEqual([inner.calls(), ledger.totals().events, ledger.read().reservations.length], [1, 0, 1]);
    const [claim] = ledger.read().reservations;
    assert.deepEqual([claim?.runId, claim?.model, claim?.step], ['pending-run', 'claude-sonnet-5-5', 'plan']);
    advance(3600);
    const capped = meteredModel(inner, openLedger(file, { now: ledger.now }), opts);
    await assert.rejects(capped.propose(req), /active spending obligation is unknown/);
    assert.equal(inner.calls(), 1);
    const other = meteredModel(inner, openLedger(file, { now: ledger.now }), { ...opts, caps: {} });
    await other.propose(req);
    assert.equal(inner.calls(), 2);
    phase = 'entities';
    finish(proposal);
    assert.equal(await first, proposal);
    assert.equal(ledger.read().reservations.length, 0);
    assert.equal(ledger.read().events.find((e) => e.step === 'plan')?.step, 'plan');
    assert.deepEqual([inner.calls(), ledger.totals().events, ledger.read().reservations.length], [2, 2, 0]);
  });

  it('preserves the model cost basis and labels client dollar figures as estimates', async () => {
    for (const costBasis of ['sdk_configured_rates', 'cli_reported_cost', 'cli_configured_rates'] as const) {
      const { ledger } = fixture();
      const provider = costBasis === 'sdk_configured_rates' ? 'anthropic' : 'claude-cli';
      const account = provider === 'anthropic' ? ACCOUNT : 'claude-cli';
      const model = meteredModel(scripted([async () => ({ ...proposal, costBasis })]), ledger, { provider, account });
      await model.propose(req);
      const event = ledger.read().events[0];
      assert.deepEqual([event?.usd, event?.estimated, event?.costBasis, ledger.totals().estimated], [0.0123, true, costBasis, 1]);
      assert.throws(() => ledger.record({ provider, account, kind: 'model_call', usd: 1, estimated: false, costBasis }), /client model cost bases are estimates/);
    }
  });

  it('records the exact tokens and the reported usd, and returns the proposal unchanged', async () => {
    const { ledger } = fixture();
    let step = 'plan';
    const inner = scripted([async () => proposal, async () => proposal]);
    const model: Model = meteredModel(inner, ledger, {
      provider: 'anthropic',
      account: accountFor('anthropic', KEY),
      model: 'claude-sonnet-5-5',
      runId: 'run-1',
      step: () => step,
    });
    assert.equal(await model.propose(req), proposal);
    step = 'entities';
    await model.propose(req);
    const { events } = ledger.read();
    assert.deepEqual(events[0], {
      t: '2026-10-06T09:00:00.000Z',
      provider: 'anthropic',
      account: 'sha256:e0dbaa0c6455',
      kind: 'model_call',
      runId: 'run-1',
      step: 'plan',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 400,
      seconds: 1.5,
      usd: 0.0123,
      estimated: false,
      reservationId: events[0]?.reservationId,
      entryId: events[0]?.entryId,
    });
    assert.equal(events[1]?.step, 'entities');
    assert.deepEqual(ledger.totals(), { usd: 0.0246, events: 2, estimated: 0, unpriced: 0, seconds: 3, unpricedSeconds: 0, corrupt: 0 });
  });

  it('records a billed ModelError with failed: true, then rethrows the same error', async () => {
    const { ledger } = fixture();
    const billed = new ModelError('the reply had no tool call', undefined, {
      usage: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.0046,
      ms: 800,
    });
    const model = meteredModel(scripted([async () => Promise.reject(billed)]), ledger, { provider: 'anthropic', account: ACCOUNT });
    await assert.rejects(model.propose(req), (err) => err === billed);
    const { events } = ledger.read();
    assert.deepEqual(events, [
      {
        t: '2026-10-06T09:00:00.000Z',
        provider: 'anthropic',
        account: 'sha256:e0dbaa0c6455',
        kind: 'model_call',
        inputTokens: 900,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        seconds: 0.8,
        usd: 0.0046,
        estimated: false,
        failed: true,
        reservationId: events[0]?.reservationId,
        entryId: events[0]?.entryId,
      },
    ]);
  });

  it('records unknown billing for a failed call without usage and rethrows it', async () => {
    const { ledger } = fixture();
    const model = meteredModel(scripted([async () => Promise.reject(new ModelError('overloaded', 529))]), ledger, {
      provider: 'anthropic',
      account: ACCOUNT,
    });
    await assert.rejects(model.propose(req), { message: 'overloaded' });
    assert.deepEqual(ledger.totals(), { usd: 0, events: 1, estimated: 0, unpriced: 1, seconds: 0, unpricedSeconds: 0, corrupt: 0 });
    assert.equal(ledger.read().events[0]?.usd, null);
    // A-164: the claim closes. Admitted without caps, it has no bound, so its billing stays unknown.
    assert.deepEqual([ledger.read().reservations.length, ledger.read().events[0]?.exposureUsd], [0, undefined]);
  });

  it('a priced settle after an unknown-cost close replaces it and its bound (A-164)', () => {
    const { ledger } = fixture();
    const claim = ledger.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxDailyUsd: 100 } });
    ledger.record({ provider: 'claude-cli', account: 'claude-cli', kind: 'model_call', reservationId: claim.id, usd: null, estimated: 'unpriced', failed: true });
    assert.deepEqual([capStatus(ledger, { maxDailyUsd: 100 }, ledger.now()).lines.maxDailyUsd?.spentUsd, ledger.read().events[0]?.exposureUsd], [100, 100]);
    ledger.record({ provider: 'claude-cli', account: 'claude-cli', kind: 'model_call', reservationId: claim.id, usd: 1, estimated: true, note: 'settled after the fact' });
    assert.deepEqual(ledger.read().events.map((e) => [e.usd, e.exposureUsd]), [[1, undefined]]);
    assert.equal(capStatus(ledger, { maxDailyUsd: 100 }, ledger.now()).lines.maxDailyUsd?.spentUsd, 1);
  });

  it('release settles a claim already closed with unknown billing, replacing its bound (A-164)', () => {
    const { ledger } = fixture();
    const claim = ledger.startModel({ provider: 'claude-cli', account: 'claude-cli', caps: { maxDailyUsd: 100 } });
    ledger.record({ provider: 'claude-cli', account: 'claude-cli', kind: 'model_call', reservationId: claim.id, usd: null, estimated: 'unpriced', failed: true });
    assert.throws(() => ledger.releaseClaim(claim.id), /already closed with unknown billing; give its cost with --usd/);
    ledger.releaseClaim(claim.id, 2, true);
    assert.deepEqual(ledger.read().events.map((e) => [e.usd, e.estimated, e.exposureUsd]), [[2, true, undefined]]);
    assert.equal(capStatus(ledger, { maxDailyUsd: 100 }, ledger.now()).lines.maxDailyUsd?.spentUsd, 2);
  });

  it('records nothing for an explicitly non-started transport failure', async () => {
    const { ledger } = fixture();
    const failure = Object.assign(new Error('missing binary'), { billing: { kind: 'not_started' } });
    const model = meteredModel(scripted([async () => { throw failure; }, async () => proposal]), ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
    await assert.rejects(model.propose(req), e => e === failure);
    assert.equal(ledger.totals().events, 0);
    assert.equal(ledger.read().reservations.length, 0);
    assert.equal(await model.propose(req), proposal);
  });

  it('blocks the next paid call against a combined cap after unknown billing survives reopen', async () => {
    const { ledger, file, advance } = fixture();
    const failure = new Error('synthetic connection dropped after request');
    const inner = scripted([async () => { advance(2); throw failure; }, async () => proposal]);
    const first = meteredModel(inner, ledger, { provider: 'anthropic', account: ACCOUNT, caps: { maxTotalUsd: 1 } });
    await assert.rejects(first.propose(req), e => e === failure);
    const row = ledger.read().events[0];
    assert.deepEqual([row?.usd, row?.seconds, row?.estimated, row?.failed], [null, 2, 'unpriced', true]);
    // A-164: the unknown billing counts at the claim's admitted bound, the whole $1 cap.
    const line = capStatus(ledger, { maxTotalUsd: 1 }, ledger.now()).lines.maxTotalUsd;
    assert.deepEqual([line?.spentUsd, line?.remainingUsd, line?.unpriced], [1, 0, undefined]);
    const reopened = meteredModel(inner, openLedger(file), { provider: 'anthropic', account: ACCOUNT, caps: { maxTotalUsd: 1 } });
    await assert.rejects(reopened.propose(req), /spend cap WORLDGEN_MAX_TOTAL_USD=\$1\.00 reached/);
    assert.equal(inner.calls(), 1);
  });

  it('a daily cap blocks the next call before the model is called', async () => {
    const { ledger } = fixture();
    const inner = scripted([async () => ({ ...proposal, costUsd: 0.6 }), async () => ({ ...proposal, costUsd: 0.6 }), async () => proposal]);
    const model = meteredModel(inner, ledger, { provider: 'claude-cli', account: accountFor('claude-cli'), caps: { maxDailyUsd: 1 } });
    await model.propose(req);
    await model.propose(req);
    await assert.rejects(model.propose(req), (err) => {
      assert.ok(err instanceof SpendCapError);
      assert.equal(err.message, 'daily spend cap WORLDGEN_MAX_DAILY_USD=$1.00 reached: $1.20 spent today (2026-10-06 UTC), all sessions, model calls and sandboxes; raise WORLDGEN_MAX_DAILY_USD to continue');
      assert.equal(err.cap, 'maxDailyUsd');
      return true;
    });
    assert.equal(inner.calls(), 2);
    assert.deepEqual(ledger.totals(), { usd: 1.2, events: 2, estimated: 0, unpriced: 0, seconds: 3, unpricedSeconds: 0, corrupt: 0 });
  });

  it('never writes the raw key to the ledger file', async () => {
    const { ledger, file } = fixture();
    const model = meteredModel(scripted([async () => proposal]), ledger, { provider: 'anthropic', account: accountFor('anthropic', KEY) });
    await model.propose(req);
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes('sha256:e0dbaa0c6455'), true);
  });
});

/** A fake backend in the create(id)/stop(id) style, with one unmetered method. */
function fakeBackend(log: string[] = []) {
  return {
    maxLifetimeSeconds: 3600,
    log,
    async create(name: string) {
      log.push(`create ${name}`);
      return { id: name };
    },
    async stop(id: string) {
      log.push(`stop ${id}`);
    },
    status() {
      return this.log.length;
    },
  };
}

describe('meteredSandbox', () => {
  it('records 1800s on a small boat at $0.2 per compute hour as usd 0.05', async () => {
    const { ledger, advance } = fixture();
    const m = meteredSandbox(fakeBackend(), ledger, { provider: 'boat', account: ACCOUNT, size: 'small', usdPerComputeHour: 0.2, runId: 'run-1' });
    await m.backend.create('sb-1');
    advance(1800);
    await m.backend.stop('sb-1');
    assert.deepEqual(ledger.read().events, [
      {
        t: '2026-10-06T09:30:00.000Z',
        provider: 'boat',
        account: 'sha256:e0dbaa0c6455',
        kind: 'sandbox',
        runId: 'run-1',
        sandboxId: 'sb-1',
        size: 'small',
        seconds: 1800,
        multiplier: 0.5,
        usd: 0.05,
        estimated: true,
      },
    ]);
    assert.deepEqual(m.live(), []);
  });

  it('passes other members through, bound to the backend', async () => {
    const log: string[] = [];
    const { ledger } = fixture();
    const m = meteredSandbox(fakeBackend(log), ledger, { provider: 'sbx', account: 'local' });
    await m.backend.create('a');
    assert.equal(m.backend.status(), 1);
    assert.equal(m.backend.log, log);
  });

  it('meters a handle whose own stop ends it', async () => {
    const { ledger, advance } = fixture();
    const backend = {
      async up() {
        return { name: 'vm-7', async down() {} };
      },
    };
    const m = meteredSandbox(backend, ledger, { provider: 'openshell', account: 'local' });
    const vm = await m.backend.up();
    assert.equal(vm.name, 'vm-7');
    advance(90);
    await vm.down();
    await vm.down();
    assert.deepEqual(ledger.read().events, [
      { t: '2026-10-06T09:01:30.000Z', provider: 'openshell', account: 'local', kind: 'sandbox', sandboxId: 'vm-7', seconds: 90, usd: 0, estimated: false },
    ]);
  });

  it('records boat time without a rate as unpriced, never as $0', async () => {
    const { ledger, advance } = fixture();
    const m = meteredSandbox(fakeBackend(), ledger, { provider: 'boat', account: ACCOUNT, env: {} });
    await m.backend.create('sb-2');
    advance(3600);
    await m.backend.stop('sb-2');
    assert.deepEqual(ledger.read().events, [
      { t: '2026-10-06T10:00:00.000Z', provider: 'boat', account: ACCOUNT, kind: 'sandbox', sandboxId: 'sb-2', size: 'default', seconds: 3600, multiplier: 1, usd: null, estimated: 'unpriced', note: 'set BOAT_USD_PER_COMPUTE_HOUR' },
    ]);
  });

  it('refuses to start an unpriced boat sandbox under a sandbox cap it cannot enforce', async () => {
    const log: string[] = [];
    const { ledger } = fixture();
    const m = meteredSandbox(fakeBackend(log), ledger, { provider: 'boat', account: ACCOUNT, env: {}, caps: { maxDailySandboxUsd: 5 } });
    await assert.rejects(m.backend.create('sb-3'), {
      message: 'WORLDGEN_MAX_DAILY_SANDBOX_USD is set but boat sandbox time is unpriced: set BOAT_USD_PER_COMPUTE_HOUR so the cap can be enforced',
    });
    assert.deepEqual(log, []);
    assert.deepEqual(ledger.read().events, []);
  });

  for (const [cap, env] of [['maxDailyUsd', 'WORLDGEN_MAX_DAILY_USD'], ['maxTotalUsd', 'WORLDGEN_MAX_TOTAL_USD']] as const) {
    it(`refuses to start an unpriced boat sandbox under the combined cap ${cap}`, async () => {
      const log: string[] = [];
      const { ledger } = fixture();
      const m = meteredSandbox(fakeBackend(log), ledger, { provider: 'boat', account: ACCOUNT, env: {}, caps: { [cap]: 5 } });
      await assert.rejects(m.backend.create('sb-3'), {
        message: `${env} is set but boat sandbox time is unpriced: set BOAT_USD_PER_COMPUTE_HOUR so the cap can be enforced`,
      });
      assert.deepEqual(log, []);
      assert.deepEqual(ledger.read().events, []);
    });
  }

  it('tears down an unpriced boat sandbox even under a combined cap', async () => {
    const log: string[] = [];
    const { ledger } = fixture();
    const free = meteredSandbox(fakeBackend(log), ledger, { provider: 'boat', account: ACCOUNT, env: {} });
    await free.backend.create('sb-4');
    const capped = meteredSandbox(fakeBackend(log), ledger, { provider: 'boat', account: ACCOUNT, env: {}, caps: { maxDailyUsd: 5 } });
    capped.adopt('sb-4', ledger.now());
    await capped.backend.stop('sb-4');
    assert.equal(ledger.read().events.length, 1);
  });

  it('a sandbox cap blocks a sandbox but not a model call', async () => {
    const log: string[] = [];
    const { ledger } = fixture();
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', seconds: 3600, usd: 0.2, estimated: true });
    const caps = { maxDailySandboxUsd: 0.2 };
    const m = meteredSandbox(fakeBackend(log), ledger, { provider: 'boat', account: ACCOUNT, usdPerComputeHour: 0.2, caps });
    await assert.rejects(m.backend.create('c'), { name: 'SpendCapError' });
    assert.deepEqual(log, []);
    const model = meteredModel(scripted([async () => proposal]), ledger, { provider: 'anthropic', account: ACCOUNT, caps });
    assert.equal((await model.propose(req)).costUsd, 0.0123);
  });

  it('records an ambiguous start once without inventing an ID or a priced lifetime, and rethrows', async () => {
    const { ledger, advance } = fixture();
    const backend = {
      async up(_files: unknown, _o: { name: string }) {
        advance(45);
        throw new Error('waitReady timed out');
      },
    };
    const m = meteredSandbox(backend, ledger, { provider: 'boat', account: ACCOUNT, size: 'small', usdPerComputeHour: 0.2 });
    await assert.rejects(m.backend.up([], { name: 'w-1' }), { message: 'waitReady timed out' });
    assert.deepEqual(ledger.read().events.map((e) => [e.sandboxId, e.seconds, e.usd, e.failed, e.note]), [[undefined, undefined, null, true, 'sandbox creation outcome and billing are unknown']]);
    assert.deepEqual(m.live(), []);
    assert.deepEqual(m.flush(), []);
  });

  it('records failed-stop usage once and records the later confirmed stop separately', async () => {
    const { ledger, advance } = fixture();
    let fail = true;
    const backend = {
      async up() {
        return { id: 'sb-9' };
      },
      async down(_id: string) {
        if (fail) throw new Error('stop failed');
      },
    };
    const m = meteredSandbox(backend, ledger, { provider: 'sbx', account: 'local' });
    await m.backend.up();
    advance(20);
    await assert.rejects(m.backend.down('sb-9'), { message: 'stop failed' });
    fail = false;
    await m.backend.down('sb-9');
    assert.deepEqual(m.flush(), []);
    assert.deepEqual(ledger.read().events.map((e) => [e.sandboxId, e.seconds, e.usd, e.failed, e.note]), [
      ['sb-9', 20, 0, true, 'teardown failed; the sandbox may still be running'],
      ['sb-9', 0, 0, undefined, undefined],
    ]);
  });

  it('flush records every live sandbox, and a later stop records nothing more', async () => {
    const { ledger, advance } = fixture();
    const m = meteredSandbox(fakeBackend(), ledger, { provider: 'boat', account: ACCOUNT, size: 'large', usdPerComputeHour: 0.2 });
    await m.backend.create('a');
    await m.backend.create('b');
    assert.deepEqual(m.live(), ['a', 'b']);
    advance(3600);
    assert.deepEqual(m.flush().map((e) => [e.sandboxId, e.seconds, e.usd, e.note]), [
      ['a', 3600, 0.4, 'flushed at exit; the sandbox may still be running'],
      ['b', 3600, 0.4, 'flushed at exit; the sandbox may still be running'],
    ]);
    await m.backend.stop('a');
    assert.deepEqual(ledger.totals(), { usd: 0.8, events: 2, estimated: 2, unpriced: 0, seconds: 7200, unpricedSeconds: 0, corrupt: 0 });
  });

  it('records the old lifetime when a new sandbox reuses a live id', async () => {
    const { ledger, advance } = fixture();
    const m = meteredSandbox(fakeBackend(), ledger, { provider: 'sbx', account: 'local' });
    await m.backend.create('same');
    advance(30);
    await m.backend.create('same');
    advance(10);
    await m.backend.stop('same');
    assert.deepEqual(ledger.read().events.map((e) => [e.seconds, e.note]), [
      [30, 'superseded by a new sandbox with the same id'],
      [10, undefined],
    ]);
  });

  it('a spend cap stops create before the backend is called', async () => {
    const log: string[] = [];
    const { ledger } = fixture();
    ledger.record(modelCall(2));
    const m = meteredSandbox(fakeBackend(log), ledger, { provider: 'boat', account: ACCOUNT, usdPerComputeHour: 0.2, caps: { maxTotalUsd: 2 } });
    await assert.rejects(m.backend.create('c'), { name: 'SpendCapError' });
    assert.deepEqual(log, []);
    assert.deepEqual(m.live(), []);
  });

  it('refuses an unknown boat size', () => {
    const { ledger } = fixture();
    assert.throws(() => meteredSandbox(fakeBackend(), ledger, { provider: 'boat', account: ACCOUNT, size: 'huge', usdPerComputeHour: 0.2 }), {
      message: 'unknown boat size "huge": expected one of small, default, large, or pass a multiplier',
    });
  });
});

describe('costs CLI', () => {
  const capsOff = { WORLDGEN_MAX_DAILY_USD: '', WORLDGEN_MAX_TOTAL_USD: '', WORLDGEN_MAX_DAILY_LLM_USD: '', WORLDGEN_MAX_DAILY_SANDBOX_USD: '' };
  const runCli = (file: string, ...args: string[]) =>
    spawnSync('node', ['--import', 'tsx', 'src/cli/costs.ts', ...args], {
      cwd: CODE_DIR,
      encoding: 'utf8',
      env: { ...process.env, WORLDGEN_COSTS_FILE: file, ...capsOff },
    });
  const today = new Date().toISOString().slice(0, 10);

  it('shows unresolved model and VM claims without caps or settled events, even outside --since', () => {
    const { ledger, file } = fixture();
    const { id } = ledger.startModel({ provider: 'anthropic', account: ACCOUNT, caps: {}, model: 'claude-sonnet-5-5', runId: 'crashed-run', step: 'plan' });
    const vm = ledger.reserve({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', caps: {}, boundUsd: 0.5 });
    ledger.bindReservation(vm.id, 'pending-vm');
    const json = runCli(file, '--since', '2099-01-01', '--json');
    assert.equal(json.status, 0);
    const out = JSON.parse(json.stdout);
    assert.deepEqual(out.pending, [
      { id, kind: 'model_call', provider: 'anthropic', account: ACCOUNT, startedAt: '2026-10-06T09:00:00.000Z', runId: 'crashed-run', model: 'claude-sonnet-5-5', step: 'plan', sandboxId: null, boundUsd: null, remainingUsd: null },
      { id: vm.id, kind: 'sandbox', provider: 'boat', account: ACCOUNT, startedAt: '2026-10-06T09:00:00.000Z', runId: null, model: null, step: null, sandboxId: 'pending-vm', boundUsd: 0.5, remainingUsd: 0.5 },
    ]);
    assert.deepEqual([out.total.events, out.total.usd], [0, 0]);
    const text = runCli(file);
    assert.equal(text.status, 0);
    assert.ok(text.stdout.includes('pending obligations (2; not settled spending)'));
    assert.ok(text.stdout.includes(`${id}  model_call  anthropic  ${ACCOUNT}`));
    assert.ok(text.stdout.includes('billing unknown'));
    assert.ok(text.stdout.includes('run crashed-run  model claude-sonnet-5-5  step plan'));
    assert.ok(text.stdout.includes('reserved $0.5000'));
    ledger.releaseReservation(id);
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', reservationId: vm.id, usd: 0.25, estimated: true });
    assert.deepEqual(JSON.parse(runCli(file, '--json').stdout).pending, []);
  });

  /** Two past days (a model call, a priced boat VM, a legacy $0 boat line, a corrupt line) and one model call now. */
  const seeded = (): string => {
    const { ledger, file, advance } = fixture('2026-10-01T10:00:00.000Z');
    ledger.record(modelCall(1.25, { runId: 'r1', seconds: 4 }));
    advance(86400);
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', runId: 'r1', seconds: 1800, usd: 0.05, estimated: true });
    const legacy = { t: '2026-10-02T11:00:00.000Z', provider: 'boat', account: ACCOUNT, kind: 'sandbox', seconds: 152, usd: 0, estimated: true, note: 'set BOAT_USD_PER_COMPUTE_HOUR' };
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify(legacy)}\ngarbage\n`);
    openLedger(file).record(modelCall(0.5, { seconds: 2 }));
    return file;
  };

  it('prints the llm and sandbox meters, totals by provider, the corrupt count and every cap', () => {
    const file = seeded();
    const r = runCli(file);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.equal(
      r.stdout,
      [
        `ledger ${file}`,
        `meters (today is ${today} UTC)`,
        '  llm      today $0.5000  all time $1.7500  2 calls  6 s',
        '  sandbox  today $0.0000  all time $0.0500 + unpriced: 152 sandbox-seconds  2 sandboxes  1952 s',
        '  total    today $0.5000  all time $1.8000 + unpriced: 152 sandbox-seconds  4 events  1958 s',
        'by provider',
        '  anthropic      $1.7500  2 events',
        '  boat       $0.0500 + unpriced: 152 sandbox-seconds  2 events, 1 estimated',
        '  total      $1.8000 + unpriced: 152 sandbox-seconds  4 events, 1 estimated',
        'skipped 1 corrupt line',
        'caps',
        '  maxTotalUsd         none (set WORLDGEN_MAX_TOTAL_USD)',
        '  maxDailyUsd         none (set WORLDGEN_MAX_DAILY_USD)',
        '  maxDailyLlmUsd      none (set WORLDGEN_MAX_DAILY_LLM_USD)',
        '  maxDailySandboxUsd  none (set WORLDGEN_MAX_DAILY_SANDBOX_USD)',
        '',
      ].join('\n'),
    );
  });

  it('groups by kind and shows a meter cap with what it leaves', () => {
    const file = seeded();
    const r = spawnSync('node', ['--import', 'tsx', 'src/cli/costs.ts', '--by', 'kind'], {
      cwd: CODE_DIR,
      encoding: 'utf8',
      env: { ...process.env, WORLDGEN_COSTS_FILE: file, ...capsOff, WORLDGEN_MAX_DAILY_LLM_USD: '2' },
    });
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n');
    assert.deepEqual(lines.slice(lines.indexOf('by kind'), lines.indexOf('by kind') + 4), [
      'by kind',
      '  model_call      $1.7500  2 events',
      '  sandbox     $0.0500 + unpriced: 152 sandbox-seconds  2 events, 1 estimated',
      '  total       $1.8000 + unpriced: 152 sandbox-seconds  4 events, 1 estimated',
    ]);
    assert.ok(lines.includes(`  maxDailyLlmUsd      cap $2.0000  spent ${today} $0.5000  remaining $1.5000`));
  });

  it('prints JSON with both meters, grouped by day since a date', () => {
    const file = seeded();
    const r = runCli(file, '--since', '2026-10-02', '--by', 'day', '--json');
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.rows.slice(0, 1), [{ key: '2026-10-02', usd: 0.05, events: 2, estimated: 1, unpriced: 1, unpricedSeconds: 152 }]);
    assert.deepEqual(out.meters.sandbox.allTime, { usd: 0.05, events: 2, estimated: 1, unpriced: 1, seconds: 1952, unpricedSeconds: 152, corrupt: 0 });
    assert.deepEqual(out.meters.llm.today, { usd: 0.5, events: 1, estimated: 0, unpriced: 0, seconds: 2, unpricedSeconds: 0, corrupt: 0 });
    assert.deepEqual(out.caps, { day: today, maxTotalUsd: null, maxDailyUsd: null, maxDailyLlmUsd: null, maxDailySandboxUsd: null });
    assert.equal(out.total.corrupt, 1);
  });

  it('groups spend by the pinned Boat wallet (A-247)', () => {
    const { ledger } = fixture();
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', walletId: 'org_a', seconds: 3600, usd: 1, estimated: true });
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', seconds: 1800, usd: 0.5, estimated: true });
    ledger.record({ provider: 'claude-cli', account: 'claude-cli', kind: 'model_call', usd: 0.25, estimated: true });
    assert.deepEqual(groupEvents(ledger.read().events, 'wallet').map((g) => [g.key, g.usd]), [['(boat, no wallet recorded)', 0.5], ['(not boat)', 0.25], ['org_a', 1]]);
  });

  it('exits 2 on a bad argument', () => {
    const r = runCli(seeded(), '--by', 'week');
    assert.equal(r.status, 2);
    assert.equal(r.stderr.split('\n')[0], '--by takes one of provider, kind, account, wallet, day, run');
  });
});

describe('unconfirmed live sandbox accounting', () => {
  it('keeps a failed stop live and bills the full lifetime on a confirmed retry', async () => {
    const { ledger, advance } = fixture();
    let fail = true;
    const backend = {
      async create() { return { id: 'vm-retry' }; },
      async stop(_id: string) { if (fail) throw new Error('archive not confirmed'); },
    };
    const meter = meteredSandbox(backend, ledger, { provider: 'boat', account: ACCOUNT, usdPerComputeHour: 1 });
    await meter.backend.create();
    advance(30);
    await assert.rejects(meter.backend.stop('vm-retry'), /archive not confirmed/);
    assert.deepEqual(meter.live(), ['vm-retry']);
    advance(3570);
    fail = false;
    await meter.backend.stop('vm-retry');
    assert.deepEqual(meter.live(), []);
    assert.equal(ledger.totals().usd, 1);
    assert.equal(ledger.totals().seconds, 3600);
  });

  it('hands off only unrecorded lifetime after a failed stop without double billing', async () => {
    const { ledger, advance } = fixture();
    const meter = meteredSandbox({
      async create() { return { id: 'vm-handoff' }; },
      async stop(_id: string) { throw new Error('archive not confirmed'); },
    }, ledger, { provider: 'boat', account: ACCOUNT, usdPerComputeHour: 1 });
    await meter.backend.create();
    advance(30);
    await assert.rejects(meter.backend.stop('vm-handoff'), /archive not confirmed/);
    const handoff = meter.release('vm-handoff');
    assert.ok(handoff);
    assert.equal(handoff.start, Date.parse('2026-10-06T09:00:30.000Z'));
    const next = meteredSandbox(fakeBackend(), ledger, { provider: 'boat', account: ACCOUNT, usdPerComputeHour: 1 });
    next.adopt(handoff.id, handoff.start);
    advance(3570);
    await next.backend.stop(handoff.id);
    assert.deepEqual(next.live(), []);
    const retried = meteredSandbox(fakeBackend(), ledger, { provider: 'boat', account: ACCOUNT, usdPerComputeHour: 1 });
    retried.adopt(handoff.id, Date.parse('2026-10-06T09:00:00.000Z'));
    await retried.backend.stop(handoff.id);
    assert.deepEqual(retried.live(), []);
    assert.equal(ledger.read().events.length, 2);
    assert.equal(ledger.totals().usd, 1);
    assert.equal(ledger.totals().seconds, 3600);
  });

  it('restarts from the original detached record without rebilling a failed-stop segment', async () => {
    const { ledger, file, advance } = fixture();
    const start = ledger.now();
    const opts = { provider: 'boat' as const, account: ACCOUNT, usdPerComputeHour: 1 };
    const first = meteredSandbox({ async stop(_id: string) { throw new Error('archive not confirmed'); } }, ledger, opts);
    first.adopt('vm-restart', start);
    advance(30);
    await assert.rejects(first.backend.stop('vm-restart'), /archive not confirmed/);
    const reopened = openLedger(file, { now: () => ledger.now() });
    const second = meteredSandbox({ async stop(_id: string) {} }, reopened, opts);
    second.adopt('vm-restart', start);
    advance(3570);
    await second.backend.stop('vm-restart');
    const report = meterReport(reopened.read().events, reopened.now());
    assert.deepEqual([report.kinds.sandbox.allTime.seconds, report.kinds.sandbox.today.seconds, report.total.allTime.usd], [3600, 3600, 1]);
    assert.deepEqual(reopened.read().events.map((e) => e.seconds), [30, 3570]);
  });

  it('bills each segment once when teardown fails in two processes before a third confirms it', async () => {
    const { ledger, file, advance } = fixture();
    const start = ledger.now();
    const opts = { provider: 'boat' as const, account: ACCOUNT, usdPerComputeHour: 1 };
    const failing = { async stop(_id: string) { throw new Error('archive not confirmed'); } };
    for (const seconds of [30, 600]) {
      const proc = meteredSandbox(failing, openLedger(file, { now: () => ledger.now() }), opts);
      proc.adopt('vm-twice', start);
      advance(seconds);
      await assert.rejects(proc.backend.stop('vm-twice'), /archive not confirmed/);
    }
    const last = openLedger(file, { now: () => ledger.now() });
    const third = meteredSandbox({ async stop(_id: string) {} }, last, opts);
    third.adopt('vm-twice', start);
    advance(2970);
    await third.backend.stop('vm-twice');
    third.adopt('vm-twice', start);
    assert.deepEqual(third.live(), []);
    const report = meterReport(last.read().events, last.now());
    assert.deepEqual(last.read().events.map((e) => [e.seconds, e.checkpoint]), [[30, true], [600, true], [2970, undefined]]);
    assert.deepEqual([report.kinds.sandbox.allTime.seconds, report.kinds.sandbox.today.seconds, report.total.allTime.usd, report.total.today.usd], [3600, 3600, 1, 1]);
  });

  it('resumes an unpriced failed teardown after a restart without rebilling seconds', async () => {
    const { ledger, file, advance } = fixture();
    const start = ledger.now();
    const opts = { provider: 'boat' as const, account: ACCOUNT, env: {} };
    const first = meteredSandbox({ async stop(_id: string) { throw new Error('archive not confirmed'); } }, ledger, opts);
    first.adopt('vm-unpriced', start);
    advance(30);
    await assert.rejects(first.backend.stop('vm-unpriced'), /archive not confirmed/);
    const reopened = openLedger(file, { now: () => ledger.now() });
    const second = meteredSandbox({ async stop(_id: string) {} }, reopened, opts);
    second.adopt('vm-unpriced', start);
    advance(3570);
    await second.backend.stop('vm-unpriced');
    assert.deepEqual(reopened.read().events.map((e) => [e.seconds, e.usd]), [[30, null], [3570, null]]);
    assert.equal(meterReport(reopened.read().events, reopened.now()).kinds.sandbox.allTime.seconds, 3600);
  });
});

describe('a Boat create whose outcome is unknown, and the operator who knows it (A-286)', () => {
  const CAPS = { maxDailySandboxUsd: 5 };
  const REFUSED = /cost admission refused: WORLDGEN_MAX_DAILY_SANDBOX_USD cannot be enforced while applicable billing is unknown/;
  /** A metered Boat start that fails with `start`, and the claim it leaves open, if any. */
  async function failedStart(ledger: Ledger, start: SandboxStartOutcome): Promise<string | undefined> {
    const backend = { maxLifetimeSeconds: 900, async up(_files: unknown, _o: { name: string }): Promise<never> { throw new SandboxStartError('boat.dev create failed', start); } };
    const m = meteredSandbox(backend, ledger, { provider: 'boat', account: ACCOUNT, size: 'small', usdPerComputeHour: 1, caps: CAPS });
    await assert.rejects(m.backend.up([], { name: 'w-1' }), { message: 'boat.dev create failed' });
    return ledger.read().reservations[0]?.id;
  }
  const admits = (ledger: Ledger): boolean => { guard(ledger, CAPS, ledger.now(), 'sandbox'); return true; };
  const rows = (ledger: Ledger) => ledger.read().events.map((e) => [e.usd, e.checkpoint, e.stated, e.note]);

  it('a refused create records nothing and leaves admission open', async () => {
    const { ledger } = fixture();
    assert.equal(await failedStart(ledger, { kind: 'not_started' }), undefined);
    assert.deepEqual(rows(ledger), []);
    assert.equal(admits(ledger), true);
  });

  it('an unknown create blocks admission until the operator releases it with a stated cost', async () => {
    const { ledger } = fixture();
    const id = await failedStart(ledger, { kind: 'unknown' });
    assert.deepEqual(rows(ledger), [[null, true, undefined, 'sandbox creation outcome and billing are unknown']]);
    assert.throws(() => admits(ledger), REFUSED);
    ledger.releaseClaim(id ?? '', 0);
    assert.deepEqual(rows(ledger), [[0, undefined, true, 'released by the operator with a stated cost']]);
    assert.equal(admits(ledger), true);
  });

  it('clears the live claim e1467cfb: its $0 release, written before A-286, left the create unknown; a stated settle replaces it', async () => {
    const { ledger } = fixture();
    const id = await failedStart(ledger, { kind: 'unknown' }) ?? '';
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', reservationId: id, usd: 0, estimated: false, failed: true, note: 'released by the operator with a stated cost' });
    assert.throws(() => admits(ledger), REFUSED);
    ledger.releaseClaim(id, 0);
    assert.deepEqual(rows(ledger), [[0, undefined, undefined, 'released by the operator with a stated cost'], [0, undefined, true, 'settled by the operator with a stated cost']]);
    assert.equal(admits(ledger), true);
  });

  it('an unstated priced close still keeps an unbound unknown create, as before', async () => {
    const { ledger } = fixture();
    const id = await failedStart(ledger, { kind: 'unknown' }) ?? '';
    ledger.record({ provider: 'boat', account: ACCOUNT, kind: 'sandbox', reservationId: id, usd: 0.1, estimated: true, failed: true });
    assert.deepEqual(rows(ledger), [[null, true, undefined, 'sandbox creation outcome and billing are unknown'], [0.1, undefined, undefined, undefined]]);
    assert.throws(() => admits(ledger), REFUSED);
  });
});
