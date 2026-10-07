/**
 * Self-tests for the red-team fixtures and harness (G-00), plus two engine examples that
 * show the cap() pattern. Fixture checks use worldSchema only to prove the fixtures are
 * well formed, never to compute an expected engine result.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorld, ISSUES, worldSchema, type IssueCode } from '#engine';
import { CAPABILITIES, CLI_CAPS, PROBE, STRICT, cap, capStatus, cliProbed, clone, ddmin, deepFreeze, mulberry32, rng } from './redteam/harness.ts';
import { BAD_TASKS } from './redteam/graders.ts';
import { MUTATIONS, NO_MUTATION_ROW } from './redteam/mutations.ts';
import { FACTS, SEED_PRIORITY, SEED_STATUS, TASK_IDS, baseWorld } from './redteam/world.ts';

describe('fixtures', () => {
  it('G-00 base world parses with worldSchema to itself', () => {
    const r = worldSchema.safeParse(baseWorld());
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues, null, 2));
    assert.deepEqual(r.data, baseWorld());
  });

  it('G-00 baseWorld returns an independent copy each call', () => {
    const a = baseWorld();
    a.meta.seed = 99;
    assert.equal(baseWorld().meta.seed, 7);
  });

  it('G-00 FACTS agree with the seed tables they were derived from', () => {
    assert.equal(SEED_STATUS.length, FACTS.counts.ticket);
    assert.equal(SEED_PRIORITY.length, FACTS.counts.ticket);
    assert.deepEqual(FACTS.ticketPages.flat(), FACTS.ticketIds);
    assert.deepEqual(Object.keys(baseWorld().tasks), [...TASK_IDS]);
    assert.equal(FACTS.refCodeOf('tkt_0005'), 'HD-1005');
  });

  it('G-00 mutation ids are unique', () => {
    const ids = MUTATIONS.map((m) => m.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  });

  it('G-00 mutation table covers every world-triggerable ISSUES code', () => {
    const covered = new Set<IssueCode>(MUTATIONS.map((m) => m.code));
    const missing = (Object.keys(ISSUES) as IssueCode[]).filter((c) => !covered.has(c) && !NO_MUTATION_ROW.includes(c));
    assert.deepEqual(missing, []);
    assert.ok(MUTATIONS.length >= 45, `only ${MUTATIONS.length} rows`);
  });

  it('G-00 every bad task and mutation changes the world', () => {
    const base = JSON.stringify(baseWorld());
    for (const m of MUTATIONS) {
      if (m.id === 'GR-range-exact-ends') continue;
      const w = baseWorld();
      m.mutate(w);
      assert.notEqual(JSON.stringify(w), base, `${m.id} did not change the world`);
    }
  });

  it('G-00 only schema-layer rows fail worldSchema', () => {
    for (const m of MUTATIONS) {
      const w = baseWorld();
      m.mutate(w);
      const parsed = worldSchema.safeParse(w).success;
      assert.equal(parsed, m.layer !== 'schema', `${m.id} (${m.note}) parsed=${parsed}`);
    }
  });

  it('G-00 bad tasks name only grader-related or snippet codes', () => {
    const allowed: readonly IssueCode[] = [
      'task.grader_out_of_range', 'task.solution_not_full_marks', 'task.noop_not_zero', 'task.decoy_required',
      'task.decoy_full_marks', 'task.decoy_trivial', 'task.prefix_full_marks', 'task.mutant_full_marks', 'task.nondeterministic',
      'task.idle_not_zero', 'task.alternative_not_full_marks',
      'world.too_few_tasks', 'snippet.runtime_error',
    ];
    for (const b of BAD_TASKS) assert.ok(allowed.includes(b.code), `${b.id} uses ${b.code}`);
    for (const code of allowed.filter((c) => c !== 'snippet.runtime_error')) {
      assert.ok(BAD_TASKS.some((b) => b.code === code && b.expect === 'present'), `no bad task for ${code}`);
    }
  });
});

describe('harness', () => {
  it('G-00 mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    const xs = Array.from({ length: 1000 }, () => a());
    assert.deepEqual(Array.from({ length: 1000 }, () => b()), xs);
    assert.ok(xs.every((x) => x >= 0 && x < 1));
    assert.notDeepEqual(Array.from({ length: 10 }, mulberry32(2)), xs.slice(0, 10));
  });

  it('G-00 rng.int stays in range and shuffle is a permutation', () => {
    const r = rng(42);
    for (let i = 0; i < 500; i++) {
      const n = r.int(-3, 3);
      assert.ok(Number.isInteger(n) && n >= -3 && n <= 3);
    }
    assert.deepEqual([...r.shuffle([1, 2, 3, 4, 5])].sort(), [1, 2, 3, 4, 5]);
    assert.throws(() => r.pick([]));
  });

  it('G-00 ddmin finds the minimal failing pair', () => {
    const calls = Array.from({ length: 20 }, (_, i) => i);
    assert.deepEqual(ddmin(calls, (s) => s.includes(3) && s.includes(17)), [3, 17]);
    assert.deepEqual(ddmin(calls, (s) => s.includes(9)), [9]);
    assert.deepEqual(ddmin([1, 2], () => false), [1, 2]);
  });

  it('G-00 deepFreeze freezes nested values and clone is independent', () => {
    const w = deepFreeze(baseWorld());
    assert.ok(Object.isFrozen(w.entities['ticket']?.fields));
    assert.throws(() => {
      (w.meta as { seed: number }).seed = 1;
    });
    const c = clone(w);
    c.meta.seed = 1;
    assert.equal(w.meta.seed, 7);
  });

  it('G-00 cap() skips exactly the capabilities the probe did not find', () => {
    for (const name of CAPABILITIES) {
      if (CLI_CAPS.includes(name)) continue;
      const s = capStatus(name);
      const expected = STRICT || s.state === 'ok' ? {} : { skip: s.reason };
      assert.deepEqual(cap(name), expected);
    }
    if (!cliProbed()) assert.throws(() => cap('cli'), /probeCli/);
  });
});

describe('engine examples', () => {
  it('G-01 checkWorld never throws on garbage', cap('checkWorld'), () => {
    for (const input of [null, undefined, 0, 'world', [], {}, { format: 1 }, deepFreeze(baseWorld())]) {
      const r = checkWorld(input);
      assert.equal(typeof r.ok, 'boolean');
    }
  });

  it('G-05 base world checks ok', cap('checkWorld'), () => {
    const r = PROBE.baseReport ?? checkWorld(baseWorld());
    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.issues, null, 2));
  });

  // Verdicts come from the tasks layer, so this half waits for that unit.
  it('G-05 base world report has a verdict for every task', cap('checkWorld', 'check.tasks'), () => {
    const r = PROBE.baseReport ?? checkWorld(baseWorld());
    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.issues, null, 2));
    if (r.ok) assert.deepEqual(Object.keys(r.verdicts).sort(), [...TASK_IDS].sort());
  });
});
