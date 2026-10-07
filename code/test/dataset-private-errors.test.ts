import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { StateDump } from '#engine';
import { runEpisode, type EpisodeInput, type WorldPort } from '../src/dataset/episode.ts';
import { hashState, redactor, sha256Hex } from '../src/dataset/schema.ts';
import { appendEpisode, exportDataset, worldArtifactPath, writeArtifacts } from '../src/dataset/store.ts';

const hidden = 'PRIVATE_EVALUATION_RULE_SENTINEL';
const secret = 'controller-key-for-privacy-test';
const frozen = 'private world fixture';
const state: StateDump = { world: 'toy', hash: 'f'.repeat(64), now: '2026-10-06T00:00:00.000Z', tables: {}, counters: {} };
const fail = async (): Promise<never> => { throw new Error(`${hidden}: ${secret}`); };

describe('private controller errors in dataset exports', () => {
  for (const boundary of ['reset', 'initial state', 'final state', 'grade', 'log'] as const) {
    it(`keeps ${boundary} errors in private evidence and out of saved public JSONL`, async () => {
      let reads = 0;
      const port: WorldPort = {
        reset: boundary === 'reset' ? fail : async () => undefined,
        state: async () => {
          reads += 1;
          if ((boundary === 'initial state' && reads === 1) || (boundary === 'final state' && reads === 2)) return fail();
          return state;
        },
        call: async () => ({ status: 200, text: '{}' }),
        log: boundary === 'log' ? fail : async () => [],
      };
      const redact = redactor([secret]);
      const input: EpisodeInput = {
        runId: 'privacy-test', engineCommit: 'a'.repeat(40), worldId: 'toy', worldVersion: sha256Hex(frozen),
        promptVersion: 'solver-prompt-1', configVersion: 'test-config-1',
        task: { id: 'visible_task', difficulty: 'easy', instruction: 'Complete the visible task using the public API.' },
        index: 1, openapi: { openapi: '3.1.0', info: { title: 'toy', version: '1', description: '' }, paths: {}, tags: [], components: { schemas: {} }, 'x-error-codes': {} },
        seedHash: hashState(state), port,
        grade: boundary === 'grade' ? fail : async () => ({ ok: true as const, score: 0 }),
        nextTurn: async () => ({ decision: { action: 'finish', final_reply: 'Unable to complete this task.' }, commentary: '',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.000012, ms: 1 }),
        maxTurns: 2, budgetLeftUsd: 0.1, deadline: Date.now() + 30_000, now: Date.now, redact,
      };
      const result = await runEpisode(input);
      assert.equal(result.episode.stop_reason, boundary === 'reset' || boundary === 'initial state' ? 'world_error' : 'grade_error');
      assert.equal(result.episode.score, null);
      assert.equal(JSON.stringify(result.episode).includes(hidden), false, 'private details entered the public record');
      assert.equal(JSON.stringify(result.artifacts).includes(hidden), true, 'private diagnostic detail was discarded');
      assert.equal(JSON.stringify(result.artifacts).includes(secret), false, 'controller key entered private diagnostics');

      const out = await mkdtemp(path.join(os.tmpdir(), 'dataset-privacy-'));
      try {
        const artifact = path.join(out, worldArtifactPath(input.worldVersion));
        await mkdir(path.dirname(artifact), { recursive: true });
        await writeFile(artifact, frozen);
        await writeArtifacts(out, result.episode.episode_id, result.artifacts, redact);
        await appendEpisode(out, result.episode, redact);
        const exported = await exportDataset({ out, redact });
        assert.deepEqual(exported.manifest.counts, { episodes: 1, accepted: 0, failed: 1, by_stop_reason: { [result.episode.stop_reason]: 1 } });
        for (const name of ['dataset.jsonl', 'failures.jsonl', 'manifest.json', 'logs/privacy-test.episodes.jsonl']) {
          const text = await readFile(path.join(out, name), 'utf8');
          assert.equal(text.includes(hidden), false, `${name} leaked private evaluation details`);
          assert.equal(text.includes(secret), false, `${name} leaked the controller key`);
        }
        const detail = await readFile(path.join(out, 'private', 'episodes', result.episode.episode_id, 'errors.json'), 'utf8');
        assert.equal(detail.includes(hidden), true);
        assert.equal(detail.includes(secret), false);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    });
  }
});
