/**
 * runWorldGen in iterate mode (YOS-52), driven by a scripted fake Model. bun run test never calls a real model.
 * The refunds cases iterate on a copy of the golden helpdesk (prod/worlds/helpdesk, never touched);
 * the stop cases use minimalWorld, which saves and checks in a fraction of the time.
 * Each script entry is one model call, in order: a reply (tool input), a ModelError to throw, or a
 * function of the request.
 */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { checkWorld, diffWorlds, loadWorld, saveWorld, worldIdOf, worldSchema, type CheckedWorld, type TaskVerdict, type World } from '#engine';
import { CAPSULE_FILE, capsuleSchema } from '../src/worldgen/capsule.ts';
import { configSchema, type Config } from '../src/worldgen/config.ts';
import type { RunEvent } from '../src/worldgen/events.ts';
import { applyPlanPatch, changedSections, iteratePlanSchema, planPatchSchema, planWithWorldTests } from '../src/worldgen/iterate.ts';
import { ModelError, type Model, type ProposeRequest } from '../src/worldgen/llm.ts';
import { parsePlanYaml, renderPlanYaml, workflowIssues, type Plan } from '../src/worldgen/plan.ts';
import { runWorldGen, stagePrompt, systemPrompt, stepBrief, type RunFs, type RunResult } from '../src/worldgen/run.ts';
import { minimalWorld } from './helpers/world.ts';

const HELPDESK = resolve(import.meta.dirname, '../../prod/worlds/helpdesk');
// Frozen copies of two generated worlds, byte for byte from git, so a later change to the live prod world cannot move
// the state these replays assume: gen-todo-projects as YOS-156 found it, gen-billing-dunning before W11 (#55) declared
// the default_card lifecycle that the A-345 patch adds.
const TODO = resolve(import.meta.dirname, 'fixtures/gen-todo-projects-a285');
const BILLING = resolve(import.meta.dirname, 'fixtures/gen-billing-dunning-a345');
const REQUEST = 'add refunds: an agent can refund a resolved ticket, and each refund is tracked';

// ------------------------------------------------------------------ the refunds change, as the fake model proposes it

const REFUND_ENTITY = {
  description: 'A refund requested against a resolved ticket. An agent approves or rejects it.',
  idPrefix: 'rfd',
  fields: {
    ticket_id: { type: 'ref', entity: 'ticket', required: true, onDelete: 'restrict' },
    amount: { type: 'money', currency: 'USD', required: true, min: 1 },
    reason: { type: 'text', required: true },
    status: {
      type: 'state',
      states: ['requested', 'approved', 'rejected'],
      initial: 'requested',
      transitions: { requested: ['approved', 'rejected'], approved: [], rejected: [] },
    },
  },
};

const REFUND_ROUTES = {
  list_refunds: { op: 'list', method: 'GET', path: '/refunds', entity: 'refund', filters: ['status', 'ticket_id'] },
  get_refund: { op: 'get', method: 'GET', path: '/refunds/{id}', entity: 'refund' },
};

const ISSUE_REFUND = {
  method: 'POST',
  path: '/tickets/{id}/refund',
  description: 'Request a refund on a resolved or closed ticket.',
  input: {
    amount: { type: 'money', currency: 'USD', required: true, min: 1, description: 'Amount in minor units.' },
    reason: { type: 'text', required: true },
  },
  handler: `(ctx) => {
  const id = ctx.params.id;
  const t = ctx.db.get('ticket', id);
  if (t === null) ctx.fail(404, 'not_found', 'ticket ' + id + ' not found');
  if (t.status !== 'resolved' && t.status !== 'closed') ctx.fail(409, 'invalid_state', 'ticket ' + id + ' is ' + t.status + '. Only resolved or closed tickets can be refunded.');
  const refund = ctx.db.create('refund', { ticket_id: id, amount: ctx.body.amount, reason: ctx.body.reason });
  return { status: 201, body: refund };
}`,
};

const ISSUE_REFUND_TEST = {
  description: 'issue_refund creates a requested refund on a resolved ticket and refuses an open one.',
  script: `(ctx) => {
  const resolved = ctx.api('GET', '/tickets?status=resolved&limit=1').body.data[0];
  const ok = ctx.api('POST', '/tickets/' + resolved.id + '/refund', { amount: 1500, reason: 'duplicate charge' });
  ctx.assert(ok.status === 201, 'refund returned ' + ok.status + ' ' + JSON.stringify(ok.body));
  ctx.assert(ok.body.status === 'requested' && ok.body.amount === 1500, 'refund is requested for 1500, got ' + JSON.stringify(ok.body));
  const open = ctx.api('GET', '/tickets?status=open&limit=1').body.data[0];
  const refused = ctx.api('POST', '/tickets/' + open.id + '/refund', { amount: 500, reason: 'too early' });
  ctx.assert(refused.status === 409, 'an open ticket is refused with 409, got ' + refused.status);
}`,
};

const REFUND_SEED = `(ctx) => ctx.rows('ticket').filter((t) => t.status === 'resolved').slice(0, 3)
  .map((t, i) => ({ ticket_id: t.id, amount: 1500, reason: 'duplicate charge', status: ['requested', 'approved', 'rejected'][i] }))`;

const EDITS = {
  model: { note: 'the refund entity and its read routes', upsert: { entities: { refund: REFUND_ENTITY }, routes: REFUND_ROUTES } },
  workflow: { note: 'issue_refund, which the planned test calls', upsert: { actions: { issue_refund: ISSUE_REFUND } } },
  seed: { note: 'one refund per status on resolved tickets', upsert: { seed: { refund: REFUND_SEED } } },
  tasks: { note: 'the three existing tasks already cover the world' },
};

/** The ticket status state with `closed` quietly dropped: the destructive edit a model must not make unplanned. */
const DROP_CLOSED = {
  note: 'the refund entity, and tidy the ticket lifecycle',
  upsert: { entities: { refund: REFUND_ENTITY }, routes: REFUND_ROUTES },
  patch: {
    entities: {
      ticket: {
        fields: {
          status: {
            states: ['new', 'open', 'pending', 'escalated', 'resolved'],
            transitions: { resolved: ['open'], closed: null },
          },
        },
      },
    },
  },
};

/** The same removal plus a second one, so a retry still fails but is not the same set of issues (no no_progress stop). */
const DROP_CLOSED_AND_LOW = {
  ...DROP_CLOSED,
  patch: { entities: { ticket: { fields: { ...DROP_CLOSED.patch.entities.ticket.fields, priority: { values: ['normal', 'high', 'urgent'] } } } } },
};

// ------------------------------------------------------------------ plans

type PlanOver = Partial<Plan>;

/** A change plan for `world` at revision 2: its tasks kept, plus whatever `over` says. Items it names must exist or be built by this run. */
function planFor(world: World, over: PlanOver): Plan {
  return {
    revision: 2,
    software: 'Zendesk Support tickets API',
    summary: 'Customers file tickets that agents work, now with refunds on resolved tickets.',
    clock: world.meta.clock,
    verdict: { kind: 'proceed' },
    entities: [{ name: 'ticket', purpose: 'a support request', keyFields: ['status'] }],
    workflows: [{ name: 'support', entity: 'ticket', states: ['open', 'resolved'], rules: [], actions: [] }],
    jobs: [],
    acceptanceTests: [],
    routes: [],
    seed: { rowsPerEntity: { ticket: 12 }, mix: 'as before' },
    tasks: Object.entries(world.tasks).map(([id, t]) => ({ id, difficulty: t.difficulty, intent: 'as before', decoyIdea: 'as before' })),
    assumptions: [{ decision: 'A refund is requested, then approved or rejected.', why: 'The request names refunds but no review step.' }],
    outOfScope: [{ what: 'paying the refund out', why: 'the world has no payments' }],
    changes: [],
    ...over,
  };
}

const REFUND_PLAN_OVER: PlanOver = {
  entities: [
    { name: 'ticket', purpose: 'a support request', keyFields: ['status'] },
    { name: 'refund', purpose: 'money returned to a customer for a resolved ticket', keyFields: ['ticket_id', 'amount', 'status'] },
  ],
  workflows: [{ name: 'refunds', entity: 'refund', states: ['requested', 'approved', 'rejected'], rules: [{ rule: 'only a resolved or closed ticket can be refunded', by: ['issue_refund'], test: 'issue_refund_on_resolved' }], actions: ['issue_refund'] }],
  routes: [
    { id: 'list_refunds', method: 'GET', path: '/refunds', purpose: 'browse refunds' },
    { id: 'get_refund', method: 'GET', path: '/refunds/{id}', purpose: 'read one refund' },
  ],
  acceptanceTests: [{ id: 'issue_refund_on_resolved', intent: 'a resolved ticket can be refunded and an open one cannot', actions: ['issue_refund'], ...ISSUE_REFUND_TEST }],
  seed: { rowsPerEntity: { refund: 3 }, mix: 'one per status, on resolved tickets' },
};

/** The plan.yaml an earlier run left: revision 1, so the change plan (revision 2) supersedes it. */
const recorded = (world: World, over: PlanOver): Plan => planFor(world, { ...over, revision: 1 });

// ------------------------------------------------------------------ harness

type Reply = { readonly input: unknown } | ModelError;
type Script = readonly (Reply | ((req: ProposeRequest) => Reply))[];

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Each call costs $0.125 and takes 1000 ms. */
function fakeModel(script: Script): Model & { readonly calls: ProposeRequest[] } {
  const calls: ProposeRequest[] = [];
  return {
    calls,
    async propose(req) {
      const entry = script[calls.length];
      calls.push(req);
      if (entry === undefined) throw new Error(`fake model script has no reply for call ${calls.length}`);
      const reply = typeof entry === 'function' ? entry(req) : entry;
      if (reply instanceof ModelError) throw reply;
      return { input: reply.input, advice: [], usage: USAGE, costUsd: 0.125, ms: 1000 };
    },
  };
}

const CONFIG: Config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

const tmp = (): string => mkdtempSync(join(tmpdir(), 'wg-iterate-'));

/** A scratch copy of the golden helpdesk, with plan.yaml only when asked for. */
function helpdeskCopy(plan?: Plan | string): string {
  const dir = tmp();
  copyFileSync(join(HELPDESK, 'world.yaml'), join(dir, 'world.yaml'));
  if (plan !== undefined) writeFileSync(join(dir, 'plan.yaml'), typeof plan === 'string' ? plan : renderPlanYaml(plan));
  return dir;
}

