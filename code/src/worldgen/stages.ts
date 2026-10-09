/**
 * The stage table. Stages are rows of data run by one loop in run.ts, not modules.
 *
 * Invariants:
 * - Each section has exactly one owning step (`SECTION_OWNER`). A stage's tool schema
 *   allows edits only to the sections it owns, and issue ownership follows the same table.
 *   Adding a section to format.ts without an owner here fails to compile.
 * - `done` is pure. It reads engine output and the plan only, and never takes a Model.
 * - Stage order is dependency order. On iterate, a stage reruns only if a section it owns
 *   or reads changed (`stagesToRun`).
 */
import { ENGINE_ERROR_CODES, OP_SUCCESS_STATUS, issue, machineOf, routeKey, type CheckIssue, type CheckReport, type Difficulty, type IssueCode, type Section, type World, type WorldStats } from '#engine';
import { assertNever } from '#lib/never';
import { fixtureFed } from './input-coverage.ts';
import { HARD_TASK_ACTIONS, MIX_WITHIN, actionRouteIds, planCoverage, plannedItems, pressurePlanIssues, pressureUnreachable, seedPlanIssues, taskKindLines, type Plan, type PlanList } from './plan.ts';

export const STAGE_IDS = ['model', 'workflow', 'seed', 'tasks'] as const;
export type StageId = (typeof STAGE_IDS)[number];
/** Every step the loop runs. `plan` writes plan.yaml, not world sections. */
export type StepId = 'plan' | StageId;

/** `input` means code writes it (CSV fixtures), never the model. */
export const SECTION_OWNER = {
  entities: 'model',
  routes: 'model',
  actions: 'workflow',
  jobs: 'workflow',
  tests: 'plan',
  seed: 'seed',
  tasks: 'tasks',
  fixtures: 'input',
} as const satisfies Record<Section, StepId | 'input'>;

const TEST_RUN_CODES: ReadonlySet<IssueCode> = new Set(['test.failed', 'snippet.runtime_error', 'test.seed_collision', 'layer.blocked', 'iterate.regression']);

/**
 * Whether `i` comes from running a test that fails, throws or cannot run. The plan owns the tests, but
 * such an issue is the workflow stage's to fix, in the implementation the test checks. A test that
 * throws before workflow has built what it calls is no fault of the plan's (A-361); one whose issue set
 * repeats goes back to the plan by the seen-twice rule (A-165).
 */
export function isTestRun(i: CheckIssue): boolean {
  return i.path[0] === 'tests' && TEST_RUN_CODES.has(i.code);
}

/** `isTestRun` for one entry of an issue-set key, `code@path: found` (policy.ts `issueSetKey`). */
export function isTestRunEntry(entry: string): boolean {
  const at = entry.indexOf('@');
  const code = entry.slice(0, at);
  return at > 0 && [...TEST_RUN_CODES].some((c) => c === code) && /^tests(?:[/:]|$)/.test(entry.slice(at + 1));
}

export type Stage = {
  readonly id: StageId;
  /** Sections this stage reads. Their change makes it rerun on iterate. */
  readonly reads: readonly Section[];
  /** Stage instructions. The generated format reference is appended by run.ts. */
  readonly brief: string;
  /** Plan lists whose items this stage must create. `done` and the checklist in the stage prompt both read it. */
  readonly covers: readonly PlanList[];
  /** Acceptance beyond engine ok, such as "3 tasks covering every difficulty". Engine facts and plan only. */
  readonly done: (report: Extract<CheckReport, { ok: true }>, plan: Plan) => readonly CheckIssue[];
};

type OkReport = Extract<CheckReport, { ok: true }>;

/** Coverage for each plan list, including contracts rooted at their world route or action. */
function coverage(report: OkReport, plan: Plan, lists: readonly PlanList[]): readonly CheckIssue[] {
  return planCoverage(plan, report.world).filter((i) => {
    const list = i.path[0] === 'plan' ? i.path[1] : i.path[0] === 'actions' ? 'workflows' : i.path[0];
    return lists.some((l) => l === list);
  });
}

