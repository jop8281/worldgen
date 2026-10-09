/**
 * Trace-aware grading (YOS-82, design law L7): graders score V(seed, trace, end). Covers
 * ctx.trace(), ctx.goal, ctx.guard and ctx.score, and that verifyTask, gradeDump and
 * Runtime.grade grade each run with its own trace.
 *
 * The world is inline and tiny: invoices that a PATCH can refund or dispute. Refunding then
 * disputing and disputing then refunding end in the same state, so only the trace tells them apart.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime, type Runtime } from '../src/engine/api.ts';
import { emptyWorld, worldSchema, type World } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { seedState, stateHash, type State } from '../src/engine/store.ts';
import { clientCtx, grade, gradeDump, stateFromDump, traceOf, verifyTask } from '../src/engine/tasks.ts';
import { checkedForTest } from './helpers/world.ts';

const host = createVmHost();
const TASK = 'refund_then_dispute';
const T = (s: string): string => `2026-01-01T00:00:${s}.000Z`;

/** The history guard: no write refunds the Acme invoice after a write disputed it. */
const HISTORY_GRADER = `(ctx) => {
  const inv = ctx.seed.list('invoice', { where: { customer: 'Acme' } })[0];
  if (!inv) return 0;
  let disputed = false;
  let refundAfterDispute = false;
  for (const c of ctx.trace()) {
    for (const w of c.writes) {
      if (w.entity !== 'invoice' || w.id !== inv.id) continue;
      if (disputed && w.fields.includes('refunded')) refundAfterDispute = true;
      if (w.fields.includes('disputed')) disputed = true;
    }
  }
  ctx.guard('no refund after dispute', !refundAfterDispute);
  ctx.guard('only the Acme invoice changed', ctx.changes().every((c) => c.id === inv.id && c.fields.every((f) => f === 'refunded' || f === 'disputed')));
  const end = ctx.db.get('invoice', inv.id);
  ctx.goal(0.5, 'refunded', end.refunded === true);
  ctx.goal(0.5, 'disputed', end.disputed === true);
  return ctx.score();
}`;

/** The same end-state checks as a plain number, with no trace. */
const NUMERIC_GRADER = `(ctx) => {
  const inv = ctx.seed.list('invoice', { where: { customer: 'Acme' } })[0];
  const end = ctx.db.get('invoice', inv.id);
  return (end.refunded ? 0.5 : 0) + (end.disputed ? 0.5 : 0);
}`;

const script = (first: 'refunded' | 'disputed', second: 'refunded' | 'disputed'): string => `(ctx) => {
  const inv = ctx.api('GET', '/invoices?customer=Acme').body.data[0];
  ctx.assert(inv, 'no Acme invoice');
  ctx.assert(ctx.api('PATCH', '/invoices/' + inv.id, { ${first}: true }).status === 200, '${first} failed');
  ctx.assert(ctx.api('PATCH', '/invoices/' + inv.id, { ${second}: true }).status === 200, '${second} failed');
}`;
const SOLUTION = script('refunded', 'disputed');
const WRONG_ORDER = script('disputed', 'refunded');
const WRONG_WHY = 'disputes the invoice first and refunds it afterwards, so it refunds a disputed invoice';

