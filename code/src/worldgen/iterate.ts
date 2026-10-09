/**
 * What iterate mode asks and which stages it reruns. Pure: no model, no file IO. run.ts holds the
 * loop; this file holds the iterate-only knowledge so create mode never reads it.
 *
 * Invariants:
 * - The sections a request changes are computed from the plan and the old world, never asked
 *   of a model: an item the plan promises that the world lacks is new, and an entry of
 *   `plan.changes` marks an existing item as changed.
 * - Which stages run is `stagesToRun` (stages.ts, A-33). This file only supplies its input.
 */
import { z } from 'zod';
import { SECTIONS, renderWorldYaml, type Section, type World } from '#engine';
import { changeItem, jobActionIssues, planSchema, plannedItems, renderPlanYaml, untestedActions, type Plan } from './plan.ts';
import { stagesToRun } from './stages.ts';

/**
 * The plan step's instructions on iterate. With an existing plan the answer is a patch on it (A-345). It holds only
 * the keys that change, so an unchanged item, a frozen test above all, is never restated. Without a plan the answer is
 * the whole plan.
 */
export const ITERATE_PLAN_BRIEF =
  'An existing world must change to meet a change request. The plan that every later stage follows is saved as plan.yaml. ' +
  'When the existing plan is shown, answer with a patch on it, not with the whole plan. Give revision, changes and only the keys that change. ' +
  'An entity, route, workflow, job, task or acceptance test you give, matched by its name or id, replaces the existing one with that key or is added, so give each such item whole. ' +
  'Every item you leave out stays exactly as it is, acceptance tests included. To change an existing item, name it in changes and give it whole. To drop one, list it in remove as <list>.<key>, such as tasks.<id>, routes.<id> or tests.<id>. ' +
  'Assumptions, outOfScope and open_questions you give are added to the existing ones; software, summary, seed and verdict you give replace them. ' +
  'When no plan exists, write the whole plan for the world as it is plus what the request needs. ' +
  'Write every workflow rule you give in the form of what enforces it: a rule enforced by actions or jobs as { rule, by, test }, by naming the enforcing action or job keys and test naming the id of the acceptance test that exercises the rule through that enforcement, each acceptance test bound by at most one rule and, when by names actions, its bound test exercising one of them; a rule only the data model enforces as { rule, schema } with the reason the schema enforces it; keep plain text only for context neither enforces. ' +
  'Declare lifecycle: { representation: descriptive or removal, reason } on a workflow whose states no state field holds, such as a derived flag or deletion by removal, because a state-named workflow with no machine and no declaration is rejected. ' +
  'Preserve the existing world clock exactly; iterate cannot change world metadata. ' +
  'Fill `changes` with every EXISTING item the request alters or removes, as dotted paths rooted at the section or at the item key, such as ticket.fields.status or tasks.resolve_ticket; ' +
  'name a removed state or enum value by its value. Leave out anything the request does not touch: the judge rejects each destructive change to an item that `changes` does not name. ' +
  'Name a new item by the exact key it will have in the world. ' +
  'Keep each existing task\'s pressure as the existing plan has it, and none where it has none. Add or change a pressure claim only when the request asks for harder tasks, and then name seed.<entity> in `changes` for each entity the claim presses, so the seed step reruns and can seed what it needs. ' +
  'Set revision one above the existing plan\'s, and raise it again whenever the plan step runs again. ' +
  'List an acceptance test in acceptanceTests for every new workflow action; it is written into the world\'s tests exactly as given, and no later stage can edit tests. ' +
  'Each new or rewritten acceptance test must create every prerequisite row through ctx.api and check the public behavior with ctx.assert, without relying on rows the later seed stage will create, because workflow runs these tests before seed. ' +
  'An existing test stays and reruns against the changed world: to rewrite it, give it under its existing id and name tests.<id> in `changes`; to drop it, name tests.<id> in `changes` and leave it out. ' +
  'Before planning, list each question you would ask a human about the request in open_questions, each with a question and a default_answer, and record every default as an entry in assumptions with the decision and why. Never guess silently. Put what you leave out in outOfScope with why. Refuse with a reason if the request asks for something harmful.';

