import assert from 'node:assert/strict';
import { timeMath } from '../src/engine/clock.ts';
import { snippetDoc } from '../src/engine/ctx.ts';
import { describe, it } from 'node:test';
import type { Instant } from '../src/engine/clock.ts';
import type { SnippetHost } from '../src/engine/ctx.ts';
import { worldSchema, type World } from '../src/engine/format.ts';
import { EnforceError, uniqueClash, emptyState, initialState, stateHash, transact, type State, type Tx } from '../src/engine/store.ts';
import { bareWorld } from './helpers/world.ts';

/**
 * bareWorld() already has one ref (ticket.customer, restrict), one unique (customer.name),
 * one readonly (ticket.sla_due_at) and one state field (ticket.status). Local overrides add
 * a nullify ref (ticket.assignee) and a two-level cascade (comment -> ticket, reaction -> comment).
 */
function storeWorld(): World {
  const bare = bareWorld();
  const ticket = bare.entities['ticket']!;
  return worldSchema.parse({
    ...bare,
    entities: {
      ...bare.entities,
      agent: { description: 'A support agent.', idPrefix: 'agt', fields: { name: { type: 'string', required: true } } },
      ticket: {
        ...ticket,
        fields: { ...ticket.fields, assignee: { type: 'ref', entity: 'agent', onDelete: 'nullify', nullable: true } },
      },
      comment: {
        description: 'A reply on a ticket.',
        idPrefix: 'cmt',
        fields: { ticket: { type: 'ref', entity: 'ticket', onDelete: 'cascade', required: true }, body: { type: 'text', required: true } },
      },
      reaction: {
        description: 'An emoji on a comment.',
        idPrefix: 'rct',
        fields: { comment: { type: 'ref', entity: 'comment', onDelete: 'cascade', required: true }, emoji: { type: 'string', required: true } },
      },
    },
  });
}

const W = storeWorld();
const START = '2026-01-05T09:00:00.000Z';

/** Runs fn and returns the committed state. Fails the test on { ok: false }. */
function commit(state: State, fn: (tx: Tx) => unknown, world: World = W): State {
  const r = transact(world, state, fn);
  if (!r.ok) assert.fail(`expected ok, got ${r.error.status} ${r.error.code}: ${r.error.message}`);
  return r.state;
}

/** Runs fn and returns the error. Fails the test on { ok: true }. */
function refuse(state: State, fn: (tx: Tx) => unknown, world: World = W): EnforceError {
  const r = transact(world, state, fn);
  if (r.ok) assert.fail('expected the transaction to fail');
  return r.error;
}

/** Two customers (Acme cus_0001, Globex cus_0002) and one open ticket tkt_0001 for Acme. */
function seeded(): State {
  return commit(emptyState(W), (tx) => {
    tx.create('customer', { name: 'Acme', tier: 'pro' }, 'api');
    tx.create('customer', { name: 'Globex', tier: 'free' }, 'api');
    tx.create('ticket', { customer: 'cus_0001', subject: 'Cannot log in', priority: 'low' }, 'api');
  });
}

const atState = (s: State, iso: string): State => ({ ...s, now: Date.parse(iso) as Instant });

describe('emptyState and initialState', () => {
  it('R18 has one empty table and a zero counter per entity, and now at meta.clock.start', () => {
    const s = emptyState(W);
    assert.deepEqual(Object.keys(s.tables).sort(), ['agent', 'comment', 'customer', 'reaction', 'ticket']);
    assert.equal(s.tables['ticket']!.size, 0);
    assert.deepEqual(s.counters, { agent: 0, comment: 0, customer: 0, reaction: 0, ticket: 0 });
    assert.equal(s.now, 1767603600000);
  });

  it('R17 initialState of a world with no seed snippets is the empty state', () => {
    const host = {} as SnippetHost;
    const unseeded: World = { ...W, seed: {} };
    const s = initialState(unseeded, host);
    assert.deepEqual(s, emptyState(unseeded));
    assert.equal(stateHash(s), stateHash(emptyState(unseeded)));
  });
});

