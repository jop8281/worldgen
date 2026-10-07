import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changesSince, runtime, type ApiRequest, type HttpMethod, type Runtime } from '../src/engine/api.ts';
import type { CheckedWorld } from '../src/engine/check.ts';
import { worldSchema } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { bareWorld, checkedForTest } from './helpers/world.ts';

/**
 * Worlds here are bareWorld() variants with no seed (the start state is empty whether or not
 * engine-seed has landed), a fixed clock so every engine time is a literal, and a Stripe-like
 * error envelope so "the world's envelope" is visibly not the default one.
 */
const START = '2026-01-01T00:00:00.000Z';
const ENVELOPE = { error: { type: 'api_error', status: '$status', code: '$code', message: '$message' } };
const host = createVmHost();

const ESCALATE = `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'ticket.not_found', 'No ticket ' + ctx.params.id);
  ctx.db.update('ticket', t.id, { subject: t.subject + ' [' + ctx.body.reason + ']' });
  if (t.priority === 'urgent') ctx.fail(409, 'already_escalated', 'Ticket ' + t.id + ' is already urgent');
  const row = ctx.db.update('ticket', t.id, { priority: 'urgent', sla_due_at: ctx.time.plus(ctx.now(), ctx.body.minutes + 'm') });
  return { status: 200, body: { ticket: row, input: ctx.body } };
}`;
const BREAK = `(ctx) => {
  ctx.db.update('ticket', ctx.params.id, { subject: 'broken' });
  throw new Error('kaboom');
}`;
const FORCE_RESOLVE = `(ctx) => ({ status: 200, body: ctx.db.update('ticket', ctx.params.id, { status: 'resolved' }) })`;
const IMPORT = `(ctx) => ({ status: 201, body: ctx.db.create('ticket', ctx.body) })`;

type Over = { tick?: string; jobs?: Record<string, { every: string; run: string }>; withEvents?: boolean };

/** bareWorld plus test actions; `jobs` replaces bareWorld's jobs when given. */
function testWorld(over: Over = {}): CheckedWorld {
  const bare = bareWorld();
  return checkedForTest(worldSchema.parse({
    ...bare,
    meta: { ...bare.meta, clock: { start: START, tick: over.tick ?? '1s' }, api: { error: ENVELOPE } },
    entities: {
      ...bare.entities,
      ...(over.withEvents ? { event: { description: 'One job firing.', idPrefix: 'evt', fields: { name: { type: 'string', required: true } } } } : {}),
    },
    actions: {
      ...bare.actions,
      escalate_ticket: {
        method: 'POST', path: '/tickets/{id}/escalate', handler: ESCALATE,
        input: { reason: { type: 'string', required: true }, minutes: { type: 'int', min: 1, default: 60 } },
      },
      break_ticket: { method: 'POST', path: '/tickets/{id}/break', handler: BREAK },
      force_resolve: { method: 'POST', path: '/tickets/{id}/force-resolve', handler: FORCE_RESOLVE },
      import_ticket: {
        method: 'POST', path: '/import/tickets', handler: IMPORT,
        input: {
          customer: { type: 'ref', entity: 'customer', required: true },
          subject: { type: 'string', required: true },
          priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'], required: true },
          sla_due_at: { type: 'datetime', nullable: true },
        },
      },
    },
    jobs: over.jobs
      ? Object.fromEntries(Object.entries(over.jobs).map(([k, j]) => [k, { description: `test job ${k}`, ...j }]))
      : bare.jobs,
    seed: {},
  }));
}

const req = (method: HttpMethod, path: string, body?: unknown): ApiRequest => ({ method, path, query: {}, body });

