/**
 * Every failure and warning the system reports, in one catalog.
 *
 * Invariants:
 * - `IssueCode` is `keyof typeof ISSUES`. A code that is not in the catalog does not compile.
 * - `CheckIssue` is branded. Only `issue()` mints one (test/architecture.test.ts bans
 *   `as CheckIssue` elsewhere). Model output cannot become an issue without a catalog code.
 * - Every issue carries path, expected, found and hint, so a model can fix it without
 *   reading engine code.
 * - `owner` names the section whose stage must fix the issue. `at_path` means path[0].
 *   worldgen/policy.ts uses it to choose a backtrack target.
 */
import { z } from 'zod';
import type { Section } from './format.ts';

/** Where the issue is: a path into world.yaml, plan.yaml or the input. */
export type IssuePath = readonly [Section | 'meta' | 'format' | 'plan' | 'input', ...(string | number)[]];
export type NonEmpty<T> = readonly [T, ...T[]];
export type Severity = 'error' | 'warning';
export type IssueOwner = 'at_path' | Section | 'meta' | 'plan';

type IssueDef<P> = {
  readonly severity: Severity;
  readonly owner: IssueOwner;
  readonly expected: (p: P) => string;
  readonly hint: (p: P) => string;
};
const def =
  <P>() =>
  (d: IssueDef<P>): IssueDef<P> =>
    d;

/** The engine-built mutant kinds verifyTask runs, and what each one's task.mutant_full_marks says (A-199). */
export type MutantKind = 'target_field' | 'other_row' | 'extra_action' | 'extra_create' | 'extra_delete' | 'undone_write' | 'retarget' | 'perturb';
const MUTANT_TEXT: Readonly<Record<MutantKind, { readonly expected: string; readonly hint: (call: string) => string }>> = {
  target_field: {
    expected: 'the solution plus one collateral write scores below 1',
    hint: (call) => `The solution's calls plus ${call}, which changes a field the solution did not write on a row it wrote, still score 1. Pin the exact fields each target row may change with ctx.guardChanges.`,
  },
  other_row: {
    expected: 'the solution plus one collateral write scores below 1',
    hint: (call) => `The solution's calls plus ${call}, which changes a row the solution never touched, still score 1. Reject changes to other rows with ctx.guardChanges or a ctx.changes() check.`,
  },
  extra_action: {
    expected: 'the solution plus one collateral write scores below 1',
    hint: (call) => `The solution's calls plus ${call}, an action the solution never called, on a row it wrote, still score 1. Reject changes the task does not ask for with ctx.guardChanges.`,
  },
  extra_create: {
    expected: 'the solution plus one collateral write scores below 1',
    hint: (call) => `The solution's calls plus ${call}, which creates a row the task does not ask for, still score 1. Reject unplanned created rows with ctx.guardChanges or a ctx.changes() check.`,
  },
  extra_delete: {
    expected: 'the solution plus one collateral write scores below 1',
    hint: (call) => `The solution's calls plus ${call}, which deletes a row the solution never touched, still score 1. Reject deleted rows with ctx.guardChanges or a ctx.changes() check.`,
  },
  undone_write: {
    expected: 'the solution plus one collateral write that is then undone scores below 1',
    hint: (call) => `The solution's calls plus ${call} still score 1: an edit undone before the end leaves the end state as the solution's, and the grader judges only the end state. Declare the task's allows, or use ctx.guardChanges; both judge every write a call made, undone or not (A-387).`,
  },
  retarget: {
    expected: 'the solution with one write sent to a different row scores below 1',
    hint: (call) => `The solution's calls with ${call} still score 1: the grader accepts the work on the wrong row. Check which row changed, by id or by the instruction's own criteria.`,
  },
  perturb: {
    expected: 'the solution with one written value changed scores below 1',
    hint: (call) => `The solution's calls with ${call} still score 1: the grader accepts a wrong value. Check the exact value the instruction asks for.`,
  },
};
/** Every engine mutant kind, in catalog order. The report counts its probe cells against this, so a new kind moves it. */
export const MUTANT_KINDS: readonly MutantKind[] = Object.keys(MUTANT_TEXT).filter((k): k is MutantKind => Object.hasOwn(MUTANT_TEXT, k));

