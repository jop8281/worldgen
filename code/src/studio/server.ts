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
 *   answers the world's real status and body, or the real failure.
 * - Children only. The studio never imports llm.ts and never makes a model call: generation and
 *   serving are spawned CLIs through an injected `Spawner`, and `costs` runs through an injected
 *   `Runner`. Generation and episodes get the operator's environment, so it carries every key, minus the
 *   studio's own sign-in token; a child that runs a world's snippets (check, proof, serve) gets only an
 *   allowlist (A-338, A-343). The studio stores and logs no key.
 * - No private task material. The worlds route counts tasks, it never returns task source. The
 *   report route serves REPORT.md and capsule.json and refuses a report that embeds any
 *   grader, solution or decoy source. test/studio.test.ts proves both with canaries.
 * - Sign-in (YOS-187). With users configured, every route but GET / and GET /api/health needs a bearer token whose
 *   sha256 matches a user; GETs need the viewer role, POSTs the operator role, GET /api/audit the admin role. The
 *   credential is a bearer header, never a cookie: a cookie ignores ports and would reach every served world on the
 *   host, whose call log records request headers. With no users the studio is open and must stay on loopback. Every
 *   POST is appended to <worldsDir>/.studio-audit.jsonl: who, what and the status, never a token or a body.
 * - The studio answers only to its own names. Every request's Host must be the bound address, a loopback name when
 *   bound to loopback or a wildcard, or the configured `origin`; a POST that carries an Origin needs one of the same.
 *   Open mode makes every request the local admin, so without this any page the operator visits could POST
 *   /api/generate (cross-site), and a DNS-rebinding page would reach the studio as same-origin. A request with no
 *   Origin (curl, scripts) passes the Origin check.
 * - Stops never leave zombies: SIGTERM, a short wait, SIGKILL, and the answer says which signal
 *   ended the child. A child that dies on its own removes its own record.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { Dirent } from 'node:fs';
import { appendFile, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadWorld } from '#engine';
import { CAPSULE_FILE, capsuleSchema, type RunCapsule } from '../worldgen/capsule.ts';
import type { RunResult, Runner, SpawnedChild, Spawner } from '../sandboxes/backend.ts';
import { parseEpisode, type Episode } from '../dataset/schema.ts';
import { summarizeEpisodes } from './analytics.ts';
import { adoptedChild, loadRuns, osProcesses, saveRuns, type Processes, type StoredRun } from './runstore.ts';
import { studioPage } from './page.ts';

/** Ordered: each role can do everything the roles before it can. */
export const STUDIO_ROLES = ['viewer', 'operator', 'admin'] as const;
export type StudioRole = (typeof STUDIO_ROLES)[number];
/** One signed-in person. Holds the sha256 hex of their token, never the token. */
export type StudioUser = { readonly name: string; readonly role: StudioRole; readonly tokenSha256: string };

/** The audit log of POST requests, in the worlds dir. */
export const AUDIT_FILE = '.studio-audit.jsonl';

