/**
 * Red-team suite for checkWorld: G-01 to G-07 in research/redteam-contract.md, plus the
 * prototype-key and sandbox probes that run inside check (G-21).
 *
 * Expected values are literals: codes, layers and path prefixes from mutations.ts and the
 * extra rows below, counts from FACTS, or engine-vs-engine invariance. Nothing calls engine
 * logic to compute an expectation. worldSchema is used only in the G-00 fixture self-test.
 *
 * Layout:
 * - baseline: the base world checks ok, with stats and no warnings (G-03, G-05, G-06).
 * - rows: one test per mutations.ts row and per extra row (G-07). Every report is also
 *   held to G-02 (issue fields), G-03 (severity placement) and G-04 (no cascade).
 * - layers: scenario tests for layer order and layer.blocked (G-04).
 * - garbage: inputs no parsed world should hold (G-01).
 * - fuzz: seeded random multi-mutations, ddmin repro on failure (G-01, G-04).
 *
 * Ambiguities this file owns in the contract: RT-80 (every issue of the failing layer is
 * reported), RT-81 (a failed seed of one entity does not cascade into issues on entities
 * seeded from it), RT-82 (issue strings are bounded in length), RT-83 (routes that differ
 * only in param names are duplicates), RT-84 (a report lists no issue twice), RT-85 (a
 * tasks failure, which skips only lints, adds no layer.blocked), RT-86 (a snippet
 * cannot change host intrinsics through the prototype chain of a ctx object), RT-88 (a cyclic
 * value in the JSON field meta.api.error is refused) and RT-89 (input deeper than the parser's
 * stack is refused at the deep value).
 *
 * Gating: each row and test skips with `unit <key> not landed` until the units it needs land
 * (LAYER_CAPS, CODE_CAPS). The fuzz pool holds only rows whose unit has landed.
 */
import { describe, it, type TestOptions } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import {
  CHECK_LAYERS, ISSUES, SECTIONS, checkWorld, worldSchema,
  type CheckLayer, type CheckReport, type IssueCode, type Section, type TaskVerdict, type World,
} from '#engine';
import { ITER, PROBE, cap, clone, deepFreeze, failWithRepro, opts, rng, seeds, todo, type CapName } from './redteam/harness.ts';
import { MUTATIONS, NOT_WORLD_TRIGGERABLE, type Mutation } from './redteam/mutations.ts';
import { FACTS, TASK_IDS, baseWorld, field, worldsUnderTest } from './redteam/world.ts';

// ---------------------------------------------------------------------------------------
// Literal tables

/**
 * The earliest layer that may emit each code. A report whose `reached` comes before the
 * code's layer is a cascade (G-04). Layers follow the groups in issues.ts, and where the
 * docs allow an earlier layer this table takes it, so it never flags a legal report:
 * runtime_error and timeout_guard may come from compile (row C03 accepts runtime_error for a
 * compile-layer row, and evaluating a snippet expression can loop), promise_returned may
 * come from a static `async` check at compile, and action.unexercised sits in the issues.ts
 * group "Enforcement during seed and tests". null: WorldGen-only, never from checkWorld.
 */
const EARLIEST = {
  'schema.invalid': 'schema',
  'ref.unknown': 'references',
  'route.duplicate_path': 'references',
  'state.bad_machine': 'schema',
  'seed.cycle': 'references',
  'snippet.compile_error': 'compile',
  'snippet.runtime_error': 'compile',
  'snippet.promise_returned': 'compile',
  'snippet.call_quota': 'seed',
  'snippet.memory': 'compile',
  'snippet.host_unavailable': 'compile',
  'snippet.timeout_guard': 'compile',
  'task.clock_control': 'compile',
  'task.instruction_only': 'tasks',
  'constraint.violation': 'seed',
  'test.failed': 'tests',
  'test.seed_collision': 'tests',
  'action.unexercised': 'tests',
  'task.grader_out_of_range': 'tasks',
  'task.reference_server_error': 'tasks',
  'task.decoy_server_error': 'tasks',
  'task.solution_not_full_marks': 'tasks',
  'task.noop_not_zero': 'tasks',
  'task.idle_not_zero': 'tasks',
  'task.alternative_not_full_marks': 'tasks',
  'task.decoy_required': 'tasks',
  'task.decoy_full_marks': 'tasks',
  'task.decoy_trivial': 'tasks',
  'task.prefix_full_marks': 'tasks',
  'task.mutant_full_marks': 'tasks',
  'task.nondeterministic': 'tasks',
  'world.too_few_tasks': 'tasks',
  'tasks.private_mixed': 'tasks',
  'route.param_not_column': 'references',
  'route.bad_path': 'references',
  'route.reserved_path': 'references',
  'route.missing_id_param': 'references',
  'route.filter_not_filterable': 'references',
  'route.sort_ignored': 'references',
  'api.name_collision': 'references',
  'field.reserved_name': 'references',
  'field.default_invalid': 'schema',
  'field.range_inverted': 'schema',
  'field.values_duplicate': 'schema',
  'field.pattern_invalid': 'schema',
  'layer.blocked': 'schema',
  'seed.too_few_rows_for_paging': 'lints',
  'seed.state_mix_skewed': 'lints',
  'tasks.difficulty_not_spread': 'lints',
  'world.read_only': 'lints',
  'task.no_write': 'lints',
  'tasks.no_read_before_write': 'lints',
  'route.unused_required_input': 'lints',
  'seed.time_order': 'lints',
  'seed.totals_mismatch': 'lints',
  'seed.lorem_text': 'lints',
  'openapi.operation_missing': null,
  'openapi.operation_extra': null,
  'openapi.status_missing': null,
  'openapi.required_field_missing': null,
  'openapi.required_field_extra': null,
  'openapi.field_type': null,
  'openapi.field_enum': null,
  'rules.invalid': 'references',
  'rules.handler_mismatch': 'references',
  'fidelity.below_floor': null,
  'plan.not_covered': null,
  'plan.fixture_changed': null,
  'task.difficulty_unproven': null,
  'task.pressure_unmet': null,
  'plan.seed_rows_short': null,
  'plan.state_missing': null,
  'plan.state_field_missing': null,
  'plan.lifecycle_unrepresented': null,
  'plan.pressure_unreachable': null,
  'plan.rule_unanswered': null,
  'plan.job_as_action': null,
  'plan.seed_mix_off': null,
  'edit.out_of_scope': null,
  'iterate.unplanned_change': null,
  'iterate.out_of_scope': null,
  'iterate.regression': null,
} as const satisfies Record<IssueCode, CheckLayer | null>;

/**
 * Sections whose layer never runs when `reached` fails, so each must carry exactly one
 * layer.blocked unless it is empty or already has a real issue. A minimum: an engine may
 * also block actions and jobs when compile is skipped.
 */
const SKIPPED_MIN: Readonly<Record<CheckLayer, readonly Section[]>> = {
  schema: [],
  references: ['seed', 'tests', 'tasks'],
  compile: ['seed', 'tests', 'tasks'],
  seed: ['tests', 'tasks'],
  tests: ['tasks'],
  tasks: [],
  lints: [],
};

const WORLD_HEADS: ReadonlySet<string> = new Set<string>([...SECTIONS, 'meta', 'format']);
/** Bound for RT-82: an issue string a model can read. */
const MAX_ISSUE_TEXT = 4096;

// ---------------------------------------------------------------------------------------
// File-local helpers

const CHECK: TestOptions = cap('checkWorld');
const LONG: TestOptions = { timeout: 300_000 };

/**
 * Capabilities a check layer needs before its rows mean anything. Every layer after seed reads
 * seeded rows, so it also needs check.seed. Units land in the order seed, tests, tasks, lints
 * (research/archive/factory/backlog.json), so the first missing cap names the unit that blocks.
 */
const LAYER_CAPS: Readonly<Record<CheckLayer, readonly CapName[]>> = {
  schema: ['check.schema'],
  references: ['check.references'],
  compile: ['check.compile'],
  seed: ['check.seed'],
  tests: ['check.seed', 'check.tests'],
  tasks: ['check.seed', 'check.tests', 'check.tasks'],
  lints: ['check.seed', 'check.lints'],
};
/**
 * Codes another unit than the layer's own emits (backlog acceptance): decoy and prefix checks
 * come with engine-verify-full, world.too_few_tasks with engine-lints, and action.unexercised
 * with engine-tests-layer.
 */
const CODE_CAPS: Readonly<Partial<Record<IssueCode, readonly CapName[]>>> = {
  'task.idle_not_zero': ['check.tasks.discriminating'],
  'task.alternative_not_full_marks': ['check.tasks.discriminating'],
  'task.decoy_required': ['check.tasks.discriminating'],
  'task.decoy_full_marks': ['check.tasks.discriminating'],
  'task.decoy_trivial': ['check.tasks.discriminating'],
  'task.prefix_full_marks': ['check.tasks.discriminating'],
  'task.mutant_full_marks': ['check.tasks.discriminating'],
  'world.too_few_tasks': ['check.tasks'],
  'action.unexercised': ['check.seed', 'check.tests'],
};
/** Skips a row whose layer or code belongs to a unit that has not landed. */
function rowGate(m: Mutation): TestOptions {
  return cap('checkWorld', ...new Set([...LAYER_CAPS[m.layer], ...(CODE_CAPS[m.code] ?? [])]));
}
const landed = (m: Mutation): boolean => rowGate(m).skip === undefined;
/** The base report's seeded stats (engine-seed acceptance 5). */
const SEEDED: TestOptions = cap('checkWorld', 'check.seed');
/** Verdicts in the ok report (engine-grade-verify-basic acceptance 5). */
const VERDICTS: TestOptions = cap('checkWorld', 'check.seed', 'check.tests', 'check.tasks');

