import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handle, type ApiRequest, type ApiResponse, type HttpMethod } from '../src/engine/api.ts';
import type { CheckedWorld } from '../src/engine/check.ts';
import { fromIso } from '../src/engine/clock.ts';
import type { SnippetHost } from '../src/engine/ctx.ts';
import { worldSchema, type World } from '../src/engine/format.ts';
import { emptyState, stateHash, type State } from '../src/engine/store.ts';
import { bareWorld, checkedForTest } from './helpers/world.ts';

/**
 * bareWorld() with search and sort declared on list_tickets, so acceptance 3 has something
 * to exercise. Seeding is not implemented yet, so every test builds its state through handle().
 */
function apiWorld(over: { api?: unknown; pageSize?: number } = {}): CheckedWorld {
  const bare = bareWorld();
  const list = bare.routes['list_tickets']!;
  return checkedForTest(worldSchema.parse({
    ...bare,
    meta: over.api === undefined ? bare.meta : { ...bare.meta, api: over.api },
    routes: {
      ...bare.routes,
      list_tickets: { ...list, search: ['subject'], sort: ['priority', 'created_at'], ...(over.pageSize ? { pageSize: over.pageSize } : {}) },
      // A literal segment that competes with get_customer's {id}.
      count_customers: { op: 'list', entity: 'customer', method: 'GET', path: '/customers/count', filters: [], pageSize: 1 },
    },
  } satisfies Record<keyof World, unknown>));
}

const host: SnippetHost = {
  compile() {
    throw new Error('CRUD tests compile no snippets');
  },
};

const req = (method: HttpMethod, path: string, query: Record<string, string> = {}, body: unknown = undefined): ApiRequest => ({ method, path, query, body });

type Step = { state: State; res: ApiResponse; routeId: string | null };
function call(world: CheckedWorld, state: State, method: HttpMethod, path: string, query: Record<string, string> = {}, body?: unknown): Step {
  return handle(world, state, req(method, path, query, body), host);
}

/** Calls that must succeed, returning the next state. */
function must(world: CheckedWorld, state: State, method: HttpMethod, path: string, body?: unknown): State {
  const r = call(world, state, method, path, {}, body);
  assert.ok(r.res.status < 300, `${method} ${path} failed: ${JSON.stringify(r.res.body)}`);
  return r.state;
}

const PRIORITY = ['low', 'normal', 'high', 'urgent'] as const;

/**
 * Three customers, then n tickets. Ticket i (1-based): customer cus_000((i % 3) + 1),
 * subject "Issue i", priority PRIORITY[i % 4]. Every fifth ticket is moved to pending.
 */
function seeded(world: CheckedWorld, n: number): State {
  let s = emptyState(world);
  for (const [name, tier] of [['Acme', 'enterprise'], ['Globex', 'pro'], ['Initech', 'free']] as const) s = must(world, s, 'POST', '/customers', { name, tier });
  for (let i = 1; i <= n; i++) {
    s = must(world, s, 'POST', '/tickets', { customer: `cus_000${(i % 3) + 1}`, subject: `Issue ${i}`, priority: PRIORITY[i % 4] });
    if (i % 5 === 0) s = must(world, s, 'PATCH', `/tickets/tkt_${String(i).padStart(4, '0')}`, { status: 'pending' });
  }
  return s;
}

const idsOf = (body: unknown, key = 'data'): string[] => ((body as Record<string, { id: string }[]>)[key] ?? []).map((r) => r.id);
const tkt = (...ns: number[]): string[] => ns.map((n) => `tkt_${String(n).padStart(4, '0')}`);

const W = apiWorld();
const S12 = seeded(W, 12);
const S65 = seeded(W, 65);

