/**
 * boat.dev hosted sandboxes as a SandboxBackend, over the narrow BoatClient (boat/client.ts).
 * Boat is the only product sandbox; OpenShell and sbx stay for local development.
 *
 * `up` creates a VM of the requested type ('small', 2 vCPU and 4 GB, unless asked otherwise),
 * waits until it is ready, makes the directories, and writes each file base64-encoded under
 * BOAT_WORKDIR. A file over BOAT_WRITE_CHUNK_BYTES goes up in parts, joined on the VM and checked
 * by sha256, because boat.dev refuses a single write over 5 MiB. A failure after create stops the VM before the error propagates. `down` stops it
 * and waits until boat.dev reports it archived. `expose` maps one port to a URL; upWorld only
 * ever passes the world port, never the admin port.
 */
import { createHash } from 'node:crypto';
import { BoatError, type BoatClient, type BoatType } from '../boat/client.ts';
import { BOAT_SIZES } from '../costs/pricing.ts';
import { DEFAULT_SIZE, PendingSandboxError, SandboxError, SandboxStartError, assertSandboxName, shQuote, type ExecOpts, type ExecResult, type SandboxBackend, type SandboxFile, type SandboxSize } from './backend.ts';

/** Where the uploaded files land inside a boat sandbox. The home directory is unknown, so it is /tmp. */
export const BOAT_WORKDIR = '/tmp/worldgen';
/** A boat sandbox lives this long unless the caller sets a TTL. */
export const BOAT_DEFAULT_TTL_SEC = 1800;
/** Files written at once during upload. */
export const BOAT_UPLOAD_CONCURRENCY = 8;
/** The largest write sent at once: 3 MiB is 4 MiB base64, under boat.dev's 5 MiB write_file cap. */
export const BOAT_WRITE_CHUNK_BYTES = 3 * 1024 * 1024;
/** boat.dev accepts 1 to 600 seconds per command. */
export const BOAT_MAX_COMMAND_SEC = 600;
/** The exit code reported for a command boat killed at its timeout, as coreutils `timeout` does. */
export const TIMED_OUT_EXIT = 124;

export type BoatDeps = {
  readonly client: BoatClient;
  readonly ttlSeconds?: number;
  /** Waits between retries of a write or a stop; tests pass one that returns at once. */
  readonly sleep?: (ms: number) => Promise<void>;
};

const BOAT_TYPES: readonly BoatType[] = ['small', 'default', 'large'];

/** The boat type with exactly this many CPUs and GiB, or a SandboxError listing the ones that exist. */
export function boatTypeOf(size: SandboxSize): BoatType {
  const hit = BOAT_TYPES.find((t) => BOAT_SIZES[t].vcpu === size.cpus && BOAT_SIZES[t].memoryGb === size.memoryGi);
  if (hit !== undefined) return hit;
  const known = BOAT_TYPES.map((t) => `${t} (${BOAT_SIZES[t].vcpu} CPU, ${BOAT_SIZES[t].memoryGb} GB)`).join(', ');
  throw new SandboxError(`boat has no ${size.cpus} CPU, ${size.memoryGi} GB type: use ${known}`);
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A BoatError is already one line and key-free; the backend's callers see every failure as a SandboxError. */
/**
 * Statuses with which boat.dev refuses a create before making anything, such as 403 not_org_member (A-286).
 * Any other failure leaves the outcome unknown: a timeout, a 5xx, a 429, or a 409 that may name an earlier create.
 */
const REFUSED_CREATE: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 422]);

/** boat.dev answers 502, 503 or 504 for minutes at a time; a write or a stop is tried this many times before it fails. */
export const BOAT_TRANSIENT_TRIES = 3;
const TRANSIENT: ReadonlySet<number> = new Set([502, 503, 504]);

async function withRetry<T>(f: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await f();
    } catch (err) {
      if (n >= BOAT_TRANSIENT_TRIES || !(err instanceof BoatError && TRANSIENT.has(err.status ?? 0))) throw err;
      await sleep(5_000 * n);
    }
  }
}

async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof BoatError) throw new SandboxError(err.message);
    throw err;
  }
}

/** The directories that must exist before the files under them are written, parents first. */
function dirsOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}

async function inBatches<T>(items: readonly T[], size: number, f: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(f));
}

