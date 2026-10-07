/**
 * Replaces the whole-issue collateral loops in three gen-linear-backlog graders with exact-field ctx.guardChanges
 * allowances and adds one correct-fix-then-edit-the-target decoy to each, then saves through checkWorld and saveWorld.
 * The decoy wraps the task's own reference solution, so it applies the correct writes first.
 * Rerunning is safe: the guard block is replaced in place and decoys are matched by their `why`.
 * Usage: npx tsx scripts/harden-gen-linear-backlog.ts [worldDir]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const DIR = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../prod/worlds/gen-linear-backlog'));

const EVENT = `['issue_id', 'kind', 'from_value', 'to_value']`;
const COMMENT = `['issue_id', 'body']`;
const history = (idsExpr: string, comments: boolean) => `const events = ctx.db.list('issue_event').filter((e) => ${idsExpr}.has(e.issue_id) && ctx.seed.get('issue_event', e.id) === null);
  ${comments ? `const notes = ctx.db.list('comment').filter((c) => ${idsExpr}.has(c.issue_id) && ctx.seed.get('comment', c.id) === null);` : ''}`;
const history_allow = (comments: boolean) => `...events.map((e) => ({ entity: 'issue_event', id: e.id, kind: 'created', fields: ${EVENT} })),${comments ? `\n    ...notes.map((c) => ({ entity: 'comment', id: c.id, kind: 'created', fields: ${COMMENT} })),` : ''}`;

const COLLATERAL = /const collateral = ctx\.changes\(\)[\s\S]*?ctx\.guard\('[^']*', !collateral\);/;

const guards: Record<string, string> = {
  start_the_welcome_issue: `const ids = new Set([t.id]);
  ${history('ids', false)}
  ctx.guardChanges('only the rehearsal issue status and its new events changed', [
    { entity: 'issue', id: t.id, kind: 'updated', fields: ['status'] },
    ${history_allow(false)}
  ]);`,
  cancel_stale_backlog_in_milestone: `${history('ids', true)}
  ctx.guardChanges('only the target issues status, completed_at and their new events and comments changed', [
    ...targets.map((t) => ({ entity: 'issue', id: t.id, kind: 'updated', fields: ['status', 'completed_at'] })),
    ${history_allow(true)}
  ]);`,
  close_out_epic_with_sub_issues: `${history('ids', true)}
  ctx.guardChanges('only the epics and their sub-issues status, completed_at and their new events and comments changed', [
    ...[...ids].map((id) => ({ entity: 'issue', id, kind: 'updated', fields: ['status', 'completed_at'] })),
    ${history_allow(true)}
  ]);`,
};

const PAGES = `const pages = (path) => { const rows = []; let cursor = null; do { const r = ctx.api('GET', path + (cursor === null ? '' : (path.includes('?') ? '&' : '?') + 'cursor=' + cursor)); rows.push(...r.body.data); cursor = r.body.next_cursor; } while (cursor !== null); return rows; };`;
const finds: Record<string, { why: string; pick: string }> = {
  start_the_welcome_issue: {
    why: 'starts the rehearsal issue correctly, then also edits its title',
    pick: `const hit = pages('/issues?status=backlog').find((i) => i.title === 'Timed live-run rehearsal on sealed unseen prompts');`,
  },
  cancel_stale_backlog_in_milestone: {
    why: 'cancels every target correctly, then also edits the title of one of them',
    pick: `const ms = pages('/milestones').find((m) => m.name === 'Later: Fidelity and factory operations');
  const lb = pages('/labels').find((l) => l.name === 'area:engine');
  const hit = pages('/issues?milestone_id=' + ms.id + '&status=backlog').find((t) => pages('/issues/' + t.id + '/labels').some((l) => l.label_id === lb.id));`,
  },
  close_out_epic_with_sub_issues: {
    why: 'closes out every epic correctly, then also edits the title of the first one',
    pick: `const issues = pages('/issues'); const withKids = new Set(issues.filter((i) => i.parent_id).map((i) => i.parent_id));
  const hit = issues.find((i) => i.status === 'in_progress' && withKids.has(i.id));`,
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
  const { why, pick } = finds[id];
  const script = `(ctx) => {
  ${PAGES}
  ${pick}
  (${task.solution})(ctx);
  ctx.api('PATCH', '/issues/' + hit.id, { title: hit.title + ' (edited)' });
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
