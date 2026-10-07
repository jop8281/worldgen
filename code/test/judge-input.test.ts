import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWorld, type CheckIssue, type World } from '#engine';
import { INPUT_KINDS, redact, type InputDigest } from '../src/worldgen/input.ts';
import { blockingIssues, inputCoverage } from '../src/worldgen/judge.ts';
import type { Plan } from '../src/worldgen/plan.ts';
import { ownerOf } from '../src/worldgen/policy.ts';
import { bareWorld, minimalWorld } from './helpers/world.ts';

const plan: Plan = {
  revision: 1, acceptanceTests: [], software: 'Helpdesk', summary: 'Tests', verdict: { kind: 'proceed' }, entities: [], routes: [],
  clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' }, workflows: [], jobs: [], seed: { rowsPerEntity: {}, mix: '' }, tasks: [], assumptions: [], outOfScope: [], changes: [],
};
const paths = (issues: readonly CheckIssue[]) => issues.map((i) => [i.code, i.path]);
const openapi = (paths: unknown, only: string[] = []): InputDigest => INPUT_KINDS.openapi.digest(redact('openapi', {
  document: { openapi: '3.1.0', paths }, only,
}));
const orders = openapi({ '/store/orders': { get: {}, post: {} } });
const ordersWorld = (): World => ({ ...bareWorld(), routes: {
  list_orders: { op: 'list', entity: 'customer', method: 'GET', path: '/store/orders', filters: [], search: [], sort: [], pageSize: 25 },
} });
const customers = [
  { name: 'Acme', tier: 'enterprise' }, { name: 'Globex', tier: 'pro' }, { name: 'Initech', tier: 'pro' },
  { name: 'Umbrella', tier: 'free' }, { name: 'Hooli', tier: 'free' },
];
const csv: InputDigest = {
  kind: 'csv', summary: 'Customers', fixtures: { customers }, operations: [], observations: [], apiShape: null,
};
const fixtureWorld = (source = '(ctx) => ctx.fixtures.customers', rows = customers): World => minimalWorld({
  fixtures: { customers: rows }, seed: { customer: source },
});

describe('original OpenAPI input coverage', () => {
  it('reports the omitted POST even when the plan did not promise it', () => {
    assert.deepEqual(inputCoverage(orders, ordersWorld()).map((i) => ({
      code: i.code, severity: i.severity, path: i.path, expected: i.expected, found: i.found, hint: i.hint,
    })), [{
      code: 'plan.not_covered', severity: 'error', path: ['routes', 'POST /store/orders'],
      expected: 'the planned input operation POST /store/orders exists in the world',
      found: 'no route or action with this method and path',
      hint: 'Build what the plan says, or change the plan in the plan step.',
    }]);
  });

  it('accepts matching operations supplied by either standard routes or actions', () => {
    const world = ordersWorld();
    world.actions.place_order = { method: 'POST', path: '/store/orders', input: {}, handler: '(ctx) => ({status: 201, body: null})' };
    assert.deepEqual(inputCoverage(orders, world), []);
  });

  it('uses router normalization for parameter names and trailing slashes but retains methods and literal segments', () => {
    const digest = openapi({ '/customers/{customerId}/': { get: {}, post: {} }, '/client/{id}': { get: {} } });
    assert.deepEqual(paths(inputCoverage(digest, bareWorld())), [
      ['plan.not_covered', ['routes', 'POST /customers/{customerId}/']],
      ['plan.not_covered', ['routes', 'GET /client/{id}']],
    ]);
  });

  it('retains every selected operation without examples, beyond the prose summary limit', () => {
    const paths = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`/store/item${i}`, { get: { summary: 'Long description '.repeat(20) } }]));
    const digest = openapi({ ...paths, '/storefront': { get: {} } }, ['/store/']);
    assert.equal(digest.summary.length <= 8000, true);
    assert.equal(digest.summary.includes('GET /store/item149'), false);
    assert.equal(digest.observations.length, 0);
    assert.equal(digest.operations.length, 150);
    assert.deepEqual(digest.operations[149], { method: 'GET', path: '/store/item149' });
    assert.equal(digest.operations.some((o) => o.path === '/storefront'), false);
    assert.equal(inputCoverage(digest, bareWorld()).length, 150);
  });

  it('compares the error template structurally without caring about object key order', () => {
    const world = bareWorld();
    const digest = { ...orders, operations: [], apiShape: { ...world.meta.api, error: { message: '$message', code: '$code' } } };
    assert.deepEqual(paths(inputCoverage(digest, world)), [['plan.not_covered', ['meta', 'api', 'error']]]);
    world.meta.api.error = { code: '$code', message: '$message' };
    assert.deepEqual(inputCoverage(digest, world), []);
  });

  it('description inputs add no coverage requirements', () => {
    assert.deepEqual(inputCoverage({ ...csv, kind: 'description' }, bareWorld()), []);
  });
});

