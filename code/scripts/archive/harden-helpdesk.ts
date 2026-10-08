/**
 * Pins the escalate_breached_enterprise_tickets grader to exact fields with ctx.guardChanges and adds a
 * correct-fix-then-collateral decoy, then saves through checkWorld and saveWorld.
 * Rerunning is safe: the grader is replaced and the decoy is matched by its `why`.
 * Usage: bun scripts/archive/harden-helpdesk.ts [worldDir] [--decoys-only]
 * --decoys-only adds the decoy to the old grader and prints the check verdict without saving.
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const args = process.argv.slice(2);
const decoysOnly = args.includes('--decoys-only');
const DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../../prod/worlds/helpdesk'));

const TASK = 'escalate_breached_enterprise_tickets';

const grader = `(ctx) => {
  const tierOf = {};
  for (const c of ctx.seed.list('customer')) tierOf[c.id] = c.tier;
  const targets = ctx.seed.list('ticket', { where: { status: 'open', priority: 'high', sla_breached: true } })
    .filter((t) => tierOf[t.customer_id] === 'enterprise');
  if (targets.length === 0) return 0;
  const ids = new Set(targets.map((t) => t.id));
  const events = ctx.db.list('ticket_event', { where: { kind: 'escalated' } })
    .filter((e) => ctx.seed.get('ticket_event', e.id) === null && ids.has(e.ticket_id) && e.actor_id === null);
  ctx.guardChanges('only the escalation fields of the target tickets and their escalated events changed', [
    ...targets.map((t) => ({ entity: 'ticket', id: t.id, kind: 'updated', fields: ['status', 'escalation_level', 'escalated_at', 'assignee_id'] })),
    ...events.map((e) => ({ entity: 'ticket_event', id: e.id, kind: 'created', fields: ['ticket_id', 'kind', 'note', 'actor_id'] })),
  ]);
  const shifts = ctx.seed.list('oncall_shift', { where: { level: 1 } });
  let done = 0;
  for (const t of targets) {
    const end = ctx.db.get('ticket', t.id);
    if (end.status !== 'escalated' || end.escalation_level !== 1 || end.escalated_at === null) continue;
    const at = end.escalated_at;
    const shift = shifts.find((s) => ctx.time.minutesBetween(s.starts_at, at) >= 0 && ctx.time.minutesBetween(at, s.ends_at) > 0);
    if (shift && end.assignee_id === shift.agent_id) done += 1;
  }
  return done / targets.length;
}`;

const decoy = {
  why: 'escalates every target ticket correctly, then also rewrites the subject of one of them',
  script: `(ctx) => {
  const pages = (path) => {
    const rows = [];
    let cursor = null;
    do {
      const r = ctx.api('GET', path + (cursor === null ? '' : '&cursor=' + cursor));
      rows.push(...r.body.data);
      cursor = r.body.next_cursor;
    } while (cursor !== null);
    return rows;
  };
  const enterprise = new Set(pages('/customers?tier=enterprise').map((c) => c.id));
  const targets = pages('/tickets?status=open&priority=high&sla_breached=true').filter((t) => enterprise.has(t.customer_id));
  for (const t of targets) ctx.api('POST', '/tickets/' + t.id + '/escalate', { reason: 'SLA breached on a high-priority enterprise ticket' });
  ctx.api('PATCH', '/tickets/' + targets[0].id, { subject: targets[0].subject + ' (edited)' });
}`,
};

const loaded = await loadWorld(DIR);
if (!loaded.ok) {
  for (const i of loaded.error) process.stderr.write(`${i.code} ${i.path.join('.')}: ${i.found}\n`);
  process.exit(1);
}
const world = loaded.value as { tasks: Record<string, { grader: string; decoys: { why: string; script: string }[] }> };
const task = world.tasks[TASK];
if (task === undefined) throw new Error(`task ${TASK} not found in ${DIR}`);
if (!decoysOnly) task.grader = grader;
task.decoys = [...task.decoys.filter((d) => d.why !== decoy.why), decoy];

const report = checkWorld(world);
for (const w of report.warnings) process.stderr.write(`warning ${w.code} ${w.path.join('.')}: ${w.found}\n`);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
if (decoysOnly) {
  process.stderr.write('check passed with the old grader: the collateral decoy is already caught\n');
  process.exit(0);
}
await saveWorld(DIR, report.world);
process.stderr.write(`wrote ${DIR}/world.yaml\n`);
