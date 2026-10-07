/**
 * Red-team paging suite (G-46 to G-49). For every list route of every world under test,
 * walks `next_cursor` at limits 1, 2, 3, pageSize and 200, with no filter and every declared
 * filter value. Each walk must visit every matching row exactly once, in id order, end with a
 * null cursor, and change no table. A stripe-mode world walks `starting_after` the last id while
 * `has_more` is true, and its rows come newest first by created_at, then id descending. Several filters must all match (A-189).
 * A cursor may be a string or a number (RT-120).
 *
 * Expected rows are literals for the base world (FACTS, SEED_STATUS, SEED_PRIORITY). For
 * other worlds they are the dump's own rows filtered by strict equality, which is an
 * invariance check (list output vs dump output), not a recomputation of engine logic.
 *
 * Runs in-process through Runtime.call with the `query` object (RT-26). One test repeats the
 * base walk over HTTP with encoded cursors (RT-18).
 */
import { describe, it, type TestOptions } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { checkWorld, createRuntime, type ApiRequest, type CheckedWorld, type Runtime } from '#engine';
import { cap, checkedBase, failWithRepro, opts, probeCli, rng, seeds, serveWorld } from './redteam/harness.ts';
import { FACTS, SEED_PRIORITY, SEED_STATUS, baseWorld, worldsUnderTest, type WorldUnderTest } from './redteam/world.ts';

await probeCli();
const WORLDS = await worldsUnderTest();

const RUNTIME: TestOptions = cap('checkWorld', 'createRuntime', 'runtime.call', 'runtime.dump');
const rtOpts = (...extra: TestOptions[]): TestOptions => opts(RUNTIME, ...extra);
/** Base-world literal tests read the seeded rows, so they also need the seed unit. */
const seededOpts = (...extra: TestOptions[]): TestOptions => opts(RUNTIME, cap('runtime.seed'), ...extra);

type Row = Readonly<Record<string, unknown>>;
type Query = Record<string, string>;
type Next = { readonly ok: true; readonly cursor: string | null } | { readonly ok: false };
/** How a world's lists page: the opaque cursor contract, or stripe mode's has_more and starting_after. */
type ListShape = {
  readonly dataKey: string;
  readonly limitParam: string;
  /** The query parameter that takes the value `next` returns. */
  readonly nextParam: string;
  /** The response key `next` reads, for messages. */
  readonly nextKey: string;
  /** The value that fetches the page after this one, or null on the last page. */
  readonly next: (body: Record<string, unknown>, data: readonly Row[]) => Next;
  /** Table rows (id order) in the order the list returns them. */
  readonly order: (rows: readonly Row[]) => Row[];
  readonly sorts: boolean;
};
type ListRoute = { readonly id: string; readonly path: string; readonly entity: string; readonly filters: readonly string[]; readonly sort: readonly string[]; readonly pageSize: number };

function checkedOf(w: WorldUnderTest): CheckedWorld {
  if (w.dir === null && w.name === 'redteam_base') return checkedBase();
  const r = checkWorld(w.input);
  if (!r.ok) assert.fail(`${w.name} does not check: ${JSON.stringify(r.issues, null, 2)}`);
  return r.world;
}

const idOrder = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

function shapeOf(c: CheckedWorld): ListShape {
  const l = c.meta.api.list;
  if (l.mode === 'stripe') {
    return {
      dataKey: l.dataKey, limitParam: l.limitParam, nextParam: l.startingAfterParam, nextKey: l.hasMoreKey, sorts: false,
      next: (body, data) => {
        const more = body[l.hasMoreKey];
        if (more === false) return { ok: true, cursor: null };
        const last = data[data.length - 1];
        return more === true && last !== undefined ? { ok: true, cursor: String(last['id']) } : { ok: false };
      },
      order: (rows) => [...rows].sort((a, b) =>
        String(b['created_at']).localeCompare(String(a['created_at'])) || idOrder(String(b['id']), String(a['id']))),
    };
  }
  return {
    dataKey: l.dataKey, limitParam: l.limitParam, nextParam: l.cursorParam, nextKey: l.cursorKey, sorts: true,
    next: (body) => cursorValue(body[l.cursorKey]),
    order: (rows) => [...rows],
  };
}

function listRoutes(c: CheckedWorld): ListRoute[] {
  const out: ListRoute[] = [];
  for (const [id, r] of Object.entries(c.routes)) {
    if (r.op !== 'list' || r.path.includes('{')) continue;
    out.push({ id, path: r.path, entity: r.entity, filters: r.filters, sort: r.sort, pageSize: r.pageSize });
  }
  return out;
}

