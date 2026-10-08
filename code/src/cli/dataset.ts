/**
 * `bun run dataset`: one sequential dataset run (YOS-91). Argument parsing, wiring and printing;
 * the work is in dataset/pipeline.ts. The controller reads LLM_KEY for the opt-in SDK and BOAT_API_KEY
 * here, passes the values on only as redaction secrets, and never puts them in the bundle.
 *
 * Exit codes: 0 every task has an accepted episode and every gate passed, 1 a gate failed or the
 * preflight refused, 2 bad usage, 3 the pipeline is sound but some episodes failed.
 *
 * `dataset release-claim` removes the episode-log claim a crashed run left (dataset/store.ts).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ORG_ENV } from '../boat/client.ts';
import { backendFor, sandboxName } from '../sandboxes/registry.ts';
import { nodeRunner, type Runner, type SandboxBackend, type WorldBundle } from '../sandboxes/backend.ts';
import { collectBundle } from '../sandboxes/files.ts';
import { PreflightError, checkInChild, runPipeline, type CheckedForRun, type PipelineResult } from '../dataset/pipeline.ts';
import type { NextTurn } from '../dataset/episode.ts';
import { childGrader, type GraderFactory } from '../dataset/verifier.ts';
import { solverTurn, type SolverProposer } from '../dataset/solver.ts';
import { GRADING_NOTE, redactor, type Redactor } from '../dataset/schema.ts';
import { releaseStaleClaim } from '../dataset/store.ts';
import { DEFAULT_API_KEY_ENV, loadConfig, transportOf, type Config, type Transport } from '../worldgen/config.ts';
import { makeModel } from './models.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '../..');
const CONFIG_FILE = path.join(CODE_DIR, 'worldgen.config.json');
const BOAT_KEY_ENV = 'BOAT_API_KEY';
/** A solver turn is one tool call, so the reply cap is far below the generator's. */
const SOLVER_MAX_OUTPUT_TOKENS = 4096;

export const USAGE = `usage: dataset --world <dir> --out <dir> --run-id <id> --engine-commit <sha> --max-turns <n> --budget-usd <n> --max-minutes <n>

Runs one solver episode per proven task of a checked world, in one Boat sandbox, with
claude-sonnet-5-5 through the logged-in Claude CLI by default. The sandbox serves and uploads
the PUBLIC form of the world only; a separate verifier process (cli/verifier.ts), which holds
the private world and no credential, replays each recorded trace and grades it (YOS-159).
Writes <out>/dataset.jsonl (complete successes), failures.jsonl, manifest.json and REPORT.md,
reopens and validates them, and always stops the sandbox.

  --world <dir>          a world directory the engine checks and proves (for example ../prod/worlds/helpdesk)
  --out <dir>            where logs, the export and the private evidence go
  --run-id <id>          this run's name; reusing one in the same --out is refused
  --engine-commit <sha>  the engine commit the world was proven with, 7 to 64 hex digits
  --max-turns <n>        most model turns per episode
  --budget-usd <n>       most model spend for the whole run
  --max-minutes <n>      wall-clock limit for the episodes; a pending model call is cancelled at it

  --model <id>          the solver's model, default the config's (claude-sonnet-5-5); any Claude model with a known price
  --transport <kind>    claude-cli (default) or sdk; sdk needs ${DEFAULT_API_KEY_ENV}

Needs ${BOAT_KEY_ENV} and ${ORG_ENV} (the one Boat organization this machine bills to, A-247) in the environment. Exit 0 only when every task has an
accepted episode, the export reopened clean and the sandbox stop was confirmed; 3 when the
pipeline is sound but some episodes failed; 1 otherwise; 2 for bad usage.

${GRADING_NOTE}

   or: dataset release-claim --out <dir> --run-id <id>   after a crashed run, see dataset release-claim --help
`;

export const RELEASE_USAGE = `usage: dataset release-claim --out <dir> --run-id <id>

Removes the episode-log claim that a crashed dataset run left, so the run's log takes appends again.
Refuses while the claim's process is alive, when another host took the claim, and when the log does
not validate. Exit 0 when the claim is removed, 1 when it is refused, 2 for bad usage.
`;

