/**
 * The verifier protocol (YOS-159, A-224): how a run's trace and final state are graded against
 * the private world, and what may come back.
 *
 * The controller sends one request per episode: the submission id (unique per run), the task id,
 * the identities the run is bound to (the WID of the full private world, the sha-256 of its
 * world.yaml, the engine revision), the ordered trace of successful calls, a deterministic hash
 * chain over that trace, and the final state snapshot. The verifier that holds the private world
 * replays the trace from seed on a fresh runtime and grades the state the trace reached. The
 * answer is only the bounded verdict: task, wid, score, stop, and for a graded one the goal and
 * guard counts as two integer pairs (A-389). Nothing else, never a goal's or guard's name, so no
 * grader source can leave through an error string, a log line or a rejected request's echo.
 *
 * Rejections, in check order: `request.too_large` (the message text or the trace is over
 * VERIFIER_LIMITS), `request.invalid` (not JSON, not the message shape, or a state snapshot that
 * is not a state of this world), `trace.chain` (the declared chain does not cover the trace as
 * sent, so the trace was mutated), `world.mismatch` (the WID or world version is not the
 * verifier's), `engine.mismatch` (the engine revision is not), `trace.replayed` (the submission
 * id was already graded in this verifier session), `task.unknown`, `trace.mismatch` (the trace
 * does not replay to the snapshot: a call answers differently, or the replayed state, clock
 * included, is not the snapshot), `grade.failed` (the grader itself faulted; the reason stays
 * private).
 *
 * Pure. The vm host and the sha-256 function arrive as parameters; index.ts injects both, as it
 * does for every core function that runs snippets. The replay uses the same `handle()` path HTTP
 * and client scripts use, and grades through gradeDump with the replay's own journal and log,
 * so ctx.changes() skips job changes and ctx.trace() sees the trace.
 */
import { z } from 'zod';
import { runtime, type DumpInput, type Runtime } from './api.ts';
import type { CheckedWorld } from './check.ts';
import type { SnippetHost } from './ctx.ts';
import { canonicalJson, type Wid } from './provenance.ts';
import { gradeDump, stateFromDump, type Graded } from './tasks.ts';
import { stateHash } from './store.ts';

/** The protocol version of a verifier request. */
export const VERIFIER_PROTOCOL = 1;

/** Bounds a request may not exceed, whatever it contains. */
export const VERIFIER_LIMITS = {
  /** Most successful calls a trace may hold. A solver episode is far below this. */
  maxTraceCalls: 10_000,
  /** Most characters of request text. The shell checks bytes before reading; this is the core's own bound. */
  maxRequestChars: 8 * 1024 * 1024,
} as const;

/** What the verifier holds: the private world and the identities the run must match. */
export type VerifierHeld = {
  /** worldIdOf of the full private world. The public bundle is bound to it by this id, never by content. */
  readonly wid: Wid;
  /** sha-256 of the frozen private world.yaml. */
  readonly worldVersion: string;
  /** The engine revision the run declares, such as the dataset run's engine commit. */
  readonly engine: string;
};

export const VERIFIER_STOPS = [
  'graded',
  'task.unknown',
  'world.mismatch',
  'engine.mismatch',
  'request.invalid',
  'request.too_large',
  'trace.chain',
  'trace.replayed',
  'trace.mismatch',
  'grade.failed',
] as const;
export type RejectStop = Exclude<(typeof VERIFIER_STOPS)[number], 'graded'>;

/**
 * How many of the grader's goals were met and its guards held: two integer pairs, never the goals' or guards' names,
 * which are grader source. Totals are 0 when the grader recorded none (A-389, amending YOS-159's bounded verdict).
 */
export type GradeCounts = {
  readonly goals: { readonly met: number; readonly total: number };
  readonly guards: { readonly held: number; readonly total: number };
};

/** The bounded verdict: the only thing the verifier ever answers with. */
export type VerifierVerdict =
  | ({ readonly task: string; readonly wid: Wid; readonly score: number; readonly stop: 'graded' } & GradeCounts)
  | { readonly task: string; readonly wid: Wid; readonly score: null; readonly stop: RejectStop };

const countsOf = (graded: Extract<Graded, { ok: true }>): GradeCounts => ({
  goals: { met: (graded.goals ?? []).filter((g) => g.met).length, total: (graded.goals ?? []).length },
  guards: { held: (graded.guards ?? []).filter((g) => g.held).length, total: (graded.guards ?? []).length },
});

/** One verified submission: the verdict, and the submission id the caller must record in the session ledger. */
export type VerifiedSubmission = {
  readonly verdict: VerifierVerdict;
  /** Null when the request never parsed (nothing was consumed) or was a replay (already recorded). */
  readonly ledger: string | null;
};

/** One call of the trace, as the controller recorded it from the run's own log. */
const traceEntrySchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(2000),
  status: z.number().int().min(100).max(599),
  routeId: z.string().min(1).max(64).nullable(),
  at: z.string().min(1).max(64),
  body: z.json().nullable(),
  writes: z.array(z.strictObject({
    entity: z.string().min(1).max(64),
    id: z.string().min(1).max(64),
    kind: z.enum(['created', 'updated', 'deleted']),
    fields: z.array(z.string().min(1).max(64)).max(64),
  })).max(64),
});