function invoiceWorld(grader: string = HISTORY_GRADER): World {
  const base = emptyWorld('invoices', 'hand');
  return worldSchema.parse({
    ...base,
    meta: {
      ...base.meta,
      description: 'Invoices a support agent can refund and dispute.',
      resembles: 'a small billing API',
      seed: 1,
      clock: { start: T('00'), tick: '1s' },
    },
    entities: {
      invoice: {
        description: 'A bill sent to a customer.',
        idPrefix: 'inv',
        fields: {
          customer: { type: 'string', required: true },
          amount: { type: 'int', required: true, min: 0 },
          refunded: { type: 'bool', required: true, default: false },
          disputed: { type: 'bool', required: true, default: false },
        },
      },
    },
    routes: {
      list_invoices: { op: 'list', entity: 'invoice', method: 'GET', path: '/invoices', filters: ['customer'] },
      get_invoice: { op: 'get', entity: 'invoice', method: 'GET', path: '/invoices/{id}' },
      update_invoice: { op: 'update', entity: 'invoice', method: 'PATCH', path: '/invoices/{id}' },
    },
    seed: {
      invoice: `(ctx) => [
        { customer: 'Acme', amount: 120, refunded: false, disputed: false },
        { customer: 'Globex', amount: 80, refunded: false, disputed: false },
      ]`,
    },
    tasks: {
      [TASK]: {
        difficulty: 'medium',
        instruction: 'Acme disputes its invoice and wants its money back. Refund the invoice, then mark it disputed. Never refund a disputed invoice.',
        grader,
        solution: SOLUTION,
        decoys: [{ why: WRONG_WHY, script: WRONG_ORDER }],
      },
    },
  });
}

/** invoiceWorld with the task's grader replaced. */
const withGrader = (grader: string): World => invoiceWorld(grader);

function seeded(world: World): State {
  const r = seedState(world, host);
  if (!r.ok) throw new Error(`seed failed: ${r.issue.code}`);
  return r.state;
}

/** A runtime from the seeded state at clock.start, after running `source` as a client script. */
function ran(world: World, source: string): Runtime {
  const rt = runtime(checkedForTest(world), host);
  const compiled = host.compile('client', source, ['tasks', TASK, 'solution']);
  if (!compiled.ok) throw new Error(compiled.issue.hint);
  const { ctx, failed } = clientCtx(rt);
  compiled.run(ctx);
  assert.equal(failed(), null);
  return rt;
}

function scored(world: World, rt: Runtime, withTrace: boolean) {
  const end = stateFromDump(world, rt.dump());
  return grade(world, seeded(world), end, TASK, host, rt.journal(), withTrace ? rt.log() : []);
}

describe('ctx.trace()', () => {
  it('lists the successful calls in order, each with its seq, request and the rows it wrote', () => {
    const w = invoiceWorld();
    const rt = runtime(checkedForTest(w), host);
    assert.equal(rt.call({ method: 'GET', path: '/invoices', query: {}, body: undefined }).status, 200);
    assert.equal(rt.call({ method: 'PATCH', path: '/invoices/inv_9999', query: {}, body: { refunded: true } }).status, 404);
    assert.equal(rt.call({ method: 'PATCH', path: '/invoices/inv_0001', query: {}, body: { refunded: true } }).status, 200);
    const expected = [
      { seq: 1, method: 'GET', path: '/invoices', status: 200, routeId: 'list_invoices', at: T('00'), body: null, writes: [] },
      {
        seq: 3, method: 'PATCH', path: '/invoices/inv_0001', status: 200, routeId: 'update_invoice', at: T('01'), body: { refunded: true },
        writes: [{ entity: 'invoice', id: 'inv_0001', kind: 'updated', fields: ['refunded'] }],
      },
    ];
    assert.deepEqual(traceOf(rt.log()), expected);

    // The grader sees exactly that trace through the sandbox.
    const g = withGrader(`(ctx) => JSON.stringify(ctx.trace()) === ${JSON.stringify(JSON.stringify(expected))} ? 1 : 0`);
    assert.deepEqual(grade(g, seeded(g), stateFromDump(g, rt.dump()), TASK, host, rt.journal(), rt.log()), { ok: true, score: 1 });
  });

  it('is empty on the untouched seed and when no log is given', () => {
    const g = withGrader('(ctx) => ctx.trace().length === 0 ? 0 : 1');
    assert.deepEqual(grade(g, seeded(g), seeded(g), TASK, host), { ok: true, score: 0 });
    const rt = ran(g, SOLUTION);
    assert.deepEqual(grade(g, seeded(g), stateFromDump(g, rt.dump()), TASK, host, rt.journal()), { ok: true, score: 0 });
    assert.deepEqual(grade(g, seeded(g), stateFromDump(g, rt.dump()), TASK, host, rt.journal(), rt.log()), { ok: true, score: 1 });
  });
});