export type CliDeps = {
  readonly config?: Config;
  /** Test seams. Absent, the pinned Anthropic model and the Boat backend are built from the environment. */
  readonly proposer?: SolverProposer;
  /** Replaces the whole solver, for tests that script turns directly. */
  readonly nextTurn?: NextTurn;
  /** The world port inside the sandbox. Default 4000. */
  readonly port?: number;
  readonly backend?: SandboxBackend;
  readonly makeBundle?: (frozenDir: string) => Promise<WorldBundle>;
  /** Replaces the verifier child, for tests. Default: childGrader, one process per submission (YOS-159). */
  readonly grader?: GraderFactory;
  readonly fetch?: typeof globalThis.fetch;
  /** Runs the check, prepare and verifier children. Default nodeRunner; tests whose env has no PATH inject one. */
  readonly runner?: Runner;
  /** Where lines go. Default: stdout and stderr. */
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
};
type Env = Readonly<Record<string, string | undefined>>;

type Args = {
  readonly world: string; readonly out: string; readonly runId: string; readonly engineCommit: string;
  readonly maxTurns: number; readonly budgetUsd: number; readonly maxMinutes: number;
  readonly transport?: Transport;
  readonly model?: string;
};
class UsageError extends Error {}

const positive = (flag: string, raw: string, whole: boolean): number => {
  const ok = whole ? /^[1-9]\d*$/.test(raw) : /^\d+(\.\d+)?$/.test(raw) && Number(raw) > 0;
  if (!ok) throw new UsageError(`${flag} must be a positive ${whole ? 'whole number' : 'number'}, got ${JSON.stringify(raw)}`);
  return Number(raw);
};

