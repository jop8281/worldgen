/**
 * World state and the only way to change it.
 *
 * Invariants:
 * - State is immutable. `transact` runs a function against an overlay and returns a new
 *   State on success. Any throw (EnforceError, ctx.fail, runtime error) discards the overlay.
 *   A failed call leaves no partial change.
 * - The store checks every write when it happens. It checks type (via FIELD_TYPES), required,
 *   unique, ref resolution, onDelete, readonly, and state transitions measured from the value
 *   before the transaction.
 * - Ids are per-entity counters (`tkt_0001`). Lists are ordered by id.
 * - `id`, `created_at` and `updated_at` are engine fields on every entity.
 */
import { fromIso, timeMath, toIso, type Instant } from './clock.ts';
import { SnippetFault, type SeedCtx, type SnippetHost, type Where } from './ctx.ts';
import { FIELD_TYPES, initialOf, kindOf, machineOf, refOf, type Field, type Value } from './fields.ts';
import type { Entity, World } from './format.ts';
import { issue, type CheckIssue, type IssuePath } from './issues.ts';

export type RowId = string & { readonly __brand: 'RowId' };
export type Row = Readonly<Record<string, Value>> & { readonly id: RowId };

/**
 * Deterministic POST retry metadata. It is engine state: dumps and stateHash() include it so
 * evidence survives restart and detects edits, while graders still inspect domain tables/journal.
 */
export type IdempotencyEntry = {
  readonly fingerprint: string;
  readonly routeId: string | null;
  readonly response: unknown;
};

export type State = {
  readonly now: Instant;
  readonly tables: Readonly<Record<string, ReadonlyMap<RowId, Row>>>;
  readonly counters: Readonly<Record<string, number>>;
  readonly idempotency?: ReadonlyMap<string, IdempotencyEntry>;
};

export type WriteMode = 'api' | 'privileged' | 'seed'; // privileged: actions and jobs set readonly fields; seed also starts rows in any state (A-146)

export interface Tx {
  readonly now: Instant;
  get(entity: string, id: string): Row | null;
  list(entity: string, q?: { where?: Where }): readonly Row[];
  create(entity: string, data: Record<string, unknown>, mode: WriteMode): Row;
  update(entity: string, id: string, patch: Record<string, unknown>, mode: WriteMode): Row;
  delete(entity: string, id: string): void;
}

export type FieldProblem = { readonly field: string; readonly expected: string; readonly found: string };
export class EnforceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly problems: readonly FieldProblem[] = [],
  ) {
    super(message);
  }
}

const ENGINE_TIME_FIELDS = ['created_at', 'updated_at'] as const;
const ID_DIGITS = 4;
const DATETIME_DEF: Field = FIELD_TYPES.datetime.schema.parse({ type: 'datetime' });

/** `found` text for a problem. JSON, so strings are quoted and numbers are not. */
const show = (v: unknown): string => (v === undefined ? 'missing' : JSON.stringify(v) ?? String(v));

/** The message of a field.unique refusal and its parse, defined once so check can name the row that holds the value. */
export const uniqueClash = {
  message: (entity: string, field: string, value: unknown, rowId: string): string => `${entity}.${field} ${show(value)} is already used by ${rowId}`,
  /** `value` stays as shown (JSON). Null for any other message. */
  parse: (message: string): { entity: string; field: string; value: string; rowId: string } | null => {
    const m = /^(\w+)\.(\w+) (.+) is already used by (\S+)$/s.exec(message);
    return m === null ? null : { entity: m[1]!, field: m[2]!, value: m[3]!, rowId: m[4]! };
  },
};

/** Id order: shorter numeric suffix first, then code units, so _10000 sorts after _9999 on any host. */
const cmpId = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

function freezeRow(r: Record<string, Value>): Row {
  return Object.freeze(r) as Row;
}

export function emptyState(world: World): State {
  const names = Object.keys(world.entities);
  return {
    now: fromIso(world.meta.clock.start),
    tables: Object.fromEntries(names.map((n) => [n, new Map<RowId, Row>()])),
    counters: Object.fromEntries(names.map((n) => [n, 0])),
    idempotency: new Map(),
  };
}

/** The state a runtime starts from: the seeded state. Throws only for a world check() rejects. */
export function initialState(world: World, host: SnippetHost): State {
  const r = seedState(world, host);
  if (!r.ok) throw new Error(`Seeding failed at ${r.issue.path.join('.')}: ${r.issue.code} ${r.issue.found}`);
  return r.state;
}

