/**
 * THE world format. One zod schema, and everything else derives from it:
 * - static types (`z.output`),
 * - runtime validation in check.ts,
 * - JSON Schema for each WorldGen stage tool (`editJsonSchema`),
 * - check messages (hints come from `.describe()` text),
 * - prod/world-format.md and the stage system prompts (`formatReference`).
 *
 * Invariants:
 * - Every section is a record keyed by name, so every change is a WorldEdit.
 *   Generation is `edit(emptyWorld)`. Iteration is `edit(existing)`. One code path.
 * - Logic that must be code is a snippet string (`js(kind)`). Everything the engine must
 *   enforce on every write (types, refs, unique, readonly, state machines) is data.
 * - Adding a key to `sections` adds it to edits, tool schemas and docs. The compiler then
 *   asks for its owning step in worldgen/stages.ts (`SECTION_OWNER`).
 */
import { z } from 'zod';
import { Duration, Tick } from './clock.ts';
import { SNIPPET_LIMITS, js, snippetDoc, type SnippetKind } from './ctx.ts';
import { FIELD_TYPES, FieldName, Name, fieldSchema } from './fields.ts';
import { ISSUES, issue, type CheckIssue, type IssueCode } from './issues.ts';
import { rulesField } from './rules.ts';

export { Name };

const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const path = z.string().regex(/^\//).describe('OpenAPI-style path with {params}, such as /tickets/{id}');

export const entitySchema = z.strictObject({
  description: z.string(),
  idPrefix: z.string().regex(/^[a-z]{2,5}$/).describe('Row ids look like <idPrefix>_0001'),
  fields: z.record(FieldName, fieldSchema).describe('id, created_at and updated_at are implicit and engine-maintained'),
});

const routeCommon = { method, path, description: z.string().optional() };
/** Standard operations. The engine implements them. Custom logic goes in `actions`. */
export const routeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list'), entity: Name,
    filters: z.array(FieldName).default([]).describe('fields a client filters on with ?field=value; several filters all must match, and null on a nullable field matches rows where it is null'),
    search: z.array(FieldName).default([]),
    sort: z.array(FieldName).default([]), pageSize: z.number().int().min(1).max(200).default(25), ...routeCommon }),
  z.strictObject({ op: z.literal('get'), entity: Name, ...routeCommon }),
  z.strictObject({ op: z.literal('create'), entity: Name, ...routeCommon }),
  z.strictObject({ op: z.literal('update'), entity: Name, ...routeCommon }),
  z.strictObject({ op: z.literal('delete'), entity: Name, ...routeCommon }),
]);

/** A route with custom logic. The body is validated against `input` before the handler runs. */
export const actionSchema = z.strictObject({
  ...routeCommon,
  input: z.record(FieldName, fieldSchema).default({}),
  handler: js('handler'),
  rules: rulesField.optional(),
  duration: Duration.optional().describe(
    'engine time the action takes, such as 4h for a carrier pickup. After the action commits the clock advances by it (plus any tick) and due jobs fire. A failed call takes no time. Omit for an instant action.'),
});

/** Time-driven logic: SLA breach, expiry. Fires when engine time passes each multiple of `every`. */
export const jobSchema = z.strictObject({ description: z.string(), every: Duration, run: js('job'), rules: rulesField.optional() });

export const testSchema = z.strictObject({ description: z.string(), script: js('test') });

export const decoySchema = z.strictObject({
  why: z.string().min(10).describe('the plausible mistake this script makes, such as "skips page 2"'),
  script: js('client'),
});

export const alternativeSchema = z.strictObject({
  why: z.string().min(10).describe('how this correct path differs from the solution, such as "assigns before escalating"'),
  script: js('client'),
});

