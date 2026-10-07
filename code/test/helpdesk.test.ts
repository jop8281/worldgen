/**
 * The golden helpdesk world (prod/worlds/helpdesk) beyond "it checks": seed shape and consistency,
 * the jobs (which world tests cannot reach, because client scripts cannot move the clock), and the
 * grader discrimination rules for every task: decoys below 1 and not trivial, every strict prefix of
 * the solution's writes below 1.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runtime, type CallRecord, type Runtime } from '../src/engine/api.ts';
import { check, type CheckedWorld } from '../src/engine/check.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { seedState, stateHash, type Row, type State } from '../src/engine/store.ts';
import { clientCtx, grade, stateFromDump } from '../src/engine/tasks.ts';
import { loadWorld } from '#engine';

const HELPDESK = fileURLToPath(new URL('../../prod/worlds/helpdesk/', import.meta.url));
const host = createVmHost();

async function load() {
  const loaded = await loadWorld(path.join(HELPDESK));
  if (!loaded.ok) assert.fail(JSON.stringify(loaded.error, null, 2));
  const report = check(loaded.value, host);
  if (!report.ok) assert.fail(`helpdesk failed check at ${report.reached}:\n${JSON.stringify(report.issues, null, 2)}`);
  const seeded = seedState(report.world, host);
  if (!seeded.ok) assert.fail(JSON.stringify(seeded.issue));
  return { report, world: report.world, seed: seeded.state };
}
let memo: ReturnType<typeof load> | null = null;
const helpdesk = (): ReturnType<typeof load> => (memo ??= load());

const S = '2026-03-02T09:00:00.000Z';
const minutes = (from: unknown, to: unknown): number => (Date.parse(String(to)) - Date.parse(String(from))) / 60_000;
const rowsOf = (state: State, entity: string): Row[] => [...(state.tables[entity]?.values() ?? [])];

type Call = { status: number; body: Record<string, unknown> };
function caller(rt: Runtime): (method: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown) => Call {
  return (method, p, body) => {
    const res = rt.call({ method, path: p, query: {}, body });
    return { status: res.status, body: res.body as Record<string, unknown> };
  };
}

describe('helpdesk seed', () => {
  it('has paging-sized tables: 60 customers, 12 agents, 12 policies, 39 shifts, 320 tickets', async () => {
    const { report } = await helpdesk();
    assert.deepEqual(report.stats.rows, {
      customer: 60, agent: 12, sla_policy: 12, oncall_shift: 39, ticket: 320, ticket_comment: 229, ticket_event: 1033,
    });
    assert.ok(report.stats.rows.ticket! >= 3 * 25);
  });

  it('covers every ticket state, none above 70%', async () => {
    const { report } = await helpdesk();
    const counts = report.stats.states['ticket.status']!;
    assert.deepEqual(counts, { new: 30, open: 90, pending: 30, escalated: 40, resolved: 85, closed: 45 });
    for (const [state, n] of Object.entries(counts)) {
      assert.ok(n > 0, `${state} is missing`);
      assert.ok(n / 320 <= 0.7, `${state} is ${n} of 320`);
    }
  });

  it('exercises every action in a world test', async () => {
    const { report } = await helpdesk();
    assert.deepEqual(report.stats.unexercisedActions, []);
    assert.equal(report.tests, 6);
  });

  it('has one SLA policy per tier and priority, stricter towards enterprise and urgent', async () => {
    const { seed } = await helpdesk();
    const table = Object.fromEntries(rowsOf(seed, 'sla_policy').map((p) => [p.code, p.resolution_minutes]));
    assert.deepEqual(table, {
      enterprise_urgent: 60, enterprise_high: 240, enterprise_normal: 480, enterprise_low: 1440,
      premium_urgent: 120, premium_high: 480, premium_normal: 1440, premium_low: 2880,
      standard_urgent: 240, standard_high: 1440, standard_normal: 2880, standard_low: 4320,
    });
  });

  it('staffs both on-call levels at clock.start, level 1 without gaps, level 2 with one 12h gap', async () => {
    const { seed } = await helpdesk();
    const shifts = rowsOf(seed, 'oncall_shift');
    const at = (level: number, t: string): unknown =>
      shifts.find((s) => s.level === level && minutes(s.starts_at, t) >= 0 && minutes(t, s.ends_at) > 0)?.agent_id ?? null;
    assert.equal(at(1, S), 'agt_0003');
    assert.equal(at(2, S), 'agt_0004');
    assert.equal(at(1, '2026-03-02T21:00:00.000Z'), 'agt_0006');
    assert.equal(at(2, '2026-03-02T21:00:00.000Z'), null);
    assert.equal(at(2, '2026-03-03T09:00:00.000Z'), 'agt_0011');
    assert.equal(at(1, '2026-02-23T09:00:00.000Z'), 'agt_0006');
    assert.equal(at(1, '2026-03-05T09:00:00.000Z'), null);
    const teams = Object.fromEntries(rowsOf(seed, 'agent').map((a) => [a.id, a.team]));
    assert.deepEqual([...new Set(shifts.map((s) => `${s.level}:${String(teams[String(s.agent_id)])}`))].sort(), ['1:tier2', '2:sre']);
  });

  it('keeps every ticket consistent with its state, its SLA policy and its on-call shift', async () => {
    const { seed } = await helpdesk();
    const tier = Object.fromEntries(rowsOf(seed, 'customer').map((c) => [c.id, c.tier]));
    const target = Object.fromEntries(rowsOf(seed, 'sla_policy').map((p) => [p.code, p.resolution_minutes]));
    const shifts = rowsOf(seed, 'oncall_shift');
    const onCall = (level: unknown, t: unknown): unknown =>
      shifts.find((s) => s.level === level && minutes(s.starts_at, t) >= 0 && minutes(t, s.ends_at) > 0)?.agent_id ?? null;
    const bad: string[] = [];
    for (const t of rowsOf(seed, 'ticket')) {
      const fail = (why: string): void => {
        bad.push(`${t.id} ${String(t.status)}: ${why}`);
      };
      if (t.sla_started_at !== t.created_at) fail('sla_started_at is not created_at');
      if (minutes(t.sla_started_at, t.sla_due_at) !== target[`${String(tier[String(t.customer_id)])}_${String(t.priority)}`]) fail('sla_due_at does not follow the tier policy');
      if (minutes(t.created_at, S) < 0 || minutes(t.updated_at, S) < 0 || minutes(t.created_at, t.updated_at) < 0) fail('created_at or updated_at out of order');
      const active = ['new', 'open', 'pending', 'escalated'].includes(String(t.status));
      if (active) {
        if (t.resolved_at !== null) fail('active with resolved_at');
        if (t.sla_breached !== minutes(t.sla_due_at, S) >= 0) fail('sla_breached does not match sla_due_at <= S');
      } else {
        if (minutes(t.created_at, t.resolved_at) <= 0) fail('resolved_at is not after created_at');
        if (t.sla_breached !== minutes(t.sla_due_at, t.resolved_at) > 0) fail('sla_breached does not match sla_due_at < resolved_at');
        const sinceResolved = minutes(t.resolved_at, S);
        if (t.status === 'resolved' && !(sinceResolved > 0 && sinceResolved < 72 * 60)) fail('resolved outside the last 72h');
        if (t.status === 'closed' && !(sinceResolved >= 73 * 60)) fail('closed less than 73h after resolution');
      }
      if (t.status === 'new' && (t.assignee_id !== null || t.escalation_level !== 0)) fail('new but assigned or escalated');
      if ((t.status === 'open' || t.status === 'pending') && (t.assignee_id === null || t.escalation_level !== 0 || t.escalated_at !== null)) fail('open or pending without assignee or with escalation');
      if (t.status === 'escalated' && onCall(t.escalation_level, t.escalated_at) !== t.assignee_id) fail('assignee is not the on-call agent at escalated_at');
      if (t.escalation_level === 2 && t.priority !== 'urgent') fail('level 2 is only reached by urgent tickets');
      if (t.priority === 'urgent' && ['new', 'open', 'pending'].includes(String(t.status)) && t.sla_breached) fail('urgent and breached, but sla_breach did not escalate it');
      if (t.priority === 'urgent' && t.status === 'escalated' && t.escalation_level === 1 && !(minutes(t.escalated_at, S) > 0 && minutes(t.escalated_at, S) < 60)) fail('urgent at level 1 for 60 minutes or more');
    }
    assert.deepEqual(bad, []);
  });

  it('uses plausible helpdesk text and keeps Acme Logistics to its four anchor tickets', async () => {
    const { seed } = await helpdesk();
    const tickets = rowsOf(seed, 'ticket');
    const subjects = new Set(tickets.map((t) => String(t.subject)));
    assert.ok(subjects.size >= 40, `${subjects.size} distinct subjects`);
    assert.deepEqual(tickets.filter((t) => /lorem|ipsum|test ticket/i.test(`${String(t.subject)} ${String(t.description)}`)).map((t) => t.id), []);
    assert.deepEqual(tickets.filter((t) => t.customer_id === 'cus_0001').map((t) => `${t.id} ${String(t.subject)}`), [
      'tkt_0001 Label printer offline in DC-3',
      'tkt_0002 Label printer jams on 4x6 stock',
      "tkt_0003 Can't export manifest CSV",
      'tkt_0004 Driver portal login loop',
    ]);
    const names = rowsOf(seed, 'customer').map((c) => String(c.name));
    assert.equal(new Set(names).size, 60);
    assert.deepEqual(names.filter((n) => n.includes('Acme')), ['Acme Logistics', 'Acme Paper Co.']);
  });

  it('derives one created event per ticket, every event inside its ticket lifetime', async () => {
    const { seed } = await helpdesk();
    const created = new Map<string, unknown>(rowsOf(seed, 'ticket').map((t) => [t.id, t.created_at]));
    const events = rowsOf(seed, 'ticket_event');
    const createdEvents = events.filter((e) => e.kind === 'created').map((e) => e.ticket_id);
    assert.equal(createdEvents.length, 320);
    assert.equal(new Set(createdEvents).size, 320);
    assert.deepEqual(events.filter((e) => minutes(created.get(String(e.ticket_id)), e.created_at) < 0 || minutes(e.created_at, S) < 0).map((e) => e.id), []);
    const kinds: Record<string, number> = {};
    for (const e of events) kinds[String(e.kind)] = (kinds[String(e.kind)] ?? 0) + 1;
    assert.deepEqual(kinds, { created: 320, assigned: 290, sla_breach: 194, escalated: 54, resolved: 130, closed: 45 });
  });
});

describe('helpdesk jobs', () => {
  it('sla_breach flags tkt_0005 at the 09:15 firing and escalates it to the level 1 on-call agent; escalation_timeout pages level 2 an hour later', async () => {
    const { world } = await helpdesk();
    const rt = runtime(world, host);
    const call = caller(rt);
    assert.equal(call('GET', '/tickets/tkt_0005').body.sla_due_at, '2026-03-02T09:10:00.000Z');
    rt.reset();
    assert.deepEqual(rt.advance('15m'), { jobsFired: ['escalation_timeout', 'sla_breach'], jobsFailed: [] });
    const t = call('GET', '/tickets/tkt_0005').body;
    assert.deepEqual([t.status, t.escalation_level, t.assignee_id, t.escalated_at, t.sla_breached], ['escalated', 1, 'agt_0003', '2026-03-02T09:15:00.000Z', true]);
    assert.equal(rt.advance('60m').jobsFailed.length, 0);
    const later = call('GET', '/tickets/tkt_0005').body;
    assert.deepEqual([later.escalation_level, later.assignee_id, later.escalated_at], [2, 'agt_0004', '2026-03-02T10:15:00.000Z']);
    const events = (call('GET', '/tickets/tkt_0005/events?sort=created_at').body.data as Row[]).map((e) => `${String(e.created_at)} ${String(e.kind)} ${String(e.note)}`);
    assert.deepEqual(events, [
      '2026-03-02T08:10:00.000Z created null',
      '2026-03-02T08:35:00.000Z assigned null',
      '2026-03-02T09:15:00.000Z sla_breach resolution target 2026-03-02T09:10:00.000Z passed',
      '2026-03-02T09:15:00.000Z escalated auto: SLA breach',
      '2026-03-02T10:15:00.000Z escalated auto: level 1 timeout',
    ]);
  });

  it('sla_breach gives a ticket created through POST /tickets its policy due time at the next firing', async () => {
    const { world } = await helpdesk();
    const rt = runtime(world, host);
    const call = caller(rt);
    assert.equal(call('POST', '/tickets', { subject: 'Driver app shows wrong route', customer_id: 'cus_0001', priority: 'normal' }).body.sla_due_at, null);
    rt.advance('15m');
    const t = call('GET', '/tickets/tkt_0321').body;
    assert.deepEqual([t.sla_started_at, t.sla_due_at, t.sla_breached, t.status], ['2026-03-02T09:00:00.000Z', '2026-03-02T17:00:00.000Z', false, 'new']);
  });

  it('escalation_timeout skips the level 2 gap and pages level 2 when its next shift starts', async () => {
    const { world } = await helpdesk();
    const rt = runtime(world, host);
    const call = caller(rt);
    rt.advance('11h');
    const created = call('POST', '/tickets', { subject: 'Warehouse scanners offline', customer_id: 'cus_0001', priority: 'urgent' });
    assert.deepEqual([created.status, created.body.id, created.body.created_at], [201, 'tkt_0321', '2026-03-02T20:00:00.000Z']);
    rt.advance('3h');
    const atNight = call('GET', '/tickets/tkt_0321').body;
    assert.deepEqual([atNight.status, atNight.escalation_level, atNight.assignee_id, atNight.escalated_at], ['escalated', 1, 'agt_0006', '2026-03-02T21:00:00.000Z']);
    rt.advance('10h');
    const morning = call('GET', '/tickets/tkt_0321').body;
    assert.deepEqual([morning.escalation_level, morning.assignee_id, morning.escalated_at], [2, 'agt_0011', '2026-03-03T09:00:00.000Z']);
  });

  it('auto_close closes a ticket 72h after it was resolved, and escalation fails with 409 no_oncall once the roster ends', async () => {
    const { world } = await helpdesk();
    const rt = runtime(world, host);
    const call = caller(rt);
    assert.equal(call('POST', '/tickets/tkt_0002/resolve', {}).body.resolved_at, S);
    assert.deepEqual(rt.advance('71h').jobsFailed, []);
    assert.equal(call('GET', '/tickets/tkt_0002').body.status, 'resolved');
    assert.deepEqual(rt.advance('1h').jobsFailed, []);
    const t = call('GET', '/tickets/tkt_0002').body;
    assert.deepEqual([t.status, t.updated_at], ['closed', '2026-03-05T09:00:00.000Z']);
    const before = rt.dump();
    const r = call('POST', '/tickets/tkt_0003/escalate', { reason: 'Still cannot export' });
    assert.equal(r.status, 409);
    assert.equal((r.body.error as { code: string }).code, 'no_oncall');
    assert.deepEqual(rt.dump(), before);
  });
});

/** Runs one client script from the seed on a fresh runtime. */
function runScript(world: CheckedWorld, seed: State, source: string): Runtime {
  const rt = runtime(world, host, seed);
  const compiled = host.compile('client', source, ['tasks']);
  if (!compiled.ok) assert.fail(compiled.issue.hint);
  const { ctx, failed } = clientCtx(rt);
  compiled.run(ctx);
  assert.equal(failed(), null);
  return rt;
}
function scoreOf(world: CheckedWorld, seed: State, taskId: string, rt: Runtime): number {
  const r = grade(world, seed, stateFromDump(world, rt.dump()), taskId, host, rt.journal(), rt.log());
  if (!r.ok) assert.fail(`${r.issue.code}: ${r.issue.hint}`);
  return r.score;
}
const writesOf = (log: readonly CallRecord[]): number[] =>
  log.flatMap((c, i) => (c.req.method !== 'GET' && c.res.status < 400 ? [i] : []));

