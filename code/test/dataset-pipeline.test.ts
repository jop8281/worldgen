import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PreflightError, checkForRun, prepareWorld, runPipeline, type PipelineDeps, type PipelineOptions } from '../src/dataset/pipeline.ts';
import { CHUNK_SCRIPT, stateFromAdmin } from '../src/dataset/pipeline.ts';
import { episodeSchema, hashState, sha256Hex } from '../src/dataset/schema.ts';
import { nodeRunner, type Runner } from '../src/sandboxes/backend.ts';
import { engineGrader } from '../src/dataset/verifier.ts';
import { collectBundle } from '../src/sandboxes/files.ts';
import { turn, COMMIT, HELPDESK_DIR, easyOnly, fakeBackend, helpdesk, lazySolver, randomPort, RUN_BUDGET, solveAll, tmp, type FakeBackendOptions } from './dataset-kit.ts';
import type { NextTurn } from '../src/dataset/episode.ts';
import { checkWorld, dumpSha256, type StateDump } from '#engine';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const ANTHROPIC = 'sk-ant-api03-ANTHROPIC-SECRET-VALUE';
const BOAT = 'boat_live_BOAT-SECRET-VALUE-0001';

type Setup = {
  solver?: NextTurn;
  backend?: Partial<FakeBackendOptions>;
  opts?: Partial<PipelineOptions>;
  deps?: Partial<PipelineDeps>;
  out?: string;
};

/** A tiny bundle: only the public form of the world. The real collectBundle is exercised by one test below. */
const tinyBundle: PipelineDeps['makeBundle'] = async (dir) => ({ files: [{ path: 'worlds/w/world.yaml', data: readFileSync(path.join(dir, 'public', 'world.yaml')) }], world: 'worlds/w' });

async function run(s: Setup = {}) {
  const world = await helpdesk();
  const port = randomPort();
  const backend = fakeBackend(world, { port, ...s.backend });
  const out = s.out ?? tmp('run');
  const logs: string[] = [];
  const result = await runPipeline(
    {
      worldDir: HELPDESK_DIR, out, runId: 'run-1', engineCommit: COMMIT, model: 'claude-sonnet-5-5', maxTurns: 60, budgetUsd: 5, maxMinutes: 5,
      secrets: [ANTHROPIC, BOAT], sandboxName: 'ds-run-1-abc123', port, ...s.opts,
    },
    { backend, nextTurn: s.solver ?? solveAll, makeBundle: tinyBundle, grader: engineGrader, log: (l) => logs.push(l), ...s.deps },
  );
  return { result, backend, out, logs, port };
}
const lines = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
const everyFile = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));

