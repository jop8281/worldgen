/**
 * The sequential dataset run (YOS-91): check and freeze the world, bring it up in one sandbox,
 * run one episode per proven task, collect evidence, export and reopen the JSONL, and always
 * tear the sandbox down. Shell code: it reads and writes files and talks to a SandboxBackend.
 * It imports no model: the solver arrives as `NextTurn`.
 *
 * The controller reaches the world two ways. The public API goes over HTTP to the URL
 * `upWorld` exposed. The admin routes (reset, state, grade, log) are never exposed: the
 * controller runs a small Node script inside the sandbox through `backend.exec`, with every
 * value passed as argv, and downloads results in verified chunks.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  checkWorld, createRuntime, dumpSha256, loadWorld, openApiOf, publicWorldOf, renderWorldYaml, saveWorld, taskPrivacy, worldIdOf,
  type CheckedWorld, type Difficulty, type OpenApiDocument, type StateDump, type Wid,
} from '#engine';
import { READY_TIMEOUT_SEC, SERVE_LOG, reachWorld, upWorld, type Runner, type SandboxBackend, type WorldBundle } from '../sandboxes/backend.ts';
import { runEpisode, type NextTurn, type SendableRequest, type WorldPort } from './episode.ts';
import {
  DatasetError, GRADING_NOTE, PROMPT_VERSION, RUN_ID, TASK_ID, configVersion, hashState, isCompleteSuccess, redactor, sha256Hex,
  type Episode, type Manifest, type Redactor,
} from './schema.ts';
import { appendEpisode, diagnosticsDir, exportDataset, startRunLog, writeArtifacts, writeDiagnostic, worldArtifactPath } from './store.ts';
import { engineGrader, type GraderFactory } from './verifier.ts';

/** A problem found before anything was started: bad option, world that does not check, run id already used. Nothing is created but the frozen world, which runs share. */
export class PreflightError extends Error {
  override readonly name = 'PreflightError';
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------------------------
// The world

export type PreparedWorld = {
  readonly world: CheckedWorld;
  readonly worldId: string;
  /** worldIdOf of the full world: the identity the public bundle stays bound to, by request and folder name (YOS-159). */
  readonly wid: Wid;
  /** sha-256 of the frozen world.yaml. */
  readonly worldVersion: string;
  /** The directory holding the frozen private world.yaml and, under `public/`, its public form. */
  readonly frozenDir: string;
  /** The directory holding only the public world.yaml. It is what gets uploaded. */
  readonly publicDir: string;
  readonly openapi: OpenApiDocument;
  /** The seed state's hash, from a local engine over the checked world. */
  readonly seedHash: string;
  readonly tasks: readonly { readonly id: string; readonly difficulty: Difficulty; readonly instruction: string }[];
};

const MAX_ISSUES_SHOWN = 5;

/**
 * Checks `worldDir` with the deterministic engine and requires at least one task and a proof
 * for every task. Nothing is written. Throws a PreflightError naming the first issues.
 */
export type CheckedForRun = { readonly world: CheckedWorld; readonly tasks: PreparedWorld['tasks'] };
export async function checkForRun(worldDir: string): Promise<CheckedForRun> {
  const loaded = await loadWorld(worldDir);
  const issues = !loaded.ok ? loaded.error : null;
  const report = loaded.ok ? checkWorld(loaded.value) : null;
  if (issues !== null || (report !== null && !report.ok)) {
    const list = issues ?? (report !== null && !report.ok ? report.issues : []);
    const shown = list.slice(0, MAX_ISSUES_SHOWN).map((i) => `${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}`);
    throw new PreflightError(`the world in ${worldDir} does not check (${list.length} issue${list.length === 1 ? '' : 's'}):\n${shown.join('\n')}`);
  }
  if (report === null || !report.ok) throw new PreflightError(`the world in ${worldDir} could not be checked`);
  const ids = Object.keys(report.world.tasks);
  if (ids.length === 0) throw new PreflightError(`the world in ${worldDir} has no tasks`);
  if (taskPrivacy(report.world) === 'public') {
    throw new PreflightError(`the world in ${worldDir} is a public bundle: its tasks carry only their instructions, so no episode can be graded; run the dataset on the private world`);
  }
  const unproven = ids.filter((id) => !Object.hasOwn(report.verdicts, id));
  if (unproven.length > 0) throw new PreflightError(`the world has tasks the engine did not prove: ${unproven.join(', ')}`);
  const tasks = ids.map((id) => {
    const t = report.world.tasks[id];
    if (id.includes('__')) throw new PreflightError(`task ${JSON.stringify(id)} cannot be used as a dataset task id: an episode id joins run, task and number with "__", so a task id cannot contain "__"`);
    if (t === undefined || !TASK_ID.test(id)) throw new PreflightError(`task ${JSON.stringify(id)} cannot be used as a dataset task id`);
    return { id, difficulty: t.difficulty, instruction: t.instruction };
  });
  return { world: report.world, tasks };
}

/**
 * Checks the world, then freezes both forms of it under `out` (YOS-159): the private world as
 * `private/worlds/<hash>/world.yaml` and its public form as `private/worlds/<hash>/public/world.yaml`,
 * both written through saveWorld, so each is a world the engine checked. Each call stages its own
 * copy and renames it into place, so runs that share `out` can freeze one world at once. The public
 * form is what gets uploaded; the private world is what the verifier grades against, and it never
 * leaves the trusted side.
 */
export async function prepareWorld(worldDir: string, out: string, checked?: CheckedForRun): Promise<PreparedWorld> {
  const { world, tasks } = checked ?? (await checkForRun(worldDir));
  const worldVersion = sha256Hex(renderWorldYaml(world));
  const artifact = path.join(out, ...worldArtifactPath(worldVersion).split('/'));
  const frozenDir = path.dirname(artifact);
  await mkdir(frozenDir, { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(frozenDir), '.freeze-'));
  try {
    await saveWorld(staging, world);
    await rename(path.join(staging, path.basename(artifact)), artifact);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const written = sha256Hex(await readFile(artifact));
  if (written !== worldVersion) throw new DatasetError(`the frozen world ${artifact} hashes to ${written}, expected ${worldVersion}`);
  const publicDir = path.join(frozenDir, 'public');
  const publicReport = checkWorld(publicWorldOf(world));
  if (!publicReport.ok) {
    const [first] = publicReport.issues;
    throw new PreflightError(`the public form of the world in ${worldDir} does not check: ${first?.code} ${first?.path.join('.')}`);
  }
  // The public form is staged like the private one: saveWorld's internal tmp rename is a fixed
  // path, so concurrent prepareWorld calls on a shared --out must not rename over each other.
  const publicStaging = await mkdtemp(path.join(path.dirname(frozenDir), '.freeze-public-'));
  try {
    await saveWorld(publicStaging, publicReport.world);
    await mkdir(publicDir, { recursive: true });
    await rename(path.join(publicStaging, 'world.yaml'), path.join(publicDir, 'world.yaml'));
  } finally {
    await rm(publicStaging, { recursive: true, force: true });
  }
  let seed: StateDump;
  try {
    seed = JSON.parse(JSON.stringify(createRuntime(world).dump())) as StateDump;
  } catch (e) {
    throw new PreflightError(`the engine could not build the world's seed state: ${messageOf(e)}`);
  }
  return { world, worldId: world.meta.name, wid: worldIdOf(world), worldVersion, frozenDir, publicDir, openapi: openApiOf(world), seedHash: hashState(seed), tasks };
}

// ---------------------------------------------------------------------------------------------
// The sandbox port

/** Runs in the sandbox: one admin request. argv: method, url, output file. Prints status, size and hash, and the body when it is small. */
export const ADMIN_SCRIPT =
  "const fs=require('node:fs'),c=require('node:crypto');" +
  "fetch(process.argv[2],{method:process.argv[1]}).then(async r=>{const t=await r.text();const b=Buffer.from(t);fs.writeFileSync(process.argv[3],b);" +
  "const o={status:r.status,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')};if(b.length<=30000)o.inline=t;process.stdout.write(JSON.stringify(o))})" +
  ".catch(e=>{process.stderr.write(String(e&&e.message||e));process.exit(2)});";
/** Runs in the sandbox: size and hash of one file. argv: path. */
export const STAT_SCRIPT =
  "const fs=require('node:fs'),c=require('node:crypto');const b=fs.readFileSync(process.argv[1]);process.stdout.write(JSON.stringify({bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}));";
/** Runs in the sandbox: one chunk of a file as base64. argv: path, offset, length. */
export const CHUNK_SCRIPT =
  "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');const n=Number(process.argv[3]);const b=Buffer.alloc(n);" +
  "const k=fs.readSync(fd,b,0,n,Number(process.argv[2]));process.stdout.write(b.subarray(0,k).toString('base64'));";

const CHUNK_BYTES = 48 * 1024;
const ADMIN_TIMEOUT_SEC = 120;

type AdminResult = { readonly status: number; readonly bytes: number; readonly sha256: string; readonly inline?: string };

function parseAdminResult(text: string): AdminResult {
  const o = JSON.parse(text) as { status?: unknown; bytes?: unknown; sha256?: unknown; inline?: unknown } | null;
  if (typeof o?.status !== 'number' || typeof o.bytes !== 'number' || typeof o.sha256 !== 'string' || (o.inline !== undefined && typeof o.inline !== 'string')) {
    throw new Error('the sandbox answered with something other than the admin result');
  }
  return { status: o.status, bytes: o.bytes, sha256: o.sha256, ...(o.inline === undefined ? {} : { inline: o.inline }) };
}

export type SandboxPortOptions = {
  readonly backend: SandboxBackend;
  readonly sandboxId: string;
  readonly workdir: string;
  /** The public world URL `upWorld` returned. */
  readonly url: string;
  /** Inside the sandbox only. */
  readonly adminPort: number;
  readonly fetch?: typeof globalThis.fetch;
};
export type SandboxPort = WorldPort & {
  /** Downloads a file from the sandbox in verified chunks. */
  download(remotePath: string): Promise<Buffer>;
};

/** A WorldPort over a running sandbox: public HTTP for `call`, backend.exec scripts for the private routes. */
/**
 * The state dump in an admin `GET /_world/state` answer. The route adds its own sha-256 digest of the
 * dump (YOS-183). It is not part of the state, so it must match the dump and is dropped before anything
 * hashes the state, or every reset would miss the frozen seed hash.
 */
export function stateFromAdmin(read: unknown): StateDump {
  const r = read as (Partial<StateDump> & { sha256?: unknown }) | null;
  if (r === null || typeof r !== 'object' || typeof r.now !== 'string' || typeof r.tables !== 'object' || typeof r.counters !== 'object') {
    throw new Error('state read did not return a state dump');
  }
  const { sha256: digest, ...dump } = r;
  if (digest !== undefined && digest !== dumpSha256(dump as StateDump)) throw new Error('state read returned a sha-256 digest that does not match its dump');
  return dump as StateDump;
}

export function sandboxPort(o: SandboxPortOptions): SandboxPort {
  const doFetch = o.fetch ?? globalThis.fetch;
  const base = new URL(o.url);
  const adminBase = `http://127.0.0.1:${o.adminPort}`;
  const tag = o.sandboxId.replace(/[^A-Za-z0-9_-]/g, '_');
  let counter = 0;

  const exec = async (argv: readonly string[], what: string): Promise<string> => {
    const r = await o.backend.exec(o.sandboxId, argv, { workdir: o.workdir, timeoutSec: ADMIN_TIMEOUT_SEC });
    if (r.exitCode !== 0) throw new Error(`${what} failed in the sandbox (exit ${r.exitCode}): ${(r.stderr.trim() || r.stdout.trim() || 'no output').split('\n').slice(-1)[0]}`);
    return r.stdout;
  };

  async function download(remotePath: string, known?: { bytes: number; sha256: string }): Promise<Buffer> {
    const meta = known ?? (JSON.parse(await exec(['node', '-e', STAT_SCRIPT, remotePath], `stat ${path.posix.basename(remotePath)}`)) as { bytes: number; sha256: string });
    const parts: Buffer[] = [];
    for (let offset = 0; offset < meta.bytes; offset += CHUNK_BYTES) {
      const len = Math.min(CHUNK_BYTES, meta.bytes - offset);
      const chunk = Buffer.from(await exec(['node', '-e', CHUNK_SCRIPT, remotePath, String(offset), String(len)], `read ${path.posix.basename(remotePath)}`), 'base64');
      if (chunk.length !== len) throw new Error(`download of ${path.posix.basename(remotePath)} returned ${chunk.length} bytes at offset ${offset}, expected ${len}`);
      parts.push(chunk);
    }
    const data = Buffer.concat(parts);
    if (data.length !== meta.bytes || createHash('sha256').update(data).digest('hex') !== meta.sha256) {
      throw new Error(`download of ${path.posix.basename(remotePath)} fails its checksum`);
    }
    return data;
  }

  /** One private admin request. `label` names it in errors, so no admin path or URL leaves this function. */
  async function admin(method: 'GET' | 'POST', route: string, label: string): Promise<unknown> {
    const file = `/tmp/wg-admin-${tag}-${++counter}.json`;
    const r = parseAdminResult(await exec(['node', '-e', ADMIN_SCRIPT, method, `${adminBase}${route}`, file], label));
    const text = r.inline ?? (await download(file, r)).toString('utf8');
    if (r.inline !== undefined && sha256Hex(text) !== r.sha256) throw new Error(`${label} answer fails its checksum`);
    if (r.status !== 200) throw new Error(`${label} answered HTTP ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  }

  return {
    download: (p) => download(p),
    async call(req: SendableRequest, signal) {
      const target = new URL(base.origin + req.target);
      if (target.origin !== base.origin) throw new Error('the request does not stay on the world host');
      const res = await doFetch(target, {
        method: req.method,
        redirect: 'manual',
        signal,
        headers: { accept: 'application/json', ...(req.bodyText === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(req.bodyText === undefined ? {} : { body: req.bodyText }),
      });
      return { status: res.status, text: await res.text() };
    },
    async reset() {
      const r = (await admin('POST', '/_world/reset', 'reset')) as { ok?: unknown };
      if (r.ok !== true) throw new Error('reset did not report ok');
    },
    async state() {
      return stateFromAdmin(await admin('GET', '/_world/state', 'state read'));
    },
    async log() {
      // The world served in the sandbox is the public form (YOS-159): it has no grader, so the
      // admin grade route there can no longer score. Reading the log is all that is left, and the
      // trusted verifier grades the trace it records against the private world.
      const r = (await admin('GET', '/_world/log', 'log read')) as { calls?: unknown } | null;
      if (r === null || typeof r !== 'object' || !Array.isArray(r.calls)) throw new Error('log read did not return the call log');
      return r.calls as Awaited<ReturnType<WorldPort['log']>>;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The run

export type PipelineOptions = {
  readonly worldDir: string;
  readonly out: string;
  readonly runId: string;
  readonly engineCommit: string;
  /** The model the solver calls, recorded on every episode (A-283). */
  readonly model: string;
  readonly maxTurns: number;
  readonly budgetUsd: number;
  readonly maxMinutes: number;
  /** Values the controller holds, such as API keys, that must never reach a public or private record. The caller reads them from its environment. */
  readonly secrets: readonly string[];
  /** The sandbox name, a safe slug (see `sandboxName`). */
  readonly sandboxName: string;
  /** The world port inside the sandbox. The admin port is this plus one. Default 4000. */
  readonly port?: number;
};
export type PipelineDeps = {
  readonly backend: SandboxBackend;
  readonly nextTurn: NextTurn;
  /**
   * The files to upload for the frozen world directory. The real one is `collectBundle(codeDir,
   * dir, { publicOnly: true })`: the public form of the world and the code package, nothing
   * private (YOS-159). A test seam may upload anything.
   */
  readonly makeBundle: (frozenDir: string) => Promise<WorldBundle>;
  /**
   * Builds the trusted grader the episodes grade through. Default `engineGrader`: the protocol
   * verified in this process through #engine. The CLI passes `childGrader`, one separate host
   * process per submission with the private world by path.
   */
  readonly grader?: GraderFactory;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** The result of `checkForRun(worldDir)` when the caller already ran it, so the world is not checked twice. */
  readonly checked?: CheckedForRun;
  /** Runs the check and prepare children. Default nodeRunner. */
  readonly runner?: Runner;
  /** The source the children's allowlisted environment is built from. Default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly interrupt?: AbortSignal;
  readonly log?: (line: string) => void;
};

/** `accepted`: every task has a complete successful episode and every gate passed. `incomplete`: the pipeline is sound but some episodes failed. `failed`: a pipeline gate failed. */
export type PipelineStatus = 'accepted' | 'incomplete' | 'failed';
export type PipelineResult = {
  readonly status: PipelineStatus;
  readonly runId: string;
  readonly episodes: readonly Episode[];
  readonly accepted: number;
  readonly failed: number;
  readonly manifest: Manifest | null;
  readonly sandbox: { readonly id: string | null; readonly teardown: 'confirmed' | 'failed' | 'not_started' };
  /** Everything that stopped the pipeline from being sound: lost evidence, a failed export, a sandbox that may still run. */
  readonly problems: readonly string[];
  readonly modelCostUsd: number;
  readonly paths: { readonly out: string; readonly diagnostics: string; readonly report: string };
};

function validateOptions(o: PipelineOptions): void {
  const bad = (m: string): never => {
    throw new PreflightError(m);
  };
  if (!RUN_ID.test(o.runId)) bad(`run id ${JSON.stringify(o.runId)} must be 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit, with no "__" and no "_" at the end`);
  if (!/^[0-9a-f]{7,64}$/.test(o.engineCommit)) bad(`engine commit ${JSON.stringify(o.engineCommit)} must be 7 to 64 lowercase hex digits`);
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1) bad('max turns must be a whole number of at least 1');
  if (!Number.isFinite(o.budgetUsd) || o.budgetUsd <= 0) bad('budget must be a positive number of USD');
  if (!Number.isFinite(o.maxMinutes) || o.maxMinutes <= 0) bad('max minutes must be a positive number');
}

function reportOf(r: Omit<PipelineResult, 'paths'>, worldId: string, taskCount: number): string {
  const rows = r.episodes.map((e) => `| ${e.task_id} | ${e.difficulty} | ${e.stop_reason} | ${e.score === null ? 'none' : e.score} | ${e.usage.model_calls} | ${e.usage.cost_usd} |`);
  return [
    `# Dataset run ${r.runId}`,
    '',
    `World \`${worldId}\`, ${taskCount} proven task${taskCount === 1 ? '' : 's'}. Status: **${r.status}**. Sandbox teardown: ${r.sandbox.teardown}.`,
    `Accepted episodes: ${r.accepted}. Failed episodes: ${r.failed}. Model spend: ${r.modelCostUsd} USD.`,
    '',
    '| task | difficulty | stop | engine score | model calls | cost USD |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...(r.problems.length === 0 ? [] : [`Problems: ${r.problems.length}. The details are in the private diagnostics summary, not in this report.`, '']),
    `Grading: ${GRADING_NOTE}`,
    '',
  ].join('\n');
}

export async function runPipeline(o: PipelineOptions, deps: PipelineDeps): Promise<PipelineResult> {
  validateOptions(o);
  const log = deps.log ?? ((): void => undefined);
  const now = deps.now ?? Date.now;
  const base = redactor(o.secrets);
  const checked = deps.checked ?? (await checkForRun(o.worldDir));
  base.assertClean('the source world', JSON.stringify(checked.world));
  const prep = await prepareWorld(o.worldDir, o.out, checked);
  if (!(await startRunLog(o.out, o.runId))) throw new PreflightError(`run id ${o.runId} is already used in ${o.out}: pick another --run-id`);
  log(`world ${prep.worldId} ${prep.worldVersion.slice(0, 12)} checked and frozen; ${prep.tasks.length} proven task(s)`);

  const problems: string[] = [];
  const paths = { out: o.out, diagnostics: diagnosticsDir(o.out, o.runId), report: path.join(o.out, 'REPORT.md') };
  const episodes: Episode[] = [];
  let manifest: Manifest | null = null;
  let spent = 0;
  const port = o.port ?? 4000;
  const started = now();
  const deadline = started + o.maxMinutes * 60_000;
  const cfg = configVersion({ maxTurns: o.maxTurns, budgetUsd: o.budgetUsd, maxMinutes: o.maxMinutes });

  async function finish(sandbox: PipelineResult['sandbox'], redact: Redactor): Promise<PipelineResult> {
    const accepted = episodes.filter(isCompleteSuccess).length;
    const status: PipelineStatus = problems.length > 0 || manifest === null ? 'failed' : accepted === prep.tasks.length ? 'accepted' : 'incomplete';
    const partial = { status, runId: o.runId, episodes, accepted, failed: episodes.length - accepted, manifest, sandbox, problems, modelCostUsd: Math.round(spent * 1e9) / 1e9, paths };
    try {
      await mkdir(o.out, { recursive: true });
      await writeFile(paths.report, redact.text(reportOf(partial, prep.worldId, prep.tasks.length)));
      await writeDiagnostic(o.out, o.runId, 'summary.json', JSON.stringify({ status, sandbox, problems, accepted, failed: partial.failed, modelCostUsd: partial.modelCostUsd }, null, 2), redact);
    } catch (e) {
      problems.push(`the run report and diagnostics summary were not saved: ${messageOf(e)}`);
      return { ...partial, status: 'failed', problems };
    }
    return partial;
  }

  // 1. Up. upWorld tears the sandbox down itself when it fails after creating it.
  let up: Awaited<ReturnType<typeof upWorld>>;
  try {
    const bundle = await deps.makeBundle(prep.frozenDir);
    up = await upWorld(deps.backend, bundle, {
      name: o.sandboxName, port, public: true,
      reach: (url) => reachWorld(url, Math.max(0, Math.min(READY_TIMEOUT_SEC, (deadline - now()) / 1000)), {
        now,
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      }),
    });
  } catch (e) {
    const why = base.text(messageOf(e));
    problems.push(`the sandbox did not come up: ${why}`);
    return finish({ id: null, teardown: /also failed/.test(why) ? 'failed' : 'not_started' }, base);
  }
  const sandboxId = up.sandbox.id;
  const redact = redactor([...o.secrets, up.url, `127.0.0.1:${port + 1}`]);
  let teardown: 'confirmed' | 'failed' = 'confirmed';
  try {
    log(`sandbox ${sandboxId} is up`);
    const world = sandboxPort({ backend: deps.backend, sandboxId, workdir: up.sandbox.workdir, url: up.url, adminPort: port + 1, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
    // The trusted grader (YOS-159): one verifier session for the whole run, so a submission graded once cannot be graded again.
    const grade = (deps.grader ?? engineGrader)({
      world: prep.world, wid: prep.wid, worldVersion: prep.worldVersion, frozenDir: prep.frozenDir, engine: o.engineCommit,
    });
    // 2. Episodes, one after another, each from a reset world and an empty conversation.
    for (const task of prep.tasks) {
      if (deps.interrupt?.aborted === true) {
        problems.push('interrupted before every task had an episode');
        break;
      }
      const { episode, artifacts } = await runEpisode({
        runId: o.runId, engineCommit: o.engineCommit, worldId: prep.worldId, worldVersion: prep.worldVersion, promptVersion: PROMPT_VERSION, configVersion: cfg, model: o.model,
        task, index: 1, openapi: prep.openapi, seedHash: prep.seedHash, port: world, grade, nextTurn: deps.nextTurn,
        maxTurns: o.maxTurns, budgetLeftUsd: o.budgetUsd - spent, deadline, now, redact, interrupt: deps.interrupt,
      });
      spent += episode.usage.cost_usd;
      episodes.push(episode);
      log(`episode ${episode.episode_id}: ${episode.stop_reason}, engine score ${episode.score === null ? 'none' : episode.score}, ${episode.usage.cost_usd} USD`);
      try {
        await writeArtifacts(o.out, episode.episode_id, artifacts, redact);
        await appendEpisode(o.out, episode, redact);
      } catch (e) {
        problems.push(`episode ${episode.episode_id} was not saved: ${messageOf(e)}`);
      }
    }

    // 3. Evidence from the sandbox, before it stops. A partial failure is itself kept as a diagnostic.
    const collectErrors: string[] = [];
    const collect = async (name: string, get: () => Promise<string | Buffer>): Promise<void> => {
      try {
        await writeDiagnostic(o.out, o.runId, name, (await get()).toString(), redact);
      } catch (e) {
        collectErrors.push(`${name}: ${messageOf(e)}`);
      }
    };
    await collect('worldplay.log', () => world.download(SERVE_LOG));
    await collect('final-state.json', async () => JSON.stringify(await world.state()));
    await collect('final-log.json', async () => JSON.stringify({ calls: await world.log() }));
    if (collectErrors.length > 0) {
      problems.push(`collecting from the sandbox failed: ${collectErrors.join('; ')}`);
      await writeDiagnostic(o.out, o.runId, 'collect-errors.txt', collectErrors.join('\n'), redact).catch((e: unknown) => {
        problems.push(`the collection errors were not saved: ${messageOf(e)}`);
      });
    }

    // 4. Export what the logs hold, reopen it, and validate it.
    try {
      const exported = await exportDataset({ out: o.out, redact });
      manifest = exported.manifest;
      log(`exported ${manifest.counts.accepted} accepted and ${manifest.counts.failed} failed episode(s) and reopened them`);
    } catch (e) {
      problems.push(`export failed: ${messageOf(e)}`);
    }
  } catch (e) {
    problems.push(`the run stopped on an unexpected error: ${redact.text(messageOf(e))}`);
  } finally {
    try {
      await deps.backend.down(sandboxId);
    } catch (e) {
      teardown = 'failed';
      problems.push(`teardown of sandbox ${sandboxId} failed and it may still be running: ${redact.text(messageOf(e))}`);
    }
    if (teardown === 'confirmed') {
      try {
        log(`sandbox ${sandboxId} stopped`);
      } catch (e) {
        problems.push(`logging the confirmed stop of sandbox ${sandboxId} failed: ${redact.text(messageOf(e))}`);
      }
    }
  }
  return finish({ id: sandboxId, teardown }, redact);
}
