/**
 * The red-team fixture world. A tiny helpdesk written as a TS object in the exact OUTPUT
 * shape of `worldSchema` (every defaulted key spelled out), so it is valid input and
 * matches what check sees after parsing.
 *
 * Every literal fact the suites may assert is hand-derived below in FACTS. None of it is
 * computed by the engine. If you change the seed snippet, recompute FACTS by hand.
 */
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadWorld, type Field, type World } from '#engine';

type Common = 'required' | 'nullable' | 'unique' | 'readonly';
type FieldOf<T extends Field['type']> = Extract<Field, { type: T }>;

/** A field with the four common flags defaulted to false, as zod output would have them. */
export function field<T extends Field['type']>(f: Omit<FieldOf<T>, Common> & Partial<Pick<FieldOf<T>, Common>>): FieldOf<T> {
  return { required: false, nullable: false, unique: false, readonly: false, ...f } as FieldOf<T>;
}

export const TASK_IDS = ['pend_hd1005', 'pend_open_urgent', 'escalate_unassigned'] as const;
export type TaskId = (typeof TASK_IDS)[number];

/** Seed statuses and priorities by row index (row i is tkt_000{i+1}). */
export const SEED_STATUS = ['open', 'open', 'pending', 'closed', 'open', 'pending', 'open', 'closed', 'open', 'pending', 'open'] as const;
export const SEED_PRIORITY = ['urgent', 'low', 'normal', 'urgent', 'high', 'urgent', 'normal', 'low', 'urgent', 'high', 'normal'] as const;

/** The ticket seed snippet. `statuses` lets mutations skew the state mix. */
export function ticketSeed(statuses: readonly string[] = SEED_STATUS, priorities: readonly string[] = SEED_PRIORITY): string {
  return `(ctx) => {
  const agents = ctx.rows('agent');
  const status = ${JSON.stringify(statuses)};
  const priority = ${JSON.stringify(priorities)};
  const topics = ['login fails', 'refund request', 'slow dashboard', 'billing error', 'export broken'];
  return status.map((s, i) => ({
    subject: 'Case ' + (i + 1) + ': ' + ctx.pick(topics),
    status: s,
    priority: priority[i % priority.length],
    ref_code: 'HD-' + (1001 + i),
    credit: ctx.int(0, 40) * 25,
    escalated: false,
    assignee: i % 4 === 2 ? null : agents[i % agents.length].id,
  }));
}`;
}

export const AGENT_SEED = `(ctx) => {
  const rows = [
    { name: 'Ava Stone', email: 'ava@example.test', on_call: true },
    { name: 'Ben Okafor', email: 'ben@example.test', on_call: false },
    { name: 'Chloe Park', email: 'chloe@example.test', on_call: false },
  ];
  ctx.rng();
  return rows;
}`;

/** Collect every row of a list route by following next_cursor. Used inside client snippets. */
const ALL = `const all = (path) => {
    const out = [];
    let cursor = null;
    do {
      const r = ctx.api('GET', path + (cursor ? '?cursor=' + cursor : ''));
      ctx.assert(r.status === 200, 'list ' + path + ' returned ' + r.status);
      for (const row of r.body.data) out.push(row);
      cursor = r.body.next_cursor;
    } while (cursor);
    return out;
  };`;

