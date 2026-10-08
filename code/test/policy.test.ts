import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issue, type CheckIssue } from '#engine';
import { configSchema, type Config } from '../src/worldgen/config.ts';
import type { AttemptOutcome } from '../src/worldgen/events.ts';
import type { StepId } from '../src/worldgen/stages.ts';
import { attemptIssueSet, decide, issueSetKey, estimateCallMs, nextIsRepair, NO_CALLS, preflight, stepShareMs, ownerOf, record, recordBacktrack, recordStallRetry, type Decision, type Ledger, type OwnedIssue } from '../src/worldgen/policy.ts';

const budget = { maxAttempts: 4 };
const config: Config = {
  model: 'test-model',
  maxCostUsd: 5,
  maxMinutes: 30,
  maxBacktracks: 2,
  maxOutputTokens: 16000,
  steps: { plan: budget, model: budget, workflow: budget, seed: budget, tasks: budget },
  prices: {},
  exampleWorld: '../prod/worlds/helpdesk',
};

// Owners: bad -> model (entities), cyc -> model, tf -> workflow (a test run), cv -> seed (at_path seed),
// noop -> tasks, nc -> plan (at_path plan), warn -> seed but a warning.
const bad = issue('state.bad_machine', ['entities', 'ticket'], { problem: 'no initial state' }, 'none');
const cyc = issue('seed.cycle', ['entities', 'ticket'], { cycle: ['ticket', 'user'], refs: ['ticket.user', 'user.ticket'] }, 'ticket -> user -> ticket');
const tf = issue('test.failed', ['tests', 'close_ticket'], { message: 'status' }, 'open');
const cv = issue('constraint.violation', ['seed', 'ticket'], { entity: 'ticket', field: 'priority', rule: 'enum' }, 'urgent');
const noop = issue('task.noop_not_zero', ['tasks', 'refund'], { score: 1 }, '1');
const nc = issue('plan.not_covered', ['plan', 'entities', 0], { item: 'refund' }, 'missing');
const warn = issue('seed.too_few_rows_for_paging', ['seed', 'ticket'], { entity: 'ticket', rows: 3, pageSize: 10 }, '3');
// Plan coverage gaps, one per kind of planned item. Each is owned by the stage that builds the item.
const ncRoute = issue('plan.not_covered', ['plan', 'routes', 0], { item: 'route "list_refunds"' }, 'no routes.list_refunds');
const ncAction = issue('plan.not_covered', ['plan', 'workflows', 0, 'actions', 1], { item: 'action "refund"' }, 'no actions.refund');
const ncTask = issue('plan.not_covered', ['plan', 'tasks', 2], { item: 'task "t3"' }, 'no tasks.t3');
const ncJob = issue('plan.not_covered', ['plan', 'jobs', 0], { item: 'job "sla_breach"' }, 'no jobs.sla_breach');
// Section-rooted gaps (input conformance): owned by path[0], whatever the item is called.
const ncSeedTasks = issue('plan.not_covered', ['seed', 'tasks'], { item: 'entity "tasks"' }, 'no seed rows for tasks');
const ncSeedCtor = issue('plan.not_covered', ['seed', 'constructor'], { item: 'entity "constructor"' }, 'no seed rows for constructor');
const planShape = issue('schema.invalid', ['plan', 'entities', 0], { message: 'name required' }, 'undefined');

const owned = (...pairs: [CheckIssue, StepId][]): OwnedIssue[] => pairs.map(([i, o]) => ({ issue: i, owner: o }));
const rejected = (...is: CheckIssue[]): AttemptOutcome => ({ kind: 'rejected', issues: is });

const START = 1_000_000;
const MIN = 60_000;
const ledger = (o: Partial<Ledger> = {}): Ledger => ({
  startedAtMs: START,
  spentUsd: 0,
  attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 },
  backtracks: 0,
  seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] },
  stallRetries: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 },
  ...o,
});
const stalled: AttemptOutcome = { kind: 'stalled', idleMs: 120_000, progress: { messages: 0, outputTokens: 0, schemaRetries: 0, outputBytes: 0 } };
const KEY_TF = 'test.failed@tests/close_ticket: open';
const actionBad = issue('snippet.runtime_error', ['actions', 'close_ticket', 'handler'], { message: 'boom' }, 'boom');
const KEY_ACTION = 'snippet.runtime_error@actions/close_ticket/handler: boom';
const KEY_TF_AND_ACTION = 'snippet.runtime_error@actions/close_ticket/handler: boom|test.failed@tests/close_ticket: open';

// The airline live run run_20261007T051502Z_6b44181a: seed attempt 2 fixed booking_id on row 0 and failed flight_id on it.
const seatRef = (field: string, of: string, found: string) =>
  issue('constraint.violation', ['seed', 'seat'], { entity: 'seat', field, rule: `ref.unresolved (the id of an existing ${of})` }, found);
const seatBooking = seatRef('booking_id', 'booking', 'row 0, field booking_id: "bkg_0009"');
const seatBookingNext = seatRef('booking_id', 'booking', 'row 0, field booking_id: "bkg_0010"');
const seatFlight = seatRef('flight_id', 'flight', 'row 0, field flight_id: "flt_0001"');
const testsBlocked = issue('layer.blocked', ['tests'], { layer: 'seed' }, 'skipped layers: tests');
const KEY_BOOKING = 'constraint.violation@seed/seat: row 0, field booking_id: "*"|layer.blocked@tests: skipped layers: tests';
const KEY_FLIGHT = 'constraint.violation@seed/seat: row 0, field flight_id: "*"|layer.blocked@tests: skipped layers: tests';
const KEY_NOOP = 'task.noop_not_zero@tasks/refund: 1';
// The gen-todo-projects live iterate run (YOS-218): a paging claim the reference, which changes no task row, cannot show.
const pu = issue('task.pressure_unmet', ['tasks', 'archive_all'], { task: 'archive_all', need: 'paging: reaches a task row past the first page' }, 'no later page');
const KEY_PU = 'task.pressure_unmet@tasks/archive_all: no later page';
const KEY_PU_AND_NOOP = 'task.noop_not_zero@tasks/refund: 1|task.pressure_unmet@tasks/archive_all: no later page';
/** The key the loop records for a seed rejection with these issues. */
const seedKey = (...is: CheckIssue[]): string => attemptIssueSet(rejected(...is), is.map((i) => ({ issue: i, owner: 'seed' as const }))) ?? '';
const tasksKey = (i: CheckIssue): string => attemptIssueSet(rejected(i), owned([i, 'tasks'])) ?? '';
/**
 * worldgen-97: tasks saw `before` sets, backtracked to seed, then saw `after` sets. Built with record and
 * recordBacktrack as the loop does.
 */
const acrossBacktrack = (before: readonly string[], after: readonly string[]): Ledger => {
  let l = ledger({ attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 0 } });
  for (const k of before) l = record(l, 'tasks', 0, k);
  l = recordBacktrack(l, 'seed');
  l = record(l, 'seed', 0, null);
  for (const k of after) l = record(l, 'tasks', 0, k);
  return l;
};

type Row = {
  name: string;
  step: StepId;
  last?: boolean;
  ledger?: Partial<Ledger>;
  nowMs?: number;
  config?: Partial<Config>;
  outcome: AttemptOutcome;
  issues: OwnedIssue[];
  want: Decision;
};

