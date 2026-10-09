/**
 * What a plan is, and whether a world follows it. plan.yaml is the human-readable plan
 * that every later stage is prompted with.
 *
 * Invariant: code checks planned keys and route contracts. No model is asked.
 */
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { InputKind } from './input.ts';
import { fixtureFed } from './input-coverage.ts';
import { issue, machineOf, routeKey, worldSchema, type CheckIssue, type IssuePath, type World, type WorldStats } from '#engine';

/** How many percentage points a seeded state share may stray from `seed.stateMix`. */
export const MIX_WITHIN = 10;

const planBase = z.object({
  revision: z.number().int().positive().default(1).describe('increment this when explicitly revising an already-approved plan'),
  software: z.string().describe('the real product this world mirrors, such as "Zendesk-style helpdesk"'),
  summary: z.string(),
  clock: worldSchema.shape.meta.shape.clock.describe(
    'Explicit deterministic world time. Choose a start after imported historical events; future scheduled events may remain in the future. Never use the wall clock.'),
  entities: z.array(z.object({ name: z.string(), purpose: z.string(), keyFields: z.array(z.string()) })),
  jobs: z.array(z.object({ name: z.string(), every: z.string(), rule: z.string() })).default([]),
  routes: z.array(z.object({ id: z.string(), method: z.string(), path: z.string(), purpose: z.string() })),
  acceptanceTests: z.array(z.object({
    id: z.string(),
    intent: z.string(),
    actions: z.array(z.string()).min(1).describe('the workflow actions this test exercises, each one declared in the actions of a workflow above; to test an operation such as create_customer, declare it in its workflow\'s actions first'),
    description: z.string(),
    script: z.string().describe('a client script that checks this acceptance case through ctx.api and ctx.assert'),
  })).default([]).describe('acceptance tests fixed by the approved plan before implementation repair begins'),
  seed: z.object({
    rowsPerEntity: z.record(z.string(), z.number().int()),
    mix: z.string(),
    stateMix: z.record(z.string(), z.record(z.string(), z.number().min(0).max(100))).optional()
      .describe(`for each workflow entity whose states a state field holds, the percent of its seeded rows in each workflow state, summing to 100, such as { ticket: { open: 60, closed: 40 } }; the built seed must land within ${MIX_WITHIN} points of each. Leave out an entity whose every workflow declares a lifecycle, since no state field holds its states`),
  }),
  open_questions: z
    .array(z.object({ question: z.string(), default_answer: z.string() }))
    .optional()
    .describe('each question a human would be asked, with the answer the plan takes by default'),
  assumptions: z.array(z.object({ decision: z.string(), why: z.string() })),
  outOfScope: z.array(z.object({ what: z.string(), why: z.string() })),
  changes: z.array(z.string()).default([]).describe(
    'iterate only: every existing item this request changes or removes, as a dotted name. An item whose name shares no word with the request needs a reason quoted from it: `<dotted name> because <words of the request>` (A-289).'),
});

const BECAUSE = /\s+because\s+/i;
/** The dotted item a plan.changes entry names: the text before ` because `. */
export const changeItem = (entry: string): string => entry.split(BECAUSE)[0]?.trim() ?? '';
/** The reason a plan.changes entry quotes from the request, or null when it gives none. */
export const changeReason = (entry: string): string | null => {
  const at = entry.search(BECAUSE);
  return at < 0 ? null : entry.slice(at).replace(BECAUSE, '').trim();
};

const behavioralRule = z.object({
  rule: z.string(),
  by: z.array(z.string()).min(1).describe('the workflow action keys or job names that enforce this rule'),
  test: z.string().describe('the id of the acceptance test that exercises this rule through an enforcing action or job'),
});
const schemaRule = z.object({
  rule: z.string(),
  schema: z.string().min(1).describe('why the data model alone enforces this rule; the declared exemption from the frozen-scenario binding'),
});
const ruleItem = z.union([z.string(), behavioralRule, schemaRule]).describe(
  'a rule as text, or { rule, by, test } when actions or jobs enforce it and a frozen acceptance test exercises it, or { rule, schema } when the data model alone enforces it',
);
type PlanRule = z.output<typeof ruleItem>;
type BehavioralRule = z.output<typeof behavioralRule>;

/** A behavioral rule: an object rule bound to a frozen acceptance test. A schema rule names none. */
const isBehavioral = (r: PlanRule): r is BehavioralRule => typeof r !== 'string' && 'test' in r;

