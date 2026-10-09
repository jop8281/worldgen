/**
 * How HTTP-shaped requests become operations on state.
 *
 * Invariants:
 * - `handle` is pure: (world, state, request) to (state, response). No IO, no wall clock.
 *   Runtime, client scripts and http.ts all go through it.
 * - One call is one transaction. A failed call returns the world's error envelope and the
 *   previous state, with the clock and id counters unchanged.
 * - Time is explicit (design law L8). A committed call moves the clock by `meta.clock.tick`
 *   (0s unless the world opts in) plus the matched action's `duration`, if it declares one.
 * - Lists and errors use `meta.api` shapes. Filters, sort and cursors go through FIELD_TYPES.
 */
import type { CheckedWorld } from './check.ts';
import { MAX_INSTANT, dueJobs, fromIso, parseDuration, parseTick, timeMath, toIso, type Duration, type Instant, type Iso } from './clock.ts';
import {
  SnippetFault, type Change, type ErrorStatus, type HandlerCtx, type JobCtx, type Snippet, type SnippetHost, type SnippetKind,
  type WriteDb,
} from './ctx.ts';
import { RUNTIME_ERROR_CODES, type RuntimeErrorCode } from './error-codes.ts';
import { FIELD_TYPES, initialOf, kindOf, refOf, type Field, type Value } from './fields.ts';
import { STRIPE_MAX_LIMIT, type Action, type Route, type World } from './format.ts';
import { issue, type CheckIssue, type IssuePath } from './issues.ts';
import { EnforceError, initialState, stateHash, transact, type Row, type State, type Tx } from './store.ts';
import { grade as gradeTask } from './tasks.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ApiRequest = {
  /** Any method string: one the engine does not route, such as OPTIONS, is answered 405 and logged like any other call. */
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** Header names are normalized to lower-case at the Runtime/HTTP boundary. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
};
export type ApiResponse = {
  readonly status: number;
  readonly body: unknown;
  /** Runtime.call only: jobs that failed during the call's tick. Absent when none did. */
  readonly jobsFailed?: readonly JobFailure[];
};
/** One row a call committed: how (`op`) and which non-engine fields it wrote. The call's own journal rows. */
export type CallWrite = {
  readonly entity: string;
  readonly id: string;
  readonly op: Change['kind'];
  readonly fields: readonly string[];
};
export type CallRecord = {
  readonly seq: number;
  readonly at: string;
  readonly routeId: string | null;
  readonly req: ApiRequest;
  readonly res: ApiResponse;
  /**
   * The rows this call committed, in journal order. Empty for a read and for every refused call,
   * which is the log's proof that a refused call left no partial change. Jobs that fire in the
   * tick after the call are in the journal, not here.
   */
  readonly writes: readonly CallWrite[];
  /** Jobs the call's tick fired (only on a successful call), as advance() reports them. */
  readonly jobsFired: readonly string[];
  readonly jobsFailed: readonly JobFailure[];
};
export type StateDump = {
  /** meta.name of the world this state belongs to. */
  readonly world: string;
  /** stateHash of tables, counters and idempotency evidence; engine `now` is intentionally excluded. */
  readonly hash: string;
  readonly now: string;
  readonly tables: Readonly<Record<string, readonly Row[]>>;
  readonly counters: Readonly<Record<string, number>>;
  readonly idempotency?: readonly {
    readonly key: string;
    readonly fingerprint: string;
    readonly routeId: string | null;
    readonly response: unknown;
  }[];
};
/** Older dumps may omit `world`, `hash` and the newer idempotency evidence. */
export type DumpInput =
  Omit<StateDump, 'world' | 'hash' | 'idempotency'>
  & {
    readonly world?: string | undefined;
    readonly hash?: string | undefined;
    readonly idempotency?: NonNullable<StateDump['idempotency']> | undefined;
  };

/**
 * One row a transaction changed: how, and which non-engine fields it wrote (every field for a
 * created or deleted row, the fields whose value changed for an updated one).
 */
export type JournalRow = {
  readonly entity: string;
  readonly id: string;
  readonly kind: Change['kind'];
  readonly fields: readonly string[];
};
/** One committed call or job firing that changed rows, and the rows it changed (id order per entity). */
export type JournalEntry = {
  readonly origin: Change['origin'];
  /** The route or action id for a call, the job name for a firing. */
  readonly source: string;
  readonly at: Iso;
  readonly rows: readonly JournalRow[];
};
export type OriginJournal = readonly JournalEntry[];
export type JobFailure = { readonly job: string; readonly at: Iso; readonly message: string };
export type AdvanceResult = { readonly jobsFired: readonly string[]; readonly jobsFailed: readonly JobFailure[] };

/** One live world. Synchronous, so calls are serialized by construction. */
export interface Runtime {
  call(req: ApiRequest): ApiResponse;
  dump(): StateDump;
  /** Back to the seeded state, clock at meta.clock.start, log and journal cleared. */
  reset(): void;
  log(): readonly CallRecord[];
  /**
   * Logs a request the transport answered before it reached the world (malformed JSON, an oversize body, an
   * unsupported method, `/_world` on the world port) as a failed call: routeId null, no writes, state unchanged,
   * no tick consumed. It holds no headers and no body, so the entry depends only on the method, the path, the
   * answer and engine time.
   */
  refuse(method: string, path: string, res: ApiResponse): void;
  /** Who changed which rows since the last reset: calls and job firings, in commit order. */
  journal(): OriginJournal;
  /** Moves engine time and fires due jobs in (time, name) order, each in its own transaction. */
  advance(by: Duration): AdvanceResult;
  /**
   * The task's score for the current state against the start state, with the calls since the last
   * reset as ctx.trace(). Throws an Error naming the issue when grading fails.
   */
  grade(taskId: string): number;
  /** Canonical hash of the current tables and counters; equals `TaskVerdict.endStateHash` for the same end state. */
  stateHash(): string;
}

/** A refused request. Carries any HTTP status, unlike the store's EnforceError. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: ErrorExtra = {},
  ) {
    super(message);
  }
}

/** Optional template fields an error can set: `$type` and `$param`. */
type ErrorExtra = { readonly type?: string | undefined; readonly param?: string | undefined };

/**
 * An engine-minted refusal. The status comes from RUNTIME_ERROR_CODES, one source with
 * x-error-codes, and the parameter type closes the code against that catalog, like issue().
 * Open codes still go through `new ApiError`: a handler's ctx.fail, and the store's
 * EnforceError surfaced by write() and runAction().
 */
function refusal<C extends RuntimeErrorCode>(code: C, message: string, extra: ErrorExtra = {}): ApiError {
  return new ApiError(RUNTIME_ERROR_CODES[code].status, code, message, extra);
}

/**
 * The first path segment serve keeps for the admin routes. On the world port every path under it
 * is 404 before routing, so check refuses a route or action there (route.reserved_path).
 */
export const ADMIN_PREFIX = '_world';
/** The one-segment path serve answers on the world port with openApiOf(world). check refuses it too. */
export const OPENAPI_PATH = 'openapi.json';

