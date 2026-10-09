/**
 * runWorldGen in create mode, driven by a scripted fake Model. bun run test never calls a real model.
 * Each script entry is one model call, in order: a reply (tool input), a ModelError to throw, or a
 * function of the request. The target world, plan and stage edits are in test/helpers/scripted-world.ts,
 * shared with the CLI end-to-end test.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { checkWorld, editJsonSchema, emptyWorld, formatReference, issue, loadWorld, renderWorldYaml, routeKey, worldIdOf, worldSchema, type CheckIssue, type CheckReport, type World } from '#engine';
import { CostUnenforceableError, openLedger, SpendCapError } from '../src/costs/ledger.ts';
import { CAPSULE_FILE, capsuleSchema } from '../src/worldgen/capsule.ts';
import { meteredModel } from '../src/costs/meter.ts';
import { configSchema, type Config } from '../src/worldgen/config.ts';
import { parseEventLog } from '../src/worldgen/eval.ts';
import { describeStop, type RunEvent, type StopReason } from '../src/worldgen/events.ts';
import type { Input, InputDigest } from '../src/worldgen/input.ts';
import { claudeCliModel, CallStalled, ModelError, StepShareExpired, type Model, type ProposeRequest } from '../src/worldgen/llm.ts';
import { planCoverage, planSchemaFor } from '../src/worldgen/plan.ts';
import { renderReport } from '../src/worldgen/report.ts';
import { partialDir, pickExample, runWorldGen, scopeIssues, stagePrompt, stepBrief, systemPrompt, testOperations, type RunResult } from '../src/worldgen/run.ts';
import { PLAN_BRIEF, STAGES } from '../src/worldgen/stages.ts';
import { CUSTOMERS, EDITS, ESCALATE_TEST, PLAN, RESOLVE_TEST, TARGET } from './helpers/scripted-world.ts';
import { minimalWorld } from './helpers/world.ts';

const REVISED_PLAN = {
  ...PLAN,
  revision: 2,
  acceptanceTests: [{
    ...PLAN.acceptanceTests[0]!,
    intent: 'A pending ticket can be resolved and read back as resolved.',
    description: 'a pending ticket can be resolved and reads back as resolved',
    script: RESOLVE_TEST.replace(
      "  ctx.assert(r.status === 200, 'resolve failed');\n}",
      "  ctx.assert(r.status === 200, 'resolve failed');\n  const final = ctx.api('GET', '/tickets/' + t.body.id);\n  ctx.assert(final.body.status === 'resolved', 'ticket not resolved');\n}",
    ),
  }, PLAN.acceptanceTests[1]!],
};
const REAPPROVED_PLAN = { ...PLAN, revision: 2 };

const routesWith = (name: string, over: Record<string, unknown>) => ({ ...TARGET.routes, [name]: { ...TARGET.routes[name], ...over } });
/** Rejected by the references layer: ref.unknown at routes.get_ticket.entity. */
const BAD_ENTITY = { note: 'entities and routes', upsert: { entities: TARGET.entities, routes: routesWith('get_ticket', { entity: 'tikket' }) } };
/** Rejected by the references layer: ref.unknown at routes.list_tickets.filters.0. */
const BAD_FILTER = { note: 'entities and routes', upsert: { entities: TARGET.entities, routes: routesWith('list_tickets', { filters: ['nope'] }) } };

type Reply = { readonly input: unknown; readonly advice?: readonly string[] } | ModelError | StepShareExpired | CallStalled;
type Script = readonly (Reply | ((req: ProposeRequest) => Reply))[];

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
/** What a killed claude -p call streamed when it had sent nothing. */
const SILENT = { messages: 0, schemaRetries: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputBytes: 0 };

for (const deadline of ['share', 'run'] as const) {
for (const outcome of ['reply', 'billed', 'not_started', 'unknown', 'partial'] as const) {
  it(`integrated ${deadline} cancellation keeps ${outcome} billing through meter, run and capsule`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-finality-'));
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const completed = fakeModel(HAPPY);
    let aborted = false;
    const raw: Model = { propose(req) {
      calls += 1;
      if (deadline === 'run' && calls <= 4) return completed.propose(req);
      if (outcome === 'partial') {
        const cli = claudeCliModel(config, async (_bin, _args, _stdin, options) => {
          await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); entered(); });
          return { code: 143, signal: 'SIGTERM', killed: 'aborted', stderr: '', stdout: [
            { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 100 } } } },
            { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } },
          ].map((frame) => JSON.stringify(frame)).join('\n') };
        });
        return cli.propose(req);
      }
      entered();
      return new Promise((resolve, reject) => {
        assert.ok(req.signal);
        req.signal.addEventListener('abort', () => {
          aborted = true;
          switch (outcome) {
            case 'reply': resolve({ input: {}, advice: [], usage: USAGE, costUsd: 0.25, ms: 389000 }); break;
            case 'billed': reject(new ModelError('terminal receipt', undefined, { usage: USAGE, costUsd: 0.25, ms: 389000 })); break;
            case 'not_started': reject(new ModelError('not started', undefined, { kind: 'not_started' })); break;
            case 'unknown': reject(new ModelError('no final receipt', undefined, { kind: 'unknown' })); break;
          }
        }, { once: true });
      });
    } };
    const ledger = openLedger(join(dir, 'costs.jsonl'));
    const model = meteredModel(raw, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
    let clock = Date.UTC(2026, 9, 7);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const running = runWorldGen({ kind: 'create', input: { kind: 'description', text: 'Offline cancellation fixture' }, outDir: dir }, config,
        { model, exampleWorld: minimalWorld(), now: () => (clock += 1000), runId: 'finality' });
      await inFlight;
      mock.timers.tick(deadline === 'run' ? 900000 : 568500);
      const result = await running;
      assert.equal(aborted, true);
      assert.equal(calls, deadline === 'run' ? 5 : 1);
      assert.equal(result.kind === 'stopped' ? result.reason.kind : null, deadline === 'run' ? 'time_exhausted' : 'stage_time_exhausted');
      const attemptCost = outcome === 'reply' || outcome === 'billed' ? 0.25 : 0;
      const expected = (deadline === 'run' ? 0.5 : 0) + attemptCost;
      assert.equal(result.costUsd, expected);
      assert.equal(ledger.totals().usd, expected);
      // A-164: the claim closes even with unknown billing; caps count it at its admitted bound.
      assert.equal(ledger.read().reservations.length, 0);
      const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(result.dir, CAPSULE_FILE), 'utf8')));
      assert.equal(capsule.costUsd, expected);
      if (deadline === 'share') assert.equal(capsule.attempts[0]?.costUsd, (outcome === 'unknown' || outcome === 'partial') ? null : attemptCost);
      assert.equal(capsule.unknownCostCalls, (outcome === 'unknown' || outcome === 'partial') ? 1 : undefined);
      const logged = parseEventLog(readFileSync(join(result.dir, 'runs', 'finality', 'events.jsonl'), 'utf8'));
      assert.deepEqual(logged.problems, []);
      if (deadline === 'run') {
        const cancelled = logged.events.find((event) => event.t === 'call_cancelled');
        assert.equal(cancelled?.t === 'call_cancelled' ? cancelled.costUsd : undefined, (outcome === 'unknown' || outcome === 'partial') ? null : attemptCost);
      }
      if (outcome === 'partial') {
        const expectedPartial = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, observedCostUsd: 0.0004, costBasis: 'cli_configured_rates' };
        const evidence = deadline === 'share' ? capsule.attempts[0] : capsule.cancelledCalls?.[0];
        assert.deepEqual(evidence?.partialModelUsage, expectedPartial);
        const event = logged.events.find((event) => event.t === (deadline === 'share' ? 'attempt' : 'call_cancelled'));
        assert.deepEqual(event?.t === 'attempt' || event?.t === 'call_cancelled' ? event.partialModelUsage : undefined, expectedPartial);
        const recorded = ledger.read().events.findLast((event) => event.kind === 'model_call');
        assert.deepEqual(recorded?.partialModelUsage, expectedPartial);
        assert.equal(recorded?.usd, null);
        assert.ok(readFileSync(join(result.dir, 'REPORT.md'), 'utf8').includes('20+ output tokens'));
      }
      if (outcome === 'unknown' || outcome === 'partial') {
        assert.ok(readFileSync(join(result.dir, 'REPORT.md'), 'utf8').includes('Cost remains unknown for 1 model call; the total excludes that billing.'));
      }
    } finally {
      mock.timers.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
}

it('finality probe: share interruption retains unknown run billing', async () => {
  const { result, events, calls, filesDir } = await run([new StepShareExpired(1000, 1001)]);
  assert.equal(result.kind, 'stopped');
  assert.equal(calls.length, 1);
  assert.equal(result.kind === 'stopped' ? result.unknownCostCalls : undefined, 1);
  const finished = events.find((event) => event.t === 'run_finished');
  assert.equal(finished?.t === 'run_finished' ? finished.unknownCostCalls : undefined, 1);
  const attempt = events.find((event) => event.t === 'attempt');
  assert.equal(attempt?.t === 'attempt' ? attempt.costUsd : undefined, null);
  assert.deepEqual(parseEventLog(events.map((event) => JSON.stringify(event)).join('\n')).problems, []);
  const written = readFileSync(join(filesDir, 'REPORT.md'), 'utf8');
  assert.ok(written.includes('| plan | 1 | 0.02 | 0.0000 + unknown |'));
  assert.ok(written.includes('Cost remains unknown for 1 model call; the total excludes that billing.'));
});

it('finality probe: unknown model failure does not retry paid work', async () => {
  const { result, calls } = await run([new ModelError('interrupted without final receipt', undefined, { kind: 'unknown' }), ...HAPPY]);
  assert.equal(result.kind, 'stopped');
  assert.equal(calls.length, 1);
  assert.equal(result.kind === 'stopped' ? result.unknownCostCalls : undefined, 1);
});

for (const billing of ['billed', 'not_started'] as const) {
  it(`finality probe: ordinary ${billing} failure remains priced`, async () => {
    const error = billing === 'billed'
      ? new ModelError('terminal receipt', undefined, { usage: USAGE, costUsd: 0.25, ms: 10 })
      : new ModelError('not started', undefined, { kind: 'not_started' });
    const { result, events } = await run([error]);
    assert.equal(result.costUsd, billing === 'billed' ? 0.25 : 0);
    assert.equal(result.kind === 'stopped' ? result.unknownCostCalls : undefined, undefined);
    const attempt = events.find((event) => event.t === 'attempt');
    assert.equal(attempt?.t === 'attempt' ? attempt.costUsd : undefined, billing === 'billed' ? 0.25 : 0);
  });
}


it('finality composition probe: unresolved stall prevents another call', async () => {
 const { result, calls, filesDir } = await run([new CallStalled(120000, 120001), ...HAPPY]);
 assert.equal(calls.length, 1);
 assert.equal(result.kind, 'stopped');
 assert.equal(result.kind === 'stopped' ? result.unknownCostCalls : undefined, 1);
 const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(filesDir, CAPSULE_FILE), 'utf8')));
 assert.equal(capsule.unknownCostCalls, 1);
 assert.equal(capsule.attempts[0]?.costUsd, null);
});


/** Each call costs $0.125 and takes 1000 ms, so totals are exact binary fractions. */
function fakeModel(script: Script): Model & { readonly calls: ProposeRequest[] } {
  const calls: ProposeRequest[] = [];
  return {
    calls,
    async propose(req) {
      const entry = script[calls.length];
      calls.push(req);
      if (entry === undefined) throw new Error(`fake model script has no reply for call ${calls.length}`);
      const reply = typeof entry === 'function' ? entry(req) : entry;
      if (reply instanceof ModelError || reply instanceof StepShareExpired || reply instanceof CallStalled) throw reply;
      return { input: reply.input, advice: reply.advice ?? [], usage: USAGE, costUsd: 0.125, ms: 1000 };
    },
  };
}

const HAPPY: Script = [{ input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }];
const CONFIG: Config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 });
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

const newOutDir = (): string => join(mkdtempSync(join(tmpdir(), 'wg-run-')), 'gen-helpdesk');

/** `outDir` is the destination; `filesDir` holds the run's files: `<out>` when done, `<out>.partial` on a stop (A-293). */
type Ran = { result: RunResult; events: RunEvent[]; calls: ProposeRequest[]; outDir: string; filesDir: string };
async function run(script: Script, opts: { config?: Config; outDir?: string; input?: Input; exampleWorld?: World | readonly World[]; digest?: InputDigest; digestThrows?: Error; check?: (world: World) => CheckReport; callAdvanceMs?: readonly number[]; signal?: AbortSignal; abortOnCall?: { n: number; controller: AbortController } } = {}): Promise<Ran> {
  const outDir = opts.outDir ?? newOutDir();
  const fake = fakeModel(script);
  const model: typeof fake = { calls: fake.calls, propose: (req) => {
    t += opts.callAdvanceMs?.[fake.calls.length] ?? 0;
    if (opts.abortOnCall !== undefined && fake.calls.length + 1 === opts.abortOnCall.n) opts.abortOnCall.controller.abort();
    return fake.propose(req);
  } };
  const events: RunEvent[] = [];
  let t = T0;
  const digest = opts.digest;
  const result = await runWorldGen(
    { kind: 'create', input: opts.input ?? { kind: 'description', text: 'A helpdesk where overdue tickets escalate' }, outDir },
    opts.config ?? CONFIG,
    {
      model,
      exampleWorld: opts.exampleWorld ?? minimalWorld(),
      emit: (e) => events.push(e),
      now: () => (t += 1000),
      runId: 'run_test',
      ...(digest === undefined ? {} : { digest: async () => ({ ok: true as const, digest }) }),
      ...(opts.check === undefined ? {} : { check: opts.check }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      ...(opts.abortOnCall === undefined ? {} : { signal: opts.abortOnCall.controller.signal }),
      ...(opts.digestThrows === undefined ? {} : { digest: async () => { throw opts.digestThrows; } }),
    },
  );
  return { result, events, calls: model.calls, outDir, filesDir: result.dir };
}

const kinds = (events: readonly RunEvent[]) => events.map((e) => e.t);

describe('pickExample (A-390)', () => {
  it('takes the entry the first eight hex digits of the digest pick, modulo the list length', () => {
    const rows: [string, string][] = [
      ['00000000aa', 'a'], ['00000001aa', 'b'], ['00000002aa', 'c'], ['00000003aa', 'a'], ['ffffffffaa', 'a'], ['0000000a', 'b'], ['', 'a'], ['zz', 'a'],
    ];
    for (const [digest, want] of rows) assert.equal(pickExample(['a', 'b', 'c'], digest), want, digest);
    assert.equal(pickExample(['only'], 'ffffffff'), 'only');
    assert.throws(() => pickExample([], '00000000'), /no example world/);
  });
});

describe('runWorldGen picks its few-shot world from the config list by the input digest (A-390)', () => {
  const marked = (mark: string): World => minimalWorld({ actions: { resolve_ticket: { description: `Resolve a pending ticket. ${mark}` } } });
  const EXAMPLES = [marked('EXAMPLE-A'), marked('EXAMPLE-B'), marked('EXAMPLE-C')];
  const shown = (calls: readonly ProposeRequest[]) => ['EXAMPLE-A', 'EXAMPLE-B', 'EXAMPLE-C'].filter((m) => calls[0]?.system.includes(m));

  it('renders the same example for the same input and spreads other inputs over the list', async () => {
    const helpdesk = { kind: 'description', text: 'A helpdesk where overdue tickets escalate' } as const;
    const first = await run([{ input: PLAN }, new ModelError('stop after the plan')], { input: helpdesk, exampleWorld: EXAMPLES });
    const again = await run([{ input: PLAN }, new ModelError('stop after the plan')], { input: helpdesk, exampleWorld: EXAMPLES });
    const other = await run([{ input: PLAN }, new ModelError('stop after the plan')], { input: { kind: 'description', text: 'A bakery that takes cake orders' }, exampleWorld: EXAMPLES });
    assert.deepEqual([shown(first.calls), shown(again.calls), shown(other.calls)], [['EXAMPLE-C'], ['EXAMPLE-C'], ['EXAMPLE-B']]);
  });

  it('renders a single world as before', async () => {
    const one = await run([{ input: PLAN }, new ModelError('stop after the plan')], { exampleWorld: marked('EXAMPLE-A') });
    assert.deepEqual(shown(one.calls), ['EXAMPLE-A']);
  });
});
const attempts = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.t === 'attempt' ? [[e.step, e.n, e.outcome.kind] as const] : []));
const brief = (issues: readonly CheckIssue[]) => issues.map((i) => [i.code, i.path] as const);

const HAPPY_EVENTS = [
  'run_started',
  'step_started', 'attempt', 'step_finished',
  'step_started', 'attempt', 'step_finished',
  'step_started', 'attempt', 'step_finished',
  'step_started', 'attempt', 'step_finished',
  'step_started', 'attempt', 'step_finished',
  'fidelity',
  'run_finished',
];

describe('the scripted target world', () => {
  it('passes the engine, so the scripts below fail only where they mean to', () => {
    const r = checkWorld(TARGET);
    assert.equal(r.ok, true);
  });
});

