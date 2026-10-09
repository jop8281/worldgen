/**
 * Renders the public form of each prod world to <world>/public/world.yaml (YOS-159): every task bare, everything else
 * as the private world has it. The file is what a public bundle serves; test/worlds.test.ts fails when one drifts.
 * Each world must check as a private world, and its public form must check too. saveWorld is the only writer. Rerun it
 * after changing a world; `bun run live` writes it for each world it delivers. No model call (A-392).
 *
 *   bun scripts/render-public-worlds.ts [<worldDir>...]   # default: every world under prod/worlds
 *
 * Exit codes: 0 done, 1 a world was refused.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, loadWorld, publicWorldOf, renderWorldYaml, saveWorld, taskPrivacy } from '#engine';

const USAGE = 'usage: bun scripts/render-public-worlds.ts [<worldDir>...]\n';
const REPO = path.resolve(import.meta.dirname, '../..');
const WORLDS = path.join(REPO, 'prod/worlds');

async function allWorldDirs(): Promise<string[]> {
  const subdirs = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.partial')).map((e) => e.name);
  const top = await subdirs(WORLDS);
  const generated = top.includes('generated') ? (await subdirs(path.join(WORLDS, 'generated'))).map((n) => `generated/${n}`) : [];
  return [...top.filter((n) => n !== 'generated'), ...generated].sort().map((n) => path.join(WORLDS, n));
}

async function render(dir: string): Promise<'wrote' | 'unchanged'> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) throw new Error(`did not load: ${JSON.stringify(loaded.error)}`);
  const report = checkWorld(loaded.value);
  if (!report.ok) throw new Error(`failed check at ${report.reached}: ${JSON.stringify(report.issues)}`);
  // An all-bare world is already a public form; rendering it would nest public/public/.
  if (taskPrivacy(report.world) !== 'private') throw new Error('is already a public form: its tasks carry no grader or solution');
  const pub = checkWorld(publicWorldOf(report.world));
  if (!pub.ok) throw new Error(`public form failed check at ${pub.reached}: ${JSON.stringify(pub.issues)}`);
  const file = path.join(dir, 'public', 'world.yaml');
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  if (existing === renderWorldYaml(pub.world)) return 'unchanged';
  await saveWorld(path.join(dir, 'public'), pub.world);
  return 'wrote';
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const dirs = args.length > 0 ? args.map((a) => path.resolve(a)) : await allWorldDirs();
  let refused = 0;
  for (const dir of dirs) {
    const rel = path.relative(REPO, path.join(dir, 'public', 'world.yaml'));
    try {
      process.stdout.write(`${await render(dir)} ${rel}\n`);
    } catch (e) {
      refused++;
      process.stderr.write(`refused ${path.relative(REPO, dir)}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return refused > 0 ? 1 : 0;
}

process.exit(await main());
