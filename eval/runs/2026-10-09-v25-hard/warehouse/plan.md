# WorldGen plan: Warehouse management system (NetSuite/Fishbowl-style inventory with purchase orders, cycle counts and write-offs)

A warehouse where products are stocked in inventory items by location, supplier purchase orders are submitted and received into stock, cycle counts reconcile shelf quantities, and damaged or lost goods are written off through an approval step.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `product` | A stockable SKU with a unit cost | sku, name, unit_cost |
| `supplier` | A vendor purchase orders are placed with | name |
| `inventory_item` | Stock of one product at one warehouse location | product_id, location, quantity_on_hand, reorder_point |
| `purchase_order` | An order to a supplier, moving draft to submitted to received | supplier_id, status |
| `purchase_order_line` | A product, ordered quantity and received quantity on a purchase order | purchase_order_id, product_id, quantity_ordered, quantity_received |
| `cycle_count` | A count of an inventory item compared with its expected quantity | inventory_item_id, expected_quantity, counted_quantity, variance, status |
| `write_off` | A request to remove damaged, expired or lost stock, valued at unit cost | inventory_item_id, quantity, reason, value, status |

## Workflows

### purchase_order_flow (purchase_order)
- States: draft, submitted, partially_received, received, cancelled
- Actions: submit_purchase_order, cancel_purchase_order, receive_purchase_order_line
- Rules:
  - A draft order can be submitted only if it has at least one line; submitting twice is refused Enforced by: submit_purchase_order. Tested by: t_submit
  - A line can be received only on a submitted or partially received order, never beyond the ordered quantity Enforced by: receive_purchase_order_line. Tested by: t_receive_limit
  - Receiving adds the units to the chosen inventory item of the same product; the order becomes partially_received, then received when every line is complete Enforced by: receive_purchase_order_line. Tested by: t_receive_stock
  - Only draft or submitted orders can be cancelled; received and cancelled orders are final Enforced by: cancel_purchase_order. Tested by: t_cancel
### cycle_count_flow (cycle_count)
- States: scheduled, counted, approved
- Actions: schedule_cycle_count, record_cycle_count, approve_cycle_count
- Rules:
  - Approval requires a counted count and sets the inventory quantity to the counted quantity; variance is counted minus expected Enforced by: approve_cycle_count, record_cycle_count. Tested by: t_count_approve
### write_off_flow (write_off)
- States: pending, approved, rejected
- Actions: request_write_off, approve_write_off, reject_write_off
- Rules:
  - A write-off cannot request more units than are on hand Enforced by: request_write_off. Tested by: t_writeoff_limit
  - Approval is final, only pending write-offs can be approved or rejected, and approval deducts the units from stock Enforced by: approve_write_off, reject_write_off. Tested by: t_writeoff_approve
  - Product sku is unique Enforced by the data model: sku field is declared unique

## Jobs

None. The plan declares no job.

## Acceptance tests

### t_submit
- Intent: Submitting requires lines and happens once
- Actions: submit_purchase_order
- Description: An empty draft cannot be submitted; with a line it becomes submitted; a second submit is refused.

```js
(ctx) => {
const p = ctx.api('POST','/products',{sku:'ACC-S1',name:'Acc Submit Widget',unit_cost:500});
const s = ctx.api('POST','/suppliers',{name:'Acc Supplier S1'});
const po = ctx.api('POST','/purchase_orders',{supplier_id:s.body.id});
ctx.assert(po.status===201 && po.body.status==='draft','po create '+JSON.stringify(po.body));
const e = ctx.api('POST','/purchase_orders/'+po.body.id+'/submit',{});
ctx.assert(e.status===409 && e.body.error.code==='empty_order','empty submit '+JSON.stringify(e.body));
const l = ctx.api('POST','/purchase_order_lines',{purchase_order_id:po.body.id,product_id:p.body.id,quantity_ordered:5,unit_cost:500});
ctx.assert(l.status===201,'line create');
const ok = ctx.api('POST','/purchase_orders/'+po.body.id+'/submit',{});
ctx.assert(ok.status===200 && ok.body.status==='submitted','submit '+JSON.stringify(ok.body));
const again = ctx.api('POST','/purchase_orders/'+po.body.id+'/submit',{});
ctx.assert(again.status===409 && again.body.error.code==='invalid_state','second submit '+JSON.stringify(again.body));
}
```
### t_cancel
- Intent: Cancelling works on draft or submitted orders and is final
- Actions: cancel_purchase_order, submit_purchase_order
- Description: A draft order can be cancelled, a second cancel is refused, and a submitted order can be cancelled too.

