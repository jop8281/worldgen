import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issue, type CheckIssue, type CheckReport, type World, type WorldStats } from '#engine';
import type { Plan } from '../src/worldgen/plan.ts';
import { PLAN_BRIEF, STAGES, pressureChecks, pressureIssues, seedNeedLines, seedNeeds, stagesToRun, taskPressureLines } from '../src/worldgen/stages.ts';

type OkReport = Extract<CheckReport, { ok: true }>;

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
  routes: [
    { id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse' },
    { id: 'get_ticket', method: 'GET', path: '/tickets/{id}', purpose: 'read one' },
  ],
  seed: { rowsPerEntity: { ticket: 60 }, mix: 'mostly open' },
  tasks: [
    { id: 'assign_oldest', difficulty: 'easy', intent: 'assign', decoyIdea: 'newest' },
    { id: 'solve_vip', difficulty: 'medium', intent: 'solve', decoyIdea: 'page 1 only' },
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
const route = (path: string) => ({ op: 'get' as const, entity: 'ticket', method: 'GET' as const, path });
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
    entities: { ticket: entity, agent: entity },
    routes: { list_tickets: route('/tickets'), get_ticket: route('/tickets/{id}') },
    actions: { assign: action('/tickets/{id}/assign'), solve: action('/tickets/{id}/solve') },
    jobs: {},
    fixtures: {},
    seed: {},
    tests: {},
    tasks: { assign_oldest: task('easy'), solve_vip: task('medium'), rebalance: task('hard') },
    ...over,
  };
}

/**
 * checkWorld is not implemented yet, so no CheckedWorld can be minted. `done` reads only
 * world, stats and warnings, so the test builds an ok report and casts the report once.
 */
function report(w: World, stats: Partial<WorldStats> = {}, warnings: readonly CheckIssue[] = []): OkReport {
  const r = {
    ok: true,
    world: w,
    verdicts: {},
    stats: { rows: { ticket: 60 }, states: {}, unexercisedActions: [], ...stats },
    tests: 0,
    warnings,
  };
  return r as unknown as OkReport;
}

const summary = (issues: readonly CheckIssue[]) => issues.map((i) => [i.code, i.severity, i.path]);

const sentences = (text: string) => text.split(/[.!?](?:\s+|$)/).filter((s) => s.trim() !== '');

describe('STAGES.model.done', () => {
  it('passes when every planned entity and route exists', () => {
    assert.deepEqual(STAGES.model.done(report(world()), plan), []);
  });

  it('reports missing planned entities and routes, and ignores actions and tasks', () => {
    const w = world({ entities: { ticket: entity }, routes: { list_tickets: route('/tickets') }, actions: {}, tasks: {} });
    assert.deepEqual(summary(STAGES.model.done(report(w), plan)), [
      ['plan.not_covered', 'error', ['plan', 'entities', 1]],
      ['plan.not_covered', 'error', ['plan', 'routes', 1]],
    ]);
  });
});

describe('STAGES.workflow.done', () => {
  it('passes when every planned action exists and is exercised', () => {
    assert.deepEqual(STAGES.workflow.done(report(world()), plan), []);
  });

  it('reports a missing planned action, and ignores entities and tasks', () => {
    const w = world({ entities: {}, actions: { assign: action('/tickets/{id}/assign') }, tasks: {} });
    assert.deepEqual(summary(STAGES.workflow.done(report(w), plan)), [
      ['plan.not_covered', 'error', ['plan', 'workflows', 0, 'actions', 1]],
    ]);
  });

  it('reports every action with no test', () => {
    const issues = STAGES.workflow.done(report(world(), { unexercisedActions: ['solve'] }), plan);
    assert.deepEqual(summary(issues), [['action.unexercised', 'warning', ['actions', 'solve']]]);
    assert.equal(issues[0]?.hint, 'Remove solve, or call it from a test or a task solution.');
  });
});

