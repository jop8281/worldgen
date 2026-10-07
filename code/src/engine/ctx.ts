/**
 * The contract between the engine and world snippets (JS strings inside world.yaml).
 *
 * Each snippet kind has one TS interface (what the engine passes in) and one registry
 * of `{ sig, doc }` per member (what the model reads). The registry is typed
 * `Registry<Ctx>`, so a member present in one and missing in the other fails to compile.
 * The builders in api.ts, tasks.ts and check.ts return the interface, so a member
 * without an implementation also fails to compile. test/ctx.test.ts compiles the `sig`
 * strings against the interfaces, so a stale signature fails `npm test`.
 *
 * Invariants:
 * - `now()` is a function in every ctx and returns engine time as Iso.
 * - Snippets are synchronous. A returned Promise is an issue (`snippet.promise_returned`).
 * - Snippets reach time and randomness only through ctx. sandbox.ts removes everything else.
 * - Client scripts (tests, solutions, decoys) reach state only through `api`, the same
 *   path HTTP uses. Only tests may also move time (`advance`).
 */
import { z } from 'zod';
import type { Iso } from './clock.ts';
import type { Value } from './fields.ts';
import type { CheckIssue, IssuePath } from './issues.ts';
import type { Row } from './store.ts';

type Member = { readonly sig: string; readonly doc: string };
type Registry<C> = { readonly [K in keyof C]-?: Member };

export type Where = Readonly<Record<string, Value>>;
export interface ReadDb {
  get(entity: string, id: string): Row | null;
  list(entity: string, q?: { where?: Where }): readonly Row[];
}
export interface WriteDb extends ReadDb {
  create(entity: string, data: Record<string, unknown>): Row;
  update(entity: string, id: string, patch: Record<string, unknown>): Row;
  delete(entity: string, id: string): void;
}
export interface TimeMath {
  plus(t: Iso, d: string): Iso;
  minus(t: Iso, d: string): Iso;
  minutesBetween(a: Iso, b: Iso): number;
}
/**
 * One row-level difference between the seed and the end state. `origin` says who caused it:
 * an API call (and anything its handler wrote), or a job that fired when the clock moved.
 */
export type Change = {
  readonly entity: string;
  readonly id: string;
  readonly kind: 'created' | 'updated' | 'deleted';
  readonly fields: readonly string[];
  readonly origin: 'call' | 'job';
};
export const changeGuardSchema = z.object({
  name: z.string(),
  allowed: z.array(z.object({
    entity: z.string().min(1),
    id: z.string().min(1),
    kind: z.enum(['created', 'updated', 'deleted']),
    fields: z.array(z.string().min(1)).readonly(),
  }).strict()),
}).strict();
export type ChangeAllowance = z.infer<typeof changeGuardSchema>['allowed'][number];
export type ErrorStatus = 400 | 404 | 409 | 422;
/** One row a call committed: how, and which non-engine fields it wrote. */
export type TraceWrite = {
  readonly entity: string;
  readonly id: string;
  readonly kind: Change['kind'];
  readonly fields: readonly string[];
};
/**
 * One successful call of the graded run, in call order (design law L7). `seq` is its place in the
 * run's call log, so refused calls leave gaps. `writes` are the rows it committed, its handler's
 * writes included, as the runtime journal recorded them. Jobs are not calls and never appear.
 */
export type TraceCall = {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly routeId: string | null;
  readonly at: Iso;
  readonly body: unknown;
  readonly writes: readonly TraceWrite[];
};

const DB_SIG = 'get(entity, id) => Row | null; list(entity, { where? }) => Row[]';
const WRITE_SIG = `${DB_SIG}; create(entity, data) => Row; update(entity, id, patch) => Row; delete(entity, id)`;
const NOW = { sig: '() => string', doc: 'Engine time as ISO 8601. Never use Date.' } as const;
const TIME = {
  sig: 'plus(iso, "15m") => iso; minus(iso, "3d") => iso; minutesBetween(a, b) => number',
  doc: 'Pure date math on ISO strings. The offset is unsigned and may be zero, such as "0d", "45m" or "1d12h": plus moves later, minus moves earlier ("3d ago"). A signed offset such as "-5d" throws: use minus.',
} as const;