function checkedOf(world: World): CheckedWorld {
  const r = checkWorld(world);
  if (!r.ok) throw new Error(`fixture rejected: ${JSON.stringify(r.issues.map((i) => [i.code, i.path, i.found]))}`);
  return r.world;
}

/** A scratch directory holding `world` (minimalWorld by default) as saved by the engine, with plan.yaml when given. */
async function minimalDir(plan?: Plan, world: World = minimalWorld()): Promise<string> {
  const dir = tmp();
  await saveWorld(dir, checkedOf(world));
  if (plan !== undefined) writeFileSync(join(dir, 'plan.yaml'), renderPlanYaml(plan));
  return dir;
}

async function loadChecked(dir: string): Promise<CheckedWorld> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) throw new Error(`${dir} does not load`);
  return checkedOf(loaded.value as World);
}

/** The bytes the run must leave alone. */
const snapshot = (dir: string) => ({
  world: readFileSync(join(dir, 'world.yaml'), 'utf8'),
  plan: existsSync(join(dir, 'plan.yaml')) ? readFileSync(join(dir, 'plan.yaml'), 'utf8') : null,
});

type Ran = { result: RunResult; events: RunEvent[]; calls: ProposeRequest[]; dir: string };
async function iterate(dir: string, script: Script, opts: { config?: Config; request?: string; fs?: RunFs; check?: Parameters<typeof runWorldGen>[2]["check"] } = {}): Promise<Ran> {
  const model = fakeModel(script);
  const events: RunEvent[] = [];
  let t = T0;
  const result = await runWorldGen({ kind: 'iterate', worldDir: dir, request: opts.request ?? REQUEST }, opts.config ?? CONFIG, {
    model,
    exampleWorld: minimalWorld(),
    emit: (e) => events.push(e),
    now: () => (t += 1000),
    runId: 'run_iter',
    ...(opts.fs === undefined ? {} : { fs: opts.fs }),
    ...(opts.check === undefined ? {} : { check: opts.check }),
  });
  return { result, events, calls: model.calls, dir };
}

const attempts = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.t === 'attempt' ? [[e.step, e.n, e.outcome.kind] as const] : []));
const delta = (before: World, after: World) =>
  diffWorlds(before, after).changes.map((c) => `${c.kind} ${c.path.join('.')}`);
const stoppedReason = (r: RunResult) => (r.kind === 'stopped' ? r.reason : null);

// ------------------------------------------------------------------ cases

describe('changedSections: which sections a change plan reaches', () => {
  const world = minimalWorld();

  it('is empty when the plan only names what the world already holds', () => {
    assert.deepEqual([...changedSections(planFor(world, {}), world)], []);
  });

  it('counts each planned item the world lacks, in the section that holds it', () => {
    assert.deepEqual([...changedSections(planFor(world, REFUND_PLAN_OVER), world)].sort(), ['actions', 'entities', 'routes', 'tests']);
  });

  it('counts a plan.changes entry rooted at a section, and one rooted at an item key in every section that holds the key', () => {
    assert.deepEqual([...changedSections(planFor(world, { changes: ['jobs'] }), world)], ['jobs']);
    assert.deepEqual([...changedSections(planFor(world, { changes: ['ticket.fields.status'] }), world)].sort(), ['entities', 'seed']);
    assert.deepEqual([...changedSections(planFor(world, { changes: ['no_such_item.x', ' '] }), world)], []);
  });
});

describe('runWorldGen iterate: preserved world clock', () => {
  it('rejects a conflicting plan clock before later stages, then saves a repaired plan matching the world', async () => {
    const world = minimalWorld();
    const plan = planFor(world, { changes: ['tasks.resolve_password_ticket.instruction'] });
    const drifted: Plan = { ...plan, revision: 1, clock: { start: '2035-01-01T00:00:00.000Z', tick: '2s' } };
    const dir = await minimalDir(drifted);
    const { result, events, calls } = await iterate(dir, [
      { input: drifted }, { input: plan }, { input: { note: 'Keep the existing task wording.' } },
    ]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'accepted'], ['tasks', 1, 'accepted']]);
    assert.ok(calls[0]?.prompt.includes(JSON.stringify(world.meta.clock)), 'the actual clock is shown even when the saved plan has drifted');
    assert.ok(calls[0]?.prompt.includes('- row.not_found (404): No row has this id.'), 'the iterate plan prompt names the engine error codes');
    assert.ok(calls[1]?.prompt.includes('iterate must preserve the existing world clock'));
    assert.equal(calls[2]?.prompt.includes('2035-01-01'), false);
    assert.deepEqual(parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'))?.clock, world.meta.clock);
    assert.deepEqual((await loadChecked(dir)).meta.clock, world.meta.clock);
  });
});

