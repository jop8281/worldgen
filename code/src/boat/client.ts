/**
 * The boat.dev adapter. The only importer of `@boatdev/sdk`.
 *
 * Everything else talks to boat.dev through the narrow `BoatClient` interface, so tests pass
 * a fake and `npm test` never reaches the network. The key comes from `BOAT_API_KEY` only and
 * is scrubbed from every error this module raises.
 */
import { BoatApi, Configuration, FetchError, ResponseError, SandboxAccessEnum, SandboxStateEnum, SandboxTypeEnum } from '@boatdev/sdk';
import { z } from 'zod';

/** boat.dev machine types. small is 2 vCPU and 4 GB, default 4 and 8, large 8 and 16. */
export type BoatType = 'small' | 'default' | 'large';

export type CreateOptions = {
  readonly idempotencyKey?: string;
  readonly type?: BoatType;
  readonly ttlSeconds: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly setupScript?: string;
};

export type ExecOptions = {
  readonly cwd?: string;
  /** boat.dev accepts 1 to 600. */
  readonly timeoutSeconds?: number;
};

export type ExecResult = {
  /** null when the process was killed by a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type FileWrite = {
  /** Absolute path inside the sandbox. */
  readonly path: string;
  readonly content: string;
  readonly encoding: 'base64' | 'utf8';
};

/** The boat.dev calls WorldGen needs. Every method throws `BoatError` on failure. */
export interface BoatClient {
  create(opts: CreateOptions): Promise<{ readonly sandboxId: string; readonly startedAt?: number }>;
  /** Resolves once the sandbox is ready, idle or running. */
  waitReady(sandboxId: string): Promise<void>;
  /** Runs a command to completion. */
  exec(sandboxId: string, command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Starts a command detached and returns at once. */
  start(sandboxId: string, command: string, opts?: { readonly cwd?: string }): Promise<{ readonly processId: number }>;
  writeFile(sandboxId: string, file: FileWrite): Promise<void>;
  /** Maps `port` to a URL. `isPublic` false keeps it behind the account's key. */
  expose(sandboxId: string, port: number, isPublic: boolean): Promise<{ readonly url: string }>;
  /** Asks the sandbox to stop and keeps its snapshots. An already removed sandbox is a no-op. */
  stop(sandboxId: string): Promise<void>;
  /** Resolves once the sandbox is archived (or was removed), so cleanup is verified, not assumed. */
  waitStopped(sandboxId: string): Promise<void>;
}

const inventorySandboxSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), state: z.enum(SandboxStateEnum),
  type: z.enum(SandboxTypeEnum).nullable().optional(),
  access: z.enum(SandboxAccessEnum).optional().transform(v => v ?? 'unknown'),
  createdAt: z.date().nullable().optional().transform(v => v?.toISOString() ?? null),
  team: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/) }).nullable()
    .transform(v => v === null ? undefined : { id: v.id }).optional(),
});
const inventoryPageSchema = z.object({
  ok: z.literal(true), type: z.literal('sandbox.list'),
  sandboxes: z.array(inventorySandboxSchema),
  pageInfo: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean(), limit: z.int().positive() }),
});
const usageSchema = z.object({
  ok: z.literal(true), type: z.literal('sandbox.usage'),
  sandboxId: z.string().min(1), sandboxType: z.enum(SandboxTypeEnum),
  billingMultiplier: z.number().finite().nonnegative(),
  since: z.date().transform(v => v.toISOString()), until: z.date().transform(v => v.toISOString()),
  seconds: z.number().finite().nonnegative(), dollars: z.number().finite().nonnegative(),
  secondsPerDollar: z.number().finite().positive(), running: z.boolean(),
}).refine(v => v.since <= v.until, { message: 'usage window is reversed' })
  .refine(v => Math.abs(v.dollars - v.seconds / v.secondsPerDollar) <= 0.000001, { message: 'usage list price is inconsistent' })
  .transform(({ ok, type, ...usage }) => usage);
