# WorldGen report: Warehouse inventory / WMS-style stock ledger with purchase-order receiving (in the spirit of Odoo Inventory, NetSuite Inventory and Fishbowl)

A single-warehouse inventory system. SKUs are stocked in bins (stock_level rows, one per SKU and bin). Every change to stock is written to an append-only stock_movement ledger by an action, and stock can never go below zero. Purchase orders to suppliers move draft -> submitted -> partially_received -> received (or cancelled). Goods are received one PO line and one bin at a time, so a PO is received into bins in several partial shipments. Receiving is refused when it would exceed the ordered quantity, overfill a bin, or target an inactive or quarantine bin. Agents also issue stock, run cycle-count adjustments and transfer stock between bins. A job flags overdue purchase orders.

## What was built

Entities (7):

- `supplier`: 12 seeded rows
- `sku`: 80 seeded rows
- `bin`: 36 seeded rows
- `purchase_order`: 45 seeded rows
- `purchase_order_line`: 108 seeded rows
- `stock_level`: 216 seeded rows
- `stock_movement`: 278 seeded rows

Routes (21):

- `list_suppliers`: GET /suppliers
- `get_supplier`: GET /suppliers/{id}
- `create_supplier`: POST /suppliers
- `update_supplier`: PATCH /suppliers/{id}
- `list_skus`: GET /skus
- `get_sku`: GET /skus/{id}
- `create_sku`: POST /skus
- `update_sku`: PATCH /skus/{id}
- `list_bins`: GET /bins
- `get_bin`: GET /bins/{id}
- `create_bin`: POST /bins
- `update_bin`: PATCH /bins/{id}
- `list_stock_levels`: GET /stock_levels
- `get_stock_level`: GET /stock_levels/{id}
- `list_stock_movements`: GET /stock_movements
- `get_stock_movement`: GET /stock_movements/{id}
- `list_purchase_orders`: GET /purchase_orders
- `get_purchase_order`: GET /purchase_orders/{id}
- `create_purchase_order`: POST /purchase_orders
- `update_purchase_order`: PATCH /purchase_orders/{id}
- `list_purchase_order_lines`: GET /purchase_orders/{purchase_order_id}/lines

Actions (7):

- `add_po_line`: POST /purchase_orders/{id}/add_line
- `submit_purchase_order`: POST /purchase_orders/{id}/submit
- `receive_purchase_order`: POST /purchase_orders/{id}/receive
- `cancel_purchase_order`: POST /purchase_orders/{id}/cancel
- `issue_stock`: POST /stock/issue
- `adjust_stock`: POST /stock/adjust
- `transfer_stock`: POST /stock/transfer

Jobs (1):

- `overdue_purchase_orders`: every 6h

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 7 world tests, 1 warning. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| cycle_count_adjustment | easy | 1.000 | 0.000 | 0.400, 0.000, 0.400 | n/a |
| receive_rest_of_harbor_po | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | 0.000 |
| cancel_unstarted_northgate_pos | medium | 1.000 | 0.000 | 0.000, 0.000, 0.333 | 0.667 |
| restock_pick_bins | hard | 1.000 | 0.000 | 0.000, 0.000, 0.154 | 0.923 |

Decoys:

- `cycle_count_adjustment` 0.400: removes the difference with issue_stock, so the stock is right but the ledger row is an issue instead of an adjustment
- `cycle_count_adjustment` 0.000: adjusts the same SKU in a different pick bin (A-01-01) instead of A-03-02
- `cycle_count_adjustment` 0.400: adjusts the right bin to 12 but records a different reason than cycle count
- `receive_rest_of_harbor_po` 0.000: receives the outstanding quantity of only the first open line, so the PO stays partially received
- `receive_rest_of_harbor_po` 0.000: receives the right quantities but into bin R-02 instead of R-01
- `receive_rest_of_harbor_po` 0.000: sends each line's full ordered_qty instead of the remaining quantity, so lines that were already partly received are refused with over_receipt
- `cancel_unstarted_northgate_pos` 0.000: cancels the draft purchase orders of Northgate Industrial as well as the submitted ones
- `cancel_unstarted_northgate_pos` 0.000: matches suppliers by the search term Northgate and also cancels submitted POs of the similarly named Northgate Industries
- `cancel_unstarted_northgate_pos` 0.333: cancels only the first submitted purchase order it finds and stops, leaving the others open
- `restock_pick_bins` 0.000: moves the whole quantity of the bulk bin instead of only the shortfall, so pick bins overshoot the reorder point
- `restock_pick_bins` 0.000: does not skip inactive SKUs, so it also restocks a discontinued SKU that must be left alone
- `restock_pick_bins` 0.154: only restocks pick bins that are completely empty and ignores bins that are low but not empty

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 2.68 | 0.4430 |
| model | 1 | 0.71 | 0.3952 |
| workflow | 1 | 0.60 | 0.3896 |
| seed | 1 | 3.60 | 0.6116 |
| tasks | 1 | 4.10 | 0.7178 |
| Total | 5 | 11.69 | 2.5572 |

Run total: 11.74 minutes, $2.5572.
