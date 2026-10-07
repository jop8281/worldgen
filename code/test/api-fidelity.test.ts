import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime, type Runtime } from '../src/engine/api.ts';
import { FIELD_TYPES } from '../src/engine/fields.ts';
import { worldSchema, type World } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { bareWorld, checkedForTest } from './helpers/world.ts';

const host = createVmHost();
const START = '2026-01-01T00:00:00.000Z';
const START_UNIX = 1767225600;
const STRIPE_ERROR = { error: { type: '$type', code: '$code', message: '$message', param: '$param' } };

const CHARGE_FIELDS = {
  amount: { type: 'money', currency: 'USD', required: true, min: 1 },
  created: { type: 'unix_time', readonly: true, default: 'now' },
};

/** A Stripe-shaped world: charges listed newest first, a refund action that fails with type and param. */
function stripeWorld(api: unknown = {}): World {
  const bare = bareWorld();
  return worldSchema.parse({
    ...bare,
    meta: { ...bare.meta, clock: { start: START, tick: '0s' }, api: { error: STRIPE_ERROR, ...(api as object) } },
    entities: {
      charge: { description: 'A payment.', idPrefix: 'ch', fields: CHARGE_FIELDS },
    },
    routes: {
      list_charges: { op: 'list', entity: 'charge', method: 'GET', path: '/v1/charges', filters: [], pageSize: 25 },
      create_charge: { op: 'create', entity: 'charge', method: 'POST', path: '/v1/charges' },
    },
    actions: {
      refund: {
        method: 'POST', path: '/v1/refunds',
        input: { charge: { type: 'string', required: true } },
        handler: `(ctx) => ctx.fail(400, 'charge_already_refunded', 'Charge ' + ctx.body.charge + ' is refunded', { type: 'invalid_request_error', param: 'charge' })`,
      },
      plain_fail: {
        method: 'POST', path: '/v1/plain',
        handler: `(ctx) => ctx.fail(409, 'busy', 'Try later')`,
      },
    },
    jobs: {}, seed: {}, tasks: {}, tests: {}, fixtures: {},
  });
}

function live(world: World): Runtime {
  return runtime(checkedForTest(world), host);
}

describe('error type and param', () => {
  it('fills a literal Stripe-shaped template from ctx.fail', () => {
    const rt = live(stripeWorld());
    const res = rt.call({ method: 'POST', path: '/v1/refunds', query: {}, body: { charge: 'ch_0001' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge ch_0001 is refunded', param: 'charge' },
    });
  });

  it('turns an unset $type and $param into null', () => {
    const res = live(stripeWorld()).call({ method: 'POST', path: '/v1/plain', query: {}, body: undefined });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: { type: null, code: 'busy', message: 'Try later', param: null } });
  });

  it('keeps the default template free of the new keys', () => {
    const res = live(worldSchema.parse({ ...stripeWorld(), meta: { ...stripeWorld().meta, api: {} } }))
      .call({ method: 'GET', path: '/nope', query: {}, body: undefined });
    assert.deepEqual(res.body, { error: { code: 'route.not_found', message: 'No route matches GET /nope' } });
  });
});

