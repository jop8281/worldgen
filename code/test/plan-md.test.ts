/**
 * plan.md (YOS-182): every rendered line comes from a plan field, and runWorldGen writes it
 * beside plan.yaml on both exits that write plan.yaml — right after the plan step accepts on
 * create, and staged with plan.yaml at the end of an accepted iterate, rolled back with it.
 * A stop never touches it. The create control reuses the scripted world (helpers/scripted-world.ts);
 * the iterate controls reuse minimalWorld, as test/worldgen-iterate.test.ts does.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkWorld, saveWorld, type CheckedWorld, type World } from '#engine';
import { configSchema, type Config } from '../src/worldgen/config.ts';
import { ModelError, type Model, type ProposeRequest } from '../src/worldgen/llm.ts';
import { parsePlanYaml, renderPlanYaml, type Plan } from '../src/worldgen/plan.ts';
import { renderPlanMd } from '../src/worldgen/plan-md.ts';
import { partialDir, runWorldGen, type RunFs } from '../src/worldgen/run.ts';
import { EDITS, PLAN, RESOLVE_TEST } from './helpers/scripted-world.ts';
import { minimalWorld } from './helpers/world.ts';

/** The acceptance test's script, verbatim in the plan and in the rendered fence. */
const SCRIPT = `(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Literal Co', tier: 'free' });
  ctx.assert(c.status === 201, 'create customer failed');
  const t = ctx.api('POST', '/tickets', { customer: c.body.id, subject: 'Help', priority: 'low' });
  ctx.assert(t.status === 201, 'create ticket failed');
  const p = ctx.api('PATCH', '/tickets/' + t.body.id, { status: 'pending' });
  ctx.assert(p.status === 200, 'move to pending failed');
  const r = ctx.api('POST', '/tickets/' + t.body.id + '/resolve');
  ctx.assert(r.status === 200, 'resolve failed');
}`;

/** A small literal plan holding every field, both rule forms, a state mix and declared pressure. */
const LITERAL: Plan = {
  revision: 2,
  software: 'Zendesk-style helpdesk',
  summary: 'Customers file tickets, agents resolve pending ones, and overdue tickets escalate.',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'customer', purpose: 'a company that files tickets', keyFields: ['name', 'tier'] },
    { name: 'ticket', purpose: 'a support request', keyFields: ['status', 'priority'] },
  ],
  workflows: [{
    name: 'resolution',
    entity: 'ticket',
    states: ['open', 'pending', 'resolved'],
    rules: [
      { rule: 'Only a pending ticket can be resolved.', by: ['resolve_ticket'], test: 'resolve_pending_ticket' },
      'A ticket is created open.',
    ],
    actions: ['resolve_ticket'],
  }],
  jobs: [{ name: 'escalate_overdue', every: '15m', rule: 'overdue unresolved tickets become urgent' }],
  acceptanceTests: [{
    id: 'resolve_pending_ticket',
    intent: 'A pending ticket can be resolved through the public API.',
    actions: ['resolve_ticket'],
    description: 'a pending ticket can be resolved',
    script: SCRIPT,
  }],
  routes: [
    { id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse tickets' },
    { id: 'get_ticket', method: 'GET', path: '/tickets/{id}', purpose: 'read one ticket' },
  ],
  seed: { rowsPerEntity: { customer: 15, ticket: 12 }, mix: 'half the tickets pending', stateMix: { ticket: { open: 33, pending: 50, resolved: 17 } } },
  tasks: [
    { id: 'resolve_password_ticket', difficulty: 'easy', intent: 'resolve one named ticket', decoyIdea: 'resolves the wrong ticket' },
    { id: 'resolve_initech_pending', difficulty: 'medium', intent: 'resolve the pending tickets of one customer', decoyIdea: 'resolves every customer' },
    {
      id: 'escalate_acme',
      difficulty: 'hard',
      intent: 'escalate and resolve the tickets of a churning customer',
      decoyIdea: 'forgets to resolve',
      pressure: { paging: 'ticket', states: ['ticket.pending'], distractors: 'customer' },
    },
  ],
  open_questions: [{ question: 'Which ticket priorities exist?', default_answer: 'low, normal and high' }],
  assumptions: [
    { decision: 'Tickets move open -> pending -> resolved, and a resolved ticket can reopen.', why: 'The description names no lifecycle, so the plan takes the smallest Zendesk-like one.' },
  ],
  outOfScope: [{ what: 'agent assignment', why: 'none of the three tasks needs it' }],
  changes: ['tasks.escalate_acme.instruction'],
};