type Loose = Record<PropertyKey, unknown>;
const loose = (x: object): Loose => x as Loose;
const isObj = (x: unknown): x is Loose => typeof x === 'object' && x !== null;

function at<T>(rec: Readonly<Record<string, T>>, key: string): T {
  const v = rec[key];
  if (v === undefined) throw new Error(`fixture has no ${key}`);
  return v;
}

function errText(e: unknown): string {
  return (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 400);
}

function pathText(path: unknown): string {
  return Array.isArray(path) ? `[${path.map((p) => (typeof p === 'string' ? p.slice(0, 60) : String(p))).join('.')}]` : `<${typeof path}>`;
}

function describeIssue(i: unknown): string {
  if (!isObj(i)) return `<${typeof i}>`;
  const found = typeof i['found'] === 'string' ? i['found'].slice(0, 120) : `<${typeof i['found']}>`;
  return `${String(i['code'])} @ ${pathText(i['path'])} found=${found}`;
}

function summarize(r: unknown): string {
  if (!isObj(r)) return `report is ${typeof r}`;
  const warnings = Array.isArray(r['warnings']) ? r['warnings'].map(describeIssue) : [];
  if (r['ok'] === true) return [`ok: true`, ...warnings.map((w) => `  warning ${w}`)].join('\n');
  const issues = Array.isArray(r['issues']) ? r['issues'].map(describeIssue) : [];
  return [`ok: ${String(r['ok'])}, reached: ${String(r['reached'])}`, ...issues.map((i) => `  ${i}`), ...warnings.map((w) => `  warning ${w}`)].join('\n');
}

function startsWith(path: unknown, prefix: readonly (string | number)[]): boolean {
  return Array.isArray(path) && path.length >= prefix.length && prefix.every((p, i) => path[i] === p);
}

