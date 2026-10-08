/**
 * The studio: the offline page, the loopback routes, the child rollout (serve/stop), the
 * generation runs, the eval and spend reads, and the private boundary. The spawner and the
 * runner are fakes, so no test starts a real child and no model is ever called. Canary worlds,
 * the private-boundary pattern, prove no grader, solution or decoy source reaches any /api
 * response or the page.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { checkWorld, saveWorld, serve, worldIdOf, type World, type WorldServer } from '#engine';
import { nodeRunner, type RunResult, type Runner, type SpawnedChild, type Spawner } from '../src/sandboxes/backend.ts';
import { studioPage } from '../src/studio/page.ts';
import { studioServer, type StudioServer } from '../src/studio/server.ts';
import { quietPort } from './helpers/ports.ts';
import { minimalWorld } from './helpers/world.ts';

// ---- transport: fetch against the loopback studio ----------------------------------------------

const REAL_CODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Json = { [k: string]: unknown };

async function call(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; text: string; type: string | null }> {
  const res = await fetch(`${base}${p}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
}

async function json(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; type: string | null; body: Json }> {
  const r = await call(base, method, p, body);
  return { status: r.status, type: r.type, body: (r.text === '' ? null : JSON.parse(r.text)) as Json };
}

/** A run status without its job record, which test/studio-jobs.test.ts covers. */
const withoutJob = (body: Json): Json => Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'job'));

/** The error object of a JSON answer, narrowed. */
function errorOf(body: Json): { code: unknown; message: unknown } | null {
  const e = body['error'];
  return typeof e === 'object' && e !== null ? (e as { code: unknown; message: unknown }) : null;
}

// ---- fakes: every child is recorded, none is real ------------------------------------------------

/** What the next spawn answers: which signals it dies to, its pid, and what it does on start. */
/**
 * What the next spawn answers: which signals it dies to, its pid, and what it does on start. A `worldplay serve` child
 * prints its listening line as the real one does (A-348): the asked port and port + 1, or fake OS-picked ports for port 0,
 * unless `listening` names other ports, is null for a child that never reports, or `exitsFirst` makes it exit first.
 */
type ChildPlan = {
  diesOn?: readonly string[];
  pid?: number;
  onSpawn?: (argv: readonly string[]) => void;
  listening?: { readonly world: number; readonly admin: number } | null;
  exitsFirst?: { readonly code: number; readonly line: string };
};

let pickedPorts = 46000;
/** The listening line a fake `worldplay serve` prints for this argv and plan, or '' for any other child. */
function serveLine(argv: readonly string[], plan: ChildPlan): string {
  if (argv[1] !== 'src/cli/worldplay.ts' || argv[2] !== 'serve' || plan.listening === null || plan.exitsFirst !== undefined) return '';
  const asked = Number(argv[argv.indexOf('--port') + 1]);
  const ports = plan.listening ?? (asked > 0 ? { world: asked, admin: asked + 1 } : { world: (pickedPorts += 2), admin: pickedPorts + 1 });
  return `${JSON.stringify({ listening: ports })}\n`;
}

function fakeChild(plan: ChildPlan = {}, argv: readonly string[] = []): { child: SpawnedChild; signals: string[]; exitWith: (code: number | null) => void } {
  const signals: string[] = [];
  const diesOn = plan.diesOn ?? ['SIGTERM', 'SIGKILL'];
  let dead = false;
  let text = serveLine(argv, plan);
  let settle: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settle = resolve;
  });
  const child: SpawnedChild = {
    pid: plan.pid ?? 43210,
    exited,
    kill(signal) {
      signals.push(signal);
      if (!dead && diesOn.includes(signal)) {
        dead = true;
        settle(signal === 'SIGKILL' ? null : 0);
      }
      return !dead;
    },
    output: () => text,
  };
  if (plan.exitsFirst !== undefined) {
    const { code, line } = plan.exitsFirst;
    text = `${line}\n`;
    dead = true;
    setImmediate(() => settle(code));
  }
  return {
    child,
    signals,
    exitWith(code) {
      dead = true;
      text += `exit ${code}\n`;
      settle(code);
    },
  };
}

type SpawnedCall = { argv: string[]; cwd: string | undefined; handle: ReturnType<typeof fakeChild> };

function fakeSpawner(plan: () => ChildPlan): { spawner: Spawner; spawned: SpawnedCall[] } {
  const spawned: SpawnedCall[] = [];
  const spawner: Spawner = (argv, opts) => {
    const one = plan();
    const handle = fakeChild(one, argv);
    spawned.push({ argv: [...argv], cwd: opts?.cwd, handle });
    one.onSpawn?.(argv);
    return handle.child;
  };
  return { spawner, spawned };
}

// ---- canary worlds, the private-boundary pattern --------------------------------------------------

/** A comment right after the first arrow, so the snippet stays one function expression with the same behavior. */
function comment(canary: string, source: string | undefined): string {
  assert.ok(source !== undefined, 'snippet is present in the private world');
  assert.equal(source.includes('=>'), true, 'snippet has no arrow');
  return source.replace('=>', `=> /* ${canary} */`);
}

function markedWorld(label: string): { world: World; canaries: string[] } {
  const canaries: string[] = [];
  const mark = (kind: string): string => {
    const text = `STUDIO_CANARY_${label}_${canaries.length}_${kind}`;
    canaries.push(text);
    return text;
  };
  const base = minimalWorld();
  const tasks = Object.fromEntries(Object.entries(base.tasks).map(([id, t]) => [id, {
    ...t,
    grader: comment(mark('GRADER'), t.grader),
    solution: comment(mark('SOLUTION'), t.solution),
    decoys: t.decoys.map((d) => ({ script: comment(mark('DECOY_SCRIPT'), d.script), why: `${mark('DECOY_WHY')}: ${d.why}` })),
  }]));
  return { world: minimalWorld({ tasks }), canaries };
}

/** The only writer of a fixture world.yaml: through checkWorld and saveWorld. */
async function writeWorld(dir: string, world: World): Promise<void> {
  const report = checkWorld(world);
  if (!report.ok) assert.fail(`fixture world failed check:\n${JSON.stringify(report.issues, null, 2)}`);
  await mkdir(dir, { recursive: true });
  await saveWorld(dir, report.world);
}

// ---- fixture facts --------------------------------------------------------------------------------

const CAPSULE = {
  capsule: 1,
  runId: 'run_20261007T181329Z_old1111',
  mode: 'create',
  input: { kind: 'description', digest: 'a'.repeat(64) },
  worldId: `wid_${'b'.repeat(64)}`,
  model: 'claude-sonnet-5-5',
  transport: 'claude-cli',
  attempts: [
    { step: 'plan', n: 1, outcome: 'accepted', ms: 12000, costUsd: 0.2 },
    { step: 'model', n: 1, outcome: 'accepted', ms: 9000, costUsd: 0.31 },
  ],
  ms: 24000,
  costUsd: 0.51,
};
const CANARY_CAPSULE = { ...CAPSULE, runId: 'run_20261007T000000Z_other99', worldId: null, input: { kind: 'description', digest: 'c'.repeat(64) } };

const SUMMARY_WITH_PASS = `# Eval run run-2026-10-07-a

Suite \`stress\`, model \`claude-sonnet-5-5\`, budget $2.0000 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |
|---|---|---|---|---|--:|--:|---|---|---|
| alpha | done | done | - | plan 1 | 1.0 | $0.2000 | pass: 3 tasks | ok | yes |

**Totals:** 1 expected cases: 1 done, 0 stopped, 0 crashed, 0 missing, 0 invalid; 1.0 min; $0.2000; 0 unlogged.

**Median and p95:** 1.0 min and 1.0 min; $0.2000 and $0.2000.

**Pass rate:** 1/1 (100%).
`;
const SUMMARY_NO_PASS = `# Eval run preview-only

A hand-written summary with no pass-rate line, so the list shows a preview only.
Line three.
Line four.
Line five.
Line six.
Line seven.
Line eight.
Line nine.
Line ten.
Line eleven.
Line twelve.
Line thirteen.
`;

