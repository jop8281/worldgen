import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { worldSchema, type World } from '../src/engine/format.ts';
import { bareWorld, checkedForTest, minimalWorld } from './helpers/world.ts';

type Row = Record<string, unknown> & { id: string };
type Chg = { entity: string; id: string; kind: string; fields: string[]; origin: string };

const compile = (src: string): ((ctx: unknown) => unknown) => new Function(`return (${src});`)() as (ctx: unknown) => unknown;

/** Runs the seed snippets with a fake ctx, entities in ref order. Ids follow idPrefix_0001. */
function seeded(world: World): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {};
  for (const name of ['customer', 'ticket']) {
    const ctx = {
      rng: () => 0.5, pick: <T>(xs: T[]) => xs[0], int: (lo: number) => lo,
      rows: (e: string) => tables[e] ?? [], fixtures: {}, now: () => '2026-01-05T09:00:00.000Z',
      time: { plus: (t: string, d: string) => `${t}+${d}`, minutesBetween: () => 0 },
    };
    const out = compile(world.seed[name]!)(ctx) as Record<string, unknown>[];
    const prefix = world.entities[name]!.idPrefix;
    tables[name] = out.map((r, i) => ({ ...r, id: `${prefix}_${String(i + 1).padStart(4, '0')}` }));
  }
  return tables;
}

function gradeWith(world: World, task: string, end: Record<string, Row[]>, changes: Chg[]): unknown {
  const grader = world.tasks[task]?.grader;
  assert.ok(grader !== undefined, `${task} must carry its grader`);
  const seed = seeded(world);
  const mk = (t: Record<string, Row[]>) => ({
    get: (e: string, id: string) => t[e]!.find((r) => r.id === id) ?? null,
    list: (e: string, q?: { where?: Record<string, unknown> }) =>
      t[e]!.filter((r) => Object.entries(q?.where ?? {}).every(([k, v]) => r[k] === v)),
  });
  return compile(grader)({ db: mk(end), seed: mk(seed), changes: () => changes, now: () => '', time: {} });
}

