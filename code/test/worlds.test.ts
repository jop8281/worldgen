import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkWorld, createRuntime, loadWorld, type CheckedWorld, type Runtime } from '#engine';
import { parsePlanYaml } from '../src/worldgen/plan.ts';

const WORLDS = fileURLToPath(new URL('../../prod/worlds/', import.meta.url));
const HELPDESK = path.join(WORLDS, 'helpdesk');

/** Each world directory, relative to prod/worlds. `generated/` holds `npm run worldgen` output one level down. */
async function worldDirs(): Promise<string[]> {
  const subdirs = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const top = await subdirs(WORLDS);
  const generated = top.includes('generated') ? (await subdirs(path.join(WORLDS, 'generated'))).map((n) => `generated/${n}`) : [];
  return [...top.filter((n) => n !== 'generated'), ...generated].sort();
}

async function checkDir(dir: string): Promise<CheckedWorld> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) assert.fail(`${dir} did not load:\n${JSON.stringify(loaded.error, null, 2)}`);
  const report = checkWorld(loaded.value);
  if (!report.ok) assert.fail(`${dir} failed check at ${report.reached}:\n${JSON.stringify(report.issues, null, 2)}`);
  return report.world;
}

/** The checked helpdesk, once per file: a full check seeds, runs the world tests and verifies the tasks. */
const memo = new Map<string, Promise<CheckedWorld>>();
function checked(dir: string): Promise<CheckedWorld> {
  let p = memo.get(dir);
  if (p === undefined) memo.set(dir, (p = checkDir(dir)));
  return p;
}

describe('prod worlds', async () => {
  const dirs = await worldDirs();

  it('include the hand-built helpdesk', () => {
    assert.ok(dirs.includes('helpdesk'), `found ${dirs.join(', ')}`);
  });

  for (const name of dirs) {
    it(`${name} loads and passes checkWorld`, async () => {
      const loaded = await loadWorld(path.join(WORLDS, name));
      assert.ok(loaded.ok, loaded.ok ? '' : JSON.stringify(loaded.error, null, 2));
      const report = checkWorld(loaded.value);
      assert.equal(report.ok, true, report.ok ? '' : `reached ${report.reached}:\n${JSON.stringify(report.issues, null, 2)}`);
      const planText = await readFile(path.join(WORLDS, name, 'plan.yaml'), 'utf8').catch(() => null);
      const plan = planText === null ? null : parsePlanYaml(planText);
      if (report.ok && plan !== null) assert.deepEqual(plan.clock, report.world.meta.clock, `${name}: plan.yaml clock differs from world.yaml`);
    });
  }

  it('every saved plan.yaml parses with parsePlanYaml', async () => {
    const unparsed: string[] = [];
    for (const name of dirs) {
      const text = await readFile(path.join(WORLDS, name, 'plan.yaml'), 'utf8').catch(() => null);
      if (text !== null && parsePlanYaml(text) === null) unparsed.push(name);
    }
    assert.deepEqual(unparsed, []);
  });
});

