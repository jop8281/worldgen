/**
 * Rewrites three gen-petstore graders with exact-field ctx.guardChanges allowances and adds one
 * correct-fix-then-collateral decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: graders are replaced and decoys are matched by their `why`.
 * Usage: npx tsx scripts/harden-petstore-graders.ts [worldDir] [--decoys-only]
 * --decoys-only adds the decoys to the old graders and prints the check verdict without saving.
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const args = process.argv.slice(2);
const decoysOnly = args.includes('--decoys-only');
const DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../prod/worlds/gen-petstore'));

const ORDER_FIELDS = `['pet_id', 'quantity', 'ship_date', 'status', 'complete']`;

const graders: Record<string, string> = {
  order_available_pet: `(ctx) => {
  const pets = ctx.seed.list('pet', { where: { name: 'Biscuit' } });
  if (pets.length !== 1) return 0;
  const target = pets[0];
  const orders = ctx.db.list('store_order', { where: { pet_id: target.id } });
  ctx.guardChanges('only Biscuit status and its new order changed', [
    { entity: 'pet', id: target.id, kind: 'updated', fields: ['status'] },
    ...orders.filter((o) => ctx.seed.get('store_order', o.id) === null)
      .map((o) => ({ entity: 'store_order', id: o.id, kind: 'created', fields: ${ORDER_FIELDS} })),
  ]);
  const okOrder = orders.length === 1 && orders[0].status === 'placed' && orders[0].quantity === 1;
  ctx.goal(0.7, 'exactly one placed order with quantity 1 for Biscuit', okOrder);
  const end = ctx.db.get('pet', target.id);
  ctx.goal(0.3, 'Biscuit is pending', end !== null && end.status === 'pending');
  return ctx.score();
}`,
  cancel_wrong_mochi_order: `(ctx) => {
  const cats = ctx.seed.list('category', { where: { name: 'Cats' } })[0];
  const fish = ctx.seed.list('category', { where: { name: 'Fish' } })[0];
  if (!cats || !fish) return 0;
  const catPet = ctx.seed.list('pet', { where: { name: 'Mochi', category_id: cats.id } })[0];
  const fishPet = ctx.seed.list('pet', { where: { name: 'Mochi', category_id: fish.id } })[0];
  if (!catPet || !fishPet) return 0;
  const catOrder = ctx.seed.list('store_order', { where: { pet_id: catPet.id } })[0];
  const fishOrder = ctx.seed.list('store_order', { where: { pet_id: fishPet.id } })[0];
  if (!catOrder || !fishOrder) return 0;
  ctx.guardChanges('only the cat Mochi order deleted and its status changed', [
    { entity: 'store_order', id: catOrder.id, kind: 'deleted', fields: ${ORDER_FIELDS} },
    { entity: 'pet', id: catPet.id, kind: 'updated', fields: ['status'] },
  ]);
  const fishEnd = ctx.db.get('pet', fishPet.id);
  ctx.guard('the fish Mochi and its order are untouched', ctx.db.get('store_order', fishOrder.id) !== null && fishEnd !== null && fishEnd.status === 'pending');
  ctx.goal(0.6, 'the cat order is deleted', ctx.db.get('store_order', catOrder.id) === null);
  const catEnd = ctx.db.get('pet', catPet.id);
  ctx.goal(0.4, 'the cat is available again', catEnd !== null && catEnd.status === 'available');
  return ctx.score();
}`,
  order_all_rescue_dogs: `(ctx) => {
  const dogs = ctx.seed.list('category', { where: { name: 'Dogs' } })[0];
  const rescue = ctx.seed.list('tag', { where: { name: 'rescue' } })[0];
  if (!dogs || !rescue) return 0;
  const rescued = new Set(ctx.seed.list('pet_tag', { where: { tag_id: rescue.id } }).map((r) => r.pet_id));
  const targets = ctx.seed.list('pet', { where: { category_id: dogs.id, status: 'available' } }).filter((p) => rescued.has(p.id));
  if (targets.length === 0) return 0;
  const created = targets.flatMap((t) => ctx.db.list('store_order', { where: { pet_id: t.id } }))
    .filter((o) => ctx.seed.get('store_order', o.id) === null);
  ctx.guardChanges('only rescue dog status and their new orders changed', [
    ...targets.map((t) => ({ entity: 'pet', id: t.id, kind: 'updated', fields: ['status'] })),
    ...created.map((o) => ({ entity: 'store_order', id: o.id, kind: 'created', fields: ${ORDER_FIELDS} })),
  ]);
  for (const t of targets) {
    const orders = ctx.db.list('store_order', { where: { pet_id: t.id } });
    const end = ctx.db.get('pet', t.id);
    const ok = orders.length === 1 && orders[0].status === 'placed' && orders[0].quantity === 1 && end !== null && end.status === 'pending';
    ctx.goal(1 / targets.length, 'rescue dog ' + t.id + ' ordered once', ok);
  }
  return ctx.score();
}`,
};

const decoys: Record<string, { why: string; script: string }> = {
  order_available_pet: {
    why: 'places the correct order, then also renames Biscuit',
    script: `(ctx) => {
  const p = ctx.api('GET', '/pet/findByStatus?status=available&q=Biscuit').body.data.find((x) => x.name === 'Biscuit');
  ctx.api('POST', '/store/orders', { pet_id: p.id, quantity: 1 });
  ctx.api('PUT', '/pet', { id: p.id, name: 'Biscuit Jr', category_id: p.category_id, photo_urls: p.photo_urls, status: 'pending' });
}`,
  },
  cancel_wrong_mochi_order: {
    why: "deletes the cat Mochi's order, then also replaces the cat's photos",
    script: `(ctx) => {
  const cats = ctx.api('GET', '/categories?q=Cats').body.data.find((c) => c.name === 'Cats');
  const p = ctx.api('GET', '/pet/findByStatus?q=Mochi').body.data.find((x) => x.name === 'Mochi' && x.category_id === cats.id);
  const o = ctx.api('GET', '/store/orders?pet_id=' + p.id).body.data[0];
  ctx.api('DELETE', '/store/orders/' + o.id);
  ctx.api('PUT', '/pet', { id: p.id, name: p.name, category_id: p.category_id, photo_urls: 'https://img.example/mochi-new.jpg', status: 'available' });
}`,
  },
  order_all_rescue_dogs: {
    why: 'orders every rescue dog correctly, then also moves one of them to the Cats category',
    script: `(ctx) => {
  const pages = (path) => {
    const rows = [];
    let cursor = null;
    do {
      const r = ctx.api('GET', path + (cursor === null ? '' : '&cursor=' + cursor));
      rows.push(...r.body.data);
      cursor = r.body.next_cursor;
    } while (cursor);
    return rows;
  };
  const dogs = ctx.api('GET', '/categories?q=Dogs').body.data.find((c) => c.name === 'Dogs');
  const cats = ctx.api('GET', '/categories?q=Cats').body.data.find((c) => c.name === 'Cats');
  const rescue = ctx.api('GET', '/tags?q=rescue').body.data.find((t) => t.name === 'rescue');
  const rescued = new Set(pages('/pet_tags?tag_id=' + rescue.id).map((r) => r.pet_id));
  const targets = pages('/pet/findByStatus?status=available&category_id=' + dogs.id).filter((p) => rescued.has(p.id));
  for (const p of targets) ctx.api('POST', '/store/orders', { pet_id: p.id, quantity: 1 });
  const p = targets[0];
  ctx.api('PUT', '/pet', { id: p.id, name: p.name, category_id: cats.id, photo_urls: p.photo_urls, status: 'pending' });
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
