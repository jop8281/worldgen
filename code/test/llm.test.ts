import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { BUILTIN_PRICES, configSchema, isPriced, loadConfig } from '../src/worldgen/config.ts';
import { dirname, join, resolve } from 'node:path';
import {
  anthropicModel, CallStalled, claudeArgs, claudeCliModel, costOf, MAX_ARG_BYTES, ModelError, spawnClaude,
  StepShareExpired, streamProgress, type MessagesClient, type ProposeRequest, type SpawnClaude, type SpawnResult,
} from '../src/worldgen/llm.ts';

const PRICES = { 'claude-sonnet-5-5': { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 } };
const FAKE_KEY = 'sk-fake-key-123456';
const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, prices: PRICES, maxOutputTokens: 4000 });
const req: ProposeRequest = {
  system: 'sys',
  prompt: 'make a world',
  tool: { name: 'submit_plan', description: 'submit', inputSchema: { type: 'object' } },
};
/** Deterministic clock: each call advances 250 ms. */
const ticker = () => { let t = 0; return () => (t += 250); };
const u = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0, cacheWrite1hTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens });

function fakeClient(reply: () => unknown, seen: Record<string, unknown>[] = []): MessagesClient {
  return {
    messages: { countTokens: async () => ({ input_tokens: 1 }),
      async create(params) {
        seen.push(params);
        return reply() as never;
      },
    },
  };
}
const ok = (content: unknown[], stop_reason = 'tool_use') => () => ({
  content,
  stop_reason,
  usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000 },
});

describe('costOf', () => {
  it('prices input and output tokens per million', () => {
    assert.equal(costOf(u(1_000_000, 0), 'claude-sonnet-5-5', PRICES), 15);
    assert.equal(costOf(u(0, 2_000_000), 'claude-sonnet-5-5', PRICES), 150);
    assert.equal(costOf(u(1000, 200), 'claude-sonnet-5-5', PRICES), 0.03);
  });
  it('defaults cache write to 1.25x input and cache read to 0.1x input', () => {
    assert.equal(costOf(u(0, 0, 0, 1_000_000), 'claude-sonnet-5-5', PRICES), 18.75);
    assert.equal(costOf(u(0, 0, 1_000_000, 0), 'claude-sonnet-5-5', PRICES), 1.5);
  });
  it('uses explicit cache prices when given', () => {
    const prices = { m: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 4, cacheReadPerMTok: 0.25 } };
    assert.equal(costOf(u(1_000_000, 1_000_000, 2_000_000, 1_000_000), 'm', prices), 3 + 15 + 0.5 + 4);
  });
  it('prices the 1-hour part of the cache writes at 2x input by default, and the rest at the 5-minute rate', () => {
    // 600k * 18.75 + 400k * 30
    assert.equal(costOf(u(0, 0, 0, 1_000_000, 400_000), 'claude-sonnet-5-5', PRICES), 23.25);
    const prices = { m: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 4, cacheWrite1hPerMTok: 5 } };
    // 250k * 4 + 750k * 5
    assert.equal(costOf(u(0, 0, 0, 1_000_000, 750_000), 'm', prices), 4.75);
  });
  it('matches what the claude CLI charged for the live lib1 and lib2 plan calls at the pinned prices', () => {
    // lib1 wrote all 18971 cache tokens to the 1-hour cache; its result line says total_cost_usd 0.4830332. lib2 wrote none: 0.5000982.
    assert.equal(costOf({ inputTokens: 4, outputTokens: 38980, cacheReadTokens: 86706, cacheWriteTokens: 18971, cacheWrite1hTokens: 18971 }, 'claude-sonnet-5-5', BUILTIN_PRICES), 0.4830332);
    assert.equal(costOf({ inputTokens: 2, outputTokens: 49136, cacheReadTokens: 43671, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }, 'claude-sonnet-5-5', BUILTIN_PRICES), 0.5000982);
  });
  it('prices Claude Haiku 5.5 at its over-100K tier, so a call is never under-counted (A-403)', () => {
    assert.deepEqual(BUILTIN_PRICES['claude-haiku-5-5'], { inputPerMTok: 0.5, outputPerMTok: 2.5, cacheWritePerMTok: 0.625, cacheWrite1hPerMTok: 1, cacheReadPerMTok: 0.05 });
    // 1000 * 0.5 + 2000 * 2.5 + 10000 * 0.625 + 20000 * 1 + 100000 * 0.05, per million
    assert.equal(costOf({ inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 100_000, cacheWriteTokens: 30_000, cacheWrite1hTokens: 20_000 }, 'claude-haiku-5-5', BUILTIN_PRICES), 0.03675);
    assert.equal(isPriced('claude-haiku-5-5', {}), true);
    assert.deepEqual(['claude-haiku-5-5', 'claude-haiku-4-5'].map((model) => configSchema.safeParse({ model, maxCostUsd: 1 }).success), [true, false]);
  });
  it('returns 0 for zero usage', () => {
    assert.equal(costOf(u(0, 0), 'claude-sonnet-5-5', PRICES), 0);
  });
  it('throws a model_error for an unpriced model', () => {
    assert.throws(
      () => costOf(u(1, 1), 'mystery', PRICES),
      (e: unknown) => e instanceof ModelError && e.kind === 'model_error' && e.message.includes('mystery'),
    );
  });
});