describe('list envelope and paging (acceptance 1)', () => {
  it('R1: returns exactly the default data and next_cursor keys, one page of pageSize rows', () => {
    const r = call(W, S65, 'GET', '/tickets');
    assert.equal(r.res.status, 200);
    assert.equal(r.routeId, 'list_tickets');
    const body = r.res.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['data', 'next_cursor']);
    assert.equal((body['data'] as unknown[]).length, 25);
    assert.equal(typeof body['next_cursor'], 'string');
  });

  it('R1: uses custom meta.api.list keys and params', () => {
    const w = apiWorld({ api: { list: { dataKey: 'items', cursorKey: 'next', limitParam: 'per_page', cursorParam: 'after' } } });
    const s = seeded(w, 4);
    const first = call(w, s, 'GET', '/tickets', { per_page: '3' });
    assert.equal(first.res.status, 200);
    const body = first.res.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['items', 'next']);
    assert.deepEqual(idsOf(body, 'items'), tkt(1, 2, 3));
    const second = call(w, s, 'GET', '/tickets', { per_page: '3', after: String(body['next']) });
    assert.deepEqual(second.res.body, { items: [(s.tables['ticket']!.get(tkt(4)[0] as never))], next: null });
    // The default param names are undeclared in this world.
    assert.equal(call(w, s, 'GET', '/tickets', { limit: '3' }).res.status, 400);
  });

  it('R2: limit returns that many rows and caps at pageSize', () => {
    assert.deepEqual(idsOf(call(W, S65, 'GET', '/tickets', { limit: '10' }).res.body), tkt(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    assert.equal(idsOf(call(W, S65, 'GET', '/tickets', { limit: '500' }).res.body).length, 25);
    const small = apiWorld({ pageSize: 2 });
    assert.deepEqual(idsOf(call(small, seeded(small, 5), 'GET', '/tickets', { limit: '50' }).res.body), tkt(1, 2));
  });

  it('R3: following the cursor over 65 rows yields every id once, in order, then null', () => {
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: Record<string, string> = cursor === null ? { limit: '20' } : { limit: '20', cursor };
      const r = call(W, S65, 'GET', '/tickets', q);
      assert.equal(r.res.status, 200);
      const body = r.res.body as { data: { id: string }[]; next_cursor: string | null };
      sizes.push(body.data.length);
      seen.push(...body.data.map((x) => x.id));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    assert.deepEqual(sizes, [20, 20, 20, 5]);
    assert.equal(seen.length, 65);
    assert.equal(new Set(seen).size, 65);
    assert.equal(seen[0], 'tkt_0001');
    assert.equal(seen[64], 'tkt_0065');
    assert.deepEqual(seen, Array.from({ length: 65 }, (_, i) => `tkt_${String(i + 1).padStart(4, '0')}`));
  });

  it('R3: a page that ends exactly at the last row has a null cursor', () => {
    const r = call(W, S12, 'GET', '/tickets', { limit: '12' });
    assert.equal((r.res.body as { next_cursor: unknown }).next_cursor, null);
    assert.equal(idsOf(r.res.body).length, 12);
  });

  it('R3: the cursor still works when the row it points at is deleted between pages', () => {
    const first = call(W, S12, 'GET', '/tickets', { limit: '4' }).res.body as { next_cursor: string };
    const after = must(W, S12, 'DELETE', '/tickets/tkt_0004');
    assert.deepEqual(idsOf(call(W, after, 'GET', '/tickets', { limit: '4', cursor: first.next_cursor }).res.body), tkt(5, 6, 7, 8));
  });

  it('R4: a bad limit or a bad cursor returns 400 in the envelope', () => {
    assert.deepEqual(call(W, S12, 'GET', '/tickets', { limit: '0' }).res, {
      status: 400, body: { error: { code: 'query.invalid', message: 'limit expected a whole number from 1, found "0"' } },
    });
    assert.equal(call(W, S12, 'GET', '/tickets', { limit: 'abc' }).res.status, 400);
    assert.equal(call(W, S12, 'GET', '/tickets', { limit: '2.5' }).res.status, 400);
    assert.deepEqual(call(W, S12, 'GET', '/tickets', { cursor: 'garbage!!' }).res, {
      status: 400, body: { error: { code: 'cursor.invalid', message: 'cursor is not a cursor this list returned' } },
    });
  });

  it('R4: a cursor from one sort is refused under another sort', () => {
    const first = call(W, S12, 'GET', '/tickets', { limit: '3', sort: 'priority' }).res.body as { next_cursor: string };
    const r = call(W, S12, 'GET', '/tickets', { limit: '3', sort: '-priority', cursor: first.next_cursor });
    assert.equal(r.res.status, 400);
    assert.deepEqual(r.res.body, { error: { code: 'cursor.invalid', message: 'cursor was issued for sort "priority", not "-priority"' } });
  });
});

