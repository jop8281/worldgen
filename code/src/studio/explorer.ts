/**
 * The World Explorer's view of one checked world definition: identity, entities and their
 * references, routes and actions, jobs, and the task catalog. Pure: no IO.
 *
 * Public facts only. A task is its id, content id, difficulty and instruction, which an agent
 * under test is told anyway; graders, solutions, decoys and every snippet source (handlers, jobs,
 * seeds) stay out. test/studio.test.ts proves it with canaries.
 */
import { taskIdOf, worldIdOf, type CheckedWorld } from '#engine';

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
export type WorldExplorer = {
  readonly name: string;
  readonly wid: string;
  readonly description: string;
  readonly resembles: string;
  readonly clockStart: string;
  readonly entities: readonly ExplorerEntity[];
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

export function explorerOf(dirName: string, world: CheckedWorld): WorldExplorer {
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
    routes: [
      ...Object.entries(world.routes).map(([name, r]) => ({ name, kind: r.op, method: r.method, path: r.path, entity: r.entity, description: r.description ?? '', input: [] })),
      ...Object.entries(world.actions).map(([name, a]) => ({ name, kind: 'action', method: a.method, path: a.path, entity: null, description: a.description ?? '', input: fieldsOf(a.input as Record<string, FieldDef>) })),
    ],
    jobs: Object.entries(world.jobs).map(([name, j]) => ({ name, description: j.description, every: j.every })),
    tasks: Object.entries(world.tasks).map(([id, t]) => ({ id, tid: taskIdOf(t), difficulty: t.difficulty, instruction: t.instruction })),
  };
}
