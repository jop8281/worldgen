/**
 * Whether a world's public API conforms to the OpenAPI spec it was generated from.
 *
 * Invariants:
 * - Pure. Reads `openApiOf(world)` and a parsed spec document, never a file, a model or a clock.
 * - Only operations under `only` are compared, with the same prefix rule worldgen uses to digest
 *   the spec. An empty `only` selects every path.
 * - Path params compare by position, not by name: `/pet/{petId}` is `/pet/{id}`.
 * - A spec 2xx status is met by any 2xx the world answers, because the engine fixes the success
 *   status of each standard op (create is 201). Another status is met by itself or its `4XX` style wildcard.
 * - Field names compare ignoring case and `_` or `-`, because world names are snake_case and a
 *   spec's `photoUrls` can only be `photo_urls`. A different word is a missing field.
 * - Ids and refs (a field named `id` or ending in `id`) are strings in the engine, so a spec integer there
 *   is not a mismatch. Spec arrays and objects are not compared: no field type holds them.
 * - A request enum may be narrower than the spec's (the engine pins a state field's initial value
 *   on create) but may not hold a value the spec lacks. A response enum must match exactly.
 * - A source body is read as JSON or, failing that, as a form; a form body feeds only the required checks.
 * - A request field the world requires and the source leaves optional is an error (`openapi.required_field_extra`),
 *   except a body `id` with no path parameter and a field whose source alternative the world does not model (`exemptExtra`).
 * - A missing operation, status, required field, type or enum is an error. An operation the spec
 *   does not declare is a warning, because a plan may add routes on purpose.
 */
import { issue, type CheckIssue } from './issues.ts';
import type { World } from './format.ts';
import { openApiOf, type JsonSchema, type OpenApiDocument } from './openapi.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_REF_DEPTH = 16;

/** Whether `path` is selected by the `--only` prefixes. The one prefix rule, shared with worldgen's digest. */
export function underPrefix(path: string, only: readonly string[]): boolean {
  if (only.length === 0) return true;
  return only.some((p) => {
    const q = p.replace(/\/+$/, '');
    return q === '' || path === q || path.startsWith(`${q}/`);
  });
}

/** A field as both sides describe it: its JSON type with null removed, and its enum values as text. */
type Prop = { readonly name: string; readonly type: string | null; readonly values: readonly string[] | null };
/** One operation seen from either side. */
type Shape = {
  readonly statuses: readonly string[];
  readonly required: readonly string[];
  readonly request: ReadonlyMap<string, Prop>;
  /** Every field the body declares, in JSON or form encoding. Only the required checks read it, so form bodies stay uncompared for types and enums. */
  readonly declared: ReadonlyMap<string, Prop>;
  readonly response: ReadonlyMap<string, Prop>;
};

/** The key two spellings of one field share: `photoUrls` and `photo_urls`. */
const fieldKey = (name: string): string => name.toLowerCase().replace(/[_-]/g, '');

const shapePath = (p: string): string => p.replace(/\{[^}]*\}/g, '{}');

function typeOf(t: unknown): string | null {
  const all = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string' && x !== 'null');
  return all.length === 1 ? (all[0] ?? null) : null;
}
const propOf = (s: Obj): Omit<Prop, 'name'> => ({
  type: typeOf(s['type']),
  values: Array.isArray(s['enum']) ? s['enum'].filter((v) => v !== null).map(String) : null,
});