/** A refusal: no workflow, no task, and every empty section renders as none. */
const REFUSAL: Plan = {
  revision: 1,
  software: 'Payments API replica',
  summary: 'The request is refused.',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  verdict: { kind: 'refuse', why: 'refunds would move real money', feasibleIf: 'a refund record that moves no money' },
  entities: [],
  workflows: [],
  jobs: [],
  acceptanceTests: [],
  routes: [],
  seed: { rowsPerEntity: {}, mix: 'no rows are seeded' },
  tasks: [],
  assumptions: [],
  outOfScope: [],
  changes: [],
};

describe('renderPlanMd: every line from a plan field', () => {
  it('renders the whole plan as literal markdown, in plan.yaml key order', () => {
    assert.deepEqual(renderPlanMd(LITERAL).split('\n'), [
      '# WorldGen plan: Zendesk-style helpdesk',
      '',
      'Customers file tickets, agents resolve pending ones, and overdue tickets escalate.',
      '',
      '- Revision: 2',
      '- Verdict: proceed',
      '- Clock: starts 2026-01-05T09:00:00.000Z, tick 0s',
      '',
      '## Entities',
      '',
      '| Entity | Purpose | Key fields |',
      '|---|---|---|',
      '| `customer` | a company that files tickets | name, tier |',
      '| `ticket` | a support request | status, priority |',
      '',
      '## Workflows',
      '',
      '### resolution (ticket)',
      '- States: open, pending, resolved',
      '- Actions: resolve_ticket',
      '- Rules:',
      '  - Only a pending ticket can be resolved. Enforced by: resolve_ticket. Tested by: resolve_pending_ticket',
      '  - A ticket is created open.',
      '',
      '## Jobs',
      '',
      '- `escalate_overdue` runs every 15m: overdue unresolved tickets become urgent',
      '',
      '## Acceptance tests',
      '',
      '### resolve_pending_ticket',
      '- Intent: A pending ticket can be resolved through the public API.',
      '- Actions: resolve_ticket',
      '- Description: a pending ticket can be resolved',
      '',
      '```js',
      ...SCRIPT.split('\n'),
      '```',
      '',
      '## Routes',
      '',
      '| Route | Method | Path | Purpose |',
      '|---|---|---|---|',
      '| `list_tickets` | GET | /tickets | browse tickets |',
      '| `get_ticket` | GET | /tickets/{id} | read one ticket |',
      '',
      '## Seed',
      '',
      '- Rows per entity: customer: 15, ticket: 12',
      '- Mix: half the tickets pending',
      '- State mix: ticket: open 33%, pending 50%, resolved 17%',
      '',
      '## Tasks',
      '',
      '- `resolve_password_ticket` (easy): resolve one named ticket',
      '  - Decoy idea: resolves the wrong ticket',
      '- `resolve_initech_pending` (medium): resolve the pending tickets of one customer',
      '  - Decoy idea: resolves every customer',
      '- `escalate_acme` (hard): escalate and resolve the tickets of a churning customer',
      '  - Decoy idea: forgets to resolve',
      '  - Pressure: paging past the first page of ticket; seeded rows in ticket.pending; distractor rows of customer',
      '',
      '## Open questions',
      '',
      '- Which ticket priorities exist?',
      '  - Default answer: low, normal and high',
      '',
      '## Assumptions',
      '',
      '- Tickets move open -> pending -> resolved, and a resolved ticket can reopen.',
      '  - Why: The description names no lifecycle, so the plan takes the smallest Zendesk-like one.',
      '',
      '## Out of scope',
      '',
      '- agent assignment',
      '  - Why: none of the three tasks needs it',
      '',
      '## Changes',
      '',
      '- tasks.escalate_acme.instruction',
      '',
    ]);
  });

  it('renders a refusal with its reason and what a feasible request would ask for', () => {
    assert.deepEqual(renderPlanMd(REFUSAL).split('\n'), [
      '# WorldGen plan: Payments API replica',
      '',
      'The request is refused.',
      '',
      '- Revision: 1',
      '- Verdict: refuse — refunds would move real money',
      '- Feasible if: a refund record that moves no money',
      '- Clock: starts 2026-01-05T09:00:00.000Z, tick 0s',
      '',
      '## Entities',
      '',
      'None. The plan names no entity.',
      '',
      '## Workflows',
      '',
      'None. The plan declares no workflow.',
      '',
      '## Jobs',
      '',
      'None. The plan declares no job.',
      '',
      '## Acceptance tests',
      '',
      'None. The plan records no acceptance test.',
      '',
      '## Routes',
      '',
      'None. The plan declares no route.',
      '',
      '## Seed',
      '',
      '- Rows per entity: none',
      '- Mix: no rows are seeded',
      '',
      '## Tasks',
      '',
      'None. The plan records no task.',
      '',
      '## Open questions',
      '',
      'None. The plan asks no open question.',
      '',
      '## Assumptions',
      '',
      'None. The plan records no assumption.',
      '',
      '## Out of scope',
      '',
      'None. The plan leaves nothing out.',
      '',
      '## Changes',
      '',
      'None. The plan changes no existing item.',
      '',
    ]);
  });

  it('round-trips: the plan parses back from its own plan.yaml and renders the same plan.md', () => {
    for (const plan of [LITERAL, REFUSAL]) {
      const parsed = parsePlanYaml(renderPlanYaml(plan));
      assert.ok(parsed !== null, 'renderPlanYaml output parses back as a Plan');
      assert.deepEqual(parsed, plan);
      assert.equal(renderPlanMd(parsed), renderPlanMd(plan));
    }
  });
});

