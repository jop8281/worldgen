/**
 * `bun run difficulty` (A-391): the run loop, the matrix and its Markdown over a scripted episode
 * runner, then the local runner over helpdesk with a fake Model, metered and not, and the CLI's
 * refusals. No test calls a real model.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { parse } from '../src/cli/difficulty.ts';
import { CostUnenforceableError, openLedger, SpendCapError } from '../src/costs/ledger.ts';
import { meteredModel } from '../src/costs/meter.ts';
import {
  difficultyMatrix, isBudgetStop, isCostRefusal, isTrial, localRunner, measuredTier, modelCapLeft, renderDifficultyMd, runDifficulty, wilson,
  type DifficultyRunOptions, type DifficultyTask, type EpisodeJob, type EpisodeOutcome,
} from '../src/dataset/difficulty.ts';
import { redactor, type StopReason } from '../src/dataset/schema.ts';
import type { SolverProposer } from '../src/dataset/solver.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const HELPDESK = path.resolve(CODE_DIR, '../prod/worlds/helpdesk');
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const EASY: DifficultyTask = { world: 'helpdesk', worldDir: HELPDESK, task: 'assign_newest_acme_ticket', labeled: 'easy' };
const HARD: DifficultyTask = { world: 'helpdesk', worldDir: HELPDESK, task: 'escalate_breached_enterprise_tickets', labeled: 'hard' };

const scratch: string[] = [];
const tmp = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `difficulty-${name}-`));
  scratch.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const outcome = (score: number | null, costUsd: number, stopReason: StopReason = 'done', refusal: string | null = null, unaccountedCalls = 0): Omit<EpisodeOutcome, 'episodeId'> => ({
  score, stopReason, costUsd, unaccountedCalls, refusal, budgetTooSmall: false,
});

/** A runner that answers each job from `script`, keyed `task model index`, and records the jobs it was given. */
function scriptedRunner(script: Readonly<Record<string, Omit<EpisodeOutcome, 'episodeId'> | Error>>): { run: DifficultyRunOptions['run']; jobs: string[] } {
  const jobs: string[] = [];
  return {
    jobs,
    run: async (job: EpisodeJob) => {
      const key = `${job.task} ${job.model} ${job.index}`;
      jobs.push(`${job.runId} ${key} $${job.budgetUsd}`);
      const answer = script[key];
      if (answer === undefined) throw new Error(`no script for ${key}`);
      if (answer instanceof Error) throw answer;
      return { episodeId: `${job.runId}__${job.task}__1`, ...answer };
    },
  };
}

const base = { runId: 'd1', models: [SONNET, OPUS], budgetUsd: 10, episodeBudgetUsd: 0.5 } as const;

describe('wilson and measuredTier', () => {
  it('gives the Wilson 95% interval, rounded to three places, and null with no trials', () => {
    assert.deepEqual(
      [[0, 3], [1, 3], [2, 3], [3, 3], [1, 2], [5, 6], [1, 5]].map(([k, n]) => wilson(k as number, n as number)),
      [[0, 0.561], [0.061, 0.792], [0.208, 0.939], [0.439, 1], [0.095, 0.905], [0.436, 0.97], [0.036, 0.624]],
    );
    assert.equal(wilson(0, 0), null);
  });

  it('measures easy from 2/3, medium from 1/3, hard below, and unmeasured with no trials', () => {
    assert.deepEqual(
      [[0, 0], [3, 3], [2, 3], [1, 3], [0, 3], [6, 9], [5, 9], [3, 9], [2, 9]].map(([k, n]) => measuredTier(k as number, n as number)),
      ['unmeasured', 'easy', 'easy', 'medium', 'hard', 'easy', 'medium', 'medium', 'hard'],
    );
  });
});