describe('runWorldGen create: success on the first try', () => {
  it('runs plan, model, workflow, seed and tasks once each and saves the world', async () => {
    const { result, events, calls, outDir } = await run(HAPPY);
    assert.equal(result.kind, 'done');
    assert.equal(result.dir, outDir);
    assert.equal(result.costUsd, 0.625);
    assert.deepEqual(kinds(events), HAPPY_EVENTS);
    assert.deepEqual(
      events.flatMap((e) => (e.t === 'step_started' ? [[e.step, e.reason]] : [])),
      [['plan', 'planned'], ['model', 'planned'], ['workflow', 'planned'], ['seed', 'planned'], ['tasks', 'planned']],
    );
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    assert.deepEqual(calls.map((c) => c.tool.name), ['submit_plan', 'edit_world', 'edit_world', 'edit_world', 'edit_world']);
    const first = events[0];
    assert.deepEqual(first, { at: '2026-10-06T12:00:02.000Z', runId: 'run_test', t: 'run_started', mode: 'create', input: 'description', model: 'claude-sonnet-5-5', budgetUsd: 5, transport: 'claude-cli' });
    const last = events[events.length - 1];
    assert.equal(last?.t === 'run_finished' && last.worldWritten, true);
    assert.deepEqual(last?.t === 'run_finished' ? last.result : null, { kind: 'done', worldDir: outDir });
    assert.deepEqual(events.flatMap((e) => (e.t === 'fidelity' ? [e.check] : [])), [{ kind: 'unchecked', software: 'Zendesk-style helpdesk' }]);
    const report = readFileSync(join(outDir, 'REPORT.md'), 'utf8');
    assert.equal(report.includes('## Fidelity\n\nNot checked. The input gave no source spec or frozen reference of Zendesk-style helpdesk,'), true);
  });

  it('writes world.yaml from the checked world, with meta from the plan and the output directory', async () => {
    const { outDir } = await run(HAPPY);
    const loaded = await loadWorld(outDir);
    assert.equal(loaded.ok, true);
    const report = checkWorld(loaded.ok ? loaded.value : null);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.equal(report.world.meta.name, 'gen_helpdesk');
    assert.equal(report.world.meta.source, 'worldgen');
    assert.equal(report.world.meta.resembles, 'Zendesk-style helpdesk');
    assert.equal(report.world.meta.description, 'Customers file tickets, agents resolve pending ones, and overdue tickets escalate.');
    assert.deepEqual(Object.keys(report.world.tasks), ['resolve_password_ticket', 'resolve_initech_pending', 'escalate_acme']);
    assert.deepEqual(Object.keys(report.world.tests), ['resolve_pending_ticket', 'escalate_open_ticket']);
  });

  it('applies the planned clock before seeding imported history and preserves it on disk', async () => {
    const clock = { start: '2026-04-01T09:00:00.000Z', tick: '0s' };
    const digest: InputDigest = {
      kind: 'csv', summary: 'Imported orders paid in February', operations: [], observations: [], apiShape: null,
      fixtures: { imported_orders: [{ paid_at: '2026-02-27T13:12:00.000Z' }, { paid_at: '2026-03-07T10:00:00.000Z' }] },
    };
    const customer = `(ctx) => {
      if (ctx.fixtures.imported_orders.some((row) => ctx.now() < row.paid_at)) throw new Error('clock precedes imported payment');
      return (${CUSTOMERS})(ctx);
    }`;
    const { result, outDir, calls, filesDir } = await run([
      { input: { ...PLAN, clock } }, { input: EDITS.model }, { input: EDITS.workflow },
      { input: { ...EDITS.seed, upsert: { seed: { ...TARGET.seed, customer } } } }, { input: EDITS.tasks },
    ], { digest });
    assert.equal(result.kind, 'done');
    assert.equal(calls.length, 5);
    assert.ok(calls[1]?.prompt.includes('2026-04-01T09:00:00.000Z'));
    const loaded = await loadWorld(outDir);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const report = checkWorld(loaded.value);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.deepEqual(report.world.meta.clock, clock);
    assert.deepEqual(parseYaml(readFileSync(join(filesDir, 'plan.yaml'), 'utf8')).clock, clock);
    assert.equal(checkWorld(loaded.value).ok, true);
  });

  it('writes events.jsonl and one dump per attempt under runs/<runId>', async () => {
    const { events, calls, filesDir } = await run(HAPPY);
    const runDir = join(filesDir, 'runs', 'run_test');
    assert.deepEqual(readdirSync(runDir).sort(), ['001-plan-1.json', '002-model-1.json', '003-workflow-1.json', '004-seed-1.json', '005-tasks-1.json', 'events.jsonl']);
    const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => JSON.parse(l)), JSON.parse(JSON.stringify(events)));
    assert.deepEqual(
      events.flatMap((e) => (e.t === 'attempt' ? [e.dump] : [])),
      ['runs/run_test/001-plan-1.json', 'runs/run_test/002-model-1.json', 'runs/run_test/003-workflow-1.json', 'runs/run_test/004-seed-1.json', 'runs/run_test/005-tasks-1.json'],
    );
    const dump = JSON.parse(readFileSync(join(runDir, '002-model-1.json'), 'utf8'));
    assert.equal(dump.step, 'model');
    assert.equal(dump.n, 1);
    assert.equal(dump.model, 'claude-sonnet-5-5');
    assert.equal(dump.tool, 'edit_world');
    assert.equal(dump.prompt, calls[1]?.prompt);
    // The frozen test calls an action this stage has not built, so the check stops at the tests layer, before the paging lints.
    assert.deepEqual(dump.outcome, { kind: 'accepted', warnings: 0 });
    assert.deepEqual(dump.proposal.input, JSON.parse(JSON.stringify(EDITS.model)));
    assert.equal(dump.costUsd, 0.125);
  });

  it('writes plan.yaml before any stage runs, with the plan assumptions verbatim', async () => {
    const outDir = newOutDir();
    let planBeforeModel = false;
    const script: Script = [
      { input: PLAN },
      () => {
        planBeforeModel = existsSync(join(partialDir(outDir), 'plan.yaml'));
        return { input: EDITS.model };
      },
      { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ];
    await run(script, { outDir });
    assert.equal(planBeforeModel, true);
    const text = readFileSync(join(outDir, 'plan.yaml'), 'utf8');
    assert.equal(text.includes('  - decision: Tickets move open -> pending -> resolved, and a resolved ticket can reopen.\n'), true);
    assert.equal(text.includes('    why: SLA escalation needs a schedule, and 15 minutes is a common helpdesk default.\n'), true);
    assert.deepEqual(parseYaml(text).assumptions, [
      { decision: 'Tickets move open -> pending -> resolved, and a resolved ticket can reopen.', why: 'The description names no lifecycle, so the plan takes the smallest Zendesk-like one.' },
      { decision: 'Overdue unresolved tickets become urgent, checked every 15 minutes.', why: 'SLA escalation needs a schedule, and 15 minutes is a common helpdesk default.' },
    ]);
    assert.deepEqual(parseYaml(text).acceptanceTests, PLAN.acceptanceTests);
  });
});

describe('description route contract repair (YOS-111)', () => {
  it('retries the model stage when a matching route ID has the wrong path', async () => {
    const wrongPath = { ...EDITS.model, upsert: { ...EDITS.model.upsert, routes: routesWith('list_tickets', { path: '/wrong-tickets' }) } };
    const { result, events, calls, outDir } = await run([
      { input: PLAN }, { input: wrongPath }, { input: EDITS.model },
      { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['model', 1, 'rejected'], ['model', 2, 'accepted'],
      ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    assert.equal(calls[2]?.prompt.includes('path: routes.list_tickets'), true);
    assert.equal(calls[2]?.prompt.includes('at GET /tickets exists in the world'), true);
    assert.equal(calls[2]?.prompt.includes('found: GET /wrong-tickets'), true);
    const loaded = await loadWorld(outDir);
    assert.ok(loaded.ok);
    const report = checkWorld(loaded.value);
    assert.ok(report.ok);
    assert.equal(report.world.routes['list_tickets']?.path, '/tickets');
  });
});

describe('runWorldGen create: one bad edit, then a fixed one', () => {
  it('retries the model stage with the engine issues and then finishes', async () => {
    const script: Script = [{ input: PLAN, advice: ['Consider SLA tiers later.'] }, { input: BAD_ENTITY }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, events, calls } = await run(script);
    assert.equal(result.kind, 'done');
    assert.equal(result.costUsd, 0.75);
    assert.deepEqual(kinds(events), [
      'run_started',
      'step_started', 'advice', 'attempt', 'step_finished',
      'step_started', 'attempt', 'attempt', 'step_finished',
      'step_started', 'attempt', 'step_finished',
      'step_started', 'attempt', 'step_finished',
      'step_started', 'attempt', 'step_finished',
      'fidelity',
      'run_finished',
    ]);
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['model', 1, 'rejected'], ['model', 2, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    const advice = events.find((e) => e.t === 'advice');
    assert.deepEqual(advice?.t === 'advice' ? [advice.step, advice.text] : null, ['plan', 'Consider SLA tiers later.']);
    const rejected = events.find((e) => e.t === 'attempt' && e.outcome.kind === 'rejected');
    assert.deepEqual(rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? brief(rejected.outcome.issues) : null, [
      ['ref.unknown', ['routes', 'get_ticket', 'entity']],
    ]);
    const finished = events.filter((e) => e.t === 'step_finished');
    assert.deepEqual(finished.map((e) => (e.t === 'step_finished' ? [e.step, e.attempts, e.costUsd] : null)), [
      ['plan', 1, 0.125], ['model', 2, 0.25], ['workflow', 1, 0.125], ['seed', 1, 0.125], ['tasks', 1, 0.125],
    ]);

    const retry = calls[2]?.prompt ?? '';
    assert.equal(calls[1]?.prompt.includes('ref.unknown'), false);
    assert.equal(retry.includes('## Your previous answer was rejected'), true);
    assert.equal(retry.includes('- code: ref.unknown'), true);
    assert.equal(retry.includes('  path: routes.get_ticket.entity'), true);
    assert.equal(retry.includes('  expected: one of the declared entity names'), true);
    assert.equal(retry.includes('  found: "tikket"'), true);
    assert.equal(retry.includes('  hint: Known entity names: customer, ticket.'), true);
    assert.equal(retry.includes('"entity": "tikket"'), true);
  });

  it('keeps world.yaml unwritten until the last stage is accepted', async () => {
    const outDir = newOutDir();
    const seen: boolean[] = [];
    const look = (reply: Reply) => () => {
      seen.push(existsSync(join(outDir, 'world.yaml')) || existsSync(join(partialDir(outDir), 'world.yaml')));
      return reply;
    };
    await run([look({ input: PLAN }), look({ input: EDITS.model }), look({ input: EDITS.workflow }), look({ input: EDITS.seed }), look({ input: EDITS.tasks })], { outDir });
    assert.deepEqual(seen, [false, false, false, false, false]);
    assert.equal(existsSync(join(outDir, 'world.yaml')), true);
  });
});

describe('runWorldGen create: an action no acceptance test calls (A-136)', () => {
  const CLOSE = { ...TARGET.actions.resolve_ticket!, path: '/tickets/{id}/close' };
  const EXTRA_ACTION = { note: 'the resolve action, an unplanned close action and the escalation job', upsert: { actions: { ...TARGET.actions, close_ticket: CLOSE }, jobs: TARGET.jobs } };

  it('rejects the workflow attempt at the workflow stage, repairs it there and saves a world without the action', async () => {
    const { result, events, calls, filesDir } = await run([{ input: PLAN }, { input: EDITS.model }, { input: EXTRA_ACTION }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'rejected'], ['workflow', 2, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    assert.deepEqual(kinds(events).filter((k) => k === 'backtracked'), []);
    const rejected = events.find((e) => e.t === 'attempt' && e.outcome.kind === 'rejected');
    assert.deepEqual(rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? brief(rejected.outcome.issues) : null, [
      ['action.unexercised', ['actions', 'close_ticket']],
    ]);
    assert.equal(calls[3]?.prompt.includes('- code: action.unexercised'), true);
    const saved = parseYaml(readFileSync(join(filesDir, 'world.yaml'), 'utf8')) as World;
    assert.deepEqual(Object.keys(saved.actions), ['resolve_ticket', 'escalate_ticket']);
  });
});

describe('runWorldGen create: the plan step', () => {
  it('asks with the plan JSON Schema and a system prompt holding the format reference and example world', async () => {
    const { calls } = await run(HAPPY);
    const plan = calls[0];
    assert.equal(plan?.tool.name, 'submit_plan');
    assert.deepEqual(plan?.tool.inputSchema, z.toJSONSchema(planSchemaFor('description'), { io: 'input' }));
    assert.equal(plan?.system.includes(formatReference().trimEnd()), true);
    assert.equal(plan?.system.includes(renderWorldYaml(minimalWorld()).trimEnd()), true);
    assert.equal(plan?.prompt.startsWith(`## This step: plan\n\n${PLAN_BRIEF}\n\n## Input (description)\n\nA helpdesk where overdue tickets escalate`), true);
  });

  it('feeds plan schema errors back and accepts the corrected plan', async () => {
    const { result, events, calls } = await run([{ input: { software: 'helpdesk' } }, { input: PLAN }, new ModelError('stop here')]);
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'accepted'], ['model', 1, 'model_error']]);
    const invalid = events.find((e) => e.t === 'attempt' && e.outcome.kind === 'invalid_output');
    const issues = invalid?.t === 'attempt' && invalid.outcome.kind === 'invalid_output' ? invalid.outcome.issues : [];
    assert.deepEqual(issues.map((i) => i.path[0]), issues.map(() => 'plan'));
    assert.equal(issues.some((i) => i.code === 'schema.invalid' && i.path.join('.') === 'plan.summary'), true);
    assert.equal(calls[1]?.prompt.includes('  path: plan.summary'), true);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'model_error', message: 'stop here' });
  });

  it('rejects a first description plan with no assumptions, says why in the retry, and accepts the corrected plan', async () => {
    const silent = { ...PLAN, assumptions: [] };
    const { result, events, calls } = await run([{ input: silent }, ...HAPPY]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    const invalid = events.find((e) => e.t === 'attempt' && e.outcome.kind === 'invalid_output');
    const issues = invalid?.t === 'attempt' && invalid.outcome.kind === 'invalid_output' ? invalid.outcome.issues : [];
    assert.deepEqual(issues.map((i) => [i.code, i.path.join('.')]), [['schema.invalid', 'plan.assumptions']]);
    const retry = calls[1]?.prompt ?? '';
    assert.equal(retry.includes('  path: plan.assumptions'), true);
    assert.equal(retry.includes('a plan built from a description needs at least one assumption'), true);
  });

  it('stops with input_rejected on a refusal, writing plan.yaml but no world.yaml', async () => {
    const refusal = { ...PLAN, verdict: { kind: 'refuse', why: 'The input asks for a phishing site.' }, workflows: [], tasks: [] };
    const { result, events, calls, filesDir } = await run([{ input: refusal }]);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'input_rejected', why: 'The input asks for a phishing site.' });
    assert.equal(calls.length, 1);
    assert.deepEqual(kinds(events), ['run_started', 'step_started', 'attempt', 'step_finished', 'run_finished']);
    assert.equal(parseYaml(readFileSync(join(filesDir, 'plan.yaml'), 'utf8')).verdict.kind, 'refuse');
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
  });
});

