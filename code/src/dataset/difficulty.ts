/**
 * `bun run difficulty` (A-391): how hard each task is for each model, measured rather than labeled.
 * For every chosen task and model it runs N local episodes (local.ts: loopback, no Boat), each graded
 * by the verifier child, and builds the matrix: the pass rate with a Wilson 95% interval per task per
 * model, the task's labeled tier beside the tier its pass rate measures, and the cost.
 *
 * Spend goes through the metered proposer the caller injects. An episode starts only while its whole
 * budget fits in what is left of the run's budget and under the ledger's spend caps. The first call
 * the ledger refuses stops the run, and no other model stands in for the refused one.
 */
import path from 'node:path';
import type { Difficulty } from '#engine';
import { CAPS, CostUnenforceableError, SpendCapError, capStatus, type Ledger, type SpendCaps } from '../costs/ledger.ts';
import type { Runner, Spawner } from '../sandboxes/backend.ts';
import { runLocalEpisode } from './local.ts';
import { GRADING_NOTE, STOP_REASONS, type Redactor, type StopReason } from './schema.ts';
import { solverTurn, type SolverProposer } from './solver.ts';

/** One task of one world, with the tier its author labeled it. */
export type DifficultyTask = { readonly world: string; readonly worldDir: string; readonly task: string; readonly labeled: Difficulty };

/** One episode to run: a task, a model, the episode's number within its cell, its run id and its budget. */
export type EpisodeJob = DifficultyTask & { readonly model: string; readonly index: number; readonly runId: string; readonly budgetUsd: number };

/** What one episode came to. `refusal` is the spend ledger's message when it refused a call of this episode. */
export type EpisodeOutcome = {
  readonly episodeId: string;
  readonly score: number | null;
  readonly stopReason: StopReason;
  /** The billed cost of the episode's calls. */
  readonly costUsd: number;
  /** Calls whose billing is unknown, such as one cut off by the time limit. A refused call is not one: it was never made. */
  readonly unaccountedCalls: number;
  readonly refusal: string | null;
  /** The episode's first call did not fit its budget, so the agent never acted. */
  readonly budgetTooSmall: boolean;
};

export type EpisodeRunner = (job: EpisodeJob) => Promise<EpisodeOutcome>;

/** `chargedUsd` is what the episode counts against the run's budget: its cost, or its whole budget when a call's billing is unknown. */
export type EpisodeRow = Omit<EpisodeJob, 'worldDir' | 'budgetUsd'> & EpisodeOutcome & { readonly chargedUsd: number };

export type DifficultyStop =
  | { readonly kind: 'complete' }
  /** The next episode's budget no longer fits in what is left of the run's. */
  | { readonly kind: 'budget_spent'; readonly leftUsd: number }
  /** The ledger refused a call, or its spend caps no longer fit the next episode's budget. */
  | { readonly kind: 'cost_refused'; readonly message: string }
  | { readonly kind: 'interrupted' }
  /** An episode could not run to the end, for example because its world did not serve. */
  | { readonly kind: 'failed'; readonly message: string };

export type DifficultyRunOptions = {
  readonly runId: string;
  readonly tasks: readonly DifficultyTask[];
  readonly models: readonly string[];
  /** Episodes per task per model. */
  readonly episodes: number;
  /** The cap on the whole run's model spend. */
  readonly budgetUsd: number;
  /** Each episode's budget. Every episode gets all of it, so every trial is measured under the same budget. */
  readonly episodeBudgetUsd: number;
  readonly run: EpisodeRunner;
  /** What the ledger's spend caps leave for model calls, or null when none is set. Asked before each episode. */
  readonly capLeftUsd?: () => number | null;
  readonly interrupt?: AbortSignal | undefined;
  readonly onEpisode?: (row: EpisodeRow) => void;
};

/** `spentUsd` is the sum of every episode's `chargedUsd`, and of the whole budget of an episode that could not run to the end. */
export type DifficultyRun = { readonly rows: readonly EpisodeRow[]; readonly spentUsd: number; readonly stop: DifficultyStop };

