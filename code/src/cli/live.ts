/**
 * `bun run live <prompts-dir>`: runs WorldGen on each prompt of the live run, one at a time with
 * the A-48 limits from worldgen.config.json, then checks and verifies the world and writes
 * prod/LIVE-RUN.md. Each run writes under ../eval/runs/<date>-live/<outName>/. A world that is done
 * and passes the engine is moved to ../prod/worlds/<outName>/; a stop or an invalid world stays
 * under eval/runs, so `bun test` never sees it (research/live-run-runbook.md sections 4 and 5).
 * Planning and the table live in worldgen/live.ts; this file reads files and runs the model.
 * Exit codes: 0 every prompt that ran was delivered (or the dry run is ready), 1 otherwise,
 * 2 bad usage or an intake problem, always before any model call.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkWorld, loadWorld, type World } from '#engine';
import { loadConfig, transportOf, type Config } from '../worldgen/config.ts';
import { createEmitter, describeStop } from '../worldgen/events.ts';
import { inputSchema, parseInputArgs, type Input } from '../worldgen/input.ts';
import { commitLabel, delivered, planIntake, renderLiveRun, type LiveCase, type LiveCheck, type LiveMeta, type LiveRow } from '../worldgen/live.ts';
import { nodeRunner, type Runner } from '../sandboxes/backend.ts';
import { runWorldGen, type Job } from '../worldgen/run.ts';
import { loadExampleWorld, makeModel, mtimeOf, writeReport } from './models.ts';
import { CONFIG_FILE, MODEL_OPTIONS, UsageError, modelOverrides, optionValue } from './options.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '../..');
const REPO_DIR = path.resolve(CODE_DIR, '..');
const DEFAULT_REPORT = path.join(REPO_DIR, 'prod/LIVE-RUN.md');

const USAGE = `usage: bun run live <prompts-dir> [options]

Runs WorldGen on every prompt in <prompts-dir> (see ../prod/prompts/README.md), one at a time,
then checks and verifies each world and writes the results table.

options:
  --only <id,...>         run only these prompt ids, such as 03-dental-clinic
  --dry-run               list the prompts and any intake problem; no model call, nothing written
  --commit <sha>          the release commit to print in the table (default: the checkout's git HEAD, with -dirty
                          when it has changes outside prod/prompts, prod/worlds, prod/LIVE-RUN.md and the run's
                          eval/runs/<date>-live folder; unknown when git cannot say)
  --date <YYYY-MM-DD>     run date, used in the artifacts folder name (default: today, UTC)
  --report <file>         the results table (default ../prod/LIVE-RUN.md)
  --worlds-dir <dir>      where delivered worlds go (default ../prod/worlds)
  --out-dir <dir>         where every run writes first (default ../eval/runs/<date>-live)
  --model <id>            override worldgen.config.json model
  --transport <t>         claude-cli (default) or sdk (reads LLM_KEY from the environment)
  --budget-usd <n>        override the per-prompt budget (default: the config's $5, A-48)
  --max-minutes <n>       override the per-prompt time limit (default: the config's 15, A-48)

exit codes: 0 every prompt delivered, 1 a prompt stopped, crashed or failed verify, 2 bad usage or intake
`;

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
const posix = (p: string): string => p.split(path.sep).join('/');
/** Where the dry run says a file goes: relative to the repository root when inside it, else absolute. */
const shown = (p: string): string => {
  const rel = path.relative(REPO_DIR, p);
  return rel.startsWith('..') || path.isAbsolute(rel) ? posix(p) : posix(rel);
};

export type LiveArgs = {
  readonly promptsDir: string;
  readonly only: readonly string[] | null;
  readonly dryRun: boolean;
  /** `--commit`, or null to name the checkout's HEAD. */
  readonly commit: string | null;
  readonly date: string;
  readonly report: string;
  readonly worldsDir: string;
  readonly outDir: string | null;
  readonly overrides: Partial<Config>;
};

