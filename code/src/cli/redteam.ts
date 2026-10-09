/**
 * `bun run redteam`: the red-team run (A-404). Every task of every world under --worlds runs once on loopback
 * (dataset/local.ts) with the red-team solver, which sees only the public world and makes a near-miss of the task on
 * purpose, wrong in one important way. Each row goes to <out>/results.jsonl as its task ends, so a stopped run resumes where it
 * stopped, and <out>/summary.md is rendered from the rows. Argument parsing and wiring; the report is dataset/redteam.ts.
 *
 * Exit codes: 0 every task ran, 1 the run stopped early or failed, 2 bad usage.
 */
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadWorld } from '#engine';
import { runLocalEpisode } from '../dataset/local.ts';
import { renderRedteamSummary, rowOf, type RedteamRow } from '../dataset/redteam.ts';
import { redactor } from '../dataset/schema.ts';
import { PROMPT_VERSION_OF, solverTurn, type SolverProposer } from '../dataset/solver.ts';
import { DEFAULT_API_KEY_ENV, loadConfig, transportOf, type Transport } from '../worldgen/config.ts';
import { makeModel } from './models.ts';
import { CONFIG_FILE, UsageError, positiveNumber, transportOption } from './options.ts';

/** A solver turn is one tool call, so the reply cap is far below the generator's. */
const SOLVER_MAX_OUTPUT_TOKENS = 4096;

export const USAGE = `usage: redteam --worlds <dir> --out <dir> --work <dir> --engine-commit <sha> [options]
Runs every task of every world under --worlds once, on loopback, with the red-team solver (A-404): it sees
only the public world and makes a near-miss of the task on purpose, wrong in one important way, so a full
score is a candidate grader bug. Appends one row per task to <out>/results.jsonl as it ends (a rerun skips tasks
already there), and writes <out>/summary.md. Stops at the first model error, such as a spend cap refusal.
  --worlds <dir>        a directory of world directories (for example ../prod/worlds)
  --out <dir>           where results.jsonl, run.json and summary.md go
  --work <dir>          where each world's frozen copy, episode logs and private evidence go; keep it out of the repo
  --engine-commit <sha> the engine commit this run uses, 7 to 64 hex digits
  --model <id>          the solver's model, default the config's; any Claude model with a known price
  --max-turns <n>       most agent turns per task (default 10)
  --budget-usd <n>      most model spend per task (default 0.15); the ledger caps the whole run
  --max-minutes <n>     wall-clock limit per task (default 5)
  --transport <t>       claude-cli (default) or sdk; sdk needs ${DEFAULT_API_KEY_ENV}
  --only <list>         comma-separated <world> or <world>/<task> to run, default all
  --triage <file>       a JSON object of notes per fooled <world>/<task>, rendered into summary.md
  --render-only         write summary.md from results.jsonl and run.json, and run nothing`;

type Env = Readonly<Record<string, string | undefined>>;
export type Args = {
  readonly worlds: string; readonly out: string; readonly work: string; readonly engineCommit: string; readonly model: string | undefined;
  readonly maxTurns: number; readonly budgetUsd: number; readonly maxMinutes: number; readonly transport: Transport | undefined;
  readonly only: readonly string[]; readonly triage: string | undefined; readonly renderOnly: boolean;
};
/** Test seams. Absent, the model is built from config and the environment. */
export type RedteamDeps = { readonly proposer?: SolverProposer; readonly out?: (line: string) => void; readonly err?: (line: string) => void };
type RunMeta = { readonly date: string; readonly model: string; readonly engineCommit: string };

const positive = (flag: string, v: string | undefined, fallback: number): number => (v === undefined ? fallback : positiveNumber(flag, v));

export function parse(argv: readonly string[]): Args | 'help' {
  let v: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values: v } = parseArgs({
      args: [...argv],
      options: {
        worlds: { type: 'string' }, out: { type: 'string' }, work: { type: 'string' }, 'engine-commit': { type: 'string' }, model: { type: 'string' },
        'max-turns': { type: 'string' }, 'budget-usd': { type: 'string' }, 'max-minutes': { type: 'string' }, transport: { type: 'string' },
        only: { type: 'string' }, triage: { type: 'string' }, 'render-only': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (v['help'] === true) return 'help';
  const need = (k: string): string => {
    const x = v[k];
    if (typeof x !== 'string' || x.trim() === '') throw new UsageError(`--${k} is required`);
    return x;
  };
  const renderOnly = v['render-only'] === true;
  const engineCommit = renderOnly ? '' : need('engine-commit');
  if (!renderOnly && !/^[0-9a-f]{7,64}$/.test(engineCommit)) throw new UsageError(`--engine-commit must be 7 to 64 lowercase hex digits, got ${engineCommit}`);
  const given = v['transport'] as string | undefined;
  const only = typeof v['only'] === 'string' ? v['only'].split(',').map((s) => s.trim()).filter((s) => s !== '') : [];
  return {
    worlds: renderOnly ? '' : path.resolve(need('worlds')), out: path.resolve(need('out')), work: renderOnly ? '' : path.resolve(need('work')), engineCommit,
    model: v['model'] as string | undefined,
    maxTurns: Math.floor(positive('--max-turns', v['max-turns'] as string | undefined, 10)),
    budgetUsd: positive('--budget-usd', v['budget-usd'] as string | undefined, 0.15),
    maxMinutes: positive('--max-minutes', v['max-minutes'] as string | undefined, 5),
    transport: given === undefined ? undefined : transportOption('--transport', given),
    only, triage: v['triage'] as string | undefined, renderOnly,
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
};
async function readRows(file: string): Promise<RedteamRow[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as RedteamRow);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return [];
    throw e;
  }
}

/** The task ids of the world in `dir`, in its order, from world.yaml as written; the prepare child checks it before a task runs. */
async function taskIds(dir: string): Promise<string[]> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) throw new Error(`${dir}: ${loaded.error[0].code}: ${loaded.error[0].found}`);
  const tasks = typeof loaded.value === 'object' && loaded.value !== null ? (loaded.value as { tasks?: unknown }).tasks : undefined;
  return typeof tasks === 'object' && tasks !== null ? Object.keys(tasks) : [];
}

