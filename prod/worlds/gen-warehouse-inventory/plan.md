# WorldGen plan: Warehouse inventory / WMS-style stock ledger with purchase-order receiving (in the spirit of Odoo Inventory, NetSuite Inventory and Fishbowl)

A single-warehouse inventory system. SKUs are stocked in bins (stock_level rows, one per SKU and bin). Every change to stock is written to an append-only stock_movement ledger by an action, and stock can never go below zero. Purchase orders to suppliers move draft -> submitted -> partially_received -> received (or cancelled). Goods are received one PO line and one bin at a time, so a PO is received into bins in several partial shipments. Receiving is refused when it would exceed the ordered quantity, overfill a bin, or target an inactive or quarantine bin. Agents also issue stock, run cycle-count adjustments and transfer stock between bins. A job flags overdue purchase orders.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `supplier` | A vendor that purchase orders are placed with. | name, email, active |
| `sku` | A stock keeping unit: a distinct item the warehouse holds. code is unique. reorder_point is the minimum desired quantity in pick bins. | code, name, unit_cost, reorder_point, active |
| `bin` | A storage location. zone is receiving, pick, bulk or quarantine. capacity is the maximum total units across all SKUs in the bin. quarantine bins and inactive bins cannot receive stock. | code, zone, capacity, active |
| `stock_level` | Current on-hand quantity of one SKU in one bin. quantity is readonly, min 0, and changed only by actions. Unique per (sku, bin) by action logic. | sku_id, bin_id, quantity |
| `stock_movement` | Append-only ledger row written by every stock action. kind is receipt, issue, adjustment, transfer_in or transfer_out. quantity_delta is signed. balance_after is the bin quantity after the movement. Receipts carry purchase_order_id and purchase_order_line_id. | sku_id, bin_id, kind, quantity_delta, balance_after, purchase_order_id, purchase_order_line_id, reference |
| `purchase_order` | An order to a supplier. status is a readonly state (draft, submitted, partially_received, received, cancelled). overdue is a readonly flag set by a job. | number, supplier_id, status, expected_at, submitted_at, received_at, overdue, note |
| `purchase_order_line` | One SKU on a purchase order. ordered_qty is fixed, received_qty is readonly and grows with each partial receipt and never exceeds ordered_qty. | purchase_order_id, sku_id, ordered_qty, received_qty, unit_cost |

## Workflows

### purchase_order_lifecycle (purchase_order)
- States: draft, submitted, partially_received, received, cancelled
- Actions: add_po_line, submit_purchase_order, receive_purchase_order, cancel_purchase_order
- Rules:
  - A PO is created as draft. Lines are added only while draft, with add_po_line (ordered_qty >= 1, SKU must be active, one line per SKU per PO).
  - submit needs at least one line, otherwise 409 no_lines. It sets submitted_at and moves draft -> submitted.
  - receive works only in submitted or partially_received (409 invalid_state otherwise). The line must belong to the PO (409 line_mismatch). The bin must be active and not quarantine (409 bin_not_receivable). quantity must be between 1 and the line's remaining quantity (409 over_receipt). The bin's total units after receipt must not exceed its capacity (409 bin_capacity_exceeded).
  - A successful receive increases line.received_qty, upserts the stock_level for (sku, bin), appends a receipt movement carrying the PO and line ids, and updates PO status in the same call: partially_received while any line has a remaining quantity, received (with received_at) when none has.
  - cancel works only for draft or submitted POs with no receipts. Otherwise 409 invalid_state. received and cancelled are final.
  - Job overdue_purchase_orders (every 6h) sets overdue=true on submitted and partially_received POs whose expected_at has passed.
### stock_ledger (stock_level)
- States: empty, stocked
- Actions: issue_stock, adjust_stock, transfer_stock
- Rules:
  - Stock never goes negative. quantity has min 0 and every action refuses with 409 insufficient_stock first.
  - Every stock change appends exactly one stock_movement per affected bin, with signed quantity_delta and balance_after equal to the new bin quantity. Movements are never edited or deleted.
  - issue_stock removes quantity (>= 1) of a SKU from a bin. It is 409 insufficient_stock if the bin holds less, or holds none.
  - adjust_stock sets the exact quantity (>= 0) for a SKU and bin from a cycle count. It needs a non-blank reason. It writes an adjustment movement with delta new_quantity minus current. A zero delta is 409 no_change. Raising a quantity respects bin capacity.
  - transfer_stock moves quantity between two different bins (422 same_bin if equal). It is 409 insufficient_stock if the source holds less. The destination must be receivable (409 bin_not_receivable) and within capacity (409 bin_capacity_exceeded). It writes a transfer_out and a transfer_in movement atomically.
  - A stock_level row with quantity 0 is kept (not deleted) so history stays visible.

## Jobs

- `overdue_purchase_orders` runs every 6h: Set overdue=true on every purchase order in status submitted or partially_received whose expected_at is at or before now. Draft, received and cancelled POs are never flagged. Idempotent, and it writes no ledger rows.

## Acceptance tests

### partial_receipt_flow
- Intent: A PO is received into two bins in two partial shipments, with status, line received_qty, stock levels and ledger updated each time.
- Actions: add_po_line, submit_purchase_order, receive_purchase_order
- Description: Create a supplier, SKU, two bins and a PO with one line of 100. Submit. Receive 40 into bin 1, which makes the PO partially_received. Receive 60 into bin 2, which makes it received. Stock levels and receipt movements match. Receiving again is 409 invalid_state.