describe('create', () => {
  it('R1 assigns <idPrefix>_0001 then _0002, with a counter per entity', () => {
    const s = commit(emptyState(W), (tx) => {
      assert.equal(tx.create('customer', { name: 'Acme', tier: 'pro' }, 'api').id, 'cus_0001');
      assert.equal(tx.create('customer', { name: 'Globex', tier: 'pro' }, 'api').id, 'cus_0002');
      assert.equal(tx.create('agent', { name: 'Ann' }, 'api').id, 'agt_0001');
    });
    assert.deepEqual(s.counters, { agent: 1, comment: 0, customer: 2, reaction: 0, ticket: 0 });
    const s2 = commit(s, (tx) => tx.create('customer', { name: 'Initech', tier: 'free' }, 'api'));
    assert.equal(s2.tables['customer']!.has('cus_0003' as never), true);
  });

  it('R2 sets created_at and updated_at to engine time, fills defaults and the initial state', () => {
    const s = commit(atState(emptyState(W), '2026-03-02T10:30:00.000Z'), (tx) => {
      tx.create('customer', { name: 'Acme', tier: 'pro' }, 'api');
      const t = tx.create('ticket', { customer: 'cus_0001', subject: 'Hi', priority: 'low' }, 'api');
      assert.deepEqual({ ...t }, {
        id: 'tkt_0001',
        customer: 'cus_0001',
        subject: 'Hi',
        priority: 'low',
        status: 'open',
        sla_due_at: null,
        assignee: null,
        created_at: '2026-03-02T10:30:00.000Z',
        updated_at: '2026-03-02T10:30:00.000Z',
      });
    });
    assert.equal(s.tables['ticket']!.get('tkt_0001' as never)!.created_at, '2026-03-02T10:30:00.000Z');
  });
});

describe('get and list', () => {
  it('R3 list returns rows ordered by id and filters by where', () => {
    const s = commit(seeded(), (tx) => {
      tx.create('ticket', { customer: 'cus_0002', subject: 'B', priority: 'high' }, 'api');
      tx.create('ticket', { customer: 'cus_0001', subject: 'C', priority: 'high' }, 'api');
    });
    commit(s, (tx) => {
      assert.deepEqual(tx.list('ticket').map((r) => r.id), ['tkt_0001', 'tkt_0002', 'tkt_0003']);
      assert.deepEqual(tx.list('ticket', { where: { customer: 'cus_0001' } }).map((r) => r.id), ['tkt_0001', 'tkt_0003']);
      assert.deepEqual(tx.list('ticket', { where: { customer: 'cus_0001', priority: 'high' } }).map((r) => r.id), ['tkt_0003']);
      assert.equal(tx.get('ticket', 'tkt_0002')!.subject, 'B');
      assert.equal(tx.get('ticket', 'tkt_0009'), null);
    });
  });

  it('R3 list sees writes made earlier in the same transaction', () => {
    commit(seeded(), (tx) => {
      tx.delete('ticket', 'tkt_0001');
      tx.create('customer', { name: 'Initech', tier: 'free' }, 'api');
      assert.deepEqual(tx.list('ticket'), []);
      assert.deepEqual(tx.list('customer').map((r) => r.name), ['Acme', 'Globex', 'Initech']);
    });
  });

  it('R3 orders ids past _9999 numerically', () => {
    const base = emptyState(W);
    const s: State = { ...base, counters: { ...base.counters, agent: 9998 } };
    commit(s, (tx) => {
      tx.create('agent', { name: 'a' }, 'api');
      tx.create('agent', { name: 'b' }, 'api');
      assert.deepEqual(tx.list('agent').map((r) => r.id), ['agt_9999', 'agt_10000']);
    });
  });
});

