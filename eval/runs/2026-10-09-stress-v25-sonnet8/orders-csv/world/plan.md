# WorldGen plan: Shopify-style order desk (orders and customers admin API)

An order desk where customers' orders move from pending through paid, shipped and delivered, or end cancelled or refunded. Agents read orders and customers and run the fulfilment actions. The orders and customers CSV tables are kept exactly.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-04-08T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A buyer, imported from the customers CSV (18 rows). | name, email, country, plan |
| `order` | A customer order, imported from the orders CSV (72 rows), with a status state machine. | customer_id, status, total_cents, currency, item_count, placed_at, shipped_at, note |

## Workflows

### order_fulfilment (order)
- States: pending, paid, shipped, delivered, cancelled, refunded
- Actions: pay_order, ship_order, deliver_order, cancel_order, refund_order
- Rules:
  - Only a pending order can be paid. Enforced by: pay_order. Tested by: pay_order_flow
  - Only a paid order can be shipped, and shipping sets shipped_at. Enforced by: ship_order. Tested by: ship_order_flow
  - Only a shipped order can be delivered. Enforced by: deliver_order. Tested by: deliver_order_flow
  - Only a pending or paid order can be cancelled. A shipped order cannot. Enforced by: cancel_order. Tested by: cancel_order_flow
  - Only a paid or delivered order can be refunded. Refund is final. Enforced by: refund_order. Tested by: refund_order_flow
  - total_cents is not negative and customer emails are unique. Enforced by the data model: min 0 on the money field and unique on the email field are enforced by the data model.

## Jobs

None. The plan declares no job.

## Acceptance tests