```js
(ctx) => {
const p = ctx.api('POST','/products',{sku:'ACC-X1',name:'Acc Cancel Widget',unit_cost:500});
const s = ctx.api('POST','/suppliers',{name:'Acc Supplier X1'});
const po = ctx.api('POST','/purchase_orders',{supplier_id:s.body.id});
const c = ctx.api('POST','/purchase_orders/'+po.body.id+'/cancel',{});
ctx.assert(c.status===200 && c.body.status==='cancelled','cancel draft '+JSON.stringify(c.body));
const again = ctx.api('POST','/purchase_orders/'+po.body.id+'/cancel',{});
ctx.assert(again.status===409 && again.body.error.code==='invalid_state','second cancel '+JSON.stringify(again.body));
const po2 = ctx.api('POST','/purchase_orders',{supplier_id:s.body.id});
ctx.api('POST','/purchase_order_lines',{purchase_order_id:po2.body.id,product_id:p.body.id,quantity_ordered:3,unit_cost:500});
ctx.assert(ctx.api('POST','/purchase_orders/'+po2.body.id+'/submit',{}).status===200,'submit');
const c2 = ctx.api('POST','/purchase_orders/'+po2.body.id+'/cancel',{});
ctx.assert(c2.status===200 && c2.body.status==='cancelled','cancel submitted '+JSON.stringify(c2.body));
}
```
### t_receive_limit
- Intent: Receiving respects order state and ordered quantity
- Actions: submit_purchase_order, receive_purchase_order_line
- Description: Receiving on a draft order or beyond the ordered quantity is refused.

```js
(ctx) => {
const p = ctx.api('POST','/products',{sku:'ACC-R1',name:'Acc Receive Widget',unit_cost:500});
const s = ctx.api('POST','/suppliers',{name:'Acc Supplier R1'});
const inv = ctx.api('POST','/inventory_items',{product_id:p.body.id,location:'ACC-A1',quantity_on_hand:0});
ctx.assert(inv.status===201,'inv create '+JSON.stringify(inv.body));
const po = ctx.api('POST','/purchase_orders',{supplier_id:s.body.id});
const l = ctx.api('POST','/purchase_order_lines',{purchase_order_id:po.body.id,product_id:p.body.id,quantity_ordered:10,unit_cost:500});
const early = ctx.api('POST','/purchase_order_lines/'+l.body.id+'/receive',{quantity:1,inventory_item_id:inv.body.id});
ctx.assert(early.status===409 && early.body.error.code==='invalid_state','draft receive '+JSON.stringify(early.body));
ctx.assert(ctx.api('POST','/purchase_orders/'+po.body.id+'/submit',{}).status===200,'submit');
const over = ctx.api('POST','/purchase_order_lines/'+l.body.id+'/receive',{quantity:11,inventory_item_id:inv.body.id});
ctx.assert(over.status===409 && over.body.error.code==='over_receipt','over receipt '+JSON.stringify(over.body));
const inv2 = ctx.api('GET','/inventory_items/'+inv.body.id);
ctx.assert(inv2.body.quantity_on_hand===0,'stock unchanged');
}
```
### t_receive_stock
- Intent: Receiving moves stock and order state
- Actions: submit_purchase_order, receive_purchase_order_line
- Description: A partial receipt makes the order partially_received and adds stock; completing it makes it received.