describe('runWorldGen iterate: add refunds to a copy of the golden helpdesk', () => {
  it('runs plan, model, workflow, seed and tasks, proves the intended diff, and keeps what it did not mean to change', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const goldenReport = checkWorld(golden);
    if (!goldenReport.ok) throw new Error('golden helpdesk does not check');
    const plan = planFor(golden, REFUND_PLAN_OVER);
    const { result, events, calls } = await iterate(dir, [{ input: plan }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);

    assert.equal(result.kind, 'done');
    assert.equal(calls.length, 5);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    const started = events.filter((e) => e.t === 'step_started').map((e) => (e.t === 'step_started' ? `${e.step}:${e.reason}` : ''));
    assert.deepEqual(started, ['plan:changed', 'model:changed', 'workflow:changed', 'seed:changed', 'tasks:changed']);
    assert.equal(events.some((e) => e.t === 'step_skipped'), false);
    const first = events[0];
    assert.deepEqual(first?.t === 'run_started' ? [first.mode, first.input] : null, ['iterate', 'change_request']);

    // The saved world is the engine's checked world, and it differs from the golden world by exactly the refunds.
    const after = await loadChecked(dir);
    assert.deepEqual(delta(golden, after), [
      'item_added entities.refund',
      'item_added routes.get_refund',
      'item_added routes.list_refunds',
      'item_added actions.issue_refund',
      'item_added seed.refund',
      'item_added tests.issue_refund_on_resolved',
    ]);
    assert.equal(after.meta.name, 'helpdesk');
    assert.equal(after.meta.description, golden.meta.description);

    // Nothing the request did not mention was regenerated: every old seed snippet is the old text.
    for (const entity of Object.keys(golden.seed)) assert.equal(after.seed[entity], golden.seed[entity], `seed.${entity} changed`);
    assert.deepEqual(Object.keys(after.seed).sort(), [...Object.keys(golden.seed), 'refund'].sort());
    assert.deepEqual(after.actions['assign_ticket'], golden.actions['assign_ticket']);
    assert.deepEqual(after.tasks, golden.tasks);

    // Every old task is still proven by the engine with the same scores, and the old tests still run.
    // Only the end-state hash moves: the world has one more table.
    assert.equal(result.kind === 'done' ? result.report.tests : null, 7);
    const scores = (v: TaskVerdict | undefined) => (v === undefined ? null : { ...v, endStateHash: '' });
    for (const id of Object.keys(golden.tasks)) {
      assert.deepEqual(scores(result.kind === 'done' ? result.report.verdicts[id] : undefined), scores(goldenReport.verdicts[id]), id);
      assert.equal(result.kind === 'done' ? result.report.verdicts[id]?.solution : null, 1);
      assert.equal(result.kind === 'done' ? result.report.verdicts[id]?.noop : null, 0);
    }
    assert.deepEqual(Object.keys(result.kind === 'done' ? result.report.verdicts : {}), Object.keys(golden.tasks));
  });

  it('writes plan.yaml, REPORT.md with the semantic Changes, and the run log, beside the world', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const plan = planFor(golden, REFUND_PLAN_OVER);
    await iterate(dir, [{ input: plan }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);

    assert.equal(readFileSync(join(dir, 'plan.yaml'), 'utf8'), renderPlanYaml(plan));
    assert.equal(existsSync(join(dir, 'plan.yaml.tmp')), false);
    const report = readFileSync(join(dir, 'REPORT.md'), 'utf8');
    const changes = report.slice(report.indexOf('## Changes'), report.indexOf('## Assumed and why'));
    assert.equal(
      changes,
      [
        '## Changes',
        '',
        '- item_added `entities.refund`',
        '- item_added `routes.get_refund`',
        '- item_added `routes.list_refunds`',
        '- item_added `actions.issue_refund`',
        '- item_added `seed.refund`',
        '- item_added `tests.issue_refund_on_resolved`',
        '',
        '',
      ].join('\n'),
    );
    assert.ok(report.startsWith('# WorldGen report: Zendesk Support tickets API\n'));
    assert.ok(report.includes('| assign_newest_acme_ticket | '));
    const c = capsuleSchema.parse(JSON.parse(readFileSync(join(dir, CAPSULE_FILE), 'utf8')));
    assert.equal(c.mode, 'iterate');
    assert.deepEqual(c.input, { kind: 'change_request', digest: '30c2a0859ff08f0a9e51ebc8b8d082724e540031a7f27d320db4a350cc03ae23', source: { kind: 'change_request', before: 'runs/run_iter/before' } });
    // The world the change started from is saved, so the Changes section can be re-rendered from the capsule (A-351).
    const snapshot = await loadWorld(join(dir, 'runs', 'run_iter', 'before'));
    const startedFrom = snapshot.ok ? checkWorld(snapshot.value) : null;
    const now = await loadWorld(dir);
    const ended = now.ok ? checkWorld(now.value) : null;
    assert.ok(startedFrom?.ok && ended?.ok);
    assert.deepEqual(diffWorlds(startedFrom.world, ended.world).changes.map((ch) => `${ch.kind} ${ch.section}.${ch.key}`),
      ['item_added entities.refund', 'item_added routes.get_refund', 'item_added routes.list_refunds', 'item_added actions.issue_refund', 'item_added seed.refund', 'item_added tests.issue_refund_on_resolved']);
    assert.equal(report.includes(`World id (WID): \`${c.worldId}\`.`), true);
    assert.deepEqual(readdirSync(join(dir, 'runs', 'run_iter')).filter((f) => f === 'events.jsonl'), ['events.jsonl']);
    assert.equal(readdirSync(join(dir, 'runs', 'run_iter')).filter((f) => f.endsWith('.json')).length, 5);
  });

  it('asks the iterate plan step for open_questions with default answers, as create does (YOS-97)', () => {
    const text = stepBrief('plan', minimalWorld(), 'iterate');
    assert.equal(text.includes('list each question you would ask a human about the request in open_questions, each with a question and a default_answer'), true);
  });

  it('prompts each step with the change request, and a plan step that sees the world when there is no plan.yaml', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const { calls } = await iterate(dir, [{ input: planFor(golden, REFUND_PLAN_OVER) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.deepEqual(calls.map((c) => c.tool.name), ['submit_plan', 'edit_world', 'edit_world', 'edit_world', 'edit_world']);
    const plan = calls[0]?.prompt ?? '';
    assert.ok(plan.includes(`## Change request\n\n${REQUEST}`));
    assert.ok(plan.includes('## Existing world') && plan.includes('This world has no usable plan.yaml.'));
    assert.ok(plan.includes('name: helpdesk') && !plan.includes('## Existing plan'));
    assert.equal(calls[0]?.system, systemPrompt(minimalWorld()));
    assert.ok((calls[0]?.prompt ?? '').startsWith(`${stepBrief('plan', minimalWorld(), 'iterate')}\n\n`));
    assert.ok((calls[0]?.prompt ?? '').includes('An existing world must change to meet a change request.'));
    for (const c of calls.slice(1)) assert.ok(c.prompt.includes(`## Change request\n\n${REQUEST}`), c.tool.name);
    const frozen = { ...golden, tests: { ...golden.tests, issue_refund_on_resolved: ISSUE_REFUND_TEST } };
    assert.equal(calls[1]?.prompt, `${stepBrief('model', minimalWorld(), 'iterate')}\n\n${stagePrompt('model', planFor(golden, REFUND_PLAN_OVER), frozen, null, REQUEST)}`);
  });
});

describe('runWorldGen iterate: a change that reaches only some stages', () => {
  const NOTE_ACTION = {
    method: 'POST',
    path: '/tickets/{id}/note',
    description: 'Add a private internal note to a ticket.',
    input: { body: { type: 'text', required: true } },
    handler: `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'not_found', 'ticket ' + ctx.params.id + ' not found');
  const note = ctx.db.create('ticket_comment', { ticket_id: t.id, author_id: t.assignee_id, body: ctx.body.body, public: false });
  return { status: 201, body: note };
}`,
  };
  const NOTE_TEST = {
    description: 'add_note stores a private comment on the ticket.',
    script: `(ctx) => {
  const r = ctx.api('POST', '/tickets/tkt_0001/note', { body: 'called the customer' });
  ctx.assert(r.status === 201 && r.body.public === false, 'note is private, got ' + r.status + ' ' + JSON.stringify(r.body));
}`,
  };
  const NOTE_PLAN: PlanOver = {
    workflows: [{ name: 'notes', entity: 'ticket_comment', states: [], rules: ['a note is private'], actions: ['add_note'] }],
    acceptanceTests: [{ id: 'add_note_is_private', intent: 'a note is stored as a private comment', actions: ['add_note'], ...NOTE_TEST }],
  };
  const NOTE_EDIT = { note: 'add_note, which the planned test calls', upsert: { actions: { add_note: NOTE_ACTION } } };

  it('skips the stages the change does not reach, logs step_skipped, and calls the model only for the rest', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const { result, events, calls } = await iterate(dir, [{ input: planFor(golden, NOTE_PLAN) }, { input: NOTE_EDIT }, { input: { note: 'nothing to add' } }]);

    assert.equal(result.kind, 'done');
    assert.equal(calls.length, 3);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['workflow', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    const skipped = events.flatMap((e) => (e.t === 'step_skipped' ? [[e.step, e.why] as const] : []));
    assert.deepEqual(skipped, [
      ['model', 'no planned change reaches entities, routes, fixtures'],
      ['seed', 'no planned change reaches seed, entities, fixtures'],
    ]);
    // A skipped stage's marker sits between the steps that ran, in stage order.
    const order = events.flatMap((e) => (e.t === 'step_started' || e.t === 'step_skipped' ? [`${e.t}:${e.step}`] : []));
    assert.deepEqual(order, ['step_started:plan', 'step_skipped:model', 'step_started:workflow', 'step_skipped:seed', 'step_started:tasks']);

    const after = await loadChecked(dir);
    assert.deepEqual(delta(golden, after), ['item_added actions.add_note', 'item_added tests.add_note_is_private']);
    assert.deepEqual(after.seed, golden.seed);
    assert.deepEqual(after.entities, golden.entities);
    assert.deepEqual(after.tasks, golden.tasks);
    assert.ok(readFileSync(join(dir, 'REPORT.md'), 'utf8').includes('Skipped:\n\n- `model`: no planned change reaches entities, routes, fixtures\n- `seed`: no planned change reaches seed, entities, fixtures'));
  });

  it('skips a stage whose only failures the world already had before the run, and says so (A-290, hotel deadlock)', async () => {
    const golden = await loadChecked(helpdeskCopy());
    const SHORT = { seed: { rowsPerEntity: { ticket: 999 }, mix: 'as before' } };
    const dir = helpdeskCopy(recorded(golden, SHORT));
    const { result, events, calls } = await iterate(dir, [{ input: planFor(golden, { ...NOTE_PLAN, ...SHORT }) }, { input: NOTE_EDIT }, { input: { note: 'nothing to add' } }]);

    assert.equal(result.kind, 'done');
    assert.equal(calls.length, 3);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['workflow', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    const skipped = events.flatMap((e) => (e.t === 'step_skipped' ? [[e.step, e.why] as const] : []));
    assert.deepEqual(skipped, [
      ['model', 'no planned change reaches entities, routes, fixtures'],
      ['seed', 'no planned change reaches seed, entities, fixtures; it keeps 1 issue(s) the world had before this iterate: plan.seed_rows_short'],
    ]);
    assert.deepEqual((await loadChecked(dir)).seed, golden.seed);
  });

  it('still runs that stage when the plan itself raises the bar the world misses, with the failure as feedback', async () => {
    const golden = await loadChecked(helpdeskCopy());
    const dir = helpdeskCopy(recorded(golden, {}));
    const raised = planFor(golden, { ...NOTE_PLAN, seed: { rowsPerEntity: { ticket: 999 }, mix: 'as before' } });
    const { events, calls } = await iterate(dir, [{ input: raised }, { input: NOTE_EDIT }, { input: { note: 'no new rows' } }, { input: { note: 'no new rows' } }, { input: { note: 'no new rows' } }]);

    assert.deepEqual(events.flatMap((e) => (e.t === 'step_skipped' ? [e.step] : [])), ['model']);
    assert.ok((calls[2]?.prompt ?? '').includes('code: plan.seed_rows_short'));
  });

  /** Debt every stage's judge raises: a planned workflow on customer, which has no state field (plan.state_field_missing, owned by the model stage). */
  const CHURN = { name: 'churn', entity: 'customer', states: ['active', 'churned'], rules: [], actions: [] };

  it('a running stage, the last one included, is not blocked by debt the world already had, and the skipped stages name it (A-291)', async () => {
    const golden = await loadChecked(helpdeskCopy());
    const workflows = [...(NOTE_PLAN.workflows ?? []), CHURN];
    const dir = helpdeskCopy(recorded(golden, { workflows }));
    const { result, events, calls } = await iterate(dir, [{ input: planFor(golden, { ...NOTE_PLAN, workflows }) }, { input: NOTE_EDIT }, { input: { note: 'nothing to add' } }]);

    assert.equal(result.kind, 'done');
    assert.equal(calls.length, 3);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['workflow', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    const skipped = events.flatMap((e) => (e.t === 'step_skipped' ? [[e.step, e.why] as const] : []));
    assert.deepEqual(skipped, [
      ['model', 'no planned change reaches entities, routes, fixtures; it keeps 1 issue(s) the world had before this iterate: plan.state_field_missing'],
      ['seed', 'no planned change reaches seed, entities, fixtures; it keeps 1 issue(s) the world had before this iterate: plan.state_field_missing'],
    ]);
    assert.deepEqual(delta(golden, await loadChecked(dir)), ['item_added actions.add_note', 'item_added tests.add_note_is_private']);
  });

  it('debt whose owning stage the plan reaches is that stage\'s to pay: it still blocks there', async () => {
    const golden = await loadChecked(helpdeskCopy());
    const workflows = [...(REFUND_PLAN_OVER.workflows ?? []), CHURN];
    const dir = helpdeskCopy(recorded(golden, { workflows }));
    const { events } = await iterate(dir, [{ input: planFor(golden, { ...REFUND_PLAN_OVER, workflows }) }, { input: EDITS.model }, { input: EDITS.model }, { input: EDITS.model }]);

    const model = events.find((e) => e.t === 'attempt' && e.step === 'model');
    assert.ok(model?.t === 'attempt' && model.outcome.kind === 'rejected');
    assert.deepEqual(model.outcome.issues.map((i) => `${i.code} ${i.path.join('.')}`), ['plan.state_field_missing entities.customer']);
  });

  it('uses the existing plan.yaml as the plan step\'s context, not the world', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const previous = recorded(golden, { assumptions: [{ decision: 'tickets are the only workflow', why: 'the first plan' }] });
    writeFileSync(join(dir, 'plan.yaml'), renderPlanYaml(previous));
    const { result, calls } = await iterate(dir, [{ input: planFor(golden, NOTE_PLAN) }, { input: NOTE_EDIT }, { input: { note: 'nothing to add' } }]);
    assert.equal(result.kind, 'done');
    const prompt = calls[0]?.prompt ?? '';
    assert.ok(prompt.includes('## Existing plan') && prompt.includes('tickets are the only workflow'));
    assert.equal(prompt.includes('\n## Existing world\n'), false);
    assert.ok(prompt.includes('\n## Existing world clock\n'));
    // The accepted plan replaces the old one only after the run succeeded. The answer is a patch (A-345), so the old
    // support workflow, which it neither gives nor removes, stays, and the notes workflow is added.
    assert.deepEqual(parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'))?.workflows.map((w) => w.name), ['support', 'notes']);
  });

  it('treats a plan.yaml that does not parse as no plan, and says so by showing the world', async () => {
    const dir = helpdeskCopy('software: [not a plan\n');
    const golden = await loadChecked(dir);
    const { calls } = await iterate(dir, [{ input: planFor(golden, NOTE_PLAN) }, { input: NOTE_EDIT }, { input: { note: 'nothing to add' } }]);
    assert.ok((calls[0]?.prompt ?? '').includes('This world has no usable plan.yaml.'));
  });

  it('revises the plan alone when the world already meets it: one call, and world.yaml keeps its bytes (A-294)', async () => {
    const old = planFor(minimalWorld(), {});
    const dir = await minimalDir(old);
    const worldBytes = readFileSync(join(dir, 'world.yaml'), 'utf8');
    const next = planFor(minimalWorld(), { revision: 3, assumptions: [...old.assumptions, { decision: 'Support keeps no refund queue.', why: 'No entity holds refunds.' }] });
    const { result, calls } = await iterate(dir, [{ input: next }]);
    assert.equal(result.kind, 'done');
    assert.equal(calls.length, 1);
    assert.equal(readFileSync(join(dir, 'world.yaml'), 'utf8'), worldBytes);
    assert.deepEqual(parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'))?.assumptions.map((a) => a.decision), ['A refund is requested, then approved or rejected.', 'Support keeps no refund queue.']);
  });

  it('still refuses a plan identical to the old one apart from revision and changes (A-294)', async () => {
    const old = planFor(minimalWorld(), {});
    const dir = await minimalDir(old);
    const before = snapshot(dir);
    const { result, calls } = await iterate(dir, [{ input: { ...old, revision: 3 } }]);
    assert.equal(calls.length, 1);
    assert.equal(stoppedReason(result)?.kind, 'input_rejected');
    assert.deepEqual(snapshot(dir), before);
  });

  it('stops with input_rejected when the plan changes nothing, and writes nothing but the report and the log', async () => {
    const dir = await minimalDir();
    const before = snapshot(dir);
    const { result, calls } = await iterate(dir, [{ input: planFor(minimalWorld(), {}) }]);
    assert.equal(calls.length, 1);
    assert.equal(stoppedReason(result)?.kind, 'input_rejected');
    assert.deepEqual(snapshot(dir), before);
    assert.ok(readFileSync(join(dir, 'REPORT.md'), 'utf8').startsWith('Stopped: input_rejected\n\nThe input was rejected: the plan changes nothing in the world'));
  });
});

describe('runWorldGen iterate: the preservation gate', () => {
  it('rejects a silently removed state, repairs it from the feedback, and finishes with the state kept', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const plan = planFor(golden, REFUND_PLAN_OVER);
    const { result, events, calls } = await iterate(dir, [{ input: plan }, { input: DROP_CLOSED }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);

    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['model', 1, 'rejected'], ['model', 2, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    const rejected = events.find((e) => e.t === 'attempt' && e.step === 'model' && e.outcome.kind === 'rejected');
    const issues = rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? rejected.outcome.issues : [];
    const unplanned = issues.filter((i) => i.code === 'iterate.unplanned_change');
    assert.deepEqual(unplanned.map((i) => [i.path.join('.'), i.found]), [
      ['entities.ticket.fields.status.states.5', 'entities.ticket.fields.status.states.closed removed'],
      ['entities.ticket.fields.status.transitions.resolved', '["open","closed"] became ["open"]'],
    ]);

    // The repair prompt carries the rejection and the rejected answer.
    const retry = calls[2]?.prompt ?? '';
    assert.ok(retry.includes('## Your previous answer was rejected'));
    assert.ok(retry.includes('code: iterate.unplanned_change'));
    assert.ok(retry.includes('Unplanned: state_removed at entities.ticket.fields.status.states.closed.'));

    const after = await loadChecked(dir);
    assert.deepEqual(after.entities['ticket']?.fields['status'], golden.entities['ticket']?.fields['status']);
    assert.deepEqual(delta(golden, after).filter((c) => c.includes('ticket')), []);
  });

  it('rejects a silent endpoint change that the engine itself accepts, so the gate alone catches it', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const moved = { ...EDITS.model, upsert: { ...EDITS.model.upsert, routes: { ...REFUND_ROUTES, list_sla_policies: { ...golden.routes['list_sla_policies'], path: '/sla-policies' } } } };
    const { result, events } = await iterate(dir, [{ input: planFor(golden, REFUND_PLAN_OVER) }, { input: moved }, new ModelError('stop here')]);
    assert.equal(stoppedReason(result)?.kind, 'model_error');
    const rejected = events.find((e) => e.t === 'attempt' && e.step === 'model');
    const issues = rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? rejected.outcome.issues : [];
    assert.deepEqual(issues.map((i) => [i.code, i.path.join('.'), i.found]), [
      ['iterate.unplanned_change', 'routes.list_sla_policies.path', '"/sla_policies" became "/sla-policies"'],
    ]);
  });

  it('YOS-217 refuses an unrequested field addition (bookmarks case), then accepts the confined edit', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const customer = golden.entities['customer'];
    assert.ok(customer);
    const extra = { ...EDITS.model, upsert: { ...EDITS.model.upsert, entities: { ...EDITS.model.upsert.entities, customer: { ...customer, fields: { ...customer.fields, region: { type: 'string' } } } } } };
    const { result, events } = await iterate(dir, [{ input: planFor(golden, REFUND_PLAN_OVER) }, { input: extra }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.equal(result.kind, 'done');
    const first = events.find((e) => e.t === 'attempt' && e.step === 'model');
    const issues = first?.t === 'attempt' && first.outcome.kind === 'rejected' ? first.outcome.issues : [];
    assert.deepEqual(issues.map((i) => [i.code, i.path.join('.'), i.found]), [['iterate.out_of_scope', 'entities.customer.fields.region', 'field_added at entities.customer.fields.region']]);
    assert.equal(issues[0]?.hint, `The request ${JSON.stringify(REQUEST)} does not ask for entities.customer.fields.region. Undo that change, or name it in plan.changes as "entities.customer.fields.region because <words from the request that imply it>".`);
    assert.equal((await loadChecked(dir)).entities['customer']?.fields['region'], undefined);
  });

  it('YOS-217 refuses an unrequested seed change (hotel case), then accepts the confined edit', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const tweaked = { ...EDITS.seed, upsert: { seed: { ...EDITS.seed.upsert.seed, customer: golden.seed['customer']?.replace('=>', '=> /* more customers */') } } };
    const { result, events } = await iterate(dir, [{ input: planFor(golden, REFUND_PLAN_OVER) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: tweaked }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events).filter(([step]) => step === 'seed'), [['seed', 1, 'rejected'], ['seed', 2, 'accepted']]);
    const first = events.find((e) => e.t === 'attempt' && e.step === 'seed');
    const issues = first?.t === 'attempt' && first.outcome.kind === 'rejected' ? first.outcome.issues : [];
    assert.deepEqual(issues.map((i) => [i.code, i.path.join('.')]), [['iterate.out_of_scope', 'seed.customer']]);
    assert.equal((await loadChecked(dir)).seed['customer'], golden.seed['customer']);
  });

  it('YOS-217 accepts that seed change when plan.changes quotes a request clause that asks for it, never one that forbids it', async () => {
    const request = 'add refunds: an agent can refund a resolved ticket, and seed a few more customers. Do not change oncall shift seeds';
    const tweak = (golden: World) => ({ ...EDITS.seed, upsert: { seed: { ...EDITS.seed.upsert.seed, customer: golden.seed['customer']?.replace('=>', '=> /* more customers */'), oncall_shift: golden.seed['oncall_shift']?.replace('=>', '=> /* more shifts */') } } });
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const plan = planFor(golden, { ...REFUND_PLAN_OVER, changes: ['seed.oncall_shift because Do not change oncall shift seeds'] });
    const { events } = await iterate(dir, [{ input: plan }, { input: EDITS.model }, { input: EDITS.workflow }, { input: tweak(golden) }, new ModelError('stop here')], { request });
    const first = events.find((e) => e.t === 'attempt' && e.step === 'seed');
    const issues = first?.t === 'attempt' && first.outcome.kind === 'rejected' ? first.outcome.issues : [];
    // seed.customer traces through "customers" in an asked clause; seed.oncall_shift's reason quotes the forbidding clause, so it does not count.
    assert.deepEqual(issues.filter((i) => i.code === 'iterate.out_of_scope').map((i) => i.path.join('.')), ['seed.oncall_shift']);
  });

  it('accepts the same removal at the model stage when plan.changes names the state and its transitions', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const plan = planFor(golden, { ...REFUND_PLAN_OVER, changes: ['ticket.fields.status.states.closed', 'ticket.fields.status.transitions.resolved', 'ticket.fields.status.transitions.closed'] });
    const { events } = await iterate(dir, [{ input: plan }, { input: DROP_CLOSED }, new ModelError('stop here')]);
    // The engine's own verdict on the edited world is not this test's concern. The gate raises nothing for what plan.changes names.
    const issues = events.flatMap((e) => (e.t === 'attempt' && e.step === 'model' && e.outcome.kind === 'rejected' ? e.outcome.issues : []));
    assert.deepEqual(issues.filter((i) => i.code.startsWith('iterate.')), []);
  });

  it('stops with attempts_exhausted when the model keeps removing the state, and leaves the world and plan as they were', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const previous = recorded(golden, { assumptions: [{ decision: 'the first plan', why: 'older run' }] });
    writeFileSync(join(dir, 'plan.yaml'), renderPlanYaml(previous));
    const before = snapshot(dir);
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { model: { maxAttempts: 2 } } });
    const { result, events } = await iterate(dir, [{ input: planFor(golden, REFUND_PLAN_OVER) }, { input: DROP_CLOSED }, { input: DROP_CLOSED_AND_LOW }], { config });

    assert.equal(stoppedReason(result)?.kind, 'attempts_exhausted');
    assert.deepEqual(snapshot(dir), before);
    const last = events[events.length - 1];
    assert.equal(last?.t === 'run_finished' && last.worldWritten, false);
    const report = readFileSync(join(dir, 'REPORT.md'), 'utf8');
    assert.ok(report.startsWith('Stopped: attempts_exhausted\n\nThe model step was still rejected after 2 attempts.\n'));
    assert.ok(report.includes('`iterate.unplanned_change`'));
    // No stage was accepted. The only change is the planned test the approved plan wrote into the world.
    assert.ok(report.includes('## Changes\n\nThe run stopped, so none of these changes were written:\n\n- item_added `tests.issue_refund_on_resolved`\n\n'));
  });
});

describe('runWorldGen iterate: frozen acceptance tests (A-99)', () => {
  const RESOLVE_SCRIPT = `(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Test Co', tier: 'free' });
  const t = ctx.api('POST', '/tickets', { customer: c.body.id, subject: 'Help', priority: 'low' });
  ctx.api('PATCH', '/tickets/' + t.body.id, { status: 'pending' });
  const r = ctx.api('POST', '/tickets/' + t.body.id + '/resolve');
  ctx.assert(r.status === 200, 'resolve returned ' + r.status);
}`;
  const STRONGER_SCRIPT = RESOLVE_SCRIPT.replace(
    "ctx.assert(r.status === 200, 'resolve returned ' + r.status);",
    "ctx.assert(r.status === 200, 'resolve returned ' + r.status);\n  ctx.assert(ctx.api('GET', '/tickets/' + t.body.id).body.status === 'resolved', 'not resolved');",
  );
  const RESOLVE = { description: 'a pending ticket can be resolved', script: RESOLVE_SCRIPT };
  const LIST = { description: 'customers can be listed', script: "(ctx) => { const r = ctx.api('GET', '/customers'); ctx.assert(r.status === 200, 'list returned ' + r.status); }" };
  const world = (): World => minimalWorld({ tests: { resolve_pending_ticket: RESOLVE, list_customers: LIST } });
  const SUPPORT = [{ name: 'support', entity: 'ticket', states: ['pending', 'resolved'], rules: [], actions: ['resolve_ticket'] }];
  /** A plan that rewrites resolve_pending_ticket, with `changes` as given. */
  const rewrite = (script: string, changes: readonly string[]): Plan => planFor(world(), {
    workflows: SUPPORT,
    acceptanceTests: [{ id: 'resolve_pending_ticket', intent: 'resolving works', actions: ['resolve_ticket'], ...RESOLVE, script }],
    changes: [...changes],
  });
  const TASK_ONLY = ['tasks.resolve_password_ticket.instruction'];
  const issuesAt = (events: readonly RunEvent[], step: string, n: number) =>
    events.flatMap((e) => (e.t === 'attempt' && e.step === step && e.n === n && (e.outcome.kind === 'rejected' || e.outcome.kind === 'invalid_output') ? e.outcome.issues : []));

  it('requires the plan revision to rise above the recorded plan.yaml', async () => {
    const dir = await minimalDir(recorded(world(), {}), world());
    const { result, events } = await iterate(dir, [
      { input: planFor(world(), { revision: 1, changes: TASK_ONLY }) }, { input: planFor(world(), { changes: TASK_ONLY }) }, { input: { note: 'wording kept' } },
    ]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'accepted'], ['tasks', 1, 'accepted']]);
    assert.deepEqual(issuesAt(events, 'plan', 1).map((i) => [i.code, i.path.join('.'), i.found]), [['schema.invalid', 'plan.revision', '1']]);
    assert.equal(parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'))?.revision, 2);
  });

  it('refuses a plan that rewrites an existing test without naming it in changes, however high its revision', async () => {
    const dir = await minimalDir(recorded(world(), {}), world());
    const before = snapshot(dir);
    const weak = { ...rewrite("(ctx) => { ctx.api('GET', '/tickets'); ctx.assert(true, 'always'); }", TASK_ONLY), revision: 9 };
    const { result, events } = await iterate(dir, [{ input: weak }, new ModelError('stop here')]);
    assert.equal(stoppedReason(result)?.kind, 'model_error');
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'model_error']]);
    const [refused, ...rest] = issuesAt(events, 'plan', 1);
    assert.equal(rest.length, 0);
    assert.equal(refused?.code, 'schema.invalid');
    assert.equal(refused?.path.join('.'), 'plan.acceptanceTests.0');
    assert.equal(refused?.expected, 'acceptance test resolve_pending_ticket rewrites the existing tests.resolve_pending_ticket: copy it unchanged, or name tests.resolve_pending_ticket in changes');
    assert.deepEqual(snapshot(dir), before);
  });

  it('naming tests.<id> in changes unfreezes exactly that test: it is rewritten, and every other test stays byte for byte', async () => {
    const dir = await minimalDir(recorded(world(), {}), world());
    const old = await loadChecked(dir);
    const { result, events } = await iterate(dir, [{ input: rewrite(STRONGER_SCRIPT, ['tests.resolve_pending_ticket']) }, { input: { note: 'the handler already passes' } }]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['workflow', 1, 'accepted']]);
    const after = await loadChecked(dir);
    assert.deepEqual(delta(old, after), ['snippet_changed tests.resolve_pending_ticket.script']);
    assert.equal(after.tests['resolve_pending_ticket']?.script, STRONGER_SCRIPT);
    assert.deepEqual(after.tests['list_customers'], LIST);
  });

  it('drops an existing test only when changes names it and acceptanceTests leaves it out', async () => {
    const dir = await minimalDir(recorded(world(), {}), world());
    const old = await loadChecked(dir);
    // The request asks for the drop: scope (A-289) refuses changes the request does not ask for.
    const { result } = await iterate(dir, [{ input: planFor(world(), { changes: ['tests.list_customers'] }) }, { input: { note: 'nothing to build' } }], { request: 'drop the list customers acceptance test' });
    assert.equal(result.kind, 'done');
    const after = await loadChecked(dir);
    assert.deepEqual(delta(old, after), ['item_removed tests.list_customers']);
    assert.deepEqual(after.tests, { resolve_pending_ticket: RESOLVE });
  });

  it('rejects a stage edit to an old test the plan did not unfreeze, and sends it back to the plan', async () => {
    const dir = await minimalDir(recorded(world(), {}), world());
    const before = snapshot(dir);
    const weaken = { note: 'relax the listing test', patch: { tests: { list_customers: { script: "(ctx) => { ctx.assert(true, 'always'); }" } } } };
    const { result, events } = await iterate(dir, [{ input: rewrite(STRONGER_SCRIPT, ['tests.resolve_pending_ticket']) }, { input: weaken }, new ModelError('stop here')]);
    assert.equal(stoppedReason(result)?.kind, 'model_error');
    const [refused, ...rest] = issuesAt(events, 'workflow', 1);
    assert.equal(rest.length, 0);
    assert.equal(refused?.code, 'edit.out_of_scope');
    assert.equal(refused?.path.join('.'), 'tests');
    assert.deepEqual(events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to]] : [])), [['workflow', 'plan']]);
    assert.deepEqual(snapshot(dir), before);
  });

  /** The resolution rule bound to the acceptance test that exercises it (YOS-155). */
  const BOUND_RULE = { rule: 'only a pending ticket can be resolved', by: ['resolve_ticket'], test: 'resolve_pending_ticket' };
  /** A change plan whose workflow binds that rule, with resolve_pending_ticket rewritten to `script`. */
  const bound = (script: string, changes: readonly string[]): Plan => planFor(world(), {
    workflows: [{ name: 'support', entity: 'ticket', states: ['pending', 'resolved'], rules: [BOUND_RULE], actions: ['resolve_ticket'] }],
    acceptanceTests: [{ id: 'resolve_pending_ticket', intent: 'resolving works', actions: ['resolve_ticket'], ...RESOLVE, script }],
    changes: [...changes],
  });

  it('refuses to rewrite a rule-bound test without tests.<id> in changes, and writes it named with a higher revision', async () => {
    const dir = await minimalDir({ ...bound(RESOLVE_SCRIPT, []), revision: 1 }, world());
    const weak = "(ctx) => { ctx.api('GET', '/tickets'); ctx.assert(true, 'always'); }";
    const { result, events } = await iterate(dir, [
      { input: bound(weak, TASK_ONLY) },
      { input: bound(STRONGER_SCRIPT, ['tests.resolve_pending_ticket']) },
      { input: { note: 'the handler already passes' } },
    ]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'accepted'], ['workflow', 1, 'accepted']]);
    const [refused, ...rest] = issuesAt(events, 'plan', 1);
    assert.equal(rest.length, 0);
    assert.equal(refused?.code, 'schema.invalid');
    assert.equal(refused?.path.join('.'), 'plan.acceptanceTests.0');
    assert.equal(refused?.expected, 'acceptance test resolve_pending_ticket rewrites the existing tests.resolve_pending_ticket: copy it unchanged, or name tests.resolve_pending_ticket in changes');
    const after = await loadChecked(dir);
    assert.deepEqual(after.tests, { resolve_pending_ticket: { ...RESOLVE, script: STRONGER_SCRIPT }, list_customers: LIST });
    const saved = parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'));
    assert.equal(saved?.revision, 2);
    assert.deepEqual(saved?.workflows[0]?.rules, [BOUND_RULE]);
  });

  it('rejects a workflow edit that touches a rule-bound test, and backtracks to the plan step that owns it', async () => {
    const dir = await minimalDir({ ...bound(RESOLVE_SCRIPT, []), revision: 1 }, world());
    const before = snapshot(dir);
    const weaken = { note: 'relax the bound test', patch: { tests: { resolve_pending_ticket: { script: "(ctx) => { ctx.assert(true, 'always'); }" } } } };
    const { result, events, calls } = await iterate(dir, [
      { input: bound(STRONGER_SCRIPT, ['tests.resolve_pending_ticket']) }, { input: weaken }, new ModelError('stop here'),
    ]);
    assert.equal(stoppedReason(result)?.kind, 'model_error');
    // The backtrack resets the plan step's attempts, so its second call is attempt 1 again.
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['workflow', 1, 'rejected'], ['plan', 1, 'model_error']]);
    const [refused, ...rest] = issuesAt(events, 'workflow', 1);
    assert.equal(rest.length, 0);
    assert.equal(refused?.code, 'edit.out_of_scope');
    assert.equal(refused?.path.join('.'), 'tests');
    assert.deepEqual(events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to]] : [])), [['workflow', 'plan']]);
    assert.equal(calls[2]?.prompt.includes('- code: edit.out_of_scope\n  path: tests\n'), true);
    assert.deepEqual(snapshot(dir), before);
  });

  it('after a backtrack, shows the plan accepted in this run and asks for a patch on it (A-345)', async () => {
    const dir = await minimalDir({ ...bound(RESOLVE_SCRIPT, []), revision: 1 }, world());
    const weaken = { note: 'relax the bound test', patch: { tests: { resolve_pending_ticket: { script: "(ctx) => { ctx.assert(true, 'always'); }" } } } };
    const { calls } = await iterate(dir, [
      { input: bound(STRONGER_SCRIPT, ['tests.resolve_pending_ticket']) }, { input: weaken }, new ModelError('stop here'),
    ]);
    const shown = calls[2]?.prompt ?? '';
    assert.equal(shown.includes('## Existing plan\n\n```yaml\nrevision: 2\n'), true);
    assert.equal(shown.includes('Answer again with a patch on the plan above, and fix every issue below.'), true);
    assert.equal(shown.includes('Answer again in full'), false);
  });
});

