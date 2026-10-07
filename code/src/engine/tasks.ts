/**
 * What a score means, and the proof that a task's grader discriminates.
 *
 * Invariants:
 * - Solutions, tests and decoys run as client scripts. They reach state only through
 *   `handle()` in api.ts, the same path HTTP uses.
 * - A task passes only if all of these hold. The solution scores exactly 1 and gets no 5xx.
 *   Doing nothing scores exactly 0. Medium and hard tasks have a decoy. Every decoy gets no
 *   5xx, scores below 1 and is not trivial. Every strict prefix of the solution's successful writes scores
 *   below 1, and so does the solution plus one collateral write (the engine builds both by replaying
 *   the solution's calls, no model). Two solution runs from seed end in the same state hash.
 * - A grader scores V(seed, trace, end) (design law L7): ctx.trace() is the graded run's own
 *   successful calls with their writes, ctx.guard gates the score to 0, ctx.goal adds weights.
 *   A grader that returns a plain number keeps working.
 * - `TaskVerdict` is branded. Only `verifyTask` mints one, so report.ts can only render
 *   verdicts the engine produced.
 */
import {
  changesSince, queryOf, runtime, type ApiRequest, type CallRecord, type DumpInput, type HttpMethod, type OriginJournal, type Runtime,
} from './api.ts';
import type { CheckedWorld } from './check.ts';
import { fromIso, parseDuration, timeMath, toIso, type Iso } from './clock.ts';
import {
  changeGuardSchema, SnippetFault, type Change, type ClientCtx, type GraderCtx, type ReadDb, type SnippetHost, type TraceCall,
} from './ctx.ts';
import type { Difficulty, World } from './format.ts';
import { machineOf } from './fields.ts';
import { issue, type CheckIssue, type IssuePath, type MutantKind, type NonEmpty } from './issues.ts';
import { seedState, stateHash, transact, type IdempotencyEntry, type Row, type RowId, type State } from './store.ts';

declare const verdictBrand: unique symbol;
/** One engine mutant kind on one task. `call` and `score` are null when the kind found nothing to probe: unprobed, not passed. */
export type MutantProbe = { readonly kind: MutantKind; readonly call: string | null; readonly score: number | null };

export type TaskVerdict = {
  readonly taskId: string;
  readonly difficulty: Difficulty;
  readonly solution: 1;
  readonly noop: 0;
  readonly decoys: readonly { readonly why: string; readonly score: number }[];
  /** Highest score among strict prefixes of the solution's successful writes. Below 1, or null with one write. */
  readonly bestPrefixScore: number | null;
  readonly solutionCalls: number;
  /** Successful calls of the solution that changed a row. */
  readonly solutionWrites: number;
  /** Successful GET calls of the solution before its first write. */
  readonly solutionReadsBeforeWrite: number;
  /** Entities whose list route the solution called with a page-size or cursor parameter, sorted. Paging matters for these. */
  readonly solutionPagedEntities: readonly string[];
  /** Distinct rows the solution's successful calls changed. One means a single-row path (A-225). */
  readonly solutionRowsChanged: number;
  /** Entities where the solution changed a row it saw only on a page after the first, sorted: proof it crossed a page boundary (A-226). */
  readonly solutionLaterPageEntities: readonly string[];
  /** Entities the solution changed rows of, where its filtered list calls also returned a row it left unchanged, sorted: near-duplicate distractors it had to tell apart (YOS-180). */
  readonly solutionDistractorEntities: readonly string[];
  /** Every engine mutant kind, in order: the call it graded and its score, or nulls when no candidate committed a visible change, so the kind was not probed. */
  readonly collateral: readonly MutantProbe[];
  readonly endStateHash: string;
  readonly [verdictBrand]: true;
};

/** A goal a grader recorded with ctx.goal, and whether it was met. */
export type GoalResult = { readonly name: string; readonly weight: number; readonly met: boolean };
/** A guard a grader recorded with ctx.guard, and whether it held. */
export type GuardResult = { readonly name: string; readonly held: boolean };
/** A score. `goals` and `guards` are present only when the grader recorded any. */
export type Graded =
  | { ok: true; score: number; goals?: readonly GoalResult[]; guards?: readonly GuardResult[] }
  | { ok: false; issue: CheckIssue };

/** The `worldplay verify --json` record for one task. */
export type TaskProof = {
  readonly task: string;
  readonly difficulty: Difficulty;
  readonly proof: {
    readonly reference: { readonly score: 1; readonly calls: number };
    readonly noop: { readonly score: 0 };
    /** The best decoy, or null when the task has none. */
    readonly near_miss: { readonly score: number } | null;
    readonly decoys: readonly number[];
    readonly best_prefix: number | null;
    /** Always true for a verdict: two solution runs ending in different states fail verification. */
    readonly replay_identical: true;
    readonly state: string;
  };
};

/** Projects a verdict onto its JSON proof. Pure. */
export function proofOf(v: TaskVerdict): TaskProof {
  const scores = v.decoys.map((d) => d.score);
  return {
    task: v.taskId,
    difficulty: v.difficulty,
    proof: {
      reference: { score: v.solution, calls: v.solutionCalls },
      noop: { score: v.noop },
      near_miss: scores.length === 0 ? null : { score: Math.max(...scores) },
      decoys: scores,
      best_prefix: v.bestPrefixScore,
      replay_identical: true,
      state: v.endStateHash,
    },
  };
}

const show = (v: unknown): string => {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return typeof v;
  }
};
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function taskOf(world: World, taskId: string): { ok: true; task: World['tasks'][string] } | { ok: false; issue: CheckIssue } {
  const task = Object.hasOwn(world.tasks, taskId) ? world.tasks[taskId] : undefined;
  if (task) return { ok: true, task };
  const known = Object.keys(world.tasks);
  return { ok: false, issue: issue('ref.unknown', ['tasks', taskId], { kind: 'task', name: taskId, known }, JSON.stringify(taskId)) };
}

/**
 * Runs `fn` with a read-only view of `state`, through the store's own reads so `where` matches
 * exactly as handlers see it. Nothing is written; a throw inside `fn` comes out unwrapped.
 */
function withReader<T>(world: World, state: State, fn: (db: ReadDb) => T): T {
  const r = transact(world, state, (tx) => fn({ get: (entity, id) => tx.get(entity, id), list: (entity, q) => tx.list(entity, q) }));
  if (r.ok) return r.value;
  throw r.error.code === 'tx.aborted' && r.error.cause !== undefined ? r.error.cause : r.error;
}