/**
 * Entities in seed order. Each entity comes after every entity it refs through a field that
 * cannot be null (not nullable, or required): the same edges check()'s seed.cycle uses, so any
 * world check() accepts has such an order. Nullable refs are a soft preference: among the
 * entities ready to seed, one whose nullable refs are also seeded goes first. Ties go to
 * declaration order. Self-refs and unknown entities are ignored. A hard cycle (check() rejects
 * it) falls back to declaration order for the entities left.
 */
export function seedOrder(world: World): string[] {
  const names = Object.keys(world.entities);
  const hard = new Map(names.map((n) => [n, new Set<string>()]));
  const soft = new Map(names.map((n) => [n, new Set<string>()]));
  for (const [n, e] of Object.entries(world.entities)) {
    for (const def of Object.values(e.fields)) {
      const ref = refOf(def);
      if (ref === undefined || ref.entity === n || !hard.has(ref.entity)) continue;
      (def.nullable && !def.required ? soft : hard).get(n)!.add(ref.entity);
    }
  }
  const out: string[] = [];
  const done = new Set<string>();
  const seeded = (deps: ReadonlySet<string>): boolean => [...deps].every((d) => done.has(d));
  while (out.length < names.length) {
    const left = names.filter((n) => !done.has(n));
    const ready = left.filter((n) => seeded(hard.get(n)!));
    const next = ready.find((n) => seeded(soft.get(n)!)) ?? ready[0] ?? left[0]!;
    done.add(next);
    out.push(next);
  }
  return out;
}

/** 32-bit FNV-1a. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small seeded PRNG in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const article = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  return /^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`;
};

class SeedError extends Error {}

/**
 * The refs a seed may leave pointing at a row seeded later: nullable ref fields whose target entity
 * is the same entity or comes at or after it in seed order. The seed layer checks they resolve once
 * every entity is seeded. A required or non-nullable ref never defers, so it still needs its row.
 */
function deferredRefs(world: World, order: readonly string[]): { map: Map<string, Set<string>>; targets: Map<string, Map<string, string>> } {
  const map = new Map<string, Set<string>>();
  const targets = new Map<string, Map<string, string>>();
  order.forEach((entity, i) => {
    for (const [field, def] of Object.entries(world.entities[entity]!.fields)) {
      const ref = refOf(def);
      if (ref === undefined || !def.nullable || def.required || !Object.hasOwn(world.entities, ref.entity)) continue;
      if (order.indexOf(ref.entity) < i) continue;
      map.set(entity, (map.get(entity) ?? new Set()).add(field));
      targets.set(entity, (targets.get(entity) ?? new Map()).set(field, ref.entity));
    }
  });
  return { map, targets };
}

/**
 * Runs every seed snippet in seedOrder against a fresh state. Each entity's rows are created
 * in one privileged transaction. Stops at the first entity that fails and returns its issue.
 */
