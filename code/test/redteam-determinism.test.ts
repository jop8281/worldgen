/**
 * Red-team: determinism and the snippet sandbox (G-06, G-18, G-20 to G-24).
 *
 * - Two runtimes over one checked world agree on every dump, response and log.
 * - Verdict endStateHash values are stable across checkWorld calls.
 * - Sandbox escapes, placed in seed, handler, job, grader and client snippets, end in a
 *   catalog issue (or a deterministic failure). None may give ok:true.
 * - Runaway snippets (busy loops, ctx loops, recursion, promises) end in their catalog code.
 *   Anything that can hang the process runs in a child process with a kill timer, so a
 *   broken engine fails these tests instead of hanging `bun run test`.
 *
 * Expected values are literals (codes, SNIPPET_LIMITS numbers copied from ctx.ts, FACTS)
 * or before/after comparisons of engine output.
 *
 * Ambiguities this file owns in the contract: RT-110 (work a snippet leaves behind or hands
 * to host code: late microtasks, import(), stale ctx, looping getters), RT-111 (`globalThis`
 * and the exact global set), RT-112 (host locale), RT-113 (host stack depth) and RT-114 (how
 * long a runaway snippet may hold up checkWorld or advance) and RT-115 (ctx.time on garbage).
 * It also uses RT-27, RT-35,
 * RT-42, RT-46, RT-62 and RT-86.
 */
import { after, afterEach, describe, it, type TestContext, type TestOptions } from 'node:test';
import { guardScale } from '../src/engine/sandbox.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  checkWorld,
  createRuntime,
  type ApiRequest,
  type CheckReport,
  type CheckedWorld,
  type IssueCode,
  type Runtime,
  type World,
} from '#engine';
import {
  CODE_DIR,
  ITER,
  PROBE,
  STRICT,
  available,
  baseOk,
  cap,
  checkedBase,
  clone,
  deepFreeze,
  failWithRepro,
  freshRuntime,
  isNotImplemented,
  opts,
  rng,
  seeds,
  type Rng,
  tsEvalArgs,
} from './redteam/harness.ts';
import { BAD_TASKS } from './redteam/graders.ts';
import { MUTATIONS } from './redteam/mutations.ts';
import { AGENT_SEED, FACTS, SNIPPETS, TASK_IDS, baseWorld } from './redteam/world.ts';

// ---------------------------------------------------------------------------------------
// Literals from the contract

/** ctx.ts SNIPPET_LIMITS, copied as literals. */
const GUARD_MS = 2_000;
const CALLS_PER_RUN = 20_000;
/** sandbox.ts WALL_BACKSTOP_FACTOR: the guard counts CPU time, and wall time only backs it up this many times over. */
const WALL_BACKSTOP_FACTOR = 15;
/**
 * RT-114: one guarded run ends within its wall backstop plus slack. The guard is guardMs of CPU time
 * (A-89), so how fast a runaway stops in wall time depends on how much CPU the machine gives it;
 * only the backstop is a load-independent wall bound. The fault code is asserted separately, so
 * this is the upper bound that proves the runaway was stopped. test/sandbox-starved.test.ts proves
 * the CPU accounting itself.
 */
const GUARD_SLACK_MS = 10_000;
/** A slow host scales the default guard (A-169), so the bound scales with it. */
const GUARD_BUDGET_MS = GUARD_MS * guardScale() * WALL_BACKSTOP_FACTOR + GUARD_SLACK_MS;
/** sandbox.ts SANDBOX_GLOBALS, copied as a literal. `globalThis` is RT-111. */
const ALLOWED_GLOBALS = [
  'Object', 'Array', 'Map', 'Set', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Symbol',
  'Error', 'TypeError', 'RangeError', 'RegExp', 'BigInt', 'Infinity', 'NaN', 'undefined',
  'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
] as const;
/** Globals the sandbox header and G-21 say are absent. */
const FORBIDDEN_GLOBALS = [
  'Date', 'Intl', 'WeakRef', 'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics', 'WebAssembly',
  'process', 'require', 'module', 'exports', 'global', 'Buffer', 'fetch', 'setTimeout', 'setInterval',
  'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'eval', 'Function', 'performance',
  'crypto', 'navigator', 'structuredClone',
] as const;

// ---------------------------------------------------------------------------------------
// Skip guards

/** checkWorld runs and the base world checks ok. Escape tests are meaningless otherwise. */
const BASE_OK: TestOptions = baseOk();
const RUNTIME: TestOptions = opts(BASE_OK, cap('createRuntime', 'runtime.call', 'runtime.dump', 'runtime.log', 'runtime.advance', 'runtime.reset'));
/**
 * The check layer that runs each snippet kind. A snippet whose layer is still a pass-through
 * never runs during checkWorld, so every "is stopped" assertion on it would fail for that
 * reason alone. Handlers run only through action calls made by the world tests.
 */
const SEED_RUNS: TestOptions = cap('check.seed');
const HANDLER_RUNS: TestOptions = cap('check.tests', 'runtime.actions');
const TASK_RUNS: TestOptions = cap('check.tasks');
const JOB_RUNS: TestOptions = cap('createRuntime', 'runtime.advance', 'runtime.dump');

// ---------------------------------------------------------------------------------------
// Small helpers

type Path = readonly (string | number)[];

function startsWith(path: Path, prefix: Path): boolean {
  return prefix.every((p, i) => path[i] === p);
}

function replaceOnce(src: string, find: string, repl: string): string {
  const i = src.indexOf(find);
  if (i < 0) throw new Error(`fixture snippet has no ${JSON.stringify(find)}`);
  return src.slice(0, i) + repl + src.slice(i + find.length);
}

function at<T>(rec: Readonly<Record<string, T>>, key: string): T {
  const v = rec[key];
  if (v === undefined) throw new Error(`fixture has no ${key}`);
  return v;
}

function summary(r: CheckReport): string {
  if (r.ok) return 'ok: true';
  return `ok: false, reached ${r.reached}: ${r.issues.map((i) => `${i.code} @ ${i.path.join('.')} (${i.hint.slice(0, 160)})`).join('; ')}`;
}

/** What two reports must agree on. Issue text is left out because `task.nondeterministic` puts state hashes in it (issues.ts). */
function reportKey(r: CheckReport): unknown {
  if (r.ok) {
    return {
      ok: true,
      verdicts: Object.entries(r.verdicts)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, v]) => [id, v.endStateHash, v.solutionCalls, v.bestPrefixScore, v.decoys.map((d) => d.score)]),
      warnings: r.warnings.map((w) => `${w.code}@${w.path.join('.')}`),
      // G-06: the whole report is deterministic, so stats and the test count are compared too.
      stats: r.stats,
      tests: r.tests,
    };
  }
  return { ok: false, reached: r.reached, issues: r.issues.map((i) => `${i.code}@${i.path.join('.')}`) };
}

/** The matching issue, or a problem string. */
function issueProblem(r: CheckReport, codes: readonly IssueCode[], prefix: Path | null): string | null {
  if (r.ok) return `expected one of ${codes.join(', ')}${prefix ? ` at ${prefix.join('.')}` : ''}, but the world checked ok`;
  const hit = r.issues.find((i) => codes.includes(i.code) && (prefix === null || startsWith(i.path, prefix)));
  return hit ? null : `expected one of ${codes.join(', ')}${prefix ? ` at ${prefix.join('.')}` : ''}, got ${summary(r)}`;
}

/** Like issueProblem, but the issue path may start with any of `prefixes`. */
function issueProblemAt(r: CheckReport, codes: readonly IssueCode[], prefixes: readonly Path[]): string | null {
  const where = prefixes.map((p) => p.join('.')).join(' or ');
  if (r.ok) return `expected one of ${codes.join(', ')} at ${where}, but the world checked ok`;
  const hit = r.issues.find((i) => codes.includes(i.code) && prefixes.some((p) => startsWith(i.path, p)));
  return hit ? null : `expected one of ${codes.join(', ')} at ${where}, got ${summary(r)}`;
}

/** The parts of a verdict that do not depend on the end state's content: scores and call counts. */
function verdictScores(r: CheckReport, id: string): unknown {
  if (!r.ok) return null;
  const v = r.verdicts[id];
  return v ? [v.solutionCalls, v.bestPrefixScore, v.decoys.map((d) => d.score)] : null;
}

function verdictHash(r: CheckReport, id: string): string | null {
  return r.ok ? (r.verdicts[id]?.endStateHash ?? null) : null;
}

function assertIssue(r: CheckReport, codes: readonly IssueCode[], prefix: Path | null): void {
  const p = issueProblem(r, codes, prefix);
  assert.equal(p, null, p ?? '');
}

function mutated(fn: (w: World) => void): World {
  const w = baseWorld();
  fn(w);
  return w;
}

function rowsOf(rt: Runtime, entity: string): readonly Record<string, unknown>[] {
  return (rt.dump().tables[entity] ?? []) as readonly Record<string, unknown>[];
}

/**
 * A detached copy of a dump. Every "before" snapshot goes through this, so an engine whose
 * dump() returns its live (or a shared) state object cannot pass a before/after comparison
 * by comparing that object with itself.
 */
function snap(rt: Runtime): ReturnType<Runtime['dump']> {
  return clone(rt.dump());
}

