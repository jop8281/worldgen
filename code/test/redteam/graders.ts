/**
 * Bad-task variants: one world mutation per grader-related ISSUES code, plus value
 * variants for task.grader_out_of_range. Each row says which code must (or must not)
 * appear when the mutated world is checked. Expected codes are literals.
 */
import type { IssueCode, World } from '#engine';
import { FACTS, SNIPPETS, type TaskId } from './world.ts';

export type Expect = 'present' | 'absent';

export type BadTask = {
  readonly id: string;
  readonly note: string;
  readonly code: IssueCode;
  /** present: report.ok is false and some issue has `code`. absent: no issue or warning has `code`. */
  readonly expect: Expect;
  readonly taskId: TaskId | null;
  /** Other codes that also satisfy the row, with the RT that allows them. */
  readonly accept?: readonly IssueCode[];
  readonly todo?: string;
  mutate(w: World): void;
};

function task(w: World, id: TaskId) {
  const t = w.tasks[id];
  if (!t) throw new Error(`fixture has no task ${id}`);
  return t;
}

/** Wrap a grader so it returns `value` when the real score equals `when`. */
function graderReturning(real: string, when: 0 | 1, value: string): string {
  return `(ctx) => {
  const real = ${real};
  const s = real(ctx);
  return s === ${when} ? (${value}) : s;
}`;
}

/** Bad grader return values, as JS source. */
export const OUT_OF_RANGE: readonly { readonly label: string; readonly js: string }[] = [
  { label: 'NaN', js: 'NaN' },
  { label: 'true', js: 'true' },
  { label: 'false', js: 'false' },
  { label: "'1'", js: "'1'" },
  { label: 'undefined', js: 'undefined' },
  { label: 'null', js: 'null' },
  { label: '1.0000001', js: '1.0000001' },
  { label: '-1e-9', js: '-1e-9' },
  { label: 'Infinity', js: 'Infinity' },
  { label: '2', js: '2' },
  { label: '[1]', js: '[1]' },
  { label: '{}', js: '({})' },
];

const outOfRange: BadTask[] = OUT_OF_RANGE.flatMap(({ label, js }) =>
  (['noop', 'solution'] as const).map((at): BadTask => ({
    id: `GR-range-${at}-${label}`,
    note: `medium grader returns ${label} on the ${at} end state`,
    code: 'task.grader_out_of_range',
    expect: 'present',
    taskId: 'pend_open_urgent',
    mutate: (w) => {
      task(w, 'pend_open_urgent').grader = graderReturning(SNIPPETS.mediumGrader, at === 'noop' ? 0 : 1, js);
    },
  })),
);

