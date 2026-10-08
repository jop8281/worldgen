/**
 * Talking to the model. The only importer of @anthropic-ai/sdk and the only place the claude
 * CLI is spawned. Only run.ts and cli/ may import this file (architecture test), so judge.ts,
 * stages.ts, policy.ts and report.ts cannot ask a model anything.
 *
 * Two transports implement Model: `claudeCliModel` (the default, U-11: `claude -p` under the
 * user's logged-in session, no key read) and `anthropicModel` (opt-in, needs the key passed in).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { SpendEvent } from '../costs/ledger.ts';
import type { CostBasis } from '../costs/basis.ts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_PRICES, DEFAULT_CLAUDE_BIN, EFFORTS, isClaudeModelId, type Config, type Effort } from './config.ts';

export type ProposeRequest = {
  readonly system: string;
  readonly prompt: string;
  /** The tool the model is told to call (tool_choice auto: forcing is rejected by the default model). Its input schema comes from editJsonSchema or planSchema, never written by hand. */
  readonly tool: { readonly name: string; readonly description: string; readonly inputSchema: object };
  /** The model for this call (config `stepModels`). Absent means `config.model`. */
  readonly model?: string | undefined;
  /** The effort for this call. Absent means the model's own default. */
  readonly effort?: Effort | undefined;
  /** Hard limit for this call in ms: the step's share of the run's time left, ending at least 15 s before the run deadline. Absent means `maxMinutes`. */
  readonly timeoutMs?: number | undefined;
  /** Remaining client-estimate budget. CLI enforces the tighter request/config budget; not an invoice bound. */
  readonly maxCostUsd?: number | undefined;
  /** Cancels the pending model request. An interrupted call may still have unknown provider cost. */
  readonly signal?: AbortSignal | undefined;
  /** The run and step this call belongs to, for its spend-ledger lines (`costs --by run`). Transports ignore them. */
  readonly runId?: string | undefined;
  readonly step?: string | undefined;
};
export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** Optional so callers built before cache writes were tracked still typecheck. propose always fills it. */
  readonly cacheWriteTokens?: number | undefined;
  /** The part of cacheWriteTokens written to the 1-hour cache, which the claude CLI uses. propose always fills it. */
  readonly cacheWrite1hTokens?: number | undefined;
};
/**
 * `input` is untrusted. The caller parses it at its boundary (applyEdit, planSchema).
 * `advice` is the model's text outside the tool call. It is commentary, never parsed.
 */
export type Proposal = {
  readonly input: unknown;
  readonly advice: readonly string[];
  readonly usage: Usage;
  readonly costUsd: number;
  readonly costBasis?: CostBasis;
  readonly ms: number;
};

/** Implementations: the claude CLI, Anthropic, and the scripted fake in test/worldgen.test.ts. */
export interface Model {
  propose(req: ProposeRequest): Promise<Proposal>;
}

/** USD per million tokens. Cache prices default to Anthropic's ratios: 5-minute write 1.25x input, 1-hour write 2x input, read 0.1x input. */
export type ModelPrice = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheWritePerMTok?: number | undefined;
  readonly cacheWrite1hPerMTok?: number | undefined;
  readonly cacheReadPerMTok?: number | undefined;
};
export type Prices = Readonly<Record<string, ModelPrice>>;

/**
 * Built-in prices, used for models that config.prices does not list (config.ts BUILTIN_PRICES,
 * which config validation also reads). config.prices wins per field within a model.
 * Opus 5.5 lists $4 / $20, cache writes $5 (1.25x), cache reads $0.20 (0.05x), so its cache prices are explicit.
 */
export const DEFAULT_PRICES: Prices = BUILTIN_PRICES;

/** Built-in prices merged per field with config.prices. */
function pricesOf(config: Config): Prices {
  const prices: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  for (const [model, entry] of Object.entries(config.prices)) {
    const given = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
    prices[model] = { ...DEFAULT_PRICES[model], ...given } as ModelPrice;
  }
  return prices;
}

/** A failed model call. `status` is the HTTP status when the API answered. Mirrors RunEvent's `model_error`. */
type BilledFailure = { readonly usage: Usage; readonly costUsd: number; readonly ms: number; readonly costBasis?: CostBasis };
type FailureBilling = { readonly kind: 'not_started' } | { readonly kind: 'unknown'; readonly partialModelUsage?: SpendEvent['partialModelUsage'] } | ({ readonly kind: 'billed' } & BilledFailure);
const notStartedFailureSchema = z.object({ billing: z.object({ kind: z.literal('not_started') }) });
const cliBillingUsageSchema = z.object({
  input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative(),
  cache_read_input_tokens: z.int().nonnegative().optional(), cache_creation_input_tokens: z.int().nonnegative().optional(),
});

