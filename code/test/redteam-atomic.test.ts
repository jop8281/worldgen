/**
 * Runtime atomicity (G-08 to G-17, G-18, G-19, G-23, G-25).
 *
 * One test per kind of refused write. Each asserts a literal status (or the literal status
 * set the contract allows, see RT-16, RT-17, RT-43 and RT-46), that `dump()` is deep-equal to a copy taken
 * before the call, that `now` did not move, and that the body is the `meta.api.error`
 * envelope. Then three seeded properties over random 40-call sequences that mix valid and
 * invalid calls:
 * - a 2xx write moves `now` by exactly one tick, and a refused call changes nothing;
 * - replaying the same calls on a fresh runtime gives the same responses, dump and log;
 * - `reset()` returns to the seed dump and the runtime then behaves like a fresh one
 *   (log records compared without `seq`, see RT-47).
 * A failing property prints its seed and a ddmin-minimized call list.
 *
 * Env: REDTEAM_ITER sets the number of sequences per property (300 when unset), REDTEAM_SEED
 * the first seed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { checkWorld, createRuntime, type ApiRequest, type ApiResponse, type CheckedWorld, type Runtime, type StateDump, type World } from '#engine';
import { ITER, cap, clone, deepFreeze, failWithRepro, freshRuntime, opts, rng, seeds, type Rng } from './redteam/harness.ts';
import { FACTS, baseWorld, field } from './redteam/world.ts';

// ---------------------------------------------------------------------------------------
// File-local helpers

type Method = ApiRequest['method'];
type Json = Readonly<Record<string, unknown>>;

const RUNS = process.env['REDTEAM_ITER'] ? ITER : 300;
const SEQ_LEN = 40;

const ENFORCE = [400, 409, 422] as const; // RT-16: type, required, unique, transition, readonly
const REF = [400, 404, 409, 422] as const; // G-11 set, where RT-16 does not narrow it: ref resolution and onDelete
/** RT-46: a handler that throws or runs out of ctx calls gets some 4xx or 5xx. The docs name no status. */
const HANDLER_ERROR: readonly number[] = Array.from({ length: 200 }, (_, i) => 400 + i);
/** A runtime that answers calls; no seeded rows needed. */
const RUNTIME_CAPS = cap('createRuntime', 'runtime.call', 'runtime.dump');
/** Every trajectory starts from the literal seed rows (assertSeed), so it needs the seed unit. */
const SEEDED_CAPS = cap('createRuntime', 'runtime.call', 'runtime.dump', 'runtime.seed');
/** Seeded, and calls an action (escalate or a red-team handler). */
const ACTION_CAPS = cap('createRuntime', 'runtime.call', 'runtime.dump', 'runtime.seed', 'runtime.actions');

const req = (method: Method, path: string, body: unknown = null, query: Readonly<Record<string, string>> = {}): ApiRequest => ({ method, path, query, body });

/** A valid ticket create body. The ref code must be unused (seed uses HD-1001 to HD-1011). */
const newTicket = (ref = 'HD-2001'): Record<string, unknown> => ({ subject: 'Printer on fire', status: 'open', priority: 'high', ref_code: ref });
const newAgent = (email = 'dana@example.test'): Record<string, unknown> => ({ name: 'Dana Lee', email, on_call: false });

const show = (r: ApiRequest): string => `${r.method} ${r.path}${Object.keys(r.query).length ? ` ?${JSON.stringify(r.query)}` : ''} ${JSON.stringify(r.body)}`;

const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** `meta.api.error` is `{ error: { code: '$code', message: '$message' } }` in the base world (G-16). */
function envelopeProblem(body: unknown): string | null {
  if (!isObj(body)) return `body is not an object: ${JSON.stringify(body)}`;
  if (!isDeepStrictEqual(Object.keys(body), ['error'])) return `body keys are ${JSON.stringify(Object.keys(body))}, expected ["error"]`;
  const e = body['error'];
  if (!isObj(e)) return `error is not an object: ${JSON.stringify(e)}`;
  if (!isDeepStrictEqual(Object.keys(e).sort(), ['code', 'message'])) return `error keys are ${JSON.stringify(Object.keys(e))}`;
  if (typeof e['code'] !== 'string' || e['code'] === '' || e['code'] === '$code') return `error.code is ${JSON.stringify(e['code'])}`;
  if (typeof e['message'] !== 'string' || e['message'] === '' || e['message'] === '$message') return `error.message is ${JSON.stringify(e['message'])}`;
  return null;
}

/** A deep copy, so an engine that hands out its live state cannot make before == after trivially. */
const snap = (rt: Runtime): StateDump => clone(rt.dump());

/** Call, and assert the call was refused with a status in `statuses`, nothing changed and the body is the envelope. */
function refused(rt: Runtime, r: ApiRequest, statuses: readonly number[], label: string): ApiResponse {
  const before = snap(rt);
  const res = rt.call(r);
  const where = `${label}: ${show(r)}`;
  assert.ok(statuses.includes(res.status), `${where} returned ${res.status}, expected one of ${JSON.stringify(statuses)}. Body: ${JSON.stringify(res.body)}`);
  const after = rt.dump();
  assert.equal(after.now, before.now, `${where} moved the clock`);
  assert.deepEqual(after, before, `${where} was refused but changed the dump`);
  const env = envelopeProblem(res.body);
  assert.equal(env, null, `${where}: ${env}`);
  return res;
}

