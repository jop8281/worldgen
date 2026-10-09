/**
 * Which settings exist and their defaults. Parsed from code/worldgen.config.json, then
 * CLI flags override. Unknown keys are errors (`.strict()`), so a typo in a stage name
 * fails at load instead of falling back to a default.
 *
 * This is the one config file (A-36). Model selection (model and effort per step, the
 * escalation model, the transport and prices) lives here too, not in a second file.
 * Settings added after the first Config literals are optional in the parsed type, and their
 * defaults are applied by the helpers below (`transportOf`, `stepModel`), so a Config written
 * by hand stays valid.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { STAGE_IDS, type StepId } from './stages.ts';

const stepBudget = z.object({
  maxAttempts: z.number().int().min(1).default(4),
  reserve: z.number().min(0).max(1).optional().describe('least share of maxMinutes kept for this step while an earlier step runs; the step always keeps its next call\'s estimate (A-311)'),
  minShareSeconds: z.number().min(0).optional().describe('the least time this step may use, even out of later steps\' reserves, capped at the time left (A-185)'),
}).strict();
const STEP_IDS: readonly StepId[] = ['plan', ...STAGE_IDS];

function perStep<T extends z.ZodType>(schema: T): z.ZodObject<{ [K in StepId]: T }, z.core.$strict> {
  return z.strictObject(Object.fromEntries(STEP_IDS.map((id) => [id, schema])) as { [K in StepId]: T });
}

const price = z.number().nonnegative();
/** USD per million tokens. Strict so a typo like `outputPerMtok` fails at load; cache prices are optional and fall back per field. */
const priceEntry = z.strictObject({
  inputPerMTok: price,
  outputPerMTok: price,
  cacheReadPerMTok: price.optional(),
  cacheWritePerMTok: price.optional(),
  cacheWrite1hPerMTok: price.optional(),
});
export type PriceEntry = z.output<typeof priceEntry>;

/** The model every step runs unless config or `--model` names another (A-283; A-66 pinned it). */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** A Claude model id: `claude-` and lowercase words joined by `-` or `.`. Nothing else reaches a transport. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
export const isClaudeModelId = (m: string): boolean => CLAUDE_MODEL_ID.test(m);
export const claudeModelId = z.string().refine(isClaudeModelId, { error: (iss) => `model "${String(iss.input)}" is not a Claude model id such as ${DEFAULT_MODEL}` });

/**
 * Prices known without config, used for a model that `prices` does not list. `prices` wins per
 * field within a model. Sonnet 5.5 lists $2 / $10, 5-minute cache writes $2.50 (1.25x), 1-hour
 * cache writes $4 (2x), cache reads $0.20 (0.1x). The claude CLI writes 1-hour entries. Opus 5.5
 * lists $4 / $20, cache writes $5, cache reads $0.20, as config held it before A-66. Any other
 * model runs only once `prices` gives it an input and an output price.
 */
export const BUILTIN_PRICES: Readonly<Record<string, PriceEntry>> = {
  [DEFAULT_MODEL]: { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheWrite1hPerMTok: 4, cacheReadPerMTok: 0.2 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 },
};

/** Whether `model` has an input and an output price, built in or from a `prices` entry that `configSchema` accepted. */
export const isPriced = (model: string, prices: Readonly<Record<string, Partial<PriceEntry>>>): boolean =>
  BUILTIN_PRICES[model] !== undefined || (prices[model]?.inputPerMTok !== undefined && prices[model]?.outputPerMTok !== undefined);

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
const effort = z.enum(EFFORTS, { error: `effort must be one of ${EFFORTS.join(', ')}` });

export const TRANSPORTS = ['claude-cli', 'sdk'] as const;
export type Transport = (typeof TRANSPORTS)[number];
/** The claude CLI under the user's logged-in session (U-11). `sdk` is opt-in and reads the key named by `apiKeyEnv`. */
export const DEFAULT_TRANSPORT: Transport = 'claude-cli';
export const DEFAULT_CLAUDE_BIN = 'claude';
export const DEFAULT_API_KEY_ENV = 'LLM_KEY';

/** Model and effort for one step. An absent field falls back to the top-level `model` and `effort`. */
const modelChoice = z.strictObject({
  model: claudeModelId.optional(),
  effort: effort.optional(),
});

const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'an environment variable name such as LLM_KEY')
  .refine((n) => !n.startsWith('ANTHROPIC_'), 'a variable other than ANTHROPIC_*: WorldGen never reads the ambient Anthropic key');

