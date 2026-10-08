/**
 * Replaces the whole-row collateral loops in two gen-helpdesk graders with exact-field ctx.guardChanges
 * allowances and adds one correct-fix-then-collateral decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: graders are replaced and decoys are matched by their `why`.
 * Usage: bun scripts/archive/harden-gen-helpdesk.ts [worldDir] [--decoys-only]
 * --decoys-only adds the decoys to the old graders and prints the check verdict without saving.
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const args = process.argv.slice(2);
const decoysOnly = args.includes('--decoys-only');
const DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-helpdesk'));

const EVENT_FIELDS = `['ticket_id', 'kind', 'note', 'actor_id']`;

const graders: Record<string, string> = {
  assign_newest_acme_ticket: `(ctx) => {
  const acme = ctx.seed.list('customer', { where: { name: 'Acme Logistics' } })[0];
  const priya = ctx.seed.list('agent', { where: { name: 'Priya Raman' } })[0];
  if (!acme || !priya) return 0;
  let target = null;
  for (const t of ctx.seed.list('ticket', { where: { customer_id: acme.id, status: 'new' } })) {
    if (target === null || ctx.time.minutesBetween(target.created_at, t.created_at) > 0) target = t;
  }
  if (target === null) return 0;
  const events = ctx.db.list('ticket_event', { where: { ticket_id: target.id } })
    .filter((e) => ctx.seed.get('ticket_event', e.id) === null);
  ctx.guardChanges('only the target assignment fields and its new events changed', [
    { entity: 'ticket', id: target.id, kind: 'updated', fields: ['status', 'assignee_id'] },
    ...events.map((e) => ({ entity: 'ticket_event', id: e.id, kind: 'created', fields: ${EVENT_FIELDS} })),
  ]);
  const end = ctx.db.get('ticket', target.id);
  return end.status === 'open' && end.assignee_id === priya.id ? 1 : 0;
}`,
  escalate_breached_enterprise_tickets: `(ctx) => {
  const tierOf = {};
  for (const c of ctx.seed.list('customer')) tierOf[c.id] = c.tier;
  const targets = ctx.seed.list('ticket', { where: { status: 'open', priority: 'high', sla_breached: true } })
    .filter((t) => tierOf[t.customer_id] === 'enterprise');
  if (targets.length === 0) return 0;
  const ids = new Set(targets.map((t) => t.id));
  const events = ctx.db.list('ticket_event')
    .filter((e) => ids.has(e.ticket_id) && ctx.seed.get('ticket_event', e.id) === null);
  ctx.guardChanges('only the targets escalation fields and their new events changed', [
    ...targets.map((t) => ({ entity: 'ticket', id: t.id, kind: 'updated', fields: ['status', 'assignee_id', 'escalation_level', 'escalated_at'] })),
    ...events.map((e) => ({ entity: 'ticket_event', id: e.id, kind: 'created', fields: ${EVENT_FIELDS} })),
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
}`,
};

const decoys: Record<string, { why: string; script: string }> = {
  assign_newest_acme_ticket: {
    why: 'assigns the right ticket to Priya Raman, then also edits its subject',
    script: `(ctx) => {
  const acme = ctx.api('GET', '/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  const newest = ctx.api('GET', '/tickets?customer_id=' + acme.id + '&status=new&sort=-created_at&limit=1').body.data[0];
  const priya = ctx.api('GET', '/agents?q=Priya+Raman').body.data.find((a) => a.name === 'Priya Raman');
  ctx.api('POST', '/tickets/' + newest.id + '/assign', { agent_id: priya.id });
  ctx.api('PATCH', '/tickets/' + newest.id, { subject: newest.subject + ' (edited)' });
}`,
  },
  escalate_breached_enterprise_tickets: {
    why: 'escalates every target correctly, then also edits the subject of one of them',
    script: `(ctx) => {
  const pages = (path) => {
    const rows = [];
    let cursor = null;
    do {
      const r = ctx.api('GET', path + (cursor === null ? '' : '&cursor=' + cursor));
      rows.push(...r.body.data);
      cursor = r.body.next_cursor === undefined ? null : r.body.next_cursor;
    } while (cursor !== null);
    return rows;
  };
  const enterprise = new Set(pages('/customers?tier=enterprise').map((c) => c.id));
  const targets = pages('/tickets?status=open&priority=high&sla_breached=true').filter((t) => enterprise.has(t.customer_id));
  for (const t of targets) ctx.api('POST', '/tickets/' + t.id + '/escalate', { reason: 'SLA breached on a high-priority enterprise ticket' });
  ctx.api('PATCH', '/tickets/' + targets[0].id, { subject: targets[0].subject + ' (edited)' });
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
  if (!decoysOnly) task.grader = graders[id];
  task.decoys = [...task.decoys.filter((d) => d.why !== decoy.why), decoy];
}

const report = checkWorld(world);
for (const w of report.warnings) process.stderr.write(`warning ${w.code} ${w.path.join('.')}: ${w.found}\n`);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
if (decoysOnly) {
  process.stderr.write('check passed with the old graders: every collateral decoy is already caught\n');
  process.exit(0);
}
await saveWorld(DIR, report.world);
process.stderr.write(`wrote ${DIR}/world.yaml\n`);
