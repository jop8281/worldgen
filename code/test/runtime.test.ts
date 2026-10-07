import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime, type ApiRequest, type HttpMethod, type Runtime } from '../src/engine/api.ts';
import type { CheckedWorld } from '../src/engine/check.ts';
import type { SnippetHost } from '../src/engine/ctx.ts';
import { worldSchema } from '../src/engine/format.ts';
import { stateHash } from '../src/engine/store.ts';
import { stateFromDump } from '../src/engine/tasks.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { bareWorld, checkedForTest } from './helpers/world.ts';

/**
 * bareWorld() with no seed, so the start state is empty whether or not engine-seed has landed,
 * and a fixed clock so every engine time below is a literal. `tick` omitted means the format
 * default (0s, design law L8); tests that need distinct times per call opt in with a tick.
 */
function runtimeWorld(tick?: string): CheckedWorld {
  const bare = bareWorld();
  return checkedForTest(worldSchema.parse({
    ...bare,
    meta: { ...bare.meta, clock: { start: '2026-01-01T00:00:00.000Z', ...(tick ? { tick } : {}) } },
    seed: {},
  }));
}

const host: SnippetHost = {
  compile() {
    throw new Error('runtime tests compile no snippets');
  },
};

const req = (method: HttpMethod, path: string, body?: unknown, headers?: Record<string, string>): ApiRequest => ({
  method, path, query: {}, ...(headers === undefined ? {} : { headers }), body,
});

function fresh(tick?: string): Runtime {
  return runtime(runtimeWorld(tick), host);
}

const ACME = { id: 'cus_0001', name: 'Acme', tier: 'enterprise', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };

