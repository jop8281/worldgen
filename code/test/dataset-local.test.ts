/**
 * `runLocalEpisode` with an agent that calls the world (YOS-190). The scripted agent replays the four
 * requests the first live Sonnet episode made, so the export it reopens holds tool calls and results.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { NextTurn } from '../src/dataset/episode.ts';
import { finishAtOnce, runLocalEpisode, type LocalEpisodeResult } from '../src/dataset/local.ts';
import { redactor } from '../src/dataset/schema.ts';
import { nodeRunner, nodeSpawn, type Runner, type Spawner } from '../src/sandboxes/backend.ts';

const HELPDESK = path.resolve(import.meta.dirname, '../../prod/worlds/helpdesk');

const DECISIONS: readonly unknown[] = [
  { action: 'request', method: 'GET', path: '/agents', query: { q: 'Priya' } },
  { action: 'request', method: 'GET', path: '/customers', query: { q: 'Acme' } },
  { action: 'request', method: 'GET', path: '/tickets', query: { customer_id: 'cus_0001', sort: '-created_at' } },
  { action: 'request', method: 'POST', path: '/tickets/tkt_0004/assign', body: { agent_id: 'agt_0001' }, query: {} },
  { action: 'finish', final_reply: 'Assigned tkt_0004 to Priya Raman.' },
];

const replay: NextTurn = async (view) => ({
  decision: DECISIONS[view.turn - 1] ?? { action: 'finish', final_reply: 'Out of script.' },
  commentary: '',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  costUsd: 0,
  ms: 0,
});

describe('runLocalEpisode: an agent that calls the world', () => {
  let out: string;
  let result: LocalEpisodeResult;
  before(async () => {
    out = await mkdtemp(path.join(tmpdir(), 'wg-local-'));
    result = await runLocalEpisode({
      worldDir: HELPDESK, taskId: 'assign_newest_acme_ticket', out, runId: 'replay', engineCommit: 'abcdef1', model: 'claude-sonnet-5-5',
      nextTurn: replay, maxTurns: 12, budgetUsd: 0.01, maxMinutes: 2, redact: redactor([]),
    });
  });
  after(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('reopens its export with tool calls and results, and the engine scores the solved task 1', () => {
    const e = result.episode;
    assert.deepEqual([e.stop_reason, e.score, e.final_reply], ['done', 1, 'Assigned tkt_0004 to Priya Raman.']);
    assert.deepEqual(e.messages.map((m) => `${m.role} ${m.type}`), [
      'user instruction',
      'assistant tool_call', 'tool tool_result',
      'assistant tool_call', 'tool tool_result',
      'assistant tool_call', 'tool tool_result',
      'assistant tool_call', 'tool tool_result',
      'assistant final_reply',
    ]);
  });
});

describe('runLocalEpisode: the noop agent', () => {
  it('records model null, because it called no model, and the engine scores its untouched end state 0', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'wg-local-noop-'));
    try {
      const { episode: e } = await runLocalEpisode({
        worldDir: HELPDESK, taskId: 'assign_newest_acme_ticket', out, runId: 'noop', engineCommit: 'abcdef1', model: null,
        nextTurn: finishAtOnce, maxTurns: 3, budgetUsd: 0.01, maxMinutes: 2, redact: redactor([]),
      });
      assert.deepEqual([e.model, e.usage.model_calls, e.usage.cost_usd, e.stop_reason, e.score], [null, 0, 0, 'done', 0]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('runLocalEpisode: the world runs in children with an allowlisted environment', () => {
  it('prepares, serves and grades in children that hold only TZ and PATH', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'wg-local-env-'));
    const runs: { argv: readonly string[]; env: unknown }[] = [];
    const spawns: { argv: readonly string[]; env: unknown }[] = [];
    const runner: Runner = (argv, opts) => {
      runs.push({ argv, env: opts?.env });
      return nodeRunner(argv, opts);
    };
    const spawner: Spawner = (argv, opts) => {
      spawns.push({ argv, env: opts?.env });
      return nodeSpawn(argv, opts);
    };
    const allow = { TZ: 'UTC', PATH: process.env.PATH ?? '' };
    try {
      const { episode: e } = await runLocalEpisode({
        worldDir: HELPDESK, taskId: 'assign_newest_acme_ticket', out, runId: 'iso', engineCommit: 'abcdef1', model: null,
        nextTurn: finishAtOnce, maxTurns: 3, budgetUsd: 0.01, maxMinutes: 2, redact: redactor([]), runner, spawner,
        env: { PATH: process.env.PATH ?? '', HOME: '/home/op', LLM_KEY: 'sk-live-1', BOAT_API_KEY: 'boat-3', WORLDGEN_STUDIO_TOKEN: 'tok-4' },
      });
      assert.deepEqual([e.stop_reason, e.score], ['done', 0]);
      const prepare = runs.find((r) => r.argv.includes('src/cli/episode-prepare.ts'));
      const serve = spawns.find((r) => r.argv.includes('src/cli/worldplay.ts') && r.argv.includes('serve'));
      const verify = runs.find((r) => r.argv.includes('src/cli/verifier.ts'));
      assert.deepEqual(prepare?.env, allow);
      assert.deepEqual(serve?.env, allow);
      assert.equal(verify?.argv[0], 'bun');
      assert.deepEqual(verify?.env, allow);
      for (const r of [...runs, ...spawns]) {
        const env = r.env as Record<string, string> | undefined;
        assert.equal(env?.['LLM_KEY'], undefined);
        assert.equal(env?.['BOAT_API_KEY'], undefined);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
