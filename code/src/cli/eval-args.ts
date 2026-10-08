/**
 * `bun run eval` options: parsing, usage and the refusal a bad command line gets. Pure apart from resolving paths.
 * `--transport`, like `--model`, overrides worldgen.config.json, so the model factory and every run's events read the
 * same transport, as `bun run worldgen` does (YOS-255).
 */
import path from 'node:path';
import { TRANSPORTS, loadConfig, transportOf, type Config, type Transport } from '../worldgen/config.ts';

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

export class UsageError extends Error {}

function positive(flag: string, v: string, integer: boolean): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new UsageError(`${flag} needs a positive ${integer ? 'integer' : 'number'}, got ${v}`);
  }
  return n;
}

function oneOf<T extends string>(flag: string, v: string, allowed: readonly T[]): T {
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new UsageError(`${flag} must be one of ${allowed.join(', ')}, got ${v}`);
  return hit;
}

export function parseEvalArgs(argv: readonly string[], defaultSuite: string): EvalArgs | 'help' {
  const args: EvalArgs = { suite: defaultSuite, only: null, tags: null, dryRun: false, outDir: null, backend: 'local', parallel: 1, overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === '--help' || flag === '-h') return 'help';
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--suite') args.suite = path.resolve(value());
    else if (flag === '--only') args.only = value().split(',').filter((id) => id !== '');
    else if (flag === '--tag') args.tags = value().split(',').filter((t) => t !== '');
    else if (flag === '--model') args.overrides.model = value();
    else if (flag === '--budget-usd') args.overrides.maxCostUsd = positive(flag, value(), false);
    else if (flag === '--max-minutes') args.overrides.maxMinutes = positive(flag, value(), false);
    else if (flag === '--out-dir') args.outDir = path.resolve(value());
    else if (flag === '--transport') args.overrides.transport = oneOf(flag, value(), TRANSPORTS);
    else if (flag === '--backend') args.backend = oneOf<Backend>(flag, value(), ['local', 'boat']);
    else if (flag === '--parallel') args.parallel = positive(flag, value(), true);
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
