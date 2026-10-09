import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chainOf, checkWorld, traceOf, verifySubmission, worldIdOf } from '#engine';
import { changesSince, runtime, type JournalRow, type OriginJournal, type Runtime, type TablesView } from '../src/engine/api.ts';
import type { World } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { gradeDump, verifyTask } from '../src/engine/tasks.ts';
import { seedState } from '../src/engine/store.ts';
import { checkedForTest, minimalWorld } from './helpers/world.ts';

const host = createVmHost();
const TASK = 'resolve_password_ticket';
const TARGET = "{ entity: 'ticket', id: 'tkt_0002', kind: 'updated', fields: ['status'] }";
const guard = (allowed: string): string => `(ctx) => {
  ctx.guardChanges('only declared changes', ${allowed});
  return ctx.db.get('ticket', 'tkt_0002').status === 'resolved' ? 1 : 0;
}`;
function worldWith(grader = guard(`[${TARGET}]`)): World {
  return minimalWorld({ tasks: { [TASK]: { grader } } });
}
function call(rt: Runtime, method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): number {
  return rt.call({ method, path, body, query: {} }).status;
}
function solved(world = worldWith()): Runtime {
  const rt = runtime(checkedForTest(world), host);
  assert.equal(call(rt, 'POST', '/tickets/tkt_0002/resolve'), 200);
  return rt;
}