/** Plan lists each stage must cover. Its `done` and its prompt checklist both read this. */
const COVERS = { model: ['entities', 'routes'], workflow: ['workflows', 'jobs'], seed: [], tasks: ['tasks'] } as const satisfies { readonly [K in StageId]: readonly PlanList[] };

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

function tasksDone(report: OkReport, plan: Plan): readonly CheckIssue[] {
  const tasks = Object.values(report.world.tasks);
  const have = DIFFICULTIES.filter((d) => tasks.some((t) => t.difficulty === d));
  const out: CheckIssue[] = [];
  if (tasks.length < 3) {
    out.push(issue('world.too_few_tasks', ['tasks'], { have: tasks.length }, `${tasks.length} tasks`));
  }
  if (have.length < DIFFICULTIES.length) {
    out.push(issue('tasks.difficulty_not_spread', ['tasks'], { have }, have.join(', ') || 'none'));
  }
  return [...out, ...pagingBlocking(report), ...pressureIssues(report, plan), ...coverage(report, plan, COVERS.tasks)];
}

/** One pressure claim on a task, checked against its reference trace and the seed. `exempt` says why imported data cannot meet it. */
export type PressureCheck = {
  readonly task: string;
  readonly need: string;
  readonly met: boolean;
  readonly exempt: string | null;
  /** Where a miss is repaired: the seed when it lacks the rows, the plan when it pressed what no reference can show, else the task. */
  readonly path: readonly ['seed' | 'tasks', string] | readonly ['plan', 'tasks', number, 'pressure', 'distractors'];
  /** What the trace and the seed show, with the numbers a repair needs. */
  readonly found: string;
};

/** The page size of `entity`'s list routes: the largest, or 0 when it has none. */
const pageSizeOf = (world: World, entity: string): number =>
  Math.max(0, ...Object.values(world.routes).map((r) => (r.op === 'list' && r.entity === entity ? r.pageSize : 0)));

/** Seeded rows of `entity` in `state`, over every state field whose machine has that state. */
function rowsInState(world: World, stats: Pick<WorldStats, 'states'>, entity: string, state: string): number {
  const fields = Object.entries(world.entities[entity]?.fields ?? {}).filter(([, d]) => machineOf(d)?.states.includes(state));
  return fields.reduce((n, [fn]) => n + (stats.states[`${entity}.${fn}`]?.[state] ?? 0), 0);
}

/**
 * What the seed must hold for the pressure the plan's tasks declare, read before any task exists (A-271):
 * rows past one list page for a paging entity, rows in each pressed state, and near-duplicate rows for a
 * distractor entity. An entity fed from an input fixture is left to its input (A-221).
 */
export type SeedNeed = { readonly task: string; readonly entity: string } & (
  | { readonly kind: 'paging'; readonly pageSize: number }
  | { readonly kind: 'state'; readonly state: string }
  | { readonly kind: 'distractors' }
);

export function seedNeeds(plan: Plan, world: World): readonly SeedNeed[] {
  const fed = fixtureFed(world);
  return plan.tasks.flatMap((t): SeedNeed[] => {
    const p = t.pressure;
    if (p === undefined) return [];
    const pageSize = p.paging === undefined ? 0 : pageSizeOf(world, p.paging);
    return [
      ...(p.paging !== undefined && !fed.has(p.paging) && pageSize > 0 ? [{ task: t.id, entity: p.paging, kind: 'paging' as const, pageSize }] : []),
      ...(p.states ?? []).flatMap((es) => {
        const [entity = '', state = ''] = es.split('.');
        return fed.has(entity) || pressureUnreachable(plan, es) ? [] : [{ task: t.id, entity, kind: 'state' as const, state }];
      }),
      ...(p.distractors !== undefined && !fed.has(p.distractors) ? [{ task: t.id, entity: p.distractors, kind: 'distractors' as const }] : []),
    ];
  });
}