/** Follows `#/...` refs inside one document. Anything unresolvable is an empty schema. */
function resolver(doc: unknown): (node: unknown) => Obj {
  const follow = (node: unknown, depth: number): Obj => {
    if (!isObj(node)) return {};
    const ref = node['$ref'];
    if (typeof ref !== 'string') return node;
    if (depth >= MAX_REF_DEPTH || !ref.startsWith('#/')) return {};
    let cur: unknown = doc;
    for (const seg of ref.slice(2).split('/')) {
      cur = isObj(cur) ? cur[seg.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    return follow(cur, depth + 1);
  };
  return (node) => follow(node, 0);
}

/** An object schema's properties and required names, with allOf parts merged in. */
function objectOf(schema: Obj, deref: (n: unknown) => Obj, depth = 0): { props: Map<string, Prop>; required: string[] } {
  const props = new Map<string, Prop>();
  const required: string[] = [];
  const parts = depth < MAX_REF_DEPTH && Array.isArray(schema['allOf']) ? schema['allOf'] : [];
  for (const part of parts) {
    const sub = objectOf(deref(part), deref, depth + 1);
    for (const [k, v] of sub.props) props.set(fieldKey(k), v);
    required.push(...sub.required);
  }
  if (isObj(schema['properties'])) for (const [k, v] of Object.entries(schema['properties'])) props.set(fieldKey(k), { ...propOf(deref(v)), name: k });
  if (Array.isArray(schema['required'])) required.push(...schema['required'].filter((r): r is string => typeof r === 'string'));
  return { props, required };
}

const jsonSchemaOf = (content: unknown): unknown => (isObj(content) && isObj(content['application/json']) ? content['application/json']['schema'] : undefined);
/** A source request body is JSON or, as in Stripe's spec, a form. The world takes JSON either way, so both name the same fields. */
const sourceBodyOf = (content: unknown): unknown => jsonSchemaOf(content) ?? (isObj(content) && isObj(content['application/x-www-form-urlencoded']) ? content['application/x-www-form-urlencoded']['schema'] : undefined);
const SUCCESS = /^2/;

function specShapes(spec: unknown, only: readonly string[]): Map<string, { method: string; path: string; shape: Shape }> {
  const out = new Map<string, { method: string; path: string; shape: Shape }>();
  const deref = resolver(spec);
  const paths = isObj(spec) && isObj(spec['paths']) ? spec['paths'] : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!underPrefix(path, only) || !isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const body = isObj(op['requestBody']) ? deref(op['requestBody']) : {};
      const request = objectOf(deref(jsonSchemaOf(deref(body)['content'])), deref);
      const declared = objectOf(deref(sourceBodyOf(deref(body)['content'])), deref);
      const responses = isObj(op['responses']) ? op['responses'] : {};
      const statuses = Object.keys(responses).filter((s) => s !== 'default');
      const ok = statuses.find((s) => SUCCESS.test(s));
      const response = ok === undefined ? null : objectOf(deref(jsonSchemaOf(deref(responses[ok])['content'])), deref);
      out.set(`${method} ${shapePath(path)}`, {
        method: method.toUpperCase(),
        path,
        shape: { statuses, required: declared.required, request: request.props, declared: declared.props, response: response?.props ?? new Map() },
      });
    }
  }
  return out;
}

function worldShapes(world: World): Map<string, { method: string; path: string; shape: Shape }> {
  const doc: OpenApiDocument = openApiOf(world);
  const deref = (node: unknown): Obj => {
    if (!isObj(node)) return {};
    const ref = node['$ref'];
    if (typeof ref !== 'string') return node;
    const hit = doc.components.schemas[ref.replace('#/components/schemas/', '')] as JsonSchema | undefined;
    return hit === undefined ? {} : (hit as Obj);
  };
  const out = new Map<string, { method: string; path: string; shape: Shape }>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      const request = objectOf(deref(jsonSchemaOf(op.requestBody?.content)), deref);
      const statuses = Object.keys(op.responses);
      const ok = statuses.find((s) => SUCCESS.test(s) && op.responses[s]?.content !== undefined);
      const response = ok === undefined ? null : objectOf(deref(jsonSchemaOf(op.responses[ok]?.content)), deref);
      out.set(`${method} ${shapePath(path)}`, {
        method: method.toUpperCase(),
        path,
        shape: { statuses, required: request.required, request: request.props, declared: request.props, response: response?.props ?? new Map() },
      });
    }
  }
  return out;
}

/**
 * Differences the engine cannot express, so the world is right to have them: ids and refs are
 * strings (`id`, `petId`), and no field type holds an array or object (the world flattens them).
 */
const engineShapes = (key: string, want: string, have: string): boolean =>
  want === 'array' || want === 'object' || (have === 'string' && (want === 'integer' || want === 'number') && key.endsWith('id'));

/**
 * A world field the source leaves optional but the world may still require. A body `id` on an
 * operation with no path parameter is how the world finds the row to update. A field is also
 * exempt when the source offers an optional plain string the world has no field for (Stripe's
 * `charge` or `payment_intent`): requiring the one the world models is not a departure the client can fix.
 */
const exemptExtra = (key: string, path: string, alternative: boolean): boolean => (key === 'id' && !path.includes('{')) || alternative;