export interface HandlerCtx {
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
  db: WriteDb;
  now(): Iso;
  time: TimeMath;
  fail(status: ErrorStatus, code: string, message: string, extra?: { type?: string; param?: string }): never;
}
export const HANDLER_CTX = {
  params: { sig: 'Record<string, string>', doc: 'Path parameters, such as id in /tickets/{id}.' },
  query: { sig: 'Record<string, string>', doc: 'Query string parameters.' },
  body: { sig: 'Record<string, unknown>', doc: 'Request body, already validated against the action input.' },
  db: { sig: WRITE_SIG, doc: 'Every write enforces the data model. Any throw rolls back the whole call.' },
  now: NOW,
  time: TIME,
  fail: { sig: '(status: 400 | 404 | 409 | 422, code, message, extra?: { type?: string; param?: string }) => never', doc: 'Abort the call. Nothing is written. The optional extra fills $type and $param in the world error template.' },
} as const satisfies Registry<HandlerCtx>;

export interface JobCtx {
  db: WriteDb;
  now(): Iso;
  time: TimeMath;
}
export const JOB_CTX = {
  db: { sig: WRITE_SIG, doc: 'Runs in its own transaction when the clock passes the job time.' },
  now: NOW,
  time: TIME,
} as const satisfies Registry<JobCtx>;

export interface SeedCtx {
  rng(): number;
  pick<T>(xs: readonly T[]): T;
  int(lo: number, hi: number): number;
  rows(entity: string): readonly Row[];
  fixtures: Readonly<Record<string, readonly Readonly<Record<string, Value>>[]>>;
  now(): Iso;
  time: TimeMath;
}
export const SEED_CTX = {
  rng: { sig: '() => number', doc: 'Seeded random number in [0, 1). Never use Math.random.' },
  pick: { sig: '(xs) => x', doc: 'Seeded pick from a list.' },
  int: { sig: '(lo, hi) => number', doc: 'Seeded integer in [lo, hi].' },
  rows: { sig: '(entity) => Row[]', doc: 'Rows already seeded. The engine seeds entities in ref order.' },
  fixtures: { sig: 'Record<string, Row[]>', doc: 'Imported tables (CSV). Read-only.' },
  now: NOW,
  time: TIME,
} as const satisfies Registry<SeedCtx>;

export interface GraderCtx {
  db: ReadDb;
  seed: ReadDb;
  changes(opts?: { ignore?: readonly string[]; includeJobs?: boolean }): readonly Change[];
  guardChanges(name: string, allowed: readonly ChangeAllowance[]): boolean;
  trace(): readonly TraceCall[];
  goal(weight: number, name: string, ok: unknown): boolean;
  guard(name: string, ok: unknown): boolean;
  score(): number;
  now(): Iso;
  time: TimeMath;
}
export const GRADER_CTX = {
  db: { sig: DB_SIG, doc: 'End state, read-only.' },
  seed: { sig: DB_SIG, doc: 'Start state, read-only.' },
  changes: {
    sig: '({ ignore?: entity[], includeJobs?: boolean }?) => { entity, id, kind, fields, origin }[]',
    doc: 'Every row created, updated or deleted since seed, over all entities. Excludes engine fields (updated_at) and, by default, changes made by jobs. Use it for collateral checks.',
  },
  guardChanges: {
    sig: '(name: string, allowed: { entity: string; id: string; kind: "created" | "updated" | "deleted"; fields: readonly string[] }[]) => boolean',
    doc: 'Hard collateral guard over ctx.changes(): every change must match an exact entity, row id and kind, and every changed field must be explicitly allowed for that match. No wildcards. An empty list permits no changes. Engine fields and job changes are excluded, as in ctx.changes(). A failed guard makes the grade 0 even if the grader returns 1. Declare target fields and legitimate side effects separately; use ctx.trace() guards for history, including edits later undone.',
  },
  trace: {
    sig: '() => { seq, method, path, status, routeId, at, body, writes }[]',
    doc: 'The successful calls of the graded run, in order: seq in the call log, method, path as sent (query included), status, routeId (route or action id), at (engine time), body (request body or null) and writes ({ entity, id, kind, fields }[], the rows the call committed, handler writes included). Refused calls and jobs are left out. Empty on the untouched seed. Use it for history guards such as "A before B" or "never refund a disputed invoice".',
  },
  goal: {
    sig: '(weight: number, name: string, ok: unknown) => boolean',
    doc: 'Records a goal worth weight (above 0, at most 1) and returns whether ok is truthy. The weights of all goals should sum to 1.',
  },
  guard: {
    sig: '(name: string, ok: unknown) => boolean',
    doc: 'Records a condition that must hold, such as no collateral or A before B, and returns whether ok is truthy. Any failed guard makes the score 0, whatever the grader returns.',
  },
  score: {
    sig: '() => number',
    doc: 'The sum of the weights of met goals, rounded to 9 decimals, or 0 when a guard failed. Return it: guards, then goals, then return ctx.score().',
  },
  now: NOW,
  time: TIME,
} as const satisfies Registry<GraderCtx>;

