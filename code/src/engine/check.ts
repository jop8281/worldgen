/**
 * Whether a world is acceptable. The engine is the only judge, and this is its verdict.
 *
 * Invariants:
 * - `checkWorld` is the only minter of `CheckedWorld` (architecture test bans
 *   `as CheckedWorld` elsewhere). saveWorld, createRuntime and serve accept only
 *   CheckedWorld, so an unjudged world cannot be saved or served.
 * - Layers run in CHECK_LAYERS order. A failed layer stops later layers, and each skipped
 *   section gets one `layer.blocked` issue instead of a cascade.
 * - Warnings (quality lints) never block `ok`. WorldGen stages may still treat them as blocking.
 */
import { ADMIN_PREFIX, OPENAPI_PATH, routeParamIssues, runtime, type Runtime } from './api.ts';
import { fromIso, toIso, type Instant } from './clock.ts';
import { SnippetFault, type Snippet, type SnippetHost, type SnippetKind, type TestCtx } from './ctx.ts';
import { FIELD_TYPES, machineOf, refOf, temporalOf, type FieldKind, type Machine } from './fields.ts';
import { SECTIONS, STRIPE_MAX_LIMIT, taskSchema, worldSchema, type Section, type World } from './format.ts';
import { fromZod, issue, type CheckIssue, type IssuePath, type NonEmpty } from './issues.ts';
import { lowerRules } from './rules.ts';
import { privacySplit, taskPrivacy } from './split.ts';
import { seedState, uniqueClash, type Row, type State } from './store.ts';
import { clientCtx, recordingHost, verifyTask, type TaskVerdict } from './tasks.ts';

declare const checked: unique symbol;
export type CheckedWorld = World & { readonly [checked]: true };

export const CHECK_LAYERS = ['schema', 'references', 'compile', 'seed', 'tests', 'tasks', 'lints'] as const;
export type CheckLayer = (typeof CHECK_LAYERS)[number];

/** Facts about a checked world. Lints and WorldGen acceptance read these, never a model. */
export type WorldStats = {
  readonly rows: Readonly<Record<string, number>>;
  /** `entity.field` of each state field to counts per state. */
  readonly states: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Actions no test or solution calls. */
  readonly unexercisedActions: readonly string[];
};

export type CheckReport =
  | {
      readonly ok: true;
      readonly world: CheckedWorld;
      readonly verdicts: Readonly<Record<string, TaskVerdict>>;
      readonly stats: WorldStats;
      readonly tests: number;
      readonly warnings: readonly CheckIssue[];
    }
  | {
      readonly ok: false;
      readonly reached: CheckLayer;
      readonly issues: NonEmpty<CheckIssue>;
      readonly warnings: readonly CheckIssue[];
      /** The rows the seed produced, per entity, when the seed layer passed and a later layer failed. Absent otherwise. */
      readonly seeded?: Readonly<Record<string, readonly Row[]>>;
      /** Row and state counts of `seeded`, present exactly when it is. */
      readonly stats?: Pick<WorldStats, 'rows' | 'states'>;
    };

/**
 * The sections each layer reads. When a layer fails, every non-empty section that a later
 * layer would read, and that has no issue yet, gets one `layer.blocked`.
 */
const LAYER_SECTIONS: { readonly [L in CheckLayer]: readonly Section[] } = {
  schema: SECTIONS,
  references: ['entities', 'routes', 'actions', 'seed'],
  compile: ['actions', 'jobs', 'seed', 'tests', 'tasks'],
  seed: ['seed'],
  tests: ['tests'],
  tasks: ['tasks'],
  lints: [],
};

/** Engine-maintained fields every row has. Lists may filter, search and sort on them. */
const IMPLICIT_FIELDS = ['id', 'created_at', 'updated_at'] as const;
/** Query parameters every list may read besides meta.api.list's paging params. */
const LIST_QUERY_PARAMS = ['q', 'sort'] as const;
/** Field types a list can filter on: some valid example of the type parses as a query value. */
const FILTERABLE: ReadonlySet<string> = new Set(
  Object.values(FIELD_TYPES)
    .filter((k) => {
      // One cast, because TS cannot correlate a kind's schema with its own parseQuery (as in api.ts).
      const kind = k as unknown as FieldKind<string, unknown>;
      const def = kind.schema.safeParse(kind.examples.def);
      return def.success && kind.examples.valid.some((v) => kind.parseQuery(String(v), def.data).ok);
    })
    .map((k) => k.type),
);
/** Longest snippet excerpt kept in `found`. */
const FOUND_MAX = 200;
/** The largest share of a state field's rows one state may hold: 7/10, so above 70% is skewed. */
const STATE_SHARE_MAX = { num: 7, den: 10 } as const;
/** Fewest tasks a finished world may have. */
const MIN_TASKS = 3;
/** Every difficulty, in format order. A world's tasks should cover all of them. */
const DIFFICULTIES = taskSchema.shape.difficulty.options;
/** A name word that marks a past event: a regular past participle or a common irregular one, as in placed_at or paid_at. */
const PAST_WORD = /^(?:[a-z]+ed|paid|sent|sold|held|won|lost|built|made|done|spent|begun|read|seen)$/;
/** Name words that mark a planned time even beside a participle, as in scheduled_for, expected_at or approved_by. */
const PLAN_WORDS: ReadonlySet<string> = new Set(['scheduled', 'expected', 'planned', 'estimated', 'projected', 'promised', 'due', 'next', 'for', 'by', 'until']);
/** The name word of an end time for each start word, so starts_at pairs with ends_at and period_start with period_end. */
const END_WORD: Readonly<Record<string, string>> = { start: 'end', starts: 'ends' };
/** Placeholder text a seed should never hold. */
const LOREM = /\b(lorem|ipsum)\b/i;
/** Field types that hold prose, so the lorem lint reads them. */
const TEXT_TYPES: ReadonlySet<string> = new Set(['string', 'text']);
/** Field types a total and its parts may have. */
const NUMERIC_TYPES: ReadonlySet<string> = new Set(['int', 'number', 'money']);

/**
 * What one check() run carries between layers. `exercised` holds every action whose handler ran
 * during a test or a task's reference solution. A call refused by routing or input validation does
 * not count, and neither do decoy runs. The tasks layer also adds its verdicts.
 */
type Run = { seeded: State | null; tests: number; exercised: Set<string>; verdicts: Record<string, TaskVerdict> };
type Layer = (world: World, host: SnippetHost, run: Run) => readonly CheckIssue[];

