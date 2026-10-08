/**
 * WorldGen's acceptance rules. Every verdict here is computed from engine output and the
 * plan. This file takes no Model and may not import llm.ts (architecture test). The iterate
 * gate reruns old scripts only through checkWorld and createRuntime.
 */
import {
  CHECK_LAYERS, DESTRUCTIVE, ISSUES, checkWorld, createRuntime, diffWorlds, issue, routeKey,
  type CheckIssue, type CheckLayer, type CheckReport, type CheckedWorld, type Difficulty, type World,
  type WorldChange, type WorldDelta, type WorldEdit,
} from '#engine';
import { inputCoverage } from './input-coverage.ts';
import type { InputDigest } from './input.ts';
import { actionRouteIds, changeItem, changeReason, planCoverage, seedPlanIssues, workflowIssues, type Plan } from './plan.ts';
import { SECTION_OWNER, STAGES, STAGE_IDS, isTestRun, seedBlocking, seedNeedIssues, type StageId } from './stages.ts';

/** How many times a check may run when the engine's snippet host fails to start. */
export const INFRA_CHECK_TRIES = 2;

/** The issues that say the engine could not judge, not that the world is wrong. */
export function infraIssues(report: CheckReport): readonly CheckIssue[] {
  return report.ok ? [] : report.issues.filter((i) => i.code === 'snippet.host_unavailable');
}

/** Runs `check`, and runs it again while the snippet host is unavailable, up to `tries` runs. No model is involved. */
export function checkJudgeable(check: () => CheckReport, tries: number = INFRA_CHECK_TRIES): CheckReport {
  let report = check();
  for (let n = 1; n < tries && infraIssues(report).length > 0; n += 1) report = check();
  return report;
}

export { inputCoverage } from './input-coverage.ts';

/** Position of the stage that must fix `i`. Owners no stage holds (meta, format, input, fixtures) come first, and the plan before them. */
function ownerRank(i: CheckIssue): number {
  if (isTestRun(i)) return STAGE_IDS.indexOf('workflow');
  const owner = ISSUES[i.code].owner;
  const key = owner === 'at_path' ? i.path[0] : owner;
  if (!Object.hasOwn(SECTION_OWNER, key)) return 0;
  const stage = SECTION_OWNER[key as keyof typeof SECTION_OWNER];
  return stage === 'input' ? 0 : stage === 'plan' ? -1 : STAGE_IDS.indexOf(stage);
}

/** The plan list a coverage issue is about (path[1]) and the stage that builds it. */
const PLAN_LIST_STAGE: Readonly<Record<string, StageId | 'plan'>> = {
  entities: 'model',
  routes: 'model',
  workflows: 'workflow',
  jobs: 'workflow',
  acceptanceTests: 'plan',
  tasks: 'tasks',
};

const issueKey = (i: CheckIssue) => `${i.code}@${JSON.stringify(i.path)}`;

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];

/**
 * The `STAGES[stage].done` rules that can run on a failed report, which carries warnings but
 * no checked world and no full stats. Seed's and workflow's rules read the report warnings (the
 * engine adds `action.unexercised` when the tasks layer failed only for too few tasks, A-136),
 * seed's plan rules and seed needs read the seed counts a report past the seed layer carries, so a
 * create's seed step, whose world has no task yet and so never checks ok, still blocks on what the
 * planned tasks need (A-271, A-369). The task count and spread rules read `candidate`. Mirrors
 * stages.ts (seed and workflow `done`, `tasksDone`); keep the two in step until `Stage.done` accepts
 * an unchecked world.
 */
function failedDone(stage: StageId, report: Extract<CheckReport, { ok: false }>, candidate: World | undefined, plan: Plan): readonly CheckIssue[] {
  if (stage === 'seed') {
    const planned = report.stats === undefined || candidate === undefined
      ? []
      : [...seedPlanIssues(plan, report.stats, candidate), ...seedNeedIssues(plan, candidate, report.stats)];
    return [...seedBlocking(report.warnings, plan), ...planned];
  }
  if (stage === 'workflow') return report.warnings.filter((w) => w.code === 'action.unexercised');
  if (stage !== 'tasks' || candidate === undefined) return [];
  const tasks = Object.values(candidate.tasks);
  const have = DIFFICULTIES.filter((d) => tasks.some((t) => t.difficulty === d));
  const out: CheckIssue[] = [];
  if (tasks.length < 3) {
    out.push(issue('world.too_few_tasks', ['tasks'], { have: tasks.length }, `${tasks.length} tasks`));
  }
  if (have.length < DIFFICULTIES.length) {
    out.push(issue('tasks.difficulty_not_spread', ['tasks'], { have }, have.join(', ') || 'none'));
  }
  return out;
}

