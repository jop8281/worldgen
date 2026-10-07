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
import { SECTIONS, renderWorldYaml, type Section, type World } from '#engine';
import { changeItem, planSchema, plannedItems, renderPlanYaml, untestedActions, type Plan } from './plan.ts';
import { stagesToRun } from './stages.ts';

/** The plan step's instructions on iterate. The plan is the whole updated plan, not a delta. */
export const ITERATE_PLAN_BRIEF =
  'An existing world must change to meet a change request. Write the whole updated plan that every later stage follows, saved as plan.yaml: ' +
  'keep every existing entity, route, workflow, job and task the request does not change, and add what the request needs. ' +
  'Write every workflow rule in the whole updated plan in the form of what enforces it: a rule enforced by actions or jobs as { rule, by, test }, by naming the enforcing action or job keys and test naming the id of the acceptance test that exercises the rule through that enforcement, each acceptance test bound by at most one rule and, when by names actions, its bound test exercising one of them; a rule only the data model enforces as { rule, schema } with the reason the schema enforces it; keep plain text only for context neither enforces. ' +
  'Declare lifecycle: { representation: descriptive or removal, reason } on a workflow whose states no state field holds, such as a derived flag or deletion by removal, because a state-named workflow with no machine and no declaration is rejected. ' +
  'Preserve the existing world clock exactly; iterate cannot change world metadata. ' +
  'Fill `changes` with every EXISTING item the request alters or removes, as dotted paths rooted at the section or at the item key, such as ticket.fields.status or tasks.resolve_ticket; ' +
  'name a removed state or enum value by its value. Leave out anything the request does not touch: the judge rejects each destructive change to an item that `changes` does not name. ' +
  'Name a new item by the exact key it will have in the world. ' +
  'Keep each existing task\'s pressure as the existing plan has it, and none where it has none. Add or change a pressure claim only when the request asks for harder tasks, and then name seed.<entity> in `changes` for each entity the claim presses, so the seed step reruns and can seed what it needs. ' +
  'Set revision one above the existing plan\'s, and raise it again whenever the plan step runs again. ' +
  'List an acceptance test in acceptanceTests for every new workflow action; it is written into the world\'s tests exactly as given, and no later stage can edit tests. ' +
  'Each new or rewritten acceptance test must create every prerequisite row through ctx.api and check the public behavior with ctx.assert, without relying on rows the later seed stage will create, because workflow runs these tests before seed. ' +
  'An existing test stays and reruns against the changed world: to rewrite it, list it under its existing id and name tests.<id> in `changes`; to drop it, name tests.<id> in `changes` and leave it out of acceptanceTests. ' +
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
