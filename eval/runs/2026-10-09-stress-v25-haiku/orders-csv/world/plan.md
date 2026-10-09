# WorldGen plan: Shopify-style order management API (orders and customers)

An orders API where agents read customers and orders, and move orders through a fixed fulfilment lifecycle (pending, paid, shipped, delivered, with cancelled and refunded as end states). Core value is stateful order records changed through actions, so the world is feasible. Both CSV tables are imported exactly: 18 customers and 72 orders. Only the five order actions and the standard CRUD and list routes are built.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-04-08T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A buyer who places orders. Imported from the customers CSV table, 18 rows, ids kept as in the CSV. | id, email |
| `order` | A purchase by one customer. Imported from the orders CSV table, 72 rows. status is a state field moved only by the workflow actions. | id, customer_id, status, placed_at |

## Workflows

### order_lifecycle (order)
- States: pending, paid, shipped, delivered, cancelled, refunded
- Actions: pay_order, ship_order, deliver_order, cancel_order, refund_order
- Rules:
  - An order moves pending to paid, paid to shipped and shipped to delivered only through pay_order, ship_order and deliver_order, and ship_order sets shipped_at Enforced by: pay_order, ship_order, deliver_order. Tested by: t_pay_ship_deliver
  - ship_order refuses an order that is not paid with 409 invalid_state Enforced by: ship_order. Tested by: t_ship_requires_paid
  - cancel_order cancels only pending or paid orders; shipped, delivered, cancelled and refunded orders are refused with 409 invalid_state Enforced by: cancel_order. Tested by: t_cancel_only_before_shipping
  - refund_order refunds only paid, shipped or delivered orders as a full refund; refunded and cancelled orders are final Enforced by: refund_order. Tested by: t_refund_only_after_payment
  - status cannot be set through create or PATCH; only the five actions move it Enforced by the data model: status is a readonly state field, so standard create and update refuse it with field.readonly
  - total_cents is a non-negative amount in USD minor units Enforced by the data model: money field in USD with min 0
  - customer_id names an existing customer Enforced by the data model: ref field to customer, so a write with an unknown id fails with ref.unresolved
  - list_orders and list_customer_orders return only rows matching the status and customer_id filters, and every row of the customer's orders is listed across pages

## Jobs

None. The plan declares no job.

## Acceptance tests