/** One kind of change a task permits (YOS-156): rows of `entity` created, deleted, or updated in only `fields`. */
export const allowanceSchema = z.strictObject({
  entity: Name,
  kind: z.enum(['created', 'updated', 'deleted']),
  fields: z.array(FieldName).default([]).describe('for updated: the only fields a change may touch. Ignored for created and deleted.'),
  where: z.record(FieldName, z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe(
    'only rows with these field values: seed values for updated and deleted rows, end values for created ones. Omit to allow every row of the entity.'),
});

export const taskSchema = z.strictObject({
  difficulty: z.enum(['easy', 'medium', 'hard']),
  instruction: z.string().min(20).describe('what the agent under test is told. Do not leak ids it should discover.'),
  grader: js('grader').optional().describe('present in the private world; a public bundle drops it and keeps only the instruction (YOS-159)'),
  solution: js('client').optional().describe('present in the private world; a public bundle drops it and keeps only the instruction (YOS-159)'),
  decoys: z.array(decoySchema).default([]).describe('wrong solutions that must score below 1. Required on medium and hard.'),
  alternatives: z.array(alternativeSchema).default([]).describe('other correct solutions that must score exactly 1, so the grader judges the outcome, not one path (A-199)'),
  allows: z.array(allowanceSchema).optional().describe(
    'the changes the task permits, from its instruction, not from what the solution happens to write. When set, the engine adds a guard that scores 0 for any change outside it, a call edit later reverted included (A-387); job changes and engine timestamps are exempt. A task without it is a legacy task, judged by its grader\'s own guards and the engine mutants (YOS-156).'),
});

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** The largest page a stripe-mode list returns, as Stripe's own limit. */
export const STRIPE_MAX_LIMIT = 100;

/** meta.api.list keys without defaults, so the world schema and the edit schema share one description each. */
const listKeys = {
  mode: z.enum(['cursor', 'stripe']).describe(
    'cursor: rows in id order, or by a route sort field with ?sort=field or ?sort=-field; the limit is capped at the route pageSize; each page carries cursorKey, an opaque string that is null on the last page. '
    + 'stripe: Stripe list paging. Rows are newest first by created_at, ties by id descending; ?sort is refused. '
    + `The limit is 1 to ${STRIPE_MAX_LIMIT} and defaults to the route pageSize capped at ${STRIPE_MAX_LIMIT}. `
    + 'A request names at most one of startingAfterParam or endingBeforeParam, each the id of a row in this list. '
    + 'The page carries the boolean hasMoreKey instead of a cursor. '
    + 'Example: with three charges and {"mode":"stripe"}, GET /v1/charges?limit=2 returns ch_0003 and ch_0002 with has_more true, '
    + '?limit=2&starting_after=ch_0002 returns ch_0001 with has_more false, and ?ending_before=ch_0001 returns ch_0003 and ch_0002 with has_more false.'),
  dataKey: z.string().describe('response key of the page array'),
  cursorKey: z.string().describe('cursor mode only: response key of the next-page cursor'),
  limitParam: z.string().describe('query parameter for the page size'),
  cursorParam: z.string().describe('cursor mode only: query parameter that takes a cursorKey value'),
  hasMoreKey: z.string().describe('stripe mode only: boolean response key, true when more rows lie past this page in the direction it was read'),
  startingAfterParam: z.string().describe('stripe mode only: query parameter naming a row id; the page holds the rows after it (older)'),
  endingBeforeParam: z.string().describe('stripe mode only: query parameter naming a row id; the page holds the rows just before it (newer), still newest first'),
};

function hasNoJsonCycle(value: unknown): boolean {
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  const pending: { value: unknown; leaving: boolean }[] = [{ value, leaving: false }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next || next.value === null || typeof next.value !== 'object') continue;
    const node = next.value;
    if (next.leaving) {
      active.delete(node);
      complete.add(node);
      continue;
    }
    if (active.has(node)) return false;
    if (complete.has(node)) continue;
    active.add(node);
    pending.push({ value: node, leaving: true });
    for (const child of Object.values(node)) pending.push({ value: child, leaving: false });
  }
  return true;
}

const JsonTemplate = z.json().refine(hasNoJsonCycle, 'JSON error templates must not contain cycles');

