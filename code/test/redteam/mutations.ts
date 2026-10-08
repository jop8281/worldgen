/**
 * One row per way to break the base world, covering every world-triggerable code in
 * ISSUES. `code` is typed IssueCode, so a typo fails typecheck. Task codes come from
 * graders.ts so there is one copy of each bad task.
 *
 * Row semantics (for test writers):
 * - Apply `mutate` to a fresh baseWorld(), then checkWorld it.
 * - An error code: report.ok is false and some issue has `code` (or a code in `accept`),
 *   and that issue's path starts with `pathPrefix` (an empty prefix matches any path).
 * - A warning code: report.ok is true and some warning has `code`.
 * - `layer` is the CheckLayer that owns the code. For errors, report.reached equals it.
 * - Rows with `todo` depend on an RT ambiguity in research/redteam-contract.md.
 * - Rows with `slow` need the wall-clock guard (about 2 s).
 */
import type { CheckLayer, IssueCode, World } from '#engine';
import { BAD_TASKS } from './graders.ts';
import { AGENT_SEED, field, SEED_PRIORITY, SEED_STATUS, ticketSeed } from './world.ts';

export type Mutation = {
  readonly id: string;
  readonly note: string;
  readonly code: IssueCode;
  readonly pathPrefix: readonly (string | number)[];
  readonly layer: CheckLayer;
  readonly accept?: readonly IssueCode[];
  readonly todo?: string;
  readonly slow?: true;
  /** For task rows that must NOT produce `code`. Only graders.ts rows set it. */
  readonly expect?: 'present' | 'absent';
  mutate(w: World): void;
};

/** Escape the World type for values the schema must reject. */
type Loose = Record<string, unknown>;
const loose = (x: object): Loose => x as Loose;

function at<T>(rec: Readonly<Record<string, T>>, key: string): T {
  const v = rec[key];
  if (v === undefined) throw new Error(`fixture has no ${key}`);
  return v;
}
const ticket = (w: World) => at(w.entities, 'ticket');
const ticketField = (w: World, f: string) => loose(at(ticket(w).fields, f));
const route = (w: World, r: string) => loose(at(w.routes, r));

/**
 * Codes checkWorld never emits: WorldGen's plan and iterate gates, the stage check of a plan
 * task's difficulty and pressure claims against its reference trace, openapiFidelity, which
 * needs the source spec as a second input, and task.instruction_only, which grading or verifying
 * a bare task returns: check stops a mixed world at tasks.private_mixed and verifies no task of an
 * all-bare (public) world. No world.yaml can make checkWorld emit them.
 */
export const NOT_WORLD_TRIGGERABLE: readonly IssueCode[] = [
  'openapi.required_field_extra',
  'fidelity.below_floor',
  'plan.not_covered',
  'plan.seed_rows_short',
  'plan.fixture_changed',
  'plan.state_missing',
  'plan.state_field_missing',
  'plan.lifecycle_unrepresented',
  'plan.pressure_unreachable',
  'plan.rule_unanswered',
  'plan.seed_mix_off',
  'plan.lifecycle_unrepresented',
  'edit.out_of_scope',
  'iterate.unplanned_change',
  'iterate.out_of_scope',
  'iterate.regression',
  'task.difficulty_unproven',
  'task.pressure_unmet',
  'task.instruction_only',
  'openapi.operation_missing',
  'openapi.operation_extra',
  'openapi.status_missing',
  'openapi.required_field_missing',
  'openapi.field_type',
  'openapi.field_enum',
];

/**
 * Codes checkWorld can emit only from the host's condition, never from world content.
 * sandbox.test.ts asserts each one against a host configured to fail.
 */
export const HOST_CONDITION: readonly IssueCode[] = ['snippet.host_unavailable'];

/** Codes that need no mutation row. */
export const NO_MUTATION_ROW: readonly IssueCode[] = [...NOT_WORLD_TRIGGERABLE, ...HOST_CONDITION];