### pay_order_flow
- Intent: pay_order moves a pending order to paid and refuses a second payment.
- Actions: pay_order
- Description: Create a customer and an order, pay it, then pay again.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Pay Tester', email: 'pay.tester@payflow.test', country: 'GB', plan: 'pro' });
  ctx.assert(c.status === 201, 'create customer ' + JSON.stringify(c.body));
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 1500, currency: 'USD', item_count: 1, placed_at: '2026-04-01T10:00:00Z' });
  ctx.assert(o.status === 201 && o.body.status === 'pending', 'create order ' + JSON.stringify(o.body));
  const p = ctx.api('POST', '/orders/' + o.body.id + '/pay', {});
  ctx.assert(p.status === 200 && p.body.status === 'paid', 'pay ' + JSON.stringify(p.body));
  const again = ctx.api('POST', '/orders/' + o.body.id + '/pay', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second pay ' + JSON.stringify(again.body));
}
```
### ship_order_flow
- Intent: ship_order needs a paid order and sets shipped_at.
- Actions: pay_order, ship_order
- Description: Ship a pending order (refused), pay it, ship it.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Ship Tester', email: 'ship.tester@shipflow.test', country: 'DE', plan: 'free' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 2500, currency: 'USD', item_count: 2, placed_at: '2026-04-01T11:00:00Z' });
  ctx.assert(o.status === 201, 'create order ' + JSON.stringify(o.body));
  const early = ctx.api('POST', '/orders/' + o.body.id + '/ship', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'ship pending ' + JSON.stringify(early.body));
  ctx.assert(ctx.api('POST', '/orders/' + o.body.id + '/pay', {}).status === 200, 'pay');
  const s = ctx.api('POST', '/orders/' + o.body.id + '/ship', {});
  ctx.assert(s.status === 200 && s.body.status === 'shipped' && s.body.shipped_at !== null, 'ship ' + JSON.stringify(s.body));
}
```
### deliver_order_flow
- Intent: deliver_order moves a shipped order to delivered and refuses other states.
- Actions: pay_order, ship_order, deliver_order
- Description: Deliver a paid order (refused), ship it, deliver it, deliver again.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Deliver Tester', email: 'deliver.tester@deliverflow.test', country: 'FR', plan: 'pro' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 900, currency: 'USD', item_count: 1, placed_at: '2026-04-02T10:00:00Z' });
  const id = o.body.id;
  ctx.api('POST', '/orders/' + id + '/pay', {});
  const early = ctx.api('POST', '/orders/' + id + '/deliver', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'deliver paid ' + JSON.stringify(early.body));
  ctx.api('POST', '/orders/' + id + '/ship', {});
  const d = ctx.api('POST', '/orders/' + id + '/deliver', {});
  ctx.assert(d.status === 200 && d.body.status === 'delivered', 'deliver ' + JSON.stringify(d.body));
  const again = ctx.api('POST', '/orders/' + id + '/deliver', {});
  ctx.assert(again.status === 409, 'deliver twice ' + again.status);
}
```
### cancel_order_flow
- Intent: cancel_order works on pending and paid orders and refuses shipped ones.
- Actions: pay_order, ship_order, cancel_order
- Description: Cancel a pending order, a paid order, and fail on a shipped order.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Cancel Tester', email: 'cancel.tester@cancelflow.test', country: 'ES', plan: 'free' });
  const mk = (n) => ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 700 + n, currency: 'USD', item_count: 1, placed_at: '2026-04-03T10:00:00Z' }).body.id;
  const a = mk(1), b = mk(2), s = mk(3);
  const ca = ctx.api('POST', '/orders/' + a + '/cancel', {});
  ctx.assert(ca.status === 200 && ca.body.status === 'cancelled', 'cancel pending ' + JSON.stringify(ca.body));
  ctx.api('POST', '/orders/' + b + '/pay', {});
  const cb = ctx.api('POST', '/orders/' + b + '/cancel', {});
  ctx.assert(cb.status === 200 && cb.body.status === 'cancelled', 'cancel paid ' + JSON.stringify(cb.body));
  ctx.api('POST', '/orders/' + s + '/pay', {});
  ctx.api('POST', '/orders/' + s + '/ship', {});
  const cs = ctx.api('POST', '/orders/' + s + '/cancel', {});
  ctx.assert(cs.status === 409 && cs.body.error.code === 'invalid_state', 'cancel shipped ' + JSON.stringify(cs.body));
}
```
### refund_order_flow
- Intent: refund_order refunds paid or delivered orders only, once.
- Actions: pay_order, refund_order
- Description: Refuse refunding a pending order, refund a paid order, refuse a second refund.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Refund Tester', email: 'refund.tester@refundflow.test', country: 'IT', plan: 'pro' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 4200, currency: 'USD', item_count: 3, placed_at: '2026-04-04T10:00:00Z' });
  const id = o.body.id;
  const early = ctx.api('POST', '/orders/' + id + '/refund', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'refund pending ' + JSON.stringify(early.body));
  ctx.api('POST', '/orders/' + id + '/pay', {});
  const r = ctx.api('POST', '/orders/' + id + '/refund', {});
  ctx.assert(r.status === 200 && r.body.status === 'refunded', 'refund ' + JSON.stringify(r.body));
  const again = ctx.api('POST', '/orders/' + id + '/refund', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'refund twice ' + JSON.stringify(again.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_orders` | GET | /orders | List orders, filter by status, customer_id, currency, note and item_count, sort by placed_at and total_cents. |
| `get_order` | GET | /orders/{id} | Read one order. |
| `create_order` | POST | /orders | Create a pending order. |
| `list_customers` | GET | /customers | List customers, filter by plan and country, search by name and email. |
| `get_customer` | GET | /customers/{id} | Read one customer. |
| `create_customer` | POST | /customers | Create a customer. |
| `pay_order` | POST | /orders/{id}/pay | Mark a pending order paid. |
| `ship_order` | POST | /orders/{id}/ship | Ship a paid order and set shipped_at. |
| `deliver_order` | POST | /orders/{id}/deliver | Mark a shipped order delivered. |
| `cancel_order` | POST | /orders/{id}/cancel | Cancel a pending or paid order. |
| `refund_order` | POST | /orders/{id}/refund | Refund a paid or delivered order. |

## Seed

- Rows per entity: customer: 18, order: 72
- Mix: Imported CSV rows kept as they are: 18 customers across 6 countries and 3 plans, 72 orders across all six statuses with a spread of totals and item counts.
- State mix: order: pending 19%, paid 22%, shipped 17%, delivered 22%, cancelled 14%, refunded 6%

## Tasks

- `cancel_latest_pending` (easy, irreversible): Cancel the most recently placed pending order.
  - Actions: `cancel_order`
  - Decoy idea: Cancels the earliest-placed pending order, or the latest order of any status.
  - Pressure: seeded rows in order.pending
- `refund_top_delivered` (medium, irreversible): Refund the delivered order with the highest total_cents. Check that it is delivered before refunding, and touch nothing else.
  - Actions: `refund_order`
  - Decoy idea: Refunds the highest-total order of any status, or the cheapest delivered order, or misses it on a later page.
  - Pressure: paging past the first page of order; seeded rows in order.delivered; distractor rows of order
- `pay_and_ship_pro_pending` (hard, two_actors): For every pending order placed by a customer on the pro plan, pay it and then ship it. Change nothing else.
  - Actions: `pay_order`, `ship_order`
  - Decoy idea: Pays the orders but does not ship them, reads only the first page, or includes customers on other plans.
  - Pressure: paging past the first page of order; seeded rows in order.pending; distractor rows of customer

## Open questions

- Can a shipped order be cancelled or refunded?
  - Default answer: No. It must be delivered first, and then it can be refunded.
- Should pending orders expire automatically?
  - Default answer: No. There are no jobs.
- Is there an actor, such as an agent or role, that restricts who may act on an order?
  - Default answer: No. Any caller may run any action.

## Assumptions

- Clock starts 2026-04-08T09:00:00Z with tick 0s.
  - Why: It is after the latest imported event (shipped_at 2026-04-07T14:00:00Z), and time then moves only explicitly.
- Order statuses and the transitions pending->paid|cancelled, paid->shipped|cancelled|refunded, shipped->delivered, delivered->refunded, with cancelled and refunded final.
  - Why: This is the standard order lifecycle for the CSV's six status values.
- Shipped orders cannot be cancelled or refunded directly. They must be delivered first.
  - Why: It keeps refund and cancel rules simple and checkable.
- stateMix is estimated from the CSV: about 32 of 72 orders have shipped_at, which covers shipped, delivered and some refunded orders.
  - Why: The exact status counts are not given in the profile.
- The standard create_order route makes pending orders. All later transitions go through the actions, not PATCH.
  - Why: Actions set shipped_at and enforce the rules.
- No jobs.
  - Why: Time-based changes would break the idle-state checks on the tasks, and the request names none.
- customer.plan and country are strings, as in the CSV. The note enum has the four CSV values and is nullable.
  - Why: This keeps the imported values unchanged.

## Out of scope

- Payments, carriers and inventory
  - Why: The CSV has only orders and customers.
- Line items
  - Why: Only item_count exists in the data.
- Multi-currency orders
  - Why: All imported orders are USD.

## Changes

None. The plan changes no existing item.