describe('runWorldGen create: a rule binds the acceptance test that exercises it (YOS-155)', () => {
  const RESOLUTION = PLAN.workflows[0]!;
  const MISSING_TEST = { rule: 'only a pending ticket can be resolved', by: ['resolve_ticket'], test: 'no_such_test' };
  const BOUND_RULE = { rule: 'only a pending ticket can be resolved', by: ['resolve_ticket'], test: 'resolve_pending_ticket' };
  const SCHEMA_RULE = { rule: 'a ticket status moves only along its declared transitions', schema: 'the ticket.status state field declares every transition' };
  const rulePlan = (rules: readonly unknown[]): unknown => ({ ...PLAN, workflows: [{ ...RESOLUTION, rules }] });

  it('rejects a rule whose bound test does not exist at the plan step, then accepts the same rule bound to a real test', async () => {
    const { result, events, calls } = await run([{ input: rulePlan([MISSING_TEST]) }, { input: rulePlan([BOUND_RULE]) }, new ModelError('stop here')]);
    assert.deepEqual(attempts(events), [['plan', 1, 'invalid_output'], ['plan', 2, 'accepted'], ['model', 1, 'model_error']]);
    const invalid = events.find((e) => e.t === 'attempt' && e.outcome.kind === 'invalid_output');
    const issues = invalid?.t === 'attempt' && invalid.outcome.kind === 'invalid_output' ? invalid.outcome.issues : [];
    assert.deepEqual(issues.map((i) => [i.code, i.path.join('.'), i.found]), [['schema.invalid', 'plan.workflows.0.rules.0.test', '"no_such_test"']]);
    assert.equal(calls[1]?.prompt.includes('  path: plan.workflows.0.rules.0.test'), true);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'model_error', message: 'stop here' });
  });

  it('completes a run with one rule bound to its test and one data-model rule, and saves the bound test exactly as written', async () => {
    const { result, events, calls, outDir, filesDir } = await run([{ input: rulePlan([BOUND_RULE, SCHEMA_RULE]) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.equal(result.kind, 'done');
    assert.equal(result.costUsd, 0.625);
    assert.equal(calls.length, 5);
    assert.deepEqual(kinds(events), HAPPY_EVENTS);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    assert.deepEqual(parseYaml(readFileSync(join(filesDir, 'plan.yaml'), 'utf8')).workflows[0]?.rules, [BOUND_RULE, SCHEMA_RULE]);
    const loaded = await loadWorld(outDir);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const report = checkWorld(loaded.value);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.deepEqual(report.world.tests, {
      resolve_pending_ticket: { description: 'a pending ticket can be resolved', script: RESOLVE_TEST },
      escalate_open_ticket: { description: 'an unresolved ticket can be escalated', script: ESCALATE_TEST },
    });
  });
});

describe('runWorldGen create: an infeasible request is refused at plan (A-104)', () => {
  const CODEC = { ...PLAN, software: 'video codec', summary: 'refused', workflows: [], tasks: [],
    verdict: { kind: 'refuse', why: 'A video codec is computation on frames, not stateful records with actions an agent performs through an API.',
      feasibleIf: 'Ask for a service that holds records and actions, such as a video-encoding job queue with jobs, presets and retries.' } };

  it('stops at plan with the reason and what would make the request feasible, spending one call', async () => {
    const { result, calls, filesDir } = await run([{ input: CODEC }]);
    const why = result.kind === 'stopped' && result.reason.kind === 'input_rejected' ? result.reason.why : '';
    assert.match(why, /not stateful records with actions/);
    assert.match(why, /What would make it feasible: Ask for a service that holds records and actions, such as a video-encoding job queue/);
    assert.equal(calls.length, 1);
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
    assert.match(report(filesDir), /What would make it feasible: Ask for a service that holds records and actions/);
    assert.match(readFileSync(join(filesDir, 'plan.yaml'), 'utf8'), /feasibleIf:/);
  });

  it('asks the plan step to decide feasibility before anything else', async () => {
    const { calls } = await run([{ input: CODEC }]);
    assert.match(calls[0]?.prompt ?? '', /stateful records/);
    assert.match(calls[0]?.prompt ?? '', /feasibleIf/);
  });
});

describe('runWorldGen create: stage tools and scope', () => {
  // A-409: the cache prefix runs tools, then system, so one edit tool and one system prompt let the four stages share a cached prefix.
  it('gives every stage one edit tool over every stage\'s sections, and names each stage\'s own sections in its prompt', async () => {
    const { calls } = await run(HAPPY);
    for (const c of calls.slice(1)) {
      assert.deepEqual(c.tool, {
        name: 'edit_world', description: "Propose one WorldEdit for this stage. Write only the sections this step's prompt names: any other is refused.",
        inputSchema: editJsonSchema(['entities', 'routes', 'actions', 'jobs', 'seed', 'tasks']),
      });
    }
    assert.equal(calls[1]?.prompt.startsWith(`## This step: model\n\n${STAGES.model.brief}\n\n`), true);
    assert.equal(calls[4]?.prompt.startsWith(`## This step: tasks\n\n${STAGES.tasks.brief}\n\n`), true);
    assert.deepEqual(['It may write only entities, routes.', 'It may write only tasks.'].map((line, i) => calls[i === 0 ? 1 : 4]?.prompt.includes(line)), [true, true]);
  });

  it('sends every step of a run one system prompt with no step in it, and opens each prompt with its step (A-409)', async () => {
    const { calls } = await run(HAPPY);
    assert.deepEqual([...new Set(calls.map((c) => c.system))], [systemPrompt(minimalWorld())]);
    assert.equal(calls[0]?.system.includes('## This step:'), false);
    assert.deepEqual(calls.map((c) => c.prompt.split('\n')[0]), ['## This step: plan', '## This step: model', '## This step: workflow', '## This step: seed', '## This step: tasks']);
    assert.notDeepEqual(calls[0]?.tool, calls[1]?.tool);
  });

  it('opens the workflow call with the path rule read from the example world the run picked (A-409)', async () => {
    const loaded = await loadWorld(join(import.meta.dirname, '../../prod/worlds/helpdesk'));
    const report = checkWorld(loaded.ok ? loaded.value : null);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    const { calls } = await run(HAPPY, { exampleWorld: report.world });
    assert.equal(calls[2]?.prompt.includes('Example from the example world: routes.create_ticket declares POST /tickets, so no action may use POST /tickets.'), true);
    assert.equal(calls[2]?.system.includes('Example from the example world:'), false);
  });

  it('rejects edits to meta and to fixtures as edit.out_of_scope', async () => {
    const intrusive = { note: 'too much', meta: { description: 'mine' }, upsert: { entities: TARGET.entities, routes: TARGET.routes, tasks: TARGET.tasks } };
    const fixtures = { note: 'tables', upsert: { fixtures: { legacy_ticket: [{ subject: 'Old' }] } } };
    const { result, events, calls, filesDir } = await run([{ input: PLAN }, { input: intrusive }, { input: fixtures }, new ModelError('stop here')]);
    const outcomes = events.flatMap((e) => (e.t === 'attempt' && e.outcome.kind === 'invalid_output' ? [brief(e.outcome.issues)] : []));
    assert.deepEqual(outcomes, [
      [['edit.out_of_scope', ['meta']]],
      [['edit.out_of_scope', ['fixtures']]],
    ]);
    assert.equal(calls[2]?.prompt.includes('  hint: This stage does not own meta.'), true);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'model_error', message: 'stop here' });
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
  });

  // A-409: the one edit tool lets a stage name another stage's section; only the owner's write lands, as each stage's own schema once allowed.
  it('drops the sections another stage owns from a stage edit, and the owner writes them in its turn (A-409)', async () => {
    const stray = { ...TARGET.tasks.resolve_password_ticket!, instruction: 'STRAY-TASK-FROM-THE-MODEL-STAGE' };
    const eager = { note: 'entities, routes and a task', upsert: { entities: TARGET.entities, routes: TARGET.routes, tasks: { stray_task: stray } } };
    const { result, events, calls, filesDir } = await run([{ input: PLAN }, { input: eager }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.deepEqual(attempts(events).map(([step, , outcome]) => [step, outcome]), [
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'accepted'],
    ]);
    assert.deepEqual(calls.slice(2).map((c) => c.prompt.includes('STRAY-TASK-FROM-THE-MODEL-STAGE')), [false, false, false]);
    assert.equal(result.kind, 'done');
    const saved = parseYaml(readFileSync(join(filesDir, 'world.yaml'), 'utf8')) as World;
    assert.deepEqual(Object.keys(saved.tasks).sort(), Object.keys(TARGET.tasks).sort());
    assert.equal(readFileSync(join(filesDir, 'world.yaml'), 'utf8').includes('stray_task'), false);
  });

  it('tells a stage retried for other issues which of its sections were left out, so it stops resending them (A-409)', async () => {
    const stray = { ...TARGET.tasks.resolve_password_ticket!, instruction: 'STRAY-TASK-FROM-THE-MODEL-STAGE' };
    const badAndEager = { ...BAD_ENTITY, upsert: { ...BAD_ENTITY.upsert, tasks: { stray_task: stray }, seed: {} } };
    const { result, events, calls } = await run([{ input: PLAN }, { input: badAndEager }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.deepEqual(attempts(events).map(([step, , outcome]) => [step, outcome]).slice(0, 3), [['plan', 'accepted'], ['model', 'rejected'], ['model', 'accepted']]);
    assert.equal(calls[2]?.prompt.includes('Left out of the answer, because another stage writes them:\n\n- ignored: tasks (owned by the tasks stage)'), true);
    assert.equal(calls[2]?.prompt.includes('ignored: seed'), false);
    assert.equal(calls[3]?.prompt.includes('ignored:'), false);
    assert.equal(result.kind, 'done');
  });

  /** A first workflow answer whose handler refuses every resolve, so the frozen test fails and the next answer is a repair. */
  const BROKEN_HANDLER = {
    note: 'the resolve action and the escalation job',
    upsert: {
      actions: { ...TARGET.actions, resolve_ticket: { ...TARGET.actions['resolve_ticket'], handler: "(ctx) => ctx.fail(409, 'invalid_state', 'not yet')" } },
      jobs: TARGET.jobs,
    },
  };
  const workflowAttempts = (events: readonly RunEvent[]) =>
    events.filter((e): e is Extract<RunEvent, { t: 'attempt' }> => e.t === 'attempt' && e.step === 'workflow');
  const issuesOf = (e: Extract<RunEvent, { t: 'attempt' }> | undefined) =>
    e !== undefined && (e.outcome.kind === 'rejected' || e.outcome.kind === 'invalid_output') ? e.outcome.issues : [];

  it('rejects a workflow repair that weakens a frozen acceptance test and sends it to the plan, which must raise the revision to change the test', async () => {
    const weakened = {
      note: 'fix the handler and relax the test',
      upsert: {
        actions: TARGET.actions,
        jobs: TARGET.jobs,
        tests: { resolve_pending_ticket: { description: 'a pending ticket can be resolved', script: '(ctx) => { ctx.assert(true, "always"); }' } },
      },
    };
    const { result, events, calls, outDir, filesDir } = await run([
      { input: PLAN }, { input: EDITS.model }, { input: BROKEN_HANDLER }, { input: weakened }, { input: PLAN }, { input: REVISED_PLAN },
      { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ]);
    assert.equal(result.kind, 'done');
    const workflow = workflowAttempts(events);
    assert.deepEqual(workflow.map((e) => [e.n, e.outcome.kind]), [[1, 'rejected'], [2, 'rejected'], [1, 'accepted']]);
    assert.deepEqual(issuesOf(workflow[0]).map((i) => [i.code, i.path.join('.')]), [['test.failed', 'tests.resolve_pending_ticket.script']]);
    const repair = issuesOf(workflow[1]);
    assert.equal(repair.length, 1);
    assert.equal(repair[0]?.code, 'edit.out_of_scope');
    assert.equal(repair[0]?.path.join('.'), 'tests');
    assert.deepEqual(events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to]] : [])), [['workflow', 'plan']]);
    const plans = events.filter((e): e is Extract<RunEvent, { t: 'attempt' }> => e.t === 'attempt' && e.step === 'plan');
    assert.deepEqual(plans.map((e) => e.outcome.kind), ['accepted', 'invalid_output', 'accepted']);
    assert.deepEqual(issuesOf(plans[1]).map((i) => [i.code, i.path.join('.'), i.found]), [['schema.invalid', 'plan.revision', '1']]);
    assert.equal(calls[4]?.prompt.includes('## Current approved plan'), true);
    assert.equal(calls[4]?.prompt.includes('This is revision 1. Answer with revision 2: change what the issues below require, and keep the rest as it is.'), true);
    assert.deepEqual(parseYaml(readFileSync(join(filesDir, 'plan.yaml'), 'utf8')).revision, 2);
    assert.deepEqual(parseYaml(readFileSync(join(filesDir, 'plan.yaml'), 'utf8')).acceptanceTests, REVISED_PLAN.acceptanceTests);
    const saved = await loadWorld(outDir);
    assert.deepEqual(saved.ok ? (saved.value as World).tests : null, {
      resolve_pending_ticket: { description: 'a pending ticket can be resolved and reads back as resolved', script: REVISED_PLAN.acceptanceTests[0]?.script },
      escalate_open_ticket: { description: 'an unresolved ticket can be escalated', script: ESCALATE_TEST },
    });
  });

  it('rejects a workflow repair that removes a frozen acceptance test, and the reapproved plan puts the same test back', async () => {
    const removal = {
      note: 'fix the handler and drop the failing test',
      upsert: { actions: TARGET.actions, jobs: TARGET.jobs },
      remove: { tests: ['resolve_pending_ticket'] },
    };
    const { result, events, outDir } = await run([
      { input: PLAN }, { input: EDITS.model }, { input: BROKEN_HANDLER }, { input: removal }, { input: REAPPROVED_PLAN },
      { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ]);
    assert.equal(result.kind, 'done');
    const workflow = workflowAttempts(events);
    assert.deepEqual(workflow.map((e) => [e.n, e.outcome.kind]), [[1, 'rejected'], [2, 'rejected'], [1, 'accepted']]);
    const repair = issuesOf(workflow[1]);
    assert.equal(repair.length, 1);
    assert.equal(repair[0]?.code, 'edit.out_of_scope');
    assert.equal(repair[0]?.path.join('.'), 'tests');
    assert.deepEqual(events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to]] : [])), [['workflow', 'plan']]);
    const saved = await loadWorld(outDir);
    assert.deepEqual(saved.ok ? (saved.value as World).tests : null, {
      resolve_pending_ticket: { description: 'a pending ticket can be resolved', script: RESOLVE_TEST },
      escalate_open_ticket: { description: 'an unresolved ticket can be escalated', script: ESCALATE_TEST },
    });
  });

  it('flags unknown edit keys and section names instead of dropping them, and ignores empty unowned parts', () => {
    assert.deepEqual(brief(scopeIssues('model', { note: 'x', upserts: {}, upsert: { entity: { a: 1 } } })), [
      ['edit.out_of_scope', ['format', 'upserts']],
      ['edit.out_of_scope', ['format', 'upsert', 'entity']],
    ]);
    assert.deepEqual(scopeIssues('seed', { note: 'x', meta: {}, upsert: { seed: { ticket: '(ctx) => []' }, tasks: {} }, remove: { routes: [] } }), []);
    assert.deepEqual(brief(scopeIssues('workflow', { upsert: { tests: { resolve_pending_ticket: { script: '(ctx) => { ctx.assert(true); }' } } } })), [
      ['edit.out_of_scope', ['tests']],
    ]);
  });

  it('requires a plan built from a description to record at least one open question, but not other inputs', () => {
    const none = { ...PLAN, open_questions: [] };
    const asked = { ...PLAN, open_questions: [{ question: 'Which SLA tiers exist?', default_answer: 'Standard and priority' }] };
    const refused = planSchemaFor('description').safeParse(none);
    assert.equal(refused.success, false);
    assert.deepEqual(refused.error?.issues.map((i) => [i.path.join('.'), i.message]), [
      ['open_questions', 'a plan built from a description needs at least one open question with the default answer taken: ask what a human would be asked'],
    ]);
    assert.equal(planSchemaFor('description').safeParse(asked).success, true);
    assert.equal(planSchemaFor('csv').safeParse(none).success, true);
  });

  it('requires the approved plan to define an acceptance test for every workflow action', () => {
    const parsed = planSchemaFor('description').safeParse({ ...PLAN, acceptanceTests: [] });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.issues.some((i) => i.message === 'a plan to build needs acceptance tests before implementation begins'), true);
  });
});

describe('runWorldGen create: OpenAPI fidelity at the model step', () => {
  it('rejects a model edit whose route field departs from the source spec, so the run never backtracks from tasks', async () => {
    const spec = join(mkdtempSync(join(tmpdir(), 'wg-spec-')), 'spec.json');
    const tier = { type: 'string', enum: ['free', 'pro', 'enterprise', 'trial'] };
    writeFileSync(spec, JSON.stringify({ openapi: '3.0.3', paths: { '/customers/{id}': { get: { responses: {
      '200': { content: { 'application/json': { schema: { type: 'object', properties: { tier } } } } } } } } } }));
    const customer = TARGET.entities['customer']!;
    const withTrial = { ...customer, fields: { ...customer.fields, tier: { type: 'enum', values: tier.enum, required: true } } };
    const fixedModel = { note: 'tier takes trial', upsert: { entities: { ...TARGET.entities, customer: withTrial }, routes: TARGET.routes } };
    const script: Script = [{ input: PLAN }, { input: EDITS.model }, { input: fixedModel }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, events } = await run(script, { input: { kind: 'openapi', path: spec, only: [] }, digest: { kind: 'openapi', summary: 'a customers API', fixtures: {}, observations: [], operations: [], apiShape: null } });
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'rejected'], ['model', 2, 'accepted'],
      ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    assert.equal(result.kind, 'done');
    const first = events.find((e) => e.t === 'attempt' && e.step === 'model');
    assert.deepEqual(first?.t === 'attempt' && first.outcome.kind === 'rejected' ? brief(first.outcome.issues) : null,
      [['openapi.field_enum', ['input', 'openapi', 'GET /customers/{id}', 'response', 'tier']]]);
    assert.equal(events.some((e) => e.t === 'backtracked'), false);
  });
});

describe('runWorldGen create: OpenAPI request shape is judged at the step that builds it (YOS-222)', () => {
  const OPENAPI_DIGEST: InputDigest = { kind: 'openapi', summary: 'a helpdesk API', fixtures: {}, observations: [], operations: [], apiShape: null };
  const specFile = (paths: unknown): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'wg-spec-')), 'spec.json');
    writeFileSync(file, JSON.stringify({ openapi: '3.0.3', paths }));
    return file;
  };
  const steps = (events: readonly RunEvent[]) => events.flatMap((e) => (e.t === 'attempt' ? [[e.step, e.outcome.kind] as const] : []));
  const firstRejected = (events: readonly RunEvent[], step: string) => {
    const e = events.find((x) => x.t === 'attempt' && x.step === step && x.outcome.kind === 'rejected');
    return e?.t === 'attempt' && e.outcome.kind === 'rejected' ? brief(e.outcome.issues) : null;
  };

  it('rejects an action whose request departs from the spec at the workflow step, not first at tasks', async () => {
    const reasons = ['duplicate', 'fraudulent', 'requested_by_customer'];
    const spec = specFile({ '/tickets/{id}/resolve': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string', enum: reasons } } } } } },
      responses: { '200': { description: 'resolved' } } } } });
    const resolve = TARGET.actions['resolve_ticket']!;
    const withReason = (values: string[]) => ({ note: 'resolve takes a reason', upsert: { actions: { ...TARGET.actions, resolve_ticket: { ...resolve, input: { reason: { type: 'enum', values } } } }, jobs: TARGET.jobs } });
    const script: Script = [{ input: PLAN }, { input: EDITS.model }, { input: withReason([...reasons, 'other']) }, { input: withReason(reasons) }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, events } = await run(script, { input: { kind: 'openapi', path: spec, only: [] }, digest: OPENAPI_DIGEST });
    assert.deepEqual(steps(events), [['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'rejected'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'accepted']]);
    assert.deepEqual(firstRejected(events, 'workflow'), [['openapi.field_enum', ['input', 'openapi', 'POST /tickets/{id}/resolve', 'request', 'reason']]]);
    assert.equal(events.some((e) => e.t === 'backtracked'), false);
    assert.equal(result.kind, 'done');
  });

  it('replays YOS-241: an action field the spec requires, made required but with a default, is progress, and the next attempt hears why', async () => {
    const spec = specFile({ '/tickets/{id}/resolve': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } } },
      responses: { '200': { description: 'resolved' } } } } });
    const resolve = TARGET.actions['resolve_ticket']!;
    const withReason = (reason: object) => ({ note: 'resolve takes a reason', upsert: { actions: { ...TARGET.actions, resolve_ticket: { ...resolve, input: { reason } } }, jobs: TARGET.jobs } });
    // As the live run answered: the field optional, then required with a default. Before YOS-241 both read
    // `fields reason`, so the second stopped the run as no_progress before a third workflow call.
    const script: Script = [{ input: PLAN }, { input: EDITS.model }, { input: withReason({ type: 'string' }) },
      { input: withReason({ type: 'string', required: true, default: 'none' }) }, new ModelError('the third workflow call')];
    const { result, events, calls } = await run(script, { input: { kind: 'openapi', path: spec, only: [] }, digest: OPENAPI_DIGEST });
    assert.deepEqual(steps(events), [['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'rejected'], ['workflow', 'rejected'], ['workflow', 'model_error']]);
    const found = events.flatMap((e) => (e.t === 'attempt' && e.outcome.kind === 'rejected' ? [e.outcome.issues.map((i) => [i.code, i.path.join('.'), i.found])] : []));
    const at = 'input.openapi.POST /tickets/{id}/resolve.request.reason';
    assert.deepEqual(found, [
      [['openapi.required_field_missing', at, 'reason is optional']],
      [['openapi.required_field_missing', at, 'reason has a default, so a request may leave it out']],
    ]);
    assert.equal(calls[4]?.prompt.includes('reason has a default, so a request may leave it out'), true);
    assert.equal(calls[4]?.prompt.includes('make it required with no default'), true);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'model_error', message: 'the third workflow call' });
  });

  it('rejects a route whose request requires a field the spec leaves optional at the model step, not first at tasks', async () => {
    const spec = specFile({ '/customers': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] } } } } } },
      responses: { '201': { description: 'created' } } } } });
    const customer = TARGET.entities['customer']!;
    const optionalTier = { ...customer, fields: { ...customer.fields, tier: { ...customer.fields['tier']!, required: false } } };
    const fixedModel = { note: 'tier is optional, as in the spec', upsert: { entities: { ...TARGET.entities, customer: optionalTier }, routes: TARGET.routes } };
    const script: Script = [{ input: PLAN }, { input: EDITS.model }, { input: fixedModel }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, events } = await run(script, { input: { kind: 'openapi', path: spec, only: [] }, digest: OPENAPI_DIGEST });
    assert.deepEqual(steps(events), [['plan', 'accepted'], ['model', 'rejected'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'accepted']]);
    assert.deepEqual(firstRejected(events, 'model'), [['openapi.required_field_extra', ['input', 'openapi', 'POST /customers', 'request', 'tier']]]);
    assert.equal(events.some((e) => e.t === 'backtracked'), false);
    assert.equal(result.kind, 'done');
  });
});

describe('runWorldGen create: OpenAPI fidelity at the last step', () => {
  it('rejects a finished world that lacks a status the source spec declares, and never saves it', async () => {
    const spec = join(mkdtempSync(join(tmpdir(), 'wg-spec-')), 'spec.json');
    writeFileSync(spec, JSON.stringify({ openapi: '3.0.3', paths: { '/customers/{id}': { get: { responses: {
      '200': { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
      '409': { description: 'conflict' } } } } } }));
    const script: Script = [{ input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }, { input: EDITS.tasks }, { input: EDITS.tasks }];
    const { result, events, outDir } = await run(script, { input: { kind: 'openapi', path: spec, only: [] }, digest: { kind: 'openapi', summary: 'a customers API', fixtures: {}, observations: [], operations: [], apiShape: null } });
    const first = events.find((e) => e.t === 'attempt' && e.step === 'tasks');
    assert.deepEqual(first?.t === 'attempt' && first.outcome.kind === 'rejected' ? brief(first.outcome.issues) : null,
      [['openapi.status_missing', ['input', 'openapi', 'GET /customers/{id}', 'responses', '409']]]);
    assert.equal(result.kind, 'stopped');
    assert.equal((await loadWorld(outDir)).ok, false);
  });
});

describe('the plan prompt names the engine error codes acceptance tests may assert', () => {
  it('lists every standard error code with its status before the plan writes its tests', async () => {
    const { result, calls } = await run(HAPPY);
    assert.equal(result.kind, 'done');
    const prompt = calls[0]?.prompt ?? '';
    assert.equal(prompt.includes('## Engine error codes'), true);
    assert.equal(prompt.includes('- row.not_found (404): No row has this id.'), true);
    assert.equal(prompt.includes('- state.transition (422): A write moves a state field along an undeclared transition.'), true);
    assert.equal(prompt.includes('never a code of its own such as not_found'), true);
    assert.equal(calls[1]?.prompt.includes('## Engine error codes'), false);
  });
});

describe('the briefs pin success statuses and OpenAPI field names', () => {
  it('lists the engine success status of every standard op in the plan prompt only', async () => {
    const { result, calls } = await run(HAPPY);
    assert.equal(result.kind, 'done');
    const prompt = calls[0]?.prompt ?? '';
    assert.equal(prompt.includes('## Engine success statuses'), true);
    for (const line of ['- list: 200', '- get: 200', '- create: 201', '- update: 200', '- delete: 204']) assert.equal(prompt.includes(line), true, line);
    assert.equal(prompt.includes('## Spec field names'), false);
    assert.equal(calls[1]?.prompt.includes('## Engine success statuses'), false);
  });

  it('tells the plan and the model stage to keep the spec field names on OpenAPI input', async () => {
    const spec = join(mkdtempSync(join(tmpdir(), 'wg-spec-')), 'spec.json');
    writeFileSync(spec, JSON.stringify({ openapi: '3.0.3', paths: {} }));
    const { calls } = await run(HAPPY, { input: { kind: 'openapi', path: spec, only: [] }, digest: { kind: 'openapi', summary: 'a pets API', fixtures: {}, observations: [], operations: [], apiShape: null } });
    const rule = 'Keep every field name exactly as the spec spells it, such as photoUrls; never rename one to snake_case.';
    assert.equal(calls[0]?.prompt.includes(rule), true);
    assert.equal(calls[1]?.prompt.includes(rule), true);
    assert.equal(calls[2]?.prompt.includes(rule), false);
  });
});

describe('runWorldGen create: code writes fixtures and the API shape', () => {
  const API: World['meta']['api'] = { list: { mode: 'cursor', dataKey: 'data', cursorKey: 'next', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' }, error: { message: '$message' } };
  const FIXTURES = { legacy_ticket: [{ subject: 'Old printer', priority: 'low' }, { subject: 'Lost badge', priority: 'high' }] };
  const DIGEST: InputDigest = { kind: 'description', summary: 'A helpdesk imported from a legacy tracker', fixtures: FIXTURES, operations: [], observations: [], apiShape: API };

  it('puts digest fixtures and apiShape into the world before the model stage and keeps them to the end', async () => {
    const { result, calls, outDir } = await run(HAPPY, { digest: DIGEST });
    assert.equal(result.kind, 'done');
    assert.equal(calls[0]?.prompt.includes('- legacy_ticket: 2 rows, columns subject, priority'), true);
    assert.equal(calls[1]?.prompt.includes('cursorKey: next'), true);
    assert.equal(calls[1]?.prompt.includes('subject: Old printer'), true);
    const loaded = await loadWorld(outDir);
    const world = loaded.ok ? (loaded.value as World) : null;
    assert.deepEqual(world?.fixtures, FIXTURES);
    assert.deepEqual(world?.meta.api, API);
  });

  it('stops with input_rejected when the digest tables do not fit the world format', async () => {
    const bad: InputDigest = { ...DIGEST, fixtures: { 'Bad Name': [{ a: 1 }] } };
    const { result, calls } = await run(HAPPY, { digest: bad });
    assert.equal(result.kind === 'stopped' ? result.reason.kind : null, 'input_rejected');
    assert.equal(calls.length, 0);
  });
});

describe('runWorldGen: a backtrack from tasks to model fits in the time left (A-139)', () => {
  it('reruns model, workflow, seed and tasks with 357 s left, less than the 414 s first-pass reserves of the later steps', async () => {
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 15 });
    const script: Script = [...HAPPY, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, events } = await run(script, { config, check: tasksBreakModelOnce(), callAdvanceMs: [0, 0, 0, 0, 500_000] });
    assert.deepEqual(events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to]] : [])), [['tasks', 'model']]);
    assert.deepEqual(events.flatMap((e) => (e.t === 'call_refused' ? [e] : [])), []);
    assert.equal(result.kind, 'done');
  });
});