describe('isCostRefusal, isBudgetStop and modelCapLeft', () => {
  it('reads every refusal the ledger throws before a call, and nothing else', () => {
    assert.deepEqual(
      [
        new SpendCapError({ cap: 'maxTotalUsd', capUsd: 1, spentUsd: 1, remainingUsd: 0 }, '2026-10-08'),
        new CostUnenforceableError('maxDailyUsd', 'c1', 'cost admission refused: WORLDGEN_MAX_DAILY_USD cannot be enforced'),
        new Error('cost admission refused: the ledger contains corrupt or incomplete records'),
        new Error('model call failed: Anthropic API error 529: overloaded'),
        'cost admission refused',
      ].map(isCostRefusal),
      [true, true, true, false, false],
    );
  });

  it('reads a call its allowance stopped, in each way llm.ts words it', () => {
    assert.deepEqual(
      [
        'claude -p failed (exit 1): error_max_budget_usd: Reached maximum budget ($0.02)',
        'SDK admission refused: counted input and one output token do not fit the model estimate budget',
        'model output hit max_tokens (250) before the tool call finished',
        'model output hit max_tokens (4096) before the tool call finished',
        'claude -p failed (exit 1): error_max_structured_output_retries: Failed to provide valid structured output after 5 attempts',
      ].map((m) => isBudgetStop(new Error(m), 4096)),
      [true, true, true, false, false],
    );
  });

  it('leaves the least that a model-call cap leaves, ignores the sandbox cap, and is null with no cap', () => {
    const ledger = openLedger(path.join(tmp('caps'), 'costs.jsonl'));
    ledger.record({ provider: 'anthropic', account: 'sha256:e0dbaa0c6455', kind: 'model_call', usd: 1.25, estimated: false });
    assert.equal(modelCapLeft(ledger, { maxTotalUsd: 10, maxDailyLlmUsd: 2, maxDailySandboxUsd: 0.1 })(), 0.75);
    assert.equal(modelCapLeft(ledger, { maxDailySandboxUsd: 0.1 })(), null);
    assert.equal(modelCapLeft(ledger, {})(), null);
  });
});

