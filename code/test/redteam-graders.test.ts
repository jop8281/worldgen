/**
 * Red-team: grading and task verification (G-31 to G-40, plus G-01, G-02, G-24, G-30 and
 * G-43 where they touch graders).
 *
 * verifyTask is not exported, so verification is observed through checkWorld: a bad task
 * must turn the report to ok: false with its code on ['tasks', <task>], and a good world
 * must carry one TaskVerdict per task. Grading is observed through Runtime.grade and the
 * admin port's POST /_world/grade/<task>.
 *
 * Every expected score is a hand-derived literal (FACTS in ./redteam/world.ts, or the
 * literals below with their derivation). Nothing here computes an expected value with
 * engine logic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorld, createRuntime, type CheckIssue, type CheckReport, type IssueCode, type Runtime, type StateDump, type TaskVerdict, type World } from '#engine';
import { cap, checkedBase, freshRuntime, opts, probeCli, serveWorld, type CapName, type HttpResult, type Server } from './redteam/harness.ts';
import { BAD_TASKS, type BadTask } from './redteam/graders.ts';
import { FACTS, SNIPPETS, TASK_IDS, baseWorld, type TaskId } from './redteam/world.ts';

await probeCli();

// ---------------------------------------------------------------------------------------
// File-local fixtures (hand-derived literals)

type Call = { readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; readonly path: string; readonly body: unknown };
const patch = (id: string, body: Record<string, unknown>): Call => ({ method: 'PATCH', path: `/tickets/${id}`, body });
const escalate = (id: string): Call => ({ method: 'POST', path: `/tickets/${id}/escalate`, body: { reason: 'unassigned' } });

/** The successful writes of each reference solution, with bodies. Mirrors FACTS.solutionWrites. */
const SOLUTION_CALLS: Readonly<Record<TaskId, readonly Call[]>> = {
  pend_hd1005: [patch('tkt_0005', { status: 'pending' })],
  pend_open_urgent: [patch('tkt_0001', { status: 'pending' }), patch('tkt_0009', { status: 'pending' })],
  escalate_unassigned: [
    escalate('tkt_0003'), patch('tkt_0003', { assignee: 'agt_0001' }),
    escalate('tkt_0007'), patch('tkt_0007', { assignee: 'agt_0001' }),
    escalate('tkt_0011'), patch('tkt_0011', { assignee: 'agt_0001' }),
  ],
};

/**
 * Highest score over strict prefixes of the solution's writes.
 * easy: one write, so null. medium: 1 of 2 targets pending = 0.5.
 * hard: 5 of 6 writes = escalate x3 (0.5 each) + assign x2 (0.5 each) over 3 targets = 2.5 / 3.
 */
const BEST_PREFIX: Readonly<Record<TaskId, number | null>> = {
  pend_hd1005: null,
  pend_open_urgent: 0.5,
  escalate_unassigned: 2.5 / 3,
};

const EPS = 1e-12;
const close = (a: number, b: number): boolean => Math.abs(a - b) <= EPS;

/** Same idea as graders.ts graderReturning (not exported): return `value` when the real score equals `when`. */
function wrapGrader(real: string, when: number, value: string): string {
  return `(ctx) => {
  const real = ${real};
  const s = real(ctx);
  return s === ${when} ? (${value}) : s;
}`;
}

function taskOf(w: World, id: TaskId) {
  const t = w.tasks[id];
  if (!t) throw new Error(`fixture has no task ${id}`);
  return t;
}

function variant(fn: (w: World) => void): World {
  const w = baseWorld();
  fn(w);
  return w;
}

// ---------------------------------------------------------------------------------------
// Report helpers

type Run = { readonly report: CheckReport | null; readonly problems: string[] };

function runCheck(label: string, input: unknown): Run {
  try {
    return { report: checkWorld(input), problems: [] };
  } catch (e) {
    return { report: null, problems: [`${label}: checkWorld threw (G-01): ${e instanceof Error ? e.stack ?? e.message : String(e)}`] };
  }
}

const brief = (i: CheckIssue): string => `${i.code} @ ${JSON.stringify(i.path)}: found ${JSON.stringify(i.found)}`;

/** Problems with the precision of one issue (G-02). */
function issueShape(label: string, i: CheckIssue): string[] {
  const out: string[] = [];
  if (i.severity !== 'error') out.push(`${label}: ${i.code} has severity ${i.severity}`);
  for (const k of ['expected', 'found', 'hint'] as const) {
    if (typeof i[k] !== 'string' || i[k].length === 0) out.push(`${label}: ${i.code} has empty ${k}`);
  }
  return out;
}

type Want = {
  readonly label: string;
  readonly taskId: TaskId | null;
  /** Any of these codes satisfies the expectation. Plain strings, so spec-call tests can name proposed codes. */
  readonly codes: readonly string[];
  /**
   * When given, every issue on the target task (or, with taskId null, every issue apart from
   * layer.blocked) must have one of these codes. Catches an engine that reports every task.*
   * code whenever anything is wrong.
   */
  readonly only?: readonly string[];
};

/**
 * The world must fail at the tasks layer with one of `codes` on ['tasks', taskId]. No issue
 * of any code may name a different task (verification is per task, so a bad grader must not
 * poison the sandbox or seed of the others), and no issue may sit outside the tasks section
 * apart from layer.blocked (RT-68). Task issues sit under ['tasks', taskId] because an IssuePath
 * is a path into world.yaml (issues.ts).
 */
function expectTaskIssue(input: unknown, want: Want): { problems: string[]; hit: CheckIssue | null } {
  const { report, problems } = runCheck(want.label, input);
  if (!report) return { problems, hit: null };
  if (report.ok) return { problems: [...problems, `${want.label}: checked ok, expected one of ${want.codes.join(' | ')}`], hit: null };
  const hit = report.issues.find((i) => want.codes.includes(i.code)) ?? null;
  if (!hit) {
    problems.push(`${want.label}: expected one of ${want.codes.join(' | ')}, got [${report.issues.map(brief).join('; ')}]`);
    return { problems, hit };
  }
  const head = want.taskId ? ['tasks', want.taskId] : ['tasks'];
  if (!head.every((h, k) => hit.path[k] === h)) problems.push(`${want.label}: ${hit.code} path ${JSON.stringify(hit.path)} does not start with ${JSON.stringify(head)}`);
  // Every task code, world.too_few_tasks included since YOS-113, stops the report at the tasks layer.
  if (report.reached !== 'tasks') problems.push(`${want.label}: reached ${report.reached}, expected tasks`);
  problems.push(...issueShape(want.label, hit));
  for (const i of report.issues) {
    if (i.code === 'layer.blocked') continue;
    if (i.path[0] !== 'tasks') {
      problems.push(`${want.label}: issue outside the tasks section: ${brief(i)}`);
      continue;
    }
    const onOther = want.taskId !== null && typeof i.path[1] === 'string' && i.path[1] !== want.taskId;
    if (onOther || (want.taskId !== null && i.code.startsWith('task.') && i.path[1] !== want.taskId)) {
      problems.push(`${want.label}: stray issue on another task: ${brief(i)}`);
      continue;
    }
    if (want.only && !want.only.includes(i.code)) problems.push(`${want.label}: unexpected extra issue ${brief(i)} (allowed: ${want.only.join(' | ')})`);
  }
  return { problems, hit };
}