describe('runWorldGen: a tasks -> seed pressure backtrack fits in the A-48 limits (YOS-226, A-330)', () => {
  // The YOS-100 rehearsal's 01-gym run, call for call: each call takes its live time and cost, and the clock moves only inside calls.
  // The two repairs after the backtrack take their estimates, a quarter of the step's first call (A-95).
  const GYM = [
    { input: PLAN, ms: 234_391, costUsd: 0.391 },
    { input: EDITS.model, ms: 21_758, costUsd: 0.178 },
    { input: EDITS.workflow, ms: 214_214, costUsd: 0.218 },
    { input: EDITS.seed, ms: 130_144, costUsd: 0.355 },
    { input: EDITS.tasks, ms: 139_725, costUsd: 0.404 },
    { input: EDITS.seed, ms: 32_536, costUsd: 0.089 },
    { input: EDITS.tasks, ms: 34_931, costUsd: 0.101 },
  ];
  const config = configSchema.parse({
    model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 15, steps: { plan: { minShareSeconds: 330 } },
    stepModels: { plan: { effort: 'medium' }, model: { effort: 'high' }, workflow: { effort: 'medium' }, seed: { effort: 'medium' }, tasks: { effort: 'high' } },
  });
  /** The first world that holds tasks misses a pressure claim the seed owns, as `seed.booking` did live. */
  const pressureUnmetOnce = (): ((world: World) => CheckReport) => {
    let left = 1;
    return (world) => {
      if (Object.keys(world.tasks).length === 0 || left === 0) return checkWorld(world);
      left -= 1;
      const unmet = issue('task.pressure_unmet', ['seed', 'ticket'], { task: 'resolve_pending_ticket', need: 'a filtered ticket list returns a row it leaves unchanged' }, 'no such row');
      return { ok: false, reached: 'tasks', issues: [unmet], warnings: [] };
    };
  };

  it('reruns seed and tasks as repairs with 159.8 s left and finishes at 807.7 s for $1.74', async () => {
    let t = T0;
    let n = 0;
    const model: Model = {
      async propose() {
        const call = GYM[n++];
        if (call === undefined) throw new Error(`the gym script has no reply for call ${n}`);
        t += call.ms;
        return { input: call.input, advice: [], usage: USAGE, costUsd: call.costUsd, ms: call.ms };
      },
    };
    const events: RunEvent[] = [];
    const result = await runWorldGen(
      { kind: 'create', input: { kind: 'description', text: 'Something like Mindbody for a gym' }, outDir: newOutDir() },
      config,
      { model, exampleWorld: minimalWorld(), emit: (e) => events.push(e), now: () => t, runId: 'run_test', check: pressureUnmetOnce() },
    );
    assert.deepEqual(events.flatMap((e) => (e.t === 'call_refused' ? [[e.step, e.reason, e.estimateMs, e.remainingMs]] : [])), []);
    assert.deepEqual(events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to]] : [])), [['tasks', 'seed']]);
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'],
      ['tasks', 1, 'rejected'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    assert.equal(result.kind, 'done');
    assert.equal(result.kind === 'done' ? result.ms : null, 807_699);
    assert.equal(result.kind === 'done' ? result.costUsd.toFixed(3) : null, '1.736');
  });
});

describe('runWorldGen: after a tasks -> model backtrack, workflow and seed rerun as repairs (YOS-54, A-349)', () => {
  // The gym run's first pass as above, with the tasks rejection owned by model instead of seed. Model reruns with the
  // backtrack's issues; workflow and seed rerun with none. Each call after the backtrack takes its repair estimate.
  const GYM_MODEL = [
    { input: PLAN, ms: 234_391, costUsd: 0.391 },
    { input: EDITS.model, ms: 21_758, costUsd: 0.178 },
    { input: EDITS.workflow, ms: 214_214, costUsd: 0.218 },
    { input: EDITS.seed, ms: 130_144, costUsd: 0.355 },
    { input: EDITS.tasks, ms: 139_725, costUsd: 0.404 },
    { input: EDITS.model, ms: 5_440, costUsd: 0.045 },
    { input: EDITS.workflow, ms: 53_554, costUsd: 0.054 },
    { input: EDITS.seed, ms: 32_536, costUsd: 0.089 },
    { input: EDITS.tasks, ms: 34_931, costUsd: 0.101 },
  ];
  const config = configSchema.parse({
    model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 15, steps: { plan: { minShareSeconds: 330 } },
    stepModels: { plan: { effort: 'medium' }, model: { effort: 'high' }, workflow: { effort: 'medium' }, seed: { effort: 'medium' }, tasks: { effort: 'high' } },
  });

  it('prices the workflow rerun with no feedback as the repair it is reserved as, and finishes at 866.7 s for $1.84', async () => {
    let t = T0;
    let n = 0;
    const model: Model = {
      async propose() {
        const call = GYM_MODEL[n++];
        if (call === undefined) throw new Error(`the gym script has no reply for call ${n}`);
        t += call.ms;
        return { input: call.input, advice: [], usage: USAGE, costUsd: call.costUsd, ms: call.ms };
      },
    };
    const events: RunEvent[] = [];
    const result = await runWorldGen(
      { kind: 'create', input: { kind: 'description', text: 'Something like Mindbody for a gym' }, outDir: newOutDir() },
      config,
      { model, exampleWorld: minimalWorld(), emit: (e) => events.push(e), now: () => t, runId: 'run_test', check: tasksBreakModelOnce() },
    );
    assert.deepEqual(events.flatMap((e) => (e.t === 'call_refused' ? [[e.step, e.reason, e.estimateMs, e.remainingMs]] : [])), []);
    assert.deepEqual(events.flatMap((e) => (e.t === 'backtracked' ? [[e.from, e.to]] : [])), [['tasks', 'model']]);
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'rejected'],
      ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    assert.equal(result.kind, 'done');
    assert.equal(result.kind === 'done' ? result.ms : null, 866_693);
    assert.equal(result.kind === 'done' ? result.costUsd.toFixed(3) : null, '1.835');
  });
});

describe('runWorldGen judges the planned state mix on create, before any task exists (A-155)', () => {
  const withMix = (stateMix: Record<string, Record<string, number>>) => ({ ...PLAN, seed: { ...PLAN.seed, stateMix } });

  it('rejects a seed whose state shares stray more than 10 points from stateMix', async () => {
    const { events } = await run([
      { input: withMix({ ticket: { open: 10, pending: 80, resolved: 10 } }) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed },
      new ModelError('stop after the seed is judged'),
    ]);
    assert.deepEqual(attempts(events).slice(0, 4), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'rejected']]);
    const rejected = events.find((e) => e.t === 'attempt' && e.step === 'seed' && e.outcome.kind === 'rejected');
    assert.deepEqual(rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? rejected.outcome.issues.map((i) => [i.code, i.path, i.found]) : [], [
      ['plan.seed_mix_off', ['plan', 'seed', 'stateMix', 'ticket', 'open'], '4 of 12 rows'],
      ['plan.seed_mix_off', ['plan', 'seed', 'stateMix', 'ticket', 'pending'], '6 of 12 rows'],
    ]);
  });

  it('accepts the same seed when stateMix matches it within 10 points', async () => {
    const { result, events } = await run([
      { input: withMix({ ticket: { open: 35, pending: 50, resolved: 15 } }) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events).map(([step, , outcome]) => [step, outcome]), [['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'accepted']]);
  });
});

describe('runWorldGen sends a frozen test the workflow stage keeps failing back to the plan (A-161)', () => {
  // Live rehearsal L2: the plan froze a test asserting not_found, and the engine answers an unknown id with row.not_found.
  const unknownTicket = (code: string) => ({
    id: 'unknown_ticket_404',
    intent: 'An unknown ticket id is a 404.',
    actions: ['resolve_ticket'],
    description: 'an unknown ticket is not found',
    script: `(ctx) => { const r = ctx.api('GET', '/tickets/tkt_9999'); ctx.assert(r.status === 404 && JSON.stringify(r.body).includes('"${code}"'), 'unknown ticket: ' + JSON.stringify(r)); }`,
  });
  const planWith = (code: string, revision: number) => ({ ...PLAN, revision, acceptanceTests: [...PLAN.acceptanceTests, unknownTicket(code)] });

  it('backtracks to plan after the second identical failure, and finishes once the plan asserts the engine code', async () => {
    const { result, events, calls } = await run([
      { input: planWith('not_found', 1) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.workflow },
      { input: planWith('row.not_found', 2) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ]);
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events).map(([step, , outcome]) => [step, outcome]), [
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'rejected'], ['workflow', 'rejected'],
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'accepted'],
    ]);
    const back = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(back?.t === 'backtracked' ? [back.from, back.to, back.because.map((i) => [i.code, i.path])] : [], [
      'workflow', 'plan', [['test.failed', ['tests', 'unknown_ticket_404', 'script']]],
    ]);
    assert.equal(calls[4]?.prompt.includes('row.not_found'), true);
  });

  it('maps each frozen test to the planned operations it exercises: declared action routes and literal ctx.api paths (A-406)', () => {
    const plan = {
      ...PLAN, revision: 1, changes: [],
      routes: [...PLAN.routes, { id: 'resolve_ticket', method: 'post', path: '/tickets/{id}/resolve', purpose: 'resolve' }],
      acceptanceTests: [
        ...PLAN.acceptanceTests,
        { id: 'declared', intent: 'i', actions: ['resolve_ticket'], description: 'd', script: '(ctx) => {}' },
        { id: 'annotated', intent: 'i', actions: ['resolve_ticket (POST /tickets/{id}/resolve)'], description: 'd', script: '(ctx) => {}' },
        { id: 'literal', intent: 'i', actions: ['escalate_ticket'], description: 'd', script: "(ctx) => { ctx.api('GET', '/tickets/tkt_0001'); ctx.api('GET', '/customers?q=Acme'); }" },
        { id: 'built', intent: 'i', actions: ['escalate_ticket'], description: 'd', script: "(ctx) => { const id = 'tkt_0001'; ctx.api('GET', '/tickets/' + id); }" },
      ],
    };
    const mine = new Set(['declared', 'annotated', 'literal', 'built']);
    assert.deepEqual([...testOperations(planSchemaFor('description').parse(plan))].filter(([id]) => mine.has(id)), [
      ['declared', ['POST /tickets/{}/resolve']], ['annotated', ['POST /tickets/{}/resolve']], ['literal', ['GET /customers', 'GET /tickets/{}']], ['built', []],
    ]);
  });

  // stress-8 petstore-store (A-406): one workflow answer failed a frozen test, the next a check the input fixes, and back.
  const specOff = { ...EDITS.workflow, note: 'the actions with the escalate reason optional', upsert: { ...EDITS.workflow.upsert, actions: { ...TARGET.actions, escalate_ticket: { ...TARGET.actions.escalate_ticket!, description: 'Make an unresolved ticket urgent (reason optional).' } } } };
  // A stand-in for petstore's spec check, on the operation the frozen test unknown_ticket_404 exercises (GET /tickets/tkt_9999).
  const reasonOptional = issue('openapi.required_field_missing', ['input', 'openapi', 'GET /tickets/{ticket_id}', 'request', 'reason'], { op: 'GET /tickets/{ticket_id}', field: 'reason' }, 'reason is optional');
  /** As the conformance check refuses petstore's optional petId: a world whose escalate reason is optional fails the source spec. */
  const specCheck = (world: World): CheckReport =>
    world.actions.escalate_ticket?.description?.includes('(reason optional)') === true ? { ok: false, reached: 'lints', issues: [reasonOptional], warnings: [] } : checkWorld(world);

  // J191 (e3's follow-up on #179): the plan is shown only the failing tests of the operation the input check names.
  const teapot = { id: 'customers_teapot', intent: 'Customers answer 418.', actions: ['resolve_ticket'], description: 'customers are a teapot',
    script: "(ctx) => { const r = ctx.api('GET', '/customers'); ctx.assert(r.status === 418, 'customers: ' + r.status); }" };

  it('hands the plan only the failing frozen tests of the traded operation, never one of another operation (J191)', async () => {
    const withTeapot = { ...planWith('not_found', 1), acceptanceTests: [...planWith('not_found', 1).acceptanceTests, teapot] };
    const { result, events } = await run([
      { input: withTeapot }, { input: EDITS.model }, { input: specOff }, { input: EDITS.workflow }, { input: specOff },
      { input: planWith('row.not_found', 2) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ], { check: specCheck });
    const failedTests = events.flatMap((e) => (e.t === 'attempt' && e.step === 'workflow' && e.outcome.kind === 'rejected' ? e.outcome.issues.filter((i) => i.code === 'test.failed').map((i) => i.path[1]) : []));
    assert.deepEqual(failedTests, ['unknown_ticket_404', 'customers_teapot']);
    const back = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(back?.t === 'backtracked' ? back.because.map((i) => [i.code, i.path]) : [], [
      ['openapi.required_field_missing', ['input', 'openapi', 'GET /tickets/{ticket_id}', 'request', 'reason']], ['test.failed', ['tests', 'unknown_ticket_404', 'script']],
    ]);
    assert.equal(result.kind, 'done');
  });

  it('narrows the deciding attempt\'s own failing tests for the plan when the tests side decides the trade, and keeps them whole for the rerun (J192)', async () => {
    const withTeapot = { ...planWith('not_found', 1), acceptanceTests: [...planWith('not_found', 1).acceptanceTests, teapot] };
    const { result, events, calls } = await run([
      { input: withTeapot }, { input: EDITS.model }, { input: EDITS.workflow }, { input: specOff }, { input: EDITS.workflow },
      { input: planWith('row.not_found', 2) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ], { check: specCheck });
    const back = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(back?.t === 'backtracked' ? [back.from, back.to, back.because.map((i) => [i.code, i.path])] : [], [
      'workflow', 'plan', [['test.failed', ['tests', 'unknown_ticket_404', 'script']], ['openapi.required_field_missing', ['input', 'openapi', 'GET /tickets/{ticket_id}', 'request', 'reason']]],
    ]);
    assert.deepEqual(['unknown_ticket_404', 'customers: 200'].map((s) => calls[5]?.prompt.includes(s)), [true, false]);
    // The workflow rerun is shown its own last rejection whole, the teapot failure included.
    assert.equal(calls[7]?.prompt.includes('customers: 200'), true);
    assert.equal(result.kind, 'done');
  });

  it('tells the plan the deciding attempt\'s failing tests whole when the check names only a nested sub-operation, never none (J192 review, J193)', async () => {
    // 66's block on #198: a prefix match once traded GET /tickets/{} against a check on the nested GET /tickets/{ticket_id}/events, and an
    // unguarded narrowing then left the plan no issues. Since J193 the two are no trade, so the frozen tests go back to the plan whole (A-161).
    const nested = issue('openapi.required_field_missing', ['input', 'openapi', 'GET /tickets/{ticket_id}/events', 'request', 'reason'], { op: 'GET /tickets/{ticket_id}/events', field: 'reason' }, 'reason is optional');
    const nestedCheck = (world: World): CheckReport =>
      world.actions.escalate_ticket?.description?.includes('(reason optional)') === true ? { ok: false, reached: 'lints', issues: [nested], warnings: [] } : checkWorld(world);
    const withTeapot = { ...planWith('not_found', 1), acceptanceTests: [...planWith('not_found', 1).acceptanceTests, teapot] };
    const { result, events } = await run([
      { input: withTeapot }, { input: EDITS.model }, { input: EDITS.workflow }, { input: specOff }, { input: EDITS.workflow },
      { input: planWith('row.not_found', 2) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ], { check: nestedCheck });
    const back = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(back?.t === 'backtracked' ? [back.from, back.to, back.because.map((i) => String(i.path[1]))] : [], ['workflow', 'plan', ['unknown_ticket_404', 'customers_teapot']]);
    assert.equal(result.kind, 'done');
  });

  // J193: a trade compares whole operations (A-406), and the plan sees only the input issues of the traded operation (A-416).
  const eventsReasonOptional = issue('openapi.required_field_missing', ['input', 'openapi', 'GET /tickets/{ticket_id}/events', 'request', 'reason'], { op: 'GET /tickets/{ticket_id}/events', field: 'reason' }, 'reason is optional');
  const customersEmailOptional = issue('openapi.required_field_missing', ['input', 'openapi', 'POST /customers', 'request', 'email'], { op: 'POST /customers', field: 'email' }, 'email is optional');
  /** specCheck with other input issues: the world with an optional escalate reason fails each of `issues`. */
  const checkWith = (...issues: [CheckIssue, ...CheckIssue[]]) => (world: World): CheckReport =>
    world.actions.escalate_ticket?.description?.includes('(reason optional)') === true ? { ok: false, reached: 'lints', issues, warnings: [] } : checkWorld(world);

  it('stops, not trades, when the input check names a nested sub-operation of what the failing test exercises (J193)', async () => {
    const { result, events } = await run([
      { input: planWith('not_found', 1) }, { input: EDITS.model }, { input: specOff }, { input: EDITS.workflow }, { input: specOff },
    ], { check: checkWith(eventsReasonOptional) });
    assert.equal(events.some((e) => e.t === 'backtracked'), false);
    assert.deepEqual(result.kind === 'stopped' ? [result.reason.kind, result.reason.kind === 'no_progress' ? result.reason.step : null] : result.kind, ['no_progress', 'workflow']);
  });

  it('when the input side decides the trade, hands the plan only the input issues of the traded operation, never another\'s (J193, A-416)', async () => {
    const { result, events } = await run([
      { input: planWith('not_found', 1) }, { input: EDITS.model }, { input: specOff }, { input: EDITS.workflow }, { input: specOff },
      { input: planWith('row.not_found', 2) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ], { check: checkWith(reasonOptional, customersEmailOptional) });
    const back = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(back?.t === 'backtracked' ? [back.from, back.to, back.because.map((i) => [i.code, i.path])] : [], [
      'workflow', 'plan', [['openapi.required_field_missing', ['input', 'openapi', 'GET /tickets/{ticket_id}', 'request', 'reason']], ['test.failed', ['tests', 'unknown_ticket_404', 'script']]],
    ]);
    assert.equal(result.kind, 'done');
  });

  it('backtracks to plan when workflow trades a frozen test against a check the input fixes, and tells the plan both (A-406)', async () => {
    const { result, events, calls } = await run([
      { input: planWith('not_found', 1) }, { input: EDITS.model }, { input: specOff }, { input: EDITS.workflow }, { input: specOff },
      { input: planWith('row.not_found', 2) }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ], { check: specCheck });
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events).map(([step, , outcome]) => [step, outcome]), [
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'rejected'], ['workflow', 'rejected'], ['workflow', 'rejected'],
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'accepted'],
    ]);
    const back = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(back?.t === 'backtracked' ? [back.from, back.to, back.because.map((i) => [i.code, i.path])] : [], [
      'workflow', 'plan', [['openapi.required_field_missing', ['input', 'openapi', 'GET /tickets/{ticket_id}', 'request', 'reason']], ['test.failed', ['tests', 'unknown_ticket_404', 'script']]],
    ]);
    assert.deepEqual(['reason is optional', 'ctx.assert failed'].map((s) => calls[5]?.prompt.includes(s)), [true, true]);
    // The workflow rerun is shown its own last rejection, the spec check, not the old plan's test failure.
    assert.deepEqual(['reason is optional', 'ctx.assert failed'].map((s) => calls[7]?.prompt.includes(s)), [true, false]);
  });
});