const schema: Mutation[] = [
  { id: 'S01', note: 'format 2', code: 'schema.invalid', pathPrefix: ['format'], layer: 'schema', mutate: (w) => { loose(w).format = 2; } },
  { id: 'S02', note: 'meta.seed is a float', code: 'schema.invalid', pathPrefix: ['meta', 'seed'], layer: 'schema', mutate: (w) => { w.meta.seed = 1.5; } },
  { id: 'S03', note: 'clock.start is not ISO', code: 'schema.invalid', pathPrefix: ['meta', 'clock', 'start'], layer: 'schema', mutate: (w) => { w.meta.clock.start = 'yesterday'; } },
  { id: 'S04', note: 'clock.tick is not a duration', code: 'schema.invalid', pathPrefix: ['meta', 'clock', 'tick'], layer: 'schema', mutate: (w) => { w.meta.clock.tick = '1 sec'; } },
  { id: 'S05', note: 'meta.source is not hand or worldgen', code: 'schema.invalid', pathPrefix: ['meta', 'source'], layer: 'schema', mutate: (w) => { loose(w.meta).source = 'ai'; } },
  { id: 'S06', note: 'meta.description missing', code: 'schema.invalid', pathPrefix: ['meta'], layer: 'schema', mutate: (w) => { delete loose(w.meta).description; } },
  { id: 'S07', note: 'idPrefix upper case', code: 'schema.invalid', pathPrefix: ['entities', 'ticket', 'idPrefix'], layer: 'schema', mutate: (w) => { ticket(w).idPrefix = 'TKT'; } },
  { id: 'S08', note: 'entity key not snake_case', code: 'schema.invalid', pathPrefix: ['entities'], layer: 'schema', mutate: (w) => { w.entities['BadName'] = structuredClone(at(w.entities, 'agent')); } },
  { id: 'S09', note: 'unknown field type uuid', code: 'schema.invalid', pathPrefix: ['entities', 'ticket', 'fields', 'subject'], layer: 'schema', mutate: (w) => { ticketField(w, 'subject').type = 'uuid'; } },
  { id: 'S10', note: 'money currency lower case', code: 'schema.invalid', pathPrefix: ['entities', 'ticket', 'fields', 'credit'], layer: 'schema', mutate: (w) => { ticketField(w, 'credit').currency = 'usd'; } },
  { id: 'S11', note: 'state field with one state', code: 'schema.invalid', pathPrefix: ['entities', 'ticket', 'fields', 'status'], layer: 'schema', mutate: (w) => { ticketField(w, 'status').states = ['open']; } },
  { id: 'S12', note: 'enum with no values', code: 'schema.invalid', pathPrefix: ['entities', 'ticket', 'fields', 'priority'], layer: 'schema', mutate: (w) => { ticketField(w, 'priority').values = []; } },
  { id: 'S13', note: 'list pageSize 0', code: 'schema.invalid', pathPrefix: ['routes', 'list_tickets'], layer: 'schema', mutate: (w) => { route(w, 'list_tickets').pageSize = 0; } },
  { id: 'S14', note: 'list pageSize 201', code: 'schema.invalid', pathPrefix: ['routes', 'list_tickets'], layer: 'schema', mutate: (w) => { route(w, 'list_tickets').pageSize = 201; } },
  { id: 'S15', note: 'route path without leading slash', code: 'schema.invalid', pathPrefix: ['routes', 'get_ticket'], layer: 'schema', mutate: (w) => { route(w, 'get_ticket').path = 'tickets/{id}'; } },
  { id: 'S16', note: 'method FETCH', code: 'schema.invalid', pathPrefix: ['routes', 'get_ticket'], layer: 'schema', mutate: (w) => { route(w, 'get_ticket').method = 'FETCH'; } },
  { id: 'S17', note: 'route op upsert', code: 'schema.invalid', pathPrefix: ['routes', 'get_ticket'], layer: 'schema', mutate: (w) => { route(w, 'get_ticket').op = 'upsert'; } },
  { id: 'S18', note: 'job every is not a duration', code: 'schema.invalid', pathPrefix: ['jobs', 'a'], layer: 'schema', mutate: (w) => { loose(at(w.jobs, 'a')).every = '1 hour'; } },
  { id: 'S19', note: 'task difficulty trivial', code: 'schema.invalid', pathPrefix: ['tasks', 'pend_hd1005'], layer: 'schema', mutate: (w) => { loose(at(w.tasks, 'pend_hd1005')).difficulty = 'trivial'; } },
  { id: 'S20', note: 'instruction under 20 chars', code: 'schema.invalid', pathPrefix: ['tasks', 'pend_hd1005', 'instruction'], layer: 'schema', mutate: (w) => { at(w.tasks, 'pend_hd1005').instruction = 'do it'; } },
  { id: 'S21', note: 'decoy why under 10 chars', code: 'schema.invalid', pathPrefix: ['tasks', 'pend_open_urgent', 'decoys', 0, 'why'], layer: 'schema', mutate: (w) => { const d = at(w.tasks, 'pend_open_urgent').decoys[0]; if (d) d.why = 'x'; } },
  { id: 'S22', note: 'empty grader snippet', code: 'schema.invalid', pathPrefix: ['tasks', 'pend_hd1005', 'grader'], layer: 'schema', mutate: (w) => { at(w.tasks, 'pend_hd1005').grader = ''; } },
  { id: 'S23', note: 'fixture cell is an object', code: 'schema.invalid', pathPrefix: ['fixtures'], layer: 'schema', mutate: (w) => { loose(w.fixtures).people = [{ name: { first: 'A' } }]; } },
  { id: 'S24', note: 'entities is an array', code: 'schema.invalid', pathPrefix: ['entities'], layer: 'schema', mutate: (w) => { loose(w).entities = []; } },
  { id: 'S25', note: 'world is an empty object', code: 'schema.invalid', pathPrefix: [], layer: 'schema', mutate: (w) => { for (const k of Object.keys(w)) delete loose(w)[k]; } },
];