const ids = (rows: readonly Row[]): string[] => rows.map((r) => String(r['id']));
const tableOf = (rt: Runtime, entity: string): Row[] => [...(rt.dump().tables[entity] ?? [])] as Row[];
const limitsFor = (r: ListRoute): number[] => [...new Set([1, 2, 3, r.pageSize, 200])];

// ---------------------------------------------------------------------------------------
// Walking

/** RT-120: a cursor is a non-empty string or a finite number. null/undefined ends the walk. */
function cursorValue(next: unknown): { readonly ok: true; readonly cursor: string | null } | { readonly ok: false } {
  if (next === null || next === undefined) return { ok: true, cursor: null };
  if (typeof next === 'string' && next !== '') return { ok: true, cursor: next };
  if (typeof next === 'number' && Number.isFinite(next)) return { ok: true, cursor: String(next) };
  return { ok: false };
}
const hasCursor = (next: unknown): boolean => {
  const cv = cursorValue(next);
  return cv.ok && cv.cursor !== null;
};

type Walk =
  | { readonly ok: true; readonly pages: readonly (readonly Row[])[]; readonly cursors: readonly (string | null)[] }
  | { readonly ok: false; readonly status: number; readonly reason: string; readonly pages: readonly (readonly Row[])[] };

function walk(rt: Runtime, shape: ListShape, path: string, query: Query, limit: number | null, maxPages: number): Walk {
  const pages: Row[][] = [];
  const cursors: (string | null)[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const q: Query = { ...query };
    if (limit !== null) q[shape.limitParam] = String(limit);
    if (cursor !== null) q[shape.nextParam] = cursor;
    const res = rt.call({ method: 'GET', path, query: q, body: null });
    if (res.status !== 200) return { ok: false, status: res.status, reason: `page ${pages.length + 1} returned ${res.status}: ${JSON.stringify(res.body)?.slice(0, 200)}`, pages };
    const body = (res.body ?? {}) as Record<string, unknown>;
    const data = body[shape.dataKey];
    if (!Array.isArray(data)) return { ok: false, status: 200, reason: `page ${pages.length + 1} has no ${shape.dataKey} array`, pages };
    pages.push(data as Row[]);
    const cv = shape.next(body, data as Row[]);
    if (!cv.ok) return { ok: false, status: 200, reason: `${shape.nextKey} is ${JSON.stringify(body[shape.nextKey])}`, pages };
    const next = cv.cursor;
    cursors.push(next);
    if (next === null) return { ok: true, pages, cursors };
    if (seen.has(next)) return { ok: false, status: 200, reason: `cursor ${next} repeats (infinite walk)`, pages };
    if (data.length === 0) return { ok: false, status: 200, reason: 'an empty page carries a non-null cursor', pages };
    if (pages.length > maxPages) return { ok: false, status: 200, reason: `more than ${maxPages} pages`, pages };
    seen.add(next);
    cursor = next;
  }
}

/**
 * Walk and compare to `expected` ids. Returns problems. `pageSize` is the route default.
 * limit null: non-final pages hold exactly pageSize rows (G-46).
 * limit <= pageSize: non-final pages hold exactly limit rows.
 * limit > pageSize: a 4xx is allowed (RT-05). Otherwise every page holds at most min(limit, 200).
 */
