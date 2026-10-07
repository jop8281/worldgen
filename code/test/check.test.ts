import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check, type CheckReport } from '../src/engine/check.ts';
import type { SnippetHost } from '../src/engine/ctx.ts';
import { emptyWorld, worldSchema, type World } from '../src/engine/format.ts';
import { fromZod, type CheckIssue } from '../src/engine/issues.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { bareWorld, minimalWorld, withStubTasks } from './helpers/world.ts';

const host = createVmHost();

/** Plain JSON view of a world, so tests can mutate it freely before check parses it. */
function raw(world: World): Record<string, any> {
  return structuredClone(world) as Record<string, any>;
}

function failed(report: CheckReport): Extract<CheckReport, { ok: false }> {
  if (report.ok) throw new Error('expected a failed report');
  return report;
}

const brief = (i: CheckIssue): { code: string; path: readonly (string | number)[] } => ({ code: i.code, path: i.path });

/** A small inline world: customer and ticket, with ticket.customer pointing at `target`. */
function refWorld(target: string): Record<string, any> {
  const w = raw(emptyWorld('inline', 'hand'));
  w.entities = {
    customer: { description: 'A company.', idPrefix: 'cus', fields: { name: { type: 'string', required: true } } },
    ticket: {
      description: 'A request.',
      idPrefix: 'tkt',
      fields: {
        customer: { type: 'ref', entity: target, required: true },
        subject: { type: 'string', required: true },
      },
    },
  };
  return w;
}

describe('check: schema layer', () => {
  it('returns exactly the fromZod issues of the world schema', () => {
    const w = raw(bareWorld());
    w.entities.customer.idPrefix = 'CUSTOMER';
    const r = failed(check(w, host));
    const parsed = worldSchema.safeParse(w);
    assert.equal(parsed.success, false);
    const expected = fromZod(parsed.error, [], { schema: worldSchema, input: w });
    assert.equal(r.reached, 'schema');
    assert.deepEqual(r.issues[0], expected[0]);
    assert.equal(r.issues[0].code, 'schema.invalid');
    assert.deepEqual(r.issues[0].path, ['entities', 'customer', 'idPrefix']);
    assert.equal(r.issues[0].found, '"CUSTOMER"');
  });

  it('never throws on null, a string, undefined, a number or an array', () => {
    for (const input of [null, 'world', undefined, 42, []]) {
      const r = failed(check(input, host));
      assert.equal(r.reached, 'schema');
      assert.equal(r.issues[0].code, 'schema.invalid');
      assert.deepEqual(r.issues[0].path, ['format']);
      assert.deepEqual(r.warnings, []);
    }
  });

  it('never throws when reading the input throws', () => {
    const hostile = { get format(): never { throw new Error('boom'); } };
    const r = failed(check(hostile, host));
    assert.equal(r.reached, 'schema');
    assert.equal(r.issues[0].code, 'schema.invalid');
  });

  it('blocks each non-empty section a later layer checks, once, and skips sections that already have an issue', () => {
    const w = raw(bareWorld());
    w.entities.customer.idPrefix = 'CUSTOMER';
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief), [
      { code: 'schema.invalid', path: ['entities', 'customer', 'idPrefix'] },
      { code: 'layer.blocked', path: ['routes'] },
      { code: 'layer.blocked', path: ['actions'] },
      { code: 'layer.blocked', path: ['jobs'] },
      { code: 'layer.blocked', path: ['seed'] },
    ]);
    assert.equal(r.issues[1]?.hint, 'Not checked because the schema layer failed. Fix those issues first.');
    assert.equal(r.issues[1]?.found, 'skipped layers: references');
    assert.equal(r.issues[4]?.found, 'skipped layers: references, compile, seed');
  });
});

