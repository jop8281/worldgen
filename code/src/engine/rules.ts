/**
 * Declarative workflow rules (YOS-126 prototype, A-167): an opt-in `rules` list on an action or a job
 * that the engine lowers to the JavaScript the action's `handler` or the job's `run` must then be.
 *
 * Invariants:
 * - Lowering is pure and deterministic, so the same rules always give the same source.
 * - A rule reaches only ctx members a handler already has: db get, list, update and create, fail,
 *   now and time. The engine still enforces types, refs, transitions and rollback on every write.
 * - The input is bounded JSON (`boundedJson`) before the recursive schema reads it, so a cyclic or
 *   huge YAML alias graph is refused instead of overflowing the stack.
 */
import { z } from 'zod';
import { choicesOf, kindOf, machineOf } from './fields.ts';
import type { World } from './format.ts';

type Scalar = string | number | boolean | null;
export type Expression =
  | { op: 'literal'; value: Scalar }
  | { op: 'ref'; name: string; field?: string | undefined }
  | { op: 'now' }
  | { op: 'eq' | 'ne' | 'lt' | 'gte' | 'minutesBetween' | 'plus'; left: Expression; right: Expression }
  | { op: 'in'; value: Expression; values: Scalar[] }
  | { op: 'and' | 'or' | 'concat'; values: Expression[] };
export type Step =
  | { op: 'get'; entity: string; id: Expression; as: string }
  | { op: 'find'; entity: string; as: string; where: Record<string, Expression>; when?: Expression | undefined }
  | { op: 'each'; entity: string; as: string; where: Record<string, Expression>; steps: Step[] }
  | { op: 'let'; as: string; value: Expression }
  | { op: 'set'; name: string; value: Expression }
  | { op: 'if'; when: Expression; then: Step[]; otherwise?: Step[] | undefined }
  | { op: 'guard'; when: Expression; status: 400 | 404 | 409 | 422; code: string; message: Expression }
  | { op: 'update'; entity: string; id: Expression; set: Record<string, Expression> }
  | { op: 'create'; entity: string; set: Record<string, Expression> }
  | { op: 'return'; status: number; body: Expression };

const MAX_VALUES = 8192;
const MAX_DEPTH = 32;
const MAX_STRING = 4096;
const MAX_STEPS = 64;

const name = z.string().max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
  .refine((s) => !['constructor', 'prototype', '__proto__'].includes(s), 'reserved name');
const scalar = z.union([z.string().max(MAX_STRING), z.number().finite(), z.boolean(), z.null()]);
const expression: z.ZodType<Expression> = z.lazy(() => z.union([
  z.strictObject({ op: z.literal('literal'), value: scalar }),
  z.strictObject({ op: z.literal('ref'), name, field: name.optional() }),
  z.strictObject({ op: z.literal('now') }),
  z.strictObject({ op: z.enum(['eq', 'ne', 'lt', 'gte', 'minutesBetween', 'plus']), left: expression, right: expression }),
  z.strictObject({ op: z.literal('in'), value: expression, values: z.array(scalar).max(MAX_STEPS) }),
  z.strictObject({ op: z.enum(['and', 'or', 'concat']), values: z.array(expression).min(1).max(MAX_STEPS) }),
]));
const fields = z.record(name, expression);
const step: z.ZodType<Step> = z.lazy(() => z.union([
  z.strictObject({ op: z.literal('get'), entity: name, id: expression, as: name }),
  z.strictObject({ op: z.literal('find'), entity: name, as: name, where: fields, when: expression.optional() }),
  z.strictObject({ op: z.literal('each'), entity: name, as: name, where: fields, steps: z.array(step).max(MAX_STEPS) }),
  z.strictObject({ op: z.literal('let'), as: name, value: expression }),
  z.strictObject({ op: z.literal('set'), name, value: expression }),
  z.strictObject({ op: z.literal('if'), when: expression, then: z.array(step).max(MAX_STEPS), otherwise: z.array(step).max(MAX_STEPS).optional() }),
  z.strictObject({ op: z.literal('guard'), when: expression, status: z.union([z.literal(400), z.literal(404), z.literal(409), z.literal(422)]), code: name, message: expression }),
  z.strictObject({ op: z.literal('update'), entity: name, id: expression, set: fields }),
  z.strictObject({ op: z.literal('create'), entity: name, set: fields }),
  z.strictObject({ op: z.literal('return'), status: z.number().int().min(200).max(299), body: expression }),
]));

