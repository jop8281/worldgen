/**
 * The node:http adapter. A shell file: it turns HTTP into Runtime calls and Runtime results into
 * JSON. Routing, enforcement, envelopes and time live in api.ts behind Runtime.
 *
 * Invariants:
 * - The world port serves only the world's routes and actions. `/_world/*` there is 404, looking
 *   like any unknown route, so the agent under test cannot inspect, reset, grade or move the
 *   clock (A-31). The admin port serves only `/_world/*` and the operator console page at `GET /`
 *   (ui.ts): a self-contained, fully offline document, so the agent under test never sees it.
 *   GET /openapi.json is the world's OpenAPI document, mirrored on the admin port at
 *   `/_world/openapi`. check refuses world routes at either reserved path (route.reserved_path).
 * - A request that never reaches the world (malformed JSON, an oversize body, an unsupported method,
 *   `/_world` on the world port) is answered here in the world's error envelope and logged through
 *   Runtime.refuse as a failed call, so the agent's failed attempts are visible to the log and to
 *   graders (A-145). Admin-port requests (the console included) and GET /openapi.json are not world
 *   calls and are not logged.
 * - Admin errors use the engine's own `{ error: { code, message } }`, whatever the world's envelope.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ADMIN_PREFIX, errorBody, OPENAPI_PATH, type ApiRequest, type CallRecord, type HttpMethod, type Runtime } from './api.ts';
import type { CheckedWorld } from './check.ts';
// The shell's sha-256 dump digest (YOS-183), owned by index.ts beside the sha-256 content ids.
// The cycle is safe: it is called at request time, never while either module is evaluating.
import { dumpSha256 } from './index.ts';
import { RUNTIME_ERROR_CODES, type RuntimeErrorCode } from './error-codes.ts';
import { openApiOf } from './openapi.ts';
import { consolePage } from './ui.ts';

export type ServeOptions = {
  /** World port, for the agent under test. 0 picks a free port. */
  readonly port: number;
  /** Admin port. Defaults to port + 1, or to a free port when port is 0. */
  readonly adminPort?: number | undefined;
  /** Interface the world port binds. Defaults to 127.0.0.1. */
  readonly host?: string | undefined;
  /** Interface the admin port binds. Defaults to 127.0.0.1 even when `host` is public. */
  readonly adminHost?: string | undefined;
};

export interface WorldServer {
  readonly url: string;
  readonly adminUrl: string;
  readonly port: number;
  readonly adminPort: number;
  /** Stops both ports and drops open connections. Safe to call more than once. */
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const isMethod = (m: string): m is HttpMethod => (METHODS as readonly string[]).includes(m);
/** Largest request body read. A larger one is 413 and never parsed. */
const MAX_BODY_BYTES = 1_048_576;
/** Deepest JSON nesting a body may have, as world input (A-194). Deeper bodies are refused before parse (A-245). */
const MAX_BODY_DEPTH = 64;

/** Whether `text` nests brackets deeper than `max`, counting only outside strings. One pass, no allocation. */
function nestsDeeper(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) {
      if (++depth > max) return true;
    } else if (c === 93 || c === 125) depth--;
  }
  return false;
}

/** An answer: a JSON body (the default), or one pre-encoded HTML document (the console page). */
type Reply =
  | { readonly status: number; readonly body: unknown; readonly type?: undefined }
  | { readonly status: number; readonly body: string; readonly type: 'text/html; charset=utf-8' };

const portProblem = (name: string, p: number): string | null =>
  Number.isInteger(p) && p >= 0 && p <= 65535 ? null : `${name} ${p} is not a port from 0 to 65535`;

/** The two ports to bind. Throws RangeError for a port outside 0..65535. */
function portsOf(opts: ServeOptions): { port: number; adminPort: number } {
  const bad = portProblem('port', opts.port);
  if (bad) throw new RangeError(bad);
  if (opts.adminPort !== undefined) {
    const badAdmin = portProblem('admin port', opts.adminPort);
    if (badAdmin) throw new RangeError(badAdmin);
    return { port: opts.port, adminPort: opts.adminPort };
  }
  const adminPort = opts.port === 0 ? 0 : opts.port + 1;
  const badDefault = portProblem('admin port', adminPort);
  if (badDefault) throw new RangeError(`${badDefault}. Pass adminPort.`);
  return { port: opts.port, adminPort };
}

/** An answer in the world's own error envelope, for a request that never reaches the world. The status comes from the code's catalog row. */
const worldError = (world: CheckedWorld, code: RuntimeErrorCode, message: string): Reply => ({
  status: RUNTIME_ERROR_CODES[code].status,
  body: errorBody(world, RUNTIME_ERROR_CODES[code].status, code, message),
});

/** worldError, also logged as the agent's failed call. */
function refused(world: CheckedWorld, rt: Runtime, method: string, target: string, code: RuntimeErrorCode, message: string): Reply {
  const reply = worldError(world, code, message);
  rt.refuse(method, target, reply);
  return reply;
}

const adminError = (code: RuntimeErrorCode, message: string): Reply => ({ status: RUNTIME_ERROR_CODES[code].status, body: { error: { code, message } } });