/** Call, and assert a 2xx. */
function accepted(rt: Runtime, r: ApiRequest, label: string): ApiResponse {
  const res = rt.call(r);
  assert.ok(res.status >= 200 && res.status < 300, `${label}: ${show(r)} returned ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

const idOf = (res: ApiResponse): unknown => (isObj(res.body) ? res.body['id'] : undefined);

/** The rows of one entity in a dump (id order, per the dump contract). */
const rowsOf = (d: StateDump, entity: string): readonly Json[] => (d.tables[entity] ?? []) as readonly Json[];
const idsOf = (d: StateDump, entity: string): unknown[] => rowsOf(d, entity).map((r) => r['id']);
/** One row by id. Fails the test when it is missing. */
function rowOf(d: StateDump, entity: string, id: string): Json {
  const r = rowsOf(d, entity).find((x) => x['id'] === id);
  assert.ok(r, `${entity} ${id} is not in the dump`);
  return r;
}
const tickAfter = (n: number): string => new Date(Date.parse(FACTS.clockStart) + n * FACTS.tickMs).toISOString();

/**
 * Literal anchors for a fresh runtime. Without them, "equal to a fresh runtime" could mean
 * "equal to an equally broken runtime" (empty tables, a clock that already moved).
 */
function assertSeed(d: StateDump, label: string): void {
  assert.equal(d.now, FACTS.clockStart, `${label}: a fresh runtime's clock`);
  assert.deepEqual(idsOf(d, 'ticket'), [...FACTS.ticketIds], `${label}: a fresh runtime's ticket ids`);
  assert.deepEqual(idsOf(d, 'agent'), [...FACTS.agentIds], `${label}: a fresh runtime's agent ids`);
  assert.deepEqual(rowsOf(d, 'job_run'), [], `${label}: a fresh runtime's job_run rows`);
}

/** A step of a trajectory: a call that must be refused, or one that must be accepted. */
type Step = { readonly refuse: ApiRequest; readonly statuses: readonly number[] } | { readonly accept: ApiRequest };
const no = (r: ApiRequest, statuses: readonly number[]): Step => ({ refuse: r, statuses });
const yes = (r: ApiRequest): Step => ({ accept: r });

type Trajectory = { readonly accepted: readonly ApiResponse[]; readonly refused: readonly ApiResponse[]; readonly dump: StateDump };

/**
 * Runs every step on runtime A and only the accepted steps on runtime B. Both are built
 * before any call. Refusals must leave no trace at all, now or later:
 * - after every step A's dump deep-equals B's, and B did not move while A was called;
 * - every accepted call gets a deep-equal response on A and B (so ids, ticks and leaked rows
 *   from a refusal show up here even when the dump hid them);
 * - B's clock reads start + one tick per accepted write (GETs may add 0 or 1, RT-02).
 * The accepted calls are positive controls: an engine that refuses everything fails here.
 */
function trajectory(make: () => Runtime, steps: readonly Step[], label: string): Trajectory {
  const a = make();
  const b = make();
  assertSeed(snap(a), label);
  assert.deepEqual(b.dump(), a.dump(), `${label}: two fresh runtimes differ`);
  const acc: ApiResponse[] = [];
  const ref: ApiResponse[] = [];
  let writes = 0;
  let gets = 0;
  for (const [i, s] of steps.entries()) {
    const where = `${label}, step ${i + 1}`;
    const bBefore = snap(b);
    if ('refuse' in s) {
      ref.push(clone(refused(a, s.refuse, s.statuses, where)));
      assert.deepEqual(b.dump(), bBefore, `${where}: a call on one runtime changed another runtime`);
    } else {
      const ra = clone(accepted(a, s.accept, `${where} (with the refusals)`));
      assert.deepEqual(b.dump(), bBefore, `${where}: a call on one runtime changed another runtime`);
      const rb = clone(accepted(b, s.accept, `${where} (without the refusals)`));
      assert.deepEqual(ra, rb, `${where}: ${show(s.accept)} answered differently once refused calls had run before it`);
      acc.push(ra);
      if (s.accept.method === 'GET') gets++;
      else writes++;
    }
    assert.deepEqual(a.dump(), b.dump(), `${where}: the runtime that saw refused calls differs from the one that did not`);
    const moved = (Date.parse(b.dump().now) - Date.parse(FACTS.clockStart)) / FACTS.tickMs;
    assert.ok(moved >= writes && moved <= writes + gets, `${where}: ${writes} accepted writes and ${gets} GETs moved now by ${moved} ticks`);
  }
  return { accepted: acc, refused: ref, dump: snap(a) };
}

// ---------------------------------------------------------------------------------------
// A world with extra handlers that write and then fail in every way a handler can fail.

const GO = field<'bool'>({ type: 'bool', default: false });

const HANDLERS = {
  /** Updates, creates two rows, then throws when go is true. */
  boom: `(ctx) => {
  ctx.db.update('ticket', ctx.params.id, { priority: 'low', escalated: true });
  ctx.db.create('ticket', { subject: 'Ghost ticket', status: 'open', priority: 'normal', ref_code: 'HD-9001' });
  ctx.db.create('agent', { name: 'Ghost Agent', email: 'ghost@example.test', on_call: false });
  if (ctx.body.go === true) throw new Error('handler exploded after writing');
  return { status: 200, body: {} };
}`,
  /** Creates, updates, then ctx.fail(409) when go is true. */
  mint: `(ctx) => {
  ctx.db.create('ticket', { subject: 'Minted ticket', status: 'open', priority: 'normal', ref_code: 'HD-9002' });
  ctx.db.update('ticket', ctx.params.id, { escalated: true, credit: 500 });
  if (ctx.body.go === true) ctx.fail(409, 'mint_refused', 'minting was refused after the write');
  return { status: 200, body: {} };
}`,
  /** Updates, then calls ctx forever when go is true, so only the call quota (or the guard) stops it. */
  spin: `(ctx) => {
  ctx.db.update('ticket', ctx.params.id, { priority: 'low' });
  if (ctx.body.go === true) { for (;;) ctx.db.get('ticket', ctx.params.id); }
  return { status: 200, body: {} };
}`,
  /** Two transitions in one transaction: open -> pending -> closed is open -> closed measured from before the transaction. */
  hop: `(ctx) => {
  ctx.db.update('ticket', ctx.params.id, { status: 'pending' });
  ctx.db.update('ticket', ctx.params.id, { status: 'closed' });
  return { status: 200, body: {} };
}`,
  /** One legal transition from a handler, the positive control for hop. */
  step: `(ctx) => {
  ctx.db.update('ticket', ctx.params.id, { status: 'pending' });
  return { status: 200, body: {} };
}`,
} as const;

function handlerWorld(): World {
  const w = baseWorld();
  for (const [name, handler] of Object.entries(HANDLERS)) {
    w.actions[name] = {
      method: 'POST', path: `/tickets/{id}/${name}`, description: `Red-team handler ${name}.`, input: { go: clone(GO) }, handler,
    };
  }
  return w;
}

let handlerChecked: CheckedWorld | null = null;
function handlerRuntime(): Runtime {
  if (!handlerChecked) {
    const r = checkWorld(handlerWorld());
    if (!r.ok) assert.fail(`the handler world does not check: ${JSON.stringify(r.issues, null, 2)}`);
    handlerChecked = r.world;
  }
  return createRuntime(handlerChecked);
}

const HANDLER_CAPS = cap('checkWorld', 'createRuntime', 'runtime.call', 'runtime.dump', 'runtime.seed', 'runtime.actions');

// ---------------------------------------------------------------------------------------
// One test per refused write kind

describe('refused writes change nothing', () => {
  it('G-11 G-14 type violations are refused with 400/409/422 and change nothing', SEEDED_CAPS, () => {
    const cases: readonly ApiRequest[] = [
      req('PATCH', '/tickets/tkt_0001', { credit: 12.5 }),
      req('PATCH', '/tickets/tkt_0001', { credit: -1 }),
      req('PATCH', '/tickets/tkt_0001', { credit: '1250' }),
      req('PATCH', '/tickets/tkt_0001', { priority: 'critical' }),
      req('PATCH', '/tickets/tkt_0001', { status: 'archived' }),
      req('PATCH', '/tickets/tkt_0001', { subject: 42 }),
      req('PATCH', '/tickets/tkt_0001', { subject: 'x'.repeat(121) }),
      req('PATCH', '/tickets/tkt_0001', { ref_code: 'hd-1' }),
      req('PATCH', '/tickets/tkt_0001', { subject: { nested: true } }),
      // A legal change next to an illegal one: the whole call is refused.
      req('PATCH', '/tickets/tkt_0002', { subject: 'Legal change', credit: 0.5 }),
      req('POST', '/tickets', { ...newTicket(), credit: 99.99 }),
      req('POST', '/tickets', { ...newTicket(), priority: 'URGENT' }),
      req('POST', '/agents', newAgent('not-an-email')),
      req('POST', '/agents', { ...newAgent(), on_call: 'true' }),
      req('POST', '/agents', { ...newAgent(), name: 'n'.repeat(81) }),
    ];
    const t = trajectory(freshRuntime, [
      ...cases.map((c) => no(c, ENFORCE)),
      // Positive controls at the edge of each rule: an engine that refuses too much fails here.
      yes(req('PATCH', '/tickets/tkt_0002', { subject: 'x'.repeat(120), credit: 0 })),
      yes(req('PATCH', '/tickets/tkt_0001', { ref_code: 'HD-1234', priority: 'low' })),
      yes(req('POST', '/tickets', { ...newTicket(), credit: 2500 })),
      yes(req('POST', '/agents', { ...newAgent(), name: 'n'.repeat(80), on_call: true })),
      // The new rows are checked as strictly as the seeded ones.
      no(req('PATCH', '/tickets/tkt_0012', { credit: 12.5 }), ENFORCE),
      no(req('PATCH', '/tickets/tkt_0012', { priority: 'critical' }), ENFORCE),
    ], 'type');
    assert.deepEqual(idsOf(t.dump, 'ticket'), [...FACTS.ticketIds, 'tkt_0012']);
    assert.deepEqual(idsOf(t.dump, 'agent'), [...FACTS.agentIds, 'agt_0004']);
    const t2 = rowOf(t.dump, 'ticket', 'tkt_0002');
    assert.equal(t2['subject'], 'x'.repeat(120));
    assert.equal(t2['credit'], 0);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['ref_code'], 'HD-1234');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['priority'], 'low');
    const t12 = rowOf(t.dump, 'ticket', 'tkt_0012');
    assert.equal(t12['credit'], 2500);
    assert.equal(t12['priority'], 'high');
    assert.equal(t12['subject'], 'Printer on fire');
    assert.equal(rowOf(t.dump, 'agent', 'agt_0004')['name'], 'n'.repeat(80));
    assert.equal(rowOf(t.dump, 'agent', 'agt_0004')['on_call'], true);
    assert.equal(t.dump.now, tickAfter(4));
  });

  it('G-11 missing required fields are refused with 400/409/422 and change nothing', ACTION_CAPS, () => {
    const without = (k: string): Record<string, unknown> => {
      const b = newTicket();
      delete b[k];
      return b;
    };
    const cases: readonly ApiRequest[] = [
      req('POST', '/tickets', without('subject')),
      req('POST', '/tickets', without('ref_code')),
      req('POST', '/tickets', { ...newTicket(), subject: null }),
      req('POST', '/agents', { name: 'No Email' }),
      req('POST', '/agents', { email: 'noname@example.test' }),
      req('PATCH', '/tickets/tkt_0001', { subject: null }),
      req('PATCH', '/tickets/tkt_0001', { ref_code: null }),
      req('POST', '/tickets/tkt_0001/escalate', {}),
    ];
    const t = trajectory(freshRuntime, [
      ...cases.map((c) => no(c, ENFORCE)),
      yes(req('POST', '/tickets', newTicket())),
      yes(req('POST', '/agents', newAgent())),
      yes(req('POST', '/tickets/tkt_0001/escalate', { reason: 'probe' })),
      no(req('PATCH', '/tickets/tkt_0012', { subject: null }), ENFORCE),
      no(req('POST', '/tickets/tkt_0012/escalate', {}), ENFORCE),
    ], 'required');
    assert.equal(idOf(t.accepted[0] as ApiResponse), FACTS.nextTicketId);
    assert.equal(idOf(t.accepted[1] as ApiResponse), FACTS.nextAgentId);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0012')['ref_code'], 'HD-2001');
    assert.equal(rowOf(t.dump, 'agent', 'agt_0004')['email'], 'dana@example.test');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['escalated'], true);
    assert.equal(t.dump.now, tickAfter(3));
  });

  it('G-11 unique violations are refused with 400/409/422 and change nothing', SEEDED_CAPS, () => {
    const t = trajectory(freshRuntime, [
      no(req('POST', '/tickets', newTicket('HD-1001')), ENFORCE),
      no(req('PATCH', '/tickets/tkt_0002', { ref_code: 'HD-1001' }), ENFORCE),
      no(req('PATCH', '/tickets/tkt_0011', { subject: 'Legal change', ref_code: 'HD-1005' }), ENFORCE),
      no(req('POST', '/agents', newAgent('ava@example.test')), ENFORCE),
      // A row keeping its own unique value is not a collision with itself.
      yes(req('PATCH', '/tickets/tkt_0005', { ref_code: 'HD-1005' })),
      // A value freed by an update or a delete can be taken again; the value taken is now refused.
      yes(req('PATCH', '/tickets/tkt_0001', { ref_code: 'HD-3001' })),
      yes(req('PATCH', '/tickets/tkt_0002', { ref_code: 'HD-1001' })),
      yes(req('DELETE', '/tickets/tkt_0011')),
      yes(req('POST', '/tickets', newTicket('HD-1011'))),
      no(req('POST', '/tickets', newTicket('HD-3001')), ENFORCE),
      no(req('PATCH', '/tickets/tkt_0003', { ref_code: 'HD-1001' }), ENFORCE),
      no(req('PATCH', '/tickets/tkt_0003', { ref_code: 'HD-1011' }), ENFORCE),
    ], 'unique');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['ref_code'], 'HD-3001');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0002')['ref_code'], 'HD-1001');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0012')['ref_code'], 'HD-1011');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0003')['ref_code'], 'HD-1003');
    assert.deepEqual(idsOf(t.dump, 'ticket'), [...FACTS.ticketIds.filter((id) => id !== 'tkt_0011'), 'tkt_0012']);
  });

  it('G-15 a ref that does not resolve is refused and changes nothing', SEEDED_CAPS, () => {
    const cases: readonly ApiRequest[] = [
      req('PATCH', '/tickets/tkt_0001', { assignee: 'agt_9999' }),
      req('PATCH', '/tickets/tkt_0003', { assignee: 'agt_0004' }), // the next id, not yet created
      req('PATCH', '/tickets/tkt_0001', { assignee: 'tkt_0002' }), // a row of the wrong entity
      req('PATCH', '/tickets/tkt_0001', { assignee: 42 }), // not an id at all: a type or a ref refusal
      req('POST', '/tickets', { ...newTicket(), assignee: 'agt_0000' }),
    ];
    const t = trajectory(freshRuntime, [
      ...cases.map((c) => no(c, REF)),
      yes(req('PATCH', '/tickets/tkt_0003', { assignee: 'agt_0002' })),
      yes(req('POST', '/agents', newAgent())),
      // agt_0004 exists now, so the ref that was refused above resolves.
      yes(req('PATCH', '/tickets/tkt_0007', { assignee: 'agt_0004' })),
      yes(req('POST', '/tickets', { ...newTicket(), assignee: 'agt_0001' })),
      no(req('PATCH', '/tickets/tkt_0003', { assignee: 'agt_0005' }), REF),
    ], 'unknown ref');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0003')['assignee'], 'agt_0002');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0007')['assignee'], 'agt_0004');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0012')['assignee'], 'agt_0001');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['assignee'], 'agt_0001');
  });

  it('G-15 deleting a row a restrict ref points at is refused and changes nothing', SEEDED_CAPS, () => {
    const [first, second] = FACTS.ticketsOfAgent.agt_0003;
    const t = trajectory(freshRuntime, [
      ...FACTS.agentIds.map((id) => no(req('DELETE', `/agents/${id}`), REF)),
      // One ref left is still a ref: the delete stays refused until nothing points at Chloe.
      yes(req('PATCH', `/tickets/${first}`, { assignee: null })),
      no(req('DELETE', '/agents/agt_0003'), REF),
      yes(req('PATCH', `/tickets/${second}`, { assignee: null })),
      yes(req('DELETE', '/agents/agt_0003')),
      no(req('GET', '/agents/agt_0003'), [404]),
      no(req('PATCH', '/tickets/tkt_0001', { assignee: 'agt_0003' }), REF),
      no(req('DELETE', '/agents/agt_0003'), [404]),
    ], 'restrict');
    assert.deepEqual(idsOf(t.dump, 'agent'), ['agt_0001', 'agt_0002']);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0006')['assignee'], null);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0009')['assignee'], null);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['assignee'], 'agt_0001');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0002')['assignee'], 'agt_0002');
  });

  it('G-13 standard create and update refuse readonly fields and change nothing', ACTION_CAPS, () => {
    const t = trajectory(freshRuntime, [
      no(req('PATCH', '/tickets/tkt_0001', { escalated: true }), ENFORCE),
      no(req('PATCH', '/tickets/tkt_0002', { priority: 'low', escalated: true }), ENFORCE),
      no(req('POST', '/tickets', { ...newTicket(), escalated: true }), ENFORCE),
      // Actions may set it (G-13), and once set a plain PATCH still cannot change it back.
      yes(req('POST', '/tickets/tkt_0002/escalate', { reason: 'probe' })),
      no(req('PATCH', '/tickets/tkt_0002', { escalated: false }), ENFORCE),
      yes(req('PATCH', '/tickets/tkt_0002', { priority: 'low' })),
    ], 'readonly');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0002')['escalated'], true);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0002')['priority'], 'low');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['escalated'], false);
  });

  it('G-12 an undeclared transition is refused and changes nothing', SEEDED_CAPS, () => {
    const t = trajectory(freshRuntime, [
      no(req('PATCH', '/tickets/tkt_0001', { status: 'closed' }), ENFORCE), // open -> closed
      no(req('PATCH', '/tickets/tkt_0004', { status: 'open' }), ENFORCE), // closed -> open
      no(req('PATCH', '/tickets/tkt_0008', { status: 'pending' }), ENFORCE), // closed -> pending
      no(req('PATCH', '/tickets/tkt_0009', { subject: 'Legal change', status: 'closed' }), ENFORCE),
      // Measured from the current value, not the seed: open -> pending -> closed is legal (G-12).
      yes(req('PATCH', '/tickets/tkt_0001', { status: 'pending' })),
      yes(req('PATCH', '/tickets/tkt_0001', { status: 'closed' })),
      no(req('PATCH', '/tickets/tkt_0001', { status: 'open' }), ENFORCE),
      no(req('PATCH', '/tickets/tkt_0001', { status: 'pending' }), ENFORCE),
      yes(req('PATCH', '/tickets/tkt_0003', { status: 'open' })), // pending -> open
      yes(req('PATCH', '/tickets/tkt_0009', { subject: 'Legal change' })),
    ], 'transition');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['status'], 'closed');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0003')['status'], 'open');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0009')['status'], 'open');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0009')['subject'], 'Legal change');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0004')['status'], 'closed');
  });

  it('G-12 two hops inside one handler are measured from before the transaction', HANDLER_CAPS, () => {
    const t = trajectory(handlerRuntime, [
      no(req('POST', '/tickets/tkt_0001/hop', {}), ENFORCE),
      // A single legal hop from a handler goes through, so hop is refused for the transition.
      yes(req('POST', '/tickets/tkt_0001/step', {})),
      no(req('POST', '/tickets/tkt_0007/hop', {}), ENFORCE),
      yes(req('PATCH', '/tickets/tkt_0001', { status: 'closed' })),
    ], 'hop');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['status'], 'closed');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0007')['status'], 'open');
  });

  it('G-09 escalate writes then ctx.fail(422): literal envelope, nothing written', ACTION_CAPS, () => {
    const t = trajectory(freshRuntime, [
      no(req('POST', '/tickets/tkt_0002/escalate', { reason: 'probe', fail: true }), [422]),
      no(req('POST', '/tickets/tkt_0004/escalate', { reason: 'probe' }), [409]),
      yes(req('POST', '/tickets/tkt_0002/escalate', { reason: 'probe' })),
      no(req('POST', '/tickets/tkt_0007/escalate', { reason: 'probe', fail: true }), [422]),
    ], 'handler fail');
    const fail = { error: { code: 'forced_failure', message: 'fail was requested after the write' } };
    assert.deepEqual(t.refused, [fail, { error: { code: 'ticket_closed', message: 'a closed ticket cannot be escalated' } }, fail].map((body, i) => ({ status: [422, 409, 422][i], body })));
    const t2 = rowOf(t.dump, 'ticket', 'tkt_0002');
    assert.equal(t2['escalated'], true);
    assert.equal(t2['priority'], 'urgent');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0007')['escalated'], false);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0007')['priority'], 'normal');
  });

  it('G-09 G-10 G-25 a handler that creates rows then ctx.fail(409) writes nothing and uses no id', HANDLER_CAPS, () => {
    const t = trajectory(handlerRuntime, [
      no(req('POST', '/tickets/tkt_0001/mint', { go: true }), [409]),
      yes(req('POST', '/tickets', newTicket())),
      // The same handler without the failure writes both rows, in one tick (G-25: per call, not per write).
      yes(req('POST', '/tickets/tkt_0001/mint', {})),
    ], 'mint');
    assert.deepEqual(t.refused[0]?.body, { error: { code: 'mint_refused', message: 'minting was refused after the write' } });
    assert.equal(idOf(t.accepted[0] as ApiResponse), FACTS.nextTicketId);
    assert.deepEqual(idsOf(t.dump, 'ticket'), [...FACTS.ticketIds, 'tkt_0012', 'tkt_0013']);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0013')['ref_code'], 'HD-9002');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['credit'], 500);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['escalated'], true);
    assert.equal(t.dump.now, tickAfter(2));
  });

  it('G-08 G-10 a handler that writes then throws is refused and writes nothing (RT-46)', HANDLER_CAPS, () => {
    const t = trajectory(handlerRuntime, [
      no(req('POST', '/tickets/tkt_0001/boom', { go: true }), HANDLER_ERROR),
      yes(req('POST', '/tickets', newTicket())),
      yes(req('POST', '/agents', newAgent())),
      // Without the throw, the same handler's three writes all land.
      yes(req('POST', '/tickets/tkt_0005/boom', {})),
      no(req('POST', '/tickets/tkt_0001/boom', { go: true }), HANDLER_ERROR),
    ], 'boom');
    assert.equal(idOf(t.accepted[0] as ApiResponse), FACTS.nextTicketId);
    assert.equal(idOf(t.accepted[1] as ApiResponse), FACTS.nextAgentId);
    assert.deepEqual(idsOf(t.dump, 'ticket'), [...FACTS.ticketIds, 'tkt_0012', 'tkt_0013']);
    assert.deepEqual(idsOf(t.dump, 'agent'), [...FACTS.agentIds, 'agt_0004', 'agt_0005']);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0013')['ref_code'], 'HD-9001');
    assert.equal(rowOf(t.dump, 'agent', 'agt_0005')['email'], 'ghost@example.test');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0005')['priority'], 'low');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0005')['escalated'], true);
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['priority'], 'urgent');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['escalated'], false);
  });

  it('G-08 G-23 a handler that writes then exhausts the ctx call quota is refused and writes nothing (RT-46)', opts(HANDLER_CAPS, { timeout: 60_000 }), () => {
    const t = trajectory(handlerRuntime, [
      no(req('POST', '/tickets/tkt_0001/spin', { go: true }), HANDLER_ERROR),
      yes(req('PATCH', '/tickets/tkt_0001', { priority: 'high' })),
      yes(req('POST', '/tickets/tkt_0001/spin', {})),
      no(req('POST', '/tickets/tkt_0005/spin', { go: true }), HANDLER_ERROR),
    ], 'spin');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0001')['priority'], 'low');
    assert.equal(rowOf(t.dump, 'ticket', 'tkt_0005')['priority'], 'high');
    // A quota counts ctx calls, so the answer is the same on every run (a wall-clock guard need not be).
    const again = handlerRuntime().call(req('POST', '/tickets/tkt_0001/spin', { go: true }));
    assert.deepEqual(clone(again), t.refused[0]);
  });

  it('G-08 a missing id gets 404 in the envelope and changes nothing (RT-17)', ACTION_CAPS, () => {
    const cases: readonly ApiRequest[] = [
      req('GET', '/tickets/tkt_9999'),
      req('GET', '/tickets/agt_0001'),
      req('PATCH', '/tickets/tkt_9999', { priority: 'low' }),
      req('PATCH', `/tickets/${FACTS.nextTicketId}`, { priority: 'low' }),
      req('DELETE', '/tickets/tkt_9999'),
      req('DELETE', '/agents/agt_9999'),
      // RT-43: the engine may 404 before the handler runs, or the handler's own ctx.fail(404) answers.
      req('POST', '/tickets/tkt_9999/escalate', { reason: 'probe' }),
    ];
    const gone: readonly ApiRequest[] = [
      req('GET', `/tickets/${FACTS.nextTicketId}`),
      req('PATCH', `/tickets/${FACTS.nextTicketId}`, { priority: 'low' }),
      req('DELETE', `/tickets/${FACTS.nextTicketId}`),
      req('POST', `/tickets/${FACTS.nextTicketId}/escalate`, { reason: 'probe' }),
    ];
    const t = trajectory(freshRuntime, [
      ...cases.map((c) => no(c, [404])),
      // The same routes find rows that exist, and lose them again once deleted.
      yes(req('GET', '/tickets/tkt_0001')),
      yes(req('GET', '/agents/agt_0002')),
      yes(req('POST', '/tickets', newTicket())),
      yes(req('PATCH', `/tickets/${FACTS.nextTicketId}`, { priority: 'low' })),
      yes(req('DELETE', `/tickets/${FACTS.nextTicketId}`)),
      ...gone.map((c) => no(c, [404])),
    ], 'missing id');
    assert.equal(idOf(t.accepted[0] as ApiResponse), 'tkt_0001');
    assert.equal(idOf(t.accepted[1] as ApiResponse), 'agt_0002');
    assert.equal(idOf(t.accepted[2] as ApiResponse), FACTS.nextTicketId);
    assert.deepEqual(idsOf(t.dump, 'ticket'), [...FACTS.ticketIds]);
  });

  it('G-09 an action on a missing id reaches the handler, whose ctx.fail(404) body is returned', opts(ACTION_CAPS), () => {
    const rt = freshRuntime();
    const esc = refused(rt, req('POST', '/tickets/tkt_9999/escalate', { reason: 'probe' }), [404], 'escalate missing');
    assert.deepEqual(esc.body, { error: { code: 'not_found', message: 'ticket not found' } });
  });
});