describe('anthropicModel', () => {
  it('passes the request timeoutMs to the SDK as the request timeout, else maxMinutes', async () => {
    const options: ({ readonly timeout?: number; readonly signal?: AbortSignal } | undefined)[] = [];
    const reply = ok([{ type: 'tool_use', id: 't1', name: 'submit_plan', input: {} }]);
    const client: MessagesClient = { messages: { countTokens: async () => ({ input_tokens: 1 }), create: async (_params, opts) => { options.push(opts); return reply() as never; } } };
    await anthropicModel(config, { apiKey: FAKE_KEY, client }).propose({ ...req, timeoutMs: 42_000 });
    await anthropicModel(config, { apiKey: FAKE_KEY, client }).propose(req);
    assert.deepEqual(options.map(o => o?.timeout), [42_000, 900_000]);
    assert.ok(options.every(o => o?.signal instanceof AbortSignal));
  });

  it('sends auto tool_choice and returns input, usage, cost and ms', async () => {
    const seen: Record<string, unknown>[] = [];
    let t = 1000;
    const now = () => (t += 250);
    const client = fakeClient(ok([{ type: 'tool_use', id: 't1', name: 'submit_plan', input: { a: 1 } }]), seen);
    const p = await anthropicModel(config, { apiKey: FAKE_KEY, client, now }).propose(req);
    assert.deepEqual(p.input, { a: 1 });
    assert.deepEqual(p.advice, []);
    assert.deepEqual(p.usage, u(1000, 200, 5000, 400));
    // 1000*15 + 200*75 + 400*18.75 + 5000*1.5 = 15000+15000+7500+7500 = 45000 per million
    assert.equal(p.costUsd, 0.045);
    assert.equal(p.ms, 250);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.['tool_choice'], { type: 'auto', disable_parallel_tool_use: true });
    assert.match(String(seen[0]?.['system']), /calling the tool "submit_plan"/);
    assert.equal(seen[0]?.['model'], 'claude-sonnet-5-5');
    assert.equal(seen[0]?.['max_tokens'], 4000);
    assert.deepEqual(seen[0]?.['tools'], [{ name: 'submit_plan', description: 'submit', input_schema: { type: 'object' } }]);
  });

  it('returns text blocks as advice and never parses them', async () => {
    const client = fakeClient(ok([
      { type: 'text', text: '{"input": "decoy"}' },
      { type: 'tool_use', name: 'submit_plan', input: { real: true } },
      { type: 'text', text: 'consider more tasks' },
    ]));
    const p = await anthropicModel(config, { apiKey: FAKE_KEY, client }).propose(req);
    assert.deepEqual(p.input, { real: true });
    assert.deepEqual(p.advice, ['{"input": "decoy"}', 'consider more tasks']);
  });

  it('raises model_error when the response has no tool call', async () => {
    const client = fakeClient(ok([{ type: 'text', text: 'I refuse' }], 'end_turn'));
    await assert.rejects(
      anthropicModel(config, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req),
      (e: unknown) => e instanceof ModelError && e.kind === 'model_error' && e.message === 'model did not call tool "submit_plan" (stop_reason: end_turn)' &&
        e.status === undefined && e.costUsd === 0.045 && e.ms === 250 && e.usage?.outputTokens === 200,
    );
  });

  it('raises model_error when output was truncated at max_tokens', async () => {
    const client = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: {} }], 'max_tokens'));
    await assert.rejects(
      anthropicModel(config, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'model output hit max_tokens (4000) before the tool call finished' &&
        e.status === undefined && e.costUsd === 0.045 && e.ms === 250 && e.usage?.inputTokens === 1000 && e.usage.cacheReadTokens === 5000,
    );
  });

  it('raises model_error carrying the status of an API error', async () => {
    const client: MessagesClient = {
      messages: { countTokens: async () => ({ input_tokens: 1 }), create: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); } },
    };
    await assert.rejects(
      anthropicModel(config, { apiKey: FAKE_KEY, client }).propose(req),
      (e: unknown) => e instanceof ModelError && e.status === 429 && e.message === 'Anthropic API error 429: rate limited',
    );
  });

  it('raises model_error without a status for a network failure', async () => {
    const client: MessagesClient = { messages: { countTokens: async () => ({ input_tokens: 1 }), create: async () => { throw new Error('ECONNRESET'); } } };
    await assert.rejects(
      anthropicModel(config, { apiKey: FAKE_KEY, client }).propose(req),
      (e: unknown) => e instanceof ModelError && e.status === undefined && e.message === 'Anthropic API error: ECONNRESET',
    );
  });
});

describe('pricing', () => {
  it('prices the shipped default model from the built-in table when config has no prices', () => {
    const shipped = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: {} }]), seen);
    return anthropicModel(shipped, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req).then((p) => {
      // 1000*2 + 200*10 + 400*2.5 + 5000*0.2 = 2000+2000+1000+1000 = 6000 per million
      assert.equal(p.costUsd, 0.006);
    });
  });

  it('config.prices overrides the built-in price for the same model', async () => {
    const client = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: {} }]));
    const p = await anthropicModel(config, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req);
    // 1000*15 + 200*75 + 400*18.75 + 5000*1.5 = 45000 per million
    assert.equal(p.costUsd, 0.045);
  });

  it('config that sets only input and output keeps the default cache read price', async () => {
    const c = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, prices: { 'claude-sonnet-5-5': { inputPerMTok: 4, outputPerMTok: 20 } } });
    const client = fakeClient(() => ({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 },
    }));
    const p = await anthropicModel(c, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req);
    assert.equal(p.costUsd, 0.2);
  });

  it('reads the 1-hour cache writes from the SDK usage and prices them at 2x input', async () => {
    const shipped = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
    const client = fakeClient(() => ({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 400 } },
    }));
    const p = await anthropicModel(shipped, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req);
    // 1000*2 + 200*10 + 400*4 + 5000*0.2 = 6600 per million
    assert.deepEqual([p.usage, p.costUsd], [u(1000, 200, 5000, 400, 400), 0.0066]);
  });

  it('config cache prices override the defaults per field', async () => {
    const c = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, prices: { 'claude-sonnet-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 1 } } });
    const client = fakeClient(() => ({
      content: [{ type: 'tool_use', name: 'submit_plan', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
    }));
    const p = await anthropicModel(c, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req);
    // read 1 (config) + write 2.5 (default)
    assert.equal(p.costUsd, 3.5);
  });

  it('rejects an id that is not a Claude model before any network call, at parse time and per request', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient(ok([]), seen);
    const r = configSchema.safeParse({ model: 'mystery-model', maxCostUsd: 5 });
    assert.deepEqual(r.error?.issues.map((i) => [i.path.join('.'), i.message]), [
      ['model', 'model "mystery-model" is not a Claude model id such as claude-sonnet-5-5'],
    ]);
    await assert.rejects(
      anthropicModel(config, { apiKey: FAKE_KEY, client }).propose({ ...req, model: 'mystery-model' }),
      (e: unknown) => e instanceof ModelError && e.message === 'model "mystery-model" is not allowed: use a Claude model id such as claude-sonnet-5-5',
    );
    assert.equal(seen.length, 0);
  });
});

describe('API key handling', () => {
  it('with the shipped config, sends the key as x-api-key to api.anthropic.com even when ambient env points elsewhere', async () => {
    const shipped = await loadConfig(resolve(import.meta.dirname, '../worldgen.config.json'), {});
    const saved = { b: process.env['ANTHROPIC_BASE_URL'], a: process.env['ANTHROPIC_AUTH_TOKEN'] };
    process.env['ANTHROPIC_BASE_URL'] = 'https://evil.example';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'ambient-token';
    const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 1000 }), { headers: { 'content-type': 'application/json' } });
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: shipped.model, stop_reason: 'tool_use', stop_sequence: null,
          content: [{ type: 'text', text: 'note' }, { type: 'tool_use', id: 't1', name: 'submit_plan', input: { a: 1 } }],
          usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    try {
      const p = await anthropicModel(shipped, { apiKey: FAKE_KEY, fetch: fakeFetch }).propose(req);
      assert.deepEqual(p.input, { a: 1 });
      assert.deepEqual(p.advice, ['note']);
      // 1000*2 + 200*10 = 4000 per million
      assert.equal(p.costUsd, 0.004);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/messages');
      assert.equal(calls[0]?.headers.get('x-api-key'), FAKE_KEY);
      assert.equal(calls[0]?.headers.get('authorization'), null);
      assert.deepEqual(calls[0]?.body['tool_choice'], { type: 'auto', disable_parallel_tool_use: true });
      assert.equal(calls[0]?.body['model'], 'claude-sonnet-5-5');
    } finally {
      if (saved.b === undefined) delete process.env['ANTHROPIC_BASE_URL']; else process.env['ANTHROPIC_BASE_URL'] = saved.b;
      if (saved.a === undefined) delete process.env['ANTHROPIC_AUTH_TOKEN']; else process.env['ANTHROPIC_AUTH_TOKEN'] = saved.a;
    }
  });

  it('throws a model_error naming LLM_KEY when the key is missing or blank', () => {
    for (const apiKey of [undefined, '', '   ']) {
      assert.throws(
        () => anthropicModel(config, { apiKey }),
        (e: unknown) => e instanceof ModelError && e.kind === 'model_error' && e.message.includes('LLM_KEY'),
      );
    }
  });

  it('never reads ANTHROPIC_API_KEY from the environment', () => {
    const saved = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = FAKE_KEY;
    try {
      assert.throws(() => anthropicModel(config, { apiKey: undefined }), /LLM_KEY/);
    } finally {
      if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it('keeps the key out of the proposal and out of error messages, even when the API echoes it', async () => {
    const good = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: { a: 1 } }]));
    const p = await anthropicModel(config, { apiKey: FAKE_KEY, client: good }).propose(req);
    assert.equal(JSON.stringify(p).includes(FAKE_KEY), false);

    const leaky: MessagesClient = {
      messages: { countTokens: async () => ({ input_tokens: 1 }), create: async () => { throw Object.assign(new Error(`invalid x-api-key ${FAKE_KEY}`), { status: 401 }); } },
    };
    await assert.rejects(
      anthropicModel(config, { apiKey: FAKE_KEY, client: leaky }).propose(req),
      (e: unknown) => e instanceof ModelError && e.status === 401 && !e.message.includes(FAKE_KEY) && e.message === 'Anthropic API error 401: invalid x-api-key [redacted]',
    );
  });

  it('does not put the key in config', () => {
    assert.equal(JSON.stringify(config).includes(FAKE_KEY), false);
    assert.equal(configSchema.safeParse({ model: 'claude-sonnet-5-5', maxCostUsd: 1, apiKey: FAKE_KEY }).success, false);
  });
});

