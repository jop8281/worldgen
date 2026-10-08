/**
 * `bun run worldgen`: one command from an input to a world directory. Argument parsing and
 * wiring only: inputs parse through parseInputArgs (input.ts), the run is runWorldGen (run.ts),
 * the stop line is describeStop (events.ts), and REPORT.md is renderReport (report.ts).
 * The model transport is the claude CLI by default; only `--transport sdk` reads a key, from
 * the environment. Nothing here reads a .env file.
 * `--world <dir> "<change request>"` iterates in place: a missing world.yaml is a usage error,
 * and the run itself writes REPORT.md, with the semantic changes, on done and on every stop.
 * Exit codes: 0 done, 1 stopped (the StopReason on one line) or crashed, 2 bad usage or no
 * usable model (missing claude binary or key), always before any model call. The process exits
 * as soon as the run returns.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { World } from '#engine';
import { assertNever } from '#lib/never';
import { loadConfig, transportOf, type Config } from '../worldgen/config.ts';
import { createEmitter, describeStop } from '../worldgen/events.ts';
import { parseFidelityReference } from '../worldgen/fidelity.ts';
import { genDirName, parseInputArgs, type Input } from '../worldgen/input.ts';
import type { Model } from '../worldgen/llm.ts';
import { partialDir, runWorldGen, type Job, type RunResult } from '../worldgen/run.ts';
import { loadExampleWorld, makeModel, mtimeOf, writeReport } from './models.ts';
import { CONFIG_FILE, MODEL_OPTIONS, UsageError, modelOverrides, optionValue } from './options.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '../..');
const WORLDS_DIR = path.resolve(CODE_DIR, '../prod/worlds');

const USAGE = `usage:
  bun run worldgen -- "<description>" [options]
  bun run worldgen -- --openapi <file> [--only <prefix,...>] [options]
  bun run worldgen -- --csv <file...> [options]
  bun run worldgen -- --world <dir> "<change request>" [options]

inputs (exactly one):
  "<description>"         what the software does, in words
  --fidelity <file>       with a description: a frozen reference of the real software it names (eval/fidelity/*.yaml);
                          the world must score at least 0.80 against it, or the last step sends the misses back
  --openapi <file>        an OpenAPI spec
  --only <prefix,...>     with --openapi: keep only paths under these prefixes
  --csv <file...>         one or more CSV files
  --world <dir>           iterate on the world in <dir> in place with a change request: only the stages the change
                          reaches rerun, and world.yaml and plan.yaml change only if the whole run is accepted

options:
  --out <dir>             world directory to write (default ../prod/worlds/gen-<slug-of-input>; not with --world)
  --model <id>            override the model in worldgen.config.json
  --transport <t>         claude-cli (default: the logged-in claude CLI) or sdk (reads LLM_KEY from the environment)
  --budget-usd <n>        override the run budget in USD (maxCostUsd)
  --max-minutes <n>       override the run time limit (maxMinutes)
  -h, --help              print this help

exit codes: 0 done, 1 stopped (the reason is printed on one line), 2 bad usage, or no claude binary or key
`;

/** Options this CLI owns, each with one value. Everything else goes to parseInputArgs. */
const VALUE_OPTIONS = ['--out', '--world', ...MODEL_OPTIONS] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];
const INPUT_FLAGS: ReadonlySet<string> = new Set(['--openapi', '--only', '--csv', '--fidelity']);

type Args =
  | { readonly mode: 'create'; readonly input: Input; readonly outDir: string; readonly overrides: Partial<Config> }
  | { readonly mode: 'iterate'; readonly worldDir: string; readonly request: string; readonly overrides: Partial<Config> };

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function parseArgs(all: readonly string[]): Args | 'help' {
  // `--` ends the options: what follows is the description or the change request, even a word that starts with -.
  const end = all.indexOf('--');
  const argv = end < 0 ? all : all.slice(0, end);
  const text = end < 0 ? [] : all.slice(end + 1).filter((a) => a.trim() !== '');
  if (argv.some((a) => a === '--help' || a === '-h')) return 'help';
  const opts = new Map<ValueOption, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const option = VALUE_OPTIONS.find((o) => o === a);
    if (option !== undefined) {
      const v = optionValue(option, argv[++i]);
      if (opts.has(option)) throw new UsageError(`${option} is given twice`);
      opts.set(option, v);
    } else if (a.startsWith('-') && !INPUT_FLAGS.has(a)) {
      throw new UsageError(`unknown option ${a}`);
    } else if (a.trim() !== '') {
      rest.push(a);
    }
  }

  const overrides = modelOverrides((o) => opts.get(o));

  const world = opts.get('--world');
  if (world !== undefined) {
    if (opts.has('--out')) throw new UsageError('--out does not apply with --world: iterate changes that world in place');
    if (rest.some((a) => INPUT_FLAGS.has(a))) throw new UsageError('--world takes a change request, not --openapi, --csv or --fidelity');
    const request = [...rest, ...text].join(' ').trim();
    if (request === '') throw new UsageError('--world needs a change request');
    return { mode: 'iterate', worldDir: path.resolve(world), request, overrides };
  }

  let input: Input;
  try {
    input = parseInputArgs(text.length === 0 ? rest : [...rest, '--', ...text]);
  } catch (e) {
    throw new UsageError(message(e));
  }
  if (input.kind === 'description' && input.fidelity !== undefined) input = { ...input, fidelity: checkedReference(input.fidelity) };
  const outFlag = opts.get('--out');
  const outDir = outFlag === undefined ? path.join(WORLDS_DIR, genDirName(input)) : path.resolve(outFlag);
  return { mode: 'create', input, outDir, overrides };
}

