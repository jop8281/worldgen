import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import type { World } from '#engine';
import { z } from 'zod';
import { parsePlanYaml, planCoverage, planSchema, planSchemaFor, pressurePlanIssues, renderPlanYaml, workflowIssues, type Plan } from '../src/worldgen/plan.ts';
import { iteratePlanSchema } from '../src/worldgen/iterate.ts';
import { ownerOf } from '../src/worldgen/policy.ts';

const plan: Plan = {
  revision: 1,
  software: 'Zendesk-style helpdesk',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Tickets with SLA tiers.',
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'ticket', purpose: 'a support request', keyFields: ['status', 'priority'] },
    { name: 'agent', purpose: 'who works tickets', keyFields: ['email'] },
  ],
  workflows: [
    { name: 'triage', entity: 'ticket', states: ['open', 'solved'], rules: ['solved needs an assignee'], actions: ['assign', 'solve'] },
  ],
  jobs: [],
  acceptanceTests: [{
    id: 'solve_ticket',
    intent: 'A ticket can be solved through the public API.',
    actions: ['assign', 'solve'],
    description: 'a ticket can be solved',
    script: "(ctx) => { const r = ctx.api('POST', '/tickets/tk_0001/solve'); ctx.assert(r.status === 200, 'solve failed'); }",
  }],
  routes: [
    { id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse tickets' },
    { id: 'get_ticket', method: 'GET', path: '/tickets/{id}', purpose: 'read one ticket' },
  ],
  seed: { rowsPerEntity: { ticket: 60, agent: 5 }, mix: 'mostly open' },
  tasks: [
    { id: 'assign_oldest', difficulty: 'easy', intent: 'assign the oldest ticket', decoyIdea: 'assigns the newest' },
    { id: 'solve_vip', difficulty: 'medium', intent: 'solve VIP tickets', decoyIdea: 'skips page 2' },
    { id: 'rebalance', difficulty: 'hard', kind: 'investigation', intent: 'rebalance load', actions: ['assign', 'solve'], decoyIdea: 'moves one ticket' },
  ],
  open_questions: [{ question: 'How many SLA tiers?', default_answer: 'two' }],
  assumptions: [{ decision: 'Two SLA tiers', why: 'the input names gold and standard only' }],
  outOfScope: [{ what: 'email intake', why: 'needs a mail server' }],
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
    tests: { solve_ticket: { description: plan.acceptanceTests[0]!.description, script: plan.acceptanceTests[0]!.script } },
    tasks: { assign_oldest: task('easy'), solve_vip: task('medium'), rebalance: task('hard') },
    ...over,
  };
}

const summary = (issues: ReturnType<typeof planCoverage>) => issues.map((i) => [i.code, i.severity, i.path]);