describe('runWorldGen gates a description that names a fidelity reference at the last step (A-258)', () => {
  const HELPDESK_SLA = join(import.meta.dirname, '../../eval/fidelity/helpdesk-sla.yaml');

  it('rejects the finished world below the 0.80 floor and sends the misses back to the model stage', async () => {
    const { result, events } = await run([...HAPPY, new ModelError('stop after the fidelity rejection')], {
      input: { kind: 'description', text: 'A helpdesk like Zendesk', fidelity: HELPDESK_SLA },
    });
    assert.equal(result.kind, 'stopped');
    assert.deepEqual(attempts(events).map(([step, , outcome]) => [step, outcome]), [
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'rejected'], ['model', 'model_error'],
    ]);
    const rejected = events.find((e) => e.t === 'attempt' && e.step === 'tasks' && e.outcome.kind === 'rejected');
    const issues = rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? rejected.outcome.issues : [];
    assert.equal(issues.length > 0 && issues.every((i) => i.code === 'fidelity.below_floor'), true);
    assert.equal(issues[0]?.expected.includes('fidelity to the frozen reference is 0.3944, below the floor of 0.8'), true);
    const back = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(back?.t === 'backtracked' ? [back.from, back.to] : [], ['tasks', 'model']);
  });

  it('the same run without a reference finishes, so the gate is what refused it', async () => {
    const { result } = await run(HAPPY);
    assert.equal(result.kind, 'done');
  });
});

describe('runWorldGen original input contracts', () => {
  it('rejects an undersized CSV seed at the seed step, before any task exists', async () => {
    const customers = [
      { name: 'Acme', tier: 'enterprise' }, { name: 'Globex', tier: 'pro' }, { name: 'Initech', tier: 'pro' },
      { name: 'Umbrella', tier: 'free' }, { name: 'Hooli', tier: 'free' }, { name: 'Stark', tier: 'enterprise' },
    ];
    const digest: InputDigest = { kind: 'csv', summary: 'Imported customers', fixtures: { customers },
      operations: [], observations: [], apiShape: null };
    const undersized = { note: 'Import customers', upsert: { seed: { ...TARGET.seed, customer: '(ctx) => ctx.fixtures.customers.slice(0, 5)' } } };
    const full = { note: 'Import every customer', upsert: { seed: { ...TARGET.seed, customer: '(ctx) => ctx.fixtures.customers' } } };
    // The plan keeps the imported table at its 6 rows: padding it would be refused at the plan step (A-221).
    const imported = { ...PLAN, seed: { ...PLAN.seed, rowsPerEntity: { ...PLAN.seed.rowsPerEntity, customer: 6 } } };
    const { result, events, filesDir } = await run([
      { input: imported }, { input: EDITS.model }, { input: EDITS.workflow }, { input: undersized }, { input: full },
      new ModelError('stop after the repaired seed is accepted'),
    ], { digest });
    assert.equal(result.kind, 'stopped');
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
    assert.deepEqual(attempts(events).slice(0, 5), [
      ['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'],
      ['seed', 1, 'rejected'], ['seed', 2, 'accepted'],
    ]);
    const rejected = events.find((e) => e.t === 'attempt' && e.step === 'seed' && e.outcome.kind === 'rejected');
    assert.deepEqual(rejected?.t === 'attempt' && rejected.outcome.kind === 'rejected' ? brief(rejected.outcome.issues) : [], [
      ['plan.not_covered', ['seed', 'customer']],
    ]);
  });

  it('repairs an omitted OpenAPI operation: the plan step names it first (YOS-244), then the model step builds it', async () => {
    const digest: InputDigest = { kind: 'openapi', summary: 'Imported helpdesk', fixtures: {},
      operations: [{ method: 'DELETE', path: '/imports/{id}' }], observations: [], apiShape: null };
    const repaired = { note: 'Include the input operation', upsert: {
      ...EDITS.model.upsert,
      routes: { ...TARGET.routes, delete_import: { method: 'DELETE', path: '/imports/{id}', op: 'delete', entity: 'customer' } },
    } };
    const planned = { ...PLAN, routes: [...PLAN.routes, { id: 'delete_import', method: 'DELETE', path: '/imports/{id}', purpose: 'remove an import' }] };
    const { result, events, outDir } = await run([
      { input: PLAN }, { input: planned }, { input: EDITS.model }, { input: repaired },
      { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ], { digest });
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events), [
      ['plan', 1, 'rejected'], ['plan', 2, 'accepted'], ['model', 1, 'rejected'], ['model', 2, 'accepted'],
      ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted'],
    ]);
    const rejected = events.filter((e) => e.t === 'attempt' && e.outcome.kind === 'rejected')
      .map((e) => (e.t === 'attempt' && e.outcome.kind === 'rejected' ? brief(e.outcome.issues) : []));
    assert.deepEqual(rejected, [
      [['plan.not_covered', ['plan', 'routes', 'DELETE /imports/{id}']]],
      [['plan.not_covered', ['plan', 'routes', 3]], ['plan.not_covered', ['routes', 'DELETE /imports/{id}']]],
    ]);
    const saved = await loadWorld(outDir);
    const checked = saved.ok ? checkWorld(saved.value) : null;
    assert.equal(checked?.ok && checked.world.routes.delete_import?.path, '/imports/{id}');
  });
});

describe('runWorldGen create: stops', () => {
  it('stops with attempts_exhausted after the step budget, with no world.yaml', async () => {
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { model: { maxAttempts: 2 } } });
    const { result, events, filesDir } = await run([{ input: PLAN }, { input: BAD_ENTITY }, { input: BAD_FILTER }], { config });
    assert.equal(result.kind, 'stopped');
    if (result.kind !== 'stopped' || result.reason.kind !== 'attempts_exhausted') throw new Error('expected attempts_exhausted');
    assert.deepEqual([result.reason.step, result.reason.attempts, brief(result.reason.lastIssues)], [
      'model', 2, [['ref.unknown', ['routes', 'list_tickets', 'filters', 0]]],
    ]);
    assert.equal(result.costUsd, 0.375);
    assert.deepEqual(kinds(events).slice(-3), ['attempt', 'attempt', 'run_finished']);
    const last = events[events.length - 1];
    assert.equal(last?.t === 'run_finished' && last.worldWritten, false);
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
  });

  it('stops with no_progress when the same issues come back', async () => {
    const { result } = await run([{ input: PLAN }, { input: BAD_ENTITY }, { input: BAD_ENTITY }]);
    assert.equal(result.kind === 'stopped' && result.reason.kind === 'no_progress' ? result.reason.repeatedIssueSet : null, 'ref.unknown@routes/get_ticket/entity: "*"');
  });

  it('stops with model_error and charges what the failed call billed', async () => {
    const billed = new ModelError('model did not call tool "edit_world" (stop_reason: end_turn)', undefined, { usage: USAGE, costUsd: 0.5, ms: 10 });
    const { result, events, filesDir } = await run([{ input: PLAN }, { input: EDITS.model }, billed]);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'model_error', message: 'model did not call tool "edit_world" (stop_reason: end_turn)' });
    assert.equal(result.costUsd, 0.75);
    const failed = events.find((e) => e.t === 'attempt' && e.outcome.kind === 'model_error');
    assert.deepEqual(failed?.t === 'attempt' ? [failed.step, failed.costUsd, failed.ms] : null, ['workflow', 0.5, 10]);
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
  });

  it('stops with stage_time_exhausted, not model_error, when the transport kills a call at its step share', async () => {
    // The seed call outlives its share: the transport killed it itself and says so. The share is the request's own timeoutMs.
    const outlived = (req: ProposeRequest): Reply => new StepShareExpired(req.timeoutMs ?? -1, 276_500, SILENT, 0);
    const { result, events, filesDir } = await run([{ input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, outlived]);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'stage_time_exhausted', step: 'seed', shareMs: 740_000 });
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'share_expired']]);
    assert.deepEqual(kinds(events).slice(-3), ['step_started', 'attempt', 'run_finished']);
    assert.equal(events.some((e) => (e.t === 'attempt' && e.outcome.kind === 'model_error') || (e.t === 'run_finished' && e.result.kind === 'stopped' && e.result.reason.kind === 'model_error')), false);
    const killed = events.find((e) => e.t === 'attempt' && e.step === 'seed');
    assert.deepEqual(killed?.t === 'attempt' ? [killed.outcome, killed.ms, killed.costUsd] : null,
      [{ kind: 'share_expired', shareMs: 740_000, progress: { messages: 0, outputTokens: 0, schemaRetries: 0, outputBytes: 0 } }, 276_500, null]);
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
    const stop = result.kind === 'stopped' ? result.reason : null;
    const text = renderReport({ events, ...(stop === null ? {} : { stop }) });
    assert.deepEqual(text.split('\n').slice(0, 5), [
      'Stopped: stage_time_exhausted',
      '',
      'The seed call sent nothing before its 740 s share ran out, so the run stopped. Raise maxMinutes, or lower the seed effort in stepModels.',
      '',
      'No world.yaml was written.',
    ]);
  });

  it('retains partial plan usage with unknown billing while REPORT.md says it was still writing', async () => {
    const streamed = { inputTokens: 4, outputTokens: 17873, cacheReadTokens: 86706, cacheWriteTokens: 18971 };
    const outlived = (req: ProposeRequest): Reply => new StepShareExpired(req.timeoutMs ?? -1, 377_984, { messages: 2, schemaRetries: 1, usage: streamed, outputBytes: 7285 }, 0.25);
    const { result, events, filesDir } = await run([outlived]);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'stage_time_exhausted', step: 'plan', shareMs: 553_500 });
    const killed = events.find((e) => e.t === 'attempt');
    assert.deepEqual(killed?.t === 'attempt' ? [killed.step, killed.outcome, killed.usage, killed.costUsd, killed.ms] : null,
      ['plan', { kind: 'share_expired', shareMs: 553_500, progress: { messages: 2, outputTokens: 17873, schemaRetries: 1, outputBytes: 7285 } }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, null, 377_984]);
    assert.equal(result.costUsd, 0);
    assert.equal(result.kind === 'stopped' ? result.unknownCostCalls : undefined, 1);
    assert.deepEqual(killed?.t === 'attempt' ? killed.partialModelUsage : undefined, { ...streamed, observedCostUsd: 0.25 });
    const dump = JSON.parse(readFileSync(join(filesDir, killed?.t === 'attempt' ? killed.dump : ''), 'utf8')) as Record<string, unknown>;
    assert.equal(dump['costUsd'], null);
    assert.deepEqual(dump['partialModelUsage'], { ...streamed, observedCostUsd: 0.25 });
    assert.deepEqual(report(filesDir).split('\n').slice(0, 5), [
      'Stopped: stage_time_exhausted',
      '',
      'The plan call was still writing when its 554 s share ran out (2 messages, 17,873 output tokens and 7,285 answer bytes so far, 1 schema retry by the CLI), so the run stopped. Raise maxMinutes, or lower the plan effort in stepModels.',
      '',
      'No world.yaml was written.',
    ]);
  });

  it('stops after an unresolved stalled call without retrying the paid work', async () => {
    const { result, events, calls } = await run([new CallStalled(120_000, 121_000), ...HAPPY]);
    assert.equal(result.kind, 'stopped');
    assert.equal(result.kind === 'stopped' ? result.unknownCostCalls : undefined, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(attempts(events), [['plan', 1, 'stalled']]);
    const first = events.find((e) => e.t === 'attempt');
    assert.deepEqual(first?.t === 'attempt' ? [first.outcome, first.ms, first.costUsd] : null, [{ kind: 'stalled', idleMs: 120_000, progress: { messages: 0, outputTokens: 0, schemaRetries: 0, outputBytes: 0 } }, 121_000, null]);
    assert.deepEqual(events.filter((e) => e.t === 'stall_retry'), []);
    assert.equal(result.costUsd, 0);
  });

  it('stops with transport_stalled before a second stalled call, and REPORT.md names unresolved billing', async () => {
    const { result, events, calls, filesDir } = await run([new CallStalled(120_000, 121_000), new CallStalled(120_000, 121_000), ...HAPPY]);
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'transport_stalled', step: 'plan', idleMs: 120_000 });
    assert.equal(calls.length, 1);
    assert.deepEqual(attempts(events), [['plan', 1, 'stalled']]);
    assert.equal(events.filter((e) => e.t === 'stall_retry').length, 0);
    assert.equal(result.costUsd, 0);
    assert.deepEqual(report(filesDir).split('\n').slice(0, 5), [
      'Stopped: transport_stalled',
      '',
      'The claude CLI went silent for 120 s on the plan step. The run stopped with unknown billing; reconcile the interrupted charge before resuming.',
      '',
      'No world.yaml was written.',
    ]);
    assert.equal(describeStop({ kind: 'transport_stalled', step: 'plan', idleMs: 120_000 }), 'transport_stalled: the claude CLI went silent for 120 s on the plan step; billing is unknown');
  });

  it('stops with budget_exhausted once spend reaches maxCostUsd before the last step', async () => {
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 0.25, maxOutputTokens: 100 });
    const { result, events, calls, filesDir } = await run(HAPPY, { config });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'budget_exhausted', spentUsd: 0.25, limitUsd: 0.25 });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.maxCostUsd), [0.25, 0.125]);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted']]);
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
  });

  it('refuses a call whose estimated cost does not fit, before spending anything', async () => {
    // A full 16k-token sonnet reply alone is $0.16, more than the $0.15 budget.
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 0.15 });
    const { result, events, calls, filesDir } = await run(HAPPY, { config });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'budget_exhausted', spentUsd: 0, limitUsd: 0.15 });
    assert.equal(calls.length, 0);
    assert.deepEqual(attempts(events), []);
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
  });

  it('refuses a call that cannot finish in the time left, before making it, and logs the estimate', async () => {
    // The plan step's first call is estimated at its measured 206 s (A-311); a 1-minute run has less than that left.
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 1 });
    const { result, events, calls, filesDir } = await run(HAPPY, { config });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'time_exhausted', minutes: 1, refused: { step: 'plan', estimateMs: 206_000, remainingMs: 56_000 } });
    assert.equal(calls.length, 0);
    const refused = events.find((e) => e.t === 'call_refused');
    assert.equal(refused?.t === 'call_refused' ? refused.estimateMs : null, 206_000);
    assert.equal(refused?.t === 'call_refused' ? refused.step : null, 'plan');
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
  });

  it('gives every call its step share of the run time left as its hard timeout', async () => {
    const { calls } = await run(HAPPY);
    assert.equal(calls.length, 5);
    assert.ok(calls.every((c) => typeof c.timeoutMs === 'number' && c.timeoutMs > 0 && c.timeoutMs <= 15 * 60_000));
    // Each call's timeout is the run's time left minus the later steps' next-call estimates (A-311): 900 s minus the reserves
    // 342.5, 316.5, 255, 132 and 0 s, minus the fake clock's elapsed seconds.
    // Tasks has no later reserve, so its 864 s share would end with the run: its timeout is the 863 s left when the call starts, less the 15 s grace.
    assert.deepEqual(calls.map((c) => c.timeoutMs), [553_500, 571_500, 625_000, 740_000, 848_000]);
  });

  it('refuses a call that would eat the time reserved for the later steps, before making it', async () => {
    // Tasks reserves 90% of the 15 minutes, so plan has no share left.
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { tasks: { reserve: 0.9 } } });
    const { result, events, calls } = await run(HAPPY, { config });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'stage_time_exhausted', step: 'plan', shareMs: 0 });
    assert.equal(calls.length, 0);
    assert.equal(events.some((e) => e.t === 'call_refused' && e.reason.kind === 'stage_time_exhausted'), true);
  });
});