describe('enforcement on every write', () => {
  it('R4 refuses a value of the wrong type with field, expected and found', () => {
    const e = refuse(seeded(), (tx) => tx.create('customer', { name: 'Hooli', tier: 'gold' }, 'api'));
    assert.equal(e instanceof EnforceError, true);
    assert.equal(e.status, 422);
    assert.equal(e.code, 'field.type');
    assert.deepEqual(e.problems, [{ field: 'tier', expected: 'one of free, pro, enterprise', found: '"gold"' }]);
  });

  it('R4 refuses a wrong type on update too', () => {
    const e = refuse(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { subject: 42 }, 'api'));
    assert.equal(e.status, 422);
    assert.deepEqual(e.problems, [{ field: 'subject', expected: 'a string', found: '42' }]);
  });

  it('R5 refuses a missing required field', () => {
    const e = refuse(seeded(), (tx) => tx.create('customer', { name: 'Hooli' }, 'api'));
    assert.equal(e.status, 422);
    assert.equal(e.code, 'field.required');
    assert.deepEqual(e.problems, [{ field: 'tier', expected: 'a value (required)', found: 'missing' }]);
  });

  it('R6 refuses null on a non-nullable field and stores null on a nullable one', () => {
    const e = refuse(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { subject: null }, 'api'));
    assert.equal(e.status, 422);
    assert.equal(e.code, 'field.null');
    assert.deepEqual(e.problems, [{ field: 'subject', expected: 'a string', found: 'null' }]);
    const s = commit(seeded(), (tx) => {
      tx.create('agent', { name: 'Ann' }, 'api');
      tx.update('ticket', 'tkt_0001', { assignee: 'agt_0001' }, 'api');
    });
    const s2 = commit(s, (tx) => tx.update('ticket', 'tkt_0001', { assignee: null }, 'api'));
    assert.equal(s2.tables['ticket']!.get('tkt_0001' as never)!.assignee, null);
  });

  it('R7 refuses a duplicate unique value with 409 on create and update', () => {
    const e1 = refuse(seeded(), (tx) => tx.create('customer', { name: 'Acme', tier: 'free' }, 'api'));
    assert.equal(e1.status, 409);
    assert.equal(e1.code, 'field.unique');
    assert.deepEqual(e1.problems, [{ field: 'name', expected: 'a value no other customer has', found: '"Acme" (cus_0001)' }]);
    const e2 = refuse(seeded(), (tx) => tx.update('customer', 'cus_0002', { name: 'Acme' }, 'api'));
    assert.equal(e2.status, 409);
  });

  it('R7 lets a row keep its own unique value', () => {
    const s = commit(seeded(), (tx) => tx.update('customer', 'cus_0001', { name: 'Acme', tier: 'enterprise' }, 'api'));
    assert.equal(s.tables['customer']!.get('cus_0001' as never)!.tier, 'enterprise');
  });

  it('R8 refuses a ref that does not resolve with 422', () => {
    const e = refuse(seeded(), (tx) => tx.create('ticket', { customer: 'cus_0042', subject: 'x', priority: 'low' }, 'api'));
    assert.equal(e.status, 422);
    assert.equal(e.code, 'ref.unresolved');
    assert.deepEqual(e.problems, [{ field: 'customer', expected: 'the id of an existing customer', found: '"cus_0042"' }]);
  });

  it('R8 resolves a ref to a row created earlier in the same transaction', () => {
    const s = commit(emptyState(W), (tx) => {
      const c = tx.create('customer', { name: 'Acme', tier: 'pro' }, 'api');
      tx.create('ticket', { customer: c.id, subject: 'x', priority: 'low' }, 'api');
    });
    assert.equal(s.tables['ticket']!.get('tkt_0001' as never)!.customer, 'cus_0001');
  });

  it('R19 refuses unknown fields, the id field, unknown entities and missing rows', () => {
    const e1 = refuse(seeded(), (tx) => tx.create('customer', { name: 'X', tier: 'pro', vip: true }, 'api'));
    assert.equal(e1.status, 422);
    assert.equal(e1.code, 'field.unknown');
    assert.deepEqual(e1.problems, [{ field: 'vip', expected: 'one of name, tier', found: 'true' }]);
    const e2 = refuse(seeded(), (tx) => tx.update('customer', 'cus_0001', { id: 'cus_0009' }, 'privileged'));
    assert.equal(e2.status, 422);
    assert.equal(e2.code, 'field.readonly');
    const e3 = refuse(seeded(), (tx) => tx.list('invoice'));
    assert.equal(e3.status, 404);
    assert.equal(e3.code, 'entity.unknown');
    const e4 = refuse(seeded(), (tx) => tx.update('ticket', 'tkt_0099', { subject: 'x' }, 'api'));
    assert.equal(e4.status, 404);
    assert.equal(e4.code, 'row.not_found');
    const e5 = refuse(seeded(), (tx) => tx.delete('ticket', 'tkt_0099'));
    assert.equal(e5.status, 404);
  });

  it('R2 update sets updated_at to engine time and keeps created_at', () => {
    const s = commit(atState(seeded(), '2026-01-05T11:00:00.000Z'), (tx) => tx.update('ticket', 'tkt_0001', { priority: 'high' }, 'api'));
    const t = s.tables['ticket']!.get('tkt_0001' as never)!;
    assert.equal(t.created_at, START);
    assert.equal(t.updated_at, '2026-01-05T11:00:00.000Z');
    assert.equal(t.priority, 'high');
  });

  it('a refused write inside a transaction leaves earlier writes of the same call intact when caught', () => {
    const s = commit(seeded(), (tx) => {
      tx.update('ticket', 'tkt_0001', { priority: 'high' }, 'api');
      assert.throws(() => tx.delete('customer', 'cus_0001'), EnforceError);
      assert.throws(() => tx.create('ticket', { customer: 'nope', subject: 'x', priority: 'low' }, 'api'), EnforceError);
    });
    assert.equal(s.tables['ticket']!.get('tkt_0001' as never)!.priority, 'high');
    assert.equal(s.tables['customer']!.size, 2);
    assert.equal(s.counters['ticket'], 1);
  });
});