const LAYERS: { readonly [L in Exclude<CheckLayer, 'schema'>]: Layer } = {
  references,
  compile,
  seed,
  tests,
  tasks,
  lints,
};

/** Total: never throws on a bad world. `input` is untrusted (parsed YAML or an applied edit). */
export function check(input: unknown, host: SnippetHost): CheckReport {
  const parsed = parseWorld(input);
  if (!parsed.ok) return failure('schema', parsed.issues, [], input);
  const world = parsed.world;
  const warnings: CheckIssue[] = [];
  const run: Run = { seeded: null, tests: 0, exercised: new Set(), verdicts: {} };
  const memo = memoHost(host);
  for (const layer of CHECK_LAYERS) {
    if (layer === 'schema') continue;
    const found = LAYERS[layer](world, memo, run);
    warnings.push(...found.filter((i) => i.severity === 'warning'));
    const [first, ...rest] = found.filter((i) => i.severity === 'error');
    if (first) {
      if (layer === 'tasks') {
        warnings.push(...stateLints(world, run.seeded));
        // Only when every present task verified is run.exercised complete; a failed solution's calls are unknown.
        if ([first, ...rest].every((i) => i.code === 'world.too_few_tasks')) warnings.push(...unexercisedLints(world, run).issues);
      }
      const failed = failure(layer, [first, ...rest], warnings, world);
      if (run.seeded === null || failed.ok) return failed;
      const seeded = run.seeded;
      return {
        ...failed,
        seeded: Object.fromEntries(Object.keys(world.entities).map((en) => [en, [...(seeded.tables[en]?.values() ?? [])]])),
        stats: seedStats(world, seeded),
      };
    }
  }
  const { actions: unexercisedActions, issues: unexercised } = unexercisedLints(world, run);
  warnings.push(...unexercised);
  return {
    ok: true,
    world: world as CheckedWorld,
    verdicts: run.verdicts,
    stats: { ...seedStats(world, run.seeded), unexercisedActions },
    tests: run.tests,
    warnings,
  };
}

/**
 * The actions no test or verified solution ran. check() mints these on an ok report and on a tasks
 * failure that is only world.too_few_tasks, so WorldGen's workflow stage, which holds 0 tasks, sees them.
 */
function unexercisedLints(world: World, run: Run): { actions: string[]; issues: CheckIssue[] } {
  const actions = Object.keys(world.actions).filter((a) => !run.exercised.has(a));
  return { actions, issues: actions.map((action) => issue('action.unexercised', ['actions', action], { action }, 'no test calls it')) };
}

/** Compiles each (kind, path, source) once per check, so later layers reuse the compile layer's result. */
function memoHost(host: SnippetHost): SnippetHost {
  type Compiled<K extends SnippetKind> = { ok: true; run: Snippet<K> } | { ok: false; issue: CheckIssue };
  const caches: { [K in SnippetKind]: Map<string, Compiled<K>> } = {
    handler: new Map(), job: new Map(), seed: new Map(), grader: new Map(), client: new Map(), test: new Map(),
  };
  return {
    compile<K extends SnippetKind>(kind: K, source: string, path: IssuePath): Compiled<K> {
      const cache: { [J in SnippetKind]: Map<string, Compiled<J>> }[K] = caches[kind];
      const key = JSON.stringify([path, source]);
      const hit = cache.get(key);
      if (hit) return hit;
      const r = host.compile(kind, source, path);
      cache.set(key, r);
      return r;
    },
  };
}

function parseWorld(input: unknown): { ok: true; world: World } | { ok: false; issues: NonEmpty<CheckIssue> } {
  const from = { schema: worldSchema, input };
  try {
    const [shape, ...more] = inputShapeIssues(input);
    if (shape) return { ok: false, issues: [shape, ...more] };
    const result = worldSchema.safeParse(input);
    return result.success ? { ok: true, world: result.data } : { ok: false, issues: fromZod(result.error, [], from) };
  } catch (e) {
    // A getter or proxy in the input threw. fromZod on a non-zod error does not read the input.
    return { ok: false, issues: fromZod(e, [], from) };
  }
}

/** How deep a world's input may nest. The deepest real world value, a JSON error template, is far shallower. */
const MAX_INPUT_DEPTH = 64;

/**
 * Input shapes zod cannot judge, found before it parses (A-192, A-194): an own `__proto__` key, which
 * zod records drop without an issue, so a world could name an entity `__proto__` and have it vanish;
 * and a value nested deeper than MAX_INPUT_DEPTH, which would overflow zod's stack and be reported at
 * ['format'] instead of at the deep value. Walks each object and array once.
 */
const isRoot = (key: string): key is Section | 'meta' => key === 'meta' || (SECTIONS as readonly string[]).includes(key);

function inputShapeIssues(input: unknown): CheckIssue[] {
  const out: CheckIssue[] = [];
  const seen = new Set<object>();
  const rooted = (path: readonly (string | number)[]): IssuePath => {
    const [first, ...rest] = path;
    return typeof first === 'string' && isRoot(first) ? [first, ...rest] : ['format', ...path];
  };
  const walk = (value: unknown, path: (string | number)[]): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (path.length >= MAX_INPUT_DEPTH) {
      out.push(issue('schema.invalid', rooted(path), { message: `a value nested more than ${MAX_INPUT_DEPTH} levels deep` }, `deeper than ${MAX_INPUT_DEPTH} levels`));
      return;
    }
    if (!Array.isArray(value) && Object.hasOwn(value, '__proto__')) {
      out.push(issue('schema.invalid', rooted([...path, '__proto__']), { message: 'a key named __proto__ is not allowed' }, '"__proto__"'));
    }
    for (const [k, v] of Object.entries(value)) walk(v, [...path, Array.isArray(value) ? Number(k) : k]);
  };
  walk(input, []);
  return out;
}

function failure(layer: CheckLayer, issues: NonEmpty<CheckIssue>, warnings: readonly CheckIssue[], source: unknown): CheckReport {
  const hit = new Set<unknown>(issues.map((i) => i.path[0]));
  const later = CHECK_LAYERS.slice(CHECK_LAYERS.indexOf(layer) + 1);
  const blocked: CheckIssue[] = [];
  for (const section of SECTIONS) {
    if (hit.has(section) || !hasItems(source, section)) continue;
    const skipped = later.filter((l) => LAYER_SECTIONS[l].includes(section));
    if (skipped.length > 0) blocked.push(issue('layer.blocked', [section], { layer }, `skipped layers: ${skipped.join(', ')}`));
  }
  const [first, ...rest] = issues;
  return { ok: false, reached: layer, issues: [first, ...rest, ...blocked], warnings };
}