// ---------------------------------------------------------------------------------------
// Ids and ticks around refusals

describe('ids and ticks', () => {
  it('G-10 G-17 refused creates use no id, and deleted ids are never handed out again', SEEDED_CAPS, () => {
    const t = trajectory(freshRuntime, [
      no(req('POST', '/tickets', newTicket('HD-1001')), ENFORCE),
      no(req('POST', '/tickets', { ...newTicket(), escalated: true }), ENFORCE),
      no(req('POST', '/tickets', { ...newTicket(), assignee: 'agt_9999' }), REF),
      no(req('POST', '/agents', newAgent('ava@example.test')), ENFORCE),
      yes(req('POST', '/tickets', newTicket())),
      yes(req('POST', '/agents', newAgent())),
      no(req('POST', '/tickets', newTicket('HD-2001')), ENFORCE),
      yes(req('POST', '/tickets', newTicket('HD-2002'))),
      // Per-entity counters (G-17): a delete does not give its id back.
      yes(req('DELETE', '/tickets/tkt_0013')),
      yes(req('POST', '/tickets', newTicket('HD-2003'))),
      yes(req('DELETE', '/agents/agt_0004')),
      yes(req('POST', '/agents', newAgent('eve@example.test'))),
    ], 'ids');
    // Accepted steps 4 and 6 are deletes, whose body is not asserted (RT-37).
    assert.deepEqual([0, 1, 2, 4, 6].map((i) => idOf(t.accepted[i] as ApiResponse)), ['tkt_0012', 'agt_0004', 'tkt_0013', 'tkt_0014', 'agt_0005']);
    assert.deepEqual(idsOf(t.dump, 'ticket'), [...FACTS.ticketIds, 'tkt_0012', 'tkt_0014']);
    assert.deepEqual(idsOf(t.dump, 'agent'), [...FACTS.agentIds, 'agt_0005']);
  });

  it('G-25 a committed write moves now by exactly one tick and a refused one by 0', ACTION_CAPS, () => {
    const rt = freshRuntime();
    assert.equal(rt.dump().now, FACTS.clockStart);
    accepted(rt, req('PATCH', '/tickets/tkt_0005', { status: 'pending' }), 'patch');
    assert.equal(rt.dump().now, '2026-01-05T09:00:01.000Z');
    assert.equal(rowOf(rt.dump(), 'ticket', 'tkt_0005')['status'], 'pending');
    refused(rt, req('PATCH', '/tickets/tkt_0005', { status: 'archived' }), ENFORCE, 'bad state');
    refused(rt, req('DELETE', '/tickets/tkt_9999'), [404], 'missing');
    refused(rt, req('POST', '/tickets/tkt_0001/escalate', { reason: 'probe', fail: true }), [422], 'handler fail');
    assert.equal(rt.dump().now, '2026-01-05T09:00:01.000Z');
    accepted(rt, req('POST', '/tickets', newTicket()), 'create');
    assert.equal(rt.dump().now, '2026-01-05T09:00:02.000Z');
    accepted(rt, req('POST', '/tickets/tkt_0001/escalate', { reason: 'probe' }), 'escalate');
    assert.equal(rt.dump().now, '2026-01-05T09:00:03.000Z');
    accepted(rt, req('DELETE', '/tickets/tkt_0012'), 'delete');
    assert.equal(rt.dump().now, '2026-01-05T09:00:04.000Z');
  });
});

