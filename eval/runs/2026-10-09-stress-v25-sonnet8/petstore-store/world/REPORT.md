# WorldGen report: Swagger Petstore (OpenAPI 3.0) store API: orders and pet inventory

A pet store where customers place orders for pets, orders move placed → approved → delivered, orders reserve pet stock, and inventory reports pets per status. Mirrors the four /store operations of the spec (inventory, place, get, delete order) plus the minimal pet and workflow routes an agent needs.

## What was built

Entities (2):

- `pet`: 30 seeded rows
- `order`: 40 seeded rows

Routes (6):

- `list_pets`: GET /pets
- `get_pet`: GET /pets/{id}
- `create_pet`: POST /pets
- `update_pet`: PATCH /pets/{id}
- `list_orders`: GET /store/orders
- `get_order`: GET /store/orders/{id}

Actions (5):

- `place_order`: POST /store/orders
- `approve_order`: POST /store/orders/{id}/approve
- `deliver_order`: POST /store/orders/{id}/deliver
- `delete_order`: DELETE /store/orders/{id}
- `get_inventory`: GET /store/inventory

Jobs: none.

## Assumed and why

- Engine row ids are strings (ord_0001, pet_0001); the spec's integer order id is replaced by the implicit id. petId on an order is an integer matching pet.petId, not a ref, to keep the spec's integer type.
  - Why: The engine assigns string ids and openapi field types must match; a ref would be a string.
- Path param {orderId} is written {id}.
  - Why: Get routes and actions address rows by {id}; the URL shape is identical.
- Added pet entity, pet routes, list_orders, approve_order and deliver_order beyond the 4 in-scope operations.
  - Why: Inventory by pet status and order progression need pets and an agent needs to discover and advance orders.
- Pet status is a state field with available and sold (no pending), moving available↔sold with stock.
  - Why: Keeps inventory simple and deterministic.
- Inventory counts pets (not units) per status and always includes both keys available and sold.
  - Why: Petstore inventory is keyed by pet status.
- place_order returns 200 with the Order (spec), refuses with 400 unknown_pet, 409 pet_sold or 409 insufficient_stock. Optional status input must be placed, complete must be false.
  - Why: Spec declares 200 and 400; conflicts use 409.
- Error body uses the proposed template, so the machine code is in body.type and the HTTP status is in body.code. Tests assert body.type.
  - Why: Follows the proposed meta.api.error.
- delete_order is an action answering 204, 404 order_not_found, and 409 order_delivered for delivered orders. Deleting returns the quantity to the pet and re-lists a sold pet as available.
  - Why: Cancelling an order must release reserved stock.
- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded history is before it, shipDates may be after it.
  - Why: Explicit deterministic time; shipDate is a planned future time.
- No jobs.
  - Why: Nothing in the spec happens on a schedule.
- Tests use pet petId values 90001 and above, seed uses 1 to 30.
  - Why: Avoids collisions with seed rows.

## Fields not in the input

2 fields match no column or property name in the input. WorldGen invented each one, or renamed an input field.

- `pet.name`
- `pet.stock`

## Questions asked of the input

- Should orders be listable and pets managed even though the spec kept only 4 store operations?
  - Default answer: Yes, add minimal list_orders and pet routes so agents can discover rows.
- Should placing an order reserve pet stock?
  - Default answer: Yes, a pet has a stock count and sells out.
- Should the integer order id be kept?
  - Default answer: No, use engine string ids.

## Left out

- Pet create/update/delete beyond minimal pet routes, photos, tags, categories, /pet, /user endpoints
  - Why: Only 4 /store operations were kept; the rest were dropped.
- Authentication and API keys
  - Why: Not part of the kept operations.

## Proof

The engine check passed: 5 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_9ecb4d40ad5b2f1f327c4766065b356b6d7a78d966dcce94795918e1dbb18c0c`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| approve_biscuit_order | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 4/8 | `tid_cd49882273a2417bdcfedb382eb9fb5a64077d2b0c20faa6122264fab78bd8d9` |
| cancel_luna_placed_order | medium | 1.000 | 0.000 | 0.000, 0.400, 0.600 | n/a | declared (2); mutants 4/8 | `tid_1b4a5d1160a383dd4d510014455e29eec3f1da825387b15817cfe208e5c5e10f` |
| fulfil_orders_due_soon | hard | 1.000 | 0.000 | 0.600, 0.000, 0.000 | 0.800 | declared (1); mutants 3/8 | `tid_5a7d609f81c2103d759bffaec15deb3347d3b4610c167ef0089548b085dd92b2` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `approve_biscuit_order` 0.000: approves the placed order of the similarly named pet Biscuit Jr instead of Biscuit
- `approve_biscuit_order` 0.000: approves the Biscuit order correctly, then also approves the placed order of Biscuit Jr
- `cancel_luna_placed_order` 0.000: deletes the approved Luna order of quantity 2 instead of the placed one
- `cancel_luna_placed_order` 0.400: puts the stock back by hand with a PATCH on the pet and never deletes the order
- `cancel_luna_placed_order` 0.600: deletes the right order, then adds the quantity to the pet stock by hand again, so the stock is returned twice
- `fulfil_orders_due_soon` 0.600: reads only the first page of the orders sorted by petId descending, so it misses the due placed orders on page 2
- `fulfil_orders_due_soon` 0.000: pages through every order but only approves the due placed orders and never delivers them
- `fulfil_orders_due_soon` 0.000: ignores the shipDate cutoff and delivers every placed order, including those shipping later

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| approve_biscuit_order | easy | 1 | none | order | distractors: met |
| cancel_luna_placed_order | medium | 2 | none | order | distractors: met; state: met; state: met |
| fulfil_orders_due_soon | hard | 5 | order | none | hard: met; paging: met; state: met; state: met |

## Fidelity

Checked against the OpenAPI source spec. The last step rejected any route, field type or enum that departs from it.

## Run

Mode: create from openapi. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.39 | 0.1445 |
| model | 1 | 0.37 | 0.1077 |
| workflow | 1 | 0.26 | 0.0838 |
| seed | 1 | 0.37 | 0.0942 |
| tasks | 1 | 2.09 | 0.2570 |
| Total | 5 | 4.48 | 0.6871 |

Run total: 4.49 minutes, $0.6871.
