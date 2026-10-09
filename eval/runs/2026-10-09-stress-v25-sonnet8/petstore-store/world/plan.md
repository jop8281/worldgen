# WorldGen plan: Swagger Petstore (OpenAPI 3.0) store API: orders and pet inventory

A pet store where customers place orders for pets, orders move placed → approved → delivered, orders reserve pet stock, and inventory reports pets per status. Mirrors the four /store operations of the spec (inventory, place, get, delete order) plus the minimal pet and workflow routes an agent needs.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `pet` | A pet listed for sale with a stock count and a sale status (available or sold). | name, petId, status, stock |
| `order` | A purchase order for a quantity of one pet, following placed, approved, delivered. | petId, quantity, shipDate, status, complete |

## Workflows

### order_lifecycle (order)
- States: placed, approved, delivered
- Actions: place_order, approve_order, deliver_order, delete_order
- Rules:
  - Placing an order for an available pet reserves its quantity from pet stock; the pet becomes sold when stock reaches 0; the new order is placed with complete false. Enforced by: place_order. Tested by: place_reserves_stock
  - An order for an unknown pet (400 unknown_pet), a sold pet (409 pet_sold), or a quantity above stock (409 insufficient_stock) is refused and changes nothing. Enforced by: place_order. Tested by: place_refusals
  - Orders move only placed → approved → delivered; delivering sets complete true; other moves are refused with 409 invalid_state. Enforced by: approve_order, deliver_order. Tested by: order_progression
  - Deleting a placed or approved order returns its quantity to pet stock and makes a sold pet available again; a delivered order cannot be deleted (409 order_delivered). Enforced by: delete_order. Tested by: delete_restores_stock
  - Order quantity is at least 1 and shipDate is optional.
### pet_inventory (pet)
- States: available, sold
- Actions: get_inventory
- Rules:
  - Inventory reports the number of pets per pet status, always with both available and sold keys. Enforced by: get_inventory. Tested by: inventory_counts
  - pet.petId is unique. Enforced by the data model: unique constraint on pet.petId

## Jobs

None. The plan declares no job.

## Acceptance tests

### place_reserves_stock
- Intent: Placing orders reserves pet stock and marks the pet sold at zero stock.
- Actions: place_order
- Description: Create a pet with stock 3, order 2, then 1; stock drops to 1 then 0 and the pet becomes sold; a further order is refused.

```js
(ctx) => {
  const p = ctx.api('POST', '/pets', { name: 'Acceptance Beagle A', petId: 90001, stock: 3 });
  ctx.assert(p.status === 201, 'create pet: ' + JSON.stringify(p));
  const o = ctx.api('POST', '/store/orders', { petId: 90001, quantity: 2, shipDate: '2026-10-20T10:00:00.000Z' });
  ctx.assert(o.status === 200, 'place: ' + JSON.stringify(o));
  ctx.assert(o.body.status === 'placed' && o.body.complete === false && o.body.petId === 90001 && o.body.quantity === 2, 'order fields: ' + JSON.stringify(o.body));
  const g = ctx.api('GET', '/store/orders/' + o.body.id);
  ctx.assert(g.status === 200 && g.body.id === o.body.id, 'get order: ' + JSON.stringify(g));
  let pet = ctx.api('GET', '/pets/' + p.body.id).body;
  ctx.assert(pet.stock === 1 && pet.status === 'available', 'stock 1 available: ' + JSON.stringify(pet));
  const o2 = ctx.api('POST', '/store/orders', { petId: 90001, quantity: 1 });
  ctx.assert(o2.status === 200, 'second order: ' + JSON.stringify(o2));
  pet = ctx.api('GET', '/pets/' + p.body.id).body;
  ctx.assert(pet.stock === 0 && pet.status === 'sold', 'sold at zero: ' + JSON.stringify(pet));
  const o3 = ctx.api('POST', '/store/orders', { petId: 90001, quantity: 1 });
  ctx.assert(o3.status === 409 && o3.body.type === 'pet_sold', 'sold pet: ' + JSON.stringify(o3));
}
```
### place_refusals
- Intent: Invalid orders are refused and change no stock.
- Actions: place_order
- Description: Unknown pet, zero quantity, missing petId and quantity above stock are refused; stock is unchanged.