export type BoatInventorySandbox = z.output<typeof inventorySandboxSchema>;
export type BoatUsage = z.output<typeof usageSchema>;
const usageWindowSchema = z.object({ since: z.iso.datetime(), until: z.iso.datetime() })
  .refine(v => Date.parse(v.since) < Date.parse(v.until));
export type BoatUsageWindow = z.output<typeof usageWindowSchema>;

/** One UTC calendar day, used to request bounded provider usage rather than a lifetime total. */
export function boatUsageWindow(day: string): BoatUsageWindow {
  if (!z.iso.date().safeParse(day).success) throw new BoatError('usage day must be a valid UTC date (YYYY-MM-DD)');
  const since = `${day}T00:00:00.000Z`;
  const until = new Date(Date.parse(since) + 86400000).toISOString();
  const window = usageWindowSchema.safeParse({ since, until });
  if (!window.success) throw new BoatError('usage day must fit a complete ISO UTC day');
  return window.data;
}

export interface BoatInspection {
  inventory(org?: string): Promise<readonly BoatInventorySandbox[]>;
  usage(sandboxId: string, window?: BoatUsageWindow): Promise<BoatUsage>;
}

export class BoatError extends Error {
  override readonly name = 'BoatError';
  /** The HTTP status boat.dev answered with, when it answered. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export const MISSING_KEY = 'BOAT_API_KEY is not set: create a key at https://boat.dev/dashboard?tab=api-keys and export it';
export const DEFAULT_BASE_URL = 'https://boat.dev/api/v1';
/** User decision A-247: one Boat organization (wallet) per machine, named here. */
export const ORG_ENV = 'WORLDGEN_BOAT_ORG';
export const MISSING_ORG = `${ORG_ENV} is not set: Boat provisioning needs the one organization (wallet) this machine bills to, such as the id in https://boat.dev/dashboard (A-247)`;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The HTTP transport seam. Defaults to the global fetch. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type BoatClientOptions = {
  readonly apiKey: string;
  /** The pinned organization (wallet): sent as X-Boat-Org on every request and as `org` on create and inventory. Create refuses without it. */
  readonly org?: string | undefined;
  readonly basePath?: string;
  readonly fetch?: FetchFn;
  /** Delay between readiness polls. Default 2000. */
  readonly pollMs?: number;
  /** waitReady gives up after sleeping this long. Default 300000. */
  readonly readyTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const READY = new Set(['ready', 'idle', 'running']);
const TERMINAL = new Set(['error', 'archived', 'archiving', 'cancelled']);
/** A stopped sandbox is archived. `cancelled` was removed, so there is nothing left to bill. */
const STOPPED = new Set(['archived', 'cancelled']);
const BODY_EXCERPT = 300;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Env = Readonly<Record<string, string | undefined>>;

/** `BOAT_API_KEY` from the process environment, never from a file. Throws `BoatError(MISSING_KEY)` without one. */
/** `WORLDGEN_BOAT_ORG`, or undefined when unset. Throws a BoatError naming the variable when it is malformed. */
export function boatOrg(env: Env): string | undefined {
  const org = env[ORG_ENV]?.trim() ?? '';
  if (org === '') return undefined;
  if (!ORG_RE.test(org)) throw new BoatError(`${ORG_ENV} must be a Boat organization id (letters, digits, dot, underscore or hyphen), got ${JSON.stringify(org)}`);
  return org;
}

export function boatKey(env: Env): string {
  const apiKey = env['BOAT_API_KEY']?.trim() ?? '';
  if (apiKey === '') throw new BoatError(MISSING_KEY);
  return apiKey;
}

/** Reads `BOAT_API_KEY` and optional `BOAT_BASE_URL`. Throws `BoatError(MISSING_KEY)` without a key. */
export function boatClientFromEnv(env: Env = process.env, seams: Omit<BoatClientOptions, 'apiKey' | 'basePath'> = {}): BoatClient & BoatInspection {
  const apiKey = boatKey(env);
  const base = env['BOAT_BASE_URL']?.trim() ?? '';
  const org = boatOrg(env);
  return boatClient({ ...seams, apiKey, basePath: base === '' ? DEFAULT_BASE_URL : base, ...(org === undefined ? {} : { org }) });
}

export function boatClient(opts: BoatClientOptions): BoatClient & BoatInspection {
  const { apiKey } = opts;
  if (apiKey.trim() === '') throw new BoatError(MISSING_KEY);
  const api = new BoatApi(new Configuration({
    basePath: opts.basePath ?? DEFAULT_BASE_URL,
    accessToken: apiKey,
    ...(opts.fetch === undefined ? {} : { fetchApi: opts.fetch }),
    ...(opts.org === undefined ? {} : { headers: { 'X-Boat-Org': opts.org } }),
  }));
  const pollMs = opts.pollMs ?? 2000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 300_000;
  const sleep = opts.sleep ?? defaultSleep;
  const scrub = (s: string): string => s.split(apiKey).join('[redacted]');
  const fail = (message: string, status?: number): BoatError => new BoatError(scrub(message), status);

  async function call<T>(op: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      throw fail(`boat.dev ${op} failed: ${await explain(e)}`, e instanceof ResponseError ? e.response.status : undefined);
    }
  }

  /** The sandbox's state. A sandbox boat.dev already removed answers 404, which reads as cancelled. */
  async function stateOf(sandboxId: string): Promise<string> {
    return call('get', async () => {
      try {
        return (await api.get({ sandboxId })).sandbox.state;
      } catch (e) {
        if (e instanceof ResponseError && e.response.status === 404) return 'cancelled';
        throw e;
      }
    });
  }

  const inspect = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (err) { throw fail(`boat.dev ${op} failed${err instanceof ResponseError ? ` (HTTP ${err.response.status})` : ''}`); }
  };

