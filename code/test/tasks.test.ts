/**
 * Grading and task verification (engine-grade-verify-basic). Each case names the requirement
 * it proves (R1..R9 in the unit spec).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime, type Runtime } from '../src/engine/api.ts';
import { check, type CheckReport } from '../src/engine/check.ts';
import type { SnippetHost } from '../src/engine/ctx.ts';
import type { World } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { seedState, stateHash, type State } from '../src/engine/store.ts';
import { grade, gradeDump, stateFromDump, verifyTask } from '../src/engine/tasks.ts';
import { checkedForTest, minimalWorld } from './helpers/world.ts';

const host = createVmHost();

/** minimalWorld's easy grader, proven present: minimalWorld is the private form (YOS-159). */
const EASY_GRADER = minimalWorld().tasks.resolve_password_ticket?.grader ?? assert.fail('minimalWorld carries no easy grader');

function seeded(world: World): State {
  const r = seedState(world, host);
  if (!r.ok) throw new Error(`seed failed: ${r.issue.code}`);
  return r.state;
}

function failed(report: CheckReport): Extract<CheckReport, { ok: false }> {
  if (report.ok) throw new Error('expected a failed report');
  return report;
}

/** A runtime over minimalWorld (or a variant), typed through checkedForTest. */
function rtOf(world: World = minimalWorld()): Runtime {
  return runtime(checkedForTest(world), host);
}

/** minimalWorld with only one task, whose grader is `grader`. */
function oneTask(grader: string, solution?: string): World {
  const w = minimalWorld({ tasks: { resolve_initech_pending: null, escalate_acme: null } });
  w.tasks.resolve_password_ticket!.grader = grader;
  if (solution !== undefined) w.tasks.resolve_password_ticket!.solution = solution;
  return w;
}

/** The end state after resolving tkt_0002 (the easy task's target), rebuilt from a runtime dump. */
function resolvedEasy(world: World): State {
  const rt = rtOf(world);
  assert.equal(rt.call({ method: 'POST', path: '/tickets/tkt_0002/resolve', query: {}, body: undefined }).status, 200);
  return stateFromDump(world, rt.dump());
}

describe('grade (R1)', () => {
  it('R1 scores the easy task 1 on its end state and 0 on the seed', () => {
    const w = minimalWorld();
    const seed = seeded(w);
    assert.deepEqual(grade(w, seed, resolvedEasy(w), 'resolve_password_ticket', host), { ok: true, score: 1 });
    assert.deepEqual(grade(w, seed, seed, 'resolve_password_ticket', host), { ok: true, score: 0 });
  });

  it('R1 gives the grader db (end), seed (start), now (end time) and time', () => {
    const w = oneTask(`(ctx) => {
      const endT = ctx.db.get('ticket', 'tkt_0002');
      const seedT = ctx.seed.get('ticket', 'tkt_0002');
      if (endT.status !== 'resolved' || seedT.status !== 'pending') return 0;
      if (ctx.now() !== '2026-01-01T00:00:01.000Z') return 0.25;
      if (ctx.time.plus(ctx.now(), '1h') !== '2026-01-01T01:00:01.000Z') return 0.5;
      return 1;
    }`);
    w.meta.clock.start = '2026-01-01T00:00:00.000Z';
    const seed = seeded(w);
    assert.deepEqual(grade(w, seed, resolvedEasy(w), 'resolve_password_ticket', host), { ok: true, score: 1 });
  });

  for (const [label, src, found] of [
    ['above 1', '(ctx) => 1.5', '1.5'],
    ['below 0', '(ctx) => -0.1', '-0.1'],
    ['NaN', '(ctx) => NaN', 'NaN'],
    ['a boolean', '(ctx) => true', 'true'],
    ['a string', "(ctx) => '1'", '"1"'],
  ] as const) {
    it(`R1 a grader returning ${label} yields task.grader_out_of_range`, () => {
      const w = oneTask(src);
      const r = grade(w, seeded(w), seeded(w), 'resolve_password_ticket', host);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.issue.code, 'task.grader_out_of_range');
      assert.deepEqual(r.issue.path, ['tasks', 'resolve_password_ticket', 'grader']);
      assert.equal(r.issue.found, found);
    });
  }

  it('R1 accepts the bounds 0 and 1 exactly', () => {
    const w = oneTask('(ctx) => 0');
    assert.deepEqual(grade(w, seeded(w), seeded(w), 'resolve_password_ticket', host), { ok: true, score: 0 });
  });

  it('R1 a grader that throws yields snippet.runtime_error at its path', () => {
    const w = oneTask("(ctx) => { throw new Error('boom'); }");
    const r = grade(w, seeded(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.issue.code, 'snippet.runtime_error');
    assert.deepEqual(r.issue.path, ['tasks', 'resolve_password_ticket', 'grader']);
  });

  it('R1 an unknown task id yields ref.unknown at its path', () => {
    const w = minimalWorld();
    const r = grade(w, seeded(w), seeded(w), 'nope', host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.issue.code, 'ref.unknown');
    assert.deepEqual(r.issue.path, ['tasks', 'nope']);
  });
});