const rows: Row[] = [
  { name: 'accepted advances', step: 'model', outcome: { kind: 'accepted', warnings: 0 }, issues: [], want: { kind: 'advance' } },
  { name: 'a call killed at its step share stops stage_time_exhausted', step: 'seed', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 0 } },
    outcome: { kind: 'share_expired', shareMs: 276_500, progress: { messages: 1, outputTokens: 9000, schemaRetries: 0, outputBytes: 0 } }, issues: [],
    want: { kind: 'stop', reason: { kind: 'stage_time_exhausted', step: 'seed', shareMs: 276_500 } } },
  { name: 'a check cut at the run deadline stops time_exhausted, even with time left on the injected clock', step: 'seed', nowMs: START + MIN,
    ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 2, tasks: 0 } },
    outcome: { kind: 'judge_expired' }, issues: [],
    want: { kind: 'stop', reason: { kind: 'time_exhausted', minutes: 30 } } },
  { name: 'a stalled call with no stall retry yet retries', step: 'plan', ledger: { attempts: { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 } },
    outcome: stalled, issues: [], want: { kind: 'retry' } },
  { name: 'a second stall on the same step stops transport_stalled', step: 'plan',
    ledger: { attempts: { plan: 2, model: 0, workflow: 0, seed: 0, tasks: 0 }, stallRetries: { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 } },
    outcome: stalled, issues: [], want: { kind: 'stop', reason: { kind: 'transport_stalled', step: 'plan', idleMs: 120_000 } } },
  { name: 'a stall at maxAttempts still retries: a stall is outside maxAttempts', step: 'workflow', ledger: { attempts: { plan: 1, model: 1, workflow: 4, seed: 0, tasks: 0 } },
    outcome: stalled, issues: [], want: { kind: 'retry' } },
  { name: 'a stall retry on another step does not count against this one', step: 'seed',
    ledger: { attempts: { plan: 2, model: 1, workflow: 1, seed: 1, tasks: 0 }, stallRetries: { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 } },
    outcome: stalled, issues: [], want: { kind: 'retry' } },
  { name: 'the attempt after a stall retry is not charged the stalled call', step: 'workflow',
    ledger: { attempts: { plan: 1, model: 1, workflow: 4, seed: 0, tasks: 0 }, stallRetries: { plan: 0, model: 0, workflow: 1, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: ['a', 'b', KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']), want: { kind: 'retry' } },
  { name: 'accepted with warnings advances', step: 'seed', outcome: { kind: 'accepted', warnings: 2 }, issues: owned([warn, 'seed']), want: { kind: 'advance' } },
  { name: 'first rejection retries', step: 'workflow', ledger: { attempts: { plan: 0, model: 0, workflow: 1, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']), want: { kind: 'retry' } },
  { name: 'rejection at attempts 3 of 4 still retries', step: 'workflow', ledger: { attempts: { plan: 0, model: 0, workflow: 3, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: ['a', 'b', KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']), want: { kind: 'retry' } },
  { name: 'attempts at the limit stops attempts_exhausted', step: 'workflow', ledger: { attempts: { plan: 0, model: 0, workflow: 4, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: ['a', 'b', 'c', KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']),
    want: { kind: 'stop', reason: { kind: 'attempts_exhausted', step: 'workflow', attempts: 4, lastIssues: [tf] } } },
  { name: 'per-step maxAttempts is honoured', step: 'plan', config: { steps: { plan: { maxAttempts: 1 }, model: budget, workflow: budget, seed: budget, tasks: budget } },
    ledger: { attempts: { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 }, seenIssueSets: { plan: ['x'], model: [], workflow: [], seed: [], tasks: [] } },
    outcome: rejected(nc), issues: owned([nc, 'plan']),
    want: { kind: 'stop', reason: { kind: 'attempts_exhausted', step: 'plan', attempts: 1, lastIssues: [nc] } } },
  // A-161: workflow cannot edit the plan's frozen tests, so a repeated failing test goes back to the plan that wrote it.
  { name: 'a frozen test failing twice at workflow backtracks to plan, not no_progress', step: 'workflow', ledger: { attempts: { plan: 1, model: 1, workflow: 2, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [KEY_TF, KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']), want: { kind: 'backtrack', to: 'plan' } },
  { name: 'a frozen test failing twice at workflow stops backtrack_limit when no backtrack is left', step: 'workflow', ledger: { backtracks: 2, attempts: { plan: 1, model: 1, workflow: 2, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [KEY_TF, KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']), want: { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'workflow', backtracks: 2 } } },
  { name: 'a failing test repeated beside a workflow error still stops no_progress', step: 'workflow', ledger: { attempts: { plan: 1, model: 1, workflow: 2, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [KEY_TF_AND_ACTION, KEY_TF_AND_ACTION], seed: [], tasks: [] } },
    outcome: rejected(tf, actionBad), issues: owned([tf, 'workflow'], [actionBad, 'workflow']),
    want: { kind: 'stop', reason: { kind: 'no_progress', step: 'workflow', repeatedIssueSet: KEY_TF_AND_ACTION, lastIssues: [tf, actionBad] } } },
  // A-165: the seed cannot edit the plan's frozen tests either, so a failing test it keeps repeating goes back to plan.
  { name: 'a frozen test failing twice at seed backtracks to plan, not no_progress', step: 'seed', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 2, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [KEY_TF, KEY_TF], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'seed']), want: { kind: 'backtrack', to: 'plan' } },
  { name: 'a frozen test failing twice at seed stops backtrack_limit when no backtrack is left', step: 'seed', ledger: { backtracks: 2, attempts: { plan: 1, model: 1, workflow: 1, seed: 2, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [KEY_TF, KEY_TF], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'seed']), want: { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'seed', backtracks: 2 } } },
  { name: 'a failing test repeated beside a seed error still stops no_progress at seed', step: 'seed', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 2, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [KEY_TF_AND_ACTION, KEY_TF_AND_ACTION], tasks: [] } },
    outcome: rejected(tf, actionBad), issues: owned([tf, 'seed'], [actionBad, 'seed']),
    want: { kind: 'stop', reason: { kind: 'no_progress', step: 'seed', repeatedIssueSet: KEY_TF_AND_ACTION, lastIssues: [tf, actionBad] } } },
  // A-285: only the plan can drop a pressure claim, so one the tasks step keeps missing goes back to the plan.
  { name: 'an unmet pressure claim once at tasks retries', step: 'tasks', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 1 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [KEY_PU] } },
    outcome: rejected(pu), issues: owned([pu, 'tasks']), want: { kind: 'retry' } },
  { name: 'an unmet pressure claim twice at tasks backtracks to plan, not no_progress', step: 'tasks', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 2 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [KEY_PU, KEY_PU] } },
    outcome: rejected(pu), issues: owned([pu, 'tasks']), want: { kind: 'backtrack', to: 'plan' } },
  { name: 'an unmet pressure claim twice at tasks stops backtrack_limit when no backtrack is left', step: 'tasks', ledger: { backtracks: 2, attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 2 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [KEY_PU, KEY_PU] } },
    outcome: rejected(pu), issues: owned([pu, 'tasks']), want: { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'tasks', backtracks: 2 } } },
  { name: 'an unmet pressure claim repeated beside another tasks error still stops no_progress', step: 'tasks', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 2 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [KEY_PU_AND_NOOP, KEY_PU_AND_NOOP] } },
    outcome: rejected(pu, noop), issues: owned([pu, 'tasks'], [noop, 'tasks']),
    want: { kind: 'stop', reason: { kind: 'no_progress', step: 'tasks', repeatedIssueSet: KEY_PU_AND_NOOP, lastIssues: [pu, noop] } } },
  { name: 'a different earlier set does not trigger no_progress', step: 'workflow', ledger: { attempts: { plan: 0, model: 0, workflow: 2, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: ['other', KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']), want: { kind: 'retry' } },
  { name: 'the same set seen on another step is not a repeat', step: 'workflow', ledger: { attempts: { plan: 0, model: 2, workflow: 1, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [KEY_TF, KEY_TF], workflow: [KEY_TF], seed: [], tasks: [] } },
    outcome: rejected(tf), issues: owned([tf, 'workflow']), want: { kind: 'retry' } },
  { name: 'all blockers owned earlier backtracks', step: 'tasks', ledger: { attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 1 } },
    outcome: rejected(bad), issues: owned([bad, 'model']), want: { kind: 'backtrack', to: 'model' } },
  { name: 'backtrack goes to the earliest owner', step: 'tasks', ledger: { attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 1 } },
    outcome: rejected(cv, bad, tf), issues: owned([cv, 'seed'], [tf, 'workflow'], [bad, 'model']), want: { kind: 'backtrack', to: 'model' } },
  { name: 'one blocker owned by the current step prevents backtrack', step: 'seed', ledger: { attempts: { plan: 0, model: 0, workflow: 0, seed: 1, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: ['k'], tasks: [] } },
    outcome: rejected(bad, cv), issues: owned([bad, 'model'], [cv, 'seed']), want: { kind: 'retry' } },
  { name: 'a rejection blocked only by a warning owned earlier backtracks to its owner (A-270)', step: 'tasks', ledger: { attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 1 } },
    outcome: rejected(warn), issues: owned([warn, 'seed']), want: { kind: 'backtrack', to: 'seed' } },
  { name: 'a warning owned earlier does not force a backtrack', step: 'tasks', ledger: { attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 1 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: ['k'] } },
    outcome: rejected(noop, warn), issues: owned([noop, 'tasks'], [warn, 'seed']), want: { kind: 'retry' } },
  { name: 'backtracks past the limit stop backtrack_limit', step: 'tasks', ledger: { backtracks: 2, attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 1 } },
    outcome: rejected(cyc), issues: owned([cyc, 'model']), want: { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'tasks', backtracks: 2 } } },
  { name: 'maxBacktracks 0 stops at the first backtrack', step: 'workflow', config: { maxBacktracks: 0 }, ledger: { attempts: { plan: 0, model: 0, workflow: 1, seed: 0, tasks: 0 } },
    outcome: rejected(bad), issues: owned([bad, 'model']), want: { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'workflow', backtracks: 0 } } },
  { name: 'backtrack wins over attempts_exhausted', step: 'tasks', ledger: { attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 4 } },
    outcome: rejected(bad), issues: owned([bad, 'model']), want: { kind: 'backtrack', to: 'model' } },
  { name: 'backtrack wins over no_progress', step: 'tasks', ledger: { attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 2 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: ['state.bad_machine@entities/ticket: none', 'state.bad_machine@entities/ticket: none'] } },
    outcome: rejected(bad), issues: owned([bad, 'model']), want: { kind: 'backtrack', to: 'model' } },
  { name: 'plan issues at the plan step retry, not backtrack', step: 'plan', ledger: { attempts: { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 } },
    outcome: rejected(planShape), issues: owned([planShape, 'plan']), want: { kind: 'retry' } },
  { name: 'a coverage gap raised at the plan step retries plan', step: 'plan', ledger: { attempts: { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 } },
    outcome: rejected(nc), issues: owned([nc, ownerOf(nc)]), want: { kind: 'retry' } },
  { name: 'model stage missing a planned entity retries model, not backtrack to plan', step: 'model', ledger: { attempts: { plan: 1, model: 1, workflow: 0, seed: 0, tasks: 0 } },
    outcome: rejected(nc), issues: owned([nc, ownerOf(nc)]), want: { kind: 'retry' } },
  { name: 'model stage missing a planned route retries model', step: 'model', ledger: { attempts: { plan: 1, model: 2, workflow: 0, seed: 0, tasks: 0 } },
    outcome: rejected(ncRoute), issues: owned([ncRoute, ownerOf(ncRoute)]), want: { kind: 'retry' } },
  { name: 'workflow stage missing a planned action retries workflow', step: 'workflow', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 0, tasks: 0 } },
    outcome: rejected(ncAction), issues: owned([ncAction, ownerOf(ncAction)]), want: { kind: 'retry' } },
  { name: 'workflow stage missing a planned job retries workflow, not backtrack to plan', step: 'workflow', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 0, tasks: 0 } },
    outcome: rejected(ncJob), issues: owned([ncJob, ownerOf(ncJob)]), want: { kind: 'retry' } },
  { name: 'tasks stage missing a planned task retries tasks', step: 'tasks', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 1 } },
    outcome: rejected(ncTask), issues: owned([ncTask, ownerOf(ncTask)]), want: { kind: 'retry' } },
  { name: 'a planned entity still missing at the tasks stage backtracks to model, not plan', step: 'tasks', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 1 } },
    outcome: rejected(nc), issues: owned([nc, ownerOf(nc)]), want: { kind: 'backtrack', to: 'model' } },
  { name: 'a seed-rooted gap on an entity named tasks raised at tasks backtracks to seed', step: 'tasks', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 1 } },
    outcome: rejected(ncSeedTasks), issues: owned([ncSeedTasks, ownerOf(ncSeedTasks)]), want: { kind: 'backtrack', to: 'seed' } },
  { name: 'a seed-rooted gap on an entity named constructor raised at tasks backtracks to seed', step: 'tasks', ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 1 } },
    outcome: rejected(ncSeedCtor), issues: owned([ncSeedCtor, ownerOf(ncSeedCtor)]), want: { kind: 'backtrack', to: 'seed' } },
  { name: 'invalid_output retries and never backtracks', step: 'workflow', ledger: { attempts: { plan: 0, model: 0, workflow: 1, seed: 0, tasks: 0 } },
    outcome: { kind: 'invalid_output', issues: [nc] }, issues: [], want: { kind: 'retry' } },
  { name: 'invalid_output repeated stops no_progress', step: 'workflow', ledger: { attempts: { plan: 0, model: 0, workflow: 2, seed: 0, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: ['plan.not_covered@plan/entities/0: missing', 'plan.not_covered@plan/entities/0: missing'], seed: [], tasks: [] } },
    outcome: { kind: 'invalid_output', issues: [nc] }, issues: [],
    want: { kind: 'stop', reason: { kind: 'no_progress', step: 'workflow', repeatedIssueSet: 'plan.not_covered@plan/entities/0: missing', lastIssues: [nc] } } },
  { name: 'the same row failing on another field is progress: retry (airline seed)', step: 'seed',
    ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 2, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [seedKey(seatBooking, testsBlocked), seedKey(seatFlight, testsBlocked)], tasks: [] } },
    outcome: rejected(seatFlight, testsBlocked), issues: owned([seatFlight, 'seed'], [testsBlocked, 'workflow']), want: { kind: 'retry' } },
  { name: 'the same field failing again with another quoted id stops no_progress', step: 'seed',
    ledger: { attempts: { plan: 1, model: 1, workflow: 1, seed: 2, tasks: 0 }, seenIssueSets: { plan: [], model: [], workflow: [], seed: [seedKey(seatBooking, testsBlocked), seedKey(seatBookingNext, testsBlocked)], tasks: [] } },
    outcome: rejected(seatBookingNext, testsBlocked), issues: owned([seatBookingNext, 'seed'], [testsBlocked, 'workflow']),
    want: { kind: 'stop', reason: { kind: 'no_progress', step: 'seed', repeatedIssueSet: KEY_BOOKING, lastIssues: [seatBookingNext, testsBlocked] } } },
  { name: 'a set seen before a backtrack and once after it retries', step: 'tasks', ledger: acrossBacktrack([tasksKey(noop), 'k'], [tasksKey(noop)]),
    outcome: rejected(noop), issues: owned([noop, 'tasks']), want: { kind: 'retry' } },
  { name: 'a set seen twice after a backtrack stops no_progress', step: 'tasks', ledger: acrossBacktrack(['k'], [tasksKey(noop), tasksKey(noop)]),
    outcome: rejected(noop), issues: owned([noop, 'tasks']),
    want: { kind: 'stop', reason: { kind: 'no_progress', step: 'tasks', repeatedIssueSet: KEY_NOOP, lastIssues: [noop] } } },
  { name: 'model_error stops', step: 'model', outcome: { kind: 'model_error', message: 'overloaded' }, issues: [],
    want: { kind: 'stop', reason: { kind: 'model_error', message: 'overloaded' } } },
  { name: 'spend at the limit stops budget_exhausted before accepting', step: 'model', ledger: { spentUsd: 5 }, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 5, limitUsd: 5 } } },
  { name: 'spend just under the limit proceeds', step: 'model', ledger: { spentUsd: 4.99 }, outcome: { kind: 'accepted', warnings: 0 }, issues: [], want: { kind: 'advance' } },
  { name: 'accepted last step whose call crossed the budget advances and reports the overspend', step: 'tasks', ledger: { spentUsd: 5.0001 }, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'advance', overspent: { spentUsd: 5.0001, limitUsd: 5 } } },
  { name: 'accepted last step exactly at the budget advances with the overspend', step: 'tasks', ledger: { spentUsd: 5 }, outcome: { kind: 'accepted', warnings: 1 }, issues: [],
    want: { kind: 'advance', overspent: { spentUsd: 5, limitUsd: 5 } } },
  { name: 'last: true marks an earlier step as the end of an iterate run', step: 'seed', last: true, ledger: { spentUsd: 6 }, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'advance', overspent: { spentUsd: 6, limitUsd: 5 } } },
  { name: 'last: false at tasks still stops over budget', step: 'tasks', last: false, ledger: { spentUsd: 6 }, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 6, limitUsd: 5 } } },
  { name: 'accepted on a non-last step over budget stops: no further call is allowed', step: 'workflow', ledger: { spentUsd: 5.5 }, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 5.5, limitUsd: 5 } } },
  { name: 'a rejection on the last step over budget stops', step: 'tasks', ledger: { spentUsd: 5.5, attempts: { plan: 1, model: 1, workflow: 1, seed: 1, tasks: 1 } }, outcome: rejected(noop), issues: owned([noop, 'tasks']),
    want: { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 5.5, limitUsd: 5 } } },
  { name: 'time still stops an accepted last step that crossed the budget', step: 'tasks', ledger: { spentUsd: 5.5 }, nowMs: START + 30 * MIN, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'stop', reason: { kind: 'time_exhausted', minutes: 30 } } },
  { name: 'budget is checked before a backtrack', step: 'tasks', ledger: { spentUsd: 7.5 }, outcome: rejected(bad), issues: owned([bad, 'model']),
    want: { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 7.5, limitUsd: 5 } } },
  { name: 'elapsed at maxMinutes stops time_exhausted before accepting', step: 'model', nowMs: START + 30 * MIN, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'stop', reason: { kind: 'time_exhausted', minutes: 30 } } },
  { name: 'elapsed just under maxMinutes proceeds', step: 'model', nowMs: START + 30 * MIN - 1, outcome: { kind: 'accepted', warnings: 0 }, issues: [], want: { kind: 'advance' } },
  { name: 'budget beats time when both are spent', step: 'model', ledger: { spentUsd: 6 }, nowMs: START + 99 * MIN, outcome: { kind: 'accepted', warnings: 0 }, issues: [],
    want: { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: 6, limitUsd: 5 } } },
];