describe('planCoverage', () => {
  it('returns no issues when the world has everything planned', () => {
    assert.deepEqual(planCoverage(plan, world()), []);
  });

  for (const promised of [
    { method: 'DELETE', path: '/tickets', expected: 'the planned route "list_tickets" at DELETE /tickets exists in the world' },
    { method: 'GET', path: '/this-route-does-not-exist', expected: 'the planned route "list_tickets" at GET /this-route-does-not-exist exists in the world' },
    { method: 'DELETE', path: '/this-route-does-not-exist', expected: 'the planned route "list_tickets" at DELETE /this-route-does-not-exist exists in the world' },
  ]) {
    it(`rejects an existing route that does not implement ${promised.method} ${promised.path}`, () => {
      const descriptionPlan = planSchemaFor('description').parse({
        ...plan, seed: { ...plan.seed, stateMix: { ticket: { open: 80, solved: 20 } } }, routes: [{ id: 'list_tickets', method: promised.method, path: promised.path, purpose: 'browse tickets' }],
      });
      const issues = planCoverage(descriptionPlan, world());
      assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['routes', 'list_tickets']]]);
      assert.equal(issues[0]?.expected, promised.expected);
      assert.equal(issues[0]?.found, 'GET /tickets');
      assert.equal(issues[0]?.hint, 'Build what the plan says, or change the plan in the plan step.');
      assert.deepEqual(issues.map(ownerOf), ['model']);
    });
  }

  for (const promised of [
    { method: 'DELETE', path: '/tickets/{id}/solve', expected: 'the planned action "solve" at DELETE /tickets/{id}/solve exists in the world' },
    { method: 'POST', path: '/tickets/{id}/close', expected: 'the planned action "solve" at POST /tickets/{id}/close exists in the world' },
    { method: 'DELETE', path: '/tickets/{id}/close', expected: 'the planned action "solve" at DELETE /tickets/{id}/close exists in the world' },
  ]) {
    it(`rejects a claimed action route that does not implement ${promised.method} ${promised.path}`, () => {
      const actionPlan: Plan = {
        ...plan,
        routes: [{ id: 'solve', method: promised.method, path: promised.path, purpose: 'solve a ticket' }],
        workflows: [{ name: 'resolution', entity: 'ticket', states: [], rules: [], actions: ['solve (POST /tickets/{id}/solve)'] }],
      };
      const issues = planCoverage(actionPlan, world());
      assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['actions', 'solve']]]);
      assert.equal(issues[0]?.expected, promised.expected);
      assert.equal(issues[0]?.found, 'POST /tickets/{id}/solve');
      assert.deepEqual(issues.map(ownerOf), ['workflow']);
    });
  }

  it('names a planned job built as an action, and leaves its repair to workflow (YOS-257, bookmarks)', () => {
    const jobPlan: Plan = { ...plan, jobs: [{ name: 'close_stale', every: '1d', rule: 'close tickets solved a week ago' }] };
    const job = { description: 'close stale tickets', every: '1d', run: '(ctx) => null' };
    assert.deepEqual(planCoverage(jobPlan, world({ jobs: { close_stale: job } })), []);
    const issues = planCoverage(jobPlan, world({ jobs: { close_stale: job }, actions: { ...world().actions, close_stale: action('/maintenance/close_stale') } }));
    assert.deepEqual(summary(issues), [['plan.job_as_action', 'error', ['plan', 'jobs', 0]]]);
    assert.equal(issues[0]?.expected, 'the planned job close_stale only under jobs, with no action of that name');
    assert.equal(issues[0]?.found, 'actions.close_stale');
    assert.equal(issues[0]?.hint, 'Remove actions.close_stale and keep jobs.close_stale. A job runs on the clock, so a test reaches it with ctx.advance and no test calls an action of that name.');
    assert.deepEqual(issues.map(ownerOf), ['workflow']);
  });

  it('accepts a claimed action route only when its method and path match', () => {
    const actionPlan: Plan = { ...plan, routes: [{ id: 'solve', method: 'POST', path: '/tickets/{id}/solve', purpose: 'solve a ticket' }] };
    assert.deepEqual(planCoverage(actionPlan, world()), []);
  });

  // stress-6 stripe-charges (YOS-258): the plan said GET /v1/charges/{charge}, the model built GET /v1/charges/{id}.
  it('accepts a planned route or claimed action whose path names its params differently', () => {
    const renamed: Plan = { ...plan, routes: [
      { id: 'get_ticket', method: 'GET', path: '/tickets/{ticket}', purpose: 'read one ticket' },
      { id: 'solve', method: 'POST', path: '/tickets/{ticket_id}/solve', purpose: 'solve a ticket' },
    ] };
    assert.deepEqual(planCoverage(renamed, world()), []);
  });

  it('still rejects a renamed param path whose literal segments differ', () => {
    const renamed: Plan = { ...plan, routes: [{ id: 'get_ticket', method: 'GET', path: '/ticket/{ticket}', purpose: 'read one ticket' }] };
    const issues = planCoverage(renamed, world());
    assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['routes', 'get_ticket']]]);
    assert.equal(issues[0]?.expected, 'the planned route "get_ticket" at GET /ticket/{ticket} exists in the world');
    assert.equal(issues[0]?.found, 'GET /tickets/{id}');
  });

  it('reports a missing claimed action once and assigns its repair to workflow', () => {
    const actionPlan: Plan = { ...plan, routes: [{ id: 'solve', method: 'POST', path: '/tickets/{id}/solve', purpose: 'solve a ticket' }] };
    const issues = planCoverage(actionPlan, world({ actions: { assign: action('/tickets/{id}/assign') } }));
    assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['plan', 'workflows', 0, 'actions', 1]]]);
    assert.equal(issues[0]?.found, 'no actions.solve');
    assert.deepEqual(issues.map(ownerOf), ['workflow']);
  });

  it('reports a missing planned entity at its plan path', () => {
    const issues = planCoverage(plan, world({ entities: { ticket: entity } }));
    assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['plan', 'entities', 1]]]);
    assert.equal(issues[0]?.expected, 'the planned entity "agent" exists in the world');
    assert.equal(issues[0]?.found, 'no entities.agent');
  });

  it('reports a missing planned route at its plan path', () => {
    const issues = planCoverage(plan, world({ routes: { get_ticket: route('/tickets/{id}') } }));
    assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['plan', 'routes', 0]]]);
    assert.equal(issues[0]?.expected, 'the planned route "list_tickets" exists in the world');
  });

  it('reports a missing workflow action at its plan path', () => {
    const issues = planCoverage(plan, world({ actions: { assign: action('/tickets/{id}/assign') } }));
    assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['plan', 'workflows', 0, 'actions', 1]]]);
    assert.equal(issues[0]?.expected, 'the planned action "solve" exists in the world');
  });

  it('reports a missing planned task at its plan path', () => {
    const issues = planCoverage(plan, world({ tasks: { assign_oldest: task('easy'), solve_vip: task('medium') } }));
    assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['plan', 'tasks', 2]]]);
    assert.equal(issues[0]?.expected, 'the planned task "rebalance" exists in the world');
  });

  it('reports a planned job missing from world.jobs at its plan path', () => {
    const withJob: Plan = { ...plan, jobs: [{ name: 'sla_breach', every: '1h', rule: 'escalate overdue tickets' }] };
    const issues = planCoverage(withJob, world());
    assert.deepEqual(summary(issues), [['plan.not_covered', 'error', ['plan', 'jobs', 0]]]);
    assert.equal(issues[0]?.expected, 'the planned job "sla_breach" exists in the world');
    assert.equal(issues[0]?.found, 'no jobs.sla_breach');
  });

  it('accepts a planned job that the world has', () => {
    const withJob: Plan = { ...plan, jobs: [{ name: 'sla_breach', every: '1h', rule: 'escalate overdue tickets' }] };
    const job = { description: 'flags overdue tickets', every: '1h', run: '(ctx) => null' };
    assert.deepEqual(planCoverage(withJob, world({ jobs: { sla_breach: job } } )), []);
  });

  it('reports every gap in plan order on an empty world', () => {
    const issues = planCoverage(plan, world({ entities: {}, routes: {}, actions: {}, tasks: {} }));
    assert.deepEqual(
      issues.map((i) => i.path),
      [
        ['plan', 'entities', 0],
        ['plan', 'entities', 1],
        ['plan', 'routes', 0],
        ['plan', 'routes', 1],
        ['plan', 'workflows', 0, 'actions', 0],
        ['plan', 'workflows', 0, 'actions', 1],
        ['plan', 'tasks', 0],
        ['plan', 'tasks', 1],
        ['plan', 'tasks', 2],
      ],
    );
  });
});