const COSTS_JSON = {
  file: '/tmp/costs.jsonl',
  since: null,
  by: 'day',
  meters: {
    day: '2026-10-07',
    llm: { today: { usd: 1.25, events: 3, estimated: 0, unpriced: 0, unpricedSeconds: 0 }, allTime: { usd: 9.15, events: 18, estimated: 0, unpriced: 0, unpricedSeconds: 0 } },
    sandbox: { today: { usd: 0, events: 0, estimated: 0, unpriced: 2, unpricedSeconds: 7200 }, allTime: { usd: 0.35, events: 3, estimated: 1, unpriced: 8, unpricedSeconds: 28800 } },
    total: { today: { usd: 1.25, events: 3, estimated: 0, unpriced: 2, unpricedSeconds: 7200 }, allTime: { usd: 9.5, events: 21, estimated: 1, unpriced: 8, unpricedSeconds: 28800 } },
  },
  rows: [
    { key: '2026-10-07', usd: 1.25, events: 3, estimated: 0, unpriced: 2, unpricedSeconds: 7200 },
    { key: '2026-10-06', usd: 8.25, events: 18, estimated: 1, unpriced: 6, unpricedSeconds: 21600 },
  ],
  total: { usd: 9.5, events: 21, estimated: 1, unpriced: 8, unpricedSeconds: 28800 },
  pending: [],
  caps: {
    day: '2026-10-07',
    WORLDGEN_MAX_DAILY_USD: { capUsd: 20, spentUsd: 1.25, remainingUsd: 18.75 },
    WORLDGEN_MAX_TOTAL_USD: null,
  },
};

/** The events the fake worldgen child writes under <out>/runs/run_.../events.jsonl. */
const FAKE_RUN_ID = 'run_20261007T181329Z_fake0001';
const E1 = { t: 'run_started', at: '2026-10-07T18:13:29.000Z', runId: FAKE_RUN_ID, mode: 'create', input: 'description', model: 'claude-sonnet-5-5', budgetUsd: 2, transport: 'claude-cli' };
const E2 = { t: 'attempt', at: '2026-10-07T18:13:41.000Z', runId: FAKE_RUN_ID, step: 'plan', n: 1, ms: 12000, costUsd: 0.2, outcome: { kind: 'accepted', warnings: 0 } };
const E3 = { t: 'run_finished', at: '2026-10-07T18:13:53.000Z', runId: FAKE_RUN_ID, ms: 24000, costUsd: 0.51, worldWritten: true, result: { kind: 'done' } };

