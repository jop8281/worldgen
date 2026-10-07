/**
 * The dataset's one schema (YOS-91): the Episode record, the manifest, canonical JSON and hashes,
 * and secret redaction. Pure apart from node:crypto; no file IO, no engine, no model.
 *
 * An Episode is public. It holds what the solver saw and did (instruction, public requests and
 * responses, final reply), the engine's score and the state hashes. The world file, graders,
 * reference solutions, admin URLs and the engine's dumps never appear in it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PINNED_MODEL } from '../worldgen/config.ts';

export const SCHEMA_VERSION = 1;
export const MANIFEST_VERSION = 1;
/** Bump when the solver's system prompt, tool schema or history rendering changes (solver.ts). */
export const PROMPT_VERSION = 'solver-prompt-1';
export const PROVIDER = 'anthropic';
export const REDACTED = '[redacted]';
export const GRADING_NOTE =
  'The engine score certifies the final world state only. It does not independently certify that the final reply is factually correct.';

/** A dataset failure the caller can act on: corrupt log, conflicting duplicate, bad checksum. */
export class DatasetError extends Error {
  override readonly name = 'DatasetError';
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON and hashes

function canonical(v: unknown, depth: number): string {
  if (depth > 200) throw new DatasetError('value is nested too deeply to hash');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new DatasetError(`cannot hash the non-finite number ${String(v)}`);
    return JSON.stringify(v);
  }
  if (typeof v === 'object') {
    if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x, depth + 1)).join(',')}]`;
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new DatasetError('cannot hash a value that is not plain JSON data');
    const entries = Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x, depth + 1)}`).join(',')}}`;
  }
  throw new DatasetError(`cannot hash a ${typeof v}`);
}

/** JSON with every object's keys in code-unit order and no whitespace. The same data always gives the same text. */
export const canonicalJson = (v: unknown): string => canonical(v, 0);

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** The hash of an engine state dump (`GET /_world/state`, `Runtime.dump()`): sha256 of its canonical JSON. */
export const hashState = (dump: unknown): string => sha256Hex(canonicalJson(dump));

export type RunConfig = { readonly maxTurns: number; readonly budgetUsd: number; readonly maxMinutes: number };

/** `cfg-<12 hex>` of the run limits, so episodes made under different limits are told apart. */
export const configVersion = (c: RunConfig): string =>
  `cfg-${sha256Hex(canonicalJson({ max_turns: c.maxTurns, budget_usd: c.budgetUsd, max_minutes: c.maxMinutes })).slice(0, 12)}`;

// ---------------------------------------------------------------------------------------------
// Redaction

export type Redactor = {
  readonly active: boolean;
  /** `s` with every secret replaced by `[redacted]`. */
  text(s: string): string;
  /** `v` with every string and object key redacted. */
  deep<T>(v: T): T;
  /** Throws a DatasetError naming `what` when `text` still holds a secret, plain or JSON-escaped. */
  assertClean(what: string, text: string): void;
};

/** Secrets are values the caller read from its environment and passes in: API keys, the sandbox URL. Blank ones are ignored. */
export function redactor(secrets: readonly string[]): Redactor {
  const list = [...new Set(secrets.filter((s) => s.trim() !== ''))].sort((a, b) => b.length - a.length);
  const escaped = list.map((s) => JSON.stringify(s).slice(1, -1)).filter((e, i) => e !== list[i]);
  const text = (s: string): string => list.reduce((acc, secret) => acc.split(secret).join(REDACTED), s);
  const deep = <T>(v: T, depth = 0): T => {
    if (depth > 200) throw new DatasetError('value is nested too deeply to redact');
    if (typeof v === 'string') return text(v) as T;
    if (Array.isArray(v)) return v.map((x) => deep(x, depth + 1)) as T;
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), deep(x, depth + 1)])) as T;
    }
    return v;
  };
  return {
    active: list.length > 0,
    text,
    deep: (v) => deep(v),
    assertClean(what, body) {
      if (list.some((s) => body.includes(s)) || escaped.some((s) => body.includes(s))) {
        throw new DatasetError(`${what} holds a supplied secret; refusing to keep it`);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Episode record

export const STOP_REASONS = ['done', 'turn_limit', 'budget_limit', 'time_limit', 'model_error', 'world_error', 'grade_error', 'interrupted'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

const sha = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex sha-256');
const nat = z.number().int().nonnegative();

/** No `__` and no final `_`, so an episode id `<run>__<task>__<n>` splits one way only (A-242). */
export const RUN_ID = /^(?!.*__)(?!.*_$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Engine Names, as `routeKey`/`Name` accept them: letters, digits, `_` and `-`, here without `__`. */
export const TASK_ID = /^(?!.*__)[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const episodeId = (runId: string, taskId: string, index = 1): string => `${runId}__${taskId}__${index}`;

const requestSchema = z.strictObject({
  method: z.string(),
  path: z.string(),
  query: z.record(z.string(), z.string()),
  body: z.json().optional(),
});
export type PublicRequest = z.output<typeof requestSchema>;

const instructionMsg = z.strictObject({ seq: nat, role: z.literal('user'), type: z.literal('instruction'), text: z.string() });
const toolCallMsg = z.strictObject({
  seq: nat, role: z.literal('assistant'), type: z.literal('tool_call'), call_id: z.string().min(1), request: requestSchema, commentary: z.string(),
});
const toolResultMsg = z.strictObject({
  seq: nat,
  role: z.literal('tool'),
  type: z.literal('tool_result'),
  call_id: z.string().min(1),
  /** `response`: the world answered. `rejected`: the controller refused the request before sending it. `error`: it could not be sent or read. */
  outcome: z.enum(['response', 'rejected', 'error']),
  status: z.number().int().nullable(),
  body: z.json(),
  truncated: z.boolean(),
  detail: z.string().nullable(),
});
const finalReplyMsg = z.strictObject({ seq: nat, role: z.literal('assistant'), type: z.literal('final_reply'), text: z.string(), commentary: z.string() });
const messageSchema = z.discriminatedUnion('type', [instructionMsg, toolCallMsg, toolResultMsg, finalReplyMsg]);
export type PublicMessage = z.output<typeof messageSchema>;

const usageSchema = z.strictObject({
  model_calls: nat,
  /** Calls cancelled or lost before the API reported usage, so their cost is unknown, not zero. */
  unaccounted_calls: nat,
  input_tokens: nat,
  output_tokens: nat,
  cache_read_tokens: nat,
  cache_write_tokens: nat,
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().nonnegative(),
});
export type EpisodeUsage = z.output<typeof usageSchema>;

/** Messages must be numbered 0.., open with the instruction, pair every tool call with its result, and end at most once with the final reply. */
function checkMessages(messages: readonly PublicMessage[], ctx: z.RefinementCtx): void {
  const bad = (message: string): void => void ctx.addIssue({ code: 'custom', path: ['messages'], message });
  const first = messages[0];
  if (first === undefined || first.type !== 'instruction') bad('the first message must be the instruction');
  const seen = new Set<string>();
  let open: string | null = null;
  messages.forEach((m, i) => {
    if (m.seq !== i) bad(`message ${i} has seq ${m.seq}`);
    if (m.type === 'instruction' && i > 0) bad(`message ${i} is a second instruction`);
    if (m.type === 'tool_call') {
      if (open !== null) bad(`tool call ${m.call_id} starts before ${open} has a result`);
      if (seen.has(m.call_id)) bad(`duplicate tool call id ${m.call_id}`);
      seen.add(m.call_id);
      open = m.call_id;
    } else if (m.type === 'tool_result') {
      if (open !== m.call_id) bad(`tool result ${m.call_id} does not follow its call`);
      open = null;
    } else if (open !== null) {
      bad(`${open} has no result before message ${i}`);
    }
    if (m.type === 'final_reply' && i !== messages.length - 1) bad('the final reply must be the last message');
  });
  if (open !== null) bad(`tool call ${open} has no result`);
}

const episodeBase = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  episode_id: z.string().min(1),
  run_id: z.string().regex(RUN_ID),
  world_id: z.string().min(1),
  /** sha-256 of the frozen world.yaml. */
  world_version: sha,
  engine_commit: z.string().regex(/^[0-9a-f]{7,64}$/),
  task_id: z.string().regex(TASK_ID),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  provider: z.literal(PROVIDER),
  model: z.literal(PINNED_MODEL),
  prompt_version: z.string().min(1),
  config_version: z.string().min(1),
  initial_state_hash: sha.nullable(),
  final_state_hash: sha.nullable(),
  messages: z.array(messageSchema).min(1),
  /** The model's reply exactly as returned, or null when it never finished. */
  final_reply: z.string().nullable(),
  /** The engine's score for the end state, never the model's. Null when grading did not happen. */
  score: z.number().min(0).max(1).nullable(),
  score_scope: z.literal('engine_state_only'),
  stop_reason: z.enum(STOP_REASONS),
  /** A public, redacted explanation of a non-done stop. */
  error: z.string().nullable(),
  usage: usageSchema,
});

export const episodeSchema = episodeBase.superRefine((ep, ctx) => {
  checkMessages(ep.messages, ctx);
  const add = (path: string, message: string): void => void ctx.addIssue({ code: 'custom', path: [path], message });
  const last = ep.messages[ep.messages.length - 1];
  const reply = last?.type === 'final_reply' ? last.text : null;
  if (ep.final_reply !== reply) add('final_reply', 'must equal the final_reply message text, or be null when there is none');
  if (!ep.episode_id.startsWith(`${ep.run_id}__${ep.task_id}__`) || !/^\d+$/.test(ep.episode_id.slice(`${ep.run_id}__${ep.task_id}__`.length))) {
    add('episode_id', `must be ${ep.run_id}__${ep.task_id}__<n>`);
  }
  if (ep.stop_reason === 'done' && ep.final_reply === null) add('stop_reason', 'done needs a final reply');
  if (ep.stop_reason !== 'done' && ep.error === null) add('error', 'a stop other than done needs an error');
});
export type Episode = z.output<typeof episodeSchema>;

/** The rule for dataset.jsonl: stopped by finishing, engine score exactly 1, a non-blank reply, both hashes, and real, accounted spend. */
export function isCompleteSuccess(ep: Episode): boolean {
  return (
    ep.stop_reason === 'done' &&
    ep.score === 1 &&
    ep.final_reply !== null && ep.final_reply.trim() !== '' &&
    ep.error === null &&
    ep.initial_state_hash !== null && ep.final_state_hash !== null &&
    ep.usage.model_calls >= 1 && ep.usage.unaccounted_calls === 0 && ep.usage.cost_usd > 0
  );
}

const describeIssue = (e: z.ZodError): string => {
  const i = e.issues[0];
  return i === undefined ? 'invalid' : `${i.path.join('.') || '(record)'}: ${i.message}`;
};

/** Parses an untrusted record, or throws a DatasetError naming `where` and the first problem. */
export function parseEpisode(raw: unknown, where: string): Episode {
  const r = episodeSchema.safeParse(raw);
  if (!r.success) throw new DatasetError(`${where}: not a valid episode record: ${describeIssue(r.error)}`);
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// Manifest

const fileEntry = z.strictObject({ path: z.string(), records: nat, bytes: nat, sha256: sha });
export const manifestSchema = z.strictObject({
  manifest_version: z.literal(MANIFEST_VERSION),
  schema_version: z.literal(SCHEMA_VERSION),
  provider: z.literal(PROVIDER),
  model: z.literal(PINNED_MODEL),
  prompt_versions: z.array(z.string()),
  config_versions: z.array(z.string()),
  engine_commits: z.array(z.string()),
  run_ids: z.array(z.string()),
  /** The filters the export was made with, or null for every saved episode. */
  selection: z.strictObject({ run_ids: z.array(z.string()), task_ids: z.array(z.string()), episode_ids: z.array(z.string()) }).nullable(),
  /** The frozen world each episode ran against, as a path under the dataset directory and its hash. The file is private and is not part of the export. */
  worlds: z.array(z.strictObject({ world_id: z.string(), world_version: sha, artifact: z.strictObject({ path: z.string(), sha256: sha }) })),
  counts: z.strictObject({ episodes: nat, accepted: nat, failed: nat, by_stop_reason: z.record(z.string(), nat) }),
  files: z.strictObject({ dataset: fileEntry, failures: fileEntry }),
  grading_note: z.literal(GRADING_NOTE),
});
export type Manifest = z.output<typeof manifestSchema>;

export function parseManifest(raw: unknown, where: string): Manifest {
  const r = manifestSchema.safeParse(raw);
  if (!r.success) throw new DatasetError(`${where}: not a valid manifest: ${describeIssue(r.error)}`);
  return r.data;
}