const workflowItem = z.object({ name: z.string(), entity: z.string(), states: z.array(z.string()), rules: z.array(ruleItem),
  lifecycle: z.object({ representation: z.enum(['descriptive', 'removal']), reason: z.string().min(1) }).optional()
    .describe('declared when this workflow\'s states are not held by a state field: a derived flag, or deletion by removal'),
  actions: z.array(z.string()).describe('action keys exactly as in world.actions, such as resolve_ticket; a plan route with the same id is built as this action, not as a route') });
const pressureItem = z.object({
  paging: z.string().optional().describe('entity whose list the reference must page past the first page to reach a target row'),
  states: z.array(z.string()).optional().describe('entity.state values the task needs seeded rows in, such as ticket.pending; never a state only a workflow with a declared lifecycle names, since no state field holds it'),
  distractors: z.string().optional().describe('an entity the task changes rows of, whose near-duplicate rows the reference must tell apart: a filtered list must return a row of it the task leaves unchanged; never an entity the task only looks up'),
}).describe('what makes the task as hard as its label; the judge checks it against the reference trace and the seed (A-226, A-227)');
/** What a task is about beyond its difficulty, and what each kind means; the plan step and the tasks step are told (A-390). */
export const TASK_KINDS = {
  permissions: 'the world records who may act on a row, such as a role, an owner or an assignee, and an action checks it, so the task acts only where it is allowed and a decoy acts where it is not',
  scarce_resource: 'a limited supply, such as seats, stock, rooms, slots or budget, that competing requests draw on, so the task allocates within capacity and a decoy overbooks or serves the wrong request',
  two_actors: 'two parties act on the same records in turn, such as a requester and an approver, so the task makes both sides\' calls in order and a decoy makes only one side\'s',
  irreversible: 'a step that cannot be undone, such as a refund, a cancellation or a deletion, so the task checks its preconditions before acting and a decoy acts on the wrong row or before checking',
  time_sensitive: 'which rows to act on depends on the current time, which the instruction states, against seeded due dates, deadlines or expiries with rows just before and just after the cutoff; the reference compares them with ctx.now(), and a decoy goes by creation order, a status flag or the wrong side of the cutoff',
  policy_conflict: 'the request collides with a world rule or a policy the instruction states for some of the rows, so for those the correct move is to refuse, leaving them unchanged, or to escalate them through an action; the grader rewards changing only the allowed rows, and a decoy carries out the whole request',
  investigation: 'the target is found only by combining facts from several entities and reading past the first list page, with near-miss rows that match all facts but one; the reference pages and cross-checks, and a decoy stops at the first page, trusts one entity or takes a near miss',
  misleading_text: 'seeded rows carry misleading text, such as a note saying already refunded or ignore the limit on a row whose fields say otherwise, or a near-duplicate name; the instruction says what to go by, the reference follows the fields and the rule, and a decoy follows the text',
} as const;
export type TaskKind = keyof typeof TASK_KINDS;
const TASK_KIND_IDS = Object.keys(TASK_KINDS) as [TaskKind, ...TaskKind[]];
/** The kinds a hard task must have (A-405): each fails an agent that skims, trusts the first plausible row or follows planted text. */
export const HARD_TASK_KINDS = ['time_sensitive', 'policy_conflict', 'investigation', 'misleading_text', 'irreversible'] as const satisfies readonly TaskKind[];
/** Each kind with its meaning, for prompts and messages. */
export const taskKindLines = (): string[] => TASK_KIND_IDS.map((k) => `${k}: ${TASK_KINDS[k]}`);
/** The fewest distinct workflow actions a plan's multi-action hard task names (A-390). */
export const HARD_TASK_ACTIONS = 2;

const taskItem = z.object({
  id: z.string(), difficulty: z.enum(['easy', 'medium', 'hard']),
  kind: z.enum(TASK_KIND_IDS).optional().describe(`what the task is about beyond its difficulty, one of ${taskKindLines().join('; ')}`),
  intent: z.string(),
  actions: z.array(z.string()).optional().describe('the distinct workflow actions the reference solution calls through ctx.api, each declared in the actions of a workflow above'),
  decoyIdea: z.string(), pressure: pressureItem.optional(),
});

/**
 * One object root (a model tool input_schema must be type object). A refusal owes no workflows
 * or tasks; a plan to build owes at least one workflow and three graded tasks, enforced below.
 */
