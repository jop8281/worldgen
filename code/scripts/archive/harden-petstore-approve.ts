/**
 * Hardens gen-petstore approve_placed_cat_orders with an exact-field ctx.guardChanges on each target order
 * (status and ship_date, the two fields approve_order writes) and adds a collateral decoy that approves every
 * cat order and then also approves a placed dog order. Saves through checkWorld and saveWorld.
 * Rerunning is safe: the grader is replaced and the decoy is matched by its `why`.
 * Usage: npx tsx scripts/archive/harden-petstore-approve.ts [worldDir]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const DIR = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-petstore'));
const TASK = 'approve_placed_cat_orders';

const grader = `(ctx) => {
  const cat = ctx.seed.list('category', { where: { name: 'Cats' } })[0];
  if (!cat) return 0;
  const catPets = new Set(ctx.seed.list('pet', { where: { category_id: cat.id } }).map((p) => p.id));
  const targets = ctx.seed.list('store_order', { where: { status: 'placed' } }).filter((o) => catPets.has(o.pet_id));
  if (targets.length === 0) return 0;
  ctx.guardChanges('only the placed Cats orders changed, and only status and ship_date',
    targets.map((t) => ({ entity: 'store_order', id: t.id, kind: 'updated', fields: ['status', 'ship_date'] })));
  for (const t of targets) {
    const end = ctx.db.get('store_order', t.id);
    ctx.goal(1 / targets.length, 'order ' + t.id + ' approved', end !== null && end.status === 'approved' && end.complete === false && end.ship_date !== null);
  }
  return ctx.score();
}`;

const decoy = {
  why: 'approves every placed cat order, then also approves a placed dog order',
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
  const cat = ctx.api('GET', '/categories?q=Cats').body.data.find((c) => c.name === 'Cats');
  const dog = ctx.api('GET', '/categories?q=Dogs').body.data.find((c) => c.name === 'Dogs');
  const petsOf = (c) => new Set(pages('/pet/findByStatus?status=pending&category_id=' + c.id).map((p) => p.id));
  const catPets = petsOf(cat);
  const dogPets = petsOf(dog);
  const placed = pages('/store/orders?status=placed');
  for (const o of placed.filter((x) => catPets.has(x.pet_id))) ctx.api('POST', '/store/orders/' + o.id + '/approve');
  const extra = placed.find((x) => dogPets.has(x.pet_id));
  ctx.api('POST', '/store/orders/' + extra.id + '/approve');
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
task.grader = grader;
task.decoys = [...task.decoys.filter((d) => d.why !== decoy.why), decoy];

const report = checkWorld(world);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
await saveWorld(DIR, report.world);
process.stderr.write(`wrote ${DIR}/world.yaml\n`);