describe('runWorldGen iterate: every stop leaves world.yaml and plan.yaml byte for byte', () => {
  /** minimalWorld plus the plan's refund entity, so stages after `model` have something to run on. */
  const refundPlan = (): Plan => planFor(minimalWorld(), REFUND_PLAN_OVER);
  const previousPlan = (): Plan => recorded(minimalWorld(), { assumptions: [{ decision: 'the first plan', why: 'older run' }] });

  async function stopped(script: Script, config: Config = CONFIG) {
    const dir = await minimalDir(previousPlan());
    const before = snapshot(dir);
    const ran = await iterate(dir, script, { config });
    assert.equal(ran.result.kind, 'stopped');
    assert.deepEqual(snapshot(dir), before);
    assert.equal(existsSync(join(dir, 'world.yaml.tmp')), false);
    assert.equal(existsSync(join(dir, 'plan.yaml.tmp')), false);
    const last = ran.events[ran.events.length - 1];
    assert.equal(last?.t === 'run_finished' && last.worldWritten, false);
    return { ...ran, report: readFileSync(join(dir, 'REPORT.md'), 'utf8') };
  }

  it('model_error on the plan step', async () => {
    const { result, report, calls } = await stopped([new ModelError('rate limited', undefined, { usage: USAGE, costUsd: 0.5, ms: 10 })]);
    assert.deepEqual(stoppedReason(result), { kind: 'model_error', message: 'rate limited' });
    assert.equal(result.costUsd, 0.5);
    assert.equal(calls.length, 1);
    assert.ok(report.startsWith('Stopped: model_error\n\nThe model call failed: rate limited\n\nNo world.yaml was written.\n'));
  });

  it('model_error after earlier stages were accepted in memory: the report lists the changes it did not write', async () => {
    const { result, report } = await stopped([{ input: refundPlan() }, { input: EDITS.model }, new ModelError('connection reset')]);
    assert.deepEqual(stoppedReason(result), { kind: 'model_error', message: 'connection reset' });
    assert.ok(report.includes('The run stopped, so none of these changes were written:\n\n- item_added `entities.refund`\n- item_added `routes.get_refund`\n- item_added `routes.list_refunds`\n'));
    assert.ok(report.includes('Nothing was handed over: the run stopped.'));
  });

  it('budget_exhausted', async () => {
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 0.25, maxOutputTokens: 100 });
    const { result, calls } = await stopped([{ input: refundPlan() }, { input: EDITS.model }, { input: EDITS.workflow }], config);
    assert.deepEqual(stoppedReason(result), { kind: 'budget_exhausted', spentUsd: 0.25, limitUsd: 0.25 });
    assert.equal(calls.length, 2);
  });

  it('time_exhausted, before the first call', async () => {
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 1 });
    const { result, calls, report } = await stopped([{ input: refundPlan() }], config);
    assert.deepEqual(stoppedReason(result), { kind: 'time_exhausted', minutes: 1, refused: { step: 'plan', estimateMs: 206_000, remainingMs: 56_000 } });
    assert.equal(calls.length, 0);
    assert.ok(report.startsWith('Stopped: time_exhausted\n\nThe run did not reach its 1-minute limit: the next call (plan) needed ~206 s and 56 s were left.\n'));
  });

  it('a plan that refuses the request', async () => {
    const { result, report } = await stopped([{ input: { ...refundPlan(), verdict: { kind: 'refuse', why: 'refunds would move real money' }, workflows: [], tasks: [] } }]);
    assert.deepEqual(stoppedReason(result), { kind: 'input_rejected', why: 'refunds would move real money' });
    assert.ok(report.includes('The input was rejected: refunds would move real money'));
  });

  it('the world no longer passes the engine: nothing is asked of the model', async () => {
    const dir = tmp();
    const broken = 'format: 1\nmeta:\n  name: broken\n';
    writeFileSync(join(dir, 'world.yaml'), broken);
    const { result, calls } = await iterate(dir, []);
    assert.equal(calls.length, 0);
    assert.equal(stoppedReason(result)?.kind, 'input_rejected');
    assert.equal(readFileSync(join(dir, 'world.yaml'), 'utf8'), broken);
  });
});

