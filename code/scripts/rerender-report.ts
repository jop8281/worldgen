/**
 * Re-renders generated worlds' REPORT.md and capsule.json from what each run saved: plan.yaml, the events of the run
 * capsule.json names, and the world.yaml beside them, through renderReport and runCapsule. No model call. For when
 * a world's content ids moved with no edit to world.yaml, such as a new schema default (A-332), so the report and
 * capsule name the world they sit beside. test/prod-world-ids.test.ts fails until they do. It lives outside src/
 * because it reads back the CheckIssues a run logged, and only engine/issues.ts may assert that brand in src/.
 *
 *   bun scripts/rerender-report.ts <worldDir>...                                     # every world from its capsule
 *   bun scripts/rerender-report.ts <worldDir> [--before <worldDir>] [-- <worldgen input args>] [--record-input]
 *
 * A capsule records the run's input (A-351): an OpenAPI spec or CSV paths relative to the repository, or for a change
 * request the world it started from, saved under the run's directory. With no overrides each world re-renders from
 * that. A world whose capsule records no input needs overrides, one world at a time: a create run from --openapi or
 * --csv takes that input after --, exactly as the run was given it, and an iterate run takes --before. A create
 * input must digest to the capsule's own input digest, so the report lists the same input fields.
 * --record-input back-fills an older capsule: it checks the overrides are the run's own (the digest; for a change
 * request, the Changes section the committed REPORT.md shows), saves an outside --before world under the run's
 * directory through saveWorld, and adds only input.source to capsule.json. Exit codes: 0 done, 1 refused, 2 bad usage.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, contentDigest, diffWorlds, loadWorld, saveWorld, worldIdOf, type CheckReport } from '#engine';
import { CAPSULE_FILE, capsuleSchema, runCapsule, type InputSource, type RunCapsule } from '../src/worldgen/capsule.ts';
import type { RunEvent } from '../src/worldgen/events.ts';
import { digestInput, parseInputArgs, type Input } from '../src/worldgen/input.ts';
import { parsePlanYaml } from '../src/worldgen/plan.ts';
import { renderReport } from '../src/worldgen/report.ts';

const USAGE = 'usage: bun scripts/rerender-report.ts <worldDir>... | <worldDir> [--before <worldDir>] [-- <worldgen input args>] [--record-input]\n';
const REPO = path.resolve(import.meta.dirname, '../..');

class Refused extends Error {}

type Overrides = { readonly before?: string | undefined; readonly inputArgs: readonly string[]; readonly record: boolean };

async function checked(dir: string): Promise<Extract<CheckReport, { ok: true }>> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) throw new Refused(`${dir} does not load: ${loaded.error[0].code}`);
  const report = checkWorld(loaded.value);
  if (!report.ok) throw new Refused(`${dir} does not check: ${report.issues.map((i) => i.code).slice(0, 5).join(', ')}`);
  return report;
}

/** worldgen input args for a recorded OpenAPI or CSV source, with repository paths made absolute. */
function argsOf(source: InputSource): string[] | null {
  if (source.kind === 'openapi') {
    if (source.path === null) return null;
    return ['--openapi', path.join(REPO, source.path), ...(source.only.length === 0 ? [] : ['--only', source.only.join(',')])];
  }
  if (source.kind === 'csv') return source.paths.includes(null) ? null : ['--csv', ...source.paths.map((p) => path.join(REPO, p!))];
  return null;
}

/** The source a create input records, its paths relative to this repository. */
function sourceOf(input: Input): InputSource {
  const rel = (p: string): string | null => {
    const r = path.relative(REPO, path.resolve(p));
    return r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/');
  };
  if (input.kind === 'openapi') return { kind: 'openapi', path: rel(input.path), only: [...input.only] };
  if (input.kind === 'csv') return { kind: 'csv', paths: input.paths.map(rel) };
  return { kind: 'description' };
}

const changesOf = (report: string): string => /\n## Changes\n[\s\S]*?(?=\n## |$)/.exec(report)?.[0] ?? '';