export const ISSUES = {
  // Format and references
  'schema.invalid': def<{ message: string; describe?: string | undefined }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => p.message,
    hint: (p) => `${p.describe ? `${p.describe.replace(/\.$/, '')}. ` : ''}Match the shape in prod/world-format.md.` }),
  'ref.unknown': def<{ kind: string; name: string; known: readonly string[] }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `one of the declared ${p.kind} names`, hint: (p) => `Known ${p.kind} names: ${p.known.join(', ')}.` }),
  'route.duplicate_path': def<{ method: string; path: string; other: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'a unique method and path across routes and actions', hint: (p) => `${p.method} ${p.path} is also declared by ${p.other}.` }),
  'route.bad_path': def<{ problem: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'a path like /tickets/{id}: non-empty segments, each a literal or a whole {param}', hint: (p) => p.problem }),
  'route.reserved_path': def<{ reserved: string; reason: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'a path outside /_world/... and other than /openapi.json, which serve keeps for itself',
    hint: (p) => `${p.reserved}: ${p.reason} Choose another path.` }),
  'route.missing_id_param': def<{ op: string }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `a ${p.op} route path with a {param} for the row id, such as /tickets/{id}`,
    hint: (p) => `Without a path param the ${p.op} route cannot address a row. Add {id} to the path.` }),
  'route.param_not_column': def<{ param: string; entity: string; known: readonly string[] }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `a path param that is the row id of a get, update or delete, or a ref field of ${p.entity} the operation scopes by`,
    hint: (p) => `{${p.param}} would be ignored. Only a get, update or delete path takes the row id, as {id}. Any other param must be named like a ref field of ${p.entity}, usually the one to the parent: ${p.known.join(', ')}.` }),
  'route.filter_not_filterable': def<{ entity: string; field: string; type: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'a filter on a field type that can be filtered',
    hint: (p) => `${p.entity}.${p.field} is a ${p.type} field, which lists cannot filter. Remove it from filters, or put it in search.` }),
  'route.sort_ignored': def<{ route: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'no sort fields on a list route while meta.api.list.mode is stripe',
    hint: (p) => `Stripe-mode lists are always newest first by created_at and refuse ?sort, so the sort fields of ${p.route} would be ignored. Drop the sort list, or set meta.api.list.mode to cursor.` }),
  'api.name_collision': def<{ problem: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'distinct list envelope keys and query parameter names', hint: (p) => p.problem }),
  'field.reserved_name': def<{ field: string }>()({ severity: 'error', owner: 'entities',
    expected: () => 'a field name other than id, created_at and updated_at',
    hint: (p) => `The engine assigns ${p.field} on every row. Rename the field or drop it.` }),
  'state.bad_machine': def<{ problem: string }>()({ severity: 'error', owner: 'entities',
    expected: () => 'initial in states, every transition between declared states, every state reachable', hint: (p) => p.problem }),
  'field.default_invalid': def<{ problem: string }>()({ severity: 'error', owner: 'entities',
    expected: () => 'a default the field\'s own type accepts (values, min/max, maxLength, pattern, format)', hint: (p) => `${p.problem} Change the default or the constraint.` }),
  'field.values_duplicate': def<{ problem: string }>()({ severity: 'error', owner: 'entities',
    expected: () => 'each enum value and each state listed once', hint: (p) => `${p.problem} Remove the repeated entry.` }),
  'field.range_inverted': def<{ problem: string }>()({ severity: 'error', owner: 'entities',
    expected: () => 'min less than or equal to max', hint: (p) => `${p.problem} No value can satisfy both.` }),
  'field.pattern_invalid': def<{ problem: string }>()({ severity: 'error', owner: 'entities',
    expected: () => 'a valid JavaScript regular expression', hint: (p) => `${p.problem} Fix the syntax, such as an unclosed bracket.` }),
  'seed.cycle': def<{ cycle: readonly string[]; refs: readonly string[] }>()({ severity: 'error', owner: 'entities',
    expected: () => 'refs between entities that allow a seed order',
    hint: (p) =>
      `Make one of these refs nullable (nullable: true, and not required) to break ${p.cycle.join(' -> ')}: ${p.refs.join(', ')}. ` +
      'A nullable ref may name a row of an entity seeded later by its predictable id, such as the first booking id; it must resolve once every seed has run.' }),
  // Snippets
  'snippet.compile_error': def<{ message: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'a JS function expression (ctx) => ...', hint: (p) => p.message }),
  'snippet.runtime_error': def<{ message: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'the snippet runs without throwing', hint: (p) => p.message }),
  'snippet.promise_returned': def<Record<string, never>>()({ severity: 'error', owner: 'at_path',
    expected: () => 'a synchronous function', hint: () => 'Remove async and await. Every ctx call is synchronous.' }),
  'snippet.call_quota': def<{ limit: number }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `at most ${p.limit} ctx calls per run`, hint: () => 'Look for a loop that never ends or lists inside a loop.' }),
  'snippet.memory': def<{ mb: number }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `a heap under ${p.mb} MB`, hint: (p) => `the snippet ran out of memory: its heap is limited to ${p.mb} MB` }),
  'snippet.timeout_guard': def<{ ms: number }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `uses at most ${p.ms} ms of CPU time between ctx calls`, hint: () => 'Look for a loop with no ctx calls that never ends.' }),
  'snippet.host_unavailable': def<{ ms: number }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `the snippet process starts within ${p.ms} ms`,
    hint: (p) => `This is not an error in the snippet: the machine was too busy to start the sandbox process within ${p.ms} ms. Do not change the snippet. Run the check again.` }),
  // Enforcement during seed and tests
  'constraint.violation': def<{ entity: string; field: string; rule: string }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `${p.entity}.${p.field} to satisfy ${p.rule}`, hint: () => 'The engine refused this write. Fix the value or the field definition.' }),
  'test.failed': def<{ message: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'every assert in the test passes', hint: (p) => p.message }),
  'test.seed_collision': def<{ entity: string; field: string; value: string; rowId: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'test scripts that create rows with values the seed does not use',
    hint: (p) => `The test created ${p.entity}.${p.field} ${p.value}, which seed row ${p.rowId} already holds. It collides with seed row ${p.rowId}. Change one side: seed rows must avoid values that test scripts create, and a test must create values the seed does not use, or derive them from ctx, for example by reading the seeded rows and adding a suffix.` }),
  'action.unexercised': def<{ action: string }>()({ severity: 'warning', owner: 'actions',
    expected: () => 'every action called by at least one test or solution', hint: (p) => `Remove ${p.action}, or call it from a test or a task solution.` }),
  // Tasks
  'task.clock_control': def<Record<string, never>>()({ severity: 'error', owner: 'tasks',
    expected: () => 'a solution or decoy that calls only ctx.api, ctx.assert and ctx.now',
    hint: () => 'Only world tests can call ctx.advance. A task runs as an agent would, through the public API with no clock control, so read time-dependent facts from seed.' }),
  'task.instruction_only': def<Record<string, never>>()({ severity: 'error', owner: 'tasks',
    expected: () => 'a task with its grader and solution, which only the private world holds',
    hint: () => 'This task carries only its instruction, so it is the public form of the world (YOS-159): no grader exists to run. Grade the private world, or serve this one, but never try to score it.' }),
  'task.grader_out_of_range': def<{ score: unknown }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'a number in [0, 1]', hint: () => 'Return a fraction, never NaN or a boolean.' }),
  'task.solution_not_full_marks': def<{ score: number }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'the solution scores exactly 1', hint: () => 'Either the solution misses rows (check paging) or the grader asks for more than the instruction says.' }),
  'task.reference_server_error': def<{ task: string; call: string; body: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'every call in the reference solution answers below 500',
    hint: (p) =>
      `In the reference solution of task ${p.task}, ${p.call} ${p.body}. ` +
      'A reference run must get no 5xx: make the handler succeed, or refuse bad input with ctx.fail and a 4xx status.' }),
  'task.noop_not_zero': def<{ score: number }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'doing nothing scores exactly 0', hint: () => 'The grader passes on the seed. Grade the change, not the start state.' }),
  'task.alternative_not_full_marks': def<{ why: string; score: number }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'every alternative solution scores exactly 1',
    hint: (p) => `Alternative "${p.why}" scores ${p.score}. The grader checks the path, not the outcome. Grade the end state.` }),
  'task.idle_not_zero': def<{ seconds: number; jobsFired: readonly string[] }>()({ severity: 'error', owner: 'tasks',
    expected: (p) => `doing nothing while ${p.seconds} s of engine time pass scores exactly 0`,
    hint: (p) => `Jobs ${p.jobsFired.join(', ') || '(none)'} fired and the grader passed without any agent call. Grade what the agent changed, for example with ctx.changes(), not what time or a job did.` }),
  'task.decoy_required': def<{ difficulty: string }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'at least one decoy on medium and hard tasks', hint: () => 'Add a plausible wrong solution, such as one that skips page 2.' }),
  'task.decoy_full_marks': def<{ why: string }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'every decoy scores below 1', hint: (p) => `The decoy "${p.why}" scored 1. Its script may not do what its why says (a list read right after a write often returns the row the script just created), or the grader cannot tell it apart. Check the script's calls first, then tighten the grader.` }),
  'task.decoy_trivial': def<{ why: string; reason: 'no_successful_write' | 'same_as_noop' | 'same_as_solution' }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'a decoy that writes and ends in a state unlike both noop and the solution', hint: (p) => `Decoy "${p.why}" is ${p.reason}.` }),
  'task.decoy_server_error': def<{ task: string; why: string; call: string; body: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'every call in a decoy run answers below 500',
    hint: (p) =>
      `In decoy "${p.why}" of task ${p.task}, ${p.call} ${p.body}. ` +
      'A decoy must score below 1 on its own merits, not because the server failed: make the handler succeed, or refuse bad input with ctx.fail and a 4xx status.' }),
  'task.prefix_full_marks': def<{ writes: number; of: number }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'partial work scores below 1', hint: (p) => `The first ${p.writes} of ${p.of} solution writes already score 1. The grader ignores the rest of the work.` }),
  'task.mutant_full_marks': def<{ kind: MutantKind; call: string }>()({ severity: 'error', owner: 'tasks',
    expected: (p) => MUTANT_TEXT[p.kind].expected,
    hint: (p) => MUTANT_TEXT[p.kind].hint(p.call) }),
  'task.freetext_unchecked': def<{ field: string; call: string }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'nonsense in a free-text field the solution writes scores below 1',
    hint: (p) => `The solution's calls with ${p.call} still score 1: the grader never reads ${p.field}. Check that text against what the instruction asks it to say, such as a keyword, a name or an amount the instruction gives (A-388).` }),
  'task.nondeterministic': def<{ first: string; second: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'two runs from seed end in the same state hash', hint: () => 'Something reads state the engine does not control. Report this as an engine bug if the snippet uses only ctx.' }),
  'world.too_few_tasks': def<{ have: number }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'at least 3 tasks covering easy, medium and hard', hint: (p) => `The world has ${p.have}.` }),
  'tasks.private_mixed': def<{ complete: readonly string[]; bare: readonly string[] }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'every task with its grader and solution, or every task with neither (a public bundle)',
    hint: (p) => `Complete: ${p.complete.join(', ') || 'none'}. Instruction-only: ${p.bare.join(', ') || 'none'}. Restore the missing graders and solutions, or drop them from every task and serve the public bundle.` }),
  'layer.blocked': def<{ layer: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'earlier layers pass', hint: (p) => `Not checked because the ${p.layer} layer failed. Fix those issues first.` }),
  // Quality lints
  'seed.too_few_rows_for_paging': def<{ entity: string; rows: number; pageSize: number }>()({ severity: 'warning', owner: 'seed',
    expected: (p) => `more than ${p.pageSize} ${p.entity} rows`, hint: (p) => `${p.rows} rows fit on one page. Paging never matters.` }),
  'seed.state_mix_skewed': def<{ field: string; counts: Readonly<Record<string, number>> }>()({ severity: 'warning', owner: 'seed',
    expected: () => 'every state present and none above 70% of rows', hint: (p) => `Counts for ${p.field}: ${JSON.stringify(p.counts)}.` }),
  'tasks.difficulty_not_spread': def<{ have: readonly string[] }>()({ severity: 'warning', owner: 'tasks',
    expected: () => 'easy, medium and hard', hint: (p) => `Only ${p.have.join(', ')}.` }),
  'world.read_only': def<{ routes: number }>()({ severity: 'warning', owner: 'routes',
    expected: () => 'at least one create, update or delete route, or an action', hint: (p) => `All ${p.routes} routes only read. An agent can change nothing, so no task can grade a change.` }),
  'task.no_write': def<{ calls: number }>()({ severity: 'warning', owner: 'tasks',
    expected: () => 'a solution that makes at least one successful write', hint: (p) => `The solution changed no row in ${p.calls === 1 ? 'its one call' : `${p.calls} calls`}. Grade a change to state, not a read.` }),
  'seed.time_order': def<{ entity: string; id: string; problem: string }>()({ severity: 'warning', owner: 'seed',
    expected: () => 'on every seeded row: created_at <= updated_at, past events such as created_at and placed_at at or before meta.clock.start, each end such as ends_at at or after its start, and past events in the order the state machine allows, such as paid_at before shipped_at',
    hint: (p) => `${p.entity} ${p.id}: ${p.problem}. Seeded history happens before the clock starts. Only planned times such as due_at, scheduled_for or ends_at may lie after it.` }),
  'seed.totals_mismatch': def<{ field: string; child: string; id: string; total: number; sum: number }>()({ severity: 'warning', owner: 'seed',
    expected: (p) => `${p.field} equals the sum of ${p.child} over its rows`, hint: (p) => `${p.id} has ${p.total}, its rows sum to ${p.sum}. Compute the total from the rows in the seed.` }),
  'tasks.no_read_before_write': def<Record<string, never>>()({ severity: 'warning', owner: 'tasks',
    expected: () => 'a medium or hard solution that reads before its first write',
    hint: () => 'The solution writes to ids it never looked up. An agent must discover them, so read the list or search first.' }),
  'route.unused_required_input': def<{ action: string; field: string }>()({ severity: 'warning', owner: 'actions',
    expected: () => 'a handler that reads every required input', hint: (p) => `Callers must send ${p.field}, but the handler ignores it. Use it, or drop it from input.` }),
  'seed.lorem_text': def<{ field: string; rows: number }>()({ severity: 'warning', owner: 'seed',
    expected: () => 'plausible text, never lorem ipsum', hint: (p) => `${p.rows} ${p.field} values are placeholder text. Write values the real software would hold.` }),
  // OpenAPI fidelity (a generated world against the source spec; see openapi-fidelity.ts)
  'openapi.operation_missing': def<{ method: string; path: string }>()({ severity: 'error', owner: 'routes',
    expected: (p) => `an operation ${p.method} ${p.path}, which the source spec declares`,
    hint: (p) => `Add a route or action answering ${p.method} ${p.path}. The path may name its params differently, but every segment must match.` }),
  'openapi.operation_extra': def<{ method: string; path: string }>()({ severity: 'warning', owner: 'routes',
    expected: (p) => `only operations the source spec declares under the selected paths, not ${p.method} ${p.path}`,
    hint: () => 'An extra operation is allowed when the plan adds it on purpose. Otherwise remove it, or list it in the plan assumptions.' }),
  'openapi.status_missing': def<{ op: string; status: string }>()({ severity: 'error', owner: 'routes',
    expected: (p) => `${p.op} can answer ${p.status}, as the source spec declares`,
    hint: (p) => `Make ${p.op} answer ${p.status}, for example with a route status or an action response. A 2XX or 4XX wildcard in the world covers any status of that class.` }),
  'openapi.required_field_missing': def<{ op: string; field: string }>()({ severity: 'error', owner: 'routes',
    expected: (p) => `the ${p.op} request body takes ${p.field}, which the source spec requires`,
    hint: (p) => `Add ${p.field} to the entity or action input behind ${p.op}, under the spec's name, and make it required with no default: a field with a default may be left out of a request.` }),
  'openapi.required_field_extra': def<{ op: string; field: string }>()({ severity: 'error', owner: 'routes',
    expected: (p) => `${p.op} accepts requests without ${p.field}, which the source spec does not require`,
    hint: (p) => `Make ${p.field} optional in the input behind ${p.op}. Handle missing values according to the source operation instead of adding a required field.` }),
  'openapi.field_type': def<{ op: string; where: string; field: string; type: string }>()({ severity: 'error', owner: 'routes',
    expected: (p) => `${p.where} field ${p.field} of ${p.op} has type ${p.type}, as in the source spec`,
    hint: (p) => `Change ${p.field} to a field type whose JSON type is ${p.type}.` }),
  'openapi.field_enum': def<{ op: string; where: string; field: string; values: readonly string[] }>()({ severity: 'error', owner: 'routes',
    expected: (p) => `${p.where} field ${p.field} of ${p.op} allows exactly ${p.values.join(', ')}, as in the source spec`,
    hint: (p) => `Make ${p.field} an enum or state field with the values ${p.values.join(', ')}.` }),
  'rules.invalid': def<{ problem: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'rules that name only known entities, fields, inputs, path parameters, bindings and state or enum values',
    hint: (p) => `${p.problem}. Fix the rules, or drop them and keep the JavaScript.` }),
  'rules.handler_mismatch': def<{ source: string }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `the source the rules lower to: ${p.source}`,
    hint: () => 'With rules present, the handler or run must be exactly their lowered source. Copy it from expected, or drop the rules.' }),
  // WorldGen judgments (computed by code, never by a model)
  'fidelity.below_floor': def<{ score: number; floor: number; what: string }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `the real software's ${p.what}: fidelity to the frozen reference is ${p.score}, below the floor of ${p.floor}`,
    hint: () => 'Model the real software this world names: add the missing entity, field, state or route, under its real name or a listed synonym.' }),
  'plan.not_covered': def<{ item: string }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `the planned ${p.item} exists in the world`, hint: () => 'Build what the plan says, or change the plan in the plan step.' }),
  'task.difficulty_unproven': def<{ task: string; rows: number }>()({ severity: 'error', owner: 'tasks',
    expected: () => 'a hard task whose reference solution changes more than one row or reaches a row past the first list page',
    hint: (p) => `The reference for ${p.task} changes ${p.rows} row${p.rows === 1 ? '' : 's'} and never pages. Make the task need several rows or a later page, or label it medium.` }),
  'task.pressure_unmet': def<{ task: string; need: string }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `the pressure task ${p.task} declares: ${p.need}`,
    hint: (p) => `The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for ${p.task}.` }),
  'plan.fixture_changed': def<{ entity: string; table: string; problem: string }>()({ severity: 'error', owner: 'plan',
    expected: (p) => `a plan that keeps every imported ${p.table} row and value in ${p.entity} unchanged`,
    hint: (p) => `${p.problem}. Plan rowsPerEntity for ${p.entity} as the CSV's row count, make every value of its state column a workflow state, and add generated rows only to entities with no fixture.` }),
  'plan.seed_rows_short': def<{ entity: string; planned: number; built: number }>()({ severity: 'error', owner: 'seed',
    expected: (p) => `at least the ${p.planned} ${p.entity} rows the plan promises`, hint: (p) => `The seed made ${p.built}. Seed the planned count, or change rowsPerEntity in the plan step.` }),
  'plan.state_missing': def<{ workflow: string; entity: string; state: string }>()({ severity: 'error', owner: 'entities',
    expected: (p) => `a state field of ${p.entity} that declares ${p.state}, a state of the planned workflow ${p.workflow}`,
    hint: (p) => `Add ${p.state} to the state field of ${p.entity} with a transition into it, or drop it from the workflow in the plan step.` }),
  'plan.state_field_missing': def<{ workflow: string; entity: string; states: readonly string[] }>()({ severity: 'error', owner: 'entities',
    expected: (p) => `a state field on ${p.entity} that declares the states of the planned workflow ${p.workflow}: ${p.states.join(', ')}`,
    hint: (p) => `Give ${p.entity} a field of type state with those states and transitions between them, or drop the states from the workflow in the plan step.` }),
  'plan.lifecycle_unrepresented': def<{ workflow: string; entity: string; states: readonly string[] }>()({ severity: 'error', owner: 'plan',
    expected: (p) => `every state of ${p.workflow} declared in a state field of ${p.entity}, or an explicit lifecycle representation on the workflow`,
    hint: (p) => `Declare these states in a state machine of ${p.entity}, or add lifecycle: { representation: descriptive|removal, reason } to this workflow in the plan step.` }),
  'plan.pressure_unreachable': def<{ task: string; entity: string; state: string; workflows: readonly string[] }>()({ severity: 'error', owner: 'plan',
    expected: (p) => `pressure states on ${p.task} that a state field of ${p.entity} holds`,
    hint: (p) => `${p.entity}.${p.state} belongs only to ${p.workflows.join(', ')}, whose declared lifecycle keeps it out of every state field, so no seed row can be in it. Drop ${p.entity}.${p.state} from the pressure of ${p.task}, or press a state of a workflow whose states a state field holds.` }),
  'plan.job_as_action': def<{ job: string }>()({ severity: 'error', owner: 'actions',
    expected: (p) => `the planned job ${p.job} only under jobs, with no action of that name`,
    hint: (p) => `Remove actions.${p.job} and keep jobs.${p.job}. A job runs on the clock, so a test reaches it with ctx.advance and no test calls an action of that name.` }),
  'plan.rule_unanswered': def<{ workflow: string; rule: string; by: readonly string[] }>()({ severity: 'error', owner: 'actions',
    expected: (p) => `an action or job ${p.by.join(' or ')} that enforces the ${p.workflow} rule: ${p.rule}`,
    hint: (p) => `Write ${p.by.join(' or ')} as a key in actions or jobs, or link the rule to what enforces it in the plan step.` }),
  'plan.seed_mix_off': def<{ entity: string; state: string; planned: number; built: number; within: number }>()({ severity: 'error', owner: 'seed',
    expected: (p) => `${p.planned}% of the seeded ${p.entity} rows in state ${p.state}, within ${p.within} points, as the plan's stateMix says`,
    hint: (p) => `The seed has ${p.built}%. Seed the planned share, or change stateMix in the plan step.` }),
  'edit.out_of_scope': def<{ section: string; allowed: readonly string[] }>()({ severity: 'error', owner: 'at_path',
    expected: (p) => `edits only to ${p.allowed.join(', ')}`, hint: (p) => `This stage does not own ${p.section}.` }),
  'iterate.unplanned_change': def<{ change: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'existing items unchanged unless edit.remove or plan.changes names them', hint: (p) => `Unplanned: ${p.change}. Restore it or add it to plan.changes.` }),
  'iterate.out_of_scope': def<{ item: string; request: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'every change an iterate makes traces to its change request',
    hint: (p) => `The request ${JSON.stringify(p.request)} does not ask for ${p.item}. Undo that change, or name it in plan.changes as "${p.item} because <words from the request that imply it>".` }),
  'iterate.regression': def<{ what: string }>()({ severity: 'error', owner: 'at_path',
    expected: () => 'old tests and decoys still behave the same', hint: (p) => p.what }),
} as const;

