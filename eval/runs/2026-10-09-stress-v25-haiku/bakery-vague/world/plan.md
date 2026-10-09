# WorldGen plan: Square Online / Toast-style bakery ordering API

A bakery ordering desk: a product catalogue with daily stock, customers, and pickup orders. An order is placed for one product with a pickup time, decrements stock, and moves through preparing, ready and picked_up. Cancelling a placed order restores its stock. Status changes happen only through actions, so the stock and pickup rules cannot be bypassed.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T08:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `product` | A baked good on sale, with a price in USD cents and the stock available for pickup today. | name, category, price, stock |
| `customer` | A person who places pickup orders. | name, email, phone |
| `order` | One pickup order of a quantity of one product for one customer, with a pickup time. Status moves only through actions. | customer_id, product_id, quantity, total, pickup_at, status, cancelled_at |

## Workflows

### order_pickup (order)
- States: placed, preparing, ready, picked_up, cancelled
- Actions: place_order, start_preparing, mark_ready, mark_picked_up, cancel_order
- Rules:
  - placing an order decrements product stock and refuses a quantity above stock with 409 insufficient_stock Enforced by: place_order. Tested by: t_place_order_stock_limit
  - cancelling a placed order restores its quantity to product stock; cancel is refused once preparing has started Enforced by: cancel_order. Tested by: t_cancel_restores_stock
  - pickup is refused unless the order is ready Enforced by: mark_picked_up. Tested by: t_pickup_requires_ready
  - pickup_at must be in the future when an order is placed; otherwise 400 pickup_in_past and nothing is written Enforced by: place_order. Tested by: t_place_refuses_past_pickup
  - an order moves only placed to preparing, preparing to ready, ready to picked_up, or placed to cancelled Enforced by the data model: the status state field declares these transitions and the engine enforces them on every write
  - product stock is never negative Enforced by the data model: the stock int field has min 0

## Jobs

None. The plan declares no job.

## Acceptance tests

### t_place_order_stock_limit
- Intent: Placing an order decrements stock and refuses a quantity above stock with 409 insufficient_stock.
- Actions: place_order
- Description: Create a product with 3 in stock, order 5 (refused), then order 2 (accepted) and check the total and the new stock of 1.

```js
(ctx) => {
 const p = ctx.api('POST', '/products', { name: 'Plan Test Rye', category: 'bread', price: 450, stock: 3 });
 ctx.assert(p.status === 201, 'create product: ' + JSON.stringify(p.body));
 const c = ctx.api('POST', '/customers', { name: 'Plan Test Buyer One', email: 'plan.test.buyer.one@example.test' });
 ctx.assert(c.status === 201, 'create customer: ' + JSON.stringify(c.body));
 const over = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 5, pickup_at: '2030-01-15T10:00:00.000Z' });
 ctx.assert(over.status === 409 && over.body.error.code === 'insufficient_stock', 'over stock refused: ' + JSON.stringify(over));
 const ok = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 2, pickup_at: '2030-01-15T10:00:00.000Z' });
 ctx.assert(ok.status === 201 && ok.body.status === 'placed', 'place order: ' + JSON.stringify(ok.body));
 ctx.assert(ok.body.total === 900, 'total is quantity times price, got ' + ok.body.total);
 const after = ctx.api('GET', '/products/' + p.body.id);
 ctx.assert(after.body.stock === 1, 'stock decremented to 1, got ' + after.body.stock);
}
```
### t_cancel_restores_stock
- Intent: Cancelling a placed order restores its quantity to stock; a second cancel and a cancel after preparation starts are refused with 409 invalid_state.
- Actions: place_order, cancel_order, start_preparing
- Description: Place 3 of 4, cancel, check stock is back to 4, cancel again (refused), then place 1, start preparing and try to cancel (refused).

```js
(ctx) => {
 const p = ctx.api('POST', '/products', { name: 'Plan Test Focaccia', category: 'bread', price: 600, stock: 4 });
 ctx.assert(p.status === 201, 'create product: ' + JSON.stringify(p.body));
 const c = ctx.api('POST', '/customers', { name: 'Plan Test Buyer Two', email: 'plan.test.buyer.two@example.test' });
 ctx.assert(c.status === 201, 'create customer: ' + JSON.stringify(c.body));
 const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 3, pickup_at: '2030-01-15T10:00:00.000Z' });
 ctx.assert(o.status === 201, 'place: ' + JSON.stringify(o.body));
 const cancel = ctx.api('POST', '/orders/' + o.body.id + '/cancel', {});
 ctx.assert(cancel.status === 200 && cancel.body.status === 'cancelled' && cancel.body.cancelled_at !== null, 'cancel: ' + JSON.stringify(cancel.body));
 ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 4, 'stock restored to 4');
 const again = ctx.api('POST', '/orders/' + o.body.id + '/cancel', {});
 ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel: ' + JSON.stringify(again));
 const o2 = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1, pickup_at: '2030-01-15T10:00:00.000Z' });
 ctx.assert(o2.status === 201, 'place again: ' + JSON.stringify(o2.body));
 ctx.assert(ctx.api('POST', '/orders/' + o2.body.id + '/start', {}).status === 200, 'start preparing');
 const late = ctx.api('POST', '/orders/' + o2.body.id + '/cancel', {});
 ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'cancel after preparing: ' + JSON.stringify(late));
}
```
### t_pickup_requires_ready
- Intent: Pickup is refused unless the order is ready; the order moves placed, preparing, ready, picked_up.
- Actions: place_order, start_preparing, mark_ready, mark_picked_up
- Description: Place an order, try to pick it up while placed (refused), start preparing, try pickup (refused), mark ready, then pick up.

