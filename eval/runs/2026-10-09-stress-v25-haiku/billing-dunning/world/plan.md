# WorldGen plan: Stripe Billing subscriptions with invoices, card payments and dunning

A subscription billing API. Customers hold cards and subscribe to plans; each subscription bills an invoice per period. A declined charge moves the invoice and subscription to past_due and starts dunning: retries run 1, 3 and 7 days after the first failure, and when the last retry fails the subscription is cancelled and its invoice voided. Agents charge invoices, change a subscription's card, cancel subscriptions and read invoices and payments. Feasible: the core value is stateful billing records that an agent reads and changes through actions.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A paying account with a name and a unique email. | first_name, last_name, email |
| `plan` | A price list entry that subscriptions bill against. | name, price, interval |
| `payment_method` | A card on file for a customer. card_state declined simulates an issuer decline. | customer_id, kind, last_four, card_state |
| `subscription` | A customer's recurring subscription to a plan, with its status state machine. | customer_id, plan_id, payment_method_id, status, cancelled_at |
| `invoice` | One bill of a subscription, with dunning fields attempts, first_failed_at and next_retry_at. | subscription_id, number, amount, status, attempts, first_failed_at, next_retry_at, paid_at |
| `payment` | One charge attempt against an invoice, succeeded or failed, on a payment method. | invoice_id, payment_method_id, amount, outcome |

## Workflows

### subscription_lifecycle (subscription)
- States: active, past_due, cancelled
- Actions: create_subscription, cancel_subscription, update_subscription_payment_method
- Rules:
  - A new subscription starts active and opens one invoice at the plan price Enforced by: create_subscription. Tested by: create_subscription_opens_invoice
  - A declined charge moves the subscription to past_due and records the first failure Enforced by: charge_invoice. Tested by: declined_charge_starts_dunning
  - Dunning retries run 1, 3 and 7 days after the first failure; when the last retry fails the subscription is cancelled and its invoice voided Enforced by: dunning_retry. Tested by: dunning_retries_then_cancels
  - A successful retry returns the subscription to active Enforced by: dunning_retry. Tested by: retry_after_card_fix_restores
  - Cancelling a subscription voids its open and past_due invoices and sets cancelled_at Enforced by: cancel_subscription. Tested by: cancel_voids_open_invoices
  - The card on a subscription must belong to the subscription customer Enforced by: update_subscription_payment_method. Tested by: payment_method_must_belong
  - Status moves only active to past_due and back, or to cancelled Enforced by the data model: subscription.status is a state field whose transitions the engine enforces on every write
### invoice_collection (invoice)
- States: open, paid, past_due, void
- Actions: charge_invoice
- Rules:
  - A cancelled subscription accepts no charge Enforced by: charge_invoice. Tested by: cancelled_refuses_charge
  - A paid invoice cannot be charged again Enforced by: charge_invoice. Tested by: paid_invoice_refuses_charge
  - Invoice numbers are unique Enforced by the data model: invoice.number is declared unique
  - An invoice cannot move from paid back to open Enforced by the data model: invoice.status is a state field whose transitions the engine enforces

## Jobs

- `dunning_retry` runs every 1h: For each past_due invoice whose next_retry_at is at or before now, charge its subscription's card. A success marks the invoice paid with paid_at, clears next_retry_at and returns the subscription to active. A failure increments attempts and records a payment failed. The first failure sets next_retry_at to first_failed_at plus 1 day; after attempt 2 the next retry is first_failed_at plus 3 days; after attempt 3 it is first_failed_at plus 7 days. When the 4th attempt fails the subscription is cancelled and the invoice voided.

## Acceptance tests

### create_subscription_opens_invoice
- Intent: A new subscription is active and bills one open invoice at the plan price.
- Actions: create_subscription
- Description: Create a customer, plan and card, subscribe, and check the subscription and its single open invoice.

