import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gatherScorecards } from '../src/cli/scorecards.ts';
import { parseManifest } from '../src/dataset/schema.ts';
import {
  exportCounts, fidelityKinds, fidelityRows, generatorRow, graderTaskOf, graderTotals, parseDifficulty, renderScorecards, runParts, suiteFor,
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
function evidence(id: string, o: { ms?: number; costUsd?: number; pass?: boolean; extra?: readonly object[]; dir?: string } = {}): EvalEvidence {
  return {
    id, source: `${o.dir ?? 'eval/runs/r1'}/${id}/case.json`,
    caseText: JSON.stringify({ id, expect: 'done', phases: [{ phase: 'create', result: 'done', error: null }], verify: o.pass === false ? { kind: 'fail', codes: ['task.failed'] } : { kind: 'pass', tasks: 3 } }),
    logs: { create: log(o.ms ?? 60_000, o.costUsd ?? 1, o.extra) },
  };
}
const run = (evidence: readonly EvalEvidence[]): RunInput => ({
  run: 'eval/runs/r1', suite: 'stress', suiteFile: 'eval/suite.yaml',
  cases: [{ id: 'alpha', expect: 'done' }, { id: 'beta', expect: 'done' }, { id: 'gamma', expect: 'done' }], evidence,
});
const none: ScorecardInputs = { runs: [], unmatchedRuns: [], otherRuns: [], references: [], worlds: [], difficulty: [], exports: [] };

describe('prod/scorecards.md', () => {
  it('is what `bun run scorecards` writes (A-402)', async () => {
    const onDisk = await readFile(path.join(REPO, 'prod/scorecards.md'), 'utf8').catch(() => '(missing)');
    assert.equal(onDisk, renderScorecards(await gatherScorecards(REPO)), 'prod/scorecards.md is stale. Run `bun run scorecards` in code/ and commit prod/scorecards.md.');
  });
});

describe('scorecards (A-402)', () => {
  it('a run is its own case folders, its disjoint lanes together, or each overlapping arm alone', () => {
    assert.deepEqual(runParts('eval/runs/s6', ['alpha'], [{ name: 'x', ids: ['beta'] }]), [{ run: 'eval/runs/s6', parts: ['eval/runs/s6'] }]);
    assert.deepEqual(runParts('eval/runs/s2', [], [{ name: 'lane-a', ids: ['alpha'] }, { name: 'lane-b', ids: ['beta'] }, { name: 'logs', ids: [] }]),
      [{ run: 'eval/runs/s2', parts: ['eval/runs/s2/lane-a', 'eval/runs/s2/lane-b'] }]);
    assert.deepEqual(runParts('eval/runs/ab', [], [{ name: 'high', ids: ['alpha'] }, { name: 'medium', ids: ['alpha'] }]),
      [{ run: 'eval/runs/ab/high', parts: ['eval/runs/ab/high'] }, { run: 'eval/runs/ab/medium', parts: ['eval/runs/ab/medium'] }]);
    assert.deepEqual(runParts('eval/runs/drill', [], [{ name: 'out', ids: [] }]), []);
  });

  it('scores a run against the suite that holds most of its cases, the smaller one on a tie, and none on a full tie', () => {
    const suites = [{ file: 'eval/suite.yaml', ids: ['alpha', 'beta', 'gamma'] }, { file: 'eval/targeted.yaml', ids: ['alpha', 'beta'] }, { file: 'eval/live-segment.yaml', ids: ['delta'] }];
    assert.equal(suiteFor(['alpha', 'beta', 'gamma'], suites), 'eval/suite.yaml');
    assert.equal(suiteFor(['alpha', 'beta'], suites), 'eval/targeted.yaml');
    assert.equal(suiteFor(['delta', 'alpha'], [{ file: 'eval/a.yaml', ids: ['alpha'] }, { file: 'eval/b.yaml', ids: ['delta'] }]), null);
    assert.equal(suiteFor(['epsilon'], suites), null);
  });

  it('a generator row rates passes over every suite case, names a folder the suite lacks, and takes nearest-rank times', () => {
    const r = generatorRow(run([evidence('alpha', { ms: 120_000, costUsd: 1.5 }), evidence('beta', { ms: 60_000, costUsd: 0.5, pass: false }), evidence('extra')]));
    assert.deepEqual(r, {
      run: 'eval/runs/r1', suite: 'stress', suiteFile: 'eval/suite.yaml', suiteSize: 3, ran: 2, passed: 1,
      outcomes: { success: 1, 'expected refusal': 0, 'product failure': 1, 'infra failure': 0, 'not run': 1 },
      p50Ms: 60_000, p95Ms: 120_000, usd: 2, usdCases: 2, unexpected: ['extra'],
    });
    const md = renderScorecards({ ...none, runs: [run([evidence('alpha', { ms: 120_000, costUsd: 1.5 }), evidence('beta', { ms: 60_000, costUsd: 0.5, pass: false })])] });
    assert.ok(md.includes('| `eval/runs/r1` | stress (`eval/suite.yaml`) | 2 of 3 | 1 | 33.3% | 1 | 0 | 1 | 0 | 1.0 | 2.0 | 2.00 |'));
  });

  it('a fidelity row is each recorded reference score, or none for a referenced suite case that recorded no event in a run that records them', () => {
    const r = run([
      evidence('alpha', { dir: 'eval/runs/r1/lane-a', extra: [{ t: 'fidelity', check: { kind: 'reference', reference: 'alpha', score: 0.9012, floor: 0.8 } }] }),
      evidence('beta', { extra: [{ t: 'fidelity', check: { kind: 'unchecked', software: 'a CRM' } }] }),
      evidence('gamma'),
      evidence('extra', { extra: [{ t: 'fidelity', check: { kind: 'openapi' } }] }),
    ]);
    assert.deepEqual(fidelityRows(r, ['alpha', 'beta', 'gamma']), [
      { run: 'eval/runs/r1', caseId: 'alpha', source: 'eval/runs/r1/lane-a/alpha/events.jsonl', reference: 'alpha', score: 0.9012, floor: 0.8 },
      { run: 'eval/runs/r1', caseId: 'gamma', source: 'eval/runs/r1/gamma/events.jsonl', reference: 'gamma', score: null, floor: 0.8 },
    ]);
    assert.deepEqual(fidelityKinds(r), { reference: 1, openapi: 0, unchecked: 1, none: 1 });
    assert.deepEqual(fidelityRows(run([evidence('gamma')]), ['gamma']), []);
  });

  it('a grader task counts flipped checks and probed slots off its verdict, and the card names the highest decoy and a refused world', () => {
    const t = graderTaskOf({
      taskId: 'refund', decoys: [{ why: 'refunds all', score: 0.57 }, { why: 'nothing', score: 0 }], solutionWrites: 2,
      checks: [{ check: 'refunded', flippedBy: ['prefix 1'] }, { check: 'others untouched', flippedBy: [] }],
      collateral: [{ kind: 'extra_delete', call: 'DELETE /orders/1', score: 0 }, { kind: 'target_field', call: null, score: null }],
    }, 1);
    assert.deepEqual(t, { task: 'refund', decoys: [0.57, 0], alternatives: 1, solutionWrites: 2, checks: 2, flipped: 1, slots: 2, probed: 1 });
    assert.deepEqual(graderTotals([t, { ...t, task: 'ship', solutionWrites: 1, alternatives: 0 }]), { tasks: 2, decoys: 4, alternatives: 1, oneWrite: 1, checks: 4, flipped: 2, slots: 4, probed: 2 });
    const md = renderScorecards({ ...none, worlds: [
      { world: 'shop', source: 'prod/worlds/shop/world.yaml', tasks: [t] },
      { world: 'broken', source: 'prod/worlds/broken/world.yaml', refused: 'task.decoy_full_marks at tasks.refund.decoys.0' },
    ] });
    assert.ok(md.includes('The highest decoy score, cut to 4 decimals, is 0.57, on refund in `prod/worlds/shop/world.yaml`.'));
    assert.ok(md.includes('| shop | 1 | 2 | 1 | 0 | 1/2 (50.0%) | 1/2 (50.0%) | `prod/worlds/shop/world.yaml` |'));
    assert.ok(md.includes('- `prod/worlds/broken/world.yaml` fails check, so its tasks are not counted: task.decoy_full_marks at tasks.refund.decoys.0'));
  });

  it('reads a difficulty.json, and names why a file is not one', () => {
    const p = parseDifficulty(JSON.stringify({
      runId: 'p', models: ['claude-sonnet-5-5'], episodesPerCell: 3, budgetUsd: 5, spentUsd: 1.25, stop: { kind: 'complete' }, episodes: [{}, {}, {}],
      cells: [{ world: 'helpdesk', task: 't', labeled: 'hard', model: 'claude-sonnet-5-5', episodes: 3, trials: 3, passes: 1, passRate: 0.333, interval: [0.061, 0.792], measured: 'medium' }],
    }));
    assert.ok(p.ok);
    assert.deepEqual([p.run.runId, p.run.cells[0]!.passes, p.run.cells[0]!.measured, p.run.cells[0]!.interval], ['p', 1, 'medium', [0.061, 0.792]]);
    assert.deepEqual(parseDifficulty('{'), { ok: false, error: 'not JSON' });
    assert.deepEqual(parseDifficulty('{"runId":1}').ok, false);
    const md = renderScorecards({ ...none, difficulty: [{ source: 'eval/difficulty/p/difficulty.json', text: JSON.stringify(p.run) }] });
    assert.ok(md.includes('| helpdesk | t | claude-sonnet-5-5 | hard | medium | no | 1 / 3 | 33.3% | 0.061 to 0.792 |'));
    assert.ok(md.includes('The labeled tier agrees with the measured one in 0 of 1 measured cells.'));
  });

  it('counts a schema-1 export by success and the rest, a schema-2 export by verdict, and names an unreadable or successes-only one', async () => {
    const source = 'eval/dataset/2026-10-07/helpdesk/manifest.json';
    const v1 = parseManifest(JSON.parse(await readFile(path.join(REPO, source), 'utf8')), source);
    assert.deepEqual(exportCounts(v1), { episodes: 6, success: 6, partial: null, failure: null, infra: null, notSuccess: 0 });
    const v2 = parseManifest({
      manifest_version: 2, schema_version: 2, provider: v1.provider, model: v1.model, prompt_versions: v1.prompt_versions, config_versions: v1.config_versions,
      engine_commits: v1.engine_commits, run_ids: v1.run_ids, worlds: v1.worlds, grading_note: v1.grading_note,
      selection: { run_ids: [], task_ids: [], episode_ids: [], successes_only: true },
      counts: { episodes: 5, by_verdict: { success: 1, partial: 1, failure: 2, infra: 1 }, by_stop_reason: { done: 4, model_error: 1 }, by_failure_cause: { 'scored 0': 2, 'scored 0.5': 1, model_error: 1 } },
      files: { dataset: v1.files.dataset },
    }, 'v2');
    assert.deepEqual(exportCounts(v2), { episodes: 5, success: 1, partial: 1, failure: 2, infra: 1, notSuccess: 4 });

    const exports: ExportInput[] = [{ source, manifest: v1 }, { source: 'eval/dataset/x/w/manifest.json', manifest: v2 }, { source: 'eval/dataset/x/bad/manifest.json', error: 'not JSON' }];
    const md = renderScorecards({ ...none, exports });
    assert.ok(md.includes('| **Total** |  |  | 11 | 7 |  |  |  | 4 |'));
    assert.ok(md.includes('| `eval/dataset/x/bad/manifest.json` | - | - | - | - | - | - | - | unreadable: not JSON |'));
    assert.ok(md.includes('1 schema-2 export folder holds 5 episodes: 1 success, 1 partial, 2 failure, 1 infra.'));
    assert.ok(md.includes('`eval/dataset/x/w/manifest.json` was exported with successes only'));
    assert.ok(md.includes('No difficulty run is committed.'));
  });
});