/** The seed prompt's lines for `seedNeeds`, each with its exact number and the task that needs it. */
export function seedNeedLines(needs: readonly SeedNeed[]): string[] {
  return needs.map((n) => {
    switch (n.kind) {
      case 'paging': return `- ${n.entity}: at least ${n.pageSize + 1} rows, more than one ${n.pageSize}-row list page, because task ${n.task} must reach a ${n.entity} row past the first page.`;
      case 'state': return `- ${n.entity}.${n.state}: at least one row in that state, because task ${n.task} presses on it.`;
      case 'distractors': return `- ${n.entity}: near-duplicate rows for task ${n.task}: several rows one filtered list returns, of which the task changes only some.`;
      default: return assertNever(n);
    }
  });
}

/**
 * What each planned task's declared pressure asks of its reference solution, with the list mechanics that show it
 * (A-316). Every tasks prompt lists all of them, so a retry keeps the claims it met instead of trading one for another.
 */
export function taskPressureLines(plan: Plan, world: World): string[] {
  const list = world.meta.api.list;
  const pageParams = list.mode === 'stripe' ? `${list.startingAfterParam} or ${list.endingBeforeParam}` : list.cursorParam;
  const next = list.mode === 'stripe' ? `${list.startingAfterParam}=<id of the last row on the page>` : `${list.cursorParam}=<the page's ${list.cursorKey}>`;
  const listOf = (entity: string) => Object.values(world.routes).find((r) => r.op === 'list' && r.entity === entity);
  return plan.tasks.flatMap((t): string[] => {
    const p = t.pressure;
    if (p === undefined) return [];
    const paging = p.paging === undefined ? undefined : listOf(p.paging);
    const near = p.distractors === undefined ? undefined : listOf(p.distractors);
    return [
      ...(p.paging !== undefined && paging?.op === 'list'
        ? [`- ${t.id}, paging ${p.paging}: GET ${paging.path}?${list.limitParam}=${paging.pageSize}, follow ${next} to a later page, and change a ${p.paging} row that appears only there. A list call without ${pageParams} is a first page, a filtered one included, so never fetch that row that way.`]
        : []),
      ...(p.distractors !== undefined && near?.op === 'list'
        ? [`- ${t.id}, distractors ${p.distractors}: call GET ${near.path} with one of its filters (${near.filters.join(', ') || 'none declared'}) so that it returns a ${p.distractors} row the task leaves unchanged, and change at least one ${p.distractors} row. With ${pageParams} too, the call still counts as a later page.`]
        : []),
    ];
  });
}

/**
 * The `seedNeeds` the seed alone can meet, checked at the seed step so a shortfall is repaired there, not at tasks,
 * and plan.pressure_unreachable for a pressed state no seed can meet, which goes back to the plan (A-369).
 */
export function seedNeedIssues(plan: Plan, world: World, stats: Pick<WorldStats, 'rows' | 'states'>): readonly CheckIssue[] {
  return [...pressurePlanIssues(plan), ...seedNeeds(plan, world).flatMap((n): CheckIssue[] => {
    if (n.kind === 'paging') {
      const rows = stats.rows[n.entity] ?? 0;
      return rows > n.pageSize ? [] : [issue('seed.too_few_rows_for_paging', ['seed', n.entity], { entity: n.entity, rows, pageSize: n.pageSize }, `${rows} rows`)];
    }
    if (n.kind === 'state') {
      return rowsInState(world, stats, n.entity, n.state) > 0 ? [] : [
        issue('task.pressure_unmet', ['seed', n.entity], { task: n.task, need: `state: seeded ${n.entity}.${n.state} rows` }, `0 ${n.entity} rows in ${n.state}`),
      ];
    }
    return [];
  })];
}

/**
 * Every pressure claim of the built world's tasks. A hard task must change more than one row or reach a
 * row past the first list page (A-225). A task's planned pressure.paging entity must show such a
 * later-page row, and each pressure.states entry a state field can hold must have seeded rows (A-226, A-227,
 * A-369). An entity fed from an input fixture is exempt, with the reason recorded, because its rows come from the
 * input (A-221).
 */