describe('anthropicModel per-request model and effort', () => {
  const twoModels = configSchema.parse({
    model: 'claude-sonnet-5-5', maxCostUsd: 5, maxOutputTokens: 4000,
    prices: { 'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 } },
  });

  it('sends the request model and effort, and prices the call at that model', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: {} }]), seen);
    const p = await anthropicModel(twoModels, { apiKey: FAKE_KEY, client, now: ticker() }).propose({ ...req, model: 'claude-sonnet-5-5', effort: 'xhigh' });
    assert.equal(seen[0]?.['model'], 'claude-sonnet-5-5');
    assert.deepEqual(seen[0]?.['output_config'], { effort: 'xhigh' });
    // 1000*2 + 200*10 + 400*2.5 + 5000*0.2 = 2000+2000+1000+1000 = 6000 per million
    assert.equal(p.costUsd, 0.006);
  });

  it('sends no output_config when the request has no effort', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: {} }]), seen);
    await anthropicModel(twoModels, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req);
    assert.equal(seen[0]?.['model'], 'claude-sonnet-5-5');
    assert.equal(Object.hasOwn(seen[0] ?? {}, 'output_config'), false);
  });

  it('calls exactly the priced model a request names, with no substitute (A-283)', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: {} }]), seen);
    const p = await anthropicModel(twoModels, { apiKey: FAKE_KEY, client, now: ticker() }).propose({ ...req, model: 'claude-opus-5-5' });
    assert.deepEqual(seen.map((s) => s['model']), ['claude-opus-5-5']);
    // Opus built-in: 1000*4 + 200*20 + 400*5 + 5000*0.2 = 11000 per million
    assert.equal(p.costUsd, 0.011);
  });

  it('refuses a request model with no known price before any network call', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient(ok([]), seen);
    await assert.rejects(
      anthropicModel(twoModels, { apiKey: FAKE_KEY, client }).propose({ ...req, model: 'claude-haiku-4-5' }),
      (e: unknown) => e instanceof ModelError && e.kind === 'model_error' && e.message === 'model "claude-haiku-4-5" has no known price: add it to prices in worldgen.config.json' &&
        e.costUsd === undefined,
    );
    assert.equal(seen.length, 0);
  });

  it('rejects a reply that calls the tool twice, billed, with the literal message', async () => {
    const client = fakeClient(ok([
      { type: 'tool_use', id: 't1', name: 'submit_plan', input: { a: 1 } },
      { type: 'tool_use', id: 't2', name: 'submit_plan', input: { a: 2 } },
    ]));
    await assert.rejects(
      anthropicModel(config, { apiKey: FAKE_KEY, client, now: ticker() }).propose(req),
      (e: unknown) => e instanceof ModelError && e.kind === 'model_error' && e.message === 'model called tool "submit_plan" 2 times, expected exactly one' &&
        e.status === undefined && e.costUsd === 0.045 && e.ms === 250 && e.usage?.outputTokens === 200,
    );
  });

  it('sends exactly these request params, with output_config only when an effort is set', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient(ok([{ type: 'tool_use', name: 'submit_plan', input: {} }]), seen);
    const model = anthropicModel(twoModels, { apiKey: FAKE_KEY, client, now: ticker() });
    await model.propose({ ...req, effort: 'high' });
    await model.propose(req);
    const base = {
      model: 'claude-sonnet-5-5',
      max_tokens: 4000,
      system: 'sys\n\nRespond by calling the tool "submit_plan" exactly once with your answer as its input.',
      messages: [{ role: 'user', content: 'make a world' }],
      tools: [{ name: 'submit_plan', description: 'submit', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    };
    assert.deepEqual(seen, [{ ...base, output_config: { effort: 'high' } }, base]);
  });
});

/**
 * A claude -p JSON result trimmed from one real call (CLI 2.1.292, 2026-10-06, schema
 * {word: string}): the fields claudeCliModel reads, plus a few it ignores.
 */
const CLI_SUCCESS = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  duration_ms: 2764,
  duration_api_ms: 2637,
  stop_reason: 'tool_use',
  result: '{"word":"pong"}',
  structured_output: { word: 'pong' },
  total_cost_usd: 0.014896,
  usage: { input_tokens: 2, cache_creation_input_tokens: 1731, cache_read_input_tokens: 0, output_tokens: 52, service_tier: 'standard' },
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 2, outputTokens: 52, costUSD: 0.014896 } },
  permission_denials: [],
};
/** Error results, shape from the CLI docs (no real failure was captured). */
const CLI_RETRIES_EXHAUSTED = {
  type: 'result',
  subtype: 'error_max_structured_output_retries',
  is_error: true,
  total_cost_usd: 0.25,
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  errors: ['Failed to provide valid structured output after 5 attempts'],
};

type SpawnCall = { bin: string; args: readonly string[]; stdin: string; limits: { timeoutMs: number; idleMs: number } };
function fakeSpawn(reply: SpawnResult | Error, seen: SpawnCall[] = []): SpawnClaude {
  return async (bin, args, stdin, limits) => {
    seen.push({ bin, args, stdin, limits });
    if (reply instanceof Error) throw reply;
    return reply;
  };
}
/**
 * A plan call cut off by its share in its second API message, in the line shapes of a live sonnet-5-5 run (A-135):
 * the CLI's own schema check rejected the first answer, so the model wrote it again. Ids and long fields trimmed.
 */