describe('runDifficulty and difficultyMatrix', () => {
  it('runs every task with every model once per round and builds the literal matrix', async () => {
    const { run, jobs } = scriptedRunner({
      [`${EASY.task} ${SONNET} 1`]: outcome(1, 0.01), [`${EASY.task} ${OPUS} 1`]: outcome(1, 0.02),
      [`${HARD.task} ${SONNET} 1`]: outcome(0, 0.01), [`${HARD.task} ${OPUS} 1`]: outcome(1, 0.02),
      [`${EASY.task} ${SONNET} 2`]: outcome(1, 0.01), [`${EASY.task} ${OPUS} 2`]: outcome(1, 0.02),
      [`${HARD.task} ${SONNET} 2`]: outcome(0, 0.01), [`${HARD.task} ${OPUS} 2`]: outcome(null, 0.02, 'world_error'),
      [`${EASY.task} ${SONNET} 3`]: outcome(0, 0.01, 'turn_limit'), [`${EASY.task} ${OPUS} 3`]: outcome(1, 0.02),
      [`${HARD.task} ${SONNET} 3`]: outcome(0, 0.01, 'model_error'), [`${HARD.task} ${OPUS} 3`]: outcome(0, 0.02),
    });
    const options = { ...base, tasks: [EASY, HARD], episodes: 3 };
    const r = await runDifficulty({ ...options, run });
    assert.deepEqual(r.stop, { kind: 'complete' });
    assert.equal(r.spentUsd, 0.18);
    assert.deepEqual(jobs.slice(0, 5), [
      `d1.1 ${EASY.task} ${SONNET} 1 $0.5`, `d1.2 ${EASY.task} ${OPUS} 1 $0.5`,
      `d1.3 ${HARD.task} ${SONNET} 1 $0.5`, `d1.4 ${HARD.task} ${OPUS} 1 $0.5`,
      `d1.5 ${EASY.task} ${SONNET} 2 $0.5`,
    ]);
    const m = difficultyMatrix(options, r);
    assert.deepEqual(m.tasks, [
      { world: 'helpdesk', task: EASY.task, labeled: 'easy', trials: 6, passes: 5, passRate: 0.833, interval: [0.436, 0.97], measured: 'easy', agrees: true },
      { world: 'helpdesk', task: HARD.task, labeled: 'hard', trials: 4, passes: 1, passRate: 0.25, interval: [0.046, 0.699], measured: 'hard', agrees: true },
    ]);
    assert.deepEqual(m.cells, [
      { world: 'helpdesk', task: EASY.task, labeled: 'easy', model: SONNET, episodes: 3, trials: 3, passes: 2, passRate: 0.667, interval: [0.208, 0.939], measured: 'easy', costUsd: 0.03, usdPerPass: 0.015, unaccountedCalls: 0, stops: { done: 2, turn_limit: 1 }, refused: 0 },
      { world: 'helpdesk', task: EASY.task, labeled: 'easy', model: OPUS, episodes: 3, trials: 3, passes: 3, passRate: 1, interval: [0.439, 1], measured: 'easy', costUsd: 0.06, usdPerPass: 0.02, unaccountedCalls: 0, stops: { done: 3 }, refused: 0 },
      { world: 'helpdesk', task: HARD.task, labeled: 'hard', model: SONNET, episodes: 3, trials: 2, passes: 0, passRate: 0, interval: [0, 0.658], measured: 'hard', costUsd: 0.03, usdPerPass: null, unaccountedCalls: 0, stops: { done: 2, model_error: 1 }, refused: 0 },
      { world: 'helpdesk', task: HARD.task, labeled: 'hard', model: OPUS, episodes: 3, trials: 2, passes: 1, passRate: 0.5, interval: [0.095, 0.905], measured: 'medium', costUsd: 0.06, usdPerPass: 0.06, unaccountedCalls: 0, stops: { done: 2, world_error: 1 }, refused: 0 },
    ]);
  });

  it('starts an episode only while its whole budget fits, and stops with what is left', async () => {
    const { run, jobs } = scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: outcome(1, 0.4), [`${EASY.task} ${OPUS} 1`]: outcome(0, 0.4) });
    const r = await runDifficulty({ ...base, tasks: [EASY], episodes: 3, budgetUsd: 1.2, run });
    assert.deepEqual(r.stop, { kind: 'budget_spent', leftUsd: 0.4 });
    assert.deepEqual([r.spentUsd, jobs.length], [0.8, 2]);
  });

  it('stops at the first cost refusal, and no other model runs in its place', async () => {
    const refusal = 'total spend cap WORLDGEN_MAX_TOTAL_USD=$1.00 reached';
    const { run, jobs } = scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: outcome(1, 0.01), [`${EASY.task} ${OPUS} 1`]: outcome(0, 0, 'model_error', refusal) });
    const options = { ...base, tasks: [EASY, HARD], episodes: 2 };
    const r = await runDifficulty({ ...options, run });
    assert.deepEqual(r.stop, { kind: 'cost_refused', message: refusal });
    assert.deepEqual(jobs, [`d1.1 ${EASY.task} ${SONNET} 1 $0.5`, `d1.2 ${EASY.task} ${OPUS} 1 $0.5`]);
    const cell = difficultyMatrix(options, r).cells[1];
    assert.deepEqual([cell?.model, cell?.episodes, cell?.trials, cell?.refused, cell?.measured], [OPUS, 1, 0, 1, 'unmeasured']);
  });

  it('stops as failed when an episode cannot run, and as interrupted when the operator stops it', async () => {
    const failed = await runDifficulty({ ...base, tasks: [EASY], episodes: 1, run: scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: new Error('the world did not start serving') }).run });
    assert.deepEqual(failed.stop, { kind: 'failed', message: `episode d1.1 (helpdesk ${EASY.task}, ${SONNET}) could not run to the end, so it is charged its whole $0.5 budget: the world did not start serving` });
    assert.equal(failed.spentUsd, 0.5);
    const stopped = new AbortController();
    stopped.abort();
    const { run, jobs } = scriptedRunner({});
    const interrupted = await runDifficulty({ ...base, tasks: [EASY], episodes: 1, run, interrupt: stopped.signal });
    assert.deepEqual([interrupted.stop, jobs.length], [{ kind: 'interrupted' }, 0]);
  });

  it('refuses the next episode when the spend caps no longer fit its budget', async () => {
    const left = [2, 0.3];
    const { run, jobs } = scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: outcome(1, 0.2) });
    const r = await runDifficulty({ ...base, tasks: [EASY], episodes: 1, run, capLeftUsd: () => left.shift() ?? null });
    assert.deepEqual(r.stop, { kind: 'cost_refused', message: "the spend caps leave $0.3 for model calls, less than one episode's $0.5 budget" });
    assert.deepEqual([jobs.length, r.spentUsd], [1, 0.2]);
  });

  it('reads a budget stop as the caps running out when they no longer fit an episode, so it is no trial', async () => {
    const left = [2, 0.3];
    const { run } = scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: outcome(0, 0.2, 'budget_limit') });
    const options = { ...base, tasks: [EASY], episodes: 1 };
    const r = await runDifficulty({ ...options, run, capLeftUsd: () => left.shift() ?? null });
    const message = "the spend caps ran low during the episode and leave $0.3 for model calls, less than one episode's $0.5 budget";
    assert.deepEqual(r.stop, { kind: 'cost_refused', message });
    const cell = difficultyMatrix(options, r).cells[0];
    assert.deepEqual([cell?.episodes, cell?.trials, cell?.refused], [1, 0, 1]);
  });

  it('stops as failed when a model cannot make one call within the episode budget', async () => {
    const { run, jobs } = scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: { ...outcome(0, 0, 'model_error'), budgetTooSmall: true } });
    const r = await runDifficulty({ ...base, tasks: [EASY], episodes: 2, run });
    assert.deepEqual(r.stop, { kind: 'failed', message: `episode d1.1: ${SONNET} could not make one call within the $0.5 episode budget; raise --episode-budget-usd` });
    assert.deepEqual([jobs.length, r.rows[0] === undefined ? null : isTrial(r.rows[0])], [1, false]);
  });

  it('charges an episode with a call of unknown billing its whole budget', async () => {
    const { run } = scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: outcome(0, 0.1, 'time_limit', null, 1), [`${EASY.task} ${OPUS} 1`]: outcome(1, 0.2) });
    const options = { ...base, tasks: [EASY], episodes: 1 };
    const r = await runDifficulty({ ...options, run });
    assert.deepEqual([r.spentUsd, r.rows.map((e) => e.chargedUsd)], [0.7, [0.5, 0.2]]);
    const cells = difficultyMatrix(options, r).cells;
    assert.deepEqual(cells.map((c) => [c.costUsd, c.unaccountedCalls]), [[0.1, 1], [0.2, 0]]);
  });

  it('renders the literal Markdown matrix', async () => {
    const { run } = scriptedRunner({ [`${EASY.task} ${SONNET} 1`]: outcome(1, 0.01), [`${EASY.task} ${OPUS} 1`]: outcome(0, 0.02, 'turn_limit') });
    const options = { ...base, tasks: [EASY], episodes: 1 };
    const md = renderDifficultyMd(difficultyMatrix(options, await runDifficulty({ ...options, run })));
    assert.equal(md, [
      '# Difficulty: d1',
      '',
      'Models: claude-sonnet-5-5, claude-opus-5-5. Episodes per task per model: 1, each with a $0.5 budget.',
      '',
      'Charged $0.03 of the $10 budget over 2 episodes. An episode with a call of unknown billing is charged its whole budget; there were 0 such calls.',
      '',
      'Stop: complete.',
      '',
      'A pass is an engine score of 1. A trial is a graded episode that stopped done or at its turn, budget or time limit; a model error, a refusal, a world or grade error and an interruption are not trials. The interval is Wilson 95%. The measured tier is easy at a pass rate of 2/3 or more, medium at 1/3 or more, and hard below.',
      '',
      'The engine score certifies the final world state only. It does not independently certify that the final reply is factually correct.',
      '',
      '## By task',
      '',
      '| world | task | labeled | measured | agrees | passes / trials | pass rate | 95% interval |',
      '|---|---|---|---|---|---|---|---|',
      '| helpdesk | assign_newest_acme_ticket | easy | medium | no | 1 / 2 | 0.5 | 0.095 to 0.905 |',
      '',
      '## By task and model',
      '',
      '| world | task | labeled | model | measured | passes / trials | pass rate | 95% interval | episodes | stops | cost USD | USD per pass |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      '| helpdesk | assign_newest_acme_ticket | easy | claude-sonnet-5-5 | easy | 1 / 1 | 1 | 0.207 to 1 | 1 | done 1 | 0.01 | 0.01 |',
      '| helpdesk | assign_newest_acme_ticket | easy | claude-opus-5-5 | hard | 0 / 1 | 0 | 0 to 0.793 | 1 | turn_limit 1 | 0.02 | none |',
      '',
    ].join('\n'));
  });
});

