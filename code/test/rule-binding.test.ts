import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, checkWorld, type CheckReport, type World } from '#engine';
import { planSchema, parsePlanYaml, renderPlanYaml, workflowIssues, type Plan } from '../src/worldgen/plan.ts';
import { scopeIssues } from '../src/worldgen/run.ts';
import { withStubTasks, type StubTarget } from './helpers/world.ts';

/**
 * YOS-155: every workflow rule binds to a frozen behavioral acceptance case, and the plan owns
 * those tests. Four surfaces, asserted with literals:
 *
 * - acceptance-2, the heart: two worlds that differ only in the resolve_ticket handler. The frozen
 *   scenario t_resolve_boundary creates its own ticket, refuses a whitespace-only comment, then
 *   resolves the same ticket with the one-character "x". A handler that resolves a blank comment
 *   fails as test.failed at the scenario's path; the handler that enforces the rule checks ok.
 * - planSchema: a rule bound as { rule, by, test } and a workflow lifecycle parse and round-trip
 *   through plan.yaml, beside a schema rule exempt from the binding.
 * - workflowIssues: a workflow whose entity machine models another workflow and that declares no
 *   lifecycle mints plan.lifecycle_unrepresented at ['plan', 'workflows', 0, 'lifecycle']; a
 *   descriptive lifecycle is the positive control; a removal lifecycle exempts an entity with no
 *   state field from plan.state_field_missing.
 * - acceptance-3: a workflow-stage edit that patches tests is edit.out_of_scope at ['tests'];
 *   the same edit shape on actions, a section that stage owns, mints nothing.
 */

/** The frozen boundary scenario: the plan pins it (acceptanceTests) and the world carries it (tests). */
const T_RESOLVE_BOUNDARY = `(ctx) => {
  const t = ctx.api('POST', '/tickets', { subject: 'Boundary probe' });
  ctx.assert(t.status === 201, 'create returned ' + t.status + ' ' + JSON.stringify(t.body));
  const blank = ctx.api('POST', '/tickets/' + t.body.id + '/resolve', { comment: '   ' });
  ctx.assert(blank.status === 422, 'a whitespace-only comment was not refused: ' + blank.status + ' ' + JSON.stringify(blank.body));
  ctx.assert(blank.body.error.code === 'ticket.comment_required', 'the refusal code was ' + blank.body.error.code);
  const edge = ctx.api('POST', '/tickets/' + t.body.id + '/resolve', { comment: 'x' });
  ctx.assert(edge.status === 200, 'the one-character comment did not resolve: ' + edge.status + ' ' + JSON.stringify(edge.body));
  ctx.assert(edge.body.status === 'resolved', 'resolve left the ticket ' + edge.body.status);
  const after = ctx.api('GET', '/tickets/' + t.body.id);
  ctx.assert(after.status === 200 && after.body.status === 'resolved', 'the ticket was not resolved: ' + JSON.stringify(after.body));
}`;
const T_RESOLVE_DESCRIPTION = 'resolve_ticket refuses a whitespace-only comment with 422 ticket.comment_required and resolves the same ticket with the one-character comment "x".';

/** The handler that enforces the rule: a comment of only spaces is refused, "x" resolves. */
const RIGHT_HANDLER = `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'ticket.not_found', 'No ticket ' + ctx.params.id);
  if (ctx.body.comment.trim() === '') ctx.fail(422, 'ticket.comment_required', 'Resolution requires a non-empty comment. A comment of only spaces is refused.');
  return { status: 200, body: ctx.db.update('ticket', t.id, { status: 'resolved' }) };
}`;
/** Incorrect business behavior only: the action exists and runs, but it resolves a blank comment too. */
const WRONG_HANDLER = `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'ticket.not_found', 'No ticket ' + ctx.params.id);
  return { status: 200, body: ctx.db.update('ticket', t.id, { status: 'resolved' }) };
}`;

