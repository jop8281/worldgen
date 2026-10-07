# WorldGen report: Swagger Petstore (OpenAPI 3.0 sample): pets, categories and store orders with inventory by pet status, plus order refunds

A pet store where pets move available → pending → sold as customers place, approve and deliver orders. Placing an order reserves the pet, delivery sells it, and deleting an open order releases it. A customer can ask for a refund on a delivered order. A refund is requested, then approved (optionally putting the pet back on sale) or rejected. The 9 spec operations are kept under their spec paths. Extras: list orders, categories, approve and deliver actions, and the refund actions and reads. This revision declares an allows list on every task, taken from the task instruction: which entities may be created, updated or deleted, the exact fields of updates, and a where of field values that picks the target rows. Nothing else is changed.

## What was built

Entities (4):

- `category`: 6 seeded rows
- `pet`: 30 seeded rows
- `store_order`: 12 seeded rows
- `refund`: 5 seeded rows

Routes (10):

- `add_pet`: POST /pet
- `find_pets_by_status`: GET /pet/findByStatus
- `get_pet`: GET /pet/{id}
- `delete_pet`: DELETE /pet/{id}
- `get_order`: GET /store/orders/{id}
- `list_orders`: GET /store/orders
- `list_categories`: GET /categories
- `create_category`: POST /categories
- `list_refunds`: GET /refunds
- `get_refund`: GET /refunds/{id}

Actions (9):

- `update_pet`: PUT /pet
- `place_order`: POST /store/orders
- `approve_order`: POST /store/orders/{id}/approve
- `deliver_order`: POST /store/orders/{id}/deliver
- `delete_order`: DELETE /store/orders/{id}
- `get_inventory`: GET /store/inventory
- `request_refund`: POST /store/orders/{id}/refunds
- `approve_refund`: POST /refunds/{id}/approve
- `reject_refund`: POST /refunds/{id}/reject

Jobs: none.

## Changes

- item_changed `tasks.deliver_cat_juniper.allows`
- item_changed `tasks.order_biscuit.allows`
- item_changed `tasks.release_stale_placed_orders.allows`
- item_changed `tasks.request_refund_mochi.allows`
- item_changed `tasks.restock_pepper_refund.allows`
- item_changed `tasks.settle_requested_refunds.allows`

## Assumed and why

- Row ids are engine ids such as pet_0001, ord_0001, cat_0001 and rfd_0001, not int64. Spec path params petId and orderId become {id}. The spec's petId field on orders is kept as a ref to pet.
  - Why: The engine assigns prefixed string ids and a get, update or delete route must use {id}.
- photoUrls and tags are stored as comma-separated text. A separate Tag entity is not built. category is a ref to the category entity.
  - Why: The field types have no array or embedded object, so the closest honest form is text and a ref. The openapi checker may flag the array type of photoUrls and tags.
- Spec names stay camelCase: photoUrls, petId, shipDate. The refund's order ref follows that style and is named orderId.
  - Why: The task requires spec field names exactly as spelled, and refunds sit beside orders that use petId.
- PUT /pet, POST /store/orders, DELETE /store/orders/{id} and GET /store/inventory are actions. The other spec operations are standard routes.
  - Why: Each needs body-id lookup, cross-entity effects such as reserving or releasing a pet, an aggregate, or a 204 answer from a handler, which standard routes cannot do.
- Standard create answers 201 for POST /pet and standard delete answers 204. place_order answers 200, as the spec says. request_refund is an action and answers 201 because it creates a row.
  - Why: The engine fixes success statuses for standard routes, and the spec's 200 for order creation is kept because it is an action.
- Pet creation always starts available. A POST /pet carrying another status is refused with 422 state.initial. A pet's status changes through the declared transitions: available to pending or sold, pending to available or sold, and sold to available.
  - Why: The engine enforces the initial state of state fields, and allowing sold to return to available keeps mistakes fixable and lets a refund restock a sold pet.
- Error bodies use the proposed template { code: $status, type: $code, message: $message }. Tests assert the HTTP status plus body.type, which holds the engine or action code.
  - Why: It matches the source spec's ApiResponse (code, type, message).
- Unknown pet on PUT /pet is 404 pet_not_found, because the id is a plain string input and not a ref. Unknown petId on place_order is 400 input.invalid because it is a ref input. Unknown order on request_refund is 404 order_not_found and unknown refund on approve or reject is 404 refund_not_found, because those ids are path params read by the handler.
  - Why: The spec gives 404 for PUT /pet and 400 for an invalid order. The refund actions follow the order action conventions.
- Order quantity is an int of at least 1. Pets stay unique animals, so quantity does not affect inventory counts.
  - Why: The spec requires quantity but defines no stock logic.
- Extras beyond the spec: GET /store/orders, GET and POST /categories, the approve and deliver actions, and the refund routes (request, approve, reject, list, get). The order status steps need actions because status and complete are readonly.
  - Why: Agents must discover orders, categories and refunds, and the lifecycles need explicit transitions. The extra operations are deliberate and allowed with a warning.