const SESSION = { session_id: '9f87fe5f-527a-466e-92be-ca03fc9f202c' };
const streamEvent = (event: object) => ({ type: 'stream_event', event, ...SESSION, parent_tool_use_id: null });
const messageStart = (cacheWrite: number, cacheRead: number, output: number) => streamEvent({
  type: 'message_start',
  message: { model: 'claude-sonnet-5-5', type: 'message', role: 'assistant', content: [], stop_reason: null,
    usage: { input_tokens: 2, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite }, output_tokens: output, service_tier: 'standard' } },
});
const thinkingTokens = (estimated: number, delta: number) => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: estimated, estimated_tokens_delta: delta, ...SESSION });
const answerChunk = (partial: string) => streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial } });
const PLAN_STREAM_CUT = [
  JSON.stringify({ type: 'system', subtype: 'init', cwd: '/private/tmp', model: 'claude-sonnet-5-5', tools: ['StructuredOutput'], ...SESSION }),
  JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting', ...SESSION }),
  JSON.stringify(messageStart(636, 43035, 5)),
  JSON.stringify(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })),
  JSON.stringify(thinkingTokens(50, 50)),
  JSON.stringify(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } })),
  JSON.stringify(thinkingTokens(14800, 150)),
  JSON.stringify(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'CAQSk6QC' } })),
  JSON.stringify(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01D1', name: 'StructuredOutput', input: {} } })),
  JSON.stringify(answerChunk('{"software":"Public library ILS",')),
  JSON.stringify(answerChunk('"summary":"A multi-branch public library."')),
  JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01D1', name: 'StructuredOutput', input: { software: 'Public library ILS' } }] }, ...SESSION }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: "Output does not match required schema: root: must have required property 'assumptions'", is_error: true, tool_use_id: 'toolu_01D1' }] }, ...SESSION }),
  JSON.stringify(streamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' },
    usage: { input_tokens: 2, cache_creation_input_tokens: 636, cache_read_input_tokens: 43035, output_tokens: 17873, output_tokens_details: { thinking_tokens: 14910 } } })),
  JSON.stringify(streamEvent({ type: 'message_stop' })),
  JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, ...SESSION }),
  JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting', ...SESSION }),
  JSON.stringify(messageStart(18335, 43671, 3)),
  JSON.stringify(thinkingTokens(1200, 1200)),
  JSON.stringify(answerChunk('{"software":"Public library ILS (Koha')),
  'warning: slow disk',
  JSON.stringify(streamEvent({ type: 'ping' })),
  '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"-style circ',
].join('\n');
/** Input and cache tokens from both message_starts; output 17873 from the finished message plus 1200 thinking so far in the cut one. */
const PLAN_STREAM_USAGE = { inputTokens: 4, outputTokens: 19073, cacheReadTokens: 86706, cacheWriteTokens: 18971, cacheWrite1hTokens: 18971 };
/**
 * A one-message plan call cut mid-answer whose thinking stayed under the CLI's estimate frames, as in the live run's second
 * message (40 thinking tokens, no thinking_tokens line): the answer streams while the output token count is still 0.
 */
const ANSWER_STREAM_CUT = [
  JSON.stringify({ type: 'system', subtype: 'init', cwd: '/private/tmp', model: 'claude-sonnet-5-5', tools: ['StructuredOutput'], ...SESSION }),
  JSON.stringify(messageStart(18335, 43671, 3)),
  JSON.stringify(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })),
  JSON.stringify(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Rewrite with assumptions.' } })),
  JSON.stringify(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EpsCCkYI' } })),
  JSON.stringify(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01Bp', name: 'StructuredOutput', input: {} } })),
  JSON.stringify(answerChunk('{"software":"Public library ILS (Koha')),
  JSON.stringify(answerChunk('-style circulation)",')),
  '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"summ',
].join('\n');
const ANSWER_STREAM_USAGE = { inputTokens: 2, outputTokens: 0, cacheReadTokens: 43671, cacheWriteTokens: 18335, cacheWrite1hTokens: 18335 };

describe('streamProgress', () => {
  it('counts messages, schema retries, usage and answer bytes, skipping non-JSON and the cut-off last line', () => {
    assert.deepEqual(streamProgress(PLAN_STREAM_CUT), { messages: 2, schemaRetries: 1, usage: PLAN_STREAM_USAGE, outputBytes: 112 });
  });

  it('is exact once the in-flight message finishes: output is the message_delta count, not the thinking estimate', () => {
    const done = [
      PLAN_STREAM_CUT.split('\n').slice(0, 20).join('\n'),
      JSON.stringify(streamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 21107, output_tokens_details: { thinking_tokens: 40 } } })),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Structured output provided successfully', tool_use_id: 'toolu_01Bp' }] }, ...SESSION }),
      '',
    ].join('\n');
    assert.deepEqual(streamProgress(done), {
      messages: 2, schemaRetries: 1,
      usage: { inputTokens: 4, outputTokens: 38980, cacheReadTokens: 86706, cacheWriteTokens: 18971, cacheWrite1hTokens: 18971 },
      outputBytes: 112,
    });
  });

  it('counts the answer bytes of a message that has reported no output tokens yet', () => {
    assert.deepEqual(streamProgress(ANSWER_STREAM_CUT), { messages: 1, schemaRetries: 0, usage: ANSWER_STREAM_USAGE, outputBytes: 58 });
  });

  it('reports nothing for empty or non-JSON stdout', () => {
    const none = { messages: 0, schemaRetries: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }, outputBytes: 0 };
    assert.deepEqual([streamProgress(''), streamProgress('Error: not logged in\n{"type":"stream_ev')], [none, none]);
  });
});

const exit0 = (body: unknown): SpawnResult => ({ code: 0, signal: null, killed: null, stdout: `${JSON.stringify(body)}\n`, stderr: '' });
const cliConfig = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 2, prices: PRICES });

describe('per-call timeout', () => {
  it('passes the request timeoutMs to the claude spawn instead of maxMinutes, with the 120 s stall limit', async () => {
    const seen: SpawnCall[] = [];
    await claudeCliModel(cliConfig, fakeSpawn(exit0(CLI_SUCCESS), seen), ticker()).propose({ ...req, timeoutMs: 42_000 });
    assert.deepEqual(seen[0]?.limits, { timeoutMs: 42_000, idleMs: 120_000 });
  });
});

describe('claudeArgs', () => {
  it('builds the claude -p flags with the schema inline, the system prompt in a file and no prompt', () => {
    assert.deepEqual(claudeArgs('claude-sonnet-5-5', { ...req, effort: 'high' }, '/tmp/worldgen-claude-x/system.md'), [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', 'claude-sonnet-5-5',
      '--effort', 'high',
      '--system-prompt-file', '/tmp/worldgen-claude-x/system.md',
      '--json-schema', '{"type":"object"}',
      '--tools', '',
      '--safe-mode',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ]);
  });

  it('drops $schema, which the claude CLI rejects, and keeps the rest of the schema', () => {
    const tool = { ...req.tool, inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } };
    const args = claudeArgs('m', { ...req, tool }, 'system.md');
    assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
  });

  it('omits --effort when the request has none', () => {
    assert.equal(claudeArgs('m', req, 'system.md').includes('--effort'), false);
  });
});