```js
(ctx) => {
  const ok = (r, m) => ctx.assert(r.status >= 200 && r.status < 300, m + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const mk = (path, body, m) => { const r = ctx.api('POST', path, body); ok(r, m); return r.body; };
  const sup = mk('/suppliers', { name: 'Test Supplier A', email: 'a@supplier.example' }, 'supplier');
  const sku = mk('/skus', { code: 'T-1001', name: 'Widget', unit_cost: 250, reorder_point: 10 }, 'sku');
  const b1 = mk('/bins', { code: 'T-A-01', zone: 'bulk', capacity: 1000 }, 'bin1');
  const b2 = mk('/bins', { code: 'T-A-02', zone: 'bulk', capacity: 1000 }, 'bin2');
  const po = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-1001', expected_at: '2026-10-20T00:00:00.000Z' }, 'po');
  ctx.assert(po.status === 'draft', 'new PO is draft, got ' + po.status);
  const line = mk('/purchase_orders/' + po.id + '/add_line', { sku_id: sku.id, ordered_qty: 100, unit_cost: 250 }, 'add_line');
  ctx.assert(line.received_qty === 0 && line.ordered_qty === 100, 'line starts unreceived, got ' + JSON.stringify(line));
  const sub = mk('/purchase_orders/' + po.id + '/submit', {}, 'submit');
  ctx.assert(sub.status === 'submitted' && sub.submitted_at !== null, 'PO submitted with submitted_at, got ' + JSON.stringify(sub));
  const r1 = mk('/purchase_orders/' + po.id + '/receive', { line_id: line.id, bin_id: b1.id, quantity: 40, note: 'first pallet' }, 'receive 1');
  ctx.assert(r1.purchase_order.status === 'partially_received', 'partially_received after first receipt, got ' + r1.purchase_order.status);
  ctx.assert(r1.line.received_qty === 40, 'line received_qty 40, got ' + r1.line.received_qty);
  ctx.assert(r1.stock_level.quantity === 40 && r1.stock_level.bin_id === b1.id, 'stock level 40 in bin 1, got ' + JSON.stringify(r1.stock_level));
  ctx.assert(r1.movement.kind === 'receipt' && r1.movement.quantity_delta === 40 && r1.movement.balance_after === 40 && r1.movement.purchase_order_id === po.id, 'receipt movement, got ' + JSON.stringify(r1.movement));
  const r2 = mk('/purchase_orders/' + po.id + '/receive', { line_id: line.id, bin_id: b2.id, quantity: 60 }, 'receive 2');
  ctx.assert(r2.purchase_order.status === 'received' && r2.purchase_order.received_at !== null, 'received with received_at, got ' + JSON.stringify(r2.purchase_order));
  ctx.assert(r2.line.received_qty === 100, 'line fully received, got ' + r2.line.received_qty);
  const levels = ctx.api('GET', '/stock_levels?sku_id=' + sku.id).body.data;
  ctx.assert(levels.length === 2 && levels.reduce((a, l) => a + l.quantity, 0) === 100, 'two levels totalling 100, got ' + JSON.stringify(levels));
  const moves = ctx.api('GET', '/stock_movements?purchase_order_id=' + po.id).body.data;
  ctx.assert(moves.length === 2 && moves.every((m) => m.kind === 'receipt'), 'two receipt movements, got ' + moves.length);
  const again = ctx.api('POST', '/purchase_orders/' + po.id + '/receive', { line_id: line.id, bin_id: b1.id, quantity: 1 });
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'receive on received PO: ' + JSON.stringify(again));
}
```
### over_receipt_and_line_mismatch_refused
- Intent: Receiving more than remains, or a line of another PO, is refused and changes nothing.
- Actions: add_po_line, submit_purchase_order, receive_purchase_order
- Description: Receive 101 on a 100-unit line gives 409 over_receipt and leaves the line, PO and stock untouched. Quantity 0 is 400. A line from another PO is 409 line_mismatch. Receiving 60, then 41, is also over_receipt.

