/**
 * Repeat-run determinism (design law L8, YOS-81). The same world, seed and action sequence run
 * twice yields identical responses, call log, journal, clock, ids, final state hash and grade.
 * With the default 0s tick, reads do not perturb the world, so exploratory agents inhabit the
 * same world as direct ones.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime, type ApiRequest, type ApiResponse, type HttpMethod, type Runtime } from '../src/engine/api.ts';
import { check, type CheckedWorld } from '../src/engine/check.ts';
import type { Duration } from '../src/engine/clock.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { stateHash } from '../src/engine/store.ts';
import { stateFromDump } from '../src/engine/tasks.ts';
import { minimalWorld } from './helpers/world.ts';

const host = createVmHost();

const HOLD = `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'ticket.not_found', 'No ticket ' + ctx.params.id);
  return { status: 200, body: ctx.db.update('ticket', t.id, { priority: 'low' }) };
}`;

/** minimalWorld (start 2026-01-05T09:00:00Z, seed 1) with `tick` and a 2h action, through a real check. */
function worldWith(tick: string): CheckedWorld {
  const r = check(minimalWorld({
    meta: { clock: { tick } },
    actions: { hold_ticket: { method: 'POST', path: '/tickets/{id}/hold', description: 'Put a ticket on hold for two hours.', duration: '2h', handler: HOLD } },
  }), host);
  if (!r.ok) throw new Error(`world failed check: ${r.issues.map((i) => `${i.code} at ${i.path.join('.')}`).join('; ')}`);
  return r.world;
}

type Step = { readonly call: ApiRequest } | { readonly advance: Duration };
const call = (method: HttpMethod, path: string, body?: unknown): Step => ({ call: { method, path, query: {}, body } });

/** Reads, writes, refusals, an explicit advance and a timed action. */
const SCRIPT: readonly Step[] = [
  call('GET', '/tickets?status=pending'),
  call('POST', '/tickets/tkt_0002/resolve'),
  call('POST', '/tickets/tkt_0001/resolve'),
  call('POST', '/customers', { name: 'Soylent', tier: 'free' }),
  call('POST', '/customers', { name: 'Acme', tier: 'pro' }),
  call('POST', '/tickets', { customer: 'cus_0006', subject: 'New one', priority: 'normal' }),
  { advance: '3h' },
  call('POST', '/tickets/tkt_0013/hold'),
  call('PATCH', '/tickets/tkt_0013', { status: 'pending' }),
  call('GET', '/tickets/tkt_0099'),
  call('GET', '/customers'),
];

type Outcome = {
  readonly responses: readonly ApiResponse[];
  readonly advances: readonly unknown[];
  readonly log: ReturnType<Runtime['log']>;
  readonly journal: ReturnType<Runtime['journal']>;
  readonly dump: ReturnType<Runtime['dump']>;
  readonly hash: string;
  readonly grade: number;
};

function play(world: CheckedWorld, rt: Runtime, script: readonly Step[]): Outcome {
  const responses: ApiResponse[] = [];
  const advances: unknown[] = [];
  for (const step of script) {
    if ('call' in step) responses.push(rt.call(step.call));
    else advances.push(rt.advance(step.advance));
  }
  const dump = rt.dump();
  return {
    responses, advances, log: rt.log(), journal: rt.journal(), dump,
    hash: stateHash(stateFromDump(world, dump)),
    grade: rt.grade('resolve_password_ticket'),
  };
}

const run = (world: CheckedWorld, script: readonly Step[] = SCRIPT): Outcome => play(world, runtime(world, host), script);

