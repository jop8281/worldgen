/**
 * Fidelity: weighted coverage of a frozen reference of the real software by a world (YOS-96). A
 * metric in the eval scorecard, and, for a description input that names a reference, the last
 * step's gate (A-258). Pure: no model and no file IO.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { FIELD_TYPES, choicesOf, issue, machineOf as fieldMachine, type CheckIssue, type FieldType, type World } from '#engine';
import { CASE_ID } from './eval.ts';

const caseId = z.string().regex(CASE_ID, 'must be lowercase kebab-case, such as helpdesk-sla');
const where = (p: readonly PropertyKey[]): string => (p.length === 0 ? '(root)' : p.map(String).join('.'));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const weight = z.number().int().positive();
const names = z.array(z.string().min(1)).default([]);
const referenceField = z.strictObject({
  name: z.string().min(1),
  synonyms: names,
  /** Engine field types that count as the real field's type. */
  types: z
    .array(z.custom<FieldType>((t) => typeof t === 'string' && Object.hasOwn(FIELD_TYPES, t), 'not an engine field type'))
    .min(1),
  weight,
});
const referenceEntity = z.strictObject({ name: z.string().min(1), synonyms: names, weight, fields: z.array(referenceField).default([]) });
const stateLocation = z.strictObject({ entity: z.string().min(1), field: z.string().min(1), synonyms: names });
const referenceStateSet = z.strictObject({
  ...stateLocation.shape,
  /** Other places the same states may live, tried in order after the primary one. The first state or enum field wins. */
  alternatives: z.array(stateLocation).default([]),
  states: z.array(z.strictObject({ name: z.string().min(1), synonyms: names, weight })).min(1),
  transitions: z.strictObject({
    weight,
    /** The real product allows every move between its states, such as Linear. */
    anyToAny: z.boolean().default(false),
    allowed: z.array(z.tuple([z.string().min(1), z.string().min(1)])).default([]),
  }),
});
const referenceRoute = z.strictObject({ method: z.string().min(1), path: z.string().startsWith('/'), synonyms: names, weight });
const referenceError = z.strictObject({
  case: z.string().min(1),
  /** The status the real product returns. Kept for the reader: a static check cannot see it. */
  status: z.number().int().min(400).max(599),
  /** What the world must have for the failure to be producible. */
  via: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('route'), method: z.string().min(1), path: z.string().startsWith('/') }),
    z.strictObject({ kind: z.literal('state'), entity: z.string().min(1), field: z.string().min(1), from: z.string().min(1), to: z.string().min(1) }),
  ]),
  weight,
});

const uniqueNames = (
  ctx: z.RefinementCtx,
  scope: string,
  items: readonly { readonly path: readonly PropertyKey[]; readonly names: readonly string[] }[],
): void => {
  const owner = new Map<string, number>();
  items.forEach((item, i) => {
    for (const n of new Set(item.names.map(normName))) {
      const prior = owner.get(n);
      if (prior !== undefined && prior !== i) ctx.addIssue({ code: 'custom', path: [...item.path], message: `${scope} name "${n}" is also used by ${items[prior]!.names[0]}` });
      else owner.set(n, i);
    }
  });
};