describe('runWorldGen iterate: an IO failure is not a half-written world', () => {
  const plan = (): Plan => planFor(minimalWorld(), { ...REFUND_PLAN_OVER, seed: { rowsPerEntity: {}, mix: 'no new rows' } });

  for (const boundary of ['plan rename', 'report write'] as const) {
    it(`restores the original world and plan when the final ${boundary} fails`, async () => {
      const dir = await minimalDir(recorded(minimalWorld(), { assumptions: [{ decision: 'the first plan', why: 'older run' }] }));
      const before = snapshot(dir);
      let injected = false;
      const fs: RunFs = {
        ...fsPromises,
        rename: async (...args: Parameters<typeof fsPromises.rename>) => {
          if (!injected && boundary === 'plan rename' && String(args[0]) === join(dir, 'plan.yaml.tmp')) {
            injected = true;
            throw new Error('injected final persistence failure');
          }
          return fsPromises.rename(...args);
        },
        writeFile: async (...args: Parameters<typeof fsPromises.writeFile>) => {
          if (!injected && boundary === 'report write' && String(args[0]) === join(dir, 'REPORT.md')) {
            injected = true;
            throw new Error('injected final persistence failure');
          }
          return fsPromises.writeFile(...args);
        },
      };
      const bare = { note: 'nothing more to add' };
      await assert.rejects(iterate(dir, [{ input: plan() }, { input: EDITS.model }, { input: EDITS.workflow }, { input: bare }, { input: bare }], { fs }), /injected final persistence failure/);
      assert.equal(injected, true);
      assert.deepEqual(snapshot(dir), before);
      assert.match(readFileSync(join(dir, 'REPORT.md'), 'utf8'), /^Crashed: injected final persistence failure/);
      const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(dir, 'capsule.json'), 'utf8')));
      assert.equal(capsule.worldId, null);
      assert.equal(capsule.costUsd, 0.625);
      assert.equal(capsule.attempts.length, 5);
      const finished = readFileSync(join(dir, 'runs', 'run_iter', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.t === 'run_finished');
      assert.equal(finished.length, 1);
      assert.equal(finished[0].result.kind, 'crashed');
      assert.equal(finished[0].worldWritten, false);
    });
  }

  it('records unknown persistence when restoring the old world also fails', async () => {
    const dir = await minimalDir(recorded(minimalWorld(), {}));
    const first = new Error('final report failed before rollback');
    let injected = false;
    const fs: RunFs = { ...fsPromises, async writeFile(...args: Parameters<typeof fsPromises.writeFile>) {
      if (!injected && String(args[0]) === join(dir, 'REPORT.md')) {
        injected = true;
        mkdirSync(join(dir, 'world.yaml.tmp'));
        throw first;
      }
      return fsPromises.writeFile(...args);
    } };
    const bare = { note: 'nothing more to add' };
    await assert.rejects(iterate(dir, [{ input: plan() }, { input: EDITS.model }, { input: EDITS.workflow }, { input: bare }, { input: bare }], { fs }), error => error instanceof AggregateError && error.errors[0] === first && error.errors.length === 2);
    assert.match(readFileSync(join(dir, 'REPORT.md'), 'utf8'), /Whether world.yaml was restored is unknown after rollback failed/);
    const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(dir, 'capsule.json'), 'utf8')));
    assert.equal(capsule.worldId, null);
    assert.equal(capsule.costUsd, 0.625);
    const finished = readFileSync(join(dir, 'runs', 'run_iter', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.t === 'run_finished');
    assert.equal(finished.length, 1);
    assert.equal(finished[0].result.kind, 'crashed');
    assert.equal(finished[0].worldWritten, null);
  });

  it('a dump that cannot be written mid-run rejects the run and leaves world.yaml and plan.yaml untouched', async () => {
    const dir = await minimalDir(recorded(minimalWorld(), { assumptions: [{ decision: 'the first plan', why: 'older run' }] }));
    const before = snapshot(dir);
    // A directory where the first attempt dump goes, so the write after the model call fails.
    mkdirSync(join(dir, 'runs', 'run_iter', '001-plan-1.json'), { recursive: true });
    await assert.rejects(iterate(dir, [{ input: plan() }]), /EISDIR/);
    assert.deepEqual(snapshot(dir), before);
  });

  it('a world that cannot be saved at the end rejects the run, removes the staged plan and keeps the old plan', async () => {
    const dir = await minimalDir(recorded(minimalWorld(), { assumptions: [{ decision: 'the first plan', why: 'older run' }] }));
    const before = snapshot(dir);
    // A directory where saveWorld stages world.yaml, so saving fails after every stage was accepted.
    mkdirSync(join(dir, 'world.yaml.tmp'));
    // The refund world with no seed and no new task passes the engine, so the whole run is accepted before the save.
    const bare = { note: 'nothing more to add' };
    await assert.rejects(iterate(dir, [{ input: plan() }, { input: EDITS.model }, { input: EDITS.workflow }, { input: bare }, { input: bare }]), /EISDIR/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(existsSync(join(dir, 'plan.yaml.tmp')), false);
  });
});

