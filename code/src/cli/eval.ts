/**
 * `bun run eval`: runs eval/suite.yaml through runWorldGen into
 * eval/runs/<YYYY-MM-DD>-<suite>/ and writes summary.md there. Argument parsing and wiring
 * only; suite parsing, case sequencing and the scorecard live in worldgen/eval.ts.
 * Exit codes: 0 every selected case passed (or, with --dry-run, is ready), 1 otherwise, 2 bad usage.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, loadWorld, worldSchema } from '#engine';
import { fidelityScore, parseFidelityReference, type FidelityReference } from '../worldgen/fidelity.ts';
import { type Config } from '../worldgen/config.ts';
import { evalConfig, parseEvalArgs, USAGE, type EvalArgs } from './eval-args.ts';
import { CONFIG_FILE, UsageError } from './options.ts';
import {
  caseLayout,
  fidelityCell,
  inputPaths,
  parseEventLog,
  parseSuite,
  readCaseFile,
  renderSummary,
  type SummaryEntry,
  resolveInput,
  runCase,
  runName,
  selectByTag,
  selectCases,
  summarizeCase,
  type CaseFile,
  type FidelityResult,
  type Suite,
  type SuiteCase,
  type VerifyResult,
} from '../worldgen/eval.ts';
import { createEmitter } from '../worldgen/events.ts';
import { digestInput } from '../worldgen/input.ts';
import { stopLiveClaudes, type Model } from '../worldgen/llm.ts';
import type { World } from '#engine';
import { loadExampleWorld, makeModel } from './models.ts';
import { runWorldGen } from '../worldgen/run.ts';
import { withEvalAttempt } from './eval-retention.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '../..');
const DEFAULT_SUITE = path.resolve(CODE_DIR, '../eval/suite.yaml');
const RUNS_DIR = path.resolve(CODE_DIR, '../eval/runs');

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const err = (line: string): void => void process.stderr.write(`${line}\n`);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));


/** Why a case cannot run, or null when its input files exist and digest. */
async function caseProblem(c: SuiteCase, baseDir: string): Promise<string | null> {
  const missing: string[] = [];
  for (const p of inputPaths(c.input)) {
    try {
      await access(path.resolve(baseDir, p));
    } catch {
      missing.push(p);
    }
  }
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  const digest = await digestInput(resolveInput(c.input, baseDir));
  return digest.ok ? null : `input does not digest: ${digest.why}`;
}

/** Reads every case's eval/fidelity/<id>.yaml. A missing file means no reference. A bad parse or a `case` that is not the file stem is a problem. */
async function loadReferences(
  fidelityDir: string,
  cases: readonly SuiteCase[],
): Promise<{ refs: Map<string, FidelityReference>; problems: Map<string, string> }> {
  const refs = new Map<string, FidelityReference>();
  const problems = new Map<string, string>();
  for (const c of cases) {
    const text = await readFile(path.join(fidelityDir, `${c.id}.yaml`), 'utf8').catch(() => null);
    if (text === null) continue;
    const parsed = parseFidelityReference(text);
    if (!parsed.ok) problems.set(c.id, `fidelity reference ${c.id}.yaml: ${parsed.errors.join('; ')}`);
    else if (parsed.reference.case !== c.id) problems.set(c.id, `fidelity reference ${c.id}.yaml: case is ${parsed.reference.case}, expected ${c.id}`);
    else refs.set(c.id, parsed.reference);
  }
  return { refs, problems };
}

async function dryRun(suiteFile: string, cases: readonly SuiteCase[]): Promise<number> {
  out(`dry run: ${cases.length} cases from ${suiteFile}, no model call`);
  let ready = 0;
  const { problems } = await loadReferences(path.join(path.dirname(suiteFile), 'fidelity'), cases);
  for (const c of cases) {
    const why = (await caseProblem(c, path.dirname(suiteFile))) ?? problems.get(c.id) ?? null;
    if (why === null) ready++;
    out(why === null ? `ok    ${c.id} (${c.input.kind}${c.change === undefined ? '' : ' + change'})` : `fail  ${c.id}: ${why}`);
  }
  out(`${ready} of ${cases.length} cases ready`);
  return ready === cases.length ? 0 : 1;
}

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

async function verifyWorld(dir: string): Promise<VerifyResult> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) return { kind: 'fail', codes: unique(loaded.error.map((i) => i.code)) };
  const report = checkWorld(loaded.value);
  if (report.ok) return { kind: 'pass', tasks: Object.keys(report.verdicts).length };
  return { kind: 'fail', codes: unique(report.issues.map((i) => i.code)) };
}