/**
 * The judge's verdict on one stage attempt.
 * - `blocking`: what this stage must fix before it is accepted.
 * - `deferred`: engine errors owned by a later stage. This stage cannot fix them, but the
 *   world is not acceptable while any remain, so run.ts must clear them before it saves.
 * - `accepted`: the checked world, only when the engine report is ok and nothing blocks. It is
 *   null on every failed report, so a world the engine rejects is never accepted or saved.
 */
export type Judgement = {
  readonly blocking: readonly CheckIssue[];
  readonly deferred: readonly CheckIssue[];
  readonly accepted: CheckedWorld | null;
};

/**
 * Judges `stage` against the engine report and the plan. Blocking issues are engine errors in
 * sections owned by this stage or an earlier one, plan coverage gaps, the stage's `done`
 * issues, and warnings the stage treats as errors. Engine errors in later sections are
 * deferred, never dropped.
 *
 * A failed report carries no world, so on a failed report `candidate` (the world the engine
 * checked) supplies plan coverage and the task count and spread rules, and the seed and workflow
 * warning rules read the failed report's warnings.
 */
export function blockingIssues(stage: StageId, report: CheckReport, plan: Plan, candidate?: World, digest?: InputDigest): Judgement {
  const rank = STAGE_IDS.indexOf(stage);
  const out = new Map<string, CheckIssue>();
  const add = (i: CheckIssue) => {
    if (!out.has(issueKey(i))) out.set(issueKey(i), i);
  };
  const addCoverage = (world: World) => {
    for (const i of planCoverage(plan, world)) {
      if (i.path[0] !== 'plan') {
        if (ownerRank(i) <= rank) add(i);
      } else {
        const owner = PLAN_LIST_STAGE[String(i.path[1])];
        if (owner !== undefined && (owner === 'plan' || STAGE_IDS.indexOf(owner) <= rank)) add(i);
      }
    }
    for (const i of workflowIssues(plan, world)) if (ownerRank(i) <= rank) add(i);
    if (digest === undefined) return;
    const claimed = actionRouteIds(plan);
    const actionContracts = new Set(plan.routes.filter((r) => claimed.has(r.id)).map((r) => routeKey(r.method, r.path)));
    for (const i of inputCoverage(digest, world, report)) {
      const contract = digest.operations.find((o) => `${o.method} ${o.path}` === i.path[1]);
      const action = i.path[0] === 'routes' && contract !== undefined && actionContracts.has(routeKey(contract.method, contract.path));
      const owned: CheckIssue = action ? { ...i, path: ['actions', ...i.path.slice(1)] } : i;
      if (ownerRank(owned) <= rank) add(owned);
    }
  };
  if (!report.ok) {
    const deferred: CheckIssue[] = [];
    for (const i of report.issues) {
      if (i.severity !== 'error') continue;
      if (ownerRank(i) <= rank) add(i);
      else deferred.push(i);
    }
    if (candidate !== undefined) addCoverage(candidate);
    failedDone(stage, report, candidate, plan).forEach(add);
    return { blocking: [...out.values()], deferred, accepted: null };
  }
  addCoverage(report.world);
  STAGES[stage].done(report, plan).forEach(add);
  const blocking = [...out.values()];
  return { blocking, deferred: [], accepted: blocking.length === 0 ? report.world : null };
}

// ---------------------------------------------------------------- iterate gate

type Steps = readonly string[];
/** Whether an old test or decoy is exempt from rerun: its item is in edit.remove or plan.changes names `steps`. */
type Exempt = (section: 'tests' | 'tasks', key: string, steps: Steps) => boolean;

/** Longest value excerpt kept in `found`. */
const FOUND_MAX = 160;
const show = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > FOUND_MAX ? `${s.slice(0, FOUND_MAX - 1)}…` : s;
};

/** plan.changes as dotted steps. Blank entries name nothing. */
const plannedNames = (plan: Plan): readonly Steps[] =>
  plan.changes.map(changeItem).filter((c) => c !== '').map((c) => c.split('.'));