describe('headers and idempotency', () => {
  const post = (rt: Runtime, key: string | undefined, amount: number, headerName = 'idempotency-key') =>
    rt.call({ method: 'POST', path: '/v1/charges', query: {}, body: { amount }, ...(key === undefined ? {} : { headers: { [headerName]: key } }) });

  it('replays the first response and writes once', () => {
    const rt = live(stripeWorld());
    const first = post(rt, 'k1', 500);
    const second = post(rt, 'k1', 500);
    assert.equal(first.status, 201);
    assert.deepEqual(second, first);
    assert.equal(rt.dump().tables['charge']!.length, 1);
    assert.deepEqual(rt.dump().counters, { charge: 1 });
  });

  it('matches the header name in any case and ignores key order in the body', () => {
    const rt = live(stripeWorld());
    const first = rt.call({ method: 'POST', path: '/v1/charges', query: {}, body: { amount: 5, created: undefined }, headers: { 'Idempotency-Key': 'k2' } });
    const second = rt.call({ method: 'POST', path: '/v1/charges', query: {}, body: { created: undefined, amount: 5 }, headers: { 'IDEMPOTENCY-KEY': 'k2' } });
    assert.deepEqual(second, first);
    assert.equal(rt.dump().tables['charge']!.length, 1);
  });

  it('answers 400 idempotency_error when the key comes back with a different body', () => {
    const rt = live(stripeWorld());
    post(rt, 'k3', 500);
    const res = post(rt, 'k3', 900);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      error: {
        type: 'idempotency_error', code: 'idempotency_error',
        message: 'Idempotency-Key "k3" was already used with a different request', param: null,
      },
    });
    assert.equal(rt.dump().tables['charge']!.length, 1);
  });

  it('creates a second row without a key, or with a new key', () => {
    const rt = live(stripeWorld());
    post(rt, undefined, 500);
    post(rt, undefined, 500);
    post(rt, 'k4', 500);
    assert.equal(rt.dump().tables['charge']!.length, 3);
  });

  it('does not remember a refused call, so a retry with the key can succeed', () => {
    const rt = live(stripeWorld());
    assert.equal(post(rt, 'k5', 0).status, 422);
    assert.equal(post(rt, 'k5', 5).status, 201);
  });

  it('forgets keys on reset and logs the replayed call with its headers', () => {
    const rt = live(stripeWorld());
    post(rt, 'k6', 500);
    post(rt, 'k6', 500);
    const log = rt.log();
    assert.deepEqual(log.map((c) => c.writes.length), [1, 0]);
    assert.deepEqual(log[1]!.req.headers, { 'idempotency-key': 'k6' });
    rt.reset();
    assert.equal(post(rt, 'k6', 900).status, 201);
    assert.equal(rt.dump().tables['charge']!.length, 1);
  });
});

describe('unix_time on a created row', () => {
  it('stamps created in unix seconds from engine time', () => {
    const rt = live(stripeWorld());
    rt.advance('5s');
    const res = rt.call({ method: 'POST', path: '/v1/charges', query: {}, body: { amount: 100 } });
    assert.equal(res.status, 201);
    assert.equal((res.body as { created: number }).created, START_UNIX + 5);
  });
});

describe('unix_time field', () => {
  const kind = FIELD_TYPES.unix_time;
  const def = kind.schema.parse({ type: 'unix_time' });

  it('accepts whole non-negative seconds and nothing else', () => {
    assert.deepEqual(kind.validate(1700000000, def), { ok: true, value: 1700000000 });
    assert.deepEqual(kind.validate(-1, def), { ok: false, expected: 'a whole number >= 0' });
    assert.deepEqual(kind.validate(1.5, def), { ok: false, expected: 'a whole number' });
    assert.deepEqual(kind.validate('1700000000', def), { ok: false, expected: 'a whole number' });
  });

  it('orders numerically and parses query values', () => {
    assert.equal(kind.compare(9, 10, def), -1);
    assert.equal(kind.compare(null, 0, def), -1);
    assert.deepEqual(kind.parseQuery('42', def), { ok: true, value: 42 });
    assert.deepEqual(kind.parseQuery('4.2', def), { ok: false, expected: 'a whole number of seconds' });
  });

  it('defaults now to engine seconds, and a literal default must be a whole number', () => {
    assert.equal(kind.schema.safeParse({ type: 'unix_time', default: 'now' }).success, true);
    assert.equal(kind.schema.safeParse({ type: 'unix_time', default: 1.5 }).success, false);
    assert.equal(kind.schema.safeParse({ type: 'unix_time', default: 'yesterday' }).success, false);
    const rt = live(stripeWorld());
    const res = rt.call({ method: 'POST', path: '/v1/charges', query: {}, body: { amount: 5 } });
    assert.equal((res.body as { created: number }).created, START_UNIX);
  });

  it('is never inferred from a CSV column', () => {
    assert.equal(kind.inferFromCsv(['1700000000', '1700000001']), null);
  });
});

describe('a body nested 100000 deep', () => {
  const nest = (inner: () => unknown): unknown => {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 100_000; i++) {
      const next: Record<string, unknown> = {};
      cur['a'] = next;
      cur = next;
    }
    cur['a'] = inner();
    return root;
  };

  it('is refused with a 4xx, with or without an Idempotency-Key', () => {
    const rt = live(stripeWorld());
    const plain = rt.call({ method: 'POST', path: '/v1/charges', query: {}, body: nest(() => 1) });
    assert.equal(plain.status, 422);
    const keyed = rt.call({ method: 'POST', path: '/v1/charges', query: {}, body: nest(() => 1), headers: { 'Idempotency-Key': 'k1' } });
    assert.equal(keyed.status, 422);
    assert.equal(rt.log().length, 2);
  });
});
