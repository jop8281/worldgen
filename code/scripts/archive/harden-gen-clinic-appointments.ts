/**
 * Hardens four gen-clinic-appointments graders with exact-field ctx.guardChanges allowances and adds one
 * correct-fix-then-collateral decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: the guard is inserted once and decoys are matched by their `why`.
 * Usage: npx tsx scripts/archive/harden-gen-clinic-appointments.ts [worldDir] [--decoys-only]
 * --decoys-only adds the decoys to the old graders and prints the check verdict without saving.
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const args = process.argv.slice(2);
const decoysOnly = args.includes('--decoys-only');
const DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-clinic-appointments'));

const APPT_CANCEL = `['status', 'cancel_reason', 'cancelled_at']`;
const APPT_ALL = `['slot_id', 'patient_id', 'doctor_id', 'starts_at', 'status', 'reason', 'cancel_reason', 'cancelled_at', 'checked_in_at']`;

/** Each guard is inserted immediately before the grader's old hand-rolled `for (const c of ctx.changes())` loop. */
const guards: Record<string, string> = {
  cancel_marias_far_appointment: `ctx.guardChanges('only the far appointment is cancelled and its slot reopened', [
    { entity: 'appointment', id: t.id, kind: 'updated', fields: ${APPT_CANCEL} },
    { entity: 'slot', id: t.slot_id, kind: 'updated', fields: ['status'] },
  ]); `,
  book_earliest_cardiology_slot: `ctx.guardChanges('only the target slot is booked and one appointment created', [
    { entity: 'slot', id: target.id, kind: 'updated', fields: ['status'] },
    ...ctx.changes().filter((c) => c.entity === 'appointment' && c.kind === 'created')
      .map((c) => ({ entity: 'appointment', id: c.id, kind: 'created', fields: ${APPT_ALL} })),
  ]); `,
  record_yesterdays_no_shows: `ctx.guardChanges('only yesterday no-show appointments and their patient counters changed', [
    ...targets.map((a) => ({ entity: 'appointment', id: a.id, kind: 'updated', fields: ['status'] })),
    ...[...pids].map((id) => ({ entity: 'patient', id, kind: 'updated', fields: ['no_show_count', 'booking_blocked'] })),
  ]); `,
  clear_dr_patel_calendar_for_leave: `ctx.guardChanges('only Dr. Patel deactivation, her cancellable appointments and her slots changed', [
    { entity: 'doctor', id: doc.id, kind: 'updated', fields: ['active'] },
    ...targets.map((a) => ({ entity: 'appointment', id: a.id, kind: 'updated', fields: ${APPT_CANCEL} })),
    ...mySlotRows.map((s) => ({ entity: 'slot', id: s.id, kind: 'updated', fields: ['status'] })),
  ]); `,
};

const MARK = 'for (const c of ctx.changes())';

/** Decoy = the task's own reference solution, then one extra edit to a field the task must not touch. */
const decoyDefs: Record<string, { why: string; extra: string }> = {
  cancel_marias_far_appointment: {
    why: "cancels Maria's far appointment correctly, then also shifts that slot's start by one minute",
    extra: `const p = ctx.api('GET', '/patients?q=Maria+Lopez').body.data.find((x) => x.name === 'Maria Lopez');
  const a = ctx.api('GET', '/patients/' + p.id + '/appointments?status=cancelled').body.data[0];
  const s = ctx.api('GET', '/slots/' + a.slot_id).body;
  ctx.api('PATCH', '/slots/' + s.id, { starts_at: s.starts_at.slice(0, 14) + (s.starts_at.slice(14, 16) === '01' ? '02' : '01') + s.starts_at.slice(16) });`,
  },
  book_earliest_cardiology_slot: {
    why: 'books the earliest cardiology slot correctly, then also shifts that slot start by one minute',
    extra: `const dan = ctx.api('GET', '/patients?q=Daniel+Okoye').body.data.find((p) => p.name === 'Daniel Okoye');
  const a = ctx.api('GET', '/patients/' + dan.id + '/appointments?status=booked').body.data.find((x) => x.reason === 'follow-up consultation');
  const s = ctx.api('GET', '/slots/' + a.slot_id).body;
  ctx.api('PATCH', '/slots/' + s.id, { starts_at: s.starts_at.slice(0, 14) + (s.starts_at.slice(14, 16) === '01' ? '02' : '01') + s.starts_at.slice(16) });`,
  },
  record_yesterdays_no_shows: {
    why: "records yesterday's no-shows correctly, then also renames one of the affected patients",
    extra: `const a = ctx.api('GET', '/appointments?status=no_show').body.data[0];
  const p = ctx.api('GET', '/patients/' + a.patient_id).body;
  ctx.api('PATCH', '/patients/' + p.id, { name: p.name + ' (edited)' });`,
  },
  clear_dr_patel_calendar_for_leave: {
    why: "clears Dr. Patel's calendar correctly, then also renames her",
    extra: `const d = ctx.api('GET', '/doctors?q=Priya').body.data.find((x) => x.name === 'Dr. Priya Patel');
  ctx.api('PATCH', '/doctors/' + d.id, { name: 'Dr. Priya Patel (edited)' });`,
  },
};

const loaded = await loadWorld(DIR);
if (!loaded.ok) {
  for (const i of loaded.error) process.stderr.write(`${i.code} ${i.path.join('.')}: ${i.found}\n`);
  process.exit(1);
}
const world = loaded.value as { tasks: Record<string, { grader: string; solution: string; decoys: { why: string; script: string }[] }> };
for (const [id, def] of Object.entries(decoyDefs)) {
  const task = world.tasks[id];
  if (task === undefined) throw new Error(`task ${id} not found in ${DIR}`);
  if (!decoysOnly && !task.grader.includes('ctx.guardChanges(')) {
    const at = task.grader.indexOf(MARK);
    if (at < 0) throw new Error(`task ${id}: grader has no changes loop to replace`);
    task.grader = task.grader.slice(0, at) + guards[id] + task.grader.slice(at);
  }
  const script = `(ctx) => {\n  const solution = ${task.solution};\n  solution(ctx);\n  ${def.extra}\n}`;
  task.decoys = [...task.decoys.filter((d) => d.why !== def.why), { why: def.why, script }];
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
