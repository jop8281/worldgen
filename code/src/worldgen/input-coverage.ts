import { isDeepStrictEqual } from 'node:util';
import { checkWorld, createRuntime, issue, routeKey, type CheckIssue, type CheckReport, type World, choicesOf, refOf, temporalOf } from '#engine';
import { FIXTURE_ROWS_MAX, singular, type InputDigest } from './input.ts';
import type { Plan } from './plan.ts';

/** Most distinct values a CSV column may hold and still be read as a state column without being named status or state. */
const STATE_VALUES_MAX = 10;

function referencesFixture(source: string, table: string): boolean {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bctx\\s*\\.\\s*fixtures\\s*(?:\\.\\s*${escaped}\\b|\\[\\s*(['"])${escaped}\\1\\s*\\])`).test(source);
}

/** Entities whose seed rows come from a fixture table: named for it (`customers` or `customer`), or seeded by code that reads it. */
export function fixtureFed(world: World): ReadonlySet<string> {
  const tables = Object.keys(world.fixtures);
  return new Set(Object.keys(world.entities).filter((entity) =>
    tables.some((table) => table === entity || singular(table) === entity || referencesFixture(world.seed[entity] ?? '', table))));
}

const VALUE_EXAMPLES_MAX = 3;
type Cell = string | number | boolean | null;

const asInstant = (text: string): number => Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text}Z`);
const asWord = (text: string): string => text.trim().toLowerCase().replace(/[\s_-]+/g, '_');
/**
 * What a time column should hold for an imported instant cell: the same instant in ISO 8601 UTC, or in whole seconds
 * when the seed wrote a number. A date with no time, such as 2026-08-28, is midnight UTC (YOS-247). Null for a cell that
 * is not an instant.
 */
function instantToWrite(expected: Cell, found: Cell): string | null {
  if (typeof expected !== 'string' || !/\d{4}-\d\d-\d\d/.test(expected)) return null;
  const at = asInstant(expected);
  if (!Number.isFinite(at)) return null;
  return typeof found === 'number' ? String(Math.floor(at / 1000)) : new Date(at).toISOString();
}

/**
 * Cells are equal when they are the same value, the same text of a number, the same instant (a time
 * with no zone is UTC), or the same word ignoring case, spacing, `-` and `_`: world enums are snake_case.
 */
function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (x === null || y === null) return false;
  if (String(x) === String(y)) return true;
  if (typeof x !== 'string' || typeof y !== 'string') return false;
  const tx = asInstant(x);
  return (Number.isFinite(tx) && /\d{4}-\d\d-\d\d/.test(x) && tx === asInstant(y)) || asWord(x) === asWord(y);
}

/**
 * Seeded values against the imported rows, for the columns the entity has a plain field for. Ids and
 * refs are skipped, because the engine mints ids. Rows pair by the first column whose imported values
 * are all present and distinct, or by position when none is. A time column may be null where the import
 * has a time only when the row's imported status says it does not apply yet: an enum or state column
 * of that row that the seed kept unchanged (a created shipment has no shipped_at). A seed may drop or add rows (the count
 * check owns that), so an imported row with no seeded partner is not a mismatch here. A time column's example also names
 * the value to write (`instantToWrite`), so the seed step can fix an instant on its own.
 */
function valueMismatches(world: World, seeded: readonly object[], entity: string, fixtures: InputDigest['fixtures'][string]): string | null {
  const fields = world.entities[entity]?.fields ?? {};
  const is = (c: string, test: (def: Parameters<typeof temporalOf>[0]) => boolean): boolean => {
    const def = fields[c];
    return def !== undefined && test(def);
  };
  const columns = Object.keys(fixtures[0] ?? {}).filter((c) => c !== 'id' && Object.hasOwn(fields, c) && !is(c, (d) => refOf(d) !== undefined) && !c.endsWith('_id'));
  if (columns.length === 0) return null;
  const cellOf = (row: object, c: string): Cell | undefined => (row as Record<string, Cell | undefined>)[c];
  const key = columns.find((c) => {
    const values = fixtures.map((r) => r[c]);
    return values.every((v) => v !== null && v !== undefined) && new Set(values.map(String)).size === values.length;
  });
  const statusColumns = columns.filter((c) => is(c, (d) => choicesOf(d) !== undefined));
  const bySeed = key === undefined ? null : new Map(seeded.map((r) => [String(cellOf(r, key)), r]));
  const bad: string[] = [];
  let total = 0;
  fixtures.forEach((fixture, n) => {
    const partner = key === undefined || bySeed === null ? seeded[n] : bySeed.get(String(fixture[key]));
    if (partner === undefined) return;
    for (const c of columns) {
      const timed = is(c, temporalOf);
      const explained = timed && cellOf(partner, c) == null && statusColumns.some((sc) => sameCell(cellOf(partner, sc), fixture[sc]));
      if (c === key || explained || sameCell(cellOf(partner, c), fixture[c])) continue;
      total += 1;
      if (bad.length >= VALUE_EXAMPLES_MAX) continue;
      const expected = fixture[c] ?? null;
      const found = cellOf(partner, c) ?? null;
      const write = timed ? instantToWrite(expected, found) : null;
      bad.push(`row ${n + 1}${key === undefined ? '' : ` (${key}=${JSON.stringify(fixture[key])})`} ${c}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(found)}${write === null ? '' : `, write ${write}`}`);
    }
  });
  return total === 0 ? null : `${bad.join('; ')}${total > bad.length ? `; ${total - bad.length} more differ` : ''}`;
}

/** Original input contracts, independent of what the model chose to put in its plan. */
export function inputCoverage(digest: InputDigest, world: World, report?: CheckReport): readonly CheckIssue[] {
  const out: CheckIssue[] = [];
  if (digest.kind === 'openapi') {
    const have = new Set([...Object.values(world.routes), ...Object.values(world.actions)].map((r) => routeKey(r.method, r.path)));
    for (const operation of digest.operations) {
      if (have.has(routeKey(operation.method, operation.path))) continue;
      const contract = `${operation.method} ${operation.path}`;
      out.push(issue('plan.not_covered', ['routes', contract], { item: `input operation ${contract}` }, 'no route or action with this method and path'));
    }
    if (digest.apiShape !== null && !isDeepStrictEqual(world.meta.api.error, digest.apiShape.error)) {
      out.push(issue('plan.not_covered', ['meta', 'api', 'error'], { item: 'input error template' }, JSON.stringify(world.meta.api.error)));
    }
  }
  if (digest.kind !== 'csv') return out;
  const checked = report ?? checkWorld(world);
  for (const [table, fixtures] of Object.entries(digest.fixtures)) {
    const named = [table, singular(table)].find((name) => Object.hasOwn(world.entities, name));
    const mapped = named === undefined
      ? Object.keys(world.entities).filter((entity) => referencesFixture(world.seed[entity] ?? '', table))
      : [named];
    if (mapped.length === 0) {
      out.push(issue('plan.not_covered', ['seed', table], { item: `CSV fixture ${table}` }, 'no entity seed references this fixture'));
      continue;
    }
    const expected = Math.min(fixtures.length, FIXTURE_ROWS_MAX);
    const rowsIn = (entity: string): readonly object[] | null => (checked.ok ? createRuntime(checked.world).dump().tables[entity] ?? [] : checked.seeded?.[entity] ?? null);
    const rowsOf = (entity: string): number | null => (checked.ok ? checked.stats.rows[entity] ?? 0 : rowsIn(entity)?.length ?? null);
    const full = (entity: string): boolean => referencesFixture(world.seed[entity] ?? '', table) && (rowsOf(entity) === null || (rowsOf(entity) ?? 0) >= expected);
    // A table no entity is named for may feed several (issues, and the labels derived from them): one entity seeding it in full is enough.
    const derived = named === undefined && mapped.some(full);
    for (const entity of mapped) {
      if (full(entity)) {
        const seeded = rowsIn(entity);
        const differs = seeded === null ? null : valueMismatches(world, seeded, entity, fixtures);
        if (differs !== null) out.push(issue('plan.not_covered', ['seed', entity], { item: `CSV fixture ${table} values in ${entity} seed` }, differs));
        continue;
      }
      if (derived) continue;
      const found = !referencesFixture(world.seed[entity] ?? '', table) ? `seed does not reference ctx.fixtures.${table}` : `${rowsOf(entity)} seeded rows; expected at least ${expected} from ${table}`;
      out.push(issue('plan.not_covered', ['seed', entity], { item: `CSV fixture ${table} in ${entity} seed` }, found));
    }
  }
  return out;
}

/**
 * Each input operation the plan's routes do not name by method and path (YOS-244). Coverage of an operation is owned by
 * the model step unless a plan route with its method and path shares a workflow action's id, so an operation the plan
 * leaves out lands on the model step even when the workflow builds it as an action, and that route then collides with
 * the action (route.duplicate_path) in a section the workflow step cannot edit. The plan step names each one instead.
 */
export function operationPlanIssues(plan: Plan, digest: InputDigest): CheckIssue[] {
  if (digest.kind !== 'openapi' || plan.verdict.kind !== 'proceed') return [];
  const planned = new Set(plan.routes.map((r) => routeKey(r.method, r.path)));
  return digest.operations
    .filter((o) => !planned.has(routeKey(o.method, o.path)))
    .map((o) => issue('plan.not_covered', ['plan', 'routes', `${o.method} ${o.path}`], { item: `input operation ${o.method} ${o.path}` },
      'no plan route with this method and path; list it in routes, and give it the workflow action\'s name as its id when an action builds it'));
}

/**
 * Where a plan changes an imported CSV table that the seed must keep exactly: more rows planned for
 * its entity than the table holds, or a workflow on that entity whose states leave out values of the
 * table's state column. Every seed attempt would then fail fixture fidelity, so the plan step gets
 * these instead (A-221). A state column is named status or state, or holds at most STATE_VALUES_MAX
 * distinct values of which at least two are planned states.
 */
export function fixturePlanIssues(plan: Plan, digest: InputDigest): CheckIssue[] {
  if (digest.kind !== 'csv' || plan.verdict.kind !== 'proceed') return [];
  const planned = new Set(plan.entities.map((e) => e.name));
  const out: CheckIssue[] = [];
  for (const [table, rows] of Object.entries(digest.fixtures)) {
    const entity = [table, singular(table)].find((name) => planned.has(name));
    if (entity === undefined) continue;
    const have = Math.min(rows.length, FIXTURE_ROWS_MAX);
    const want = Object.hasOwn(plan.seed.rowsPerEntity, entity) ? plan.seed.rowsPerEntity[entity]! : undefined;
    if (want !== undefined && want > have) {
      out.push(issue('plan.fixture_changed', ['plan', 'seed', 'rowsPerEntity', entity], { entity, table, problem: `rowsPerEntity plans ${want} ${entity} rows, but ${table} has ${have}` }, String(want)));
    }
    plan.workflows.forEach((w, wi) => {
      if (w.entity !== entity) return;
      const states = new Set(w.states);
      for (const column of Object.keys(rows[0] ?? {})) {
        const values = [...new Set(rows.map((r) => r[column]).filter((v): v is string => typeof v === 'string' && v !== ''))];
        const shared = values.filter((v) => states.has(v)).length;
        const isState = column === 'status' || column === 'state' || (values.length <= STATE_VALUES_MAX && shared >= 2);
        const missing = values.filter((v) => !states.has(v));
        if (!isState || missing.length === 0) continue;
        out.push(issue('plan.fixture_changed', ['plan', 'workflows', wi, 'states'], {
          entity, table, problem: `${table}.${column} holds ${missing.join(', ')}, which workflow ${w.name} does not list as states`,
        }, JSON.stringify(w.states)));
      }
    });
  }
  return out;
}
