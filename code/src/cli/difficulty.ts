/**
 * `bun run difficulty` (A-391): runs N local agent episodes per task per model and writes the
 * difficulty matrix, `<out>/difficulty.json` and `<out>/difficulty.md`. Argument parsing and wiring;
 * the work is in dataset/difficulty.ts.
 *
 * Exit codes: 0 the run completed or spent its budget, 1 it failed, was interrupted or met a cost
 * refusal (once episodes start, the matrix of what ran is still written), 2 bad usage, an --out that
 * holds a run, or a model with no price, before any model call.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { capsFromEnv, ledgerPath, openLedger } from '../costs/ledger.ts';
import { difficultyMatrix, localRunner, modelCapLeft, renderDifficultyMd, runDifficulty, type DifficultyTask } from '../dataset/difficulty.ts';
import { checkInChild } from '../dataset/pipeline.ts';
import { GRADING_NOTE, RUN_ID, redactor } from '../dataset/schema.ts';
import type { SolverProposer } from '../dataset/solver.ts';
import { nodeRunner } from '../sandboxes/backend.ts';
import { DEFAULT_API_KEY_ENV, DEFAULT_MODEL, isClaudeModelId, isPriced, loadConfig, transportOf, type Transport } from '../worldgen/config.ts';
import { makeModel } from './models.ts';
import { CONFIG_FILE, UsageError, positiveNumber, transportOption } from './options.ts';

/** A solver turn is one tool call, as in cli/episode.ts. */
const SOLVER_MAX_OUTPUT_TOKENS = 4096;
/** Room in a run id for the `.<n>` each episode adds. */
const MAX_RUN_ID = 56;

export const USAGE = `usage: difficulty <world-dir>... --budget-usd <n> --out <dir> --run-id <id> --engine-commit <sha> [options]
Runs N local agent episodes of each task per model on this machine (loopback, no Boat), grades each
in the verifier child, and writes <out>/difficulty.json and <out>/difficulty.md: the pass rate with a
Wilson 95% interval per task per model, the labeled tier beside the measured one, and the cost.
Every model call is metered through the spend ledger. An episode starts only while its whole budget
fits in what is left of --budget-usd and under the spend caps; the first refused call stops the run,
and no other model stands in.
  --budget-usd <n>          the whole run's model spend; required. The claude CLI checks a call's
                            allowance only after the call, so each episode can pass its budget by
                            part of one call; the SDK bounds every call before it is made
  --out <dir>               where the matrix and every episode go; must not hold a difficulty run
  --run-id <id>             this run's name, at most ${MAX_RUN_ID} characters; episode k runs as <id>.k
  --engine-commit <sha>     the engine commit the episodes run, 7 to 64 hex digits
  --task <id>               run only this task; repeat for more (default: every task of each world)
  --models <m,...>          Claude models with a known price (default ${DEFAULT_MODEL})
  --episodes <n>            episodes per task per model (default 3)
  --episode-budget-usd <n>  each episode's budget (default 0.5); an episode starts only while all of it fits
  --max-turns <n>           most agent turns per episode (default 12)
  --max-minutes <n>         wall-clock limit per episode (default 5)
  --transport <t>           claude-cli (default) or sdk; sdk needs ${DEFAULT_API_KEY_ENV}
${GRADING_NOTE}`;

type Env = Readonly<Record<string, string | undefined>>;
export type Args = {
  readonly worlds: readonly string[]; readonly tasks: readonly string[] | null; readonly models: readonly string[]; readonly episodes: number;
  readonly budgetUsd: number; readonly episodeBudgetUsd: number; readonly maxTurns: number; readonly maxMinutes: number;
  readonly out: string; readonly runId: string; readonly engineCommit: string; readonly transport: Transport | undefined;
};

const positive = (flag: string, v: string | undefined, fallback: number): number => (v === undefined ? fallback : positiveNumber(flag, v));
function count(flag: string, v: string | undefined, fallback: number): number {
  const n = positive(flag, v, fallback);
  if (!Number.isInteger(n)) throw new UsageError(`${flag} needs a whole number, got ${v}`);
  return n;
}

