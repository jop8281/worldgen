/**
 * Shared fixtures for the red-team WorldGen suite (test/redteam-wg-*.test.ts).
 *
 * - notBuilt(unit, what, probe): runs `probe` once and returns the skip reason
 *   `unit <unit> not landed: <what>` when the capability throws `not implemented` or is
 *   missing, so unbuilt units skip instead of failing. `unit` is the backlog key. Never
 *   skips under REDTEAM_STRICT=1, like cap() in test/redteam/harness.ts.
 * - RT_CONFIG, ledger(), issues: policy inputs with literal values.
 * - rtPlan, rtWorld(), okReport(): a small plan and a world that covers it, for stage `done`.
 */
import { issue, type CheckIssue, type CheckReport, type World } from '#engine';
import type { Config } from '../../src/worldgen/config.ts';
import type { Plan } from '../../src/worldgen/plan.ts';
import type { Ledger, OwnedIssue } from '../../src/worldgen/policy.ts';
import type { StepId } from '../../src/worldgen/stages.ts';

/** `unit <unit> not landed: <what>` when `probe` throws `not implemented` (or the export is missing), else false. */
export async function notBuilt(unit: string, what: string, probe: () => unknown): Promise<string | false> {
  if (process.env['REDTEAM_STRICT'] === '1') return false;
  try {
    await probe();
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not implemented/.test(msg) || (e instanceof TypeError && /is not a function/.test(msg))) return `unit ${unit} not landed: ${what} throws not implemented`;
    return false;
  }
}

const budget = (maxAttempts: number) => ({ maxAttempts });

/** The shipped per-step budgets (worldgen.config.json), with a test model name. */
export const RT_CONFIG: Config = {
  model: 'rt-model',
  maxCostUsd: 5,
  maxMinutes: 30,
  maxBacktracks: 2,
  maxOutputTokens: 16000,
  steps: { plan: budget(3), model: budget(4), workflow: budget(5), seed: budget(4), tasks: budget(5) },
  prices: {},
  exampleWorld: ['../prod/worlds/helpdesk'],
};

export const T0 = 5_000_000;
export const MINUTE = 60_000;

export const ledger = (o: Partial<Ledger> = {}): Ledger => ({
  startedAtMs: T0,
  spentUsd: 0,
  attempts: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 },
  backtracks: 0,
  seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] },
  stallRetries: { plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0 },
  ...o,
});

export const attempts = (o: Partial<Record<StepId, number>>): Ledger['attempts'] => ({
  plan: 0, model: 0, workflow: 0, seed: 0, tasks: 0, ...o,
});
export const seen = (o: Partial<Record<StepId, readonly string[]>>): Ledger['seenIssueSets'] => ({
  plan: [], model: [], workflow: [], seed: [], tasks: [], ...o,
});

/** Issues with known owners. Keys are spelled out where tests need them. */
export const I = {
  /** entities, fixed owner -> model */
  badMachine: issue('state.bad_machine', ['entities', 'ticket'], { problem: 'no initial' }, 'none'),
  /** at_path routes -> model */
  badRoute: issue('schema.invalid', ['routes', 'list_tickets'], { message: 'bad op' }, 'lst'),
  /** a test run at tests -> workflow */
  testFailed: issue('test.failed', ['tests', 'close'], { message: 'status' }, 'open'),
  /** same code, path and found as testFailed, different expected and hint text */
  testFailedOtherText: issue('test.failed', ['tests', 'close'], { message: 'other message' }, 'open'),
  /** at_path actions -> workflow */
  actionError: issue('snippet.runtime_error', ['actions', 'solve'], { message: 'boom' }, 'TypeError'),
  /** at_path seed -> seed */
  seedViolation: issue('constraint.violation', ['seed', 'ticket'], { entity: 'ticket', field: 'priority', rule: 'enum' }, 'x'),
  /** tasks, fixed owner -> tasks */
  noopNotZero: issue('task.noop_not_zero', ['tasks', 'refund'], { score: 1 }, '1'),
  /** seed warning */
  pagingWarn: issue('seed.too_few_rows_for_paging', ['seed', 'ticket'], { entity: 'ticket', rows: 3, pageSize: 10 }, '3'),
} satisfies Record<string, CheckIssue>;