/** ctx.changes(): every change since seed, minus ignored entities and, unless asked, job changes. */
function changesFn(seed: State, end: State, journal: OriginJournal): GraderCtx['changes'] {
  let all: readonly Change[] | null = null;
  return (opts) => {
    all ??= changesSince(seed, end, journal);
    const ignore = Array.isArray(opts?.ignore) ? opts.ignore.map(String) : [];
    const includeJobs = opts?.includeJobs === true;
    return all.filter((c) => !ignore.includes(c.entity) && (includeJobs || c.origin !== 'job'));
  };
}

const succeeded = (c: CallRecord): boolean => c.res.status < 400;

/**
 * The trace of one run: its successful calls in log order, each with the rows its log entry says
 * it committed. Refused calls changed nothing, and jobs are not calls, so neither appears.
 */
export function traceOf(log: readonly CallRecord[]): TraceCall[] {
  return log.filter(succeeded).map((c) => ({
    seq: c.seq,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    routeId: c.routeId,
    at: c.at,
    body: c.req.body ?? null,
    writes: c.writes.map((w) => ({ entity: w.entity, id: w.id, kind: w.op, fields: [...w.fields] })),
  }));
}

/** Digits ctx.score() keeps, so goal weights such as 0.1 + 0.2 + 0.7 sum to exactly 1. */
const SCORE_DECIMALS = 1e9;

/** ctx.goal, ctx.guard and ctx.score for one grader run, plus what they recorded. */
function scorer(): Pick<GraderCtx, 'goal' | 'guard' | 'score'> & { goals: GoalResult[]; guards: GuardResult[]; failedGuard(): boolean } {
  const goals: GoalResult[] = [];
  const guards: GuardResult[] = [];
  const failedGuard = (): boolean => guards.some((g) => !g.held);
  return {
    goals,
    guards,
    failedGuard,
    goal(weight, name, ok) {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
        throw new Error(`ctx.goal weight must be a number above 0 and at most 1, got ${show(weight)}`);
      }
      const met = Boolean(ok);
      goals.push({ name: String(name), weight, met });
      return met;
    },
    guard(name, ok) {
      const held = Boolean(ok);
      guards.push({ name: String(name), held });
      return held;
    },
    score() {
      if (failedGuard()) return 0;
      const sum = goals.reduce((s, g) => (g.met ? s + g.weight : s), 0);
      return Math.round(sum * SCORE_DECIMALS) / SCORE_DECIMALS;
    },
  };
}

/** The name of the guard the engine adds for a task's `allows`. */
export const allowsGuard = (taskId: string): string => `engine: only the changes tasks.${taskId}.allows declares`;

/** A grader run's score, what it recorded, and whether it read ctx.trace(). */
type GradeRun = { ok: true; graded: Extract<Graded, { ok: true }>; readTrace: boolean } | { ok: false; issue: CheckIssue };

function gradeRun(world: World, seed: State, end: State, taskId: string, host: SnippetHost, journal: OriginJournal, log: readonly CallRecord[]): GradeRun {
  const t = taskOf(world, taskId);
  if (!t.ok) return t;
  // A bare task (the public form of a world, YOS-159) has no grader to run.
  if (t.task.grader === undefined) {
    return { ok: false, issue: issue('task.instruction_only', ['tasks', taskId], {}, 'the task carries no grader') };
  }
  const path: IssuePath = ['tasks', taskId, 'grader'];
  const compiled = host.compile('grader', t.task.grader, path);
  if (!compiled.ok) return compiled;
  const nowIso = toIso(end.now);
  let readTrace = false;
  let trace: readonly TraceCall[] | null = null;
  const traceFn = (): readonly TraceCall[] => {
    readTrace = true;
    trace ??= traceOf(log);
    return trace;
  };
  const s = scorer();
  const changes = changesFn(seed, end, journal);
  let score: unknown;
  try {
    score = withReader(world, end, (db) =>
      withReader(world, seed, (seedDb) =>
        compiled.run({
          db,
          seed: seedDb,
          changes,
          guardChanges(name, allowed) {
            const parsed = changeGuardSchema.safeParse({ name, allowed });
            if (!parsed.success) {
              s.guard('invalid collateral guard', false);
              throw parsed.error;
            }
            const rules = parsed.data.allowed;
            return s.guard(parsed.data.name, changes().every((change) => {
              const matching = rules.filter((rule) => rule.entity === change.entity && rule.id === change.id && rule.kind === change.kind);
              return matching.length > 0 && change.fields.every((field) => matching.some((rule) => rule.fields.includes(field)));
            }));
          },
          trace: traceFn,
          goal: s.goal,
          guard: s.guard,
          score: s.score,
          now: () => nowIso,
          time: timeMath,
        })));
  } catch (e) {
    if (e instanceof SnippetFault) return { ok: false, issue: e.issue };
    const message = messageOf(e);
    return { ok: false, issue: issue('snippet.runtime_error', path, { message }, `threw ${message}`) };
  }
  if (typeof score !== 'number' || Number.isNaN(score) || score < 0 || score > 1) {
    return { ok: false, issue: issue('task.grader_out_of_range', path, { score }, show(score)) };
  }
  // The engine's own guard over the task's declared allowances (YOS-156), after the grader's, so a grader cannot skip it.
  const allows = t.task.allows;
  if (allows !== undefined) {
    const rowOf = (state: State, entity: string, id: string): Row | undefined => [...(state.tables[entity]?.values() ?? [])].find((r) => r.id === id);
    s.guard(allowsGuard(taskId), changes().every((change) => {
      const row = rowOf(change.kind === 'created' ? end : seed, change.entity, change.id);
      return allows.some((a) => a.entity === change.entity && a.kind === change.kind &&
        (change.kind !== 'updated' || change.fields.every((f) => a.fields.includes(f))) &&
        Object.entries(a.where ?? {}).every(([f, v]) => row !== undefined && (row[f] ?? null) === v));
    }));
  }
  // A failed guard is a hard gate: it zeroes the score even when the grader returns its own number.
  const final = s.failedGuard() ? 0 : score;
  const recorded = s.goals.length + s.guards.length > 0 ? { goals: s.goals, guards: s.guards } : {};
  return { ok: true, graded: { ok: true, score: final, ...recorded }, readTrace };
}

/**
 * Score one end state. Used by `/_world/grade/:task` and by verifyTask. `journal` attributes
 * changes to calls or jobs; without one, every change counts as a call. `log` is the same run's
 * call log; with `journal` it gives ctx.trace(). Without one the trace is empty.
 */
export function grade(
  world: World,
  seed: State,
  end: State,
  taskId: string,
  host: SnippetHost,
  journal: OriginJournal = [],
  log: readonly CallRecord[] = [],
): Graded {
  const r = gradeRun(world, seed, end, taskId, host, journal, log);
  return r.ok ? r.graded : r;
}

