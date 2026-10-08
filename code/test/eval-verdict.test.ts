/**
 * YOS-240: one verdict per expected case, shared by the summary scorecard (eval.ts)
 * and the offline analyzer (eval-outcomes.ts). A stopped case passes only on a
 * semantic expected refusal; product and infrastructure stops, unlogged stops and
 * broken or missing evidence never pass, and a done case passes only on a passed
 * verification. The same class and pass must come out of both consumers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  entryVerdict,
  parseEventLog,
  renderSummary,
  STOP_IS_VERDICT,
  summarizeCase,
  VERDICT_IDENTITY,
  type CaseRecord,
  type PhaseInput,
  type SummaryEntry,
  type VerdictClass,
  type VerifyResult,
} from '../src/worldgen/eval.ts';
import { analyzeEvalOutcomes, type EvalEvidence, type ExpectedEvalCase } from '../src/worldgen/eval-outcomes.ts';
import type { RunEvent, StopReason } from '../src/worldgen/events.ts';

const AT = { at: '2026-10-06T10:00:00.000Z', runId: 'r1' } as const;
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } as const;

const runStarted: RunEvent = { ...AT, t: 'run_started', mode: 'create', input: 'description', model: 'fixture', budgetUsd: 1 };
const stepStarted: RunEvent = { ...AT, t: 'step_started', step: 'plan', reason: 'planned' };
const attemptEvt: RunEvent = { ...AT, t: 'attempt', step: 'plan', n: 1, ms: 100, usage: USAGE, costUsd: 0.1, outcome: { kind: 'accepted', warnings: 0 }, dump: '' };
const stepFinished: RunEvent = { ...AT, t: 'step_finished', step: 'plan', attempts: 1, ms: 100, costUsd: 0.1 };
const doneEvt: RunEvent = { ...AT, t: 'run_finished', ms: 100, costUsd: 0.1, worldWritten: true, result: { kind: 'done', worldDir: '/w' } };
const stoppedEvt = (reason: StopReason): RunEvent => ({ ...AT, t: 'run_finished', ms: 100, costUsd: 0, worldWritten: false, result: { kind: 'stopped', reason } });

/** The stop payloads of every stop kind the issue lists as a machinery, cancellation or product stop. */
const STOP_PAYLOADS = {
  input_rejected: { kind: 'input_rejected', why: 'not a stateful API world' },
  model_error: { kind: 'model_error', message: '529 overloaded' },
  judge_error: { kind: 'judge_error', step: 'model', message: 'runtime seeding failed' },
  infra_unavailable: { kind: 'infra_unavailable', step: 'model', issues: [] },
  transport_stalled: { kind: 'transport_stalled', step: 'plan', idleMs: 120_000 },
  cancelled: { kind: 'cancelled' },
  cost_unenforceable: { kind: 'cost_unenforceable', cap: 'maxDailyLlmUsd', claim: null },
} as const satisfies Record<string, StopReason>;