describe('ctx.changes (R2)', () => {
  /** A grader that reports what changes() returns by throwing it as JSON. */
  const REPORT = `(ctx) => {
    throw new Error(JSON.stringify({
      plain: ctx.changes(),
      jobs: ctx.changes({ includeJobs: true }),
      ignored: ctx.changes({ ignore: ['customer'] }),
    }));
  }`;

  it('R2 lists created, updated and deleted rows with origin, without updated_at, jobs only on request', () => {
    const w = oneTask(REPORT);
    w.meta.clock.start = '2026-01-01T00:00:00.000Z';
    const rt = rtOf(w);
    const call = (method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): number =>
      rt.call({ method, path, query: {}, body }).status;
    assert.equal(call('POST', '/customers', { name: 'Soylent', tier: 'free' }), 201);
    assert.equal(call('PATCH', '/tickets/tkt_0002', { subject: 'Password reset loop again' }), 200);
    assert.equal(call('DELETE', '/tickets/tkt_0011'), 204);
    // Tickets due at +2h (tkt_0001, tkt_0005, tkt_0009) become overdue; tkt_0009 is already urgent.
    assert.deepEqual(rt.advance('3h').jobsFailed, []);
    let message = '';
    assert.throws(() => rt.grade('resolve_password_ticket'), (e: Error) => {
      message = e.message;
      return true;
    });
    const json = message.slice(message.indexOf('{'));
    const got = JSON.parse(json) as Record<string, unknown>;
    const created = { entity: 'customer', id: 'cus_0006', kind: 'created', fields: ['name', 'tier'], origin: 'call' };
    const updated = { entity: 'ticket', id: 'tkt_0002', kind: 'updated', fields: ['subject'], origin: 'call' };
    const deleted = {
      entity: 'ticket', id: 'tkt_0011', kind: 'deleted', fields: ['customer', 'subject', 'priority', 'status', 'sla_due_at'], origin: 'call',
    };
    const job1 = { entity: 'ticket', id: 'tkt_0001', kind: 'updated', fields: ['priority'], origin: 'job' };
    const job5 = { entity: 'ticket', id: 'tkt_0005', kind: 'updated', fields: ['priority'], origin: 'job' };
    assert.deepEqual(got['plain'], [created, updated, deleted]);
    assert.deepEqual(got['jobs'], [created, job1, updated, job5, deleted]);
    assert.deepEqual(got['ignored'], [updated, deleted]);
  });

  it('R2 is empty on the untouched seed', () => {
    const w = oneTask('(ctx) => ctx.changes().length === 0 && ctx.changes({ includeJobs: true }).length === 0 ? 0 : 1');
    assert.deepEqual(grade(w, seeded(w), seeded(w), 'resolve_password_ticket', host), { ok: true, score: 0 });
  });
});