/**
 * The State a dump describes. Rows keep their fields; tables follow the world's entities.
 * Throws an Error naming the problem when the dump is not one a runtime could have produced.
 * A dump without `hash` is taken as it is. A dump with one must hash to it: stateHash of the
 * rebuilt state (tables, counters and idempotency evidence, not `now`), so an edited or truncated dump is refused.
 * `world` is informational: a dump of another world fails the hash check unless the two worlds
 * declare the same entities and the content matches.
 */
export function stateFromDump(world: World, dump: DumpInput): State {
  const bad = (what: string): never => {
    throw new Error(`Not a state dump: ${what}`);
  };
  if (dump === null || typeof dump !== 'object') bad('expected an object with now, tables and counters');
  let now: State['now'];
  try {
    now = fromIso(dump.now as Iso);
  } catch {
    return bad(`now ${JSON.stringify(dump.now)} is not an ISO 8601 time`);
  }
  if (dump.tables === null || typeof dump.tables !== 'object') bad('tables must be an object of row arrays');
  if (dump.counters === null || typeof dump.counters !== 'object') bad('counters must be an object of numbers');
  const tables: Record<string, Map<RowId, Row>> = {};
  const counters: Record<string, number> = {};
  for (const entity of Object.keys(world.entities)) {
    const rows: unknown = Object.hasOwn(dump.tables, entity) ? dump.tables[entity] : [];
    if (!Array.isArray(rows)) return bad(`tables.${entity} must be an array of rows`);
    const table = new Map<RowId, Row>();
    for (const row of rows as unknown[]) {
      if (row === null || typeof row !== 'object' || typeof (row as { id?: unknown }).id !== 'string') bad(`a ${entity} row has no string id`);
      const r = Object.freeze({ ...(row as Row) });
      table.set(r.id, r);
    }
    tables[entity] = new Map([...table].sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)));
    const n: unknown = Object.hasOwn(dump.counters, entity) ? dump.counters[entity] : 0;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return bad(`counters.${entity} must be a whole number`);
    counters[entity] = n;
  }
  const idempotency = new Map<string, IdempotencyEntry>();
  const rawIdempotency: unknown = dump.idempotency ?? [];
  if (!Array.isArray(rawIdempotency)) return bad('idempotency must be an array of records');
  for (let i = 0; i < rawIdempotency.length; i++) {
    const raw: unknown = rawIdempotency[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad(`idempotency[${i}] must be an object`);
    const record = raw as { key?: unknown; fingerprint?: unknown; routeId?: unknown; response?: unknown };
    if (typeof record.key !== 'string') return bad(`idempotency[${i}].key must be a string`);
    if (idempotency.has(record.key)) return bad(`idempotency contains duplicate key ${JSON.stringify(record.key)}`);
    if (typeof record.fingerprint !== 'string') return bad(`idempotency[${i}].fingerprint must be a string`);
    if (record.routeId !== null && typeof record.routeId !== 'string') return bad(`idempotency[${i}].routeId must be a string or null`);
    if (!Object.hasOwn(record, 'response')) return bad(`idempotency[${i}].response is required`);
    let response: unknown;
    try {
      const encoded = JSON.stringify(record.response);
      if (encoded === undefined) return bad(`idempotency[${i}].response must be JSON-serializable`);
      response = JSON.parse(encoded);
    } catch {
      return bad(`idempotency[${i}].response must be JSON-serializable`);
    }
    idempotency.set(record.key, Object.freeze({
      fingerprint: record.fingerprint,
      routeId: record.routeId as string | null,
      response,
    }));
  }
  const state: State = { now, tables, counters, idempotency };
  const claimed: unknown = dump.hash;
  if (claimed === undefined) return state;
  if (typeof claimed !== 'string') return bad(`hash must be a string, found ${JSON.stringify(claimed) ?? String(claimed)}`);
  const actual = stateHash(state);
  if (actual !== claimed) return bad(`hash ${claimed} does not match its content, which hashes to ${actual}. The dump was edited, truncated or taken from another world`);
  return state;
}

/** The seeded state a runtime starts from: seed snippets run, clock at meta.clock.start. */
function startOf(world: World, host: SnippetHost): { ok: true; state: State } | { ok: false; issue: CheckIssue } {
  const r = seedState(world, host);
  return r.ok ? { ok: true, state: { ...r.state, now: fromIso(world.meta.clock.start) } } : r;
}

/** gradeDump's result: a score, plus a caveat when the score may count job changes as calls or missed the trace. */
export type GradedDump =
  | { ok: true; score: number; goals?: readonly GoalResult[]; guards?: readonly GuardResult[]; caveat?: string }
  | { ok: false; issue: CheckIssue };

/**
 * Score a dumped end state (such as `--state end.json`) against the world's seed. Pass the
 * runtime's `journal()` for the same span so ctx.changes() can skip job changes (A-28), and its
 * `log()` (GET /_world/log) so ctx.trace() sees the calls. Without a journal every change counts as
 * a call, so when a job could have fired between meta.clock.start and the dump's time the result
 * carries a caveat: a collateral check may have counted job changes. When the grader read
 * ctx.trace() without a log (empty trace), the result carries a caveat too: a history guard judged
 * a trace that is not the run's.
 */
export function gradeDump(
  world: World,
  taskId: string,
  dump: DumpInput,
  host: SnippetHost,
  journal?: OriginJournal,
  log?: readonly CallRecord[],
): GradedDump {
  const end = stateFromDump(world, dump);
  const seed = startOf(world, host);
  if (!seed.ok) return seed;
  const run = gradeRun(world, seed.state, end, taskId, host, journal ?? [], log ?? []);
  if (!run.ok) return run;
  const caveats: string[] = [];
  if (journal === undefined) {
    const start = fromIso(world.meta.clock.start);
    const mayHaveFired = (every: World['jobs'][string]['every']): boolean => {
      try {
        return start + parseDuration(every) <= end.now;
      } catch {
        return true; // an unparsable interval proves nothing, so keep the caveat
      }
    };
    const fired = Object.entries(world.jobs).filter(([, j]) => mayHaveFired(j.every)).map(([name]) => name);
    if (fired.length > 0) {
      caveats.push(`no journal given and job(s) ${fired.join(', ')} may have fired before ${dump.now}; their changes counted as calls, so a collateral check may have lowered this score`);
    }
  }
  if (run.readTrace && log === undefined) {
    caveats.push('no call log given, so ctx.trace() was empty; a history guard judged this state as if no call had been made');
  }
  return caveats.length === 0 ? run.graded : { ...run.graded, caveat: caveats.join('; ') };
}

// ---------------------------------------------------------------- client scripts

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const isHttpMethod = (m: unknown): m is HttpMethod => (HTTP_METHODS as readonly unknown[]).includes(m);