describe('studio', () => {
  let root = '';
  let worldsDir = '';
  let inputsDir = '';
  let base = '';
  let server: StudioServer;
  let spawnPlan: () => ChildPlan = () => ({});
  let spawned: SpawnedCall[] = [];
  let costsCalls: { argv: string[]; cwd: string | undefined }[] = [];
  let canaries: string[] = [];
  let leakCanaries: string[] = [];

  const lastSpawn = (): SpawnedCall => {
    const one = spawned.at(-1);
    assert.ok(one !== undefined, 'no child was spawned');
    return one;
  };

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-'));
    worldsDir = path.join(root, 'prod', 'worlds');
    inputsDir = path.join(root, 'eval', 'inputs');
    const evalRuns = path.join(root, 'eval', 'runs');

    // worlds: a generated one with a capsule and a past run, a hand-built one, a broken one,
    // a canary one, and one whose REPORT.md embeds its own grader source.
    const alpha = path.join(worldsDir, 'gen-alpha');
    await writeWorld(alpha, minimalWorld());
    await writeFile(path.join(alpha, 'plan.yaml'), 'revision: 1\n');
    await writeFile(path.join(alpha, 'REPORT.md'), '# Report gen-alpha\n\nThree tasks verified.\n');
    await writeFile(path.join(alpha, 'capsule.json'), `${JSON.stringify(CAPSULE, null, 2)}\n`);
    await mkdir(path.join(alpha, 'runs', CAPSULE.runId), { recursive: true });
    await writeFile(path.join(alpha, 'runs', CAPSULE.runId, 'events.jsonl'), `${JSON.stringify(E1)}\n`);

    await writeWorld(path.join(worldsDir, 'hand-beta'), minimalWorld());

    await mkdir(path.join(worldsDir, 'no-world-gamma'), { recursive: true });
    await writeFile(path.join(worldsDir, 'no-world-gamma', 'plan.yaml'), 'revision: 1\n');

    const canary = markedWorld('alpha');
    canaries = canary.canaries;
    const canaryDir = path.join(worldsDir, 'gen-canary');
    await writeWorld(canaryDir, canary.world);
    await writeFile(path.join(canaryDir, 'plan.yaml'), 'revision: 1\n');
    await writeFile(path.join(canaryDir, 'REPORT.md'), '# Report gen-canary\n\nA benign report.\n');
    await writeFile(path.join(canaryDir, 'capsule.json'), `${JSON.stringify(CANARY_CAPSULE, null, 2)}\n`);
    await mkdir(path.join(canaryDir, 'runs', 'run_20261007T000000Z_canary01'), { recursive: true });
    await writeFile(path.join(canaryDir, 'runs', 'run_20261007T000000Z_canary01', 'events.jsonl'), `${JSON.stringify(E1)}\n`);

    const leak = markedWorld('leak');
    leakCanaries = leak.canaries;
    const leakDir = path.join(worldsDir, 'gen-leak');
    await writeWorld(leakDir, leak.world);
    const leakGrader = Object.values(leak.world.tasks)[0];
    assert.ok(leakGrader !== undefined);
    await writeFile(path.join(leakDir, 'REPORT.md'), `# Report gen-leak\n\nA report that quotes its own grader:\n\n${leakGrader.grader}\n`);

    // eval inputs and eval runs
    await mkdir(inputsDir, { recursive: true });
    await writeFile(path.join(inputsDir, 'petstore.openapi.yaml'), 'openapi: 3.1.0\npaths:\n  /pet: {}\n  /store/order: {}\n');
    await writeFile(path.join(inputsDir, 'orders.csv'), 'id,customer\no1,cus_0001\n');
    await writeFile(path.join(inputsDir, 'customers.csv'), 'id,name\ncus_0001,Acme\n');
    await mkdir(path.join(evalRuns, 'run-2026-10-07-a'), { recursive: true });
    await writeFile(path.join(evalRuns, 'run-2026-10-07-a', 'summary.md'), SUMMARY_WITH_PASS);
    await mkdir(path.join(evalRuns, 'no-summary'), { recursive: true });
    await mkdir(path.join(evalRuns, 'preview-only'), { recursive: true });
    await writeFile(path.join(evalRuns, 'preview-only', 'summary.md'), SUMMARY_NO_PASS);

    const { spawner, spawned: calls } = fakeSpawner(() => spawnPlan());
    spawned = calls;
    const costsResult: RunResult = { code: 0, stdout: `${JSON.stringify(COSTS_JSON, null, 2)}\n`, stderr: '' };
    const runner: Runner = async (argv, opts) => {
      // The Explorer's check child runs for real, in the real code dir; the fake root has none.
      if (argv.includes('src/cli/studio-check.ts')) return nodeRunner(argv, { ...opts, cwd: REAL_CODE_DIR });
      costsCalls.push({ argv: [...argv], cwd: opts?.cwd });
      return costsResult;
    };
    server = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, build: 'test-sha', serveWaitMs: 1500, runStopWaitMs: 1000, maxConcurrentRuns: 1000, maxConcurrentEpisodes: 1000 });
    base = server.url;
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  describe('health', () => {
    it('GET /api/health is ready with the build, the runtime, the world count and the traffic so far', async () => {
      const r = await call(base, 'GET', '/api/health');
      assert.equal(r.status, 200);
      const listed = (JSON.parse((await call(base, 'GET', '/api/worlds')).text) as { worlds: unknown[] }).worlds.length;
      const bun = process.versions['bun'];
      // The first test of the suite: no answer has been counted yet, and health polls never are. Counts after real
      // traffic, on an injected clock, are in test/studio-watch.test.ts.
      const { traffic, ...rest } = JSON.parse(r.text) as { traffic: { since: string } };
      assert.deepEqual(rest, { ok: true, build: 'test-sha', runtime: bun === undefined ? `node ${process.versions.node}` : `bun ${bun}`, worlds: listed });
      assert.equal(new Date(traffic.since).toISOString(), traffic.since);
      assert.deepEqual({ ...traffic, since: 'ISO' }, { since: 'ISO', requests: 0, errors5xx: 0, windowSeconds: 300, window: { requests: 0, errors5xx: 0 } });
    });
  });

  describe('the page', () => {
    it('GET / is one offline HTML page with the five sections and no absolute URL', async () => {
      const r = await call(base, 'GET', '/');
      assert.equal(r.status, 200);
      assert.equal(r.type, 'text/html; charset=utf-8');
      assert.ok(r.text.startsWith('<!DOCTYPE html>'));
      for (const section of ['<h2>Worlds<span', '<h2>Explorer<span', '<h2>Generation runs', '<h2>Eval<span', '<h2>Spend<span']) {
        assert.equal(r.text.includes(section), true, `missing section ${section}`);
      }
      assert.equal(r.text.includes('http://'), false);
      assert.equal(r.text.includes('https://'), false);
    });
  });

  describe('worlds', () => {
    it('lists every world dir with kind, tasks, capsule facts and report flag', async () => {
      const r = await json(base, 'GET', '/api/worlds');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        worlds: [
          {
            name: 'gen-alpha',
            tenant: null,
            generated: true,
            taskCount: 3,
            capsule: { wid: `wid_${'b'.repeat(64)}`, model: 'claude-sonnet-5-5', transport: 'claude-cli', costUsd: 0.51, attempts: 2 },
            reportExists: true,
          },
          {
            name: 'gen-canary',
            tenant: null,
            generated: true,
            taskCount: 3,
            capsule: { wid: null, model: 'claude-sonnet-5-5', transport: 'claude-cli', costUsd: 0.51, attempts: 2 },
            reportExists: true,
          },
          { name: 'gen-leak', tenant: null, generated: false, taskCount: 3, reportExists: true },
          { name: 'hand-beta', tenant: null, generated: false, taskCount: 3, reportExists: false },
          { name: 'no-world-gamma', tenant: null, generated: true, taskCount: null, invalid: 'schema.invalid', reportExists: false },
        ],
      });
    });

    it('serves a world REPORT.md with its capsule', async () => {
      const r = await json(base, 'GET', '/api/worlds/gen-alpha/report');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { name: 'gen-alpha', report: '# Report gen-alpha\n\nThree tasks verified.\n', capsule: CAPSULE });
    });

    it('answers report null where REPORT.md is absent', async () => {
      const r = await json(base, 'GET', '/api/worlds/hand-beta/report');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { name: 'hand-beta', report: null });
    });

    it('refuses a REPORT.md that embeds private task source', async () => {
      const r = await json(base, 'GET', '/api/worlds/gen-leak/report');
      assert.equal(r.status, 403);
      assert.deepEqual(r.body, {
        error: { code: 'report.private_source', message: 'gen-leak/REPORT.md contains private task source; the studio refuses to serve it' },
      });
    });

    it('serves a REPORT.md that lists decoy reasons, which are prose, not task source (A-280)', async () => {
      const dir = path.join(worldsDir, 'gen-decoy-theta');
      const world = structuredClone(minimalWorld());
      await writeWorld(dir, world);
      const why = Object.values(world.tasks).flatMap((t) => (t.decoys ?? []).map((d) => d.why))[0];
      assert.equal(typeof why, 'string');
      await writeFile(path.join(dir, 'REPORT.md'), `# gen-decoy-theta\n\nDecoys:\n- ${why}\n`);
      try {
        const r = await json(base, 'GET', '/api/worlds/gen-decoy-theta/report');
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body['report'], `# gen-decoy-theta\n\nDecoys:\n- ${why}\n`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('404s an unknown world', async () => {
      const r = await json(base, 'GET', '/api/worlds/nope/report');
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { error: { code: 'world.unknown', message: `No world nope under ${worldsDir}` } });
    });
  });

  describe('past runs', () => {
    it('lists every run dir with the capsule facts of the run that wrote it', async () => {
      const r = await json(base, 'GET', '/api/runs');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        runs: [
          { name: 'gen-alpha', tenant: null, runId: 'run_20261007T181329Z_old1111', model: 'claude-sonnet-5-5', transport: 'claude-cli', costUsd: 0.51, ms: 24000, outcome: 'done', hasReport: true },
          { name: 'gen-canary', tenant: null, runId: 'run_20261007T000000Z_canary01', model: null, transport: null, costUsd: null, ms: null, outcome: null, hasReport: true },
        ],
      });
    });
  });

  describe('rollout: serve and stop', () => {
    it('spawns worldplay serve on the asked port and tracks the record', async () => {
      const r = await json(base, 'POST', '/api/worlds/gen-alpha/serve', { port: 4123 });
      assert.equal(r.status, 200);
      const rec = r.body;
      assert.match(String(rec['id']), /^svc-[0-9a-f]{8}$/);
      assert.equal(rec['name'], 'gen-alpha');
      assert.equal(rec['pid'], 43210);
      assert.equal(rec['worldPort'], 4123);
      assert.equal(rec['adminPort'], 4124);
      assert.equal(typeof rec['startedAt'], 'string');
      assert.deepEqual(lastSpawn().argv, ['bun', 'src/cli/worldplay.ts', 'serve', path.join(worldsDir, 'gen-alpha'), '--port', '4123']);
      assert.equal(lastSpawn().cwd, path.join(root, 'code'));
    });

    it('lists the served record', async () => {
      const r = await json(base, 'GET', '/api/services');
      assert.equal(r.status, 200);
      const services = r.body['services'] as Json[];
      assert.equal(services.length, 1);
      assert.equal(services[0]?.['name'], 'gen-alpha');
      assert.equal(services[0]?.['worldPort'], 4123);
      assert.equal(services[0]?.['adminPort'], 4124);
      assert.equal(services[0]?.['pid'], 43210);
      assert.equal(typeof services[0]?.['startedAt'], 'string');
    });

    it('refuses a second serve of a running world', async () => {
      const r = await json(base, 'POST', '/api/worlds/gen-alpha/serve', { port: 4125 });
      assert.equal(r.status, 409);
      assert.deepEqual(r.body, { error: { code: 'world.already_serving', message: 'gen-alpha is already served on port 4123; stop it first' } });
    });

    it('stop SIGTERMs the child, answers stopped and drops the record', async () => {
      const id = String(((await json(base, 'GET', '/api/services')).body['services'] as Json[])[0]?.['id']);
      const r = await json(base, 'POST', `/api/services/${id}/stop`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { id, stopped: true, signal: 'SIGTERM' });
      assert.deepEqual(lastSpawn().handle.signals, ['SIGTERM']);
      assert.deepEqual((await json(base, 'GET', '/api/services')).body, { services: [] });
    });

    it('serves on port 0 when none is asked for, and records the ports the child reports (A-348)', async () => {
      spawnPlan = () => ({ listening: { world: 45678, admin: 45901 } });
      const r = await json(base, 'POST', '/api/worlds/hand-beta/serve', {});
      spawnPlan = () => ({});
      assert.equal(r.status, 200);
      assert.deepEqual([r.body['worldPort'], r.body['adminPort']], [45678, 45901]);
      assert.deepEqual(lastSpawn().argv, ['bun', 'src/cli/worldplay.ts', 'serve', path.join(worldsDir, 'hand-beta'), '--port', '0']);
      const id = String(r.body['id']);
      assert.deepEqual((await json(base, 'POST', `/api/services/${id}/stop`)).body, { id, stopped: true, signal: 'SIGTERM' });
    });

    it('answers 502 with the child\'s last line when worldplay serve exits before it listens', async () => {
      spawnPlan = () => ({ exitsFirst: { code: 1, line: 'serve: listen EADDRINUSE: address already in use 127.0.0.1:4555' } });
      const r = await json(base, 'POST', '/api/worlds/hand-beta/serve', {});
      spawnPlan = () => ({});
      assert.deepEqual([r.status, r.body], [502, { error: { code: 'serve.failed', message: 'worldplay serve for hand-beta exited 1 before it listened: serve: listen EADDRINUSE: address already in use 127.0.0.1:4555' } }]);
      assert.deepEqual((await json(base, 'GET', '/api/services')).body, { services: [] });
    });

    it('stops a child that reports no ports within serveWaitMs, and answers 504', async () => {
      spawnPlan = () => ({ listening: null });
      const r = await json(base, 'POST', '/api/worlds/hand-beta/serve', {});
      spawnPlan = () => ({});
      assert.deepEqual([r.status, r.body], [504, { error: { code: 'serve.timeout', message: 'worldplay serve for hand-beta reported no listening ports within 1500 ms, so the studio stopped it' } }]);
      assert.deepEqual(lastSpawn().handle.signals, ['SIGTERM']);
      assert.deepEqual((await json(base, 'GET', '/api/services')).body, { services: [] });
    });

    it('refuses an admin port that a tracked service holds as its world or admin port', async () => {
      spawnPlan = () => ({ listening: { world: 45100, admin: 45101 } });
      const first = await json(base, 'POST', '/api/worlds/hand-beta/serve', {});
      spawnPlan = () => ({});
      assert.equal(first.status, 200);
      const id = String(first.body['id']);
      try {
        for (const port of [45100, 45101, 45099]) {
          const r = await json(base, 'POST', '/api/worlds/gen-alpha/serve', { port });
          assert.deepEqual([r.status, r.body], [409, { error: { code: 'serve.port_taken', message: `port ${port} or its admin port ${port + 1} belongs to hand-beta (${id})` } }], String(port));
        }
      } finally {
        await json(base, 'POST', `/api/services/${id}/stop`);
      }
    });

    it('refuses a call to a service whose child has exited', async () => {
      const served = await json(base, 'POST', '/api/worlds/hand-beta/serve', {});
      assert.equal(served.status, 200);
      const id = String(served.body['id']);
      lastSpawn().handle.exitWith(0);
      await new Promise((resolve) => setImmediate(resolve));
      const r = await json(base, 'POST', `/api/services/${id}/call`, { method: 'GET', path: '/customers' });
      assert.deepEqual([r.status, errorOf(r.body)?.code], [404, 'service.unknown']);
    });

    it('SIGKILLs a child that lingers past SIGTERM, and says so', async () => {
      spawnPlan = () => ({ diesOn: ['SIGKILL'] });
      const r = await json(base, 'POST', '/api/worlds/gen-canary/serve', {});
      assert.equal(r.status, 200);
      const id = String(r.body['id']);
      const stop = await json(base, 'POST', `/api/services/${id}/stop`);
      assert.deepEqual(stop.body, { id, stopped: true, signal: 'SIGKILL' });
      assert.deepEqual(lastSpawn().handle.signals, ['SIGTERM', 'SIGKILL']);
      spawnPlan = () => ({});
    });

    it('refuses an unknown world, an unsafe name, an unknown service and a bad port', async () => {
      assert.equal((await json(base, 'POST', '/api/worlds/nope/serve', {})).status, 404);
      const unsafe = await json(base, 'POST', '/api/worlds/..%2Fetc/serve', {});
      assert.equal(unsafe.status, 400);
      assert.deepEqual(unsafe.body, { error: { code: 'world.name_unsafe', message: 'a world name must be one plain path segment' } });
      assert.equal((await json(base, 'POST', '/api/services/svc-999/stop')).status, 404);
      const port = await json(base, 'POST', '/api/worlds/hand-beta/serve', { port: 70000 });
      assert.equal(port.status, 400);
      assert.deepEqual(port.body, { error: { code: 'serve.port', message: 'port must be an integer from 1 to 65534 (the admin routes take port + 1)' } });
    });
  });

  describe('generation runs', () => {
    it('validates the request', async () => {
      const cases: readonly [unknown, string][] = [
        [{ kind: 'poem', text: 'x', outSlug: 'ok' }, 'generate.kind'],
        [{ kind: 'description', text: 'x', outSlug: 'Not_Kebab' }, 'generate.slug'],
        [{ kind: 'description', text: 'x' }, 'generate.slug'],
        [{ kind: 'description', text: '   ', outSlug: 'ok' }, 'generate.text'],
        [{ kind: 'openapi', text: '../../etc/hosts', outSlug: 'ok' }, 'generate.spec'],
        [{ kind: 'openapi', text: 'missing.openapi.yaml', outSlug: 'ok' }, 'generate.spec'],
        [{ kind: 'openapi', spec: 'orders.csv', outSlug: 'ok' }, 'generate.spec'],
        [{ kind: 'openapi', spec: 'petstore.openapi.yaml', only: ['/refunds'], outSlug: 'ok' }, 'generate.only'],
        [{ kind: 'openapi', spec: 'petstore.openapi.yaml', only: ['pet'], outSlug: 'ok' }, 'generate.only'],
        [{ kind: 'csv', files: [], outSlug: 'ok' }, 'generate.files'],
        [{ kind: 'csv', text: 'orders.csv petstore.openapi.yaml', outSlug: 'ok' }, 'generate.files'],
        [{ kind: 'csv', text: 'petstore.openapi.yaml', outSlug: 'ok', budgetUsd: 0 }, 'generate.budget'],
        [{ kind: 'description', text: 'x', outSlug: 'ok', maxMinutes: 1.5 }, 'generate.minutes'],
      ];
      for (const [body, code] of cases) {
        const r = await json(base, 'POST', '/api/generate', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(errorOf(r.body)?.code, code, JSON.stringify(r.body));
      }
    });

    it('spawns worldgen, reads its events while it runs, then answers the exit and totals', async () => {
      spawnPlan = () => ({
        onSpawn: (argv) => {
          const out = argv[argv.indexOf('--out') + 1];
          assert.ok(typeof out === 'string');
          const dir = path.join(out, 'runs', FAKE_RUN_ID);
          void mkdir(dir, { recursive: true }).then(() =>
            writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(E1)}\n${JSON.stringify(E2)}\n`));
        },
      });
      const post = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'A helpdesk with SLA tiers', outSlug: 'alpha' });
      assert.equal(post.status, 200);
      const runId = String(post.body['runId']);
      assert.match(runId, /^\d{8}T\d{6}Z-alpha-[0-9a-f]{6}$/);
      assert.equal(post.body['outDir'], path.join(worldsDir, 'gen-alpha'));
      assert.equal(post.body['running'], true);
      assert.deepEqual(lastSpawn().argv, ['bun', 'src/cli/worldgen.ts', 'A helpdesk with SLA tiers', '--out', path.join(worldsDir, 'gen-alpha')]);
      assert.equal(lastSpawn().cwd, path.join(root, 'code'));

      const live = await json(base, 'GET', `/api/generate/${runId}`);
      assert.equal(live.status, 200);
      assert.deepEqual(withoutJob(live.body), { running: true, state: 'running', events: [E1, E2], totals: null });
      assert.deepEqual((await json(base, 'GET', `/api/generate/${runId}/events`)).body, live.body);

      await writeFile(
        path.join(worldsDir, 'gen-alpha', 'runs', FAKE_RUN_ID, 'events.jsonl'),
        `${JSON.stringify(E1)}\n${JSON.stringify(E2)}\n${JSON.stringify(E3)}\n`,
      );
      lastSpawn().handle.exitWith(0);

      const done = await json(base, 'GET', `/api/generate/${runId}`);
      assert.deepEqual(withoutJob(done.body), { running: false, state: 'done', exitCode: 0, events: [E1, E2, E3], totals: { ms: 24000, costUsd: 0.51 } });
      spawnPlan = () => ({});
    });

    it('prefers the events file named by the studio run id over the one the child wrote', async () => {
      spawnPlan = () => ({
        onSpawn: (argv) => {
          const out = argv[argv.indexOf('--out') + 1];
          assert.ok(typeof out === 'string');
          const dir = path.join(out, 'runs', 'run_20261007T000000Z_other77');
          void mkdir(dir, { recursive: true }).then(() => writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(E2)}\n`));
        },
      });
      const post = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'literal' });
      const runId = String(post.body['runId']);
      const dir = path.join(worldsDir, 'gen-literal', 'runs', runId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(E1)}\n`);
      const r = await json(base, 'GET', `/api/generate/${runId}`);
      assert.deepEqual(withoutJob(r.body), { running: true, state: 'running', events: [E1], totals: null });
      spawnPlan = () => ({});
    });

    it('reads a running create run from <out>.partial, where it builds until done (A-293)', async () => {
      spawnPlan = () => ({
        onSpawn: (argv) => {
          const dir = path.join(`${String(argv[argv.indexOf('--out') + 1])}.partial`, 'runs', 'run_partial');
          void mkdir(dir, { recursive: true }).then(() => writeFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(E1)}\n${JSON.stringify(E2)}\n`));
        },
      });
      const post = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'partial-iota' });
      await new Promise((r) => setTimeout(r, 50));
      const r = await json(base, 'GET', `/api/generate/${String(post.body['runId'])}`);
      assert.deepEqual([r.body['state'], (r.body['events'] as unknown[]).length], ['running', 2]);
      const listed = (JSON.parse((await call(base, 'GET', '/api/worlds')).text) as { worlds: { name: string }[] }).worlds.map((w) => w.name);
      assert.equal(listed.includes('gen-partial-iota.partial'), false);
      lastSpawn().handle.exitWith(0);
      spawnPlan = () => ({});
    });

    it('passes its transport to every worldgen it starts, so a container can run on sdk (A-326)', async () => {
      const { spawner, spawned: calls } = fakeSpawner(() => ({}));
      const sdk = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }), transport: 'sdk' });
      try {
        const r = await json(sdk.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'sdk-kappa' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(calls[0]?.argv.slice(-2), ['--transport', 'sdk']);
      } finally {
        await sdk.close();
      }
    });

    it('passes the openapi and csv inputs and the budget flags through', async () => {
      const withFlags = await json(base, 'POST', '/api/generate', { kind: 'openapi', text: 'petstore.openapi.yaml', outSlug: 'pets', budgetUsd: 2, maxMinutes: 30 });
      assert.equal(withFlags.status, 200);
      assert.deepEqual(lastSpawn().argv, [
        'bun', 'src/cli/worldgen.ts', '--openapi', path.join(inputsDir, 'petstore.openapi.yaml'),
        '--out', path.join(worldsDir, 'gen-pets'), '--budget-usd', '2', '--max-minutes', '30',
      ]);
      const only = await json(base, 'POST', '/api/generate', { kind: 'openapi', spec: 'petstore.openapi.yaml', only: ['/pet', '/store'], outSlug: 'pets-only' });
      assert.equal(only.status, 200, JSON.stringify(only.body));
      assert.deepEqual(lastSpawn().argv, [
        'bun', 'src/cli/worldgen.ts', '--openapi', path.join(inputsDir, 'petstore.openapi.yaml'), '--only', '/pet,/store',
        '--out', path.join(worldsDir, 'gen-pets-only'),
      ]);
      const files = await json(base, 'POST', '/api/generate', { kind: 'csv', files: ['orders.csv', 'customers.csv'], outSlug: 'ords-files' });
      assert.equal(files.status, 200, JSON.stringify(files.body));
      assert.deepEqual(lastSpawn().argv.slice(2, 5), ['--csv', path.join(inputsDir, 'orders.csv'), path.join(inputsDir, 'customers.csv')]);
      const csv = await json(base, 'POST', '/api/generate', { kind: 'csv', text: 'orders.csv customers.csv', outSlug: 'ords' });
      assert.equal(csv.status, 200);
      assert.deepEqual(lastSpawn().argv, [
        'bun', 'src/cli/worldgen.ts', '--csv', path.join(inputsDir, 'orders.csv'), path.join(inputsDir, 'customers.csv'),
        '--out', path.join(worldsDir, 'gen-ords'),
      ]);
    });

    it('lists the inputs a generation can read, and the paths a spec declares for --only (A-312)', async () => {
      const r = await json(base, 'GET', '/api/inputs');
      assert.deepEqual(r.body, { openapi: ['petstore.openapi.yaml'], csv: ['customers.csv', 'orders.csv'] });
      const paths = await json(base, 'GET', '/api/inputs/petstore.openapi.yaml/paths');
      assert.deepEqual(paths.body, { spec: 'petstore.openapi.yaml', paths: ['/pet', '/store/order'] });
      const notSpec = await json(base, 'GET', '/api/inputs/orders.csv/paths');
      assert.deepEqual([notSpec.status, errorOf(notSpec.body)?.code], [400, 'generate.spec']);
    });

    it('says a run is stopped, with its reason, when it logs a stop; failed when it exits without run_finished (A-312)', async () => {
      const stopped = { ...E3, worldWritten: false, result: { kind: 'stopped', reason: { kind: 'cancelled' } } };
      const run = async (slug: string, events: readonly object[], code: number): Promise<Json> => {
        spawnPlan = () => ({
          onSpawn: (argv) => {
            const dir = path.join(String(argv[argv.indexOf('--out') + 1]), 'runs', FAKE_RUN_ID);
            void mkdir(dir, { recursive: true }).then(() => writeFile(path.join(dir, 'events.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join('')));
          },
        });
        const post = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: slug });
        await new Promise((r) => setTimeout(r, 50));
        lastSpawn().handle.exitWith(code);
        await new Promise((r) => setTimeout(r, 20));
        return (await json(base, 'GET', `/api/generate/${String(post.body['runId'])}`)).body;
      };
      const a = await run('state-stopped', [E1, stopped], 1);
      assert.deepEqual([a['state'], a['reason']], ['stopped', 'cancelled']);
      const b = await run('state-failed', [E1], 137);
      assert.deepEqual([b['state'], b['reason']], ['failed', 'the worldgen process exited 137 before it logged run_finished: exit 137']);
      spawnPlan = () => ({});
    });

    it('stop sends SIGINT, then SIGTERM when the child lingers', async () => {
      spawnPlan = () => ({ diesOn: ['SIGINT'] });
      const quick = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'stopint' });
      const quickId = String(quick.body['runId']);
      assert.deepEqual((await json(base, 'POST', `/api/generate/${quickId}/stop`)).body, { runId: quickId, stopped: true, signal: 'SIGINT' });
      assert.deepEqual(lastSpawn().handle.signals, ['SIGINT']);

      spawnPlan = () => ({ diesOn: ['SIGTERM'] });
      const slow = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'stopboth' });
      const slowId = String(slow.body['runId']);
      assert.deepEqual((await json(base, 'POST', `/api/generate/${slowId}/stop`)).body, { runId: slowId, stopped: true, signal: 'SIGTERM' });
      assert.deepEqual(lastSpawn().handle.signals, ['SIGINT', 'SIGTERM']);
      spawnPlan = () => ({});
    });

    it('refuses an unknown run and a finished run', async () => {
      assert.equal((await json(base, 'GET', '/api/generate/run-nope')).status, 404);
      assert.equal((await json(base, 'POST', '/api/generate/run-nope/stop')).status, 404);
      const finished = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'finished' });
      const id = String(finished.body['runId']);
      lastSpawn().handle.exitWith(0);
      await lastSpawn().handle.child.exited;
      const stop = await json(base, 'POST', `/api/generate/${id}/stop`);
      assert.equal(stop.status, 409);
      assert.deepEqual(stop.body, { error: { code: 'run.finished', message: `Run ${id} already finished` } });
    });
  });

  describe('eval', () => {
    it('lists the eval run dirs with their first summary lines', async () => {
      const r = await json(base, 'GET', '/api/eval');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        runs: [
          { dir: 'no-summary', summaryFirstLines: null },
          {
            dir: 'preview-only',
            summaryFirstLines: [
              '# Eval run preview-only',
              '',
              'A hand-written summary with no pass-rate line, so the list shows a preview only.',
              'Line three.',
              'Line four.',
              'Line five.',
              'Line six.',
              'Line seven.',
              'Line eight.',
              'Line nine.',
              'Line ten.',
              'Line eleven.',
            ],
          },
          {
            dir: 'run-2026-10-07-a',
            summaryFirstLines: [
              '# Eval run run-2026-10-07-a',
              '',
              'Suite `stress`, model `claude-sonnet-5-5`, budget $2.0000 and 12 min per run.',
              '',
              '| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |',
              '|---|---|---|---|---|--:|--:|---|---|---|',
              '| alpha | done | done | - | plan 1 | 1.0 | $0.2000 | pass: 3 tasks | ok | yes |',
              '',
              '**Totals:** 1 expected cases: 1 done, 0 stopped, 0 crashed, 0 missing, 0 invalid; 1.0 min; $0.2000; 0 unlogged.',
              '',
              '**Median and p95:** 1.0 min and 1.0 min; $0.2000 and $0.2000.',
              '',
              '**Pass rate:** 1/1 (100%).',
            ],
          },
        ],
      });
    });

    it('serves the whole summary.md of one eval run', async () => {
      const r = await json(base, 'GET', '/api/eval/run-2026-10-07-a');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { dir: 'run-2026-10-07-a', summary: SUMMARY_WITH_PASS });
      assert.equal((await json(base, 'GET', '/api/eval/nope')).status, 404);
      assert.equal((await json(base, 'GET', '/api/eval/no-summary')).status, 404);
    });
  });

  describe('spend', () => {
    it('pipes one costs --json --by day child, parsed, and caches it 30 s', async () => {
      const first = await json(base, 'GET', '/api/costs');
      assert.equal(first.status, 200);
      assert.deepEqual(first.body, COSTS_JSON);
      assert.deepEqual(costsCalls, [{ argv: ['bun', 'src/cli/costs.ts', '--json', '--by', 'day'], cwd: path.join(root, 'code') }]);
      const second = await json(base, 'GET', '/api/costs');
      assert.deepEqual(second.body, COSTS_JSON);
      assert.equal(costsCalls.length, 1);
    });
  });

  describe('unknown routes', () => {
    it('404s every unknown path and every /_world path', async () => {
      for (const [method, p] of [
        ['GET', '/nope'], ['GET', '/api'], ['GET', '/api/nope'],
        ['GET', '/_world'], ['GET', '/_world/state'], ['POST', '/_world/reset'], ['GET', '/_world/log'],
        ['POST', '/_world/grade/x'], ['GET', '/_world/openapi'],
      ] as const) {
        assert.equal((await call(base, method, p)).status, 404, `${method} ${p}`);
      }
    });

    it('405s a known path with the wrong method', async () => {
      assert.equal((await json(base, 'GET', '/api/generate')).status, 405);
      assert.equal((await json(base, 'GET', '/api/services/svc-1/stop')).status, 405);
      assert.equal((await json(base, 'POST', '/api/worlds')).status, 405);
    });
  });

  describe('the private boundary', () => {
    it('positive control: every canary is in its fixture world.yaml', async () => {
      assert.equal(canaries.length, 10);
      assert.equal(leakCanaries.length, 10);
      const alphaYaml = await readFile(path.join(worldsDir, 'gen-canary', 'world.yaml'), 'utf8');
      for (const c of canaries) assert.equal(alphaYaml.includes(c), true, c);
      const leakYaml = await readFile(path.join(worldsDir, 'gen-leak', 'world.yaml'), 'utf8');
      for (const c of leakCanaries) assert.equal(leakYaml.includes(c), true, c);
    });

    it('no canary reaches any /api response, or the page', async () => {
      spawnPlan = () => ({});
      const post = await json(base, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'canary' });
      const runId = String(post.body['runId']);
      const texts: string[] = [(await call(base, 'GET', '/')).text];
      for (const p of [
        '/api/worlds', '/api/worlds/gen-canary/report', '/api/worlds/gen-leak/report', '/api/services',
        '/api/worlds/gen-canary/explorer', '/api/worlds/gen-leak/explorer',
        `/api/generate/${runId}`, `/api/generate/${runId}/events`, '/api/runs', '/api/eval', '/api/eval/run-2026-10-07-a', '/api/costs',
      ]) {
        texts.push((await call(base, 'GET', p)).text);
      }
      for (const canary of [...canaries, ...leakCanaries]) {
        for (const text of texts) assert.equal(text.includes(canary), false, canary);
      }
    });
  });

  describe('a stopped generation', () => {
    it('is a run, not a world: its directory without world.yaml stays out of /api/worlds and shows in /api/runs', async () => {
      const dir = path.join(worldsDir, 'gen-stopped-zeta');
      await mkdir(path.join(dir, 'runs', 'run_stop'), { recursive: true });
      await writeFile(path.join(dir, 'REPORT.md'), '# Stopped\n\nStopped: cancelled\n');
      await writeFile(path.join(dir, 'runs', 'run_stop', 'events.jsonl'), `${JSON.stringify({ at: '2026-10-07T22:20:17.634Z', runId: 'run_stop', t: 'run_finished', ms: 1, costUsd: 0, worldWritten: false, result: { kind: 'stopped', reason: { kind: 'cancelled' } } })}\n`);
      try {
        const listed = (JSON.parse((await call(base, 'GET', '/api/worlds')).text) as { worlds: { name: string }[] }).worlds.map((w) => w.name);
        assert.equal(listed.includes('gen-stopped-zeta'), false);
        assert.match((await call(base, 'GET', '/api/runs')).text, /gen-stopped-zeta/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('export', () => {
    /** Entry names and bytes of a stored zip, read back from its local headers. */
    const entriesOf = (zip: Buffer): Record<string, string> => {
      const out: Record<string, string> = {};
      let at = 0;
      while (zip.readUInt32LE(at) === 0x04034b50) {
        const size = zip.readUInt32LE(at + 18);
        const nameLength = zip.readUInt16LE(at + 26);
        const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
        out[name] = zip.subarray(at + 30 + nameLength, at + 30 + nameLength + size).toString('utf8');
        at += 30 + nameLength + size;
      }
      return out;
    };

    it('zips the world files and nothing from runs/, as an attachment (A-280)', async () => {
      const dir = path.join(worldsDir, 'export-eta');
      await writeWorld(dir, minimalWorld());
      await writeFile(path.join(dir, 'REPORT.md'), '# export-eta\n');
      await mkdir(path.join(dir, 'runs', 'r1'), { recursive: true });
      await writeFile(path.join(dir, 'runs', 'r1', 'events.jsonl'), '{"key":"sk-ant-must-not-export"}\n');
      try {
        const res = await fetch(`${base}/api/worlds/export-eta/export`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/zip');
        assert.equal(res.headers.get('content-disposition'), 'attachment; filename="export-eta.zip"');
        const zip = Buffer.from(await res.arrayBuffer());
        const entries = entriesOf(zip);
        assert.deepEqual(Object.keys(entries), ['export-eta/world.yaml', 'export-eta/REPORT.md']);
        assert.equal(entries['export-eta/world.yaml'], await readFile(path.join(dir, 'world.yaml'), 'utf8'));
        assert.equal(entries['export-eta/REPORT.md'], '# export-eta\n');
        assert.equal(zip.includes('sk-ant-must-not-export'), false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses an unsafe name, an unknown world and a dir without world.yaml', async () => {
      assert.equal((await json(base, 'GET', '/api/worlds/a%5Cb/export')).status, 400);
      assert.equal((await json(base, 'GET', '/api/worlds/nowhere/export')).status, 404);
      const r = await json(base, 'GET', '/api/worlds/no-world-gamma/export');
      assert.deepEqual([r.status, errorOf(r.body)?.code], [404, 'export.no_world']);
    });
  });

  describe('the explorer', () => {
    it('describes a world definition: its wid, entities and references, routes, jobs, and tasks as an agent is told them', async () => {
      const r = await json(base, 'GET', '/api/worlds/hand-beta/explorer');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const report = checkWorld(minimalWorld());
      assert.ok(report.ok);
      assert.equal(r.body['wid'], worldIdOf(report.world));
      const entities = r.body['entities'] as Json[];
      assert.deepEqual(entities.map((e) => [e['name'], e['refersTo'], e['referencedBy']]), [['customer', [], ['ticket.customer']], ['ticket', ['customer'], []]]);
      const routes = r.body['routes'] as Json[];
      assert.equal(routes.length, Object.keys(report.world.routes).length + Object.keys(report.world.actions).length);
      assert.ok(routes.some((x) => x['kind'] === 'list' && x['method'] === 'GET' && x['path'] === '/customers'));
      assert.ok(routes.some((x) => x['kind'] === 'action' && x['path'] === '/tickets/{id}/resolve'));
      const tasks = r.body['tasks'] as Json[];
      assert.deepEqual(tasks.map((t) => Object.keys(t)), tasks.map(() => ['id', 'tid', 'difficulty', 'instruction']));
      assert.deepEqual(tasks.map((t) => [t['id'], t['difficulty'], t['instruction']]), Object.entries(report.world.tasks).map(([id, t]) => [id, t.difficulty, t.instruction]));
    });

    it('keeps an explored world until its world.yaml changes, then explores the new one', async () => {
      const dir = path.join(worldsDir, 'cache-epsilon');
      await writeWorld(dir, minimalWorld());
      const first = await json(base, 'GET', '/api/worlds/cache-epsilon/explorer');
      assert.deepEqual((await json(base, 'GET', '/api/worlds/cache-epsilon/explorer')).body, first.body);
      const changed = structuredClone(minimalWorld()) as unknown as { meta: { description: string } };
      changed.meta.description = 'A changed helpdesk.';
      await writeWorld(dir, changed as unknown as World);
      const after = await json(base, 'GET', '/api/worlds/cache-epsilon/explorer');
      assert.equal(after.status, 200);
      assert.notEqual(after.body['wid'], first.body['wid']);
      await rm(dir, { recursive: true, force: true });
    });

    it('positive control: the canary world is explored, and the canary test above reads it', async () => {
      assert.equal((await json(base, 'GET', '/api/worlds/gen-canary/explorer')).status, 200);
    });

    it('refuses a world that does not load, an unsafe name and an unknown world', async () => {
      const broken = await json(base, 'GET', '/api/worlds/no-world-gamma/explorer');
      assert.deepEqual([broken.status, errorOf(broken.body)?.code], [422, 'world.invalid']);
      assert.equal((await json(base, 'GET', '/api/worlds/a%5Cb/explorer')).status, 400);
      assert.equal((await json(base, 'GET', '/api/worlds/nowhere/explorer')).status, 404);
    });
  });

  describe('the API console', () => {
    let world: WorldServer;
    let svc = '';
    let seedHash = '';
    const direct = async (method: string, p: string, body?: unknown): Promise<{ status: number; text: string }> => {
      const res = await fetch(`${world.url}${p}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      return { status: res.status, text: await res.text() };
    };
    const send = (request: Json): Promise<{ status: number; type: string | null; body: Json }> => json(base, 'POST', `/api/services/${svc}/call`, request);

    before(async () => {
      const report = checkWorld(minimalWorld());
      assert.ok(report.ok);
      await writeWorld(path.join(worldsDir, 'console-delta'), minimalWorld());
      world = await serve(report.world, { port: 0 });
      seedHash = String(((await (await fetch(`${world.adminUrl}/_world/state`)).json()) as Json)['hash']);
      spawnPlan = () => ({ listening: { world: world.port, admin: world.adminPort } });
      const served = await json(base, 'POST', '/api/worlds/console-delta/serve', {});
      spawnPlan = () => ({});
      assert.equal(served.status, 200, JSON.stringify(served.body));
      svc = String(served.body['id']);
    });
    after(async () => {
      await json(base, 'POST', `/api/services/${svc}/stop`);
      await world.close();
    });

    it('sends a real request to the world port and answers the world\'s own status and body', async () => {
      const r = await send({ method: 'GET', path: '/customers' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const want = await direct('GET', '/customers');
      assert.deepEqual([r.body['status'], r.body['body'], r.body['world'], r.body['worldPort']], [want.status, want.text, 'console-delta', world.port]);
      assert.deepEqual(r.body['request'], { method: 'GET', path: '/customers', body: null });
      assert.equal(want.status, 200);
    });

    it('passes a refused write through as the world\'s real refusal, and the world state stays put', async () => {
      const before = await direct('GET', '/customers');
      const r = await send({ method: 'POST', path: '/customers', body: { tier: 'not-a-tier' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(typeof r.body['status'], 'number');
      assert.ok((r.body['status'] as number) >= 400 && (r.body['status'] as number) < 500, String(r.body['status']));
      assert.match(String(r.body['body']), /"error"/);
      assert.equal((await direct('GET', '/customers')).text, before.text);
    });

    it('never calls the admin port: /_world paths, other origins and escapes are refused before any request', async () => {
      for (const p of ['/_world/state', '/_world', '/%5Fworld/reset', '/_world/grade/x']) {
        const r = await send({ method: 'GET', path: p });
        assert.deepEqual([r.status, errorOf(r.body)?.code], [403, 'call.admin_path'], p);
      }
      for (const p of [`http://127.0.0.1:${world.adminPort}/_world/state`, `//127.0.0.1:${world.adminPort}/_world/state`, 'customers', '/\\evil']) {
        const r = await send({ method: 'GET', path: p });
        assert.deepEqual([r.status, errorOf(r.body)?.code], [400, 'call.path'], p);
      }
    });

    it('resets the served world to its seed only once its name is typed, and answers the time and the state hash (A-357)', async () => {
      const reset = (body?: unknown) => json(base, 'POST', `/api/services/${svc}/reset`, body);
      const refusal = { error: { code: 'reset.confirm', message: 'a reset throws away every change to console-delta\'s state; send {"confirm": "console-delta"} to go ahead' } };
      for (const body of [undefined, {}, { confirm: 'console' }, { confirm: 'CONSOLE-DELTA' }]) {
        const r = await reset(body);
        assert.deepEqual([r.status, r.body], [400, refusal], JSON.stringify(body));
      }
      const wrote = await send({ method: 'POST', path: '/customers', body: { name: 'Reset Co', tier: 'free' } });
      assert.equal(wrote.body['status'], 201, JSON.stringify(wrote.body));
      const state = async (): Promise<unknown> => ((await (await fetch(`${world.adminUrl}/_world/state`)).json()) as Json)['hash'];
      assert.notEqual(await state(), seedHash);
      const r = await reset({ confirm: 'console-delta' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body['service'], r.body['world'], r.body['hash'], typeof r.body['now']], [svc, 'console-delta', seedHash, 'string']);
      assert.equal(await state(), seedHash);
      assert.equal((await direct('GET', '/customers')).text.includes('Reset Co'), false);
    });

    it('validates the method and the body, and 404s an unknown service', async () => {
      assert.equal(errorOf((await send({ method: 'TRACE', path: '/customers' })).body)?.code, 'call.method');
      assert.equal(errorOf((await send({ method: 'GET', path: '/customers', body: {} })).body)?.code, 'call.body');
      assert.equal(errorOf((await json(base, 'POST', `/api/services/${svc}/call`, 'GET /customers')).body)?.code, 'call.body');
      assert.equal((await json(base, 'POST', '/api/services/svc-none/call', { method: 'GET', path: '/customers' })).status, 404);
    });

    it('answers a real 502 at once when nothing listens on the world port, never a made-up success', async () => {
      // The world port is one no port-0 bind can be handed (YOS-105), so nothing listens there for this test's life.
      const port = await quietPort();
      spawnPlan = () => ({ listening: { world: port, admin: port + 1 } });
      const served = await json(base, 'POST', '/api/worlds/hand-beta/serve', {});
      spawnPlan = () => ({});
      assert.equal(served.status, 200, JSON.stringify(served.body));
      const id = String(served.body['id']);
      try {
        const r = await json(base, 'POST', `/api/services/${id}/call`, { method: 'GET', path: '/customers' });
        assert.deepEqual([r.status, errorOf(r.body)?.code], [502, 'call.unreachable']);
      } finally {
        await json(base, 'POST', `/api/services/${id}/stop`);
      }
    });
  });
});

describe('the Explorer check child shows each state machine and the seed counts (A-357)', () => {
  it('on the hand-built helpdesk', () => {
    const r = spawnSync('bun', ['src/cli/studio-check.ts', path.resolve(REAL_CODE_DIR, '../prod/worlds/helpdesk'), 'helpdesk'], { cwd: REAL_CODE_DIR, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const x = JSON.parse(r.stdout) as Json;
    assert.deepEqual(x['machines'], [{
      entity: 'ticket', field: 'status', states: ['new', 'open', 'pending', 'escalated', 'resolved', 'closed'], initial: 'new',
      transitions: { new: ['open', 'escalated'], open: ['pending', 'escalated', 'resolved'], pending: ['open', 'escalated', 'resolved'], escalated: ['resolved'], resolved: ['open', 'closed'], closed: [] },
    }]);
    assert.deepEqual(x['seed'], {
      rows: { customer: 60, agent: 12, sla_policy: 12, oncall_shift: 39, ticket: 320, ticket_comment: 229, ticket_event: 1033 },
      states: { 'ticket.status': { new: 30, open: 90, pending: 30, escalated: 40, resolved: 85, closed: 45 } },
    });
  });
});

describe('studio serve: only an admin pins a port (A-348)', () => {
  it('serves an operator on port 0 whatever port the body names, and records the reported ports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-serve-'));
    const worldsDir = path.join(root, 'prod', 'worlds');
    await writeWorld(path.join(worldsDir, 'w'), minimalWorld());
    const { spawner, spawned } = fakeSpawner(() => ({ listening: { world: 45300, admin: 45301 } }));
    const runner: Runner = async () => ({ code: 0, stdout: '{}', stderr: '' });
    // sha256 of 'operator-token-o1'.
    const users = [{ name: 'olga', role: 'operator' as const, tenant: 'default', tokenSha256: '0d8dc9deab36314a0e348de096f11795a300d35258412ffe048c9eecdabb8edd' }];
    const s = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, users, serveWaitMs: 1500 });
    try {
      const res = await fetch(`${s.url}/api/worlds/w/serve`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer operator-token-o1' }, body: JSON.stringify({ port: 4321 }),
      });
      const body = await res.json() as Json;
      assert.deepEqual([res.status, body['worldPort'], body['adminPort']], [200, 45300, 45301]);
      assert.deepEqual(spawned[0]?.argv.slice(-2), ['--port', '0']);
    } finally {
      await s.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('studio runs across a restart (YOS-191, A-329)', () => {
  const runner: Runner = async () => ({ code: 0, stdout: '{}', stderr: '' });
  let root = '';
  let worldsDir = '';
  const live = new Set<number>();
  const signals: [number, string][] = [];
  const processes = {
    alive: (pid: number) => live.has(pid),
    kill: (pid: number, signal: NodeJS.Signals) => {
      signals.push([pid, signal]);
      return live.has(pid);
    },
  };
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-restart-'));
    worldsDir = path.join(root, 'prod', 'worlds');
    await mkdir(path.join(root, 'code'), { recursive: true });
    await mkdir(worldsDir, { recursive: true });
  });
  after(async () => rm(root, { recursive: true, force: true }));

  it('adopts a run whose process outlived the studio, stops it by pid, and marks a dead one interrupted without rerunning it', async () => {
    const first = fakeSpawner(() => ({ pid: 7777, diesOn: [] }));
    const a = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: first.spawner, runner, processes });
    const started = await json(a.url, 'POST', '/api/generate', { kind: 'description', text: 'T', outSlug: 'restart-lambda' });
    const runId = String(started.body['runId']);
    live.add(7777);
    const stored = JSON.parse(await readFile(path.join(worldsDir, '.studio-runs.json'), 'utf8')) as { runId: string; pid: number; phase: string }[];
    assert.deepEqual(stored.map((r) => [r.runId, r.pid, r.phase]), [[runId, 7777, 'running']]);

    // The studio dies without its children ending; a new one starts on the same data once its lease has run out (A-335).
    await a.close();
    const second = fakeSpawner(() => ({}));
    const b = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: second.spawner, runner, processes, runStopWaitMs: 50, now: () => Date.now() + 60_000 });
    try {
      assert.equal((await json(b.url, 'GET', `/api/generate/${runId}`)).body['running'], true);
      const stopped = await json(b.url, 'POST', `/api/generate/${runId}/stop`);
      assert.equal(stopped.status, 200);
      assert.deepEqual(signals[0], [7777, 'SIGINT']);
      assert.equal(second.spawned.length, 0);
    } finally {
      live.delete(7777);
      await b.close();
    }

    const c = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: second.spawner, runner, processes, runStopWaitMs: 50, now: () => Date.now() + 120_000 });
    try {
      const r = await json(c.url, 'GET', `/api/generate/${runId}`);
      assert.deepEqual([r.body['running'], r.body['state']], [false, 'interrupted']);
      assert.equal(second.spawned.length, 0);
    } finally {
      await c.close();
    }
  });
});