// ---------------------------------------------------------------------------------------
// Random call sequences

type Kind = 'patch' | 'createTicket' | 'createAgent' | 'deleteTicket' | 'deleteAgent' | 'escalate' | 'read' | 'unrouted';

/**
 * One generated call. `kind` says which route it hits and `target` which row; `unrouted` calls
 * hit no declared route (RT-03: 404 or 405). `illegal` marks a call that no state can accept:
 * a value of the wrong type, a readonly field, a missing required field, a ref to an id
 * nothing ever gets, or a forced failure. Requests are deep-frozen: an engine that writes to
 * its input fails loudly instead of corrupting the replay.
 */
type Gen = { readonly kind: Kind; readonly target: string; readonly illegal: boolean; readonly req: ApiRequest };

const TICKET_POOL = [...FACTS.ticketIds, 'tkt_0012', 'tkt_0013', 'tkt_0014', 'tkt_9999'];
const AGENT_POOL = [...FACTS.agentIds, 'agt_0004', 'agt_0005', 'agt_9999'];

function genCall(r: Rng): Gen {
  const t = r.pick(TICKET_POOL);
  const a = r.pick(AGENT_POOL);
  const g = (kind: Kind, q: ApiRequest, illegal = false, target = t): Gen => ({ kind, target, illegal, req: q });
  /** A PATCH whose body is legal or not depending on whether the picked value is in `bad`. */
  const patch = <T>(key: string, values: readonly T[], bad: readonly T[]): Gen => {
    const v = r.pick(values);
    return g('patch', req('PATCH', `/tickets/${t}`, { [key]: v }), bad.includes(v));
  };
  switch (r.int(0, 16)) {
    case 0: return patch('status', ['open', 'pending', 'closed', 'archived'], ['archived']);
    case 1: return patch<unknown>('priority', ['low', 'normal', 'high', 'urgent', 'critical', 3], ['critical', 3]);
    case 2: return patch<unknown>('credit', [0, 125, 2500, 12.5, -1, '100', null], [12.5, -1, '100']);
    case 3: return patch<unknown>('assignee', ['agt_0001', 'agt_0002', 'agt_0003', 'agt_0004', null, 'agt_9999', 'tkt_0001', 42], ['agt_9999', 'tkt_0001', 42]);
    case 4: return patch('escalated', [true, false], [true, false]);
    case 5: return patch<unknown>('subject', ['Renamed', '', 'x'.repeat(121), 42, null], ['x'.repeat(121), 42, null]);
    case 6: return patch<unknown>('ref_code', ['HD-1001', 'HD-1005', `HD-${3000 + r.int(0, 999)}`, 'hd-1', null], ['hd-1', null]);
    case 7: {
      const b = newTicket(r.pick([`HD-${2000 + r.int(0, 999)}`, 'HD-1003']));
      let illegal = false;
      switch (r.int(0, 7)) {
        case 0: delete b['subject']; illegal = true; break;
        case 1: b['escalated'] = true; illegal = true; break;
        case 2: b['assignee'] = r.pick(['agt_9999', 'agt_0002', 'agt_0004']); illegal = b['assignee'] === 'agt_9999'; break;
        case 3: b['credit'] = r.pick([1.5, -25, 300]); illegal = b['credit'] !== 300; break;
        case 4: b['status'] = r.pick(['closed', 'pending']); break; // RT-12: either outcome
        case 5: b['colour'] = 'red'; break; // RT-15: either outcome, never 5xx, never stored
        default: break;
      }
      return g('createTicket', req('POST', '/tickets', b), illegal, '');
    }
    case 8: {
      const email = r.pick(['ava@example.test', `u${r.int(0, 999)}@example.test`, 'not-an-email']);
      return g('createAgent', req('POST', '/agents', newAgent(email)), email === 'not-an-email', '');
    }
    case 9: return g('deleteTicket', req('DELETE', `/tickets/${t}`));
    case 10: return g('deleteAgent', req('DELETE', `/agents/${a}`), false, a);
    case 11: {
      const body = r.pick<Json>([{ reason: 'probe' }, { reason: 'probe', fail: true }, {}, { reason: 5 }]);
      return g('escalate', req('POST', `/tickets/${t}/escalate`, body), !isDeepStrictEqual(body, { reason: 'probe' }));
    }
    case 12: return g('read', req('GET', '/tickets', null, r.pick<Readonly<Record<string, string>>>([{}, { limit: '2' }, { status: 'open' }, { limit: '0' }, { cursor: 'garbage' }, { limit: 'abc' }])));
    case 13: return r.bool() ? g('read', req('GET', `/tickets/${t}`)) : g('read', req('GET', `/agents/${a}`), false, a);
    case 14: {
      const esc = r.bool(0.3);
      return g('patch', req('PATCH', `/tickets/${t}`, { priority: 'low', status: r.pick(['pending', 'closed']), ...(esc ? { escalated: true } : {}) }), esc);
    }
    case 15: {
      const body = r.pick<unknown>([null, [], 'status=open', {}]);
      return g('patch', req('PATCH', `/tickets/${t}`, body), Array.isArray(body) || typeof body === 'string');
    }
    default: {
      const u: readonly ApiRequest[] = [
        req('GET', '/widgets'),
        req('PUT', '/tickets/tkt_0001', { priority: 'low' }), // RT-30
        req('DELETE', '/tickets'),
        req('POST', '/tickets/tkt_0001', { priority: 'low' }),
        req('PATCH', '/agents/agt_0001', { on_call: true }), // no update route for agents
      ];
      return g('unrouted', r.pick(u), true, '');
    }
  }
}

