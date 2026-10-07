import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configSchema } from '../src/worldgen/config.ts';
import { anthropicModel, ModelError, type MessagesClient, type ProposeRequest } from '../src/worldgen/llm.ts';
const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1 });
const req: ProposeRequest = { system: 'synthetic system', prompt: 'synthetic prompt', tool: { name: 'submit', description: 'synthetic description', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } } };
const reply = { content: [{ type: 'tool_use', name: 'submit', input: { ok: true } }], usage: { input_tokens: 1000, output_tokens: 1 } };
describe('SDK estimate budget admission', () => {
  it('counts the full input and bounds output before paid creation', async () => {
    let quoted: Record<string, unknown> | undefined;
    let created: Record<string, unknown> | undefined;
    const client: MessagesClient = { messages: {
      async countTokens(params) { quoted = params; return { input_tokens: 1000 }; },
      async create(params) { created = params; return reply; },
    } };
    await anthropicModel(config, { apiKey: 'sk-synthetic-only', client }).propose({ ...req, maxCostUsd: 0.003, effort: 'high' });
    assert.equal(created?.max_tokens, 100);
    assert.deepEqual(quoted?.tools, [{ name: 'submit', description: 'synthetic description', input_schema: req.tool.inputSchema }]);
    assert.deepEqual(quoted?.messages, [{ role: 'user', content: req.prompt }]);
    assert.equal(quoted?.system, `${req.system}\n\nRespond by calling the tool "submit" exactly once with your answer as its input.`);
    assert.equal(quoted?.model, 'claude-sonnet-5-5');
    assert.equal('max_tokens' in (quoted ?? {}), false);
    assert.equal('output_config' in (quoted ?? {}), false);
    assert.deepEqual(created?.output_config, { effort: 'high' });
  });
  it('refuses invalid counts or inputs that leave no output allowance without creating a message', async () => {
    let creates = 0;
    for (const input_tokens of [-1, 1.5, NaN, Infinity, 2000]) {
      const client: MessagesClient = { messages: { async countTokens() { return { input_tokens }; }, async create() { creates += 1; return reply; } } };
      await assert.rejects(anthropicModel(config, { apiKey: 'sk-synthetic-only', client }).propose({ ...req, maxCostUsd: 0.003 }), e => e instanceof ModelError && e.billing.kind === 'not_started');
    }
    assert.equal(creates, 0);
  });
  it('refuses missing or failed quote support as unpaid and scrubs the configured key', async () => {
    let creates = 0;
    for (const messages of [
      { async create() { creates += 1; return reply; } },
      { async countTokens() { throw new Error('synthetic sk-synthetic-only quote failure'); }, async create() { creates += 1; return reply; } },
    ]) await assert.rejects(anthropicModel(config, { apiKey: 'sk-synthetic-only', client: { messages } }).propose(req), e => e instanceof ModelError && e.billing.kind === 'not_started' && !e.message.includes('sk-synthetic-only'));
    assert.equal(creates, 0);
  });
  it('cancels a pending free quote at the request deadline without paid creation', { timeout: 2000 }, async () => {
    let creates = 0;
    const client: MessagesClient = { messages: {
      countTokens(_params, options) { assert.ok(options?.signal); const signal = options.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
      async create() { creates += 1; return reply; },
    } };
    await assert.rejects(anthropicModel(config, { apiKey: 'sk-synthetic-only', client }).propose({ ...req, timeoutMs: 20 }), e => e instanceof ModelError && e.billing.kind === 'not_started');
    assert.equal(creates, 0);
  });
  it('does not retry a started paid request after HTTP 500', async () => {
    const calls: string[] = [];
    const model = anthropicModel(config, { apiKey: 'sk-synthetic-only', fetch: async url => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return path.endsWith('/count_tokens') ? Response.json({ input_tokens: 1000 }) : Response.json({ type: 'error', error: { type: 'api_error', message: 'synthetic provider error' } }, { status: 500 });
    } });
    await assert.rejects(model.propose(req), e => e instanceof ModelError && e.billing.kind === 'unknown');
    assert.deepEqual(calls, ['/v1/messages/count_tokens', '/v1/messages']);
  });
});
