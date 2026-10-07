/**
 * Semantic differences between two worlds. WorldGen's iterate gate and REPORT.md's diff
 * read this, never raw edits.
 *
 * Every item that exists in `before` and is missing or changed in `after`
 * appears in the delta, down to the field, state, transition and idPrefix level.
 *
 * A kind is in DESTRUCTIVE when the change narrows what the world accepts or holds: a removal,
 * a removed enum value, state or transition target, a field that becomes required, a new
 * required field, or a moved endpoint. A pure widening (a new item, field, enum value,
 * state or transition target) is never destructive, so an "add refunds" iterate passes.
 *
 * Invariants:
 * - `path` starts with `section`, then `key` (for meta, the top-level meta property). It points
 *   at the value in `before` for a removal or change, and in `after` for an addition.
 * - `before` and `after` are present only for the sides that hold a value. They share
 *   structure with the input worlds, which are never mutated.
 * - Output order is meta, then SECTIONS order, then key, then path. It never depends on
 *   the key order of either input.
 */
import { SECTIONS, type Section, type World } from './format.ts';
import type { IssuePath } from './issues.ts';

export type ChangeKind =
  | 'item_added'
  | 'item_removed'
  | 'item_changed'
  | 'field_added'
  | 'field_removed'
  | 'field_changed'
  | 'field_required'
  | 'required_field_added'
  | 'enum_value_removed'
  | 'state_removed'
  | 'transition_added'
  | 'transition_changed'
  | 'endpoint_changed'
  | 'id_prefix_changed'
  | 'snippet_changed'
  | 'meta_changed';

export type WorldChange = {
  readonly section: Section | 'meta';
  readonly key: string;
  readonly kind: ChangeKind;
  readonly path: IssuePath;
  readonly before?: unknown;
  readonly after?: unknown;
};
export type WorldDelta = { readonly changes: readonly WorldChange[] };

/** Removals and narrowing changes that can break existing tasks or agents. */
export const DESTRUCTIVE: ReadonlySet<ChangeKind> = new Set([
  'item_removed',
  'field_removed',
  'field_required',
  'required_field_added',
  'enum_value_removed',
  'state_removed',
  'transition_changed',
  'endpoint_changed',
  'id_prefix_changed',
]);

/** How a property of an item is compared. A property with no rule is `item_changed` when it differs. */
type PropRule = 'snippet' | 'id_prefix' | 'endpoint' | 'fields' | 'decoys';
/** `whole`: the item is one value. `snippet`: the item is one snippet. Otherwise per property. */
type ItemRule = 'whole' | 'snippet' | { readonly [prop: string]: PropRule };

/** One rule per section. A new section fails to compile here until it gets one. */
const ITEM_RULES = {
  entities: { idPrefix: 'id_prefix', fields: 'fields' },
  routes: { method: 'endpoint', path: 'endpoint' },
  actions: { method: 'endpoint', path: 'endpoint', input: 'fields', handler: 'snippet' },
  jobs: { run: 'snippet' },
  fixtures: 'whole',
  seed: 'snippet',
  tests: { script: 'snippet' },
  tasks: { grader: 'snippet', solution: 'snippet', decoys: 'decoys' },
} as const satisfies Record<Section, ItemRule>;

/** Decoy properties that hold a snippet. Other decoy properties are `item_changed`. */
const DECOY_RULES: { readonly [prop: string]: 'snippet' } = { script: 'snippet' };

type Rec = Readonly<Record<string, unknown>>;
type Step = string | number;
type Out = WorldChange[];

export function diffWorlds(before: World, after: World): WorldDelta {
  const out: Out = [];
  diffMeta(['meta'], before.meta, after.meta, out);
  for (const section of SECTIONS) {
    const b: Rec = before[section];
    const a: Rec = after[section];
    for (const key of keysOf(b, a)) {
      const path: IssuePath = [section, key];
      const bv = valueAt(b, key);
      const av = valueAt(a, key);
      if (bv === undefined) push(out, section, key, 'item_added', path, bv, av);
      else if (av === undefined) push(out, section, key, 'item_removed', path, bv, av);
      else diffItem(section, key, ITEM_RULES[section], bv, av, out);
    }
  }
  return { changes: out.sort(byOrder) };
}