/** Thrown by a falsy ctx.assert to stop the script. The failure is recorded before the throw. */
class AssertFailure extends Error {}

/**
 * A ClientCtx over one runtime: only api, assert and now. `api` goes through Runtime.call, so
 * handle() and the clock tick apply exactly as for an agent. `failed` keeps the first failed
 * assert even if the script catches the throw.
 */
export function clientCtx(rt: Runtime): { ctx: ClientCtx; failed: () => string | null } {
  let failure: string | null = null;
  const ctx: ClientCtx = {
    api(method, path, body) {
      if (!isHttpMethod(method)) throw new Error(`ctx.api method must be one of ${HTTP_METHODS.join(', ')}, got ${JSON.stringify(method) ?? String(method)}`);
      if (typeof path !== 'string') throw new Error(`ctx.api path must be a string such as '/tickets', got ${JSON.stringify(path) ?? String(path)}`);
      const res = rt.call({ method, path, query: {}, body });
      return { status: res.status, body: res.body };
    },
    assert(condition, message) {
      if (condition) return;
      const text = String(message);
      failure ??= text;
      throw new AssertFailure(text);
    },
    now: () => rt.dump().now,
  };
  return { ctx, failed: () => failure };
}

/** A client run's end state, journal and calls; a failed run still carries the calls it made. */
/** `host`, except each handler records its action in `ran` whenever it actually runs. */
export function recordingHost(host: SnippetHost, ran: Set<string>): SnippetHost {
  return {
    compile(kind, source, path) {
      const c = host.compile(kind, source, path);
      if (!c.ok || kind !== 'handler') return c;
      const action = String(path[1]);
      const run: typeof c.run = (ctx) => {
        ran.add(action);
        return c.run(ctx);
      };
      return { ok: true, run };
    },
  };
}

type ClientRun =
  | { ok: true; end: State; journal: OriginJournal; log: readonly CallRecord[] }
  | { ok: false; issue: CheckIssue; log: readonly CallRecord[] };

/**
 * Runs one client script on a fresh runtime that starts at `seed`. A failed assert or any throw
 * is snippet.runtime_error at `path`; a SnippetFault keeps the sandbox's own issue.
 */
function runClient(world: CheckedWorld, seed: State, source: string, path: IssuePath, host: SnippetHost): ClientRun {
  const compiled = host.compile('client', source, path);
  if (!compiled.ok) return { ...compiled, log: [] };
  const rt = runtime(world, host, seed);
  const { ctx, failed } = clientCtx(rt);
  try {
    compiled.run(ctx);
  } catch (e) {
    if (e instanceof SnippetFault) return { ok: false, issue: e.issue, log: rt.log() };
    const asserted = failed();
    const message = asserted !== null ? `ctx.assert failed: ${asserted}` : messageOf(e);
    return { ok: false, issue: issue('snippet.runtime_error', path, { message }, `threw ${message}`), log: rt.log() };
  }
  const asserted = failed();
  if (asserted !== null) {
    const message = `ctx.assert failed: ${asserted}`;
    return { ok: false, issue: issue('snippet.runtime_error', path, { message }, `threw ${message}`), log: rt.log() };
  }
  return { ok: true, end: stateFromDump(world, rt.dump()), journal: rt.journal(), log: rt.log() };
}

// ---------------------------------------------------------------- discrimination

/** Which difficulties need at least one decoy (A-27). */
const DECOYS_REQUIRED: Readonly<Record<Difficulty, boolean>> = { easy: false, medium: true, hard: true };

/** The seq of every successful write in `log`: a call below 400 whose log entry lists committed rows. */
function writeSeqs(log: readonly CallRecord[]): number[] {
  return log.filter((c) => succeeded(c) && c.writes.length > 0).map((c) => c.seq);
}

/**
 * A hash of what a state holds for a grader: every row, but not the engine's created_at and
 * updated_at, the id counters or the clock. A decoy that writes and undoes a change, or reaches
 * the solution's rows by other calls, hashes like noop or the solution although its timestamps moved.
 */
function contentHash(state: State): string {
  const tables = Object.fromEntries(
    Object.entries(state.tables).map(([entity, rows]) => [
      entity,
      new Map([...rows].map(([id, row]) => [id, { ...row, created_at: null, updated_at: null }])),
    ]),
  );
  return stateHash({ now: state.now, tables, counters: {} });
}

/** Longest response body, as JSON, quoted in a 5xx hint. */
const BODY_MAX = 300;
const clip = (s: string): string => (s.length > BODY_MAX ? `${s.slice(0, BODY_MAX - 3)}...` : s);

/** A 5xx in a client run: where to fix it, the call as found, and its body as JSON, clipped. */
type ServerError = { readonly path: IssuePath; readonly call: string; readonly body: string };

/**
 * The first 5xx per endpoint in `log`, in call order. A 5xx from an action points at its handler;
 * any other points at `script`, the client script that made the call.
 */
function serverErrors(world: CheckedWorld, script: IssuePath, log: readonly CallRecord[]): ServerError[] {
  const seen = new Set<string>();
  const out: ServerError[] = [];
  for (const c of log) {
    if (c.res.status < 500 || seen.has(c.routeId ?? '')) continue;
    seen.add(c.routeId ?? '');
    const path: IssuePath = c.routeId !== null && Object.hasOwn(world.actions, c.routeId) ? ['actions', c.routeId, 'handler'] : script;
    out.push({ path, call: `${c.req.method} ${c.req.path} answered ${c.res.status}`, body: clip(show(c.res.body)) });
  }
  return out;
}

/**
 * Scores of the strict prefixes of a solution run: the state right after its k-th successful
 * write, for k = 1 .. writes - 1. One runtime replays `log` from `seed` in a single pass, re-issuing
 * its successful calls (reads too, so engine time matches the original run; refused calls changed
 * nothing). Stops at the first prefix that scores 1 or cannot be graded.
 */
function prefixScores(
  world: CheckedWorld,
  seed: State,
  taskId: string,
  host: SnippetHost,
  log: readonly CallRecord[],
  writes: readonly number[],
): { ok: true; scores: number[] } | { ok: false; issue: CheckIssue } {
  const scores: number[] = [];
  const strict = writes.slice(0, -1);
  if (strict.length === 0) return { ok: true, scores };
  const rt = runtime(world, host, seed);
  for (const c of log) {
    if (scores.length === strict.length) break;
    if (!succeeded(c)) continue;
    rt.call(c.req);
    if (c.seq !== strict[scores.length]) continue;
    const g = grade(world, seed, stateFromDump(world, rt.dump()), taskId, host, rt.journal(), rt.log());
    if (!g.ok) return g;
    scores.push(g.score);
    if (g.score === 1) break;
  }
  return { ok: true, scores };
}

