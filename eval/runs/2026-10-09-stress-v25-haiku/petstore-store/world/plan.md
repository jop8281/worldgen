# WorldGen plan: Swagger Petstore OpenAPI 3.0 (store orders and inventory)

A world of the Petstore store API: customers' purchase orders for pets (place, find, delete) and an inventory count of pets by status. Core value is stateful order records an agent reads and changes through the API, so it is feasible. Pet CRUD and user routes are dropped by the source scope; pets exist only as seeded rows that the inventory reads.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `order` | A purchase order for a pet, the Petstore Order schema. Carries petId, quantity, shipDate, complete and a lifecycle status. | petId, status |
| `pet` | A pet listed for sale, seeded only. Its status feeds the inventory count. No pet routes are in scope. | name, status |

## Workflows

### order (order)
- States: placed, approved, delivered
- Actions: place_order, get_order, delete_order
- Rules:
  - An order quantity is at least 1; 0 or less is refused with 400 input.invalid and nothing is stored Enforced by: place_order. Tested by: order_quantity_refused
  - POST /store/orders with status approved or delivered walks the order through placed to that state in one call Enforced by: place_order. Tested by: place_order_status_walks
  - A deleted order cannot be fetched again: GET answers 404 row.not_found Enforced by: delete_order. Tested by: delete_then_get_404
  - Deleting an unknown order id answers 404 row.not_found Enforced by: delete_order. Tested by: delete_missing_404
  - Looking up an unknown order id answers 404 row.not_found Enforced by: get_order. Tested by: get_order_missing
  - Order status moves only placed to approved and approved to delivered; the engine refuses any other write with state.transition Enforced by the data model: status is a state field whose transitions list allows only placed to approved and approved to delivered
  - Orders carry no customer and petId is not checked against pets, as in the spec. Plain context only.
### pet (pet)
- States: available, pending, sold
- Actions: get_inventory
- Rules:
  - The inventory counts every pet under each of the three statuses Enforced by: get_inventory. Tested by: inventory_counts_statuses
  - A pet status moves available to pending, pending to available or sold; the engine refuses any other write Enforced by the data model: status is a state field whose transitions list allows only those moves

## Jobs

None. The plan declares no job.

## Acceptance tests

### place_order_defaults
- Intent: A new order is placed and not complete, and can be read back.
- Actions: place_order, get_order
- Description: POST with petId and quantity answers 200 placed, complete false; GET returns the same order.

```js
(ctx) => { const r = ctx.api('POST', '/store/orders', { petId: 8801, quantity: 2 }); ctx.assert(r.status === 200, 'place order returned ' + r.status + ' ' + JSON.stringify(r.body)); ctx.assert(r.body.status === 'placed' && r.body.complete === false, 'new order is placed and not complete, got ' + JSON.stringify(r.body)); ctx.assert(r.body.petId === 8801 && r.body.quantity === 2, 'petId and quantity are kept, got ' + JSON.stringify(r.body)); const g = ctx.api('GET', '/store/orders/' + r.body.id); ctx.assert(g.status === 200 && g.body.id === r.body.id, 'GET returns the order, got ' + g.status); }
```
### order_quantity_refused
- Intent: An order for fewer than one unit is refused and not stored.
- Actions: place_order
- Description: POST with quantity 0 answers 400 input.invalid.

```js
(ctx) => { const r = ctx.api('POST', '/store/orders', { petId: 8801, quantity: 0 }); ctx.assert(r.status === 400 && r.body.type === 'input.invalid', 'quantity 0 refused with input.invalid, got ' + r.status + ' ' + JSON.stringify(r.body)); }
```
### place_order_status_walks
- Intent: An order placed with status delivered is walked through approved and ends delivered.
- Actions: place_order, get_order
- Description: POST with status delivered answers 200 delivered, and GET agrees.

```js
(ctx) => { const r = ctx.api('POST', '/store/orders', { petId: 8802, quantity: 1, status: 'delivered' }); ctx.assert(r.status === 200 && r.body.status === 'delivered', 'delivered on create, got ' + r.status + ' ' + JSON.stringify(r.body)); const g = ctx.api('GET', '/store/orders/' + r.body.id); ctx.assert(g.status === 200 && g.body.status === 'delivered', 'GET shows delivered, got ' + JSON.stringify(g.body)); }
```
### delete_then_get_404
- Intent: A deleted order is gone for good.
- Actions: place_order, delete_order, get_order
- Description: DELETE answers 204 and a later GET answers 404 row.not_found.

```js
(ctx) => { const c = ctx.api('POST', '/store/orders', { petId: 8801, quantity: 4 }); ctx.assert(c.status === 200, 'create ' + c.status); const d = ctx.api('DELETE', '/store/orders/' + c.body.id); ctx.assert(d.status === 204, 'delete returned ' + d.status + ' ' + JSON.stringify(d.body)); const g = ctx.api('GET', '/store/orders/' + c.body.id); ctx.assert(g.status === 404 && g.body.type === 'row.not_found', 'GET after delete is 404 row.not_found, got ' + g.status + ' ' + JSON.stringify(g.body)); }
```
### delete_missing_404
- Intent: Deleting an order that does not exist is refused.
- Actions: delete_order
- Description: DELETE of an unknown id answers 404 row.not_found.