describe('check: references layer', () => {
  it('reports an unknown route entity with the known entities in the hint', () => {
    const w = raw(bareWorld());
    w.routes.get_ticket.entity = 'tiket';
    const r = failed(check(w, host));
    assert.equal(r.reached, 'references');
    const i = r.issues[0];
    assert.equal(i.code, 'ref.unknown');
    assert.deepEqual(i.path, ['routes', 'get_ticket', 'entity']);
    assert.equal(i.found, '"tiket"');
    assert.equal(i.expected, 'one of the declared entity names');
    assert.equal(i.hint, 'Known entity names: customer, ticket.');
  });

  it('reports an unknown entity in an action input ref', () => {
    const w = raw(bareWorld());
    w.actions.resolve_ticket.input = { owner: { type: 'ref', entity: 'agent' } };
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief)[0], { code: 'ref.unknown', path: ['actions', 'resolve_ticket', 'input', 'owner', 'entity'] });
    assert.equal(r.issues[0].hint, 'Known entity names: customer, ticket.');
  });

  it('reports unknown filter, sort and search fields at their index', () => {
    const w = raw(bareWorld());
    w.routes.list_tickets.filters = ['customer', 'stauts'];
    w.routes.list_tickets.sort = ['created_at', 'prio'];
    w.routes.list_tickets.search = ['subjct'];
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.filter((i) => i.code === 'ref.unknown').map(brief), [
      { code: 'ref.unknown', path: ['routes', 'list_tickets', 'filters', 1] },
      { code: 'ref.unknown', path: ['routes', 'list_tickets', 'search', 0] },
      { code: 'ref.unknown', path: ['routes', 'list_tickets', 'sort', 1] },
    ]);
    const filter = r.issues[0];
    assert.equal(filter.found, '"stauts"');
    assert.equal(filter.expected, 'one of the declared ticket field names');
    assert.equal(filter.hint, 'Known ticket field names: customer, subject, priority, status, sla_due_at, id, created_at, updated_at.');
  });

  it('reports a seed generator for an unknown entity', () => {
    const w = raw(bareWorld());
    w.seed.agent = '(ctx) => []';
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief)[0], { code: 'ref.unknown', path: ['seed', 'agent'] });
  });

  it('reports a duplicate method and path across routes and actions, ignoring param names', () => {
    const w = raw(bareWorld());
    w.actions.reopen_ticket = { method: 'PATCH', path: '/tickets/{ticket_id}', handler: '(ctx) => ({ status: 200, body: {} })' };
    const r = failed(check(w, host));
    const i = r.issues[0];
    assert.equal(i.code, 'route.duplicate_path');
    assert.deepEqual(i.path, ['actions', 'reopen_ticket', 'path']);
    assert.equal(i.found, 'PATCH /tickets/{ticket_id}');
    assert.equal(i.hint, 'PATCH /tickets/{ticket_id} is also declared by routes.update_ticket.');
  });

  it('allows the same path with a different method', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.actions.replace_ticket = { method: 'PUT', path: '/tickets/{id}', handler: '(ctx) => ({ status: 200, body: {} })' };
    assert.equal(check(w, host).ok, true);
  });

  it('reports an initial state that is not declared', () => {
    const w = raw(bareWorld());
    w.entities.ticket.fields.status.initial = 'new';
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief), [{ code: 'state.bad_machine', path: ['entities', 'ticket', 'fields', 'status', 'initial'] }]
      .concat(['routes', 'actions', 'jobs', 'seed'].map((s) => ({ code: 'layer.blocked', path: [s] }))));
    assert.equal(r.issues[0].found, '"new"');
    assert.equal(r.issues[0].hint, 'initial "new" is not one of the states open, pending, resolved.');
  });

  it('reports transitions from and to undeclared states', () => {
    const w = raw(bareWorld());
    w.entities.ticket.fields.status.transitions = { open: ['pending', 'closed'], pending: ['resolved'], resolved: ['open'], archived: ['open'] };
    const r = failed(check(w, host));
    const bad = r.issues.filter((i) => i.code === 'state.bad_machine');
    assert.deepEqual(bad.map(brief), [
      { code: 'state.bad_machine', path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'open', 1] },
      { code: 'state.bad_machine', path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'archived'] },
    ]);
    assert.equal(bad[0]?.hint, 'transition open -> closed goes to "closed", which is not one of the states open, pending, resolved.');
    assert.equal(bad[1]?.hint, 'transitions from "archived", which is not one of the states open, pending, resolved.');
  });

  it('reports each state unreachable from initial', () => {
    const w = raw(bareWorld());
    w.entities.ticket.fields.status.transitions = { open: [], pending: ['resolved'], resolved: ['open'] };
    const r = failed(check(w, host));
    const bad = r.issues.filter((i) => i.code === 'state.bad_machine');
    assert.deepEqual(bad.map(brief), [
      { code: 'state.bad_machine', path: ['entities', 'ticket', 'fields', 'status', 'states', 1] },
      { code: 'state.bad_machine', path: ['entities', 'ticket', 'fields', 'status', 'states', 2] },
    ]);
    assert.equal(bad[0]?.found, '"pending"');
    assert.equal(bad[0]?.hint, 'state "pending" cannot be reached from initial "open". Add a transition into it.');
  });

  it('reports a ref cycle with no nullable ref once', () => {
    const w = raw(bareWorld());
    w.entities.customer.fields.primary_ticket = { type: 'ref', entity: 'ticket' };
    const r = failed(check(w, host));
    const cycles = r.issues.filter((i) => i.code === 'seed.cycle');
    assert.deepEqual(cycles.map(brief), [{ code: 'seed.cycle', path: ['entities', 'customer', 'fields', 'primary_ticket'] }]);
    assert.equal(cycles[0]?.hint, 'Make one of these refs nullable (nullable: true, and not required) to break customer -> ticket -> customer: customer.primary_ticket, ticket.customer.' +
      ' A nullable ref may name a row of an entity seeded later by its predictable id, such as the first booking id; it must resolve once every seed has run.');
    assert.equal(cycles[0]?.found, 'customer -> ticket -> customer');
  });

  it('reports disjoint cycles in declaration order and selects the shortest cycle', () => {
    const w = raw(emptyWorld('cycles', 'hand'));
    const entity = (idPrefix: string, fields: Record<string, { type: 'ref'; entity: string }>) => ({ description: 'Graph node.', idPrefix, fields });
    w.entities = {
      source: entity('src', { next: { type: 'ref', entity: 'a' } }),
      a: entity('aaa', { long: { type: 'ref', entity: 'b' }, short: { type: 'ref', entity: 'c' } }),
      b: entity('bbb', { next: { type: 'ref', entity: 'c' } }),
      c: entity('ccc', { next: { type: 'ref', entity: 'a' } }),
      d: entity('ddd', { self: { type: 'ref', entity: 'd' }, other: { type: 'ref', entity: 'a' } }),
    };
    const cycles = failed(check(w, host)).issues.filter((i) => i.code === 'seed.cycle');
    assert.deepEqual(cycles.map(brief), [
      { code: 'seed.cycle', path: ['entities', 'a', 'fields', 'short'] },
      { code: 'seed.cycle', path: ['entities', 'd', 'fields', 'self'] },
    ]);
    assert.deepEqual(cycles.map((i) => i.found), ['a -> c -> a', 'd -> d']);
  });

  it('reports a non-nullable self-ref as a cycle', () => {
    const w = raw(bareWorld());
    w.entities.ticket.fields.parent = { type: 'ref', entity: 'ticket' };
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief)[0], { code: 'seed.cycle', path: ['entities', 'ticket', 'fields', 'parent'] });
    assert.equal(r.issues[0].hint, 'Make one of these refs nullable (nullable: true, and not required) to break ticket -> ticket: ticket.parent.' +
      ' A nullable ref may name a row of an entity seeded later by its predictable id, such as the first booking id; it must resolve once every seed has run.');
  });

  it('accepts a cycle broken by a nullable ref', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.entities.customer.fields.primary_ticket = { type: 'ref', entity: 'ticket', nullable: true };
    w.entities.ticket.fields.parent = { type: 'ref', entity: 'ticket', nullable: true };
    assert.equal(check(w, host).ok, true);
  });

  it('counts a required nullable ref as unbreakable', () => {
    const w = raw(bareWorld());
    w.entities.customer.fields.primary_ticket = { type: 'ref', entity: 'ticket', nullable: true, required: true };
    const r = failed(check(w, host));
    assert.equal(r.issues[0].code, 'seed.cycle');
  });

  it('yields exactly one issue for a ref typo in a small world', () => {
    const r = failed(check(refWorld('custmer'), host));
    assert.equal(r.reached, 'references');
    assert.equal(r.issues.length, 1);
    const i = r.issues[0];
    assert.equal(i.code, 'ref.unknown');
    assert.deepEqual(i.path, ['entities', 'ticket', 'fields', 'customer', 'entity']);
    assert.equal(i.found, '"custmer"');
    assert.equal(i.hint, 'Known entity names: customer, ticket.');
    // With the typo fixed it passes every layer up to tasks, where 0 tasks fail (YOS-113).
    assert.deepEqual(failed(check(refWorld('customer'), host)).issues.map((i) => [i.code, i.found]), [['world.too_few_tasks', '0 tasks']]);
  });

  it('hands back the seeded rows when a later layer fails, and none when the seed layer fails', () => {
    const w = refWorld('customer');
    w.seed = { customer: "(ctx) => [{ name: 'Acme' }, { name: 'Globex' }]" };
    const later = failed(check(w, host));
    assert.equal(later.reached, 'tasks');
    assert.deepEqual(later.seeded?.['customer']?.map((r) => r['name']), ['Acme', 'Globex']);
    assert.deepEqual(later.seeded?.['ticket'], []);
    w.seed = { customer: '(ctx) => { throw new Error("boom"); }' };
    assert.equal(failed(check(w, host)).seeded, undefined);
  });

  it('counts the seeded rows and states when a later layer fails, and none when the seed layer fails', () => {
    const w = refWorld('customer');
    w.entities.customer.fields.tier = { type: 'state', states: ['trial', 'paid'], initial: 'trial', transitions: { trial: ['paid'] } };
    w.seed = { customer: "(ctx) => [{ name: 'Acme', tier: 'paid' }, { name: 'Globex' }, { name: 'Initech', tier: 'paid' }]" };
    assert.deepEqual(failed(check(w, host)).stats, { rows: { customer: 3, ticket: 0 }, states: { 'customer.tier': { trial: 1, paid: 2 } } });
    w.seed = { customer: '(ctx) => { throw new Error("boom"); }' };
    assert.equal(failed(check(w, host)).stats, undefined);
  });

  it('blocks the sections of later layers after a references failure', () => {
    const w = raw(bareWorld());
    w.entities.ticket.fields.customer.entity = 'custmer';
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief), [
      { code: 'ref.unknown', path: ['entities', 'ticket', 'fields', 'customer', 'entity'] },
      { code: 'layer.blocked', path: ['actions'] },
      { code: 'layer.blocked', path: ['jobs'] },
      { code: 'layer.blocked', path: ['seed'] },
    ]);
    assert.equal(r.issues[1]?.found, 'skipped layers: compile');
    assert.equal(r.issues[3]?.found, 'skipped layers: compile, seed');
  });
});