describe('runWorldGen create: the hard run deadline', () => {
  const realSetTimeout = globalThis.setTimeout;
  const bounded = <T>(p: Promise<T>, what: string): Promise<T> => {
    let guard: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, rej) => { guard = realSetTimeout(() => rej(new Error(`${what} did not settle within 5 s`)), 5000); });
    return Promise.race([p, late]).finally(() => clearTimeout(guard));
  };
  const timeouts = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  /**
   * A model whose call number `hangAt` (1-based) never settles; the calls before it answer from HAPPY.
   * Resolves `inFlight` once the hanging call is made, and `release` settles it late.
   */
  function hangingModel(hangAt: number) {
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    let release!: (p: Awaited<ReturnType<Model['propose']>>) => void;
    let n = 0;
    const model: Model = {
      propose: async () => {
        n += 1;
        const reply = HAPPY[n - 1];
        if (n < hangAt && reply !== undefined && typeof reply !== 'function' && 'input' in reply) {
          return { input: reply.input, advice: [], usage: USAGE, costUsd: 0.125, ms: 1000 };
        }
        started();
        return new Promise((r) => { release = r; });
      },
    };
    return { model, inFlight, release: (p: Awaited<ReturnType<Model['propose']>>) => release(p) };
  }
  const startRun = (model: Model, outDir: string, events: RunEvent[]) => {
    let t = T0;
    return runWorldGen(
      { kind: 'create', input: { kind: 'description', text: 'A helpdesk where overdue tickets escalate' }, outDir },
      CONFIG,
      { model, exampleWorld: minimalWorld(), emit: (e) => events.push(e), now: () => (t += 1000), runId: 'run_test' },
    );
  };

  it('abandons a call that never settles at its step share plus the grace, records share_expired, and the late reply changes nothing', async () => {
    const outDir = newOutDir();
    const events: RunEvent[] = [];
    const hung = hangingModel(1);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const running = startRun(hung.model, outDir, events);
      await bounded(hung.inFlight, 'the first model call');
      // The plan share is 553.5 s (A-311); 15 s of grace later the run gives up on the call, long before the 15-minute deadline.
      mock.timers.tick(568_500);
      await new Promise<void>((resolve) => setImmediate(resolve));
      mock.timers.tick(2000);
      const result = await bounded(running, 'runWorldGen');
      assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'stage_time_exhausted', step: 'plan', shareMs: 553_500 });
      assert.deepEqual(attempts(events), [['plan', 1, 'share_expired']]);
      const attempt = events.find((e) => e.t === 'attempt');
      assert.deepEqual(attempt?.t === 'attempt' ? [attempt.outcome, attempt.costUsd, attempt.usage] : null,
        [{ kind: 'share_expired', shareMs: 553_500, progress: null }, null, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
      assert.equal(renderReport({ events, stop: { kind: 'stage_time_exhausted', step: 'plan', shareMs: 553_500 } }).split('\n')[2],
        'The plan call did not return before its 554 s share ran out, so the run stopped. Raise maxMinutes, or lower the plan effort in stepModels.');
      const seen = events.length;
      hung.release({ input: PLAN, advice: ['late'], usage: USAGE, costUsd: 0.125, ms: 1000 });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(events.length, seen);
      assert.equal(result.costUsd, 0);
      assert.equal(existsSync(join(result.dir, 'world.yaml')), false);
      assert.equal(existsSync(join(result.dir, 'plan.yaml')), false);
    } finally {
      mock.timers.reset();
    }
  });

  it('stops with time_exhausted when the last step call never settles, since its share is all the run has left', async () => {
    const outDir = newOutDir();
    const events: RunEvent[] = [];
    const hung = hangingModel(5);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const running = startRun(hung.model, outDir, events);
      await bounded(hung.inFlight, 'the tasks call');
      mock.timers.tick(15 * 60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      mock.timers.tick(2000);
      const result = await bounded(running, 'runWorldGen');
      assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'time_exhausted', minutes: 15 });
      const last = events[events.length - 1];
      assert.deepEqual(last?.t === 'run_finished' ? last.result : null, { kind: 'stopped', reason: { kind: 'time_exhausted', minutes: 15 } });
      assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted']]);
      const seen = events.length;
      hung.release({ input: EDITS.tasks, advice: ['late'], usage: USAGE, costUsd: 0.125, ms: 1000 });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      assert.equal(events.length, seen);
      assert.equal(existsSync(join(result.dir, 'world.yaml')), false);
    } finally {
      mock.timers.reset();
    }
  });

  it('records partial tasks usage with unknown billing when transport timeout precedes the run deadline', async () => {
    const outDir = newOutDir();
    const events: RunEvent[] = [];
    const streamed = { inputTokens: 4, outputTokens: 17873, cacheReadTokens: 86706, cacheWriteTokens: 18971 };
    let n = 0;
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    // The tasks call behaves like claude -p killed at its timeoutMs: SIGTERM, then 5 s until the process is gone and the cut is billed.
    const model: Model = {
      propose: async (req) => {
        n += 1;
        const reply = HAPPY[n - 1];
        if (n < 5 && reply !== undefined && typeof reply !== 'function' && 'input' in reply) {
          return { input: reply.input, advice: [], usage: USAGE, costUsd: 0.125, ms: 1000 };
        }
        const killedAt = (req.timeoutMs ?? -1) + 5000;
        started();
        return new Promise((_, reject) => {
          setTimeout(() => reject(new StepShareExpired(req.timeoutMs ?? -1, killedAt, { messages: 2, schemaRetries: 1, usage: streamed, outputBytes: 7285 }, 0.25)), killedAt);
        });
      },
    };
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const running = startRun(model, outDir, events);
      await bounded(inFlight, 'the tasks call');
      let settled = false;
      void running.finally(() => { settled = true; });
      for (let s = 0; s < 15 * 60 && !settled; s += 1) {
        mock.timers.tick(1000);
        await new Promise<void>((r) => setImmediate(r));
      }
      const result = await bounded(running, 'runWorldGen');
      assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'stage_time_exhausted', step: 'tasks', shareMs: 848_000 });
      assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'share_expired']]);
      const killed = events.find((e) => e.t === 'attempt' && e.step === 'tasks');
      assert.deepEqual(killed?.t === 'attempt' ? [killed.outcome, killed.usage, killed.costUsd, killed.ms] : null,
        [{ kind: 'share_expired', shareMs: 848_000, progress: { messages: 2, outputTokens: 17873, schemaRetries: 1, outputBytes: 7285 } }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, null, 853_000]);
      assert.equal(result.costUsd, 0.5);
      assert.equal(result.kind === 'stopped' ? result.unknownCostCalls : undefined, 1);
      assert.deepEqual(killed?.t === 'attempt' ? killed.partialModelUsage : undefined, { ...streamed, observedCostUsd: 0.25 });
      assert.deepEqual(report(result.dir).split('\n').slice(0, 3), [
        'Stopped: stage_time_exhausted',
        '',
        'The tasks call was still writing when its 848 s share ran out (2 messages, 17,873 output tokens and 7,285 answer bytes so far, 1 schema retry by the CLI), so the run stopped. Raise maxMinutes, or lower the tasks effort in stepModels.',
      ]);
    } finally {
      mock.timers.reset();
    }
  });

  it('gives a tasks call the time left, not the margined timeout, when the margin would cut below its estimate', async () => {
    const outDir = newOutDir();
    const events: RunEvent[] = [];
    const calls: ProposeRequest[] = [];
    let t = T0;
    let n = 0;
    // The seed call takes 723 s of fake time, so tasks starts with 140 s left: its 132 s estimate fits, but 140 - 15 = 125 s would not, so it gets all 140 s.
    const model: Model = {
      propose: async (req) => {
        calls.push(req);
        n += 1;
        if (n === 4) t += 723_000;
        const reply = HAPPY[n - 1];
        if (reply === undefined || typeof reply === 'function' || !('input' in reply)) throw new Error(`no reply for call ${n}`);
        return { input: reply.input, advice: [], usage: USAGE, costUsd: 0.125, ms: 1000 };
      },
    };
    const result = await runWorldGen(
      { kind: 'create', input: { kind: 'description', text: 'A helpdesk where overdue tickets escalate' }, outDir },
      CONFIG,
      { model, exampleWorld: minimalWorld(), emit: (e) => events.push(e), now: () => (t += 1000), runId: 'run_test' },
    );
    assert.equal(result.kind, 'done');
    assert.deepEqual(calls.map((c) => c.timeoutMs).slice(-1), [140_000]);
    assert.deepEqual(events.filter((e) => e.t === 'call_refused'), []);
  });

  it('leaves a call that settles before the deadline alone, and leaves no timer running', async () => {
    const before = timeouts();
    const { result, events } = await run(HAPPY);
    assert.equal(result.kind, 'done');
    assert.deepEqual(kinds(events), HAPPY_EVENTS);
    assert.equal(timeouts(), before);
  });
});

describe('runWorldGen create: model and effort per step', () => {
  it('runs a configured override model on every step it covers, and a step pin on its own step, with no fallback (A-283)', async () => {
    const config = configSchema.parse({ model: 'claude-opus-5-5', maxCostUsd: 5, stepModels: { seed: { model: 'claude-sonnet-5-5' } } });
    const { result, calls } = await run(HAPPY, { config });
    assert.equal(result.kind, 'done');
    assert.deepEqual(calls.map((c) => c.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('uses each step effort from config, and the escalation effort after a stall, always on the default model', async () => {
    const config = configSchema.parse({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      maxCostUsd: 5,
      stepModels: { plan: { model: 'claude-sonnet-5-5', effort: 'high' }, seed: { effort: 'low' } },
      escalate: { effort: 'max' },
    });
    // model stage: two rejections with one issue each (no fewer the second time) is a stall, so attempt 3 escalates.
    const script: Script = [{ input: PLAN }, { input: BAD_ENTITY }, { input: BAD_FILTER }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, calls } = await run(script, { config });
    assert.equal(result.kind, 'done');
    assert.deepEqual(calls.map((c) => [c.model, c.effort]), [
      ['claude-sonnet-5-5', 'high'],
      ['claude-sonnet-5-5', 'medium'],
      ['claude-sonnet-5-5', 'medium'],
      ['claude-sonnet-5-5', 'max'],
      ['claude-sonnet-5-5', 'medium'],
      ['claude-sonnet-5-5', 'low'],
      ['claude-sonnet-5-5', 'medium'],
    ]);
  });

  it('refuses a step or escalation model that is not a Claude model id when the config is parsed, so no step can pick it', () => {
    const r = configSchema.safeParse({
      model: 'claude-sonnet-5-5',
      maxCostUsd: 5,
      stepModels: { plan: { model: 'm-plan' } },
      escalate: { model: 'm-big', effort: 'max' },
    });
    const got = new Map(r.error?.issues.map((i) => [i.path.join('.'), i.message]));
    assert.equal(got.size, 2);
    assert.equal(got.get('stepModels.plan.model'), 'model "m-plan" is not a Claude model id such as claude-sonnet-5-5');
    assert.equal(got.get('escalate.model'), 'model "m-big" is not a Claude model id such as claude-sonnet-5-5');
  });

  it('does not escalate while each retry has fewer issues than the one before', async () => {
    const twoBad = { note: 'entities and routes', upsert: { entities: TARGET.entities, routes: { ...routesWith('get_ticket', { entity: 'tikket' }), list_tickets: { ...TARGET.routes['list_tickets'], filters: ['nope'] } } } };
    const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, escalate: { effort: 'max' } });
    const { calls } = await run([{ input: PLAN }, { input: twoBad }, { input: BAD_ENTITY }, { input: EDITS.model }, new ModelError('stop here')], { config });
    assert.deepEqual(calls.map((c) => c.effort), [undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('runWorldGen create: a retry sees the step\'s history (YOS-246, A-364)', () => {
  /** CUSTOMERS without its last row: 14 of the planned 15. */
  const SHORT = CUSTOMERS.replace("  { name: 'Massive Dynamic', tier: 'enterprise' },\n", '');
  const config = configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, stepModels: { seed: { effort: 'medium' } }, escalate: { effort: 'max' } });

  it('keeps the best full seed when a retry answers in part, lists every earlier attempt, and does not escalate', async () => {
    const nearlyRight = { note: 'customers and tickets', upsert: { seed: { ...TARGET.seed, customer: SHORT } } };
    const customersOnly = { note: 'one more customer', upsert: { seed: { customer: CUSTOMERS } } };
    const { result, events, calls } = await run([
      { input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: nearlyRight }, { input: customersOnly }, { input: EDITS.seed }, { input: EDITS.tasks },
    ], { config });
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events).filter((a) => a[0] === 'seed'), [['seed', 1, 'rejected'], ['seed', 2, 'rejected'], ['seed', 3, 'accepted']]);
    // Attempt 2 rose from no issue on ticket to one only because it left seed.ticket out: no escalation.
    assert.deepEqual(calls.slice(3, 6).map((c) => c.effort), ['medium', 'medium', 'medium']);
    const third = calls[5]?.prompt ?? '';
    assert.equal(third.includes('Your best answer so far (attempt 1):'), true);
    assert.equal(third.includes(JSON.stringify(SHORT)), true);
    assert.equal(third.includes('"note": "one more customer"'), false);
    assert.equal(third.includes('## Earlier attempts in this step'), true);
    assert.equal(third.includes([
      '- attempt 1: plan.seed_rows_short at plan.seed.rowsPerEntity.customer',
      '- attempt 2, which left seed.ticket untouched: plan.seed_rows_short at plan.seed.rowsPerEntity.ticket',
    ].join('\n')), true);
  });

  it('shows both earlier issue sets when a third answer could go back to the first (course-enrollments)', async () => {
    const { result, events, calls } = await run([{ input: PLAN }, { input: BAD_ENTITY }, { input: BAD_FILTER }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }], { config });
    assert.equal(result.kind, 'done');
    assert.deepEqual(attempts(events).filter((a) => a[0] === 'model'), [['model', 1, 'rejected'], ['model', 2, 'rejected'], ['model', 3, 'accepted']]);
    const third = calls[3]?.prompt ?? '';
    assert.equal(third.includes('## Earlier attempts in this step'), true);
    assert.equal(third.includes([
      '- attempt 1: ref.unknown at routes.get_ticket.entity',
      '- attempt 2: ref.unknown at routes.list_tickets.filters.0',
    ].join('\n')), true);
    // A tie keeps the latest answer, and two full answers with no fewer issues still escalate.
    assert.equal(third.includes('Your previous answer:'), true);
    assert.deepEqual(calls.slice(1, 4).map((c) => c.effort), [undefined, undefined, 'max']);
  });
});

describe('stage briefs name what the judge checks (YOS-45)', () => {
  /** PLAN with a custom route the resolve_ticket action claims, its action annotated with its route as real plans write it. */
  const ACTION_ROUTE_PLAN = {
    ...PLAN,
    routes: [...PLAN.routes, { id: 'resolve_ticket', method: 'POST', path: '/tickets/{id}/resolve', purpose: 'resolve a pending ticket' }],
    workflows: [{ ...PLAN.workflows[0]!, actions: ['resolve_ticket (POST /tickets/{id}/resolve)', 'escalate_ticket'] }],
  };
  const plan = planSchemaFor('description').parse(ACTION_ROUTE_PLAN);

  it('the model-stage prompt lists the exact entity and route keys the judge checks, and leaves the action route out', () => {
    const prompt = stagePrompt('model', plan, emptyWorld('w', 'worldgen'), null);
    assert.deepEqual(listed(prompt, 'Required keys'), ['- entities.customer', '- entities.ticket', '- routes.list_tickets', '- routes.get_ticket', '- routes.list_customers']);
    assert.deepEqual(listed(prompt, 'Action routes'), ['- resolve_ticket']);
    assert.equal(STAGES.model.brief.includes('A plan route whose id is also a workflow action name is an action route'), true);
  });

  it('tells the model stage to type an imported date-only column as a string with a date pattern, and only then (YOS-247)', () => {
    const fixtures = { enrollments: [{ student: 'S1', enrolled_on: '2026-08-28', paid_at: '2026-08-28T09:00:00Z' }, { student: 'S2', enrolled_on: '', paid_at: '2026-08-29T10:00:00Z' }] };
    const dated = { ...emptyWorld('w', 'worldgen'), fixtures };
    assert.deepEqual(listed(stagePrompt('model', plan, dated, null), 'Imported date-only columns'), [
      '- enrollments.enrolled_on holds dates with no time, such as 2026-08-28: type its field string with pattern ^\\d{4}-\\d{2}-\\d{2}$, never datetime, so the imported values seed unchanged.',
    ]);
    assert.equal(stagePrompt('model', plan, emptyWorld('w', 'worldgen'), null).includes('## Imported date-only columns'), false);
    assert.equal(stagePrompt('workflow', plan, dated, null).includes('## Imported date-only columns'), false);
  });

  it('plan coverage checks a claimed route as its action at the workflow stage, never as a route', () => {
    const noAction = { ...TARGET, actions: {}, tests: {} };
    assert.deepEqual(planCoverage(plan, noAction).map((i) => [i.path.join('.'), i.found]), [
      ['plan.workflows.0.actions.0', 'no actions.resolve_ticket'],
      ['plan.workflows.0.actions.1', 'no actions.escalate_ticket'],
      ['plan.acceptanceTests.0', 'no tests.resolve_pending_ticket'],
      ['plan.acceptanceTests.1', 'no tests.escalate_open_ticket'],
    ]);
    assert.deepEqual(planCoverage(plan, TARGET), []);
  });

  it('the seed brief tells the model to keep seed rows clear of the unique values tests create, which made 5 of 18 first-attempt rejections', () => {
    assert.equal(STAGES.seed.brief.includes('Tests run against the seeded world and create rows through the API. Read every script in tests and keep the seed rows away from the unique values (names, codes, skus, emails) those scripts create.'), true);
  });

  it('the workflow-stage prompt lists planned actions and the paths routes already own', () => {
    const prompt = stagePrompt('workflow', plan, TARGET, null);
    assert.deepEqual(listed(prompt, 'Required keys'), ['- actions.resolve_ticket (exists)', '- actions.escalate_ticket (exists)', '- jobs.escalate_overdue (exists)']);
    assert.equal(stepBrief('workflow', TARGET).includes('never edit, remove or replace a test'), true);
    assert.equal(prompt.includes('- POST /tickets (routes.create_ticket)'), true);
    assert.equal(prompt.includes('- PATCH /tickets/{id} (routes.update_ticket)'), true);
  });

  it('the workflow-stage brief states the route.duplicate_path rule with an example read from the helpdesk world', async () => {
    const loaded = await loadWorld(join(import.meta.dirname, '../../prod/worlds/helpdesk'));
    const report = checkWorld(loaded.ok ? loaded.value : null);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    const system = stepBrief('workflow', report.world);
    assert.equal(system.includes("an action's method and path, with every {param} segment counted as the same, must differ from every route's, or the engine raises route.duplicate_path"), true);
    assert.equal(system.includes('Example from the example world: routes.create_ticket declares POST /tickets, so no action may use POST /tickets. actions.assign_ticket uses POST /tickets/{id}/assign instead.'), true);
  });

  it('the brief rule is the one the engine enforces: params count as the same segment', () => {
    const clash = minimalWorld({ actions: { resolve_ticket: { ...TARGET.actions['resolve_ticket']!, method: 'PATCH', path: '/tickets/{ticket_id}' } } });
    const r = checkWorld(clash);
    assert.deepEqual(r.ok ? [] : r.issues.filter((i) => i.code === 'route.duplicate_path').map((i) => i.path), [['actions', 'resolve_ticket', 'path']]);
  });

  /**
   * A model that follows the prompt literally and otherwise does what the 8 real runs did: it keys
   * routes by method and path, and puts an action on its collection path. It obeys the Required
   * keys and Paths routes already own lists when the prompt has them.
   */
  const slug = (method: string, path: string) => `${method} ${path}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  function literalModel(req: ProposeRequest): Reply {
    const required = new Set(listed(req.prompt, 'Required keys').map((l) => l.slice(2).split(' ')[0]));
    if (req.prompt.includes('for the model stage')) {
      const routes = Object.fromEntries(Object.entries(TARGET.routes).map(([k, r]) => [required.has(`routes.${k}`) ? k : slug(r.method, r.path), r]));
      return { input: { note: 'entities and routes', upsert: { entities: TARGET.entities, routes } } };
    }
    const taken = new Set(listed(req.prompt, 'Paths routes already own').map((l) => routeKey(l.split(' ')[1]!, l.split(' ')[2]!)));
    const action = TARGET.actions['resolve_ticket']!;
    const naive = { method: 'POST', path: '/tickets' };
    const placed = taken.has(routeKey(naive.method, naive.path)) ? { method: action.method, path: action.path } : naive;
    return { input: { ...EDITS.workflow, upsert: { ...EDITS.workflow.upsert, actions: { ...TARGET.actions, resolve_ticket: { ...action, ...placed } } } } };
  }
  /** The request without the prompt sections YOS-45 added. */
  const withoutLists = (req: ProposeRequest): ProposeRequest => ({
    ...req,
    prompt: req.prompt.replace(/\n\n## (Required keys|Action routes|Paths routes already own)\n[\s\S]*?(?=\n\n## |$)/g, ''),
  });
  const firstAttemptCodes = (events: readonly RunEvent[]) =>
    events.flatMap((e) => (e.t === 'attempt' && e.n === 1 && (e.step === 'model' || e.step === 'workflow')
      ? [[e.step, 'issues' in e.outcome ? [...new Set(e.outcome.issues.map((i) => i.code))] : []]] : []));

  it('without the lists, the literal model fails attempt 1 of model (plan.not_covered) and of workflow (route.duplicate_path)', async () => {
    const { events } = await run([{ input: ACTION_ROUTE_PLAN }, (r) => literalModel(withoutLists(r)), { input: EDITS.model }, (r) => literalModel(withoutLists(r)), { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.deepEqual(firstAttemptCodes(events), [['model', ['plan.not_covered']], ['workflow', ['route.duplicate_path', 'layer.blocked', 'plan.not_covered']]]);
  });

  it('with them, the same literal model passes attempt 1 of model and workflow on a plan with a custom route', async () => {
    const { events } = await run([{ input: ACTION_ROUTE_PLAN }, literalModel, literalModel, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted']]);
  });
});

/** The `- ` lines of one `## title` section of a prompt. */
function listed(prompt: string, title: string): string[] {
  return (prompt.split(`## ${title}\n\n`)[1]?.split('\n## ')[0] ?? '').split('\n').filter((l) => l.startsWith('- '));
}

/** A seed whose first customer is the one RESOLVE_TEST creates, so the workflow test fails at the seed stage (customer.name is unique). */
const CLASHING_SEED = { note: 'customers that clash with the test', upsert: { seed: { ...TARGET.seed, customer: CUSTOMERS.replace("{ name: 'Acme'", "{ name: 'Test Co', tier: 'free' },\n  { name: 'Acme'") } } };
/** A seed whose first customer script throws, so the engine reports snippet.runtime_error at seed.customer and blocks the tests layer. */
const THROWING_SEED = { note: 'customers that throw', upsert: { seed: { ...TARGET.seed, customer: '(ctx) => { throw new Error("boom"); }' } } };
/** A check that fails a workflow test on each of the first `n` worlds that hold tasks, so the tasks step finds an issue that an earlier step owns. */
function tasksBreakWorkflowTest(n: number): (world: World) => CheckReport {
  let left = n;
  return (world) => {
    if (Object.keys(world.tasks).length === 0 || left === 0) return checkWorld(world);
    left -= 1;
    return { ok: false, reached: 'tests', issues: [issue('test.failed', ['tests', 'resolve_pending_ticket', 'script'], { message: 'boom' }, 'boom')], warnings: [] };
  };
}
/** A check that reports a model-owned issue on the first world that holds tasks, so the tasks step backtracks to model. */
function tasksBreakModelOnce(): (world: World) => CheckReport {
  let left = 1;
  return (world) => {
    if (Object.keys(world.tasks).length === 0 || left === 0) return checkWorld(world);
    left -= 1;
    return { ok: false, reached: 'tests', issues: [issue('state.bad_machine', ['entities', 'ticket'], { problem: 'no initial state' }, 'none')], warnings: [] };
  };
}
const report = (dir: string): string => readFileSync(join(dir, 'REPORT.md'), 'utf8');

/** A check that always reports the snippet host as unavailable, and counts its runs. */
function hostDown(): { check: (world: World) => CheckReport; runs: () => number } {
  const unavailable = issue('snippet.host_unavailable', ['entities', 'ticket'], { ms: 10_000 }, 'not run');
  let n = 0;
  return { check: () => { n += 1; return { ok: false, reached: 'compile', issues: [unavailable], warnings: [] }; }, runs: () => n };
}
const billedError = new ModelError('overloaded', undefined, { usage: USAGE, costUsd: 0, ms: 10 });
const STOPS: Record<StopReason['kind'], () => Promise<Ran>> = {
  input_rejected: () => run(HAPPY, { digestThrows: new Error('EACCES: permission denied') }),
  attempts_exhausted: () => run([{ input: PLAN }, { input: BAD_ENTITY }, { input: BAD_FILTER }],
    { config: configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { model: { maxAttempts: 2 } } }) }),
  no_progress: () => run([{ input: PLAN }, { input: BAD_ENTITY }, { input: BAD_ENTITY }]),
  backtrack_limit: () => run([{ input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }],
    { check: tasksBreakWorkflowTest(3) }),
  budget_exhausted: () => run(HAPPY, { config: configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 0.25, maxOutputTokens: 100 }) }),
  spend_cap: () => run([{ input: PLAN }, () => { throw new SpendCapError({ cap: 'maxTotalUsd', capUsd: 100, spentUsd: 100, remainingUsd: 0 }, '2026-10-07'); }]),
  cost_unenforceable: () => run([{ input: PLAN }, () => { throw new CostUnenforceableError('maxTotalUsd', null, 'cost admission refused'); }]),
  time_exhausted: () => run(HAPPY, { config: configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 1 }) }),
  stage_time_exhausted: () => run(HAPPY, { config: configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5, steps: { tasks: { reserve: 0.9 } } }) }),
  model_error: () => run([billedError]),
  judge_error: () => run(HAPPY, { check: () => { throw new Error('seeding failed during judging'); } }),
  infra_unavailable: () => run(HAPPY, { check: hostDown().check }),
  transport_stalled: () => run([new CallStalled(120_000, 121_000, SILENT, 0), new CallStalled(120_000, 121_000, SILENT, 0)]),
  cancelled: () => run(HAPPY, { signal: AbortSignal.abort() }),
};