const EXPECTED_YAML = `revision: 1
software: Zendesk-style helpdesk
summary: Tickets with SLA tiers.
clock:
  start: 2026-01-05T09:00:00.000Z
  tick: 0s
verdict:
  kind: proceed
entities:
  - name: ticket
    purpose: a support request
    keyFields:
      - status
      - priority
  - name: agent
    purpose: who works tickets
    keyFields:
      - email
workflows:
  - name: triage
    entity: ticket
    states:
      - open
      - solved
    rules:
      - solved needs an assignee
    actions:
      - assign
      - solve
jobs: []
acceptanceTests:
  - id: solve_ticket
    intent: A ticket can be solved through the public API.
    actions:
      - assign
      - solve
    description: a ticket can be solved
    script: (ctx) => { const r = ctx.api('POST', '/tickets/tk_0001/solve'); ctx.assert(r.status === 200, 'solve failed'); }
routes:
  - id: list_tickets
    method: GET
    path: /tickets
    purpose: browse tickets
  - id: get_ticket
    method: GET
    path: /tickets/{id}
    purpose: read one ticket
seed:
  rowsPerEntity:
    ticket: 60
    agent: 5
  mix: mostly open
tasks:
  - id: assign_oldest
    difficulty: easy
    intent: assign the oldest ticket
    decoyIdea: assigns the newest
  - id: solve_vip
    difficulty: medium
    intent: solve VIP tickets
    decoyIdea: skips page 2
  - id: rebalance
    difficulty: hard
    kind: investigation
    intent: rebalance load
    actions:
      - assign
      - solve
    decoyIdea: moves one ticket
open_questions:
  - question: How many SLA tiers?
    default_answer: two
assumptions:
  - decision: Two SLA tiers
    why: the input names gold and standard only
outOfScope:
  - what: email intake
    why: needs a mail server
changes: []
`;

describe('renderPlanYaml', () => {
  it('renders assumptions and outOfScope as readable lists', () => {
    assert.equal(renderPlanYaml(plan), EXPECTED_YAML);
  });

  it('renders the same text whatever order the plan keys arrive in', () => {
    const inner: Partial<Plan> = {
      outOfScope: [{ why: 'needs a mail server', what: 'email intake' }],
      assumptions: [{ why: 'the input names gold and standard only', decision: 'Two SLA tiers' }],
    };
    const shuffled = Object.fromEntries([...Object.entries({ ...plan, ...inner })].reverse()) as Plan;
    assert.deepEqual(Object.keys(shuffled).slice(0, 2), ['changes', 'outOfScope']);
    assert.equal(renderPlanYaml(shuffled), EXPECTED_YAML);
  });

  it('parses back through planSchema to the same plan', () => {
    assert.deepEqual(planSchema.parse(parse(renderPlanYaml(plan))), plan);
  });

  it('keeps a refusal reason and a long assumption on readable lines', () => {
    const refused: Plan = {
      ...plan,
      verdict: { kind: 'refuse', why: 'the input is a malware C2 panel' },
      assumptions: [
        {
          decision: 'Q: Do tickets ever reopen after they are solved? A: Yes, a customer reply reopens a solved ticket within 7 days',
          why: 'helpdesks commonly reopen on reply',
        },
      ],
    };
    const text = renderPlanYaml(refused);
    assert.ok(text.includes('verdict:\n  kind: refuse\n  why: the input is a malware C2 panel\n'));
    assert.ok(
      text.includes(
        "assumptions:\n  - decision: 'Q: Do tickets ever reopen after they are solved? A: Yes, a customer reply reopens a solved ticket within 7 days'\n    why: helpdesks commonly reopen on reply\n",
      ),
    );
  });
});

const refusal = {
  software: 'C2 panel',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'refused',
  verdict: { kind: 'refuse', why: 'malware command and control' },
  entities: [],
  workflows: [],
  routes: [],
  seed: { rowsPerEntity: {}, mix: '' },
  tasks: [],
  assumptions: [],
  outOfScope: [],
};

describe('plan clock', () => {
  it('requires an explicit start and validates start and tick with the world schema', () => {
    const { clock: _clock, ...missing } = plan;
    assert.equal(planSchema.safeParse(missing).success, false);
    assert.equal(planSchema.safeParse({ ...plan, clock: { start: 'yesterday', tick: '0s' } }).success, false);
    assert.equal(planSchema.safeParse({ ...plan, clock: { start: '2026-04-01T09:00:00.000Z', tick: '-1h' } }).success, false);
    const chosen = { start: '2026-04-01T09:00:00.000Z', tick: '1s' };
    assert.deepEqual(planSchema.parse({ ...plan, clock: chosen }).clock, chosen);
  });
});

describe('planSchema verdicts', () => {
  it('accepts a refusal with no workflows and no tasks', () => {
    const r = planSchema.safeParse(refusal);
    assert.equal(r.success, true);
    assert.deepEqual(r.data?.verdict, { kind: 'refuse', why: 'malware command and control' });
    assert.deepEqual(r.data?.jobs, []);
  });

  it('still demands a workflow and three tasks for a proceed verdict', () => {
    const built = { ...refusal, verdict: { kind: 'proceed' } };
    assert.equal(planSchema.safeParse(built).success, false);
    assert.equal(planSchema.safeParse({ ...plan, workflows: [] }).success, false);
    assert.equal(planSchema.safeParse({ ...plan, tasks: plan.tasks.slice(0, 2) }).success, false);
    assert.equal(planSchema.safeParse(plan).success, true);
  });

  it('rejects a refusal without a reason or with an unknown verdict kind', () => {
    assert.equal(planSchema.safeParse({ ...refusal, verdict: { kind: 'maybe' } }).success, false);
    assert.equal(planSchema.safeParse({ ...refusal, verdict: { kind: 'refuse' } }).success, false);
  });
});

