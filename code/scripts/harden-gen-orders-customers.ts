/**
 * Replaces the blanket "skip every change on the target row" loops in three gen-orders-customers
 * graders with exact-field ctx.guardChanges allowances, and adds one correct-fix-then-collateral
 * decoy to each, then saves through checkWorld and saveWorld.
 * Rerunning is safe: graders are replaced and decoys are matched by their `why`.
 * Usage: npx tsx scripts/harden-gen-orders-customers.ts [worldDir] [--decoys-only]
 * --decoys-only adds the decoys to the old graders and prints the check verdict without saving.
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const args = process.argv.slice(2);
const decoysOnly = args.includes('--decoys-only');
const DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(import.meta.dirname, '../../prod/worlds/gen-orders-customers'));

const graders: Record<string, string> = {
  ship_ada_paid_order: `(ctx) => {
  const ada = ctx.seed.list('customer', { where: { name: 'Ada Lovelace' } })[0];
  if (!ada) return 0;
  const paid = ctx.seed.list('shop_order', { where: { customer_id: ada.id, status: 'paid' } });
  if (paid.length !== 1) return 0;
  const target = paid[0];
  ctx.guardChanges('only the status and shipped_at of Ada paid order changed', [
    { entity: 'shop_order', id: target.id, kind: 'updated', fields: ['status', 'shipped_at'] },
  ]);
  const end = ctx.db.get('shop_order', target.id);
  return end.status === 'shipped' && end.shipped_at !== null && end.shipped_at >= target.placed_at ? 1 : 0;
}`,
  cancel_customer_unpaid_orders: `(ctx) => {
  const c = ctx.seed.list('customer', { where: { email: 'edsger.dijkstra@example.com' } })[0];
  if (!c) return 0;
  const targets = ctx.seed.list('shop_order', { where: { customer_id: c.id, status: 'pending' } });
  if (targets.length === 0) return 0;
  ctx.guardChanges('only the status and note of the pending orders changed', targets.map((t) => (
    { entity: 'shop_order', id: t.id, kind: 'updated', fields: ['status', 'note'] }
  )));
  let done = 0;
  for (const t of targets) {
    const end = ctx.db.get('shop_order', t.id);
    if (end.status === 'cancelled') done += 1;
  }
  return done / targets.length;
}`,
  refund_large_gb_pro_orders: `(ctx) => {
  const team = new Set(ctx.seed.list('customer', { where: { plan: 'team' } }).map((c) => c.id));
  const targets = ctx.seed.list('shop_order', { where: { status: 'delivered' } }).filter((o) => team.has(o.customer_id) && o.total_cents > 10000);
  if (targets.length === 0) return 0;
  ctx.guardChanges('only the status of the matching orders changed', targets.map((t) => (
    { entity: 'shop_order', id: t.id, kind: 'updated', fields: ['status'] }
  )));
  let done = 0;
  for (const t of targets) {
    const end = ctx.db.get('shop_order', t.id);
    if (end.status === 'refunded' && end.shipped_at === t.shipped_at) done += 1;
  }
  return done / targets.length;
}`,
};

const decoys: Record<string, { why: string; script: string }> = {
  ship_ada_paid_order: {
    why: "ships Ada's paid order correctly, then also changes its item_count",
    script: `(ctx) => {
  const ada = ctx.api('GET', '/customers?q=Ada+Lovelace').body.data.find((c) => c.name === 'Ada Lovelace');
  const paid = ctx.api('GET', '/customers/' + ada.id + '/orders?status=paid').body.data;
  ctx.api('POST', '/orders/' + paid[0].id + '/ship', {});
  ctx.api('PATCH', '/orders/' + paid[0].id, { item_count: paid[0].item_count + 1 });
}`,
  },
  cancel_customer_unpaid_orders: {
    why: "cancels every pending order of the customer correctly, then also changes one order's item_count",
    script: `(ctx) => {
  const cust = ctx.api('GET', '/customers?q=edsger.dijkstra').body.data.find((c) => c.email === 'edsger.dijkstra@example.com');
  const pending = ctx.api('GET', '/customers/' + cust.id + '/orders?status=pending').body.data;
  for (const o of pending) ctx.api('POST', '/orders/' + o.id + '/cancel', { reason: 'Cancelled at customer request' });
  ctx.api('PATCH', '/orders/' + pending[0].id, { item_count: pending[0].item_count + 1 });
}`,
  },
  refund_large_gb_pro_orders: {
    why: 'refunds every matching order correctly, then also changes one refunded order item_count',
    script: `(ctx) => {
  const pages = (path) => {
    const rows = [];
    let cursor = null;
    const sep = path.includes('?') ? '&' : '?';
    do {
      const r = ctx.api('GET', path + (cursor === null ? '' : sep + 'cursor=' + cursor));
      rows.push(...r.body.data);
      cursor = r.body.next_cursor;
    } while (cursor !== null && cursor !== undefined);
    return rows;
  };
  const team = new Set(pages('/customers?plan=team').map((c) => c.id));
  const targets = pages('/orders?status=delivered').filter((o) => team.has(o.customer_id) && o.total_cents > 10000);
  for (const o of targets) ctx.api('POST', '/orders/' + o.id + '/refund', {});
  ctx.api('PATCH', '/orders/' + targets[0].id, { item_count: targets[0].item_count + 1 });
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