/** Structural fidelity of a case's saved world: independent of check and verify, so a world that fails them still scores. */
async function fidelityOf(ref: FidelityReference, file: CaseFile, worldDir: string): Promise<FidelityResult> {
  if (file.verify.kind === 'not_run') return { kind: 'no_world', why: 'last phase did not finish' };
  const loaded = await loadWorld(worldDir);
  if (!loaded.ok) return { kind: 'no_world', why: `world.yaml does not load: ${loaded.error[0]?.code ?? 'unknown'}` };
  const parsed = worldSchema.safeParse(loaded.value);
  if (!parsed.success) return { kind: 'no_world', why: `world does not parse: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  return { kind: 'scored', fidelity: fidelityScore(ref, parsed.data) };
}

/** Every suite case with a case.json in runDir, so a rerun with --only keeps the other rows. */
/** One entry per suite case, the expected set: its record, or that its case.json is missing or invalid. */
async function collect(runDir: string, suite: Suite, refs: ReadonlyMap<string, FidelityReference>): Promise<SummaryEntry[]> {
  const records: SummaryEntry[] = [];
  for (const c of suite.cases) {
    const layout = caseLayout(runDir, c.id);
    const text = await readFile(layout.caseFile, 'utf8').catch(() => null);
    if (text === null) {
      records.push({ kind: 'missing', id: c.id, expect: c.expect });
      continue;
    }
    const read = readCaseFile(text);
    if (!read.ok) {
      err(`invalid ${layout.caseFile}: ${read.why}`);
      records.push({ kind: 'invalid', id: c.id, expect: c.expect, why: read.why });
      continue;
    }
    const phases = [];
    for (const p of read.file.phases) {
      phases.push({ ...p, log: parseEventLog(await readFile(layout.events[p.phase], 'utf8').catch(() => '')) });
    }
    const ref = refs.get(c.id);
    records.push({ kind: 'record', record: { ...read.file, phases, ...(ref === undefined ? {} : { fidelity: await fidelityOf(ref, read.file, layout.world) }) } });
  }
  return records;
}

async function runSuite(args: EvalArgs, suiteFile: string, suite: Suite, cases: readonly SuiteCase[]): Promise<number> {
  let config: Config;
  let model: Model;
  let exampleWorld: World;
  try {
    const setup = await evalConfig(CONFIG_FILE, args.overrides);
    config = setup.config;
    model = makeModel(config, process.env, setup.transport);
    exampleWorld = await loadExampleWorld(config);
  } catch (e) {
    err(message(e));
    return 1;
  }
  // Every suite case, because collect renders every row that has a case.json, not only the --only selection.
  const { refs, problems } = await loadReferences(path.join(path.dirname(suiteFile), 'fidelity'), suite.cases);
  const selectedProblems = [...problems.values()];
  if (selectedProblems.length > 0) {
    for (const why of selectedProblems) err(why);
    return 2;
  }
  const date = new Date().toISOString().slice(0, 10);
  const runDir = args.outDir ?? path.join(RUNS_DIR, runName(date, suite.name));
  const meta = { run: path.basename(runDir), suite: suite.name, model: config.model, budgetUsd: config.maxCostUsd, maxMinutes: config.maxMinutes };
  await mkdir(runDir, { recursive: true });
  out(`eval: ${cases.length} cases from ${suiteFile} into ${runDir}`);
  const passed = new Map<string, boolean>();
  for (const c of cases) {
    try {
      await withEvalAttempt(runDir, c.id, async (layout) => {
        // A description case with a frozen reference is gated on it, as `worldgen --fidelity` is (A-258).
        const gated = c.input.kind === 'description' && refs.has(c.id) ? { ...c, input: { ...c.input, fidelity: path.join(path.dirname(suiteFile), 'fidelity', `${c.id}.yaml`) } } : c;
        const file = await runCase(gated, path.dirname(suiteFile), layout, {
          run: (job, phase) => runWorldGen(job, config, { model, exampleWorld, emit: createEmitter(layout.logDir[phase], { console: true }) }),
          verify: verifyWorld,
        });
        await writeFile(layout.caseFile, `${JSON.stringify(file, null, 2)}\n`);
        const records = await collect(runDir, suite, refs);
        await writeFile(path.join(runDir, 'summary.md'), renderSummary(meta, records));
        const entry = records.find((r) => r.kind === 'record' && r.record.id === c.id);
        const record = entry?.kind === 'record' ? entry.record : undefined;
        const row = record === undefined ? null : summarizeCase(record);
        passed.set(c.id, row?.pass ?? false);
        out(row === null ? `${c.id}: no record` : `${c.id}: ${row.status}, ${row.stop}, verify ${row.verify}${row.fidelity === null ? '' : `, fidelity ${fidelityCell(row.fidelity)}`}, ${row.pass ? 'pass' : 'fail'}`);
      }, (retained) => out(`retained ${c.id}: ${retained}`));
    } catch (error) {
      err(`eval ${c.id}: ${message(error)}`);
      return 1;
    }
  }
  const ok = [...passed.values()].filter(Boolean).length;
  out(`${ok} of ${cases.length} cases passed; summary in ${path.join(runDir, 'summary.md')}`);
  return ok === cases.length ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  let args: EvalArgs | 'help';
  try {
    args = parseEvalArgs(argv, DEFAULT_SUITE);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const text = await readFile(args.suite, 'utf8').catch((e: unknown) => {
    err(`cannot read suite ${args.suite}: ${message(e)}`);
    return null;
  });
  if (text === null) return 2;
  const parsed = parseSuite(text);
  if (!parsed.ok) {
    err(`invalid suite ${args.suite}:\n${parsed.errors.join('\n')}`);
    return 1;
  }
  const selected = selectCases(parsed.suite, args.only);
  if (!selected.ok) {
    process.stderr.write(`unknown case id: ${selected.unknown.join(', ')}\n${USAGE}`);
    return 2;
  }
  const tagged = args.tags === null ? selected : selectByTag(selected.cases, args.tags);
  if (!tagged.ok) {
    process.stderr.write(`unknown tag: ${tagged.unknown.join(', ')}\n${USAGE}`);
    return 2;
  }
  return args.dryRun ? dryRun(args.suite, tagged.cases) : runSuite(args, args.suite, parsed.suite, tagged.cases);
}

// SIGTERM or Ctrl-C ends eval, and a claude -p child it spawned would otherwise keep running and billing.
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  process.once(signal, () => {
    void stopLiveClaudes().then((n) => {
      err(`eval: ${signal}, stopped ${n} claude process${n === 1 ? '' : 'es'}`);
      process.exit(code);
    });
  });
}

process.exitCode = await main(process.argv.slice(2));