describe('a full run against the golden helpdesk through a fake Boat sandbox', () => {
  it('refuses an inaccessible public API before any solver call and stops the sandbox', RUN_BUDGET, async () => {
    let clock = 0;
    let modelCalls = 0;
    const requested: string[] = [];
    const fetchFailure: typeof globalThis.fetch = async (url) => {
      requested.push(String(url));
      clock += 61_000;
      return new Response('not authorized', { status: 401 });
    };
    const { result, backend } = await run({
      solver: async (view, signal) => { modelCalls += 1; return lazySolver(view, signal); },
      deps: { fetch: fetchFailure, now: () => clock },
    });
    assert.equal(modelCalls, 0);
    assert.equal(result.status, 'failed');
    assert.equal(result.episodes.length, 0);
    assert.equal(result.modelCostUsd, 0);
    assert.equal(requested.length, 1);
    assert.equal(new URL(requested[0] ?? '').pathname, '/openapi.json');
    assert.equal(result.problems.some((p) => p.includes('HTTP 401')), true);
    assert.equal(backend.stopped(), true);
    assert.equal(backend.events.at(-1), 'down');
  });

  it('solves all three proven tasks, exports and reopens the JSONL, then stops the sandbox', RUN_BUDGET, async () => {
    const { result, backend, out, logs, port } = await run();
    assert.deepEqual(result.problems, []);
    assert.equal(result.status, 'accepted');
    assert.deepEqual([result.accepted, result.failed, result.episodes.length], [3, 0, 3]);
    assert.deepEqual(result.episodes.map((e) => [e.task_id, e.difficulty, e.score, e.stop_reason]), [
      ['assign_newest_acme_ticket', 'easy', 1, 'done'],
      ['escalate_breached_printer_ticket', 'medium', 1, 'done'],
      ['escalate_breached_enterprise_tickets', 'hard', 1, 'done'],
    ]);
    assert.deepEqual(result.sandbox, { id: 'fake-sandbox-1', teardown: 'confirmed' });
    assert.equal(result.manifest?.counts.accepted, 3);

    // The export on disk is exactly what was accepted.
    const rows = lines(path.join(out, 'dataset.jsonl')).map((l) => episodeSchema.parse(JSON.parse(l)));
    assert.deepEqual(rows.map((r) => r.task_id), ['assign_newest_acme_ticket', 'escalate_breached_enterprise_tickets', 'escalate_breached_printer_ticket']);
    assert.equal(readFileSync(path.join(out, 'failures.jsonl'), 'utf8'), '');
    const replies = Object.fromEntries(rows.map((r) => [r.task_id, r.final_reply]));
    assert.equal(replies['assign_newest_acme_ticket'], 'Assigned ticket tkt_0004 to Priya Raman (agt_0001).');
    assert.equal(rows.every((r) => r.initial_state_hash === rows[0]?.initial_state_hash && r.final_state_hash !== r.initial_state_hash), true);

    // Order: collection and export happen before the stop, and the stop is last.
    const exportedAt = logs.findIndex((l) => l.startsWith('exported '));
    const stoppedAt = logs.findIndex((l) => l.startsWith('sandbox fake-sandbox-1 stopped'));
    assert.equal(exportedAt >= 0 && stoppedAt > exportedAt, true, logs.join('\n'));
    assert.equal(backend.events.at(-1), 'down');
    assert.equal(backend.events.filter((e) => e === 'down').length, 1);
    assert.equal(backend.stopped(), true);
    // Only the world port was exposed; the admin port never was.
    assert.deepEqual(backend.exposed, [port]);

    // Evidence kept apart from the public files.
    const diag = path.join(out, 'private', 'diagnostics', 'run-1');
    assert.equal(readFileSync(path.join(diag, 'worldplay.log'), 'utf8'), `listening on ${port}\n`);
    assert.equal(typeof JSON.parse(readFileSync(path.join(diag, 'final-state.json'), 'utf8')).now, 'string');
    assert.equal(Array.isArray(JSON.parse(readFileSync(path.join(diag, 'final-log.json'), 'utf8')).calls), true);
    assert.equal(JSON.parse(readFileSync(path.join(diag, 'summary.json'), 'utf8')).status, 'accepted');
    for (const e of result.episodes) {
      const dir = path.join(out, 'private', 'episodes', e.episode_id);
      assert.equal(hashState(JSON.parse(readFileSync(path.join(dir, 'initial.json'), 'utf8'))), e.initial_state_hash);
      assert.equal(hashState(JSON.parse(readFileSync(path.join(dir, 'final.json'), 'utf8'))), e.final_state_hash);
      assert.equal(existsSync(path.join(dir, 'calls.json')), true);
    }
    const report = readFileSync(path.join(out, 'REPORT.md'), 'utf8');
    assert.equal(report.includes('Status: **accepted**'), true);
    assert.equal(report.includes('does not independently certify that the final reply is factually correct'), true);
  });

  it('keeps hidden world assets, admin routes and URLs out of the public files, and secrets out of every file', RUN_BUDGET, async () => {
    const w = await helpdesk();
    const { result, backend, out, port } = await run({
      solver: async (v, s) => ({ ...(await solveAll(v, s)), commentary: `using ${ANTHROPIC} and ${BOAT}` }),
      backend: { serveLog: `worldplay up with ${BOAT}\n` },
    });
    assert.equal(result.status, 'accepted');
    const publicText = ['dataset.jsonl', 'failures.jsonl', 'manifest.json'].map((n) => readFileSync(path.join(out, n), 'utf8')).join('\n');
    for (const t of Object.values(w.tasks)) {
      assert.ok(t.grader !== undefined && t.solution !== undefined, 'the golden helpdesk is the private form');
      assert.equal(publicText.includes(t.grader), false);
      assert.equal(publicText.includes(t.solution), false);
      for (const d of t.decoys) assert.equal(publicText.includes(d.script), false);
    }
    for (const needle of [`127.0.0.1:${port}`, `127.0.0.1:${port + 1}`, '/_world', 'adminUrl']) assert.equal(publicText.includes(needle), false, needle);
    // No secret in any file the run wrote, public or private.
    for (const file of everyFile(out)) {
      const text = readFileSync(file, 'utf8');
      assert.equal(text.includes(ANTHROPIC) || text.includes(BOAT), false, file);
    }
    assert.equal(publicText.includes('using [redacted] and [redacted]'), true);
    assert.equal(readFileSync(path.join(out, 'private/diagnostics/run-1/worldplay.log'), 'utf8'), 'worldplay up with [redacted]\n');
    // The upload holds the frozen world only, and no secret.
    assert.equal(backend.uploaded.some((f) => f.path === 'worlds/w/world.yaml'), true);
    for (const f of backend.uploaded) assert.equal(Buffer.from(f.data).toString('utf8').includes(BOAT), false);
  });

  it('checks and prepares in children whose environment holds no controller credential', RUN_BUDGET, async () => {
    const calls: { argv: readonly string[]; env: Readonly<Record<string, string | undefined>> | undefined }[] = [];
    const runner: Runner = async (argv, opts) => {
      calls.push({ argv, env: opts?.env });
      return nodeRunner(argv, opts);
    };
    const env = { PATH: process.env.PATH ?? '', HOME: '/home/op', LLM_KEY: 'sk-live-1', BOAT_API_KEY: 'boat-3', WORLDGEN_STUDIO_TOKEN: 'tok-4' };
    const { result } = await run({ deps: { runner, env, grader: engineGrader } });
    assert.equal(result.status, 'accepted');
    const children = calls.filter((c) => c.argv.includes('src/cli/episode-prepare.ts'));
    assert.deepEqual(children.map((c) => c.argv.includes('--check')), [true, false]);
    for (const c of children) assert.deepEqual(c.env, { TZ: 'UTC', PATH: process.env.PATH ?? '' });
  });

  it('rejects known secrets in the checked source world before freezing, bundling or model calls', RUN_BUDGET, async () => {
    const secret = 'controller-secret-sentinel-834029';
    const world = await helpdesk();
    const report = checkWorld({ ...world, meta: { ...world.meta, description: secret } });
    assert.equal(report.ok, true);
    if (!report.ok) throw new Error('secret-bearing fixture did not check');
    const port = randomPort();
    const backend = fakeBackend(report.world, { port });
    const out = path.join(tmp('reject-secret'), 'out');
    let bundleCalls = 0;
    let modelCalls = 0;
    const logs: string[] = [];
    await assert.rejects(runPipeline({
      worldDir: HELPDESK_DIR, out, runId: 'reject-secret', engineCommit: COMMIT, model: 'claude-sonnet-5-5',
      maxTurns: 10, budgetUsd: 1, maxMinutes: 1, secrets: [secret], sandboxName: 'reject-secret', port,
    }, {
      grader: engineGrader,
      checked: { world: report.world, tasks: Object.entries(report.world.tasks).map(([id, t]) => ({ id, difficulty: t.difficulty, instruction: t.instruction })) },
      backend,
      makeBundle: async (dir) => { bundleCalls += 1; return tinyBundle(dir); },
      nextTurn: async (view, signal) => { modelCalls += 1; return lazySolver(view, signal); },
      log: (line) => logs.push(line),
    }), { name: 'DatasetError', message: 'the source world holds a supplied secret; refusing to keep it' });
    assert.equal(existsSync(out), false);
    assert.equal(bundleCalls, 0);
    assert.equal(modelCalls, 0);
    assert.deepEqual(backend.events, []);
    assert.deepEqual(logs, []);
    assert.equal(report.world.meta.description, secret);
  });

  it('uploads the code package and the public form of the world with the real bundle, and no credential or private file', RUN_BUDGET, async () => {
    const w = await helpdesk();
    const { backend, out, result } = await run({ deps: { makeBundle: (dir) => collectBundle(CODE_DIR, dir, { publicOnly: true }) } });
    assert.equal(result.status, 'accepted');
    const paths = backend.uploaded.map((f) => f.path);
    const worldFiles = paths.filter((p) => p.startsWith('worlds/'));
    assert.equal(worldFiles.length, 1);
    assert.match(worldFiles[0] ?? '', /^worlds\/[0-9a-f]{64}\/world\.yaml$/);
    const version = worldFiles[0]?.split('/')[1] ?? '';
    for (const required of ['package.json', 'package-lock.json', 'src/cli/worldplay.ts', 'src/engine/index.ts']) assert.equal(paths.includes(required), true, required);
    assert.equal(paths.some((p) => /(^|\/)\.env|node_modules|\.pem$|credentials|private\//.test(p)), false);
    // The uploaded world.yaml is the public form: no private task source, unlike the private
    // world it is bound to by its folder name, which stays on the trusted side.
    const uploadedWorld = Buffer.from(backend.uploaded.find((f) => f.path === worldFiles[0])?.data ?? '').toString('utf8');
    for (const t of Object.values(w.tasks)) {
      assert.ok(t.grader !== undefined && t.solution !== undefined, 'the golden helpdesk is the private form');
      assert.equal(uploadedWorld.includes(t.grader), false);
      assert.equal(uploadedWorld.includes(t.solution), false);
      for (const d of t.decoys) assert.equal(uploadedWorld.includes(d.script), false);
    }
    assert.notEqual(sha256Hex(uploadedWorld), version);
    const privateKey = path.join(out, 'private', 'worlds', version, 'world.yaml');
    assert.equal(sha256Hex(readFileSync(privateKey, 'utf8')), version);
    // saveWorld renders snippets as block scalars, so a single line of the grader is the text to find.
    const graderLine = (Object.values(w.tasks)[0]?.grader ?? '').split('\n').map((l) => l.trim()).find((l) => l.length >= 24) ?? '';
    assert.equal(graderLine !== '', true, 'fixture error: the grader has no line of at least 24 characters');
    assert.equal(readFileSync(privateKey, 'utf8').includes(graderLine), true);
    assert.equal(existsSync(path.join(out, 'private', 'worlds', version, 'public', 'world.yaml')), true);
  });

  it('exports the failures and no accepted rows when no solver succeeded', RUN_BUDGET, async () => {
    const { result, out } = await run({ solver: lazySolver });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual([result.accepted, result.failed], [0, 3]);
    assert.equal(readFileSync(path.join(out, 'dataset.jsonl'), 'utf8'), '');
    assert.equal(lines(path.join(out, 'failures.jsonl')).length, 3);
    assert.deepEqual(result.manifest?.counts, { episodes: 3, accepted: 0, failed: 3, by_stop_reason: { done: 3 } });
    assert.deepEqual(result.episodes.map((e) => e.score), [0, 0, 0]);
    assert.deepEqual(result.problems, []);
  });

  it('reports an incomplete run when only some tasks are solved, and keeps each row where it belongs', RUN_BUDGET, async () => {
    const { result, out } = await run({ solver: easyOnly });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual([result.accepted, result.failed], [1, 2]);
    assert.equal(lines(path.join(out, 'dataset.jsonl')).length, 1);
    assert.equal(lines(path.join(out, 'failures.jsonl')).length, 2);
  });

  it('shares the model budget across episodes: once it is spent no later episode starts', RUN_BUDGET, async () => {
    const solver: NextTurn = async (v, s) => ({ ...(await solveAll(v, s)), costUsd: 0.01 });
    const { result } = await run({ solver, opts: { budgetUsd: 0.05 } });
    assert.deepEqual(result.episodes.map((e) => [e.stop_reason, e.usage.cost_usd, e.initial_state_hash === null]), [
      ['done', 0.05, false],
      ['budget_limit', 0, true],
      ['budget_limit', 0, true],
    ]);
    assert.equal(result.accepted, 1);
    assert.equal(result.modelCostUsd, 0.05);
    assert.equal(result.status, 'incomplete');
  });

  it('stops every episode at the time limit, skips the remaining resets, and still stops the sandbox', RUN_BUDGET, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let clock = 0;
    let modelCalls = 0;
    const hanging: NextTurn = (_v, signal) => new Promise((_resolve, reject) => {
      assert.equal(signal.aborted, false);
      signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      modelCalls += 1;
      clock = 121;
      t.mock.timers.tick(121);
    });
    const { result, backend } = await run({
      solver: hanging,
      opts: { maxMinutes: 0.002 },
      deps: { now: () => clock, fetch: async () => new Response('{}', { status: 200 }) },
    });
    assert.equal(modelCalls, 1);
    assert.deepEqual(result.episodes.map((e) => e.stop_reason), ['time_limit', 'time_limit', 'time_limit']);
    assert.equal(result.episodes[1]?.initial_state_hash, null);
    assert.equal(result.episodes[2]?.initial_state_hash, null);
    assert.equal(result.accepted, 0);
    assert.equal(result.sandbox.teardown, 'confirmed');
    assert.equal(backend.events.at(-1), 'down');
  });

  it('makes no public request or solver call when provisioning exhausts the run deadline', RUN_BUDGET, async () => {
    let clock = 0;
    let publicCalls = 0;
    let modelCalls = 0;
    const world = await helpdesk();
    const port = randomPort();
    const backend = fakeBackend(world, { port });
    const originalUp = backend.up.bind(backend);
    backend.up = async (...args) => {
      const sandbox = await originalUp(...args);
      clock = 1001;
      return sandbox;
    };
    const result = await runPipeline({
      worldDir: HELPDESK_DIR, out: tmp('startup-deadline'), runId: 'run-1', engineCommit: COMMIT, model: 'claude-sonnet-5-5',
      maxTurns: 60, budgetUsd: 5, maxMinutes: 1 / 60, secrets: [], sandboxName: 'ds-deadline', port,
    }, {
      backend, makeBundle: tinyBundle, grader: engineGrader, now: () => clock,
      fetch: async () => { publicCalls += 1; return new Response('{}'); },
      nextTurn: async (view, signal) => { modelCalls += 1; return lazySolver(view, signal); },
    });
    assert.equal(publicCalls, 0);
    assert.equal(modelCalls, 0);
    assert.equal(result.status, 'failed');
    assert.equal(result.episodes.length, 0);
    assert.equal(result.modelCostUsd, 0);
    assert.equal(backend.stopped(), true);
    assert.equal(backend.events.at(-1), 'down');
  });

  it('stops cleanly when interrupted: the pending call is cancelled, evidence is kept and the sandbox stops', RUN_BUDGET, async () => {
    const controller = new AbortController();
    const solver: NextTurn = (_v, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      setTimeout(() => controller.abort(), 20);
    });
    const { result, backend, out } = await run({ solver, deps: { interrupt: controller.signal } });
    assert.deepEqual(result.episodes.map((e) => e.stop_reason), ['interrupted']);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.problems, ['interrupted before every task had an episode']);
    assert.equal(result.sandbox.teardown, 'confirmed');
    assert.equal(backend.stopped(), true);
    assert.equal(lines(path.join(out, 'failures.jsonl')).length, 1);
  });
});

