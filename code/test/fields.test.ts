import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIELD_TYPE_ORDER, FIELD_TYPES, choicesOf, fieldSchema, initialOf, machineOf, refOf } from '../src/engine/fields.ts';
import type { FieldType } from '../src/engine/fields.ts';
import { checkWorld } from '../src/engine/index.ts';
import { fromZod } from '../src/engine/issues.ts';

const types = Object.keys(FIELD_TYPES) as FieldType[];
// The kinds' def parameter is a different type per entry, so tests call through a loose view.
type Loose = {
  schema: { parse(x: unknown): unknown };
  validate(v: unknown, d: unknown): { ok: boolean; value?: unknown; expected?: string };
  compare(a: unknown, b: unknown, d: unknown): number;
  parseQuery(raw: string, d: unknown): { ok: boolean; value?: unknown; expected?: string };
  inferFromCsv(c: readonly string[]): unknown;
  examples: { def: unknown; valid: readonly unknown[]; invalid: readonly unknown[] };
};
const kindOf = (t: FieldType): Loose => FIELD_TYPES[t] as unknown as Loose;
const def = (t: FieldType, extra: object = {}) => kindOf(t).schema.parse({ type: t, ...extra });

describe('FIELD_TYPES conformance', () => {
  for (const t of types) {
    const k = kindOf(t);
    it(`${t}: every examples.valid value passes`, () => {
      const d = k.schema.parse(k.examples.def);
      for (const v of k.examples.valid) assert.equal(k.validate(v, d).ok, true, `${t} should accept ${JSON.stringify(v)}`);
    });
    it(`${t}: every examples.invalid value fails with an expected string`, () => {
      const d = k.schema.parse(k.examples.def);
      for (const v of k.examples.invalid) {
        const r = k.validate(v, d);
        assert.equal(r.ok, false, `${t} should reject ${JSON.stringify(v)}`);
        assert.ok(typeof r.expected === 'string' && r.expected.length > 0);
      }
    });
    it(`${t}: has at least one valid and one invalid example, and null sorts first`, () => {
      const d = k.schema.parse(k.examples.def);
      assert.ok(k.examples.valid.length > 0);
      assert.ok(k.examples.invalid.length > 0);
      const v = k.examples.valid[0] as string | number | boolean;
      assert.equal(k.compare(null, v, d), -1);
      assert.equal(k.compare(v, null, d), 1);
      assert.equal(k.compare(null, null, d), 0);
    });
    it(`${t}: the field schema is reachable through fieldSchema`, () => {
      assert.equal((fieldSchema.parse(k.examples.def) as { type: string }).type, t);
    });
  }
});

describe('money', () => {
  const d = def('money', { currency: 'USD', min: 0 });
  it('rejects 12.5, -1 when min is 0, and the string 1250', () => {
    assert.equal(FIELD_TYPES.money.validate(12.5, d as never).ok, false);
    assert.equal(FIELD_TYPES.money.validate(-1, d as never).ok, false);
    assert.equal(FIELD_TYPES.money.validate('1250', d as never).ok, false);
  });
  it('accepts 0 and 1250', () => {
    assert.deepEqual(FIELD_TYPES.money.validate(0, d as never), { ok: true, value: 0 });
    assert.deepEqual(FIELD_TYPES.money.validate(1250, d as never), { ok: true, value: 1250 });
  });
  it('parseQuery("1250") returns 1250 and parseQuery("12.5") fails', () => {
    assert.deepEqual(FIELD_TYPES.money.parseQuery('1250', d as never), { ok: true, value: 1250 });
    assert.equal(FIELD_TYPES.money.parseQuery('12.5', d as never).ok, false);
  });
  it('is never inferred from a CSV column', () => {
    assert.equal(FIELD_TYPES.money.inferFromCsv(['1250', '300']), null);
  });
});

