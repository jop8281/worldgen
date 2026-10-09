/**
 * `bun run evidence [<export-dir>...]`: re-checks the exported dataset from the repository alone (A-392). For every
 * export folder it checks the files against the manifest's sha-256, the committed frozen world against the version the
 * episodes ran on, and replays each episode through the verifier, printing the recorded and replayed score side by
 * side. Argument parsing and printing only; the work is in dataset/evidence.ts. No model call, no network.
 * Exit codes: 0 every folder agrees, 1 something differs, 2 bad usage.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkExportFolder, exportFolders, folderAgrees, type FolderCheck } from '../dataset/evidence.ts';

const REPO_DIR = path.resolve(import.meta.dirname, '../../..');
const DEFAULT_EXPORTS = path.join(REPO_DIR, 'eval/dataset');

const USAGE = `usage: bun run evidence [<export-dir>...]

Re-checks each dataset export from the repository alone (A-392). An export dir holds one folder per world, each with
manifest.json, dataset.jsonl (and a version 1 export's failures.jsonl) and the frozen world the episodes ran on, in world/world.yaml.
With no argument it checks every export under ../eval/dataset.

For every folder it prints:
  files      dataset.jsonl, and a version 1 export's failures.jsonl, against the sha-256 in manifest.json
  world      the sha-256 of the frozen world's canonical render against the manifest's world_version
  episodes   each episode replayed on that world and graded by the verifier: recorded score, replayed score,
             the seed hash, how many calls answered as recorded, and the end-state hash

The replay runs on this checkout's engine, not on the engine commit each episode declares.
Exit codes: 0 every folder agrees, 1 something differs, 2 bad usage.
`;

const rel = (p: string): string => path.relative(REPO_DIR, p) || '.';

function print(f: FolderCheck, out: (line: string) => void): void {
  out(`${rel(f.folder)}`);
  if (f.error !== null) {
    out(`  ERROR  ${f.error}`);
    return;
  }
  out(`  files  ${f.changedFiles.length === 0 ? 'ok, sha-256 as in manifest.json' : `CHANGED ${f.changedFiles.join(', ')}`}`);
  out(`  world  ${f.worldVersion === null ? 'MISSING or does not check' : `${f.worldVersion.slice(0, 12)} ${f.worldOk ? 'ok, the version the episodes ran on' : 'DIFFERS from manifest.json'}`}`);
  for (const r of f.replays) {
    out(`  ${r.agrees ? 'ok  ' : 'DIFF'} ${r.episode}  recorded ${r.recorded ?? 'none'}  replayed ${r.replayed}  task ${r.taskOk ? 'ok' : 'DIFF'}  seed ${r.seedOk ? 'ok' : 'DIFF'}  calls ${r.calls - r.mismatches}/${r.calls}  final ${r.finalOk ? 'ok' : 'DIFF'}`);
  }
  if (f.failedRuns > 0) out(`  ${f.failedRuns} run(s) that are not a complete success, counted and not replayed`);
}

export async function main(argv: readonly string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = argv.find((a) => a.startsWith('-'));
  if (unknown !== undefined) {
    process.stderr.write(`unknown option ${unknown}\n${USAGE}`);
    return 2;
  }
  const exportDirs = argv.length === 0 ? [DEFAULT_EXPORTS] : argv.map((a) => path.resolve(a));
  const folders: string[] = [];
  for (const dir of exportDirs) {
    const found = await exportFolders(dir).catch(() => null);
    if (found === null) {
      process.stderr.write(`no export at ${dir}\n`);
      return 2;
    }
    folders.push(...found);
  }
  if (folders.length === 0) {
    process.stderr.write(`no export folder with a manifest.json under ${exportDirs.map(rel).join(', ')}\n`);
    return 2;
  }
  let episodes = 0;
  let agreeing = 0;
  let foldersOk = 0;
  for (const folder of folders) {
    const f = await checkExportFolder(folder);
    print(f, out);
    episodes += f.replays.length;
    agreeing += f.replays.filter((r) => r.agrees).length;
    if (folderAgrees(f)) foldersOk++;
  }
  out(`${agreeing} of ${episodes} episodes replay to their recorded score; ${foldersOk} of ${folders.length} folders agree`);
  return foldersOk === folders.length ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