describe('STAGES.seed.done', () => {
  it('passes with no warnings', () => {
    assert.deepEqual(STAGES.seed.done(report(world()), plan), []);
  });

  // A-129: a skewed state mix is advisory unless a planned task needs a state the seed never produces.
  const skew = (found: string) => issue('seed.state_mix_skewed', ['seed', 'ticket'], { field: 'ticket.status', counts: { open: 9, solved: 1 } }, found);
  const codes = (issues: readonly CheckIssue[]) => issues.map((i) => i.code);

  it('returns the blocking seed.* warnings, and not paging, an over-share state mix, other layers\' warnings', () => {
    const paging = issue('seed.too_few_rows_for_paging', ['seed', 'ticket'], { entity: 'ticket', rows: 10, pageSize: 25 }, '10 rows');
    const unexercised = issue('action.unexercised', ['actions', 'solve'], { action: 'solve' }, 'no caller');
    const spread = issue('tasks.difficulty_not_spread', ['tasks'], { have: ['easy'] }, 'easy');
    const other = issue('seed.too_few_rows_for_paging', ['seed', 'agent'], { entity: 'agent', rows: 3, pageSize: 25 }, '3 rows');
    assert.deepEqual(codes(STAGES.seed.done(report(world(), {}, [unexercised, paging, spread, skew('"open" has 169 of 220 rows'), other]), plan)), []);
  });

  it('does not block on a state the seed never produces when no planned task mentions it', () => {
    assert.deepEqual(codes(STAGES.seed.done(report(world(), {}, [skew('"escalated" has no rows')]), plan)), []);
  });

  it('blocks on a state the seed never produces when a planned task needs it', () => {
    const needs: Plan = { ...plan, tasks: [{ id: 'close_solved', difficulty: 'easy', intent: 'Find a Solved ticket and reopen it', decoyIdea: 'any ticket' }, ...plan.tasks.slice(1)] };
    assert.deepEqual(codes(STAGES.seed.done(report(world(), {}, [skew('"open" has 50 of 60 rows; "solved" has no rows')]), needs)), ['seed.state_mix_skewed']);
  });

  it('blocks on a seeded past event after the clock start', () => {
    const late = issue('seed.time_order', ['seed', 'ticket'], { entity: 'ticket', id: 'tkt_0001', problem: 'resolved_at 2026-02-01T00:00:00.000Z is after the clock start 2026-01-05T09:00:00.000Z' },
      'tkt_0001: resolved_at 2026-02-01T00:00:00.000Z is after the clock start 2026-01-05T09:00:00.000Z');
    assert.deepEqual(codes(STAGES.seed.done(report(world(), {}, [late]), plan)), ['seed.time_order']);
  });

  it('is not blocked by seed.too_few_rows_for_paging alone', () => {
    const paging = issue('seed.too_few_rows_for_paging', ['seed', 'customer'], { entity: 'customer', rows: 5, pageSize: 25 }, '5 rows');
    assert.deepEqual(STAGES.seed.done(report(world(), {}, [paging]), plan), []);
  });
});

describe('STAGES.tasks.done', () => {
  it('passes with three tasks covering easy, medium and hard', () => {
    assert.deepEqual(STAGES.tasks.done(report(world()), plan), []);
  });

  it('reports too few tasks and the missing difficulty', () => {
    const smallPlan: Plan = { ...plan, tasks: plan.tasks.slice(0, 2) };
    const w = world({ tasks: { assign_oldest: task('easy'), solve_vip: task('medium') } });
    const issues = STAGES.tasks.done(report(w), smallPlan);
    assert.deepEqual(summary(issues), [
      ['world.too_few_tasks', 'error', ['tasks']],
      ['tasks.difficulty_not_spread', 'warning', ['tasks']],
    ]);
    assert.equal(issues[0]?.hint, 'The world has 2.');
    assert.equal(issues[1]?.hint, 'Only easy, medium.');
  });

  it('reports a missing difficulty even with three or more tasks', () => {
    const tasksOnly = { assign_oldest: task('easy'), solve_vip: task('easy'), rebalance: task('hard') };
    const issues = STAGES.tasks.done(report(world({ tasks: tasksOnly })), plan);
    assert.deepEqual(summary(issues), [['tasks.difficulty_not_spread', 'warning', ['tasks']]]);
    assert.equal(issues[0]?.hint, 'Only easy, hard.');
  });

  it('reports a planned task id missing from the world', () => {
    const w = world({ tasks: { assign_oldest: task('easy'), solve_vip: task('medium'), other: task('hard') } });
    assert.deepEqual(summary(STAGES.tasks.done(report(w), plan)), [['plan.not_covered', 'error', ['plan', 'tasks', 2]]]);
  });
});

