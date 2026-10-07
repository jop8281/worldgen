/**
 * Red-team: worldgen/policy.ts (factory unit wg-policy).
 *
 * Guarantees (one sentence each, with source):
 * WG-P01 An accepted attempt advances on every step. (policy.ts decide doc: rule order "accepted")
 * WG-P02 Spend at or over maxCostUsd stops budget_exhausted whatever the outcome. (policy.ts rule order "budget" first; spec "retry within budget")
 * WG-P03 Elapsed time at maxMinutes stops time_exhausted, fractional minutes included. (policy.ts rule order "time"; A-37)
 * WG-P04 A model_error outcome stops with its message. (policy.ts rule order; events.ts StopReason)
 * WG-P05 A rejection under the step's maxAttempts with a new issue set retries. (policy.ts rule "retry")
 * WG-P06 Each step stops attempts_exhausted at exactly its own maxAttempts. (A-36 per-step budgets; policy.ts rule "attempts")
 * WG-P07 The same issue set twice on one step stops no_progress, ignoring order and message text. (policy.ts invariant; issueSetKey doc; A-124 keys found too)
 * WG-P08 A repeat that is not consecutive (A, B, A) still stops no_progress, unless it is a frozen test failing at workflow (A-161). (policy.ts invariant "seen twice on one step")
 * WG-P09 Backtrack happens only when every blocking error is owned by an earlier step, to the earliest owner, and stops at maxBacktracks. (policy.ts invariant; A-34)
 * WG-P10 invalid_output never backtracks, even when its issues point at an earlier section. (policy.ts decide comment)
 * WG-P11 A stage's own done() coverage gap makes that stage retry, never backtrack away from it. (stages.ts briefs "every planned entity and route must exist by name"; plan.not_covered hint "Build what the plan says"; A-13 issue ownership follows SECTION_OWNER)
 * WG-P12 ownerOf maps each section to its SECTION_OWNER step, fixtures to model, and meta/plan/input to plan. (policy.ts ownerOf doc; A-13)
 * WG-P13 decide and record never mutate their inputs and give the same answer for the same input. (policy.ts "A pure function over a ledger")
 * WG-P14 A loop driven by record-then-decide with a scripted fake model always terminates: a fixed rejection stops after 2 calls, distinct rejections after maxAttempts calls, an upstream error after maxBacktracks backtracks, and spend stops at the budget. (spec "knows when to stop"; A-34; policy.ts record/decide doc)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { issue, type CheckIssue } from '#engine';
import type { AttemptOutcome } from '../src/worldgen/events.ts';
import type { Model, Proposal } from '../src/worldgen/llm.ts';
import { attemptIssueSet, decide, ownerOf, record, recordBacktrack, type Decision, type Ledger, type OwnedIssue } from '../src/worldgen/policy.ts';
import { STAGES, type StepId } from '../src/worldgen/stages.ts';
import type { Config } from '../src/worldgen/config.ts';
import { I, KEY, MINUTE, RT_CONFIG, T0, attempts, ledger, okReport, owned, rtPlan, rtWorld, seen } from './redteam-wg/fixtures.ts';

const rejected = (...is: CheckIssue[]): AttemptOutcome => ({ kind: 'rejected', issues: is });
const at = (step: StepId, l: Ledger, nowMs = T0 + MINUTE) => ({ step, ledger: l, nowMs });
const STEPS: readonly StepId[] = ['plan', 'model', 'workflow', 'seed', 'tasks'];

describe('redteam policy: decide tables', () => {
  it('WG-P01 accepted advances on every step', () => {
    for (const step of STEPS) {
      const got = decide(RT_CONFIG, at(step, ledger({ attempts: attempts({ [step]: 1 }) })), { kind: 'accepted', warnings: 3 }, []);
      assert.deepEqual(got, { kind: 'advance' }, step);
    }
  });

  it('WG-P02 spend at or over the limit stops budget_exhausted for every outcome kind', () => {
    const outcomes: [AttemptOutcome, OwnedIssue[]][] = [
      [{ kind: 'accepted', warnings: 0 }, []],
      [{ kind: 'model_error', message: 'overloaded' }, []],
      [rejected(I.testFailed), owned([I.testFailed, 'workflow'])],
      [rejected(I.badMachine), owned([I.badMachine, 'model'])],
      [{ kind: 'invalid_output', issues: [I.testFailed] }, []],
    ];
    for (const [outcome, iss] of outcomes) {
      const got = decide(RT_CONFIG, at('workflow', ledger({ spentUsd: 5, attempts: attempts({ workflow: 1 }) })), outcome, iss);
      assert.deepEqual(got, { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 5, limitUsd: 5 } }, outcome.kind);
    }
    const over = decide(RT_CONFIG, at('seed', ledger({ spentUsd: 5.0001, attempts: attempts({ seed: 1 }) })), { kind: 'accepted', warnings: 0 }, []);
    assert.deepEqual(over, { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 5.0001, limitUsd: 5 } });
  });

  it('WG-P03 time stops at exactly maxMinutes, including fractional minutes', () => {
    const half: Config = { ...RT_CONFIG, maxMinutes: 0.5 };
    const l = ledger({ attempts: attempts({ model: 1 }) });
    assert.deepEqual(decide(half, at('model', l, T0 + 29_999), { kind: 'accepted', warnings: 0 }, []), { kind: 'advance' });
    assert.deepEqual(decide(half, at('model', l, T0 + 30_000), { kind: 'accepted', warnings: 0 }, []), {
      kind: 'stop', reason: { kind: 'time_exhausted', minutes: 0.5 },
    });
  });

  it('WG-P04 model_error stops with its message', () => {
    assert.deepEqual(decide(RT_CONFIG, at('plan', ledger({ attempts: attempts({ plan: 1 }) })), { kind: 'model_error', message: '529 overloaded' }, []), {
      kind: 'stop', reason: { kind: 'model_error', message: '529 overloaded' },
    });
  });

  it('WG-P05 a new issue set under maxAttempts retries', () => {
    const l = ledger({ attempts: attempts({ workflow: 2 }), seenIssueSets: seen({ workflow: [KEY.actionError, KEY.testFailed] }) });
    assert.deepEqual(decide(RT_CONFIG, at('workflow', l), rejected(I.testFailed), owned([I.testFailed, 'workflow'])), { kind: 'retry' });
  });

  it('WG-P06 each step stops at exactly its own maxAttempts (plan 3, model 4, workflow 5, seed 4, tasks 5)', () => {
    const own: Record<StepId, CheckIssue> = { plan: I.testFailed, model: I.badMachine, workflow: I.testFailed, seed: I.seedViolation, tasks: I.noopNotZero };
    const max: Record<StepId, number> = { plan: 3, model: 4, workflow: 5, seed: 4, tasks: 5 };
    for (const step of STEPS) {
      const i = own[step];
      const distinct = Array.from({ length: max[step] }, (_, n) => `distinct-${n}`);
      const below = ledger({ attempts: attempts({ [step]: max[step] - 1 }), seenIssueSets: seen({ [step]: distinct.slice(1) }) });
      assert.deepEqual(decide(RT_CONFIG, at(step, below), rejected(i), owned([i, step])), { kind: 'retry' }, `${step} below max`);
      const atMax = ledger({ attempts: attempts({ [step]: max[step] }), seenIssueSets: seen({ [step]: distinct }) });
      assert.deepEqual(decide(RT_CONFIG, at(step, atMax), rejected(i), owned([i, step])), {
        kind: 'stop', reason: { kind: 'attempts_exhausted', step, attempts: max[step], lastIssues: [i] },
      }, `${step} at max`);
    }
  });

  it('WG-P07 the same issue set twice stops no_progress, whatever the order and message text', () => {
    const first = rejected(I.testFailed, I.actionError);
    const firstIssues = owned([I.testFailed, 'workflow'], [I.actionError, 'workflow']);
    const second = rejected(I.actionError, I.testFailedOtherText);
    const secondIssues = owned([I.actionError, 'workflow'], [I.testFailedOtherText, 'workflow']);
    let l = record(ledger(), 'workflow', 0.1, attemptIssueSet(first, firstIssues));
    assert.deepEqual(decide(RT_CONFIG, at('workflow', l), first, firstIssues), { kind: 'retry' });
    l = record(l, 'workflow', 0.1, attemptIssueSet(second, secondIssues));
    assert.deepEqual(decide(RT_CONFIG, at('workflow', l), second, secondIssues), {
      kind: 'stop',
      reason: {
        kind: 'no_progress',
        step: 'workflow',
        repeatedIssueSet: 'snippet.runtime_error@actions/solve: TypeError|test.failed@tests/close: open',
        lastIssues: [I.actionError, I.testFailedOtherText],
      },
    });
  });

  it('WG-P08 a non-consecutive repeat (A, B, A) stops no_progress', () => {
    const a = rejected(I.actionError);
    const aIssues = owned([I.actionError, 'workflow']);
    const b = rejected(I.testFailed);
    const bIssues = owned([I.testFailed, 'workflow']);
    let l = record(ledger(), 'workflow', 0, attemptIssueSet(a, aIssues));
    assert.deepEqual(decide(RT_CONFIG, at('workflow', l), a, aIssues), { kind: 'retry' });
    l = record(l, 'workflow', 0, attemptIssueSet(b, bIssues));
    assert.deepEqual(decide(RT_CONFIG, at('workflow', l), b, bIssues), { kind: 'retry' });
    l = record(l, 'workflow', 0, attemptIssueSet(a, aIssues));
    assert.deepEqual(decide(RT_CONFIG, at('workflow', l), a, aIssues), {
      kind: 'stop', reason: { kind: 'no_progress', step: 'workflow', repeatedIssueSet: KEY.actionError, lastIssues: [I.actionError] },
    });
  });

  it('WG-P09 backtrack only when every blocking issue is upstream, to the earliest owner, bounded by maxBacktracks', () => {
    const rows: { name: string; step: StepId; backtracks: number; outcome: AttemptOutcome; issues: OwnedIssue[]; want: Decision }[] = [
      { name: 'seed + entities error at tasks -> model', step: 'tasks', backtracks: 0,
        outcome: rejected(I.seedViolation, I.badMachine), issues: owned([I.seedViolation, 'seed'], [I.badMachine, 'model']),
        want: { kind: 'backtrack', to: 'model' } },
      { name: 'one current-step error blocks backtrack', step: 'tasks', backtracks: 0,
        outcome: rejected(I.noopNotZero, I.badMachine), issues: owned([I.noopNotZero, 'tasks'], [I.badMachine, 'model']),
        want: { kind: 'retry' } },
      { name: 'a later-step error never backtracks', step: 'model', backtracks: 0,
        outcome: rejected(I.noopNotZero), issues: owned([I.noopNotZero, 'tasks']),
        want: { kind: 'retry' } },
      { name: 'only an upstream warning blocks: backtrack to its owner (A-270)', step: 'tasks', backtracks: 0,
        outcome: rejected(I.pagingWarn), issues: owned([I.pagingWarn, 'seed']),
        want: { kind: 'backtrack', to: 'seed' } },
      { name: 'an upstream warning beside a current-step error: retry', step: 'tasks', backtracks: 0,
        outcome: rejected(I.noopNotZero, I.pagingWarn), issues: owned([I.noopNotZero, 'tasks'], [I.pagingWarn, 'seed']),
        want: { kind: 'retry' } },
      { name: 'backtracks at the limit stop', step: 'seed', backtracks: 2,
        outcome: rejected(I.actionError), issues: owned([I.actionError, 'workflow']),
        want: { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'seed', backtracks: 2 } } },
      { name: 'one below the limit still backtracks', step: 'seed', backtracks: 1,
        outcome: rejected(I.actionError), issues: owned([I.actionError, 'workflow']),
        want: { kind: 'backtrack', to: 'workflow' } },
    ];
    for (const r of rows) {
      const l = ledger({ backtracks: r.backtracks, attempts: attempts({ [r.step]: 1 }), seenIssueSets: seen({ [r.step]: [attemptIssueSet(r.outcome, r.issues) ?? ''] }) });
      assert.deepEqual(decide(RT_CONFIG, at(r.step, l), r.outcome, r.issues), r.want, r.name);
    }
  });

  it('WG-P10 invalid_output never backtracks, even with an upstream-looking issue', () => {
    const l = ledger({ attempts: attempts({ tasks: 1 }), seenIssueSets: seen({ tasks: [KEY.badMachine] }) });
    assert.deepEqual(decide(RT_CONFIG, at('tasks', l), { kind: 'invalid_output', issues: [I.badMachine] }, owned([I.badMachine, 'model'])), { kind: 'retry' });
  });
});

describe('redteam policy: stage done() issues stay with their stage', () => {
  // The loop in architecture.md: owner = ownerOf(issue), then decide at the current stage.
  const decideFor = (step: StepId, issues: readonly CheckIssue[]): Decision => {
    const o = issues.map((i) => ({ issue: i, owner: ownerOf(i) }));
    const outcome = rejected(...issues);
    const l = record(ledger(), step, 0.1, attemptIssueSet(outcome, o));
    return decide(RT_CONFIG, at(step, l), outcome, o);
  };

  it('WG-P11a a planned entity missing after the model stage makes the model stage retry', () => {
    const w = rtWorld({ entities: { ticket: { description: 'x', idPrefix: 'tk', fields: {} } } as never });
    const gaps = STAGES.model.done(okReport(w), rtPlan);
    assert.deepEqual(gaps.map((g) => [g.code, g.path]), [['plan.not_covered', ['plan', 'entities', 1]]]);
    assert.deepEqual(decideFor('model', gaps), { kind: 'retry' });
  });

  it('WG-P11b a planned task missing after the tasks stage makes the tasks stage retry', () => {
    const full = rtWorld();
    const { rebalance: _drop, ...rest } = full.tasks;
    const w = rtWorld({ tasks: { ...rest, rebalance_v2: full.tasks['rebalance']! } });
    const gaps = STAGES.tasks.done(okReport(w), rtPlan);
    assert.deepEqual(gaps.map((g) => [g.code, g.path]), [['plan.not_covered', ['plan', 'tasks', 2]]]);
    assert.deepEqual(decideFor('tasks', gaps), { kind: 'retry' });
  });

  it('WG-P11c a planned action missing after the workflow stage makes the workflow stage retry', () => {
    const w = rtWorld({ actions: {} });
    const gaps = STAGES.workflow.done(okReport(w), rtPlan);
    assert.deepEqual(gaps.map((g) => [g.code, g.path]), [['plan.not_covered', ['plan', 'workflows', 0, 'actions', 0]]]);
    assert.deepEqual(decideFor('workflow', gaps), { kind: 'retry' });
  });
});

describe('redteam policy: ownerOf', () => {
  it('WG-P12 at_path issues map through SECTION_OWNER; meta, plan and input map to plan', () => {
    const at = (p0: string) => issue('schema.invalid', [p0, 'x'] as never, { message: 'm' }, 'f');
    const want: Record<string, StepId> = {
      entities: 'model', routes: 'model', fixtures: 'model',
      actions: 'workflow', jobs: 'workflow', tests: 'plan',
      seed: 'seed', tasks: 'tasks',
      meta: 'plan', plan: 'plan', input: 'plan', format: 'plan',
    };
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, ownerOf(at(k))]));
    assert.deepEqual(got, want);
  });

  it('WG-P12 fixed owners: entities -> model, actions -> workflow, seed -> seed, tasks -> tasks', () => {
    assert.equal(ownerOf(I.badMachine), 'model');
    assert.equal(ownerOf(issue('action.unexercised', ['actions', 'solve'], { action: 'solve' }, 'none')), 'workflow');
    assert.equal(ownerOf(I.pagingWarn), 'seed');
    assert.equal(ownerOf(I.noopNotZero), 'tasks');
  });
});

describe('redteam policy: purity', () => {
  it('WG-P13 decide and record leave deeply frozen inputs untouched and are repeatable', () => {
    const deepFreeze = <T>(o: T): T => {
      if (o !== null && typeof o === 'object') {
        for (const v of Object.values(o)) deepFreeze(v);
        Object.freeze(o);
      }
      return o;
    };
    const l = deepFreeze(ledger({ spentUsd: 1, attempts: attempts({ seed: 2 }), seenIssueSets: seen({ seed: ['a', 'b'] }) }));
    const cfg = deepFreeze(structuredClone(RT_CONFIG));
    const iss = deepFreeze(owned([I.seedViolation, 'seed']));
    const before = JSON.stringify([l, cfg, iss]);
    const d1 = decide(cfg, at('seed', l), rejected(I.seedViolation), iss);
    const d2 = decide(cfg, at('seed', l), rejected(I.seedViolation), iss);
    const r = record(l, 'seed', 0.5, 'c');
    assert.deepEqual(d1, { kind: 'retry' });
    assert.deepEqual(d2, d1);
    assert.equal(JSON.stringify([l, cfg, iss]), before);
    assert.equal(r.spentUsd, 1.5);
    assert.deepEqual(r.seenIssueSets.seed, ['a', 'b', 'c']);
    assert.equal(recordBacktrack(l, 'seed').backtracks, 1);
    assert.equal(l.backtracks, 0);
  });
});

/**
 * A scripted fake Model and a minimal loop that follows the documented protocol: propose,
 * judge (scripted), record(attemptIssueSet), decide, then follow the decision. The loop has a
 * hard cap so a policy that never stops fails the test instead of hanging it.
 */