```js
(ctx) => { const cus = ctx.api('POST', '/customers', { first_name: 'Ines', last_name: 'Opener', email: 'ines.opener.t1@example.test' }); ctx.assert(cus.status === 201, 'create customer: ' + JSON.stringify(cus.body)); const plan = ctx.api('POST', '/plans', { name: 'Test Plan T1', price: 1500, interval: 'monthly' }); ctx.assert(plan.status === 201, 'create plan: ' + JSON.stringify(plan.body)); const card = ctx.api('POST', '/payment_methods', { customer_id: cus.body.id, kind: 'card', last_four: '7001', card_state: 'good' }); ctx.assert(card.status === 201, 'create card: ' + JSON.stringify(card.body)); const sub = ctx.api('POST', '/subscriptions', { customer_id: cus.body.id, plan_id: plan.body.id, payment_method_id: card.body.id }); ctx.assert(sub.status === 201 && sub.body.status === 'active', 'subscribe: ' + JSON.stringify(sub.body)); const inv = ctx.api('GET', '/invoices?subscription_id=' + sub.body.id).body.data; ctx.assert(inv.length === 1 && inv[0].status === 'open' && inv[0].amount === 1500, 'one open invoice of 1500 expected: ' + JSON.stringify(inv)); }
```
### declined_charge_starts_dunning
- Intent: A declined charge starts dunning: invoice and subscription past_due, one attempt, one failed payment row.
- Actions: charge_invoice
- Description: Charge an invoice on a declined card and check the past_due state, the attempt count, the scheduled retry and the failed payment.

```js
(ctx) => { const cus = ctx.api('POST', '/customers', { first_name: 'Ravi', last_name: 'Declined', email: 'ravi.declined.t2@example.test' }).body; const plan = ctx.api('POST', '/plans', { name: 'Test Plan T2', price: 2000, interval: 'monthly' }).body; const card = ctx.api('POST', '/payment_methods', { customer_id: cus.id, kind: 'card', last_four: '7002', card_state: 'declined' }).body; const sub = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id, payment_method_id: card.id }).body; const inv = ctx.api('GET', '/invoices?subscription_id=' + sub.id).body.data[0]; const r = ctx.api('POST', '/invoices/' + inv.id + '/charge'); ctx.assert(r.status === 200 && r.body.status === 'past_due' && r.body.attempts === 1, 'charge should fail and start dunning: ' + JSON.stringify(r.body)); ctx.assert(r.body.first_failed_at !== null && r.body.next_retry_at !== null, 'the retry is scheduled'); ctx.assert(ctx.api('GET', '/subscriptions/' + sub.id).body.status === 'past_due', 'subscription should be past_due'); const pays = ctx.api('GET', '/payments?invoice_id=' + inv.id).body.data; ctx.assert(pays.length === 1 && pays[0].outcome === 'failed', 'one failed payment expected: ' + JSON.stringify(pays)); }
```
### dunning_retries_then_cancels
- Intent: Retries run on days 1, 3 and 7 after the first failure; the failure on day 7 cancels the subscription and voids the invoice.
- Actions: charge_invoice
- Description: Start dunning on a declined card, advance 1, 3 and 7 days so the dunning job fires, and check each retry, the cancellation, the void invoice and four failed payments.

```js
(ctx) => { const cus = ctx.api('POST', '/customers', { first_name: 'Dana', last_name: 'Retry', email: 'dana.retry.t3@example.test' }).body; const plan = ctx.api('POST', '/plans', { name: 'Test Plan T3', price: 2500, interval: 'monthly' }).body; const card = ctx.api('POST', '/payment_methods', { customer_id: cus.id, kind: 'card', last_four: '7003', card_state: 'declined' }).body; const sub = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id, payment_method_id: card.id }).body; const inv = ctx.api('GET', '/invoices?subscription_id=' + sub.id).body.data[0]; ctx.api('POST', '/invoices/' + inv.id + '/charge'); ctx.advance('1d'); let i = ctx.api('GET', '/invoices/' + inv.id).body; ctx.assert(i.attempts === 2 && i.status === 'past_due', 'day 1 retry should fail: ' + JSON.stringify(i)); ctx.advance('2d'); i = ctx.api('GET', '/invoices/' + inv.id).body; ctx.assert(i.attempts === 3 && i.status === 'past_due', 'day 3 retry should fail: ' + JSON.stringify(i)); ctx.advance('4d'); i = ctx.api('GET', '/invoices/' + inv.id).body; ctx.assert(i.attempts === 4 && i.status === 'void', 'day 7 retry should fail and void: ' + JSON.stringify(i)); ctx.assert(ctx.api('GET', '/subscriptions/' + sub.id).body.status === 'cancelled', 'subscription should be cancelled'); const pays = ctx.api('GET', '/payments?invoice_id=' + inv.id).body.data; ctx.assert(pays.length === 4 && pays.every((p) => p.outcome === 'failed'), 'four failed attempts expected'); }
```
### retry_after_card_fix_restores
- Intent: After the customer's card is replaced, the next dunning retry collects the invoice and returns the subscription to active.
- Actions: charge_invoice, update_subscription_payment_method
- Description: Fail a charge, move the subscription to a good card, advance one day so the dunning job fires, and check the paid invoice, the active subscription and a succeeded payment.