describe('Stripe list envelope and paging (YOS-127)', () => {
  const SW = apiWorld({ api: { list: { mode: 'stripe' } }, pageSize: 4 });
  const SS = seeded(SW, 13);

  it('returns newest rows first with data + has_more and pages forward with starting_after', () => {
    const first = call(SW, SS, 'GET', '/tickets', { limit: '3' });
    assert.equal(first.res.status, 200);
    assert.deepEqual(first.res.body, {
      data: tkt(13, 12, 11).map((id) => SS.tables['ticket']!.get(id as never)),
      has_more: true,
    });

    const second = call(SW, SS, 'GET', '/tickets', { limit: '3', starting_after: 'tkt_0011' });
    assert.deepEqual(idsOf(second.res.body), tkt(10, 9, 8));
    assert.equal((second.res.body as { has_more: boolean }).has_more, true);

    const last = call(SW, SS, 'GET', '/tickets', { limit: '3', starting_after: 'tkt_0003' });
    assert.deepEqual(idsOf(last.res.body), tkt(2, 1));
    assert.equal((last.res.body as { has_more: boolean }).has_more, false);
  });

  it('pages backward with ending_before without changing newest-first order', () => {
    const middle = call(SW, SS, 'GET', '/tickets', { limit: '3', ending_before: 'tkt_0007' });
    assert.deepEqual(idsOf(middle.res.body), tkt(10, 9, 8));
    assert.equal((middle.res.body as { has_more: boolean }).has_more, true);

    const first = call(SW, SS, 'GET', '/tickets', { limit: '3', ending_before: 'tkt_0010' });
    assert.deepEqual(idsOf(first.res.body), tkt(13, 12, 11));
    assert.equal((first.res.body as { has_more: boolean }).has_more, false);
  });

  it('enforces one Stripe cursor, known ids, limit 1-100, and fixed ordering', () => {
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { starting_after: 'tkt_0010', ending_before: 'tkt_0005' }).res, {
      status: 400, body: { error: { code: 'query.invalid', message: 'starting_after and ending_before cannot be used together' } },
    });
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { starting_after: 'tkt_9999' }).res, {
      status: 400, body: { error: { code: 'cursor.invalid', message: 'starting_after "tkt_9999" is not an id in this list' } },
    });
    for (const limit of ['0', '101', 'abc']) assert.equal(call(SW, SS, 'GET', '/tickets', { limit }).res.status, 400);
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { limit: '101' }).res, {
      status: 400, body: { error: { code: 'query.invalid', message: 'limit expected a whole number from 1 to 100, found "101"' } },
    });
    assert.equal(call(SW, SS, 'GET', '/tickets', { sort: 'priority' }).res.status, 400);
  });

  it('uses configurable Stripe data, has_more and cursor parameter names', () => {
    const w = apiWorld({ api: { list: {
      mode: 'stripe', dataKey: 'items', hasMoreKey: 'more', limitParam: 'count',
      startingAfterParam: 'after', endingBeforeParam: 'before',
    } } });
    const state = seeded(w, 5);
    const result = call(w, state, 'GET', '/tickets', { count: '2', after: 'tkt_0004' });
    assert.deepEqual(Object.keys(result.res.body as object).sort(), ['items', 'more']);
    assert.deepEqual(idsOf(result.res.body, 'items'), tkt(3, 2));
    assert.equal((result.res.body as { more: boolean }).more, true);
    assert.equal(call(w, state, 'GET', '/tickets', { starting_after: 'tkt_0004' }).res.status, 400);
  });

  const hasMore = (body: unknown): unknown => (body as Record<string, unknown>)['has_more'];
  const error = (code: string, message: string) => ({ status: 400, body: { error: { code, message } } });

  it('defaults the page to the route pageSize and accepts any limit from 1 to 100', () => {
    const first = call(SW, SS, 'GET', '/tickets');
    assert.deepEqual(idsOf(first.res.body), tkt(13, 12, 11, 10));
    assert.equal(hasMore(first.res.body), true);
    const one = call(SW, SS, 'GET', '/tickets', { limit: '1' });
    assert.deepEqual(idsOf(one.res.body), tkt(13));
    assert.equal(hasMore(one.res.body), true);
    const all = call(SW, SS, 'GET', '/tickets', { limit: '100' });
    assert.deepEqual(idsOf(all.res.body), tkt(13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1));
    assert.equal(hasMore(all.res.body), false);
    const exact = call(SW, SS, 'GET', '/tickets', { limit: '3', starting_after: 'tkt_0004' });
    assert.deepEqual(idsOf(exact.res.body), tkt(3, 2, 1));
    assert.equal(hasMore(exact.res.body), false);
  });

  it('caps the default page at 100 when the route pageSize is larger', () => {
    const big = apiWorld({ api: { list: { mode: 'stripe' } }, pageSize: 150 });
    const page = call(big, seeded(big, 101), 'GET', '/tickets');
    assert.equal(idsOf(page.res.body).length, 100);
    assert.equal(idsOf(page.res.body)[99], 'tkt_0002');
    assert.equal(hasMore(page.res.body), true);
  });

  it('refuses a limit outside 1 to 100 or not a whole number', () => {
    for (const limit of ['0', '101', 'abc', '1.5', '-1']) {
      assert.deepEqual(call(SW, SS, 'GET', '/tickets', { limit }).res,
        error('query.invalid', `limit expected a whole number from 1 to 100, found ${JSON.stringify(limit)}`));
    }
  });

  it('ending_before at the newest row is an empty page with has_more false', () => {
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { ending_before: 'tkt_0013' }).res, { status: 200, body: { data: [], has_more: false } });
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { starting_after: 'tkt_0001' }).res, { status: 200, body: { data: [], has_more: false } });
  });

  it('refuses an unknown ending_before id, the cursor param and sort', () => {
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { ending_before: 'tkt_0099' }).res,
      error('cursor.invalid', 'ending_before "tkt_0099" is not an id in this list'));
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { sort: '-created_at' }).res,
      error('query.unknown', 'Unknown query parameter "sort". Allowed: limit, starting_after, ending_before, q, customer, status, priority'));
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { cursor: 'abc' }).res,
      error('query.unknown', 'Unknown query parameter "cursor". Allowed: limit, starting_after, ending_before, q, customer, status, priority'));
  });

  it('pages within the filtered rows, and a cursor id outside the filter is refused', () => {
    const first = call(SW, SS, 'GET', '/tickets', { status: 'pending', limit: '1' });
    assert.deepEqual(idsOf(first.res.body), tkt(10));
    assert.equal(hasMore(first.res.body), true);
    const next = call(SW, SS, 'GET', '/tickets', { status: 'pending', limit: '1', starting_after: 'tkt_0010' });
    assert.deepEqual(idsOf(next.res.body), tkt(5));
    assert.equal(hasMore(next.res.body), false);
    const back = call(SW, SS, 'GET', '/tickets', { status: 'pending', ending_before: 'tkt_0005' });
    assert.deepEqual(idsOf(back.res.body), tkt(10));
    assert.equal(hasMore(back.res.body), false);
    assert.deepEqual(idsOf(call(SW, SS, 'GET', '/tickets', { q: 'Issue 1' }).res.body), tkt(13, 12, 11, 10));
    assert.deepEqual(call(SW, SS, 'GET', '/tickets', { status: 'pending', starting_after: 'tkt_0011' }).res,
      error('cursor.invalid', 'starting_after "tkt_0011" is not an id in this list'));
  });

  it('orders by created_at before id, and breaks created_at ties by id descending', () => {
    let s = seeded(SW, 0);
    for (const [subject, at] of [['a', '2026-01-05T12:00:00.000Z'], ['b', '2026-01-05T11:00:00.000Z'], ['c', '2026-01-05T10:00:00.000Z'], ['d', '2026-01-05T12:00:00.000Z']] as const) {
      s = must(SW, { ...s, now: fromIso(at) }, 'POST', '/tickets', { customer: 'cus_0001', subject, priority: 'low' });
    }
    assert.deepEqual(idsOf(call(SW, s, 'GET', '/tickets', { limit: '10' }).res.body), tkt(4, 1, 2, 3));
    const after = call(SW, s, 'GET', '/tickets', { limit: '2', starting_after: 'tkt_0001' });
    assert.deepEqual(idsOf(after.res.body), tkt(2, 3));
    assert.equal(hasMore(after.res.body), false);
    const before = call(SW, s, 'GET', '/tickets', { limit: '1', ending_before: 'tkt_0002' });
    assert.deepEqual(idsOf(before.res.body), tkt(1));
    assert.equal(hasMore(before.res.body), true);
  });
});