  return {
    async inventory(org) {
      const rows = new Map<string, BoatInventorySandbox>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const scope = org ?? opts.org;
        const raw = await inspect('inventory', () => api.sandboxes({ limit: 200, ...(scope === undefined ? {} : { org: scope }), ...(cursor === undefined ? {} : { cursor }) }));
        const page = inventoryPageSchema.safeParse(raw);
        if (!page.success) throw fail('boat.dev inventory returned invalid or incomplete pagination metadata');
        for (const row of page.data.sandboxes) rows.set(row.id, row);
        if (!page.data.pageInfo.hasMore) {
          if (page.data.pageInfo.nextCursor !== null) throw fail('boat.dev inventory returned conflicting pagination metadata');
          return [...rows.values()];
        }
        const next = page.data.pageInfo.nextCursor;
        if (next === null || next === '' || cursors.has(next)) throw fail('boat.dev inventory did not advance its pagination cursor');
        cursors.add(next);
        cursor = next;
      }
    },

    async usage(sandboxId, window) {
      const parsed = window === undefined ? undefined : usageWindowSchema.safeParse(window);
      if (parsed !== undefined && !parsed.success) throw fail('boat.dev usage needs a valid increasing UTC window');
      const bounds = parsed?.data;
      const raw = await inspect('usage', () => api.usage({ sandboxId, ...bounds }));
      const usage = usageSchema.safeParse(raw);
      if (!usage.success || usage.data.sandboxId !== sandboxId) throw fail('boat.dev usage returned invalid or mismatched receipt');
      if (bounds !== undefined && (Date.parse(usage.data.since) < Date.parse(bounds.since) || Date.parse(usage.data.until) > Date.parse(bounds.until))) throw fail('boat.dev usage receipt extends outside the requested window');
      return usage.data;
    },

    async create(o) {
      if (opts.org === undefined) throw new BoatError(MISSING_ORG);
      const org = opts.org;
      const res = await call('create', () => api.create({
        org,
        ...(o.idempotencyKey === undefined ? {} : { idempotencyKey: o.idempotencyKey }),
        createSandboxRequest: {
          noEnv: true,
          ...(o.type === undefined ? {} : { type: o.type }),
          ttlSeconds: o.ttlSeconds,
          ...(o.env === undefined ? {} : { env: { ...o.env } }),
          ...(o.setupScript === undefined ? {} : { setupScript: o.setupScript }),
        },
      }));
      const startedAt = res.sandbox.createdAt?.getTime();
      return { sandboxId: res.sandbox.id, ...(startedAt === undefined || !Number.isFinite(startedAt) ? {} : { startedAt }) };
    },