/** The four requests the first live Sonnet episode made on the easy task, then its reply. */
const SOLVE_EASY: readonly unknown[] = [
  { action: 'request', method: 'GET', path: '/agents', query: { q: 'Priya' } },
  { action: 'request', method: 'GET', path: '/customers', query: { q: 'Acme' } },
  { action: 'request', method: 'GET', path: '/tickets', query: { customer_id: 'cus_0001', sort: '-created_at' } },
  { action: 'request', method: 'POST', path: '/tickets/tkt_0004/assign', body: { agent_id: 'agt_0001' }, query: {} },
  { action: 'finish', final_reply: 'Assigned tkt_0004 to Priya Raman.' },
];
const FINISH = { action: 'finish', final_reply: 'All done.' };

/** A fake Model: each episode, told apart by its run id, gets `decisions` one per call, at `costUsd` a call. */
function fakeModel(decisions: readonly unknown[], costUsd: number): SolverProposer & { readonly calls: () => number } {
  const turns = new Map<string, number>();
  let calls = 0;
  return {
    calls: () => calls,
    async propose(req) {
      calls += 1;
      const n = turns.get(req.runId ?? '') ?? 0;
      turns.set(req.runId ?? '', n + 1);
      return { input: decisions[n] ?? FINISH, advice: [], usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }, costUsd, ms: 1 };
    },
  };
}