describe('decide', () => {
  for (const row of rows) {
    it(row.name, () => {
      const cfg: Config = { ...config, ...row.config };
      const state = { step: row.step, ledger: ledger(row.ledger), nowMs: row.nowMs ?? START + MIN };
      const got = decide(cfg, row.last === undefined ? state : { ...state, last: row.last }, row.outcome, row.issues);
      assert.deepEqual(got, row.want);
    });
  }

  it('table has at least 12 rows', () => {
    assert.equal(rows.length >= 12, true);
  });
});

describe('ownerOf', () => {
  const table: [string, CheckIssue, StepId][] = [
    ['fixed owner entities maps to model', bad, 'model'],
    ['fixed owner tasks maps to tasks', noop, 'tasks'],
    ['test.failed at tests maps to workflow, which fixes the implementation', tf, 'workflow'],
    ['layer.blocked at tests maps to workflow', issue('layer.blocked', ['tests'], { layer: 'tests' }, 'skipped layers: tests'), 'workflow'],
    ['iterate.regression of an old test maps to workflow', issue('iterate.regression', ['tests', 'old'], { what: 'w' }, 'f'), 'workflow'],
    ['an action no test calls maps to workflow, which wrote the action, not to plan (YOS-127)', issue('action.unexercised', ['actions', 'x'], { action: 'x' }, 'no test calls x'), 'workflow'],
    ['an edit that writes tests maps to plan, which owns them', issue('edit.out_of_scope', ['tests'], { section: 'tests', allowed: ['actions', 'jobs'] }, 'upsert.tests'), 'plan'],
    ['layer.blocked elsewhere follows its path', issue('layer.blocked', ['tasks'], { layer: 'tasks' }, 'skipped layers: tasks'), 'tasks'],
    ['at_path with path[0] seed maps to seed', cv, 'seed'],
    ['at_path with path[0] plan maps to plan', planShape, 'plan'],
    ['plan.lifecycle_unrepresented maps to plan, which writes the lifecycle the path names, not to the model or workflow stage (YOS-155)', issue('plan.lifecycle_unrepresented', ['plan', 'workflows', 0, 'lifecycle'], { workflow: 'escalation', entity: 'ticket', states: ['escalated', 'acknowledged'] }, 'no state field of ticket declares any state of this workflow'), 'plan'],
    ['plan.not_covered for an entity maps to model', nc, 'model'],
    ['plan.not_covered for a route maps to model', ncRoute, 'model'],
    ['plan.not_covered for a workflow action maps to workflow', ncAction, 'workflow'],
    ['plan.not_covered for a task maps to tasks', ncTask, 'tasks'],
    ['at_path with path[0] routes maps to model', issue('schema.invalid', ['routes', 'x'], { message: 'm' }, 'f'), 'model'],
    ['at_path with path[0] jobs maps to workflow', issue('schema.invalid', ['jobs', 'x'], { message: 'm' }, 'f'), 'workflow'],
    ['at_path with path[0] fixtures maps to model', issue('schema.invalid', ['fixtures', 'x'], { message: 'm' }, 'f'), 'model'],
    ['at_path with path[0] meta maps to plan', issue('schema.invalid', ['meta', 'name'], { message: 'm' }, 'f'), 'plan'],
    ['plan.not_covered rooted at seed for an entity named tasks maps to seed', issue('plan.not_covered', ['seed', 'tasks'], { item: 'entity "tasks"' }, 'no seed rows'), 'seed'],
    ['plan.not_covered rooted at routes maps to model', issue('plan.not_covered', ['routes', 'GET /x'], { item: 'route "GET /x"' }, 'no route'), 'model'],
    ['plan.not_covered rooted at meta maps to plan', issue('plan.not_covered', ['meta', 'api', 'error'], { item: 'error envelope' }, 'no envelope'), 'plan'],
    ['plan.not_covered rooted at seed for an entity named constructor maps to seed', issue('plan.not_covered', ['seed', 'constructor'], { item: 'entity "constructor"' }, 'no seed rows'), 'seed'],
    ['plan.not_covered for a plan kind named constructor maps to plan', issue('plan.not_covered', ['plan', 'constructor', 0], { item: 'x' }, 'x'), 'plan'],
    ['at_path with path[0] input maps to plan', issue('schema.invalid', ['input'], { message: 'm' }, 'f'), 'plan'],
  ];
  for (const [name, i, want] of table) {
    it(name, () => {
      assert.equal(ownerOf(i), want);
    });
  }
});