export function pressureChecks(report: OkReport, plan: Plan): readonly PressureCheck[] {
  const fed = fixtureFed(report.world);
  const planned = new Map(plan.tasks.map((t) => [t.id, t]));
  const planIndex = new Map(plan.tasks.map((t, i) => [t.id, i]));
  const out: PressureCheck[] = [];
  for (const v of Object.values(report.verdicts)) {
    if (v.difficulty === 'hard') {
      out.push({
        task: v.taskId, need: 'hard: changes more than one row or reaches a later page', met: v.solutionRowsChanged > 1 || v.solutionLaterPageEntities.length > 0,
        exempt: null, path: ['tasks', v.taskId], found: `${v.solutionRowsChanged} rows changed, no later page`,
      });
    }
    const p = planned.get(v.taskId)?.pressure;
    if (p?.paging !== undefined) {
      const e = p.paging;
      const rows = report.stats.rows[e] ?? 0;
      const pageSize = pageSizeOf(report.world, e);
      const short = rows <= pageSize;
      out.push({
        task: v.taskId, need: `paging: reaches a ${e} row past the first page`, met: v.solutionLaterPageEntities.includes(e),
        exempt: fed.has(e) && short ? `${e} is imported with ${rows} rows, which fit on one page; the input sets its size` : null,
        path: short ? ['seed', e] : ['tasks', v.taskId],
        found: short ? `${rows} ${e} rows fit one ${pageSize}-row page; seed at least ${pageSize + 1}` : `${rows} ${e} rows over ${pageSize}-row pages, and the reference changed no row it reached only past the first page`,
      });
    }
    if (p?.distractors !== undefined) {
      const e = p.distractors;
      const rows = report.stats.rows[e] ?? 0;
      // With two rows the seed can hold a near-duplicate, so a miss is the reference's filter to change, not the seed's (A-317).
      const seeded = rows >= 2;
      // A distractor counts only on an entity the reference changes rows of (A-230). A claim on one the task only looks up,
      // as the agent of a ticket assignment, no seed or reference can meet, so it is the plan's to fix (A-406).
      const lookup = !v.solutionChangedEntities.includes(e);
      out.push({
        task: v.taskId, need: `distractors: a filtered ${e} list returns a row the reference leaves unchanged`, met: v.solutionDistractorEntities.includes(e),
        exempt: fed.has(e) ? `${e} is imported; the input decides which near-duplicate rows exist, and none were fabricated` : null,
        path: lookup ? ['plan', 'tasks', planIndex.get(v.taskId) ?? 0, 'pressure', 'distractors'] : seeded ? ['tasks', v.taskId] : ['seed', e],
        found: lookup
          ? `the reference changes no ${e} row, so no ${e} row can be a distractor: a distractor is a near-duplicate of a row the task changes`
          : seeded
            ? `${rows} ${e} rows seeded, and no filtered ${e} list in the reference returned a row it left unchanged`
            : `${rows} ${e} rows seeded; seed at least 2 that one filtered list returns`,
      });
    }
    for (const es of (p?.states ?? []).filter((pressed) => !pressureUnreachable(plan, pressed))) {
      const [e = '', s = ''] = es.split('.');
      const n = rowsInState(report.world, report.stats, e, s);
      out.push({
        task: v.taskId, need: `state: seeded ${es} rows`, met: n > 0,
        exempt: fed.has(e) ? `${e} is imported and the input has no ${s} rows; none were fabricated` : null,
        path: ['seed', e], found: `${n} ${e} rows in ${s}`,
      });
    }
  }
  return out;
}

/**
 * task.difficulty_unproven for an unmet hard label, task.pressure_unmet for every other unmet, unexempt claim, and
 * plan.pressure_unreachable for a pressed state no seed can meet, which `pressureChecks` leaves out (A-369).
 */