function resolvePath(root: unknown, path: readonly unknown[]): unknown {
  let cur = root;
  for (const k of path) {
    if (!isObj(cur) || (typeof k !== 'string' && typeof k !== 'number') || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const layerIndex = (l: CheckLayer): number => CHECK_LAYERS.indexOf(l);
const isLayer = (x: unknown): x is CheckLayer => typeof x === 'string' && (CHECK_LAYERS as readonly string[]).includes(x);
const isCode = (x: unknown): x is IssueCode => typeof x === 'string' && Object.hasOwn(ISSUES, x);

type ProblemOpts = { readonly world?: unknown; readonly allowInputHead?: boolean };

/** G-02 and G-03 for one issue. Returns problems, empty when the issue is well formed. */
function issueProblems(i: unknown, where: 'issues' | 'warnings', o: ProblemOpts): string[] {
  const tag = `${where} ${describeIssue(i)}`;
  if (!isObj(i)) return [`${tag}: not an object`];
  const p: string[] = [];
  const code = i['code'];
  if (!isCode(code)) return [`${tag}: code is not in ISSUES`];
  if (NOT_WORLD_TRIGGERABLE.includes(code)) p.push(`${tag}: WorldGen-only code came out of checkWorld`);
  if (i['severity'] !== ISSUES[code].severity) p.push(`${tag}: severity ${String(i['severity'])}, ISSUES says ${ISSUES[code].severity}`);
  const want = where === 'issues' ? 'error' : 'warning';
  if (i['severity'] !== want) p.push(`${tag}: severity ${String(i['severity'])} listed under ${where}`);
  const path = i['path'];
  if (!Array.isArray(path) || path.length === 0) {
    p.push(`${tag}: path is empty or not an array`);
  } else {
    const head: unknown = path[0];
    const headOk = typeof head === 'string' && (WORLD_HEADS.has(head) || (o.allowInputHead === true && head === 'input'));
    if (!headOk) p.push(`${tag}: path head ${String(head)} is not a section, meta or format`);
    path.forEach((seg: unknown, n) => {
      if (!(typeof seg === 'string' || (typeof seg === 'number' && Number.isInteger(seg) && seg >= 0))) p.push(`${tag}: path segment ${n} is ${typeof seg}`);
    });
  }
  for (const k of ['expected', 'found', 'hint'] as const) {
    const v = i[k];
    if (typeof v !== 'string' || v.trim() === '') p.push(`${tag}: ${k} is empty or not a string`);
    else if (v.includes('[object Object]')) p.push(`${tag}: ${k} contains [object Object]`);
  }
  const span = i['span'];
  if (span !== undefined) {
    if (!isObj(span) || !Number.isInteger(span['start']) || !Number.isInteger(span['end'])) {
      p.push(`${tag}: span is not { start, end } integers`);
    } else {
      const start = span['start'] as number;
      const end = span['end'] as number;
      if (start < 0 || end < start) p.push(`${tag}: span ${start}..${end} is not a range`);
      const target = Array.isArray(path) && o.world !== undefined ? resolvePath(o.world, path) : undefined;
      if (typeof target === 'string' && end > target.length) p.push(`${tag}: span end ${end} is past the string length ${target.length}`);
    }
  }
  return p;
}

/** G-02, G-03 and G-04 for a whole report. Returns problems, empty when the report is sound. */
function reportProblems(r: unknown, o: ProblemOpts = {}): string[] {
  if (!isObj(r)) return [`report is ${r === null ? 'null' : typeof r}`];
  if (typeof r['ok'] !== 'boolean') return [`report.ok is ${typeof r['ok']}`];
  const p: string[] = [];
  const warnings = r['warnings'];
  if (!Array.isArray(warnings)) p.push('warnings is not an array');
  else for (const w of warnings) p.push(...issueProblems(w, 'warnings', o));

  if (r['ok']) {
    if (!isObj(r['world'])) p.push('ok report has no world');
    if (!isObj(r['verdicts'])) p.push('ok report has no verdicts');
    if (!isObj(r['stats'])) p.push('ok report has no stats');
    if (typeof r['tests'] !== 'number') p.push('ok report has no tests count');
    return p;
  }

  const reached = r['reached'];
  if (!isLayer(reached)) return [...p, `reached ${String(reached)} is not a CHECK_LAYERS entry`];
  // Since YOS-113 world.too_few_tasks is a tasks-layer error, so the lints layer has no errors.
  if (reached === 'lints') p.push('reached is lints, but the lints layer reports only warnings');
  const issues = r['issues'];
  if (!Array.isArray(issues) || issues.length === 0) return [...p, 'ok:false report has no issues'];
  for (const i of issues) p.push(...issueProblems(i, 'issues', o));

  // G-04: nothing from a layer after `reached`, warnings included.
  const all: readonly unknown[] = [...issues, ...(Array.isArray(warnings) ? warnings : [])];
  for (const i of all) {
    if (!isObj(i) || !isCode(i['code'])) continue;
    const from: CheckLayer | null = EARLIEST[i['code']];
    if (from !== null && layerIndex(from) > layerIndex(reached)) p.push(`cascade: ${describeIssue(i)} comes from ${from}, after reached ${reached}`);
  }

  // G-04: one layer.blocked per skipped section. Whether a tasks failure, which skips only
  // lints, may add layer.blocked is RT-85, tested on its own below.
  const heads = new Map<string, number>();
  const realHeads = new Set<string>();
  for (const i of issues) {
    if (!isObj(i) || !Array.isArray(i['path'])) continue;
    const head = String(i['path'][0]);
    if (i['code'] === 'layer.blocked') {
      heads.set(head, (heads.get(head) ?? 0) + 1);
      if (!(SECTIONS as readonly string[]).includes(head)) p.push(`layer.blocked on ${head}, which is not a section`);
    } else {
      realHeads.add(head);
    }
  }
  for (const [head, n] of heads) if (n > 1) p.push(`${n} layer.blocked issues for section ${head}, expected one`);
  if (isObj(o.world)) {
    for (const s of SKIPPED_MIN[reached]) {
      const section = o.world[s];
      const nonEmpty = isObj(section) && Object.keys(section).length > 0;
      if (nonEmpty && !realHeads.has(s) && !heads.has(s)) p.push(`section ${s} was skipped after ${reached} failed but has no layer.blocked`);
    }
  }

  return p;
}

/** RT-84: issues listed more than once with the same code, path, expected, found and hint. */
function duplicateIssues(r: CheckReport): string[] {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const i of r.ok ? [] : r.issues) {
    const key = JSON.stringify([i.code, pathText(i.path), i.expected, i.found, i.hint]);
    if (seen.has(key)) dups.push(describeIssue(i));
    seen.add(key);
  }
  return dups;
}

function assertSound(r: unknown, o: ProblemOpts = {}, label = ''): void {
  assert.deepEqual(reportProblems(r, o), [], `${label}\n${summarize(r)}`);
}

function blockedHeads(r: CheckReport): string[] {
  return r.ok ? [] : r.issues.filter((i) => i.code === 'layer.blocked').map((i) => String(i.path[0]));
}

function rtTodo(rt: string | undefined): TestOptions {
  return rt !== undefined && rt.startsWith('RT-') ? todo(rt as `RT-${string}`) : {};
}

const ROW = new Map(MUTATIONS.map((m) => [m.id, m] as const));
function row(id: string): Mutation {
  const m = ROW.get(id);
  if (!m) throw new Error(`no mutation row ${id}`);
  return m;
}
function mutated(...ids: string[]): World {
  const w = baseWorld();
  for (const id of ids) row(id).mutate(w);
  return w;
}

function baseReport(): CheckReport {
  return PROBE.baseReport ?? checkWorld(baseWorld());
}

/** Prototype keys of the host intrinsics, to catch pollution. */
function protoSnapshot(): string[] {
  return [Object.prototype, Array.prototype, Function.prototype, String.prototype].map((p) => Reflect.ownKeys(p).map(String).sort().join(','));
}

type Prefix = readonly (string | number)[];
type GarbageOpts = { fail?: boolean; schema?: boolean; world?: unknown; at?: Prefix };

/**
 * Never throws, report is sound. `fail`: ok must be false. `schema`: and reached schema with
 * schema.invalid, under `at` when given. Returns the report so callers can compare it.
 */
function garbageCheck(label: string, input: unknown, o: GarbageOpts = {}): { problems: string[]; report: unknown } {
  let r: unknown;
  try {
    r = checkWorld(input);
  } catch (e) {
    return { problems: [`${label}: threw ${errText(e)}`], report: undefined };
  }
  const p = reportProblems(r, { allowInputHead: true, world: o.world ?? input }).map((x) => `${label}: ${x}`);
  if (!isObj(r)) return { problems: p, report: r };
  if ((o.fail || o.schema) && r['ok'] !== false) p.push(`${label}: ok is ${String(r['ok'])}, expected false`);
  if (o.schema && r['ok'] === false) {
    if (r['reached'] !== 'schema') p.push(`${label}: reached ${String(r['reached'])}, expected schema`);
    const issues = Array.isArray(r['issues']) ? r['issues'] : [];
    const at = o.at ?? [];
    if (!issues.some((i) => isObj(i) && i['code'] === 'schema.invalid' && startsWith(i['path'], at))) p.push(`${label}: no schema.invalid under ${pathText(at)}`);
  }
  return { problems: p, report: r };
}

function garbageProblems(label: string, input: unknown, o: GarbageOpts = {}): string[] {
  return garbageCheck(label, input, o).problems;
}

function assertGarbage(label: string, input: unknown, o: GarbageOpts = {}): void {
  assert.deepEqual(garbageProblems(label, input, o), []);
}

/** What a report decided, without the per-item detail that scales with input size. */
function shapeOf(r: unknown): unknown {
  if (!isObj(r)) return `<${typeof r}>`;
  const codes = (k: string) => [...new Set((Array.isArray(r[k]) ? r[k] : []).map((i: unknown) => (isObj(i) ? String(i['code']) : '?')))].sort();
  return r['ok'] === true
    ? { ok: true, warnings: codes('warnings'), verdicts: isObj(r['verdicts']) ? Object.keys(r['verdicts']).sort() : null, tests: r['tests'] }
    : { ok: r['ok'], reached: r['reached'], issues: codes('issues'), warnings: codes('warnings') };
}

/** A deliberate refusal: ok:false at one of `layers`, every real issue one of `codes` under one of `prefixes`. */
type Refusal = { readonly layers: readonly CheckLayer[]; readonly codes: readonly IssueCode[]; readonly prefixes: readonly Prefix[] };
const SCHEMA_REFUSAL = (...prefixes: Prefix[]): Refusal => ({ layers: ['schema'], codes: ['schema.invalid'], prefixes });

/**
 * Invariance for stress inputs: the report is sound and decides like the report for `control`
 * (the same construction at a small size or without the hostile value). An engine may instead
 * refuse the input on purpose, but only precisely, as `refusal` says. A crash caught by a
 * catch-all, a truncated walk or a stack overflow turned into some other issue fails.
 */
function likeControlProblems(label: string, input: unknown, control: unknown, refusal?: Refusal, world?: unknown): string[] {
  const { problems, report } = garbageCheck(label, input, world === undefined ? {} : { world });
  if (problems.length > 0) return problems;
  let controlReport: unknown;
  try {
    controlReport = checkWorld(control);
  } catch (e) {
    return [`${label}: control threw ${errText(e)}`];
  }
  const got = shapeOf(report);
  const want = shapeOf(controlReport);
  if (JSON.stringify(got) === JSON.stringify(want)) return [];
  if (refusal && isObj(report) && report['ok'] === false && isLayer(report['reached']) && refusal.layers.includes(report['reached'])) {
    const issues = Array.isArray(report['issues']) ? report['issues'] : [];
    const stray = issues.filter(
      (i) => !(isObj(i) && (i['code'] === 'layer.blocked' || (refusal.codes.includes(i['code'] as IssueCode) && refusal.prefixes.some((pre) => startsWith(i['path'], pre))))),
    );
    if (stray.length === 0) return [];
    return [`${label}: refused with stray issues ${stray.slice(0, 5).map(describeIssue).join('; ')}`];
  }
  return [`${label}: checks as ${JSON.stringify(got)}, its control checks as ${JSON.stringify(want)}`];
}

// ---------------------------------------------------------------------------------------
// Extra rows: prototype-named references, exotic values, and one RT-83 case

const route = (w: World, r: string) => loose(at(w.routes, r));
const ticketField = (w: World, f: string) => loose(at(at(w.entities, 'ticket').fields, f));

const EXTRA_ROWS: readonly Mutation[] = [
  { id: 'X01', note: 'route entity named constructor, which no world declares', code: 'ref.unknown', pathPrefix: ['routes', 'get_ticket'], layer: 'references', mutate: (w) => { route(w, 'get_ticket')['entity'] = 'constructor'; } },
  { id: 'X02', note: 'ref field to entity constructor', code: 'ref.unknown', pathPrefix: ['entities', 'ticket', 'fields', 'assignee'], layer: 'references', mutate: (w) => { ticketField(w, 'assignee')['entity'] = 'constructor'; } },
  { id: 'X03', note: 'list filter on field constructor', code: 'ref.unknown', pathPrefix: ['routes', 'list_tickets'], layer: 'references', mutate: (w) => { route(w, 'list_tickets')['filters'] = ['status', 'constructor']; } },
  { id: 'X04', note: 'list sort on field constructor', code: 'ref.unknown', pathPrefix: ['routes', 'list_tickets'], layer: 'references', mutate: (w) => { route(w, 'list_tickets')['sort'] = ['constructor']; } },
  { id: 'X05', note: 'seed for entity constructor', code: 'ref.unknown', pathPrefix: ['seed', 'constructor'], layer: 'references', mutate: (w) => { w.seed['constructor'] = '(ctx) => []'; } },
  {
    id: 'X06', note: 'transition from undeclared state constructor', code: 'state.bad_machine', pathPrefix: ['entities', 'ticket'], layer: 'schema',
    mutate: (w) => { ticketField(w, 'status')['transitions'] = { open: ['pending'], pending: ['open', 'closed'], closed: [], constructor: ['open'] }; },
  },
  {
    id: 'X07', note: 'transition to undeclared state constructor', code: 'state.bad_machine', pathPrefix: ['entities', 'ticket'], layer: 'schema',
    mutate: (w) => { ticketField(w, 'status')['transitions'] = { open: ['pending', 'constructor'], pending: ['open', 'closed'], closed: [] }; },
  },
  { id: 'X08', note: 'state initial constructor', code: 'state.bad_machine', pathPrefix: ['entities', 'ticket'], layer: 'schema', mutate: (w) => { ticketField(w, 'status')['initial'] = 'constructor'; } },
  {
    id: 'X09', note: 'action input ref to entity constructor', code: 'ref.unknown', pathPrefix: ['actions', 'escalate'], layer: 'references',
    mutate: (w) => { at(w.actions, 'escalate').input['other'] = field<'ref'>({ type: 'ref', entity: 'constructor', nullable: true, onDelete: 'restrict' }); },
  },
  {
    // zod v4 records drop an own __proto__ key without an issue, so check refuses it before parsing (RT-14, A-192).
    id: 'X10', note: 'own __proto__ key in entities', code: 'schema.invalid', pathPrefix: ['entities'], layer: 'schema',
    mutate: (w) => { Object.defineProperty(w.entities, '__proto__', { value: structuredClone(at(w.entities, 'agent')), enumerable: true, configurable: true, writable: true }); },
  },
  { id: 'X11', note: 'meta.seed is a BigInt', code: 'schema.invalid', pathPrefix: ['meta', 'seed'], layer: 'schema', mutate: (w) => { loose(w.meta)['seed'] = 7n; } },
  { id: 'X12', note: 'meta.name is a Symbol', code: 'schema.invalid', pathPrefix: ['meta', 'name'], layer: 'schema', mutate: (w) => { loose(w.meta)['name'] = Symbol('redteam'); } },
  { id: 'X13', note: 'clock.start is a Date (YAML timestamp)', code: 'schema.invalid', pathPrefix: ['meta', 'clock', 'start'], layer: 'schema', mutate: (w) => { loose(w.meta.clock)['start'] = new Date(0); } },
  { id: 'X14', note: 'handler is a JS function, not source', code: 'schema.invalid', pathPrefix: ['actions', 'escalate', 'handler'], layer: 'schema', mutate: (w) => { loose(at(w.actions, 'escalate'))['handler'] = () => ({ status: 200, body: {} }); } },
  { id: 'X15', note: 'meta.seed is NaN', code: 'schema.invalid', pathPrefix: ['meta', 'seed'], layer: 'schema', mutate: (w) => { w.meta.seed = Number.NaN; } },
  { id: 'X16', note: 'meta.seed is the string "7"', code: 'schema.invalid', pathPrefix: ['meta', 'seed'], layer: 'schema', mutate: (w) => { loose(w.meta)['seed'] = '7'; } },
  { id: 'X17', note: 'format is the string "1"', code: 'schema.invalid', pathPrefix: ['format'], layer: 'schema', mutate: (w) => { loose(w)['format'] = '1'; } },
  { id: 'X18', note: 'list pageSize Infinity', code: 'schema.invalid', pathPrefix: ['routes', 'list_tickets'], layer: 'schema', mutate: (w) => { route(w, 'list_tickets')['pageSize'] = Number.POSITIVE_INFINITY; } },
  { id: 'X19', note: 'entity key is a lone surrogate', code: 'schema.invalid', pathPrefix: ['entities'], layer: 'schema', mutate: (w) => { w.entities['\uD800'] = structuredClone(at(w.entities, 'agent')); } },
  { id: 'X20', note: 'decoys hold a number', code: 'schema.invalid', pathPrefix: ['tasks', 'pend_open_urgent', 'decoys'], layer: 'schema', mutate: (w) => { loose(at(w.tasks, 'pend_open_urgent'))['decoys'] = [42]; } },
  { id: 'X21', note: 'seed snippet is a String object', code: 'schema.invalid', pathPrefix: ['seed', 'job_run'], layer: 'schema', mutate: (w) => { loose(w.seed)['job_run'] = new String('(ctx) => []'); } },
  { id: 'X22', note: 'list pageSize 2.5', code: 'schema.invalid', pathPrefix: ['routes', 'list_tickets'], layer: 'schema', mutate: (w) => { route(w, 'list_tickets')['pageSize'] = 2.5; } },
  {
    id: 'X23', note: 'GET /tickets/{ticket_id} next to GET /tickets/{id}', code: 'route.duplicate_path', pathPrefix: ['routes'], layer: 'references',
    mutate: (w) => { w.routes['get_ticket_alt'] = { op: 'get', method: 'GET', path: '/tickets/{ticket_id}', entity: 'ticket' }; },
  },
];

const ALL_ROWS: readonly Mutation[] = [...MUTATIONS, ...EXTRA_ROWS];

function runRow(m: Mutation): void {
  const w = baseWorld();
  m.mutate(w);
  const r = checkWorld(w);
  const codes: readonly IssueCode[] = [m.code, ...(m.accept ?? [])];
  const want = `${codes.join(' or ')} under ${pathText(m.pathPrefix)}`;
  if (m.expect === 'absent') {
    const all = [...(r.ok ? [] : r.issues), ...r.warnings];
    assert.deepEqual(all.filter((i) => i.code === m.code).map(describeIssue), [], `${m.id}: ${m.code} must not appear`);
    // Absent rows describe a world that is fine ("easy task without decoys is fine"). Without
    // this, an engine that rejects the world with any other code would pass.
    assert.equal(r.ok, true, `${m.id}: expected the world to check ok\n${summarize(r)}`);
  } else if (ISSUES[m.code].severity === 'error') {
    assert.equal(r.ok, false, `${m.id}: expected ok:false with ${want}\n${summarize(r)}`);
    if (r.ok) return;
    const hit =
      r.issues.find((i) => i.code === m.code && startsWith(i.path, m.pathPrefix)) ??
      r.issues.find((i) => codes.includes(i.code) && startsWith(i.path, m.pathPrefix));
    assert.ok(hit, `${m.id}: no ${want}\n${summarize(r)}`);
    // mutations.ts: "For errors, report.reached equals it", also when an accepted code matched.
    assert.equal(r.reached, m.layer, `${m.id}: reached (matched ${hit.code})\n${summarize(r)}`);
  } else {
    const warn = r.warnings.find((i) => i.code === m.code && startsWith(i.path, m.pathPrefix));
    if (r.ok) {
      assert.ok(warn, `${m.id}: expected warning ${m.code}\n${summarize(r)}`);
      // One mutation, one lint: a lint that misfires on the edited world must not hide here.
      const stray = r.warnings.filter((i) => !codes.includes(i.code));
      assert.deepEqual(stray.map(describeIssue), [], `${m.id}: warnings other than ${codes.join(' or ')}`);
    } else {
      const hit = r.issues.find((i) => codes.includes(i.code) && ISSUES[i.code].severity === 'error' && startsWith(i.path, m.pathPrefix));
      assert.ok(hit, `${m.id}: expected ok:true with warning ${m.code}\n${summarize(r)}`);
    }
  }
  assertSound(r, { world: w }, m.id);
}

// ---------------------------------------------------------------------------------------
// Tests

describe('check: fixtures', () => {
  it('G-00 extra rows have unique ids and only schema-layer rows fail worldSchema', () => {
    const ids = ALL_ROWS.map((m) => m.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
    for (const m of EXTRA_ROWS) {
      const w = baseWorld();
      m.mutate(w);
      const zodAccepts = m.id === 'X10';
      assert.equal(worldSchema.safeParse(w).success, zodAccepts || m.layer !== 'schema', `${m.id} (${m.note})`);
    }
  });

  it('G-00 EARLIEST names a real layer for every code mutations.ts uses', () => {
    for (const m of ALL_ROWS) {
      const from = EARLIEST[m.code];
      assert.notEqual(from, null, `${m.id} uses WorldGen-only ${m.code}`);
      if (from !== null && m.expect !== 'absent') assert.ok(layerIndex(from) <= layerIndex(m.layer), `${m.id}: ${m.code} is earliest at ${from}, row says ${m.layer}`);
    }
  });
});

describe('check: baseline', () => {
  it('G-05 base world checks ok with one verdict per task', VERDICTS, () => {
    const r = baseReport();
    assert.equal(r.ok, true, summarize(r));
    if (!r.ok) return;
    assert.deepEqual(Object.keys(r.verdicts).sort(), [...TASK_IDS].sort());
    assertSound(r, { world: baseWorld() });
  });

  // decoys, bestPrefixScore, solutionCalls and endStateHash come with engine-verify-full (acceptance 4).
  it('G-33 base verdicts hold the hand-derived scores, not placeholders', cap('checkWorld', 'check.seed', 'check.tests', 'check.tasks', 'check.tasks.discriminating'), () => {
    const r = baseReport();
    assert.equal(r.ok, true, summarize(r));
    if (!r.ok) return;
    const base = baseWorld();
    for (const id of TASK_IDS) {
      assert.ok(Object.hasOwn(r.verdicts, id), `no own verdict for ${id}`);
      const v: TaskVerdict = at(r.verdicts, id);
      const t = at(base.tasks, id);
      const facts = FACTS.scores[id];
      assert.equal(v.taskId, id);
      assert.equal(v.difficulty, t.difficulty, id);
      assert.equal(v.solution, 1, id);
      assert.equal(v.noop, 0, id);
      assert.deepEqual(v.decoys.map((d) => d.why), t.decoys.map((d) => d.why), `${id}: decoy order or text`);
      assert.equal(v.decoys.length, facts.decoys.length, id);
      v.decoys.forEach((d, n) => assert.ok(Math.abs(d.score - (facts.decoys[n] ?? Number.NaN)) < 1e-9, `${id} decoy ${n}: score ${d.score}, FACTS says ${String(facts.decoys[n])}`));
      const writes = FACTS.solutionWrites[id].length;
      if (writes === 1) assert.equal(v.bestPrefixScore, null, `${id}: one solution write, so no strict prefix`);
      else assert.ok(typeof v.bestPrefixScore === 'number' && v.bestPrefixScore >= 0 && v.bestPrefixScore < 1, `${id}: bestPrefixScore ${String(v.bestPrefixScore)}`);
      assert.ok(Number.isInteger(v.solutionCalls) && v.solutionCalls >= writes, `${id}: solutionCalls ${v.solutionCalls} below ${writes} writes`);
      assert.ok(typeof v.endStateHash === 'string' && v.endStateHash.length > 0, `${id}: empty endStateHash`);
    }
  });

  it('G-05 base report counts every world test', opts(cap('checkWorld', 'check.seed', 'check.tests')), () => {
    const r = baseReport();
    assert.equal(r.ok, true, summarize(r));
    if (!r.ok) return;
    assert.equal(r.tests, Object.keys(baseWorld().tests).length, 'tests count');
  });

  it('G-05 base report returns the checked sections', CHECK, () => {
    const r = baseReport();
    assert.equal(r.ok, true, summarize(r));
    if (!r.ok) return;
    const base = baseWorld();
    assert.ok(Number.isInteger(r.tests) && r.tests >= 0, `tests is ${String(r.tests)}`);
    for (const s of SECTIONS) assert.deepEqual(Object.keys(r.world[s]).sort(), Object.keys(base[s]).sort(), `report.world.${s} keys`);
    assert.equal(r.world.meta.seed, base.meta.seed);
    assert.equal(r.world.meta.name, base.meta.name);
  });

  it('G-05 base world has no warnings', CHECK, () => {
    const r = baseReport();
    assert.deepEqual(r.warnings.map(describeIssue), []);
  });

  it('G-05 base stats count the hand-derived rows', SEEDED, () => {
    const r = baseReport();
    assert.equal(r.ok, true, summarize(r));
    if (!r.ok) return;
    assert.equal(r.stats.rows['agent'], FACTS.counts.agent);
    assert.equal(r.stats.rows['ticket'], FACTS.counts.ticket);
    assert.equal(r.stats.rows['job_run'] ?? 0, FACTS.counts.job_run);
    assert.deepEqual(Object.keys(r.stats.rows).filter((k) => !['agent', 'ticket', 'job_run'].includes(k)), [], 'rows for entities the world does not declare');
  });

  it('G-05 base stats count ticket states and list no unexercised action', cap('checkWorld', 'check.seed', 'check.tests'), () => {
    const r = baseReport();
    assert.equal(r.ok, true, summarize(r));
    if (!r.ok) return;
    assert.deepEqual(Object.keys(r.stats.states), ['ticket.status']);
    assert.deepEqual(r.stats.states['ticket.status'], FACTS.statusCounts);
    assert.deepEqual([...r.stats.unexercisedActions], []);
  });

  it('G-05 every world under test checks ok with one verdict per task', VERDICTS, async () => {
    for (const wut of await worldsUnderTest()) {
      const r = checkWorld(wut.input);
      assert.equal(r.ok, true, `${wut.name}\n${summarize(r)}`);
      if (!r.ok) continue;
      const tasks = isObj(wut.input) && isObj(wut.input['tasks']) ? Object.keys(wut.input['tasks']).sort() : [];
      assert.deepEqual(Object.keys(r.verdicts).sort(), tasks, wut.name);
    }
  });

  it('G-06 checking the base world twice gives deep-equal reports', CHECK, () => {
    assert.deepEqual(checkWorld(baseWorld()), checkWorld(baseWorld()));
  });

  it('G-06 a deep-frozen base world checks ok, like its unfrozen copy', CHECK, () => {
    const w = deepFreeze(baseWorld());
    const r = checkWorld(w);
    assert.equal(r.ok, true, summarize(r));
    // A frozen input cannot change, so compare reports instead: an engine that swallows a
    // write to a frozen object and carries on would differ here.
    assert.deepEqual(r, checkWorld(baseWorld()));
  });

  it('G-06 checking an unfrozen base world leaves it deep-equal to a fresh copy', CHECK, () => {
    // The ok path (defaults, seeding, task runs) must not write into the input either.
    const w = baseWorld();
    const r = checkWorld(w);
    assert.equal(r.ok, true, summarize(r));
    assert.deepEqual(w, baseWorld(), 'check mutated an ok input');
  });

  it('G-06 broken worlds are not mutated, and frozen or repeated checks agree', CHECK, () => {
    let covered = 0;
    for (const layer of CHECK_LAYERS) {
      const m = MUTATIONS.find((x) => x.layer === layer && !x.slow && x.todo === undefined && x.expect !== 'absent');
      if (!m) continue;
      const w = baseWorld();
      m.mutate(w);
      const snap = clone(w);
      const a = checkWorld(w);
      assert.deepEqual(w, snap, `${m.id}: check mutated its input`);
      assert.deepEqual(checkWorld(w), a, `${m.id}: second check differs`);
      assert.deepEqual(checkWorld(deepFreeze(clone(w))), a, `${m.id}: frozen input differs`);
      covered++;
    }
    assert.equal(covered, CHECK_LAYERS.length, 'a layer had no usable mutation row, so this test checked less than it says');
  });
});

/** Bun ignores Worker resourceLimits, so rows that expect snippet.memory hold only on Node (A-87). */
const HEAP_BOUND_SKIP: TestOptions = process.versions.bun !== undefined ? { skip: 'YOS-59: Bun ignores heap limits; the Node job enforces this' } : {};

describe('check: mutation rows (G-07)', () => {
  for (const m of ALL_ROWS) {
    const label = m.expect === 'absent' ? `no ${m.code}` : m.code;
    it(`G-07 ${m.id} ${m.note} -> ${label}`, opts(rowGate(m), rtTodo(m.todo), m.slow ? LONG : {}, m.code === 'snippet.memory' ? HEAP_BOUND_SKIP : {}), () => runRow(m));
  }
});

describe('check: layers (G-04)', () => {
  function assertBlockedOnce(r: CheckReport, sections: readonly Section[], label: string): void {
    const heads = blockedHeads(r);
    for (const s of sections) assert.equal(heads.filter((h) => h === s).length, 1, `${label}: layer.blocked on ${s}\n${summarize(r)}`);
  }
  /** Each layer.blocked hint names the layer that failed, not a fixed or wrong one. */
  function assertHintNames(r: CheckReport, failed: CheckLayer): void {
    const blocked = r.ok ? [] : r.issues.filter((i) => i.code === 'layer.blocked');
    assert.ok(blocked.length > 0, `no layer.blocked\n${summarize(r)}`);
    for (const i of blocked) {
      assert.ok(i.hint.includes(failed), `hint does not name the failed ${failed} layer: ${i.hint}`);
      const others = CHECK_LAYERS.filter((l) => l !== failed && new RegExp(`\\b${l}\\b layer`).test(i.hint));
      assert.deepEqual(others, [], `hint names another layer as failed: ${i.hint}`);
    }
  }

  it('G-04 a references failure blocks seed, tests and tasks once each and names the failed layer', CHECK, () => {
    const w = mutated('R01');
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'references', summarize(r));
    assertBlockedOnce(r, ['seed', 'tests', 'tasks'], 'R01');
    for (const i of r.issues) if (i.code === 'layer.blocked') assert.ok(i.hint.includes('references'), `hint does not name the failed layer: ${i.hint}`);
    assert.deepEqual(r.warnings.map(describeIssue), []);
    assertSound(r, { world: w });
  });

  it('G-04 a compile failure in tests blocks seed and tasks once each', CHECK, () => {
    const w = mutated('C07');
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'compile', summarize(r));
    assertBlockedOnce(r, ['seed', 'tasks'], 'C07');
    assertHintNames(r, 'compile');
    assertSound(r, { world: w });
  });

  it('G-04 a seed failure blocks tests and tasks once each and runs no test', rowGate(row('D01')), () => {
    const w = mutated('D01');
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'seed', summarize(r));
    assertBlockedOnce(r, ['tests', 'tasks'], 'D01');
    assertHintNames(r, 'seed');
    assert.deepEqual(r.issues.filter((i) => i.code === 'test.failed' || i.code.startsWith('task.')).map(describeIssue), []);
    assertSound(r, { world: w });
  });

  it('G-04 a failing world test blocks tasks once and verifies no task', rowGate(row('T01')), () => {
    const w = mutated('T01');
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'tests', summarize(r));
    assertBlockedOnce(r, ['tasks'], 'T01');
    assertHintNames(r, 'tests');
    assert.deepEqual(r.issues.filter((i) => i.code.startsWith('task.') || i.code === 'world.too_few_tasks').map(describeIssue), []);
    assertSound(r, { world: w });
  });

  it('G-04 a task failure reaches tasks and reports no lint', rowGate(row('GR-noop-half')), () => {
    const w = mutated('GR-noop-half');
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'tasks', summarize(r));
    assert.ok(r.issues.some((i) => i.code === 'task.noop_not_zero' && startsWith(i.path, ['tasks', 'pend_hd1005'])), summarize(r));
    assert.deepEqual(r.warnings.map(describeIssue), []);
    assertSound(r, { world: w });
  });

  it('G-04 a task failure, which skips only lints, adds no layer.blocked', opts(rowGate(row('GR-noop-half'))), () => {
    const r = checkWorld(mutated('GR-noop-half'));
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.deepEqual(blockedHeads(r), []);
  });

  it('G-02 a report lists no issue twice', opts(CHECK), () => {
    const p: string[] = [];
    for (const m of MUTATIONS.filter((x) => ISSUES[x.code].severity === 'error' && x.expect !== 'absent' && x.todo === undefined && !x.slow)) {
      const r = checkWorld(mutated(m.id));
      p.push(...duplicateIssues(r).map((d) => `${m.id}: ${d}`));
    }
    assert.deepEqual(p, []);
  });

  it('G-04 a schema failure hides a references failure', CHECK, () => {
    const w = mutated('S02', 'R01');
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'schema', summarize(r));
    assert.ok(r.issues.some((i) => i.code === 'schema.invalid' && startsWith(i.path, ['meta', 'seed'])), summarize(r));
    assert.deepEqual(r.issues.filter((i) => i.code === 'ref.unknown').map(describeIssue), []);
    assertSound(r, { world: w });
  });

  it('G-04 a references failure hides compile, seed and test failures', CHECK, () => {
    const w = mutated('R01', 'C01', 'D01', 'T01');
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'references', summarize(r));
    const late = r.issues.filter((i) => i.code.startsWith('snippet.') || i.code === 'constraint.violation' || i.code === 'test.failed');
    assert.deepEqual(late.map(describeIssue), []);
    assertSound(r, { world: w });
  });

  it('G-03 a world with only warnings is ok and lists each warning', cap('checkWorld', 'check.seed', 'check.tests', 'check.tasks', 'check.lints'), () => {
    const w = mutated('L01', 'L02', 'L05');
    const r = checkWorld(w);
    assert.equal(r.ok, true, summarize(r));
    const codes = new Set(r.warnings.map((i) => i.code));
    for (const c of ['seed.too_few_rows_for_paging', 'seed.state_mix_skewed', 'action.unexercised'] as const) assert.ok(codes.has(c), `missing ${c}\n${summarize(r)}`);
    assert.deepEqual([...codes].sort(), ['action.unexercised', 'seed.state_mix_skewed', 'seed.too_few_rows_for_paging'], `unexpected warnings\n${summarize(r)}`);
    if (r.ok) assert.deepEqual(Object.keys(r.verdicts).sort(), [...TASK_IDS].sort(), 'warnings must not cost verdicts');
    assertSound(r, { world: w });
  });

  // A-193: every issue of the failing layer is reported. A state machine contradiction (R09) is a schema-layer
  // issue since the strict field schemas (#69), so this asserts three references-layer issues together.
  it('G-04 every references issue is reported, not only the first', opts(CHECK), () => {
    const r = checkWorld(mutated('R01', 'R02', 'R03'));
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'references', summarize(r));
    const has = (code: IssueCode, prefix: readonly (string | number)[]) => r.issues.some((i) => i.code === code && startsWith(i.path, prefix));
    assert.ok(has('ref.unknown', ['routes', 'get_ticket']), summarize(r));
    assert.ok(has('ref.unknown', ['entities', 'ticket', 'fields', 'assignee']), summarize(r));
    assert.ok(has('ref.unknown', ['routes', 'list_tickets']), summarize(r));
  });

  it('G-04 every schema issue is reported, one per broken section', opts(CHECK), () => {
    const w: Loose = { format: 1, meta: baseWorld().meta };
    for (const s of SECTIONS) w[s] = 42;
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    for (const s of SECTIONS) assert.ok(r.issues.some((i) => i.code === 'schema.invalid' && i.path[0] === s), `no schema.invalid for ${s}\n${summarize(r)}`);
  });

  it('G-04 a failed agent seed does not cascade into ticket seed issues', opts(rowGate(row('D02'))), () => {
    const r = checkWorld(mutated('D02'));
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    const cascade = r.issues.filter((i) => i.code !== 'layer.blocked' && startsWith(i.path, ['seed', 'ticket']));
    assert.deepEqual(cascade.map(describeIssue), []);
  });
});