describe('runtime: time is explicit by default (L8)', () => {
  it('starts at meta.clock.start with empty tables', () => {
    const { hash, ...rest } = fresh().dump();
    assert.match(hash, /^[0-9a-f]{32}$/);
    assert.deepEqual(rest, {
      world: 'minimal',
      now: '2026-01-01T00:00:00.000Z',
      tables: { customer: [], ticket: [] },
      counters: { customer: 0, ticket: 0 },
    });
  });

  it('the default tick is 0s: successful writes and reads leave now where it was', () => {
    const rt = fresh();
    assert.equal(rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' })).status, 201);
    assert.equal(rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' })).status, 201);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.call(req('GET', '/tickets')).status, 200);
    const d = rt.dump();
    assert.equal(d.now, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(d.tables['customer']!.map((r) => r['created_at']), ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
    assert.deepEqual(rt.log().map((c) => c.at), [
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('advance is what moves time, and later rows carry the advanced time', () => {
    const rt = fresh();
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    rt.advance('90m');
    rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' }));
    rt.call(req('PATCH', '/customers/cus_0001', { tier: 'pro' }));
    const d = rt.dump();
    assert.equal(d.now, '2026-01-01T01:30:00.000Z');
    assert.deepEqual(d.tables['customer']!.map((r) => [r.id, r['created_at'], r['updated_at']]), [
      ['cus_0001', '2026-01-01T00:00:00.000Z', '2026-01-01T01:30:00.000Z'],
      ['cus_0002', '2026-01-01T01:30:00.000Z', '2026-01-01T01:30:00.000Z'],
    ]);
  });

  it('read-only exploration changes nothing: any number of reads ends in the same dump', () => {
    const quiet = fresh();
    const curious = fresh();
    quiet.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    curious.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    for (let i = 0; i < 25; i++) {
      curious.call(req('GET', '/customers'));
      curious.call(req('GET', '/customers/cus_0001'));
      curious.call(req('GET', '/nowhere'));
    }
    assert.deepEqual(curious.dump(), quiet.dump());
    assert.equal(curious.dump().now, '2026-01-01T00:00:00.000Z');
    assert.equal(curious.log().length, 76);
  });
});

describe('runtime: a world may opt in to a per-call tick', () => {
  it('a successful write advances now by one tick', () => {
    const rt = fresh('1s');
    const res = rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    assert.equal(res.status, 201);
    assert.equal(rt.dump().now, '2026-01-01T00:00:01.000Z');
  });

  it('a successful read advances now by one tick too', () => {
    const rt = fresh('1s');
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.dump().now, '2026-01-01T00:00:01.000Z');
    assert.equal(rt.call(req('GET', '/tickets')).status, 200);
    assert.equal(rt.dump().now, '2026-01-01T00:00:02.000Z');
  });

  it('uses meta.clock.tick, and stamps each row with the time its call ran at', () => {
    const rt = fresh('5m');
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' }));
    const d = rt.dump();
    assert.equal(d.now, '2026-01-01T00:10:00.000Z');
    assert.deepEqual(d.tables['customer']!.map((r) => r['created_at']), ['2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z']);
  });

  it('an explicit 0s tick behaves like the default', () => {
    const rt = fresh('0s');
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    rt.call(req('GET', '/customers'));
    assert.equal(rt.dump().now, '2026-01-01T00:00:00.000Z');
  });
});

describe('runtime: POST idempotency keys (YOS-73 G2)', () => {
  it('replays the first response without a second write or clock tick and normalizes header names', () => {
    const rt = fresh('1s');
    const headers = { 'Idempotency-Key': 'customer-create-1' };
    const body = { name: 'Acme', tier: 'enterprise' };
    const first = rt.call(req('POST', '/customers', body, headers));
    assert.equal(first.status, 201);
    const afterFirst = rt.dump();

    // JSON object key order is not part of request identity.
    const second = rt.call(req('POST', '/customers', { tier: 'enterprise', name: 'Acme' }, headers));
    assert.deepEqual(second, first);
    assert.deepEqual(rt.dump(), afterFirst);
    assert.equal(rt.dump().now, '2026-01-01T00:00:01.000Z');
    assert.deepEqual(rt.dump().counters, { customer: 1, ticket: 0 });
    assert.equal(rt.log().length, 2);
    assert.equal(rt.log()[0]!.writes.length, 1);
    assert.deepEqual(rt.log()[1]!.writes, []);
    assert.deepEqual(rt.log()[1]!.req.headers, { 'idempotency-key': 'customer-create-1' });
  });

  it('persists idempotency evidence in hash/dump and replays after dump reload', () => {
    const world = runtimeWorld('1s');
    const rt = runtime(world, host);
    const headers = { 'idempotency-key': 'customer-create-restart' };
    const body = { name: 'Acme', tier: 'enterprise' };

    const first = rt.call(req('POST', '/customers', body, headers));
    assert.equal(first.status, 201);
    const dump = rt.dump();
    assert.equal(dump.idempotency?.length, 1);
    assert.equal(dump.idempotency?.[0]?.key, 'customer-create-restart');
    assert.throws(
      () => stateFromDump(world, { ...dump, idempotency: [] }),
      /hash .* does not match its content/,
    );

    const restored = stateFromDump(world, dump);
    assert.equal(stateHash(restored), dump.hash);
    const resumed = runtime(world, host, restored);
    const replay = resumed.call(req('POST', '/customers', body, headers));
    assert.deepEqual(replay, first);
    assert.deepEqual(resumed.dump(), dump);
    assert.deepEqual(resumed.log()[0]!.writes, []);
  });

  it('a refused POST does not reserve its idempotency key', () => {
    const rt = fresh();
    const headers = { 'idempotency-key': 'customer-create-after-refusal' };
    assert.equal(rt.call(req('POST', '/customers', ['not-an-object'], headers)).status, 400);
    assert.equal(rt.dump().idempotency, undefined);

    const ok = rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }, headers));
    assert.equal(ok.status, 201);
    assert.equal(rt.dump().idempotency?.length, 1);
  });

  it('returns idempotency_error for the same key with a different body and keeps domain state unchanged', () => {
    const rt = fresh('1s');
    const headers = { 'idempotency-key': 'customer-create-2' };
    assert.equal(rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }, headers)).status, 201);
    const before = rt.dump();

    const conflict = rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' }, headers));
    assert.equal(conflict.status, 400);
    assert.equal((conflict.body as { error: { code: string } }).error.code, 'idempotency_error');
    assert.deepEqual(rt.dump(), before);
    assert.deepEqual(rt.log().at(-1)!.writes, []);
  });

  it('reset clears the idempotency ledger with the world state', () => {
    const rt = fresh();
    const headers = { 'idempotency-key': 'customer-create-3' };
    assert.equal(rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }, headers)).status, 201);

    assert.equal(rt.dump().idempotency?.length, 1);
    rt.reset();
    assert.equal(rt.dump().idempotency, undefined);
    const afterReset = rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' }, headers));
    assert.equal(afterReset.status, 201);
    assert.equal((afterReset.body as { id: string }).id, 'cus_0001');
    assert.equal((afterReset.body as { name: string }).name, 'Globex');
  });
});

