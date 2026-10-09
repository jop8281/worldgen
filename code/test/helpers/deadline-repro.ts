/**
 * Run as a child process by test/worldgen-deadline.test.ts, because a judge stuck in a synchronous
 * check cannot be preempted by a test timeout. Prints one JSON line describing how the run ended.
 * - 'capped' and 'uncapped': a scripted model drives a create run to the tasks stage with about 3 s
 *   of a 600 s run left, then proposes a grader that spins about 0.5 s between ctx.changes()
 *   calls: 200 times, or forever. Tasks is the last step, the only one a call may still reach
 *   with 3 s left once a run reserves the tasks call's own estimate (A-114).
 * - 'iterate-old': an iterate run on a world whose seed spins forever, with a 3 s run. The check
 *   of the existing world, before any model call, must stop at the deadline.
 * - 'iterate-probe': an iterate run on a world whose seed spins 25 times and keeps its rows, so the
 *   existing world passes. The plan call leaves about 3 s of a 240 s run and changes only a task,
 *   so the model stage is probed for a skip, and that probe must stop at the deadline.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { World } from '#engine';
import { configSchema } from '../../src/worldgen/config.ts';
import type { RunEvent } from '../../src/worldgen/events.ts';
import type { Model, ProposeRequest } from '../../src/worldgen/llm.ts';
import { runWorldGen } from '../../src/worldgen/run.ts';
import { ESCALATE_HANDLER, ESCALATE_TEST } from './scripted-world.ts';
import { minimalWorld } from './world.ts';

const CUSTOMERS = `(ctx) => [
  { name: 'Acme', tier: 'enterprise' },
  { name: 'Globex', tier: 'pro' },
  { name: 'Initech', tier: 'pro' },
  { name: 'Umbrella', tier: 'free' },
  { name: 'Hooli', tier: 'free' },
  { name: 'Stark', tier: 'enterprise' },
  { name: 'Wayne', tier: 'enterprise' },
  { name: 'Wonka', tier: 'pro' },
  { name: 'Cyberdyne', tier: 'pro' },
  { name: 'Tyrell', tier: 'free' },
  { name: 'Soylent', tier: 'free' },
  { name: 'Aperture', tier: 'pro' },
  { name: 'Vandelay', tier: 'free' },
  { name: 'Pied Piper', tier: 'pro' },
  { name: 'Massive Dynamic', tier: 'enterprise' },
]`;
const RESOLVE_TEST = `(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Test Co', tier: 'free' });
  ctx.assert(c.status === 201, 'create customer failed');
  const t = ctx.api('POST', '/tickets', { customer: c.body.id, subject: 'Help', priority: 'low' });
  ctx.assert(t.status === 201, 'create ticket failed');
  const p = ctx.api('PATCH', '/tickets/' + t.body.id, { status: 'pending' });
  ctx.assert(p.status === 200, 'move to pending failed');
  const r = ctx.api('POST', '/tickets/' + t.body.id + '/resolve');
  ctx.assert(r.status === 200, 'resolve failed');
}`;
const TARGET: World = minimalWorld({
  routes: { list_customers: { pageSize: 5 }, list_tickets: { pageSize: 4 } },
  actions: { escalate_ticket: { method: 'POST', path: '/tickets/{id}/escalate', description: 'Make an unresolved ticket urgent.', handler: ESCALATE_HANDLER } },
  seed: { customer: CUSTOMERS },
});
const PLAN = {
  open_questions: [{ question: 'Which ticket priorities exist?', default_answer: 'low, normal and high' }],
  software: 'Zendesk-style helpdesk',
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
  summary: 'Customers file tickets, agents resolve pending ones, and overdue tickets escalate.',
  verdict: { kind: 'proceed' },
  entities: [
    { name: 'customer', purpose: 'a company that files tickets', keyFields: ['name', 'tier'] },
    { name: 'ticket', purpose: 'a support request', keyFields: ['status', 'priority'] },
  ],
  workflows: [{ name: 'resolution', entity: 'ticket', states: ['open', 'pending', 'resolved'], rules: ['only a pending ticket can be resolved'], actions: ['resolve_ticket', 'escalate_ticket'] }],
  jobs: [{ name: 'escalate_overdue', every: '15m', rule: 'overdue unresolved tickets become urgent' }],
  routes: [
    { id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'browse tickets' },
    { id: 'get_ticket', method: 'GET', path: '/tickets/{id}', purpose: 'read one ticket' },
    { id: 'list_customers', method: 'GET', path: '/customers', purpose: 'browse customers' },
  ],
  // Required by plans that freeze acceptance tests before the workflow stage; an older plan schema strips it.
  acceptanceTests: [{
    id: 'resolve_pending_ticket',
    intent: 'A pending ticket can be resolved through the public API.',
    actions: ['resolve_ticket'],
    description: 'a pending ticket can be resolved',
    script: RESOLVE_TEST,
  }, {
    id: 'escalate_open_ticket',
    intent: 'An unresolved ticket can be escalated through the public API.',
    actions: ['escalate_ticket'],
    description: 'an unresolved ticket can be escalated',
    script: ESCALATE_TEST,
  }],
  seed: { rowsPerEntity: { customer: 15, ticket: 12 }, mix: 'half the tickets pending', stateMix: { ticket: { open: 33, pending: 50, resolved: 17 } } },
  tasks: [
    { id: 'resolve_password_ticket', difficulty: 'easy', intent: 'resolve one named ticket', decoyIdea: 'resolves the wrong ticket' },
    { id: 'resolve_initech_pending', difficulty: 'medium', intent: 'resolve the pending tickets of one customer', decoyIdea: 'resolves every customer' },
    { id: 'escalate_acme', difficulty: 'hard', kind: 'irreversible', intent: 'escalate and resolve the tickets of a churning customer', actions: ['escalate_ticket', 'resolve_ticket'], decoyIdea: 'forgets to resolve' },
  ],
  assumptions: [
    { decision: 'Tickets move open -> pending -> resolved, and a resolved ticket can reopen.', why: 'The description names no lifecycle.' },
    { decision: 'Overdue unresolved tickets become urgent, checked every 15 minutes.', why: 'SLA escalation needs a schedule.' },
  ],
  outOfScope: [{ what: 'agent assignment', why: 'none of the three tasks needs it' }],
};
const EDITS = {
  model: { note: 'entities and routes from the plan', upsert: { entities: TARGET.entities, routes: TARGET.routes } },
  workflow: { note: 'the resolve action and the escalation job', upsert: { actions: TARGET.actions, jobs: TARGET.jobs } },
};
const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
const seedWith = (source: string) => ({ note: 'customers', upsert: { seed: { ...TARGET.seed, customer: source } } });
const EASY = TARGET.tasks['resolve_password_ticket'];
if (EASY === undefined) throw new Error('minimalWorld lost resolve_password_ticket');
const tasksWith = (grader: string) => ({ note: 'tasks', upsert: { tasks: { ...TARGET.tasks, resolve_password_ticket: { ...EASY, grader } } } });
const spinGrader = (cond: string) => `(ctx) => { let x = 0; for (let k = 0; ${cond}; k++) { for (let i = 0; i < 3e8; i++) x += i; ctx.changes(); } return 0; }`;

/** minimalWorld's five customers, returned after the spin so the world still passes. */
const KEPT_ROWS = `[{ name: 'Acme', tier: 'enterprise' }, { name: 'Globex', tier: 'pro' }, { name: 'Initech', tier: 'pro' }, { name: 'Umbrella', tier: 'free' }, { name: 'Hooli', tier: 'free' }]`;
const keepSeed = (cond: string) => `(ctx) => { let x = 0; for (let k = 0; ${cond}; k++) { for (let i = 0; i < 3e8; i++) x += i; ctx.rng(); } return ${KEPT_ROWS}; }`;

