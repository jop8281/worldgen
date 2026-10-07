/**
 * The studio's generation runs, kept on disk so a studio restart neither loses nor duplicates them (YOS-191, A-329).
 * One JSON file in the worlds directory, the volume a container keeps. Written whole through a temp file and a rename,
 * so a crash mid-write leaves the previous registry, never half of one.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpawnedChild } from '../sandboxes/backend.ts';

/** The registry's file name in the worlds directory. A file, so the worlds table (directories only) never lists it. */
export const RUN_STORE_FILE = '.studio-runs.json';

/** What survives a restart about one run. */
export type StoredRun = {
  readonly runId: string;
  readonly outDir: string;
  readonly pid: number | null;
  readonly knownRuns: readonly string[];
  readonly startedAt: string;
  /** Null while the process runs; its exit code once the studio saw it end. */
  readonly exitCode: number | null;
  readonly finished: boolean;
};

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
    return Array.isArray(parsed) ? (parsed as StoredRun[]) : [];
  } catch {
    return [];
  }
}

export async function saveRuns(worldsDir: string, runs: readonly StoredRun[]): Promise<void> {
  const file = path.join(worldsDir, RUN_STORE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
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