describe('stage briefs', () => {
  const expectations = [
    ['model', ['entities', 'routes', 'references']],
    ['workflow', ['actions', 'jobs', 'tests', 'compile']],
    ['seed', ['seed', 'seed layer', 'lints']],
    ['tasks', ['tasks', 'tasks layer', 'easy, medium and hard']],
  ] as const;
  for (const [id, words] of expectations) {
    it(`${id} brief has 2-6 sentences and names its sections and check`, () => {
      const brief = STAGES[id].brief;
      const n = sentences(brief).length;
      assert.ok(n >= 2 && n <= 6, `${id} brief has ${n} sentences`);
      for (const w of words) assert.ok(brief.includes(w), `${id} brief lacks "${w}"`);
    });
  }

  it('plan brief asks for each human question answered as an assumption with why', () => {
    const n = sentences(PLAN_BRIEF).length;
    assert.ok(n >= 2 && n <= 7, `plan brief has ${n} sentences`);
    for (const w of ['question', 'assumptions', 'why', 'plan.yaml', 'open_questions', 'default_answer']) {
      assert.ok(PLAN_BRIEF.includes(w), `plan brief lacks "${w}"`);
    }
  });
});

describe('PLAN_BRIEF feasibility rule (A-143)', () => {
  it('asks whether the request\'s core value is the computation itself, and forbids rescuing it by reinterpretation', () => {
    for (const w of ['core value', 'computation itself', 'never reinterpret', 'feasibleIf', 'job queue']) {
      assert.ok(PLAN_BRIEF.includes(w), `plan brief lacks "${w}"`);
    }
    assert.ok(sentences(PLAN_BRIEF).length <= 7);
  });
});

describe('PLAN_BRIEF rule forms and lifecycle (YOS-155)', () => {
  it('names each rule form by what enforces it, and the workflow lifecycle declaration', () => {
    for (const w of ['{ rule, by, test }', '{ rule, schema }', 'plain text only for context neither enforces', 'lifecycle: { representation: descriptive or removal, reason }']) {
      assert.ok(PLAN_BRIEF.includes(w), `plan brief lacks "${w}"`);
    }
  });

  it('asks a stateMix only of an entity a state field holds, and none of one whose every workflow declares a lifecycle (A-371)', () => {
    for (const w of ['a stateMix giving, per workflow entity whose states a state field holds,', 'none for an entity whose every workflow declares a removal or descriptive lifecycle']) {
      assert.ok(PLAN_BRIEF.includes(w), `plan brief lacks "${w}"`);
    }
  });

  it('the workflow brief makes a rule with by pass the frozen acceptance test it binds', () => {
    assert.ok(STAGES.workflow.brief.includes('must pass the frozen acceptance test it binds'), STAGES.workflow.brief);
    assert.ok(STAGES.workflow.brief.includes('must make that scenario pass'), STAGES.workflow.brief);
  });
});

describe('stagesToRun', () => {
  it('reruns the owner and every reader of routes, but not seed', () => {
    assert.deepEqual(stagesToRun(new Set(['routes'])), ['model', 'workflow', 'tasks']);
  });

  it('reruns seed and tasks when seed changes', () => {
    assert.deepEqual(stagesToRun(new Set(['seed'])), ['seed', 'tasks']);
  });

  it('reruns the readers of fixtures, which code owns', () => {
    assert.deepEqual(stagesToRun(new Set(['fixtures'])), ['model', 'seed']);
  });

  it('runs nothing when nothing changed', () => {
    assert.deepEqual(stagesToRun(new Set()), []);
  });
});

