import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime } from '../src/engine/api.ts';
import { check, type CheckReport } from '../src/engine/check.ts';
import type { SnippetHost } from '../src/engine/ctx.ts';
import { worldSchema, type World } from '../src/engine/format.ts';
import type { CheckIssue } from '../src/engine/issues.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { seedOrder, seedState, stateHash, type Row, type State } from '../src/engine/store.ts';
import { bareWorld, checkedForTest, minimalWorld, withStubTasks } from './helpers/world.ts';

const host = createVmHost();

/** bareWorld with some top-level keys replaced. Re-parsed so defaults apply. */
function variant(patch: Partial<Record<keyof World, unknown>>): World {
  return worldSchema.parse({ ...bareWorld(), ...patch });
}

/** bareWorld whose seed section is exactly `seed`, with an optional meta.seed and fixtures. */
function seedWorld(seed: Record<string, string>, opts: { metaSeed?: number; fixtures?: World['fixtures'] } = {}): World {
  const bare = bareWorld();
  return variant({
    meta: { ...bare.meta, ...(opts.metaSeed === undefined ? {} : { seed: opts.metaSeed }) },
    fixtures: opts.fixtures ?? {},
    seed,
  });
}

function seeded(world: World): State {
  const r = seedState(world, host);
  if (!r.ok) assert.fail(`seeding failed: ${r.issue.code} ${r.issue.found}`);
  return r.state;
}

function failedSeed(world: World): CheckIssue {
  const r = seedState(world, host);
  if (r.ok) assert.fail('expected seeding to fail');
  return r.issue;
}

const rows = (s: State, entity: string): Row[] => [...(s.tables[entity]?.values() ?? [])];

function failed(r: CheckReport): Extract<CheckReport, { ok: false }> {
  if (r.ok) assert.fail('expected check to fail');
  return r;
}

/** One customer row for a seed that needs nothing else. */
const ONE_CUSTOMER = `(ctx) => [{ name: 'Acme', tier: 'pro' }]`;

describe('seed order (R1)', () => {
  it('R1 bareWorld seeds customer before ticket', () => {
    assert.deepEqual(seedOrder(bareWorld()), ['customer', 'ticket']);
  });

  it('R1 a referenced entity declared later still seeds first', () => {
    const bare = bareWorld();
    const w = variant({
      entities: {
        note: {
          description: 'A note on a ticket.', idPrefix: 'nte',
          fields: { ticket: { type: 'ref', entity: 'ticket', onDelete: 'cascade', required: true }, body: { type: 'text', required: true } },
        },
        ticket: bare.entities['ticket'],
        customer: bare.entities['customer'],
      },
    });
    assert.deepEqual(seedOrder(w), ['customer', 'ticket', 'note']);
  });

  it('R1 a nullable back-ref does not decide the order, whichever entity is declared first', () => {
    const bare = bareWorld();
    const customer = {
      ...bare.entities['customer']!,
      fields: { ...bare.entities['customer']!.fields, top_ticket: { type: 'ref', entity: 'ticket', onDelete: 'nullify', nullable: true } },
    };
    const ticketFirst = variant({ entities: { ticket: bare.entities['ticket'], customer } });
    const customerFirst = variant({ entities: { customer, ticket: bare.entities['ticket'] } });
    assert.deepEqual(seedOrder(ticketFirst), ['customer', 'ticket']);
    assert.deepEqual(seedOrder(customerFirst), ['customer', 'ticket']);
    for (const w of [ticketFirst, customerFirst]) {
      const r = check(withStubTasks(w), host);
      if (!r.ok) assert.fail(`expected ok, got ${r.issues[0].code} at ${r.issues[0].path.join('.')}`);
      assert.deepEqual(r.stats.rows, { customer: 5, ticket: 12 });
    }
  });

  it('R1 runs seed snippets in ref order even when the seed section lists the referrer first', () => {
    const bare = bareWorld();
    const w = seedWorld({ ticket: bare.seed['ticket']!, customer: bare.seed['customer']! });
    const s = seeded(w);
    assert.equal(rows(s, 'ticket').length, 12);
    assert.equal(rows(s, 'ticket')[0]!['customer'], 'cus_0001');
  });
});

