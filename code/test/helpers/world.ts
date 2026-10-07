/**
 * Shared test worlds: one small, valid helpdesk-shaped world so engine and WorldGen tests do
 * not each invent one. Not a golden world (that is prod/worlds/helpdesk) and not helpdesk-sized.
 *
 * - bareWorld(): entities, routes, one action, one job and seeds. No tests, no tasks.
 * - minimalWorld(overrides?): bareWorld plus three tasks (easy, medium, hard).
 * - checkedForTest(world): a cast for tests that only need the type. Tests that need a real
 *   verdict call checkWorld.
 *
 * The tasks are proven in test/tasks.test.ts (engine-grade-verify-basic: solution 1, noop 0,
 * replay hash) and test/tasks-verify.test.ts (engine-verify-full: no 5xx, every strict prefix of
 * the solution's writes below 1, each decoy writing, unlike noop and the solution, and below 1).
 * The medium and hard decoys and solution prefixes each score 0.5. test/helpers.test.ts only
 * checks their structure and grades hand-built end states.
 *
 * Seed data (ids follow idPrefix_0001):
 *   customers cus_0001 Acme, cus_0002 Globex, cus_0003 Initech, cus_0004 Umbrella, cus_0005 Hooli.
 *   tickets tkt_0001..tkt_0012, see TICKETS below. Pending: 2, 5, 6, 8, 9, 12.
 *
 * Snippets are plain JS strings. They stay far under SNIPPET_LIMITS.ctxCallsPerRun, use only
 * ctx members from the registries in src/engine/ctx.ts, and never touch Date or Math.random.
 */
import type { CheckedWorld } from '../../src/engine/check.ts';
import { emptyWorld, worldSchema, type World } from '../../src/engine/format.ts';

/** Deep partial of T where any key may also be null, which deletes it from the result. */
export type Overrides<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] | null : T[K] extends object ? Overrides<T[K]> | null : T[K] | null;
};

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge recursively, scalars and arrays replace, null deletes the key. Never mutates its inputs. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (!isPlain(base) || !isPlain(over)) return structuredClone(over);
  const out: Record<string, unknown> = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = k in out ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

const CUSTOMER_SEED = `(ctx) => [
  { name: 'Acme', tier: 'enterprise' },
  { name: 'Globex', tier: 'pro' },
  { name: 'Initech', tier: 'pro' },
  { name: 'Umbrella', tier: 'free' },
  { name: 'Hooli', tier: 'free' },
]`;

/** [customer index, status, priority, subject]. Index n is tkt_(n+1). */
const TICKET_SEED = `(ctx) => {
  const customers = ctx.rows('customer');
  const spec = [
    [0, 'open', 'low', 'Cannot log in'],
    [1, 'pending', 'normal', 'Password reset loop'],
    [2, 'resolved', 'low', 'Invoice question'],
    [3, 'open', 'high', 'Export times out'],
    [4, 'pending', 'normal', 'Wrong shipping address'],
    [0, 'pending', 'high', 'Refund not received'],
    [1, 'open', 'urgent', 'Site is down'],
    [2, 'pending', 'low', 'Update billing email'],
    [3, 'pending', 'urgent', 'Data missing after migration'],
    [4, 'open', 'normal', 'Feature request: dark mode'],
    [0, 'resolved', 'normal', 'Thanks, all good'],
    [2, 'pending', 'high', 'Duplicate charge'],
  ];
  return spec.map((s, i) => ({
    customer: customers[s[0]].id,
    subject: s[3],
    priority: s[2],
    status: s[1],
    sla_due_at: ctx.time.plus(ctx.now(), ((i % 4) + 1) * 2 + 'h'),
  }));
}`;

const RESOLVE_HANDLER = `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'ticket.not_found', 'No ticket ' + ctx.params.id);
  if (t.status !== 'pending') ctx.fail(409, 'ticket.not_pending', 'Only a pending ticket can be resolved. Move it to pending first.');
  return { status: 200, body: ctx.db.update('ticket', t.id, { status: 'resolved' }) };
}`;

const ESCALATE_JOB = `(ctx) => {
  for (const t of ctx.db.list('ticket')) {
    if (t.status !== 'resolved' && t.priority !== 'urgent' && t.sla_due_at !== null && ctx.time.minutesBetween(t.sla_due_at, ctx.now()) > 0) {
      ctx.db.update('ticket', t.id, { priority: 'urgent' });
    }
  }
}`;

/** Standard routes for one entity. Update uses PATCH. Paths use the plural noun. */
function standardRoutes(entity: string, plural: string): Record<string, unknown> {
  return {
    [`list_${plural}`]: { op: 'list', entity, method: 'GET', path: `/${plural}`, filters: entity === 'ticket' ? ['customer', 'status', 'priority'] : ['tier'], sort: [] },
    [`get_${entity}`]: { op: 'get', entity, method: 'GET', path: `/${plural}/{id}` },
    [`create_${entity}`]: { op: 'create', entity, method: 'POST', path: `/${plural}` },
    [`update_${entity}`]: { op: 'update', entity, method: 'PATCH', path: `/${plural}/{id}` },
    [`delete_${entity}`]: { op: 'delete', entity, method: 'DELETE', path: `/${plural}/{id}` },
  };
}