function must(rt: Runtime, method: HttpMethod, path: string, body?: unknown): unknown {
  const res = rt.call(req(method, path, body));
  assert.ok(res.status < 300, `${method} ${path} failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Acme, then one open ticket tkt_0001 (low) and one urgent ticket tkt_0002. Ends at 00:00:03. */
function withTickets(over: Over = {}): Runtime {
  const rt = runtime(testWorld(over), host);
  must(rt, 'POST', '/customers', { name: 'Acme', tier: 'enterprise' });
  must(rt, 'POST', '/tickets', { customer: 'cus_0001', subject: 'Cannot log in', priority: 'low' });
  must(rt, 'POST', '/tickets', { customer: 'cus_0001', subject: 'Site is down', priority: 'urgent' });
  return rt;
}

const createdAt = (s: number): string => `2026-01-01T00:00:0${s}.000Z`;
const TKT1 = {
  id: 'tkt_0001', customer: 'cus_0001', subject: 'Cannot log in', priority: 'low', status: 'open', sla_due_at: null,
  created_at: createdAt(1), updated_at: createdAt(1),
};

describe('actions: input validation (acceptance 1)', () => {
  it('R1: a body with an unknown key, a wrong type and a value below min returns 400 with every problem, and the handler does not run', () => {
    const rt = withTickets();
    const before = rt.dump();
    const res = rt.call(req('POST', '/tickets/tkt_0001/escalate', { extra: true, reason: 5, minutes: 0 }));
    assert.deepEqual(res, {
      status: 400,
      body: { error: {
        type: 'api_error', status: 400, code: 'input.invalid',
        message: 'Invalid input for escalate_ticket: extra expected one of reason, minutes, found true; reason expected a string, found 5; minutes expected a whole number >= 1, found 0',
      } },
    });
    assert.deepEqual(rt.dump(), before);
  });

  it('R1: a missing required field and a null in a non-nullable field are reported with expected and found', () => {
    const rt = withTickets();
    const res = rt.call(req('POST', '/tickets/tkt_0001/escalate', { minutes: null }));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: {
      type: 'api_error', status: 400, code: 'input.invalid',
      message: 'Invalid input for escalate_ticket: reason expected a value (required), found missing; minutes expected a non-null value, found null',
    } });
  });

  it('R1: a body that is not a JSON object returns 400', () => {
    const rt = withTickets();
    const res = rt.call(req('POST', '/tickets/tkt_0001/escalate', ['vip']));
    assert.deepEqual(res, { status: 400, body: { error: { type: 'api_error', status: 400, code: 'body.invalid', message: 'Request body must be a JSON object' } } });
  });

  it('R2: a valid body reaches ctx.body with declared defaults filled in', () => {
    const rt = withTickets();
    const res = rt.call(req('POST', '/tickets/tkt_0001/escalate', { reason: 'vip' }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      input: { reason: 'vip', minutes: 60 },
      ticket: { ...TKT1, subject: 'Cannot log in [vip]', priority: 'urgent', sla_due_at: '2026-01-01T01:00:03.000Z', updated_at: '2026-01-01T00:00:03.000Z' },
    });
  });
});

describe('actions: handler writes and failures (acceptance 2, 3)', () => {
  it('R3: handler writes are privileged, so a handler sets a readonly field the API refuses', () => {
    const rt = withTickets();
    const body = { customer: 'cus_0001', subject: 'Imported', priority: 'high', sla_due_at: '2026-01-02T00:00:00.000Z' };
    assert.equal(rt.call(req('POST', '/tickets', body)).status, 422);
    const res = rt.call(req('POST', '/import/tickets', body));
    assert.deepEqual(res, {
      status: 201,
      body: {
        id: 'tkt_0003', customer: 'cus_0001', subject: 'Imported', priority: 'high', status: 'open', sla_due_at: '2026-01-02T00:00:00.000Z',
        created_at: '2026-01-01T00:00:03.000Z', updated_at: '2026-01-01T00:00:03.000Z',
      },
    });
  });

  it('R4: ctx.fail(409) returns the world envelope, keeps no write made before it, and does not move the clock', () => {
    const rt = withTickets();
    const before = rt.dump();
    const res = rt.call(req('POST', '/tickets/tkt_0002/escalate', { reason: 'again' }));
    assert.deepEqual(res, {
      status: 409,
      body: { error: { type: 'api_error', status: 409, code: 'already_escalated', message: 'Ticket tkt_0002 is already urgent' } },
    });
    assert.deepEqual(rt.dump(), before);
    assert.equal(rt.dump().now, '2026-01-01T00:00:03.000Z');
  });

  it('R4: ctx.fail(404) from a handler returns 404', () => {
    const rt = withTickets();
    const res = rt.call(req('POST', '/tickets/tkt_0099/escalate', { reason: 'x' }));
    assert.deepEqual(res, { status: 404, body: { error: { type: 'api_error', status: 404, code: 'ticket.not_found', message: 'No ticket tkt_0099' } } });
  });

  it('R5: a handler that throws returns 500 and leaves dump() unchanged', () => {
    const rt = withTickets();
    const before = rt.dump();
    const res = rt.call(req('POST', '/tickets/tkt_0001/break'));
    assert.deepEqual(res, { status: 500, body: { error: { type: 'api_error', status: 500, code: 'action.failed', message: 'Action break_ticket failed: kaboom' } } });
    assert.deepEqual(rt.dump(), before);
  });

  it('R6: a handler that writes an illegal state transition returns 422 and writes nothing', () => {
    const rt = withTickets();
    const before = rt.dump();
    const res = rt.call(req('POST', '/tickets/tkt_0001/force-resolve'));
    assert.deepEqual(res, {
      status: 422,
      body: { error: { type: 'api_error', status: 422, code: 'state.transition', message: 'ticket tkt_0001 status cannot move from open to resolved' } },
    });
    assert.deepEqual(rt.dump(), before);
  });

  it('bareWorld resolve_ticket resolves a pending ticket and refuses an open one with 409', () => {
    const rt = withTickets();
    assert.equal(rt.call(req('POST', '/tickets/tkt_0001/resolve')).status, 409);
    must(rt, 'PATCH', '/tickets/tkt_0001', { status: 'pending' });
    const res = rt.call(req('POST', '/tickets/tkt_0001/resolve'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ...TKT1, status: 'resolved', updated_at: '2026-01-01T00:00:04.000Z' });
  });
});

const ev = (name: string, at: string, n: number): Record<string, unknown> => ({ id: `evt_000${n}`, name, created_at: at, updated_at: at });
const T = (hhmm: string): string => `2026-01-01T${hhmm}:00.000Z`;
const job = (name: string): string => `(ctx) => { ctx.db.create('event', { name: '${name}' }); }`;

describe('jobs: firing on advance (acceptance 4)', () => {
  it('R7: advance(1h) fires a 15m job 4 times in time order, and now ends 1h later', () => {
    const rt = runtime(testWorld({ withEvents: true, jobs: { ping: { every: '15m', run: job('ping') } } }), host);
    assert.deepEqual(rt.advance('1h'), { jobsFired: ['ping', 'ping', 'ping', 'ping'], jobsFailed: [] });
    assert.equal(rt.dump().now, T('01:00'));
    assert.deepEqual(rt.dump().tables['event'], [ev('ping', T('00:15'), 1), ev('ping', T('00:30'), 2), ev('ping', T('00:45'), 3), ev('ping', T('01:00'), 4)]);
  });

  it('R7: two advances that together cross a job time fire it once', () => {
    const rt = runtime(testWorld({ withEvents: true, jobs: { ping: { every: '15m', run: job('ping') } } }), host);
    assert.deepEqual(rt.advance('10m').jobsFired, []);
    assert.deepEqual(rt.advance('10m').jobsFired, ['ping']);
    assert.deepEqual(rt.dump().tables['event'], [ev('ping', T('00:15'), 1)]);
  });

  it('R8: jobs due at the same instant fire in name order, not declaration order', () => {
    const rt = runtime(testWorld({
      withEvents: true,
      jobs: { zeta: { every: '30m', run: job('zeta') }, mid: { every: '15m', run: job('mid') }, alpha: { every: '30m', run: job('alpha') } },
    }), host);
    assert.deepEqual(rt.advance('1h').jobsFired, ['mid', 'alpha', 'mid', 'zeta', 'mid', 'alpha', 'mid', 'zeta']);
    assert.deepEqual(rt.dump().tables['event']!.map((r) => [r['name'], r['created_at']]), [
      ['mid', T('00:15')], ['alpha', T('00:30')], ['mid', T('00:30')], ['zeta', T('00:30')],
      ['mid', T('00:45')], ['alpha', T('01:00')], ['mid', T('01:00')], ['zeta', T('01:00')],
    ]);
  });

  it('R9: each firing is its own transaction; a failing firing rolls back alone', () => {
    const flaky = `(ctx) => {
      ctx.db.create('event', { name: 'flaky' });
      if (ctx.now() === '2026-01-01T00:45:00.000Z') throw new Error('flaky at 00:45');
    }`;
    const rt = runtime(testWorld({ withEvents: true, jobs: { flaky: { every: '15m', run: flaky } } }), host);
    assert.deepEqual(rt.advance('1h'), {
      jobsFired: ['flaky', 'flaky', 'flaky', 'flaky'],
      jobsFailed: [{ job: 'flaky', at: T('00:45'), message: 'flaky at 00:45' }],
    });
    assert.deepEqual(rt.dump().tables['event'], [ev('flaky', T('00:15'), 1), ev('flaky', T('00:30'), 2), ev('flaky', T('01:00'), 3)]);
    assert.equal(rt.dump().now, T('01:00'));
  });
});

describe('jobs: firing on a committed call tick (acceptance 5)', () => {
  it('R10: a committed call whose tick crosses a job time fires it; a failed call fires nothing', () => {
    const rt = runtime(testWorld({ tick: '15m', withEvents: true, jobs: { ping: { every: '15m', run: job('ping') } } }), host);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.dump().now, T('00:15'));
    assert.deepEqual(rt.dump().tables['event'], [ev('ping', T('00:15'), 1)]);
    assert.equal(rt.call(req('POST', '/customers', {})).status, 422);
    assert.equal(rt.dump().now, T('00:15'));
    assert.deepEqual(rt.dump().tables['event'], [ev('ping', T('00:15'), 1)]);
    assert.deepEqual(rt.log().map((c) => [c.seq, c.routeId, c.res.status]), [[1, 'list_customers', 200], [2, 'create_customer', 422]]);
  });
});

describe('origin journal and changesSince (acceptance 6)', () => {
  it('R11: the journal has one entry per committed call or firing that changed rows, and reset clears it', () => {
    const rt = runtime(testWorld({ withEvents: true, jobs: { ping: { every: '15m', run: job('ping') } } }), host);
    must(rt, 'GET', '/customers');
    must(rt, 'POST', '/customers', { name: 'Acme', tier: 'enterprise' });
    assert.equal(rt.call(req('POST', '/customers', { name: 'Acme', tier: 'pro' })).status, 409);
    rt.advance('15m');
    assert.deepEqual(rt.journal(), [
      { origin: 'call', source: 'create_customer', at: '2026-01-01T00:00:01.000Z', rows: [{ entity: 'customer', id: 'cus_0001', kind: 'created', fields: ['name', 'tier'] }] },
      { origin: 'job', source: 'ping', at: T('00:15'), rows: [{ entity: 'event', id: 'evt_0001', kind: 'created', fields: ['name'] }] },
    ]);
    rt.reset();
    assert.deepEqual(rt.journal(), []);
  });

  it('R12: created, updated and deleted rows, tagged call or job, without engine fields', () => {
    const rt = runtime(testWorld({ withEvents: true, jobs: { ping: { every: '15m', run: job('ping') } } }), host);
    must(rt, 'POST', '/customers', { name: 'Acme', tier: 'enterprise' });
    must(rt, 'POST', '/customers', { name: 'Initech', tier: 'free' });
    const seed = rt.dump();
    const mark = rt.journal().length;
    must(rt, 'DELETE', '/customers/cus_0001');
    must(rt, 'PATCH', '/customers/cus_0002', { tier: 'pro' });
    must(rt, 'POST', '/customers', { name: 'Globex', tier: 'pro' });
    must(rt, 'POST', '/customers', { name: 'Temp', tier: 'free' });
    must(rt, 'DELETE', '/customers/cus_0004');
    rt.advance('15m');
    assert.deepEqual(changesSince(seed, rt.dump(), rt.journal().slice(mark)), [
      { entity: 'customer', id: 'cus_0001', kind: 'deleted', fields: ['name', 'tier'], origin: 'call' },
      { entity: 'customer', id: 'cus_0002', kind: 'updated', fields: ['tier'], origin: 'call' },
      { entity: 'customer', id: 'cus_0003', kind: 'created', fields: ['name', 'tier'], origin: 'call' },
      { entity: 'event', id: 'evt_0001', kind: 'created', fields: ['name'], origin: 'job' },
    ]);
  });

  it('R12: an update back to the seed value is no change', () => {
    const rt = runtime(testWorld(), host);
    must(rt, 'POST', '/customers', { name: 'Acme', tier: 'enterprise' });
    const seed = rt.dump();
    must(rt, 'PATCH', '/customers/cus_0001', { tier: 'pro' });
    must(rt, 'PATCH', '/customers/cus_0001', { tier: 'enterprise' });
    assert.deepEqual(changesSince(seed, rt.dump(), rt.journal()), []);
  });
});

describe("bareWorld's escalate_overdue job through runtime.advance (acceptance 7)", () => {
  /** bareWorld's own job and resolve_ticket action; import_ticket only sets sla_due_at. */
  function scenario(): { rt: Runtime; seed: ReturnType<Runtime['dump']>; mark: number } {
    const rt = runtime(testWorld(), host);
    const imp = (subject: string, priority: string, sla?: string): unknown =>
      must(rt, 'POST', '/import/tickets', { customer: 'cus_0001', subject, priority, ...(sla ? { sla_due_at: sla } : {}) });
    must(rt, 'POST', '/customers', { name: 'Acme', tier: 'enterprise' }); // 00:00:00
    imp('Overdue', 'low', T('00:30')); // tkt_0001 at 00:00:01
    imp('Not due', 'normal', T('02:00')); // tkt_0002 at 00:00:02
    imp('Done', 'high', T('00:10')); // tkt_0003 at 00:00:03
    must(rt, 'PATCH', '/tickets/tkt_0003', { status: 'pending' }); // 00:00:04
    must(rt, 'POST', '/tickets/tkt_0003/resolve'); // 00:00:05
    imp('No SLA', 'low'); // tkt_0004 at 00:00:06
    imp('Late', 'normal', T('00:20')); // tkt_0005 at 00:00:07
    return { rt, seed: rt.dump(), mark: rt.journal().length };
  }

  it('R13: escalates only overdue, unresolved, non-urgent tickets, each at the firing that first finds it overdue', () => {
    const { rt } = scenario();
    assert.deepEqual(rt.advance('1h'), { jobsFired: ['escalate_overdue', 'escalate_overdue', 'escalate_overdue', 'escalate_overdue'], jobsFailed: [] });
    const row = (n: number, subject: string, priority: string, status: string, sla: string | null, updated: string) => ({
      id: `tkt_000${n}`, customer: 'cus_0001', subject, priority, status, sla_due_at: sla, created_at: createdAt(n === 4 ? 6 : n === 5 ? 7 : n), updated_at: updated,
    });
    assert.deepEqual(rt.dump().now, '2026-01-01T01:00:08.000Z');
    assert.deepEqual(rt.dump().tables['ticket'], [
      row(1, 'Overdue', 'urgent', 'open', T('00:30'), T('00:45')),
      row(2, 'Not due', 'normal', 'open', T('02:00'), createdAt(2)),
      row(3, 'Done', 'high', 'resolved', T('00:10'), createdAt(5)),
      row(4, 'No SLA', 'low', 'open', null, createdAt(6)),
      row(5, 'Late', 'urgent', 'open', T('00:20'), T('00:30')),
    ]);
  });

  it('R12, R13: job escalations are origin job; a row a call and a job both changed splits its fields by writer', () => {
    const { rt, seed, mark } = scenario();
    rt.advance('1h');
    must(rt, 'PATCH', '/tickets/tkt_0001', { subject: 'Overdue!' });
    must(rt, 'PATCH', '/tickets/tkt_0002', { subject: 'Not due yet' });
    // The journal slice that covers seed to end, as a grader's seed-to-end journal does.
    assert.deepEqual(changesSince(seed, rt.dump(), rt.journal().slice(mark)), [
      { entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['subject'], origin: 'call' },
      { entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['priority'], origin: 'job' },
      { entity: 'ticket', id: 'tkt_0002', kind: 'updated', fields: ['subject'], origin: 'call' },
      { entity: 'ticket', id: 'tkt_0005', kind: 'updated', fields: ['priority'], origin: 'job' },
    ]);
  });

  it('R12: a field a call writes after a job wrote it is origin call; the job keeps the fields only it wrote', () => {
    const { rt, seed, mark } = scenario();
    rt.advance('1h');
    must(rt, 'PATCH', '/tickets/tkt_0001', { subject: 'Overdue!', priority: 'high' });
    assert.deepEqual(rt.journal().slice(-1), [
      { origin: 'call', source: 'update_ticket', at: '2026-01-01T01:00:08.000Z', rows: [{ entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['subject', 'priority'] }] },
    ]);
    assert.deepEqual(changesSince(seed, rt.dump(), rt.journal().slice(mark)), [
      { entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['subject', 'priority'], origin: 'call' },
      { entity: 'ticket', id: 'tkt_0005', kind: 'updated', fields: ['priority'], origin: 'job' },
    ]);
  });

  it('R12: a row a call creates and a job then changes is created by call, updated by job', () => {
    const rt = runtime(testWorld(), host);
    must(rt, 'POST', '/customers', { name: 'Acme', tier: 'enterprise' });
    const seed = rt.dump();
    const mark = rt.journal().length;
    must(rt, 'POST', '/import/tickets', { customer: 'cus_0001', subject: 'Late', priority: 'low', sla_due_at: T('00:10') });
    rt.advance('15m');
    assert.deepEqual(changesSince(seed, rt.dump(), rt.journal().slice(mark)), [
      { entity: 'ticket', id: 'tkt_0001', kind: 'created', fields: ['customer', 'subject', 'status', 'sla_due_at'], origin: 'call' },
      { entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['priority'], origin: 'job' },
    ]);
  });
});

describe('actions: ref inputs, the largest tick and job failures on a call tick (YOS-69)', () => {
  it('a ref input naming no row is 400 input.invalid and the handler does not run', () => {
    const rt = withTickets();
    const before = rt.dump();
    const res = rt.call(req('POST', '/import/tickets', { customer: 'cus_0099', subject: 'x', priority: 'low' }));
    assert.deepEqual(res, { status: 400, body: { error: {
      type: 'api_error', status: 400, code: 'input.invalid',
      message: 'Invalid input for import_ticket: customer expected an existing customer id, found "cus_0099"',
    } } });
    assert.deepEqual(rt.dump(), before);
  });

  it('a ref input naming a row passes', () => {
    const rt = withTickets();
    assert.equal(rt.call(req('POST', '/import/tickets', { customer: 'cus_0001', subject: 'x', priority: 'low' })).status, 201);
  });

  it('the largest allowed tick does not throw on later calls; time stops at the Date limit', () => {
    const rt = runtime(testWorld({ tick: '97000000d', jobs: {} }), host);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.dump().now, '+275760-09-13T00:00:00.000Z');
  });

  it('a job that fails during a call\'s tick is in the response and in the log', () => {
    const boom = `(ctx) => { throw new Error('boom at ' + ctx.now()); }`;
    const rt = runtime(testWorld({ tick: '15m', jobs: { bad: { every: '15m', run: boom } } }), host);
    const failure = { job: 'bad', at: T('00:15'), message: 'boom at 2026-01-01T00:15:00.000Z' };
    const res = rt.call(req('GET', '/customers'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.jobsFailed, [failure]);
    const rec = rt.log()[0]!;
    assert.deepEqual(rec.jobsFired, ['bad']);
    assert.deepEqual(rec.jobsFailed, [failure]);
  });

  it('a call whose tick fails no job has no jobsFailed in the response and an empty one in the log', () => {
    const rt = runtime(testWorld({ tick: '15m', withEvents: true, jobs: { ping: { every: '15m', run: job('ping') } } }), host);
    const res = rt.call(req('GET', '/customers'));
    assert.deepEqual(res, { status: 200, body: { data: [], next_cursor: null } });
    assert.deepEqual(rt.log()[0]!.jobsFired, ['ping']);
    assert.deepEqual(rt.log()[0]!.jobsFailed, []);
  });
});

describe('runtime.call never throws; log records are copies (YOS-69 acceptance 4, 5)', () => {
  it('a tick with more than MAX_DUE_FIRINGS firings is a 500 engine.internal, the call is rolled back and logged', () => {
    const rt = runtime(testWorld({ tick: '97000000d', withEvents: true, jobs: { ping: { every: '15m', run: job('ping') } } }), host);
    const before = rt.dump();
    const res = rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    assert.deepEqual(res, { status: 500, body: { error: {
      type: 'api_error', status: 500, code: 'engine.internal',
      message: 'dueJobs window yields more than 100000 firings; advance in smaller steps',
    } } });
    assert.deepEqual(rt.dump(), before);
    assert.deepEqual(rt.journal(), []);
    assert.equal(rt.log().length, 1);
    assert.deepEqual(rt.log()[0]!.res, res);
    assert.deepEqual(rt.log()[0]!.jobsFired, []);
  });

  it('mutating the request body or the response body afterwards leaves the log unchanged, and records are frozen', () => {
    const rt = runtime(testWorld(), host);
    const body = { name: 'Acme', tier: 'enterprise' };
    const res = rt.call(req('POST', '/customers', body));
    body.name = 'Mutated';
    (res.body as { name: string }).name = 'Mutated too';
    const rec = rt.log()[0]!;
    assert.deepEqual(rec.req.body, { name: 'Acme', tier: 'enterprise' });
    assert.equal((rec.res.body as { name: string }).name, 'Acme');
    assert.equal(Object.isFrozen(rec.req.body), true);
    assert.equal(Object.isFrozen(rec.res.body), true);
    assert.equal(Object.isFrozen(rec.req.query), true);
  });
});