```js
(ctx) => {
  const ok = (r, m) => ctx.assert(r.status >= 200 && r.status < 300, m + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const mk = (path, body, m) => { const r = ctx.api('POST', path, body); ok(r, m); return r.body; };
  const sup = mk('/suppliers', { name: 'Test Supplier B', email: 'b@supplier.example' }, 'supplier');
  const sku = mk('/skus', { code: 'T-2001', name: 'Gasket', unit_cost: 90, reorder_point: 5 }, 'sku');
  const bin = mk('/bins', { code: 'T-B-01', zone: 'bulk', capacity: 1000 }, 'bin');
  const po1 = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-2001', expected_at: '2026-10-20T00:00:00.000Z' }, 'po1');
  const po2 = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-2002', expected_at: '2026-10-20T00:00:00.000Z' }, 'po2');
  const l1 = mk('/purchase_orders/' + po1.id + '/add_line', { sku_id: sku.id, ordered_qty: 100 }, 'line1');
  const l2 = mk('/purchase_orders/' + po2.id + '/add_line', { sku_id: sku.id, ordered_qty: 10 }, 'line2');
  mk('/purchase_orders/' + po1.id + '/submit', {}, 'submit1');
  mk('/purchase_orders/' + po2.id + '/submit', {}, 'submit2');
  const over = ctx.api('POST', '/purchase_orders/' + po1.id + '/receive', { line_id: l1.id, bin_id: bin.id, quantity: 101 });
  ctx.assert(over.status === 409 && over.body.error.code === 'over_receipt', 'over receipt: ' + JSON.stringify(over));
  const zero = ctx.api('POST', '/purchase_orders/' + po1.id + '/receive', { line_id: l1.id, bin_id: bin.id, quantity: 0 });
  ctx.assert(zero.status === 400 && zero.body.error.code === 'input.invalid', 'zero quantity: ' + JSON.stringify(zero));
  const mismatch = ctx.api('POST', '/purchase_orders/' + po1.id + '/receive', { line_id: l2.id, bin_id: bin.id, quantity: 5 });
  ctx.assert(mismatch.status === 409 && mismatch.body.error.code === 'line_mismatch', 'line mismatch: ' + JSON.stringify(mismatch));
  ctx.assert(ctx.api('GET', '/stock_levels?sku_id=' + sku.id).body.data.length === 0, 'refused receipts created no stock');
  ctx.assert(ctx.api('GET', '/stock_movements?sku_id=' + sku.id).body.data.length === 0, 'refused receipts wrote no movement');
  const po = ctx.api('GET', '/purchase_orders/' + po1.id).body;
  ctx.assert(po.status === 'submitted', 'PO still submitted, got ' + po.status);
  mk('/purchase_orders/' + po1.id + '/receive', { line_id: l1.id, bin_id: bin.id, quantity: 60 }, 'receive 60');
  const over2 = ctx.api('POST', '/purchase_orders/' + po1.id + '/receive', { line_id: l1.id, bin_id: bin.id, quantity: 41 });
  ctx.assert(over2.status === 409 && over2.body.error.code === 'over_receipt', 'second over receipt: ' + JSON.stringify(over2));
  const line = ctx.api('GET', '/purchase_orders/' + po1.id + '/lines').body.data.find((l) => l.id === l1.id);
  ctx.assert(line.received_qty === 60, 'line stays at 60, got ' + line.received_qty);
}
```
### issue_never_goes_negative
- Intent: Stock can be issued down to exactly zero but never below, and each issue writes a ledger row.
- Actions: add_po_line, submit_purchase_order, receive_purchase_order, issue_stock
- Description: Receive 30 units, then issue 31 (409 insufficient_stock, stock unchanged), issue 30 (stock 0, issue movement with delta -30), issue 1 more (409). An issue from a bin that holds none is 409.

```js
(ctx) => {
  const ok = (r, m) => ctx.assert(r.status >= 200 && r.status < 300, m + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const mk = (path, body, m) => { const r = ctx.api('POST', path, body); ok(r, m); return r.body; };
  const sup = mk('/suppliers', { name: 'Test Supplier C', email: 'c@supplier.example' }, 'supplier');
  const sku = mk('/skus', { code: 'T-3001', name: 'Bracket', unit_cost: 400, reorder_point: 5 }, 'sku');
  const bin = mk('/bins', { code: 'T-C-01', zone: 'pick', capacity: 500 }, 'bin');
  const other = mk('/bins', { code: 'T-C-02', zone: 'pick', capacity: 500 }, 'other bin');
  const po = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-3001', expected_at: '2026-10-20T00:00:00.000Z' }, 'po');
  const line = mk('/purchase_orders/' + po.id + '/add_line', { sku_id: sku.id, ordered_qty: 30 }, 'line');
  mk('/purchase_orders/' + po.id + '/submit', {}, 'submit');
  mk('/purchase_orders/' + po.id + '/receive', { line_id: line.id, bin_id: bin.id, quantity: 30 }, 'receive');
  const tooMany = ctx.api('POST', '/stock/issue', { sku_id: sku.id, bin_id: bin.id, quantity: 31, reference: 'order 1' });
  ctx.assert(tooMany.status === 409 && tooMany.body.error.code === 'insufficient_stock', 'issue 31 of 30: ' + JSON.stringify(tooMany));
  const lvl = ctx.api('GET', '/stock_levels?sku_id=' + sku.id + '&bin_id=' + bin.id).body.data[0];
  ctx.assert(lvl.quantity === 30, 'stock unchanged at 30, got ' + lvl.quantity);
  const all = mk('/stock/issue', { sku_id: sku.id, bin_id: bin.id, quantity: 30, reference: 'order 2' }, 'issue 30');
  ctx.assert(all.stock_level.quantity === 0, 'stock now 0, got ' + JSON.stringify(all.stock_level));
  ctx.assert(all.movement.kind === 'issue' && all.movement.quantity_delta === -30 && all.movement.balance_after === 0 && all.movement.reference === 'order 2', 'issue movement, got ' + JSON.stringify(all.movement));
  const more = ctx.api('POST', '/stock/issue', { sku_id: sku.id, bin_id: bin.id, quantity: 1, reference: 'order 3' });
  ctx.assert(more.status === 409 && more.body.error.code === 'insufficient_stock', 'issue from empty: ' + JSON.stringify(more));
  const none = ctx.api('POST', '/stock/issue', { sku_id: sku.id, bin_id: other.id, quantity: 1, reference: 'order 4' });
  ctx.assert(none.status === 409 && none.body.error.code === 'insufficient_stock', 'issue from a bin without stock: ' + JSON.stringify(none));
  const bad = ctx.api('POST', '/stock/issue', { sku_id: sku.id, bin_id: bin.id, quantity: -5, reference: 'order 5' });
  ctx.assert(bad.status === 400, 'negative quantity is invalid input, got ' + bad.status);
  ctx.assert(ctx.api('GET', '/stock_movements?sku_id=' + sku.id).body.data.length === 2, 'ledger holds only the receipt and the one successful issue');
}
```
### transfer_and_adjust_keep_ledger_consistent
- Intent: Transfers and cycle-count adjustments move stock correctly, refuse invalid requests, and the ledger deltas always sum to the on-hand total.
- Actions: add_po_line, submit_purchase_order, receive_purchase_order, transfer_stock, adjust_stock
- Description: Receive 50 into bin 1, transfer 20 to bin 2, refuse a 31-unit transfer (409) and a same-bin transfer (422 same_bin), adjust bin 2 to 5 (delta -15), refuse an adjust with no reason or no change. Sum of movement deltas equals the sum of stock levels (35).