function checkWalk(rt: Runtime, shape: ListShape, route: ListRoute, query: Query, limit: number | null, expected: readonly string[]): string[] {
  const tag = `${route.path}?${new URLSearchParams(query).toString()} limit=${limit ?? 'default'}`;
  const w = walk(rt, shape, route.path, query, limit, expected.length + 3);
  if (!w.ok) {
    if (limit !== null && limit > route.pageSize && w.pages.length === 0 && w.status >= 400 && w.status < 500) return [];
    return [`${tag}: ${w.reason}`];
  }
  const out: string[] = [];
  const got = w.pages.flatMap((p) => ids(p));
  const dupes = got.filter((id, k) => got.indexOf(id) !== k);
  if (dupes.length) out.push(`${tag}: rows seen twice ${JSON.stringify([...new Set(dupes)])}`);
  if (!isDeepStrictEqual(got, [...expected])) out.push(`${tag}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  const cap = limit === null ? route.pageSize : Math.min(limit, 200);
  const exact = limit === null ? route.pageSize : limit <= route.pageSize ? limit : null;
  w.pages.forEach((p, k) => {
    if (p.length > cap) out.push(`${tag}: page ${k + 1} holds ${p.length} rows, above ${cap}`);
    const last = k === w.pages.length - 1;
    if (!last && exact !== null && p.length !== exact) out.push(`${tag}: page ${k + 1} holds ${p.length} rows, expected ${exact}`);
  });
  const final = w.cursors[w.cursors.length - 1];
  if (final !== null && final !== undefined) out.push(`${tag}: final cursor is ${JSON.stringify(final)}`);
  // The rule G-46 asserts (rows <= pageSize means a null cursor), applied to every walk: a full
  // last page must not hand out a cursor to an empty page.
  if (w.pages.length > 1 && w.pages[w.pages.length - 1]?.length === 0) out.push(`${tag}: the walk ends with an empty page after a cursor`);
  return out;
}

const report = (problems: readonly string[]): string => `${problems.length} problem(s):\n${problems.slice(0, 40).join('\n')}`;

/** Distinct scalar values of a field in a table, in first-seen order. Nulls left out: RT-122 tests ?field=null on its own. */
function distinct(rows: readonly Row[], field: string): (string | number | boolean)[] {
  const out: (string | number | boolean)[] = [];
  for (const r of rows) {
    const v = r[field];
    if ((typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && !out.includes(v)) out.push(v);
  }
  return out;
}

const matching = (rows: readonly Row[], where: Readonly<Record<string, unknown>>): string[] =>
  ids(rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)));

// ---------------------------------------------------------------------------------------
// Base-world literals, derived from the fixture tables only

const BASE_AGENTS = ['agt_0001', 'agt_0002', 'agt_0003'] as const;
/** Assignee by seed row index, copied from ticketSeed(): i % 4 === 2 ? null : agents[i % 3]. */
const SEED_ASSIGNEE: readonly (string | null)[] = SEED_STATUS.map((_, i) => (i % 4 === 2 ? null : (BASE_AGENTS[i % 3] ?? null)));
const BASE_TICKETS = SEED_STATUS.map((s, i) => ({ id: FACTS.ticketIds[i] ?? '', status: s, priority: SEED_PRIORITY[i] ?? '', assignee: SEED_ASSIGNEE[i] ?? null }));
const baseIds = (pred: (t: (typeof BASE_TICKETS)[number]) => boolean): string[] => BASE_TICKETS.filter(pred).map((t) => t.id);
const chunk = <T,>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, k) => xs.slice(k * n, k * n + n));

// ---------------------------------------------------------------------------------------
// Tests

for (const w of WORLDS) {
  const N = `[${w.name}]`;
  const isBase = w.dir === null && w.name === 'redteam_base';

  describe(`paging ${N}`, () => {
    it(`G-46 every list route returns the meta.api.list envelope with the route's default page size ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      const problems: string[] = [];
      for (const r of listRoutes(c)) {
        const res = rt.call({ method: 'GET', path: r.path, query: {}, body: null });
        if (res.status !== 200) {
          problems.push(`${r.path}: ${res.status}`);
          continue;
        }
        const body = (res.body ?? {}) as Record<string, unknown>;
        if (!Array.isArray(body[shape.dataKey])) problems.push(`${r.path}: no ${shape.dataKey} array`);
        const total = tableOf(rt, r.entity).length;
        const cur = body[shape.nextKey];
        const cv = shape.next(body, Array.isArray(body[shape.dataKey]) ? (body[shape.dataKey] as Row[]) : []);
        if (!cv.ok) problems.push(`${r.path}: ${shape.nextKey} is ${JSON.stringify(cur)} (RT-120: a string or a number)`);
        if (total > r.pageSize && cv.ok && cv.cursor === null) problems.push(`${r.path}: ${total} rows but ${shape.nextKey} is ${JSON.stringify(cur)}`);
        if (total <= r.pageSize && cv.ok && cv.cursor !== null) problems.push(`${r.path}: one page of rows but ${shape.nextKey} is ${JSON.stringify(cur)} (RT-19: null or absent)`);
        const data = body[shape.dataKey];
        if (Array.isArray(data) && data.length !== Math.min(total, r.pageSize)) problems.push(`${r.path}: first page holds ${data.length}, expected ${Math.min(total, r.pageSize)}`);
      }
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-47 unfiltered walks at limits 1, 2, 3, pageSize and 200 visit every row once in id order ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      const problems: string[] = [];
      for (const r of listRoutes(c)) {
        const table = tableOf(rt, r.entity);
        assert.deepEqual(ids(table), [...ids(table)].sort(), `dump of ${r.entity} is not in id order`);
        const expected = ids(shape.order(table));
        for (const limit of [null, ...limitsFor(r)]) problems.push(...checkWalk(rt, shape, r, {}, limit, expected));
      }
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-48 every declared filter value returns exactly the matching rows across pages ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      const problems: string[] = [];
      for (const r of listRoutes(c)) {
        const table = tableOf(rt, r.entity);
        for (const f of r.filters) {
          for (const v of distinct(table, f)) {
            const expected = matching(shape.order(table), { [f]: v });
            for (const limit of [null, ...limitsFor(r)]) {
              // Every successful call ticks the clock (api.ts runtime), so a world with jobs such as the helpdesk's
              // sla_breach changes rows under a long run of walks. Each walk starts from the seed the table was read from.
              rt.reset();
              problems.push(...checkWalk(rt, shape, r, { [f]: String(v) }, limit, expected));
            }
          }
        }
      }
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-48 RT-121 every pair of filters intersects exactly, including empty results ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      const problems: string[] = [];
      for (const r of listRoutes(c)) {
        const table = tableOf(rt, r.entity);
        for (let a = 0; a < r.filters.length; a++) {
          for (let b = a + 1; b < r.filters.length; b++) {
            const fa = r.filters[a] ?? '';
            const fb = r.filters[b] ?? '';
            for (const va of distinct(table, fa).slice(0, 6)) {
              for (const vb of distinct(table, fb).slice(0, 6)) {
                const expected = matching(shape.order(table), { [fa]: va, [fb]: vb });
                for (const limit of [null, 1, 2]) {
                  // Each walk starts from the seed the table was read from: calls tick the clock, and jobs then change rows.
                  rt.reset();
                  problems.push(...checkWalk(rt, shape, r, { [fa]: String(va), [fb]: String(vb) }, limit, expected));
                }
              }
            }
          }
        }
      }
      assert.deepEqual(problems, [], report(problems));
    });

    // G-49 (reads change no table) and api.ts (`handle` is pure) make a replayed cursor give the
    // same rows. Only status and rows are compared: the cursor in the body may depend on `now` (RT-02).
    it(`G-47 G-49 replaying a cursor gives the same rows ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      for (const r of listRoutes(c)) {
        const first = walk(rt, shape, r.path, {}, 1, tableOf(rt, r.entity).length + 3);
        assert.ok(first.ok, first.ok ? '' : first.reason);
        // Newest cursor first, and each replay compared with the page the walk saw: a cursor that
        // is a consumable server-side iterator, or valid only while it is the latest one handed
        // out, gives the same wrong page twice and passes an a-vs-b comparison alone.
        const order = first.cursors.map((cur, k) => [cur, k] as const).reverse();
        for (const [cur, k] of order) {
          if (cur === null) continue;
          const q = { [shape.limitParam]: '1', [shape.nextParam]: cur };
          const a = rt.call({ method: 'GET', path: r.path, query: q, body: null });
          const b = rt.call({ method: 'GET', path: r.path, query: q, body: null });
          assert.equal(a.status, 200);
          assert.equal(b.status, a.status, `${r.path} cursor ${cur} gave two different statuses`);
          const rowsOf = (x: { readonly body: unknown }): unknown => ((x.body ?? {}) as Record<string, unknown>)[shape.dataKey];
          assert.deepEqual(rowsOf(b), rowsOf(a), `${r.path} cursor ${cur} gave two different pages`);
          assert.deepEqual(ids(rowsOf(a) as Row[]), ids(first.pages[k + 1] ?? []), `${r.path} cursor ${cur} replays to a different page than the walk saw`);
        }
      }
    });

    it(`G-49 list and get calls leave every table unchanged ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      // A copy: if dump() hands out the live tables, `before` is the very object compared later.
      const before = structuredClone(rt.dump().tables);
      const problems: string[] = [];
      for (const r of listRoutes(c)) {
        walk(rt, shape, r.path, {}, 1, (before[r.entity]?.length ?? 0) + 3);
        const getRoute = Object.values(c.routes).find((x) => x.op === 'get' && x.entity === r.entity);
        // Ids from the dump, so a broken walk cannot shrink the set of gets; each must be a 2xx,
        // so a get that 404s before touching the row cannot pass vacuously.
        if (getRoute) {
          for (const id of ids(before[r.entity] ?? [])) {
            const g = rt.call({ method: 'GET', path: getRoute.path.replace(/\{[^}]+\}/, id), query: {}, body: null });
            if (g.status < 200 || g.status >= 300) problems.push(`GET ${getRoute.path} ${id} -> ${g.status}`);
          }
        }
        for (const f of r.filters) rt.call({ method: 'GET', path: r.path, query: { [f]: 'redteam_no_match' }, body: null });
      }
      assert.deepEqual(rt.dump().tables, before);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-47 RT-38 sorted walks visit every row once, ordered by the sort field ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      const problems: string[] = [];
      for (const r of listRoutes(c)) {
        const table = tableOf(rt, r.entity);
        const fields = c.entities[r.entity]?.fields ?? {};
        for (const f of shape.sorts ? r.sort : []) {
          const def = fields[f];
          for (const dir of ['', '-']) {
            for (const limit of [1, 2, r.pageSize]) {
              const wk = walk(rt, shape, r.path, { sort: `${dir}${f}` }, limit, table.length + 3);
              if (!wk.ok) {
                problems.push(`${r.path}?sort=${dir}${f}: ${wk.reason}`);
                continue;
              }
              const got = wk.pages.flat();
              if (!isDeepStrictEqual(ids(got).sort(), ids(table).sort())) problems.push(`${r.path}?sort=${dir}${f} limit ${limit}: rows differ from the table`);
              const vals = got.map((x) => x[f]);
              // Null sorts lowest (A-188), so it leads an ascending walk and ends a descending one.
              const rank = (v: unknown): number | string | null =>
                def?.type === 'enum' && typeof v === 'string' ? def.values.indexOf(v) : typeof v === 'number' || typeof v === 'string' ? v : null;
              const atMost = (p: number | string | null, q: number | string | null): boolean => p === null || (q !== null && p <= q);
              const ordered = vals.every((v, k) => {
                if (k === 0) return true;
                const p = rank(vals[k - 1]);
                const q = rank(v);
                return dir === '' ? atMost(p, q) : atMost(q, p);
              });
              if (!ordered) problems.push(`${r.path}?sort=${dir}${f} limit ${limit}: ${JSON.stringify(vals)} is not ordered`);
            }
          }
        }
      }
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-47 RT-18 cursors are URL-safe, so client snippets can pass them unencoded ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      for (const r of listRoutes(c)) {
        const wk = walk(rt, shape, r.path, {}, 1, tableOf(rt, r.entity).length + 3);
        assert.ok(wk.ok, wk.ok ? '' : wk.reason);
        for (const cur of wk.cursors) if (cur !== null) assert.match(cur, /^[A-Za-z0-9._~-]+$/, `${r.path} cursor ${cur} needs encoding`);
      }
    });

    it(`G-48 RT-39 a filter value of the wrong type gives a 4xx or an empty page, never a 5xx ${N}`, rtOpts(), () => {
      const c = checkedOf(w);
      const shape = shapeOf(c);
      const rt = createRuntime(c);
      const before = structuredClone(rt.dump().tables);
      const problems: string[] = [];
      for (const r of listRoutes(c)) {
        for (const f of r.filters) {
          for (const v of ['redteam_no_such_value', '%', '\u0000', '[]', '{}', '1e309', 'NaN']) {
            const res = rt.call({ method: 'GET', path: r.path, query: { [f]: v }, body: null });
            const data = ((res.body ?? {}) as Record<string, unknown>)[shape.dataKey];
            const fine = (res.status >= 400 && res.status < 500) || (res.status === 200 && Array.isArray(data) && data.length === 0);
            if (!fine) problems.push(`${r.path}?${f}=${JSON.stringify(v)} -> ${res.status} ${JSON.stringify(res.body)?.slice(0, 160)}`);
          }
        }
      }
      assert.deepEqual(problems, [], report(problems));
      assert.deepEqual(rt.dump().tables, before);
    });

    if (!isBase) return;

    // -----------------------------------------------------------------------------------
    // Base-world literals

    it(`G-46 base first pages: 3 tickets, 1 agent, both with a cursor ${N}`, seededOpts(), () => {
      const rt = createRuntime(checkedBase());
      const t = rt.call({ method: 'GET', path: '/tickets', query: {}, body: null });
      assert.equal(t.status, 200);
      const tb = t.body as Record<string, unknown>;
      assert.deepEqual(ids(tb['data'] as Row[]), [...FACTS.ticketPages[0]]);
      assert.ok(hasCursor(tb['next_cursor']), `next_cursor is ${JSON.stringify(tb['next_cursor'])}`);
      const a = rt.call({ method: 'GET', path: '/agents', query: {}, body: null });
      assert.equal(a.status, 200);
      const ab = a.body as Record<string, unknown>;
      assert.deepEqual(ids(ab['data'] as Row[]), ['agt_0001']);
      assert.ok(hasCursor(ab['next_cursor']), `next_cursor is ${JSON.stringify(ab['next_cursor'])}`);
    });

    it(`G-47 base walks give FACTS.ticketPages and the literal chunks at every limit ${N}`, seededOpts(), () => {
      const c = checkedBase();
      const rt = createRuntime(c);
      const tickets = walk(rt, shapeOf(c), '/tickets', {}, null, 20);
      assert.ok(tickets.ok, tickets.ok ? '' : tickets.reason);
      assert.deepEqual(tickets.pages.map((p) => ids(p)), FACTS.ticketPages.map((p) => [...p]));
      const agents = walk(rt, shapeOf(c), '/agents', {}, null, 20);
      assert.ok(agents.ok, agents.ok ? '' : agents.reason);
      assert.deepEqual(agents.pages.map((p) => ids(p)), [['agt_0001'], ['agt_0002'], ['agt_0003']]);
      for (const limit of [1, 2, 3]) {
        const wk = walk(rt, shapeOf(c), '/tickets', {}, limit, 20);
        assert.ok(wk.ok, wk.ok ? '' : wk.reason);
        assert.deepEqual(wk.pages.map((p) => ids(p)), chunk(FACTS.ticketIds, limit), `limit ${limit}`);
      }
    });

    it(`G-48 base status, priority, assignee and on_call filters match the seed tables at every limit ${N}`, seededOpts(), () => {
      const c = checkedBase();
      const rt = createRuntime(c);
      const shape = shapeOf(c);
      const tickets = listRoutes(c).find((r) => r.path === '/tickets');
      const agents = listRoutes(c).find((r) => r.path === '/agents');
      assert.ok(tickets && agents);
      assert.deepEqual(baseIds((t) => t.status === 'open'), [...FACTS.openTickets]);
      assert.deepEqual(baseIds((t) => t.assignee === null), [...FACTS.unassigned]);
      assert.deepEqual(baseIds((t) => t.priority === 'urgent'), [...FACTS.urgentTickets]);
      for (const a of BASE_AGENTS) assert.deepEqual(baseIds((t) => t.assignee === a), [...FACTS.ticketsOfAgent[a]], `literal sources disagree on ${a}`);
      const cases: [Query, readonly string[]][] = [
        [{ status: 'open' }, FACTS.openTickets],
        [{ status: 'pending' }, FACTS.pendingTickets],
        [{ status: 'closed' }, FACTS.closedTickets],
        ...['low', 'normal', 'high', 'urgent'].map((p): [Query, readonly string[]] => [{ priority: p }, baseIds((t) => t.priority === p)]),
        ...BASE_AGENTS.map((a): [Query, readonly string[]] => [{ assignee: a }, FACTS.ticketsOfAgent[a]]),
      ];
      const problems: string[] = [];
      for (const [q, expected] of cases) for (const limit of [null, 1, 2, 3, 200]) problems.push(...checkWalk(rt, shape, tickets, q, limit, expected));
      problems.push(...checkWalk(rt, shape, agents, { on_call: 'true' }, null, [FACTS.onCallAgent]));
      for (const limit of [null, 1, 2]) problems.push(...checkWalk(rt, shape, agents, { on_call: 'false' }, limit, ['agt_0002', 'agt_0003']));
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-48 RT-121 base pair and triple filters intersect at every limit ${N}`, seededOpts(), () => {
      const c = checkedBase();
      const rt = createRuntime(c);
      const shape = shapeOf(c);
      const tickets = listRoutes(c).find((r) => r.path === '/tickets');
      assert.ok(tickets);
      const cases: [Query, readonly string[]][] = [[{ status: 'open', priority: 'urgent' }, FACTS.openUrgent]];
      for (const s of ['open', 'pending', 'closed']) {
        for (const p of ['low', 'normal', 'high', 'urgent']) {
          cases.push([{ status: s, priority: p }, baseIds((t) => t.status === s && t.priority === p)]);
          for (const a of BASE_AGENTS) cases.push([{ status: s, priority: p, assignee: a }, baseIds((t) => t.status === s && t.priority === p && t.assignee === a)]);
        }
      }
      const problems: string[] = [];
      for (const [q, expected] of cases) for (const limit of [null, 1, 2, 3, 200]) problems.push(...checkWalk(rt, shape, tickets, q, limit, expected));
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-47 seeded fuzz: after random writes, every walk still matches the dump ${N}`, rtOpts(), () => {
      const c = checkedBase();
      const shape = shapeOf(c);
      const routes = listRoutes(c);
      type Op = ApiRequest;
      let wrote = 0;
      const fails = (calls: readonly Op[]): boolean => {
        const rt = createRuntime(c);
        // Read every list (unfiltered and filtered) before writing, so a list or filter cache that
        // writes never invalidate serves stale pages to the walks below.
        for (const r of routes) {
          walk(rt, shape, r.path, {}, null, 50);
          for (const f of r.filters) for (const v of distinct(tableOf(rt, r.entity), f).slice(0, 3)) walk(rt, shape, r.path, { [f]: String(v) }, null, 50);
        }
        for (const call of calls) {
          const res = rt.call(call);
          if (res.status >= 200 && res.status < 300) wrote++;
        }
        for (const r of routes) {
          const table = tableOf(rt, r.entity);
          for (const limit of [null, 1, 2]) {
            if (checkWalk(rt, shape, r, {}, limit, ids(table)).length) return true;
            for (const f of r.filters) {
              for (const v of distinct(table, f).slice(0, 3)) if (checkWalk(rt, shape, r, { [f]: String(v) }, limit, matching(table, { [f]: v })).length) return true;
            }
          }
        }
        return false;
      };
      for (const seed of seeds()) {
        const g = rng(seed);
        const calls: Op[] = [];
        let n = 0;
        for (let k = 0; k < 12; k++) {
          const tid = `tkt_${String(g.int(1, 16)).padStart(4, '0')}`;
          const roll = g.int(0, 5);
          if (roll === 0) calls.push({ method: 'DELETE', path: `/tickets/${tid}`, query: {}, body: null });
          else if (roll === 1) calls.push({ method: 'POST', path: '/agents', query: {}, body: { name: `Fuzz ${seed}-${n}`, email: `f${seed}x${n++}@example.test`, on_call: g.bool() } });
          else if (roll === 2) calls.push({ method: 'PATCH', path: `/tickets/${tid}`, query: {}, body: { status: g.pick(['open', 'pending', 'closed']) } });
          else if (roll === 3) calls.push({ method: 'PATCH', path: `/tickets/${tid}`, query: {}, body: { priority: g.pick(['low', 'normal', 'high', 'urgent']), assignee: g.pick([null, ...BASE_AGENTS]) } });
          else calls.push({ method: 'POST', path: '/tickets', query: {}, body: { subject: `Fuzz ${seed}-${k}`, status: 'open', priority: g.pick(['low', 'urgent']), ref_code: `HD-${7000 + seed * 20 + k}`, assignee: g.pick([null, ...BASE_AGENTS]) } });
        }
        if (fails(calls)) failWithRepro('G-47 walk disagrees with the dump after writes', seed, calls, fails);
      }
      // Vacuity guard: if every write was refused, the walks only re-checked the seed.
      assert.ok(wrote > 0, 'no fuzz write succeeded, so no walk ran over a written state');
    });

    it(`G-48 RT-122 assignee=null selects the unassigned tickets ${N}`, seededOpts(), () => {
      const c = checkedBase();
      const rt = createRuntime(c);
      const tickets = listRoutes(c).find((r) => r.path === '/tickets');
      assert.ok(tickets);
      assert.deepEqual(checkWalk(rt, shapeOf(c), tickets, { assignee: 'null' }, null, FACTS.unassigned), []);
    });

    it(`G-48 RT-123 a query on an undeclared filter field is refused, not silently ignored ${N}`, rtOpts(), () => {
      const rt = createRuntime(checkedBase());
      for (const q of [{ credit: '0' }, { subject: 'Case 1' }, { ref_code: 'HD-1005' }, { escalated: 'true' }]) {
        const res = rt.call({ method: 'GET', path: '/tickets', query: q, body: null });
        assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(q)} -> ${res.status}`);
      }
    });

    it(`G-47 RT-124 a row created mid-walk appears exactly once, at the end ${N}`, seededOpts(), () => {
      const c = checkedBase();
      const rt = createRuntime(c);
      const p1 = rt.call({ method: 'GET', path: '/tickets', query: {}, body: null });
      const body = p1.body as Record<string, unknown>;
      const created = rt.call({ method: 'POST', path: '/tickets', query: {}, body: { subject: 'Mid-walk', status: 'open', priority: 'low', ref_code: 'HD-8001' } });
      assert.equal((created.body as Record<string, unknown>)['id'], FACTS.nextTicketId);
      const rest = walkFrom(rt, c, '/tickets', {}, String(body['next_cursor']));
      assert.deepEqual([...ids(body['data'] as Row[]), ...rest], [...FACTS.ticketIds, FACTS.nextTicketId]);
    });

    it(`G-47 RT-124 deleting seen rows, or the cursor row, mid-walk skips nothing ${N}`, seededOpts(), () => {
      const c = checkedBase();
      for (const victim of ['tkt_0001', 'tkt_0003']) {
        const rt = createRuntime(c);
        const p1 = rt.call({ method: 'GET', path: '/tickets', query: {}, body: null });
        const body = p1.body as Record<string, unknown>;
        const del = rt.call({ method: 'DELETE', path: `/tickets/${victim}`, query: {}, body: null });
        assert.ok(del.status >= 200 && del.status < 300, `delete ${victim} -> ${del.status}`);
        const rest = walkFrom(rt, c, '/tickets', {}, String(body['next_cursor']));
        assert.deepEqual(rest, FACTS.ticketIds.slice(3), `after deleting ${victim}`);
      }
    });

    it(`G-48 RT-124 a seen row leaving the filter mid-walk does not shift later pages ${N}`, seededOpts(), () => {
      const c = checkedBase();
      const rt = createRuntime(c);
      const p1 = rt.call({ method: 'GET', path: '/tickets', query: { status: 'open', limit: '2' }, body: null });
      const body = p1.body as Record<string, unknown>;
      assert.deepEqual(ids(body['data'] as Row[]), FACTS.openTickets.slice(0, 2));
      const patch = rt.call({ method: 'PATCH', path: `/tickets/${FACTS.openTickets[0]}`, query: {}, body: { status: 'pending' } });
      assert.ok(patch.status >= 200 && patch.status < 300, `patch -> ${patch.status}`);
      const rest = walkFrom(rt, c, '/tickets', { status: 'open', limit: '2' }, String(body['next_cursor']));
      assert.deepEqual(rest, FACTS.openTickets.slice(2));
    });

    it(`G-47 RT-18 the base walk over HTTP with encoded cursors gives FACTS.ticketPages ${N}`, opts(cap('cli.serve', 'runtime.seed'), { timeout: 60_000 }), async () => {
      const s = await serveWorld(baseWorld());
      try {
        const pages: string[][] = [];
        let cursor: string | null = null;
        do {
          const r = await s.api.get(`/tickets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
          assert.equal(r.status, 200, r.text);
          const b = r.body as Record<string, unknown>;
          pages.push(ids(b['data'] as Row[]));
          const cv = cursorValue(b['next_cursor']);
          assert.ok(cv.ok, `next_cursor is ${JSON.stringify(b['next_cursor'])}`);
          cursor = cv.cursor;
          assert.ok(pages.length <= FACTS.ticketPages.length, 'too many pages');
        } while (cursor);
        assert.deepEqual(pages, FACTS.ticketPages.map((p) => [...p]));
        const filtered = await s.api.get(`/tickets?status=open&limit=2`);
        assert.equal(filtered.status, 200, filtered.text);
        assert.deepEqual(ids((filtered.body as Record<string, unknown>)['data'] as Row[]), FACTS.openTickets.slice(0, 2));
      } finally {
        await s.stop();
      }
    });
  });
}

/** Continue a walk from `cursor` and return the ids seen. */
function walkFrom(rt: Runtime, c: CheckedWorld, path: string, query: Query, cursor: string): string[] {
  const shape = c.meta.api.list;
  const out: string[] = [];
  let cur: string | null = cursor;
  for (let k = 0; cur !== null && k < 30; k++) {
    const res = rt.call({ method: 'GET', path, query: { ...query, [shape.cursorParam]: cur }, body: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const b = res.body as Record<string, unknown>;
    out.push(...ids(b[shape.dataKey] as Row[]));
    const cv = cursorValue(b[shape.cursorKey]);
    assert.ok(cv.ok, `${shape.cursorKey} is ${JSON.stringify(b[shape.cursorKey])}`);
    cur = cv.cursor;
  }
  return out;
}
