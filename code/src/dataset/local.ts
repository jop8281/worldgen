/**
 * One agent episode on the operator's own machine, for the studio's Agent Playground (YOS-190).
 * The world never runs in this process, whose environment holds the model key (A-347). A prepare
 * child checks and freezes it, a `worldplay serve` child serves it on loopback (the agent gets only
 * the world port and the public OpenAPI document, the admin port is the controller's private
 * channel for reset, state and log), and a `cli/verifier.ts` child grades each recorded trace
 * against the private world. Each runs in an allowlisted environment; only `nextTurn` keeps this
 * process's own.
 * The episode is saved, exported and reopened through store.ts exactly as a dataset run's are.
 *
 * There is no sandbox here, so this is for a trusted operator on loopback. Hosted or untrusted
 * agents need the YOS-159/191 boundary that pipeline.ts runs in Boat.
 */
import type { CallRecord } from '#engine';
import { isolatedEnv, listeningPorts, nodeRunner, nodeSpawn, type Runner, type SpawnedChild, type Spawner } from '../sandboxes/backend.ts';
import { runEpisode, type NextTurn, type SendableRequest, type WorldPort } from './episode.ts';
import { CODE_DIR, prepareInChild, stateFromAdmin } from './pipeline.ts';
import { PROMPT_VERSION, canonicalJson, configVersion, type Episode, type Redactor } from './schema.ts';
import { appendEpisode, exportDataset, startRunLog, writeArtifacts, type ExportResult } from './store.ts';
import { childGrader } from './verifier.ts';

/** A WorldPort over a world served on loopback: the world port for the agent, the admin port for the controller. */
export function loopbackPort(server: { readonly url: string; readonly adminUrl: string }, doFetch: typeof fetch = globalThis.fetch): WorldPort {
  const base = new URL(server.url);
  async function admin(method: 'GET' | 'POST', route: string, label: string): Promise<unknown> {
    const res = await doFetch(`${server.adminUrl}${route}`, { method, headers: { accept: 'application/json' } });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`${label} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  }
  return {
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
      const r = (await admin('GET', '/_world/log', 'log read')) as { calls?: unknown } | null;
      if (r === null || typeof r !== 'object' || !Array.isArray(r.calls)) throw new Error('log read did not return the call log');
      return r.calls as readonly CallRecord[];
    },
  };
}

export type LocalEpisodeOptions = {
  readonly worldDir: string;
  readonly taskId: string;
  /** Where the frozen world, the episode log, the private evidence and the export go. */
  readonly out: string;
  readonly runId: string;
  readonly engineCommit: string;
  /** The model `nextTurn` calls, recorded on the episode, or null when it calls none, as the noop agent does. */
  readonly model: string | null;
  readonly nextTurn: NextTurn;
  readonly maxTurns: number;
  readonly budgetUsd: number;
  readonly maxMinutes: number;
  readonly redact: Redactor;
  readonly now?: () => number;
  readonly interrupt?: AbortSignal | undefined;
  /** Starts the serve child. Default nodeSpawn. */
  readonly spawner?: Spawner;
  /** Runs the prepare and verifier children. Default nodeRunner. */
  readonly runner?: Runner;
  /** The source the children's allowlisted environment is built from. Default process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type LocalEpisodeResult = {
  readonly episode: Episode;
  /** The export reopened and validated: the episode it holds matches the one just run, field for field. */
  readonly export: ExportResult;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The serve child's ports once it reports both listening, or an error with its last output when it exits first or 120 s pass. */
async function untilServing(child: SpawnedChild): Promise<{ readonly world: number; readonly admin: number }> {
  const tail = (): string => child.output().trim().split('\n').slice(-5).join('\n');
  let gone = false;
  void child.exited.then(() => (gone = true));
  const deadline = Date.now() + 120_000;
  while (!gone && Date.now() < deadline) {
    const ports = listeningPorts(child.output());
    if (ports !== null) return ports;
    await sleep(100);
  }
  throw new Error(`the world did not start serving (${gone ? 'the serve process exited' : 'timed out'}):\n${tail()}`);
}

/**
 * Runs one episode of `taskId` and exports it. A run id already used in `out` is refused, so a
 * second episode never mixes into another's export. The served world always stops.
 */
export async function runLocalEpisode(o: LocalEpisodeOptions): Promise<LocalEpisodeResult> {
  const now = o.now ?? Date.now;
  const runner = o.runner ?? nodeRunner;
  const src = o.env ?? process.env;
  const prep = await prepareInChild(o.worldDir, o.out, runner, src);
  const task = prep.tasks.find((t) => t.id === o.taskId);
  if (task === undefined) throw new Error(`task ${o.taskId} is not a proven task of ${prep.worldId}: ${prep.tasks.map((t) => t.id).join(', ')}`);
  if (!(await startRunLog(o.out, o.runId))) throw new Error(`run id ${o.runId} is already used in ${o.out}`);
  const child = (o.spawner ?? nodeSpawn)(['bun', 'src/cli/worldplay.ts', 'serve', prep.frozenDir, '--port', '0'], { cwd: CODE_DIR, env: isolatedEnv(src) });
  try {
    const ports = await untilServing(child);
    const grade = childGrader({ codeDir: CODE_DIR, out: o.out, runner, launcher: ['bun'], env: src })({
      wid: prep.wid, worldVersion: prep.worldVersion, frozenDir: prep.frozenDir, engine: o.engineCommit,
    });
    const server = { url: `http://127.0.0.1:${ports.world}`, adminUrl: `http://127.0.0.1:${ports.admin}` };
    const { episode, artifacts } = await runEpisode({
      runId: o.runId, engineCommit: o.engineCommit, worldId: prep.worldId, worldVersion: prep.worldVersion, promptVersion: PROMPT_VERSION,
      configVersion: configVersion({ maxTurns: o.maxTurns, budgetUsd: o.budgetUsd, maxMinutes: o.maxMinutes }), model: o.model,
      task, index: 1, openapi: prep.openapi, seedHash: prep.seedHash, port: loopbackPort(server), grade, nextTurn: o.nextTurn,
      maxTurns: o.maxTurns, budgetLeftUsd: o.budgetUsd, deadline: now() + o.maxMinutes * 60_000, now, redact: o.redact, interrupt: o.interrupt,
    });
    await writeArtifacts(o.out, episode.episode_id, artifacts, o.redact);
    await appendEpisode(o.out, episode, o.redact);
    const exported = await exportDataset({ out: o.out, redact: o.redact, runIds: [o.runId] });
    const reopened = [...exported.accepted, ...exported.failed].find((e) => e.episode_id === episode.episode_id);
    // The export is canonical JSON parsed back in schema key order, so only canonical forms compare.
    if (reopened === undefined || canonicalJson(reopened) !== canonicalJson(episode)) {
      throw new Error(`the export of ${o.out} does not reopen to episode ${episode.episode_id} as it was run`);
    }
    return { episode, export: exported };
  } finally {
    child.kill('SIGTERM');
    // A pending timer would hold the episode CLI open after the child is gone, so it is cleared.
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await child.exited;
    clearTimeout(force);
  }
}

/** A turn that finishes at once with no request: a real, engine-graded episode that costs nothing and changes nothing. */
export const finishAtOnce: NextTurn = async () => ({
  decision: { action: 'finish', final_reply: 'No action taken.' },
  commentary: '',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  costUsd: 0,
  ms: 0,
});