describe('claudeCliModel', () => {
  it('sends the prompt on stdin and returns structured_output, usage, total_cost_usd and wall ms', async () => {
    const seen: SpawnCall[] = [];
    const p = await claudeCliModel(cliConfig, fakeSpawn(exit0(CLI_SUCCESS), seen), ticker()).propose({ ...req, effort: 'low' });
    assert.deepEqual(p, {
      input: { word: 'pong' },
      advice: [],
      usage: { inputTokens: 2, outputTokens: 52, cacheReadTokens: 0, cacheWriteTokens: 1731, cacheWrite1hTokens: 0 },
      costUsd: 0.014896,
      costBasis: 'cli_reported_cost',
      ms: 250,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.bin, 'claude');
    assert.equal(seen[0]?.stdin, 'make a world');
    assert.deepEqual(seen[0]?.limits, { timeoutMs: 120_000, idleMs: 120_000 });
    const args = seen[0]?.args ?? [];
    const systemFile = args[args.indexOf('--system-prompt-file') + 1] ?? '';
    assert.deepEqual(args, claudeArgs('claude-sonnet-5-5', { ...req, effort: 'low', maxCostUsd: cliConfig.maxCostUsd }, systemFile));
    assert.equal(args.includes('make a world'), false);
    assert.equal(args.includes('sys'), false);
    assert.equal(seen[0]?.args.includes('--bare'), false);
  });

  it('uses the configured binary and the request model', async () => {
    const seen: SpawnCall[] = [];
    const c = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, claudeBin: '/home/me/.local/bin/claude' });
    await claudeCliModel(c, fakeSpawn(exit0(CLI_SUCCESS), seen), ticker()).propose({ ...req, model: 'claude-sonnet-5-5' });
    assert.equal(seen[0]?.bin, '/home/me/.local/bin/claude');
    assert.deepEqual(seen[0]?.args.slice(5, 7), ['--model', 'claude-sonnet-5-5']);
  });

  it('returns result text as advice when it is commentary, not the JSON echo', async () => {
    const p = await claudeCliModel(cliConfig, fakeSpawn(exit0({ ...CLI_SUCCESS, result: 'Added two tasks.' })), ticker()).propose(req);
    assert.deepEqual(p.advice, ['Added two tasks.']);
  });

  it('reads the result from the last line when a warning precedes it', async () => {
    const out: SpawnResult = { code: 0, signal: null, killed: null, stdout: `warning: slow disk\n${JSON.stringify(CLI_SUCCESS)}\n`, stderr: '' };
    const p = await claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req);
    assert.deepEqual(p.input, { word: 'pong' });
  });

  it('raises a billed model_error for an is_error result on a non-zero exit', async () => {
    const out: SpawnResult = { code: 1, signal: null, killed: null, stdout: JSON.stringify(CLI_RETRIES_EXHAUSTED), stderr: '' };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.kind === 'model_error' &&
        e.message === 'claude -p failed (exit 1): error_max_structured_output_retries: Failed to provide valid structured output after 5 attempts' &&
        e.costUsd === 0.25 && e.ms === 250 && e.usage?.inputTokens === 100 && e.usage.outputTokens === 20,
    );
  });

  it('raises a billed model_error for is_error even on exit 0, with the result text and stderr tail', async () => {
    const body = { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded', total_cost_usd: 0, usage: {} };
    const out: SpawnResult = { code: 0, signal: null, killed: null, stdout: JSON.stringify(body), stderr: 'retrying\ngave up\n' };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'claude -p failed (exit 0): error_during_execution: API Error: 529 overloaded: retrying\ngave up' && e.costUsd === 0,
    );
  });

  it('raises a billed model_error when structured_output is missing', async () => {
    const { structured_output: _omit, ...noOutput } = CLI_SUCCESS;
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(exit0(noOutput)), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'claude -p returned no structured_output (subtype: success)' && e.costUsd === 0.014896 && e.ms === 250,
    );
  });

  it('names claudeBin, WORLDGEN_CLAUDE_BIN and the real binary when the CLI exits 127', async () => {
    const out: SpawnResult = { code: 127, signal: null, killed: null, stdout: '', stderr: 'Error: claude not found in PATH\n' };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'claude -p exited 127: "claude" could not run, often a shell shim or wrapper that is not on PATH outside your terminal. Point WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json at the real binary (try ~/.local/bin/claude): Error: claude not found in PATH',
    );
  });

  it('sends a --json-schema with no $schema that parses as JSON', async () => {
    const seen: SpawnCall[] = [];
    const tool = { ...req.tool, inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'string' } } } };
    await claudeCliModel(cliConfig, fakeSpawn(exit0(CLI_SUCCESS), seen), ticker()).propose({ ...req, tool });
    const args = seen[0]?.args ?? [];
    assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1] ?? ''), { type: 'object', properties: { a: { type: 'string' } } });
  });

  it('raises model_error naming the exit code and stderr when stdout is not JSON', async () => {
    const out: SpawnResult = { code: 1, signal: null, killed: null, stdout: '', stderr: 'Error: --json-schema is not a valid JSON Schema\n' };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'claude -p exited 1 with no JSON result: Error: --json-schema is not a valid JSON Schema' && e.costUsd === undefined,
    );
  });

  it('raises model_error for a process killed by a signal it did not get from us', async () => {
    const out: SpawnResult = { code: null, signal: 'SIGTERM', killed: null, stdout: '', stderr: '' };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'claude -p was killed by SIGTERM with no JSON result',
    );
  });

  it('raises an unbilled StepShareExpired, not model_error, when our own timeout killed a CLI that had sent nothing', async () => {
    const out: SpawnResult = { code: 143, signal: null, killed: 'share', stdout: '', stderr: 'Terminated\n' };
    const e = await claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose({ ...req, timeoutMs: 276_500 }).then(() => null, (x: unknown) => x);
    assert.equal(e instanceof StepShareExpired && !(e instanceof ModelError), true);
    const cut = e as StepShareExpired;
    assert.deepEqual([cut.kind, cut.shareMs, cut.ms, cut.usage, cut.costUsd, cut.progress, cut.message], [
      'share_expired', 276_500, 250, undefined, undefined,
      { messages: 0, schemaRetries: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }, outputBytes: 0 },
      'claude -p was stopped after its 276500 ms step share and had sent nothing',
    ]);
  });

  it('bills a share-killed call for what it streamed, priced from config, and names its progress', async () => {
    const out: SpawnResult = { code: null, signal: 'SIGTERM', killed: 'share', stdout: PLAN_STREAM_CUT, stderr: '' };
    const e = await claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose({ ...req, timeoutMs: 377_984 }).then(() => null, (x: unknown) => x);
    assert.equal(e instanceof StepShareExpired, true);
    const cut = e as StepShareExpired;
    // 4*15 + 19073*75 + 18971*4 + 86706*1.5 = 1636478 per million: config sets no 1-hour write price, so the built-in $4 holds
    assert.deepEqual([cut.shareMs, cut.ms, cut.usage, cut.costUsd, cut.progress, cut.message], [
      377_984, 250, PLAN_STREAM_USAGE, 1.636478,
      { messages: 2, schemaRetries: 1, usage: PLAN_STREAM_USAGE, outputBytes: 112 },
      'claude -p was stopped after its 377984 ms step share while still writing: 2 messages, 19073+ output tokens, 1 schema retry, 112 answer bytes',
    ]);
  });

  it('says a cut call was still writing when it streamed answer bytes but no output token count yet', async () => {
    const share: SpawnResult = { code: null, signal: 'SIGTERM', killed: 'share', stdout: ANSWER_STREAM_CUT, stderr: '' };
    const stall: SpawnResult = { ...share, killed: 'stall' };
    const [cut, silent] = await Promise.all([share, stall].map((out) =>
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose({ ...req, timeoutMs: 377_984 }).then(() => null, (x: unknown) => x)));
    assert.equal(cut instanceof StepShareExpired && silent instanceof CallStalled, true);
    // 2*15 + 18335*4 (1-hour writes, built-in price) + 43671*1.5 = 138876.5 per million
    assert.deepEqual([(cut as StepShareExpired).costUsd, (cut as StepShareExpired).message, (silent as CallStalled).message], [
      0.1388765,
      'claude -p was stopped after its 377984 ms step share while still writing: 1 message, 0+ output tokens, 0 schema retries, 58 answer bytes',
      'claude -p went silent for 120000 ms after streaming 1 message, 0+ output tokens, 0 schema retries, 58 answer bytes, and was stopped as stalled',
    ]);
  });

  it('raises an unbilled CallStalled, not model_error or StepShareExpired, when the CLI was killed for sending nothing', async () => {
    const out: SpawnResult = { code: null, signal: 'SIGTERM', killed: 'stall', stdout: '', stderr: '' };
    const e = await claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose({ ...req, timeoutMs: 276_500 }).then(() => null, (x: unknown) => x);
    assert.equal(e instanceof CallStalled && !(e instanceof ModelError), true);
    const cut = e as CallStalled;
    assert.deepEqual([cut.kind, cut.idleMs, cut.ms, cut.usage, cut.costUsd, cut.progress.messages, cut.message],
      ['stalled', 120_000, 250, undefined, undefined, 0, 'claude -p sent nothing for 120000 ms and was stopped as stalled']);
  });

  it('bills a CallStalled that went silent after streaming part of an answer, and names its progress', async () => {
    const out: SpawnResult = { code: null, signal: 'SIGTERM', killed: 'stall', stdout: PLAN_STREAM_CUT, stderr: '' };
    const e = await claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req).then(() => null, (x: unknown) => x);
    assert.equal(e instanceof CallStalled, true);
    const cut = e as CallStalled;
    assert.deepEqual([cut.usage, cut.costUsd, cut.progress.schemaRetries, cut.message], [
      PLAN_STREAM_USAGE, 1.636478, 1,
      'claude -p went silent for 120000 ms after streaming 2 messages, 19073+ output tokens, 1 schema retry, 112 answer bytes, and was stopped as stalled',
    ]);
  });

  it('returns a billed proposal when the CLI printed its result before this side stopped it', async () => {
    for (const killed of ['stall', 'share', 'answered'] as const) {
      const out: SpawnResult = { code: null, signal: 'SIGTERM', killed, stdout: `{"type":"system"}\n${JSON.stringify(CLI_SUCCESS)}\n`, stderr: '' };
      const p = await claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req);
      assert.deepEqual({ killed, input: p.input, costUsd: p.costUsd }, { killed, input: { word: 'pong' }, costUsd: 0.014896 });
    }
  });

  it('reads the result line of a stream-json transcript into the same proposal as a lone result', async () => {
    const lines = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { type: 'system', subtype: 'thinking_tokens', tokens: 120 },
      { type: 'assistant', message: { content: [{ type: 'text', text: '{"word":"pong"}' }] } },
      CLI_SUCCESS,
    ].map((l) => JSON.stringify(l));
    const out: SpawnResult = { code: 0, signal: null, killed: null, stdout: `${lines.join('\n')}\n{"type":"stream_ev`, stderr: '' };
    const streamed = await claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req);
    const lone = await claudeCliModel(cliConfig, fakeSpawn(exit0(CLI_SUCCESS)), ticker()).propose(req);
    assert.deepEqual(streamed, {
      input: { word: 'pong' },
      advice: [],
      usage: { inputTokens: 2, outputTokens: 52, cacheReadTokens: 0, cacheWriteTokens: 1731, cacheWrite1hTokens: 0 },
      costUsd: 0.014896,
      costBasis: 'cli_reported_cost',
      ms: 250,
    });
    assert.deepEqual(streamed, lone);
  });

  it('raises model_error when a stream-json transcript ends with no result line', async () => {
    const out: SpawnResult = { code: 1, signal: null, killed: null, stdout: '{"type":"system","subtype":"init"}\n{"type":"assistant"}\n', stderr: '' };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'claude -p exited 1 with no JSON result: {"type":"system","subtype":"init"}\n{"type":"assistant"}',
    );
  });

  it('still raises model_error for a genuine exit 143 the timeout did not cause', async () => {
    const out: SpawnResult = { code: 143, signal: null, killed: null, stdout: '', stderr: '' };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(out), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError && e.message === 'claude -p exited 143 with no JSON result',
    );
  });

  it('raises model_error when the binary cannot start', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(enoent), ticker()).propose(req),
      (e: unknown) => e instanceof ModelError &&
        e.message === 'cannot run the claude CLI "claude": spawn claude ENOENT. Set claudeBin in worldgen.config.json to the real binary',
    );
  });

  it('falls back to config prices when the result has no total_cost_usd, and to the built-in Sonnet prices without config prices', async () => {
    const { total_cost_usd: _omit, ...noCost } = CLI_SUCCESS;
    const body = { ...noCost, usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000 } };
    const p = await claudeCliModel(cliConfig, fakeSpawn(exit0(body)), ticker()).propose(req);
    // 1000*15 + 200*75 + 400*18.75 + 5000*1.5 = 45000 per million
    assert.equal(p.costUsd, 0.045);
    const builtin = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
    const q = await claudeCliModel(builtin, fakeSpawn(exit0(body)), ticker()).propose(req);
    // 1000*2 + 200*10 + 400*2.5 + 5000*0.2 = 6000 per million
    assert.equal(q.costUsd, 0.006);
  });

  it('prices the 1-hour cache writes of a result with no total_cost_usd at 2x input, as the CLI bills the live lib1 plan call', async () => {
    const lib1 = {
      type: 'result', subtype: 'success', is_error: false, structured_output: { word: 'pong' },
      usage: { input_tokens: 4, cache_creation_input_tokens: 18971, cache_read_input_tokens: 86706, output_tokens: 38980,
        cache_creation: { ephemeral_1h_input_tokens: 18971, ephemeral_5m_input_tokens: 0 }, service_tier: 'standard' },
    };
    const builtin = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
    const p = await claudeCliModel(builtin, fakeSpawn(exit0(lib1)), ticker()).propose(req);
    assert.deepEqual([p.usage, p.costUsd], [{ inputTokens: 4, outputTokens: 38980, cacheReadTokens: 86706, cacheWriteTokens: 18971, cacheWrite1hTokens: 18971 }, 0.4830332]);
  });

  it('passes the CLI exactly one --model, the one named, and never a fallback model (A-283)', async () => {
    const seen: SpawnCall[] = [];
    await claudeCliModel(cliConfig, fakeSpawn(exit0(CLI_SUCCESS), seen), ticker()).propose({ ...req, model: 'claude-opus-5-5' });
    const args = seen[0]?.args ?? [];
    assert.deepEqual(args.flatMap((a, i) => (a === '--model' ? [args[i + 1]] : [])), ['claude-opus-5-5']);
    assert.equal(args.some((a) => a.includes('fallback')), false);
  });

  it('rejects a request model with no known price before spawning the CLI', async () => {
    const seen: SpawnCall[] = [];
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(exit0(CLI_SUCCESS), seen), ticker()).propose({ ...req, model: 'claude-haiku-4-5' }),
      (e: unknown) => e instanceof ModelError && e.kind === 'model_error' && e.message === 'model "claude-haiku-4-5" has no known price: add it to prices in worldgen.config.json',
    );
    assert.equal(seen.length, 0);
  });

  it('refuses an argument Linux would refuse with E2BIG before spawning, on every platform (A-378)', async () => {
    const seen: SpawnCall[] = [];
    const tool = { ...req.tool, inputSchema: { type: 'object', description: 'd'.repeat(131_072) } };
    await assert.rejects(
      claudeCliModel(cliConfig, fakeSpawn(exit0(CLI_SUCCESS), seen), ticker()).propose({ ...req, tool }),
      (e: unknown) => e instanceof ModelError && e.billing.kind === 'not_started' &&
        e.message === 'claude -p argument --json-schema is 131106 bytes, and Linux refuses one of 131072 or more',
    );
    assert.equal(seen.length, 0);
    assert.equal(MAX_ARG_BYTES, 131_072);
  });
});