/** Whether `source[section]` is an object with at least one key. Never throws. */
function hasItems(source: unknown, section: Section): boolean {
  try {
    if (source === null || typeof source !== 'object') return false;
    const value: unknown = (source as Record<string, unknown>)[section];
    return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  } catch {
    return false;
  }
}

const show = (value: string): string => JSON.stringify(value);
/** `1 row`, `12 rows`. */
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- references

function references(world: World): CheckIssue[] {
  const out: CheckIssue[] = [];
  const entities = new Map(Object.entries(world.entities));
  const entityNames = [...entities.keys()];
  const unknownEntity = (path: IssuePath, name: string): CheckIssue =>
    issue('ref.unknown', path, { kind: 'entity', name, known: entityNames }, show(name));

  for (const [en, entity] of entities) {
    for (const [fn, def] of Object.entries(entity.fields)) {
      if ((IMPLICIT_FIELDS as readonly string[]).includes(fn)) out.push(issue('field.reserved_name', ['entities', en, 'fields', fn], { field: fn }, show(fn)));
      const ref = refOf(def);
      if (ref && !entities.has(ref.entity)) out.push(unknownEntity(['entities', en, 'fields', fn, 'entity'], ref.entity));
      const machine = machineOf(def);
      if (machine) out.push(...stateMachine(en, fn, machine));
    }
  }
  out.push(...seedCycles(world));

  for (const [rn, route] of Object.entries(world.routes)) {
    const entity = entities.get(route.entity);
    if (!entity) {
      out.push(unknownEntity(['routes', rn, 'entity'], route.entity));
      continue;
    }
    if (route.op !== 'list') continue;
    const fields = [...Object.keys(entity.fields), ...IMPLICIT_FIELDS];
    const kind = `${route.entity} field`;
    for (const list of ['filters', 'search', 'sort'] as const) {
      route[list].forEach((name, i) => {
        if (!fields.includes(name)) out.push(issue('ref.unknown', ['routes', rn, list, i], { kind, name, known: fields }, show(name)));
      });
    }
    if (world.meta.api.list.mode === 'stripe' && route.sort.length > 0) {
      out.push(issue('route.sort_ignored', ['routes', rn, 'sort'], { route: rn }, JSON.stringify(route.sort)));
    }
    route.filters.forEach((name, i) => {
      const def = Object.hasOwn(entity.fields, name) ? entity.fields[name] : undefined;
      if (def && !FILTERABLE.has(def.type)) {
        out.push(issue('route.filter_not_filterable', ['routes', rn, 'filters', i], { entity: route.entity, field: name, type: def.type }, show(name)));
      }
      const problem = filterCollision(world, name);
      if (problem) out.push(issue('api.name_collision', ['routes', rn, 'filters', i], { problem }, show(name)));
    });
  }
  for (const [an, action] of Object.entries(world.actions)) {
    for (const [fn, def] of Object.entries(action.input)) {
      const ref = refOf(def);
      if (ref && !entities.has(ref.entity)) out.push(unknownEntity(['actions', an, 'input', fn, 'entity'], ref.entity));
    }
  }
  for (const name of Object.keys(world.seed)) {
    if (!entities.has(name)) out.push(unknownEntity(['seed', name], name));
  }
  for (const [tn, task] of Object.entries(world.tasks)) {
    (task.allows ?? []).forEach((allowance, i) => {
      const entity = entities.get(allowance.entity);
      if (!entity) {
        out.push(unknownEntity(['tasks', tn, 'allows', i, 'entity'], allowance.entity));
        return;
      }
      const fields = Object.keys(entity.fields);
      allowance.fields.forEach((name, j) => {
        if (!fields.includes(name)) out.push(issue('ref.unknown', ['tasks', tn, 'allows', i, 'fields', j], { kind: `${allowance.entity} field`, name, known: fields }, show(name)));
      });
      for (const name of Object.keys(allowance.where ?? {})) {
        if (!fields.includes(name)) out.push(issue('ref.unknown', ['tasks', tn, 'allows', i, 'where', name], { kind: `${allowance.entity} field`, name, known: fields }, show(name)));
      }
    });
  }
  out.push(...paths(world), ...routeParamIssues(world), ...apiCollisions(world), ...rulesIssues(world));
  return out;
}

/**
 * Each action or job with `rules` (A-167): the rules must lower, and the handler or run must be
 * exactly the lowered source, so the snippet the engine runs and the rules a reader sees agree.
 */
function rulesIssues(world: World): CheckIssue[] {
  const slots = [
    ...Object.entries(world.actions).map(([key, a]) => ({ path: ['actions', key] as const, rules: a.rules, code: a.handler, codeKey: 'handler', action: key })),
    ...Object.entries(world.jobs).map(([key, j]) => ({ path: ['jobs', key] as const, rules: j.rules, code: j.run, codeKey: 'run', action: null })),
  ];
  return slots.flatMap(({ path, rules, code, codeKey, action }): CheckIssue[] => {
    if (rules === undefined) return [];
    const lowered = lowerRules(world, rules, action);
    if (!lowered.ok) return [issue('rules.invalid', [...path, 'rules'], { problem: lowered.problem }, lowered.problem)];
    return code === lowered.source ? [] : [issue('rules.handler_mismatch', [...path, codeKey], { source: lowered.source }, `a ${codeKey} that differs from the lowered rules`)];
  });
}

/** Active paging query parameters for this world's list contract. */
function listPagingParams(world: World): readonly (readonly [string, string])[] {
  const shape = world.meta.api.list;
  return shape.mode === 'stripe'
    ? [['limitParam', shape.limitParam], ['startingAfterParam', shape.startingAfterParam], ['endingBeforeParam', shape.endingBeforeParam]]
    : [['limitParam', shape.limitParam], ['cursorParam', shape.cursorParam]];
}

/** Why a list filter named `name` clashes with a query parameter every list reads, or null. */
function filterCollision(world: World, name: string): string | null {
  for (const [key, value] of listPagingParams(world)) {
    if (name === value) return `filter ${show(name)} is also the ${key}. Drop the filter or rename meta.api.list.${key}.`;
  }
  for (const param of LIST_QUERY_PARAMS) {
    if (name === param) return `filter ${show(name)} is also the ${param} query parameter. Drop the filter.`;
  }
  return null;
}

