import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeEvalOutcomes, type EvalEvidence, type ExpectedEvalCase } from '../src/worldgen/eval-outcomes.ts';

const expected: ExpectedEvalCase[] = [{ id: 'alpha', expect: 'done' }, { id: 'beta', expect: 'done' }];
function log(ms: unknown = 100, costUsd: unknown = 1, attempts = 1, kind = 'done', reason = 'input_rejected', mode: 'create' | 'iterate' = 'create'): string {
  return [
    { t: 'run_started', mode },
    ...(attempts === 0 ? [] : [{ t: 'step_started', step: 'plan' }]),
    ...Array.from({ length: attempts }, (_, i) => ({ t: 'attempt', step: 'plan', n: i + 1 })),
    ...(attempts === 0 ? [] : [{ t: 'step_finished', step: 'plan', attempts }]),
    { t: 'run_finished', ms, costUsd, result: kind === 'done' ? { kind } : { kind, reason: { kind: reason } } },
  ].map((e) => JSON.stringify({ runId: `r-${mode}`, ...e })).join('\n');
}
function evidence(id: string, options: { ms?: unknown; cost?: unknown; attempts?: number; pass?: boolean; stopped?: string } = {}): EvalEvidence {
  const stopped = options.stopped !== undefined;
  return {
    id, source: `${id}/case.json`,
    caseText: JSON.stringify({ id, expect: stopped ? 'stopped' : 'done', phases: [{ phase: 'create', result: stopped ? 'stopped' : 'done', error: null }],
      verify: stopped ? { kind: 'not_run' } : options.pass === false ? { kind: 'fail', codes: ['task.failed'] } : { kind: 'pass', tasks: 3 } }),
    logs: { create: log(options.ms ?? 100, options.cost === undefined ? 1 : options.cost, options.attempts ?? 1, stopped ? 'stopped' : 'done', options.stopped) },
  };
}