/** A route or action as the router sees it. Routes come first, in declaration order. */
type Endpoint = { readonly id: string; readonly route: Route | null; readonly method: HttpMethod; readonly segments: readonly string[] };

const PARAM_RE = /^\{([^{}]+)\}$/;
const splitSegments = (path: string): string[] => path.split('/').filter((s) => s !== '');

function endpointsOf(world: CheckedWorld): Endpoint[] {
  return [
    ...Object.entries(world.routes).map(([id, r]) => ({ id, route: r, method: r.method, segments: splitSegments(r.path) })),
    ...Object.entries(world.actions).map(([id, a]) => ({ id, route: null, method: a.method, segments: splitSegments(a.path) })),
  ];
}

/** Path params when `segments` matches the request, with the count of literal segments as the score. */
function matchPath(e: Endpoint, reqSegments: readonly string[]): { params: Map<string, string>; score: number } | null {
  if (e.segments.length !== reqSegments.length) return null;
  const params = new Map<string, string>();
  let score = 0;
  for (let i = 0; i < e.segments.length; i++) {
    const pat = e.segments[i]!;
    const got = reqSegments[i]!;
    const param = PARAM_RE.exec(pat);
    if (param) params.set(param[1]!, got);
    else if (pat === got) score += 1;
    else return null;
  }
  return { params, score };
}

function decodePart(raw: string, plusIsSpace: boolean): string | null {
  try {
    return decodeURIComponent(plusIsSpace ? raw.replace(/\+/g, ' ') : raw);
  } catch {
    return null;
  }
}

/** Path segments, plus the query: a query string inside `path` merged under `req.query`, which wins. */
function parseTarget(req: ApiRequest): { segments: string[]; query: Map<string, string> } {
  const at = req.path.indexOf('?');
  const pathPart = at < 0 ? req.path : req.path.slice(0, at);
  const segments: string[] = [];
  for (const raw of splitSegments(pathPart)) {
    const s = decodePart(raw, false);
    if (s === null) throw refusal('path.invalid', `Path ${pathPart} is not valid percent-encoding`);
    segments.push(s);
  }
  const query = new Map<string, string>();
  if (at >= 0) {
    for (const pair of req.path.slice(at + 1).split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const k = decodePart(eq < 0 ? pair : pair.slice(0, eq), true);
      const v = decodePart(eq < 0 ? '' : pair.slice(eq + 1), true);
      if (k === null || v === null) throw refusal('query.invalid', `Query string ${req.path.slice(at + 1)} is not valid percent-encoding`);
      query.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(req.query)) query.set(k, v);
  return { segments, query };
}

/** The query a call is routed with (see parseTarget), or null when its path is not valid percent-encoding. */
export function queryOf(req: ApiRequest): ReadonlyMap<string, string> | null {
  try {
    return parseTarget(req).query;
  } catch {
    return null;
  }
}

/**
 * The world's error body: `$status`, `$code` and `$message` substituted. A string that is exactly
 * "$status" becomes the number. http.ts answers requests that never reach handle() with it too.
 */
export function errorBody(world: CheckedWorld, status: number, code: string, message: string, extra: ErrorExtra = {}): unknown {
  const vars: Record<'status' | 'code' | 'message' | 'type' | 'param', string> = {
    status: String(status), code, message, type: extra.type ?? '', param: extra.param ?? '',
  };
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v === '$status') return status;
      if (v === '$type') return extra.type ?? null;
      if (v === '$param') return extra.param ?? null;
      return v.replace(/\$(status|code|message|type|param)/g, (_m, k: keyof typeof vars) => vars[k]);
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(world.meta.api.error);
}

/** How one column filters and orders: a declared field through FIELD_TYPES, or an engine field. */
type Column = {
  parse(raw: string): { ok: true; value: Value } | { ok: false; expected: string };
  compare(a: Value, b: Value): number;
  /** A nullable field, so a filter value of `null` selects the rows where it is null (A-190). */
  readonly nullable: boolean;
};

/** Id order, the same as the store's: shorter numeric suffix first, then code units. */
const cmpId = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

function kindColumn(def: Field): Column {
  const kind = kindOf(def);
  return { parse: (raw) => kind.parseQuery(raw, def), compare: (a, b) => kind.compare(a, b, def), nullable: def.nullable === true };
}

const ENGINE_TIME_DEF = FIELD_TYPES.datetime.schema.parse({ type: 'datetime' });
// check rejects a declared created_at (field.reserved_name) and the store stamps it on every create, so stripe order needs no columnOf.
const CREATED_AT: Column = kindColumn(ENGINE_TIME_DEF);
const ID_COLUMN: Column = {
  parse: (raw) => (raw === '' ? { ok: false, expected: 'a non-empty id string' } : { ok: true, value: raw }),
  compare: (a, b) => cmpId(String(a), String(b)),
  nullable: false,
};

function columnOf(world: CheckedWorld, entity: string, name: string): Column | null {
  const e = Object.hasOwn(world.entities, entity) ? world.entities[entity] : undefined;
  if (e && Object.hasOwn(e.fields, name)) return kindColumn(e.fields[name]!);
  if (name === 'id') return ID_COLUMN;
  if (name === 'created_at' || name === 'updated_at') return kindColumn(ENGINE_TIME_DEF);
  return null;
}

const show = (raw: string): string => JSON.stringify(raw);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Refuses every query key outside `allowed`, listing them in order. */
function requireKnownQuery(query: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const k of query.keys()) {
    if (!allowed.includes(k)) {
      throw refusal('query.unknown', `Unknown query parameter ${show(k)}. Allowed: ${allowed.length ? allowed.join(', ') : 'none'}`);
    }
  }
}

const FORM_TYPE = 'application/x-www-form-urlencoded';

function isForm(headers: ApiRequest['headers']): boolean {
  return (headers?.['content-type'] ?? '').toLowerCase().startsWith(FORM_TYPE);
}

/** A form body carries strings only, so each declared field is parsed as its query value would be; '' clears it, as on Stripe. */
function fromForm(body: unknown, defs: Readonly<Record<string, Field>>): unknown {
  if (!isPlainObject(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    const def = Object.hasOwn(defs, key) ? defs[key] : undefined;
    if (def === undefined || typeof raw !== 'string') out[key] = raw;
    else if (raw === '') out[key] = null;
    else {
      const parsed = FIELD_TYPES[def.type].parseQuery(raw, def as never);
      out[key] = parsed.ok ? parsed.value : raw;
    }
  }
  return out;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) throw refusal('body.invalid', 'Request body must be a JSON object');
  return body;
}

function tableOf(world: CheckedWorld, state: State, entity: string): ReadonlyMap<string, Row> {
  const t = Object.hasOwn(world.entities, entity) ? state.tables[entity] : undefined;
  if (!t) throw refusal('entity.unknown', `No entity ${entity}`);
  return t;
}