/** The real API's envelopes, so OpenAPI-derived worlds keep their shapes. */
export const apiShapeSchema = z.strictObject({
  list: z
    .strictObject({
      mode: listKeys.mode.default('cursor'),
      dataKey: listKeys.dataKey.default('data'),
      cursorKey: listKeys.cursorKey.default('next_cursor'),
      limitParam: listKeys.limitParam.default('limit'),
      cursorParam: listKeys.cursorParam.default('cursor'),
      hasMoreKey: listKeys.hasMoreKey.default('has_more'),
      startingAfterParam: listKeys.startingAfterParam.default('starting_after'),
      endingBeforeParam: listKeys.endingBeforeParam.default('ending_before'),
    })
    .prefault({}),
  error: JsonTemplate
    .default({ error: { code: '$code', message: '$message' } })
    .describe('error body template. $status, $code, $message, $type and $param are replaced. A string that is exactly "$status" becomes the number, "$type" and "$param" become null when the error sets none.'),
});

export const metaSchema = z.strictObject({
  name: Name,
  description: z.string(),
  resembles: z.string().describe('the real software this world mirrors, such as "Zendesk tickets API"'),
  source: z.enum(['hand', 'worldgen']),
  seed: z.number().int().describe('rng seed for seed snippets'),
  clock: z.strictObject({
    start: z.iso.datetime(),
    tick: Tick.default('0s').describe(
      'engine time added after each committed call. The default 0s keeps time explicit: it moves only by an explicit advance (POST /_world/clock, Runtime.advance) or an action duration. Set it, such as 1s, to opt in to per-call drift.'),
  }),
  api: apiShapeSchema.prefault({}),
});

/** Keyed sections. Order here is the seed and check order only where noted in check.ts. */
const sections = {
  entities: z.record(Name, entitySchema),
  routes: z.record(Name, routeSchema),
  actions: z.record(Name, actionSchema),
  jobs: z.record(Name, jobSchema),
  fixtures: z.record(Name, z.array(z.record(z.string(), Scalar))).describe('imported tables (CSV), written by code, read by seed'),
  seed: z.record(Name, js('seed')).describe('entity to generator. Runs in ref order. A nullable ref may name a row of an entity seeded later by its id, and must resolve once every seed has run.'),
  tests: z.record(Name, testSchema),
  tasks: z.record(Name, taskSchema),
};
export type Section = keyof typeof sections;
export const SECTIONS = Object.keys(sections) as readonly Section[];

export const worldSchema = z.strictObject({ format: z.literal(1), meta: metaSchema, ...sections });
export type World = z.output<typeof worldSchema>;
export type Entity = z.output<typeof entitySchema>;
export type Route = z.output<typeof routeSchema>;
export type Action = z.output<typeof actionSchema>;
export type Job = z.output<typeof jobSchema>;
export type Task = z.output<typeof taskSchema>;
export type Difficulty = Task['difficulty'];

function mapSections<V extends z.ZodType>(f: (s: Section) => V): { [K in Section]: V } {
  return Object.fromEntries(SECTIONS.map((s) => [s, f(s)])) as { [K in Section]: V };
}

const clockSchema = metaSchema.shape.clock;
/** meta as an edit: every key optional at every depth (except the opaque error template), still strict. */
const metaEditSchema = metaSchema.extend({
  clock: z.strictObject({ start: clockSchema.shape.start, tick: Tick }).partial(),
  api: z.strictObject({
    list: z.strictObject(listKeys).partial(),
    error: JsonTemplate,
  }).partial(),
}).partial();

/** JSON merge patch (RFC 7386) for one keyed item. null deletes a key. */
const mergePatch = z.record(z.string(), z.unknown());

/**
 * The only way a world changes, for humans and WorldGen alike.
 * Apply order: remove, then upsert (whole item), then patch (merge into one item).
 */