```js
(ctx) => {
  const ok = (r, m) => ctx.assert(r.status >= 200 && r.status < 300, m + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const mk = (path, body, m) => { const r = ctx.api('POST', path, body); ok(r, m); return r.body; };
  const sup = mk('/suppliers', { name: 'Test Supplier D', email: 'd@supplier.example' }, 'supplier');
  const sku = mk('/skus', { code: 'T-4001', name: 'Hinge', unit_cost: 120, reorder_point: 8 }, 'sku');
  const b1 = mk('/bins', { code: 'T-D-01', zone: 'bulk', capacity: 1000 }, 'bin1');
  const b2 = mk('/bins', { code: 'T-D-02', zone: 'pick', capacity: 1000 }, 'bin2');
  const po = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-4001', expected_at: '2026-10-20T00:00:00.000Z' }, 'po');
  const line = mk('/purchase_orders/' + po.id + '/add_line', { sku_id: sku.id, ordered_qty: 50 }, 'line');
  mk('/purchase_orders/' + po.id + '/submit', {}, 'submit');
  mk('/purchase_orders/' + po.id + '/receive', { line_id: line.id, bin_id: b1.id, quantity: 50 }, 'receive');
  const t = mk('/stock/transfer', { sku_id: sku.id, from_bin_id: b1.id, to_bin_id: b2.id, quantity: 20 }, 'transfer 20');
  ctx.assert(t.from_stock_level.quantity === 30 && t.to_stock_level.quantity === 20, 'after transfer 30 and 20, got ' + JSON.stringify(t));
  const tooMuch = ctx.api('POST', '/stock/transfer', { sku_id: sku.id, from_bin_id: b1.id, to_bin_id: b2.id, quantity: 31 });
  ctx.assert(tooMuch.status === 409 && tooMuch.body.error.code === 'insufficient_stock', 'transfer 31 of 30: ' + JSON.stringify(tooMuch));
  const same = ctx.api('POST', '/stock/transfer', { sku_id: sku.id, from_bin_id: b1.id, to_bin_id: b1.id, quantity: 1 });
  ctx.assert(same.status === 422 && same.body.error.code === 'same_bin', 'same bin: ' + JSON.stringify(same));
  const a = mk('/stock/adjust', { sku_id: sku.id, bin_id: b2.id, new_quantity: 5, reason: 'cycle count' }, 'adjust');
  ctx.assert(a.stock_level.quantity === 5, 'adjusted to 5, got ' + JSON.stringify(a.stock_level));
  ctx.assert(a.movement.kind === 'adjustment' && a.movement.quantity_delta === -15 && a.movement.balance_after === 5, 'adjustment movement, got ' + JSON.stringify(a.movement));
  const noReason = ctx.api('POST', '/stock/adjust', { sku_id: sku.id, bin_id: b2.id, new_quantity: 6 });
  ctx.assert(noReason.status === 400 && noReason.body.error.code === 'input.invalid', 'adjust without reason: ' + JSON.stringify(noReason));
  const noChange = ctx.api('POST', '/stock/adjust', { sku_id: sku.id, bin_id: b2.id, new_quantity: 5, reason: 'recount' });
  ctx.assert(noChange.status === 409 && noChange.body.error.code === 'no_change', 'adjust to same quantity: ' + JSON.stringify(noChange));
  const moves = ctx.api('GET', '/stock_movements?sku_id=' + sku.id).body.data;
  const kinds = moves.map((m) => m.kind).sort().join(',');
  ctx.assert(kinds === 'adjustment,receipt,transfer_in,transfer_out', 'one movement per successful stock change, got ' + kinds);
  const levels = ctx.api('GET', '/stock_levels?sku_id=' + sku.id).body.data;
  const deltaSum = moves.reduce((s, m) => s + m.quantity_delta, 0);
  const levelSum = levels.reduce((s, l) => s + l.quantity, 0);
  ctx.assert(deltaSum === 35 && levelSum === 35, 'ledger deltas ' + deltaSum + ' equal stock total ' + levelSum + ' equal 35');
}
```
### po_lifecycle_refusals
- Intent: The PO workflow refuses submit without lines, edits after submit, receiving a draft or cancelled PO, and cancelling after a receipt.
- Actions: add_po_line, submit_purchase_order, receive_purchase_order, cancel_purchase_order
- Description: Submit with no lines is 409 no_lines. add_line after submit, receive on a draft or cancelled PO, a second cancel and a cancel after a partial receipt are all 409 invalid_state. A submitted PO with no receipts can be cancelled. Adding a SKU twice to a PO is refused.