describe('runWorldGen create: atomic output through <out>.partial (YOS-44, A-293)', () => {
  it('leaves an existing <out> byte for byte on a stop, and keeps the run in <out>.partial', async () => {
    const outDir = newOutDir();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'world.yaml'), 'previous world\n');
    writeFileSync(join(outDir, 'REPORT.md'), 'previous report\n');
    const { result } = await run([], { outDir });
    assert.equal(result.kind, 'stopped');
    assert.equal(result.dir, partialDir(outDir));
    assert.deepEqual(readdirSync(outDir).sort(), ['REPORT.md', 'world.yaml']);
    assert.equal(readFileSync(join(outDir, 'world.yaml'), 'utf8'), 'previous world\n');
    assert.equal(readFileSync(join(outDir, 'REPORT.md'), 'utf8'), 'previous report\n');
    assert.equal(report(partialDir(outDir)).split('\n')[0], 'Stopped: model_error');
    assert.equal(existsSync(join(partialDir(outDir), 'world.yaml')), false);
    assert.equal(existsSync(join(partialDir(outDir), 'runs', 'run_test', 'events.jsonl')), true);
  });

  it('publishes <out> only when done, and moves an existing <out> aside instead of deleting it', async () => {
    const outDir = newOutDir();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'REPORT.md'), 'an earlier stop\n');
    const { result } = await run(HAPPY, { outDir });
    assert.equal(result.kind, 'done');
    assert.equal(result.dir, outDir);
    assert.equal(existsSync(partialDir(outDir)), false);
    assert.deepEqual(['capsule.json', 'plan.md', 'plan.yaml', 'REPORT.md', 'runs', 'world.yaml'].filter((f) => existsSync(join(outDir, f))), ['capsule.json', 'plan.md', 'plan.yaml', 'REPORT.md', 'runs', 'world.yaml']);
    assert.equal(readFileSync(join(`${outDir}.replaced-run_test`, 'REPORT.md'), 'utf8'), 'an earlier stop\n');
  });
});

describe('runWorldGen create: an operator stop (A-279)', () => {
  it('cancels the call in flight, records it, stops with cancelled and still writes REPORT.md and run_finished', async () => {
    const controller = new AbortController();
    const { result, events, filesDir } = await run(HAPPY, { abortOnCall: { n: 2, controller } });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : result.kind, { kind: 'cancelled' });
    assert.deepEqual(events.filter((e) => e.t === 'call_cancelled').map((e) => e.t === 'call_cancelled' ? e.step : null), ['model']);
    assert.equal(events.at(-1)?.t, 'run_finished');
    assert.match(report(filesDir), /The operator stopped the run/);
  });
});

describe('runWorldGen create: REPORT.md on every exit (YOS-44)', () => {
  it('writes REPORT.md when the run is done', async () => {
    const { result, filesDir } = await run(HAPPY);
    assert.equal(result.kind, 'done');
    assert.match(report(filesDir), /^# /);
    assert.doesNotMatch(report(filesDir), /Stopped:/);
  });

  for (const [kind, go] of Object.entries(STOPS)) {
    it(`writes REPORT.md naming the stop when the run stops with ${kind}`, async () => {
      const { result, events, filesDir } = await go();
      assert.equal(result.kind === 'stopped' ? result.reason.kind : result.kind, kind);
      assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
      assert.match(report(filesDir), new RegExp(`Stopped: ${kind}\n`));
      const c = capsuleSchema.parse(JSON.parse(readFileSync(join(filesDir, CAPSULE_FILE), 'utf8')));
      assert.equal(c.worldId, null);
      assert.equal(c.runId, 'run_test');
      assert.equal(events[events.length - 1]?.t, 'run_finished');
    });
  }

  it('stops with input_rejected, not a thrown error, when the digest cannot read the input', async () => {
    const { result } = await run(HAPPY, { digestThrows: new Error('EACCES: permission denied') });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'input_rejected', why: 'The input could not be read: EACCES: permission denied' });
  });

  it('stops with spend_cap, not model_error or the run budget, when a ledger cap refuses the call, and names the cap', async () => {
    const cap = new SpendCapError({ cap: 'maxDailyUsd', capUsd: 60, spentUsd: 60.08, remainingUsd: 0 }, '2026-10-07');
    const { result, events, filesDir } = await run([{ input: PLAN }, () => { throw cap; }]);
    const reason = { kind: 'spend_cap', cap: 'maxDailyUsd', capUsd: 60, spentUsd: 60.08, day: '2026-10-07' };
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, reason);
    const finished = events.find((e) => e.t === 'run_finished');
    assert.deepEqual(finished?.t === 'run_finished' ? finished.result : null, { kind: 'stopped', reason });
    assert.equal(finished?.t === 'run_finished' && finished.result.kind === 'stopped' ? describeStop(finished.result.reason) : null,
      'spend_cap: daily spend cap WORLDGEN_MAX_DAILY_USD=$60.00 reached: $60.08 spent today (2026-10-07 UTC), all sessions, model calls and sandboxes');
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted']]);
    assert.equal(report(filesDir).startsWith('Stopped: spend_cap\n\nThe run was refused by a spend cap shared by every session, not by its own budget: daily spend cap WORLDGEN_MAX_DAILY_USD=$60.00 reached: $60.08 spent today (2026-10-07 UTC), all sessions, model calls and sandboxes.\n'), true);
  });
});

describe('runWorldGen create: a call the ledger cannot admit (YOS-227)', () => {
  for (const [claim, why] of [[null, 'some spend in its window has unknown cost'], ['e1467cfb', 'claim e1467cfb has unknown cost']] as const) {
    it(`stops with cost_unenforceable, $0 and no unknown-cost call, when ${why}`, async () => {
      const refused = new CostUnenforceableError('maxDailyUsd', claim, 'cost admission refused: WORLDGEN_MAX_DAILY_USD cannot be enforced');
      const { result, events, filesDir } = await run([{ input: PLAN }, () => { throw refused; }]);
      const reason: StopReason = { kind: 'cost_unenforceable', cap: 'maxDailyUsd', claim };
      assert.deepEqual(result.kind === 'stopped' ? result.reason : null, reason);
      assert.equal(result.costUsd, 0.125);
      assert.deepEqual(attempts(events), [['plan', 1, 'accepted']]);
      const finished = events.find((e) => e.t === 'run_finished');
      assert.equal(finished?.t === 'run_finished' ? finished.unknownCostCalls : 'missing', undefined);
      assert.equal(describeStop(reason),
        `cost_unenforceable: not admitted: WORLDGEN_MAX_DAILY_USD cannot be enforced while ${why}; nothing was called or spent (see \`costs\`, settle with \`costs release <id> --usd <n>\`)`);
      assert.equal(report(filesDir).split('\n').slice(0, 3).join('\n'),
        `Stopped: cost_unenforceable\n\nThe run was not admitted: WORLDGEN_MAX_DAILY_USD cannot be enforced while ${why}; nothing was called or spent (see \`costs\`, settle with \`costs release <id> --usd <n>\`). Spend of unknown cost, from any session, blocks every capped run until it is settled.`);
    });
  }
});

describe('runWorldGen create: judging exceptions', () => {
  it('records a failed judging attempt, retains its cost and writes the stopped report without another model call', async () => {
    const { result, events, calls, filesDir } = await run(HAPPY, { check: () => { throw new Error('seeding failed during judging'); } });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'judge_error', step: 'model', message: 'seeding failed during judging' });
    assert.equal(result.costUsd, 0.25);
    assert.equal(calls.length, 2);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'judge_error']]);
    assert.match(report(filesDir), /Stopped: judge_error/);
    assert.match(report(filesDir), /The engine could not finish judging model: seeding failed during judging/);
    assert.equal(existsSync(join(filesDir, 'world.yaml')), false);
    const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(filesDir, CAPSULE_FILE), 'utf8')));
    assert.deepEqual(capsule.attempts.map(a => [a.step, a.n, a.outcome]), [['plan', 1, 'accepted'], ['model', 1, 'judge_error']]);
    assert.equal(capsule.costUsd, 0.25);
    assert.equal(capsule.worldId, null);
  });
});

describe('runWorldGen create: an unavailable snippet host is infrastructure, not a repair (A-92)', () => {
  it('rechecks once, then stops without asking the model to change the proposal', async () => {
    const down = hostDown();
    const { result, events, calls } = await run(HAPPY, { check: down.check });
    assert.deepEqual(result.kind === 'stopped' ? result.reason.kind : null, 'infra_unavailable');
    assert.equal(down.runs(), 2);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'infra_unavailable']]);
    assert.equal(calls.length, 2);
  });
});

/** A tasks edit with one of the three planned tasks: rejected for tasks-owned issues (world.too_few_tasks). */
const ONE_TASK = (() => {
  const [id, task] = Object.entries(TARGET.tasks)[0] ?? [];
  if (id === undefined || task === undefined) throw new Error('TARGET has no task');
  return { note: 'one task', upsert: { tasks: { [id]: task } } };
})();
/** The same customers in a snippet that differs only in spacing, so a check can tell the reseeded world apart. */
const RESEED = { note: 'customers, seeded again', upsert: { seed: { ...TARGET.seed, customer: CUSTOMERS.replace('(ctx) => [', '(ctx) =>  [') } } };
const FLAGGED = issue('constraint.violation', ['seed', 'customer'], { entity: 'customer', field: 'tier', rule: 'enum' }, 'row 0, field tier: "gold"');
/** The engine check, except that a world with all three tasks over the first seed fails FLAGGED, a seed-owned issue. */
const flagsFirstSeed = (w: World): CheckReport =>
  Object.keys(w.tasks).length === 3 && w.seed['customer'] === CUSTOMERS ? { ok: false, reached: 'seed', issues: [FLAGGED], warnings: [] } : checkWorld(w);
/**
 * worldgen-97: tasks is rejected for its own issues (X), then for a seed-owned one (Y), so it backtracks to seed.
 * Seed is accepted, and tasks repeats X once before it answers in full.
 */
const RERUN_AFTER_BACKTRACK: Script = [{ input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed },
  { input: ONE_TASK }, { input: EDITS.tasks }, { input: RESEED }, { input: ONE_TASK }, { input: EDITS.tasks }];