describe('check: prototype-named items (G-07)', () => {
  function invariance(label: string, add: (w: World, name: string) => void): void {
    const a = baseWorld();
    add(a, 'constructor');
    const b = baseWorld();
    add(b, 'redteam_extra');
    const ra = checkWorld(a);
    const rb = checkWorld(b);
    // Names are swapped for a placeholder so verdicts, row counts and test counts compare too.
    const shape = (r: CheckReport, name: string) => {
      const n = (k: string) => (k === name ? '<name>' : k);
      return {
        ok: r.ok,
        issues: (r.ok ? [] : r.issues).map((i) => `${i.code} ${pathText(i.path.map((x) => (typeof x === 'string' ? n(x) : x)))}`).sort(),
        warnings: r.warnings.map((i) => i.code).sort(),
        tests: r.ok ? r.tests : null,
        verdicts: r.ok ? Object.keys(r.verdicts).map(n).sort() : null,
        rows: r.ok ? Object.entries(r.stats.rows).map(([k, v]) => `${n(k)}=${String(v)}`).sort() : null,
      };
    };
    // The control must check ok, or the comparison is vacuous (both could fail the same way).
    assert.equal(rb.ok, true, `${label}: control redteam_extra\n${summarize(rb)}`);
    assert.deepEqual(shape(ra, 'constructor'), shape(rb, 'redteam_extra'), `${label}\nconstructor:\n${summarize(ra)}\nredteam_extra:\n${summarize(rb)}`);
    assertSound(ra, { world: a }, label);
  }

  it('G-07 a world test named constructor checks like any other name', CHECK, () => {
    invariance('test', (w, name) => { w.tests[name] = structuredClone(at(w.tests, 'escalate_ok')); });
  });

  it('G-07 an entity named constructor checks like any other name', CHECK, () => {
    invariance('entity', (w, name) => {
      w.entities[name] = { description: 'An extra entity.', idPrefix: 'xtra', fields: { label: field<'string'>({ type: 'string' }) } };
      w.seed[name] = '(ctx) => []';
    });
  });

  it('G-07 a task named constructor checks like any other name and gets its verdict', VERDICTS, () => {
    invariance('task', (w, name) => { w.tasks[name] = structuredClone(at(w.tasks, 'pend_hd1005')); });
    const w = baseWorld();
    w.tasks['constructor'] = structuredClone(at(w.tasks, 'pend_hd1005'));
    const r = checkWorld(w);
    assert.equal(r.ok, true, summarize(r));
    if (!r.ok) return;
    assert.ok(Object.hasOwn(r.verdicts, 'constructor'), 'no own verdict for task constructor');
    const v = at(r.verdicts, 'constructor');
    const twin = at(r.verdicts, 'pend_hd1005');
    assert.equal(v.taskId, 'constructor');
    // Same task body, so the same verdict apart from its id.
    assert.deepEqual({ ...v, taskId: '' }, { ...twin, taskId: '' });
  });
});