/** The stage prompt's block for an iterate run: the request and the rules of a minimal edit. */
export function iterateStageBlock(request: string): readonly string[] {
  return [
    '## Change request',
    '',
    request,
    '',
    'The world above exists and passes the engine. Propose the smallest WorldEdit for this stage: `upsert` or `patch` only what the request needs, and never restate an item it does not change.',
    'Do not drop a field, state, transition, enum value, test, decoy or seeded row that the plan\'s `changes` does not name. The judge rejects every unplanned removal, and reruns the old tests and decoys against your result.',
    'If this stage has nothing to change, answer with an edit that has only a note.',
  ];
}

/** The plan step's prompt on iterate: the request, then the old plan, or the world itself when no plan exists, then any rejection. */
export function iteratePlanBlocks(request: string, oldPlan: Plan | null, world: World): readonly string[] {
  const existing = oldPlan === null
    ? [
        '## Existing world',
        '',
        'This world has no usable plan.yaml. Write the plan for the world as it is, then add what the request changes.',
        '',
        '```yaml',
        renderWorldYaml(world).trimEnd(),
        '```',
      ]
    : ['## Existing plan', '', '```yaml', renderPlanYaml(oldPlan).trimEnd(), '```'];
  return ['## Change request', '', request, '', '## Existing world clock', '', JSON.stringify(world.meta.clock), '', ...existing];
}

/** The keyed plan lists, each with the field that keys its items. A patch item replaces the existing item with its key, or is added. */
const KEYED = { entities: 'name', routes: 'id', workflows: 'name', jobs: 'name', acceptanceTests: 'id', tasks: 'id' } as const;
type KeyedList = keyof typeof KEYED;
/** How `remove` names an existing item of a keyed list: `<prefix>.<key>`. An acceptance test is a world test. */
const REMOVAL_PREFIX: Record<KeyedList, string> = { entities: 'entities', routes: 'routes', workflows: 'workflows', jobs: 'jobs', acceptanceTests: 'tests', tasks: 'tasks' };
/** The unkeyed plan lists: a patch adds the entries the existing plan lacks. */
const APPENDED = ['assumptions', 'outOfScope', 'open_questions'] as const;

const shape = planSchema.shape;
/**
 * The plan step's answer on iterate when a plan exists (A-345). Revision is required and every other key is optional.
 * A whole plan is also a valid patch. An unknown key is refused, never dropped, and so is a keyed item given twice.
 */
export const planPatchSchema = z.strictObject({
  revision: z.number().int().positive().describe('one above the existing plan\'s revision, raised again whenever the plan step runs again'),
  changes: shape.changes,
  software: shape.software.optional(),
  summary: shape.summary.optional(),
  clock: shape.clock.optional(),
  verdict: shape.verdict.optional(),
  seed: shape.seed.optional(),
  entities: shape.entities.optional(),
  routes: shape.routes.optional(),
  workflows: shape.workflows.optional(),
  jobs: shape.jobs.removeDefault().optional(),
  acceptanceTests: shape.acceptanceTests.removeDefault().optional().describe('acceptance tests fixed by the approved plan before implementation repair begins'),
  tasks: shape.tasks.optional(),
  assumptions: shape.assumptions.optional(),
  outOfScope: shape.outOfScope.optional(),
  open_questions: shape.open_questions,
  remove: z.array(z.string()).optional().describe('existing items to drop, each as <list>.<key>, such as tasks.resolve_ticket or tests.<id>; each is also recorded in changes'),
}).superRefine((patch, ctx) => {
  for (const [list, key] of Object.entries(KEYED) as [KeyedList, string][]) {
    const keys = ((patch[list] ?? []) as readonly Record<string, unknown>[]).map((item) => item[key]);
    const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
    if (twice.length > 0) ctx.addIssue({ code: 'custom', path: [list], message: `${list} gives ${[...new Set(twice)].join(', ')} more than once: give each item once` });
  }
});
export type PlanPatch = z.output<typeof planPatchSchema>;

