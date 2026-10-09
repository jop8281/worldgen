# WorldGen report: Swagger Petstore (OpenAPI 3.0 sample): pets, categories and store orders with inventory by pet status

A pet store where pets move available → pending → sold as customers place, approve and deliver orders. Placing an order reserves the pet, delivery sells it, and deleting an open order releases it. The 9 spec operations are kept under their spec paths. Three small extras make records discoverable and workflow steps explicit: list orders, categories, and approve and deliver actions.

## What was built

Entities (3):

- `category`: 6 seeded rows
- `pet`: 30 seeded rows
- `store_order`: 12 seeded rows

Routes (8):

- `add_pet`: POST /pet
- `find_pets_by_status`: GET /pet/findByStatus
- `get_pet`: GET /pet/{id}
- `delete_pet`: DELETE /pet/{id}
- `get_order`: GET /store/orders/{id}
- `list_orders`: GET /store/orders
- `list_categories`: GET /categories
- `create_category`: POST /categories

Actions (6):

- `update_pet`: PUT /pet
- `place_order`: POST /store/orders
- `approve_order`: POST /store/orders/{id}/approve
- `deliver_order`: POST /store/orders/{id}/deliver
- `delete_order`: DELETE /store/orders/{id}
- `get_inventory`: GET /store/inventory

Jobs: none.

## Assumed and why

- Row ids are engine ids such as pet_0001, ord_0001 and cat_0001, not int64. Spec path params petId and orderId become {id}. The spec's petId field on orders is kept as a ref to pet.
  - Why: The engine assigns prefixed string ids and a get, update or delete route must use {id}.
- photoUrls and tags are stored as comma-separated text. A separate Tag entity is not built. category is a ref to the category entity.
  - Why: The field types have no array or embedded object, so the closest honest form is text and a ref. The openapi checker may flag the array type of photoUrls and tags.
- Spec names stay camelCase: photoUrls, petId, shipDate.
  - Why: The task requires spec field names exactly as spelled.
- PUT /pet, POST /store/orders, DELETE /store/orders/{id} and GET /store/inventory are actions. The other spec operations are standard routes.
  - Why: Each needs body-id lookup, cross-entity effects such as reserving or releasing a pet, an aggregate, or a 204 answer from a handler, which standard routes cannot do.
- Standard create answers 201 for POST /pet and standard delete answers 204. place_order answers 200, as the spec says.
  - Why: The engine fixes success statuses for standard routes, and the spec's 200 for order creation is kept because it is an action.
- Pet creation always starts available. A POST /pet carrying another status is refused with 422 state.initial. A pet's status changes through the declared transitions: available to pending or sold, pending to available or sold, and sold to available.
  - Why: The engine enforces the initial state of state fields, and allowing sold to return to available keeps mistakes fixable.
- Error bodies use the proposed template { code: $status, type: $code, message: $message }. Tests assert the HTTP status plus body.type, which holds the engine or action code.
  - Why: It matches the source spec's ApiResponse (code, type, message).
- Unknown pet on PUT /pet is 404 pet_not_found, because the id is a plain string input and not a ref. Unknown petId on place_order is 400 input.invalid because it is a ref input.
  - Why: The spec gives 404 for PUT /pet and 400 for an invalid order.
- Order quantity is an int of at least 1. Pets stay unique animals, so quantity does not affect inventory counts.
  - Why: The spec requires quantity but defines no stock logic.
- Extras beyond the spec: GET /store/orders, GET and POST /categories, and the approve and deliver actions. The two order status steps need actions because status and complete are readonly.
  - Why: Agents must discover orders and categories, and the order lifecycle needs explicit transitions. The extra operations are deliberate and allowed with a warning.
- Clock starts 2026-10-07T09:00:00.000Z with tick 0s, after all seeded history. Order shipDate may lie in the future (planned) or in the past (stale placed orders).
  - Why: Time must be explicit and deterministic. Tasks cannot advance the clock, so they refer to the fixed date 2026-10-07.
- No jobs are built.
  - Why: The spec has no time-driven behavior. Staleness is a task for agents, not an automatic rule.
- Acceptance tests list only workflow actions in their actions field. Tests that mainly use standard routes (add_pet, create_category) also exercise place_order so each names at least one workflow action.
  - Why: The plan schema accepts only workflow action keys in a test's actions.

## Fields not in the input

None. The input names every field.

## Questions asked of the input

- Should ids be integers like the spec (int64) or prefixed strings?
  - Default answer: Prefixed strings (pet_0001, ord_0001), because the engine assigns them.
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

## Proof

The engine check passed: 8 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_f119814c616eb24dae058f683feadaede880f80030d9d624601058c97d9e07fd`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| order_biscuit | easy | 1.000 | 0.000 | 0.000, 0.700 | n/a | legacy; mutants 4/8 | `tid_4549cbb2c5747ba370c83c6feada75318f92e70c91a7998974e148be58a31be1` |
| deliver_cat_juniper | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.500 | n/a | legacy; mutants 5/8 | `tid_1fcddd015a39124188e3d3f0a3b6ec0af453ea6d930b3b20fa517de4b767e9a3` |
| release_stale_placed_orders | hard | 1.000 | 0.000 | 0.500, 0.000, 0.000 | 0.500 | legacy; mutants 4/8 | `tid_25289cca1e683ff73ed211cd99d1e2ba963471d1201c902113b0872289926dc4` |

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

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| order_biscuit | easy | 2 | none | pet | none declared |
| deliver_cat_juniper | medium | 2 | none | none | none declared |
| release_stale_placed_orders | hard | 4 | none | store_order | hard: met |

## Run

Mode: create from openapi. Model: claude-sonnet-5-5. Budget: $4.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 4.51 | 0.8758 |
| model | 1 | 0.40 | 0.3654 |
| workflow | 2 | 0.43 | 0.4373 |
| seed | 2 | 0.58 | 0.4596 |
| tasks | 2 | 1.49 | 0.5786 |
| Total | 9 | 7.41 | 2.7168 |

Backtracks:

- `tasks` to `workflow`: 1 issue

Run total: 7.43 minutes, $2.7168.
