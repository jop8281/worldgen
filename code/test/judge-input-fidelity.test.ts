import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWorld, type CheckIssue, type World } from '#engine';
import type { InputDigest } from '../src/worldgen/input.ts';
import { inputCoverage } from '../src/worldgen/input-coverage.ts';
import { bareWorld, minimalWorld } from './helpers/world.ts';
import { blockingIssues } from '../src/worldgen/judge.ts';
import type { Plan } from '../src/worldgen/plan.ts';

const customers = [
  { name: 'Acme', tier: 'enterprise', region: 'emea' }, { name: 'Globex', tier: 'pro', region: 'amer' },
  { name: 'Initech', tier: 'pro', region: 'amer' }, { name: 'Umbrella', tier: 'free', region: 'apac' },
  { name: 'Hooli', tier: 'free', region: 'amer' }, { name: 'Vandelay', tier: 'pro', region: 'emea' },
];
const csv: InputDigest = { kind: 'csv', summary: 'Customers', fixtures: { customers }, operations: [], observations: [], apiShape: null };
const world = (seed: string): World => minimalWorld({ fixtures: { customers }, seed: { customer: seed } });
const paths = (issues: readonly CheckIssue[]) => issues.map((i) => [i.code, i.path]);
const coverage = (w: World) => {
  const report = checkWorld(w);
  assert.equal(report.ok, true, JSON.stringify(report.ok ? null : report.issues));
  return inputCoverage(csv, w, report);
};

describe('CSV fixture fidelity', () => {
  it('reports a seed that keeps the row count but rewrites fixture values', () => {
    const w = world("(ctx) => ctx.fixtures.customers.map((c, n) => ({ name: c.name, tier: n % 5 === 0 ? 'free' : c.tier }))");
    assert.deepEqual(paths(coverage(w)), [['plan.not_covered', ['seed', 'customer']]]);
  });

  it('accepts a seed that keeps every fixture value its entity has a field for', () => {
    const w = world('(ctx) => ctx.fixtures.customers.map((c) => ({ name: c.name, tier: c.tier }))');
    assert.deepEqual(coverage(w), []);
  });

  it('names the first rewritten rows by key, column, expected and found', () => {
    const w = world("(ctx) => ctx.fixtures.customers.map((c, n) => ({ name: c.name, tier: n % 5 === 0 ? 'free' : c.tier }))");
    const [first] = coverage(w);
    assert.equal(first?.found, 'row 1 (name="Acme") tier: expected "enterprise", found "free"; row 6 (name="Vandelay") tier: expected "pro", found "free"');
  });

  it('accepts a seed that spells an enum value in another case', () => {
    const upper = customers.map((c) => ({ ...c, tier: c.tier.toUpperCase() }));
    const w = minimalWorld({ fixtures: { customers: upper }, seed: { customer: "(ctx) => ctx.fixtures.customers.map((c) => ({ name: c.name, tier: c.tier.toLowerCase() }))" } });
    const report = checkWorld(w);
    assert.equal(report.ok, true);
    assert.deepEqual(inputCoverage({ ...csv, fixtures: { customers: upper } }, w, report), []);
  });
});

const digestOf = (fixtures: InputDigest['fixtures']): InputDigest => ({ ...csv, fixtures });
const checkedCoverage = (digest: InputDigest, w: World) => {
  const report = checkWorld(w);
  assert.equal(report.ok, true, JSON.stringify(report.ok ? null : report.issues));
  return inputCoverage(digest, w, report);
};