/** Runs one write transaction in mode api. A refused write becomes an ApiError and no state. */
function write<T>(world: CheckedWorld, state: State, fn: Parameters<typeof transact<T>>[2]): { state: State; value: T } {
  const r = transact(world, state, fn);
  if (!r.ok) throw new ApiError(r.error.status, r.error.code, r.error.message);
  return { state: r.state, value: r.value };
}

// ---- cursors: base64url of encodeURIComponent(JSON), pure ES so engine core needs no Buffer.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(ascii: string): string {
  let out = '';
  for (let i = 0; i < ascii.length; i += 3) {
    const n = (ascii.charCodeAt(i) << 16) | ((ascii.charCodeAt(i + 1) || 0) << 8) | (ascii.charCodeAt(i + 2) || 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    if (i + 1 < ascii.length) out += B64.charAt((n >> 6) & 63);
    if (i + 2 < ascii.length) out += B64.charAt(n & 63);
  }
  return out;
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  let out = '';
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j++) n = (n << 6) | (j < chunk.length ? B64.indexOf(chunk.charAt(j)) : 0);
    out += String.fromCharCode((n >> 16) & 255);
    if (chunk.length > 2) out += String.fromCharCode((n >> 8) & 255);
    if (chunk.length > 3) out += String.fromCharCode(n & 255);
  }
  return out;
}

/** Position after one row under one sort. `s` is the sort param it was issued for ("" for id order). */
type Cursor = { readonly s: string; readonly v: Value; readonly i: string };

function encodeCursor(c: Cursor): string {
  return toBase64Url(encodeURIComponent(JSON.stringify([c.s, c.v, c.i])));
}

function decodeCursor(raw: string): Cursor | null {
  const ascii = fromBase64Url(raw);
  if (ascii === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(ascii));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [s, v, i] = parsed as unknown[];
  const isValue = v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (typeof s !== 'string' || typeof i !== 'string' || !isValue) return null;
  return { s, v, i };
}

// ---- standard operations

type OpInput = {
  readonly world: CheckedWorld;
  readonly state: State;
  readonly params: ReadonlyMap<string, string>;
  readonly query: ReadonlyMap<string, string>;
  readonly body: unknown;
};
type OpResult = { readonly state: State; readonly res: ApiResponse };
type RouteOf<K extends Route['op']> = Extract<Route, { op: K }>;
type OpTable = { readonly [K in Route['op']]: (route: RouteOf<K>, input: OpInput) => OpResult };

/** The row-id param of a get, update or delete path: `{id}`, else the last param. Null for list and create. */
function rowIdParam(op: Route['op'], params: readonly string[]): string | null {
  if (op !== 'get' && op !== 'update' && op !== 'delete') return null;
  return params.includes('id') ? 'id' : (params.at(-1) ?? null);
}

const paramNames = (path: string): string[] => splitSegments(path).flatMap((s) => {
  const m = PARAM_RE.exec(s);
  return m ? [m[1]!] : [];
});

/**
 * Route compilation, for check's references layer: every path param other than the row id
 * names a ref field of the route's entity (for a nested route, the ref to the parent), so the
 * operation is scoped by it. The engine fields id, created_at and updated_at never scope a list or
 * create, and a create route cannot scope by a readonly field. Routes on an unknown entity are left to the entity check.
 */
export function routeParamIssues(world: World): CheckIssue[] {
  const out: CheckIssue[] = [];
  for (const [rn, route] of Object.entries(world.routes)) {
    if (!Object.hasOwn(world.entities, route.entity)) continue;
    const params = paramNames(route.path);
    const idParam = rowIdParam(route.op, params);
    const fields = Object.entries(world.entities[route.entity]!.fields);
    const known = fields.filter(([, f]) => refOf(f) !== undefined && (route.op !== 'create' || !f.readonly)).map(([n]) => n);
    for (const p of params) {
      if (p === idParam || known.includes(p)) continue;
      out.push(issue('route.param_not_column', ['routes', rn, 'path'], { param: p, entity: route.entity, known }, show(`{${p}}`)));
    }
  }
  return out;
}

type Condition = { readonly name: string; readonly column: Column; readonly value: Value };

/**
 * Path params other than `skip` as equality conditions on the route's entity. A param whose
 * value cannot be in that column, or a ref param whose target row does not exist, is 404:
 * the parent the path names is not there.
 */
function scopeOf(world: CheckedWorld, state: State, entity: string, params: ReadonlyMap<string, string>, skip: string | null): Condition[] {
  const out: Condition[] = [];
  for (const [name, raw] of params) {
    if (name === skip) continue;
    const column = columnOf(world, entity, name);
    if (column === null) throw refusal('row.not_found', `Path param ${name} names no ${entity} field`);
    const c = column.parse(raw);
    if (!c.ok) throw refusal('row.not_found', `No ${entity} with ${name} ${show(raw)}`);
    const fields = world.entities[entity]!.fields;
    const def = Object.hasOwn(fields, name) ? fields[name] : undefined;
    const target = def === undefined ? undefined : refOf(def);
    if (target !== undefined && !tableOf(world, state, target.entity).has(String(c.value))) {
      throw refusal('row.not_found', `No ${target.entity} ${String(c.value)}`);
    }
    out.push({ name, column, value: c.value });
  }
  return out;
}

const inScope = (r: Row, scope: readonly Condition[]): boolean => scope.every((w) => w.column.compare(r[w.name] ?? null, w.value) === 0);

/** The row a get, update or delete addresses, which must also match every other path param. 404 otherwise. */
function scopedRow(world: CheckedWorld, state: State, route: Route, params: ReadonlyMap<string, string>): Row {
  const idName = rowIdParam(route.op, [...params.keys()]);
  const scope = scopeOf(world, state, route.entity, params, idName);
  const id = idName === null ? '' : (params.get(idName) ?? '');
  const row = tableOf(world, state, route.entity).get(id);
  if (!row || !inScope(row, scope)) {
    const under = scope.length > 0 ? ` with ${scope.map((w) => `${w.name} ${String(w.value)}`).join(', ')}` : '';
    throw refusal('row.not_found', `No ${route.entity} ${id}${under}`);
  }
  return row;
}