/** A deep copy, so a later comparison cannot pass because the engine handed out a live object. */
const snap = <T>(x: T): T => structuredClone(x);

/** One row of a dump by id, or undefined. */
function rowOf(d: StateDump, entity: string, id: string): Readonly<Record<string, unknown>> | undefined {
  return d.tables[entity]?.find((r) => r.id === id);
}

/** The world must check ok and `code` must not appear among issues or warnings. */
function expectCleanOf(input: unknown, label: string, code: IssueCode): string[] {
  const { report, problems } = runCheck(label, input);
  if (!report) return problems;
  const all = report.ok ? report.warnings : [...report.issues, ...report.warnings];
  const bad = all.filter((i) => i.code === code);
  if (bad.length > 0) problems.push(`${label}: unexpected ${bad.map(brief).join('; ')}`);
  if (!report.ok) problems.push(`${label}: expected ok, got [${report.issues.map(brief).join('; ')}]`);
  return problems;
}

/**
 * Codes that may also appear on the row's task. A bad value on the noop state may also be
 * reported as noop_not_zero, and on the solution state as solution_not_full_marks. Nothing
 * else: each row breaks exactly one rule (derivations in graders.ts notes).
 */
function companionsOf(b: BadTask): readonly IssueCode[] {
  if (b.id.startsWith('GR-range-noop-')) return ['task.noop_not_zero'];
  if (b.id.startsWith('GR-range-solution-')) return ['task.solution_not_full_marks'];
  return [];
}

function checkRow(b: BadTask): string[] {
  const w = variant(b.mutate);
  const label = `${b.id} (${b.note})`;
  if (b.expect === 'absent') return expectCleanOf(w, label, b.code);
  const codes = [b.code, ...(b.accept ?? [])];
  return expectTaskIssue(w, { label, taskId: b.taskId, codes, only: [...codes, ...companionsOf(b)] }).problems;
}

/** Fails loudly when the base world does not check, so a bad-variant failure is never vacuous. */
function requireBase(): void {
  checkedBase();
}

// ---------------------------------------------------------------------------------------
// Runtime and HTTP helpers