describe('check: definitions the runtime cannot serve', () => {
  const codesOf = (r: CheckReport, code: string): { code: string; path: readonly (string | number)[] }[] =>
    failed(r).issues.filter((i) => i.code === code).map(brief);

  it('reports an entity field named after an engine-assigned field', () => {
    const w = raw(bareWorld());
    w.entities.customer.fields.id = { type: 'string', required: true };
    w.entities.ticket.fields.created_at = { type: 'datetime' };
    w.entities.ticket.fields.updated_at = { type: 'datetime' };
    const r = failed(check(w, host));
    assert.equal(r.reached, 'references');
    assert.deepEqual(codesOf(r, 'field.reserved_name'), [
      { code: 'field.reserved_name', path: ['entities', 'customer', 'fields', 'id'] },
      { code: 'field.reserved_name', path: ['entities', 'ticket', 'fields', 'created_at'] },
      { code: 'field.reserved_name', path: ['entities', 'ticket', 'fields', 'updated_at'] },
    ]);
    const i = r.issues[0];
    assert.equal(i.found, '"id"');
    assert.equal(i.expected, 'a field name other than id, created_at and updated_at');
    assert.equal(i.hint, 'The engine assigns id on every row. Rename the field or drop it.');
  });

  it('reports a list filter on a field type that cannot be filtered, and accepts engine fields as filters', () => {
    const w = raw(bareWorld());
    w.entities.customer.fields.notes = { type: 'text' };
    w.routes.list_customers.filters = ['tier', 'notes', 'id', 'created_at'];
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief), [
      { code: 'route.filter_not_filterable', path: ['routes', 'list_customers', 'filters', 1] },
      { code: 'layer.blocked', path: ['actions'] },
      { code: 'layer.blocked', path: ['jobs'] },
      { code: 'layer.blocked', path: ['seed'] },
    ]);
    assert.equal(r.issues[0].found, '"notes"');
    assert.equal(r.issues[0].expected, 'a filter on a field type that can be filtered');
    assert.equal(r.issues[0].hint, 'customer.notes is a text field, which lists cannot filter. Remove it from filters, or put it in search.');
  });

  it('reports malformed path templates', () => {
    const cases: [string, string][] = [
      ['/tickets/{id', 'segment "{id" is not a literal or a whole {param}.'],
      ['/tickets//{id}', 'empty segment between two slashes.'],
      ['/tickets/pre{id}', 'segment "pre{id}" is not a literal or a whole {param}.'],
      ['/tickets/{}', 'segment "{}" is not a literal or a whole {param}.'],
      ['/tickets/id}', 'segment "id}" is not a literal or a whole {param}.'],
      ['/tickets/{id}/x/{id}', 'param {id} appears twice.'],
      ['/tickets/{id}/re solve', 'segment "re solve" contains a space, ?, or #.'],
      ['/tickets/{id}/resolve?x=1', 'segment "resolve?x=1" contains a space, ?, or #.'],
    ];
    for (const [path, problem] of cases) {
      const w = raw(bareWorld());
      w.actions.resolve_ticket.path = path;
      const r = failed(check(w, host));
      assert.equal(r.reached, 'references', path);
      assert.deepEqual(r.issues.map(brief)[0], { code: 'route.bad_path', path: ['actions', 'resolve_ticket', 'path'] }, path);
      assert.equal(r.issues[0].found, JSON.stringify(path));
      assert.equal(r.issues[0].hint, problem);
      assert.equal(r.issues[0].expected, 'a path like /tickets/{id}: non-empty segments, each a literal or a whole {param}');
    }
  });

  it('reports a get route path with an unclosed brace', () => {
    const w = raw(bareWorld());
    w.routes.get_customer.path = '/customers/{id';
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief)[0], { code: 'route.bad_path', path: ['routes', 'get_customer', 'path'] });
  });

  it('treats a trailing slash as the same path, as the router does', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.routes.list_customers.path = '/customers/';
    assert.equal(check(w, host).ok, true);
    w.actions.list_again = { method: 'GET', path: '/customers', handler: '(ctx) => ({ status: 200, body: {} })' };
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief)[0], { code: 'route.duplicate_path', path: ['actions', 'list_again', 'path'] });
    assert.equal(r.issues[0].hint, 'GET /customers is also declared by routes.list_customers.');
  });

  it('reports get, update and delete routes with no path param for the row id', () => {
    const w = raw(bareWorld());
    w.routes.get_customer.path = '/customer';
    w.routes.update_customer.path = '/customer';
    w.routes.delete_ticket.path = '/ticket';
    const r = failed(check(w, host));
    assert.deepEqual(codesOf(r, 'route.missing_id_param'), [
      { code: 'route.missing_id_param', path: ['routes', 'get_customer', 'path'] },
      { code: 'route.missing_id_param', path: ['routes', 'update_customer', 'path'] },
      { code: 'route.missing_id_param', path: ['routes', 'delete_ticket', 'path'] },
    ]);
    assert.equal(r.issues[0].found, '"/customer"');
    assert.equal(r.issues[0].expected, 'a get route path with a {param} for the row id, such as /tickets/{id}');
    assert.equal(r.issues[0].hint, 'Without a path param the get route cannot address a row. Add {id} to the path.');
  });

  it('accepts a get route whose last param is not named id', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.routes.get_customer.path = '/customers/{customer_id}';
    assert.equal(check(w, host).ok, true);
  });

  it('reports a route or action under /_world, which serve answers with 404 on the world port', () => {
    const w = raw(bareWorld());
    w.routes.list_customers.path = '/_world';
    w.actions.resolve_ticket.path = '/_world/tickets/{id}/resolve';
    const r = failed(check(w, host));
    assert.equal(r.reached, 'references');
    assert.deepEqual(codesOf(r, 'route.reserved_path'), [
      { code: 'route.reserved_path', path: ['routes', 'list_customers', 'path'] },
      { code: 'route.reserved_path', path: ['actions', 'resolve_ticket', 'path'] },
    ]);
    const i = r.issues[1];
    assert.equal(i?.found, '"/_world/tickets/{id}/resolve"');
    assert.equal(i?.expected, 'a path outside /_world/... and other than /openapi.json, which serve keeps for itself');
    assert.equal(i?.hint, '/_world/...: serve answers every path under it with 404 on the world port, so this would never be reached over HTTP. Choose another path.');
  });

  it('reports /openapi.json, with or without a trailing slash, whatever the method', () => {
    for (const [method, path] of [['GET', '/openapi.json'], ['POST', '/openapi.json/']] as const) {
      const w = raw(bareWorld());
      w.actions.spec = { method, path, handler: '(ctx) => ({ status: 200, body: {} })' };
      const r = failed(check(w, host));
      assert.deepEqual(r.issues.map(brief)[0], { code: 'route.reserved_path', path: ['actions', 'spec', 'path'] }, path);
      assert.equal(r.issues[0].found, JSON.stringify(path));
      assert.equal(r.issues[0].hint, "/openapi.json: serve answers GET there with the world's OpenAPI document, which agents read to discover the API. Choose another path.");
    }
  });

  it('accepts _world and openapi.json anywhere but the reserved spots', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.actions.world_note = { method: 'POST', path: '/tickets/{id}/_world', handler: '(ctx) => ({ status: 200, body: {} })' };
    w.actions.spec_file = { method: 'GET', path: '/docs/openapi.json', handler: '(ctx) => ({ status: 200, body: {} })' };
    w.actions.world_like = { method: 'GET', path: '/_worlds', handler: '(ctx) => ({ status: 200, body: {} })' };
    assert.equal(check(w, host).ok, true);
  });

  it('reports dataKey equal to cursorKey', () => {
    const w = raw(bareWorld());
    w.meta.api.list.cursorKey = 'data';
    const r = failed(check(w, host));
    assert.deepEqual(r.issues.map(brief)[0], { code: 'api.name_collision', path: ['meta', 'api', 'list', 'cursorKey'] });
    assert.equal(r.issues[0].found, '"data"');
    assert.equal(r.issues[0].expected, 'distinct list envelope keys and query parameter names');
    assert.equal(r.issues[0].hint, 'cursorKey "data" is also the dataKey, so the cursor overwrites the page. Rename one.');
  });

  it('reports limitParam equal to cursorParam, and either equal to q or sort', () => {
    const w = raw(bareWorld());
    w.meta.api.list.limitParam = 'sort';
    w.meta.api.list.cursorParam = 'sort';
    const r = failed(check(w, host));
    assert.deepEqual(codesOf(r, 'api.name_collision'), [
      { code: 'api.name_collision', path: ['meta', 'api', 'list', 'limitParam'] },
      { code: 'api.name_collision', path: ['meta', 'api', 'list', 'cursorParam'] },
      { code: 'api.name_collision', path: ['meta', 'api', 'list', 'cursorParam'] },
    ]);
    assert.equal(r.issues[0].hint, 'limitParam "sort" is also the sort query parameter. Rename it.');
    assert.equal(r.issues[1]?.hint, 'cursorParam "sort" is also the limitParam. Rename one.');
    assert.equal(r.issues[2]?.hint, 'cursorParam "sort" is also the sort query parameter. Rename it.');
  });

  it('reports a list filter named like a paging, search or sort parameter', () => {
    const w = raw(bareWorld());
    w.entities.customer.fields.limit = { type: 'int' };
    w.entities.customer.fields.q = { type: 'string' };
    w.entities.customer.fields.sort = { type: 'string' };
    w.routes.list_customers.filters = ['tier', 'limit', 'q', 'sort'];
    const r = failed(check(w, host));
    assert.deepEqual(codesOf(r, 'api.name_collision'), [
      { code: 'api.name_collision', path: ['routes', 'list_customers', 'filters', 1] },
      { code: 'api.name_collision', path: ['routes', 'list_customers', 'filters', 2] },
      { code: 'api.name_collision', path: ['routes', 'list_customers', 'filters', 3] },
    ]);
    assert.equal(r.issues[0].found, '"limit"');
    assert.equal(r.issues[0].hint, 'filter "limit" is also the limitParam. Drop the filter or rename meta.api.list.limitParam.');
    assert.equal(r.issues[1]?.hint, 'filter "q" is also the q query parameter. Drop the filter.');
  });

  it('reports collisions among active Stripe envelope keys and paging params', () => {
    const w = raw(bareWorld());
    w.meta.api.list = {
      ...w.meta.api.list,
      mode: 'stripe',
      hasMoreKey: 'data',
      startingAfterParam: 'limit',
      endingBeforeParam: 'sort',
    };
    const r = failed(check(w, host));
    assert.deepEqual(codesOf(r, 'api.name_collision'), [
      { code: 'api.name_collision', path: ['meta', 'api', 'list', 'hasMoreKey'] },
      { code: 'api.name_collision', path: ['meta', 'api', 'list', 'startingAfterParam'] },
      { code: 'api.name_collision', path: ['meta', 'api', 'list', 'endingBeforeParam'] },
    ]);
    assert.equal(r.issues[0].hint, 'hasMoreKey "data" is also the dataKey, so has_more overwrites the page. Rename one.');
    assert.equal(r.issues[1]?.hint, 'startingAfterParam "limit" is also the limitParam. Rename one.');
    assert.equal(r.issues[2]?.hint, 'endingBeforeParam "sort" is also the sort query parameter. Rename it.');
  });

  it('reports a list filter named like a stripe cursor param, and ignores the inactive cursor keys', () => {
    const w = raw(bareWorld());
    w.meta.api.list = { ...w.meta.api.list, mode: 'stripe', cursorKey: 'data', cursorParam: 'limit' };
    w.entities.customer.fields.starting_after = { type: 'string' };
    w.entities.customer.fields.cursor = { type: 'string' };
    w.routes.list_customers.filters = ['tier', 'starting_after', 'cursor'];
    const r = failed(check(w, host));
    assert.deepEqual(codesOf(r, 'api.name_collision'), [
      { code: 'api.name_collision', path: ['routes', 'list_customers', 'filters', 1] },
    ]);
    assert.equal(r.issues[0].hint, 'filter "starting_after" is also the startingAfterParam. Drop the filter or rename meta.api.list.startingAfterParam.');
  });

  it('reports sort fields on a list route of a stripe-mode world, which the list would ignore', () => {
    const w = raw(bareWorld());
    w.meta.api.list = { ...w.meta.api.list, mode: 'stripe' };
    w.routes.list_customers.sort = ['created_at', 'name'];
    const r = failed(check(w, host));
    assert.equal(r.reached, 'references');
    assert.deepEqual(r.issues.filter((i) => i.code !== 'layer.blocked').map(brief), [{ code: 'route.sort_ignored', path: ['routes', 'list_customers', 'sort'] }]);
    assert.equal(r.issues[0].found, '["created_at","name"]');
    assert.equal(r.issues[0].hint,
      'Stripe-mode lists are always newest first by created_at and refuse ?sort, so the sort fields of list_customers would be ignored. Drop the sort list, or set meta.api.list.mode to cursor.');
  });

  it('accepts sort fields on a list route in cursor mode', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.routes.list_customers.sort = ['created_at', 'name'];
    assert.equal(check(w, host).ok, true);
  });

  it('accepts a stripe-mode world with default keys', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.meta.api.list = { ...w.meta.api.list, mode: 'stripe' };
    assert.equal(check(w, host).ok, true);
  });

  it('accepts renamed envelope keys and params that stay distinct', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.meta.api.list = { ...w.meta.api.list, dataKey: 'items', cursorKey: 'next', limitParam: 'page_size', cursorParam: 'starting_after' };
    assert.equal(check(w, host).ok, true);
  });
});