describe('localRunner over helpdesk with a fake Model', () => {
  it('runs graded loopback episodes per model and writes each under <out>/episodes/<run id>', async () => {
    const out = tmp('local');
    const solver = fakeModel(SOLVE_EASY, 0.001);
    const lazy = fakeModel([FINISH], 0.001);
    const options = { runId: 'loc', tasks: [EASY], models: [SONNET, OPUS], episodes: 1, budgetUsd: 1, episodeBudgetUsd: 0.1 };
    const run = localRunner({ out, engineCommit: 'abcdef1', maxTurns: 8, maxMinutes: 2, maxOutputTokens: 4096, redact: redactor([]), proposers: new Map([[SONNET, solver], [OPUS, lazy]]) });
    const r = await runDifficulty({ ...options, run });
    assert.deepEqual(r.stop, { kind: 'complete' });
    assert.deepEqual(r.rows.map((e) => [e.runId, e.model, e.stopReason, e.score, e.costUsd, e.refusal]), [
      ['loc.1', SONNET, 'done', 1, 0.005, null],
      ['loc.2', OPUS, 'done', 0, 0.001, null],
    ]);
    const m = difficultyMatrix(options, r);
    assert.deepEqual(m.tasks.map((t) => [t.passes, t.trials, t.measured, t.agrees]), [[1, 2, 'medium', false]]);
    assert.deepEqual(m.cells.map((c) => [c.model, c.measured, c.interval]), [[SONNET, 'easy', [0.207, 1]], [OPUS, 'hard', [0, 0.793]]]);
    assert.deepEqual([existsSync(path.join(out, 'episodes/loc.1/dataset.jsonl')), existsSync(path.join(out, 'episodes/loc.2/failures.jsonl'))], [true, true]);
  });

  it('reads a later call its allowance stopped as budget_limit, a trial, and a first one as a budget too small', async () => {
    const out = tmp('budget');
    const budgetStop = (): Error => Object.assign(new Error('claude -p failed (exit 1): error_max_budget_usd: Reached maximum budget'), {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }, costUsd: 0.02, ms: 1,
    });
    const answers = fakeModel(SOLVE_EASY, 0.001);
    let calls = 0;
    const spendsOut: SolverProposer = { propose: async (req) => (++calls === 1 ? answers.propose(req) : Promise.reject(budgetStop())) };
    const tooSmall: SolverProposer = { propose: async () => { throw budgetStop(); } };
    const run = localRunner({ out, engineCommit: 'abcdef1', maxTurns: 8, maxMinutes: 2, maxOutputTokens: 4096, redact: redactor([]), proposers: new Map([[SONNET, spendsOut], [OPUS, tooSmall]]) });
    const r = await runDifficulty({ runId: 'bud', tasks: [EASY], models: [SONNET, OPUS], episodes: 1, budgetUsd: 1, episodeBudgetUsd: 0.1, run });
    assert.deepEqual(r.rows.map((e) => [e.model, e.stopReason, e.score, e.costUsd, e.budgetTooSmall, isTrial(e)]), [
      [SONNET, 'budget_limit', 0, 0.021, false, true],
      [OPUS, 'model_error', 0, 0.02, true, false],
    ]);
    assert.deepEqual(r.stop, { kind: 'failed', message: `episode bud.2: ${OPUS} could not make one call within the $0.1 episode budget; raise --episode-budget-usd` });
  });

  it('stops the run when the spend ledger refuses the first call, before the fake Model is called', async () => {
    const out = tmp('refused');
    const ledger = openLedger(path.join(out, 'costs.jsonl'));
    ledger.record({ provider: 'anthropic', account: 'sha256:e0dbaa0c6455', kind: 'model_call', usd: 1, estimated: false });
    const inner = fakeModel(SOLVE_EASY, 0.001);
    const metered = meteredModel(inner, ledger, { provider: 'anthropic', account: 'sha256:e0dbaa0c6455', caps: { maxTotalUsd: 1 } });
    const other = fakeModel([FINISH], 0.001);
    const run = localRunner({ out, engineCommit: 'abcdef1', maxTurns: 8, maxMinutes: 2, maxOutputTokens: 4096, redact: redactor([]), proposers: new Map([[SONNET, metered], [OPUS, other]]) });
    const r = await runDifficulty({ runId: 'ref', tasks: [EASY], models: [SONNET, OPUS], episodes: 2, budgetUsd: 1, episodeBudgetUsd: 0.1, run });
    assert.equal(r.stop.kind, 'cost_refused');
    assert.match(r.stop.kind === 'cost_refused' ? r.stop.message : '', /^total spend cap WORLDGEN_MAX_TOTAL_USD=\$1\.00 reached/);
    assert.deepEqual(r.rows.map((e) => [e.runId, e.model, e.stopReason, e.costUsd, e.unaccountedCalls, e.chargedUsd]), [['ref.1', SONNET, 'model_error', 0, 0, 0]]);
    assert.equal(r.spentUsd, 0);
    assert.deepEqual([inner.calls(), other.calls()], [0, 0]);
  });
});