type Script = (step: StepId, n: number) => { outcome: AttemptOutcome; issues: OwnedIssue[]; costUsd: number };

function fakeModel(): Model & { calls: StepId[] } {
  const calls: StepId[] = [];
  return {
    calls,
    async propose(req) {
      const step = req.tool.name as StepId;
      calls.push(step);
      const p: Proposal = { input: { step }, advice: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, costUsd: 0, ms: 1 };
      return p;
    },
  };
}

async function drive(config: Config, script: Script): Promise<{ decision: Decision; calls: StepId[]; ledger: Ledger }> {
  const model = fakeModel();
  let l = ledger();
  let i = 0;
  let step: StepId = 'plan';
  for (let guard = 0; guard < 200; guard++) {
    await model.propose({ system: 's', prompt: 'p', tool: { name: step, description: 'd', inputSchema: {} } });
    const n = l.attempts[step] + 1;
    const { outcome, issues, costUsd } = script(step, n);
    l = record(l, step, costUsd, attemptIssueSet(outcome, issues));
    const d = decide(config, { step, ledger: l, nowMs: T0 + ++i }, outcome, issues);
    switch (d.kind) {
      case 'advance': {
        const next: StepId | undefined = STEPS[STEPS.indexOf(step) + 1];
        if (next === undefined) return { decision: d, calls: model.calls, ledger: l };
        step = next;
        break;
      }
      case 'retry':
        break;
      case 'backtrack':
        l = recordBacktrack(l, d.to);
        step = d.to;
        break;
      case 'stop':
        return { decision: d, calls: model.calls, ledger: l };
    }
  }
  throw new Error(`loop did not stop within 200 model calls: ${model.calls.join(',')}`);
}

