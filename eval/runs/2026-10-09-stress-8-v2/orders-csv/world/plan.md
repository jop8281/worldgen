# WorldGen plan: Shopify-style order desk (orders and customers API)

An order desk with customers and orders. Orders move through pending, paid, shipped, delivered, and can be cancelled before shipping or refunded after payment. The imported CSV fixtures (18 customers, 72 orders) are kept exactly.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-04-08T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A buyer, imported from customers.csv (18 rows). Holds name, unique email, country and plan. | id, email |
| `order` | A purchase by a customer, imported from orders.csv (72 rows). Holds status, total in USD cents, item_count, placed_at, shipped_at and an optional delivery note. | id, customer_id, status, placed_at |

## Workflows

### order_fulfilment (order)
- States: pending, paid, shipped, delivered, cancelled, refunded
- Actions: pay_order, ship_order, deliver_order, cancel_order, refund_order
- Rules:
  - Only a pending order can be paid; any other state is refused with 409 invalid_state. Enforced by: pay_order. Tested by: pay_order_only_from_pending
  - Only a paid order can be shipped; shipping sets shipped_at to the current time and other states are refused with 409 invalid_state. Enforced by: ship_order. Tested by: ship_requires_paid_and_sets_shipped_at
  - Only a shipped order can be marked delivered. Enforced by: deliver_order. Tested by: deliver_only_from_shipped
  - Only a pending or paid order can be cancelled; once shipped it cannot be cancelled, and cancelled is final. Enforced by: cancel_order. Tested by: cancel_only_before_shipping
  - Only a paid, shipped or delivered order can be refunded; refunded is final and a second refund is refused. Enforced by: refund_order. Tested by: refund_only_after_payment
  - A new order always starts pending; a create that sets another status is refused. Enforced by the data model: The state field has initial pending, so the engine refuses any other initial state with state.initial.
  - A customer email is unique. Enforced by the data model: The email field is declared unique, so a duplicate create is refused with field.unique.

## Jobs

None. The plan declares no job.

## Acceptance tests