describe('declared collateral guards', () => {
  it('lets the reference pass and rejects each unrelated target field even with a numeric return', () => {
    for (const patch of [{ subject: 'Overwritten' }, { priority: 'urgent' }]) {
      const world = worldWith();
      const rt = solved(world);
      assert.deepEqual(gradeDump(world, TASK, rt.dump(), host, rt.journal(), rt.log()), {
        ok: true, score: 1, goals: [], guards: [{ name: 'only declared changes', held: true }],
      });
      assert.equal(call(rt, 'PATCH', '/tickets/tkt_0002', patch), 200);
      assert.deepEqual(gradeDump(world, TASK, rt.dump(), host, rt.journal(), rt.log()), {
        ok: true, score: 0, goals: [], guards: [{ name: 'only declared changes', held: false }],
      });
    }
  });

  it('rejects other rows and other entities', () => {
    for (const [path, patch] of [
      ['/tickets/tkt_0001', { subject: 'Overwritten' }],
      ['/customers/cus_0001', { name: 'Overwritten' }],
    ] as const) {
      const rt = solved();
      assert.equal(rt.grade(TASK), 1);
      assert.equal(call(rt, 'PATCH', path, patch), 200);
      assert.equal(rt.grade(TASK), 0);
    }
  });

  it('matches entity and kind as well as row id, and treats wildcards as literal names', () => {
    for (const rule of [
      "{ entity: 'customer', id: 'tkt_0002', kind: 'updated', fields: ['status'] }",
      "{ entity: 'ticket', id: 'tkt_0002', kind: 'created', fields: ['status'] }",
      "{ entity: 'ticket', id: '*', kind: 'updated', fields: ['status'] }",
      "{ entity: 'ticket', id: 'tkt_0002', kind: 'updated', fields: ['*'] }",
    ]) {
      assert.equal(solved(worldWith(guard(`[${rule}]`))).grade(TASK), 0);
    }
    assert.equal(solved().grade(TASK), 1);
  });

  it('permits explicitly declared creation side effects with every data field', () => {
    const extra = "{ entity: 'customer', id: 'cus_0006', kind: 'created', fields: ['name', 'tier'] }";
    const rt = solved(worldWith(guard(`[${TARGET}, ${extra}]`)));
    assert.equal(call(rt, 'POST', '/customers', { name: 'New customer', tier: 'free' }), 201);
    assert.equal(rt.grade(TASK), 1);
    assert.equal(call(rt, 'POST', '/customers', { name: 'Unrelated customer', tier: 'free' }), 201);
    assert.equal(rt.grade(TASK), 0);
  });

  it('does not treat a creation allowance as permission to delete an existing row', () => {
    const fields = "['customer', 'status', 'priority', 'subject', 'sla_due_at']";
    for (const [kind, score] of [['created', 0], ['deleted', 1]] as const) {
      const extra = `{ entity: 'ticket', id: 'tkt_0012', kind: '${kind}', fields: ${fields} }`;
      const rt = solved(worldWith(guard(`[${TARGET}, ${extra}]`)));
      assert.equal(call(rt, 'DELETE', '/tickets/tkt_0012'), 204);
      assert.equal(rt.grade(TASK), score);
    }
  });

  it('an empty declaration permits no changes', () => {
    const rt = runtime(checkedForTest(worldWith("(ctx) => { ctx.guardChanges('unchanged', []); return 1; }")), host);
    assert.equal(rt.grade(TASK), 1);
    assert.equal(call(rt, 'POST', '/tickets/tkt_0002/resolve'), 200);
    assert.equal(rt.grade(TASK), 0);
  });

  it('rejects missing field declarations even when the grader catches the validation error', () => {
    const rt = solved(worldWith(`(ctx) => {
      try { ctx.guardChanges('malformed', [{ entity: 'ticket', id: 'tkt_0002', kind: 'updated' }]); } catch {}
      return 1;
    }`));
    assert.equal(rt.grade(TASK), 0);
  });

  it('rejects malformed names even when name coercion throws and the grader catches it', () => {
    const world = worldWith(`(ctx) => {
      try { ctx.guardChanges({ toString: null, valueOf: null }, []); } catch {}
      return 1;
    }`);
    const rt = solved(world);
    assert.equal(call(rt, 'PATCH', '/tickets/tkt_0002', { subject: 'Unrelated overwrite' }), 200);
    assert.deepEqual(gradeDump(world, TASK, rt.dump(), host, rt.journal(), rt.log()), {
      ok: true, score: 0, goals: [], guards: [{ name: 'invalid collateral guard', held: false }],
    });
  });

  it('excludes automatic job changes and engine timestamps', () => {
    const rt = solved();
    rt.advance('12h');
    assert.equal(rt.grade(TASK), 1);
    assert.equal(call(rt, 'PATCH', '/tickets/tkt_0002', { subject: 'Overwritten after jobs' }), 200);
    assert.equal(rt.grade(TASK), 0);
  });

  it('saved dumps use the same guard without a call trace', () => {
    const world = worldWith();
    const rt = solved(world);
    const good = gradeDump(checkedForTest(world), TASK, rt.dump(), host);
    assert.equal(good.ok && good.score, 1);
    assert.equal(call(rt, 'PATCH', '/tickets/tkt_0002', { priority: 'urgent' }), 200);
    const bad = gradeDump(checkedForTest(world), TASK, rt.dump(), host);
    assert.equal(bad.ok && bad.score, 0);
  });

  it('generated task verification exercises the guard for references and collateral decoys', () => {
    const world = worldWith();
    world.meta.source = 'worldgen';
    const task = world.tasks[TASK];
    if (!task) assert.fail('missing test task');
    const collateral = `(${task.solution})(ctx); ctx.api('PATCH', '/tickets/tkt_0002', { subject: 'Overwritten' });`;
    task.decoys = [{ why: 'solves the task then changes an unrelated field', script: `(ctx) => { ${collateral} }` }];
    const checked = checkWorld(world);
    if (!checked.ok) assert.fail(JSON.stringify(checked.issues));
    assert.equal(checked.verdicts[TASK]?.solution, 1);
    assert.deepEqual(checked.verdicts[TASK]?.decoys, [{ why: 'solves the task then changes an unrelated field', score: 0 }]);
    const seeded = seedState(world, host);
    if (!seeded.ok) assert.fail(seeded.issue.hint);
    task.solution = `(ctx) => { ${collateral} }`;
    task.decoys = [];
    const failed = verifyTask(checkedForTest(world), seeded.state, TASK, host);
    assert.equal(failed.ok, false);
    if (failed.ok) assert.fail('collateral reference must fail verification');
    assert.deepEqual(failed.issues.map((i) => [i.code, i.found]), [
      ['task.solution_not_full_marks', 'solution scored 0'],
    ]);
  });
});

