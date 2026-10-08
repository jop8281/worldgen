/**
 * The studio server: one loopback port for the operator — the worlds table, world rollout
 * (child `worldplay serve` processes), generation runs (child `worldgen` processes), the eval
 * runs, the spend ledger, and the Agent Playground (child `episode` processes and the engine's
 * `worldplay verify` proof). The page is page.ts; this file only routes and spawns.
 *
 * Invariants:
 * - Loopback by default (127.0.0.1). This is the studio's own port, not a world port: no
 *   `/_world` route exists here. The page is offline and every fetch it makes is same-origin and
 *   relative. The one way through to a world is the API console route (A-268): it forwards one
 *   request to the world port of a service this studio started, never to its admin port, and
 *   answers the world's real status and body, or the real failure. The one exception is reset
 *   (A-357): after the caller types the world's name, the studio itself sends that service's admin
 *   port POST /_world/reset and GET /_world/state, and answers only the time and the state hash.
 * - Children only. The studio never imports llm.ts and never makes a model call: generation and
 *   serving are spawned CLIs through an injected `Spawner`, and `costs` runs through an injected
 *   `Runner`. Generation and episodes get the operator's environment, so it carries every key, minus the
 *   studio's own sign-in token; a child that runs a world's snippets (check, proof, serve) gets only an
 *   allowlist (A-338, A-343). The studio stores and logs no key.
 * - No private task material. The worlds route counts tasks, it never returns task source. The
 *   report route serves REPORT.md and capsule.json, and the plan route plan.yaml's assumptions and plan.md, and each
 *   refuses an answer that embeds any grader, solution or decoy source. test/studio.test.ts and
 *   test/studio-builder.test.ts prove it with canaries.
 * - Uploads (YOS-188). An OpenAPI spec or CSV table an operator uploads is stored in its tenant's own
 *   <shelf root>/.uploads (uploads.ts), and an upload id resolves only there, so no tenant reads or generates from
 *   another's. Every walker of the worlds dir skips dot dirs, so .uploads is never a world, a run source or a shelf.
 * - Sign-in (YOS-187). With users configured, every route but GET / and GET /api/health needs a bearer token whose
 *   sha256 matches a user; GETs need the viewer role, POSTs the operator role, GET /api/audit the admin role. The
 *   credential is a bearer header, never a cookie: a cookie ignores ports and would reach every served world on the
 *   host, whose call log records request headers. With no users the studio is open and must stay on loopback. Every
 *   POST is appended to <worldsDir>/.studio-audit.jsonl: who, what and the status, never a token or a body.
 * - Tenancy (YOS-187, A-344). Every user has a tenant; the WORLDGEN_STUDIO_TOKEN admin and open mode are `default`. Jobs,
 *   episodes, services and audit lines record the caller's tenant. A viewer or operator sees and acts on its own
 *   tenant's records only, an admin on every tenant's, narrowed by `?tenant=`. A foreign record answers exactly like an
 *   unknown one, and an idempotency key is looked up within the caller's tenant, so no answer tells a tenant that
 *   another's record or key exists. The world library, the top-level dirs of worldsDir, is shared and read-only. A
 *   generation writes into its tenant's dir, <worldsDir>/<tenant>/gen-<slug>, and `default` keeps the old layout,
 *   <worldsDir>/gen-<slug>. Every `:name` route resolves its world through worldDirOf.
 * - The studio answers only to its own names. Every request's Host must be the bound address, a loopback name when
 *   bound to loopback or a wildcard, or the configured `origin`; a POST that carries an Origin needs one of the same.
 *   Open mode makes every request the local admin, so without this any page the operator visits could POST
 *   /api/generate (cross-site), and a DNS-rebinding page would reach the studio as same-origin. A request with no
 *   Origin (curl, scripts) passes the Origin check.
 * - A job runs once (A-335). A generation or an episode is recorded as an intent, with its key and a lease to this
 *   studio, before its child is spawned, and with its pid after. The key is the Idempotency-Key header, else `derived:`
 *   the request's sha256, which matches only an unfinished job; a client key reused for another request is 422. The
 *   holder renews its lease every leaseMs / 3, and stops renewing when the file names another holder. A job whose
 *   lease ran out is resumed when its process lives and stopped when it does not. An intent is stopped, never started,
 *   because its child may have started before the crash. So a retried POST, a double click or a crash never starts a
 *   second paid run.
 * - Web hardening (YOS-234). Every answer carries SECURITY_HEADERS (frame, sniffing, referrer and a CSP the offline page
 *   meets). Each POST route has one token bucket per client address and tenant, and a failed bearer draws from one bucket per
 *   client that slows token guessing; both read the injected clock. Unfinished runs and episodes are capped, counted
 *   after the idempotency lookup so a replay never gets 429. CSRF is the own-names guard's job (#12), not a check here.
 * - Stops never leave zombies: SIGTERM, a short wait, SIGKILL, and the answer says which signal
 *   ended the child. A child that dies on its own removes its own record.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { Dirent } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { assertNever } from '#lib/never';
import { loadWorld } from '#engine';
import { CAPSULE_FILE, capsuleSchema, type RunCapsule } from '../worldgen/capsule.ts';
import { parsePlanYaml } from '../worldgen/plan.ts';
import { renderPlanMd } from '../worldgen/plan-md.ts';
import { isolatedEnv, listeningPorts, type RunResult, type Runner, type SpawnedChild, type Spawner } from '../sandboxes/backend.ts';
import { parseEpisode, type Episode } from '../dataset/schema.ts';
import { summarizeEpisodes } from './analytics.ts';
import { adoptedChild, DEFAULT_TENANT, loadRuns, osProcesses, recoveryOf, RUN_STORE_FILE, saveRuns, type JobKind, type Lease, type Processes, type Recovery, type StoredRun } from './runstore.ts';
import { studioPage } from './page.ts';
import { MAX_UPLOAD_BYTES, MAX_UPLOADS, openapiPaths, parseUpload, uploadFileOf, uploadIdOf, uploadPartsOf, UPLOADS_DIR, type Upload, type UploadKind } from './uploads.ts';
import { trafficCounter } from './watch.ts';

/** Ordered: each role can do everything the roles before it can. */
export const STUDIO_ROLES = ['viewer', 'operator', 'admin'] as const;
export type StudioRole = (typeof STUDIO_ROLES)[number];
/** One signed-in person and the tenant whose records they see. Holds the sha256 hex of their token, never the token. */
export type StudioUser = { readonly name: string; readonly role: StudioRole; readonly tenant: string; readonly tokenSha256: string };

/** The audit log of POST requests, in the worlds dir. */
export const AUDIT_FILE = '.studio-audit.jsonl';

/** A tenant name becomes a directory under the worlds dir, so it is one plain lowercase segment, never a `gen-<slug>` dir of the default tenant. */
const TENANT = /^(?!gen-)[a-z0-9][a-z0-9-]{0,62}$/;
const TENANT_RULE = 'tenant must be 1 to 63 lowercase letters, digits or dashes, starting with a letter or digit and not with gen-, which names the default tenant\'s generated worlds';

const usersFileSchema = z.strictObject({
  users: z.array(z.strictObject({
    name: z.string().min(1),
    role: z.enum(STUDIO_ROLES),
    tenant: z.string().regex(TENANT, TENANT_RULE).refine((t) => t !== DEFAULT_TENANT, 'tenant default is the library\'s own (open mode and the WORLDGEN_STUDIO_TOKEN admin); give each team a tenant of its own'),
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'token_sha256 must be 64 lowercase hex characters'),
  })).min(1, 'list at least one user: an empty list would turn sign-in off'),
});

/** `value` as an http(s) origin with no path, query or fragment, such as http://127.0.0.1:8787; null when it is not one. */
export function originOf(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && `${url.origin}/` === url.href ? url.origin : null;
}

/** The users of a `--users` file's text. Throws an Error naming the problem. */
export function parseUsersFile(text: string): StudioUser[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = usersFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; '));
  }
  return parsed.data.users.map((u) => ({ name: u.name, role: u.role, tenant: u.tenant, tokenSha256: u.token_sha256 }));
}

export type StudioOptions = {
  /** The studio port. 0 picks a free port. */
  readonly port: number;
  /** Interface to bind. Defaults to 127.0.0.1, the operator's loopback. */
  readonly host?: string | undefined;
  /** The repository root: code/, prod/worlds/, eval/inputs/ and eval/runs/ are found from it. */
  readonly repoRoot: string;
  /** Where the worlds live. Defaults to <repoRoot>/prod/worlds. */
  readonly worldsDir?: string | undefined;
  /** Starts long-running children (`worldplay serve`, `worldgen`). Injected so tests run no child. */
  readonly spawner: Spawner;
  /** Runs one command to completion (`costs --json`). Injected so tests run no child. */
  readonly runner: Runner;
  /** The source sha this server was built from, reported by /api/health. Unknown when absent. */
  readonly build?: string | undefined;
  /** How long Serve waits for the world child to report its listening ports before it stops the child. Default 10 s. */
  readonly serveWaitMs?: number | undefined;
  /** How long a stopped generation run gets after SIGINT before SIGTERM. Default 30 s. */
  readonly runStopWaitMs?: number | undefined;
  /** The model transport every worldgen it starts uses (`--transport`); the CLI default when absent. A container has no claude CLI, so it uses sdk (A-326). */
  readonly transport?: 'claude-cli' | 'sdk' | undefined;
  /** Looks at and signals runs a previous studio started. Defaults to the OS (process.kill). */
  readonly processes?: Processes | undefined;
  /** Who may sign in. Empty or absent is open mode: everyone is the admin `local`, and the host must be loopback. */
  readonly users?: readonly StudioUser[] | undefined;
  /** The one public origin the studio is also reached at, such as http://127.0.0.1:9000 for a published container port or https://studio.example.com behind a proxy. */
  readonly origin?: string | undefined;
  /** The environment the studio's children are built from: check, proof and serve get an allowlist of it, generation and episodes all of it. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** How long an isolated check or proof child may run. Default 300000 (the verifier's CHILD_TIMEOUT_MS). */
  readonly checkTimeoutMs?: number | undefined;
  /** How long a job's lease lasts without renewal. Default 30 s. Injected so tests can expire a lease without waiting. */
  readonly leaseMs?: number | undefined;
  /** The clock leases are read and written by. Default Date.now. Injected so tests can expire a lease without waiting. */
  readonly now?: (() => number) | undefined;
  /** The burst and refill of each client's bucket on each POST route. Default 60 and 1 per second. */
  readonly rateLimit?: RateLimit | undefined;
  /** The burst and refill of each client's failed-sign-in bucket. Default 10 and 1 per 6 s. */
  readonly authThrottle?: RateLimit | undefined;
  /** Most unfinished generation runs at once. Default 4. */
  readonly maxConcurrentRuns?: number | undefined;
  /** Most unfinished agent episodes at once. Default 4. */
  readonly maxConcurrentEpisodes?: number | undefined;
};

export type RateLimit = { readonly capacity: number; readonly refillPerSecond: number };

const DEFAULT_RATE_LIMIT: RateLimit = { capacity: 60, refillPerSecond: 1 };
const DEFAULT_AUTH_THROTTLE: RateLimit = { capacity: 10, refillPerSecond: 1 / 6 };
const DEFAULT_MAX_JOBS = 4;
const MAX_BUCKETS = 1024;

/** Sent on every answer. The page is one offline document with inline script and style and relative fetches only. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
};

export interface StudioServer {
  readonly url: string;
  readonly port: number;
  /**
   * Drops the port and open connections, stops every served world (SIGTERM, then SIGKILL) and every running check, and
   * resolves once each is gone. A generation run or an episode gets SIGTERM, its own clean stop, and finishes billing
   * on its own (A-279).
   */
  close(): Promise<void>;
}

/** What stopOnSignals needs of a process: its two stop signals, its exit and stderr. `process` is one. */
export type SignalHost = {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): void;
  readonly stderr: { write(text: string): unknown };
};

/**
 * Stops the studio on SIGTERM or SIGINT: close() stops every served world and check and waits for them, then the
 * process exits 0 after SIGTERM or 130 after SIGINT, or 1 when close fails. A second signal while closing exits at
 * once, 143 or 130 by that signal, as worldgen does (A-279).
 */
export function stopOnSignals(server: Pick<StudioServer, 'close'>, host: SignalHost): void {
  let closing = false;
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (closing) {
      host.stderr.write(`studio: ${signal} again, exiting before every child is gone\n`);
      host.exit(signal === 'SIGINT' ? 130 : 143);
      return;
    }
    closing = true;
    host.stderr.write(`studio: ${signal}, stopping every served world and check (send it again to quit now)\n`);
    server.close().then(
      () => host.exit(signal === 'SIGINT' ? 130 : 0),
      (e: unknown) => {
        host.stderr.write(`studio: close failed: ${e instanceof Error ? e.message : String(e)}\n`);
        host.exit(1);
      },
    );
  };
  host.on('SIGINT', () => onSignal('SIGINT'));
  host.on('SIGTERM', () => onSignal('SIGTERM'));
}

