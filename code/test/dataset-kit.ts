/**
 * Shared pieces for the dataset tests (not a test file): the checked golden helpdesk, a real
 * local HTTP world behind a WorldPort, a fake Boat-style SandboxBackend that runs the controller's
 * scripts against a real served world, scripted solvers, and a valid Episode builder.
 */
import crypto from 'node:crypto';
import fs, { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { checkWorld, createRuntime, loadWorld, serve, type CallRecord, type CheckedWorld, type WorldServer } from '#engine';
import type { EpisodeInput, NextTurn, TurnResult, WorldPort } from '../src/dataset/episode.ts';
import { prepareWorld, stateFromAdmin, type PreparedWorld } from '../src/dataset/pipeline.ts';
import { engineGrader } from '../src/dataset/verifier.ts';
import { PROMPT_VERSION, SCHEMA_VERSION, redactor, type Episode, type PublicMessage } from '../src/dataset/schema.ts';
import { WAIT_FOR_PORT, type ExecOpts, type ExecResult, type SandboxBackend, type SandboxFile } from '../src/sandboxes/backend.ts';

export const HELPDESK_DIR = path.resolve(import.meta.dirname, '../../prod/worlds/helpdesk');
export const EASY = 'assign_newest_acme_ticket';
export const COMMIT = 'a0ca1351234567';
/** A test that runs the dataset CLI or pipeline takes seconds on a loaded machine: give it the budget `bun run test` gives, not bare `bun test`'s 5 s default. */
export const RUN_BUDGET = { timeout: 120_000 };
export const tmp = (name: string): string => mkdtempSync(path.join(tmpdir(), `dataset-${name}-`));

let cached: CheckedWorld | undefined;
/** The golden helpdesk, checked once. */
export async function helpdesk(): Promise<CheckedWorld> {
  if (cached !== undefined) return cached;
  const loaded = await loadWorld(HELPDESK_DIR);
  if (!loaded.ok) throw new Error('helpdesk does not load');
  const report = checkWorld(loaded.value);
  if (!report.ok) throw new Error(`helpdesk does not check: ${report.issues[0].code}`);
  cached = report.world;
  return cached;
}

let preparedCache: { out: string; prep: PreparedWorld } | undefined;
/** The helpdesk checked, frozen and hashed under one shared temp directory. */
export async function preparedHelpdesk(): Promise<{ out: string; prep: PreparedWorld }> {
  if (preparedCache !== undefined) return preparedCache;
  const out = tmp('prep');
  preparedCache = { out, prep: await prepareWorld(HELPDESK_DIR, out) };
  return preparedCache;
}

// ---------------------------------------------------------------------------------------------
// A real local world

export type LocalWorld = { readonly port: WorldPort; readonly server: WorldServer; readonly url: string; close(): Promise<void> };

/**
 * One request on its own connection. The world is served in this process, so a test that blocks the event loop for
 * longer than the server's keep-alive timeout (a full check on a slow runner) would have the server close a pooled
 * socket just as fetch reused it: ECONNRESET on the next reset (promotion 9, J87).
 */
function httpOnce(url: string, method: string, body?: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method, agent: false, ...(signal === undefined ? {} : { signal }),
      headers: { connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The helpdesk served on free ports, with a WorldPort that speaks HTTP to both ports directly, one connection per request. */
export async function localWorld(world: CheckedWorld, ports?: { port: number; adminPort: number }): Promise<LocalWorld> {
  const server = await serve(world, ports ?? { port: 0 });
  const admin = async (method: string, route: string): Promise<{ status: number; body: unknown }> => {
    const res = await httpOnce(`${server.adminUrl}${route}`, method);
    return { status: res.status, body: JSON.parse(res.text) };
  };
  const port: WorldPort = {
    async call(req, signal) {
      return httpOnce(`${server.url}${req.target}`, req.method, req.bodyText, signal);
    },
    async reset() {
      const r = await admin('POST', '/_world/reset');
      if (r.status !== 200) throw new Error(`reset answered ${r.status}`);
    },
    async state() {
      return stateFromAdmin((await admin('GET', '/_world/state')).body);
    },
    log: async () => ((await admin('GET', '/_world/log')).body as { calls: readonly CallRecord[] }).calls,
  };
  return { port, server, url: server.url, close: () => server.close() };
}

// ---------------------------------------------------------------------------------------------
// Scripted solvers

export const COST = 0.003;
export const turn = (decision: unknown, commentary = '', costUsd = COST): TurnResult => ({
  decision, commentary, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd, ms: 5,
});
const request = (method: string, path: string, query: Record<string, string> = {}, body?: unknown) => ({
  action: 'request', method, path, query, ...(body === undefined ? {} : { body }),
});

/** The body of the tool result for call `id`. */
export function resultOf(messages: readonly PublicMessage[], id: string): { status: number | null; body: any } {
  const m = messages.find((x) => x.type === 'tool_result' && x.call_id === id);
  if (m?.type !== 'tool_result') throw new Error(`no result for ${id}`);
  return { status: m.status, body: m.body };
}

export const EASY_TICKET = 'tkt_0004';
export const PRIYA = 'agt_0001';
export const EASY_REPLY = `Assigned ticket ${EASY_TICKET} to Priya Raman (${PRIYA}).`;

/** Solves the easy task through the public API, reading ids from its own history. Five turns. */
export const easySolver: NextTurn = async (view) => {
  const calls = view.messages.filter((m) => m.type === 'tool_call').length;
  switch (calls) {
    case 0:
      return turn(request('GET', '/customers', { q: 'Acme' }), 'Looking up the customer.');
    case 1: {
      const acme = resultOf(view.messages, 'c1').body.data.find((c: { name: string }) => c.name === 'Acme Logistics');
      return turn(request('GET', '/tickets', { customer_id: acme.id, status: 'new', sort: '-created_at', limit: '1' }));
    }
    case 2:
      return turn(request('GET', '/agents', { q: 'Priya Raman' }));
    case 3: {
      const ticket = resultOf(view.messages, 'c2').body.data[0];
      const priya = resultOf(view.messages, 'c3').body.data.find((a: { name: string }) => a.name === 'Priya Raman');
      return turn(request('POST', `/tickets/${ticket.id}/assign`, {}, { agent_id: priya.id }));
    }
    default: {
      const ticket = resultOf(view.messages, 'c2').body.data[0];
      const priya = resultOf(view.messages, 'c3').body.data.find((a: { name: string }) => a.name === 'Priya Raman');
      return turn({ action: 'finish', final_reply: `Assigned ticket ${ticket.id} to Priya Raman (${priya.id}).` });
    }
  }
};

const REASON = 'SLA breached on a high-priority enterprise ticket';
type Result = { status: number | null; body: any };
const resultsOf = (messages: readonly PublicMessage[]): Result[] =>
  messages.flatMap((m) => (m.type === 'tool_result' ? [{ status: m.status, body: m.body }] : []));

/** Solves the medium task: escalate Acme Logistics' breached label printer ticket. */
export const mediumSolver: NextTurn = async (view) => {
  const r = resultsOf(view.messages);
  if (r.length === 0) return turn(request('GET', '/customers', { q: 'Acme' }));
  const acme = r[0]?.body.data.find((c: { name: string }) => c.name === 'Acme Logistics');
  if (r.length === 1) return turn(request('GET', '/tickets', { customer_id: acme.id, q: 'label printer' }));
  const hit = r[1]?.body.data.filter((t: { sla_breached: boolean }) => t.sla_breached)[0];
  if (r.length === 2) return turn(request('POST', `/tickets/${hit.id}/escalate`, {}, { reason: REASON }));
  return turn({ action: 'finish', final_reply: `Escalated ${hit.id} with the reason "${REASON}".` });
};

/** Reads consecutive pages of one list from `results[from..]`: its rows, where it ends, and the cursor still to fetch. */
function pages(results: readonly Result[], from: number): { rows: any[]; next: number; cursor: string | null; done: boolean } {
  const rows: any[] = [];
  for (let i = from; ; i++) {
    const r = results[i];
    if (r === undefined) return { rows, next: i, cursor: i === from ? null : (results[i - 1]?.body.next_cursor as string), done: false };
    rows.push(...r.body.data);
    if (r.body.next_cursor === null) return { rows, next: i + 1, cursor: null, done: true };
  }
}

/** Solves the hard task: escalate every open, high-priority, breached ticket of an enterprise customer, across pages. */
export const hardSolver: NextTurn = async (view) => {
  const r = resultsOf(view.messages);
  const customers = pages(r, 0);
  if (!customers.done) return turn(request('GET', '/customers', { tier: 'enterprise', ...(customers.cursor === null ? {} : { cursor: customers.cursor }) }));
  const enterprise = new Set(customers.rows.map((c) => c.id));
  const tickets = pages(r, customers.next);
  if (!tickets.done) {
    return turn(request('GET', '/tickets', { status: 'open', priority: 'high', sla_breached: 'true', ...(tickets.cursor === null ? {} : { cursor: tickets.cursor }) }));
  }
  const targets = tickets.rows.filter((t) => enterprise.has(t.customer_id));
  const done = r.length - tickets.next;
  const target = targets[done];
  if (target !== undefined) return turn(request('POST', `/tickets/${target.id}/escalate`, {}, { reason: REASON }));
  return turn({ action: 'finish', final_reply: `Escalated ${targets.length} tickets: ${targets.map((t) => t.id).join(', ')}.` });
};

/** The right solver for each helpdesk task, picked by its instruction. */
export const solveAll: NextTurn = (view, signal) =>
  (view.instruction.startsWith('Assign the most recently') ? easySolver : view.instruction.startsWith('Acme Logistics says') ? mediumSolver : hardSolver)(view, signal);

/** Solves the easy task and claims success on every other. */
export const easyOnly: NextTurn = (view, signal) => (view.instruction.startsWith('Assign the most recently') ? easySolver : lazySolver)(view, signal);

/** Claims success without doing anything. */
export const lazySolver: NextTurn = async () => turn({ action: 'finish', final_reply: 'All done, the ticket is assigned.' });

/** A scripted sequence of decisions, one per turn. Past the end it finishes with `Done.` */
export const scripted = (decisions: readonly unknown[]): NextTurn => async (view) => turn(decisions[view.turn - 1] ?? { action: 'finish', final_reply: 'Done.' });

// ---------------------------------------------------------------------------------------------
// A fake Boat sandbox

export type FakeBackendOptions = {
  readonly port: number;
  readonly failUp?: boolean;
  /** What the sandbox's serve log holds. */
  readonly serveLog?: string;
  readonly failDown?: boolean;
  /** Return an exit code to make that exec fail. */
  readonly failExec?: (cmd: readonly string[]) => number | undefined;
};
export type FakeBackend = SandboxBackend & {
  readonly events: string[];
  readonly uploaded: SandboxFile[];
  readonly execs: (readonly string[])[];
  readonly exposed: number[];
  readonly stopped: () => boolean;
};

class ScriptExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Runs one of the controller's `node -e` scripts the way node does (argv from index 1, `require`,
 * `fetch`, stdout and stderr, `process.exit`), inside a vm context in this process, so the real
 * script text runs without spawning a node per call.
 */
async function runScript(script: string, args: readonly string[]): Promise<ExecResult> {
  let stdout = '';
  let stderr = '';
  const modules: Record<string, unknown> = { fs, 'node:fs': fs, crypto, 'node:crypto': crypto };
  const context = vm.createContext({
    require: (name: string) => {
      if (!Object.hasOwn(modules, name)) throw new Error(`Cannot find module '${name}'`);
      return modules[name];
    },
    process: { argv: ['node', ...args], stdout: { write: (t: string) => void (stdout += t) }, stderr: { write: (t: string) => void (stderr += t) }, exit: (c = 0) => { throw new ScriptExit(c); } },
    fetch, Buffer, JSON, Number, String, Math, Promise,
  });
  try {
    await (vm.runInContext(script, context) as unknown);
    return { exitCode: 0, stdout, stderr };
  } catch (e) {
    if (e instanceof ScriptExit) return { exitCode: e.code, stdout, stderr };
    return { exitCode: 1, stdout, stderr: `${stderr}${e instanceof Error ? e.message : String(e)}\n` };
  }
}

/** Free port pair for a fake sandbox: `port` and `port + 1`. Retries on collision inside `localWorld`. */
export const randomPort = (): number => 20000 + Math.floor(Math.random() * 30000);

/**
 * Behaves like the Boat backend `upWorld` drives: `start` serves the world on the requested
 * ports, `expose` returns the world URL only, `exec` runs the controller's `node -e` scripts with
 * a real node (their `/tmp/` paths mapped into a private directory), and `down` stops the servers.
 */
export function fakeBackend(world: CheckedWorld, o: FakeBackendOptions): FakeBackend {
  const events: string[] = [];
  const uploaded: SandboxFile[] = [];
  const execs: (readonly string[])[] = [];
  const exposed: number[] = [];
  const dir = tmp('sbx');
  let local: LocalWorld | undefined;
  let stopped = false;
  const map = (a: string): string => (a.startsWith('/tmp/') ? path.join(dir, a.slice('/tmp/'.length)) : a);
  const ID = 'fake-sandbox-1';
  return {
    kind: 'boat',
    events, uploaded, execs, exposed,
    stopped: () => stopped,
    async up(files) {
      events.push('up');
      if (o.failUp) throw new Error('boat create failed');
      uploaded.push(...files);
      return { id: ID, workdir: '/tmp/worldgen' };
    },
    async exec(_id, cmd, _opts?: ExecOpts) {
      execs.push(cmd);
      events.push(`exec ${cmd[0]}${cmd[1] === '-e' ? ` -e ${cmd[2] === WAIT_FOR_PORT ? 'wait' : cmd[2]?.slice(0, 20)}` : ''}`);
      const forced = o.failExec?.(cmd);
      if (forced !== undefined) return { exitCode: forced, stdout: '', stderr: 'injected failure' };
      if (cmd[0] === 'node' && cmd[1] === '-v') return { exitCode: 0, stdout: 'v22.4.0\n', stderr: '' };
      if (cmd.join(' ').includes('bun-linux-')) return { exitCode: 0, stdout: '1.4.2\n', stderr: '' };
      if (cmd[0] === 'npm' || cmd[0]?.endsWith('/bun')) return { exitCode: 0, stdout: '', stderr: '' };
      if (cmd[0] === 'tail') return { exitCode: 0, stdout: 'serving\n', stderr: '' };
      if (cmd[0] === 'node' && cmd[1] === '-e') {
        if (cmd[2] === WAIT_FOR_PORT) return { exitCode: 0, stdout: '', stderr: '' };
        return runScript(cmd[2] ?? '', cmd.slice(3).map(map));
      }
      return { exitCode: 127, stdout: '', stderr: `unexpected command ${cmd.join(' ')}` };
    },
    async start(_id, cmd, opts) {
      events.push('start');
      const port = Number(cmd[cmd.indexOf('--port') + 1]);
      local = await localWorld(world, { port, adminPort: port + 1 });
      writeFileSync(map(opts.log), o.serveLog ?? `listening on ${port}\n`);
    },
    async expose(_id, port) {
      events.push('expose');
      exposed.push(port);
      if (local === undefined) throw new Error('nothing is listening');
      return local.url;
    },
    async down() {
      events.push('down');
      await local?.close();
      if (o.failDown) throw new Error('boat stop never confirmed');
      stopped = true;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Episode builders

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

/** A valid, complete successful Episode for the helpdesk, with every field overridable. */
export function episode(over: Partial<Episode> = {}): Episode {
  const base: Episode = {
    schema_version: SCHEMA_VERSION,
    episode_id: `run1__${EASY}__1`,
    run_id: 'run1',
    world_id: 'helpdesk',
    world_version: SHA_A,
    engine_commit: COMMIT,
    task_id: EASY,
    difficulty: 'easy',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    prompt_version: PROMPT_VERSION,
    config_version: 'cfg-000000000000',
    initial_state_hash: SHA_A,
    final_state_hash: SHA_B,
    messages: [
      { seq: 0, role: 'user', type: 'instruction', text: 'Assign the newest ticket.' },
      { seq: 1, role: 'assistant', type: 'tool_call', call_id: 'c1', request: { method: 'GET', path: '/customers', query: { q: 'Acme' } }, commentary: '' },
      { seq: 2, role: 'tool', type: 'tool_result', call_id: 'c1', outcome: 'response', status: 200, body: { data: [] }, truncated: false, detail: null },
      { seq: 3, role: 'assistant', type: 'final_reply', text: 'Done.', commentary: '' },
    ],
    final_reply: 'Done.',
    score: 1,
    score_scope: 'engine_state_only',
    stop_reason: 'done',
    error: null,
    usage: { model_calls: 2, unaccounted_calls: 0, input_tokens: 2000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.006, duration_ms: 10 },
  };
  return { ...base, ...over };
}

export const noSecrets = redactor([]);

/** Defaults for runEpisode over `localWorld` and the prepared helpdesk. */
export async function episodeInput(port: WorldPort, nextTurn: NextTurn, over: Partial<EpisodeInput> = {}): Promise<EpisodeInput> {
  const { prep } = await preparedHelpdesk();
  const task = prep.tasks.find((t) => t.id === EASY);
  if (task === undefined) throw new Error('no easy task');
  return {
    runId: 'run1', engineCommit: COMMIT, worldId: prep.worldId, worldVersion: prep.worldVersion, promptVersion: PROMPT_VERSION, configVersion: 'cfg-000000000000', model: 'claude-sonnet-5-5',
    task, index: 1, openapi: prep.openapi, seedHash: prep.seedHash, port,
    grade: engineGrader({ wid: prep.wid, worldVersion: prep.worldVersion, frozenDir: prep.frozenDir, engine: COMMIT }),
    nextTurn, maxTurns: 10, budgetLeftUsd: 1, deadline: Date.now() + 60_000, now: Date.now, redact: noSecrets, ...over,
  };
}

export { createRuntime };