function listOp(route: RouteOf<'list'>, { world, state, params, query }: OpInput): OpResult {
  const shape = world.meta.api.list;
  const stripe = shape.mode === 'stripe';
  const filters = route.filters.filter((f) => columnOf(world, route.entity, f) !== null);
  const sortable = route.sort.filter((f) => columnOf(world, route.entity, f) !== null);
  requireKnownQuery(query, [
    shape.limitParam,
    ...(stripe ? [shape.startingAfterParam, shape.endingBeforeParam] : [shape.cursorParam]),
    ...(route.search.length > 0 ? ['q'] : []),
    ...(!stripe && sortable.length > 0 ? ['sort'] : []),
    ...filters,
  ]);

  // Equality conditions: declared filters from the query, and path params that name a column.
  const where: Condition[] = scopeOf(world, state, route.entity, params, null);
  const addCondition = (name: string, raw: string): void => {
    const column = columnOf(world, route.entity, name)!;
    if (raw === 'null' && column.nullable) {
      where.push({ name, column, value: null });
      return;
    }
    const parsed = column.parse(raw);
    if (!parsed.ok) throw refusal('query.invalid', `${name} expected ${parsed.expected}, found ${show(raw)}`);
    where.push({ name, column, value: parsed.value });
  };
  for (const f of filters) {
    const raw = query.get(f);
    if (raw !== undefined) addCondition(f, raw);
  }

  let limit = stripe ? Math.min(route.pageSize, STRIPE_MAX_LIMIT) : route.pageSize;
  const rawLimit = query.get(shape.limitParam);
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || (stripe && Number(rawLimit) > STRIPE_MAX_LIMIT)) {
      const expected = stripe ? `a whole number from 1 to ${STRIPE_MAX_LIMIT}` : 'a whole number from 1';
      throw refusal('query.invalid', `${shape.limitParam} expected ${expected}, found ${show(rawLimit)}`);
    }
    limit = stripe ? Number(rawLimit) : Math.min(Number(rawLimit), route.pageSize);
  }

  const sortParam = stripe ? '' : (query.get('sort') ?? '');
  let order = (left: Row, right: Row): number => cmpId(left.id, right.id);
  let sortKey: (row: Row) => Value = () => null;
  if (stripe) {
    order = (left, right) => -CREATED_AT.compare(left['created_at'] ?? null, right['created_at'] ?? null) || -cmpId(left.id, right.id);
  } else if (sortParam !== '') {
    const desc = sortParam.startsWith('-');
    const field = desc ? sortParam.slice(1) : sortParam;
    if (!sortable.includes(field)) {
      throw refusal('query.invalid', `sort expected one of ${[...sortable, ...sortable.map((f) => `-${f}`)].join(', ')}, found ${show(sortParam)}`);
    }
    const column = columnOf(world, route.entity, field)!;
    const dir = desc ? -1 : 1;
    sortKey = (row) => row[field] ?? null;
    order = (left, right) => dir * column.compare(sortKey(left), sortKey(right)) || cmpId(left.id, right.id);
  }

  let rows = [...tableOf(world, state, route.entity).values()].filter((row) => where.every((w) => w.column.compare(row[w.name] ?? null, w.value) === 0));
  const q = query.get('q');
  if (q !== undefined && q !== '') {
    const needle = q.toLowerCase();
    rows = rows.filter((row) => route.search.some((field) => {
      const value = row[field];
      return value !== null && value !== undefined && String(value).toLowerCase().includes(needle);
    }));
  }
  rows.sort(order);

  if (stripe) {
    const starting = query.get(shape.startingAfterParam);
    const ending = query.get(shape.endingBeforeParam);
    if (starting !== undefined && ending !== undefined) {
      throw refusal('query.invalid', `${shape.startingAfterParam} and ${shape.endingBeforeParam} cannot be used together`);
    }
    const cursorIndex = (param: string, id: string): number => {
      const at = rows.findIndex((row) => row.id === id);
      if (at < 0) throw refusal('cursor.invalid', `${param} ${show(id)} is not an id in this list`);
      return at;
    };
    if (ending !== undefined) {
      const end = cursorIndex(shape.endingBeforeParam, ending);
      const start = Math.max(0, end - limit);
      const page = rows.slice(start, end);
      return { state, res: { status: OP_SUCCESS_STATUS.list, body: { [shape.dataKey]: page, [shape.hasMoreKey]: start > 0 } } };
    }
    const start = starting === undefined ? 0 : cursorIndex(shape.startingAfterParam, starting) + 1;
    const page = rows.slice(start, start + limit);
    return { state, res: { status: OP_SUCCESS_STATUS.list, body: { [shape.dataKey]: page, [shape.hasMoreKey]: start + page.length < rows.length } } };
  }

  let start = 0;
  const rawCursor = query.get(shape.cursorParam);
  if (rawCursor !== undefined) {
    const cursor = decodeCursor(rawCursor);
    if (cursor === null) throw refusal('cursor.invalid', `${shape.cursorParam} is not a cursor this list returned`);
    if (cursor.s !== sortParam) {
      throw refusal('cursor.invalid', `${shape.cursorParam} was issued for sort ${show(cursor.s || 'id')}, not ${show(sortParam || 'id')}`);
    }
    // A stand-in row at the cursor position, so the list's own order decides what comes after it.
    const at = { id: cursor.i, ...(sortParam === '' ? {} : { [sortParam.replace(/^-/, '')]: cursor.v }) } as unknown as Row;
    start = rows.findIndex((row) => order(row, at) > 0);
    if (start < 0) start = rows.length;
  }
  const page = rows.slice(start, start + limit);
  const last = page.at(-1);
  const next = last !== undefined && start + limit < rows.length ? encodeCursor({ s: sortParam, v: sortKey(last), i: last.id }) : null;
  return { state, res: { status: OP_SUCCESS_STATUS.list, body: { [shape.dataKey]: page, [shape.cursorKey]: next } } };
}

/** The status each standard op answers on success. The plan prompt lists it, so acceptance tests assert these. */
export const OP_SUCCESS_STATUS = { list: 200, get: 200, create: 201, update: 200, delete: 204 } as const satisfies Record<Route['op'], number>;

const OPS: OpTable = {
  list: listOp,
  get(route, { world, state, params, query }) {
    requireKnownQuery(query, []);
    return { state, res: { status: OP_SUCCESS_STATUS.get, body: scopedRow(world, state, route, params) } };
  },
  create(route, { world, state, params, query, body }) {
    requireKnownQuery(query, []);
    // A nested create takes its parent from the path; a body naming another parent is refused.
    const data: Record<string, unknown> = { ...bodyObject(body) };
    for (const w of scopeOf(world, state, route.entity, params, null)) {
      if (data[w.name] !== undefined && data[w.name] !== w.value) {
        throw refusal('body.invalid', `${w.name} expected ${show(String(w.value))} (from the path), found ${JSON.stringify(data[w.name])}`);
      }
      data[w.name] = w.value;
    }
    const r = write(world, state, (tx) => tx.create(route.entity, data, 'api'));
    return { state: r.state, res: { status: OP_SUCCESS_STATUS.create, body: r.value } };
  },
  update(route, { world, state, params, query, body }) {
    requireKnownQuery(query, []);
    const data = bodyObject(body);
    const id = scopedRow(world, state, route, params).id;
    const r = write(world, state, (tx) => tx.update(route.entity, id, data, 'api'));
    return { state: r.state, res: { status: OP_SUCCESS_STATUS.update, body: r.value } };
  },
  delete(route, { world, state, params, query }) {
    requireKnownQuery(query, []);
    const id = scopedRow(world, state, route, params).id;
    const r = write(world, state, (tx) => tx.delete(route.entity, id));
    return { state: r.state, res: { status: OP_SUCCESS_STATUS.delete, body: null } };
  },
};

function dispatch(route: Route, input: OpInput): OpResult {
  // OpTable makes a missing op a compile error. TS cannot correlate route.op with its entry, hence one cast.
  const op = OPS[route.op] as (r: Route, i: OpInput) => OpResult;
  return op(route, input);
}