/** meta.api.list: active response keys and paging params stay distinct and do not shadow q or sort. */
function apiCollisions(world: World): CheckIssue[] {
  const out: CheckIssue[] = [];
  const shape = world.meta.api.list;
  const at = (key: string, value: string, problem: string): void => {
    out.push(issue('api.name_collision', ['meta', 'api', 'list', key], { problem }, show(value)));
  };
  if (shape.mode === 'stripe') {
    if (shape.hasMoreKey === shape.dataKey) {
      at('hasMoreKey', shape.hasMoreKey, `hasMoreKey ${show(shape.hasMoreKey)} is also the dataKey, so has_more overwrites the page. Rename one.`);
    }
  } else if (shape.cursorKey === shape.dataKey) {
    at('cursorKey', shape.cursorKey, `cursorKey ${show(shape.cursorKey)} is also the dataKey, so the cursor overwrites the page. Rename one.`);
  }
  const params = listPagingParams(world);
  for (let i = 0; i < params.length; i++) {
    const [key, value] = params[i]!;
    for (let j = 0; j < i; j++) {
      const [otherKey, otherValue] = params[j]!;
      if (value === otherValue) at(key, value, `${key} ${show(value)} is also the ${otherKey}. Rename one.`);
    }
    for (const param of LIST_QUERY_PARAMS) {
      if (value === param) at(key, value, `${key} ${show(value)} is also the ${param} query parameter. Rename it.`);
    }
  }
  return out;
}


/** Initial in states, every transition between declared states, every state reachable from initial. */
function stateMachine(entity: string, field: string, def: Machine): CheckIssue[] {
  const out: CheckIssue[] = [];
  const declared = new Set(def.states);
  const list = def.states.join(', ');
  const bad = (path: IssuePath, problem: string, found: string): void => {
    out.push(issue('state.bad_machine', path, { problem }, found));
  };
  if (!declared.has(def.initial)) {
    bad(['entities', entity, 'fields', field, 'initial'], `initial ${show(def.initial)} is not one of the states ${list}.`, show(def.initial));
  }
  const moves = new Map<string, readonly string[]>();
  for (const [from, tos] of Object.entries(def.transitions)) {
    if (!declared.has(from)) {
      bad(['entities', entity, 'fields', field, 'transitions', from], `transitions from ${show(from)}, which is not one of the states ${list}.`, show(from));
      continue;
    }
    moves.set(from, tos);
    tos.forEach((to, i) => {
      if (!declared.has(to)) {
        bad(['entities', entity, 'fields', field, 'transitions', from, i],
          `transition ${from} -> ${to} goes to ${show(to)}, which is not one of the states ${list}.`, show(to));
      }
    });
  }
  if (!declared.has(def.initial)) return out;
  const reached = new Set([def.initial]);
  const queue = [def.initial];
  for (let i = 0; i < queue.length; i++) {
    for (const to of moves.get(queue[i] ?? '') ?? []) {
      if (declared.has(to) && !reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }
  def.states.forEach((s, i) => {
    if (!reached.has(s)) {
      bad(['entities', entity, 'fields', field, 'states', i], `state ${show(s)} cannot be reached from initial ${show(def.initial)}. Add a transition into it.`, show(s));
    }
  });
  return out;
}

type RefEdge = { readonly from: string; readonly to: string; readonly field: string };

/**
 * One `seed.cycle` per strongly connected group of entities joined by refs that cannot be
 * null (not nullable, or required). Such a group has no seed order. Self-refs count.
 */
function seedCycles(world: World): CheckIssue[] {
  const names = Object.keys(world.entities);
  const edges = new Map<string, RefEdge[]>(names.map((n) => [n, []]));
  for (const [from, entity] of Object.entries(world.entities)) {
    for (const [field, def] of Object.entries(entity.fields)) {
      const ref = refOf(def);
      if (!ref || !edges.has(ref.entity) || (def.nullable && !def.required)) continue;
      edges.get(from)?.push({ from, to: ref.entity, field });
    }
  }
  const out = (n: string): readonly RefEdge[] => edges.get(n) ?? [];
  const reverse = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const [from, refs] of edges) {
    for (const ref of refs) reverse.get(ref.to)?.push(from);
  }
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const start of names) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [{ name: start, refs: out(start)[Symbol.iterator]() }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const next = frame.refs.next();
      if (next.done) {
        finished.push(frame.name);
        stack.pop();
      } else if (!visited.has(next.value.to)) {
        visited.add(next.value.to);
        stack.push({ name: next.value.to, refs: out(next.value.to)[Symbol.iterator]() });
      }
    }
  }
  const components = new Map<string, Set<string>>();
  for (const start of finished.reverse()) {
    if (components.has(start)) continue;
    const group = new Set([start]);
    components.set(start, group);
    const queue = [start];
    for (const name of queue) {
      for (const previous of reverse.get(name) ?? []) {
        if (components.has(previous)) continue;
        components.set(previous, group);
        group.add(previous);
        queue.push(previous);
      }
    }
  }
  const grouped = new Set<Set<string>>();
  const issues: CheckIssue[] = [];
  for (const v of names) {
    const group = components.get(v);
    if (!group || grouped.has(group)) continue;
    grouped.add(group);
    if (group.size === 1 && !out(v).some((e) => e.to === v)) continue;
    const cycle = cycleThrough(v, group, out);
    const first = cycle[0];
    if (!first) continue;
    const path = [v, ...cycle.map((e) => e.to)];
    issues.push(issue('seed.cycle', ['entities', v, 'fields', first.field], { cycle: path, refs: cycle.map((e) => `${e.from}.${e.field}`) }, path.join(' -> ')));
  }
  return issues;
}

/** The shortest ref path from `v` back to itself inside `group`, edges in declaration order. */
function cycleThrough(v: string, group: ReadonlySet<string>, out: (n: string) => readonly RefEdge[]): RefEdge[] {
  const prev = new Map<string, RefEdge>();
  const queue = [v];
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i] ?? '';
    for (const e of out(u)) {
      if (!group.has(e.to)) continue;
      if (e.to === v) {
        const path = [e];
        for (let p = prev.get(u); p; p = prev.get(p.from)) path.unshift(p);
        return path;
      }
      if (!prev.has(e.to)) {
        prev.set(e.to, e);
        queue.push(e.to);
      }
    }
  }
  return [];
}

