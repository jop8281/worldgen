import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWorld, issue, taskIdOf, worldIdOf, type CheckIssue, type CheckReport, type TaskVerdict, type WorldDelta } from '#engine';
import type { AttemptOutcome, FidelityCheck, RunEvent, StopReason } from '../src/worldgen/events.ts';
import type { Plan } from '../src/worldgen/plan.ts';
import { renderReport } from '../src/worldgen/report.ts';
import { minimalWorld } from './helpers/world.ts';

type OkReport = Extract<CheckReport, { ok: true }>;

/** A real engine report: TaskVerdicts are minted only by the engine's check. */
function checked(): OkReport {
  const r = checkWorld(minimalWorld());
  if (!r.ok) throw new Error(`the minimal world failed check: ${r.issues[0].code}`);
  return r;
}
const OK = checked();
const masked = (s: string): string => s.replace(/\b(wid|tid)_[0-9a-f]{64}\b/g, '$1_<sha256>');

function verdict(id: string): TaskVerdict {
  const v = OK.verdicts[id];
  assert.ok(v, `no verdict for ${id}`);
  return v;
}

/**
 * The real report with the parts that later engine units fill (decoy scores, prefix scores,
 * lints) pinned to known values, so the Proof text is literal. The verdicts are still the
 * engine's own objects with fields overridden, never built from nothing.
 */
const WARNING = issue('tasks.difficulty_not_spread', ['tasks'], { have: ['easy', 'hard'] }, 'easy, hard');
const PINNED: OkReport = {
  ...OK,
  tests: 1,
  warnings: [WARNING],
  verdicts: {
    resolve_password_ticket: verdict('resolve_password_ticket'),
    escalate_acme: {
      ...verdict('escalate_acme'),
      decoys: [
        { why: 'raises priority but forgets to resolve', score: 0.5 },
        { why: 'touches Globex too', score: 0.25 },
      ],
      bestPrefixScore: 0.75,
    },
  },
};

const PLAN: Plan = {
  revision: 1,
  software: 'Zendesk-style helpdesk',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Tickets move from open to resolved under an SLA.',
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'customer', purpose: 'who files tickets', keyFields: ['tier'] },
    { name: 'ticket', purpose: 'a support request', keyFields: ['status'] },
  ],
  workflows: [{ name: 'triage', entity: 'ticket', states: ['open', 'pending', 'resolved'], rules: [], actions: ['resolve_ticket'] }],
  jobs: [{ name: 'escalate_overdue', every: '15m', rule: 'overdue tickets become urgent' }],
  acceptanceTests: [],
  routes: [{ id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse' }],
  seed: { rowsPerEntity: { customer: 5, ticket: 12 }, mix: 'mostly pending' },
  tasks: [
    { id: 'resolve_password_ticket', difficulty: 'easy', intent: 'resolve one', decoyIdea: 'wrong ticket' },
    { id: 'resolve_initech_pending', difficulty: 'medium', intent: 'resolve some', decoyIdea: 'every customer' },
    { id: 'escalate_acme', difficulty: 'hard', intent: 'escalate', decoyIdea: 'forgets to resolve' },
  ],
  assumptions: [
    { decision: 'Tickets have three statuses: open, pending and resolved.', why: 'That is the smallest set the triage workflow needs.' },
    { decision: 'Every customer has exactly one tier', why: 'The prompt names tiers but not upgrades.' },
  ],
  outOfScope: [{ what: 'Email notifications', why: 'They are not world state an agent can read back.' }],
  changes: [],
};

const at = '2026-10-06T00:00:00.000Z';
const runId = 'r1';
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 };
const COVER = issue('plan.not_covered', ['plan', 'tasks', 2], { item: 'task "rebalance"' }, 'no tasks.rebalance');
const DECOY = issue('task.decoy_full_marks', ['tasks', 'escalate_acme', 'decoys', 0], { why: 'skips page 2' }, 'score 1');

function attempt(step: 'plan' | 'model' | 'workflow' | 'seed' | 'tasks', n: number, ms: number, costUsd: number, issues?: readonly CheckIssue[]): RunEvent {
  const outcome = issues ? { kind: 'rejected' as const, issues } : { kind: 'accepted' as const, warnings: 0 };
  return { at, runId, t: 'attempt', step, n, ms, usage, costUsd, outcome, dump: `${step}-${n}.json` };
}