describe('runWorldGen iterate: an action no frozen test calls (YOS-127)', () => {
  /** issue_refund, which the planned test calls, plus void_refund, which the plan never named and no test calls. */
  const EXTRA_ACTION = {
    note: 'issue_refund, and a void action no test calls',
    upsert: {
      actions: {
        issue_refund: ISSUE_REFUND,
        void_refund: { method: 'POST', path: '/refunds/{id}/void', description: 'Void a requested refund.', handler: "(ctx) => ({ status: 200, body: ctx.db.get('refund', ctx.params.id) })" },
      },
    },
  };

  it('repairs at the workflow step by dropping the extra action, never backtracking to the plan, and saves the world', async () => {
    const dir = helpdeskCopy();
    const golden = await loadChecked(dir);
    const plan = planFor(golden, REFUND_PLAN_OVER);
    const { result, events, calls } = await iterate(dir, [{ input: plan }, { input: EDITS.model }, { input: EXTRA_ACTION }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);

    assert.deepEqual(stoppedReason(result), null);
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'rejected'], ['workflow', 2, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    assert.deepEqual(events.filter((e) => e.t === 'backtracked'), []);
    const rejected = events.find((e) => e.t === 'attempt' && e.step === 'workflow' && e.outcome.kind === 'rejected');
    const issues = rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? rejected.outcome.issues : [];
    assert.deepEqual(issues.map((i) => [i.code, i.path.join('.')]), [['action.unexercised', 'actions.void_refund']]);
    const repair = calls[3]?.prompt ?? '';
    assert.ok(repair.includes('code: action.unexercised'));
    assert.ok(repair.includes('hint: Remove void_refund, or call it from a test or a task solution.'));
    assert.deepEqual(Object.keys((await loadChecked(dir)).actions).includes('void_refund'), false);
  });
});

describe('runWorldGen iterate: judging exceptions', () => {
  it('writes a stopped report and preserves the original files when an unchanged stage cannot be judged', async () => {
    const world = minimalWorld();
    const dir = await minimalDir(recorded(world, {}), world);
    const before = snapshot(dir);
    const { result, calls } = await iterate(dir, [{ input: planFor(world, { changes: ['tests'] }) }], { check: () => { throw new Error('runtime seeding failed during preservation'); } });
    assert.deepEqual(stoppedReason(result), { kind: 'judge_error', step: 'model', message: 'runtime seeding failed during preservation' });
    assert.deepEqual(snapshot(dir), before);
    assert.equal(calls.length, 1);
    assert.match(readFileSync(join(dir, 'REPORT.md'), 'utf8'), /Stopped: judge_error/);
  });
});

describe('runWorldGen iterate: a pressure claim on a world built before the pressure gate (YOS-218, A-285)', () => {
  const HARD = 'archive_all_finished_projects';
  const REQ = 'give every task an allows list grounded in its instruction, and change nothing else';
  const REJECTED = `task ${HARD} adds pressure the existing plan does not have (paging: task), but no planned change reaches the seed, so no step would seed for it: keep the task's existing pressure, or, if the request asks for harder tasks, name seed.task in changes`;

  /** A scratch copy of gen-todo-projects with its plan.yaml (revision 1, no pressure on any task), and that plan. */
  function todoCopy(): { dir: string; old: Plan } {
    const dir = tmp();
    copyFileSync(join(TODO, 'world.yaml'), join(dir, 'world.yaml'));
    copyFileSync(join(TODO, 'plan.yaml'), join(dir, 'plan.yaml'));
    const old = parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'));
    if (old === null) throw new Error('gen-todo-projects plan.yaml does not parse');
    return { dir, old };
  }
  /** The old plan reworded for allows, as the live plan step wrote it: tasks.<hard> in changes, and `pressure` on the hard task. */
  const allowsPlan = (old: Plan, revision: number, pressure: Plan['tasks'][number]['pressure'], changes: readonly string[]): Plan => ({
    ...old, revision, changes: [...changes],
    tasks: old.tasks.map((t) => (t.id === HARD ? { ...t, intent: `${t.intent} Allows: project status and archived_at.`, ...(pressure === undefined ? {} : { pressure }) } : t)),
  });
  const PAGING = { paging: 'task' };

  it('refuses at the plan step a paging claim the old plan lacks while the seed step would not rerun, then finishes on the old seed', async () => {
    const { dir, old } = todoCopy();
    const before = await loadChecked(dir);
    const { result, events, calls } = await iterate(dir, [
      { input: allowsPlan(old, 2, PAGING, [`tasks.${HARD}`]) },
      { input: allowsPlan(old, 2, undefined, [`tasks.${HARD}`]) },
      { input: { note: 'allows live in the task intents; no task changes' } },
    ], { request: REQ });
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'accepted'], ['tasks', 1, 'accepted']]);
    const first = events.find((e) => e.t === 'attempt' && e.n === 1);
    assert.deepEqual(first?.t === 'attempt' && first.outcome.kind === 'invalid_output' ? first.outcome.issues.map((i) => [i.code, i.path.join('.'), i.expected]) : null, [
      ['schema.invalid', 'plan.tasks.2.pressure', REJECTED],
    ]);
    assert.ok((calls[1]?.prompt ?? '').includes(REJECTED));
    const after = await loadChecked(dir);
    assert.deepEqual(after.seed, before.seed);
    assert.equal(parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'))?.tasks[2]?.pressure, undefined);
  });

  it('a claim the seed cannot make true goes back to the plan after two tasks attempts, not no_progress', async () => {
    const { dir, old } = todoCopy();
    const before = await loadChecked(dir);
    const note = { input: { note: 'nothing to change' } };
    const { result, events } = await iterate(dir, [
      { input: allowsPlan(old, 2, PAGING, [`tasks.${HARD}`, 'seed.task']) },
      note,
      note,
      note,
      { input: allowsPlan(old, 3, undefined, [`tasks.${HARD}`]) },
      note,
    ], { request: REQ });

    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'rejected'], ['tasks', 2, 'rejected'], ['plan', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    const back = events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to, e.because.map((i) => `${i.code}@${i.path.join('/')}: ${i.found}`)] as const] : []));
    assert.deepEqual(back, [['tasks', 'plan', [`task.pressure_unmet@tasks/${HARD}: 130 task rows over 25-row pages, and the reference changed no row it reached only past the first page`]]]);
    const after = await loadChecked(dir);
    assert.deepEqual(after.seed, before.seed);
  });
});