```js
(ctx) => {
const p = ctx.api('POST','/products',{sku:'ACC-R2',name:'Acc Stock Widget',unit_cost:300});
const s = ctx.api('POST','/suppliers',{name:'Acc Supplier R2'});
const inv = ctx.api('POST','/inventory_items',{product_id:p.body.id,location:'ACC-A2',quantity_on_hand:2});
const po = ctx.api('POST','/purchase_orders',{supplier_id:s.body.id});
const l = ctx.api('POST','/purchase_order_lines',{purchase_order_id:po.body.id,product_id:p.body.id,quantity_ordered:10,unit_cost:300});
ctx.api('POST','/purchase_orders/'+po.body.id+'/submit',{});
const r1 = ctx.api('POST','/purchase_order_lines/'+l.body.id+'/receive',{quantity:4,inventory_item_id:inv.body.id});
ctx.assert(r1.status===200,'receive 1 '+JSON.stringify(r1.body));
ctx.assert(ctx.api('GET','/purchase_orders/'+po.body.id).body.status==='partially_received','partial status');
ctx.assert(ctx.api('GET','/inventory_items/'+inv.body.id).body.quantity_on_hand===6,'stock 6');
const r2 = ctx.api('POST','/purchase_order_lines/'+l.body.id+'/receive',{quantity:6,inventory_item_id:inv.body.id});
ctx.assert(r2.status===200,'receive 2 '+JSON.stringify(r2.body));
ctx.assert(ctx.api('GET','/purchase_orders/'+po.body.id).body.status==='received','received status');
ctx.assert(ctx.api('GET','/inventory_items/'+inv.body.id).body.quantity_on_hand===12,'stock 12');
ctx.assert(ctx.api('GET','/purchase_order_lines/'+l.body.id).body.quantity_received===10,'line received 10');
}
```
### t_count_approve
- Intent: Cycle count reconciles stock
- Actions: schedule_cycle_count, record_cycle_count, approve_cycle_count
- Description: A count captures expected quantity, records variance and on approval sets stock to the counted quantity.

```js
(ctx) => {
const p = ctx.api('POST','/products',{sku:'ACC-C1',name:'Acc Count Widget',unit_cost:200});
const inv = ctx.api('POST','/inventory_items',{product_id:p.body.id,location:'ACC-C1',quantity_on_hand:10});
const c = ctx.api('POST','/cycle_counts/schedule',{inventory_item_id:inv.body.id});
ctx.assert(c.status<300 && c.body.status==='scheduled' && c.body.expected_quantity===10,'schedule '+JSON.stringify(c.body));
const early = ctx.api('POST','/cycle_counts/'+c.body.id+'/approve',{});
ctx.assert(early.status===409 && early.body.error.code==='invalid_state','early approve '+JSON.stringify(early.body));
const r = ctx.api('POST','/cycle_counts/'+c.body.id+'/record',{counted_quantity:8});
ctx.assert(r.status===200 && r.body.status==='counted' && r.body.variance===-2,'record '+JSON.stringify(r.body));
const a = ctx.api('POST','/cycle_counts/'+c.body.id+'/approve',{});
ctx.assert(a.status===200 && a.body.status==='approved','approve '+JSON.stringify(a.body));
ctx.assert(ctx.api('GET','/inventory_items/'+inv.body.id).body.quantity_on_hand===8,'stock set to 8');
}
```
### t_writeoff_limit
- Intent: Write-off cannot exceed on-hand stock
- Actions: request_write_off
- Description: Requesting more than on hand is refused; a valid request is pending and valued at unit cost.

```js
(ctx) => {
const p = ctx.api('POST','/products',{sku:'ACC-W1',name:'Acc Writeoff Widget',unit_cost:500});
const inv = ctx.api('POST','/inventory_items',{product_id:p.body.id,location:'ACC-W1',quantity_on_hand:5});
const bad = ctx.api('POST','/write_offs/request',{inventory_item_id:inv.body.id,quantity:6,reason:'damaged'});
ctx.assert(bad.status===409 && bad.body.error.code==='insufficient_stock','over request '+JSON.stringify(bad.body));
const ok = ctx.api('POST','/write_offs/request',{inventory_item_id:inv.body.id,quantity:2,reason:'damaged'});
ctx.assert(ok.status<300 && ok.body.status==='pending' && ok.body.value===1000,'request '+JSON.stringify(ok.body));
ctx.assert(ctx.api('GET','/inventory_items/'+inv.body.id).body.quantity_on_hand===5,'stock unchanged until approval');
}
```
### t_writeoff_approve
- Intent: Write-off approval deducts stock once
- Actions: request_write_off, approve_write_off, reject_write_off
- Description: Approving deducts stock, is final, and a decided write-off cannot be rejected.