describe('difficulty CLI', () => {
  const ARGS = ['/golden/worlds/helpdesk', '--budget-usd', '2', '--out', '/golden/out', '--run-id', 'd1', '--engine-commit', 'abcdef1'];
  const refusal = (argv: readonly string[]): string => {
    try {
      parse(argv);
      return 'accepted';
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('parses the defaults and every option', () => {
    assert.deepEqual(parse(ARGS), {
      worlds: ['/golden/worlds/helpdesk'], tasks: null, models: [SONNET], episodes: 3, budgetUsd: 2, episodeBudgetUsd: 0.5, maxTurns: 12, maxMinutes: 5,
      out: '/golden/out', runId: 'd1', engineCommit: 'abcdef1', transport: undefined,
    });
    assert.deepEqual(parse([...ARGS, '--models', `${SONNET}, ${OPUS}`, '--task', 'a', '--task', 'b', '--episodes', '5', '--episode-budget-usd', '0.25', '--transport', 'sdk']), {
      worlds: ['/golden/worlds/helpdesk'], tasks: ['a', 'b'], models: [SONNET, OPUS], episodes: 5, budgetUsd: 2, episodeBudgetUsd: 0.25, maxTurns: 12, maxMinutes: 5,
      out: '/golden/out', runId: 'd1', engineCommit: 'abcdef1', transport: 'sdk',
    });
    assert.equal(parse(['--help']), 'help');
  });

  it('refuses a bad command line before any model call', () => {
    assert.deepEqual(
      [
        ARGS.slice(1),
        ARGS.filter((a, i) => i !== 1 && i !== 2),
        [...ARGS, '--episode-budget-usd', '3'],
        [...ARGS, '--models', 'gpt-5'],
        [...ARGS, '--models', `${SONNET},${SONNET}`],
        [...ARGS, '--episodes', '2.5'],
        [...ARGS.slice(0, 6), 'x'.repeat(57), ...ARGS.slice(7)],
        [...ARGS, '/golden/other/helpdesk'],
      ].map(refusal),
      [
        'name at least one world directory',
        '--budget-usd is required',
        '--episode-budget-usd 3 is more than --budget-usd 2, so no episode could start',
        '--models takes Claude model ids such as claude-sonnet-5-5, got "gpt-5"',
        '--models names a model twice',
        '--episodes needs a whole number, got 2.5',
        `--run-id must be 1 to 56 letters, digits, dots, dashes or underscores, starting with a letter or digit, with no "__" and no "_" at the end, got ${'x'.repeat(57)}`,
        'two worlds are named helpdesk; the matrix names a world by its directory',
      ],
    );
  });

  it('refuses a model with no known price with exit 2, before it checks a world or calls a model', () => {
    const out = tmp('cli');
    const r = spawnSync('bun', ['src/cli/difficulty.ts', HELPDESK, ...ARGS.slice(1, 3), '--out', out, ...ARGS.slice(5), '--models', `${SONNET},claude-haiku-5-5`], { cwd: CODE_DIR, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'no known price for claude-haiku-5-5: add prices.<model> with inputPerMTok and outputPerMTok to worldgen.config.json; no other model stands in\n');
    assert.equal(existsSync(path.join(out, 'difficulty.json')), false);
  });
});
