/**
 * Pins the exact fields two gen-rental-fleet graders may see changed (ctx.guardChanges) and adds one
 * correct-fix-then-collateral decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: the grader edit is a replace of a known old text or a no-op, decoys match by `why`.
 * Usage: npx tsx scripts/harden-gen-rental-fleet.ts [worldDir]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const DIR = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../prod/worlds/gen-rental-fleet'));

const edits: Record<string, { old: string; next: string; marker: string }> = {
  return_tomas_reyes_suv: {
    old: `ctx.guard('only the target rental and its vehicle changed', ctx.changes().every((c) => (c.entity === 'rental' && c.id === t.id) || (c.entity === 'vehicle' && c.id === t.vehicle_id)));`,
    next: `ctx.guardChanges('only the target rental check-in and its vehicle availability and odometer changed', [{ entity: 'rental', id: t.id, kind: 'updated', fields: ['status', 'returned_at', 'odometer_in', 'branch_id'] }, { entity: 'vehicle', id: t.vehicle_id, kind: 'updated', fields: ['status', 'odometer_km', 'branch_id'] }]);`,
    marker: 'ctx.guardChanges(',
  },
  triage_small_claims: {
    old: `for (const c of ctx.changes()) { if (c.entity === 'damage_claim' && ids.has(c.id)) continue; if (c.entity === 'vehicle' && vids.has(c.id)) continue; return 0; }`,
    next: `ctx.guardChanges('only the under_review claims were decided', targets.flatMap((t) => [{ entity: 'damage_claim', id: t.id, kind: 'updated', fields: t.estimated_cost < 15000 ? ['status', 'denial_reason', 'resolved_at'] : ['status', 'approved_amount', 'resolved_at'] }, ...(t.estimated_cost < 15000 ? [] : [{ entity: 'vehicle', id: t.vehicle_id, kind: 'updated', fields: ['status'] }])]));`,
    marker: 'ctx.guardChanges(',
  },
};

const decoys: Record<string, { why: string; script: string }> = {
  return_tomas_reyes_suv: {
    why: 'returns the right rental correctly, then also renames the make of the returned vehicle',
    script: `(ctx) => { const tm = ctx.api('GET', '/customers?q=Tomas').body.data.find((c) => c.name === 'Tomas Reyes'); const act = ctx.api('GET', '/customers/' + tm.id + '/rentals?status=active').body.data; const r = ctx.api('POST', '/rentals/' + act[0].id + '/return', { odometer_in: 48210 }); ctx.assert(r.status === 200, 'return failed: ' + JSON.stringify(r.body)); const p = ctx.api('PATCH', '/vehicles/' + act[0].vehicle_id, { make: 'Toyota (edited)' }); ctx.assert(p.status === 200, 'patch failed: ' + JSON.stringify(p.body)); }`,
  },
  triage_small_claims: {
    why: 'triages every claim correctly, then also renames the make of one claimed vehicle',
    script: `(ctx) => { const pages = (path) => { const rows = []; let cursor = null; do { const r = ctx.api('GET', path + (cursor === null ? '' : '&cursor=' + cursor)); rows.push(...r.body.data); cursor = r.body.next_cursor; } while (cursor !== null && cursor !== undefined); return rows; }; const claims = pages('/damage_claims?status=under_review&limit=25'); for (const c of claims) { const r = c.estimated_cost < 15000 ? ctx.api('POST', '/damage_claims/' + c.id + '/deny', { reason: 'Minor wear and tear' }) : ctx.api('POST', '/damage_claims/' + c.id + '/approve', { approved_amount: c.estimated_cost }); ctx.assert(r.status === 200, 'triage failed: ' + JSON.stringify(r.body)); } const p = ctx.api('PATCH', '/vehicles/' + claims[0].vehicle_id, { make: 'Chrysler (edited)' }); ctx.assert(p.status === 200, 'patch failed: ' + JSON.stringify(p.body)); }`,
  },
};

const loaded = await loadWorld(DIR);
if (!loaded.ok) {
  for (const i of loaded.error) process.stderr.write(`${i.code} ${i.path.join('.')}: ${i.found}\n`);
  process.exit(1);
}
const world = loaded.value as { tasks: Record<string, { grader: string; decoys: { why: string; script: string }[] }> };
for (const [id, e] of Object.entries(edits)) {
  const task = world.tasks[id];
  if (task === undefined) throw new Error(`task ${id} not found in ${DIR}`);
  if (!task.grader.includes(e.marker)) {
    if (!task.grader.includes(e.old)) throw new Error(`grader of ${id} has neither the old text nor the hardened text`);
    task.grader = task.grader.replace(e.old, () => e.next);
  }
  const decoy = decoys[id];
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