const startsWith = (steps: Steps, prefix: Steps): boolean =>
  prefix.length <= steps.length && prefix.every((p, i) => p === steps[i]);

/**
 * Whether plan.changes names `steps` ([section, key, ...]) or anything above it. An entry is a
 * dotted path rooted at the section (`entities.ticket.fields.status`) or at the item key
 * (`ticket.fields.status`). A bare section is not enough: it would cover every item in it.
 */
const named = (names: readonly Steps[], steps: Steps): boolean =>
  names.some((n) => (n.length >= 2 && startsWith(steps, n)) || startsWith(steps.slice(1), n));

/** A change as dotted steps. A removed state or enum value is named by its value, not its index. */
function changeSteps(c: WorldChange): Steps {
  const steps = c.path.map(String);
  if ((c.kind === 'state_removed' || c.kind === 'enum_value_removed') && typeof c.before === 'string') steps[steps.length - 1] = c.before;
  return steps;
}

const targets = (v: unknown): readonly string[] => (Array.isArray(v) ? v.map(String) : []);

/** A removed transition is planned when plan.changes names its from-state, or the state of every target it lost. */
function edgesPlanned(names: readonly Steps[], c: WorldChange, steps: Steps): boolean {
  if (c.kind !== 'transition_changed' || steps[steps.length - 2] !== 'transitions') return false;
  const field = steps.slice(0, -2);
  const state = (s: string) => named(names, [...field, 'states', s]);
  const from = steps[steps.length - 1];
  const after = targets(c.after);
  const lost = targets(c.before).filter((t) => !after.includes(t));
  return (from !== undefined && state(from)) || (lost.length > 0 && lost.every(state));
}

const removedByEdit = (edits: readonly WorldEdit[], section: 'meta' | keyof WorldEdit['remove'], key: string): boolean =>
  section !== 'meta' && edits.some((e) => (e.remove[section] ?? []).includes(key));

/**
 * One `iterate.unplanned_change` per destructive change in `delta`, in delta order, unless an
 * edit's `remove` names its item or plan.changes names it (see `named`). The issue sits at the
 * change's path in the old world and gives the dotted name to add to plan.changes.
 */
export function unplannedChanges(delta: WorldDelta, edits: readonly WorldEdit[], plan: Plan): readonly CheckIssue[] {
  const names = plannedNames(plan);
  const out: CheckIssue[] = [];
  for (const c of delta.changes) {
    if (!DESTRUCTIVE.has(c.kind) || removedByEdit(edits, c.section, c.key)) continue;
    const steps = changeSteps(c);
    if (named(names, steps) || edgesPlanned(names, c, steps)) continue;
    const dotted = steps.join('.');
    const found = c.after === undefined
      ? `${dotted} removed`
      : c.before === undefined ? `${dotted} added as ${show(c.after)}` : `${show(c.before)} became ${show(c.after)}`;
    out.push(issue('iterate.unplanned_change', c.path, { change: `${c.kind} at ${dotted}` }, found));
  }
  return out;
}

/** A clause that forbids rather than asks: its words never justify a change (A-289). */
const NEGATION = /\b(do not|don't|dont|never|nothing else|no other|without|must not|should not)\b/i;
/** Path steps that say where in an item a change sits, not what it is about. */
const STRUCTURE = new Set(['fields', 'states', 'transitions', 'input', 'values', 'filters', 'search', 'sort', 'rules', 'decoys', 'alternatives']);

const words = (s: string): string[] => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
/** A crude stem, so `refunds`, `refunded` and `refund` meet. */
const stem = (w: string): string => (w.length <= 3 ? w : w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, ''));
const norm = (s: string): string => words(s).join(' ');

/** The request's clauses that ask for something: split at sentence and clause marks, negated ones dropped. */
function askedClauses(request: string): string[] {
  return request.split(/[.;:!?\n]+/).map((c) => c.trim()).filter((c) => c !== '' && !NEGATION.test(c));
}

/**
 * One `iterate.out_of_scope` per changed item an iterate's request does not ask for (A-289). An item
 * traces to the request when a word of its name (the section aside, structural steps aside) shares a
 * stem with a word of a clause that asks rather than forbids, or when a plan.changes entry names it
 * with a reason quoted from such a clause, of two words or more. Destructive changes still need their
 * own plan.changes name (`unplannedChanges`).
 */
