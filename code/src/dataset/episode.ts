/**
 * One solver episode (YOS-91): reset the world, let a fresh conversation call the public API
 * until it finishes or hits a limit, then read the end state and the call log and hand them to
 * the trusted verifier for the score.
 *
 * The model is behind `NextTurn`, a function the CLI injects; nothing here imports a model, an
 * SDK or a sandbox. The world is behind `WorldPort`: `call` is the public HTTP API, the rest is
 * the controller's private channel (reset, state, log). Grading is behind `EpisodeGrader`
 * (YOS-159): the world the sandbox serves is the public bundle, so the in-sandbox admin port
 * can no longer grade, and the controller grades the recorded trace and end state through the
 * verifier protocol against the private world it holds. The solver gets the instruction, the
 * difficulty, the public OpenAPI document and its own history, and nothing else. The score is
 * the engine's. An episode that fails is returned as a failed record, never thrown.
 */
import { z } from 'zod';
import { traceOf, type CallRecord, type Difficulty, type OpenApiDocument, type StateDump, type TraceCall } from '#engine';
import {
  PROVIDER, SCHEMA_VERSION, gradeCountsOf, hashState, outcomeOf, parseEpisode,
  type Episode, type EpisodeUsage, type GradeCounts, type PublicMessage, type PublicRequest, type Redactor, type StopReason,
} from './schema.ts';

// ---------------------------------------------------------------------------------------------
// The seams

/** What a request becomes once it passed the checks: the path and query to send, and the JSON body text. */
export type SendableRequest = { readonly method: string; readonly target: string; readonly bodyText: string | undefined };

export interface WorldPort {
  /** The public API over HTTP. Rejects on a transport failure; any HTTP status is a result. */
  call(req: SendableRequest, signal: AbortSignal): Promise<{ readonly status: number; readonly text: string }>;
  /** Private: back to the seed, clock at start. */
  reset(): Promise<void>;
  /** Private: the engine's state dump. */
  state(): Promise<StateDump>;
  /** Private: the engine's call log since the reset, records as `GET /_world/log` serves them. */
  log(): Promise<readonly CallRecord[]>;
}

/** What the controller hands the trusted verifier at the end of an episode (YOS-159). */
export type EpisodeSubmission = {
  /** Unique per run: the episode id, so a trace cannot be replayed for a second score. */
  readonly submission: string;
  readonly task: string;
  /** The run's successful calls in log order, as the engine's own traceOf records them. */
  readonly trace: readonly TraceCall[];
  /** The final state snapshot (GET /_world/state). */
  readonly state: StateDump;
};

/** A grade: the score and the verifier's goal and guard counts (integers, A-389), or why it could not be graded. */
export type GradeResult = ({ readonly ok: true; readonly score: number } & GradeCounts) | { readonly ok: false; readonly reason: string };
export type EpisodeGrader = (submission: EpisodeSubmission) => Promise<GradeResult>;

/** What the solver sees on every turn. `messages` is the public history so far; nothing else about the world is reachable from it. */
export type TurnView = {
  readonly instruction: string;
  readonly difficulty: Difficulty;
  readonly openapi: OpenApiDocument;
  readonly messages: readonly PublicMessage[];
  readonly turn: number;
  readonly maxTurns: number;
  readonly budgetLeftUsd: number;
};
export type TurnResult = {
  /** Untrusted: parsed here against `decisionSchema`. */
  readonly decision: unknown;
  /** The model's text outside its tool call. Never hidden thinking. */
  readonly commentary: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens?: number | undefined };
  readonly costUsd: number;
  readonly ms: number;
};
/** Must stop and reject once `signal` aborts, cancelling any request it made. */
export type NextTurn = (view: TurnView, signal: AbortSignal) => Promise<TurnResult>;

export const decisionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('request'),
    method: z.string(),
    path: z.string(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: z.json().optional(),
  }),
  z.strictObject({ action: z.literal('finish'), final_reply: z.string() }),
]);
export type Decision = z.output<typeof decisionSchema>;