export type IssueCode = keyof typeof ISSUES;
type ParamsOf<C extends IssueCode> = (typeof ISSUES)[C] extends IssueDef<infer P> ? P : never;

declare const issueBrand: unique symbol;
export type CheckIssue = {
  readonly code: IssueCode;
  readonly severity: Severity;
  readonly path: IssuePath;
  /** Character range inside a snippet or string field, when known. */
  readonly span?: { readonly start: number; readonly end: number };
  /** The file `path` points into, such as world.yaml. Set only through `atLine`. */
  readonly file?: string;
  /** 1-based line in `file` of the node at `path`, or of its nearest ancestor in the file. Set only through `atLine`. */
  readonly line?: number;
  readonly expected: string;
  readonly found: string;
  readonly hint: string;
  readonly [issueBrand]: true;
};

/** Where an issue sits in the file it was loaded from. */
export type SourceLine = { readonly file: string; readonly line: number };

/**
 * The same issue placed at a line of its source file. Code, path and texts stay as issue()
 * minted them; this only adds where a human finds the node. The shell (loadWorld's line map)
 * calls it, because engine core never sees file text.
 */
export function atLine(i: CheckIssue, at: SourceLine): CheckIssue {
  return { ...i, file: at.file, line: at.line };
}

/** The only way to create a CheckIssue. */
export function issue<C extends IssueCode>(
  code: C,
  path: IssuePath,
  params: ParamsOf<C>,
  found: string,
  span?: { start: number; end: number },
): CheckIssue {
  const d = ISSUES[code] as IssueDef<ParamsOf<C>>;
  return {
    code,
    severity: d.severity,
    path,
    ...(span ? { span } : {}),
    expected: d.expected(params),
    found,
    hint: d.hint(params),
  } as CheckIssue;
}