const hasStatus = (world: readonly string[], status: string): boolean =>
  SUCCESS.test(status) ? world.some((w) => SUCCESS.test(w)) : world.includes(status) || world.includes(`${status[0] ?? ''}XX`);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v) => b.includes(v));
const within = (a: readonly string[], b: readonly string[]): boolean => a.every((v) => b.includes(v));

function compareProps(
  at: readonly (string | number)[],
  op: string,
  where: 'request' | 'response',
  spec: ReadonlyMap<string, Prop>,
  world: ReadonlyMap<string, Prop>,
  out: CheckIssue[],
): void {
  for (const [key, want] of spec) {
    const have = world.get(key);
    if (have === undefined) continue;
    const name = want.name;
    const path = ['input', 'openapi', ...at, where, name] as const;
    if (want.type !== null && have.type !== null && want.type !== have.type && !engineShapes(key, want.type, have.type)) {
      out.push(issue('openapi.field_type', path, { op, where, field: name, type: want.type }, `${have.type}`));
    }
    const wanted = want.values;
    const enumOk = wanted === null || (have.values !== null && (where === 'request' ? within(have.values, wanted) : sameSet(wanted, have.values)));
    if (wanted !== null && !enumOk) {
      out.push(issue('openapi.field_enum', path, { op, where, field: name, values: wanted }, have.values === null ? 'no enum' : have.values.join(', ')));
    }
  }
}

/**
 * Every way `world`'s public API departs from the `spec` operations under `only`. Order follows
 * the spec's paths, then the world's extra operations.
 */
export function openapiFidelity(world: World, spec: unknown, only: readonly string[] = []): readonly CheckIssue[] {
  const want = specShapes(spec, only);
  const have = worldShapes(world);
  const out: CheckIssue[] = [];
  for (const [key, w] of want) {
    const h = have.get(key);
    const op = `${w.method} ${w.path}`;
    const at = [op] as const;
    if (h === undefined) {
      out.push(issue('openapi.operation_missing', ['input', 'openapi', ...at], { method: w.method, path: w.path }, `${[...have.values()].length} operations, none matching`));
      continue;
    }
    for (const status of w.shape.statuses) {
      if (!hasStatus(h.shape.statuses, status)) {
        out.push(issue('openapi.status_missing', ['input', 'openapi', ...at, 'responses', status], { op, status }, h.shape.statuses.join(', ')));
      }
    }
    const worldRequired = new Set(h.shape.required.map(fieldKey));
    for (const field of w.shape.required) {
      const sourceKey = fieldKey(field);
      const worldKey = !h.shape.request.has(sourceKey) && w.shape.request.get(sourceKey)?.type === 'object' && h.shape.request.has(`${sourceKey}id`) ? `${sourceKey}id` : sourceKey;
      if (!h.shape.request.has(worldKey) || !worldRequired.has(worldKey)) {
        out.push(issue('openapi.required_field_missing', ['input', 'openapi', ...at, 'request', field], { op, field },
          h.shape.request.size === 0 ? 'no request body' : `fields ${[...h.shape.request.values()].map((p) => p.name).join(', ')}`));
      }
    }
    const sourceRequired = new Set(w.shape.required.map(fieldKey));
    const alternative = [...w.shape.declared].some(([k, p]) => k !== 'id' && !sourceRequired.has(k) && !h.shape.request.has(k) && !h.shape.request.has(`${k}id`) && p.type === 'string' && p.values === null);
    for (const field of h.shape.required) {
      const key = fieldKey(field);
      const sourceKey = !w.shape.request.has(key) && key.endsWith('id') && w.shape.request.get(key.slice(0, -2))?.type === 'object' ? key.slice(0, -2) : key;
      if (sourceRequired.has(sourceKey) || exemptExtra(key, w.path, alternative)) continue;
      out.push(issue('openapi.required_field_extra', ['input', 'openapi', ...at, 'request', field], { op, field }, 'required by the world input'));
    }
    compareProps(at, op, 'request', w.shape.request, h.shape.request, out);
    compareProps(at, op, 'response', w.shape.response, h.shape.response, out);
  }
  for (const [key, h] of have) {
    if (want.has(key) || !underPrefix(h.path, only)) continue;
    out.push(issue('openapi.operation_extra', ['input', 'openapi', `${h.method} ${h.path}`], { method: h.method, path: h.path }, 'not in the spec'));
  }
  return out;
}
