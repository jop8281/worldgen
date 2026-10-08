/**
 * Re-renders a generated world's REPORT.md and capsule.json from what its run saved: plan.yaml, the events of the run
 * capsule.json names, and the world.yaml beside them, through renderReport and runCapsule. No model call. For when
 * the world's content ids moved with no edit to world.yaml, such as a new schema default (A-332), so the report and
 * capsule name the world they sit beside. test/prod-world-ids.test.ts fails until they do. It lives outside src/
 * because it reads back the CheckIssues a run logged, and only engine/issues.ts may assert that brand in src/.
 *
 *   bun scripts/rerender-report.ts <worldDir> [--before <worldDir>] [-- <worldgen input args>]
 *
 * A create run from --openapi or --csv takes that input after --, exactly as the run was given it. It must digest to
 * the capsule's own input digest, so the report lists the same input fields. An iterate run takes --before, the world
 * it started from, for its Changes section. Exit codes: 0 rewritten, 1 refused, 2 bad usage.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, contentDigest, diffWorlds, loadWorld, worldIdOf, type CheckReport } from '#engine';
import { CAPSULE_FILE, capsuleSchema, runCapsule } from '../src/worldgen/capsule.ts';
import type { RunEvent } from '../src/worldgen/events.ts';
import { digestInput, parseInputArgs } from '../src/worldgen/input.ts';
import { parsePlanYaml } from '../src/worldgen/plan.ts';
import { renderReport } from '../src/worldgen/report.ts';

const USAGE = 'usage: bun scripts/rerender-report.ts <worldDir> [--before <worldDir>] [-- <worldgen input args>]\n';

class Refused extends Error {}

async function checked(dir: string): Promise<Extract<CheckReport, { ok: true }>> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) throw new Refused(`${dir} does not load: ${loaded.error[0].code}`);
  const report = checkWorld(loaded.value);
  if (!report.ok) throw new Refused(`${dir} does not check: ${report.issues.map((i) => i.code).slice(0, 5).join(', ')}`);
  return report;
}

async function rerender(dir: string, beforeDir: string | undefined, inputArgs: readonly string[]): Promise<string> {
  const capsule = capsuleSchema.parse(JSON.parse(await readFile(path.join(dir, CAPSULE_FILE), 'utf8')));
  const events = (await readFile(path.join(dir, 'runs', capsule.runId, 'events.jsonl'), 'utf8'))
    .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as RunEvent);
  const plan = parsePlanYaml(await readFile(path.join(dir, 'plan.yaml'), 'utf8'));
  if (plan === null) throw new Refused(`${dir}/plan.yaml does not parse`);
  const report = await checked(dir);

  let text: string;
  if (capsule.mode === 'iterate') {
    if (beforeDir === undefined) throw new Refused('an iterate run needs --before, the world it started from');
    text = renderReport({ plan, report, delta: diffWorlds((await checked(beforeDir)).world, report.world), events });
  } else {
    let sourceFields: readonly string[] | undefined;
    if (capsule.input.kind === 'openapi' || capsule.input.kind === 'csv') {
      if (inputArgs.length === 0) throw new Refused(`a ${capsule.input.kind} run needs its input after --`);
      const digested = await digestInput(parseInputArgs(inputArgs));
      if (!digested.ok) throw new Refused(digested.why);
      // A run digested before InputDigest carried sourceFields recorded the digest of the rest.
      const { sourceFields: _fields, ...older } = digested.digest;
      if (contentDigest(digested.digest) !== capsule.input.digest && contentDigest(older) !== capsule.input.digest) {
        throw new Refused(`that input digests to ${contentDigest(digested.digest)}, not the run's ${capsule.input.digest ?? 'null'}`);
      }
      sourceFields = digested.digest.sourceFields;
    }
    text = renderReport({ plan, report, events, sourceFields });
  }
  const next = runCapsule(events, { inputDigest: capsule.input.digest, world: report.world });
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
  const beforeDir = at < 0 ? undefined : own[at + 1];
  const rest = at < 0 ? own : own.filter((_, i) => i !== at && i !== at + 1);
  if (rest.length !== 1 || (at >= 0 && beforeDir === undefined) || rest[0]!.startsWith('-')) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    process.stdout.write(`${await rerender(path.resolve(rest[0]!), beforeDir === undefined ? undefined : path.resolve(beforeDir), inputArgs)}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    process.stderr.write(`refused: ${e.message}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