const references: Mutation[] = [
  { id: 'R01', note: 'route entity tickt', code: 'ref.unknown', pathPrefix: ['routes', 'get_ticket'], layer: 'references', mutate: (w) => { route(w, 'get_ticket').entity = 'tickt'; } },
  { id: 'R02', note: 'ref to unknown entity person', code: 'ref.unknown', pathPrefix: ['entities', 'ticket', 'fields', 'assignee'], layer: 'references', mutate: (w) => { ticketField(w, 'assignee').entity = 'person'; } },
  { id: 'R03', note: 'list filter on unknown field', code: 'ref.unknown', pathPrefix: ['routes', 'list_tickets'], layer: 'references', mutate: (w) => { route(w, 'list_tickets').filters = ['colour']; } },
  { id: 'R04', note: 'list sort on unknown field', code: 'ref.unknown', pathPrefix: ['routes', 'list_tickets'], layer: 'references', mutate: (w) => { route(w, 'list_tickets').sort = ['nope']; } },
  { id: 'R05', note: 'list search on unknown field', code: 'ref.unknown', pathPrefix: ['routes', 'list_tickets'], layer: 'references', mutate: (w) => { route(w, 'list_tickets').search = ['body']; } },
  { id: 'R06', note: 'seed for unknown entity', code: 'ref.unknown', pathPrefix: ['seed', 'widget'], layer: 'references', mutate: (w) => { w.seed['widget'] = '(ctx) => []'; } },
  { id: 'R07', note: 'two routes with the same method and path', code: 'route.duplicate_path', pathPrefix: ['routes'], layer: 'references', mutate: (w) => { w.routes['get_ticket_again'] = structuredClone(at(w.routes, 'get_ticket')); } },
  { id: 'R08', note: 'action shadows the create route', code: 'route.duplicate_path', pathPrefix: [], layer: 'references', mutate: (w) => { at(w.actions, 'escalate').path = '/tickets'; } },
  { id: 'R09', note: 'state initial not in states', code: 'state.bad_machine', pathPrefix: ['entities', 'ticket'], layer: 'schema', mutate: (w) => { ticketField(w, 'status').initial = 'new'; } },
  { id: 'R10', note: 'transition to an undeclared state', code: 'state.bad_machine', pathPrefix: ['entities', 'ticket'], layer: 'schema', mutate: (w) => { ticketField(w, 'status').transitions = { open: ['pending', 'archived'], pending: ['open', 'closed'], closed: [] }; } },
  { id: 'R11', note: 'transition from an undeclared state', code: 'state.bad_machine', pathPrefix: ['entities', 'ticket'], layer: 'schema', mutate: (w) => { ticketField(w, 'status').transitions = { open: ['pending'], pending: ['open', 'closed'], closed: [], ghost: ['open'] }; } },
  { id: 'R12', note: 'state spam is unreachable', code: 'state.bad_machine', pathPrefix: ['entities', 'ticket'], layer: 'references', mutate: (w) => { ticketField(w, 'status').states = ['open', 'pending', 'closed', 'spam']; } },
  {
    id: 'R13', note: 'required refs in both directions', code: 'seed.cycle', pathPrefix: ['entities'], layer: 'references',
    mutate: (w) => {
      ticketField(w, 'assignee').nullable = false;
      ticketField(w, 'assignee').required = true;
      at(w.entities, 'agent').fields['home_ticket'] = field<'ref'>({ type: 'ref', entity: 'ticket', required: true, onDelete: 'restrict' });
    },
  },
  {
    id: 'R14', note: 'routes break, so later layers are skipped', code: 'layer.blocked', pathPrefix: [], layer: 'references',
    mutate: (w) => { route(w, 'get_ticket').entity = 'tickt'; },
  },
  { id: 'R15', note: 'path with an empty segment', code: 'route.bad_path', pathPrefix: ['routes', 'get_ticket'], layer: 'references', mutate: (w) => { route(w, 'get_ticket').path = '/tickets//{id}'; } },
  { id: 'R16', note: 'get route without an id param', code: 'route.missing_id_param', pathPrefix: ['routes', 'get_ticket'], layer: 'references', mutate: (w) => { route(w, 'get_ticket').path = '/tickets/one'; } },
  {
    id: 'R17', note: 'list filters on a text field', code: 'route.filter_not_filterable', pathPrefix: ['routes', 'list_tickets', 'filters'], layer: 'references',
    mutate: (w) => { ticket(w).fields['body'] = field<'text'>({ type: 'text' }); route(w, 'list_tickets').filters = ['status', 'body']; },
  },
  { id: 'R18', note: 'list cursorKey equals dataKey', code: 'api.name_collision', pathPrefix: ['meta', 'api', 'list'], layer: 'references', mutate: (w) => { loose(w.meta.api.list).cursorKey = 'data'; } },
  { id: 'R19', note: 'field named created_at', code: 'field.reserved_name', pathPrefix: ['entities', 'ticket', 'fields', 'created_at'], layer: 'references', mutate: (w) => { ticket(w).fields['created_at'] = field<'datetime'>({ type: 'datetime' }); } },
  { id: 'R20', note: "priority default 'critical' not in values", code: 'field.default_invalid', pathPrefix: ['entities', 'ticket', 'fields', 'priority'], layer: 'schema', mutate: (w) => { ticketField(w, 'priority').default = 'critical'; } },
  { id: 'R21', note: 'credit as an int with max below min (money has no max since the strict field schemas of PR #69)', code: 'field.range_inverted', pathPrefix: ['entities', 'ticket', 'fields', 'credit'], layer: 'schema', mutate: (w) => { w.entities['ticket']!.fields['credit'] = { type: 'int', min: 10, max: 5 } as never; } },
  { id: 'R22', note: 'ref_code pattern has an unclosed bracket', code: 'field.pattern_invalid', pathPrefix: ['entities', 'ticket', 'fields', 'ref_code'], layer: 'schema', mutate: (w) => { ticketField(w, 'ref_code').pattern = '^HD-[0-9'; } },
  { id: 'R23', note: 'priority lists low twice', code: 'field.values_duplicate', pathPrefix: ['entities', 'ticket', 'fields', 'priority'], layer: 'schema', mutate: (w) => { ticketField(w, 'priority').values = ['low', 'normal', 'low']; } },
  { id: 'R24', note: 'list_tickets scoped by a param that names no ref field of ticket', code: 'route.param_not_column', pathPrefix: ['routes', 'list_tickets', 'path'], layer: 'references', mutate: (w) => { route(w, 'list_tickets').path = '/queues/{queue}/tickets'; } },
  { id: 'R25', note: 'stripe list mode with a route that still declares sort fields', code: 'route.sort_ignored', pathPrefix: ['routes', 'list_tickets', 'sort'], layer: 'references', mutate: (w) => { w.meta.api.list.mode = 'stripe'; } },
  { id: 'R26', note: 'escalate rules read an unknown entity', code: 'rules.invalid', pathPrefix: ['actions', 'escalate', 'rules'], layer: 'references',
    mutate: (w) => { at(w.actions, 'escalate').rules = [{ op: 'get', entity: 'nope', id: { op: 'literal', value: 'x' }, as: 'row' }]; } },
  { id: 'R27', note: 'escalate rules with a handler that is not their lowered source', code: 'rules.handler_mismatch', pathPrefix: ['actions', 'escalate', 'handler'], layer: 'references',
    mutate: (w) => { at(w.actions, 'escalate').rules = [{ op: 'return', status: 200, body: { op: 'literal', value: null } }]; } },
];