export class ModelError extends Error {
  readonly kind = 'model_error' as const;
  readonly status: number | undefined;
  readonly billing: FailureBilling;
  get partialModelUsage(): SpendEvent['partialModelUsage'] { return this.billing.kind === 'unknown' ? this.billing.partialModelUsage : undefined; }
  get usage(): Usage | undefined { return this.billing.kind === 'billed' ? this.billing.usage : undefined; }
  get costUsd(): number | undefined { return this.billing.kind === 'billed' ? this.billing.costUsd : undefined; }
  get costBasis(): CostBasis | undefined { return this.billing.kind === 'billed' ? this.billing.costBasis : undefined; }
  get ms(): number | undefined { return this.billing.kind === 'billed' ? this.billing.ms : undefined; }
  constructor(message: string, status?: number, outcome?: BilledFailure | Exclude<FailureBilling, { readonly kind: 'billed' }>) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.billing = outcome === undefined ? { kind: 'unknown' } : 'kind' in outcome ? outcome : { kind: 'billed', ...outcome };
  }
}

export type CallProgress = {
  readonly messages: number;
  readonly schemaRetries: number;
  readonly usage: Usage;
  readonly outputBytes: number;
};

const EMPTY_PROGRESS: CallProgress = { messages: 0, schemaRetries: 0, outputBytes: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };

const spentAny = (u: Usage): boolean => u.inputTokens + u.outputTokens + u.cacheReadTokens + (u.cacheWriteTokens ?? 0) > 0;
/** A message whose thinking stays under the CLI's estimate frames reports 0 output tokens while its answer streams. */
const wrote = (p: CallProgress): boolean => p.usage.outputTokens > 0 || p.outputBytes > 0;
const retries = (n: number): string => `${n} schema ${n === 1 ? 'retry' : 'retries'}`;
const progressText = (p: CallProgress): string =>
  `${p.messages} ${p.messages === 1 ? 'message' : 'messages'}, ${p.usage.outputTokens}+ output tokens, ${retries(p.schemaRetries)}, ${p.outputBytes} answer bytes`;

/**
 * A call the transport ended itself because the step's time share (`timeoutMs`) ran out. A time stop, not a failed
 * model call: run.ts records a `share_expired` attempt, and policy stops with stage_time_exhausted. Partial stream usage is
 * retained as observed evidence; final billing remains unknown without a terminal receipt.
 */
export class StepShareExpired extends Error {
  readonly billing = { kind: 'unknown' } as const;
  readonly kind = 'share_expired' as const;
  readonly shareMs: number;
  readonly ms: number;
  readonly progress: CallProgress;
  /** Partial observed usage; absence does not prove the call was free. */
  readonly usage: Usage | undefined;
  readonly costUsd: number | undefined;
  constructor(shareMs: number, ms: number, progress: CallProgress = EMPTY_PROGRESS, costUsd = 0) {
    super(wrote(progress)
      ? `claude -p was stopped after its ${shareMs} ms step share while still writing: ${progressText(progress)}`
      : `claude -p was stopped after its ${shareMs} ms step share and had sent nothing`);
    this.name = 'StepShareExpired';
    this.shareMs = shareMs;
    this.ms = ms;
    this.progress = progress;
    this.usage = spentAny(progress.usage) ? progress.usage : undefined;
    this.costUsd = spentAny(progress.usage) ? costUsd : undefined;
  }
}

/**
 * A call the transport ended because the CLI sent nothing on stdout for `idleMs`. The transport failed, not the model:
 * run.ts records a `stalled` attempt. Its partial stream usage is observed evidence; final billing remains unknown.
 */
export class CallStalled extends Error {
  readonly billing = { kind: 'unknown' } as const;
  readonly kind = 'stalled' as const;
  readonly idleMs: number;
  readonly ms: number;
  readonly progress: CallProgress;
  readonly usage: Usage | undefined;
  readonly costUsd: number | undefined;
  constructor(idleMs: number, ms: number, progress: CallProgress = EMPTY_PROGRESS, costUsd = 0) {
    super(wrote(progress)
      ? `claude -p went silent for ${idleMs} ms after streaming ${progressText(progress)}, and was stopped as stalled`
      : `claude -p sent nothing for ${idleMs} ms and was stopped as stalled`);
    this.name = 'CallStalled';
    this.idleMs = idleMs;
    this.ms = ms;
    this.progress = progress;
    this.usage = spentAny(progress.usage) ? progress.usage : undefined;
    this.costUsd = spentAny(progress.usage) ? costUsd : undefined;
  }
}

