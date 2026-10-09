# WorldGen plan: Square-for-Retail / Toast-style bakery order and pickup system

A neighborhood bakery tracks its products and stock, customers, and pre-orders. Orders move from placed to baking to ready to picked up, can be cancelled before they are ready, and stock is reserved when an order is placed. A daily job cancels ready orders that nobody collected.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T08:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `product` | A baked good for sale with price, category and stock on hand. | name, category, price, stock |
| `customer` | A person who places pre-orders. | name, email, phone |
| `order` | A pre-order of one product in a quantity by one customer, moving through bakery states. | customer_id, product_id, quantity, total, status, ready_at |

## Workflows

### order_fulfilment (order)
- States: placed, baking, ready, picked_up, cancelled
- Actions: place_order, start_baking, mark_ready, pick_up_order, cancel_order
- Rules:
  - Placing an order reserves stock: it fails with insufficient_stock when quantity exceeds product stock, otherwise stock is reduced by quantity and total is quantity times price. Enforced by: place_order. Tested by: place_order_reserves_stock
  - Orders move only placed to baking to ready to picked_up; any other action order is refused with invalid_state. Enforced by: start_baking, mark_ready, pick_up_order. Tested by: order_lifecycle_order
  - Cancelling is allowed only from placed or baking, and returns the reserved stock to the product. Enforced by: cancel_order. Tested by: cancel_restores_stock
  - A ready order not picked up within 2 days is cancelled by the daily job and its stock is returned. Enforced by: expire_ready_orders. Tested by: expire_uncollected_orders
  - Product names are unique. Enforced by the data model: The product name field is declared unique, so the engine refuses duplicates with field.unique.

## Jobs

- `expire_ready_orders` runs every 1d: Cancel every ready order whose ready_at is 2 days or more in the past and add its quantity back to the product stock.

## Acceptance tests

