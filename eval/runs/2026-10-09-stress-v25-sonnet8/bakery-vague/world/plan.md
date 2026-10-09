# WorldGen plan: Bakery order and pickup system (Square for Restaurants / Toast-style bakery ordering)

A bakery sells products with limited daily stock. Customers place pickup orders that reserve stock; staff move orders through production, ready and pickup. Cancelling a placed order restores stock, and ready orders not collected within 24 hours expire.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T08:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `product` | A bakery item for sale (bread, pastry, cake) with price and stock on hand. | name, sku, category, price, stock |
| `customer` | A person who orders for pickup. | name, email, phone |
| `bakery_order` | A pickup order of one quantity of one product by a customer; moves through a fulfillment state machine. | customer_id, product_id, quantity, total, pickup_date, status, ready_at |

## Workflows

### order_fulfillment (bakery_order)
- States: placed, in_production, ready, picked_up, cancelled, expired
- Actions: place_order, start_production, mark_ready, pick_up, cancel_order, restock_product
- Rules:
  - Placing an order requires enough stock; it reserves the quantity (decrements stock) and computes total = price x quantity. Insufficient stock is refused with 409 insufficient_stock. Enforced by: place_order. Tested by: t_place_stock
  - Only a placed order can be cancelled; cancelling restores the reserved stock. Other states are refused with 409 invalid_state. Enforced by: cancel_order. Tested by: t_cancel
  - Orders move placed -> in_production -> ready -> picked_up in order only; out-of-sequence steps are refused with 409 invalid_state and marking ready stamps ready_at. Enforced by: start_production, mark_ready, pick_up. Tested by: t_flow
  - A ready order not picked up within 24 hours becomes expired (stock is not restored because the goods are perishable). Enforced by: expire_ready_orders. Tested by: t_expire
  - Restocking adds a positive quantity to a product's stock; stock changes only through restock and orders. Enforced by: restock_product. Tested by: t_restock
  - Product sku is unique. Enforced by the data model: sku is a unique string field on product.

## Jobs

- `expire_ready_orders` runs every 1h: Every hour, each ready order whose ready_at is 24 hours or more in the past becomes expired.

## Acceptance tests