const compile: Mutation[] = [
  { id: 'C01', note: 'handler syntax error', code: 'snippet.compile_error', pathPrefix: ['actions', 'escalate', 'handler'], layer: 'compile', mutate: (w) => { at(w.actions, 'escalate').handler = '(ctx) => { return {'; } },
  { id: 'C02', note: 'grader syntax error', code: 'snippet.compile_error', pathPrefix: ['tasks', 'pend_hd1005', 'grader'], layer: 'compile', mutate: (w) => { at(w.tasks, 'pend_hd1005').grader = '(ctx) => ctx.db.'; } },
  { id: 'C03', note: 'job is not a function', code: 'snippet.compile_error', pathPrefix: ['jobs', 'b', 'run'], layer: 'compile', accept: ['snippet.runtime_error'], mutate: (w) => { at(w.jobs, 'b').run = '42'; } },
  { id: 'C90', note: 'solution advances the clock', code: 'task.clock_control', pathPrefix: ['tasks', 'pend_hd1005', 'solution'], layer: 'compile', mutate: (w) => { at(w.tasks, 'pend_hd1005').solution = "async (ctx) => { await ctx.clock.advance('1h'); }"; } },
  { id: 'C04', note: 'seed is a statement, not an expression', code: 'snippet.compile_error', pathPrefix: ['seed', 'ticket'], layer: 'compile', mutate: (w) => { w.seed['ticket'] = 'return [];'; } },
  { id: 'C05', note: 'solution uses import', code: 'snippet.compile_error', pathPrefix: ['tasks', 'pend_hd1005', 'solution'], layer: 'compile', mutate: (w) => { at(w.tasks, 'pend_hd1005').solution = "import fs from 'node:fs'"; } },
  { id: 'C06', note: 'decoy syntax error', code: 'snippet.compile_error', pathPrefix: ['tasks', 'pend_open_urgent', 'decoys', 0], layer: 'compile', mutate: (w) => { const d = at(w.tasks, 'pend_open_urgent').decoys[0]; if (d) d.script = '(ctx) => {'; } },
  { id: 'C07', note: 'test script syntax error', code: 'snippet.compile_error', pathPrefix: ['tests', 'escalate_ok', 'script'], layer: 'compile', mutate: (w) => { at(w.tests, 'escalate_ok').script = '(ctx) => ]'; } },
];