/**
 * `base` with `patch` applied. A keyed item the patch gives replaces the existing item with its key, or is added.
 * An existing item that `remove` lists as `<prefix>.<key>` is dropped. So is an acceptance test that `changes` names as
 * `tests.<id>` and the patch leaves out, because a test cannot change without its new text. Every other item, and every
 * key the patch leaves out, carries over as it is. `remove` entries join `changes`, so the stages and the preservation
 * gate see the drop as planned. The result is judged against the full plan rules.
 */
export function applyPlanPatch(base: Plan, patch: PlanPatch): Plan {
  const removed = new Set(patch.remove ?? []);
  const named = new Set(patch.changes.map(changeItem));
  const drops = (list: KeyedList, key: string): boolean =>
    removed.has(`${REMOVAL_PREFIX[list]}.${key}`) || (list === 'acceptanceTests' && named.has(`tests.${key}`));
  const merged = <L extends KeyedList>(list: L): Plan[L] => {
    const key = KEYED[list];
    const old = base[list] as readonly Record<string, unknown>[];
    const given = (patch[list] ?? []) as readonly Record<string, unknown>[];
    const byKey = new Map(given.map((item) => [item[key], item]));
    const kept = old.flatMap((item) => (byKey.has(item[key]) ? [byKey.get(item[key])!] : drops(list, String(item[key])) ? [] : [item]));
    const added = given.filter((item) => !old.some((o) => o[key] === item[key]));
    return [...kept, ...added] as unknown as Plan[L];
  };
  const appended = <L extends (typeof APPENDED)[number]>(list: L): Plan[L] => {
    const old = (base[list] ?? []) as readonly unknown[];
    const seen = new Set(old.map((e) => JSON.stringify(e)));
    const added = ((patch[list] ?? []) as readonly unknown[]).filter((e) => !seen.has(JSON.stringify(e)));
    return [...old, ...added] as Plan[L];
  };
  return {
    ...base,
    revision: patch.revision,
    changes: [...patch.changes, ...[...removed].filter((r) => !named.has(r))],
    software: patch.software ?? base.software,
    summary: patch.summary ?? base.summary,
    clock: patch.clock ?? base.clock,
    verdict: patch.verdict ?? base.verdict,
    seed: patch.seed ?? base.seed,
    entities: merged('entities'),
    routes: merged('routes'),
    workflows: merged('workflows'),
    jobs: merged('jobs'),
    acceptanceTests: merged('acceptanceTests'),
    tasks: merged('tasks'),
    assumptions: appended('assumptions'),
    outOfScope: appended('outOfScope'),
    ...(base.open_questions === undefined && patch.open_questions === undefined ? {} : { open_questions: appended('open_questions') }),
  };
}

/**
 * `plan` with each acceptance test the world already holds taken from world.tests. The world's tests are
 * engine-checked, and a test fixed after generation can leave plan.yaml stale, so the world decides what an
 * unchanged test is (A-345). A patch that leaves a test out then carries the world's version, never the stale copy.
 */
export function planWithWorldTests(plan: Plan, world: World): Plan {
  return {
    ...plan,
    acceptanceTests: plan.acceptanceTests.map((t) => {
      const w = Object.hasOwn(world.tests, t.id) ? world.tests[t.id] : undefined;
      return w === undefined ? t : { ...t, description: w.description, script: w.script };
    }),
  };
}

/**
 * The sections a plan changes in `world`. A planned item the world lacks is new, so its section
 * changes; each `plan.changes` entry changes the section it names, or every section that holds an
 * item with the entry's first step as its key (`ticket.fields.status` reaches entities and seed).
 */
/**
 * Whether `next` revises the plan without asking for a world change: an old plan exists and the two
 * differ in something besides `revision` and `changes`, such as a declared lifecycle or an assumption
 * (A-294). Such a run probes every stage against the unchanged world instead of being refused.
 */
export function revisesPlanOnly(old: Plan | null, next: Plan): boolean {
  if (old === null) return false;
  const body = (p: Plan): string => renderPlanYaml({ ...p, revision: 0, changes: [] });
  return body(old) !== body(next);
}