const accept = { outcome: { kind: 'accepted', warnings: 0 } as AttemptOutcome, issues: [] as OwnedIssue[], costUsd: 0.01 };

describe('redteam policy: the loop always stops (scripted fake model)', () => {
  it('WG-P14 a fixed rejection on workflow stops no_progress after exactly 2 workflow calls', async () => {
    const r = await drive(RT_CONFIG, (step) =>
      step === 'workflow' ? { outcome: rejected(I.actionError), issues: owned([I.actionError, 'workflow']), costUsd: 0.01 } : accept);
    assert.deepEqual(r.calls, ['plan', 'model', 'workflow', 'workflow']);
    assert.deepEqual(r.decision, { kind: 'stop', reason: { kind: 'no_progress', step: 'workflow', repeatedIssueSet: KEY.actionError, lastIssues: [I.actionError] } });
  });

  it('WG-P14 a frozen test workflow keeps failing goes back to plan twice, then stops attempts_exhausted on workflow (11 calls, A-161)', async () => {
    const r = await drive(RT_CONFIG, (step) =>
      step === 'workflow' ? { outcome: rejected(I.testFailed), issues: owned([I.testFailed, 'workflow']), costUsd: 0.01 } : accept);
    assert.deepEqual(r.calls, [
      'plan', 'model', 'workflow', 'workflow',
      'plan', 'model', 'workflow', 'workflow',
      'plan', 'model', 'workflow',
    ]);
    assert.equal(r.ledger.backtracks, 2);
    assert.deepEqual(r.decision, { kind: 'stop', reason: { kind: 'attempts_exhausted', step: 'workflow', attempts: 5, lastIssues: [I.testFailed] } });
  });

  it('WG-P14 always-new rejections on tasks stop attempts_exhausted after exactly 5 tasks calls', async () => {
    const r = await drive(RT_CONFIG, (step, n) => {
      if (step !== 'tasks') return accept;
      const i = issue('task.noop_not_zero', ['tasks', `t${n}`], { score: 1 }, '1');
      return { outcome: rejected(i), issues: owned([i, 'tasks']), costUsd: 0.01 };
    });
    assert.deepEqual(r.calls, ['plan', 'model', 'workflow', 'seed', 'tasks', 'tasks', 'tasks', 'tasks', 'tasks']);
    assert.equal(r.decision.kind, 'stop');
    assert.equal(r.decision.kind === 'stop' && r.decision.reason.kind, 'attempts_exhausted');
  });

  it('WG-P14 an upstream error that never goes away stops backtrack_limit after 2 backtracks (13 calls)', async () => {
    const r = await drive(RT_CONFIG, (step) =>
      step === 'tasks' ? { outcome: rejected(I.badMachine), issues: owned([I.badMachine, 'model']), costUsd: 0.01 } : accept);
    assert.deepEqual(r.calls, [
      'plan', 'model', 'workflow', 'seed', 'tasks',
      'model', 'workflow', 'seed', 'tasks',
      'model', 'workflow', 'seed', 'tasks',
    ]);
    assert.deepEqual(r.decision, { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'tasks', backtracks: 2 } });
  });

  it('WG-P14 spend stops the run at the budget even when every attempt is accepted', async () => {
    const r = await drive(RT_CONFIG, () => ({ ...accept, costUsd: 2 }));
    assert.deepEqual(r.calls, ['plan', 'model', 'workflow']);
    assert.deepEqual(r.decision, { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 6, limitUsd: 5 } });
  });

  it('WG-P14 a clean run advances through all five steps once', async () => {
    const r = await drive(RT_CONFIG, () => accept);
    assert.deepEqual(r.calls, ['plan', 'model', 'workflow', 'seed', 'tasks']);
    assert.deepEqual(r.decision, { kind: 'advance' });
  });
});