export function requestScopeIssues(delta: WorldDelta, plan: Plan, request: string): readonly CheckIssue[] {
  const clauses = askedClauses(request);
  const asked = new Set(clauses.flatMap(words).map(stem));
  const quotes = clauses.map(norm);
  const reasoned = plan.changes
    .filter((e) => { const r = changeReason(e); return r !== null && words(r).length >= 2 && quotes.some((q) => q.includes(norm(r))); })
    .map((e) => changeItem(e).split('.'));
  const names = plannedNames(plan);
  const seen = new Set<string>();
  const out: CheckIssue[] = [];
  for (const c of delta.changes) {
    const steps = changeSteps(c);
    // An unnamed destructive change is already iterate.unplanned_change; report it once.
    if (DESTRUCTIVE.has(c.kind) && !named(names, steps)) continue;
    const item = steps.join('.');
    const own = steps.slice(1).filter((s) => !STRUCTURE.has(s)).flatMap(words).filter((w) => w.length >= 3).map(stem);
    if (own.some((w) => asked.has(w)) || named(reasoned, steps)) continue;
    const key = steps.slice(0, 2).join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue('iterate.out_of_scope', c.path, { item, request }, `${c.kind} at ${item}`));
  }
  return out;
}

const layerAt = (layer: CheckLayer): number => CHECK_LAYERS.indexOf(layer);
type Failed = Extract<CheckReport, { ok: false }>;

/** The rerun world failed before reaching `layer`, so nothing about the old scripts is known. Blocks rather than passes. */
function inconclusive(section: 'tests' | 'tasks', what: string, report: Failed): CheckIssue {
  const [first] = report.issues;
  return issue('iterate.regression', [section], {
    what: `Could not rerun the old ${what} on the new world: it stopped at the ${report.reached} layer (${first.code} at ${first.path.join('.')}).`,
  }, first.found);
}

/**
 * Old tests whose script the new world lacks or changed rerun on the new world: the new world
 * with only those tests and no tasks goes through checkWorld. A test the new world kept
 * unchanged already passed its own check.
 */
function testRegressions(before: CheckedWorld, after: CheckedWorld, exempt: Exempt): readonly CheckIssue[] {
  const rerun = Object.entries(before.tests).filter(([name, t]) =>
    !exempt('tests', name, ['tests', name, 'script']) && (Object.hasOwn(after.tests, name) ? after.tests[name]?.script : undefined) !== t.script);
  if (rerun.length === 0) return [];
  const report = checkJudgeable(() => checkWorld({ ...after, tests: Object.fromEntries(rerun), tasks: {} }));
  if (report.ok || layerAt(report.reached) > layerAt('tests')) return [];
  if (report.reached !== 'tests') return [inconclusive('tests', 'tests', report)];
  return rerun.flatMap(([name, t]) => {
    const hit = report.issues.find((i) => i.path[0] === 'tests' && i.path[1] === name);
    if (hit === undefined) return [];
    return [issue('iterate.regression', ['tests', name], {
      what: `Old test ${name} (${t.description}) fails against the new world. Keep the behavior it checks, or name tests.${name} in plan.changes.`,
    }, hit.found)];
  });
}

/**
 * Every old decoy of a task the new world kept is scored by the new world's grader: each becomes
 * the solution of an easy, decoy-free copy of its task, and the copies go through checkWorld
 * together. A copy with no solution or grader issue scored 1.
 */
