/**
 * The lints layer of check(), plus world.too_few_tasks, which the tasks layer reports (YOS-113).
 * Lint codes: seed.too_few_rows_for_paging, seed.state_mix_skewed, tasks.difficulty_not_spread,
 * world.read_only, task.no_write, tasks.no_read_before_write, route.unused_required_input,
 * seed.time_order, seed.lorem_text and seed.totals_mismatch.
 *
 * The verdict lints (task.no_write, tasks.no_read_before_write, tasks.difficulty_not_spread) run
 * only on a world whose tasks layer passes. The others also run when the tasks layer fails, so a
 * world with 0 tasks still gets its seed and route lints.
 * Worlds are minimalWorld(), or bareWorld() variants with withStubTasks(), plus one inline
 * orders world for the totals lint. bareWorld seeds 5 customers and 12 tickets (status: 4 open,
 * 6 pending, 2 resolved), and both list routes use the default pageSize of 25. minimalWorld's
 * solutions read only the first page, so worlds with smaller pages start from bareWorld.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check, type CheckReport } from '../src/engine/check.ts';
import { emptyWorld, worldSchema, type World } from '../src/engine/format.ts';
import type { CheckIssue } from '../src/engine/issues.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { bareWorld, CUSTOMER_STUB, minimalWorld, withStubTasks } from './helpers/world.ts';

const host = createVmHost();

type Brief = { severity: string; code: string; path: readonly (string | number)[]; expected: string; found: string; hint: string };
const brief = (i: CheckIssue): Brief => ({ severity: i.severity, code: i.code, path: i.path, expected: i.expected, found: i.found, hint: i.hint });

const ok = (r: CheckReport): Extract<CheckReport, { ok: true }> => {
  if (!r.ok) throw new Error(`expected an ok report, got ${r.issues.map((i) => i.code).join(', ')}`);
  return r;
};
const failed = (r: CheckReport): Extract<CheckReport, { ok: false }> => {
  if (r.ok) throw new Error('expected a failed report');
  return r;
};

const withCode = (issues: readonly CheckIssue[], code: string): Brief[] => issues.filter((i) => i.code === code).map(brief);

/** `world` with list_customers and list_tickets paging at the given sizes. */
function paged(world: World, customers: number, tickets: number): World {
  const routes = structuredClone(world.routes);
  const lc = routes.list_customers;
  const lt = routes.list_tickets;
  if (lc?.op !== 'list' || lt?.op !== 'list') throw new Error('list routes missing');
  lc.pageSize = customers;
  lt.pageSize = tickets;
  return { ...world, routes };
}

/** bareWorld with stub tasks and the given list page sizes. */
const tasked = (customers: number, tickets: number): World => withStubTasks(paged(bareWorld(), customers, tickets));

/** A ticket seed with one row per status, all on the first customer. */
function ticketSeed(statuses: readonly string[]): string {
  return `(ctx) => {
    const c = ctx.rows('customer')[0];
    return ${JSON.stringify(statuses)}.map((s, i) => ({ customer: c.id, subject: 'Ticket ' + i, priority: 'low', status: s }));
  }`;
}

/** bareWorld with `statuses` as its tickets, stub tasks, and pages small enough that paging never warns. */
function mixWorld(statuses: readonly string[]): World {
  const bare = tasked(1, 1);
  return { ...bare, seed: { ...bare.seed, ticket: ticketSeed(statuses) } };
}

const repeat = (n: number, s: string): string[] => Array.from({ length: n }, () => s);