/** Why `input` is not bounded, acyclic plain JSON, or null when it is. Never throws on plain data. */
function boundedJson(input: unknown): string | null {
  const pending = [{ value: input, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (++nodes > MAX_VALUES || item.depth > MAX_DEPTH) return `rules exceed ${MAX_VALUES} values or depth ${MAX_DEPTH}`;
    const { value, depth } = item;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      if (value.length > MAX_STRING) return `a rules string is longer than ${MAX_STRING} characters`;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'rules numbers must be finite';
      continue;
    }
    if (typeof value !== 'object') return 'rules must be JSON data';
    if (seen.has(value)) return 'rules must be a tree: a YAML alias makes a cycle or a shared node';
    seen.add(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return 'rules must hold only plain objects and arrays';
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return null;
}

/** The `rules` field of an action or a job: bounded JSON first, then the step schema. */
export const rulesField = z.unknown()
  .superRefine((v, ctx) => {
    const problem = boundedJson(v);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  })
  .pipe(z.array(step).min(1).max(MAX_STEPS))
  .describe('optional declarative steps (get, find, each, let, set, if, guard, update, create, return) the engine lowers to JavaScript; when present, the handler or run must equal the lowered source, which rules.handler_mismatch prints');

export type Lowered = { readonly ok: true; readonly source: string } | { readonly ok: false; readonly problem: string };

type Binding = { readonly entity: string | null; readonly mutable: boolean };
type Scope = Map<string, Binding>;
const quote = (value: unknown): string => JSON.stringify(value);
const local = (key: string): string => `_v_${key}`;

class RuleError extends Error {}
function fail(problem: string): never {
  throw new RuleError(problem);
}

/**
 * The JavaScript `steps` lower to: an action handler when `actionId` names one, else a job run.
 * Entity, field, input, path-param and binding names are checked against `world`, and a literal
 * written to a state or enum field must be one of its values.
 */
export function lowerRules(world: World, steps: readonly Step[], actionId: string | null): Lowered {
  const action = actionId === null ? undefined : world.actions[actionId];
  if (actionId !== null && action === undefined) return { ok: false, problem: `unknown action ${actionId}` };
  const entity = (key: string) => (Object.hasOwn(world.entities, key) ? world.entities[key]! : fail(`unknown entity ${key}`));
  const field = (key: string, fieldName: string, write: boolean): void => {
    const def = entity(key);
    if (!write && ['id', 'created_at', 'updated_at'].includes(fieldName)) return;
    if (!Object.hasOwn(def.fields, fieldName)) fail(`unknown ${write ? 'write ' : ''}field ${key}.${fieldName}`);
  };
  const bind = (scope: Scope, key: string, rowEntity: string | null, mutable = false): void => {
    if (key === 'params' || key === 'body' || scope.has(key)) fail(`duplicate or reserved binding ${key}`);
    scope.set(key, { entity: rowEntity, mutable });
  };
  const expr = (value: Expression, scope: Scope): string => {
    switch (value.op) {
      case 'literal': return quote(value.value);
      case 'now': return 'ctx.now()';
      case 'ref': {
        if (value.name === 'params' || value.name === 'body') {
          if (action === undefined || value.field === undefined) fail('only a named action input or path parameter can be read');
          if (value.name === 'body' && !Object.hasOwn(action.input, value.field)) fail(`unknown action input ${value.field}`);
          if (value.name === 'params' && !action.path.split('/').includes(`{${value.field}}`)) fail(`unknown action path parameter ${value.field}`);
          return `ctx.${value.name}[${quote(value.field)}]`;
        }
        const binding = scope.get(value.name) ?? fail(`unknown binding ${value.name}`);
        if (value.field === undefined) return local(value.name);
        if (binding.entity === null) fail(`binding ${value.name} has no fields`);
        field(binding.entity, value.field, false);
        return `${local(value.name)}[${quote(value.field)}]`;
      }
      case 'eq': return `(${expr(value.left, scope)} === ${expr(value.right, scope)})`;
      case 'ne': return `(${expr(value.left, scope)} !== ${expr(value.right, scope)})`;
      case 'lt': return `(${expr(value.left, scope)} < ${expr(value.right, scope)})`;
      case 'gte': return `(${expr(value.left, scope)} >= ${expr(value.right, scope)})`;
      case 'minutesBetween': return `ctx.time.minutesBetween(${expr(value.left, scope)}, ${expr(value.right, scope)})`;
      case 'plus': return `ctx.time.plus(${expr(value.left, scope)}, ${expr(value.right, scope)})`;
      case 'in': return `${quote(value.values)}.includes(${expr(value.value, scope)})`;
      case 'and': return `(${value.values.map((v) => expr(v, scope)).join(' && ')})`;
      case 'or': return `(${value.values.map((v) => expr(v, scope)).join(' || ')})`;
      case 'concat': return `("" + ${value.values.map((v) => expr(v, scope)).join(' + ')})`;
    }
  };
  const record = (values: Record<string, Expression>, key: string, scope: Scope, write: boolean): string => {
    const def = entity(key);
    return `{${Object.entries(values).map(([k, v]) => {
      field(key, k, write);
      const f = def.fields[k];
      // A literal for a field with a closed list of values must be one of them, checked by the field's own kind.
      if (v.op === 'literal' && f !== undefined && choicesOf(f) !== undefined && !kindOf(f).validate(v.value, f).ok) {
        fail(`unknown ${machineOf(f) === undefined ? 'enum value' : 'state'} ${key}.${k}: ${quote(v.value)}`);
      }
      return `[${quote(k)}]:${expr(v, scope)}`;
    }).join(',')}}`;
  };
  const block = (list: readonly Step[], scope: Scope): string => list.map((s): string => {
    switch (s.op) {
      case 'get': {
        entity(s.entity);
        const id = expr(s.id, scope);
        bind(scope, s.as, s.entity);
        return `const ${local(s.as)} = ctx.db.get(${quote(s.entity)},${id});`;
      }
      case 'find': {
        const where = record(s.where, s.entity, scope, false);
        const inner = new Map(scope);
        bind(inner, s.as, s.entity);
        const predicate = s.when === undefined ? 'true' : expr(s.when, inner);
        bind(scope, s.as, s.entity);
        return `const ${local(s.as)} = ctx.db.list(${quote(s.entity)},{where:${where}}).find((${local(s.as)})=>${predicate}) ?? null;`;
      }
      case 'each': {
        const where = record(s.where, s.entity, scope, false);
        const inner = new Map(scope);
        bind(inner, s.as, s.entity);
        return `for (const ${local(s.as)} of ctx.db.list(${quote(s.entity)},{where:${where}})) {${block(s.steps, inner)}}`;
      }
      case 'let': {
        const value = expr(s.value, scope);
        bind(scope, s.as, null, true);
        return `let ${local(s.as)} = ${value};`;
      }
      case 'set':
        if (!scope.get(s.name)?.mutable) fail(`binding ${s.name} is not a let`);
        return `${local(s.name)} = ${expr(s.value, scope)};`;
      case 'if': return `if (${expr(s.when, scope)}) {${block(s.then, new Map(scope))}} else {${block(s.otherwise ?? [], new Map(scope))}}`;
      case 'guard':
        if (action === undefined) fail('a job rule cannot use guard: only a handler answers a request');
        return `if (!(${expr(s.when, scope)})) ctx.fail(${s.status},${quote(s.code)},${expr(s.message, scope)});`;
      case 'update': return `ctx.db.update(${quote(s.entity)},${expr(s.id, scope)},${record(s.set, s.entity, scope, true)});`;
      case 'create': return `ctx.db.create(${quote(s.entity)},${record(s.set, s.entity, scope, true)});`;
      case 'return':
        if (action === undefined) fail('a job rule cannot return a response');
        return `return {status:${s.status},body:${expr(s.body, scope)}};`;
    }
  }).join('\n');
  try {
    return { ok: true, source: `(ctx) => {\n${block(steps, new Map())}\n}` };
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, problem: e.message };
    throw e;
  }
}