describe('small seeds (A-129)', () => {
  it('the seed brief asks for just over one page on the main entity and a handful elsewhere, because the first call is the time budget', () => {
    assert.ok(STAGES.seed.brief.includes('just over one page'), STAGES.seed.brief);
    assert.ok(STAGES.seed.brief.includes('a handful'), STAGES.seed.brief);
  });
  it('the plan brief asks for a small seed in rowsPerEntity', () => {
    assert.ok(PLAN_BRIEF.includes('small seed'), PLAN_BRIEF);
    assert.ok(PLAN_BRIEF.includes('rowsPerEntity'), PLAN_BRIEF);
  });
});

describe('plan acceptance tests and the seed (A-133)', () => {
  it('the plan brief tells the model its tests create their own rows and never rely on seed rows, because workflow runs them before any seed exists', () => {
    assert.ok(PLAN_BRIEF.includes('never relying on seed rows'), PLAN_BRIEF);
    assert.ok(PLAN_BRIEF.includes('before any seed exists'), PLAN_BRIEF);
  });
});

describe('task pressure from reference traces (A-225..A-227)', () => {
  const status = { type: 'state', states: ['open', 'solved'], initial: 'open', transitions: { open: ['solved'] }, required: true, nullable: false, unique: false, readonly: false };
  const listRoute = { op: 'list', entity: 'ticket', method: 'GET', path: '/tickets', filters: [], search: [], sort: [], pageSize: 25 };
  const traced = (over: Partial<World> = {}): World => world({
    entities: { ticket: { ...entity, fields: { status } }, agent: entity } as unknown as World['entities'],
    routes: { list_tickets: listRoute } as unknown as World['routes'],
    ...over,
  });
  type Trace = { taskId: string; difficulty: 'easy' | 'medium' | 'hard'; solutionRowsChanged: number; solutionLaterPageEntities: string[]; solutionDistractorEntities: string[]; solutionChangedEntities: string[] };
  const v = (taskId: string, difficulty: Trace['difficulty'], rows: number, later: string[] = [], distractors: string[] = [], changed: string[] = ['ticket']): Trace =>
    ({ taskId, difficulty, solutionRowsChanged: rows, solutionLaterPageEntities: later, solutionDistractorEntities: distractors, solutionChangedEntities: changed });
  const withTraces = (w: World, traces: readonly Trace[], stats: Partial<WorldStats> = {}): OkReport =>
    ({ ...report(w, stats), verdicts: Object.fromEntries(traces.map((t) => [t.taskId, t])) }) as unknown as OkReport;
  const pressed = (id: string, pressure: NonNullable<Plan['tasks'][number]['pressure']>): Plan =>
    ({ ...plan, tasks: plan.tasks.map((t) => (t.id === id ? { ...t, pressure } : t)) });

  it('fails a hard label whose reference changes one row and never pages, and keeps an easy one valid', () => {
    const r = withTraces(traced(), [v('assign_oldest', 'easy', 1), v('rebalance', 'hard', 1)]);
    assert.deepEqual(pressureIssues(r, plan).map((i) => [i.code, i.path, i.found]), [
      ['task.difficulty_unproven', ['tasks', 'rebalance'], '1 rows changed, no later page'],
    ]);
  });

  it('accepts a hard task that changes several rows, or one row past the first page', () => {
    assert.deepEqual(pressureIssues(withTraces(traced(), [v('rebalance', 'hard', 3)]), plan), []);
    assert.deepEqual(pressureIssues(withTraces(traced(), [v('rebalance', 'hard', 1, ['ticket'])]), plan), []);
  });

  it('holds a paging task to a row past the first page: the task repairs it when rows span pages, the seed when they fit one', () => {
    const paging = pressed('solve_vip', { paging: 'ticket' });
    const onPageOne = [v('solve_vip', 'medium', 2)];
    assert.deepEqual(pressureIssues(withTraces(traced(), [v('solve_vip', 'medium', 2, ['ticket'])], { rows: { ticket: 60 } }), paging), []);
    assert.deepEqual(pressureIssues(withTraces(traced(), onPageOne, { rows: { ticket: 60 } }), paging).map((i) => [i.code, i.path]), [
      ['task.pressure_unmet', ['tasks', 'solve_vip']],
    ]);
    assert.deepEqual(pressureIssues(withTraces(traced(), onPageOne, { rows: { ticket: 12 } }), paging).map((i) => [i.code, i.path, i.found]), [
      ['task.pressure_unmet', ['seed', 'ticket'], '12 ticket rows fit one 25-row page; seed at least 26'],
    ]);
    assert.deepEqual(pressureIssues(withTraces(traced(), onPageOne, { rows: { ticket: 60 } }), paging).map((i) => i.found), [
      '60 ticket rows over 25-row pages, and the reference changed no row it reached only past the first page',
    ]);
  });

  it('needs seeded rows in each declared state', () => {
    const states = pressed('solve_vip', { states: ['ticket.solved'] });
    const none = withTraces(traced(), [v('solve_vip', 'medium', 2)], { states: { 'ticket.status': { open: 40 } } });
    const some = withTraces(traced(), [v('solve_vip', 'medium', 2)], { states: { 'ticket.status': { open: 40, solved: 3 } } });
    assert.deepEqual(pressureIssues(none, states).map((i) => [i.code, i.path, i.expected, i.found]), [
      ['task.pressure_unmet', ['seed', 'ticket'], 'the pressure task solve_vip declares: state: seeded ticket.solved rows', '0 ticket rows in solved'],
    ]);
    assert.deepEqual(pressureIssues(some, states), []);
  });

  it('needs a near-duplicate row the reference told apart, routed to the seed when missing (YOS-180)', () => {
    const near = pressed('solve_vip', { distractors: 'ticket' });
    assert.deepEqual(pressureIssues(withTraces(traced(), [v('solve_vip', 'medium', 2, [], ['ticket'])]), near), []);
    assert.deepEqual(pressureIssues(withTraces(traced(), [v('solve_vip', 'medium', 2)], { rows: { ticket: 1 } }), near).map((i) => [i.code, i.path, i.expected, i.found]), [
      ['task.pressure_unmet', ['seed', 'ticket'], 'the pressure task solve_vip declares: distractors: a filtered ticket list returns a row the reference leaves unchanged',
        '1 ticket rows seeded; seed at least 2 that one filtered list returns'],
    ]);
    // A-317: once the seed holds two rows, the miss is the reference's filter, so tasks repairs it and no backtrack is spent.
    assert.deepEqual(pressureIssues(withTraces(traced(), [v('solve_vip', 'medium', 2)], { rows: { ticket: 40 } }), near).map((i) => [i.code, i.path, i.found]), [
      ['task.pressure_unmet', ['tasks', 'solve_vip'], '40 ticket rows seeded, and no filtered ticket list in the reference returned a row it left unchanged'],
    ]);
    const imported = traced({ fixtures: { tickets: [{ subject: 'a' }] } as unknown as World['fixtures'] });
    assert.deepEqual(pressureChecks(withTraces(imported, [v('solve_vip', 'medium', 2)]), near).map((c) => [c.met, c.exempt]), [
      [false, 'ticket is imported; the input decides which near-duplicate rows exist, and none were fabricated'],
    ]);
  });

  it('sends a distractor claim on an entity the reference changes no row of to the plan, whatever the seed holds (A-406)', () => {
    // stress-8 helpdesk-sla: assigning a ticket to a named agent changes the ticket; the agent is only looked up.
    const lookup = pressed('solve_vip', { distractors: 'agent' });
    for (const rows of [8, 1]) {
      assert.deepEqual(pressureIssues(withTraces(traced(), [v('solve_vip', 'medium', 2)], { rows: { ticket: 40, agent: rows } }), lookup).map((i) => [i.code, i.path, i.expected, i.found]), [
        ['task.pressure_unmet', ['plan', 'tasks', 1, 'pressure', 'distractors'], 'the pressure task solve_vip declares: distractors: a filtered agent list returns a row the reference leaves unchanged',
          'the reference changes no agent row, so no agent row can be a distractor: a distractor is a near-duplicate of a row the task changes'],
      ]);
    }
    // Once the reference changes an agent row, the claim is the reference's or the seed's again (A-317).
    assert.deepEqual(pressureIssues(withTraces(traced(), [v('solve_vip', 'medium', 2, [], [], ['agent', 'ticket'])], { rows: { agent: 8 } }), lookup).map((i) => [i.code, i.path]), [
      ['task.pressure_unmet', ['tasks', 'solve_vip']],
    ]);
  });

  it('sends a pressed state no state field can hold to the plan at tasks, and checks no seeded rows for it (A-369, YOS-253)', () => {
    const removal = { name: 'ticket_removal', entity: 'ticket', states: ['archived'], rules: [], lifecycle: { representation: 'removal' as const, reason: 'an archived ticket is deleted' }, actions: [] };
    const unmeetable: Plan = { ...pressed('solve_vip', { states: ['ticket.archived'] }), workflows: [...plan.workflows, removal] };
    const r = withTraces(traced(), [v('solve_vip', 'medium', 2)], { states: { 'ticket.status': { open: 40 } } });
    assert.deepEqual(pressureIssues(r, unmeetable).map((i) => [i.code, i.path, i.found]), [
      ['plan.pressure_unreachable', ['plan', 'tasks', 1, 'pressure', 'states', 0], 'ticket.archived is a state only of ticket_removal (lifecycle removal)'],
    ]);
    assert.deepEqual(pressureChecks(r, unmeetable), []);
  });

  it('exempts an imported table instead of padding it, and says why', () => {
    const imported = traced({ fixtures: { tickets: [{ subject: 'a' }] } as unknown as World['fixtures'] });
    const plan2 = pressed('solve_vip', { paging: 'ticket', states: ['ticket.solved'] });
    const r = withTraces(imported, [v('solve_vip', 'medium', 2)], { rows: { ticket: 12 }, states: { 'ticket.status': { open: 12 } } });
    assert.deepEqual(pressureIssues(r, plan2), []);
    assert.deepEqual(pressureChecks(r, plan2).map((c) => [c.need, c.met, c.exempt]), [
      ['paging: reaches a ticket row past the first page', false, 'ticket is imported with 12 rows, which fit on one page; the input sets its size'],
      ['state: seeded ticket.solved rows', false, 'ticket is imported and the input has no solved rows; none were fabricated'],
    ]);
  });
});