const usersFileSchema = z.strictObject({
  users: z.array(z.strictObject({
    name: z.string().min(1),
    role: z.enum(STUDIO_ROLES),
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
  return parsed.data.users.map((u) => ({ name: u.name, role: u.role, tokenSha256: u.token_sha256 }));
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
  /** How long after Serve a refused API-console call is retried while the world starts listening. Default 10 s. */
  readonly startupGraceMs?: number | undefined;
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
};

export interface StudioServer {
  readonly url: string;
  readonly port: number;
  /** Drops the port and open connections, and SIGTERMs every tracked child so none outlives its record. */
  close(): Promise<void>;
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
/** How long a stop waits after a signal before it escalates, or answers not-stopped. */
const SIGNAL_WAIT_MS = 1_000;
/** How long a generation run gets after SIGINT to cancel its call, bill it and write REPORT.md before SIGTERM (A-279). */
const RUN_STOP_WAIT_MS = 30_000;
const STARTUP_GRACE_MS = 10_000;

/** A fetch that failed because nothing listened yet (Node: cause ECONNREFUSED; Bun: code ConnectionRefused). */
function refused(e: unknown): boolean {
  const code = (x: unknown): unknown => (typeof x === 'object' && x !== null ? (x as { code?: unknown }).code : undefined);
  const c = code(e) ?? code(typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined);
  return c === 'ECONNREFUSED' || c === 'ConnectionRefused';
}

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

/** Reads the whole body. Empty is undefined; anything else must be JSON. */
function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => setImmediate(() => {
      if (req.socket.destroyed || !req.socket.writable) {
        reject(new ConnectionClosed());
        return;
      }
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false, status: 413, code: 'body.too_large', message: `Request body is ${size} bytes; the most is ${MAX_BODY_BYTES}` });
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
  | { readonly kind: 'user'; readonly name: string; readonly role: StudioRole };

const roleRank = (role: StudioRole): number => STUDIO_ROLES.indexOf(role);
const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

function write(res: ServerResponse, reply: Reply): void {
  if (reply.type !== undefined) {
    res.writeHead(reply.status, {
      'content-type': reply.type,
      'content-length': typeof reply.body === 'string' ? Buffer.byteLength(reply.body) : reply.body.length,
      ...(reply.type === 'application/zip' ? { 'content-disposition': `attachment; filename="${reply.filename}"` } : {}),
    });
    res.end(reply.body);
    return;
  }
  const text = JSON.stringify(reply.body ?? null);
  res.writeHead(reply.status, { ...reply.headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** A port that was free a moment ago, from the OS. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, DEFAULT_HOST, () => {
      const a = probe.address();
      const port = a !== null && typeof a === 'object' ? a.port : 0;
      probe.close(() => resolve(port));
    });
  });
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
type Handler = (params: Params, body: unknown, who: Caller) => Promise<Reply> | Reply;
/** `need` is the least role that may call the route; a public route needs no sign-in. */
type Route = { readonly method: 'GET' | 'POST'; readonly need: StudioRole | 'public'; readonly parts: readonly string[]; readonly run: Handler };

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
    return { user: u, digest: Buffer.from(u.tokenSha256, 'hex') };
  });
  const seen = new Set<string>();
  for (const { user, digest } of digests) {
    for (const [what, key] of [['name', user.name], ['token', digest.toString('hex')]] as const) {
      if (seen.has(`${what} ${key}`)) throw new Error(`studio users share a ${what}: ${user.name}`);
      seen.add(`${what} ${key}`);
    }
  }
  /** Open mode makes every request the local admin; otherwise the bearer decides. Every digest is compared, in constant time. */
  const callerOf = (req: IncomingMessage): Caller => {
    if (!signIn) return { kind: 'user', name: 'local', role: 'admin' };
    const m = /^bearer +(.+)$/i.exec(req.headers.authorization ?? '');
    if (m === null) return { kind: 'anonymous' };
    const given = sha256(m[1]!.trim());
    let hit: StudioUser | null = null;
    for (const d of digests) if (timingSafeEqual(given, d.digest)) hit = d.user;
    return hit === null ? { kind: 'rejected' } : { kind: 'user', name: hit.name, role: hit.role };
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

  type ServiceRecord = { readonly id: string; readonly name: string; readonly pid: number | undefined; readonly worldPort: number; readonly adminPort: number; readonly startedAt: string };
  type RunRecord = { readonly runId: string; readonly outDir: string; readonly child: SpawnedChild; readonly knownRuns: ReadonlySet<string>; readonly startedAt: string; running: boolean; exitCode: number | null; interrupted: boolean };

  const services = new Map<string, { record: ServiceRecord; child: SpawnedChild }>();
  let serviceSeq = 0;
  const runs = new Map<string, RunRecord>();
  const processes = opts.processes ?? osProcesses;
  // One write at a time, in order, so the file on disk is always the latest whole registry.
  let persisting: Promise<void> = Promise.resolve();
  // Once close starts, the registry is final: a run still going is stored as unfinished, so a later studio
  // marks it interrupted (A-329) and nothing writes into the worlds dir after close resolves.
  let closed = false;
  const persist = (): Promise<void> => {
    if (closed) return persisting;
    const snapshot: StoredRun[] = [...runs.values()].map((r) => ({
      runId: r.runId, outDir: r.outDir, pid: r.child.pid ?? null, knownRuns: [...r.knownRuns], startedAt: r.startedAt,
      exitCode: r.exitCode, finished: !r.running,
    }));
    persisting = persisting.then(() => saveRuns(worldsDir, snapshot)).catch(() => undefined);
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
  async function auditTail(): Promise<Reply> {
    await auditing;
    const text = await readFile(auditPath, 'utf8').catch(() => '');
    const entries: unknown[] = [];
    for (const line of text.split('\n').filter((l) => l.trim() !== '').slice(-AUDIT_TAIL)) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // a damaged line is skipped, not fatal
      }
    }
    return { status: 200, body: { entries, unwritten } };
  }
  const track = (run: RunRecord): void => {
    runs.set(run.runId, run);
    void run.child.exited.then((code) => {
      run.running = false;
      run.exitCode = code;
      void persist();
    });
  };
  // Runs a previous studio left (A-329): a live process is adopted, so it can still be watched and stopped; a dead one
  // that never finished is interrupted, its <out>.partial evidence and REPORT kept (A-293); none is started again.
  for (const stored of await loadRuns(worldsDir)) {
    const base = { runId: stored.runId, outDir: stored.outDir, knownRuns: new Set(stored.knownRuns), startedAt: stored.startedAt };
    const done = { pid: stored.pid ?? undefined, exited: Promise.resolve(stored.exitCode), kill: () => false, output: () => '' };
    if (stored.finished) runs.set(stored.runId, { ...base, child: done, running: false, exitCode: stored.exitCode, interrupted: false });
    else if (stored.pid !== null && processes.alive(stored.pid)) track({ ...base, child: adoptedChild(stored.pid, processes), running: true, exitCode: null, interrupted: false });
    else runs.set(stored.runId, { ...base, child: done, running: false, exitCode: null, interrupted: true });
  }
  void persist();
  let costsCache: { at: number; value: unknown } | null = null;
  let costsInFlight: Promise<unknown> | null = null;

  // ---- handlers ---------------------------------------------------------------------------

  /** Readiness for a container or load balancer: the worlds directory reads, and the build and runtime are named. */
  async function health(): Promise<Reply> {
    const bun = process.versions['bun'];
    const runtime = bun === undefined ? `node ${process.versions.node}` : `bun ${bun}`;
    try {
      return { status: 200, body: { ok: true, build: opts.build ?? 'unknown', runtime, worlds: (await worldNames()).length } };
    } catch (e) {
      return fail(503, 'health.worlds_unreadable', `worlds directory ${worldsDir} cannot be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * World directories. A generation stopped before its plan leaves runs/ and REPORT.md with neither world.yaml nor
   * plan.yaml: that is a run, listed under /api/runs, not a world, so it is skipped here instead of reading as an
   * invalid hand-built world. A dir with plan.yaml and no world.yaml is still listed, as a generation that failed.
   */
  async function worldNames(): Promise<string[]> {
    const names: string[] = [];
    for (const name of await dirsOf(worldsDir)) {
      if (name.endsWith(PARTIAL_SUFFIX)) continue;
      const dir = path.join(worldsDir, name);
      if (await file(path.join(dir, 'world.yaml')) || await file(path.join(dir, 'plan.yaml'))) names.push(name);
    }
    return names;
  }

  async function worlds(): Promise<Reply> {
    const list = await Promise.all((await worldNames()).map(async (name) => {
      const dir = path.join(worldsDir, name);
      const capsule = await readCapsule(dir);
      const loaded = await loadWorld(dir);
      const base = {
        name,
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
  const childEnv = (): Record<string, string> => {
    const src = opts.env ?? process.env;
    return { TZ: 'UTC', PATH: src['PATH'] ?? '', ...(src['WORLDGEN_GUARD_SCALE'] === undefined ? {} : { WORLDGEN_GUARD_SCALE: src['WORLDGEN_GUARD_SCALE'] }) };
  };
  /** Generation and episodes call the model, so they get the whole environment, LLM_KEY included, but never the studio's own sign-in token. */
  const modelEnv = (): Record<string, string | undefined> => {
    const { WORLDGEN_STUDIO_TOKEN: _token, ...rest } = opts.env ?? process.env;
    return rest;
  };
  const checkTimeoutMs = opts.checkTimeoutMs ?? 300_000;
  const lastLine = (text: string): string => text.trim().split('\n').slice(-1)[0] ?? '';

  /** <name>.zip of the world's own files (EXPORT_FILES that exist), refused like the report when REPORT.md leaks task source. */
  async function worldExport(p: Params): Promise<Reply> {
    const name = p['name'] ?? '';
    if (!safeSegment(name)) return fail(400, 'world.name_unsafe', 'a world name must be one plain path segment');
    const dir = path.join(worldsDir, name);
    if (!await isDir(dir)) return fail(404, 'world.unknown', `No world ${name} under ${worldsDir}`);
    if (!await file(path.join(dir, 'world.yaml'))) return fail(404, 'export.no_world', `${name} has no world.yaml to export`);
    const checked = await worldReport(p);
    if (checked.status !== 200) return checked;
    const entries: { name: string; data: Buffer }[] = [];
    for (const f of EXPORT_FILES) {
      const data = await readFile(path.join(dir, f)).catch(() => null);
      if (data !== null) entries.push({ name: `${name}/${f}`, data });
    }
    return { status: 200, body: zipOf(entries), type: 'application/zip', filename: `${name}.zip` };
  }

  async function worldReport(p: Params): Promise<Reply> {
    const name = p['name'] ?? '';
    if (!safeSegment(name)) return fail(400, 'world.name_unsafe', 'a world name must be one plain path segment');
    const dir = path.join(worldsDir, name);
    if (!await isDir(dir)) return fail(404, 'world.unknown', `No world ${name} under ${worldsDir}`);
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

  async function explorer(p: Params): Promise<Reply> {
    const name = p['name'] ?? '';
    if (!safeSegment(name)) return fail(400, 'world.name_unsafe', 'a world name must be one plain path segment');
    const dir = path.join(worldsDir, name);
    if (!await isDir(dir)) return fail(404, 'world.unknown', `No world ${name} under ${worldsDir}`);
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
      res = await opts.runner(['bun', 'src/cli/studio-check.ts', dir, name], { cwd: codeDir, env: childEnv(), timeoutMs: checkTimeoutMs });
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
  async function callService(p: Params, body: unknown): Promise<Reply> {
    const hit = services.get(p['id'] ?? '');
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
    const send = (): Promise<Response> => fetch(url, {
      method, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    });
    let res: Response;
    try {
      res = await send();
    } catch (first) {
      // A world spawned a moment ago may not listen yet. A refused connection never delivered the request, so it is safe
      // to resend, POST included, until the world has had its startup grace to come up (A-278).
      let last: unknown = first;
      let got: Response | null = null;
      while (refused(last) && Date.now() - Date.parse(hit.record.startedAt) < (opts.startupGraceMs ?? STARTUP_GRACE_MS)) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          got = await send();
          break;
        } catch (e) {
          last = e;
        }
      }
      if (got === null) {
        return fail(502, 'call.unreachable', `world port ${hit.record.worldPort} of ${hit.record.name} did not answer ${method} ${url.pathname}${url.search}: ${last instanceof Error ? last.message : String(last)}`);
      }
      res = got;
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

  async function serveWorld(p: Params, body: unknown): Promise<Reply> {
    const name = p['name'] ?? '';
    if (!safeSegment(name)) return fail(400, 'world.name_unsafe', 'a world name must be one plain path segment');
    for (const { record } of services.values()) {
      if (record.name === name) return fail(409, 'world.already_serving', `${name} is already served on port ${record.worldPort}; stop it first`);
    }
    const dir = path.join(worldsDir, name);
    if (!await isDir(dir)) return fail(404, 'world.unknown', `No world ${name} under ${worldsDir}`);
    const wanted = isObject(body) ? body['port'] : undefined;
    let port: number;
    if (wanted === undefined) {
      port = await freePort();
    } else {
      if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1 || wanted > 65534) {
        return fail(400, 'serve.port', 'port must be an integer from 1 to 65534 (the admin routes take port + 1)');
      }
      port = wanted;
    }
    const child = opts.spawner(['bun', 'src/cli/worldplay.ts', 'serve', dir, '--port', String(port)], { cwd: codeDir, env: childEnv() });
    const id = `svc-${(serviceSeq += 1)}`;
    const record: ServiceRecord = { id, name, pid: child.pid, worldPort: port, adminPort: port + 1, startedAt: new Date().toISOString() };
    services.set(id, { record, child });
    void child.exited.then(() => {
      services.delete(id);
    });
    return { status: 200, body: record };
  }

  async function stopService(p: Params): Promise<Reply> {
    const hit = services.get(p['id'] ?? '');
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

  async function generate(body: unknown): Promise<Reply> {
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
    const outDir = path.join(worldsDir, `gen-${slug}`);
    let args: string[];
    if (kind === 'description') {
      if (text.trim() === '') return fail(400, 'generate.text', 'a description needs text');
      args = [text, '--out', outDir, ...flags];
    } else if (kind === 'openapi') {
      const spec = await pathsOfSpec(typeof body['spec'] === 'string' ? body['spec'] : text);
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
      if (parts.length < 1 || parts.length > MAX_CSV_FILES || (Array.isArray(files) && parts.length !== files.length)) {
        return fail(400, 'generate.files', `csv needs 1 to ${MAX_CSV_FILES} CSV files under eval/inputs`);
      }
      const csv: string[] = [];
      for (const part of parts) {
        const one = await underInputs(part);
        if (!one.ok) return fail(400, 'generate.files', one.why);
        if (!/\.csv$/i.test(one.path)) return fail(400, 'generate.files', `${part} is not a .csv file`);
        csv.push(one.path);
      }
      args = ['--csv', ...csv, '--out', outDir, ...flags];
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const runId = `${stamp}-${slug}`;
    const runDir = path.join(outDir, 'runs');
    const knownRuns = new Set([
      ...await readdir(runDir).catch((): string[] => []),
      ...await readdir(path.join(`${outDir}${PARTIAL_SUFFIX}`, 'runs')).catch((): string[] => []),
    ]);
    const transport = opts.transport === undefined ? [] : ['--transport', opts.transport];
    const child = opts.spawner(['bun', 'src/cli/worldgen.ts', ...args, ...transport], { cwd: codeDir, env: modelEnv() });
    track({ runId, outDir, child, knownRuns, startedAt: new Date().toISOString(), running: true, exitCode: null, interrupted: false });
    await persist();
    return { status: 200, body: { runId, outDir, running: true } };
  }

  /**
   * The events file of a run: `<out>/runs/<runId>/events.jsonl` when present, else the run dir
   * the child created after spawn (the worldgen CLI mints its own run id), newest first.
   */
  async function eventsFileOf(run: RunRecord): Promise<string | null> {
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

  async function readEvents(run: RunRecord): Promise<unknown[]> {
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
  function stateOf(running: boolean, exitCode: number | null, all: readonly unknown[], output = '', interrupted = false): { state: 'queued' | 'running' | 'done' | 'stopped' | 'failed' | 'interrupted'; reason?: string } {
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
    if (interrupted) return { state: 'interrupted', reason: 'the studio restarted while this run was running and its process is gone; its evidence stays in the <out>.partial directory' };
    const said = output.trim().split('\n').pop()?.trim() ?? '';
    return { state: 'failed', reason: `the worldgen process exited ${exitCode ?? 'by a signal'} before it logged run_finished${said === '' ? '' : `: ${said}`}` };
  }

  async function runStatus(p: Params): Promise<Reply> {
    const run = runs.get(p['runId'] ?? '');
    if (run === undefined) return fail(404, 'run.unknown', `No run ${p['runId'] ?? ''}`);
    const events = await readEvents(run);
    return {
      status: 200,
      body: {
        running: run.running,
        ...stateOf(run.running, run.exitCode, events, run.child.output(), run.interrupted),
        ...(run.running ? {} : { exitCode: run.exitCode }),
        events: events.slice(-EVENT_TAIL),
        totals: totalsOf(events),
      },
    };
  }

  async function stopRun(p: Params): Promise<Reply> {
    const run = runs.get(p['runId'] ?? '');
    if (run === undefined) return fail(404, 'run.unknown', `No run ${p['runId'] ?? ''}`);
    if (!run.running) return fail(409, 'run.finished', `Run ${run.runId} already finished`);
    const gone = await signalAndWait(run.child, ['SIGINT', 'SIGTERM'], opts.runStopWaitMs ?? RUN_STOP_WAIT_MS);
    return { status: 200, body: { runId: run.runId, stopped: gone.exited, signal: gone.signal } };
  }

  async function listRuns(): Promise<Reply> {
    const out: {
      name: string; runId: string; model: string | null; transport: string | null;
      costUsd: number | null; ms: number | null; outcome: 'done' | 'stopped' | null; hasReport: boolean;
    }[] = [];
    for (const name of await dirsOf(worldsDir)) {
      const dir = path.join(worldsDir, name);
      const capsule = await readCapsule(dir);
      const hasReport = await file(path.join(dir, 'REPORT.md'));
      for (const runId of await dirsOf(path.join(dir, 'runs'))) {
        if (!await file(path.join(dir, 'runs', runId, 'events.jsonl'))) continue;
        const mine = capsule !== null && capsule.runId === runId;
        out.push({
          name,
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
    const res = await opts.runner(['bun', 'src/cli/costs.ts', '--json', '--by', 'day'], { cwd: codeDir });
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

  type EpisodeRun = { readonly runId: string; readonly world: string; readonly task: string; readonly agent: string; readonly out: string; readonly child: SpawnedChild; running: boolean; exitCode: number | null };
  const episodes = new Map<string, EpisodeRun>();
  let episodeSeq = 0;
  let commit: string | null = null;
  /** The commit of the code the studio runs, recorded on every episode as its engine. Read once, through the injected runner. */
  async function engineCommit(): Promise<string | null> {
    if (commit !== null) return commit;
    const r = await opts.runner(['git', 'rev-parse', 'HEAD'], { cwd: codeDir });
    const sha = r.stdout.trim();
    if (r.code !== 0 || !/^[0-9a-f]{7,64}$/.test(sha)) return null;
    commit = sha;
    return sha;
  }

  /** A world dir by its route name, or the reply that refuses it. */
  async function worldDirOf(name: string): Promise<{ ok: true; dir: string } | { ok: false; reply: Reply }> {
    if (!safeSegment(name)) return { ok: false, reply: fail(400, 'world.name_unsafe', 'a world name must be one plain path segment') };
    const dir = path.join(worldsDir, name);
    if (!await isDir(dir)) return { ok: false, reply: fail(404, 'world.unknown', `No world ${name} under ${worldsDir}`) };
    return { ok: true, dir };
  }

  /** The tasks of a world, public fields only: id, difficulty and the instruction an agent gets. Never a grader, solution or decoy. */
  async function worldTasks(p: Params): Promise<Reply> {
    const w = await worldDirOf(p['name'] ?? '');
    if (!w.ok) return w.reply;
    const loaded = await loadWorld(w.dir);
    if (!loaded.ok || !isObject(loaded.value) || !isObject(loaded.value['tasks'])) return fail(422, 'world.unloadable', `${p['name'] ?? ''} has no loadable tasks`);
    const tasks = Object.entries(loaded.value['tasks']).flatMap(([id, t]) => (isObject(t) && typeof t['instruction'] === 'string'
      ? [{ id, difficulty: typeof t['difficulty'] === 'string' ? t['difficulty'] : null, instruction: t['instruction'] }]
      : []));
    return { status: 200, body: { world: p['name'], tasks } };
  }

  /** The engine's proof of every task: reference 1, doing nothing 0, every decoy and near miss below 1. `worldplay verify --json`, never a model. */
  async function worldProof(p: Params): Promise<Reply> {
    const w = await worldDirOf(p['name'] ?? '');
    if (!w.ok) return w.reply;
    const res = await opts.runner(['bun', 'src/cli/worldplay.ts', 'verify', w.dir, '--json'], { cwd: codeDir, env: childEnv(), timeoutMs: checkTimeoutMs });
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
    return { status: 200, body: { world: p['name'], verified: res.code === 0, tasks } };
  }

  /** Starts one agent episode as a child `episode` CLI. The studio never calls a model itself. */
  async function startEpisode(body: unknown): Promise<Reply> {
    if (!isObject(body)) return fail(400, 'episode.body', 'body must be {"world": ..., "task": ..., "agent": "noop" | "sonnet"}');
    const world = typeof body['world'] === 'string' ? body['world'] : '';
    const w = await worldDirOf(world);
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
    if (sha === null) return fail(500, 'episode.commit', 'git rev-parse HEAD failed in the code directory, so the episode would have no engine identity');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const runId = `${stamp}-${agent}-${++episodeSeq}`;
    const out = path.join(episodesDir, runId);
    const child = opts.spawner(['bun', 'src/cli/episode.ts', '--world', w.dir, '--task', task, '--out', out, '--run-id', runId, '--engine-commit', sha, '--agent', agent, ...flags], { cwd: codeDir, env: modelEnv() });
    const run: EpisodeRun = { runId, world, task, agent, out, child, running: true, exitCode: null };
    episodes.set(runId, run);
    void child.exited.then((code) => {
      run.running = false;
      run.exitCode = code;
    });
    return { status: 200, body: { runId, world, task, agent, running: true } };
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

  async function episodeStatus(p: Params): Promise<Reply> {
    const runId = p['runId'] ?? '';
    if (!safeSegment(runId)) return fail(400, 'episode.name_unsafe', 'an episode run id must be one plain path segment');
    const run = episodes.get(runId);
    const out = run?.out ?? path.join(episodesDir, runId);
    if (run === undefined && !await isDir(out)) return fail(404, 'episode.unknown', `No episode run ${runId}`);
    const episode = await exportedEpisode(out, runId);
    const output = run?.child.output() ?? '';
    return {
      status: 200,
      body: {
        runId,
        ...(run === undefined ? {} : { world: run.world, task: run.task, agent: run.agent, running: run.running, exitCode: run.exitCode }),
        episode,
        ...(run !== undefined && !run.running && run.exitCode !== 0 ? { failure: output.split('\n').filter((l) => l.trim() !== '').slice(-3) } : {}),
      },
    };
  }

  /** Every exported episode under eval/episodes, each parsed by the dataset schema. A run with no export yet is skipped. */
  async function allEpisodes(): Promise<{ episodes: Episode[]; unreadable: string[] }> {
    const episodesOut: Episode[] = [];
    const unreadable: string[] = [];
    for (const runId of await dirsOf(episodesDir)) {
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
  async function episodeAnalytics(): Promise<Reply> {
    const { episodes: list, unreadable } = await allEpisodes();
    return { status: 200, body: { episodes: list.length, groups: summarizeEpisodes(list), unreadable } };
  }

  async function listEpisodes(): Promise<Reply> {
    const ids = new Set([...(await dirsOf(episodesDir)), ...episodes.keys()]);
    const rows = await Promise.all([...ids].sort().reverse().map(async (runId) => {
      const run = episodes.get(runId);
      const e = await exportedEpisode(run?.out ?? path.join(episodesDir, runId), runId);
      const ep = isObject(e) ? e : null;
      return {
        runId,
        running: run?.running ?? false,
        task: ep?.['task_id'] ?? run?.task ?? null,
        world: ep?.['world_id'] ?? run?.world ?? null,
        stop: ep?.['stop_reason'] ?? null,
        score: ep?.['score'] ?? null,
        costUsd: isObject(ep?.['usage']) ? (ep['usage'] as Record<string, unknown>)['cost_usd'] ?? null : null,
      };
    }));
    return { status: 200, body: { episodes: rows } };
  }

  async function stopEpisode(p: Params): Promise<Reply> {
    const run = episodes.get(p['runId'] ?? '');
    if (run === undefined) return fail(404, 'episode.unknown', `No running episode ${p['runId'] ?? ''}`);
    if (!run.running) return fail(409, 'episode.finished', `Episode ${run.runId} already finished`);
    const gone = await signalAndWait(run.child, ['SIGINT', 'SIGTERM']);
    return { status: 200, body: { runId: run.runId, stopped: gone.exited, signal: gone.signal } };
  }

  const routes: readonly Route[] = [
    { method: 'GET', need: 'public', parts: [], run: () => ({ status: 200, body: studioPage(), type: 'text/html; charset=utf-8' }) },
    { method: 'GET', need: 'public', parts: ['api', 'health'], run: () => health() },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds'], run: () => worlds() },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'report'], run: (p) => worldReport(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'export'], run: (p) => worldExport(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'explorer'], run: (p) => explorer(p) },
    { method: 'POST', need: 'operator', parts: ['api', 'worlds', ':name', 'serve'], run: (p, b) => serveWorld(p, b) },
    { method: 'GET', need: 'viewer', parts: ['api', 'services'], run: () => ({ status: 200, body: { services: [...services.values()].map((s) => s.record) } }) },
    { method: 'POST', need: 'operator', parts: ['api', 'services', ':id', 'stop'], run: (p) => stopService(p) },
    { method: 'POST', need: 'operator', parts: ['api', 'services', ':id', 'call'], run: (p, b) => callService(p, b) },
    { method: 'GET', need: 'viewer', parts: ['api', 'inputs'], run: () => inputs() },
    { method: 'GET', need: 'viewer', parts: ['api', 'inputs', ':spec', 'paths'], run: (p) => specPaths(p) },
    { method: 'POST', need: 'operator', parts: ['api', 'generate'], run: (_p, b) => generate(b) },
    { method: 'GET', need: 'viewer', parts: ['api', 'generate', ':runId'], run: (p) => runStatus(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'generate', ':runId', 'events'], run: (p) => runStatus(p) },
    { method: 'POST', need: 'operator', parts: ['api', 'generate', ':runId', 'stop'], run: (p) => stopRun(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'runs'], run: () => listRuns() },
    { method: 'GET', need: 'viewer', parts: ['api', 'eval'], run: () => listEval() },
    { method: 'GET', need: 'viewer', parts: ['api', 'eval', ':dir'], run: (p) => evalSummary(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'costs'], run: () => costs() },
    { method: 'GET', need: 'viewer', parts: ['api', 'worlds', ':name', 'tasks'], run: (p) => worldTasks(p) },
    { method: 'POST', need: 'operator', parts: ['api', 'worlds', ':name', 'proof'], run: (p) => worldProof(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'episodes'], run: () => listEpisodes() },
    { method: 'POST', need: 'operator', parts: ['api', 'episodes'], run: (_p, b) => startEpisode(b) },
    { method: 'GET', need: 'viewer', parts: ['api', 'episodes', 'analytics'], run: () => episodeAnalytics() },
    { method: 'GET', need: 'viewer', parts: ['api', 'episodes', ':runId'], run: (p) => episodeStatus(p) },
    { method: 'POST', need: 'operator', parts: ['api', 'episodes', ':runId', 'stop'], run: (p) => stopEpisode(p) },
    { method: 'GET', need: 'viewer', parts: ['api', 'me'], run: (_p, _b, who) => ({ status: 200, body: { name: who.kind === 'user' ? who.name : null, role: who.kind === 'user' ? who.role : null, signIn } }) },
    { method: 'GET', need: 'admin', parts: ['api', 'audit'], run: () => auditTail() },
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
    const need = hit.route.need;
    if (need !== 'public') {
      const what = `${method} /${segments.join('/')}`;
      if (who.kind === 'anonymous') {
        return fail(401, 'auth.required', `${what} needs sign-in: send Authorization: Bearer <token>, or sign in on the page`, AUTH_CHALLENGE);
      }
      if (who.kind === 'rejected') {
        return fail(401, 'auth.invalid', `${what}: the bearer token matches no studio user; check it, or sign in again on the page`, AUTH_CHALLENGE);
      }
      if (roleRank(who.role) < roleRank(need)) {
        return fail(403, 'auth.forbidden', `${what} needs the ${need} role; ${who.name} is ${who.role === 'viewer' ? 'a' : 'an'} ${who.role}`);
      }
    }
    const body = hit.route.method === 'POST' ? await readBody(req) : { ok: true as const, value: undefined };
    if (!body.ok) return fail(body.status, body.code, body.message);
    return hit.route.run(hit.params, body.value, who);
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
    if (req.method === 'POST') {
      const error = isObject(reply.body) && isObject(reply.body['error']) ? reply.body['error']['code'] : undefined;
      await audit({
        at: new Date().toISOString(),
        user: who.kind === 'user' ? who.name : null,
        role: who.kind === 'user' ? who.role : null,
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

  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    close() {
      closing ??= (async () => {
        closed = true;
        for (const { child } of services.values()) child.kill('SIGTERM');
        for (const { child } of runs.values()) child.kill('SIGTERM');
        for (const { child } of episodes.values()) child.kill('SIGTERM');
        if (server.listening) {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
        }
        await persisting;
        await auditing;
      })();
      return closing;
    },
  };
}
