/**
 * `bun run scorecards` (YOS-262, A-402): regenerates prod/scorecards.md from committed files only, with no model call
 * and no network. Reading and wiring; the scorecards are in scorecards/cards.ts. No logic.
 *
 * Exit codes: 0 written, 1 a source could not be read, 2 bad usage.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkWorld, loadWorld } from '#engine';
import { parseManifest } from '../dataset/schema.ts';
import {
  graderTaskOf, renderScorecards, runParts, suiteFor,
  type DifficultyInput, type ExportInput, type GraderWorld, type RunInput, type ScorecardInputs,
} from '../scorecards/cards.ts';
import { CASE_ID, parseSuite, type Suite } from '../worldgen/eval.ts';
import { readEvalEvidence } from './eval-analysis-files.ts';

const REPO_DIR = path.resolve(import.meta.dirname, '../../..');
const DEFAULT_OUT = path.join(REPO_DIR, 'prod/scorecards.md');

export const USAGE = `usage: bun run scorecards [--out <file>]
Regenerates the four scorecards (YOS-262, A-402) from committed files only, with no model call and no network, and
writes them to <file> (default ../prod/scorecards.md):
  generator   each eval/runs/<run>/ with case files, directly or in lane folders, scored as
              bun scripts/analyze-eval.ts scores it against the eval/*.yaml suite that holds its cases
  fidelity    the fidelity events those runs recorded, against the 0.80 floor (A-258)
  grader      the engine's check of every world in prod/worlds, which worldplay verify runs
  agent       eval/difficulty/*/difficulty.json and each eval/dataset/<export>/[<pass>/]<world>/manifest.json
Exit codes: 0 written, 1 a source could not be read, 2 bad usage.
`;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Reads the repository at repo. Symlinked and hidden folders are skipped: committed evidence is never a link, and `.attempts` is history. */
function reader(repo: string) {
  const rel = (p: string): string => path.relative(repo, p).split(path.sep).join('/');
  const dirs = async (dir: string): Promise<string[]> =>
    existsSync(dir) ? (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.')).map((d) => d.name).sort() : [];
  const caseIds = async (dir: string): Promise<string[]> => (await dirs(dir)).filter((id) => CASE_ID.test(id) && existsSync(path.join(dir, id, 'case.json')));
  return { rel, dirs, caseIds };
}

async function gatherRuns(repo: string): Promise<Pick<ScorecardInputs, 'runs' | 'unmatchedRuns' | 'otherRuns'>> {
  const { rel, dirs, caseIds } = reader(repo);
  const suites = new Map<string, Suite>();
  for (const name of (await readdir(path.join(repo, 'eval'))).filter((n) => n.endsWith('.yaml')).sort()) {
    const parsed = parseSuite(await readFile(path.join(repo, 'eval', name), 'utf8'));
    if (!parsed.ok) throw new Error(`eval/${name} is not a suite: ${parsed.errors[0]}`);
    suites.set(`eval/${name}`, parsed.suite);
  }
  const suiteIds = [...suites].map(([file, s]) => ({ file, ids: s.cases.map((c) => c.id) }));
  const runs: RunInput[] = [];
  const unmatchedRuns: string[] = [];
  const otherRuns: string[] = [];
  for (const name of await dirs(path.join(repo, 'eval/runs'))) {
    const dir = path.join(repo, 'eval/runs', name);
    const subs = await Promise.all((await dirs(dir)).map(async (sub) => ({ name: sub, ids: await caseIds(path.join(dir, sub)) })));
    const found = runParts(rel(dir), await caseIds(dir), subs);
    if (found.length === 0) otherRuns.push(rel(dir));
    for (const r of found) {
      const parts = await Promise.all(r.parts.map(async (p) => ({ part: p, ids: await caseIds(path.join(repo, p)) })));
      const file = suiteFor(parts.flatMap((p) => p.ids), suiteIds);
      if (file === null) {
        unmatchedRuns.push(r.run);
        continue;
      }
      const suite = suites.get(file)!;
      const cases = suite.cases.map((c) => ({ id: c.id, expect: c.expect, ...(c.change === undefined ? {} : { change: c.change }) }));
      const evidence = (await Promise.all(parts.map(async ({ part }) =>
        (await readEvalEvidence(path.join(repo, part), cases)).map((e) => ({ ...e, source: `${part}/${e.source}` }))))).flat();
      runs.push({ run: r.run, suite: suite.name, suiteFile: file, cases, evidence });
    }
  }
  return { runs, unmatchedRuns, otherRuns };
}

async function gatherWorlds(repo: string): Promise<GraderWorld[]> {
  const { rel, dirs } = reader(repo);
  const root = path.join(repo, 'prod/worlds');
  const out: GraderWorld[] = [];
  for (const name of await dirs(root)) {
    const dir = path.join(root, name);
    if (!existsSync(path.join(dir, 'world.yaml'))) continue;
    const source = rel(path.join(dir, 'world.yaml'));
    const loaded = await loadWorld(dir);
    if (!loaded.ok) {
      out.push({ world: name, source, refused: `does not load: ${loaded.error[0].found.replaceAll(`${repo}${path.sep}`, '')}` });
      continue;
    }
    const report = checkWorld(loaded.value, loaded.lines);
    if (!report.ok) {
      out.push({ world: name, source, refused: `${report.issues[0].code} at ${report.issues[0].path.join('.')}` });
      continue;
    }
    out.push({ world: name, source, tasks: Object.values(report.verdicts).map((v) => graderTaskOf(v, report.world.tasks[v.taskId]?.alternatives.length ?? 0)) });
  }
  return out;
}

async function gatherAgent(repo: string): Promise<Pick<ScorecardInputs, 'difficulty' | 'exports'>> {
  const { rel, dirs } = reader(repo);
  const difficulty: DifficultyInput[] = [];
  for (const name of await dirs(path.join(repo, 'eval/difficulty'))) {
    const file = path.join(repo, 'eval/difficulty', name, 'difficulty.json');
    if (existsSync(file)) difficulty.push({ source: rel(file), text: await readFile(file, 'utf8') });
  }
  const exports: ExportInput[] = [];
  const readManifest = async (file: string): Promise<void> => {
    try {
      exports.push({ source: rel(file), manifest: parseManifest(JSON.parse(await readFile(file, 'utf8')), rel(file)) });
    } catch (e) {
      exports.push({ source: rel(file), error: messageOf(e) });
    }
  };
  // An export is <export>/<world>/manifest.json, or <export>/<pass>/<world>/manifest.json when it was made in passes.
  for (const name of await dirs(path.join(repo, 'eval/dataset'))) {
    for (const sub of await dirs(path.join(repo, 'eval/dataset', name))) {
      const dir = path.join(repo, 'eval/dataset', name, sub);
      if (existsSync(path.join(dir, 'manifest.json'))) await readManifest(path.join(dir, 'manifest.json'));
      else for (const world of await dirs(dir)) if (existsSync(path.join(dir, world, 'manifest.json'))) await readManifest(path.join(dir, world, 'manifest.json'));
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
    process.stderr.write(`${messageOf(e)}\n${USAGE}`);
    return 2;
  }
  try {
    await writeFile(out, renderScorecards(await gatherScorecards()));
  } catch (e) {
    process.stderr.write(`scorecards: ${messageOf(e)}\n`);
    return 1;
  }
  process.stdout.write(`wrote ${out}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