```js
(ctx) => {
  const ok = (r, m) => ctx.assert(r.status >= 200 && r.status < 300, m + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const mk = (path, body, m) => { const r = ctx.api('POST', path, body); ok(r, m); return r.body; };
  const code = (r, s, c, m) => ctx.assert(r.status === s && r.body.error && r.body.error.code === c, m + ': ' + JSON.stringify(r));
  const sup = mk('/suppliers', { name: 'Test Supplier E', email: 'e@supplier.example' }, 'supplier');
  const sku = mk('/skus', { code: 'T-5001', name: 'Spring', unit_cost: 60, reorder_point: 5 }, 'sku');
  const bin = mk('/bins', { code: 'T-E-01', zone: 'bulk', capacity: 1000 }, 'bin');
  const empty = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-5001', expected_at: '2026-10-20T00:00:00.000Z' }, 'empty po');
  code(ctx.api('POST', '/purchase_orders/' + empty.id + '/submit', {}), 409, 'no_lines', 'submit without lines');
  const draft = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-5002', expected_at: '2026-10-20T00:00:00.000Z' }, 'draft po');
  const dl = mk('/purchase_orders/' + draft.id + '/add_line', { sku_id: sku.id, ordered_qty: 10 }, 'draft line');
  const dup = ctx.api('POST', '/purchase_orders/' + draft.id + '/add_line', { sku_id: sku.id, ordered_qty: 5 });
  ctx.assert(dup.status >= 400 && dup.status < 500, 'second line for the same SKU is refused, got ' + dup.status);
  code(ctx.api('POST', '/purchase_orders/' + draft.id + '/receive', { line_id: dl.id, bin_id: bin.id, quantity: 1 }), 409, 'invalid_state', 'receive on draft');
  mk('/purchase_orders/' + draft.id + '/submit', {}, 'submit');
  code(ctx.api('POST', '/purchase_orders/' + draft.id + '/add_line', { sku_id: sku.id, ordered_qty: 1 }), 409, 'invalid_state', 'add_line after submit');
  const cancelled = mk('/purchase_orders/' + draft.id + '/cancel', {}, 'cancel submitted');
  ctx.assert(cancelled.status === 'cancelled', 'status cancelled, got ' + cancelled.status);
  code(ctx.api('POST', '/purchase_orders/' + draft.id + '/receive', { line_id: dl.id, bin_id: bin.id, quantity: 1 }), 409, 'invalid_state', 'receive on cancelled');
  code(ctx.api('POST', '/purchase_orders/' + draft.id + '/cancel', {}), 409, 'invalid_state', 'cancel twice');
  const started = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-5003', expected_at: '2026-10-20T00:00:00.000Z' }, 'started po');
  const sl = mk('/purchase_orders/' + started.id + '/add_line', { sku_id: sku.id, ordered_qty: 100 }, 'started line');
  mk('/purchase_orders/' + started.id + '/submit', {}, 'submit started');
  mk('/purchase_orders/' + started.id + '/receive', { line_id: sl.id, bin_id: bin.id, quantity: 10 }, 'partial receive');
  code(ctx.api('POST', '/purchase_orders/' + started.id + '/cancel', {}), 409, 'invalid_state', 'cancel after partial receipt');
  ctx.assert(ctx.api('GET', '/purchase_orders/' + started.id).body.status === 'partially_received', 'PO stays partially_received');
}
```
### bin_capacity_and_quarantine
- Intent: Receiving respects bin capacity, quarantine zone and inactive bins, and a refused receipt changes nothing.
- Actions: add_po_line, submit_purchase_order, receive_purchase_order, transfer_stock
- Description: A bin of capacity 50 refuses a receipt of 60 (409 bin_capacity_exceeded) and accepts 50, then a further unit is refused. A quarantine bin and a deactivated bin give 409 bin_not_receivable. Transfer into a full bin is refused.

