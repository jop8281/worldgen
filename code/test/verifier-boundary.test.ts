/**
 * The private verifier process and the public-only world bundle (YOS-159, A-224).
 *
 * What this file proves:
 * - The split (engine/split.ts): the public form of a world keeps every task's id, difficulty and
 *   instruction and drops grader, solution, decoys and alternative source, checks as a world,
 *   serves the same OpenAPI and the same seed, and a world that mixes complete and bare tasks is
 *   refused (`tasks.private_mixed`), so a public bundle can never carry half-private source.
 * - The bundle (sandboxes/files.ts publicOnly + dataset/pipeline.ts prepareWorld): the uploaded
 *   workspace holds the public form alone; the private world stays on the trusted side.
 * - The verifier protocol (engine/verify.ts): a trace recorded over the PUBLIC world's own port
 *   replays to its final state and grades 1 against the PRIVATE world; unknown ids, identity
 *   mismatches, and mutated, replayed and oversized inputs are rejected with literal stops; no
 *   verdict or rejection carries grader source.
 * - The verifier child (cli/verifier.ts through dataset/verifier.ts childGrader): one bounded
 *   verdict per submission, a replayed submission refused through the ledger, a malformed request
 *   answered as a rejection with exit 0, a crashed or overrunning verifier a failed grade with an
 *   authored reason, and a spawn that carries no controller credential.
 * - The public-serving process exposes no grading authority: every /_world path on the world port
 *   is an ordinary 404 that changes nothing, the admin port has no verifier route, and its grade
 *   route cannot score a public world.
 *
 * What this file does NOT claim: OS-level isolation of the host processes. The verifier child is a
 * separate host process with the private world by path and a clean environment, which is the
 * prototype's declared deployment control; a container, a separate VM or a separate OS user is the
 * separately qualified follow-up. Port separation alone does not prove process isolation.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  chainOf, checkWorld, createRuntime, gradeDump, loadWorld, openApiOf, publicWorldOf, renderWorldYaml, serve, taskPrivacy,
  traceOf, verifySubmission, worldIdOf, VERIFIER_LIMITS,
  type CheckedWorld, type StateDump, type TraceCall, type WorldServer,
} from '#engine';
import { collectBundle } from '../src/sandboxes/files.ts';
import { nodeRunner, type Runner } from '../src/sandboxes/backend.ts';
import { prepareWorld, runPipeline, type PreparedWorld } from '../src/dataset/pipeline.ts';
import { childGrader, type GraderWorld } from '../src/dataset/verifier.ts';
import { checkedForTest, minimalWorld } from './helpers/world.ts';
import { COMMIT, EASY, HELPDESK_DIR, fakeBackend, randomPort, solveAll, tmp } from './dataset-kit.ts';
import type { World } from '../src/engine/format.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');

// ---- Private-source fragments, as test/private-boundary.test.ts scans them ----------------------

/** Every private snippet of a world: graders, solutions, decoys and alternatives (scripts and whys). */
function privateSources(world: World): string[] {
  return Object.values(world.tasks)
    .flatMap((t) => [t.grader, t.solution, ...t.decoys.flatMap((d) => [d.script, d.why]), ...t.alternatives.flatMap((a) => [a.script, a.why])])
    .filter((s): s is string => s !== undefined);
}

const WINDOW = 40;
const STEP = 20;

/**
 * Fixed-width windows of every private source, at every step, that the text the public form
 * legitimately holds (everything but the private task material) does not already contain.
 */
function fragmentsOf(sources: readonly string[], served: string): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    const last = Math.max(src.length - WINDOW, 0);
    const starts = new Set<number>([last]);
    for (let i = 0; i < last; i += STEP) starts.add(i);
    for (const i of starts) {
      const w = src.slice(i, i + WINDOW);
      if (w.trim().length >= 24 && !/["\\\u0000-\u001f]/.test(w) && !served.includes(w)) found.add(w);
    }
  }
  return [...found];
}

/** The private fragments that must never appear in anything public for this world. */
function forbiddenOf(world: World): string[] {
  return fragmentsOf(privateSources(world), JSON.stringify({ ...world, tasks: {} }));
}

