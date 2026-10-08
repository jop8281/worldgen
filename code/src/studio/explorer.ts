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

/** Each entity's sensitive field names, keyed by its idPrefix, from a loaded world definition. A row id is `<idPrefix>_…`; entities sharing a prefix share the union. */
export function sensitiveOf(world: unknown): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  const entities = obj(world) && obj(world['entities']) ? world['entities'] : {};
  for (const entity of Object.values(entities)) {
    if (!obj(entity) || typeof entity['idPrefix'] !== 'string' || !obj(entity['fields'])) continue;
    const names = Object.entries(entity['fields']).filter(([, def]) => obj(def) && def['sensitive'] === true).map(([name]) => name);
    if (names.length > 0) out.set(entity['idPrefix'], new Set([...(out.get(entity['idPrefix']) ?? []), ...names]));
  }
  return out;
}

/** What a role below admin sees in place of text outside any row that names a sensitive field, such as a refusal (A-367). */
export const SENSITIVE_MESSAGE = '[withheld: the message names a sensitive field]';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Whether `text` names `field` as a word, in any case and with `_`, `-`, a space or nothing between its parts:
 * `api_key` is named by `API-KEY` and `api key`, `photoUrls` by `photo urls`, `status` by `tkt_0002 status`, but
 * `status` not by `statuses` and `ssn` not by `lessons`.
 */
const namesField = (text: string, field: string): boolean => {
  const parts = field.split(/[_\- ]+|(?<=[a-z0-9])(?=[A-Z])/).filter((p) => p !== '').map(escapeRegExp);
  return parts.length > 0 && new RegExp(`(^|[^a-z0-9])${parts.join('[_\\- ]?')}($|[^a-z0-9])`, 'i').test(text);
};

/**
 * `value` with every sensitive field of every row it holds replaced by SENSITIVE_MASK. A row is an object whose `id` is
 * `<idPrefix>_…`. Text outside every row that names a sensitive field, such as a `state.transition` refusal naming the
 * stored state, becomes SENSITIVE_MESSAGE (YOS-252, A-367).
 */
export function maskSensitive(value: unknown, sensitive: ReadonlyMap<string, ReadonlySet<string>>): unknown {
  const names = [...new Set([...sensitive.values()].flatMap((fields) => [...fields]))];
  const walk = (v: unknown, inRow: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, inRow));
    if (typeof v === 'string') return !inRow && names.some((n) => namesField(v, n)) ? SENSITIVE_MESSAGE : v;
    if (!obj(v)) return v;
    const id = v['id'];
    const cut = typeof id === 'string' ? id.indexOf('_') : -1;
    const fields = cut > 0 ? sensitive.get((id as string).slice(0, cut)) : undefined;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fields?.has(k) === true ? SENSITIVE_MASK : walk(x, cut > 0)]));
  };
  return walk(value, false);
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

/** Each entity's sensitive fields by idPrefix, or null when the world's definition could not be read, so its values are withheld (A-356). */
export type Sensitivity = ReadonlyMap<string, ReadonlySet<string>> | null;
/** What a role below admin sees in place of a world's answer when the world's sensitive fields could not be read. */
export const SENSITIVITY_UNREAD = "[withheld: the world's sensitive fields could not be read]";

/** A world response body as a role below admin sees it: as is with no sensitive field, masked with some, withheld when unread. */
export function bodyBelowAdmin(text: string, sensitive: Sensitivity): string {
  if (sensitive === null) return text === '' ? text : SENSITIVITY_UNREAD;
  return sensitive.size === 0 ? text : maskSensitiveText(text, sensitive);
}

/** Sensitive fields of several worlds in one map, or null when any of them is unread or there is none. */
export function mergeSensitivity(all: readonly Sensitivity[]): Sensitivity {
  if (all.length === 0 || all.includes(null)) return null;
  const out = new Map<string, Set<string>>();
  for (const s of all) for (const [prefix, fields] of s ?? []) out.set(prefix, new Set([...(out.get(prefix) ?? []), ...fields]));
  return out;
}

/** What a role below admin sees in place of a run's free text that can quote seed values or model output (A-367). */
export const RUN_TEXT_WITHHELD = "[withheld: it can quote seed values, and the run's world has a sensitive field or saved none to tell]";

const isIssue = (v: Readonly<Record<string, unknown>>): boolean =>
  typeof v['code'] === 'string' && typeof v['severity'] === 'string' && Array.isArray(v['path']) && typeof v['found'] === 'string';
/** Outcomes and stop reasons whose `message` is free text: a model's or the judge's error, or a crash. */
const MESSAGE_KINDS: ReadonlySet<unknown> = new Set(['model_error', 'judge_error', 'crashed']);

/**
 * A generation run's events as a role below admin sees them (A-367). An issue's found and hint can quote a seed value
 * or a test's message, a no_progress stop's repeated issue set holds the found texts, and a model error, judge error or
 * crash message can quote model output, so all of them are withheld unless the run's saved world has no sensitive
 * field. A run that saved no world, or whose world is unread, fails closed.
 */
export function runEventsBelowAdmin(events: readonly unknown[], sensitive: Sensitivity): unknown[] {
  if (sensitive !== null && sensitive.size === 0) return [...events];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!obj(v)) return v;
    if (isIssue(v)) return { ...v, found: RUN_TEXT_WITHHELD, ...(typeof v['hint'] === 'string' ? { hint: RUN_TEXT_WITHHELD } : {}) };
    const freeText = (k: string, x: unknown): boolean => typeof x === 'string' && (k === 'repeatedIssueSet' || (k === 'message' && MESSAGE_KINDS.has(v['kind'])));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, freeText(k, x) ? RUN_TEXT_WITHHELD : walk(x)]));
  };
  return events.map(walk);
}

/**
 * An exported episode as a role below admin sees it: each tool result body masked like a console answer. A body
 * stored as text (not JSON, or cut at the size limit) is withheld, and so is every body when the world is unread.
 */
export function episodeBelowAdmin(episode: unknown, sensitive: Sensitivity): unknown {
  if (!obj(episode) || !Array.isArray(episode['messages']) || sensitive?.size === 0) return episode;
  const messages = episode['messages'].map((m: unknown) => {
    if (!obj(m) || m['type'] !== 'tool_result' || m['body'] === null || m['body'] === undefined) return m;
    if (sensitive === null) return { ...m, body: SENSITIVITY_UNREAD };
    return { ...m, body: typeof m['body'] === 'string' ? SENSITIVE_WITHHELD : maskSensitive(m['body'], sensitive) };
  });
  return { ...episode, messages };
}
