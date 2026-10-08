/**
 * The studio's Agent Playground (YOS-190), end to end with real children: the episode CLI runs a
 * real agent episode against the engine-served world and the engine grades it, and the proof is
 * the engine's own `worldplay verify`. Only the noop agent runs here, so no test makes a model call.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadWorld } from '#engine';
import { nodeRunner, nodeSpawn, type Runner } from '../src/sandboxes/backend.ts';
import { RUN_STORE_FILE } from '../src/studio/runstore.ts';
import { AUDIT_FILE, studioServer, type StudioServer } from '../src/studio/server.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const WORLDS_DIR = path.resolve(CODE_DIR, '../prod/worlds');

/**
 * A worlds dir of its own under `repo`, holding a copy of helpdesk. The studio keeps its run store and audit log in its
 * worlds dir, so a shared prod/worlds carried one run's jobs into the next, and an identical request replayed onto a
 * stale one (YOS-233).
 */
async function worldsIn(repo: string): Promise<string> {
  const worlds = path.join(repo, 'worlds');
  await cp(path.join(WORLDS_DIR, 'helpdesk'), path.join(worlds, 'helpdesk'), { recursive: true });
  return worlds;
}

/** Size and mtime of the studio's own files under the real prod/worlds, or null where one is absent. */
const PROD_STUDIO_FILES = [RUN_STORE_FILE, AUDIT_FILE].map((f) => path.join(WORLDS_DIR, f));
const stampProd = (): Promise<(string | null)[]> =>
  Promise.all(PROD_STUDIO_FILES.map((f) => stat(f).then((s) => `${s.size}:${s.mtimeMs}`, () => null)));
let prodBefore: (string | null)[];
before(async () => { prodBefore = await stampProd(); });
after(async () => { assert.deepEqual(await stampProd(), prodBefore, 'a studio test wrote its run store or audit log under prod/worlds'); });

type Json = Record<string, unknown>;
async function json(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${p}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

describe('studio agent playground (YOS-190)', () => {
  let repo: string;
  let studio: StudioServer;
  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'wg-playground-'));
    await symlink(CODE_DIR, path.join(repo, 'code'));
    studio = await studioServer({ port: 0, repoRoot: repo, worldsDir: await worldsIn(repo), spawner: nodeSpawn, runner: nodeRunner });
  });
  after(async () => {
    await studio.close();
    await rm(repo, { recursive: true, force: true });
  });

  it('lists a world\'s tasks with the public fields only, never grader, solution or decoy source', async () => {
    const r = await json(studio.url, 'GET', '/api/worlds/helpdesk/tasks');
    assert.equal(r.status, 200);
    const tasks = r.body['tasks'] as Json[];
    assert.deepEqual(tasks.map((t) => [t['id'], t['difficulty']]), [
      ['assign_newest_acme_ticket', 'easy'], ['escalate_breached_printer_ticket', 'medium'], ['escalate_breached_enterprise_tickets', 'hard'],
    ]);
    assert.deepEqual(Object.keys(tasks[0]!).sort(), ['difficulty', 'id', 'instruction']);
    const loaded = await loadWorld(path.join(WORLDS_DIR, 'helpdesk'));
    assert.ok(loaded.ok);
    const text = JSON.stringify(r.body);
    for (const task of Object.values((loaded.value as { tasks: Record<string, { grader: string; solution: string }> }).tasks)) {
      assert.equal(text.includes(task.grader.slice(0, 80)), false, 'a grader source reached the tasks route');
      assert.equal(text.includes(task.solution.slice(0, 80)), false, 'a solution source reached the tasks route');
    }
  });

  it('proves every helpdesk task through the engine: reference 1, doing nothing 0, every wrong attempt below 1', async () => {
    const r = await json(studio.url, 'POST', '/api/worlds/helpdesk/proof');
    assert.equal(r.status, 200);
    assert.equal(r.body['verified'], true);
    const rows = r.body['tasks'] as { task: string; proof: { reference: { score: number }; noop: { score: number }; decoys: number[]; near_miss: { score: number } } }[];
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.proof.reference.score, 1, row.task);
      assert.equal(row.proof.noop.score, 0, row.task);
      assert.equal(row.proof.decoys.every((d) => d < 1), true, row.task);
      assert.equal(row.proof.near_miss.score < 1, true, row.task);
    }
  });

  it('runs a noop agent episode as a child and serves its engine-graded, reopened export', async () => {
    const start = await json(studio.url, 'POST', '/api/episodes', { world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'noop', budgetUsd: 0.01, maxTurns: 3 });
    assert.equal(start.status, 200);
    const runId = start.body['runId'] as string;
    let status: Json = {};
    for (let i = 0; i < 240; i++) {
      status = (await json(studio.url, 'GET', `/api/episodes/${encodeURIComponent(runId)}`)).body;
      if (status['running'] === false) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(status['exitCode'], 0, JSON.stringify(status['failure'] ?? null));
    const e = status['episode'] as Json;
    assert.deepEqual([e['run_id'], e['world_id'], e['task_id'], e['stop_reason'], e['score'], e['score_scope']],
      [runId, 'helpdesk', 'assign_newest_acme_ticket', 'done', 0, 'engine_state_only']);
    assert.equal(e['initial_state_hash'], e['final_state_hash']);
    assert.equal(e['model'], null, 'the noop agent called no model');
    const list = (await json(studio.url, 'GET', '/api/episodes')).body['episodes'] as Json[];
    assert.deepEqual(list.filter((x) => x['runId'] === runId).map((x) => [x['stop'], x['score']]), [['done', 0]]);
    const analytics = (await json(studio.url, 'GET', '/api/episodes/analytics')).body;
    const groups = analytics['groups'] as Json[];
    assert.deepEqual(groups.filter((g) => g['task'] === 'assign_newest_acme_ticket').map((g) => [g['world'], g['model'], g['successes'], g['failures']]), [['helpdesk', 'noop (no model)', 0, { 'scored 0': 1 }]]);
    assert.deepEqual(analytics['unreadable'], []);
  });

  it('refuses an unknown agent and an unsafe world name before spawning anything', async () => {
    assert.equal((await json(studio.url, 'POST', '/api/episodes', { world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'gpt' })).status, 400);
    assert.equal((await json(studio.url, 'POST', '/api/episodes', { world: '..', task: 'x', agent: 'noop' })).status, 400);
    assert.equal((await json(studio.url, 'GET', '/api/worlds/nope/tasks')).status, 404);
  });
});

