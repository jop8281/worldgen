/**
 * `bun run scorecards` (YOS-262, A-402): regenerates prod/scorecards.md from committed files only, with no model call
 * and no network. Reading and wiring; the scorecards are in scorecards/cards.ts.
 *
 * Exit codes: 0 written, 1 a source could not be read, 2 bad usage.
 */
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkWorld, loadWorld } from '#engine';
import { parseManifest } from '../dataset/schema.ts';
import { renderScorecards, suiteFor, type DifficultyInput, type ExportInput, type GraderWorld, type RunInput, type ScorecardInputs } from '../scorecards/cards.ts';
import { CASE_ID, parseSuite, type Suite } from '../worldgen/eval.ts';
import { readEvalEvidence } from './eval-analysis-files.ts';

const REPO_DIR = path.resolve(import.meta.dirname, '../../..');
const DEFAULT_OUT = path.join(REPO_DIR, 'prod/scorecards.md');

export const USAGE = `usage: bun run scorecards [--out <file>]
Regenerates the four scorecards (YOS-262, A-402) from committed files only, with no model call and no network, and
writes them to <file> (default ../prod/scorecards.md):
  generator   each eval/runs/<run>/ with case files, scored as bun scripts/analyze-eval.ts scores it against the
              eval/*.yaml suite that holds its cases
  fidelity    the fidelity events those runs recorded, against the 0.80 floor (A-258)
  grader      the engine's check of every world in prod/worlds, which worldplay verify runs
  agent       eval/difficulty/*/difficulty.json and each eval/dataset/<export>/<world>/manifest.json
Exit codes: 0 written, 1 a source could not be read, 2 bad usage.
`;

const rel = (p: string): string => path.relative(REPO_DIR, p).split(path.sep).join('/');
/** The real subdirectories of dir, sorted; none when dir is absent. */
async function dirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    if (!(await lstat(path.join(dir, e))).isSymbolicLink()) out.push(e);
  }
  return out;
}

/** Each eval/*.yaml suite, by repo-relative path. A suite file that does not parse stops the run. */
async function suites(repo: string): Promise<Map<string, Suite>> {
  const evalDir = path.join(repo, 'eval');
  const out = new Map<string, Suite>();
  for (const name of (await readdir(evalDir)).filter((n) => n.endsWith('.yaml')).sort()) {
    const parsed = parseSuite(await readFile(path.join(evalDir, name), 'utf8'));
    if (!parsed.ok) throw new Error(`eval/${name} is not a suite: ${parsed.errors[0]}`);
    out.set(`eval/${name}`, parsed.suite);
  }
  return out;
}

async function gatherRuns(repo: string): Promise<Pick<ScorecardInputs, 'runs' | 'unmatchedRuns' | 'otherRuns'>> {
  const all = await suites(repo);
  const runsDir = path.join(repo, 'eval/runs');
  const runs: RunInput[] = [];
  const unmatchedRuns: string[] = [];
  const otherRuns: string[] = [];
  for (const name of await dirs(runsDir)) {
    const dir = path.join(runsDir, name);
    const ids = (await dirs(dir)).filter((id) => CASE_ID.test(id) && existsSync(path.join(dir, id, 'case.json')));
    if (ids.length === 0) {
      otherRuns.push(rel(dir));
      continue;
    }
    const file = suiteFor(ids, [...all].map(([f, suite]) => ({ file: f, ids: suite.cases.map((c) => c.id) })));
    if (file === null) {
      unmatchedRuns.push(rel(dir));
      continue;
    }
    const suite = all.get(file)!;
    const cases = suite.cases.map((c) => ({ id: c.id, expect: c.expect, ...(c.change === undefined ? {} : { change: c.change }) }));
    runs.push({ run: rel(dir), suite: suite.name, suiteFile: file, cases, evidence: await readEvalEvidence(dir, cases) });
  }
  return { runs, unmatchedRuns, otherRuns };
}

async function gatherWorlds(repo: string): Promise<GraderWorld[]> {
  const root = path.join(repo, 'prod/worlds');
  const out: GraderWorld[] = [];
  for (const name of await dirs(root)) {
    const dir = path.join(root, name);
    if (!existsSync(path.join(dir, 'world.yaml'))) continue;
    const source = rel(path.join(dir, 'world.yaml'));
    const loaded = await loadWorld(dir);
    if (!loaded.ok) {
      out.push({ world: name, source, refused: loaded.error[0].found });
      continue;
    }
    const report = checkWorld(loaded.value, loaded.lines);
    if (!report.ok) {
      out.push({ world: name, source, refused: `${report.issues[0].code} at ${report.issues[0].path.join('.')}` });
      continue;
    }
    out.push({
      world: name, source,
      tasks: Object.values(report.verdicts).map((v) => ({
        task: v.taskId, decoys: v.decoys.map((d) => d.score), alternatives: report.world.tasks[v.taskId]?.alternatives.length ?? 0,
        solutionWrites: v.solutionWrites, checks: v.checks.length, flipped: v.checks.filter((c) => c.flippedBy.length > 0).length,
        slots: v.collateral.length, probed: v.collateral.filter((m) => m.call !== null).length,
      })),
    });
  }
  return out;
}

async function gatherAgent(repo: string): Promise<Pick<ScorecardInputs, 'difficulty' | 'exports'>> {
  const difficulty: DifficultyInput[] = [];
  const difficultyDir = path.join(repo, 'eval/difficulty');
  for (const name of await dirs(difficultyDir)) {
    const file = path.join(difficultyDir, name, 'difficulty.json');
    if (existsSync(file)) difficulty.push({ source: rel(file), text: await readFile(file, 'utf8') });
  }
  const exports: ExportInput[] = [];
  const datasetDir = path.join(repo, 'eval/dataset');
  for (const name of await dirs(datasetDir)) {
    for (const world of await dirs(path.join(datasetDir, name))) {
      const file = path.join(datasetDir, name, world, 'manifest.json');
      if (existsSync(file)) exports.push({ source: rel(file), manifest: parseManifest(JSON.parse(await readFile(file, 'utf8')), rel(file)) });
    }
  }
  return { difficulty, exports };
}

/** Everything the scorecards read, from the repository at repo. */
export async function gatherScorecards(repo: string = REPO_DIR): Promise<ScorecardInputs> {
  const fidelityDir = path.join(repo, 'eval/fidelity');
  const references = existsSync(fidelityDir) ? (await readdir(fidelityDir)).filter((n) => n.endsWith('.yaml')).map((n) => n.slice(0, -'.yaml'.length)).sort() : [];
  return { ...(await gatherRuns(repo)), references, worlds: await gatherWorlds(repo), ...(await gatherAgent(repo)) };
}

export async function main(argv: readonly string[]): Promise<number> {
  let out: string;
  try {
    const p = parseArgs({ args: [...argv], options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false, strict: true });
    if (p.values.help === true) {
      process.stdout.write(USAGE);
      return 0;
    }
    out = path.resolve(p.values.out ?? DEFAULT_OUT);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  try {
    await writeFile(out, renderScorecards(await gatherScorecards()));
  } catch (e) {
    process.stderr.write(`scorecards: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  process.stdout.write(`wrote ${out}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