describe('seed rows are created privileged with counter ids (R2)', () => {
  it('R2 minimalWorld seeds cus_0001..cus_0005 and tkt_0001..tkt_0012', () => {
    const s = seeded(minimalWorld());
    assert.deepEqual(rows(s, 'customer').map((r) => r.id), ['cus_0001', 'cus_0002', 'cus_0003', 'cus_0004', 'cus_0005']);
    assert.deepEqual(rows(s, 'customer').map((r) => r['name']), ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli']);
    assert.equal(rows(s, 'ticket').length, 12);
    assert.equal(rows(s, 'ticket')[11]!.id, 'tkt_0012');
    assert.deepEqual(s.counters, { customer: 5, ticket: 12 });
  });

  it('R2 stamps rows with meta.clock.start and lets seed set readonly fields', () => {
    const bare = bareWorld();
    const w = variant({ meta: { ...bare.meta, clock: { start: '2026-01-01T00:00:00.000Z' } } });
    const t = rows(seeded(w), 'ticket')[0]!;
    assert.equal(t['created_at'], '2026-01-01T00:00:00.000Z');
    assert.equal(t['updated_at'], '2026-01-01T00:00:00.000Z');
    // sla_due_at is readonly; tkt_0001 is i = 0, so now + 2h.
    assert.equal(t['sla_due_at'], '2026-01-01T02:00:00.000Z');
  });

  it('R2 a seed snippet that returns no rows leaves the entity empty', () => {
    const s = seeded(seedWorld({ customer: '(ctx) => []' }));
    assert.deepEqual(s.counters, { customer: 0, ticket: 0 });
  });
});

describe('seeded randomness (R3)', () => {
  const RNG_SEED = `(ctx) => [{ name: 'r' + ctx.rng(), tier: 'free' }, { name: 'r' + ctx.rng(), tier: 'free' }, { name: 'r' + ctx.rng(), tier: 'free' }]`;

  it('R3 rng is a mulberry32 stream keyed by meta.seed and entity name', () => {
    const names = rows(seeded(seedWorld({ customer: RNG_SEED }, { metaSeed: 1 })), 'customer').map((r) => r['name']);
    assert.deepEqual(names, ['r0.42092972062528133', 'r0.9338818080723286', 'r0.3331405380740762']);
    const other = rows(seeded(seedWorld({ customer: RNG_SEED }, { metaSeed: 2 })), 'customer').map((r) => r['name']);
    assert.deepEqual(other, ['r0.5671564852818847', 'r0.11747431918047369', 'r0.44157968647778034']);
  });

  it('R3 int(lo, hi) is inclusive and pick draws from the same stream', () => {
    const w = seedWorld({
      customer: `(ctx) => [1, 2, 3, 4, 5].map((i) => ({ name: 'c' + i + '-' + ctx.int(1, 6), tier: 'free' }))`,
      ticket: `(ctx) => [{ customer: 'cus_0001', subject: ctx.pick(['a', 'b', 'c']), priority: 'low' }]`,
    }, { metaSeed: 1 });
    const s = seeded(w);
    assert.deepEqual(rows(s, 'customer').map((r) => r['name']), ['c1-3', 'c2-6', 'c3-2', 'c4-4', 'c5-3']);
    // ticket stream at meta.seed 1 starts at 0.9702..., so pick takes index 2.
    assert.equal(rows(s, 'ticket')[0]!['subject'], 'c');
  });

  it('R3 seeding minimalWorld twice yields the identical stateHash', () => {
    assert.equal(stateHash(seeded(minimalWorld())), stateHash(seeded(minimalWorld())));
  });

  it('R3 changing meta.seed changes the stateHash of a world whose seed uses the rng', () => {
    const bare = bareWorld();
    const pickPriority = bare.seed['ticket']!.replace('priority: s[2],', "priority: ctx.pick(['low', 'normal', 'high', 'urgent']),");
    assert.notEqual(pickPriority, bare.seed['ticket']);
    const at = (seed: number): string => stateHash(seeded(minimalWorld({ meta: { seed }, seed: { ticket: pickPriority } })));
    assert.equal(at(1), at(1));
    assert.notEqual(at(1), at(2));
  });

  it('R3 int with a reversed range and pick of an empty list fail the seed', () => {
    const a = failedSeed(seedWorld({ customer: `(ctx) => [{ name: 'x' + ctx.int(5, 1), tier: 'free' }]` }));
    assert.equal(a.code, 'snippet.runtime_error');
    assert.deepEqual(a.path, ['seed', 'customer']);
    assert.match(a.hint, /int\(5, 1\)/);
    const b = failedSeed(seedWorld({ customer: `(ctx) => [{ name: ctx.pick([]), tier: 'free' }]` }));
    assert.equal(b.code, 'snippet.runtime_error');
    assert.match(b.hint, /pick/);
  });
});

describe('data model violations in seed rows (R4, R7)', () => {
  const BAD_TIER = `(ctx) => [{ name: 'A', tier: 'free' }, { name: 'B', tier: 'pro' }, { name: 'C', tier: 'gold' }]`;

  it('R4 yields constraint.violation at [seed, entity] naming the row index and field', () => {
    const i = failedSeed(seedWorld({ customer: BAD_TIER }));
    assert.equal(i.code, 'constraint.violation');
    assert.deepEqual(i.path, ['seed', 'customer']);
    assert.equal(i.found, 'row 2, field tier: "gold"');
    assert.equal(i.expected, 'customer.tier to satisfy field.type (one of free, pro, enterprise)');
  });

  it('R4 check stops at the seed layer and later entities never run', () => {
    let ticketRuns = 0;
    const counting: SnippetHost = {
      compile(kind, source, path) {
        const r = host.compile(kind, source, path);
        if (!r.ok || path[1] !== 'ticket') return r;
        const run = r.run;
        return { ok: true, run: ((ctx: Parameters<typeof run>[0]) => { ticketRuns += 1; return run(ctx); }) as typeof run };
      },
    };
    const r = failed(check(seedWorld({ customer: BAD_TIER, ticket: `(ctx) => [{ subject: 1 }]` }), counting));
    assert.equal(r.reached, 'seed');
    assert.deepEqual(r.issues.map((x) => [x.code, x.path]), [['constraint.violation', ['seed', 'customer']]]);
    assert.equal(ticketRuns, 0);
  });

  it('R4 a unique clash and an unresolved ref are violations too', () => {
    const dup = failedSeed(seedWorld({ customer: `(ctx) => [{ name: 'A', tier: 'free' }, { name: 'A', tier: 'pro' }]` }));
    assert.equal(dup.code, 'constraint.violation');
    assert.equal(dup.found, 'row 1, field name: "A" (cus_0001)');
    const ref = failedSeed(seedWorld({
      customer: ONE_CUSTOMER,
      ticket: `(ctx) => [{ customer: 'cus_0009', subject: 'S', priority: 'low' }]`,
    }));
    assert.deepEqual(ref.path, ['seed', 'ticket']);
    assert.equal(ref.found, 'row 0, field customer: "cus_0009"');
  });

  it('R4 a row that sets id is refused', () => {
    const i = failedSeed(seedWorld({ customer: `(ctx) => [{ id: 'cus_0042', name: 'A', tier: 'free' }]` }));
    assert.equal(i.code, 'constraint.violation');
    assert.equal(i.found, 'row 0, field id: "cus_0042"');
  });

  it('R7 seed rows may start in any declared state, skipping transitions', () => {
    const s = seeded(seedWorld({
      customer: ONE_CUSTOMER,
      ticket: `(ctx) => [{ customer: 'cus_0001', subject: 'S', priority: 'low', status: 'resolved' }]`,
    }));
    assert.equal(rows(s, 'ticket')[0]!['status'], 'resolved');
  });

  it('R7 an undeclared state is a constraint.violation on that field', () => {
    const i = failedSeed(seedWorld({
      customer: ONE_CUSTOMER,
      ticket: `(ctx) => [{ customer: 'cus_0001', subject: 'S', priority: 'low', status: 'closed' }]`,
    }));
    assert.equal(i.code, 'constraint.violation');
    assert.deepEqual(i.path, ['seed', 'ticket']);
    assert.equal(i.found, 'row 0, field status: "closed"');
  });
});

describe('rows and fixtures in SeedCtx (R5)', () => {
  it('R5 rows(entity) returns rows already seeded, and [] for an entity not seeded yet', () => {
    const s = seeded(seedWorld({
      customer: `(ctx) => [{ name: 'tickets before me: ' + ctx.rows('ticket').length, tier: 'free' }]`,
      ticket: `(ctx) => ctx.rows('customer').map((c) => ({ customer: c.id, subject: c.name, priority: 'low' }))`,
    }));
    assert.deepEqual(rows(s, 'ticket').map((t) => [t['customer'], t['subject']]), [['cus_0001', 'tickets before me: 0']]);
  });

  it('R5 rows of an unknown entity fails the seed', () => {
    const i = failedSeed(seedWorld({ customer: `(ctx) => ctx.rows('custmer')` }));
    assert.equal(i.code, 'snippet.runtime_error');
    assert.match(i.hint, /custmer/);
  });

  it('R5 fixtures expose world.fixtures, and a snippet that mutates them changes nothing', () => {
    const fixtures = { companies: [{ name: 'Acme', tier: 'pro' }, { name: 'Globex', tier: 'free' }] };
    const w = seedWorld({
      customer: `(ctx) => { const out = ctx.fixtures.companies.map((c) => ({ name: c.name, tier: c.tier })); ctx.fixtures.companies[0].name = 'Mutated'; ctx.fixtures.companies.push({ name: 'Extra' }); return out; }`,
      ticket: `(ctx) => [{ customer: 'cus_0001', subject: ctx.fixtures.companies[0].name + ' ' + ctx.fixtures.companies.length, priority: 'low' }]`,
    }, { fixtures });
    const s = seeded(w);
    assert.deepEqual(rows(s, 'customer').map((r) => [r['name'], r['tier']]), [['Acme', 'pro'], ['Globex', 'free']]);
    assert.equal(rows(s, 'ticket')[0]!['subject'], 'Acme 2');
    assert.deepEqual(w.fixtures, { companies: [{ name: 'Acme', tier: 'pro' }, { name: 'Globex', tier: 'free' }] });
  });

  it('R5 now() is meta.clock.start and time math works on it', () => {
    const bare = bareWorld();
    const w = variant({
      meta: { ...bare.meta, clock: { start: '2026-01-01T00:00:00.000Z' } },
      seed: { customer: `(ctx) => [{ name: ctx.now() + ' ' + ctx.time.plus(ctx.now(), '15m') + ' ' + ctx.time.minutesBetween(ctx.now(), ctx.time.plus(ctx.now(), '2h')), tier: 'free' }]` },
    });
    assert.equal(rows(seeded(w), 'customer')[0]!['name'], '2026-01-01T00:00:00.000Z 2026-01-01T00:15:00.000Z 120');
  });

  it('A-126 a seed snippet can add a zero offset and subtract days from now()', () => {
    const bare = bareWorld();
    const w = variant({
      meta: { ...bare.meta, clock: { start: '2026-10-06T00:00:00.000Z' } },
      seed: { customer: `(ctx) => [0, 3, 5].map((i) => ({ name: ctx.time.plus(ctx.now(), (i * 11) + 'd') + ' ' + ctx.time.minus(ctx.now(), i + 'd'), tier: 'free' }))` },
    });
    assert.deepEqual(rows(seeded(w), 'customer').map((r) => r['name']), [
      '2026-10-06T00:00:00.000Z 2026-10-06T00:00:00.000Z',
      '2026-11-08T00:00:00.000Z 2026-10-03T00:00:00.000Z',
      '2026-11-30T00:00:00.000Z 2026-10-01T00:00:00.000Z',
    ]);
  });
});

/** An ok report needs 3 tasks since YOS-113, so the ok cases here add stub tasks. */
describe('check seed layer and stats (R6, R9, R10)', () => {
  it('R6 the ok report counts rows per entity and states per entity.field', () => {
    const r = check(withStubTasks(bareWorld()), host);
    if (!r.ok) assert.fail(`expected ok, got ${r.issues[0].code}`);
    assert.deepEqual(r.stats.rows, { customer: 5, ticket: 12 });
    assert.deepEqual(r.stats.states, { 'ticket.status': { open: 4, pending: 6, resolved: 2 } });
  });

  it('R6 an entity with no seed counts 0 rows and every declared state appears', () => {
    const r = check(withStubTasks(seedWorld({ customer: ONE_CUSTOMER })), host);
    if (!r.ok) assert.fail(`expected ok, got ${r.issues[0].code}`);
    assert.deepEqual(r.stats.rows, { customer: 1, ticket: 0 });
    assert.deepEqual(r.stats.states, { 'ticket.status': { open: 0, pending: 0, resolved: 0 } });
  });

  it('R9 a throwing snippet, a non-array result and a non-object row are issues, never exceptions', () => {
    const threw = failed(check(seedWorld({ customer: `(ctx) => { throw new Error('boom'); }` }), host));
    assert.equal(threw.reached, 'seed');
    assert.equal(threw.issues[0].code, 'snippet.runtime_error');
    assert.deepEqual(threw.issues[0].path, ['seed', 'customer']);
    const notArray = failedSeed(seedWorld({ customer: `(ctx) => ({ name: 'A' })` }));
    assert.equal(notArray.code, 'snippet.runtime_error');
    assert.equal(notArray.found, 'returned an object, not an array of rows');
    const notRow = failedSeed(seedWorld({ customer: `(ctx) => [{ name: 'A', tier: 'free' }, 'B']` }));
    assert.equal(notRow.code, 'snippet.runtime_error');
    assert.equal(notRow.found, 'row 1 is a string, not an object');
  });

  it('R10 check compiles each seed snippet once', () => {
    const compiled: string[] = [];
    const recording: SnippetHost = {
      compile(kind, source, path) {
        if (kind === 'seed') compiled.push(path.join('.'));
        return host.compile(kind, source, path);
      },
    };
    assert.equal(check(withStubTasks(bareWorld()), recording).ok, true);
    assert.deepEqual(compiled, ['seed.customer', 'seed.ticket']);
  });
});

describe('runtime starts from the seeded state (R8)', () => {
  it('R8 the first dump holds the seed rows and reset returns to them', () => {
    const rt = runtime(checkedForTest(bareWorld()), host);
    const start = rt.dump();
    assert.deepEqual(start.counters, { customer: 5, ticket: 12 });
    assert.deepEqual(start.tables['customer']!.map((r) => r['name']), ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli']);
    assert.equal(rt.call({ method: 'DELETE', path: '/tickets/tkt_0001', query: {}, body: undefined }).status, 204);
    assert.equal(rt.dump().tables['ticket']!.length, 11);
    rt.reset();
    assert.deepEqual(rt.dump(), start);
  });
});