```js
(ctx) => {
  const ok = (r, m) => ctx.assert(r.status >= 200 && r.status < 300, m + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const mk = (path, body, m) => { const r = ctx.api('POST', path, body); ok(r, m); return r.body; };
  const code = (r, s, c, m) => ctx.assert(r.status === s && r.body.error && r.body.error.code === c, m + ': ' + JSON.stringify(r));
  const sup = mk('/suppliers', { name: 'Test Supplier F', email: 'f@supplier.example' }, 'supplier');
  const sku = mk('/skus', { code: 'T-6001', name: 'Bolt', unit_cost: 15, reorder_point: 5 }, 'sku');
  const small = mk('/bins', { code: 'T-F-01', zone: 'pick', capacity: 50 }, 'small bin');
  const big = mk('/bins', { code: 'T-F-02', zone: 'bulk', capacity: 1000 }, 'big bin');
  const quar = mk('/bins', { code: 'T-F-03', zone: 'quarantine', capacity: 1000 }, 'quarantine bin');
  const dead = mk('/bins', { code: 'T-F-04', zone: 'bulk', capacity: 1000 }, 'bin to deactivate');
  const upd = ctx.api('PATCH', '/bins/' + dead.id, { active: false });
  ok(upd, 'deactivate bin');
  const po = mk('/purchase_orders', { supplier_id: sup.id, number: 'PO-T-6001', expected_at: '2026-10-20T00:00:00.000Z' }, 'po');
  const line = mk('/purchase_orders/' + po.id + '/add_line', { sku_id: sku.id, ordered_qty: 200 }, 'line');
  mk('/purchase_orders/' + po.id + '/submit', {}, 'submit');
  const recv = (bin, q) => ctx.api('POST', '/purchase_orders/' + po.id + '/receive', { line_id: line.id, bin_id: bin.id, quantity: q });
  code(recv(small, 60), 409, 'bin_capacity_exceeded', 'receive 60 into capacity 50');
  ctx.assert(ctx.api('GET', '/stock_levels?bin_id=' + small.id).body.data.length === 0, 'refused receipt created no stock');
  ok(recv(small, 50), 'receive 50 into capacity 50');
  code(recv(small, 1), 409, 'bin_capacity_exceeded', 'receive into full bin');
  code(recv(quar, 10), 409, 'bin_not_receivable', 'receive into quarantine');
  code(recv(dead, 10), 409, 'bin_not_receivable', 'receive into inactive bin');
  ok(recv(big, 20), 'receive 20 into big bin');
  code(ctx.api('POST', '/stock/transfer', { sku_id: sku.id, from_bin_id: big.id, to_bin_id: small.id, quantity: 1 }), 409, 'bin_capacity_exceeded', 'transfer into full bin');
  code(ctx.api('POST', '/stock/transfer', { sku_id: sku.id, from_bin_id: big.id, to_bin_id: quar.id, quantity: 1 }), 409, 'bin_not_receivable', 'transfer into quarantine');
  const line2 = ctx.api('GET', '/purchase_orders/' + po.id + '/lines').body.data[0];
  ctx.assert(line2.received_qty === 70, 'only the two successful receipts count, got ' + line2.received_qty);
}
```
### overdue_job_flags_open_pos
- Intent: The overdue job flags submitted and partially received POs past expected_at, but not drafts or fully received POs.
- Actions: add_po_line, submit_purchase_order, receive_purchase_order
- Description: Four POs expect delivery on 2026-10-07: one submitted, one partially received, one received, one draft. After advancing one day the first two are overdue and the others are not. Before the advance none are.

```js
(ctx) => {
  const ok = (r, m) => ctx.assert(r.status >= 200 && r.status < 300, m + ': ' + r.status + ' ' + JSON.stringify(r.body));
  const mk = (path, body, m) => { const r = ctx.api('POST', path, body); ok(r, m); return r.body; };
  const sup = mk('/suppliers', { name: 'Test Supplier G', email: 'g@supplier.example' }, 'supplier');
  const sku = mk('/skus', { code: 'T-7001', name: 'Washer', unit_cost: 5, reorder_point: 5 }, 'sku');
  const bin = mk('/bins', { code: 'T-G-01', zone: 'bulk', capacity: 5000 }, 'bin');
  const mkpo = (n, submit, recvQty) => {
    const po = mk('/purchase_orders', { supplier_id: sup.id, number: n, expected_at: '2026-10-07T00:00:00.000Z' }, 'po ' + n);
    const line = mk('/purchase_orders/' + po.id + '/add_line', { sku_id: sku.id, ordered_qty: 100 }, 'line ' + n);
    if (submit) mk('/purchase_orders/' + po.id + '/submit', {}, 'submit ' + n);
    if (recvQty > 0) mk('/purchase_orders/' + po.id + '/receive', { line_id: line.id, bin_id: bin.id, quantity: recvQty }, 'receive ' + n);
    return po.id;
  };
  const submitted = mkpo('PO-T-7001', true, 0);
  const partial = mkpo('PO-T-7002', true, 40);
  const received = mkpo('PO-T-7003', true, 100);
  const draft = mkpo('PO-T-7004', false, 0);
  const flag = (id) => ctx.api('GET', '/purchase_orders/' + id).body.overdue;
  ctx.assert([submitted, partial, received, draft].every((id) => flag(id) === false), 'nothing is overdue before expected_at');
  const res = ctx.advance('1d');
  ctx.assert(res.jobsFailed.length === 0, 'no job failed, got ' + JSON.stringify(res.jobsFailed));
  ctx.assert(flag(submitted) === true, 'submitted PO past expected_at is overdue');
  ctx.assert(flag(partial) === true, 'partially received PO past expected_at is overdue');
  ctx.assert(flag(received) === false, 'received PO is not overdue');
  ctx.assert(flag(draft) === false, 'draft PO is not overdue');
  const overdue = ctx.api('GET', '/purchase_orders?overdue=true').body.data.map((p) => p.id);
  ctx.assert(overdue.includes(submitted) && overdue.includes(partial) && !overdue.includes(received) && !overdue.includes(draft), 'overdue filter lists the right POs');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_suppliers` | GET | /suppliers | List suppliers. Filter by active, search by name. |
