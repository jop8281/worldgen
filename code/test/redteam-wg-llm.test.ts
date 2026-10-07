/**
 * Red-team: worldgen/llm.ts, SDK transport only (factory unit wg-llm), and the rule that
 * `npm test` never calls the real API.
 *
 * Guarantees (one sentence each, with source):
 * WG-L01 claude-sonnet-5-5 costs $2 input, $10 output, $2.50 cache write and $0.20 cache read per million tokens. (config.ts BUILTIN_PRICES doc "Sonnet 5.5 lists $2 / $10")
 * WG-L02 A price without cache prices charges cache writes at 1.25x input and cache reads at 0.1x input. (llm.ts ModelPrice doc)
 * WG-L03 costOf is exact to a billionth of a dollar, with no float noise, and a missing cacheWriteTokens counts as zero. (llm.ts costOf doc; Usage doc)
 * WG-L04 costOf throws a ModelError for an unpriced model. (llm.ts costOf doc)
 * WG-L05 propose sends config.model, config.maxOutputTokens and the given tool schema, and returns input, advice, usage, cost and ms. (llm.ts ProposeRequest, Proposal, anthropicModel)
 * WG-L06 A reply that the API billed but that is unusable raises a ModelError that carries the billed usage and cost. (llm.ts ModelError doc "Set when the API answered (and billed)")
 * WG-L07 With the client or fetch seam, the module never touches globalThis.fetch. (llm.ts AnthropicOptions "no SDK client is built and no network is touched"; "replaces the HTTP transport")
 * WG-L08 A missing key fails before any client exists or any request is made, and never falls back to the environment. (llm.ts AnthropicOptions "this module never reads the environment")
 * WG-L09 The key never appears in a ModelError message, whichever path raised it. (input.ts / llm.ts: tokens never reach events; ModelError mirrors RunEvent model_error)
 * WG-N01 No test file builds anthropicModel without a client or fetch seam (or a blank key that fails before the network), passes an environment value as apiKey, or loads .env. (AGENTS.md "npm test never calls the real API")
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { configSchema } from '../src/worldgen/config.ts';
import { DEFAULT_PRICES, ModelError, anthropicModel, costOf, type MessagesClient, type ProposeRequest } from '../src/worldgen/llm.ts';

const KEY = 'sk-ant-rt-SECRET-0000';
const req: ProposeRequest = { system: 'sys', prompt: 'go', tool: { name: 'edit_world', description: 'edit', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } } };
const opus = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, maxOutputTokens: 1234 });
const u = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens?: number) =>
  cacheWriteTokens === undefined ? { inputTokens, outputTokens, cacheReadTokens } : { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };

function client(reply: unknown, seen: Record<string, unknown>[] = []): MessagesClient {
  return { messages: { countTokens: async () => ({ input_tokens: 1 }), create: async (p) => { seen.push(p); return reply as never; } } };
}
const reply = (content: unknown[], stop_reason: string | null, usage = { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 4000 }) =>
  ({ content, stop_reason, usage });

let fetchCalls = 0;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error('redteam: global fetch is forbidden in tests');
  }) as typeof globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

describe('redteam llm: cost', () => {
  it('WG-L01 Sonnet 5.5 built-in prices per million tokens', () => {
    const P = DEFAULT_PRICES;
    assert.equal(costOf(u(1_000_000, 0), 'claude-sonnet-5-5', P), 2);
    assert.equal(costOf(u(0, 1_000_000), 'claude-sonnet-5-5', P), 10);
    assert.equal(costOf(u(0, 0, 0, 1_000_000), 'claude-sonnet-5-5', P), 2.5);
    assert.equal(costOf(u(0, 0, 1_000_000), 'claude-sonnet-5-5', P), 0.2);
    // 1000*2 + 2000*10 + 3000*2.5 + 4000*0.2 = 2000+20000+7500+800 = 30300 per million
    assert.equal(costOf(u(1000, 2000, 4000, 3000), 'claude-sonnet-5-5', P), 0.0303);
  });

  it('WG-L02 default cache ratios: write 1.25x input, read 0.1x input', () => {
    const P = { m: { inputPerMTok: 3, outputPerMTok: 15 } };
    assert.equal(costOf(u(0, 0, 0, 1_000_000), 'm', P), 3.75);
    assert.equal(costOf(u(0, 0, 1_000_000), 'm', P), 0.3);
  });

  it('WG-L03 exact to a billionth, missing cacheWriteTokens is zero', () => {
    const P = { m: { inputPerMTok: 0.1, outputPerMTok: 0.2 } };
    assert.equal(costOf(u(1, 1), 'm', P), 0.0000003);
    assert.equal(costOf(u(1, 0), 'claude-sonnet-5-5', DEFAULT_PRICES), 0.000002);
    assert.equal(costOf(u(0, 0, 1), 'claude-sonnet-5-5', DEFAULT_PRICES), 0.0000002);
    assert.equal(costOf(u(333, 0), 'm', P), 0.0000333);
    assert.equal(costOf({ inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 }, 'm', P), 0.000003);
  });

  it('WG-L04 unpriced model throws ModelError', () => {
    assert.throws(() => costOf(u(1, 1), 'nope', DEFAULT_PRICES), (e: unknown) => e instanceof ModelError && e.kind === 'model_error');
  });
});

describe('redteam llm: propose through the client seam', () => {
  it('WG-L05 sends model, max_tokens and the tool schema; returns input, advice, usage, cost, ms', async () => {
    const seen: Record<string, unknown>[] = [];
    let t = 100;
    const m = anthropicModel(opus, { apiKey: KEY, client: client(reply([{ type: 'text', text: 'hm' }, { type: 'tool_use', name: 'edit_world', input: { a: 1 } }], 'tool_use'), seen), now: () => (t += 50) });
    const p = await m.propose(req);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.['model'], 'claude-sonnet-5-5');
    assert.equal(seen[0]?.['max_tokens'], 1234);
    assert.deepEqual(seen[0]?.['tools'], [{ name: 'edit_world', description: 'edit', input_schema: req.tool.inputSchema }]);
    assert.deepEqual(p, {
      input: { a: 1 },
      advice: ['hm'],
      usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 4000, cacheWriteTokens: 3000, cacheWrite1hTokens: 0 },
      costUsd: 0.0303,
      costBasis: 'sdk_configured_rates',
      ms: 50,
    });
  });

  it('WG-L06 a billed reply with no tool call, a wrong tool name, or max_tokens carries usage and cost', async () => {
    const cases = [
      reply([{ type: 'text', text: 'no tool' }], 'end_turn'),
      reply([{ type: 'tool_use', name: 'other_tool', input: {} }], 'tool_use'),
      reply([{ type: 'tool_use', name: 'edit_world', input: { a: 1 } }], 'max_tokens'),
    ];
    for (const r of cases) {
      await assert.rejects(anthropicModel(opus, { apiKey: KEY, client: client(r), now: () => 0 }).propose(req), (e: unknown) =>
        e instanceof ModelError && e.costUsd === 0.0303 && e.usage?.outputTokens === 2000 && e.ms === 0);
    }
  });
});

describe('redteam llm: no network in tests', () => {
  it('WG-L07 the client and fetch seams never reach globalThis.fetch', async () => {
    const start = fetchCalls;
    await anthropicModel(opus, { apiKey: KEY, client: client(reply([{ type: 'tool_use', name: 'edit_world', input: {} }], 'tool_use')) }).propose(req);
    const seamCalls: string[] = [];
    const seam = (async (url: unknown) => {
      if (String(url).includes('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 1 }), { headers: { 'content-type': 'application/json' } });
      seamCalls.push(String(url));
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', stop_sequence: null,
        content: [{ type: 'tool_use', id: 't1', name: 'edit_world', input: { a: 2 } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const p = await anthropicModel(opus, { apiKey: KEY, fetch: seam }).propose(req);
    assert.deepEqual(p.input, { a: 2 });
    assert.deepEqual(seamCalls, ['https://api.anthropic.com/v1/messages']);
    assert.equal(fetchCalls - start, 0);
  });

  it('WG-L08 a missing key fails before any request, even with ANTHROPIC_API_KEY and LLM_KEY set', () => {
    const saved = { a: process.env['ANTHROPIC_API_KEY'], l: process.env['LLM_KEY'] };
    process.env['ANTHROPIC_API_KEY'] = KEY;
    process.env['LLM_KEY'] = KEY;
    const seen: Record<string, unknown>[] = [];
    try {
      for (const apiKey of [undefined, '', ' \t\n']) {
        assert.throws(() => anthropicModel(opus, { apiKey, client: client({}, seen) }), ModelError);
      }
    } finally {
      if (saved.a === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = saved.a;
      if (saved.l === undefined) delete process.env['LLM_KEY']; else process.env['LLM_KEY'] = saved.l;
    }
    assert.equal(seen.length, 0);
  });

  it('WG-L09 the key never appears in any ModelError message', async () => {
    const throwing = (err: unknown): MessagesClient => ({ messages: { countTokens: async () => ({ input_tokens: 1 }), create: async () => { throw err; } } });
    const errs: unknown[] = [
      Object.assign(new Error(`401 invalid x-api-key: ${KEY}`), { status: 401 }),
      new Error(`connect ECONNREFUSED (key ${KEY}${KEY})`),
      `string thrown with ${KEY}`,
    ];
    for (const err of errs) {
      await assert.rejects(anthropicModel(opus, { apiKey: KEY, client: throwing(err) }).propose(req), (e: unknown) =>
        e instanceof ModelError && !e.message.includes(KEY) && !String(e.stack).includes(KEY));
    }
  });

  it('WG-N01 no test can reach the real API', () => {
    const dir = import.meta.dirname;
    const files = [
      ...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)),
      ...readdirSync(join(dir, 'helpers')).filter((f) => f.endsWith('.ts')).map((f) => join(dir, 'helpers', f)),
      ...readdirSync(join(dir, 'redteam-wg')).filter((f) => f.endsWith('.ts')).map((f) => join(dir, 'redteam-wg', f)),
    ];
    const offences: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'anthropicModel') {
          const opts = n.arguments[1];
          const props = opts !== undefined && ts.isObjectLiteralExpression(opts)
            ? opts.properties.map((p) => (p.name !== undefined && ts.isIdentifier(p.name) ? p.name.text : '?'))
            : ['?'];
          const seamed = props.includes('client') || props.includes('fetch');
          const keyless = props.includes('apiKey') && !props.includes('?') &&
            opts !== undefined && ts.isObjectLiteralExpression(opts) &&
            opts.properties.some((p) => ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.name.getText() === 'apiKey' &&
              (p.initializer.kind === ts.SyntaxKind.UndefinedKeyword || p.initializer.getText() === 'undefined' || /^'\s*'$/.test(p.initializer.getText()))));
          if (!seamed && !keyless) offences.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} anthropicModel without client/fetch seam`);
        }
        if (ts.isPropertyAssignment(n) && n.name.getText() === 'apiKey' && /process\.env|LLM_KEY/.test(n.initializer.getText())) {
          offences.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} passes an environment key as apiKey`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      // Code that loads an env file, not prose: a test that checks the runner passes --no-env-file names dotenv in its title.
      if (/\bloadEnvFile\s*\(|from\s+['"]dotenv|require\(\s*['"]dotenv|['"]dotenv\/config['"]/.test(text) && !file.endsWith('redteam-wg-llm.test.ts')) offences.push(`${file}: loads .env`);
    }
    const pkg = JSON.parse(readFileSync(join(dir, '../package.json'), 'utf8')) as { scripts: Record<string, string> };
    if (/env-file|dotenv/.test(pkg.scripts['test'] ?? '')) offences.push('package.json test script loads an env file');
    assert.deepEqual(offences, []);
  });
});
