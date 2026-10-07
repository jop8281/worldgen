/**
 * The canonical text of a world, which the shell hashes into a content id (A-121).
 *
 * Rules: every object's keys sort in UTF-16 code-unit order, members whose value is undefined are
 * dropped, arrays keep their order, and no whitespace is written. Input is the parsed world, never
 * YAML text, so formatting and omitted defaults cannot move an id. `entities`, `routes` and
 * `actions` serialize as [name, item] pairs in declaration order, because the engine reads that
 * order: route ties and seed ties go to the first declared. Inside them, each entity's `fields` and
 * each action's `input` serialize as [name, def] pairs too: the engine validates, reports the
 * first error, orders unique clashes and delete referrers, and lists OpenAPI properties in that order.
 * Defaults are hashed as filled, so a new defaulted format field moves every id once (A-154).
 */
import type { World } from './format.ts';

export type Wid = `wid_${string}`;
export type Tid = `tid_${string}`;

/** JSON.stringify's output for JSON data, with sorted keys. An undefined array item is null. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${members.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function canonicalWorld(world: World): string {
  return canonicalJson({
    ...world,
    entities: Object.entries(world.entities).map(([n, e]) => [n, { ...e, fields: Object.entries(e.fields) }]),
    routes: Object.entries(world.routes),
    actions: Object.entries(world.actions).map(([n, a]) => [n, { ...a, input: Object.entries(a.input) }]),
  });
}