/** A valid world with no tests and no tasks. A fresh object on every call. */
export function bareWorld(): World {
  const base = emptyWorld('minimal', 'hand');
  return worldSchema.parse({
    ...base,
    meta: { ...base.meta, description: 'A tiny helpdesk for tests.', resembles: 'a small helpdesk tickets API', seed: 1, clock: { ...base.meta.clock, tick: '1s' } },
    entities: {
      customer: {
        description: 'A company that files tickets.',
        idPrefix: 'cus',
        fields: {
          name: { type: 'string', required: true, unique: true },
          tier: { type: 'enum', values: ['free', 'pro', 'enterprise'], required: true },
        },
      },
      ticket: {
        description: 'A support request.',
        idPrefix: 'tkt',
        fields: {
          customer: { type: 'ref', entity: 'customer', onDelete: 'restrict', required: true },
          subject: { type: 'string', required: true },
          priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'], required: true },
          status: {
            type: 'state', required: true, states: ['open', 'pending', 'resolved'], initial: 'open',
            transitions: { open: ['pending'], pending: ['resolved'], resolved: ['open'] },
          },
          sla_due_at: { type: 'datetime', readonly: true, nullable: true },
        },
      },
    },
    routes: { ...standardRoutes('customer', 'customers'), ...standardRoutes('ticket', 'tickets') },
    actions: {
      resolve_ticket: {
        method: 'POST', path: '/tickets/{id}/resolve', description: 'Resolve a pending ticket.', handler: RESOLVE_HANDLER,
      },
    },
    jobs: { escalate_overdue: { description: 'Make overdue unresolved tickets urgent.', every: '15m', run: ESCALATE_JOB } },
    seed: { customer: CUSTOMER_SEED, ticket: TICKET_SEED },
  });
}

const EASY_GRADER = `(ctx) => {
  const t = ctx.db.list('ticket', { where: { subject: 'Password reset loop' } })[0];
  if (!t || t.status !== 'resolved') return 0;
  return ctx.changes().every((c) => c.id === t.id && c.fields.every((f) => f === 'status')) ? 1 : 0.5;
}`;
const EASY_SOLUTION = `(ctx) => {
  const list = ctx.api('GET', '/tickets');
  ctx.assert(list.status === 200, 'list tickets failed');
  const t = list.body.data.find((x) => x.subject === 'Password reset loop');
  ctx.assert(t, 'ticket not found');
  const r = ctx.api('POST', '/tickets/' + t.id + '/resolve');
  ctx.assert(r.status === 200, 'resolve failed');
}`;

const MEDIUM_GRADER = `(ctx) => {
  const c = ctx.db.list('customer', { where: { name: 'Initech' } })[0];
  if (!c) return 0;
  const targets = ctx.seed.list('ticket', { where: { customer: c.id, status: 'pending' } });
  const done = targets.filter((t) => ctx.db.get('ticket', t.id).status === 'resolved').length;
  if (targets.length === 0 || done === 0) return 0;
  const score = done / targets.length;
  const stray = ctx.changes().some((x) => !targets.some((t) => t.id === x.id) || x.fields.some((f) => f !== 'status'));
  return stray ? score / 2 : score;
}`;
const MEDIUM_SOLUTION = `(ctx) => {
  const c = ctx.api('GET', '/customers').body.data.find((x) => x.name === 'Initech');
  ctx.assert(c, 'customer not found');
  const pending = ctx.api('GET', '/tickets?customer=' + c.id + '&status=pending').body.data;
  for (const t of pending) {
    const r = ctx.api('POST', '/tickets/' + t.id + '/resolve');
    ctx.assert(r.status === 200, 'resolve failed');
  }
}`;
const MEDIUM_DECOY = `(ctx) => {
  const pending = ctx.api('GET', '/tickets?status=pending').body.data;
  for (const t of pending) ctx.api('POST', '/tickets/' + t.id + '/resolve');
}`;

const HARD_GRADER = `(ctx) => {
  const c = ctx.db.list('customer', { where: { name: 'Acme' } })[0];
  if (!c) return 0;
  const unresolved = ctx.seed.list('ticket', { where: { customer: c.id } }).filter((t) => t.status !== 'resolved');
  let met = 0;
  for (const t of unresolved) {
    const now = ctx.db.get('ticket', t.id);
    if (now.priority === 'urgent' && (t.status !== 'pending' || now.status === 'resolved')) met += 1;
  }
  if (met === 0) return 0;
  const score = met / unresolved.length;
  const stray = ctx.changes().some((x) => !unresolved.some((t) => t.id === x.id) || x.fields.some((f) => f !== 'priority' && f !== 'status'));
  return stray ? score / 2 : score;
}`;
const HARD_SOLUTION = `(ctx) => {
  const c = ctx.api('GET', '/customers').body.data.find((x) => x.name === 'Acme');
  ctx.assert(c, 'customer not found');
  const tickets = ctx.api('GET', '/tickets?customer=' + c.id).body.data;
  for (const t of tickets) {
    if (t.status === 'resolved') continue;
    const p = ctx.api('PATCH', '/tickets/' + t.id, { priority: 'urgent' });
    ctx.assert(p.status === 200, 'escalate failed');
    if (t.status === 'pending') {
      const r = ctx.api('POST', '/tickets/' + t.id + '/resolve');
      ctx.assert(r.status === 200, 'resolve failed');
    }
  }
}`;
const HARD_DECOY = `(ctx) => {
  const c = ctx.api('GET', '/customers').body.data.find((x) => x.name === 'Acme');
  const tickets = ctx.api('GET', '/tickets?customer=' + c.id).body.data;
  for (const t of tickets) {
    if (t.status !== 'resolved') ctx.api('PATCH', '/tickets/' + t.id, { priority: 'urgent' });
  }
}`;