// ---------------------------------------------------------------------------------------------
// Public request checks

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const BODYLESS = new Set(['GET', 'DELETE']);
const MAX_PATH_CHARS = 2000;
const MAX_BODY_CHARS = 100_000;
const CONTROL = /[\u0000-\u001f\u007f\s]/u;
const PLACEHOLDER = /^\{[^{}/]+\}$/;
const ADMIN_SEGMENT = '_world';

export type Route = { readonly method: string; readonly template: string; readonly segments: readonly string[] };

/** Every method and path template the public OpenAPI document documents. */
export function routesOf(doc: OpenApiDocument): Route[] {
  return Object.entries(doc.paths).flatMap(([template, item]) =>
    Object.keys(item).map((m) => ({ method: m.toUpperCase(), template, segments: template.split('/').filter((s) => s !== '') })));
}

const tryDecode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** The decoded segments of a relative public path, or why the path is refused. */
function pathSegments(path: string): { ok: true; segments: string[] } | { ok: false; reason: string } {
  const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (path === '' || path.length > MAX_PATH_CHARS) return no(`path must be 1 to ${MAX_PATH_CHARS} characters`);
  if (CONTROL.test(path)) return no('path must not contain whitespace or control characters');
  if (!path.startsWith('/')) return no('path must be relative and start with "/", not an absolute URL');
  if (path.startsWith('//')) return no('path must not start with "//" (protocol-relative URL)');
  if (path.includes('\\')) return no('path must not contain a backslash');
  if (/[?#]/.test(path)) return no('put query parameters in "query", not in the path');
  const segments: string[] = [];
  for (const raw of path === '/' ? [] : path.split('/').slice(1)) {
    if (raw === '') return no('path must not contain an empty segment');
    const once = tryDecode(raw);
    if (once === null) return no('path has malformed percent-encoding');
    if (once.includes('/') || once.includes('\\') || CONTROL.test(once)) return no('path must not encode a separator, backslash or control character');
    if (once === '.' || once === '..') return no('path must not contain "." or ".." segments');
    if (tryDecode(once) !== once) return no('path must not be double-encoded');
    if (once.toLowerCase().startsWith(ADMIN_SEGMENT)) return no('path is outside the public API');
    segments.push(once);
  }
  return { ok: true, segments };
}

export type Checked = { readonly ok: true; readonly send: SendableRequest } | { readonly ok: false; readonly reason: string };

/**
 * Whether `req` may be sent: a known method, a relative path whose method and segments match a
 * documented route (a `{placeholder}` takes any one non-empty segment), string query values, and a
 * JSON body only on methods that take one. The reason names what to change, and is shown to the solver.
 */
export function checkRequest(req: PublicRequest, routes: readonly Route[]): Checked {
  const no = (reason: string): Checked => ({ ok: false, reason });
  const method = req.method.toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) return no(`method must be one of ${METHODS.join(', ')}`);
  const p = pathSegments(req.path);
  if (!p.ok) return no(p.reason);
  const matches = (r: Route): boolean =>
    r.segments.length === p.segments.length && r.segments.every((s, i) => (PLACEHOLDER.test(s) ? true : s === p.segments[i]));
  const sameShape = routes.filter(matches);
  if (!sameShape.some((r) => r.method === method)) {
    return no(
      sameShape.length === 0
        ? `${req.path} is not a path in the API documentation`
        : `${method} is not documented for ${req.path}; documented: ${sameShape.map((r) => `${r.method} ${r.template}`).join(', ')}`,
    );
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === '' || CONTROL.test(k)) return no('query names must be non-empty and free of whitespace and control characters');
    query.append(k, v);
  }
  let bodyText: string | undefined;
  if (req.body !== undefined) {
    if (BODYLESS.has(method)) return no(`${method} takes no body`);
    bodyText = JSON.stringify(req.body);
    if (bodyText.length > MAX_BODY_CHARS) return no(`body is longer than ${MAX_BODY_CHARS} characters`);
  }
  const qs = query.toString();
  return { ok: true, send: { method, target: qs === '' ? req.path : `${req.path}?${qs}`, bodyText } };
}

// ---------------------------------------------------------------------------------------------
// The episode

