/**
 * The state machine's initial-state rule on every write path (spec E10). A row is born in the
 * machine's initial state through the API, an action handler and a job. A seed snippet may start
 * a row in any declared state, because seed data is history (A-146). Transitions are checked on
 * every update, whichever path writes it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime, type ApiRequest, type HttpMethod } from '../src/engine/api.ts';
import { worldSchema, type World } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { seedState } from '../src/engine/store.ts';
import { bareWorld, checkedForTest } from './helpers/world.ts';

const host = createVmHost();
const START = '2026-01-01T00:00:00.000Z';
const req = (method: HttpMethod, path: string, body?: unknown): ApiRequest => ({ method, path, query: {}, body });

const BORN_RESOLVED = `(ctx) => ({ status: 201, body: ctx.db.create('ticket', { customer: ctx.body.customer, subject: 'born resolved', priority: 'low', status: 'resolved' }) })`;
const BORN_DEFAULT = `(ctx) => ({ status: 201, body: ctx.db.create('ticket', { customer: ctx.body.customer, subject: 'born default', priority: 'low' }) })`;
const BORN_OPEN_THEN_PENDING = `(ctx) => {
  const t = ctx.db.create('ticket', { customer: ctx.body.customer, subject: 'walks the machine', priority: 'low', status: 'open' });
  return { status: 201, body: ctx.db.update('ticket', t.id, { status: 'pending' }) };
}`;
const SKIP_A_STATE = `(ctx) => ({ status: 200, body: ctx.db.update('ticket', ctx.params.id, { status: 'resolved' }) })`;
const JOB_BORN_PENDING = `(ctx) => { ctx.db.create('ticket', { customer: 'cus_0001', subject: 'job row', priority: 'low', status: 'pending' }); }`;
const JOB_BORN_OPEN = `(ctx) => { ctx.db.create('ticket', { customer: 'cus_0001', subject: 'job row', priority: 'low' }); }`;

function worldWith(over: { jobRun?: string; seedTicket?: string } = {}): World {
  const bare = bareWorld();
  return worldSchema.parse({
    ...bare,
    meta: { ...bare.meta, clock: { start: START, tick: '1s' } },
    actions: {
      born_resolved: { method: 'POST', path: '/born/resolved', handler: BORN_RESOLVED, input: { customer: { type: 'ref', entity: 'customer', required: true } } },
      born_default: { method: 'POST', path: '/born/default', handler: BORN_DEFAULT, input: { customer: { type: 'ref', entity: 'customer', required: true } } },
      born_walk: { method: 'POST', path: '/born/walk', handler: BORN_OPEN_THEN_PENDING, input: { customer: { type: 'ref', entity: 'customer', required: true } } },
      skip_a_state: { method: 'POST', path: '/tickets/{id}/skip', handler: SKIP_A_STATE },
    },
    jobs: { make_row: { description: 'Makes a ticket.', every: '15m', run: over.jobRun ?? JOB_BORN_OPEN } },
    seed: { customer: bare.seed['customer'], ticket: over.seedTicket ?? bare.seed['ticket'] },
  });
}

/** A runtime with one customer (cus_0001) and no tickets. */
function empty(w: World) {
  const rt = runtime(checkedForTest(w), host);
  assert.equal(rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' })).status, 201);
  return rt;
}
const noSeed = (w: World): World => ({ ...w, seed: {} });

describe('initial state on the API', () => {
  it('refuses a ticket created in a state that is not initial, and accepts the initial one', () => {
    const rt = empty(noSeed(worldWith()));
    const bad = rt.call(req('POST', '/tickets', { customer: 'cus_0001', subject: 'x', priority: 'low', status: 'resolved' }));
    assert.equal(bad.status, 422);
    assert.match(JSON.stringify(bad.body), /state\.initial/);
    assert.equal(rt.call(req('POST', '/tickets', { customer: 'cus_0001', subject: 'x', priority: 'low', status: 'open' })).status, 201);
  });
});

describe('initial state in an action handler', () => {
  it('refuses a handler that creates a row born in a state that is not initial, and keeps no change', () => {
    const rt = empty(noSeed(worldWith()));
    const before = rt.dump();
    const res = rt.call(req('POST', '/born/resolved', { customer: 'cus_0001' }));
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body), /state\.initial/);
    assert.match(JSON.stringify(res.body), /open \(the initial state\)/);
    assert.deepEqual(rt.dump().tables['ticket'] ?? [], (before.tables['ticket'] ?? []));
  });

  it('gives a row the initial state when the handler leaves it out, and lets it walk the machine', () => {
    const rt = empty(noSeed(worldWith()));
    const a = rt.call(req('POST', '/born/default', { customer: 'cus_0001' }));
    assert.equal(a.status, 201);
    assert.equal((a.body as { status: string }).status, 'open');
    const b = rt.call(req('POST', '/born/walk', { customer: 'cus_0001' }));
    assert.equal(b.status, 201);
    assert.equal((b.body as { status: string }).status, 'pending');
  });

  it('refuses a handler update that skips a transition', () => {
    const rt = empty(noSeed(worldWith()));
    assert.equal(rt.call(req('POST', '/born/default', { customer: 'cus_0001' })).status, 201);
    const res = rt.call(req('POST', '/tickets/tkt_0001/skip', {}));
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(res.body), /state\.transition/);
  });
});

describe('initial state in a job', () => {
  it('reports a job that creates a row in a state that is not initial as failed, and writes nothing', () => {
    const rt = empty(noSeed(worldWith({ jobRun: JOB_BORN_PENDING })));
    const r = rt.advance('15m');
    assert.equal(r.jobsFailed.length, 1);
    assert.equal(r.jobsFailed[0]?.job, 'make_row');
    assert.match(r.jobsFailed[0]?.message ?? '', /open \(the initial state\)/);
    assert.equal((rt.dump().tables['ticket'] ?? []).length, 0);
  });

  it('lets a job create a row in the initial state', () => {
    const rt = empty(noSeed(worldWith({ jobRun: JOB_BORN_OPEN })));
    const r = rt.advance('15m');
    assert.deepEqual(r.jobsFailed, []);
    assert.equal((rt.dump().tables['ticket'] as unknown[]).length, 1);
  });
});

describe('initial state in a seed', () => {
  it('lets a seed start rows in any declared state, since seed data is history', () => {
    const seedTicket = `(ctx) => [
      { customer: ctx.rows('customer')[0].id, subject: 'old', priority: 'low', status: 'resolved' },
      { customer: ctx.rows('customer')[0].id, subject: 'mid', priority: 'low', status: 'pending' },
      { customer: ctx.rows('customer')[0].id, subject: 'new', priority: 'low' },
    ]`;
    const r = seedState(worldWith({ seedTicket }), host);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual([...r.state.tables['ticket']!.values()].map((t) => t['status']), ['resolved', 'pending', 'open']);
  });

  it('still refuses a seed state the machine does not declare', () => {
    const seedTicket = `(ctx) => [{ customer: ctx.rows('customer')[0].id, subject: 'x', priority: 'low', status: 'closed' }]`;
    assert.equal(seedState(worldWith({ seedTicket }), host).ok, false);
  });
});