const EVENTS: readonly RunEvent[] = [
  { at, runId, t: 'run_started', mode: 'create', input: 'description', model: 'claude-sonnet-5-5', budgetUsd: 5 },
  { at, runId, t: 'step_started', step: 'plan', reason: 'planned' },
  attempt('plan', 1, 30000, 0.0125),
  { at, runId, t: 'step_finished', step: 'plan', attempts: 1, ms: 31000, costUsd: 0.0125 },
  { at, runId, t: 'step_started', step: 'model', reason: 'planned' },
  attempt('model', 1, 45000, 0.02, [COVER]),
  { at, runId, t: 'advice', step: 'model', text: 'MODEL COMMENTARY NEVER RENDERED' },
  attempt('model', 2, 15000, 0.01),
  { at, runId, t: 'step_finished', step: 'model', attempts: 2, ms: 61000, costUsd: 0.03 },
  { at, runId, t: 'step_started', step: 'workflow', reason: 'planned' },
  attempt('workflow', 1, 60000, 0.03),
  { at, runId, t: 'step_skipped', step: 'seed', why: 'no section it reads changed' },
  { at, runId, t: 'step_started', step: 'tasks', reason: 'planned' },
  attempt('tasks', 1, 60000, 0.025, [DECOY]),
  { at, runId, t: 'backtracked', from: 'tasks', to: 'workflow', because: [DECOY] },
  { at, runId, t: 'step_started', step: 'workflow', reason: 'backtracked' },
  attempt('workflow', 2, 30000, 0.015),
  { at, runId, t: 'step_started', step: 'tasks', reason: 'planned' },
  attempt('tasks', 2, 30000, 0.015),
  { at, runId, t: 'run_finished', ms: 312000, costUsd: 0.1275, worldWritten: true, result: { kind: 'done', worldDir: 'out' } },
];

const DELTA: WorldDelta = {
  changes: [
    { section: 'routes', key: 'list_refunds', kind: 'item_added', path: ['routes', 'list_refunds'], after: { op: 'list' } },
    { section: 'jobs', key: 'escalate_overdue', kind: 'item_removed', path: ['jobs', 'escalate_overdue'], before: { every: '15m' } },
    { section: 'entities', key: 'ticket', kind: 'enum_value_removed', path: ['entities', 'ticket', 'fields', 'priority', 'values', 3], before: 'urgent' },
    { section: 'meta', key: 'description', kind: 'meta_changed', path: ['meta', 'description'], before: 'a', after: 'b' },
  ],
};

const headings = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('#'));