export function boatBackend(deps: BoatDeps): SandboxBackend {
  const { client } = deps;
  const ttlSeconds = deps.ttlSeconds ?? BOAT_DEFAULT_TTL_SEC;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new SandboxError('boat TTL must be a positive finite integer in seconds');

  const exec = async (id: string, cmd: readonly string[], opts?: ExecOpts): Promise<ExecResult> => {
    const res = await call(() =>
      client.exec(id, cmd.map(shQuote).join(' '), {
        ...(opts?.workdir === undefined ? {} : { cwd: opts.workdir }),
        ...(opts?.timeoutSec === undefined ? {} : { timeoutSeconds: Math.min(Math.max(1, Math.ceil(opts.timeoutSec)), BOAT_MAX_COMMAND_SEC) }),
      }),
    );
    return { exitCode: res.timedOut ? TIMED_OUT_EXIT : (res.exitCode ?? 1), stdout: res.stdout, stderr: res.stderr };
  };

  /** Stops the VM and waits until boat.dev says it is archived, so a leaked sandbox is never silent. */
  const down = async (id: string): Promise<void> => {
    await call(() => withRetry(async () => {
      await client.stop(id);
      await client.waitStopped(id);
    }, sleep));
  };

  const write = (id: string, path: string, data: Uint8Array): Promise<void> =>
    call(() => withRetry(() => client.writeFile(id, { path, content: Buffer.from(data).toString('base64'), encoding: 'base64' }), sleep));

  /** Writes one file, in parts joined on the VM when it is too large for one write, and checks the joined bytes by sha256. */
  const upload = async (id: string, f: SandboxFile): Promise<void> => {
    const target = `${BOAT_WORKDIR}/${f.path}`;
    if (f.data.byteLength <= BOAT_WRITE_CHUNK_BYTES) return write(id, target, f.data);
    const parts: string[] = [];
    for (let at = 0; at < f.data.byteLength; at += BOAT_WRITE_CHUNK_BYTES) {
      const part = `${target}.part${String(parts.length).padStart(4, '0')}`;
      await write(id, part, f.data.subarray(at, at + BOAT_WRITE_CHUNK_BYTES));
      parts.push(part);
    }
    const join = await exec(id, ['sh', '-c', 'out=$1; shift; cat "$@" > "$out" && rm -f "$@" && sha256sum "$out"', 'sh', target, ...parts]);
    const want = createHash('sha256').update(f.data).digest('hex');
    const got = join.stdout.trim().split(/\s+/)[0] ?? '';
    if (join.exitCode !== 0 || got !== want) {
      throw new SandboxError(`joining ${parts.length} parts of ${f.path} in boat sandbox ${id} failed (exit ${join.exitCode}, sha256 ${got || 'none'}, expected ${want}): ${join.stderr.trim() || 'no output'}`);
    }
  };

  return {
    kind: 'boat',
    maxLifetimeSeconds: ttlSeconds,

    async up(files, opts) {
      let type: BoatType;
      try {
        assertSandboxName(opts.name);
        if (opts.image !== undefined) throw new SandboxError('boat takes no image; drop the image option or use openshell');
        type = boatTypeOf(opts.size ?? DEFAULT_SIZE);
      } catch (err) { throw new SandboxStartError(messageOf(err), { kind: 'not_started' }); }
      let id: string;
      try { ({ sandboxId: id } = await client.create({ type, ttlSeconds, ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }) })); }
      catch (err) { throw new SandboxStartError(messageOf(err), { kind: err instanceof BoatError && REFUSED_CREATE.has(err.status ?? 0) ? 'not_started' : 'unknown' }); }
      try {
        await call(() => client.waitReady(id));
        const dirs = dirsOf(files.map((f) => f.path)).map((d) => `${BOAT_WORKDIR}/${d}`);
        const mkdir = await exec(id, ['mkdir', '-p', BOAT_WORKDIR, ...dirs]);
        if (mkdir.exitCode !== 0) throw new SandboxError(`mkdir in boat sandbox ${id} failed (exit ${mkdir.exitCode}): ${mkdir.stderr.trim() || 'no output'}`);
        await inBatches(files, BOAT_UPLOAD_CONCURRENCY, (f) => upload(id, f));
      } catch (err) {
        try {
          await down(id);
        } catch (downErr) {
          throw new PendingSandboxError(`${messageOf(err)}\nteardown of boat sandbox ${id} also failed: ${messageOf(downErr)}`, id);
        }
        throw new SandboxStartError(messageOf(err), { kind: 'closed', id });
      }
      return { id, workdir: BOAT_WORKDIR };
    },

    exec,

    async start(id, cmd, opts) {
      const line = `${cmd.map(shQuote).join(' ')} > ${shQuote(opts.log)} 2>&1 < /dev/null`;
      await call(() => client.start(id, line, opts.workdir === undefined ? {} : { cwd: opts.workdir }));
    },

    async expose(id, port, opts) {
      return (await call(() => client.expose(id, port, opts.public))).url;
    },

    down,
  };
}