/** Path segments of a request target, percent-decoded where possible, without the query. */
function segmentsOf(target: string): string[] {
  const at = target.indexOf('?');
  return (at < 0 ? target : target.slice(0, at)).split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** The client's connection ended before its request could be answered, so nothing may run for it. */
class ConnectionClosed extends Error {}

type Body = { ok: true; value: unknown } | { ok: false; code: 'body.invalid' | 'body.too_large'; message: string };

/** Reads the whole body. Empty is undefined; anything else must be JSON. */
/** Stripe-style form fields: `a=1&meta[k]=v` becomes {"a":"1","meta":{"k":"v"}}. Values stay strings; the API parses them per field. */
function formObject(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const m = /^([^[\]]+)\[([^[\]]*)\]$/.exec(key);
    if (m === null) {
      out[key] = value;
      continue;
    }
    const [, outer, inner] = m as unknown as [string, string, string];
    const nested = out[outer];
    const obj = typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : {};
    obj[inner] = value;
    out[outer] = obj;
  }
  return out;
}

function readBody(req: IncomingMessage, form = false): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('error', reject);
    // Bytes past Content-Length parse as the next request. When they are not one, the parser answers 400 and
    // closes the socket, so the client will never see this request's reply: do not run it. Node closes the
    // socket before 'end' and Bun one turn after it, so the check waits a turn.
    req.on('end', () => setImmediate(() => {
      if (req.socket.destroyed || !req.socket.writable) {
        reject(new ConnectionClosed());
        return;
      }
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, code: 'body.too_large', message: `Request body is ${size} bytes; the most is ${MAX_BODY_BYTES}` });
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({ ok: true, value: undefined });
        return;
      }
      if (form) {
        resolve({ ok: true, value: formObject(text) });
        return;
      }
      if (nestsDeeper(text, MAX_BODY_DEPTH)) {
        resolve({ ok: false, code: 'body.invalid', message: `Request body nests deeper than ${MAX_BODY_DEPTH} levels` });
        return;
      }
      try {
        const value: unknown = JSON.parse(text);
        resolve({ ok: true, value });
      } catch (e) {
        resolve({ ok: false, code: 'body.invalid', message: `Request body is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
      }
    }));
  });
}

function write(res: ServerResponse, reply: Reply): void {
  if (reply.status === 204 || reply.status === 304) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  if (reply.type !== undefined) {
    res.writeHead(reply.status, { 'content-type': reply.type, 'content-length': Buffer.byteLength(reply.body) });
    res.end(reply.body);
    return;
  }
  const text = JSON.stringify(reply.body ?? null);
  res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Node already lower-cases ordinary header names; normalize again and flatten duplicate values. */
function requestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** The world port: everything except /_world goes to Runtime.call. */
async function onWorld(world: CheckedWorld, rt: Runtime, req: IncomingMessage): Promise<Reply> {
  const method = req.method ?? '';
  const target = req.url ?? '/';
  const segments = segmentsOf(target);
  if (segments[0] === ADMIN_PREFIX) return refused(world, rt, method, target, 'route.not_found', `No route matches ${method} /${segments.join('/')}`);
  if (method === 'GET' && segments.length === 1 && segments[0] === OPENAPI_PATH) return { status: 200, body: openApiOf(world) };
  if (!isMethod(method)) return refused(world, rt, method, target, 'method.not_allowed', `${method} is not supported. Use one of ${METHODS.join(', ')}`);
  // Stripe clients send form bodies, so a Stripe-shaped world reads them; every other world reads JSON only.
  const form = world.meta.api.list.mode === 'stripe' && (req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded');
  const body = await readBody(req, form);
  if (!body.ok) return refused(world, rt, method, target, body.code, body.message);
  const call: ApiRequest = { method, path: target, query: {}, headers: requestHeaders(req), body: body.value };
  return rt.call(call);
}

/** A logged call whose body JSON cannot encode (nested deeper than the stack) is listed with its body replaced, so the log stays readable. */
function serializable(record: CallRecord): CallRecord {
  try {
    JSON.stringify(record);
    return record;
  } catch {
    return { ...record, req: { ...record.req, body: { note: 'request body too deeply nested to log' } }, res: { ...record.res, body: null } };
  }
}

type AdminRoute = { readonly method: HttpMethod; readonly param: boolean; run(rt: Runtime, world: CheckedWorld, body: unknown, param: string): Reply };

const ADMIN_ROUTES: Readonly<Record<string, AdminRoute>> = {
  state: {
    method: 'GET',
    param: false,
    run: (rt) => {
      const dump = rt.dump();
      // The response is the dump plus the shell's sha-256 digest of it (YOS-183). The core's
      // `hash` field inside the dump is unchanged; only the route's response carries the digest.
      return { status: 200, body: { ...dump, sha256: dumpSha256(dump) } };
    },
  },
  reset: {
    method: 'POST',
    param: false,
    run: (rt) => {
      rt.reset();
      return { status: 200, body: { ok: true, now: rt.dump().now } };
    },
  },
  log: { method: 'GET', param: false, run: (rt) => ({ status: 200, body: { calls: rt.log().map(serializable) } }) },
  openapi: { method: 'GET', param: false, run: (_rt, world) => ({ status: 200, body: openApiOf(world) }) },
  clock: {
    method: 'POST',
    param: false,
    run: (rt, _world, body) => {
      const advance = body !== null && typeof body === 'object' && !Array.isArray(body) && 'advance' in body ? body.advance : undefined;
      if (typeof advance !== 'string') return adminError('clock.invalid', 'Body must be {"advance": "<duration>"}, such as {"advance":"4h"}');
      try {
        const r = rt.advance(advance);
        return { status: 200, body: { now: rt.dump().now, jobsFired: r.jobsFired, jobsFailed: r.jobsFailed } };
      } catch (e) {
        if (e instanceof RangeError) return adminError('clock.invalid', e.message);
        throw e;
      }
    },
  },
  grade: {
    method: 'POST',
    param: true,
    run: (rt, world, _body, task) => {
      if (!Object.hasOwn(world.tasks, task)) {
        return adminError('task.unknown', `No task ${task}. Known tasks: ${Object.keys(world.tasks).join(', ') || 'none'}`);
      }
      try {
        return { status: 200, body: { task, score: rt.grade(task), state: rt.stateHash() } };
      } catch (e) {
        return adminError('grade.failed', e instanceof Error ? e.message : String(e));
      }
    },
  },
};

const ADMIN_LIST = Object.entries(ADMIN_ROUTES).map(([name, r]) => `${r.method} /${ADMIN_PREFIX}/${name}${r.param ? '/<task>' : ''}`).join(', ');

/** The admin port: the operator console at `/`, and only /_world/<route> otherwise. */
async function onAdmin(world: CheckedWorld, rt: Runtime, req: IncomingMessage, consoleHtml: string): Promise<Reply> {
  const method = req.method ?? '';
  const segments = segmentsOf(req.url ?? '/');
  if (segments.length === 0 && method === 'GET') return { status: 200, body: consoleHtml, type: 'text/html; charset=utf-8' };
  const [prefix, name, ...rest] = segments;
  const route = name !== undefined && Object.hasOwn(ADMIN_ROUTES, name) ? ADMIN_ROUTES[name] : undefined;
  if (prefix !== ADMIN_PREFIX || route === undefined || rest.length !== (route.param ? 1 : 0)) {
    return adminError('route.not_found', `No admin route ${method} /${segments.join('/')}. Admin routes: ${ADMIN_LIST}`);
  }
  if (method !== route.method) return adminError('method.not_allowed', `${method} /${segments.join('/')} is not allowed. Allowed: ${route.method}`);
  const body = await readBody(req);
  if (!body.ok) return adminError(body.code, body.message);
  return route.run(rt, world, body.value, rest[0] ?? '');
}

type Handler = (world: CheckedWorld, rt: Runtime, req: IncomingMessage) => Promise<Reply>;

/** A request listener that always answers, with 500 when the handler itself fails, and never rejects. */
function listener(world: CheckedWorld, rt: Runtime, handler: Handler, onFail: (message: string) => Reply) {
  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let reply: Reply;
    try {
      reply = await handler(world, rt, req);
    } catch (e) {
      if (e instanceof ConnectionClosed) {
        res.destroy();
        return;
      }
      reply = onFail(`Engine error: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      write(res, reply);
    } catch {
      res.destroy();
    }
  };
  return (req: IncomingMessage, res: ServerResponse): void => {
    void answer(req, res);
  };
}