export function seedState(world: World, host: SnippetHost): { ok: true; state: State } | { ok: false; issue: CheckIssue } {
  let state = emptyState(world);
  const nowIso = world.meta.clock.start;
  const order = seedOrder(world);
  const deferred = deferredRefs(world, order);
  for (const entity of order) {
    const source = Object.hasOwn(world.seed, entity) ? world.seed[entity] : undefined;
    if (source === undefined) continue;
    const path: IssuePath = ['seed', entity];
    const runtimeError = (message: string, found: string) => ({ ok: false as const, issue: issue('snippet.runtime_error', path, { message }, found) });

    let compiled: ReturnType<typeof host.compile<'seed'>>;
    try {
      compiled = host.compile('seed', source, path);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, issue: issue('snippet.compile_error', path, { message }, source.slice(0, 200)) };
    }
    if (!compiled.ok) return { ok: false, issue: compiled.issue };

    const rng = mulberry32(fnv1a(`${world.meta.seed}:${entity}`));
    const current = state;
    const ctx: SeedCtx = {
      rng,
      pick: <T>(xs: readonly T[]): T => {
        if (!Array.isArray(xs) || xs.length === 0) throw new SeedError(`pick(${JSON.stringify(xs) ?? String(xs)}) needs a non-empty list`);
        return xs[Math.floor(rng() * xs.length)]!;
      },
      int: (lo, hi) => {
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) throw new SeedError(`int(${lo}, ${hi}) needs integers with lo <= hi`);
        return lo + Math.floor(rng() * (hi - lo + 1));
      },
      rows: (name) => {
        if (!Object.hasOwn(world.entities, name)) throw new SeedError(`rows(${JSON.stringify(name)}): no entity ${name}. Known: ${Object.keys(world.entities).join(', ')}`);
        return [...(current.tables[name]?.values() ?? [])];
      },
      // A fresh copy per entity, so a snippet that mutates it changes nothing outside its run.
      fixtures: Object.fromEntries(Object.entries(world.fixtures).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))])),
      now: () => nowIso,
      time: timeMath,
    };

    let result: unknown;
    try {
      result = compiled.run(ctx);
    } catch (e) {
      if (e instanceof SnippetFault) return { ok: false, issue: e.issue };
      const message = e instanceof Error ? e.message : String(e);
      return runtimeError(message, `threw ${message}`);
    }
    if (!Array.isArray(result)) return runtimeError('A seed snippet returns an array of rows without id.', `returned ${article(result)}, not an array of rows`);
    const rows: unknown[] = result;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        return runtimeError('Each seed row is an object of field values.', `row ${i} is ${Array.isArray(r) ? 'an array' : article(r)}, not an object`);
      }
    }

    let at = 0;
    const tx = transact(world, state, (t) => {
      for (at = 0; at < rows.length; at++) t.create(entity, rows[at] as Record<string, unknown>, 'seed');
    }, deferred.map);
    if (!tx.ok) {
      const p = tx.error.problems[0];
      const field = p?.field ?? '(row)';
      const rule = p ? `${tx.error.code} (${p.expected})` : tx.error.code;
      const found = p ? `row ${at}, field ${p.field}: ${p.found}` : `row ${at}: ${tx.error.message}`;
      return { ok: false, issue: issue('constraint.violation', path, { entity, field, rule }, found) };
    }
    state = tx.state;
  }
  return resolveDeferred(state, deferred.targets);
}

/** Every deferred ref the seeds left must name a row that exists now. The first one that does not is the issue. */
function resolveDeferred(state: State, targets: Map<string, Map<string, string>>): { ok: true; state: State } | { ok: false; issue: CheckIssue } {
  for (const [entity, fields] of targets) {
    const rows = [...(state.tables[entity]?.values() ?? [])];
    for (const [field, target] of fields) {
      for (const [index, row] of rows.entries()) {
        const value = row[field];
        if (typeof value !== 'string' || state.tables[target]?.has(value as RowId)) continue;
        const ids = [...(state.tables[target]?.keys() ?? [])];
        const made = ids.length === 0 ? `the seed made no ${target} rows` : `the seed made ${ids.length} ${target} row${ids.length === 1 ? '' : 's'}, ${ids[0]}${ids.length > 1 ? ` to ${ids[ids.length - 1]}` : ''}`;
        const rule = `ref.unresolved (the id of an existing ${target})`;
        return { ok: false, issue: issue('constraint.violation', ['seed', entity], { entity, field, rule }, `row ${index}, field ${field}: ${JSON.stringify(value)}; ${made}`) };
      }
    }
  }
  return { ok: true, state };
}

/** One entity's writes inside a transaction. `null` marks a deleted row. */
type Overlay = Map<string, Map<RowId, Row | null>>;

/** Per entity, the nullable ref fields whose value may name a row that does not exist yet. Only the seed layer passes it. */
export type DeferredRefs = ReadonlyMap<string, ReadonlySet<string>>;