function diffItem(section: Section, key: string, rule: ItemRule, b: unknown, a: unknown, out: Out): void {
  const path: IssuePath = [section, key];
  if (rule === 'whole') {
    if (!same(b, a)) push(out, section, key, 'item_changed', path, b, a);
    return;
  }
  if (rule === 'snippet') {
    if (!same(b, a)) push(out, section, key, 'snippet_changed', path, b, a);
    return;
  }
  if (!isRec(b) || !isRec(a)) {
    if (!same(b, a)) push(out, section, key, 'item_changed', path, b, a);
    return;
  }
  for (const prop of keysOf(b, a)) {
    const bv = valueAt(b, prop);
    const av = valueAt(a, prop);
    const at: IssuePath = [section, key, prop];
    const propRule = Object.hasOwn(rule, prop) ? rule[prop] : undefined;
    if (propRule === undefined) {
      if (!same(bv, av)) push(out, section, key, 'item_changed', at, bv, av);
    } else if (propRule === 'snippet') {
      if (!same(bv, av)) push(out, section, key, 'snippet_changed', at, bv, av);
    } else if (propRule === 'id_prefix') {
      if (!same(bv, av)) push(out, section, key, 'id_prefix_changed', at, bv, av);
    } else if (propRule === 'endpoint') {
      if (!same(bv, av)) push(out, section, key, 'endpoint_changed', at, bv, av);
    } else if (propRule === 'fields') {
      diffFields(section, key, at, recOf(bv), recOf(av), out);
    } else {
      diffDecoys(section, key, at, bv, av, out);
    }
  }
}

/**
 * A map of field name to field definition: entity fields and action input.
 * A new field is `required_field_added` when it is required, else `field_added`.
 * A changed `type` is one `field_changed` for the whole definition; a `state` field that loses
 * its type also reports every state and non-empty transition list it held.
 */
function diffFields(section: Section, key: string, base: IssuePath, b: Rec, a: Rec, out: Out): void {
  for (const name of keysOf(b, a)) {
    const bd = valueAt(b, name);
    const ad = valueAt(a, name);
    const at = extend(base, name);
    if (bd === undefined) push(out, section, key, isRequired(ad) ? 'required_field_added' : 'field_added', at, bd, ad);
    else if (ad === undefined) push(out, section, key, 'field_removed', at, bd, ad);
    else if (!isRec(bd) || !isRec(ad) || !same(bd['type'], ad['type'])) {
      if (same(bd, ad)) continue;
      push(out, section, key, 'field_changed', at, bd, ad);
      if (isRec(bd) && bd['type'] === 'state') diffLostStates(section, key, at, bd, out);
      if (!isRequired(bd) && isRequired(ad)) {
        push(out, section, key, 'field_required', extend(at, 'required'), recOf(bd)['required'], true);
      }
    } else {
      for (const attr of keysOf(bd, ad)) {
        const bv = valueAt(bd, attr);
        const av = valueAt(ad, attr);
        const to = extend(at, attr);
        if (attr === 'states') diffMembers(section, key, 'state_removed', to, bv, av, out);
        else if (attr === 'values' && bd['type'] === 'enum') diffMembers(section, key, 'enum_value_removed', to, bv, av, out);
        else if (attr === 'transitions') diffTransitions(section, key, to, recOf(bv), recOf(av), out);
        else if (attr === 'required' && bv !== true && av === true) push(out, section, key, 'field_required', to, bv, av);
        else if (!same(bv, av)) push(out, section, key, 'field_changed', to, bv, av);
      }
    }
  }
}

/**
 * An ordered list of names (states, enum values). Each dropped member is `removed` at its index
 * in `before`. Added or reordered members are one `field_changed`, because order drives sorting.
 */
function diffMembers(
  section: Section, key: string, removed: 'state_removed' | 'enum_value_removed', at: IssuePath, b: unknown, a: unknown, out: Out,
): void {
  const bs: readonly unknown[] = Array.isArray(b) ? b : [];
  const as: readonly unknown[] = Array.isArray(a) ? a : [];
  bs.forEach((member, i) => {
    if (!as.includes(member)) push(out, section, key, removed, extend(at, i), member, undefined);
  });
  const kept = bs.filter((member) => as.includes(member));
  if (!same(kept, as)) push(out, section, key, 'field_changed', at, b, a);
}

/** A state field whose type changed loses every state and every edge: report each one as removed. */
function diffLostStates(section: Section, key: string, at: IssuePath, bd: Rec, out: Out): void {
  diffMembers(section, key, 'state_removed', extend(at, 'states'), bd['states'], [], out);
  diffTransitions(section, key, extend(at, 'transitions'), recOf(bd['transitions']), {}, out);
}

/**
 * Per from-state, targets compared as a set; order carries no meaning and a missing from-state
 * equals an empty list. Only added targets is `transition_added`; any removed target is `transition_changed`.
 */