```js
(ctx) => { const cus = ctx.api('POST', '/customers', { first_name: 'Fay', last_name: 'Recovered', email: 'fay.recovered.t4@example.test' }).body; const plan = ctx.api('POST', '/plans', { name: 'Test Plan T4', price: 1800, interval: 'monthly' }).body; const bad = ctx.api('POST', '/payment_methods', { customer_id: cus.id, kind: 'card', last_four: '7004', card_state: 'declined' }).body; const good = ctx.api('POST', '/payment_methods', { customer_id: cus.id, kind: 'card', last_four: '7014', card_state: 'good' }).body; const sub = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id, payment_method_id: bad.id }).body; const inv = ctx.api('GET', '/invoices?subscription_id=' + sub.id).body.data[0]; ctx.api('POST', '/invoices/' + inv.id + '/charge'); const u = ctx.api('POST', '/subscriptions/' + sub.id + '/payment_method', { payment_method_id: good.id }); ctx.assert(u.status === 200, 'card change failed: ' + JSON.stringify(u.body)); ctx.advance('1d'); const i = ctx.api('GET', '/invoices/' + inv.id).body; ctx.assert(i.status === 'paid' && i.paid_at !== null, 'retry should pay the invoice: ' + JSON.stringify(i)); ctx.assert(ctx.api('GET', '/subscriptions/' + sub.id).body.status === 'active', 'subscription should be active again'); const pays = ctx.api('GET', '/payments?invoice_id=' + inv.id).body.data; ctx.assert(pays.some((p) => p.outcome === 'succeeded' && p.payment_method_id === good.id), 'a succeeded payment on the good card is expected'); }
```
### cancel_voids_open_invoices
- Intent: Cancelling an active subscription sets cancelled_at and voids its open invoice; cancelling again is refused.
- Actions: cancel_subscription
- Description: Cancel an active subscription, check the cancelled subscription, the void invoice and the refused second cancel.

```js
(ctx) => { const cus = ctx.api('POST', '/customers', { first_name: 'Gus', last_name: 'Cancel', email: 'gus.cancel.t5@example.test' }).body; const plan = ctx.api('POST', '/plans', { name: 'Test Plan T5', price: 900, interval: 'yearly' }).body; const card = ctx.api('POST', '/payment_methods', { customer_id: cus.id, kind: 'card', last_four: '7005', card_state: 'good' }).body; const sub = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id, payment_method_id: card.id }).body; const inv = ctx.api('GET', '/invoices?subscription_id=' + sub.id).body.data[0]; const r = ctx.api('POST', '/subscriptions/' + sub.id + '/cancel'); ctx.assert(r.status === 200 && r.body.status === 'cancelled' && r.body.cancelled_at !== null, 'cancel failed: ' + JSON.stringify(r.body)); ctx.assert(ctx.api('GET', '/invoices/' + inv.id).body.status === 'void', 'open invoice should be void'); const again = ctx.api('POST', '/subscriptions/' + sub.id + '/cancel'); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel should answer 409 invalid_state: ' + JSON.stringify(again.body)); }
```
### cancelled_refuses_charge
- Intent: A cancelled subscription's invoice cannot be charged.
- Actions: cancel_subscription, charge_invoice
- Description: Cancel a subscription and try to charge its invoice; the charge answers 409 invalid_state.

```js
(ctx) => { const cus = ctx.api('POST', '/customers', { first_name: 'Hugo', last_name: 'Frozen', email: 'hugo.frozen.t6@example.test' }).body; const plan = ctx.api('POST', '/plans', { name: 'Test Plan T6', price: 700, interval: 'monthly' }).body; const card = ctx.api('POST', '/payment_methods', { customer_id: cus.id, kind: 'card', last_four: '7006', card_state: 'good' }).body; const sub = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id, payment_method_id: card.id }).body; const inv = ctx.api('GET', '/invoices?subscription_id=' + sub.id).body.data[0]; ctx.assert(ctx.api('POST', '/subscriptions/' + sub.id + '/cancel').status === 200, 'cancel should succeed'); const r = ctx.api('POST', '/invoices/' + inv.id + '/charge'); ctx.assert(r.status === 409 && r.body.error.code === 'invalid_state', 'charge should be refused with invalid_state: ' + JSON.stringify(r.body)); ctx.assert(ctx.api('GET', '/payments?invoice_id=' + inv.id).body.data.length === 0, 'no payment row should be written'); }
```
### paid_invoice_refuses_charge
- Intent: A paid invoice cannot be charged again; the second charge answers 409 invalid_state and writes no payment row.
- Actions: charge_invoice
- Description: Charge an invoice on a good card so it is paid, then charge it again and check the 409 invalid_state refusal and the single succeeded payment.

