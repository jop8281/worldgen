/**
 * Pins the exact fields two gen-bakery-vague graders may change with ctx.guardChanges and adds one
 * correct-fix-then-collateral decoy to each (the correct solution, then a product rename), then saves
 * through checkWorld and saveWorld. Rerunning is safe: the guard is replaced only when still the old
 * loop, and decoys are matched by their `why`.
 * Usage: npx tsx scripts/archive/harden-gen-bakery-vague.ts [worldDir]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const DIR = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-bakery-vague'));

const BAKE_OLD = `for (const c of ctx.changes()) { if (!allowed.has(c.id)) return 0; }`;
const BAKE_NEW = `ctx.guardChanges('only the croissant batch, its product stock and its recipe ingredient stock changed', [{ entity: 'production_batch', id: batch.id, kind: 'updated', fields: ['status', 'completed_at'] }, { entity: 'product', id: prod.id, kind: 'updated', fields: ['stock_on_hand'] }, ...lines.map((l) => ({ entity: 'ingredient', id: l.ingredient_id, kind: 'updated', fields: ['stock_qty'] }))]);`;
const CANCEL_OLD = `for (const c of ctx.changes()) { if (c.entity === 'bakery_order' && orderIds.has(c.id)) continue; if (c.entity === 'product' && allowedProducts.has(c.id)) continue; return 0; }`;
const CANCEL_NEW = `ctx.guardChanges('only the target orders are cancelled and their products restocked', [...[...orderIds].map((id) => ({ entity: 'bakery_order', id, kind: 'updated', fields: ['status'] })), ...[...allowedProducts].map((id) => ({ entity: 'product', id, kind: 'updated', fields: ['stock_on_hand'] }))]);`;

const swaps: Record<string, [string, string]> = {
  bake_croissants_after_restock: [BAKE_OLD, BAKE_NEW],
  cancel_tomorrows_orders_for_discontinued_product: [CANCEL_OLD, CANCEL_NEW],
};
const decoyTail: Record<string, { why: string; name: string }> = {
  bake_croissants_after_restock: { why: 'restocks and completes the croissant batch correctly, then also renames the Butter Croissant product', name: 'Butter Croissant' },
  cancel_tomorrows_orders_for_discontinued_product: { why: 'cancels the right orders correctly, then also renames the Baguette product', name: 'Baguette' },
};

const loaded = await loadWorld(DIR);
if (!loaded.ok) {
  for (const i of loaded.error) process.stderr.write(`${i.code} ${i.path.join('.')}: ${i.found}\n`);
  process.exit(1);
}
const world = loaded.value as { tasks: Record<string, { grader: string; solution: string; decoys: { why: string; script: string }[] }> };
for (const [id, [oldText, newText]] of Object.entries(swaps)) {
  const task = world.tasks[id];
  if (task === undefined) throw new Error(`task ${id} not found in ${DIR}`);
  if (task.grader.includes(oldText)) task.grader = task.grader.replace(oldText, newText);
  else if (!task.grader.includes(newText)) throw new Error(`grader of ${id} is neither the old nor the hardened form`);
  const { why, name } = decoyTail[id];
  const script = `(ctx) => { (${task.solution})(ctx); const p = ctx.api('GET', '/products?q=' + '${name.replace(' ', '+')}').body.data.find((x) => x.name === '${name}'); ctx.api('PATCH', '/products/' + p.id, { name: '${name} (edited)' }); }`;
  task.decoys = [...task.decoys.filter((d) => d.why !== why), { why, script }];
}

const report = checkWorld(world);
for (const w of report.warnings) process.stderr.write(`warning ${w.code} ${w.path.join('.')}: ${w.found}\n`);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
await saveWorld(DIR, report.world);
process.stderr.write(`wrote ${DIR}/world.yaml\n`);