describe('check: garbage input never throws (G-01)', () => {
  it('G-01 primitives and functions give ok:false at the schema layer', CHECK, () => {
    const inputs: readonly [string, unknown][] = [
      ['null', null], ['undefined', undefined], ['0', 0], ['42', 42], ['-0', -0], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY],
      ["''", ''], ["'world'", 'world'], ["'format: 1'", 'format: 1'], ['true', true], ['false', false],
      ['Symbol', Symbol('world')], ['10n', 10n], ['function', () => baseWorld()],
    ];
    assert.deepEqual(inputs.flatMap(([label, x]) => garbageProblems(label, x, { schema: true })), []);
  });

  it('G-01 arrays give ok:false at the schema layer', CHECK, () => {
    const withProps = Object.assign([] as unknown[], baseWorld());
    const inputs: readonly [string, unknown][] = [
      ['[]', []], ['[world]', [baseWorld()]], ['sparse', new Array(5)], ['array with world keys', withProps], ['frozen []', Object.freeze([])],
    ];
    assert.deepEqual(inputs.flatMap(([label, x]) => garbageProblems(label, x, { schema: true })), []);
  });

  it('G-01 non-world objects give ok:false at the schema layer', CHECK, () => {
    class Fake {
      format = 1;
    }
    const inputs: readonly [string, unknown][] = [
      ['{}', {}], ['null prototype {}', Object.create(null)], ['{ format: 1 }', { format: 1 }], ['frozen {}', Object.freeze({})],
      ['Map of the world', new Map(Object.entries(baseWorld()))], ['Date', new Date(0)], ['RegExp', /world/], ['class instance', new Fake()],
      ['String object', new String('world')], ['Promise of the world', Promise.resolve(baseWorld())], ['Error', new Error('world')],
      ['Uint8Array of JSON', new TextEncoder().encode(JSON.stringify(baseWorld()))],
    ];
    assert.deepEqual(inputs.flatMap(([label, x]) => garbageProblems(label, x, { schema: true })), []);
  });

  it('G-01 every section of the wrong type gives ok:false at the schema layer', CHECK, () => {
    const p: string[] = [];
    for (const bad of [42, 'x', [], null, true]) {
      const w: Loose = { format: 1, meta: baseWorld().meta };
      for (const s of SECTIONS) w[s] = bad;
      p.push(...garbageProblems(`sections=${JSON.stringify(bad)}`, w, { schema: true }));
      const m: Loose = { ...baseWorld(), meta: bad };
      p.push(...garbageProblems(`meta=${JSON.stringify(bad)}`, m, { schema: true }));
    }
    assert.deepEqual(p, []);
  });

  it('G-01 a deep-frozen broken world never throws and checks like its unfrozen copy', CHECK, () => {
    const p: string[] = [];
    for (const m of MUTATIONS.filter((x) => x.layer === 'schema' || x.layer === 'references')) {
      const w = baseWorld();
      m.mutate(w);
      const unfrozen = clone(w);
      const { problems, report } = garbageCheck(m.id, deepFreeze(w), { fail: true });
      p.push(...problems);
      // A frozen-write TypeError swallowed into some generic issue would differ from this.
      if (problems.length === 0 && !isDeepStrictEqual(report, checkWorld(unfrozen))) p.push(`${m.id}: frozen and unfrozen reports differ`);
    }
    assert.deepEqual(p, []);
  });

  it('G-01 a null-prototype copy of the base world checks like the base world', CHECK, () => {
    const nullProto = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(nullProto);
      if (!isObj(x)) return x;
      const o: Loose = Object.create(null) as Loose;
      for (const [k, v] of Object.entries(x)) o[k] = nullProto(v);
      return o;
    };
    // Same data as the base world, so it decides the same way. No doc says a null-prototype
    // object must be accepted, so a precise schema refusal is also allowed.
    assert.deepEqual(likeControlProblems('null-prototype world', nullProto(baseWorld()), baseWorld(), SCHEMA_REFUSAL([]), baseWorld()), []);
  });

  // zod's z.json() accepts a cyclic value, and YAML anchors can produce one. Whether the engine
  // must refuse it is RT-88: format.ts types the field as JSON, and no doc says more.
  it('G-01 a cyclic meta.api.error (YAML alias loop) gives schema.invalid under meta', opts(CHECK), () => {
    const w = baseWorld();
    const cyc: Loose = { error: { code: '$code' } };
    cyc['self'] = cyc;
    loose(w.meta.api)['error'] = cyc;
    assertGarbage('cyclic error template', w, { schema: true, at: ['meta'] });
  });

  it('G-01 a cyclic fixture cell gives schema.invalid under fixtures', opts(CHECK), () => {
    const w = baseWorld();
    const cell: Loose = { first: 'A' };
    cell['me'] = cell;
    loose(w.fixtures)['people'] = [{ name: cell }];
    assertGarbage('cyclic fixture cell', w, { schema: true, at: ['fixtures'] });
  });

  it('G-01 a decoys array that contains itself gives schema.invalid under its decoys', opts(CHECK), () => {
    const w = baseWorld();
    const decoys = at(w.tasks, 'pend_open_urgent').decoys as unknown[];
    decoys.push(decoys);
    assertGarbage('self-containing decoys', w, { schema: true, at: ['tasks', 'pend_open_urgent', 'decoys'] });
  });

  it('G-01 a test that points back at the world gives schema.invalid under that test', CHECK, () => {
    const w = baseWorld();
    loose(w.tests)['loop'] = w;
    assertGarbage('world inside tests', w, { schema: true, at: ['tests', 'loop'] });
  });

  it('G-01 cycles under unknown keys check like plain values there', CHECK, () => {
    const w = baseWorld();
    loose(w)['self'] = w;
    loose(w.meta)['self'] = w.meta;
    loose(at(w.tasks, 'pend_hd1005'))['back'] = w.tasks;
    // Control: the same unknown keys holding plain values. Unknown keys are either stripped or
    // refused, and the cycle must not change which.
    const control = baseWorld();
    loose(control)['self'] = 'x';
    loose(control.meta)['self'] = 'x';
    loose(at(control.tasks, 'pend_hd1005'))['back'] = 'x';
    assert.deepEqual(likeControlProblems('cycles under unknown keys', w, control, SCHEMA_REFUSAL([])), []);
  });

  it('G-06 shared (YAML alias) subtrees check like their unshared copies', CHECK, () => {
    const w = baseWorld();
    w.tests['alias'] = at(w.tests, 'escalate_ok');
    at(w.entities, 'agent').fields['name'] = at(at(w.entities, 'ticket').fields, 'subject');
    const copy = JSON.parse(JSON.stringify(w)) as World;
    const before = JSON.stringify(w);
    const ra = checkWorld(w);
    const rb = checkWorld(copy);
    const shape = (r: CheckReport) => ({ ok: r.ok, issues: (r.ok ? [] : r.issues).map(describeIssue).sort(), warnings: r.warnings.map(describeIssue).sort() });
    // The unshared copy is a valid world, so the comparison is not between two failures.
    assert.equal(rb.ok, true, summarize(rb));
    assert.deepEqual(shape(ra), shape(rb));
    // Compare with a snapshot from before either check: comparing the two checked inputs
    // would miss an engine that mutates both the same way.
    assert.equal(JSON.stringify(w), before, 'check changed a shared subtree');
    assert.equal(JSON.stringify(copy), before, 'check changed its input');
  });

  it('G-01 __proto__ keys never throw and never pollute host prototypes', CHECK, () => {
    const before = protoSnapshot();
    const json = JSON.stringify(baseWorld());
    const inputs: readonly [string, unknown][] = [
      ['top-level __proto__', JSON.parse(`{"__proto__":{"rtPolluted":"top"},${json.slice(1)}`)],
      ['meta __proto__', (() => { const w = loose(JSON.parse(json)); w['meta'] = JSON.parse(`{"__proto__":{"rtPolluted":"meta"},${JSON.stringify(w['meta']).slice(1)}`); return w; })()],
      ['error template __proto__', (() => { const w = baseWorld(); loose(w.meta.api)['error'] = JSON.parse('{"__proto__":{"rtPolluted":"error"},"error":{"code":"$code"}}'); return w; })()],
      ['fixture row __proto__', (() => { const w = baseWorld(); loose(w.fixtures)['people'] = [JSON.parse('{"__proto__":{"rtPolluted":"fixture"},"name":"A"}')]; return w; })()],
      ['entities __proto__', (() => { const w = baseWorld(); loose(w)['entities'] = JSON.parse(`{"__proto__":{"rtPolluted":"entities"},${JSON.stringify(w.entities).slice(1)}`); return w; })()],
      ['task __proto__', (() => { const w = baseWorld(); loose(w)['tasks'] = JSON.parse(`{"__proto__":{"difficulty":"easy"},${JSON.stringify(w.tasks).slice(1)}`); return w; })()],
    ];
    const p = inputs.flatMap(([label, x]) => garbageProblems(label, x));
    assert.deepEqual(p, []);
    assert.equal(loose({})['rtPolluted'], undefined, 'Object.prototype was polluted');
    assert.deepEqual(protoSnapshot(), before);
  });

  // Stress inputs are compared with the same construction at size 3. A recursive walk that
  // overflows the stack, or a catch-all that turns a crash into some issue, decides differently.
  function bulkEntities(n: number): World {
    const w = baseWorld();
    for (let i = 0; i < n; i++) w.entities[`e${i}`] = { description: 'bulk', idPrefix: prefixOf(i), fields: { label: field<'string'>({ type: 'string' }) } };
    return w;
  }

  function refChain(n: number): World {
    const w = baseWorld();
    for (let i = 0; i < n; i++) {
      const fields: World['entities'][string]['fields'] = { label: field<'string'>({ type: 'string' }) };
      if (i > 0) fields['prev'] = field<'ref'>({ type: 'ref', entity: `e${i - 1}`, nullable: true, onDelete: 'restrict' });
      w.entities[`e${i}`] = { description: 'chain', idPrefix: prefixOf(i), fields };
    }
    return w;
  }

  it('G-01 a world of 10k entities checks like a world of 3', opts(CHECK, LONG), () => {
    assert.deepEqual(likeControlProblems('10k entities', bulkEntities(10_000), bulkEntities(3), SCHEMA_REFUSAL(['entities'])), []);
  });

  it('G-01 a 10k-long chain of refs checks like a chain of 3', opts(CHECK, LONG), () => {
    assert.deepEqual(likeControlProblems('10k ref chain', refChain(10_000), refChain(3), SCHEMA_REFUSAL(['entities'])), []);
  });

  it('G-01 a 10k-long cycle of required refs gives seed.cycle', opts(CHECK, LONG), () => {
    const n = 10_000;
    const w = loose(baseWorld());
    const entities = loose(w['entities'] as object);
    for (let i = 0; i < n; i++) {
      const prev = field<'ref'>({ type: 'ref', entity: `e${(i + n - 1) % n}`, required: true, onDelete: 'restrict' });
      entities[`e${i}`] = { description: 'cycle', idPrefix: prefixOf(i), fields: { prev } };
    }
    const r = checkWorld(w);
    assert.equal(r.ok, false, summarize(r));
    if (r.ok) return;
    assert.equal(r.reached, 'references', summarize(r));
    assert.ok(r.issues.some((i) => i.code === 'seed.cycle' && i.path[0] === 'entities'), summarize(r));
    assertSound(r, { world: w });
  });

  it('G-01 10k fixture rows check like 3', opts(CHECK, LONG), () => {
    const people = (n: number): World => {
      const w = baseWorld();
      loose(w.fixtures)['people'] = Array.from({ length: n }, (_, i) => ({ name: `P${i}`, n: i, ok: i % 2 === 0, gone: null }));
      return w;
    };
    assert.deepEqual(likeControlProblems('10k fixture rows', people(10_000), people(3), SCHEMA_REFUSAL(['fixtures'])), []);
  });

  const nestArr = (n: number): unknown => {
    let x: unknown = 0;
    for (let i = 0; i < n; i++) x = [x];
    return x;
  };
  const nestObj = (n: number): unknown => {
    let x: unknown = 'leaf';
    for (let i = 0; i < n; i++) x = { d: x };
    return x;
  };
  const deepCell = (n: number): World => {
    const w = baseWorld();
    loose(w.fixtures)['people'] = [{ name: nestArr(n) }];
    return w;
  };
  const deepTemplate = (n: number): World => {
    const w = baseWorld();
    loose(w.meta.api)['error'] = nestObj(n);
    return w;
  };
  const deepUnknownKey = (n: number): World => {
    const w = baseWorld();
    loose(w)['extra'] = nestArr(n);
    return w;
  };

  it('G-01 100k-deep nesting never throws and gives a sound report', opts(CHECK, LONG), () => {
    assert.deepEqual(
      [
        // A fixture cell must be a scalar (row S23), so this is a schema refusal at any depth.
        ...garbageProblems('deep fixture cell', deepCell(100_000), { schema: true }),
        ...garbageProblems('deep error template', deepTemplate(100_000)),
        ...likeControlProblems('deep unknown key', deepUnknownKey(100_000), deepUnknownKey(3), SCHEMA_REFUSAL([])),
        ...garbageProblems('deep bare array', nestArr(100_000), { schema: true }),
      ],
      [],
    );
  });

  // RT-89, A-194: input nested deeper than 64 levels is refused before zod parses it, at the deep value's section.
  it('G-01 100k-deep nesting is refused at the deep value or checks like shallow nesting', opts(CHECK, LONG), () => {
    assert.deepEqual(
      [
        ...garbageProblems('deep fixture cell', deepCell(100_000), { schema: true, at: ['fixtures'] }),
        ...likeControlProblems('deep error template', deepTemplate(100_000), deepTemplate(3), SCHEMA_REFUSAL(['meta'])),
      ],
      [],
    );
  });

  it('G-01 huge strings never throw and check like short ones', opts(CHECK, LONG), () => {
    const desc = baseWorld();
    desc.meta.description = 'd'.repeat(8_000_000);
    const snippet = baseWorld();
    snippet.seed['job_run'] = `(ctx) => { /* ${'c'.repeat(2_000_000)} */ return []; }`;
    const longName = (n: number): World => {
      const w = baseWorld();
      w.entities[`e${'x'.repeat(n)}`] = { description: 'long name', idPrefix: 'lng', fields: {} };
      return w;
    };
    const seed = baseWorld();
    loose(seed.meta)['seed'] = 's'.repeat(5_000_000);
    // No documented size limit, so each checks like its short control. A deliberate size cap
    // is allowed only as a precise refusal at the oversized value.
    assert.deepEqual(
      [
        ...likeControlProblems('8MB description', desc, baseWorld(), SCHEMA_REFUSAL(['meta'])),
        ...likeControlProblems('2MB snippet', snippet, baseWorld(), {
          layers: ['schema', 'compile'], codes: ['schema.invalid', 'snippet.compile_error'], prefixes: [['seed', 'job_run']],
        }),
        ...likeControlProblems('100k-char entity name', longName(100_000), longName(3), SCHEMA_REFUSAL(['entities'])),
        ...garbageProblems('5MB string seed', seed, { schema: true, at: ['meta', 'seed'] }),
      ],
      [],
    );
  });

  it('G-02 issue text stays bounded when the input holds a 5MB string', opts(CHECK, LONG), () => {
    const w = baseWorld();
    loose(w.meta)['seed'] = 's'.repeat(5_000_000);
    const r = checkWorld(w);
    assert.equal(r.ok, false);
    if (r.ok) return;
    for (const i of r.issues) for (const k of ['expected', 'found', 'hint'] as const) assert.ok(i[k].length <= MAX_ISSUE_TEXT, `${i.code} ${k} is ${i[k].length} chars`);
  });

  it('G-01 lone surrogates never throw and check like well-formed text', CHECK, () => {
    const desc = baseWorld();
    desc.meta.description = 'a\uD800b\uDFFFc';
    at(desc.entities, 'ticket').description = '\uDC00';
    const key = baseWorld();
    key.entities['bad\uD800'] = structuredClone(at(key.entities, 'agent'));
    const seedValue = baseWorld();
    seedValue.seed['ticket'] = (seedValue.seed['ticket'] ?? '').replace("'Case ' + (i + 1)", "'Case \\uD800' + (i + 1)");
    const comment = baseWorld();
    at(comment.tests, 'escalate_ok').description = 'surrogate \uD83D';
    at(comment.tests, 'escalate_ok').script = `/* \uDE00 */ ${at(comment.tests, 'escalate_ok').script}`;
    assert.ok(seedValue.seed['ticket']?.includes('\\uD800'), 'fixture: the seed replace did not apply');
    // Lone surrogates are legal JS strings. Each world checks like the base world, unless the
    // engine refuses ill-formed text on purpose, precisely, at the value that holds it.
    assert.deepEqual(
      [
        ...likeControlProblems('lone surrogate descriptions', desc, baseWorld(), SCHEMA_REFUSAL(['meta'], ['entities', 'ticket'])),
        ...garbageProblems('lone surrogate entity key', key, { schema: true, at: ['entities'] }),
        ...likeControlProblems('lone surrogate in seeded subjects', seedValue, baseWorld(), {
          layers: ['seed'], codes: ['constraint.violation'], prefixes: [['seed', 'ticket']],
        }),
        ...likeControlProblems('lone surrogate in a test', comment, baseWorld(), {
          layers: ['schema', 'compile'], codes: ['schema.invalid', 'snippet.compile_error'], prefixes: [['tests', 'escalate_ok']],
        }),
      ],
      [],
    );
  });
});