function start(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const a = server.address();
      resolve(a !== null && typeof a === 'object' ? a.port : port);
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

const urlOf = (host: string, port: number): string => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

/**
 * Serves `rt` over HTTP: the world's API on `port`, the /_world admin routes and the operator
 * console page on `adminPort`. Rejects with the listen error (such as EADDRINUSE) and leaves
 * nothing listening.
 */
export async function listen(world: CheckedWorld, rt: Runtime, opts: ServeOptions): Promise<WorldServer> {
  const { port, adminPort } = portsOf(opts);
  const host = opts.host ?? DEFAULT_HOST;
  const adminHost = opts.adminHost ?? DEFAULT_HOST;
  const worldServer = createServer(listener(world, rt, onWorld, (m) => worldError(world, 'engine.error', m)));
  const boundPort = await start(worldServer, port, host);
  // The console displays the world port, so it is built once that port is bound.
  const consoleHtml = consolePage(world.meta.name, boundPort);
  const adminServer = createServer(
    listener(world, rt, (w, r, req) => onAdmin(w, r, req, consoleHtml), (m) => adminError('engine.error', m)),
  );
  let boundAdmin: number;
  try {
    boundAdmin = await start(adminServer, adminPort, adminHost);
  } catch (e) {
    await stop(worldServer);
    throw e;
  }
  let closing: Promise<void> | undefined;
  return {
    url: urlOf(host, boundPort),
    adminUrl: urlOf(adminHost, boundAdmin),
    port: boundPort,
    adminPort: boundAdmin,
    close() {
      closing ??= Promise.all([stop(worldServer), stop(adminServer)]).then(() => undefined);
      return closing;
    },
  };
}