    async waitReady(sandboxId) {
      let slept = 0;
      for (;;) {
        const { sandbox } = await call('get', () => api.get({ sandboxId }));
        if (READY.has(sandbox.state)) return;
        if (TERMINAL.has(sandbox.state)) {
          const why = sandbox.error === undefined || sandbox.error === null || sandbox.error === '' ? '' : `: ${sandbox.error}`;
          throw fail(`sandbox ${sandboxId} entered state ${sandbox.state}${why}`);
        }
        if (slept >= readyTimeoutMs) throw fail(`sandbox ${sandboxId} not ready after ${readyTimeoutMs} ms (state ${sandbox.state})`);
        await sleep(pollMs);
        slept += pollMs;
      }
    },

    async exec(sandboxId, command, o = {}) {
      const res = await call('command', () => api.command({
        sandboxId,
        commandRequest: {
          command,
          ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
          ...(o.timeoutSeconds === undefined ? {} : { timeoutSeconds: o.timeoutSeconds }),
        },
      }));
      if (res.type !== 'command.finished') throw fail(`boat.dev command returned ${String(res.type)}, expected command.finished`);
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut };
    },

    async start(sandboxId, command, o = {}) {
      const res = await call('command', () => api.command({
        sandboxId,
        commandRequest: { command, ...(o.cwd === undefined ? {} : { cwd: o.cwd }), detached: true },
      }));
      if (res.type !== 'command.started') throw fail(`boat.dev command returned ${String(res.type)}, expected command.started`);
      return { processId: res.processId };
    },

    async writeFile(sandboxId, f) {
      await call('writeFile', () => api.writeFile({
        sandboxId,
        fileWriteRequest: { path: f.path, content: f.content, encoding: f.encoding },
      }));
    },

    async expose(sandboxId, port, isPublic) {
      const res = await call('hostPort', () => api.hostPort({ sandboxId, hostPortRequest: { port, _public: isPublic } }));
      if (res.url === undefined || res.url === '') throw fail(`boat.dev hostPort returned no url for port ${port}`);
      return { url: res.url };
    },

    async stop(sandboxId) {
      await call('stop', async () => {
        try {
          await api.stop({ sandboxId });
        } catch (e) {
          if (e instanceof ResponseError) {
            if (e.response.status === 404) return;
            if (e.response.status === 400 && STOPPED.has(await stateOf(sandboxId))) return;
          }
          throw e;
        }
      });
    },

    async waitStopped(sandboxId) {
      let slept = 0;
      for (;;) {
        const state = await stateOf(sandboxId);
        if (STOPPED.has(state)) return;
        if (state === 'error') throw fail(`sandbox ${sandboxId} entered state error while stopping, so it may still be billed`);
        if (slept >= readyTimeoutMs) throw fail(`sandbox ${sandboxId} not stopped after ${readyTimeoutMs} ms (state ${state})`);
        await sleep(pollMs);
        slept += pollMs;
      }
    },
  };
}

/** One line for an SDK failure: the HTTP status and body excerpt, or the network cause. */
async function explain(e: unknown): Promise<string> {
  if (e instanceof ResponseError) {
    const body = await e.response.text().then((t) => t.replace(/\s+/g, ' ').trim(), () => '');
    return `HTTP ${e.response.status}${body === '' ? '' : ` ${body.slice(0, BODY_EXCERPT)}`}`;
  }
  if (e instanceof FetchError) {
    const inner: unknown = e.cause.cause;
    const code = typeof inner === 'object' && inner !== null && 'code' in inner && typeof inner.code === 'string' ? ` (${inner.code})` : '';
    return `${e.cause.message}${code}`;
  }
  return e instanceof Error ? e.message : String(e);
}