export const KEY = {
  badMachine: 'state.bad_machine@entities/ticket: none',
  testFailed: 'test.failed@tests/close: open',
  actionError: 'snippet.runtime_error@actions/solve: TypeError',
  noopNotZero: 'task.noop_not_zero@tasks/refund: 1',
} as const;

export const owned = (...pairs: [CheckIssue, StepId][]): OwnedIssue[] => pairs.map(([i, o]) => ({ issue: i, owner: o }));

export const rtPlan: Plan = {
  revision: 1,
  software: 'Zendesk-style helpdesk',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Tickets with SLA tiers.',
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'ticket', purpose: 'a support request', keyFields: ['status'] },
    { name: 'agent', purpose: 'who works tickets', keyFields: ['email'] },
  ],
  workflows: [{ name: 'triage', entity: 'ticket', states: ['open', 'solved'], rules: ['only open tickets solve'], actions: ['solve'] }],
  jobs: [{ name: 'sla_breach', every: '1h', rule: 'flag open urgent tickets older than 4h' }],
  acceptanceTests: [{
    id: 'solve_ticket',
    intent: 'An open ticket can be solved through the public API.',
    actions: ['solve'],
    description: 'an open ticket can be solved',
    script: "(ctx) => { const r = ctx.api('POST', '/tickets/tk_0001/solve'); ctx.assert(r.status === 200, 'solve failed'); }",
  }],
  routes: [{ id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse' }],
  seed: { rowsPerEntity: { ticket: 60, agent: 5 }, mix: 'mostly open' },
  tasks: [
    { id: 'solve_one', difficulty: 'easy', intent: 'solve', decoyIdea: 'wrong ticket' },
    { id: 'solve_vip', difficulty: 'medium', intent: 'solve vip', decoyIdea: 'page 1 only' },
    { id: 'rebalance', difficulty: 'hard', intent: 'rebalance', decoyIdea: 'moves one' },
  ],
  assumptions: [{ decision: 'one SLA tier per ticket', why: 'input names tiers, not overlap' }],
  outOfScope: [],
  changes: [],
};

const entity = { description: 'x', idPrefix: 'tk', fields: {} };
const task = (difficulty: 'easy' | 'medium' | 'hard') => ({
  difficulty,
  instruction: 'do the thing the plan says to do',
  grader: '(ctx) => 1',
  solution: '(ctx) => null',
  decoys: [],
});

/** A world that covers every item of rtPlan, including the planned job. */
export function rtWorld(over: Partial<World> = {}): World {
  return {
    format: 1,
    meta: {
      name: 'helpdesk',
      description: 'test world',
      resembles: 'Zendesk tickets API',
      source: 'hand',
      seed: 1,
      clock: { start: '2026-01-01T00:00:00Z', tick: '1s' },
      api: { list: { dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor' }, error: {} },
    },
    entities: { ticket: entity, agent: entity },
    routes: { list_tickets: { op: 'list', entity: 'ticket', method: 'GET', path: '/tickets' } },
    actions: { solve: { method: 'POST', path: '/tickets/{id}/solve', input: {}, handler: '(ctx) => null' } },
    jobs: { sla_breach: { every: '1h', run: '(ctx) => {}' } },
    fixtures: {},
    seed: {},
    tests: { solve_ticket: { description: rtPlan.acceptanceTests[0]!.description, script: rtPlan.acceptanceTests[0]!.script } },
    tasks: { solve_one: task('easy'), solve_vip: task('medium'), rebalance: task('hard') },
    ...over,
  } as World;
}

type OkReport = Extract<CheckReport, { ok: true }>;

/**
 * checkWorld cannot mint a CheckedWorld for a hand-built world in a unit test, and `done`
 * reads only world, stats and warnings, so the report is cast once here.
 */
export function okReport(w: World, warnings: readonly CheckIssue[] = []): OkReport {
  return {
    ok: true,
    world: w,
    verdicts: {},
    stats: { rows: {}, states: {}, unexercisedActions: [] },
    tests: 0,
    warnings,
  } as unknown as OkReport;
}
