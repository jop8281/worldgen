/** YOS-176: one nullable timestamp alias must not hide another populated alias. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check } from '../src/engine/check.ts';
import { emptyWorld, worldSchema } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';

const host = createVmHost();
type Times = Record<string, string | number | null>;
type Options = {
  states?: string[];
  transitions?: Record<string, string[]>;
  types?: Record<string, 'datetime' | 'unix_time' | 'string'>;
};

/** No tasks are needed for a seed lint; assert that only the tasks-count gate fails. */
function timeWarnings(rows: readonly Times[], options: Options = {}) {
  const base = emptyWorld('orders', 'hand');
  const fields = Object.fromEntries(['paid_at', 'paid_on', 'shipped_at', 'shipped_on'].map((name) => [
    name, { type: options.types?.[name] ?? 'datetime', nullable: true },
  ]));
  const world = worldSchema.parse({
    ...base,
    meta: {
      ...base.meta, description: 'Orders with lifecycle event aliases.', resembles: 'an order API',
      clock: { ...base.meta.clock, start: '2026-01-05T09:00:00.000Z' },
    },
    entities: {
      order: {
        description: 'An order.', idPrefix: 'ord',
        fields: {
          status: {
            type: 'state', states: options.states ?? ['placed', 'paid', 'shipped'], initial: 'placed',
            transitions: options.transitions ?? { placed: ['paid'], paid: ['shipped'] },
          },
          ...fields,
        },
      },
    },
    seed: { order: `(ctx) => ${JSON.stringify(rows.map((row) => ({ status: 'shipped', ...row })))}` },
  });
  const report = check(world, host);
  if (report.ok) throw new Error('Expected the deliberately taskless fixture to reach the tasks-count gate.');
  assert.equal(report.reached, 'tasks');
  assert.deepEqual(report.issues.map((i) => i.code), ['world.too_few_tasks']);
  assert.equal(report.seeded?.['order']?.length, rows.length);
  return report.warnings.filter((i) => i.code === 'seed.time_order').map((i) => ({
    severity: i.severity, code: i.code, path: i.path, expected: i.expected, found: i.found, hint: i.hint,
  }));
}

const late = '2025-12-20T00:00:00.000Z';
const early = '2025-12-05T00:00:00.000Z';

