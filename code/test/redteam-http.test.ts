/**
 * Red-team HTTP suite: `world serve` over every worldsUnderTest(), driven through the CLI
 * (startServer). Covers G-41 to G-45 on the wire, plus G-09 and G-11 to G-17 as an agent
 * would attack them over HTTP.
 *
 * Every probe runs through `runCases`, which takes the admin state before and after each
 * request. Expectations are literals (FACTS) or invariance: a refused request must leave the
 * admin `GET /_world/state` deep-equal, including `now`. A successful read must leave the
 * tables deep-equal (RT-02 lets `now` tick).
 *
 * Raw requests go through node:http rather than fetch, because fetch normalizes `..`, `%2e`
 * and absolute-form targets before they reach the server.
 */
import { after, describe, it, type TestOptions } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime, dumpSha256, type ApiRequest, type StateDump } from '#engine';
import { SEED, cap, checkedBase, opts, probeCli, rng, seeds, startServer, serveWorld, type Server } from './redteam/harness.ts';
import { FACTS, SEED_PRIORITY, SEED_STATUS, worldsUnderTest, type WorldUnderTest } from './redteam/world.ts';

await probeCli();
const WORLDS = await worldsUnderTest();

/** Options for every test here: needs `world serve`, and gets a generous timeout. */
function http(...extra: TestOptions[]): TestOptions {
  return opts(cap('cli.serve'), { timeout: 120_000 }, ...extra);
}

// ---------------------------------------------------------------------------------------
// World shape, read loosely from the raw input (prod worlds come from loadWorld, unchecked)

type Loose = Readonly<Record<string, unknown>>;
const obj = (x: unknown): Loose => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Loose) : {});
const str = (x: unknown, fallback: string): string => (typeof x === 'string' ? x : fallback);

type RouteInfo = {
  readonly id: string;
  /** null for actions. */
  readonly op: string | null;
  readonly method: string;
  readonly path: string;
  readonly entity: string | null;
  readonly filters: readonly string[];
  /** The list route's default page size, null when not a list or not declared. */
  readonly pageSize: number | null;
  /** Declared field names of the body: the entity's fields for routes, the input for actions. */
  readonly fields: readonly string[];
};
/** How a world's lists page: the opaque cursor contract, or stripe mode's has_more with starting_after / ending_before ids. */
type ListShape = {
  readonly dataKey: string;
  readonly limitParam: string;
  /** Query parameters that take a page position: the cursor, or starting_after and ending_before. */
  readonly positionParams: readonly [string, ...string[]];
  /** The response key that says whether a walk goes on: cursorKey, or hasMoreKey. */
  readonly nextKey: string;
  /** Why the value under nextKey is malformed, or null. */
  readonly nextProblem: (value: unknown) => string | null;
  /** The value of positionParams[0] that fetches the page after this one, or null on the last page. */
  readonly next: (body: Loose) => string | null;
  /** Table rows (id order) in the order the list returns them. */
  readonly order: (table: readonly Row[]) => Row[];
};
type Info = {
  readonly name: string;
  readonly isBase: boolean;
  readonly errorTemplate: unknown;
  readonly list: ListShape;
  readonly routes: readonly RouteInfo[];
  readonly tasks: readonly string[];
  /** Every field name any entity declares. */
  readonly declaredFields: ReadonlySet<string>;
  readonly clockStart: string | null;
};

const DEFAULT_ERROR = { error: { code: '$code', message: '$message' } };

/** Id order, the same as the store's: shorter numeric suffix first, then code units. */
const idOrder = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

function listShapeOf(raw: Loose): ListShape {
  const dataKey = str(raw['dataKey'], 'data');
  const limitParam = str(raw['limitParam'], 'limit');
  if (raw['mode'] === 'stripe') {
    const hasMoreKey = str(raw['hasMoreKey'], 'has_more');
    return {
      dataKey, limitParam, nextKey: hasMoreKey,
      positionParams: [str(raw['startingAfterParam'], 'starting_after'), str(raw['endingBeforeParam'], 'ending_before')],
      nextProblem: (value) => (typeof value === 'boolean' ? null : `${hasMoreKey} is ${JSON.stringify(value)}, not a boolean`),
      next: (body) => {
        const data = body[dataKey];
        const last = Array.isArray(data) ? obj(data.at(-1))['id'] : undefined;
        return body[hasMoreKey] === true && typeof last === 'string' ? last : null;
      },
      order: (table) => [...table].sort((a, b) =>
        Date.parse(String(b['created_at'])) - Date.parse(String(a['created_at'])) || idOrder(String(b['id']), String(a['id']))),
    };
  }
  const cursorKey = str(raw['cursorKey'], 'next_cursor');
  // RT-120: a cursor is a non-empty string or a finite number; null or absent ends the walk.
  const cursorOf = (c: unknown): string | null => ((typeof c === 'string' && c !== '') || (typeof c === 'number' && Number.isFinite(c)) ? String(c) : null);
  return {
    dataKey, limitParam, nextKey: cursorKey,
    positionParams: [str(raw['cursorParam'], 'cursor')],
    nextProblem: (value) => (value === null || value === undefined || cursorOf(value) !== null ? null : `${cursorKey} is ${JSON.stringify(value)}`),
    next: (body) => cursorOf(body[cursorKey]),
    order: (table) => [...table],
  };
}

function infoOf(w: WorldUnderTest): Info {
  const input = obj(w.input);
  const meta = obj(input['meta']);
  const fieldsOf = (entity: string | null): string[] => (entity ? Object.keys(obj(obj(obj(input['entities'])[entity])['fields'])) : []);
  const api = obj(meta['api']);
  const listRaw = obj(api['list']);
  const routes: RouteInfo[] = Object.entries(obj(input['routes'])).map(([id, r]) => {
    const o = obj(r);
    const filters = Array.isArray(o['filters']) ? o['filters'].filter((f): f is string => typeof f === 'string') : [];
    const entity = str(o['entity'], '') || null;
    const pageSize = typeof o['pageSize'] === 'number' ? o['pageSize'] : null;
    return { id, op: str(o['op'], 'unknown'), method: str(o['method'], 'GET'), path: str(o['path'], '/'), entity, filters, pageSize, fields: fieldsOf(entity) };
  });
  for (const [id, a] of Object.entries(obj(input['actions']))) {
    const o = obj(a);
    const path = str(o['path'], '/');
    const head = /^[^{]*\{[^}]+\}/.exec(path)?.[0];
    const owner = head ? routes.find((r) => r.op !== null && r.path === head) : undefined;
    routes.push({ id, op: null, method: str(o['method'], 'POST'), path, entity: owner?.entity ?? null, filters: [], pageSize: null, fields: Object.keys(obj(o['input'])) });
  }
  return {
    name: w.name,
    isBase: w.dir === null && w.name === 'redteam_base',
    errorTemplate: api['error'] === undefined ? DEFAULT_ERROR : api['error'],
    list: listShapeOf(listRaw),
    routes,
    tasks: Object.keys(obj(input['tasks'])),
    declaredFields: new Set(Object.keys(obj(input['entities'])).flatMap((e) => fieldsOf(e))),
    clockStart: typeof obj(meta['clock'])['start'] === 'string' ? (obj(meta['clock'])['start'] as string) : null,
  };
}

const fill = (path: string, id: string): string => path.replace(/\{[^}]+\}/g, id);
const lists = (i: Info): RouteInfo[] => i.routes.filter((r) => r.op === 'list' && !r.path.includes('{'));
/** Routes that take a body: create, update and actions. DELETE may legitimately ignore a body. */
const writes = (i: Info): RouteInfo[] => i.routes.filter((r) => r.op !== 'list' && r.op !== 'get' && r.op !== 'delete' && r.method !== 'GET' && r.method !== 'DELETE');

// ---------------------------------------------------------------------------------------
// Raw HTTP

type RawRes = { readonly status: number | null; readonly text: string; readonly body: unknown; readonly headers: IncomingHttpHeaders; readonly error: string | null };
type StreamSpec = { readonly head: string; readonly chunk: Buffer; readonly count: number };
type RawOpts = { readonly headers?: Readonly<Record<string, string>>; readonly body?: string | Buffer; readonly stream?: StreamSpec; readonly timeoutMs?: number };

function parseJson(text: string): unknown {
  try {
    return text === '' ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function pump(req: ClientRequest, s: StreamSpec, stop: () => boolean): Promise<void> {
  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        req.off('drain', done);
        req.off('close', done);
        req.off('error', done);
        resolve();
      };
      req.once('drain', done);
      req.once('close', done);
      req.once('error', done);
    });
  if (!req.write(s.head)) await wait();
  for (let i = 0; i < s.count && !stop() && !req.destroyed; i++) {
    if (!req.write(s.chunk)) await wait();
  }
  if (!stop() && !req.destroyed) req.end();
}

/** One request with the target sent byte for byte. Never throws: a dropped connection gives status null. */
function rawRequest(base: string, method: string, path: string, o: RawOpts = {}): Promise<RawRes> {
  const u = new URL(base);
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: RawRes): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    const fail = (error: string): void => finish({ status: null, text: '', body: undefined, headers: {}, error });
    const headers: Record<string, string> = { accept: 'application/json', connection: 'close', ...o.headers };
    const has = (h: string): boolean => Object.keys(headers).some((k) => k.toLowerCase() === h);
    if ((o.body !== undefined || o.stream) && !has('content-type')) headers['content-type'] = 'application/json';
    if (o.body !== undefined && !has('content-length')) headers['content-length'] = String(Buffer.byteLength(o.body));
    let req: ClientRequest;
    try {
      req = httpRequest({ host: u.hostname, port: Number(u.port), method, path, headers, agent: false });
    } catch (e) {
      fail(`client could not send: ${(e as Error).message}`);
      return;
    }
    timer = setTimeout(() => {
      req.destroy();
      fail(`no response within ${o.timeoutMs ?? 30_000} ms`);
    }, o.timeoutMs ?? 30_000);
    req.on('error', (e) => fail(e.message));
    req.on('response', (res) => {
      const bufs: Buffer[] = [];
      const done = (): void => {
        const text = Buffer.concat(bufs).toString('utf8');
        finish({ status: res.statusCode ?? null, text, body: parseJson(text), headers: res.headers, error: null });
        req.destroy();
      };
      res.on('data', (b: Buffer) => bufs.push(b));
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    if (o.stream) void pump(req, o.stream, () => settled);
    else req.end(o.body);
  });
}