/** A response longer than this is cut, so one list call cannot fill the solver's context. The cut is flagged. */
export const MAX_RESULT_CHARS = 20_000;

export type EpisodeInput = {
  readonly runId: string;
  readonly engineCommit: string;
  readonly worldId: string;
  /** sha-256 of the frozen world.yaml. */
  readonly worldVersion: string;
  readonly promptVersion: string;
  readonly configVersion: string;
  /** The model `nextTurn` calls, recorded on the episode, or null when it calls none, as the noop agent does. */
  readonly model: string | null;
  readonly task: { readonly id: string; readonly difficulty: Difficulty; readonly instruction: string };
  readonly index: number;
  readonly openapi: OpenApiDocument;
  /** The hash of the seed state, computed from the checked world by a local engine. A reset that lands elsewhere stops the episode. */
  readonly seedHash: string;
  readonly port: WorldPort;
  /** The trusted verifier: grades the recorded trace and end state against the private world (YOS-159). */
  readonly grade: EpisodeGrader;
  readonly nextTurn: NextTurn;
  readonly maxTurns: number;
  /** Model spend this episode may use, in USD: its own budget, or what is left of a run's (limitScope). */
  readonly budgetLeftUsd: number;
  /** Epoch ms after which the episode is cancelled: its own deadline, or a run's (limitScope). */
  readonly deadline: number;
  /**
   * Whose budget and deadline these are: the episode's own (the default), or what is left of a run's shared ones. A cut
   * by a run's is `run_budget_limit` or `run_time_limit`, which is infra, not the agent's failure (A-396).
   */
  readonly limitScope?: 'episode' | 'run';
  readonly now: () => number;
  readonly redact: Redactor;
  /** The operator's Ctrl-C. Aborting it cancels the pending call like the deadline does, and the episode stops as `interrupted`. */
  readonly interrupt?: AbortSignal | undefined;
};

/** The engine's private evidence for an episode. It is kept apart from the public record. */
export type PrivateArtifacts = {
  initialState?: StateDump;
  finalState?: StateDump;
  callLog?: unknown;
  /** What failed at the controller's private boundary, in full and redacted of supplied secrets. The public record says only that it failed. */
  errors?: { readonly boundary: string; readonly message: string }[];
};
export type EpisodeOutput = { readonly episode: Episode; readonly artifacts: PrivateArtifacts };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const billedSchema = z.object({
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(), cacheWriteTokens: z.number().optional() }),
  costUsd: z.number(),
  ms: z.number().optional(),
});
const notStartedSchema = z.object({ billing: z.object({ kind: z.literal('not_started') }) });

type Json = z.output<ReturnType<typeof z.json>>;

function parseBody(text: string): { body: Json; truncated: boolean } {
  if (text.length > MAX_RESULT_CHARS) return { body: text.slice(0, MAX_RESULT_CHARS), truncated: true };
  try {
    return { body: JSON.parse(text) as Json, truncated: false };
  } catch {
    return { body: text, truncated: false };
  }
}