export function changedSections(plan: Plan, world: World): ReadonlySet<Section> {
  const out = new Set<Section>();
  for (const item of plannedItems(plan)) {
    if (!Object.hasOwn(world[item.section], item.key)) out.add(item.section);
  }
  for (const entry of plan.changes) {
    const root = changeItem(entry).split('.')[0] ?? '';
    if (root === '') continue;
    const named = SECTIONS.find((s) => s === root);
    if (named !== undefined) out.add(named);
    else for (const s of SECTIONS) if (Object.hasOwn(world[s], root)) out.add(s);
  }
  return out;
}

type Pressure = NonNullable<Plan['tasks'][number]['pressure']>;

/** The claims of `next` that `prev` lacks, each with the entity whose seed must hold it. */
function addedPressure(next: Pressure | undefined, prev: Pressure | undefined): readonly { readonly claim: string; readonly entity: string }[] {
  if (next === undefined) return [];
  return [
    ...(next.paging !== undefined && next.paging !== prev?.paging ? [{ claim: `paging: ${next.paging}`, entity: next.paging }] : []),
    ...(next.states ?? []).filter((s) => !(prev?.states ?? []).includes(s)).map((s) => ({ claim: `states: ${s}`, entity: s.split('.')[0] ?? '' })),
    ...(next.distractors !== undefined && next.distractors !== prev?.distractors ? [{ claim: `distractors: ${next.distractors}`, entity: next.distractors }] : []),
  ];
}

/**
 * planSchema plus what an iterate plan owes the world it changes: the world's clock unchanged, an
 * acceptance test for every action the world lacks, and an existing test rewritten only when
 * plan.changes names it as `tests.<id>`. A test the plan copies unchanged needs no name. A pressure
 * claim `oldPlan` lacks (every claim, when there is no old plan) needs the seed step to rerun, so the
 * seed the old world was built with is never held to a claim no stage will seed for (A-285).
 */
export function iteratePlanSchema(world: World, oldPlan: Plan | null): typeof planSchema {
  return planSchema.superRefine((plan, ctx) => {
    if (plan.clock.start !== world.meta.clock.start || plan.clock.tick !== world.meta.clock.tick) {
      ctx.addIssue({ code: 'custom', path: ['clock'], message: `iterate must preserve the existing world clock: ${JSON.stringify(world.meta.clock)}` });
    }
    if (plan.verdict.kind !== 'proceed') return;
    jobActionIssues(plan, ctx);
    for (const action of untestedActions(plan).filter((a) => !Object.hasOwn(world.actions, a))) {
      ctx.addIssue({ code: 'custom', path: ['acceptanceTests'], message: `acceptance tests must cover new workflow action ${action}` });
    }
    const named = new Set(plan.changes.map(changeItem));
    plan.acceptanceTests.forEach((t, i) => {
      const old = Object.hasOwn(world.tests, t.id) ? world.tests[t.id] : undefined;
      if (old === undefined || (old.description === t.description && old.script === t.script) || named.has(`tests.${t.id}`)) return;
      ctx.addIssue({ code: 'custom', path: ['acceptanceTests', i], message: `acceptance test ${t.id} rewrites the existing tests.${t.id}: copy it unchanged, or name tests.${t.id} in changes` });
    });
    if (stagesToRun(changedSections(plan, world)).includes('seed')) return;
    const before = new Map((oldPlan?.tasks ?? []).map((t) => [t.id, t.pressure]));
    plan.tasks.forEach((t, i) => {
      const added = addedPressure(t.pressure, before.get(t.id));
      if (added.length === 0) return;
      const seeds = [...new Set(added.map((a) => `seed.${a.entity}`))].join(', ');
      ctx.addIssue({
        code: 'custom', path: ['tasks', i, 'pressure'],
        message: `task ${t.id} adds pressure the existing plan does not have (${added.map((a) => a.claim).join('; ')}), but no planned change reaches the seed, so no step would seed for it: keep the task's existing pressure, or, if the request asks for harder tasks, name ${seeds} in changes`,
      });
    });
  });
}
