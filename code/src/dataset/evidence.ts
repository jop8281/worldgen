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
import { hashState, isCompleteSuccess, parseEpisode, parseManifest, sha256Hex, type Episode, type Manifest, type ManifestV1 } from './schema.ts';
import { verifierRequestOf } from './verifier.ts';

/** One episode replayed: what was recorded, what the verifier answers now, and each binding check. */
export type EpisodeReplay = {
  readonly episode: string;
  readonly task: string;
  readonly recorded: number | null;
  /** The verifier's score, or the stop it refused with. */
  readonly replayed: number | string;
  /** True when the episode's instruction and difficulty are the frozen world's own task. */
  readonly taskOk: boolean;
  readonly seedOk: boolean;
  /** Calls the world answered on replay, and how many answered with another status or body than recorded. */
  readonly calls: number;
  readonly mismatches: number;
  readonly finalOk: boolean;
  readonly agrees: boolean;
};

/** Replays one episode on its frozen world, then grades the replay's trace and end state through the verifier. */
export function replayEpisode(world: CheckedWorld, ep: Episode): EpisodeReplay {
  const task = world.tasks[ep.task_id];
  const instruction = ep.messages[0]?.type === 'instruction' ? ep.messages[0].text : null;
  const taskOk = task !== undefined && task.instruction === instruction && task.difficulty === ep.difficulty;
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
    // The wire carries no body on a 204 or 304, which the episode records as "".
    const wire = out.status === 204 || out.status === 304 ? '' : JSON.parse(JSON.stringify(out.body ?? null));
    const sameBody = res.truncated || isDeepStrictEqual(wire, res.body);
    if (out.status !== res.status || !sameBody) mismatches++;
  }
  const state = JSON.parse(JSON.stringify(rt.dump())) as StateDump;
  const finalOk = hashState(state) === ep.final_state_hash;
  const held = { wid: worldIdOf(world), worldVersion: ep.world_version, frozenDir: '', engine: ep.engine_commit };
  const request = verifierRequestOf(held, { submission: ep.episode_id, task: ep.task_id, trace: traceOf(rt.log()), state });
  const { verdict } = verifySubmission(world, held, JSON.stringify(request), new Set());
  const replayed = verdict.stop === 'graded' ? verdict.score : verdict.stop;
  return {
    episode: ep.episode_id, task: ep.task_id, recorded: ep.score, replayed, taskOk, seedOk, calls, mismatches, finalOk,
    agrees: replayable && taskOk && seedOk && finalOk && mismatches === 0 && replayed === ep.score,
  };
}

/** One export folder checked: its files, its frozen world and every accepted episode. */
export type FolderCheck = {
  readonly folder: string;
  /** Why the folder could not be checked at all, such as an unreadable manifest; null when it could. */
  readonly error: string | null;
  /** Files whose bytes no longer have the sha-256 the manifest records. */
  readonly changedFiles: readonly string[];
  /** The sha-256 of the frozen world's canonical render, or null when it does not load and check. */
  readonly worldVersion: string | null;
  /** True when the manifest names that version, so the episodes ran on this very world. */
  readonly worldOk: boolean;
  readonly replays: readonly EpisodeReplay[];
  /** Episodes that are not complete successes, counted but not replayed: failures.jsonl in a version 1 export, the other rows of dataset.jsonl in a version 2 one (A-389). */
  readonly failedRuns: number;
};

const linesOf = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

/** Checks `<folder>/manifest.json`, `dataset.jsonl` (and a version 1 export's `failures.jsonl`) against the frozen world in `worldDir`. */
export async function checkExportFolder(folder: string, worldDir = path.join(folder, 'world')): Promise<FolderCheck> {
  const none = { changedFiles: [], worldVersion: null, worldOk: false, replays: [], failedRuns: 0 };
  let manifest: Manifest | ManifestV1;
  try {
    manifest = parseManifest(JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')), 'manifest.json');
  } catch (e) {
    return { folder, error: `manifest.json: ${e instanceof Error ? e.message : String(e)}`, ...none };
  }
  // One frozen world per folder: an export naming several cannot say which world/ holds, so it is refused, not half-checked.
  if (manifest.worlds.length !== 1) return { folder, error: `manifest.json names ${manifest.worlds.length} worlds; a folder holds exactly one frozen world`, ...none };
  const changedFiles: string[] = [];
  const texts: Record<string, string> = {};
  for (const entry of manifest.manifest_version === 1 ? [manifest.files.dataset, manifest.files.failures] : [manifest.files.dataset]) {
    const bytes = await readFile(path.join(folder, entry.path)).catch(() => null);
    if (bytes === null || sha256Hex(bytes) !== entry.sha256) changedFiles.push(entry.path);
    texts[entry.path] = bytes === null ? '' : bytes.toString('utf8');
  }
  // The complete successes are replayed, as before A-389; a version 2 dataset.jsonl also holds the other rows, which are counted.
  const rows = linesOf(texts[manifest.files.dataset.path] ?? '');
  const success = (line: string): boolean => {
    try {
      return isCompleteSuccess(parseEpisode(JSON.parse(line), manifest.files.dataset.path));
    } catch {
      return true; // replayed, so the row is reported as episode.invalid
    }
  };
  const replayed = rows.map((line, i) => ({ line, i })).filter(({ line }) => manifest.manifest_version === 1 || success(line));
  const failedRuns = manifest.manifest_version === 1 ? linesOf(texts[manifest.files.failures.path] ?? '').length : rows.length - replayed.length;
  const loaded = await loadWorld(worldDir);
  const report = loaded.ok ? checkWorld(loaded.value) : null;
  if (report === null || !report.ok) return { folder, error: null, changedFiles, worldVersion: null, worldOk: false, replays: [], failedRuns };
  const worldVersion = sha256Hex(renderWorldYaml(report.world));
  const worldOk = manifest.worlds[0]!.world_version === worldVersion;
  if (!worldOk) return { folder, error: null, changedFiles, worldVersion, worldOk, replays: [], failedRuns };
  const replays = replayed.map(({ line, i }): EpisodeReplay => {
    const where = `${manifest.files.dataset.path}:${i + 1}`;
    let ep: Episode;
    try {
      ep = parseEpisode(JSON.parse(line), where);
    } catch {
      return { episode: where, task: '', recorded: null, replayed: 'episode.invalid', taskOk: false, seedOk: false, calls: 0, mismatches: 0, finalOk: false, agrees: false };
    }
    if (ep.world_version !== worldVersion) {
      return { episode: ep.episode_id, task: ep.task_id, recorded: ep.score, replayed: 'world.mismatch', taskOk: false, seedOk: false, calls: 0, mismatches: 0, finalOk: false, agrees: false };
    }
    return replayEpisode(report.world, ep);
  });
  return { folder, error: null, changedFiles, worldVersion, worldOk, replays, failedRuns };
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
export const folderAgrees = (f: FolderCheck): boolean => f.error === null && f.changedFiles.length === 0 && f.worldOk && f.replays.every((r) => r.agrees);
