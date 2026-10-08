/**
 * Rewrites two gen-todo-projects graders with exact-field ctx.guardChanges allowances and adds one
 * correct-fix-then-collateral decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: graders are replaced and decoys are matched by their `why`.
 * Usage: npx tsx scripts/archive/harden-gen-todo-projects.ts [worldDir]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const DIR = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-todo-projects'));

const graders: Record<string, string> = {
  archive_q3_launch_project: `(ctx) => {
  const project = ctx.seed.list('project', { where: { name: 'Q3 Marketing Launch' } })[0];
  if (!project) return 0;
  const open = ctx.seed.list('task', { where: { project_id: project.id } }).filter((t) => t.status !== 'done');
  ctx.guardChanges('only the open tasks of Q3 Marketing Launch are completed and the project is archived', [
    ...open.map((t) => ({ entity: 'task', id: t.id, kind: 'updated', fields: ['status', 'completed_at', 'is_overdue'] })),
    { entity: 'project', id: project.id, kind: 'updated', fields: ['status', 'archived_at'] },
  ]);
  const allDone = open.every((t) => ctx.db.get('task', t.id).status === 'done');
  const archived = ctx.db.get('project', project.id).status === 'archived';
  if (archived && allDone) return 1;
  if (allDone) return 0.4;
  return 0;
}`,
  archive_all_finished_projects: `(ctx) => {
  const targets = ctx.seed.list('project', { where: { status: 'active' } }).filter((p) =>
    ctx.seed.list('task', { where: { project_id: p.id } }).every((t) => t.status === 'done'));
  if (targets.length === 0) return 0;
  ctx.guardChanges('only finished active projects are archived', targets.map((p) => (
    { entity: 'project', id: p.id, kind: 'updated', fields: ['status', 'archived_at'] })));
  let done = 0;
  for (const p of targets) {
    const end = ctx.db.get('project', p.id);
    if (end.status === 'archived' && end.archived_at !== null) done += 1;
  }
  return done / targets.length;
}`,
};

const decoys: Record<string, { why: string; script: string }> = {
  archive_q3_launch_project: {
    why: 'finishes and archives Q3 Marketing Launch correctly, then also renames the project',
    script: `(ctx) => {
  const project = ctx.api('GET', '/projects?q=Q3+Marketing+Launch').body.data.find((p) => p.name === 'Q3 Marketing Launch');
  const tasks = ctx.api('GET', '/projects/' + project.id + '/tasks').body.data;
  for (const t of tasks.filter((x) => x.status !== 'done')) ctx.api('POST', '/tasks/' + t.id + '/complete');
  ctx.api('POST', '/projects/' + project.id + '/archive');
  ctx.api('PATCH', '/projects/' + project.id, { name: 'Q3 Marketing Launch (edited)' });
}`,
  },
  archive_all_finished_projects: {
    why: 'archives every finished project correctly, then also renames one of them',
    script: `(ctx) => {
  const projects = ctx.api('GET', '/projects?status=active').body.data;
  const archived = [];
  for (const p of projects) {
    const tasks = ctx.api('GET', '/projects/' + p.id + '/tasks').body.data;
    if (tasks.some((t) => t.status !== 'done')) continue;
    ctx.api('POST', '/projects/' + p.id + '/archive');
    archived.push(p);
  }
  ctx.api('PATCH', '/projects/' + archived[0].id, { name: archived[0].name + ' (edited)' });
}`,
  },
};

const loaded = await loadWorld(DIR);
if (!loaded.ok) {
  for (const i of loaded.error) process.stderr.write(`${i.code} ${i.path.join('.')}: ${i.found}\n`);
  process.exit(1);
}
const world = loaded.value as { tasks: Record<string, { grader: string; decoys: { why: string; script: string }[] }> };
for (const [id, decoy] of Object.entries(decoys)) {
  const task = world.tasks[id];
  if (task === undefined) throw new Error(`task ${id} not found in ${DIR}`);
  task.grader = graders[id];
  task.decoys = [...task.decoys.filter((d) => d.why !== decoy.why), decoy];
}

const report = checkWorld(world);
for (const w of report.warnings) process.stderr.write(`warning ${w.code} ${w.path.join('.')}: ${w.found}\n`);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
await saveWorld(DIR, report.world);
process.stderr.write(`wrote ${DIR}/world.yaml\n`);