describe('studio page accessibility (YOS-187)', () => {
  const html = studioPage();
  const tags = (name: string): { tag: string; at: number }[] =>
    [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => ({ tag: m[0], at: m.index ?? 0 }));
  const labelledFor = new Set([...html.matchAll(/<label\s+for="([^"]+)"/g)].map((m) => m[1]));
  const insideLabel = (at: number): boolean => {
    const open = html.lastIndexOf('<label', at);
    return open !== -1 && html.lastIndexOf('</label>', at) < open && html.indexOf('</label>', at) !== -1;
  };

  it('names every input, select and textarea', () => {
    const controls = [...tags('input'), ...tags('select'), ...tags('textarea')];
    assert.equal(controls.length, 18);
    const unnamed = controls.filter((c) => {
      const id = /\bid="([^"]+)"/.exec(c.tag)?.[1];
      return !c.tag.includes('aria-label=') && !(id !== undefined && labelledFor.has(id)) && !insideLabel(c.at);
    });
    assert.deepEqual(unnamed.map((c) => c.tag), []);
    assert.equal(html.includes('<input id="worlds-filter" type="search"'), true);
  });

  it('has one header, one main, a nav, and an h2 in every section', () => {
    assert.equal(tags('header').length, 1);
    assert.equal(tags('main').length, 1);
    assert.equal(tags('nav').length, 1);
    const sections = tags('section');
    assert.equal(sections.length, 6);
    const mainEnd = html.indexOf('</main>');
    sections.forEach((s, i) => {
      const end = Math.min(sections[i + 1]?.at ?? mainEnd, mainEnd);
      assert.equal(html.slice(s.at, end).includes('<h2'), true, s.tag);
      assert.equal(html.includes(`href="#${/id="([^"]+)"/.exec(s.tag)?.[1]}"`), true, s.tag);
    });
  });

  it('gives every script-created input, select and textarea an aria-label', () => {
    const created = [...html.matchAll(/createElement\('(input|select|textarea)'\)/g)];
    assert.equal(created.length, 1);
    assert.equal((html.match(/\.setAttribute\('aria-label'/g) ?? []).length, 1);
  });
});