describe('check: compile layer', () => {
  const BAD = '(ctx) => {';

  it('reports a compile error at the exact path of every snippet kind', () => {
    const w = raw(minimalWorld());
    w.actions.resolve_ticket.handler = BAD;
    w.jobs.escalate_overdue.run = BAD;
    w.seed.customer = BAD;
    w.tests = { smoke: { description: 'Lists tickets.', script: BAD } };
    w.tasks.resolve_password_ticket.grader = BAD;
    w.tasks.resolve_password_ticket.solution = BAD;
    w.tasks.escalate_acme.decoys[0].script = BAD;
    const r = failed(check(w, host));
    assert.equal(r.reached, 'compile');
    assert.deepEqual(r.issues.map(brief), [
      { code: 'snippet.compile_error', path: ['actions', 'resolve_ticket', 'handler'] },
      { code: 'snippet.compile_error', path: ['jobs', 'escalate_overdue', 'run'] },
      { code: 'snippet.compile_error', path: ['seed', 'customer'] },
      { code: 'snippet.compile_error', path: ['tests', 'smoke', 'script'] },
      { code: 'snippet.compile_error', path: ['tasks', 'resolve_password_ticket', 'grader'] },
      { code: 'snippet.compile_error', path: ['tasks', 'resolve_password_ticket', 'solution'] },
      { code: 'snippet.compile_error', path: ['tasks', 'escalate_acme', 'decoys', 0, 'script'] },
    ]);
    assert.equal(r.issues[0].found, '(ctx) => {');
  });

  it('compiles each snippet with its kind', () => {
    const seen: string[] = [];
    const recording: SnippetHost = {
      compile(kind, source, path) {
        seen.push(`${kind} ${path.join('.')}`);
        return host.compile(kind, source, path);
      },
    };
    const w = raw(minimalWorld());
    w.tests = { smoke: { description: 'Lists tickets.', script: '(ctx) => {}' } };
    assert.equal(check(w, recording).ok, true);
    assert.deepEqual(seen, [
      'handler actions.resolve_ticket.handler',
      'job jobs.escalate_overdue.run',
      'seed seed.customer',
      'seed seed.ticket',
      'test tests.smoke.script',
      'grader tasks.resolve_password_ticket.grader',
      'client tasks.resolve_password_ticket.solution',
      'grader tasks.resolve_initech_pending.grader',
      'client tasks.resolve_initech_pending.solution',
      'client tasks.resolve_initech_pending.decoys.0.script',
      'grader tasks.escalate_acme.grader',
      'client tasks.escalate_acme.solution',
      'client tasks.escalate_acme.decoys.0.script',
    ]);
  });

  it('refuses a task solution or decoy that moves time, naming the script', () => {
    const w = raw(minimalWorld());
    w.tasks.resolve_password_ticket.solution = "(ctx) => { ctx.advance('1h'); ctx.api('POST', '/tickets/tkt_0002/resolve'); }";
    w.tasks.escalate_acme.decoys[0].script = '(c) => { c . advance ("15m"); }';
    const r = failed(check(w, host));
    assert.equal(r.reached, 'compile');
    assert.deepEqual(r.issues.filter((i) => i.code === 'task.clock_control').map((i) => [i.code, i.path.join('.'), i.hint]), [
      ['task.clock_control', 'tasks.resolve_password_ticket.solution', 'Only world tests can call ctx.advance. A task runs as an agent would, through the public API with no clock control, so read time-dependent facts from seed.'],
      ['task.clock_control', 'tasks.escalate_acme.decoys.0.script', 'Only world tests can call ctx.advance. A task runs as an agent would, through the public API with no clock control, so read time-dependent facts from seed.'],
    ]);
  });

  it('reports a host that throws as a compile error instead of throwing', () => {
    const throwing: SnippetHost = {
      compile() {
        throw new Error('host broke');
      },
    };
    const r = failed(check(bareWorld(), throwing));
    assert.equal(r.reached, 'compile');
    assert.deepEqual(r.issues[0].path, ['actions', 'resolve_ticket', 'handler']);
    assert.equal(r.issues[0].code, 'snippet.compile_error');
    assert.equal(r.issues[0].hint, 'host broke');
  });
});