export const worldEditSchema = z.strictObject({
  note: z.string().describe('one line: what this edit changes and why'),
  meta: metaEditSchema.optional().describe('merge-patched into meta at every depth. Only the keys given change.'),
  upsert: z.strictObject(sections).partial().default({}).describe('insert or replace whole items by key'),
  patch: z.strictObject(mapSections(() => z.record(Name, mergePatch))).partial().default({})
    .describe('merge-patch existing items by key. Use it to add one field or state without restating the item.'),
  remove: z.strictObject(mapSections(() => z.array(Name))).partial().default({}),
});
export type WorldEdit = z.output<typeof worldEditSchema>;

/** Engine time zero for a new world. A fixed literal, never the wall clock. */
const EMPTY_WORLD_START = '2026-01-05T09:00:00.000Z';

/** A world with every section empty. Generation is `edit(emptyWorld(...))`. Throws if `name` is not a Name. */
export function emptyWorld(name: string, source: World['meta']['source']): World {
  return worldSchema.parse({
    format: 1,
    meta: { name, description: '', resembles: '', source, seed: 0, clock: { start: EMPTY_WORLD_START } },
    ...Object.fromEntries(SECTIONS.map((s) => [s, {}])),
  });
}

/** JSON Schema for a stage tool: a WorldEdit restricted to `writes`. Derived, never hand-written. */
export function editJsonSchema(writes: readonly Section[]): object {
  const mask = Object.fromEntries(SECTIONS.filter((s) => writes.includes(s)).map((s) => [s, true] as const)) as { [K in Section]?: true };
  const narrow = (field: z.ZodDefault<z.ZodObject>): z.ZodType => {
    const picked = field.unwrap().pick(mask).default({});
    return field.description === undefined ? picked : picked.describe(field.description);
  };
  const { upsert, patch, remove } = worldEditSchema.shape;
  return z.toJSONSchema(worldEditSchema.extend({ upsert: narrow(upsert), patch: narrow(patch), remove: narrow(remove) }), { io: 'input' });
}

/** Every snippet kind, in docs order. `satisfies` makes a new kind a compile error here. */
const SNIPPET_KINDS = Object.keys({ handler: 0, job: 0, seed: 0, grader: 0, client: 0, test: 0 } satisfies Record<SnippetKind, 0>) as SnippetKind[];

/**
 * One example of every issue code, with placeholders such as `<kind>` for the details each issue
 * fills in, so the reference can print each code's expected and hint text. The type makes a new
 * catalog code a compile error here until it has an example.
 */