describe('state transitions', () => {
  it('R9 accepts a declared transition in api and privileged modes', () => {
    const a = commit(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { status: 'pending' }, 'api'));
    assert.equal(a.tables['ticket']!.get('tkt_0001' as never)!.status, 'pending');
    const p = commit(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { status: 'pending' }, 'privileged'));
    assert.equal(p.tables['ticket']!.get('tkt_0001' as never)!.status, 'pending');
  });

  it('R10 refuses an undeclared transition with 422 naming from and to, in both modes', () => {
    for (const mode of ['api', 'privileged'] as const) {
      const e = refuse(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { status: 'resolved' }, mode));
      assert.equal(e.status, 422);
      assert.equal(e.code, 'state.transition');
      assert.equal(e.message, 'ticket tkt_0001 status cannot move from open to resolved');
      assert.deepEqual(e.problems, [{ field: 'status', expected: 'a transition from open to one of pending', found: 'open -> resolved' }]);
    }
  });

  it('R10 measures from the value before the transaction, so two hops in one call are refused', () => {
    const e = refuse(seeded(), (tx) => {
      tx.update('ticket', 'tkt_0001', { status: 'pending' }, 'api');
      tx.update('ticket', 'tkt_0001', { status: 'resolved' }, 'api');
    });
    assert.equal(e.code, 'state.transition');
    assert.equal(e.message, 'ticket tkt_0001 status cannot move from open to resolved');
  });

  it('R10 refuses writing the unchanged state value back unless the machine declares it (A-197)', () => {
    const e = refuse(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { status: 'open', priority: 'normal' }, 'api'));
    assert.equal(e.status, 422);
    assert.equal(e.code, 'state.transition');
    assert.equal(e.message, 'ticket tkt_0001 status cannot move from open to open');
  });

  it('R10 create in api and privileged mode must start at the initial state; seed mode may start at any declared state', () => {
    for (const mode of ['api', 'privileged'] as const) {
      const e = refuse(seeded(), (tx) => tx.create('ticket', { customer: 'cus_0001', subject: 'x', priority: 'low', status: 'pending' }, mode));
      assert.equal(e.status, 422);
      assert.equal(e.code, 'state.initial');
      assert.deepEqual(e.problems, [{ field: 'status', expected: 'open (the initial state)', found: '"pending"' }]);
    }
    const s = commit(seeded(), (tx) => tx.create('ticket', { customer: 'cus_0001', subject: 'x', priority: 'low', status: 'resolved' }, 'seed'));
    assert.equal(s.tables['ticket']!.get('tkt_0002' as never)!.status, 'resolved');
    const e2 = refuse(seeded(), (tx) => tx.create('ticket', { customer: 'cus_0001', subject: 'x', priority: 'low', status: 'archived' }, 'seed'));
    assert.equal(e2.code, 'field.type');
  });
});

