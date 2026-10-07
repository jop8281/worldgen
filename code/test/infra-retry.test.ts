import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issue, type CheckIssue, type CheckReport } from '#engine';
import { configSchema } from '../src/worldgen/config.ts';
import type { AttemptOutcome } from '../src/worldgen/events.ts';
import { INFRA_CHECK_TRIES, checkJudgeable, infraIssues } from '../src/worldgen/judge.ts';
import { decide, type Ledger } from '../src/worldgen/policy.ts';

const unavailable = issue('snippet.host_unavailable', ['seed', 'ticket'], { ms: 10_000 }, '(ctx) => 1 not run');
const broken = issue('snippet.compile_error', ['seed', 'ticket'], { message: 'x is not defined' }, '(ctx) => x');
const failed = (...issues: [CheckIssue, ...CheckIssue[]]): CheckReport => ({ ok: false, reached: 'compile', issues, warnings: [] });

/** A check that answers from a script and counts its runs. */
function scripted(...reports: CheckReport[]): { run: () => CheckReport; runs: () => number } {
  let n = 0;
  return { run: () => reports[Math.min(n++, reports.length - 1)]!, runs: () => n };
}

describe('checkJudgeable', () => {
  it('tries a check at most twice', () => {
    assert.equal(INFRA_CHECK_TRIES, 2);
  });

  it('runs a clean check once', () => {
    const s = scripted(failed(broken));
    assert.deepEqual(checkJudgeable(s.run), failed(broken));
    assert.equal(s.runs(), 1);
  });

  it('reruns once after host_unavailable and returns the second report', () => {
    const s = scripted(failed(unavailable), failed(broken));
    assert.deepEqual(checkJudgeable(s.run), failed(broken));
    assert.equal(s.runs(), 2);
  });

  it('stops rerunning after two tries when the host stays unavailable', () => {
    const s = scripted(failed(unavailable));
    assert.deepEqual(infraIssues(checkJudgeable(s.run)), [unavailable]);
    assert.equal(s.runs(), 2);
  });
});

describe('infraIssues', () => {
  it('picks host_unavailable out of a mixed report and nothing else', () => {
    assert.deepEqual(infraIssues(failed(broken, unavailable)), [unavailable]);
    assert.deepEqual(infraIssues(failed(broken)), []);
  });
});

const config = configSchema.parse({
  model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 30, maxBacktracks: 2, maxOutputTokens: 16000,
  steps: { plan: { maxAttempts: 4 }, model: { maxAttempts: 4 }, workflow: { maxAttempts: 4 }, seed: { maxAttempts: 4 }, tasks: { maxAttempts: 4 } },
  prices: {}, exampleWorld: '../prod/worlds/helpdesk',
});
const START = 1_000_000;
const ledger: Ledger = {
  startedAtMs: START, spentUsd: 0, backtracks: 0,
  attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 0 },
  seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] },
  stallRetries: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 },
};

describe('decide on an infra outcome', () => {
  const cases: { name: string; outcome: AttemptOutcome; want: ReturnType<typeof decide> }[] = [
    { name: 'stops with infra_unavailable and the issue, never retries with a repair prompt',
      outcome: { kind: 'infra_unavailable', issues: [unavailable] },
      want: { kind: 'stop', reason: { kind: 'infra_unavailable', step: 'seed', issues: [unavailable] } } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      assert.deepEqual(decide(config, { step: 'seed', ledger, nowMs: START + 1000 }, c.outcome, []), c.want);
    });
  }

  it('still reports the budget first when the run is over budget', () => {
    assert.deepEqual(
      decide(config, { step: 'seed', ledger: { ...ledger, spentUsd: 5 }, nowMs: START + 1000 }, { kind: 'infra_unavailable', issues: [unavailable] }, []),
      { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 5, limitUsd: 5 } },
    );
  });
});