export const SNIPPETS = {
  escalate: `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (!t) ctx.fail(404, 'not_found', 'ticket not found');
  if (ctx.body.reason.trim() === '') ctx.fail(422, 'reason_blank', 'reason must not be blank');
  if (t.status === 'closed') ctx.fail(409, 'ticket_closed', 'a closed ticket cannot be escalated');
  const updated = ctx.db.update('ticket', t.id, { escalated: true, priority: 'urgent' });
  if (ctx.body.fail === true) ctx.fail(422, 'forced_failure', 'fail was requested after the write');
  return { status: 200, body: updated };
}`,
  job: (name: string) => `(ctx) => { ctx.db.create('job_run', { job: '${name}', at: ctx.now() }); }`,

  // easy
  easyGrader: `(ctx) => {
  const t = ctx.seed.list('ticket', { where: { ref_code: 'HD-1005' } })[0];
  if (!t) return 0;
  if (ctx.changes().some((c) => c.id !== t.id)) return 0;
  if (ctx.changes().some((c) => c.fields.some((f) => f !== 'status'))) return 0;
  const now = ctx.db.get('ticket', t.id);
  return now && now.status === 'pending' ? 1 : 0;
}`,
  easySolution: `(ctx) => {
  ${ALL}
  const t = all('/tickets').find((r) => r.ref_code === 'HD-1005');
  ctx.assert(t, 'HD-1005 not found');
  const r = ctx.api('PATCH', '/tickets/' + t.id, { status: 'pending' });
  ctx.assert(r.status === 200, 'patch returned ' + r.status);
}`,
  easyDecoyWrongTicket: `(ctx) => {
  const r = ctx.api('GET', '/tickets');
  const t = r.body.data[0];
  ctx.api('PATCH', '/tickets/' + t.id, { status: 'pending' });
}`,

  // medium
  mediumGrader: `(ctx) => {
  const targets = ctx.seed.list('ticket', { where: { status: 'open', priority: 'urgent' } });
  if (targets.length === 0) return 0;
  const ids = targets.map((t) => t.id);
  if (ctx.changes().some((c) => !ids.includes(c.id))) return 0;
  if (ctx.changes().some((c) => c.fields.some((f) => f !== 'status'))) return 0;
  const done = ids.filter((id) => { const r = ctx.db.get('ticket', id); return r && r.status === 'pending'; }).length;
  return done / ids.length;
}`,
  mediumSolution: `(ctx) => {
  ${ALL}
  for (const t of all('/tickets')) {
    if (t.status === 'open' && t.priority === 'urgent') {
      const r = ctx.api('PATCH', '/tickets/' + t.id, { status: 'pending' });
      ctx.assert(r.status === 200, 'patch returned ' + r.status);
    }
  }
}`,
  mediumDecoyFirstPage: `(ctx) => {
  const r = ctx.api('GET', '/tickets');
  for (const t of r.body.data) {
    if (t.status === 'open' && t.priority === 'urgent') ctx.api('PATCH', '/tickets/' + t.id, { status: 'pending' });
  }
}`,

  // hard
  hardGrader: `(ctx) => {
  const targets = ctx.seed.list('ticket').filter((t) => t.assignee === null && t.status !== 'closed');
  const onCall = ctx.seed.list('agent', { where: { on_call: true } })[0];
  if (targets.length === 0 || !onCall) return 0;
  const ids = targets.map((t) => t.id);
  if (ctx.changes().some((c) => c.entity !== 'ticket' || !ids.includes(c.id))) return 0;
  if (ctx.changes().some((c) => c.fields.some((f) => !['escalated', 'priority', 'assignee'].includes(f)))) return 0;
  let score = 0;
  for (const id of ids) {
    const r = ctx.db.get('ticket', id);
    if (r && r.escalated === true) score += 0.5;
    if (r && r.assignee === onCall.id) score += 0.5;
  }
  return score / ids.length;
}`,
  hardSolution: `(ctx) => {
  ${ALL}
  const onCall = all('/agents').find((a) => a.on_call === true);
  ctx.assert(onCall, 'no on-call agent');
  for (const t of all('/tickets')) {
    if (t.assignee === null && t.status !== 'closed') {
      const e = ctx.api('POST', '/tickets/' + t.id + '/escalate', { reason: 'unassigned' });
      ctx.assert(e.status === 200, 'escalate returned ' + e.status);
      const p = ctx.api('PATCH', '/tickets/' + t.id, { assignee: onCall.id });
      ctx.assert(p.status === 200, 'assign returned ' + p.status);
    }
  }
}`,
  hardDecoyFirstPage: `(ctx) => {
  const agents = ctx.api('GET', '/agents?on_call=true').body.data;
  const onCall = agents[0];
  for (const t of ctx.api('GET', '/tickets').body.data) {
    if (t.assignee === null && t.status !== 'closed') {
      ctx.api('POST', '/tickets/' + t.id + '/escalate', { reason: 'unassigned' });
      if (onCall) ctx.api('PATCH', '/tickets/' + t.id, { assignee: onCall.id });
    }
  }
}`,
  hardDecoyNoAssign: `(ctx) => {
  ${ALL}
  for (const t of all('/tickets')) {
    if (t.assignee === null && t.status !== 'closed') ctx.api('POST', '/tickets/' + t.id + '/escalate', { reason: 'unassigned' });
  }
}`,

  // world tests
  testEscalateOk: `(ctx) => {
  const r = ctx.api('POST', '/tickets/tkt_0001/escalate', { reason: 'customer is blocked' });
  ctx.assert(r.status === 200, 'escalate returned ' + r.status);
  ctx.assert(r.body.escalated === true, 'escalated flag not set');
  ctx.assert(r.body.priority === 'urgent', 'priority not raised');
}`,
  testEscalateAtomic: `(ctx) => {
  const before = ctx.api('GET', '/tickets/tkt_0002');
  const r = ctx.api('POST', '/tickets/tkt_0002/escalate', { reason: 'probe', fail: true });
  ctx.assert(r.status === 422, 'expected 422, got ' + r.status);
  const after = ctx.api('GET', '/tickets/tkt_0002');
  ctx.assert(JSON.stringify(before.body) === JSON.stringify(after.body), 'a failed escalate left a write behind');
}`,
  testIllegalTransition: `(ctx) => {
  const r = ctx.api('PATCH', '/tickets/tkt_0001', { status: 'closed' });
  ctx.assert(r.status >= 400 && r.status < 500, 'open -> closed was accepted with ' + r.status);
}`,
} as const;