export const planSchema = planBase
  .extend({
    verdict: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('proceed') }),
      z.object({ kind: z.literal('refuse'), why: z.string(), feasibleIf: z.string().optional().describe('what a feasible version of this request would ask for') }),
    ]),
    workflows: z.array(workflowItem),
    tasks: z.array(taskItem),
  })
  .superRefine((plan, ctx) => {
    if (plan.verdict.kind !== 'proceed') return;
    if (plan.workflows.length < 1) {
      ctx.addIssue({ code: 'too_small', origin: 'array', minimum: 1, inclusive: true, path: ['workflows'], message: 'a plan to build needs at least one workflow' });
    }
    if (plan.tasks.length < 3) {
      ctx.addIssue({ code: 'too_small', origin: 'array', minimum: 3, inclusive: true, path: ['tasks'], message: 'a plan to build needs at least three tasks' });
    }
    const ids = plan.acceptanceTests.map((t) => t.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['acceptanceTests'], message: 'acceptance test ids must be unique' });
    }
    const known = new Set(plan.workflows.flatMap((w) => w.actions.map(actionKey)));
    const jobs = new Set(plan.jobs.map((j) => j.name));
    const enforcers = new Set([...known, ...jobs]);
    /** The first rule that binds each acceptance test, so a later binding of the same test names it. */
    const bound = new Map<string, { readonly workflow: string; readonly rule: string }>();
    plan.workflows.forEach((w, wi) => w.rules.forEach((r, ri) => {
      for (const key of ruleBy(r).map(actionKey)) {
        if (!enforcers.has(key)) ctx.addIssue({ code: 'custom', path: ['workflows', wi, 'rules', ri, 'by'], message: `rule of ${w.name} names ${key}, which is no workflow action or job` });
      }
      if (!isBehavioral(r)) return;
      const test = plan.acceptanceTests.find((t) => t.id === r.test);
      if (test === undefined) {
        ctx.addIssue({ code: 'custom', path: ['workflows', wi, 'rules', ri, 'test'], message: `rule of ${w.name} binds test ${r.test}, which is no acceptance test id` });
      }
      const first = bound.get(r.test);
      if (first !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['workflows', wi, 'rules', ri, 'test'], message: `rule of ${w.name} binds test ${r.test}, which the rule "${first.rule}" of workflow ${first.workflow} already binds` });
      } else {
        bound.set(r.test, { workflow: w.name, rule: r.rule });
      }
      const byActions = ruleBy(r).map(actionKey).filter((key) => known.has(key));
      if (test === undefined || byActions.length === 0) return;
      const exercised = test.actions.map(actionKey).some((key) => byActions.includes(key)) && CALLS_API.test(test.script);
      if (!exercised) {
        ctx.addIssue({ code: 'custom', path: ['workflows', wi, 'rules', ri, 'test'], message: `rule of ${w.name} binds test ${r.test}, which does not exercise its enforcing action ${byActions.join(' or ')}: the test must name one of them in its actions and call it through ctx.api in its script` });
      }
    }));
    const entityNames = new Set(plan.entities.map((e) => e.name));
    plan.tasks.forEach((t, ti) => {
      const p = t.pressure;
      if (p?.paging !== undefined && !entityNames.has(p.paging)) {
        ctx.addIssue({ code: 'custom', path: ['tasks', ti, 'pressure', 'paging'], message: `pressure.paging names ${p.paging}, which is no planned entity` });
      }
      if (p?.distractors !== undefined && !entityNames.has(p.distractors)) {
        ctx.addIssue({ code: 'custom', path: ['tasks', ti, 'pressure', 'distractors'], message: `pressure.distractors names ${p.distractors}, which is no planned entity` });
      }
      (p?.states ?? []).forEach((es, si) => {
        const [entity, state] = es.split('.');
        if (state === undefined || !plan.workflows.some((w) => w.entity === entity && w.states.includes(state))) {
          ctx.addIssue({ code: 'custom', path: ['tasks', ti, 'pressure', 'states', si], message: `pressure state ${es} is not entity.state of a planned workflow` });
        }
      });
    });
    for (const [entity, mix] of Object.entries(plan.seed.stateMix ?? {})) {
      const states = new Set(plan.workflows.filter((w) => w.entity === entity).flatMap((w) => w.states));
      if (states.size === 0) ctx.addIssue({ code: 'custom', path: ['seed', 'stateMix', entity], message: `stateMix names ${entity}, which is no workflow entity` });
      for (const state of Object.keys(mix).filter((st) => states.size > 0 && !states.has(st))) {
        ctx.addIssue({ code: 'custom', path: ['seed', 'stateMix', entity, state], message: `stateMix names ${state}, which is no planned state of ${entity}` });
      }
      const total = Object.values(mix).reduce((a, b) => a + b, 0);
      if (Math.abs(total - 100) > 1) ctx.addIssue({ code: 'custom', path: ['seed', 'stateMix', entity], message: `stateMix shares of ${entity} sum to ${total}, not 100` });
    }
    plan.acceptanceTests.forEach((t, i) => {
      if ([t.id, t.intent, t.description, t.script].some((s) => s.trim() === '')) {
        ctx.addIssue({ code: 'custom', path: ['acceptanceTests', i], message: 'acceptance test id, intent, description and script must not be blank' });
      }
      for (const action of t.actions.map(actionKey)) {
        if (!known.has(action) && !jobs.has(action)) ctx.addIssue({ code: 'custom', path: ['acceptanceTests', i, 'actions'], message: `acceptance test ${t.id} names ${action}, which no workflow declares in its actions: add ${action} to the actions of the workflow it belongs to, or name an action a workflow declares` });
      }
    });
  });