const meta: World['meta'] = {
  name: 'helpdesk',
  description: 'A helpdesk that resolves tickets with a required comment.',
  resembles: 'a small helpdesk tickets API',
  source: 'hand',
  seed: 1,
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  api: {
    list: { mode: 'cursor', dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' },
    error: { error: { code: '$code', message: '$message' } },
  },
};

/** The stub tasks create their own agents, so the world needs only list and create routes for them. */
const AGENT_STUB: StubTarget = { entity: 'agent', path: '/agents', key: 'name', row: (label) => ({ name: label }) };

/**
 * The acceptance-2 world: one ticket entity with an open/resolved machine, one enforcing action,
 * the frozen boundary scenario, and stub tasks so an ok report needs no seed rows. The two
 * variants differ only in the handler.
 */
function boundaryWorld(handler: string): World {
  return withStubTasks({
    format: 1,
    meta,
    entities: {
      ticket: {
        description: 'A support request.',
        idPrefix: 'tkt',
        fields: {
          subject: { type: 'string', required: true, nullable: false, unique: false, readonly: false },
          status: { type: 'state', required: true, nullable: false, unique: false, readonly: false, states: ['open', 'resolved'], initial: 'open', transitions: { open: ['resolved'] } },
        },
      },
      agent: { description: 'A support agent who resolves tickets.', idPrefix: 'agt', fields: { name: { type: 'string', required: true, nullable: false, unique: false, readonly: false } } },
    },
    routes: {
      create_ticket: { op: 'create', entity: 'ticket', method: 'POST', path: '/tickets' },
      get_ticket: { op: 'get', entity: 'ticket', method: 'GET', path: '/tickets/{id}' },
      list_agents: { op: 'list', entity: 'agent', method: 'GET', path: '/agents', filters: [], search: [], sort: [], pageSize: 25 },
      create_agent: { op: 'create', entity: 'agent', method: 'POST', path: '/agents' },
    },
    actions: {
      resolve_ticket: {
        method: 'POST',
        path: '/tickets/{id}/resolve',
        description: 'Resolve an open ticket. Resolution requires a non-empty comment.',
        input: { comment: { type: 'text', required: true, nullable: false, unique: false, readonly: false } },
        handler,
      },
    },
    jobs: {},
    fixtures: {},
    seed: {},
    tests: { t_resolve_boundary: { description: T_RESOLVE_DESCRIPTION, script: T_RESOLVE_BOUNDARY } },
    tasks: {},
  }, AGENT_STUB);
}

function ok(report: CheckReport): Extract<CheckReport, { ok: true }> {
  if (!report.ok) throw new Error(`expected ok, got ${JSON.stringify(report.issues.map((i) => [i.code, i.path, i.hint]))}`);
  return report;
}
function failed(report: CheckReport): Extract<CheckReport, { ok: false }> {
  if (report.ok) throw new Error('expected a failed report');
  return report;
}

describe('the frozen boundary scenario (acceptance-2)', () => {
  it('checks ok when the handler refuses a whitespace-only comment and resolves on the one-character "x"', () => {
    const report = ok(checkWorld(boundaryWorld(RIGHT_HANDLER)));
    assert.equal(report.tests, 1);
    assert.deepEqual(report.stats.unexercisedActions, []);
  });

  it('fails a handler that resolves a blank comment as test.failed at the scenario path', () => {
    const report = failed(checkWorld(boundaryWorld(WRONG_HANDLER)));
    assert.equal(report.reached, 'tests');
    assert.deepEqual(report.issues.map((i) => [i.code, i.path]), [
      ['test.failed', ['tests', 't_resolve_boundary', 'script']],
      ['layer.blocked', ['tasks']],
    ]);
  });
});

/** The plan of the acceptance-2 world: the rule is bound to its frozen test, the aging workflow declares its derived states. */
const boundPlan: Plan = {
  revision: 1,
  software: 'Zendesk-style helpdesk',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Tickets resolved through a comment-bearing action.',
  verdict: { kind: 'proceed' },
  entities: [{ name: 'ticket', purpose: 'a support request', keyFields: ['status'] }],
  workflows: [
    {
      name: 'resolution',
      entity: 'ticket',
      states: ['open', 'resolved'],
      rules: [
        { rule: 'resolution requires a non-empty comment', by: ['resolve_ticket'], test: 't_resolve_boundary' },
        { rule: 'a ticket always carries a subject', schema: 'the create route refuses a ticket without a subject through its field schema' },
      ],
      actions: ['resolve_ticket'],
    },
    {
      name: 'aging',
      entity: 'ticket',
      states: ['fresh', 'stale'],
      rules: [],
      actions: [],
      lifecycle: { representation: 'descriptive', reason: 'staleness is derived from updated_at, not a stored state' },
    },
  ],
  jobs: [],
  acceptanceTests: [{
    id: 't_resolve_boundary',
    intent: 'A ticket resolves only with a non-empty comment; one character is the boundary.',
    actions: ['resolve_ticket'],
    description: T_RESOLVE_DESCRIPTION,
    script: T_RESOLVE_BOUNDARY,
  }],
  routes: [
    { id: 'create_ticket', method: 'POST', path: '/tickets', purpose: 'file a ticket' },
    { id: 'get_ticket', method: 'GET', path: '/tickets/{id}', purpose: 'read one ticket' },
  ],
  seed: { rowsPerEntity: { ticket: 20 }, mix: 'mostly open', stateMix: { ticket: { open: 80, resolved: 20 } } },
  tasks: [
    { id: 'resolve_oldest', difficulty: 'easy', intent: 'resolve the oldest open ticket', decoyIdea: 'resolves the newest' },
    { id: 'resolve_urgent', difficulty: 'medium', intent: 'resolve every urgent ticket', decoyIdea: 'skips page 2' },
    { id: 'resolve_all_pages', difficulty: 'hard', intent: 'resolve open tickets on every page', decoyIdea: 'stops after page 1' },
  ],
  open_questions: [{ question: 'Can a resolved ticket reopen?', default_answer: 'no, resolution is final here' }],
  assumptions: [{ decision: 'a one-character comment is acceptable', why: 'the boundary scenario pins the minimum at one character' }],
  outOfScope: [{ what: 'email intake', why: 'needs a mail server' }],
  changes: [],
};

describe('planSchema rule binding and lifecycle (YOS-155)', () => {
  it('accepts a rule bound to its enforcing action and frozen test, a schema rule, and a workflow lifecycle', () => {
    const r = planSchema.safeParse(boundPlan);
    assert.deepEqual(r.success ? [] : r.error.issues.map((i) => i.message), []);
    const workflows = r.success ? r.data.workflows : [];
    assert.deepEqual(workflows[0]?.rules, [
      { rule: 'resolution requires a non-empty comment', by: ['resolve_ticket'], test: 't_resolve_boundary' },
      { rule: 'a ticket always carries a subject', schema: 'the create route refuses a ticket without a subject through its field schema' },
    ]);
    assert.deepEqual(workflows[1]?.lifecycle, { representation: 'descriptive', reason: 'staleness is derived from updated_at, not a stored state' });
  });

  it('round-trips the bound rule, the schema rule and the lifecycle through plan.yaml deep-equal', () => {
    assert.deepEqual(parsePlanYaml(renderPlanYaml(boundPlan)), boundPlan);
  });
});

/** A ticket whose only state machine, lifecycle_stage, models another workflow, not resolution. */
const STAGED_TICKET: World['entities'][string] = {
  description: 'A support request with a stored editorial stage and a derived resolution state.',
  idPrefix: 'tkt',
  fields: {
    subject: { type: 'string', required: true, nullable: false, unique: false, readonly: false },
    lifecycle_stage: { type: 'state', required: true, nullable: false, unique: false, readonly: false, states: ['draft', 'archived'], initial: 'draft', transitions: { draft: ['archived'] } },
  },
};

/** A ticket with no state field at all: deletion removes the row. */
const PLAIN_TICKET: World['entities'][string] = {
  description: 'A support request. Deleting one removes the row.',
  idPrefix: 'tkt',
  fields: { subject: { type: 'string', required: true, nullable: false, unique: false, readonly: false } },
};

function lifecycleWorld(ticket: World['entities'][string]): World {
  return { format: 1, meta, entities: { ticket }, routes: {}, actions: {}, jobs: {}, fixtures: {}, seed: {}, tests: {}, tasks: {} };
}

const LIFECYCLE_PLAN: Omit<Plan, 'workflows'> = {
  revision: 1,
  software: 'Zendesk-style helpdesk',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Tickets with a stored editorial stage and a derived resolution state.',
  verdict: { kind: 'proceed' },
  entities: [{ name: 'ticket', purpose: 'a support request', keyFields: ['subject'] }],
  jobs: [],
  acceptanceTests: [],
  routes: [],
  seed: { rowsPerEntity: { ticket: 5 }, mix: 'mostly open' },
  tasks: [
    { id: 'resolve_oldest', difficulty: 'easy', intent: 'resolve the oldest open ticket', decoyIdea: 'resolves the newest' },
    { id: 'resolve_urgent', difficulty: 'medium', intent: 'resolve every urgent ticket', decoyIdea: 'skips page 2' },
    { id: 'resolve_all_pages', difficulty: 'hard', intent: 'resolve open tickets on every page', decoyIdea: 'stops after page 1' },
  ],
  assumptions: [],
  outOfScope: [],
  changes: [],
};

const lifecyclePlan = (workflow: Plan['workflows'][number]): Plan => ({ ...LIFECYCLE_PLAN, workflows: [workflow] });

describe('workflowIssues lifecycle controls (YOS-155)', () => {
  it('mints plan.lifecycle_unrepresented when the entity machine models another workflow and the plan declares no lifecycle', () => {
    const issues = workflowIssues(lifecyclePlan({
      name: 'resolution', entity: 'ticket', states: ['open', 'resolved'], rules: [], actions: [],
    }), lifecycleWorld(STAGED_TICKET));
    assert.deepEqual(issues.map((i) => [i.code, i.path]), [['plan.lifecycle_unrepresented', ['plan', 'workflows', 0, 'lifecycle']]]);
  });

  it('mints nothing when a descriptive lifecycle declares the derived representation', () => {
    const issues = workflowIssues(lifecyclePlan({
      name: 'resolution', entity: 'ticket', states: ['open', 'resolved'], rules: [], actions: [],
      lifecycle: { representation: 'descriptive', reason: 'open and resolved are derived from the last agent reply, not a stored machine' },
    }), lifecycleWorld(STAGED_TICKET));
    assert.deepEqual(issues, []);
  });

  it('mints no plan.state_field_missing when a removal lifecycle declares deletion as row removal', () => {
    const issues = workflowIssues(lifecyclePlan({
      name: 'deletion', entity: 'ticket', states: ['live', 'deleted'], rules: [], actions: [],
      lifecycle: { representation: 'removal', reason: 'deletion is row removal through DELETE, not a stored state' },
    }), lifecycleWorld(PLAIN_TICKET));
    assert.deepEqual(issues, []);
  });
});

describe('scopeIssues: the plan owns the frozen tests (acceptance-3)', () => {
  it('mints edit.out_of_scope at the tests path for a workflow-stage edit that patches tests', () => {
    const edit = { note: 'weaken the frozen boundary scenario', patch: { tests: { t_resolve_boundary: { script: "(ctx) => { ctx.assert(true, 'always passes'); }" } } } };
    assert.equal(applyEdit(boundaryWorld(RIGHT_HANDLER), edit).ok, true); // the engine accepts the edit; the stage scope is what refuses it
    assert.deepEqual(scopeIssues('workflow', edit).map((i) => [i.code, i.path]), [['edit.out_of_scope', ['tests']]]);
  });

  it('mints nothing for the same edit shape on actions, a section the workflow stage owns', () => {
    const edit = { note: 'reword the resolve description', patch: { actions: { resolve_ticket: { description: 'Resolve an open ticket with a required comment.' } } } };
    assert.equal(applyEdit(boundaryWorld(RIGHT_HANDLER), edit).ok, true);
    assert.deepEqual(scopeIssues('workflow', edit), []);
  });
});
