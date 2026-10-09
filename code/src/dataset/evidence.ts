/**
 * Re-checks an exported dataset from the repository alone (A-392). For each export folder it checks the jsonl files
 * against the manifest's sha-256, the frozen world against the world_version the episodes name, and then replays every
 * accepted episode on that world and grades the replay through the verifier (engine/verify.ts). The replay runs on this
 * checkout's engine, not on the engine commit an episode declares, so agreement shows today's engine reproduces the
 * recorded run: the same seed, the same answer to every call, the same end state and the same score.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { checkWorld, createRuntime, loadWorld, openApiOf, renderWorldYaml, traceOf, verifySubmission, worldIdOf, type CheckedWorld, type StateDump } from '#engine';
import { checkRequest, routesOf } from './episode.ts';
import { hashState, parseEpisode, parseManifest, sha256Hex, type Episode } from './schema.ts';
import { verifierRequestOf } from './verifier.ts';

/** One episode replayed: what was recorded, what the verifier answers now, and each binding check. */
export type EpisodeReplay = {
  readonly episode: string;
  readonly task: string;
  readonly recorded: number | null;
  /** The verifier's score, or the stop it refused with. */
  readonly replayed: number | string;
  readonly seedOk: boolean;
  /** Calls the world answered on replay, and how many answered with another status or body than recorded. */
  readonly calls: number;
  readonly mismatches: number;
  readonly finalOk: boolean;
  readonly agrees: boolean;
};

/** Replays one episode on its frozen world, then grades the replay's trace and end state through the verifier. */
export function replayEpisode(world: CheckedWorld, ep: Episode): EpisodeReplay {
  const rt = createRuntime(world);
  const seedOk = hashState(JSON.parse(JSON.stringify(rt.dump()))) === ep.initial_state_hash;
  const routes = routesOf(openApiOf(world));
  let calls = 0;
  let mismatches = 0;
  let replayable = true;
  for (let k = 0; k < ep.messages.length; k++) {
    const m = ep.messages[k]!;
    if (m.type !== 'tool_call') continue;
    const res = ep.messages[k + 1];
    // A refused call never reached the world. An errored one may or may not have, so it cannot be replayed honestly.
    if (res?.type !== 'tool_result' || res.outcome === 'rejected') continue;
    if (res.outcome === 'error') {
      replayable = false;
      break;
    }
    const checked = checkRequest(m.request, routes);
    if (!checked.ok) {
      mismatches++;
      continue;
    }
    const out = rt.call({ method: checked.send.method, path: checked.send.target, query: {}, body: checked.send.bodyText === undefined ? undefined : JSON.parse(checked.send.bodyText) });
    calls++;
    const sameBody = res.truncated || isDeepStrictEqual(JSON.parse(JSON.stringify(out.body ?? null)), res.body);
    if (out.status !== res.status || !sameBody) mismatches++;
  }
  const state = JSON.parse(JSON.stringify(rt.dump())) as StateDump;
  const finalOk = hashState(state) === ep.final_state_hash;
  const held = { wid: worldIdOf(world), worldVersion: ep.world_version, frozenDir: '', engine: ep.engine_commit };
  const request = verifierRequestOf(held, { submission: ep.episode_id, task: ep.task_id, trace: traceOf(rt.log()), state });
  const { verdict } = verifySubmission(world, held, JSON.stringify(request), new Set());
  const replayed = verdict.stop === 'graded' ? verdict.score : verdict.stop;
  return {
    episode: ep.episode_id, task: ep.task_id, recorded: ep.score, replayed, seedOk, calls, mismatches, finalOk,
    agrees: replayable && seedOk && finalOk && mismatches === 0 && replayed === ep.score,
  };
}

/** One export folder checked: its files, its frozen world and every accepted episode. */
export type FolderCheck = {
  readonly folder: string;
  /** Files whose bytes no longer have the sha-256 the manifest records. */
  readonly changedFiles: readonly string[];
  /** The sha-256 of the frozen world's canonical render, or null when it does not load and check. */
  readonly worldVersion: string | null;
  /** True when the manifest names that version, so the episodes ran on this very world. */
  readonly worldOk: boolean;
  readonly replays: readonly EpisodeReplay[];
  /** Episodes in failures.jsonl: failed runs with no score to check, counted but not replayed. */
  readonly failedRuns: number;
};

const linesOf = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

/** Checks `<folder>/manifest.json`, `dataset.jsonl` and `failures.jsonl` against the frozen world in `worldDir`. */
export async function checkExportFolder(folder: string, worldDir = path.join(folder, 'world')): Promise<FolderCheck> {
  const manifest = parseManifest(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')), path.join(folder, 'manifest.json'));
  const changedFiles: string[] = [];
  const texts: Record<string, string> = {};
  for (const entry of [manifest.files.dataset, manifest.files.failures]) {
    const bytes = await readFile(path.join(folder, entry.path)).catch(() => null);
    if (bytes === null || sha256Hex(bytes) !== entry.sha256) changedFiles.push(entry.path);
    texts[entry.path] = bytes === null ? '' : bytes.toString('utf8');
  }
  const failedRuns = linesOf(texts[manifest.files.failures.path] ?? '').length;
  const loaded = await loadWorld(worldDir);
  const report = loaded.ok ? checkWorld(loaded.value) : null;
  if (report === null || !report.ok) return { folder, changedFiles, worldVersion: null, worldOk: false, replays: [], failedRuns };
  const worldVersion = sha256Hex(renderWorldYaml(report.world));
  const worldOk = manifest.worlds.some((w) => w.world_version === worldVersion);
  if (!worldOk) return { folder, changedFiles, worldVersion, worldOk, replays: [], failedRuns };
  const replays = linesOf(texts[manifest.files.dataset.path] ?? '').map((line, i) => {
    const ep = parseEpisode(JSON.parse(line), `${manifest.files.dataset.path}:${i + 1}`);
    if (ep.world_version !== worldVersion) {
      return { episode: ep.episode_id, task: ep.task_id, recorded: ep.score, replayed: 'world.mismatch', seedOk: false, calls: 0, mismatches: 0, finalOk: false, agrees: false };
    }
    return replayEpisode(report.world, ep);
  });
  return { folder, changedFiles, worldVersion, worldOk, replays, failedRuns };
}

const subdirs = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)).sort();
const hasManifest = (dir: string): Promise<boolean> => readFile(path.join(dir, 'manifest.json')).then(() => true, () => false);

/**
 * The export folders under `dir`, in name order: its subfolders that hold a manifest.json (one export), or else those
 * one level further down (a dir of dated exports, such as eval/dataset). Throws when `dir` cannot be read.
 */
export async function exportFolders(dir: string): Promise<string[]> {
  const direct: string[] = [];
  for (const sub of await subdirs(dir)) if (await hasManifest(sub)) direct.push(sub);
  if (direct.length > 0) return direct;
  const nested: string[] = [];
  for (const sub of await subdirs(dir)) for (const folder of await subdirs(sub)) if (await hasManifest(folder)) nested.push(folder);
  return nested;
}

/** True when a folder's files are unchanged, its world is the one the episodes ran on, and every replay agrees. */
export const folderAgrees = (f: FolderCheck): boolean => f.changedFiles.length === 0 && f.worldOk && f.replays.every((r) => r.agrees);