function callAll(rt: Runtime, calls: readonly Call[]): string[] {
  const problems: string[] = [];
  for (const c of calls) {
    const res = rt.call({ method: c.method, path: c.path, query: {}, body: c.body });
    if (res.status < 200 || res.status > 299) problems.push(`${c.method} ${c.path} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  return problems;
}

/** RT-64: the admin grade body is a bare number or an object with `score`. */
function scoreOf(r: HttpResult): unknown {
  if (typeof r.body === 'number') return r.body;
  if (r.body !== null && typeof r.body === 'object' && 'score' in r.body) return (r.body as { score: unknown }).score;
  return r.body;
}

async function withServer(world: unknown, fn: (s: Server) => Promise<void>): Promise<void> {
  const s = await serveWorld(world, { timeoutMs: 30_000 });
  try {
    await fn(s);
  } catch (e) {
    if (e instanceof Error) e.message += `\n--- server output ---\n${s.output().slice(-2000)}`;
    throw e;
  } finally {
    await s.stop();
  }
}

const CRASH_ERRORS = ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'];

// ---------------------------------------------------------------------------------------

/**
 * Which check capability produces each code (research/archive/factory/backlog.json): solution, noop,
 * range and determinism checks come with the tasks layer (engine-grade-verify-basic); decoys
 * and prefixes with engine-verify-full; world.too_few_tasks with engine-lints. A row skips
 * until the unit that owns its code lands, instead of failing on a pass-through layer.
 */
const VERIFY: readonly CapName[] = ['checkWorld', 'check.tasks'];
const VERIFY_FULL: readonly CapName[] = [...VERIFY, 'check.tasks.discriminating'];
const CAPS_OF: Partial<Record<IssueCode, readonly CapName[]>> = {
  'task.grader_out_of_range': VERIFY,
  'task.noop_not_zero': VERIFY,
  'task.solution_not_full_marks': VERIFY,
  'task.nondeterministic': VERIFY,
  'snippet.runtime_error': VERIFY,
  'task.prefix_full_marks': VERIFY_FULL,
  'task.decoy_full_marks': VERIFY_FULL,
  'task.decoy_required': VERIFY_FULL,
  'task.decoy_trivial': VERIFY_FULL,
  'world.too_few_tasks': ['checkWorld', 'check.lints'],
};
const capsOf = (codes: readonly IssueCode[]): CapName[] => [...new Set(codes.flatMap((c) => CAPS_OF[c] ?? VERIFY_FULL))];

/** One test per code over the rows without a todo. Snippet rows have dedicated tests below. */
const GROUPS: readonly { readonly gid: string; readonly codes: readonly IssueCode[] }[] = [
  { gid: 'G-34', codes: ['task.grader_out_of_range'] },
  { gid: 'G-35', codes: ['task.noop_not_zero', 'task.idle_not_zero'] },
  { gid: 'G-36', codes: ['task.solution_not_full_marks', 'task.alternative_not_full_marks'] },
  { gid: 'G-37', codes: ['task.prefix_full_marks'] },
  { gid: 'G-38', codes: ['task.decoy_full_marks', 'task.decoy_required'] },
  { gid: 'G-39', codes: ['task.decoy_trivial'] },
  { gid: 'G-40', codes: ['world.too_few_tasks'] },
  { gid: 'G-60', codes: ['task.mutant_full_marks'] },
  { gid: 'G-61', codes: ['task.freetext_unchecked'] },
  { gid: 'G-62', codes: ['task.omission_full_marks'] },
];
/** Rows with their own test: in 'verify: graders that misbehave', and G-24 in redteam-determinism.test.ts for GR-nondeterministic-proto. */
const DEDICATED_ROWS: readonly string[] = ['GR-grader-throws', 'GR-grader-writes', 'GR-nondeterministic-proto'];
/** Hand count of graders.ts rows without a todo, per group: 12 values x 2 states + exact ends + -0 (RT-07) = 26 for G-34. */
const GROUP_ROWS: Readonly<Record<string, number>> = { 'G-34': 26, 'G-35': 3, 'G-36': 3, 'G-37': 2, 'G-38': 4, 'G-39': 4, 'G-40': 2, 'G-60': 2, 'G-61': 1, 'G-62': 1 };

describe('grader fixtures', () => {
  it('G-00 grader-suite solution calls match FACTS.solutionWrites', () => {
    for (const id of TASK_IDS) {
      assert.deepEqual(SOLUTION_CALLS[id].map((c) => `${c.method} ${c.path}`), [...FACTS.solutionWrites[id]], id);
    }
  });

  it('G-00 every graders.ts row is exercised: each group has its hand-counted rows, and no row falls through', () => {
    // A row whose code drifts out of every group, or a group emptied by todos, would
    // otherwise drop out of the suite without a trace.
    const counts = Object.fromEntries(GROUPS.map((g) => [g.gid, BAD_TASKS.filter((b) => g.codes.includes(b.code) && !b.todo).length]));
    assert.deepEqual(counts, GROUP_ROWS);
    const orphans = BAD_TASKS.filter((b) => !b.todo && !DEDICATED_ROWS.includes(b.id) && !GROUPS.some((g) => g.codes.includes(b.code)));
    assert.deepEqual(orphans.map((b) => b.id), []);
    for (const id of DEDICATED_ROWS) assert.ok(BAD_TASKS.some((b) => b.id === id), `graders.ts lost row ${id}`);
    assert.equal(new Set(BAD_TASKS.map((b) => b.id)).size, BAD_TASKS.length, 'duplicate row ids in graders.ts');
    for (const b of BAD_TASKS) {
      if (b.expect === 'present' && b.taskId !== null) {
        const w = variant(b.mutate);
        assert.notDeepEqual(w, baseWorld(), `${b.id}: mutate() did not change the world, so the row proves nothing`);
      }
    }
  });
});

describe('verify: bad grader variants (graders.ts)', () => {
  const GID_OF: Partial<Record<IssueCode, string>> = Object.fromEntries(GROUPS.flatMap((g) => g.codes.map((c) => [c, g.gid])));
  GID_OF['task.nondeterministic'] = 'G-24';

  for (const g of GROUPS) {
    const rows = BAD_TASKS.filter((b) => g.codes.includes(b.code) && !b.todo);
    if (rows.length === 0) continue;
    it(`${g.gid} each ${g.codes.join(' / ')} row gives its code on its task (${rows.length} rows)`, cap(...capsOf(g.codes)), () => {
      requireBase();
      assert.deepEqual(rows.flatMap(checkRow), []);
    });
  }

  for (const b of BAD_TASKS.filter((r) => r.todo)) {
    const gid = GID_OF[b.code] ?? 'G-33';
    it(`${gid} ${b.id} ${b.note}`, opts(cap(...capsOf([b.code])), { todo: b.todo ?? true }), () => {
      requireBase();
      assert.deepEqual(checkRow(b), []);
    });
  }

  it('G-39 decoy_trivial names the decoy and its reason', cap(...VERIFY_FULL), () => {
    requireBase();
    // RT-60: the copy of the solution also scores 1, so the engine may report it as
    // decoy_full_marks instead of decoy_trivial. Both codes name the decoy; only
    // decoy_trivial carries the reason.
    const cases: readonly { readonly id: string; readonly reason: string; readonly codes: readonly IssueCode[] }[] = [
      { id: 'GR-decoy-trivial-reads', reason: 'no_successful_write', codes: ['task.decoy_trivial'] },
      { id: 'GR-decoy-trivial-solution', reason: 'same_as_solution', codes: ['task.decoy_trivial', 'task.decoy_full_marks'] },
    ];
    const problems: string[] = [];
    for (const c of cases) {
      const b = BAD_TASKS.find((r) => r.id === c.id);
      if (!b) throw new Error(`graders.ts has no row ${c.id}`);
      const w = variant(b.mutate);
      const decoys = taskOf(w, 'pend_open_urgent').decoys;
      // An empty `why` would make the includes() below vacuous.
      const why = decoys.at(-1)?.why ?? '';
      const goodWhy = decoys[0]?.why ?? '';
      assert.equal(decoys.length, 2, `${c.id}: expected the base decoy plus the trivial one`);
      assert.ok(why.length > 0 && goodWhy.length > 0 && !why.includes(goodWhy) && !goodWhy.includes(why), `${c.id}: decoy whys must be non-empty and distinct`);
      const run = runCheck(c.id, w);
      const trivial = run.report && !run.report.ok ? run.report.issues.filter((i) => i.code === 'task.decoy_trivial') : [];
      const { problems: p, hit } = expectTaskIssue(w, { label: c.id, taskId: 'pend_open_urgent', codes: c.codes, only: ['task.decoy_trivial', ...(b.accept ?? [])] });
      problems.push(...p);
      if (hit && hit.code === 'task.decoy_trivial' && !hit.hint.includes(c.reason)) problems.push(`${c.id}: hint does not give reason ${c.reason}: ${hit.hint}`);
      if (hit && !(hit.hint + hit.found).includes(why)) problems.push(`${c.id}: issue does not name the decoy "${why}"`);
      // The base decoy (first page only) writes and scores 0.5, so it is not trivial.
      for (const i of trivial) {
        if ((i.hint + i.found).includes(goodWhy)) problems.push(`${c.id}: the good base decoy was flagged trivial: ${brief(i)}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('verify: adversarial grader returns', () => {
  it('G-01 G-34 hostile return values (BigInt, boxed number, Symbol, throwing toString, -Infinity) give a clean issue without crashing check (RT-61)', cap(...VERIFY), () => {
    requireBase();
    const range: IssueCode = 'task.grader_out_of_range';
    const cases: readonly { readonly label: string; readonly when: 0 | 1; readonly js: string; readonly codes: readonly IssueCode[] }[] = [
      { label: '0n on noop', when: 0, js: '0n', codes: [range, 'snippet.runtime_error'] },
      { label: '1n on solution', when: 1, js: '1n', codes: [range, 'snippet.runtime_error'] },
      { label: '-Infinity on noop', when: 0, js: '-Infinity', codes: [range] },
      { label: 'Object(1) on solution', when: 1, js: 'Object(1)', codes: [range, 'snippet.runtime_error'] },
      { label: 'Symbol() on noop', when: 0, js: "Symbol('s')", codes: [range, 'snippet.runtime_error'] },
      {
        label: 'object whose toString and toJSON throw, on solution', when: 1,
        js: "({ valueOf() { return 1; }, toString() { throw new Error('toString'); }, toJSON() { throw new Error('toJSON'); } })",
        // RT-61: marshalling the result out of the sandbox may throw, which is a runtime error.
        codes: [range, 'snippet.runtime_error'],
      },
      { label: 'frozen array [0] on noop', when: 0, js: 'Object.freeze([0])', codes: [range, 'snippet.runtime_error'] },
    ];
    const problems = cases.flatMap((c) => {
      const w = variant((x) => { taskOf(x, 'pend_hd1005').grader = wrapGrader(SNIPPETS.easyGrader, c.when, c.js); });
      const companion: IssueCode = c.when === 0 ? 'task.noop_not_zero' : 'task.solution_not_full_marks';
      return expectTaskIssue(w, { label: c.label, taskId: 'pend_hd1005', codes: c.codes, only: [...c.codes, companion] }).problems;
    });
    assert.deepEqual(problems, []);
  });

  it('G-35 G-36 noop and solution are compared exactly, with no epsilon', cap(...VERIFY), () => {
    requireBase();
    assert.ok(0.9999999999999999 < 1 && 5e-324 > 0, 'fixture literals collapsed to 1 or 0');
    const noopTiny = variant((w) => { taskOf(w, 'pend_hd1005').grader = wrapGrader(SNIPPETS.easyGrader, 0, '5e-324'); });
    const solAlmost = variant((w) => { taskOf(w, 'pend_hd1005').grader = wrapGrader(SNIPPETS.easyGrader, 1, '0.9999999999999999'); });
    // Both values are numbers inside [0, 1], so grader_out_of_range would be a false alarm.
    const problems = [
      ...expectTaskIssue(noopTiny, { label: 'noop scores 5e-324', taskId: 'pend_hd1005', codes: ['task.noop_not_zero'], only: ['task.noop_not_zero'] }).problems,
      ...expectTaskIssue(solAlmost, { label: 'solution scores 1 - 2^-53', taskId: 'pend_hd1005', codes: ['task.solution_not_full_marks'], only: ['task.solution_not_full_marks'] }).problems,
    ];
    assert.deepEqual(problems, []);
  });

  it('G-37 G-38 decoy and prefix are compared exactly against 1, with no epsilon', cap(...VERIFY_FULL), () => {
    requireBase();
    // Medium: decoy and prefix both score 0.5. Lifting them to 1 - 2^-53 must still pass,
    // since below 1 is below 1. An engine that rounds or uses an epsilon reports full marks.
    const w = variant((x) => { taskOf(x, 'pend_open_urgent').grader = wrapGrader(SNIPPETS.mediumGrader, 0.5, '0.9999999999999999'); });
    const run = runCheck('decoy and prefix at 1 - 2^-53', w);
    assert.deepEqual(run.problems, []);
    const report = run.report;
    assert.ok(report);
    assert.equal(report.ok, true, report.ok ? '' : `a score just below 1 was treated as full marks: ${report.issues.map(brief).join('; ')}`);
    if (!report.ok) return;
    const v = report.verdicts['pend_open_urgent'];
    assert.ok(v, 'no verdict for pend_open_urgent');
    assert.deepEqual(v.decoys.map((d) => d.score), [0.9999999999999999]);
    assert.equal(v.bestPrefixScore, 0.9999999999999999);
  });

  it('G-33 a grader that returns NaN or a string on decoy and prefix states cannot pass verification', cap(...VERIFY_FULL), () => {
    requireBase();
    // Medium: noop 0, solution 1, decoy 0.5, prefix 0.5. Only the in-between scores are corrupted.
    const codes: readonly IssueCode[] = ['task.grader_out_of_range', 'task.decoy_full_marks', 'task.prefix_full_marks'];
    const problems = ['NaN', "'0.5'", 'undefined'].flatMap((js) => {
      const w = variant((x) => { taskOf(x, 'pend_open_urgent').grader = wrapGrader(SNIPPETS.mediumGrader, 0.5, js); });
      return expectTaskIssue(w, { label: `in-between score ${js}`, taskId: 'pend_open_urgent', codes, only: codes }).problems;
    });
    assert.deepEqual(problems, []);
  });

  const boom = "(() => { throw new Error('late boom'); })()";
  const carriesBoom = (label: string, hit: CheckIssue | null): string[] =>
    hit && hit.code === 'snippet.runtime_error' && !(hit.expected + hit.found + hit.hint).includes('late boom')
      ? [`${label}: runtime_error does not carry the thrown message: ${brief(hit)}`]
      : [];

  it('G-01 G-02 a grader that throws only on the solution state gives a clean issue', cap(...VERIFY), () => {
    requireBase();
    const onSolution = variant((w) => { taskOf(w, 'pend_hd1005').grader = wrapGrader(SNIPPETS.easyGrader, 1, boom); });
    const sol = expectTaskIssue(onSolution, {
      label: 'throws on solution', taskId: 'pend_hd1005', codes: ['snippet.runtime_error', 'task.grader_out_of_range'],
      only: ['snippet.runtime_error', 'task.grader_out_of_range', 'task.solution_not_full_marks'],
    });
    assert.deepEqual([...sol.problems, ...carriesBoom('throws on solution', sol.hit)], []);
  });

  it('G-01 G-02 a grader that throws only on a decoy or prefix state gives a clean issue', cap(...VERIFY_FULL), () => {
    requireBase();
    const onDecoy = variant((w) => { taskOf(w, 'pend_open_urgent').grader = wrapGrader(SNIPPETS.mediumGrader, 0.5, boom); });
    const decoyCodes: readonly IssueCode[] = ['snippet.runtime_error', 'task.grader_out_of_range', 'task.decoy_full_marks', 'task.prefix_full_marks'];
    const dec = expectTaskIssue(onDecoy, { label: 'throws on decoy/prefix', taskId: 'pend_open_urgent', codes: decoyCodes, only: decoyCodes });
    assert.deepEqual([...dec.problems, ...carriesBoom('throws on decoy/prefix', dec.hit)], []);
  });
});

describe('verify: graders that misbehave', () => {
  function rowById(id: string): BadTask {
    const b = BAD_TASKS.find((r) => r.id === id);
    if (!b) throw new Error(`graders.ts has no row ${id}`);
    return b;
  }

  it('G-02 a grader that throws gives a clean snippet.runtime_error on its task with the thrown message', cap(...VERIFY), () => {
    requireBase();
    const b = rowById('GR-grader-throws');
    const codes: readonly IssueCode[] = ['snippet.runtime_error', ...(b.accept ?? [])];
    const { problems, hit } = expectTaskIssue(variant(b.mutate), { label: b.id, taskId: 'pend_hd1005', codes, only: codes });
    // snippet.runtime_error's hint is the thrown message (issues.ts). grader_out_of_range has
    // fixed expected and hint texts, and the docs do not say what its `found` holds.
    if (hit && hit.code === 'snippet.runtime_error' && !(hit.expected + hit.found + hit.hint).includes('grader exploded')) {
      problems.push(`${b.id}: ${hit.code} does not carry the thrown message: ${JSON.stringify(hit)}`);
    }
    assert.deepEqual(problems, []);
  });

  it('G-02 a throwing grader\'s snippet.runtime_error points at tasks.<id>.grader', opts(cap(...VERIFY)), () => {
    requireBase();
    const b = rowById('GR-grader-throws');
    const { problems, hit } = expectTaskIssue(variant(b.mutate), { label: b.id, taskId: 'pend_hd1005', codes: ['snippet.runtime_error'] });
    if (hit && hit.path[2] !== 'grader') problems.push(`${b.id}: path ${JSON.stringify(hit.path)} does not point at the grader`);
    assert.deepEqual(problems, []);
  });

  it('G-32 a grader that writes through ctx.db (or ctx.seed) gives a clean issue on its task', cap(...VERIFY), () => {
    requireBase();
    const b = rowById('GR-grader-writes');
    const codes: readonly IssueCode[] = ['snippet.runtime_error', ...(b.accept ?? [])];
    const writers = [
      { label: b.id, world: variant(b.mutate) },
      {
        label: 'grader creates through ctx.db',
        world: variant((w) => { taskOf(w, 'pend_hd1005').grader = "(ctx) => { ctx.db.create('agent', { name: 'X', email: 'x@example.test' }); return 0; }"; }),
      },
      {
        label: 'grader writes through ctx.seed',
        world: variant((w) => { taskOf(w, 'pend_hd1005').grader = "(ctx) => { ctx.seed.update('ticket', 'tkt_0005', { status: 'pending' }); return 0; }"; }),
      },
    ];
    // A write that silently lands (or is silently dropped) shows up as noop_not_zero or
    // solution_not_full_marks instead, which `only` refuses.
    const problems = writers.flatMap((x) => expectTaskIssue(x.world, { label: x.label, taskId: 'pend_hd1005', codes, only: codes }).problems);
    assert.deepEqual(problems, []);
  });

  it('G-32 a grader that mutates the row objects it reads cannot change state or later grades', cap('checkWorld', 'createRuntime', 'runtime.grade', 'runtime.dump', 'runtime.reset'), () => {
    requireBase();
    // Scores first, then tries to scribble on every row object and array it was handed.
    const grader = `(ctx) => {
  const g = ${SNIPPETS.easyGrader};
  const s = g(ctx);
  const scribble = (x) => { try { if (x) { x.status = 'closed'; x.subject = 'scribbled'; } } catch (e) {} };
  const empty = (xs) => { try { xs.length = 0; } catch (e) {} };
  scribble(ctx.db.get('ticket', 'tkt_0005'));
  scribble(ctx.seed.get('ticket', 'tkt_0005'));
  const a = ctx.db.list('ticket'); for (const r of a) scribble(r); empty(a);
  const b = ctx.seed.list('ticket'); for (const r of b) scribble(r); empty(b);
  try { const c = ctx.changes(); c.push({ entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['status'], origin: 'call' }); } catch (e) {}
  return s;
}`;
    const w = variant((x) => { taskOf(x, 'pend_hd1005').grader = grader; });
    const run = runCheck('scribbling grader', w);
    assert.deepEqual(run.problems, []);
    const report = run.report;
    assert.ok(report);
    assert.equal(report.ok, true, report.ok ? '' : `verification was disturbed by a grader scribbling on its read view: ${report.issues.map(brief).join('; ')}`);
    if (!report.ok) return;
    const v = report.verdicts['pend_hd1005'];
    assert.ok(v, 'no verdict for pend_hd1005');
    assert.equal(v.noop, 0);
    assert.equal(v.solution, 1);

    const rt = createRuntime(report.world);
    const before = snap(rt.dump());
    // checkWorld already ran the scribbler on every verification state. If it reached the
    // seed, this runtime starts from a scribbled seed, so compare with the base world's seed.
    assert.deepEqual(before, snap(freshRuntime().dump()), 'verification scribbles leaked into the seed of the checked world');
    assert.deepEqual(rowOf(before, 'ticket', 'tkt_0005')?.['status'], 'open', 'tkt_0005 does not start open');
    assert.equal(before.tables['ticket']?.length, FACTS.counts.ticket, 'seed ticket rows were lost');
    assert.equal(rt.grade('pend_hd1005'), 0);
    assert.deepEqual(rt.dump(), before, 'grading changed the dump');
    assert.equal(rt.grade('pend_hd1005'), 0, 'second grade differs from the first');
    assert.deepEqual(callAll(rt, SOLUTION_CALLS.pend_hd1005), []);
    const solved = snap(rt.dump());
    assert.equal(rowOf(solved, 'ticket', 'tkt_0005')?.['status'], 'pending');
    assert.equal(rt.grade('pend_hd1005'), 1);
    assert.deepEqual(rt.dump(), solved, 'grading after the solution changed the dump');
    assert.equal(rt.grade('pend_hd1005'), 1, 'second grade after the solution differs');
    rt.reset();
    assert.deepEqual(rt.dump(), before, 'reset after grading does not restore the seed');
  });

  it('G-32 a grader that swallows its own write attempts still verifies exactly, and writes reach neither state nor seed', cap('checkWorld', 'createRuntime', 'runtime.call', 'runtime.grade', 'runtime.dump', 'runtime.reset'), () => {
    requireBase();
    // Each write is caught, then the real easy grader scores. If a write lands:
    //   db.update tkt_0005 -> pending makes the noop state score 1 (noop_not_zero);
    //   db.create agent adds a change off tkt_0005, so the solution scores 0;
    //   seed.update of tkt_0005's ref_code hides HD-1005, so the solution scores 0.
    // A refused or ignored write changes nothing, and the easy task verifies as in the base world.
    const grader = `(ctx) => {
  const real = ${SNIPPETS.easyGrader};
  try { ctx.db.update('ticket', 'tkt_0005', { status: 'pending' }); } catch (e) {}
  try { ctx.db.create('agent', { name: 'X', email: 'x@example.test' }); } catch (e) {}
  try { ctx.seed.update('ticket', 'tkt_0005', { ref_code: 'HD-9999' }); } catch (e) {}
  try { ctx.db.delete('ticket', 'tkt_0001'); } catch (e) {}
  return real(ctx);
}`;
    const w = variant((x) => { taskOf(x, 'pend_hd1005').grader = grader; });
    const run = runCheck('swallowing writer', w);
    assert.deepEqual(run.problems, []);
    const report = run.report;
    assert.ok(report);
    if (!report.ok) {
      // An engine may refuse any write attempt outright. Then the only acceptable report is
      // a runtime_error on the grader, never a score-based code that shows a write landed.
      const codes: readonly IssueCode[] = ['snippet.runtime_error'];
      assert.deepEqual(expectTaskIssue(w, { label: 'swallowing writer', taskId: 'pend_hd1005', codes, only: codes }).problems, []);
      return;
    }
    const v = report.verdicts['pend_hd1005'];
    assert.ok(v, 'no verdict for pend_hd1005');
    assert.ok(Object.is(v.noop, 0) && Object.is(v.solution, 1), `noop ${v.noop}, solution ${v.solution}`);
    assert.deepEqual(v.decoys.map((d) => d.score), [...FACTS.scores.pend_hd1005.decoys]);

    const rt = createRuntime(report.world);
    const before = snap(rt.dump());
    assert.deepEqual(before, snap(freshRuntime().dump()), 'a grader write during verification reached the seed');
    assert.ok(Object.is(rt.grade('pend_hd1005'), 0), 'fresh grade is not 0');
    assert.deepEqual(rt.dump(), before, 'a grader write reached the live state');
    assert.deepEqual(callAll(rt, SOLUTION_CALLS.pend_hd1005), []);
    const solved = snap(rt.dump());
    assert.ok(Object.is(rt.grade('pend_hd1005'), 1), 'grade after the solution is not 1');
    assert.deepEqual(rt.dump(), solved, 'a grader write reached the live state after the solution');
    rt.reset();
    assert.deepEqual(rt.dump(), before, 'a grader write reached the seed that reset restores');
  });
});

describe('verify: verdicts of the base world', () => {
  it('G-33 base verdicts: solution 1, noop 0, FACTS decoy scores, literal bestPrefixScore', cap(...VERIFY_FULL), () => {
    const run = runCheck('base', baseWorld());
    assert.deepEqual(run.problems, []);
    const report = run.report;
    assert.ok(report);
    assert.equal(report.ok, true, report.ok ? '' : report.issues.map(brief).join('; '));
    if (!report.ok) return;
    assert.deepEqual(Object.keys(report.verdicts).sort(), [...TASK_IDS].sort());
    const world = baseWorld();
    for (const id of TASK_IDS) {
      const v: TaskVerdict | undefined = report.verdicts[id];
      assert.ok(v, `no verdict for ${id}`);
      const facts = FACTS.scores[id];
      assert.equal(v.taskId, id);
      assert.equal(v.difficulty, taskOf(world, id).difficulty, `${id} difficulty`);
      assert.ok(Object.is(v.solution, 1), `${id} solution ${v.solution}`);
      assert.ok(Object.is(v.noop, 0), `${id} noop ${v.noop}`);
      // The docs do not fix the order of TaskVerdict.decoys, so decoys are matched by `why`
      // (distinct in the fixture). FACTS.scores lists them in fixture order.
      const whys = taskOf(world, id).decoys.map((d) => d.why);
      assert.deepEqual(v.decoys.map((d) => d.why).sort(), [...whys].sort(), `${id} decoy whys`);
      assert.equal(whys.length, facts.decoys.length, `${id}: FACTS.scores and the fixture disagree on decoy count`);
      whys.forEach((why, k) => {
        const want = facts.decoys[k];
        const d = v.decoys.find((x) => x.why === why);
        assert.ok(want !== undefined && d !== undefined && typeof d.score === 'number' && close(d.score, want), `${id} decoy "${why}" scored ${d?.score}, expected ${want}`);
        assert.ok(d.score < 1);
      });
      const best = BEST_PREFIX[id];
      if (best === null) assert.equal(v.bestPrefixScore, null, `${id} has one write, so bestPrefixScore is null`);
      else assert.ok(typeof v.bestPrefixScore === 'number' && close(v.bestPrefixScore, best), `${id} bestPrefixScore ${v.bestPrefixScore}, expected ${best}`);
      assert.ok(Number.isInteger(v.solutionCalls) && v.solutionCalls >= FACTS.solutionWrites[id].length, `${id} solutionCalls ${v.solutionCalls}`);
      assert.ok(typeof v.endStateHash === 'string' && v.endStateHash.length > 0, `${id} endStateHash`);
    }
    const hashes = TASK_IDS.map((id) => report.verdicts[id]?.endStateHash);
    assert.equal(new Set(hashes).size, hashes.length, 'different solutions ended in the same state hash');
    // A hash of something unstable (wall clock, object identity, a run counter) differs between runs.
    const again = runCheck('base, second run', baseWorld());
    assert.deepEqual(again.problems, []);
    const r2 = again.report;
    assert.ok(r2 && r2.ok, 'base world checked ok once and failed the second time');
    assert.deepEqual(TASK_IDS.map((id) => r2.verdicts[id]?.endStateHash), hashes, 'endStateHash differs between two checks of the same world');
  });

  it('G-33 endStateHash reflects row values: one extra field written by the solution changes it', cap(...VERIFY_FULL), () => {
    requireBase();
    // Same target, same status, plus priority high -> low on tkt_0005. The grader allows exactly
    // those two fields on tkt_0005, so the variant checks ok, and its end state differs in one row value.
    const w = variant((x) => {
      const t = taskOf(x, 'pend_hd1005');
      t.solution = SNIPPETS.easySolution.replace("{ status: 'pending' }", "{ status: 'pending', priority: 'low' }");
      t.grader = "(ctx) => { const t = ctx.db.get('ticket', 'tkt_0005'); return t && t.status === 'pending' && ctx.changes().every((c) => c.id === 'tkt_0005' && c.fields.every((f) => f === 'status' || f === 'priority')) ? 1 : 0; }";
    });
    assert.notEqual(taskOf(w, 'pend_hd1005').solution, SNIPPETS.easySolution, 'fixture replace did not apply');
    const base = runCheck('base', baseWorld());
    const other = runCheck('extra field', w);
    assert.deepEqual([...base.problems, ...other.problems], []);
    assert.ok(base.report?.ok && other.report?.ok, 'both worlds must check ok');
    const h1 = base.report.verdicts['pend_hd1005']?.endStateHash;
    const h2 = other.report.verdicts['pend_hd1005']?.endStateHash;
    assert.ok(typeof h1 === 'string' && typeof h2 === 'string');
    assert.notEqual(h2, h1, 'endStateHash ignores row values, so same_as_solution and determinism checks are blind');
  });
});

describe('grade: in-process runtime', () => {
  const RT = cap('checkWorld', 'createRuntime', 'runtime.call', 'runtime.grade', 'runtime.reset', 'runtime.dump');

  it('G-31 grade is 0 on a fresh runtime, 1 after each solution, 0 again after reset', RT, () => {
    const rt = freshRuntime();
    for (const id of TASK_IDS) assert.ok(Object.is(rt.grade(id), 0), `${id} fresh grade is not exactly 0`);
    for (const id of TASK_IDS) {
      rt.reset();
      assert.deepEqual(callAll(rt, SOLUTION_CALLS[id]), [], `${id} solution calls failed`);
      assert.ok(Object.is(rt.grade(id), 1), `${id} grade after solution is ${rt.grade(id)}`);
      rt.reset();
      assert.ok(Object.is(rt.grade(id), 0), `${id} grade after reset is not 0`);
    }
  });

  it('G-31 partial, decoy, retargeted and collateral call sequences grade to hand-computed literals', RT, () => {
    const rt = freshRuntime();
    const cases: readonly { readonly label: string; readonly task: TaskId; readonly calls: readonly Call[]; readonly want: number }[] = [
      { label: 'medium prefix: 1 of 2 targets', task: 'pend_open_urgent', calls: SOLUTION_CALLS.pend_open_urgent.slice(0, 1), want: 0.5 },
      { label: 'hard prefix: 5 of 6 writes', task: 'escalate_unassigned', calls: SOLUTION_CALLS.escalate_unassigned.slice(0, 5), want: 2.5 / 3 },
      { label: 'hard: escalate only', task: 'escalate_unassigned', calls: SOLUTION_CALLS.escalate_unassigned.filter((c) => c.method === 'POST'), want: 0.5 },
      { label: 'medium decoy: first page only', task: 'pend_open_urgent', calls: [patch('tkt_0001', { status: 'pending' })], want: 0.5 },
      { label: 'easy retarget: wrong ticket', task: 'pend_hd1005', calls: [patch('tkt_0001', { status: 'pending' })], want: 0 },
      { label: 'easy collateral: right ticket plus another', task: 'pend_hd1005', calls: [patch('tkt_0005', { status: 'pending' }), patch('tkt_0002', { status: 'pending' })], want: 0 },
      { label: 'medium collateral: solution plus a non-target', task: 'pend_open_urgent', calls: [...SOLUTION_CALLS.pend_open_urgent, patch('tkt_0002', { status: 'pending' })], want: 0 },
      { label: 'hard perturb: assigned to a non-on-call agent', task: 'escalate_unassigned', calls: SOLUTION_CALLS.escalate_unassigned.map((c) => (c.method === 'PATCH' ? { ...c, body: { assignee: 'agt_0002' } } : c)), want: 0.5 },
    ];
    const problems: string[] = [];
    for (const c of cases) {
      rt.reset();
      const failed = callAll(rt, c.calls);
      if (failed.length > 0) {
        problems.push(`${c.label}: calls failed: ${failed.join('; ')}`);
        continue;
      }
      const got = rt.grade(c.task);
      if (typeof got !== 'number' || !close(got, c.want)) problems.push(`${c.label}: grade ${got}, expected ${c.want}`);
    }
    assert.deepEqual(problems, []);
  });

  it('G-30 jobs firing after the solution do not change its grade', opts(RT, cap('runtime.advance')), () => {
    const rt = freshRuntime();
    for (const id of TASK_IDS) {
      rt.reset();
      assert.deepEqual(callAll(rt, SOLUTION_CALLS[id]), []);
      const jobsBefore = rt.dump().tables['job_run']?.length ?? 0;
      const fired = rt.advance('4h').jobsFired;
      assert.ok(fired.length > 0, 'advance(4h) fired no jobs, so this test proves nothing');
      // Jobs that fire but write nothing would make the grade check below vacuous.
      assert.equal((rt.dump().tables['job_run']?.length ?? 0) - jobsBefore, fired.length, 'fired jobs left no job_run rows, so this test proves nothing');
      assert.ok(Object.is(rt.grade(id), 1), `${id}: job rows leaked into ctx.changes() and zeroed the grade`);
    }
    rt.reset();
    rt.advance('4h');
    for (const id of TASK_IDS) assert.ok(Object.is(rt.grade(id), 0), `${id}: jobs alone scored ${rt.grade(id)}`);
  });

  it('G-32 grading is read-only: the dump is unchanged and repeated grades agree', RT, () => {
    const rt = freshRuntime();
    assert.deepEqual(callAll(rt, SOLUTION_CALLS.pend_open_urgent.slice(0, 1)), []);
    const dump = snap(rt.dump());
    const first = TASK_IDS.map((id) => rt.grade(id));
    const second = TASK_IDS.map((id) => rt.grade(id));
    // tkt_0001 pending: easy sees a change off HD-1005 (0), medium has 1 of 2 (0.5), hard sees a
    // non-target change (0). A stable but wrong grade would pass the comparison alone.
    assert.deepEqual(first, [0, 0.5, 0], 'grades of the medium prefix state');
    assert.deepEqual(second, first, 'grades differ between two passes');
    assert.deepEqual(rt.dump(), dump, 'grading changed the dump (including now)');
  });

  it('G-32 grading leaves the call log unchanged', opts(RT, cap('runtime.log')), () => {
    const rt = freshRuntime();
    assert.deepEqual(callAll(rt, SOLUTION_CALLS.pend_open_urgent.slice(0, 1)), []);
    const log = snap(rt.log());
    assert.equal(log.length, 1, 'the one PATCH is not in the log, so the comparison proves nothing');
    for (const id of TASK_IDS) rt.grade(id);
    assert.deepEqual(rt.log(), log, 'grading changed the call log');
  });

  const UNKNOWN_TASKS = ['no_such_task', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'PEND_HD1005', 'pend_hd1005 '];

  it('G-31 grade of an unknown task id (incl. __proto__, constructor) throws, never returns, and changes nothing (RT-25)', RT, () => {
    const rt = freshRuntime();
    const before = snap(rt.dump());
    const problems: string[] = [];
    for (const id of UNKNOWN_TASKS) {
      try {
        const v: unknown = rt.grade(id);
        problems.push(`grade(${JSON.stringify(id)}) returned ${String(v)} instead of failing`);
      } catch {
        // RT-25: any throw satisfies the contract. What it throws is RT-63.
      }
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(rt.dump(), before, 'a failed grade changed state');
    assert.ok(Object.is(rt.grade('pend_hd1005'), 0), 'the runtime is unusable after an unknown-task grade');
  });

  it('G-31 grade of an unknown task id throws a deliberate Error with a message, not a TypeError-style crash', opts(RT), () => {
    const rt = freshRuntime();
    const problems: string[] = [];
    for (const id of UNKNOWN_TASKS) {
      try {
        rt.grade(id);
      } catch (e) {
        const name = e instanceof Error ? e.name : typeof e;
        const message = e instanceof Error ? e.message : String(e);
        if (!(e instanceof Error)) problems.push(`grade(${JSON.stringify(id)}) threw a non-Error: ${message}`);
        else if (CRASH_ERRORS.includes(name)) problems.push(`grade(${JSON.stringify(id)}) crashed with ${name}: ${message}`);
        else if (message.trim() === '') problems.push(`grade(${JSON.stringify(id)}) threw an empty message`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('grade: HTTP admin port', () => {
  const HTTP = opts(cap('cli.serve'), { timeout: 180_000 });

  it('G-43 solution run over HTTP, then POST /_world/grade/<task> returns 1 (0 before, state untouched by grading) (RT-64)', HTTP, async () => {
    await withServer(baseWorld(), async (s) => {
      for (const id of TASK_IDS) {
        const reset = await s.adminApi.post('/_world/reset');
        assert.ok(reset.status >= 200 && reset.status < 300, `reset -> ${reset.status}`);
        const g0 = await s.adminApi.post(`/_world/grade/${id}`);
        assert.ok(g0.status >= 200 && g0.status < 300, `${id} fresh grade -> ${g0.status} ${g0.text}`);
        assert.ok(Object.is(scoreOf(g0), 0), `${id} fresh grade body ${g0.text}`);
        for (const c of SOLUTION_CALLS[id]) {
          const r = await s.api.request(c.method, c.path, c.body);
          assert.ok(r.status >= 200 && r.status < 300, `${id}: ${c.method} ${c.path} -> ${r.status} ${r.text}`);
        }
        const state = await s.adminApi.get('/_world/state');
        assert.ok(state.status >= 200 && state.status < 300, `${id}: /_world/state -> ${state.status}, so the state comparison proves nothing`);
        assert.ok(state.body !== null && typeof state.body === 'object', `${id}: /_world/state body is not JSON: ${state.text.slice(0, 200)}`);
        const g1 = await s.adminApi.post(`/_world/grade/${id}`);
        assert.ok(g1.status >= 200 && g1.status < 300, `${id} grade -> ${g1.status} ${g1.text}`);
        assert.ok(Object.is(scoreOf(g1), 1), `${id} grade after the HTTP solution: ${g1.text}`);
        const after = await s.adminApi.get('/_world/state');
        assert.deepEqual(after.body, state.body, `${id}: grading over HTTP changed /_world/state`);
      }
    });
  });

  it('G-43 admin grade of an unknown task is a 404, changes nothing and leaves the server up (RT-25)', HTTP, async () => {
    await withServer(baseWorld(), async (s) => {
      const before = await s.adminApi.get('/_world/state');
      assert.ok(before.status >= 200 && before.status < 300, `/_world/state -> ${before.status}, so the state comparison proves nothing`);
      assert.ok(before.body !== null && typeof before.body === 'object', `/_world/state body is not JSON: ${before.text.slice(0, 200)}`);
      for (const id of ['no_such_task', '__proto__', 'constructor', 'toString', '..%2F..%2Fstate']) {
        const r = await s.adminApi.post(`/_world/grade/${id}`);
        // RT-25 says 404 for an unknown task. The encoded traversal may instead be routed as
        // an unknown path, which RT-03 allows to be 404 or 405.
        const allowed = id.includes('%2F') ? [404, 405] : [404];
        assert.ok(allowed.includes(r.status), `grade/${id} -> ${r.status} ${r.text}`);
        assert.equal(typeof scoreOf(r) === 'number', false, `grade/${id} returned a score`);
      }
      const after = await s.adminApi.get('/_world/state');
      assert.ok(after.status >= 200 && after.status < 300, `admin port died after unknown-task grades: ${after.status}`);
      assert.deepEqual(after.body, before.body);
      const ok = await s.adminApi.post('/_world/grade/pend_hd1005');
      assert.ok(ok.status >= 200 && ok.status < 300, `known-task grade -> ${ok.status} ${ok.text}`);
      assert.ok(Object.is(scoreOf(ok), 0), `server unusable afterwards: ${ok.status} ${ok.text}`);
    });
  });
});

/** Proposals in research/spec-calls/ (engine-mutants.md RT-65, idle-noop.md RT-66, task-alternatives.md RT-67). Todo until decided. */
describe('spec calls (open design questions, expected to fail until decided)', () => {
  const sees = (w: World, label: string, taskId: TaskId, codes: readonly string[]): void => {
    requireBase();
    assert.deepEqual(expectTaskIssue(w, { label, taskId, codes }).problems, []);
  };
  // Proposed codes come from research/spec-calls/*.md; today's codes are accepted too.
  const ANY_TASK: readonly string[] = [
    'task.mutant_full_marks',
    'task.decoy_full_marks', 'task.prefix_full_marks', 'task.noop_not_zero', 'task.solution_not_full_marks', 'task.decoy_trivial',
  ];

  it('G-33 RT-65 engine-built retarget mutant: a grader that accepts "any one ticket moved to pending" is caught', cap(...VERIFY_FULL), () => {
    // Solution 1, noop 0, single write (no prefix), easy so no decoy: passes today's rules.
    const w = variant((x) => {
      const t = taskOf(x, 'pend_hd1005');
      t.decoys = [];
      t.grader = `(ctx) => {
  const ch = ctx.changes();
  if (ch.length !== 1) return 0;
  const r = ctx.db.get('ticket', ch[0].id);
  return r && r.status === 'pending' ? 1 : 0;
}`;
    });
    sees(w, 'retarget mutant', 'pend_hd1005', ANY_TASK);
  });

  it('G-33 RT-65 engine-built perturb mutant: a grader that accepts any assignee is caught', cap(...VERIFY_FULL), () => {
    // Decoys still score 1/3 and 0.5, best prefix 5/6: passes today's rules.
    const w = variant((x) => {
      const t = taskOf(x, 'escalate_unassigned');
      t.grader = SNIPPETS.hardGrader.replace('r.assignee === onCall.id', 'r.assignee !== null');
    });
    assert.notEqual(taskOf(w, 'escalate_unassigned').grader, SNIPPETS.hardGrader, 'fixture replace did not apply');
    sees(w, 'perturb mutant', 'escalate_unassigned', ANY_TASK);
  });

  it('G-33 RT-65 engine-built collateral mutant: a grader with no collateral check is caught', cap(...VERIFY_FULL), () => {
    // Decoy still scores 0.5, prefix 0.5: passes today's rules.
    const w = variant((x) => {
      const t = taskOf(x, 'pend_open_urgent');
      t.grader = SNIPPETS.mediumGrader.replace('if (ctx.changes().some((c) => !ids.includes(c.id))) return 0;', '');
    });
    assert.notEqual(taskOf(w, 'pend_open_urgent').grader, SNIPPETS.mediumGrader, 'fixture replace did not apply');
    sees(w, 'collateral mutant', 'pend_open_urgent', ANY_TASK);
  });

  it('G-35 RT-66 idle noop: a time-only grader (rewards the clock moving) gives noop_not_zero', cap(...VERIFY_FULL), () => {
    // Noop at clock start scores 0 and the solution's write ticks the clock, so it scores 1.
    // An idle noop (time passes, no calls) would score 1.
    const w = variant((x) => {
      const t = taskOf(x, 'pend_hd1005');
      t.decoys = [];
      t.grader = `(ctx) => (ctx.now() > '${FACTS.clockStart}' ? 1 : 0)`;
    });
    sees(w, 'time-only grader', 'pend_hd1005', ['task.idle_not_zero', 'task.noop_not_zero', ...ANY_TASK]);
  });

  it('G-36 RT-67 task alternatives: an over-strict grader that rejects a valid alternative solution is caught', cap(...VERIFY_FULL), () => {
    // The reference solution is one PATCH, so it ends at start + 1 tick. The grader demands
    // exactly that time. The alternative makes one extra no-op write (priority stays high)
    // and ends a tick later, in the same row values, so the over-strict grader gives it 0.
    const w = variant((x) => {
      const t = taskOf(x, 'pend_hd1005');
      t.decoys = [];
      t.solution = "(ctx) => { const r = ctx.api('PATCH', '/tickets/tkt_0005', { status: 'pending' }); ctx.assert(r.status === 200, 'patch ' + r.status); }";
      t.grader = `(ctx) => {
  const g = ${SNIPPETS.easyGrader};
  return g(ctx) === 1 && ctx.now() === '2026-01-05T09:00:01.000Z' ? 1 : 0;
}`;
      (t as unknown as Record<string, unknown>)['alternatives'] = [{
        why: 'sets priority to its current value first, then moves the ticket to pending',
        script: "(ctx) => { ctx.api('PATCH', '/tickets/tkt_0005', { priority: 'high' }); ctx.api('PATCH', '/tickets/tkt_0005', { status: 'pending' }); }",
      }];
    });
    sees(w, 'over-strict grader', 'pend_hd1005', ['task.alternative_not_full_marks', 'task.solution_not_full_marks', ...ANY_TASK]);
  });
});