const usd = (n: number): number => Math.round(n * 1e6) / 1e6;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The run id of the run's k-th episode. */
export const episodeRunId = (runId: string, k: number): string => `${runId}.${k}`;

/**
 * Runs `episodes` rounds. Each round runs every task with every model once, so a run the budget
 * stops early still has about as many episodes in every cell.
 */
export async function runDifficulty(o: DifficultyRunOptions): Promise<DifficultyRun> {
  const rows: EpisodeRow[] = [];
  let spent = 0;
  const done = (stop: DifficultyStop): DifficultyRun => ({ rows, spentUsd: usd(spent), stop });
  for (let index = 1; index <= o.episodes; index++) {
    for (const t of o.tasks) {
      for (const model of o.models) {
        if (o.interrupt?.aborted === true) return done({ kind: 'interrupted' });
        const left = usd(o.budgetUsd - spent);
        if (left < o.episodeBudgetUsd) return done({ kind: 'budget_spent', leftUsd: left });
        const capLeft = o.capLeftUsd?.() ?? null;
        if (capLeft !== null && capLeft < o.episodeBudgetUsd) {
          return done({ kind: 'cost_refused', message: `the spend caps leave $${capLeft} for model calls, less than one episode's $${o.episodeBudgetUsd} budget` });
        }
        const runId = episodeRunId(o.runId, rows.length + 1);
        let outcome: EpisodeOutcome;
        try {
          outcome = await o.run({ ...t, model, index, runId, budgetUsd: o.episodeBudgetUsd });
        } catch (e) {
          // What it spent before it failed is unknown, so it counts at its whole budget.
          spent += o.episodeBudgetUsd;
          return done({ kind: 'failed', message: `episode ${runId} (${t.world} ${t.task}, ${model}) could not run to the end, so it is charged its whole $${o.episodeBudgetUsd} budget: ${messageOf(e)}` });
        }
        if (outcome.stopReason === 'budget_limit' && outcome.refusal === null) {
          // The caps are shared by every session, so one can run out mid-episode and cut a call short. In doubt, the caps did it: no trial.
          const after = o.capLeftUsd?.() ?? null;
          if (after !== null && after < o.episodeBudgetUsd) outcome = { ...outcome, refusal: `the spend caps ran low during the episode and leave $${after} for model calls, less than one episode's $${o.episodeBudgetUsd} budget` };
        }
        const chargedUsd = usd(outcome.unaccountedCalls > 0 ? Math.max(outcome.costUsd, o.episodeBudgetUsd) : outcome.costUsd);
        spent += chargedUsd;
        const row: EpisodeRow = { world: t.world, task: t.task, labeled: t.labeled, model, index, runId, ...outcome, chargedUsd };
        rows.push(row);
        o.onEpisode?.(row);
        if (outcome.refusal !== null) return done({ kind: 'cost_refused', message: outcome.refusal });
        if (outcome.budgetTooSmall) return done({ kind: 'failed', message: `episode ${runId}: ${model} could not make one call within the $${o.episodeBudgetUsd} episode budget; raise --episode-budget-usd` });
        if (outcome.stopReason === 'interrupted') return done({ kind: 'interrupted' });
      }
    }
  }
  return done({ kind: 'complete' });
}

/** Whether `e` is the spend ledger refusing a call before it was made. */
export function isCostRefusal(e: unknown): boolean {
  return e instanceof SpendCapError || e instanceof CostUnenforceableError || (e instanceof Error && e.message.startsWith('cost admission refused'));
}

/**
 * Whether `e` is a call its cost allowance stopped, as llm.ts words it: the claude CLI's
 * `error_max_budget_usd`, SDK admission that cannot fit the input and one output token, and SDK
 * output cut below `maxOutputTokens` to fit the allowance. The episode files these as model_error,
 * but the agent ran out of budget.
 */
export function isBudgetStop(e: unknown, maxOutputTokens: number): boolean {
  if (!(e instanceof Error)) return false;
  if (e.message.includes('error_max_budget_usd') || e.message.includes('do not fit the model estimate budget')) return true;
  const cut = /hit max_tokens \((\d+)\)/.exec(e.message);
  return cut !== null && Number(cut[1]) < maxOutputTokens;
}

