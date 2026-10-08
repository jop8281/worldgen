/**
 * The studio's jobs (generation runs and agent episodes), kept on disk so neither a restart nor a retried request loses
 * or duplicates one (YOS-191 A-329, YOS-231 A-335). One JSON file in the worlds directory, the volume a container
 * keeps. Written whole through a temp file and a rename, so a crash mid-write leaves the previous registry, never half
 * of one. The loader reads only the final name, so a temp file a crash left behind is never read.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SpawnedChild } from '../sandboxes/backend.ts';

/** The registry's file name in the worlds directory. A file, so the worlds table (directories only) never lists it. */
export const RUN_STORE_FILE = '.studio-runs.json';

export type JobKind = 'generate' | 'episode';
/** The tenant of open mode, of the WORLDGEN_STUDIO_TOKEN admin, and of a record written before tenants existed. */
export const DEFAULT_TENANT = 'default';
/** Which studio may act on an unfinished job, and until when. Past `expiresAt` the holder counts as dead. */
export type Lease = { readonly holder: string; readonly expiresAt: string };
/** What a studio did with a job whose holder died. */
export type Recovery =
  | { readonly at: string; readonly from: string; readonly outcome: 'resumed' }
  | { readonly at: string; readonly from: string; readonly outcome: 'stopped'; readonly reason: 'process_gone' | 'start_unconfirmed' };

/** What survives a restart about one job. */
export type StoredRun = {
  readonly runId: string;
  readonly kind: JobKind;
  /** The tenant of the user who started it. Only that tenant and an admin see the job, and its key is looked up within it. */
  readonly tenant: string;
  /** The Idempotency-Key header, or `derived:<sha256>` of the request when the client sent none. */
  readonly key: string;
  /** sha256 of the canonical request (kind + argv); a client key reused with another request is refused. */
  readonly fingerprint: string;
  /** intent: recorded, child not confirmed started. running: child pid recorded. finished: the studio saw it end, or recovery stopped it. */
  readonly phase: 'intent' | 'running' | 'finished';
  /** Null once finished. */
  readonly lease: Lease | null;
  readonly recovery?: Recovery | undefined;
  readonly outDir: string;
  readonly pid: number | null;
  readonly knownRuns: readonly string[];
  readonly startedAt: string;
  /** Null while the process runs; its exit code once the studio saw it end. */
  readonly exitCode: number | null;
  /** Episodes only. */
  readonly episode?: { readonly world: string; readonly task: string; readonly agent: string } | undefined;
};

const sharedFields = {
  runId: z.string(),
  outDir: z.string(),
  pid: z.number().int().nullable(),
  knownRuns: z.array(z.string()),
  startedAt: z.string(),
  exitCode: z.number().int().nullable(),
};

const storedRunSchema = z.object({
  ...sharedFields,
  kind: z.enum(['generate', 'episode']),
  tenant: z.string().default(DEFAULT_TENANT),
  key: z.string(),
  fingerprint: z.string(),
  phase: z.enum(['intent', 'running', 'finished']),
  lease: z.object({ holder: z.string(), expiresAt: z.string() }).nullable(),
  recovery: z.discriminatedUnion('outcome', [
    z.object({ at: z.string(), from: z.string(), outcome: z.literal('resumed') }),
    z.object({ at: z.string(), from: z.string(), outcome: z.literal('stopped'), reason: z.enum(['process_gone', 'start_unconfirmed']) }),
  ]).optional(),
  episode: z.object({ world: z.string(), task: z.string(), agent: z.string() }).optional(),
});

/** The A-329 record: a generation run with a finished flag and no lease. */
const legacyRunSchema = z.object({ ...sharedFields, finished: z.boolean() });

/** One record of the file, in the current shape or the A-329 one; null when it is neither. */
function storedRunOf(value: unknown): StoredRun | null {
  const current = storedRunSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyRunSchema.safeParse(value);
  if (!legacy.success) return null;
  const { finished, ...run } = legacy.data;
  // An unfinished legacy record has no lease, so it counts as expired and the next studio recovers it.
  return { ...run, kind: 'generate', tenant: DEFAULT_TENANT, key: `legacy:${run.runId}`, fingerprint: '', phase: finished ? 'finished' : 'running', lease: null };
}

/** How the studio looks at and signals a process it did not spawn itself. Injected so tests run no real process. */
export type Processes = {
  alive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): boolean;
};

export const osProcesses: Processes = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means the pid exists but belongs to someone else, so it is not our worldgen.
      return false;
    }
  },
  kill(pid, signal) {
    try {
      return process.kill(pid, signal);
    } catch {
      return false;
    }
  },
};

export async function loadRuns(worldsDir: string): Promise<StoredRun[]> {
  const text = await readFile(path.join(worldsDir, RUN_STORE_FILE), 'utf8').catch(() => null);
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.flatMap((r) => storedRunOf(r) ?? []) : [];
  } catch {
    return [];
  }
}

export async function saveRuns(worldsDir: string, runs: readonly StoredRun[]): Promise<void> {
  const file = path.join(worldsDir, RUN_STORE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  // A worlds dir the studio was pointed at may not exist yet, and a job's intent must still reach the disk.
  await mkdir(worldsDir, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * A child handle for a run a previous studio started. Its exit is seen by polling, because only the parent that
 * spawned a process can wait on it; its output is whatever that studio captured, which is gone, so it is empty.
 */
export function adoptedChild(pid: number, processes: Processes, pollMs = 1_000): SpawnedChild {
  let timer: ReturnType<typeof setInterval> | undefined;
  const exited = new Promise<number | null>((resolve) => {
    const check = (): void => {
      if (processes.alive(pid)) return;
      if (timer !== undefined) clearInterval(timer);
      resolve(null);
    };
    timer = setInterval(check, pollMs);
    timer.unref?.();
    check();
  });
  return { pid, exited, kill: (signal) => processes.kill(pid, signal), output: () => '' };
}