export function transact<T>(
  world: World,
  state: State,
  fn: (tx: Tx) => T,
  deferred?: DeferredRefs,
): { ok: true; state: State; value: T } | { ok: false; error: EnforceError } {
  const overlay: Overlay = new Map();
  const counters: Record<string, number> = { ...state.counters };
  const nowIso = toIso(state.now);

  const entityOf = (name: string): Entity => {
    const e = Object.hasOwn(world.entities, name) ? world.entities[name] : undefined;
    if (!e) throw new EnforceError(404, 'entity.unknown', `No entity ${name}. Known: ${Object.keys(world.entities).join(', ')}`);
    return e;
  };
  const baseRow = (entity: string, id: string): Row | null => state.tables[entity]?.get(id as RowId) ?? null;
  const readRow = (entity: string, id: string): Row | null => {
    const o = overlay.get(entity);
    if (o?.has(id as RowId)) return o.get(id as RowId) ?? null;
    return baseRow(entity, id);
  };
  const rowsOf = (entity: string): Row[] => {
    const merged = new Map<RowId, Row | null>(state.tables[entity] ?? []);
    for (const [id, r] of overlay.get(entity) ?? []) merged.set(id, r);
    return [...merged.values()].filter((r): r is Row => r !== null).sort((a, b) => cmpId(a.id, b.id));
  };
  const put = (entity: string, id: RowId, row: Row | null): void => {
    let o = overlay.get(entity);
    if (!o) overlay.set(entity, (o = new Map()));
    o.set(id, row);
  };
  const requireRow = (entity: string, id: string): Row => {
    const r = readRow(entity, id);
    if (!r) throw new EnforceError(404, 'row.not_found', `No ${entity} ${id}`);
    return r;
  };

  /**
   * Validates `input` against the entity and returns the full next row. Mutates nothing.
   * `prev` is the current row on update, null on create.
   */
  const validateWrite = (entityName: string, entity: Entity, prev: Row | null, id: RowId, input: Record<string, unknown>, mode: WriteMode): Row => {
    const fields = entity.fields;
    const p422: { code: string; problem: FieldProblem }[] = [];
    const add = (code: string, field: string, expected: string, found: string): void => {
      p422.push({ code, problem: { field, expected, found } });
    };
    const next: Record<string, Value> = prev ? { ...prev } : { id };
    const explicit = new Set<string>();

    for (const key of Object.keys(input)) {
      if (input[key] === undefined) continue;
      if (key === 'id') add('field.readonly', key, 'no value: id is assigned by the engine', show(input[key]));
      else if ((ENGINE_TIME_FIELDS as readonly string[]).includes(key)) {
        if (mode === 'api') add('field.readonly', key, 'no value: engine-maintained timestamp', show(input[key]));
        else {
          const c = FIELD_TYPES.datetime.validate(input[key], FIELD_TYPES.datetime.schema.parse({ type: 'datetime' }));
          if (c.ok) {
            next[key] = c.value;
            explicit.add(key);
          } else add('field.type', key, c.expected, show(input[key]));
        }
      } else if (!Object.hasOwn(fields, key)) add('field.unknown', key, `one of ${Object.keys(fields).join(', ')}`, show(input[key]));
    }

    for (const [name, def] of Object.entries(fields)) {
      const given = Object.hasOwn(input, name) ? input[name] : undefined;
      const kind = kindOf(def);
      if (given !== undefined && def.readonly && mode === 'api') {
        add('field.readonly', name, 'no value: readonly fields are set by actions, jobs and seed', show(given));
        continue;
      }
      let value: unknown = given;
      if (value === undefined) {
        if (prev) continue; // update: untouched field keeps its value
        value = initialOf(def, nowIso);
        if (value === undefined) {
          if (def.required) add('field.required', name, 'a value (required)', 'missing');
          // A non-nullable optional field stays absent: storing null would hold a value the store refuses.
          else if (def.nullable) next[name] = null;
          continue;
        }
      }
      if (value === null) {
        if (def.required || !def.nullable) {
          const c = kind.validate(null, def);
          add('field.null', name, c.ok ? 'a non-null value' : c.expected, 'null');
        } else next[name] = null;
        continue;
      }
      const c = kind.validate(value, def);
      if (!c.ok) {
        add('field.type', name, c.expected, show(value));
        continue;
      }
      const machine = machineOf(def);
      if (machine !== undefined) {
        const from = prev ? fromValue(entityName, prev.id, name) : null;
        if (from === null) {
          if (mode !== 'seed' && given !== undefined && c.value !== machine.initial) {
            add('state.initial', name, `${machine.initial} (the initial state)`, show(c.value));
            continue;
          }
        } else {
          // A write that names the current state is a self-transition: refused unless the machine declares it (A-197).
          const allowed = machine.transitions[String(from)] ?? [];
          if (!allowed.includes(String(c.value))) {
            throw new EnforceError(422, 'state.transition', `${entityName} ${prev!.id} ${name} cannot move from ${String(from)} to ${String(c.value)}`, [{
              field: name,
              expected: allowed.length ? `a transition from ${String(from)} to one of ${allowed.join(', ')}` : `no transition: ${String(from)} is final`,
              found: `${String(from)} -> ${String(c.value)}`,
            }]);
          }
        }
      }
      const target = refOf(def);
      if (target !== undefined && readRow(target.entity, String(c.value)) === null) {
        if (!deferred?.get(entityName)?.has(name)) {
          add('ref.unresolved', name, `the id of an existing ${target.entity}`, show(c.value));
          continue;
        }
      }
      next[name] = c.value;
    }

    if (p422.length > 0) {
      const first = p422[0]!;
      const label = prev ? `${entityName} ${prev.id}` : `new ${entityName}`;
      throw new EnforceError(422, first.code, `Invalid write to ${label}: ${p422.map((x) => `${x.problem.field} expected ${x.problem.expected}, found ${x.problem.found}`).join('; ')}`, p422.map((x) => x.problem));
    }

    for (const [name, def] of Object.entries(fields)) {
      const v = next[name];
      if (!def.unique || v === null || v === undefined) continue;
      const clash = rowsOf(entityName).find((r) => r.id !== id && r[name] === v);
      if (clash) {
        throw new EnforceError(409, 'field.unique', uniqueClash.message(entityName, name, v, clash.id), [{
          field: name, expected: `a value no other ${entityName} has`, found: `${show(v)} (${clash.id})`,
        }]);
      }
    }
    // Engine timestamps: privileged writes may set them explicitly (validated above), otherwise engine time.
    if (!explicit.has('updated_at')) next['updated_at'] = nowIso;
    if (!prev && !explicit.has('created_at')) next['created_at'] = nowIso;
    return freezeRow(next);
  };

  /**
   * The value a state field had before this transaction. A row created in this transaction
   * has no earlier value, so its current value inside the transaction counts.
   */
  const fromValue = (entity: string, id: RowId, field: string): Value => {
    const before = baseRow(entity, id) ?? readRow(entity, id);
    return before?.[field] ?? null;
  };

  /** Every (entity, field, onDelete) whose ref points at `target`. In declaration order. */
  const referrersOf = (target: string): { entity: string; field: string; onDelete: 'restrict' | 'cascade' | 'nullify'; nullable: boolean }[] => {
    const out: { entity: string; field: string; onDelete: 'restrict' | 'cascade' | 'nullify'; nullable: boolean }[] = [];
    for (const [en, e] of Object.entries(world.entities)) {
      for (const [fn, def] of Object.entries(e.fields)) {
        const ref = refOf(def);
        if (ref?.entity === target) out.push({ entity: en, field: fn, onDelete: ref.onDelete, nullable: def.nullable && !def.required });
      }
    }
    return out;
  };

  const tx: Tx = {
    now: state.now,
    get(entity, id) {
      entityOf(entity);
      return readRow(entity, id);
    },
    list(entity, q) {
      const e = entityOf(entity);
      // Filter values pass through the field's validate, so they meet stored values in their stored
      // form (a datetime literal in any accepted spelling matches its canonical instant). A value the
      // field refuses stays raw and matches nothing. A missing key reads as null.
      const where = Object.entries(q?.where ?? {}).map(([k, v]): [string, Value] => {
        const def = Object.hasOwn(e.fields, k) ? e.fields[k] : (ENGINE_TIME_FIELDS as readonly string[]).includes(k) ? DATETIME_DEF : undefined;
        if (def === undefined || v === null) return [k, v];
        const c = kindOf(def).validate(v, def);
        return [k, c.ok ? c.value : v];
      });
      return rowsOf(entity).filter((r) => where.every(([k, v]) => (r[k] ?? null) === v));
    },
    create(entity, data, mode) {
      const e = entityOf(entity);
      const n = (counters[entity] ?? 0) + 1;
      const id = `${e.idPrefix}_${String(n).padStart(ID_DIGITS, '0')}` as RowId;
      const row = validateWrite(entity, e, null, id, data, mode);
      counters[entity] = n;
      put(entity, id, row);
      return row;
    },
    update(entity, id, patch, mode) {
      const e = entityOf(entity);
      const prev = requireRow(entity, id);
      const row = validateWrite(entity, e, prev, prev.id, patch, mode);
      put(entity, prev.id, row);
      return row;
    },
    delete(entity, id) {
      entityOf(entity);
      const root = requireRow(entity, id);
      // Plan first, then apply, so a refused delete leaves the overlay untouched.
      const doomed = new Map<string, Set<RowId>>();
      const queue: [string, RowId][] = [[entity, root.id]];
      const mark = (en: string, rid: RowId): boolean => {
        let s = doomed.get(en);
        if (!s) doomed.set(en, (s = new Set()));
        if (s.has(rid)) return false;
        s.add(rid);
        return true;
      };
      mark(entity, root.id);
      while (queue.length > 0) {
        const [en, rid] = queue.shift()!;
        for (const ref of referrersOf(en)) {
          if (ref.onDelete !== 'cascade') continue;
          for (const r of rowsOf(ref.entity)) if (r[ref.field] === rid && mark(ref.entity, r.id)) queue.push([ref.entity, r.id]);
        }
      }
      const isDoomed = (en: string, rid: RowId): boolean => doomed.get(en)?.has(rid) ?? false;
      const nullify = new Map<string, Map<RowId, string[]>>();
      for (const [en, ids] of doomed) {
        for (const ref of referrersOf(en)) {
          if (ref.onDelete === 'cascade') continue;
          const hits = rowsOf(ref.entity).filter((r) => typeof r[ref.field] === 'string' && ids.has(r[ref.field] as RowId) && !isDoomed(ref.entity, r.id));
          if (hits.length === 0) continue;
          const target = String(hits[0]![ref.field]);
          if (ref.onDelete === 'restrict') {
            throw new EnforceError(409, 'delete.restricted', `Cannot delete ${en} ${target}: ${ref.entity}.${ref.field} references it (onDelete restrict)`, [{
              field: `${ref.entity}.${ref.field}`, expected: `no ${ref.entity} referencing ${en} ${target}`, found: hits.map((h) => h.id).join(', '),
            }]);
          }
          if (!ref.nullable) {
            throw new EnforceError(422, 'field.null', `Cannot nullify ${ref.entity}.${ref.field}: the field is not nullable`, [{
              field: `${ref.entity}.${ref.field}`, expected: 'a nullable field for onDelete nullify', found: hits.map((h) => h.id).join(', '),
            }]);
          }
          let m = nullify.get(ref.entity);
          if (!m) nullify.set(ref.entity, (m = new Map()));
          for (const h of hits) m.set(h.id, [...(m.get(h.id) ?? []), ref.field]);
        }
      }
      for (const [en, ids] of doomed) for (const rid of ids) put(en, rid, null);
      for (const [en, m] of nullify) {
        for (const [rid, fields] of m) {
          const r = readRow(en, rid)!;
          put(en, rid, freezeRow({ ...r, ...Object.fromEntries(fields.map((f) => [f, null])), updated_at: nowIso }));
        }
      }
    },
  };

  let value: T;
  try {
    value = fn(tx);
  } catch (err) {
    if (err instanceof EnforceError) return { ok: false, error: err };
    const wrapped = new EnforceError(422, 'tx.aborted', err instanceof Error ? err.message : String(err));
    wrapped.cause = err;
    return { ok: false, error: wrapped };
  }

  const tables: Record<string, ReadonlyMap<RowId, Row>> = { ...state.tables };
  for (const [entity, o] of overlay) {
    const merged = new Map<RowId, Row | null>(state.tables[entity] ?? []);
    for (const [id, r] of o) merged.set(id, r);
    const rows = [...merged.values()].filter((r): r is Row => r !== null).sort((a, b) => cmpId(a.id, b.id));
    tables[entity] = new Map(rows.map((r) => [r.id, r]));
  }
  return { ok: true, state: { ...state, tables, counters }, value };
}