describe('readonly', () => {
  it('R11 refuses a readonly field in api mode on create and update', () => {
    const e1 = refuse(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { sla_due_at: '2026-01-06T09:00:00.000Z' }, 'api'));
    assert.equal(e1.status, 422);
    assert.equal(e1.code, 'field.readonly');
    assert.deepEqual(e1.problems, [{ field: 'sla_due_at', expected: 'no value: readonly fields are set by actions, jobs and seed', found: '"2026-01-06T09:00:00.000Z"' }]);
    const e2 = refuse(seeded(), (tx) =>
      tx.create('ticket', { customer: 'cus_0001', subject: 'x', priority: 'low', sla_due_at: '2026-01-06T09:00:00.000Z' }, 'api'));
    assert.equal(e2.code, 'field.readonly');
    const e3 = refuse(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { created_at: '2026-01-06T09:00:00.000Z' }, 'api'));
    assert.equal(e3.code, 'field.readonly');
  });

  it('R11 allows a readonly field in privileged mode', () => {
    const s = commit(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { sla_due_at: '2026-01-06T09:00:00.000Z' }, 'privileged'));
    assert.equal(s.tables['ticket']!.get('tkt_0001' as never)!.sla_due_at, '2026-01-06T09:00:00.000Z');
    const s2 = commit(seeded(), (tx) => tx.update('ticket', 'tkt_0001', { created_at: '2025-12-01T00:00:00.000Z' }, 'privileged'));
    assert.equal(s2.tables['ticket']!.get('tkt_0001' as never)!.created_at, '2025-12-01T00:00:00.000Z');
  });
});

describe('delete and onDelete', () => {
  it('R12 restrict refuses with 409 and changes nothing', () => {
    const before = seeded();
    const hash = stateHash(before);
    const e = refuse(before, (tx) => tx.delete('customer', 'cus_0001'));
    assert.equal(e.status, 409);
    assert.equal(e.code, 'delete.restricted');
    assert.deepEqual(e.problems, [{ field: 'ticket.customer', expected: 'no ticket referencing customer cus_0001', found: 'tkt_0001' }]);
    assert.equal(stateHash(before), hash);
    const s = commit(before, (tx) => tx.delete('customer', 'cus_0002'));
    assert.deepEqual([...s.tables['customer']!.keys()], ['cus_0001']);
  });

  it('R13 cascade deletes every referencing row, recursively', () => {
    const s = commit(seeded(), (tx) => {
      tx.create('ticket', { customer: 'cus_0002', subject: 'Other', priority: 'low' }, 'api');
      tx.create('comment', { ticket: 'tkt_0001', body: 'first' }, 'api');
      tx.create('comment', { ticket: 'tkt_0001', body: 'second' }, 'api');
      tx.create('comment', { ticket: 'tkt_0002', body: 'keep' }, 'api');
      tx.create('reaction', { comment: 'cmt_0002', emoji: 'ok' }, 'api');
      tx.create('reaction', { comment: 'cmt_0003', emoji: 'ok' }, 'api');
    });
    const after = commit(s, (tx) => tx.delete('ticket', 'tkt_0001'));
    assert.deepEqual([...after.tables['ticket']!.keys()], ['tkt_0002']);
    assert.deepEqual([...after.tables['comment']!.keys()], ['cmt_0003']);
    assert.deepEqual([...after.tables['reaction']!.keys()], ['rct_0002']);
    assert.deepEqual(after.counters, { agent: 0, comment: 3, customer: 2, reaction: 2, ticket: 2 });
  });

  it('R14 nullify sets the ref to null on every referencing row', () => {
    const s = commit(seeded(), (tx) => {
      tx.create('agent', { name: 'Ann' }, 'api');
      tx.create('agent', { name: 'Bob' }, 'api');
      tx.create('ticket', { customer: 'cus_0001', subject: 'Two', priority: 'low', assignee: 'agt_0001' }, 'api');
      tx.update('ticket', 'tkt_0001', { assignee: 'agt_0001' }, 'api');
      tx.create('ticket', { customer: 'cus_0001', subject: 'Three', priority: 'low', assignee: 'agt_0002' }, 'api');
    });
    const after = commit(atState(s, '2026-01-05T12:00:00.000Z'), (tx) => tx.delete('agent', 'agt_0001'));
    const t = after.tables['ticket']!;
    assert.equal(t.get('tkt_0001' as never)!.assignee, null);
    assert.equal(t.get('tkt_0002' as never)!.assignee, null);
    assert.equal(t.get('tkt_0002' as never)!.updated_at, '2026-01-05T12:00:00.000Z');
    assert.equal(t.get('tkt_0003' as never)!.assignee, 'agt_0002');
    assert.deepEqual([...after.tables['agent']!.keys()], ['agt_0002']);
  });
});

