import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { createEmitter, type RunEvent } from '../src/worldgen/events.ts';

const at = '2026-10-06T00:00:00.000Z';
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 };

const EVENTS: RunEvent[] = [
  { at, runId: 'r1', t: 'run_started', mode: 'create', input: 'description', model: 'claude-sonnet-5-5', budgetUsd: 5 },
  { at, runId: 'r1', t: 'step_started', step: 'plan', reason: 'planned' },
  { at, runId: 'r1', t: 'attempt', step: 'plan', n: 2, ms: 1234, usage, costUsd: 0.0123, outcome: { kind: 'accepted', warnings: 0 }, dump: 'x' },
  { at, runId: 'r1', t: 'step_finished', step: 'plan', attempts: 2, ms: 2000, costUsd: 0.02 },
  { at, runId: 'r1', t: 'run_finished', ms: 5000, costUsd: 0.5, worldWritten: false,
    result: { kind: 'stopped', reason: { kind: 'model_error', message: 'boom' } } },
];

function tmpRun(): string {
  return join(mkdtempSync(join(tmpdir(), 'wgev-')), 'runs', 'r1');
}

describe('createEmitter', () => {
  it('prints cancelled cost receipts and qualifies unknown run totals', () => {
    const log = mock.method(console, 'log', () => {});
    try {
      const emit = createEmitter(null, { console: true, progress: true });
      emit({ at, runId: 'r1', t: 'call_cancelled', step: 'plan', ms: 900000, costUsd: 0.25 });
      emit({ at, runId: 'r1', t: 'call_cancelled', step: 'plan', ms: 902000, costUsd: null });
      emit({ at, runId: 'r1', t: 'run_finished', ms: 902000, costUsd: 0.25, unknownCostCalls: 1,
        worldWritten: false, result: { kind: 'stopped', reason: { kind: 'time_exhausted', minutes: 15 } } });
      assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), [
        '[r1] plan call cancelled: 900000ms, $0.2500',
        '[r1] plan call cancelled: 902000ms, cost unknown',
        '[r1] run finished: stopped (time_exhausted), 902000ms, $0.2500 known; 1 call(s) have unknown cost',
      ]);
    } finally {
      log.mock.restore();
    }
  });

  it('appends one JSON line per event and events() keeps order', () => {
    const dir = tmpRun();
    const emit = createEmitter(dir, { console: false });
    for (const e of EVENTS) emit(e);
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n');
    assert.equal(lines.length, 6);
    assert.equal(lines[5], '');
    assert.deepEqual(lines.slice(0, 5).map((l) => JSON.parse(l)), EVENTS);
    assert.deepEqual(emit.events(), EVENTS);
  });

  it('appends to an existing file across emitters', () => {
    const dir = tmpRun();
    createEmitter(dir)(EVENTS[0]!);
    createEmitter(dir)(EVENTS[1]!);
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
  });

  it('prints nothing when console is false', () => {
    const log = mock.method(console, 'log', () => {});
    try {
      createEmitter(tmpRun(), { console: false })(EVENTS[2]!);
      assert.equal(log.mock.callCount(), 0);
    } finally {
      log.mock.restore();
    }
  });

  it('prints one summary line per event with step, attempt, ms and cost', () => {
    const log = mock.method(console, 'log', () => {});
    try {
      const emit = createEmitter(tmpRun(), { console: true });
      for (const e of EVENTS) emit(e);
      assert.equal(log.mock.callCount(), 5);
      const out = log.mock.calls.map((c) => c.arguments[0]);
      assert.equal(out[2], '[r1] plan attempt 2: accepted, 1234ms, $0.0123');
      assert.equal(out[0], '[r1] run started: create from description, model claude-sonnet-5-5, budget $5.00');
      assert.equal(out[4], '[r1] run finished: stopped (model_error), 5000ms, $0.5000');
    } finally {
      log.mock.restore();
    }
  });

  it('events() returns a copy', () => {
    const emit = createEmitter(tmpRun());
    emit(EVENTS[0]!);
    const snap = emit.events() as RunEvent[];
    snap.length = 0;
    assert.equal(emit.events().length, 1);
  });
});