describe('issueSetKey', () => {
  it('sorts and de-duplicates by code, path and found', () => {
    assert.equal(issueSetKey([tf, bad, tf]), 'state.bad_machine@entities/ticket: none|test.failed@tests/close_ticket: open');
  });

  it('keys the airline pair apart: the same row on another field is a different issue', () => {
    assert.equal(issueSetKey([seatBooking, testsBlocked]), KEY_BOOKING);
    assert.equal(issueSetKey([testsBlocked, seatFlight]), KEY_FLIGHT);
  });

  it('masks quoted values, so the same field with another id is the same issue', () => {
    assert.equal(issueSetKey([seatBookingNext, testsBlocked]), KEY_BOOKING);
    assert.equal(issueSetKey([seatBooking, seatBookingNext]), 'constraint.violation@seed/seat: row 0, field booking_id: "*"');
  });

  it('masks double- and single-quoted literals with escapes, collapses whitespace, and keeps unquoted numbers', () => {
    const found = (f: string) => issueSetKey([issue('constraint.violation', ['seed', 'seat'], { entity: 'seat', field: 'id', rule: 'unique' }, f)]);
    assert.equal(found('row 3,\n  field id:  "a\\"b" and \'it\\\'s\'  '), 'constraint.violation@seed/seat: row 3, field id: "*" and "*"');
    assert.equal(found('row 0, field id: "x"'), 'constraint.violation@seed/seat: row 0, field id: "*"');
    assert.equal(found("the plan's entity doesn't exist"), "constraint.violation@seed/seat: the plan's entity doesn't exist");
    assert.equal(found('{"status":"open","n":2}'), 'constraint.violation@seed/seat: {"*":"*","*":2}');
  });

  it('escapes the set separator inside an entry', () => {
    assert.equal(issueSetKey([issue('test.failed', ['tests', 'a'], { message: 'm' }, 'string | null'), tf]),
      'test.failed@tests/a: string \\| null|test.failed@tests/close_ticket: open');
  });
});