export type Plan = z.output<typeof planSchema>;

const CALLS_API = /(?:^|[^A-Za-z0-9_])ctx\.api\s*\(/;

/** Planned workflow actions that no acceptance test both names and reaches through ctx.api, in plan order. */
export function untestedActions(plan: Plan): readonly string[] {
  const tested = new Set(plan.acceptanceTests.filter((t) => CALLS_API.test(t.script)).flatMap((t) => t.actions.map(actionKey)));
  return [...new Set(plan.workflows.flatMap((w) => w.actions.map(actionKey)))].filter((a) => !tested.has(a));
}

const asJob = (key: string): string => `${key} is a job: a job runs on the clock, so list it only under jobs and in a rule's by, and let the test call the workflow action that sets up the job's rows through ctx.api, name that action in its actions, then reach the job with ctx.advance`;

/**
 * A proposed plan that lists a plan job as a workflow or test action, which the workflow step would build twice (A-382).
 * Only the proposal schemas (`planSchemaFor`, `iteratePlanSchema`) refuse it, so `parsePlanYaml` still loads an older plan.
 */
export function jobActionIssues(plan: Plan, ctx: z.RefinementCtx): void {
  const jobs = new Set(plan.jobs.map((j) => j.name));
  plan.workflows.forEach((w, wi) => w.actions.forEach((a, ai) => {
    const key = actionKey(a);
    if (jobs.has(key)) ctx.addIssue({ code: 'custom', path: ['workflows', wi, 'actions', ai], message: `workflow ${w.name} lists ${key} in its actions, but ${asJob(key)}` });
  }));
  plan.acceptanceTests.forEach((t, i) => {
    for (const action of t.actions.map(actionKey).filter((key) => jobs.has(key))) {
      ctx.addIssue({ code: 'custom', path: ['acceptanceTests', i, 'actions'], message: `acceptance test ${t.id} names ${action} in its actions, but ${asJob(action)}` });
    }
  });
}

const declaredActions = (plan: Plan): ReadonlySet<string> => new Set(plan.workflows.flatMap((w) => w.actions.map(actionKey)));
/** A hard task naming at least HARD_TASK_ACTIONS distinct actions the plan declares. */
const multiActionHard = (t: Plan['tasks'][number], known: ReadonlySet<string>): boolean =>
  t.difficulty === 'hard' && new Set((t.actions ?? []).map(actionKey).filter((k) => known.has(k))).size >= HARD_TASK_ACTIONS;

/**
 * Task variety in a proposed plan (A-390, A-405). A task's actions must name workflow actions the plan declares. When
 * `owed`, as on create, at least one hard task names two or more distinct actions its reference solution calls, and
 * every hard task has a hard kind; an iterate plan instead keeps each existing task's kind and actions
 * (`iteratePlanSchema`). Only the proposal schemas apply it, like jobActionIssues, so `parsePlanYaml` still loads a plan
 * written before it.
 */
export function taskVarietyIssues(plan: Plan, ctx: z.RefinementCtx, owed: boolean): void {
  const known = declaredActions(plan);
  plan.tasks.forEach((t, ti) => (t.actions ?? []).forEach((a, ai) => {
    const key = actionKey(a);
    if (!known.has(key)) ctx.addIssue({ code: 'custom', path: ['tasks', ti, 'actions', ai], message: `task ${t.id} names ${key} in its actions, which no workflow declares in its actions` });
  }));
  if (!owed) return;
  if (!plan.tasks.some((t) => multiActionHard(t, known))) {
    ctx.addIssue({ code: 'custom', path: ['tasks'], message: `a plan to build needs at least one hard task whose actions name ${HARD_TASK_ACTIONS} or more distinct workflow actions its reference solution calls, such as one that assigns a row and then resolves it` });
  }
  const hardKinds: readonly TaskKind[] = HARD_TASK_KINDS;
  plan.tasks.forEach((t, ti) => {
    if (t.difficulty !== 'hard' || (t.kind !== undefined && hardKinds.includes(t.kind))) return;
    ctx.addIssue({ code: 'custom', path: ['tasks', ti, 'kind'], message: `hard task ${t.id} needs a hard kind, one of ${HARD_TASK_KINDS.join(', ')}: a hard task is hard for what it asks an agent to notice, not for its size` });
  });
}

/**
 * planSchema plus the rules of a plan that builds a new world: its acceptance tests exist before
 * implementation and cover every workflow action, a description plan asks at least one open
 * question, every plan records at least one assumption (A-180), and every workflow entity whose
 * states a state field holds has a planned stateMix that the seed step is then judged against
 * (A-183). An entity whose every workflow declares a lifecycle has no state field to mix, so it owes
 * none (A-371). Its tasks owe the variety of `taskVarietyIssues` (A-390). Refusals have no such rules.
 */
export function planSchemaFor(inputKind: InputKind) {
  return planSchema.superRefine((plan, ctx) => {
    if (plan.verdict.kind !== 'proceed') return;
    jobActionIssues(plan, ctx);
    taskVarietyIssues(plan, ctx, true);
    if (plan.acceptanceTests.length === 0) {
      ctx.addIssue({ code: 'too_small', origin: 'array', minimum: 1, inclusive: true, path: ['acceptanceTests'], message: 'a plan to build needs acceptance tests before implementation begins' });
    }
    for (const action of untestedActions(plan)) {
      ctx.addIssue({ code: 'custom', path: ['acceptanceTests'], message: `acceptance tests must cover workflow action ${action}` });
    }
    if (inputKind === 'description' && (plan.open_questions ?? []).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['open_questions'],
        message: 'a plan built from a description needs at least one open question with the default answer taken: ask what a human would be asked',
      });
    }
    for (const entity of new Set(plan.workflows.filter((w) => w.lifecycle === undefined).map((w) => w.entity))) {
      if (!Object.hasOwn(plan.seed.stateMix ?? {}, entity)) {
        ctx.addIssue({ code: 'custom', path: ['seed', 'stateMix', entity], message: `a plan to build needs seed.stateMix for workflow entity ${entity}, whose states a state field holds: the percent of its rows in each planned state, summing to 100` });
      }
    }
    if (plan.assumptions.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['assumptions'],
        message: inputKind === 'description'
          ? 'a plan built from a description needs at least one assumption: answer each open question and record it'
          : `a plan built from ${inputKind} input needs at least one assumption: record each field, rule or value the input does not give`,
      });
    }
  });
}