/** A whole-segment path param, as the router in api.ts reads it. */
const PARAM_RE = /^\{([^{}]+)\}$/;

/** The key route.duplicate_path compares: method plus path with every `{param}` segment blanked. Routes and actions share one key space. */
export function routeKey(method: string, path: string): string {
  return `${method} /${splitSegments(path).map((s) => (PARAM_RE.test(s) ? '{}' : s)).join('/')}`;
}
/** The router's path normalization in api.ts: empty segments dropped, so a trailing slash is ignored. */
const splitSegments = (path: string): string[] => path.split('/').filter((s) => s !== '');

/** Why `path` is not a template the router can match as written, or null. A trailing slash is fine. */
function pathProblem(path: string): string | null {
  const parts = path.split('/').slice(1);
  const params = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i] ?? '';
    if (s === '') {
      if (i === parts.length - 1) continue;
      return 'empty segment between two slashes.';
    }
    if (/[\s?#]/.test(s)) return `segment ${show(s)} contains a space, ?, or #.`;
    if (!s.includes('{') && !s.includes('}')) continue;
    const name = PARAM_RE.exec(s)?.[1];
    if (name === undefined) return `segment ${show(s)} is not a literal or a whole {param}.`;
    if (params.has(name)) return `param {${name}} appears twice.`;
    params.add(name);
  }
  return null;
}

/**
 * Why serve keeps the path with these segments for itself, whatever the method, or null. On the
 * world port http.ts answers every path under /_world with 404, and GET /openapi.json with the
 * world's OpenAPI document, before any route.
 */
function reservedBy(segments: readonly string[]): { reserved: string; reason: string } | null {
  if (segments[0] === ADMIN_PREFIX) {
    return { reserved: `/${ADMIN_PREFIX}/...`, reason: 'serve answers every path under it with 404 on the world port, so this would never be reached over HTTP.' };
  }
  if (segments.length === 1 && segments[0] === OPENAPI_PATH) {
    return { reserved: `/${OPENAPI_PATH}`, reason: "serve answers GET there with the world's OpenAPI document, which agents read to discover the API." };
  }
  return null;
}

/**
 * Per route and action: a well-formed path template outside the paths serve keeps for itself, a
 * row-id param on get, update and delete, and a unique method plus normalized path (param names
 * dropped, so /t/{id} and /t/{ticket_id} collide, and so do /t and /t/).
 */
function paths(world: World): CheckIssue[] {
  const out: CheckIssue[] = [];
  const seen = new Map<string, string>();
  const all: [Section, string, { readonly method: string; readonly path: string; readonly op?: string }][] = [
    ...Object.entries(world.routes).map(([n, r]): [Section, string, typeof r] => ['routes', n, r]),
    ...Object.entries(world.actions).map(([n, a]): [Section, string, typeof a] => ['actions', n, a]),
  ];
  for (const [section, name, { method, path, op }] of all) {
    const at: IssuePath = [section, name, 'path'];
    const problem = pathProblem(path);
    if (problem !== null) {
      out.push(issue('route.bad_path', at, { problem }, show(path)));
      continue;
    }
    const reserved = reservedBy(splitSegments(path));
    if (reserved !== null) {
      out.push(issue('route.reserved_path', at, reserved, show(path)));
      continue;
    }
    const segments = splitSegments(path).map((s) => (PARAM_RE.test(s) ? '{}' : s));
    if ((op === 'get' || op === 'update' || op === 'delete') && !segments.includes('{}')) {
      out.push(issue('route.missing_id_param', at, { op }, show(path)));
    }
    const key = routeKey(method, path);
    const other = seen.get(key);
    if (other === undefined) seen.set(key, `${section}.${name}`);
    else out.push(issue('route.duplicate_path', at, { method, path, other }, `${method} ${path}`));
  }
  return out;
}

// ---------------------------------------------------------------- compile

/** Every snippet in the world, compiled through the host. The host's issue carries the exact path. */
function compile(world: World, host: SnippetHost): CheckIssue[] {
  const out: CheckIssue[] = [];
  const one = (kind: SnippetKind, source: string, path: IssuePath): void => {
    try {
      const r = host.compile(kind, source, path);
      if (!r.ok) out.push(r.issue);
    } catch (e) {
      out.push(issue('snippet.compile_error', path, { message: e instanceof Error ? e.message : String(e) }, clip(source)));
    }
  };
  for (const [n, a] of Object.entries(world.actions)) one('handler', a.handler, ['actions', n, 'handler']);
  for (const [n, j] of Object.entries(world.jobs)) one('job', j.run, ['jobs', n, 'run']);
  for (const [n, s] of Object.entries(world.seed)) one('seed', s, ['seed', n]);
  // A task script that moves time gets a clear issue here, not a bare TypeError at run time.
  const task = (source: string, path: IssuePath): void => {
    if (MOVES_TIME.test(source)) out.push(issue('task.clock_control', path, {}, clip(source)));
    else one('client', source, path);
  };
  for (const [n, t] of Object.entries(world.tests)) one('test', t.script, ['tests', n, 'script']);
  // A bare task (the public form, YOS-159) has no task script to compile; the tasks layer judges privacy.
  for (const [n, t] of Object.entries(world.tasks)) {
    if (t.grader !== undefined) one('grader', t.grader, ['tasks', n, 'grader']);
    if (t.solution !== undefined) task(t.solution, ['tasks', n, 'solution']);
    t.decoys.forEach((d, i) => task(d.script, ['tasks', n, 'decoys', i, 'script']));
  }
  return out;
}