### t_place_stock
- Intent: place_order reserves stock, computes total, refuses insufficient stock
- Actions: place_order, restock_product
- Description: Create a product, restock 5, order 2 (stock 3, total computed), order 4 refused with insufficient_stock, stock unchanged.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Baguette A', sku: 'TST-PLACE-1', category: 'bread', price: 350 });
  ctx.assert(p.status === 201, 'create product: ' + JSON.stringify(p.body));
  const rs = ctx.api('POST', '/products/' + p.body.id + '/restock', { quantity: 5 });
  ctx.assert(rs.status === 200 && rs.body.stock === 5, 'restock: ' + JSON.stringify(rs.body));
  const c = ctx.api('POST', '/customers', { name: 'Place Tester', email: 'place.tester@example.com' });
  ctx.assert(c.status === 201, 'create customer: ' + JSON.stringify(c.body));
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 2, pickup_date: '2026-10-12' });
  ctx.assert(o.status === 201 && o.body.status === 'placed' && o.body.total === 700, 'place: ' + JSON.stringify(o.body));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 3, 'stock reserved');
  const big = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 4, pickup_date: '2026-10-12' });
  ctx.assert(big.status === 409 && big.body.error.code === 'insufficient_stock', 'insufficient: ' + JSON.stringify(big));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 3, 'stock unchanged after refusal');
}
```
### t_cancel
- Intent: cancel_order only from placed and restores stock
- Actions: cancel_order, place_order, restock_product, start_production
- Description: Cancel a placed order restores stock; second cancel and cancel of an in-production order are refused.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Croissant B', sku: 'TST-CANCEL-1', category: 'pastry', price: 300 });
  ctx.api('POST', '/products/' + p.body.id + '/restock', { quantity: 5 });
  const c = ctx.api('POST', '/customers', { name: 'Cancel Tester', email: 'cancel.tester@example.com' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 2, pickup_date: '2026-10-12' });
  ctx.assert(o.status === 201, 'place: ' + JSON.stringify(o.body));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 3, 'reserved');
  const x = ctx.api('POST', '/orders/' + o.body.id + '/cancel', {});
  ctx.assert(x.status === 200 && x.body.status === 'cancelled', 'cancel: ' + JSON.stringify(x.body));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 5, 'stock restored');
  const again = ctx.api('POST', '/orders/' + o.body.id + '/cancel', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel: ' + JSON.stringify(again));
  const o2 = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1, pickup_date: '2026-10-12' });
  ctx.assert(ctx.api('POST', '/orders/' + o2.body.id + '/start_production', {}).status === 200, 'start');
  const late = ctx.api('POST', '/orders/' + o2.body.id + '/cancel', {});
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'cancel in production: ' + JSON.stringify(late));
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 4, 'stock not restored by refused cancel');
}
```
### t_flow
- Intent: orders follow placed -> in_production -> ready -> picked_up only
- Actions: place_order, restock_product, start_production, mark_ready, pick_up
- Description: Out-of-sequence steps are refused; the full flow stamps ready_at.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Sourdough C', sku: 'TST-FLOW-1', category: 'bread', price: 600 });
  ctx.api('POST', '/products/' + p.body.id + '/restock', { quantity: 3 });
  const c = ctx.api('POST', '/customers', { name: 'Flow Tester', email: 'flow.tester@example.com' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1, pickup_date: '2026-10-12' });
  const id = o.body.id;
  const early = ctx.api('POST', '/orders/' + id + '/mark_ready', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'ready from placed: ' + JSON.stringify(early));
  const early2 = ctx.api('POST', '/orders/' + id + '/pick_up', {});
  ctx.assert(early2.status === 409 && early2.body.error.code === 'invalid_state', 'pickup from placed: ' + JSON.stringify(early2));
  const s = ctx.api('POST', '/orders/' + id + '/start_production', {});
  ctx.assert(s.status === 200 && s.body.status === 'in_production', 'start: ' + JSON.stringify(s.body));
  const r = ctx.api('POST', '/orders/' + id + '/mark_ready', {});
  ctx.assert(r.status === 200 && r.body.status === 'ready' && r.body.ready_at !== null, 'ready: ' + JSON.stringify(r.body));
  const pk = ctx.api('POST', '/orders/' + id + '/pick_up', {});
  ctx.assert(pk.status === 200 && pk.body.status === 'picked_up', 'pickup: ' + JSON.stringify(pk.body));
  const again = ctx.api('POST', '/orders/' + id + '/pick_up', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second pickup: ' + JSON.stringify(again));
}
```
### t_expire
- Intent: uncollected ready orders expire after 24 hours
- Actions: place_order, restock_product, start_production, mark_ready
- Description: A ready order stays ready at 23h and is expired after 25h.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Eclair D', sku: 'TST-EXP-1', category: 'pastry', price: 450 });
  ctx.api('POST', '/products/' + p.body.id + '/restock', { quantity: 3 });
  const c = ctx.api('POST', '/customers', { name: 'Expire Tester', email: 'expire.tester@example.com' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, product_id: p.body.id, quantity: 1, pickup_date: '2026-10-12' });
  ctx.api('POST', '/orders/' + o.body.id + '/start_production', {});
  const r = ctx.api('POST', '/orders/' + o.body.id + '/mark_ready', {});
  ctx.assert(r.status === 200, 'ready: ' + JSON.stringify(r.body));
  ctx.advance('23h');
  ctx.assert(ctx.api('GET', '/orders/' + o.body.id).body.status === 'ready', 'still ready at 23h');
  const run = ctx.advance('2h');
  ctx.assert(run.jobsFailed.length === 0, 'no job failed');
  ctx.assert(ctx.api('GET', '/orders/' + o.body.id).body.status === 'expired', 'expired after 25h');
  ctx.assert(ctx.api('GET', '/products/' + p.body.id).body.stock === 2, 'stock not restored on expiry');
}
```
### t_restock
- Intent: restock_product adds positive quantity to stock
- Actions: restock_product
- Description: Restock accumulates; zero quantity is refused.

```js
(ctx) => {
  const p = ctx.api('POST', '/products', { name: 'Test Rye E', sku: 'TST-RESTOCK-1', category: 'bread', price: 500 });
  ctx.assert(p.status === 201 && p.body.stock === 0, 'new product has no stock: ' + JSON.stringify(p.body));
  const a = ctx.api('POST', '/products/' + p.body.id + '/restock', { quantity: 10 });
  ctx.assert(a.status === 200 && a.body.stock === 10, 'restock 10: ' + JSON.stringify(a.body));
  const b = ctx.api('POST', '/products/' + p.body.id + '/restock', { quantity: 5 });
  ctx.assert(b.status === 200 && b.body.stock === 15, 'restock 5: ' + JSON.stringify(b.body));
  const z = ctx.api('POST', '/products/' + p.body.id + '/restock', { quantity: 0 });
  ctx.assert(z.status === 400 && z.body.error.code === 'input.invalid', 'zero refused: ' + JSON.stringify(z));
  const dup = ctx.api('POST', '/products', { name: 'Test Rye Dup', sku: 'TST-RESTOCK-1', category: 'bread', price: 500 });
  ctx.assert(dup.status === 409 && dup.body.error.code === 'field.unique', 'sku unique: ' + JSON.stringify(dup));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_products` | GET | /products | List products, filter by category, sort by price or name. |