// ---- actions and jobs

/** A handler's own result with status >= 400: rolled back like any failure, its body returned as is. */
class HandlerRefusal extends Error {
  constructor(readonly res: ApiResponse) {
    super(`handler returned ${res.status}`);
  }
}

/** Compiled snippets per host and world, so a call does not recompile its handler. */
const compiled = new WeakMap<SnippetHost, WeakMap<CheckedWorld, Map<string, unknown>>>();

function compileSnippet<K extends SnippetKind>(world: CheckedWorld, host: SnippetHost, kind: K, source: string, path: IssuePath): Snippet<K> {
  let byWorld = compiled.get(host);
  if (!byWorld) compiled.set(host, (byWorld = new WeakMap()));
  let cache = byWorld.get(world);
  if (!cache) byWorld.set(world, (cache = new Map()));
  const key = path.join('\u0000');
  const hit = cache.get(key);
  if (hit !== undefined) return hit as Snippet<K>;
  const c = host.compile(kind, source, path);
  if (!c.ok) throw new Error(`${c.issue.code}: ${c.issue.hint}`);
  cache.set(key, c.run);
  return c.run;
}

/** A failure's message for an envelope: the snippet's own message for a SnippetFault. */
function faultMessage(err: unknown): string {
  if (err instanceof SnippetFault) return err.issue.hint;
  return err instanceof Error ? err.message : String(err);
}

/** The store's privileged write surface for handlers and jobs. */
function writeDb(tx: Tx): WriteDb {
  return {
    get: (entity, id) => tx.get(entity, id),
    list: (entity, q) => tx.list(entity, q),
    create: (entity, data) => tx.create(entity, data, 'privileged'),
    update: (entity, id, patch) => tx.update(entity, id, patch, 'privileged'),
    delete: (entity, id) => tx.delete(entity, id),
  };
}

const FAIL_STATUSES: readonly number[] = [400, 404, 409, 422] satisfies readonly ErrorStatus[];

/** `body` checked against the action's input fields. Every problem is reported at once, as 400. */
function validateInput(world: CheckedWorld, state: State, actionId: string, action: Action, raw: unknown, nowIso: Iso): Record<string, unknown> {
  const body = bodyObject(raw);
  const fields = action.input;
  const problems: string[] = [];
  const add = (field: string, expected: string, found: string): void => {
    problems.push(`${field} expected ${expected}, found ${found}`);
  };
  const json = (v: unknown): string => {
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      // A body nested deeper than the stack overflows JSON.stringify; the problem is still a 400.
      return Array.isArray(v) ? 'a deeply nested array' : 'a deeply nested value';
    }
  };
  for (const key of Object.keys(body)) {
    if (body[key] !== undefined && !Object.hasOwn(fields, key)) {
      add(key, Object.keys(fields).length > 0 ? `one of ${Object.keys(fields).join(', ')}` : 'no field: this action takes no input', json(body[key]));
    }
  }
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(fields)) {
    let value = Object.hasOwn(body, name) ? body[name] : undefined;
    if (value === undefined) value = initialOf(def, nowIso);
    if (value === undefined) {
      if (def.required) add(name, 'a value (required)', 'missing');
      continue;
    }
    if (value === null) {
      if (def.required || !def.nullable) add(name, 'a non-null value', 'null');
      else out[name] = null;
      continue;
    }
    const c = kindOf(def).validate(value, def);
    const target = refOf(def);
    if (!c.ok) add(name, c.expected, json(value));
    else if (target !== undefined && !tableOf(world, state, target.entity).has(String(c.value))) add(name, `an existing ${target.entity} id`, json(value));
    else out[name] = c.value;
  }
  if (problems.length > 0) throw refusal('input.invalid', `Invalid input for ${actionId}: ${problems.join('; ')}`);
  return out;
}

/** A handler's result: a plain object with an integer HTTP status. */
function handlerResponse(actionId: string, out: unknown): ApiResponse {
  if (isPlainObject(out) && typeof out['status'] === 'number' && Number.isInteger(out['status']) && out['status'] >= 100 && out['status'] <= 599) {
    return { status: out['status'], body: out['body'] ?? null };
  }
  throw new Error(`handler of ${actionId} must return { status, body } with an integer status from 100 to 599`);
}

/** Runs one action in one privileged transaction. Any failure leaves `state` as it was. */
function runAction(world: CheckedWorld, state: State, host: SnippetHost, actionId: string, input: Omit<OpInput, 'world' | 'state'>): OpResult {
  const action = world.actions[actionId]!;
  const nowIso = toIso(state.now);
  const body = validateInput(world, state, actionId, action, input.body, nowIso);
  let run: Snippet<'handler'>;
  try {
    run = compileSnippet(world, host, 'handler', action.handler, ['actions', actionId, 'handler']);
  } catch (err) {
    throw refusal('action.failed', `Action ${actionId} failed: ${faultMessage(err)}`);
  }
  const r = transact(world, state, (tx) => {
    const ctx: HandlerCtx = {
      params: Object.fromEntries(input.params),
      query: Object.fromEntries(input.query),
      body,
      db: writeDb(tx),
      now: () => nowIso,
      time: timeMath,
      fail(status, code, message, extra) {
        if (!FAIL_STATUSES.includes(status)) throw new Error(`ctx.fail status must be one of ${FAIL_STATUSES.join(', ')}, got ${String(status)}`);
        const e: unknown = extra;
        const type = isPlainObject(e) && typeof e['type'] === 'string' ? e['type'] : undefined;
        const param = isPlainObject(e) && typeof e['param'] === 'string' ? e['param'] : undefined;
        throw new ApiError(status, String(code), String(message), { type, param });
      },
    };
    const res = handlerResponse(actionId, run(ctx));
    if (res.status >= 400) throw new HandlerRefusal(res);
    return res;
  });
  if (r.ok) return { state: r.state, res: r.value };
  // transact wraps anything but an EnforceError as tx.aborted with the original as cause.
  const cause = r.error.code === 'tx.aborted' ? r.error.cause : undefined;
  if (cause instanceof ApiError) throw cause;
  if (cause instanceof HandlerRefusal) return { state, res: cause.res };
  if (cause !== undefined) throw refusal('action.failed', `Action ${actionId} failed: ${faultMessage(cause)}`);
  throw new ApiError(r.error.status, r.error.code, r.error.message);
}

/**
 * One request against `state`. `routeId` is the matched route or action id (null when nothing
 * matched). `duration` is the matched action's declared duration, null for a route or no match;
 * handle never moves the clock, the runtime applies it when the call commits.
 */