/**
 * What fromZod needs to know about the parse: the schema and the value the zod paths start
 * from. Both are required, so a caller cannot silently lose `found` and the describe hint.
 */
export type ZodSource = { readonly schema: z.ZodType; readonly input: unknown };

const FOUND_MAX = 200;

/**
 * zod error to issues, with hints taken from each field's `.describe()` text.
 * Each path is `base` followed by the zod path. An empty result path becomes ['format'].
 * `found` is the offending value as JSON, from `issue.input` (zod `reportInput`) or by
 * walking `from.input`. For a bad record key (`invalid_key`) it is the key itself, and the
 * hint comes from the record's key schema.
 */
export function fromZod(error: unknown, base: IssuePath | readonly [], from: ZodSource): NonEmpty<CheckIssue> {
  const zodIssues = zodIssuesOf(error);
  if (zodIssues.length === 0) {
    const message = error instanceof Error ? error.message : String(error);
    return [issue('schema.invalid', rootPath(base, []), { message }, 'unknown')];
  }
  const out = zodIssues.map((zi) => {
    const rel = zi.path.map((k) => (typeof k === 'symbol' ? String(k) : k));
    if (zi.code === 'invalid_key' && rel.length > 0) {
      const key = rel[rel.length - 1];
      const inner = (zi.issues ?? []).map((i) => i.message).filter((m) => typeof m === 'string');
      const message = inner.length > 0 ? `${zi.message}: ${inner.join('; ')}` : zi.message;
      const describe = describeKeyAt(from.schema, rel.slice(0, -1), from.input);
      return issue('schema.invalid', rootPath(base, rel), { message, describe }, renderFound(key));
    }
    const minted = registeredIssue(zi);
    if (minted) return issue(minted.code, rootPath(base, rel), { problem: minted.problem }, minted.found ?? renderFound(valueAt(from.input, rel)));
    const describe = describeAt(from.schema, rel, from.input);
    const found = 'input' in zi ? renderFound(zi.input) : renderFound(valueAt(from.input, rel));
    return issue('schema.invalid', rootPath(base, rel), { message: zi.message, describe }, found);
  });
  return out as unknown as NonEmpty<CheckIssue>;
}