/** The text from `heading` up to the next H2, without trailing blank lines. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `no "${heading}" in the report`);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end)).trimEnd();
}

describe('renderReport: a finished run', () => {
  const text = renderReport({ plan: PLAN, report: PINNED, events: EVENTS });

  it('shows how far each reference solution reached, under Coverage (A-228)', () => {
    assert.equal(section(text, '## Coverage'), [
      '## Coverage',
      '',
      "From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.",
      '',
      '| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |',
      '|---|---|---|---|---|---|',
      '| resolve_password_ticket | easy | 1 | none | none | none declared |',
      '| escalate_acme | hard | 2 | none | ticket | hard: met |',
    ].join('\n'));
  });

  it('has the title and the five sections in order, and no Changes without a delta', () => {
    assert.deepEqual(headings(text), [
      '# WorldGen report: Zendesk-style helpdesk',
      '## What was built',
      '## Assumed and why',
      '## Left out',
      '## Proof',
      '## Coverage',
      '## Run',
    ]);
    assert.equal(text.startsWith('# WorldGen report: Zendesk-style helpdesk\n\nTickets move from open to resolved under an SLA.\n\n## What was built\n'), true);
    assert.equal(text.endsWith('\n'), true);
  });

  it('lists entities with seeded rows, routes, actions and jobs from the checked world', () => {
    assert.equal(section(text, '## What was built'), [
      '## What was built',
      '',
      'Entities (2):',
      '',
      '- `customer`: 5 seeded rows',
      '- `ticket`: 12 seeded rows',
      '',
      'Routes (10):',
      '',
      '- `list_customers`: GET /customers',
      '- `get_customer`: GET /customers/{id}',
      '- `create_customer`: POST /customers',
      '- `update_customer`: PATCH /customers/{id}',
      '- `delete_customer`: DELETE /customers/{id}',
      '- `list_tickets`: GET /tickets',
      '- `get_ticket`: GET /tickets/{id}',
      '- `create_ticket`: POST /tickets',
      '- `update_ticket`: PATCH /tickets/{id}',
      '- `delete_ticket`: DELETE /tickets/{id}',
      '',
      'Actions (1):',
      '',
      '- `resolve_ticket`: POST /tickets/{id}/resolve',
      '',
      'Jobs (1):',
      '',
      '- `escalate_overdue`: every 15m',
    ].join('\n'));
  });

  it('lists every plan assumption verbatim with its why', () => {
    assert.equal(section(text, '## Assumed and why'), [
      '## Assumed and why',
      '',
      '- Tickets have three statuses: open, pending and resolved.',
      '  - Why: That is the smallest set the triage workflow needs.',
      '- Every customer has exactly one tier',
      '  - Why: The prompt names tiers but not upgrades.',
    ].join('\n'));
  });

  it('lists every left-out item with its why', () => {
    assert.equal(section(text, '## Left out'), [
      '## Left out',
      '',
      '- Email notifications',
      '  - Why: They are not world state an agent can read back.',
    ].join('\n'));
  });

  it('proves each task from its TaskVerdict: solution, noop, decoys and best prefix', () => {
    assert.equal(masked(section(text, '## Proof')), [
      '## Proof',
      '',
      'The engine check passed: 1 world test, 1 warning. Each row is one engine TaskVerdict.',
      '',
      'World id (WID): `wid_<sha256>`.',
      '',
      '| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |',
      '|---|---|---|---|---|---|---|---|',
      '| resolve_password_ticket | easy | 1.000 | 0.000 | none | n/a | legacy; mutants 5/7 | `tid_<sha256>` |',
      '| escalate_acme | hard | 1.000 | 0.000 | 0.500, 0.250 | 0.750 | legacy; mutants 5/7 | `tid_<sha256>` |',
      '',
      "Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).",
      '',
      'Decoys:',
      '',
      '- `escalate_acme` 0.500: raises priority but forgets to resolve',
      '- `escalate_acme` 0.250: touches Globex too',
    ].join('\n'));
  });

  it('renders the unmodified engine verdict of the easy task as one literal row', () => {
    const real = renderReport({ plan: PLAN, report: OK, events: [] });
    assert.equal(masked(real).split('\n').includes('| resolve_password_ticket | easy | 1.000 | 0.000 | none | n/a | legacy; mutants 5/7 | `tid_<sha256>` |'), true);
    assert.equal(real.includes('| escalate_acme | hard | 1.000 | 0.000 |'), true);
  });

  it('classifies a task that declares allows as declared, with the number of allowances (YOS-156)', () => {
    const t = OK.world.tasks['resolve_password_ticket'];
    assert.ok(t);
    const world = { ...OK.world, tasks: { ...OK.world.tasks, resolve_password_ticket: { ...t, allows: [{ entity: 'ticket', kind: 'updated' as const, fields: ['status'] }] } } };
    const real = renderReport({ plan: PLAN, report: { ...OK, world } as typeof OK, events: [] });
    assert.equal(masked(real).split('\n').some((l) => l.startsWith('| resolve_password_ticket | easy |') && l.includes('| declared (1); mutants 5/7 |')), true);
  });

  it('names the world and each task by the engine content ids of the reported world', () => {
    const t = OK.world.tasks['escalate_acme'];
    assert.ok(t);
    assert.equal(text.includes(`World id (WID): \`${worldIdOf(OK.world)}\`.`), true);
    assert.equal(text.includes(`| \`${taskIdOf(t)}\` |`), true);
    const stopped = renderReport({ plan: PLAN, report: OK, events: [], stop: { kind: 'input_rejected', why: 'x' } });
    assert.equal(stopped.includes('wid_'), false);
  });

  it('sums attempts, minutes and dollars per step from attempt events, and never renders advice', () => {
    assert.equal(section(text, '## Run'), [
      '## Run',
      '',
      'Mode: create from description. Model: claude-sonnet-5-5. Budget: $5.00.',
      '',
      '| Step | Attempts | Minutes | $ |',
      '|---|---|---|---|',
      '| plan | 1 | 0.50 | 0.0125 |',
      '| model | 2 | 1.00 | 0.0300 |',
      '| workflow | 2 | 1.50 | 0.0450 |',
      '| tasks | 2 | 1.50 | 0.0400 |',
      '| Total | 7 | 4.50 | 0.1275 |',
      '',
      'Skipped:',
      '',
      '- `seed`: no section it reads changed',
      '',
      'Backtracks:',
      '',
      '- `tasks` to `workflow`: 1 issue',
      '',
      'Run total: 5.20 minutes, $0.1275.',
    ].join('\n'));
    assert.equal(text.includes('MODEL COMMENTARY'), false);
  });

  it('is deterministic', () => {
    assert.equal(renderReport({ plan: PLAN, report: PINNED, events: EVENTS }), text);
  });

  it('says so when the plan has no assumptions or left-out items', () => {
    const bare = renderReport({ plan: { ...PLAN, assumptions: [], outOfScope: [] }, report: PINNED, events: EVENTS });
    assert.equal(section(bare, '## Assumed and why'), '## Assumed and why\n\nNone. The plan records no assumptions.');
    assert.equal(section(bare, '## Left out'), '## Left out\n\nNone. The plan leaves nothing out.');
  });

  it('keeps multi-line plan text inside its list item', () => {
    const multi = renderReport({
      plan: { ...PLAN, assumptions: [{ decision: 'Two tiers.\nNo upgrades.', why: 'The prompt\nsays so.' }] },
      report: PINNED,
      events: EVENTS,
    });
    assert.equal(section(multi, '## Assumed and why'), '## Assumed and why\n\n- Two tiers.\n  No upgrades.\n  - Why: The prompt\n    says so.');
  });

  it('says so when there is no checked world or no event', () => {
    const empty = renderReport({ plan: PLAN, events: [] });
    assert.equal(section(empty, '## What was built'), '## What was built\n\nNo checked world was given, so nothing is listed.');
    assert.equal(section(empty, '## Proof'), '## Proof\n\nNo checked world was given, so there is nothing to prove.');
    assert.equal(section(empty, '## Run'), '## Run\n\nNo events were recorded.');
  });
});

describe('renderReport: fidelity (W10)', () => {
  const withCheck = (check: FidelityCheck, stop?: StopReason): string =>
    renderReport({ plan: PLAN, report: PINNED, events: [...EVENTS, { at, runId, t: 'fidelity', check }], ...(stop ? { stop } : {}) });

  it('says outright that a world with no source spec or reference was not checked, naming the software', () => {
    const text = withCheck({ kind: 'unchecked', software: 'Zendesk-style helpdesk' });
    assert.deepEqual(headings(text).slice(-3), ['## Coverage', '## Fidelity', '## Run']);
    assert.equal(section(text, '## Fidelity'), "## Fidelity\n\nNot checked. The input gave no source spec or frozen reference of Zendesk-style helpdesk, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.");
  });

  it('gives the reference score and the floor the last step gated on', () => {
    assert.equal(section(withCheck({ kind: 'reference', reference: 'helpdesk-sla', score: 0.8571, floor: 0.8 }), '## Fidelity'),
      '## Fidelity\n\nScored 0.857 against the frozen reference `helpdesk-sla`. The last step required at least 0.800.');
  });

  it('names the OpenAPI source spec as the check', () => {
    assert.equal(section(withCheck({ kind: 'openapi' }), '## Fidelity'),
      '## Fidelity\n\nChecked against the OpenAPI source spec. The last step rejected any route, field type or enum that departs from it.');
  });

  it('has no Fidelity section without a fidelity event, or on a stop', () => {
    assert.equal(headings(renderReport({ plan: PLAN, report: PINNED, events: EVENTS })).includes('## Fidelity'), false);
    const stop: StopReason = { kind: 'attempts_exhausted', step: 'tasks', attempts: 4, lastIssues: [DECOY] };
    assert.equal(headings(withCheck({ kind: 'unchecked', software: 'Zendesk-style helpdesk' }, stop)).includes('## Fidelity'), false);
  });
});

describe('renderReport: with a delta', () => {
  it('adds a Changes section after What was built, one line per WorldChange', () => {
    const text = renderReport({ plan: PLAN, report: PINNED, delta: DELTA, events: EVENTS });
    assert.deepEqual(headings(text), [
      '# WorldGen report: Zendesk-style helpdesk',
      '## What was built',
      '## Changes',
      '## Assumed and why',
      '## Left out',
      '## Proof',
      '## Coverage',
      '## Run',
    ]);
    assert.equal(section(text, '## Changes'), [
      '## Changes',
      '',
      '- item_added `routes.list_refunds`',
      '- item_removed `jobs.escalate_overdue` (destructive)',
      '- enum_value_removed `entities.ticket.fields.priority.values.3` (destructive)',
      '- meta_changed `meta.description`',
    ].join('\n'));
  });

  it('says No changes for an empty delta', () => {
    const text = renderReport({ plan: PLAN, report: PINNED, delta: { changes: [] }, events: EVENTS });
    assert.equal(section(text, '## Changes'), '## Changes\n\nNo changes.');
  });

  it('says the changes were not written when the run stopped', () => {
    const stop: StopReason = { kind: 'time_exhausted', minutes: 30 };
    const text = renderReport({ plan: PLAN, delta: { changes: [DELTA.changes[0]!] }, events: EVENTS, stop });
    assert.equal(section(text, '## Changes'), '## Changes\n\nThe run stopped, so none of these changes were written:\n\n- item_added `routes.list_refunds`');
  });
});

describe('renderReport: a stopped run', () => {
  const stop: StopReason = { kind: 'attempts_exhausted', step: 'tasks', attempts: 4, lastIssues: [DECOY, COVER] };

  it('opens with the stop kind, the reason, no world.yaml and the last issues', () => {
    const text = renderReport({ plan: PLAN, events: EVENTS, stop });
    assert.equal(text.split('\n')[0], 'Stopped: attempts_exhausted');
    assert.equal(text.slice(0, text.indexOf('\n## ')), [
      'Stopped: attempts_exhausted',
      '',
      'The tasks step was still rejected after 4 attempts.',
      '',
      'No world.yaml was written.',
      '',
      'Last issues:',
      '',
      '- `task.decoy_full_marks` at `tasks.escalate_acme.decoys.0`: The decoy "skips page 2" scored 1. Its script may not do what its why says (a list read right after a write often returns the row the script just created), or the grader cannot tell it apart. Check the script\'s calls first, then tighten the grader.',
      '- `plan.not_covered` at `plan.tasks.2`: Build what the plan says, or change the plan in the plan step.',
      '',
    ].join('\n'));
    assert.deepEqual(headings(text), ['## What was built', '## Assumed and why', '## Left out', '## Proof', '## Run']);
    assert.equal(section(text, '## Assumed and why').includes('- Tickets have three statuses: open, pending and resolved.'), true);
  });

  it('claims no world and no proof even when a check report is passed', () => {
    const text = renderReport({ plan: PLAN, report: PINNED, events: EVENTS, stop });
    assert.equal(section(text, '## What was built'), '## What was built\n\nNothing was handed over: the run stopped.');
    assert.equal(section(text, '## Proof'), '## Proof\n\nNone. The run stopped, so this report claims no verified task.');
    assert.equal(text.includes('resolve_password_ticket'), false);
  });

  it('states the reason for each stop kind', () => {
    const cases: readonly [StopReason, string][] = [
      [{ kind: 'input_rejected', why: 'Forecast accuracy is not world state' }, 'The input was rejected: Forecast accuracy is not world state'],
      [{ kind: 'attempts_exhausted', step: 'seed', attempts: 1, lastIssues: [] }, 'The seed step was still rejected after 1 attempt.'],
      [{ kind: 'no_progress', step: 'workflow', repeatedIssueSet: 'x', lastIssues: [] }, 'The workflow step made no progress: the same issues came back.'],
      [{ kind: 'backtrack_limit', step: 'tasks', backtracks: 3 }, 'The tasks step hit the backtrack limit after 3 backtracks.'],
      [{ kind: 'budget_exhausted', spentUsd: 5.0123, limitUsd: 5 }, 'The run spent $5.0123 of its per-run budget maxCostUsd=$5.00 (this run only; set by --budget-usd or worldgen.config.json).'],
      [{ kind: 'spend_cap', cap: 'maxDailyUsd', capUsd: 60, spentUsd: 60.08, day: '2026-10-07' },
        'The run was refused by a spend cap shared by every session, not by its own budget: daily spend cap WORLDGEN_MAX_DAILY_USD=$60.00 reached: $60.08 spent today (2026-10-07 UTC), all sessions, model calls and sandboxes.'],
      [{ kind: 'spend_cap', cap: 'maxTotalUsd', capUsd: 500, spentUsd: 500, day: '2026-10-07' },
        'The run was refused by a spend cap shared by every session, not by its own budget: total spend cap WORLDGEN_MAX_TOTAL_USD=$500.00 reached: $500.00 spent in all time, all sessions, model calls and sandboxes.'],
      [{ kind: 'spend_cap', cap: 'maxDailyLlmUsd', capUsd: 40, spentUsd: 40.5, day: '2026-10-07' },
        'The run was refused by a spend cap shared by every session, not by its own budget: daily LLM spend cap WORLDGEN_MAX_DAILY_LLM_USD=$40.00 reached: $40.50 spent today (2026-10-07 UTC), all sessions, model calls only.'],
      [{ kind: 'spend_cap', cap: 'maxDailySandboxUsd', capUsd: 10, spentUsd: 10.25, day: '2026-10-07' },
        'The run was refused by a spend cap shared by every session, not by its own budget: daily sandbox spend cap WORLDGEN_MAX_DAILY_SANDBOX_USD=$10.00 reached: $10.25 spent today (2026-10-07 UTC), all sessions, sandbox time only.'],
      [{ kind: 'time_exhausted', minutes: 30 }, 'The run hit its 30-minute limit.'],
      [{ kind: 'time_exhausted', minutes: 15, refused: { step: 'tasks', estimateMs: 180_000, remainingMs: 173_976 } }, 'The run did not reach its 15-minute limit: the next call (tasks) needed ~180 s and 174 s were left.'],
      [{ kind: 'stage_time_exhausted', step: 'workflow', shareMs: 90_000 }, 'The workflow step had 90 seconds left before the time reserved for the steps after it, and its next call would not fit.'],
      [{ kind: 'model_error', message: 'overloaded' }, 'The model call failed: overloaded'],
    ];
    for (const [reason, line] of cases) {
      const lines = renderReport({ events: [], stop: reason }).split('\n');
      assert.deepEqual(lines.slice(0, 5), [`Stopped: ${reason.kind}`, '', line, '', 'No world.yaml was written.'], reason.kind);
    }
  });

  it('says whether a call cut at its share was still writing, sent nothing, or never returned', () => {
    const stop: StopReason = { kind: 'stage_time_exhausted', step: 'plan', shareMs: 377_984 };
    const cut = (outcome: AttemptOutcome): RunEvent => ({ at, runId, t: 'attempt', step: 'plan', n: 1, ms: 377_990, usage, costUsd: 0.25, outcome, dump: 'plan-1.json' });
    const cases: readonly [AttemptOutcome, string][] = [
      [{ kind: 'share_expired', shareMs: 377_984, progress: { messages: 2, outputTokens: 17_873, schemaRetries: 1, outputBytes: 7285 } },
        'The plan call was still writing when its 378 s share ran out (2 messages, 17,873 output tokens and 7,285 answer bytes so far, 1 schema retry by the CLI), so the run stopped. Raise maxMinutes, or lower the plan effort in stepModels.'],
      [{ kind: 'share_expired', shareMs: 377_984, progress: { messages: 1, outputTokens: 24_350, schemaRetries: 0, outputBytes: 0 } },
        'The plan call was still writing when its 378 s share ran out (1 message, 24,350 output tokens and 0 answer bytes so far), so the run stopped. Raise maxMinutes, or lower the plan effort in stepModels.'],
      [{ kind: 'share_expired', shareMs: 377_984, progress: { messages: 1, outputTokens: 0, schemaRetries: 0, outputBytes: 26_452 } },
        'The plan call was still writing when its 378 s share ran out (1 message, 0 output tokens and 26,452 answer bytes so far), so the run stopped. Raise maxMinutes, or lower the plan effort in stepModels.'],
      [{ kind: 'share_expired', shareMs: 377_984, progress: { messages: 0, outputTokens: 0, schemaRetries: 0, outputBytes: 0 } },
        'The plan call sent nothing before its 378 s share ran out, so the run stopped. Raise maxMinutes, or lower the plan effort in stepModels.'],
      [{ kind: 'share_expired', shareMs: 377_984, progress: null },
        'The plan call did not return before its 378 s share ran out, so the run stopped. Raise maxMinutes, or lower the plan effort in stepModels.'],
    ];
    for (const [outcome, line] of cases) {
      const lines: string[] = renderReport({ events: [cut(outcome)], stop }).split('\n');
      assert.deepEqual(lines.slice(0, 7), ['Stopped: stage_time_exhausted', '', line, '', 'No world.yaml was written.', '', 'Last issues: none recorded.']);
    }
  });

  it('takes the last issues from the last attempt when the stop reason carries none', () => {
    const budget: StopReason = { kind: 'budget_exhausted', spentUsd: 5.5, limitUsd: 5 };
    const rejected = renderReport({ plan: PLAN, events: EVENTS.slice(0, 14), stop: budget });
    assert.equal(rejected.includes('Last issues:\n\n- `task.decoy_full_marks` at `tasks.escalate_acme.decoys.0`: The decoy "skips page 2" scored 1. Its script may not do what its why says (a list read right after a write often returns the row the script just created), or the grader cannot tell it apart. Check the script\'s calls first, then tighten the grader.\n\n## What was built'), true);
    const accepted = renderReport({ plan: PLAN, events: EVENTS, stop: budget });
    assert.equal(accepted.includes('Last issues: none recorded.\n\n## What was built'), true);
  });

  it('lists at most ten issues and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => issue('plan.not_covered', ['plan', 'routes', i], { item: `route "r${i}"` }, `no routes.r${i}`));
    const text = renderReport({ plan: PLAN, events: [], stop: { kind: 'no_progress', step: 'model', repeatedIssueSet: 'x', lastIssues: many } });
    const items = text.split('\n').filter((l) => l.startsWith('- `plan.not_covered`'));
    assert.equal(items.length, 10);
    assert.equal(items[9], '- `plan.not_covered` at `plan.routes.9`: Build what the plan says, or change the plan in the plan step.');
    assert.equal(text.includes('\n- 2 more issues are in events.jsonl.\n'), true);
    const eleven = renderReport({ events: [], stop: { kind: 'no_progress', step: 'model', repeatedIssueSet: 'x', lastIssues: many.slice(0, 11) } });
    assert.equal(eleven.includes('\n- 1 more issue is in events.jsonl.\n'), true);
  });

  it('renders a stop that came before any plan', () => {
    const text = renderReport({ events: [], stop: { kind: 'input_rejected', why: 'Needs a live market feed' } });
    assert.equal(section(text, '## Assumed and why'), '## Assumed and why\n\nNo plan was made.');
    assert.equal(section(text, '## Left out'), '## Left out\n\nNo plan was made.');
    assert.equal(text.includes('Last issues: none recorded.'), true);
  });
});

describe('renderReport: questions asked of the input', () => {
  const asked: Plan = {
    ...PLAN,
    open_questions: [
      { question: 'Can a resolved ticket reopen?', default_answer: 'Yes, back to open.' },
      { question: 'Which SLA\nclock applies?', default_answer: 'Business hours,\nin UTC.' },
    ],
  };

  it('lists each question with its default answer, right after Assumed and why', () => {
    const text = renderReport({ plan: asked, report: PINNED, events: EVENTS });
    assert.deepEqual(headings(text), [
      '# WorldGen report: Zendesk-style helpdesk',
      '## What was built',
      '## Assumed and why',
      '## Questions asked of the input',
      '## Left out',
      '## Proof',
      '## Coverage',
      '## Run',
    ]);
    assert.equal(
      section(text, '## Questions asked of the input'),
      [
        '## Questions asked of the input',
        '',
        '- Can a resolved ticket reopen?',
        '  - Default answer: Yes, back to open.',
        '- Which SLA',
        '  clock applies?',
        '  - Default answer: Business hours,',
        '    in UTC.',
      ].join('\n'),
    );
  });

  it('is omitted when the plan has no open_questions or an empty list', () => {
    const none = renderReport({ plan: PLAN, report: PINNED, events: EVENTS });
    const empty = renderReport({ plan: { ...PLAN, open_questions: [] }, report: PINNED, events: EVENTS });
    assert.equal(none.includes('Questions asked of the input'), false);
    assert.equal(empty, none);
  });

  it('is rendered on a stopped run, and omitted when the stop came before a plan', () => {
    const stop: StopReason = { kind: 'attempts_exhausted', step: 'tasks', attempts: 4, lastIssues: [COVER] };
    const text = renderReport({ plan: asked, events: EVENTS, stop });
    assert.deepEqual(headings(text), ['## What was built', '## Assumed and why', '## Questions asked of the input', '## Left out', '## Proof', '## Run']);
    assert.equal(section(text, '## Questions asked of the input').includes('  - Default answer: Yes, back to open.'), true);
    const early = renderReport({ events: [], stop: { kind: 'input_rejected', why: 'Needs a live market feed' } });
    assert.equal(early.includes('Questions asked of the input'), false);
  });
});
