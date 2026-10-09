import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gatherScorecards } from '../src/cli/scorecards.ts';
import { parseManifest } from '../src/dataset/schema.ts';
import {
  exportCounts, fidelityKinds, fidelityRows, generatorRow, graderTotals, parseDifficulty, renderScorecards, suiteFor,
  type ExportInput, type RunInput, type ScorecardInputs,
} from '../src/scorecards/cards.ts';
import type { EvalEvidence } from '../src/worldgen/eval-outcomes.ts';

const REPO = path.resolve(import.meta.dirname, '../..');

/** A case's events.jsonl: a create run that ends done after `ms` and `costUsd`, with any extra events before the end. */
function log(ms: number, costUsd: number, extra: readonly object[] = []): string {
  return [
    { t: 'run_started', mode: 'create' },
    { t: 'step_started', step: 'plan' },
    { t: 'attempt', step: 'plan', n: 1 },
    { t: 'step_finished', step: 'plan', attempts: 1 },
    ...extra,
    { t: 'run_finished', ms, costUsd, result: { kind: 'done' } },
  ].map((e) => JSON.stringify({ runId: 'r-create', ...e })).join('\n');
}
function evidence(id: string, o: { ms?: number; costUsd?: number; pass?: boolean; extra?: readonly object[] } = {}): EvalEvidence {
  return {
    id, source: `${id}/case.json`,
    caseText: JSON.stringify({ id, expect: 'done', phases: [{ phase: 'create', result: 'done', error: null }], verify: o.pass === false ? { kind: 'fail', codes: ['task.failed'] } : { kind: 'pass', tasks: 3 } }),
    logs: { create: log(o.ms ?? 60_000, o.costUsd ?? 1, o.extra) },
  };
}
const run = (evidence: readonly EvalEvidence[]): RunInput => ({
  run: 'eval/runs/r1', suite: 'stress', suiteFile: 'eval/suite.yaml',
  cases: [{ id: 'alpha', expect: 'done' }, { id: 'beta', expect: 'done' }, { id: 'gamma', expect: 'done' }], evidence,
});

describe('prod/scorecards.md', () => {
  // One engine pass over prod/worlds serves both tests.
  const inputs = gatherScorecards(REPO);

  it('is what `bun run scorecards` writes (A-402)', async () => {
    const onDisk = await readFile(path.join(REPO, 'prod/scorecards.md'), 'utf8').catch(() => '(missing)');
    assert.equal(onDisk, renderScorecards(await inputs), 'prod/scorecards.md is stale. Run `bun run scorecards` in code/ and commit prod/scorecards.md.');
  });

  it('counts the grader checks and mutant slots research/evidence/probe-coverage.md counts', async () => {
    const md = await readFile(path.join(REPO, 'research/evidence/probe-coverage.md'), 'utf8');
    const total = /^\| \*\*Total\*\* \| (\d+) \| (\d+)\/(\d+) \([^)]*\) \| (\d+)\/(\d+) /m.exec(md);
    assert.ok(total !== null, 'probe-coverage.md has no Total row');
    const t = graderTotals((await inputs).worlds.flatMap((w) => ('tasks' in w ? w.tasks : [])));
    assert.deepEqual([t.tasks, t.flipped, t.checks, t.probed, t.slots], total.slice(1).map(Number), 'regenerate research/evidence/probe-coverage.md and prod/scorecards.md together');
  });
});

