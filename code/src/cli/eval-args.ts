/**
 * `bun run eval` options: parsing, usage and the refusal a bad command line gets. Pure apart from resolving paths.
 * `--transport`, like `--model`, overrides worldgen.config.json, so the model factory and every run's events read the
 * same transport, as `bun run worldgen` does (YOS-255).
 */
import path from 'node:path';
import { loadConfig, transportOf, type Config, type Transport } from '../worldgen/config.ts';
import { UsageError, isModelOption, modelOverride, oneOf, optionValue } from './options.ts';

export const BOAT_PENDING = 'boat fan-out lands with sandbox backends';

export const USAGE = `usage: bun run eval -- [options]

options:
  --suite <file>          suite file (default ../eval/suite.yaml)
  --only <id,...>         run only these case ids
  --tag <tag,...>         run only the cases that carry any of these tags (after --only)
  --dry-run               validate the suite and its input files; no model call, nothing written
  --model <id>            override worldgen.config.json model
  --budget-usd <n>        override the per-run budget (maxCostUsd)
  --max-minutes <n>       override the per-run time limit
  --out-dir <dir>         run directory (default ../eval/runs/<YYYY-MM-DD>-<suite>)
  --transport <t>         claude-cli or sdk (reads LLM_KEY from the environment); default worldgen.config.json's transport
  --backend <b>           local (default) or boat; ${BOAT_PENDING}
  --parallel <n>          cases at once (default 1); above 1 needs --backend boat
`;

export type Backend = 'local' | 'boat';
/** A parsed command line. `--transport` is a config override, like `--model`, so the model and the run's events read one transport (YOS-255). */
export type EvalArgs = {
  suite: string;
  only: readonly string[] | null;
  tags: readonly string[] | null;
  dryRun: boolean;
  outDir: string | null;
  backend: Backend;
  parallel: number;
  overrides: Partial<Config>;
};

function positiveInteger(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} needs a positive integer, got ${v}`);
  return n;
}

export function parseEvalArgs(argv: readonly string[], defaultSuite: string): EvalArgs | 'help' {
  const args: EvalArgs = { suite: defaultSuite, only: null, tags: null, dryRun: false, outDir: null, backend: 'local', parallel: 1, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    // Unlike worldgen, live and studio, eval takes a blank value such as --model "", and the config load refuses it
    // later; dataset passes one on too. Kept as it is (YOS-203).
    const value = (): string => optionValue(flag, argv[++i], 'accept');
    if (flag === '--help' || flag === '-h') return 'help';
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--suite') args.suite = path.resolve(value());
    else if (flag === '--only') args.only = value().split(',').filter((id) => id !== '');
    else if (flag === '--tag') args.tags = value().split(',').filter((t) => t !== '');
    else if (isModelOption(flag)) Object.assign(args.overrides, modelOverride(flag, value()));
    else if (flag === '--out-dir') args.outDir = path.resolve(value());
    else if (flag === '--backend') args.backend = oneOf<Backend>(flag, value(), ['local', 'boat']);
    else if (flag === '--parallel') args.parallel = positiveInteger(flag, value());
    else if (flag.startsWith('-')) throw new UsageError(`unknown option ${flag}`);
    else throw new UsageError(`unexpected argument ${flag}`);
  }
  if (args.only !== null && args.only.length === 0) throw new UsageError('--only needs at least one case id');
  if (args.tags !== null && args.tags.length === 0) throw new UsageError('--tag needs at least one tag');
  if (args.backend === 'boat') throw new UsageError(`--backend boat is not available yet: ${BOAT_PENDING}`);
  if (args.parallel > 1) throw new UsageError(`--parallel above 1 needs --backend boat (${BOAT_PENDING}); the local backend runs cases one at a time`);
  return args;
}

/**
 * The config an eval run uses and the transport its model is built with: one value, read from `configFile` with the
 * command line's overrides, so the model factory, run_started and capsule.json never disagree (YOS-255).
 */
export async function evalConfig(configFile: string, overrides: Partial<Config>): Promise<{ readonly config: Config; readonly transport: Transport }> {
  const config = await loadConfig(configFile, overrides);
  return { config, transport: transportOf(config) };
}