/**
 * Estimates a call at configured prices using four characters per input token and a full
 * `maxOutputTokens` reply. This is not a billing bound. 0 means the model has no configured price.
 */
export function estimateCallUsd(config: Config, model: string, promptChars: number): number {
  const prices = pricesOf(config);
  if (prices[model] === undefined) return 0;
  return costOf({ inputTokens: Math.ceil(promptChars / 4), outputTokens: config.maxOutputTokens, cacheReadTokens: 0 }, model, prices);
}

/**
 * Throws before any request unless `model` is a Claude model id with a known price and `effort` a known level
 * (A-283). Covers a hand-built Config or ProposeRequest that skipped parsing. The named model is the one called:
 * no transport substitutes another when it fails.
 */
function requireAllowed(model: string, effort: Effort | undefined, prices: Prices): void {
  if (!isClaudeModelId(model)) throw new ModelError(`model "${model}" is not allowed: use a Claude model id such as claude-sonnet-5-5`, undefined, { kind: 'not_started' });
  if (prices[model] === undefined) throw new ModelError(`model "${model}" has no known price: add it to prices in worldgen.config.json`, undefined, { kind: 'not_started' });
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new ModelError(`effort "${String(effort)}" is not allowed: use one of ${EFFORTS.join(', ')}`, undefined, { kind: 'not_started' });
}

/** Configured-price USD estimate, rounded to a billionth of a dollar. Throws when `model` has no price. */
export function costOf(usage: Usage, model: string, prices: Prices): number {
  const p = prices[model];
  if (p === undefined) throw new ModelError(`no price for model "${model}" in config.prices`);
  const cacheWrite = p.cacheWritePerMTok ?? p.inputPerMTok * 1.25;
  const cacheWrite1h = p.cacheWrite1hPerMTok ?? p.inputPerMTok * 2;
  const cacheRead = p.cacheReadPerMTok ?? p.inputPerMTok * 0.1;
  const written1h = usage.cacheWrite1hTokens ?? 0;
  const usd =
    (usage.inputTokens * p.inputPerMTok +
      usage.outputTokens * p.outputPerMTok +
      ((usage.cacheWriteTokens ?? 0) - written1h) * cacheWrite +
      written1h * cacheWrite1h +
      usage.cacheReadTokens * cacheRead) /
    1_000_000;
  return Math.round(usd * 1e9) / 1e9;
}

type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly name: string; readonly input: unknown }
  | { readonly type: string };