const ISSUE_EXAMPLES: { readonly [C in IssueCode]: CheckIssue } = {
  'schema.invalid': issue('schema.invalid', ['format'], { message: '<message>' }, '<found>'),
  'ref.unknown': issue('ref.unknown', ['format'], { kind: '<kind>', name: '<name>', known: ['<known names>'] }, '<found>'),
  'route.duplicate_path': issue('route.duplicate_path', ['format'], { method: '<method>', path: '<path>', other: '<other item>' }, '<found>'),
  'route.bad_path': issue('route.bad_path', ['format'], { problem: '<problem>' }, '<found>'),
  'route.reserved_path': issue('route.reserved_path', ['format'], { reserved: '<reserved path>', reason: '<what serve answers there>.' }, '<found>'),
  'route.missing_id_param': issue('route.missing_id_param', ['format'], { op: '<op>' }, '<found>'),
  'route.param_not_column': issue('route.param_not_column', ['format'], { param: '<param>', entity: '<entity>', known: ['<fields>'] }, '<found>'),
  'route.sort_ignored': issue('route.sort_ignored', ['format'], { route: '<route>' }, '<found>'),
  'route.filter_not_filterable': issue('route.filter_not_filterable', ['format'], { entity: '<entity>', field: '<field>', type: '<type>' }, '<found>'),
  'api.name_collision': issue('api.name_collision', ['format'], { problem: '<problem>' }, '<found>'),
  'field.reserved_name': issue('field.reserved_name', ['format'], { field: '<field>' }, '<found>'),
  'state.bad_machine': issue('state.bad_machine', ['format'], { problem: '<problem>' }, '<found>'),
  'field.default_invalid': issue('field.default_invalid', ['format'], { problem: '<problem>' }, '<found>'),
  'field.range_inverted': issue('field.range_inverted', ['format'], { problem: '<problem>' }, '<found>'),
  'field.pattern_invalid': issue('field.pattern_invalid', ['format'], { problem: '<problem>' }, '<found>'),
  'field.values_duplicate': issue('field.values_duplicate', ['format'], { problem: '<problem>' }, '<found>'),
  'seed.cycle': issue('seed.cycle', ['format'], { cycle: ['<entity>', '<entity>'], refs: ['<entity>.<field>', '<entity>.<field>'] }, '<found>'),
  'snippet.compile_error': issue('snippet.compile_error', ['format'], { message: '<message>' }, '<found>'),
  'snippet.runtime_error': issue('snippet.runtime_error', ['format'], { message: '<message>' }, '<found>'),
  'snippet.promise_returned': issue('snippet.promise_returned', ['format'], {}, '<found>'),
  'snippet.call_quota': issue('snippet.call_quota', ['format'], { limit: SNIPPET_LIMITS.ctxCallsPerRun }, '<found>'),
  'snippet.timeout_guard': issue('snippet.timeout_guard', ['format'], { ms: SNIPPET_LIMITS.guardMs }, '<found>'),
  'snippet.host_unavailable': issue('snippet.host_unavailable', ['format'], { ms: 10_000 }, '<found>'),
  'snippet.memory': issue('snippet.memory', ['format'], { mb: SNIPPET_LIMITS.maxOldGenerationSizeMb }, '<found>'),
  'constraint.violation': issue('constraint.violation', ['format'], { entity: '<entity>', field: '<field>', rule: '<rule>' }, '<found>'),
  'test.failed': issue('test.failed', ['format'], { message: '<message>' }, '<found>'),
  'test.seed_collision': issue('test.seed_collision', ['format'], { entity: '<entity>', field: '<field>', value: '<value>', rowId: '<id>' }, '<found>'),
  'action.unexercised': issue('action.unexercised', ['format'], { action: '<action>' }, '<found>'),
  'task.clock_control': issue('task.clock_control', ['format'], {}, '<found>'),
  'task.instruction_only': issue('task.instruction_only', ['format'], {}, '<found>'),
  'task.grader_out_of_range': issue('task.grader_out_of_range', ['format'], { score: '<score>' }, '<found>'),
  'task.solution_not_full_marks': issue('task.solution_not_full_marks', ['format'], { score: 0.5 }, '<found>'),
  'task.reference_server_error': issue('task.reference_server_error', ['format'], { task: '<task>', call: '<method> <path> answered <status>', body: '<body>' }, '<found>'),
  'task.noop_not_zero': issue('task.noop_not_zero', ['format'], { score: 0.5 }, '<found>'),
  'task.alternative_not_full_marks': issue('task.alternative_not_full_marks', ['format'], { why: 'assigns before escalating', score: 0 }, '<found>'),
  'task.idle_not_zero': issue('task.idle_not_zero', ['format'], { seconds: 3, jobsFired: ['sla_breach'] }, '<found>'),
  'task.decoy_required': issue('task.decoy_required', ['format'], { difficulty: '<difficulty>' }, '<found>'),
  'task.decoy_full_marks': issue('task.decoy_full_marks', ['format'], { why: '<why>' }, '<found>'),
  'task.decoy_trivial': issue('task.decoy_trivial', ['format'], { why: '<why>', reason: 'same_as_noop' }, '<found>'),
  'task.decoy_server_error': issue('task.decoy_server_error', ['format'], { task: '<task>', why: '<why>', call: '<method> <path> answered <status>', body: '<body>' }, '<found>'),
  'task.prefix_full_marks': issue('task.prefix_full_marks', ['format'], { writes: 2, of: 3 }, '<found>'),
  'task.mutant_full_marks': issue('task.mutant_full_marks', ['format'], { kind: 'other_row', call: '<call>' }, '<found>'),
  'task.freetext_unchecked': issue('task.freetext_unchecked', ['format'], { field: '<entity>.<field>', call: '<call>' }, '<found>'),
  'task.nondeterministic': issue('task.nondeterministic', ['format'], { first: '<hash>', second: '<hash>' }, '<found>'),
  'world.too_few_tasks': issue('world.too_few_tasks', ['format'], { have: 2 }, '<found>'),
  'tasks.private_mixed': issue('tasks.private_mixed', ['format'], { complete: ['<task ids>'], bare: ['<task ids>'] }, '<found>'),
  'layer.blocked': issue('layer.blocked', ['format'], { layer: '<layer>' }, '<found>'),
  'seed.too_few_rows_for_paging': issue('seed.too_few_rows_for_paging', ['format'], { entity: '<entity>', rows: 20, pageSize: 25 }, '<found>'),
  'seed.state_mix_skewed': issue('seed.state_mix_skewed', ['format'], { field: '<entity.field>', counts: { open: 9, closed: 1 } }, '<found>'),
  'tasks.difficulty_not_spread': issue('tasks.difficulty_not_spread', ['format'], { have: ['<difficulty>'] }, '<found>'),
  'world.read_only': issue('world.read_only', ['format'], { routes: 4 }, '<found>'),
  'task.no_write': issue('task.no_write', ['format'], { calls: 2 }, '<found>'),
  'seed.time_order': issue('seed.time_order', ['format'], { entity: '<entity>', id: '<id>', problem: '<problem>' }, '<found>'),
  'seed.totals_mismatch': issue('seed.totals_mismatch', ['format'], { field: '<entity.field>', child: '<entity.field>', id: '<id>', total: 100, sum: 90 }, '<found>'),
  'tasks.no_read_before_write': issue('tasks.no_read_before_write', ['format'], {}, '<found>'),
  'route.unused_required_input': issue('route.unused_required_input', ['format'], { action: '<action>', field: '<field>' }, '<found>'),
  'seed.lorem_text': issue('seed.lorem_text', ['format'], { field: '<entity.field>', rows: 3 }, '<found>'),
  'openapi.operation_missing': issue('openapi.operation_missing', ['format'], { method: '<method>', path: '<path>' }, '<found>'),
  'openapi.operation_extra': issue('openapi.operation_extra', ['format'], { method: '<method>', path: '<path>' }, '<found>'),
  'openapi.status_missing': issue('openapi.status_missing', ['format'], { op: '<method path>', status: '<status>' }, '<found>'),
  'openapi.required_field_extra': issue('openapi.required_field_extra', ['format'], { op: '<method path>', field: '<field>' }, '<found>'),
  'openapi.required_field_missing': issue('openapi.required_field_missing', ['format'], { op: '<method path>', field: '<field>' }, '<found>'),
  'openapi.field_type': issue('openapi.field_type', ['format'], { op: '<method path>', where: '<request or response>', field: '<field>', type: '<json type>' }, '<found>'),
  'openapi.field_enum': issue('openapi.field_enum', ['format'], { op: '<method path>', where: '<request or response>', field: '<field>', values: ['<value>'] }, '<found>'),
  'rules.invalid': issue('rules.invalid', ['format'], { problem: '<problem>' }, '<found>'),
  'rules.handler_mismatch': issue('rules.handler_mismatch', ['format'], { source: '<lowered source>' }, '<found>'),
  'fidelity.below_floor': issue('fidelity.below_floor', ['format'], { score: 0, floor: 0.8, what: '<miss>' }, '<found>'),
  'plan.not_covered': issue('plan.not_covered', ['format'], { item: '<item>' }, '<found>'),
  'plan.seed_rows_short': issue('plan.seed_rows_short', ['format'], { entity: '<entity>', planned: 0, built: 0 }, '<found>'),
  'plan.state_missing': issue('plan.state_missing', ['format'], { workflow: '<workflow>', entity: '<entity>', state: '<state>' }, '<found>'),
  'plan.state_field_missing': issue('plan.state_field_missing', ['format'], { workflow: '<workflow>', entity: '<entity>', states: ['<state>'] }, '<found>'),
  'plan.lifecycle_unrepresented': issue('plan.lifecycle_unrepresented', ['format'], { workflow: '<workflow>', entity: '<entity>', states: ['<state>'] }, '<found>'),
  'plan.pressure_unreachable': issue('plan.pressure_unreachable', ['format'], { task: '<task>', entity: '<entity>', state: '<state>', workflows: ['<workflow>'] }, '<found>'),
  'plan.rule_unanswered': issue('plan.rule_unanswered', ['format'], { workflow: '<workflow>', rule: '<rule>', by: ['<action or job>'] }, '<found>'),
  'plan.job_as_action': issue('plan.job_as_action', ['format'], { job: '<job>' }, '<found>'),
  'task.difficulty_unproven': issue('task.difficulty_unproven', ['format'], { task: '<task>', rows: 1 }, '<found>'),
  'task.planned_action_uncalled': issue('task.planned_action_uncalled', ['format'], { task: '<task>', planned: ['<action>'], missed: ['<action>'] }, '<found>'),
  'task.pressure_unmet': issue('task.pressure_unmet', ['format'], { task: '<task>', need: '<need>' }, '<found>'),
  'plan.fixture_changed': issue('plan.fixture_changed', ['format'], { entity: '<entity>', table: '<table>', problem: '<problem>' }, '<found>'),
  'plan.seed_mix_off': issue('plan.seed_mix_off', ['format'], { entity: '<entity>', state: '<state>', planned: 0, built: 0, within: 10 }, '<found>'),
  'edit.out_of_scope': issue('edit.out_of_scope', ['format'], { section: '<section>', allowed: ['<sections>'] }, '<found>'),
  'iterate.unplanned_change': issue('iterate.unplanned_change', ['format'], { change: '<change>' }, '<found>'),
  'iterate.out_of_scope': issue('iterate.out_of_scope', ['format'], { item: '<section.item>', request: '<change request>' }, '<found>'),
  'iterate.regression': issue('iterate.regression', ['format'], { what: '<what>' }, '<found>'),
};