/** Canonical hash of tables and counters. Used by replay checks and run logs. */
export function stateHash(state: State): string {
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const canonRow = (r: Row): [string, Value][] => Object.keys(r).sort(byKey).map((k) => [k, r[k] ?? null]);
  const idempotency = [...(state.idempotency ?? new Map()).entries()]
    .sort(([a], [b]) => byKey(a, b))
    .map(([key, entry]) => [key, entry.fingerprint, entry.routeId, entry.response]);
  const doc = {
    counters: Object.keys(state.counters).sort(byKey).map((k) => [k, state.counters[k]]),
    tables: Object.keys(state.tables).sort(byKey).map((k) => [
      k,
      [...state.tables[k]!.values()].sort((a, b) => cmpId(a.id, b.id)).map(canonRow),
    ]),
    ...(idempotency.length === 0 ? {} : { idempotency }),
  };
  return hash128(JSON.stringify(doc));
}

/** Four independent 32-bit lanes of a multiply-xorshift hash. Not cryptographic. Pure, so engine core can use it. */
function hash128(s: string): string {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const mul = [0x2c1b3c6d, 0x297a2d39, 0x165667b1, 0x27d4eb2f];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    for (let l = 0; l < 4; l++) lanes[l] = Math.imul(lanes[l]! ^ c, mul[l]!) ^ (lanes[l]! >>> 15);
  }
  return lanes
    .map((h, l) => {
      let x = h ^ (s.length + l);
      x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
      x ^= x >>> 16;
      return (x >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
}