export interface ClientCtx {
  api(method: string, path: string, body?: unknown): { status: number; body: unknown };
  assert(condition: unknown, message: string): void;
  now(): Iso;
}
const API = { sig: '(method, path, body?) => { status, body }', doc: 'Calls the public API through the same path as HTTP. The only way in.' } as const;
const ASSERT = { sig: '(condition, message) => void', doc: 'Fails the test with message when condition is falsy.' } as const;
export const CLIENT_CTX = { api: API, assert: ASSERT, now: NOW } as const satisfies Registry<ClientCtx>;

/** A world test. Unlike a task solution or decoy, it may move engine time to reach job-driven states. */
export interface TestCtx extends ClientCtx {
  advance(by: string): { jobsFired: readonly string[]; jobsFailed: readonly { job: string; at: Iso; message: string }[] };
}
export const TEST_CTX = {
  advance: {
    sig: '(duration) => { jobsFired: string[], jobsFailed: { job, at, message }[] }',
    doc: 'Moves engine time by a duration such as 15m or 4h and fires the jobs that fall due, like POST /_world/clock. Tests only: task solutions and decoys cannot move time.',
  },
  api: API,
  assert: ASSERT,
  now: NOW,
} as const satisfies Registry<TestCtx>;

/** Snippet kinds, their ctx, their return value, and their registry. */
export interface SnippetKinds {
  handler: { ctx: HandlerCtx; result: { status: number; body: unknown } };
  job: { ctx: JobCtx; result: void };
  seed: { ctx: SeedCtx; result: readonly Readonly<Record<string, unknown>>[] };
  grader: { ctx: GraderCtx; result: number };
  client: { ctx: ClientCtx; result: void };
  test: { ctx: TestCtx; result: void };
}
export type SnippetKind = keyof SnippetKinds;
export type Snippet<K extends SnippetKind> = (ctx: SnippetKinds[K]['ctx']) => SnippetKinds[K]['result'];

const CTX_BY_KIND: { readonly [K in SnippetKind]: Registry<SnippetKinds[K]['ctx']> } = {
  handler: HANDLER_CTX,
  job: JOB_CTX,
  seed: SEED_CTX,
  grader: GRADER_CTX,
  client: CLIENT_CTX,
  test: TEST_CTX,
};
const RETURNS: { readonly [K in SnippetKind]: string } = {
  handler: '{ status, body }',
  job: 'nothing',
  seed: 'an array of rows without id',
  grader: 'a number in [0, 1], such as ctx.score(). It must return 0 on the untouched seed.',
  client: 'nothing',
  test: 'nothing',
};

/** The doc string for one snippet kind. Rendered from the registry, never written by hand. */
export function snippetDoc(kind: SnippetKind): string {
  const members = Object.entries(CTX_BY_KIND[kind] as Record<string, Member>)
    .map(([name, m]) => `ctx.${name}: ${m.sig}. ${m.doc}`)
    .join('\n');
  return `JS function (ctx) => ... returning ${RETURNS[kind]}. Synchronous. No Date, Math.random, timers or imports.\n${members}`;
}

/** zod string field that holds a snippet of the given kind. Its description is the generated ctx doc. */
export const js = (kind: SnippetKind) => z.string().min(1).describe(snippetDoc(kind));

/**
 * Deterministic limits. The call quota is the budget a verdict depends on. The wall-clock
 * guard only stops runaway code and reports `snippet.timeout_guard`.
 */
export const SNIPPET_LIMITS = { ctxCallsPerRun: 20_000, guardMs: 2_000, maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } as const;

/**
 * How core code runs snippets. Core never imports node:vm. index.ts passes the vm-backed
 * host from sandbox.ts. This keeps tsconfig.engine-core.json free of Node types.
 */
export interface SnippetHost {
  compile<K extends SnippetKind>(
    kind: K,
    source: string,
    path: IssuePath,
  ): { ok: true; run: Snippet<K> } | { ok: false; issue: CheckIssue };
}

/**
 * Thrown by a snippet run when the snippet itself fails: a runtime error, a returned
 * Promise, the call quota or the wall-clock guard. Core code catches it without importing
 * sandbox.ts. Errors thrown by ctx members (ctx.fail, store enforcement) are not wrapped.
 */
export class SnippetFault extends Error {
  override readonly name = 'SnippetFault';
  readonly issue: CheckIssue;
  constructor(issue: CheckIssue) {
    super(`${issue.code}: ${issue.hint}`);
    this.issue = issue;
  }
}