describe('verifyTask (R3, R4, R7)', () => {
  it('R3 mints a verdict for the easy task: solution 1, noop 0', () => {
    const w = minimalWorld();
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { endStateHash, collateral, ...rest } = r.verdict;
    assert.match(endStateHash, /^[0-9a-f]{32}$/);
    assert.equal(collateral.length, 7);
    assert.deepEqual(rest, {
      taskId: 'resolve_password_ticket', difficulty: 'easy', solution: 1, noop: 0, decoys: [], bestPrefixScore: null, solutionCalls: 2, solutionWrites: 1, solutionReadsBeforeWrite: 1, solutionPagedEntities: [], solutionRowsChanged: 1, solutionLaterPageEntities: [], solutionDistractorEntities: [],
      checks: [{ check: 'return', flippedBy: ['target_field', 'other_row', 'extra_create', 'extra_delete', 'retarget'] }], unattributedProbes: [],
    });
    assert.deepEqual(r.log.map((c) => c.routeId), ['list_tickets', 'resolve_ticket']);
  });

  it('R3 a solution scoring below 1 yields task.solution_not_full_marks with the score', () => {
    const w = oneTask("(ctx) => ctx.db.get('ticket', 'tkt_0002').status === 'resolved' ? 0.5 : 0");
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.map((i) => [i.code, i.path, i.found]), [
      ['task.solution_not_full_marks', ['tasks', 'resolve_password_ticket'], 'solution scored 0.5'],
    ]);
  });

  it('R3 a grader that passes on the seed yields task.noop_not_zero with the score', () => {
    const w = oneTask("(ctx) => ctx.db.get('ticket', 'tkt_0002').status === 'resolved' ? 1 : 0.25");
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.map((i) => [i.code, i.path, i.found]), [
      ['task.noop_not_zero', ['tasks', 'resolve_password_ticket'], 'doing nothing scored 0.25'],
    ]);
  });

  it('R3 a grader that always returns 1 fails only the noop gate', () => {
    const w = oneTask('(ctx) => 1');
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.map((i) => i.code), ['task.noop_not_zero']);
  });

  it('R4 a solution that ends in a different state on replay yields task.nondeterministic', () => {
    const w = minimalWorld();
    let runs = 0;
    // A host whose solution creates a differently named customer on each run.
    const flaky: SnippetHost = {
      compile(kind, source, path) {
        if (kind !== 'client' || path[2] !== 'solution' || path[1] !== 'resolve_password_ticket') return host.compile(kind, source, path);
        const real = host.compile('client', source, path);
        if (!real.ok) return real;
        const run = (ctx: Parameters<typeof real.run>[0]): void => {
          runs += 1;
          real.run(ctx);
          ctx.api('POST', '/customers', { name: `Flaky ${runs}`, tier: 'free' });
        };
        return { ok: true, run } as ReturnType<SnippetHost['compile']>;
      },
    } as SnippetHost;
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', flaky);
    assert.equal(runs, 2);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [
      ['task.nondeterministic', ['tasks', 'resolve_password_ticket', 'solution']],
      ['task.solution_not_full_marks', ['tasks', 'resolve_password_ticket']],
    ]);
  });

  for (const [label, solution] of [
    ['ctx.db', "(ctx) => { ctx.db.update('ticket', 'tkt_0002', { status: 'resolved' }); }"],
    ['ctx.seed', "(ctx) => { ctx.seed.get('ticket', 'tkt_0002'); }"],
    ['ctx.changes', '(ctx) => { ctx.changes(); }'],
    ['ctx.fail', "(ctx) => { ctx.fail(400, 'x', 'y'); }"],
  ] as const) {
    it(`R7 a solution calling ${label} fails with snippet.runtime_error at the solution path`, () => {
      const w = oneTask(EASY_GRADER, solution);
      const r = failed(check(w, host));
      assert.equal(r.reached, 'tasks');
      // The one-task world also fails the task count, reported after the task's own issue (YOS-113).
      assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['snippet.runtime_error', ['tasks', 'resolve_password_ticket', 'solution']], ['world.too_few_tasks', ['tasks']]]);
    });
  }

  it('R7 a solution that fails an assert yields snippet.runtime_error with the assert message', () => {
    const w = oneTask(EASY_GRADER, "(ctx) => { ctx.assert(false, 'no luck'); }");
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map((i) => [i.code, i.path, i.hint]), [
      ['snippet.runtime_error', ['tasks', 'resolve_password_ticket', 'solution'], 'ctx.assert failed: no luck'],
      ['world.too_few_tasks', ['tasks'], 'The world has 1.'],
    ]);
  });

  it('R7 solution calls go through handle(): enforcement refuses an illegal transition', () => {
    // open -> resolved is not a declared transition, so the API answers 422 and nothing changes.
    const w = oneTask(
      "(ctx) => ctx.db.get('ticket', 'tkt_0001').status === 'resolved' ? 1 : 0",
      "(ctx) => { const r = ctx.api('PATCH', '/tickets/tkt_0001', { status: 'resolved' }); ctx.assert(r.status === 422, 'got ' + r.status); }",
    );
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.map((i) => [i.code, i.found]), [['task.solution_not_full_marks', 'solution scored 0']]);
  });
});