export function parseArgs(argv: readonly string[]): LiveArgs | 'help' {
  if (argv.some((a) => a === '--help' || a === '-h')) return 'help';
  const values = new Map<string, string>();
  let dryRun = false;
  let promptsDir: string | undefined;
  const VALUE_FLAGS: readonly string[] = ['--only', '--commit', '--date', '--report', '--worlds-dir', '--out-dir', ...MODEL_OPTIONS];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (VALUE_FLAGS.includes(a)) {
      const v = optionValue(a, argv[++i]);
      if (values.has(a)) throw new UsageError(`${a} is given twice`);
      values.set(a, v);
    } else if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
    else if (promptsDir === undefined) promptsDir = path.resolve(a);
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (promptsDir === undefined) throw new UsageError('give the prompts directory');
  const date = values.get('--date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`--date needs YYYY-MM-DD, got ${date}`);

  const overrides = modelOverrides((o) => values.get(o));

  const only = values.get('--only');
  return {
    promptsDir,
    only: only === undefined ? null : only.split(',').map((s) => s.trim()).filter((s) => s !== ''),
    dryRun,
    commit: values.get('--commit') ?? null,
    date,
    report: path.resolve(values.get('--report') ?? DEFAULT_REPORT),
    worldsDir: path.resolve(values.get('--worlds-dir') ?? path.join(REPO_DIR, 'prod/worlds')),
    outDir: values.has('--out-dir') ? path.resolve(values.get('--out-dir')!) : null,
    overrides,
  };
}

/**
 * The release commit the table names: `explicit` when `--commit` gave one, else the checkout's HEAD from git, labelled
 * by commitLabel. `unknown` when git is missing or cannot read HEAD or the status.
 */
export async function releaseCommit(explicit: string | null, runner: Runner, cwd: string): Promise<string> {
  if (explicit !== null) return explicit;
  const git = async (...args: string[]): Promise<string | null> => {
    try {
      const r = await runner(['git', ...args], { cwd });
      return r.code === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  };
  const head = (await git('rev-parse', '--verify', 'HEAD'))?.trim() ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(head)) return commitLabel(null, '');
  // Every untracked file by name, so a new folder is never collapsed into a parent such as `prod/`.
  const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all');
  return status === null ? commitLabel(null, '') : commitLabel(head, status);
}

/** Every file under `dir` at most one folder deep, as relative POSIX paths. */
async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile()) files.push(e.name);
    else if (e.isDirectory()) {
      for (const f of await readdir(path.join(dir, e.name), { withFileTypes: true })) files.push(`${e.name}/${f.name}${f.isDirectory() ? '/' : ''}`);
    }
  }
  return files;
}

/** What one WorldGen job did, as the table needs it. */
export type RunSummary = { readonly kind: 'done' | 'stopped'; readonly dir: string; readonly costUsd: number; readonly unknownCostCalls?: number; readonly ms: number; readonly stopLine: string };

export type LiveDeps = {
  /** Runs one job. The real one streams events to the console and writes REPORT.md; tests return a canned summary. */
  readonly run: (job: Job) => Promise<RunSummary>;
  /** Loads and checks a saved world; the check's tasks layer verifies every task. */
  readonly verify: (worldDir: string) => Promise<LiveCheck>;
};

/** The input of a case, read from its files. */
async function inputOf(c: LiveCase, promptsDir: string): Promise<Input> {
  const abs = (f: string): string => path.join(promptsDir, ...f.split('/'));
  switch (c.input.kind) {
    case 'description': {
      const text = (await readFile(abs(c.input.file), 'utf8')).trim();
      if (text === '') throw new Error(`${c.input.file} is empty`);
      return inputSchema.parse({ kind: 'description', text });
    }
    case 'openapi': {
      const extra = c.input.argsFile === null ? [] : (await readFile(abs(c.input.argsFile), 'utf8')).split(/\s+/).filter((s) => s !== '');
      return parseInputArgs(['--openapi', abs(c.input.file), ...extra]);
    }
    case 'csv':
      return parseInputArgs(['--csv', ...c.input.files.map(abs)]);
  }
}

/**
 * Runs the planned prompts one at a time and writes the table. Never throws for a prompt: a crash
 * is a row. A prompt whose world is already in `worldsDir` is skipped, so a rerun picks up where it stopped.
 */