let prepared: PreparedWorld | undefined;
/** The golden helpdesk prepared once: frozen private world, public form, WID and world version. */
async function preparedOnce(): Promise<PreparedWorld> {
  return (prepared ??= await prepareWorld(HELPDESK_DIR, tmp('verifier-boundary')));
}

/** The golden helpdesk, checked once. */
async function checkedHelpdesk(): Promise<CheckedWorld> {
  const loaded = await loadWorld(HELPDESK_DIR);
  if (!loaded.ok) assert.fail(JSON.stringify(loaded.error));
  const report = checkWorld(loaded.value);
  if (!report.ok) assert.fail(JSON.stringify(report.issues));
  return report.world;
}

const heldOf = (prep: PreparedWorld): GraderWorld => ({
  world: prep.world, wid: prep.wid, worldVersion: prep.worldVersion, frozenDir: prep.frozenDir, engine: COMMIT,
});

/** A recorded run of the easy task, driven over the world port of the served PUBLIC form. */
type Recorded = { readonly trace: readonly TraceCall[]; readonly state: StateDump };

async function servePublic(world: CheckedWorld): Promise<WorldServer> {
  const form = checkWorld(publicWorldOf(world));
  if (!form.ok) assert.fail(`the public form does not check: ${form.issues[0]?.code}`);
  return serve(form.world, { port: 0 });
}

type Seen = { readonly status: number; readonly body: any };

