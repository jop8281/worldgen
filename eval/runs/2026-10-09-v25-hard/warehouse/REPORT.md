# WorldGen report: Warehouse management system (NetSuite/Fishbowl-style inventory with purchase orders, cycle counts and write-offs)

A warehouse where products are stocked in inventory items by location, supplier purchase orders are submitted and received into stock, cycle counts reconcile shelf quantities, and damaged or lost goods are written off through an approval step.

## What was built

Entities (7):

- `product`: 30 seeded rows
- `supplier`: 6 seeded rows
- `inventory_item`: 30 seeded rows
- `purchase_order`: 12 seeded rows
- `purchase_order_line`: 30 seeded rows
- `cycle_count`: 28 seeded rows
- `write_off`: 14 seeded rows

Routes (18):

- `list_products`: GET /products
- `get_product`: GET /products/{id}
- `create_product`: POST /products
- `list_suppliers`: GET /suppliers
- `create_supplier`: POST /suppliers
- `list_inventory_items`: GET /inventory_items
- `get_inventory_item`: GET /inventory_items/{id}
- `create_inventory_item`: POST /inventory_items
- `list_purchase_orders`: GET /purchase_orders
- `get_purchase_order`: GET /purchase_orders/{id}
- `create_purchase_order`: POST /purchase_orders
- `list_purchase_order_lines`: GET /purchase_order_lines
- `get_purchase_order_line`: GET /purchase_order_lines/{id}
- `create_purchase_order_line`: POST /purchase_order_lines
- `list_cycle_counts`: GET /cycle_counts
- `get_cycle_count`: GET /cycle_counts/{id}
- `list_write_offs`: GET /write_offs
- `get_write_off`: GET /write_offs/{id}

Actions (9):

- `submit_purchase_order`: POST /purchase_orders/{id}/submit
- `cancel_purchase_order`: POST /purchase_orders/{id}/cancel
- `receive_purchase_order_line`: POST /purchase_order_lines/{id}/receive
- `schedule_cycle_count`: POST /cycle_counts/schedule
- `record_cycle_count`: POST /cycle_counts/{id}/record
- `approve_cycle_count`: POST /cycle_counts/{id}/approve
- `request_write_off`: POST /write_offs/request
- `approve_write_off`: POST /write_offs/{id}/approve
- `reject_write_off`: POST /write_offs/{id}/reject

Jobs: none.

## Assumed and why

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

## Questions asked of the input

- Is approval of write-offs restricted by user role?
  - Default answer: No roles are modeled; anyone may approve.
- Should a variance beyond a tolerance be blocked automatically?
  - Default answer: No; tolerance is policy stated in task instructions.
- Can a purchase order receive into any location?
  - Default answer: Yes, any inventory item of the same product.

## Left out

- Sales orders, picking, shipping and returns
  - Why: Request covers inbound receiving, counts and write-offs only
- Lot/serial tracking and multi-currency
  - Why: Adds complexity not requested
- Scheduled jobs such as automatic reorder
  - Why: Not requested

## Proof

The engine check passed: 7 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_9f8137c402144410caaf8b03827b1cc9a8e03573ae8fe4b7e697de99f3cabcfc`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| receive_partial_delivery | easy | 1.000 | 0.000 | 0.200 | n/a | declared (3); mutants 1/8 | `tid_0802890e7dcf24e9b253bf6eceddc58e195f3ac85594852d0a7c405cf9a93732` |
| settle_damaged_writeoffs | medium | 1.000 | 0.000 | 0.600, 0.400, 0.000 | 0.800 | declared (3); mutants 3/8 | `tid_92f0ab3c4d96bf994a86bcfa89f2d66349543bb8083927338bd01b8cfa605ba7` |
| reconcile_zone_counts | hard | 1.000 | 0.000 | 0.500, 0.600, 0.000 | 0.800 | declared (7); mutants 4/8 | `tid_a25f4a8608205343852fdfe023d83479b9010c66757ad7dcd55ddad2e5cb2d39` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `receive_partial_delivery` 0.200: receives the full ordered quantity of the line instead of the 12 units delivered
- `settle_damaged_writeoffs` 0.600: approves the damaged write-offs valued at $200 or less but never rejects the larger ones
- `settle_damaged_writeoffs` 0.400: rejects every pending damaged write-off without checking the $200 threshold
- `settle_damaged_writeoffs` 0.000: approves every pending write-off regardless of reason or value
- `reconcile_zone_counts` 0.500: only reads the first page of cycle counts, so the counts on the later page are never handled
- `reconcile_zone_counts` 0.600: approves the in-tolerance zone A counts on every page but ignores the large shortages, requesting no write-offs
- `reconcile_zone_counts` 0.000: approves every counted zone A count, including the large shortages, instead of writing them off

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| receive_partial_delivery | easy | 3 | none | purchase_order_line | none declared |
| settle_damaged_writeoffs | medium | 6 | none | write_off | distractors: met; state: met |
| reconcile_zone_counts | hard | 12 | cycle_count | cycle_count | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Warehouse management system (NetSuite/Fishbowl-style inventory with purchase orders, cycle counts and write-offs), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 1.91 | 0.2889 |
| model | 1 | 0.66 | 0.1784 |
| workflow | 1 | 0.39 | 0.1278 |
| seed | 1 | 0.67 | 0.1511 |
| tasks | 1 | 2.97 | 0.3807 |
| Total | 6 | 6.61 | 1.1268 |

Run total: 6.62 minutes, $1.1268.
