/**
 * Writes the frozen world a dataset export's episodes ran on into `<export-folder>/world/world.yaml` (A-392), so that
 * `bun run evidence` replays them from a clone. It loads and checks `<world-dir>`, and saves through saveWorld only
 * when the sha-256 of the canonical render is a world_version that the folder's manifest.json names.
 *
 *   bun scripts/freeze-export-world.ts <world-dir> <export-folder>
 *
 * The 2026-10-07 export was frozen from prod/worlds at HEAD for five worlds, and for helpdesk from the root commit:
 * `git show 733538fd:prod/worlds/helpdesk/world.yaml`, since A-356 changed helpdesk after the export.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, loadWorld, renderWorldYaml, saveWorld } from '#engine';
import { parseManifest, sha256Hex } from '../src/dataset/schema.ts';

const USAGE = 'usage: bun scripts/freeze-export-world.ts <world-dir> <export-folder>\n';

async function main(argv: readonly string[]): Promise<number> {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [worldDir, folder] = argv;
  if (worldDir === undefined || folder === undefined || argv.length !== 2) {
    process.stderr.write(USAGE);
    return 2;
  }
  const manifestFile = path.join(folder, 'manifest.json');
  const manifest = parseManifest(JSON.parse(await readFile(manifestFile, 'utf8')), manifestFile);
  const loaded = await loadWorld(worldDir);
  const report = loaded.ok ? checkWorld(loaded.value) : null;
  if (report === null || !report.ok) {
    process.stderr.write(`${worldDir}: the world does not load and check\n`);
    return 1;
  }
  const version = sha256Hex(renderWorldYaml(report.world));
  if (!manifest.worlds.some((w) => w.world_version === version)) {
    process.stderr.write(`${worldDir}: version ${version.slice(0, 12)} is not one ${manifestFile} names (${manifest.worlds.map((w) => w.world_version.slice(0, 12)).join(', ')})\n`);
    return 1;
  }
  const out = path.join(folder, 'world');
  await saveWorld(out, report.world);
  const written = sha256Hex(await readFile(path.join(out, 'world.yaml')));
  if (written !== version) {
    process.stderr.write(`${out}/world.yaml: wrote ${written.slice(0, 12)}, expected ${version.slice(0, 12)}\n`);
    return 1;
  }
  process.stdout.write(`froze ${path.join(out, 'world.yaml')} at ${version.slice(0, 12)}\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