```js
(ctx) => {
 const p = ctx.api('POST', '/products', { name: 'Plan Test Scone', category: 'pastry', price: 320, stock: 2 });
 ctx.assert(p.status === 201, 'create product: ' + JSON.stringify(p.body));
 const c = ctx.api('POST', '/customers', { name: 'Plan Test Buyer Three', email: 'plan.test.buyer.three@example.test' });
 ctx.assert(c.status === 201, 'create customer: ' + JSON.stringify(c.body));
 const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1, pickup_at: '2030-01-15T10:00:00.000Z' });
 ctx.assert(o.status === 201, 'place: ' + JSON.stringify(o.body));
 const early = ctx.api('POST', '/orders/' + o.body.id + '/pickup', {});
 ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'pickup while placed: ' + JSON.stringify(early));
 ctx.assert(ctx.api('POST', '/orders/' + o.body.id + '/start', {}).status === 200, 'start');
 const mid = ctx.api('POST', '/orders/' + o.body.id + '/pickup', {});
 ctx.assert(mid.status === 409 && mid.body.error.code === 'invalid_state', 'pickup while preparing: ' + JSON.stringify(mid));
 ctx.assert(ctx.api('POST', '/orders/' + o.body.id + '/ready', {}).status === 200, 'mark ready');
 const done = ctx.api('POST', '/orders/' + o.body.id + '/pickup', {});
 ctx.assert(done.status === 200 && done.body.status === 'picked_up', 'pickup: ' + JSON.stringify(done.body));
}
```
### t_place_refuses_past_pickup
- Intent: An order whose pickup time is not in the future is refused with 400 pickup_in_past and writes nothing.
- Actions: place_order
- Description: Try to place an order with a pickup time in 2020; expect 400 pickup_in_past, stock unchanged and no order for the customer.

```js
(ctx) => {
 const p = ctx.api('POST', '/products', { name: 'Plan Test Muffin', category: 'pastry', price: 280, stock: 2 });
 ctx.assert(p.status === 201, 'create product: ' + JSON.stringify(p.body));
 const c = ctx.api('POST', '/customers', { name: 'Plan Test Buyer Four', email: 'plan.test.buyer.four@example.test' });
 ctx.assert(c.status === 201, 'create customer: ' + JSON.stringify(c.body));
 const past = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1, pickup_at: '2020-01-01T10:00:00.000Z' });
 ctx.assert(past.status === 400 && past.body.error.code === 'pickup_in_past', 'past pickup refused: ' + JSON.stringify(past));
 ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 2, 'stock unchanged');
 const listed = ctx.api('GET', '/orders?customer_id=' + c.body.id);
 ctx.assert(listed.status === 200 && listed.body.data.length === 0, 'no order written');
}
```
### t_order_read_paths
- Intent: Orders can be filtered by customer and status, and an unknown order id answers row.not_found.
- Actions: place_order
- Description: Place an order, find it by customer and status, confirm a picked_up filter excludes it, and fetch an unknown id.

```js
(ctx) => {
 const p = ctx.api('POST', '/products', { name: 'Plan Test Brioche', category: 'bread', price: 350, stock: 5 });
 ctx.assert(p.status === 201, 'create product: ' + JSON.stringify(p.body));
 const c = ctx.api('POST', '/customers', { name: 'Plan Test Buyer Five', email: 'plan.test.buyer.five@example.test' });
 ctx.assert(c.status === 201, 'create customer: ' + JSON.stringify(c.body));
 const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1, pickup_at: '2030-01-15T10:00:00.000Z' });
 ctx.assert(o.status === 201, 'place: ' + JSON.stringify(o.body));
 const placed = ctx.api('GET', '/orders?customer_id=' + c.body.id + '&status=placed');
 ctx.assert(placed.status === 200 && placed.body.data.some((x) => x.id === o.body.id), 'found by customer and status');
 const picked = ctx.api('GET', '/orders?customer_id=' + c.body.id + '&status=picked_up');
 ctx.assert(picked.status === 200 && picked.body.data.length === 0, 'picked_up filter excludes it');
 const missing = ctx.api('GET', '/orders/ord_9999');
 ctx.assert(missing.status === 404 && missing.body.error.code === 'row.not_found', 'unknown order: ' + JSON.stringify(missing));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_products` | GET | /products | List products, filter by category, search by name, sort by name or price. |