const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);
/** How many audit lines GET /api/audit answers. */
const AUDIT_TAIL = 200;
const AUTH_CHALLENGE = { 'www-authenticate': 'Bearer realm="studio"' };
/** The suffix of the directory a create run builds in until it is done (worldgen/run.ts partialDir, A-293). */
const PARTIAL_SUFFIX = '.partial';
/** Most CSV tables one generation reads. */
const MAX_CSV_FILES = 8;
/** Largest request body read. A larger one is 413 and never parsed. */
const MAX_BODY_BYTES = 1_048_576;
/** Largest POST /api/uploads body: JSON spells one control character in six bytes, so any content of MAX_UPLOAD_BYTES fits. */
const MAX_UPLOAD_BODY_BYTES = 6 * MAX_UPLOAD_BYTES + 4_096;
/** How long a stop waits after a signal before it escalates, or answers not-stopped. */
const SIGNAL_WAIT_MS = 1_000;
/** How long a generation run gets after SIGINT to cancel its call, bill it and write REPORT.md before SIGTERM (A-279). */
const RUN_STOP_WAIT_MS = 30_000;
/** How long Serve waits for `worldplay serve` to report its listening ports (A-348). */
const SERVE_WAIT_MS = 10_000;
/** How often Serve reads the child's output for that report. */
const SERVE_POLL_MS = 50;
/** How long a job's lease lasts unless its holder renews it (A-335). */
const LEASE_MS = 30_000;
/** How many finished proof replies are kept for a client key's retry. */
const PROOF_REPLIES = 100;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/** How long a /api/costs answer stays fresh. */
const COSTS_CACHE_MS = 30_000;
/** How many events the runs panel reads. */
const EVENT_TAIL = 100;
/** How far into a summary.md the pass-rate line may sit before the list shows a preview instead. */
const SUMMARY_SCAN_LINES = 200;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Methods the API console may send to a world port. */
const CALL_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** How long the API console waits for a world port to answer. */
const CALL_TIMEOUT_MS = 15_000;
/** Largest world answer the API console passes back whole; a larger one is cut and marked. */
const MAX_CALL_BYTES = 1_048_576;
const ROUTE_PARAM = /^:/;

/** An answer: a JSON body (the default), or one pre-encoded HTML document (the page). */
type Reply =
  | { readonly status: number; readonly body: unknown; readonly type?: undefined; readonly headers?: Readonly<Record<string, string>> }
  | { readonly status: number; readonly body: string; readonly type: 'text/html; charset=utf-8' }
  | { readonly status: number; readonly body: Buffer; readonly type: 'application/zip'; readonly filename: string };

const fail = (status: number, code: string, message: string, headers?: Readonly<Record<string, string>>): Reply => ({ status, body: { error: { code, message } }, ...(headers === undefined ? {} : { headers }) });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The Idempotency-Key header as Node hands it over. */
type RawKey = string | readonly string[] | undefined;

/** The client's Idempotency-Key, undefined when it sent none, or the reply that refuses it. */
function idempotencyKeyOf(raw: RawKey): { ok: true; key: string | undefined } | { ok: false; reply: Reply } {
  if (raw === undefined) return { ok: true, key: undefined };
  if (typeof raw === 'string' && IDEMPOTENCY_KEY.test(raw)) return { ok: true, key: raw };
  return { ok: false, reply: fail(400, 'idempotency.key', 'Idempotency-Key must be 1 to 128 letters, digits, dots, underscores, colons or dashes') };
}

/** What makes two requests the same: the sha256 of the kind and the canonical request. */
const fingerprintOf = (kind: string, request: readonly string[]): string => createHash('sha256').update(JSON.stringify([kind, request])).digest('hex');

/** Why recovery stopped a run, as its status says it. */
const STOPPED_REASON: Record<Extract<Recovery, { outcome: 'stopped' }>['reason'], string> = {
  process_gone: 'the studio restarted while this run was running and its process is gone; its evidence stays in the <out>.partial directory',
  start_unconfirmed: 'the studio stopped before it confirmed this run started, so it is never started again: its process may have started, and a paid run must not run twice',
};

/** One directory level of a request target: not empty, no separators, no dot segments. */
const safeSegment = (s: string): boolean => s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0');

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

type Body = { ok: true; value: unknown } | { ok: false; status: 400 | 413; code: string; message: string };