/** A change plan for `world` that only rewords one task, so only the tasks stage is reached. */
function rewordPlan(world: World): unknown {
  return {
    software: 'Zendesk Support tickets API',
    summary: 'Customers file tickets that agents work.',
    clock: world.meta.clock,
    verdict: { kind: 'proceed' },
    entities: [{ name: 'ticket', purpose: 'a support request', keyFields: ['status'] }],
    workflows: [{ name: 'support', entity: 'ticket', states: ['open', 'resolved'], rules: [], actions: [] }],
    jobs: [],
    routes: [],
    seed: { rowsPerEntity: { ticket: 12 }, mix: 'as before' },
    tasks: Object.entries(world.tasks).map(([id, t]) => ({ id, difficulty: t.difficulty, intent: 'as before', decoyIdea: 'as before' })),
    assumptions: [{ decision: 'The easy task names the ticket by subject.', why: 'The request asks for clearer wording.' }],
    outOfScope: [{ what: 'new entities', why: 'the request only rewords a task' }],
    changes: ['tasks.resolve_password_ticket.instruction'],
  };
}

const variant = process.argv[2];
if (variant !== 'capped' && variant !== 'uncapped' && variant !== 'iterate-old' && variant !== 'iterate-probe') {
  throw new Error(`usage: deadline-repro.ts capped|uncapped|iterate-old|iterate-probe, got ${variant}`);
}