describe('scorecards (A-402)', () => {
  it('scores a run against the suite that holds most of its cases, and none on a tie', () => {
    const suites = [{ file: 'eval/suite.yaml', ids: ['alpha', 'beta'] }, { file: 'eval/live-segment.yaml', ids: ['gamma'] }];
    assert.equal(suiteFor(['alpha', 'beta', 'gamma'], suites), 'eval/suite.yaml');
    assert.equal(suiteFor(['alpha', 'gamma'], suites), null);
    assert.equal(suiteFor(['delta'], suites), null);
  });

  it('a generator row rates the cases a run ran, names a folder the suite lacks, and takes nearest-rank times', () => {
    const r = generatorRow(run([evidence('alpha', { ms: 120_000, costUsd: 1.5 }), evidence('beta', { ms: 60_000, costUsd: 0.5, pass: false }), evidence('extra')]));
    assert.deepEqual(r, {
      run: 'eval/runs/r1', suite: 'stress', suiteFile: 'eval/suite.yaml', suiteSize: 3, ran: 2, passed: 1,
      outcomes: { success: 1, 'expected refusal': 0, 'product failure': 1, 'infra failure': 0, 'not run': 1 },
      p50Ms: 60_000, p95Ms: 120_000, usd: 2, usdCases: 2, unexpected: ['extra'],
    });
  });

  it('a fidelity row is each recorded reference score, or none for a referenced case that recorded no score', () => {
    const r = run([
      evidence('alpha', { extra: [{ t: 'fidelity', check: { kind: 'reference', reference: 'alpha', score: 0.7912, floor: 0.8 } }] }),
      evidence('beta', { extra: [{ t: 'fidelity', check: { kind: 'openapi' } }] }),
      evidence('gamma'),
    ]);
    assert.deepEqual(fidelityRows(r, ['alpha', 'gamma']), [
      { run: 'eval/runs/r1', caseId: 'alpha', source: 'eval/runs/r1/alpha/events.jsonl', reference: 'alpha', score: 0.7912, floor: 0.8 },
      { run: 'eval/runs/r1', caseId: 'gamma', source: 'eval/runs/r1/gamma/events.jsonl', reference: 'gamma', score: null, floor: 0.8 },
    ]);
    assert.deepEqual(fidelityKinds(r), { reference: 1, openapi: 1, unchecked: 0, none: 1 });
  });

  it('grader totals add tasks, decoys, alternatives, one-write solutions, checks and slots', () => {
    const t = graderTotals([
      { task: 'a', decoys: [0.5, 0], alternatives: 1, solutionWrites: 1, checks: 3, flipped: 2, slots: 8, probed: 5 },
      { task: 'b', decoys: [0.25], alternatives: 0, solutionWrites: 3, checks: 2, flipped: 2, slots: 8, probed: 1 },
    ]);
    assert.deepEqual(t, { tasks: 2, decoys: 3, alternatives: 1, oneWrite: 1, checks: 5, flipped: 4, slots: 16, probed: 6 });
  });

  it('reads a difficulty.json, and names why a file is not one', () => {
    const ok = parseDifficulty(JSON.stringify({
      runId: 'p', models: ['claude-sonnet-5-5'], episodesPerCell: 3, budgetUsd: 5, spentUsd: 1.25, stop: { kind: 'complete' }, episodes: [{}, {}, {}],
      cells: [{ world: 'helpdesk', task: 't', labeled: 'hard', model: 'claude-sonnet-5-5', episodes: 3, trials: 3, passes: 1, passRate: 0.333, interval: [0.061, 0.792], measured: 'hard' }],
    }));
    assert.equal(ok.ok, true);
    assert.deepEqual(parseDifficulty('{'), { ok: false, error: 'not JSON' });
    assert.equal(parseDifficulty('{}').ok, false);
  });

  it('counts a schema-1 export by success and the rest, and a schema-2 export by verdict', async () => {
    const source = 'eval/dataset/2026-10-07/helpdesk/manifest.json';
    const v1 = parseManifest(JSON.parse(await readFile(path.join(REPO, source), 'utf8')), source);
    assert.deepEqual(exportCounts(v1), { episodes: 6, success: 6, partial: null, failure: null, infra: null, notSuccess: 0 });
    const v2 = parseManifest({
      manifest_version: 2, schema_version: 2, provider: v1.provider, model: v1.model, prompt_versions: v1.prompt_versions, config_versions: v1.config_versions,
      engine_commits: v1.engine_commits, run_ids: v1.run_ids, worlds: v1.worlds, grading_note: v1.grading_note, selection: null,
      counts: { episodes: 5, by_verdict: { success: 1, partial: 1, failure: 2, infra: 1 }, by_stop_reason: { done: 4, model_error: 1 }, by_failure_cause: { 'scored 0': 2, 'scored 0.5': 1, model_error: 1 } },
      files: { dataset: v1.files.dataset },
    }, 'v2');
    assert.deepEqual(exportCounts(v2), { episodes: 5, success: 1, partial: 1, failure: 2, infra: 1, notSuccess: 4 });

    const exports: ExportInput[] = [{ source, manifest: v1 }, { source: 'eval/dataset/x/w/manifest.json', manifest: v2 }];
    const empty: ScorecardInputs = { runs: [], unmatchedRuns: [], otherRuns: [], references: [], worlds: [], difficulty: [], exports };
    const md = renderScorecards(empty);
    assert.ok(md.includes('| **Total** |  |  | 11 | 7 |  |  |  | 4 | `eval/dataset/` |'));
    assert.ok(md.includes('1 schema-2 export folder holds 5 episodes: 1 success, 1 partial, 2 failure, 1 infra.'));
    assert.ok(md.includes('No difficulty run is committed.'));
  });
});