describe('check: seed snippets stay in the sandbox (G-21)', () => {
  const ESCAPES: readonly [string, string][] = [
    ['ctx.rng.constructor', "ctx.rng.constructor('return globalThis')()"],
    ['ctx.time.plus.constructor', "ctx.time.plus.constructor('return globalThis')()"],
    ['ctx.rows(...).constructor.constructor', "ctx.rows('agent').constructor.constructor('return globalThis')()"],
    ['ctx.fixtures.constructor.constructor', "ctx.fixtures.constructor.constructor('return globalThis')()"],
    ['ctx prototype constructor', "Object.getPrototypeOf(ctx).constructor.constructor('return globalThis')()"],
    [
      'error thrown by a ctx call',
      "(() => { try { ctx.pick([]); ctx.int('a', 'b'); ctx.rows(42); ctx.time.plus('x', 'y'); } catch (e) { return e.constructor.constructor('return globalThis')(); } return null; })()",
    ],
  ];

  for (const [label, expr] of ESCAPES) {
    it(`G-21 seed cannot reach the host realm through ${label}`, SEEDED, () => {
      const marker = `__rt_escape_${label.replace(/\W+/g, '_')}`;
      const w = baseWorld();
      // G-21: Function from strings fails. If it works at all, in any realm or worker, the seed
      // returns [] instead of throwing, so the world checks ok and the test fails even when the
      // host globalThis is out of reach (a worker or child process has its own).
      w.seed['job_run'] = `(ctx) => {
  let g = null;
  try { g = ${expr}; } catch (e) { g = null; }
  if (g && typeof g === 'object') { try { g[${JSON.stringify(marker)}] = true; } catch (e) {} return []; }
  throw new Error('probe end');
}`;
      try {
        const r = checkWorld(w);
        assert.equal(loose(globalThis)[marker], undefined, `seed reached the host globalThis through ${label}`);
        assert.equal(r.ok, false, `seed built code from a string through ${label}\n${summarize(r)}`);
        if (r.ok) return;
        assert.equal(r.reached, 'seed', summarize(r));
        assert.ok(r.issues.some((i) => i.code === 'snippet.runtime_error' && startsWith(i.path, ['seed', 'job_run'])), summarize(r));
        assertSound(r, { world: w });
      } finally {
        delete loose(globalThis)[marker];
      }
    });
  }

  it('G-21 seed cannot pollute host prototypes through ctx objects', opts(SEEDED), () => {
    const before = protoSnapshot();
    const w = baseWorld();
    w.seed['job_run'] = `(ctx) => {
  for (const o of [ctx, ctx.fixtures, ctx.rows('job_run'), ctx.time, ctx.rng, ctx.time.plus]) {
    try {
      let p = o;
      while (p && Object.getPrototypeOf(p)) p = Object.getPrototypeOf(p);
      if (p) Object.defineProperty(p, '__rt_polluted', { value: 1, configurable: true });
    } catch (e) {}
  }
  throw new Error('probe end');
}`;
    try {
      const r = checkWorld(w);
      assert.equal(Object.hasOwn(Object.prototype, '__rt_polluted'), false, 'seed polluted the host Object.prototype');
      assert.deepEqual(protoSnapshot(), before);
      assert.equal(r.ok, false, summarize(r));
      if (r.ok) return;
      assert.equal(r.reached, 'seed', summarize(r));
      assert.ok(r.issues.some((i) => i.code === 'snippet.runtime_error' && startsWith(i.path, ['seed', 'job_run'])), summarize(r));
      assert.equal(checkWorld(baseWorld()).ok, true, 'the base world stopped checking after the probe');
    } finally {
      delete loose(Object.prototype)['__rt_polluted'];
    }
  });
});

