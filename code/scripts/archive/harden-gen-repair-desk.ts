/**
 * Replaces the whole-ticket collateral loops in two gen-repair-desk graders with exact-field ctx.guardChanges
 * allowances (technician_id and status on the target tickets) and adds one correct-fix-then-edit-the-target decoy
 * to each, then saves through checkWorld and saveWorld. The decoy wraps the task's own reference solution.
 * Rerunning is safe: the guard block is replaced in place and decoys are matched by their `why`.
 * Usage: bun scripts/archive/harden-gen-repair-desk.ts [worldDir]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const DIR = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-repair-desk'));

const COLLATERAL = /const collateral = ctx\.changes\(\)[\s\S]*?ctx\.guard\('(?:[^'\\]|\\.)*', !collateral\);/;
const FIELDS = `['technician_id', 'status']`;

const guards: Record<string, string> = {
  assign_and_start_laptop: `ctx.guardChanges('only the Harbor Dental laptop ticket technician and status changed', [
    { entity: 'ticket', id: target.id, kind: 'updated', fields: ${FIELDS} },
  ]);`,
  reassign_and_start_dana_queue: `ctx.guardChanges('only Dana queued tickets technician and status changed',
    targets.map((t) => ({ entity: 'ticket', id: t.id, kind: 'updated', fields: ${FIELDS} })));`,
};

const decoys: Record<string, { why: string; pick: string }> = {
  assign_and_start_laptop: {
    why: 'assigns and starts the right ticket, then also edits its subject',
    pick: `const hit = ctx.api('GET', '/tickets?q=Laptop+will+not+boot').body.data.find((t) => t.customer_name === 'Harbor Dental' && t.status === 'queued');`,
  },
  reassign_and_start_dana_queue: {
    why: 'reassigns and starts every Dana ticket correctly, then also edits the subject of one of them',
    pick: `const dana = ctx.api('GET', '/technicians?q=Dana').body.data.find((t) => t.name === 'Dana Ortiz');
  const hit = ctx.api('GET', '/tickets?status=queued&technician_id=' + dana.id).body.data[0];`,
  },
};

const loaded = await loadWorld(DIR);
if (!loaded.ok) {
  for (const i of loaded.error) process.stderr.write(`${i.code} ${i.path.join('.')}: ${i.found}\n`);
  process.exit(1);
}
const world = loaded.value as { tasks: Record<string, { grader: string; solution: string; decoys: { why: string; script: string }[] }> };
for (const [id, guard] of Object.entries(guards)) {
  const task = world.tasks[id];
  if (task === undefined) throw new Error(`task ${id} not found in ${DIR}`);
  if (COLLATERAL.test(task.grader)) task.grader = task.grader.replace(COLLATERAL, () => guard);
  else if (!task.grader.includes('ctx.guardChanges(')) throw new Error(`${id}: no collateral loop and no guardChanges`);
  const { why, pick } = decoys[id];
  const script = `(ctx) => {
  ${pick}
  (${task.solution})(ctx);
  ctx.api('PATCH', '/tickets/' + hit.id, { subject: hit.subject + ' (edited)' });
}`;
  task.decoys = [...task.decoys.filter((d) => d.why !== why), { why, script }];
}

const report = checkWorld(world);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
await saveWorld(DIR, report.world);
process.stderr.write(`wrote ${DIR}/world.yaml\n`);