describe('check: ok report', () => {
  it('counts actions exercised only by tests and by solution runs whose handler ran, never by decoys', () => {
    const w = raw(minimalWorld());
    w.actions.close_ticket = { ...w.actions.resolve_ticket, path: '/tickets/{id}/close' };
    w.tasks.resolve_password_ticket.solution = w.tasks.resolve_password_ticket.solution.replace(
      '(ctx) => {',
      "(ctx) => { ctx.assert(ctx.api('POST', '/tickets/tkt_0001/close', { junk: 1 }).status === 400, 'junk body accepted');",
    );
    w.tasks.escalate_acme.decoys[0].script = w.tasks.escalate_acme.decoys[0].script.replace(
      '(ctx) => {',
      "(ctx) => { ctx.api('POST', '/tickets/tkt_0001/close');",
    );
    const r = check(w, host);
    if (!r.ok) throw new Error(JSON.stringify(r.issues.map(brief)));
    assert.deepEqual(r.stats.unexercisedActions, ['close_ticket']);
  });

  it('mints a CheckedWorld for bareWorld with stub tasks (YOS-113: 3 tasks needed), their verdicts and seeded stats', () => {
    const world = withStubTasks(bareWorld());
    const r = check(world, host);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.world, world);
    assert.deepEqual(Object.keys(r.verdicts), ['stub_easy', 'stub_medium', 'stub_hard']);
    assert.deepEqual(r.stats, { rows: { customer: 5, ticket: 12 }, states: { 'ticket.status': { open: 4, pending: 6, resolved: 2 } }, unexercisedActions: ['resolve_ticket'] });
    assert.equal(r.tests, 0);
  });

  it('accepts minimalWorld', () => {
    assert.equal(check(minimalWorld(), host).ok, true);
  });
});