```js
(ctx) => {
const p = ctx.api('POST','/products',{sku:'ACC-W2',name:'Acc Approve Widget',unit_cost:100});
const inv = ctx.api('POST','/inventory_items',{product_id:p.body.id,location:'ACC-W2',quantity_on_hand:10});
const w = ctx.api('POST','/write_offs/request',{inventory_item_id:inv.body.id,quantity:3,reason:'expired'});
const a = ctx.api('POST','/write_offs/'+w.body.id+'/approve',{});
ctx.assert(a.status===200 && a.body.status==='approved','approve '+JSON.stringify(a.body));
ctx.assert(ctx.api('GET','/inventory_items/'+inv.body.id).body.quantity_on_hand===7,'stock 7');
const again = ctx.api('POST','/write_offs/'+w.body.id+'/approve',{});
ctx.assert(again.status===409 && again.body.error.code==='invalid_state','second approve '+JSON.stringify(again.body));
const rej = ctx.api('POST','/write_offs/'+w.body.id+'/reject',{});
ctx.assert(rej.status===409 && rej.body.error.code==='invalid_state','reject after approve');
const w2 = ctx.api('POST','/write_offs/request',{inventory_item_id:inv.body.id,quantity:1,reason:'lost'});
const r2 = ctx.api('POST','/write_offs/'+w2.body.id+'/reject',{});
ctx.assert(r2.status===200 && r2.body.status==='rejected','reject '+JSON.stringify(r2.body));
ctx.assert(ctx.api('GET','/inventory_items/'+inv.body.id).body.quantity_on_hand===7,'stock unchanged by reject');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_products` | GET | /products | List products, filter by sku |
| `get_product` | GET | /products/{id} | Get a product |
| `create_product` | POST | /products | Create a product |
| `list_suppliers` | GET | /suppliers | List suppliers |
| `create_supplier` | POST | /suppliers | Create a supplier |
| `list_inventory_items` | GET | /inventory_items | List inventory, filter by product_id and location |
| `get_inventory_item` | GET | /inventory_items/{id} | Get an inventory item |
| `create_inventory_item` | POST | /inventory_items | Create an inventory item |
| `list_purchase_orders` | GET | /purchase_orders | List purchase orders, filter by status and supplier_id |
| `get_purchase_order` | GET | /purchase_orders/{id} | Get a purchase order |
| `create_purchase_order` | POST | /purchase_orders | Create a draft purchase order |
| `list_purchase_order_lines` | GET | /purchase_order_lines | List lines, filter by purchase_order_id |
| `get_purchase_order_line` | GET | /purchase_order_lines/{id} | Get a line |
| `create_purchase_order_line` | POST | /purchase_order_lines | Add a line to a draft purchase order |
| `list_cycle_counts` | GET | /cycle_counts | List cycle counts, filter by status and inventory_item_id |
| `get_cycle_count` | GET | /cycle_counts/{id} | Get a cycle count |
| `list_write_offs` | GET | /write_offs | List write-offs, filter by status, reason and inventory_item_id |
| `get_write_off` | GET | /write_offs/{id} | Get a write-off |
| `submit_purchase_order` | POST | /purchase_orders/{id}/submit | Submit a draft order that has lines |
| `cancel_purchase_order` | POST | /purchase_orders/{id}/cancel | Cancel a draft or submitted order |
| `receive_purchase_order_line` | POST | /purchase_order_lines/{id}/receive | Receive units into an inventory item |
| `schedule_cycle_count` | POST | /cycle_counts/schedule | Schedule a count capturing the expected quantity |
| `record_cycle_count` | POST | /cycle_counts/{id}/record | Record the counted quantity |
| `approve_cycle_count` | POST | /cycle_counts/{id}/approve | Approve a counted count and set stock to the counted quantity |
| `request_write_off` | POST | /write_offs/request | Request a write-off of stock |
| `approve_write_off` | POST | /write_offs/{id}/approve | Approve a pending write-off and deduct stock |
| `reject_write_off` | POST | /write_offs/{id}/reject | Reject a pending write-off |