/** Write raw bytes to a socket and read until the server closes or the timeout. */
function rawSocket(base: string, payload: string, timeoutMs = 3_000): Promise<{ readonly status: number | null; readonly text: string }> {
  const u = new URL(base);
  return new Promise((resolve) => {
    const sock = connect(Number(u.port), u.hostname);
    let text = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(t);
      sock.destroy();
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(text);
      resolve({ status: m ? Number(m[1]) : null, text });
    };
    const t = setTimeout(finish, timeoutMs);
    sock.on('connect', () => sock.write(payload, 'latin1'));
    sock.on('data', (d: Buffer) => (text += d.toString('latin1')));
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', finish);
  });
}

// ---------------------------------------------------------------------------------------
// Server lifecycle and admin state

type Live = { readonly s: Server; readonly fresh: unknown };

/** The admin state dump: the route's sha-256 digest (YOS-183) must match it and is dropped, so the dump compares with Runtime.dump(). */
async function adminState(s: Server): Promise<unknown> {
  const r = await s.adminApi.get('/_world/state');
  assert.equal(r.status, 200, `admin GET /_world/state returned ${r.status}: ${r.text.slice(0, 300)}`);
  const { sha256, ...dump } = r.body as Record<string, unknown>;
  assert.equal(sha256, dumpSha256(dump as unknown as StateDump), 'the admin digest matches its dump');
  return dump;
}

function lazyServer(w: WorldUnderTest): { get(): Promise<Live>; stop(): Promise<void> } {
  let p: Promise<Live> | null = null;
  return {
    get() {
      p ??= (async () => {
        const s = w.dir ? await startServer(w.dir) : await serveWorld(w.input);
        return { s, fresh: await adminState(s) };
      })();
      return p;
    },
    async stop() {
      if (!p) return;
      const live = await p.catch(() => null);
      await live?.s.stop();
    },
  };
}

/** Admin reset, which must restore the state seen right after start (G-43). */
async function pristine(live: Live): Promise<void> {
  const r = await live.s.adminApi.post('/_world/reset', {});
  assert.ok(r.status >= 200 && r.status < 300, `admin reset returned ${r.status}`);
  assert.deepEqual(await adminState(live.s), live.fresh, 'admin reset did not restore the fresh state');
}

/** Move the clock through the admin port, so a leaked reset on the world port would show. */
async function dirty(live: Live): Promise<void> {
  const r = await live.s.adminApi.post('/_world/clock', { advance: '1h' });
  assert.ok(r.status >= 200 && r.status < 300, `admin clock returned ${r.status}: ${r.text.slice(0, 300)}`);
}

async function alive(s: Server): Promise<boolean> {
  const r = await rawRequest(s.base, 'GET', '/__redteam_ping', { timeoutMs: 5_000 });
  return r.status !== null && r.status < 500;
}

type Row = Readonly<Record<string, unknown>>;
function rows(state: unknown, entity: string): Row[] {
  const t = obj(obj(state)['tables'])[entity];
  return Array.isArray(t) ? (t as Row[]) : [];
}
const row = (state: unknown, entity: string, id: string): Row | undefined => rows(state, entity).find((r) => r['id'] === id);
const tablesOf = (state: unknown): unknown => obj(state)['tables'];
function firstIdOf(state: unknown, entity: string | null): string {
  const id = entity ? rows(state, entity)[0]?.['id'] : undefined;
  return typeof id === 'string' ? id : 'redteam_missing_0001';
}

// ---------------------------------------------------------------------------------------
// Envelope matching (G-16)

/** null when `body` has the shape of the meta.api.error template, else what differs. */
function envelopeMismatch(body: unknown, tmpl: unknown, status: number, at = '$'): string | null {
  if (tmpl === '$code') return typeof body === 'string' && body.length > 0 ? null : `${at}: $code should be a non-empty string, got ${JSON.stringify(body)}`;
  if (tmpl === '$message') return typeof body === 'string' ? null : `${at}: $message should be a string, got ${JSON.stringify(body)}`;
  if (tmpl === '$status') return String(body) === String(status) ? null : `${at}: $status should be ${status}, got ${JSON.stringify(body)}`;
  if (typeof tmpl === 'string' && /\$(code|message|status)/.test(tmpl)) return typeof body === 'string' ? null : `${at}: should be a string`;
  if (Array.isArray(tmpl)) {
    if (!Array.isArray(body) || body.length !== tmpl.length) return `${at}: should be an array of ${tmpl.length}`;
    for (let i = 0; i < tmpl.length; i++) {
      const m = envelopeMismatch(body[i], tmpl[i], status, `${at}[${i}]`);
      if (m) return m;
    }
    return null;
  }
  if (tmpl !== null && typeof tmpl === 'object') {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return `${at}: should be an object, got ${JSON.stringify(body)?.slice(0, 120)}`;
    const want = Object.keys(tmpl).sort();
    const got = Object.keys(body).sort();
    if (!isDeepStrictEqual(want, got)) return `${at}: keys ${JSON.stringify(got)} should be ${JSON.stringify(want)}`;
    for (const k of want) {
      const m = envelopeMismatch((body as Loose)[k], (tmpl as Loose)[k], status, `${at}.${k}`);
      if (m) return m;
    }
    return null;
  }
  return isDeepStrictEqual(body, tmpl) ? null : `${at}: should be ${JSON.stringify(tmpl)}, got ${JSON.stringify(body)}`;
}