// ------------------------------------------------------------------ scripted-model controls

type Reply = { readonly input: unknown } | ModelError;
type Script = readonly (Reply | ((req: ProposeRequest) => Reply))[];

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
const CONFIG: Config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

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

function checkedOf(world: World): CheckedWorld {
  const r = checkWorld(world);
  if (!r.ok) throw new Error(`fixture rejected: ${JSON.stringify(r.issues.map((i) => [i.code, i.path, i.found]))}`);
  return r.world;
}

/** A change plan for minimalWorld at `revision`: its tasks kept, one task's instruction reworded. */
const changePlan = (world: World, revision: number): Plan => ({
  revision,
  software: 'Zendesk-style helpdesk',
  summary: 'Customers file tickets, agents resolve pending ones, and overdue tickets escalate.',
  clock: world.meta.clock,
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'customer', purpose: 'a company that files tickets', keyFields: ['name', 'tier'] },
    { name: 'ticket', purpose: 'a support request', keyFields: ['status', 'priority'] },
  ],
  workflows: [{
    name: 'resolution',
    entity: 'ticket',
    states: ['open', 'pending', 'resolved'],
    // This plan adds no acceptance test, so its rule stays text: a { rule, by, test } must bind a planned test id (#469).
    rules: ['Only a pending ticket can be resolved.'],
    actions: ['resolve_ticket'],
  }],
  jobs: [],
  acceptanceTests: [],
  routes: [],
  seed: { rowsPerEntity: { customer: 5, ticket: 12 }, mix: 'as before' },
  tasks: [
    { id: 'resolve_password_ticket', difficulty: 'easy', intent: 'resolve one named ticket', decoyIdea: 'resolves the wrong ticket' },
    { id: 'resolve_initech_pending', difficulty: 'medium', intent: 'resolve the pending tickets of one customer', decoyIdea: 'resolves every customer' },
    { id: 'escalate_acme', difficulty: 'hard', intent: 'escalate and resolve the tickets of a churning customer', decoyIdea: 'forgets to resolve' },
  ],
  assumptions: [
    { decision: 'Tickets move open -> pending -> resolved, and a resolved ticket can reopen.', why: 'The description names no lifecycle, so the plan takes the smallest Zendesk-like one.' },
  ],
  outOfScope: [{ what: 'agent assignment', why: 'none of the three tasks needs it' }],
  changes: ['tasks.resolve_password_ticket.instruction'],
});