describe('helpdesk tasks', () => {
  it('assignment rejects unrelated subject and priority changes on its target', async () => {
    const { world, seed } = await helpdesk();
    const rt = runtime(world, host, seed);
    const call = caller(rt);
    const task = 'assign_newest_acme_ticket';
    assert.equal(scoreOf(world, seed, task, rt), 0);
    assert.equal(call('POST', '/tickets/tkt_0004/assign', { agent_id: 'agt_0001' }).status, 200);
    assert.equal(scoreOf(world, seed, task, rt), 1);
    assert.equal(call('PATCH', '/tickets/tkt_0004', {
      subject: 'Unrelated overwritten subject', priority: 'urgent',
    }).status, 200);
    assert.equal(scoreOf(world, seed, task, rt), 0);
  });

  it('verify gives each task solution 1 and noop 0', async () => {
    const { report } = await helpdesk();
    assert.deepEqual(Object.entries(report.verdicts).map(([id, v]) => [id, v.difficulty, v.solution, v.noop, v.solutionCalls]), [
      ['assign_newest_acme_ticket', 'easy', 1, 0, 4],
      ['escalate_breached_printer_ticket', 'medium', 1, 0, 3],
      ['escalate_breached_enterprise_tickets', 'hard', 1, 0, 10],
    ]);
  });

  it('the runtime state hash after each reference run equals the verdict end-state hash', async () => {
    const { world, seed, report } = await helpdesk();
    for (const [id, task] of Object.entries(world.tasks)) {
      assert.ok(task.solution !== undefined, `${id} must carry its solution`);
      assert.equal(runScript(world, seed, task.solution).stateHash(), report.verdicts[id]?.endStateHash, id);
    }
  });

  it('instructions name no ids the agent should discover', async () => {
    const { world } = await helpdesk();
    for (const t of Object.values(world.tasks)) assert.doesNotMatch(t.instruction, /\b[a-z]{3}_\d{4}\b/);
  });

  it('every decoy writes, scores below 1, ends apart from noop and solution, and never hits a 5xx', async () => {
    const { world, seed } = await helpdesk();
    const scores: Record<string, number[]> = {};
    for (const [id, task] of Object.entries(world.tasks)) {
      assert.ok(task.solution !== undefined, `${id} must carry its solution`);
      const solved = stateHash(stateFromDump(world, runScript(world, seed, task.solution).dump()));
      scores[id] = task.decoys.map((d) => {
        const rt = runScript(world, seed, d.script);
        assert.ok(writesOf(rt.log()).length >= 1, `${id}: "${d.why}" made no successful write`);
        assert.deepEqual(rt.log().filter((c) => c.res.status >= 500).map((c) => c.req.path), [], d.why);
        const end = stateHash(stateFromDump(world, rt.dump()));
        assert.notEqual(end, stateHash(seed), `${id}: "${d.why}" ends in the noop state`);
        assert.notEqual(end, solved, `${id}: "${d.why}" ends in the solution state`);
        return scoreOf(world, seed, id, rt);
      });
    }
    assert.deepEqual(scores, {
      assign_newest_acme_ticket: [0, 0, 0, 0],
      escalate_breached_printer_ticket: [0, 0.7, 0, 0],
      escalate_breached_enterprise_tickets: [4 / 7, 0, 0, 0, 0, 0],
    });
  });

  it('medium and hard solutions read before they write, and every strict prefix of their writes scores below 1', async () => {
    const { world, seed } = await helpdesk();
    const prefixes: Record<string, number[]> = {};
    for (const [id, task] of Object.entries(world.tasks)) {
      assert.ok(task.solution !== undefined, `${id} must carry its solution`);
      const log = runScript(world, seed, task.solution).log();
      assert.deepEqual(log.filter((c) => c.res.status >= 400).map((c) => c.req.path), [], `${id}: solution hit an error`);
      const writes = writesOf(log);
      assert.ok(writes[0]! > 0, `${id}: the first call is a write`);
      prefixes[id] = writes.map((at) => {
        const rt = runtime(world, host, seed);
        for (const c of log.slice(0, at)) rt.call(c.req);
        return scoreOf(world, seed, id, rt);
      });
    }
    assert.deepEqual(prefixes, {
      assign_newest_acme_ticket: [0],
      escalate_breached_printer_ticket: [0],
      escalate_breached_enterprise_tickets: [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7],
    });
  });

  it('the hard task list spans two pages and three of its seven targets are on page 2', async () => {
    const { seed } = await helpdesk();
    const tier = Object.fromEntries(rowsOf(seed, 'customer').map((c) => [c.id, c.tier]));
    const list = rowsOf(seed, 'ticket').filter((t) => t.status === 'open' && t.priority === 'high' && t.sla_breached === true);
    assert.equal(list.length, 35);
    const targets = list.flatMap((t, i) => (tier[String(t.customer_id)] === 'enterprise' ? [`${i}:${t.id}`] : []));
    assert.deepEqual(targets, ['0:tkt_0001', '4:tkt_0033', '11:tkt_0095', '18:tkt_0145', '25:tkt_0214', '29:tkt_0254', '33:tkt_0293']);
  });
});