export async function runLive(args: LiveArgs, cases: readonly LiveCase[], meta: LiveMeta, deps: LiveDeps): Promise<{ rows: readonly LiveRow[]; code: number }> {
  const runDir = args.outDir ?? path.join(REPO_DIR, 'eval/runs', `${args.date}-live`);
  const rel = (p: string): string => posix(path.relative(REPO_DIR, p));
  const rows: LiveRow[] = [];
  for (const c of cases) {
    const base = { id: c.id, inputKind: c.input.kind, changed: c.changeFile !== null };
    const staged = path.join(runDir, c.outName);
    const final = path.join(args.worldsDir, c.outName);
    const skip = (detail: string): LiveRow => ({ ...base, outcome: 'skipped', detail, check: { kind: 'not_run' }, ms: 0, costUsd: 0, dir: rel(final) });
    if (existsSync(path.join(final, 'world.yaml'))) {
      rows.push(skip(`${rel(final)} already holds a world`));
      continue;
    }
    if (existsSync(staged)) {
      rows.push(skip(`${rel(staged)} already holds an earlier run: move it aside to run again`));
      continue;
    }
    let ms = 0;
    let costUsd = 0;
    let row: LiveRow;
    try {
      const input = await inputOf(c, args.promptsDir);
      let result = await deps.run({ kind: 'create', input, outDir: staged });
      ms += result.ms;
      costUsd += result.costUsd;
      if (result.kind === 'done' && c.changeFile !== null) {
        const request = (await readFile(path.join(args.promptsDir, ...c.changeFile.split('/')), 'utf8')).trim();
        result = await deps.run({ kind: 'iterate', worldDir: result.dir, request });
        ms += result.ms;
        costUsd += result.costUsd;
      }
      if (result.kind === 'stopped') {
        row = { ...base, outcome: 'stopped', detail: result.stopLine, check: { kind: 'not_run' }, ms, costUsd, ...(result.unknownCostCalls ? { unknownCostCalls: result.unknownCostCalls } : {}), dir: rel(staged) };
      } else {
        const check = await deps.verify(result.dir);
        let dir = staged;
        if (check.kind === 'pass') {
          await mkdir(args.worldsDir, { recursive: true });
          await rename(staged, final);
          dir = final;
        }
        row = { ...base, outcome: 'done', detail: check.kind === 'pass' ? '' : 'WorldGen finished but the engine rejects the world (accepted-but-invalid)', check, ms, costUsd, dir: rel(dir) };
      }
    } catch (e) {
      row = { ...base, outcome: 'crashed', detail: message(e), check: { kind: 'not_run' }, ms, costUsd, dir: rel(staged) };
    }
    out(`${c.id}: ${row.outcome}${row.detail === '' ? '' : ` (${row.detail})`}`);
    rows.push(row);
  }
  await mkdir(path.dirname(args.report), { recursive: true });
  await writeFile(args.report, renderLiveRun(meta, rows));
  const ran = rows.filter((r) => r.outcome !== 'skipped');
  return { rows, code: ran.every(delivered) ? 0 : 1 };
}

async function verifyWorld(dir: string): Promise<LiveCheck> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) return { kind: 'fail', codes: unique(loaded.error.map((i) => i.code)) };
  const report = checkWorld(loaded.value);
  if (report.ok) return { kind: 'pass', tasks: Object.keys(report.verdicts).length };
  return { kind: 'fail', codes: unique(report.issues.map((i) => i.code)) };
}

async function main(argv: readonly string[]): Promise<number> {
  let args: LiveArgs | 'help';
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
  if (!existsSync(args.promptsDir)) {
    err(`${args.promptsDir} does not exist`);
    return 2;
  }
  const plan = planIntake(await listFiles(args.promptsDir));
  for (const p of plan.problems) err(p);
  let cases = plan.cases;
  if (args.only !== null) {
    const known = new Set(cases.map((c) => c.id));
    const unknown = args.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      err(`no such prompt: ${unknown.join(', ')}. Known: ${[...known].join(', ') || '(none)'}`);
      return 2;
    }
    cases = cases.filter((c) => args.only!.includes(c.id));
  }
  if (plan.problems.length > 0) return 2;
  if (cases.length === 0) {
    err(`no prompts in ${args.promptsDir}`);
    return 2;
  }
  if (args.dryRun) {
    for (const c of cases) out(`${c.id}  ${c.input.kind}${c.changeFile === null ? '' : ' + change'}  -> ${shown(path.join(args.worldsDir, c.outName))}`);
    if (args.report !== DEFAULT_REPORT) out(`results table -> ${shown(args.report)}`);
    out(`${cases.length} prompts ready. No model was called.`);
    return 0;
  }

  let config: Config;
  let deps: LiveDeps;
  try {
    config = await loadConfig(CONFIG_FILE, args.overrides);
    const model = makeModel(config, process.env, transportOf(config));
    const exampleWorld: World = await loadExampleWorld(config);
    deps = {
      verify: verifyWorld,
      run: async (job) => {
        const outDir = job.kind === 'create' ? job.outDir : job.worldDir;
        const emit = createEmitter(null, { console: true, progress: true });
        const before = await mtimeOf(path.join(outDir, 'REPORT.md'));
        const result = await runWorldGen(job, config, { model, exampleWorld, emit });
        await writeReport(outDir, result, emit.events(), before);
        return { kind: result.kind, dir: result.dir, costUsd: result.costUsd, ms: result.ms,
          ...(result.kind === 'stopped' && result.unknownCostCalls ? { unknownCostCalls: result.unknownCostCalls } : {}),
          stopLine: result.kind === 'stopped' ? describeStop(result.reason) : '' };
      },
    };
  } catch (e) {
    err(message(e));
    return 2;
  }
  const meta: LiveMeta = { date: args.date, commit: await releaseCommit(args.commit, nodeRunner, REPO_DIR), model: config.model, maxCostUsd: config.maxCostUsd, maxMinutes: config.maxMinutes };
  out(`live: ${cases.length} prompts, one at a time (model ${config.model}, budget $${config.maxCostUsd.toFixed(2)} and ${config.maxMinutes} min each)`);
  const { code } = await runLive(args, cases, meta, deps);
  out(`results table: ${args.report}`);
  return code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