export const fidelityReferenceSchema = z
  .strictObject({
    case: caseId,
    source: z.string().min(1),
    entities: z.array(referenceEntity).default([]),
    stateSets: z.array(referenceStateSet).min(1),
    routes: z.array(referenceRoute).default([]),
    errors: z.array(referenceError).min(2),
  })
  .superRefine((ref, ctx) => {
    const add = (path: readonly PropertyKey[], message: string): void => ctx.addIssue({ code: 'custom', path: [...path], message });
    const entityNames = new Set(ref.entities.map((e) => e.name));
    uniqueNames(ctx, 'entity', ref.entities.map((e, i) => ({ path: ['entities', i, 'name'], names: [e.name, ...e.synonyms] })));
    ref.entities.forEach((e, i) => {
      uniqueNames(ctx, 'field', e.fields.map((f, j) => ({ path: ['entities', i, 'fields', j, 'name'], names: [f.name, ...f.synonyms] })));
    });
    ref.stateSets.forEach((set, i) => {
      for (const [k, loc] of [set, ...set.alternatives].entries()) {
        if (!entityNames.has(loc.entity)) add(k === 0 ? ['stateSets', i, 'entity'] : ['stateSets', i, 'alternatives', k - 1, 'entity'], `no reference entity named ${loc.entity}`);
      }
      uniqueNames(ctx, 'state', set.states.map((s, j) => ({ path: ['stateSets', i, 'states', j, 'name'], names: [s.name, ...s.synonyms] })));
      const declared = new Set(set.states.map((s) => s.name));
      set.transitions.allowed.forEach((pair, j) => {
        for (const n of pair) if (!declared.has(n)) add(['stateSets', i, 'transitions', 'allowed', j], `${n} is not a state of ${set.entity}.${set.field}`);
      });
      if (set.transitions.anyToAny && set.transitions.allowed.length > 0) add(['stateSets', i, 'transitions', 'allowed'], 'must be empty when anyToAny is true');
    });
    const routeKey = (method: string, p: string): string => `${method.toUpperCase()} ${normPath(p)}`;
    const seen = new Set<string>();
    ref.routes.forEach((r, i) => {
      const key = routeKey(r.method, r.path);
      if (seen.has(key)) add(['routes', i], `duplicate route ${key}`);
      seen.add(key);
    });
    const cases = new Set<string>();
    ref.errors.forEach((e, i) => {
      if (cases.has(e.case)) add(['errors', i, 'case'], `duplicate error case "${e.case}"`);
      cases.add(e.case);
      const via = e.via;
      if (via.kind === 'route') {
        if (!seen.has(routeKey(via.method, via.path))) add(['errors', i, 'via'], `no route ${routeKey(via.method, via.path)} in routes`);
      } else if (!ref.stateSets.some((s) => s.entity === via.entity && s.field === via.field)) {
        add(['errors', i, 'via'], `no state set ${via.entity}.${via.field} in stateSets`);
      } else {
        const set = ref.stateSets.find((x) => x.entity === via.entity && x.field === via.field)!;
        const declared = new Set(set.states.map((x) => x.name));
        for (const n of [via.from, via.to]) if (!declared.has(n)) add(['errors', i, 'via'], `${n} is not a state of ${via.entity}.${via.field}`);
      }
    });
  });
export type FidelityReference = z.output<typeof fidelityReferenceSchema>;
type ReferenceStateSet = FidelityReference['stateSets'][number];

export const MISS_KINDS = [
  'entity.missing',
  'field.missing',
  'field.type_mismatch',
  'state.missing',
  'transitions.stricter_than_real',
  'route.missing',
] as const;
export type MissKind = (typeof MISS_KINDS)[number];
export type FidelityMiss = { readonly kind: MissKind; readonly path: string; readonly weight: number; readonly detail: string };
export type Fidelity = {
  /** Earned weight over total weight, 0 to 1, rounded to 4 decimals. */
  readonly score: number;
  readonly earned: number;
  readonly total: number;
  readonly misses: readonly FidelityMiss[];
};