export const BAD_TASKS: readonly BadTask[] = [
  {
    id: 'GR-noop-half', note: 'easy grader gives 0.5 to the untouched seed', code: 'task.noop_not_zero', expect: 'present',
    taskId: 'pend_hd1005',
    mutate: (w) => { task(w, 'pend_hd1005').grader = `(ctx) => { const g = ${SNIPPETS.easyGrader}; return 0.5 + 0.5 * g(ctx); }`; },
  },
  {
    id: 'GR-noop-one', note: 'easy grader always returns 1', code: 'task.noop_not_zero', expect: 'present',
    taskId: 'pend_hd1005', accept: ['task.decoy_full_marks'],
    mutate: (w) => { task(w, 'pend_hd1005').grader = '(ctx) => 1'; },
  },
  {
    id: 'GR-idle-clock', note: 'easy grader rewards the clock moving, so doing nothing while time passes scores 1 (A-198)',
    code: 'task.idle_not_zero', expect: 'present', taskId: 'pend_hd1005', accept: ['task.decoy_full_marks', 'task.mutant_full_marks'],
    mutate: (w) => {
      const t = task(w, 'pend_hd1005');
      t.decoys = [];
      t.grader = `(ctx) => (ctx.now() > '${FACTS.clockStart}' ? 1 : 0)`;
    },
  },
  {
    id: 'GR-alternative-strict', note: 'easy grader demands the exact end time of the one-PATCH solution, so a valid two-PATCH alternative scores 0 (A-199)',
    code: 'task.alternative_not_full_marks', expect: 'present', taskId: 'pend_hd1005',
    mutate: (w) => {
      const t = task(w, 'pend_hd1005');
      t.decoys = [];
      t.solution = "(ctx) => { const r = ctx.api('PATCH', '/tickets/tkt_0005', { status: 'pending' }); ctx.assert(r.status === 200, 'patch ' + r.status); }";
      t.grader = `(ctx) => {
  const g = ${SNIPPETS.easyGrader};
  return g(ctx) === 1 && ctx.now() === '2026-01-05T09:00:01.000Z' ? 1 : 0;
}`;
      t.alternatives = [{
        why: 'sets priority to its current value first, then moves the ticket to pending',
        script: "(ctx) => { ctx.api('PATCH', '/tickets/tkt_0005', { priority: 'high' }); ctx.api('PATCH', '/tickets/tkt_0005', { status: 'pending' }); }",
      }];
    },
  },
  {
    id: 'GR-solution-first-page', note: 'medium solution only reads the first page, so it scores 0.5', code: 'task.solution_not_full_marks',
    expect: 'present', taskId: 'pend_open_urgent', accept: ['task.decoy_trivial'],
    mutate: (w) => { task(w, 'pend_open_urgent').solution = SNIPPETS.mediumDecoyFirstPage; },
  },
  {
    id: 'GR-solution-noop', note: 'easy solution only reads', code: 'task.solution_not_full_marks', expect: 'present',
    taskId: 'pend_hd1005',
    mutate: (w) => { task(w, 'pend_hd1005').solution = "(ctx) => { ctx.api('GET', '/tickets'); }"; },
  },
  {
    id: 'GR-prefix-any', note: 'hard grader gives 1 once any target is escalated', code: 'task.prefix_full_marks', expect: 'present',
    taskId: 'escalate_unassigned', accept: ['task.decoy_full_marks', 'task.mutant_full_marks'],
    mutate: (w) => {
      task(w, 'escalate_unassigned').grader = `(ctx) => ctx.db.list('ticket', { where: { escalated: true } }).length > 0 ? 1 : 0`;
    },
  },
  {
    id: 'GR-prefix-medium', note: 'medium grader gives 1 once one target is pending', code: 'task.prefix_full_marks', expect: 'present',
    taskId: 'pend_open_urgent', accept: ['task.decoy_full_marks'],
    mutate: (w) => {
      task(w, 'pend_open_urgent').grader = `(ctx) => { const g = ${SNIPPETS.mediumGrader}; return g(ctx) > 0 ? 1 : 0; }`;
    },
  },
  {
    id: 'GR-mutant-other-row', note: 'medium grader without its other-rows check', code: 'task.mutant_full_marks', expect: 'present',
    taskId: 'pend_open_urgent',
    mutate: (w) => {
      task(w, 'pend_open_urgent').grader = SNIPPETS.mediumGrader.replace('  if (ctx.changes().some((c) => !ids.includes(c.id))) return 0;\n', '');
    },
  },
  {
    id: 'GR-mutant-target-field', note: 'easy grader without its target-fields check', code: 'task.mutant_full_marks', expect: 'present',
    taskId: 'pend_hd1005',
    mutate: (w) => {
      task(w, 'pend_hd1005').grader = SNIPPETS.easyGrader.replace("  if (ctx.changes().some((c) => c.fields.some((f) => f !== 'status'))) return 0;\n", '');
    },
  },
  {
    id: 'GR-decoy-full', note: 'medium decoy does the work and also rewrites a target subject; the grader allows it', code: 'task.decoy_full_marks',
    expect: 'present', taskId: 'pend_open_urgent', accept: ['task.mutant_full_marks'],
    mutate: (w) => {
      task(w, 'pend_open_urgent').grader = SNIPPETS.mediumGrader.replace("  if (ctx.changes().some((c) => c.fields.some((f) => f !== 'status'))) return 0;\n", '');
      task(w, 'pend_open_urgent').decoys.push({
        why: 'also rewrites the subject of every ticket it touches',
        script: SNIPPETS.mediumSolution.replace("{ status: 'pending' }", "{ status: 'pending', subject: 'touched' }"),
      });
    },
  },
  {
    id: 'GR-decoy-trivial-reads', note: 'decoy only reads', code: 'task.decoy_trivial', expect: 'present', taskId: 'pend_open_urgent',
    mutate: (w) => {
      task(w, 'pend_open_urgent').decoys.push({ why: 'lists tickets and stops there', script: "(ctx) => { ctx.api('GET', '/tickets'); }" });
    },
  },
  {
    id: 'GR-decoy-trivial-failed-writes', note: 'decoy writes only illegal transitions, so no write succeeds', code: 'task.decoy_trivial',
    expect: 'present', taskId: 'pend_open_urgent',
    mutate: (w) => {
      task(w, 'pend_open_urgent').decoys.push({
        why: 'closes open tickets directly, which the workflow refuses',
        script: "(ctx) => { ctx.api('PATCH', '/tickets/tkt_0001', { status: 'closed' }); ctx.api('PATCH', '/tickets/tkt_0009', { status: 'closed' }); }",
      });
    },
  },
  {
    id: 'GR-decoy-trivial-noop', note: 'decoy moves a target to pending and back, ending where noop ends', code: 'task.decoy_trivial',
    expect: 'present', taskId: 'pend_open_urgent',
    mutate: (w) => {
      task(w, 'pend_open_urgent').decoys.push({
        why: 'moves a ticket to pending and then reopens it',
        script: "(ctx) => { ctx.api('PATCH', '/tickets/tkt_0001', { status: 'pending' }); ctx.api('PATCH', '/tickets/tkt_0001', { status: 'open' }); }",
      });
    },
  },
  {
    id: 'GR-decoy-trivial-solution', note: 'decoy is the solution with a comment added', code: 'task.decoy_trivial', expect: 'present',
    taskId: 'pend_open_urgent', accept: ['task.decoy_full_marks'],
    mutate: (w) => {
      task(w, 'pend_open_urgent').decoys.push({
        why: 'the reference solution with a comment',
        script: SNIPPETS.mediumSolution.replace('(ctx) => {', '(ctx) => { /* same */'),
      });
    },
  },
  {
    id: 'GR-decoy-required-medium', note: 'medium task without decoys', code: 'task.decoy_required', expect: 'present',
    taskId: 'pend_open_urgent',
    mutate: (w) => { task(w, 'pend_open_urgent').decoys = []; },
  },
  {
    id: 'GR-decoy-required-hard', note: 'hard task without decoys', code: 'task.decoy_required', expect: 'present',
    taskId: 'escalate_unassigned',
    mutate: (w) => { task(w, 'escalate_unassigned').decoys = []; },
  },
  {
    id: 'GR-decoy-optional-easy', note: 'easy task without decoys is fine', code: 'task.decoy_required', expect: 'absent',
    taskId: 'pend_hd1005',
    mutate: (w) => { task(w, 'pend_hd1005').decoys = []; },
  },
  ...outOfRange,
  {
    id: 'GR-range-negzero', note: 'easy grader returns -0 on the noop state', code: 'task.grader_out_of_range', expect: 'absent',
    taskId: 'pend_hd1005',
    mutate: (w) => { task(w, 'pend_hd1005').grader = graderReturning(SNIPPETS.easyGrader, 0, '-0'); },
  },
  {
    id: 'GR-range-exact-ends', note: 'a grader returning exactly 0 and 1 is in range', code: 'task.grader_out_of_range', expect: 'absent',
    taskId: null,
    mutate: () => {},
  },
  {
    id: 'GR-nondeterministic-proto', note: 'solution counts its runs on Array.prototype, so two runs write different subjects',
    code: 'task.nondeterministic', expect: 'present', taskId: 'pend_hd1005', accept: ['snippet.runtime_error', 'task.solution_not_full_marks'],
    mutate: (w) => {
      task(w, 'pend_hd1005').solution = SNIPPETS.easySolution.replace(
        "{ status: 'pending' }",
        "{ status: 'pending', subject: 'run ' + (Array.prototype.__rt_runs = (Array.prototype.__rt_runs || 0) + 1) }",
      );
    },
  },
  {
    id: 'GR-too-few-one', note: 'only the easy task', code: 'world.too_few_tasks', expect: 'present', taskId: null,
    mutate: (w) => { delete w.tasks['pend_open_urgent']; delete w.tasks['escalate_unassigned']; },
  },
  {
    id: 'GR-too-few-zero', note: 'no tasks at all fails like one or two, found "0 tasks" (YOS-113)', code: 'world.too_few_tasks', expect: 'present', taskId: null,
    mutate: (w) => { w.tasks = {}; },
  },
  {
    id: 'GR-grader-throws', note: 'grader throws on every state', code: 'snippet.runtime_error', expect: 'present',
    taskId: 'pend_hd1005', accept: ['task.grader_out_of_range'],
    mutate: (w) => { task(w, 'pend_hd1005').grader = "(ctx) => { throw new Error('grader exploded'); }"; },
  },
  {
    id: 'GR-grader-writes', note: 'grader tries to write through ctx.db, which is read-only', code: 'snippet.runtime_error', expect: 'present',
    taskId: 'pend_hd1005', accept: ['task.grader_out_of_range'],
    mutate: (w) => {
      task(w, 'pend_hd1005').grader = "(ctx) => { ctx.db.update('ticket', 'tkt_0005', { status: 'pending' }); return 0; }";
    },
  },
];