describe('record', () => {
  it('returns a new ledger with attempt, cost and issue set added', () => {
    const before = ledger({ spentUsd: 1.5 });
    const after = record(before, 'seed', 0.25, 'k1');
    assert.equal(after.spentUsd, 1.75);
    assert.deepEqual(after.attempts, { plan: 0, model: 0, workflow: 0, seed: 1, tasks: 0 });
    assert.deepEqual(after.seenIssueSets, { plan: [], model: [], workflow: [], seed: ['k1'], tasks: [] });
    assert.equal(after.backtracks, 0);
    assert.equal(after.startedAtMs, START);
  });

  it('keeps the seen sets when the attempt was accepted (null set)', () => {
    const after = record(ledger({ seenIssueSets: { plan: [], model: ['k'], workflow: [], seed: [], tasks: [] } }), 'model', 0, null);
    assert.deepEqual(after.seenIssueSets.model, ['k']);
    assert.equal(after.attempts.model, 1);
  });

  it('never mutates its input, even when frozen deeply', () => {
    const before = ledger();
    Object.freeze(before.attempts);
    Object.freeze(before.seenIssueSets.model);
    Object.freeze(before.seenIssueSets);
    Object.freeze(before);
    const snapshot = JSON.stringify(before);
    const after = record(before, 'model', 1, 'k');
    assert.notEqual(after, before);
    assert.equal(JSON.stringify(before), snapshot);
    assert.equal(after.attempts.model, 1);
  });

  it('recordBacktrack adds one and leaves the input alone', () => {
    const before = ledger({ backtracks: 1 });
    const after = recordBacktrack(before, 'model');
    assert.equal(after.backtracks, 2);
    assert.equal(before.backtracks, 1);
  });

  it('recordBacktrack resets the target step attempts, keeps the other attempts, and starts a new stretch of seen sets', () => {
    const before = ledger({
      backtracks: 0,
      attempts: { plan: 1, model: 4, workflow: 2, seed: 1, tasks: 3 },
      seenIssueSets: { plan: [], model: ['a'], workflow: [], seed: [], tasks: ['b'] },
    });
    Object.freeze(before.attempts);
    Object.freeze(before);
    const after = recordBacktrack(before, 'model');
    assert.deepEqual(after.attempts, { plan: 1, model: 0, workflow: 2, seed: 1, tasks: 3 });
    assert.deepEqual(after.seenIssueSets, { plan: [], model: [], workflow: [], seed: [], tasks: [] });
    assert.equal(after.backtracks, 1);
    assert.deepEqual(before.attempts, { plan: 1, model: 4, workflow: 2, seed: 1, tasks: 3 });
  });

  it('recordStallRetry counts one stall retry on its step and leaves the input alone', () => {
    const before = ledger({ attempts: { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 } });
    Object.freeze(before.stallRetries);
    Object.freeze(before);
    const after = recordStallRetry(before, 'plan');
    assert.deepEqual(after.stallRetries, { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 });
    assert.deepEqual(after.attempts, { plan: 1, model: 0, workflow: 0, seed: 0, tasks: 0 });
    assert.deepEqual(before.stallRetries, { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 });
  });

  it('recordBacktrack gives the target step its stall retry back with its attempts', () => {
    const before = ledger({ attempts: { plan: 1, model: 3, workflow: 2, seed: 0, tasks: 0 }, stallRetries: { plan: 1, model: 1, workflow: 1, seed: 0, tasks: 0 } });
    const after = recordBacktrack(before, 'model');
    assert.deepEqual(after.stallRetries, { plan: 1, model: 0, workflow: 1, seed: 0, tasks: 0 });
    assert.deepEqual(after.attempts, { plan: 1, model: 0, workflow: 2, seed: 0, tasks: 0 });
  });

  it('a step backtracked to after using all its attempts gets its repair budget again', () => {
    // model used 4 of 4 and was accepted; tasks then found a model-owned error.
    let l = ledger({ attempts: { plan: 1, model: 4, workflow: 1, seed: 1, tasks: 0 }, seenIssueSets: { plan: [], model: ['a', 'b', 'c'], workflow: [], seed: [], tasks: [] } });
    l = record(l, 'tasks', 0.1, 'state.bad_machine@entities/ticket');
    const d = decide(config, { step: 'tasks', ledger: l, nowMs: START + MIN }, rejected(bad), owned([bad, 'model']));
    assert.deepEqual(d, { kind: 'backtrack', to: 'model' });
    l = recordBacktrack(l, 'model');
    l = record(l, 'model', 0.1, 'seed.cycle@entities/ticket');
    assert.equal(l.attempts.model, 1);
    assert.deepEqual(decide(config, { step: 'model', ledger: l, nowMs: START + MIN }, rejected(cyc), owned([cyc, 'model'])), { kind: 'retry' });
  });

  it('backtracks stay bounded by maxBacktracks with the reset: an upstream error that never clears stops backtrack_limit', () => {
    let l = ledger();
    let step: StepId = 'tasks';
    const steps: string[] = [];
    let d: Decision = { kind: 'retry' };
    for (let guard = 0; guard < 50 && d.kind !== 'stop'; guard++) {
      steps.push(step);
      if (step === 'tasks') {
        l = record(l, 'tasks', 0.01, 'state.bad_machine@entities/ticket');
        d = decide(config, { step, ledger: l, nowMs: START + MIN }, rejected(bad), owned([bad, 'model']));
        if (d.kind === 'backtrack') {
          l = recordBacktrack(l, d.to);
          step = d.to;
        }
      } else {
        l = record(l, step, 0.01, null);
        step = 'tasks';
      }
    }
    assert.deepEqual(steps, ['tasks', 'model', 'tasks', 'model', 'tasks']);
    assert.deepEqual(d, { kind: 'stop', reason: { kind: 'backtrack_limit', step: 'tasks', backtracks: 2 } });
    assert.equal(l.backtracks, 2);
  });

  it('record then decide: the second identical rejection stops no_progress', () => {
    let l = record(ledger(), 'workflow', 0.1, KEY_ACTION);
    assert.deepEqual(decide(config, { step: 'workflow', ledger: l, nowMs: START + MIN }, rejected(actionBad), owned([actionBad, 'workflow'])), { kind: 'retry' });
    l = record(l, 'workflow', 0.1, KEY_ACTION);
    assert.deepEqual(decide(config, { step: 'workflow', ledger: l, nowMs: START + MIN }, rejected(actionBad), owned([actionBad, 'workflow'])), {
      kind: 'stop',
      reason: { kind: 'no_progress', step: 'workflow', repeatedIssueSet: KEY_ACTION, lastIssues: [actionBad] },
    });
  });

  it('record via attemptIssueSet with an error plus a warning: second identical rejection stops no_progress', () => {
    const outcome = rejected(actionBad, warn);
    const iss = owned([actionBad, 'workflow'], [warn, 'seed']);
    assert.equal(attemptIssueSet(outcome, iss), KEY_ACTION);
    let l = record(ledger(), 'workflow', 0.1, attemptIssueSet(outcome, iss));
    assert.deepEqual(decide(config, { step: 'workflow', ledger: l, nowMs: START + MIN }, outcome, iss), { kind: 'retry' });
    l = record(l, 'workflow', 0.1, attemptIssueSet(outcome, iss));
    assert.deepEqual(l.seenIssueSets.workflow, [KEY_ACTION, KEY_ACTION]);
    assert.deepEqual(decide(config, { step: 'workflow', ledger: l, nowMs: START + MIN }, outcome, iss), {
      kind: 'stop',
      reason: { kind: 'no_progress', step: 'workflow', repeatedIssueSet: KEY_ACTION, lastIssues: [actionBad] },
    });
  });
});