describe('runWorldGen create: backtracking (YOS-44)', () => {
  it('a workflow test that the new seed breaks is the seed step\'s to repair: it retries with the failure and nothing backtracks (A-122)', async () => {
    const script: Script = [{ input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: CLASHING_SEED }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, events, calls } = await run(script);
    assert.equal(result.kind, 'done');
    assert.equal(events.filter((e) => e.t === 'backtracked').length, 0);
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'rejected'],
      ['seed', 2, 'accepted'], ['tasks', 1, 'accepted']]);
    assert.equal(calls.length, 6);
    const retry = calls[4]?.prompt ?? '';
    assert.match(retry, /## Your previous answer was rejected/);
    assert.match(retry, /test\.(failed|seed_collision)/);
  });

  it('a seed retry is told only what it must fix: layer.blocked, which says another issue came first, is left out (A-122)', async () => {
    const script: Script = [{ input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: THROWING_SEED }, { input: EDITS.seed }, { input: EDITS.tasks }];
    const { result, events, calls } = await run(script);
    assert.equal(result.kind, 'done');
    const first = events.find((e) => e.t === 'attempt' && e.step === 'seed');
    assert.deepEqual(first?.t === 'attempt' && first.outcome.kind === 'rejected' ? first.outcome.issues.map((i) => i.code).sort() : null, ['layer.blocked', 'snippet.runtime_error']);
    const retry = calls[4]?.prompt ?? '';
    assert.match(retry, /snippet\.runtime_error/);
    assert.doesNotMatch(retry, /layer\.blocked/);
  });

  it('backtracks from tasks to the workflow step when a workflow test fails there, and reruns every later step', async () => {
    const { result, events } = await STOPS.backtrack_limit();
    assert.equal(result.kind, 'stopped');
    const bt = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(bt?.t === 'backtracked' ? [bt.from, bt.to, bt.because.map((i) => i.code)] : null, ['tasks', 'workflow', ['test.failed']]);
  });

  it('stops with backtrack_limit after maxBacktracks backtracks, never calling the model again', async () => {
    const { result, events, calls } = await STOPS.backtrack_limit();
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'backtrack_limit', step: 'tasks', backtracks: 2 });
    assert.equal(events.filter((e) => e.t === 'backtracked').length, 2);
    assert.equal(calls.length, 11);
  });

  it('gives a step that backtracked its last rejection when it runs again, after the step it backtracked to (A-124)', async () => {
    const { events, calls } = await run(RERUN_AFTER_BACKTRACK, { check: flagsFirstSeed });
    const bt = events.find((e) => e.t === 'backtracked');
    assert.deepEqual(bt?.t === 'backtracked' ? [bt.from, bt.to, bt.because] : null, ['tasks', 'seed', [FLAGGED]]);
    assert.match(calls[6]?.prompt ?? '', /## The tasks step found issues that this step must fix/);
    const again = calls[7]?.prompt ?? '';
    assert.match(again, /\n## Your previous answer was rejected for issues an earlier step owned\n\nIt was not applied\. Since then the seed step has run again, and every step between it and this one has run again or been rechecked, so the world above may have changed\. Answer again in full, keep what was right, and fix what the issues below still show\.\n/);
    assert.equal(again.includes(`Your previous answer:\n\n\`\`\`json\n${JSON.stringify(EDITS.tasks, null, 2)}\n\`\`\``), true);
    assert.equal(again.includes('- code: constraint.violation\n  path: seed.customer\n'), true);
    assert.equal(again.includes('  found: row 0, field tier: "gold"'), true);
    assert.doesNotMatch(again, /## Your previous answer was rejected\n/);
    assert.doesNotMatch(again, /## The \w+ step found issues/);
  });

  it('counts no_progress from the backtrack on: the tasks issues it had before the backtrack, seen once after it, retry (A-124)', async () => {
    const { result, events } = await run(RERUN_AFTER_BACKTRACK, { check: flagsFirstSeed });
    assert.equal(result.kind === 'stopped' ? result.reason.kind : result.kind, 'done');
    assert.deepEqual(attempts(events), [['plan', 1, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'],
      ['tasks', 1, 'rejected'], ['tasks', 2, 'rejected'], ['seed', 1, 'accepted'], ['tasks', 1, 'rejected'], ['tasks', 2, 'accepted']]);
    const first = events.find((e) => e.t === 'attempt' && e.step === 'tasks');
    const third = events.filter((e) => e.t === 'attempt' && e.step === 'tasks')[2];
    assert.deepEqual(first?.t === 'attempt' && first.outcome.kind === 'rejected' ? brief(first.outcome.issues) : null, [
      ['world.too_few_tasks', ['tasks']], ['plan.not_covered', ['plan', 'tasks', 1]], ['plan.not_covered', ['plan', 'tasks', 2]], ['tasks.difficulty_not_spread', ['tasks']],
    ]);
    assert.deepEqual(third?.t === 'attempt' ? third.outcome : null, first?.t === 'attempt' ? first.outcome : null);
  });
});

describe('runWorldGen create: run capsule and content ids (YOS-83)', () => {
  const DIGEST = 'e1e715352a48477b04a8b8538b6680e889b2ebb26a22ee2c6f5203e1b4d862a4';
  const cap = (r: Ran) => capsuleSchema.parse(JSON.parse(readFileSync(join(r.outDir, CAPSULE_FILE), 'utf8')));
  const CSV_DIGEST: InputDigest = { kind: 'csv', summary: 'orders', fixtures: {}, operations: [], observations: [], apiShape: null };

  it('records CSV paths relative to the repository, and null for a file outside it (A-351)', async () => {
    const r = await run(HAPPY, { input: { kind: 'csv', paths: ['../eval/inputs/orders.csv', join(tmpdir(), 'outside.csv')] }, digest: CSV_DIGEST });
    assert.deepEqual(cap(r).input.source, { kind: 'csv', paths: ['eval/inputs/orders.csv', null] });
  });

  it('never lets a token in the input reach capsule.json (A-351)', async () => {
    const token = 'sk-ant-abcDEF123456';
    const described = await run(HAPPY, { input: { kind: 'description', text: `A helpdesk where overdue tickets escalate; our key is ${token}` } });
    const tabled = await run(HAPPY, { input: { kind: 'csv', paths: [`../eval/inputs/${token}.csv`] }, digest: CSV_DIGEST });
    for (const r of [described, tabled]) assert.equal(readFileSync(join(r.filesDir, CAPSULE_FILE), 'utf8').includes(token), false);
    assert.deepEqual(cap(described).input.source, { kind: 'description' });
    assert.deepEqual(cap(tabled).input.source, { kind: 'csv', paths: [null] });
  });

  it('writes capsule.json next to REPORT.md with the input digest, world id, model, transport, attempts and costs', async () => {
    const r = await run(HAPPY);
    const c = cap(r);
    assert.match(c.worldId ?? '', /^wid_[0-9a-f]{64}$/);
    const a = (step: string) => ({ step, n: 1, outcome: 'accepted', ms: 1000, costUsd: 0.125 });
    assert.deepEqual({ ...c, worldId: null, ms: 0 }, {
      capsule: 1, runId: 'run_test', mode: 'create',
      input: { kind: 'description', digest: DIGEST, source: { kind: 'description' } },
      worldId: null, model: 'claude-sonnet-5-5', transport: 'claude-cli',
      attempts: [a('plan'), a('model'), a('workflow'), a('seed'), a('tasks')],
      ms: 0, costUsd: 0.625,
    });
    assert.equal(c.ms, r.result.ms);
  });

  it('the capsule world id names world.yaml on disk and the one REPORT.md shows', async () => {
    const r = await run(HAPPY);
    const c = cap(r);
    const loaded = await loadWorld(r.outDir);
    assert.ok(loaded.ok);
    assert.equal(worldIdOf(worldSchema.parse(loaded.value)), c.worldId);
    assert.equal(report(r.outDir).includes(`World id (WID): \`${c.worldId}\`.`), true);
  });

  it('the same input and script give the same ids, byte for byte', async () => {
    const a = await run(HAPPY);
    const b = await run(HAPPY);
    assert.equal(readFileSync(join(a.outDir, CAPSULE_FILE), 'utf8'), readFileSync(join(b.outDir, CAPSULE_FILE), 'utf8'));
    assert.equal(readFileSync(join(a.outDir, 'world.yaml'), 'utf8'), readFileSync(join(b.outDir, 'world.yaml'), 'utf8'));
  });

  it('a changed world gets a new world id; a changed input a new input digest', async () => {
    const base = await run(HAPPY);
    const changed = await run([{ input: { ...PLAN, summary: 'Customers file tickets and agents resolve them; overdue tickets escalate.' } }, ...HAPPY.slice(1)]);
    assert.notEqual(cap(changed).worldId, cap(base).worldId);
    assert.equal(cap(changed).input.digest, DIGEST);
    const other = await run(HAPPY, { digest: { kind: 'description', summary: 'A helpdesk with SLA tiers', fixtures: {}, operations: [], observations: [], apiShape: null } });
    assert.notEqual(cap(other).input.digest, DIGEST);
  });
});

it('direct library rejection writes report and capsule before any metered model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-direct-rejection-'));
  const outDir = join(dir, 'new-output');
  const ledger = openLedger(join(dir, 'costs.jsonl'));
  let calls = 0;
  const raw: Model = { async propose() { calls += 1; throw new Error('unexpected model call'); } };
  const model = meteredModel(raw, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
  try {
    const result = await runWorldGen({ kind: 'create', input: { kind: 'openapi', path: join(dir, 'missing.openapi.yaml'), only: [] }, outDir }, CONFIG,
      { model, exampleWorld: minimalWorld(), runId: 'direct_rejection' });
    assert.equal(result.kind === 'stopped' ? result.reason.kind : null, 'input_rejected');
    assert.equal(result.costUsd, 0);
    assert.equal(calls, 0);
    assert.equal(ledger.read().events.length, 0);
    assert.equal(ledger.read().reservations.length, 0);
    assert.equal(existsSync(join(result.dir, 'world.yaml')), false);
    assert.equal(existsSync(join(result.dir, 'plan.yaml')), false);
    assert.match(readFileSync(join(result.dir, 'REPORT.md'), 'utf8'), /^Stopped: input_rejected/);
    const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(result.dir, CAPSULE_FILE), 'utf8')));
    assert.deepEqual(capsule.attempts, []);
    assert.equal(capsule.worldId, null);
    assert.equal(capsule.costUsd, 0);
    const events = parseEventLog(readFileSync(join(result.dir, 'runs', 'direct_rejection', 'events.jsonl'), 'utf8'));
    assert.deepEqual(events.problems, []);
    assert.deepEqual(events.events.map(event => event.t), ['run_finished']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('a judging exception retains settled meter charges in the actual report and capsule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wg-metered-judge-'));
  const ledger = openLedger(join(dir, 'costs.jsonl'));
  const raw = fakeModel(HAPPY);
  const model = meteredModel(raw, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
  try {
    const result = await runWorldGen({ kind: 'create', input: { kind: 'description', text: 'Offline judge exception fixture' }, outDir: dir }, CONFIG,
      { model, exampleWorld: minimalWorld(), check: () => { throw new Error('offline judging failure'); }, runId: 'metered_judge' });
    assert.deepEqual(result.kind === 'stopped' ? result.reason : null, { kind: 'judge_error', step: 'model', message: 'offline judging failure' });
    assert.equal(raw.calls.length, 2);
    assert.equal(result.costUsd, 0.25);
    assert.equal(ledger.totals().usd, 0.25);
    assert.deepEqual(ledger.read().events.map(event => event.usd), [0.125, 0.125]);
    assert.equal(ledger.read().reservations.length, 0);
    const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(result.dir, CAPSULE_FILE), 'utf8')));
    assert.deepEqual(capsule.attempts.map(attempt => [attempt.outcome, attempt.costUsd]), [['accepted', 0.125], ['judge_error', 0.125]]);
    assert.equal(capsule.costUsd, 0.25);
    assert.equal(capsule.unknownCostCalls, undefined);
    assert.match(readFileSync(join(result.dir, 'REPORT.md'), 'utf8'), /^Stopped: judge_error/);
    assert.equal(existsSync(join(dir, 'world.yaml')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe('runWorldGen: a seed shortfall found at tasks goes back to seed with its numbers (YOS-219)', () => {
  const PAGE_12 = { note: 'entities and routes, twelve tickets a page', upsert: { entities: TARGET.entities, routes: routesWith('list_tickets', { pageSize: 12 }) } };
  // The easy solution reads two pages of six through the cursor: only a later-page call counts as paging (A-360).
  const twoPages = "((first) => ({ status: first.status, body: { data: [...first.body.data, ...ctx.api('GET', '/tickets?limit=6&cursor=' + first.body.next_cursor).body.data] } }))(ctx.api('GET', '/tickets?limit=6'))";
  const pagedTasks = Object.fromEntries(Object.entries(TARGET.tasks).map(([id, t]) =>
    [id, id === 'resolve_password_ticket' ? { ...t, solution: t.solution?.replace("ctx.api('GET', '/tickets')", twoPages) } : t]));
  const PAGED_TASKS = { note: 'three graded tasks; the easy one pages through tickets six at a time', upsert: { tasks: pagedTasks } };
  const doubled = (TARGET.seed['ticket'] ?? '').replace('return spec.map(', "return [...spec, ...spec.map((s) => [s[0], s[1], s[2], s[3] + ' (follow-up)'])].map(");
  const SEED_24 = { note: 'customers and 24 tickets, the same mix', upsert: { seed: { ...TARGET.seed, ticket: doubled } } };
  const steps = (events: readonly RunEvent[]) => events.flatMap((e) => (e.t === 'attempt' ? [[e.step, e.outcome.kind] as const] : []));

  it('backtracks to seed when a task pages through a seed that fits one page, instead of retrying tasks into no_progress', async () => {
    const { result, events, calls } = await run([
      { input: PLAN }, { input: PAGE_12 }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: PAGED_TASKS }, { input: SEED_24 }, { input: PAGED_TASKS },
    ]);
    assert.deepEqual(steps(events), [
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'rejected'], ['seed', 'accepted'], ['tasks', 'accepted'],
    ]);
    const back = events.flatMap((e) => (e.t === 'backtracked' ? [e] : []));
    assert.deepEqual(back.map((e) => [e.from, e.to, brief(e.because), e.because.map((i) => [i.expected, i.found])]), [
      ['tasks', 'seed', [['seed.too_few_rows_for_paging', ['seed', 'ticket']]], [['more than 12 ticket rows', '12 rows']]],
    ]);
    assert.equal(calls[5]?.prompt.includes('more than 12 ticket rows'), true);
    assert.equal(result.kind, 'done');
  });

  it('tells the seed step what the planned tasks press on, with exact numbers, and the run still reaches done', async () => {
    const pressured = { ...PLAN, tasks: PLAN.tasks.map((t) => (t.id === 'escalate_acme' ? { ...t, pressure: { states: ['ticket.pending'] } } : t)) };
    const { result, calls } = await run([{ input: pressured }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.deepEqual(listed(calls[3]?.prompt ?? '', 'What the planned tasks need from the seed'), [
      '- ticket.pending: at least one row in that state, because task escalate_acme presses on it.',
    ]);
    assert.deepEqual(listed(calls[4]?.prompt ?? '', 'What the planned tasks need from the seed'), []);
    assert.equal(result.kind, 'done');
  });

  it('shows the tasks step every declared claim of every task, with its list and filters, and the run reaches done (A-316)', async () => {
    const pressured = { ...PLAN, tasks: PLAN.tasks.map((t) => (t.id === 'escalate_acme' ? { ...t, pressure: { distractors: 'ticket' } } : t)) };
    const { result, calls } = await run([{ input: pressured }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    assert.deepEqual(listed(calls[4]?.prompt ?? '', 'Pressure each task must show, every claim in every answer'), [
      '- escalate_acme, distractors ticket: call GET /tickets with one of its filters (customer, status, priority) so that it returns a ticket row the task leaves unchanged, and change at least one ticket row. With cursor too, the call still counts as a later page.',
    ]);
    assert.deepEqual(listed(calls[3]?.prompt ?? '', 'Pressure each task must show, every claim in every answer'), []);
    assert.equal(result.kind, 'done');
  });

  // stress-8 helpdesk-sla (A-406): the plan pressed distractors on an entity the task only looks up, which no reference can meet.
  it('sends a distractor claim on an entity the reference never changes back to the plan at the first tasks rejection (A-406)', async () => {
    const lookup = { ...PLAN, tasks: PLAN.tasks.map((t) => (t.id === 'escalate_acme' ? { ...t, pressure: { distractors: 'customer' } } : t)) };
    const { result, events, calls } = await run([
      { input: lookup }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
      { input: { ...PLAN, revision: 2 } }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks },
    ]);
    assert.deepEqual(steps(events), [
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'rejected'],
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'accepted'], ['tasks', 'accepted'],
    ]);
    const back = events.filter((e) => e.t === 'backtracked');
    assert.deepEqual(back.map((e) => (e.t === 'backtracked' ? [e.from, e.to, e.because.map((i) => [i.code, i.path, i.found])] : [])), [
      ['tasks', 'plan', [['task.pressure_unmet', ['plan', 'tasks', 2, 'pressure', 'distractors'],
        'the reference changes no customer row, so no customer row can be a distractor: a distractor is a near-duplicate of a row the task changes']]],
    ]);
    assert.equal(calls[5]?.prompt.includes('the reference changes no customer row'), true);
    assert.equal(result.kind, 'done');
  });

  // stress-5 stripe-customers: a create's seed step had no task yet, so its report failed and the seed needs never ran there.
  it('rejects a create seed that misses a planned need at the seed step and retries it there with the issue (YOS-253)', async () => {
    const paged = { ...PLAN, tasks: PLAN.tasks.map((t) => (t.id === 'resolve_password_ticket' ? { ...t, pressure: { paging: 'ticket' } } : t)) };
    // The paging claim needs the changed row reached only past the first page: the password ticket is row 2, so pages of one.
    const secondRow = "ctx.api('GET', '/tickets?limit=1&cursor=' + ctx.api('GET', '/tickets?limit=1').body.next_cursor)";
    const LATER_PAGE_TASKS = { note: 'three graded tasks; the easy one finds its ticket on the second one-row page', upsert: { tasks: Object.fromEntries(Object.entries(TARGET.tasks).map(([id, t]) =>
      [id, id === 'resolve_password_ticket' ? { ...t, solution: t.solution?.replace("ctx.api('GET', '/tickets')", secondRow) } : t])) } };
    const { result, events, calls } = await run([
      { input: paged }, { input: PAGE_12 }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: SEED_24 }, { input: LATER_PAGE_TASKS },
    ]);
    assert.deepEqual(steps(events), [
      ['plan', 'accepted'], ['model', 'accepted'], ['workflow', 'accepted'], ['seed', 'rejected'], ['seed', 'accepted'], ['tasks', 'accepted'],
    ]);
    const seedIssues = events.flatMap((e) => (e.t === 'attempt' && e.step === 'seed' && e.outcome.kind === 'rejected' ? e.outcome.issues : []));
    assert.deepEqual(seedIssues.map((i) => [i.code, i.path, i.expected, i.found]), [['seed.too_few_rows_for_paging', ['seed', 'ticket'], 'more than 12 ticket rows', '12 rows']]);
    assert.equal(calls[4]?.prompt.includes('more than 12 ticket rows'), true);
    assert.equal(result.kind, 'done');
  });

  it('rejects at the plan step a pressed state the plan holds in no state field, and the plan that drops it reaches done (YOS-253)', async () => {
    const removal = { name: 'customer_lifecycle', entity: 'customer', states: ['active', 'deleted'], rules: [], lifecycle: { representation: 'removal', reason: 'a deleted customer is removed from the store' }, actions: [] };
    // As stripe-customers' plan did, it gives the removal entity a stateMix of active: 100, which A-371 no longer asks for.
    const unmeetable = {
      ...PLAN, workflows: [...PLAN.workflows, removal], seed: { ...PLAN.seed, stateMix: { ...PLAN.seed.stateMix, customer: { active: 100 } } },
      tasks: PLAN.tasks.map((t) => (t.id === 'escalate_acme' ? { ...t, pressure: { states: ['customer.active'] } } : t)),
    };
    const { result, events, calls } = await run([{ input: unmeetable }, { input: PLAN }, { input: EDITS.model }, { input: EDITS.workflow }, { input: EDITS.seed }, { input: EDITS.tasks }]);
    const planIssues = events.flatMap((e) => (e.t === 'attempt' && e.step === 'plan' && e.outcome.kind === 'rejected' ? e.outcome.issues : []));
    assert.deepEqual(planIssues.map((i) => [i.code, i.path, i.found]), [
      ['plan.pressure_unreachable', ['plan', 'tasks', 2, 'pressure', 'states', 0], 'customer.active is a state only of customer_lifecycle (lifecycle removal)'],
    ]);
    assert.equal(calls[1]?.prompt.includes('Drop customer.active from the pressure of escalate_acme'), true);
    assert.equal(result.kind, 'done');
  });
});


describe('runWorldGen create: an OpenAPI operation a workflow action builds is planned as that action (YOS-244)', () => {
  const RESOLVE = 'POST /tickets/{id}/resolve';
  const operations = [['GET', '/tickets'], ['GET', '/tickets/{id}'], ['GET', '/customers'], ['POST', '/tickets/{id}/resolve']] as const;
  const digest: InputDigest = { kind: 'openapi', summary: 'a helpdesk API', fixtures: {}, observations: [], apiShape: null, operations: operations.map(([method, path]) => ({ method, path })) };
  const spec = (): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'wg-spec-')), 'spec.json');
    const paths: Record<string, Record<string, unknown>> = {};
    for (const [method, path] of operations) paths[path] = { ...paths[path], [method.toLowerCase()]: { responses: { '200': { description: 'ok' } } } };
    writeFileSync(file, JSON.stringify({ openapi: '3.0.3', paths }));
    return file;
  };
  const ACTION_ROUTE = { id: 'resolve_ticket', method: 'POST', path: '/tickets/{id}/resolve', purpose: 'resolve a pending ticket, built as the resolve_ticket action' };
  /** Replies as the live model did (YOS-244): a plan without the action's route, then a plain route for any operation the judge says is uncovered. */
  const liveLike = (req: ProposeRequest): Reply => {
    if (req.tool.name === 'submit_plan') return { input: req.prompt.includes(`input operation ${RESOLVE}`) ? { ...PLAN, routes: [...PLAN.routes, ACTION_ROUTE] } : PLAN };
    const stage = /^## This step: (\w+)/.exec(req.prompt)?.[1];
    if (stage === 'model') {
      if (!req.prompt.includes(`input operation ${RESOLVE}`)) return { input: EDITS.model };
      return { input: { note: 'cover the resolve operation with a route', upsert: { entities: TARGET.entities, routes: { ...TARGET.routes, resolve_route: { op: 'update', entity: 'ticket', method: 'POST', path: '/tickets/{id}/resolve' } } } } };
    }
    if (stage === 'workflow') return { input: EDITS.workflow };
    if (stage === 'seed') return { input: EDITS.seed };
    return { input: EDITS.tasks };
  };

  it('asks the plan step to map every input operation, so the model step never routes a path the workflow builds as an action', async () => {
    const { result, events } = await run(Array.from({ length: 12 }, () => liveLike), { input: { kind: 'openapi', path: spec(), only: [] }, digest });
    assert.deepEqual(attempts(events), [['plan', 1, 'rejected'], ['plan', 2, 'accepted'], ['model', 1, 'accepted'], ['workflow', 1, 'accepted'], ['seed', 1, 'accepted'], ['tasks', 1, 'accepted']]);
    const first = events.find((e) => e.t === 'attempt' && e.step === 'plan');
    assert.deepEqual(first?.t === 'attempt' && first.outcome.kind === 'rejected' ? brief(first.outcome.issues) : null, [['plan.not_covered', ['plan', 'routes', RESOLVE]]]);
    assert.equal(events.some((e) => e.t === 'attempt' && e.outcome.kind === 'rejected' && e.outcome.issues.some((i) => i.code === 'route.duplicate_path')), false);
    assert.equal(result.kind, 'done');
  });
});