describe('filters (acceptance 2)', () => {
  it('R5: declared filters parse through FIELD_TYPES and AND together', () => {
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { status: 'pending' }).res.body), tkt(5, 10));
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { priority: 'high' }).res.body), tkt(2, 6, 10));
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { status: 'pending', priority: 'high' }).res.body), tkt(10));
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { customer: 'cus_0001' }).res.body), tkt(3, 6, 9, 12));
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/customers', { tier: 'pro' }).res.body), ['cus_0002']);
  });

  it('R5: a query string inside the path counts like req.query', () => {
    const r = call(W, S12, 'GET', '/tickets?customer=cus_0001&status=pending');
    assert.equal(r.res.status, 200);
    assert.equal(r.routeId, 'list_tickets');
    assert.deepEqual(idsOf(r.res.body), []);
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets?status=pending&priority=normal').res.body), tkt(5));
  });

  it('R6: a filter value parseQuery rejects returns 400', () => {
    assert.deepEqual(call(W, S12, 'GET', '/tickets', { priority: 'medium' }).res, {
      status: 400, body: { error: { code: 'query.invalid', message: 'priority expected one of low, normal, high, urgent, found "medium"' } },
    });
  });

  it('R7: an undeclared query param returns 400 query.unknown in the default envelope', () => {
    const r = call(W, S12, 'GET', '/tickets', { colour: 'red' });
    assert.deepEqual(r.res, {
      status: 400,
      body: { error: { code: 'query.unknown', message: 'Unknown query parameter "colour". Allowed: limit, cursor, q, sort, customer, status, priority' } },
    });
    assert.equal(r.state, S12);
    assert.equal(r.routeId, 'list_tickets');
  });

  it('R7: filtering on a field the route does not declare is refused', () => {
    assert.equal(call(W, S12, 'GET', '/tickets', { subject: 'Issue 1' }).res.status, 400);
    assert.equal(call(W, S12, 'GET', '/tickets/tkt_0001', { expand: 'customer' }).res.status, 400);
  });
});