export function pressureIssues(report: OkReport, plan: Plan): readonly CheckIssue[] {
  return [...pressurePlanIssues(plan), ...pressureChecks(report, plan).filter((c) => !c.met && c.exempt === null).map((c) => {
    if (c.need.startsWith('hard:')) {
      return issue('task.difficulty_unproven', ['tasks', c.task], { task: c.task, rows: report.verdicts[c.task]!.solutionRowsChanged }, c.found);
    }
    return issue('task.pressure_unmet', [...c.path], { task: c.task, need: c.need }, c.found);
  })];
}

/**
 * seed.too_few_rows_for_paging for each entity a task's solution pages through (its list route
 * called for a later page; a first-page lookup with only a limit does not count), owned by seed so
 * the run backtracks there. An entity whose rows come from an input fixture is exempt: the input
 * decides its size, and REPORT.md says so (A-182, A-360).
 */
export function pagingBlocking(report: OkReport): readonly CheckIssue[] {
  const paged = new Set(Object.values(report.verdicts).flatMap((v) => v.solutionPagedEntities));
  const fed = fixtureFed(report.world);
  return report.warnings.filter((w) => {
    const entity = String(w.path[1]);
    return w.code === 'seed.too_few_rows_for_paging' && paged.has(entity) && !fed.has(entity);
  });
}

/** The plan step's instructions. It writes plan.yaml, not world sections. */
export const PLAN_BRIEF =
  'Read the input and write revision 1 of the plan that every later stage follows, saved as plan.yaml, and raise revision by one each time the plan step runs again. ' +
  "Decide feasibility first by asking what the request's core value is: it is feasible only when that value is stateful records an agent reads and changes through an API, with actions it performs on them, such as a job queue or an order desk; if the core value is the computation itself, such as encoding media, rendering, training a model, or a user interface, or if the request is harmful, refuse with verdict refuse, why naming the reason, feasibleIf naming a request about records that would be feasible, and empty workflows and tasks, and never reinterpret the request as a management or control-plane service for the thing it names, since a request named for the thing wants the thing. " +

  'Name the real software it mirrors, then list its entities, workflows with their actions, jobs, routes (for an OpenAPI input, every operation in scope by method and path, one that a workflow action builds taking that action\'s name as its id), acceptanceTests, a small seed (rowsPerEntity just over one list page on the main entity and a handful elsewhere, except that an imported CSV table keeps exactly its rows and values: its rowsPerEntity is the CSV row count, every value of its status column is a workflow state, and generated rows go only to entities with no fixture, with a mix that spreads every state and a stateMix giving, per workflow entity whose states a state field holds, the percent of its rows in each state, and none for an entity whose every workflow declares a removal or descriptive lifecycle), and at least three tasks graded easy, medium and hard that differ in shape, not only in size: at least one hard task lists in its actions ' +
  `${HARD_TASK_ACTIONS} or more distinct workflow actions its reference solution calls in turn, such as assigning a row and then resolving it, and at least one task has a task kind (one of ${taskKindLines().join('; ')});` +
  ' write a rule enforced by actions or jobs as { rule, by, test }, by naming the enforcing action or job keys and test naming the id of the acceptance test that exercises the rule through that enforcement, each acceptance test bound by at most one rule and, when by names actions, its bound test exercising one of them; write a rule only the data model enforces as { rule, schema } with the reason the schema enforces it; keep plain text only for context neither enforces. ' +
  'Declare lifecycle: { representation: descriptive or removal, reason } on a workflow whose states no state field holds, such as a derived flag or deletion by removal, because a state-named workflow with no machine and no declaration is rejected. ' +
  'Set clock.start and clock.tick explicitly, choosing deterministic time after imported historical events, distinguish future scheduled events, and record the clock choice in assumptions. ' +
  'Write acceptanceTests now, before implementation: each needs a unique id, observable intent, the workflow actions it exercises, a human-readable description and a ctx.api/ctx.assert script that checks the public behavior and creates every row it needs through the API, never relying on seed rows, because the workflow stage runs the tests before any seed exists, and never counting or listing rows it did not create, because the same tests run again after the seed adds rows; they become the world\'s tests exactly as written, and no later stage can edit them. ' +
  'Before planning, list each question you would ask a human about the input in open_questions, each with a question and a default_answer, and record every default as an entry in assumptions with the decision and why; never guess silently, because a gap you fill without an assumption is a defect, and what you leave out goes in outOfScope with why.';