### place_order_reserves_stock
- Intent: Placing an order reduces stock, computes total and refuses over-ordering
- Actions: place_order
- Description: Create a product with stock 5, order 2 (stock 3, total 2x price), then 4 is refused with insufficient_stock and quantity 0 is refused.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Sourdough Alpha', category: 'bread', price: 500, stock: 5 });
  ctx.assert(p.status === 201, 'create product: ' + JSON.stringify(p.body));
  const c = ctx.api('POST', '/customers', { name: 'Test Buyer Alpha', email: 'buyer.alpha@example.com' });
  ctx.assert(c.status === 201, 'create customer: ' + JSON.stringify(c.body));
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 2 });
  ctx.assert(o.status === 201, 'place: ' + JSON.stringify(o.body));
  ctx.assert(o.body.status === 'placed' && o.body.total === 1000, 'placed with total 1000: ' + JSON.stringify(o.body));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 3, 'stock reduced to 3');
  const big = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 4 });
  ctx.assert(big.status === 409 && big.body.error.code === 'insufficient_stock', 'over-order: ' + JSON.stringify(big.body));
  const zero = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 0 });
  ctx.assert(zero.status === 400 && zero.body.error.code === 'input.invalid', 'zero quantity: ' + JSON.stringify(zero.body));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 3, 'stock unchanged after refusals');
}
```
### order_lifecycle_order
- Intent: Orders advance in order and out-of-order actions are refused
- Actions: place_order, start_baking, mark_ready, pick_up_order, cancel_order
- Description: placed cannot be marked ready; baking, ready, picked_up succeed in order; a picked up order cannot be cancelled or restarted.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Croissant Beta', category: 'pastry', price: 350, stock: 10 });
  const c = ctx.api('POST', '/customers', { name: 'Test Buyer Beta', email: 'buyer.beta@example.com' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1 });
  ctx.assert(o.status === 201, 'place: ' + JSON.stringify(o.body));
  const id = o.body.id;
  const early = ctx.api('POST', '/orders/' + id + '/mark_ready', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'ready from placed: ' + JSON.stringify(early.body));
  const nopick = ctx.api('POST', '/orders/' + id + '/pick_up', {});
  ctx.assert(nopick.status === 409 && nopick.body.error.code === 'invalid_state', 'pick up from placed');
  const b = ctx.api('POST', '/orders/' + id + '/start_baking', {});
  ctx.assert(b.status === 200 && b.body.status === 'baking', 'baking: ' + JSON.stringify(b.body));
  const again = ctx.api('POST', '/orders/' + id + '/start_baking', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second start_baking');
  const r = ctx.api('POST', '/orders/' + id + '/mark_ready', {});
  ctx.assert(r.status === 200 && r.body.status === 'ready' && r.body.ready_at !== null, 'ready: ' + JSON.stringify(r.body));
  const pk = ctx.api('POST', '/orders/' + id + '/pick_up', {});
  ctx.assert(pk.status === 200 && pk.body.status === 'picked_up', 'picked up: ' + JSON.stringify(pk.body));
  const cn = ctx.api('POST', '/orders/' + id + '/cancel', {});
  ctx.assert(cn.status === 409 && cn.body.error.code === 'invalid_state', 'cancel after pickup');
}
```
### cancel_restores_stock
- Intent: Cancelling a placed or baking order returns stock; ready orders cannot be cancelled
- Actions: place_order, cancel_order, start_baking, mark_ready
- Description: Order 3 of 5, stock 2; cancel, stock 5; second cancel refused; a ready order cannot be cancelled.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Baguette Gamma', category: 'bread', price: 300, stock: 5 });
  const c = ctx.api('POST', '/customers', { name: 'Test Buyer Gamma', email: 'buyer.gamma@example.com' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 3 });
  ctx.assert(o.status === 201, 'place: ' + JSON.stringify(o.body));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 2, 'stock 2 after order');
  const cn = ctx.api('POST', '/orders/' + o.body.id + '/cancel', {});
  ctx.assert(cn.status === 200 && cn.body.status === 'cancelled', 'cancel: ' + JSON.stringify(cn.body));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 5, 'stock restored to 5');
  const twice = ctx.api('POST', '/orders/' + o.body.id + '/cancel', {});
  ctx.assert(twice.status === 409 && twice.body.error.code === 'invalid_state', 'second cancel');
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 5, 'stock not restored twice');
  const o2 = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1 });
  ctx.api('POST', '/orders/' + o2.body.id + '/start_baking', {});
  ctx.api('POST', '/orders/' + o2.body.id + '/mark_ready', {});
  const late = ctx.api('POST', '/orders/' + o2.body.id + '/cancel', {});
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'cancel ready order refused');
}
```
### expire_uncollected_orders
- Intent: The daily job cancels ready orders left uncollected for 2 days and returns stock
- Actions: place_order, start_baking, mark_ready
- Description: A ready order stays ready after 1 day, becomes cancelled after 3 days with stock restored; a picked up order is untouched.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Brioche Delta', category: 'bread', price: 450, stock: 6 });
  const c = ctx.api('POST', '/customers', { name: 'Test Buyer Delta', email: 'buyer.delta@example.com' });
  const a = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 2 });
  const b = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1 });
  ctx.assert(a.status === 201 && b.status === 201, 'place both');
  for (const o of [a, b]) {
    ctx.api('POST', '/orders/' + o.body.id + '/start_baking', {});
    ctx.api('POST', '/orders/' + o.body.id + '/mark_ready', {});
  }
  ctx.assert(ctx.api('POST', '/orders/' + b.body.id + '/pick_up', {}).status === 200, 'pick up b');
  ctx.advance('1d');
  ctx.assert(ctx.api('GET', '/orders/' + a.body.id).body.status === 'ready', 'still ready after 1 day');
  const run = ctx.advance('3d');
  ctx.assert(run.jobsFired.includes('expire_ready_orders'), 'job fired');
  ctx.assert(ctx.api('GET', '/orders/' + a.body.id).body.status === 'cancelled', 'uncollected order cancelled');
  ctx.assert(ctx.api('GET', '/orders/' + b.body.id).body.status === 'picked_up', 'picked up order untouched');
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 5, 'stock of the cancelled order returned, got ' + ctx.api('GET', '/products/' + p.body.id).body.stock);
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_products` | GET | /products | List products, filter by category, search by name. |
| `get_product` | GET | /products/{id} | Fetch one product. |
| `create_product` | POST | /products | Add a product. |
| `update_product` | PATCH | /products/{id} | Edit price, name, category or restock. |
| `list_customers` | GET | /customers | List customers, search by name and email. |
| `get_customer` | GET | /customers/{id} | Fetch one customer. |
| `create_customer` | POST | /customers | Register a customer. |
| `list_orders` | GET | /orders | List orders, filter by status, customer and product. |
| `get_order` | GET | /orders/{id} | Fetch one order. |
| `place_order` | POST | /orders | Built as the place_order action. |
| `start_baking` | POST | /orders/{id}/start_baking | Built as the start_baking action. |
| `mark_ready` | POST | /orders/{id}/mark_ready | Built as the mark_ready action. |
| `pick_up_order` | POST | /orders/{id}/pick_up | Built as the pick_up_order action. |
| `cancel_order` | POST | /orders/{id}/cancel | Built as the cancel_order action. |