/**
 * world.tests once `plan` is approved: `base` (the old world's tests on iterate, none on create)
 * with every planned acceptance test written over it, less each base test that the plan no
 * longer lists and that plan.changes names exactly as `tests.<id>`.
 */
export function frozenTests(plan: Plan, base: World['tests']): World['tests'] {
  const named = new Set(plan.changes.map(changeItem));
  return {
    ...Object.fromEntries(Object.entries(base).filter(([id]) => !named.has(`tests.${id}`))),
    ...Object.fromEntries(plan.acceptanceTests.map(({ id, description, script }) => [id, { description, script }])),
  };
}

/** The plan lists that name world items. path[1] of a coverage issue is one of these. */
export type PlanList = 'entities' | 'routes' | 'workflows' | 'jobs' | 'acceptanceTests' | 'tasks';

/** One world item the plan promises: the world must hold `section.key`, where key is the exact plan name. */
export type PlannedItem = {
  readonly list: PlanList;
  readonly kind: string;
  readonly section: 'entities' | 'routes' | 'actions' | 'jobs' | 'tests' | 'tasks';
  readonly key: string;
  readonly path: IssuePath;
};

/**
 * The world key a plan action entry names: its leading name, so "place_order (POST /store/orders)"
 * names actions.place_order. Plans in real runs annotate actions with their route this way.
 */
