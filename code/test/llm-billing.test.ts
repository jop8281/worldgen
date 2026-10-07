import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { configSchema } from '../src/worldgen/config.ts';
import { anthropicModel, claudeCliModel, CallStalled, StepShareExpired, ModelError, type ProposeRequest } from '../src/worldgen/llm.ts';

const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1 });
const req: ProposeRequest = { system: 'synthetic', prompt: 'synthetic', tool: { name: 'submit', description: 'synthetic', inputSchema: { type: 'object' } } };

describe('model failure billing outcomes', () => {
  it('passes the tighter remaining/configured estimate budget to the CLI', async () => {
    for (const [remaining, expected] of [[undefined, '1'], [0.25, '0.25'], [9, '1']] as const) {
      let seen: readonly string[] = [];
      const cli = claudeCliModel(config, async (_bin, args) => {
        seen = args;
        return { code: 0, signal: null, killed: null, stderr: '', stdout: JSON.stringify({ type: 'result', structured_output: { ok: true }, total_cost_usd: 0.01 }) };
      });
      await cli.propose({ ...req, ...(remaining === undefined ? {} : { maxCostUsd: remaining }) });
      assert.equal(seen[seen.indexOf('--max-budget-usd') + 1], expected);
    }
  });

  it('refuses invalid or exhausted estimate budgets before spawning the CLI', async () => {
    let calls = 0;
    const cli = claudeCliModel(config, async () => { calls += 1; throw new Error('unexpected spawn'); });
    for (const maxCostUsd of [0, -1, NaN, Infinity]) await assert.rejects(cli.propose({ ...req, maxCostUsd }), e => e instanceof ModelError && e.billing.kind === 'not_started');
    assert.equal(calls, 0);
  });

  it('distinguishes configured SDK pricing from CLI-reported cost and CLI fallback pricing', async () => {
    const sdk = anthropicModel(config, { apiKey: 'sk-synthetic-only', client: { messages: { countTokens: async () => ({ input_tokens: 1 }), async create() {
      return { content: [{ type: 'tool_use', name: 'submit', input: { ok: true } }], usage: { input_tokens: 1, output_tokens: 2 } };
    } } } });
    assert.equal((await sdk.propose(req)).costBasis, 'sdk_configured_rates');
    const reply = { structured_output: { ok: true }, usage: { input_tokens: 1, output_tokens: 2 } };
    const reported = claudeCliModel(config, async () => ({ code: 0, signal: null, killed: null, stderr: '', stdout: JSON.stringify({ type: 'result', ...reply, total_cost_usd: 0.01 }) }));
    assert.equal((await reported.propose(req)).costBasis, 'cli_reported_cost');
    const fallback = claudeCliModel(config, async () => ({ code: 0, signal: null, killed: null, stderr: '', stdout: JSON.stringify({ type: 'result', ...reply }) }));
    assert.equal((await fallback.propose(req)).costBasis, 'cli_configured_rates');
  });

  it('retains the price basis on unusable but priced SDK replies', async () => {
    const sdk = anthropicModel(config, { apiKey: 'sk-synthetic-only', client: { messages: { countTokens: async () => ({ input_tokens: 1 }), async create() {
      return { content: [], usage: { input_tokens: 1, output_tokens: 2 } };
    } } } });
    await assert.rejects(sdk.propose(req), e => e instanceof ModelError && e.costBasis === 'sdk_configured_rates' && e.costUsd !== undefined);
  });

  it('does not start either transport for a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const sdk = anthropicModel(config, { apiKey: 'sk-synthetic-only', fetch: async () => { calls += 1; throw new Error('unexpected HTTP'); } });
    const cli = claudeCliModel(config, async () => { calls += 1; throw new Error('unexpected spawn'); });
    for (const model of [sdk, cli]) await assert.rejects(model.propose({ ...req, signal: controller.signal }), e => e instanceof ModelError && e.billing.kind === 'not_started');
    assert.equal(calls, 0);
  });

  it('classifies an OS-confirmed missing CLI binary as not started', async () => {
    const model = claudeCliModel({ ...config, claudeBin: join(tmpdir(), 'worldgen-nonexistent-binary-4fe7a891') });
    await assert.rejects(model.propose(req), e => e instanceof ModelError && e.billing.kind === 'not_started');
  });

  it('retains unknown billing after a started SDK request is aborted', { timeout: 10_000 }, async () => {
    const controller = new AbortController();
    let announce: (() => void) | undefined;
    const started = new Promise<void>(resolve => { announce = resolve; });
    let calls = 0;
    const model = anthropicModel(config, { apiKey: 'sk-synthetic-only', fetch: async (_url, init) => {
      if (String(_url).includes('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 1 }), { headers: { 'content-type': 'application/json' } });
      calls += 1;
      assert.ok(announce);
      announce();
      assert.ok(init?.signal);
      const signal = init.signal;
      return new Promise<Response>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')), { once: true }); });
    } });
    const rejected = assert.rejects(model.propose({ ...req, signal: controller.signal }), e => e instanceof ModelError && e.billing.kind === 'unknown' && e.costUsd === undefined);
    await started;
    controller.abort();
    await rejected;
    assert.equal(calls, 1);
  });

  it('retains unknown billing when a started CLI is stopped for silence or step share', async () => {
    for (const killed of ['stall', 'share'] as const) {
      const model = claudeCliModel(config, async () => ({ code: null, signal: 'SIGTERM', killed, stdout: '', stderr: '' }));
      await assert.rejects(model.propose(req), e => (e instanceof CallStalled || e instanceof StepShareExpired) && e.billing.kind === 'unknown');
    }
  });

  it('retains unknown billing when an executed CLI exits without a bill', async () => {
    const model = claudeCliModel(config, async () => ({ code: null, signal: 'SIGTERM', killed: null, stdout: '', stderr: '' }));
    await assert.rejects(model.propose(req), e => e instanceof ModelError && e.billing.kind === 'unknown' && e.costUsd === undefined);
  });

  it('does not invent zero billing from missing or invalid CLI usage', async () => {
    for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: 0 }]) {
      const model = claudeCliModel(config, async () => ({ code: 0, signal: null, killed: null, stderr: '', stdout: JSON.stringify({ type: 'result', structured_output: { ok: true }, usage }) }));
      await assert.rejects(model.propose(req), e => e instanceof ModelError && e.billing.kind === 'unknown' && e.costUsd === undefined);
    }
  });
});