```js
(ctx) => { const cus = ctx.api('POST', '/customers', { first_name: 'Iris', last_name: 'Settled', email: 'iris.settled.t8@example.test' }).body; const plan = ctx.api('POST', '/plans', { name: 'Test Plan T8', price: 1200, interval: 'monthly' }).body; const card = ctx.api('POST', '/payment_methods', { customer_id: cus.id, kind: 'card', last_four: '7008', card_state: 'good' }).body; const sub = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id, payment_method_id: card.id }).body; const inv = ctx.api('GET', '/invoices?subscription_id=' + sub.id).body.data[0]; const paid = ctx.api('POST', '/invoices/' + inv.id + '/charge'); ctx.assert(paid.status === 200 && paid.body.status === 'paid', 'first charge should pay: ' + JSON.stringify(paid.body)); const again = ctx.api('POST', '/invoices/' + inv.id + '/charge'); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'a paid invoice cannot be charged again: ' + JSON.stringify(again.body)); ctx.assert(ctx.api('GET', '/payments?invoice_id=' + inv.id).body.data.length === 1, 'only the first payment row should exist'); }
```
### payment_method_must_belong
- Intent: A subscription can only take a card of its own customer; another customer's card is refused and the subscription keeps its card.
- Actions: update_subscription_payment_method
- Description: Try to put another customer's card on a subscription; the call answers 422 payment_method.not_owned and the subscription keeps its card.