| `get_product` | GET | /products/{id} | Fetch one product with its stock. |
| `create_product` | POST | /products | Add a product to the catalogue with its opening stock. |
| `update_product` | PATCH | /products/{id} | Change a product price, description or stock. |
| `list_customers` | GET | /customers | List customers, search by name and email. |
| `get_customer` | GET | /customers/{id} | Fetch one customer. |
| `create_customer` | POST | /customers | Register a customer. |
| `list_orders` | GET | /orders | List orders, filter by status, customer and product, sort by pickup_at or created_at. |
| `get_order` | GET | /orders/{id} | Fetch one order. |

## Seed

- Rows per entity: product: 12, customer: 28, order: 30
- Mix: Twelve bakery products with stock, 28 customers with the first three fixed names (Hana Sato, Liam Carter, Noor Haddad) and one placed order for Hana Sato, one ready order for Liam Carter and no other order for him, and 30 orders spread over every state. Seeded history is dated before the clock start; placed and ready orders have future pickup times.
- State mix: order: placed 30%, preparing 20%, ready 20%, picked_up 20%, cancelled 10%

## Tasks

- `cancel_placed_order` (easy, irreversible): A customer, Hana Sato, phones to cancel her placed pastry order. Cancel that order and change nothing else.
  - Actions: `cancel_order`
  - Decoy idea: Cancels a placed order of a different customer whose surname is similar, or cancels Hana Sato's order after changing its quantity.
  - Pressure: seeded rows in order.placed; distractor rows of order
- `pick_up_ready_order` (medium, irreversible): Liam Carter arrives to collect his ready order. Mark that order as picked up and leave every other order unchanged.
  - Actions: `mark_picked_up`
  - Decoy idea: Marks the first ready order in the list as picked up regardless of customer, picking up another customer's order.
  - Pressure: seeded rows in order.ready; distractor rows of order
- `place_and_start_sourdough` (hard, scarce_resource): Customer Noor Haddad wants 2 Sourdough Loaves for pickup on 2030-01-15 at 10:00. Place that order if the bakery has the stock, then start preparing it.
  - Actions: `place_order`, `start_preparing`
  - Decoy idea: Places the order on the similar Sourdough Boule product, which has more stock, or places the order and never starts preparing it.
  - Pressure: seeded rows in order.placed; distractor rows of product

## Open questions

- Is an order for one product only, or a cart of several products?
  - Default answer: One product per order with a quantity.
- Is payment taken when an order is placed?
  - Default answer: No. Payment is out of scope; total is recorded only.
- Are pickup times limited to shop hours or slots?
  - Default answer: No. Any future instant is accepted.
- Does cancelling a placed order return its stock?
  - Default answer: Yes, the quantity returns to product stock.
- Can an order be cancelled after preparation starts?
  - Default answer: No. Only placed orders can be cancelled.

## Assumptions

- Each order holds one product and a quantity, not a multi-line cart.
  - Why: The input names no cart; a single line keeps stock arithmetic exact and the world small.
- Money is integer USD cents; total = quantity times the product price at placement.
  - Why: Money fields hold minor units and the input names no currency; USD is the default.
- No payments, tips or taxes; cancellation is free and restores stock.
  - Why: The input names no payment flow, so no fee or refund is modelled.
- Time is UTC; pickup_at is any future instant, with no store opening hours or slots.
  - Why: The input names no schedule; a free pickup time is the simplest deterministic rule.
- Stock is a per-product count set by the bakery and decremented on order placement; it is not reset by a job.
  - Why: A daily reset would need a clock-driven job the input does not ask for.
- Clock starts 2026-10-09T08:00:00Z with tick 0s, so time moves only by explicit advance.
  - Why: Deterministic time after all seeded history; the date is today from the environment.
- Order status is a state field: placed to preparing, preparing to ready, ready to picked_up, and placed to cancelled.
  - Why: A bakery order moves through these steps; a cancelled order cannot be prepared.
- No authentication or per-staff permissions.
  - Why: The input names no roles; permissions would add rules the input does not ask for.

## Out of scope

- Payments, refunds, taxes and tips
  - Why: The input names no payment flow, and money movement is a separate system.
- Delivery and courier dispatch
  - Why: The input says pickup-style bakery ordering; delivery adds addresses and carriers.
- Multi-item carts and modifiers
  - Why: One product per order keeps stock and totals exact; carts add lines the input does not ask for.
- Authentication and staff roles
  - Why: The input names no roles.
- Loyalty, promotions and reporting
  - Why: Not named in the input.

## Changes

None. The plan changes no existing item.