describe('planSchema rule links and stateMix (A-155)', () => {
  const triage = plan.workflows[0]!;
  const withRules = (rules: Plan['workflows'][number]['rules']): unknown => ({ ...plan, workflows: [{ ...triage, rules }] });
  const messages = (input: unknown): string[] => {
    const r = planSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts text rules, and rules linked to a workflow action or a planned job', () => {
    assert.deepEqual(messages(withRules(['solved needs an assignee', { rule: 'solving stamps solved_at', by: ['solve (POST /tickets/{id}/solve)'], test: 'solve_ticket' }])), []);
    assert.deepEqual(messages({ ...(withRules([{ rule: 'stale tickets close', by: ['auto_close'], test: 'solve_ticket' }]) as Plan), jobs: [{ name: 'auto_close', every: '1h', rule: 'close stale tickets' }] }), []);
  });

  it('rejects a rule linked to a key that is no workflow action or job', () => {
    assert.deepEqual(messages(withRules([{ rule: 'stale tickets close', by: ['auto_close'], test: 'solve_ticket' }])), ['rule of triage names auto_close, which is no workflow action or job']);
  });

  it('accepts a stateMix over planned states that sums to 100, and rejects other entities, states and sums', () => {
    const mix = (stateMix: Record<string, Record<string, number>>): unknown => ({ ...plan, seed: { ...plan.seed, stateMix } });
    assert.deepEqual(messages(mix({ ticket: { open: 70, solved: 30 } })), []);
    assert.deepEqual(messages(mix({ agent: { active: 100 } })), ['stateMix names agent, which is no workflow entity']);
    assert.deepEqual(messages(mix({ ticket: { open: 70, closed: 30 } })), ['stateMix names closed, which is no planned state of ticket']);
    assert.deepEqual(messages(mix({ ticket: { open: 70, solved: 20 } })), ['stateMix shares of ticket sum to 90, not 100']);
  });

  it('renders a linked rule and a stateMix to plan.yaml and parses them back', () => {
    const linked: Plan = { ...plan, workflows: [{ ...triage, rules: ['solved is final', { rule: 'solving stamps solved_at', by: ['solve'], test: 'solve_ticket' }] }], seed: { ...plan.seed, stateMix: { ticket: { open: 70, solved: 30 } } } };
    const text = renderPlanYaml(linked);
    assert.equal(text.includes("      - solved is final\n      - rule: solving stamps solved_at\n        by:\n          - solve\n        test: solve_ticket\n"), true);
    assert.equal(text.includes('  stateMix:\n    ticket:\n      open: 70\n      solved: 30\n'), true);
    assert.deepEqual(planSchema.parse(parse(text)), linked);
    assert.equal(renderPlanYaml(plan).includes('stateMix'), false);
  });
});

describe('planSchema rule bindings and lifecycle (YOS-155)', () => {
  const triage = plan.workflows[0]!;
  const findings = (input: unknown): { message: string; path: PropertyKey[] }[] => {
    const r = planSchema.safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => ({ message: i.message, path: i.path }));
  };
  const withRules = (rules: unknown): Record<string, unknown> => ({ ...plan, workflows: [{ ...triage, rules }] });
  const withLifecycle = (lifecycle: unknown): Record<string, unknown> => ({ ...plan, workflows: [{ ...triage, lifecycle }] });

  it('accepts a plain text rule, a schema rule and a bound behavioral rule together', () => {
    assert.deepEqual(findings(withRules([
      'solved is final',
      { rule: 'a ticket key is unique', schema: 'the engine assigns ids and rejects a duplicate key' },
      { rule: 'solving stamps solved_at', by: ['solve'], test: 'solve_ticket' },
    ])), []);
  });

  it('rejects a behavioral rule without its test binding, at the rule path', () => {
    const r = planSchema.safeParse(withRules([{ rule: 'solving stamps solved_at', by: ['solve'] }]));
    assert.equal(r.success, false);
    assert.deepEqual(JSON.parse(JSON.stringify(r.error?.issues)), [{
      code: 'invalid_union',
      path: ['workflows', 0, 'rules', 0],
      message: 'Invalid input',
      errors: [
        [{ expected: 'string', code: 'invalid_type', path: [], message: 'Invalid input: expected string, received object' }],
        [{ expected: 'string', code: 'invalid_type', path: ['test'], message: 'Invalid input: expected string, received undefined' }],
        [{ expected: 'string', code: 'invalid_type', path: ['schema'], message: 'Invalid input: expected string, received undefined' }],
      ],
    }]);
  });

  it('rejects a rule bound to a test id that is no acceptance test', () => {
    assert.deepEqual(findings(withRules([{ rule: 'solving stamps solved_at', by: ['solve'], test: 'solve_a_ticket' }])), [{
      message: 'rule of triage binds test solve_a_ticket, which is no acceptance test id',
      path: ['workflows', 0, 'rules', 0, 'test'],
    }]);
  });

  it('rejects a second rule that binds a test another rule already binds, naming it', () => {
    const boundTwice: unknown = {
      ...plan,
      workflows: [
        { ...triage, rules: [{ rule: 'solving stamps solved_at', by: ['solve'], test: 'solve_ticket' }] },
        { name: 'assignment', entity: 'ticket', states: ['open', 'solved'], rules: [{ rule: 'assigning stamps assigned_at', by: ['assign'], test: 'solve_ticket' }], actions: [] },
      ],
    };
    assert.deepEqual(findings(boundTwice), [{
      message: 'rule of assignment binds test solve_ticket, which the rule "solving stamps solved_at" of workflow triage already binds',
      path: ['workflows', 1, 'rules', 0, 'test'],
    }]);
  });

  it('rejects a bound test that names no enforcing action of the rule, and one whose script never calls ctx.api', () => {
    const notNaming: unknown = {
      ...withRules([{ rule: 'solving stamps solved_at', by: ['solve'], test: 'solve_ticket' }]),
      acceptanceTests: [{ ...plan.acceptanceTests[0]!, actions: ['assign'] }],
    };
    assert.deepEqual(findings(notNaming), [{
      message: 'rule of triage binds test solve_ticket, which does not exercise its enforcing action solve: the test must name one of them in its actions and call it through ctx.api in its script',
      path: ['workflows', 0, 'rules', 0, 'test'],
    }]);
    const notCalling: unknown = {
      ...withRules([{ rule: 'solving stamps solved_at', by: ['solve'], test: 'solve_ticket' }]),
      acceptanceTests: [{ ...plan.acceptanceTests[0]!, script: "(ctx) => { ctx.assert(true, 'no api call'); }" }],
    };
    assert.deepEqual(findings(notCalling), [{
      message: 'rule of triage binds test solve_ticket, which does not exercise its enforcing action solve: the test must name one of them in its actions and call it through ctx.api in its script',
      path: ['workflows', 0, 'rules', 0, 'test'],
    }]);
  });

  it('accepts a behavioral rule whose by names only a planned job: no action to exercise', () => {
    const byJob: unknown = {
      ...withRules([{ rule: 'stale tickets close', by: ['auto_close'], test: 'solve_ticket' }]),
      jobs: [{ name: 'auto_close', every: '1h', rule: 'close stale tickets' }],
    };
    assert.deepEqual(findings(byJob), []);
  });

  it('rejects a lifecycle representation outside the enum, and a blank reason', () => {
    assert.deepEqual(findings(withLifecycle({ representation: 'derived', reason: 'the states are a derived flag' })), [{
      message: 'Invalid option: expected one of "descriptive"|"removal"',
      path: ['workflows', 0, 'lifecycle', 'representation'],
    }]);
    assert.deepEqual(findings(withLifecycle({ representation: 'descriptive', reason: '' })), [{
      message: 'Too small: expected string to have >=1 characters',
      path: ['workflows', 0, 'lifecycle', 'reason'],
    }]);
    assert.deepEqual(findings(withLifecycle({ representation: 'removal', reason: 'rows are deleted rather than moved to a state' })), []);
  });

  it('renders a bound behavioral rule, a schema rule and a lifecycle to plan.yaml and parses them back', () => {
    const bound: Plan = {
      ...plan,
      workflows: [{
        ...triage,
        rules: [
          'solved is final',
          { rule: 'solving stamps solved_at', by: ['solve'], test: 'solve_ticket' },
          { rule: 'a ticket key is unique', schema: 'the engine assigns ids and rejects a duplicate key' },
        ],
        lifecycle: { representation: 'descriptive', reason: 'sla flags are derived, not states' },
      }],
    };
    const text = renderPlanYaml(bound);
    assert.equal(text.includes(
      '    rules:\n      - solved is final\n      - rule: solving stamps solved_at\n        by:\n          - solve\n        test: solve_ticket\n' +
      '      - rule: a ticket key is unique\n        schema: the engine assigns ids and rejects a duplicate key\n' +
      '    lifecycle:\n      representation: descriptive\n      reason: sla flags are derived, not states\n',
    ), true);
    assert.deepEqual(planSchema.parse(parse(text)), bound);
    assert.equal(renderPlanYaml(plan).includes('lifecycle:'), false);
  });
});