```js
(ctx) => { const a = ctx.api('POST', '/customers', { first_name: 'Ada', last_name: 'Owner', email: 'ada.owner.t7@example.test' }).body; const b = ctx.api('POST', '/customers', { first_name: 'Bo', last_name: 'Stranger', email: 'bo.stranger.t7@example.test' }).body; const plan = ctx.api('POST', '/plans', { name: 'Test Plan T7', price: 1100, interval: 'monthly' }).body; const cardA = ctx.api('POST', '/payment_methods', { customer_id: a.id, kind: 'card', last_four: '7007', card_state: 'good' }).body; const cardB = ctx.api('POST', '/payment_methods', { customer_id: b.id, kind: 'card', last_four: '7017', card_state: 'good' }).body; const sub = ctx.api('POST', '/subscriptions', { customer_id: a.id, plan_id: plan.id, payment_method_id: cardA.id }).body; const r = ctx.api('POST', '/subscriptions/' + sub.id + '/payment_method', { payment_method_id: cardB.id }); ctx.assert(r.status === 422 && r.body.error.code === 'payment_method.not_owned', 'foreign card should be refused: ' + JSON.stringify(r.body)); ctx.assert(ctx.api('GET', '/subscriptions/' + sub.id).body.payment_method_id === cardA.id, 'the subscription keeps its card'); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `create_customer` | POST | /customers | Create a customer for tests and agents. |
| `list_customers` | GET | /customers | List customers, filter by email or last_name. |
| `get_customer` | GET | /customers/{id} | Read one customer. |
| `create_plan` | POST | /plans | Create a plan. |
| `list_plans` | GET | /plans | List plans. |
| `get_plan` | GET | /plans/{id} | Read one plan. |
| `create_payment_method` | POST | /payment_methods | Add a card to a customer. |
| `list_payment_methods` | GET | /payment_methods | List cards, filter by customer_id. |
| `get_payment_method` | GET | /payment_methods/{id} | Read one card. |
| `list_subscriptions` | GET | /subscriptions | List subscriptions, filter by customer_id and status. |
| `get_subscription` | GET | /subscriptions/{id} | Read one subscription. |
| `list_invoices` | GET | /invoices | List invoices, filter by subscription_id and status. |
| `get_invoice` | GET | /invoices/{id} | Read one invoice. |
| `list_payments` | GET | /payments | List payment attempts, filter by invoice_id and outcome. |
| `get_payment` | GET | /payments/{id} | Read one payment attempt. |

## Seed

- Rows per entity: customer: 12, plan: 3, payment_method: 16, subscription: 12, invoice: 28, payment: 30
- Mix: Named customers: Ruth Adeyemi (ruth.adeyemi@example.com) has one active Basic subscription; Marco Bellini (marco.bellini@example.com) has a past_due subscription whose invoice is past_due, a declined card on file and a good card ending 4417; Hana Kowalski (hana.kowalski@example.com) has a past_due Plus subscription with a past_due invoice, an active Basic subscription and a good card ending 2208. Other rows spread over all states. Seeded past_due invoices carry attempts and first_failed_at before the clock start, and next_retry_at after it. Seed never uses last_four values 7001 to 7099 or emails under example.test, which the tests create.
- State mix: subscription: active 58%, past_due 25%, cancelled 17%; invoice: open 15%, paid 60%, past_due 15%, void 10%

## Tasks

- `cancel_ruth_subscription` (easy, irreversible): Ruth Adeyemi (ruth.adeyemi@example.com) wants to stop her subscription. Cancel her active subscription.
  - Actions: `cancel_subscription`
  - Decoy idea: cancels the subscription of a different customer with a similar plan
- `collect_marco_with_new_card` (medium, permissions): Marco Bellini's subscription is past due because his card was declined. He has added a new card ending in 4417. Put that card on his subscription and collect the unpaid invoice.
  - Actions: `update_subscription_payment_method`, `charge_invoice`
  - Decoy idea: charges the unpaid invoice on the declined card without changing the subscription's card
  - Pressure: seeded rows in subscription.past_due, invoice.past_due
- `move_hana_plus_and_cancel_basic` (hard, irreversible): Hana Kowalski's Plus subscription is past due. Put her card ending in 2208 on the Plus subscription and collect its unpaid invoice. Then cancel her other subscription, the Basic one, which she no longer wants.
  - Actions: `update_subscription_payment_method`, `charge_invoice`, `cancel_subscription`
  - Decoy idea: cancels the past_due Plus subscription instead of the Basic one, or skips the card change and charges the declined card
  - Pressure: seeded rows in subscription.past_due, invoice.past_due; distractor rows of subscription

## Open questions

- Are retries counted from the first failure or from the previous retry?
  - Default answer: From the first failure: days 1, 3 and 7 after it.
- Does the subscription's invoice get voided when dunning cancels the subscription?
  - Default answer: Yes, the open or past_due invoice becomes void.
- Does a manual charge reset the dunning schedule?
  - Default answer: No; it counts as an attempt and only a success clears the schedule.
- Is the currency USD?
  - Default answer: Yes, amounts in cents.
- Are renewals generated each period?
  - Default answer: No; one invoice is created with the subscription.

## Assumptions

- Dunning retries are 1, 3 and 7 days after the first failure (first_failed_at); the fourth attempt, the day-7 retry, failing cancels the subscription and voids its invoice.
  - Why: The request says retries after 1, 3 and 7 days then cancel; anchoring to the first failure makes the schedule deterministic.
- The first failed charge sets next_retry_at to first_failed_at plus 1 day; each later failure sets it to the next offset (3 days after attempt 2, 7 days after attempt 3).
  - Why: The day-1 retry needs a stored due time for the hourly job to find; without it the schedule of retries 1, 3 and 7 days is undefined.
- The dunning job runs every 1h so each retry fires at its due time within the advance that reaches it.
  - Why: A daily job would fire retries late; hourly keeps day-exact retries without a per-invoice timer.
- Each invoice is created with its subscription at the plan price in USD cents, and no recurring renewal cycles are generated.
  - Why: The request names invoices and card payments, not period renewal; one invoice per subscription keeps the world finite.
- A card decline is simulated by card_state declined on the payment method.
  - Why: No payment network exists in the world; a declared field is the only deterministic way to choose the outcome.
- A manual charge on a past_due invoice counts as an attempt and does not reset the dunning schedule; a success clears it.
  - Why: Keeps attempt counting one rule, consistent with dunning being the sole retry driver.
- Tests use emails under example.test, plan names starting with Test Plan, and last_four 7001 to 7099; the seed avoids these values.
  - Why: Avoids test.seed_collision while keeping test rows unique.
- Clock starts at 2026-10-09T09:00:00.000Z with tick 0s, after all seeded history.
  - Why: Explicit deterministic time; seeded history precedes the start.

## Out of scope

- Recurring renewal billing cycles and proration
  - Why: Requested scope is dunning and payment collection, not the period engine.
- Refunds and credit notes
  - Why: Not mentioned in the request.
- Tax, currencies other than USD, and discounts
  - Why: Not mentioned in the request.
- Webhooks and dunning emails
  - Why: Outbound notifications are not stateful records an agent reads.

## Changes

None. The plan changes no existing item.