/** A runtime that starts at `seed` and re-issues `log`'s successful calls, reads too, so engine time matches. */
function replaySolution(world: CheckedWorld, seed: State, host: SnippetHost, log: readonly CallRecord[]): Runtime {
  const rt = runtime(world, host, seed);
  for (const c of log) if (succeeded(c)) rt.call(c.req);
  return rt;
}

const COLLATERAL_KINDS = ['target_field', 'other_row', 'extra_action', 'extra_create', 'extra_delete'] as const;
type CollateralKind = (typeof COLLATERAL_KINDS)[number];
/** What a mutant kind builds its requests from: the seed, the solution's end state and its calls. */
type MutantInput = { readonly world: CheckedWorld; readonly seed: State; readonly end: State; readonly log: readonly CallRecord[] };

/** Requests one mutant kind tries after the solution. A refused request changes nothing, so the next is tried on the same replay. */
const MUTANT_TRIES = 32;

/** Rows the solution's successful calls wrote and did not delete, with the fields written. */
function writtenRows(log: readonly CallRecord[]): { entity: string; id: string; fields: Set<string> }[] {
  const rows = new Map<string, { entity: string; id: string; fields: Set<string> }>();
  for (const c of log.filter(succeeded)) {
    for (const w of c.writes) {
      const key = `${w.entity}/${w.id}`;
      if (w.op === 'deleted') {
        rows.delete(key);
        continue;
      }
      const row = rows.get(key) ?? { entity: w.entity, id: w.id, fields: new Set<string>() };
      for (const f of w.fields) row.fields.add(f);
      rows.set(key, row);
    }
  }
  return [...rows.values()];
}

const PATH_PARAM = /\{[^{}]+\}/g;

/**
 * Requests that each set one field the solution did not write on a row it wrote, through the
 * entity's update route. The value is the first seed row's value that differs, so the world already
 * holds it. Readonly and unique fields, and update routes nested under a parent, are not tried.
 */
function* targetFieldEdits({ world, seed, end, log }: MutantInput): Generator<ApiRequest> {
  for (const { entity, id, fields } of writtenRows(log)) {
    const route = Object.values(world.routes).find((r) => r.op === 'update' && r.entity === entity && r.path.match(PATH_PARAM)?.length === 1);
    const row = [...(end.tables[entity]?.values() ?? [])].find((r) => r.id === id);
    if (route === undefined || row === undefined) continue;
    const path = route.path.replace(PATH_PARAM, id);
    for (const [name, def] of Object.entries(world.entities[entity]?.fields ?? {})) {
      if (fields.has(name) || def.readonly || def.unique) continue;
      const value = [...(seed.tables[entity]?.values() ?? [])].map((r) => r[name]).find((v) => v !== undefined && v !== row[name]);
      if (value !== undefined) yield { method: route.method, path, query: {}, body: { [name]: value } };
    }
  }
}

/**
 * The solution's successful writes, last first, each re-issued with one path segment that names a
 * seed row swapped for each row of the same entity the solution neither wrote nor addressed.
 */
function* otherRowWrites({ seed, log }: MutantInput): Generator<ApiRequest> {
  const entityOf = new Map<string, string>();
  for (const [entity, rows] of Object.entries(seed.tables)) for (const id of rows.keys()) entityOf.set(id, entity);
  const writes = log.filter((c) => succeeded(c) && c.writes.length > 0);
  const touched = new Set([...writes.flatMap((c) => c.writes.map((w) => w.id)), ...writes.flatMap((c) => c.req.path.split('/'))]);
  for (const c of writes.reverse()) {
    const segments = c.req.path.split('/');
    for (const [i, segment] of segments.entries()) {
      const entity = entityOf.get(segment);
      if (entity === undefined) continue;
      for (const sibling of seed.tables[entity]?.keys() ?? []) {
        if (touched.has(sibling)) continue;
        const path = segments.map((s, j) => (j === i ? sibling : s)).join('/');
        yield { method: c.req.method, path, query: c.req.query, body: c.req.body };
      }
    }
  }
}

/** Each action the solution never called, with one path param, run on each row the solution wrote, with no input. */
function* extraActions({ world, log }: MutantInput): Generator<ApiRequest> {
  const called = new Set(log.filter(succeeded).map((c) => c.routeId));
  const rows = writtenRows(log);
  for (const [name, action] of Object.entries(world.actions)) {
    if (called.has(name) || action.path.match(PATH_PARAM)?.length !== 1) continue;
    for (const { id } of rows) yield { method: action.method, path: action.path.replace(PATH_PARAM, id), query: {}, body: {} };
  }
}

/**
 * One more row through each top-level create route, entities the solution wrote first: a copy of the
 * first seed row's writable fields. Unique fields and state fields are left out (a state starts at its
 * initial value), so an entity that requires a unique field is not tried.
 */
function* extraCreates({ world, seed, log }: MutantInput): Generator<ApiRequest> {
  const wrote = new Set(writtenRows(log).map((r) => r.entity));
  const routes = Object.values(world.routes).filter((r) => r.op === 'create' && r.path.match(PATH_PARAM) === null);
  for (const route of [...routes.filter((r) => wrote.has(r.entity)), ...routes.filter((r) => !wrote.has(r.entity))]) {
    const fields = Object.entries(world.entities[route.entity]?.fields ?? {});
    const template = seed.tables[route.entity]?.values().next().value;
    if (template === undefined || fields.some(([, def]) => def.unique && def.required)) continue;
    const body = Object.fromEntries(fields.filter(([name, def]) => !def.readonly && !def.unique && machineOf(def) === undefined && template[name] !== undefined && template[name] !== null).map(([name]) => [name, template[name]]));
    yield { method: route.method, path: route.path, query: {}, body };
  }
}

/** Each seed row the solution neither wrote nor addressed, deleted through its entity's delete route with one path param. */
function* extraDeletes({ world, seed, log }: MutantInput): Generator<ApiRequest> {
  const touched = touchedIds(log);
  for (const route of Object.values(world.routes)) {
    if (route.op !== 'delete' || route.path.match(PATH_PARAM)?.length !== 1) continue;
    for (const id of seed.tables[route.entity]?.keys() ?? []) if (!touched.has(id)) yield { method: route.method, path: route.path.replace(PATH_PARAM, id), query: {}, body: undefined };
  }
}

const MUTANTS: Readonly<Record<CollateralKind, (input: MutantInput) => Iterable<ApiRequest>>> = {
  target_field: targetFieldEdits, other_row: otherRowWrites, extra_action: extraActions, extra_create: extraCreates, extra_delete: extraDeletes,
};

const SWAP_KINDS = ['retarget', 'perturb'] as const;
type SwapKind = (typeof SWAP_KINDS)[number];
/** One solution call, by its index in the log, replaced by another request. */
type Swap = { readonly index: number; readonly req: ApiRequest; readonly label: string };