function genSequence(seed: number): Gen[] {
  const r = rng(seed);
  return Array.from({ length: SEQ_LEN }, () => deepFreeze(genCall(r)));
}

const ms = (iso: string): number => Date.parse(iso);

// Literal facts read off baseWorld()'s field definitions, never off the engine.
const STATES: readonly unknown[] = ['open', 'pending', 'closed'];
const TRANSITIONS: Readonly<Record<string, readonly unknown[]>> = { open: ['pending'], pending: ['open', 'closed'], closed: [] };
const PRIORITIES: readonly unknown[] = ['low', 'normal', 'high', 'urgent'];
const ROW_META = ['id', 'created_at', 'updated_at']; // RT-34: may exist, never set by the API
const KEYS: Readonly<Record<'ticket' | 'agent', readonly string[]>> = {
  ticket: [...ROW_META, 'subject', 'status', 'priority', 'escalated', 'ref_code', 'credit', 'assignee'],
  agent: [...ROW_META, 'name', 'email', 'on_call'],
};

/** Facts every reachable state of the base world satisfies. Returns the first one broken. */
function stateViolation(d: StateDump): string | null {
  if (rowsOf(d, 'job_run').length !== 0) return 'job_run has rows although advance() was never called';
  for (const [entity, re] of [['ticket', /^tkt_\d{4}$/], ['agent', /^agt_\d{4}$/]] as const) {
    const ids = idsOf(d, entity);
    for (const id of ids) if (typeof id !== 'string' || !re.test(id)) return `${entity} id ${JSON.stringify(id)}`;
    if (!isDeepStrictEqual(ids, [...new Set(ids)].sort())) return `${entity} ids are not unique and in id order: ${JSON.stringify(ids)}`;
    for (const row of rowsOf(d, entity)) {
      const extra = Object.keys(row).filter((k) => !KEYS[entity].includes(k));
      if (extra.length > 0) return `${entity} ${String(row['id'])} stores undeclared fields ${JSON.stringify(extra)} (RT-15)`;
    }
  }
  const agents = new Set(idsOf(d, 'agent'));
  const refCodes = new Set<unknown>();
  for (const t of rowsOf(d, 'ticket')) {
    const bad = (f: string): string => `ticket ${String(t['id'])} holds ${f} = ${JSON.stringify(t[f])}`;
    const subject = t['subject'];
    if (typeof subject !== 'string' || subject.length > 120) return bad('subject');
    if (!STATES.includes(t['status'])) return bad('status');
    if (!PRIORITIES.includes(t['priority'])) return bad('priority');
    if (t['escalated'] !== undefined && typeof t['escalated'] !== 'boolean') return bad('escalated');
    const ref = t['ref_code'];
    if (typeof ref !== 'string' || !/^HD-[0-9]{4}$/.test(ref)) return bad('ref_code');
    if (refCodes.has(ref)) return `${bad('ref_code')}, which another ticket holds too`;
    refCodes.add(ref);
    const credit = t['credit'];
    if (credit !== undefined && credit !== null && !(Number.isSafeInteger(credit) && (credit as number) >= 0)) return bad('credit');
    const assignee = t['assignee'];
    if (assignee !== undefined && assignee !== null && !agents.has(assignee)) return `${bad('assignee')}, which is not an agent`;
  }
  const emails = new Set<unknown>();
  for (const a of rowsOf(d, 'agent')) {
    const bad = (f: string): string => `agent ${String(a['id'])} holds ${f} = ${JSON.stringify(a[f])}`;
    const name = a['name'];
    if (typeof name !== 'string' || name.length > 80) return bad('name');
    const email = a['email'];
    if (typeof email !== 'string' || !email.includes('@') || emails.has(email)) return bad('email');
    emails.add(email);
    if (a['on_call'] !== undefined && typeof a['on_call'] !== 'boolean') return bad('on_call');
  }
  return null;
}