describe('runtime: failed calls consume neither time nor ids', () => {
  const failures: [ApiRequest, number][] = [
    [req('GET', '/nowhere'), 404],
    [req('PUT', '/customers'), 405],
    [req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }), 409],
    [req('POST', '/tickets', { subject: 'No customer' }), 422],
    [req('POST', '/tickets', { customer: 'cus_0099', subject: 'Bad ref', priority: 'low' }), 422],
    [req('GET', '/customers/cus_0099'), 404],
    [req('DELETE', '/customers/cus_0099'), 404],
    // This host compiles no snippets, so the action fails with 500 (test/actions.test.ts runs real ones).
    [req('POST', '/tickets/tkt_0001/resolve'), 500],
  ];

  for (const tick of [undefined, '1s'] as const) {
    it(`failed calls leave dump(), the clock and the counters unchanged (tick ${tick ?? 'default'})`, () => {
      const rt = fresh(tick);
      rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
      const before = rt.dump();
      for (const [r, status] of failures) {
        assert.equal(rt.call(r).status, status, `${r.method} ${r.path}`);
        assert.deepEqual(rt.dump(), before);
      }
      assert.equal(rt.dump().now, tick === '1s' ? '2026-01-01T00:00:01.000Z' : '2026-01-01T00:00:00.000Z');
      assert.deepEqual(rt.dump().counters, { customer: 1, ticket: 0 });
    });
  }

  it('the next successful create takes the next id, as if the failures never happened', () => {
    const rt = fresh('1s');
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    for (const [r] of failures) rt.call(r);
    assert.equal(rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' })).status, 201);
    assert.equal(rt.call(req('POST', '/tickets', { customer: 'cus_0002', subject: 'Cannot log in', priority: 'low' })).status, 201);
    const d = rt.dump();
    assert.deepEqual(d.counters, { customer: 2, ticket: 1 });
    assert.deepEqual(d.tables['customer']!.map((r) => [r.id, r['created_at']]), [
      ['cus_0001', '2026-01-01T00:00:00.000Z'],
      ['cus_0002', '2026-01-01T00:00:01.000Z'],
    ]);
    assert.deepEqual(d.tables['ticket']!.map((r) => [r.id, r['created_at']]), [['tkt_0001', '2026-01-01T00:00:02.000Z']]);
    assert.equal(d.now, '2026-01-01T00:00:03.000Z');
  });
});