describe('search and sort (acceptance 3)', () => {
  it('R8: q searches the route search fields case-insensitively', () => {
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { q: 'ISSUE 1' }).res.body), tkt(1, 10, 11, 12));
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { q: 'sue 7' }).res.body), tkt(7));
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { q: 'nothing like it' }).res.body), []);
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { q: 'issue 1', status: 'pending' }).res.body), tkt(10));
  });

  it('R9: sort=field ascends and sort=-field descends, with id ascending as tiebreak', () => {
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { sort: 'priority' }).res.body), tkt(4, 8, 12, 1, 5, 9, 2, 6, 10, 3, 7, 11));
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { sort: '-priority' }).res.body), tkt(3, 7, 11, 2, 6, 10, 1, 5, 9, 4, 8, 12));
    // Every created_at is equal (handle never ticks), so the order is the id tiebreak.
    assert.deepEqual(idsOf(call(W, S12, 'GET', '/tickets', { sort: '-created_at', limit: '4' }).res.body), tkt(1, 2, 3, 4));
  });

  it('R9: paging under a descending sort has no gaps and no duplicates', () => {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const q: Record<string, string> = { sort: '-priority', limit: '5', ...(cursor === null ? {} : { cursor }) };
      const body = call(W, S12, 'GET', '/tickets', q).res.body as { data: { id: string }[]; next_cursor: string | null };
      pages.push(body.data.map((x) => x.id));
      cursor = body.next_cursor;
    } while (cursor !== null && pages.length < 10);
    assert.deepEqual(pages, [tkt(3, 7, 11, 2, 6), tkt(10, 1, 5, 9, 4), tkt(8, 12)]);
  });

  it('R10: sort on an undeclared field and q on a route without search return 400', () => {
    assert.deepEqual(call(W, S12, 'GET', '/tickets', { sort: 'subject' }).res, {
      status: 400, body: { error: { code: 'query.invalid', message: 'sort expected one of priority, created_at, -priority, -created_at, found "subject"' } },
    });
    assert.deepEqual(call(W, S12, 'GET', '/customers', { q: 'acme' }).res, {
      status: 400, body: { error: { code: 'query.unknown', message: 'Unknown query parameter "q". Allowed: limit, cursor, tier' } },
    });
  });
});