const byId = (d: StateDump, entity: string): Map<unknown, Json> => new Map(rowsOf(d, entity).map((r) => [r['id'], r]));

/** Rows of `entity` other than `except` are deep-equal before and after. */
function othersKept(before: StateDump, after: StateDump, entity: string, except: unknown): string | null {
  const b = byId(before, entity);
  const a = byId(after, entity);
  for (const [id, row] of b) if (id !== except && !isDeepStrictEqual(a.get(id), row)) return `${entity} ${String(id)} changed or vanished`;
  return null;
}

/** What a committed call of each kind may change, and nothing else. */
function scopeViolation(g: Gen, before: StateDump, after: StateDump, res: ApiResponse): string | null {
  const kept = (e: string): string | null => (isDeepStrictEqual(rowsOf(before, e), rowsOf(after, e)) ? null : `${e} rows changed`);
  const sameIds = (e: string): string | null => (isDeepStrictEqual(idsOf(before, e), idsOf(after, e)) ? null : `${e} ids changed`);
  const added = (e: string): string | null => {
    const b = idsOf(before, e);
    const a = idsOf(after, e);
    const fresh = a.filter((id) => !b.includes(id));
    if (a.length !== b.length + 1 || fresh.length !== 1) return `${e} ids went from ${JSON.stringify(b)} to ${JSON.stringify(a)}, expected one new id`;
    const id = fresh[0];
    if (b.some((old) => String(old) >= String(id))) return `new ${e} id ${String(id)} is not above every existing id`;
    if (idOf(res) !== id) return `the response id ${JSON.stringify(idOf(res))} is not the new row ${String(id)} (RT-40)`;
    return othersKept(before, after, e, null);
  };
  const removed = (e: string, id: string): string | null =>
    isDeepStrictEqual(idsOf(after, e), idsOf(before, e).filter((x) => x !== id)) ? othersKept(before, after, e, id) : `${e} ids after deleting ${id}: ${JSON.stringify(idsOf(after, e))}`;
  const ticketBefore = byId(before, 'ticket').get(g.target);
  const ticketAfter = byId(after, 'ticket').get(g.target);
  switch (g.kind) {
    case 'read':
    case 'unrouted':
      return kept('ticket') ?? kept('agent');
    case 'patch': {
      const v = kept('agent') ?? sameIds('ticket') ?? othersKept(before, after, 'ticket', g.target);
      if (v) return v;
      if (!ticketBefore || !ticketAfter) return `PATCH of ${g.target} succeeded but the row is missing`;
      if (ticketAfter['escalated'] !== ticketBefore['escalated']) return 'a plain PATCH changed the readonly escalated field (G-13)';
      const from = ticketBefore['status'];
      const to = ticketAfter['status'];
      if (from !== to && !(TRANSITIONS[String(from)] ?? []).includes(to)) return `a PATCH moved ${g.target} from ${String(from)} to ${String(to)} (G-12)`;
      return null;
    }
    case 'createTicket': {
      const v = kept('agent') ?? added('ticket');
      if (v) return v;
      const row = byId(after, 'ticket').get(idOf(res));
      return row?.['escalated'] === true ? 'a plain create stored escalated: true (G-13)' : null;
    }
    case 'createAgent':
      return kept('ticket') ?? added('agent');
    case 'deleteTicket':
      return kept('agent') ?? removed('ticket', g.target);
    case 'deleteAgent': {
      const v = kept('ticket') ?? removed('agent', g.target);
      if (v) return v;
      const holder = rowsOf(before, 'ticket').find((t) => t['assignee'] === g.target);
      return holder ? `deleted ${g.target} while ${String(holder['id'])} pointed at it (G-15 restrict)` : null;
    }
    case 'escalate': {
      const v = kept('agent') ?? sameIds('ticket') ?? othersKept(before, after, 'ticket', g.target);
      if (v) return v;
      if (!ticketBefore || !ticketAfter) return `escalate of ${g.target} succeeded but the row is missing`;
      if (ticketBefore['status'] === 'closed') return 'escalated a closed ticket';
      if (ticketAfter['escalated'] !== true || ticketAfter['priority'] !== 'urgent') return `escalate left ${JSON.stringify(ticketAfter)}`;
      for (const f of ['subject', 'status', 'ref_code', 'credit', 'assignee']) {
        if (!isDeepStrictEqual(ticketAfter[f], ticketBefore[f])) return `escalate changed ${f}`;
      }
      return null;
    }
  }
}