/** Which entity each seed row id belongs to. */
function entityOfIds(seed: State): Map<string, string> {
  const out = new Map<string, string>();
  for (const [entity, rows] of Object.entries(seed.tables)) for (const id of rows.keys()) out.set(id, entity);
  return out;
}

/** Ids the solution's successful writes wrote or addressed, which a retarget must avoid. */
function touchedIds(log: readonly CallRecord[]): Set<string> {
  const writes = log.filter((c) => succeeded(c) && c.writes.length > 0);
  return new Set([...writes.flatMap((c) => c.writes.map((w) => w.id)), ...writes.flatMap((c) => c.req.path.split('/'))]);
}

/** Each successful write, last first, with one path segment that names a seed row swapped for a row of the same entity the solution never touched (A-199). */
function* retargetSwaps({ seed, log }: MutantInput): Generator<Swap> {
  const entityOf = entityOfIds(seed);
  const touched = touchedIds(log);
  for (const [index, c] of [...log.entries()].reverse()) {
    if (!succeeded(c) || c.writes.length === 0) continue;
    const segments = c.req.path.split('/');
    for (const [i, segment] of segments.entries()) {
      const entity = entityOf.get(segment);
      if (entity === undefined) continue;
      for (const sibling of seed.tables[entity]?.keys() ?? []) {
        if (touched.has(sibling)) continue;
        const path = segments.map((s, j) => (j === i ? sibling : s)).join('/');
        yield { index, req: { ...c.req, path }, label: `${c.req.method} ${path} instead of ${c.req.path}` };
      }
    }
  }
}

/**
 * Each successful write, last first, with one body value that names a seed row swapped for another row of
 * that entity (A-199), such as a different assignee. Other values are never changed: an instruction often
 * leaves an enum, a boolean or a text field open, so a grader that ignores it is not wrong.
 */
function* perturbSwaps({ seed, log }: MutantInput): Generator<Swap> {
  const entityOf = entityOfIds(seed);
  for (const [index, c] of [...log.entries()].reverse()) {
    if (!succeeded(c) || c.writes.length === 0 || c.req.body === null || typeof c.req.body !== 'object' || Array.isArray(c.req.body)) continue;
    const body = c.req.body as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      const entity = typeof value === 'string' ? entityOf.get(value) : undefined;
      if (entity === undefined) continue;
      const others = [...(seed.tables[entity]?.keys() ?? [])].filter((id) => id !== value);
      for (const other of others) yield { index, req: { ...c.req, body: { ...body, [key]: other } }, label: `${c.req.method} ${c.req.path} with ${key} ${show(other)} instead of ${show(value)}` };
    }
  }
}

const SWAPS: Readonly<Record<SwapKind, (input: MutantInput) => Iterable<Swap>>> = { retarget: retargetSwaps, perturb: perturbSwaps };

/**
 * The engine's swap mutants (A-199): per kind, the solution's calls replayed from `seed` with one call
 * replaced, at most MUTANT_TRIES candidates. A candidate whose replaced call is refused, or that ends like
 * the solution or the noop, is skipped. The first other one is graded, and a score of 1 is
 * task.mutant_full_marks: the grader cannot tell that work from the solution's.
 */
function swapIssues(world: CheckedWorld, seed: State, taskId: string, host: SnippetHost, log: readonly CallRecord[], end: State): Probed {
  const out: CheckIssue[] = [];
  const probes: MutantProbe[] = [];
  const skip = new Set([contentHash(end), contentHash(seed)]);
  for (const kind of SWAP_KINDS) {
    let probe: MutantProbe = { kind, call: null, score: null };
    let tries = 0;
    for (const swap of SWAPS[kind]({ world, seed, end, log })) {
      if (tries++ === MUTANT_TRIES) break;
      const rt = runtime(world, host, seed);
      let refused = false;
      for (const [i, c] of log.entries()) {
        if (i === swap.index) refused = rt.call(swap.req).status >= 400;
        else if (succeeded(c)) rt.call(c.req);
      }
      if (refused) continue;
      const state = stateFromDump(world, rt.dump());
      if (skip.has(contentHash(state))) continue;
      const g = grade(world, seed, state, taskId, host, rt.journal(), rt.log());
      probe = { kind, call: swap.label, score: g.ok ? g.score : null };
      if (!g.ok) out.push(g.issue);
      else if (g.score === 1) out.push(issue('task.mutant_full_marks', ['tasks', taskId, 'grader'], { kind, call: swap.label }, `the solution with ${swap.label} scored 1`));
      break;
    }
    probes.push(probe);
  }
  return { issues: out, probes };
}

/**
 * The engine's collateral mutants: per kind, the solution's calls replayed from `seed`, then that
 * kind's requests in order until one commits a change a grader can see, at most MUTANT_TRIES. That
 * state is graded with the replay's own trace. A kind whose requests are all refused or change
 * nothing is skipped. Returns task.mutant_full_marks for each mutant that scores 1, and any grader fault.
 */
/** True when the task declares `allows` and the engine's guard over it held: the task's contract permits that change. */
function withinAllows(g: Graded, taskId: string): boolean {
  return g.ok && (g.guards ?? []).some((guard) => guard.name === allowsGuard(taskId) && guard.held);
}

/** A mutant pass's issues, and one probe per kind it ran. */
type Probed = { readonly issues: CheckIssue[]; readonly probes: MutantProbe[] };

function collateralIssues(world: CheckedWorld, seed: State, taskId: string, host: SnippetHost, log: readonly CallRecord[], end: State): Probed {
  const out: CheckIssue[] = [];
  const probes: MutantProbe[] = [];
  const solutionContent = contentHash(end);
  for (const kind of COLLATERAL_KINDS) {
    let probe: MutantProbe = { kind, call: null, score: null };
    let rt = replaySolution(world, seed, host, log);
    let tries = 0;
    for (const req of MUTANTS[kind]({ world, seed, end, log })) {
      if (tries++ === MUTANT_TRIES) break;
      if (rt.call(req).status >= 400) continue;
      const state = stateFromDump(world, rt.dump());
      // The call committed and ticked the clock, so the next request starts from a fresh replay.
      if (contentHash(state) === solutionContent) {
        rt = replaySolution(world, seed, host, log);
        continue;
      }
      const g = grade(world, seed, state, taskId, host, rt.journal(), rt.log());
      const call = req.body === undefined ? `${req.method} ${req.path}` : `${req.method} ${req.path} ${show(req.body)}`;
      probe = { kind, call, score: g.ok ? g.score : null };
      if (!g.ok) out.push(g.issue);
      else if (g.score === 1 && !withinAllows(g, taskId)) out.push(issue('task.mutant_full_marks', ['tasks', taskId, 'grader'], { kind, call }, `the solution plus ${call} scored 1`));
      break;
    }
    probes.push(probe);
  }
  return { issues: out, probes };
}