/** Codes a field definition's own refinement can raise, each taking `{ problem }`. */
export const FIELD_CONTRADICTION_CODES = ['state.bad_machine', 'field.default_invalid', 'field.range_inverted', 'field.pattern_invalid', 'field.values_duplicate'] as const;
export type FieldContradictionCode = (typeof FIELD_CONTRADICTION_CODES)[number];
const isFieldContradictionCode = (code: unknown): code is FieldContradictionCode =>
  (FIELD_CONTRADICTION_CODES as readonly unknown[]).includes(code);

/** Custom zod issues from refinements carry `params.issue`, a catalog code taking `{ problem }`. */
function registeredIssue(zi: ZodIssueLike): { code: FieldContradictionCode; problem: string; found: string | undefined } | undefined {
  const p = zi.params;
  if (zi.code !== 'custom' || p === undefined) return undefined;
  const code = p.issue;
  if (!isFieldContradictionCode(code)) return undefined;
  return { code, problem: typeof p.problem === 'string' ? p.problem : zi.message, found: typeof p.found === 'string' ? p.found : undefined };
}

type ZodIssueLike = {
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  readonly code?: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly input?: unknown;
  readonly issues?: readonly { readonly message?: unknown }[];
};

function zodIssuesOf(error: unknown): readonly ZodIssueLike[] {
  if (error instanceof z.ZodError) return error.issues;
  const issues = (error as { issues?: unknown } | null)?.issues;
  return Array.isArray(issues) ? (issues as ZodIssueLike[]) : [];
}