function parse(argv: readonly string[]): Args | 'help' {
  let p;
  try {
    p = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        world: { type: 'string' }, out: { type: 'string' }, 'run-id': { type: 'string' }, 'engine-commit': { type: 'string' },
        transport: { type: 'string' }, model: { type: 'string' }, 'max-turns': { type: 'string' }, 'budget-usd': { type: 'string' }, 'max-minutes': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (p.values.help === true) return 'help';
  if (p.positionals.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(p.positionals[0])}`);
  const need = (flag: keyof typeof p.values): string => {
    const v = p.values[flag];
    if (typeof v !== 'string' || v === '') throw new UsageError(`--${flag} is required`);
    return v;
  };
  const transport = p.values.transport;
  if (transport !== undefined && transport !== 'claude-cli' && transport !== 'sdk') throw new UsageError('--transport must be claude-cli or sdk');
  return {
    ...(transport === undefined ? {} : { transport }),
    ...(p.values.model === undefined ? {} : { model: p.values.model }),
    world: need('world'), out: need('out'), runId: need('run-id'), engineCommit: need('engine-commit'),
    maxTurns: positive('--max-turns', need('max-turns'), true),
    budgetUsd: positive('--budget-usd', need('budget-usd'), false),
    maxMinutes: positive('--max-minutes', need('max-minutes'), false),
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function releaseClaim(argv: readonly string[], redact: Redactor, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  let p;
  try {
    p = parseArgs({ args: [...argv], options: { out: { type: 'string' }, 'run-id': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) {
    err(`${messageOf(e)}\n${RELEASE_USAGE}`);
    return 2;
  }
  if (p.values.help === true) {
    out(RELEASE_USAGE.trimEnd());
    return 0;
  }
  const dir = p.values.out;
  const runId = p.values['run-id'];
  if (dir === undefined || dir === '' || runId === undefined || runId === '') {
    err(`--out and --run-id are required\n${RELEASE_USAGE}`);
    return 2;
  }
  try {
    const r = await releaseStaleClaim(dir, runId, redact);
    out(`released ${r.claim}: process ${r.pid} is gone and the log holds ${r.episodes} valid episode(s)`);
    return 0;
  } catch (e) {
    err(messageOf(e));
    return 1;
  }
}
const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

function summary(r: PipelineResult, tasks: number): string[] {
  return [
    `dataset run ${r.runId}: ${r.status}`,
    `  accepted ${r.accepted} of ${tasks} task(s), failed or missing ${tasks - r.accepted}, model spend $${r.modelCostUsd.toFixed(4)}`,
    `  sandbox ${r.sandbox.id ?? 'not created'}: teardown ${r.sandbox.teardown}`,
    ...(r.manifest === null ? ['  export: none'] : [`  export: ${path.join(r.paths.out, 'dataset.jsonl')} (${r.manifest.counts.accepted}), failures.jsonl (${r.manifest.counts.failed}), manifest.json`]),
    `  report: ${r.paths.report}`,
    `  diagnostics: ${r.paths.diagnostics}`,
    ...r.problems.map((p) => `  problem: ${p}`),
    `  ${GRADING_NOTE}`,
  ];
}

export async function main(argv: readonly string[], env: Env = process.env, deps: CliDeps = {}): Promise<number> {
  let redact = redactor([env[DEFAULT_API_KEY_ENV], env[BOAT_KEY_ENV]].filter((v): v is string => v !== undefined));
  const writeOut = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const writeErr = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const out = (line: string): void => writeOut(redact.text(line));
  const err = (line: string): void => writeErr(redact.text(line));
  if (argv[0] === 'release-claim') return releaseClaim(argv.slice(1), redact, out, err);
  let args: Args | 'help';
  try {
    args = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    out(USAGE.trimEnd());
    return 0;
  }

  let config: Config;
  try {
    config = deps.config ?? (await loadConfig(CONFIG_FILE, { maxOutputTokens: SOLVER_MAX_OUTPUT_TOKENS, ...(args.model === undefined ? {} : { model: args.model }) }));
  } catch (e) {
    err(messageOf(e));
    return 1;
  }
  const transport = args.transport ?? transportOf(config);
  const keyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  const secrets = [env[DEFAULT_API_KEY_ENV], env[keyEnv], env[BOAT_KEY_ENV]].filter((v): v is string => v !== undefined);
  redact = redactor(secrets);

  // Offline first: a world that does not check or prove its tasks needs no key and no sandbox.
  let checked: CheckedForRun;
  try {
    checked = await checkInChild(args.world, deps.runner ?? nodeRunner, env);
  } catch (e) {
    err(e instanceof PreflightError ? e.message : `preflight failed: ${messageOf(e)}`);
    return 1;
  }
  const tasks = checked.tasks.length;

  const missing = [
    ...(transport === 'sdk' && deps.proposer === undefined && deps.nextTurn === undefined && blank(env[keyEnv]) ? [keyEnv] : []),
    ...(deps.backend === undefined && blank(env[BOAT_KEY_ENV]) ? [BOAT_KEY_ENV] : []),
    ...(deps.backend === undefined && blank(env[ORG_ENV]) ? [ORG_ENV] : []),
  ];
  if (missing.length > 0) {
    err(`${missing.join(' and ')} must be set in the environment of this command; none is ever written to a file or uploaded`);
    return 1;
  }

  const controller = new AbortController();
  const onSignal = (): void => {
    if (controller.signal.aborted) process.exit(130);
    err('interrupted: cancelling the pending call, saving what ran and stopping the sandbox (press again to force exit)');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    let nextTurn = deps.nextTurn;
    let backend = deps.backend;
    try {
      if (nextTurn === undefined) nextTurn = solverTurn(deps.proposer ?? makeModel(config, env, transport), args.runId);
      // Signals are handled above, so the registry's exit hook must not turn Ctrl-C into an exit that skips the teardown.
      if (backend === undefined) backend = backendFor('boat', env, nodeRunner, { runId: args.runId, flushOnExit: false }).backend;
    } catch (e) {
      err(messageOf(e));
      return 1;
    }
    let result: PipelineResult;
    try {
      result = await runPipeline(
        {
          worldDir: args.world, out: args.out, runId: args.runId, engineCommit: args.engineCommit, model: config.model,
          maxTurns: args.maxTurns, budgetUsd: args.budgetUsd, maxMinutes: args.maxMinutes,
          secrets, sandboxName: sandboxName(`ds-${args.runId}`), ...(deps.port === undefined ? {} : { port: deps.port }),
        },
        {
          backend, nextTurn,
          makeBundle: deps.makeBundle ?? ((dir) => collectBundle(CODE_DIR, dir, { publicOnly: true })),
          // The production grader: a separate verifier process per submission, spawned through
          // nodeRunner with a clean environment, holding the private world by path (YOS-159).
          grader: deps.grader ?? childGrader({ codeDir: CODE_DIR, out: args.out, runner: deps.runner ?? nodeRunner, launcher: ['bun'], env }),
          checked, runner: deps.runner ?? nodeRunner, env, interrupt: controller.signal, log: (l) => out(l),
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        },
      );
    } catch (e) {
      err(e instanceof PreflightError ? e.message : `dataset run crashed: ${messageOf(e)}`);
      return 1;
    }
    for (const line of summary(result, tasks)) (result.status === 'accepted' ? out : err)(line);
    return result.status === 'accepted' ? 0 : result.status === 'incomplete' ? 3 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