type ApiResponse = {
  readonly content: readonly ContentBlock[];
  readonly stop_reason?: string | null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation?: { readonly ephemeral_1h_input_tokens?: number | null } | null;
  };
};
/** The slice of the SDK client that propose uses. Tests inject a fake with this shape. */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>, options?: { readonly timeout?: number; readonly signal?: AbortSignal }): Promise<ApiResponse>;
    countTokens?(params: Record<string, unknown>, options?: { readonly timeout?: number; readonly signal?: AbortSignal }): Promise<{ readonly input_tokens: number }>;
  };
}
export type AnthropicOptions = {
  /** The value of LLM_KEY. Callers pass it in; this module never reads the environment. */
  readonly apiKey: string | undefined;
  /** Test seam. When given, no SDK client is built and no network is touched. */
  readonly client?: MessagesClient;
  /** Test seam below the SDK: replaces the HTTP transport, so the real client, URL and auth headers are exercised. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
};

/** Pinned so a stray ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN in the environment cannot redirect LLM_KEY. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export function anthropicModel(config: Config, opts: AnthropicOptions): Model {
  const { apiKey } = opts;
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ModelError('LLM_KEY is not set: put it in ../.env or export it, then pass it as { apiKey }', undefined, { kind: 'not_started' });
  }
  // Merge per field: a config entry that omits cache prices keeps the built-in ones for that model.
  const prices = pricesOf(config);
  const client: MessagesClient =
    opts.client ??
    (new Anthropic({
      apiKey,
      baseURL: ANTHROPIC_BASE_URL,
      authToken: null,
      maxRetries: 0,
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    }) as unknown as MessagesClient);
  const now = opts.now ?? Date.now;
  const scrub = (s: string): string => s.split(apiKey).join('[redacted]');

  return {
    async propose(req) {
      const model = req.model ?? config.model;
      requireAllowed(model, req.effort, prices);
      if (req.signal?.aborted) throw new ModelError('model request aborted before starting', undefined, { kind: 'not_started' });
      const started = now();
      const params = {
        model,
        max_tokens: config.maxOutputTokens,
        system: `${req.system}\n\nRespond by calling the tool "${req.tool.name}" exactly once with your answer as its input.`,
        messages: [{ role: 'user', content: req.prompt }],
        tools: [{ name: req.tool.name, description: req.tool.description, input_schema: req.tool.inputSchema }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        ...(req.effort === undefined ? {} : { output_config: { effort: req.effort } }),
      };
      const timeoutMs = req.timeoutMs ?? config.maxMinutes * 60_000;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let signal = req.signal;
      try {
        const budget = Math.min(config.maxCostUsd, req.maxCostUsd ?? config.maxCostUsd);
        if (!Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0 || (req.maxCostUsd !== undefined && (!Number.isFinite(req.maxCostUsd) || req.maxCostUsd <= 0)) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('model cost and time budgets must be positive and finite');
        const price = prices[model];
        if (price === undefined || !Number.isFinite(price.inputPerMTok) || !Number.isFinite(price.outputPerMTok) || price.inputPerMTok < 0 || price.outputPerMTok < 0) throw new Error('model pricing must be known and finite before SDK admission');
        if (client.messages.countTokens === undefined) throw new Error('SDK token counting is required before paid message creation');
        const cancel = new AbortController();
        deadline = setTimeout(() => cancel.abort(new Error('model request deadline exceeded')), timeoutMs);
        signal = req.signal === undefined ? cancel.signal : AbortSignal.any([req.signal, cancel.signal]);
        const { max_tokens: _, output_config: _effort, ...countParams } = params;
        const counted = await client.messages.countTokens(countParams, { timeout: timeoutMs, signal });
        if (!Number.isSafeInteger(counted.input_tokens) || counted.input_tokens < 0) throw new Error('SDK token counting returned invalid input usage');
        const inputUsd = counted.input_tokens * price.inputPerMTok / 1e6;
        const outputTokens = price.outputPerMTok === 0 ? config.maxOutputTokens : Math.floor((budget - inputUsd) * 1e6 / price.outputPerMTok);
        if (inputUsd > budget || outputTokens < 1) throw new Error('counted input and one output token do not fit the model estimate budget');
        params.max_tokens = Math.min(config.maxOutputTokens, outputTokens);
        signal.throwIfAborted();
      } catch (error) {
        clearTimeout(deadline);
        throw new ModelError(scrub(`SDK admission refused: ${error instanceof Error ? error.message : String(error)}`), undefined, { kind: 'not_started' });
      }
      let res: ApiResponse;
      try {
        res = await client.messages.create(params, {
          timeout: timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (e) {
        clearTimeout(deadline);
        const status = typeof (e as { status?: unknown } | null)?.status === 'number' ? (e as { status: number }).status : undefined;
        const msg = e instanceof Error ? e.message : String(e);
        throw new ModelError(scrub(`Anthropic API error${status === undefined ? '' : ` ${status}`}: ${msg}`), status);
      }
      clearTimeout(deadline);
      const ms = now() - started;
      const usage: Usage = {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        cacheWrite1hTokens: res.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      };
      const advice = res.content.flatMap((b) => (b.type === 'text' ? [(b as { text: string }).text] : []));
      const calls = res.content.filter((b): b is { type: 'tool_use'; name: string; input: unknown } =>
        b.type === 'tool_use' && (b as { name?: unknown }).name === req.tool.name);
      const [call] = calls;
      const costUsd = costOf(usage, model, prices);
      const costBasis: CostBasis = 'sdk_configured_rates';
      const billed = { usage, costUsd, ms, costBasis };
      if (call === undefined) {
        throw new ModelError(`model did not call tool "${req.tool.name}" (stop_reason: ${res.stop_reason ?? 'none'})`, undefined, billed);
      }
      if (calls.length > 1) {
        throw new ModelError(`model called tool "${req.tool.name}" ${calls.length} times, expected exactly one`, undefined, billed);
      }
      if (res.stop_reason === 'max_tokens') {
        throw new ModelError(`model output hit max_tokens (${params.max_tokens}) before the tool call finished`, undefined, billed);
      }
      return { input: call.input, advice, usage, costUsd, ms, costBasis };
    },
  };
}

/** `timeoutMs`: the call's whole step share. `idleMs`: the longest the CLI may go without writing to stdout. */
export type SpawnLimits = { readonly timeoutMs: number; readonly idleMs: number; readonly signal?: AbortSignal };
/**
 * What one run of the claude CLI produced. `code` is null when a signal ended the process. `killed` says why this side
 * ended it, null when it did not: `share` when `timeoutMs` ran out, `stall` when stdout was silent for `idleMs`,
 * `answered` when it printed its result line and then did not exit. The exit code alone cannot say who killed it.
 */
export type SpawnResult = { readonly code: number | null; readonly signal: string | null; readonly killed: null | 'share' | 'stall' | 'answered' | 'aborted'; readonly stdout: string; readonly stderr: string };
/**
 * Runs `bin` with `args` (no shell), writes `stdin` and closes it, and stops it at `limits`. Resolves with whatever
 * the process printed; rejects only when it cannot start. Tests inject a fake with this shape, so `npm test` never
 * runs the real CLI.
 */
export type SpawnClaude = (bin: string, args: readonly string[], stdin: string, limits: SpawnLimits) => Promise<SpawnResult>;

/** Measured on a plan-sized sonnet call with stream-json: first line at 1.0 s, longest gap between lines 7.3 s over 25.6 s (A-123). */
export const STALL_MS = 120_000;
/** How long a child may ignore SIGTERM before SIGKILL, and how long it may linger after its result line. */
export const KILL_GRACE_MS = 5_000;

/**
 * Linux's MAX_ARG_STRLEN: the most bytes one argv string may hold, its NUL included. macOS has no such cap, so a longer
 * argument fails only on Linux, as `spawn E2BIG`. The system prompt is larger, so it goes in a file (A-378).
 */
export const MAX_ARG_BYTES = 131_072;

/** Longest stderr kept from one run, and the longest tail quoted in an error. */
const STDERR_KEEP = 64_000;
const TAIL = 500;
const PIPE_GRACE_MS = 500;

/** Every claude child spawnClaude started that has not exited, so a CLI's signal handler can stop them (stopLiveClaudes). */
const LIVE = new Set<ChildProcess>();

/**
 * SIGTERM every live claude child, SIGKILL whichever is still running after `graceMs`, and resolve with how many there
 * were. A CLI calls it before it exits on a signal of its own: a child is not in a process group the caller can kill
 * safely, so without this it outlives its parent.
 */
export async function stopLiveClaudes(graceMs = KILL_GRACE_MS): Promise<number> {
  const children = [...LIVE];
  for (const c of children) c.kill('SIGTERM');
  await Promise.all(children.map((c) => new Promise<void>((done) => {
    if (c.exitCode !== null || c.signalCode !== null) return done();
    const t = setTimeout(() => {
      c.kill('SIGKILL');
      done();
    }, graceMs);
    c.once('exit', () => {
      clearTimeout(t);
      done();
    });
  })));
  return children.length;
}

/**
 * The real spawn. It runs from the OS temp dir, so the CLI does not pick up project settings,
 * .mcp.json or CLAUDE.md from the repo it was started in. The environment is inherited, since
 * the CLI's login lives there; nothing here reads or adds a key.
 */
export function spawnClaude(bin: string, args: readonly string[], stdin: string, limits: SpawnLimits, killGraceMs = KILL_GRACE_MS): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    limits.signal?.throwIfAborted();
    const child = spawn(bin, [...args], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    LIVE.add(child);
    let started = false;
    child.once('spawn', () => { started = true; });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exited = false;
    let killed: SpawnResult['killed'] = null;
    let answered = false;
    let partialLine = '';
    const timers = new Set<NodeJS.Timeout>();
    const after = (ms: number, f: () => void): NodeJS.Timeout => {
      const t = setTimeout(() => {
        timers.delete(t);
        f();
      }, ms);
      timers.add(t);
      return t;
    };
    const cancel = (t: NodeJS.Timeout): void => {
      clearTimeout(t);
      timers.delete(t);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolvePromise({ code, signal, killed, stdout, stderr });
    };
    const kill = (why: NonNullable<SpawnResult['killed']>): void => {
      if (killed !== null || exited) return;
      killed = why;
      cancel(share);
      cancel(idle);
      child.kill('SIGTERM');
      after(why === 'aborted' ? 1000 : killGraceMs, () => child.kill('SIGKILL'));
    };
    const share = after(limits.timeoutMs, () => kill('share'));
    let idle = after(limits.idleMs, () => kill('stall'));
    const abort = (): void => kill('aborted');
    const cleanup = (): void => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      limits.signal?.removeEventListener('abort', abort);
    };
    limits.signal?.addEventListener('abort', abort, { once: true });
    if (limits.signal?.aborted) abort();
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (killed !== null || exited || answered) return;
      cancel(idle);
      const lines = (partialLine + d).split('\n');
      partialLine = lines.pop() ?? '';
      if (lines.some((l) => resultOf(l) !== undefined)) {
        answered = true;
        cancel(share);
        after(killGraceMs, () => kill('answered'));
        return;
      }
      idle = after(limits.idleMs, () => kill('stall'));
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr = (stderr + d).slice(-STDERR_KEEP);
    });
    child.on('error', (e) => {
      LIVE.delete(child);
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(e, { billing: { kind: started ? 'unknown' : 'not_started' } }));
    });
    // A grandchild can hold the pipes open after the CLI has actually exited.
    child.on('exit', (code, signal) => {
      LIVE.delete(child);
      exited = true;
      cancel(share);
      cancel(idle);
      after(PIPE_GRACE_MS, () => finish(code, signal));
    });
    child.on('close', (code, signal) => finish(code, signal));
    // A CLI that exits before reading stdin raises EPIPE here; its exit status and stderr already say why.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}