const seedRows = (patch: string) => ticketSeed().replace('ref_code:', `${patch}\n    ref_code:`);

const seed: Mutation[] = [
  { id: 'D01', note: 'seed throws', code: 'snippet.runtime_error', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = "(ctx) => { throw new Error('seed exploded'); }"; } },
  { id: 'D02', note: 'seed calls Math.random', code: 'snippet.runtime_error', pathPrefix: ['seed', 'agent'], layer: 'seed', mutate: (w) => { w.seed['agent'] = "(ctx) => [{ name: 'R' + Math.random(), email: 'r@example.test', on_call: false }]"; } },
  { id: 'D03', note: 'seed reads Date', code: 'snippet.runtime_error', pathPrefix: ['seed', 'agent'], layer: 'seed', mutate: (w) => { w.seed['agent'] = "(ctx) => [{ name: String(Date.now()), email: 'd@example.test', on_call: false }]"; } },
  { id: 'D04', note: 'seed reads process.env', code: 'snippet.runtime_error', pathPrefix: ['seed', 'agent'], layer: 'seed', mutate: (w) => { w.seed['agent'] = "(ctx) => [{ name: String(process.env.HOME), email: 'p@example.test', on_call: false }]"; } },
  { id: 'D05', note: 'seed builds code from a string', code: 'snippet.runtime_error', pathPrefix: ['seed', 'agent'], layer: 'seed', mutate: (w) => { w.seed['agent'] = "(ctx) => [{ name: new Function('return \"x\"')(), email: 'f@example.test', on_call: false }]"; } },
  { id: 'D06', note: 'async seed', code: 'snippet.promise_returned', pathPrefix: ['seed', 'agent'], layer: 'seed', mutate: (w) => { w.seed['agent'] = 'async (ctx) => []'; } },
  { id: 'D07', note: 'seed loops on ctx.rng forever', code: 'snippet.call_quota', pathPrefix: ['seed', 'agent'], layer: 'seed', mutate: (w) => { w.seed['agent'] = '(ctx) => { for (;;) ctx.rng(); }'; } },
  { id: 'D08', note: 'seed busy-loops with no ctx calls', code: 'snippet.timeout_guard', pathPrefix: ['seed', 'agent'], layer: 'seed', slow: true, mutate: (w) => { w.seed['agent'] = '(ctx) => { for (;;) {} }'; } },
  { id: 'D90', note: 'seed allocates until the heap limit', code: 'snippet.memory', pathPrefix: ['seed', 'agent'], layer: 'seed', slow: true, mutate: (w) => { w.seed['agent'] = '(ctx) => { const a = []; for (;;) a.push(new Array(1e5).fill(a.length)); }'; } },
  { id: 'D09', note: 'seed priority not in enum', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed(SEED_STATUS, [...SEED_PRIORITY.slice(0, 10), 'critical']); } },
  { id: 'D10', note: 'seed duplicates a unique ref_code', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed().replace("'HD-' + (1001 + i)", "'HD-' + (1001 + (i === 10 ? 0 : i))"); } },
  { id: 'D11', note: 'seed refers to a missing agent', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed().replace('agents[i % agents.length].id', "'agt_9999'"); } },
  { id: 'D12', note: 'seed omits required subject', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed().replace("subject: 'Case ' + (i + 1) + ': ' + ctx.pick(topics),", 'subject: undefined,'); } },
  { id: 'D13', note: 'seed money is a float', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed().replace('ctx.int(0, 40) * 25', '12.5'); } },
  { id: 'D14', note: 'seed money is negative under min 0', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed().replace('ctx.int(0, 40) * 25', '-100'); } },
  { id: 'D15', note: 'seed state value not declared', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed([...SEED_STATUS.slice(0, 10), 'archived']); } },
  { id: 'D16', note: 'seed ref_code breaks the pattern', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed().replace("'HD-' + (1001 + i)", "'hd-' + i"); } },
  { id: 'D17', note: 'seed subject over maxLength', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = ticketSeed().replace("'Case ' + (i + 1)", "'x'.repeat(200) + (i + 1)"); } },
  { id: 'D18', note: 'seed sets an unknown field', code: 'constraint.violation', pathPrefix: ['seed', 'ticket'], layer: 'seed', mutate: (w) => { w.seed['ticket'] = seedRows("colour: 'red',"); } },
  { id: 'D19', note: 'seed returns an object, not an array', code: 'snippet.runtime_error', pathPrefix: ['seed', 'agent'], layer: 'seed', accept: ['constraint.violation', 'schema.invalid'], mutate: (w) => { w.seed['agent'] = "(ctx) => ({ name: 'A' })"; } },
];