/** Parses eval/fidelity/<case>.yaml text. Errors are `<path>: <message>`. */
export function parseFidelityReference(text: string): { ok: true; reference: FidelityReference } | { ok: false; errors: readonly string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { ok: false, errors: [`not valid YAML: ${message(e)}`] };
  }
  const parsed = fidelityReferenceSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${where(i.path)}: ${i.message}`) };
  return { ok: true, reference: parsed.data };
}

/** The matching rule for names: lowercase, then drop every character that is not a letter or digit. */
export const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** The matching rule for paths: `{param}` names are ignored and a trailing slash is dropped. */
const normPath = (p: string): string => (p.replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '') || '/').toLowerCase();

const sameName = (worldName: string, canonical: string, synonyms: readonly string[]): boolean => {
  const w = normName(worldName);
  return [canonical, ...synonyms].some((n) => normName(n) === w);
};
/** Canonical name first, then synonyms in listed order. Reference names are disjoint, so one world key satisfies at most one item. */
const findKey = <T>(record: Readonly<Record<string, T>>, canonical: string, synonyms: readonly string[]): [string, T] | undefined => {
  const entries = Object.entries(record);
  for (const n of [canonical, ...synonyms]) {
    const hit = entries.find(([k]) => normName(k) === normName(n));
    if (hit !== undefined) return hit;
  }
  return undefined;
};

type Machine = { readonly states: readonly string[]; readonly transitions: Readonly<Record<string, readonly string[]>> | null };

/** Scores a world against a frozen reference. Pure: no model, no clock, no file IO. */
export function fidelityScore(reference: FidelityReference, world: World): Fidelity {
  let total = 0;
  let earned = 0;
  const misses: FidelityMiss[] = [];
  const miss = (kind: MissKind, path: string, w: number, detail: string): void => void misses.push({ kind, path, weight: w, detail });

  for (const re of reference.entities) {
    const entityWeight = re.weight + re.fields.reduce((s, f) => s + f.weight, 0);
    total += entityWeight;
    const hit = findKey(world.entities, re.name, re.synonyms);
    if (hit === undefined) {
      miss('entity.missing', re.name, entityWeight, `no entity named ${re.name}${re.synonyms.length === 0 ? '' : ` or ${re.synonyms.join(', ')}`}`);
      continue;
    }
    earned += re.weight;
    for (const rf of re.fields) {
      const field = findKey(hit[1].fields, rf.name, rf.synonyms);
      if (field === undefined) {
        miss('field.missing', `${re.name}.${rf.name}`, rf.weight, `${hit[0]} has no field named ${rf.name}${rf.synonyms.length === 0 ? '' : ` or ${rf.synonyms.join(', ')}`}`);
      } else if (!rf.types.includes(field[1].type)) {
        miss('field.type_mismatch', `${re.name}.${rf.name}`, rf.weight, `${hit[0]}.${field[0]} is ${field[1].type}, the real field is ${rf.types.join(' or ')}`);
      } else {
        earned += rf.weight;
      }
    }
  }

  /** The first location of a state set that resolves to a state field, or an enum (states only, any move allowed). */
  const machineOf = (set: ReferenceStateSet): Machine | undefined => {
    for (const loc of [set, ...set.alternatives]) {
      const re = reference.entities.find((e) => e.name === loc.entity);
      const ent = findKey(world.entities, loc.entity, re?.synonyms ?? []);
      const f = ent === undefined ? undefined : findKey(ent[1].fields, loc.field, loc.synonyms);
      if (f === undefined) continue;
      const def = f[1];
      const states = choicesOf(def);
      if (states) return { states, transitions: fieldMachine(def)?.transitions ?? null };
    }
    return undefined;
  };

  const stateInfo = new Map<ReferenceStateSet, { machine: Machine | undefined; present: Map<string, string> }>();
  for (const set of reference.stateSets) {
    const path = `${set.entity}.${set.field}`;
    const machine = machineOf(set);
    const present = new Map<string, string>();
    stateInfo.set(set, { machine, present });
    for (const rs of set.states) {
      total += rs.weight;
      const found = machine?.states.find((s) => sameName(s, rs.name, rs.synonyms));
      if (found === undefined) miss('state.missing', `${path}.${rs.name}`, rs.weight, machine === undefined ? `no state or enum field ${set.field} on ${set.entity}` : `${set.field} has no state named ${rs.name}`);
      else {
        earned += rs.weight;
        present.set(rs.name, found);
      }
    }
    total += set.transitions.weight;
    const wanted: [string, string][] = set.transitions.anyToAny
      ? set.states.flatMap((a) => set.states.filter((b) => b.name !== a.name).map((b): [string, string] => [a.name, b.name]))
      : set.transitions.allowed;
    const forbidden: string[] = [];
    for (const [from, to] of wanted) {
      const wf = present.get(from);
      const wt = present.get(to);
      if (wf === undefined || wt === undefined || machine === undefined || machine.transitions === null) continue;
      if (!(machine.transitions[wf] ?? []).includes(wt)) forbidden.push(`${from} -> ${to}`);
    }
    if (machine === undefined) {
      miss('state.missing', `${path}.transitions`, set.transitions.weight, `no state or enum field ${set.field} on ${set.entity}`);
    } else if (present.size < 2) {
      miss('state.missing', `${path}.transitions`, set.transitions.weight, 'fewer than two real states match, so moves cannot be compared');
    } else if (forbidden.length === 0) {
      earned += set.transitions.weight;
    } else {
      miss('transitions.stricter_than_real', path, set.transitions.weight, `the world forbids ${forbidden.join(', ')}`);
    }
  }

  const routes = [...Object.values(world.routes), ...Object.values(world.actions)];
  const hasRoute = (method: string, p: string, synonyms: readonly string[]): boolean =>
    routes.some((r) => r.method === method.toUpperCase() && [p, ...synonyms].some((q) => normPath(q) === normPath(r.path)));
  for (const rr of reference.routes) {
    total += rr.weight;
    if (hasRoute(rr.method, rr.path, rr.synonyms)) earned += rr.weight;
    else miss('route.missing', `${rr.method.toUpperCase()} ${rr.path}`, rr.weight, `no route or action for ${rr.method.toUpperCase()} ${rr.path}`);
  }
  for (const err of reference.errors) {
    total += err.weight;
    const label = `error ${err.status}: ${err.case}`;
    const via = err.via;
    if (via.kind === 'route') {
      const entry = reference.routes.find((r) => r.method.toUpperCase() === via.method.toUpperCase() && normPath(r.path) === normPath(via.path));
      if (entry !== undefined && hasRoute(entry.method, entry.path, entry.synonyms)) earned += err.weight;
      else miss('route.missing', label, err.weight, `no route or action for ${via.method.toUpperCase()} ${via.path}`);
    } else {
      const set = reference.stateSets.find((x) => x.entity === via.entity && x.field === via.field);
      const info = set === undefined ? undefined : stateInfo.get(set);
      const m = info?.machine;
      const wf = info?.present.get(via.from);
      const wt = info?.present.get(via.to);
      if (m === undefined || m.transitions === null) miss('state.missing', label, err.weight, `${via.entity}.${via.field} is not a state field, so no move can be refused`);
      else if (wf === undefined || wt === undefined) miss('state.missing', label, err.weight, `the world has no state matching ${wf === undefined ? via.from : via.to}, so ${via.from} -> ${via.to} cannot be refused`);
      else if ((m.transitions[wf] ?? []).includes(wt)) miss('state.missing', label, err.weight, `the world allows ${via.from} -> ${via.to}, so it cannot be refused`);
      else earned += err.weight;
    }
  }

  const score = total === 0 ? 0 : Math.round((earned / total) * 10000) / 10000;
  return { score, earned, total, misses };
}

/**
 * The fidelity score a world must reach when its description names a frozen reference (A-258): the
 * 0.80 target the eval scorecard already measures against (YOS-96).
 */
export const FIDELITY_FLOOR = 0.8;

/**
 * The last step's fidelity gate for a description input that names a reference. At or above
 * FIDELITY_FLOOR it passes. Below it, every miss is one issue, heaviest first, rooted at the world
 * section that builds it: a route can also be an action, so route misses wait for the last step too.
 */
export function fidelityGate(reference: FidelityReference, world: World): readonly CheckIssue[] {
  const f = fidelityScore(reference, world);
  if (f.score >= FIDELITY_FLOOR) return [];
  return [...f.misses].sort((a, b) => b.weight - a.weight).map((m) =>
    issue('fidelity.below_floor', [m.kind === 'route.missing' ? 'routes' : 'entities'], { score: f.score, floor: FIDELITY_FLOOR, what: `${m.kind} ${m.path}` }, m.detail));
}