export function actionKey(entry: string): string {
  return /^[^\s(]+/.exec(entry.trim())?.[0] ?? entry;
}

/** Plan route ids that a workflow action claims by sharing its name. The workflow stage builds them as actions, never as routes. */
export function actionRouteIds(plan: Plan): ReadonlySet<string> {
  const actions = new Set(plan.workflows.flatMap((w) => w.actions.map(actionKey)));
  return new Set(plan.routes.map((r) => r.id).filter((id) => actions.has(id)));
}

/**
 * Every world item the plan promises, in plan order. Coverage and the stage briefs both read this
 * list. A plan route claimed by a workflow action is promised once, as that action.
 */
export function plannedItems(plan: Plan): readonly PlannedItem[] {
  const claimed = actionRouteIds(plan);
  return [
    ...plan.entities.map((e, i): PlannedItem => ({ list: 'entities', kind: 'entity', section: 'entities', key: e.name, path: ['plan', 'entities', i] })),
    ...plan.routes.flatMap((r, i): PlannedItem[] => (claimed.has(r.id) ? [] : [{ list: 'routes', kind: 'route', section: 'routes', key: r.id, path: ['plan', 'routes', i] }])),
    ...plan.workflows.flatMap((w, wi) =>
      w.actions.map((a, ai): PlannedItem => ({ list: 'workflows', kind: 'action', section: 'actions', key: actionKey(a), path: ['plan', 'workflows', wi, 'actions', ai] })),
    ),
    ...plan.jobs.map((j, i): PlannedItem => ({ list: 'jobs', kind: 'job', section: 'jobs', key: j.name, path: ['plan', 'jobs', i] })),
    ...plan.acceptanceTests.map((t, i): PlannedItem => ({ list: 'acceptanceTests', kind: 'acceptance test', section: 'tests', key: t.id, path: ['plan', 'acceptanceTests', i] })),
    ...plan.tasks.map((t, i): PlannedItem => ({ list: 'tasks', kind: 'task', section: 'tasks', key: t.id, path: ['plan', 'tasks', i] })),
  ];
}

/** Entities the built seed holds fewer rows of than `seed.rowsPerEntity` promises, other than `fed` ones. */
function seedRowIssues(plan: Plan, rows: Readonly<Record<string, number>>, fed: ReadonlySet<string>): readonly CheckIssue[] {
  return Object.entries(plan.seed.rowsPerEntity)
    .filter(([entity, planned]) => !fed.has(entity) && (rows[entity] ?? 0) < planned)
    .map(([entity, planned]) => {
      const built = rows[entity] ?? 0;
      return issue('plan.seed_rows_short', ['plan', 'seed', 'rowsPerEntity', entity], { entity, planned, built }, `${built} ${built === 1 ? 'row' : 'rows'}`);
    });
}

/** The rule text of a plan rule, and the actions or jobs it names as enforcing it. A plain text or schema rule names none. */
const ruleText = (r: PlanRule): string => (typeof r === 'string' ? r : r.rule);
const ruleBy = (r: PlanRule): readonly string[] => (isBehavioral(r) ? r.by : []);

/**
 * The state field of `entity` that declares the most of `states`, the first in field order on a tie,
 * or null when the entity has no state field. A planned workflow or state mix is judged against it.
 */
function machineFor(world: World, entity: string, states: readonly string[]): { readonly field: string; readonly states: readonly string[] } | null {
  let best: { field: string; states: readonly string[]; hits: number } | null = null;
  for (const [field, def] of Object.entries(world.entities[entity]?.fields ?? {})) {
    const machine = machineOf(def);
    if (!machine) continue;
    const hits = states.filter((s) => machine.states.includes(s)).length;
    if (best === null || hits > best.hits) best = { field, states: machine.states, hits };
  }
  return best;
}

/**
 * Planned workflow states missing from the entity's state machine, a workflow whose entity has no
 * state field at all, a workflow whose entity holds only a state field of another workflow (a
 * machine that declares none of its states) and that declares no lifecycle, and planned rules
 * whose `by` names no built action or job. A declared lifecycle (a derived flag, or deletion by
 * removal) exempts a workflow from both state-field checks. An entity the world lacks is left to
 * plan.not_covered, and a rule given as plain text or as a schema rule names nothing to check.
 */
export function workflowIssues(plan: Plan, world: World): readonly CheckIssue[] {
  return plan.workflows.flatMap((w, wi) => {
    const machine = Object.hasOwn(world.entities, w.entity) ? machineFor(world, w.entity, w.states) : null;
    const judged = machine !== null && w.states.some((s) => machine.states.includes(s));
    const unbuilt = machine === null && Object.hasOwn(world.entities, w.entity) && w.states.length > 0 && w.lifecycle === undefined
      ? [issue('plan.state_field_missing', ['entities', w.entity], { workflow: w.name, entity: w.entity, states: w.states }, `${w.entity} has no state field`)]
      : [];
    const unrepresented = machine !== null && !judged && w.states.length > 0 && w.lifecycle === undefined
      ? [issue('plan.lifecycle_unrepresented', ['plan', 'workflows', wi, 'lifecycle'], { workflow: w.name, entity: w.entity, states: w.states }, `no state field of ${w.entity} declares any state of this workflow`)]
      : [];
    const states = !judged ? [...unbuilt, ...unrepresented] : w.states.flatMap((state, si) => (machine.states.includes(state)
      ? []
      : [issue('plan.state_missing', ['plan', 'workflows', wi, 'states', si], { workflow: w.name, entity: w.entity, state }, `${w.entity}.${machine.field} declares ${machine.states.join(', ')}`)]));
    const rules = w.rules.flatMap((r, ri) => {
      const by = ruleBy(r);
      if (by.length === 0 || by.some((k) => Object.hasOwn(world.actions, actionKey(k)) || Object.hasOwn(world.jobs, k))) return [];
      return [issue('plan.rule_unanswered', ['plan', 'workflows', wi, 'rules', ri], { workflow: w.name, rule: ruleText(r), by }, `no ${by.map((k) => `actions.${actionKey(k)} or jobs.${k}`).join(', ')}`)];
    });
    return [...states, ...rules];
  });
}

/**
 * The workflows of a pressed `entity.state` that name the state, when every one of them declares a lifecycle: by
 * the plan's own word no state field holds it, so no seed row can be in it (A-369). Empty when a workflow without
 * a declared lifecycle names it, or when none does, which leaves the claim to the seed check.
 */
function lifecycleOnly(plan: Plan, pressed: string): Plan['workflows'] {
  const [entity = '', state = ''] = pressed.split('.');
  const naming = plan.workflows.filter((w) => w.entity === entity && w.states.includes(state));
  return naming.some((w) => w.lifecycle === undefined) ? [] : naming;
}

/** Whether a pressed `entity.state` is one the plan's own lifecycle keeps out of every state field (A-369). */
export const pressureUnreachable = (plan: Plan, pressed: string): boolean => lifecycleOnly(plan, pressed).length > 0;

/** plan.pressure_unreachable for each pressed state no seed can meet. Only the plan can drop it, so it is the plan's to fix (A-369). */
export function pressurePlanIssues(plan: Plan): readonly CheckIssue[] {
  return plan.tasks.flatMap((t, ti) => (t.pressure?.states ?? []).flatMap((pressed, si) => {
    const naming = lifecycleOnly(plan, pressed);
    if (naming.length === 0) return [];
    const [entity = '', state = ''] = pressed.split('.');
    return [issue('plan.pressure_unreachable', ['plan', 'tasks', ti, 'pressure', 'states', si], { task: t.id, entity, state, workflows: naming.map((w) => w.name) },
      `${pressed} is a state only of ${naming.map((w) => `${w.name} (lifecycle ${w.lifecycle?.representation})`).join(', ')}`)];
  }));
}

/**
 * Planned seed shares the built seed misses: entities with fewer rows than `rowsPerEntity`, and
 * states whose share of their entity's rows strays more than MIX_WITHIN points from `stateMix`.
 * An entity fed from an input fixture is skipped, because its rows come from the input and no seed
 * edit changes them, and so is an entity whose state field holds no rows: the row floor covers an
 * empty table.
 */
export function seedPlanIssues(plan: Plan, stats: Pick<WorldStats, 'rows' | 'states'>, world: World): readonly CheckIssue[] {
  const fed = fixtureFed(world);
  const mix = Object.entries(plan.seed.stateMix ?? {}).filter(([entity]) => !fed.has(entity)).flatMap(([entity, shares]) => {
    const machine = machineFor(world, entity, Object.keys(shares));
    const counts = machine === null ? {} : stats.states[`${entity}.${machine.field}`] ?? {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    return Object.entries(shares).flatMap(([state, planned]) => {
      const n = counts[state] ?? 0;
      if (Math.abs(n * 100 - planned * total) <= MIX_WITHIN * total) return [];
      const built = Math.round((n * 100) / total);
      return [issue('plan.seed_mix_off', ['plan', 'seed', 'stateMix', entity, state], { entity, state, planned, built, within: MIX_WITHIN }, `${n} of ${total} rows`)];
    });
  });
  return [...seedRowIssues(plan, stats.rows, fed), ...mix];
}

/** Missing keys point into the plan; mismatched method/path contracts point at the world item to repair. Param names do not count, as in `routeKey`. */
export function planCoverage(plan: Plan, world: World): readonly CheckIssue[] {
  const missing = plannedItems(plan)
    .filter((p) => !Object.hasOwn(world[p.section], p.key))
    .map((p) => issue('plan.not_covered', p.path, { item: `${p.kind} "${p.key}"` }, `no ${p.section}.${p.key}`));
  const claimed = actionRouteIds(plan);
  const mismatched = plan.routes.flatMap((r): CheckIssue[] => {
    const section = claimed.has(r.id) ? 'actions' : 'routes';
    const actual = Object.hasOwn(world[section], r.id) ? world[section][r.id] : undefined;
    if (actual === undefined || routeKey(actual.method, actual.path) === routeKey(r.method, r.path)) return [];
    const kind = section === 'actions' ? 'action' : 'route';
    return [issue('plan.not_covered', [section, r.id], {
      item: `${kind} "${r.id}" at ${r.method} ${r.path}`,
    }, `${actual.method} ${actual.path}`)];
  });
  const planned = new Set(plan.workflows.flatMap((w) => w.actions.map(actionKey)));
  const asActions = plan.jobs.flatMap((j, i): CheckIssue[] => (!planned.has(j.name) && Object.hasOwn(world.actions, j.name)
    ? [issue('plan.job_as_action', ['plan', 'jobs', i], { job: j.name }, `actions.${j.name}`)]
    : []));
  return [...missing, ...mismatched, ...asActions];
}

/**
 * plan.yaml text. Keys are written in schema order whatever order they arrive in, so the
 * same plan always renders the same text. Lines are never folded.
 */
export function renderPlanYaml(plan: Plan): string {
  const ordered = {
    revision: plan.revision,
    software: plan.software,
    summary: plan.summary,
    clock: { start: plan.clock.start, tick: plan.clock.tick },
    verdict: plan.verdict.kind === 'refuse'
      ? { kind: plan.verdict.kind, why: plan.verdict.why, ...(plan.verdict.feasibleIf === undefined ? {} : { feasibleIf: plan.verdict.feasibleIf }) }
      : { kind: plan.verdict.kind },
    entities: plan.entities.map((e) => ({ name: e.name, purpose: e.purpose, keyFields: e.keyFields })),
    workflows: plan.workflows.map((w) => ({
      name: w.name, entity: w.entity, states: w.states,
      rules: w.rules.map((r) => (typeof r === 'string' ? r : isBehavioral(r) ? { rule: r.rule, by: r.by, test: r.test } : { rule: r.rule, schema: r.schema })),
      ...(w.lifecycle === undefined ? {} : { lifecycle: { representation: w.lifecycle.representation, reason: w.lifecycle.reason } }),
      actions: w.actions,
    })),
    jobs: plan.jobs.map((j) => ({ name: j.name, every: j.every, rule: j.rule })),
    acceptanceTests: plan.acceptanceTests.map((t) => ({ id: t.id, intent: t.intent, actions: t.actions, description: t.description, script: t.script })),
    routes: plan.routes.map((r) => ({ id: r.id, method: r.method, path: r.path, purpose: r.purpose })),
    seed: { rowsPerEntity: plan.seed.rowsPerEntity, mix: plan.seed.mix, ...(plan.seed.stateMix === undefined ? {} : { stateMix: plan.seed.stateMix }) },
    tasks: plan.tasks.map((t) => ({
      id: t.id, difficulty: t.difficulty, ...(t.kind === undefined ? {} : { kind: t.kind }), intent: t.intent,
      ...(t.actions === undefined ? {} : { actions: t.actions }), decoyIdea: t.decoyIdea, ...(t.pressure === undefined ? {} : { pressure: t.pressure }),
    })),
    ...(plan.open_questions === undefined
      ? {}
      : { open_questions: plan.open_questions.map((q) => ({ question: q.question, default_answer: q.default_answer })) }),
    assumptions: plan.assumptions.map((a) => ({ decision: a.decision, why: a.why })),
    outOfScope: plan.outOfScope.map((o) => ({ what: o.what, why: o.why })),
    changes: plan.changes,
  };
  return stringify(ordered, { lineWidth: 0, indentSeq: true, singleQuote: true });
}

/** plan.yaml text back to a Plan, or null when it is not YAML or does not fit planSchema. The inverse of renderPlanYaml. */
export function parsePlanYaml(text: string): Plan | null {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return null;
  }
  const parsed = planSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