const tests: Mutation[] = [
  { id: 'T01', note: 'test asserts false', code: 'test.failed', pathPrefix: ['tests', 'always_fails'], layer: 'tests', mutate: (w) => { w.tests['always_fails'] = { description: 'fails on purpose', script: "(ctx) => { ctx.assert(false, 'on purpose'); }" }; } },
  { id: 'T02', note: 'test expects the readonly escalated flag to be writable by PATCH', code: 'test.failed', pathPrefix: ['tests', 'patch_readonly'], layer: 'tests', mutate: (w) => { w.tests['patch_readonly'] = { description: 'wrong belief', script: "(ctx) => { const r = ctx.api('PATCH', '/tickets/tkt_0001', { escalated: true }); ctx.assert(r.status === 200, 'refused with ' + r.status); }" }; } },
  { id: 'T03', note: 'test expects open -> closed to work', code: 'test.failed', pathPrefix: ['tests', 'skip_pending'], layer: 'tests', mutate: (w) => { w.tests['skip_pending'] = { description: 'wrong belief', script: "(ctx) => { const r = ctx.api('PATCH', '/tickets/tkt_0001', { status: 'closed' }); ctx.assert(r.status === 200, 'refused with ' + r.status); }" }; } },
  { id: 'T04', note: 'test throws', code: 'test.failed', pathPrefix: ['tests', 'throws'], layer: 'tests', accept: ['snippet.runtime_error'], mutate: (w) => { w.tests['throws'] = { description: 'throws', script: "(ctx) => { throw new Error('boom'); }" }; } },
  { id: 'T05', note: 'test creates an agent with the email a seed agent already holds', code: 'test.seed_collision', pathPrefix: ['tests', 'create_ava_again'], layer: 'tests', mutate: (w) => { w.tests['create_ava_again'] = { description: 'collides with the seed', script: "(ctx) => { const r = ctx.api('POST', '/agents', { name: 'Ava Again', email: 'ava@example.test', on_call: false }); ctx.assert(r.status === 201, 'create returned ' + r.status); }" }; } },
];