describe('cleanup and evidence', () => {
  it('stops the sandbox when the post-start logger throws', RUN_BUDGET, async () => {
    const backend = fakeBackend(await helpdesk(), { port: randomPort() });
    try {
      const { result, out } = await run({ deps: {
        backend,
        log: (line) => {
          if (line === 'sandbox fake-sandbox-1 is up') throw new Error(`post-start logger failed ${ANTHROPIC}`);
        },
      } });
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.sandbox, { id: 'fake-sandbox-1', teardown: 'confirmed' });
      assert.deepEqual(result.problems, ['the run stopped on an unexpected error: post-start logger failed [redacted]']);
      assert.deepEqual(result.episodes, []);
      assert.equal(backend.stopped(), true);
      assert.equal(backend.events.filter((e) => e === 'down').length, 1);
      const saved = JSON.parse(readFileSync(path.join(out, 'private/diagnostics/run-1/summary.json'), 'utf8'));
      assert.deepEqual(saved.sandbox, { id: 'fake-sandbox-1', teardown: 'confirmed' });
      assert.deepEqual(saved.problems, ['the run stopped on an unexpected error: post-start logger failed [redacted]']);
    } finally {
      if (!backend.stopped()) await backend.down('fake-sandbox-1');
    }
  });

  it('retains both failures when post-start logging and teardown fail', RUN_BUDGET, async () => {
    const { result, backend } = await run({ backend: { failDown: true }, deps: {
      log: (line) => {
        if (line === 'sandbox fake-sandbox-1 is up') throw new Error('post-start logger failed');
      },
    } });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.sandbox, { id: 'fake-sandbox-1', teardown: 'failed' });
    assert.equal(backend.events.filter((e) => e === 'down').length, 1);
    assert.equal(backend.stopped(), false);
    assert.deepEqual(result.problems, [
      'the run stopped on an unexpected error: post-start logger failed',
      'teardown of sandbox fake-sandbox-1 failed and it may still be running: boat stop never confirmed',
    ]);
  });

  it('keeps a confirmed stop when the post-stop logger throws', RUN_BUDGET, async () => {
    const { result, backend, out } = await run({ deps: {
      log: (line) => {
        if (line === 'sandbox fake-sandbox-1 stopped') throw new Error(`post-stop logger failed ${BOAT}`);
      },
    } });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.sandbox, { id: 'fake-sandbox-1', teardown: 'confirmed' });
    assert.deepEqual(result.problems, ['logging the confirmed stop of sandbox fake-sandbox-1 failed: post-stop logger failed [redacted]']);
    assert.equal(backend.stopped(), true);
    assert.equal(backend.events.filter((e) => e === 'down').length, 1);
    assert.equal(result.accepted, 3);
    const saved = JSON.parse(readFileSync(path.join(out, 'private/diagnostics/run-1/summary.json'), 'utf8'));
    assert.deepEqual(saved.sandbox, { id: 'fake-sandbox-1', teardown: 'confirmed' });
    assert.deepEqual(saved.problems, ['logging the confirmed stop of sandbox fake-sandbox-1 failed: post-stop logger failed [redacted]']);
  });

  it('still stops the sandbox when the export fails, and says so', RUN_BUDGET, async () => {
    const out = tmp('badlog');
    mkdirSync(path.join(out, 'logs'), { recursive: true });
    writeFileSync(path.join(out, 'logs', 'older.episodes.jsonl'), '{"schema_version":');
    const { result, backend } = await run({ out });
    assert.equal(result.status, 'failed');
    assert.equal(result.manifest, null);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0] ?? '', /^export failed: .*older\.episodes\.jsonl.*the last line is incomplete/);
    assert.equal(backend.events.at(-1), 'down');
    assert.equal(result.sandbox.teardown, 'confirmed');
    assert.equal(existsSync(path.join(out, 'dataset.jsonl')), false);
    assert.equal(readFileSync(path.join(out, 'private/diagnostics/run-1/summary.json'), 'utf8').includes('"status": "failed"'), true);
  });

  it('makes a stop that was not confirmed visible, and is not a success', RUN_BUDGET, async () => {
    const { result, backend } = await run({ backend: { failDown: true } });
    assert.equal(result.status, 'failed');
    assert.equal(result.sandbox.teardown, 'failed');
    assert.deepEqual(result.problems, ['teardown of sandbox fake-sandbox-1 failed and it may still be running: boat stop never confirmed']);
    assert.equal(backend.events.filter((e) => e === 'down').length, 1);
    assert.equal(result.accepted, 3);
  });

  it('keeps diagnostics when collecting from the sandbox partly fails, and still stops it', RUN_BUDGET, async () => {
    const { result, backend, out } = await run({ backend: { failExec: (cmd) => (cmd[2] === CHUNK_SCRIPT && cmd[3] === '/tmp/worldplay.log' ? 1 : undefined) } });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.problems, ['collecting from the sandbox failed: worldplay.log: read worldplay.log failed in the sandbox (exit 1): injected failure']);
    const diag = path.join(out, 'private/diagnostics/run-1');
    assert.equal(readFileSync(path.join(diag, 'collect-errors.txt'), 'utf8'), 'worldplay.log: read worldplay.log failed in the sandbox (exit 1): injected failure');
    assert.equal(existsSync(path.join(diag, 'final-state.json')), true);
    assert.equal(existsSync(path.join(diag, 'worldplay.log')), false);
    assert.equal(lines(path.join(out, 'dataset.jsonl')).length, 3);
    assert.equal(backend.events.at(-1), 'down');
  });

  it('is not a success when an episode\'s evidence could not be kept', RUN_BUDGET, async () => {
    const out = tmp('noevidence');
    mkdirSync(path.join(out, 'private'), { recursive: true });
    writeFileSync(path.join(out, 'private', 'episodes'), 'a file where the episode directories go');
    const { result, backend } = await run({ out });
    assert.equal(result.status, 'failed');
    assert.equal(result.problems.filter((p) => p.includes('was not saved')).length, 3);
    assert.equal(result.accepted, 3);
    assert.equal(backend.events.at(-1), 'down');
  });

  it('reports a sandbox that did not come up, with nothing to stop', RUN_BUDGET, async () => {
    const { result, backend, out } = await run({ backend: { failUp: true } });
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.sandbox, { id: null, teardown: 'not_started' });
    assert.deepEqual(result.problems, ['the sandbox did not come up: boat create failed']);
    assert.deepEqual(backend.events, ['up']);
    assert.deepEqual(result.episodes, []);
    assert.equal(existsSync(path.join(out, 'dataset.jsonl')), false);
  });

  it('fails the run when the engine admin channel fails mid-run, as a world_error episode, not a crash', RUN_BUDGET, async () => {
    const { result, backend, out } = await run({ backend: { failExec: (cmd) => (cmd[1] === '-e' && cmd[3] === 'POST' && String(cmd[4]).endsWith('/_world/reset') ? 2 : undefined) } });
    assert.deepEqual(result.episodes.map((e) => e.stop_reason), ['world_error', 'world_error', 'world_error']);
    assert.equal(result.episodes[0]?.error, 'the controller could not reset; the details are in the private diagnostics');
    const detail = readFileSync(path.join(out, 'private/episodes', result.episodes[0]?.episode_id ?? '', 'errors.json'), 'utf8');
    assert.equal(detail, '[{"boundary":"reset","message":"reset failed in the sandbox (exit 2): injected failure"}]');
    assert.equal(result.accepted, 0);
    assert.equal(backend.events.at(-1), 'down');
  });
});