async function render(o: { out: string; meta: RunMeta; triage: string | undefined }): Promise<RedteamRow[]> {
  const rows = await readRows(path.join(o.out, 'results.jsonl'));
  const triage = o.triage === undefined ? undefined : ((await readJson<Record<string, string>>(o.triage)) ?? undefined);
  await writeFile(path.join(o.out, 'summary.md'), renderRedteamSummary({ ...o.meta, rows, ...(triage === undefined ? {} : { triage }) }));
  return rows;
}

export async function main(argv: readonly string[], env: Env = process.env, deps: RedteamDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  let args: Args | 'help';
  try {
    args = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    out(USAGE);
    return 0;
  }
  const redact = redactor([env[DEFAULT_API_KEY_ENV]].filter((s): s is string => s !== undefined));
  const metaFile = path.join(args.out, 'run.json');
  try {
    if (args.renderOnly) {
      const meta = await readJson<RunMeta>(metaFile);
      if (meta === null) throw new Error(`no ${metaFile}: nothing has run in ${args.out}`);
      const rows = await render({ out: args.out, meta, triage: args.triage });
      out(`wrote ${path.join(args.out, 'summary.md')} from ${rows.length} row(s)`);
      return 0;
    }
    const config = await loadConfig(CONFIG_FILE, { maxOutputTokens: SOLVER_MAX_OUTPUT_TOKENS, ...(args.model === undefined ? {} : { model: args.model }) });
    const proposer = deps.proposer ?? makeModel(config, env, args.transport ?? transportOf(config));
    await mkdir(args.out, { recursive: true });
    const meta: RunMeta = (await readJson<RunMeta>(metaFile)) ?? { date: new Date().toISOString().slice(0, 10), model: config.model, engineCommit: args.engineCommit };
    if (meta.model !== config.model || meta.engineCommit !== args.engineCommit) {
      throw new Error(`${metaFile} is a run of ${meta.model} on ${meta.engineCommit}; resume it with the same model and engine commit, or use a new --out`);
    }
    await writeFile(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
    const results = path.join(args.out, 'results.jsonl');
    const done = new Set((await readRows(results)).map((r) => `${r.world}/${r.task}`));
    const worlds = (await readdir(args.worlds, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    // Run ids must be new in each world's work dir, so a resumed run gets a fresh prefix.
    const prefix = `rt${Date.now().toString(36)}`;
    let n = 0;
    let stopped = false;
    for (const world of worlds) {
      for (const task of await taskIds(path.join(args.worlds, world))) {
        const key = `${world}/${task}`;
        if (done.has(key) || (args.only.length > 0 && !args.only.includes(world) && !args.only.includes(key))) continue;
        const runId = `${prefix}-${++n}`;
        const r = await runLocalEpisode({
          worldDir: path.join(args.worlds, world), taskId: task, out: path.join(args.work, world), runId, engineCommit: args.engineCommit,
          model: config.model, promptVersion: PROMPT_VERSION_OF.redteam, nextTurn: solverTurn(proposer, runId, 'redteam'),
          maxTurns: args.maxTurns, budgetUsd: args.budgetUsd, maxMinutes: args.maxMinutes, redact, env,
        });
        const row = rowOf(world, r.episode);
        await appendFile(results, `${redact.text(JSON.stringify(row))}\n`);
        out(`${key} score ${row.score ?? 'none'}${row.fooled ? ' FOOLED' : ''} stop ${row.stopReason} $${row.costUsd.toFixed(4)}`);
        // A model error is a refused or failed call, such as the spend cap; every later call would fail the same way.
        if (row.stopReason === 'model_error') {
          err(`${key}: model_error, so the run stops here; rerun the same command to resume`);
          stopped = true;
          break;
        }
      }
      if (stopped) break;
    }
    const rows = await render({ out: args.out, meta, triage: args.triage });
    out(`wrote ${path.join(args.out, 'summary.md')}: ${rows.filter((r) => r.fooled).length} fooled of ${rows.length}`);
    return stopped ? 1 : 0;
  } catch (e) {
    err(redact.text(messageOf(e)));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
