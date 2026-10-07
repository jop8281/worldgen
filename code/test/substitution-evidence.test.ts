/**
 * YOS-161 substitution evidence: literal equivalence control between the in-process public API
 * reference path and the served HTTP path, plus the admin reset/clock semantics.
 *
 * R1 runs one task's reference solution twice from the same checked helpdesk world: once through
 * `createRuntime` + `clientCtx` (the exact path `verifyTask` uses for reference solutions, decoys,
 * alternatives and mutants), once through a real `worldplay serve` child on a free localhost port
 * with the sync curl client of `scripts/replay-http.ts` and the serve harness of
 * `test/cli-world.test.ts`. It asserts per-call literal status and body equality, equal state hash
 * and engine time after each call, identical dumps around a refused write (atomicity), and the
 * same `gradeDump` verdict on each path's end state.
 *
 * R2/R3 drive the admin routes of a served world: reset returns every task to the one world-level
 * seed state (the format has no per-task setup, A-41), and a clock advance fires the due jobs
 * exactly in its window (A-191 for the 0s no-op).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkWorld, createRuntime, gradeDump, loadWorld, type CallRecord, type CheckedWorld, type StateDump } from '#engine';
import { clientCtx } from '../src/engine/tasks.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const HELPDESK = path.join(CODE_DIR, '../prod/worlds/helpdesk');
const EASY = 'assign_newest_acme_ticket';
const MEDIUM = 'escalate_breached_printer_ticket';
const HARD = 'escalate_breached_enterprise_tickets';
const SEED_NOW = '2026-03-02T09:00:00.000Z';

/** The checked helpdesk, once per file: a full check seeds, runs the world tests and verifies the tasks. */
const memo = new Map<string, Promise<CheckedWorld>>();
function checked(dir: string): Promise<CheckedWorld> {
  let p = memo.get(dir);
  if (p === undefined) {
    p = (async () => {
      const loaded = await loadWorld(dir);
      if (!loaded.ok) assert.fail(`${dir} did not load: ${JSON.stringify(loaded.error, null, 2)}`);
      const report = checkWorld(loaded.value);
      if (!report.ok) assert.fail(`${dir} failed check at ${report.reached}: ${JSON.stringify(report.issues, null, 2)}`);
      return report.world;
    })();
    memo.set(dir, p);
  }
  return p;
}

type Reply = { status: number; body: unknown };

/** One HTTP call, the sync curl client of `scripts/replay-http.ts`, so a solution script stays synchronous. */
function http(base: string, method: string, p: string, body?: unknown): Reply {
  const args = ['-sS', '-g', '--max-time', '30', '-X', method, '-w', '\n%{http_code}'];
  if (body !== undefined) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
  args.push(base + p);
  let out: string;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string };
    throw new Error(`curl failed for ${method} ${p}: ${String(err.stderr ?? e).trim()}`);
  }
  const cut = out.lastIndexOf('\n');
  const text = out.slice(0, cut);
  const status = Number(out.slice(cut + 1));
  if (text === '') return { status, body: null };
  try {
    return { status, body: JSON.parse(text) as unknown };
  } catch {
    return { status, body: text };
  }
}

/** Starts `worldplay serve` and resolves with its two printed URLs once both lines are out. */
function startServe(dir: string): {
  urls: Promise<{ world: string; admin: string }>;
  exit: Promise<number | null>;
  stop: () => void;
  output: () => string;
} {
  const child = spawn(
    'node',
    ['--import', 'tsx', 'src/cli/worldplay.ts', 'serve', dir, '--port', '0'],
    { cwd: CODE_DIR, env: { ...process.env, WORLDPLAY_HOST: undefined, WORLDPLAY_ADMIN_HOST: undefined }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const urls = new Promise<{ world: string; admin: string }>((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const world = /^world (http:\/\/\S+)$/m.exec(out)?.[1];
      const admin = /^admin (http:\/\/\S+)$/m.exec(out)?.[1];
      if (world !== undefined && admin !== undefined) resolve({ world, admin });
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk;
    });
    void exit.then((code) => reject(new Error(`serve exited ${String(code)} before printing URLs:\n${out}${err}`)));
  });
  return { urls, exit, stop: () => child.kill('SIGTERM'), output: () => out + err };
}

/** Runs one task snippet `(ctx) => ...` the way `scripts/replay-http.ts` compiles it. */
function runSnippet(source: string, ctx: unknown): void {
  const fn = new Function(`'use strict'; return (${source}\n);`)() as (c: unknown) => unknown;
  fn(ctx);
}

/** The ctx a solution script gets over the world port: api through curl, assert, no now. */
function httpCtx(world: string): { api: (method: string, p: string, body?: unknown) => Reply } {
  return {
    api: (method: string, p: string, body?: unknown): Reply => http(world, method, p, body),
  };
}

/** The state route's response is the dump plus the shell's sha-256 digest (YOS-183); the dump part alone. */
const routeDump = (body: unknown): StateDump => {
  const { sha256: _sha256, ...dump } = body as StateDump & { sha256: string };
  return dump;
};

