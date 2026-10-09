import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { checkWorld, loadWorld, type CheckedWorld } from '#engine';
import { templateErrors } from './events.ts';
import { alias, linkSchema } from './links.ts';
import { provenanceSchema } from './provenance.ts';

const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const pathname = z.string().startsWith('/');
const request = { method, path: pathname, body: z.json().optional() };
const match = { world: alias, method, path: pathname, nth: z.number().int().positive().default(1) };
const faultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...match, kind: z.literal('drop_response') }),
  z.strictObject({ ...match, kind: z.literal('duplicate') }),
  z.strictObject({ ...match, kind: z.literal('operator'), request: z.strictObject({ world: alias.optional(), ...request }) }),
]);
const eventSchema = z.strictObject({
  name: z.string().min(1),
  on: z.strictObject({ world: alias, method, path: pathname, status: z.number().int().min(100).max(599) }),
  deliver: z.strictObject({ world: alias, ...request }),
  fault: z.enum(['duplicate', 'out_of_order']).optional(),
});
export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  worlds: z.record(alias, z.string().min(1)),
  gates: z.array(z.strictObject({ world: alias, task: z.string().min(1) })).min(1),
  faults: z.array(faultSchema).default([]),
  events: z.array(eventSchema).default([]),
  links: z.array(linkSchema).default([]),
  provenance: z.array(provenanceSchema).default([]),
});
export type Scenario = z.output<typeof scenarioSchema>;
export type FaultKind = Scenario['faults'][number]['kind'];
export type ScenarioEvent = Scenario['events'][number];
export type EventFault = NonNullable<ScenarioEvent['fault']>;
export type LoadedScenario = { readonly scenario: Scenario; readonly worlds: Readonly<Record<string, CheckedWorld>> };

const SCENARIO_FILE = 'scenario.yaml';

export async function loadScenario(dir: string): Promise<{ ok: true; value: LoadedScenario } | { ok: false; errors: string[] }> {
  const file = path.join(dir, SCENARIO_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { ok: false, errors: [`${SCENARIO_FILE}: no readable file at ${file}`] };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    return { ok: false, errors: [`${SCENARIO_FILE}: not valid YAML: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`] };
  }
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.length === 0 ? SCENARIO_FILE : i.path.join('.')}: ${i.message}`) };
  }
  const scenario = parsed.data;
  const errors: string[] = [];
  const worlds: Record<string, CheckedWorld> = {};
  for (const [name, rel] of Object.entries(scenario.worlds)) {
    const worldDir = path.resolve(dir, rel);
    const loaded = await loadWorld(worldDir);
    if (!loaded.ok) {
      const [first] = loaded.error;
      errors.push(`worlds.${name}: ${worldDir}: ${first.code}: ${first.found}`);
      continue;
    }
    const report = checkWorld(loaded.value, loaded.lines);
    if (!report.ok) {
      const [first] = report.issues;
      errors.push(`worlds.${name}: ${worldDir}: ${first.code}: ${first.found}`);
      continue;
    }
    worlds[name] = report.world;
  }
  const aliases = Object.keys(scenario.worlds);
  const known = `Worlds: ${aliases.join(', ')}`;
  const seen = new Set<string>();
  scenario.gates.forEach((g, i) => {
    if (!aliases.includes(g.world)) {
      errors.push(`gates[${i}]: world ${g.world} is not declared in worlds. ${known}`);
    } else {
      const w = worlds[g.world];
      if (w !== undefined && !Object.keys(w.tasks).includes(g.task)) {
        errors.push(`gates[${i}]: world ${g.world} has no task "${g.task}". Tasks: ${Object.keys(w.tasks).join(', ')}`);
      }
    }
    const key = `${g.world}/${g.task}`;
    if (seen.has(key)) errors.push(`gates[${i}]: gate ${g.world}/${g.task} appears more than once`);
    seen.add(key);
  });
  const declared = (at: string, world: string): boolean => {
    if (!aliases.includes(world)) errors.push(`${at}: world ${world} is not declared in worlds. ${known}`);
    return aliases.includes(world);
  };
  scenario.faults.forEach((f, i) => {
    declared(`faults[${i}]`, f.world);
    if (f.kind === 'operator' && f.request.world !== undefined) declared(`faults[${i}].request`, f.request.world);
  });
  const named = new Set<string>();
  scenario.events.forEach((e, i) => {
    if (named.has(e.name)) errors.push(`events[${i}]: event "${e.name}" appears more than once`);
    named.add(e.name);
    declared(`events[${i}].on`, e.on.world);
    declared(`events[${i}].deliver`, e.deliver.world);
    for (const t of templateErrors(e.deliver)) errors.push(`events[${i}].deliver: ${t} is not \${response.<field>}, a top-level field of the triggering response`);
  });
  const fieldsOf = (at: string, world: string, entity: string): string[] | null => {
    const w = declared(at, world) ? worlds[world] : undefined;
    if (w === undefined) return null;
    const e = Object.hasOwn(w.entities, entity) ? w.entities[entity] : undefined;
    if (e === undefined) {
      errors.push(`${at}: world ${world} has no entity "${entity}". Entities: ${Object.keys(w.entities).join(', ')}`);
      return null;
    }
    return ['id', ...Object.keys(e.fields)];
  };
  const hasFields = (at: string, world: string, entity: string, names: readonly (readonly [string, string])[]): void => {
    const fields = fieldsOf(at, world, entity);
    if (fields === null) return;
    for (const [where, name] of names) {
      if (!fields.includes(name)) errors.push(`${where}: ${entity} in world ${world} has no field "${name}". Fields: ${fields.join(', ')}`);
    }
  };
  scenario.links.forEach((l, i) => {
    for (const [end, e] of [['from', l.from], ['to', l.to]] as const) {
      const at = `links[${i}].${end}`;
      hasFields(at, e.world, e.entity, [...Object.keys(e.where).map((n) => [`${at}.where`, n] as const), [`${at}.field`, e.field]]);
    }
  });
  const gated = new Set<string>();
  scenario.provenance.forEach((p, i) => {
    const at = `provenance[${i}]`;
    if (gated.has(p.name)) errors.push(`${at}: provenance gate "${p.name}" appears more than once`);
    gated.add(p.name);
    const cited = p.cites === undefined ? [] : [[`${at}.cites.field`, p.cites.field] as const];
    hasFields(`${at}.rows`, p.rows.world, p.rows.entity, [...Object.keys(p.rows.where).map((n) => [`${at}.rows.where`, n] as const), ...cited]);
    if (p.cites !== undefined) fieldsOf(`${at}.cites`, p.cites.world, p.cites.entity);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { scenario, worlds } };
}