describe('check tasks layer (R5, R9)', () => {
  it('R9 check(minimalWorld()) is ok with three verdicts, each solution 1 and noop 0', () => {
    const r = check(minimalWorld(), host);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(Object.keys(r.verdicts), ['resolve_password_ticket', 'resolve_initech_pending', 'escalate_acme']);
    const brief = Object.values(r.verdicts).map((v) => [v.taskId, v.difficulty, v.solution, v.noop, v.solutionCalls]);
    assert.deepEqual(brief, [
      ['resolve_password_ticket', 'easy', 1, 0, 2],
      ['resolve_initech_pending', 'medium', 1, 0, 4],
      ['escalate_acme', 'hard', 1, 0, 5],
    ]);
  });

  it('R5 solution calls count as exercising actions', () => {
    const r = check(minimalWorld(), host);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.stats.unexercisedActions, []);
  });

  it('R5 a world with one verified task fails the tasks layer with world.too_few_tasks (PR #52, YOS-113)', () => {
    const r = failed(check(oneTask(EASY_GRADER), host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(r.issues.map((i) => [i.code, i.path, i.found]), [['world.too_few_tasks', ['tasks'], '1 task']]);
  });

  it('R5 a failing task stops the report at the tasks layer with its issues, then the task count (YOS-113)', () => {
    const r = failed(check(oneTask('(ctx) => 1'), host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['task.noop_not_zero', ['tasks', 'resolve_password_ticket']], ['world.too_few_tasks', ['tasks']]]);
  });
});

describe('Runtime.grade (R6)', () => {
  it('R6 scores the current state against the seed', () => {
    const rt = rtOf();
    assert.equal(rt.grade('resolve_password_ticket'), 0);
    assert.equal(rt.call({ method: 'POST', path: '/tickets/tkt_0002/resolve', query: {}, body: undefined }).status, 200);
    assert.equal(rt.grade('resolve_password_ticket'), 1);
    assert.equal(rt.call({ method: 'PATCH', path: '/tickets/tkt_0004', query: {}, body: { priority: 'low' } }).status, 200);
    assert.equal(rt.grade('resolve_password_ticket'), 0.5);
    rt.reset();
    assert.equal(rt.grade('resolve_password_ticket'), 0);
  });

  it('R6 throws an error naming the issue for an unknown task', () => {
    assert.throws(() => rtOf().grade('nope'), /ref\.unknown/);
  });
});

describe('gradeDump (R8)', () => {
  it('R8 grades the seed dump 0 and the solution end dump 1, also after a JSON round trip', () => {
    const w = minimalWorld();
    const rt = rtOf(w);
    assert.deepEqual(gradeDump(w, 'resolve_initech_pending', rt.dump(), host), { ok: true, score: 0 });
    for (const id of ['tkt_0008', 'tkt_0012']) {
      assert.equal(rt.call({ method: 'POST', path: `/tickets/${id}/resolve`, query: {}, body: undefined }).status, 200);
    }
    const end = JSON.parse(JSON.stringify(rt.dump())) as ReturnType<Runtime['dump']>;
    assert.deepEqual(gradeDump(w, 'resolve_initech_pending', end, host), { ok: true, score: 1 });
  });

  it('R8 the solution end dump hashes like the verdict end state', () => {
    const w = minimalWorld();
    const v = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(v.ok, true);
    if (!v.ok) return;
    const rt = rtOf(w);
    rt.call({ method: 'GET', path: '/tickets', query: {}, body: undefined });
    rt.call({ method: 'POST', path: '/tickets/tkt_0002/resolve', query: {}, body: undefined });
    assert.equal(stateHash(stateFromDump(w, rt.dump())), v.verdict.endStateHash);
    assert.deepEqual(gradeDump(w, 'resolve_password_ticket', rt.dump(), host), { ok: true, score: 1 });
  });

  it('R8 with the runtime journal, job changes after the solution do not lower the score (A-28)', () => {
    const w = minimalWorld();
    const checked = checkedForTest(w);
    for (const id of ['resolve_password_ticket', 'resolve_initech_pending', 'escalate_acme']) {
      const v = verifyTask(checked, seeded(w), id, host);
      assert.equal(v.ok, true);
      if (!v.ok) return;
      const rt = rtOf(w);
      for (const c of v.log) rt.call(c.req);
      assert.equal(rt.advance('72h').jobsFired.length, 288);
      assert.equal(rt.grade(id), 1);
      const end = JSON.parse(JSON.stringify(rt.dump())) as ReturnType<Runtime['dump']>;
      assert.deepEqual(gradeDump(w, id, end, host, rt.journal()), { ok: true, score: 1 });
    }
  });

  it('R8 without a journal, a dump past a job firing carries a caveat naming the job', () => {
    const w = minimalWorld();
    const rt = rtOf(w);
    assert.equal(rt.call({ method: 'POST', path: '/tickets/tkt_0002/resolve', query: {}, body: undefined }).status, 200);
    rt.advance('72h');
    const r = gradeDump(w, 'resolve_password_ticket', rt.dump(), host);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.score, 0.5);
    assert.equal(
      r.caveat,
      'no journal given and job(s) escalate_overdue may have fired before 2026-01-08T09:00:01.000Z; their changes counted as calls, so a collateral check may have lowered this score',
    );
  });

  it('R8 refuses a malformed dump with an error', () => {
    const w = minimalWorld();
    assert.throws(() => gradeDump(w, 'resolve_password_ticket', { now: 'yesterday', tables: {}, counters: {} }, host), /dump/);
  });
});