/** The value at the `$code` slot of the template. */
function envelopeCode(body: unknown, tmpl: unknown): unknown {
  if (tmpl === '$code') return body;
  if (tmpl !== null && typeof tmpl === 'object') {
    for (const [k, v] of Object.entries(tmpl)) {
      const found = envelopeCode(obj(body)[k], v);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// The probe loop

const VIOLATION = [400, 409, 422] as const;
const REF_VIOLATION = [400, 404, 409, 422] as const;
const NOT_FOUND = [404, 405] as const;
const is4xx = (n: number): boolean => n >= 400 && n < 500;
const is2xx = (n: number): boolean => n >= 200 && n < 300;

type Case = {
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly o?: RawOpts;
  /**
   * refuse: a 4xx (from `statuses` when given) and the full state unchanged.
   * page:   a 4xx with the state unchanged, or a 2xx list page with the tables unchanged.
   * safe:   anything below 500. A 4xx leaves the state unchanged. `check` judges a 2xx.
   */
  readonly kind: 'refuse' | 'page' | 'safe';
  readonly statuses?: readonly number[];
  /** Check the error envelope on a 4xx (default true; never for HEAD). */
  readonly envelope?: boolean;
  /** A dropped connection is acceptable (huge bodies). The state must still be unchanged. */
  readonly allowDrop?: boolean;
  /**
   * Max rows in a 2xx page (kind page). Default: the route's pageSize when the path never
   * names the limit param (G-46), else 200 (RT-05).
   */
  readonly maxRows?: number;
  /** The list route (kind page): a 2xx page holds rows of its table, in table (id) order, each once. */
  readonly route?: RouteInfo;
  /**
   * Kind page, no filter and no cursor: a 2xx page must be the first rows of the table, and a
   * null cursor must mean the page holds the whole table. Catches `slice(0, -1)` and `limit=0`
   * pages that end the walk early.
   */
  readonly prefix?: boolean;
  readonly check?: (r: RawRes, before: unknown, after: unknown) => string | null;
};

function pageMismatch(body: unknown, list: ListShape, maxRows: number): string | null {
  const b = obj(body);
  const data = b[list.dataKey];
  if (!Array.isArray(data)) return `2xx body has no ${list.dataKey} array: ${JSON.stringify(body)?.slice(0, 200)}`;
  if (data.length > maxRows) return `page of ${data.length} rows, above ${maxRows}`;
  if (!data.every((r) => typeof obj(r)['id'] === 'string')) return 'a row has no string id';
  return list.nextProblem(b[list.nextKey]);
}

/** null when the 2xx page holds rows of `table` in list order, each once (and, with `prefix`, the first ones). */
function pageRowsMismatch(body: unknown, list: ListShape, table: readonly Row[], prefix: boolean): string | null {
  const b = obj(body);
  const got = (b[list.dataKey] as unknown[]).map((r) => String(obj(r)['id']));
  const order = list.order(table).map((r) => String(r['id']));
  const at = got.map((id) => order.indexOf(id));
  const missing = got.filter((_, k) => at[k] === -1);
  if (missing.length) return `page rows ${JSON.stringify(missing)} are not in the table`;
  if (!at.every((x, k) => k === 0 || x > (at[k - 1] ?? -1))) return `page rows ${JSON.stringify(got)} are not in list order, or repeat`;
  if (!prefix) return null;
  if (!at.every((x, k) => x === k)) return `page ${JSON.stringify(got)} is not the first rows of the list ${JSON.stringify(order.slice(0, got.length))}`;
  if (list.next(b) === null && got.length !== order.length) return `${list.nextKey} ends the walk after ${got.length} of ${order.length} rows, so a walk would stop early`;
  return null;
}

/** RT-03: a 404 or 405 body is JSON (HEAD has no body). */
function jsonOnNotFound(c: Case, r: RawRes): string | null {
  if (r.status !== 404 && r.status !== 405) return null;
  if (c.method === 'HEAD' || r.body !== undefined) return null;
  return `a ${r.status} body is not JSON (RT-03): ${JSON.stringify(r.text.slice(0, 120))}`;
}

function judge(i: Info, c: Case, r: RawRes, before: unknown, after: unknown): string[] {
  const tag = `${c.label}: ${c.method} ${c.path.length > 120 ? `${c.path.slice(0, 120)}...` : c.path}`;
  const out: string[] = [];
  const unchanged = isDeepStrictEqual(before, after);
  if (r.status === null) {
    if (!c.allowDrop) out.push(`${tag} -> no response (${r.error})`);
    if (!unchanged) out.push(`${tag} -> state changed after a dropped request`);
    return out;
  }
  const st = r.status;
  const said = `${tag} -> ${st} ${r.text.slice(0, 160)}`;
  if (st >= 500) return [`${said} (5xx)`];
  if (c.kind === 'refuse') {
    const ok = c.statuses ? c.statuses.includes(st) : is4xx(st);
    if (!ok) out.push(`${said} (expected ${c.statuses ? c.statuses.join('/') : '4xx'})`);
  }
  if (!is2xx(st)) {
    if (!unchanged) out.push(`${said} (state changed on a refused request)`);
    if (is4xx(st) && c.envelope !== false && c.method !== 'HEAD') {
      const m = envelopeMismatch(r.body, i.errorTemplate, st);
      if (m) out.push(`${said} (error envelope: ${m})`);
    }
    const j = jsonOnNotFound(c, r);
    if (j) out.push(`${said} (${j})`);
  } else if (c.kind === 'page') {
    const names = c.path.includes(i.list.limitParam);
    const maxRows = c.maxRows ?? (!names && c.route?.pageSize != null ? c.route.pageSize : 200);
    const m = pageMismatch(r.body, i.list, maxRows);
    if (m) out.push(`${said} (${m})`);
    else if (c.route?.entity) {
      const m2 = pageRowsMismatch(r.body, i.list, rows(after, c.route.entity), c.prefix === true);
      if (m2) out.push(`${said} (${m2})`);
    }
    if (!isDeepStrictEqual(tablesOf(before), tablesOf(after))) out.push(`${said} (a read changed the tables)`);
  }
  if (c.check) {
    const m = c.check(r, before, after);
    if (m) out.push(`${said} (${m})`);
  }
  return out;
}

async function runCases(live: Live, i: Info, cases: readonly Case[]): Promise<string[]> {
  const problems: string[] = [];
  let before = await adminState(live.s);
  for (const c of cases) {
    const r = await rawRequest(live.s.base, c.method, c.path, c.o);
    const after = await adminState(live.s);
    problems.push(...judge(i, c, r, before, after));
    before = after;
  }
  if (!(await alive(live.s))) problems.push('the world port stopped answering');
  return problems;
}

const report = (problems: readonly string[]): string => `${problems.length} problem(s):\n${problems.slice(0, 40).join('\n')}`;

/** Body text helpers. */
const J = (x: unknown): RawOpts => ({ body: JSON.stringify(x) });
const RAW = (body: string, headers?: Record<string, string>): RawOpts => (headers ? { body, headers } : { body });

// ---------------------------------------------------------------------------------------
// /_world/* on the world port (G-42)

type AdminTarget = { readonly method: string; readonly rest: string; readonly body?: string };

function adminTargets(i: Info): AdminTarget[] {
  const task = i.tasks[0] ?? 'redteam_task';
  return [
    { method: 'GET', rest: 'state' },
    { method: 'GET', rest: 'log' },
    { method: 'POST', rest: 'reset', body: '{}' },
    { method: 'POST', rest: 'clock', body: '{"advance":"4h"}' },
    { method: 'POST', rest: `grade/${task}`, body: '{}' },
    { method: 'PUT', rest: 'state', body: '{"now":"2030-01-01T00:00:00.000Z","tables":{}}' },
    { method: 'DELETE', rest: 'state' },
    { method: 'PATCH', rest: 'clock', body: '{"advance":"4h"}' },
  ];
}

/**
 * Plain `/_world/*` targets must be 404 or 405 (G-42). Encoded, traversal, suffixed and
 * absolute-form targets are unknown paths (RT-03: 404 or 405) or malformed requests (G-45: a
 * 4xx, and Node's own parser answers 400), so they may also be 400.
 */
const NOT_FOUND_OR_MALFORMED = [400, 404, 405] as const;

function adminCases(i: Info, label: string, paths: (rest: string) => readonly string[], statuses: readonly number[] = NOT_FOUND): Case[] {
  return adminTargets(i).flatMap((t) =>
    paths(t.rest).map((path): Case => ({
      label,
      method: t.method,
      path,
      ...(t.body !== undefined ? { o: { body: t.body } } : {}),
      kind: 'refuse',
      statuses,
      envelope: false,
      check: notAdmin,
    })),
  );
}

/** A 2xx on the world port must never carry the admin state dump or the call log. */
function notAdmin(r: RawRes): string | null {
  const b = obj(r.body);
  if ('tables' in b && 'now' in b) return 'the response looks like the admin state dump';
  if (Array.isArray(r.body) && r.body.some((x) => 'seq' in obj(x))) return 'the response looks like the admin log';
  // Wrapped or nested leaks: {"error":{...},"state":{"tables":...}} or a 404 carrying the log.
  if (/"tables"\s*:\s*\{/.test(r.text)) return 'the response carries the admin tables';
  if (/"seq"\s*:\s*\d/.test(r.text) && /"routeId"\s*:/.test(r.text)) return 'the response carries admin log records';
  return null;
}

// ---------------------------------------------------------------------------------------
// Tests

for (const w of WORLDS) {
  const info = infoOf(w);
  const server = lazyServer(w);
  const N = `[${w.name}]`;
  const L = lists(info);
  const W = writes(info);

  describe(`http ${N}`, () => {
    // Inside the describe, so each world's serve process is reaped when its tests end, not when the file does.
    after(() => server.stop());
    // The harness serves with --port 0, so the admin port is the one serve reported, not the world port + 1; the +1
    // default for an explicit --port is pinned in test/http.test.ts (R2) (YOS-233).
    it(`G-41 world port serves a fresh seed and admin answers on the admin port serve reported ${N}`, http(), async () => {
      const live = await server.get();
      assert.deepEqual([new URL(live.s.base).port, new URL(live.s.admin).port], [String(live.s.port), String(live.s.adminPort)]);
      assert.notEqual(live.s.adminPort, live.s.port);
      const st = obj(live.fresh);
      if (info.clockStart !== null) assert.equal(Date.parse(String(st['now'])), Date.parse(info.clockStart), 'fresh now is not meta.clock.start');
      if (info.isBase) {
        assert.equal(st['now'], FACTS.clockStart);
        assert.deepEqual(rows(st, 'ticket').map((r) => r['id']), [...FACTS.ticketIds]);
        assert.deepEqual(rows(st, 'agent').map((r) => r['id']), [...FACTS.agentIds]);
        assert.equal(rows(st, 'job_run').length, FACTS.counts.job_run);
        // A fresh seed, not a state left behind by world tests or task verification.
        assert.deepEqual(rows(st, 'ticket').map((r) => r['status']), [...SEED_STATUS], 'ticket statuses are not the seed statuses');
        assert.deepEqual(rows(st, 'ticket').map((r) => r['priority']), [...SEED_PRIORITY], 'ticket priorities are not the seed priorities');
        assert.deepEqual(rows(st, 'ticket').map((r) => r['escalated']), FACTS.ticketIds.map(() => false), 'a seed ticket is already escalated');
        assert.deepEqual(rows(st, 'ticket').filter((r) => r['assignee'] === null).map((r) => r['id']), [...FACTS.unassigned]);
      }
      // The world port reads the same rows the admin port dumps (one runtime, not two seeded alike or not).
      for (const r of L) {
        const res = await rawRequest(live.s.base, 'GET', r.path);
        assert.equal(res.status, 200, `GET ${r.path} returned ${res.status}`);
        assert.equal(pageMismatch(res.body, info.list, r.pageSize ?? 200), null);
        if (r.entity && r.pageSize !== null) {
          const got = (obj(res.body)[info.list.dataKey] as unknown[]).map((x) => obj(x)['id']);
          assert.deepEqual(got, info.list.order(rows(live.fresh, r.entity)).slice(0, r.pageSize).map((x) => x['id']), `GET ${r.path} first page differs from the admin dump`);
        }
      }
      // A write on the world port shows on the admin port, and an admin reset shows on the world port.
      let coupled = false;
      for (const d of info.routes.filter((x) => x.op === 'delete' && x.entity !== null)) {
        const victim = rows(live.fresh, d.entity ?? '').at(-1)?.['id'];
        if (typeof victim !== 'string') continue;
        const del = await rawRequest(live.s.base, 'DELETE', fill(d.path, victim));
        if (del.status === null || !is2xx(del.status)) continue;
        assert.equal(row(await adminState(live.s), d.entity ?? '', victim), undefined, `DELETE ${victim} on the world port is not in the admin dump`);
        const getRoute = info.routes.find((x) => x.op === 'get' && x.entity === d.entity);
        if (getRoute) assert.equal((await rawRequest(live.s.base, 'GET', fill(getRoute.path, victim))).status, 404, `${victim} still served after delete`);
        await pristine(live);
        if (getRoute) {
          const back = await rawRequest(live.s.base, 'GET', fill(getRoute.path, victim));
          assert.ok(back.status !== null && is2xx(back.status), `${victim} not served after admin reset: ${back.status}`);
        }
        coupled = true;
        break;
      }
      if (info.isBase) assert.ok(coupled, 'no delete succeeded on the world port, so world/admin coupling was never checked');
      if (info.isBase) {
        // The get body's shape is not documented, so the reset is judged by invariance: the
        // world port serves the same body before the PATCH and after the admin reset.
        const seen = (await live.s.api.get(`/tickets/${FACTS.hd1005}`)).body;
        const p = await live.s.api.patch(`/tickets/${FACTS.hd1005}`, { status: 'pending' });
        assert.ok(is2xx(p.status), `PATCH -> ${p.status} ${p.text}`);
        assert.equal(row(await adminState(live.s), 'ticket', FACTS.hd1005)?.['status'], 'pending', 'a world-port PATCH is not in the admin dump');
        await pristine(live);
        assert.deepEqual((await live.s.api.get(`/tickets/${FACTS.hd1005}`)).body, seen, 'admin reset is not seen on the world port');
      }
    });

    it(`G-42 admin routes are 404 or 405 on the world port and change nothing ${N}`, http(), async () => {
      const live = await server.get();
      await dirty(live);
      const cases = adminCases(info, 'plain', (rest) => [`/_world/${rest}`, '/_world', '/_world/']);
      for (const head of ['/_world/state', '/_world/log', '/_world']) cases.push({ label: 'HEAD', method: 'HEAD', path: head, kind: 'refuse', statuses: NOT_FOUND });
      // OPTIONS may be a generic CORS answer, but must not carry admin data.
      cases.push({ label: 'OPTIONS', method: 'OPTIONS', path: '/_world/state', kind: 'safe', envelope: false, check: notAdmin });
      for (const m of ['TRACE', 'PROPFIND', 'BREW']) {
        cases.push({ label: 'odd method', method: m, path: '/_world/state', kind: 'refuse', statuses: [400, 404, 405], envelope: false, allowDrop: true });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-42 encoded and case-folded admin paths are refused ${N}`, http(), async () => {
      const live = await server.get();
      await dirty(live);
      const cases = adminCases(info, 'encoded', (rest) => [
        `/%5F_world/${rest}`, `/%5f_world/${rest}`, `/%5F%77orld/${rest}`, `/_WORLD/${rest}`, `/_World/${rest}`, `/_world/${rest.toUpperCase()}`,
        `/_world%2F${rest}`, `/_world%2f${rest}`, `/%2F_world/${rest}`, `/_world/${encodeURIComponent(rest).replace(/[a-z]/, (ch) => `%${ch.charCodeAt(0).toString(16)}`)}`,
        `/＿world/${rest}`.replace('＿', '%EF%BC%BF'),
      ], NOT_FOUND_OR_MALFORMED);
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-42 path traversal and double slashes cannot reach admin routes ${N}`, http(), async () => {
      const live = await server.get();
      await dirty(live);
      const anyList = L[0]?.path ?? '/redteam_nowhere';
      const cases = adminCases(info, 'traversal', (rest) => [
        `//_world/${rest}`, `///_world/${rest}`, `/./_world/${rest}`, `/_world/./${rest}`, `/_world//${rest}`,
        `${anyList}/../_world/${rest}`, `${anyList}/%2e%2e/_world/${rest}`, `${anyList}/%2E%2E%2F_world/${rest}`, `${anyList}/..%2F_world/${rest}`,
        `/.%2e/_world/${rest}`, `/_world/${rest}/../${rest}`, `/_world\\${rest}`, `/%5C_world/${rest}`, `/x/..//_world/${rest}`,
      ], NOT_FOUND_OR_MALFORMED);
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-42 trailing slash, query, matrix, fragment and NUL suffixes are refused ${N}`, http(), async () => {
      const live = await server.get();
      await dirty(live);
      const cases = adminCases(info, 'suffix', (rest) => [
        `/_world/${rest}/`, `/_world/${rest}?`, `/_world/${rest}?a=1`, `/_world/${rest};a=1`, `/_world/${rest}%00`, `/_world/${rest}%20`,
        `/_world/${rest}#frag`, `/_world/${rest}.json`, `/_world/${rest}%3Fa=1`, `/_world/${rest}?${encodeURIComponent('__proto__[x]')}=1`,
      ], NOT_FOUND_OR_MALFORMED);
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-42 absolute-form targets and Host headers naming the admin port are refused ${N}`, http(), async () => {
      const live = await server.get();
      await dirty(live);
      const adminHost = `127.0.0.1:${live.s.adminPort}`;
      const cases = [
        ...adminCases(info, 'absolute-form', (rest) => [`http://${adminHost}/_world/${rest}`, `http://127.0.0.1:${live.s.port}/_world/${rest}`, `http://localhost/_world/${rest}`], NOT_FOUND_OR_MALFORMED),
        ...adminCases(info, 'host header', (rest) => [`/_world/${rest}`]).map((c): Case => ({ ...c, o: { ...c.o, headers: { host: adminHost } } })),
      ];
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-42 method-override and URL-rewrite headers cannot reach admin routes ${N}`, http(), async () => {
      const live = await server.get();
      await dirty(live);
      const overrides = ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override'];
      const cases: Case[] = [];
      for (const h of overrides) {
        for (const [m, path, to] of [['GET', '/_world/state', 'POST'], ['POST', '/_world/reset', 'GET'], ['GET', '/_world/reset', 'POST'], ['POST', '/_world/clock', 'GET']] as const) {
          cases.push({ label: h, method: m, path, o: { headers: { [h]: to }, ...(m === 'POST' ? { body: '{"advance":"4h"}' } : {}) }, kind: 'refuse', statuses: NOT_FOUND, envelope: false });
        }
      }
      // A rewrite header on an ordinary path must not route to an admin handler. `/` is no
      // route, so it must stay a 404 or 405: a 2xx from a rewritten reset changes the dirty state
      // and must not pass as "safe".
      const rootDeclared = info.routes.some((r) => r.path === '/');
      const tablesSame = (r: RawRes, b: unknown, a: unknown): string | null =>
        notAdmin(r) ?? (isDeepStrictEqual(tablesOf(b), tablesOf(a)) && obj(a)['now'] !== obj(live.fresh)['now'] ? null : 'the state moved, as by an admin reset');
      for (const h of ['X-Original-URL', 'X-Rewrite-URL', 'X-Forwarded-Prefix', 'X-Forwarded-Path']) {
        for (const target of ['/_world/state', '/_world/reset', '/_world/log']) {
          for (const m of ['GET', 'POST'] as const) {
            const o: RawOpts = m === 'POST' ? { headers: { [h]: target }, body: '{}' } : { headers: { [h]: target } };
            cases.push(rootDeclared
              ? { label: h, method: m, path: '/', o, kind: 'safe', envelope: false, ...(m === 'GET' ? { check: tablesSame } : { check: notAdmin }) }
              : { label: h, method: m, path: '/', o, kind: 'refuse', statuses: NOT_FOUND, check: notAdmin });
          }
        }
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-16 an unknown route answers in the meta.api.error envelope with a non-empty code ${N}`, http(), async () => {
      const live = await server.get();
      const r = await rawRequest(live.s.base, 'GET', '/redteam_no_such_route');
      assert.ok(r.status === 404 || r.status === 405, `status ${r.status}`);
      assert.equal(envelopeMismatch(r.body, info.errorTemplate, r.status ?? 0), null, r.text);
      const code = envelopeCode(r.body, info.errorTemplate);
      assert.ok(typeof code === 'string' && code.length > 0, `code ${JSON.stringify(code)}`);
    });

    it(`G-16 RT-126 an error body carries a JSON content-type ${N}`, http(), async () => {
      const live = await server.get();
      const r = await rawRequest(live.s.base, 'GET', '/redteam_no_such_route');
      assert.match(String(r.headers['content-type']), /json/);
    });

    it(`G-45 unknown routes, wrong methods and DELETE on collections are 404 or 405 ${N}`, http(), async () => {
      const live = await server.get();
      const st = await adminState(live.s);
      const cases: Case[] = [
        { label: 'unknown', method: 'GET', path: '/redteam_nowhere', kind: 'refuse', statuses: NOT_FOUND },
        { label: 'unknown', method: 'POST', path: '/redteam_nowhere', o: J({ a: 1 }), kind: 'refuse', statuses: NOT_FOUND },
        { label: 'root', method: 'DELETE', path: '/', kind: 'refuse', statuses: NOT_FOUND },
        { label: 'deep', method: 'GET', path: '/a/b/c/d/e/f/g/h/i/j/k', kind: 'refuse', statuses: NOT_FOUND },
      ];
      for (const r of L) cases.push({ label: 'extra segment', method: 'GET', path: `${r.path}/x/y/z`, kind: 'refuse', statuses: NOT_FOUND });
      // Every method a path does not declare, including DELETE and PATCH on a collection.
      const templates = new Map<string, { entity: string | null; methods: Set<string> }>();
      for (const r of info.routes) {
        const key = fill(r.path, '{_}');
        const t = templates.get(key) ?? { entity: r.entity, methods: new Set<string>() };
        t.methods.add(r.method);
        t.entity ??= r.entity;
        templates.set(key, t);
      }
      for (const [key, t] of templates) {
        const path = fill(key, firstIdOf(st, t.entity));
        for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
          if (t.methods.has(m)) continue;
          cases.push({ label: `undeclared ${m}`, method: m, path, ...(m === 'GET' || m === 'DELETE' ? {} : { o: J({}) }), kind: 'refuse', statuses: NOT_FOUND });
        }
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 malformed JSON on every write route is a 4xx in the envelope and changes nothing ${N}`, http(), async () => {
      const live = await server.get();
      const st = await adminState(live.s);
      const bad = ['{', '{"a":}', "{'a':1}", '{"a":1,}', 'NaN', '{"a":1}{"b":2}', '\uFEFF{"a":1', '{"a":"\\x41"}', '{"a":1e999999}x', 'undefined', '{"a":"unterminated', '{"a":1', '}{'];
      const cases: Case[] = [];
      for (const r of W) {
        const path = fill(r.path, firstIdOf(st, r.entity));
        for (const b of bad) cases.push({ label: `malformed ${JSON.stringify(b)}`, method: r.method, path, o: RAW(b), kind: 'refuse' });
        // An empty body may read as {} on a route with no required fields.
        for (const b of ['', ' ']) cases.push({ label: `empty ${JSON.stringify(b)}`, method: r.method, path, o: RAW(b), kind: 'safe' });
        cases.push({ label: 'invalid UTF-8', method: r.method, path, o: { body: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }, kind: 'safe' });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-45 non-object JSON bodies on every write route are refused ${N}`, http(), async () => {
      const live = await server.get();
      const st = await adminState(live.s);
      const cases: Case[] = [];
      for (const r of W) {
        const path = fill(r.path, firstIdOf(st, r.entity));
        for (const b of ['[]', '[{}]', '"x"', '1', 'true', '-0', '1e308']) cases.push({ label: `non-object ${b}`, method: r.method, path, o: RAW(b), kind: 'refuse' });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 bodies nested 100000 deep get a 4xx without crashing the server ${N}`, http(), async () => {
      const live = await server.get();
      const st = await adminState(live.s);
      const depth = 100_000;
      const arr = '['.repeat(depth) + ']'.repeat(depth);
      const objs = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
      const cases: Case[] = [];
      for (const r of [...W, { method: 'POST', path: '/redteam_nowhere', entity: null, fields: [] as readonly string[] } as const]) {
        const path = fill(r.path, firstIdOf(st, r.entity));
        cases.push({ label: 'deep arrays', method: r.method, path, o: RAW(arr), kind: 'refuse' });
        // Under a declared field a nested object or array is a type violation for every field
        // type, so it must be a 4xx. Under the unknown key `a` it may be dropped (RT-15).
        const f = r.fields[0];
        if (f === undefined) cases.push({ label: 'deep objects', method: r.method, path, o: RAW(objs), kind: r.path === '/redteam_nowhere' ? 'refuse' : 'safe' });
        else {
          cases.push({ label: `deep object in ${f}`, method: r.method, path, o: RAW(`{${JSON.stringify(f)}:${objs}}`), kind: 'refuse' });
          cases.push({ label: `deep array in ${f}`, method: r.method, path, o: RAW(`{${JSON.stringify(f)}:${arr}}`), kind: 'refuse' });
        }
        // Deep value under an unknown key: the parser may accept it, but logging or hashing must not crash (RT-15).
        cases.push({ label: 'deep value in unknown key', method: r.method, path, o: RAW(`{"redteam_pad":${objs}}`), kind: 'safe' });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      const log = await live.s.adminApi.get('/_world/log');
      assert.ok(log.status < 500, `admin log returned ${log.status} after deep bodies`);
      await pristine(live);
    });

    it(`G-45 a 2 MB body gets a 4xx or normal processing, and the server stays up ${N}`, http(), async () => {
      const live = await server.get();
      const st = await adminState(live.s);
      const big = 'x'.repeat(2 * 1024 * 1024);
      const cases: Case[] = [{ label: '2MB unknown route', method: 'POST', path: '/redteam_nowhere', o: RAW(JSON.stringify({ pad: big })), kind: 'refuse', allowDrop: true }];
      for (const r of W) {
        const path = fill(r.path, firstIdOf(st, r.entity));
        cases.push({ label: '2MB string body', method: r.method, path, o: RAW(JSON.stringify(big)), kind: 'refuse', allowDrop: true });
        cases.push({ label: '2MB of whitespace, then []', method: r.method, path, o: RAW(`${' '.repeat(2 * 1024 * 1024)}[]`), kind: 'refuse', allowDrop: true });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 a 50 MB streamed body is refused or dropped without taking the server down ${N}`, http(), async () => {
      const live = await server.get();
      const st = await adminState(live.s);
      const target = W.find((r) => r.op === 'create') ?? W[0];
      const path = target ? fill(target.path, firstIdOf(st, target.entity)) : '/redteam_nowhere';
      const stream: StreamSpec = { head: '{"redteam_pad":"', chunk: Buffer.alloc(1024 * 1024, 0x78), count: 50 };
      const problems = await runCases(live, info, [
        { label: '50MB chunked', method: target?.method ?? 'POST', path, o: { stream, timeoutMs: 90_000 }, kind: 'refuse', allowDrop: true, envelope: false },
        { label: '50MB chunked, unknown route', method: 'POST', path: '/redteam_nowhere', o: { stream, timeoutMs: 90_000 }, kind: 'refuse', allowDrop: true, envelope: false },
        { label: 'lying content-length', method: 'POST', path, o: { body: '{}'.padEnd(64, ' '), headers: { 'content-length': '8' } }, kind: 'safe', allowDrop: true, envelope: false },
      ]);
      assert.deepEqual(problems, [], report(problems));
      for (const r of L) {
        const res = await rawRequest(live.s.base, 'GET', r.path);
        assert.equal(res.status, 200, `GET ${r.path} after the stream returned ${res.status}`);
      }
    });

    it(`G-45 invalid percent-encoding and NUL or RTL characters in paths are 4xx ${N}`, http(), async () => {
      const live = await server.get();
      const st = await adminState(live.s);
      const cases: Case[] = [];
      for (const bad of ['/%', '/%ZZ', '/%FF', '/%E0%A4%A', '/%C0%AF', '/%ED%A0%80', '/%00']) cases.push({ label: 'bad percent', method: 'GET', path: bad, kind: 'refuse' });
      for (const r of info.routes.filter((x) => x.op === 'get' || x.op === 'update' || x.op === 'delete')) {
        const id = firstIdOf(st, r.entity);
        const variants = [`${id}%00`, `%E2%80%AE${id}`, `${id}%E2%80%8F`, `${id}%20`, `%20${id}`, `${id}%0A`, `${id}%`, `${id}%FF`, '%', '%E0%A4%A', encodeURIComponent('‮evil\u0000'), encodeURIComponent('🎫')];
        for (const v of variants) {
          cases.push({ label: `${r.op} odd id`, method: r.method, path: fill(r.path, v), ...(r.method === 'PATCH' ? { o: J({}) } : {}), kind: 'refuse' });
        }
      }
      for (const r of L) {
        for (const q of ['%', '%ZZ=1', 'a=%FF', ...info.list.positionParams.map((p) => `${p}=%`), `${info.list.limitParam}=%00`]) cases.push({ label: 'bad query encoding', method: 'GET', path: `${r.path}?${q}`, kind: 'page', route: r });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-45 Object.prototype names as paths, ids, query keys and body keys never crash ${N}`, http(), async () => {
      const live = await server.get();
      const names = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'isPrototypeOf'];
      const cases: Case[] = [];
      for (const n of names) cases.push({ label: 'top-level name', method: 'GET', path: `/${n}`, kind: 'refuse', statuses: NOT_FOUND });
      for (const r of info.routes.filter((x) => x.op === 'get' || x.op === 'update' || x.op === 'delete')) {
        for (const n of names) cases.push({ label: `${r.op} id ${n}`, method: r.method, path: fill(r.path, n), ...(r.method === 'PATCH' ? { o: J({}) } : {}), kind: 'refuse', statuses: [404] });
      }
      for (const r of L) {
        for (const n of names) {
          cases.push({ label: 'query key', method: 'GET', path: `${r.path}?${n}=1`, kind: 'page', route: r });
          cases.push({ label: 'query bracket', method: 'GET', path: `${r.path}?${encodeURIComponent(`${n}[polluted]`)}=1`, kind: 'page', route: r });
          cases.push({ label: 'limit value', method: 'GET', path: `${r.path}?${info.list.limitParam}=${n}`, kind: 'page', route: r, prefix: true });
        }
        cases.push({ label: 'constructor.prototype', method: 'GET', path: `${r.path}?constructor.prototype.polluted=1&__proto__.polluted=1`, kind: 'page', route: r });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      const after = JSON.stringify(await adminState(live.s));
      assert.ok(!after.includes('polluted'), 'a polluted key reached the state');
    });

    it(`G-45 prototype-pollution keys in write bodies never reach rows or other requests ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const st = await adminState(live.s);
      const bodies = [
        '{"__proto__":{"polluted":"yes"}}',
        '{"constructor":{"prototype":{"polluted":"yes"}}}',
        '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
        '{"toString":"x","hasOwnProperty":"x","valueOf":1}',
      ];
      // No row may gain an own key named after an Object.prototype member (unless the world
      // declares such a field), and no 2xx may echo the polluted value.
      const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', 'polluted'].filter((k) => !info.declaredFields.has(k));
      const clean = (r: RawRes, _b: unknown, a: unknown): string | null => {
        if (r.status !== null && is2xx(r.status) && r.text.includes('polluted')) return 'a 2xx echoed the polluted value';
        for (const e of Object.keys(obj(obj(a)['tables']))) {
          for (const x of rows(a, e)) {
            const bad = PROTO_KEYS.filter((k) => Object.hasOwn(x, k));
            if (bad.length) return `${e} ${String(x['id'])} stored ${JSON.stringify(bad)}`;
          }
        }
        return null;
      };
      const cases: Case[] = [];
      for (const r of W) {
        const path = fill(r.path, firstIdOf(st, r.entity));
        for (const b of bodies) cases.push({ label: 'pollution body', method: r.method, path, o: RAW(b), kind: 'safe', check: clean });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      const text = JSON.stringify(await adminState(live.s));
      assert.ok(!text.includes('polluted'), 'a polluted key reached the state');
      for (const r of L) {
        const res = await rawRequest(live.s.base, 'GET', r.path);
        assert.ok(!res.text.includes('polluted'), `GET ${r.path} shows a polluted key`);
      }
      await pristine(live);
    });

    it(`G-45 repeated query params give a 4xx or a valid page ${N}`, http(), async () => {
      const live = await server.get();
      const { limitParam: lp, positionParams } = info.list;
      const cases: Case[] = [];
      for (const r of L) {
        for (const q of [`${lp}=1&${lp}=2`, `${lp}=1&${lp}=abc`, `${lp}[]=1`, `${lp}[0]=1&${lp}[1]=2`]) cases.push({ label: 'repeated limit', method: 'GET', path: `${r.path}?${q}`, kind: 'page', route: r, prefix: true });
        for (const cp of positionParams) {
          for (const q of [`${cp}=a&${cp}=b`, `${cp}[]=x`]) cases.push({ label: 'repeated cursor', method: 'GET', path: `${r.path}?${q}`, kind: 'page', route: r });
        }
        for (const f of r.filters) cases.push({ label: 'repeated filter', method: 'GET', path: `${r.path}?${f}=a&${f}=b`, kind: 'page', route: r }, { label: 'array filter', method: 'GET', path: `${r.path}?${f}[]=a`, kind: 'page', route: r });
        cases.push({ label: 'many params', method: 'GET', path: `${r.path}?${Array.from({ length: 500 }, (_, k) => `p${k}=${k}`).join('&')}`, kind: 'page', route: r });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 bad limit values give a 4xx or a page of at most 200 rows (RT-05, RT-06) ${N}`, http(), async () => {
      const live = await server.get();
      const lp = info.list.limitParam;
      const bad = ['0', '-1', '-0', '1.5', 'abc', '', '1e3', '201', '1000000', '99999999999999999999', '0x10', '%202', '2abc', 'NaN', 'Infinity', '+1', '1,2', 'null', 'true', '%D9%A3', '9007199254740993'];
      // A 2xx must be the first rows of the table: `slice(0, -1)` or an empty `limit=0` page with a
      // null cursor would end a client walk early and pass a size-only check.
      const cases: Case[] = L.flatMap((r) => bad.map((v): Case => ({ label: `limit=${v}`, method: 'GET', path: `${r.path}?${lp}=${v}`, kind: 'page', maxRows: 200, route: r, prefix: true })));
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 forged, tampered and foreign cursors give a 4xx or a valid page (RT-06) ${N}`, http(), async () => {
      const live = await server.get();
      const { positionParams, limitParam: lp } = info.list;
      const b64 = (s: string): string => encodeURIComponent(Buffer.from(s).toString('base64url'));
      const forged = [
        'garbage', 'null', 'undefined', '0', '-1', '99999999', '%00', '../../_world/state', encodeURIComponent('{"$gt":""}'), 'x'.repeat(8000),
        b64('{"id":"zzz_9999"}'), b64('{"offset":-5}'), b64('{"offset":1000000000}'), b64('{"__proto__":{"polluted":1}}'), b64('[]'), b64('null'), b64('{"after":"tkt_0000","limit":100000}'),
        encodeURIComponent(Buffer.from('{"id":"tkt_0001"}').toString('base64')),
      ];
      const cases: Case[] = [];
      const real: string[] = [];
      for (const r of L) {
        const first = await rawRequest(live.s.base, 'GET', `${r.path}?${lp}=1`);
        const c = info.list.next(obj(first.body));
        if (c !== null) real.push(c);
      }
      for (const r of L) {
        for (const cp of positionParams) {
          // No limit in the path, so a 2xx page holds at most pageSize rows: a cursor must not smuggle in a limit.
          for (const f of forged) cases.push({ label: 'forged cursor', method: 'GET', path: `${r.path}?${cp}=${f}`, kind: 'page', route: r });
          for (const c of real) {
            const flipped = c.slice(0, -1) + (c.endsWith('A') ? 'B' : 'A');
            for (const v of [c, c.slice(0, -1), flipped, c + c, c.split('').reverse().join('')]) {
              cases.push({ label: 'tampered or foreign cursor', method: 'GET', path: `${r.path}?${cp}=${encodeURIComponent(v)}`, kind: 'page', route: r });
            }
            cases.push({ label: 'cursor with limit 0', method: 'GET', path: `${r.path}?${cp}=${encodeURIComponent(c)}&${lp}=0`, kind: 'page', route: r });
          }
        }
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 content-type abuse never gives a 5xx, and form bodies are refused ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const st = await adminState(live.s);
      const cases: Case[] = [];
      for (const r of W) {
        const path = fill(r.path, firstIdOf(st, r.entity));
        cases.push({ label: 'form body', method: r.method, path, o: RAW('a=1&b=2', { 'content-type': 'application/x-www-form-urlencoded' }), kind: 'refuse' });
        cases.push({ label: 'multipart', method: r.method, path, o: RAW('--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n', { 'content-type': 'multipart/form-data; boundary=x' }), kind: 'refuse' });
        cases.push({ label: 'xml', method: r.method, path, o: RAW('<a>1</a>', { 'content-type': 'application/xml' }), kind: 'refuse' });
        cases.push({ label: 'text/plain JSON', method: r.method, path, o: RAW('{}', { 'content-type': 'text/plain' }), kind: 'safe' });
        cases.push({ label: 'utf-16 label', method: r.method, path, o: RAW('{}', { 'content-type': 'application/json; charset=utf-16' }), kind: 'safe' });
        cases.push({ label: 'gzip claimed', method: r.method, path, o: RAW('{}', { 'content-encoding': 'gzip' }), kind: 'safe' });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-45 garbage on the socket never gives a 5xx and leaves the server up ${N}`, http(), async () => {
      const live = await server.get();
      // Dirty first: a smuggled POST /_world/reset on an already fresh state would change nothing.
      await dirty(live);
      const before = await adminState(live.s);
      const payloads = [
        'GET /redteam_nowhere HTTP/1.1\r\nHost: x\r\n\r\nPOST /_world/reset HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
        'GET /redteam_nowhere HTTP/1.1\r\nHost: x\r\n\r\nGET /_world/state HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
        'GARBAGE\r\n\r\n',
        'GET\r\n\r\n',
        'GET /_world/state HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'a'.repeat(64 * 1024) + '\r\nConnection: close\r\n\r\n',
        'POST /redteam_nowhere HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\nPOST /_world/reset HTTP/1.1\r\nHost: x\r\n\r\n',
        'POST /redteam_nowhere HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nZZZ\r\n',
        'GET /_world/state HTTP/1.1\r\nHost: x\r\nHost: y\r\nConnection: close\r\n\r\n',
        'GET /\x00 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
        '\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03',
      ];
      const problems: string[] = [];
      for (const p of payloads) {
        const r = await rawSocket(live.s.base, p);
        if (r.status !== null && r.status >= 500) problems.push(`${JSON.stringify(p.slice(0, 60))} -> ${r.status}`);
        if (/"tables"\s*:/.test(r.text)) problems.push(`${JSON.stringify(p.slice(0, 60))} leaked the admin state`);
      }
      assert.deepEqual(problems, [], report(problems));
      assert.ok(await alive(live.s), 'the world port stopped answering');
      assert.deepEqual(await adminState(live.s), before, 'socket garbage changed the state');
    });

    it(`G-45 seeded fuzz: random requests never give a 5xx, and every 4xx changes nothing ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const st = await adminState(live.s);
      const ids = Object.keys(obj(obj(st)['tables'])).flatMap((e) => rows(st, e).slice(0, 2).map((r) => String(r['id'])));
      const segs = ['', '..', '.', '%2e', '%00', '__proto__', '_world', 'x'.repeat(300), '%FF', ...ids, ...info.routes.map((r) => r.path.split('/')[1] ?? '')];
      const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'];
      const values = ['null', '1', '-1', '1.5', '"x"', '[]', '{}', 'true', '""', JSON.stringify('\u0000‮'), '1e999', '{"__proto__":{}}'];
      const problems: string[] = [];
      for (const seed of seeds()) {
        const g = rng(seed);
        const cases: Case[] = [];
        for (let k = 0; k < 8; k++) {
          const route = info.routes.length > 0 ? g.pick(info.routes) : undefined;
          let path = g.bool(0.7) && route ? fill(route.path, g.pick(segs)) : `/${Array.from({ length: g.int(1, 4) }, () => g.pick(segs)).join('/')}`;
          if (g.bool(0.3)) path += `?${g.pick([info.list.limitParam, ...info.list.positionParams, 'q', 'status', '__proto__'])}=${encodeURIComponent(g.pick(values))}`;
          const method = g.pick(methods);
          const fields = route?.entity ? Object.keys(obj(obj(obj(obj(w.input)['entities'])[route.entity])['fields'])) : [];
          const body = method === 'GET' || method === 'HEAD' ? undefined : g.bool(0.2) ? g.pick(['{', '[', '"', '{"a":}', '']) : `{${fields.filter(() => g.bool(0.4)).map((f) => `${JSON.stringify(f)}:${g.pick(values)}`).join(',')}}`;
          cases.push({ label: `seed ${seed} #${k}`, method, path, ...(body !== undefined ? { o: { body } } : {}), kind: 'safe', envelope: method !== 'OPTIONS', check: notAdmin });
        }
        const found = await runCases(live, info, cases);
        if (found.length) problems.push(`REDTEAM_SEED=${seed} REDTEAM_ITER=1 bun run test (base seed ${SEED})`, ...found);
        await pristine(live);
      }
      assert.deepEqual(problems, [], report(problems));
    });

    if (!info.isBase) return;

    // -----------------------------------------------------------------------------------
    // Base-world agent attacks with fixture ids (FACTS)

    const unchangedTicket = (id: string, keys: readonly string[]) => (_r: RawRes, before: unknown, after: unknown): string | null => {
      const a = row(before, 'ticket', id);
      const b = row(after, 'ticket', id);
      if (!b) return `${id} disappeared`;
      for (const k of keys) if (!isDeepStrictEqual(a?.[k], b[k])) return `${id}.${k} changed from ${JSON.stringify(a?.[k])} to ${JSON.stringify(b[k])}`;
      return null;
    };

    it(`G-11 RT-34 PATCH of id, created_at or updated_at is refused or ignored, never honored ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const problems = await runCases(live, info, [
        { label: 'id', method: 'PATCH', path: '/tickets/tkt_0001', o: J({ id: 'tkt_9999' }), kind: 'safe',
          check: (_r, _b, a) => (row(a, 'ticket', 'tkt_0001') && !row(a, 'ticket', 'tkt_9999') ? null : 'the id was rewritten') },
        { label: 'id to another row', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ id: 'tkt_0001' }), kind: 'safe',
          check: (_r, _b, a) => (rows(a, 'ticket').filter((t) => t['id'] === 'tkt_0001').length === 1 && row(a, 'ticket', 'tkt_0002') ? null : 'ids collided') },
        { label: 'created_at', method: 'PATCH', path: '/tickets/tkt_0001', o: J({ created_at: '1999-01-01T00:00:00.000Z' }), kind: 'safe', check: unchangedTicket('tkt_0001', ['created_at']) },
        { label: 'updated_at', method: 'PATCH', path: '/tickets/tkt_0001', o: J({ updated_at: '1999-01-01T00:00:00.000Z' }), kind: 'safe',
          check: (_r, _b, a) => (row(a, 'ticket', 'tkt_0001')?.['updated_at'] === '1999-01-01T00:00:00.000Z' ? 'updated_at was forged' : null) },
        { label: 'POST with id', method: 'POST', path: '/tickets', o: J({ id: 'tkt_0001', subject: 'Forged id', status: 'open', priority: 'low', ref_code: 'HD-3001' }), kind: 'safe',
          check: (r, b, a) => {
            if (!isDeepStrictEqual(row(b, 'ticket', 'tkt_0001'), row(a, 'ticket', 'tkt_0001'))) return 'tkt_0001 was overwritten';
            return r.status !== null && is2xx(r.status) && obj(r.body)['id'] !== FACTS.nextTicketId ? `created id ${JSON.stringify(obj(r.body)['id'])}, expected ${FACTS.nextTicketId}` : null;
          } },
        { label: 'POST with created_at', method: 'POST', path: '/tickets', o: J({ created_at: '1999-01-01T00:00:00.000Z', subject: 'Forged time', status: 'open', priority: 'low', ref_code: 'HD-3002' }), kind: 'safe',
          check: (r, _b, a) => {
            if (r.status === null || !is2xx(r.status)) return null;
            if (obj(r.body)['created_at'] === '1999-01-01T00:00:00.000Z') return 'created_at was forged in the response';
            const id = obj(r.body)['id'];
            return typeof id === 'string' && row(a, 'ticket', id)?.['created_at'] === '1999-01-01T00:00:00.000Z' ? 'created_at was forged in the stored row' : null;
          } },
      ]);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-13 readonly fields are refused by standard create and update ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const problems = await runCases(live, info, [
        { label: 'PATCH escalated true', method: 'PATCH', path: '/tickets/tkt_0001', o: J({ escalated: true }), kind: 'refuse', statuses: VIOLATION },
        { label: 'PATCH escalated smuggled with a legal field', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ escalated: true, subject: 'smuggled' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'POST escalated', method: 'POST', path: '/tickets', o: J({ subject: 'Readonly probe', status: 'open', priority: 'low', ref_code: 'HD-3003', escalated: true }), kind: 'refuse', statuses: VIOLATION },
      ]);
      assert.deepEqual(problems, [], report(problems));
      // The other half of G-13: an action may set a readonly field (an engine that also blocks actions fails here).
      const e = await live.s.api.post('/tickets/tkt_0002/escalate', { reason: 'readonly via action' });
      assert.ok(is2xx(e.status), `${e.status} ${e.text}`);
      const t = row(await adminState(live.s), 'ticket', 'tkt_0002');
      assert.equal(t?.['escalated'], true, 'the action could not set the readonly field');
      assert.equal(t?.['priority'], 'urgent');
      await pristine(live);
    });

    it(`G-12 illegal and unknown state transitions over PATCH are refused ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const [open] = FACTS.openTickets;
      const [closed] = FACTS.closedTickets;
      const cases: Case[] = [
        { label: 'open -> closed', method: 'PATCH', path: `/tickets/${open}`, o: J({ status: 'closed' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'closed -> open', method: 'PATCH', path: `/tickets/${closed}`, o: J({ status: 'open' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'closed -> pending', method: 'PATCH', path: `/tickets/${closed}`, o: J({ status: 'pending' }), kind: 'refuse', statuses: VIOLATION },
      ];
      for (const s of ['archived', '', 'OPEN', 'Pending', ' pending', 'pending ', 'pending\u0000', 1, true, ['pending'], { to: 'pending' }]) {
        cases.push({ label: `status ${JSON.stringify(s)}`, method: 'PATCH', path: `/tickets/${open}`, o: J({ status: s }), kind: 'refuse', statuses: VIOLATION });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-12 open -> pending -> closed is accepted over HTTP ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const a = await live.s.api.patch('/tickets/tkt_0001', { status: 'pending' });
      assert.ok(is2xx(a.status), `${a.status} ${a.text}`);
      const b = await live.s.api.patch('/tickets/tkt_0001', { status: 'closed' });
      assert.ok(is2xx(b.status), `${b.status} ${b.text}`);
      assert.equal(row(await adminState(live.s), 'ticket', 'tkt_0001')?.['status'], 'closed');
      await pristine(live);
    });

    it(`G-11 nulls on required or non-nullable fields are refused, and a nullable ref accepts null ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const cases: Case[] = ['subject', 'status', 'priority', 'ref_code', 'credit', 'escalated'].map((f): Case => ({
        label: `${f}: null`, method: 'PATCH', path: '/tickets/tkt_0001', o: J({ [f]: null }), kind: 'refuse', statuses: VIOLATION,
      }));
      cases.push({ label: 'POST missing required', method: 'POST', path: '/tickets', o: J({ priority: 'low' }), kind: 'refuse', statuses: VIOLATION });
      cases.push({ label: 'POST agent missing email', method: 'POST', path: '/agents', o: J({ name: 'No Email' }), kind: 'refuse', statuses: VIOLATION });
      cases.push({ label: 'assignee null', method: 'PATCH', path: '/tickets/tkt_0001', o: J({ assignee: null }), kind: 'safe',
        check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', 'tkt_0001')?.['assignee'] === null ? null : 'a nullable ref did not accept null') });
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-14 money accepts only integers at or above min over HTTP ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const cases: Case[] = [12.5, -25, -1, '100', '1250', true, 0.1, 99.99, [100], { amount: 100 }].map((v): Case => ({
        label: `credit ${JSON.stringify(v)}`, method: 'PATCH', path: '/tickets/tkt_0001', o: J({ credit: v }), kind: 'refuse', statuses: VIOLATION,
      }));
      // JSON 1e2 parses to the integer 100, so it must be accepted and stored as 100.
      cases.push({ label: 'credit 1e2 as JSON exponent', method: 'PATCH', path: '/tickets/tkt_0002', o: RAW('{"credit":1e2}'), kind: 'safe',
        check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', 'tkt_0002')?.['credit'] === 100 ? null : 'credit 1e2 was not accepted as 100') });
      // At min (0) is allowed: an off-by-one `> min` check refuses it. 125000 has no upper bound.
      for (const [id, v] of [['tkt_0003', 0], ['tkt_0005', 125_000]] as const) {
        cases.push({ label: `credit ${v} accepted`, method: 'PATCH', path: `/tickets/${id}`, o: J({ credit: v }), kind: 'safe',
          check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', id)?.['credit'] === v ? null : `credit ${v} was not accepted and stored`) });
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-15 refs must resolve and a restrict delete is refused over HTTP ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const cases: Case[] = ['agt_9999', 'tkt_0001', 'AGT_0001', 'agt_0001 ', 42, '', { id: 'agt_0001' }].map((v): Case => ({
        label: `assignee ${JSON.stringify(v)}`, method: 'PATCH', path: '/tickets/tkt_0002', o: J({ assignee: v }), kind: 'refuse', statuses: REF_VIOLATION,
      }));
      cases.push({ label: 'restrict delete', method: 'DELETE', path: `/agents/${FACTS.onCallAgent}`, kind: 'refuse', statuses: REF_VIOLATION });
      cases.push({ label: 'missing id delete', method: 'DELETE', path: '/tickets/tkt_9999', kind: 'refuse', statuses: [404] });
      cases.push({ label: 'missing id patch', method: 'PATCH', path: '/tickets/tkt_9999', o: J({ subject: 'x' }), kind: 'refuse', statuses: [404] });
      // Positives, so an engine that refuses every ref write or every agent delete fails.
      cases.push({ label: 'assignee to an existing agent', method: 'PATCH', path: '/tickets/tkt_0003', o: J({ assignee: 'agt_0003' }), kind: 'safe',
        check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', 'tkt_0003')?.['assignee'] === 'agt_0003' ? null : 'a resolving ref was not accepted') });
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      const made = await live.s.api.post('/agents', { name: 'Unreferenced', email: 'unref@example.test' });
      assert.ok(made.status >= 200 && made.status < 300, made.text);
      assert.equal(obj(made.body)['id'], FACTS.nextAgentId);
      const gone = await live.s.api.del(`/agents/${FACTS.nextAgentId}`);
      assert.ok(gone.status >= 200 && gone.status < 300, `deleting an agent no ticket points at returned ${gone.status}: ${gone.text}`);
      assert.equal(row(await adminState(live.s), 'agent', FACTS.nextAgentId), undefined);
      await pristine(live);
    });

    it(`G-11 unique and pattern violations are refused over HTTP ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const problems = await runCases(live, info, [
        { label: 'duplicate ref_code', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ ref_code: 'HD-1001' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'pattern', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ ref_code: 'HD-12' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'maxLength', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ subject: 'x'.repeat(121) }), kind: 'refuse', statuses: VIOLATION },
        { label: 'duplicate email', method: 'POST', path: '/agents', o: J({ name: 'Ava Clone', email: 'ava@example.test' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'bad email', method: 'POST', path: '/agents', o: J({ name: 'Bad Mail', email: 'not-an-email' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'enum', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ priority: 'critical' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'nested object value', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ subject: { $set: 'x' } }), kind: 'refuse', statuses: VIOLATION },
        // Positives at the edges: a unique check that counts the row itself, an off-by-one
        // maxLength or a pattern that is too strict would refuse these.
        { label: 'own ref_code again', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ ref_code: 'HD-1002' }), kind: 'safe',
          check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', 'tkt_0002')?.['ref_code'] === 'HD-1002' ? null : 're-sending a row\'s own unique value was refused') },
        { label: 'subject of exactly 120', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ subject: 'y'.repeat(120) }), kind: 'safe',
          check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', 'tkt_0002')?.['subject'] === 'y'.repeat(120) ? null : 'a subject at maxLength was refused') },
        { label: 'fresh ref_code', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ ref_code: 'HD-0000' }), kind: 'safe',
          check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', 'tkt_0002')?.['ref_code'] === 'HD-0000' ? null : 'a fresh pattern-valid ref_code was refused') },
        { label: 'old ref_code is free again', method: 'PATCH', path: '/tickets/tkt_0003', o: J({ ref_code: 'HD-1002' }), kind: 'safe',
          check: (r, _b, a) => (r.status !== null && is2xx(r.status) && row(a, 'ticket', 'tkt_0003')?.['ref_code'] === 'HD-1002' ? null : 'a unique value freed by an update stayed taken') },
      ]);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-45 RT-15 unknown body fields are refused or dropped, never stored ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const notStored = (r: RawRes, _b: unknown, a: unknown): string | null => {
        const text = JSON.stringify(a);
        return text.includes('redteam_extra') || (r.status !== null && is2xx(r.status) && r.text.includes('redteam_extra')) ? 'an unknown field was stored or echoed' : null;
      };
      const problems = await runCases(live, info, [
        { label: 'PATCH unknown', method: 'PATCH', path: '/tickets/tkt_0002', o: J({ redteam_extra: 1 }), kind: 'safe', check: notStored },
        { label: 'POST unknown', method: 'POST', path: '/tickets', o: J({ subject: 'Unknown field', status: 'open', priority: 'low', ref_code: 'HD-3004', redteam_extra: 'x' }), kind: 'safe', check: notStored },
        // Without fail:true, so the action commits and an engine that merges its body into the row would store the key.
        { label: 'action unknown', method: 'POST', path: '/tickets/tkt_0002/escalate', o: J({ reason: 'probe', redteam_extra: 1 }), kind: 'safe', check: notStored },
      ]);
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-09 an action that writes then fails returns its code in the envelope and writes nothing ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const before = await adminState(live.s);
      const r = await live.s.api.post('/tickets/tkt_0002/escalate', { reason: 'probe', fail: true });
      assert.equal(r.status, 422, r.text);
      assert.equal(envelopeMismatch(r.body, info.errorTemplate, 422), null);
      assert.equal(envelopeCode(r.body, info.errorTemplate), 'forced_failure');
      assert.deepEqual(await adminState(live.s), before);
      const closed = await live.s.api.post(`/tickets/${FACTS.closedTickets[0]}/escalate`, { reason: 'probe' });
      assert.equal(closed.status, 409, closed.text);
      assert.equal(envelopeCode(closed.body, info.errorTemplate), 'ticket_closed');
      assert.deepEqual(await adminState(live.s), before);
      const problems = await runCases(live, info, [
        { label: 'missing reason', method: 'POST', path: '/tickets/tkt_0002/escalate', o: J({}), kind: 'refuse', statuses: VIOLATION },
        { label: 'reason 42', method: 'POST', path: '/tickets/tkt_0002/escalate', o: J({ reason: 42 }), kind: 'refuse', statuses: VIOLATION },
        { label: 'fail "true"', method: 'POST', path: '/tickets/tkt_0002/escalate', o: J({ reason: 'x', fail: 'true' }), kind: 'refuse', statuses: VIOLATION },
        { label: 'missing ticket', method: 'POST', path: '/tickets/tkt_9999/escalate', o: J({ reason: 'x' }), kind: 'refuse', statuses: [404] },
        { label: 'GET on action', method: 'GET', path: '/tickets/tkt_0002/escalate', kind: 'refuse', statuses: NOT_FOUND },
      ]);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 HEAD, OPTIONS and unknown methods on world routes change nothing ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const tablesSame = (_r: RawRes, b: unknown, a: unknown): string | null => (isDeepStrictEqual(tablesOf(b), tablesOf(a)) ? null : 'tables changed');
      const cases: Case[] = [];
      for (const path of ['/tickets', '/tickets/tkt_0001', '/agents', '/tickets/tkt_0001/escalate']) {
        cases.push({ label: 'HEAD', method: 'HEAD', path, kind: 'safe', check: tablesSame });
        cases.push({ label: 'OPTIONS', method: 'OPTIONS', path, kind: 'safe', envelope: false, check: tablesSame });
        for (const m of ['PROPFIND', 'MKCOL', 'PURGE', 'TRACE', 'BREW', 'LINK']) {
          cases.push({ label: m, method: m, path, kind: 'refuse', statuses: [400, 404, 405], envelope: false, allowDrop: true });
        }
      }
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
      assert.equal(rows(await adminState(live.s), 'ticket').length, FACTS.counts.ticket);
    });

    it(`G-45 RT-03 method-override headers cannot turn a POST into a DELETE or PATCH ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const cases: Case[] = [];
      for (const h of ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override']) {
        cases.push({ label: `${h}: DELETE`, method: 'POST', path: '/tickets/tkt_0001', o: { body: '{}', headers: { [h]: 'DELETE' } }, kind: 'refuse', statuses: NOT_FOUND });
        cases.push({ label: `${h}: PATCH`, method: 'POST', path: '/tickets/tkt_0001', o: { body: '{"status":"pending"}', headers: { [h]: 'PATCH' } }, kind: 'refuse', statuses: NOT_FOUND });
        cases.push({ label: `${h}: DELETE on GET`, method: 'GET', path: '/tickets/tkt_0001', o: { headers: { [h]: 'DELETE' } }, kind: 'safe',
          check: (_r, _b, a) => (row(a, 'ticket', 'tkt_0001') ? null : 'tkt_0001 was deleted by a GET') });
        cases.push({ label: `${h}: DELETE on collection`, method: 'POST', path: '/agents', o: { body: '{}', headers: { [h]: 'DELETE' } }, kind: 'refuse', statuses: VIOLATION });
      }
      cases.push({ label: '_method query', method: 'POST', path: '/tickets/tkt_0001?_method=DELETE', o: J({}), kind: 'refuse', statuses: NOT_FOUND });
      const problems = await runCases(live, info, cases);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-45 NUL, RTL and astral characters in a body round-trip exactly or are refused ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const subjects = ['nul\u0000inside', 'rtl ‮exe.txt', 'ticket 🎫 emoji', 'lone \uD800 surrogate', 'zero​width', 'line sep', 'tab\tand\r\nnewline'];
      let n = 0;
      const problems: string[] = [];
      for (const subject of subjects) {
        const ref = `HD-${3100 + n++}`;
        const r = await live.s.api.post('/tickets', { subject, status: 'open', priority: 'low', ref_code: ref });
        if (r.status >= 500) problems.push(`${JSON.stringify(subject)} -> ${r.status}`);
        // An astral character is plain text: refusing it means every subject with an emoji is lost.
        if (subject.includes('🎫') && (r.status < 200 || r.status >= 300)) problems.push(`${JSON.stringify(subject)} was refused with ${r.status}: ${r.text.slice(0, 160)}`);
        if (r.status < 200 || r.status >= 300) continue;
        const id = String(obj(r.body)['id']);
        if (row(await adminState(live.s), 'ticket', id)?.['subject'] !== subject) problems.push(`${JSON.stringify(subject)} stored differently`);
      }
      const s = await adminState(live.s);
      const g = await rawRequest(live.s.base, 'GET', `/tickets?status=${encodeURIComponent('open\u0000')}`);
      if (g.status === null || g.status >= 500) problems.push(`NUL filter -> ${g.status}`);
      assert.deepEqual(tablesOf(await adminState(live.s)), tablesOf(s));
      assert.deepEqual(problems, [], report(problems));
      await pristine(live);
    });

    it(`G-17 RT-41 50 parallel creates get distinct sequential ids ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const res = await Promise.all(
        Array.from({ length: 50 }, (_, k) => live.s.api.post('/agents', { name: `Parallel ${k}`, email: `p${k}@example.test` })),
      );
      assert.deepEqual(res.filter((r) => r.status < 200 || r.status >= 300).map((r) => `${r.status} ${r.text}`), []);
      const ids = res.map((r) => String(obj(r.body)['id'])).sort();
      assert.deepEqual(ids, Array.from({ length: 50 }, (_, k) => `agt_${String(4 + k).padStart(4, '0')}`));
      const st = await adminState(live.s);
      assert.equal(rows(st, 'agent').length, FACTS.counts.agent + 50);
      res.forEach((r, k) => {
        const id = String(obj(r.body)['id']);
        assert.equal(row(st, 'agent', id)?.['email'], `p${k}@example.test`, `${id} holds another request's row`);
      });
      await pristine(live);
    });

    it(`G-10 RT-41 parallel creates with half refused use no ids for the refused half ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const res = await Promise.all(
        Array.from({ length: 50 }, (_, k) =>
          live.s.api.post('/tickets', { subject: `Mixed ${k}`, status: 'open', priority: 'low', ref_code: `HD-${2000 + k}`, credit: k % 2 === 0 ? 100 : -1 }),
        ),
      );
      const ok = res.filter((r) => r.status >= 200 && r.status < 300);
      assert.equal(ok.length, 25, res.map((r) => r.status).join(','));
      assert.ok(res.every((r) => r.status < 500));
      assert.deepEqual(ok.map((r) => String(obj(r.body)['id'])).sort(), Array.from({ length: 25 }, (_, k) => `tkt_${String(12 + k).padStart(4, '0')}`));
      const st = await adminState(live.s);
      assert.equal(rows(st, 'ticket').length, FACTS.counts.ticket + 25);
      assert.deepEqual(rows(st, 'ticket').filter((t) => t['credit'] === -1).map((t) => t['id']), [], 'a refused create left a row');
      const next = await live.s.api.post('/tickets', { subject: 'After mixed', status: 'open', priority: 'low', ref_code: 'HD-2999' });
      assert.equal(obj(next.body)['id'], 'tkt_0037', `next create after 25 refusals got ${next.text}`);
      await pristine(live);
    });

    it(`G-11 RT-41 50 parallel creates with one unique email: exactly one wins ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const res = await Promise.all(Array.from({ length: 50 }, (_, k) => live.s.api.post('/agents', { name: `Racer ${k}`, email: 'race@example.test' })));
      const ok = res.filter((r) => r.status >= 200 && r.status < 300);
      assert.equal(ok.length, 1, res.map((r) => r.status).join(','));
      assert.equal(obj(ok[0]?.body)['id'], FACTS.nextAgentId);
      assert.ok(res.every((r) => r.status < 300 || (VIOLATION as readonly number[]).includes(r.status)), res.map((r) => r.status).join(','));
      assert.equal(rows(await adminState(live.s), 'agent').length, FACTS.counts.agent + 1);
      await pristine(live);
    });

    it(`G-43 admin reset after a burst of writes restores the fresh state ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      // The get body's shape is not documented (RT-127), so the world port's view of the reset
      // is judged by invariance: the same get bodies before the burst and after the reset.
      const t5Before = (await live.s.api.get('/tickets/tkt_0005')).body;
      const t3Before = (await live.s.api.get('/tickets/tkt_0003')).body;
      // Each burst write must land, or the reset below has nothing to undo.
      for (const r of [
        await live.s.api.patch('/tickets/tkt_0005', { status: 'pending' }),
        await live.s.api.post('/tickets/tkt_0003/escalate', { reason: 'unassigned' }),
        await live.s.api.post('/agents', { name: 'Temp', email: 'temp@example.test' }),
      ]) assert.ok(r.status >= 200 && r.status < 300, `burst write returned ${r.status}: ${r.text}`);
      await dirty(live);
      assert.notDeepEqual(await adminState(live.s), live.fresh);
      await pristine(live);
      // The world port sees the reset too (tkt_0005 back to open, the escalation gone, Temp's email free).
      assert.deepEqual((await live.s.api.get('/tickets/tkt_0005')).body, t5Before, 'the world port still serves the pre-reset tkt_0005');
      assert.deepEqual((await live.s.api.get('/tickets/tkt_0003')).body, t3Before, 'the world port still serves the pre-reset escalation');
      const again = await live.s.api.post('/agents', { name: 'After Reset', email: 'temp@example.test' });
      assert.ok(again.status >= 200 && again.status < 300, `an email freed by reset is still taken: ${again.status} ${again.text}`);
      assert.equal(obj(again.body)['id'], FACTS.nextAgentId, 'the id counter was not reset');
      await pristine(live);
    });

    it(`G-44 HTTP and the in-process runtime agree on a mixed call script ${N}`, http(cap('createRuntime', 'runtime.call', 'runtime.dump')), async () => {
      const live = await server.get();
      await pristine(live);
      const script: ApiRequest[] = [
        { method: 'GET', path: '/tickets', query: { limit: '2' }, body: null },
        { method: 'PATCH', path: '/tickets/tkt_0005', query: {}, body: { status: 'pending' } },
        { method: 'PATCH', path: '/tickets/tkt_0001', query: {}, body: { status: 'closed' } },
        { method: 'POST', path: '/tickets/tkt_0003/escalate', query: {}, body: { reason: 'unassigned' } },
        { method: 'POST', path: '/tickets/tkt_0002/escalate', query: {}, body: { reason: 'x', fail: true } },
        { method: 'POST', path: '/tickets', query: {}, body: { subject: 'Agree', status: 'open', priority: 'high', ref_code: 'HD-3500', credit: 250 } },
        { method: 'GET', path: '/tickets/tkt_0012', query: {}, body: null },
        { method: 'DELETE', path: '/agents/agt_0001', query: {}, body: null },
        { method: 'DELETE', path: '/tickets/tkt_0012', query: {}, body: null },
        { method: 'GET', path: '/agents', query: { on_call: 'true' }, body: null },
        { method: 'GET', path: '/tickets/tkt_9999', query: {}, body: null },
      ];
      const rt = createRuntime(checkedBase());
      const norm = (x: unknown): unknown => (x === undefined || x === null ? null : JSON.parse(JSON.stringify(x)));
      for (const req of script) {
        const qs = new URLSearchParams(req.query).toString();
        const h = await live.s.api.request(req.method, req.path + (qs ? `?${qs}` : ''), req.body === null ? undefined : req.body);
        const r = rt.call(req);
        assert.equal(h.status, r.status, `${req.method} ${req.path}`);
        assert.deepEqual(norm(h.body), norm(r.body), `${req.method} ${req.path}`);
      }
      assert.deepEqual(await adminState(live.s), norm(rt.dump()));
      await pristine(live);
    });

    it(`G-12 RT-12 create with a non-initial state is refused ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const problems = await runCases(live, info, [
        { label: 'create closed', method: 'POST', path: '/tickets', o: J({ subject: 'Born closed', status: 'closed', priority: 'low', ref_code: 'HD-3600' }), kind: 'refuse', statuses: VIOLATION },
      ]);
      assert.deepEqual(problems, [], report(problems));
    });

    it(`G-12 RT-125 PATCH to the current state (undeclared self-transition) is refused ${N}`, http(), async () => {
      const live = await server.get();
      await pristine(live);
      const problems = await runCases(live, info, [
        { label: 'open -> open', method: 'PATCH', path: '/tickets/tkt_0001', o: J({ status: 'open' }), kind: 'refuse', statuses: VIOLATION },
      ]);
      assert.deepEqual(problems, [], report(problems));
    });
  });
}