describe('standard ops and enforcement (acceptance 4)', () => {
  it('R11: get returns the row, and a missing id returns 404', () => {
    const r = call(W, S12, 'GET', '/tickets/tkt_0002');
    assert.equal(r.res.status, 200);
    assert.equal(r.routeId, 'get_ticket');
    assert.equal((r.res.body as { subject: string }).subject, 'Issue 2');
    assert.deepEqual(call(W, S12, 'GET', '/tickets/tkt_9999').res, {
      status: 404, body: { error: { code: 'row.not_found', message: 'No ticket tkt_9999' } },
    });
  });

  it('R12: create returns 201 with the row', () => {
    let s = emptyState(W);
    s = must(W, s, 'POST', '/customers', { name: 'Acme', tier: 'pro' });
    const r = call(W, s, 'POST', '/tickets', {}, { customer: 'cus_0001', subject: 'Cannot log in', priority: 'low' });
    assert.equal(r.routeId, 'create_ticket');
    assert.deepEqual(r.res, {
      status: 201,
      body: {
        id: 'tkt_0001', customer: 'cus_0001', subject: 'Cannot log in', priority: 'low', status: 'open', sla_due_at: null,
        created_at: '2026-01-05T09:00:00.000Z', updated_at: '2026-01-05T09:00:00.000Z',
      },
    });
    assert.equal(r.state.tables['ticket']!.size, 1);
    assert.equal(r.state.now, s.now);
  });

  it('R12: create with a body that is not an object returns 400', () => {
    assert.deepEqual(call(W, S12, 'POST', '/customers', {}, ['Acme']).res, {
      status: 400, body: { error: { code: 'body.invalid', message: 'Request body must be a JSON object' } },
    });
  });

  it('R13: delete returns 204 with a null body and removes the row', () => {
    const r = call(W, S12, 'DELETE', '/tickets/tkt_0003');
    assert.deepEqual(r.res, { status: 204, body: null });
    assert.equal(r.state.tables['ticket']!.has(tkt(3)[0] as never), false);
    assert.equal(r.state.tables['ticket']!.size, 11);
  });

  it('R13: delete refused by a restrict ref returns 409 and keeps state', () => {
    const r = call(W, S12, 'DELETE', '/customers/cus_0001');
    assert.equal(r.res.status, 409);
    assert.equal(r.state, S12);
  });

  it('R14: PATCH of a readonly field returns 422 with state unchanged', () => {
    const before = stateHash(S12);
    const r = call(W, S12, 'PATCH', '/tickets/tkt_0001', {}, { sla_due_at: '2026-02-01T00:00:00.000Z' });
    assert.equal(r.res.status, 422);
    assert.equal((r.res.body as { error: { code: string } }).error.code, 'field.readonly');
    assert.equal(r.state, S12);
    assert.equal(stateHash(r.state), before);
  });

  it('R15: PATCH with an undeclared transition (open -> resolved) returns 422 with state unchanged', () => {
    const before = stateHash(S12);
    const r = call(W, S12, 'PATCH', '/tickets/tkt_0001', {}, { status: 'resolved' });
    assert.deepEqual(r.res, {
      status: 422, body: { error: { code: 'state.transition', message: 'ticket tkt_0001 status cannot move from open to resolved' } },
    });
    assert.equal(r.state, S12);
    assert.equal(stateHash(r.state), before);
  });

  it('R16: PATCH with a declared transition (open -> pending) returns 200 with the updated row', () => {
    const r = call(W, S12, 'PATCH', '/tickets/tkt_0001', {}, { status: 'pending' });
    assert.equal(r.res.status, 200);
    assert.equal(r.routeId, 'update_ticket');
    assert.equal((r.res.body as { status: string }).status, 'pending');
    assert.equal(r.state.tables['ticket']!.get(tkt(1)[0] as never)!['status'], 'pending');
    assert.equal(S12.tables['ticket']!.get(tkt(1)[0] as never)!['status'], 'open');
  });
});