/** One expected case as both consumers can read it. */
type FixtureTerminal =
  | { readonly kind: 'done'; readonly verify: 'pass' | 'fail' }
  | { readonly kind: 'stopped'; readonly reason: StopReason | null }
  | { readonly kind: 'crashed' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' };
type Fixture = { readonly id: string; readonly expect: 'done' | 'stopped'; readonly terminal: FixtureTerminal };

function eventsOf(f: Fixture): readonly RunEvent[] {
  const prefix = [runStarted, stepStarted, attemptEvt, stepFinished];
  switch (f.terminal.kind) {
    case 'done':
      return [...prefix, doneEvt];
    case 'stopped':
      return f.terminal.reason === null ? prefix : [...prefix, stoppedEvt(f.terminal.reason)];
    case 'crashed':
      return [runStarted];
    case 'missing':
    case 'invalid':
      return [];
  }
}

function caseFileOf(f: Fixture): {
  id: string;
  expect: 'done' | 'stopped';
  phases: { phase: 'create'; result: 'done' | 'stopped' | null; error: string | null }[];
  verify: VerifyResult;
} {
  const result = f.terminal.kind === 'done' ? 'done' : f.terminal.kind === 'stopped' ? 'stopped' : null;
  const error = f.terminal.kind === 'crashed' ? 'runner threw' : null;
  const verify: VerifyResult =
    f.terminal.kind === 'done'
      ? f.terminal.verify === 'pass'
        ? { kind: 'pass', tasks: 1 }
        : { kind: 'fail', codes: ['task.failed'] }
      : { kind: 'not_run' };
  return { id: f.id, expect: f.expect, phases: [{ phase: 'create', result, error }], verify };
}

/** The analyzer's input for one expected case: the manifest entry and its evidence. */
function evidenceOf(f: Fixture): EvalEvidence[] {
  if (f.terminal.kind === 'missing') return [];
  if (f.terminal.kind === 'invalid') return [{ id: f.id, source: `${f.id}/case.json`, caseText: '{broken', logs: {} }];
  const text = eventsOf(f).map((e) => JSON.stringify(e)).join('\n');
  return [{ id: f.id, source: `${f.id}/case.json`, caseText: JSON.stringify(caseFileOf(f)), logs: { create: text } }];
}

/** The summary's input for one expected case: one entry, record, missing or invalid. */
function summaryEntryOf(f: Fixture): SummaryEntry {
  if (f.terminal.kind === 'missing') return { kind: 'missing', id: f.id, expect: f.expect };
  if (f.terminal.kind === 'invalid') return { kind: 'invalid', id: f.id, expect: f.expect, why: 'broken case.json' };
  const phase: PhaseInput = {
    phase: 'create',
    result: f.terminal.kind === 'done' ? 'done' : f.terminal.kind === 'stopped' ? 'stopped' : null,
    error: f.terminal.kind === 'crashed' ? 'runner threw' : null,
    log: parseEventLog(`${eventsOf(f).map((e) => JSON.stringify(e)).join('\n')}\n`),
  };
  const record: CaseRecord = { ...caseFileOf(f), phases: [phase] };
  return { kind: 'record', record };
}

/** The summary's record for a fixture that left one. */
function recordOf(f: Fixture): CaseRecord {
  const entry = summaryEntryOf(f);
  assert.equal(entry.kind, 'record', f.id);
  return entry.record;
}

function stopped(id: string, reason: StopReason | null): Fixture {
  return { id, expect: 'stopped', terminal: { kind: 'stopped', reason } };
}

const META = { run: '2026-10-06-verdict', suite: 'verdict', model: 'fixture', budgetUsd: 1, maxMinutes: 1 };

describe('YOS-240 red-first fixtures: machinery, cancellation and product stops never pass an expected refusal', () => {
  const NEVER_PASS: readonly (readonly [string, StopReason, VerdictClass])[] = [
    ['model_error', STOP_PAYLOADS.model_error, 'product_failure'],
    ['judge_error', STOP_PAYLOADS.judge_error, 'infrastructure_failure'],
    ['infra_unavailable', STOP_PAYLOADS.infra_unavailable, 'infrastructure_failure'],
    ['transport_stalled', STOP_PAYLOADS.transport_stalled, 'infrastructure_failure'],
    ['cancelled', STOP_PAYLOADS.cancelled, 'infrastructure_failure'],
    ['cost_unenforceable', STOP_PAYLOADS.cost_unenforceable, 'infrastructure_failure'],
  ];
  for (const [kind, reason, verdictClass] of NEVER_PASS) {
    it(`an expected stop on ${kind} is passed=false in the offline analyzer`, () => {
      const report = analyzeEvalOutcomes([{ id: 'case', expect: 'stopped' }], evidenceOf(stopped('case', reason)));
      assert.equal(report.counts.valid, 1);
      assert.equal(report.cases[0]?.passed, false);
      assert.equal(report.cases[0]?.class, verdictClass);
      assert.equal(report.passed, 0);
      assert.equal(report.passRate, 0);
      assert.equal(report.allPassed, false);
    });
    it(`an expected stop on ${kind} is pass=false in the summary scorecard`, () => {
      const row = summarizeCase(recordOf(stopped('case', reason)));
      assert.equal(row.status, 'stopped');
      assert.equal(row.pass, false);
      assert.equal(row.verdict.class, verdictClass);
      assert.equal(row.verdict.pass, false);
    });
  }

  it('an expected stop whose reason was never logged is passed=false in both consumers', () => {
    const fixture = stopped('case', null);
    const report = analyzeEvalOutcomes([{ id: 'case', expect: 'stopped' }], evidenceOf(fixture));
    assert.equal(report.counts.valid, 1);
    assert.equal(report.cases[0]?.passed, false);
    assert.equal(report.cases[0]?.class, 'invalid_evidence');
    const row = summarizeCase(recordOf(fixture));
    assert.equal(row.status, 'stopped');
    assert.equal(row.pass, false);
    assert.equal(row.verdict.class, 'invalid_evidence');
  });

  it('an expected stop on a kind outside the closed union is passed=false in the summary scorecard', () => {
    const unknown = JSON.stringify({ ...AT, t: 'run_finished', ms: 100, costUsd: 0, result: { kind: 'stopped', reason: { kind: 'future_reason' } } });
    const record: CaseRecord = {
      id: 'case',
      expect: 'stopped',
      phases: [{ phase: 'create', result: 'stopped', error: null, log: parseEventLog(`${unknown}\n`) }],
      verify: { kind: 'not_run' },
    };
    const row = summarizeCase(record);
    assert.equal(row.status, 'stopped');
    assert.equal(row.pass, false);
    assert.equal(row.verdict.class, 'invalid_evidence');
  });
});

describe('YOS-240: a genuine refusal passes, and a done case requires verification', () => {
  it('pins the verdict table: the eight verdict stops and the six non-verdict stops', () => {
    // A new StopReason kind (such as the cost admission stop landing with YOS-227) fails
    // typecheck until this table classifies it, so the two consumers cannot drift.
    assert.deepEqual(STOP_IS_VERDICT, {
      input_rejected: true,
      attempts_exhausted: true,
      no_progress: true,
      backtrack_limit: true,
      budget_exhausted: true,
      spend_cap: true,
      cost_unenforceable: false,
      time_exhausted: true,
      stage_time_exhausted: true,
      model_error: false,
      judge_error: false,
      infra_unavailable: false,
      transport_stalled: false,
      cancelled: false,
    });
  });

  it('an honest verdict stop passes an expect: stopped case in both consumers', () => {
    const fixture = stopped('case', STOP_PAYLOADS.input_rejected);
    const report = analyzeEvalOutcomes([{ id: 'case', expect: 'stopped' }], evidenceOf(fixture));
    assert.equal(report.cases[0]?.passed, true);
    assert.equal(report.cases[0]?.class, 'expected_refusal');
    assert.equal(report.passed, 1);
    const row = summarizeCase(recordOf(fixture));
    assert.equal(row.pass, true);
    assert.equal(row.verdict.class, 'expected_refusal');
  });

  it('a done case passes only on a passed verification, and a failed verification never passes', () => {
    for (const verify of ['pass', 'fail'] as const) {
      const fixture: Fixture = { id: 'case', expect: 'done', terminal: { kind: 'done', verify } };
      const report = analyzeEvalOutcomes([{ id: 'case', expect: 'done' }], evidenceOf(fixture));
      assert.equal(report.cases[0]?.class, 'done');
      assert.equal(report.cases[0]?.passed, verify === 'pass', `verify ${verify} in the analyzer`);
      const row = summarizeCase(recordOf(fixture));
      assert.equal(row.verdict.class, 'done');
      assert.equal(row.pass, verify === 'pass', `verify ${verify} in the summary`);
    }
  });

  it('a done terminal with a passing verification never passes an expect: stopped case', () => {
    const fixture: Fixture = { id: 'case', expect: 'stopped', terminal: { kind: 'done', verify: 'pass' } };
    const report = analyzeEvalOutcomes([{ id: 'case', expect: 'stopped' }], evidenceOf(fixture));
    assert.equal(report.cases[0]?.class, 'done');
    assert.equal(report.cases[0]?.passed, false);
    const row = summarizeCase(recordOf(fixture));
    assert.equal(row.pass, false);
  });
});

describe('YOS-240: both consumers answer every expected case with the same class and pass', () => {
  const EQUIVALENCE: readonly Fixture[] = [
    { id: 'done-pass', expect: 'done', terminal: { kind: 'done', verify: 'pass' } },
    { id: 'done-fail', expect: 'done', terminal: { kind: 'done', verify: 'fail' } },
    { id: 'done-but-refused', expect: 'done', terminal: { kind: 'stopped', reason: STOP_PAYLOADS.input_rejected } },
    stopped('refused', STOP_PAYLOADS.input_rejected),
    stopped('model-error', STOP_PAYLOADS.model_error),
    stopped('judge-error', STOP_PAYLOADS.judge_error),
    stopped('infra-unavailable', STOP_PAYLOADS.infra_unavailable),
    stopped('transport-stalled', STOP_PAYLOADS.transport_stalled),
    stopped('cancelled', STOP_PAYLOADS.cancelled),
    stopped('unlogged-stop', null),
    { id: 'crashed', expect: 'done', terminal: { kind: 'crashed' } },
    { id: 'missing', expect: 'done', terminal: { kind: 'missing' } },
    { id: 'invalid', expect: 'done', terminal: { kind: 'invalid' } },
  ];

  it('per-case class and pass are identical across the summary and the offline analyzer', () => {
    for (const f of EQUIVALENCE) {
      const expected: ExpectedEvalCase[] = [{ id: f.id, expect: f.expect }];
      const report = analyzeEvalOutcomes(expected, evidenceOf(f));
      assert.equal(report.counts.expected, 1, f.id);
      const analyzer = report.cases[0];
      assert.ok(analyzer !== undefined, f.id);
      assert.deepEqual({ class: analyzer.class, pass: analyzer.passed }, entryVerdict(summaryEntryOf(f)), f.id);
    }
  });

  it('the whole fixture set carries identical per-case classes, pass counts and explicit denominators', () => {
    const manifest = EQUIVALENCE.map((f): ExpectedEvalCase => ({ id: f.id, expect: f.expect }));
    const entries = EQUIVALENCE.map(summaryEntryOf);
    const evidence = EQUIVALENCE.flatMap(evidenceOf);
    const report = analyzeEvalOutcomes(manifest, evidence);
    // Denominators: every expected case, including missing, invalid and duplicate, counts.
    assert.deepEqual(report.counts, { expected: 13, observed: 12, valid: 11, invalid: 1, missing: 1, duplicate: 0, unexpected: 0 });
    assert.equal(entries.length, 13);
    const summaryVerdicts = entries.map(entryVerdict);
    assert.deepEqual(
      summaryVerdicts.map((v) => [v.class, v.pass]),
      report.cases.map((c) => [c.class, c.passed]),
    );
    assert.equal(summaryVerdicts.filter((v) => v.pass).length, report.passed);
    assert.equal(report.passed, 2);
    assert.equal(report.passRate, 2 / 13);
    // The five-way distinction stays visible: refusal, product failure, infrastructure
    // failure, invalid evidence and not run are six distinct classes with done.
    assert.deepEqual([...new Set(report.cases.map((c) => c.class))].sort(), [
      'done',
      'expected_refusal',
      'infrastructure_failure',
      'invalid_evidence',
      'not_run',
      'product_failure',
    ]);
    // The summary totals count every entry in one of the five classes, and the pass rate
    // denominator is the cases that ran: the missing and invalid entries hold it down.
    const text = renderSummary(META, entries);
    assert.match(text, /13 expected cases: 1 success, 2 expected refusal, 2 product failure, 7 infra failure, 1 not run;/);
    assert.match(text, /Pass rate:\*\* 2\/12 \(17%\), success and expected refusal over the 12 cases that ran \(1 not run\)\./);
  });

  it('a duplicate record counts in the denominator, never passes and classes as invalid evidence', () => {
    const dup = stopped('dup', STOP_PAYLOADS.cancelled);
    const one = evidenceOf(dup)[0]!;
    const two = { ...one, source: 'copy/dup/case.json' };
    const report = analyzeEvalOutcomes([{ id: 'dup', expect: 'stopped' }], [one, two]);
    assert.deepEqual(report.counts, { expected: 1, observed: 2, valid: 0, invalid: 0, missing: 0, duplicate: 1, unexpected: 0 });
    assert.equal(report.cases[0]?.status, 'duplicate');
    assert.equal(report.cases[0]?.class, 'invalid_evidence');
    assert.equal(report.cases[0]?.passed, false);
    assert.equal(report.passed, 0);
    assert.equal(report.passRate, 0);
    // With a passing case beside it, the duplicate still holds the denominator down.
    const done = { id: 'done-pass', expect: 'done' as const, terminal: { kind: 'done' as const, verify: 'pass' as const } };
    const mixed = analyzeEvalOutcomes([{ id: done.id, expect: done.expect }, { id: 'dup', expect: 'stopped' }], [evidenceOf(done)[0]!, one, two]);
    assert.deepEqual(mixed.counts, { expected: 2, observed: 3, valid: 1, invalid: 0, missing: 0, duplicate: 1, unexpected: 0 });
    assert.equal(mixed.passRate, 1 / 2);
  });

  it('both reports state their shared classifier identity and version', () => {
    const report = analyzeEvalOutcomes([{ id: 'case', expect: 'stopped' }], evidenceOf(stopped('case', STOP_PAYLOADS.cancelled)));
    assert.equal(report.verdict.version, 2);
    assert.equal(report.verdict.source, VERDICT_IDENTITY.source);
    assert.match(report.verdict.rule, /judge_error/);
    const text = renderSummary(META, [summaryEntryOf(stopped('case', STOP_PAYLOADS.cancelled))]);
    assert.match(text, /Verdicts \(v2, .*caseVerdict/);
    assert.match(text, /never pass/);
  });
});