### pay_order_only_from_pending
- Intent: pay_order moves a pending order to paid and refuses a second payment
- Actions: pay_order
- Description: Create a customer and an order, pay it, then pay again and expect 409 invalid_state.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Plan Tester Pay', email: 'pay.tester@plan-test.example.org', country: 'GB', plan: 'pro' });
  ctx.assert(c.status === 201, 'customer create ' + c.status + JSON.stringify(c.body));
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 2500, currency: 'USD', item_count: 2, placed_at: '2026-04-08T08:00:00.000Z' });
  ctx.assert(o.status === 201 && o.body.status === 'pending', 'order starts pending: ' + JSON.stringify(o.body));
  const p = ctx.api('POST', '/orders/' + o.body.id + '/pay', {});
  ctx.assert(p.status === 200 && p.body.status === 'paid', 'pay: ' + JSON.stringify(p.body));
  const again = ctx.api('POST', '/orders/' + o.body.id + '/pay', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second pay: ' + JSON.stringify(again.body));
  const missing = ctx.api('POST', '/orders/ord_999999/pay', {});
  ctx.assert(missing.status === 404, 'missing order: ' + missing.status);
}
```
### ship_requires_paid_and_sets_shipped_at
- Intent: ship_order works only on paid orders and stamps shipped_at
- Actions: pay_order, ship_order
- Description: Shipping a pending order is refused; after payment shipping succeeds and sets shipped_at to the call time.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Plan Tester Ship', email: 'ship.tester@plan-test.example.org', country: 'US', plan: 'free' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 1800, currency: 'USD', item_count: 1, placed_at: '2026-04-08T08:00:00.000Z' });
  ctx.assert(o.status === 201, 'order create ' + o.status);
  const early = ctx.api('POST', '/orders/' + o.body.id + '/ship', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'ship pending: ' + JSON.stringify(early.body));
  ctx.assert(ctx.api('POST', '/orders/' + o.body.id + '/pay', {}).status === 200, 'pay');
  const at = ctx.now();
  const s = ctx.api('POST', '/orders/' + o.body.id + '/ship', {});
  ctx.assert(s.status === 200 && s.body.status === 'shipped' && s.body.shipped_at === at, 'ship: ' + JSON.stringify(s.body));
}
```
### deliver_only_from_shipped
- Intent: deliver_order works only on shipped orders
- Actions: pay_order, ship_order, deliver_order
- Description: Delivering a paid order is refused; after shipping it succeeds.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Plan Tester Deliver', email: 'deliver.tester@plan-test.example.org', country: 'DE', plan: 'basic' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 900, currency: 'USD', item_count: 3, placed_at: '2026-04-08T08:00:00.000Z' });
  ctx.assert(ctx.api('POST', '/orders/' + o.body.id + '/pay', {}).status === 200, 'pay');
  const early = ctx.api('POST', '/orders/' + o.body.id + '/deliver', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'deliver paid: ' + JSON.stringify(early.body));
  ctx.assert(ctx.api('POST', '/orders/' + o.body.id + '/ship', {}).status === 200, 'ship');
  const d = ctx.api('POST', '/orders/' + o.body.id + '/deliver', {});
  ctx.assert(d.status === 200 && d.body.status === 'delivered', 'deliver: ' + JSON.stringify(d.body));
}
```
### cancel_only_before_shipping
- Intent: cancel_order works on pending and paid orders and is refused once shipped
- Actions: cancel_order, pay_order, ship_order
- Description: Cancel a pending order; a cancelled order cannot be cancelled again; a shipped order cannot be cancelled.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Plan Tester Cancel', email: 'cancel.tester@plan-test.example.org', country: 'FR', plan: 'pro' });
  const mk = () => ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 1200, currency: 'USD', item_count: 1, placed_at: '2026-04-08T08:00:00.000Z' }).body.id;
  const a = mk();
  const r = ctx.api('POST', '/orders/' + a + '/cancel', {});
  ctx.assert(r.status === 200 && r.body.status === 'cancelled', 'cancel pending: ' + JSON.stringify(r.body));
  const twice = ctx.api('POST', '/orders/' + a + '/cancel', {});
  ctx.assert(twice.status === 409 && twice.body.error.code === 'invalid_state', 'cancel twice: ' + JSON.stringify(twice.body));
  const b = mk();
  ctx.api('POST', '/orders/' + b + '/pay', {});
  ctx.api('POST', '/orders/' + b + '/ship', {});
  const late = ctx.api('POST', '/orders/' + b + '/cancel', {});
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'cancel shipped: ' + JSON.stringify(late.body));
  const paid = mk();
  ctx.api('POST', '/orders/' + paid + '/pay', {});
  const pc = ctx.api('POST', '/orders/' + paid + '/cancel', {});
  ctx.assert(pc.status === 200 && pc.body.status === 'cancelled', 'cancel paid: ' + JSON.stringify(pc.body));
}
```
### refund_only_after_payment
- Intent: refund_order works on paid, shipped and delivered orders, never on pending or refunded ones
- Actions: refund_order, pay_order, ship_order, deliver_order
- Description: Refuse refunding a pending order; refund a delivered order; refuse a second refund.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Plan Tester Refund', email: 'refund.tester@plan-test.example.org', country: 'GB', plan: 'pro' });
  const mk = () => ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 4000, currency: 'USD', item_count: 4, placed_at: '2026-04-08T08:00:00.000Z' }).body.id;
  const a = mk();
  const early = ctx.api('POST', '/orders/' + a + '/refund', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'refund pending: ' + JSON.stringify(early.body));
  ctx.api('POST', '/orders/' + a + '/pay', {});
  ctx.api('POST', '/orders/' + a + '/ship', {});
  ctx.api('POST', '/orders/' + a + '/deliver', {});
  const r = ctx.api('POST', '/orders/' + a + '/refund', {});
  ctx.assert(r.status === 200 && r.body.status === 'refunded', 'refund delivered: ' + JSON.stringify(r.body));
  const again = ctx.api('POST', '/orders/' + a + '/refund', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'refund twice: ' + JSON.stringify(again.body));
  const b = mk();
  ctx.api('POST', '/orders/' + b + '/pay', {});
  const pr = ctx.api('POST', '/orders/' + b + '/refund', {});
  ctx.assert(pr.status === 200 && pr.body.status === 'refunded', 'refund paid: ' + JSON.stringify(pr.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_orders` | GET | /orders | List orders, filter by status, customer_id and currency, sort by placed_at or total_cents |
| `get_order` | GET | /orders/{id} | Read one order |
| `create_order` | POST | /orders | Create an order in the pending state |
| `update_order` | PATCH | /orders/{id} | Edit non-workflow order fields such as the note |
| `list_customers` | GET | /customers | List customers, filter by country and plan, search by name and email |
| `get_customer` | GET | /customers/{id} | Read one customer |
| `create_customer` | POST | /customers | Create a customer |
| `update_customer` | PATCH | /customers/{id} | Edit a customer |

## Seed

- Rows per entity: customer: 18, order: 72
- Mix: Exactly the imported CSV rows: 18 customers and 72 orders across all six statuses with their original values. No generated rows, since both entities have fixtures.
- State mix: order: pending 17%, paid 17%, shipped 17%, delivered 17%, cancelled 16%, refunded 16%

## Tasks

- `ship_latest_paid_order` (easy): Ship the most recently placed paid order of the customer Ada Lovelace.
  - Actions: `ship_order`
  - Decoy idea: Ships her oldest paid order, or ships a paid order of another customer with a similar name.
- `refund_delivered_orders_for_country` (medium, irreversible): Refund every delivered order over 5000 cents that belongs to a customer in GB. Leave all other orders untouched.
  - Actions: `refund_order`
  - Decoy idea: Refunds all delivered orders regardless of country or amount, or refunds shipped orders as well.
  - Pressure: seeded rows in order.delivered; distractor rows of order
- `fulfil_pending_orders_of_pro_customers` (hard, two_actors): For every pending order placed by a customer on the pro plan, record payment and then ship it. Cancel nothing and change no other order.
  - Actions: `pay_order`, `ship_order`
  - Decoy idea: Pays the pending orders but never ships them, reads only the first page of orders, or ships orders of non-pro customers.
  - Pressure: paging past the first page of order; seeded rows in order.pending; distractor rows of customer

## Open questions

- Can an order be cancelled after it has shipped?
  - Default answer: No. Cancel is allowed only from pending or paid; after that use refund.
- Should a refund be allowed on a pending order?
  - Default answer: No. Refund needs a paid, shipped or delivered order; a pending order is cancelled instead.
- Is shipped_at set by the client or by the system?
  - Default answer: By the system when ship_order runs.
- Do refunds change the total or only the status?
  - Default answer: Only the status; refunds are full.

## Assumptions

- clock.start is 2026-04-08T09:00:00Z with tick 0s
  - Why: The latest imported event is shipped_at 2026-04-07T14:00:00Z, so the start is after all history. Time moves only when explicitly advanced.
- Order status is a state field with transitions pending->paid|cancelled, paid->shipped|cancelled|refunded, shipped->delivered|refunded, delivered->refunded; cancelled and refunded are final
  - Why: This is the standard order lifecycle implied by the CSV status enum.
- Status and shipped_at are readonly on standard routes and change only through actions
  - Why: Keeps the workflow rules from being bypassed by a plain PATCH.
- Money is USD cents (total_cents), and currency is fixed to USD
  - Why: The CSV has one currency value.
- stateMix is an approximately even split across the six statuses
  - Why: The exact per-status counts come from the fixture, which is kept unchanged; the mix is a rough share within tolerance (shipped_at is set on 44% of rows).
- ship_order sets shipped_at to the engine time
  - Why: The CSV has shipped_at only for shipped orders.
- Refunds are full refunds that change only the status
  - Why: The CSV has no refund amount field.
- Acceptance tests create their own customers and orders with emails under plan-test.example.org
  - Why: The tests run before the seed exists and must not collide with seed values.

## Out of scope

- Payment processing, payment gateways and card data
  - Why: The world only records state; pay_order just marks an order paid.
- Line items, inventory, shipping carriers and tracking
  - Why: The CSV only has an item_count and shipped_at.
- Partial refunds, multiple currencies and taxes
  - Why: The CSV has no fields for them.
- Deleting customers or orders
  - Why: Order history must stay intact.

## Changes

None. The plan changes no existing item.