describe('error envelope (acceptance 5)', () => {
  it('R17: a custom template substitutes $status as a number and $code, $message inside strings', () => {
    const w = apiWorld({ api: { error: { error: { type: 'invalid_request_error', code: '$code', message: '$message', status: '$status', doc: 'see $code ($status)' } } } });
    const s = seeded(w, 1);
    assert.deepEqual(call(w, s, 'GET', '/tickets/tkt_0404').res, {
      status: 404,
      body: { error: { type: 'invalid_request_error', code: 'row.not_found', message: 'No ticket tkt_0404', status: 404, doc: 'see row.not_found (404)' } },
    });
  });

  it('R17: a message containing $ patterns is inserted literally', () => {
    const r = call(W, S12, 'GET', '/tickets', { "$&'": 'x' });
    assert.deepEqual(r.res.body, {
      error: { code: 'query.unknown', message: `Unknown query parameter "$&'". Allowed: limit, cursor, q, sort, customer, status, priority` },
    });
  });
});

describe('routing', () => {
  it('R18: an unknown path returns 404 route.not_found with a null routeId', () => {
    const r = call(W, S12, 'GET', '/widgets');
    assert.deepEqual(r.res, { status: 404, body: { error: { code: 'route.not_found', message: 'No route matches GET /widgets' } } });
    assert.equal(r.routeId, null);
    assert.equal(r.state, S12);
  });

  it('R18: a known path with the wrong method returns 405', () => {
    const r = call(W, S12, 'PUT', '/tickets');
    assert.deepEqual(r.res, { status: 405, body: { error: { code: 'method.not_allowed', message: 'PUT /tickets is not allowed. Allowed: GET, POST' } } });
    assert.equal(r.routeId, null);
  });

  it('R18: a literal segment beats a {param} segment, and a trailing slash is ignored', () => {
    assert.equal(call(W, S12, 'GET', '/customers/count').routeId, 'count_customers');
    assert.equal(call(W, S12, 'GET', '/customers/cus_0001').routeId, 'get_customer');
    assert.equal(call(W, S12, 'GET', '/tickets/').routeId, 'list_tickets');
  });

  it('R18: percent-encoded path segments are decoded, malformed ones return 400', () => {
    assert.equal(call(W, S12, 'GET', '/tickets/tkt%5F0001').res.status, 200);
    assert.deepEqual(call(W, S12, 'GET', '/tickets/%E0%A4%A').res, {
      status: 400, body: { error: { code: 'path.invalid', message: 'Path /tickets/%E0%A4%A is not valid percent-encoding' } },
    });
  });

  it('R19: a request matching an action reports the action key; with no snippet host it fails 500 and keeps state', () => {
    const r = call(W, S12, 'POST', '/tickets/tkt_0005/resolve');
    assert.equal(r.routeId, 'resolve_ticket');
    assert.equal(r.res.status, 500);
    assert.equal(r.state, S12);
  });

  it('R20: reads return the same state object and no call moves the clock', () => {
    const r = call(W, S12, 'GET', '/tickets');
    assert.equal(r.state, S12);
    const w = call(W, S12, 'POST', '/customers', {}, { name: 'Hooli', tier: 'free' });
    assert.equal(w.res.status, 201);
    assert.notEqual(w.state, S12);
    assert.equal(w.state.now, S12.now);
    assert.equal((w.res.body as { id: string }).id, 'cus_0004');
  });
});