/** What one recorded call observed: the reply, then the state hash and engine time right after it. */
type Observed = { readonly status: number; readonly body: unknown; readonly hash: string; readonly now: string };

describe('YOS-161 equivalence control: in-process public API reference vs HTTP', () => {
  it('R1 the reference solution makes identical calls, states and grades on both paths', { timeout: 600_000 }, async () => {
    const world = await checked(HELPDESK);
    const task = world.tasks[EASY];
    assert.ok(task !== undefined, `no task ${EASY}`);
    const rt = createRuntime(world);
    const s = startServe(HELPDESK);
    const { world: worldUrl, admin: adminUrl } = await s.urls;
    try {
      // The seed itself: one seeded state, before any call, identical on both paths. The route
      // answers with the dump plus the shell's sha-256 digest (YOS-183), so the dump part is compared.
      const seedIn = rt.dump();
      const seedHttp = http(adminUrl, 'GET', '/_world/state');
      assert.equal(seedHttp.status, 200);
      assert.equal((seedHttp.body as StateDump).now, SEED_NOW);
      assert.deepEqual(routeDump(seedHttp.body), seedIn);
      assert.match((seedHttp.body as { sha256: string }).sha256, /^sha-256:[0-9a-f]{64}$/);

      const inproc: Observed[] = [];
      const onHttp: Observed[] = [];
      const { ctx } = clientCtx(rt);
      const solution = task.solution;
      assert.ok(solution !== undefined, 'task has no solution');
      runSnippet(solution, {
        api: (method: string, p: string, body?: unknown) => {
          const r = ctx.api(method, p, body);
          inproc.push({ status: r.status, body: r.body, hash: rt.stateHash(), now: rt.dump().now });
          return r;
        },
        assert: ctx.assert,
        now: ctx.now,
      });
      runSnippet(solution, {
        api: (method: string, p: string, body?: unknown) => {
          const r = http(worldUrl, method, p, body);
          const state = http(adminUrl, 'GET', '/_world/state');
          onHttp.push({ status: r.status, body: r.body, hash: (state.body as StateDump).hash, now: (state.body as StateDump).now });
          return r;
        },
        assert: (condition: unknown, message: unknown): void => {
          if (!condition) throw new Error(`assert failed: ${String(message)}`);
        },
        now: (): never => {
          throw new Error('ctx.now is not available over HTTP');
        },
      });

      // Per call: the same four calls, the same literal statuses and bodies, the same state and clock.
      assert.equal(inproc.length, 4);
      assert.equal(onHttp.length, 4);
      assert.deepEqual(inproc.map((c) => c.status), [200, 200, 200, 200]);
      for (let i = 0; i < 4; i++) {
        assert.equal(onHttp[i]!.status, inproc[i]!.status, `call ${i + 1} status`);
        assert.deepEqual(onHttp[i]!.body, inproc[i]!.body, `call ${i + 1} body`);
        assert.equal(onHttp[i]!.hash, inproc[i]!.hash, `call ${i + 1} state hash`);
        assert.equal(onHttp[i]!.now, inproc[i]!.now, `call ${i + 1} engine time`);
      }
      // Engine time moves one declared tick per committed call, on both paths.
      assert.deepEqual(inproc.map((c) => c.now), [
        '2026-03-02T09:00:01.000Z', '2026-03-02T09:00:02.000Z', '2026-03-02T09:00:03.000Z', '2026-03-02T09:00:04.000Z',
      ]);
      assert.deepEqual(onHttp.map((c) => c.now), inproc.map((c) => c.now));
      // No job fires inside a task run: the tick window never reaches a job schedule.
      const calls = (http(adminUrl, 'GET', '/_world/log').body as { calls: CallRecord[] }).calls;
      assert.equal(calls.length, 4);
      assert.deepEqual(calls.map((c) => c.jobsFired), [[], [], [], []]);
      assert.equal(rt.log().length, 4);

      // A refused write leaves no partial change on either path: the dumps are identical before and after.
      const beforeIn = rt.dump();
      const beforeHttp = http(adminUrl, 'GET', '/_world/state').body;
      const refusedIn = rt.call({ method: 'PATCH', path: '/tickets/tkt_0001', query: {}, body: { subject: 'atomicity probe subject', priority: 'bogus' } });
      const refusedHttp = http(worldUrl, 'PATCH', '/tickets/tkt_0001', { subject: 'atomicity probe subject', priority: 'bogus' });
      assert.equal(refusedIn.status, 422);
      assert.equal(refusedHttp.status, 422);
      assert.deepEqual(refusedHttp.body, refusedIn.body);
      assert.deepEqual(rt.dump(), beforeIn);
      assert.deepEqual(http(adminUrl, 'GET', '/_world/state').body, beforeHttp);
      assert.deepEqual(routeDump(http(adminUrl, 'GET', '/_world/state').body), rt.dump());
      assert.equal(rt.dump().now, '2026-03-02T09:00:04.000Z');

      // Grading: the same verdict from each path's own end state and trace, and from each port's grade.
      const gradedIn = gradeDump(world, EASY, rt.dump(), rt.journal(), rt.log());
      const httpLog = (http(adminUrl, 'GET', '/_world/log').body as { calls: CallRecord[] }).calls;
      const gradedHttp = gradeDump(world, EASY, http(adminUrl, 'GET', '/_world/state').body as StateDump, undefined, httpLog);
      assert.deepEqual(gradedIn, { ok: true, score: 1, goals: [], guards: [{ name: 'only assignment fields and its events changed', held: true }] });
      assert.deepEqual(gradedHttp, gradedIn);
      assert.equal(rt.grade(EASY), 1);
      const adminGrade = http(adminUrl, 'POST', `/_world/grade/${EASY}`);
      assert.equal(adminGrade.status, 200);
      assert.deepEqual(adminGrade.body, { task: EASY, score: 1, state: onHttp[3]!.hash });
    } finally {
      s.stop();
    }
    assert.equal(await s.exit, 0, s.output());
  });
});