describe('trace coverage (A-225, A-226)', () => {
  /** minimalWorld with pages of 4 tickets, and the easy task retargeted to tkt_0012, "Duplicate charge", on page 3. */
  function pagedTask(solution: string): World {
    const w = minimalWorld({ routes: { list_tickets: { pageSize: 4 } } });
    w.tasks.resolve_password_ticket!.grader = `(ctx) => {
      const t = ctx.db.get('ticket', 'tkt_0012');
      if (!t || t.status !== 'resolved') return 0;
      return ctx.changes().every((c) => c.id === t.id && c.fields.every((f) => f === 'status')) ? 1 : 0.5;
    }`;
    w.tasks.resolve_password_ticket!.solution = solution;
    return w;
  }
  const WALK = `(ctx) => {
    let cursor = null;
    let t;
    do {
      const r = ctx.api('GET', '/tickets' + (cursor ? '?cursor=' + cursor : ''));
      ctx.assert(r.status === 200, 'list failed');
      t = r.body.data.find((x) => x.subject === 'Duplicate charge');
      cursor = r.body.next_cursor;
    } while (!t && cursor);
    ctx.assert(t, 'ticket not found');
    ctx.assert(ctx.api('POST', '/tickets/' + t.id + '/resolve').status === 200, 'resolve failed');
  }`;

  it('records a target reached only past the first page', () => {
    const w = pagedTask(WALK);
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, true, r.ok ? '' : r.issues.map((i) => `${i.code} ${i.found}`).join(', '));
    if (!r.ok) return;
    assert.deepEqual([r.verdict.solutionRowsChanged, r.verdict.solutionLaterPageEntities], [1, ['ticket']]);
  });

  it('records near-duplicate rows a filtered list returned and the reference left alone (YOS-180)', () => {
    const w = minimalWorld();
    w.tasks.resolve_password_ticket!.solution = `(ctx) => {
      const r = ctx.api('GET', '/tickets?status=pending');
      ctx.assert(r.status === 200, 'list failed');
      const t = r.body.data.find((x) => x.subject === 'Password reset loop');
      ctx.assert(t, 'ticket not found');
      ctx.assert(ctx.api('POST', '/tickets/' + t.id + '/resolve').status === 200, 'resolve failed');
    }`;
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, true, r.ok ? '' : r.issues.map((i) => `${i.code} ${i.found}`).join(', '));
    if (!r.ok) return;
    assert.deepEqual(r.verdict.solutionDistractorEntities, ['ticket']);
    const plain = minimalWorld();
    const p = verifyTask(checkedForTest(plain), seeded(plain), 'resolve_password_ticket', host);
    assert.deepEqual(p.ok ? p.verdict.solutionDistractorEntities : null, []);
  });

  it('records no later page for a target on page one', () => {
    const w = minimalWorld();
    const r = verifyTask(checkedForTest(w), seeded(w), 'resolve_password_ticket', host);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual([r.verdict.solutionRowsChanged, r.verdict.solutionLaterPageEntities], [1, []]);
  });
});