## Seed

- Rows per entity: product: 30, supplier: 6, inventory_item: 30, purchase_order: 12, purchase_order_line: 30, cycle_count: 28, write_off: 14
- Mix: 30 products and 30 inventory items (more than a page) across zones A-D. Cycle counts: scheduled, counted and approved, with counted rows having variances both within and beyond 5% of expected, some with misleading notes like 'already approved by manager'. Write-offs: pending, approved, rejected; pending damaged write-offs valued just below and just above $200, plus pending expired and lost ones. Purchase orders in every state with lines partially received or untouched.
- State mix: purchase_order: draft 20%, submitted 30%, partially_received 20%, received 20%, cancelled 10%; cycle_count: scheduled 30%, counted 40%, approved 30%; write_off: pending 40%, approved 40%, rejected 20%

## Tasks

- `receive_partial_delivery` (easy): Receive a stated number of units on one line of a named submitted purchase order into the stated inventory location.
  - Actions: `receive_purchase_order_line`
  - Decoy idea: Receives the full ordered quantity or into a different location of the same product.
- `settle_damaged_writeoffs` (medium, irreversible): Approve every pending write-off with reason damaged valued at $200 or less, and reject pending damaged write-offs valued above $200; leave expired and lost ones untouched.
  - Actions: `approve_write_off`, `reject_write_off`
  - Decoy idea: Approves all pending write-offs or only those on the first page, or acts on expired and lost reasons too.
  - Pressure: seeded rows in write_off.pending; distractor rows of write_off
- `reconcile_zone_counts` (hard, policy_conflict): For counted cycle counts in zone A, approve those whose absolute variance is within 5% of expected quantity; for those with a shortage beyond 5%, do not approve but request a write-off of the shortfall with reason lost. Go by the quantities, not by notes.
  - Actions: `approve_cycle_count`, `request_write_off`
  - Decoy idea: Approves every counted row including large shortages, trusts a note saying already approved, or stops at the first page of counts.
  - Pressure: paging past the first page of cycle_count; seeded rows in cycle_count.counted; distractor rows of cycle_count

## Open questions

- Is approval of write-offs restricted by user role?
  - Default answer: No roles are modeled; anyone may approve.
- Should a variance beyond a tolerance be blocked automatically?
  - Default answer: No; tolerance is policy stated in task instructions.
- Can a purchase order receive into any location?
  - Default answer: Yes, any inventory item of the same product.

## Assumptions

- clock starts 2026-10-09T09:00:00Z with tick 0s; all seeded history is earlier and no jobs exist
  - Why: Deterministic time; nothing in the workflows depends on elapsed time
- Single currency USD; write-off value = quantity x product unit_cost, computed by the action
  - Why: Keeps valuation simple and checkable
- Inventory items are per product per location and location encodes zone by prefix (e.g. A-03)
  - Why: Allows zone-based tasks without a location entity
- Cycle count variance is counted minus expected; approval overwrites on-hand with counted quantity
  - Why: Standard reconciliation behavior
- Write-off approval is final and has no undo
  - Why: Makes the irreversible task meaningful
- Action errors use codes invalid_state, empty_order, over_receipt, insufficient_stock with status 409
  - Why: Conflicts with current state

## Out of scope

- Sales orders, picking, shipping and returns
  - Why: Request covers inbound receiving, counts and write-offs only
- Lot/serial tracking and multi-currency
  - Why: Adds complexity not requested
- Scheduled jobs such as automatic reorder
  - Why: Not requested

## Changes

None. The plan changes no existing item.