describe('original CSV input coverage', () => {
  it('reports a mapped entity whose seed ignores the fixture', () => {
    const issues = inputCoverage(csv, minimalWorld());
    assert.deepEqual(paths(issues), [['plan.not_covered', ['seed', 'customer']]]);
    assert.equal(issues[0]?.found, 'seed does not reference ctx.fixtures.customers');
  });

  it('accepts fixture access in dot and literal bracket notation', () => {
    for (const source of ['(ctx) => ctx.fixtures.customers', '(ctx) => ctx.fixtures["customers"]', "(ctx) => ctx.fixtures['customers']"]) {
      const world = fixtureWorld(source);
      assert.equal(checkWorld(world).ok, true);
      assert.deepEqual(inputCoverage(csv, world), []);
    }
  });

  it('reports a shortened fixture seed using actual engine row counts', () => {
    const rows = [...customers, { name: 'Stark', tier: 'enterprise' }];
    const world = fixtureWorld('(ctx) => ctx.fixtures.customers.slice(0, 5)', rows);
    assert.equal(checkWorld(world).ok, true);
    const issues = inputCoverage({ ...csv, fixtures: { customers: rows } }, world);
    assert.deepEqual(paths(issues), [['plan.not_covered', ['seed', 'customer']]]);
    assert.equal(issues[0]?.found, '5 seeded rows; expected at least 6 from customers');
  });

  it('uses a fixture reference to map a differently named table to its entity', () => {
    const world = minimalWorld({ fixtures: { organizations: customers }, seed: { customer: '(ctx) => ctx.fixtures.organizations' } });
    assert.deepEqual(inputCoverage({ ...csv, fixtures: { organizations: customers } }, world), []);
  });

  it('caps the required fixture row count at 2000', () => {
    const rows = [...customers, ...Array.from({ length: 1996 }, (_, i) => ({ name: `Company ${i}`, tier: 'free' }))];
    const world = fixtureWorld('(ctx) => ctx.fixtures.customers.slice(0, 2000)', rows);
    const report = checkWorld(world);
    assert.equal(report.ok, true);
    assert.equal(report.ok && report.stats.rows.customer, 2000);
    assert.deepEqual(inputCoverage({ ...csv, fixtures: { customers: rows } }, world, report), []);
  });

  it('reports a fixture omitted by every entity seed', () => {
    assert.deepEqual(paths(inputCoverage({ ...csv, fixtures: { organizations: customers } }, minimalWorld())), [
      ['plan.not_covered', ['seed', 'organizations']],
    ]);
  });
});

describe('input coverage in the stage judge', () => {
  it('keeps input errors alongside failed engine diagnostics', () => {
    const world = minimalWorld({ routes: { missing: { op: 'get', entity: 'absent', method: 'GET', path: '/absent/{id}' } } });
    const report = checkWorld(world);
    assert.equal(report.ok, false);
    const result = blockingIssues('model', report, plan, world, orders);
    assert.equal(result.blocking.some((i) => i.code === 'ref.unknown'), true);
    assert.deepEqual(paths(result.blocking.filter((i) => i.code === 'plan.not_covered')), [
      ['plan.not_covered', ['routes', 'GET /store/orders']], ['plan.not_covered', ['routes', 'POST /store/orders']],
    ]);
    assert.equal(result.accepted, null);
  });

  it('blocks error-template drift at the model stage', () => {
    const world = minimalWorld();
    const digest = { ...orders, operations: [], apiShape: { ...world.meta.api, error: { code: '$code' } } };
    const result = blockingIssues('model', checkWorld(world), plan, world, digest);
    assert.deepEqual(paths(result.blocking), [['plan.not_covered', ['meta', 'api', 'error']]]);
    assert.equal(result.accepted, null);
  });

  it('defers a missing planned action until workflow and routes its repair there', () => {
    const world = minimalWorld({ actions: { resolve_ticket: { path: '/wrong/{id}' } } });
    const digest = openapi({ '/tickets/{ticketId}/resolve': { post: {} } });
    const actionPlan: Plan = { ...plan, routes: [{ id: 'resolve_ticket', method: 'POST', path: '/tickets/{id}/resolve', purpose: 'resolve' }],
      workflows: [{ name: 'resolution', entity: 'ticket', states: [], rules: [], actions: ['resolve_ticket'] }] };
    const report = checkWorld(world);
    assert.deepEqual(blockingIssues('model', report, actionPlan, world, digest).blocking, []);
    const result = blockingIssues('workflow', report, actionPlan, world, digest);
    const coverage = result.blocking.filter((i) => i.code === 'plan.not_covered');
    assert.equal(coverage.some((i) => i.path[0] === 'actions' && i.path[1] === 'POST /tickets/{ticketId}/resolve'), true);
    assert.equal(coverage.every((i) => ownerOf(i) === 'workflow'), true);
  });

  it('defers fixture checks until seed and blocks final acceptance of an undersized seed', () => {
    const rows = [...customers, { name: 'Stark', tier: 'enterprise' }];
    const world = fixtureWorld('(ctx) => ctx.fixtures.customers.slice(0, 5)', rows);
    const digest = { ...csv, fixtures: { customers: rows } };
    const report = checkWorld(world);
    assert.equal(report.ok, true);
    assert.deepEqual(blockingIssues('model', report, plan, world, digest).blocking, []);
    for (const stage of ['seed', 'tasks'] as const) {
      const result = blockingIssues(stage, report, plan, world, digest);
      assert.deepEqual(paths(result.blocking), [['plan.not_covered', ['seed', 'customer']]]);
      assert.equal(result.accepted, null);
    }
  });

  it('still checks fixture references when failed engine checks expose no row counts', () => {
    const world = bareWorld();
    const report = checkWorld(world);
    assert.equal(report.ok, false);
    assert.deepEqual(paths(blockingIssues('seed', report, plan, world, csv).blocking), [['plan.not_covered', ['seed', 'customer']]]);
  });
});