describe('spawnClaude with a stand-in binary (no model, no network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-claude-'));
  const bin = (name: string, body: string): string => {
    const f = join(dir, name);
    writeFileSync(f, `#!/usr/bin/env node\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const sh = (name: string, body: string): string => {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const echo = bin('claude-echo', [
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (d) => { input += d; });",
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'noted',",
    "    structured_output: { argv: process.argv.slice(2), stdin: input, system: require('node:fs').readFileSync(process.argv[process.argv.indexOf('--system-prompt-file') + 1], 'utf8') }, total_cost_usd: 0.5,",
    '    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }));',
    '});',
  ].join('\n'));

  it('round-trips argv and stdin through the real spawn path', async () => {
    const c = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, claudeBin: echo });
    const prompt = 'line one\nline "two" with $HOME and `ticks`';
    const p = await claudeCliModel(c, spawnClaude, ticker()).propose({ ...req, prompt, effort: 'medium' });
    const argv = (p.input as { argv: string[] }).argv;
    const systemFile = argv[argv.indexOf('--system-prompt-file') + 1] ?? '';
    assert.deepEqual(p.input, { argv: claudeArgs('claude-sonnet-5-5', { ...req, effort: 'medium', maxCostUsd: cliConfig.maxCostUsd }, systemFile), stdin: prompt, system: 'sys' });
    assert.deepEqual(p.advice, ['noted']);
    assert.deepEqual(p.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, cacheWrite1hTokens: 0 });
    assert.equal(p.costUsd, 0.5);
  });

  it('passes a 240000-byte prompt and a 222000-byte system prompt intact, with neither in argv (A-378)', async () => {
    // Linux refuses any argv string of 131072 bytes or more with E2BIG; macOS does not, so this checks argv itself.
    const probe = bin('claude-big', [
      "const fs = require('node:fs');",
      "const file = process.argv[process.argv.indexOf('--system-prompt-file') + 1];",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => { input += d; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5,",
      "    structured_output: { file, mode: fs.statSync(file).mode & 0o777, dirMode: fs.statSync(require('node:path').dirname(file)).mode & 0o777,",
      "      system: fs.readFileSync(file, 'utf8'), stdin: input, longestArg: Math.max(...process.argv.slice(2).map((a) => Buffer.byteLength(a))) },",
      '    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } }));',
      '});',
    ].join('\n'));
    const prompt = 'make a world, café\n'.repeat(12_000);
    const system = 'You are WorldGen. Écrivez un monde.\n'.repeat(6_000);
    assert.deepEqual([Buffer.byteLength(prompt), Buffer.byteLength(system)], [240_000, 222_000]);
    const c = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, claudeBin: probe });
    const p = await claudeCliModel(c, spawnClaude, ticker()).propose({ ...req, prompt, system });
    const got = p.input as { file: string; mode: number; dirMode: number; system: string; stdin: string; longestArg: number };
    assert.equal(got.stdin === prompt, true);
    assert.equal(got.system === system, true);
    assert.deepEqual([got.mode, got.dirMode], [0o600, 0o700]);
    assert.ok(got.longestArg < 1024, `longest argument ${got.longestArg} bytes`);
    assert.deepEqual([existsSync(got.file), existsSync(dirname(got.file))], [false, false]);
  });

  it('runs the CLI from the OS temp dir, not the repo', async () => {
    const pwd = bin('claude-pwd', "process.stdout.write(JSON.stringify({ structured_output: { cwd: process.cwd() }, total_cost_usd: 0 }));");
    const r = await spawnClaude(pwd, [], '', { timeoutMs: 5000, idleMs: 60_000 });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).structured_output.cwd.startsWith(resolve(import.meta.dirname, '..')), false);
  });

  it('kills a hung CLI after the timeout with SIGTERM', async () => {
    const hang = bin('claude-hang', 'setTimeout(() => {}, 30000);');
    const r = await spawnClaude(hang, [], '', { timeoutMs: 300, idleMs: 60_000 });
    assert.deepEqual({ code: r.code, signal: r.signal, killed: r.killed }, { code: null, signal: 'SIGTERM', killed: 'share' });
  });

  it('kills a CLI that prints nothing for idleMs as stalled, long before its share', async () => {
    const silent = sh('claude-silent', 'exec sleep 30');
    const t0 = Date.now();
    const r = await spawnClaude(silent, [], '', { timeoutMs: 60_000, idleMs: 300 });
    const ms = Date.now() - t0;
    assert.deepEqual({ code: r.code, signal: r.signal, killed: r.killed, stdout: r.stdout }, { code: null, signal: 'SIGTERM', killed: 'stall', stdout: '' });
    assert.ok(ms >= 300 && ms < 3000, `settled after ${ms} ms`);
  });

  it('does not call a CLI stalled while it keeps printing, and kills it at its share', async () => {
    const ticking = sh('claude-ticking', 'while :; do echo tick; sleep 0.1; done');
    const t0 = Date.now();
    const r = await spawnClaude(ticking, [], '', { timeoutMs: 3000, idleMs: 2000 });
    const ms = Date.now() - t0;
    assert.equal(r.killed, 'share');
    assert.ok(r.stdout.split('\n').filter((l) => l === 'tick').length >= 5, r.stdout);
    assert.ok(ms >= 3000 && ms < 8000, `settled after ${ms} ms`);
  });

  it('settles and leaves no process behind when the CLI ignores SIGTERM: SIGKILL after the grace', async () => {
    // The pid is printed only after the trap is set, so the stall clock (reset by that line) cannot beat the trap.
    const stubborn = sh('claude-stubborn', 'trap "" TERM; echo $$; exec sleep 30');
    const t0 = Date.now();
    const r = await spawnClaude(stubborn, [], '', { timeoutMs: 60_000, idleMs: 1500 }, 300);
    const ms = Date.now() - t0;
    assert.deepEqual({ code: r.code, signal: r.signal, killed: r.killed }, { code: null, signal: 'SIGKILL', killed: 'stall' });
    assert.ok(ms >= 1800 && ms < 8000, `settled after ${ms} ms`);
    const pid = Number(r.stdout.trim());
    assert.throws(() => process.kill(pid, 0), (e: unknown) => (e as { code?: unknown }).code === 'ESRCH');
  });

  it('ends a CLI that printed its result and then lingers, without waiting out the stall limit, and keeps the answer', async () => {
    const lingering = sh('claude-linger', `echo '{"type":"system"}'; echo '${JSON.stringify({ ...CLI_SUCCESS, total_cost_usd: 0.42 })}'; echo $$ >&2; exec sleep 30`);
    const t0 = Date.now();
    const r = await spawnClaude(lingering, [], '', { timeoutMs: 60_000, idleMs: 60_000 }, 300);
    const ms = Date.now() - t0;
    assert.deepEqual({ code: r.code, signal: r.signal, killed: r.killed }, { code: null, signal: 'SIGTERM', killed: 'answered' });
    assert.ok(ms >= 300 && ms < 3000, `settled after ${ms} ms`);
    assert.throws(() => process.kill(Number(r.stderr.trim()), 0), (e: unknown) => (e as { code?: unknown }).code === 'ESRCH');
    const fast: SpawnClaude = (b, a, s, limits) => spawnClaude(b, a, s, { ...limits, idleMs: 60_000 }, 300);
    const c = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, claudeBin: lingering });
    const p = await claudeCliModel(c, fast, ticker()).propose(req);
    assert.deepEqual({ input: p.input, costUsd: p.costUsd }, { input: { word: 'pong' }, costUsd: 0.42 });
  });

  it('cancels the default CLI transport through the model request signal', async () => {
    const hang = bin('claude-abort', 'setTimeout(() => {}, 30000);');
    const controller = new AbortController();
    const pending = claudeCliModel({ ...cliConfig, claudeBin: hang }).propose({ ...req, signal: controller.signal });
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.billing.kind, 'unknown');
      assert.equal(error.costUsd, undefined);
      assert.equal(error.partialModelUsage, undefined);
      assert.match(error.message, /cancelled without a final receipt/);
      return true;
    });
    setTimeout(() => controller.abort(), 100);
    await rejected;
  });

  it('kills a child that ignores SIGTERM after bounded cancellation grace', async () => {
    const ready = join(dir, 'ignore-term-ready');
    const stubborn = bin('claude-ignore-term', `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const pending = spawnClaude(stubborn, [], '', { timeoutMs: 30000, idleMs: 60000, signal: controller.signal });
    const startupDeadline = Date.now() + 5000;
    try {
      while (!existsSync(ready) && Date.now() < startupDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(existsSync(ready), true, 'stand-in child did not install its SIGTERM handler');
      controller.abort();
      const result = await pending;
      const pid = Number(readFileSync(ready, 'utf8'));
      assert.throws(() => process.kill(pid, 0), (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ESRCH');
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: null, signal: 'SIGKILL' });
    } finally {
      controller.abort();
      await pending;
    }
  });

  it('does not spawn an already cancelled CLI request', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(spawnClaude(join(dir, 'missing'), [], '', { timeoutMs: 1000, idleMs: 60000, signal: controller.signal }), { name: 'AbortError' });
  });

  it('rejects when the binary does not exist', async () => {
    await assert.rejects(spawnClaude(join(dir, 'missing'), [], '', { timeoutMs: 1000, idleMs: 60_000 }), (e: unknown) => (e as { code?: unknown }).code === 'ENOENT');
  });

  it('resolves when the CLI exits but a grandchild keeps its stdout open', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const leaky = bin('claude-leaky', [
      "const { spawn } = require('node:child_process');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true });",
      'gc.unref();',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
      "console.log(JSON.stringify({ ok: 1 }));",
    ].join('\n'));
    let guard: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, rej) => { guard = setTimeout(() => rej(new Error('spawnClaude did not settle within 5 s')), 5000); });
    let r: Awaited<ReturnType<typeof spawnClaude>> | undefined;
    try {
      r = await Promise.race([spawnClaude(leaky, [], '', { timeoutMs: 60_000, idleMs: 60_000 }), late]);
    } finally {
      clearTimeout(guard);
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    }
    assert.equal(r.code, 0);
    assert.equal(r.killed, null);
    assert.equal(r.stdout, '{"ok":1}\n');
  });

  it('keeps stdout and stderr apart', async () => {
    const both = bin('claude-both', "process.stderr.write('oops'); process.stdout.write('{}');");
    const r = await spawnClaude(both, [], '', { timeoutMs: 5000, idleMs: 60_000 });
    assert.deepEqual(r, { code: 0, signal: null, killed: null, stdout: '{}', stderr: 'oops' });
  });

  it('settles cancellation after killing a stubborn CLI whose grandchild holds the output pipe', async () => {
    const pidFile = join(dir, 'cancel-grandchild.pid');
    const stubborn = bin('claude-cancel-leaky', [
      "process.on('SIGTERM', () => {});",
      "const gc = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true });",
      'gc.unref();',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const controller = new AbortController();
    const pending = spawnClaude(stubborn, [], '', { timeoutMs: 30000, idleMs: 60000, signal: controller.signal });
    let guard: ReturnType<typeof setTimeout> | undefined;
    let result: Awaited<ReturnType<typeof spawnClaude>> | undefined;
    try {
      const startupDeadline = Date.now() + 5000;
      while (!existsSync(pidFile) && Date.now() < startupDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(existsSync(pidFile), true, 'stand-in child did not start its grandchild');
      controller.abort();
      const late = new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error('cancelled CLI did not settle within 5 s')), 5000); });
      result = await Promise.race([pending, late]);
    } finally {
      controller.abort();
      clearTimeout(guard);
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      await pending;
    }
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: null, signal: 'SIGKILL' });
  });
});