### t_pay_ship_deliver
- Intent: An order moves pending, paid, shipped, delivered only through pay, ship and deliver, and ship sets shipped_at.
- Actions: pay_order, ship_order, deliver_order
- Description: Create a customer and an order, then pay, ship and deliver it, checking each status.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'QA Buyer One', email: 'qa-pay-ship@example.test', country: 'GB', plan: 'pro' });
  ctx.assert(c.status === 201, 'create customer returned ' + c.status);
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 2500, currency: 'USD', item_count: 2 });
  ctx.assert(o.status === 201 && o.body.status === 'pending', 'new order is pending, got ' + o.status + ' ' + JSON.stringify(o.body));
  const p = ctx.api('POST', '/orders/' + o.body.id + '/pay');
  ctx.assert(p.status === 200 && p.body.status === 'paid', 'pay returned ' + p.status + ' ' + JSON.stringify(p.body));
  const s = ctx.api('POST', '/orders/' + o.body.id + '/ship');
  ctx.assert(s.status === 200 && s.body.status === 'shipped' && s.body.shipped_at !== null, 'ship returned ' + s.status + ' ' + JSON.stringify(s.body));
  const d = ctx.api('POST', '/orders/' + o.body.id + '/deliver');
  ctx.assert(d.status === 200 && d.body.status === 'delivered', 'deliver returned ' + d.status + ' ' + JSON.stringify(d.body));
}
```
### t_ship_requires_paid
- Intent: ship_order refuses an order that is not paid with 409 invalid_state, and succeeds after payment.
- Actions: ship_order, pay_order
- Description: Shipping a pending order is refused, and the same order ships after it is paid.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'QA Buyer Two', email: 'qa-ship-gate@example.test', country: 'GB', plan: 'basic' });
  ctx.assert(c.status === 201, 'create customer returned ' + c.status);
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 900, currency: 'USD', item_count: 1 });
  ctx.assert(o.status === 201, 'create order returned ' + o.status);
  const early = ctx.api('POST', '/orders/' + o.body.id + '/ship');
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'ship before pay: ' + early.status + ' ' + JSON.stringify(early.body));
  const p = ctx.api('POST', '/orders/' + o.body.id + '/pay');
  ctx.assert(p.status === 200, 'pay returned ' + p.status);
  const ok = ctx.api('POST', '/orders/' + o.body.id + '/ship');
  ctx.assert(ok.status === 200 && ok.body.status === 'shipped', 'ship after pay returned ' + ok.status + ' ' + JSON.stringify(ok.body));
}
```
### t_cancel_only_before_shipping
- Intent: cancel_order cancels pending or paid orders and refuses shipped or already cancelled orders with 409 invalid_state.
- Actions: cancel_order, pay_order, ship_order
- Description: A pending order cancels once; a second cancel and a cancel after shipping are both refused.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'QA Buyer Three', email: 'qa-cancel@example.test', country: 'GB', plan: 'pro' });
  ctx.assert(c.status === 201, 'create customer returned ' + c.status);
  const a = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 1200, currency: 'USD', item_count: 1 });
  ctx.assert(a.status === 201, 'create order A returned ' + a.status);
  const cancelled = ctx.api('POST', '/orders/' + a.body.id + '/cancel');
  ctx.assert(cancelled.status === 200 && cancelled.body.status === 'cancelled', 'cancel pending returned ' + cancelled.status + ' ' + JSON.stringify(cancelled.body));
  const again = ctx.api('POST', '/orders/' + a.body.id + '/cancel');
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel: ' + again.status + ' ' + JSON.stringify(again.body));
  const b = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 1200, currency: 'USD', item_count: 1 });
  ctx.assert(b.status === 201, 'create order B returned ' + b.status);
  ctx.assert(ctx.api('POST', '/orders/' + b.body.id + '/pay').status === 200, 'pay B');
  ctx.assert(ctx.api('POST', '/orders/' + b.body.id + '/ship').status === 200, 'ship B');
  const late = ctx.api('POST', '/orders/' + b.body.id + '/cancel');
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'cancel after shipping: ' + late.status + ' ' + JSON.stringify(late.body));
  const still = ctx.api('GET', '/orders/' + b.body.id);
  ctx.assert(still.body.status === 'shipped', 'shipped order kept its status, got ' + still.body.status);
}
```
### t_refund_only_after_payment
- Intent: refund_order refunds only paid, shipped or delivered orders; refunded and cancelled orders are final.
- Actions: refund_order, pay_order, cancel_order
- Description: Refunding a pending order is refused, a paid order refunds once, and a refunded order cannot be cancelled.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'QA Buyer Four', email: 'qa-refund@example.test', country: 'GB', plan: 'standard' });
  ctx.assert(c.status === 201, 'create customer returned ' + c.status);
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 3300, currency: 'USD', item_count: 3 });
  ctx.assert(o.status === 201, 'create order returned ' + o.status);
  const early = ctx.api('POST', '/orders/' + o.body.id + '/refund');
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'refund pending: ' + early.status + ' ' + JSON.stringify(early.body));
  ctx.assert(ctx.api('POST', '/orders/' + o.body.id + '/pay').status === 200, 'pay');
  const r = ctx.api('POST', '/orders/' + o.body.id + '/refund');
  ctx.assert(r.status === 200 && r.body.status === 'refunded', 'refund paid returned ' + r.status + ' ' + JSON.stringify(r.body));
  const twice = ctx.api('POST', '/orders/' + o.body.id + '/refund');
  ctx.assert(twice.status === 409 && twice.body.error.code === 'invalid_state', 'refund twice: ' + twice.status);
  const cancel = ctx.api('POST', '/orders/' + o.body.id + '/cancel');
  ctx.assert(cancel.status === 409 && cancel.body.error.code === 'invalid_state', 'cancel refunded: ' + cancel.status);
}
```
### t_customer_orders_listed
- Intent: The status filter on a customer's orders returns only rows in that status, and the customer's order list returns every order the customer placed.
- Actions: pay_order
- Description: Two orders for a new customer; paying one lets the status-filtered list return only it, while the unfiltered list returns both.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'QA Buyer Five', email: 'qa-list@example.test', country: 'GB', plan: 'pro' });
  ctx.assert(c.status === 201, 'create customer returned ' + c.status);
  const o1 = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 700, currency: 'USD', item_count: 1 });
  const o2 = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 800, currency: 'USD', item_count: 1 });
  ctx.assert(o1.status === 201 && o2.status === 201, 'create orders');
  ctx.assert(ctx.api('POST', '/orders/' + o1.body.id + '/pay').status === 200, 'pay o1');
  const paid = ctx.api('GET', '/customers/' + c.body.id + '/orders?status=paid');
  ctx.assert(paid.status === 200 && paid.body.data.length === 1 && paid.body.data[0].id === o1.body.id, 'paid filter: ' + JSON.stringify(paid.body));
  const all = ctx.api('GET', '/orders?customer_id=' + c.body.id);
  ctx.assert(all.status === 200 && all.body.data.length === 2, 'unfiltered list returns both orders, got ' + JSON.stringify(all.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_orders` | GET | /orders | List orders, filter by status and customer_id, sort by placed_at or total_cents, 25 per page. |
| `get_order` | GET | /orders/{id} | Read one order. |
| `create_order` | POST | /orders | Place a new order for an existing customer. It starts in pending. |
| `update_order` | PATCH | /orders/{id} | Edit order details such as note and item_count. status is readonly here, so only actions move it. |
| `list_customer_orders` | GET | /customers/{customer_id}/orders | List one customer's orders, filter by status. |
| `list_customers` | GET | /customers | List customers, filter by plan and country, search name and email, sort by name. |
| `get_customer` | GET | /customers/{id} | Read one customer. |
| `create_customer` | POST | /customers | Create a customer with a unique email. |
| `update_customer` | PATCH | /customers/{id} | Edit a customer's details. |

## Seed

- Rows per entity: customer: 18, order: 72
- Mix: Both entities come from the imported CSV tables, so the seed copies every fixture row in CSV order and generates no rows. Customers keep their CSV ids cus_0001 to cus_0018 and orders keep ord_0001 to ord_0072, so order.customer_id resolves.
- State mix: order: pending 19.4%, paid 16.7%, shipped 19.4%, delivered 25%, cancelled 11.1%, refunded 8.3%

## Tasks

- `ship_latest_paid_order` (easy): Ship the most recently placed paid order of customer Ada Lovelace, changing nothing else.
  - Actions: `ship_order`
  - Decoy idea: ships the oldest paid order of that customer instead of the newest
  - Pressure: seeded rows in order.paid; distractor rows of order
- `refund_damaged_delivery` (medium, irreversible): Ada Lovelace reports that a delivered order arrived damaged. Refund her most recently placed delivered order and change nothing else. The refund is final, so check the order is delivered first.
  - Actions: `refund_order`
  - Decoy idea: refunds the oldest delivered order of the customer instead of the most recent one, and also cancels another order as collateral
  - Pressure: seeded rows in order.delivered; distractor rows of order
- `pay_and_ship_early_pending` (hard): Every pending order placed before 1 March 2026 has been paid by its customer. Mark each such order paid, then ship it. Change nothing else. The targets sit beyond the first page of pending orders.
  - Actions: `pay_order`, `ship_order`
  - Decoy idea: pays the target orders but never ships them, reading only page one of pending orders
  - Pressure: paging past the first page of order; seeded rows in order.pending; distractor rows of order

## Open questions

- Should refunds be partial, with an amount?
  - Default answer: No. refund_order is a full refund of the order.
- Does shipping need a carrier or tracking number?
  - Default answer: No. ship_order sets status to shipped and shipped_at to now.
- Can an order be cancelled after payment?
  - Default answer: Yes, from pending or paid. Shipped, delivered, cancelled and refunded orders cannot be cancelled.
- Can a customer be deleted?
  - Default answer: No delete route. Orders hold restrict references to customers.
- Is the CSV id the engine id?
  - Default answer: Yes. The seed keeps CSV order so cus_0001 to cus_0018 and ord_0001 to ord_0072 line up.
- Is the note visible to customers?
  - Default answer: It is a plain nullable text field with no visibility rule.
- What is the real per-status count of the orders CSV?
  - Default answer: Use the stateMix estimate {pending 19.4, paid 16.7, shipped 19.4, delivered 25.0, cancelled 11.1, refunded 8.3}, derived from the shipped_at null rate. The CSV counts must be checked against it, since the seed fails if any state is more than 10 points off.

## Assumptions

- clock.start is 2026-04-08T09:00:00.000Z and clock.tick is 0s.
  - Why: The latest imported timestamp is shipped_at 2026-04-07T14:00Z, so the start must follow it. A zero tick keeps time explicit, so shipped_at and tests are deterministic.
- Both tables are fixtures, so the seed copies them exactly and generates no rows. Customers and orders keep the CSV ids in CSV order.
  - Why: The plan rule for imported CSV tables keeps their rows and values exact, and CSV order gives cus_0001 to cus_0018 and ord_0001 to ord_0072, which the ref values depend on.
- seed.stateMix.order is {pending 19.4, paid 16.7, shipped 19.4, delivered 25.0, cancelled 11.1, refunded 8.3}, an estimate that sums to 100.
  - Why: The engine needs a planned mix for order, but the input gives only the distinct count (6) and no per-state counts. The shipped_at null rate of 0.56 means about 32 of 72 rows have shipped_at, which matches shipped plus delivered (19.4 + 25.0 = 44.4%). The other four states split the remaining 56% by a plausible lifecycle, and the mix is flagged as an open question for a human to confirm against the CSV.
- order.status is a state field with states pending, paid, shipped, delivered, cancelled and refunded, initial pending, and transitions pending to paid or cancelled, paid to shipped, cancelled or refunded, shipped to delivered or refunded, delivered to refunded, and cancelled and refunded final.
  - Why: These are the six CSV statuses. Transitions follow the order lifecycle implied by the actions and the timestamps, and they keep every state reachable from pending.
- status is readonly, so create and PATCH cannot set it and only the five actions move it.
  - Why: Otherwise a PATCH could skip the transition rules and the actions' checks.
- Actions take no input. pay_order, ship_order, deliver_order, cancel_order and refund_order each read the order id from the path and check the state.
  - Why: The input does not require reasons or tracking numbers, and no input is needed to drive the lifecycle. Adding inputs would require a design decision the request does not make.
- ship_order sets shipped_at to engine time. pay_order and deliver_order set no other timestamp. cancel_order and refund_order set none.
  - Why: shipped_at is the only timestamp in the CSV that tracks fulfilment. The others keep the model small.
- cancel_order is allowed only from pending or paid. refund_order is allowed only from paid, shipped or delivered, and it is a full refund.
  - Why: Shipped orders cannot be cancelled, and the request asks for refunds only in the paid-or-later states. Partial refunds need an amount input that the request does not give.
- Action errors use ctx.fail with 409 invalid_state for a refused transition and 404 not_found for a missing order.
  - Why: These are the codes the plan names for action refusals. Standard routes keep the engine codes.
- note is a nullable text field, not an enum.
  - Why: Its CSV values contain commas and quotes, and a text field stores them as they are.
- total_cents is a money field in USD with min 0. currency is an enum with the single value USD.
  - Why: The CSV holds integer minor units and one currency.
- customer.email is unique and must be an email format.
  - Why: The CSV has 18 distinct emails for 18 customers, and unique emails are what a customer lookup relies on.
- Search parameter is q.
  - Why: The list route search uses the default q parameter, which the plan does not rename.
- Acceptance tests create their own customers with labelled emails that the CSV does not use, such as qa-pay-ship@example.test.
  - Why: Tests must not depend on seed rows, and the labelled emails avoid collisions with the seed.

## Out of scope

- Payment processing, gateways and card charges
  - Why: pay_order marks the state only; the request does not ask for a payments system, and modelling one would be a separate product.
- Carrier tracking numbers and fulfilment entities
  - Why: The CSV has no tracking data, and ship_order sets shipped_at only.
- Partial refunds and order line items
  - Why: The CSV has item_count only, and a partial refund needs an amount the request does not give.
- Customer deletion and a delete route for orders
  - Why: The request does not ask for deletion, and the restrict foreign key would make it a separate design.
- Order event audit trail
  - Why: It would need generated rows for 72 orders with timing rules; the request is about orders and customers.
- Scheduled jobs such as auto-cancelling stale pending orders
  - Why: A job that changes pending orders on the clock would change rows the tasks grade, and the request does not ask for automation.
- Multi-currency and conversion
  - Why: The CSV holds USD only.

## Changes

None. The plan changes no existing item.