/**
 * Doing nothing while the solution's engine time passes (A-198): a fresh seed advanced by that time in whole
 * seconds, with due jobs firing, graded with the jobs' journal. Null when less than a second passes, since
 * that state is the plain noop's.
 */
function idleNoop(world: CheckedWorld, seed: State, end: State, taskId: string, host: SnippetHost):
  | { ok: true; score: number; seconds: number; jobsFired: readonly string[] }
  | { ok: false; issue: CheckIssue }
  | null {
  const seconds = Math.floor((end.now - seed.now) / 1000);
  if (seconds < 1) return null;
  const rt = runtime(world, host, seed);
  const { jobsFired } = rt.advance(`${seconds}s`);
  const g = grade(world, seed, stateFromDump(world, rt.dump()), taskId, host, rt.journal(), rt.log());
  return g.ok ? { ok: true, score: g.score, seconds, jobsFired } : g;
}

/** `found` for a decoy that writes but ends where noop or the solution ends. */
const TRIVIAL_FOUND: Readonly<Record<'same_as_noop' | 'same_as_solution', string>> = {
  same_as_noop: 'ends in the same state as doing nothing',
  same_as_solution: 'ends in the same state as the solution',
};

/**
 * Verifies one task from `seed`. It fails unless all of these hold: medium and hard tasks have a
 * decoy; the solution scores exactly 1 and gets no 5xx; doing nothing scores exactly 0; two
 * solution runs end in the same state hash; every strict prefix of the solution's successful
 * writes scores below 1; every decoy runs, gets no 5xx, writes, ends unlike both noop and the
 * solution (unless the grader read ctx.trace() for it), and scores below 1; each collateral mutant
 * scores below 1 (checked only when the solution scores 1 and noop 0). Each run is graded with
 * its own trace: the solution's, each prefix replay's, each decoy's, and an empty one for noop. On
 * success `log` is the first solution run's calls and `exercised` the actions whose handlers that
 * run actually ran.
 */
/** Entities whose list route a call in `log` reached with the world's limit, cursor, starting_after or ending_before parameter. */
function pagedEntities(world: World, log: readonly CallRecord[]): readonly string[] {
  const list = world.meta.api.list;
  const params = [list.limitParam, list.cursorParam, list.startingAfterParam, list.endingBeforeParam];
  const out = new Set<string>();
  for (const call of log) {
    const route = call.routeId !== null && Object.hasOwn(world.routes, call.routeId) ? world.routes[call.routeId] : undefined;
    const query = queryOf(call.req);
    if (route?.op === 'list' && query !== null && params.some((p) => query.has(p))) out.add(route.entity);
  }
  return [...out].sort();
}

/**
 * What a solution's trace shows about its reach: how many distinct rows its successful calls changed,
 * the entities where it changed a row that appeared only in a later-page list response (a call
 * with a cursor, starting_after or ending_before) and never on a first page, and the entities where a
 * list call with at least one of its route's filters returned a row the solution did not change, among
 * entities it changed rows of.
 */
function traceCoverage(world: World, log: readonly CallRecord[]): { solutionRowsChanged: number; solutionLaterPageEntities: readonly string[]; solutionDistractorEntities: readonly string[] } {
  const list = world.meta.api.list;
  const pageParams = [list.cursorParam, list.startingAfterParam, list.endingBeforeParam];
  const seen = { first: new Set<string>(), later: new Set<string>(), filtered: new Set<string>() };
  const changed = new Set<string>();
  for (const call of log) {
    if (!succeeded(call)) continue;
    for (const w of call.writes) changed.add(`${w.entity}/${w.id}`);
    const route = call.routeId !== null && Object.hasOwn(world.routes, call.routeId) ? world.routes[call.routeId] : undefined;
    const query = queryOf(call.req);
    const body = call.res.body;
    if (route?.op !== 'list' || query === null || typeof body !== 'object' || body === null) continue;
    const rows = (body as Record<string, unknown>)[list.dataKey];
    if (!Array.isArray(rows)) continue;
    const into = pageParams.some((p) => query.has(p)) ? seen.later : seen.first;
    const filtered = route.filters.some((f) => query.has(f));
    for (const r of rows) {
      if (typeof r !== 'object' || r === null || typeof (r as Record<string, unknown>)['id'] !== 'string') continue;
      const key = `${route.entity}/${String((r as Record<string, unknown>)['id'])}`;
      into.add(key);
      if (filtered) seen.filtered.add(key);
    }
  }
  const later = [...changed].filter((k) => seen.later.has(k) && !seen.first.has(k)).map((k) => k.slice(0, k.indexOf('/')));
  // Only an entity the solution changed rows of has near-duplicates: an unchanged lookup row (the customer that scopes a ticket search) competes with no target.
  const targeted = new Set([...changed].map((k) => k.slice(0, k.indexOf('/'))));
  const distractors = [...seen.filtered].filter((k) => !changed.has(k)).map((k) => k.slice(0, k.indexOf('/'))).filter((e) => targeted.has(e));
  return { solutionRowsChanged: changed.size, solutionLaterPageEntities: [...new Set(later)].sort(), solutionDistractorEntities: [...new Set(distractors)].sort() };
}