describe('iteratePlanSchema: a pressure claim the old plan lacks needs the seed step (A-285)', () => {
  const HARD = 'archive_all_finished_projects';
  const load = async (): Promise<{ world: World; old: Plan }> => {
    const old = parsePlanYaml(readFileSync(join(TODO, 'plan.yaml'), 'utf8'));
    if (old === null) throw new Error('gen-todo-projects plan.yaml does not parse');
    return { world: await loadChecked(TODO), old };
  };
  const withPressure = (plan: Plan, pressure: Plan['tasks'][number]['pressure'], changes: readonly string[]): Plan => ({
    ...plan, revision: plan.revision + 1, changes: [...changes],
    tasks: plan.tasks.map((t) => (t.id === HARD ? { ...t, pressure } : t)),
  });
  const problems = (world: World, old: Plan | null, plan: Plan): string[] => {
    const r = iteratePlanSchema(world, old).safeParse(plan);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('accepts the claim when changes names the seed of the pressed entity', async () => {
    const { world, old } = await load();
    assert.deepEqual(problems(world, old, withPressure(old, { paging: 'task' }, [`tasks.${HARD}`, 'seed.task'])), []);
  });

  it('accepts a claim the old plan already makes, with no seed change', async () => {
    const { world, old } = await load();
    const had = withPressure(old, { paging: 'task', states: ['task.done'] }, []);
    assert.deepEqual(problems(world, had, withPressure(had, { paging: 'task', states: ['task.done'] }, [`tasks.${HARD}`])), []);
    assert.deepEqual(problems(world, had, withPressure(had, undefined, [`tasks.${HARD}`])), []);
  });

  it('names only the claims the old plan lacks, and the seed of each pressed entity', async () => {
    const { world, old } = await load();
    const had = withPressure(old, { states: ['task.done'] }, []);
    assert.deepEqual(problems(world, had, withPressure(had, { states: ['task.done', 'project.archived'], distractors: 'task' }, [`tasks.${HARD}`])), [
      `tasks.2.pressure: task ${HARD} adds pressure the existing plan does not have (states: project.archived; distractors: task), but no planned change reaches the seed, so no step would seed for it: keep the task's existing pressure, or, if the request asks for harder tasks, name seed.project, seed.task in changes`,
    ]);
  });

  it('holds every claim to the rule when the world has no usable plan.yaml', async () => {
    const { world, old } = await load();
    assert.deepEqual(problems(world, null, withPressure(old, { paging: 'task' }, [`tasks.${HARD}`])), [
      `tasks.2.pressure: task ${HARD} adds pressure the existing plan does not have (paging: task), but no planned change reaches the seed, so no step would seed for it: keep the task's existing pressure, or, if the request asks for harder tasks, name seed.task in changes`,
    ]);
  });
});

describe('applyPlanPatch: an iterate plan answer is a patch on the existing plan (A-345)', () => {
  const wf = (name: string, entity: string) => ({ name, entity, states: ['open'], rules: [], actions: [] });
  const TEST_A = { id: 'a', intent: 'i', actions: ['x'], description: 'd', script: 's' };
  const base = planFor(minimalWorld(), { revision: 3, workflows: [wf('support', 'ticket'), wf('billing', 'invoice')], acceptanceTests: [TEST_A], assumptions: [{ decision: 'kept', why: 'old' }] });

  it('replaces a given item by its key, adds a new one, keeps what it leaves out, and drops what remove lists', () => {
    const lifecycle = { representation: 'descriptive' as const, reason: 'derived from a flag' };
    const patch = planPatchSchema.parse({
      revision: 4, changes: [], remove: ['workflows.billing'],
      workflows: [{ ...wf('support', 'ticket'), lifecycle }, wf('refunds', 'refund')],
      assumptions: [{ decision: 'kept', why: 'old' }, { decision: 'new', why: 'the request' }],
    });
    const merged = applyPlanPatch(base, patch);
    assert.deepEqual(merged.workflows.map((w) => [w.name, w.lifecycle?.representation ?? null]), [['support', 'descriptive'], ['refunds', null]]);
    assert.deepEqual(merged.assumptions, [{ decision: 'kept', why: 'old' }, { decision: 'new', why: 'the request' }]);
    assert.deepEqual([merged.revision, merged.changes, merged.acceptanceTests], [4, ['workflows.billing'], [TEST_A]]);
    const rest = (p: Plan) => ({ ...p, revision: 0, changes: [], workflows: [], assumptions: [] });
    assert.deepEqual(rest(merged), rest(base));
  });

  it('drops only what remove lists, records it in changes, and keeps a task that changes merely names', () => {
    const tasks = ['t1', 't2', 't3', 't4'].map((id) => ({ id, difficulty: 'easy' as const, intent: id, decoyIdea: 'none' }));
    const merged = applyPlanPatch({ ...base, tasks }, planPatchSchema.parse({ revision: 4, changes: ['tasks.t1'], remove: ['tasks.t2'] }));
    assert.deepEqual([merged.tasks.map((t) => t.id), merged.changes], [['t1', 't3', 't4'], ['tasks.t1', 'tasks.t2']]);
  });

  it('drops an acceptance test that changes names and the patch leaves out, a quoted reason included', () => {
    const plan = { ...base, acceptanceTests: [TEST_A, { ...TEST_A, id: 'b' }] };
    const drop = (entry: string) => applyPlanPatch(plan, planPatchSchema.parse({ revision: 4, changes: [entry] })).acceptanceTests.map((t) => t.id);
    assert.deepEqual([drop('tests.a'), drop('tests.a because the request drops it')], [['b'], ['b']]);
  });

  it('refuses a key it does not know and an item given twice, instead of dropping or picking one', () => {
    const issues = (input: unknown) => (planPatchSchema.safeParse(input).error?.issues ?? []).map((i) => [i.path.join('.'), i.message]);
    assert.deepEqual(issues({ revision: 4, tests: [] }).map(([p]) => p), ['']);
    assert.deepEqual(issues({ revision: 4, workflows: [wf('support', 'ticket'), wf('support', 'ticket')] }), [['workflows', 'workflows gives support more than once: give each item once']]);
  });

  it('takes each acceptance test the world holds from world.tests, and keeps a test the world lacks as planned', () => {
    const world = minimalWorld({ tests: { a: { description: 'D', script: 'S' } } });
    const plan = planFor(world, { acceptanceTests: [TEST_A, { ...TEST_A, id: 'b' }] });
    assert.deepEqual(planWithWorldTests(plan, world).acceptanceTests, [{ ...TEST_A, description: 'D', script: 'S' }, { ...TEST_A, id: 'b' }]);
  });
});

describe('runWorldGen iterate: a plan patch on gen-billing-dunning, whose plan.yaml is stale against its world tests (A-345)', () => {
  const REQUEST_LIFECYCLE = 'Plan-only revision: give workflow default_card a descriptive lifecycle. Change nothing in the world.';
  const billingCopy = (): string => {
    const dir = tmp();
    copyFileSync(join(BILLING, 'world.yaml'), join(dir, 'world.yaml'));
    copyFileSync(join(BILLING, 'plan.yaml'), join(dir, 'plan.yaml'));
    return dir;
  };
  const planIn = (dir: string): Plan => parsePlanYaml(readFileSync(join(dir, 'plan.yaml'), 'utf8'))!;
  const worldIn = async (dir: string): Promise<World> => {
    const loaded = await loadWorld(dir);
    if (!loaded.ok) throw new Error(`${dir} does not load`);
    return worldSchema.parse(loaded.value);
  };

  it('converges on a 1-key lifecycle patch in one plan call: every other key carries over, and plan.yaml\'s tests equal world.tests', async () => {
    const dir = billingCopy();
    const old = planIn(dir);
    const widBefore = worldIdOf(await worldIn(dir));
    const card = old.workflows.find((w) => w.name === 'default_card')!;
    const lifecycle = { representation: 'descriptive' as const, reason: 'no_default and has_default derive from whether the customer has a default payment method' };
    const { result, events, calls } = await iterate(dir, [{ input: { revision: old.revision + 1, changes: [], workflows: [{ ...card, lifecycle }] } }], { request: REQUEST_LIFECYCLE });
    assert.equal(result.kind, 'done');
    assert.equal(calls.length, 1);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted']]);
    const after = planIn(dir);
    const world = await worldIn(dir);
    assert.equal(worldIdOf(world), widBefore);
    const withoutLifecycle = after.workflows.map((w) => {
      if (w.name !== 'default_card') return w;
      const { lifecycle: _declared, ...plain } = w;
      return plain;
    });
    assert.deepEqual(withoutLifecycle, old.workflows);
    assert.deepEqual(after.workflows.find((w) => w.name === 'default_card')?.lifecycle, lifecycle);
    assert.deepEqual(after.acceptanceTests.map((t) => [t.id, { description: t.description, script: t.script }]), after.acceptanceTests.map((t) => [t.id, world.tests[t.id]]));
    assert.deepEqual(after.acceptanceTests.map((t) => [t.id, t.intent, t.actions]), old.acceptanceTests.map((t) => [t.id, t.intent, t.actions]));
    const rest = (p: Plan) => ({ ...p, revision: 0, changes: [], workflows: [], acceptanceTests: [] });
    assert.deepEqual(rest(after), rest(old));
    assert.deepEqual(workflowIssues(after, world), []);
  });

  it('stops input_rejected on an empty patch: the world-synced base, not the stale plan.yaml, decides that nothing changed', async () => {
    const dir = billingCopy();
    const before = snapshot(dir);
    const { result } = await iterate(dir, [{ input: { revision: planIn(dir).revision + 1, changes: [] } }], { request: REQUEST_LIFECYCLE });
    assert.equal(stoppedReason(result)?.kind, 'input_rejected');
    assert.deepEqual(snapshot(dir), before);
  });

  it('refuses a patch that rewords a frozen test without naming tests.<id> in changes, and leaves both files as they were', async () => {
    const dir = billingCopy();
    const before = snapshot(dir);
    const old = planIn(dir);
    const id = 'dunning_retries_at_1_3_7_days_then_cancels';
    const frozen = old.acceptanceTests.find((t) => t.id === id)!;
    const reworded = { revision: old.revision + 1, changes: [], acceptanceTests: [{ ...frozen, description: `${frozen.description} (reworded)` }] };
    const { result, events } = await iterate(dir, [{ input: reworded }, new ModelError('stop here')], { request: REQUEST_LIFECYCLE });
    assert.equal(stoppedReason(result)?.kind, 'model_error');
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'model_error']]);
    const refused = events.flatMap((e) => (e.t === 'attempt' && e.step === 'plan' && e.n === 1 && e.outcome.kind === 'invalid_output' ? e.outcome.issues : []));
    assert.deepEqual(refused.map((i) => i.expected), [`acceptance test ${id} rewrites the existing tests.${id}: copy it unchanged, or name tests.${id} in changes`]);
    assert.deepEqual(snapshot(dir), before);
  });
});

