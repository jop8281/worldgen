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
import { runLocalEpisode, type LocalEpisodeResult } from '../src/dataset/local.ts';
import { redactor } from '../src/dataset/schema.ts';

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
