/**
 * The trusted grader the dataset pipeline grades through (YOS-159, A-224). Shell code: it reads
 * and writes files and spawns the verifier child through the injected Runner; the protocol and
 * every judgment live in the engine (`engine/verify.ts`).
 *
 * Two graders, one protocol. `engineGrader` verifies in this process, through #engine: the test
 * seam and the offline path. `childGrader` runs `cli/verifier.ts` as a separate host process per
 * submission, with the private world by path, no listener, and a clean environment that carries
 * no controller credential (isolatedEnv: TZ, PATH and the guard scale); that is the one `bun run dataset` wires in, per
 * research/architecture.md: the verifier is a separate process, not a route on the world server.
 *
 * Both send the same request: the run's identities, the trace and its hash chain, and the final
 * state snapshot. Both map the bounded verdict to the episode's grade result; a rejection is a
 * safe one-line reason, never grader source. Request files and the submission ledger stay under
 * `<out>/private/verifier/`, which is never uploaded and never exported.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  chainOf, checkWorld, loadWorld, verifySubmission, VERIFIER_PROTOCOL, VERIFIER_STOPS,
  type CheckedWorld, type TraceCall, type VerifierVerdict, type Wid,
} from '#engine';
import { isolatedEnv, lastLines, nodeRunner, type Runner, type RunResult } from '../sandboxes/backend.ts';
import type { EpisodeGrader, EpisodeSubmission, GradeResult } from './episode.ts';

/** What a grader factory receives: the run's identities and the frozen private world's directory. No CheckedWorld, so a controller that never loaded the world can grade. */
export type HeldWorld = {
  readonly wid: Wid;
  readonly worldVersion: string;
  /** The trusted directory holding the frozen private world.yaml. */
  readonly frozenDir: string;
  readonly engine: string;
};
export type GraderFactory = (held: HeldWorld) => EpisodeGrader;

/** The protocol request the controller sends; the engine's verifierRequestSchema validates it on the verifier side. */
export type VerifierRequestMessage = {
  readonly protocol: typeof VERIFIER_PROTOCOL;
  readonly submission: string;
  readonly task: string;
  readonly wid: Wid;
  readonly worldVersion: string;
  readonly engine: string;
  readonly trace: readonly TraceCall[];
  readonly chain: string;
  readonly state: EpisodeSubmission['state'];
};

/** Builds the protocol request: the identities the run is bound to, the trace, its chain, and the final state. */
export function verifierRequestOf(held: HeldWorld, sub: EpisodeSubmission): VerifierRequestMessage {
  return {
    protocol: VERIFIER_PROTOCOL,
    submission: sub.submission,
    task: sub.task,
    wid: held.wid,
    worldVersion: held.worldVersion,
    engine: held.engine,
    trace: sub.trace,
    chain: chainOf(sub.trace),
    state: sub.state,
  };
}

/** Every stop but `graded`, derived from VERIFIER_STOPS, so a new stop is counted here automatically. */
const REJECT_STOPS: readonly Exclude<VerifierVerdict['stop'], 'graded'>[] =
  VERIFIER_STOPS.filter((s): s is Exclude<VerifierVerdict['stop'], 'graded'> => s !== 'graded');

/** A rejection as a safe one-line reason: a literal stop code, never grader source. */
const reasonOf = (stop: Exclude<VerifierVerdict['stop'], 'graded'>): string => `the verifier rejected the submission: ${stop}`;

/**
 * The offline grader: verifies in this process, through #engine, against the private world the
 * pipeline holds. One instance is one verifier session: a submission graded once cannot be
 * graded again through it.
 */
/**
 * Frozen private worlds this process has loaded and checked, by directory and world version. A frozen world never
 * changes, so each is checked once; a full check blocks the event loop for seconds on a slow host.
 */
const frozenWorlds = new Map<string, Promise<CheckedWorld | null>>();

async function loadFrozen(held: HeldWorld): Promise<CheckedWorld | null> {
  const loaded = await loadWorld(held.frozenDir);
  if (!loaded.ok) return null;
  const report = checkWorld(loaded.value);
  return report.ok ? report.world : null;
}