// ------------------------------------------------------------------ an old world the free-text gate rejects (A-395)

const ESCALATE = 'escalate_breached_enterprise_tickets';

/** The golden helpdesk as it was before A-388: its escalation grader never reads the reason, so check fails at tasks. */
function unguardedHelpdeskCopy(): string {
  const dir = helpdeskCopy();
  const text = readFileSync(join(dir, 'world.yaml'), 'utf8')
    .replace('Give each escalation a reason that names the SLA breach.', 'Give each escalation a reason.')
    .replace(/\n *\/\/ The reason must name the SLA breach[^\n]*\n *if \(!events\.some\([^\n]*\n/, '\n');
  writeFileSync(join(dir, 'world.yaml'), text);
  return dir;
}

describe('runWorldGen iterate: an old world whose only failing check issues the tasks stage owns (A-395)', () => {
  const request = `make the ${ESCALATE} grader check the escalation reason`;
  const tasksPlan = (world: World): Plan => planFor(world, { changes: [`tasks.${ESCALATE}.grader`] });

  it('admits it, and ends done once the tasks stage clears the issue', async () => {
    const dir = unguardedHelpdeskCopy();
    const old = (await loadWorld(dir)) as { ok: true; value: World };
    const first = checkWorld(old.value);
    assert.deepEqual(first.ok ? [] : first.issues.map((i) => [i.code, i.path.join('.')]), [['task.freetext_unchecked', `tasks.${ESCALATE}.grader`]]);
    const tolerated = checkWorld(old.value, undefined, { tolerate: new Set(['task.freetext_unchecked']) });
    assert.deepEqual(tolerated.ok ? tolerated.warnings.filter((w) => w.code === 'task.freetext_unchecked').map((w) => w.path.join('.')) : null, [`tasks.${ESCALATE}.grader`]);
    const fixed = (await loadChecked(HELPDESK)).tasks[ESCALATE];
    const { result, events } = await iterate(dir, [
      { input: tasksPlan(old.value) },
      { input: { note: 'the grader reads the reason', upsert: { tasks: { [ESCALATE]: fixed } } } },
    ], { request });
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    const after = checkWorld((await loadChecked(dir)));
    assert.equal(after.ok, true);
  });

  it('stops, and leaves world.yaml unchanged, when the tasks stage does not clear it', async () => {
    const dir = unguardedHelpdeskCopy();
    const before = snapshot(dir);
    const old = (await loadWorld(dir)) as { ok: true; value: World };
    const keep = { input: { note: 'keep the grader' } };
    const { result } = await iterate(dir, [{ input: tasksPlan(old.value) }, keep, keep, keep, keep], { request });
    assert.equal(result.kind, 'stopped');
    assert.equal(result.kind === 'stopped' && 'lastIssues' in result.reason ? result.reason.lastIssues.some((i) => i.code === 'task.freetext_unchecked') : false, true);
    assert.equal(snapshot(dir).world, before.world);
  });

  it('refuses it when the change plan does not rerun the tasks stage', async () => {
    const dir = unguardedHelpdeskCopy();
    const old = (await loadWorld(dir)) as { ok: true; value: World };
    const { result, calls } = await iterate(dir, [{ input: planFor(old.value, { changes: ['tests.escalate_assigns_oncall_agent'] }) }], { request });
    assert.equal(result.kind, 'stopped');
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, {
      kind: 'input_rejected',
      why: `the existing world does not pass the engine, and the change plan does not rerun tasks, which owns task.freetext_unchecked at tasks.${ESCALATE}.grader`,
    });
    assert.equal(calls.length, 1);
  });

  it('still refuses, before any model call, an old world with a failing issue outside the tasks layer', async () => {
    const dir = unguardedHelpdeskCopy();
    const text = readFileSync(join(dir, 'world.yaml'), 'utf8');
    const at = text.indexOf('      (ctx) => {\n', text.indexOf('\ntests:\n'));
    const broken = `${text.slice(0, at)}      (ctx) => {\n        ctx.assert(false, 'broken on purpose');\n${text.slice(at + '      (ctx) => {\n'.length)}`;
    assert.notEqual(broken, text);
    writeFileSync(join(dir, 'world.yaml'), broken);
    const { result, calls } = await iterate(dir, [], { request });
    assert.equal(result.kind, 'stopped');
    assert.equal(result.kind === 'stopped' && result.reason.kind === 'input_rejected' ? result.reason.why.startsWith('the existing world does not pass the engine: test.failed at tests.') : false, true);
    assert.equal(calls.length, 0);
  });
});
