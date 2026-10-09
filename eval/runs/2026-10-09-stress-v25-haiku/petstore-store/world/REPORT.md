# WorldGen report: Swagger Petstore OpenAPI 3.0 (store orders and inventory)

A world of the Petstore store API: customers' purchase orders for pets (place, find, delete) and an inventory count of pets by status. Core value is stateful order records an agent reads and changes through the API, so it is feasible. Pet CRUD and user routes are dropped by the source scope; pets exist only as seeded rows that the inventory reads.

## What was built

Entities (2):

- `order`: 30 seeded rows
- `pet`: 12 seeded rows

Routes (1):

- `list_orders`: GET /store/orders

Actions (4):

- `place_order`: POST /store/orders
- `get_order`: GET /store/orders/{orderId}
- `delete_order`: DELETE /store/orders/{orderId}
- `get_inventory`: GET /store/inventory

Jobs: none.

## Assumed and why

- Row ids are engine strings (ord_0001, pet_0001). The spec's int64 id is not reproduced; {orderId} in the path takes an engine id.
  - Why: Engine ids are prefixed strings. Renaming them to integers would break the engine's id model.
- Order.petId is a plain int, not a ref to pet.
  - Why: The spec types petId as a bare integer and the pet routes are out of scope, so petIds need not resolve to pet rows.
- POST /store/orders is the place_order action. It creates the order in placed and, when the body names approved or delivered, walks it through the transitions in the same call.
  - Why: A state field refuses a create to a non-initial state with state.initial, but the spec accepts status in the body, so the handler walks it instead.
- quantity below 1 is refused with 400 input.invalid and nothing is stored.
  - Why: The spec says quantity is an integer and the 400 response covers invalid orders; a zero-unit order is not a valid order.
- DELETE /store/orders/{orderId} is the delete_order action answering 204, and GET /store/orders/{orderId} is get_order.
  - Why: Tests and tasks must name workflow actions, and a standard route cannot be declared as one.
- Adds GET /store/orders (list_orders) with filters petId, status and complete, flagged as an extra operation.
  - Why: Tasks must find an order by pet without being given its id, and the Petstore spec has no listing. The openapi.operation_extra warning is accepted on purpose.
- Pets are seeded rows only. No pet routes. The inventory counts them by status.
  - Why: GET /store/inventory needs a pet status count, and the pet routes are dropped by scope.
- Error bodies use the proposed meta.api.error: code becomes the status, type the engine code, message the message. Tests assert body.type.
  - Why: The spec's ApiResponse schema is {code, type, message}.
- Clock starts at 2026-10-09T09:00:00.000Z with tick 0s and no jobs.
  - Why: Petstore has no time-driven behaviour, and an explicit start with no drift keeps replays deterministic.
- shipDate is an optional datetime stored as given, with no shipping logic. complete is a bool defaulting to false, set only by input.
  - Why: The spec gives no operation that changes them.
- No API action moves order or pet status after creation. Non-initial statuses exist only in seeded rows and in the create walk.
  - Why: The spec has no operation for updating orders or pets.

## Fields not in the input

1 field match no column or property name in the input. WorldGen invented each one, or renamed an input field.

- `pet.name`

## Questions asked of the input

- Should ids be the spec's int64 integers?
  - Default answer: No. Engine string ids are used; the id is an opaque string.
- Should the dropped /pet and /user operations be modelled?
  - Default answer: No. They are out of the kept /store scope.
- Should a list of orders exist, which the spec does not declare?
  - Default answer: Yes, as list_orders, flagged as an extra operation so agents can find orders without ids.
- Should POST with status approved or delivered be accepted?
  - Default answer: Yes. The create walks the order through placed to that state in one call.
- Should quantity 0 or negative be refused?
  - Default answer: Yes, with 400 input.invalid.
- Should orders move on from placed through an API operation?
  - Default answer: No. The spec has no such operation, so only seeded rows hold approved and delivered.

## Left out

- Pet CRUD, findByStatus, pet photos and tags (the dropped /pet operations)
  - Why: Outside the kept /store scope; pets are only seeded to back the inventory count.
- User routes and authentication
  - Why: Dropped by scope and not in the store API.
- Category and Tag schemas
  - Why: Only referenced by pets, which are out of scope.
- int64 ids
  - Why: Engine string ids replace them, see assumptions.
- Customer on an order
  - Why: The spec's Order carries no customer.

## Proof

The engine check passed: 8 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_883ce0020b33fa46b3b096c8897ba6e798c0b9f06b094eb2f2b4eafddccb6677`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| place_order_for_pet | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 1/8 | `tid_be075b2f2138c4a383aec279f9bd43e5e7b467482fb69666c5185da328bd8ce9` |
| delete_delivered_incomplete_order | medium | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 2/8 | `tid_6aed507bf82eafe9a5a4d6771bbfd6b5197dd3206c9618e3bc5751b02d3e96ff` |
| replace_stale_order | hard | 1.000 | 0.000 | 0.400, 0.800, 0.000, 0.400 | 0.400 | declared (2); mutants 2/8 | `tid_e15c0808d75f3743b960b7f31fa53ca5e53780270aadeabc7f04cc32089361e7` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `place_order_for_pet` 0.000: places the order for 3 units instead of 2, so the quantity is wrong
- `delete_delivered_incomplete_order` 0.000: deletes the placed 9-unit order for pet 3003 instead of the delivered incomplete one, the same pet and quantity with the wrong status
- `delete_delivered_incomplete_order` 0.000: reads only the first page and deletes the first delivered order it finds there, which belongs to another pet
- `replace_stale_order` 0.400: places the replacement but never deletes the stale 1-unit order
- `replace_stale_order` 0.800: deletes the stale order before placing the replacement, so a failed place would leave the pet with nothing
- `replace_stale_order` 0.000: places the replacement and deletes the 2-unit neighbour order for pet 3004 instead of the stale 1-unit one
- `replace_stale_order` 0.400: skips page 2: places the replacement, looks for the stale order on page 1 only, finds none there and stops

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| place_order_for_pet | easy | 1 | none | none | none declared |
| delete_delivered_incomplete_order | medium | 1 | order | order | paging: met; distractors: met; state: met; state: met |
| replace_stale_order | hard | 2 | order | order | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Checked against the OpenAPI source spec. The last step rejected any route, field type or enum that departs from it.

## Run

Mode: create from openapi. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 2.58 | 0.0291 |
| model | 1 | 0.26 | 0.0040 |
| workflow | 1 | 0.38 | 0.0071 |
| seed | 2 | 0.66 | 0.0107 |
| tasks | 2 | 3.98 | 0.0360 |
| Total | 8 | 7.86 | 0.0869 |

Run total: 7.86 minutes, $0.0869.