/** A call to `.advance(`: only a test ctx has it, and a client script has no other object that does. */
const MOVES_TIME = /\.\s*advance\s*\(/;
const clip = (source: string): string => (source.length > FOUND_MAX ? `${source.slice(0, FOUND_MAX - 3)}...` : source);

// ---------------------------------------------------------------- seed

/** Runs the seed snippets. The seeded state feeds stats and later layers. */
function seed(world: World, host: SnippetHost, run: Run): CheckIssue[] {
  const r = seedState(world, host);
  if (!r.ok) return [r.issue];
  run.seeded = r.state;
  return [];
}

/** Rows per entity and, for each state field, rows per declared state. Zero counts included. */
function seedStats(world: World, state: State | null): Pick<WorldStats, 'rows' | 'states'> {
  const rows: Record<string, number> = {};
  const states: Record<string, Record<string, number>> = {};
  for (const [en, entity] of Object.entries(world.entities)) {
    const table = [...(state?.tables[en]?.values() ?? [])];
    rows[en] = table.length;
    for (const [fn, def] of Object.entries(entity.fields)) {
      const machine = machineOf(def);
      if (!machine) continue;
      const counts: Record<string, number> = Object.fromEntries(machine.states.map((s) => [s, 0]));
      for (const row of table) {
        const v = String(row[fn]);
        if (Object.hasOwn(counts, v)) counts[v] = (counts[v] ?? 0) + 1;
      }
      states[`${en}.${fn}`] = counts;
    }
  }
  return { rows, states };
}

// ---------------------------------------------------------------- tests

/** A ClientCtx plus `advance`, which moves engine time exactly as POST /_world/clock does. */
function testCtx(rt: Runtime): { ctx: TestCtx; failed: () => string | null } {
  const { ctx, failed } = clientCtx(rt);
  const advance: TestCtx['advance'] = (by) => {
    if (typeof by !== 'string') throw new Error(`ctx.advance takes a duration such as '15m' or '4h', got ${JSON.stringify(by) ?? String(by)}`);
    return rt.advance(by);
  };
  return { ctx: { ...ctx, advance }, failed };
}

/** The first call of the test just run that the engine refused with field.unique against a row the seed created, or null. */
function seedCollision(rt: Runtime, seedIds: ReadonlySet<string>): { entity: string; field: string; value: string; rowId: string } | null {
  for (const call of rt.log()) {
    const body = call.res.body as { error?: { code?: unknown; message?: unknown } } | null;
    if (call.res.status !== 409 || body?.error?.code !== 'field.unique' || typeof body.error.message !== 'string') continue;
    const clash = uniqueClash.parse(body.error.message);
    if (clash !== null && seedIds.has(clash.rowId)) return clash;
  }
  return null;
}

/**
 * Runs every world test, each from a fresh seeded runtime, in declaration order. Each failing
 * test gives one issue at ['tests', name, 'script']: test.seed_collision when a create was refused for a value a
 * seed row holds, test.failed for any other assert, the sandbox's
 * own issue for a SnippetFault, snippet.runtime_error for anything else.
 */
function tests(world: World, host: SnippetHost, run: Run): CheckIssue[] {
  const entries = Object.entries(world.tests);
  if (entries.length === 0) return [];
  const out: CheckIssue[] = [];
  let rt: Runtime;
  try {
    // The world passed every earlier layer; runtime() only types the value, it judges nothing.
    rt = runtime(world as CheckedWorld, recordingHost(host, run.exercised));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const [first] = entries;
    return first ? [issue('snippet.runtime_error', ['tests', first[0], 'script'], { message }, `runtime did not start: ${message}`)] : [];
  }
  const seedIds = new Set(Object.values(rt.dump().tables).flatMap((rows) => rows.map((r) => r.id)));
  entries.forEach(([name, test], i) => {
    const path: IssuePath = ['tests', name, 'script'];
    if (i > 0) rt.reset();
    const compiled = host.compile('test', test.script, path);
    if (!compiled.ok) {
      out.push(compiled.issue);
      return;
    }
    const { ctx, failed } = testCtx(rt);
    let thrown: unknown = null;
    let threw = false;
    try {
      compiled.run(ctx);
    } catch (e) {
      thrown = e;
      threw = true;
    }
    run.tests += 1;
    const assertMessage = failed();
    const collision = assertMessage !== null || threw ? seedCollision(rt, seedIds) : null;
    if (thrown instanceof SnippetFault) out.push(thrown.issue);
    else if (collision !== null) out.push(issue('test.seed_collision', path, collision, `${collision.entity}.${collision.field} ${collision.value} (${collision.rowId})`));
    else if (assertMessage !== null) out.push(issue('test.failed', path, { message: assertMessage }, `ctx.assert failed: ${show(assertMessage)}`));
    else if (threw) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      out.push(issue('snippet.runtime_error', path, { message }, `threw ${message}`));
    }
  });
  return out;
}

// ---------------------------------------------------------------- tasks

/**
 * Verifies every task from the seeded state, in declaration order, and collects each verdict.
 * Every failing task contributes its issues, then a world with fewer than MIN_TASKS tasks, none
 * included, gets world.too_few_tasks (YOS-113).
 *
 * A public world (every task bare, YOS-159) verifies nothing: no task carries its grader, so
 * there is no verdict to mint and nothing to exercise. It serves; the trusted verifier that
 * holds the private world grades. A mixed world is refused with tasks.private_mixed, because a
 * public bundle of it would still carry grader source.
 */
function tasks(world: World, host: SnippetHost, run: Run): CheckIssue[] {
  const ids = Object.keys(world.tasks);
  const tooFew = ids.length < MIN_TASKS ? [issue('world.too_few_tasks', ['tasks'], { have: ids.length }, count(ids.length, 'task'))] : [];
  if (ids.length === 0) return tooFew;
  const privacy = taskPrivacy(world);
  if (privacy === 'public') return tooFew;
  if (privacy === 'mixed') {
    const { complete, bare } = privacySplit(world);
    return [...tooFew, issue('tasks.private_mixed', ['tasks'], { complete, bare }, `${complete.length} complete, ${bare.length} instruction-only`)];
  }
  let seeded = run.seeded;
  if (seeded === null) {
    const r = seedState(world, host);
    if (!r.ok) return [r.issue];
    seeded = r.state;
  }
  const out: CheckIssue[] = [];
  for (const id of ids) {
    // The world passed every earlier layer; the cast only types it for runtime(), as in tests().
    const r = verifyTask(world as CheckedWorld, seeded, id, host);
    if (!r.ok) {
      out.push(...r.issues);
      continue;
    }
    run.verdicts[id] = r.verdict;
    for (const action of r.exercised) run.exercised.add(action);
  }
  return [...out, ...tooFew];
}

// ---------------------------------------------------------------- lints

/**
 * Quality lints, all warnings, computed by code from the seeded state, the routes and the task
 * verdicts. A world with no routes gets no read_only lint.
 */
function lints(world: World, _host: SnippetHost, run: Run): CheckIssue[] {
  return [...stateLints(world, run.seeded), ...taskLints(world, run.verdicts)];
}