describe('workflowIssues lifecycles (YOS-155)', () => {
  const statusField = (states: readonly string[]) => ({
    type: 'state' as const, states: [...states], initial: states[0]!, transitions: {},
    required: false, nullable: false, unique: false, readonly: false,
  });
  const machineOnTicket = (states: readonly string[]): World =>
    world({ entities: { ticket: { ...entity, fields: { status: statusField(states) } }, agent: entity } });

  it('mints plan.lifecycle_unrepresented for a workflow whose entity holds only another workflow\'s machine, and routes it to plan', () => {
    const issues = workflowIssues(plan, machineOnTicket(['new', 'closed']));
    assert.deepEqual(issues.map((i) => [i.code, i.severity, i.path]), [
      ['plan.lifecycle_unrepresented', 'error', ['plan', 'workflows', 0, 'lifecycle']],
    ]);
    assert.equal(issues[0]?.expected, 'every state of triage declared in a state field of ticket, or an explicit lifecycle representation on the workflow');
    assert.equal(issues[0]?.found, 'no state field of ticket declares any state of this workflow');
    assert.equal(issues[0]?.hint, 'Declare these states in a state machine of ticket, or add lifecycle: { representation: descriptive|removal, reason } to this workflow in the plan step.');
    assert.deepEqual(issues.map(ownerOf), ['plan']);
  });

  it('still judges a workflow whose machine declares its states', () => {
    assert.deepEqual(workflowIssues(plan, machineOnTicket(['open', 'solved'])), []);
  });

  it('exempts a workflow that declares a lifecycle from plan.lifecycle_unrepresented', () => {
    const descriptive: Plan = { ...plan, workflows: [{ ...plan.workflows[0]!, lifecycle: { representation: 'descriptive', reason: 'sla flags are derived, not states' } }] };
    assert.deepEqual(workflowIssues(descriptive, machineOnTicket(['new', 'closed'])), []);
  });

  it('exempts a workflow that declares a removal lifecycle from plan.state_field_missing, which still mints without it (A-183)', () => {
    const removal: Plan = { ...plan, workflows: [{ ...plan.workflows[0]!, lifecycle: { representation: 'removal', reason: 'rows are deleted rather than moved to a state' } }] };
    assert.deepEqual(workflowIssues(removal, world()), []);
    assert.deepEqual(workflowIssues(plan, world()).map((i) => [i.code, i.path]), [['plan.state_field_missing', ['entities', 'ticket']]]);
  });
});

describe('planSchema JSON Schema', () => {
  it('has an object root so it can be a model tool input_schema', () => {
    assert.equal(z.toJSONSchema(planSchema, { io: 'input' }).type, 'object');
  });
});