function rootPath(base: IssuePath | readonly [], rel: readonly (string | number)[]): IssuePath {
  const full = [...base, ...rel];
  return (full.length === 0 ? ['format'] : full) as unknown as IssuePath;
}

function renderFound(value: unknown): string {
  if (value === undefined) return 'missing';
  const s = boundedJson(value, 0, []);
  return s.length > FOUND_MAX ? `${s.slice(0, FOUND_MAX - 3)}...` : s;
}

/** JSON for `found` that never throws: cycles print as "[Circular]", nesting past 8 levels as "...". */
function boundedJson(value: unknown, depth: number, parents: readonly object[]): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
    return JSON.stringify(value) ?? String(value);
  }
  if (Object.prototype.toString.call(value) === '[object Date]') return JSON.stringify(value);
  if (parents.includes(value)) return '"[Circular]"';
  if (depth >= 8) return '"..."';
  const inner = [...parents, value];
  const parts: string[] = [];
  let used = 0;
  const entries: [string | null, unknown][] = Array.isArray(value)
    ? value.map((v): [null, unknown] => [null, v])
    : Object.keys(value).map((k): [string, unknown] => [k, (value as Record<string, unknown>)[k]]);
  for (const [k, v] of entries) {
    if (used > FOUND_MAX) { parts.push('"..."'); break; }
    if (!Array.isArray(value) && (v === undefined || typeof v === 'function')) continue;
    const part = (k === null ? '' : `${JSON.stringify(k)}:`) + (v === undefined || typeof v === 'function' ? 'null' : boundedJson(v, depth + 1, inner));
    parts.push(part);
    used += part.length;
  }
  return Array.isArray(value) ? `[${parts.join(',')}]` : `{${parts.join(',')}}`;
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let v = value;
  for (const k of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

/** Strips wrappers and returns the inner schema plus the outermost description met on the way. */
function unwrap(schema: z.ZodType): { inner: z.ZodType; description: string | undefined } {
  let s = schema;
  let description = s.description;
  for (let i = 0; i < 32; i++) {
    let next: z.ZodType | undefined;
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault ||
        s instanceof z.ZodPrefault || s instanceof z.ZodReadonly || s instanceof z.ZodNonOptional ||
        s instanceof z.ZodCatch) {
      next = s.def.innerType as z.ZodType;
    } else if (s instanceof z.ZodPipe) {
      next = s.def.in as z.ZodType;
    } else if (s instanceof z.ZodLazy) {
      next = s.def.getter() as z.ZodType;
    }
    if (!next) break;
    s = next;
    description ??= s.description;
  }
  return { inner: s, description };
}

