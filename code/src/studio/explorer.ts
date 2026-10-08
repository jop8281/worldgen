/**
 * The World Explorer's view of one checked world definition: identity, entities and their
 * references, each state field's machine, the seed's row and state counts, routes and actions, jobs,
 * and the task catalog. Pure: no IO.
 *
 * Public facts only. A task is its id, content id, difficulty and instruction, which an agent
 * under test is told anyway; graders, solutions, decoys and every snippet source (handlers, jobs,
 * seeds) stay out. The seed is counts only, never a row's values. test/studio.test.ts proves it with canaries.
 */
import { machineOf, taskIdOf, worldIdOf, type CheckedWorld, type WorldStats } from '#engine';

export type ExplorerField = { readonly name: string; readonly type: string; readonly ref: string | null; readonly def: Readonly<Record<string, unknown>> };
export type ExplorerEntity = {
  readonly name: string;
  readonly description: string;
  readonly idPrefix: string;
  readonly fields: readonly ExplorerField[];
  /** Entities this one's ref fields point at. */
  readonly refersTo: readonly string[];
  /** `<entity>.<field>` of every ref field that points here. */
  readonly referencedBy: readonly string[];
};
export type ExplorerRoute = {
  readonly name: string;
  /** A standard operation (list, get, create, update, delete) or a custom action. */
  readonly kind: string;
  readonly method: string;
  readonly path: string;
  readonly entity: string | null;
  readonly description: string;
  /** Request fields of an action; empty for a standard operation, whose fields are its entity's. */
  readonly input: readonly ExplorerField[];
};
export type ExplorerJob = { readonly name: string; readonly description: string; readonly every: string };
export type ExplorerTask = { readonly id: string; readonly tid: string; readonly difficulty: string; readonly instruction: string };
/** One state field's workflow: its states, the state a create starts in, and the moves it allows. */
export type ExplorerMachine = { readonly entity: string; readonly field: string; readonly states: readonly string[]; readonly initial: string; readonly transitions: Readonly<Record<string, readonly string[]>> };
/** What the seed made: rows per entity, and per `entity.field` state field the rows in each state. */
export type ExplorerSeed = Pick<WorldStats, 'rows' | 'states'>;
export type WorldExplorer = {
  readonly name: string;
  readonly wid: string;
  readonly description: string;
  readonly resembles: string;
  readonly clockStart: string;
  readonly entities: readonly ExplorerEntity[];
  readonly machines: readonly ExplorerMachine[];
  readonly seed: ExplorerSeed;
  readonly routes: readonly ExplorerRoute[];
  readonly jobs: readonly ExplorerJob[];
  readonly tasks: readonly ExplorerTask[];
};

type FieldDef = Readonly<Record<string, unknown>> & { readonly type: string };

const fieldOf = (name: string, def: FieldDef): ExplorerField => ({
  name,
  type: def.type,
  ref: def.type === 'ref' && typeof def['entity'] === 'string' ? def['entity'] : null,
  def,
});

const fieldsOf = (fields: Readonly<Record<string, FieldDef>>): ExplorerField[] => Object.entries(fields).map(([name, def]) => fieldOf(name, def));

export function explorerOf(dirName: string, world: CheckedWorld, seed: ExplorerSeed): WorldExplorer {
  const entities = Object.entries(world.entities).map(([name, e]) => ({ name, description: e.description, idPrefix: e.idPrefix, fields: fieldsOf(e.fields as Record<string, FieldDef>) }));
  const referencedBy = new Map<string, string[]>();
  for (const e of entities) {
    for (const f of e.fields) if (f.ref !== null) referencedBy.set(f.ref, [...(referencedBy.get(f.ref) ?? []), `${e.name}.${f.name}`]);
  }
  return {
    name: dirName,
    wid: worldIdOf(world),
    description: world.meta.description,
    resembles: world.meta.resembles,
    clockStart: world.meta.clock.start,
    entities: entities.map((e) => ({
      ...e,
      refersTo: [...new Set(e.fields.flatMap((f) => (f.ref === null ? [] : [f.ref])))].sort(),
      referencedBy: referencedBy.get(e.name) ?? [],
    })),
    machines: Object.entries(world.entities).flatMap(([entity, e]) => Object.entries(e.fields).flatMap(([field, def]) => {
      const m = machineOf(def);
      return m === undefined ? [] : [{ entity, field, states: m.states, initial: m.initial, transitions: m.transitions }];
    })),
    seed: { rows: seed.rows, states: seed.states },
    routes: [
      ...Object.entries(world.routes).map(([name, r]) => ({ name, kind: r.op, method: r.method, path: r.path, entity: r.entity, description: r.description ?? '', input: [] })),
      ...Object.entries(world.actions).map(([name, a]) => ({ name, kind: 'action', method: a.method, path: a.path, entity: null, description: a.description ?? '', input: fieldsOf(a.input as Record<string, FieldDef>) })),
    ],
    jobs: Object.entries(world.jobs).map(([name, j]) => ({ name, description: j.description, every: j.every })),
    tasks: Object.entries(world.tasks).map(([id, t]) => ({ id, tid: taskIdOf(t), difficulty: t.difficulty, instruction: t.instruction })),
  };
}

/** The value the Studio shows in place of a sensitive field's value to any role below admin (A-356). */
export const SENSITIVE_MASK = '[sensitive]';
/** What the console answers in place of a body it cannot read as JSON while the world has sensitive fields. */
export const SENSITIVE_WITHHELD = '[withheld: the response could not be read as JSON to mask its sensitive fields]';

const obj = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Each entity's sensitive field names, keyed by its idPrefix, from a loaded world definition. A row id is `<idPrefix>_…`. */
export function sensitiveOf(world: unknown): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  const entities = obj(world) && obj(world['entities']) ? world['entities'] : {};
  for (const entity of Object.values(entities)) {
    if (!obj(entity) || typeof entity['idPrefix'] !== 'string' || !obj(entity['fields'])) continue;
    const names = Object.entries(entity['fields']).filter(([, def]) => obj(def) && def['sensitive'] === true).map(([name]) => name);
    if (names.length > 0) out.set(entity['idPrefix'], new Set(names));
  }
  return out;
}

/** `value` with every sensitive field of every row it holds replaced by SENSITIVE_MASK. A row is an object whose `id` is `<idPrefix>_…`. */
export function maskSensitive(value: unknown, sensitive: ReadonlyMap<string, ReadonlySet<string>>): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, sensitive));
  if (!obj(value)) return value;
  const id = value['id'];
  const cut = typeof id === 'string' ? id.indexOf('_') : -1;
  const fields = cut > 0 ? sensitive.get((id as string).slice(0, cut)) : undefined;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fields?.has(k) === true ? SENSITIVE_MASK : maskSensitive(v, sensitive)]));
}

/** A world response body with its sensitive values masked, or SENSITIVE_WITHHELD when it is not JSON (a body cut at the size limit). */
export function maskSensitiveText(text: string, sensitive: ReadonlyMap<string, ReadonlySet<string>>): string {
  if (text === '') return text;
  try {
    return JSON.stringify(maskSensitive(JSON.parse(text), sensitive));
  } catch {
    return SENSITIVE_WITHHELD;
  }
}
