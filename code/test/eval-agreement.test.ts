/**
 * One classifier for the eval (YOS-240, A-340): the same case files, read as summary.md reads them (cli/eval.ts collect)
 * and as eval-outcomes.ts reads them, give every case the same outcome and pass, summary.md's Totals and Pass rate
 * count the same passes, and both publish the same rate over every expected case (A-341).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeEvalOutcomes, type EvalEvidence } from '../src/worldgen/eval-outcomes.ts';
import { parseEventLog, readCaseFile, renderSummary, summarizeCase, type Expect, type SummaryEntry } from '../src/worldgen/eval.ts';

type Files = { readonly id: string; readonly expect: Expect; readonly caseText: string | null; readonly log: string };

function log(id: string, finish: object | null): string {
  return [
    { t: 'run_started', mode: 'create' },
    { t: 'step_started', step: 'plan' },
    { t: 'attempt', step: 'plan', n: 1, ms: 1000, costUsd: 0.5 },
    ...(finish === null ? [] : [{ t: 'step_finished', step: 'plan', attempts: 1 }, { t: 'run_finished', ms: 1000, costUsd: 0.5, result: finish }]),
  ].map((e) => JSON.stringify({ at: '2026-10-08T00:00:00.000Z', runId: `r-${id}`, ...e })).join('\n');
}

function files(id: string, expect: Expect, result: 'done' | 'stopped' | null, verify: object, finish: object | null, error: string | null = null): Files {
  return { id, expect, caseText: JSON.stringify({ id, expect, phases: [{ phase: 'create', result, error }], verify }), log: log(id, finish) };
}

const stopped = (kind: string): object => ({ kind: 'stopped', reason: { kind, step: 'plan' } });
const REFUSED = { kind: 'stopped', reason: { kind: 'input_rejected', why: 'a video codec is not a stateful API' } };
const PASS = { kind: 'pass', tasks: 3 };
const NOT_RUN = { kind: 'not_run' };

const FIXTURE: readonly Files[] = [
  files('builds-helpdesk', 'done', 'done', PASS, { kind: 'done' }),
  files('refuses-codec', 'stopped', 'stopped', NOT_RUN, REFUSED),
  files('gives-up-on-codec', 'stopped', 'stopped', NOT_RUN, stopped('attempts_exhausted')),
  files('stops-on-a-done-case', 'done', 'stopped', NOT_RUN, stopped('no_progress')),
  files('fails-verify', 'done', 'done', { kind: 'fail', codes: ['task.noop_nonzero'] }, { kind: 'done' }),
  files('overloaded', 'stopped', 'stopped', NOT_RUN, stopped('model_error')),
  files('stopped-no-reason', 'stopped', 'stopped', NOT_RUN, null),
  files('segfault', 'done', null, NOT_RUN, null, 'Bun segfault'),
  { id: 'unreadable', expect: 'done', caseText: '{', log: '' },
  { id: 'never-started', expect: 'done', caseText: null, log: '' },
];

/** Each case as summary.md reads it: a missing case.json, an unreadable one, or a record with its parsed log. */
function summaryEntry(f: Files): SummaryEntry {
  if (f.caseText === null) return { kind: 'missing', id: f.id, expect: f.expect };
  const read = readCaseFile(f.caseText);
  if (!read.ok) return { kind: 'invalid', id: f.id, expect: f.expect, why: read.why };
  return { kind: 'record', record: { ...read.file, phases: read.file.phases.map((p) => ({ ...p, log: parseEventLog(`${f.log}\n`) })) } };
}

const EXPECTED: readonly [string, string, boolean][] = [
  ['builds-helpdesk', 'success', true],
  ['refuses-codec', 'expected refusal', true],
  ['gives-up-on-codec', 'product failure', false],
  ['stops-on-a-done-case', 'product failure', false],
  ['fails-verify', 'product failure', false],
  ['overloaded', 'infra failure', false],
  ['stopped-no-reason', 'infra failure', false],
  ['segfault', 'infra failure', false],
  ['unreadable', 'infra failure', false],
  ['never-started', 'not run', false],
];

describe('one outcome classifier for summary.md and eval-outcomes (A-340)', () => {
  const entries = FIXTURE.map(summaryEntry);
  const evidence: EvalEvidence[] = FIXTURE.flatMap((f) => (f.caseText === null ? [] : [{ id: f.id, source: `${f.id}/case.json`, caseText: f.caseText, logs: { create: f.log } }]));
  const analysis = analyzeEvalOutcomes(FIXTURE.map(({ id, expect }) => ({ id, expect })), evidence);

  it('gives every case the same outcome and pass in both readers', () => {
    const fromSummary = entries.map((e): [string, string, boolean] => {
      if (e.kind === 'missing') return [e.id, 'not run', false];
      if (e.kind === 'invalid') return [e.id, 'infra failure', false];
      const row = summarizeCase(e.record);
      return [row.id, row.outcome, row.pass];
    });
    assert.deepEqual(fromSummary, EXPECTED);
    assert.deepEqual(analysis.cases.map((c) => [c.id, c.outcome, c.passed]), EXPECTED);
  });

  it('counts the same classes and publishes the same pass rate over every expected case', () => {
    const lines = renderSummary({ run: 'agree', suite: 'agree', model: 'claude-sonnet-5-5', budgetUsd: 1, maxMinutes: 1 }, entries).split('\n');
    const totals = lines.find((l) => l.startsWith('**Totals:**')) ?? '';
    assert.equal(totals.startsWith('**Totals:** 10 expected cases: 1 success, 1 expected refusal, 3 product failure, 4 infra failure, 1 not run; '), true, totals);
    assert.equal(lines.find((l) => l.startsWith('**Pass rate:**')), '**Pass rate:** 2/10 (20%), success and expected refusal over all 10 expected cases (1 not run).');
    assert.deepEqual(analysis.outcomes, { success: 1, 'expected refusal': 1, 'product failure': 3, 'infra failure': 4, 'not run': 1 });
    assert.equal(analysis.passed, 2);
    assert.equal(analysis.passRate, 2 / 10);
  });
});