/** The absolute path of a fidelity reference that reads and parses, or a UsageError that says why not. */
function checkedReference(file: string): string {
  const abs = path.resolve(file);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    throw new UsageError(`--fidelity ${file}: cannot read the file`);
  }
  const parsed = parseFidelityReference(text);
  if (!parsed.ok) throw new UsageError(`--fidelity ${file}: ${parsed.errors.join('; ')}`);
  return abs;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args | 'help';
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`${e.message} (see --help)`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const job: Job = args.mode === 'create'
    ? { kind: 'create', input: args.input, outDir: args.outDir }
    : { kind: 'iterate', worldDir: args.worldDir, request: args.request };
  const outDir = job.kind === 'create' ? job.outDir : job.worldDir;
  const hasWorld = existsSync(path.join(outDir, 'world.yaml'));
  if (job.kind === 'create' && hasWorld) {
    err(`${outDir} already holds a world.yaml: pass another --out, or --world to iterate on it`);
    return 2;
  }
  if (job.kind === 'iterate' && !hasWorld) {
    err(`${outDir} has no world.yaml: --world iterates on an existing world`);
    return 2;
  }

  let config: Config;
  let model: Model;
  let exampleWorld: World;
  try {
    config = await loadConfig(CONFIG_FILE, args.overrides);
    model = makeModel(config, process.env, transportOf(config));
    exampleWorld = await loadExampleWorld(config);
  } catch (e) {
    err(message(e));
    return 2;
  }

  out(`worldgen: ${job.kind === 'create' ? `${job.input.kind} input into` : 'change request on'} ${outDir} (model ${config.model}, transport ${transportOf(config)}, budget $${config.maxCostUsd.toFixed(2)}, ${config.maxMinutes} min)`);
  const emit = createEmitter(null, { console: true, progress: true });
  const reportBefore = await mtimeOf(path.join(outDir, 'REPORT.md'));
  // The first SIGINT or SIGTERM (Ctrl-C, or Studio's stop) ends the run cleanly: the call is cancelled and billed,
  // and REPORT.md says it was stopped. A second one exits at once (A-279).
  const stop = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stop.signal.aborted) process.exit(signal === 'SIGINT' ? 130 : 143);
    err(`worldgen: ${signal}, stopping after the current call is cancelled (send it again to quit now)`);
    stop.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let result: RunResult;
  try {
    result = await runWorldGen(job, config, { model, exampleWorld, emit, signal: stop.signal });
  } catch (e) {
    err(`worldgen crashed: ${message(e)}${job.kind === 'create' ? `; ${outDir} is unchanged, the run's evidence is in ${partialDir(outDir)}` : ''}`);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  // A stopped create leaves <out> untouched and its REPORT.md in the partial dir that result.dir names (A-293).
  const report = await writeReport(result.dir, result, emit.events(), result.dir === outDir ? reportBefore : null);

  switch (result.kind) {
    case 'done':
      out(`done: ${outDir} with ${Object.keys(result.report.verdicts).length} verified tasks, $${result.costUsd.toFixed(4)}, ${(result.ms / 1000).toFixed(1)}s; report ${report}`);
      return 0;
    case 'stopped':
      err(`stopped: ${describeStop(result.reason)}`);
      out(`report ${report}`);
      return 1;
    default:
      return assertNever(result);
  }
}

// Exit once the run has returned and REPORT.md is written. A handle still open, such as an abandoned claude child's pipes, must not keep the process alive after run_finished.
const code = await main(process.argv.slice(2));
await new Promise<void>((done) => process.stdout.write('', () => process.stderr.write('', () => done())));
process.exit(code);