```js
(ctx) => {
  const p = ctx.api('POST', '/pets', { name: 'Acceptance Beagle B', petId: 90002, stock: 2 });
  ctx.assert(p.status === 201, 'create pet: ' + JSON.stringify(p));
  const unknown = ctx.api('POST', '/store/orders', { petId: 90999, quantity: 1 });
  ctx.assert(unknown.status === 400 && unknown.body.type === 'unknown_pet', 'unknown pet: ' + JSON.stringify(unknown));
  const zero = ctx.api('POST', '/store/orders', { petId: 90002, quantity: 0 });
  ctx.assert(zero.status === 400 && zero.body.type === 'input.invalid', 'zero quantity: ' + JSON.stringify(zero));
  const missing = ctx.api('POST', '/store/orders', { quantity: 1 });
  ctx.assert(missing.status === 400 && missing.body.type === 'input.invalid', 'missing petId: ' + JSON.stringify(missing));
  const big = ctx.api('POST', '/store/orders', { petId: 90002, quantity: 3 });
  ctx.assert(big.status === 409 && big.body.type === 'insufficient_stock', 'too many: ' + JSON.stringify(big));
  const pet = ctx.api('GET', '/pets/' + p.body.id).body;
  ctx.assert(pet.stock === 2 && pet.status === 'available', 'stock unchanged: ' + JSON.stringify(pet));
}
```
### order_progression
- Intent: Orders advance placed, approved, delivered and refuse other moves.
- Actions: place_order, approve_order, deliver_order
- Description: Approve then deliver an order (complete becomes true); repeat approve, deliver a placed order and approve a missing order are refused.

```js
(ctx) => {
  const p = ctx.api('POST', '/pets', { name: 'Acceptance Beagle C', petId: 90003, stock: 5 });
  ctx.assert(p.status === 201, 'create pet: ' + JSON.stringify(p));
  const o = ctx.api('POST', '/store/orders', { petId: 90003, quantity: 1 });
  ctx.assert(o.status === 200, 'place: ' + JSON.stringify(o));
  const a = ctx.api('POST', '/store/orders/' + o.body.id + '/approve', {});
  ctx.assert(a.status === 200 && a.body.status === 'approved' && a.body.complete === false, 'approve: ' + JSON.stringify(a));
  const again = ctx.api('POST', '/store/orders/' + o.body.id + '/approve', {});
  ctx.assert(again.status === 409 && again.body.type === 'invalid_state', 'approve twice: ' + JSON.stringify(again));
  const d = ctx.api('POST', '/store/orders/' + o.body.id + '/deliver', {});
  ctx.assert(d.status === 200 && d.body.status === 'delivered' && d.body.complete === true, 'deliver: ' + JSON.stringify(d));
  const o2 = ctx.api('POST', '/store/orders', { petId: 90003, quantity: 1 });
  const early = ctx.api('POST', '/store/orders/' + o2.body.id + '/deliver', {});
  ctx.assert(early.status === 409 && early.body.type === 'invalid_state', 'deliver placed: ' + JSON.stringify(early));
  const missing = ctx.api('POST', '/store/orders/ord_9999/approve', {});
  ctx.assert(missing.status === 404 && missing.body.type === 'order_not_found', 'missing: ' + JSON.stringify(missing));
}
```
### delete_restores_stock
- Intent: Deleting an order returns its stock, and delivered orders cannot be deleted.
- Actions: place_order, approve_order, deliver_order, delete_order
- Description: Order the last unit, delete the order and see the pet available again; a delivered order is protected; a missing order is 404.

```js
(ctx) => {
  const p = ctx.api('POST', '/pets', { name: 'Acceptance Beagle D', petId: 90004, stock: 2 });
  ctx.assert(p.status === 201, 'create pet: ' + JSON.stringify(p));
  const o = ctx.api('POST', '/store/orders', { petId: 90004, quantity: 2 });
  ctx.assert(o.status === 200, 'place: ' + JSON.stringify(o));
  let pet = ctx.api('GET', '/pets/' + p.body.id).body;
  ctx.assert(pet.status === 'sold' && pet.stock === 0, 'sold after order: ' + JSON.stringify(pet));
  const del = ctx.api('DELETE', '/store/orders/' + o.body.id);
  ctx.assert(del.status === 204, 'delete: ' + JSON.stringify(del));
  pet = ctx.api('GET', '/pets/' + p.body.id).body;
  ctx.assert(pet.status === 'available' && pet.stock === 2, 'stock restored: ' + JSON.stringify(pet));
  const gone = ctx.api('GET', '/store/orders/' + o.body.id);
  ctx.assert(gone.status === 404 && gone.body.type === 'row.not_found', 'order gone: ' + JSON.stringify(gone));
  const o2 = ctx.api('POST', '/store/orders', { petId: 90004, quantity: 1 });
  ctx.api('POST', '/store/orders/' + o2.body.id + '/approve', {});
  ctx.api('POST', '/store/orders/' + o2.body.id + '/deliver', {});
  const prot = ctx.api('DELETE', '/store/orders/' + o2.body.id);
  ctx.assert(prot.status === 409 && prot.body.type === 'order_delivered', 'delivered delete: ' + JSON.stringify(prot));
  pet = ctx.api('GET', '/pets/' + p.body.id).body;
  ctx.assert(pet.stock === 1, 'stock unchanged by refused delete: ' + JSON.stringify(pet));
  const none = ctx.api('DELETE', '/store/orders/ord_9999');
  ctx.assert(none.status === 404 && none.body.type === 'order_not_found', 'missing delete: ' + JSON.stringify(none));
}
```
### inventory_counts
- Intent: Inventory counts pets per status.
- Actions: get_inventory, place_order
- Description: Compare inventory before and after adding a pet and selling it out.

