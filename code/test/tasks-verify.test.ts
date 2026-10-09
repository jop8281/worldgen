/**
 * Full task verification (engine-verify-full): decoys, strict solution prefixes and 5xx in the
 * reference run. Each case names the requirement it proves (R1..R10 in the unit spec). The
 * decoy 5xx cases come from engine-followups.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CheckIssue } from '../src/engine/issues.ts';
import { checkWorld } from '../src/engine/index.ts';
import { worldSchema, type Task, type World } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { seedState, type State } from '../src/engine/store.ts';
import { verifyTask, type TaskVerdict } from '../src/engine/tasks.ts';
import { checkedForTest, minimalWorld } from './helpers/world.ts';

const host = createVmHost();

type TaskId = 'resolve_password_ticket' | 'resolve_initech_pending' | 'escalate_acme';
const EASY: TaskId = 'resolve_password_ticket';
const MEDIUM: TaskId = 'resolve_initech_pending';
const HARD: TaskId = 'escalate_acme';
const DECOY_WHY = 'resolves every pending ticket of every customer, not only Initech';

function seeded(world: World): State {
  const r = seedState(world, host);
  if (!r.ok) throw new Error(`seed failed: ${r.issue.code}`);
  return r.state;
}

/** minimalWorld with only task `id`, its fields replaced by `patch`, plus any extra actions. Parsed, so defaults apply. */
function only(id: TaskId, patch: Partial<Task> = {}, actions: Record<string, unknown> = {}): World {
  const w = minimalWorld();
  const task = w.tasks[id];
  if (task === undefined) throw new Error(`minimalWorld has no task ${id}`);
  return worldSchema.parse({ ...w, actions: { ...w.actions, ...actions }, tasks: { [id]: { ...task, ...patch } } });
}

type Verified = ReturnType<typeof verifyTask>;

function verify(world: World, id: string): Verified {
  return verifyTask(checkedForTest(world), seeded(world), id, host);
}

function verdictOf(r: Verified): TaskVerdict {
  if (!r.ok) throw new Error(`expected a verdict, got ${r.issues.map((i) => `${i.code} ${i.path.join('.')} ${i.found}`).join('; ')}`);
  return r.verdict;
}

function issuesOf(r: Verified): readonly CheckIssue[] {
  if (r.ok) throw new Error('expected verification to fail');
  return r.issues;
}

/** [code, path, found] per issue: what a model reads first. */
const brief = (r: Verified): [string, readonly (string | number)[], string][] => issuesOf(r).map((i) => [i.code, i.path, i.found]);

/** The verdict without its hash, checked for shape only, and without its mutant probes and check coverage, which their own tests pin. */
function plain(v: TaskVerdict): Omit<TaskVerdict, 'endStateHash' | 'collateral' | 'checks' | 'unattributedProbes'> {
  const { endStateHash, collateral, checks: _checks, unattributedProbes: _unattributed, ...rest } = v;
  assert.match(endStateHash, /^[0-9a-f]{32}$/);
  assert.equal(collateral.length, 8);
  return rest;
}

/** Resolves every pending ticket of a pro customer (Globex tkt_0002, Initech tkt_0008 and tkt_0012). */
const PRO_SOLUTION = `(ctx) => {
  const pro = ctx.api('GET', '/customers?tier=pro').body.data;
  for (const c of pro) {
    for (const t of ctx.api('GET', '/tickets?customer=' + c.id + '&status=pending').body.data) {
      const r = ctx.api('POST', '/tickets/' + t.id + '/resolve');
      ctx.assert(r.status === 200, 'resolve failed');
    }
  }
}`;
/** Fraction of pro pending tickets resolved, halved by any stray change. */
const PRO_GRADER = `(ctx) => {
  const pro = ctx.seed.list('customer', { where: { tier: 'pro' } }).map((c) => c.id);
  const targets = ctx.seed.list('ticket', { where: { status: 'pending' } }).filter((t) => pro.includes(t.customer));
  const done = targets.filter((t) => ctx.db.get('ticket', t.id).status === 'resolved').length;
  if (done === 0) return 0;
  const stray = ctx.changes().some((x) => !targets.some((t) => t.id === x.id) || x.fields.some((f) => f !== 'status'));
  return stray ? done / targets.length / 2 : done / targets.length;
}`;
const RESOLVE_ALL_PENDING = `(ctx) => {
  for (const t of ctx.api('GET', '/tickets?status=pending').body.data) ctx.api('POST', '/tickets/' + t.id + '/resolve');
}`;

/** Initech's pending tickets resolved, with no check on anything else: passes on "touch everything". */
const LAX_MEDIUM_GRADER = `(ctx) => {
  const c = ctx.db.list('customer', { where: { name: 'Initech' } })[0];
  const targets = ctx.seed.list('ticket', { where: { customer: c.id, status: 'pending' } });
  const done = targets.filter((t) => ctx.db.get('ticket', t.id).status === 'resolved').length;
  return done / targets.length;
}`;
/** Checks only the first of Initech's pending tickets. */
const FIRST_ROW_GRADER = `(ctx) => {
  const c = ctx.db.list('customer', { where: { name: 'Initech' } })[0];
  const first = ctx.seed.list('ticket', { where: { customer: c.id, status: 'pending' } })[0];
  return ctx.db.get('ticket', first.id).status === 'resolved' ? 1 : 0;
}`;

describe('decoys are required on medium and hard tasks (R1)', () => {
  it('R1 a medium task with no decoys yields task.decoy_required at its decoys', () => {
    assert.deepEqual(brief(verify(only(MEDIUM, { decoys: [] }), MEDIUM)), [
      ['task.decoy_required', ['tasks', MEDIUM, 'decoys'], 'no decoys on a medium task'],
    ]);
  });

  it('R1 a hard task with no decoys yields task.decoy_required with the expected text', () => {
    const [i] = issuesOf(verify(only(HARD, { decoys: [] }), HARD));
    assert.deepEqual([i?.code, i?.path, i?.found, i?.expected], [
      'task.decoy_required', ['tasks', HARD, 'decoys'], 'no decoys on a hard task', 'at least one decoy on medium and hard tasks',
    ]);
  });

  it('R1 an easy task without decoys passes with an empty decoys list', () => {
    assert.deepEqual(verdictOf(verify(only(EASY), EASY)).decoys, []);
  });
});