| `get_product` | GET | /products/{id} | Fetch one product. |
| `create_product` | POST | /products | Add a product (stock starts at 0). |
| `update_product` | PATCH | /products/{id} | Edit name, category or price. |
| `list_customers` | GET | /customers | List customers, search by name and email. |
| `get_customer` | GET | /customers/{id} | Fetch one customer. |
| `create_customer` | POST | /customers | Register a customer. |
| `list_orders` | GET | /orders | List orders, filter by status, customer_id, product_id, pickup_date; sort by pickup_date. |
| `get_order` | GET | /orders/{id} | Fetch one order. |
| `place_order` | POST | /orders | Built as workflow action place_order. |
| `start_production` | POST | /orders/{id}/start_production | Built as workflow action. |
| `mark_ready` | POST | /orders/{id}/mark_ready | Built as workflow action. |
| `pick_up` | POST | /orders/{id}/pick_up | Built as workflow action. |
| `cancel_order` | POST | /orders/{id}/cancel | Built as workflow action. |
| `restock_product` | POST | /products/{id}/restock | Built as workflow action. |

## Seed

- Rows per entity: product: 12, customer: 10, bakery_order: 32
- Mix: Orders spread across all six states with several customers holding multiple orders in different states; a few products low on stock; placed orders include several due on the same pickup_date; some seeded orders reference the same products.
- State mix: bakery_order: placed 30%, in_production 18%, ready 18%, picked_up 22%, cancelled 8%, expired 4%

## Tasks

- `restock_low_bread` (easy, scarce_resource): Restock the product named 'Country Sourdough' (currently low on stock) by 24 units and change nothing else.
  - Actions: `restock_product`
  - Decoy idea: Restocks the similarly named 'Seeded Sourdough' product instead.
- `cancel_customer_placed_order` (medium, irreversible): Customer Maria Lopez has several orders. Cancel only her order that is still in placed state for the 'Cinnamon Roll' product, leaving her other orders (in production, ready) untouched.
  - Actions: `cancel_order`
  - Decoy idea: Cancels a different order of hers, such as the in-production one (refused) or her placed order for another product, or cancels all her orders.
  - Pressure: seeded rows in bakery_order.placed, bakery_order.in_production, bakery_order.ready; distractor rows of bakery_order
- `prepare_saturday_orders` (hard, scarce_resource): Every placed order with pickup_date 2026-10-10 must be taken through production and marked ready, so they can be picked up tomorrow morning. Do not touch orders for other dates or in other states.
  - Actions: `start_production`, `mark_ready`
  - Decoy idea: Only processes the first page of orders, or marks ready orders of the wrong pickup date, or skips start_production.
  - Pressure: paging past the first page of bakery_order; seeded rows in bakery_order.placed; distractor rows of bakery_order

## Open questions

- Is this for in-store pickup orders or also delivery?
  - Default answer: Pickup only.
- Should orders contain multiple products?
  - Default answer: No, one product and quantity per order.
- Is inventory per day or running stock?
  - Default answer: Running stock decremented at order placement.
- How long may ready orders wait?
  - Default answer: 24 hours, then they expire.

## Assumptions

- One order holds one product and quantity.
  - Why: Action inputs are scalar, so multi-line orders would need a line-item entity; kept simple.
- Currency is USD in cents.
  - Why: No currency specified.
- Clock starts 2026-10-09T08:00:00Z with tick 0s; seeded history is before it, pickup dates are future.
  - Why: Deterministic time; explicit advances only.
- Stock is reserved at order placement and restored only on cancel; expired orders do not restore stock.
  - Why: Perishable goods; simple inventory model.
- No payments, delivery or ingredient inventory.
  - Why: Request just says an app for a bakery; ordering and pickup is the core stateful flow.
- Stock and status are readonly and change only through actions.
  - Why: Rules cannot be bypassed via PATCH.

## Out of scope

- Payments and refunds
  - Why: Not specified; keeps the world focused on fulfillment.
- Delivery, recipes, ingredient inventory, staff scheduling
  - Why: Beyond a minimal bakery order desk.
- Multi-item orders
  - Why: Would require line items; simplified.

## Changes

None. The plan changes no existing item.
