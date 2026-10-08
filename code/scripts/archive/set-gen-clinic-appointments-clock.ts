/**
 * Moves the gen-clinic-appointments clock to 2026-10-06T09:00:00Z, the date the plan describes, and records it in
 * world meta (through checkWorld and saveWorld) and in plan.yaml (through renderPlanYaml). The seed is relative to
 * the clock, so every slot and appointment keeps its offset from "now". 09:00 is the time the first slots begin: at
 * 08:00 the 30-minute check-in window holds no slot and the seed makes no checked_in appointment.
 * Rerunning is safe: it changes nothing once the clock is already set.
 * Usage: bun scripts/archive/set-gen-clinic-appointments-clock.ts [worldDir]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';
import { parsePlanYaml, renderPlanYaml } from '../../src/worldgen/plan.ts';

const DIR = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-clinic-appointments'));
const START = '2026-10-06T09:00:00.000Z';
const OLD_MIX = 'Clock starts 2026-10-06T08:00Z.';
const NEW_MIX = 'Clock starts 2026-10-06T09:00Z, when the first slots begin, so the 30-minute check-in window holds slots.';
const DECISION = 'The clock starts 2026-10-06T09:00Z, not 08:00Z.';
const WHY = 'Slots begin at 09:00 and check-in opens 30 minutes before a visit, so at 08:00 no slot is inside the window and the seed has no checked_in appointment. At 09:00 the nine checked_in appointments exist. The seed is relative to the clock, so no slot or appointment changes its offset from now.';

const loaded = await loadWorld(DIR);
if (!loaded.ok) throw new Error(`${DIR} does not load: ${loaded.error[0].code}`);
const world = { ...loaded.value, meta: { ...loaded.value.meta, clock: { ...loaded.value.meta.clock, start: START } } };
const report = checkWorld(world);
if (!report.ok) throw new Error(`check failed: ${report.issues.slice(0, 3).map((i) => `${i.code} ${i.path.join('.')}`).join('; ')}`);
await saveWorld(DIR, report.world);

const planFile = path.join(DIR, 'plan.yaml');
const plan = parsePlanYaml(await readFile(planFile, 'utf8'));
if (plan === null) throw new Error(`${planFile} is not a plan`);
const next = {
  ...plan,
  revision: plan.clock.start === START ? plan.revision : plan.revision + 1,
  clock: { ...plan.clock, start: START },
  seed: { ...plan.seed, mix: plan.seed.mix.replace(OLD_MIX, NEW_MIX) },
  assumptions: plan.assumptions.some((a) => a.decision === DECISION) ? plan.assumptions : [...plan.assumptions, { decision: DECISION, why: WHY }],
};
await writeFile(planFile, renderPlanYaml(next));
const reportFile = path.join(DIR, 'REPORT.md');
const report0 = await readFile(reportFile, 'utf8');
if (!report0.includes('## Clock revision')) {
  await writeFile(reportFile, `${report0.trimEnd()}\n\n## Clock revision\n\nThe clock now starts 2026-10-06T09:00:00.000Z, the date the plan describes, instead of 2026-01-05T09:00:00.000Z. ${WHY} Revision 2 of plan.yaml records it. Seed data, tasks, generation attempts, costs and timing are unchanged.\n`);
}
console.log(`clock ${START}: world checked and saved, plan revision ${next.revision}`);
