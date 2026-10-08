/**
 * Every field type a world can declare, one entry each in FIELD_TYPES.
 *
 * An entry owns everything the repo knows about its type. That is the zod schema of the
 * field definition, how a value is validated and ordered, how a query string is
 * parsed, how a CSV column is recognized, the doc text, and conformance examples.
 *
 * Invariants:
 * - store.ts, api.ts and worldgen/input.ts never switch on `def.type`. They call
 *   `FIELD_TYPES[def.type].validate / compare / parseQuery / inferFromCsv`.
 *   A new entry missing any member does not compile.
 * - Stored values are scalars (`Value`). Money is integer minor units, never a float.
 * - test/fields.test.ts loops over every entry and asserts each `examples.valid`
 *   value is accepted and each `examples.invalid` value is rejected.
 */
import { z } from 'zod';
import { fromIso } from './clock.ts';
import type { FieldContradictionCode } from './issues.ts';

/** The only values a row can hold. Objects and arrays are not values. */
export type Value = string | number | boolean | null;

export const Name = z.string().regex(/^[a-z][a-z0-9_]*$/).describe('snake_case identifier');
/** A field or action-input name. camelCase is allowed so an OpenAPI world keeps its spec's names, such as photoUrls (A-187). */
export const FieldName = z.string().regex(/^[a-z][a-zA-Z0-9_]*$/).describe('field name: snake_case or camelCase');

const common = {
  description: z.string().optional(),
  required: z.boolean().default(false),
  nullable: z.boolean().default(false),
  unique: z.boolean().default(false),
  readonly: z
    .boolean()
    .default(false)
    .describe('Standard create and update refuse this field. Only actions, jobs and seed set it.'),
  sensitive: z
    .boolean()
    .optional()
    .describe('The Studio shows a fixed mask instead of this field\'s value to any role below admin (A-356). The world API still returns it.'),
};

type Check = { ok: true; value: Value } | { ok: false; expected: string };

/** What a `ref` field points at and what happens to the referencing row when the target is deleted. */
export type RefTarget = { readonly entity: string; readonly onDelete: 'restrict' | 'cascade' | 'nullify' };

/** A field whose value follows declared transitions. */
export type Machine = { readonly states: readonly string[]; readonly initial: string; readonly transitions: Readonly<Record<string, readonly string[]>> };

/** What every field type must provide. `D` is the parsed field definition. */
export type FieldKind<T extends string, D> = {
  readonly type: T;
  readonly schema: z.ZodType<D>;
  readonly doc: string;
  /** Validate a value written through the API, a handler, a job or seed. */
  validate(value: unknown, def: D): Check;
  /** Validate the definition's own `default`, when its accepted forms differ from `validate`. */
  validateDefault?(value: unknown, def: D): Check;
  /** Total order used by sort and cursor paging. Null sorts first. */
  compare(a: Value, b: Value, def: D): number;
  /** Parse a list filter from the query string (`?amount=1250`). */
  parseQuery(raw: string, def: D): Check;
  /** The value a create fills in when the field is absent, when it is not just `def.default`. `nowIso` is engine time. */
  initialValue?(def: D, nowIso: string): Value | undefined;
  /** Present on a type whose value is one of a closed list. */
  choices?(def: D): readonly string[];
  /** True on a type whose value is a point in time. Callers read it through `temporalOf`. */
  temporal?: true;
  /** Present on a type that points at another entity. Callers read it through `refOf`. */
  ref?(def: D): RefTarget;
  /** Present on a type with declared transitions. Callers read it through `machineOf`. */
  machine?(def: D): Machine;
  /** Propose this type for a CSV column, or null. Called by worldgen/input.ts in FIELD_TYPE_ORDER. */
  inferFromCsv(column: readonly string[]): D | null;
  readonly examples: { readonly def: unknown; readonly valid: readonly unknown[]; readonly invalid: readonly unknown[] };
};

const ok = (value: Value): Check => ({ ok: true, value });
const bad = (expected: string): Check => ({ ok: false, expected });