/** Engine time is on the fixture's calendar, never the host's (today is long after 2026-01). */
const ENGINE_DAY = /^2026-01-0[5-7]T/;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Keys a snippet may have planted on host intrinsics if it ran in the host realm. */
const HOST_TARGETS: readonly [string, object][] = [
  ['Object', Object],
  ['Object.prototype', Object.prototype],
  ['Array', Array],
  ['Array.prototype', Array.prototype],
  // ctx.now.constructor is host `Function` when ctx functions are host functions.
  ['Function', Function],
  ['Function.prototype', Function.prototype],
  ['String.prototype', String.prototype],
  ['Number.prototype', Number.prototype],
  ['Map.prototype', Map.prototype],
  ['Set.prototype', Set.prototype],
  ['Promise.prototype', Promise.prototype],
  ['RegExp.prototype', RegExp.prototype],
  ['Error', Error],
  ['Error.prototype', Error.prototype],
  ['TypeError.prototype', TypeError.prototype],
  ['JSON', JSON],
  ['Math', Math],
  ['globalThis', globalThis],
];
function hostPlanted(): string[] {
  const out: string[] = [];
  for (const [name, target] of HOST_TARGETS) {
    for (const k of Reflect.ownKeys(target)) if (typeof k === 'string' && k.startsWith('__rt_')) out.push(`${name}.${k}`);
  }
  return out;
}
/** Remove anything a leaking snippet planted, so one engine bug does not cascade. */
afterEach(() => {
  for (const [, target] of HOST_TARGETS) {
    for (const k of Reflect.ownKeys(target)) {
      if (typeof k === 'string' && k.startsWith('__rt_')) Reflect.deleteProperty(target, k);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Snippet placements

const PLACEMENTS = ['seed', 'handler', 'job', 'grader', 'client'] as const;
type Placement = (typeof PLACEMENTS)[number];
/** What must have landed for a snippet in each placement to run at all. */
const PLACEMENT_RUNS: Record<Placement, TestOptions> = {
  seed: SEED_RUNS,
  handler: HANDLER_RUNS,
  job: JOB_RUNS,
  grader: TASK_RUNS,
  client: TASK_RUNS,
};

/** A host-created object each snippet kind can reach through ctx. */
const HOST_OBJECT: Record<Placement, string> = {
  seed: "ctx.rows('agent')",
  handler: "ctx.db.list('ticket')",
  job: "ctx.db.list('ticket')",
  grader: "ctx.db.list('ticket')",
  client: "ctx.api('GET', '/tickets')",
};
/** A ctx call that should throw a host error. */
const TIME_THROWS = ["ctx.time.plus('not a date', 'soon')", "ctx.time.plus(ctx.now(), 'soon')", "ctx.time.minutesBetween('not a date', 'nor this')"];
/**
 * Ctx calls that should throw a host-made error, tried in order. Client scripts have no
 * ctx.time, so they try a cyclic and a BigInt body first (refused at the boundary, so the snippet
 * catches a boundary error, not a host-thrown one), and ctx.assert last (a failed assert may
 * also fail the script, which would make the client escape vacuous).
 */
const THROWING_CALLS: Record<Placement, readonly string[]> = {
  seed: TIME_THROWS,
  handler: TIME_THROWS,
  job: TIME_THROWS,
  grader: TIME_THROWS,
  client: [
    "ctx.api('POST', '/tickets', (() => { const o = { subject: 'x' }; o.self = o; return o; })())",
    "ctx.api('POST', '/tickets', { subject: 1n })",
    "ctx.assert(false, 'redteam probe')",
  ],
};
/** An expression whose value is the first error a THROWING_CALLS entry throws. Throws when none does. */
function caughtCtxError(p: Placement): string {
  return `(() => {
    for (const f of [${THROWING_CALLS[p].map((c) => `() => ${c}`).join(', ')}]) {
      try { f(); } catch (e) { return e; }
    }
    throw new Error('redteam: no ctx call threw');
  })()`;
}

/** Put `stmt` at the top of one snippet of the base world. */
function inject(w: World, p: Placement, stmt: string): void {
  switch (p) {
    case 'seed':
      w.seed['agent'] = replaceOnce(AGENT_SEED, 'ctx.rng();', `ctx.rng();\n  ${stmt}`);
      return;
    case 'handler':
      at(w.actions, 'escalate').handler = replaceOnce(SNIPPETS.escalate, '(ctx) => {', `(ctx) => {\n  ${stmt}`);
      return;
    case 'job':
      at(w.jobs, 'b').run = `(ctx) => {\n  ${stmt}\n  ctx.db.create('job_run', { job: 'b', at: ctx.now() });\n}`;
      return;
    case 'grader':
      at(w.tasks, 'pend_hd1005').grader = `(ctx) => {\n  ${stmt}\n  const g = ${SNIPPETS.easyGrader};\n  return g(ctx);\n}`;
      return;
    case 'client':
      at(w.tasks, 'pend_hd1005').solution = replaceOnce(SNIPPETS.easySolution, '(ctx) => {', `(ctx) => {\n  ${stmt}`);
      return;
  }
}

/** Which catalog codes, at which paths, count as "the escape was stopped" in each placement. */
const STOPPED: Record<Placement, { readonly codes: readonly IssueCode[]; readonly prefixes: readonly Path[] }> = {
  seed: { codes: ['snippet.runtime_error', 'snippet.compile_error'], prefixes: [['seed', 'agent']] },
  // A throwing handler fails the escalate call, which the world tests notice. The issue must
  // still sit on the handler or on a world test, not on some unrelated section.
  handler: { codes: ['snippet.runtime_error', 'snippet.compile_error', 'test.failed'], prefixes: [['actions', 'escalate'], ['tests']] },
  job: { codes: ['snippet.runtime_error', 'snippet.compile_error'], prefixes: [['jobs', 'b']] },
  grader: { codes: ['snippet.runtime_error', 'snippet.compile_error', 'task.grader_out_of_range'], prefixes: [['tasks', 'pend_hd1005']] },
  client: { codes: ['snippet.runtime_error', 'snippet.compile_error', 'task.solution_not_full_marks'], prefixes: [['tasks', 'pend_hd1005']] },
};

/**
 * Jobs do not run during check (clients cannot move the clock), so a job escape is judged
 * by running the job: after advance('1h') job b must not have written its row, and the
 * jobs before it keep theirs (G-29). Returns problems, or null when no runtime is available.
 */
function jobProblems(world: CheckedWorld, label: string): string[] | null {
  let rt: Runtime;
  try {
    rt = createRuntime(world);
  } catch (e) {
    if (isNotImplemented(e) && !STRICT) return null;
    throw e;
  }
  try {
    rt.advance('1h');
  } catch (e) {
    if (isNotImplemented(e) && !STRICT) return null;
    // RT-27: advance may throw when a job throws.
  }
  const jobs = rowsOf(rt, 'job_run').map((r) => r['job']);
  const problems: string[] = [];
  if (jobs.includes('b')) problems.push(`job: ${label} ran and job b committed its row`);
  if (!isDeepStrictEqual(jobs.filter((j) => j !== 'b'), ['a_late', 'a', 'a_late'])) {
    problems.push(`job: earlier jobs lost their rows when job b failed: ${JSON.stringify(jobs)}`);
  }
  return problems;
}

/** Check a world with `stmt` in placement p. Returns problems (empty when the escape was stopped). */
function placementProblems(t: TestContext, label: string, p: Placement, stmt: string, alsoStoppedBy: readonly IssueCode[] = []): string[] {
  const w = mutated((x) => inject(x, p, stmt));
  const r1 = checkWorld(clone(w));
  const r2 = checkWorld(clone(w));
  const problems: string[] = [];
  if (!isDeepStrictEqual(reportKey(r1), reportKey(r2))) {
    problems.push(`${p}: two checks disagree: ${JSON.stringify(reportKey(r1))} vs ${JSON.stringify(reportKey(r2))}`);
  }
  if (p === 'job' && r1.ok) {
    const jp = jobProblems(r1.world, label);
    if (jp === null) t.diagnostic('job placement not run: runtime is a stub');
    else problems.push(...jp);
    return problems;
  }
  const want = STOPPED[p];
  const ip = issueProblemAt(r1, [...want.codes, ...alsoStoppedBy], want.prefixes);
  if (ip) problems.push(`${p}: ${ip}`);
  return problems;
}

/** Run job b of a checked world. The job_run `job` column, or null when the runtime is a stub. */
function jobRows(world: CheckedWorld): unknown[] | null {
  try {
    const rt = createRuntime(world);
    rt.advance('1h');
    return rowsOf(rt, 'job_run').map((r) => r['job']);
  } catch (e) {
    if (isNotImplemented(e) && !STRICT) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------
// Child process runner, for anything that can hang or crash the process

type ChildIssue = { readonly code: string; readonly path: Path; readonly hint: string };
type ChildOut = {
  readonly ok?: boolean;
  readonly reached?: string;
  readonly issues?: readonly ChildIssue[];
  readonly hashes?: Readonly<Record<string, string>>;
  readonly ms?: number;
  readonly error?: string;
  readonly jobs?: readonly unknown[];
  readonly threw?: string;
  readonly advanceMs?: number;
  readonly dump?: unknown;
  /** Unhandled rejections the child saw. Recorded instead of crashing; asserted only under RT-110. */
  readonly unhandled?: readonly string[];
};
type ChildResult = { readonly out: ChildOut | null; readonly code: number | null; readonly killed: boolean; readonly stderr: string };

const CHILD_SCRIPT = `
import { checkWorld, createRuntime } from '#engine';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const [file, mode] = process.argv.slice(-2);
const world = JSON.parse(readFileSync(file, 'utf8'));
const out = { unhandled: [] };
process.on('unhandledRejection', (e) => { out.unhandled.push(String((e && e.message) || e).slice(0, 300)); });
let r = null;
const t0 = performance.now();
try { r = checkWorld(world); } catch (e) { out.error = 'checkWorld threw: ' + String((e && e.stack) || e).slice(0, 500); }
out.ms = performance.now() - t0;
if (r) {
  out.ok = r.ok;
  if (!r.ok) {
    out.reached = r.reached;
    out.issues = r.issues.map((i) => ({ code: i.code, path: i.path, hint: String(i.hint).slice(0, 300) }));
  } else {
    out.issues = [];
    out.hashes = Object.fromEntries(Object.entries(r.verdicts).map(([k, v]) => [k, v.endStateHash]));
    if (mode === 'advance') {
      const rt = createRuntime(r.world);
      const t1 = performance.now();
      try { rt.advance('1h'); } catch (e) { out.threw = String((e && e.message) || e).slice(0, 300); }
      out.advanceMs = performance.now() - t1;
      out.jobs = (rt.dump().tables.job_run || []).map((x) => x.job);
    }
    if (mode === 'dump') out.dump = createRuntime(r.world).dump();
  }
}
await new Promise((res) => setImmediate(res));
await new Promise((res) => setImmediate(res));
const settle = Number(process.env.REDTEAM_CHILD_SETTLE_MS || 0);
if (settle > 0) await new Promise((res) => setTimeout(res, settle));
process.stdout.write('\\nREDTEAM_CHILD ' + JSON.stringify(out) + '\\n');
`;

/** A hung engine never ends, so this only bounds the wait. A handler runaway is guarded once per world test, so a loaded machine needs minutes. */
const CHILD_KILL_MS = 300_000;
const childDirs: string[] = [];
after(async () => {
  for (const d of childDirs) await rm(d, { recursive: true, force: true });
});

/** checkWorld (and optionally advance or dump) in a fresh child process (Node or Bun), killed after CHILD_KILL_MS. */
async function inChild(world: unknown, mode: 'check' | 'advance' | 'dump' = 'check', env: Record<string, string> = {}): Promise<ChildResult> {
  const dir = await mkdtemp(join(tmpdir(), 'redteam-det-'));
  childDirs.push(dir);
  const file = join(dir, 'world.json');
  await writeFile(file, JSON.stringify(world));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, tsEvalArgs(CHILD_SCRIPT, [file, mode]), {
      cwd: CODE_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, CHILD_KILL_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('REDTEAM_CHILD '));
      const out = line ? (JSON.parse(line.slice('REDTEAM_CHILD '.length)) as ChildOut) : null;
      resolve({ out, code, killed, stderr: stderr.slice(-2000) });
    });
  });
}

/** Give a child time for a dynamic import() to settle before it reports. */
const SETTLE = { REDTEAM_CHILD_SETTLE_MS: '300' } as const;

/** A path in a fresh temp dir that nothing creates unless a snippet reached node:fs. */
async function markerPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'redteam-det-marker-'));
  childDirs.push(dir);
  return join(dir, 'leak.txt');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function childSummary(c: ChildResult): string {
  if (c.killed) return `child killed after ${CHILD_KILL_MS} ms (the engine hung the process)\n${c.stderr}`;
  if (!c.out) return `child exited ${c.code} without a result (crash?)\n${c.stderr}`;
  return JSON.stringify(c.out).slice(0, 1500);
}

/** The child finished cleanly and produced a result. */
function childOut(c: ChildResult): ChildOut {
  assert.equal(c.killed, false, childSummary(c));
  assert.ok(c.out, childSummary(c));
  assert.equal(c.out.error, undefined, childSummary(c));
  assert.equal(c.code, 0, `child exited ${c.code} after reporting (unhandled rejection or crash): ${childSummary(c)}`);
  return c.out;
}

