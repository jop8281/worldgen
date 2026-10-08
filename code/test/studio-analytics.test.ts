import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { finishAtOnce, runLocalEpisode } from '../src/dataset/local.ts';
import { isCompleteSuccess, redactor, type Episode } from '../src/dataset/schema.ts';
import { NO_MODEL, summarizeEpisodes } from '../src/studio/analytics.ts';

const HELPDESK = path.resolve(import.meta.dirname, '../../prod/worlds/helpdesk');

describe('summarizeEpisodes: agent-episode analytics (YOS-190)', () => {
  let out: string;
  const real: Episode[] = [];
  before(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'wg-analytics-'));
    for (const runId of ['noop-a', 'noop-b']) {
      const r = await runLocalEpisode({
        worldDir: HELPDESK, taskId: 'assign_newest_acme_ticket', out, runId, engineCommit: 'abcdef1', model: null,
        nextTurn: finishAtOnce, maxTurns: 3, budgetUsd: 0.01, maxMinutes: 2, redact: redactor([]),
      });
      real.push(r.episode);
    }
  });
  after(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('counts two engine-graded noop runs as failures scored 0, with no cost per success', () => {
    assert.deepEqual(summarizeEpisodes(real).map((g) => [g.world, g.task, g.model, g.runs, g.successes, g.successRate, g.costUsd, g.costPerSuccessUsd, g.failures]), [
      ['helpdesk', 'assign_newest_acme_ticket', 'noop (no model)', 2, 0, 0, 0, null, { 'scored 0': 2 }],
    ]);
    assert.deepEqual(summarizeEpisodes(real)[0]?.engineCommits, ['abcdef1']);
    assert.equal(summarizeEpisodes(real)[0]?.meanTurns, 1);
  });

  it('computes success rate and cost per success once a group holds a complete success', () => {
    // An edited copy stands in for a paid run here, so only the arithmetic is tested, never a mocked UI success.
    const success: Episode = { ...real[0]!, episode_id: 'paid__assign_newest_acme_ticket__1', run_id: 'paid', model: 'claude-sonnet-5-5', score: 1, usage: { ...real[0]!.usage, cost_usd: 0.02, model_calls: 1 } };
    const missed: Episode = { ...success, episode_id: 'paid__assign_newest_acme_ticket__2', score: 0 };
    assert.equal(isCompleteSuccess(success), true);
    const sonnet = summarizeEpisodes([...real, success, missed]).find((x) => x.model === 'claude-sonnet-5-5');
    assert.deepEqual([sonnet?.runs, sonnet?.successes, sonnet?.successRate, sonnet?.costUsd, sonnet?.costPerSuccessUsd, sonnet?.failures], [2, 1, 0.5, 0.04, 0.04, { 'scored 0': 1 }]);
  });

  it('keeps free noop runs out of a Sonnet group, so they never count as Sonnet failures', () => {
    const paid: Episode = { ...real[0]!, episode_id: 'paid__assign_newest_acme_ticket__1', run_id: 'paid', model: 'claude-sonnet-5-5', score: 1, usage: { ...real[0]!.usage, cost_usd: 0.02, model_calls: 1 } };
    assert.deepEqual(summarizeEpisodes([...real, paid]).map((g) => [g.model, g.runs, g.successes, g.successRate]), [
      ['claude-sonnet-5-5', 1, 1, 1],
      [NO_MODEL, 2, 0, 0],
    ]);
  });

  it('names a run that stopped early by its stop reason', () => {
    const limited: Episode = { ...real[0]!, episode_id: 'cut__assign_newest_acme_ticket__1', run_id: 'cut', stop_reason: 'turn_limit', score: null };
    assert.deepEqual(summarizeEpisodes([limited])[0]?.failures, { turn_limit: 1 });
  });
});