describe('refusals before anything starts', () => {
  const idle = async (s: Setup, re: RegExp | string) => {
    const world = await helpdesk();
    const backend = fakeBackend(world, { port: randomPort() });
    const out = s.out ?? tmp('refused');
    await assert.rejects(
      runPipeline({ worldDir: HELPDESK_DIR, out, runId: 'run-1', engineCommit: COMMIT, model: 'claude-sonnet-5-5', maxTurns: 3, budgetUsd: 1, maxMinutes: 1, secrets: [], sandboxName: 'x-abc123', ...s.opts }, { backend, nextTurn: lazySolver, makeBundle: tinyBundle, grader: engineGrader }),
      (e: unknown) => e instanceof PreflightError && (typeof re === 'string' ? e.message === re : re.test(e.message)),
    );
    assert.deepEqual(backend.events, []);
    return out;
  };

  it('rejects bad options by name', RUN_BUDGET, async () => {
    await idle({ opts: { runId: '../x' } }, /^run id "\.\.\/x" must be 1 to 64 letters/);
    await idle({ opts: { runId: 'nightly__v2' } }, 'run id "nightly__v2" must be 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit, with no "__" and no "_" at the end');
    await idle({ opts: { engineCommit: 'main' } }, 'engine commit "main" must be 7 to 64 lowercase hex digits');
    await idle({ opts: { maxTurns: 0 } }, 'max turns must be a whole number of at least 1');
    await idle({ opts: { budgetUsd: -1 } }, 'budget must be a positive number of USD');
    await idle({ opts: { maxMinutes: Number.NaN } }, 'max minutes must be a positive number');
  });

  it('rejects a world that does not check, with the engine\'s issue, and creates no sandbox or world copy', RUN_BUDGET, async () => {
    const dir = tmp('brokenworld');
    writeFileSync(path.join(dir, 'world.yaml'), 'format: 1\n');
    const out = await idle({ opts: { worldDir: dir } }, /^the world in .* does not check \(\d+ issues?\):\n[a-z_.]+ /);
    assert.equal(existsSync(path.join(out, 'private')), false);
    await idle({ opts: { worldDir: path.join(dir, 'nowhere') } }, /does not check/);
  });

  it('rejects a task whose name would make its episode ids ambiguous, before any sandbox', RUN_BUDGET, async () => {
    const dir = tmp('dunder-task');
    cpSync(HELPDESK_DIR, dir, { recursive: true });
    const file = path.join(dir, 'world.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('\n  assign_newest_acme_ticket:\n', '\n  assign__newest_acme_ticket:\n'));
    await idle({ opts: { worldDir: dir } }, 'task "assign__newest_acme_ticket" cannot be used as a dataset task id: an episode id joins run, task and number with "__", so a task id cannot contain "__"');
  });

  it('rejects a reused run id', RUN_BUDGET, async () => {
    const { out } = await run();
    await idle({ out }, `run id run-1 is already used in ${out}: pick another --run-id`);
  });
});

describe('an episode that a fake model cannot spend', () => {
  it('records nothing it did not run: a model that always fails leaves zero cost and no accepted row', RUN_BUDGET, async () => {
    const solver: NextTurn = async () => {
      throw Object.assign(new Error('Anthropic API error 529: overloaded'), { status: 529 });
    };
    const { result, out } = await run({ solver });
    assert.deepEqual(result.episodes.map((e) => [e.stop_reason, e.usage.model_calls, e.usage.cost_usd, e.score]), [
      ['model_error', 0, 0, 0], ['model_error', 0, 0, 0], ['model_error', 0, 0, 0],
    ]);
    assert.equal(readFileSync(path.join(out, 'dataset.jsonl'), 'utf8'), '');
    assert.equal(turn({}).costUsd > 0, true);
  });
});

describe('runs that share one --out', () => {
  it('freezes one world for runs that start together, leaving only the frozen file', RUN_BUDGET, async () => {
    const out = tmp('freeze');
    const checked = await checkForRun(HELPDESK_DIR);
    const preps = await Promise.all(Array.from({ length: 8 }, () => prepareWorld(HELPDESK_DIR, out, checked)));
    const version = preps[0]?.worldVersion;
    assert.equal(preps.every((p) => p.worldVersion === version), true);
    assert.deepEqual(readdirSync(path.join(out, 'private', 'worlds')), [version]);
    assert.deepEqual(readdirSync(path.join(out, 'private', 'worlds', version ?? '')), ['public', 'world.yaml']);
  });

  it('runs two run ids at once: both are accepted and the last export holds both', RUN_BUDGET, async () => {
    const out = tmp('shared');
    const runs = await Promise.all(['run-a', 'run-b'].map((runId) => run({ out, opts: { runId, sandboxName: `ds-${runId}-abc123` } })));
    assert.deepEqual(runs.map((r) => [r.result.status, r.result.problems]), [['accepted', []], ['accepted', []]]);
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual([manifest.counts.episodes, manifest.run_ids], [6, ['run-a', 'run-b']]);
  });

  it('gives a run id to one run: a second run started with it at the same time is refused', RUN_BUDGET, async () => {
    const out = tmp('same-id');
    const settled = await Promise.allSettled([run({ out }), run({ out })]);
    const refused = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []));
    const ran = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value.result] : []));
    assert.equal(refused.length, 1);
    assert.equal(refused[0] instanceof PreflightError && refused[0].message, `run id run-1 is already used in ${out}: pick another --run-id`);
    assert.deepEqual(ran.map((r) => [r.status, r.problems]), [['accepted', []]]);
  });
});