describe('CSV fixture fidelity for time columns and derived tables', () => {
  const loans = Array.from({ length: 6 }, (_, n) => ({ loan_code: `L${n + 1}`, returned_at: `2026-07-0${n + 1}T10:00:00Z`, fine_cents: 0 }));
  const loanWorld = (seed: string): World => minimalWorld({
    entities: { loan: { description: 'A loan.', idPrefix: 'ln', fields: {
      loan_code: { type: 'string', required: true, unique: true },
      returned_at: { type: 'datetime', nullable: true },
      fine_cents: { type: 'int', required: true },
    } } },
    fixtures: { loans }, seed: { loan: seed },
  });

  it('reports a seed that reopens returned rows when the import has no status column to explain it', () => {
    const w = loanWorld('(ctx) => ctx.fixtures.loans.map((l, n) => ({ ...l, returned_at: n % 5 === 0 ? null : l.returned_at }))');
    assert.deepEqual(paths(checkedCoverage(digestOf({ loans }), w)), [['plan.not_covered', ['seed', 'loan']]]);
  });

  it('accepts a null time where the kept imported status says it does not apply yet', () => {
    const shipments = [
      { code: 'S1', status: 'created', shipped_at: '2026-09-13T12:00:00Z' },
      { code: 'S2', status: 'shipped', shipped_at: '2026-09-10T08:00:00Z' },
    ];
    const w = minimalWorld({
      entities: { shipment: { description: 'A shipment.', idPrefix: 'shp', fields: {
        code: { type: 'string', required: true, unique: true },
        status: { type: 'enum', values: ['created', 'shipped'], required: true },
        shipped_at: { type: 'datetime', nullable: true },
      } } },
      fixtures: { shipments },
      seed: { shipment: "(ctx) => ctx.fixtures.shipments.map((s) => ({ ...s, shipped_at: s.status === 'created' ? null : s.shipped_at }))" },
    });
    assert.deepEqual(checkedCoverage(digestOf({ shipments }), w), []);
  });

  it('accepts a second entity that derives distinct values from a table another entity seeds in full', () => {
    const backlog = Array.from({ length: 6 }, (_, n) => ({ key: `YOS-${n + 1}`, label: n % 2 === 0 ? 'bug' : 'feature' }));
    const w = minimalWorld({
      entities: {
        issue: { description: 'An issue.', idPrefix: 'iss', fields: { key: { type: 'string', required: true, unique: true } } },
        label: { description: 'A label.', idPrefix: 'lbl', fields: { name: { type: 'string', required: true, unique: true } } },
      },
      fixtures: { backlog },
      seed: {
        issue: '(ctx) => ctx.fixtures.backlog.map((b) => ({ key: b.key }))',
        label: '(ctx) => [...new Set(ctx.fixtures.backlog.map((b) => b.label))].map((name) => ({ name }))',
      },
    });
    assert.deepEqual(checkedCoverage(digestOf({ backlog }), w), []);
  });
});

describe('CSV fixture gate at the seed step, before any task exists', () => {
  const plan: Plan = {
    revision: 1, acceptanceTests: [], software: 'Helpdesk', summary: 'Tests', verdict: { kind: 'proceed' }, entities: [], routes: [],
    clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' }, workflows: [], jobs: [], seed: { rowsPerEntity: {}, mix: '' }, tasks: [], assumptions: [], outOfScope: [], changes: [],
  };
  const noTasks = (seed: string): World => {
    const base = bareWorld();
    return { ...base, fixtures: { customers }, seed: { ...base.seed, customer: seed } };
  };
  const seedStep = (w: World) => {
    const report = checkWorld(w);
    assert.equal(report.ok, false);
    return paths(blockingIssues('seed', report, plan, w, csv).blocking);
  };

  it('blocks a seed that rewrites fixture values while the tasks step is still to come', () => {
    assert.deepEqual(seedStep(noTasks("(ctx) => ctx.fixtures.customers.map((c, n) => ({ name: c.name, tier: n % 5 === 0 ? 'free' : c.tier }))")), [['plan.not_covered', ['seed', 'customer']]]);
  });

  it('blocks a seed that drops fixture rows while the tasks step is still to come', () => {
    assert.deepEqual(seedStep(noTasks('(ctx) => ctx.fixtures.customers.slice(0, 5).map((c) => ({ name: c.name, tier: c.tier }))')), [['plan.not_covered', ['seed', 'customer']]]);
  });
});