describe('acceptance test actions are declared workflow actions (YOS-53)', () => {
  it('names the undeclared action and both ways to fix it', () => {
    const undeclared: unknown = { ...plan, acceptanceTests: [{ ...plan.acceptanceTests[0]!, actions: ['assign', 'create_ticket'] }] };
    const r = planSchema.safeParse(undeclared);
    assert.deepEqual(r.success ? [] : r.error.issues.map((i) => ({ message: i.message, path: i.path })), [{
      message: 'acceptance test solve_ticket names create_ticket, which no workflow declares in its actions: add create_ticket to the actions of the workflow it belongs to, or name an action a workflow declares',
      path: ['acceptanceTests', 0, 'actions'],
    }]);
  });
  it('refuses a plan job listed as a workflow action or a test action in a proposal, but still loads an older plan that does (YOS-257, YOS-274)', () => {
    const doubled: unknown = {
      ...plan,
      seed: { ...plan.seed, stateMix: { ticket: { open: 80, solved: 20 } } },
      workflows: [{ ...plan.workflows[0]!, actions: ['assign', 'solve', 'close_stale'] }],
      jobs: [{ name: 'close_stale', every: '1d', rule: 'close tickets solved a week ago' }],
      acceptanceTests: [{ ...plan.acceptanceTests[0]!, actions: ['assign', 'solve', 'close_stale'] }],
    };
    const loaded = planSchema.safeParse(doubled);
    assert.equal(loaded.success, true);
    assert.notEqual(parsePlanYaml(renderPlanYaml(planSchema.parse(doubled))), null);
    const jobIssues = [{
      message: "workflow triage lists close_stale in its actions, but close_stale is a job: a job runs on the clock, so list it only under jobs and in a rule's by, and let the test call the workflow action that sets up the job's rows through ctx.api, name that action in its actions, then reach the job with ctx.advance",
      path: ['workflows', 0, 'actions', 2],
    }, {
      message: "acceptance test solve_ticket names close_stale in its actions, but close_stale is a job: a job runs on the clock, so list it only under jobs and in a rule's by, and let the test call the workflow action that sets up the job's rows through ctx.api, name that action in its actions, then reach the job with ctx.advance",
      path: ['acceptanceTests', 0, 'actions'],
    }];
    const created = planSchemaFor('description').safeParse(doubled);
    assert.deepEqual(created.success ? [] : created.error.issues.map((i) => ({ message: i.message, path: i.path })), jobIssues);
    const iterated = iteratePlanSchema(world({ meta: { ...meta, clock: plan.clock } }), null).safeParse(doubled);
    assert.deepEqual(iterated.success ? [] : iterated.error.issues.map((i) => ({ message: i.message, path: i.path })), jobIssues);
  });
  it('accepts the fixed shape: the job only under jobs and a rule\'s by, its test naming the action that sets it up (YOS-257)', () => {
    const fixed: unknown = {
      ...plan,
      workflows: [{ ...plan.workflows[0]!, rules: [{ rule: 'solved tickets close after a week', by: ['close_stale'], test: 'close_stale_week' }] }],
      jobs: [{ name: 'close_stale', every: '1d', rule: 'close tickets solved a week ago' }],
      acceptanceTests: [...plan.acceptanceTests, {
        id: 'close_stale_week',
        intent: 'A solved ticket closes a week later.',
        actions: ['solve'],
        description: 'solve a ticket, advance eight days, it is closed',
        script: "(ctx) => { ctx.api('POST', '/tickets/tk_0001/solve'); ctx.advance('8d'); ctx.assert(ctx.api('GET', '/tickets/tk_0001').body.status === 'closed', 'not closed'); }",
      }],
    };
    const r = planSchema.safeParse(fixed);
    assert.deepEqual(r.success ? [] : r.error.issues.map((i) => i.message), []);
  });
  it('tells the model in the tool schema that a test names only declared workflow actions', () => {
    const json = JSON.stringify(z.toJSONSchema(planSchema, { io: 'input' }));
    assert.ok(json.includes('"description":"the workflow actions this test exercises, each one declared in the actions of a workflow above; to test an operation such as create_customer, declare it in its workflow\'s actions first"'));
  });
});