export function handle(
  world: CheckedWorld,
  state: State,
  req: ApiRequest,
  host: SnippetHost,
): { state: State; res: ApiResponse; routeId: string | null; duration: Duration | null } {
  let routeId: string | null = null;
  let duration: Duration | null = null;
  try {
    const { segments, query } = parseTarget(req);
    const matches = endpointsOf(world)
      .map((e) => ({ e, m: matchPath(e, segments) }))
      .filter((x): x is { e: Endpoint; m: NonNullable<ReturnType<typeof matchPath>> } => x.m !== null);
    const display = `/${segments.join('/')}`;
    if (matches.length === 0) throw refusal('route.not_found', `No route matches ${req.method} ${display}`);
    // The most literal segments win across every method, so a literal path another method declares
    // is never read as a parameter match: DELETE /pet/findByStatus is 405 beside GET /pet/findByStatus.
    const top = Math.max(...matches.map((x) => x.m.score));
    const specific = matches.filter((x) => x.m.score === top);
    const sameMethod = specific.filter((x) => x.e.method === req.method);
    if (sameMethod.length === 0) {
      const allowed = [...new Set(specific.map((x) => x.e.method))];
      throw refusal('method.not_allowed', `${req.method} ${display} is not allowed. Allowed: ${allowed.join(', ')}`);
    }
    // Ties keep declaration order (routes before actions).
    const best = sameMethod.reduce((a, b) => (b.m.score > a.m.score ? b : a));
    routeId = best.e.id;
    if (best.e.route === null) duration = world.actions[best.e.id]!.duration ?? null;
    const defs = best.e.route === null ? world.actions[best.e.id]!.input : world.entities[best.e.route.entity]?.fields ?? {};
    const input = { params: best.m.params, query, body: isForm(req.headers) ? fromForm(req.body, defs) : req.body };
    const out = best.e.route === null
      ? runAction(world, state, host, best.e.id, input)
      : dispatch(best.e.route, { world, state, ...input });
    return { state: out.state, res: out.res, routeId, duration };
  } catch (err) {
    if (err instanceof ApiError) return { state, res: { status: err.status, body: errorBody(world, err.status, err.code, err.message, err.extra) }, routeId, duration };
    if (err instanceof EnforceError) return { state, res: { status: err.status, body: errorBody(world, err.status, err.code, err.message) }, routeId, duration };
    throw err;
  }
}

/**
 * JSON with object keys sorted, so equal bodies in any key order give one string. Iterative, like
 * deepCopy: a body nested 100000 deep must not overflow the stack.
 */
function sortedJson(v: unknown): string {
  const out: string[] = [];
  /** Strings are literal text to emit, anything else is a value still to write. */
  const todo: (string | { readonly v: unknown })[] = [{ v }];
  while (todo.length > 0) {
    const item = todo.pop()!;
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    const x = item.v;
    if (Array.isArray(x)) {
      todo.push(']');
      for (let i = x.length - 1; i >= 0; i--) {
        todo.push({ v: x[i] });
        if (i > 0) todo.push(',');
      }
      todo.push('[');
    } else if (isPlainObject(x)) {
      const keys = Object.keys(x).sort();
      todo.push('}');
      for (let i = keys.length - 1; i >= 0; i--) {
        todo.push({ v: x[keys[i]!] });
        todo.push(`${JSON.stringify(keys[i])}:`);
        if (i > 0) todo.push(',');
      }
      todo.push('{');
    } else {
      out.push(JSON.stringify(x) ?? 'null');
    }
  }
  return out.join('');
}

/** A call commits, and moves the clock and id counters, only when it succeeds. */
const succeeded = (res: ApiResponse): boolean => res.status < 400;

const ENGINE_FIELDS: readonly string[] = ['id', 'created_at', 'updated_at'];
const dataKeys = (r: Row): string[] => Object.keys(r).filter((k) => !ENGINE_FIELDS.includes(k));

/** How `b` differs from `a` (either may be absent), or null when no non-engine field differs. */
function rowDiff(a: Row | undefined, b: Row | undefined): { kind: Change['kind']; fields: string[] } | null {
  if (a === undefined && b === undefined) return null;
  if (a === undefined) return { kind: 'created', fields: dataKeys(b!) };
  if (b === undefined) return { kind: 'deleted', fields: dataKeys(a) };
  const fields = [...new Set([...dataKeys(b), ...dataKeys(a)])].filter((k) => (a[k] ?? null) !== (b[k] ?? null));
  return fields.length === 0 ? null : { kind: 'updated', fields };
}

/**
 * Rows whose object changed between two states, per entity in table order, ids in id order,
 * with the fields each one wrote. An update that only bumps engine fields lists no fields.
 */
function touchedRows(before: State, after: State): JournalEntry['rows'] {
  const out: JournalRow[] = [];
  for (const entity of Object.keys(after.tables)) {
    const a = before.tables[entity];
    const b = after.tables[entity];
    if (a === b) continue; // transact keeps the Map of an untouched entity
    const ids = new Set<string>([...(a?.keys() ?? []), ...(b?.keys() ?? [])]);
    const changed = [...ids].filter((id) => a?.get(id as Row['id']) !== b?.get(id as Row['id']));
    for (const id of changed.sort(cmpId)) {
      const diff = rowDiff(a?.get(id as Row['id']), b?.get(id as Row['id']));
      out.push(Object.freeze({ entity, id, kind: diff?.kind ?? 'updated', fields: Object.freeze(diff?.fields ?? []) }));
    }
  }
  return out;
}

/** A State (Maps) or a StateDump (arrays): both list each entity's rows. */
export type TablesView = { readonly tables: Readonly<Record<string, ReadonlyMap<string, Row> | readonly Row[]>> };

/**
 * Row-level changes from `seed` to `end`, over every entity, without engine fields.
 * `journal` must cover exactly the span from seed to end (a runtime's whole journal when seed
 * is its start state). Each changed field is attributed to the origin of the last journal entry
 * that wrote it, so a row that a call and a job both changed yields one Change per origin (call
 * first), each listing only its own fields. A created row's 'created' Change carries the origin of
 * the entry that created it; fields the other origin wrote afterwards come as an 'updated' Change.
 * A deleted row carries the origin of the entry that deleted it. A field no entry wrote counts as
 * 'call'. Entities in `end` table order (then seed-only ones), rows in id order.
 *
 * With `callWrites`, the rows the run's calls wrote (A-387), a call change counts every field a call wrote, not only
 * the ones it changed for good: a seed row a call edited and then put back appears as an updated call change of the
 * fields written, and a call's updated change also lists fields a call wrote that a job or a later call reverted. A
 * row a call created is judged by its created change alone, and a write that changed no field counts for nothing.
 */
