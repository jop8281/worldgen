/**
 * Saved episode logs, the export, and the check that reopens it (YOS-91). Shell code: reads and
 * writes the host file system. Core logic stays in schema.ts.
 *
 * Layout under the output directory `out`:
 *   logs/<run_id>.episodes.jsonl        every episode of a run, success or not, appended as it ends
 *   dataset.jsonl, failures.jsonl       the export: complete successes, and everything else
 *   manifest.json                       counts, checksums, versions and the frozen world reference
 *   private/worlds/<hash>/world.yaml    the frozen world (graders and solutions): never exported
 *   private/episodes/<id>/              the engine's initial and final state and call log
 *   private/diagnostics/<run_id>/       what was collected from the sandbox
 * Everything public is the three export files. Everything under private/ stays out of them.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DatasetError, GRADING_NOTE, MANIFEST_VERSION, PROVIDER, SCHEMA_VERSION, canonicalJson, hashState, isCompleteSuccess, parseEpisode, parseManifest, sha256Hex,
  type Episode, type Manifest, type Redactor,
} from './schema.ts';
import { DEFAULT_MODEL } from '../worldgen/config.ts';
import type { PrivateArtifacts } from './episode.ts';

export const DATASET_FILE = 'dataset.jsonl';
export const FAILURES_FILE = 'failures.jsonl';
export const MANIFEST_FILE = 'manifest.json';
const LOGS_DIR = 'logs';
const EXPORT_CLAIM = '.export.lock';
const EXPORT_WAIT_MS = 300_000;
const CLAIM_POLL_MS = 50;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[0-9a-f]{64}$/;

const logFile = (out: string, runId: string): string => {
  if (!SAFE.test(runId)) throw new DatasetError(`bad run id ${JSON.stringify(runId)}`);
  return path.join(out, LOGS_DIR, `${runId}.episodes.jsonl`);
};
export const worldArtifactPath = (worldVersion: string): string => {
  if (!SHA.test(worldVersion)) throw new DatasetError(`bad world version ${JSON.stringify(worldVersion)}`);
  return `private/worlds/${worldVersion}/world.yaml`;
};
const episodeDir = (out: string, id: string): string => {
  if (!SAFE.test(id)) throw new DatasetError(`bad episode id ${JSON.stringify(id)}`);
  return path.join(out, 'private', 'episodes', id);
};
export const diagnosticsDir = (out: string, runId: string): string => {
  if (!SAFE.test(runId)) throw new DatasetError(`bad run id ${JSON.stringify(runId)}`);
  return path.join(out, 'private', 'diagnostics', runId);
};

const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const readOptional = (file: string): Promise<string | undefined> => readFile(file, 'utf8').catch((e: unknown) => {
  if (codeOf(e) === 'ENOENT') return undefined;
  throw e;
});

/** Parses a JSONL file line by line. A missing final newline, a blank line or a bad record is corruption. */
function parseLines(text: string, where: string, parse: (raw: unknown, at: string) => Episode): Episode[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) throw new DatasetError(`${where}: the last line is incomplete`);
  return text.slice(0, -1).split('\n').map((line, i) => {
    const at = `${where}:${i + 1}`;
    if (line.trim() === '') throw new DatasetError(`${at}: blank line`);
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new DatasetError(`${at}: not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    return parse(raw, at);
  });
}

// ---------------------------------------------------------------------------------------------
// Durable writes

const F_FULLFSYNC = 51;
/**
 * fcntl(fd, F_FULLFSYNC) through bun:ffi, on macOS under Bun only. There fsync(2) leaves data in the
 * drive's cache and Bun's FileHandle.sync() is a plain fsync(2); Node's libuv already asks for
 * F_FULLFSYNC itself.
 */
const fullFsync: ((fd: number) => number) | null = process.platform === 'darwin' && typeof process.versions.bun === 'string'
  ? (() => {
      const { dlopen, FFIType } = createRequire(import.meta.url)('bun:ffi');
      const libc = dlopen('/usr/lib/libSystem.B.dylib', { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
      return (fd: number): number => libc.symbols.fcntl(fd, F_FULLFSYNC);
    })()
  : null;

/** Flushes an open file or directory to stable storage. Like libuv, falls back to fsync(2) where F_FULLFSYNC fails. */
async function flush(handle: FileHandle): Promise<void> {
  if (fullFsync === null || fullFsync(handle.fd) !== 0) await handle.sync();
}

/** The directories that hold the entries a new `file` needs: its own, then each one up to the parent of `made`, the first directory mkdir created. */
export function newEntryDirs(file: string, made: string | undefined): string[] {
  const own = path.dirname(path.resolve(file));
  const top = made === undefined ? own : path.dirname(path.resolve(made));
  const dirs = [own];
  for (let dir = own; dir !== top && dir !== path.dirname(dir);) {
    dir = path.dirname(dir);
    dirs.push(dir);
  }
  return dirs;
}

async function flushEntries(file: string, made: string | undefined): Promise<void> {
  for (const dir of newEntryDirs(file, made)) {
    const handle = await open(dir, 'r');
    try {
      await flush(handle);
    } finally {
      await handle.close();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Claims

/**
 * One claim file: its device and inode, and its text. Linux gives a file re-created right after an
 * unlink the same inode, so only the text, which holds a random token, tells two claims apart.
 */
type ClaimIdentity = { readonly dev: number; readonly ino: number; readonly text: string };

/**
 * Takes the claim `file`, created whole by link(2) and holding this process's pid and a random
 * token. A held claim is waited on for up to `waitMs`, then refused with `busy()`.
 */
async function takeClaim(file: string, waitMs: number, busy: () => DatasetError): Promise<ClaimIdentity> {
  const mine = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  const text = `${JSON.stringify({ pid: process.pid, host: hostname(), token: randomBytes(16).toString('hex') })}\n`;
  await writeFile(mine, text, { flag: 'wx', mode: 0o600 });
  try {
    const { dev, ino } = await stat(mine);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const won = await link(mine, file).then(() => true, (e: unknown) => {
        if (codeOf(e) === 'EEXIST') return false;
        throw e;
      });
      if (won) return { dev, ino, text };
      if (Date.now() >= deadline) throw busy();
      await sleep(CLAIM_POLL_MS);
    }
  } finally {
    await unlink(mine);
  }
}

/** Removes the claim `file` only if it is still the one this process took. */
async function releaseClaim(file: string, own: ClaimIdentity): Promise<void> {
  const absent = (e: unknown): undefined => {
    if (codeOf(e) === 'ENOENT') return undefined;
    throw e;
  };
  const now = await lstat(file).catch(absent);
  const text = now === undefined ? undefined : await readFile(file, 'utf8').catch(absent);
  if (now?.dev !== own.dev || now.ino !== own.ino || text !== own.text) {
    throw new DatasetError(`${file} was replaced or removed while this process held it, so another writer may have run: validate what it guards before writing again`);
  }
  await unlink(file);
}

/**
 * Runs `work` while this process holds the claim `file`. The claim is released after a result or
 * an error. A holder that dies leaves it in place, fail closed, for the recovery steps in
 * research/boat-sonnet-dataset-plan.md.
 */
async function withClaim<T>(file: string, waitMs: number, busy: () => DatasetError, work: () => Promise<T>): Promise<T> {
  const own = await takeClaim(file, waitMs, busy);
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await releaseClaim(file, own).catch((e: unknown) => {
      throw new DatasetError(`${messageOf(error)}; then ${messageOf(e)}`, { cause: error });
    });
    throw error;
  }
  await releaseClaim(file, own);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Saved logs

/** Reads a saved episode log and validates every record. Fails closed on the first corrupt line. */
export async function readEpisodeLog(file: string, redact: Redactor): Promise<Episode[]> {
  const text = await readOptional(file);
  if (text === undefined) throw new DatasetError(`${file} does not exist`);
  redact.assertClean(file, text);
  return parseLines(text, file, parseEpisode);
}

/** One run's saved records by episode id. A record of another run, or one id saved with two contents, is corruption. */
function byEpisodeId(file: string, runId: string, episodes: readonly Episode[]): Map<string, Episode> {
  const byId = new Map<string, Episode>();
  for (const ep of episodes) {
    if (ep.run_id !== runId) throw new DatasetError(`${file}: episode ${ep.episode_id} belongs to run ${ep.run_id}`);
    const seen = byId.get(ep.episode_id);
    if (seen !== undefined && canonicalJson(seen) !== canonicalJson(ep)) throw new DatasetError(`${file}: episode ${ep.episode_id} is saved twice with different content`);
    byId.set(ep.episode_id, ep);
  }
  return byId;
}

/** Starts the empty log of `runId` under `out`, created exclusively and flushed, so a run id belongs to one run. False when it exists. */
export async function startRunLog(out: string, runId: string): Promise<boolean> {
  const file = logFile(out, runId);
  const made = await mkdir(path.dirname(file), { recursive: true });
  const created = await writeFile(file, '', { flag: 'wx', mode: 0o600 }).then(() => true, (e: unknown) => {
    if (codeOf(e) === 'EEXIST') return false;
    throw e;
  });
  if (created) await flushEntries(file, made);
  return created;
}

/**
 * Appends a finished episode to its run's log, flushed to disk, while holding the log's claim. The
 * same record again is a no-op (`duplicate`); a different record under the same episode id is a
 * conflict and is refused, and so is a log that is already corrupt. A failed append is cut back
 * before the claim is released.
 */
export async function appendEpisode(out: string, episode: Episode, redact: Redactor): Promise<'added' | 'duplicate'> {
  const requested = logFile(out, episode.run_id);
  const line = canonicalJson(parseEpisode(episode, episode.episode_id));
  redact.assertClean(`episode ${episode.episode_id}`, line);
  const made = await mkdir(path.dirname(requested), { recursive: true });
  const file = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  const claimFile = `${file}.lock`;
  const busy = (): DatasetError => new DatasetError(`episode log ${file} already has a writer; if it crashed, run dataset release-claim for run ${episode.run_id}`);
  return withClaim(claimFile, 0, busy, async () => {
    const handle = await open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600).catch((error: unknown) => {
      if (codeOf(error) === 'ELOOP') throw new DatasetError(`episode log ${file} is a symbolic link; each run needs its own regular log file`);
      throw error;
    });
    try {
      const { nlink, size } = await handle.stat();
      if (nlink !== 1) throw new DatasetError(`episode log ${file} has ${nlink} hard links; each run needs its own regular log file`);
      const text = await handle.readFile('utf8');
      redact.assertClean(file, text);
      const same = byEpisodeId(file, episode.run_id, parseLines(text, file, parseEpisode)).get(episode.episode_id);
      if (same !== undefined) {
        if (canonicalJson(same) !== line) throw new DatasetError(`${file}: episode ${episode.episode_id} is already saved with different content`);
        await flush(handle);
        return 'duplicate';
      }
      try {
        await handle.appendFile(`${line}\n`);
        await flush(handle);
      } catch (error) {
        await handle.truncate(size).then(() => flush(handle)).catch((e: unknown) => {
          throw new DatasetError(`${messageOf(error)}; the log could not be cut back to ${size} bytes: ${messageOf(e)}`, { cause: error });
        });
        throw error;
      }
      if (size === 0) await flushEntries(requested, made);
      return 'added';
    } finally {
      await handle.close();
    }
  });
}

const holderOf = (text: string): { readonly pid: number; readonly host: string } | undefined => {
  try {
    const v = JSON.parse(text) as { pid?: unknown; host?: unknown } | null;
    if (typeof v?.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 && typeof v.host === 'string') return { pid: v.pid, host: v.host };
    return undefined;
  } catch {
    return undefined;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return codeOf(e) === 'EPERM';
  }
};

/**
 * Removes the claim that a crashed writer left on the episode log of `runId` under `out`. Refuses
 * while the claim's process is alive, when another host took it or it names no process, and when
 * the log does not validate. Removes the claim only if it is still the file it inspected.
 */
export async function releaseStaleClaim(out: string, runId: string, redact: Redactor): Promise<{ readonly claim: string; readonly pid: number; readonly episodes: number }> {
  const requested = logFile(out, runId);
  const dir = await realpath(path.dirname(requested)).catch((e: unknown) => {
    if (codeOf(e) === 'ENOENT') throw new DatasetError(`${out} has no episode logs`);
    throw e;
  });
  const file = path.join(dir, path.basename(requested));
  const claim = `${file}.lock`;
  const inspected = await lstat(claim).catch((e: unknown) => {
    if (codeOf(e) === 'ENOENT') throw new DatasetError(`run ${runId} has no claim to release: ${claim} does not exist`);
    throw e;
  });
  const text = await readFile(claim, 'utf8');
  const holder = holderOf(text);
  if (holder === undefined) throw new DatasetError(`${claim} names no process and host; stop every writer of run ${runId}, validate its log, then remove the claim by hand`);
  if (holder.host !== hostname()) throw new DatasetError(`${claim} was taken on host ${holder.host}; release it there`);
  if (isAlive(holder.pid)) throw new DatasetError(`process ${holder.pid} still holds ${claim}; stop it before releasing the claim`);
  let episodes: number;
  try {
    const text = (await readOptional(file)) ?? '';
    redact.assertClean(file, text);
    episodes = byEpisodeId(file, runId, parseLines(text, file, parseEpisode)).size;
  } catch (e) {
    throw new DatasetError(`the claim stays because the log does not validate: ${messageOf(e)}`, { cause: e });
  }
  await releaseClaim(claim, { dev: inspected.dev, ino: inspected.ino, text });
  return { claim, pid: holder.pid, episodes };
}

const stateText = (dump: unknown): string => JSON.stringify(dump);

/** Writes the engine's evidence for one episode under private/. A dump that holds a supplied secret is refused. */
export async function writeArtifacts(out: string, episodeId: string, artifacts: PrivateArtifacts, redact: Redactor): Promise<void> {
  const dir = episodeDir(out, episodeId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const parts: [string, unknown][] = [['initial.json', artifacts.initialState], ['final.json', artifacts.finalState], ['calls.json', artifacts.callLog === undefined ? undefined : redact.deep(artifacts.callLog)], ['errors.json', artifacts.errors === undefined ? undefined : redact.deep(artifacts.errors)]];
  for (const [name, value] of parts) {
    if (value === undefined) continue;
    const text = stateText(value);
    redact.assertClean(`${name} of ${episodeId}`, text);
    await writeFile(path.join(dir, name), text, { mode: 0o600 });
  }
}

/** Writes one diagnostic file under private/diagnostics/<run>/, redacted. */
export async function writeDiagnostic(out: string, runId: string, name: string, text: string, redact: Redactor): Promise<string> {
  if (!SAFE.test(name)) throw new DatasetError(`bad diagnostic name ${JSON.stringify(name)}`);
  const dir = diagnosticsDir(out, runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  await writeFile(file, redact.text(text), { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------------------------
// Export

export type ExportOptions = {
  readonly out: string;
  readonly redact: Redactor;
  /** Keep only these. Each filter that is given must match; an export with filters that match nothing is an error. */
  readonly runIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly episodeIds?: readonly string[];
};
export type ExportResult = { readonly manifest: Manifest; readonly accepted: readonly Episode[]; readonly failed: readonly Episode[] };

const byKey = (a: Episode, b: Episode): number => {
  const ka = [a.run_id, a.task_id, a.episode_id];
  const kb = [b.run_id, b.task_id, b.episode_id];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (ka[i] ?? '') < (kb[i] ?? '') ? -1 : 1;
  return 0;
};
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const lines = (eps: readonly Episode[]): string => eps.map((e) => `${canonicalJson(e)}\n`).join('');

/** Every episode in every saved log under `out`, deduplicated by id. Two different records with one id are a conflict. */
async function loadSaved(out: string, redact: Redactor): Promise<Episode[]> {
  const dir = path.join(out, LOGS_DIR);
  const names = (await readdir(dir).catch((e: unknown) => {
    if ((e as { code?: unknown } | null)?.code === 'ENOENT') return [];
    throw e;
  })).filter((n) => n.endsWith('.episodes.jsonl')).sort();
  if (names.length === 0) throw new DatasetError(`no saved episode logs under ${dir}`);
  const byId = new Map<string, Episode>();
  for (const name of names) {
    const file = path.join(dir, name);
    for (const ep of byEpisodeId(file, name.slice(0, -'.episodes.jsonl'.length), await readEpisodeLog(file, redact)).values()) {
      const seen = byId.get(ep.episode_id);
      if (seen !== undefined && canonicalJson(seen) !== canonicalJson(ep)) throw new DatasetError(`episode ${ep.episode_id} is saved twice with different content`);
      byId.set(ep.episode_id, ep);
    }
  }
  return [...byId.values()];
}

async function artifactHash(root: string, rel: string): Promise<string> {
  const text = await readFile(path.join(root, ...rel.split('/'))).catch(() => undefined);
  if (text === undefined) throw new DatasetError(`the frozen world ${rel} is missing`);
  return sha256Hex(text);
}

/**
 * Exports the saved logs under `out`, then reopens the written files and validates them. The
 * result depends only on the selected records, so exporting twice gives byte-identical files and
 * no duplicate rows. Files are written to a temporary directory, validated there, and moved into
 * place with the manifest last; a failed check leaves any earlier export untouched. Exports of one
 * `out` take turns on its export claim, so runs that share it each publish one whole set.
 */
export async function exportDataset(o: ExportOptions): Promise<ExportResult> {
  const claim = path.join(o.out, EXPORT_CLAIM);
  const busy = (): DatasetError => new DatasetError(`another export of ${o.out} has held ${claim} for ${EXPORT_WAIT_MS / 60_000} minutes; if no export is running, remove it and export again`);
  return withClaim(claim, EXPORT_WAIT_MS, busy, () => exportClaimed(o));
}

async function exportClaimed(o: ExportOptions): Promise<ExportResult> {
  const all = await loadSaved(o.out, o.redact);
  const filtered = o.runIds !== undefined || o.taskIds !== undefined || o.episodeIds !== undefined;
  const keep = (ep: Episode): boolean =>
    (o.runIds === undefined || o.runIds.includes(ep.run_id)) &&
    (o.taskIds === undefined || o.taskIds.includes(ep.task_id)) &&
    (o.episodeIds === undefined || o.episodeIds.includes(ep.episode_id));
  const chosen = all.filter(keep).sort(byKey);
  if (filtered && chosen.length === 0) throw new DatasetError('the run, task and episode filters match no saved episode');
  const accepted = chosen.filter(isCompleteSuccess);
  const failed = chosen.filter((e) => !isCompleteSuccess(e));
  // The manifest names one model (A-283): the one the episodes called. A noop episode called none, and an export with no model call keeps the default.
  const models = sorted(chosen.flatMap((e) => (e.model === null ? [] : [e.model])));
  if (models.length > 1) throw new DatasetError(`an export holds one model, and these episodes ran ${models.join(' and ')}: filter by run id`);

  const worlds = new Map<string, { world_id: string; world_version: string }>();
  for (const ep of chosen) {
    const seen = worlds.get(ep.world_version);
    if (seen !== undefined && seen.world_id !== ep.world_id) throw new DatasetError(`world version ${ep.world_version} is named ${seen.world_id} and ${ep.world_id}`);
    worlds.set(ep.world_version, { world_id: ep.world_id, world_version: ep.world_version });
  }
  const worldRefs = [...worlds.values()].sort((a, b) => (a.world_version < b.world_version ? -1 : 1));
  const refs: Manifest['worlds'] = [];
  for (const w of worldRefs) {
    const rel = worldArtifactPath(w.world_version);
    const sha = await artifactHash(o.out, rel);
    if (sha !== w.world_version) throw new DatasetError(`the frozen world ${rel} hashes to ${sha}, not its world version`);
    refs.push({ ...w, artifact: { path: rel, sha256: sha } });
  }

  const datasetText = lines(accepted);
  const failuresText = lines(failed);
  const byStop: Record<string, number> = {};
  for (const ep of chosen) byStop[ep.stop_reason] = (byStop[ep.stop_reason] ?? 0) + 1;
  const manifest: Manifest = {
    manifest_version: MANIFEST_VERSION,
    schema_version: SCHEMA_VERSION,
    provider: PROVIDER,
    model: models[0] ?? DEFAULT_MODEL,
    prompt_versions: sorted(chosen.map((e) => e.prompt_version)),
    config_versions: sorted(chosen.map((e) => e.config_version)),
    engine_commits: sorted(chosen.map((e) => e.engine_commit)),
    run_ids: sorted(chosen.map((e) => e.run_id)),
    selection: filtered ? { run_ids: sorted(o.runIds ?? []), task_ids: sorted(o.taskIds ?? []), episode_ids: sorted(o.episodeIds ?? []) } : null,
    worlds: refs,
    counts: { episodes: chosen.length, accepted: accepted.length, failed: failed.length, by_stop_reason: Object.fromEntries(Object.entries(byStop).sort(([a], [b]) => (a < b ? -1 : 1))) },
    files: {
      dataset: { path: DATASET_FILE, records: accepted.length, bytes: Buffer.byteLength(datasetText), sha256: sha256Hex(datasetText) },
      failures: { path: FAILURES_FILE, records: failed.length, bytes: Buffer.byteLength(failuresText), sha256: sha256Hex(failuresText) },
    },
    grading_note: GRADING_NOTE,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const [what, text] of [[DATASET_FILE, datasetText], [FAILURES_FILE, failuresText], [MANIFEST_FILE, manifestText]] as const) o.redact.assertClean(what, text);

  const tmp = path.join(o.out, '.export-tmp');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    await writeFile(path.join(tmp, DATASET_FILE), datasetText);
    await writeFile(path.join(tmp, FAILURES_FILE), failuresText);
    await writeFile(path.join(tmp, MANIFEST_FILE), manifestText);
    await validateExport(tmp, { root: o.out, redact: o.redact });
    for (const name of [DATASET_FILE, FAILURES_FILE, MANIFEST_FILE]) await rename(path.join(tmp, name), path.join(o.out, name));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const reopened = await validateExport(o.out, { redact: o.redact });
  return { manifest: reopened, accepted, failed };
}

// ---------------------------------------------------------------------------------------------
// Reopening

/**
 * Reopens the written export in `dir` and checks it against its manifest and against the private
 * evidence under `root` (default `dir`): file sizes and hashes, one canonical valid record per
 * line in key order, successes complete and failures not, no id twice, counts, version lists, the
 * frozen world hashes, and the engine's state files for every accepted episode. Returns the
 * manifest, or throws a DatasetError. A pass means the files are internally consistent; it does
 * not certify the replies' factual claims.
 */
export async function validateExport(dir: string, opts: { readonly root?: string; readonly redact: Redactor }): Promise<Manifest> {
  const root = opts.root ?? dir;
  const manifestRaw = await readOptional(path.join(dir, MANIFEST_FILE));
  if (manifestRaw === undefined) throw new DatasetError(`${path.join(dir, MANIFEST_FILE)} does not exist`);
  opts.redact.assertClean(MANIFEST_FILE, manifestRaw);
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (e) {
    throw new DatasetError(`${MANIFEST_FILE}: not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const manifest = parseManifest(manifestJson, MANIFEST_FILE);

  const read = async (entry: Manifest['files']['dataset'], expectSuccess: boolean): Promise<Episode[]> => {
    const text = await readOptional(path.join(dir, entry.path));
    if (text === undefined) throw new DatasetError(`${entry.path} does not exist`);
    if (Buffer.byteLength(text) !== entry.bytes) throw new DatasetError(`${entry.path} has ${Buffer.byteLength(text)} bytes, the manifest says ${entry.bytes}`);
    if (sha256Hex(text) !== entry.sha256) throw new DatasetError(`${entry.path} fails its checksum`);
    opts.redact.assertClean(entry.path, text);
    const eps = parseLines(text, entry.path, parseEpisode);
    if (eps.length !== entry.records) throw new DatasetError(`${entry.path} has ${eps.length} records, the manifest says ${entry.records}`);
    (text === '' ? [] : text.slice(0, -1).split('\n')).forEach((line, i) => {
      if (line !== canonicalJson(eps[i])) throw new DatasetError(`${entry.path}:${i + 1}: record is not in canonical form`);
    });
    eps.forEach((ep, i) => {
      if (isCompleteSuccess(ep) !== expectSuccess) {
        throw new DatasetError(`${entry.path}:${i + 1}: episode ${ep.episode_id} ${expectSuccess ? 'is not a complete success' : 'is a complete success and belongs in dataset.jsonl'}`);
      }
      const prev = eps[i - 1];
      if (prev !== undefined && byKey(prev, ep) >= 0) throw new DatasetError(`${entry.path}:${i + 1}: records are not in run, task, episode order`);
    });
    return eps;
  };
  const accepted = await read(manifest.files.dataset, true);
  const failed = await read(manifest.files.failures, false);

  const ids = [...accepted, ...failed].map((e) => e.episode_id);
  if (new Set(ids).size !== ids.length) throw new DatasetError('an episode id appears twice across dataset.jsonl and failures.jsonl');
  const all = [...accepted, ...failed];
  const stops: Record<string, number> = {};
  for (const ep of all) stops[ep.stop_reason] = (stops[ep.stop_reason] ?? 0) + 1;
  const wantCounts = { episodes: all.length, accepted: accepted.length, failed: failed.length, by_stop_reason: stops };
  if (canonicalJson(wantCounts) !== canonicalJson(manifest.counts)) throw new DatasetError('the manifest counts do not match the records');
  const sameList = (name: string, have: readonly string[], want: readonly string[]): void => {
    if (canonicalJson(have) !== canonicalJson(sorted(want))) throw new DatasetError(`the manifest ${name} do not match the records`);
  };
  sameList('prompt versions', manifest.prompt_versions, all.map((e) => e.prompt_version));
  sameList('config versions', manifest.config_versions, all.map((e) => e.config_version));
  sameList('engine commits', manifest.engine_commits, all.map((e) => e.engine_commit));
  sameList('run ids', manifest.run_ids, all.map((e) => e.run_id));
  sameList('world versions', manifest.worlds.map((w) => w.world_version), all.map((e) => e.world_version));
  for (const w of manifest.worlds) {
    if (w.artifact.path !== worldArtifactPath(w.world_version) || w.artifact.sha256 !== w.world_version) throw new DatasetError(`world ${w.world_id} has a bad artifact reference`);
    if ((await artifactHash(root, w.artifact.path)) !== w.artifact.sha256) throw new DatasetError(`the frozen world ${w.artifact.path} fails its checksum`);
    if (all.some((e) => e.world_version === w.world_version && e.world_id !== w.world_id)) throw new DatasetError(`world ${w.world_version} is named inconsistently`);
  }
  for (const ep of accepted) {
    for (const [name, want] of [['initial.json', ep.initial_state_hash], ['final.json', ep.final_state_hash]] as const) {
      const text = await readOptional(path.join(episodeDir(root, ep.episode_id), name));
      if (text === undefined) throw new DatasetError(`episode ${ep.episode_id}: private ${name} is missing`);
      let dump: unknown;
      try {
        dump = JSON.parse(text);
      } catch {
        throw new DatasetError(`episode ${ep.episode_id}: private ${name} is not JSON`);
      }
      if (hashState(dump) !== want) throw new DatasetError(`episode ${ep.episode_id}: private ${name} does not match the recorded state hash`);
    }
  }
  return manifest;
}