describe('transact atomicity', () => {
  it('R15 a throw after two successful writes returns ok:false and leaves the input state unchanged', () => {
    const before = seeded();
    const hash = stateHash(before);
    const snapshot = { now: before.now, counters: { ...before.counters }, tickets: [...before.tables['ticket']!.values()].map((r) => ({ ...r })) };
    const r = transact(W, before, (tx) => {
      tx.create('customer', { name: 'Initech', tier: 'free' }, 'api');
      tx.update('ticket', 'tkt_0001', { status: 'pending' }, 'api');
      tx.update('ticket', 'tkt_0001', { priority: 'nope' }, 'api');
    });
    assert.equal(r.ok, false);
    assert.equal(stateHash(before), hash);
    assert.deepEqual(before.counters, snapshot.counters);
    assert.deepEqual([...before.tables['ticket']!.values()].map((x) => ({ ...x })), snapshot.tickets);
    assert.equal(before.tables['customer']!.size, 2);
  });

  it('R15 wraps a non-EnforceError throw as tx.aborted and keeps the cause', () => {
    const before = seeded();
    const hash = stateHash(before);
    const boom = new Error('boom');
    const r = transact(W, before, (tx) => {
      tx.create('customer', { name: 'Initech', tier: 'free' }, 'api');
      tx.create('agent', { name: 'Ann' }, 'api');
      throw boom;
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error instanceof EnforceError, true);
    assert.equal(r.error.code, 'tx.aborted');
    assert.equal(r.error.message, 'boom');
    assert.equal(r.error.cause, boom);
    assert.equal(stateHash(before), hash);
    assert.equal(before.counters['agent'], 0);
  });

  it('returns the value of fn and keeps now unchanged on success', () => {
    const before = seeded();
    const r = transact(W, before, (tx) => tx.get('ticket', 'tkt_0001')!.subject);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value, 'Cannot log in');
    assert.equal(r.state.now, before.now);
  });

  it('rows read from a committed state cannot be mutated', () => {
    const row = seeded().tables['ticket']!.get('tkt_0001' as never)!;
    assert.throws(() => {
      (row as Record<string, unknown>)['subject'] = 'x';
    }, TypeError);
  });
});

describe('stateHash', () => {
  const build = (): State =>
    commit(seeded(), (tx) => {
      tx.update('ticket', 'tkt_0001', { status: 'pending' }, 'api');
      tx.create('agent', { name: 'Ann' }, 'api');
    });

  it('R16 is identical for two states built by the same sequence of writes', () => {
    const a = build();
    const b = build();
    assert.notEqual(a, b);
    assert.equal(stateHash(a), stateHash(b));
    assert.match(stateHash(a), /^[0-9a-f]{32}$/);
  });

  it('R16 differs when one value differs', () => {
    const a = build();
    const b = commit(a, (tx) => tx.update('ticket', 'tkt_0001', { priority: 'normal' }, 'api'));
    assert.notEqual(stateHash(a), stateHash(b));
  });

  it('R16 differs when only a counter differs', () => {
    const a = build();
    const b = commit(a, (tx) => {
      tx.create('agent', { name: 'Tmp' }, 'api');
      tx.delete('agent', 'agt_0002');
    });
    assert.deepEqual([...b.tables['agent']!.keys()], ['agt_0001']);
    assert.notEqual(stateHash(a), stateHash(b));
  });

  it('R16 ignores map insertion order and engine time', () => {
    const a = build();
    const reversed: State = {
      ...a,
      now: (a.now + 1000) as Instant,
      tables: Object.fromEntries(Object.entries(a.tables).reverse().map(([k, m]) => [k, new Map([...m].reverse())])),
    };
    assert.equal(stateHash(reversed), stateHash(a));
  });
});

/** One entity with an optional non-nullable string, an optional nullable int and a unique nullable datetime. */
const optWorld: World = worldSchema.parse({
  ...W,
  entities: {
    event: {
      description: 'A scheduled event.',
      idPrefix: 'evt',
      fields: {
        label: { type: 'string' },
        size: { type: 'int', nullable: true },
        at: { type: 'datetime', unique: true, nullable: true },
      },
    },
  },
  routes: {}, actions: {}, jobs: {}, fixtures: {}, seed: {}, tests: {}, tasks: {},
});