describe('route path params must name a column (YOS-69)', () => {
  it('a param that is neither the row id nor a column of the entity is route.param_not_column', () => {
    const w = raw(bareWorld());
    w.routes['list_tickets'].path = '/customers/{owner}/tickets';
    const report = failed(check(w, host));
    assert.deepEqual(report.issues.filter((i) => i.code !== 'layer.blocked').map(brief), [{ code: 'route.param_not_column', path: ['routes', 'list_tickets', 'path'] }]);
  });

  it('the engine field id is not a param on a list path', () => {
    const w = raw(bareWorld());
    w.routes['list_tickets'].path = '/customers/{id}/tickets';
    const report = failed(check(w, host));
    const issue = report.issues.find((i) => i.code === 'route.param_not_column');
    assert.deepEqual(issue?.path, ['routes', 'list_tickets', 'path']);
    assert.equal(issue?.hint.includes('as {id}. Any other param'), true);
    assert.equal(issue?.hint.includes('Add {id}'), false);
  });

  it('a param that names a non-ref column is refused on a list path', () => {
    const w = raw(bareWorld());
    w.routes['list_tickets'].path = '/statuses/{status}/tickets';
    assert.deepEqual(failed(check(w, host)).issues.filter((i) => i.code !== 'layer.blocked').map(brief), [{ code: 'route.param_not_column', path: ['routes', 'list_tickets', 'path'] }]);
  });

  it('a create path cannot scope by a readonly ref, but can by a writable one', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.routes['create_ticket'].path = '/customers/{customer}/tickets';
    assert.equal(check(w, host).ok, true);
    w.entities['ticket'].fields['customer'].readonly = true;
    assert.deepEqual(failed(check(w, host)).issues.filter((i) => i.code !== 'layer.blocked').map(brief), [{ code: 'route.param_not_column', path: ['routes', 'create_ticket', 'path'] }]);
  });

  it('a param naming a ref column is accepted, and so is the row id', () => {
    const w = raw(withStubTasks(bareWorld()));
    w.routes['list_tickets'].path = '/customers/{customer}/tickets';
    w.routes['get_ticket'].path = '/customers/{customer}/tickets/{id}';
    assert.equal(check(w, host).ok, true);
  });
});