let skew = 0;
const now = (): number => Date.now() + skew;
const t0 = Date.now();
const root = mkdtempSync(join(tmpdir(), 'wg-deadline-'));
const outDir = join(root, 'gen-helpdesk');

type Setup = { readonly config: ReturnType<typeof configSchema.parse>; readonly script: readonly unknown[]; readonly skewAt: number; readonly leftMs: number; readonly job: Parameters<typeof runWorldGen>[0] };
function setup(): Setup {
  if (variant === 'capped' || variant === 'uncapped') {
    return {
      // 10 minutes with effort low leaves each first call its measured estimate after the tasks call's estimate is held back (A-114, A-131).
      config: configSchema.parse({ model: 'claude-sonnet-5-5', effort: 'low', maxCostUsd: 5, maxMinutes: 10, steps: { tasks: { maxAttempts: 2 } } }),
      script: [PLAN, EDITS.model, EDITS.workflow, seedWith(CUSTOMERS), tasksWith('not js'), tasksWith(spinGrader(variant === 'capped' ? 'k < 200' : 'true'))],
      // The first tasks call jumps the clock to about 3 s before the 600 s deadline. Its repair is estimated at 250 ms, so it is let through.
      skewAt: 5,
      leftMs: 3_000,
      job: { kind: 'create', input: { kind: 'description', text: 'A helpdesk where overdue tickets escalate' }, outDir },
    };
  }
  // A fixture world written as plain YAML: the spinner cannot be checked first, which saveWorld needs.
  const world = minimalWorld({ seed: { customer: keepSeed(variant === 'iterate-old' ? 'true' : 'k < 25') } });
  writeFileSync(join(root, 'world.yaml'), YAML.stringify(world));
  const job = { kind: 'iterate', worldDir: root, request: 'reword the password reset task' } as const;
  if (variant === 'iterate-old') {
    // 3 s: the existing world's check, before any call, outlives it.
    return { config: configSchema.parse({ model: 'claude-sonnet-5-5', effort: 'low', maxCostUsd: 5, maxMinutes: 0.05 }), script: [], skewAt: 0, leftMs: 0, job };
  }
  // 240 s, so the plan call's 69 s low-effort estimate fits its share after the 25-chunk check of the existing world and the 114 s the later steps keep (A-311).
  return { config: configSchema.parse({ model: 'claude-sonnet-5-5', effort: 'low', maxCostUsd: 5, maxMinutes: 4 }), script: [rewordPlan(world)], skewAt: 1, leftMs: 3_000, job };
}
const { config, script, skewAt, leftMs, job } = setup();

const calls: ProposeRequest[] = [];
const model: Model = {
  propose(req) {
    const entry = script[calls.length];
    calls.push(req);
    if (calls.length === skewAt) skew = t0 + config.maxMinutes * 60_000 - leftMs - Date.now();
    if (entry === undefined) return Promise.reject(new Error(`no reply for call ${calls.length}`));
    return Promise.resolve({ input: entry, advice: [], usage: USAGE, costUsd: 0.125, ms: 1000 });
  },
};

const events: RunEvent[] = [];
const result = await runWorldGen(job, config, { model, exampleWorld: minimalWorld(), emit: (e) => events.push(e), now, runId: 'run_deadline' });
const finished = events.find((e) => e.t === 'run_finished');
const worldDir = result.dir;
const attempts = events.flatMap((e) => (e.t === 'attempt' ? [e] : []));
const lastAttempt = attempts.at(-1);
const reportFile = join(worldDir, 'REPORT.md');
process.stdout.write(`${JSON.stringify({
  reason: result.kind === 'stopped' ? result.reason : null,
  lastEvent: events.at(-1)?.t,
  tail: events.slice(-2).map((e) => (e.t === 'attempt' || e.t === 'step_started' || e.t === 'step_finished' ? `${e.t}:${e.step}` : e.t)),
  ms: finished?.t === 'run_finished' ? finished.ms : null,
  costUsd: finished?.t === 'run_finished' ? finished.costUsd : null,
  calls: calls.length,
  attempts: attempts.map((e) => `${e.step}-${e.n}:${e.outcome.kind}`),
  attemptCostUsd: attempts.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
  lastDump: lastAttempt === undefined ? null : JSON.parse(readFileSync(join(worldDir, lastAttempt.dump), 'utf8')) as unknown,
  report: existsSync(reportFile),
  reportHead: existsSync(reportFile) ? readFileSync(reportFile, 'utf8').split('\n').filter((l) => l.startsWith('Stopped:') || l.startsWith('The run hit')) : [],
  wallMs: Date.now() - t0,
})}\n`);
rmSync(root, { recursive: true, force: true });