/** A fresh deep copy of the fixture world. Mutate freely. */
export function baseWorld(): World {
  const world: World = {
    format: 1,
    meta: {
      name: 'redteam_desk',
      description: 'A tiny helpdesk used by the red-team suite.',
      resembles: 'Zendesk tickets API',
      source: 'hand',
      seed: 7,
      clock: { start: '2026-01-05T09:00:00.000Z', tick: '1s' },
      api: {
        list: { mode: 'cursor', dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' },
        error: { error: { code: '$code', message: '$message' } },
      },
    },
    entities: {
      agent: {
        description: 'A support agent.',
        idPrefix: 'agt',
        fields: {
          name: field<'string'>({ type: 'string', required: true, maxLength: 80 }),
          email: field<'string'>({ type: 'string', required: true, unique: true, format: 'email' }),
          on_call: field<'bool'>({ type: 'bool', default: false }),
        },
      },
      ticket: {
        description: 'A customer support ticket.',
        idPrefix: 'tkt',
        fields: {
          subject: field<'string'>({ type: 'string', required: true, maxLength: 120 }),
          status: field<'state'>({
            type: 'state', required: true, states: ['open', 'pending', 'closed'], initial: 'open',
            transitions: { open: ['pending'], pending: ['open', 'closed'], closed: [] },
          }),
          priority: field<'enum'>({ type: 'enum', required: true, values: ['low', 'normal', 'high', 'urgent'], default: 'normal' }),
          escalated: field<'bool'>({ type: 'bool', readonly: true, default: false }),
          ref_code: field<'string'>({ type: 'string', required: true, unique: true, pattern: '^HD-[0-9]{4}$' }),
          credit: field<'money'>({ type: 'money', currency: 'USD', min: 0, default: 0 }),
          assignee: field<'ref'>({ type: 'ref', entity: 'agent', nullable: true, onDelete: 'restrict' }),
        },
      },
      job_run: {
        description: 'One row per job firing, so job order is observable.',
        idPrefix: 'job',
        fields: {
          job: field<'enum'>({ type: 'enum', required: true, values: ['a', 'a_late', 'b'] }),
          at: field<'datetime'>({ type: 'datetime', required: true }),
        },
      },
    },
    routes: {
      list_tickets: { op: 'list', method: 'GET', path: '/tickets', entity: 'ticket', filters: ['status', 'priority', 'assignee'],
        search: ['subject'], sort: ['priority', 'credit'], pageSize: 3 },
      get_ticket: { op: 'get', method: 'GET', path: '/tickets/{id}', entity: 'ticket' },
      create_ticket: { op: 'create', method: 'POST', path: '/tickets', entity: 'ticket' },
      update_ticket: { op: 'update', method: 'PATCH', path: '/tickets/{id}', entity: 'ticket' },
      delete_ticket: { op: 'delete', method: 'DELETE', path: '/tickets/{id}', entity: 'ticket' },
      list_agents: { op: 'list', method: 'GET', path: '/agents', entity: 'agent', filters: ['on_call'], search: [], sort: [], pageSize: 1 },
      get_agent: { op: 'get', method: 'GET', path: '/agents/{id}', entity: 'agent' },
      create_agent: { op: 'create', method: 'POST', path: '/agents', entity: 'agent' },
      delete_agent: { op: 'delete', method: 'DELETE', path: '/agents/{id}', entity: 'agent' },
    },
    actions: {
      escalate: {
        method: 'POST', path: '/tickets/{id}/escalate', description: 'Escalate a ticket. Writes, then fails when body.fail is true.',
        input: {
          reason: field<'text'>({ type: 'text', required: true }),
          fail: field<'bool'>({ type: 'bool', default: false }),
        },
        handler: SNIPPETS.escalate,
      },
    },
    jobs: {
      a: { description: 'Hourly job a.', every: '1h', run: SNIPPETS.job('a') },
      a_late: { description: 'Half-hourly job a_late.', every: '30m', run: SNIPPETS.job('a_late') },
      b: { description: 'Hourly job b.', every: '1h', run: SNIPPETS.job('b') },
    },
    fixtures: {},
    seed: { agent: AGENT_SEED, ticket: ticketSeed(), job_run: '(ctx) => []' },
    tests: {
      escalate_ok: { description: 'Escalate sets the flag and raises priority.', script: SNIPPETS.testEscalateOk },
      escalate_atomic: { description: 'A failing escalate writes nothing.', script: SNIPPETS.testEscalateAtomic },
      illegal_transition: { description: 'open -> closed is refused.', script: SNIPPETS.testIllegalTransition },
    },
    tasks: {
      pend_hd1005: {
        difficulty: 'easy',
        instruction: 'Move the ticket with reference code HD-1005 to pending.',
        grader: SNIPPETS.easyGrader,
        solution: SNIPPETS.easySolution,
        decoys: [{ why: 'moves the first ticket on page 1 instead of HD-1005', script: SNIPPETS.easyDecoyWrongTicket }],
        alternatives: [],
      },
      pend_open_urgent: {
        difficulty: 'medium',
        instruction: 'Move every open ticket with urgent priority to pending.',
        grader: SNIPPETS.mediumGrader,
        solution: SNIPPETS.mediumSolution,
        decoys: [{ why: 'only first page of the ticket list', script: SNIPPETS.mediumDecoyFirstPage }],
        alternatives: [],
      },
      escalate_unassigned: {
        difficulty: 'hard',
        instruction: 'Escalate every ticket that has no assignee and is not closed (reason "unassigned"), then assign each one to the agent who is on call.',
        grader: SNIPPETS.hardGrader,
        solution: SNIPPETS.hardSolution,
        decoys: [
          { why: 'only first page of the ticket list', script: SNIPPETS.hardDecoyFirstPage },
          { why: 'escalates every target but never assigns them', script: SNIPPETS.hardDecoyNoAssign },
        ],
        alternatives: [],
      },
    },
  };
  return structuredClone(world);
}

/**
 * Hand-derived facts about baseWorld() after seeding. Literals only.
 * Row i of SEED_STATUS is tkt_000(i+1). Agents seed in order Ava, Ben, Chloe.
 */
export const FACTS = {
  clockStart: '2026-01-05T09:00:00.000Z',
  tickMs: 1000,
  counts: { agent: 3, ticket: 11, job_run: 0 },
  ticketIds: ['tkt_0001', 'tkt_0002', 'tkt_0003', 'tkt_0004', 'tkt_0005', 'tkt_0006', 'tkt_0007', 'tkt_0008', 'tkt_0009', 'tkt_0010', 'tkt_0011'],
  agentIds: ['agt_0001', 'agt_0002', 'agt_0003'],
  nextTicketId: 'tkt_0012',
  nextAgentId: 'agt_0004',
  statusCounts: { open: 6, pending: 3, closed: 2 },
  ticketPageSize: 3,
  /** Pages when listing /tickets with no filter and no limit. */
  ticketPages: [['tkt_0001', 'tkt_0002', 'tkt_0003'], ['tkt_0004', 'tkt_0005', 'tkt_0006'], ['tkt_0007', 'tkt_0008', 'tkt_0009'], ['tkt_0010', 'tkt_0011']],
  openTickets: ['tkt_0001', 'tkt_0002', 'tkt_0005', 'tkt_0007', 'tkt_0009', 'tkt_0011'],
  closedTickets: ['tkt_0004', 'tkt_0008'],
  pendingTickets: ['tkt_0003', 'tkt_0006', 'tkt_0010'],
  urgentTickets: ['tkt_0001', 'tkt_0004', 'tkt_0006', 'tkt_0009'],
  openUrgent: ['tkt_0001', 'tkt_0009'],
  unassigned: ['tkt_0003', 'tkt_0007', 'tkt_0011'],
  /** Ava Stone, the only on_call agent. Assigned to tkt_0001, tkt_0004 and tkt_0010. */
  onCallAgent: 'agt_0001',
  ticketsOfAgent: { agt_0001: ['tkt_0001', 'tkt_0004', 'tkt_0010'], agt_0002: ['tkt_0002', 'tkt_0005', 'tkt_0008'], agt_0003: ['tkt_0006', 'tkt_0009'] },
  hd1005: 'tkt_0005',
  /** Every ref_code is HD-(1000 + n) for tkt_000n. */
  refCodeOf: (id: string): string => `HD-${1000 + Number(id.slice(4))}`,
  /** advance('1h') straight after create or reset: (time, name) order. */
  jobsAfter1h: ['a_late', 'a', 'a_late', 'b'],
  jobTimesAfter1h: ['2026-01-05T09:30:00.000Z', '2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00.000Z'],
  /** advance('30m') then advance('30m'): same rows as one advance('1h'). */
  jobsAfter30m: ['a_late'],
  /** Grader scores by script, from the hand-computed end states. */
  scores: {
    pend_hd1005: { noop: 0, solution: 1, decoys: [0] },
    pend_open_urgent: { noop: 0, solution: 1, decoys: [0.5] },
    escalate_unassigned: { noop: 0, solution: 1, decoys: [1 / 3, 0.5] },
  },
  /** Successful writes the solutions make, in order. */
  solutionWrites: {
    pend_hd1005: ['PATCH /tickets/tkt_0005'],
    pend_open_urgent: ['PATCH /tickets/tkt_0001', 'PATCH /tickets/tkt_0009'],
    escalate_unassigned: [
      'POST /tickets/tkt_0003/escalate', 'PATCH /tickets/tkt_0003',
      'POST /tickets/tkt_0007/escalate', 'PATCH /tickets/tkt_0007',
      'POST /tickets/tkt_0011/escalate', 'PATCH /tickets/tkt_0011',
    ],
  },
} as const;

/** Repo-root prod/worlds, resolved from this file. */
export const PROD_WORLDS_DIR = fileURLToPath(new URL('../../../prod/worlds/', import.meta.url));

export type WorldUnderTest = { readonly name: string; readonly dir: string | null; readonly input: unknown };

/**
 * The base world plus every prod/worlds/* world that loads. While loadWorld is a stub,
 * prod worlds are skipped silently, because test/worlds.test.ts owns that failure.
 */
export async function worldsUnderTest(): Promise<readonly WorldUnderTest[]> {
  const out: WorldUnderTest[] = [{ name: 'redteam_base', dir: null, input: baseWorld() }];
  let names: string[] = [];
  try {
    names = (await readdir(PROD_WORLDS_DIR)).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = join(PROD_WORLDS_DIR, name);
    try {
      if (!(await stat(join(dir, 'world.yaml'))).isFile()) continue;
      const loaded = await loadWorld(dir);
      if (loaded.ok) out.push({ name, dir, input: loaded.value });
    } catch {
      // loadWorld not implemented yet, or the dir is unreadable.
    }
  }
  return out;
}
