/**
 * The OpenAPI 3.1 document for a world's public API: what the agent under test may call.
 *
 * Invariants:
 * - Pure. Built only from meta, entities, routes and actions. Graders, solutions, decoys, tests,
 *   seed, fixtures, jobs and the admin /_world routes never reach the document.
 * - It describes the engine as it behaves: the query params a list accepts (api.ts), which path
 *   param selects a row, which fields create and update take (store.ts), the envelopes from
 *   meta.api, and the error codes each operation can answer.
 * - Field schemas come from FIELD_JSON, keyed by FieldType, so a new field type does not compile
 *   until it has a JSON Schema here. Nothing switches on `def.type`.
 */
import { RUNTIME_ERROR_CODES } from './error-codes.ts';
import { machineOf, refOf, type Field, type FieldType } from './fields.ts';
import { STRIPE_MAX_LIMIT, type Action, type Entity, type Route, type World } from './format.ts';

type Scalar = string | number | boolean | null;
type JsonType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

/** The JSON Schema 2020-12 subset this document uses. */
export type JsonSchema = {
  $ref?: string;
  type?: JsonType | JsonType[];
  description?: string;
  enum?: Scalar[];
  const?: Scalar;
  default?: Scalar;
  examples?: Scalar[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  readOnly?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema | false;
  prefixItems?: JsonSchema[];
  'x-currency'?: string;
  'x-transitions'?: Record<string, readonly string[]>;
};

export type OpenApiParameter = { name: string; in: 'path' | 'query'; required: boolean; description: string; schema: JsonSchema };
type JsonContent = { 'application/json': { schema: JsonSchema } };
export type OpenApiResponse = { description: string; content?: JsonContent };
export type OpenApiOperation = {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters: OpenApiParameter[];
  requestBody?: { required: boolean; content: JsonContent };
  responses: Record<string, OpenApiResponse>;
};
type MethodKey = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type OpenApiPathItem = Partial<Record<MethodKey, OpenApiOperation>>;
export type OpenApiDocument = {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  tags: { name: string; description: string }[];
  paths: Record<string, OpenApiPathItem>;
  components: { schemas: Record<string, JsonSchema> };
  'x-error-codes': Record<string, { status: number; meaning: string }>;
};

/**
 * Every error code a routed call on the world port can answer with: the public subset of
 * RUNTIME_ERROR_CODES, one row per code holding the catalog member itself, so status and
 * meaning cannot drift from the responses. The runtime-only codes (idempotency_error,
 * engine.internal, body.too_large, engine.error) and the admin codes (clock.invalid,
 * task.unknown, grade.failed) stay out of the world's document. Action handlers may add their
 * own codes through ctx.fail. tx.aborted is absent: an action turns it into action.failed.
 */
export const ENGINE_ERROR_CODES = {
  'path.invalid': RUNTIME_ERROR_CODES['path.invalid'],
  'query.invalid': RUNTIME_ERROR_CODES['query.invalid'],
  'query.unknown': RUNTIME_ERROR_CODES['query.unknown'],
  'cursor.invalid': RUNTIME_ERROR_CODES['cursor.invalid'],
  'body.invalid': RUNTIME_ERROR_CODES['body.invalid'],
  'input.invalid': RUNTIME_ERROR_CODES['input.invalid'],
  'route.not_found': RUNTIME_ERROR_CODES['route.not_found'],
  'row.not_found': RUNTIME_ERROR_CODES['row.not_found'],
  'entity.unknown': RUNTIME_ERROR_CODES['entity.unknown'],
  'method.not_allowed': RUNTIME_ERROR_CODES['method.not_allowed'],
  'field.unique': RUNTIME_ERROR_CODES['field.unique'],
  'delete.restricted': RUNTIME_ERROR_CODES['delete.restricted'],
  'field.unknown': RUNTIME_ERROR_CODES['field.unknown'],
  'field.readonly': RUNTIME_ERROR_CODES['field.readonly'],
  'field.required': RUNTIME_ERROR_CODES['field.required'],
  'field.null': RUNTIME_ERROR_CODES['field.null'],
  'field.type': RUNTIME_ERROR_CODES['field.type'],
  'ref.unresolved': RUNTIME_ERROR_CODES['ref.unresolved'],
  'state.initial': RUNTIME_ERROR_CODES['state.initial'],
  'state.transition': RUNTIME_ERROR_CODES['state.transition'],
  'action.failed': RUNTIME_ERROR_CODES['action.failed'],
} as const satisfies Record<string, { status: number; meaning: string }>;
export type EngineErrorCode = keyof typeof ENGINE_ERROR_CODES;
type ErrorStatus = (typeof ENGINE_ERROR_CODES)[EngineErrorCode]['status'];

const STATUS_TEXT: { readonly [S in ErrorStatus]: string } = {
  400: 'Bad request',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  422: 'Unprocessable write',
  500: 'Action failed',
};
/** The statuses an action handler may pass to ctx.fail. Any other makes the call action.failed. */
const HANDLER_STATUSES: readonly ErrorStatus[] = [400, 404, 409, 422];

// ---- field types to JSON Schema

type FieldOf<K extends FieldType> = Extract<Field, { type: K }>;
type FieldJsonTable = { readonly [K in FieldType]: (def: FieldOf<K>) => JsonSchema };

const range = (d: { min?: number | undefined; max?: number | undefined }): JsonSchema => ({
  ...(d.min === undefined ? {} : { minimum: d.min }),
  ...(d.max === undefined ? {} : { maximum: d.max }),
});

/** `format` keyword for the string formats JSON Schema names. Phone has none, so it is described. */
const STRING_FORMAT: { readonly [F in NonNullable<FieldOf<'string'>['format']>]: JsonSchema } = {
  email: { format: 'email' },
  url: { format: 'uri' },
  phone: { description: 'A phone number such as +14155550123.' },
};

function movesText(transitions: Readonly<Record<string, readonly string[]>>, states: readonly string[]): string {
  const moves = states.map((s) => {
    const to = transitions[s] ?? [];
    return to.length > 0 ? `${s} -> ${to.join(', ')}` : `${s} is final`;
  });
  return `Workflow state. Allowed moves: ${moves.join('; ')}.`;
}

/** A field's value schema, without null, default or readOnly. One entry per field type. */
const FIELD_JSON: FieldJsonTable = {
  string: (d) => ({
    type: 'string',
    ...(d.maxLength === undefined ? {} : { maxLength: d.maxLength }),
    ...(d.pattern === undefined ? {} : { pattern: d.pattern }),
    ...(d.format === undefined ? {} : STRING_FORMAT[d.format]),
  }),
  text: () => ({ type: 'string' }),
  int: (d) => ({ type: 'integer', ...range(d) }),
  number: (d) => ({ type: 'number', ...range(d) }),
  money: (d) => ({
    type: 'integer',
    ...(d.min === undefined ? {} : { minimum: d.min }),
    description: `Integer amount in minor units of ${d.currency}.`,
    'x-currency': d.currency,
  }),
  bool: () => ({ type: 'boolean' }),
  datetime: () => ({ type: 'string', format: 'date-time' }),
  unix_time: () => ({ type: 'integer', minimum: 0, description: 'Unix time in whole seconds.' }),
  enum: (d) => ({ type: 'string', enum: [...d.values] }),
  ref: (d) => ({ type: 'string', description: `Id of the ${d.entity} it references.` }),
  state: (d) => ({ type: 'string', enum: [...d.states], description: movesText(d.transitions, d.states), 'x-transitions': d.transitions }),
};

function valueSchemaOf<K extends FieldType>(type: K, def: FieldOf<K>): JsonSchema {
  const build: (def: FieldOf<K>) => JsonSchema = FIELD_JSON[type];
  return build(def);
}

/** The default a write fills in when the field is absent, as the store applies it. `now` is engine time. */
function defaultOf(def: Field): Scalar | 'now' | undefined {
  const machine = machineOf(def);
  if (machine) return machine.initial;
  return 'default' in def ? def.default : undefined;
}

const joinText = (...parts: (string | undefined)[]): string | undefined => {
  const kept = parts.filter((p): p is string => p !== undefined && p !== '');
  return kept.length > 0 ? kept.join(' ') : undefined;
};

/** Where a field schema is used. Each use decides null, default and readOnly. */
export type FieldUse = 'row' | 'create' | 'update' | 'input' | 'query';

function withNull(s: JsonSchema): JsonSchema {
  const t = s.type;
  return {
    ...s,
    ...(t === undefined ? {} : { type: [...(Array.isArray(t) ? t : [t]), 'null'] }),
    ...(s.enum === undefined ? {} : { enum: [...s.enum, null] }),
  };
}

/** The JSON Schema of one field definition for one use. Exported so tests can pin every field type. */
export function fieldJsonSchema(def: Field, use: FieldUse = 'row'): JsonSchema {
  const base = valueSchemaOf(def.type, def);
  const dflt = defaultOf(def);
  const writesDefault = use === 'create' || use === 'input';
  let s: JsonSchema = { ...base };
  // A create through the API may only start a state field at its initial state.
  const machine = machineOf(def);
  if (use === 'create' && machine) s = { ...s, enum: [machine.initial] };
  const description = joinText(def.description, s.description,
    writesDefault && dflt === 'now' ? 'Defaults to the engine time of the write.' : undefined);
  if (description === undefined) delete s.description;
  else s.description = description;
  if (writesDefault && dflt !== undefined && dflt !== 'now') s.default = dflt;
  if (use !== 'query' && def.nullable && !def.required) s = withNull(s);
  if (use === 'row' && def.readonly) s.readOnly = true;
  return s;
}

/** Absent on create means 422 field.required. */
const mustSend = (def: Field): boolean => def.required && defaultOf(def) === undefined;
/** Every stored row holds the field: required, defaulted, or stored as null when absent. */
const alwaysPresent = (def: Field): boolean => def.required || def.nullable || defaultOf(def) !== undefined;

// ---- components

const ENGINE_TIME: JsonSchema = { type: 'string', format: 'date-time', readOnly: true };
const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

function rowSchema(e: Entity): JsonSchema {
  const fields = Object.entries(e.fields);
  return {
    type: 'object',
    description: e.description,
    properties: {
      id: { type: 'string', pattern: `^${e.idPrefix}_[0-9]+$`, readOnly: true, description: 'Assigned by the engine.' },
      ...Object.fromEntries(fields.map(([n, d]) => [n, fieldJsonSchema(d, 'row')])),
      created_at: { ...ENGINE_TIME, description: 'Engine time of the create.' },
      updated_at: { ...ENGINE_TIME, description: 'Engine time of the last write.' },
    },
    required: ['id', ...fields.filter(([, d]) => alwaysPresent(d)).map(([n]) => n), 'created_at', 'updated_at'],
    additionalProperties: false,
  };
}

/** A request body of fields. Unknown keys are refused, so additionalProperties is false. */
function bodySchema(fields: readonly [string, Field][], use: 'create' | 'update' | 'input', description: string): JsonSchema {
  const required = use === 'update' ? [] : fields.filter(([, d]) => mustSend(d)).map(([n]) => n);
  return {
    type: 'object',
    description,
    properties: Object.fromEntries(fields.map(([n, d]) => [n, fieldJsonSchema(d, use)])),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const writable = (e: Entity): [string, Field][] => Object.entries(e.fields).filter(([, d]) => !d.readonly);

function listSchema(world: World, entity: string): JsonSchema {
  const shape = world.meta.api.list;
  if (shape.mode === 'stripe') {
    return {
      type: 'object',
      description: `One page of ${entity} rows, newest first. ${shape.hasMoreKey} says whether another page exists in this direction.`,
      properties: { [shape.dataKey]: { type: 'array', items: ref(entity) }, [shape.hasMoreKey]: { type: 'boolean' } },
      required: [shape.dataKey, shape.hasMoreKey],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    description: `One page of ${entity} rows. ${shape.cursorKey} is null on the last page.`,
    properties: { [shape.dataKey]: { type: 'array', items: ref(entity) }, [shape.cursorKey]: { type: ['string', 'null'] } },
    required: [shape.dataKey, shape.cursorKey],
    additionalProperties: false,
  };
}

/** The world's error template as a schema: $status, $code and $message become typed slots. */
function errorSchema(template: unknown, status: number, code: JsonSchema): JsonSchema {
  if (typeof template === 'string') {
    if (template === '$status') return { type: 'integer', const: status };
    if (template === '$code') return code;
    if (/\$(status|code|message)/.test(template)) return { type: 'string' };
    return { const: template };
  }
  if (Array.isArray(template)) {
    return { type: 'array', prefixItems: template.map((t) => errorSchema(t, status, code)), items: false };
  }
  if (template !== null && typeof template === 'object') {
    const entries = Object.entries(template);
    return {
      type: 'object',
      properties: Object.fromEntries(entries.map(([k, v]) => [k, errorSchema(v, status, code)])),
      required: entries.map(([k]) => k),
      additionalProperties: false,
    };
  }
  if (typeof template === 'number' || typeof template === 'boolean' || template === null) return { const: template };
  return {};
}

/**
 * Error responses by status. `closed` lists the only codes a status can carry; `open` codes are
 * the ones known (an action handler may use others).
 */
function errorResponses(world: World, closed: readonly EngineErrorCode[], open: readonly { status: ErrorStatus; code: string }[] = []): Record<string, OpenApiResponse> {
  const byStatus = new Map<ErrorStatus, { codes: string[]; closed: boolean }>();
  const add = (status: ErrorStatus, code: string, isClosed: boolean): void => {
    const slot = byStatus.get(status) ?? { codes: [], closed: true };
    if (!slot.codes.includes(code)) slot.codes.push(code);
    slot.closed &&= isClosed;
    byStatus.set(status, slot);
  };
  for (const o of open) add(o.status, o.code, false);
  for (const c of closed) add(ENGINE_ERROR_CODES[c].status, c, true);
  const out: Record<string, OpenApiResponse> = {};
  for (const [status, { codes, closed: isClosed }] of [...byStatus].sort(([a], [b]) => a - b)) {
    const code: JsonSchema = isClosed ? { type: 'string', enum: codes } : { type: 'string', examples: codes };
    const lead = isClosed ? 'Codes' : 'Known codes (the handler may use others)';
    out[String(status)] = {
      description: `${STATUS_TEXT[status]}. ${lead}: ${codes.join(', ')}.`,
      content: { 'application/json': { schema: errorSchema(world.meta.api.error, status, code) } },
    };
  }
  return out;
}

// ---- which engine errors an operation can raise

/** Entities a delete of `entity` removes: itself and every cascade below it. */
function cascadeClosure(world: World, entity: string): Set<string> {
  const doomed = new Set([entity]);
  const queue = [entity];
  while (queue.length > 0) {
    const target = queue.shift()!;
    for (const [en, e] of Object.entries(world.entities)) {
      for (const d of Object.values(e.fields)) {
        const ref = refOf(d);
        if (ref?.entity === target && ref.onDelete === 'cascade' && !doomed.has(en)) {
          doomed.add(en);
          queue.push(en);
        }
      }
    }
  }
  return doomed;
}

function deleteErrors(world: World, entity: string): EngineErrorCode[] {
  const doomed = cascadeClosure(world, entity);
  const refs = Object.values(world.entities).flatMap((e) => Object.values(e.fields)).flatMap((d) => {
    const ref = refOf(d);
    return ref && doomed.has(ref.entity) ? [{ onDelete: ref.onDelete, required: d.required, nullable: d.nullable }] : [];
  });
  return [
    'query.unknown', 'row.not_found',
    ...(refs.some((d) => d.onDelete === 'restrict') ? ['delete.restricted' as const] : []),
    ...(refs.some((d) => d.onDelete === 'nullify' && (d.required || !d.nullable)) ? ['field.null' as const] : []),
  ];
}

/** Store refusals a write through the API can hit, given the entity's fields. */
function writeErrors(e: Entity, op: 'create' | 'update'): EngineErrorCode[] {
  const fields = Object.values(e.fields);
  const open = fields.filter((d) => !d.readonly);
  const has = (test: (d: Field) => boolean, code: EngineErrorCode, among: readonly Field[] = open): EngineErrorCode[] => (among.some(test) ? [code] : []);
  return [
    'query.unknown', 'body.invalid',
    ...(op === 'update' ? ['row.not_found' as const] : []),
    ...has((d) => d.unique, 'field.unique', fields),
    'field.unknown', 'field.readonly',
    ...(op === 'create' ? has(mustSend, 'field.required', fields) : []),
    ...has((d) => d.required || !d.nullable, 'field.null'),
    'field.type',
    ...has((d) => refOf(d) !== undefined, 'ref.unresolved'),
    ...(op === 'create' ? has((d) => machineOf(d) !== undefined, 'state.initial') : has((d) => machineOf(d) !== undefined, 'state.transition')),
  ];
}

const ACTION_ERRORS: readonly EngineErrorCode[] = [
  'body.invalid', 'input.invalid', 'row.not_found', 'entity.unknown', 'field.unique', 'delete.restricted',
  'field.unknown', 'field.readonly', 'field.required', 'field.null', 'field.type', 'ref.unresolved', 'state.transition', 'action.failed',
];

/** Codes a handler passes to ctx.fail as literals, by status. Codes built at run time are not found. */
function handlerCodes(source: string): { status: ErrorStatus; code: string }[] {
  const out: { status: ErrorStatus; code: string }[] = [];
  for (const m of source.matchAll(/\bfail\(\s*(\d{3})\s*,\s*(['"`])([A-Za-z0-9_.:-]+)\2/g)) {
    const status = HANDLER_STATUSES.find((s) => String(s) === m[1]);
    if (status !== undefined) out.push({ status, code: m[3]! });
  }
  return out;
}

// ---- paths

const METHOD_KEY = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'delete' } as const satisfies Record<Route['method'], MethodKey>;
const PARAM_RE = /^\{([^{}]+)\}$/;
const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');
/** The router ignores empty segments, so /tickets/ is served as /tickets. */
const pathKey = (path: string): string => `/${segmentsOf(path).join('/')}`;
const paramsOf = (path: string): string[] => segmentsOf(path).flatMap((s) => PARAM_RE.exec(s)?.[1] ?? []);

/** The engine fields every row has; lists may filter and sort on them. */
const ENGINE_COLUMNS: Readonly<Record<string, JsonSchema>> = {
  id: { type: 'string' },
  created_at: { type: 'string', format: 'date-time' },
  updated_at: { type: 'string', format: 'date-time' },
};

/** The query schema of a column the router can filter or sort on, or null when it ignores the name. */
function columnSchema(e: Entity, name: string): JsonSchema | null {
  const def = Object.hasOwn(e.fields, name) ? e.fields[name] : undefined;
  if (def !== undefined) return fieldJsonSchema(def, 'query');
  return Object.hasOwn(ENGINE_COLUMNS, name) ? { ...ENGINE_COLUMNS[name] } : null;
}

const pathParam = (name: string, description: string, schema: JsonSchema = { type: 'string' }): OpenApiParameter =>
  ({ name, in: 'path', required: true, description, schema });
const queryParam = (name: string, description: string, schema: JsonSchema): OpenApiParameter =>
  ({ name, in: 'query', required: false, description, schema });

function listParameters(world: World, route: Extract<Route, { op: 'list' }>, e: Entity): OpenApiParameter[] {
  const shape = world.meta.api.list;
  const out: OpenApiParameter[] = paramsOf(route.path).map((p) => {
    const s = columnSchema(e, p);
    return s === null ? pathParam(p, 'Not used by this list.') : pathParam(p, `Only ${route.entity} rows whose ${p} equals this.`, s);
  });
  for (const f of route.filters) {
    const s = columnSchema(e, f);
    if (s !== null) out.push(queryParam(f, `Only rows whose ${f} equals this.`, s));
  }
  if (route.search.length > 0) {
    out.push(queryParam('q', `Case-insensitive substring match on any of: ${route.search.join(', ')}.`, { type: 'string' }));
  }
  const sortable = route.sort.filter((f) => columnSchema(e, f) !== null);
  if (shape.mode !== 'stripe' && sortable.length > 0) {
    out.push(queryParam('sort', 'One field, ascending, or descending with a leading -. Ties break by id. Default: id order.',
      { type: 'string', enum: [...sortable, ...sortable.map((f) => `-${f}`)] }));
  }
  if (shape.mode === 'stripe') {
    out.push(queryParam(shape.limitParam, `Page size from 1 to ${STRIPE_MAX_LIMIT}.`,
      { type: 'integer', minimum: 1, maximum: STRIPE_MAX_LIMIT, default: Math.min(route.pageSize, STRIPE_MAX_LIMIT) }));
    out.push(queryParam(shape.startingAfterParam, `Return rows after this id in newest-first order. Cannot be combined with ${shape.endingBeforeParam}.`, { type: 'string' }));
    out.push(queryParam(shape.endingBeforeParam, `Return rows immediately before this id in newest-first order. Cannot be combined with ${shape.startingAfterParam}.`, { type: 'string' }));
  } else {
    out.push(queryParam(shape.limitParam, `Page size. Values above ${route.pageSize} are capped to ${route.pageSize}.`,
      { type: 'integer', minimum: 1, default: route.pageSize }));
    out.push(queryParam(shape.cursorParam, `The ${shape.cursorKey} of the previous page, under the same sort.`, { type: 'string' }));
  }
  return out;
}

/** get, update and delete address the row by {id}, or by the last param when there is no {id}. */
function rowParameters(route: Route): OpenApiParameter[] {
  const params = paramsOf(route.path);
  const rowParam = params.includes('id') ? 'id' : params.at(-1);
  return params.map((p) => (p === rowParam ? pathParam(p, `Id of the ${route.entity}.`) : pathParam(p, 'Not used to select the row.')));
}

const jsonBody = (schema: JsonSchema, required: boolean): NonNullable<OpenApiOperation['requestBody']> =>
  ({ required, content: { 'application/json': { schema } } });
const jsonResponse = (description: string, schema: JsonSchema): OpenApiResponse => ({ description, content: { 'application/json': { schema } } });

function routeOperation(world: World, id: string, route: Route, schemas: Record<string, JsonSchema>): OpenApiOperation {
  const e = world.entities[route.entity]!;
  const name = route.entity;
  const common = { operationId: id, tags: [name], ...(route.description === undefined ? {} : { description: route.description }) };
  if (route.op === 'list') {
    schemas[`${name}.list`] ??= listSchema(world, name);
    return { ...common, summary: `List ${name} rows`, parameters: listParameters(world, route, e),
      responses: { 200: jsonResponse(`A page of ${name} rows.`, ref(`${name}.list`)),
        ...errorResponses(world, ['query.unknown', 'query.invalid', 'cursor.invalid', ...(paramsOf(route.path).length > 0 ? ['row.not_found' as const] : [])]) } };
  }
  if (route.op === 'get') {
    return { ...common, summary: `Get one ${name}`, parameters: rowParameters(route),
      responses: { 200: jsonResponse(`The ${name}.`, ref(name)), ...errorResponses(world, ['query.unknown', 'row.not_found']) } };
  }
  if (route.op === 'create') {
    schemas[`${name}.create`] ??= bodySchema(writable(e), 'create', `Fields of a new ${name}. Readonly fields are set by the world, not the client.`);
    const required = writable(e).some(([, d]) => mustSend(d));
    return { ...common, summary: `Create a ${name}`, parameters: paramsOf(route.path).map((p) => pathParam(p, 'Not used by create.')),
      requestBody: jsonBody(ref(`${name}.create`), required),
      responses: { 201: jsonResponse(`The created ${name}.`, ref(name)), ...errorResponses(world, writeErrors(e, 'create')) } };
  }
  if (route.op === 'update') {
    schemas[`${name}.update`] ??= bodySchema(writable(e), 'update', `Fields to change on a ${name}. Omitted fields keep their values.`);
    return { ...common, summary: `Update a ${name}`, parameters: rowParameters(route), requestBody: jsonBody(ref(`${name}.update`), false),
      responses: { 200: jsonResponse(`The updated ${name}.`, ref(name)), ...errorResponses(world, writeErrors(e, 'update')) } };
  }
  return { ...common, summary: `Delete a ${name}`, parameters: rowParameters(route),
    responses: { 204: { description: 'Deleted. No body.' }, ...errorResponses(world, deleteErrors(world, name)) } };
}

function actionOperation(world: World, id: string, action: Action, schemas: Record<string, JsonSchema>): OpenApiOperation {
  const input = Object.entries(action.input);
  const notes = [
    action.description,
    'A handler that answers with its own status of 400 or more sends its own body, not the error envelope.',
  ];
  const op: OpenApiOperation = {
    operationId: id,
    summary: id,
    description: joinText(...notes) ?? '',
    tags: ['Actions'],
    parameters: paramsOf(action.path).map((p) => pathParam(p, `Passed to the handler as params.${p}.`)),
    responses: {
      '2XX': jsonResponse('Success. The handler sets the status and body.', {}),
      ...errorResponses(world, ACTION_ERRORS, handlerCodes(action.handler)),
    },
  };
  if (input.length > 0) {
    schemas[`${id}.input`] = bodySchema(input, 'input', `Input of the ${id} action.`);
    op.requestBody = jsonBody(ref(`${id}.input`), input.some(([, d]) => mustSend(d)));
  }
  return op;
}

/**
 * The OpenAPI 3.1 document for the world's public API (a CheckedWorld is a World). One operation per
 * route and per action. When two share a method and path, the first in declaration order wins, as
 * in the router.
 */
export function openApiOf(world: World): OpenApiDocument {
  const schemas: Record<string, JsonSchema> = {};
  for (const [name, e] of Object.entries(world.entities)) schemas[name] = rowSchema(e);
  const paths: Record<string, OpenApiPathItem> = {};
  const place = (path: string, method: Route['method'], build: () => OpenApiOperation): void => {
    const item = (paths[pathKey(path)] ??= {});
    item[METHOD_KEY[method]] ??= build();
  };
  for (const [id, r] of Object.entries(world.routes)) {
    if (Object.hasOwn(world.entities, r.entity)) place(r.path, r.method, () => routeOperation(world, id, r, schemas));
  }
  for (const [id, a] of Object.entries(world.actions)) place(a.path, a.method, () => actionOperation(world, id, a, schemas));

  const { meta } = world;
  return {
    openapi: '3.1.0',
    info: { title: meta.name, version: '1', description: joinText(meta.description, meta.resembles === '' ? undefined : `Resembles ${meta.resembles}.`) ?? '' },
    tags: [
      ...Object.entries(world.entities).map(([name, e]) => ({ name, description: e.description })),
      ...(Object.keys(world.actions).length > 0 ? [{ name: 'Actions', description: 'Operations with custom logic.' }] : []),
    ],
    paths,
    components: { schemas },
    'x-error-codes': Object.fromEntries(Object.entries(ENGINE_ERROR_CODES).map(([c, v]) => [c, { status: v.status, meaning: v.meaning }])),
  };
}