describe('seed.time_order: lifecycle timestamp aliases', () => {
  it('checks paid_on when the declared paid_at alias is null, with the existing warning contract', () => {
    assert.deepEqual(timeWarnings([{ paid_at: null, paid_on: late, shipped_at: early }]), [{
      severity: 'warning', code: 'seed.time_order', path: ['seed', 'order'],
      expected: 'on every seeded row: created_at <= updated_at, past events such as created_at and placed_at at or before meta.clock.start, each end such as ends_at at or after its start, and past events in the order the state machine allows, such as paid_at before shipped_at',
      found: 'ord_0001: shipped_at 2025-12-05T00:00:00.000Z is before paid_on 2025-12-20T00:00:00.000Z',
      hint: 'order ord_0001: shipped_at 2025-12-05T00:00:00.000Z is before paid_on 2025-12-20T00:00:00.000Z. Seeded history happens before the clock starts. Only planned times such as due_at, scheduled_for or ends_at may lie after it.',
    }]);
  });

  it('checks the alternative when the earlier alias is omitted from the seed row', () => {
    assert.deepEqual(timeWarnings([{ paid_on: late, shipped_at: early }]).map((i) => i.found), [
      'ord_0001: shipped_at 2025-12-05T00:00:00.000Z is before paid_on 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('checks shipped_on when the declared shipped_at alias is null', () => {
    assert.deepEqual(timeWarnings([{ paid_at: late, shipped_at: null, shipped_on: early }]).map((i) => i.found), [
      'ord_0001: shipped_on 2025-12-05T00:00:00.000Z is before paid_at 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('checks the alternative when the later alias is omitted from the seed row', () => {
    assert.deepEqual(timeWarnings([{ paid_at: late, shipped_on: early }]).map((i) => i.found), [
      'ord_0001: shipped_on 2025-12-05T00:00:00.000Z is before paid_at 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('checks two populated _on aliases when both _at aliases are null', () => {
    assert.deepEqual(timeWarnings([{ paid_at: null, paid_on: late, shipped_at: null, shipped_on: early }]).map((i) => i.found), [
      'ord_0001: shipped_on 2025-12-05T00:00:00.000Z is before paid_on 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('does not let a valid paid_at hide a conflicting populated paid_on', () => {
    assert.deepEqual(timeWarnings([{
      paid_at: '2025-12-01T00:00:00.000Z', paid_on: late, shipped_at: early, shipped_on: late,
    }]).map((i) => i.found), [
      'ord_0001: shipped_at 2025-12-05T00:00:00.000Z is before paid_on 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('does not let a valid shipped_at hide a conflicting populated shipped_on', () => {
    assert.deepEqual(timeWarnings([{
      paid_at: late, paid_on: early, shipped_at: '2025-12-25T00:00:00.000Z', shipped_on: early,
    }]).map((i) => i.found), [
      'ord_0001: shipped_on 2025-12-05T00:00:00.000Z is before paid_at 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('compares a unix_time earlier alias with a datetime later alias in the same units', () => {
    assert.deepEqual(timeWarnings([{ paid_at: null, paid_on: 1766188800, shipped_at: early }], {
      types: { paid_on: 'unix_time' },
    }).map((i) => i.found), [
      'ord_0001: shipped_at 2025-12-05T00:00:00.000Z is before paid_on 1766188800',
    ]);
  });

  it('compares a datetime earlier alias with a unix_time later alias', () => {
    assert.deepEqual(timeWarnings([{ paid_at: late, shipped_at: null, shipped_on: 1764892800 }], {
      types: { shipped_on: 'unix_time' },
    }).map((i) => i.found), [
      'ord_0001: shipped_on 1764892800 is before paid_at 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('accepts ordered and equal timestamps across all alias combinations', () => {
    assert.deepEqual(timeWarnings([
      { paid_at: early, paid_on: early, shipped_at: late, shipped_on: late },
      { paid_at: early, paid_on: early, shipped_at: early, shipped_on: early },
      { paid_at: null, paid_on: early, shipped_at: null, shipped_on: late },
    ]), []);
  });

  it('does not turn absent history into an ordering warning', () => {
    assert.deepEqual(timeWarnings([{}, { paid_at: null, paid_on: null, shipped_at: null, shipped_on: null }]), []);
  });

  it('preserves the original _at-only comparison and first-warning precedence', () => {
    assert.deepEqual(timeWarnings([
      { paid_at: late, paid_on: late, shipped_at: early, shipped_on: early },
      { paid_at: null, paid_on: late, shipped_at: null, shipped_on: early },
    ]).map((i) => i.found), [
      'ord_0001: shipped_at 2025-12-05T00:00:00.000Z is before paid_at 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('does not order aliases belonging to states on a cycle', () => {
    assert.deepEqual(timeWarnings([{ paid_on: late, shipped_on: early }], {
      transitions: { placed: ['paid'], paid: ['shipped'], shipped: ['paid'] },
    }), []);
  });

  it('does not order aliases belonging to unrelated branches', () => {
    assert.deepEqual(timeWarnings([{ paid_on: late, shipped_on: early }], {
      transitions: { placed: ['paid', 'shipped'] },
    }), []);
  });

  it('keeps ordering through an intermediate state without timestamp fields', () => {
    assert.deepEqual(timeWarnings([{ paid_on: late, shipped_on: early }], {
      states: ['placed', 'paid', 'packed', 'shipped'],
      transitions: { placed: ['paid'], paid: ['packed'], packed: ['shipped'] },
    }).map((i) => i.found), [
      'ord_0001: shipped_on 2025-12-05T00:00:00.000Z is before paid_on 2025-12-20T00:00:00.000Z',
    ]);
  });

  it('ignores an alias whose field is not temporal', () => {
    assert.deepEqual(timeWarnings([{ paid_on: 'not a timestamp', shipped_on: early }], {
      types: { paid_on: 'string' },
    }), []);
  });
});
