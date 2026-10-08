/**
 * Runs WorldGen's workflow gate (`workflowIssues`, spec row W11) on every world with a plan.yaml, and prints one line
 * per world with its WID (the parsed world's, as REPORT.md cites it), so a before/after diff also shows whether a world
 * changed. No model, no network.
 *
 *   bun scripts/workflow-probe.ts [worlds-dir]
 *
 * Exits 1 when any world fails the gate.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadWorld, worldIdOf, worldSchema } from '#engine';
import { parsePlanYaml, workflowIssues } from '../src/worldgen/plan.ts';

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../prod/worlds'));
let pass = 0, fail = 0, noPlan = 0;
for (const name of readdirSync(root).sort()) {
  const dir = path.join(root, name);
  if (!existsSync(path.join(dir, 'world.yaml'))) continue;
  const loaded = await loadWorld(dir);
  if (!loaded.ok) throw new Error(`${name}: world.yaml does not load: ${loaded.error[0].found}`);
  const world = worldSchema.parse(loaded.value);
  const wid = worldIdOf(world).slice(0, 16);
  if (!existsSync(path.join(dir, 'plan.yaml'))) {
    noPlan++;
    console.log(`no plan  ${name} ${wid}`);
    continue;
  }
  const plan = parsePlanYaml(readFileSync(path.join(dir, 'plan.yaml'), 'utf8'));
  if (plan === null) throw new Error(`${name}: plan.yaml does not parse`);
  const issues = workflowIssues(plan, world);
  if (issues.length === 0) {
    pass++;
    console.log(`ok       ${name} ${wid}`);
  } else {
    fail++;
    console.log(`FAIL     ${name} ${wid} ${issues.map((i) => `${i.code} ${i.path.join('.')}`).join('; ')}`);
  }
}
console.log(`pass ${pass}, fail ${fail}, no plan ${noPlan}`);
process.exit(fail > 0 ? 1 : 0);