## Seed

- Rows per entity: product: 10, customer: 12, order: 30
- Mix: Orders spread across all five states with no state above 30%; products across bread, pastry, cake and cookie categories, most with healthy stock and two nearly sold out; several customers have multiple orders, and two products have near-identical names.
- State mix: order: placed 25%, baking 25%, ready 20%, picked_up 20%, cancelled 10%

## Tasks

- `mark_ready_for_customer` (easy, two_actors): Mark the baking order of a named customer as ready for pickup, touching nothing else.
  - Actions: `mark_ready`
  - Decoy idea: Marks a different baking order, such as another customer's with a similar name, as ready.
  - Pressure: seeded rows in order.baking; distractor rows of order
- `cancel_placed_order_restock` (medium, irreversible): Cancel a named customer's placed order for a given product so the stock goes back, leaving their other orders alone.
  - Actions: `cancel_order`
  - Decoy idea: Cancels all of the customer's orders, or cancels the ready one that cannot be cancelled, or edits stock by hand.
  - Pressure: seeded rows in order.placed, order.ready; distractor rows of order
- `fulfil_customer_placed_orders` (hard, scarce_resource): A customer with several placed orders is collecting today: move every one of their placed orders through baking to ready, and cancel any whose product has stock shown as discontinued in its name, found by paging through the full order list.
  - Actions: `start_baking`, `mark_ready`, `cancel_order`
  - Decoy idea: Reads only the first page of orders, or marks orders ready without starting baking first, or advances another customer's orders.
  - Pressure: paging past the first page of order; seeded rows in order.placed, order.baking; distractor rows of order

## Open questions

- Is this for pre-orders with pickup, or in-store sales and delivery?
  - Default answer: Pre-orders with in-store pickup.
- Can one order contain several products?
  - Default answer: No, one product and quantity per order.
- How long is a ready order held?
  - Default answer: 2 days, then auto-cancelled.
- Is payment tracked?
  - Default answer: No, out of scope.

## Assumptions

- Each order holds one product and a quantity rather than multiple line items.
  - Why: Keeps the model small while still allowing stock contention.
- Stock is reserved at order placement and returned on cancellation.
  - Why: Gives a scarce-resource rule and an irreversible-step rule agents must respect.
- Clock starts 2026-10-09T08:00:00Z with tick 0s; seeded history is before this and nothing is scheduled in the future except job runs.
  - Why: Deterministic time; the expiry job is driven by explicit advances.
- Money is USD in cents; no payments, delivery or ingredients are modelled.
  - Why: Request gives no detail; pickup-only bakery is the simplest reading.
- Ready orders are held for 2 days before auto-cancellation.
  - Why: Typical bakery freshness policy; request is silent.

## Out of scope

- Payments, refunds and invoicing
  - Why: Not requested; adds a second domain.
- Ingredient inventory and recipes
  - Why: Request only asks for a bakery app; product stock is enough.
- Delivery and a customer-facing UI
  - Why: Control is through API records only.

## Changes

None. The plan changes no existing item.