describe('cancelling a request with an AbortSignal', () => {
  it('keeps the per-call timeout when handing the optional signal to the client', async () => {
    const seen: { params: Record<string, unknown>; options: unknown[] }[] = [];
    const client: MessagesClient = {
      messages: { countTokens: async () => ({ input_tokens: 1 }),
        async create(params, ...options) {
          seen.push({ params, options });
          return { content: [{ type: 'tool_use', name: 'submit_plan', input: { a: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 200 } };
        },
      },
    };
    const model = anthropicModel(config, { apiKey: FAKE_KEY, client });
    const controller = new AbortController();
    await model.propose({ ...req, timeoutMs: 42_000, signal: controller.signal });
    await model.propose(req);
    assert.equal(seen[0]?.options.length, 1);
    assert.equal((seen[0]?.options[0] as { signal?: AbortSignal }).signal?.aborted, false);
    assert.equal('signal' in (seen[0]?.params ?? {}), false);
    assert.equal((seen[0]?.options[0] as { timeout?: number }).timeout, 42_000);
    assert.equal((seen[1]?.options[0] as { timeout?: number }).timeout, 900_000);
    assert.equal((seen[1]?.options[0] as { signal?: AbortSignal }).signal?.aborted, false);
  });

  it('aborts the HTTP request the SDK made, once, and raises a model_error without retrying', async () => {
    let calls = 0;
    let httpAborted = false;
    const hanging = (async (_url: unknown, init?: RequestInit) => {
      if (String(_url).includes('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 1 }), { headers: { 'content-type': 'application/json' } });
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          httpAborted = true;
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    }) as typeof globalThis.fetch;
    const controller = new AbortController();
    const pending = anthropicModel(config, { apiKey: FAKE_KEY, fetch: hanging }).propose({ ...req, signal: controller.signal });
    const settled = assert.rejects(pending, (e: unknown) => e instanceof ModelError && e.status === undefined && e.usage === undefined && e.message.startsWith('Anthropic API error:'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(httpAborted, false);
    controller.abort();
    await settled;
    assert.equal(httpAborted, true);
    assert.equal(calls, 1);
  });

  it('sends nothing at all when the signal is already aborted', async () => {
    let calls = 0;
    const fetchSeam = (async () => { calls += 1; return Response.json(ok([{ type: 'tool_use', id: 't1', name: 'submit_plan', input: {} }])()); }) as typeof globalThis.fetch;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(anthropicModel(config, { apiKey: FAKE_KEY, fetch: fetchSeam }).propose({ ...req, signal: controller.signal }), ModelError);
    assert.equal(calls, 0);
  });
});
