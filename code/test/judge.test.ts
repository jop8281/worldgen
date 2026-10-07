import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { issue, type CheckIssue, type CheckReport, type World, type WorldStats } from '#engine';
import { blockingIssues } from '../src/worldgen/judge.ts';
import { ownerOf } from '../src/worldgen/policy.ts';
import type { Plan } from '../src/worldgen/plan.ts';
import { STAGES, type StageId } from '../src/worldgen/stages.ts';

const plan: Plan = {
  revision: 1,
  software: 'Zendesk-style helpdesk',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Tickets with SLA tiers.',
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'ticket', purpose: 'a support request', keyFields: ['status'] },
    { name: 'agent', purpose: 'who works tickets', keyFields: ['email'] },
  ],
  workflows: [{ name: 'triage', entity: 'ticket', states: ['open', 'solved'], rules: [], actions: ['assign', 'solve'] }],
  jobs: [],
  acceptanceTests: [],
  routes: [{ id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse' }],
  seed: { rowsPerEntity: { ticket: 60 }, mix: 'mostly open' },
  tasks: [
    { id: 'assign_oldest', difficulty: 'easy', intent: 'assign', decoyIdea: 'newest' },
    { id: 'solve_vip', difficulty: 'medium', intent: 'solve a ticket until it is solved', decoyIdea: 'page 1 only' },
    { id: 'rebalance', difficulty: 'hard', intent: 'rebalance', decoyIdea: 'moves one' },
  ],
  assumptions: [],
  outOfScope: [],
  changes: [],
};

const meta: World['meta'] = {
  name: 'helpdesk',
  description: 'test world',
  resembles: 'Zendesk tickets API',
  source: 'hand',
  seed: 1,
  clock: { start: '2026-01-01T00:00:00Z', tick: '1s' },
  api: { list: { mode: 'cursor', dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' }, error: {} },
};
const entity = { description: 'x', idPrefix: 'tk', fields: {} };
const ticket: World['entities'][string] = {
  ...entity,
  fields: { status: { type: 'state', states: ['open', 'solved'], initial: 'open', transitions: { open: ['solved'] }, required: false, nullable: false, unique: false, readonly: false } },
};
const action = (path: string) => ({ method: 'POST' as const, path, input: {}, handler: '(ctx) => null' });
const task = (difficulty: 'easy' | 'medium' | 'hard') => ({
  difficulty,
  instruction: 'do the thing the plan says to do',
  grader: '(ctx) => 1',
  solution: '(ctx) => null',
  decoys: [],
  alternatives: [],
});

function world(over: Partial<World> = {}): World {
  return {
    format: 1,
    meta,
    entities: { ticket, agent: entity },
    routes: { list_tickets: { op: 'get' as const, entity: 'ticket', method: 'GET' as const, path: '/tickets' } },
    actions: { assign: action('/tickets/{id}/assign'), solve: action('/tickets/{id}/solve') },
    jobs: {},
    fixtures: {},
    seed: {},
    tests: {},
    tasks: { assign_oldest: task('easy'), solve_vip: task('medium'), rebalance: task('hard') },
    ...over,
  };
}

/** check() is not implemented, so no CheckedWorld can be minted. The reports are cast once, here. */
function okReport(w: World, warnings: readonly CheckIssue[] = [], stats: Partial<WorldStats> = {}): CheckReport {
  return {
    ok: true,
    world: w,
    verdicts: {},
    stats: { rows: { ticket: 60 }, states: {}, unexercisedActions: [], ...stats },
    tests: 0,
    warnings,
  } as unknown as CheckReport;
}
function failReport(issues: readonly CheckIssue[], warnings: readonly CheckIssue[] = [], stats?: Pick<WorldStats, 'rows' | 'states'>): CheckReport {
  return { ok: false, reached: 'schema', issues, warnings, ...(stats === undefined ? {} : { stats }) } as unknown as CheckReport;
}

const schemaBad = (section: 'entities' | 'routes' | 'actions' | 'tests' | 'seed' | 'tasks') =>
  issue('schema.invalid', [section, 'x'], { message: 'bad' }, 'bad');
const metaBad = issue('schema.invalid', ['meta', 'name'], { message: 'bad' }, 'bad');
const unexercised = issue('action.unexercised', ['actions', 'solve'], { action: 'solve' }, 'no caller');
const paging = issue('seed.too_few_rows_for_paging', ['seed', 'ticket'], { entity: 'ticket', rows: 10, pageSize: 25 }, '10 rows');
const skew = issue('seed.state_mix_skewed', ['seed', 'ticket'], { field: 'ticket.status', counts: { open: 10, solved: 0 } }, '"solved" has no rows');
// A-129: this skew blocks the seed stage because the plan's solve_vip task needs a solved ticket.
const spread = issue('tasks.difficulty_not_spread', ['tasks'], { have: ['easy'] }, 'easy');
const solutionBad = issue('task.solution_not_full_marks', ['tasks', 'solve_vip'], { score: 0.5 }, '0.5');
const noopBad = issue('task.noop_not_zero', ['tasks', 'rebalance'], { score: 1 }, '1');
const testFailed = issue('test.failed', ['tests', 't1'], { message: 'boom' }, 'boom');
const tooFewTasks = issue('world.too_few_tasks', ['tasks'], { have: 0 }, '0 tasks');
const unknownRef = issue('ref.unknown', ['routes', 'list_tickets', 'entity'], { kind: 'entity', name: 'x', known: [] }, 'x');
const nonDeterministic = issue('task.nondeterministic', ['tasks', 'solve_vip'], { first: 'a', second: 'b' }, 'a vs b');

type Row = { name: string; stage: StageId; report: CheckReport; plan: Plan; codes: readonly string[]; deferred?: readonly string[] };

const rows: readonly Row[] = [
  { name: 'model stage keeps its own errors and defers later sections', stage: 'model', report: failReport([schemaBad('entities'), schemaBad('actions'), schemaBad('tasks')]), plan, codes: ['schema.invalid'], deferred: ['schema.invalid', 'schema.invalid'] },
  { name: 'workflow stage keeps model and workflow errors, defers seed and tasks', stage: 'workflow', report: failReport([schemaBad('entities'), schemaBad('tests'), schemaBad('seed'), solutionBad]), plan, codes: ['schema.invalid', 'schema.invalid'], deferred: ['schema.invalid', 'task.solution_not_full_marks'] },
  { name: 'tasks stage keeps errors from every section', stage: 'tasks', report: failReport([unknownRef, testFailed, schemaBad('seed'), solutionBad]), plan, codes: ['ref.unknown', 'test.failed', 'schema.invalid', 'task.solution_not_full_marks'] },
  { name: 'meta errors block even the first stage', stage: 'model', report: failReport([metaBad, schemaBad('seed')]), plan, codes: ['schema.invalid'], deferred: ['schema.invalid'] },
  { name: 'seed warnings on a failed report block the seed stage alongside engine errors', stage: 'seed', report: failReport([schemaBad('seed')], [paging, spread, skew]), plan, codes: ['schema.invalid', 'seed.state_mix_skewed'] },
  { name: 'seed warnings on a failed report do not block other stages', stage: 'tasks', report: failReport([schemaBad('seed')], [paging, skew]), plan, codes: ['schema.invalid'] },
  { name: 'a failed report with only later-stage errors blocks nothing now and defers them all', stage: 'seed', report: failReport([solutionBad, noopBad, nonDeterministic]), plan, codes: [], deferred: ['task.solution_not_full_marks', 'task.noop_not_zero', 'task.nondeterministic'] },
  { name: 'ok report with full coverage blocks nothing at model', stage: 'model', report: okReport(world()), plan, codes: [] },
  { name: 'model stage reports missing entity and route, not action or task gaps', stage: 'model', report: okReport(world({ entities: { ticket }, routes: {}, actions: {}, tasks: {} })), plan, codes: ['plan.not_covered', 'plan.not_covered'] },
  { name: 'workflow stage reports a missing action and an unexercised action', stage: 'workflow', report: okReport(world({ actions: { assign: action('/a') }, tasks: {} }), [], { unexercisedActions: ['assign'] }), plan, codes: ['plan.not_covered', 'action.unexercised'] },
  { name: 'workflow stage blocks on an unexercised action warning from a report that failed only for too few tasks (A-136)', stage: 'workflow', report: failReport([tooFewTasks], [unexercised, paging]), plan, codes: ['action.unexercised'], deferred: ['world.too_few_tasks'] },
  { name: 'seed stage ignores an unexercised action warning on a failed report', stage: 'seed', report: failReport([tooFewTasks], [unexercised]), plan, codes: [], deferred: ['world.too_few_tasks'] },
  { name: 'workflow stage reports an unexercised action warning as blocking', stage: 'workflow', report: okReport(world(), [unexercised], { unexercisedActions: ['solve'] }), plan, codes: ['action.unexercised'] },
  // Updated in stab/paging: seed.too_few_rows_for_paging no longer blocks the seed stage.
  { name: 'seed stage returns only blocking seed warnings', stage: 'seed', report: okReport(world(), [unexercised, paging, spread, skew]), plan, codes: ['seed.state_mix_skewed'] },
  { name: 'seed stage still reports an earlier stage coverage gap', stage: 'seed', report: okReport(world({ entities: { ticket } })), plan, codes: ['plan.not_covered'] },
  { name: 'seed stage ignores a task coverage gap that tasks owns', stage: 'seed', report: okReport(world({ tasks: {} })), plan, codes: [] },
  { name: 'tasks stage reports a missing task once, not twice', stage: 'tasks', report: okReport(world({ tasks: { assign_oldest: task('easy'), solve_vip: task('medium') } })), plan, codes: ['plan.not_covered', 'world.too_few_tasks', 'tasks.difficulty_not_spread'] },
  { name: 'tasks stage ignores warnings other than its own', stage: 'tasks', report: okReport(world(), [paging, skew, unexercised]), plan, codes: [] },
];

describe('blockingIssues', () => {
  const routeMismatch: Plan = { ...plan, routes: [{ id: 'list_tickets', method: 'DELETE', path: '/wrong-tickets', purpose: 'browse' }] };
  const actionMismatch: Plan = { ...plan, routes: [{ id: 'solve', method: 'DELETE', path: '/wrong-solve', purpose: 'solve' }] };
  for (const row of [
    { stage: 'model', plan: routeMismatch, paths: [['routes', 'list_tickets']] },
    { stage: 'workflow', plan: routeMismatch, paths: [['routes', 'list_tickets']] },
    { stage: 'tasks', plan: routeMismatch, paths: [['routes', 'list_tickets']] },
    { stage: 'model', plan: actionMismatch, paths: [] },
    { stage: 'workflow', plan: actionMismatch, paths: [['actions', 'solve']] },
    { stage: 'tasks', plan: actionMismatch, paths: [['actions', 'solve']] },
  ] satisfies { stage: StageId; plan: Plan; paths: string[][] }[]) {
    it(`${row.stage} filters ${row.plan.routes[0]?.id} contract mismatches by the world section on an ok report`, () => {
      const result = blockingIssues(row.stage, okReport(world()), row.plan);
      assert.deepEqual(result.blocking.map((i) => i.path), row.paths);
      assert.equal(result.accepted === null, row.paths.length > 0);
    });

    it(`${row.stage} filters ${row.plan.routes[0]?.id} contract mismatches on a failed report`, () => {
      const result = blockingIssues(row.stage, failReport([solutionBad]), row.plan, world());
      assert.deepEqual(result.blocking.filter((i) => i.code === 'plan.not_covered').map((i) => i.path), row.paths);
      assert.equal(result.accepted, null);
    });
  }

  it('stage done rules enforce route contracts and defer action contracts to workflow', () => {
    const report = okReport(world());
    assert.ok(report.ok);
    assert.deepEqual(STAGES.model.done(report, routeMismatch).map((i) => i.path), [['routes', 'list_tickets']]);
    assert.deepEqual(STAGES.model.done(report, actionMismatch), []);
    assert.deepEqual(STAGES.workflow.done(report, actionMismatch).map((i) => i.path), [['actions', 'solve']]);
  });

  for (const row of rows) {
    it(row.name, () => {
      const j = blockingIssues(row.stage, row.report, row.plan);
      assert.deepEqual(j.blocking.map((i) => i.code), row.codes);
      assert.deepEqual(j.deferred.map((i) => i.code), row.deferred ?? []);
    });
  }

  it('keeps report order and the original issue objects', () => {
    const r = failReport([testFailed, schemaBad('entities')]);
    const out = blockingIssues('workflow', r, plan).blocking;
    assert.deepEqual(out.map((i) => i.path), [['tests', 't1'], ['entities', 'x']]);
    assert.equal(out[0], testFailed);
  });

  it('points a coverage gap at the plan item', () => {
    const out = blockingIssues('model', okReport(world({ entities: { ticket } })), plan).blocking;
    assert.deepEqual(out.map((i) => i.path), [['plan', 'entities', 1]]);
    assert.equal(out[0]?.severity, 'error');
  });

  it('keeps the warning severity on a done warning', () => {
    assert.equal(blockingIssues('seed', okReport(world(), [skew]), plan).blocking[0]?.severity, 'warning');
  });
});

describe('blockingIssues: planned jobs and planned seed rows (A-148)', () => {
  const withJob: Plan = { ...plan, jobs: [{ name: 'sla_breach', every: '15m', rule: 'overdue tickets become urgent' }] };
  const job = { description: 'escalates overdue tickets', every: '15m', run: '(ctx) => null' };

  it('workflow stage blocks a world that leaves out a planned job, and names the plan item', () => {
    const out = blockingIssues('workflow', okReport(world()), withJob).blocking;
    assert.deepEqual(out.map((i) => [i.code, i.path]), [['plan.not_covered', ['plan', 'jobs', 0]]]);
  });

  it('workflow stage accepts the world once the planned job is a key in jobs', () => {
    assert.deepEqual(blockingIssues('workflow', okReport(world({ jobs: { sla_breach: job } })), withJob).blocking, []);
  });

  it('workflow stage reports the missing job from the candidate on a failed report, and model stage leaves it to workflow', () => {
    const failed = blockingIssues('workflow', failReport([tooFewTasks], []), withJob, world());
    assert.deepEqual(failed.blocking.map((i) => i.code), ['plan.not_covered']);
    assert.deepEqual(failed.deferred.map((i) => i.code), ['world.too_few_tasks']);
    assert.deepEqual(blockingIssues('model', okReport(world()), withJob).blocking, []);
  });

  it('seed stage blocks an entity with fewer rows than the plan says, and names the plan entry', () => {
    const out = blockingIssues('seed', okReport(world(), [], { rows: { ticket: 10 } }), plan).blocking;
    assert.deepEqual(out.map((i) => [i.code, i.path, i.severity]), [['plan.seed_rows_short', ['plan', 'seed', 'rowsPerEntity', 'ticket'], 'error']]);
    assert.equal(out[0]?.found, '10 rows');
  });

  it('seed stage accepts a seed with the planned rows or more, and ignores entities the input supplies as fixtures', () => {
    assert.deepEqual(blockingIssues('seed', okReport(world(), [], { rows: { ticket: 60 } }), plan).blocking, []);
    assert.deepEqual(blockingIssues('seed', okReport(world(), [], { rows: { ticket: 75 } }), plan).blocking, []);
    assert.deepEqual(blockingIssues('seed', okReport(world({ fixtures: { ticket: [{}] } }), [], { rows: { ticket: 10 } }), plan).blocking, []);
  });

  it('later stages do not repeat the seed row shortfall', () => {
    assert.deepEqual(blockingIssues('tasks', okReport(world(), [], { rows: { ticket: 10 } }), plan).blocking, []);
  });
});

describe('blockingIssues: planned workflow states, rule links and seed state mix (A-155)', () => {
  const statusOf = (states: readonly string[]): World['entities'][string] =>
    ({ ...ticket, fields: { status: { ...ticket.fields['status']!, type: 'state', states: [...states], initial: states[0]!, transitions: {} } } });
  const codesAt = (j: { blocking: readonly CheckIssue[] }) => j.blocking.map((i) => [i.code, i.path, i.found]);

  it('model stage blocks a planned state the entity state machine leaves out, and names the plan state', () => {
    const j = blockingIssues('model', okReport(world({ entities: { ticket: statusOf(['open']), agent: entity } })), plan);
    assert.deepEqual(codesAt(j), [['plan.state_missing', ['plan', 'workflows', 0, 'states', 1], 'ticket.status declares open']]);
    assert.equal(j.blocking[0]?.expected, 'a state field of ticket that declares solved, a state of the planned workflow triage');
  });

  it('model stage judges the candidate on a failed report too', () => {
    const j = blockingIssues('model', failReport([tooFewTasks]), plan, world({ entities: { ticket: statusOf(['open', 'closed']), agent: entity } }));
    assert.deepEqual(codesAt(j), [['plan.state_missing', ['plan', 'workflows', 0, 'states', 1], 'ticket.status declares open, closed']]);
  });

  it('model stage blocks a planned workflow whose entity has no state field, at the entity path (A-159)', () => {
    const bare = world({ entities: { ticket: entity, agent: entity } });
    const want = [['plan.state_field_missing', ['entities', 'ticket'], 'ticket has no state field']];
    assert.deepEqual(codesAt(blockingIssues('model', okReport(bare), plan)), want);
    assert.deepEqual(codesAt(blockingIssues('model', failReport([tooFewTasks]), plan, bare)), want);
    const j = blockingIssues('workflow', okReport(bare), plan);
    assert.deepEqual(j.blocking.map((i) => [i.code, ownerOf(i)]), [['plan.state_field_missing', 'model']]);
    assert.equal(j.blocking[0]?.expected, 'a state field on ticket that declares the states of the planned workflow triage: open, solved');
  });

  it('leaves alone a workflow whose entity has a state machine that declares none of its states, once the plan declares its lifecycle', () => {
    const declared: Plan = {
      ...plan,
      workflows: [{ ...plan.workflows[0]!, lifecycle: { representation: 'descriptive', reason: 'the ticket machine models another workflow, and the triage states are derived, not stored' } }],
    };
    assert.deepEqual(blockingIssues('model', okReport(world({ entities: { ticket: statusOf(['new', 'closed']), agent: entity } })), declared).blocking, []);
  });

  it('later stages still see a missing state, and policy sends it back to model', () => {
    const j = blockingIssues('workflow', okReport(world({ entities: { ticket: statusOf(['open']), agent: entity } })), plan);
    assert.deepEqual(j.blocking.map((i) => [i.code, ownerOf(i)]), [['plan.state_missing', 'model']]);
  });

  const linked: Plan = {
    ...plan,
    workflows: [{ ...plan.workflows[0]!, rules: ['solved is final', { rule: 'overdue tickets escalate', by: ['sla_breach'], test: 'solve_ticket' }] }],
    jobs: [{ name: 'sla_breach', every: '15m', rule: 'escalate overdue tickets' }],
  };
  const job = { description: 'escalates overdue tickets', every: '15m', run: '(ctx) => null' };

  it('workflow stage blocks a linked rule whose action or job is not built, and leaves text rules alone', () => {
    const j = blockingIssues('workflow', okReport(world()), linked);
    assert.deepEqual(codesAt(j), [
      ['plan.not_covered', ['plan', 'jobs', 0], 'no jobs.sla_breach'],
      ['plan.rule_unanswered', ['plan', 'workflows', 0, 'rules', 1], 'no actions.sla_breach or jobs.sla_breach'],
    ]);
    assert.equal(j.blocking[1]?.expected, 'an action or job sla_breach that enforces the triage rule: overdue tickets escalate');
    assert.deepEqual(j.blocking.map(ownerOf), ['workflow', 'workflow']);
  });

  it('a linked rule is answered once its job is built, and the model stage never sees it', () => {
    assert.deepEqual(blockingIssues('workflow', okReport(world({ jobs: { sla_breach: job } })), linked).blocking, []);
    assert.deepEqual(blockingIssues('model', okReport(world()), linked).blocking, []);
  });

  const mixed: Plan = { ...plan, seed: { ...plan.seed, stateMix: { ticket: { open: 70, solved: 30 } } } };

  it('seed stage blocks a seeded state share more than 10 points off stateMix, and names the plan share', () => {
    const j = blockingIssues('seed', okReport(world(), [], { states: { 'ticket.status': { open: 58, solved: 2 } } }), mixed);
    assert.deepEqual(codesAt(j), [
      ['plan.seed_mix_off', ['plan', 'seed', 'stateMix', 'ticket', 'open'], '58 of 60 rows'],
      ['plan.seed_mix_off', ['plan', 'seed', 'stateMix', 'ticket', 'solved'], '2 of 60 rows'],
    ]);
    assert.equal(j.blocking[1]?.hint, 'The seed has 3%. Seed the planned share, or change stateMix in the plan step.');
  });

  it('seed stage accepts shares within 10 points, and skips fixtures and plans without stateMix', () => {
    const near = { states: { 'ticket.status': { open: 36, solved: 24 } } };
    assert.deepEqual(blockingIssues('seed', okReport(world(), [], near), mixed).blocking, []);
    const off = { states: { 'ticket.status': { open: 60, solved: 0 } } };
    assert.deepEqual(blockingIssues('seed', okReport(world({ fixtures: { ticket: [{}] } }), [], off), mixed).blocking, []);
    assert.deepEqual(blockingIssues('seed', okReport(world({ fixtures: { tickets: [{}] } }), [], off), mixed).blocking, []);
    const fromCsv = world({ fixtures: { rows: [{}] }, seed: { ticket: '(ctx) => ctx.fixtures.rows' } });
    assert.deepEqual(blockingIssues('seed', okReport(fromCsv, [], { ...off, rows: { ticket: 1 } }), mixed).blocking, []);
    assert.deepEqual(blockingIssues('seed', okReport(world(), [], off), plan).blocking, []);
  });

  it('seed stage judges rows and state mix from a failed report that carries seed counts, as on create', () => {
    const counts = { rows: { ticket: 10 }, states: { 'ticket.status': { open: 10, solved: 0 } } };
    const j = blockingIssues('seed', failReport([tooFewTasks], [], counts), mixed, world());
    assert.deepEqual(j.blocking.map((i) => [i.code, i.path]), [
      ['plan.seed_rows_short', ['plan', 'seed', 'rowsPerEntity', 'ticket']],
      ['plan.seed_mix_off', ['plan', 'seed', 'stateMix', 'ticket', 'open']],
      ['plan.seed_mix_off', ['plan', 'seed', 'stateMix', 'ticket', 'solved']],
    ]);
    assert.deepEqual(j.deferred.map((i) => i.code), ['world.too_few_tasks']);
  });
});

describe('blockingIssues never accepts a world the engine rejects', () => {
  it('a tasks-owned error alone blocks the final tasks stage and nothing is accepted', () => {
    const j = blockingIssues('tasks', failReport([solutionBad]), plan);
    assert.deepEqual(j.blocking.map((i) => i.code), ['task.solution_not_full_marks']);
    assert.deepEqual(j.deferred.map((i) => i.code), []);
    assert.equal(j.accepted, null);
  });

  it('YOS-113: a 0-task world failing only world.too_few_tasks passes the model, workflow and seed gates', () => {
    const tooFew = issue('world.too_few_tasks', ['tasks'], { have: 0 }, '0 tasks');
    for (const stage of ['model', 'workflow', 'seed'] as const) {
      const j = blockingIssues(stage, failReport([tooFew]), plan, world({ tasks: {} }));
      assert.deepEqual(j.blocking.map((i) => i.code), [], stage);
      assert.deepEqual(j.deferred.map((i) => i.code), ['world.too_few_tasks'], stage);
    }
  });

  it('a 0-task world with a skewed seed blocks the seed stage on the skew, not on paging', () => {
    const tooFew = issue('world.too_few_tasks', ['tasks'], { have: 0 }, '0 tasks');
    const j = blockingIssues('seed', failReport([tooFew], [paging, skew]), plan, world({ tasks: {} }));
    assert.deepEqual(j.blocking.map((i) => i.code), ['seed.state_mix_skewed']);
    assert.deepEqual(j.deferred.map((i) => i.code), ['world.too_few_tasks']);
    assert.equal(j.accepted, null);
  });

  it('a tasks-owned error alone is deferred, not dropped, at every earlier stage', () => {
    for (const stage of ['model', 'workflow', 'seed'] as const) {
      const j = blockingIssues(stage, failReport([solutionBad]), plan);
      assert.deepEqual(j.blocking.map((i) => i.code), []);
      assert.deepEqual(j.deferred.map((i) => i.path), [['tasks', 'solve_vip']]);
      assert.equal(j.deferred[0], solutionBad);
      assert.equal(j.accepted, null);
    }
  });

  it('a failed report is never accepted, even with an empty blocking list', () => {
    const j = blockingIssues('seed', failReport([schemaBad('tasks')]), plan, world());
    assert.deepEqual(j.blocking, []);
    assert.equal(j.accepted, null);
  });

  it('an ok report with nothing blocking accepts the checked world', () => {
    const r = okReport(world());
    const j = blockingIssues('tasks', r, plan);
    assert.deepEqual(j.blocking, []);
    assert.deepEqual(j.deferred, []);
    assert.equal(j.accepted, r.ok ? r.world : undefined);
  });

  it('an ok report with a coverage gap is not accepted', () => {
    const j = blockingIssues('model', okReport(world({ entities: { ticket } })), plan);
    assert.deepEqual(j.blocking.map((i) => i.code), ['plan.not_covered']);
    assert.equal(j.accepted, null);
  });

  it('reports coverage gaps of the candidate world together with engine errors', () => {
    const j = blockingIssues('model', failReport([schemaBad('entities')]), plan, world({ entities: { ticket }, routes: {} }));
    assert.deepEqual(j.blocking.map((i) => i.code), ['schema.invalid', 'plan.not_covered', 'plan.not_covered']);
    assert.deepEqual(j.blocking.map((i) => i.path), [['entities', 'x'], ['plan', 'entities', 1], ['plan', 'routes', 0]]);
  });

  it('candidate coverage on a failed report follows stage ownership', () => {
    const candidate = world({ actions: { assign: action('/a') }, tasks: {} });
    const atModel = blockingIssues('model', failReport([solutionBad]), plan, candidate);
    assert.deepEqual(atModel.blocking.map((i) => i.code), []);
    const atWorkflow = blockingIssues('workflow', failReport([solutionBad]), plan, candidate);
    assert.deepEqual(atWorkflow.blocking.map((i) => i.path), [['plan', 'workflows', 0, 'actions', 1]]);
    const atTasks = blockingIssues('tasks', failReport([solutionBad]), plan, candidate);
    assert.deepEqual(atTasks.blocking.map((i) => i.code), ['task.solution_not_full_marks', 'plan.not_covered', 'plan.not_covered', 'plan.not_covered', 'plan.not_covered', 'world.too_few_tasks', 'tasks.difficulty_not_spread']);
    assert.deepEqual(atTasks.deferred, []);
  });

  it('seed done rules run on a failed report: seed warnings are reported with the engine error', () => {
    const j = blockingIssues('seed', failReport([schemaBad('seed')], [paging, unexercised, skew]), plan, world());
    assert.deepEqual(j.blocking.map((i) => i.code), ['schema.invalid', 'seed.state_mix_skewed']);
    assert.deepEqual(j.blocking.map((i) => i.severity), ['error', 'warning']);
    assert.equal(j.accepted, null);
  });

  it('tasks done rules run on a failed report: task count and spread of the candidate are reported with the engine error', () => {
    const j = blockingIssues('tasks', failReport([solutionBad]), plan, world({ tasks: { assign_oldest: task('easy') } }));
    assert.deepEqual(j.blocking.map((i) => i.code), ['task.solution_not_full_marks', 'plan.not_covered', 'plan.not_covered', 'world.too_few_tasks', 'tasks.difficulty_not_spread']);
    assert.deepEqual(j.blocking.map((i) => i.path), [['tasks', 'solve_vip'], ['plan', 'tasks', 1], ['plan', 'tasks', 2], ['tasks'], ['tasks']]);
    assert.equal(j.accepted, null);
  });

  it('a failed report with a full candidate adds no tasks done issues', () => {
    const j = blockingIssues('tasks', failReport([solutionBad]), plan, world());
    assert.deepEqual(j.blocking.map((i) => i.code), ['task.solution_not_full_marks']);
  });

  it('a failed report without a candidate world reports no coverage', () => {
    const j = blockingIssues('tasks', failReport([schemaBad('entities')]), plan);
    assert.deepEqual(j.blocking.map((i) => i.code), ['schema.invalid']);
  });
});

describe('judge.ts imports', () => {
  it('imports neither llm.ts nor policy.ts', () => {
    const src = readFileSync(new URL('../src/worldgen/judge.ts', import.meta.url), 'utf8');
    const specs = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(specs, ['#engine', './input-coverage.ts', './input.ts', './plan.ts', './stages.ts', './input-coverage.ts']);
  });
});