export function changesSince(seed: TablesView, end: TablesView, journal: OriginJournal, callWrites?: readonly JournalRow[]): Change[] {
  // Per row: the last origin to write each field, and the last origin to create or delete the row.
  const writers = new Map<string, Map<string, Change['origin']>>();
  const lifecycle = new Map<string, { created?: Change['origin']; deleted?: Change['origin'] }>();
  for (const e of journal) {
    for (const r of e.rows) {
      const key = `${r.entity}\u0000${r.id}`;
      let w = writers.get(key);
      if (w === undefined) writers.set(key, (w = new Map()));
      for (const f of r.fields) w.set(f, e.origin);
      if (r.kind !== 'updated') lifecycle.set(key, { ...lifecycle.get(key), [r.kind]: e.origin });
    }
  }
  const wrote = new Map<string, { fields: string[]; created: boolean }>();
  for (const r of callWrites ?? []) {
    const key = `${r.entity}\u0000${r.id}`;
    const w = wrote.get(key) ?? { fields: [], created: false };
    if (r.kind === 'created') w.created = true;
    for (const f of r.fields) if (!w.fields.includes(f)) w.fields.push(f);
    wrote.set(key, w);
  }
  /** Fields the run's calls wrote on a row they did not create, beyond `net`. */
  const callFields = (key: string, net: readonly string[]): string[] => {
    const w = wrote.get(key);
    return w === undefined || w.created ? [...net] : [...new Set([...net, ...w.fields])];
  };
  const rowsOf = (t: TablesView, entity: string): Map<string, Row> => {
    const v = Object.hasOwn(t.tables, entity) ? t.tables[entity] : undefined;
    return new Map([...(v === undefined ? [] : Array.isArray(v) ? v : (v as ReadonlyMap<string, Row>).values())].map((r: Row) => [r.id, r]));
  };
  const entities = [...new Set([...Object.keys(end.tables), ...Object.keys(seed.tables)])];
  const out: Change[] = [];
  for (const entity of entities) {
    const before = rowsOf(seed, entity);
    const after = rowsOf(end, entity);
    const ids = [...new Set([...before.keys(), ...after.keys()])].sort(cmpId);
    for (const id of ids) {
      const diff = rowDiff(before.get(id), after.get(id));
      const key = `${entity}\u0000${id}`;
      if (diff === null) {
        const undone = before.has(id) ? callFields(key, []) : [];
        if (undone.length > 0) out.push({ entity, id, kind: 'updated', fields: undone, origin: 'call' });
        continue;
      }
      if (diff.kind === 'deleted') {
        out.push({ entity, id, kind: 'deleted', fields: diff.fields, origin: lifecycle.get(key)?.deleted ?? 'call' });
        continue;
      }
      const w = writers.get(key);
      const by = (origin: Change['origin']): string[] => diff.fields.filter((f) => (w?.get(f) ?? 'call') === origin);
      const creator = diff.kind === 'created' ? (lifecycle.get(key)?.created ?? 'call') : null;
      for (const origin of ['call', 'job'] as const) {
        const fields = origin === 'call' && creator !== 'call' ? callFields(key, by(origin)) : by(origin);
        if (origin === creator) out.push({ entity, id, kind: 'created', fields, origin });
        else if (fields.length > 0) out.push({ entity, id, kind: 'updated', fields, origin });
      }
    }
  }
  return out;
}

/** Fires every job due in (from, to] in (time, name) order, each in its own transaction at its own time. */
function fireJobs(
  world: CheckedWorld,
  host: SnippetHost,
  state: State,
  to: Instant,
  record: (entry: JournalEntry) => void,
): { state: State; fired: string[]; failed: JobFailure[] } {
  const due = dueJobs(world.jobs, fromIso(world.meta.clock.start), state.now, to);
  const fired: string[] = [];
  const failed: JobFailure[] = [];
  let current = state;
  for (const { job, at } of due) {
    fired.push(job);
    const atState: State = { ...current, now: at };
    const nowIso = toIso(at);
    let r: ReturnType<typeof transact<void>>;
    try {
      const run = compileSnippet(world, host, 'job', world.jobs[job]!.run, ['jobs', job, 'run']);
      r = transact(world, atState, (tx) => {
        const ctx: JobCtx = { db: writeDb(tx), now: () => nowIso, time: timeMath };
        run(ctx);
      });
    } catch (err) {
      failed.push({ job, at: nowIso, message: faultMessage(err) });
      current = atState;
      continue;
    }
    if (!r.ok) {
      failed.push({ job, at: nowIso, message: faultMessage(r.error.code === 'tx.aborted' && r.error.cause !== undefined ? r.error.cause : r.error) });
      current = atState;
      continue;
    }
    const rows = touchedRows(atState, r.state);
    if (rows.length > 0) record({ origin: 'job', source: job, at: nowIso, rows });
    current = r.state;
  }
  return { state: { ...current, now: to }, fired, failed };
}

/**
/**
 * The dump of `state`: one table and one counter per world entity, rows copied so the dump is
 * detached from live state. `hash` is stateHash of exactly that view, so stateFromDump rebuilds a
 * state with the same hash and can tell an edited dump from a real one.
 */
export function dumpOf(world: CheckedWorld, state: State): StateDump {
  const entities = Object.keys(world.entities);
  const counters = Object.fromEntries(entities.map((e) => [e, state.counters[e] ?? 0]));
  const idempotency = [...(state.idempotency ?? new Map()).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => ({
      key,
      fingerprint: entry.fingerprint,
      routeId: entry.routeId,
      response: deepCopy(entry.response),
    }));
  const view: State = {
    now: state.now,
    tables: Object.fromEntries(entities.map((e) => [e, state.tables[e] ?? new Map()])),
    counters,
    idempotency: new Map(idempotency.map(({ key, ...entry }) => [key, entry] as const)),
  };
  return {
    world: world.meta.name,
    hash: stateHash(view),
    now: toIso(state.now),
    // Store tables are already in id order; spreading the rows detaches the dump from live state.
    tables: Object.fromEntries(entities.map((e) => [e, [...(state.tables[e]?.values() ?? [])].map((r) => ({ ...r }))])),
    counters,
    ...(idempotency.length === 0 ? {} : { idempotency }),
  };
}

/** A committed call's journal rows as its log entry's writes. */
const writesOf = (rows: JournalEntry['rows']): readonly CallWrite[] =>
  Object.freeze(rows.map((r) => Object.freeze({ entity: r.entity, id: r.id, op: r.kind, fields: r.fields })));

/**
 * A deep copy of JSON-shaped data: arrays and plain objects are copied, anything else is kept.
 * Iterative, so a request body nested deeper than the call stack is copied instead of overflowing it.
 */
function deepCopy(v: unknown): unknown {
  if (!Array.isArray(v) && !isPlainObject(v)) return v;
  const root = Array.isArray(v) ? [] : {};
  const copies = new Map<object, object>([[v, root]]);
  const active = new Set<object>([v]);
  const frame = (from: object, to: object) => ({ from, to, entries: Object.entries(from)[Symbol.iterator]() });
  const todo = [frame(v, root)];
  for (let current = todo.at(-1); current !== undefined; current = todo.at(-1)) {
    const entry = current.entries.next();
    if (entry.done) {
      active.delete(current.from);
      todo.pop();
      continue;
    }
    const [key, value]: [string, unknown] = entry.value;
    let child = value;
    if (Array.isArray(value) || isPlainObject(value)) {
      if (active.has(value)) throw refusal('body.invalid', 'Request bodies cannot contain cycles');
      child = copies.get(value);
      if (child === undefined) {
        const copy = Array.isArray(value) ? [] : {};
        child = copy;
        copies.set(value, copy);
        active.add(value);
        todo.push(frame(value, copy));
      }
    }
    Object.defineProperty(current.to, key, { value: child, enumerable: true, writable: true, configurable: true });
  }
  return root;
}