const lints: Mutation[] = [
  // Not list_tickets: with every ticket on page 1, the first-page decoys score 1 and the world
  // fails at tasks. list_agents is read only by the hard solution (which pages) and by a
  // decoy that filters on_call=true (one row), so no task changes.
  // Updated in stab/paging: the lint now fires at rows <= pageSize, so 3 agents need pageSize 3.
  { id: 'L01', note: 'list_agents pageSize 3 with 3 agents', code: 'seed.too_few_rows_for_paging', pathPrefix: [], layer: 'lints', mutate: (w) => { route(w, 'list_agents').pageSize = 3; } },
  { id: 'L02', note: 'every seeded ticket open', code: 'seed.state_mix_skewed', pathPrefix: [], layer: 'lints', mutate: (w) => { w.seed['ticket'] = ticketSeed(SEED_STATUS.map(() => 'open')); } },
  { id: 'L03', note: 'no closed tickets in seed', code: 'seed.state_mix_skewed', pathPrefix: [], layer: 'lints', mutate: (w) => { w.seed['ticket'] = ticketSeed(SEED_STATUS.map((s) => (s === 'closed' ? 'pending' : s))); } },
  { id: 'L04', note: 'hard task relabelled medium', code: 'tasks.difficulty_not_spread', pathPrefix: [], layer: 'lints', accept: ['world.too_few_tasks'], mutate: (w) => { at(w.tasks, 'escalate_unassigned').difficulty = 'medium'; } },
  {
    id: 'L05', note: 'action no test or solution calls', code: 'action.unexercised', pathPrefix: [], layer: 'lints',
    mutate: (w) => {
      w.actions['reopen'] = { method: 'POST', path: '/tickets/{id}/reopen', input: {}, handler: "(ctx) => ({ status: 200, body: ctx.db.update('ticket', ctx.params.id, { status: 'open' }) })" };
    },
  },
  { id: 'L06', note: 'an agent named Lorem Ipsum', code: 'seed.lorem_text', pathPrefix: ['seed', 'agent'], layer: 'lints', mutate: (w) => { w.seed['agent'] = AGENT_SEED.replace("'Chloe Park'", "'Lorem Ipsum'"); } },
  {
    id: 'L07', note: 'an agent created after clock.start', code: 'seed.time_order', pathPrefix: ['seed', 'agent'], layer: 'lints',
    mutate: (w) => { w.seed['agent'] = AGENT_SEED.replace("on_call: false },\n  ];", "on_call: false, created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z' },\n  ];"); },
  },
  {
    id: 'L08', note: 'agent credit_total left at 0 while its tickets, line items by their quantity field (A-94), carry credit', code: 'seed.totals_mismatch', pathPrefix: ['seed', 'agent'], layer: 'lints',
    mutate: (w) => {
      at(w.entities, 'agent').fields['credit_total'] = field<'money'>({ type: 'money', currency: 'USD', min: 0, default: 0 });
      ticket(w).fields['quantity'] = field<'int'>({ type: 'int', min: 1, default: 1 });
    },
  },
  {
    id: 'L09', note: 'an easy task whose solution only reads', code: 'task.no_write', pathPrefix: ['tasks', 'lookup', 'solution'], layer: 'lints',
    mutate: (w) => {
      w.tasks['lookup'] = {
        difficulty: 'easy', instruction: 'Look at the agent list once and report how many agents there are.', decoys: [], alternatives: [],
        grader: "(ctx) => (ctx.changes().length === 0 && ctx.trace().some((c) => c.method === 'GET' && c.path.startsWith('/agents') && c.status === 200) ? 1 : 0)", solution: "(ctx) => { ctx.api('GET', '/agents'); }",
      };
    },
  },
  {
    id: 'L10', note: 'medium solution patches known ids without reading', code: 'tasks.no_read_before_write', pathPrefix: ['tasks', 'pend_open_urgent', 'solution'], layer: 'lints',
    mutate: (w) => {
      at(w.tasks, 'pend_open_urgent').solution = `(ctx) => {
  for (const id of ['tkt_0001', 'tkt_0009']) ctx.assert(ctx.api('PATCH', '/tickets/' + id, { status: 'pending' }).status === 200, 'patch ' + id);
}`;
    },
  },
  {
    id: 'L11', note: 'action requires a note its handler never reads', code: 'route.unused_required_input', pathPrefix: ['actions', 'annotate', 'input', 'note'], layer: 'lints',
    accept: ['action.unexercised'],
    mutate: (w) => {
      w.actions['annotate'] = {
        method: 'POST', path: '/tickets/{id}/annotate', input: { note: field<'text'>({ type: 'text', required: true }) },
        handler: "(ctx) => ({ status: 200, body: ctx.db.get('ticket', ctx.params.id) })",
      };
    },
  },
  {
    id: 'L12', note: 'only get and list routes, no actions or tests, and three easy read-only tasks', code: 'world.read_only', pathPrefix: ['routes'], layer: 'lints',
    accept: ['task.no_write', 'tasks.difficulty_not_spread'],
    mutate: (w) => {
      for (const [k, r] of Object.entries(w.routes)) if (r.op !== 'get' && r.op !== 'list') delete w.routes[k];
      w.actions = {};
      w.tests = {};
      const look = (n: number) => ({
        difficulty: 'easy' as const, instruction: `Read the ticket list ${n} times and report what changed between reads.`, decoys: [], alternatives: [],
        grader: `(ctx) => (ctx.trace().filter((c) => c.method === 'GET' && c.path.startsWith('/tickets') && c.status === 200).length >= ${n} ? 1 : 0)`,
        solution: `(ctx) => { for (let i = 0; i < ${n}; i++) ctx.api('GET', '/tickets'); }`,
      });
      w.tasks = { look_1: look(1), look_2: look(2), look_3: look(3) };
    },
  },
];