/** Counts of outcomes per kind across a property run, so a too-strict engine cannot pass by refusing. */
type Tally = Map<string, number>;

/** Per-call invariants on one runtime. Returns the first violation, or null. */
function stepViolation(rt: Runtime, gens: readonly Gen[], tally?: Tally): string | null {
  const seedProblem = stateViolation(snap(rt));
  if (seedProblem) return `the seed breaks an invariant: ${seedProblem}`;
  for (const [i, g] of gens.entries()) {
    const before = snap(rt);
    let res: ApiResponse;
    try {
      res = clone(rt.call(g.req));
    } catch (e) {
      return `call ${i + 1} (${show(g.req)}) threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    const after = snap(rt);
    const at = `call ${i + 1} (${show(g.req)}) -> ${res.status} ${JSON.stringify(res.body)}`;
    if (!Number.isInteger(res.status) || res.status < 200 || res.status >= 500 || (res.status >= 300 && res.status < 400)) {
      return `${at}: status outside 2xx/4xx`;
    }
    const ok = res.status < 300;
    tally?.set(`${g.kind} ${ok ? '2xx' : '4xx'}`, (tally.get(`${g.kind} ${ok ? '2xx' : '4xx'}`) ?? 0) + 1);
    if (g.kind === 'unrouted' && res.status !== 404 && res.status !== 405) return `${at}: unrouted call, expected 404 or 405 (RT-03)`;
    if (g.illegal && ok) return `${at}: accepted a call that no state may accept (G-11, G-13)`;
    if (!ok) {
      if (!isDeepStrictEqual(after, before)) return `${at}: refused call changed the dump (now ${before.now} -> ${after.now})`;
      if (g.kind !== 'unrouted') {
        const env = envelopeProblem(res.body);
        if (env) return `${at}: ${env}`;
      }
      continue;
    }
    const moved = ms(after.now) - ms(before.now);
    if (g.req.method === 'GET') {
      if (moved !== 0 && moved !== FACTS.tickMs) return `${at}: a GET moved now by ${moved} ms (RT-02 allows 0 or one tick)`;
    } else if (moved !== FACTS.tickMs) {
      return `${at}: a committed write moved now by ${moved} ms, expected ${FACTS.tickMs}`;
    }
    const scope = scopeViolation(g, before, after, res);
    if (scope) return `${at}: ${scope}`;
    const inv = stateViolation(after);
    if (inv) return `${at}: ${inv}`;
  }
  return null;
}

type Trace = { readonly start: StateDump; readonly responses: readonly ApiResponse[]; readonly end: StateDump; readonly log: unknown };

function trace(rt: Runtime, gens: readonly Gen[]): Trace {
  const start = snap(rt);
  const responses = gens.map((g) => clone(rt.call(g.req)));
  return { start, responses, end: snap(rt), log: clone(rt.log()) };
}

function firstDiff(a: Trace, b: Trace): string | null {
  if (!isDeepStrictEqual(a.start, b.start)) return 'start dumps differ';
  for (let i = 0; i < a.responses.length; i++) {
    if (!isDeepStrictEqual(a.responses[i], b.responses[i])) {
      return `response ${i + 1} differs: ${JSON.stringify(a.responses[i])} vs ${JSON.stringify(b.responses[i])}`;
    }
  }
  if (!isDeepStrictEqual(a.end, b.end)) return 'final dumps differ';
  if (!isDeepStrictEqual(a.log, b.log)) return 'logs differ';
  return null;
}

/**
 * Two fresh runtimes fed the same calls in lockstep. Lockstep, not one after the other, so a
 * runtime that shares state with another (a module-level store, state cached on the checked
 * world, the last-created runtime winning) shows up as one call changing the other runtime.
 */
function replayViolation(gens: readonly Gen[]): string | null {
  try {
    const a = freshRuntime();
    const b = freshRuntime();
    if (!isDeepStrictEqual(snap(a), snap(b))) return 'two fresh runtimes have different dumps';
    for (const [i, g] of gens.entries()) {
      const bBefore = snap(b);
      const ra = clone(a.call(g.req));
      if (!isDeepStrictEqual(snap(b), bBefore)) return `call ${i + 1} (${show(g.req)}) on one runtime changed another runtime`;
      const rb = clone(b.call(g.req));
      if (!isDeepStrictEqual(ra, rb)) return `response ${i + 1} (${show(g.req)}) differs: ${JSON.stringify(ra)} vs ${JSON.stringify(rb)}`;
      if (!isDeepStrictEqual(snap(a), snap(b))) return `dumps differ after call ${i + 1} (${show(g.req)})`;
    }
    if (!isDeepStrictEqual(clone(a.log()), clone(b.log()))) return 'logs differ';
    return null;
  } catch (e) {
    return `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * RT-01 safe assumption: every successful call (GETs too) appears in the log in call order,
 * with the response it returned; failed calls may or may not appear; seq strictly increases.
 * `at` is engine time, so it lies between the start and end clocks and never goes back.
 */
function logViolation(t: Trace, gens: readonly Gen[]): string | null {
  if (!Array.isArray(t.log)) return 'log() is not an array';
  const recs = t.log as readonly unknown[];
  let prevSeq = -Infinity;
  let prevAt = ms(t.start.now);
  for (const [j, r] of recs.entries()) {
    if (!isObj(r)) return `log record ${j + 1} is not an object`;
    const seq = r['seq'];
    if (typeof seq !== 'number' || seq <= prevSeq) return `log seq not strictly increasing at record ${j + 1}`;
    prevSeq = seq;
    const at = typeof r['at'] === 'string' ? ms(r['at']) : NaN;
    if (!(at >= prevAt && at <= ms(t.end.now))) return `log record ${j + 1} has at ${JSON.stringify(r['at'])}, outside engine time ${t.start.now}..${t.end.now} or going back`;
    prevAt = at;
  }
  const is2xx = (i: number): boolean => {
    const s = t.responses[i]?.status ?? 0;
    return s >= 200 && s < 300;
  };
  // Compare method and path only: the engine may normalize the body or query it records.
  const matches = (r: Json, i: number): boolean => {
    const q = r['req'];
    const g = gens[i];
    return g !== undefined && isObj(q) && q['method'] === g.req.method && q['path'] === g.req.path && isDeepStrictEqual(r['res'], t.responses[i]);
  };
  let i = 0;
  for (const [j, r] of recs.entries()) {
    while (i < gens.length && !matches(r as Json, i)) {
      if (is2xx(i)) return `successful call ${i + 1} (${show((gens[i] as Gen).req)}) is missing from the log, or logged with another response`;
      i++;
    }
    if (i === gens.length) return `log record ${j + 1} ${JSON.stringify(r)} matches no call, in order`;
    i++;
  }
  for (; i < gens.length; i++) if (is2xx(i)) return `successful call ${i + 1} (${show((gens[i] as Gen).req)}) is missing from the log`;
  return null;
}

/** RT-47: whether `seq` restarts after reset() is open, so reset comparisons drop it. Order is still compared. */
function withoutSeq(t: Trace): Trace {
  if (!Array.isArray(t.log)) return t;
  return { ...t, log: t.log.map((r: unknown) => (isObj(r) ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'seq')) : r)) };
}

function resetViolation(gens: readonly Gen[]): string | null {
  try {
    const rt = freshRuntime();
    const seedDump = snap(rt);
    assertSeed(seedDump, 'seed before reset');
    const first = trace(rt, gens);
    const lv = logViolation(first, gens);
    if (lv) return lv;
    rt.reset();
    if (!isDeepStrictEqual(rt.dump(), seedDump)) return 'dump after reset() differs from the seed dump';
    if (rt.log().length !== 0) return `log() has ${rt.log().length} records after reset()`;
    const again = withoutSeq(trace(rt, gens));
    const d = firstDiff(again, withoutSeq(first));
    if (d) return `after reset(): ${d}`;
    const fresh = withoutSeq(trace(freshRuntime(), gens));
    const f = firstDiff(again, fresh);
    return f ? `reset runtime vs fresh runtime: ${f}` : null;
  } catch (e) {
    return `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Each kind of call must succeed and fail somewhere in a full run (skipped for short repro runs). */
const MUST_HAPPEN = ['patch 2xx', 'patch 4xx', 'createTicket 2xx', 'createTicket 4xx', 'createAgent 2xx', 'createAgent 4xx', 'deleteTicket 2xx', 'deleteAgent 2xx', 'deleteAgent 4xx', 'escalate 2xx', 'escalate 4xx', 'read 2xx', 'unrouted 4xx'];

describe(`random ${SEQ_LEN}-call sequences (${RUNS} per property)`, () => {
  const PROP_CAPS = opts(RUNTIME_CAPS, { timeout: 600_000 });
  /** The generated calls target seeded ids and escalate, and MUST_HAPPEN needs escalate outcomes. */
  const SEEDED_PROP_CAPS = opts(ACTION_CAPS, { timeout: 600_000 });

  it('G-08 G-11 G-25 every call keeps the invariants: a 2xx write moves now one tick and changes only its row, a refused call changes nothing', SEEDED_PROP_CAPS, () => {
    const tally: Tally = new Map();
    for (const seed of seeds(RUNS)) {
      const gens = genSequence(seed);
      const fails = (s: readonly Gen[]): boolean => stepViolation(freshRuntime(), s) !== null;
      const v = stepViolation(freshRuntime(), gens, tally);
      if (v) failWithRepro('G-08 G-25 step invariant', seed, gens, fails, v);
    }
    if (RUNS >= 25) {
      const missing = MUST_HAPPEN.filter((k) => !tally.get(k));
      assert.deepEqual(missing, [], `over ${RUNS} sequences these outcomes never happened: ${JSON.stringify(missing)}. Tally: ${JSON.stringify([...tally])}`);
    }
  });

  it('G-18 two runtimes fed the same calls in lockstep give the same responses, dumps and logs, and never touch each other', opts(PROP_CAPS, cap('runtime.log')), () => {
    for (const seed of seeds(RUNS)) {
      const gens = genSequence(seed);
      const v = replayViolation(gens);
      if (v) failWithRepro('G-18 replay', seed, gens, (s) => replayViolation(s) !== null, v);
    }
  });

  it('G-19 reset() returns to the seed dump, clears the log and then behaves like a fresh runtime', opts(cap('createRuntime', 'runtime.call', 'runtime.dump', 'runtime.seed', 'runtime.actions', 'runtime.log', 'runtime.reset'), { timeout: 600_000 }), () => {
    for (const seed of seeds(RUNS)) {
      const gens = genSequence(seed);
      const v = resetViolation(gens);
      if (v) failWithRepro('G-19 reset', seed, gens, (s) => resetViolation(s) !== null, v);
    }
  });
});