describe('attemptIssueSet', () => {
  it('is null for accepted and model_error', () => {
    assert.equal(attemptIssueSet({ kind: 'accepted', warnings: 1 }, owned([warn, 'seed'])), null);
    assert.equal(attemptIssueSet({ kind: 'model_error', message: 'x' }, []), null);
  });

  it('keys only blocking errors of a rejection', () => {
    assert.equal(attemptIssueSet(rejected(warn, tf), owned([warn, 'seed'], [tf, 'workflow'])), KEY_TF);
  });

  it('keys all issues when a rejection has only warnings', () => {
    assert.equal(attemptIssueSet(rejected(warn), owned([warn, 'seed'])), 'seed.too_few_rows_for_paging@seed/ticket: 3');
  });

  it('keys the outcome issues of invalid_output', () => {
    assert.equal(attemptIssueSet({ kind: 'invalid_output', issues: [nc] }, []), 'plan.not_covered@plan/entities/0: missing');
  });
});

describe('preflight', () => {
  // config: maxCostUsd 5. A run started at 0 with spentUsd 4.5.
  const ledger = { startedAtMs: 0, spentUsd: 4.5, attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 }, backtracks: 0, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] }, stallRetries: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 } };
  const limitMs = config.maxMinutes * 60_000;
  const cases = [
    { name: 'a call that fits exactly goes ahead', nowMs: 0, usd: 0.5, ms: 0, want: null },
    { name: 'a call that would cross the budget stops before spending', nowMs: 0, usd: 0.51, ms: 0, want: { kind: 'budget_exhausted', spentUsd: 4.5, limitUsd: 5 } },
    { name: 'an unpriced call (estimate 0) goes ahead', nowMs: 0, usd: 0, ms: 0, want: null },
    { name: 'a call that ends exactly at the time limit goes ahead', nowMs: limitMs - 60_000, usd: 0, ms: 60_000, want: null },
    { name: 'a call that would run past the time limit stops first', nowMs: limitMs - 60_000, usd: 0, ms: 60_001, want: { kind: 'time_exhausted', minutes: config.maxMinutes } },
    { name: 'budget is checked before time', nowMs: limitMs, usd: 1, ms: 1, want: { kind: 'budget_exhausted', spentUsd: 4.5, limitUsd: 5 } },
  ] as const;
  for (const c of cases) it(c.name, () => assert.deepEqual(preflight(config, ledger, c.nowMs, c.usd, c.ms), c.want));

  const fresh = { ...ledger, spentUsd: 0 };
  it('a call that fits the run but not its step share is refused with the share', () => {
    // 15-minute run, 100 s in: workflow keeps the seed and tasks first-call estimates, 123 s and 132 s, so its share is 545 s.
    assert.deepEqual(preflight(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), fresh, 100_000, 0, 545_001, 'workflow'),
      { kind: 'stage_time_exhausted', step: 'workflow', shareMs: 545_000 });
  });
  it('a call that fits its step share goes ahead', () => {
    assert.equal(preflight(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), fresh, 100_000, 0, 545_000, 'workflow'), null);
  });
  // The seed stage of the live library run: a 262 s first attempt was rejected, 238 s of the step share remain.
  it('a repair after a 262 s first attempt fits a 223 s share, since the repair is estimated at a quarter', () => {
    const ms = estimateCallMs('medium', [{ ms: 262_000, repair: false }], true);
    assert.equal(ms, 65_500);
    // 15-minute run, 545 s elapsed: seed keeps the 132 s tasks estimate, so the share is 900 - 545 - 132 = 223 s.
    assert.equal(preflight(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), fresh, 545_000, 0, ms, 'seed'), null);
  });
  it('a repair whose own estimate exceeds the share is still refused with the share', () => {
    const ms = estimateCallMs('medium', [{ ms: 262_000, repair: false }, { ms: 120_000, repair: true }], true);
    assert.equal(ms, 120_000);
    assert.deepEqual(preflight(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), fresh, 700_000, 0, ms, 'seed'),
      { kind: 'stage_time_exhausted', step: 'seed', shareMs: 68_000 });
  });
  it('a call that overruns the whole run is time_exhausted, not a share refusal', () => {
    assert.deepEqual(preflight(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), fresh, 800_000, 0, 100_001, 'tasks'),
      { kind: 'time_exhausted', minutes: 15, refused: { step: 'tasks', estimateMs: 100_001, remainingMs: 100_000 } });
  });
});