const copyResponse = (r: ApiResponse): ApiResponse =>
  r.jobsFailed === undefined ? { status: r.status, body: deepCopy(r.body) } : { status: r.status, body: deepCopy(r.body), jobsFailed: r.jobsFailed.map((f) => ({ ...f })) };

/** Freezes `v` and everything reachable from it, and returns it. Iterative, like deepCopy. */
function deepFreeze<T>(v: T): T {
  const todo: unknown[] = [v];
  for (let x = todo.pop(); x !== undefined; x = todo.pop()) {
    if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
      Object.freeze(x);
      for (const child of Object.values(x)) todo.push(child);
    }
  }
  return v;
}

/** Lower-case request header names once at the trusted runtime boundary. */
function normalizedHeaders(headers: ApiRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

/**
 * A live world. It starts from `start` when given (verifyTask passes the seed it already has),
 * else from the seeded state with the clock at meta.clock.start. reset() returns to that start.
 */
export function runtime(world: CheckedWorld, host: SnippetHost, start?: State): Runtime {
  const tick = parseTick(world.meta.clock.tick);
  const seed: State = start ?? { ...initialState(world, host), now: fromIso(world.meta.clock.start) };
  let state = seed;
  let log: CallRecord[] = [];
  let journal: JournalEntry[] = [];
  const record = (entry: JournalEntry): void => {
    journal.push(Object.freeze(entry));
  };

  return {
    call(req) {
      const at = toIso(state.now);
      const pending: JournalEntry[] = [];
      let recorded: ApiRequest = { method: req.method, path: req.path, query: {}, body: null };
      let routeId: string | null = null;
      let res: ApiResponse | undefined;
      let jobsFired: readonly string[] = [];
      let jobsFailed: readonly JobFailure[] = [];
      let writes: readonly CallWrite[] = [];
      let next = state;
      let idempotencyKey: string | undefined;
      let fingerprint: string | undefined;
      let hadPrior = false;
      try {
        // Deep copies, so a caller that reuses or mutates its request cannot rewrite the log.
        const headers = normalizedHeaders(req.headers);
        recorded = {
          method: req.method,
          path: req.path,
          query: { ...req.query },
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          body: deepCopy(req.body),
        };
        if (recorded.method === 'POST' && Object.hasOwn(headers, 'idempotency-key')) {
          idempotencyKey = headers['idempotency-key']!;
          fingerprint = JSON.stringify([recorded.path, sortedJson(recorded.query), sortedJson(recorded.body)]);
          const prior = state.idempotency?.get(idempotencyKey);
          if (prior !== undefined) {
            hadPrior = true;
            routeId = prior.routeId;
            if (prior.fingerprint !== fingerprint) {
              // Thrown, not assigned: call()'s catch renders the refusal in the world's
              // envelope and keeps the call exactly as refused (no writes, no tick, routeId
              // kept from the prior call).
              throw refusal(
                'idempotency_error',
                `Idempotency-Key ${show(idempotencyKey)} was already used with a different request`,
                { type: 'idempotency_error' },
              );
            }
            res = copyResponse(prior.response as ApiResponse);
          }
        }

        if (!hadPrior) {
          const out = handle(
            world,
            state,
            { ...recorded, query: { ...recorded.query }, body: deepCopy(recorded.body) },
            host,
          );
          routeId = out.routeId;
          res = out.res;
          if (succeeded(out.res)) {
            const rows = touchedRows(state, out.state);
            // The tick and an action's duration are engine time passing, so jobs due within them fire
            // after the call commits. With neither, `to` is now and no job fires. It stops at the last
            // instant a Date can hold, so the largest allowed time cannot overflow.
            const elapsed = tick + (out.duration === null ? 0 : parseDuration(out.duration));
            const fired = fireJobs(world, host, out.state, Math.min(state.now + elapsed, MAX_INSTANT) as Instant, (e) => pending.push(e));
            if (rows.length > 0) pending.unshift({ origin: 'call', source: routeId ?? '', at, rows });
            writes = writesOf(rows);
            next = fired.state;
            jobsFired = fired.fired;
            jobsFailed = fired.failed;
            if (jobsFailed.length > 0) res = { ...out.res, jobsFailed };
          }
        }
      } catch (err) {
        // Nothing the call did is kept: state and journal stay as they were.
        pending.length = 0;
        next = state;
        jobsFired = [];
        jobsFailed = [];
        writes = [];
        res = err instanceof ApiError
          ? { status: err.status, body: errorBody(world, err.status, err.code, err.message, err.extra) }
          : { status: 500, body: errorBody(world, 500, 'engine.internal', faultMessage(err)) };
      }

      const finalRes = res ?? {
        status: 500,
        body: errorBody(world, 500, 'engine.internal', 'Runtime call completed without a response'),
      };

      // Bind the key only to the first successful POST result; refusals do not reserve the key.
      // This metadata is immutable engine State and is included in dump/hash evidence for restart-safe replay.
      if (idempotencyKey !== undefined && fingerprint !== undefined && !hadPrior && succeeded(finalRes)) {
        const idempotency = new Map(next.idempotency ?? []);
        idempotency.set(idempotencyKey, deepFreeze({
          fingerprint,
          routeId,
          response: copyResponse(finalRes),
        }));
        next = { ...next, idempotency };
      }

      state = next;
      for (const e of pending) record(e);
      log.push(deepFreeze({ seq: log.length + 1, at, routeId, req: recorded, res: copyResponse(finalRes), writes, jobsFired, jobsFailed }));
      return copyResponse(finalRes);
    },
    dump() {
      return dumpOf(world, state);
    },
    reset() {
      state = seed;
      log = [];
      journal = [];
    },
    log() {
      return [...log];
    },
    refuse(method, path, res) {
      log.push(deepFreeze({ seq: log.length + 1, at: toIso(state.now), routeId: null, req: { method, path, query: {}, body: null }, res: copyResponse(res), writes: [], jobsFired: [], jobsFailed: [] }));
    },
    journal() {
      return [...journal];
    },
    advance(by) {
      // advance('0s') is a no-op: nothing fires and now stays (A-191). Every other duration is at least 1s.
      const ms = parseTick(by);
      if (ms === 0) return { jobsFired: [], jobsFailed: [] };
      const to = state.now + ms;
      if (!(to <= MAX_INSTANT)) throw new RangeError(`advance(${by}) moves engine time past the latest instant, ${toIso(MAX_INSTANT as Instant)}; state and clock are unchanged`);
      const out = fireJobs(world, host, state, to as Instant, record);
      state = out.state;
      return { jobsFired: out.fired, jobsFailed: out.failed };
    },
    grade(taskId) {
      const r = gradeTask(world, seed, state, taskId, host, journal, log);
      if (!r.ok) throw new Error(`${r.issue.code} at ${r.issue.path.join('.')}: ${r.issue.hint}`);
      return r.score;
    },
    stateHash() {
      return stateHash(state);
    },
  };
}