/** bareWorld plus three tasks. `overrides` deep merge into the result and null deletes a key. */
export function minimalWorld(overrides: Overrides<World> = {}): World {
  const bare = bareWorld();
  const world = worldSchema.parse({
    ...bare,
    tasks: {
      resolve_password_ticket: {
        difficulty: 'easy',
        instruction: 'Resolve the pending ticket whose subject is "Password reset loop".',
        grader: EASY_GRADER,
        solution: EASY_SOLUTION,
      },
      resolve_initech_pending: {
        difficulty: 'medium',
        instruction: 'Resolve every pending ticket that belongs to the customer Initech. Leave all other tickets alone.',
        grader: MEDIUM_GRADER,
        solution: MEDIUM_SOLUTION,
        decoys: [{ why: 'resolves every pending ticket of every customer, not only Initech', script: MEDIUM_DECOY }],
      },
      escalate_acme: {
        difficulty: 'hard',
        instruction: 'Acme is churning. Make every unresolved Acme ticket urgent, and resolve the ones that are already pending. Do not touch resolved tickets or other customers.',
        grader: HARD_GRADER,
        solution: HARD_SOLUTION,
        decoys: [{ why: 'raises priority to urgent but forgets to resolve the pending Acme ticket', script: HARD_DECOY }],
      },
    },
  });
  return deepMerge(world, overrides) as World;
}

/** Where stub tasks write: an entity, its create path, and a row for a given label, keyed by `key`. */
export type StubTarget = { readonly entity: string; readonly path: string; readonly key: string; readonly row: (label: string) => Readonly<Record<string, string | number>> };

/** bareWorld's customers: each stub task creates one customer with a new name. */
export const CUSTOMER_STUB: StubTarget = { entity: 'customer', path: '/customers', key: 'name', row: (label) => ({ name: label, tier: 'free' }) };

/**
 * `world` plus three tasks (easy, medium, hard) that each read the list once, then create one row
 * through `target`. Since YOS-113 a world with fewer than 3 tasks fails the tasks layer, so a
 * test that needs an ok report on a task-free world adds these. They read no seed row, so any
 * seed works, and they call no action, so action.unexercised is unchanged.
 */
export function withStubTasks(world: World, target: StubTarget = CUSTOMER_STUB): World {
  const task = (difficulty: 'easy' | 'medium' | 'hard') => {
    const want = target.row(`Stub ${difficulty}`);
    const wrong = target.row(`Stub ${difficulty} wrong`);
    const create = (row: Readonly<Record<string, string | number>>) => `(ctx) => {
  ctx.api('GET', '${target.path}');
  const r = ctx.api('POST', '${target.path}', ${JSON.stringify(row)});
  ctx.assert(r.status < 300, 'create returned ' + r.status);
}`;
    return {
      difficulty,
      instruction: `Create one ${target.entity} with ${target.key} ${JSON.stringify(want[target.key])}.`,
      // Only the created row may change, and it may hold only the fields the task names, so collateral scores 0.
      grader: `(ctx) => {
  const want = ${JSON.stringify(want)};
  const row = ctx.db.list('${target.entity}', { where: { ${target.key}: want.${target.key} } })[0];
  if (!row) return 0;
  if (!ctx.changes().every((c) => c.entity === '${target.entity}' && c.id === row.id)) return 0;
  return Object.keys(row).every((k) => k in want || k === 'id' || k === 'created_at' || k === 'updated_at' || row[k] === null) ? 1 : 0;
}`,
      solution: create(want),
      decoys: difficulty === 'easy' ? [] : [{ why: 'creates the row with the wrong value', script: create(wrong) }],
    };
  };
  return worldSchema.parse({ ...world, tasks: { ...world.tasks, stub_easy: task('easy'), stub_medium: task('medium'), stub_hard: task('hard') } });
}

/**
 * Tests only: this casts and judges nothing. It exists so a test that merely needs a
 * CheckedWorld-typed value can have one. A test that needs a real verdict must call checkWorld.
 * The architecture test scans src only, so this cast is allowed here and nowhere in src.
 */
export function checkedForTest(world: World): CheckedWorld {
  return world as CheckedWorld;
}