describe('omitted optional fields', () => {
  it('R1 an omitted non-required, non-nullable field without default stores no key (api and privileged)', () => {
    for (const mode of ['api', 'privileged'] as const) {
      const s = commit(emptyState(optWorld), (tx) => tx.create('event', {}, mode), optWorld);
      const row = s.tables['event']!.get('evt_0001' as never)!;
      assert.equal(Object.hasOwn(row, 'label'), false);
      assert.deepEqual({ ...row }, { id: 'evt_0001', size: null, at: null, created_at: START, updated_at: START });
    }
  });

  it('R2 an omitted nullable field without default still stores null', () => {
    const s = commit(emptyState(optWorld), (tx) => tx.create('event', { label: 'x' }, 'api'), optWorld);
    const row = s.tables['event']!.get('evt_0001' as never)!;
    assert.equal(Object.hasOwn(row, 'size'), true);
    assert.equal(row['size'], null);
  });

  it('R3 an omitted required field without default is still refused field.required', () => {
    const e = refuse(emptyState(W), (tx) => tx.create('agent', {}, 'api'));
    assert.equal(e.status, 422);
    assert.equal(e.code, 'field.required');
    assert.deepEqual(e.problems, [{ field: 'name', expected: 'a value (required)', found: 'missing' }]);
  });

  it('R4 the omitted field can be set later, and null is still refused', () => {
    const s = commit(emptyState(optWorld), (tx) => tx.create('event', {}, 'api'), optWorld);
    const s2 = commit(s, (tx) => tx.update('event', 'evt_0001', { label: 'kickoff' }, 'api'), optWorld);
    assert.equal(s2.tables['event']!.get('evt_0001' as never)!['label'], 'kickoff');
    const e = refuse(s, (tx) => tx.update('event', 'evt_0001', { label: null }, 'api'), optWorld);
    assert.equal(e.status, 422);
    assert.equal(e.code, 'field.null');
  });
});

describe('datetime canonical form and unique', () => {
  it('R6 datetime fields and privileged engine timestamps are stored in canonical form', () => {
    const s = commit(emptyState(optWorld), (tx) => {
      tx.create('event', { at: '2026-01-01T00:00:00Z' }, 'api');
      tx.create('event', { at: '2026-01-02T00:00:00.5Z', created_at: '2025-12-31T23:00:00Z' }, 'privileged');
    }, optWorld);
    const t = s.tables['event']!;
    assert.equal(t.get('evt_0001' as never)!['at'], '2026-01-01T00:00:00.000Z');
    assert.equal(t.get('evt_0002' as never)!['at'], '2026-01-02T00:00:00.500Z');
    assert.equal(t.get('evt_0002' as never)!['created_at'], '2025-12-31T23:00:00.000Z');
  });

  it('R7 unique datetime compares instants across representations on create', () => {
    const e = refuse(emptyState(optWorld), (tx) => {
      tx.create('event', { at: '2026-01-01T00:00:00Z' }, 'api');
      tx.create('event', { at: '2026-01-01T00:00:00.000Z' }, 'api');
    }, optWorld);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'field.unique');
    assert.deepEqual(e.problems, [{ field: 'at', expected: 'a value no other event has', found: '"2026-01-01T00:00:00.000Z" (evt_0001)' }]);
  });

  it('R7 unique datetime compares instants across representations on update', () => {
    const s = commit(emptyState(optWorld), (tx) => {
      tx.create('event', { at: '2026-01-01T00:00:00.000Z' }, 'api');
      tx.create('event', { at: '2026-01-02T00:00:00Z' }, 'api');
    }, optWorld);
    const e = refuse(s, (tx) => tx.update('event', 'evt_0002', { at: '2026-01-01T00:00:00.000000Z' }, 'api'), optWorld);
    assert.equal(e.status, 409);
    assert.equal(e.code, 'field.unique');
  });

  it('R8 instants that differ below a millisecond do not collide', () => {
    const s = commit(emptyState(optWorld), (tx) => {
      tx.create('event', { at: '2026-01-01T00:00:00Z' }, 'api');
      tx.create('event', { at: '2026-01-01T00:00:00.0001Z' }, 'api');
    }, optWorld);
    assert.equal(s.tables['event']!.get('evt_0002' as never)!['at'], '2026-01-01T00:00:00.0001Z');
  });
});