| `get_supplier` | GET | /suppliers/{id} | Get one supplier. |
| `create_supplier` | POST | /suppliers | Create a supplier. |
| `update_supplier` | PATCH | /suppliers/{id} | Update a supplier. |
| `list_skus` | GET | /skus | List SKUs. Filter by active, search by code and name (q). |
| `get_sku` | GET | /skus/{id} | Get one SKU. |
| `create_sku` | POST | /skus | Create a SKU (code, name, unit_cost, reorder_point). |
| `update_sku` | PATCH | /skus/{id} | Update a SKU. |
| `list_bins` | GET | /bins | List bins. Filter by zone and active, search by code. |
| `get_bin` | GET | /bins/{id} | Get one bin. |
| `create_bin` | POST | /bins | Create a bin (code, zone, capacity). |
| `update_bin` | PATCH | /bins/{id} | Update a bin, such as deactivating it. |
| `list_stock_levels` | GET | /stock_levels | List stock levels. Filter by sku_id and bin_id. |
| `get_stock_level` | GET | /stock_levels/{id} | Get one stock level. |
| `list_stock_movements` | GET | /stock_movements | List ledger rows. Filter by sku_id, bin_id, kind, purchase_order_id. Sort by created_at. |
| `get_stock_movement` | GET | /stock_movements/{id} | Get one ledger row. |
| `list_purchase_orders` | GET | /purchase_orders | List purchase orders. Filter by status, supplier_id and overdue. Search by number. Sort by created_at and expected_at. |
| `get_purchase_order` | GET | /purchase_orders/{id} | Get one purchase order. |
| `create_purchase_order` | POST | /purchase_orders | Create a draft purchase order (supplier_id, number, expected_at, note). |
| `update_purchase_order` | PATCH | /purchase_orders/{id} | Update expected_at and note. Status is readonly. |
| `list_purchase_order_lines` | GET | /purchase_orders/{purchase_order_id}/lines | List the lines of one purchase order. |
| `add_po_line` | POST | /purchase_orders/{id}/add_line | Action: add a line (sku_id, ordered_qty, optional unit_cost) to a draft PO. Returns 201 with the line. |
| `submit_purchase_order` | POST | /purchase_orders/{id}/submit | Action: draft -> submitted. Needs at least one line. |
| `receive_purchase_order` | POST | /purchase_orders/{id}/receive | Action: receive one shipment of one line into one bin (line_id, bin_id, quantity, optional note). Returns {purchase_order, line, stock_level, movement}. |
| `cancel_purchase_order` | POST | /purchase_orders/{id}/cancel | Action: cancel a draft or submitted PO that has no receipts. |
| `issue_stock` | POST | /stock/issue | Action: remove quantity of a SKU from a bin (sku_id, bin_id, quantity, reference). Returns {stock_level, movement}. |
| `adjust_stock` | POST | /stock/adjust | Action: cycle count, set a SKU's quantity in a bin (sku_id, bin_id, new_quantity, reason). Returns {stock_level, movement}. |
| `transfer_stock` | POST | /stock/transfer | Action: move quantity between two bins (sku_id, from_bin_id, to_bin_id, quantity). Returns {from_stock_level, to_stock_level}. |

## Seed

- Rows per entity: supplier: 12, sku: 80, bin: 36, stock_level: 190, stock_movement: 330, purchase_order: 45, purchase_order_line: 110
- Mix: Bins: 4 receiving, 16 pick, 12 bulk, 4 quarantine, 2 inactive. Purchase orders: about 6 draft, 14 submitted (4 of them past expected_at and flagged overdue), 10 partially_received, 12 received, 3 cancelled. Lines are consistent with receipts: received_qty equals the sum of receipt movements for the line, and fully received POs have received_qty equal to ordered_qty. Every stock_level quantity equals the sum of the movement deltas for that (sku, bin), with the last balance_after matching it. No bin is over capacity. Some pick-bin levels are below the SKU reorder_point and have enough stock in a bulk bin. Anchor rows have fixed codes for tasks and read by the grader: SKU BLT-M8-40 in bin A-03-02, supplier Harbor Fasteners with a partially received PO, supplier Northgate Industrial with several submitted POs, one of them partially received. All history is dated before 2026-10-06T09:00Z. Open POs have expected_at both before and after the clock start.

## Tasks

- `cycle_count_adjustment` (easy): A cycle count found 12 units of the SKU with code BLT-M8-40 in bin A-03-02 (the system shows a different number). Correct the stock to 12 with the reason 'cycle count'. Passes when that one stock_level is 12, one adjustment movement with the right delta exists, and nothing else changed.
  - Decoy idea: Uses issue_stock to remove the difference (wrong movement kind, and fails if the count is higher), or adjusts the same SKU in a different bin.
- `receive_rest_of_harbor_po` (medium): The supplier Harbor Fasteners delivered the rest of their partially received purchase order. Receive every outstanding unit on all its lines into bin R-01, then the PO must be received. The agent must find the PO by supplier and status and compute each remaining quantity (ordered minus received). Nothing else changes.
  - Decoy idea: Receives only the first line, or sends the full ordered_qty and hits 409 over_receipt, or picks Harbor's other fully received PO, or receives into a different bin.
- `cancel_unstarted_northgate_pos` (medium): Cancel every submitted purchase order of the supplier Northgate Industrial that has no goods received yet. Leave its partially received PO, draft POs and other suppliers' POs untouched. Requires paging and checking received_qty or status.
  - Decoy idea: Cancels the draft POs too, reads only page 1, or tries the partially received one (refused with 409) and gives up. Another decoy cancels submitted POs of a similarly named supplier.