describe('lints: seed.too_few_rows_for_paging', () => {
  // Rule changed in stab/paging: warn when every row fits on one page (rows <= pageSize) of an
  // entity that has a list route and a create route. It was rows < 3 pages for any listed entity.
  it('warns for each created and listed entity whose rows fit on one page, in entity order', () => {
    const r = ok(check(minimalWorld(), host));
    assert.deepEqual(withCode(r.warnings, 'seed.too_few_rows_for_paging'), [
      {
        severity: 'warning', code: 'seed.too_few_rows_for_paging', path: ['seed', 'customer'],
        expected: 'more than 25 customer rows', found: '5 rows', hint: '5 rows fit on one page. Paging never matters.',
      },
      {
        severity: 'warning', code: 'seed.too_few_rows_for_paging', path: ['seed', 'ticket'],
        expected: 'more than 25 ticket rows', found: '12 rows', hint: '12 rows fit on one page. Paging never matters.',
      },
    ]);
  });

  it('warns at exactly pageSize rows and is silent one row above', () => {
    const at = ok(check(tasked(5, 12), host));
    assert.deepEqual(withCode(at.warnings, 'seed.too_few_rows_for_paging').map((i) => [i.path, i.expected, i.found]), [
      [['seed', 'customer'], 'more than 5 customer rows', '5 rows'],
      [['seed', 'ticket'], 'more than 12 ticket rows', '12 rows'],
    ]);
    const above = ok(check(tasked(4, 11), host));
    assert.deepEqual(withCode(above.warnings, 'seed.too_few_rows_for_paging'), []);
  });

  it('in stripe mode measures against the 100-row limit a client can always ask for', () => {
    const bare = tasked(4, 11);
    const stripe = ok(check({ ...bare, meta: { ...bare.meta, api: { ...bare.meta.api, list: { ...bare.meta.api.list, mode: 'stripe' } } } }, host));
    assert.deepEqual(withCode(stripe.warnings, 'seed.too_few_rows_for_paging').map((i) => [i.path, i.expected, i.found]), [
      [['seed', 'customer'], 'more than 100 customer rows', '5 rows'],
      [['seed', 'ticket'], 'more than 100 ticket rows', '12 rows'],
    ]);
  });

  it('skips an entity with no list route', () => {
    const bare = tasked(1, 1);
    const { list_customers: _dropped, ...routes } = bare.routes;
    const r = ok(check({ ...bare, routes }, host));
    assert.deepEqual(withCode(r.warnings, 'seed.too_few_rows_for_paging'), []);
  });

  it('skips a listed reference table with no create route', () => {
    // The stub tasks create customers, so tickets play the reference table here.
    const bare = tasked(25, 25);
    const { create_ticket: _dropped, ...routes } = bare.routes;
    const r = ok(check({ ...bare, routes }, host));
    assert.deepEqual(withCode(r.warnings, 'seed.too_few_rows_for_paging').map((i) => i.path), [['seed', 'customer']]);
  });

  it('uses the largest pageSize when an entity has two list routes', () => {
    const base = tasked(1, 2);
    const routes = { ...base.routes, search_tickets: { op: 'list', entity: 'ticket', method: 'GET', path: '/search/tickets', pageSize: 12 } };
    const r = ok(check({ ...base, routes }, host));
    assert.deepEqual(withCode(r.warnings, 'seed.too_few_rows_for_paging').map((i) => [i.path, i.expected, i.found]), [
      [['seed', 'ticket'], 'more than 12 ticket rows', '12 rows'],
    ]);
  });

  it('warns with 0 rows when a listed entity has no seed', () => {
    const bare = tasked(1, 1);
    const r = ok(check({ ...bare, seed: { customer: bare.seed.customer ?? '' } }, host));
    assert.deepEqual(withCode(r.warnings, 'seed.too_few_rows_for_paging').map((i) => [i.path, i.expected, i.found]), [
      [['seed', 'ticket'], 'more than 1 ticket rows', '0 rows'],
    ]);
  });
});