describe('the tasks reserve is never below the tasks call estimate (A-114)', () => {
  const cfg = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
  const fresh = { startedAtMs: 0, spentUsd: 0, attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 }, backtracks: 0, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] }, stallRetries: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 } };
  const tasksRan = { ...NO_CALLS, tasks: [{ ms: 180_000, repair: false }] };

  it('the live library run: seed attempt 2 starts at 624.4 s; tasks keeps its 132 s first-call estimate, or a 45 s repair after a 180 s tasks call (A-330)', () => {
    assert.equal(stepShareMs(cfg, fresh, 'seed', 624_400), 143_600);
    assert.equal(stepShareMs(cfg, fresh, 'seed', 624_400, tasksRan), 230_600);
  });
  it('a seed call that runs to its share leaves the estimate of the tasks call that follows; 180000 ms needed against 173976 ms left cannot happen', () => {
    const share = stepShareMs(cfg, fresh, 'seed', 624_400);
    assert.equal(900_000 - (624_400 + share), 132_000);
    assert.equal(preflight(cfg, fresh, 624_400 + share, 0, 132_000, 'tasks'), null);
    const rerun = stepShareMs(cfg, fresh, 'seed', 624_400, tasksRan);
    assert.equal(900_000 - (624_400 + rerun), 45_000);
    assert.equal(preflight(cfg, fresh, 624_400 + rerun, 0, 45_000, 'tasks', tasksRan), null);
  });
  it('the refusal that did happen names the next call and the time left', () => {
    assert.deepEqual(preflight(cfg, fresh, 726_024, 0, 180_000, 'tasks'),
      { kind: 'time_exhausted', minutes: 15, refused: { step: 'tasks', estimateMs: 180_000, remainingMs: 173_976 } });
  });
  it('a configured reserve above the estimate still wins', () => {
    const big = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { tasks: { reserve: 0.5 } } });
    assert.equal(stepShareMs(big, fresh, 'seed', 0), 450_000);
  });
});

describe('stepShareMs', () => {
  // The default 15-minute run is 900 s. With no effort set, later steps keep their first-call estimates (A-311):
  // model 26 s, workflow 61.5 s and seed 123 s (measured at medium, so 1.5 times on the ladder's default), tasks 132 s.
  const cfg = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
  const ledger = { startedAtMs: 0, spentUsd: 0, attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 }, backtracks: 0, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] }, stallRetries: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 } };
  const S = 1000;
  const cases = [
    { name: 'plan keeps the reserves of model, workflow, seed and tasks', step: 'plan', nowS: 0, want: 557_500 },
    { name: 'workflow at the start keeps the seed and tasks reserves', step: 'workflow', nowS: 0, want: 645_000 },
    { name: 'workflow after 110 s of plan and model has 535 s', step: 'workflow', nowS: 110, want: 535_000 },
    { name: 'seed keeps only the tasks reserve', step: 'seed', nowS: 700, want: 68_000 },
    { name: 'tasks gets everything left', step: 'tasks', nowS: 700, want: 200 * S },
    { name: 'a share that the reserves exhaust is 0, never negative', step: 'workflow', nowS: 800, want: 0 },
  ] as const;
  for (const c of cases) it(c.name, () => assert.equal(stepShareMs(cfg, ledger, c.step, c.nowS * S), c.want));

  it('a configured step reserve above the estimate is kept', () => {
    const custom = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { tasks: { reserve: 0.5 } } });
    assert.equal(stepShareMs(custom, ledger, 'seed', 0), 450 * S);
  });
  it('a configured step reserve below the estimate keeps the estimate', () => {
    const custom = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { tasks: { reserve: 0.05 } } });
    assert.equal(stepShareMs(custom, ledger, 'seed', 0), 768 * S);
  });
});

describe('ownerOf a seed collision (A-128)', () => {
  it('belongs to the workflow stage, which owns the tests, not to seed', () => {
    const i = issue('test.seed_collision', ['tests', 'create_acme', 'script'], { entity: 'customer', field: 'name', value: 'Acme', rowId: 'cus_0001' }, 'customer.name "Acme"');
    assert.equal(ownerOf(i), 'workflow');
  });
});

describe('nextIsRepair: one rule for the preflight and the reserve (A-349)', () => {
  const first = (ms: number) => ({ ms, repair: false });
  const repair = (ms: number) => ({ ms, repair: true });
  const cases = [
    { name: 'a step with no call and no feedback makes a first call', history: [], feedback: false, want: false },
    { name: 'feedback makes a repair, even before any call (an iterate probe that failed)', history: [], feedback: true, want: true },
    { name: 'a step that made a first call reruns as a repair with no feedback (a rerun after a backtrack)', history: [first(214_214)], feedback: false, want: true },
    { name: 'a retry with feedback is a repair', history: [first(214_214)], feedback: true, want: true },
    { name: 'repairs alone, with no first call on record, leave the next call a first call', history: [repair(46_000)], feedback: false, want: false },
  ] as const;
  for (const c of cases) it(c.name, () => assert.equal(nextIsRepair(c.history, c.feedback), c.want));
});

describe('estimateCallMs', () => {
  const first = (ms: number) => ({ ms, repair: false });
  const repair = (ms: number) => ({ ms, repair: true });
  const cases = [
    { name: 'no calls yet uses the effort default', effort: 'xhigh', history: [], repair: false, want: 300_000 },
    { name: 'no effort uses the model-default entry', effort: undefined, history: [], repair: false, want: 180_000 },
    { name: 'the slowest of the last three first calls wins', effort: 'low', history: [first(900_000), first(10_000), first(40_000), first(20_000)], repair: false, want: 40_000 },
    { name: 'a first call ignores repair history', effort: 'low', history: [first(262_000), repair(46_000)], repair: false, want: 262_000 },
    { name: 'a repair with no repair history is a quarter of the slowest first call', effort: 'medium', history: [first(262_000)], repair: true, want: 65_500 },
    { name: 'a repair uses the slowest of its own last three repairs once it has them', effort: 'medium', history: [first(262_000), repair(46_000), repair(30_000)], repair: true, want: 46_000 },
    { name: 'a repair with no history at all is a quarter of the effort default', effort: 'high', history: [], repair: true, want: 45_000 },
    { name: 'a first call with only repair history uses the effort default', effort: 'high', history: [repair(46_000)], repair: false, want: 180_000 },
  ] as const;
  for (const c of cases) it(c.name, () => assert.equal(estimateCallMs(c.effort, c.history, c.repair), c.want));
});