const edit = (t: Record<string, Row[]>, id: string, patch: Record<string, unknown>): Record<string, Row[]> =>
  ({ ...t, ticket: t.ticket!.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
const chg = (id: string, fields: string[]): Chg => ({ entity: 'ticket', id, kind: 'updated', fields, origin: 'call' });

describe('bareWorld', () => {
  const w = bareWorld();
  it('R1 parses with worldSchema and is a hand world', () => {
    assert.equal(worldSchema.safeParse(w).success, true);
    assert.equal(w.meta.source, 'hand');
    assert.equal(w.meta.clock.start, '2026-01-05T09:00:00.000Z');
  });
  it('R2 has customer and ticket with the specified fields', () => {
    assert.deepEqual(Object.keys(w.entities), ['customer', 'ticket']);
    const c = w.entities.customer!.fields;
    assert.deepEqual(Object.keys(c), ['name', 'tier']);
    assert.equal(c.name!.type, 'string');
    assert.equal(c.name!.unique, true);
    assert.deepEqual(c.tier, { ...c.tier, type: 'enum', values: ['free', 'pro', 'enterprise'] });
    const t = w.entities.ticket!.fields;
    assert.deepEqual(Object.keys(t), ['customer', 'subject', 'priority', 'status', 'sla_due_at']);
    assert.deepEqual(t.customer, { ...t.customer, type: 'ref', entity: 'customer', onDelete: 'restrict' });
    assert.equal(t.subject!.type, 'string');
    assert.deepEqual(t.priority, { ...t.priority, type: 'enum', values: ['low', 'normal', 'high', 'urgent'] });
    assert.deepEqual(t.status, {
      ...t.status, type: 'state', states: ['open', 'pending', 'resolved'], initial: 'open',
      transitions: { open: ['pending'], pending: ['resolved'], resolved: ['open'] },
    });
    assert.equal(t.sla_due_at!.type, 'datetime');
    assert.equal(t.sla_due_at!.readonly, true);
  });
  it('R3 has standard routes for both entities, one action and one 15m job', () => {
    assert.deepEqual(Object.values(w.routes).map((r) => `${r.op} ${r.entity} ${r.method} ${r.path}`), [
      'list customer GET /customers', 'get customer GET /customers/{id}', 'create customer POST /customers',
      'update customer PATCH /customers/{id}', 'delete customer DELETE /customers/{id}',
      'list ticket GET /tickets', 'get ticket GET /tickets/{id}', 'create ticket POST /tickets',
      'update ticket PATCH /tickets/{id}', 'delete ticket DELETE /tickets/{id}',
    ]);
    assert.deepEqual(Object.keys(w.actions), ['resolve_ticket']);
    assert.equal(w.actions.resolve_ticket!.path, '/tickets/{id}/resolve');
    assert.deepEqual(Object.keys(w.jobs), ['escalate_overdue']);
    assert.equal(w.jobs.escalate_overdue!.every, '15m');
  });
  it('R4 seed snippets yield 5 customers and 12 tickets', () => {
    assert.deepEqual(Object.keys(w.seed), ['customer', 'ticket']);
    const s = seeded(w);
    assert.deepEqual(s.customer!.map((r) => r.name), ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli']);
    assert.equal(s.ticket!.length, 12);
    assert.deepEqual(s.ticket!.map((r) => r.status), [
      'open', 'pending', 'resolved', 'open', 'pending', 'pending', 'open', 'pending', 'pending', 'open', 'resolved', 'pending']);
    assert.equal(s.ticket!.every((r) => s.customer!.some((c) => c.id === r.customer)), true);
    assert.equal(s.ticket![1]!.subject, 'Password reset loop');
    assert.equal(s.ticket![1]!.customer, 'cus_0002');
  });
  it('R5 has no tests and no tasks', () => {
    assert.deepEqual(w.tests, {});
    assert.deepEqual(w.tasks, {});
  });
});

describe('minimalWorld', () => {
  const w = minimalWorld();
  it('R6 parses and adds exactly three tasks with 0, 1 and 1 decoys', () => {
    assert.equal(worldSchema.safeParse(w).success, true);
    assert.deepEqual(Object.keys(w.tasks), ['resolve_password_ticket', 'resolve_initech_pending', 'escalate_acme']);
    assert.deepEqual(Object.values(w.tasks).map((t) => t.difficulty), ['easy', 'medium', 'hard']);
    assert.deepEqual(Object.values(w.tasks).map((t) => t.decoys.length), [0, 1, 1]);
    assert.deepEqual({ ...w, tasks: {} }, bareWorld());
  });
  it('R7 solutions and decoys call ctx.api, graders read ctx.db and ctx.changes', () => {
    for (const t of Object.values(w.tasks)) {
      assert.ok(t.grader !== undefined && t.solution !== undefined, 'minimalWorld carries the private task material');
      assert.match(t.solution, /ctx\.api\(/);
      assert.match(t.grader, /ctx\.db\./);
      assert.match(t.grader, /ctx\.changes\(/);
      for (const d of t.decoys) {
        assert.match(d.script, /ctx\.api\(/);
        assert.notEqual(d.script, t.solution);
      }
    }
  });
  it('R7 graders score 0 on the untouched seed', () => {
    for (const k of Object.keys(w.tasks)) assert.equal(gradeWith(w, k, seeded(w), []), 0);
  });
  it('R7 graders give 1 for the goal, partial for a half goal or collateral', () => {
    const s = seeded(w);
    assert.equal(gradeWith(w, 'resolve_password_ticket', edit(s, 'tkt_0002', { status: 'resolved' }), [chg('tkt_0002', ['status'])]), 1);
    const both = edit(edit(s, 'tkt_0008', { status: 'resolved' }), 'tkt_0012', { status: 'resolved' });
    assert.equal(gradeWith(w, 'resolve_initech_pending', both, [chg('tkt_0008', ['status']), chg('tkt_0012', ['status'])]), 1);
    assert.equal(gradeWith(w, 'resolve_initech_pending', edit(s, 'tkt_0008', { status: 'resolved' }), [chg('tkt_0008', ['status'])]), 0.5);
    const all = ['tkt_0002', 'tkt_0005', 'tkt_0006', 'tkt_0008', 'tkt_0009', 'tkt_0012'];
    const everything = all.reduce((t, id) => edit(t, id, { status: 'resolved' }), s);
    assert.equal(gradeWith(w, 'resolve_initech_pending', everything, all.map((id) => chg(id, ['status']))), 0.5);
    const hardEnd = edit(edit(s, 'tkt_0001', { priority: 'urgent' }), 'tkt_0006', { priority: 'urgent', status: 'resolved' });
    const hardChanges = [chg('tkt_0001', ['priority']), chg('tkt_0006', ['priority', 'status'])];
    assert.equal(gradeWith(w, 'escalate_acme', hardEnd, hardChanges), 1);
    const noResolve = edit(edit(s, 'tkt_0001', { priority: 'urgent' }), 'tkt_0006', { priority: 'urgent' });
    assert.equal(gradeWith(w, 'escalate_acme', noResolve, [chg('tkt_0001', ['priority']), chg('tkt_0006', ['priority'])]), 0.5);
    assert.equal(gradeWith(w, 'escalate_acme', hardEnd, [...hardChanges, chg('tkt_0011', ['priority'])]), 0.5);
  });
  it('R8 deep merges objects, replaces scalars and arrays, and null deletes', () => {
    const o = minimalWorld({ meta: { seed: 7, clock: { tick: '5s' } } });
    assert.equal(o.meta.seed, 7);
    assert.equal(o.meta.clock.tick, '5s');
    assert.equal(o.meta.clock.start, '2026-01-05T09:00:00.000Z');
    assert.equal(o.meta.name, 'minimal');
    assert.equal(Object.hasOwn(minimalWorld({ tasks: null }), 'tasks'), false);
    const noTicketDelete = minimalWorld({ routes: { delete_ticket: null } });
    assert.equal(Object.keys(noTicketDelete.routes).length, 9);
    assert.equal(Object.hasOwn(noTicketDelete.routes, 'delete_ticket'), false);
    const enumSwap = minimalWorld({ entities: { customer: { fields: { tier: { values: ['a'] } } } } });
    assert.deepEqual((enumSwap.entities.customer!.fields.tier as { values: string[] }).values, ['a']);
    assert.equal(enumSwap.entities.customer!.fields.tier!.type, 'enum');
  });
  it('R9 returns fresh objects on every call', () => {
    const a = minimalWorld();
    a.meta.name = 'changed';
    delete (a.entities as Record<string, unknown>).ticket;
    assert.equal(minimalWorld().meta.name, 'minimal');
    assert.deepEqual(Object.keys(minimalWorld().entities), ['customer', 'ticket']);
    const over = { meta: { seed: 3 } };
    const b = minimalWorld(over);
    b.meta.seed = 9;
    assert.deepEqual(over, { meta: { seed: 3 } });
  });
});

describe('checkedForTest', () => {
  it('R10 returns the same object and the source says tests only', () => {
    const w = bareWorld();
    assert.equal(checkedForTest(w) as unknown, w);
    const src = readFileSync(new URL('./helpers/world.ts', import.meta.url), 'utf8');
    assert.match(src, /tests only/i);
    assert.match(src, /checkWorld/);
  });
});

describe('snippets', () => {
  const w = minimalWorld();
  const all: string[] = [
    ...Object.values(w.seed), ...Object.values(w.jobs).map((j) => j.run), ...Object.values(w.actions).map((a) => a.handler),
    ...Object.values(w.tasks).flatMap((t) => [t.grader, t.solution, ...t.decoys.map((d) => d.script)]).filter((s): s is string => s !== undefined),
  ];
  it('R11 are plain JS functions that compile', () => {
    assert.equal(all.length, 2 + 1 + 1 + 3 * 2 + 2);
    for (const s of all) assert.equal(typeof compile(s), 'function');
  });
  it('R11 avoid forbidden globals and use only registry ctx members', () => {
    for (const s of all) {
      assert.doesNotMatch(s, /\b(Date|setTimeout|setInterval|async|await|import|require|globalThis|performance)\b|Math\.random/);
      for (const m of s.matchAll(/ctx\.(\w+)/g)) {
        assert.equal(['rows', 'pick', 'int', 'rng', 'fixtures', 'now', 'time', 'db', 'seed', 'changes', 'api', 'assert', 'params', 'query', 'body', 'fail'].includes(m[1]!), true, m[1]);
      }
    }
  });
  it('R12 the helper header names engine-grade-verify-basic', () => {
    const src = readFileSync(new URL('./helpers/world.ts', import.meta.url), 'utf8');
    assert.match(src.slice(0, 1500), /engine-grade-verify-basic/);
  });
});