describe('helpdesk world: model', () => {
  it('R1 meta is hand-built, resembles Zendesk, with a fixed clock', async () => {
    const w = await checked(HELPDESK);
    assert.equal(w.format, 1);
    assert.equal(w.meta.name, 'helpdesk');
    assert.equal(w.meta.source, 'hand');
    assert.equal(w.meta.resembles, 'Zendesk Support tickets API');
    assert.equal(w.meta.clock.start, '2026-03-02T09:00:00.000Z');
    assert.equal(w.meta.clock.tick, '1s');
  });

  it('R2 has the entities and refs of the behaviour table', async () => {
    const w = await checked(HELPDESK);
    assert.deepEqual(Object.keys(w.entities).sort(), ['agent', 'customer', 'oncall_shift', 'sla_policy', 'ticket', 'ticket_comment', 'ticket_event']);
    const refs: string[] = [];
    for (const [en, e] of Object.entries(w.entities)) {
      for (const [fn, f] of Object.entries(e.fields)) if (f.type === 'ref') refs.push(`${en}.${fn}->${f.entity}`);
    }
    assert.deepEqual(refs.sort(), [
      'oncall_shift.agent_id->agent',
      'ticket.assignee_id->agent',
      'ticket.customer_id->customer',
      'ticket_comment.author_id->agent',
      'ticket_comment.ticket_id->ticket',
      'ticket_event.actor_id->agent',
      'ticket_event.ticket_id->ticket',
    ]);
    const tier = w.entities.customer?.fields.tier;
    assert.ok(tier && tier.type === 'enum');
    assert.deepEqual(tier.values, ['standard', 'premium', 'enterprise']);
    assert.equal(w.entities.sla_policy?.fields.code?.unique, true);
    const kind = w.entities.ticket_event?.fields.kind;
    assert.ok(kind && kind.type === 'enum');
    assert.deepEqual(kind.values, ['created', 'assigned', 'escalated', 'sla_breach', 'priority_changed', 'resolved', 'reopened', 'closed']);
  });

  it('R3 ticket.status is a writable state machine with open -> escalated and without open -> closed', async () => {
    const status = (await checked(HELPDESK)).entities.ticket?.fields.status;
    assert.ok(status && status.type === 'state');
    assert.deepEqual(status.states, ['new', 'open', 'pending', 'escalated', 'resolved', 'closed']);
    assert.equal(status.initial, 'new');
    assert.equal(status.readonly, false);
    assert.deepEqual(status.transitions, {
      new: ['open', 'escalated'],
      open: ['pending', 'escalated', 'resolved'],
      pending: ['open', 'escalated', 'resolved'],
      escalated: ['resolved'],
      resolved: ['open', 'closed'],
      closed: [],
    });
  });

  it('R4 priority is an enum, sla_due_at a readonly datetime, workflow fields readonly', async () => {
    const fields = (await checked(HELPDESK)).entities.ticket?.fields;
    assert.ok(fields);
    const priority = fields.priority;
    assert.ok(priority && priority.type === 'enum');
    assert.deepEqual(priority.values, ['low', 'normal', 'high', 'urgent']);
    assert.equal(fields.sla_due_at?.type, 'datetime');
    assert.equal(fields.sla_due_at?.readonly, true);
    const readonly = Object.entries(fields).filter(([, f]) => f.readonly).map(([n]) => n).sort();
    assert.deepEqual(readonly, ['assignee_id', 'escalated_at', 'escalation_level', 'resolved_at', 'sla_breached', 'sla_due_at', 'sla_started_at']);
  });

  it('R5 routes cover the standard operations', async () => {
    const w = await checked(HELPDESK);
    const ops = Object.values(w.routes).map((r) => `${r.method} ${r.path} ${r.op} ${r.entity}`).sort();
    assert.deepEqual(ops, [
      'GET /agents list agent',
      'GET /customers list customer',
      'GET /customers/{id} get customer',
      'GET /oncall list oncall_shift',
      'GET /sla_policies list sla_policy',
      'GET /tickets list ticket',
      'GET /tickets/{id} get ticket',
      'GET /tickets/{ticket_id}/comments list ticket_comment',
      'GET /tickets/{ticket_id}/events list ticket_event',
      'PATCH /customers/{id} update customer',
      'PATCH /tickets/{id} update ticket',
      'POST /customers create customer',
      'POST /tickets create ticket',
    ]);
    const list = w.routes.list_tickets;
    assert.ok(list && list.op === 'list');
    assert.deepEqual(list.filters, ['status', 'priority', 'customer_id', 'assignee_id', 'sla_breached', 'escalation_level']);
    assert.deepEqual(list.search, ['subject']);
    assert.deepEqual(list.sort, ['created_at', 'sla_due_at']);
    assert.equal(list.pageSize, 25);
  });

  it('R6 workflow sections are filled: actions, jobs, seed, tests and tasks; no fixtures', async () => {
    const w = await checked(HELPDESK);
    assert.deepEqual(Object.values(w.actions).map((a) => `${a.method} ${a.path}`), [
      'POST /tickets/{id}/assign',
      'POST /tickets/{id}/escalate',
      'POST /tickets/{id}/resolve',
      'POST /tickets/{id}/reopen',
    ]);
    assert.deepEqual(Object.keys(w.actions), ['assign_ticket', 'escalate_ticket', 'resolve_ticket', 'reopen_ticket']);
    assert.deepEqual(Object.entries(w.jobs).map(([n, j]) => `${n} ${j.every}`), ['sla_breach 15m', 'escalation_timeout 15m', 'auto_close 1h']);
    assert.deepEqual(Object.keys(w.seed), ['customer', 'agent', 'sla_policy', 'oncall_shift', 'ticket', 'ticket_comment', 'ticket_event']);
    assert.deepEqual(Object.keys(w.tests), [
      'escalate_assigns_oncall_agent', 'escalate_twice_is_409', 'escalate_refusals',
      'resolve_sets_resolved_at', 'reopen_restarts_sla', 'assign_opens_new_ticket',
    ]);
    assert.deepEqual(Object.entries(w.tasks).map(([n, t]) => `${t.difficulty} ${n} ${t.decoys.length}`), [
      'easy assign_newest_acme_ticket 4',
      'medium escalate_breached_printer_ticket 4',
      'hard escalate_breached_enterprise_tickets 6',
    ]);
    assert.deepEqual(w.fixtures, {});
  });

  it('R7 NOTES.md is at most 70 lines and names every entity, Zendesk, the workflow and the tasks', async () => {
    const notes = await readFile(path.join(HELPDESK, 'NOTES.md'), 'utf8');
    assert.ok(notes.trimEnd().split('\n').length <= 70, `NOTES.md has ${notes.trimEnd().split('\n').length} lines`);
    for (const word of ['customer', 'agent', 'sla_policy', 'oncall_shift', 'ticket', 'ticket_comment', 'ticket_event', 'Zendesk', 'escalated', 'pending',
      '## Workflow', '## Tasks', 'assign_ticket', 'escalate_ticket', 'resolve_ticket', 'reopen_ticket', 'sla_breach',
      'assign_newest_acme_ticket', 'escalate_breached_printer_ticket', 'escalate_breached_enterprise_tickets']) {
      assert.ok(notes.includes(word), `NOTES.md does not mention ${word}`);
    }
  });
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Call = { status: number; body: Record<string, unknown> };

/** A fresh runtime on the seeded helpdesk, at clock.start. */
async function helpdesk(): Promise<{ rt: Runtime; call: (method: Method, p: string, body?: unknown, query?: Record<string, string>) => Call }> {
  const rt = createRuntime(await checked(HELPDESK));
  const call = (method: Method, p: string, body?: unknown, query: Record<string, string> = {}): Call => {
    const res = rt.call({ method, path: p, query, body });
    return { status: res.status, body: res.body as Record<string, unknown> };
  };
  return { rt, call };
}

const errorCode = (c: Call): unknown => (c.body.error as { code?: unknown } | undefined)?.code;
const ids = (c: Call): unknown[] => (c.body.data as { id: unknown }[]).map((r) => r.id);

describe('helpdesk world: API behaviour', () => {
  it('R9 a ticket created through POST /tickets starts new, unassigned, at level 0, with its SLA clock started at engine time', async () => {
    const { call } = await helpdesk();
    const created = call('POST', '/tickets', { subject: 'Invoice question', customer_id: 'cus_0001', priority: 'low', description: 'Billing asks about VAT' });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'tkt_0321');
    const t = call('GET', '/tickets/tkt_0321');
    assert.equal(t.status, 200);
    assert.equal(t.body.status, 'new');
    assert.equal(t.body.priority, 'low');
    assert.equal(t.body.assignee_id, null);
    assert.equal(t.body.escalation_level, 0);
    assert.equal(t.body.sla_breached, false);
    assert.equal(t.body.sla_due_at, null);
    assert.equal(t.body.sla_started_at, '2026-03-02T09:00:00.000Z');
  });

  it('R9 a plain PATCH moves open -> escalated without touching the workflow fields', async () => {
    const { call } = await helpdesk();
    const r = call('PATCH', '/tickets/tkt_0002', { status: 'escalated' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'escalated');
    assert.equal(r.body.escalation_level, 0);
    assert.equal(r.body.assignee_id, 'agt_0001');
    assert.equal(r.body.escalated_at, null);
  });

  it('R9 open -> closed is refused and changes nothing', async () => {
    const { rt, call } = await helpdesk();
    const before = rt.dump().tables;
    const r = call('PATCH', '/tickets/tkt_0001', { status: 'closed' });
    assert.equal(r.status, 422);
    assert.equal(errorCode(r), 'state.transition');
    assert.deepEqual(rt.dump().tables, before);
  });

  it('R9 plain writes refuse readonly, unknown and missing targets with engine codes', async () => {
    const { call } = await helpdesk();
    for (const body of [
      { sla_due_at: '2026-03-03T09:00:00.000Z' },
      { assignee_id: null },
      { escalation_level: 1 },
      { resolved_at: '2026-03-03T09:00:00.000Z' },
      { sla_breached: true },
      { created_at: '2026-03-03T09:00:00.000Z' },
    ]) {
      const r = call('PATCH', '/tickets/tkt_0001', body);
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.equal(errorCode(r), 'field.readonly', JSON.stringify(body));
    }
    const unknown = call('PATCH', '/tickets/tkt_0001', { mood: 'grumpy' });
    assert.equal(unknown.status, 422);
    assert.equal(errorCode(unknown), 'field.unknown');
    const missing = call('PATCH', '/tickets/tkt_9999', { subject: 'x' });
    assert.equal(missing.status, 404);
    assert.equal(errorCode(missing), 'row.not_found');
    const del = call('DELETE', '/tickets/tkt_0001');
    assert.equal(del.status, 405);
    assert.equal(errorCode(del), 'method.not_allowed');
    const ok = call('PATCH', '/tickets/tkt_0001', { subject: 'Label printer offline in DC-3 (dock 3)', description: 'Since 04:00' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.subject, 'Label printer offline in DC-3 (dock 3)');
  });

  it('R10 every move in the transition matrix works or is refused exactly as declared', async () => {
    const { call } = await helpdesk();
    const pathTo: Record<string, string[]> = {
      new: [],
      open: ['open'],
      pending: ['open', 'pending'],
      escalated: ['escalated'],
      resolved: ['open', 'resolved'],
      closed: ['open', 'resolved', 'closed'],
    };
    const states = ['new', 'open', 'pending', 'escalated', 'resolved', 'closed'];
    const legal: string[] = [];
    for (const from of states) {
      for (const to of states) {
        if (from === to) continue;
        const created = call('POST', '/tickets', { subject: `${from} to ${to}`, customer_id: 'cus_0001', priority: 'normal' });
        assert.equal(created.status, 201);
        const id = String(created.body.id);
        for (const step of pathTo[from]!) assert.equal(call('PATCH', `/tickets/${id}`, { status: step }).status, 200, `${id} -> ${step}`);
        const r = call('PATCH', `/tickets/${id}`, { status: to });
        if (r.status === 200) legal.push(`${from}->${to}`);
        else assert.equal(errorCode(r), 'state.transition', `${from}->${to}: ${JSON.stringify(r.body)}`);
      }
    }
    assert.deepEqual(legal, [
      'new->open', 'new->escalated',
      'open->pending', 'open->escalated', 'open->resolved',
      'pending->open', 'pending->escalated', 'pending->resolved',
      'escalated->resolved',
      'resolved->open', 'resolved->closed',
    ]);
  });

  it('R10 every state is reachable from a created ticket and closed is final', async () => {
    const { call } = await helpdesk();
    assert.equal(call('POST', '/tickets', { subject: 'Label printer offline', customer_id: 'cus_0001', priority: 'urgent' }).status, 201);
    for (const s of ['open', 'pending', 'escalated', 'resolved', 'closed']) {
      const r = call('PATCH', '/tickets/tkt_0321', { status: s });
      assert.equal(r.status, 200, `to ${s}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, s);
    }
    for (const s of ['new', 'open', 'pending', 'escalated', 'resolved']) {
      const back = call('PATCH', '/tickets/tkt_0321', { status: s });
      assert.equal(back.status, 422);
      assert.equal(errorCode(back), 'state.transition');
    }
  });

  it('R11 the ticket list filters, searches, sorts and pages over the seed', async () => {
    const { call } = await helpdesk();
    assert.deepEqual(ids(call('GET', '/tickets', undefined, { customer_id: 'cus_0001' })), ['tkt_0001', 'tkt_0002', 'tkt_0003', 'tkt_0004']);
    assert.deepEqual(ids(call('GET', '/tickets', undefined, { customer_id: 'cus_0001', status: 'new', sort: '-created_at' })), ['tkt_0004', 'tkt_0003']);
    assert.deepEqual(ids(call('GET', '/tickets', undefined, { customer_id: 'cus_0001', q: 'label printer' })), ['tkt_0001', 'tkt_0002']);
    assert.deepEqual(ids(call('GET', '/tickets', undefined, { customer_id: 'cus_0001', sla_breached: 'true' })), ['tkt_0001']);
    assert.deepEqual(ids(call('GET', '/tickets', undefined, { customer_id: 'cus_0001', sort: 'sla_due_at', limit: '2' })), ['tkt_0001', 'tkt_0002']);
    const page1 = call('GET', '/tickets', undefined, { status: 'open', priority: 'high', sla_breached: 'true' });
    assert.equal((page1.body.data as unknown[]).length, 25);
    assert.equal(typeof page1.body.next_cursor, 'string');
    const page2 = call('GET', '/tickets', undefined, { status: 'open', priority: 'high', sla_breached: 'true', cursor: String(page1.body.next_cursor) });
    assert.equal((page2.body.data as unknown[]).length, 10);
    assert.equal(page2.body.next_cursor, null);
  });

  it('R5 customers, agents, on-call shifts, SLA policies, events and comments are listable', async () => {
    const { call } = await helpdesk();
    assert.deepEqual(ids(call('GET', '/customers', undefined, { q: 'Acme' })), ['cus_0001', 'cus_0002']);
    assert.deepEqual(ids(call('GET', '/agents', undefined, { team: 'sre', active: 'true' })), ['agt_0004', 'agt_0008', 'agt_0011']);
    assert.deepEqual(ids(call('GET', '/agents', undefined, { q: 'Priya' })), ['agt_0001', 'agt_0002']);
    assert.deepEqual(ids(call('GET', '/sla_policies', undefined, { tier: 'enterprise', priority: 'urgent' })), ['sla_0001']);
    const l1 = call('GET', '/oncall', undefined, { level: '1', agent_id: 'agt_0003' });
    assert.equal(l1.status, 200);
    assert.equal((l1.body.data as unknown[]).length, 6);
    const events = call('GET', '/tickets/tkt_0001/events', undefined, { sort: 'created_at' });
    assert.deepEqual((events.body.data as { kind: string }[]).map((e) => e.kind), ['created', 'assigned', 'sla_breach']);
    const comments = call('GET', '/tickets/tkt_0001/comments');
    assert.equal(comments.status, 200);
  });
});