describe('lints: seed.state_mix_skewed', () => {
  it('is silent on a believable mix (minimalWorld: 4 open, 6 pending, 2 resolved)', () => {
    const r = ok(check(minimalWorld(), host));
    assert.deepEqual(withCode(r.warnings, 'seed.state_mix_skewed'), []);
  });

  it('warns when one state holds more than 70% of rows, with the counts in the hint', () => {
    const r = ok(check(mixWorld([...repeat(8, 'open'), 'pending', 'resolved']), host));
    assert.deepEqual(withCode(r.warnings, 'seed.state_mix_skewed'), [
      {
        severity: 'warning', code: 'seed.state_mix_skewed', path: ['seed', 'ticket'],
        expected: 'every state present and none above 70% of rows', found: '"open" has 8 of 10 rows',
        hint: 'Counts for ticket.status: {"open":8,"pending":1,"resolved":1}.',
      },
    ]);
  });

  it('is silent at exactly 70%', () => {
    const r = ok(check(mixWorld([...repeat(7, 'open'), 'pending', 'pending', 'resolved']), host));
    assert.deepEqual(withCode(r.warnings, 'seed.state_mix_skewed'), []);
  });

  it('warns when a declared state has no rows', () => {
    const r = ok(check(mixWorld([...repeat(5, 'open'), ...repeat(5, 'pending')]), host));
    assert.deepEqual(withCode(r.warnings, 'seed.state_mix_skewed').map((i) => [i.path, i.found, i.hint]), [
      [['seed', 'ticket'], '"resolved" has no rows', 'Counts for ticket.status: {"open":5,"pending":5,"resolved":0}.'],
    ]);
  });

  it('names every problem of one field in one issue, in declared state order', () => {
    const r = ok(check(mixWorld([...repeat(9, 'open'), 'resolved']), host));
    assert.deepEqual(withCode(r.warnings, 'seed.state_mix_skewed').map((i) => [i.path, i.found, i.hint]), [
      [['seed', 'ticket'], '"open" has 9 of 10 rows; "pending" has no rows', 'Counts for ticket.status: {"open":9,"pending":0,"resolved":1}.'],
    ]);
  });

  it('skips a state field whose entity has no rows', () => {
    const bare = tasked(1, 1);
    const r = ok(check({ ...bare, seed: { customer: bare.seed.customer ?? '' } }, host));
    assert.deepEqual(withCode(r.warnings, 'seed.state_mix_skewed'), []);
  });
});