describe('task variety in a proposed plan (A-390, A-405)', () => {
  const HARD_KIND = 'hard task rebalance needs a hard kind, one of time_sensitive, policy_conflict, investigation, misleading_text, irreversible: a hard task is hard for what it asks an agent to notice, not for its size';
  const HARD = 'a plan to build needs at least one hard task whose actions name 2 or more distinct workflow actions its reference solution calls, such as one that assigns a row and then resolves it';
  const built: Plan = { ...plan, seed: { ...plan.seed, stateMix: { ticket: { open: 80, solved: 20 } } } };
  const withTasks = (tasks: Plan['tasks']): Plan => ({ ...built, tasks });
  const [easy, medium, hard] = plan.tasks as [Plan['tasks'][number], Plan['tasks'][number], Plan['tasks'][number]];
  const plain = (t: Plan['tasks'][number]) => ({ id: t.id, difficulty: t.difficulty, intent: t.intent, decoyIdea: t.decoyIdea });
  const issuesOf = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: readonly { message: string; path: readonly PropertyKey[] }[] } } }, value: unknown) => {
    const r = schema.safeParse(value);
    return r.success ? [] : (r.error?.issues ?? []).map((i) => [i.path.join('.'), i.message]);
  };
  const rows: [string, Plan, string[][]][] = [
    ['a hard kind and a hard task naming two actions', built, []],
    ['the hard task has no kind', withTasks([easy, medium, { ...hard, kind: undefined }]), [['tasks.2.kind', HARD_KIND]]],
    ['the hard task has a kind that is not a hard one', withTasks([easy, medium, { ...hard, kind: 'scarce_resource' }]), [['tasks.2.kind', HARD_KIND]]],
    ['the hard task with another hard kind', withTasks([easy, { ...medium, kind: 'two_actors' }, { ...hard, kind: 'misleading_text' }]), []],
    ['an easy or medium task needs no hard kind', withTasks([{ ...easy, kind: 'permissions' }, plain(medium), hard]), []],
    ['the hard task names one action', withTasks([easy, medium, { ...hard, actions: ['assign'] }]), [['tasks', HARD]]],
    ['the hard task names one action twice', withTasks([easy, medium, { ...hard, actions: ['assign', 'assign (POST /tickets/{id}/assign)'] }]), [['tasks', HARD]]],
    ['only a medium task names two actions', withTasks([easy, { ...medium, actions: ['assign', 'solve'] }, { ...hard, actions: undefined }]), [['tasks', HARD]]],
    ['a task names an undeclared action', withTasks([easy, medium, { ...hard, actions: ['assign', 'refund'] }]),
      [['tasks.2.actions.1', 'task rebalance names refund in its actions, which no workflow declares in its actions'], ['tasks', HARD]]],
    ['a plan written before A-390', withTasks([plain(easy), plain(medium), plain(hard)]), [['tasks', HARD], ['tasks.2.kind', HARD_KIND]]],
  ];
  for (const [name, value, want] of rows) {
    it(`a create plan: ${name}`, () => assert.deepEqual(issuesOf(planSchemaFor('description'), value), want));
  }

  it('leaves a refusal, the base schema and parsePlanYaml alone, so a committed plan still loads', () => {
    const before = withTasks([plain(easy), plain(medium), plain(hard)]);
    assert.deepEqual(issuesOf(planSchemaFor('description'), { ...before, verdict: { kind: 'refuse', why: 'harmful' }, workflows: [], tasks: [] }), []);
    assert.deepEqual(issuesOf(planSchema, before), []);
    assert.notEqual(parsePlanYaml(renderPlanYaml(before)), null);
  });

  it('on iterate, keeps each existing task\'s kind and actions unless changes names the task, and checks action names', () => {
    const w = world({ meta: { ...meta, clock: plan.clock } });
    const dropped = withTasks([easy, medium, plain(hard)]);
    assert.deepEqual(issuesOf(iteratePlanSchema(w, built), dropped),
      [['tasks.2', 'task rebalance changes its kind and actions from the existing plan: keep them as the existing plan has them, or name tasks.rebalance in changes']]);
    assert.deepEqual(issuesOf(iteratePlanSchema(w, built), withTasks([easy, medium, { ...hard, actions: ['solve', 'assign'] }])),
      [['tasks.2', 'task rebalance changes its actions from the existing plan: keep it as the existing plan has it, or name tasks.rebalance in changes']]);
    assert.deepEqual(issuesOf(iteratePlanSchema(w, built), { ...dropped, changes: ['tasks.rebalance because the request drops the second action'] }), []);
    assert.deepEqual(issuesOf(iteratePlanSchema(w, built), withTasks([easy, medium, hard, { ...plain(medium), id: 'new_one' }])), []);
    assert.deepEqual(issuesOf(iteratePlanSchema(w, dropped), dropped), []);
    assert.deepEqual(issuesOf(iteratePlanSchema(w, null), withTasks([easy, medium, { ...hard, actions: ['refund'] }])),
      [['tasks.2.actions.0', 'task rebalance names refund in its actions, which no workflow declares in its actions']]);
  });
});

describe('planSchemaFor', () => {
  // A built plan needs a stateMix for each workflow entity (A-183), which the shared fixture leaves out.
  const built: Plan = { ...plan, seed: { ...plan.seed, stateMix: { ticket: { open: 80, solved: 20 } } } };

  it('requires an assumption on a built plan from a description', () => {
    const r = planSchemaFor('description').safeParse({ ...built, assumptions: [] });
    assert.equal(r.success, false);
    assert.deepEqual(r.error?.issues.map((i) => i.path), [['assumptions']]);
  });

  it('accepts a built description plan that records an assumption', () => {
    assert.equal(planSchemaFor('description').safeParse(built).success, true);
  });

  it('requires an assumption on a built openapi or csv plan too, but not on a refusal (A-180)', () => {
    assert.deepEqual(planSchemaFor('openapi').safeParse({ ...built, assumptions: [] }).error?.issues.map((i) => i.path), [['assumptions']]);
    assert.deepEqual(planSchemaFor('csv').safeParse({ ...built, assumptions: [] }).error?.issues.map((i) => i.path), [['assumptions']]);
    assert.equal(planSchemaFor('description').safeParse(refusal).success, true);
  });

  it('round-trips open_questions through plan.yaml', () => {
    const parsed = planSchema.parse(parse(renderPlanYaml(plan)));
    assert.deepEqual(parsed.open_questions, [{ question: 'How many SLA tiers?', default_answer: 'two' }]);
  });
});