export function parse(argv: readonly string[]): Args | 'help' {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        'budget-usd': { type: 'string' }, out: { type: 'string' }, 'run-id': { type: 'string' }, 'engine-commit': { type: 'string' },
        task: { type: 'string', multiple: true }, models: { type: 'string' }, episodes: { type: 'string' }, 'episode-budget-usd': { type: 'string' },
        'max-turns': { type: 'string' }, 'max-minutes': { type: 'string' }, transport: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const v = parsed.values;
  if (v['help'] === true) return 'help';
  const need = (k: string): string => {
    const x = v[k];
    if (typeof x !== 'string' || x.trim() === '') throw new UsageError(`--${k} is required`);
    return x;
  };
  if (parsed.positionals.length === 0) throw new UsageError('name at least one world directory');
  const worlds = parsed.positionals.map((w) => path.resolve(w));
  const names = worlds.map((w) => path.basename(w));
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice !== undefined) throw new UsageError(`two worlds are named ${twice}; the matrix names a world by its directory`);
  const budgetUsd = positiveNumber('--budget-usd', need('budget-usd'));
  const runId = need('run-id');
  if (!RUN_ID.test(runId) || runId.length > MAX_RUN_ID) {
    throw new UsageError(`--run-id must be 1 to ${MAX_RUN_ID} letters, digits, dots, dashes or underscores, starting with a letter or digit, with no "__" and no "_" at the end, got ${runId}`);
  }
  const engineCommit = need('engine-commit');
  if (!/^[0-9a-f]{7,64}$/.test(engineCommit)) throw new UsageError(`--engine-commit must be 7 to 64 lowercase hex digits, got ${engineCommit}`);
  const models = ((v['models'] as string | undefined) ?? DEFAULT_MODEL).split(',').map((m) => m.trim());
  const bad = models.find((m) => !isClaudeModelId(m));
  if (bad !== undefined) throw new UsageError(`--models takes Claude model ids such as ${DEFAULT_MODEL}, got "${bad}"`);
  if (new Set(models).size !== models.length) throw new UsageError('--models names a model twice');
  const episodeBudgetUsd = positive('--episode-budget-usd', v['episode-budget-usd'] as string | undefined, 0.5);
  if (episodeBudgetUsd > budgetUsd) throw new UsageError(`--episode-budget-usd ${episodeBudgetUsd} is more than --budget-usd ${budgetUsd}, so no episode could start`);
  const tasks = v['task'] as string[] | undefined;
  const given = v['transport'] as string | undefined;
  return {
    worlds, tasks: tasks === undefined ? null : [...new Set(tasks)], models,
    episodes: count('--episodes', v['episodes'] as string | undefined, 3),
    budgetUsd, episodeBudgetUsd,
    maxTurns: count('--max-turns', v['max-turns'] as string | undefined, 12),
    maxMinutes: positive('--max-minutes', v['max-minutes'] as string | undefined, 5),
    out: path.resolve(need('out')), runId, engineCommit,
    transport: given === undefined ? undefined : transportOption('--transport', given),
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The chosen tasks of every world, in the order given, with their labeled tiers, from the check child. */
async function plan(args: Args, env: Env): Promise<DifficultyTask[]> {
  const tasks: DifficultyTask[] = [];
  for (const worldDir of args.worlds) {
    const checked = await checkInChild(worldDir, nodeRunner, env);
    for (const t of checked.tasks) {
      if (args.tasks === null || args.tasks.includes(t.id)) tasks.push({ world: path.basename(worldDir), worldDir, task: t.id, labeled: t.difficulty });
    }
  }
  const missing = (args.tasks ?? []).filter((id) => !tasks.some((t) => t.task === id));
  if (missing.length > 0) throw new Error(`no world given has the task ${missing.join(', ')}`);
  return tasks;
}

export async function main(argv: readonly string[], env: Env = process.env): Promise<number> {
  let args: Args | 'help';
  try {
    args = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const redact = redactor([env[DEFAULT_API_KEY_ENV]].filter((s): s is string => s !== undefined));
  const matrixFile = path.join(args.out, 'difficulty.json');
  if (existsSync(matrixFile)) {
    process.stderr.write(`${matrixFile} already holds a difficulty run; give a new --out\n`);
    return 2;
  }
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const base = await loadConfig(CONFIG_FILE, {});
    const unpriced = args.models.filter((m) => !isPriced(m, base.prices));
    if (unpriced.length > 0) {
      process.stderr.write(`no known price for ${unpriced.join(', ')}: add prices.<model> with inputPerMTok and outputPerMTok to worldgen.config.json; no other model stands in\n`);
      return 2;
    }
    const tasks = await plan(args, env);
    const proposers = new Map<string, SolverProposer>();
    for (const model of args.models) {
      const config = await loadConfig(CONFIG_FILE, { maxOutputTokens: SOLVER_MAX_OUTPUT_TOKENS, model });
      proposers.set(model, makeModel(config, env, args.transport ?? transportOf(config)));
    }
    await mkdir(args.out, { recursive: true });
    const options = { runId: args.runId, tasks, models: args.models, episodes: args.episodes, budgetUsd: args.budgetUsd, episodeBudgetUsd: args.episodeBudgetUsd };
    const run = await runDifficulty({
      ...options,
      run: localRunner({
        out: args.out, engineCommit: args.engineCommit, maxTurns: args.maxTurns, maxMinutes: args.maxMinutes, maxOutputTokens: SOLVER_MAX_OUTPUT_TOKENS,
        redact, proposers, interrupt: controller.signal,
      }),
      capLeftUsd: modelCapLeft(openLedger(ledgerPath(env)), capsFromEnv(env)),
      interrupt: controller.signal,
      onEpisode: (r) => process.stderr.write(`${redact.text(`${r.runId} ${r.world} ${r.task} ${r.model} #${r.index}: ${r.stopReason}, score ${r.score ?? 'none'}, charged $${r.chargedUsd}`)}\n`),
    });
    const matrix = difficultyMatrix(options, run);
    await writeFile(matrixFile, `${redact.text(JSON.stringify(matrix, null, 2))}\n`);
    await writeFile(path.join(args.out, 'difficulty.md'), redact.text(renderDifficultyMd(matrix)));
    process.stdout.write(`${redact.text(JSON.stringify({ out: args.out, stop: run.stop.kind, episodes: run.rows.length, spent_usd: run.spentUsd, budget_usd: args.budgetUsd }))}\n`);
    return run.stop.kind === 'complete' || run.stop.kind === 'budget_spent' ? 0 : 1;
  } catch (e) {
    process.stderr.write(`${redact.text(messageOf(e))}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