describe('what the planned tasks need from the seed, told and checked at the seed step (A-271)', () => {
  const status = { type: 'state', states: ['open', 'solved'], initial: 'open', transitions: { open: ['solved'] }, required: true, nullable: false, unique: false, readonly: false };
  const listRoute = { op: 'list', entity: 'ticket', method: 'GET', path: '/tickets', filters: [], search: [], sort: [], pageSize: 25 };
  const built = world({
    entities: { ticket: { ...entity, fields: { status } }, agent: entity } as unknown as World['entities'],
    routes: { list_tickets: listRoute } as unknown as World['routes'],
  });
  const pressing: Plan = {
    ...plan,
    seed: { rowsPerEntity: { ticket: 12 }, mix: 'mostly open' },
    tasks: plan.tasks.map((t) => (t.id === 'rebalance' ? { ...t, pressure: { paging: 'ticket', states: ['ticket.solved'], distractors: 'ticket' } } : t)),
  };

  it('names each need with its exact number and the task behind it', () => {
    assert.deepEqual(seedNeedLines(seedNeeds(pressing, built)), [
      '- ticket: at least 26 rows, more than one 25-row list page, because task rebalance must reach a ticket row past the first page.',
      '- ticket.solved: at least one row in that state, because task rebalance presses on it.',
      '- ticket: near-duplicate rows for task rebalance: several rows one filtered list returns, of which the task changes only some.',
    ]);
    assert.deepEqual(seedNeeds(plan, built), []);
  });

  it('blocks a seed whose paging entity fits one page or whose pressed state has no rows, with the numbers to fix it', () => {
    const short = STAGES.seed.done(report(built, { rows: { ticket: 12 }, states: { 'ticket.status': { open: 12 } } }), pressing);
    assert.deepEqual(short.map((i) => [i.code, i.path, i.expected, i.found]), [
      ['seed.too_few_rows_for_paging', ['seed', 'ticket'], 'more than 25 ticket rows', '12 rows'],
      ['task.pressure_unmet', ['seed', 'ticket'], 'the pressure task rebalance declares: state: seeded ticket.solved rows', '0 ticket rows in solved'],
    ]);
    assert.deepEqual(STAGES.seed.done(report(built, { rows: { ticket: 30 }, states: { 'ticket.status': { open: 27, solved: 3 } } }), pressing), []);
  });

  it('leaves an entity fed from an input fixture to its input', () => {
    const fed = { ...built, fixtures: { tickets: [{ status: 'open' }] }, seed: { ticket: '(ctx) => ctx.fixture("tickets")' } } as unknown as World;
    assert.deepEqual(seedNeeds(pressing, fed), []);
  });

  it('asks the seed for no row in a state the plan\'s lifecycle keeps out of every state field, and sends the claim to the plan (A-369)', () => {
    const removal = { name: 'ticket_removal', entity: 'ticket', states: ['archived'], rules: [], lifecycle: { representation: 'removal' as const, reason: 'an archived ticket is deleted' }, actions: [] };
    const unmeetable: Plan = { ...pressing, workflows: [...plan.workflows, removal], tasks: plan.tasks.map((t) => (t.id === 'rebalance' ? { ...t, pressure: { states: ['ticket.archived'] } } : t)) };
    assert.deepEqual(seedNeeds(unmeetable, built), []);
    assert.deepEqual(STAGES.seed.done(report(built, { rows: { ticket: 12 }, states: { 'ticket.status': { open: 12 } } }), unmeetable).map((i) => [i.code, i.path, i.found]), [
      ['plan.pressure_unreachable', ['plan', 'tasks', 2, 'pressure', 'states', 0], 'ticket.archived is a state only of ticket_removal (lifecycle removal)'],
    ]);
  });
});

