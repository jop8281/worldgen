/**
 * The scripted world a fake model builds, shared by the runWorldGen tests (test/worldgen.test.ts)
 * and the worldgen CLI end-to-end test (test/cli-worldgen.test.ts): a plan, then one WorldEdit per
 * stage (model, workflow, seed, tasks) whose union is TARGET.
 */
import type { World } from '#engine';
import { minimalWorld } from './world.ts';

export const CUSTOMERS = `(ctx) => [
  { name: 'Acme', tier: 'enterprise' },
  { name: 'Globex', tier: 'pro' },
  { name: 'Initech', tier: 'pro' },
  { name: 'Umbrella', tier: 'free' },
  { name: 'Hooli', tier: 'free' },
  { name: 'Stark', tier: 'enterprise' },
  { name: 'Wayne', tier: 'enterprise' },
  { name: 'Wonka', tier: 'pro' },
  { name: 'Cyberdyne', tier: 'pro' },
  { name: 'Tyrell', tier: 'free' },
  { name: 'Soylent', tier: 'free' },
  { name: 'Aperture', tier: 'pro' },
  { name: 'Vandelay', tier: 'free' },
  { name: 'Pied Piper', tier: 'pro' },
  { name: 'Massive Dynamic', tier: 'enterprise' },
]`;

export const RESOLVE_TEST = `(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Test Co', tier: 'free' });
  ctx.assert(c.status === 201, 'create customer failed');
  const t = ctx.api('POST', '/tickets', { customer: c.body.id, subject: 'Help', priority: 'low' });
  ctx.assert(t.status === 201, 'create ticket failed');
  const p = ctx.api('PATCH', '/tickets/' + t.body.id, { status: 'pending' });
  ctx.assert(p.status === 200, 'move to pending failed');
  const r = ctx.api('POST', '/tickets/' + t.body.id + '/resolve');
  ctx.assert(r.status === 200, 'resolve failed');
}`;

export const ESCALATE_TEST = `(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Escalate Co', tier: 'free' });
  ctx.assert(c.status === 201, 'create customer failed');
  const t = ctx.api('POST', '/tickets', { customer: c.body.id, subject: 'Down', priority: 'low' });
  ctx.assert(t.status === 201, 'create ticket failed');
  const e = ctx.api('POST', '/tickets/' + t.body.id + '/escalate');
  ctx.assert(e.status === 200 && e.body.priority === 'urgent', 'escalate failed');
}`;

export const ESCALATE_HANDLER = `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'ticket.not_found', 'No ticket ' + ctx.params.id);
  if (t.status === 'resolved') ctx.fail(409, 'ticket.resolved', 'A resolved ticket cannot be escalated.');
  return { status: 200, body: ctx.db.update('ticket', t.id, { priority: 'urgent' }) };
}`;

/**
 * What the fake model builds: minimalWorld with 15 customers, page sizes 5 and 4, an escalate action beside resolve,
 * so the plan's hard task can name two workflow actions (A-390), and a test for each action.
 */
export const TARGET: World = minimalWorld({
  routes: { list_customers: { pageSize: 5 }, list_tickets: { pageSize: 4 } },
  actions: { escalate_ticket: { method: 'POST', path: '/tickets/{id}/escalate', description: 'Make an unresolved ticket urgent.', handler: ESCALATE_HANDLER } },
  seed: { customer: CUSTOMERS },
  tests: {
    resolve_pending_ticket: { description: 'a pending ticket can be resolved', script: RESOLVE_TEST },
    escalate_open_ticket: { description: 'an unresolved ticket can be escalated', script: ESCALATE_TEST },
  },
});

export const PLAN = {
  software: 'Zendesk-style helpdesk',
  open_questions: [{ question: 'Which ticket priorities exist?', default_answer: 'low, normal and high' }],
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Customers file tickets, agents resolve pending ones, and overdue tickets escalate.',
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'customer', purpose: 'a company that files tickets', keyFields: ['name', 'tier'] },
    { name: 'ticket', purpose: 'a support request', keyFields: ['status', 'priority'] },
  ],
  workflows: [{ name: 'resolution', entity: 'ticket', states: ['open', 'pending', 'resolved'], rules: ['only a pending ticket can be resolved'], actions: ['resolve_ticket', 'escalate_ticket'] }],
  jobs: [{ name: 'escalate_overdue', every: '15m', rule: 'overdue unresolved tickets become urgent' }],
  routes: [
    { id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse tickets' },
    { id: 'get_ticket', method: 'GET', path: '/tickets/{id}', purpose: 'read one ticket' },
    { id: 'list_customers', method: 'GET', path: '/customers', purpose: 'browse customers' },
  ],
  acceptanceTests: [{
    id: 'resolve_pending_ticket',
    intent: 'A pending ticket can be resolved through the public API.',
    actions: ['resolve_ticket'],
    description: 'a pending ticket can be resolved',
    script: RESOLVE_TEST,
  }, {
    id: 'escalate_open_ticket',
    intent: 'An unresolved ticket can be escalated through the public API.',
    actions: ['escalate_ticket'],
    description: 'an unresolved ticket can be escalated',
    script: ESCALATE_TEST,
  }],
  seed: { rowsPerEntity: { customer: 15, ticket: 12 }, mix: 'half the tickets pending', stateMix: { ticket: { open: 33, pending: 50, resolved: 17 } } },
  tasks: [
    { id: 'resolve_password_ticket', difficulty: 'easy', intent: 'resolve one named ticket', decoyIdea: 'resolves the wrong ticket' },
    { id: 'resolve_initech_pending', difficulty: 'medium', intent: 'resolve the pending tickets of one customer', decoyIdea: 'resolves every customer' },
    { id: 'escalate_acme', difficulty: 'hard', kind: 'irreversible', intent: 'escalate and resolve the tickets of a churning customer', actions: ['escalate_ticket', 'resolve_ticket'], decoyIdea: 'forgets to resolve' },
  ],
  assumptions: [
    { decision: 'Tickets move open -> pending -> resolved, and a resolved ticket can reopen.', why: 'The description names no lifecycle, so the plan takes the smallest Zendesk-like one.' },
    { decision: 'Overdue unresolved tickets become urgent, checked every 15 minutes.', why: 'SLA escalation needs a schedule, and 15 minutes is a common helpdesk default.' },
  ],
  outOfScope: [{ what: 'agent assignment', why: 'none of the three tasks needs it' }],
};

export const EDITS = {
  model: { note: 'entities and routes from the plan', upsert: { entities: TARGET.entities, routes: TARGET.routes } },
  workflow: { note: 'the resolve action and the escalation job', upsert: { actions: TARGET.actions, jobs: TARGET.jobs } },
  seed: { note: 'customers and tickets', upsert: { seed: TARGET.seed } },
  tasks: { note: 'three graded tasks', upsert: { tasks: TARGET.tasks } },
};