/** A scratch directory holding minimalWorld as saved by the engine, with that world's change plan at `revision` beside it. */
async function minimalDir(revision: number): Promise<{ dir: string; world: World; plan: Plan }> {
  const world = minimalWorld();
  const plan = changePlan(world, revision);
  const dir = mkdtempSync(join(tmpdir(), 'wg-plan-md-'));
  await saveWorld(dir, checkedOf(world));
  writeFileSync(join(dir, 'plan.yaml'), renderPlanYaml(plan));
  writeFileSync(join(dir, 'plan.md'), renderPlanMd(plan));
  return { dir, world, plan };
}

describe('runWorldGen writes plan.md beside plan.yaml (YOS-182)', () => {
  it('on create: written with plan.yaml when the plan step accepts, before any stage runs', async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), 'wg-plan-md-')), 'gen-helpdesk');
    let mdBeforeStages = false;
    const script: Script = [
      { input: PLAN },
      () => {
        mdBeforeStages = existsSync(join(partialDir(outDir), 'plan.md'));
        return { input: EDITS.model };
      },
      { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ];
    const model = fakeModel(script);
    let t = T0;
    const result = await runWorldGen(
      { kind: 'create', input: { kind: 'description', text: 'A helpdesk where overdue tickets escalate' }, outDir },
      CONFIG,
      { model, exampleWorld: minimalWorld(), now: () => (t += 1000), runId: 'run_test' },
    );
    assert.equal(result.kind, 'done');
    assert.equal(mdBeforeStages, true);
    const plan = parsePlanYaml(readFileSync(join(outDir, 'plan.yaml'), 'utf8'));
    assert.ok(plan !== null, 'the written plan.yaml parses');
    const md = readFileSync(join(outDir, 'plan.md'), 'utf8');
    assert.equal(md, renderPlanMd(plan));
    assert.ok(md.startsWith('# WorldGen plan: Zendesk-style helpdesk\n'));
    assert.ok(md.includes('- Revision: 1\n'));
    assert.ok(md.includes('- Verdict: proceed\n'));
    assert.ok(md.includes('- Clock: starts 2026-01-05T09:00:00.000Z, tick 0s\n'));
    assert.ok(md.includes('### resolution (ticket)\n'));
    assert.ok(md.includes('- States: open, pending, resolved\n'));
    assert.ok(md.includes('  - only a pending ticket can be resolved\n'));
    assert.ok(md.includes('- `escalate_overdue` runs every 15m: overdue unresolved tickets become urgent\n'));
    assert.ok(md.includes('```js\n' + RESOLVE_TEST + '\n```\n'));
    assert.ok(md.includes('- Rows per entity: customer: 15, ticket: 12\n'));
    assert.ok(md.includes('- State mix: ticket: open 33%, pending 50%, resolved 17%\n'));
    assert.ok(md.includes('- `escalate_acme` (hard): escalate and resolve the tickets of a churning customer\n'));
    assert.ok(md.includes('## Changes\n\nNone. The plan changes no existing item.\n'));
  });

  it('on iterate: staged beside plan.yaml, renamed only once the whole run is accepted', async () => {
    const { dir, world } = await minimalDir(1);
    const plan2 = changePlan(world, 2);
    const model = fakeModel([{ input: plan2 }, { input: { note: 'the wording is kept' } }]);
    let t = T0;
    const result = await runWorldGen(
      { kind: 'iterate', worldDir: dir, request: 'reword the password reset task' },
      CONFIG,
      { model, exampleWorld: minimalWorld(), now: () => (t += 1000), runId: 'run_iter' },
    );
    assert.equal(result.kind, 'done');
    assert.equal(readFileSync(join(dir, 'plan.yaml'), 'utf8'), renderPlanYaml(plan2));
    const md = readFileSync(join(dir, 'plan.md'), 'utf8');
    assert.equal(md, renderPlanMd(plan2));
    assert.ok(md.includes('- Revision: 2\n'));
    assert.ok(md.includes('- States: open, pending, resolved\n'));
    assert.ok(md.includes('## Changes\n\n- tasks.resolve_password_ticket.instruction\n'));
    assert.equal(existsSync(join(dir, 'plan.yaml.tmp')), false);
    assert.equal(existsSync(join(dir, 'plan.md.tmp')), false);
  });

  it('on iterate: a failed final write rolls plan.md back with plan.yaml, byte for byte', async () => {
    const { dir, world } = await minimalDir(1);
    const before = {
      world: readFileSync(join(dir, 'world.yaml'), 'utf8'),
      plan: readFileSync(join(dir, 'plan.yaml'), 'utf8'),
      md: readFileSync(join(dir, 'plan.md'), 'utf8'),
    };
    let injected = false;
    const fs: RunFs = {
      ...fsPromises,
      writeFile: async (...args: Parameters<typeof fsPromises.writeFile>) => {
        if (!injected && String(args[0]) === join(dir, 'REPORT.md')) {
          injected = true;
          throw new Error('injected final persistence failure');
        }
        return fsPromises.writeFile(...args);
      },
    };
    let t = T0;
    const model = fakeModel([{ input: changePlan(world, 2) }, { input: { note: 'the wording is kept' } }]);
    await assert.rejects(
      runWorldGen(
        { kind: 'iterate', worldDir: dir, request: 'reword the password reset task' },
        CONFIG,
        { model, exampleWorld: minimalWorld(), now: () => (t += 1000), runId: 'run_iter', fs },
      ),
      /injected final persistence failure/,
    );
    assert.equal(injected, true);
    assert.equal(readFileSync(join(dir, 'world.yaml'), 'utf8'), before.world);
    assert.equal(readFileSync(join(dir, 'plan.yaml'), 'utf8'), before.plan);
    assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), before.md);
    assert.equal(existsSync(join(dir, 'plan.yaml.tmp')), false);
    assert.equal(existsSync(join(dir, 'plan.md.tmp')), false);
  });

  it('on a stop: plan.md stays untouched, like plan.yaml', async () => {
    const { dir } = await minimalDir(1);
    const before = {
      plan: readFileSync(join(dir, 'plan.yaml'), 'utf8'),
      md: readFileSync(join(dir, 'plan.md'), 'utf8'),
    };
    const model = fakeModel([new ModelError('stop here')]);
    let t = T0;
    const result = await runWorldGen(
      { kind: 'iterate', worldDir: dir, request: 'reword the password reset task' },
      CONFIG,
      { model, exampleWorld: minimalWorld(), now: () => (t += 1000), runId: 'run_iter' },
    );
    assert.equal(result.kind, 'stopped');
    assert.equal(result.kind === 'stopped' ? result.reason.kind : null, 'model_error');
    assert.equal(readFileSync(join(dir, 'plan.yaml'), 'utf8'), before.plan);
    assert.equal(readFileSync(join(dir, 'plan.md'), 'utf8'), before.md);
    assert.equal(existsSync(join(dir, 'plan.yaml.tmp')), false);
    assert.equal(existsSync(join(dir, 'plan.md.tmp')), false);
  });
});
