/**
 * Pins the exact fields two gen-hotel-booking graders may change with ctx.guardChanges and adds one
 * correct-fix-then-collateral decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: graders are replaced and decoys are matched by their `why`.
 * Usage: npx tsx scripts/archive/harden-gen-hotel-booking.ts [worldDir] [--decoys-only]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const args = process.argv.slice(2);
const decoysOnly = args.includes('--decoys-only');
const DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-hotel-booking'));

const graders: Record<string, string> = {
  cancel_distant_reservation: `(ctx) => {
  const g = ctx.seed.list('guest', { where: { name: 'Eleanor Whitfield' } })[0];
  if (!g) return 0;
  const target = ctx.seed.list('reservation', { where: { guest_id: g.id, status: 'confirmed' } })[0];
  if (!target) return 0;
  if (ctx.changes().length === 0) return 0;
  ctx.guardChanges('only the target reservation is cancelled', [
    { entity: 'reservation', id: target.id, kind: 'updated', fields: ['status', 'cancelled_at', 'cancellation_fee'] },
  ]);
  const end = ctx.db.get('reservation', target.id);
  if (!end) return 0;
  ctx.goal(1, 'cancelled with no fee', end.status === 'cancelled' && end.cancellation_fee === 0 && end.cancelled_at !== null);
  return ctx.score();
}`,
  cancel_arriving_tomorrow_with_fee: `(ctx) => {
  const g = ctx.seed.list('guest', { where: { name: 'Marcus Okafor' } })[0];
  if (!g) return 0;
  let target = null;
  for (const r of ctx.seed.list('reservation', { where: { guest_id: g.id, status: 'confirmed' } })) {
    if (target === null || ctx.time.minutesBetween(r.check_in, target.check_in) > 0) target = r;
  }
  if (target === null) return 0;
  if (ctx.changes().length === 0) return 0;
  const fees = ctx.db.list('folio_charge', { where: { reservation_id: target.id } }).filter((f) => ctx.seed.get('folio_charge', f.id) === null);
  ctx.guardChanges('only the target reservation is cancelled and its fee charge created', [
    { entity: 'reservation', id: target.id, kind: 'updated', fields: ['status', 'cancelled_at', 'cancellation_fee'] },
    ...fees.map((f) => ({ entity: 'folio_charge', id: f.id, kind: 'created', fields: ['reservation_id', 'kind', 'amount', 'description'] })),
  ]);
  const end = ctx.db.get('reservation', target.id);
  if (!end || end.status !== 'cancelled' || end.cancelled_at === null) return 0;
  if (end.cancellation_fee !== target.nightly_rate) return 0;
  const before = ctx.seed.list('folio_charge', { where: { reservation_id: target.id } }).length;
  const kinds = ctx.db.list('folio_charge', { where: { reservation_id: target.id, kind: 'cancellation_fee' } });
  const all = ctx.db.list('folio_charge', { where: { reservation_id: target.id } });
  if (before !== 0 || all.length !== 1 || kinds.length !== 1) return 0;
  ctx.goal(1, 'one cancellation_fee of one night', kinds[0].amount === target.nightly_rate);
  return ctx.score();
}`,
};

const decoys: Record<string, { why: string; script: string }> = {
  cancel_distant_reservation: {
    why: 'cancels the correct reservation, then also changes its adults count',
    script: `(ctx) => {
  const g = ctx.api('GET', '/guests?q=Whitfield').body.data.find((x) => x.name === 'Eleanor Whitfield');
  const res = ctx.api('GET', '/reservations?guest_id=' + g.id + '&status=confirmed').body.data;
  ctx.api('POST', '/reservations/' + res[0].id + '/cancel', {});
  ctx.api('PATCH', '/reservations/' + res[0].id, { adults: 3 });
}`,
  },
  cancel_arriving_tomorrow_with_fee: {
    why: 'cancels the correct reservation, then also changes its adults count',
    script: `(ctx) => {
  const g = ctx.api('GET', '/guests?q=Okafor').body.data.find((x) => x.name === 'Marcus Okafor');
  const res = ctx.api('GET', '/reservations?guest_id=' + g.id + '&status=confirmed&sort=check_in').body.data;
  ctx.api('POST', '/reservations/' + res[0].id + '/cancel', {});
  ctx.api('PATCH', '/reservations/' + res[0].id, { adults: 2 });
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