/** Markdown reference from the schemas, FIELD_TYPES docs, ctx registries and issue catalog. prod/world-format.md and system prompts. */
export function formatReference(): string {
  const out: string[] = [
    '# World format',
    '',
    'A world is one world.yaml with `format: 1`, `meta`, and the keyed sections below. Every section maps a snake_case name to an item. Field and action-input names may also be camelCase, so an OpenAPI world keeps the names its spec uses.',
    '',
    '## meta',
    '',
    ...renderProps(jsonOf(metaSchema), ''),
  ];
  for (const s of SECTIONS) {
    const node = jsonOf(sections[s]);
    out.push('', `## ${s}`, '');
    if (node.description) out.push(node.description, '');
    out.push(...renderItem(node.additionalProperties && typeof node.additionalProperties === 'object' ? node.additionalProperties : {}));
  }
  out.push('', '## Field types', '', 'Each entry under `entities.<name>.fields` is one of these, chosen by `type`.');
  for (const t of Object.values(FIELD_TYPES)) {
    out.push('', `### ${t.type}`, '', t.doc, '', `Example: \`${JSON.stringify(t.examples.def)}\``, '', ...renderProps(jsonOf(t.schema), ''));
  }
  out.push('', '## Snippets', '', 'Snippet fields hold a JS function as a string. What each kind receives:');
  for (const k of SNIPPET_KINDS) out.push('', `### ${k}`, '', '```text', snippetDoc(k), '```');
  out.push('', '## WorldEdit', '', 'The only way a world changes. Apply order: remove, then upsert, then patch.', '',
    ...renderProps(jsonOf(worldEditSchema), ''));
  out.push('', '## Issues', '',
    'Check, verify and WorldGen report these codes. Every issue also carries `path` (where in world.yaml) and `found` (what is there).',
    'Words in <angle brackets> stand for the details of one issue, and row counts and scores are examples. `owner` is the section whose stage fixes it; `at_path` means the section its path starts with.',
    '');
  for (const i of Object.values(ISSUE_EXAMPLES)) {
    out.push(`- \`${i.code}\` (${i.severity}, owner ${ISSUES[i.code].owner}): expected ${i.expected}. Hint: ${i.hint}`);
  }
  return `${out.join('\n')}\n`;
}

