import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { configSchema, loadConfig, stepModel, transportOf } from '../src/worldgen/config.ts';

const REAL = resolve(import.meta.dirname, '../worldgen.config.json');

function tmpConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wgcfg-'));
  const f = join(dir, 'c.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

describe('loadConfig', () => {
  it('parses the shipped config with the A-48 budget of $5 and 15 minutes', async () => {
    const c = await loadConfig(REAL, {});
    assert.equal(c.model, 'claude-sonnet-5-5');
    assert.equal(c.maxCostUsd, 5);
    assert.equal(c.maxMinutes, 15);
    assert.equal(c.maxBacktracks, 2);
    assert.equal(c.maxOutputTokens, 16000);
    assert.equal(c.steps.plan.maxAttempts, 3);
    assert.equal(c.steps.workflow.maxAttempts, 5);
  });

  it('rejects an unknown step key and names it', async () => {
    const f = tmpConfig({ model: 'claude-sonnet-5-5', maxCostUsd: 1, steps: { modle: { maxAttempts: 2 } } });
    await assert.rejects(loadConfig(f, {}), /steps: .*"modle"/s);
  });

  it('rejects an unknown top-level key and names it', async () => {
    const f = tmpConfig({ model: 'claude-sonnet-5-5', maxCostUsd: 1, budget: 3 });
    await assert.rejects(loadConfig(f, {}), /"budget"/);
  });

  it('overrides win over the file', async () => {
    const c = await loadConfig(REAL, { model: 'claude-sonnet-5-5', maxCostUsd: 1.5, maxMinutes: 7 });
    assert.equal(c.model, 'claude-sonnet-5-5');
    assert.equal(c.maxCostUsd, 1.5);
    assert.equal(c.maxMinutes, 7);
    assert.equal(c.steps.tasks.maxAttempts, 5);
  });

  it('ignores undefined overrides', async () => {
    const c = await loadConfig(REAL, { model: undefined as unknown as string });
    assert.equal(c.model, 'claude-sonnet-5-5');
  });

  it('validates overrides', async () => {
    await assert.rejects(loadConfig(REAL, { maxCostUsd: -1 }), /maxCostUsd/);
  });

  it('fills defaults for omitted keys', async () => {
    const c = await loadConfig(tmpConfig({ model: 'claude-sonnet-5-5', maxCostUsd: 2 }), {});
    assert.equal(c.maxMinutes, 15);
    assert.equal(c.steps.model.maxAttempts, 4);
  });

  it('resolves the default exampleWorld against the config dir when the key is omitted', async () => {
    const f = tmpConfig({ model: 'claude-sonnet-5-5', maxCostUsd: 1 });
    const c = await loadConfig(f, {});
    assert.equal(c.exampleWorld, resolve(dirname(f), '../prod/worlds/helpdesk'));
  });

  it('errors on a missing file and on bad JSON', async () => {
    await assert.rejects(loadConfig('/nonexistent/wg.json', {}), /cannot read config/);
    const dir = mkdtempSync(join(tmpdir(), 'wgcfg-'));
    writeFileSync(join(dir, 'bad.json'), '{nope');
    await assert.rejects(loadConfig(join(dir, 'bad.json'), {}), /not valid JSON/);
  });

  it('resolves exampleWorld against the config dir, not the cwd', async () => {
    const before = process.cwd();
    process.chdir(tmpdir());
    try {
      const c = await loadConfig(REAL, {});
      assert.equal(c.exampleWorld, resolve(import.meta.dirname, '../../prod/worlds/helpdesk'));
      assert.ok(c.exampleWorld.endsWith('/prod/worlds/helpdesk'));
    } finally {
      process.chdir(before);
    }
  });
});

describe('prices schema', () => {
  const base = { model: 'claude-sonnet-5-5', maxCostUsd: 1 };
  it('accepts cache prices and keeps them', () => {
    const c = configSchema.parse({ ...base, prices: { 'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, cacheWrite1hPerMTok: 6 } } });
    assert.deepEqual(c.prices, { 'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, cacheWrite1hPerMTok: 6 } });
  });

  it('rejects a misspelt key and names it', () => {
    const r = configSchema.safeParse({ ...base, prices: { 'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMtok: 15 } } });
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error?.issues), /outputPerMtok/);
  });

  it('rejects negative prices', () => {
    for (const k of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWritePerMTok', 'cacheWrite1hPerMTok']) {
      const r = configSchema.safeParse({ ...base, prices: { 'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMTok: 15, [k]: -1 } } });
      assert.equal(r.success, false, k);
    }
  });

  it('rejects a misspelt price key through loadConfig with the key in the message', async () => {
    const f = tmpConfig({ ...base, prices: { 'claude-sonnet-5-5': { inputPerMTok: 3, outputPerMtok: 15 } } });
    await assert.rejects(loadConfig(f, {}), /outputPerMtok/);
  });
});

describe('model selection folded into worldgen.config.json', () => {
  it('ships transport, binary, key variable, per-step effort, escalation and prices in the one config file', async () => {
    const c = await loadConfig(REAL, {});
    assert.equal(c.effort, 'high');
    assert.equal(c.transport, 'claude-cli');
    assert.equal(c.claudeBin, 'claude');
    assert.equal(c.apiKeyEnv, 'LLM_KEY');
    assert.deepEqual(c.stepModels, {
      plan: { effort: 'medium' },
      model: { effort: 'high' },
      workflow: { effort: 'medium' },
      seed: { effort: 'medium' },
      tasks: { effort: 'high' },
    });
    assert.deepEqual(c.escalate, { effort: 'high' });
    assert.deepEqual(c.prices, {
      'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheWrite1hPerMTok: 4, cacheReadPerMTok: 0.2 },
    });
    assert.equal(existsSync(resolve(import.meta.dirname, '../models.json')), false);
  });

  it('gives each step of the shipped config claude-sonnet-5-5 at its effort, and the escalation effort when escalated', async () => {
    const c = await loadConfig(REAL, {});
    assert.deepEqual(stepModel(c, 'plan', false), { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(stepModel(c, 'model', false), { model: 'claude-sonnet-5-5', effort: 'high' });
    assert.deepEqual(stepModel(c, 'workflow', false), { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(stepModel(c, 'seed', false), { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(stepModel(c, 'tasks', false), { model: 'claude-sonnet-5-5', effort: 'high' });
    assert.deepEqual(stepModel(c, 'seed', true), { model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('a --model override reaches every step of the shipped config, since no step pins its model', async () => {
    const c = await loadConfig(REAL, { model: 'claude-sonnet-5-5' });
    assert.deepEqual(stepModel(c, 'workflow', false), { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(stepModel(c, 'tasks', true), { model: 'claude-sonnet-5-5', effort: 'high' });
  });

  it('picks the pinned model and effort per step from a literal config, falling back to the defaults', () => {
    const c = configSchema.parse({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      maxCostUsd: 5,
      stepModels: { seed: { model: 'claude-sonnet-5-5', effort: 'low' }, tasks: { effort: 'max' }, workflow: { model: 'claude-sonnet-5-5' } },
      escalate: { model: 'claude-sonnet-5-5', effort: 'xhigh' },
    });
    assert.deepEqual(stepModel(c, 'plan', false), { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(stepModel(c, 'model', false), { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(stepModel(c, 'workflow', false), { model: 'claude-sonnet-5-5', effort: 'medium' });
    assert.deepEqual(stepModel(c, 'seed', false), { model: 'claude-sonnet-5-5', effort: 'low' });
    assert.deepEqual(stepModel(c, 'tasks', false), { model: 'claude-sonnet-5-5', effort: 'max' });
    assert.deepEqual(stepModel(c, 'seed', true), { model: 'claude-sonnet-5-5', effort: 'xhigh' });
  });

  it('escalation keeps the step model when escalate names only an effort, and is a no-op without escalate', () => {
    const c = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1, stepModels: { seed: { model: 'claude-sonnet-5-5', effort: 'low' } }, escalate: { effort: 'high' } });
    assert.deepEqual(stepModel(c, 'seed', true), { model: 'claude-sonnet-5-5', effort: 'high' });
    const plain = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1 });
    assert.deepEqual(stepModel(plain, 'seed', true), { model: 'claude-sonnet-5-5', effort: undefined });
  });

  it('defaults the transport to the claude CLI', () => {
    assert.equal(transportOf(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1 })), 'claude-cli');
    assert.equal(transportOf(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1, transport: 'sdk' })), 'sdk');
  });

  it('rejects an unknown transport, effort, step or escalate key', () => {
    const base = { model: 'claude-sonnet-5-5', maxCostUsd: 1 };
    assert.equal(configSchema.safeParse({ ...base, transport: 'http' }).success, false);
    assert.equal(configSchema.safeParse({ ...base, effort: 'huge' }).success, false);
    assert.equal(configSchema.safeParse({ ...base, stepModels: { planner: { effort: 'low' } } }).success, false);
    assert.equal(configSchema.safeParse({ ...base, stepModels: { plan: { effort: 'low', temperature: 0 } } }).success, false);
    assert.equal(configSchema.safeParse({ ...base, escalate: { modle: 'x' } }).success, false);
  });

  it('refuses an Anthropic environment variable as the sdk key source', () => {
    const base = { model: 'claude-sonnet-5-5', maxCostUsd: 1 };
    assert.equal(configSchema.safeParse({ ...base, apiKeyEnv: 'ANTHROPIC_API_KEY' }).success, false);
    assert.equal(configSchema.safeParse({ ...base, apiKeyEnv: 'lower_case' }).success, false);
    assert.equal(configSchema.safeParse({ ...base, apiKeyEnv: 'MY_KEY' }).success, true);
  });
});

describe('a priced Claude model, Sonnet by default (A-283)', () => {
  const NOT_CLAUDE = (id: string): string => `model "${id}" is not a Claude model id such as claude-sonnet-5-5`;
  const NO_PRICE = (id: string): string => `model "${id}" has no known price: add prices.${id} with inputPerMTok and outputPerMTok, or use claude-sonnet-5-5`;
  const issues = (r: { error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }): string[][] =>
    (r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]);

  it('defaults every step to claude-sonnet-5-5 in the shipped config', async () => {
    const c = await loadConfig(REAL, {});
    assert.equal(c.model, 'claude-sonnet-5-5');
    assert.deepEqual([stepModel(c, 'plan', false).model, stepModel(c, 'tasks', false).model, stepModel(c, 'model', true).model], ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  });

  it('accepts a --model override with a built-in price, under either transport', async () => {
    for (const transport of ['claude-cli', 'sdk'] as const) {
      const c = await loadConfig(REAL, { transport, model: 'claude-opus-5-5' });
      assert.deepEqual([c.model, stepModel(c, 'seed', false).model], ['claude-opus-5-5', 'claude-opus-5-5']);
    }
  });

  it('accepts any Claude model at every position once prices lists it', () => {
    const r = configSchema.safeParse({
      model: 'claude-haiku-4-5-20251001', maxCostUsd: 1,
      stepModels: { workflow: { model: 'claude-fable-5-1' } }, escalate: { model: 'claude-opus-5-5' },
      prices: { 'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 }, 'claude-fable-5-1': { inputPerMTok: 3, outputPerMTok: 15 } },
    });
    assert.deepEqual(issues(r), []);
  });

  it('refuses an id that is not a Claude model id at its path, under both transports', () => {
    for (const transport of ['claude-cli', 'sdk'] as const) {
      assert.deepEqual(issues(configSchema.safeParse({ model: 'gpt-4o', maxCostUsd: 1, transport })), [['model', NOT_CLAUDE('gpt-4o')]]);
      assert.deepEqual(issues(configSchema.safeParse({ model: 'claude-sonnet-5-5', maxCostUsd: 1, transport, stepModels: { seed: { model: 'Claude-Opus' } } })), [['stepModels.seed.model', NOT_CLAUDE('Claude-Opus')]]);
      assert.deepEqual(issues(configSchema.safeParse({ model: 'claude-sonnet-5-5', maxCostUsd: 1, transport, escalate: { model: 'claude-opus-5-5 --fallback-model x' } })), [['escalate.model', NOT_CLAUDE('claude-opus-5-5 --fallback-model x')]]);
    }
  });

  it('refuses a Claude model with no known price at each position, even when prices lists another', () => {
    const r = configSchema.safeParse({
      model: 'claude-haiku-4-5', maxCostUsd: 1,
      stepModels: { workflow: { model: 'claude-fable-5-1' } }, escalate: { model: 'claude-mystery-9' },
      prices: { 'claude-other-1': { inputPerMTok: 1, outputPerMTok: 5 } },
    });
    assert.deepEqual(issues(r), [
      ['model', NO_PRICE('claude-haiku-4-5')], ['stepModels.workflow.model', NO_PRICE('claude-fable-5-1')], ['escalate.model', NO_PRICE('claude-mystery-9')],
    ]);
  });

  it('fails at load time when a --model override has no known price', async () => {
    await assert.rejects(
      loadConfig(REAL, { model: 'claude-haiku-4-5' }),
      (e: unknown) => e instanceof Error && e.message.includes(`\nmodel: ${NO_PRICE('claude-haiku-4-5')}`),
    );
  });

  it('rejects an unknown effort with the literal list of levels', () => {
    const r = configSchema.safeParse({ model: 'claude-sonnet-5-5', maxCostUsd: 1, effort: 'huge' });
    assert.deepEqual(r.error?.issues.map((i) => [i.path.join('.'), i.message]), [['effort', 'effort must be one of low, medium, high, xhigh, max']]);
  });
});
