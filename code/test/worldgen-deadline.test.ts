/**
 * maxMinutes bounds the engine's judging, not only the model call. A snippet that calls ctx about
 * every 0.5 s never trips the no-call guard, so before A-118 the run outlived its deadline by the
 * length of the snippet: 98 s against 66 s for a 200-chunk seed, without end for an unbounded loop.
 * The create cases put the spinner in a grader, since tasks is the one step a call can still
 * reach 3 s before the deadline once the tasks call's estimate is held back (A-114).
 * The iterate cases cover the other two checks a run makes: of the existing world, and the skip probe.
 * Each case runs in a child, since a synchronous check cannot be preempted by a test timeout.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

const CODE_DIR = path.resolve(import.meta.dirname, '..');

describe('the run deadline bounds judging', () => {
  for (const variant of ['capped', 'uncapped'] as const) {
    it(`a ${variant} ctx.changes spinner in a grader stops the run at the deadline with time_exhausted`, () => {
      const r = spawnSync(process.execPath, ['test/helpers/deadline-repro.ts', variant], { cwd: CODE_DIR, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' });
      assert.equal(r.error, undefined, `the run did not finish in 45 s; it printed:\n${r.stdout}${r.stderr}`);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
      assert.deepEqual(out['reason'], { kind: 'time_exhausted', minutes: 10 });
      assert.equal(out['lastEvent'], 'run_finished');
      assert.deepEqual(out['tail'], ['attempt:tasks', 'run_finished']);
      assert.equal(out['calls'], 6);
      assert.equal(out['report'], true);
      assert.equal(typeof out['ms'], 'number');
      const ms = Number(out['ms']);
      assert.equal(ms <= 600_000 + 1_500, true, `run_finished at ${ms} ms`);
      assert.equal(ms >= 600_000 - 50, true, `run_finished at ${ms} ms`);
      assert.equal(out['costUsd'], 0.75);
      // The cut check is an attempt like any other: logged, dumped with its proposal, and in the step totals.
      assert.deepEqual(out['attempts'], ['plan-1:accepted', 'model-1:accepted', 'workflow-1:accepted', 'seed-1:accepted', 'tasks-1:rejected', 'tasks-2:judge_expired']);
      assert.equal(out['attemptCostUsd'], 0.75);
      const dump = out['lastDump'] as Record<string, unknown>;
      assert.deepEqual([dump['step'], dump['n'], dump['outcome'], dump['costUsd']], ['tasks', 2, { kind: 'judge_expired' }, 0.125]);
      assert.equal(JSON.stringify(dump['proposal']).includes('ctx.changes()'), true);
      assert.deepEqual(out['reportHead'], [
        'Stopped: time_exhausted',
        "The run hit its 10-minute limit while the engine was still checking the tasks step's proposal, so the check was cut short and the proposal was not judged.",
      ]);
      assert.equal(Number(out['wallMs']) < 20_000, true, `wall ${String(out['wallMs'])} ms`);
    });
  }

  const ITERATE = [
    // The existing world's own check, before any model call: a 3 s run.
    { variant: 'iterate-old', minutes: 0.05, deadlineMs: 3_000, tail: ['run_started', 'run_finished'], calls: 0, costUsd: 0 },
    // The skip probe of the model stage, after the plan call left 3 s of a 240 s run. Later steps keep their low-effort
    // call estimates, 114 s in all (A-311), so the plan call needs a run of more than 183 s to start.
    { variant: 'iterate-probe', minutes: 4, deadlineMs: 240_000, tail: ['step_finished:plan', 'run_finished'], calls: 1, costUsd: 0.125 },
  ] as const;
  for (const c of ITERATE) {
    it(`${c.variant}: a spinner seed in the existing world stops the iterate run at the deadline with time_exhausted`, () => {
      const r = spawnSync(process.execPath, ['test/helpers/deadline-repro.ts', c.variant], { cwd: CODE_DIR, encoding: 'utf8', timeout: 45_000, killSignal: 'SIGKILL' });
      assert.equal(r.error, undefined, `the run did not finish in 45 s; it printed:\n${r.stdout}${r.stderr}`);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
      assert.deepEqual(out['reason'], { kind: 'time_exhausted', minutes: c.minutes });
      assert.equal(out['lastEvent'], 'run_finished');
      assert.deepEqual(out['tail'], c.tail);
      assert.equal(out['calls'], c.calls);
      assert.equal(out['report'], true);
      assert.equal(typeof out['ms'], 'number');
      const ms = Number(out['ms']);
      assert.equal(ms <= c.deadlineMs + 1_500, true, `run_finished at ${ms} ms`);
      assert.equal(ms >= c.deadlineMs - 50, true, `run_finished at ${ms} ms`);
      assert.equal(out['costUsd'], c.costUsd);
    });
  }
});