export function engineGrader(held: HeldWorld): EpisodeGrader {
  const seen = new Set<string>();
  const key = `${held.frozenDir}\n${held.worldVersion}`;
  return async (sub) => {
    let world = frozenWorlds.get(key);
    if (world === undefined) frozenWorlds.set(key, (world = loadFrozen(held)));
    const checked = await world;
    if (checked === null) return { ok: false, reason: 'the frozen private world does not check' };
    const { verdict, ledger } = verifySubmission(
      checked,
      { wid: held.wid, worldVersion: held.worldVersion, engine: held.engine },
      JSON.stringify(verifierRequestOf(held, sub)),
      seen,
    );
    if (ledger !== null) seen.add(ledger);
    return verdict.stop === 'graded' ? { ok: true, score: verdict.score, goals: verdict.goals, guards: verdict.guards } : { ok: false, reason: reasonOf(verdict.stop) };
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How long the verifier child may run before it is killed: it loads and checks the private world. */
const CHILD_TIMEOUT_MS = 300_000;

/**
 * The child's answer on stdout as a grade result, or null when it is not a verdict. Only the
 * bounded fields are read: a stop code, a score and two integer pairs of goal and guard counts,
 * so nothing a broken child could print becomes an episode's reason or label.
 */
function verdictOf(text: string): GradeResult | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = v as { task?: unknown; stop?: unknown; score?: unknown; goals?: unknown; guards?: unknown } | null;
  if (o === null || typeof o !== 'object' || typeof o.task !== 'string' || typeof o.stop !== 'string') return null;
  if (o.stop === 'graded') {
    const goals = countPair(o.goals, 'met');
    const guards = countPair(o.guards, 'held');
    const ok = typeof o.score === 'number' && Number.isFinite(o.score) && o.score >= 0 && o.score <= 1 && goals !== null && guards !== null;
    return ok ? { ok: true, score: o.score as number, goals: { met: goals.n, total: goals.total }, guards: { held: guards.n, total: guards.total } } : null;
  }
  const stop = REJECT_STOPS.find((s) => s === o.stop);
  return stop === undefined ? null : { ok: false, reason: reasonOf(stop) };
}

/** `{ <key>: n, total }` with two non-negative integers and n at most total, and nothing else; null otherwise. */
function countPair(v: unknown, key: 'met' | 'held'): { n: number; total: number } | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [key, 'total'].sort().join(',')) return null;
  const n = (v as Record<string, unknown>)[key];
  const total = (v as Record<string, unknown>)['total'];
  return Number.isSafeInteger(n) && Number.isSafeInteger(total) && (n as number) >= 0 && (n as number) <= (total as number) ? { n: n as number, total: total as number } : null;
}

export type ChildGraderOptions = {
  /** Where the code package lives: `src/cli/verifier.ts`. */
  readonly codeDir: string;
  /** The dataset run's output directory: request files and the ledger go under `<out>/private/verifier/`. */
  readonly out: string;
  /** Spawns the child. Default nodeRunner. */
  readonly runner?: Runner;
  /** How long the child may run. Default 300000 ms. */
  readonly timeoutMs?: number;
  /** The command that runs a TypeScript file. Default the Bun running this process (A-381). */
  readonly launcher?: readonly string[];
  /** The source the child's allowlisted environment is built from. Default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * The production grader: one `cli/verifier.ts` child process per submission, spawned through the
 * injected Runner with a clean environment. The child holds the private world by path, verifies
 * the protocol message, records the submission in the run's ledger, and prints exactly one
 * bounded verdict. A non-zero exit, a timeout or an unparseable answer is a failed grade, never
 * a crash of the run.
 */
export function childGrader(o: ChildGraderOptions): (held: HeldWorld) => EpisodeGrader {
  const runner = o.runner ?? nodeRunner;
  const launcher = o.launcher ?? [process.execPath];
  const requestsDir = path.join(o.out, 'private', 'verifier', 'requests');
  const ledger = path.join(o.out, 'private', 'verifier', 'submissions.jsonl');
  return (held) => async (sub) => {
    const file = path.join(requestsDir, `${sub.submission}.json`);
    await mkdir(requestsDir, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(verifierRequestOf(held, sub)), { mode: 0o600 });
    let run: RunResult;
    try {
      run = await runner(
        [...launcher, 'src/cli/verifier.ts', held.frozenDir, file, held.engine, ledger],
        { cwd: o.codeDir, timeoutMs: o.timeoutMs ?? CHILD_TIMEOUT_MS, env: isolatedEnv(o.env ?? process.env) },
      );
    } catch (e) {
      return { ok: false, reason: `the verifier process could not start: ${messageOf(e)}` };
    }
    if (run.code !== 0) {
      // The child's stderr carries only its own authored one-line reasons, never world content.
      return { ok: false, reason: `the verifier process failed (exit ${run.code}): ${lastLines(run.stderr, 1) || 'no output'}` };
    }
    const graded = verdictOf(run.stdout);
    return graded ?? { ok: false, reason: 'the verifier process answered with something other than a verdict' };
  };
}