export function verifyTask(
  world: CheckedWorld,
  seed: State,
  taskId: string,
  host: SnippetHost,
): { ok: true; verdict: TaskVerdict; log: readonly CallRecord[]; exercised: readonly string[] } | { ok: false; issues: NonEmpty<CheckIssue> } {
  const t = taskOf(world, taskId);
  if (!t.ok) return { ok: false, issues: [t.issue] };
  const task = t.task;
  // A bare task (the public form of a world, YOS-159) has no solution to run and no grader to score it.
  if (task.grader === undefined || task.solution === undefined) {
    return { ok: false, issues: [issue('task.instruction_only', ['tasks', taskId], {}, 'the task carries no grader or no solution')] };
  }
  const issues: CheckIssue[] = [];
  const key = (i: CheckIssue): string => JSON.stringify([i.code, i.path, i.found]);
  // A grader fault on several states is one fix, so the same issue is kept once.
  const push = (i: CheckIssue): void => {
    if (!issues.some((x) => key(x) === key(i))) issues.push(i);
  };
  /** Ends verification with every issue so far plus `last`. */
  const stop = (last: CheckIssue): { ok: false; issues: NonEmpty<CheckIssue> } => {
    push(last);
    const [head = last, ...rest] = issues;
    return { ok: false, issues: [head, ...rest] };
  };
  const taskPath: IssuePath = ['tasks', taskId];
  if (DECOYS_REQUIRED[task.difficulty] && task.decoys.length === 0) {
    push(issue('task.decoy_required', [...taskPath, 'decoys'], { difficulty: task.difficulty }, `no decoys on a ${task.difficulty} task`));
  }

  const solutionPath: IssuePath = [...taskPath, 'solution'];
  const ran = new Set<string>();
  const first = runClient(world, seed, task.solution, solutionPath, recordingHost(host, ran));
  for (const e of serverErrors(world, solutionPath, first.log)) {
    push(issue('task.reference_server_error', e.path, { task: taskId, call: e.call, body: e.body }, e.call));
  }
  if (!first.ok) return stop(first.issue);
  const second = runClient(world, seed, task.solution, solutionPath, host);
  if (!second.ok) return stop(second.issue);
  const hash = stateHash(first.end);
  const replay = stateHash(second.end);
  if (hash !== replay) push(issue('task.nondeterministic', solutionPath, { first: hash, second: replay }, `end state ${hash}, then ${replay}`));

  const solution = grade(world, seed, first.end, taskId, host, first.journal, first.log);
  if (!solution.ok) push(solution.issue);
  else if (solution.score !== 1) push(issue('task.solution_not_full_marks', taskPath, { score: solution.score }, `solution scored ${solution.score}`));
  const noop = grade(world, seed, seed, taskId, host, [], []);
  if (!noop.ok) push(noop.issue);
  else if (noop.score !== 0) push(issue('task.noop_not_zero', taskPath, { score: noop.score }, `doing nothing scored ${noop.score}`));

  for (const [i, alt] of task.alternatives.entries()) {
    const altPath: IssuePath = [...taskPath, 'alternatives', i];
    const run = runClient(world, seed, alt.script, [...altPath, 'script'], host);
    if (!run.ok) {
      push(run.issue);
      continue;
    }
    const g = grade(world, seed, run.end, taskId, host, run.journal, run.log);
    if (!g.ok) push(g.issue);
    else if (g.score !== 1) push(issue('task.alternative_not_full_marks', altPath, { why: alt.why, score: g.score }, `alternative scored ${g.score}`));
  }

  // A grader that already fails the plain noop is broken at the root; the idle noop would only repeat it (A-198).
  const idle = noop.ok && noop.score === 0 ? idleNoop(world, seed, first.end, taskId, host) : null;
  if (idle !== null && !idle.ok) push(idle.issue);
  else if (idle !== null && idle.score !== 0) {
    push(issue('task.idle_not_zero', taskPath, { seconds: idle.seconds, jobsFired: idle.jobsFired }, `doing nothing for ${idle.seconds} s scored ${idle.score}`));
  }

  const writes = writeSeqs(first.log);
  const firstWrite = writes[0] ?? Infinity;
  const readsBeforeWrite = first.log.filter((c) => c.seq < firstWrite && c.req.method === 'GET' && succeeded(c)).length;
  let bestPrefixScore: number | null = null;
  if (solution.ok && solution.score === 1) {
    const prefixes = prefixScores(world, seed, taskId, host, first.log, writes);
    if (!prefixes.ok) push(prefixes.issue);
    else {
      const full = prefixes.scores.indexOf(1);
      if (full >= 0) {
        const k = full + 1;
        push(issue('task.prefix_full_marks', taskPath, { writes: k, of: writes.length }, `the first ${k} of ${writes.length} writes scored 1`));
      }
      if (prefixes.scores.length > 0) bestPrefixScore = Math.max(...prefixes.scores);
    }
  }

  const decoys: { why: string; score: number }[] = [];
  const probes: MutantProbe[] = [];
  if (solution.ok) {
    const noopContent = contentHash(seed);
    const solutionContent = contentHash(first.end);
    for (const [i, d] of task.decoys.entries()) {
      const decoyPath: IssuePath = [...taskPath, 'decoys', i];
      const scriptPath: IssuePath = [...decoyPath, 'script'];
      const run = runClient(world, seed, d.script, scriptPath, host);
      // A decoy that scores below 1 only because the server failed proves nothing about the grader.
      const crashed = serverErrors(world, scriptPath, run.log);
      for (const e of crashed) push(issue('task.decoy_server_error', e.path, { task: taskId, why: d.why, call: e.call, body: e.body }, e.call));
      if (!run.ok) {
        push(run.issue);
        continue;
      }
      if (crashed.length > 0) continue;
      const r = gradeRun(world, seed, run.end, taskId, host, run.journal, run.log);
      if (!r.ok) {
        push(r.issue);
        continue;
      }
      const g = r.graded;
      decoys.push({ why: d.why, score: g.score });
      // A trivial decoy proves nothing about the grader, so its triviality is the issue even at full marks.
      if (writeSeqs(run.log).length === 0) {
        const n = run.log.length;
        push(issue('task.decoy_trivial', decoyPath, { why: d.why, reason: 'no_successful_write' }, `no successful write in ${n} call${n === 1 ? '' : 's'}`));
        continue;
      }
      // A grader that read ctx.trace() can tell runs apart that end alike, so the end state proves no triviality.
      const content = r.readTrace ? null : contentHash(run.end);
      const reason = content === noopContent ? 'same_as_noop' : content === solutionContent ? 'same_as_solution' : null;
      if (reason !== null) push(issue('task.decoy_trivial', decoyPath, { why: d.why, reason }, TRIVIAL_FOUND[reason]));
      else if (g.score === 1) push(issue('task.decoy_full_marks', decoyPath, { why: d.why }, 'decoy scored 1'));
    }
  }
  // After the decoys, which the author declared and so name the more specific fix. A grader that
  // already fails noop is broken at the root, and collateral issues would only repeat it.
  if (solution.ok && solution.score === 1 && noop.ok && noop.score === 0) {
    for (const pass of [collateralIssues(world, seed, taskId, host, first.log, first.end), swapIssues(world, seed, taskId, host, first.log, first.end)]) {
      for (const i of pass.issues) push(i);
      probes.push(...pass.probes);
    }
  }

  const [head, ...rest] = issues;
  if (head) return { ok: false, issues: [head, ...rest] };
  const verdict = {
    taskId,
    difficulty: task.difficulty,
    solution: 1,
    noop: 0,
    decoys,
    bestPrefixScore,
    solutionCalls: first.log.length,
    solutionWrites: writes.length,
    solutionReadsBeforeWrite: readsBeforeWrite,
    solutionPagedEntities: pagedEntities(world, first.log),
    ...traceCoverage(world, first.log),
    collateral: probes,
    endStateHash: hash,
  } as unknown as TaskVerdict;
  return { ok: true, verdict, log: first.log, exercised: [...ran] };
}