describe('history guards', () => {
  it('fail a run that writes in the wrong order although its end state matches the solution', () => {
    const w = invoiceWorld();
    const right = ran(w, SOLUTION);
    const wrong = ran(w, WRONG_ORDER);
    assert.equal(stateHash(stateFromDump(w, wrong.dump())), stateHash(stateFromDump(w, right.dump())));

    assert.deepEqual(scored(w, right, true), {
      ok: true,
      score: 1,
      goals: [{ name: 'refunded', weight: 0.5, met: true }, { name: 'disputed', weight: 0.5, met: true }],
      guards: [{ name: 'no refund after dispute', held: true }, { name: 'only the Acme invoice changed', held: true }],
    });
    assert.deepEqual(scored(w, wrong, true), {
      ok: true,
      score: 0,
      goals: [{ name: 'refunded', weight: 0.5, met: true }, { name: 'disputed', weight: 0.5, met: true }],
      guards: [{ name: 'no refund after dispute', held: false }, { name: 'only the Acme invoice changed', held: true }],
    });
    // Without the trace the end state alone cannot tell them apart.
    const blind = scored(w, wrong, false);
    assert.equal(blind.ok && blind.score, 1);
  });

  it('Runtime.grade passes the runtime trace, so POST /_world/grade sees the history', () => {
    const w = invoiceWorld();
    assert.equal(ran(w, SOLUTION).grade(TASK), 1);
    assert.equal(ran(w, WRONG_ORDER).grade(TASK), 0);
    const rt = ran(w, WRONG_ORDER);
    rt.reset();
    assert.equal(rt.grade(TASK), 0);
  });

  it('gradeDump uses a saved call log, and warns when a trace-reading grader gets none', () => {
    const w = invoiceWorld();
    const wrong = ran(w, WRONG_ORDER);
    assert.deepEqual(gradeDump(w, TASK, wrong.dump(), host, wrong.journal(), wrong.log()), {
      ok: true,
      score: 0,
      goals: [{ name: 'refunded', weight: 0.5, met: true }, { name: 'disputed', weight: 0.5, met: true }],
      guards: [{ name: 'no refund after dispute', held: false }, { name: 'only the Acme invoice changed', held: true }],
    });
    const blind = gradeDump(w, TASK, wrong.dump(), host, wrong.journal());
    assert.equal(blind.ok && blind.score, 1);
    assert.equal(
      blind.ok && blind.caveat,
      'no call log given, so ctx.trace() was empty; a history guard judged this state as if no call had been made',
    );
    // The log entries carry each call's writes, so a log alone is a full trace: no journal, no caveat.
    const noJournal = gradeDump(w, TASK, wrong.dump(), host, undefined, wrong.log());
    assert.equal(noJournal.ok && noJournal.score, 0);
    assert.equal(noJournal.ok && noJournal.caveat, undefined);
    // A grader that never reads the trace gets no trace caveat (this world has no jobs).
    const n = withGrader(NUMERIC_GRADER);
    assert.deepEqual(gradeDump(n, TASK, ran(n, WRONG_ORDER).dump(), host), { ok: true, score: 1 });
  });
});