async function rerender(dir: string, o: Overrides): Promise<string> {
  const raw = JSON.parse(await readFile(path.join(dir, CAPSULE_FILE), 'utf8')) as Record<string, unknown> & { input: Record<string, unknown> };
  const capsule: RunCapsule = capsuleSchema.parse(raw);
  const recorded = capsule.input.source;
  const events = (await readFile(path.join(dir, 'runs', capsule.runId, 'events.jsonl'), 'utf8'))
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as RunEvent);
  const plan = parsePlanYaml(await readFile(path.join(dir, 'plan.yaml'), 'utf8'));
  if (plan === null) throw new Refused(`${dir}/plan.yaml does not parse`);
  const report = await checked(dir);

  let text: string;
  let source: InputSource | undefined = recorded;
  if (capsule.mode === 'iterate') {
    const beforeDir = o.before ?? (recorded?.kind === 'change_request' ? path.join(dir, recorded.before) : undefined);
    if (beforeDir === undefined) throw new Refused('capsule.json records no input (A-351): pass --before, the world this change started from');
    const before = await checked(beforeDir);
    text = renderReport({ plan, report, delta: diffWorlds(before.world, report.world), events });
    if (o.record) {
      const committed = await readFile(path.join(dir, 'REPORT.md'), 'utf8');
      if (changesOf(text) !== changesOf(committed)) throw new Refused('that --before world does not give the Changes section the committed REPORT.md shows');
      const inside = path.relative(dir, beforeDir);
      const rel = inside.startsWith('..') || path.isAbsolute(inside) ? `runs/${capsule.runId}/before` : inside.split(path.sep).join('/');
      if (rel !== inside.split(path.sep).join('/')) await saveWorld(path.join(dir, rel), before.world);
      source = { kind: 'change_request', before: rel };
    }
  } else {
    let sourceFields: readonly string[] | undefined;
    if (capsule.input.kind === 'openapi' || capsule.input.kind === 'csv') {
      const args = o.inputArgs.length > 0 ? o.inputArgs : recorded === undefined ? null : argsOf(recorded);
      if (args === null) throw new Refused(`capsule.json records no usable ${capsule.input.kind} input (A-351): pass the run's input after --`);
      const input = parseInputArgs(args);
      const digested = await digestInput(input);
      if (!digested.ok) throw new Refused(digested.why);
      // A run digested before InputDigest carried sourceFields recorded the digest of the rest.
      const { sourceFields: _fields, ...older } = digested.digest;
      if (contentDigest(digested.digest) !== capsule.input.digest && contentDigest(older) !== capsule.input.digest) {
        throw new Refused(`that input digests to ${contentDigest(digested.digest)}, not the run's ${capsule.input.digest ?? 'null'}`);
      }
      sourceFields = digested.digest.sourceFields;
      if (o.record) source = sourceOf(input);
    } else if (o.record) {
      source = { kind: 'description' };
    }
    text = renderReport({ plan, report, events, sourceFields });
  }

  if (o.record) {
    if (source === undefined) throw new Refused('nothing to record');
    raw.input = { ...raw.input, source };
    capsuleSchema.parse(raw);
    await writeFile(path.join(dir, CAPSULE_FILE), `${JSON.stringify(raw, null, 2)}\n`);
    return `${path.basename(dir)}: recorded ${JSON.stringify(source)}`;
  }
  const next = runCapsule(events, { inputDigest: capsule.input.digest, world: report.world, source });
  await writeFile(path.join(dir, 'REPORT.md'), text);
  await writeFile(path.join(dir, CAPSULE_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return `${path.basename(dir)}: ${capsule.worldId ?? 'null'} -> ${worldIdOf(report.world)}`;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const cut = argv.indexOf('--');
  const own = cut < 0 ? argv : argv.slice(0, cut);
  const inputArgs = cut < 0 ? [] : argv.slice(cut + 1);
  const at = own.indexOf('--before');
  const before = at < 0 ? undefined : own[at + 1];
  const record = own.includes('--record-input');
  const dirs = own.filter((a, i) => a !== '--record-input' && !(at >= 0 && (i === at || i === at + 1)));
  const overriding = before !== undefined || inputArgs.length > 0 || record;
  if (dirs.length === 0 || dirs.some((d) => d.startsWith('-')) || (at >= 0 && before === undefined) || (overriding && dirs.length !== 1)) {
    process.stderr.write(USAGE);
    return 2;
  }
  let refused = 0;
  for (const dir of dirs) {
    try {
      process.stdout.write(`${await rerender(path.resolve(dir), { before: before === undefined ? undefined : path.resolve(before), inputArgs, record })}\n`);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      process.stderr.write(`${path.basename(dir)}: refused: ${e.message}\n`);
      refused += 1;
    }
  }
  return refused === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