/** What the spend caps that bind model calls leave, the least of them, or null when none is set. */
export function modelCapLeft(ledger: Ledger, caps: SpendCaps, now: () => number = Date.now): () => number | null {
  return () => {
    const left = Object.values(capStatus(ledger, caps, now()).lines)
      .filter((l) => l !== undefined && CAPS[l.cap].kind !== 'sandbox')
      .map((l) => l?.remainingUsd ?? 0);
    return left.length === 0 ? null : Math.min(...left);
  };
}

export type LocalRunnerOptions = {
  /** Each episode writes under `<out>/episodes/<run id>`. */
  readonly out: string;
  readonly engineCommit: string;
  readonly maxTurns: number;
  readonly maxMinutes: number;
  /** The output cap each solver call is configured with, so a lower cap reads as cut to fit the budget. */
  readonly maxOutputTokens: number;
  readonly redact: Redactor;
  /** The metered proposer of each model, built before the run starts. */
  readonly proposers: ReadonlyMap<string, SolverProposer>;
  readonly interrupt?: AbortSignal | undefined;
  readonly runner?: Runner;
  readonly spawner?: Spawner;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * An EpisodeRunner over runLocalEpisode. The episode files any failed model call as model_error,
 * and the failed call is always the last, so the proposer is watched here: a cost refusal is noted,
 * and a call its allowance stopped makes the episode read as budget_limit, unless it was the first
 * call, when the budget was too small for the agent to act at all. The episode's own export keeps
 * model_error and the call's error.
 */
export function localRunner(o: LocalRunnerOptions): EpisodeRunner {
  return async (job) => {
    const proposer = o.proposers.get(job.model);
    if (proposer === undefined) throw new Error(`no proposer was built for ${job.model}`);
    let refusal: string | null = null;
    let budgetStop = false;
    let answered = 0;
    const watched: SolverProposer = {
      async propose(req) {
        try {
          const p = await proposer.propose(req);
          answered += 1;
          return p;
        } catch (e) {
          if (isCostRefusal(e)) refusal ??= messageOf(e);
          else if (isBudgetStop(e, o.maxOutputTokens)) budgetStop = true;
          throw e;
        }
      },
    };
    const { episode } = await runLocalEpisode({
      worldDir: job.worldDir, taskId: job.task, out: path.join(o.out, 'episodes', job.runId), runId: job.runId, engineCommit: o.engineCommit,
      model: job.model, nextTurn: solverTurn(watched, job.runId), maxTurns: o.maxTurns, budgetUsd: job.budgetUsd, maxMinutes: o.maxMinutes,
      redact: o.redact, interrupt: o.interrupt,
      ...(o.runner === undefined ? {} : { runner: o.runner }),
      ...(o.spawner === undefined ? {} : { spawner: o.spawner }),
      ...(o.env === undefined ? {} : { env: o.env }),
    });
    const spentOut = episode.stop_reason === 'model_error' && budgetStop && refusal === null;
    return {
      episodeId: episode.episode_id, score: episode.score, stopReason: spentOut && answered > 0 ? 'budget_limit' : episode.stop_reason, costUsd: episode.usage.cost_usd,
      // The episode counts a refused call as one of unknown billing, but the ledger refused it before it was made.
      unaccountedCalls: Math.max(0, episode.usage.unaccounted_calls - (refusal === null ? 0 : 1)),
      refusal, budgetTooSmall: spentOut && answered === 0,
    };
  };
}

// ---------------------------------------------------------------------------------------------
// The matrix. Pure.

/**
 * Which stops measure the agent on the task: it finished, or ran out of turns, budget or time.
 * A failed model call, a refused, ungraded or interrupted episode, and one the world or the grader
 * broke measure the transport, the infrastructure or the operator, so they are not trials: a call
 * that fails reads as unmeasured, not as hard. A slow call still counts against the time limit.
 */
const MEASURES: Record<StopReason, boolean> = {
  done: true, turn_limit: true, budget_limit: true, time_limit: true,
  model_error: false, world_error: false, grade_error: false, interrupted: false,
};
export const isTrial = (r: EpisodeOutcome): boolean => r.refusal === null && r.score !== null && MEASURES[r.stopReason];
/** A pass is the engine's full score. */
export const isPass = (r: EpisodeOutcome): boolean => isTrial(r) && r.score === 1;

/** z for a two-sided 95% interval. */
const Z = 1.959964;
const rate = (x: number): number => Math.round(x * 1000) / 1000;

/** The Wilson score interval for `passes` of `trials` at 95%, or null with no trials. */
export function wilson(passes: number, trials: number): readonly [number, number] | null {
  if (trials === 0) return null;
  const p = passes / trials;
  const z2 = Z * Z;
  const centre = p + z2 / (2 * trials);
  const margin = Z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  const scale = 1 + z2 / trials;
  return [rate(Math.max(0, (centre - margin) / scale)), rate(Math.min(1, (centre + margin) / scale))];
}

export type Measured = Difficulty | 'unmeasured';
/** The tier a pass rate measures: easy from 2/3, medium from 1/3, hard below. Integer comparisons, so 6 of 9 is exactly 2/3. */
export function measuredTier(passes: number, trials: number): Measured {
  if (trials === 0) return 'unmeasured';
  if (3 * passes >= 2 * trials) return 'easy';
  if (3 * passes >= trials) return 'medium';
  return 'hard';
}

type Rate = {
  readonly trials: number;
  readonly passes: number;
  readonly passRate: number | null;
  readonly interval: readonly [number, number] | null;
  readonly measured: Measured;
};
export type DifficultyCell = { readonly world: string; readonly task: string; readonly labeled: Difficulty; readonly model: string; readonly episodes: number } & Rate & {
  /** The billed cost of the cell's calls; `usdPerPass` divides it by the passes. */
  readonly costUsd: number;
  readonly usdPerPass: number | null;
  readonly unaccountedCalls: number;
  readonly stops: Readonly<Partial<Record<StopReason, number>>>;
  readonly refused: number;
};
/** One task over every model of the run, pooled. `agrees` is null while the task is unmeasured. */
export type DifficultyTaskRow = { readonly world: string; readonly task: string; readonly labeled: Difficulty } & Rate & { readonly agrees: boolean | null };

export type DifficultyMatrix = {
  readonly runId: string;
  readonly models: readonly string[];
  readonly episodesPerCell: number;
  readonly budgetUsd: number;
  readonly episodeBudgetUsd: number;
  readonly spentUsd: number;
  readonly stop: DifficultyStop;
  readonly tasks: readonly DifficultyTaskRow[];
  readonly cells: readonly DifficultyCell[];
  readonly episodes: readonly EpisodeRow[];
};

function rateOf(rows: readonly EpisodeRow[]): Rate {
  const trials = rows.filter(isTrial).length;
  const passes = rows.filter(isPass).length;
  return { trials, passes, passRate: trials === 0 ? null : rate(passes / trials), interval: wilson(passes, trials), measured: measuredTier(passes, trials) };
}

/** The matrix of a run, in the order its tasks and models were given. Every planned cell is present, empty ones as unmeasured. */
export function difficultyMatrix(
  o: Pick<DifficultyRunOptions, 'runId' | 'tasks' | 'models' | 'episodes' | 'budgetUsd' | 'episodeBudgetUsd'>,
  run: DifficultyRun,
): DifficultyMatrix {
  const of = (t: DifficultyTask): EpisodeRow[] => run.rows.filter((r) => r.world === t.world && r.task === t.task);
  const tasks = o.tasks.map((t): DifficultyTaskRow => {
    const r = rateOf(of(t));
    return { world: t.world, task: t.task, labeled: t.labeled, ...r, agrees: r.measured === 'unmeasured' ? null : r.measured === t.labeled };
  });
  const cells = o.tasks.flatMap((t) =>
    o.models.map((model): DifficultyCell => {
      const rows = of(t).filter((r) => r.model === model);
      const r = rateOf(rows);
      const costUsd = usd(rows.reduce((sum, e) => sum + e.costUsd, 0));
      const stops: Partial<Record<StopReason, number>> = {};
      for (const s of STOP_REASONS) {
        const n = rows.filter((e) => e.stopReason === s).length;
        if (n > 0) stops[s] = n;
      }
      return {
        world: t.world, task: t.task, labeled: t.labeled, model, episodes: rows.length, ...r, costUsd,
        usdPerPass: r.passes === 0 ? null : usd(costUsd / r.passes), unaccountedCalls: rows.reduce((sum, e) => sum + e.unaccountedCalls, 0),
        stops, refused: rows.filter((e) => e.refusal !== null).length,
      };
    }),
  );
  return {
    runId: o.runId, models: o.models, episodesPerCell: o.episodes, budgetUsd: o.budgetUsd, episodeBudgetUsd: o.episodeBudgetUsd,
    spentUsd: run.spentUsd, stop: run.stop, tasks, cells, episodes: run.rows,
  };
}

const stopText = (s: DifficultyStop): string => {
  switch (s.kind) {
    case 'complete':
      return 'complete';
    case 'budget_spent':
      return `budget spent ($${s.leftUsd} left, less than one episode's budget)`;
    case 'cost_refused':
      return `the spend ledger refused a call: ${s.message}`;
    case 'interrupted':
      return 'interrupted by the operator';
    case 'failed':
      return `failed: ${s.message}`;
  }
};
const shownRate = (r: Rate): string => (r.passRate === null ? 'none' : String(r.passRate));
const shownInterval = (r: Rate): string => (r.interval === null ? 'none' : `${r.interval[0]} to ${r.interval[1]}`);
const shownStops = (c: DifficultyCell): string =>
  Object.entries(c.stops).map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
const cell = (v: string): string => v.replaceAll('|', '\\|').replaceAll('\n', ' ');
const row = (vs: readonly string[]): string => `| ${vs.map(cell).join(' | ')} |`;

/** The matrix as Markdown: one table per task over every model, then one per task and model. */
export function renderDifficultyMd(m: DifficultyMatrix): string {
  return [
    `# Difficulty: ${m.runId}`,
    '',
    `Models: ${m.models.join(', ')}. Episodes per task per model: ${m.episodesPerCell}, each with a $${m.episodeBudgetUsd} budget.`,
    '',
    `Charged $${m.spentUsd} of the $${m.budgetUsd} budget over ${m.episodes.length} episodes. An episode with a call of unknown billing is charged its whole budget; there were ${m.cells.reduce((sum, c) => sum + c.unaccountedCalls, 0)} such calls.`,
    '',
    `Stop: ${stopText(m.stop)}.`,
    '',
    'A pass is an engine score of 1. A trial is a graded episode that stopped done or at its turn, budget or time limit; a model error, a refusal, a world or grade error and an interruption are not trials. The interval is Wilson 95%. The measured tier is easy at a pass rate of 2/3 or more, medium at 1/3 or more, and hard below.',
    '',
    GRADING_NOTE,
    '',
    '## By task',
    '',
    '| world | task | labeled | measured | agrees | passes / trials | pass rate | 95% interval |',
    '|---|---|---|---|---|---|---|---|',
    ...m.tasks.map((t) => row([t.world, t.task, t.labeled, t.measured, t.agrees === null ? 'n/a' : t.agrees ? 'yes' : 'no', `${t.passes} / ${t.trials}`, shownRate(t), shownInterval(t)])),
    '',
    '## By task and model',
    '',
    '| world | task | labeled | model | measured | passes / trials | pass rate | 95% interval | episodes | stops | cost USD | USD per pass |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...m.cells.map((c) =>
      row([c.world, c.task, c.labeled, c.model, c.measured, `${c.passes} / ${c.trials}`, shownRate(c), shownInterval(c), String(c.episodes), shownStops(c), String(c.costUsd), c.usdPerPass === null ? 'none' : String(c.usdPerPass)]),
    ),
    '',
  ].join('\n');
}