/** bareWorld plus routes nested under /customers/{customer}/tickets. */
function nestedWorld(): CheckedWorld {
  const bare = bareWorld();
  return checkedForTest(worldSchema.parse({
    ...bare,
    routes: {
      ...bare.routes,
      list_customer_tickets: { op: 'list', entity: 'ticket', method: 'GET', path: '/customers/{customer}/tickets', filters: ['status'], sort: [] },
      get_customer_ticket: { op: 'get', entity: 'ticket', method: 'GET', path: '/customers/{customer}/tickets/{id}' },
      create_customer_ticket: { op: 'create', entity: 'ticket', method: 'POST', path: '/customers/{customer}/tickets' },
      update_customer_ticket: { op: 'update', entity: 'ticket', method: 'PATCH', path: '/customers/{customer}/tickets/{id}' },
      delete_customer_ticket: { op: 'delete', entity: 'ticket', method: 'DELETE', path: '/customers/{customer}/tickets/{id}' },
    },
  }));
}

describe('path params scope the operation (YOS-69)', () => {
  const NW = nestedWorld();
  // Tickets 1..6: ticket i belongs to cus_000((i % 3) + 1), so cus_0001 owns tkt_0003 and tkt_0006.
  const NS = seeded(NW, 6);
  const notFound = (message: string) => ({ status: 404, body: { error: { code: 'row.not_found', message } } });

  it('a nested list returns only the parent\'s rows', () => {
    assert.deepEqual(idsOf(call(NW, NS, 'GET', '/customers/cus_0001/tickets').res.body), tkt(3, 6));
  });

  it('a nested list of an unknown parent is 404', () => {
    assert.deepEqual(call(NW, NS, 'GET', '/customers/cus_0099/tickets').res, notFound('No customer cus_0099'));
  });

  it('a nested get returns the row under its own parent and 404 under another', () => {
    assert.equal(call(NW, NS, 'GET', '/customers/cus_0002/tickets/tkt_0001').res.status, 200);
    assert.deepEqual(call(NW, NS, 'GET', '/customers/cus_0001/tickets/tkt_0001').res, notFound('No ticket tkt_0001 with customer cus_0001'));
    assert.deepEqual(call(NW, NS, 'GET', '/customers/cus_0099/tickets/tkt_0001').res, notFound('No customer cus_0099'));
  });

  it('update and delete under the wrong parent are 404 and change nothing', () => {
    const patch = call(NW, NS, 'PATCH', '/customers/cus_0001/tickets/tkt_0001', {}, { subject: 'hijacked' });
    assert.deepEqual(patch.res, notFound('No ticket tkt_0001 with customer cus_0001'));
    assert.equal(patch.state, NS);
    const del = call(NW, NS, 'DELETE', '/customers/cus_0001/tickets/tkt_0001');
    assert.deepEqual(del.res, notFound('No ticket tkt_0001 with customer cus_0001'));
    assert.equal(del.state, NS);
  });

  it('update and delete under the right parent work', () => {
    const patch = call(NW, NS, 'PATCH', '/customers/cus_0002/tickets/tkt_0001', {}, { subject: 'renamed' });
    assert.equal(patch.res.status, 200);
    assert.equal((patch.res.body as { subject: string }).subject, 'renamed');
    assert.equal(call(NW, patch.state, 'DELETE', '/customers/cus_0002/tickets/tkt_0001').res.status, 204);
  });

  it('a nested create takes its parent from the path', () => {
    const r = call(NW, NS, 'POST', '/customers/cus_0002/tickets', {}, { subject: 'New', priority: 'low' });
    assert.equal(r.res.status, 201);
    assert.equal((r.res.body as { customer: string }).customer, 'cus_0002');
  });
});