function decoyRegressions(before: CheckedWorld, after: CheckedWorld, exempt: Exempt): readonly CheckIssue[] {
  const runs: { key: string; task: string; index: number; why: string }[] = [];
  const tasks: Record<string, unknown> = {};
  for (const [id, old] of Object.entries(before.tasks)) {
    const now = Object.hasOwn(after.tasks, id) ? after.tasks[id] : undefined;
    if (now === undefined) continue;
    old.decoys.forEach((d, index) => {
      if (exempt('tasks', id, ['tasks', id, 'decoys', String(index)])) return;
      const key = `decoy_${runs.length}`;
      runs.push({ key, task: id, index, why: d.why });
      tasks[key] = { ...now, difficulty: 'easy', solution: d.script, decoys: [] };
    });
  }
  if (runs.length === 0) return [];
  const report = checkJudgeable(() => checkWorld({ ...after, tests: {}, tasks }));
  if (!report.ok && layerAt(report.reached) < layerAt('tasks')) return [inconclusive('tasks', 'decoys', report)];
  const issues = !report.ok && report.reached === 'tasks' ? report.issues : [];
  const scoredOne = (key: string) => !issues.some((i) =>
    i.path[0] === 'tasks' && i.path[1] === key && (i.code === 'task.solution_not_full_marks' || i.path[2] === 'solution' || i.path[2] === 'grader'));
  return runs.filter((r) => scoredOne(r.key)).map((r) => issue('iterate.regression', ['tasks', r.task, 'decoys', r.index], {
    what: `Old decoy ${r.index} of ${r.task} ("${r.why}") now scores 1. Make the grader score it below 1, or name tasks.${r.task} in plan.changes.`,
  }, 'scored 1'));
}

/**
 * A seeded row the old world had and the new one lacks, while an old test or task the new world
 * kept names its id literally. One issue per lost id, at the seed that should make it.
 */
function lostRowRegressions(before: CheckedWorld, after: CheckedWorld, exempt: Exempt): readonly CheckIssue[] {
  const old = createRuntime(before).dump().tables;
  const now = createRuntime(after).dump().tables;
  const lost: { entity: string; id: string }[] = [];
  for (const [entity, rows] of Object.entries(old)) {
    const kept = new Set((Object.hasOwn(now, entity) ? now[entity] ?? [] : []).map((r) => r.id));
    for (const r of rows) if (!kept.has(r.id)) lost.push({ entity, id: r.id });
  }
  if (lost.length === 0) return [];
  const texts: { where: string; owner: string; text: string }[] = [];
  for (const [name, t] of Object.entries(before.tests)) {
    if (Object.hasOwn(after.tests, name) && !exempt('tests', name, ['tests', name])) texts.push({ where: `tests.${name}.script`, owner: `tests.${name}`, text: t.script });
  }
  for (const [id, t] of Object.entries(before.tasks)) {
    if (!Object.hasOwn(after.tasks, id) || exempt('tasks', id, ['tasks', id])) continue;
    const owner = `tasks.${id}`;
    texts.push({ where: `${owner}.instruction`, owner, text: t.instruction });
    // A bare task (the public form of a world, YOS-159) carries no snippet text to search.
    if (t.grader !== undefined) texts.push({ where: `${owner}.grader`, owner, text: t.grader });
    if (t.solution !== undefined) texts.push({ where: `${owner}.solution`, owner, text: t.solution });
    texts.push(...t.decoys.map((d, i) => ({ where: `${owner}.decoys.${i}.script`, owner, text: d.script })));
  }
  return lost.flatMap(({ entity, id }) => {
    const word = new RegExp(`(?:^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
    const user = texts.find((t) => word.test(t.text));
    if (user === undefined) return [];
    return [issue('iterate.regression', ['seed', entity], {
      what: `Row ${id} is gone from the new seed, but the old ${user.where} names it. Seed it again, or name ${user.owner} in plan.changes.`,
    }, `no ${entity} ${id} after seeding`)];
  });
}

/**
 * The iterate gate, run on an accepted new world. In order:
 * - every destructive change from diffWorlds(before, after) not named in an edit's `remove` or
 *   in plan.changes (`iterate.unplanned_change`, see `unplannedChanges`);
 * - old tests the new world dropped or rewrote, rerun on the new world (`iterate.regression`);
 * - old decoys of kept tasks, scored by the new grader: scoring 1 is `iterate.regression`;
 * - seeded rows that an old kept test or task names by literal id and the new seed lost.
 * A test or task named in edit.remove or plan.changes is not rerun.
 */
export function preservationIssues(
  before: CheckedWorld,
  after: CheckedWorld,
  edits: readonly WorldEdit[],
  plan: Plan,
): readonly CheckIssue[] {
  const names = plannedNames(plan);
  const exempt: Exempt = (section, key, steps) => removedByEdit(edits, section, key) || named(names, steps);
  return [
    ...unplannedChanges(diffWorlds(before, after), edits, plan),
    ...testRegressions(before, after, exempt),
    ...decoyRegressions(before, after, exempt),
    ...lostRowRegressions(before, after, exempt),
  ];
}