describe('studio agent playground with no git, as in the container image (YOS-236)', () => {
  const BUILD = '0123456789abcdef0123456789abcdef01234567';
  /** The image has no git binary, so the runner rejects as nodeRunner does for a missing binary. Every other command runs for real. */
  const noGit: Runner = (argv, o) => (argv[0] === 'git' ? Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })) : nodeRunner(argv, o));
  let repo: string;
  let worlds: string;
  const studios: StudioServer[] = [];
  const start = async (build?: string): Promise<StudioServer> => {
    const s = await studioServer({ port: 0, repoRoot: repo, worldsDir: worlds, spawner: nodeSpawn, runner: noGit, ...(build === undefined ? {} : { build }) });
    studios.push(s);
    return s;
  };
  before(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'wg-playground-nogit-'));
    await symlink(CODE_DIR, path.join(repo, 'code'));
    worlds = await worldsIn(repo);
  });
  after(async () => {
    for (const s of studios) await s.close();
    await rm(repo, { recursive: true, force: true });
  });

  it('records the build sha as the episode engine when git cannot name the commit', async () => {
    const studio = await start(BUILD);
    const begun = await json(studio.url, 'POST', '/api/episodes', { world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'noop', budgetUsd: 0.01, maxTurns: 3 });
    assert.equal(begun.status, 200, JSON.stringify(begun.body));
    const runId = begun.body['runId'] as string;
    let status: Json = {};
    for (let i = 0; i < 240; i++) {
      status = (await json(studio.url, 'GET', `/api/episodes/${encodeURIComponent(runId)}`)).body;
      if (status['running'] === false) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(status['exitCode'], 0, JSON.stringify(status['failure'] ?? null));
    assert.equal((status['episode'] as Json)['engine_commit'], BUILD);
  });

  it('also falls back when git runs but finds no repository', async () => {
    const outside: Runner = (argv, o) => (argv[0] === 'git' ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }) : nodeRunner(argv, o));
    const studio = await studioServer({ port: 0, repoRoot: repo, worldsDir: worlds, spawner: nodeSpawn, runner: outside, build: BUILD });
    studios.push(studio);
    const r = await json(studio.url, 'POST', '/api/episodes', { world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'noop', budgetUsd: 0.01, maxTurns: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('refuses with episode.commit when there is neither a git commit nor a build sha', async () => {
    const studio = await start();
    const r = await json(studio.url, 'POST', '/api/episodes', { world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'noop', budgetUsd: 0.01, maxTurns: 3 });
    assert.deepEqual([r.status, (r.body['error'] as Json)['code']], [500, 'episode.commit']);
  });
});