describe('list where after canonical writes and omitted keys', () => {
  it('R9 where on a datetime matches the stored instant in any accepted spelling', () => {
    const s = commit(emptyState(optWorld), (tx) => {
      tx.create('event', { at: '2026-01-01T00:00:00Z' }, 'api');
      tx.create('event', { at: '2026-01-02T00:00:00Z' }, 'api');
    }, optWorld);
    commit(s, (tx) => {
      assert.deepEqual(tx.list('event', { where: { at: '2026-01-01T00:00:00Z' } }).map((r) => r.id), ['evt_0001']);
      assert.deepEqual(tx.list('event', { where: { at: '2026-01-01T00:00:00.000000Z' } }).map((r) => r.id), ['evt_0001']);
      assert.deepEqual(tx.list('event', { where: { at: '2026-01-01T00:00:00.001Z' } }).map((r) => r.id), []);
      assert.deepEqual(tx.list('event', { where: { created_at: '2026-01-01T00:00:00Z' } }).map((r) => r.id), []);
    }, optWorld);
  });

  it('R9 where on an engine timestamp matches its canonical value from a short spelling', () => {
    const s = commit(emptyState(optWorld), (tx) => tx.create('event', { created_at: '2025-12-31T23:00:00Z' }, 'privileged'), optWorld);
    commit(s, (tx) => {
      assert.deepEqual(tx.list('event', { where: { created_at: '2025-12-31T23:00:00Z' } }).map((r) => r.id), ['evt_0001']);
    }, optWorld);
  });

  it('R10 where null finds a row whose optional field was omitted', () => {
    const s = commit(emptyState(optWorld), (tx) => {
      tx.create('event', {}, 'api');
      tx.create('event', { label: 'kickoff' }, 'api');
    }, optWorld);
    commit(s, (tx) => {
      assert.deepEqual(tx.list('event', { where: { label: null } }).map((r) => r.id), ['evt_0001']);
      assert.deepEqual(tx.list('event', { where: { label: 'kickoff' } }).map((r) => r.id), ['evt_0002']);
    }, optWorld);
  });

  it('R10 a where value the field refuses matches nothing', () => {
    const s = commit(emptyState(optWorld), (tx) => tx.create('event', { size: 5 }, 'api'), optWorld);
    commit(s, (tx) => {
      assert.deepEqual(tx.list('event', { where: { size: '5' } }).map((r) => r.id), []);
      assert.deepEqual(tx.list('event', { where: { size: 5 } }).map((r) => r.id), ['evt_0001']);
    }, optWorld);
  });
});

describe('time math doc (7 of 18 live first-attempt seed rejections threw on "0d" or a negative duration)', () => {
  it('the ctx doc says a zero offset is fine and a signed one throws, and timeMath does both', () => {
    assert.equal(snippetDoc('seed').includes('plus(iso, "15m") => iso; minus(iso, "3d") => iso; minutesBetween(a, b) => number. Pure date math on ISO strings. The offset is unsigned and may be zero, such as "0d", "45m" or "1d12h": plus moves later, minus moves earlier ("3d ago"). A signed offset such as "-5d" throws: use minus.'), true);
    assert.equal(timeMath.plus('2026-01-01T00:00:00.000Z', '0d'), '2026-01-01T00:00:00.000Z');
    assert.equal(timeMath.minus('2026-01-01T00:00:00.000Z', '520h'), '2025-12-10T08:00:00.000Z');
    assert.throws(() => timeMath.plus('2026-01-01T00:00:00.000Z', '-520h'), /Invalid duration "-520h"/);
  });
});

describe('uniqueClash', () => {
  it('writes the field.unique message and parses it back to the entity, field, shown value and holder', () => {
    const m = uniqueClash.message('customer', 'name', 'Acme', 'cus_0001');
    assert.equal(m, 'customer.name "Acme" is already used by cus_0001');
    assert.deepEqual(uniqueClash.parse(m), { entity: 'customer', field: 'name', value: '"Acme"', rowId: 'cus_0001' });
  });
  it('parses nothing from any other message', () => {
    assert.equal(uniqueClash.parse('Invalid write to customer cus_0001: tier expected enum'), null);
  });
});