export async function runEpisode(a: EpisodeInput): Promise<EpisodeOutput> {
  const started = a.now();
  const messages: PublicMessage[] = [{ seq: 0, role: 'user', type: 'instruction', text: a.task.instruction }];
  const usage = { model_calls: 0, unaccounted_calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, duration_ms: 0 };
  const artifacts: PrivateArtifacts = {};
  const privateErrors: { boundary: string; message: string }[] = [];
  /** Keeps a private-boundary failure's text out of the public record: engine and sandbox errors can quote hidden grader or world details. */
  const keepPrivate = (boundary: string, e: unknown): void => void privateErrors.push({ boundary, message: a.redact.text(messageOf(e)) });
  const routes = routesOf(a.openapi);
  let stop = null as StopReason | null;
  let error = null as string | null;
  let finalReply = null as string | null;
  let initialHash = null as string | null;
  let finalHash = null as string | null;
  let score = null as number | null;
  let counts = null as GradeCounts | null;
  let ready = false;

  const fail = (reason: StopReason, why: string): void => {
    stop ??= reason;
    error ??= a.redact.text(why);
  };
  const account = (u: TurnResult['usage'], costUsd: number): void => {
    if (a.model !== null) usage.model_calls += 1;
    usage.input_tokens += u.inputTokens;
    usage.output_tokens += u.outputTokens;
    usage.cache_read_tokens += u.cacheReadTokens;
    usage.cache_write_tokens += u.cacheWriteTokens ?? 0;
    usage.cost_usd = Math.round((usage.cost_usd + costUsd) * 1e9) / 1e9;
  };
  const runLimits = a.limitScope === 'run';
  const exhausted = (): { reason: StopReason; why: string } | null =>
    usage.cost_usd >= a.budgetLeftUsd
      ? { reason: runLimits ? 'run_budget_limit' : 'budget_limit', why: `the ${runLimits ? "run's " : ''}model budget is spent (${usage.cost_usd} USD of ${a.budgetLeftUsd} USD left at the start)` }
      : a.interrupt?.aborted === true ? cancelled()
      : a.now() >= a.deadline ? cancelled()
      : null;

  // One controller for the whole episode: the deadline cancels the pending model call or HTTP request itself.
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), Math.min(Math.max(0, a.deadline - a.now()), 2 ** 31 - 1));
  const onInterrupt = (): void => cancel.abort();
  if (a.interrupt?.aborted === true) onInterrupt();
  a.interrupt?.addEventListener('abort', onInterrupt, { once: true });
  const cancelled = (): { reason: StopReason; why: string } =>
    a.interrupt?.aborted === true ? { reason: 'interrupted', why: 'the operator interrupted the run' }
      : runLimits ? { reason: 'run_time_limit', why: "the run's time limit passed" } : { reason: 'time_limit', why: 'the time limit passed' };
  try {
    const early = exhausted();
    if (early !== null) {
      fail(early.reason, `${early.why} before the episode started`);
    } else {
      let step = 'reset';
      try {
        await a.port.reset();
        step = 'initial state read';
        const dump = await a.port.state();
        initialHash = hashState(dump);
        artifacts.initialState = dump;
        if (initialHash === a.seedHash) ready = true;
        else fail('world_error', `after the reset the world state hash is ${initialHash}, not the frozen seed ${a.seedHash}`);
      } catch (e) {
        keepPrivate(step, e);
        fail('world_error', `the controller could not ${step}; the details are in the private diagnostics`);
      }
    }

    for (let turn = 1; ready && stop === null && turn <= a.maxTurns; turn++) {
      const limit = exhausted();
      if (limit !== null) {
        fail(limit.reason, limit.why);
        break;
      }
      let res: TurnResult;
      try {
        res = await a.nextTurn({ instruction: a.task.instruction, difficulty: a.task.difficulty, openapi: a.openapi, messages: [...messages], turn, maxTurns: a.maxTurns, budgetLeftUsd: Math.max(0, a.budgetLeftUsd - usage.cost_usd) }, cancel.signal);
      } catch (e) {
        const billed = billedSchema.safeParse(e);
        const notStarted = notStartedSchema.safeParse(e).success;
        if (billed.success) account(billed.data.usage, billed.data.costUsd);
        else if (!notStarted) usage.unaccounted_calls += 1;
        if (cancel.signal.aborted) fail(cancelled().reason, `${cancelled().why}; ${notStarted ? 'it cancelled before a paid model request started' : "it cancelled a pending model call and that call's cost is unknown"}`);
        else fail('model_error', `model call failed: ${messageOf(e)}`);
        break;
      }
      account(res.usage, res.costUsd);
      const parsed = decisionSchema.safeParse(res.decision);
      if (!parsed.success) {
        fail('invalid_turn', `the solver's answer is not a valid turn: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        break;
      }
      const decision = parsed.data;
      if (decision.action === 'finish') {
        messages.push({ seq: messages.length, role: 'assistant', type: 'final_reply', text: decision.final_reply, commentary: res.commentary });
        finalReply = decision.final_reply;
        stop = 'done';
        break;
      }
      const callId = `c${messages.filter((m) => m.type === 'tool_call').length + 1}`;
      const request: PublicRequest = {
        method: decision.method,
        path: decision.path,
        query: Object.fromEntries(Object.entries(decision.query ?? {}).map(([k, v]) => [k, String(v)])),
        ...(decision.body === undefined ? {} : { body: decision.body }),
      };
      messages.push({ seq: messages.length, role: 'assistant', type: 'tool_call', call_id: callId, request, commentary: res.commentary });
      const result = (r: Omit<Extract<PublicMessage, { type: 'tool_result' }>, 'seq' | 'role' | 'type' | 'call_id'>): void => {
        messages.push({ seq: messages.length, role: 'tool', type: 'tool_result', call_id: callId, ...r });
      };
      const checked = checkRequest(request, routes);
      if (!checked.ok) {
        result({ outcome: 'rejected', status: null, body: null, truncated: false, detail: checked.reason });
        continue;
      }
      try {
        const answer = await a.port.call(checked.send, cancel.signal);
        result({ outcome: 'response', status: answer.status, ...parseBody(answer.text), detail: null });
      } catch (e) {
        const stopped = cancel.signal.aborted;
        result({ outcome: 'error', status: null, body: null, truncated: false, detail: a.redact.text(stopped ? 'cancelled before it completed' : `the request could not be completed: ${messageOf(e)}`) });
        if (stopped) fail(cancelled().reason, `${cancelled().why}; it cancelled a pending request`);
        else fail('world_error', `public request failed: ${messageOf(e)}`);
      }
    }
    if (ready && stop === null) fail('turn_limit', `no final reply after ${a.maxTurns} turns`);
  } finally {
    clearTimeout(timer);
    a.interrupt?.removeEventListener('abort', onInterrupt);
  }

  // Grading is private and short, so it runs whatever the stop reason, and the time limit does not cancel it.
  if (ready) {
    let step = 'final state read';
    try {
      const dump = await a.port.state();
      artifacts.finalState = dump;
      finalHash = hashState(dump);
      step = 'log read';
      const log = await a.port.log();
      artifacts.callLog = log;
      step = 'grade';
      const graded = await a.grade({ submission: `${a.runId}__${a.task.id}__${a.index}`, task: a.task.id, trace: traceOf(log), state: dump });
      if (!graded.ok) throw new Error(graded.reason);
      const s = graded.score;
      if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1) throw new Error(`the verifier returned the score ${String(s)}, not a number from 0 to 1`);
      const c = gradeCountsOf(graded.goals, graded.guards);
      if (c === null) throw new Error('the verifier returned goal or guard counts that are not two integer pairs');
      if (c.guards.held < c.guards.total && s !== 0) throw new Error(`the verifier scored ${s} with a broken guard, which the engine scores 0`);
      score = s;
      counts = c;
    } catch (e) {
      score = null;
      counts = null;
      keepPrivate(step, e);
      const why = `grading failed at the ${step}; the details are in the private diagnostics`;
      if (stop === 'done') {
        stop = 'grade_error';
        error = a.redact.text(why);
      } else {
        error = a.redact.text(`${error ?? ''}; ${why}`);
      }
    }
  }

  if (privateErrors.length > 0) artifacts.errors = privateErrors;
  usage.duration_ms = Math.max(0, a.now() - started);
  const usageRecord: EpisodeUsage = usage;
  const core = a.redact.deep({
    schema_version: SCHEMA_VERSION,
    episode_id: `${a.runId}__${a.task.id}__${a.index}`,
    run_id: a.runId,
    world_id: a.worldId,
    world_version: a.worldVersion,
    engine_commit: a.engineCommit,
    task_id: a.task.id,
    difficulty: a.task.difficulty,
    provider: PROVIDER,
    model: a.model,
    prompt_version: a.promptVersion,
    config_version: a.configVersion,
    initial_state_hash: initialHash,
    final_state_hash: finalHash,
    messages,
    final_reply: finalReply,
    score,
    score_scope: 'engine_state_only',
    stop_reason: stop ?? 'world_error',
    error,
    usage: usageRecord,
  });
  const record = { ...core, outcome: outcomeOf(core, counts) };
  return { episode: parseEpisode(record, record.episode_id), artifacts };
}