/** prod/world-format.md: a generated-file header, then formatReference(). `bun run docs` writes it. */
export function worldFormatDoc(): string {
  return `> Generated by \`bun run docs\` in code/ from code/src/engine/format.ts. Do not edit by hand.\n\n${formatReference()}`;
}

type JsonNode = {
  type?: string | string[];
  const?: unknown;
  enum?: readonly unknown[];
  description?: string;
  default?: unknown;
  pattern?: string;
  format?: string;
  properties?: Record<string, JsonNode>;
  required?: readonly string[];
  additionalProperties?: JsonNode | boolean;
  items?: JsonNode;
  oneOf?: readonly JsonNode[];
  anyOf?: readonly JsonNode[];
};

function jsonOf(schema: z.ZodType): JsonNode {
  return z.toJSONSchema(schema, { io: 'input' }) as JsonNode;
}

function snippetKindOf(n: JsonNode): SnippetKind | undefined {
  return n.description === undefined ? undefined : SNIPPET_KINDS.find((k) => snippetDoc(k) === n.description);
}

/** The property every option pins with `const`, such as `op` or `type`. */
function discriminatorOf(options: readonly JsonNode[]): string | undefined {
  const first = options[0]?.properties ?? {};
  return Object.keys(first).find((p) => options.every((o) => o.properties?.[p]?.const !== undefined));
}