export const configSchema = z
  .strictObject({
    model: claudeModelId.describe(`default model for every step that stepModels does not set, ${DEFAULT_MODEL} in the shipped config; it needs a price, built in or in prices`),
    effort: effort.optional().describe('default effort; absent means the model default'),
    transport: z.enum(TRANSPORTS).optional().describe(`how model calls are made, default ${DEFAULT_TRANSPORT}`),
    claudeBin: z.string().min(1).optional().describe(`claude CLI binary, default "${DEFAULT_CLAUDE_BIN}" from PATH`),
    apiKeyEnv: envName.optional().describe(`environment variable the sdk transport reads the key from, default ${DEFAULT_API_KEY_ENV}`),
    maxCostUsd: z.number().positive(),
    maxMinutes: z.number().positive().default(15),
    maxBacktracks: z.number().int().min(0).default(2),
    maxOutputTokens: z.number().int().positive().default(16_000),
    steps: perStep(stepBudget.prefault({})).prefault({}),
    stepModels: perStep(modelChoice.optional()).optional().describe('model and effort per step'),
    escalate: modelChoice.optional().describe('model and effort for a step that stalls'),
    prices: z.record(z.string(), priceEntry).default({}),
    exampleWorld: z.union([z.string().min(1).transform((p) => [p]), z.array(z.string().min(1)).min(1)]).default(['../prod/worlds/helpdesk'])
      .describe('few-shot worlds, read by path; a run renders the one its input digest picks (A-390). One path, the older form, is a list of one'),
  })
  .superRefine((c, ctx) => {
    // Refused at load, before any call: a model with no price could not be metered against the caps.
    const named: [readonly PropertyKey[], string | undefined][] = [
      [['model'], c.model],
      ...STEP_IDS.map((id): [readonly PropertyKey[], string | undefined] => [['stepModels', id, 'model'], c.stepModels?.[id]?.model]),
      [['escalate', 'model'], c.escalate?.model],
    ];
    for (const [path, model] of named) {
      if (model === undefined || !isClaudeModelId(model) || isPriced(model, c.prices)) continue;
      ctx.addIssue({ code: 'custom', path: [...path], message: `model "${model}" has no known price: add prices.${model} with inputPerMTok and outputPerMTok, or use ${DEFAULT_MODEL}` });
    }
  });
export type Config = z.output<typeof configSchema>;

export function transportOf(config: Config): Transport {
  return config.transport ?? DEFAULT_TRANSPORT;
}

/** What one model call uses. `effort` undefined means the model's own default. */
export type ModelChoice = { readonly model: string; readonly effort: Effort | undefined };

/**
 * The model and effort for `step`: `stepModels[step]`, then the top-level `model` and `effort`.
 * When `escalated`, `escalate` overrides whichever of the two it sets.
 */
export function stepModel(config: Config, step: StepId, escalated: boolean): ModelChoice {
  const pinned = config.stepModels?.[step];
  const base: ModelChoice = { model: pinned?.model ?? config.model, effort: pinned?.effort ?? config.effort };
  if (!escalated || config.escalate === undefined) return base;
  return { model: config.escalate.model ?? base.model, effort: config.escalate.effort ?? base.effort };
}

/**
 * Reads `file`, applies `overrides` on top, and parses strictly. Each `exampleWorld` path from the file
 * resolves against the file's directory; an override resolves against the process cwd.
 */
export async function loadConfig(file: string, overrides: Partial<Config>): Promise<Config> {
  const abs = resolve(file);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (e) {
    throw new Error(`cannot read config ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`config ${abs} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`config ${abs} must be a JSON object`);
  }
  const fromFile = raw as Record<string, unknown>;
  if (fromFile['exampleWorld'] !== undefined) fromFile['exampleWorld'] = resolvePaths(fromFile['exampleWorld'], dirname(abs));
  const defined: Record<string, unknown> = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  if (defined['exampleWorld'] !== undefined) defined['exampleWorld'] = resolvePaths(defined['exampleWorld'], process.cwd());
  const parsed = configSchema.safeParse({ ...fromFile, ...defined });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const where = i.path.length > 0 ? i.path.join('.') : '(root)';
      const keys = i.code === 'unrecognized_keys' ? ` ${i.keys.map((k) => `"${k}"`).join(', ')}` : '';
      return `${where}: ${i.message}${keys}`;
    });
    throw new Error(`invalid config ${abs}:\n${lines.join('\n')}`);
  }
  // A schema default (key absent from file and overrides) is still relative; anchor it to the config dir.
  return { ...parsed.data, exampleWorld: parsed.data.exampleWorld.map((p) => resolve(dirname(abs), p)) };
}

/** A path, or each path of a list, resolved against `base`; an empty path or anything else is left for the schema to refuse. */
function resolvePaths(value: unknown, base: string): unknown {
  const one = (p: unknown): unknown => (typeof p === 'string' && p !== '' ? resolve(base, p) : p);
  return Array.isArray(value) ? value.map(one) : one(value);
}