- Refunds are a new entity with its own state machine requested, approved, rejected. The store_order status machine is not changed: a refunded order stays delivered. restock, decision_note and decided_at are readonly and set only by approve_refund and reject_refund. amount is money in USD with min 1.
  - Why: This adds the feature without altering the existing order and pet workflows or their tests.
- refund.orderId is a required ref to store_order with onDelete restrict. delete_order is not edited. An order with a refund therefore answers 409 delete.restricted through the engine.
  - Why: Refund history should not vanish, and the existing handler's delete already enforces the restriction.
- Approving a refund never moves the order. With restock true it moves the pet sold to available only if the pet is currently sold, otherwise 409 cannot_restock.
  - Why: A pet that was already put back on sale, or reserved again, must not be restocked twice.
- Seed refunds all sit on delivered orders. One delivered order (pet Mochi) has only rejected refunds so a task can file a new request. Existing seed counts and state mixes for pets and orders are unchanged.
  - Why: Refund tasks need unambiguous targets and an eligible order, and existing tasks must keep their seed.
- Clock starts 2026-10-07T09:00:00.000Z with tick 0s, after all seeded history. Order shipDate may lie in the future (planned) or in the past (stale placed orders). Refund decided_at lies before the clock start.
  - Why: Time must be explicit and deterministic. Tasks cannot advance the clock, so they refer to the fixed date 2026-10-07.
- No jobs are built. Refunds are not auto-expired or auto-approved.
  - Why: The spec has no time-driven behavior. Deciding refunds is a task for agents.
- Acceptance tests list only workflow actions in their actions field. Tests that mainly use standard routes (add_pet, create_category) also exercise place_order so each names at least one workflow action.
  - Why: The plan schema accepts only workflow action keys in a test's actions.
- Every task gets an allows list taken from its instruction, stated in the task intent: entity, kind (created, updated or deleted), exact fields for updates, and a where of equality field values that picks the target rows. Only the tasks change. No entity, route, action, workflow, test or seed row changes.
  - Why: The change request asks for allows on every task and nothing else.