describe('stateFromAdmin', () => {
  const dump = { world: 'helpdesk', hash: 'abc', now: '2026-03-02T09:00:00.000Z', tables: { ticket: [] }, counters: { ticket: 0 } };

  it('drops the admin route digest when it matches the dump, so the state hashes as the bare dump', () => {
    const read = { ...dump, sha256: dumpSha256(dump as unknown as StateDump) };
    assert.deepEqual(stateFromAdmin(read), dump);
    assert.equal(hashState(stateFromAdmin(read)), hashState(dump));
  });

  it('accepts a dump with no digest, as an older engine returns', () => {
    assert.deepEqual(stateFromAdmin(dump), dump);
  });

  it('refuses a digest that does not match the dump', () => {
    assert.throws(() => stateFromAdmin({ ...dump, sha256: 'sha-256:0000' }), /sha-256 digest that does not match its dump/);
    assert.throws(() => stateFromAdmin({ ...dump, tables: { ticket: [{ id: 'tkt_0001' }] }, sha256: dumpSha256(dump as unknown as StateDump) }), /does not match its dump/);
  });

  it('refuses an answer that is not a state dump', () => {
    assert.throws(() => stateFromAdmin({ ok: true }), /did not return a state dump/);
    assert.throws(() => stateFromAdmin(null), /did not return a state dump/);
  });
});