- `restock_pick_bins` (hard): For every active SKU with a stock level in a pick-zone bin below its reorder_point, transfer from a bulk bin that holds that SKU exactly the shortfall (reorder_point minus the pick quantity) into that pick bin. Give no SKU more or less than the shortfall and touch no other stock. The seed has more than 25 stock levels so paging matters, and a few SKUs have pick bins exactly at the reorder point or inactive SKUs that must be skipped.
  - Decoy idea: Reads only page 1 of stock levels, moves the whole bulk quantity, tops up to the reorder point twice, includes inactive SKUs or pick bins already at the reorder_point, or transfers from a quarantine bin (refused).

## Open questions

- Should the system model several warehouses or only one?
  - Default answer: One warehouse. Bins are the only location level.
- Can a single receive call carry several PO lines or bins?
  - Default answer: No. One call receives one line into one bin. Partial shipments are separate calls.
- Is over-receipt (more than ordered) ever allowed?
  - Default answer: No. It is refused with 409 over_receipt.
- Should stock reserved for sales orders be modelled?
  - Default answer: No. Outbound is a plain issue_stock action against on-hand stock.
- What does a bin's capacity measure?
  - Default answer: Total units of all SKUs in the bin, enforced on receive and transfer-in.
- Can a PO be cancelled after goods have arrived?
  - Default answer: No. Only draft or submitted POs with no receipts can be cancelled.
- Do lots, serial numbers or expiry dates matter?
  - Default answer: No, out of scope.

## Assumptions

- Clock starts 2026-10-06T09:00:00.000Z with tick 0s. Time moves only on explicit advance (the overdue job test advances it).
  - Why: Start is after all seeded history (movements, receipts, POs). Open POs have expected_at both before and after it, so some are already overdue and some are future scheduled events. A zero tick keeps timestamps exact for assertions.
- Single warehouse, one unit of measure (each), no lots or serials.
  - Why: Keeps the model focused on the stock-never-negative invariant and partial receiving.
- A receive call receives one PO line into one bin. A PO is received in several partial shipments by calling receive repeatedly, possibly into different bins.
  - Why: Action inputs are scalar, so a multi-line receipt cannot be sent in one call. One call per line and bin matches the partial-shipment requirement.
- stock_level.quantity has min 0 at the data-model level and every action also refuses with 409 insufficient_stock before writing.
  - Why: The invariant is enforced twice, so no write path can drive stock negative. Stock fields are readonly, so only actions change them.
- Bin capacity is the total units of all SKUs in the bin. Receive and transfer-in refuse with 409 bin_capacity_exceeded if the total would exceed it.
  - Why: A simple, checkable rule that makes bin choice matter.
- Quarantine-zone and inactive bins are not receivable and not valid transfer destinations (409 bin_not_receivable). Issue, adjust and transfer-out work on any bin that holds stock.
  - Why: Mirrors real WMS quarantine behaviour, and stock in a deactivated bin can still be moved out.
- Receiving more than ordered_qty - received_qty on a line is refused with 409 over_receipt. A line from another PO is refused with 409 line_mismatch. Receive on a PO not in submitted or partially_received is refused with 409 invalid_state.
  - Why: No over-receipt tolerance, which keeps the data consistent.
- The PO becomes partially_received after the first receipt and received once every line has received_qty equal to ordered_qty. received_at is set then. Cancel is allowed only for draft or submitted POs with no receipts, otherwise 409 invalid_state. Submit with no lines is 409 no_lines. add_line on a non-draft PO is 409 invalid_state.
  - Why: Defines the workflow and error codes so tests and tasks are unambiguous.
- PO status, received_qty, quantity, balance_after, overdue and submitted_at/received_at are readonly. The PO line create route is not exposed. Lines are added only with add_po_line.
  - Why: Prevents bypassing workflow rules with a plain PATCH or POST.
- Action response shapes: add_po_line returns 201 with the line. submit and cancel return 200 with the purchase order. receive returns {purchase_order, line, stock_level, movement}. issue and adjust return {stock_level, movement}. transfer returns {from_stock_level, to_stock_level}. Errors use the default {error:{code,message}} template. Validation failures of declared inputs return 400 input.invalid.
  - Why: Fixes the contract that the acceptance tests check.
- Money is USD in minor units. List endpoints use the default envelope (data, next_cursor, limit, cursor) and a q parameter for search.
  - Why: Follows the engine defaults.
- The overdue job runs every 6h. It sets overdue=true on submitted and partially_received POs whose expected_at is at or before now. Draft, received and cancelled POs are never flagged.
  - Why: Gives the world a time-driven behaviour that is testable with advance.

## Out of scope

- Multiple warehouses and inter-warehouse transfers
  - Why: A single warehouse is enough for the stock and PO-receiving behaviours.
- Lot, serial and expiry tracking, FIFO/FEFO and cost layers
  - Why: Not needed for the quantity invariants and adds large model surface.
- Sales orders, pick lists, reservations and allocated stock
  - Why: Outbound is reduced to a plain issue_stock action.
- Returns to supplier, PO price or quantity amendments after submit, over-receipt tolerance
  - Why: Excluded to keep the PO state machine small.
- Authentication, users and permissions
  - Why: The API is tested as a single trusted client.
- Barcode scanning, units of measure conversion, multi-currency
  - Why: Not relevant to the tested behaviour.
- Multi-line receipts in a single call
  - Why: Action inputs are scalar. Receiving is one line and one bin per call.

## Changes

- workflows.stock_ledger because give workflow stock_ledger a lifecycle