/**
 * The lints that read no verdict. check() also runs them when the tasks layer fails, so WorldGen's
 * stages before tasks, which always hold 0 tasks, see seed and route warnings.
 */
function stateLints(world: World, seeded: State | null): CheckIssue[] {
  return [...worldLints(world), ...inputLints(world), ...seedLints(world, seeded)];
}

/** route.unused_required_input: a required action input whose name never appears in its handler. */
function inputLints(world: World): CheckIssue[] {
  return Object.entries(world.actions).flatMap(([action, a]) =>
    Object.entries(a.input)
      .filter(([field, def]) => def.required && !new RegExp(`\\b${field}\\b`).test(a.handler))
      .map(([field]) => issue('route.unused_required_input', ['actions', action, 'input', field], { action, field }, `${action} never names ${show(field)}`)),
  );
}

/** world.read_only: routes exist, but none creates, updates or deletes, and there is no action. */
function worldLints(world: World): CheckIssue[] {
  const routes = Object.values(world.routes);
  if (routes.length === 0 || Object.keys(world.actions).length > 0) return [];
  if (routes.some((r) => r.op === 'create' || r.op === 'update' || r.op === 'delete')) return [];
  return [issue('world.read_only', ['routes'], { routes: routes.length }, `${count(routes.length, 'route')}, all get or list`)];
}

/** The most rows one list call can return: the route pageSize in cursor mode, which caps limit, and any stripe-mode limit up to the maximum. */
const largestPage = (world: World, pageSize: number): number =>
  world.meta.api.list.mode === 'stripe' ? STRIPE_MAX_LIMIT : pageSize;

/**
 * Per entity in declaration order: all rows fit on one page of its largest list page, one
 * issue per skewed state field, rows out of time order, totals that disagree with their rows, and
 * placeholder text. Each points at the entity's seed. The paging lint skips an entity with no
 * create route: a reference table such as agent or sla_policy stays small.
 */
function seedLints(world: World, seeded: State | null): CheckIssue[] {
  const { rows, states } = seedStats(world, seeded);
  const pageSizes = new Map<string, number>();
  for (const route of Object.values(world.routes)) {
    if (route.op === 'list') pageSizes.set(route.entity, Math.max(largestPage(world, route.pageSize), pageSizes.get(route.entity) ?? 0));
  }
  const created = new Set(Object.values(world.routes).filter((r) => r.op === 'create').map((r) => r.entity));
  const out: CheckIssue[] = [];
  for (const [en, entity] of Object.entries(world.entities)) {
    const have = rows[en] ?? 0;
    const pageSize = pageSizes.get(en);
    if (pageSize !== undefined && created.has(en) && have <= pageSize) {
      out.push(issue('seed.too_few_rows_for_paging', ['seed', en], { entity: en, rows: have, pageSize }, count(have, 'row')));
    }
    for (const [fn, def] of Object.entries(entity.fields)) {
      const machine = machineOf(def);
      if (!machine) continue;
      const field = `${en}.${fn}`;
      const counts = states[field] ?? {};
      const problems = stateMixProblems(machine.states, counts);
      if (problems.length > 0) out.push(issue('seed.state_mix_skewed', ['seed', en], { field, counts }, problems.join('; ')));
    }
    if (seeded === null) continue;
    const table = [...(seeded.tables[en]?.values() ?? [])];
    out.push(...timeOrder(en, entity, table, seeded.now), ...totalsMismatches(world, seeded, en), ...loremText(world, en, table));
  }
  return out;
}

/**
 * Each declared state with no rows, and each state above STATE_SHARE_MAX of the rows that hold a
 * state, in declared order. None when no row holds a state: the paging lint covers empty tables.
 */
function stateMixProblems(declared: readonly string[], counts: Readonly<Record<string, number>>): string[] {
  const total = declared.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  if (total === 0) return [];
  return declared.flatMap((s) => {
    const n = counts[s] ?? 0;
    if (n === 0) return [`${show(s)} has no rows`];
    return n * STATE_SHARE_MAX.den > total * STATE_SHARE_MAX.num ? [`${show(s)} has ${n} of ${total} rows`] : [];
  });
}

const instant = (v: unknown): Instant | null => {
  if (typeof v !== 'string') return null;
  try {
    return fromIso(v);
  } catch {
    return null;
  }
};

/** A temporal field's value in ms: datetime holds ISO text, unix_time whole seconds. */
const msOf = (v: unknown): number | null => (typeof v === 'number' ? v * 1000 : instant(v));

/**
 * The past-event fields of an entity, and the pairs of temporal fields whose order is fixed: an end
 * field after its start, and past events in the order a state machine allows. A field is a past
 * event when a word of its name is a past participle and none marks a plan, so placed_at must lie at or
 * before the clock start while due_at and scheduled_for may lie after it.
 */
function timedFields(entity: World['entities'][string]): { past: string[]; ordered: [earlier: string, later: string][] } {
  const timed = Object.entries(entity.fields).filter(([, d]) => temporalOf(d)).map(([fn]) => fn);
  const past = timed.filter((fn) => {
    const words = fn.split('_');
    return words.some((w) => PAST_WORD.test(w)) && !words.some((w) => PLAN_WORDS.has(w));
  });
  const spans = timed.flatMap((fn): [string, string][] => {
    const words = fn.split('_');
    const i = words.findIndex((w) => Object.hasOwn(END_WORD, w));
    if (i < 0) return [];
    const end = words.with(i, END_WORD[words[i]!]!).join('_');
    return timed.includes(end) ? [[fn, end]] : [];
  });
  const machines = Object.values(entity.fields).flatMap((d) => machineOf(d) ?? []);
  return { past, ordered: [...spans, ...machines.flatMap((m) => lifecyclePairs(m, past))] };
}

/**
 * Past-event fields a state machine orders: each `<a>_at`/`<a>_on` before each `<b>_at`/`<b>_on`
 * when the machine reaches b from a and never a from b. Compare all declared aliases: a nullable
 * `_at` must not hide a populated `_on`. States on a cycle, such as a reopen loop, give no pair.
 */
function lifecyclePairs(machine: Machine, past: readonly string[]): [earlier: string, later: string][] {
  const fieldsOf = (state: string): string[] => [`${state}_at`, `${state}_on`].filter((f) => past.includes(f));
  const reach = new Map(machine.states.map((s) => [s, reachable(machine, s)]));
  return machine.states.flatMap((a) => machine.states.flatMap((b): [string, string][] => {
    if (!reach.get(a)!.has(b) || reach.get(b)!.has(a)) return [];
    return fieldsOf(a).flatMap((earlier) => fieldsOf(b).map((later): [string, string] => [earlier, later]));
  }));
}