describe('determinism: same world, seed and actions, same outcome', () => {
  for (const [tick, endNow] of [['0s', '2026-01-05T14:00:00.000Z'], ['1s', '2026-01-05T14:00:07.000Z']] as const) {
    it(`two runs agree on every response, the log, journal, clock, ids, state hash and grade (tick ${tick})`, () => {
      const world = worldWith(tick);
      const a = run(world);
      const b = run(world);
      assert.deepEqual(b.responses, a.responses);
      assert.deepEqual(b.advances, a.advances);
      assert.deepEqual(b.log, a.log);
      assert.deepEqual(b.journal, a.journal);
      assert.deepEqual(b.dump, a.dump);
      assert.equal(b.hash, a.hash);
      assert.equal(b.grade, a.grade);

      assert.deepEqual(a.responses.map((r) => r.status), [200, 200, 409, 201, 409, 201, 200, 200, 404, 200]);
      assert.equal(a.dump.now, endNow);
      assert.deepEqual(a.dump.counters, { customer: 6, ticket: 13 });
      assert.deepEqual(a.dump.tables['customer']!.map((r) => r.id), ['cus_0001', 'cus_0002', 'cus_0003', 'cus_0004', 'cus_0005', 'cus_0006']);
      assert.equal(a.dump.tables['ticket']!.at(-1)!.id, 'tkt_0013');
      assert.equal(a.log.length, 10);
      assert.equal(a.grade, 0.5);
      assert.match(a.hash, /^[0-9a-f]{32}$/);
    });
  }

  it('the default-tick run lands at literal engine times: calls at start, the timed action at +3h, then +2h', () => {
    const a = run(worldWith('0s'));
    assert.deepEqual(a.log.map((c) => [c.seq, c.at, c.routeId, c.res.status]), [
      [1, '2026-01-05T09:00:00.000Z', 'list_tickets', 200],
      [2, '2026-01-05T09:00:00.000Z', 'resolve_ticket', 200],
      [3, '2026-01-05T09:00:00.000Z', 'resolve_ticket', 409],
      [4, '2026-01-05T09:00:00.000Z', 'create_customer', 201],
      [5, '2026-01-05T09:00:00.000Z', 'create_customer', 409],
      [6, '2026-01-05T09:00:00.000Z', 'create_ticket', 201],
      [7, '2026-01-05T12:00:00.000Z', 'hold_ticket', 200],
      [8, '2026-01-05T14:00:00.000Z', 'update_ticket', 200],
      [9, '2026-01-05T14:00:00.000Z', 'get_ticket', 404],
      [10, '2026-01-05T14:00:00.000Z', 'list_customers', 200],
    ]);
    const created = a.dump.tables['ticket']!.at(-1)!;
    assert.deepEqual([created['created_at'], created['updated_at'], created['priority'], created['status']],
      ['2026-01-05T09:00:00.000Z', '2026-01-05T14:00:00.000Z', 'low', 'pending']);
    assert.deepEqual(a.journal.filter((e) => e.origin === 'call').map((e) => [e.source, e.at]), [
      ['resolve_ticket', '2026-01-05T09:00:00.000Z'],
      ['create_customer', '2026-01-05T09:00:00.000Z'],
      ['create_ticket', '2026-01-05T09:00:00.000Z'],
      ['hold_ticket', '2026-01-05T12:00:00.000Z'],
      ['update_ticket', '2026-01-05T14:00:00.000Z'],
    ]);
  });

  it('reset then replay on the same runtime reproduces the first run exactly', () => {
    const world = worldWith('0s');
    const rt = runtime(world, host);
    const first = play(world, rt, SCRIPT);
    rt.reset();
    const second = play(world, rt, SCRIPT);
    assert.deepEqual(second, first);
  });

  it('a fresh check of the same world yields the same outcome', () => {
    assert.deepEqual(run(worldWith('0s')), run(worldWith('0s')));
  });
});

describe('determinism: exploration does not perturb the world under the default tick (L8)', () => {
  const READS: readonly Step[] = [
    call('GET', '/customers'),
    call('GET', '/tickets?customer=cus_0001'),
    call('GET', '/tickets/tkt_0002'),
    call('GET', '/nowhere'),
  ];
  /** SCRIPT with READS before every step, as an agent that looks before it acts would run it. */
  const EXPLORING: readonly Step[] = SCRIPT.flatMap((s) => [...READS, s]);

  it('with tick 0s, extra reads change neither the end state, its hash, the clock nor the grade', () => {
    const world = worldWith('0s');
    const direct = run(world);
    const exploring = run(world, EXPLORING);
    assert.equal(exploring.log.length, 54);
    assert.deepEqual(exploring.dump, direct.dump);
    assert.equal(exploring.hash, direct.hash);
    assert.equal(exploring.grade, direct.grade);
    assert.deepEqual(exploring.journal, direct.journal);
  });

  it('with an opted-in 1s tick, the same reads drift the clock and the row stamps', () => {
    const world = worldWith('1s');
    const direct = run(world);
    const exploring = run(world, EXPLORING);
    assert.equal(direct.dump.now, '2026-01-05T14:00:07.000Z');
    assert.equal(exploring.dump.now, '2026-01-05T14:00:40.000Z');
    assert.notEqual(exploring.hash, direct.hash);
  });
});