spawnClaude satisfies SpawnClaude;

/**
 * The CLI arguments for one call. The prompt is not among them: it goes on stdin. The system prompt is not either: it is
 * read from `systemFile`, since it is over the MAX_ARG_BYTES Linux allows one argument (A-378).
 * `--output-format stream-json` with `--verbose --include-partial-messages` prints a line every few seconds even while
 * the model thinks, so a silent stdout means a stalled call; its last line is the same result object `json` printed.
 * `--json-schema` makes the reply a `structured_output` validated against the tool's input schema,
 * `--system-prompt-file` replaces Claude Code's own prompt, and `--tools ""`, `--safe-mode`,
 * `--strict-mcp-config` and `--disable-slash-commands` leave the model no tools, MCP servers,
 * skills, hooks or CLAUDE.md. `--bare` is not used: it ignores the logged-in session.
 */
export function claudeArgs(model: string, req: ProposeRequest, systemFile: string): string[] {
  if (req.maxCostUsd !== undefined && (!Number.isFinite(req.maxCostUsd) || req.maxCostUsd <= 0)) throw new ModelError('model cost budget must be a positive finite number of USD', undefined, { kind: 'not_started' });
  // The CLI's validator has no draft 2020-12 meta-schema, and z.toJSONSchema always declares it.
  const { $schema: _, ...schema }: { $schema?: unknown } = req.tool.inputSchema;
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model,
    ...(req.maxCostUsd === undefined ? [] : ['--max-budget-usd', String(req.maxCostUsd)]),
    ...(req.effort === undefined ? [] : ['--effort', req.effort]),
    '--system-prompt-file', systemFile,
    '--json-schema', JSON.stringify(schema),
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

/** The fields of the CLI's JSON result that propose reads. Everything is unknown until checked. */
type CliResult = {
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly total_cost_usd?: unknown;
  readonly errors?: unknown;
  readonly usage?: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const tailOf = (s: string): string => {
  const t = s.trim();
  return t === '' ? '' : `: ${t.length > TAIL ? `...${t.slice(-TAIL)}` : t}`;
};

const parseLine = (line: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(line);
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

function resultOf(line: string): CliResult | undefined {
  const v = parseLine(line);
  return v !== undefined && v['type'] === 'result' ? v : undefined;
}

/** The last stdout line that parses as a `type: "result"` object. Stream events, warnings and a cut-off last line are skipped. */
function parseCliResult(stdout: string): CliResult | undefined {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const res = resultOf(lines[i] ?? '');
    if (res !== undefined) return res;
  }
  return undefined;
}

const SCHEMA_REJECTED = 'Output does not match required schema';

/** True for a tool_result the CLI sent back because the answer failed its --json-schema check. */
function schemaRejected(block: unknown): boolean {
  if (!isRecord(block) || block['type'] !== 'tool_result' || block['is_error'] !== true) return false;
  const c = block['content'];
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (isRecord(x) && typeof x['text'] === 'string' ? x['text'] : '')).join('') : '';
  return text.startsWith(SCHEMA_REJECTED);
}

/** What a stream-json transcript had reported so far (CallProgress). Non-JSON lines and a cut-off last line are skipped. */
export function streamProgress(stdout: string): CallProgress {
  let messages = 0;
  let schemaRetries = 0;
  let outputBytes = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWrite1hTokens = 0;
  let finishedOutput = 0;
  /** The thinking estimate of the message still in flight, or null between messages. */
  let inFlight: number | null = null;
  for (const line of stdout.split('\n')) {
    const v = parseLine(line);
    if (v === undefined) continue;
    if (v['type'] === 'system' && v['subtype'] === 'thinking_tokens' && inFlight !== null) {
      inFlight = count(v['estimated_tokens']);
    } else if (v['type'] === 'user') {
      const message = v['message'];
      const content = isRecord(message) && Array.isArray(message['content']) ? message['content'] : [];
      schemaRetries += content.filter(schemaRejected).length;
    } else if (v['type'] === 'stream_event' && isRecord(v['event'])) {
      const e = v['event'];
      if (e['type'] === 'message_start') {
        const u = isRecord(e['message']) && isRecord(e['message']['usage']) ? e['message']['usage'] : {};
        messages += 1;
        inputTokens += count(u['input_tokens']);
        cacheReadTokens += count(u['cache_read_input_tokens']);
        cacheWriteTokens += count(u['cache_creation_input_tokens']);
        cacheWrite1hTokens += written1h(u);
        inFlight = 0;
      } else if (e['type'] === 'message_delta') {
        finishedOutput += count(isRecord(e['usage']) ? e['usage']['output_tokens'] : undefined);
        inFlight = null;
      } else if (e['type'] === 'content_block_delta' && isRecord(e['delta']) && e['delta']['type'] === 'input_json_delta') {
        const chunk = e['delta']['partial_json'];
        outputBytes += typeof chunk === 'string' ? chunk.length : 0;
      }
    }
  }
  return {
    messages,
    schemaRetries,
    usage: { inputTokens, outputTokens: finishedOutput + (inFlight ?? 0), cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens },
    outputBytes,
  };
}

/** `usage.cache_creation.ephemeral_1h_input_tokens` of a message_start or result line. */
function written1h(u: Record<string, unknown>): number {
  const c = u['cache_creation'];
  return count(isRecord(c) ? c['ephemeral_1h_input_tokens'] : undefined);
}

function cliUsage(u: unknown): Usage {
  const r = isRecord(u) ? u : {};
  return {
    inputTokens: count(r['input_tokens']),
    outputTokens: count(r['output_tokens']),
    cacheReadTokens: count(r['cache_read_input_tokens']),
    cacheWriteTokens: count(r['cache_creation_input_tokens']),
    cacheWrite1hTokens: written1h(r),
  };
}

/** Writes one call's system prompt to a new private temp dir (0700, the file 0600), for `--system-prompt-file`. */
function systemFileOf(system: string): { readonly dir: string; readonly file: string } {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'worldgen-claude-'));
    const file = join(dir, 'system.md');
    writeFileSync(file, system, { mode: 0o600 });
    return { dir, file };
  } catch (e) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    throw new ModelError(`cannot write the system prompt file for claude -p: ${e instanceof Error ? e.message : String(e)}`, undefined, { kind: 'not_started' });
  }
}