// ---------------------------------------------------------------------------------------
// Fuzz: random multi-mutations

/**
 * Rows whose error is certain on their own: no warnings, no absent rows, no RT, not slow.
 * Only rows whose unit has landed (all rows under REDTEAM_STRICT=1): a pass-through stub layer
 * lets its own row check ok. The pool widens by itself as units land.
 */
const FUZZ_POOL: readonly Mutation[] = MUTATIONS.filter(
  (m) => ISSUES[m.code].severity === 'error' && m.expect !== 'absent' && m.todo === undefined && !m.slow && landed(m),
);

/** A failure reason, or null when the combined rows check as expected (or none applied). */
function fuzzOutcome(rows: readonly Mutation[]): string | null {
  const w = baseWorld();
  let applied = 0;
  // Layers of every attempted row, applied or not: a row that throws part-way may still have
  // left an edit behind, so counting it only widens the allowed set.
  const layers = new Set<CheckLayer>();
  for (const m of rows) {
    layers.add(m.layer);
    try {
      m.mutate(w);
      applied++;
    } catch {
      // An earlier row removed what this one edits.
    }
  }
  if (applied === 0) return null;
  let r: unknown;
  try {
    r = checkWorld(w);
  } catch (e) {
    return `checkWorld threw ${errText(e)}`;
  }
  if (isObj(r) && r['ok'] === true) return 'ok:true for a world with an error mutation';
  const p = reportProblems(r, { world: w });
  // Each row fails at its own layer, and a later row can only replace an earlier row's edit,
  // so the first failing layer is one of theirs. An engine reporting garbage codes at some
  // other layer passes every check above.
  if (isObj(r) && isLayer(r['reached']) && !layers.has(r['reached'])) p.push(`reached ${r['reached']}, but the rows fail at ${[...layers].join(', ')}`);
  return p.length > 0 ? p.join('; ') : null;
}