describe('all expected eval outcomes', () => {
  it('R1-R2 keeps missing and invalid expected cases in order and in the success denominator', () => {
    const report = analyzeEvalOutcomes([...expected, { id: 'gamma', expect: 'done' }], [evidence('alpha'), { ...evidence('beta'), caseText: '{broken' }]);
    assert.deepEqual(report.counts, { expected: 3, observed: 2, valid: 1, invalid: 1, missing: 1, duplicate: 0, unexpected: 0 });
    assert.deepEqual(report.cases.map((c) => [c.id, c.status, c.passed]), [['alpha', 'valid', true], ['beta', 'invalid', false], ['gamma', 'missing', false]]);
    assert.equal(report.passed, 1);
    assert.equal(report.passRate, 1 / 3);
    assert.equal(report.completeSuite, false);
  });

  it('R2 dropping a failed record cannot improve success or claim a complete suite', () => {
    const full = analyzeEvalOutcomes(expected, [evidence('alpha'), evidence('beta', { pass: false })]);
    const dropped = analyzeEvalOutcomes(expected, [evidence('alpha')]);
    assert.equal(full.passRate, 0.5);
    assert.equal(dropped.passRate, 0.5);
    assert.equal(full.completeSuite, true);
    assert.equal(full.allPassed, false);
    assert.equal(dropped.completeSuite, false);
    assert.equal(dropped.metrics.costUsd.total, null);
  });

  it('R1 reports duplicate and unexpected evidence instead of choosing a winner', () => {
    const report = analyzeEvalOutcomes(expected, [evidence('alpha'), { ...evidence('alpha'), source: 'copy/alpha/case.json' }, evidence('extra')]);
    assert.deepEqual(report.counts, { expected: 2, observed: 3, valid: 0, invalid: 0, missing: 1, duplicate: 1, unexpected: 1 });
    assert.equal(report.cases[0]?.status, 'duplicate');
    assert.deepEqual(report.cases[0]?.sources, ['alpha/case.json', 'copy/alpha/case.json']);
    assert.deepEqual(report.unexpected, [{ id: 'extra', source: 'extra/case.json' }]);
    assert.equal(report.passRate, 0);
    assert.equal(report.metrics.costUsd.measuredTotal, null);
  });

  it('R1 rejects empty, duplicate or unsafe expected sets', () => {
    assert.throws(() => analyzeEvalOutcomes([], []), /at least one/);
    assert.throws(() => analyzeEvalOutcomes([expected[0]!, expected[0]!], []), /duplicate/);
    assert.throws(() => analyzeEvalOutcomes([{ id: '../escape', expect: 'done' }], []), /case id/);
  });

  it('R3 distinguishes measured zeros from unknown values and reports coverage', () => {
    const report = analyzeEvalOutcomes([{ id: 'alpha', expect: 'stopped' }, expected[1]!], [evidence('alpha', { ms: 0, cost: 0, attempts: 0, stopped: 'input_rejected' }), evidence('beta', { cost: null })]);
    assert.deepEqual(report.metrics.costUsd, { measured: 1, expected: 2, coverage: 0.5, measuredTotal: 0, total: null, p50: 0, p95: 0 });
    assert.equal(report.metrics.ms.total, 100);
    assert.equal(report.cases[1]?.metrics.costUsd, null);
    assert.equal(report.completeSuite, false);
    assert.match(report.percentileMethod, /nearest-rank/);
    assert.match(report.interpretation, /no improvement claim/i);
  });

  it('R3 does not substitute partial attempt sums for missing terminal totals', () => {
    const record = evidence('alpha');
    const report = analyzeEvalOutcomes([expected[0]!], [{ ...record, logs: { create: '{"t":"attempt","runId":"r","step":"plan","n":1,"ms":50,"costUsd":0.2}' } }]);
    assert.deepEqual(report.cases[0]?.metrics, { ms: null, costUsd: null, attempts: null });
    assert.equal(report.completeSuite, false);
    assert.equal(report.metrics.ms.p50, null);
  });

  it('R3 labels nonfinite and negative metrics as unknown', () => {
    for (const value of [-1, '4', null, Infinity]) {
      const report = analyzeEvalOutcomes([expected[0]!], [evidence('alpha', { cost: value })]);
      assert.equal(report.metrics.costUsd.measured, 0);
      assert.equal(report.metrics.costUsd.total, null);
      assert.equal(report.completeSuite, false);
    }
  });

  it('R3 uses nearest-rank percentiles across measured case totals', () => {
    const ids = ['one', 'two', 'three', 'four'];
    const report = analyzeEvalOutcomes(ids.map((id, i) => ({ id, expect: i === 0 ? 'stopped' : 'done' })), ids.map((id, i) => evidence(id, { ms: [10, 20, 30, 100][i], attempts: i, ...(i === 0 ? { stopped: 'input_rejected' } : {}) })));
    assert.deepEqual(report.metrics.ms, { measured: 4, expected: 4, coverage: 1, measuredTotal: 160, total: 160, p50: 20, p95: 100 });
    assert.equal(report.metrics.attempts.p50, 1);
    assert.equal(report.metrics.attempts.p95, 3);
    assert.equal(report.completeSuite, true);
    assert.equal(report.allPassed, true);
  });

  it('R2 refuses identity/expectation/phase mismatches and contradictory or malformed logs', () => {
    const good = evidence('alpha');
    const file = JSON.parse(good.caseText!);
    const mutants: EvalEvidence[] = [
      { ...good, caseText: JSON.stringify({ ...file, id: 'other' }) },
      { ...good, caseText: JSON.stringify({ ...file, expect: 'stopped' }) },
      { ...good, caseText: JSON.stringify({ ...file, phases: [{ phase: 'change', result: 'done', error: null }] }) },
      { ...good, caseText: JSON.stringify({ ...file, phases: [...file.phases, ...file.phases] }) },
      { ...good, logs: { create: log(1, 1, 1, 'stopped') } },
      { ...good, logs: { create: log() + '\n{broken' } },
      { ...good, logs: { create: log() + '\n' + log() } },
    ];
    for (const mutant of mutants) {
      const report = analyzeEvalOutcomes([expected[0]!], [mutant]);
      assert.equal(report.cases[0]?.status, 'invalid');
      assert.equal(report.passed, 0);
      assert.equal(report.completeSuite, false);
    }
  });

  it('R2 verifies expected stopped reasons instead of counting model errors or unlogged stops', () => {
    const cases: ExpectedEvalCase[] = [{ id: 'alpha', expect: 'stopped' }];
    assert.equal(analyzeEvalOutcomes(cases, [evidence('alpha', { stopped: 'input_rejected' })]).passRate, 1);
    assert.equal(analyzeEvalOutcomes(cases, [evidence('alpha', { stopped: 'model_error' })]).passRate, 0);
    assert.equal(analyzeEvalOutcomes(cases, [{ ...evidence('alpha', { stopped: 'input_rejected' }), logs: {} }]).passRate, 0);
  });

  it('R2-R3 requires an expected change phase and totals both measured phases', () => {
    const cases: ExpectedEvalCase[] = [{ id: 'alpha', expect: 'done', change: 'Add refunds' }];
    const record = evidence('alpha');
    assert.equal(analyzeEvalOutcomes(cases, [record]).counts.invalid, 1);
    const file = JSON.parse(record.caseText!);
    file.phases.push({ phase: 'change', result: 'done', error: null });
    const report = analyzeEvalOutcomes(cases, [{ ...record, caseText: JSON.stringify(file), logs: { create: log(100, 1, 1), change: log(200, 2, 2, 'done', 'input_rejected', 'iterate') } }]);
    assert.deepEqual(report.cases[0]?.metrics, { ms: 300, costUsd: 3, attempts: 3 });
    assert.equal(report.completeSuite, true);
    for (const change of [log(), log(100, 1, 1, 'done', 'input_rejected', 'iterate').replaceAll('r-iterate', 'r-create')]) {
      const copied = analyzeEvalOutcomes(cases, [{ ...record, caseText: JSON.stringify(file), logs: { create: log(), change } }]);
      assert.equal(copied.counts.invalid, 1);
      assert.equal(copied.completeSuite, false);
    }
    const wrongMode = analyzeEvalOutcomes([expected[0]!], [{ ...record, logs: { create: log().replace('"mode":"create"', '"mode":"iterate"') } }]);
    assert.equal(wrongMode.counts.invalid, 1);
  });

  it('R3 does not call missing or nonconsecutive attempt records zero', () => {
    for (const text of [log().split('\n').slice(1).join('\n'), log().replace('"n":1', '"n":2')]) {
      const report = analyzeEvalOutcomes([expected[0]!], [{ ...evidence('alpha'), logs: { create: text } }]);
      assert.equal(report.metrics.attempts.total, null);
      assert.equal(report.completeSuite, false);
    }
  });

  it('R2 rejects unknown tags/reasons, interleaved runs and reordered boundaries without echoing payloads', () => {
    const secret = 'sk-example-never-print';
    for (const text of [
      log().replace('"attempt"', '"future_event"'),
      log().replace('"step":"plan"', '"runId":"foreign","step":"plan"'),
      log().split('\n').reverse().join('\n'),
      log(1, 1, 1, 'stopped', 'future_reason'),
      `${log()}\n{"password":"${secret}"`,
    ]) {
      const report = analyzeEvalOutcomes([expected[0]!], [{ ...evidence('alpha'), logs: { create: text } }]);
      assert.equal(report.counts.invalid, 1);
      assert.equal(JSON.stringify(report).includes(secret), false);
    }
    const report = analyzeEvalOutcomes([expected[0]!], [{ ...evidence('alpha'), caseText: `{"password":"${secret}"` }]);
    assert.equal(JSON.stringify(report).includes(secret), false);
  });

  it('R3 checks step counts, keeps a legitimate zero-attempt preflight and resets only the backtrack target counter', () => {
    const wrap = (events: unknown[], stopped = false) => [
      { t: 'run_started', runId: 'r', mode: 'create' }, ...events,
      { t: 'run_finished', runId: 'r', ms: 1, costUsd: 0, result: stopped ? { kind: 'stopped', reason: { kind: 'budget_exhausted' } } : { kind: 'done' } },
    ].map((e) => JSON.stringify(e)).join('\n');
    const start = { t: 'step_started', runId: 'r', step: 'plan' };
    const finish = { t: 'step_finished', runId: 'r', step: 'plan', attempts: 1 };
    const attempt = { t: 'attempt', runId: 'r', step: 'plan', n: 1 };
    const missing = analyzeEvalOutcomes([expected[0]!], [{ ...evidence('alpha'), logs: { create: wrap([start, finish]) } }]);
    assert.equal(missing.metrics.attempts.total, null);
    const preflight = analyzeEvalOutcomes([{ id: 'alpha', expect: 'stopped' }], [{ ...evidence('alpha', { stopped: 'budget_exhausted' }), logs: { create: wrap([start, { t: 'call_refused', runId: 'r', step: 'plan' }], true) } }]);
    assert.equal(preflight.metrics.attempts.total, 0);
    assert.equal(preflight.completeSuite, true);
    const backtracked = analyzeEvalOutcomes([expected[0]!], [{ ...evidence('alpha'), logs: { create: wrap([
      start, attempt, finish,
      { ...start, step: 'model' }, { ...attempt, step: 'model' },
      { t: 'backtracked', runId: 'r', from: 'model', to: 'plan' },
      start, attempt, finish,
      { ...start, step: 'model' }, { ...attempt, step: 'model', n: 2 }, { ...finish, step: 'model' },
    ]) } }]);
    assert.equal(backtracked.metrics.attempts.total, 4);
    assert.equal(backtracked.completeSuite, true);
  });

  it('R3 lets a step rerun after a backtrack restart at 1 (YOS-258) or continue its count (runs before it), and nothing else', () => {
    const start = { t: 'step_started', runId: 'r', step: 'plan' };
    const finish = { t: 'step_finished', runId: 'r', step: 'plan', attempts: 1 };
    const attempt = { t: 'attempt', runId: 'r', step: 'plan', n: 1 };
    const rerun = (...ns: number[]) => analyzeEvalOutcomes([expected[0]!], [{ ...evidence('alpha'), logs: { create: [
      { t: 'run_started', runId: 'r', mode: 'create' },
      start, attempt, finish,
      { ...start, step: 'model' }, { ...attempt, step: 'model' },
      { t: 'backtracked', runId: 'r', from: 'model', to: 'plan' },
      start, attempt, finish,
      { ...start, step: 'model' }, ...ns.map((n) => ({ ...attempt, step: 'model', n })), { ...finish, step: 'model', attempts: ns.length },
      { t: 'run_finished', runId: 'r', ms: 1, costUsd: 0, result: { kind: 'done' } },
    ].map((e) => JSON.stringify(e)).join('\n') } }]);
    for (const [ns, total] of [[[1], 4], [[2], 4], [[1, 2], 5], [[3], null], [[1, 3], null], [[1, 1], null]] as const) {
      const report = rerun(...ns);
      assert.equal(report.metrics.attempts.total, total, JSON.stringify(ns));
      assert.equal(report.completeSuite, total !== null, JSON.stringify(ns));
    }
  });

  it('R3 refuses orphan events, impossible backtracks and completion after refusal as complete attempt coverage', () => {
    const start = { t: 'step_started', step: 'plan' };
    const attempt = { t: 'attempt', step: 'plan', n: 1 };
    const refused = { t: 'call_refused', step: 'plan' };
    const backtrack = { t: 'backtracked', from: 'plan', to: 'plan' };
    for (const middle of [[attempt], [refused], [backtrack], [start, backtrack], [start, refused], [start, refused, attempt], [start, { t: 'step_finished', step: 'plan', attempts: 0 }], []]) {
      const text = [{ t: 'run_started', mode: 'create' }, ...middle, { t: 'run_finished', ms: 0, costUsd: 0, result: { kind: 'done' } }]
        .map((e) => JSON.stringify({ ...e, runId: 'r' })).join('\n');
      const report = analyzeEvalOutcomes([expected[0]!], [{ ...evidence('alpha'), logs: { create: text } }]);
      assert.equal(report.metrics.attempts.total, null, JSON.stringify(middle));
      assert.equal(report.completeSuite, false);
    }
  });
});