function assertChildIssue(c: ChildResult, codes: readonly IssueCode[], prefix: Path | null): ChildOut {
  const out = childOut(c);
  assert.equal(out.ok, false, `expected one of ${codes.join(', ')}, but the world checked ok`);
  const hit = (out.issues ?? []).find((i) => (codes as readonly string[]).includes(i.code) && (prefix === null || startsWith(i.path, prefix)));
  assert.ok(hit, `expected one of ${codes.join(', ')}${prefix ? ` at ${prefix.join('.')}` : ''}, got ${childSummary(c)}`);
  return out;
}

function assertWithinGuard(out: ChildOut, what: string): void {
  assert.ok(typeof out.ms === 'number' && out.ms <= GUARD_BUDGET_MS, `${what}: checkWorld took ${out.ms} ms, budget ${GUARD_BUDGET_MS} ms`);
}

// =======================================================================================
// G-18 and G-20: runtimes agree

type Op = { readonly call: ApiRequest } | { readonly advance: string };

const req = (method: ApiRequest['method'], path: string, body: unknown = null, query: Record<string, string> = {}): ApiRequest => ({
  method,
  path,
  query,
  body,
});

/** Apply one op and capture the outcome, including a throw. */
function applyOp(rt: Runtime, op: Op): unknown {
  try {
    if ('call' in op) return rt.call(op.call);
    return rt.advance(op.advance);
  } catch (e) {
    return { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

type Ran = { results: unknown[]; dump: ReturnType<Runtime['dump']>; log: ReturnType<Runtime['log']> };

function runOps(rt: Runtime, ops: readonly Op[]): Ran {
  const results = ops.map((op) => clone(applyOp(rt, op)));
  return { results, dump: snap(rt), log: clone(rt.log()) };
}

const statusOf = (x: unknown): number | null =>
  x !== null && typeof x === 'object' && 'status' in x && typeof x.status === 'number' ? x.status : null;
const threwOf = (x: unknown): string | null =>
  x !== null && typeof x === 'object' && 'threw' in x && typeof x.threw === 'string' ? x.threw : null;

/**
 * Non-vacuity for a run: no runtime method threw (failed calls return the error envelope,
 * and the base world's jobs never throw), engine time stays on the fixture's calendar (a
 * wall-clock `now` or `at` would be in today's month), and every successful call is logged
 * with strictly increasing `seq` (RT-01). Returns problems.
 */
function runProblems(ran: Ran): string[] {
  const problems: string[] = [];
  ran.results.forEach((x, i) => {
    const t = threwOf(x);
    if (t !== null) problems.push(`op ${i + 1} threw: ${t}`);
  });
  if (!ENGINE_DAY.test(ran.dump.now)) problems.push(`dump.now ${ran.dump.now} is not engine time`);
  const ok = ran.results.filter((x) => {
    const s = statusOf(x);
    return s !== null && s >= 200 && s < 300;
  }).length;
  if (ran.log.length < ok) problems.push(`log has ${ran.log.length} records for ${ok} successful calls`);
  ran.log.forEach((c, i) => {
    if (!ENGINE_DAY.test(c.at)) problems.push(`log[${i}].at ${c.at} is not engine time`);
    const prev = ran.log[i - 1];
    if (prev && !(c.seq > prev.seq)) problems.push(`log seq does not increase at ${i}: ${prev.seq} then ${c.seq}`);
  });
  return problems;
}

/** Statuses G-11 and G-15 allow for a refused write. */
const REFUSED = [400, 404, 409, 422];

const FIXED_OPS: readonly Op[] = [
  { call: req('GET', '/tickets') },
  { call: req('GET', '/tickets', null, { status: 'open' }) },
  { call: req('PATCH', '/tickets/tkt_0001', { status: 'pending' }) },
  { call: req('PATCH', '/tickets/tkt_0002', { status: 'closed' }) },
  { call: req('POST', '/tickets/tkt_0002/escalate', { reason: 'probe', fail: true }) },
  { call: req('POST', '/tickets', { subject: 'Determinism probe', status: 'open', priority: 'low', ref_code: 'HD-2001' }) },
  { call: req('POST', '/tickets', { subject: 'Duplicate ref', status: 'open', priority: 'low', ref_code: 'HD-2001' }) },
  { advance: '1h' },
  { call: req('DELETE', '/agents/agt_0001') },
  { call: req('PATCH', '/tickets/tkt_9999', { priority: 'low' }) },
  { call: req('POST', '/tickets/tkt_0003/escalate', { reason: 'unassigned' }) },
  { call: req('PATCH', '/tickets/tkt_0003', { assignee: 'agt_0001' }) },
  { advance: '7m' },
  { call: req('GET', '/tickets/tkt_0003') },
];

function randomOps(r: Rng, n: number): Op[] {
  const ids = [...FACTS.ticketIds, 'tkt_0012', 'tkt_9999'];
  const agents = [...FACTS.agentIds, 'agt_9999'];
  const out: Op[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.pick(ids);
    switch (r.int(0, 9)) {
      case 0:
        out.push({ call: req('GET', '/tickets', null, r.bool() ? { status: r.pick(['open', 'pending', 'closed']) } : {}) });
        break;
      case 1:
        out.push({ call: req('GET', `/tickets/${id}`) });
        break;
      case 2:
        out.push({ call: req('PATCH', `/tickets/${id}`, { status: r.pick(['open', 'pending', 'closed']) }) });
        break;
      case 3:
        out.push({ call: req('PATCH', `/tickets/${id}`, { credit: r.pick([0, 25, -5, 1.5, '10']) }) });
        break;
      case 4:
        out.push({ call: req('PATCH', `/tickets/${id}`, { assignee: r.pick([...agents, null]) }) });
        break;
      case 5:
        out.push({ call: req('POST', `/tickets/${id}/escalate`, { reason: 'fuzz', fail: r.bool(0.3) }) });
        break;
      case 6:
        out.push({ call: req('POST', '/tickets', { subject: `Fuzz ${i}`, status: 'open', priority: 'low', ref_code: `HD-${r.int(2000, 2003)}` }) });
        break;
      case 7:
        out.push({ call: req('DELETE', r.bool() ? `/tickets/${id}` : `/agents/${r.pick(agents)}`) });
        break;
      case 8:
        out.push({ call: req('POST', '/agents', { name: `Fuzz ${i}`, email: `f${r.int(0, 2)}@example.test` }) });
        break;
      default:
        out.push({ advance: r.pick(['1s', '7m', '30m', '1h']) });
    }
  }
  return out;
}

describe('G-18 two runtimes agree', () => {
  it('G-18 two runtimes from one checked world have deep-equal dumps', RUNTIME, () => {
    const a = freshRuntime();
    const b = freshRuntime();
    const da = snap(a);
    assert.deepEqual(b.dump(), da);
    assert.deepEqual(a.log(), []);
    assert.deepEqual(b.log(), []);
    assert.equal(da.now, FACTS.clockStart);
    // Literal seed facts, so two empty (or two equally wrong) dumps do not pass.
    assert.deepEqual((da.tables['ticket'] ?? []).map((r) => r.id), [...FACTS.ticketIds]);
    assert.deepEqual((da.tables['agent'] ?? []).map((r) => r.id), [...FACTS.agentIds]);
    assert.deepEqual(da.tables['job_run'] ?? [], []);
  });

  it('G-18 two separately checked copies of the base world seed deep-equal dumps', RUNTIME, () => {
    const r1 = checkWorld(baseWorld());
    const r2 = checkWorld(deepFreeze(baseWorld()));
    assert.ok(r1.ok && r2.ok, `${summary(r1)} / ${summary(r2)}`);
    const d1 = snap(createRuntime(r1.world));
    assert.deepEqual(createRuntime(r2.world).dump(), d1);
    assert.equal(d1.now, FACTS.clockStart);
    assert.deepEqual((d1.tables['ticket'] ?? []).map((r) => r.id), [...FACTS.ticketIds]);
    assert.deepEqual((d1.tables['agent'] ?? []).map((r) => r.id), [...FACTS.agentIds]);
  });

  it('G-18 a fixed call sequence gives deep-equal responses, dumps and logs', RUNTIME, () => {
    const a = runOps(freshRuntime(), FIXED_OPS);
    const b = runOps(freshRuntime(), FIXED_OPS);
    assert.deepEqual(a.results, b.results);
    assert.deepEqual(a.dump, b.dump);
    assert.deepEqual(a.log, b.log);
    // Non-vacuity: two runtimes that throw on every call, or answer every call with the same
    // error, also agree. These are the hand-derived outcomes of FIXED_OPS on the base world.
    assert.deepEqual(runProblems(a), []);
    const st = a.results.map(statusOf);
    const expect: readonly [number, readonly number[], string][] = [
      [0, [200], 'GET /tickets'],
      [1, [200], 'GET /tickets?status=open'],
      [2, [200], 'open -> pending'],
      [3, REFUSED, 'open -> closed is not a declared transition (G-12)'],
      [4, [422], 'escalate with fail: true (G-09)'],
      [6, REFUSED, 'duplicate unique ref_code (G-11)'],
      [8, REFUSED, 'delete of a restrict-referenced agent (G-15)'],
      [9, [404], 'update of a missing id (RT-17)'],
      [10, [200], 'escalate tkt_0003'],
      [11, [200], 'assign tkt_0003'],
      [13, [200], 'GET /tickets/tkt_0003'],
    ];
    for (const [i, want, what] of expect) assert.ok(want.includes(st[i] ?? -1), `op ${i + 1} (${what}) gave ${JSON.stringify(a.results[i])}`);
    const created = a.results[5] as { status?: number; body?: { id?: unknown } } | undefined;
    assert.ok(created && typeof created.status === 'number' && created.status >= 200 && created.status < 300, `create gave ${JSON.stringify(created)}`);
    assert.equal(created.body?.id, FACTS.nextTicketId, 'create did not get the next counter id (G-10, G-17)');
    const open = a.results[1] as { body?: { data?: { id?: unknown }[] } } | undefined;
    assert.deepEqual((open?.body?.data ?? []).map((r) => r.id), FACTS.openTickets.slice(0, FACTS.ticketPageSize));
    // Runtime.advance returns { jobsFired } (api.ts). Other keys are not asserted.
    assert.deepEqual((a.results[7] as { jobsFired?: unknown } | undefined)?.jobsFired, [...FACTS.jobsAfter1h]);
    assert.deepEqual((a.results[12] as { jobsFired?: unknown } | undefined)?.jobsFired, []);
    // The shape of a get body is not documented, so the row is read from the dump.
    const t3: Readonly<Record<string, unknown>> = (a.dump.tables['ticket'] ?? []).find((r) => r.id === 'tkt_0003') ?? {};
    assert.deepEqual([t3['status'], t3['escalated'], t3['priority'], t3['assignee']], ['pending', true, 'urgent', FACTS.onCallAgent]);
    // start + 1h + 7m + one tick per committed write, plus at most a tick per GET (RT-02) or job (RT-24).
    assert.match(a.dump.now, /^2026-01-05T10:07:[0-5]\d\.000Z$/);
  });

  it('G-18 seeded random call sequences agree across two runtimes', RUNTIME, () => {
    let ok = 0;
    let refused = 0;
    for (const seed of seeds(Math.max(1, Math.min(ITER, 25)))) {
      const ops = randomOps(rng(seed), 30);
      const differs = (subset: readonly Op[]): boolean => !isDeepStrictEqual(runOps(freshRuntime(), subset), runOps(freshRuntime(), subset));
      if (differs(ops)) failWithRepro('G-18 two runtimes diverged on the same calls', seed, ops, differs);
      const ran = runOps(freshRuntime(), ops);
      const problems = runProblems(ran);
      if (problems.length > 0) {
        const bad = (subset: readonly Op[]): boolean => runProblems(runOps(freshRuntime(), subset)).length > 0;
        failWithRepro('G-18 a fuzz run threw or left engine time', seed, ops, bad, problems.join('; '));
      }
      for (const x of ran.results) {
        const s = statusOf(x);
        if (s !== null && s >= 200 && s < 300) ok++;
        if (s !== null && s >= 400 && s < 500) refused++;
      }
    }
    // Two runtimes that answer everything with the same error also "agree".
    assert.ok(ok > 0 && refused > 0, `fuzz is vacuous: ${ok} successful and ${refused} refused calls`);
  });

  it('G-18 calls and reset on one runtime never show up in another', RUNTIME, () => {
    const world = checkedBase();
    const worldBefore = clone(world);
    const a = createRuntime(world);
    const b = createRuntime(world);
    // Snapshots are copies: a dump() that returns live or shared state must not compare to itself.
    const bBefore = snap(b);
    const ranA = runOps(a, FIXED_OPS);
    assert.notDeepEqual(ranA.dump, bBefore, 'FIXED_OPS changed nothing on runtime A, so this test is vacuous');
    assert.deepEqual(b.dump(), bBefore, 'writes on runtime A changed runtime B');
    assert.deepEqual(b.log(), []);
    a.reset();
    assert.deepEqual(a.log(), [], 'reset did not clear the log (G-19)');
    assert.equal(a.dump().now, FACTS.clockStart, 'reset did not restore the clock (G-19)');
    runOps(b, FIXED_OPS.slice(0, 3));
    assert.notDeepEqual(snap(b), bBefore, 'the PATCH on runtime B changed nothing, so this test is vacuous');
    assert.deepEqual(a.dump(), bBefore, 'runtime A after reset does not match a fresh seed');
    assert.deepEqual(a.log(), [], 'calls on runtime B showed up in the log of runtime A');
    assert.deepEqual(createRuntime(world).dump(), bBefore, 'a third runtime does not start from the seed');
    assert.deepEqual(world, worldBefore, 'running calls mutated the CheckedWorld');
  });

  it('G-20 dumps taken at different wall times are equal and start at the world clock', RUNTIME, async () => {
    // Wall time passes between createRuntime and dump, so an engine that counts elapsed
    // host time from creation (or reset) moves `now`.
    const rt0 = freshRuntime();
    await sleep(60);
    const a = snap(rt0);
    assert.equal(a.now, FACTS.clockStart, 'now moved with wall time between createRuntime and dump');
    await sleep(60);
    assert.deepEqual(freshRuntime().dump(), a);
    const rt = freshRuntime();
    await sleep(60);
    const res = rt.call(req('PATCH', '/tickets/tkt_0001', { status: 'pending' }));
    assert.equal(res.status, 200, JSON.stringify(res));
    const first = snap(rt);
    // G-25: a committed write moves now by exactly one tick.
    assert.equal(first.now, '2026-01-05T09:00:01.000Z');
    const log = rt.log();
    assert.ok(log.length >= 1, 'the successful PATCH is not in the log (RT-01)');
    for (const c of log) assert.match(c.at, /^2026-01-05T09:00:0[01]\.000Z$/, 'a log record took its time from the wall clock');
    await sleep(60);
    rt.reset();
    await sleep(60);
    rt.call(req('PATCH', '/tickets/tkt_0001', { status: 'pending' }));
    assert.deepEqual(rt.dump(), first, 'the same write at a later wall time gave a different dump');
  });
});

// =======================================================================================
// G-06: verdict endStateHash stability

describe('G-06 verdict endStateHash is stable', () => {
  // Verdicts come from the tasks layer. While it is a pass-through, `verdicts` is empty.
  const HASHES = opts(BASE_OK, TASK_RUNS);

  it('G-06 every endStateHash is identical across checkWorld calls at different wall times', HASHES, async () => {
    const r1 = checkWorld(baseWorld());
    // Over a second, so a hash that folds in the wall clock at second resolution changes.
    await sleep(1_100);
    const r2 = checkWorld(deepFreeze(baseWorld()));
    const r3 = PROBE.baseReport;
    assert.ok(r1.ok && r2.ok, `${summary(r1)} / ${summary(r2)}`);
    assert.deepEqual(Object.keys(r1.verdicts).sort(), [...TASK_IDS].sort());
    for (const id of TASK_IDS) {
      const h: string | undefined = r1.verdicts[id]?.endStateHash;
      assert.equal(typeof h, 'string');
      assert.ok((h ?? '').length > 0, `${id} has an empty endStateHash`);
      assert.equal(r2.verdicts[id]?.endStateHash, h, `${id} hash changed between checks`);
      assert.ok(r3?.ok, 'the import-time probe of the base world did not check ok');
      assert.equal(r3.verdicts[id]?.endStateHash, h, `${id} hash differs from the import-time probe`);
    }
    assert.deepEqual(reportKey(r1), reportKey(r2));
    // G-06: the same input gives a deep-equal report, not only equal hashes.
    assert.deepEqual(r2, r1);
    // Another process, under another time zone and locale, gives the same hashes.
    const child = childOut(await inChild(baseWorld(), 'check', { TZ: 'Pacific/Kiritimati', LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8' }));
    assert.equal(child.ok, true, JSON.stringify(child).slice(0, 1500));
    assert.deepEqual(child.hashes, Object.fromEntries(TASK_IDS.map((id) => [id, r1.verdicts[id]?.endStateHash])));
  });

  it('G-06 endStateHash ignores grader and solution formatting that does not change the end state', HASHES, () => {
    const base = checkWorld(baseWorld());
    const w = baseWorld();
    for (const id of TASK_IDS) {
      const t = at(w.tasks, id);
      assert.ok(t.grader !== undefined && t.solution !== undefined, `${id}: the probe world must be the private form`);
      const grader = `\n\n  ${t.grader.replace('(ctx) => {', '(ctx) =>   {  /* reformatted */')}  \n`;
      const solution = t.solution.replace('(ctx) => {', '(ctx) => { /* same calls */ ');
      assert.ok(grader.includes('reformatted') && solution.includes('same calls'), `${id}: the reformatting did not apply, so this test is vacuous`);
      t.grader = grader;
      t.solution = solution;
    }
    const re = checkWorld(w);
    assert.ok(base.ok && re.ok, `${summary(base)} / ${summary(re)}`);
    for (const id of TASK_IDS) assert.equal(re.verdicts[id]?.endStateHash, base.verdicts[id]?.endStateHash, id);
  });

  it('G-06 endStateHash follows the end state: one extra field written changes only that task\'s hash', HASHES, () => {
    // A hash of the task id, or of the snippet source, passes the two tests above. This one
    // changes the end state of pend_hd1005 only (HD-1005 seeds priority 'high'; the grader
    // still scores 1 because it allows priority on the target ticket).
    const base = checkWorld(baseWorld());
    const changed = checkWorld(
      mutated((w) => {
        at(w.tasks, 'pend_hd1005').solution = replaceOnce(SNIPPETS.easySolution, "{ status: 'pending' }", "{ status: 'pending', priority: 'low' }");
        at(w.tasks, 'pend_hd1005').grader = replaceOnce(SNIPPETS.easyGrader, "f !== 'status'", "f !== 'status' && f !== 'priority'");
      }),
    );
    assert.ok(base.ok && changed.ok, `${summary(base)} / ${summary(changed)}`);
    assert.notEqual(verdictHash(changed, 'pend_hd1005'), verdictHash(base, 'pend_hd1005'), 'a different end state kept the same endStateHash');
    for (const id of ['pend_open_urgent', 'escalate_unassigned'] as const) {
      assert.equal(verdictHash(changed, id), verdictHash(base, id), `${id} hash changed although its end state did not`);
    }
  });

  it('G-06 endStateHash differs between tasks whose solutions end in different states', HASHES, () => {
    const r = checkWorld(baseWorld());
    assert.ok(r.ok, summary(r));
    const hashes = TASK_IDS.map((id) => r.verdicts[id]?.endStateHash);
    assert.equal(new Set(hashes).size, TASK_IDS.length, `hashes collide: ${JSON.stringify(hashes)}`);
  });
});

// =======================================================================================
// G-24: state cannot leak between snippet runs or between checks

type Leak = {
  readonly name: string;
  readonly mutate: (w: World) => void;
  readonly awaitBetween?: true;
  /**
   * G-24 and RT-35: when the leak world fails, one of these codes is reported at one of
   * `sites`: frozen intrinsics or strict mode refuse the write, or verification notices.
   */
  readonly codes: readonly IssueCode[];
  readonly sites: readonly Path[];
  /**
   * When the leak world checks ok, the leak must have had no effect: every verdict (scores
   * and endStateHash) equals that of one of these leak-free control worlds. Each control
   * spells out the value the snippet sees when every run starts clean (or when a write to a
   * frozen intrinsic is silently dropped in sloppy mode).
   */
  readonly controls: readonly ((w: World) => void)[];
  /** Extra checks on a checked-ok leak world, run when the runtime is available. */
  readonly afterOk?: (world: CheckedWorld) => void;
};

const PROTO_ROW = BAD_TASKS.find((b) => b.id === 'GR-nondeterministic-proto');
const SOLUTION_LEAK_CODES: readonly IssueCode[] = ['task.nondeterministic', 'snippet.runtime_error', 'task.solution_not_full_marks'];
const GRADER_LEAK_CODES: readonly IssueCode[] = ['task.nondeterministic', 'snippet.runtime_error', 'task.grader_out_of_range'];
const NO_CHANGE = (_w: World): void => {};
const subjectRun1 = (w: World): void => {
  at(w.tasks, 'pend_hd1005').solution = replaceOnce(SNIPPETS.easySolution, "{ status: 'pending' }", "{ status: 'pending', subject: 'run 1' }");
};
const benNamed = (name: string) => (w: World): void => {
  w.seed['agent'] = replaceOnce(AGENT_SEED, 'return rows;', `rows[1].name = ${JSON.stringify(name)};\n  return rows;`);
};
/** A pend_hd1005 grader that scores 0.5 from its second run on, if its counter survives runs. */
const countingGrader = (limit: number): string => `(ctx) => {
  globalThis.__rt_grades = (globalThis.__rt_grades || 0) + 1;
  const g = ${SNIPPETS.easyGrader};
  return globalThis.__rt_grades > ${limit} ? 0.5 : g(ctx);
}`;

const LEAKS: readonly Leak[] = [
  {
    name: 'a solution counting its runs on Array.prototype',
    mutate: (w) => {
      if (!PROTO_ROW) throw new Error('graders.ts has no GR-nondeterministic-proto');
      PROTO_ROW.mutate(w);
    },
    codes: [...SOLUTION_LEAK_CODES, ...(PROTO_ROW?.accept ?? [])],
    sites: [['tasks', 'pend_hd1005']],
    controls: [subjectRun1],
  },
  {
    name: 'a solution counting its runs in an implicit sloppy global',
    mutate: (w) => {
      at(w.tasks, 'pend_hd1005').solution = replaceOnce(
        SNIPPETS.easySolution,
        "{ status: 'pending' }",
        "{ status: 'pending', subject: 'run ' + (__rt_runs = (typeof __rt_runs === 'number' ? __rt_runs : 0) + 1) }",
      );
    },
    codes: SOLUTION_LEAK_CODES,
    sites: [['tasks', 'pend_hd1005']],
    controls: [subjectRun1],
  },
  {
    name: 'a grader counting its runs on globalThis across checks',
    mutate: (w) => (at(w.tasks, 'pend_hd1005').grader = countingGrader(6)),
    codes: GRADER_LEAK_CODES,
    sites: [['tasks', 'pend_hd1005']],
    controls: [NO_CHANGE],
  },
  {
    // One check grades pend_hd1005 at least on the noop, the solution and the decoy, so a
    // counter shared by the runs of one check gives 0.5 to one of them.
    name: 'a grader counting its runs on globalThis within one check',
    mutate: (w) => (at(w.tasks, 'pend_hd1005').grader = countingGrader(1)),
    codes: GRADER_LEAK_CODES,
    sites: [['tasks', 'pend_hd1005']],
    controls: [NO_CHANGE],
  },
  {
    name: 'a seed counting its runs on the Error constructor',
    mutate: (w) => {
      w.seed['agent'] = replaceOnce(AGENT_SEED, 'return rows;', "Error.__rt_seeds = (Error.__rt_seeds || 0) + 1;\n  rows[1].name = 'Ben ' + Error.__rt_seeds;\n  return rows;");
    },
    codes: ['snippet.runtime_error', 'task.nondeterministic'],
    sites: [['seed', 'agent'], ['tasks']],
    controls: [benNamed('Ben 1'), benNamed('Ben undefined')],
    // A runtime that seeds by running the seed snippet again must not see the old count.
    afterOk: (world) => {
      const names = [createRuntime(world), createRuntime(world)].map((rt) => rowsOf(rt, 'agent')[1]?.['name']);
      assert.ok(names.every((n) => n === 'Ben 1' || n === 'Ben undefined'), `runtimes seeded ${JSON.stringify(names)}: the seed count leaked`);
      assert.equal(names[0], names[1]);
    },
  },
  {
    name: 'a handler counting its calls on Object.prototype',
    mutate: (w) => {
      at(w.actions, 'escalate').handler = replaceOnce(
        SNIPPETS.escalate,
        '(ctx) => {',
        "(ctx) => {\n  Object.prototype.__rt_calls = (({}).__rt_calls || 0) + 1;\n  if (({}).__rt_calls > 4) ctx.fail(409, 'leaked', 'call count leaked between runs');",
      );
    },
    // Frozen Object.prototype in strict mode makes every escalate throw, which the world tests notice.
    codes: ['snippet.runtime_error', 'task.nondeterministic', 'test.failed'],
    sites: [['actions', 'escalate'], ['tests'], ['tasks']],
    controls: [NO_CHANGE],
  },
  {
    name: 'a seed that schedules a microtask which flips Array.prototype after the check',
    awaitBetween: true,
    mutate: (w) => {
      w.seed['agent'] = replaceOnce(AGENT_SEED, 'ctx.rng();', 'ctx.rng();\n  (async () => {})().then(() => { Array.prototype.__rt_late = true; });');
      at(w.tasks, 'pend_hd1005').grader = `(ctx) => {
  const g = ${SNIPPETS.easyGrader};
  return [].__rt_late === true ? 0.5 : g(ctx);
}`;
    },
    // A-195: the promise the seed starts is refused as snippet.promise_returned before the flip can land.
    codes: ['snippet.runtime_error', 'task.nondeterministic', 'snippet.promise_returned'],
    sites: [['seed', 'agent'], ['tasks']],
    controls: [NO_CHANGE],
  },
];

/** Every verdict's scores and hash, for comparing a leak world with its controls. */
function verdictsKey(r: CheckReport): unknown {
  return TASK_IDS.map((id) => [id, verdictScores(r, id), verdictHash(r, id)]);
}

/** G-24 on the first report of a leak world. Returns a problem, or null. */
function leakOutcomeProblem(r: CheckReport, leak: Leak): string | null {
  if (!r.ok) {
    const p = issueProblemAt(r, leak.codes, leak.sites);
    return p ? `the leak changed the outcome instead of being refused or reported: ${p}` : null;
  }
  const got = verdictsKey(r);
  const tried: unknown[] = [];
  for (const control of leak.controls) {
    const c = checkWorld(mutated(control));
    if (!c.ok) return `control world does not check: ${summary(c)}`;
    const want = verdictsKey(c);
    if (isDeepStrictEqual(got, want)) return null;
    tried.push(want);
  }
  return `the leak world checked ok but its verdicts match no leak-free control, so state leaked between runs unnoticed: got ${JSON.stringify(got)}, controls ${JSON.stringify(tried)}`;
}

describe('G-24 no state leaks across runs and checks', () => {
  for (const leak of LEAKS) {
    // G-06: the same input gives the same report, and checking never adds keys to host intrinsics.
    it(`G-06 G-24 ${leak.name} gives the same report on every check`, BASE_OK, async () => {
      const w = mutated(leak.mutate);
      const keys: unknown[] = [];
      let first: CheckReport | null = null;
      for (let i = 0; i < 3; i++) {
        const r = checkWorld(clone(w));
        first ??= r;
        keys.push(reportKey(r));
        if (leak.awaitBetween) {
          await tick();
          await tick();
        }
      }
      assert.deepEqual(keys[1], keys[0], 'second check differs from the first: state leaked between checks');
      assert.deepEqual(keys[2], keys[0], 'third check differs from the first: state leaked between checks');
      await tick();
      assert.deepEqual(hostPlanted(), [], 'snippet state reached the host realm');
    });

    // Three equal reports also come from an engine that leaks the same way inside every check.
    // RT-35 (A-195): every run gets a fresh context, so a leak is refused, reported, or has no effect.
    it(`G-24 RT-35 ${leak.name} is refused, reported, or has no effect`, opts(BASE_OK), () => {
      const r = checkWorld(mutated(leak.mutate));
      const p = leakOutcomeProblem(r, leak);
      assert.equal(p, null, p ?? '');
      // afterOk reads seeded rows, so it also needs the runtime to run the seed snippets.
      if (r.ok && leak.afterOk && (STRICT || (available('createRuntime') && available('runtime.dump') && available('runtime.seed')))) leak.afterOk(r.world);
    });
  }

  it('G-06 G-24 checking leaky worlds in between leaves base-world verdicts unchanged', BASE_OK, async () => {
    const before = reportKey(checkWorld(baseWorld()));
    // Earlier tests in this process already checked leaky worlds, so `before` alone could
    // already be polluted. The import-time probe ran before any snippet of this file.
    assert.ok(PROBE.baseReport, 'no import-time report of the base world');
    assert.deepEqual(before, reportKey(PROBE.baseReport), 'the base world report changed since import: earlier tests leaked state');
    for (const leak of LEAKS) {
      checkWorld(mutated(leak.mutate));
      await tick();
    }
    assert.deepEqual(reportKey(checkWorld(baseWorld())), before);
  });

  it('G-06 RT-86 snippets cannot plant keys on host intrinsics through ctx objects', opts(BASE_OK), () => {
    const results: string[] = [];
    const problems: string[] = [];
    for (const p of PLACEMENTS) {
      const stmt = `try { Object.getPrototypeOf(${HOST_OBJECT[p]}).__rt_poll_${p} = 1; } catch (e) {}
  try { Object.getPrototypeOf(Object.getPrototypeOf(ctx.now)).__rt_poll_${p} = 1; } catch (e) {}
  try { (${HOST_OBJECT[p]}).constructor.__rt_poll_${p} = 1; } catch (e) {}
  try { Object.getPrototypeOf(Object.getPrototypeOf(${HOST_OBJECT[p]})).__rt_poll_${p} = 1; } catch (e) {}
  try { Object.getPrototypeOf(ctx).__rt_poll_${p} = 1; } catch (e) {}
  try { Object.getPrototypeOf(ctx.now).__rt_poll_${p} = 1; } catch (e) {}
  try { ctx.now.constructor.__rt_poll_${p} = 1; } catch (e) {}`;
      const w = mutated((x) => inject(x, p, stmt));
      const r = checkWorld(w);
      // Every write is wrapped in try, so each world must check ok and every statement must
      // have run. Otherwise the probe never ran and an empty hostPlanted() proves nothing.
      if (!r.ok) problems.push(`${p}: the probe world does not check, so the probe never ran: ${summary(r)}`);
      if (r.ok && p === 'job') {
        const jobs = jobRows(r.world);
        if (jobs !== null && !jobs.includes('b')) problems.push(`job: job b did not run, so the probe never ran: ${JSON.stringify(jobs)}`);
      }
      results.push(`${p}: ${r.ok ? 'ok' : r.reached}`);
    }
    assert.deepEqual(hostPlanted(), [], `host intrinsics were polluted (${results.join(', ')})`);
    assert.deepEqual(problems, []);
  });
});

// =======================================================================================
// G-21: sandbox escapes in every snippet kind

/** alsoStoppedBy: issue codes besides STOPPED[p] that also show the escape never ran. */
type Escape = { readonly name: string; readonly expr: (p: Placement) => string; readonly alsoStoppedBy?: readonly IssueCode[] };

const ESCAPES: readonly Escape[] = [
  { name: 'Date', expr: () => 'Date.now()' },
  { name: 'Math.random', expr: () => 'Math.random()' },
  { name: 'process', expr: () => 'process.hrtime()' },
  { name: 'require', expr: () => "require('node:fs').readFileSync" },
  { name: 'this.constructor.constructor', expr: () => "this.constructor.constructor('return process')().pid" },
  { name: 'Function', expr: () => "Function('return 1')()" },
  { name: 'function literal constructor', expr: () => "(() => 0).constructor('return 1')()" },
  { name: 'eval', expr: () => "eval('1 + 1')" },
  // On a runtime without a promise hook (Bun) compile refuses any async source with
  // snippet.promise_returned, so the snippet is refused before it runs, which is what this row guards.
  { name: 'AsyncFunction constructor', expr: () => "(async () => {}).constructor('return 1')", alsoStoppedBy: ['snippet.promise_returned'] },
  { name: 'GeneratorFunction constructor', expr: () => "(function* () {}).constructor('yield 1')" },
  { name: 'cross-realm ctx.now.constructor', expr: () => "ctx.now.constructor('return process')().pid" },
  { name: 'cross-realm ctx.constructor.constructor', expr: () => "ctx.constructor.constructor('return process')().pid" },
  { name: 'cross-realm row.constructor', expr: (p) => `(${HOST_OBJECT[p]}).constructor.constructor('return process')().pid` },
  {
    // Vacuous if no ctx call throws: the control test below proves that one does.
    name: 'cross-realm caught error .constructor',
    expr: (p) => `${caughtCtxError(p)}.constructor.constructor('return process')().pid`,
  },
  {
    name: 'Error.prepareStackTrace host frames',
    expr: () => `(() => {
    const own = (() => 0).constructor;
    Error.prepareStackTrace = (e, cs) => cs;
    const cs = new Error('probe').stack;
    Error.prepareStackTrace = undefined;
    const host = Array.isArray(cs)
      ? cs.map((c) => (c.getFunction && c.getFunction()) || (c.getThis && c.getThis())).find((f) => f && f.constructor && f.constructor !== own && f.constructor.constructor !== own)
      : undefined;
    if (host) return (typeof host === 'function' ? host : host.constructor).constructor('return process')().pid;
    throw new Error('redteam: no host frame reachable');
  })()`,
  },
  { name: 'setTimeout', expr: () => 'setTimeout(() => {}, 0)' },
  { name: 'queueMicrotask', expr: () => 'queueMicrotask(() => {})' },
  { name: 'Intl', expr: () => 'Intl.DateTimeFormat().resolvedOptions().timeZone' },
  { name: 'WebAssembly', expr: () => 'typeof WebAssembly.Module' },
  { name: 'SharedArrayBuffer', expr: () => 'new SharedArrayBuffer(8)' },
  // The same escapes with names built at run time. An engine that refuses snippets by
  // scanning their source for `Date`, `process` or `constructor` passes every case above
  // and fails these, which reach the same objects without spelling the name.
  { name: 'Date by computed globalThis key', expr: () => "globalThis['Da' + 'te'].now()" },
  { name: 'process by computed globalThis key', expr: () => "globalThis[['pro', 'cess'].join('')].hrtime()" },
  { name: 'Math.random by computed key', expr: () => "Math['ran' + 'dom']()" },
  { name: 'function literal constructor by computed key', expr: () => "(() => 0)['constr' + 'uctor']('return 1')()" },
  { name: 'cross-realm ctx.now constructor by computed key', expr: () => "ctx.now['constr' + 'uctor']('return process')().pid" },
  {
    name: 'cross-realm ctx.now constructor through a property descriptor',
    expr: () => "Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx.now), 'constr' + 'uctor').value('return process')().pid",
  },
];

describe('G-21 sandbox escapes end in a catalog issue in every snippet kind', () => {
  // One test per placement, gated on the layer that runs that snippet kind, so each placement
  // is tested as soon as its unit lands.
  for (const esc of ESCAPES) {
    for (const p of PLACEMENTS) {
      it(`G-21 ${esc.name} in a ${p} is stopped`, opts(BASE_OK, PLACEMENT_RUNS[p]), (t) => {
        assert.deepEqual(placementProblems(t, esc.name, p, `void (${esc.expr(p)});`, esc.alsoStoppedBy), []);
        assert.deepEqual(hostPlanted(), [], 'G-06: checking added keys to host intrinsics');
      });
    }
  }

  it('G-21 control: a harmless statement in every snippet kind checks ok and job b runs', BASE_OK, () => {
    // Without this, an engine (or an inject() bug) that breaks any edited snippet makes every
    // escape test above pass, because a broken snippet also ends in a catalog issue.
    const w = baseWorld();
    for (const p of PLACEMENTS) inject(w, p, 'void (1 + 1);');
    const r = checkWorld(w);
    assert.equal(r.ok, true, summary(r));
    if (r.ok) {
      const jobs = jobRows(r.world);
      if (jobs !== null) assert.deepEqual(jobs, [...FACTS.jobsAfter1h]);
    }
  });

  it('G-21 RT-115 control: a ctx call throws a catchable error in seed, handler, job and grader', opts(BASE_OK), () => {
    // The caught-error escape is vacuous where no ctx call throws: it then throws its own
    // redteam error, which also counts as stopped. That date math on garbage throws is RT-115.
    const w = baseWorld();
    for (const p of ['seed', 'handler', 'job', 'grader'] as const) inject(w, p, `void ${caughtCtxError(p)};`);
    const r = checkWorld(w);
    assert.equal(r.ok, true, summary(r));
    if (r.ok) {
      const jobs = jobRows(r.world);
      if (jobs !== null) assert.deepEqual(jobs, [...FACTS.jobsAfter1h], 'job b found no throwing ctx call');
    }
  });

  it('G-21 forbidden globals are absent and allowed globals present in every snippet kind', BASE_OK, () => {
    const probe = `(() => {
    const present = [${FORBIDDEN_GLOBALS.map((n) => `[${JSON.stringify(n)}, typeof ${n}]`).join(', ')}]
      .filter(([, t]) => t !== 'undefined').map(([n]) => n);
    const missing = [${ALLOWED_GLOBALS.filter((n) => n !== 'undefined').map((n) => `[${JSON.stringify(n)}, typeof ${n}]`).join(', ')}]
      .filter(([, t]) => t === 'undefined').map(([n]) => n);
    // G-21: Math.random throws, and code generation from strings fails.
    try { Math.random(); present.push('Math.random did not throw'); } catch (e) {}
    try { (() => 0).constructor('return 1')(); present.push('Function from a string worked'); } catch (e) {}
    if (present.length || missing.length) throw new Error('present: ' + present.join(',') + ' missing: ' + missing.join(','));
  })();`;
    const w = baseWorld();
    for (const p of PLACEMENTS) inject(w, p, probe);
    const r = checkWorld(w);
    assert.equal(r.ok, true, summary(r));
    if (r.ok && (STRICT || available('runtime.advance'))) {
      // Job b must run here: the probe throws only when the sandbox is wrong.
      const rt = createRuntime(r.world);
      assert.deepEqual(rt.advance('1h').jobsFired, [...FACTS.jobsAfter1h]);
      assert.deepEqual(rowsOf(rt, 'job_run').map((x) => x['job']), [...FACTS.jobsAfter1h]);
    }
  });

  it('G-21 RT-111 the global object holds exactly SANDBOX_GLOBALS', opts(BASE_OK), () => {
    const allowed = [...ALLOWED_GLOBALS, 'globalThis'].sort();
    const w = baseWorld();
    inject(w, 'seed', `(() => {
    const allowed = ${JSON.stringify(allowed)};
    const extra = Object.getOwnPropertyNames(globalThis).filter((n) => !allowed.includes(n));
    if (extra.length) throw new Error('extra globals: ' + extra.join(','));
  })();`);
    const r = checkWorld(w);
    assert.equal(r.ok, true, summary(r));
  });

  it('G-22 import() returned from a seed is refused and does not crash the process', opts(BASE_OK, SEED_RUNS), async () => {
    // The promise is refused either way; the marker file shows whether node:fs was reached.
    const marker = await markerPath();
    const c = await inChild(
      mutated((w) => (w.seed['agent'] = `(ctx) => import('node:fs').then((fs) => { fs.writeFileSync(${JSON.stringify(marker)}, 'leak'); return []; })`)),
      'check',
      SETTLE,
    );
    assertChildIssue(c, ['snippet.promise_returned', 'snippet.runtime_error', 'snippet.compile_error'], ['seed', 'agent']);
    assert.equal(await exists(marker), false, 'a seed import() reached node:fs and wrote a host file');
  });

  it('G-21 a fire-and-forget import() in a seed cannot reach node:fs', BASE_OK, async () => {
    const marker = await markerPath();
    const c = await inChild(
      mutated((w) => {
        w.seed['agent'] = replaceOnce(AGENT_SEED, 'ctx.rng();', `ctx.rng();\n  import('node:fs').then((fs) => { fs.writeFileSync(${JSON.stringify(marker)}, 'leak'); }, () => {});`);
      }),
      'check',
      SETTLE,
    );
    assert.equal(c.killed, false, childSummary(c));
    assert.equal(await exists(marker), false, `a seed import() reached node:fs and wrote a host file after checkWorld returned: ${childSummary(c)}`);
  });

  it('G-21 RT-110 a fire-and-forget import() in a seed leaves no unhandled rejection and does not crash the process', opts(BASE_OK), async () => {
    const marker = await markerPath();
    const c = await inChild(
      mutated((w) => {
        w.seed['agent'] = replaceOnce(AGENT_SEED, 'ctx.rng();', `ctx.rng();\n  import('node:fs').then((fs) => { fs.writeFileSync(${JSON.stringify(marker)}, 'leak'); });`);
      }),
      'check',
      SETTLE,
    );
    assert.equal(await exists(marker), false, 'a seed import() reached node:fs and wrote a host file');
    const out = childOut(c);
    assert.deepEqual(out.unhandled ?? [], [], `the import() left an unhandled rejection: ${childSummary(c)}`);
    if (out.ok === false) {
      // A-195: async work a snippet starts, an import() included, is refused as snippet.promise_returned.
      const codes = (out.issues ?? []).map((i) => i.code);
      assert.ok(codes.some((x) => x === 'snippet.compile_error' || x === 'snippet.runtime_error' || x === 'snippet.promise_returned'), childSummary(c));
    }
  });
});

// =======================================================================================
// G-21: runaway code (busy loops and host-side traps), in child processes

type ChildCase = {
  readonly name: string;
  readonly mutate: (w: World) => void;
  readonly mode?: 'check' | 'advance';
  /** The documented outcome. */
  readonly check: (c: ChildResult) => void;
  /** Extra options, such as a todo or a runtime capability guard. */
  readonly opts?: TestOptions;
  /** The RT-114 time bound, in its own test over the same child run. */
  readonly budget?: { readonly name: string; readonly opts: TestOptions; readonly check: (c: ChildResult) => void };
};

const BUSY = '(ctx) => { for (;;) {} }';
const D08 = MUTATIONS.find((m) => m.id === 'D08');
const D07 = MUTATIONS.find((m) => m.id === 'D07');
const D06 = MUTATIONS.find((m) => m.id === 'D06');

/** ctx.ts SNIPPET_LIMITS: the wall-clock guard stops runaway code and reports snippet.timeout_guard. */
const timeoutAt = (prefix: Path | null) => (c: ChildResult) => void assertChildIssue(c, ['snippet.timeout_guard'], prefix);
const checkWithinGuard = (what: string) => (c: ChildResult) => assertWithinGuard(childOut(c), what);
/** RT-114: one guarded run is assumed to end within GUARD_BUDGET_MS. */
const oneRunBudget = (name: string, what: string) => ({ name, opts: {}, check: checkWithinGuard(what) });
/** RT-114 (A-211): a check that makes many guarded runs still ends within GUARD_BUDGET_MS, the one-run bound. */
const manyRunBudget = (name: string, what: string) => ({ name, opts: {}, check: checkWithinGuard(what) });
/** RT-110 (A-211): a value a snippet returned that loops when the host reads it fails the check within the guard. */
const anyFailureInBudget = (c: ChildResult) => {
  const out = childOut(c);
  assert.equal(out.ok, false, `a snippet that never returns let the world check ok: ${childSummary(c)}`);
  assertWithinGuard(out, 'host-side trap');
};

const RUNAWAY: readonly ChildCase[] = [
  {
    name: 'G-23 RT-114 while(true) in a seed gives snippet.timeout_guard',
    opts: SEED_RUNS,
    mutate: (w) => {
      if (!D08) throw new Error('mutations.ts has no D08');
      D08.mutate(w);
    },
    check: timeoutAt(['seed', 'agent']),
    budget: oneRunBudget('G-23 RT-114 while(true) in a seed ends checkWorld within the wall backstop', 'busy seed'),
  },
  {
    name: 'G-23 RT-114 while(true) in a grader gives snippet.timeout_guard',
    opts: TASK_RUNS,
    mutate: (w) => (at(w.tasks, 'pend_hd1005').grader = BUSY),
    check: timeoutAt(['tasks', 'pend_hd1005']),
    budget: manyRunBudget('G-23 RT-114 while(true) in a grader ends checkWorld within the wall backstop', 'busy grader'),
  },
  {
    name: 'G-23 RT-114 while(true) in a solution gives snippet.timeout_guard',
    opts: TASK_RUNS,
    mutate: (w) => (at(w.tasks, 'pend_hd1005').solution = BUSY),
    check: timeoutAt(['tasks', 'pend_hd1005']),
    budget: manyRunBudget('G-23 RT-114 while(true) in a solution ends checkWorld within the wall backstop', 'busy solution'),
  },
  {
    name: 'G-23 RT-114 while(true) in a handler fails the world tests',
    opts: HANDLER_RUNS,
    mutate: (w) => (at(w.actions, 'escalate').handler = BUSY),
    check: (c) => void assertChildIssue(c, ['snippet.timeout_guard', 'test.failed'], null),
    budget: manyRunBudget('G-23 RT-114 while(true) in a handler ends checkWorld within the wall backstop', 'busy handler'),
  },
  {
    name: 'G-23 RT-114 a busy loop that catches the guard error still gives snippet.timeout_guard',
    opts: SEED_RUNS,
    mutate: (w) => (w.seed['agent'] = '(ctx) => { for (;;) { try { for (;;) {} } catch (e) {} } }'),
    check: timeoutAt(['seed', 'agent']),
    budget: oneRunBudget('G-23 RT-114 a busy loop that catches the guard error ends checkWorld within the wall backstop', 'guard-catching seed'),
  },
  {
    name: 'G-29 RT-114 while(true) in a job is stopped, commits nothing and keeps the jobs before it',
    mode: 'advance',
    opts: RUNTIME,
    mutate: (w) => (at(w.jobs, 'b').run = "(ctx) => { ctx.db.create('job_run', { job: 'b', at: ctx.now() }); for (;;) {} }"),
    check: (c) => {
      const out = childOut(c);
      if (out.ok === false) {
        // Check runs no jobs, so only a static refusal of the loop can fail it here.
        const codes: readonly string[] = ['snippet.timeout_guard', 'snippet.compile_error', 'snippet.runtime_error'];
        assert.ok((out.issues ?? []).some((i) => codes.includes(i.code) && startsWith(i.path, ['jobs', 'b'])), childSummary(c));
        return;
      }
      assert.deepEqual(out.jobs, ['a_late', 'a', 'a_late'], 'the looping job b committed, or earlier jobs were undone');
    },
    budget: {
      name: 'G-29 RT-114 while(true) in a job ends advance within the wall backstop',
      opts: {},
      check: (c) => {
        const out = childOut(c);
        if (out.ok === false) return;
        assert.ok(typeof out.advanceMs === 'number' && out.advanceMs <= GUARD_BUDGET_MS, `advance took ${out.advanceMs} ms`);
      },
    },
  },
  {
    name: 'G-21 RT-110 a seed row getter that never returns cannot hang the host',
    opts: opts(SEED_RUNS),
    mutate: (w) => (w.seed['agent'] = "(ctx) => [{ get name() { for (;;) {} }, email: 'g@example.test', on_call: false }]"),
    check: anyFailureInBudget,
  },
  {
    name: 'G-22 RT-110 a grader returning an object with a looping then getter cannot hang the host',
    opts: opts(TASK_RUNS),
    mutate: (w) => (at(w.tasks, 'pend_hd1005').grader = '(ctx) => ({ get then() { for (;;) {} } })'),
    check: anyFailureInBudget,
  },
  {
    name: 'G-34 RT-110 a grader result whose valueOf and toString loop cannot hang the host',
    opts: opts(TASK_RUNS),
    mutate: (w) =>
      (at(w.tasks, 'pend_hd1005').grader = '(ctx) => ({ valueOf() { for (;;) {} }, toString() { for (;;) {} }, [Symbol.toPrimitive]() { for (;;) {} } })'),
    check: anyFailureInBudget,
  },
  {
    name: 'G-21 RT-110 a handler body whose toJSON loops cannot hang the host',
    opts: opts(HANDLER_RUNS),
    mutate: (w) =>
      (at(w.actions, 'escalate').handler = '(ctx) => ({ status: 200, body: { escalated: true, priority: "urgent", toJSON() { for (;;) {} } } })'),
    check: anyFailureInBudget,
  },
  {
    name: 'G-21 RT-110 a microtask loop scheduled by a seed cannot hang the host after checkWorld returns',
    opts: opts(SEED_RUNS),
    mutate: (w) => {
      w.seed['agent'] = replaceOnce(AGENT_SEED, 'ctx.rng();', 'ctx.rng();\n  (async () => {})().then(() => { for (;;) {} });');
    },
    check: checkWithinGuard('deferred loop'),
  },
];

// =======================================================================================
// G-23: call quota

const QUOTA: readonly ChildCase[] = [
  {
    name: 'G-23 a seed looping on ctx.rng gives snippet.call_quota',
    opts: SEED_RUNS,
    mutate: (w) => {
      if (!D07) throw new Error('mutations.ts has no D07');
      D07.mutate(w);
    },
    check: (c) => void assertChildIssue(c, ['snippet.call_quota'], ['seed', 'agent']),
  },
  {
    name: 'G-23 a grader looping on ctx.db.get gives snippet.call_quota',
    opts: TASK_RUNS,
    mutate: (w) => (at(w.tasks, 'pend_hd1005').grader = "(ctx) => { for (;;) ctx.db.get('ticket', 'tkt_0001'); }"),
    check: (c) => void assertChildIssue(c, ['snippet.call_quota'], ['tasks', 'pend_hd1005']),
  },
  {
    name: 'G-23 a client looping on ctx.api gives snippet.call_quota, not a machine-speed timeout',
    opts: TASK_RUNS,
    mutate: (w) => (at(w.tasks, 'pend_hd1005').solution = "(ctx) => { for (;;) ctx.api('GET', '/tickets/tkt_0001'); }"),
    check: (c) => void assertChildIssue(c, ['snippet.call_quota'], ['tasks', 'pend_hd1005']),
  },
  {
    name: 'G-23 RT-46 a handler looping on ctx.db.get fails the world tests through the quota',
    opts: HANDLER_RUNS,
    mutate: (w) => (at(w.actions, 'escalate').handler = "(ctx) => { for (;;) ctx.db.get('ticket', ctx.params.id); }"),
    check: (c) => void assertChildIssue(c, ['snippet.call_quota', 'test.failed'], null),
  },
  {
    name: 'G-23 catching the quota error does not let a ctx loop run forever',
    opts: SEED_RUNS,
    mutate: (w) => (w.seed['agent'] = '(ctx) => { for (;;) { try { ctx.rng(); } catch (e) {} } }'),
    check: (c) => void assertChildIssue(c, ['snippet.call_quota'], ['seed', 'agent']),
    budget: oneRunBudget('G-23 RT-114 catching the quota error ends checkWorld within the wall backstop', 'caught quota loop'),
  },
];

describe('G-21 and G-23 runaway snippets (child processes)', { concurrency: 4 }, () => {
  for (const c of [...RUNAWAY, ...QUOTA]) {
    let run: Promise<ChildResult> | null = null;
    const result = (): Promise<ChildResult> => (run ??= inChild(mutated(c.mutate), c.mode ?? 'check'));
    it(c.name, opts(BASE_OK, c.opts ?? {}), async () => {
      c.check(await result());
    });
    const b = c.budget;
    if (b) {
      it(b.name, opts(BASE_OK, c.opts ?? {}, b.opts), async () => {
        b.check(await result());
      });
    }
  }

  it('G-18 RT-112 seeds that read the locale give the same dump under different LC_ALL and TZ', opts(RUNTIME), async () => {
    const w = mutated((x) => {
      x.seed['agent'] = replaceOnce(AGENT_SEED, 'return rows;', "rows[1].name = 'Ben ' + (1234567.5).toLocaleString() + ' ' + ['b', 'a', 'ä', 'z'].sort((p, q) => p.localeCompare(q)).join('');\n  return rows;");
    });
    const de = childOut(await inChild(w, 'dump', { LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', TZ: 'Pacific/Kiritimati' }));
    const en = childOut(await inChild(w, 'dump', { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', TZ: 'UTC' }));
    assert.deepEqual(de.ok, en.ok);
    assert.deepEqual((de.issues ?? []).map((i) => `${i.code}@${i.path.join('.')}`), (en.issues ?? []).map((i) => `${i.code}@${i.path.join('.')}`));
    if (de.ok) assert.ok(de.dump !== undefined && de.hashes !== undefined, 'the child reported no dump, so the comparison is vacuous');
    assert.deepEqual(de.hashes, en.hashes, 'verdict hashes depend on the host locale');
    assert.deepEqual(de.dump, en.dump, 'seeded rows depend on the host locale');
  });
});

describe('G-23 quota is per run', () => {
  it('G-23 15000 ctx calls in one seed run and 6000 per grader run still check ok', BASE_OK, () => {
    assert.ok(15_000 < CALLS_PER_RUN && 6_000 < CALLS_PER_RUN);
    const w = baseWorld();
    w.seed['agent'] = replaceOnce(AGENT_SEED, 'ctx.rng();', 'ctx.rng();\n  for (let i = 0; i < 15000; i++) ctx.rng();');
    at(w.tasks, 'pend_hd1005').grader = `(ctx) => {
  for (let i = 0; i < 6000; i++) ctx.db.get('ticket', 'tkt_0001');
  const g = ${SNIPPETS.easyGrader};
  return g(ctx);
}`;
    const r = checkWorld(w);
    assert.equal(r.ok, true, `the quota counts across runs: ${summary(r)}`);
  });
});

// =======================================================================================
// Deep recursion

describe('G-21 deep recursion ends in snippet.runtime_error', () => {
  const RECURSE = 'const f = (n) => f(n + 1) + 1; f(0);';

  it('G-21 unbounded recursion in a seed gives snippet.runtime_error', opts(BASE_OK, SEED_RUNS), () => {
    assertIssue(checkWorld(mutated((w) => inject(w, 'seed', RECURSE))), ['snippet.runtime_error'], ['seed', 'agent']);
  });

  it('G-21 unbounded recursion in a grader gives snippet.runtime_error', opts(BASE_OK, TASK_RUNS), () => {
    assertIssue(checkWorld(mutated((w) => inject(w, 'grader', RECURSE))), ['snippet.runtime_error', 'task.grader_out_of_range'], ['tasks', 'pend_hd1005']);
  });

  it('G-21 recursion through ctx calls fails cleanly and leaves the engine usable', opts(BASE_OK, SEED_RUNS), () => {
    const r = checkWorld(mutated((w) => (w.seed['agent'] = '(ctx) => { const f = () => { ctx.rng(); return f(); }; return f(); }')));
    assertIssue(r, ['snippet.runtime_error', 'snippet.call_quota'], ['seed', 'agent']);
    const again = checkWorld(baseWorld());
    assert.ok(again.ok, `base world stopped checking after a stack overflow: ${summary(again)}`);
    if (PROBE.baseReport) assert.deepEqual(reportKey(again), reportKey(PROBE.baseReport));
  });

  it('G-18 RT-113 a seed that measures its own stack depth seeds the same rows in every runtime', opts(RUNTIME), () => {
    const r = checkWorld(
      mutated((w) => {
        w.seed['agent'] = replaceOnce(
          AGENT_SEED,
          'return rows;',
          "const f = (n) => { try { return f(n + 1); } catch (e) { return n; } };\n  rows[1].name = 'Ben ' + f(0);\n  return rows;",
        );
      }),
    );
    if (!r.ok) {
      assertIssue(r, ['snippet.runtime_error'], ['seed', 'agent']);
      return;
    }
    const shallow = createRuntime(r.world).dump();
    const deep = (n: number): unknown => (n === 0 ? createRuntime(r.world).dump() : deep(n - 1));
    assert.deepEqual(deep(400), shallow, 'seeded rows depend on the host stack depth');
  });
});

// =======================================================================================
// G-22: promises and thenables

describe('G-22 promises and thenables', () => {
  it('G-22 an async seed gives snippet.promise_returned', opts(BASE_OK, SEED_RUNS), () => {
    if (!D06) throw new Error('mutations.ts has no D06');
    assertIssue(checkWorld(mutated((w) => D06.mutate(w))), ['snippet.promise_returned'], ['seed', 'agent']);
  });

  it('G-22 a seed returning an inner async call gives snippet.promise_returned', opts(BASE_OK, SEED_RUNS), () => {
    assertIssue(
      checkWorld(mutated((w) => (w.seed['agent'] = "(ctx) => (async () => [{ name: 'A', email: 'a@example.test', on_call: true }])()"))),
      ['snippet.promise_returned'],
      ['seed', 'agent'],
    );
  });

  it('G-22 an async grader gives snippet.promise_returned', opts(BASE_OK, TASK_RUNS), () => {
    assertIssue(
      checkWorld(mutated((w) => (at(w.tasks, 'pend_hd1005').grader = `async ${SNIPPETS.easyGrader}`))),
      ['snippet.promise_returned'],
      ['tasks', 'pend_hd1005'],
    );
  });

  it('G-22 an async solution whose writes all run synchronously still gives snippet.promise_returned', opts(BASE_OK, TASK_RUNS), () => {
    assertIssue(
      checkWorld(mutated((w) => (at(w.tasks, 'pend_hd1005').solution = `async ${SNIPPETS.easySolution}`))),
      ['snippet.promise_returned'],
      ['tasks', 'pend_hd1005'],
    );
  });

  it('G-22 RT-46 an async handler is refused', opts(BASE_OK, HANDLER_RUNS), () => {
    // The issue sits on the handler or on a world test that called it, not on an unrelated section.
    const r = checkWorld(mutated((w) => (at(w.actions, 'escalate').handler = `async ${SNIPPETS.escalate}`)));
    const p = issueProblemAt(r, ['snippet.promise_returned', 'test.failed', 'snippet.runtime_error'], [['actions', 'escalate'], ['tests']]);
    assert.equal(p, null, p ?? '');
  });

  it('G-22 G-34 a grader returning a thenable is refused', opts(BASE_OK, TASK_RUNS), () => {
    assertIssue(
      checkWorld(mutated((w) => (at(w.tasks, 'pend_hd1005').grader = '(ctx) => ({ then(resolve) { resolve(0); } })'))),
      // The sandbox copies results out as plain data (PR #64 snippet process): a result with a function
      // member is refused as snippet.runtime_error before any thenable could be awaited.
      ['snippet.promise_returned', 'task.grader_out_of_range', 'snippet.runtime_error'],
      ['tasks', 'pend_hd1005'],
    );
  });

  it('G-22 RT-42 a seed returning a thenable is refused', opts(BASE_OK, SEED_RUNS), () => {
    assertIssue(
      checkWorld(mutated((w) => (w.seed['agent'] = '(ctx) => ({ then(resolve) { resolve([]); } })'))),
      ['snippet.promise_returned', 'snippet.runtime_error', 'constraint.violation', 'schema.invalid'],
      ['seed', 'agent'],
    );
  });

  it('G-22 G-29 an async job neither commits its synchronous write nor passes silently', RUNTIME, () => {
    const r = checkWorld(mutated((w) => (at(w.jobs, 'b').run = `async ${SNIPPETS.job('b')}`)));
    if (!r.ok) {
      assertIssue(r, ['snippet.promise_returned', 'snippet.compile_error'], ['jobs', 'b']);
      return;
    }
    const jp = jobProblems(r.world, 'async job');
    assert.deepEqual(jp ?? [], []);
  });
});

// =======================================================================================
// Handler variants on a live runtime: late ctx use, async writes, cross-runtime ctx reuse

/** Handler variants that need no async code. Any engine must accept this world. */
const SYNC_VARIANTS = `if (ctx.body.reason === 'noop') {
    return { status: 200, body: t };
  }
  if (ctx.body.reason === 'stash') {
    globalThis.__rt_ctx = ctx;
    return { status: 200, body: t };
  }
  if (ctx.body.reason === 'reuse') {
    const old = globalThis.__rt_ctx;
    if (old && old !== ctx) { try { old.db.update('ticket', 'tkt_0002', { priority: 'high' }); } catch (e) {} }
    return { status: 200, body: t };
  }
  if (ctx.body.reason === 'recurse') {
    const f = (n) => f(n + 1) + 1;
    f(0);
  }
  `;
/** Handler variants that create promises. An engine may refuse these statically. */
const ASYNC_VARIANTS = `if (ctx.body.reason === 'late') {
    (async () => {})().then(() => { try { ctx.db.update('ticket', t.id, { priority: 'low' }); } catch (e) {} });
    return { status: 200, body: t };
  }
  if (ctx.body.reason === 'async_write') {
    ctx.db.update('ticket', t.id, { escalated: true, priority: 'urgent' });
    return (async () => ({ status: 200, body: t }))();
  }
  `;
const variantHandler = (variants: string): string => replaceOnce(SNIPPETS.escalate, "if (t.status === 'closed')", `${variants}if (t.status === 'closed')`);

let syncCache: CheckReport | null = null;
/** The base world with the sync variants. Must check ok, so these tests can never pass vacuously. */
function syncVariantWorld(): CheckedWorld {
  syncCache ??= checkWorld(mutated((w) => (at(w.actions, 'escalate').handler = variantHandler(SYNC_VARIANTS))));
  const r = syncCache;
  assert.ok(r.ok, `the sync handler variants do not check: ${summary(r)}`);
  return r.world;
}

let asyncCache: CheckReport | null = null;
/** The base world with the async variants. Returns null when the engine statically refuses async code. */
function asyncVariantWorld(t: TestContext): CheckedWorld | null {
  asyncCache ??= checkWorld(mutated((w) => (at(w.actions, 'escalate').handler = variantHandler(ASYNC_VARIANTS))));
  const r = asyncCache;
  if (r.ok) return r.world;
  if (NO_PROMISE_HOOK) {
    // A-211: Bun refuses every run of the async-syntax handler, so the world fails through its tests and no run can write late.
    assertIssue(r, ['test.failed'], ['tests']);
    t.diagnostic(NO_PROMISE_HOOK);
    return null;
  }
  assertIssue(r, ['snippet.compile_error', 'snippet.promise_returned'], ['actions', 'escalate']);
  t.diagnostic('the engine refuses async handler code statically, so the late-write cases are covered by that refusal');
  return null;
}

/**
 * Without a promise hook (Bun) every run of a source with async syntax faults, so the variant handler's
 * sync branches fail too, its calls answer 500, the world's tests fail, and no late write can happen.
 */
const NO_PROMISE_HOOK = process.versions.bun !== undefined && 'Bun refuses every run of an async-syntax handler, so late writes cannot arise';

const escalate = (id: string, reason: string): ApiRequest => req('POST', `/tickets/${id}/escalate`, { reason });

describe('G-08 and RT-110 handler ctx cannot act outside its call', () => {
  it('G-08 RT-110 a handler microtask that writes after the call returns changes nothing', opts(RUNTIME), async (t) => {
    const world = asyncVariantWorld(t);
    if (!world) return;
    const rt = createRuntime(world);
    const res = rt.call(escalate('tkt_0001', 'late'));
    const afterCall = snap(rt);
    const logLen = rt.log().length;
    await tick();
    await tick();
    // tkt_0001 seeds priority 'urgent', so a late write of 'low' is visible.
    assert.deepEqual(rt.dump(), afterCall, `a write landed after the call returned (status ${res.status})`);
    assert.equal(rt.log().length, logLen);
  });

  it('G-08 G-22 RT-46 a handler that writes and then returns a promise leaves the dump unchanged', NO_PROMISE_HOOK ? opts(RUNTIME, { skip: NO_PROMISE_HOOK }) : RUNTIME, async (t) => {
    const world = asyncVariantWorld(t);
    if (!world) return;
    const rt = createRuntime(world);
    const before = snap(rt);
    const res = rt.call(escalate('tkt_0002', 'async_write'));
    await tick();
    assert.ok(res.status >= 400, `a promise-returning handler gave ${res.status}`);
    assert.deepEqual(rt.dump(), before, 'the synchronous write of a promise-returning handler was committed');
  });

  it('G-18 RT-110 a ctx stashed by one runtime cannot write into it from another runtime', opts(RUNTIME), () => {
    const world = syncVariantWorld();
    const a = createRuntime(world);
    const b = createRuntime(world);
    // A frozen global object may refuse the stash (a 4xx or 5xx); then there is nothing to reuse.
    a.call(escalate('tkt_0001', 'stash'));
    const aAfter = snap(a);
    const rb = b.call(escalate('tkt_0001', 'reuse'));
    assert.equal(rb.status, 200, JSON.stringify(rb));
    // tkt_0002 seeds priority 'low', so a stale write of 'high' is visible.
    assert.deepEqual(a.dump(), aAfter, 'a call on runtime B wrote into runtime A through a stale ctx');
    // Nor into runtime B: its dump equals that of a runtime whose handler took the plain path.
    const plain = createRuntime(world);
    plain.call(escalate('tkt_0001', 'noop'));
    assert.deepEqual(b.dump(), plain.dump(), 'the stale ctx wrote into runtime B');
    const fresh = createRuntime(world);
    fresh.call(escalate('tkt_0001', 'reuse'));
    const c = createRuntime(world);
    c.call(escalate('tkt_0001', 'reuse'));
    assert.deepEqual(fresh.dump(), c.dump(), 'the same call gave different dumps depending on earlier runtimes');
  });

  it('G-08 RT-46 a handler that overflows the stack fails the call, changes nothing and leaves the runtime usable', RUNTIME, () => {
    const world = syncVariantWorld();
    const a = createRuntime(world);
    const b = createRuntime(world);
    const before = snap(a);
    const ra = a.call(escalate('tkt_0001', 'recurse'));
    const rb = b.call(escalate('tkt_0001', 'recurse'));
    assert.ok(ra.status >= 400, `stack overflow gave ${ra.status}`);
    assert.deepEqual(ra, rb, 'the failure is not deterministic');
    assert.deepEqual(a.dump(), before);
    const ok = a.call(escalate('tkt_0001', 'after overflow'));
    assert.equal(ok.status, 200, `runtime broken after a stack overflow: ${JSON.stringify(ok.body)}`);
    // The normal path still writes: tkt_0001 is now escalated.
    const row = rowsOf(a, 'ticket').find((r) => r['id'] === 'tkt_0001');
    assert.equal(row?.['escalated'], true);
  });
});