/**
 * The seed warnings that block the seed stage, on an ok or a failed report. Paging coverage does not (A-95): the tasks stage blocks it once a solution pages (pagingBlocking, A-182). A skewed
 * state mix blocks only when it leaves a state with no rows that a planned task mentions: a state above its share is
 * advisory, and so is a missing state no task needs. The warning still reaches the check output and REPORT.md (A-129).
 */
export function seedBlocking(warnings: readonly CheckIssue[], plan: Plan): readonly CheckIssue[] {
  const taskText = plan.tasks.map((t) => `${t.intent} ${t.decoyIdea}`).join(' ').toLowerCase();
  const neededButMissing = (w: CheckIssue): boolean =>
    [...w.found.matchAll(/"([^"]+)" has no rows/g)].some((m) => taskText.includes(m[1]!.toLowerCase()));
  return warnings.filter((w) => w.code.startsWith('seed.') && w.code !== 'seed.too_few_rows_for_paging' && (w.code !== 'seed.state_mix_skewed' || neededButMissing(w)));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One line per imported column whose every filled cell is a date with no time, such as 2026-08-28 (YOS-247). The model
 * step is told to type it as a string with a date pattern: a datetime field cannot hold those values unchanged, and the
 * seed step, which owns the values, cannot change a field type.
 */
export function dateOnlyColumnLines(world: World): string[] {
  const lines: string[] = [];
  for (const [table, rows] of Object.entries(world.fixtures)) {
    for (const column of Object.keys(rows[0] ?? {})) {
      const cells = rows.map((r) => r[column]).filter((v) => v !== null && v !== undefined && v !== '');
      if (cells.length === 0 || !cells.every((v) => typeof v === 'string' && DATE_ONLY.test(v))) continue;
      lines.push(`- ${table}.${column} holds dates with no time, such as ${String(cells[0])}: type its field string with pattern ^\\d{4}-\\d{2}-\\d{2}$, never datetime, so the imported values seed unchanged.`);
    }
  }
  return lines;
}

export const STAGES = {
  model: {
    id: 'model',
    reads: ['fixtures'],
    brief:
      'Write the entities and routes sections for every entity in the plan and every plan route that no workflow action claims. ' +
      'Give each entity typed fields, refs and a state machine where the plan names states, declaring every state of its planned workflow, and add standard list, get, create, update and delete routes. ' +
      'A plan route whose id is also a workflow action name is an action route: the workflow stage builds it as an action, so never declare it in routes, or its path is taken and the action fails with route.duplicate_path. ' +
      'Every other planned entity and route must be a key spelled exactly as its plan name or id, not its path, as the Required keys list in the prompt names them; the engine judges this stage with the schema and references layers.',
    covers: COVERS.model,
    done: (report, plan) => coverage(report, plan, COVERS.model),
  },
  workflow: {
    id: 'workflow',
    reads: ['entities', 'routes', 'tests'],
    brief:
      'Write the actions and jobs sections for every workflow in the plan. ' +
      'Each planned action becomes a handler that enforces the workflow rules, and each planned job runs on its schedule; for simple guards, state transitions, assignments and timers prefer the declarative rules list on the action or job, with the handler or run set to a placeholder such as "(ctx) => null", because code replaces it with the source the rules lower to. ' +
      'The tests section already holds the acceptance tests from the approved plan, so make the handlers pass them and never edit, remove or replace a test, because an edit that touches tests sends the run back to the plan step. ' +
      'Every planned action must be a key in actions, and every planned job a key in jobs, spelled exactly as in the plan, and a planned rule with by needs one of the actions or jobs it names, and each planned rule with by must pass the frozen acceptance test it binds, and the handler or job it names must make that scenario pass. ' +
      "Routes and actions share one path space: an action's method and path, with every {param} segment counted as the same, must differ from every route's, or the engine raises route.duplicate_path; " +
      'standard routes already serve list, get, create, update and delete, so give each action its own sub-path such as POST /<collection>/{id}/<verb>, never a method and path a route already declares. ' +
      'The engine judges this stage with the compile and tests layers, and an action no test calls blocks it.',
    covers: COVERS.workflow,
    done: (report, plan) => [
      ...coverage(report, plan, COVERS.workflow),
      ...report.stats.unexercisedActions.map((a) =>
        issue('action.unexercised', ['actions', a], { action: a }, `no test calls ${a}`),
      ),
    ],
  },
  seed: {
    id: 'seed',
    reads: ['entities', 'fixtures'],
    brief:
      'Write the seed section with one generator per entity, following the row counts and mix in the plan. ' +
      'Keep the seed small, because the first seed call is most of the time budget: use fixtures unchanged when the input supplied them, every row and value as imported, otherwise just over one page of rows on the main entity so paging matters and a handful on every other entity, and keep every state field spread so no state holds more than 70% of its rows. ' +
      'Entities that ref each other need one nullable ref (nullable: true, not required) to have a seed order, and that ref may name a row of an entity seeded later by its id, such as "bkg_0001" (the idPrefix and a four-digit count, in row order), which must resolve once every seed has run, so count the later entity\'s rows. ' +
      'Tests run against the seeded world and create rows through the API. Read every script in tests and keep the seed rows away from the unique values (names, codes, skus, emails) those scripts create. ' +
      `The engine judges this stage with the seed layer, so any seed warning from the lints layer except paging coverage blocks it, and so does an entity with fewer rows than the plan's rowsPerEntity, or a state share more than ${MIX_WITHIN} points off its stateMix, unless the input supplies it as fixtures, and so does a miss on what the prompt lists the planned tasks need from the seed: more rows than one list page of an entity a task must page through, and rows in each state a task presses on.`,
    covers: COVERS.seed,
    done: (report, plan) => [...seedBlocking(report.warnings, plan), ...seedPlanIssues(plan, report.stats, report.world), ...seedNeedIssues(plan, report.world, report.stats)],
  },
  tasks: {
    id: 'tasks',
    reads: ['entities', 'routes', 'actions', 'jobs', 'seed'],
    brief:
      'Write the tasks section with every task in the plan, at least three covering easy, medium and hard. ' +
      'Each task has an instruction, a grader, a solution that uses the public API and calls through ctx.api each action the plan lists for the task, and decoys on medium and hard tasks, and a task the plan gives a task kind is built as that task kind says (' +
      `${taskKindLines().join('; ')}). ` +
      'Give each medium and hard task at least one decoy that does part of the work and scores above 0 but below 1, such as one that fixes only the first page of matches, and make each decoy script do exactly what its why says: Stripe-mode lists are newest first, so a list read right after a write (for example GET /v1/refunds?limit=1) returns the row the script just created, and a decoy that edits that row scores 1 like the solution. ' +
      'In every grader, call ctx.guardChanges with each row the task may change, its kind and its exact fields, and give the task an allows list taken from its instruction, not from what the solution writes (each entity, kind, exact update fields, and a where of field values that picks the target rows), so any collateral write scores 0. ' +
      'A solution that asks a list for a later page (a cursor, starting_after or ending_before parameter) needs that entity seeded past one page, or the run goes back to the seed step; a first-page lookup with only a limit does not count. ' +
      'The engine judges this stage with the tasks layer: the solution scores 1, doing nothing scores 0, and every decoy and partial solution scores below 1.',
    covers: COVERS.tasks,
    done: tasksDone,
  },
} as const satisfies { readonly [K in StageId]: Stage & { readonly id: K } };

/** Sections a stage may write. Derived from SECTION_OWNER. */
export function writesOf(stage: StageId): readonly Section[] {
  return (Object.keys(SECTION_OWNER) as Section[]).filter((s) => SECTION_OWNER[s] === stage);
}

/** Stages an iterate run must execute, given the sections the plan says will change. */
export function stagesToRun(changed: ReadonlySet<Section>): readonly StageId[] {
  return STAGE_IDS.filter((id) => [...writesOf(id), ...STAGES[id].reads].some((s) => changed.has(s)));
}

/**
 * The exact keys this stage must create, read from the list plan coverage checks, so the prompt
 * and the judge cannot drift. Keys the world already holds are marked.
 */
export function stageChecklist(stage: StageId, plan: Plan, world: World): string[] {
  const covers: readonly PlanList[] = STAGES[stage].covers;
  const items = plannedItems(plan).filter((p) => covers.includes(p.list));
  if (items.length === 0) return [];
  return [
    'The judge raises plan.not_covered for each of these keys the world lacks. Use each key exactly as written:',
    '',
    ...items.map((p) => `- ${p.section}.${p.key}${Object.hasOwn(world[p.section], p.key) ? ' (exists)' : ''}`),
  ];
}

/** At the model stage, the plan routes a workflow action claims, which routes must not declare. Empty elsewhere. */
export function actionRoutesLeftOut(stage: StageId, plan: Plan): string[] {
  const ids = [...actionRouteIds(plan)];
  if (stage !== 'model' || ids.length === 0) return [];
  return ['The workflow stage builds these plan routes as actions. Never declare them in routes:', '', ...ids.map((id) => `- ${id}`)];
}

/**
 * The codes the engine answers errors with, for the plan step, which writes the acceptance tests
 * before any handler exists. A frozen test that asserts a code the engine never sends fails at the
 * workflow stage, which cannot edit tests (live rehearsal L2: not_found against row.not_found).
 */
export function engineErrorCodes(): string[] {
  return [
    'Standard routes and the engine answer errors with these codes. An acceptance test that expects one of these errors must assert this exact code, never a code of its own such as not_found; only an action handler\'s ctx.fail answers with codes the plan names:',
    '',
    ...Object.entries(ENGINE_ERROR_CODES).map(([code, { status, meaning }]) => `- ${code} (${status}): ${meaning}`),
  ];
}

/** The engine's success status per standard op, so a frozen acceptance test never asserts another API's status, such as Stripe's 200 on a create. */
export function engineSuccessStatuses(): string[] {
  return [
    'Standard routes answer success with these statuses. An acceptance test that checks a standard route\'s status must assert this one, whatever the source API returns:',
    '',
    ...Object.entries(OP_SUCCESS_STATUS).map(([op, status]) => `- ${op}: ${status}`),
  ];
}

/** On OpenAPI input the fidelity check and the frozen tests use the spec's names, so a renamed field fails both. */
export const SPEC_FIELD_NAMES = ['Keep every field name exactly as the spec spells it, such as photoUrls; never rename one to snake_case.'];

/** Method and path pairs the world's routes already own. No action may reuse one (route.duplicate_path). */
export function takenPaths(world: World): string[] {
  return Object.entries(world.routes).map(([name, r]) => `- ${r.method} ${r.path} (routes.${name})`);
}

/**
 * The route.duplicate_path rule shown with a route and an action from the example world that share
 * a method and collection, or null when it has no such pair.
 */
export function pathRuleExample(example: World): string | null {
  const first = (path: string) => path.split('/').find((s) => s !== '') ?? '';
  for (const [aName, a] of Object.entries(example.actions)) {
    const clash = Object.entries(example.routes).find(([, r]) => r.method === a.method && first(r.path) === first(a.path));
    if (clash === undefined || routeKey(clash[1].method, clash[1].path) === routeKey(a.method, a.path)) continue;
    const [rName, r] = clash;
    return `Example from the example world: routes.${rName} declares ${r.method} ${r.path}, so no action may use ${r.method} ${r.path}. ` +
      `actions.${aName} uses ${a.method} ${a.path} instead.`;
  }
  return null;
}