/** Every state reachable from `from` in one or more transitions. */
function reachable(machine: Machine, from: string): ReadonlySet<string> {
  const next = (s: string): readonly string[] => (Object.hasOwn(machine.transitions, s) ? machine.transitions[s]! : []);
  const seen = new Set<string>();
  const todo = [...next(from)];
  for (let s = todo.pop(); s !== undefined; s = todo.pop()) {
    if (seen.has(s)) continue;
    seen.add(s);
    todo.push(...next(s));
  }
  return seen;
}

/**
 * The first row, in id order, updated before it was created, with created_at, updated_at or a
 * past-event field after the clock start, or with a pair of ordered fields the wrong way round.
 */
function timeOrder(en: string, entity: World['entities'][string], table: readonly Row[], start: Instant): CheckIssue[] {
  const { past, ordered } = timedFields(entity);
  for (const row of table) {
    const created = instant(row['created_at']);
    const updated = instant(row['updated_at']);
    const lateEvent = past.find((fn) => {
      const at = msOf(row[fn]);
      return at !== null && at > start;
    });
    const backwards = ordered.find(([earlier, later]) => {
      const [from, to] = [msOf(row[earlier]), msOf(row[later])];
      return from !== null && to !== null && to < from;
    });
    const problem =
      created !== null && updated !== null && updated < created ? `updated_at ${toIso(updated)} is before created_at ${toIso(created)}`
      : created !== null && created > start ? `created_at ${toIso(created)} is after the clock start ${toIso(start)}`
      : updated !== null && updated > start ? `updated_at ${toIso(updated)} is after the clock start ${toIso(start)}`
      : lateEvent !== undefined ? `${lateEvent} ${String(row[lateEvent])} is after the clock start ${toIso(start)}`
      : backwards !== undefined ? `${backwards[1]} ${String(row[backwards[1]])} is before ${backwards[0]} ${String(row[backwards[0]])}`
      : null;
    if (problem !== null) return [issue('seed.time_order', ['seed', en], { entity: en, id: row.id, problem }, `${row.id}: ${problem}`)];
  }
  return [];
}

/** A child entity whose rows compose its parent: named line or item (`order_line`, `line_items`), or carrying a quantity or unit price. */
const LINE_NAME = /(^|_)(line|item)s?$/;
const LINE_FIELDS = ['quantity', 'qty', 'unit_price'];
const isLineItem = (name: string, child: World['entities'][string]): boolean =>
  LINE_NAME.test(name) || LINE_FIELDS.some((f) => Object.hasOwn(child.fields, f));

/**
 * For each numeric field of `en` named `total` or `<part>_total`, and each line-item entity whose
 * ref points at `en` and that has a numeric `<part>` field (`amount` for a bare `total`): the first
 * parent row with child rows whose total differs from their sum. Parents with no child rows are
 * skipped. Other children, such as refunds or payments, are not summed (A-94).
 */
function totalsMismatches(world: World, seeded: State, en: string): CheckIssue[] {
  const out: CheckIssue[] = [];
  for (const [fn, def] of Object.entries(world.entities[en]?.fields ?? {})) {
    if (!NUMERIC_TYPES.has(def.type) || !(fn === 'total' || fn.endsWith('_total'))) continue;
    const part = fn === 'total' ? 'amount' : fn.slice(0, -'_total'.length);
    for (const [cn, child] of Object.entries(world.entities)) {
      const ref = Object.entries(child.fields).find(([, d]) => refOf(d)?.entity === en)?.[0];
      const partDef = child.fields[part];
      if (ref === undefined || !partDef || !NUMERIC_TYPES.has(partDef.type) || !isLineItem(cn, child)) continue;
      const sums = new Map<string, number>();
      for (const row of seeded.tables[cn]?.values() ?? []) {
        const parent = row[ref];
        const v = row[part];
        if (typeof parent === 'string' && typeof v === 'number') sums.set(parent, (sums.get(parent) ?? 0) + v);
      }
      for (const row of seeded.tables[en]?.values() ?? []) {
        const total = row[fn];
        const sum = sums.get(row.id);
        if (typeof total !== 'number' || sum === undefined || total === sum) continue;
        out.push(issue('seed.totals_mismatch', ['seed', en], { field: `${en}.${fn}`, child: `${cn}.${part}`, id: row.id, total, sum },
          `${row.id} ${fn} ${total}, sum ${sum}`));
        break;
      }
    }
  }
  return out;
}

/** One issue per string or text field with lorem ipsum in any row, quoting the first such value. */
function loremText(world: World, en: string, table: readonly Row[]): CheckIssue[] {
  const fields = Object.entries(world.entities[en]?.fields ?? {}).filter(([, d]) => TEXT_TYPES.has(d.type));
  return fields.flatMap(([fn]) => {
    const hits = table.map((r) => r[fn]).filter((v): v is string => typeof v === 'string' && LOREM.test(v));
    const first = hits[0];
    if (first === undefined) return [];
    return [issue('seed.lorem_text', ['seed', en], { field: `${en}.${fn}`, rows: hits.length }, show(first.slice(0, FOUND_MAX)))];
  });
}

/**
 * A missing difficulty, each task whose solution changed no row, and each medium or hard
 * solution that writes before any read.
 */
function taskLints(world: World, verdicts: Readonly<Record<string, TaskVerdict>>): CheckIssue[] {
  const tasks = Object.values(world.tasks);
  const out: CheckIssue[] = [];
  const have = DIFFICULTIES.filter((d) => tasks.some((t) => t.difficulty === d));
  if (have.length < DIFFICULTIES.length) out.push(issue('tasks.difficulty_not_spread', ['tasks'], { have }, have.join(', ')));
  for (const [id, v] of Object.entries(verdicts)) {
    if (v.solutionWrites === 0) out.push(issue('task.no_write', ['tasks', id, 'solution'], { calls: v.solutionCalls }, `0 writes in ${count(v.solutionCalls, 'call')}`));
    else if (v.difficulty !== 'easy' && v.solutionReadsBeforeWrite === 0) {
      out.push(issue('tasks.no_read_before_write', ['tasks', id, 'solution'], {}, `no read before the first of ${count(v.solutionWrites, 'write')}`));
    }
  }
  return out;
}
