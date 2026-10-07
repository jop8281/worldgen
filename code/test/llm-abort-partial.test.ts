import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../src/costs/ledger.ts';
import { meteredModel } from '../src/costs/meter.ts';
import { configSchema } from '../src/worldgen/config.ts';
import { claudeCliModel, ModelError } from '../src/worldgen/llm.ts';

it('an aborted partial CLI stream keeps observed usage with unknown final billing', async () => {
  const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1 });
  const stdout = [
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } },
  ].map((event) => JSON.stringify(event)).join('\n');
  const model = claudeCliModel(config, async () => ({ code: 143, signal: 'SIGTERM', killed: 'aborted', stdout, stderr: '' }));
  let caught: unknown;
  try { await model.propose({ system: 'Offline', prompt: 'Synthetic', tool: { name: 'submit', description: 'Synthetic', inputSchema: {} } }); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof ModelError);
  assert.equal(caught.billing.kind, 'unknown');
  assert.equal(caught.costUsd, undefined);
  assert.deepEqual(caught.partialModelUsage, {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0,
    observedCostUsd: 0.0004, costBasis: 'cli_configured_rates',
  });
});

it('aborted one-hour cache usage survives the adapter and ledger, and the claim closes at its admitted bound (A-164)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-cache-finality-'));
  try {
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1 });
    const stdout = [
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 40 } } } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } },
    ].map((frame) => JSON.stringify(frame)).join('\n');
    const raw = claudeCliModel(config, async () => ({ code: 143, signal: 'SIGTERM', killed: 'aborted', stdout, stderr: '' }));
    const ledger = openLedger(join(dir, 'costs.jsonl'));
    const model = meteredModel(raw, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
    await assert.rejects(model.propose({ system: 'Offline', prompt: 'Synthetic', tool: { name: 'submit', description: 'Synthetic', inputSchema: {} } }));
    assert.deepEqual(ledger.read().events[0]?.partialModelUsage, {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 100, cacheWrite1hTokens: 40,
      observedCostUsd: 0.00071, costBasis: 'cli_configured_rates',
    });
    assert.equal(ledger.read().events[0]?.usd, null);
    assert.equal(ledger.read().reservations.length, 0);
    assert.equal(ledger.read().events[0]?.exposureUsd, 1);
    assert.equal(ledger.totals().usd, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
