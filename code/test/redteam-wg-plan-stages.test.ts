/**
 * Red-team: worldgen/plan.ts and worldgen/stages.ts (factory unit wg-plan-stages-judge).
 *
 * Guarantees (one sentence each, with source):
 * WG-S01 SECTION_OWNER names every engine section exactly once; stage writes exclude plan-owned acceptance tests and input-owned fixtures. (stages.ts invariant; A-13)
 * WG-S02 Each stage reads only sections owned by an earlier stage or by input code. (stages.ts invariant "Stage order is dependency order")
 * WG-S03 On iterate, a stage reruns exactly when a section it owns or reads changed. (stages.ts stagesToRun doc; A-33)
 * WG-S04 stagesToRun returns stages in STAGE_IDS order without duplicates, all four when everything changed, none when nothing did. (stages.ts invariant)
 * WG-S05 Every planned job that the world lacks is a coverage gap at the workflow stage, as planned entities, routes, actions and tasks are. (plan.ts invariant "code computes plan coverage (names exist)"; workflow brief "each planned job runs on its schedule"; spec "plan first, later stages follow it")
 * WG-S06 A world that has every planned item has no coverage gaps, and names shaped like Object.prototype keys are still checked by own keys. (plan.ts planCoverage doc)
 * WG-S07 plan.yaml parses back through planSchema to the same plan even for YAML-hostile strings. (plan.ts renderPlanYaml doc; spec "plan saved, human-readable")
 * WG-S08 planSchema rejects a plan with fewer than three tasks or no workflow, and fills jobs and changes defaults. (plan.ts planSchema; spec "at least three graded tasks", "at least one real workflow")
 * WG-S09 Every stage `done` is a pure function of (report, plan) and returns the same issues on a repeat call. (stages.ts invariant "done is pure")
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { SECTIONS, type Section } from '#engine';
import { planCoverage, planSchema, renderPlanYaml } from '../src/worldgen/plan.ts';
import { SECTION_OWNER, STAGE_IDS, STAGES, stagesToRun, writesOf } from '../src/worldgen/stages.ts';
import { okReport, rtPlan, rtWorld } from './redteam-wg/fixtures.ts';

describe('redteam stages: ownership table', () => {
  it('WG-S01 SECTION_OWNER covers every section, and stage writes exclude plan-owned tests', () => {
    assert.deepEqual([...Object.keys(SECTION_OWNER)].sort(), ['actions', 'entities', 'fixtures', 'jobs', 'routes', 'seed', 'tasks', 'tests']);
    assert.deepEqual([...SECTIONS].sort(), ['actions', 'entities', 'fixtures', 'jobs', 'routes', 'seed', 'tasks', 'tests']);
    const writes = Object.fromEntries(STAGE_IDS.map((id) => [id, [...writesOf(id)].sort()]));
    assert.deepEqual(writes, {
      model: ['entities', 'routes'],
      workflow: ['actions', 'jobs'],
      seed: ['seed'],
      tasks: ['tasks'],
    });
    assert.equal(SECTION_OWNER.fixtures, 'input');
    assert.equal(SECTION_OWNER.tests, 'plan');
  });

  it('WG-S02 each stage reads only sections owned by an earlier stage or input', () => {
    const order = ['input', 'plan', ...STAGE_IDS] as const;
    for (const id of STAGE_IDS) {
      for (const s of STAGES[id].reads) {
        const owner = SECTION_OWNER[s];
        assert.equal(order.indexOf(owner) < order.indexOf(id), true, `${id} reads ${s}, owned by ${owner}`);
      }
    }
  });
});

describe('redteam stages: stagesToRun', () => {
  it('WG-S03 each single changed section reruns its owner and its readers', () => {
    const table: [Section, string[]][] = [
      ['entities', ['model', 'workflow', 'seed', 'tasks']],
      ['routes', ['model', 'workflow', 'tasks']],
      ['actions', ['workflow', 'tasks']],
      ['jobs', ['workflow', 'tasks']],
      ['tests', ['workflow']],
      ['seed', ['seed', 'tasks']],
      ['tasks', ['tasks']],
      ['fixtures', ['model', 'seed']],
    ];
    const got = table.map(([s]) => [s, [...stagesToRun(new Set([s]))]]);
    assert.deepEqual(got, table);
  });

  it('WG-S04 order, de-duplication, all and none', () => {
    assert.deepEqual(stagesToRun(new Set<Section>(['tasks', 'entities', 'routes'])), ['model', 'workflow', 'seed', 'tasks']);
    assert.deepEqual(stagesToRun(new Set<Section>(SECTIONS)), ['model', 'workflow', 'seed', 'tasks']);
    assert.deepEqual(stagesToRun(new Set<Section>()), []);
  });
});

describe('redteam plan: coverage', () => {
  it('WG-S05 a planned job missing from the world is a coverage gap at the workflow stage', () => {
    const w = rtWorld({ jobs: {} });
    const gaps = [...planCoverage(rtPlan, w), ...STAGES.workflow.done(okReport(w), rtPlan)];
    assert.equal(
      gaps.some((g) => g.code === 'plan.not_covered' && g.path[1] === 'jobs' && g.path[2] === 0),
      true,
      `no gap reported for planned job "sla_breach"; got ${JSON.stringify(gaps.map((g) => [g.code, g.path]))}`,
    );
  });

  it('WG-S06 full coverage yields no gaps; prototype-shaped names are checked as own keys', () => {
    assert.deepEqual(planCoverage(rtPlan, rtWorld()), []);
    const plan = { ...rtPlan, entities: [{ name: 'constructor', purpose: 'p', keyFields: [] }, { name: 'toString', purpose: 'p', keyFields: [] }] };
    const gaps = planCoverage(plan, rtWorld());
    assert.deepEqual(gaps.map((g) => [g.code, g.path]), [
      ['plan.not_covered', ['plan', 'entities', 0]],
      ['plan.not_covered', ['plan', 'entities', 1]],
    ]);
  });
});

describe('redteam plan: plan.yaml and schema', () => {
  it('WG-S07 plan.yaml round-trips YAML-hostile strings', () => {
    const hostile = planSchema.parse({
      software: 'yes',
      clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
      summary: 'null',
      verdict: { kind: 'refuse', why: 'key: value # not a comment' },
      entities: [{ name: 'true', purpose: '~', keyFields: ['0x1F', '1e3', '.inf'] }],
      workflows: [{ name: 'on', entity: 'true', states: ['NO', 'off'], rules: ['- dash', '[a, b]'], actions: ['{x}'] }],
      routes: [{ id: '007', method: 'GET', path: '/x/{id}', purpose: "it's \"quoted\"" }],
      seed: { rowsPerEntity: { null: 3, '1': 2, '~': 1 }, mix: '>' },
      tasks: [
        { id: '1.0', difficulty: 'easy', intent: '@x', decoyIdea: '*alias' },
        { id: '2', difficulty: 'medium', intent: '!tag', decoyIdea: '%dir' },
        { id: '3', difficulty: 'hard', intent: '\ttab', decoyIdea: 'line1\nline2\n' },
      ],
      assumptions: [{ decision: '&anchor', why: '| pipe' }],
      outOfScope: [{ what: '', why: ' leading space' }],
    });
    const back = planSchema.parse(parse(renderPlanYaml(hostile)));
    assert.deepEqual(back, hostile);
  });

  it('WG-S08 planSchema needs three tasks and a workflow, and defaults jobs and changes', () => {
    const { jobs: _j, changes: _c, ...base } = rtPlan;
    const parsed = planSchema.parse(base);
    assert.deepEqual(parsed.jobs, []);
    assert.deepEqual(parsed.changes, []);
    assert.equal(planSchema.safeParse({ ...base, tasks: rtPlan.tasks.slice(0, 2) }).success, false);
    assert.equal(planSchema.safeParse({ ...base, workflows: [] }).success, false);
  });
});

describe('redteam stages: done is pure', () => {
  it('WG-S09 every done returns equal results twice and leaves the plan untouched', () => {
    const w = rtWorld({ entities: {}, actions: {}, tasks: {} });
    const before = JSON.stringify(rtPlan);
    for (const id of STAGE_IDS) {
      const a = STAGES[id].done(okReport(w), rtPlan);
      const b = STAGES[id].done(okReport(w), rtPlan);
      assert.deepEqual(a, b, id);
      assert.equal(STAGES[id].done.length, 2, id);
    }
    assert.equal(JSON.stringify(rtPlan), before);
  });
});
