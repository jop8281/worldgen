/**
 * `bun run episode`: one agent episode of one task on this machine (YOS-190), for the studio's
 * Agent Playground. Argument parsing and wiring; the work is in dataset/local.ts. The studio spawns
 * this as a child, so the studio itself never makes a model call.
 *
 * Exit codes: 0 the episode was graded, exported and reopened (whatever its score), 1 the run
 * failed, 2 bad usage.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { NextTurn } from '../dataset/episode.ts';
import { finishAtOnce, runLocalEpisode } from '../dataset/local.ts';
import { GRADING_NOTE, redactor } from '../dataset/schema.ts';
import { solverTurn } from '../dataset/solver.ts';
import { DEFAULT_API_KEY_ENV, DEFAULT_MODEL, loadConfig, transportOf, type Transport } from '../worldgen/config.ts';
import { makeModel } from './models.ts';
import { CONFIG_FILE, UsageError, positiveNumber, transportOption } from './options.ts';

/** A solver turn is one tool call, so the reply cap is far below the generator's. */
const SOLVER_MAX_OUTPUT_TOKENS = 4096;
/** The agents an episode can run. `noop` finishes at once and costs nothing; `sonnet` runs DEFAULT_MODEL, whatever config's model, and spends. */
export const AGENTS = ['noop', 'sonnet'] as const;
export type Agent = (typeof AGENTS)[number];
/** The model each agent calls, recorded on its episode. The noop agent calls none. */
const AGENT_MODEL: Record<Agent, string | null> = { noop: null, sonnet: DEFAULT_MODEL };

export const USAGE = `usage: episode --world <dir> --task <id> --out <dir> --run-id <id> --engine-commit <sha> [options]
Runs one agent episode of one proven task on this machine: the engine serves the world on loopback,
the agent sees only the world port and the public OpenAPI document, and the engine grades the end
state. Writes <out>/dataset.jsonl or failures.jsonl with manifest.json, reopens them, and prints
one JSON line with the episode id, stop reason, score and spend.
  --world <dir>        a world directory the engine checks and proves
  --task <id>          the task to run
  --out <dir>          where the frozen world, the episode log, private evidence and the export go
  --run-id <id>        this episode's run name; reusing one in the same --out is refused
  --engine-commit <sha> the engine commit this episode runs, 7 to 64 hex digits
  --agent <a>          noop (default: finishes at once, free) or sonnet (claude-sonnet-5-5, spends)
  --max-turns <n>      most agent turns (default 12)
  --budget-usd <n>     most model spend (default 0.5)
  --max-minutes <n>    wall-clock limit (default 5)
  --transport <t>      claude-cli (default) or sdk; sdk needs ${DEFAULT_API_KEY_ENV}
${GRADING_NOTE}`;

type Env = Readonly<Record<string, string | undefined>>;
export type Args = {
  readonly world: string; readonly task: string; readonly out: string; readonly runId: string; readonly engineCommit: string; readonly agent: Agent;
  readonly maxTurns: number; readonly budgetUsd: number; readonly maxMinutes: number; readonly transport: Transport | undefined;
};

const positive = (flag: string, v: string | undefined, fallback: number): number => (v === undefined ? fallback : positiveNumber(flag, v));

export function parse(argv: readonly string[]): Args | 'help' {
  let v: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values: v } = parseArgs({
      args: [...argv],
      options: {
        world: { type: 'string' }, task: { type: 'string' }, out: { type: 'string' }, 'run-id': { type: 'string' }, 'engine-commit': { type: 'string' }, agent: { type: 'string' },
        'max-turns': { type: 'string' }, 'budget-usd': { type: 'string' }, 'max-minutes': { type: 'string' }, transport: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
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
  const engineCommit = need('engine-commit');
  if (!/^[0-9a-f]{7,64}$/.test(engineCommit)) throw new UsageError(`--engine-commit must be 7 to 64 lowercase hex digits, got ${engineCommit}`);
  const agent = (v['agent'] as string | undefined) ?? 'noop';
  if (!(AGENTS as readonly string[]).includes(agent)) throw new UsageError(`--agent must be one of ${AGENTS.join(', ')}, got ${agent}`);
  const given = v['transport'] as string | undefined;
  const transport = given === undefined ? undefined : transportOption('--transport', given);
  return {
    world: path.resolve(need('world')), task: need('task'), out: path.resolve(need('out')), runId: need('run-id'), engineCommit, agent: agent as Agent,
    maxTurns: Math.floor(positive('--max-turns', v['max-turns'] as string | undefined, 12)),
    budgetUsd: positive('--budget-usd', v['budget-usd'] as string | undefined, 0.5),
    maxMinutes: positive('--max-minutes', v['max-minutes'] as string | undefined, 5),
    transport,
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
  const secrets = [env[DEFAULT_API_KEY_ENV]].filter((s): s is string => s !== undefined);
  const redact = redactor(secrets);
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    let nextTurn: NextTurn = finishAtOnce;
    if (args.agent === 'sonnet') {
      const config = await loadConfig(CONFIG_FILE, { maxOutputTokens: SOLVER_MAX_OUTPUT_TOKENS, model: DEFAULT_MODEL });
      nextTurn = solverTurn(makeModel(config, env, args.transport ?? transportOf(config)), args.runId);
    }
    const r = await runLocalEpisode({
      worldDir: args.world, taskId: args.task, out: args.out, runId: args.runId, engineCommit: args.engineCommit, model: AGENT_MODEL[args.agent], nextTurn,
      maxTurns: args.maxTurns, budgetUsd: args.budgetUsd, maxMinutes: args.maxMinutes, redact, interrupt: controller.signal,
    });
    const e = r.episode;
    process.stdout.write(`${redact.text(JSON.stringify({ episode_id: e.episode_id, task_id: e.task_id, agent: args.agent, stop_reason: e.stop_reason, score: e.score, cost_usd: e.usage.cost_usd, out: args.out, reopened: true }))}\n`);
    return 0;
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