const INT_RE = /^-?\d+$/;
const NUMBER_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#][^\s]*$/i;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;
const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/** Longest CSV cell that still reads as a short string. Longer columns infer as text. */
const STRING_MAX_CHARS = 200;
/** An enum is inferred only for columns with at least ENUM_MIN_ROWS rows and at most ENUM_MAX_DISTINCT values. */
const ENUM_MIN_ROWS = 30;
const ENUM_MAX_DISTINCT = 20;

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number): number => (m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

/** Calendar-checked ISO 8601 UTC string, normalized so that string order is time order. No Date. */
function normalizeInstant(raw: string): string | null {
  const m = ISO_UTC_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || se > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${(m[7] ?? '').padEnd(9, '0')}Z`;
}

/** Code-unit order, so the result never depends on a locale. */
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Null sorts first for every type. Returns undefined when neither side is null. */
function nullOrder(a: Value, b: Value): number | undefined {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return undefined;
}

function checkInt(value: unknown, min: number | undefined, max: number | undefined): Check {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return bad('a whole number');
  if (min !== undefined && value < min) return bad(`a whole number >= ${min}`);
  if (max !== undefined && value > max) return bad(`a whole number <= ${max}`);
  return ok(value);
}

function checkNumber(value: unknown, def: { min?: number | undefined; max?: number | undefined }): Check {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bad('a finite number');
  if (def.min !== undefined && value < def.min) return bad(`a number >= ${def.min}`);
  if (def.max !== undefined && value > def.max) return bad(`a number <= ${def.max}`);
  return ok(value);
}

function checkMoney(value: unknown, def: { min?: number | undefined }): Check {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return bad('an integer amount in minor units');
  if (def.min !== undefined && value < def.min) return bad(`an integer amount in minor units >= ${def.min}`);
  return ok(value);
}

function checkString(value: unknown, def: { maxLength?: number | undefined; pattern?: string | undefined; format?: 'email' | 'url' | 'phone' | undefined }): Check {
  if (typeof value !== 'string') return bad('a string');
  if (def.maxLength !== undefined && value.length > def.maxLength) return bad(`a string of at most ${def.maxLength} characters`);
  if (def.pattern !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(def.pattern);
    } catch {
      return bad(`a valid regular expression in pattern, got ${def.pattern}`);
    }
    if (!re.test(value)) return bad(`a string matching /${def.pattern}/`);
  }
  if (def.format === 'email' && !EMAIL_RE.test(value)) return bad('an email address');
  if (def.format === 'url' && !URL_RE.test(value)) return bad('an http or https URL');
  if (def.format === 'phone' && !PHONE_RE.test(value)) return bad('a phone number such as +14155550123');
  return ok(value);
}

const DATETIME_EXPECTED = 'an ISO 8601 UTC timestamp such as 2026-03-02T09:00:00.000Z';

/**
 * The one stored form of an instant: milliseconds always written, digits past them only up to
 * the last non-zero one. Equal instants give equal strings, so unique compares instants.
 */
function canonicalInstant(raw: string): string | null {
  const n = normalizeInstant(raw);
  if (n === null) return null;
  const frac = n.slice(20, 29).replace(/0+$/, '').padEnd(3, '0');
  return `${n.slice(0, 19)}.${frac}Z`;
}

function checkDatetime(value: unknown): Check {
  const c = typeof value === 'string' ? canonicalInstant(value) : null;
  return c === null ? bad(DATETIME_EXPECTED) : ok(c);
}

/** Query values keep their raw form; filters compare through `compare`, which normalizes. */
function checkDatetimeQuery(value: unknown): Check {
  if (typeof value !== 'string' || normalizeInstant(value) === null) return bad(DATETIME_EXPECTED);
  return ok(value);
}

function checkOneOf(value: unknown, values: readonly string[]): Check {
  if (typeof value !== 'string' || !values.includes(value)) return bad(`one of ${values.join(', ')}`);
  return ok(value);
}

function checkRef(value: unknown): Check {
  if (typeof value !== 'string' || value === '') return bad('a non-empty id string');
  return ok(value);
}

/** Cells of a column that carry data. Blank cells are missing values. */
const filled = (column: readonly string[]): string[] => column.filter((c) => c.trim() !== '');
const hasBlank = (column: readonly string[]): boolean => filled(column).length < column.length;
/** True when the column has data and every non-blank cell passes `test`. */
const allCells = (column: readonly string[], test: (cell: string) => boolean): boolean => {
  const cells = filled(column);
  return cells.length > 0 && cells.every(test);
};

/** A self-contradiction in one field definition. `path` is relative to the field. */
type Contradiction = { code: FieldContradictionCode; path: (string | number)[]; problem: string; found?: string };

const quote = (v: unknown): string => JSON.stringify(v);

/** Index of the first entry that repeats an earlier one, or -1. */
function firstDuplicate(list: readonly string[]): number {
  return list.findIndex((v, i) => list.indexOf(v) !== i);
}

/** Structural contradictions inside one definition. Pure, so fieldSchema and checkWorld agree. */
function consistency(def: Record<string, unknown>): Contradiction[] {
  const out: Contradiction[] = [];
  const add = (code: Contradiction['code'], path: (string | number)[], problem: string, found?: string): void => {
    out.push(found === undefined ? { code, path, problem } : { code, path, problem, found });
  };
  const duplicate = (key: 'values' | 'states'): void => {
    const list = def[key] as readonly string[];
    const i = firstDuplicate(list);
    if (i >= 0) add('field.values_duplicate', [key, i], `${key} lists ${quote(list[i])} more than once.`, quote(list[i]));
  };
  if (def.type === 'state') {
    duplicate('states');
    const states = def.states as readonly string[];
    const transitions = def.transitions as Readonly<Record<string, readonly string[]>>;
    const list = states.join(', ');
    if (!states.includes(def.initial as string)) {
      add('state.bad_machine', ['initial'], `initial ${quote(def.initial)} is not one of the states ${list}.`, quote(def.initial));
    }
    for (const [from, tos] of Object.entries(transitions)) {
      if (!states.includes(from)) {
        add('state.bad_machine', ['transitions', from], `transitions from ${quote(from)}, which is not one of the states ${list}.`, quote(from));
        continue;
      }
      tos.forEach((to, i) => {
        if (!states.includes(to)) {
          add('state.bad_machine', ['transitions', from, i], `transition ${from} -> ${to} goes to ${quote(to)}, which is not one of the states ${list}.`, quote(to));
        }
      });
    }
  } else if (def.type === 'enum') {
    duplicate('values');
  } else if (def.type === 'int' || def.type === 'number') {
    const { min, max } = def as { min?: number; max?: number };
    if (min !== undefined && max !== undefined && min > max) add('field.range_inverted', ['min'], `min ${min} is greater than max ${max}.`);
  } else if (def.type === 'string') {
    const { pattern } = def as { pattern?: string };
    if (pattern !== undefined) {
      try {
        new RegExp(pattern);
      } catch {
        add('field.pattern_invalid', ['pattern'], `pattern ${quote(pattern)} is not a valid regular expression.`);
      }
    }
  }
  return out;
}

function kind<const T extends string, S extends z.ZodRawShape>(
  type: T,
  shape: S,
  impl: (schema: z.ZodObject<{ type: z.ZodLiteral<T> } & typeof common & S>) => Omit<
    FieldKind<T, z.output<z.ZodObject<{ type: z.ZodLiteral<T> } & typeof common & S>>>,
    'type' | 'schema'
  >,
) {
  const schema = z.strictObject({ type: z.literal(type), ...common, ...shape }).superRefine((def, ctx) => {
    const found = consistency(def as Record<string, unknown>);
    // A broken constraint would also fail the default, so the default is judged only against a sound definition.
    const dflt = (def as { default?: unknown }).default;
    if (found.length === 0 && dflt !== undefined) {
      const c = (kindImpl.validateDefault ?? kindImpl.validate)(dflt, def);
      if (!c.ok) found.push({ code: 'field.default_invalid', path: ['default'], problem: `default ${quote(dflt)} is not ${c.expected}.` });
    }
    for (const p of found) {
      ctx.addIssue({ code: 'custom', message: p.problem, path: p.path, params: { issue: p.code, problem: p.problem, found: p.found } });
    }
  });
  const kindImpl = impl(schema);
  return { type, schema, ...kindImpl };
}

const KINDS = [
  kind('string', { maxLength: z.number().int().positive().optional(), pattern: z.string().optional(),
    format: z.enum(['email', 'url', 'phone']).optional(), default: z.string().optional() }, (schema) => ({
    doc: 'Short text. Optional maxLength, pattern, format.',
    validate: checkString,
    compare: (a, b) => nullOrder(a, b) ?? cmpStr(String(a), String(b)),
    parseQuery: checkString,
    inferFromCsv: (column) => {
      const cells = filled(column);
      return cells.length > 0 && cells.every((c) => c.length <= STRING_MAX_CHARS) ? schema.parse({ type: 'string', nullable: hasBlank(column) }) : null;
    },
    examples: { def: { type: 'string', maxLength: 5 }, valid: ['abc'], invalid: [12, 'abcdef'] },
  })),
  kind('text', { default: z.string().optional() }, (schema) => ({
    doc: 'Long free text. Not filterable, searchable when listed in a route search.',
    validate: (value) => (typeof value === 'string' ? ok(value) : bad('a string')),
    compare: (a, b) => nullOrder(a, b) ?? cmpStr(String(a), String(b)),
    parseQuery: () => bad('no filter, text fields are not filterable'),
    inferFromCsv: (column) => (filled(column).length > 0 ? schema.parse({ type: 'text', nullable: hasBlank(column) }) : null),
    examples: { def: { type: 'text' }, valid: ['a long note'], invalid: [true] },
  })),
  kind('int', { min: z.number().int().optional(), max: z.number().int().optional(), default: z.number().int().optional() }, (schema) => ({
    doc: 'Whole number. Optional min and max.',
    validate: (value, def) => checkInt(value, def.min, def.max),
    compare: (a, b) => nullOrder(a, b) ?? cmpNum(Number(a), Number(b)),
    parseQuery: (raw, def) => (INT_RE.test(raw) ? checkInt(Number(raw), def.min, def.max) : bad('a whole number')),
    inferFromCsv: (column) =>
      allCells(column, (c) => INT_RE.test(c) && Number.isSafeInteger(Number(c))) ? schema.parse({ type: 'int', nullable: hasBlank(column) }) : null,
    examples: { def: { type: 'int', min: 1, max: 3 }, valid: [1, 3], invalid: [0, 1.5, '2'] },
  })),
  kind('number', { min: z.number().optional(), max: z.number().optional(), default: z.number().optional() }, (schema) => ({
    doc: 'Real number for measurements and ratings. Never money.',
    validate: checkNumber,
    compare: (a, b) => nullOrder(a, b) ?? cmpNum(Number(a), Number(b)),
    parseQuery: (raw, def) => (NUMBER_RE.test(raw) ? checkNumber(Number(raw), def) : bad('a number')),
    inferFromCsv: (column) =>
      allCells(column, (c) => NUMBER_RE.test(c) && Number.isFinite(Number(c))) ? schema.parse({ type: 'number', nullable: hasBlank(column) }) : null,
    examples: { def: { type: 'number' }, valid: [4.5], invalid: ['4.5'] },
  })),
  kind('money', { currency: z.string().regex(/^[A-Z]{3}$/).describe('ISO 4217, fixed for the field'),
    min: z.number().int().optional(), default: z.number().int().optional() }, () => ({
    doc: 'Amount in integer minor units (1250 is 12.50 in USD). The currency is fixed on the field.',
    validate: checkMoney,
    compare: (a, b) => nullOrder(a, b) ?? cmpNum(Number(a), Number(b)),
    parseQuery: (raw, def) => (INT_RE.test(raw) ? checkMoney(Number(raw), def) : bad('an integer amount in minor units')),
    // A column cannot tell us the currency, so money is never inferred.
    inferFromCsv: () => null,
    examples: { def: { type: 'money', currency: 'USD', min: 0 }, valid: [0, 1250], invalid: [12.5, -1, '1250'] },
  })),
  kind('bool', { default: z.boolean().optional() }, (schema) => ({
    doc: 'true or false.',
    validate: (value) => (typeof value === 'boolean' ? ok(value) : bad('true or false')),
    compare: (a, b) => nullOrder(a, b) ?? cmpNum(a === true ? 1 : 0, b === true ? 1 : 0),
    parseQuery: (raw) => (raw === 'true' ? ok(true) : raw === 'false' ? ok(false) : bad('true or false')),
    inferFromCsv: (column) => (allCells(column, (c) => c === 'true' || c === 'false') ? schema.parse({ type: 'bool', nullable: hasBlank(column) }) : null),
    examples: { def: { type: 'bool' }, valid: [true, false], invalid: ['true', 0] },
  })),
  kind('datetime', { default: z.literal('now').optional() }, (schema) => ({
    temporal: true,
    doc: 'ISO 8601 UTC timestamp. default: now uses engine time, never the wall clock.',
    validate: checkDatetime,
    validateDefault: (value) => (value === 'now' ? ok(value) : checkDatetime(value)),
    initialValue: (def, nowIso) => (def.default === 'now' ? nowIso : undefined),
    compare: (a, b) => nullOrder(a, b) ?? cmpStr(normalizeInstant(String(a)) ?? String(a), normalizeInstant(String(b)) ?? String(b)),
    parseQuery: checkDatetimeQuery,
    inferFromCsv: (column) => (allCells(column, (c) => normalizeInstant(c) !== null) ? schema.parse({ type: 'datetime', nullable: hasBlank(column) }) : null),
    examples: { def: { type: 'datetime' }, valid: ['2026-03-02T09:00:00.000Z', '2026-01-01T00:00:00Z'],
      invalid: ['yesterday', 1700000000, '2026-03-02T09:00:00+02:00', '2026-02-30T00:00:00Z'] },
  })),
  kind('unix_time', { default: z.union([z.literal('now'), z.number().int().min(0)]).optional() }, () => ({
    temporal: true,
    doc: 'Unix time in whole seconds, as Stripe-style created fields. default: now is the engine clock in seconds, never the wall clock.',
    validate: (value) => checkInt(value, 0, undefined),
    validateDefault: (value) => (value === 'now' ? ok(value) : checkInt(value, 0, undefined)),
    initialValue: (def, nowIso) => (def.default === 'now' ? Math.floor(fromIso(nowIso) / 1000) : undefined),
    compare: (a, b) => nullOrder(a, b) ?? cmpNum(Number(a), Number(b)),
    parseQuery: (raw) => (INT_RE.test(raw) ? checkInt(Number(raw), 0, undefined) : bad('a whole number of seconds')),
    // Epoch seconds look like any large int, so a column is never inferred as unix_time.
    inferFromCsv: () => null,
    examples: { def: { type: 'unix_time' }, valid: [0, 1700000000], invalid: [-1, 1.5, '1700000000', '2026-03-02T09:00:00.000Z'] },
  })),
  kind('enum', { values: z.array(z.string()).min(1), default: z.string().optional() }, (schema) => ({
    doc: 'One of a fixed list of values.',
    choices: (def) => def.values,
    validate: (value, def) => checkOneOf(value, def.values),
    compare: (a, b, def) => nullOrder(a, b) ?? cmpNum(def.values.indexOf(String(a)), def.values.indexOf(String(b))),
    parseQuery: (raw, def) => checkOneOf(raw, def.values),
    inferFromCsv: (column) => {
      const cells = filled(column);
      const distinct = [...new Set(cells)];
      if (column.length < ENUM_MIN_ROWS || cells.length === 0 || distinct.length > ENUM_MAX_DISTINCT) return null;
      return schema.parse({ type: 'enum', values: distinct, nullable: hasBlank(column) });
    },
    examples: { def: { type: 'enum', values: ['low', 'high'] }, valid: ['low'], invalid: ['medium'] },
  })),
  kind('ref', { entity: Name, onDelete: z.enum(['restrict', 'cascade', 'nullify']).default('restrict') }, () => ({
    doc: 'Id of a row in another entity. Must resolve on every write.',
    // Resolution against the target entity is the store's job.
    ref: (def) => ({ entity: def.entity, onDelete: def.onDelete }),
    validate: checkRef,
    compare: (a, b) => nullOrder(a, b) ?? cmpStr(String(a), String(b)),
    parseQuery: checkRef,
    // A column of ids cannot name its target entity, so ref is never inferred.
    inferFromCsv: () => null,
    examples: { def: { type: 'ref', entity: 'customer' }, valid: ['cus_0001'], invalid: [42, ''] },
  })),
  kind('state', { states: z.array(Name).min(2), initial: Name,
    transitions: z.record(Name, z.array(Name)).describe('from-state to allowed to-states. The engine enforces it on every write.') }, () => ({
    doc: 'Workflow state. Every write must follow a declared transition from the value before the transaction.',
    // Declared states only. Whether the move is legal is the store's job.
    choices: (def) => def.states,
    machine: (def) => ({ states: def.states, initial: def.initial, transitions: def.transitions }),
    initialValue: (def) => def.initial,
    validate: (value, def) => checkOneOf(value, def.states),
    compare: (a, b, def) => nullOrder(a, b) ?? cmpNum(def.states.indexOf(String(a)), def.states.indexOf(String(b))),
    parseQuery: (raw, def) => checkOneOf(raw, def.states),
    inferFromCsv: () => null,
    examples: { def: { type: 'state', states: ['open', 'closed'], initial: 'open', transitions: { open: ['closed'], closed: [] } },
      valid: ['open'], invalid: ['archived', 3] },
  })),
] as const;

type AnyKind = (typeof KINDS)[number];
export type FieldType = AnyKind['type'];

/** Lookup by type. Keys come from each entry's `type`, so they cannot disagree. */
export const FIELD_TYPES = Object.fromEntries(KINDS.map((k) => [k.type, k])) as {
  readonly [K in FieldType]: Extract<AnyKind, { type: K }>;
};

/** The kind of a parsed field. One cast, because TS cannot correlate `def.type` with its FIELD_TYPES entry. */
export function kindOf(def: Field): FieldKind<Field['type'], Field> {
  return FIELD_TYPES[def.type] as unknown as FieldKind<Field['type'], Field>;
}

/** The target of a `ref` field, or undefined for any other type. */
export const refOf = (def: Field): RefTarget | undefined => kindOf(def).ref?.(def);

/** The closed list of values of an `enum` or `state` field, or undefined for any other type. */
/** Whether the field holds a point in time. */
export const temporalOf = (def: Field): boolean => kindOf(def).temporal === true;
export const choicesOf = (def: Field): readonly string[] | undefined => kindOf(def).choices?.(def);

/** The transitions of a `state` field, or undefined for any other type. */
export const machineOf = (def: Field): Machine | undefined => kindOf(def).machine?.(def);

/** The value a create fills in when the field is absent, or undefined when there is none. */
export function initialOf(def: Field, nowIso: string): Value | undefined {
  const kind = kindOf(def);
  if (kind.initialValue !== undefined) {
    const v = kind.initialValue(def, nowIso);
    if (v !== undefined) return v;
  }
  return 'default' in def ? (def.default as Value | undefined) : undefined;
}

/** Order in which CSV inference tries types. Most specific first. */
export const FIELD_TYPE_ORDER: readonly FieldType[] = ['bool', 'int', 'money', 'number', 'datetime', 'enum', 'string', 'text'];

export const fieldSchema = z.discriminatedUnion('type', KINDS.map((k) => k.schema) as unknown as [
  AnyKind['schema'],
  ...AnyKind['schema'][],
]);
export type Field = z.output<typeof fieldSchema>;
