# WorldGen plan: Shopify-style order desk (Shopify Admin / WooCommerce orders API): customers place orders that are paid, shipped, delivered, cancelled or refunded.

An order-management desk built around the imported orders table. Customers own orders. Each order moves through pending, paid, shipped, delivered, with cancellation and refund exits. Status changes happen only through guarded actions (pay, ship, deliver, cancel, refund) that stamp timestamps and write an audit trail, and an hourly job cancels orders left unpaid for 72 hours.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-04-08T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A buyer who places orders. Seeded so the 18 customer ids cus_0001..cus_0018 referenced by the imported orders resolve. | name, email, vip |
| `order` | A purchase, loaded from the imported orders table (ids ord_0001..ord_0072 kept). Status is a state machine driven by actions. Timestamps shipped_at, delivered_at, cancelled_at and refunded_at are stamped by actions. | customer_id, status, total_cents, currency, item_count, placed_at, shipped_at, delivered_at, cancelled_at, refunded_at, tracking_number, note |
| `order_event` | Append-only audit trail of status changes on an order, written by actions and the auto-cancel job. | order_id, kind, note |

## Workflows

### order_fulfillment (order)
- States: pending, paid, shipped, delivered, cancelled, refunded
- Actions: pay_order, ship_order, deliver_order, cancel_order, refund_order
- Rules:
  - A pending order becomes paid only through pay_order; paying any other status is refused with 409 invalid_state. Enforced by: pay_order. Tested by: order_listing_filters
  - Only a paid order can be shipped; ship_order sets shipped_at to the current engine time and stores the optional tracking_number. Enforced by: ship_order. Tested by: order_happy_path
  - Only a shipped order can be delivered; deliver_order sets delivered_at. Enforced by: deliver_order. Tested by: order_out_of_order_refused
  - Only pending or paid orders can be cancelled, with a required reason; cancel_order sets cancelled_at. Shipped, delivered, cancelled and refunded orders are refused with 409 invalid_state. Enforced by: cancel_order. Tested by: order_cancel_rules
  - Only paid, shipped or delivered orders can be refunded, once, with a required reason; refund_order sets refunded_at and the order is final. Enforced by: refund_order. Tested by: order_refund_rules
  - Pending orders unpaid for 72 hours are cancelled automatically with an event whose note starts with 'auto:'. Enforced by: auto_cancel_unpaid. Tested by: auto_cancel_unpaid_orders
  - Every pay, ship, deliver, cancel and refund writes one order_event of the matching kind. Enforced by: pay_order, ship_order, deliver_order, cancel_order, refund_order. Tested by: order_status_is_action_only
  - Status, shipped_at, delivered_at, cancelled_at, refunded_at and tracking_number cannot be written by plain create or update; the state machine rejects every undeclared transition.

## Jobs

- `auto_cancel_unpaid` runs every 1h: Cancel every pending order whose placed_at is 72 hours or more before now: status cancelled, cancelled_at now, plus an order_event of kind cancelled with note 'auto: unpaid for 72h'.

## Acceptance tests

