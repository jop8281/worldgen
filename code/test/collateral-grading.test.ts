import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWorld } from '#engine';
import { runtime, type Runtime } from '../src/engine/api.ts';
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