/** Reads the whole body, at most `limit` bytes. Empty is undefined; anything else must be JSON. */
function readBody(req: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => setImmediate(() => {
      if (req.socket.destroyed || !req.socket.writable) {
        reject(new ConnectionClosed());
        return;
      }
      if (size > limit) {
        resolve({ ok: false, status: 413, code: 'body.too_large', message: `Request body is ${size} bytes; the most is ${limit}` });
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({ ok: true, value: undefined });
        return;
      }
      try {
        const value: unknown = JSON.parse(text);
        resolve({ ok: true, value });
      } catch (e) {
        resolve({ ok: false, status: 400, code: 'body.invalid', message: `Request body is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
      }
    }));
  });
}

/** The files a world export carries. Never runs/: its events and dumps are provenance for this machine, not the world (A-280). */
const EXPORT_FILES = ['world.yaml', 'plan.yaml', 'REPORT.md', 'capsule.json'] as const;

/** A zip of stored (uncompressed) entries: one local header per file, then the central directory and its end record. */
function zipOf(entries: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** Who sent a request: no bearer, a bearer that matches no user, or a user. */
type Caller =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'user'; readonly name: string; readonly role: StudioRole; readonly tenant: string };
/** A caller that passed sign-in: the only kind a route that needs a role is handed. */
type User = Extract<Caller, { readonly kind: 'user' }>;

/** Whether `who` sees a record of `tenant`: its own tenant's, or for an admin every tenant's, narrowed by `?tenant=`. */
const visible = (tenant: string, who: User, filter: string | null): boolean => (who.role === 'admin' ? filter === null || tenant === filter : tenant === who.tenant);

const roleRank = (role: StudioRole): number => STUDIO_ROLES.indexOf(role);
const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

function write(res: ServerResponse, reply: Reply): void {
  if (reply.type !== undefined) {
    res.writeHead(reply.status, {
      ...SECURITY_HEADERS,
      'content-type': reply.type,
      'content-length': typeof reply.body === 'string' ? Buffer.byteLength(reply.body) : reply.body.length,
      ...(reply.type === 'application/zip' ? { 'content-disposition': `attachment; filename="${reply.filename}"` } : {}),
    });
    res.end(reply.body);
    return;
  }
  const text = JSON.stringify(reply.body ?? null);
  res.writeHead(reply.status, { ...SECURITY_HEADERS, ...reply.headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True once the child is gone, false when `ms` passed first. */
function exitedWithin(child: SpawnedChild, ms: number): Promise<boolean> {
  return Promise.race([child.exited.then(() => true), sleep(ms).then(() => false)]);
}

/** Sends each signal in order and waits briefly; the first the child dies to wins. */
async function signalAndWait(child: SpawnedChild, signals: readonly NodeJS.Signals[], waitMs = SIGNAL_WAIT_MS): Promise<{ exited: boolean; signal: NodeJS.Signals }> {
  let last: NodeJS.Signals = signals[0] ?? 'SIGTERM';
  for (const signal of signals) {
    last = signal;
    child.kill(signal);
    if (await exitedWithin(child, waitMs)) return { exited: true, signal };
  }
  return { exited: false, signal: last };
}

type Params = Record<string, string>;
/**
 * `key` is the request's Idempotency-Key header, which only the job-starting POSTs read. `filter` is an admin's
 * `?tenant=`, null for everyone else and for an admin who sent none.
 */
type Ctx = { readonly key: RawKey; readonly filter: string | null };
type Handler = (params: Params, body: unknown, who: User, ctx: Ctx) => Promise<Reply> | Reply;
/**
 * `need` is the least role that may call the route. A public route needs no sign-in and is handed no caller, so its
 * answer cannot depend on the bearer: a public answer that did would tell an unthrottled guesser which tokens are valid.
 * `maxBody` is the largest body a POST reads, MAX_BODY_BYTES when absent.
 */
type Route =
  | { readonly method: 'GET'; readonly need: 'public'; readonly parts: readonly string[]; readonly run: () => Promise<Reply> | Reply }
  | { readonly method: 'GET' | 'POST'; readonly need: StudioRole; readonly parts: readonly string[]; readonly run: Handler; readonly maxBody?: number };

/** The capsule.json of one world dir, parsed, or null when absent or foreign. */
async function readCapsule(dir: string): Promise<RunCapsule | null> {
  const text = await readFile(path.join(dir, CAPSULE_FILE), 'utf8').catch(() => null);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = capsuleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The capsule facts the worlds table shows: the WID, model, transport, spend and attempt count. */
function capsuleFacts(c: RunCapsule): { wid: string | null; model: string; transport: string; costUsd: number; attempts: number } {
  return { wid: c.worldId, model: c.model, transport: c.transport, costUsd: c.costUsd, attempts: c.attempts.length };
}

/** Every grader, solution and decoy source of a loaded (unchecked) world value. */
function privateSources(value: unknown): string[] {
  if (!isObject(value) || !isObject(value['tasks'])) return [];
  const out: string[] = [];
  for (const task of Object.values(value['tasks'])) {
    if (!isObject(task)) continue;
    for (const key of ['grader', 'solution'] as const) {
      if (typeof task[key] === 'string') out.push(task[key] as string);
    }
    const decoys = task['decoys'];
    if (Array.isArray(decoys)) {
      for (const d of decoys) {
        if (!isObject(d)) continue;
        // A decoy's `why` is one line of prose that REPORT.md lists under Decoys on purpose; only its script is source.
        if (typeof d['script'] === 'string') out.push(d['script'] as string);
      }
    }
  }
  return out;
}

/** The first lines of a summary: through the pass-rate line, else a 12-line preview. */
function firstLines(text: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('**Pass rate:**'));
  if (at < 0 || at >= SUMMARY_SCAN_LINES) return lines.slice(0, 12);
  return lines.slice(0, at + 1);
}

/**
 * Serves the studio on one port. Rejects with the listen error (such as EADDRINUSE) and leaves
 * nothing listening. Tracked children are stopped only by their stop routes or by close().
 */
export async function studioServer(opts: StudioOptions): Promise<StudioServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const users = opts.users ?? [];
  if (users.length === 0 && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(`studio refuses to bind ${host} with no sign-in: it starts worldgen runs. Pass --users <file> or set WORLDGEN_STUDIO_TOKEN, or bind 127.0.0.1`);
  }
  const signIn = users.length > 0;
  const configuredOrigin = opts.origin === undefined ? undefined : originOf(opts.origin);
  if (configuredOrigin === null) throw new Error(`studio origin must be an http(s) origin such as http://127.0.0.1:8787, got ${opts.origin}`);
  const digests = users.map((u) => {
    if (!/^[0-9a-f]{64}$/i.test(u.tokenSha256)) throw new Error(`studio user ${u.name}: tokenSha256 must be 64 hex characters`);
    if (!TENANT.test(u.tenant)) throw new Error(`studio user ${u.name}: ${TENANT_RULE}`);
    return { user: u, digest: Buffer.from(u.tokenSha256, 'hex') };
  });
  /** Every tenant with a directory of its own under the worlds dir. `default` has none: its worlds are the library. */
  const tenants: ReadonlySet<string> = new Set(users.map((u) => u.tenant).filter((t) => t !== DEFAULT_TENANT).sort());
  const seen = new Set<string>();
  for (const { user, digest } of digests) {
    for (const [what, key] of [['name', user.name], ['token', digest.toString('hex')]] as const) {
      if (seen.has(`${what} ${key}`)) throw new Error(`studio users share a ${what}: ${user.name}`);
      seen.add(`${what} ${key}`);
    }
  }
  /** Open mode makes every request the local admin; otherwise the bearer decides. Every digest is compared, in constant time. */
  const callerOf = (req: IncomingMessage): Caller => {
    if (!signIn) return { kind: 'user', name: 'local', role: 'admin', tenant: DEFAULT_TENANT };
    const m = /^bearer +(.+)$/i.exec(req.headers.authorization ?? '');
    if (m === null) return { kind: 'anonymous' };
    const given = sha256(m[1]!.trim());
    let hit: StudioUser | null = null;
    for (const d of digests) if (timingSafeEqual(given, d.digest)) hit = d.user;
    return hit === null ? { kind: 'rejected' } : { kind: 'user', name: hit.name, role: hit.role, tenant: hit.tenant };
  };
  const repoRoot = path.resolve(opts.repoRoot);
  const worldsDir = path.resolve(opts.worldsDir ?? path.join(repoRoot, 'prod', 'worlds'));
  const codeDir = path.join(repoRoot, 'code');
  const inputsDir = path.join(repoRoot, 'eval', 'inputs');
  const evalRunsDir = path.join(repoRoot, 'eval', 'runs');
  /** Agent episodes (YOS-190), kept apart from the generator's eval runs: one directory per episode run. */
  const episodesDir = path.join(repoRoot, 'eval', 'episodes');

  const file = async (p: string): Promise<boolean> => {
    const s = await stat(p).catch(() => null);
    return s !== null && s.isFile();
  };
  const isDir = async (p: string): Promise<boolean> => {
    const s = await stat(p).catch(() => null);
    return s !== null && s.isDirectory();
  };
  const dirsOf = async (p: string): Promise<string[]> => {
    const entries: readonly Dirent[] = await readdir(p, { withFileTypes: true }).catch(() => [] as readonly Dirent[]);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  };
  // A tenant's directory holds its worlds, so a shared world of the same name would be hidden from everyone.
  for (const t of tenants) {
    if (await file(path.join(worldsDir, t, 'world.yaml'))) throw new Error(`studio tenant ${t} is also a world in ${worldsDir}; rename the tenant`);
  }

  /** One directory of world dirs: the shared library (tenant null) or one tenant's own. */
  type Shelf = { readonly tenant: string | null; readonly root: string };
  const LIBRARY: Shelf = { tenant: null, root: worldsDir };
  const shelfOf = (tenant: string): Shelf => ({ tenant, root: path.join(worldsDir, tenant) });
  /** Where `tenant` writes: its own dir, and for `default` the worlds dir itself, the old layout. */
  const writeRootOf = (tenant: string): string => (tenant === DEFAULT_TENANT ? worldsDir : shelfOf(tenant).root);
  /** What `who` reads: the library, then each tenant dir it sees, in name order. */
  const shelvesOf = (who: User, filter: string | null): Shelf[] => [LIBRARY, ...[...tenants].filter((t) => visible(t, who, filter)).map(shelfOf)];
  /** The dirs on a shelf. A dot dir (.uploads) is never a world, and a tenant's own dir is never a dir of the library. */
  const dirsOn = async (shelf: Shelf): Promise<string[]> => {
    const names = (await dirsOf(shelf.root)).filter((name) => !name.startsWith('.') && (shelf.tenant !== null || !tenants.has(name)));
    if (shelf.tenant !== null) return names;
    const kept: string[] = [];
    for (const name of names) if (!await isTenantShelf(path.join(shelf.root, name))) kept.push(name);
    return kept;
  };
  /** A library dir with no world.yaml or plan.yaml of its own but worlds below it is a removed tenant's shelf, never a world. */
  const isTenantShelf = async (dir: string): Promise<boolean> => {
    if (await file(path.join(dir, 'world.yaml')) || await file(path.join(dir, 'plan.yaml'))) return false;
    for (const child of await dirsOf(dir)) {
      if (child.startsWith('.')) continue;
      if (await file(path.join(dir, child, 'world.yaml')) || await file(path.join(dir, child, 'plan.yaml'))) return true;
    }
    return false;
  };

  type ServiceRecord = { readonly id: string; readonly name: string; readonly tenant: string; readonly pid: number | undefined; readonly worldPort: number; readonly adminPort: number; readonly startedAt: string };
  type EpisodeRequest = { readonly world: string; readonly task: string; readonly agent: string };
  /**
   * One generation run or agent episode (A-335): its stored record, and the process this studio watches. `child` is
   * null before the spawn, for a job that was finished when it was loaded, and while another studio holds the lease.
   */
  type Job = {
    readonly runId: string;
    readonly kind: JobKind;
    readonly tenant: string;
    readonly key: string;
    readonly fingerprint: string;
    readonly outDir: string;
    readonly knownRuns: ReadonlySet<string>;
    readonly startedAt: string;
    readonly episode: EpisodeRequest | undefined;
    phase: StoredRun['phase'];
    lease: Lease | null;
    recovery: Recovery | undefined;
    pid: number | null;
    exitCode: number | null;
    child: SpawnedChild | null;
  };

  const services = new Map<string, { record: ServiceRecord; dir: string; child: SpawnedChild }>();
  /** `<tenant> <world dir>` of each `worldplay serve` that has not reported its ports yet. */
  const starting = new Set<string>();
  /** Ports an admin pinned for a `worldplay serve` that has not reported yet: the world port and its admin port. */
  const pinning = new Set<number>();
  /** Each `worldplay serve` child that has not reported yet, so close() stops it too. */
  const startingChildren = new Set<SpawnedChild>();
  const jobs = new Map<string, Job>();
  /** Aborted by close(): it stops every runner child, the Explorer check and the proof among them. */
  const stopping = new AbortController();
  /** The runner calls still running, so close() can wait until their children are gone. */
  const runnerCalls = new Set<Promise<RunResult>>();
  const runChild: Runner = (argv, runOpts) => {
    const call = opts.runner(argv, { ...runOpts, signal: stopping.signal });
    runnerCalls.add(call);
    const done = (): void => void runnerCalls.delete(call);
    call.then(done, done);
    return call;
  };
  /** A generation run `who` sees, by id. Another tenant's is not found, exactly like an id that never existed. */
  const runOf = (runId: string, who: User, filter: string | null): Job | undefined => {
    const job = jobs.get(runId);
    return job?.kind === 'generate' && visible(job.tenant, who, filter) ? job : undefined;
  };
  const isEpisode = (job: Job | undefined): job is Job & { readonly episode: EpisodeRequest } => job?.kind === 'episode' && job.episode !== undefined;
  const processes = opts.processes ?? osProcesses;
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const now = opts.now ?? Date.now;
  /** Token buckets by key, oldest inserted dropped beyond MAX_BUCKETS. Time is the injected clock. */
  const bucketsOf = (limit: RateLimit) => {
    const buckets = new Map<string, { tokens: number; at: number }>();
    const refilled = (key: string): { tokens: number; at: number } => {
      const t = now();
      const b = buckets.get(key) ?? { tokens: limit.capacity, at: t };
      b.tokens = Math.min(limit.capacity, b.tokens + Math.max(0, t - b.at) / 1000 * limit.refillPerSecond);
      b.at = t;
      if (!buckets.has(key)) {
        buckets.set(key, b);
        if (buckets.size > MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
      }
      return b;
    };
    return {
      /** Whole seconds until one token is there (at least 1), or 0 when there is one. */
      wait(key: string): number {
        const b = refilled(key);
        return b.tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / limit.refillPerSecond));
      },
      draw(key: string): void {
        const b = refilled(key);
        b.tokens = Math.max(0, b.tokens - 1);
      },
    };
  };
  const me = `studio-${process.pid}-${randomBytes(4).toString('hex')}`;
  const leaseFrom = (at: number): Lease => ({ holder: me, expiresAt: new Date(at + leaseMs).toISOString() });
  const rateLimit = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
  const postBuckets = bucketsOf(rateLimit);
  const authLimit = opts.authThrottle ?? DEFAULT_AUTH_THROTTLE;
  const failedSignIns = bucketsOf(authLimit);
  const maxJobs = { generate: opts.maxConcurrentRuns ?? DEFAULT_MAX_JOBS, episode: opts.maxConcurrentEpisodes ?? DEFAULT_MAX_JOBS };
  const holds = (job: Job): boolean => job.lease?.holder === me;
  /** Set by close(): from then on the registry is never written. */
  let closed = false;
  const storedOf = (job: Job): StoredRun => ({
    runId: job.runId, kind: job.kind, tenant: job.tenant, key: job.key, fingerprint: job.fingerprint, phase: job.phase, lease: job.lease,
    ...(job.recovery === undefined ? {} : { recovery: job.recovery }),
    outDir: job.outDir, pid: job.pid, knownRuns: [...job.knownRuns], startedAt: job.startedAt, exitCode: job.exitCode,
    ...(job.episode === undefined ? {} : { episode: job.episode }),
  });
  const jobOf = (stored: StoredRun): Job => ({
    runId: stored.runId, kind: stored.kind, tenant: stored.tenant, key: stored.key, fingerprint: stored.fingerprint, outDir: stored.outDir,
    knownRuns: new Set(stored.knownRuns), startedAt: stored.startedAt, episode: stored.episode, phase: stored.phase,
    lease: stored.lease, recovery: stored.recovery, pid: stored.pid, exitCode: stored.exitCode, child: null,
  });
  // One write at a time, in order, so the file on disk is always the latest whole registry. True when it was written.
  let persisting: Promise<boolean> = Promise.resolve(true);
  const persist = (): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    const snapshot = [...jobs.values()].map(storedOf);
    persisting = persisting.then(() => saveRuns(worldsDir, snapshot)).then(() => true, () => false);
    return persisting;
  };
  // The audit log: one line per POST, appended one at a time in order. A failed append never fails the reply (fail-open).
  const auditPath = path.join(worldsDir, AUDIT_FILE);
  let auditing: Promise<void> = Promise.resolve();
  let unwritten = 0;
  const audit = (entry: Record<string, unknown>): Promise<void> => {
    auditing = auditing.then(() => appendFile(auditPath, `${JSON.stringify(entry)}\n`)).catch(() => {
      unwritten += 1;
    });
    return auditing;
  };
  /** The last AUDIT_TAIL lines, or with `?tenant=` the last AUDIT_TAIL lines of that tenant. */
  async function auditTail(filter: string | null): Promise<Reply> {
    await auditing;
    const text = await readFile(auditPath, 'utf8').catch(() => '');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    const entries: unknown[] = [];
    for (const line of filter === null ? lines.slice(-AUDIT_TAIL) : lines) {
      try {
        const entry: unknown = JSON.parse(line);
        if (filter === null || (isObject(entry) && entry['tenant'] === filter)) entries.push(entry);
      } catch {
        // a damaged line is skipped, not fatal
      }
    }
    return { status: 200, body: { entries: entries.slice(-AUDIT_TAIL), unwritten } };
  }
  /** Watches a job's process. Its end finishes the job, unless another studio took the lease and so records the end. */
  const watch = (job: Job, child: SpawnedChild): void => {
    job.child = child;
    void child.exited.then((code) => {
      if (job.child !== child) return;
      job.phase = 'finished';
      job.lease = null;
      job.exitCode = code;
      void persist();
    });
  };
  /** Applies the lease rules (`recoveryOf`, A-335) to a job whose holder may have died. True when it acted. */
  const recover = (job: Job, at: number): boolean => {
    const decision = recoveryOf(job, at, me, processes);
    const when = new Date(at).toISOString();
    switch (decision.kind) {
      case 'leave':
        return false;
      case 'resume':
        job.lease = leaseFrom(at);
        job.recovery = { at: when, from: decision.from, outcome: 'resumed' };
        watch(job, adoptedChild(decision.pid, processes));
        return true;
      case 'stop':
        job.recovery = { at: when, from: decision.from, outcome: 'stopped', reason: decision.reason };
        job.phase = 'finished';
        job.lease = null;
        return true;
      default:
        return assertNever(decision);
    }
  };
  /**
   * The lease tick. Each unfinished job this studio holds gets a fresh lease, unless the file names another holder: a
   * studio took it over while this one stalled, so this one stops renewing it and only reads it from then on. A job
   * held elsewhere is read from the file, then recovered if its lease ran out.
   */
  let renewing = false;
  const renew = async (): Promise<void> => {
    if (renewing) return;
    renewing = true;
    try {
      await persisting;
      const onDisk = new Map((await loadRuns(worldsDir)).map((stored) => [stored.runId, stored]));
      if (closed) return;
      const at = now();
      let changed = false;
      for (const job of jobs.values()) {
        if (job.phase === 'finished') continue;
        const disk = onDisk.get(job.runId);
        if (holds(job) && (disk === undefined || disk.lease?.holder === me)) {
          job.lease = leaseFrom(at);
          changed = true;
        } else if (disk !== undefined) {
          job.phase = disk.phase;
          job.lease = disk.lease;
          job.recovery = disk.recovery;
          job.pid = disk.pid;
          job.exitCode = disk.exitCode;
          job.child = null;
        }
        if (recover(job, at)) changed = true;
      }
      if (changed) await persist();
    } finally {
      renewing = false;
    }
  };
  // Jobs a previous studio left (A-329, A-335) are recovered by the lease rules; none is started again. A finished
  // one is listed as it was, and a dead run keeps its <out>.partial evidence and REPORT (A-293).
  for (const stored of await loadRuns(worldsDir)) jobs.set(stored.runId, jobOf(stored));
  const loadedAt = now();
  for (const job of jobs.values()) recover(job, loadedAt);
  await persist();
  let costsCache: { at: number; value: unknown } | null = null;
  let costsInFlight: Promise<unknown> | null = null;
  const traffic = trafficCounter(now());

  // ---- handlers ---------------------------------------------------------------------------

  /**
   * Readiness for a container or load balancer: the worlds directory reads, and the build and runtime are named. Traffic
   * counts every answer but health polls, since start and in the last 300 s (YOS-237). It is public, so it holds no spend.
   * The world count is the library's alone, the same for every caller, because a public answer must not depend on the bearer.
   */
  async function health(): Promise<Reply> {
    const bun = process.versions['bun'];
    const runtime = bun === undefined ? `node ${process.versions.node}` : `bun ${bun}`;
    try {
      return { status: 200, body: { ok: true, build: opts.build ?? 'unknown', runtime, worlds: (await worldEntries([LIBRARY])).length, traffic: traffic.snapshot(now()) } };
    } catch (e) {
      return fail(503, 'health.worlds_unreadable', `worlds directory ${worldsDir} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * World directories on the shelves, each with the tenant whose dir holds it (null for the library). A generation
   * stopped before its plan leaves runs/ and REPORT.md with neither world.yaml nor plan.yaml: that is a run, listed
   * under /api/runs, not a world, so it is skipped here instead of reading as an invalid hand-built world. A dir with
   * plan.yaml and no world.yaml is still listed, as a generation that failed.
   */
  async function worldEntries(shelves: readonly Shelf[]): Promise<{ name: string; tenant: string | null; dir: string }[]> {
    const out: { name: string; tenant: string | null; dir: string }[] = [];
    for (const shelf of shelves) {
      for (const name of await dirsOn(shelf)) {
        if (name.endsWith(PARTIAL_SUFFIX)) continue;
        const dir = path.join(shelf.root, name);
        if (await file(path.join(dir, 'world.yaml')) || await file(path.join(dir, 'plan.yaml'))) out.push({ name, tenant: shelf.tenant, dir });
      }
    }
    return out;
  }

  /**
   * A world dir by its route name, or the reply that refuses it: the caller's own tenant dir first (an admin's
   * `?tenant=` names it), then the library. A world in another tenant's dir answers like no world at all.
   */
  async function worldDirOf(name: string, who: User, filter: string | null): Promise<{ ok: true; dir: string } | { ok: false; reply: Reply }> {
    if (!safeSegment(name)) return { ok: false, reply: fail(400, 'world.name_unsafe', 'a world name must be one plain path segment') };
    const own = who.role === 'admin' && filter !== null ? filter : who.tenant;
    for (const shelf of [...(tenants.has(own) ? [shelfOf(own)] : []), LIBRARY]) {
      const dir = path.join(shelf.root, name);
      if (!name.startsWith('.') && (shelf.tenant !== null || !tenants.has(name)) && await isDir(dir) && (shelf.tenant !== null || !await isTenantShelf(dir))) return { ok: true, dir };
    }
    return { ok: false, reply: fail(404, 'world.unknown', `No world ${name} under ${worldsDir}`) };
  }

  async function worlds(who: User, filter: string | null): Promise<Reply> {
    const list = await Promise.all((await worldEntries(shelvesOf(who, filter))).map(async ({ name, tenant, dir }) => {
      const capsule = await readCapsule(dir);
      const loaded = await loadWorld(dir);
      const base = {
        name,
        tenant,
        generated: await file(path.join(dir, 'plan.yaml')),
        ...(loaded.ok
          ? { taskCount: isObject(loaded.value) && isObject(loaded.value['tasks']) ? Object.keys(loaded.value['tasks']).length : 0 }
          : { taskCount: null, invalid: loaded.error[0].code }),
        ...(capsule === null ? {} : { capsule: capsuleFacts(capsule) }),
        reportExists: await file(path.join(dir, 'REPORT.md')),
      };
      return base;
    }));
    return { status: 200, body: { worlds: list } };
  }

  const checkedWorlds = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly body: Record<string, unknown> }>();
  /** Checks in flight, by world dir and world.yaml version: a repeated request joins the running child instead of starting another. */
  const checking = new Map<string, Promise<Reply>>();

  /** The check, proof and serve children run a world's snippets, so they get an allowlist, never the web process's credentials (A-338, A-343). */
  const childEnv = (): Record<string, string> => isolatedEnv(opts.env ?? process.env);
  /** Generation and episodes call the model, so they get the whole environment, LLM_KEY included, but never the studio's own sign-in token. */
  const modelEnv = (): Record<string, string | undefined> => {
    const { WORLDGEN_STUDIO_TOKEN: _token, ...rest } = opts.env ?? process.env;
    return rest;
  };
  const checkTimeoutMs = opts.checkTimeoutMs ?? 300_000;
  const lastLine = (text: string): string => text.trim().split('\n').slice(-1)[0] ?? '';

  /** <name>.zip of the world's own files (EXPORT_FILES that exist), refused like the report when REPORT.md leaks task source. */
  async function worldExport(p: Params, who: User, filter: string | null): Promise<Reply> {
    const name = p['name'] ?? '';
    const w = await worldDirOf(name, who, filter);
    if (!w.ok) return w.reply;
    if (!await file(path.join(w.dir, 'world.yaml'))) return fail(404, 'export.no_world', `${name} has no world.yaml to export`);
    const checked = await reportOf(name, w.dir);
    if (checked.status !== 200) return checked;
    const entries: { name: string; data: Buffer }[] = [];
    for (const f of EXPORT_FILES) {
      const data = await readFile(path.join(w.dir, f)).catch(() => null);
      if (data !== null) entries.push({ name: `${name}/${f}`, data });
    }
    return { status: 200, body: zipOf(entries), type: 'application/zip', filename: `${name}.zip` };
  }

  async function worldReport(p: Params, who: User, filter: string | null): Promise<Reply> {
    const w = await worldDirOf(p['name'] ?? '', who, filter);
    return w.ok ? reportOf(p['name'] ?? '', w.dir) : w.reply;
  }

  /** REPORT.md and capsule.json of a resolved world dir, refused when the report embeds private task source. */
  async function reportOf(name: string, dir: string): Promise<Reply> {
    const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8').catch(() => null);
    const capsule = await readCapsule(dir);
    if (report !== null) {
      const loaded = await loadWorld(dir);
      for (const source of privateSources(loaded.ok ? loaded.value : null)) {
        if (source !== '' && report.includes(source)) {
          return fail(403, 'report.private_source', `${name}/REPORT.md contains private task source; the studio refuses to serve it`);
        }
      }
    }
    return { status: 200, body: { name, report, ...(capsule === null ? {} : { capsule }) } };
  }

  /**
   * The plan of a generated world (YOS-188): plan.yaml's assumptions, open questions and out-of-scope items, and plan.md,
   * or plan.md rendered from plan.yaml when the run wrote none. Refused like the report when any of it embeds task source.
   */
  async function worldPlan(p: Params, who: User, filter: string | null): Promise<Reply> {
    const name = p['name'] ?? '';
    const w = await worldDirOf(name, who, filter);
    if (!w.ok) return w.reply;
    const yaml = await readFile(path.join(w.dir, 'plan.yaml'), 'utf8').catch(() => null);
    if (yaml === null) return fail(404, 'plan.missing', `${name} has no plan.yaml; only a generated world has a plan`);
    const plan = parsePlanYaml(yaml);
    if (plan === null) return fail(422, 'plan.invalid', `${name}/plan.yaml does not parse as a WorldGen plan`);
    const written = await readFile(path.join(w.dir, 'plan.md'), 'utf8').catch(() => null);
    const body = {
      name,
      assumptions: plan.assumptions.map((a) => ({ decision: a.decision, why: a.why })),
      openQuestions: (plan.open_questions ?? []).map((q) => ({ question: q.question, default_answer: q.default_answer })),
      outOfScope: plan.outOfScope.map((o) => ({ what: o.what, why: o.why })),
      planMd: written ?? renderPlanMd(plan),
    };
    const shown = [body.planMd, ...body.assumptions.flatMap((a) => [a.decision, a.why]), ...body.openQuestions.flatMap((q) => [q.question, q.default_answer]), ...body.outOfScope.flatMap((o) => [o.what, o.why])];
    const loaded = await loadWorld(w.dir);
    const sources = privateSources(loaded.ok ? loaded.value : null).filter((source) => source !== '');
    if (shown.some((text) => sources.some((source) => text.includes(source)))) {
      return fail(403, 'plan.private_source', `${name}'s plan contains private task source; the studio refuses to serve it`);
    }
    return { status: 200, body };
  }

  async function explorer(p: Params, who: User, filter: string | null): Promise<Reply> {
    const name = p['name'] ?? '';
    const w = await worldDirOf(name, who, filter);
    if (!w.ok) return w.reply;
    const dir = w.dir;
    // The check verifies every task, about 9 s on a big world, so an explored world is kept until its world.yaml changes.
    const yaml = await stat(path.join(dir, 'world.yaml')).catch(() => null);
    const cached = checkedWorlds.get(dir);
    if (yaml !== null && cached !== undefined && cached.mtimeMs === yaml.mtimeMs && cached.size === yaml.size) {
      return { status: 200, body: cached.body };
    }
    const key = `${dir}\n${yaml?.mtimeMs}\n${yaml?.size}`;
    const running = checking.get(key);
    if (running !== undefined) return running;
    const reply = checkInChild(dir, name, yaml).finally(() => checking.delete(key));
    checking.set(key, reply);
    return reply;
  }

  async function checkInChild(dir: string, name: string, yaml: { readonly mtimeMs: number; readonly size: number } | null): Promise<Reply> {
    let res: RunResult;
    try {
      res = await runChild(['bun', 'src/cli/studio-check.ts', dir, name], { cwd: codeDir, env: childEnv(), timeoutMs: checkTimeoutMs });
    } catch {
      return fail(502, 'check.failed', 'the check process could not start');
    }
    if (res.code === 3) return fail(422, 'world.invalid', lastLine(res.stderr).slice(0, 300));
    if (res.code !== 0) return fail(502, 'check.failed', `the check process failed (exit ${res.code}): ${lastLine(res.stderr).slice(0, 200) || 'no output'}`);
    let body: unknown;
    try {
      body = JSON.parse(res.stdout);
    } catch {
      body = null;
    }
    if (!isObject(body)) return fail(502, 'check.unreadable', 'the check process answered something that is not a JSON object');
    if (yaml !== null) checkedWorlds.set(dir, { mtimeMs: yaml.mtimeMs, size: yaml.size, body });
    return { status: 200, body };
  }

  /** The API console: one request to the world port of a service this studio started, and the world's real answer. */
  /** A service `who` sees, by id. Another tenant's is not found, exactly like an id that never existed. */
  const serviceOf = (id: string, who: User, filter: string | null): { record: ServiceRecord; dir: string; child: SpawnedChild } | undefined => {
    const hit = services.get(id);
    return hit !== undefined && visible(hit.record.tenant, who, filter) ? hit : undefined;
  };

  async function callService(p: Params, body: unknown, who: User, filter: string | null): Promise<Reply> {
    const hit = serviceOf(p['id'] ?? '', who, filter);
    if (hit === undefined) return fail(404, 'service.unknown', `No service ${p['id'] ?? ''}`);
    if (!isObject(body)) return fail(400, 'call.body', 'the body must be a JSON object: {"method", "path", "body"}');
    const method = typeof body['method'] === 'string' ? body['method'].toUpperCase() : '';
    if (!CALL_METHODS.has(method)) return fail(400, 'call.method', 'method must be GET, POST, PUT, PATCH or DELETE');
    const target = body['path'];
    const origin = `http://127.0.0.1:${hit.record.worldPort}`;
    const url = typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') ? new URL(target, origin) : null;
    if (url === null || url.origin !== origin) return fail(400, 'call.path', 'path must start with one / and stay on the world port, such as /tickets?status=open');
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // A malformed escape is the world's to refuse; the admin check below still sees the raw path.
    }
    if (pathname === '/_world' || pathname.startsWith('/_world/')) {
      return fail(403, 'call.admin_path', 'the API console calls the world API only; /_world routes live on the admin port, which it never calls');
    }
    const payload = body['body'];
    if (payload !== undefined && (method === 'GET' || method === 'DELETE')) return fail(400, 'call.body', `${method} takes no body`);
    const started = Date.now();
    let res: Response;
    try {
      // A service is recorded only once its world reported it listens (A-348), so a refused call is the world's real answer.
      res = await fetch(url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
      });
    } catch (e) {
      return fail(502, 'call.unreachable', `world port ${hit.record.worldPort} of ${hit.record.name} did not answer ${method} ${url.pathname}${url.search}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const truncated = bytes.length > MAX_CALL_BYTES;
    return {
      status: 200,
      body: {
        service: hit.record.id, world: hit.record.name, worldPort: hit.record.worldPort,
        request: { method, path: `${url.pathname}${url.search}`, body: payload ?? null },
        status: res.status, contentType: res.headers.get('content-type'), ms: Date.now() - started,
        body: bytes.subarray(0, MAX_CALL_BYTES).toString('utf8'), truncated,
      },
    };
  }

  /** What a just-spawned `worldplay serve` did first: reported its listening ports, exited, or neither within `waitMs`. */
  async function firstReport(child: SpawnedChild, waitMs: number): Promise<{ kind: 'listening'; world: number; admin: number } | { kind: 'exited'; code: number | null } | { kind: 'timeout' }> {
    const state: { exit: { code: number | null } | null } = { exit: null };
    void child.exited.then((code) => {
      state.exit = { code };
    });
    const deadline = Date.now() + waitMs;
    for (;;) {
      const ports = listeningPorts(child.output());
      if (ports !== null) return { kind: 'listening', ...ports };
      if (state.exit !== null) return { kind: 'exited', code: state.exit.code };
      if (Date.now() >= deadline) return { kind: 'timeout' };
      await sleep(SERVE_POLL_MS);
    }
  }

  /**
   * Serves a world as a `worldplay serve` child on ports the OS picks, and records the ports the child reports once both
   * listen (A-348). Only an admin may pin a port, and never one a tracked service holds, so no caller can point the API
   * console at another service's world.
   */
  async function serveWorld(p: Params, body: unknown, who: User, filter: string | null): Promise<Reply> {
    const name = p['name'] ?? '';
    const w = await worldDirOf(name, who, filter);
    if (!w.ok) return w.reply;
    const dir = w.dir;
    // An admin serving with ?tenant=t serves the world for t, so t's own operators see and stop it.
    const owner = filter ?? who.tenant;
    const startKey = `${owner} ${dir}`;
    if (starting.has(startKey)) return fail(409, 'world.already_serving', `${name} is starting; wait for it or stop it`);
    // Only a service the caller sees blocks a second serve, so the refusal never names another tenant's port. A second
    // `worldplay serve` of one world dir is safe: serve keeps its state in memory and writes nothing into the dir.
    for (const s of services.values()) {
      if (s.dir === dir && visible(s.record.tenant, who, filter)) return fail(409, 'world.already_serving', `${name} is already served on port ${s.record.worldPort}; stop it first`);
    }
    const wanted = isObject(body) ? body['port'] : undefined;
    let port = 0;
    if (wanted !== undefined && who.role === 'admin') {
      if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1 || wanted > 65534) {
        return fail(400, 'serve.port', 'port must be an integer from 1 to 65534 (the admin routes take port + 1)');
      }
      for (const { record } of services.values()) {
        if ([record.worldPort, record.adminPort].some((held) => held === wanted || held === wanted + 1)) {
          return fail(409, 'serve.port_taken', `port ${wanted} or its admin port ${wanted + 1} belongs to ${record.name} (${record.id})`);
        }
      }
      if (pinning.has(wanted) || pinning.has(wanted + 1)) {
        return fail(409, 'serve.port_taken', `port ${wanted} or its admin port ${wanted + 1} is pinned by a serve that has not reported its ports yet`);
      }
      port = wanted;
    }
    // From the checks above to here nothing awaits, so a second pin of the same port cannot pass them before this one is held.
    // Nor can close() start in between, so a child spawned here is always one that close() stops.
    if (closed) return fail(503, 'studio.closing', `The studio is closing, so it did not serve ${name}`);
    const pinned = port === 0 ? [] : [port, port + 1];
    for (const held of pinned) pinning.add(held);
    const child = opts.spawner(['bun', 'src/cli/worldplay.ts', 'serve', dir, '--port', String(port)], { cwd: codeDir, env: childEnv() });
    starting.add(startKey);
    startingChildren.add(child);
    let report: Awaited<ReturnType<typeof firstReport>>;
    try {
      report = await firstReport(child, opts.serveWaitMs ?? SERVE_WAIT_MS);
    } finally {
      starting.delete(startKey);
      startingChildren.delete(child);
      for (const held of pinned) pinning.delete(held);
    }
    if (report.kind === 'exited') {
      const said = child.output().trim().split('\n').pop()?.trim() ?? '';
      return fail(502, 'serve.failed', `worldplay serve for ${name} exited ${report.code ?? 'by a signal'} before it listened${said === '' ? '' : `: ${said}`}`);
    }
    if (report.kind === 'timeout') {
      await signalAndWait(child, ['SIGTERM', 'SIGKILL']);
      return fail(504, 'serve.timeout', `worldplay serve for ${name} reported no listening ports within ${opts.serveWaitMs ?? SERVE_WAIT_MS} ms, so the studio stopped it`);
    }
    // It reported while close() was stopping it: close() waits for it, so it is never served.
    if (closed) return fail(503, 'studio.closing', `The studio is closing, so it stopped ${name} before serving it`);
    let id = `svc-${randomBytes(4).toString('hex')}`;
    while (services.has(id)) id = `svc-${randomBytes(4).toString('hex')}`;
    const record: ServiceRecord = { id, name, tenant: owner, pid: child.pid, worldPort: report.world, adminPort: report.admin, startedAt: new Date().toISOString() };
    services.set(id, { record, dir, child });
    void child.exited.then(() => {
      services.delete(id);
    });
    return { status: 200, body: record };
  }

  /**
   * Resets a served world to its seed (A-357). The caller types the world's name as `confirm`, because a reset throws
   * away every change to its state. The studio calls only that service's admin port, server-side, and answers the
   * engine's time and the reset state's hash, never the state itself.
   */
  async function resetService(p: Params, body: unknown, who: User, filter: string | null): Promise<Reply> {
    const hit = serviceOf(p['id'] ?? '', who, filter);
    if (hit === undefined) return fail(404, 'service.unknown', `No service ${p['id'] ?? ''}`);
    const name = hit.record.name;
    if (!isObject(body) || body['confirm'] !== name) {
      return fail(400, 'reset.confirm', `a reset throws away every change to ${name}'s state; send {"confirm": "${name}"} to go ahead`);
    }
    const admin = `http://127.0.0.1:${hit.record.adminPort}`;
    const signal = (): AbortSignal => AbortSignal.timeout(CALL_TIMEOUT_MS);
    try {
      const reset = await fetch(`${admin}/_world/reset`, { method: 'POST', redirect: 'manual', signal: signal() });
      if (!reset.ok) return fail(502, 'reset.failed', `the admin port of ${name} answered ${reset.status} to the reset`);
      const done: unknown = await reset.json();
      const state = await fetch(`${admin}/_world/state`, { redirect: 'manual', signal: signal() });
      const dump: unknown = state.ok ? await state.json() : null;
      const now = isObject(done) && typeof done['now'] === 'string' ? done['now'] : null;
      const hash = isObject(dump) && typeof dump['hash'] === 'string' ? dump['hash'] : null;
      if (now === null || hash === null) return fail(502, 'reset.failed', `the admin port of ${name} gave no time or state hash after the reset`);
      return { status: 200, body: { service: hit.record.id, world: name, now, hash } };
    } catch (e) {
      return fail(502, 'reset.unreachable', `the admin port of ${name} did not answer the reset: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function stopService(p: Params, who: User, filter: string | null): Promise<Reply> {
    const hit = serviceOf(p['id'] ?? '', who, filter);
    if (hit === undefined) return fail(404, 'service.unknown', `No service ${p['id'] ?? ''}`);
    const gone = await signalAndWait(hit.child, ['SIGTERM', 'SIGKILL']);
    services.delete(hit.record.id);
    return { status: 200, body: { id: hit.record.id, stopped: gone.exited, signal: gone.signal } };
  }

  type PathCheck = { ok: true; path: string } | { ok: false; why: string };

  /** One operator-given path under eval/inputs; relative paths resolve against it. */
  async function underInputs(raw: string): Promise<PathCheck> {
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(inputsDir, raw);
    if (abs !== inputsDir && !abs.startsWith(`${inputsDir}${path.sep}`)) {
      return { ok: false, why: `${raw} is not under eval/inputs; pass a path relative to it, such as petstore.openapi.yaml` };
    }
    if (!await file(abs)) return { ok: false, why: `no file at ${abs}` };
    return { ok: true, path: abs };
  }

  /** Files under eval/inputs a generation can read, as paths relative to it: OpenAPI specs and CSV tables. */
  async function inputFiles(dir = inputsDir, depth = 0): Promise<string[]> {
    if (depth > 3) return [];
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => [])) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await inputFiles(abs, depth + 1));
      else if (e.isFile()) out.push(path.relative(inputsDir, abs).split(path.sep).join('/'));
    }
    return out.sort();
  }

  async function inputs(): Promise<Reply> {
    const all = await inputFiles();
    return { status: 200, body: { openapi: all.filter((f) => /\.(ya?ml|json)$/i.test(f)), csv: all.filter((f) => /\.csv$/i.test(f)) } };
  }

  /** The paths an OpenAPI spec under eval/inputs declares, for the --only picker; null with a reason when it is not a spec. */
  async function pathsOfSpec(rel: string): Promise<{ ok: true; abs: string; paths: string[] } | { ok: false; why: string }> {
    const spec = await underInputs(rel);
    if (!spec.ok) return spec;
    let doc: unknown;
    try {
      doc = parseYaml(await readFile(spec.path, 'utf8'));
    } catch (e) {
      return { ok: false, why: `${rel} does not parse as YAML or JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!isObject(doc) || !isObject(doc['paths'])) return { ok: false, why: `${rel} is not an OpenAPI document: it has no paths object` };
    return { ok: true, abs: spec.path, paths: Object.keys(doc['paths']).sort() };
  }

  async function specPaths(p: Params): Promise<Reply> {
    const found = await pathsOfSpec(p['spec'] ?? '');
    return found.ok ? { status: 200, body: { spec: p['spec'], paths: found.paths } } : fail(400, 'generate.spec', found.why);
  }

  // ---- uploads (YOS-188) --------------------------------------------------------------------

  type StoredUpload = { readonly id: string; readonly kind: UploadKind; readonly name: string; readonly bytes: number; readonly file: string };
  const uploadView = (u: StoredUpload): { id: string; kind: UploadKind; name: string; bytes: number } => ({ id: u.id, kind: u.kind, name: u.name, bytes: u.bytes });

  /** One of `tenant`'s uploads by id, or null: any other id, another tenant's included, is unknown. */
  async function uploadOf(tenant: string, id: string): Promise<StoredUpload | null> {
    const parts = uploadPartsOf(id);
    if (parts === null) return null;
    const at = uploadFileOf(writeRootOf(tenant), parts.sha12, parts.name);
    const s = await lstat(at).catch(() => null);
    return s !== null && s.isFile() ? { id, kind: parts.kind, name: parts.name, bytes: s.size, file: at } : null;
  }

  /** `tenant`'s uploads, by name, then id. */
  async function uploadsOf(tenant: string): Promise<StoredUpload[]> {
    const root = path.join(writeRootOf(tenant), UPLOADS_DIR);
    const out: StoredUpload[] = [];
    for (const sha12 of await dirsOf(root)) {
      for (const name of await readdir(path.join(root, sha12)).catch((): string[] => [])) {
        const one = await uploadOf(tenant, `${sha12}-${name}`);
        if (one !== null) out.push(one);
      }
    }
    const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return out.sort((a, b) => order(a.name, b.name) || order(a.id, b.id));
  }

  /** The OpenAPI paths of a stored upload, read again from its file. */
  async function specOfUpload(u: StoredUpload): Promise<{ ok: true; abs: string; paths: string[] } | { ok: false; why: string }> {
    const text = await readFile(u.file, 'utf8').catch(() => null);
    if (text === null) return { ok: false, why: `upload ${u.id} cannot be read` };
    const spec = openapiPaths(text);
    return spec.ok ? { ok: true, abs: u.file, paths: spec.paths } : { ok: false, why: `upload ${u.id}: ${spec.why}` };
  }

  // One upload at a time, so two at once cannot both pass the cap.
  let uploading: Promise<unknown> = Promise.resolve();

  async function upload(body: unknown, who: User): Promise<Reply> {
    const parsed = parseUpload(body);
    if (!parsed.ok) return fail(400, parsed.code, parsed.message);
    const stored = uploading.then(() => storeUpload(parsed.upload, who.tenant));
    uploading = stored.catch(() => undefined);
    return stored;
  }

  /** Writes a new upload through a temp file and a rename, 0600 in 0700 dirs; an upload stored before answers 200 untouched. */
  async function storeUpload(u: Upload, tenant: string): Promise<Reply> {
    const { sha12, id } = uploadIdOf(u);
    const answer = (status: 200 | 201, bytes: number): Reply => ({
      status, body: { upload: { id, kind: u.kind, name: u.name, bytes, ...(u.paths === undefined ? {} : { paths: u.paths }) } },
    });
    const known = await uploadOf(tenant, id);
    if (known !== null) return answer(200, known.bytes);
    if ((await uploadsOf(tenant)).length >= MAX_UPLOADS) return fail(409, 'upload.full', `this tenant already stores ${MAX_UPLOADS} uploads, the most the studio keeps for one tenant`);
    const root = writeRootOf(tenant);
    await mkdir(root, { recursive: true });
    const target = uploadFileOf(root, sha12, u.name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(target), `.${u.name}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(temp, u.content, { mode: 0o600, flag: 'wx' });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    return answer(201, Buffer.byteLength(u.content, 'utf8'));
  }

  async function uploadPaths(p: Params, who: User): Promise<Reply> {
    const id = p['id'] ?? '';
    const found = await uploadOf(who.tenant, id);
    if (found === null) return fail(404, 'upload.unknown', `No upload ${id}`);
    if (found.kind !== 'openapi') return fail(400, 'upload.kind', `upload ${id} is a csv table; only an OpenAPI upload has paths`);
    const spec = await specOfUpload(found);
    return spec.ok ? { status: 200, body: { upload: id, paths: spec.paths } } : fail(422, 'upload.openapi', spec.why);
  }

  /** What a job start asks for. `request` is what two retries share: the child's argv without the run id each job mints or the transport. */
  type JobStart = {
    readonly kind: JobKind;
    /** The caller's tenant: the job's owner, and the scope its key is looked up in. */
    readonly tenant: string;
    readonly rawKey: RawKey;
    readonly request: readonly string[];
    /** The run id after its UTC stamp. */
    readonly label: string;
    readonly knownRuns: ReadonlySet<string>;
    readonly episode: EpisodeRequest | undefined;
    /** The out dir and the child's argv, once the run id is fixed. */
    readonly launch: (runId: string) => { readonly outDir: string; readonly argv: readonly string[] };
  };

  /** The answer to a start, the same for the first request and each replay of it. */
  const startAnswer = (job: Job, replayed: boolean): Reply => {
    const running = job.phase !== 'finished';
    return { status: 200, body: isEpisode(job) ? { runId: job.runId, ...job.episode, running, replayed } : { runId: job.runId, outDir: job.outDir, running, replayed } };
  };

  /** What a status shows of a job's record. Never the request body or the argv. */
  const jobView = (job: Job): Record<string, unknown> => ({
    kind: job.kind, key: job.key, phase: job.phase, lease: job.lease, ...(job.recovery === undefined ? {} : { recovery: job.recovery }),
  });

  /**
   * Starts a job once per key (A-335). A client key names one job forever; a derived key matches only an unfinished
   * job, so the same request after the first one finished is a deliberate rerun. The intent is on disk before the spawn.
   */
  async function startJob(start: JobStart): Promise<Reply> {
    const clientKey = idempotencyKeyOf(start.rawKey);
    if (!clientKey.ok) return clientKey.reply;
    const fingerprint = fingerprintOf(start.kind, start.request);
    const key = clientKey.key ?? `derived:${fingerprint}`;
    // No await from this lookup to the insert below, so two requests with one key cannot both miss. Another tenant's job
    // never matches: its key is unused here, since a replay or a refusal would tell this caller that the key exists.
    const prior = [...jobs.values()].find((j) => j.tenant === start.tenant && j.key === key && (clientKey.key !== undefined || j.phase !== 'finished'));
    if (prior !== undefined) {
      if (prior.fingerprint === fingerprint) return startAnswer(prior, true);
      return fail(422, 'idempotency.mismatch', `Idempotency-Key ${key} was used for a different request (job ${prior.runId})`);
    }
    // Counted after the lookup, so a replay answers first. Intents and jobs another studio leases count. Still no await.
    // The cap is global because it protects the machine. The refusal states no count, since the count holds other tenants' jobs.
    const active = [...jobs.values()].filter((j) => j.kind === start.kind && j.phase !== 'finished').length;
    if (active >= maxJobs[start.kind]) {
      const what = start.kind === 'generate' ? 'generation runs' : 'agent episodes';
      return fail(429, start.kind === 'generate' ? 'generate.concurrent_limit' : 'episode.concurrent_limit', `the studio runs at most ${maxJobs[start.kind]} ${what} at once; wait for one to finish`);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    // A random suffix, so an id never counts another tenant's starts.
    let runId = `${stamp}-${start.label}-${randomBytes(3).toString('hex')}`;
    while (jobs.has(runId)) runId = `${stamp}-${start.label}-${randomBytes(3).toString('hex')}`;
    const { outDir, argv } = start.launch(runId);
    const job: Job = {
      runId, kind: start.kind, tenant: start.tenant, key, fingerprint, outDir, knownRuns: start.knownRuns, startedAt: new Date().toISOString(),
      episode: start.episode, phase: 'intent', lease: leaseFrom(now()), recovery: undefined, pid: null, exitCode: null, child: null,
    };
    jobs.set(runId, job);
    const recorded = await persist();
    // No child may outlive close(). An intent already written is stopped as unconfirmed by the next studio.
    if (closed) return fail(503, 'studio.closing', `The studio is closing, so it did not start job ${runId}`);
    if (!recorded) {
      jobs.delete(runId);
      return fail(503, 'job.unrecorded', `The studio could not write ${RUN_STORE_FILE}, so it did not start the job: a job it cannot record could run twice`);
    }
    let child: SpawnedChild;
    try {
      child = opts.spawner(argv, { cwd: codeDir, env: modelEnv() });
    } catch (e) {
      // A start that never happened is finished, so its derived key cannot answer every later retry with a dead intent.
      job.phase = 'finished';
      job.lease = null;
      await persist();
      throw e;
    }
    job.phase = 'running';
    job.pid = child.pid ?? null;
    watch(job, child);
    await persist();
    return startAnswer(job, false);
  }

  async function generate(body: unknown, who: User, rawKey: RawKey): Promise<Reply> {
    if (!isObject(body)) return fail(400, 'generate.body', 'the body must be a JSON object');
    const kind = body['kind'];
    if (kind !== 'description' && kind !== 'openapi' && kind !== 'csv') {
      return fail(400, 'generate.kind', 'kind must be one of description, openapi or csv');
    }
    const slug = body['outSlug'];
    if (typeof slug !== 'string' || !KEBAB.test(slug)) {
      return fail(400, 'generate.slug', 'outSlug must be kebab-case: lowercase letters, digits and dashes, such as orders-demo');
    }
    const rawText = body['text'];
    if (rawText !== undefined && typeof rawText !== 'string') return fail(400, 'generate.text', 'text must be a string: the description, or the spec or csv path(s)');
    if (kind === 'description' && typeof rawText !== 'string') return fail(400, 'generate.text', 'a description needs text');
    const text = rawText ?? '';
    const budget = body['budgetUsd'];
    if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0)) {
      return fail(400, 'generate.budget', 'budgetUsd must be a positive number');
    }
    const minutes = body['maxMinutes'];
    if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0)) {
      return fail(400, 'generate.minutes', 'maxMinutes must be a positive integer');
    }
    const flags = [...(budget === undefined ? [] : ['--budget-usd', String(budget)]), ...(minutes === undefined ? [] : ['--max-minutes', String(minutes)])];
    // `default` keeps the old layout, so open mode and the token admin write where they always did.
    const outDir = path.join(writeRootOf(who.tenant), `gen-${slug}`);
    let args: string[];
    if (kind === 'description') {
      if (text.trim() === '') return fail(400, 'generate.text', 'a description needs text');
      args = [text, '--out', outDir, ...flags];
    } else if (kind === 'openapi') {
      const chosen = body['upload'];
      if (chosen !== undefined && (body['spec'] !== undefined || rawText !== undefined)) {
        return fail(400, 'generate.spec', 'give either an upload or a spec under eval/inputs, not both');
      }
      let spec: Awaited<ReturnType<typeof pathsOfSpec>>;
      if (chosen === undefined) {
        spec = await pathsOfSpec(typeof body['spec'] === 'string' ? body['spec'] : text);
      } else {
        if (typeof chosen !== 'string') return fail(400, 'generate.upload', 'upload must be an upload id, such as the id POST /api/uploads answered');
        const found = await uploadOf(who.tenant, chosen);
        if (found === null) return fail(400, 'generate.upload', `No upload ${chosen}`);
        if (found.kind !== 'openapi') return fail(400, 'generate.upload', `upload ${chosen} is a csv table, not an OpenAPI spec`);
        spec = await specOfUpload(found);
      }
      if (!spec.ok) return fail(400, 'generate.spec', spec.why);
      const only = body['only'] ?? [];
      if (!Array.isArray(only) || !only.every((o): o is string => typeof o === 'string' && o.startsWith('/'))) {
        return fail(400, 'generate.only', 'only must be a list of path prefixes that start with /, such as ["/pet"]');
      }
      const missing = only.filter((o) => !spec.paths.some((sp) => sp.startsWith(o)));
      if (missing.length > 0) return fail(400, 'generate.only', `no path in the spec starts with ${missing.join(', ')}; the spec has ${spec.paths.join(', ')}`);
      args = ['--openapi', spec.abs, ...(only.length === 0 ? [] : ['--only', only.join(',')]), '--out', outDir, ...flags];
    } else {
      const files = body['files'];
      const parts = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : text.split(/[\s,]+/).filter((s) => s !== '');
      const chosen = body['uploads'] ?? [];
      if (!Array.isArray(chosen) || !chosen.every((c): c is string => typeof c === 'string')) {
        return fail(400, 'generate.upload', 'uploads must be a list of upload ids, such as the ids POST /api/uploads answered');
      }
      const total = parts.length + chosen.length;
      if (total < 1 || total > MAX_CSV_FILES || (Array.isArray(files) && parts.length !== files.length)) {
        return fail(400, 'generate.files', `csv needs 1 to ${MAX_CSV_FILES} CSV files, under eval/inputs or uploaded`);
      }
      const csv: string[] = [];
      for (const part of parts) {
        const one = await underInputs(part);
        if (!one.ok) return fail(400, 'generate.files', one.why);
        if (!/\.csv$/i.test(one.path)) return fail(400, 'generate.files', `${part} is not a .csv file`);
        csv.push(one.path);
      }
      for (const id of chosen) {
        const found = await uploadOf(who.tenant, id);
        if (found === null) return fail(400, 'generate.upload', `No upload ${id}`);
        if (found.kind !== 'csv') return fail(400, 'generate.upload', `upload ${id} is an OpenAPI spec, not a csv table`);
        csv.push(found.file);
      }
      args = ['--csv', ...csv, '--out', outDir, ...flags];
    }
    await mkdir(path.dirname(outDir), { recursive: true });
    const runDir = path.join(outDir, 'runs');
    const knownRuns = new Set([
      ...await readdir(runDir).catch((): string[] => []),
      ...await readdir(path.join(`${outDir}${PARTIAL_SUFFIX}`, 'runs')).catch((): string[] => []),
    ]);
    const transport = opts.transport === undefined ? [] : ['--transport', opts.transport];
    const request = ['bun', 'src/cli/worldgen.ts', ...args];
    return startJob({ kind: 'generate', tenant: who.tenant, rawKey, request, label: slug, knownRuns, episode: undefined, launch: () => ({ outDir, argv: [...request, ...transport] }) });
  }

  /**
   * The events file of a run: `<out>/runs/<runId>/events.jsonl` when present, else the run dir
   * the child created after spawn (the worldgen CLI mints its own run id), newest first.
   */
  async function eventsFileOf(run: Job): Promise<string | null> {
    // A create run builds in `<out>.partial` and renames it to `<out>` only when done (A-293), so a running or stopped
    // run's events live under the .partial sibling.
    let best: { file: string; mtime: number } | null = null;
    for (const root of [run.outDir, `${run.outDir}${PARTIAL_SUFFIX}`]) {
      const literal = path.join(root, 'runs', run.runId, 'events.jsonl');
      if (await file(literal)) return literal;
      const runsRoot = path.join(root, 'runs');
      const names = await dirsOf(runsRoot);
      const fresh = names.filter((n) => !run.knownRuns.has(n));
      for (const name of fresh.length > 0 ? fresh : names) {
        const events = path.join(runsRoot, name, 'events.jsonl');
        const s = await stat(events).catch(() => null);
        if (s !== null && (best === null || s.mtimeMs > best.mtime)) best = { file: events, mtime: s.mtimeMs };
      }
    }
    return best === null ? null : best.file;
  }

  async function readEvents(run: Job): Promise<unknown[]> {
    const file = await eventsFileOf(run);
    if (file === null) return [];
    const text = await readFile(file, 'utf8').catch(() => '');
    const out: unknown[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a partial last line while the child is still writing
      }
    }
    return out;
  }

  function totalsOf(events: readonly unknown[]): { ms: number; costUsd: number } | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!isObject(e) || e['t'] !== 'run_finished') continue;
      const ms = e['ms'];
      const costUsd = e['costUsd'];
      if (typeof ms === 'number' && typeof costUsd === 'number') return { ms, costUsd };
      return null;
    }
    return null;
  }

  /**
   * What a run is doing, from its process and its own events (A-312): queued until it logs run_started, running until
   * run_finished, then done or stopped with the reason it logged. A process that exits without run_finished failed.
   */
  function stateOf(running: boolean, exitCode: number | null, all: readonly unknown[], output = '', recovery?: Recovery): { state: 'queued' | 'running' | 'done' | 'stopped' | 'failed' | 'interrupted'; reason?: string } {
    const events = all.filter(isObject);
    const finished = [...events].reverse().find((e) => e['t'] === 'run_finished');
    const result = finished !== undefined && isObject(finished['result']) ? finished['result'] : null;
    if (result !== null) {
      if (result['kind'] === 'done') return { state: 'done' };
      const reason = isObject(result['reason']) && typeof result['reason']['kind'] === 'string' ? result['reason']['kind'] : 'unknown';
      return { state: 'stopped', reason };
    }
    if (running) return { state: events.some((e) => e['t'] === 'run_started') ? 'running' : 'queued' };
    // The CLI says why on its last line (a missing key, a bad flag), so a failed run shows that, not just the exit code.
    if (recovery?.outcome === 'stopped') return { state: 'interrupted', reason: STOPPED_REASON[recovery.reason] };
    const said = output.trim().split('\n').pop()?.trim() ?? '';
    return { state: 'failed', reason: `the worldgen process exited ${exitCode ?? 'by a signal'} before it logged run_finished${said === '' ? '' : `: ${said}`}` };
  }

  async function runStatus(p: Params, who: User, filter: string | null): Promise<Reply> {
    const run = runOf(p['runId'] ?? '', who, filter);
    if (run === undefined) return fail(404, 'run.unknown', `No run ${p['runId'] ?? ''}`);
    const events = await readEvents(run);
    const running = run.phase !== 'finished';
    return {
      status: 200,
      body: {
        running,
        ...stateOf(running, run.exitCode, events, run.child?.output() ?? '', run.recovery),
        ...(running ? {} : { exitCode: run.exitCode }),
        events: events.slice(-EVENT_TAIL),
        totals: totalsOf(events),
        job: jobView(run),
      },
    };
  }

  async function stopRun(p: Params, who: User, filter: string | null): Promise<Reply> {
    const run = runOf(p['runId'] ?? '', who, filter);
    if (run === undefined) return fail(404, 'run.unknown', `No run ${p['runId'] ?? ''}`);
    if (run.phase === 'finished') return fail(409, 'run.finished', `Run ${run.runId} already finished`);
    if (run.child === null) return fail(409, 'run.unheld', `Run ${run.runId} has no process this studio watches; its lease is held by ${run.lease?.holder ?? 'no studio'}`);
    const gone = await signalAndWait(run.child, ['SIGINT', 'SIGTERM'], opts.runStopWaitMs ?? RUN_STOP_WAIT_MS);
    return { status: 200, body: { runId: run.runId, stopped: gone.exited, signal: gone.signal } };
  }

  /** The run history of every dir on the caller's shelves: the library's, which everyone sees, and its tenants'. */
  async function listRuns(who: User, filter: string | null): Promise<Reply> {
    const out: {
      name: string; tenant: string | null; runId: string; model: string | null; transport: string | null;
      costUsd: number | null; ms: number | null; outcome: 'done' | 'stopped' | null; hasReport: boolean;
    }[] = [];
    for (const shelf of shelvesOf(who, filter)) {
      for (const name of await dirsOn(shelf)) {
        const dir = path.join(shelf.root, name);
        const capsule = await readCapsule(dir);
        const hasReport = await file(path.join(dir, 'REPORT.md'));
        for (const runId of await dirsOf(path.join(dir, 'runs'))) {
          if (!await file(path.join(dir, 'runs', runId, 'events.jsonl'))) continue;
          const mine = capsule !== null && capsule.runId === runId;
          out.push({
            name,
            tenant: shelf.tenant,
            runId,
            model: mine ? capsule.model : null,
            transport: mine ? capsule.transport : null,
            costUsd: mine ? capsule.costUsd : null,
            ms: mine ? capsule.ms : null,
            outcome: mine ? (capsule.worldId !== null ? 'done' : 'stopped') : null,
            hasReport,
          });
        }
      }
    }
    return { status: 200, body: { runs: out } };
  }

  async function listEval(): Promise<Reply> {
    const list = await Promise.all((await dirsOf(evalRunsDir)).map(async (dir) => {
      const summary = await readFile(path.join(evalRunsDir, dir, 'summary.md'), 'utf8').catch(() => null);
      return { dir, summaryFirstLines: summary === null ? null : firstLines(summary) };
    }));
    return { status: 200, body: { runs: list } };
  }

  async function evalSummary(p: Params): Promise<Reply> {
    const dir = p['dir'] ?? '';
    if (!safeSegment(dir)) return fail(400, 'eval.name_unsafe', 'an eval run name must be one plain path segment');
    const summary = await readFile(path.join(evalRunsDir, dir, 'summary.md'), 'utf8').catch(() => null);
    if (summary === null) return fail(404, 'eval.unknown', `No summary.md for eval run ${dir}`);
    return { status: 200, body: { dir, summary } };
  }

  async function runCosts(): Promise<unknown> {
    const res = await runChild(['bun', 'src/cli/costs.ts', '--json', '--by', 'day'], { cwd: codeDir });
    if (res.code !== 0) {
      const why = res.stderr.split('\n').filter((l) => l.trim() !== '').slice(-1)[0] ?? res.stdout.split('\n').filter((l) => l.trim() !== '').slice(-1)[0] ?? 'no output';
      throw new Error(`costs exited ${res.code}: ${why}`);
    }
    return JSON.parse(res.stdout);
  }

  async function costs(): Promise<Reply> {
    if (costsCache !== null && Date.now() - costsCache.at <= COSTS_CACHE_MS) return { status: 200, body: costsCache.value };
    costsInFlight ??= runCosts().then((value) => {
      costsCache = { at: Date.now(), value };
      return value;
    }).finally(() => {
      costsInFlight = null;
    });
    try {
      return { status: 200, body: await costsInFlight };
    } catch (e) {
      return fail(502, 'costs.failed', e instanceof Error ? e.message : String(e));
    }
  }

  // ---- routing ----------------------------------------------------------------------------

  // ---------------------------------------------------------------- agent playground (YOS-190)

  let commit: string | null = null;
  /**
   * The commit of the code the studio runs, recorded on every episode as its engine. Read once, through the injected
   * runner. The Studio image has neither .git nor a git binary, so there the sha it was built from (`build`) names
   * it (YOS-236). A missing binary rejects the runner, and that counts as no commit too.
   */
  async function engineCommit(): Promise<string | null> {
    if (commit !== null) return commit;
    const isSha = (s: string | undefined): s is string => s !== undefined && /^[0-9a-f]{7,64}$/.test(s);
    const r = await runChild(['git', 'rev-parse', 'HEAD'], { cwd: codeDir }).catch(() => null);
    const sha = r === null ? '' : r.stdout.trim();
    const found = r !== null && r.code === 0 && isSha(sha) ? sha : isSha(opts.build) ? opts.build : null;
    if (found === null) return null;
    commit = found;
    return found;
  }

  /** The tasks of a world, public fields only: id, difficulty and the instruction an agent gets. Never a grader, solution or decoy. */
  async function worldTasks(p: Params, who: User, filter: string | null): Promise<Reply> {
    const w = await worldDirOf(p['name'] ?? '', who, filter);
    if (!w.ok) return w.reply;
    const loaded = await loadWorld(w.dir);
    if (!loaded.ok || !isObject(loaded.value) || !isObject(loaded.value['tasks'])) return fail(422, 'world.unloadable', `${p['name'] ?? ''} has no loadable tasks`);
    const tasks = Object.entries(loaded.value['tasks']).flatMap(([id, t]) => (isObject(t) && typeof t['instruction'] === 'string'
      ? [{ id, difficulty: typeof t['difficulty'] === 'string' ? t['difficulty'] : null, instruction: t['instruction'] }]
      : []));
    return { status: 200, body: { world: p['name'], tasks } };
  }

  // A proof runs inside the request through the runner and costs nothing, so it gets in-memory dedupe only: no lease,
  // no registry record. Requests with one key share one runner call while it runs, and a client key keeps its reply.
  // Both maps are keyed by tenant and key, so a key another tenant used is unused here, as it is for jobs.
  const proofsRunning = new Map<string, { readonly fingerprint: string; readonly reply: Promise<Reply> }>();
  const proofsDone = new Map<string, { readonly fingerprint: string; readonly reply: Reply }>();

  /** The engine's proof of every task: reference 1, doing nothing 0, every decoy and near miss below 1. `worldplay verify --json`, never a model. */
  async function worldProof(p: Params, who: User, ctx: Ctx): Promise<Reply> {
    const w = await worldDirOf(p['name'] ?? '', who, ctx.filter);
    if (!w.ok) return w.reply;
    const clientKey = idempotencyKeyOf(ctx.key);
    if (!clientKey.ok) return clientKey.reply;
    const fingerprint = fingerprintOf('proof', [w.dir]);
    const key = clientKey.key ?? `derived:${fingerprint}`;
    const slot = `${who.tenant} ${key}`;
    const known = proofsDone.get(slot) ?? proofsRunning.get(slot);
    if (known !== undefined) {
      if (known.fingerprint === fingerprint) return known.reply;
      return fail(422, 'idempotency.mismatch', `Idempotency-Key ${key} was used for a different request (the proof of another world)`);
    }
    const reply = proveWorld(w.dir, p['name'] ?? '');
    proofsRunning.set(slot, { fingerprint, reply });
    try {
      const done = await reply;
      if (clientKey.key !== undefined) {
        proofsDone.set(slot, { fingerprint, reply: done });
        for (const oldest of proofsDone.keys()) {
          if (proofsDone.size <= PROOF_REPLIES) break;
          proofsDone.delete(oldest);
        }
      }
      return done;
    } finally {
      proofsRunning.delete(slot);
    }
  }

  async function proveWorld(dir: string, name: string): Promise<Reply> {
    const res = await runChild(['bun', 'src/cli/worldplay.ts', 'verify', dir, '--json'], { cwd: codeDir, env: childEnv(), timeoutMs: checkTimeoutMs });
    const tasks: unknown[] = [];
    for (const line of res.stdout.split('\n')) {
      if (line.trim() === '') continue;
      try {
        tasks.push(JSON.parse(line));
      } catch {
        // a progress line that is not a proof row
      }
    }
    if (res.code !== 0 && tasks.length === 0) {
      const why = (res.stderr.trim() || res.stdout.trim() || 'no output').split('\n').slice(-1)[0];
      return fail(422, 'proof.failed', `verify exited ${res.code}: ${why}`);
    }
    return { status: 200, body: { world: name, verified: res.code === 0, tasks } };
  }

  /** Starts one agent episode as a child `episode` CLI. The studio never calls a model itself. */
  async function startEpisode(body: unknown, who: User, ctx: Ctx): Promise<Reply> {
    if (!isObject(body)) return fail(400, 'episode.body', 'body must be {"world": ..., "task": ..., "agent": "noop" | "sonnet"}');
    const world = typeof body['world'] === 'string' ? body['world'] : '';
    const w = await worldDirOf(world, who, ctx.filter);
    if (!w.ok) return w.reply;
    const task = body['task'];
    if (typeof task !== 'string' || !KEBAB.test(task.replace(/_/g, '-'))) return fail(400, 'episode.task', 'task must be a task id of the world');
    const agent = body['agent'] ?? 'noop';
    if (agent !== 'noop' && agent !== 'sonnet') return fail(400, 'episode.agent', 'agent must be noop or sonnet');
    const flags: string[] = [];
    for (const [key, flag] of [['maxTurns', '--max-turns'], ['budgetUsd', '--budget-usd'], ['maxMinutes', '--max-minutes']] as const) {
      const v = body[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return fail(400, 'episode.limits', `${key} must be a positive number`);
      flags.push(flag, String(v));
    }
    const sha = await engineCommit();
    if (sha === null) return fail(500, 'episode.commit', 'git rev-parse HEAD failed in the code directory and no build sha is set, so the episode would have no engine identity');
    return startJob({
      kind: 'episode',
      tenant: who.tenant,
      rawKey: ctx.key,
      request: ['bun', 'src/cli/episode.ts', '--world', w.dir, '--task', task, '--agent', agent, ...flags],
      label: agent,
      knownRuns: new Set(),
      episode: { world, task, agent },
      launch: (runId) => {
        const out = path.join(episodesDir, runId);
        return { outDir: out, argv: ['bun', 'src/cli/episode.ts', '--world', w.dir, '--task', task, '--out', out, '--run-id', runId, '--engine-commit', sha, '--agent', agent, ...flags] };
      },
    });
  }

  /** The episode a run exported and reopened, from its dataset.jsonl or failures.jsonl. The private evidence stays on disk. */
  async function exportedEpisode(out: string, runId: string): Promise<unknown> {
    for (const name of ['dataset.jsonl', 'failures.jsonl']) {
      const text = await readFile(path.join(out, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const e: unknown = JSON.parse(line);
          if (isObject(e) && e['run_id'] === runId) return e;
        } catch {
          // a partial last line while the child is still writing
        }
      }
    }
    return null;
  }

  /** An episode's tenant is its job's. An episode dir with no job record counts as `default`. */
  const episodeTenant = (runId: string): string => {
    const job = jobs.get(runId);
    return isEpisode(job) ? job.tenant : DEFAULT_TENANT;
  };

  async function episodeStatus(p: Params, who: User, filter: string | null): Promise<Reply> {
    const runId = p['runId'] ?? '';
    if (!safeSegment(runId)) return fail(400, 'episode.name_unsafe', 'an episode run id must be one plain path segment');
    const unknown = fail(404, 'episode.unknown', `No episode run ${runId}`);
    if (!visible(episodeTenant(runId), who, filter)) return unknown;
    const job = jobs.get(runId);
    const run = isEpisode(job) ? job : undefined;
    const out = run?.outDir ?? path.join(episodesDir, runId);
    if (run === undefined && !await isDir(out)) return unknown;
    const episode = await exportedEpisode(out, runId);
    const output = run?.child?.output() ?? '';
    const running = run !== undefined && run.phase !== 'finished';
    return {
      status: 200,
      body: {
        runId,
        ...(run === undefined ? {} : { ...run.episode, running, exitCode: run.exitCode, job: jobView(run) }),
        episode,
        ...(run !== undefined && !running && run.exitCode !== 0 ? { failure: output.split('\n').filter((l) => l.trim() !== '').slice(-3) } : {}),
      },
    };
  }

  /** The episode dirs under eval/episodes that `who` sees. */
  const episodeDirs = async (who: User, filter: string | null): Promise<string[]> => (await dirsOf(episodesDir)).filter((runId) => visible(episodeTenant(runId), who, filter));

  /** Every exported episode `who` sees, each parsed by the dataset schema. A run with no export yet is skipped. */
  async function allEpisodes(who: User, filter: string | null): Promise<{ episodes: Episode[]; unreadable: string[] }> {
    const episodesOut: Episode[] = [];
    const unreadable: string[] = [];
    for (const runId of await episodeDirs(who, filter)) {
      for (const name of ['dataset.jsonl', 'failures.jsonl']) {
        const text = await readFile(path.join(episodesDir, runId, name), 'utf8').catch(() => '');
        for (const [i, line] of text.split('\n').entries()) {
          if (line.trim() === '') continue;
          try {
            episodesOut.push(parseEpisode(JSON.parse(line), `${runId}/${name}:${i + 1}`));
          } catch {
            unreadable.push(`${runId}/${name}:${i + 1}`);
          }
        }
      }
    }
    return { episodes: episodesOut, unreadable };
  }

  /** Episodes compared by world, task and agent model: success rate, failure causes, cost per success, provenance. */
  async function episodeAnalytics(who: User, filter: string | null): Promise<Reply> {
    const { episodes: list, unreadable } = await allEpisodes(who, filter);
    return { status: 200, body: { episodes: list.length, groups: summarizeEpisodes(list), unreadable } };
  }

  async function listEpisodes(who: User, filter: string | null): Promise<Reply> {
    const ids = new Set([...(await episodeDirs(who, filter)), ...[...jobs.values()].filter(isEpisode).filter((j) => visible(j.tenant, who, filter)).map((j) => j.runId)]);
    const rows = await Promise.all([...ids].sort().reverse().map(async (runId) => {
      const job = jobs.get(runId);
      const run = isEpisode(job) ? job : undefined;
      const e = await exportedEpisode(run?.outDir ?? path.join(episodesDir, runId), runId);
      const ep = isObject(e) ? e : null;
      return {
        runId,
        running: run !== undefined && run.phase !== 'finished',
        task: ep?.['task_id'] ?? run?.episode.task ?? null,
        world: ep?.['world_id'] ?? run?.episode.world ?? null,
        stop: ep?.['stop_reason'] ?? null,
        score: ep?.['score'] ?? null,
        costUsd: isObject(ep?.['usage']) ? (ep['usage'] as Record<string, unknown>)['cost_usd'] ?? null : null,
      };
    }));
    return { status: 200, body: { episodes: rows } };
  }

  async function stopEpisode(p: Params, who: User, filter: string | null): Promise<Reply> {
    const run = jobs.get(p['runId'] ?? '');
    if (!isEpisode(run) || !visible(run.tenant, who, filter)) return fail(404, 'episode.unknown', `No running episode ${p['runId'] ?? ''}`);
    if (run.phase === 'finished') return fail(409, 'episode.finished', `Episode ${run.runId} already finished`);
    if (run.child === null) return fail(409, 'episode.unheld', `Episode ${run.runId} has no process this studio watches; its lease is held by ${run.lease?.holder ?? 'no studio'}`);
    const gone = await signalAndWait(run.child, ['SIGINT', 'SIGTERM']);
    return { status: 200, body: { runId: run.runId, stopped: gone.exited, signal: gone.signal } };
  }

  const routes: readonly Route[] = [
    { method: 'GET', need: 'public', parts: [], run: () => ({ status: 200, body: studioPage(), type: 'text/html; charset=utf-8' }) },
    { method: 'GET', need: 'public', parts: ['api', 'health'], run: () => health() },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds'], run: (_p, _b, who, ctx) => worlds(who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'report'], run: (p, _b, who, ctx) => worldReport(p, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'plan'], run: (p, _b, who, ctx) => worldPlan(p, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'export'], run: (p, _b, who, ctx) => worldExport(p, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'explorer'], run: (p, _b, who, ctx) => explorer(p, who, ctx.filter) },
    { method: 'POST', need: 'operator', parts: ['api', 'worlds', ':name', 'serve'], run: (p, b, who, ctx) => serveWorld(p, b, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'services'], run: (_p, _b, who, ctx) => ({ status: 200, body: { services: [...services.values()].filter((s) => visible(s.record.tenant, who, ctx.filter)).map((s) => s.record) } }) },
    { method: 'POST', need: 'operator', parts: ['api', 'services', ':id', 'stop'], run: (p, _b, who, ctx) => stopService(p, who, ctx.filter) },
    { method: 'POST', need: 'operator', parts: ['api', 'services', ':id', 'call'], run: (p, b, who, ctx) => callService(p, b, who, ctx.filter) },
    { method: 'POST', need: 'operator', parts: ['api', 'services', ':id', 'reset'], run: (p, b, who, ctx) => resetService(p, b, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'inputs'], run: () => inputs() },
    { method: 'GET', need: 'viewer', parts: ['api', 'inputs', ':spec', 'paths'], run: (p) => specPaths(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'uploads'], run: async (_p, _b, who) => ({ status: 200, body: { uploads: (await uploadsOf(who.tenant)).map(uploadView) } }) },
    { method: 'POST', need: 'operator', parts: ['api', 'uploads'], run: (_p, b, who) => upload(b, who), maxBody: MAX_UPLOAD_BODY_BYTES },
    { method: 'GET', need: 'viewer', parts: ['api', 'uploads', ':id', 'paths'], run: (p, _b, who) => uploadPaths(p, who) },
    { method: 'POST', need: 'operator', parts: ['api', 'generate'], run: (_p, b, who, ctx) => generate(b, who, ctx.key) },
    { method: 'GET', need: 'viewer', parts: ['api', 'generate', ':runId'], run: (p, _b, who, ctx) => runStatus(p, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'generate', ':runId', 'events'], run: (p, _b, who, ctx) => runStatus(p, who, ctx.filter) },
    { method: 'POST', need: 'operator', parts: ['api', 'generate', ':runId', 'stop'], run: (p, _b, who, ctx) => stopRun(p, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'runs'], run: (_p, _b, who, ctx) => listRuns(who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'eval'], run: () => listEval() },
    { method: 'GET', need: 'viewer', parts: ['api', 'eval', ':dir'], run: (p) => evalSummary(p) },
    { method: 'GET', need: 'admin', parts: ['api', 'costs'], run: () => costs() },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'tasks'], run: (p, _b, who, ctx) => worldTasks(p, who, ctx.filter) },
    { method: 'POST', need: 'operator', parts: ['api', 'worlds', ':name', 'proof'], run: (p, _b, who, ctx) => worldProof(p, who, ctx) },
    { method: 'GET', need: 'viewer', parts: ['api', 'episodes'], run: (_p, _b, who, ctx) => listEpisodes(who, ctx.filter) },
    { method: 'POST', need: 'operator', parts: ['api', 'episodes'], run: (_p, b, who, ctx) => startEpisode(b, who, ctx) },
    { method: 'GET', need: 'viewer', parts: ['api', 'episodes', 'analytics'], run: (_p, _b, who, ctx) => episodeAnalytics(who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'episodes', ':runId'], run: (p, _b, who, ctx) => episodeStatus(p, who, ctx.filter) },
    { method: 'POST', need: 'operator', parts: ['api', 'episodes', ':runId', 'stop'], run: (p, _b, who, ctx) => stopEpisode(p, who, ctx.filter) },
    { method: 'GET', need: 'viewer', parts: ['api', 'me'], run: (_p, _b, who) => ({ status: 200, body: { name: who.name, role: who.role, tenant: who.tenant, signIn } }) },
    { method: 'GET', need: 'admin', parts: ['api', 'audit'], run: (_p, _b, _w, ctx) => auditTail(ctx.filter) },
  ];
  const ROUTE_LIST = routes.map((r) => `${r.method} /${r.parts.filter((p) => !p.startsWith(':')).join('/')}`).join(', ');

  const match = (method: string, segments: readonly string[]): { route: Route; params: Params } | null => {
    for (const route of routes) {
      if (route.method !== method || route.parts.length !== segments.length) continue;
      const params: Params = {};
      let hit = true;
      for (const [i, part] of route.parts.entries()) {
        if (part === undefined) {
          hit = false;
          break;
        }
        const seg = segments[i] ?? '';
        if (ROUTE_PARAM.test(part)) params[part.slice(1)] = seg;
        else if (part !== seg) {
          hit = false;
          break;
        }
      }
      if (hit) return { route, params };
    }
    return null;
  };

  // Set once listen has resolved the real port.
  const ownHosts = new Set<string>();
  const ownOrigins = new Set<string>();

  const onStudio = async (req: IncomingMessage, who: Caller): Promise<Reply> => {
    const method = req.method ?? '';
    const rawHost = req.headers.host;
    let hostName: string | undefined;
    try {
      if (rawHost !== undefined) hostName = new URL(`http://${rawHost}`).host;
    } catch {
      // unparsable: refused below
    }
    if (hostName === undefined || !ownHosts.has(hostName)) {
      return fail(403, 'host.forbidden', `Host ${rawHost ?? '(none)'} is not this studio, which answers to ${[...ownHosts].join(', ')}. To reach it by another name, start it with --origin <url>`);
    }
    const origin = req.headers.origin;
    if (method === 'POST' && origin !== undefined && !ownOrigins.has(origin)) {
      return fail(403, 'origin.forbidden', `POST from ${origin} is refused: a POST must come from the studio page (${[...ownOrigins].join(', ')}) or from a client that sends no Origin`);
    }
    const segments = segmentsOf(req.url ?? '/');
    const hit = match(method, segments);
    if (hit === null) {
      const other = match(method === 'GET' ? 'POST' : 'GET', segments);
      if (other !== null) {
        return fail(405, 'method.not_allowed', `${method} /${segments.join('/')} is not allowed. Allowed: ${other.route.method}`);
      }
      const missing = `No studio route ${method} /${segments.join('/')}`;
      return fail(404, 'route.not_found', signIn ? missing : `${missing}. Studio routes: ${ROUTE_LIST}`);
    }
    const route = hit.route;
    if (route.need === 'public') return route.run();
    const client = req.socket.remoteAddress ?? 'unknown';
    const what = `${method} /${segments.join('/')}`;
    // A throttled client is refused whether its token is right or wrong, so a guesser learns nothing.
    // The cost is that a valid user on the same address waits too.
    if (who.kind !== 'anonymous') {
      const seconds = failedSignIns.wait(client);
      if (seconds > 0) return fail(429, 'auth.throttled', `Too many failed sign-ins from ${client}: wait ${seconds} s before the next bearer token is checked`, { 'retry-after': String(seconds) });
    }
    if (who.kind === 'anonymous') {
      return fail(401, 'auth.required', `${what} needs sign-in: send Authorization: Bearer <token>, or sign in on the page`, AUTH_CHALLENGE);
    }
    if (who.kind === 'rejected') {
      failedSignIns.draw(client);
      return fail(401, 'auth.invalid', `${what}: the bearer token matches no studio user; check it, or sign in again on the page`, AUTH_CHALLENGE);
    }
    if (roleRank(who.role) < roleRank(route.need)) {
      return fail(403, 'auth.forbidden', `${what} needs the ${route.need} role; ${who.name} is ${who.role === 'viewer' ? 'a' : 'an'} ${who.role}`);
    }
    if (method === 'POST') {
      const joined = route.parts.join('/');
      const key = `POST ${joined} ${client} ${who.tenant}`;
      const seconds = postBuckets.wait(key);
      if (seconds > 0) {
        return fail(429, 'studio.rate_limited', `Too many POST /${joined} requests from ${client}: the studio allows a burst of ${rateLimit.capacity}, refilled ${rateLimit.refillPerSecond} per second`, { 'retry-after': String(seconds) });
      }
      postBuckets.draw(key);
    }
    // An admin's ?tenant=, read only after sign-in and the throttle, so a malformed one cannot tell a guesser that a token
    // is an admin's. No other role narrows.
    const at = (req.url ?? '').indexOf('?');
    const filter = who.role === 'admin' ? new URLSearchParams(at < 0 ? '' : (req.url ?? '').slice(at + 1)).get('tenant') : null;
    if (filter !== null && !TENANT.test(filter)) return fail(400, 'tenant.invalid', `?tenant=${filter} is refused: ${TENANT_RULE}`);
    const body = route.method === 'POST' ? await readBody(req, route.maxBody ?? MAX_BODY_BYTES) : { ok: true as const, value: undefined };
    if (!body.ok) return fail(body.status, body.code, body.message);
    return route.run(hit.params, body.value, who, { key: req.headers['idempotency-key'], filter });
  };

  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let reply: Reply;
    const who = callerOf(req);
    try {
      reply = await onStudio(req, who);
    } catch (e) {
      if (e instanceof ConnectionClosed) {
        res.destroy();
        return;
      }
      reply = fail(500, 'studio.error', `Studio error: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Health polls would drown the traffic they report, so they are not counted.
    const segments = segmentsOf(req.url ?? '/');
    if (!(req.method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'health')) traffic.record(now(), reply.status);
    if (req.method === 'POST') {
      const error = isObject(reply.body) && isObject(reply.body['error']) ? reply.body['error']['code'] : undefined;
      await audit({
        at: new Date().toISOString(),
        user: who.kind === 'user' ? who.name : null,
        role: who.kind === 'user' ? who.role : null,
        tenant: who.kind === 'user' ? who.tenant : null,
        method: 'POST',
        path: (req.url ?? '/').split('?')[0],
        status: reply.status,
        ...(typeof error === 'string' ? { code: error } : {}),
      });
    }
    try {
      write(res, reply);
    } catch {
      res.destroy();
    }
  };

  const server: Server = createHttpServer((req, res) => {
    void answer(req, res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      const a = server.address();
      resolve(a !== null && typeof a === 'object' ? a.port : opts.port);
    });
  });

  const wildcard = host === '0.0.0.0' || host === '::';
  const names = wildcard ? [] : [host.includes(':') ? `[${host}]` : host];
  if (LOOPBACK_HOSTS.has(host) || wildcard) names.push('127.0.0.1', 'localhost');
  if (host === '::') names.push('[::1]');
  for (const name of names) {
    const own = new URL(`http://${name}:${port}`);
    ownHosts.add(own.host);
    ownOrigins.add(`http://${own.host}`);
  }
  if (configuredOrigin !== undefined) {
    ownHosts.add(new URL(configuredOrigin).host);
    ownOrigins.add(configuredOrigin);
  }

  const renewal = setInterval(() => void renew(), leaseMs / 3);
  renewal.unref?.();

  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    close() {
      closing ??= (async () => {
        closed = true;
        clearInterval(renewal);
        const unbound = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
        server.closeAllConnections();
        stopping.abort();
        // A generation run or an episode takes SIGTERM as its clean stop and bills its call on its own (A-279), so close
        // does not wait for it or SIGKILL it.
        for (const job of jobs.values()) if (job.phase !== 'finished') job.child?.kill('SIGTERM');
        await Promise.all([
          unbound,
          ...[...services.values()].map(({ child }) => child).concat([...startingChildren]).map((child) => signalAndWait(child, ['SIGTERM', 'SIGKILL'])),
          ...[...runnerCalls].map((call) => call.catch(() => undefined)),
        ]);
        // Writes queued before close land before close returns; none is queued after (#28).
        await persisting;
        await auditing;
      })();
      return closing;
    },
  };
}