describe('what each task\'s declared pressure asks of its reference, in every tasks prompt (A-316)', () => {
  const listRoute = { op: 'list', entity: 'ticket', method: 'GET', path: '/tickets', filters: ['status', 'agent'], search: [], sort: [], pageSize: 25 };
  const built = (list: Partial<World['meta']['api']['list']> = {}): World => {
    const w = world({ entities: { ticket: entity, agent: entity } as unknown as World['entities'], routes: { list_tickets: listRoute } as unknown as World['routes'] });
    return { ...w, meta: { ...w.meta, api: { ...w.meta.api, list: { ...w.meta.api.list, ...list } } } };
  };
  const pressing: Plan = { ...plan, tasks: plan.tasks.map((t) => (t.id === 'rebalance' ? { ...t, pressure: { paging: 'ticket', distractors: 'ticket', states: ['ticket.open'] } } : t)) };

  it('names the list, page size and next-page parameter of cursor paging, and the filters for distractors', () => {
    assert.deepEqual(taskPressureLines(pressing, built()), [
      "- rebalance, paging ticket: GET /tickets?limit=25, follow cursor=<the page's next_cursor> to a later page, and change a ticket row that appears only there. A list call without cursor is a first page, a filtered one included, so never fetch that row that way.",
      '- rebalance, distractors ticket: call GET /tickets with one of its filters (status, agent) so that it returns a ticket row the task leaves unchanged, and change at least one ticket row. With cursor too, the call still counts as a later page.',
    ]);
    assert.deepEqual(taskPressureLines(plan, built()), []);
  });

  it('uses starting_after in Stripe list mode', () => {
    assert.match(taskPressureLines(pressing, built({ mode: 'stripe' }))[0] ?? '', /follow starting_after=<id of the last row on the page> to a later page.*without starting_after or ending_before is a first page/);
  });
});