const tasks: Mutation[] = BAD_TASKS.map((b) => ({
  id: b.id,
  note: b.note,
  code: b.code,
  pathPrefix: b.taskId ? ['tasks', b.taskId] : [],
  layer: 'tasks',
  ...(b.accept ? { accept: b.accept } : {}),
  ...(b.todo ? { todo: b.todo } : {}),
  expect: b.expect,
  mutate: b.mutate,
}));

const deliveryEvidence: Mutation[] = [
  {
    id: 'T-private-mixed', note: 'one task stripped to its instruction while the others keep grader and solution (YOS-159)', code: 'tasks.private_mixed', pathPrefix: ['tasks'], layer: 'tasks',
    mutate: (w) => {
      const task = at(w.tasks, 'pend_hd1005');
      delete task.grader;
      delete task.solution;
      task.decoys = [];
      task.alternatives = [];
    },
  },
  { id: 'R-reserved-path', note: 'a route claims the private admin namespace', code: 'route.reserved_path', pathPrefix: ['routes', 'list_tickets', 'path'], layer: 'references', mutate: (w) => { at(w.routes, 'list_tickets').path = '/_world/tickets'; } },
  {
    id: 'GR-reference-server-error', note: 'the reference calls a crashing handler before solving the task', code: 'task.reference_server_error', pathPrefix: ['actions', 'crash', 'handler'], layer: 'tasks',
    mutate: (w) => {
      w.actions['crash'] = { method: 'POST', path: '/crash', description: 'Crashes for the reference evidence probe.', input: {}, handler: '(ctx) => { throw new Error("injected reference failure"); }' };
      const task = at(w.tasks, 'pend_hd1005');
      if (task.solution === undefined) throw new Error('GR-reference-server-error needs the private form of the world');
      task.solution = task.solution.replace('(ctx) => {', '(ctx) => { ctx.api("POST", "/crash");');
    },
  },
  {
    id: 'GR-decoy-server-error', note: 'a decoy calls a crashing handler before its near miss', code: 'task.decoy_server_error', pathPrefix: ['actions', 'crash', 'handler'], layer: 'tasks',
    mutate: (w) => {
      w.actions['crash'] = { method: 'POST', path: '/crash', description: 'Crashes for the decoy evidence probe.', input: {}, handler: '(ctx) => { throw new Error("injected decoy failure"); }' };
      const decoy = at(w.tasks, 'pend_hd1005').decoys[0];
      if (decoy === undefined) throw new Error('fixture has no easy decoy');
      decoy.script = decoy.script.replace('(ctx) => {', '(ctx) => { ctx.api("POST", "/crash");');
    },
  },
];

export const MUTATIONS: readonly Mutation[] = [...schema, ...references, ...compile, ...seed, ...tests, ...lints, ...tasks, ...deliveryEvidence];