```js
(ctx) => { const d = ctx.api('DELETE', '/store/orders/ord_9999'); ctx.assert(d.status === 404 && d.body.type === 'row.not_found', 'unknown order delete is 404 row.not_found, got ' + d.status + ' ' + JSON.stringify(d.body)); }
```
### get_order_missing
- Intent: Looking up an unknown order is refused.
- Actions: get_order
- Description: GET of an unknown id answers 404 row.not_found.

```js
(ctx) => { const g = ctx.api('GET', '/store/orders/ord_9998'); ctx.assert(g.status === 404 && g.body.type === 'row.not_found', 'unknown order is 404 row.not_found, got ' + g.status + ' ' + JSON.stringify(g.body)); }
```
### inventory_counts_statuses
- Intent: The inventory reports a non-negative whole count for each pet status.
- Actions: get_inventory
- Description: GET /store/inventory answers 200 with integer available, pending and sold counts.

```js
(ctx) => { const r = ctx.api('GET', '/store/inventory'); ctx.assert(r.status === 200, 'inventory returned ' + r.status); for (const k of ['available', 'pending', 'sold']) ctx.assert(Number.isInteger(r.body[k]) && r.body[k] >= 0, k + ' is a non-negative integer, got ' + JSON.stringify(r.body[k])); }
```
### list_orders_by_pet
- Intent: An order can be found by its pet through the order list.
- Actions: place_order
- Description: After placing an order for pet 8803, GET /store/orders?petId=8803 lists it.

```js
(ctx) => { const c = ctx.api('POST', '/store/orders', { petId: 8803, quantity: 3 }); ctx.assert(c.status === 200, 'create ' + c.status); const l = ctx.api('GET', '/store/orders?petId=8803'); ctx.assert(l.status === 200, 'list returned ' + l.status + ' ' + JSON.stringify(l.body)); ctx.assert(l.body.data.some((o) => o.id === c.body.id), 'the created order is listed'); ctx.assert(l.body.data.every((o) => o.petId === 8803), 'the filter only returns pet 8803'); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `get_inventory` | GET | /store/inventory | Built as the get_inventory action: counts pets under each status (available, pending, sold). |
| `place_order` | POST | /store/orders | Built as the place_order action: creates an order in placed status, optionally walked to the requested status, and answers 200 with the Order. |
| `get_order` | GET | /store/orders/{orderId} | Built as the get_order action: returns the order or 404 row.not_found. |
| `delete_order` | DELETE | /store/orders/{orderId} | Built as the delete_order action: deletes the order and answers 204, or 404 row.not_found. |
| `list_orders` | GET | /store/orders | Added on purpose (extra to the spec, flagged in assumptions): list orders, filterable by petId, status and complete, so an agent can find an order without knowing its id. A list route, not an action, so it is not in any workflow's actions. |

## Seed

- Rows per entity: order: 28, pet: 12
- Mix: Orders: 28 rows, placed/approved/delivered roughly 43/29/28. Pets: 12 rows, available/pending/sold roughly 58/25/17. Pet ids for orders are 1000 to 7999 except the task rows: 3003 (one delivered incomplete order for quantity 9, plus a placed quantity 9 decoy and a delivered complete quantity 4 decoy) and 3004 (a placed quantity 1 stale order plus a placed quantity 2 neighbour). Task target rows sit after the first 25 orders in id order so they fall on page 2. No seeded petId is in 8800 to 8899, which the tests use.
- State mix: order: placed 43%, approved 29%, delivered 28%; pet: available 58%, pending 25%, sold 17%

## Tasks

- `place_order_for_pet` (easy, permissions): Place an order for pet 8801 for 2 units and confirm it is placed.
  - Actions: `place_order`
  - Decoy idea: places the order for the wrong quantity, or PATCHes an existing order instead of placing a new one
- `delete_delivered_incomplete_order` (medium, irreversible): Pet 3003 has a delivered but incomplete order for 9 units. Delete that order and leave the others for the pet alone.
  - Actions: `delete_order`
  - Decoy idea: deletes the placed order for the same pet and quantity instead of the delivered one, or reads only page 1 and misses the target on page 2
  - Pressure: paging past the first page of order; seeded rows in order.delivered, order.placed; distractor rows of order
- `replace_stale_order` (hard, irreversible): Pet 3004 has a stale placed order for 1 unit. Place a replacement for 4 units first, then delete the stale order. Change nothing else.
  - Actions: `place_order`, `delete_order`
  - Decoy idea: deletes the stale order before placing the replacement, so a failed place leaves the pet with nothing; or deletes the wrong order or skips page 2
  - Pressure: paging past the first page of order; seeded rows in order.placed; distractor rows of order

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

None. The plan changes no existing item.