function childOf(schema: z.ZodType, key: string | number, value: unknown): z.ZodType | undefined {
  const { inner } = unwrap(schema);
  if (inner instanceof z.ZodObject) return (inner.shape as Record<string, z.ZodType>)[String(key)];
  if (inner instanceof z.ZodRecord) return inner.def.valueType as z.ZodType;
  if (inner instanceof z.ZodArray) return inner.def.element as z.ZodType;
  if (inner instanceof z.ZodUnion) {
    const options = inner.def.options as readonly z.ZodType[];
    const disc = (inner.def as { discriminator?: string }).discriminator;
    if (disc !== undefined && value !== null && typeof value === 'object') {
      const tag = (value as Record<string, unknown>)[disc];
      for (const o of options) {
        const tagSchema = childOf(o, disc, value);
        if (tagSchema?.safeParse(tag).success) return childOf(o, key, value);
      }
    }
    for (const o of options) {
      const c = childOf(o, key, value);
      if (c) return c;
    }
  }
  return undefined;
}

/** The schema at `path`, if it can be found. */
function schemaAt(schema: z.ZodType, path: readonly (string | number)[], input: unknown): z.ZodType | undefined {
  let s: z.ZodType | undefined = schema;
  let v = input;
  for (const k of path) {
    s = childOf(s, k, v);
    if (!s) return undefined;
    v = v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined;
  }
  return s;
}

/** The `.describe()` text of the schema at `path`, if any. */
function describeAt(schema: z.ZodType, path: readonly (string | number)[], input: unknown): string | undefined {
  const s = schemaAt(schema, path, input);
  return s ? unwrap(s).description : undefined;
}

/** The `.describe()` text of the key schema of the record at `path`, if any. */
function describeKeyAt(schema: z.ZodType, path: readonly (string | number)[], input: unknown): string | undefined {
  const s = schemaAt(schema, path, input);
  if (!s) return undefined;
  const { inner } = unwrap(s);
  return inner instanceof z.ZodRecord ? unwrap(inner.def.keyType as z.ZodType).description : undefined;
}