async function recordEasyOverPublic(world: CheckedWorld): Promise<{ server: WorldServer; recorded: Recorded }> {
  const server = await servePublic(world);
  const send = async (method: string, target: string, body?: unknown): Promise<Seen> => {
    const res = await fetch(`${server.url}${target}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    return { status: res.status, body: await res.json() };
  };
  const admin = async (method: string, route: string): Promise<any> => (await fetch(`${server.adminUrl}${route}`, { method })).json();
  try {
    const acme = (await send('GET', '/customers?q=Acme')).body.data.find((c: { name: string }) => c.name === 'Acme Logistics');
    const newest = (await send('GET', `/tickets?customer_id=${acme.id}&status=new&sort=-created_at&limit=1`)).body.data[0];
    const priya = (await send('GET', '/agents?q=Priya Raman')).body.data.find((a: { name: string }) => a.name === 'Priya Raman');
    assert.equal((await send('POST', `/tickets/${newest.id}/assign`, { agent_id: priya.id })).status, 200);
    const log = await admin('GET', '/_world/log');
    const state = await admin('GET', '/_world/state');
    return { server, recorded: { trace: traceOf(log.calls), state } };
  } finally {
    await server.close();
  }
}

// ---- The split -----------------------------------------------------------------------------------

describe('the public/private split', () => {
  it('publicWorldOf drops grader, solution, decoys and alternatives, keeps the rest, and changes the WID', async () => {
    const world = await checkedHelpdesk();
    const form = publicWorldOf(world);
    assert.deepEqual(Object.keys(form.tasks), Object.keys(world.tasks));
    for (const [id, task] of Object.entries(form.tasks)) {
      assert.deepEqual(task, { difficulty: world.tasks[id]?.difficulty, instruction: world.tasks[id]?.instruction, decoys: [], alternatives: [] });
    }
    assert.deepEqual({ ...form, tasks: {} }, { ...world, tasks: {} });
    assert.equal(taskPrivacy(world), 'private');
    assert.equal(taskPrivacy(form), 'public');
    assert.notEqual(worldIdOf(form), worldIdOf(world));
  });

  it('the public form checks as a world, holds no verdicts, and serves the same OpenAPI and seed', async () => {
    const world = await checkedHelpdesk();
    const report = checkWorld(publicWorldOf(world));
    if (!report.ok) assert.fail(JSON.stringify(report.issues));
    assert.deepEqual(report.verdicts, {});
    assert.deepEqual(openApiOf(report.world), openApiOf(world));
    assert.deepEqual(createRuntime(report.world).dump(), createRuntime(world).dump());
  });

  it('the rendered public form and the uploaded public bundle carry no window of any private source', async () => {
    const world = await checkedHelpdesk();
    const forbidden = forbiddenOf(world);
    assert.equal(forbidden.length > 0, true, 'the scanner found no private windows, so this scan is vacuous');
    const form = checkWorld(publicWorldOf(world));
    if (!form.ok) assert.fail(JSON.stringify(form.issues));
    const text = renderWorldYaml(form.world);
    assert.deepEqual(forbidden.filter((f) => text.includes(f)), [], 'the public form leaked private source');
    assert.equal(renderWorldYaml(world).includes(forbidden[0] ?? ''), true, 'self-check: the private world holds the fragment');

    const prep = await preparedOnce();
    const bundle = await collectBundle(CODE_DIR, prep.frozenDir, { publicOnly: true });
    assert.equal(bundle.world, `worlds/${prep.worldVersion}`);
    assert.deepEqual(bundle.files.filter((f) => f.path.startsWith('worlds/')).map((f) => f.path), [`worlds/${prep.worldVersion}/world.yaml`]);
    assert.equal(
      Buffer.from(bundle.files.find((f) => f.path.startsWith('worlds/'))?.data ?? '').toString('utf8'),
      readFileSync(path.join(prep.publicDir, 'world.yaml'), 'utf8'),
    );
    for (const file of bundle.files) {
      const body = Buffer.from(file.data).toString('utf8');
      for (const fragment of forbiddenOf(prep.world)) assert.equal(body.includes(fragment), false, `${file.path} leaked private source`);
    }
    // The private world stays on the trusted side, beside the public form the bundle takes.
    assert.equal(existsSync(path.join(prep.frozenDir, 'world.yaml')), true);
    assert.equal(readFileSync(path.join(prep.frozenDir, 'world.yaml'), 'utf8').includes(forbidden[0] ?? ''), true);
  });

  it('a world that mixes complete and bare tasks is refused with tasks.private_mixed', () => {
    const mixed = minimalWorld({ tasks: { resolve_initech_pending: { grader: null, solution: null } } });
    const report = checkWorld(mixed);
    if (report.ok) assert.fail('a mixed world checked');
    assert.deepEqual([report.issues[0]?.code, report.issues[0]?.path, report.issues[0]?.found], ['tasks.private_mixed', ['tasks'], '2 complete, 1 instruction-only']);
  });

  it('a world whose every task is bare is the public form: it checks, and a bare task cannot be graded', () => {
    const world = minimalWorld();
    const report = checkWorld(publicWorldOf(checkedForTest(world)));
    if (!report.ok) assert.fail(JSON.stringify(report.issues));
    assert.deepEqual(report.verdicts, {});
    const graded = gradeDump(report.world, 'resolve_password_ticket', createRuntime(report.world).dump());
    assert.deepEqual(graded.ok ? null : [graded.issue.code, graded.issue.path], ['task.instruction_only', ['tasks', 'resolve_password_ticket']]);
    assert.throws(() => createRuntime(report.world).grade('resolve_password_ticket'), /task\.instruction_only/);
    assert.throws(() => createRuntime(report.world).grade('nope'), /ref\.unknown/);
  });
});

// ---- The verifier protocol ------------------------------------------------------------------------

describe('the verifier protocol against the private world', () => {
  let prep: PreparedWorld;
  let recorded: Recorded;
  const verdicts: unknown[] = [];

  before(async () => {
    prep = await preparedOnce();
    recorded = (await recordEasyOverPublic(prep.world)).recorded;
  });

  const requestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    protocol: 1, submission: 'sub-1', task: EASY, wid: prep.wid, worldVersion: prep.worldVersion, engine: COMMIT,
    trace: recorded.trace, chain: chainOf(recorded.trace), state: recorded.state, ...over,
  });
  const verify = (request: unknown, seen: ReadonlySet<string> = new Set<string>()) => {
    const held = { wid: prep.wid, worldVersion: prep.worldVersion, engine: COMMIT };
    const result = verifySubmission(prep.world, held, JSON.stringify(request), seen);
    verdicts.push(result.verdict);
    return result;
  };

  it('a trace recorded over the public port grades 1 against the private world, and doing nothing grades 0', async () => {
    const { verdict, ledger } = verify(requestOf());
    assert.deepEqual(verdict, { task: EASY, wid: prep.wid, score: 1, stop: 'graded' });
    assert.equal(ledger, 'sub-1');
    const seed = createRuntime(prep.world).dump();
    const noop = verify(requestOf({ trace: [], chain: chainOf([]), state: seed }));
    assert.deepEqual(noop.verdict, { task: EASY, wid: prep.wid, score: 0, stop: 'graded' });
    assert.equal(noop.ledger, 'sub-1');
  });

  it('rejects unknown task ids and identity mismatches with literal stops, burning the submission', () => {
    const table: readonly [string, Record<string, unknown>, string][] = [
      ['task.unknown', { task: 'no_such_task' }, 'no_such_task'],
      ['world.mismatch', { wid: `wid_${'0'.repeat(64)}` }, EASY],
      ['world.mismatch', { worldVersion: '0'.repeat(64) }, EASY],
      ['engine.mismatch', { engine: 'b'.repeat(40) }, EASY],
    ];
    for (const [stop, over, task] of table) {
      const { verdict, ledger } = verify(requestOf(over));
      assert.deepEqual(verdict, { task, wid: prep.wid, score: null, stop }, stop);
      assert.equal(ledger, 'sub-1');
    }
  });

  it('rejects a mutated trace: with its chain stale, and re-chained when the replay no longer matches', () => {
    const tampered = recorded.trace.map((c, i) => (i === recorded.trace.length - 1 ? { ...c, body: { agent_id: 'agt_0002' } } : c));
    assert.deepEqual(verify(requestOf({ trace: tampered })).verdict, { task: EASY, wid: prep.wid, score: null, stop: 'trace.chain' });
    assert.equal(verify(requestOf({ trace: tampered, chain: chainOf(tampered) })).verdict.stop, 'trace.mismatch');
    const dropped = recorded.trace.slice(0, -1);
    assert.equal(verify(requestOf({ trace: dropped, chain: chainOf(dropped) })).verdict.stop, 'trace.mismatch');
    const wrongStatus = recorded.trace.map((c, i) => (i === 0 ? { ...c, status: 404 } : c));
    assert.equal(verify(requestOf({ trace: wrongStatus, chain: chainOf(wrongStatus) })).verdict.stop, 'trace.mismatch');
  });

  it('rejects a replayed submission, an oversized request and a malformed one', () => {
    const replay = verify(requestOf(), new Set(['sub-1']));
    assert.deepEqual(replay.verdict, { task: EASY, wid: prep.wid, score: null, stop: 'trace.replayed' });
    assert.equal(replay.ledger, null);
    const padded = [...recorded.trace, ...Array.from({ length: VERIFIER_LIMITS.maxTraceCalls }, (_, i) => ({ ...recorded.trace[0], seq: i + 2 }))];
    assert.equal(verify(requestOf({ trace: padded, chain: chainOf(padded) })).verdict.stop, 'request.too_large');
    assert.equal(verify('.'.repeat(VERIFIER_LIMITS.maxRequestChars + 1)).verdict.stop, 'request.too_large');
    assert.equal(verify('not json').verdict.stop, 'request.invalid');
    assert.equal(verify(requestOf({ protocol: 2 })).verdict.stop, 'request.invalid');
    const { state, ...withoutState } = requestOf();
    assert.equal(state !== undefined, true, 'fixture error: the request lost its state');
    assert.equal(verify(withoutState).verdict.stop, 'request.invalid');
    const tamperedState = structuredClone(recorded.state);
    (tamperedState as { now?: string }).now = '2027-01-01T00:00:00.000Z';
    assert.equal(verify(requestOf({ state: tamperedState })).verdict.stop, 'trace.mismatch');
  });

  it('a grader that faults on the claimed state is a private grade.failed, never a crash or a leak', () => {
    const grader = `(ctx) => {
      const t = ctx.db.list('ticket', { where: { subject: 'Password reset loop' } })[0];
      if (!t) throw new Error('the graded run deleted the target ticket');
      return ctx.changes().every((c) => c.id === t.id && c.fields.every((f) => f === 'status')) ? (t.status === 'resolved' ? 1 : 0) : 0.5;
    }`;
    const report = checkWorld(minimalWorld({ tasks: { resolve_password_ticket: { grader } } }));
    if (!report.ok) assert.fail(JSON.stringify(report.issues));
    const rt = createRuntime(report.world);
    assert.equal(rt.call({ method: 'DELETE', path: '/tickets/tkt_0002', query: {}, body: undefined }).status, 204);
    const heldHere = { wid: worldIdOf(report.world), worldVersion: 'a'.repeat(64), engine: COMMIT };
    const request = {
      protocol: 1, submission: 'sub-failed', task: 'resolve_password_ticket', ...heldHere,
      trace: traceOf(rt.log()), chain: chainOf(traceOf(rt.log())), state: rt.dump(),
    };
    const { verdict } = verifySubmission(report.world, heldHere, JSON.stringify(request), new Set());
    assert.deepEqual(verdict, { task: 'resolve_password_ticket', wid: heldHere.wid, score: null, stop: 'grade.failed' });
    verdicts.push(verdict);
  });

  it('no verdict or rejection carries grader source', async () => {
    assert.equal(verdicts.length >= 12, true, 'the earlier tests recorded no verdicts to scan');
    const forbidden = forbiddenOf(prep.world);
    for (const verdict of verdicts) {
      for (const fragment of forbidden) assert.equal(JSON.stringify(verdict).includes(fragment), false, JSON.stringify(verdict));
    }
  });
});

// ---- The verifier child process -------------------------------------------------------------------

describe('the verifier child process', () => {
  let prep: PreparedWorld;
  let recorded: Recorded;

  before(async () => {
    prep = await preparedOnce();
    recorded = (await recordEasyOverPublic(prep.world)).recorded;
  });

  const tsx = path.join(CODE_DIR, 'node_modules', '.bin', 'tsx');
  const submission = (task: string, trace: readonly TraceCall[], state: StateDump) => ({ submission: task, task: EASY, trace, state });

  it('one child grades a recorded trace, records the submission, and keeps the evidence private', async () => {
    const out = tmp('verify-child');
    const grade = childGrader({ codeDir: CODE_DIR, out, runner: nodeRunner })(heldOf(prep));
    assert.deepEqual(await grade(submission('child-1', recorded.trace, recorded.state)), { ok: true, score: 1 });
    const requestFile = path.join(out, 'private', 'verifier', 'requests', 'child-1.json');
    assert.equal(existsSync(requestFile), true);
    assert.equal(statSync(requestFile).mode & 0o777, 0o600);
    const request = JSON.parse(readFileSync(requestFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual([request.wid, request.worldVersion, request.engine, request.task], [prep.wid, prep.worldVersion, COMMIT, EASY]);
    assert.equal(readFileSync(path.join(out, 'private', 'verifier', 'submissions.jsonl'), 'utf8'), '{"submission":"child-1"}\n');
  });

  it('a submission graded once cannot be graded again through the run ledger', async () => {
    const out = tmp('verify-child-replay');
    const grade = childGrader({ codeDir: CODE_DIR, out, runner: nodeRunner })(heldOf(prep));
    assert.deepEqual(await grade(submission('child-2', recorded.trace, recorded.state)), { ok: true, score: 1 });
    assert.deepEqual(await grade(submission('child-2', recorded.trace, recorded.state)), {
      ok: false, reason: 'the verifier rejected the submission: trace.replayed',
    });
    assert.equal(readFileSync(path.join(out, 'private', 'verifier', 'submissions.jsonl'), 'utf8'), '{"submission":"child-2"}\n');
  });

  it('a malformed request is one bounded rejection on stdout, exit 0', async () => {
    const out = tmp('verify-child-malformed');
    const dir = path.join(out, 'private', 'verifier', 'requests');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'child-3.json');
    writeFileSync(file, 'not json');
    const run = await nodeRunner([tsx, 'src/cli/verifier.ts', prep.frozenDir, file, COMMIT, path.join(out, 'private', 'verifier', 'submissions.jsonl')], {
      cwd: CODE_DIR, timeoutMs: 120_000, env: { TZ: 'UTC', PATH: process.env.PATH ?? '' },
    });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, `${JSON.stringify({ task: '', wid: prep.wid, score: null, stop: 'request.invalid' })}\n`);
    assert.equal(existsSync(path.join(out, 'private', 'verifier', 'submissions.jsonl')), false);
  });

  it('bad usage and a missing private world are authored failures with exit codes, not crashes', async () => {
    const usage = await nodeRunner([tsx, 'src/cli/verifier.ts'], { cwd: CODE_DIR, timeoutMs: 60_000, env: { TZ: 'UTC', PATH: process.env.PATH ?? '' } });
    assert.equal(usage.code, 2);
    assert.equal(usage.stderr, 'usage: verifier <privateWorldDir> <requestFile> <engineRevision> <ledgerFile>\n');

    const nowhere = path.join(tmp('verify-nowhere'), 'worlds', 'helpdesk');
    const out = tmp('verify-child-crash');
    const grade = childGrader({ codeDir: CODE_DIR, out, runner: nodeRunner })({ ...heldOf(prep), frozenDir: nowhere });
    assert.deepEqual(await grade(submission('child-4', recorded.trace, recorded.state)), {
      ok: false, reason: `the verifier process failed (exit 3): the private world in ${nowhere} does not load`,
    });
  });

  it('a verifier child that outlives its bound is killed and the grade fails', async () => {
    const out = tmp('verify-child-timeout');
    const grade = childGrader({ codeDir: CODE_DIR, out, runner: nodeRunner, timeoutMs: 1 })(heldOf(prep));
    const result = await grade(submission('child-5', recorded.trace, recorded.state));
    if (result.ok) assert.fail('a killed verifier child still graded');
    assert.match(result.reason, /^the verifier process failed \(exit \d+\): /);
  });

  it('the spawn carries no controller credential and passes the private world by path', async () => {
    const calls: { argv: readonly string[]; env: Readonly<Record<string, string | undefined>> | undefined }[] = [];
    const runner: Runner = async (argv, opts) => {
      calls.push({ argv, env: opts?.env });
      return { code: 0, stdout: `${JSON.stringify({ task: EASY, wid: prep.wid, score: 1, stop: 'graded' })}\n`, stderr: '' };
    };
    const out = tmp('verify-child-env');
    const grade = childGrader({ codeDir: CODE_DIR, out, runner })(heldOf(prep));
    assert.deepEqual(await grade(submission('child-6', recorded.trace, recorded.state)), { ok: true, score: 1 });
    assert.deepEqual(calls, [{
      argv: [tsx, 'src/cli/verifier.ts', prep.frozenDir, path.join(out, 'private', 'verifier', 'requests', 'child-6.json'), COMMIT, path.join(out, 'private', 'verifier', 'submissions.jsonl')],
      env: { TZ: 'UTC', PATH: process.env.PATH ?? '' },
    }]);
    assert.equal(Object.keys(calls[0]?.env ?? {}).includes('BOAT_API_KEY'), false);
  });
});

// ---- The pipeline --------------------------------------------------------------------------------

describe('the pipeline grades through the verifier with bounded failure', () => {
  it('a failing grader fails every episode as grade_error and still tears the sandbox down', async () => {
    const world = await checkedHelpdesk();
    const port = randomPort();
    const backend = fakeBackend(world, { port });
    const out = tmp('verify-pipeline');
    const result = await runPipeline(
      { worldDir: HELPDESK_DIR, out, runId: 'run-1', engineCommit: COMMIT, model: 'claude-sonnet-5-5', maxTurns: 60, budgetUsd: 5, maxMinutes: 5, secrets: [], sandboxName: 'ds-verify-1', port },
      {
        backend, nextTurn: solveAll,
        makeBundle: async (dir) => ({ files: [{ path: 'worlds/w/world.yaml', data: readFileSync(path.join(dir, 'public', 'world.yaml')) }], world: 'worlds/w' }),
        grader: () => async () => ({ ok: false, reason: 'injected verifier failure' }),
        log: () => undefined,
      },
    );
    assert.equal(result.status, 'incomplete');
    assert.deepEqual([result.accepted, result.failed], [0, 3]);
    assert.deepEqual(result.episodes.map((e) => [e.stop_reason, e.score]), [['grade_error', null], ['grade_error', null], ['grade_error', null]]);
    assert.equal(result.episodes.every((e) => e.error === 'grading failed at the grade; the details are in the private diagnostics'), true);
    assert.deepEqual(result.sandbox, { id: 'fake-sandbox-1', teardown: 'confirmed' });
    assert.equal(backend.stopped(), true);
    assert.equal(backend.events.at(-1), 'down');
  });
});

// ---- Network reachability under the declared controls --------------------------------------------

describe('the public-serving process exposes no grading authority', () => {
  let server: WorldServer;
  let forbidden: string[];

  before(async () => {
    const prep = await preparedOnce();
    server = await servePublic(prep.world);
    forbidden = forbiddenOf(prep.world);
  });

  after(async () => {
    await server.close();
  });

  it('every /_world path on the world port is an ordinary 404 that changes nothing', async () => {
    const before = (await (await fetch(`${server.adminUrl}/_world/state`)).json()) as { hash: string; now: string };
    const probes: readonly (readonly [string, string])[] = [
      ['GET', '/_world/state'], ['POST', '/_world/state'], ['POST', `/_world/grade/${EASY}`], ['GET', `/_world/grade/${EASY}`],
      ['POST', '/_world/verify'], ['GET', '/_world/verify/sub-1'], ['POST', '/_world/reset'], ['POST', '/_world/clock'], ['GET', '/_world/log'],
      ['POST', '/%5Fworld/grade/x'], ['GET', '/_world%2Fstate'], ['BREW', '/_world/grade'],
    ];
    for (const [method, target] of probes) {
      const init = { method, ...(method === 'POST' ? { body: '{}' } : {}) };
      const res = await fetch(`${server.url}${target}`, init);
      // The same method on a path the world never had: a /_world path must answer exactly as it does,
      // a 404 for the known methods and the transport's own refusal for an unknown one such as BREW.
      const control = await fetch(`${server.url}/no-such-path`, init);
      await control.arrayBuffer();
      assert.equal(res.status, control.status, `${method} ${target}`);
      assert.equal(res.status === 404 || method === 'BREW', true, `${method} ${target} answered ${res.status}`);
      const text = `${res.status}\n${await res.text()}`;
      for (const fragment of forbidden) assert.equal(text.includes(fragment), false, `${method} ${target} leaked`);
    }
    const after = (await (await fetch(`${server.adminUrl}/_world/state`)).json()) as { hash: string; now: string };
    assert.deepEqual(after, before);
  });

  it('the admin port is the controller channel on loopback, has no verifier route, and cannot score a public world', async () => {
    assert.equal(server.adminUrl.startsWith('http://127.0.0.1:'), true);
    const unknown = await fetch(`${server.adminUrl}/_world/verify`, { method: 'POST', body: '{}' });
    assert.equal(unknown.status, 404);
    const refused = (await unknown.json()) as { error: { code: string; message: string } };
    assert.equal(refused.error.code, 'route.not_found');
    assert.equal(refused.error.message.startsWith('No admin route POST /_world/verify. Admin routes: '), true);
    assert.equal(refused.error.message.slice('No admin route POST /_world/verify.'.length).includes('verify'), false, 'no verifier route is listed');
    const graded = await fetch(`${server.adminUrl}/_world/grade/${EASY}`, { method: 'POST' });
    assert.equal(graded.status, 500);
    const body = await graded.json();
    assert.equal((body as { error?: { code?: string } }).error?.code, 'grade.failed');
    assert.equal(JSON.stringify(body).includes('task.instruction_only'), true);
    for (const fragment of forbidden) assert.equal(JSON.stringify(body).includes(fragment), false, 'the grade failure leaked');
  });
});