/**
 * Model calls through the claude CLI under the user's logged-in session (U-11). `spawn` is the
 * test seam. Cost is the CLI's `total_cost_usd`; when it is missing, cost falls back to `prices`,
 * so a format change cannot make calls look free to the budget while a price is known.
 */
export function claudeCliModel(config: Config, spawnCli: SpawnClaude = spawnClaude, now: () => number = Date.now): Model {
  const bin = config.claudeBin ?? DEFAULT_CLAUDE_BIN;
  const prices = pricesOf(config);
  const timeoutMs = config.maxMinutes * 60_000;
  return {
    async propose(req) {
      const model = req.model ?? config.model;
      requireAllowed(model, req.effort, prices);
      if (req.signal?.aborted) throw new ModelError('model request aborted before starting', undefined, { kind: 'not_started' });
      if (!Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0 || (req.maxCostUsd !== undefined && (!Number.isFinite(req.maxCostUsd) || req.maxCostUsd <= 0))) throw new ModelError('model cost budget must be a positive finite number of USD', undefined, { kind: 'not_started' });
      const budgetUsd = Math.min(config.maxCostUsd, req.maxCostUsd ?? config.maxCostUsd);
      const started = now();
      let out: SpawnResult;
      const shareMs = req.timeoutMs ?? timeoutMs;
      const system = systemFileOf(req.system);
      try {
        const args = claudeArgs(model, { ...req, maxCostUsd: budgetUsd }, system.file);
        const over = args.findIndex((a) => Buffer.byteLength(a) >= MAX_ARG_BYTES);
        if (over >= 0) throw new ModelError(`claude -p argument ${args[over - 1] ?? ''} is ${Buffer.byteLength(args[over] ?? '')} bytes, and Linux refuses one of ${MAX_ARG_BYTES} or more`, undefined, { kind: 'not_started' });
        try {
          out = await spawnCli(bin, args, req.prompt, { timeoutMs: shareMs, idleMs: STALL_MS, ...(req.signal === undefined ? {} : { signal: req.signal }) });
        } catch (e) {
          const notStarted = notStartedFailureSchema.safeParse(e).success;
          throw new ModelError(`cannot run the claude CLI "${bin}": ${e instanceof Error ? e.message : String(e)}. Set claudeBin in worldgen.config.json to the real binary`, undefined, notStarted ? { kind: 'not_started' } : { kind: 'unknown' });
        }
      } finally {
        rmSync(system.dir, { recursive: true, force: true });
      }
      const ms = now() - started;
      // A result line is a finished, billed call whatever stopped the process after it.
      const res = parseCliResult(out.stdout);
      if (res === undefined && (out.killed === 'share' || out.killed === 'stall')) {
        const progress = streamProgress(out.stdout);
        const partialCostUsd = prices[model] === undefined ? 0 : costOf(progress.usage, model, prices);
        throw out.killed === 'share'
          ? new StepShareExpired(shareMs, ms, progress, partialCostUsd)
          : new CallStalled(STALL_MS, ms, progress, partialCostUsd);
      }
      if (res === undefined && out.killed === 'aborted') {
        const progress = streamProgress(out.stdout);
        const partialModelUsage = spentAny(progress.usage) && prices[model] !== undefined
          ? { ...progress.usage, observedCostUsd: costOf(progress.usage, model, prices), costBasis: 'cli_configured_rates' as const }
          : undefined;
        throw new ModelError('model request cancelled without a final receipt', undefined, { kind: 'unknown', ...(partialModelUsage === undefined ? {} : { partialModelUsage }) });
      }
      if (res === undefined && out.code === 127) {
        throw new ModelError(`claude -p exited 127: "${bin}" could not run, often a shell shim or wrapper that is not on PATH outside your terminal. Point WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json at the real binary (try ~/.local/bin/claude)${tailOf(out.stderr)}`);
      }
      if (res === undefined) {
        const how = out.code === null ? `was killed by ${out.signal ?? 'a signal'}` : `exited ${out.code}`;
        throw new ModelError(`claude -p ${how} with no JSON result${tailOf(out.stderr === '' ? out.stdout : out.stderr)}`);
      }
      const usage = cliUsage(res.usage);
      const reported = res.total_cost_usd;
      const reportedCost = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0;
      if (!reportedCost && (!cliBillingUsageSchema.safeParse(res.usage).success || prices[model] === undefined)) {
        throw new ModelError('claude -p returned no usable billing information');
      }
      const costUsd = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0
        ? reported
        : prices[model] === undefined ? 0 : costOf(usage, model, prices);
      const costBasis: CostBasis = reportedCost ? 'cli_reported_cost' : 'cli_configured_rates';
      const billed = { usage, costUsd, ms, costBasis };
      if (res.is_error === true || (out.killed === null && out.code !== 0)) {
        const errors = Array.isArray(res.errors) ? res.errors.filter((x): x is string => typeof x === 'string') : [];
        const text = typeof res.result === 'string' ? [res.result] : [];
        const detail = [typeof res.subtype === 'string' ? res.subtype : 'error', ...errors, ...text].join(': ');
        const exit = out.code === null ? `killed by ${out.signal ?? 'a signal'}` : `exit ${out.code}`;
        throw new ModelError(`claude -p failed (${exit}): ${detail.slice(0, TAIL)}${tailOf(out.stderr)}`, undefined, billed);
      }
      if (res.structured_output === undefined || res.structured_output === null) {
        throw new ModelError(`claude -p returned no structured_output (subtype: ${String(res.subtype)})`, undefined, billed);
      }
      // With --json-schema the CLI's `result` is usually the structured output as JSON text again, which is no commentary.
      const text = typeof res.result === 'string' ? res.result.trim() : '';
      const advice = text === '' || text === JSON.stringify(res.structured_output) ? [] : [text];
      return { input: res.structured_output, advice, usage, costUsd, ms, costBasis };
    },
  };
}

export type ClaudeBinProbe = { ok: true; version: string } | { ok: false; error: string };

/** Runs `<bin> --version`, so a shim that cannot reach the real binary fails before any model call. */
export function probeClaudeBin(bin: string, env: Readonly<Record<string, string | undefined>>): ClaudeBinProbe {
  const probe = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 30_000 });
  if (probe.status === 0) return { ok: true, version: (probe.stdout ?? '').trim() };
  const why = (probe.stderr ?? '').trim().split('\n').at(-1) || (probe.error?.message ?? 'no output');
  return { ok: false, error: `exit ${probe.status ?? probe.signal}: ${why}` };
}