describe('decoys run from seed and must score below 1 (R2, R3, R10)', () => {
  it('R3 R10 a grader that passes on "touch everything" fails the decoy, naming its why', () => {
    const r = verify(only(MEDIUM, { grader: LAX_MEDIUM_GRADER }), MEDIUM);
    const issues = issuesOf(r);
    assert.deepEqual(brief(r), [
      ['task.decoy_full_marks', ['tasks', 'resolve_initech_pending', 'decoys', 0], 'decoy scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /tickets/tkt_0008 {"customer":"cus_0001"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets/tkt_0002/resolve scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets {"customer":"cus_0001","subject":"Cannot log in","priority":"low"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus DELETE /tickets/tkt_0001 scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"} scored 1'],
    ]);
    assert.equal(issues[0]?.hint, `The decoy "${DECOY_WHY}" scored 1. Its script may not do what its why says (a list read right after a write often returns the row the script just created), or the grader cannot tell it apart. Check the script's calls first, then tighten the grader.`);
  });

  it('R10 a correct grader passes: the decoy scores 0.5 and the verdict carries it', () => {
    assert.deepEqual(verdictOf(verify(only(MEDIUM), MEDIUM)).decoys, [{ why: DECOY_WHY, score: 0.5 }]);
  });

  it('R2 every decoy runs from seed and keeps its declaration order in the verdict', () => {
    const decoys = [
      { why: 'resolves only the first Initech ticket it finds', script: "(ctx) => { ctx.api('POST', '/tickets/tkt_0008/resolve'); }" },
      { why: DECOY_WHY, script: RESOLVE_ALL_PENDING },
      { why: 'resolves only the second Initech ticket it finds', script: "(ctx) => { ctx.api('POST', '/tickets/tkt_0012/resolve'); }" },
    ];
    assert.deepEqual(verdictOf(verify(only(MEDIUM, { decoys }), MEDIUM)).decoys, [
      { why: 'resolves only the first Initech ticket it finds', score: 0.5 },
      { why: DECOY_WHY, score: 0.5 },
      { why: 'resolves only the second Initech ticket it finds', score: 0.5 },
    ]);
  });

  it('R2 a decoy that throws yields snippet.runtime_error at its script', () => {
    const script = "(ctx) => { ctx.api('POST', '/tickets/tkt_0008/resolve'); throw new Error('decoy broke'); }";
    assert.deepEqual(brief(verify(only(MEDIUM, { decoys: [{ why: 'resolves one ticket, then crashes', script }] }), MEDIUM)), [
      ['snippet.runtime_error', ['tasks', MEDIUM, 'decoys', 0, 'script'], 'threw decoy broke'],
    ]);
  });

  it('R2 a decoy that fails its own assert yields snippet.runtime_error with the assert message', () => {
    const script = "(ctx) => { ctx.assert(false, 'not today'); }";
    const [i] = issuesOf(verify(only(MEDIUM, { decoys: [{ why: 'gives up before doing anything', script }] }), MEDIUM));
    assert.deepEqual([i?.code, i?.path, i?.hint], ['snippet.runtime_error', ['tasks', MEDIUM, 'decoys', 0, 'script'], 'ctx.assert failed: not today']);
  });
});

describe('trivial decoys (R4, R5)', () => {
  it('R4 a decoy that only reads yields task.decoy_trivial no_successful_write', () => {
    const why = 'looks at the tickets and changes nothing';
    const r = verify(only(MEDIUM, { decoys: [{ why, script: "(ctx) => { ctx.api('GET', '/tickets'); }" }] }), MEDIUM);
    assert.deepEqual(brief(r), [['task.decoy_trivial', ['tasks', MEDIUM, 'decoys', 0], 'no successful write in 1 call']]);
    assert.equal(issuesOf(r)[0]?.hint, `Decoy "${why}" is no_successful_write.`);
  });

  it('R4 a decoy whose writes are all refused yields no_successful_write', () => {
    // tkt_0004 is open, so resolve answers 409; the bad PATCH answers 400.
    const script = "(ctx) => { ctx.api('POST', '/tickets/tkt_0004/resolve'); ctx.api('PATCH', '/tickets/tkt_0008', { priority: 'meh' }); }";
    assert.deepEqual(brief(verify(only(MEDIUM, { decoys: [{ why: 'resolves the wrong tickets', script }] }), MEDIUM)), [
      ['task.decoy_trivial', ['tasks', MEDIUM, 'decoys', 0], 'no successful write in 2 calls'],
    ]);
  });

  it('R4 a successful call that changes no row is not a write', () => {
    const ping = { method: 'POST', path: '/ping', description: 'Answers ok.', handler: '(ctx) => ({ status: 200, body: { ok: true } })' };
    const w = only(MEDIUM, { decoys: [{ why: 'pings the server instead of working', script: "(ctx) => { ctx.api('POST', '/ping'); }" }] }, { ping });
    assert.deepEqual(brief(verify(w, MEDIUM)), [['task.decoy_trivial', ['tasks', MEDIUM, 'decoys', 0], 'no successful write in 1 call']]);
  });

  it('R4 a GET action that changes a row is a write', () => {
    const touch = {
      method: 'GET', path: '/tickets/{id}/touch', description: 'Marks a ticket high priority.',
      handler: "(ctx) => ({ status: 200, body: ctx.db.update('ticket', ctx.params.id, { priority: 'high' }) })",
    };
    const w = only(MEDIUM, { decoys: [{ why: 'bumps priority instead of resolving', script: "(ctx) => { ctx.api('GET', '/tickets/tkt_0008/touch'); }" }] }, { touch });
    assert.deepEqual(verdictOf(verify(w, MEDIUM)).decoys, [{ why: 'bumps priority instead of resolving', score: 0 }]);
  });

  it('R5 a decoy that writes and then undoes it yields same_as_noop, though timestamps moved', () => {
    const script = `(ctx) => {
      ctx.api('PATCH', '/tickets/tkt_0008', { priority: 'high' });
      ctx.api('PATCH', '/tickets/tkt_0008', { priority: 'low' });
    }`;
    const why = 'raises the priority, then thinks better of it';
    const r = verify(only(MEDIUM, { decoys: [{ why, script }] }), MEDIUM);
    assert.deepEqual(brief(r), [['task.decoy_trivial', ['tasks', MEDIUM, 'decoys', 0], 'ends in the same state as doing nothing']]);
    assert.equal(issuesOf(r)[0]?.hint, `Decoy "${why}" is same_as_noop.`);
  });

  it('R5 a decoy that reaches the solution state by other calls yields same_as_solution, not full marks', () => {
    const script = "(ctx) => { ctx.api('GET', '/tickets'); ctx.api('POST', '/tickets/tkt_0008/resolve'); ctx.api('POST', '/tickets/tkt_0012/resolve'); }";
    const why = 'resolves the Initech tickets by their ids';
    const r = verify(only(MEDIUM, { decoys: [{ why, script }] }), MEDIUM);
    assert.deepEqual(brief(r), [['task.decoy_trivial', ['tasks', MEDIUM, 'decoys', 0], 'ends in the same state as the solution']]);
    assert.equal(issuesOf(r)[0]?.hint, `Decoy "${why}" is same_as_solution.`);
  });

  it('R5 a copy of the solution yields same_as_solution', () => {
    const w = only(HARD);
    const decoys = [{ why: 'exactly what the reference does', script: w.tasks[HARD]?.solution ?? '' }];
    assert.deepEqual(brief(verify(only(HARD, { decoys }), HARD)), [
      ['task.decoy_trivial', ['tasks', HARD, 'decoys', 0], 'ends in the same state as the solution'],
    ]);
  });
});

