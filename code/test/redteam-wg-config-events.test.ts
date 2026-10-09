/**
 * Red-team: worldgen/config.ts and worldgen/events.ts (factory unit wg-config-events-llm).
 *
 * Guarantees (one sentence each, with source):
 * WG-C01 An unknown key anywhere in the config is an error, never silently dropped, including inside a prices entry. (config.ts header "Unknown keys are errors (.strict())"; A-36)
 * WG-C02 Cache prices given in config.prices reach the cost of a call. (llm.ts ModelPrice and "config.prices wins per model"; spec "observable ... model cost")
 * WG-C03 Bad budgets are rejected: non-positive cost or minutes, negative or fractional backtracks, zero attempts, zero output tokens, a missing budget. (config.ts schema; spec "model and budget are settings")
 * WG-C04 A negative token price is rejected, since it would let spend fall and bypass the budget stop. (A-34 budget stop reads ledger spend; spec "retry within budget")
 * WG-C05 Omitted settings take their documented defaults. (config.ts schema; A-48 for maxMinutes)
 * WG-C06 Overrides are parsed as strictly as the file. (config.ts loadConfig doc "applies overrides on top, and parses strictly")
 * WG-C07 The shipped config parses to the documented values. (A-48; worldgen.config.json)
 * WG-E01 Every RunEvent variant, every StopReason and every AttemptOutcome survives the events.jsonl round trip unchanged. (events.ts header: every event is written to events.jsonl)
 * WG-E02 One event is one line, even when text carries newlines. (events.ts createEmitter writes JSONL)
 * WG-E03 The RunEvent, StopReason and AttemptOutcome unions are exactly the documented sets, so the spec's stops and observables each have a variant. (events.ts header; spec "knows when to stop", "observable")
 * WG-E04 The console line for a stopped run names the stop reason. (events.ts header "a one-line console view"; spec "says why")
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { issue } from '#engine';
import { configSchema, loadConfig, type Config } from '../src/worldgen/config.ts';
import { createEmitter, type AttemptOutcome, type RunEvent, type StopReason } from '../src/worldgen/events.ts';
import { anthropicModel, type MessagesClient } from '../src/worldgen/llm.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'rt-wg-'));
const writeConfig = (obj: unknown): string => {
  const f = join(tmp(), 'worldgen.config.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
};
const BASE = { model: 'claude-sonnet-5-5', maxCostUsd: 5 };
const ok = (o: unknown) => configSchema.safeParse(o).success;

describe('redteam config: strictness', () => {
  it('WG-C01 unknown keys are rejected at the root, in steps, in a step, and in a prices entry', () => {
    assert.equal(ok({ ...BASE, maxCostUSD: 3 }), false, 'root');
    assert.equal(ok({ ...BASE, steps: { planner: { maxAttempts: 2 } } }), false, 'steps');
    assert.equal(ok({ ...BASE, steps: { plan: { maxAttempt: 2 } } }), false, 'step');
    const typo = configSchema.safeParse({ ...BASE, prices: { 'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMtok: 0.3 } } });
    assert.equal(typo.success, false, `prices entry: a misspelt key was accepted and parsed to ${JSON.stringify(typo.success && typo.data.prices)}`);
  });

  it('WG-C02 a cache read price in config.prices is what a cache read costs', async () => {
    const file = writeConfig({ ...BASE, prices: { 'claude-sonnet-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 } } });
    const config = await loadConfig(file, {});
    const client: MessagesClient = {
      messages: { countTokens: async () => ({ input_tokens: 1 }),
        create: async () => ({
          content: [{ type: 'tool_use', name: 't', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 },
        }),
      },
    };
    const p = await anthropicModel(config, { apiKey: 'sk-test', client, now: () => 0 })
      .propose({ system: 's', prompt: 'p', tool: { name: 't', description: 'd', inputSchema: {} } });
    // 1,000,000 cache-read tokens at $0.20 per million.
    assert.equal(p.costUsd, 0.2);
  });

  it('WG-C03 bad budgets are rejected', () => {
    const bad: [string, unknown][] = [
      ['maxCostUsd 0', { ...BASE, maxCostUsd: 0 }],
      ['maxCostUsd negative', { ...BASE, maxCostUsd: -1 }],
      ['maxCostUsd string', { ...BASE, maxCostUsd: '5' }],
      ['maxCostUsd missing', { model: 'claude-sonnet-5-5' }],
      ['maxCostUsd Infinity', { ...BASE, maxCostUsd: Infinity }],
      ['maxCostUsd NaN', { ...BASE, maxCostUsd: NaN }],
      ['maxMinutes 0', { ...BASE, maxMinutes: 0 }],
      ['maxBacktracks -1', { ...BASE, maxBacktracks: -1 }],
      ['maxBacktracks 1.5', { ...BASE, maxBacktracks: 1.5 }],
      ['maxAttempts 0', { ...BASE, steps: { seed: { maxAttempts: 0 } } }],
      ['maxAttempts 2.5', { ...BASE, steps: { seed: { maxAttempts: 2.5 } } }],
      ['maxOutputTokens 0', { ...BASE, maxOutputTokens: 0 }],
      ['model missing', { maxCostUsd: 5 }],
    ];
    const accepted = bad.filter(([, o]) => ok(o)).map(([n]) => n);
    assert.deepEqual(accepted, []);
  });

  it('WG-C04 negative token prices are rejected', () => {
    const accepted = [
      { inputPerMTok: -4, outputPerMTok: 20 },
      { inputPerMTok: 4, outputPerMTok: -20 },
    ].filter((p) => ok({ ...BASE, prices: { 'claude-sonnet-5-5': p } }));
    assert.deepEqual(accepted, []);
  });

  it('WG-C05 omitted settings take documented defaults', () => {
    const c = configSchema.parse(BASE);
    assert.deepEqual(
      { maxMinutes: c.maxMinutes, maxBacktracks: c.maxBacktracks, maxOutputTokens: c.maxOutputTokens, steps: c.steps, prices: c.prices, exampleWorld: c.exampleWorld },
      {
        maxMinutes: 15, maxBacktracks: 2, maxOutputTokens: 16000,
        steps: { plan: { maxAttempts: 4 }, model: { maxAttempts: 4 }, workflow: { maxAttempts: 4 }, seed: { maxAttempts: 4 }, tasks: { maxAttempts: 4 } },
        prices: {}, exampleWorld: ['../prod/worlds/helpdesk'],
      },
    );
    const partial = configSchema.parse({ ...BASE, steps: { tasks: { maxAttempts: 7 } } });
    assert.deepEqual(partial.steps, { plan: { maxAttempts: 4 }, model: { maxAttempts: 4 }, workflow: { maxAttempts: 4 }, seed: { maxAttempts: 4 }, tasks: { maxAttempts: 7 } });
  });

  it('WG-C06 overrides are parsed strictly', async () => {
    const file = writeConfig(BASE);
    await assert.rejects(loadConfig(file, { maxCostUsd: -2 }));
    await assert.rejects(loadConfig(file, { maxMinutes: 0 }));
    await assert.rejects(loadConfig(file, { bogus: 1 } as unknown as Partial<Config>));
    await assert.rejects(loadConfig(file, { model: 'other' }), /model "other" is not a Claude model id such as claude-sonnet-5-5/);
    const c = await loadConfig(file, { maxCostUsd: 0.5, model: 'claude-sonnet-5-5' });
    assert.equal(c.maxCostUsd, 0.5);
    assert.equal(c.model, 'claude-sonnet-5-5');
  });

  it('WG-C07 the shipped config parses to the documented values', async () => {
    const c = await loadConfig(join(import.meta.dirname, '../worldgen.config.json'), {});
    assert.equal(c.model, 'claude-sonnet-5-5');
    assert.equal(c.maxCostUsd, 5);
    assert.equal(c.maxMinutes, 15);
    assert.equal(c.maxBacktracks, 2);
    assert.deepEqual(c.steps, { plan: { maxAttempts: 3, minShareSeconds: 330 }, model: { maxAttempts: 4 }, workflow: { maxAttempts: 4 }, seed: { maxAttempts: 4 }, tasks: { maxAttempts: 4 } });
  });
});

const iss = issue('snippet.runtime_error', ['actions', 'solve', 'handler'], { message: 'boom' }, 'TypeError: x', { start: 3, end: 9 });
const STOPS: StopReason[] = [
  { kind: 'input_rejected', why: 'asks for malware' },
  { kind: 'attempts_exhausted', step: 'tasks', attempts: 5, lastIssues: [iss] },
  { kind: 'no_progress', step: 'workflow', repeatedIssueSet: 'a@b|c@d', lastIssues: [iss] },
  { kind: 'backtrack_limit', step: 'seed', backtracks: 2 },
  { kind: 'budget_exhausted', spentUsd: 5.25, limitUsd: 5 },
  { kind: 'spend_cap', cap: 'maxTotalUsd', capUsd: 100, spentUsd: 100.5, day: '2026-10-07' },
  { kind: 'cost_unenforceable', cap: 'maxTotalUsd', claim: 'e1467cfb' },
  { kind: 'time_exhausted', minutes: 30 },
  { kind: 'stage_time_exhausted', step: 'workflow', shareMs: 90_000 },
  { kind: 'model_error', message: 'overloaded' },
  { kind: 'judge_error', step: 'seed', message: 'seed runtime failed' },
  { kind: 'infra_unavailable', step: 'seed', issues: [iss] },
  { kind: 'transport_stalled', step: 'plan', idleMs: 120_000 },
  { kind: 'cancelled' },
];
const OUTCOMES: AttemptOutcome[] = [
  { kind: 'accepted', warnings: 2 },
  { kind: 'rejected', issues: [iss] },
  { kind: 'invalid_output', issues: [iss] },
  { kind: 'share_expired', shareMs: 276_500, progress: { messages: 2, outputTokens: 17_873, schemaRetries: 1, outputBytes: 7285 } },
  { kind: 'stalled', idleMs: 120_000, progress: { messages: 0, outputTokens: 0, schemaRetries: 0, outputBytes: 0 } },
  { kind: 'model_error', message: '529' },
  { kind: 'judge_error', message: 'seed runtime failed' },
  { kind: 'infra_unavailable', issues: [iss] },
  { kind: 'judge_expired' },
];
const at = { at: '2026-10-06T10:00:00.000Z', runId: 'run_rt' };
const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 400 };
const EVENTS: RunEvent[] = [
  { ...at, t: 'run_started', mode: 'create', input: 'description', model: 'claude-sonnet-5-5', budgetUsd: 5 },
  { ...at, t: 'run_started', mode: 'iterate', input: 'change_request', model: 'claude-sonnet-5-5', budgetUsd: 5 },
  { ...at, t: 'step_started', step: 'plan', reason: 'planned' },
  { ...at, t: 'step_started', step: 'seed', reason: 'changed' },
  { ...at, t: 'step_started', step: 'model', reason: 'backtracked' },
  { ...at, t: 'step_skipped', step: 'seed', why: 'no section it reads changed' },
  ...OUTCOMES.map((outcome, n): RunEvent => ({ ...at, t: 'attempt', step: 'workflow', n: n + 1, ms: 1234, usage, costUsd: 0.011, outcome, dump: 'runs/run_rt/workflow-1.json' })),
  { ...at, t: 'backtracked', from: 'tasks', to: 'model', because: [iss] },
  { ...at, t: 'advice', step: 'tasks', text: 'line one\nline two\r\n end' },
  { ...at, t: 'call_refused', step: 'workflow', reason: { kind: 'time_exhausted', minutes: 15 }, estimateUsd: 0.4, estimateMs: 300_000, remainingMs: 120_000 },
  { ...at, t: 'stall_retry', step: 'plan', n: 1, idleMs: 120_000, remainingMs: 780_000 },
  { ...at, t: 'call_cancelled', step: 'plan', ms: 900_000, costUsd: null },
  { ...at, t: 'step_finished', step: 'tasks', attempts: 3, ms: 9000, costUsd: 0.3 },
  { ...at, t: 'fidelity', check: { kind: 'openapi' } },
  { ...at, t: 'fidelity', check: { kind: 'reference', reference: 'helpdesk-sla', score: 0.85, floor: 0.8 } },
  { ...at, t: 'fidelity', check: { kind: 'unchecked', software: 'Zendesk-style helpdesk' } },
  { ...at, t: 'run_finished', ms: 60000, costUsd: 1.5, worldWritten: true, result: { kind: 'done', worldDir: '/w' } },
  ...STOPS.map((reason): RunEvent => ({ ...at, t: 'run_finished', ms: 1, costUsd: 0, worldWritten: false, result: { kind: 'stopped', reason } })),
];

describe('redteam events: JSONL', () => {
  it('WG-E01 every variant round-trips through events.jsonl unchanged', () => {
    const dir = tmp();
    const emit = createEmitter(dir);
    for (const e of EVENTS) emit(e);
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n');
    assert.equal(lines.at(-1), '');
    assert.deepEqual(lines.slice(0, -1).map((l) => JSON.parse(l) as unknown), EVENTS.map((e) => structuredClone(e)));
    assert.deepEqual(emit.events(), EVENTS);
  });

  it('WG-E02 one event per line even with newlines in text', () => {
    const dir = tmp();
    const emit = createEmitter(dir);
    emit({ ...at, t: 'advice', step: 'plan', text: 'a\nb\nc' });
    emit({ ...at, t: 'step_skipped', step: 'tasks', why: 'x\ny' });
    const text = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    assert.equal(text.split('\n').length, 3);
  });

  it('WG-E03 the unions are exactly the documented sets', () => {
    // Compile-time: adding or removing a variant breaks these records.
    const tags: Record<RunEvent['t'], true> = {
      run_started: true, step_started: true, step_skipped: true, attempt: true, backtracked: true, advice: true, call_refused: true, stall_retry: true, call_cancelled: true, step_finished: true, fidelity: true, run_finished: true,
    };
    const stops: Record<StopReason['kind'], true> = {
      input_rejected: true, attempts_exhausted: true, no_progress: true, backtrack_limit: true, budget_exhausted: true, spend_cap: true, cost_unenforceable: true, time_exhausted: true, stage_time_exhausted: true, model_error: true, judge_error: true, infra_unavailable: true, transport_stalled: true, cancelled: true,
    };
    const outcomes: Record<AttemptOutcome['kind'], true> = { accepted: true, rejected: true, invalid_output: true, share_expired: true, stalled: true, model_error: true, judge_error: true, infra_unavailable: true, judge_expired: true };
    assert.deepEqual(Object.keys(tags).length, 12);
    assert.deepEqual([...new Set(EVENTS.map((e) => e.t))].sort(), Object.keys(tags).sort());
    assert.deepEqual(STOPS.map((s) => s.kind).sort(), Object.keys(stops).sort());
    assert.deepEqual(OUTCOMES.map((o) => o.kind).sort(), Object.keys(outcomes).sort());
  });

  it('WG-E04 the console line for a stopped run names the reason', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      const emit = createEmitter(tmp(), { console: true });
      for (const reason of STOPS) emit({ ...at, t: 'run_finished', ms: 10, costUsd: 0.5, worldWritten: false, result: { kind: 'stopped', reason } });
    } finally {
      console.log = orig;
    }
    assert.deepEqual(lines, STOPS.map((s) => `[run_rt] run finished: stopped (${s.kind}), 10ms, $0.5000`));
  });
});