describe('runtime: action durations', () => {
  const vm = createVmHost();
  const OPEN = `(ctx) => ({ status: 201, body: ctx.db.create('ticket', {
    customer: ctx.params.id, subject: 'Timed', priority: 'low', sla_due_at: ctx.time.plus(ctx.now(), '30m'),
  }) })`;
  const REFUSE = `(ctx) => {
    ctx.db.create('ticket', { customer: ctx.params.id, subject: 'Never', priority: 'low' });
    ctx.fail(409, 'refused', 'Refused after a write');
  }`;
  const INSTANT = `(ctx) => ({ status: 200, body: ctx.db.update('ticket', ctx.params.id, { priority: 'high' }) })`;

  /** runtimeWorld plus timed actions; bareWorld's escalate_overdue job (every 15m) still runs. */
  function timedWorld(tick?: string): CheckedWorld {
    const w = runtimeWorld(tick);
    return checkedForTest(worldSchema.parse({
      ...w,
      actions: {
        ...w.actions,
        open_ticket: { method: 'POST', path: '/customers/{id}/open', duration: '1h', handler: OPEN },
        refuse_ticket: { method: 'POST', path: '/customers/{id}/refuse', duration: '1h', handler: REFUSE },
        raise_ticket: { method: 'POST', path: '/tickets/{id}/raise', handler: INSTANT },
      },
    }));
  }

  it('a committed action advances the clock by its duration, and jobs due within it fire after the commit', () => {
    const rt = runtime(timedWorld(), vm);
    assert.equal(rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' })).status, 201);
    const res = rt.call(req('POST', '/customers/cus_0001/open'));
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, {
      id: 'tkt_0001', customer: 'cus_0001', subject: 'Timed', priority: 'low', status: 'open', sla_due_at: '2026-01-01T00:30:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    });
    const d = rt.dump();
    assert.equal(d.now, '2026-01-01T01:00:00.000Z');
    // The ticket went overdue at 00:30, so the 00:45 firing escalated it.
    assert.deepEqual(d.tables['ticket']!.map((r) => [r.id, r['priority'], r['updated_at']]), [['tkt_0001', 'urgent', '2026-01-01T00:45:00.000Z']]);
    assert.deepEqual(rt.journal().map((e) => [e.origin, e.source, e.at]), [
      ['call', 'create_customer', '2026-01-01T00:00:00.000Z'],
      ['call', 'open_ticket', '2026-01-01T00:00:00.000Z'],
      ['job', 'escalate_overdue', '2026-01-01T00:45:00.000Z'],
    ]);
    assert.deepEqual(rt.log().map((c) => [c.seq, c.at, c.routeId, c.res.status]), [
      [1, '2026-01-01T00:00:00.000Z', 'create_customer', 201],
      [2, '2026-01-01T00:00:00.000Z', 'open_ticket', 201],
    ]);
  });

  it('an action without a duration is instant', () => {
    const rt = runtime(timedWorld(), vm);
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    rt.call(req('POST', '/customers/cus_0001/open'));
    assert.equal(rt.call(req('POST', '/tickets/tkt_0001/raise')).status, 200);
    assert.equal(rt.dump().now, '2026-01-01T01:00:00.000Z');
  });

  it('a failed action takes no time and consumes no id, even when it wrote before failing', () => {
    const rt = runtime(timedWorld(), vm);
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    const before = rt.dump();
    const res = rt.call(req('POST', '/customers/cus_0001/refuse'));
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: { code: 'refused', message: 'Refused after a write' } });
    assert.deepEqual(rt.dump(), before);
    assert.equal(rt.dump().now, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(rt.dump().counters, { customer: 1, ticket: 0 });
    assert.equal(rt.call(req('POST', '/customers/cus_0099/open')).status, 422);
    assert.deepEqual(rt.dump(), before);
    assert.equal(rt.call(req('POST', '/customers/cus_0001/open')).status, 201);
    assert.deepEqual(rt.dump().tables['ticket']!.map((r) => r.id), ['tkt_0001']);
  });

  it('a duration adds to an opted-in tick', () => {
    const rt = runtime(timedWorld('1s'), vm);
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    assert.equal(rt.dump().now, '2026-01-01T00:00:01.000Z');
    rt.call(req('POST', '/customers/cus_0001/open'));
    assert.equal(rt.dump().now, '2026-01-01T01:00:02.000Z');
    assert.deepEqual(rt.dump().tables['ticket']!.map((r) => r['created_at']), ['2026-01-01T00:00:01.000Z']);
  });

  it('reset puts the clock back at meta.clock.start after durations', () => {
    const rt = runtime(timedWorld(), vm);
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    rt.call(req('POST', '/customers/cus_0001/open'));
    rt.reset();
    assert.equal(rt.dump().now, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(rt.journal(), []);
  });
});

describe('runtime: log (acceptance 2)', () => {
  it('records every call with increasing seq, engine time, method, path, status and routeId', () => {
    const rt = fresh('1s');
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    rt.call(req('GET', '/nowhere'));
    rt.call(req('GET', '/customers/cus_0001'));
    const log = rt.log();
    assert.deepEqual(
      log.map((c) => [c.seq, c.at, c.req.method, c.req.path, c.res.status, c.routeId]),
      [
        [1, '2026-01-01T00:00:00.000Z', 'POST', '/customers', 201, 'create_customer'],
        [2, '2026-01-01T00:00:01.000Z', 'GET', '/nowhere', 404, null],
        [3, '2026-01-01T00:00:01.000Z', 'GET', '/customers/cus_0001', 200, 'get_customer'],
      ],
    );
    assert.deepEqual(log[2]!.res.body, ACME);
    assert.deepEqual(log[0]!.req, { method: 'POST', path: '/customers', query: {}, body: { name: 'Acme', tier: 'enterprise' } });
  });

  it('returns snapshots: a later call changes neither an earlier log nor an earlier dump', () => {
    const rt = fresh('1s');
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    const log = rt.log();
    const dump = rt.dump();
    rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' }));
    assert.equal(log.length, 1);
    assert.equal(dump.now, '2026-01-01T00:00:01.000Z');
    assert.deepEqual(dump.tables['customer'], [ACME]);
    assert.equal(rt.log().length, 2);
  });

  it('keeps the request as it was sent even if the caller mutates it afterwards', () => {
    const rt = fresh();
    const query: Record<string, string> = {};
    const r = { method: 'GET' as const, path: '/customers', query, body: undefined };
    rt.call(r);
    query['tier'] = 'pro';
    assert.deepEqual(rt.log()[0]!.req.query, {});
  });
});

describe('runtime: dump (acceptance 3)', () => {
  const script: ApiRequest[] = [
    req('POST', '/customers', { name: 'Globex', tier: 'pro' }),
    req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }),
    req('POST', '/tickets', { customer: 'cus_0002', subject: 'Cannot log in', priority: 'low' }),
    req('PATCH', '/tickets/tkt_0001', { status: 'pending' }),
    req('POST', '/tickets', { customer: 'cus_0099', subject: 'Bad ref', priority: 'low' }),
    req('GET', '/tickets'),
  ];

  it('is a JSON-serializable StateDump with id-ordered tables and counters', () => {
    const rt = fresh('1s');
    for (const r of script) rt.call(r);
    const d = rt.dump();
    const { hash, ...rest } = d;
    assert.match(hash, /^[0-9a-f]{32}$/);
    assert.deepEqual(rest, {
      world: 'minimal',
      now: '2026-01-01T00:00:05.000Z',
      tables: {
        customer: [
          { id: 'cus_0001', name: 'Globex', tier: 'pro', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
          { id: 'cus_0002', name: 'Acme', tier: 'enterprise', created_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:01.000Z' },
        ],
        ticket: [
          {
            id: 'tkt_0001', customer: 'cus_0002', subject: 'Cannot log in', priority: 'low', status: 'pending', sla_due_at: null,
            created_at: '2026-01-01T00:00:02.000Z', updated_at: '2026-01-01T00:00:03.000Z',
          },
        ],
      },
      counters: { customer: 2, ticket: 1 },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
  });

  it('two runtimes on the same world given the same calls produce deep-equal dumps and logs', () => {
    const a = fresh();
    const b = fresh();
    for (const r of script) {
      a.call(r);
      b.call(r);
    }
    assert.deepEqual(a.dump(), b.dump());
    assert.deepEqual(a.log(), b.log());
    assert.equal(a.log().length, 6);
    assert.equal(a.dump().now, '2026-01-01T00:00:00.000Z');
  });
});

describe('runtime: reset (acceptance 4)', () => {
  it('restores the start state, the clock at meta.clock.start and an empty log', () => {
    const rt = fresh('1s');
    const start = rt.dump();
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    rt.call(req('GET', '/customers'));
    rt.advance('2h');
    rt.reset();
    const { hash, ...rest } = rt.dump();
    assert.equal(hash, start.hash);
    assert.deepEqual(rest, {
      world: 'minimal',
      now: '2026-01-01T00:00:00.000Z',
      tables: { customer: [], ticket: [] },
      counters: { customer: 0, ticket: 0 },
    });
    assert.deepEqual(rt.dump(), start);
    assert.deepEqual(rt.log(), []);
  });

  it('starts seq and ids over after a reset', () => {
    const rt = fresh('1s');
    rt.call(req('POST', '/customers', { name: 'Globex', tier: 'pro' }));
    rt.reset();
    rt.call(req('POST', '/customers', { name: 'Acme', tier: 'enterprise' }));
    assert.deepEqual(rt.log().map((c) => [c.seq, c.at, c.res.status]), [[1, '2026-01-01T00:00:00.000Z', 201]]);
    assert.deepEqual(rt.dump().tables['customer'], [ACME]);
  });
});

describe('runtime: advance (acceptance 5)', () => {
  it('moves now by the duration (job firing is covered in test/actions.test.ts)', () => {
    const rt = fresh();
    rt.advance('4h');
    assert.equal(rt.dump().now, '2026-01-01T04:00:00.000Z');
  });
});

describe('runtime: evidence in the dump and the log (YOS-78)', () => {
  const acme = req('POST', '/customers', { name: 'Acme', tier: 'enterprise' });

  it('two runtimes from the same world have equal dump hashes and name the world', () => {
    const a = fresh().dump();
    const b = fresh().dump();
    assert.equal(a.hash, b.hash);
    assert.equal(a.world, 'minimal');
    assert.equal(b.world, 'minimal');
  });

  it('one write changes the hash, the same write on another runtime gives the same hash, and reset restores it', () => {
    const rt = fresh();
    const start = rt.dump().hash;
    assert.equal(rt.call(acme).status, 201);
    const written = rt.dump().hash;
    assert.notEqual(written, start);
    const other = fresh();
    assert.equal(other.call(acme).status, 201);
    assert.equal(other.dump().hash, written);
    rt.reset();
    assert.equal(rt.dump().hash, start);
  });

  it('the hash covers rows and counters but not the clock: a read moves now and keeps the hash', () => {
    const rt = runtime(runtimeWorld('1s'), host);
    const before = rt.dump();
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    const after = rt.dump();
    assert.equal(after.now, '2026-01-01T00:00:01.000Z');
    assert.equal(after.hash, before.hash);
  });

  it('the hash is the stateHash of the state the dump describes, also after a JSON round trip', () => {
    const world = runtimeWorld();
    const rt = runtime(world, host);
    assert.equal(rt.call(acme).status, 201);
    const d = rt.dump();
    assert.equal(stateHash(stateFromDump(world, d)), d.hash);
    assert.equal(stateHash(stateFromDump(world, JSON.parse(JSON.stringify(d)))), d.hash);
  });

  it('stateFromDump accepts a dump without hash and refuses one whose hash does not match its content', () => {
    const world = runtimeWorld();
    const rt = runtime(world, host);
    assert.equal(rt.call(acme).status, 201);
    const d = rt.dump();
    const unhashed = { now: d.now, tables: d.tables, counters: d.counters };
    assert.equal(stateHash(stateFromDump(world, unhashed)), d.hash);
    assert.throws(() => stateFromDump(world, { ...d, tables: { customer: [], ticket: [] } }), /^Error: Not a state dump: hash [0-9a-f]{32} does not match its content/);
    assert.throws(() => stateFromDump(world, { ...d, counters: { customer: 2, ticket: 0 } }), /^Error: Not a state dump: hash /);
    assert.throws(() => stateFromDump(world, { ...d, hash: '00000000000000000000000000000000' }), /^Error: Not a state dump: hash 00000000000000000000000000000000 does not match/);
  });

  it('each call logs the rows it committed; reads and refused calls log writes []', () => {
    const rt = fresh();
    assert.equal(rt.call(acme).status, 201);
    assert.equal(rt.call(req('POST', '/tickets', { customer: 'cus_0001', subject: 'Cannot log in', priority: 'low' })).status, 201);
    assert.equal(rt.call(req('PATCH', '/tickets/tkt_0001', { status: 'pending' })).status, 200);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    const before = rt.dump().hash;
    assert.equal(rt.call(acme).status, 409);
    assert.equal(rt.call(req('POST', '/tickets', { subject: 'No customer' })).status, 422);
    assert.equal(rt.call(req('GET', '/nowhere')).status, 404);
    assert.equal(rt.dump().hash, before);
    assert.deepEqual(rt.log().map((c) => [c.seq, c.res.status, c.writes]), [
      [1, 201, [{ entity: 'customer', id: 'cus_0001', op: 'created', fields: ['name', 'tier'] }]],
      [2, 201, [{ entity: 'ticket', id: 'tkt_0001', op: 'created', fields: ['customer', 'subject', 'priority', 'status', 'sla_due_at'] }]],
      [3, 200, [{ entity: 'ticket', id: 'tkt_0001', op: 'updated', fields: ['status'] }]],
      [4, 200, []],
      [5, 409, []],
      [6, 422, []],
      [7, 404, []],
    ]);
  });
});

describe('runtime: advance stops at the Date limit', () => {
  /** The same world without jobs, since a job-bearing world refuses a 97-million-day window (dueJobs firing cap). */
  function noJobs(tick?: string): Runtime {
    const w = runtimeWorld(tick);
    return runtime(checkedForTest(worldSchema.parse({ ...w, jobs: {} })), host);
  }

  // 2026-01-01 plus 97000000d and then 2000000d is year 273078, 979 days short of the Date limit.
  const NEAR_LIMIT = '+273078-10-18T00:00:00.000Z';

  it('refuses an advance past the limit and leaves the clock and state alone', () => {
    const rt = noJobs();
    rt.advance('97000000d');
    rt.advance('2000000d');
    assert.equal(rt.dump().now, NEAR_LIMIT);
    assert.throws(() => rt.advance('1500000d'), RangeError);
    assert.equal(rt.dump().now, NEAR_LIMIT);
  });

  it('dump and call keep working after a refused advance', () => {
    const rt = noJobs();
    rt.advance('97000000d');
    rt.advance('2000000d');
    assert.throws(() => rt.advance('1500000d'), RangeError);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.dump().now, NEAR_LIMIT);
  });

  it('a call whose tick would pass the limit succeeds and the clock stops at the limit (clamp from the merged call() fix)', () => {
    const rt = noJobs('2000000d');
    rt.advance('97000000d');
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
    assert.equal(rt.dump().now, '+275760-09-13T00:00:00.000Z');
  });
});


describe('runtime: request graph boundaries', () => {
  it('rejects a cyclic body without changing state and keeps the log serializable', () => {
    const rt = fresh();
    const before = rt.dump();
    const body: Record<string, unknown> = { name: 'Acme' };
    body['self'] = body;
    const res = rt.call(req('POST', '/customers', body));
    assert.equal(res.status, 400);
    assert.deepEqual(rt.dump(), before);
    assert.doesNotThrow(() => JSON.stringify(rt.log()));
    assert.equal(rt.call(req('GET', '/customers')).status, 200);
  });

  it('copies a shared child without mistaking it for a cycle or retaining the caller object', () => {
    const rt = fresh();
    const shared = { value: 'original' };
    const body = { left: shared, right: shared };
    assert.equal(rt.call(req('POST', '/no-route', body)).status, 404);
    shared.value = 'changed';
    assert.deepEqual(rt.log()[0]?.req.body, { left: { value: 'original' }, right: { value: 'original' } });
  });
});