describe('datetime', () => {
  const k = kindOf('datetime');
  const d = def('datetime');
  it('accepts only ISO 8601 UTC strings', () => {
    assert.equal(k.validate('2026-03-02T09:00:00Z', d).ok, true);
    assert.equal(k.validate('2026-03-02T09:00:00.123Z', d).ok, true);
    assert.equal(k.validate('2026-03-02T09:00:00+02:00', d).ok, false);
    assert.equal(k.validate('2026-03-02', d).ok, false);
    assert.equal(k.validate('2026-02-30T00:00:00Z', d).ok, false);
    assert.equal(k.validate('2026-13-01T00:00:00Z', d).ok, false);
    assert.equal(k.validate('2024-02-29T00:00:00Z', d).ok, true);
    assert.equal(k.validate('2026-02-29T00:00:00Z', d).ok, false);
    assert.equal(k.validate(1700000000, d).ok, false);
  });
  it('compare orders chronologically across fraction widths', () => {
    assert.equal(k.compare('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.001Z', d), -1);
    assert.equal(k.compare('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z', d), 0);
    assert.equal(k.compare('2027-01-01T00:00:00Z', '2026-12-31T23:59:59.999Z', d), 1);
  });
  it('R5 validate returns one canonical form: at least 3 fraction digits, trailing zeros past 3 dropped', () => {
    assert.deepEqual(k.validate('2026-01-01T00:00:00Z', d), { ok: true, value: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(k.validate('2026-01-01T00:00:00.000Z', d), { ok: true, value: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(k.validate('2026-01-01T00:00:00.5Z', d), { ok: true, value: '2026-01-01T00:00:00.500Z' });
    assert.deepEqual(k.validate('2026-01-01T00:00:00.123400Z', d), { ok: true, value: '2026-01-01T00:00:00.1234Z' });
    assert.deepEqual(k.validate('2026-01-01T00:00:00.000000000Z', d), { ok: true, value: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(k.validate('2026-01-01T00:00:00.000000001Z', d), { ok: true, value: '2026-01-01T00:00:00.000000001Z' });
  });
  it('parseQuery applies the same rule', () => {
    assert.deepEqual(k.parseQuery('2026-03-02T09:00:00Z', d), { ok: true, value: '2026-03-02T09:00:00Z' });
    assert.equal(k.parseQuery('yesterday', d).ok, false);
  });
});

describe('compare', () => {
  it('orders numbers, strings and bools', () => {
    assert.equal(kindOf('int').compare(2, 10, def('int')), -1);
    assert.equal(kindOf('number').compare(2.5, 2.5, def('number')), 0);
    assert.equal(kindOf('money').compare(300, 200, def('money', { currency: 'USD' })), 1);
    assert.equal(kindOf('string').compare('B', 'a', def('string')), -1);
    assert.equal(kindOf('bool').compare(false, true, def('bool')), -1);
    assert.equal(kindOf('ref').compare('cus_0002', 'cus_0010', def('ref', { entity: 'customer' })), -1);
  });
  it('orders enum and state by declaration order', () => {
    const e = def('enum', { values: ['low', 'high'] });
    assert.equal(kindOf('enum').compare('low', 'high', e), -1);
    const s = def('state', { states: ['open', 'closed'], initial: 'open', transitions: { open: ['closed'], closed: [] } });
    assert.equal(kindOf('state').compare('closed', 'open', s), 1);
  });
});

describe('state and ref', () => {
  const s = def('state', { states: ['open', 'closed'], initial: 'open', transitions: { open: ['closed'], closed: [] } });
  it('state accepts only declared states, whatever the transitions say', () => {
    assert.deepEqual(kindOf('state').validate('closed', s), { ok: true, value: 'closed' });
    assert.equal(kindOf('state').validate('archived', s).ok, false);
    assert.equal(kindOf('state').parseQuery('archived', s).ok, false);
  });
  it('ref accepts any non-empty string id and rejects numbers and empty', () => {
    const r = def('ref', { entity: 'customer' });
    assert.deepEqual(kindOf('ref').validate('cus_0001', r), { ok: true, value: 'cus_0001' });
    assert.equal(kindOf('ref').validate(42, r).ok, false);
    assert.equal(kindOf('ref').validate('', r).ok, false);
  });
});

describe('validate details', () => {
  it('string enforces maxLength, pattern and format', () => {
    const k = kindOf('string');
    assert.equal(k.validate('abcdef', def('string', { maxLength: 5 })).ok, false);
    assert.equal(k.validate('ab1', def('string', { pattern: '^[a-z]+$' })).ok, false);
    assert.equal(k.validate('ab', def('string', { pattern: '^[a-z]+$' })).ok, true);
    assert.equal(k.validate('a@b.co', def('string', { format: 'email' })).ok, true);
    assert.equal(k.validate('nope', def('string', { format: 'email' })).ok, false);
    assert.equal(k.validate('https://x.io/a', def('string', { format: 'url' })).ok, true);
    assert.equal(k.validate('ftp://x.io', def('string', { format: 'url' })).ok, false);
    assert.equal(k.validate('+14155550123', def('string', { format: 'phone' })).ok, true);
    assert.equal(k.validate('abc', def('string', { format: 'phone' })).ok, false);
    assert.equal(k.validate('x', { type: 'string', pattern: '(' }).ok, false);
  });
  it('int and number enforce bounds and finiteness', () => {
    assert.equal(kindOf('int').validate(4, def('int', { min: 1, max: 3 })).ok, false);
    assert.equal(kindOf('number').validate(Number.NaN, def('number')).ok, false);
    assert.equal(kindOf('number').validate(Infinity, def('number')).ok, false);
    assert.equal(kindOf('number').validate(5, def('number', { max: 4 })).ok, false);
  });
  it('text accepts strings only and is not filterable', () => {
    assert.equal(kindOf('text').validate('x', def('text')).ok, true);
    assert.equal(kindOf('text').parseQuery('x', def('text')).ok, false);
  });
});

describe('parseQuery', () => {
  it('bool accepts true and false only', () => {
    const k = kindOf('bool');
    assert.deepEqual(k.parseQuery('true', def('bool')), { ok: true, value: true });
    assert.deepEqual(k.parseQuery('false', def('bool')), { ok: true, value: false });
    assert.equal(k.parseQuery('TRUE', def('bool')).ok, false);
    assert.equal(k.parseQuery('1', def('bool')).ok, false);
  });
  it('int rejects 1.5 and accepts 7', () => {
    assert.equal(kindOf('int').parseQuery('1.5', def('int')).ok, false);
    assert.deepEqual(kindOf('int').parseQuery('7', def('int')), { ok: true, value: 7 });
    assert.deepEqual(kindOf('int').parseQuery('-7', def('int')), { ok: true, value: -7 });
  });
  it('number parses decimals', () => {
    assert.deepEqual(kindOf('number').parseQuery('4.5', def('number')), { ok: true, value: 4.5 });
    assert.equal(kindOf('number').parseQuery('abc', def('number')).ok, false);
  });
  it('enum rejects values outside values', () => {
    const e = def('enum', { values: ['low', 'high'] });
    assert.deepEqual(kindOf('enum').parseQuery('low', e), { ok: true, value: 'low' });
    const r = kindOf('enum').parseQuery('medium', e);
    assert.equal(r.ok, false);
    assert.equal(r.expected, 'one of low, high');
  });
  it('string and ref pass the raw text through', () => {
    assert.deepEqual(kindOf('string').parseQuery('abc', def('string')), { ok: true, value: 'abc' });
    assert.deepEqual(kindOf('ref').parseQuery('cus_0001', def('ref', { entity: 'customer' })), { ok: true, value: 'cus_0001' });
  });
});

describe('inferFromCsv', () => {
  const first = (col: string[]): unknown => {
    for (const t of FIELD_TYPE_ORDER) {
      const r = kindOf(t).inferFromCsv(col) as { type: string } | null;
      if (r) return r.type;
    }
    return null;
  };
  const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
  it('true/false is bool', () => assert.equal(first(['true', 'false']), 'bool'));
  it('1,2 is int', () => assert.equal(first(['1', '2']), 'int'));
  it('1.5,2 is number', () => assert.equal(first(['1.5', '2']), 'number'));
  it('an ISO UTC timestamp is datetime', () => assert.equal(first(['2026-01-01T00:00:00Z']), 'datetime'));
  it('30 rows over 3 values is enum with those values', () => {
    const col = many(30, (i) => ['a', 'b', 'c'][i % 3] as string);
    assert.equal(first(col), 'enum');
    assert.deepEqual((kindOf('enum').inferFromCsv(col) as { values: string[] }).values, ['a', 'b', 'c']);
  });
  it('29 rows over 3 values is string, not enum', () => assert.equal(first(many(29, (i) => ['a', 'b', 'c'][i % 3] as string)), 'string'));
  it('30 rows with 21 distinct values is string', () => assert.equal(first(many(30, (i) => `v${i % 21}`)), 'string'));
  it('30 rows with 20 distinct values is enum', () => assert.equal(first(many(30, (i) => `v${i % 20}`)), 'enum'));
  it('a long cell makes text, a short one string', () => {
    assert.equal(first(['short', 'words']), 'string');
    assert.equal(first(['x'.repeat(201)]), 'text');
    assert.equal(first(['x'.repeat(200)]), 'string');
  });
  it('ints beyond the safe range are not int, and 1.0 is not int', () => {
    assert.equal(first(['99999999999999999999']), 'number');
    assert.equal(first(['1.0']), 'number');
  });
  it('blank cells are ignored and mark the field nullable', () => {
    const r = kindOf('int').inferFromCsv(['1', '', '3']) as { nullable: boolean };
    assert.equal(r.nullable, true);
    assert.equal((kindOf('int').inferFromCsv(['1', '3']) as { nullable: boolean }).nullable, false);
  });
  it('an all-blank column infers nothing', () => {
    for (const t of FIELD_TYPE_ORDER) assert.equal(kindOf(t).inferFromCsv(['', ' ']), null);
  });
  it('bool rejects True and yes', () => assert.equal(kindOf('bool').inferFromCsv(['True', 'yes']), null));
});

describe('fieldSchema self-consistency', () => {
  type Hit = { code: string; path: (string | number)[] };
  const hits = (d: unknown): Hit[] => {
    const r = fieldSchema.safeParse(d);
    if (r.success) return [];
    return fromZod(r.error, ['entities', 't', 'fields', 'f'], { schema: fieldSchema, input: d }).map((i) => ({ code: i.code, path: [...i.path] }));
  };
  const at = (...rest: (string | number)[]) => ['entities', 't', 'fields', 'f', ...rest];
  const machine = { type: 'state', states: ['open', 'closed'], initial: 'open', transitions: { open: ['closed'], closed: [] } };

  it('accepts a consistent state machine, enum, int range, and string default', () => {
    assert.deepEqual(hits(machine), []);
    assert.deepEqual(hits({ type: 'enum', values: ['a', 'b'], default: 'b' }), []);
    assert.deepEqual(hits({ type: 'int', min: 3, max: 3 }), []);
    assert.deepEqual(hits({ type: 'string', maxLength: 3, pattern: '^a+$', default: 'aaa' }), []);
  });
  it('state initial outside states is state.bad_machine at initial', () => {
    assert.deepEqual(hits({ ...machine, initial: 'archived' }), [{ code: 'state.bad_machine', path: at('initial') }]);
  });
  it('transitions naming unknown states are state.bad_machine at the offending entry', () => {
    assert.deepEqual(hits({ ...machine, transitions: { open: ['closed', 'gone'], ghost: [] } }), [
      { code: 'state.bad_machine', path: at('transitions', 'open', 1) },
      { code: 'state.bad_machine', path: at('transitions', 'ghost') },
    ]);
  });
  it('enum default outside values is field.default_invalid at default', () => {
    assert.deepEqual(hits({ type: 'enum', values: ['a', 'b'], default: 'zzz' }), [{ code: 'field.default_invalid', path: at('default') }]);
  });
  it('int and number min above max are field.range_inverted at min', () => {
    assert.deepEqual(hits({ type: 'int', min: 5, max: 1 }), [{ code: 'field.range_inverted', path: at('min') }]);
    assert.deepEqual(hits({ type: 'number', min: 2.5, max: 2.4 }), [{ code: 'field.range_inverted', path: at('min') }]);
  });
  it('string default longer than maxLength is field.default_invalid', () => {
    assert.deepEqual(hits({ type: 'string', maxLength: 2, default: 'toolong' }), [{ code: 'field.default_invalid', path: at('default') }]);
  });
  it('string default not matching pattern is field.default_invalid', () => {
    assert.deepEqual(hits({ type: 'string', pattern: '^[0-9]+$', default: 'abc' }), [{ code: 'field.default_invalid', path: at('default') }]);
  });
  it('an invalid regex is field.pattern_invalid at pattern and does not also fail the default', () => {
    assert.deepEqual(hits({ type: 'string', pattern: '([', default: 'x' }), [{ code: 'field.pattern_invalid', path: at('pattern') }]);
  });
  it('int, number and money defaults outside min or max are field.default_invalid at default', () => {
    assert.deepEqual(hits({ type: 'int', min: 1, max: 3, default: 9 }), [{ code: 'field.default_invalid', path: at('default') }]);
    assert.deepEqual(hits({ type: 'number', max: 1, default: 5 }), [{ code: 'field.default_invalid', path: at('default') }]);
    assert.deepEqual(hits({ type: 'money', currency: 'USD', min: 0, default: -100 }), [{ code: 'field.default_invalid', path: at('default') }]);
  });
  it('string default failing its format is field.default_invalid at default', () => {
    assert.deepEqual(hits({ type: 'string', format: 'email', default: 'not-an-email' }), [{ code: 'field.default_invalid', path: at('default') }]);
  });
  it('an inverted range with a default reports only field.range_inverted', () => {
    assert.deepEqual(hits({ type: 'int', min: 5, max: 1, default: 3 }), [{ code: 'field.range_inverted', path: at('min') }]);
  });
  it('defaults the type accepts pass, including datetime now', () => {
    assert.deepEqual(hits({ type: 'int', min: 1, max: 3, default: 3 }), []);
    assert.deepEqual(hits({ type: 'number', max: 1, default: 1 }), []);
    assert.deepEqual(hits({ type: 'money', currency: 'USD', min: 0, default: 0 }), []);
    assert.deepEqual(hits({ type: 'string', format: 'email', default: 'a@b.co' }), []);
    assert.deepEqual(hits({ type: 'datetime', default: 'now' }), []);
    assert.deepEqual(hits({ type: 'bool', default: false }), []);
    assert.deepEqual(hits({ type: 'enum', values: ['a', 'b'], default: 'b' }), []);
  });
  it('a repeated enum value or state is field.values_duplicate at the second entry', () => {
    assert.deepEqual(hits({ type: 'enum', values: ['a', 'a'] }), [{ code: 'field.values_duplicate', path: at('values', 1) }]);
    assert.deepEqual(hits({ type: 'state', states: ['open', 'open'], initial: 'open', transitions: { open: [] } }),
      [{ code: 'field.values_duplicate', path: at('states', 1) }]);
  });
  it('the default issue names the value and what the type expects', () => {
    const r = fieldSchema.safeParse({ type: 'int', min: 1, max: 3, default: 9 });
    assert.equal(r.success, false);
    if (r.success) return;
    const [i] = fromZod(r.error, [], { schema: fieldSchema, input: {} });
    assert.equal(i?.hint, 'default 9 is not a whole number <= 3. Change the default or the constraint.');
  });
  it('the duplicate issue names the repeated value', () => {
    const r = fieldSchema.safeParse({ type: 'enum', values: ['a', 'b', 'a'] });
    assert.equal(r.success, false);
    if (r.success) return;
    const [i] = fromZod(r.error, [], { schema: fieldSchema, input: {} });
    assert.deepEqual([i?.found, i?.hint], ['"a"', 'values lists "a" more than once. Remove the repeated entry.']);
  });
  it('the issue text names the problem', () => {
    const r = fieldSchema.safeParse({ type: 'int', min: 5, max: 1 });
    assert.equal(r.success, false);
    if (r.success) return;
    const [i] = fromZod(r.error, [], { schema: fieldSchema, input: {} });
    assert.equal(i?.hint.startsWith('min 5 is greater than max 1.'), true);
  });
});

describe('checkWorld reports inconsistent field definitions', () => {
  const world = (field: unknown) => ({ format: 1,
    meta: { name: 'w', description: '', resembles: '', source: 'hand', seed: 0, clock: { start: '2026-01-05T09:00:00.000Z' } },
    entities: { customer: { description: 'c', idPrefix: 'cus', fields: { f: field } } },
    routes: { list_c: { op: 'list', entity: 'customer', method: 'GET', path: '/customers' } },
    actions: {}, jobs: {}, fixtures: {}, seed: {}, tests: {}, tasks: {} });
  const run = (field: unknown) => {
    const r = checkWorld(world(field));
    assert.equal(r.ok, false);
    return r.ok ? [] : r.issues.filter((i) => i.code !== 'layer.blocked').map((i) => ({ code: i.code, path: [...i.path] }));
  };
  const base = ['entities', 'customer', 'fields', 'f'];
  it('enum default', () => assert.deepEqual(run({ type: 'enum', values: ['a'], default: 'z' }), [{ code: 'field.default_invalid', path: [...base, 'default'] }]));
  it('int range', () => assert.deepEqual(run({ type: 'int', min: 5, max: 1 }), [{ code: 'field.range_inverted', path: [...base, 'min'] }]));
  it('bad regex', () => assert.deepEqual(run({ type: 'string', pattern: '([' }), [{ code: 'field.pattern_invalid', path: [...base, 'pattern'] }]));
  it('money default below min', () =>
    assert.deepEqual(run({ type: 'money', currency: 'USD', min: 0, default: -100 }), [{ code: 'field.default_invalid', path: [...base, 'default'] }]));
  it('duplicate enum value', () =>
    assert.deepEqual(run({ type: 'enum', values: ['a', 'a'] }), [{ code: 'field.values_duplicate', path: [...base, 'values', 1] }]));
  it('state initial', () =>
    assert.deepEqual(run({ type: 'state', states: ['a', 'b'], initial: 'c', transitions: {} }), [{ code: 'state.bad_machine', path: [...base, 'initial'] }]));
});

describe('capability members read through refOf, machineOf, choicesOf and initialOf', () => {
  const NOW = '2026-03-02T09:00:00.000Z';
  const ref = def('ref', { entity: 'customer', onDelete: 'cascade' }) as Parameters<typeof refOf>[0];
  const state = def('state', { states: ['open', 'closed'], initial: 'open', transitions: { open: ['closed'], closed: [] } }) as Parameters<typeof refOf>[0];
  const pick = def('enum', { values: ['low', 'high'], default: 'low' }) as Parameters<typeof refOf>[0];
  const stamp = def('datetime', { default: 'now' }) as Parameters<typeof refOf>[0];
  const plain = def('int', { default: 7 }) as Parameters<typeof refOf>[0];

  it('refOf names the target and the delete rule of a ref and nothing else', () => {
    assert.deepEqual(refOf(ref), { entity: 'customer', onDelete: 'cascade' });
    for (const d of [state, pick, stamp, plain]) assert.equal(refOf(d), undefined);
  });

  it('machineOf returns the states, initial and transitions of a state and nothing else', () => {
    assert.deepEqual(machineOf(state), { states: ['open', 'closed'], initial: 'open', transitions: { open: ['closed'], closed: [] } });
    for (const d of [ref, pick, stamp, plain]) assert.equal(machineOf(d), undefined);
  });

  it('choicesOf lists the values of an enum and the states of a state', () => {
    assert.deepEqual(choicesOf(pick), ['low', 'high']);
    assert.deepEqual(choicesOf(state), ['open', 'closed']);
    for (const d of [ref, stamp, plain]) assert.equal(choicesOf(d), undefined);
  });

  it('initialOf starts a state at initial, resolves datetime now to engine time and falls back to the default', () => {
    assert.equal(initialOf(state, NOW), 'open');
    assert.equal(initialOf(stamp, NOW), NOW);
    assert.equal(initialOf(def('datetime') as Parameters<typeof refOf>[0], NOW), undefined);
    assert.equal(initialOf(def('unix_time', { default: 'now' }) as Parameters<typeof refOf>[0], NOW), 1772442000);
    assert.equal(initialOf(def('unix_time', { default: 5 }) as Parameters<typeof refOf>[0], NOW), 5);
    assert.equal(initialOf(pick, NOW), 'low');
    assert.equal(initialOf(plain, NOW), 7);
    assert.equal(initialOf(ref, NOW), undefined);
  });
});