/**
 * The protocol message. `state` is judged by the engine's own stateFromDump, not by this schema:
 * a state dump has one judge, so the field only checks that a snapshot object is present.
 */
export const verifierRequestSchema = z.strictObject({
  protocol: z.literal(VERIFIER_PROTOCOL),
  submission: z.string().min(1).max(200),
  task: z.string().min(1).max(64),
  wid: z.string().regex(/^wid_[0-9a-f]{64}$/),
  worldVersion: z.string().regex(/^[0-9a-f]{64}$/),
  engine: z.string().min(7).max(64),
  trace: z.array(traceEntrySchema),
  chain: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.custom<DumpInput>((v) => typeof v === 'object' && v !== null, { message: 'a state dump object (GET /_world/state)' }),
});
export type VerifierRequest = z.output<typeof verifierRequestSchema>;

/** The domain-separated seed of the trace chain. */
const CHAIN_SEED = 'worldgen:verifier:trace:v1';

/**
 * The deterministic hash chain over a trace: each call digests the previous digest plus the
 * call's canonical JSON, so any mutation, insertion, removal or reordering of any entry changes
 * the final digest. The controller computes it over what it sends; the verifier recomputes.
 */
export function chainOf(trace: readonly unknown[], sha256: (text: string) => string): string {
  let digest = sha256(CHAIN_SEED);
  for (const call of trace) digest = sha256(`${digest}\n${canonicalJson(call)}`);
  return digest;
}

/**
 * Verifies one submission against the private world `world` holds. `requestText` is the message
 * exactly as sent; `seen` holds the submission ids this verifier session already graded. Never
 * throws: every failure is a rejection verdict. A request that parsed consumed its submission
 * id whatever the verdict, so it cannot be replayed or retried under the same id; only a replay
 * itself records nothing new.
 */
export function verifySubmission(
  world: CheckedWorld,
  held: VerifierHeld,
  requestText: string,
  seen: ReadonlySet<string>,
  host: SnippetHost,
  sha256: (text: string) => string,
): VerifiedSubmission {
  const reject = (stop: RejectStop, task: string, ledger: string | null): VerifiedSubmission =>
    ({ verdict: { task, wid: held.wid, score: null, stop }, ledger });

  if (requestText.length > VERIFIER_LIMITS.maxRequestChars) return reject('request.too_large', '', null);
  let raw: unknown;
  try {
    raw = JSON.parse(requestText);
  } catch {
    return reject('request.invalid', '', null);
  }
  const echo = (r: unknown): string => {
    const task = (r as { task?: unknown } | null)?.task;
    return typeof task === 'string' ? task.slice(0, 64) : '';
  };
  const rawTrace = (raw as { trace?: unknown } | null)?.trace;
  if (Array.isArray(rawTrace) && rawTrace.length > VERIFIER_LIMITS.maxTraceCalls) {
    return reject('request.too_large', echo(raw), null);
  }
  const parsed = verifierRequestSchema.safeParse(raw);
  if (!parsed.success) return reject('request.invalid', echo(raw), null);
  const req = parsed.data;

  if (chainOf(req.trace, sha256) !== req.chain) return reject('trace.chain', req.task, req.submission);
  if (req.wid !== held.wid || req.worldVersion !== held.worldVersion) return reject('world.mismatch', req.task, req.submission);
  if (req.engine !== held.engine) return reject('engine.mismatch', req.task, req.submission);
  if (seen.has(req.submission)) return reject('trace.replayed', req.task, null);
  if (!Object.hasOwn(world.tasks, req.task)) return reject('task.unknown', req.task, req.submission);

  // The engine's own stateFromDump is this snapshot's one judge: a malformed or tampered dump
  // (its hash does not cover its content) is a request.invalid.
  const dump: DumpInput = req.state;
  let claimed: ReturnType<typeof stateFromDump>;
  try {
    claimed = stateFromDump(world, dump);
  } catch {
    return reject('request.invalid', req.task, req.submission);
  }

  // Replay: the same handle() path HTTP uses, from the seed, each successful call in order.
  const rt: Runtime = runtime(world, host);
  for (const call of req.trace) {
    const res = rt.call({ method: call.method, path: call.path, query: {}, body: call.body === null ? undefined : call.body });
    if (res.status !== call.status) return reject('trace.mismatch', req.task, req.submission);
  }
  const replayed = stateFromDump(world, rt.dump());
  if (stateHash(replayed) !== stateHash(claimed) || replayed.now !== claimed.now) {
    return reject('trace.mismatch', req.task, req.submission);
  }

  const graded = gradeDump(world, req.task, dump, host, rt.journal(), rt.log());
  if (!graded.ok) return reject('grade.failed', req.task, req.submission);
  return { verdict: { task: req.task, wid: held.wid, score: graded.score, stop: 'graded', ...countsOf(graded) }, ledger: req.submission };
}