describe('world.too_few_tasks (tasks layer, YOS-113) and tasks.difficulty_not_spread', () => {
  it('is silent on three tasks covering easy, medium and hard', () => {
    const r = ok(check(minimalWorld(), host));
    assert.deepEqual(withCode(r.warnings, 'tasks.difficulty_not_spread'), []);
    assert.deepEqual(Object.keys(r.verdicts), ['resolve_password_ticket', 'resolve_initech_pending', 'escalate_acme']);
  });

  it('fails a world with two verified tasks at the tasks layer, and only the lints that need no verdict run', () => {
    const { escalate_acme: _dropped, ...tasks } = minimalWorld().tasks;
    const r = failed(check({ ...minimalWorld(), tasks }, host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(r.issues.map(brief), [
      {
        severity: 'error', code: 'world.too_few_tasks', path: ['tasks'],
        expected: 'at least 3 tasks covering easy, medium and hard', found: '2 tasks', hint: 'The world has 2.',
      },
    ]);
    assert.deepEqual(r.warnings.map((i) => [i.code, i.path]), [
      ['seed.too_few_rows_for_paging', ['seed', 'customer']],
      ['seed.too_few_rows_for_paging', ['seed', 'ticket']],
    ]);
  });

  it('fails a world with one task', () => {
    const w = minimalWorld();
    const easy = w.tasks.resolve_password_ticket;
    assert.ok(easy);
    const r = failed(check({ ...w, tasks: { resolve_password_ticket: easy } }, host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(r.issues.map((i) => [i.code, i.found, i.hint]), [['world.too_few_tasks', '1 task', 'The world has 1.']]);
  });

  it('fails a world with no tasks, as a finished world (YOS-113)', () => {
    const r = failed(check(bareWorld(), host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(r.issues.map((i) => [i.code, i.path, i.found]), [['world.too_few_tasks', ['tasks'], '0 tasks']]);
  });

  it('reports a failing task before the count', () => {
    const w = minimalWorld();
    const easy = w.tasks.resolve_password_ticket;
    assert.ok(easy);
    const r = failed(check({ ...w, tasks: { resolve_password_ticket: { ...easy, grader: '(ctx) => 1' } } }, host));
    assert.deepEqual(r.issues.map((i) => i.code), ['task.noop_not_zero', 'world.too_few_tasks']);
  });

  it('warns but stays ok when three tasks miss a difficulty', () => {
    const w = minimalWorld();
    const hard = w.tasks.escalate_acme;
    assert.ok(hard);
    const r = ok(check({ ...w, tasks: { ...w.tasks, escalate_acme: { ...hard, difficulty: 'medium' } } }, host));
    assert.deepEqual(withCode(r.warnings, 'tasks.difficulty_not_spread').map((i) => [i.path, i.found, i.hint]), [
      [['tasks'], 'easy, medium', 'Only easy, medium.'],
    ]);
  });

  it('does not run when an earlier layer fails', () => {
    const w = minimalWorld();
    const { escalate_acme: _dropped, ...tasks } = w.tasks;
    const r = failed(check({ ...w, tasks, seed: { ...w.seed, ticket: '(ctx) => { throw new Error("boom"); }' } }, host));
    assert.equal(r.reached, 'seed');
    assert.deepEqual(r.warnings, []);
  });
});

describe('lints: world.read_only', () => {
  it('is silent when the world has a write route or an action', () => {
    const r = ok(check(tasked(1, 1), host));
    assert.deepEqual(withCode(r.warnings, 'world.read_only'), []);
  });

  it('warns at routes when every route only reads and there is no action', () => {
    const bare = paged(bareWorld(), 1, 1);
    const routes = Object.fromEntries(Object.entries(bare.routes).filter(([, r]) => r.op === 'list' || r.op === 'get'));
    const look = (n: number) => ({
      difficulty: 'easy' as const, instruction: `Look at the customer list ${n} times and report what changed between reads.`, decoys: [],
      grader: `(ctx) => (ctx.trace().filter((c) => c.method === 'GET' && c.path.startsWith('/customers') && c.status === 200).length >= ${n} ? 1 : 0)`,
      solution: `(ctx) => { for (let i = 0; i < ${n}; i++) ctx.api('GET', '/customers'); }`,
    });
    const r = ok(check({ ...bare, routes, actions: {}, tasks: { look_1: look(1), look_2: look(2), look_3: look(3) } }, host));
    assert.deepEqual(withCode(r.warnings, 'world.read_only'), [
      {
        severity: 'warning', code: 'world.read_only', path: ['routes'],
        expected: 'at least one create, update or delete route, or an action', found: '4 routes, all get or list',
        hint: 'All 4 routes only read. An agent can change nothing, so no task can grade a change.',
      },
    ]);
  });
});

describe('lints: task.no_write', () => {
  it('is silent when every solution writes', () => {
    const r = ok(check(minimalWorld(), host));
    assert.deepEqual(withCode(r.warnings, 'task.no_write'), []);
  });

  it('warns at the solution of a task that verifies without a write', () => {
    const w = minimalWorld();
    const lookup = {
      difficulty: 'easy' as const,
      instruction: 'Look at the customer list once and report how many customers there are.',
      grader: `(ctx) => (ctx.changes().length === 0 && ctx.trace().some((c) => c.method === 'GET' && c.path.startsWith('/customers') && c.status === 200) ? 1 : 0)`,
      solution: `(ctx) => { ctx.api('GET', '/customers'); }`,
      decoys: [],
    };
    const r = ok(check({ ...w, tasks: { ...w.tasks, lookup } }, host));
    assert.deepEqual(withCode(r.warnings, 'task.no_write'), [
      {
        severity: 'warning', code: 'task.no_write', path: ['tasks', 'lookup', 'solution'],
        expected: 'a solution that makes at least one successful write', found: '0 writes in 1 call',
        hint: 'The solution changed no row in its one call. Grade a change to state, not a read.',
      },
    ]);
  });
});

/** mixWorld's tickets with the customer seed replaced. */
function withCustomers(rows: string): World {
  const w = mixWorld(['open', 'pending', 'resolved']);
  return { ...w, seed: { ...w.seed, customer: `(ctx) => ${rows}` } };
}

describe('lints: seed.time_order', () => {
  it('is silent when the engine stamps every row', () => {
    const r = ok(check(mixWorld(['open', 'pending', 'resolved']), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order'), []);
  });

  it('warns on the first row updated before it was created', () => {
    const r = ok(check(withCustomers(`[
      { name: 'Acme', tier: 'pro', created_at: '2025-12-01T00:00:00.000Z', updated_at: '2025-12-02T00:00:00.000Z' },
      { name: 'Globex', tier: 'pro', created_at: '2025-12-03T00:00:00.000Z', updated_at: '2025-11-01T00:00:00.000Z' },
      { name: 'Initech', tier: 'free', created_at: '2025-12-03T00:00:00.000Z', updated_at: '2025-11-01T00:00:00.000Z' },
    ]`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order'), [
      {
        severity: 'warning', code: 'seed.time_order', path: ['seed', 'customer'],
        expected: 'on every seeded row: created_at <= updated_at, past events such as created_at and placed_at at or before meta.clock.start, each end such as ends_at at or after its start, and past events in the order the state machine allows, such as paid_at before shipped_at',
        found: 'cus_0002: updated_at 2025-11-01T00:00:00.000Z is before created_at 2025-12-03T00:00:00.000Z',
        hint: 'customer cus_0002: updated_at 2025-11-01T00:00:00.000Z is before created_at 2025-12-03T00:00:00.000Z. Seeded history happens before the clock starts. Only planned times such as due_at, scheduled_for or ends_at may lie after it.',
      },
    ]);
  });

  it('warns on a row stamped after the clock start', () => {
    const r = ok(check(withCustomers(`[
      { name: 'Acme', tier: 'pro', created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z' },
      { name: 'Globex', tier: 'pro' },
      { name: 'Initech', tier: 'free' },
    ]`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order').map((i) => i.found), [
      'cus_0001: created_at 2026-02-01T00:00:00.000Z is after the clock start 2026-01-05T09:00:00.000Z',
    ]);
  });

  it('warns on a past-event field after the clock start', () => {
    const r = ok(check(withCustomerTimes({ signed_up_at: { type: 'datetime', nullable: true } }, `[
      { name: 'Acme', tier: 'pro', signed_up_at: '2025-12-01T00:00:00.000Z' },
      { name: 'Globex', tier: 'pro', signed_up_at: '2026-02-01T00:00:00.000Z' },
      { name: 'Initech', tier: 'free', signed_up_at: null },
    ]`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order'), [
      {
        severity: 'warning', code: 'seed.time_order', path: ['seed', 'customer'],
        expected: 'on every seeded row: created_at <= updated_at, past events such as created_at and placed_at at or before meta.clock.start, each end such as ends_at at or after its start, and past events in the order the state machine allows, such as paid_at before shipped_at',
        found: 'cus_0002: signed_up_at 2026-02-01T00:00:00.000Z is after the clock start 2026-01-05T09:00:00.000Z',
        hint: 'customer cus_0002: signed_up_at 2026-02-01T00:00:00.000Z is after the clock start 2026-01-05T09:00:00.000Z. Seeded history happens before the clock starts. Only planned times such as due_at, scheduled_for or ends_at may lie after it.',
      },
    ]);
  });

  it('lets planned times lie after the clock start', () => {
    const r = ok(check(withCustomerTimes({
      renews_at: { type: 'datetime' }, scheduled_for: { type: 'datetime' }, expected_close_at: { type: 'datetime' }, approved_by: { type: 'datetime' },
    }, `['Acme', 'Globex', 'Initech'].map((name) => ({
      name, tier: 'pro', renews_at: '2026-06-01T00:00:00.000Z', scheduled_for: '2026-06-01T00:00:00.000Z',
      expected_close_at: '2026-06-01T00:00:00.000Z', approved_by: '2026-06-01T00:00:00.000Z',
    }))`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order'), []);
  });

  it('warns on an end before its start, even when both are planned', () => {
    const r = ok(check(withCustomerTimes({ trial_starts_at: { type: 'datetime' }, trial_ends_at: { type: 'datetime' } }, `[
      { name: 'Acme', tier: 'pro', trial_starts_at: '2026-03-10T00:00:00.000Z', trial_ends_at: '2026-03-01T00:00:00.000Z' },
      { name: 'Globex', tier: 'pro', trial_starts_at: '2026-03-01T00:00:00.000Z', trial_ends_at: '2026-03-01T00:00:00.000Z' },
      { name: 'Initech', tier: 'free', trial_starts_at: '2026-03-01T00:00:00.000Z', trial_ends_at: '2026-03-10T00:00:00.000Z' },
    ]`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order').map((i) => i.found), [
      'cus_0001: trial_ends_at 2026-03-01T00:00:00.000Z is before trial_starts_at 2026-03-10T00:00:00.000Z',
    ]);
  });

  it('reads a unix_time past event as whole seconds', () => {
    const r = ok(check(withCustomerTimes({ canceled_at: { type: 'unix_time', nullable: true } }, `[
      { name: 'Acme', tier: 'pro', canceled_at: 1764547200 },
      { name: 'Globex', tier: 'pro', canceled_at: 1769904000 },
      { name: 'Initech', tier: 'free', canceled_at: null },
    ]`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order').map((i) => i.found), [
      'cus_0002: canceled_at 1769904000 is after the clock start 2026-01-05T09:00:00.000Z',
    ]);
  });

  const stage = (transitions: Record<string, string[]>) => ({
    stage: { type: 'state', states: ['trial', 'paid', 'churned'], initial: 'trial', transitions },
    paid_at: { type: 'datetime', nullable: true },
    churned_at: { type: 'datetime', nullable: true },
  });
  const outOfOrder = `[
    { name: 'Acme', tier: 'pro', stage: 'paid', paid_at: '2025-12-01T00:00:00.000Z', churned_at: null },
    { name: 'Globex', tier: 'pro', stage: 'churned', paid_at: '2025-12-20T00:00:00.000Z', churned_at: '2025-12-05T00:00:00.000Z' },
    { name: 'Initech', tier: 'free', stage: 'churned', paid_at: '2025-12-01T00:00:00.000Z', churned_at: '2025-12-15T00:00:00.000Z' },
  ]`;

  it('warns on past events out of the order the state machine allows', () => {
    const r = ok(check(withCustomerTimes(stage({ trial: ['paid', 'churned'], paid: ['churned'] }), outOfOrder), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order').map((i) => i.found), [
      'cus_0002: churned_at 2025-12-05T00:00:00.000Z is before paid_at 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('leaves states on a cycle of the state machine unordered', () => {
    const r = ok(check(withCustomerTimes(stage({ trial: ['paid'], paid: ['churned'], churned: ['paid'] }), outOfOrder), host));
    assert.deepEqual(withCode(r.warnings, 'seed.time_order'), []);
  });
});

/** withCustomers, with extra fields on customer. */
function withCustomerTimes(fields: Record<string, { type: string } & Record<string, unknown>>, rows: string): World {
  const w = withCustomers(rows);
  const customer = w.entities['customer']!;
  const world = worldSchema.parse({ ...w, entities: { ...w.entities, customer: { ...customer, fields: { ...customer.fields, ...fields } } } });
  // A created customer gets the state machine's initial stage, so the stub tasks name it or their graders reject the row.
  return 'stage' in fields ? withStubTasks(world, { ...CUSTOMER_STUB, row: (label) => ({ name: label, tier: 'free', stage: 'trial' }) }) : world;
}

describe('lints: seed.lorem_text', () => {
  it('warns once per field with the count and the first value', () => {
    const r = ok(check(withCustomers(`[
      { name: 'Acme', tier: 'pro' },
      { name: 'Lorem ipsum dolor', tier: 'pro' },
      { name: 'Ipsum Corp', tier: 'free' },
    ]`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.lorem_text'), [
      {
        severity: 'warning', code: 'seed.lorem_text', path: ['seed', 'customer'],
        expected: 'plausible text, never lorem ipsum', found: '"Lorem ipsum dolor"',
        hint: '2 customer.name values are placeholder text. Write values the real software would hold.',
      },
    ]);
  });

  it('is silent on words that only contain the letters', () => {
    const r = ok(check(withCustomers(`[{ name: 'Loremark', tier: 'pro' }, { name: 'Dolorsit', tier: 'pro' }, { name: 'Acme', tier: 'free' }]`), host));
    assert.deepEqual(withCode(r.warnings, 'seed.lorem_text'), []);
  });
});

/**
 * An order with a money total and line items that each carry an amount. Its one route creates
 * orders, for the stub tasks, so there is no list and no paging lint.
 */
function ordersWorld(totals: readonly number[]): World {
  const base = emptyWorld('orders', 'hand');
  return withStubTasks(worldSchema.parse({
    ...base,
    meta: { ...base.meta, description: 'Orders and their lines.', resembles: 'an order API' },
    entities: {
      order: {
        description: 'An order.', idPrefix: 'ord',
        fields: { total: { type: 'money', currency: 'USD', required: true }, reference: { type: 'string' } },
      },
      line: {
        description: 'One line of an order.', idPrefix: 'lin',
        fields: { order: { type: 'ref', entity: 'order', required: true }, amount: { type: 'money', currency: 'USD', required: true } },
      },
    },
    seed: {
      order: `(ctx) => ${JSON.stringify(totals)}.map((total) => ({ total }))`,
      line: `(ctx) => ctx.rows('order').flatMap((o) => [{ order: o.id, amount: 1000 }, { order: o.id, amount: 250 }])`,
    },
    routes: { create_order: { op: 'create', entity: 'order', method: 'POST', path: '/orders' } },
  }), { entity: 'order', path: '/orders', key: 'reference', row: (label) => ({ reference: label, total: 0 }) });
}

describe('lints: seed.totals_mismatch', () => {
  it('is silent when every total is the sum of its lines', () => {
    const r = ok(check(ordersWorld([1250, 1250]), host));
    assert.deepEqual(withCode(r.warnings, 'seed.totals_mismatch'), []);
  });

  it('warns on the first order whose total is not the sum of its lines', () => {
    const r = ok(check(ordersWorld([1250, 1300, 900]), host));
    assert.deepEqual(withCode(r.warnings, 'seed.totals_mismatch'), [
      {
        severity: 'warning', code: 'seed.totals_mismatch', path: ['seed', 'order'],
        expected: 'order.total equals the sum of line.amount over its rows', found: 'ord_0002 total 1300, sum 1250',
        hint: 'ord_0002 has 1300, its rows sum to 1250. Compute the total from the rows in the seed.',
      },
    ]);
  });
});

/** ordersWorld plus a refund entity that refs order and has an amount, as the live gen-petstore-refunds iterate built it. */
function ordersWithRefunds(totals: readonly number[]): World {
  const w = ordersWorld(totals);
  return worldSchema.parse({
    ...w,
    entities: {
      ...w.entities,
      refund: {
        description: 'A refund against an order.', idPrefix: 'ref',
        fields: { order_id: { type: 'ref', entity: 'order', required: true }, amount: { type: 'money', currency: 'USD', required: true } },
      },
    },
    seed: { ...w.seed, refund: `(ctx) => ctx.rows('order').map((o) => ({ order_id: o.id, amount: 400 }))` },
  });
}

describe('lints: seed.totals_mismatch ignores children that are not line items (A-94)', () => {
  it('does not sum refunds into order.total when the lines add up', () => {
    const r = ok(check(ordersWithRefunds([1250, 1250]), host));
    assert.deepEqual(withCode(r.warnings, 'seed.totals_mismatch'), []);
  });

  it('still flags a wrong total against its lines when refunds exist', () => {
    const r = ok(check(ordersWithRefunds([1250, 1300]), host));
    assert.deepEqual(withCode(r.warnings, 'seed.totals_mismatch').map((i) => i.found), ['ord_0002 total 1300, sum 1250']);
  });
});

describe('lints: tasks.no_read_before_write', () => {
  it('is silent when medium and hard solutions read first, and on an easy task', () => {
    const r = ok(check(minimalWorld(), host));
    assert.deepEqual(withCode(r.warnings, 'tasks.no_read_before_write'), []);
  });

  it('warns at a medium solution whose first call writes to ids it never looked up', () => {
    const w = minimalWorld({
      tasks: {
        resolve_initech_pending: {
          solution: `(ctx) => {
            ctx.assert(ctx.api('POST', '/tickets/tkt_0008/resolve').status === 200, 'resolve failed');
            ctx.assert(ctx.api('POST', '/tickets/tkt_0012/resolve').status === 200, 'resolve failed');
          }`,
        },
      },
    });
    const r = ok(check(w, host));
    assert.deepEqual(withCode(r.warnings, 'tasks.no_read_before_write'), [
      {
        severity: 'warning', code: 'tasks.no_read_before_write', path: ['tasks', 'resolve_initech_pending', 'solution'],
        expected: 'a medium or hard solution that reads before its first write', found: 'no read before the first of 2 writes',
        hint: 'The solution writes to ids it never looked up. An agent must discover them, so read the list or search first.',
      },
    ]);
  });
});

describe('lints: route.unused_required_input', () => {
  /** bareWorld with an add_note action whose handler is `handler`. */
  function noteWorld(handler: string): World {
    const bare = tasked(1, 1);
    const add_note = {
      method: 'POST' as const, path: '/tickets/{id}/notes', description: 'Add a note to a ticket.',
      input: { note: { type: 'text' as const, required: true }, internal: { type: 'bool' as const } },
      handler,
    };
    return worldSchema.parse({ ...bare, actions: { ...bare.actions, add_note } });
  }

  it('is silent when the handler reads every required input', () => {
    const r = ok(check(noteWorld(`(ctx) => ({ status: 200, body: { id: ctx.params.id, note: ctx.body.note } })`), host));
    assert.deepEqual(withCode(r.warnings, 'route.unused_required_input'), []);
  });

  it('warns at each required input the handler never names, and skips optional ones', () => {
    const r = ok(check(noteWorld(`(ctx) => ({ status: 200, body: ctx.db.get('ticket', ctx.params.id) })`), host));
    assert.deepEqual(withCode(r.warnings, 'route.unused_required_input'), [
      {
        severity: 'warning', code: 'route.unused_required_input', path: ['actions', 'add_note', 'input', 'note'],
        expected: 'a handler that reads every required input', found: 'add_note never names "note"',
        hint: 'Callers must send note, but the handler ignores it. Use it, or drop it from input.',
      },
    ]);
  });
});

describe('lints on a world whose tasks layer fails', () => {
  it('a 0-task world with a skewed seed gets seed.state_mix_skewed beside world.too_few_tasks', () => {
    const r = failed(check({ ...mixWorld([...repeat(9, 'open'), 'resolved']), tasks: {} }, host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(r.issues.map((i) => i.code), ['world.too_few_tasks']);
    assert.deepEqual(r.warnings.map((i) => [i.code, i.path, i.found]), [
      ['seed.state_mix_skewed', ['seed', 'ticket'], '"open" has 9 of 10 rows; "pending" has no rows'],
      ['action.unexercised', ['actions', 'resolve_ticket'], 'no test calls it'],
    ]);
  });

  it('a 0-task world whose routes only read gets world.read_only', () => {
    const bare = paged(bareWorld(), 1, 1);
    const routes = Object.fromEntries(Object.entries(bare.routes).filter(([, r]) => r.op === 'list' || r.op === 'get'));
    const r = failed(check({ ...bare, routes, actions: {}, tests: {}, tasks: {} }, host));
    assert.deepEqual(r.issues.map((i) => i.code), ['world.too_few_tasks']);
    assert.deepEqual(withCode(r.warnings, 'world.read_only').map((i) => [i.path, i.found]), [[['routes'], '4 routes, all get or list']]);
  });

  it('a read-only world whose tasks fail gets world.read_only beside the task errors', () => {
    const bare = paged(withStubTasks(bareWorld()), 1, 1);
    const routes = Object.fromEntries(Object.entries(bare.routes).filter(([, r]) => r.op === 'list' || r.op === 'get'));
    const r = failed(check({ ...bare, routes, actions: {}, tests: {} }, host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(withCode(r.warnings, 'world.read_only').map((i) => i.found), ['4 routes, all get or list']);
  });
});