function diffTransitions(section: Section, key: string, at: IssuePath, b: Rec, a: Rec, out: Out): void {
  for (const from of keysOf(b, a)) {
    const bv = valueAt(b, from);
    const av = valueAt(a, from);
    const bt = targetSet(bv);
    const atg = targetSet(av);
    if (same(bt, atg)) continue;
    const kind = bt.every((t) => atg.includes(t)) ? 'transition_added' : 'transition_changed';
    push(out, section, key, kind, extend(at, from), bv, av);
  }
}

/** Decoys are matched by index. Each snippet is `snippet_changed`; anything else, or a decoy added or dropped, is `item_changed`. */
function diffDecoys(section: Section, key: string, at: IssuePath, b: unknown, a: unknown, out: Out): void {
  const bs: readonly unknown[] = Array.isArray(b) ? b : [];
  const as: readonly unknown[] = Array.isArray(a) ? a : [];
  for (let i = 0; i < Math.max(bs.length, as.length); i++) {
    const bd = bs[i];
    const ad = as[i];
    const di = extend(at, i);
    if (bd === undefined || ad === undefined || !isRec(bd) || !isRec(ad)) {
      if (!same(bd, ad)) push(out, section, key, 'item_changed', di, bd, ad);
      continue;
    }
    for (const prop of keysOf(bd, ad)) {
      const bv = valueAt(bd, prop);
      const av = valueAt(ad, prop);
      const kind = Object.hasOwn(DECOY_RULES, prop) ? 'snippet_changed' : 'item_changed';
      if (!same(bv, av)) push(out, section, key, kind, extend(di, prop), bv, av);
    }
  }
}

/** Meta is walked down to the deepest differing value. The key is the top-level meta property. */
function diffMeta(at: IssuePath, b: unknown, a: unknown, out: Out): void {
  if (isRec(b) && isRec(a)) {
    for (const prop of keysOf(b, a)) diffMeta(extend(at, prop), valueAt(b, prop), valueAt(a, prop), out);
    return;
  }
  if (!same(b, a)) push(out, 'meta', String(at[1]), 'meta_changed', at, b, a);
}

function push(out: Out, section: Section | 'meta', key: string, kind: ChangeKind, path: IssuePath, before: unknown, after: unknown): void {
  out.push({
    section,
    key,
    kind,
    path,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
}

function extend(path: IssuePath, step: Step): IssuePath {
  return [...path, step];
}

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRequired(def: unknown): boolean {
  return isRec(def) && def['required'] === true;
}

function recOf(v: unknown): Rec {
  return isRec(v) ? v : {};
}

/** An own property's value, or undefined. Never reads the prototype chain. */
function valueAt(r: Rec, k: string): unknown {
  return Object.hasOwn(r, k) ? r[k] : undefined;
}

/** Own keys of either record that hold a value. Output order is fixed later by `byOrder`. */
function keysOf(b: Rec, a: Rec): string[] {
  const keys = new Set<string>();
  for (const r of [b, a]) for (const k of Object.keys(r)) if (r[k] !== undefined) keys.add(k);
  return [...keys];
}

function targetSet(v: unknown): readonly unknown[] {
  const list = Array.isArray(v) ? v : [];
  return [...new Set(list.map((t) => String(t)))].sort(cmpStr);
}

/** Structural equality over JSON-like values. An undefined property equals a missing one. */
function same(b: unknown, a: unknown): boolean {
  if (b === a) return true;
  if (Array.isArray(b) || Array.isArray(a)) {
    return Array.isArray(b) && Array.isArray(a) && b.length === a.length && b.every((v, i) => same(v, a[i]));
  }
  if (!isRec(b) || !isRec(a)) return false;
  const keys = keysOf(b, a);
  return keys.every((k) => same(valueAt(b, k), valueAt(a, k)));
}

/** Code-unit order, so the result never depends on a locale. */
const cmpStr = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function sectionRank(s: Section | 'meta'): number {
  return s === 'meta' ? 0 : SECTIONS.indexOf(s) + 1;
}

/** Numbers before strings, numbers by value, strings by code unit. */
function cmpStep(x: Step, y: Step): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'number') return -1;
  if (typeof y === 'number') return 1;
  return cmpStr(x, y);
}

function byOrder(x: WorldChange, y: WorldChange): number {
  const bySection = sectionRank(x.section) - sectionRank(y.section);
  if (bySection !== 0) return bySection;
  const byKey = cmpStr(x.key, y.key);
  if (byKey !== 0) return byKey;
  for (let i = 2; ; i++) {
    const xs = x.path[i];
    const ys = y.path[i];
    if (xs === undefined || ys === undefined) return x.path.length - y.path.length;
    const c = cmpStep(xs, ys);
    if (c !== 0) return c;
  }
}