describe('planSchemaFor asks a stateMix only of an entity whose states a state field holds (A-371, YOS-253)', () => {
  const built: Plan = { ...plan, seed: { ...plan.seed, stateMix: { ticket: { open: 80, solved: 20 } } } };
  const lifecycle = (representation: 'removal' | 'descriptive') => ({
    name: 'agent_lifecycle', entity: 'agent', states: ['active', 'deleted'], rules: [], actions: [],
    lifecycle: { representation, reason: representation === 'removal' ? 'a deleted agent is removed from the store' : 'active is a derived flag' },
  });
  const held = { name: 'agent_status', entity: 'agent', states: ['active', 'away'], rules: [], actions: [] };
  const issues = (input: unknown): unknown[] => {
    const r = planSchemaFor('description').safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => [i.path, i.message]);
  };
  const needsAgentMix = [['seed', 'stateMix', 'agent'], 'a plan to build needs seed.stateMix for workflow entity agent, whose states a state field holds: the percent of its rows in each planned state, summing to 100'];

  it('parses an entity whose only workflow declares a removal or descriptive lifecycle, with no stateMix for it', () => {
    assert.deepEqual(issues({ ...built, workflows: [...built.workflows, lifecycle('removal')] }), []);
    assert.deepEqual(issues({ ...built, workflows: [...built.workflows, lifecycle('descriptive')] }), []);
  });

  it('still requires a stateMix for an entity once a workflow without a lifecycle puts its states in a state field', () => {
    assert.deepEqual(issues({ ...built, workflows: [...built.workflows, held] }), [needsAgentMix]);
    assert.deepEqual(issues({ ...built, workflows: [...built.workflows, lifecycle('removal'), held] }), [needsAgentMix]);
    assert.deepEqual(issues(plan), [
      [['seed', 'stateMix', 'ticket'], 'a plan to build needs seed.stateMix for workflow entity ticket, whose states a state field holds: the percent of its rows in each planned state, summing to 100'],
    ]);
  });

  it('still accepts a stateMix that a plan gives a removal-lifecycle entity, as stripe-customers\' plan did', () => {
    const given = { ...built, workflows: [...built.workflows, lifecycle('removal')], seed: { ...built.seed, stateMix: { ...built.seed.stateMix, agent: { active: 100 } } } };
    assert.deepEqual(issues(given), []);
  });
});

describe('task pressure in the plan (A-226, A-227)', () => {
  const withPressure = (pressure: NonNullable<Plan['tasks'][number]['pressure']>): unknown =>
    ({ ...plan, tasks: plan.tasks.map((t, i) => (i === 0 ? { ...t, pressure } : t)) });

  it('refuses a paging entity or a pressure state the plan does not have', () => {
    const r = planSchema.safeParse(withPressure({ paging: 'invoice', states: ['ticket.closed', 'ticket'] }));
    assert.deepEqual(r.error?.issues.map((i) => [i.path, i.message]), [
      [['tasks', 0, 'pressure', 'paging'], 'pressure.paging names invoice, which is no planned entity'],
      [['tasks', 0, 'pressure', 'states', 0], 'pressure state ticket.closed is not entity.state of a planned workflow'],
      [['tasks', 0, 'pressure', 'states', 1], 'pressure state ticket is not entity.state of a planned workflow'],
    ]);
  });

  it('refuses a distractors entity the plan does not have (YOS-180)', () => {
    assert.deepEqual(planSchema.safeParse(withPressure({ distractors: 'invoice' })).error?.issues.map((i) => [i.path, i.message]), [
      [['tasks', 0, 'pressure', 'distractors'], 'pressure.distractors names invoice, which is no planned entity'],
    ]);
    const ok = planSchema.parse(withPressure({ distractors: 'ticket' }));
    assert.deepEqual(planSchema.parse(parse(renderPlanYaml(ok))).tasks[0]?.pressure, { distractors: 'ticket' });
  });

  it('accepts a planned paging entity and workflow state, and keeps them through plan.yaml', () => {
    const r = planSchema.parse(withPressure({ paging: 'ticket', states: ['ticket.solved'] }));
    assert.deepEqual(planSchema.parse(parse(renderPlanYaml(r))).tasks[0]?.pressure, { paging: 'ticket', states: ['ticket.solved'] });
  });
});

describe('a pressure state the plan\'s own lifecycle keeps out of every state field (A-369, YOS-253)', () => {
  const removal = { name: 'agent_lifecycle', entity: 'agent', states: ['active', 'deleted'], rules: [], lifecycle: { representation: 'removal' as const, reason: 'a deleted agent is removed from the store' }, actions: [] };
  const pressing = (states: string[], workflows: Plan['workflows'] = [...plan.workflows, removal]): Plan =>
    ({ ...plan, workflows, tasks: plan.tasks.map((t) => (t.id === 'solve_vip' ? { ...t, pressure: { states } } : t)) });

  it('mints plan.pressure_unreachable for a state only a removal workflow names, and routes it to plan', () => {
    const issues = pressurePlanIssues(pressing(['agent.active']));
    assert.deepEqual(issues.map((i) => [i.code, i.severity, i.path, i.found]), [
      ['plan.pressure_unreachable', 'error', ['plan', 'tasks', 1, 'pressure', 'states', 0], 'agent.active is a state only of agent_lifecycle (lifecycle removal)'],
    ]);
    assert.equal(issues[0]?.expected, 'pressure states on solve_vip that a state field of agent holds');
    assert.equal(issues[0]?.hint, 'agent.active belongs only to agent_lifecycle, whose declared lifecycle keeps it out of every state field, so no seed row can be in it. Drop agent.active from the pressure of solve_vip, or press a state of a workflow whose states a state field holds.');
    assert.deepEqual(issues.map(ownerOf), ['plan']);
  });

  it('mints it for a descriptive lifecycle too, at the index of the claim', () => {
    const flag = { ...removal, lifecycle: { representation: 'descriptive' as const, reason: 'active is a derived flag' } };
    assert.deepEqual(pressurePlanIssues(pressing(['ticket.solved', 'agent.active'], [...plan.workflows, flag])).map((i) => [i.path, i.found]), [
      [['plan', 'tasks', 1, 'pressure', 'states', 1], 'agent.active is a state only of agent_lifecycle (lifecycle descriptive)'],
    ]);
  });

  it('leaves a state that a workflow without a lifecycle also names to the seed check', () => {
    const held = { name: 'agent_status', entity: 'agent', states: ['active', 'away'], rules: [], actions: [] };
    assert.deepEqual(pressurePlanIssues(pressing(['agent.active'], [...plan.workflows, removal, held])), []);
    assert.deepEqual(pressurePlanIssues(pressing(['ticket.solved'])), []);
  });
});