describe('an edit undone before the end still counts as collateral (A-387)', () => {
  /** Acme's tier moved off its seed value and back: the end state is the solution's own, the write trace is not. */
  function undo(rt: Runtime): void {
    assert.equal(call(rt, 'PATCH', '/customers/cus_0001', { tier: 'pro' }), 200);
    assert.equal(call(rt, 'PATCH', '/customers/cus_0001', { tier: 'enterprise' }), 200);
  }
  /** Rejects every stray end value it can see, by comparing rows with seed, so only the write trace shows the undone edit. */
  const END_VALUES_GRADER = `(ctx) => {
    const t = ctx.db.get('ticket', 'tkt_0002');
    if (t === null || t.status !== 'resolved') return 0;
    const same = (entity, fields) => ctx.db.list(entity).length === ctx.seed.list(entity).length && ctx.db.list(entity).every((r) => {
      const was = ctx.seed.get(entity, r.id);
      return was !== null && fields.every((f) => (r.id === 'tkt_0002' && f === 'status') || r[f] === was[f]);
    });
    return same('customer', ['name', 'tier']) && same('ticket', ['customer', 'subject', 'priority', 'status']) ? 1 : 0;
  }`;

  it('changesSince counts what calls wrote, but not a write that changed nothing or a row a job created and a call deleted', () => {
    const at = '2026-01-05T09:00:00.000Z' as OriginJournal[number]['at'];
    const seed = { tables: { ticket: [{ id: 'tkt_0001', subject: 'Printer', priority: 'low' }], alert: [] } } as unknown as TablesView;
    const journal: OriginJournal = [
      { origin: 'job', source: 'raise_alert', at, rows: [{ entity: 'alert', id: 'alr_0001', kind: 'created', fields: ['message'] }] },
      { origin: 'call', source: 'delete_alert', at, rows: [{ entity: 'alert', id: 'alr_0001', kind: 'deleted', fields: ['message'] }] },
      { origin: 'call', source: 'update_ticket', at, rows: [{ entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: [] }] },
    ];
    const calls = (j: OriginJournal): JournalRow[] => j.filter((e) => e.origin === 'call').flatMap((e) => e.rows);
    assert.deepEqual(changesSince(seed, seed, journal, calls(journal)), []);
    const undone: OriginJournal = [...journal,
      { origin: 'call', source: 'update_ticket', at, rows: [{ entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['priority'] }] },
      { origin: 'call', source: 'update_ticket', at, rows: [{ entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['priority'] }] },
    ];
    assert.deepEqual(changesSince(seed, seed, undone, calls(undone)), [{ entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['priority'], origin: 'call' }]);
    assert.deepEqual(changesSince(seed, seed, undone), []);
  });

  it('a write that resends the value a row already holds is no collateral', () => {
    const world = worldWith();
    const rt = solved(world);
    const subject = (rt.call({ method: 'GET', path: '/tickets/tkt_0001', query: {}, body: undefined }).body as { subject: string }).subject;
    assert.equal(call(rt, 'PATCH', '/tickets/tkt_0001', { subject }), 200);
    assert.equal(rt.grade(TASK), 1);
  });

  it('ctx.guardChanges scores 0 for the solution plus an edit it undoes', () => {
    const world = worldWith();
    const rt = solved(world);
    undo(rt);
    assert.deepEqual(gradeDump(world, TASK, rt.dump(), host, rt.journal(), rt.log()), {
      ok: true, score: 0, goals: [], guards: [{ name: 'only declared changes', held: false }],
    });
  });

  it("the engine's guard over a task's allows scores it 0 in runtime grading, the path of POST /_world/grade", () => {
    const world = minimalWorld({ tasks: { [TASK]: {
      grader: "(ctx) => (ctx.db.get('ticket', 'tkt_0002').status === 'resolved' ? 1 : 0)",
      allows: [{ entity: 'ticket', kind: 'updated', fields: ['status'] }],
    } } });
    const rt = solved(world);
    assert.equal(rt.grade(TASK), 1);
    undo(rt);
    assert.equal(rt.grade(TASK), 0);
  });

  it("the verifier's replay of the recorded trace scores it 0", () => {
    const world = checkedForTest(worldWith());
    const rt = solved(world);
    undo(rt);
    const held = { wid: worldIdOf(world), worldVersion: 'a'.repeat(64), engine: 'test-engine' };
    const trace = traceOf(rt.log());
    const request = { protocol: 1, submission: 'sub-undone', task: TASK, ...held, trace, chain: chainOf(trace), state: rt.dump() };
    assert.deepEqual(verifySubmission(world, held, JSON.stringify(request), new Set()).verdict, { task: TASK, wid: held.wid, score: 0, stop: 'graded' });
  });

  it('without a journal or a call log the guards see only the end state, and the score says so', () => {
    const world = worldWith();
    const rt = solved(world);
    undo(rt);
    assert.deepEqual(gradeDump(world, TASK, rt.dump(), host), {
      ok: true, score: 1, goals: [], guards: [{ name: 'only declared changes', held: true }],
      caveat: 'no journal or call log given, so ctx.changes() and the collateral guards saw only the end state; an edit undone before it was not judged',
    });
  });

  it('verifyTask catches a grader that judges only end values, through the undone_write mutant', () => {
    const world = minimalWorld({ tasks: { [TASK]: { grader: END_VALUES_GRADER } } });
    const seeded = seedState(world, host);
    if (!seeded.ok) assert.fail(seeded.issue.hint);
    const r = verifyTask(checkedForTest(world), seeded.state, TASK, host);
    if (r.ok) assert.fail('an end-values grader must fail the undone_write mutant');
    assert.deepEqual(r.issues.map((i) => [i.code, i.path.join('.'), i.found]), [
      ['task.mutant_full_marks', `tasks.${TASK}.grader`, 'the solution plus PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"} scored 1'],
    ]);
  });

  it('a guarded grader passes, and its verdict records the undone_write probe at 0', () => {
    const world = worldWith();
    const seeded = seedState(world, host);
    if (!seeded.ok) assert.fail(seeded.issue.hint);
    const r = verifyTask(checkedForTest(world), seeded.state, TASK, host);
    if (!r.ok) assert.fail(JSON.stringify(r.issues));
    assert.deepEqual(r.verdict.collateral.find((p) => p.kind === 'undone_write'), {
      kind: 'undone_write', call: 'PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"}', score: 0,
    });
  });
});