function label(n: JsonNode): string {
  const kind = snippetKindOf(n);
  if (kind) return `snippet (${kind})`;
  if (n.const !== undefined) return JSON.stringify(n.const);
  if (n.enum) return n.enum.map((v) => JSON.stringify(v)).join(' | ');
  const options = n.oneOf ?? n.anyOf;
  if (options) {
    const d = discriminatorOf(options);
    return d ? `object chosen by ${d}: ${options.map((o) => JSON.stringify(o.properties?.[d]?.const)).join(' | ')}`
      : options.map(label).join(' | ');
  }
  if (n.type === 'array') return `list of ${label(n.items ?? {})}`;
  if (n.type === 'object') {
    if (!n.properties && typeof n.additionalProperties === 'object') return `map of name to ${label(n.additionalProperties)}`;
    return 'object';
  }
  if (n.type === 'string' && n.format) return `${n.format} string`;
  if (n.type === 'string' && n.pattern) return `string matching \`${n.pattern}\``;
  if (Array.isArray(n.type)) return n.type.join(' | ');
  return n.type ?? 'any JSON';
}

function renderProps(n: JsonNode, indent: string): string[] {
  const lines: string[] = [];
  const required = new Set(n.required ?? []);
  for (const [key, p] of Object.entries(n.properties ?? {})) {
    const bits = [label(p), required.has(key) ? 'required' : 'optional'];
    if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`);
    const kind = snippetKindOf(p);
    const text = kind ? `See Snippets, ${kind}.` : p.description;
    lines.push(`${indent}- \`${key}\` (${bits.join(', ')})${text ? `: ${text}` : ''}`);
    const nested = p.properties ? p : p.items?.properties ? p.items : undefined;
    if (nested) lines.push(...renderProps(nested, `${indent}  `));
  }
  return lines;
}

function renderItem(item: JsonNode): string[] {
  const options = item.oneOf ?? item.anyOf;
  const d = options && discriminatorOf(options);
  if (options && d) {
    return options.flatMap((o, i) => [...(i > 0 ? [''] : []),
      `Item with \`${d}: ${JSON.stringify(o.properties?.[d]?.const)}\`:`, '', ...renderProps(o, '')]);
  }
  if (item.properties) return ['Each item:', '', ...renderProps(item, '')];
  return [`Each item: ${label(item)}.`];
}