describe('per-step first-call estimates from live data (A-131)', () => {
  // stress-2 and stress-3, 2026-10-07: p75 of first calls, in seconds: plan 206 (n 49), model 26 (43), workflow 41 (43), seed 82 (37), tasks 132 (32).
  // The efforts are the config's: plan, model and tasks high, workflow and seed medium (A-311).
  const cases = [
    { name: 'plan, high', step: 'plan', effort: 'high', want: 206_000 },
    { name: 'model, high: 26 s, not the 180 s effort default', step: 'model', effort: 'high', want: 26_000 },
    { name: 'workflow, medium', step: 'workflow', effort: 'medium', want: 41_000 },
    { name: 'seed, medium', step: 'seed', effort: 'medium', want: 82_000 },
    { name: 'tasks, high', step: 'tasks', effort: 'high', want: 132_000 },
    { name: 'a step run at a different effort scales by the effort ladder: seed at high is 1.5 times medium', step: 'seed', effort: 'high', want: 123_000 },
    { name: 'a step with no effort set uses the high figure for the ladder default (180 s)', step: 'model', effort: undefined, want: 26_000 },
    { name: 'plan at low effort is a third of high (60 s of 180 s)', step: 'plan', effort: 'low', want: 68_667 },
  ] as const;
  for (const c of cases) it(c.name, () => assert.equal(estimateCallMs(c.effort, [], false, c.step), c.want));

  it('a step with history still uses its own slowest of the last three first calls', () => {
    assert.equal(estimateCallMs('high', [{ ms: 41_000, repair: false }, { ms: 28_000, repair: false }], false, 'model'), 41_000);
  });
  it('a repair with no history is a quarter of the first-call figure, as before (A-95)', () => {
    assert.equal(estimateCallMs('medium', [], true, 'seed'), 20_500);
  });
  it('a call with no step keeps the effort ladder', () => {
    assert.equal(estimateCallMs('high', [], false), 180_000);
  });

  // The 2026-10-07 bookmark run: the plan took 259.8 s and its repair 97.9 s, so the model call started at 357.8 s with 542.2 s left.
  const cfg = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
  const fresh = { startedAtMs: 0, spentUsd: 0, attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 }, stallRetries: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 }, backtracks: 0, seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] } };
  it('plan repair then model: the 32 s model call fits its 225.7 s share', () => {
    assert.equal(preflight(cfg, fresh, 357_768, 0, 32_000, 'model'), null);
  });
  it('the same moment, a model call above the share is still refused (stage_time_exhausted)', () => {
    assert.deepEqual(preflight(cfg, fresh, 357_768, 0, 225_733, 'model'),
      { kind: 'stage_time_exhausted', step: 'model', shareMs: 225_732 });
  });
});

describe('after a backtrack, later steps that already ran are reserved at their repair estimate (A-139)', () => {
  const cfg = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1.75, maxMinutes: 12 });
  const at = (startedAtMs: number): Ledger => ledger({ startedAtMs, backtracks: 1 });
  const first = (ms: number) => ({ ms, repair: false });
  const repair = (ms: number) => ({ ms, repair: true });
  // Each later step is reserved at its repair estimate, a quarter of its first call or its slowest repair, tasks too once it ran (A-330).
  const cases = [
    { name: 'stress-1b stripe-refunds: tasks -> model with 218749 ms left', nowMs: 501_251,
      history: { ...NO_CALLS, workflow: [first(55_000)], seed: [first(124_719)], tasks: [first(158_311)] }, modelMs: 4_950.5, share: 134_242 },
    { name: 'stress-1b petstore-store: tasks -> model with 321815 ms left', nowMs: 398_185,
      history: { ...NO_CALLS, workflow: [first(85_690), repair(88_262)], seed: [first(65_720)], tasks: [first(85_143)] }, modelMs: 3_720.5, share: 195_837 },
  ];
  for (const c of cases) {
    it(`${c.name} gets ${c.share} ms for model, not 0`, () => {
      assert.equal(stepShareMs(cfg, at(0), 'model', c.nowMs, c.history), c.share);
      assert.equal(preflight(cfg, at(0), c.nowMs, 0, c.modelMs, 'model', c.history), null);
    });
  }
  it('stress-1b stripe-partial-refunds: 78543 ms left cannot fit the reruns (5762 + 39009.5 + 37756.25 ms), so model is still refused', () => {
    const history = { ...NO_CALLS, workflow: [first(23_048)], seed: [first(156_038)], tasks: [first(151_025)] };
    assert.deepEqual(preflight(cfg, at(0), 641_457, 0, 6_226.25, 'model', history),
      { kind: 'stage_time_exhausted', step: 'model', shareMs: 0 });
  });
  it('the rerun reserves are the repair estimates of each step\'s real call history', () => {
    assert.equal(estimateCallMs('high', [{ ms: 55_000, repair: false }], true, 'workflow'), 13_750);
    assert.equal(estimateCallMs('medium', [{ ms: 124_719, repair: false }], true, 'seed'), 31_179.75);
    assert.equal(estimateCallMs('high', [{ ms: 85_690, repair: false }, { ms: 88_262, repair: true }], true, 'workflow'), 88_262);
  });
  it('without call history, 218749 ms left minus the first-call estimates (61.5 + 123 + 132 s) is 0', () => {
    assert.equal(stepShareMs(cfg, at(0), 'model', 501_251), 0);
  });
});

describe('later steps keep the estimate of their next call, not a fixed share of the run (A-311)', () => {
  // The repo's efforts on the stress suite's 12-minute runs: later steps keep model 26 s, workflow 41 s, seed 82 s, tasks 132 s.
  const live = configSchema.parse({
    model: 'claude-sonnet-5-5', maxCostUsd: 3, maxMinutes: 12, steps: { plan: { minShareSeconds: 330 } },
    stepModels: { plan: { effort: 'high' }, model: { effort: 'high' }, workflow: { effort: 'medium' }, seed: { effort: 'medium' }, tasks: { effort: 'high' } },
  });
  const fresh = ledger({ startedAtMs: 0 });
  const first = (ms: number) => ({ ms, repair: false });
  const repair = (ms: number) => ({ ms, repair: true });

  it('stress-3 stripe-partial-refunds: after a 320 s plan, model has a 145 s share for its 26 s call (it had 4.4 s and stopped)', () => {
    assert.equal(stepShareMs(live, fresh, 'model', 320_000), 145_000);
    assert.equal(preflight(live, fresh, 320_000, 0, estimateCallMs('high', [], false, 'model'), 'model'), null);
  });
  it('stress-3 library-holds: seed has a 215.1 s share for its 82 s first call with 347.1 s left (it had 189.1 s against 202 s)', () => {
    assert.equal(stepShareMs(live, fresh, 'seed', 372_912), 215_088);
    assert.equal(preflight(live, fresh, 372_912, 0, estimateCallMs('medium', [], false, 'seed'), 'seed'), null);
  });
  it('stress-2 rental-fleet: the plan share is 439 s, so its 288.6 s plan call is not cut at 288.4 s', () => {
    assert.equal(stepShareMs(live, fresh, 'plan', 0), 439_000);
  });
  it('stress-2 hotel-booking: three rejected seed attempts leave an 84.9 s repair against a 56.7 s share, still refused', () => {
    const history = { ...NO_CALLS, seed: [first(76_090), repair(30_556), repair(84_931)] };
    assert.deepEqual(preflight(live, fresh, 531_348, 0, estimateCallMs('medium', history.seed, true, 'seed'), 'seed', history),
      { kind: 'stage_time_exhausted', step: 'seed', shareMs: 56_652 });
  });
});