describe('goals, guards and score', () => {
  it('score is the sum of met goal weights, rounded so 0.1 + 0.2 + 0.7 is exactly 1', () => {
    const all = withGrader("(ctx) => { ctx.goal(0.1, 'a', true); ctx.goal(0.2, 'b', 1); ctx.goal(0.7, 'c', 'yes'); return ctx.score(); }");
    const r = grade(all, seeded(all), seeded(all), TASK, host);
    assert.equal(r.ok && r.score, 1);
    const some = withGrader("(ctx) => { ctx.goal(0.1, 'a', true); ctx.goal(0.2, 'b', true); ctx.goal(0.7, 'c', null); return ctx.score(); }");
    assert.deepEqual(grade(some, seeded(some), seeded(some), TASK, host), {
      ok: true,
      score: 0.3,
      goals: [{ name: 'a', weight: 0.1, met: true }, { name: 'b', weight: 0.2, met: true }, { name: 'c', weight: 0.7, met: false }],
      guards: [],
    });
  });

  it('goal and guard return whether their condition holds', () => {
    const g = withGrader("(ctx) => ctx.goal(1, 'g', 0) === false && ctx.guard('h', 'x') === true ? 0.25 : 0.75");
    const r = grade(g, seeded(g), seeded(g), TASK, host);
    assert.equal(r.ok && r.score, 0.25);
  });

  it('a failed guard makes the score 0 even when the grader returns its own number', () => {
    const g = withGrader("(ctx) => { ctx.guard('never', false); return 1; }");
    assert.deepEqual(grade(g, seeded(g), seeded(g), TASK, host), { ok: true, score: 0, goals: [], guards: [{ name: 'never', held: false }] });
  });

  for (const weight of ['0', '-0.5', '2', 'NaN', "'0.5'"]) {
    it(`a goal weight of ${weight} is snippet.runtime_error at the grader`, () => {
      const g = withGrader(`(ctx) => { ctx.goal(${weight}, 'bad', true); return ctx.score(); }`);
      const r = grade(g, seeded(g), seeded(g), TASK, host);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.issue.code, 'snippet.runtime_error');
      assert.deepEqual(r.issue.path, ['tasks', TASK, 'grader']);
      assert.match(`${r.issue.found} ${r.issue.hint}`, /ctx\.goal weight must be a number above 0 and at most 1/);
    });
  }

  it('a plain numeric grader keeps its score and gains no goals or guards', () => {
    const n = withGrader(NUMERIC_GRADER);
    const rt = ran(n, script('refunded', 'refunded'));
    assert.deepEqual(grade(n, seeded(n), stateFromDump(n, rt.dump()), TASK, host, rt.journal(), rt.log()), { ok: true, score: 0.5 });
    assert.deepEqual(grade(n, seeded(n), seeded(n), TASK, host), { ok: true, score: 0 });
  });
});

describe('verifyTask grades every run with its own trace', () => {
  it('passes a task whose decoy ends like the solution but breaks the history guard', () => {
    const w = invoiceWorld();
    const r = verifyTask(checkedForTest(w), seeded(w), TASK, host);
    if (!r.ok) assert.fail(r.issues.map((i) => `${i.code} ${i.path.join('.')} ${i.found}`).join('; '));
    assert.deepEqual(r.verdict.decoys, [{ why: WRONG_WHY, score: 0 }]);
    // The one strict prefix (refunded only) is graded with its own one-write trace.
    assert.equal(r.verdict.bestPrefixScore, 0.5);
    assert.equal(r.verdict.solutionCalls, 3);
  });

  it('still calls that decoy trivial when the grader judges the end state only', () => {
    const n = withGrader(NUMERIC_GRADER);
    const r = verifyTask(checkedForTest(n), seeded(n), TASK, host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.map((i) => [i.code, i.path, i.found]), [
      ['task.decoy_trivial', ['tasks', TASK, 'decoys', 0], 'ends in the same state as the solution'],
      ['task.mutant_full_marks', ['tasks', TASK, 'grader'], 'the solution plus PATCH /invoices/inv_0001 {"customer":"Globex"} scored 1'],
      ['task.mutant_full_marks', ['tasks', TASK, 'grader'], 'the solution plus PATCH /invoices/inv_0002 {"disputed":true} scored 1'],
      ['task.mutant_full_marks', ['tasks', TASK, 'grader'], 'the solution plus PATCH /invoices/inv_0002 {"customer":"Acme"} then {"customer":"Globex"} scored 1'],
    ]);
  });
});