- A where can only match equal field values, so range conditions in an instruction (shipDate before 2026-10-07, amount above or at most 10000) are not in where. The where narrows by status and the target names, and the grader checks the range on the exact rows. Refs in where (the Biscuit pet, the Cats category, Mochi's order) are filled with the seeded row ids by the tasks stage.
  - Why: The allows where has no comparison operators, and the instruction gives names, not ids.
- Side effects the instruction implies are allowed: place_order moves the pet to pending, deliver_order sets the pet sold, delete_order releases the pet, approve_refund with restock moves the pet to available. Fields set by actions (status, complete, restock, decided_at, decision_note) are listed on the updated entity.
  - Why: The allows is derived from what the instruction asks for, and these are the effects of the actions that carry it out.

## Questions asked of the input

- Should ids be integers like the spec (int64) or prefixed strings?
  - Default answer: Prefixed strings (pet_0001, ord_0001, rfd_0001), because the engine assigns them.
- How should array fields photoUrls and tags be represented?
  - Default answer: Comma-separated text on the pet. Tag has no entity of its own.
- Does a pet have stock, so an order's quantity matters?
  - Default answer: No. A pet is one listing. Quantity is at least 1 and is stored only on the order.
- Who may set order status and complete?
  - Default answer: Only the actions (place, approve, deliver). Clients cannot set them. place_order refuses status other than placed and complete true.
- Is PUT /pet a standard update?
  - Default answer: No. It is an action that finds the pet by the id in the body, because the standard update route needs {id} in the path.
- Should deleting an open order release the pet?
  - Default answer: Yes. A placed or approved order returns the pet to available. A delivered order leaves it sold.
- Which orders can be refunded?
  - Default answer: Only delivered orders. Orders that are placed or approved are cancelled by deleting them, which already releases the pet.
- Do orders have a price, and can the refund amount be checked against it?
  - Default answer: No. The world has no prices, so the client states the amount in USD minor units (at least 1) and it is not capped.
- Can an order be refunded more than once, for example in parts?
  - Default answer: One active refund (requested or approved) per order. After a rejection a new request is allowed. Partial refunds are not summed.
- Does a refund change the order status or put the pet back on sale?
  - Default answer: The order stays delivered. The pet goes back to available only when the approver sets restock true and the pet is sold. Otherwise it stays sold.
- What happens to refunds when an order is deleted?
  - Default answer: An order with any refund cannot be deleted (409 delete.restricted), so the refund history is kept.
- How can an allows where express a range such as shipDate before a date or an amount above 10000?
  - Default answer: It cannot. The where holds equal field values only (status, names, resolved ids). The grader checks the range on the exact rows.
- Should the allows list include the pet changes that follow from an order action, such as the pet moving to pending, sold or available?
  - Default answer: Yes, as an update of the pet's status field only, because the instruction implies those effects.

## Left out

- Tag as its own entity and routes, and real array fields for photoUrls and tags
  - Why: The field types have no arrays. Tags are kept as text on the pet.
- Users, login, API keys and OAuth
  - Why: The 9 spec operations kept for this world are unauthenticated.
- Image upload and other spec operations that were dropped
  - Why: All 9 kept operations are covered. Binary upload has no stateful records.
- Per-pet stock and quantity-based inventory
  - Why: The spec counts pets by status only.
- Automatic order expiry or time-driven jobs
  - Why: The spec has none. The hard task has the agent do the cleanup.
- Order prices, payments, payment gateways and payout of the refund money
  - Why: The world has no prices or payments. A refund is a recorded decision with a client-stated amount.
- A refunded order status and multiple or partial refunds summed against an order total
  - Why: Keeps the order state machine unchanged. One active refund per order is enough for the workflow.
- Refund creation or editing through standard routes, and deleting refunds
  - Why: Refunds change only through the request, approve and reject actions, which protect the audit trail.
- Any change to entities, routes, actions, workflows, jobs, tests or seed rows
  - Why: The change request only adds allows lists to the tasks.

## Proof

The engine check passed: 11 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_d35309768d6d3c8d49388536a5858bdaccd577d36ba6a26a586eb2d97764c045`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| order_biscuit | easy | 1.000 | 0.000 | 0.000, 0.700 | n/a | declared (2); mutants 4/7 | `tid_e2b44620abb9d67d0534e82120517f67640a166b75fa1b1e883d9c19b7a92488` |
| deliver_cat_juniper | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.500 | n/a | declared (2); mutants 5/7 | `tid_90105d0f2da3d241fd87f390b6a64aed7b1c1259abb4b115477c33ffab4ba2d7` |
| release_stale_placed_orders | hard | 1.000 | 0.000 | 0.500, 0.000, 0.000 | 0.500 | declared (2); mutants 4/7 | `tid_0e6d4c8073e4316dae3646efc90d3b0824b872193a4e29183969dac160d2bec2` |
| request_refund_mochi | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 3/7 | `tid_2147be8cf95c07e1eeb6299623960c8f35fb0e0bf411c49bf4fc6cebbfa01bc9` |
| restock_pepper_refund | medium | 1.000 | 0.000 | 0.300, 0.700, 0.000, 0.000 | n/a | declared (2); mutants 4/7 | `tid_3b48a19874c3a397e25819cda8de970e6fb6d2261b568dccd97e84e5d8646ea4` |
| settle_requested_refunds | hard | 1.000 | 0.000 | 0.500, 0.500, 0.500, 0.000 | 0.500 | declared (1); mutants 2/7 | `tid_ef6e9f00ee77846dea62c9f66e40f32f41426dd63ee1fc7e2b9a21df7dc7ef53` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `order_biscuit` 0.000: orders the similarly named Biscuit Jr instead of Biscuit
- `order_biscuit` 0.700: orders the right pet with the right quantity but leaves out the ship date
- `deliver_cat_juniper` 0.000: delivers the dog Juniper's order instead of the cat's
- `deliver_cat_juniper` 0.000: delivers the approved orders of both Juniper pets
- `deliver_cat_juniper` 0.000: deletes the cat's order, which frees the pet and delivers nothing
- `deliver_cat_juniper` 0.500: delivers the cat's order, then sets the sold pet back to available by hand, so the pet is not sold
- `release_stale_placed_orders` 0.500: deletes only the first stale placed order and stops, leaving the others
- `release_stale_placed_orders` 0.000: deletes every order with a past ship date, including the approved one
- `release_stale_placed_orders` 0.000: deletes all placed orders including the future-dated ones
- `request_refund_mochi` 0.000: files the refund on Mochi's order but with the amount of the older rejected request (5000) instead of 6000
- `restock_pepper_refund` 0.300: approves the Pepper refund without restock, so the pet stays sold
- `restock_pepper_refund` 0.700: approves the Pepper refund without restock, then sets the pet to available by hand with update_pet, so the refund does not record restock
- `restock_pepper_refund` 0.000: approves with restock the refund of the similarly named Pepperoni instead of Pepper
- `restock_pepper_refund` 0.000: rejects the Pepper refund instead of approving it
- `settle_requested_refunds` 0.500: decides only the first requested refund and stops, leaving the others
- `settle_requested_refunds` 0.500: approves every requested refund regardless of amount
- `settle_requested_refunds` 0.500: rejects every requested refund regardless of amount
- `settle_requested_refunds` 0.000: decides each refund by the rule but approves the small ones with restock true, which puts sold pets back on sale

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| order_biscuit | easy | 2 | none | pet | none declared |
| deliver_cat_juniper | medium | 2 | none | none | none declared |
| release_stale_placed_orders | hard | 4 | none | store_order | hard: met |
| request_refund_mochi | easy | 1 | none | none | none declared |
| restock_pepper_refund | medium | 2 | none | none | none declared |
| settle_requested_refunds | hard | 2 | none | none | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $1.60.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.81 | 0.3399 |
| tasks | 1 | 0.24 | 0.2432 |
| Total | 2 | 2.05 | 0.5831 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures

Run total: 2.08 minutes, $0.5831.