### order_happy_path
- Intent: An order moves pending -> paid -> shipped -> delivered through the actions, stamping timestamps and writing events.
- Actions: pay_order, ship_order, deliver_order
- Description: Create a customer and an order, pay, ship with tracking, deliver. Check statuses, shipped_at equals the call time, delivered_at is set, and the event trail has one paid, shipped and delivered event.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Flow Buyer', email: 'flow.buyer@acceptance.example' });
  ctx.assert(c.status === 200 || c.status === 201, 'create customer returned ' + c.status + ' ' + JSON.stringify(c.body));
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 4599, currency: 'USD', item_count: 2 });
  ctx.assert(o.status === 200 || o.status === 201, 'create order returned ' + o.status + ' ' + JSON.stringify(o.body));
  ctx.assert(o.body.status === 'pending' && o.body.shipped_at === null, 'new order is pending with no shipped_at, got ' + JSON.stringify(o.body));
  const id = o.body.id;
  const paid = ctx.api('POST', '/orders/' + id + '/pay', {});
  ctx.assert(paid.status === 200 && paid.body.status === 'paid', 'pay: ' + JSON.stringify(paid));
  const at = ctx.now();
  const shipped = ctx.api('POST', '/orders/' + id + '/ship', { tracking_number: '1Z999AA10123456784' });
  ctx.assert(shipped.status === 200 && shipped.body.status === 'shipped', 'ship: ' + JSON.stringify(shipped));
  ctx.assert(shipped.body.shipped_at === at, 'shipped_at is the call time ' + at + ', got ' + shipped.body.shipped_at);
  ctx.assert(shipped.body.tracking_number === '1Z999AA10123456784', 'tracking number stored, got ' + shipped.body.tracking_number);
  const delivered = ctx.api('POST', '/orders/' + id + '/deliver', {});
  ctx.assert(delivered.status === 200 && delivered.body.status === 'delivered' && delivered.body.delivered_at !== null, 'deliver: ' + JSON.stringify(delivered));
  const ev = ctx.api('GET', '/orders/' + id + '/events').body.data;
  for (const k of ['paid', 'shipped', 'delivered']) {
    ctx.assert(ev.filter((e) => e.kind === k).length === 1, 'exactly one ' + k + ' event, got ' + JSON.stringify(ev));
  }
  const got = ctx.api('GET', '/orders/' + id).body;
  ctx.assert(got.status === 'delivered', 'GET shows delivered, got ' + got.status);
}
```
### order_out_of_order_refused
- Intent: Actions that skip a step are refused with 409 invalid_state and change nothing; unknown orders are 404.
- Actions: pay_order, ship_order, deliver_order
- Description: Ship and deliver a pending order, pay twice, deliver a paid order, and act on a missing order. Each is refused and the order stays as it was.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Order Skipper', email: 'skipper@acceptance.example' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 1250, currency: 'USD', item_count: 1 });
  const id = o.body.id;
  const early = ctx.api('POST', '/orders/' + id + '/ship', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'ship a pending order: ' + JSON.stringify(early));
  const earlyDeliver = ctx.api('POST', '/orders/' + id + '/deliver', {});
  ctx.assert(earlyDeliver.status === 409 && earlyDeliver.body.error.code === 'invalid_state', 'deliver a pending order: ' + JSON.stringify(earlyDeliver));
  ctx.assert(ctx.api('POST', '/orders/' + id + '/pay', {}).status === 200, 'pay');
  const twice = ctx.api('POST', '/orders/' + id + '/pay', {});
  ctx.assert(twice.status === 409 && twice.body.error.code === 'invalid_state', 'pay twice: ' + JSON.stringify(twice));
  const paidDeliver = ctx.api('POST', '/orders/' + id + '/deliver', {});
  ctx.assert(paidDeliver.status === 409 && paidDeliver.body.error.code === 'invalid_state', 'deliver a paid order: ' + JSON.stringify(paidDeliver));
  const after = ctx.api('GET', '/orders/' + id).body;
  ctx.assert(after.status === 'paid' && after.shipped_at === null && after.delivered_at === null, 'order is still paid, got ' + JSON.stringify(after));
  const missing = ctx.api('POST', '/orders/ord_9999/pay', {});
  ctx.assert(missing.status === 404 && missing.body.error.code === 'not_found', 'missing order: ' + JSON.stringify(missing));
}
```
### order_cancel_rules
- Intent: Pending and paid orders can be cancelled with a reason; shipped and cancelled orders cannot.
- Actions: cancel_order, pay_order, ship_order
- Description: Cancel a pending order and a paid order, check cancelled_at and the event, then show a shipped order, a cancelled order and a missing reason are refused.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Cancel Buyer', email: 'cancel.buyer@acceptance.example' });
  const mk = () => ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 3000, currency: 'USD', item_count: 3 }).body.id;
  const a = mk();
  const at = ctx.now();
  const r = ctx.api('POST', '/orders/' + a + '/cancel', { reason: 'Changed my mind' });
  ctx.assert(r.status === 200 && r.body.status === 'cancelled' && r.body.cancelled_at === at, 'cancel pending: ' + JSON.stringify(r));
  const ev = ctx.api('GET', '/orders/' + a + '/events').body.data.filter((e) => e.kind === 'cancelled');
  ctx.assert(ev.length === 1 && ev[0].note === 'Changed my mind', 'one cancelled event with the reason, got ' + JSON.stringify(ev));
  const again = ctx.api('POST', '/orders/' + a + '/cancel', { reason: 'again' });
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'cancel twice: ' + JSON.stringify(again));
  const payCancelled = ctx.api('POST', '/orders/' + a + '/pay', {});
  ctx.assert(payCancelled.status === 409 && payCancelled.body.error.code === 'invalid_state', 'pay a cancelled order: ' + JSON.stringify(payCancelled));
  const b = mk();
  ctx.assert(ctx.api('POST', '/orders/' + b + '/pay', {}).status === 200, 'pay b');
  const noReason = ctx.api('POST', '/orders/' + b + '/cancel', {});
  ctx.assert(noReason.status === 400 && noReason.body.error.code === 'input.invalid', 'cancel without reason: ' + JSON.stringify(noReason));
  const paidCancel = ctx.api('POST', '/orders/' + b + '/cancel', { reason: 'Out of stock' });
  ctx.assert(paidCancel.status === 200 && paidCancel.body.status === 'cancelled', 'cancel paid: ' + JSON.stringify(paidCancel));
  const d = mk();
  ctx.assert(ctx.api('POST', '/orders/' + d + '/pay', {}).status === 200, 'pay d');
  ctx.assert(ctx.api('POST', '/orders/' + d + '/ship', {}).status === 200, 'ship d');
  const shippedCancel = ctx.api('POST', '/orders/' + d + '/cancel', { reason: 'Too late' });
  ctx.assert(shippedCancel.status === 409 && shippedCancel.body.error.code === 'invalid_state', 'cancel shipped: ' + JSON.stringify(shippedCancel));
  ctx.assert(ctx.api('GET', '/orders/' + d).body.status === 'shipped', 'shipped order is unchanged');
}
```
### order_refund_rules
- Intent: Paid, shipped and delivered orders can be refunded once with a reason; pending, cancelled and refunded orders cannot.
- Actions: refund_order, pay_order, ship_order, deliver_order, cancel_order
- Description: Refund a paid order and a delivered order, check refunded_at and events, then show a pending order, a repeat refund, a cancelled order and a missing reason are refused.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Refund Buyer', email: 'refund.buyer@acceptance.example' });
  const mk = () => ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 8000, currency: 'USD', item_count: 4 }).body.id;
  const pending = mk();
  const early = ctx.api('POST', '/orders/' + pending + '/refund', { reason: 'Not paid yet' });
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'refund a pending order: ' + JSON.stringify(early));
  const a = mk();
  ctx.assert(ctx.api('POST', '/orders/' + a + '/pay', {}).status === 200, 'pay a');
  const noReason = ctx.api('POST', '/orders/' + a + '/refund', {});
  ctx.assert(noReason.status === 400 && noReason.body.error.code === 'input.invalid', 'refund without reason: ' + JSON.stringify(noReason));
  const at = ctx.now();
  const r = ctx.api('POST', '/orders/' + a + '/refund', { reason: 'Duplicate charge' });
  ctx.assert(r.status === 200 && r.body.status === 'refunded' && r.body.refunded_at === at, 'refund paid: ' + JSON.stringify(r));
  const ev = ctx.api('GET', '/orders/' + a + '/events').body.data.filter((e) => e.kind === 'refunded');
  ctx.assert(ev.length === 1 && ev[0].note === 'Duplicate charge', 'one refunded event with the reason, got ' + JSON.stringify(ev));
  const twice = ctx.api('POST', '/orders/' + a + '/refund', { reason: 'again' });
  ctx.assert(twice.status === 409 && twice.body.error.code === 'invalid_state', 'refund twice: ' + JSON.stringify(twice));
  const b = mk();
  for (const step of ['pay', 'ship', 'deliver']) ctx.assert(ctx.api('POST', '/orders/' + b + '/' + step, {}).status === 200, step + ' b');
  const delivered = ctx.api('POST', '/orders/' + b + '/refund', { reason: 'Arrived damaged' });
  ctx.assert(delivered.status === 200 && delivered.body.status === 'refunded', 'refund delivered: ' + JSON.stringify(delivered));
  const cancelled = mk();
  ctx.assert(ctx.api('POST', '/orders/' + cancelled + '/cancel', { reason: 'Oops' }).status === 200, 'cancel');
  const late = ctx.api('POST', '/orders/' + cancelled + '/refund', { reason: 'Nothing was charged' });
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'refund a cancelled order: ' + JSON.stringify(late));
}
```
### order_status_is_action_only
- Intent: Status and timestamps cannot be set by plain create or update; only the note is editable.
- Actions: pay_order
- Description: PATCH status to shipped is refused and leaves the order pending, PATCH note works, and creating an order with a status other than pending is refused or ignored so the order starts pending.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Patch Buyer', email: 'patch.buyer@acceptance.example' });
  const o = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 999, currency: 'USD', item_count: 1 });
  const id = o.body.id;
  const bad = ctx.api('PATCH', '/orders/' + id, { status: 'shipped' });
  ctx.assert(bad.status >= 400 && bad.status < 500, 'PATCH status must be refused with a 4xx, got ' + bad.status + ' ' + JSON.stringify(bad.body));
  ctx.assert(ctx.api('GET', '/orders/' + id).body.status === 'pending', 'order is still pending');
  const ok = ctx.api('PATCH', '/orders/' + id, { note: 'Gift wrap, no receipt' });
  ctx.assert(ok.status === 200 && ok.body.note === 'Gift wrap, no receipt', 'PATCH note: ' + JSON.stringify(ok));
  const forged = ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 500, currency: 'USD', item_count: 1, status: 'delivered' });
  ctx.assert(forged.status >= 400 || forged.body.status === 'pending', 'create cannot start an order past pending, got ' + JSON.stringify(forged));
  const ghost = ctx.api('POST', '/orders', { customer_id: 'cus_9999', total_cents: 500, currency: 'USD', item_count: 1 });
  ctx.assert(ghost.status >= 400 && ghost.status < 500, 'order for an unknown customer is refused, got ' + ghost.status);
}
```
### auto_cancel_unpaid_orders
- Intent: The hourly job cancels pending orders after 72 hours and leaves paid orders alone.
- Actions: pay_order
- Description: Create a pending order and a paid order. After 2 days both are unchanged. After 4 days the pending one is cancelled with an auto event and the paid one is still paid.

```js
(ctx) => {
  const c = ctx.api('POST', '/customers', { name: 'Slow Payer', email: 'slow.payer@acceptance.example' });
  const mk = () => ctx.api('POST', '/orders', { customer_id: c.body.id, total_cents: 2200, currency: 'USD', item_count: 2 }).body.id;
  const unpaid = mk();
  const paid = mk();
  ctx.assert(ctx.api('POST', '/orders/' + paid + '/pay', {}).status === 200, 'pay');
  ctx.advance('2d');
  ctx.assert(ctx.api('GET', '/orders/' + unpaid).body.status === 'pending', 'still pending after 2 days');
  const run = ctx.advance('2d');
  ctx.assert(run.jobsFailed.length === 0, 'jobs failed: ' + JSON.stringify(run.jobsFailed));
  const after = ctx.api('GET', '/orders/' + unpaid).body;
  ctx.assert(after.status === 'cancelled' && after.cancelled_at !== null, 'unpaid order cancelled after 96 hours, got ' + JSON.stringify(after));
  const ev = ctx.api('GET', '/orders/' + unpaid + '/events').body.data.filter((e) => e.kind === 'cancelled');
  ctx.assert(ev.length === 1 && typeof ev[0].note === 'string' && ev[0].note.indexOf('auto:') === 0, 'one auto cancelled event, got ' + JSON.stringify(ev));
  ctx.assert(ctx.api('GET', '/orders/' + paid).body.status === 'paid', 'paid order untouched');
}
```
### order_listing_filters
- Intent: Orders can be filtered by status and customer and paged with a cursor.
- Actions: pay_order
- Description: Create two customers, three orders for the first and one for the second, pay one. Filtering by customer and status returns exactly the right orders, and limit=2 pages through all three without repeats.

```js
(ctx) => {
  const a = ctx.api('POST', '/customers', { name: 'List Buyer A', email: 'list.a@acceptance.example' }).body.id;
  const b = ctx.api('POST', '/customers', { name: 'List Buyer B', email: 'list.b@acceptance.example' }).body.id;
  const mk = (cid) => ctx.api('POST', '/orders', { customer_id: cid, total_cents: 1000, currency: 'USD', item_count: 1 }).body.id;
  const a1 = mk(a); const a2 = mk(a); const a3 = mk(a); mk(b);
  ctx.assert(ctx.api('POST', '/orders/' + a2 + '/pay', {}).status === 200, 'pay a2');
  const mine = ctx.api('GET', '/orders?customer_id=' + a).body.data.map((o) => o.id).sort();
  ctx.assert(JSON.stringify(mine) === JSON.stringify([a1, a2, a3].sort()), 'customer filter, got ' + JSON.stringify(mine));
  const paid = ctx.api('GET', '/orders?customer_id=' + a + '&status=paid').body.data;
  ctx.assert(paid.length === 1 && paid[0].id === a2, 'status filter, got ' + JSON.stringify(paid));
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = ctx.api('GET', '/orders?customer_id=' + a + '&limit=2' + (cursor === null ? '' : '&cursor=' + cursor));
    ctx.assert(r.status === 200, 'page failed ' + JSON.stringify(r.body));
    for (const o of r.body.data) seen.push(o.id);
    cursor = r.body.next_cursor;
    pages += 1;
  } while (cursor !== null && pages < 5);
  ctx.assert(pages === 2 && seen.length === 3 && new Set(seen).size === 3, 'two pages, three distinct orders, got ' + pages + ' pages ' + JSON.stringify(seen));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_orders` | GET | /orders | List orders with filters status, customer_id, currency, item_count; search on note; sort by placed_at, total_cents, shipped_at. Cursor paging. |
| `get_order` | GET | /orders/{id} | Fetch one order. |
| `create_order` | POST | /orders | Place an order (customer_id, total_cents, currency, item_count, optional note). Starts pending with placed_at set to now. |
| `update_order` | PATCH | /orders/{id} | Edit only the note (status, timestamps and tracking are readonly and move through actions). |
| `list_order_events` | GET | /orders/{order_id}/events | Audit trail of one order. |
| `list_customers` | GET | /customers | List customers; filter vip; search name and email. |
| `get_customer` | GET | /customers/{id} | Fetch one customer. |
| `create_customer` | POST | /customers | Create a customer (name, email unique). |

## Seed

- Rows per entity: customer: 18, order: 72, order_event: 60
- Mix: order rows come from the imported orders fixture (72 rows, ids and customer ids kept, status as imported: about 17% pending, 19% paid, 17% shipped, 25% delivered, 14% cancelled, 8% refunded; shipped_at non-null for the 32 shipped, delivered and shipped-then-refunded rows). 18 customers named so cus_0001..cus_0018 resolve, a few flagged vip. order_event rows give a plausible paid/shipped/delivered/cancelled/refunded trail for a sample of seeded orders, all dated before clock.start.
- State mix: order: pending 17%, paid 19%, shipped 17%, delivered 25%, cancelled 14%, refunded 8%

## Tasks

- `pay_oldest_pending_for_customer` (easy): Mark the oldest still-pending order of one named customer (identified by customer id in the instruction) as paid using the pay action, changing nothing else.
  - Decoy idea: Pays the newest pending order, or the first pending order in id order instead of the oldest by placed_at, or PATCHes status directly.
- `refund_delivered_big_orders_for_customer` (medium): For one customer, refund every delivered order whose total is above a stated dollar threshold, with a reason on each, leaving their other orders (shipped, paid, smaller delivered) untouched.
  - Decoy idea: Refunds all of the customer's delivered orders ignoring the threshold, or also refunds shipped orders, or misreads the threshold in dollars versus total_cents.
- `cancel_stale_pending_with_gift_note` (medium): Cancel every pending order placed before a stated date whose note is a given text (for example 'Gift wrap, no receipt'), with a reason, and leave pending orders with other notes or later dates alone.
  - Decoy idea: Cancels all pending orders before the date regardless of note, or cancels paid orders with that note as well.
- `ship_all_paid_large_orders` (hard): Ship every paid order that has at least a stated item_count and a total above a stated amount, across more than one page of results, giving each a tracking number, without touching other paid orders.
  - Decoy idea: Reads only the first page of paid orders, ignores one of the two conditions, delivers instead of ships, or marks them shipped by PATCH so shipped_at stays empty.

## Open questions

- Should the orders table be the seed source exactly, including its statuses and ids?
  - Default answer: Yes. The fixture is loaded as the order seed unchanged, and customers and events are generated around it.
- Which customer attributes exist, since the CSV only has customer ids?
  - Default answer: Name, unique email and a vip flag, generated by the seed.
- Can shipped orders be cancelled?
  - Default answer: No. Once shipped an order can only be delivered or refunded.
- Are refunds partial?
  - Default answer: No, full refund only, and it is allowed from paid, shipped and delivered.
- Should unpaid orders expire?
  - Default answer: Yes, pending orders are auto-cancelled after 72 hours by an hourly job.
- How should the clock behave?
  - Default answer: Start 2026-04-08T09:00:00Z, no per-call tick, time moves only on explicit advance.

## Assumptions

- clock.start is 2026-04-08T09:00:00Z and tick is 0s.
  - Why: The latest imported timestamp is shipped_at 2026-04-07T14:00Z, so the world starts after all imported history. Time moves only by explicit advance, so timestamp assertions are exact.
- Fixture ids (ord_0001..ord_0072) and customer ids are kept as given; a customer entity with idPrefix cus is seeded with 18 rows so every orders.customer_id resolves.
  - Why: The CSV only has orders but references cus_0001..cus_0018.
- Money is kept as total_cents (int) with a currency enum limited to USD, as imported.
  - Why: This matches the CSV and only one currency exists, so no conversion logic is needed.
- Orders have no line-item table. item_count and total_cents are plain fields that are not recomputed.
  - Why: The CSV carries only aggregates, and line items would add scope with no source data.
- Order status machine: pending->paid|cancelled; paid->shipped|cancelled|refunded; shipped->delivered|refunded; delivered->refunded; cancelled and refunded are final.
  - Why: Standard order desk lifecycle covering all six imported statuses. Shipped orders cannot be cancelled, only refunded, because they have left the warehouse.
- Status, shipped_at, delivered_at, cancelled_at, refunded_at and tracking_number are readonly on plain create/update. Only the action routes change them. Illegal actions answer 409 with error code invalid_state, unknown ids 404 not_found, a missing required input 400 input.invalid.
  - Why: Forces agents to use the business actions, and gives tests and graders a stable error contract.
- Refund is always a full refund of total_cents, and a reason is required. Cancel also requires a reason. Ship takes an optional tracking_number. Pay and deliver need no input.
  - Why: Keeps the money logic simple while still giving each action a visible side effect.
- Job auto_cancel_unpaid runs every 1h and cancels pending orders whose placed_at is at least 72h before now, writing a cancelled event with note starting 'auto:'.
  - Why: Gives a time-driven rule. Old seeded pending orders will be cancelled the first time the clock advances, which only tests (not tasks) can trigger.
- Acceptance tests create their own customers with emails ending @acceptance.example and orders through the API, and never read seed rows. The job test lists only workflow actions in its actions field; the job is exercised through ctx.advance.
  - Why: The workflow stage runs tests before any seed exists, and the actions field accepts only workflow action keys.

## Out of scope

- Payment gateway, card capture, partial refunds, and refund amounts
  - Why: The value here is order state and workflow, not payment processing; refunds are full and just change state.
- Line items, products, inventory and shipping-rate calculation
  - Why: Not in the imported data and would multiply scope.
- Multi-currency and tax
  - Why: The CSV has USD only.
- Authentication, webhooks and an admin UI
  - Why: Agents talk to the REST API directly; no user interface is part of the world.

## Changes

None. The plan changes no existing item.
