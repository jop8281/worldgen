/**
 * Rewrites two gen-shipments graders with exact-field ctx.guardChanges allowances and adds one
 * correct-fix-then-collateral decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: graders are replaced and decoys are matched by their `why`.
 * Usage: npx tsx scripts/harden-gen-shipments.ts [worldDir] [--decoys-only]
 * --decoys-only adds the decoys to the old graders and prints the check verdict without saving.
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const args = process.argv.slice(2);
const decoysOnly = args.includes('--decoys-only');
const DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../prod/worlds/gen-shipments'));

const EVENT_FIELDS = `['shipment_id', 'kind', 'hub_id', 'note']`;

const graders: Record<string, string> = {
  dispatch_heaviest_created_shipment: `(ctx) => {
  const created = ctx.seed.list('shipment', { where: { status: 'created' } });
  let target = null;
  for (const s of created) { if (target === null || s.weight_kg > target.weight_kg) target = s; }
  if (target === null) return 0;
  const old = new Set(ctx.seed.list('shipment_event', { where: { shipment_id: target.id } }).map((e) => e.id));
  const events = ctx.db.list('shipment_event', { where: { shipment_id: target.id } }).filter((e) => !old.has(e.id));
  ctx.guardChanges('only the target shipment status, shipped_at and ETA, and its new events changed', [
    { entity: 'shipment', id: target.id, kind: 'updated', fields: ['status', 'shipped_at', 'expected_delivery_at'] },
    ...events.map((e) => ({ entity: 'shipment_event', id: e.id, kind: 'created', fields: ${EVENT_FIELDS} })),
  ]);
  const end = ctx.db.get('shipment', target.id);
  const ok = end !== null && end.status === 'in_transit' && end.shipped_at !== null && end.expected_delivery_at !== null;
  const fresh = events.filter((e) => e.kind === 'dispatched');
  ctx.goal(0.7, 'the heaviest created shipment is in_transit with shipped_at and an ETA', ok);
  ctx.goal(0.3, 'one dispatched event was written', ok && fresh.length === 1);
  return ctx.score();
}`,
  move_postnl_created_to_dpd: `(ctx) => {
  const post = ctx.seed.list('carrier', { where: { name: 'PostNL' } })[0];
  const dpd = ctx.seed.list('carrier', { where: { name: 'DPD' } })[0];
  if (!post || !dpd) return 0;
  const targets = ctx.seed.list('shipment', { where: { carrier_id: post.id, status: 'created' } });
  if (targets.length === 0) return 0;
  const old = new Set(ctx.seed.list('shipment_event').map((e) => e.id));
  const events = targets.flatMap((t) => ctx.db.list('shipment_event', { where: { shipment_id: t.id } })).filter((e) => !old.has(e.id));
  ctx.guardChanges('only the carrier of the created PostNL shipments and their new events changed', [
    ...targets.map((t) => ({ entity: 'shipment', id: t.id, kind: 'updated', fields: ['carrier_id'] })),
    ...events.map((e) => ({ entity: 'shipment_event', id: e.id, kind: 'created', fields: ${EVENT_FIELDS} })),
  ]);
  let done = 0;
  for (const t of targets) {
    const end = ctx.db.get('shipment', t.id);
    if (end === null || end.carrier_id !== dpd.id || end.status !== 'created') continue;
    const evs = events.filter((e) => e.shipment_id === t.id && e.kind === 'carrier_changed');
    if (evs.length === 1) done += 1;
  }
  return done / targets.length;
}`,
};

const decoys: Record<string, { why: string; script: string }> = {
  dispatch_heaviest_created_shipment: {
    why: 'dispatches the heaviest created shipment correctly, then also edits its weight',
    script: `(ctx) => {
  const r = ctx.api('GET', '/shipments?status=created&sort=-weight_kg&limit=1');
  const s = r.body.data[0];
  ctx.api('POST', '/shipments/' + s.id + '/dispatch', {});
  ctx.api('PATCH', '/shipments/' + s.id, { weight_kg: s.weight_kg + 1 });
}`,
  },
  move_postnl_created_to_dpd: {
    why: 'reassigns every created PostNL shipment correctly, then also edits the weight of one',
    script: `(ctx) => {
  const cars = ctx.api('GET', '/carriers').body.data;
  const post = cars.find((c) => c.name === 'PostNL');
  const dpd = cars.find((c) => c.name === 'DPD');
  const rows = [];
  let cur = null;
  do {
    const r = ctx.api('GET', '/shipments?carrier_id=' + post.id + '&status=created' + (cur === null ? '' : '&cursor=' + cur));
    rows.push(...r.body.data);
    cur = r.body.next_cursor;
  } while (cur);
  for (const s of rows) ctx.api('POST', '/shipments/' + s.id + '/reassign_carrier', { carrier_id: dpd.id });
  ctx.api('PATCH', '/shipments/' + rows[0].id, { weight_kg: rows[0].weight_kg + 1 });
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