```js
(ctx) => {
  const before = ctx.api('GET', '/store/inventory');
  ctx.assert(before.status === 200 && typeof before.body.available === 'number' && typeof before.body.sold === 'number', 'inventory shape: ' + JSON.stringify(before));
  const p = ctx.api('POST', '/pets', { name: 'Acceptance Beagle E', petId: 90005, stock: 1 });
  ctx.assert(p.status === 201, 'create pet: ' + JSON.stringify(p));
  const mid = ctx.api('GET', '/store/inventory').body;
  ctx.assert(mid.available === before.body.available + 1 && mid.sold === before.body.sold, 'available +1: ' + JSON.stringify(mid));
  const o = ctx.api('POST', '/store/orders', { petId: 90005, quantity: 1 });
  ctx.assert(o.status === 200, 'place: ' + JSON.stringify(o));
  const after = ctx.api('GET', '/store/inventory').body;
  ctx.assert(after.available === before.body.available && after.sold === before.body.sold + 1, 'moved to sold: ' + JSON.stringify(after));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `get_inventory` | GET | /store/inventory | Returns the number of pets per pet status as a map of integers (action). |
| `place_order` | POST | /store/orders | Place an order for a pet; reserves stock (action built from the create operation). |
| `get_order` | GET | /store/orders/{id} | Find a purchase order by id (spec orderId). |
| `delete_order` | DELETE | /store/orders/{id} | Delete an order and return its stock (action, answers 204). |
| `list_orders` | GET | /store/orders | List orders with filters so an agent can discover ids (added on purpose). |
| `approve_order` | POST | /store/orders/{id}/approve | Move a placed order to approved (added on purpose). |
| `deliver_order` | POST | /store/orders/{id}/deliver | Move an approved order to delivered (added on purpose). |
| `list_pets` | GET | /pets | List and filter pets. |
| `get_pet` | GET | /pets/{id} | Read one pet. |
| `create_pet` | POST | /pets | Add a pet with its stock. |
| `update_pet` | PATCH | /pets/{id} | Edit a pet. |

## Seed

- Rows per entity: pet: 30, order: 40
- Mix: 30 pets, about 80% available and 20% sold (stock 0); 40 orders spread over placed, approved and delivered, with shipDates spread around the clock start, several pets with more than one order, and a few same-named near-duplicate pets with different orders.
- State mix: order: placed 35%, approved 35%, delivered 30%; pet: available 80%, sold 20%

## Tasks

- `approve_biscuit_order` (easy, two_actors): Approve the one placed order for the pet named Biscuit.
  - Actions: `approve_order`
  - Decoy idea: Approves a delivered or approved order for another pet, or one of the other orders for a similarly named pet.
  - Pressure: distractor rows of order
- `cancel_luna_placed_order` (medium, irreversible): A customer cancelled: delete only the placed order for the pet named Luna with quantity 2, so its stock returns. Luna's other orders, including a delivered one, must stay.
  - Actions: `delete_order`
  - Decoy idea: Deletes the delivered or approved Luna order, or deletes by the wrong quantity, or PATCHes the pet stock by hand.
  - Pressure: seeded rows in order.placed, order.delivered; distractor rows of order
- `fulfil_orders_due_soon` (hard, scarce_resource): Take every order that is still placed and has a shipDate on or before 2026-10-12 all the way to delivered, approving then delivering each. Change nothing else.
  - Actions: `approve_order`, `deliver_order`
  - Decoy idea: Reads only the first page of orders, only approves without delivering, or also moves approved orders and orders shipping later.
  - Pressure: paging past the first page of order; seeded rows in order.placed, order.approved

## Open questions

- Should orders be listable and pets managed even though the spec kept only 4 store operations?
  - Default answer: Yes, add minimal list_orders and pet routes so agents can discover rows.
- Should placing an order reserve pet stock?
  - Default answer: Yes, a pet has a stock count and sells out.
- Should the integer order id be kept?
  - Default answer: No, use engine string ids.

## Assumptions

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

## Out of scope

- Pet create/update/delete beyond minimal pet routes, photos, tags, categories, /pet, /user endpoints
  - Why: Only 4 /store operations were kept; the rest were dropped.
- Authentication and API keys
  - Why: Not part of the kept operations.

## Changes

None. The plan changes no existing item.