describe('strict solution prefixes (R6, R7, R10)', () => {
  it('R6 R10 a grader that checks only the first row fails the prefix gate', () => {
    const r = verify(only(MEDIUM, { grader: FIRST_ROW_GRADER }), MEDIUM);
    const issues = issuesOf(r);
    // The decoy resolves both Initech tickets too, so this lax grader also gives it full marks.
    assert.deepEqual(brief(r), [
      ['task.prefix_full_marks', ['tasks', 'resolve_initech_pending'], 'the first 1 of 2 writes scored 1'],
      ['task.decoy_full_marks', ['tasks', 'resolve_initech_pending', 'decoys', 0], 'decoy scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /tickets/tkt_0008 {"customer":"cus_0001"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets/tkt_0002/resolve scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets {"customer":"cus_0001","subject":"Cannot log in","priority":"low"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus DELETE /tickets/tkt_0001 scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution with POST /tickets/tkt_0002/resolve instead of /tickets/tkt_0012/resolve scored 1'],
    ]);
    assert.equal(issues[0]?.hint, 'The first 1 of 2 solution writes already score 1. The grader ignores the rest of the work.');
  });

  it('R6 only the shortest prefix scoring 1 is reported', () => {
    // The hard solution writes tkt_0001, tkt_0006, then resolves tkt_0006; this grader checks tkt_0001 only.
    const grader = "(ctx) => ctx.db.get('ticket', 'tkt_0001').priority === 'urgent' ? 1 : 0";
    const decoys = [{ why: 'escalates only the pending Acme ticket', script: "(ctx) => { ctx.api('PATCH', '/tickets/tkt_0006', { priority: 'urgent' }); }" }];
    assert.deepEqual(brief(verify(only(HARD, { grader, decoys }), HARD)), [
      ['task.prefix_full_marks', ['tasks', 'escalate_acme'], 'the first 1 of 3 writes scored 1'],
      ['task.omission_full_marks', ['tasks', 'escalate_acme'], 'the solution without write 2 of 3 (PATCH /tickets/tkt_0006) scored 1'],
      ['task.mutant_full_marks', ['tasks', 'escalate_acme', 'grader'], 'the solution plus PATCH /tickets/tkt_0001 {"customer":"cus_0002"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'escalate_acme', 'grader'], 'the solution plus POST /tickets/tkt_0002/resolve scored 1'],
      ['task.mutant_full_marks', ['tasks', 'escalate_acme', 'grader'], 'the solution plus POST /tickets {"customer":"cus_0001","subject":"Cannot log in","priority":"low"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'escalate_acme', 'grader'], 'the solution plus DELETE /tickets/tkt_0002 scored 1'],
      ['task.mutant_full_marks', ['tasks', 'escalate_acme', 'grader'], 'the solution plus PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'escalate_acme', 'grader'], 'the solution with POST /tickets/tkt_0002/resolve instead of /tickets/tkt_0006/resolve scored 1'],
    ]);
  });

  it('R6 refused calls and calls that change nothing are not counted as writes', () => {
    const ping = { method: 'POST', path: '/ping', description: 'Answers ok.', handler: '(ctx) => ({ status: 200, body: { ok: true } })' };
    const solution = `(ctx) => {
      ctx.api('POST', '/tickets/tkt_0004/resolve');
      ctx.api('POST', '/ping');
      ctx.api('POST', '/tickets/tkt_0008/resolve');
      ctx.api('POST', '/ping');
      ctx.api('POST', '/tickets/tkt_0012/resolve');
    }`;
    assert.deepEqual(brief(verify(only(MEDIUM, { grader: FIRST_ROW_GRADER, solution, decoys: [] }, { ping }), MEDIUM)), [
      ['task.decoy_required', ['tasks', 'resolve_initech_pending', 'decoys'], 'no decoys on a medium task'],
      ['task.prefix_full_marks', ['tasks', 'resolve_initech_pending'], 'the first 1 of 2 writes scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /tickets/tkt_0008 {"customer":"cus_0001"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets/tkt_0002/resolve scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets {"customer":"cus_0001","subject":"Cannot log in","priority":"low"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus DELETE /tickets/tkt_0001 scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution with POST /tickets/tkt_0002/resolve instead of /tickets/tkt_0012/resolve scored 1'],
    ]);
  });

  it('R6 a grader that throws on a partial state yields its runtime error', () => {
    const grader = `(ctx) => {
      const done = ['tkt_0008', 'tkt_0012'].filter((id) => ctx.db.get('ticket', id).status === 'resolved').length;
      if (done === 1) throw new Error('half done');
      return done / 2;
    }`;
    const decoys = [{ why: 'resolves the Globex ticket instead', script: "(ctx) => { ctx.api('POST', '/tickets/tkt_0002/resolve'); }" }];
    assert.deepEqual(brief(verify(only(MEDIUM, { grader, decoys }), MEDIUM)), [
      ['snippet.runtime_error', ['tasks', 'resolve_initech_pending', 'grader'], 'threw half done'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /tickets/tkt_0008 {"customer":"cus_0001"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets/tkt_0002/resolve scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus POST /tickets {"customer":"cus_0001","subject":"Cannot log in","priority":"low"} scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus DELETE /tickets/tkt_0001 scored 1'],
      ['task.mutant_full_marks', ['tasks', 'resolve_initech_pending', 'grader'], 'the solution plus PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"} scored 1'],
    ]);
  });

  it('R6 A-401 a grader that checks only the last row passes the prefixes and fails the omission gate', () => {
    // The medium solution resolves tkt_0008, then tkt_0012; this grader checks tkt_0012 only, so no prefix reaches 1.
    const grader = "(ctx) => ctx.db.get('ticket', 'tkt_0012').status === 'resolved' ? 1 : 0";
    const r = verify(only(MEDIUM, { grader }), MEDIUM);
    const gates = issuesOf(r).filter((i) => i.code === 'task.omission_full_marks' || i.code === 'task.prefix_full_marks');
    assert.deepEqual(gates.map((i) => [i.code, i.path, i.found]), [
      ['task.omission_full_marks', ['tasks', 'resolve_initech_pending'], 'the solution without write 1 of 2 (POST /tickets/tkt_0008/resolve) scored 1'],
    ]);
    assert.equal(gates[0]?.hint, "The solution's calls without write 1 of 2, POST /tickets/tkt_0008/resolve, still score 1. The grader never checks what that write does; check its effect, such as that row's end state (A-401).");
  });

  it('R6 A-401 a grader that checks every row passes the omission gate, and the left-out write is a probe it flipped', () => {
    const v = verdictOf(verify(only(MEDIUM), MEDIUM));
    assert.deepEqual(v.checks.find((c) => c.check === 'return')?.flippedBy.filter((p) => p.startsWith('omit_write')), ['omit_write 1']);
  });

  it('R6 prefixes are not checked when the solution misses full marks', () => {
    const grader = `(ctx) => ctx.db.get('ticket', 'tkt_0008').status === 'resolved' ? (ctx.db.get('ticket', 'tkt_0012').status === 'resolved' ? 0.5 : 1) : 0`;
    assert.deepEqual(brief(verify(only(MEDIUM, { grader }), MEDIUM)), [
      ['task.solution_not_full_marks', ['tasks', MEDIUM], 'solution scored 0.5'],
    ]);
  });

  it('R6 a prefix replays the bodies the solution sent, even when it reuses and edits one object', () => {
    const solution = `(ctx) => {
      const patch = { priority: 'urgent' };
      ctx.assert(ctx.api('PATCH', '/tickets/tkt_0001', patch).status === 200, 'first patch failed');
      patch.priority = 'low';
      ctx.assert(ctx.api('PATCH', '/tickets/tkt_0006', patch).status === 200, 'second patch failed');
    }`;
    const grader = `(ctx) => ctx.changes().some((c) => !['tkt_0001', 'tkt_0006'].includes(c.id) || c.fields.some((f) => f !== 'priority'))
      ? 0
      : (ctx.db.get('ticket', 'tkt_0001').priority === 'urgent' ? 0.5 : 0) + (ctx.db.get('ticket', 'tkt_0006').priority === 'low' ? 0.5 : 0)`;
    assert.equal(verdictOf(verify(only(EASY, { grader, solution }), EASY)).bestPrefixScore, 0.5);
  });

  it('R7 bestPrefixScore is null with one write', () => {
    assert.equal(verdictOf(verify(only(EASY), EASY)).bestPrefixScore, null);
  });

  it('R7 bestPrefixScore is the highest strict prefix score', () => {
    const decoys = [{ why: DECOY_WHY, script: RESOLVE_ALL_PENDING }];
    const w = only(MEDIUM, { grader: PRO_GRADER, solution: PRO_SOLUTION, decoys });
    assert.deepEqual(plain(verdictOf(verify(w, MEDIUM))), {
      taskId: MEDIUM, difficulty: 'medium', solution: 1, noop: 0, decoys: [{ why: DECOY_WHY, score: 0.5 }], bestPrefixScore: 0.6666666666666666, solutionCalls: 6, solutionWrites: 3, solutionReadsBeforeWrite: 2, solutionPagedEntities: [], solutionRowsChanged: 3, solutionLaterPageEntities: [], solutionDistractorEntities: [], solutionActions: ['resolve_ticket'],
    });
  });
});

describe('the verdict names the workflow actions the reference called successfully (A-398)', () => {
  /** An action that answers 200 and writes nothing, and one that always refuses. */
  const extra = {
    note_ticket: { method: 'POST', path: '/tickets/{id}/note', description: 'Acknowledge a ticket.', handler: '(ctx) => ({ status: 200, body: { ok: true } })' },
    archive_ticket: { method: 'POST', path: '/tickets/{id}/archive', description: 'Never allowed.', handler: "(ctx) => ctx.fail(409, 'ticket.locked', 'Archiving is off.')" },
  };
  const viaNote = `(ctx) => {
    const t = ctx.api('GET', '/tickets').body.data.find((x) => x.subject === 'Password reset loop');
    ctx.api('POST', '/tickets/' + t.id + '/archive');
    ctx.assert(ctx.api('POST', '/tickets/' + t.id + '/resolve').status === 200, 'resolve failed');
    ctx.assert(ctx.api('POST', '/tickets/' + t.id + '/note').status === 200, 'note failed');
  }`;
  const patchOnly = `(ctx) => {
    const t = ctx.api('GET', '/tickets').body.data.find((x) => x.subject === 'Password reset loop');
    ctx.assert(ctx.api('PATCH', '/tickets/' + t.id, { status: 'resolved' }).status === 200, 'patch failed');
  }`;
  const rows: [string, World, TaskId, readonly string[]][] = [
    ['an action call', only(EASY), EASY, ['resolve_ticket']],
    ['actions sorted, a refused one left out', only(EASY, { solution: viaNote }, extra), EASY, ['note_ticket', 'resolve_ticket']],
    ['standard routes only', only(EASY, { solution: patchOnly }), EASY, []],
    ['an update route and an action', only(HARD), HARD, ['resolve_ticket']],
  ];
  for (const [name, w, id, want] of rows) {
    it(name, () => assert.deepEqual(verdictOf(verify(w, id)).solutionActions, want));
  }
});

describe('only a later-page list call counts as paging (A-360)', () => {
  /** Finds the ticket on the first page the list call returns, then resolves it. */
  const lookup = (query: string) => `(ctx) => {
    ctx.api('GET', '/tickets${query}');
    const list = ctx.api('GET', '/tickets?limit=25');
    const t = list.body.data.find((x) => x.subject === 'Password reset loop');
    ctx.assert(t, 'ticket not found');
    ctx.assert(ctx.api('POST', '/tickets/' + t.id + '/resolve').status === 200, 'resolve failed');
  }`;

  it('a lookup with a bare ?limit= and then a valid limit pages no entity', () => {
    assert.deepEqual(verdictOf(verify(only(EASY, { solution: lookup('?limit=') }), EASY)).solutionPagedEntities, []);
  });

  it('a lookup with only a valid ?limit= pages no entity', () => {
    assert.deepEqual(verdictOf(verify(only(EASY, { solution: lookup('?limit=5') }), EASY)).solutionPagedEntities, []);
  });

  it('a refused later-page call reads no page, so it pages no entity', () => {
    assert.deepEqual(verdictOf(verify(only(EASY, { solution: lookup('?cursor=bogus') }), EASY)).solutionPagedEntities, []);
  });

  it('a solution that follows the next-page cursor pages that entity', () => {
    const solution = `(ctx) => {
      let page = ctx.api('GET', '/tickets?limit=1');
      let t = page.body.data.find((x) => x.subject === 'Password reset loop');
      while (!t && page.body.next_cursor !== null) {
        page = ctx.api('GET', '/tickets?limit=1&cursor=' + page.body.next_cursor);
        t = page.body.data.find((x) => x.subject === 'Password reset loop');
      }
      ctx.assert(t, 'ticket not found');
      ctx.assert(ctx.api('POST', '/tickets/' + t.id + '/resolve').status === 200, 'resolve failed');
    }`;
    const v = verdictOf(verify(only(EASY, { solution }), EASY));
    assert.deepEqual([v.solutionPagedEntities, v.solutionLaterPageEntities], [['ticket'], ['ticket']]);
  });
});

describe('collateral mutants (A-156)', () => {
  /** Rejects changes to other rows, but not to other fields of the target row. */
  const ROW_ONLY = `(ctx) => {
    const t = ctx.db.list('ticket', { where: { subject: 'Password reset loop' } })[0];
    if (!t || t.status !== 'resolved') return 0;
    return ctx.changes().every((c) => c.id === t.id) ? 1 : 0.5;
  }`;
  /** Rejects changes to other fields, but not to other rows. */
  const FIELD_ONLY = `(ctx) => {
    const t = ctx.db.list('ticket', { where: { subject: 'Password reset loop' } })[0];
    if (!t || t.status !== 'resolved') return 0;
    return ctx.changes().every((c) => c.fields.every((f) => f === 'status')) ? 1 : 0.5;
  }`;

  it('a grader blind to other fields of the target row yields task.mutant_full_marks target_field at the grader', () => {
    const r = verify(only(EASY, { grader: ROW_ONLY }), EASY);
    assert.deepEqual(brief(r), [['task.mutant_full_marks', ['tasks', EASY, 'grader'], 'the solution plus PATCH /tickets/tkt_0002 {"customer":"cus_0001"} scored 1']]);
    assert.equal(
      issuesOf(r)[0]?.hint,
      'The solution\'s calls plus PATCH /tickets/tkt_0002 {"customer":"cus_0001"}, which changes a field the solution did not write on a row it wrote, still score 1. Pin the exact fields each target row may change with ctx.guardChanges.',
    );
  });

  it('a grader blind to other rows yields task.mutant_full_marks other_row, after skipping siblings the handler refuses', () => {
    // tkt_0001, tkt_0003 and tkt_0004 are not pending, so resolving them is refused; tkt_0005 is the first that commits.
    const r = verify(only(EASY, { grader: FIELD_ONLY }), EASY);
    assert.deepEqual(brief(r), [['task.mutant_full_marks', ['tasks', EASY, 'grader'], 'the solution plus POST /tickets/tkt_0005/resolve scored 1']]);
    assert.equal(
      issuesOf(r)[0]?.hint,
      "The solution's calls plus POST /tickets/tkt_0005/resolve, which changes a row the solution never touched, still score 1. Reject changes to other rows with ctx.guardChanges or a ctx.changes() check.",
    );
  });

  it('a grader that rejects both passes, and the mutants leave the verdict unchanged', () => {
    assert.deepEqual(plain(verdictOf(verify(only(EASY), EASY))), {
      taskId: EASY, difficulty: 'easy', solution: 1, noop: 0, decoys: [], bestPrefixScore: null, solutionCalls: 2, solutionWrites: 1, solutionReadsBeforeWrite: 1, solutionPagedEntities: [], solutionRowsChanged: 1, solutionLaterPageEntities: [], solutionDistractorEntities: [], solutionActions: ['resolve_ticket'],
    });
  });

  it('the verdict lists every mutant kind, graded with its call and score or unprobed with nulls (YOS-156)', () => {
    // No action besides resolve, which the solution calls, so extra_action has nothing to try; no body value names a row, so neither has perturb.
    assert.deepEqual(verdictOf(verify(only(EASY), EASY)).collateral, [
      { kind: 'target_field', call: 'PATCH /tickets/tkt_0002 {"customer":"cus_0001"}', score: 0.5 },
      { kind: 'other_row', call: 'POST /tickets/tkt_0005/resolve', score: 0.5 },
      { kind: 'extra_action', call: null, score: null },
      { kind: 'extra_create', call: 'POST /tickets {"customer":"cus_0001","subject":"Cannot log in","priority":"low"}', score: 0.5 },
      { kind: 'extra_delete', call: 'DELETE /tickets/tkt_0001', score: 0.5 },
      { kind: 'undone_write', call: 'PATCH /customers/cus_0001 {"tier":"pro"} then {"tier":"enterprise"}', score: 0.5 },
      { kind: 'retarget', call: 'POST /tickets/tkt_0005/resolve instead of /tickets/tkt_0002/resolve', score: 0 },
      { kind: 'perturb', call: null, score: null },
    ]);
  });

  it('without an update route the target_field kind has no request to try: the row-only grader passes, and the verdict reports the kind unprobed, not passed (YOS-156 acceptance 3)', () => {
    const w = only(EASY, { grader: ROW_ONLY });
    delete w.routes['update_ticket'];
    const v = verdictOf(verify(w, EASY));
    assert.equal(v.solution, 1);
    assert.deepEqual(v.collateral.find((m) => m.kind === 'target_field'), { kind: 'target_field', call: null, score: null });
  });
});

describe('declared allowances (YOS-156)', () => {
  /** Rejects changes to other rows, but not to other fields of the target row. */
  const ROW_ONLY = `(ctx) => {
    const t = ctx.db.list('ticket', { where: { subject: 'Password reset loop' } })[0];
    if (!t || t.status !== 'resolved') return 0;
    return ctx.changes().every((c) => c.id === t.id) ? 1 : 0.5;
  }`;
  /** Rejects changes to other fields, but not to other rows. */
  const FIELD_ONLY = `(ctx) => {
    const t = ctx.db.list('ticket', { where: { subject: 'Password reset loop' } })[0];
    if (!t || t.status !== 'resolved') return 0;
    return ctx.changes().every((c) => c.fields.every((f) => f === 'status')) ? 1 : 0.5;
  }`;
  const TARGET_STATUS = { entity: 'ticket', kind: 'updated', fields: ['status'], where: { subject: 'Password reset loop' } };
  const probe = (v: TaskVerdict, kind: string) => v.collateral.find((m) => m.kind === kind);

  it('the engine guard zeroes the collateral edit a row-only grader misses, so the task passes', () => {
    const v = verdictOf(verify(only(EASY, { grader: ROW_ONLY, allows: [TARGET_STATUS] } as Partial<Task>), EASY));
    assert.deepEqual(probe(v, 'target_field'), { kind: 'target_field', call: 'PATCH /tickets/tkt_0002 {"customer":"cus_0001"}', score: 0 });
  });

  it('a change outside the declared rows scores 0, though the grader alone would give 1', () => {
    const decoys = [{ why: 'also resolves the Wrong shipping address ticket', script: "(ctx) => { ctx.api('POST', '/tickets/tkt_0002/resolve'); ctx.api('POST', '/tickets/tkt_0005/resolve'); }" }];
    const r = verify(only(EASY, { grader: FIELD_ONLY, allows: [TARGET_STATUS], decoys } as Partial<Task>), EASY);
    assert.deepEqual(verdictOf(r).decoys, [{ why: 'also resolves the Wrong shipping address ticket', score: 0 }]);
  });

  it('a mutant inside an entity-wide allowance is not collateral: the contract permits it', () => {
    // Without allows this grader fails other_row (see A-156 above); here any ticket may change status.
    const v = verdictOf(verify(only(EASY, { grader: FIELD_ONLY, allows: [{ entity: 'ticket', kind: 'updated', fields: ['status'] }] } as Partial<Task>), EASY));
    assert.deepEqual(probe(v, 'other_row'), { kind: 'other_row', call: 'POST /tickets/tkt_0005/resolve', score: 1 });
  });

  it('an unknown entity or field in allows is ref.unknown at its path', () => {
    const w = only(EASY, { allows: [{ entity: 'tickt', kind: 'deleted' }, { entity: 'ticket', kind: 'updated', fields: ['statuss'], where: { subjct: 'x' } }] } as Partial<Task>);
    const r = checkWorld(w);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.filter((i) => i.code === 'ref.unknown').map((i) => [i.path, i.found]), [
      [['tasks', EASY, 'allows', 0, 'entity'], '"tickt"'],
      [['tasks', EASY, 'allows', 1, 'fields', 0], '"statuss"'],
      [['tasks', EASY, 'allows', 1, 'where', 'subjct'], '"subjct"'],
    ]);
  });
});

describe('a reference run gets no 5xx (R8)', () => {
  const crash = { method: 'POST', path: '/tickets/{id}/reopen', description: 'Reopen a ticket.', handler: "(ctx) => { throw new Error('reopen is broken'); }" };
  const SOLVE_THEN_REOPEN = `(ctx) => {
    ctx.assert(ctx.api('POST', '/tickets/tkt_0002/resolve').status === 200, 'resolve failed');
    ctx.api('POST', '/tickets/tkt_0002/reopen');
    ctx.api('POST', '/tickets/tkt_0002/reopen');
  }`;

  it('R8 a handler crash in the solution yields one task.reference_server_error at the handler, though the solution scores 1', () => {
    const r = verify(only(EASY, { solution: SOLVE_THEN_REOPEN }, { reopen_ticket: crash }), EASY);
    assert.deepEqual(brief(r), [['task.reference_server_error', ['actions', 'reopen_ticket', 'handler'], 'POST /tickets/tkt_0002/reopen answered 500']]);
    assert.equal(issuesOf(r)[0]?.expected, 'every call in the reference solution answers below 500');
    assert.equal(
      issuesOf(r)[0]?.hint,
      'In the reference solution of task resolve_password_ticket, POST /tickets/tkt_0002/reopen answered 500 {"error":{"code":"action.failed","message":"Action reopen_ticket failed: reopen is broken"}}. A reference run must get no 5xx: make the handler succeed, or refuse bad input with ctx.fail and a 4xx status.',
    );
  });

  it('R8 a 5xx a handler returns on purpose fails the reference run too', () => {
    const busy = { method: 'POST', path: '/tickets/{id}/reopen', description: 'Reopen a ticket.', handler: "(ctx) => ({ status: 503, body: { error: 'maintenance' } })" };
    assert.deepEqual(brief(verify(only(EASY, { solution: SOLVE_THEN_REOPEN }, { reopen_ticket: busy }), EASY)), [
      ['task.reference_server_error', ['actions', 'reopen_ticket', 'handler'], 'POST /tickets/tkt_0002/reopen answered 503'],
    ]);
  });

  it('R8 a long 5xx body is clipped to 300 characters in the hint', () => {
    const big = { method: 'POST', path: '/tickets/{id}/reopen', description: 'Reopen a ticket.', handler: "(ctx) => ({ status: 502, body: 'x'.repeat(1000) })" };
    const [i] = issuesOf(verify(only(EASY, { solution: SOLVE_THEN_REOPEN }, { reopen_ticket: big }), EASY));
    assert.equal(
      i?.hint,
      `In the reference solution of task resolve_password_ticket, POST /tickets/tkt_0002/reopen answered 502 "${'x'.repeat(296)}.... A reference run must get no 5xx: make the handler succeed, or refuse bad input with ctx.fail and a 4xx status.`,
    );
  });

  it('R8 the 5xx is reported before the solution failure it caused', () => {
    const solution = `(ctx) => {
      const r = ctx.api('POST', '/tickets/tkt_0002/reopen');
      ctx.assert(r.status === 200, 'reopen failed');
    }`;
    assert.deepEqual(issuesOf(verify(only(EASY, { solution }, { reopen_ticket: crash }), EASY)).map((i) => [i.code, i.path]), [
      ['task.reference_server_error', ['actions', 'reopen_ticket', 'handler']],
      ['snippet.runtime_error', ['tasks', EASY, 'solution']],
    ]);
  });
});

describe('a decoy run gets no 5xx', () => {
  const reopen = (handler: string) => ({ method: 'POST', path: '/tickets/{id}/reopen', description: 'Reopen a ticket.', handler });
  const crash = reopen("(ctx) => { throw new Error('reopen is broken'); }");
  const why = 'resolves one Initech ticket, then reopens it';
  /** Without the reopen it would score 0.5, a valid near-miss. */
  const RESOLVE_THEN_REOPEN = `(ctx) => {
    ctx.api('POST', '/tickets/tkt_0008/resolve');
    ctx.api('POST', '/tickets/tkt_0008/reopen');
  }`;
  const decoyWith = (script: string, action: ReturnType<typeof reopen>): World =>
    only(MEDIUM, { decoys: [{ why, script }] }, { reopen_ticket: action });

  it('a handler crash in a decoy yields task.decoy_server_error at the handler, and nothing else', () => {
    const r = verify(decoyWith(RESOLVE_THEN_REOPEN, crash), MEDIUM);
    assert.deepEqual(brief(r), [['task.decoy_server_error', ['actions', 'reopen_ticket', 'handler'], 'POST /tickets/tkt_0008/reopen answered 500']]);
    const [i] = issuesOf(r);
    assert.equal(i?.expected, 'every call in a decoy run answers below 500');
    assert.equal(
      i?.hint,
      'In decoy "resolves one Initech ticket, then reopens it" of task resolve_initech_pending, POST /tickets/tkt_0008/reopen answered 500 {"error":{"code":"action.failed","message":"Action reopen_ticket failed: reopen is broken"}}. A decoy must score below 1 on its own merits, not because the server failed: make the handler succeed, or refuse bad input with ctx.fail and a 4xx status.',
    );
  });

  it('a 5xx a handler returns on purpose fails the decoy too', () => {
    const busy = reopen("(ctx) => ({ status: 503, body: { error: 'maintenance' } })");
    assert.deepEqual(brief(verify(decoyWith(RESOLVE_THEN_REOPEN, busy), MEDIUM)), [
      ['task.decoy_server_error', ['actions', 'reopen_ticket', 'handler'], 'POST /tickets/tkt_0008/reopen answered 503'],
    ]);
  });

  it('the 5xx is reported before the decoy failure it caused', () => {
    const script = `(ctx) => {
      ctx.api('POST', '/tickets/tkt_0008/resolve');
      ctx.assert(ctx.api('POST', '/tickets/tkt_0008/reopen').status === 200, 'reopen failed');
    }`;
    assert.deepEqual(issuesOf(verify(decoyWith(script, crash), MEDIUM)).map((i) => [i.code, i.path]), [
      ['task.decoy_server_error', ['actions', 'reopen_ticket', 'handler']],
      ['snippet.runtime_error', ['tasks', MEDIUM, 'decoys', 0, 'script']],
    ]);
  });

  it('a decoy whose call is refused with a 4xx stays a valid near-miss', () => {
    const refuse = reopen("(ctx) => ctx.fail(409, 'ticket.not_reopenable', 'Resolved tickets stay resolved')");
    assert.deepEqual(verdictOf(verify(decoyWith(RESOLVE_THEN_REOPEN, refuse), MEDIUM)).decoys, [{ why, score: 0.5 }]);
  });
});

describe('minimalWorld under the full rules (R9)', () => {
  it('R9 checkWorld(minimalWorld()) is ok with decoy scores and prefix scores in each verdict', () => {
    const r = checkWorld(minimalWorld());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(Object.values(r.verdicts).map(plain), [
      { taskId: EASY, difficulty: 'easy', solution: 1, noop: 0, decoys: [], bestPrefixScore: null, solutionCalls: 2, solutionWrites: 1, solutionReadsBeforeWrite: 1, solutionPagedEntities: [], solutionRowsChanged: 1, solutionLaterPageEntities: [], solutionDistractorEntities: [], solutionActions: ['resolve_ticket'] },
      { taskId: MEDIUM, difficulty: 'medium', solution: 1, noop: 0, decoys: [{ why: DECOY_WHY, score: 0.5 }], bestPrefixScore: 0.5, solutionCalls: 4, solutionWrites: 2, solutionReadsBeforeWrite: 2, solutionPagedEntities: [], solutionRowsChanged: 2, solutionLaterPageEntities: [], solutionDistractorEntities: [], solutionActions: ['resolve_ticket'] },
      {
        taskId: HARD, difficulty: 'hard', solution: 1, noop: 0,
        decoys: [{ why: 'raises priority to urgent but forgets to resolve the pending Acme ticket', score: 0.5 }], bestPrefixScore: 0.5, solutionCalls: 5, solutionWrites: 3, solutionReadsBeforeWrite: 2, solutionPagedEntities: [], solutionRowsChanged: 2, solutionLaterPageEntities: [], solutionDistractorEntities: ['ticket'], solutionActions: ['resolve_ticket'],
      },
    ]);
  });
});

describe('grader check coverage: which checks a probe flipped (A-393)', () => {
  const targets = `const c = ctx.seed.list('customer', { where: { name: 'Initech' } })[0];
  const targets = ctx.seed.list('ticket', { where: { customer: c.id, status: 'pending' } });
  const onlyTargets = ctx.changes().every((x) => targets.some((t) => t.id === x.id) && x.fields.every((f) => f === 'status'));`;
  const MUTANTS_THAT_COMMIT = ['target_field', 'other_row', 'extra_create', 'extra_delete', 'undone_write', 'retarget'];

  it('a grader that records no goal or guard has one check, its return value, flipped by every probe that scored below 1', () => {
    assert.deepEqual(verdictOf(verify(minimalWorld(), MEDIUM)).checks, [{ check: 'return', flippedBy: ['prefix 1', 'omit_write 1', 'decoy 0', ...MUTANTS_THAT_COMMIT] }]);
  });

  it('each goal and guard is a check, a repeated name by occurrence, and one no probe flipped has none', () => {
    const grader = `(ctx) => {
  ${targets}
  ctx.guard('only the status of Initech pending tickets changed', onlyTargets);
  ctx.guard('Initech still exists', ctx.db.get('customer', c.id) !== null);
  for (const t of targets) ctx.goal(1 / targets.length, 'pending ticket resolved', ctx.db.get('ticket', t.id).status === 'resolved');
  return ctx.score();
}`;
    const v = verdictOf(verify(only(MEDIUM, { grader }), MEDIUM));
    assert.deepEqual(v.checks, [
      // The solution resolves tkt_0008 first, so its prefix still has it and retarget swaps only the last write: only leaving that write out flips it (A-401).
      { check: 'goal pending ticket resolved', flippedBy: ['omit_write 1'] },
      { check: 'goal pending ticket resolved #2', flippedBy: ['prefix 1', 'retarget'] },
      { check: 'guard only the status of Initech pending tickets changed', flippedBy: ['decoy 0', ...MUTANTS_THAT_COMMIT] },
      { check: 'guard Initech still exists', flippedBy: [] },
    ]);
    assert.deepEqual(v.unattributedProbes, []);
  });

  it('a guard-only grader keeps its return value as a check, flipped by the probes no guard explains', () => {
    const grader = `(ctx) => {
  ${targets}
  ctx.guard('only the status of Initech pending tickets changed', onlyTargets);
  return targets.filter((t) => ctx.db.get('ticket', t.id).status === 'resolved').length / targets.length;
}`;
    assert.deepEqual(verdictOf(verify(only(MEDIUM, { grader }), MEDIUM)).checks, [
      { check: 'guard only the status of Initech pending tickets changed', flippedBy: ['decoy 0', ...MUTANTS_THAT_COMMIT] },
      { check: 'return', flippedBy: ['prefix 1', 'omit_write 1'] },
    ]);
  });

  it('a free-text swap of a string the solution writes is a probe too, named by its field', () => {
    const grader = `(ctx) => {
  ctx.guardChanges('only the subject of tkt_0002', [{ entity: 'ticket', id: 'tkt_0002', kind: 'updated', fields: ['subject'] }]);
  ctx.goal(1, 'subject reads Printer jam on floor 3', ctx.db.get('ticket', 'tkt_0002').subject === 'Printer jam on floor 3');
  return ctx.score();
}`;
    const solution = `(ctx) => { ctx.assert(ctx.api('PATCH', '/tickets/tkt_0002', { subject: 'Printer jam on floor 3' }).status === 200, 'patch failed'); }`;
    const v = verdictOf(verify(only(EASY, { instruction: 'Change the subject of ticket tkt_0002 to "Printer jam on floor 3".', grader, solution }), EASY));
    assert.deepEqual(v.checks, [
      { check: 'goal subject reads Printer jam on floor 3', flippedBy: ['retarget', 'free_text ticket.subject'] },
      { check: 'guard only the subject of tkt_0002', flippedBy: ['target_field', 'other_row', 'extra_action', 'extra_create', 'extra_delete', 'undone_write', 'retarget'] },
    ]);
  });

  it('a probe an early return 0 caught before any goal is unattributed, not credited to a goal', () => {
    const grader = `(ctx) => {
  ${targets}
  if (!onlyTargets) return 0;
  for (const t of targets) ctx.goal(1 / targets.length, t.id + ' resolved', ctx.db.get('ticket', t.id).status === 'resolved');
  return ctx.score();
}`;
    const v = verdictOf(verify(only(MEDIUM, { grader }), MEDIUM));
    assert.deepEqual(v.checks, [{ check: 'goal tkt_0008 resolved', flippedBy: ['omit_write 1'] }, { check: 'goal tkt_0012 resolved', flippedBy: ['prefix 1'] }]);
    assert.deepEqual(v.unattributedProbes, ['decoy 0', ...MUTANTS_THAT_COMMIT]);
  });
});
