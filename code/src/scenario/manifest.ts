import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { checkWorld, loadWorld, type CheckedWorld } from '#engine';
import { alias, linkSchema, type LinkEnd } from './links.ts';

const faultSchema = z.strictObject({
  world: alias,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/'),
  nth: z.number().int().positive().default(1),
  kind: z.enum(['drop_response', 'duplicate']),
});
export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  worlds: z.record(alias, z.string().min(1)),
  gates: z.array(z.strictObject({ world: alias, task: z.string().min(1) })).min(1),
  faults: z.array(faultSchema).default([]),
  links: z.array(linkSchema).default([]),
});
export type Scenario = z.output<typeof scenarioSchema>;
export type FaultKind = Scenario['faults'][number]['kind'];
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
  scenario.faults.forEach((f, i) => {
    if (!aliases.includes(f.world)) errors.push(`faults[${i}]: world ${f.world} is not declared in worlds. ${known}`);
  });
  const linkEnd = (at: string, e: LinkEnd): void => {
    if (!aliases.includes(e.world)) {
      errors.push(`${at}: world ${e.world} is not declared in worlds. ${known}`);
      return;
    }
    const w = worlds[e.world];
    if (w === undefined) return;
    const entity = Object.hasOwn(w.entities, e.entity) ? w.entities[e.entity] : undefined;
    if (entity === undefined) {
      errors.push(`${at}: world ${e.world} has no entity "${e.entity}". Entities: ${Object.keys(w.entities).join(', ')}`);
      return;
    }
    const fields = ['id', ...Object.keys(entity.fields)];
    const unknown = (key: string, name: string): void => {
      if (!fields.includes(name)) errors.push(`${at}.${key}: ${e.entity} in world ${e.world} has no field "${name}". Fields: ${fields.join(', ')}`);
    };
    for (const name of Object.keys(e.where)) unknown('where', name);
    unknown('field', e.field);
  };
  scenario.links.forEach((l, i) => {
    linkEnd(`links[${i}].from`, l.from);
    linkEnd(`links[${i}].to`, l.to);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { scenario, worlds } };
}