describe('YOS-161 reset and clock control: world-level seed start, no per-task setup', () => {
  it('R2 reset returns every task to the one world-level seed state', { timeout: 600_000 }, async () => {
    const world = await checked(HELPDESK);
    const s = startServe(HELPDESK);
    const { world: worldUrl, admin: adminUrl } = await s.urls;
    try {
      const reset = (): Reply => http(adminUrl, 'POST', '/_world/reset');
      const state = (): StateDump => http(adminUrl, 'GET', '/_world/state').body as StateDump;
      const grade = (task: string): number => (http(adminUrl, 'POST', `/_world/grade/${task}`).body as { score: number }).score;

      assert.equal(reset().status, 200);
      const seed = state();
      assert.equal(seed.now, SEED_NOW);

      // Two different tasks, one after the other over the world port, each from the same reset target.
      for (const id of [EASY, MEDIUM]) {
        const task = world.tasks[id];
        assert.ok(task !== undefined, `no task ${id}`);
        const solution = task.solution;
        assert.ok(solution !== undefined, `task ${id} has no solution`);
        runSnippet(solution, {
          ...httpCtx(worldUrl),
          assert: (condition: unknown, message: unknown): void => {
            if (!condition) throw new Error(`assert failed: ${String(message)}`);
          },
          now: (): never => {
            throw new Error('ctx.now is not available over HTTP');
          },
        });
        assert.notEqual(state().hash, seed.hash, `${id} changed the state`);
        assert.equal(grade(id), 1, `${id} scored at its end state`);
        assert.equal(reset().status, 200);
        assert.deepEqual(state(), seed, `reset after ${id} did not return the seed`);
        assert.equal(((http(adminUrl, 'GET', '/_world/log').body) as { calls: CallRecord[] }).calls.length, 0);
      }

      // No per-task setup exists: at the reset seed every task, easy to hard, starts at noop score 0.
      for (const id of [EASY, MEDIUM, HARD]) assert.equal(grade(id), 0, `${id} at the seed`);
      assert.deepEqual(state(), seed);
    } finally {
      s.stop();
    }
    assert.equal(await s.exit, 0, s.output());
  });

  it('R3 the admin clock bounds job effects to its advance window', { timeout: 600_000 }, async () => {
    await checked(HELPDESK);
    const s = startServe(HELPDESK);
    const { admin: adminUrl } = await s.urls;
    try {
      const state = (): StateDump => http(adminUrl, 'GET', '/_world/state').body as StateDump;
      const clock = (advance: string): Reply => http(adminUrl, 'POST', '/_world/clock', { advance });
      assert.equal(http(adminUrl, 'POST', '/_world/reset').status, 200);
      const seed = state();
      const seedHash = seed.hash;

      // 0s is a no-op: nothing fires, nothing moves (A-191).
      const zero = clock('0s');
      assert.equal(zero.status, 200);
      assert.deepEqual(zero.body, { now: SEED_NOW, jobsFired: [], jobsFailed: [] });
      assert.equal(state().hash, seedHash);

      // 10m: no job is scheduled inside the window, so only engine time moves and the state hash is unchanged.
      const ten = clock('10m');
      assert.equal(ten.status, 200);
      assert.deepEqual(ten.body, { now: '2026-03-02T09:10:00.000Z', jobsFired: [], jobsFailed: [] });
      assert.equal(state().hash, seedHash);

      // 5m more reaches the 15m schedules: exactly the two 15m jobs fire, in (time, name) order.
      const five = clock('5m');
      assert.equal(five.status, 200);
      assert.deepEqual(five.body, { now: '2026-03-02T09:15:00.000Z', jobsFired: ['escalation_timeout', 'sla_breach'], jobsFailed: [] });
      assert.notEqual(state().hash, seedHash);

      // An invalid advance is refused and moves nothing.
      const bad = clock('nope');
      assert.equal(bad.status, 400);
      assert.equal((bad.body as { error: { code: string } }).error.code, 'clock.invalid');
      assert.equal(state().now, '2026-03-02T09:15:00.000Z');

      // The world-level reset erases the job effects too: back to the seed.
      assert.equal(http(adminUrl, 'POST', '/_world/reset').status, 200);
      assert.deepEqual(state(), seed);
    } finally {
      s.stop();
    }
    assert.equal(await s.exit, 0, s.output());
  });
});