function fuzzCase(seed: number): string[] {
  const r = rng(seed);
  return r.shuffle(FUZZ_POOL).slice(0, r.int(2, 4)).map((m) => m.id);
}

const FUZZ_TOTAL = process.env['REDTEAM_ITER'] ? ITER : 300;
const FUZZ_BATCH = 50;

describe('check: fuzz (G-01, G-04)', () => {
  const all = seeds(FUZZ_TOTAL);
  for (let b = 0; b < all.length; b += FUZZ_BATCH) {
    const batch = all.slice(b, b + FUZZ_BATCH);
    const first = batch[0];
    const last = batch[batch.length - 1];
    it(`G-01 random multi-mutations never throw, never pass and never cascade (seeds ${first}..${last})`, opts(CHECK, LONG), () => {
      for (const seed of batch) {
        const ids = fuzzCase(seed);
        const outcome = fuzzOutcome(ids.map(row));
        if (outcome !== null) {
          failWithRepro('G-01 checkWorld on combined mutation rows', seed, ids, (subset) => fuzzOutcome(subset.map(row)) !== null, outcome.slice(0, 2000));
        }
      }
    });
  }
});

/** A unique 2 to 5 letter idPrefix for bulk entity i. */
function prefixOf(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `z${s.padStart(3, 'a')}`;
}