describe('free text a grader never reads (A-388)', () => {
  const RENAME = 'rename_password_ticket';
  const SOLUTION = `(ctx) => {
    const r = ctx.api('PATCH', '/tickets/tkt_0002', { subject: 'Password reset loop (VIP)' });
    ctx.assert(r.status === 200, 'rename failed');
  }`;
  const graderThat = (check: string): string => `(ctx) => {
    ctx.guardChanges('only the subject', [{ entity: 'ticket', id: 'tkt_0002', kind: 'updated', fields: ['subject'] }]);
    const subject = ctx.db.get('ticket', 'tkt_0002').subject;
    return ${check} ? 1 : 0;
  }`;
  function verifyRename(grader: string) {
    const world = minimalWorld({ tasks: { [RENAME]: { difficulty: 'easy', instruction: 'Rename ticket tkt_0002 to "Password reset loop (VIP)".', grader, solution: SOLUTION, decoys: [], alternatives: [] } } });
    const seeded = seedState(world, host);
    if (!seeded.ok) assert.fail(seeded.issue.hint);
    return verifyTask(checkedForTest(world), seeded.state, RENAME, host);
  }

  it('flags a grader that accepts any new subject: nonsense as long as the real text still scores 1', () => {
    const r = verifyRename(graderThat("subject !== ctx.seed.get('ticket', 'tkt_0002').subject"));
    if (r.ok) assert.fail('a grader that never reads the subject must fail the free-text probe');
    assert.deepEqual(r.issues.map((i) => [i.code, i.path.join('.'), i.found]), [
      ['task.freetext_unchecked', `tasks.${RENAME}.grader`, 'the solution with PATCH /tickets/tkt_0002 with subject "bananas bananas bananas b" scored 1'],
    ]);
    assert.equal(r.issues[0]?.hint.includes('the grader never reads ticket.subject'), true);
  });

  it('passes a grader that checks the text the instruction asks for', () => {
    const r = verifyRename(graderThat("subject === 'Password reset loop (VIP)'"));
    if (!r.ok) assert.fail(JSON.stringify(r.issues));
    assert.equal(r.verdict.solution, 1);
  });
});
