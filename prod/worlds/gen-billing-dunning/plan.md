# WorldGen plan: Stripe Billing-style subscription billing (customers, plans, subscriptions, invoices, card payments, and smart-retry dunning)

A subscription billing system. Customers hold card payment methods and subscribe to plans. Each billing period produces an invoice that is charged to the customer's default card. A failed charge puts the subscription in past_due and starts dunning. The invoice is retried 1, 3 and 7 days after the first failure. If the 7-day retry also fails, the invoice becomes uncollectible and the subscription is cancelled. Agents can subscribe customers, switch their default card, collect invoices manually, change plans and cancel subscriptions. Hourly jobs renew subscriptions and run the dunning retries. Card outcomes are deterministic: each payment method carries a test token that decides whether charges succeed or how they fail.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `plan` | A priced subscription offering. Billed every month (30 days) or year (365 days) in USD. Inactive plans cannot take new subscriptions or plan changes. | name, code (unique), amount (money USD minor units), interval (month\|year), active |
| `customer` | A billing account holder. default_payment_method_id is the card charged for every invoice. It is readonly and set only by the set_default_payment_method action. | name, email (unique), default_payment_method_id (nullable ref payment_method, readonly) |
| `payment_method` | A card on file for a customer. The token field is a deterministic test token: tok_visa always succeeds, tok_chargeDeclined fails with card_declined, tok_insufficient_funds fails with insufficient_funds, tok_expired_card fails with expired_card. | customer_id, brand, last4, exp_month, exp_year, token, active |
| `subscription` | A customer's recurring purchase of a plan. Lifecycle active, past_due, canceled. Holds the current billing period. Readonly fields, changed only by actions and jobs. | customer_id, plan_id, status (state), current_period_start, current_period_end, canceled_at, cancel_reason (requested\|dunning_exhausted) |
| `invoice` | A charge for one billing period. Also holds the dunning state: attempt_count (1 to 4 failed or total charge attempts), dunning_started_at, next_retry_at, last_failure_code. Status open, paid, void or uncollectible. | number (unique), subscription_id, customer_id, amount_due, status (state), period_start, period_end, attempt_count, dunning_started_at, next_retry_at, last_failure_code, paid_at |
| `payment` | One card charge attempt against an invoice, successful or failed. Failed attempts are kept as history. | invoice_id, payment_method_id (nullable), amount, status (succeeded\|failed), failure_code, kind (initial\|renewal\|retry\|manual) |
| `billing_event` | Append-only audit trail for a subscription: created, renewed, payment_failed, payment_succeeded, retry_scheduled, past_due, reactivated, plan_changed, canceled. Written by actions and jobs. | subscription_id, invoice_id (nullable), kind, note |

## Workflows

### subscription_lifecycle (subscription)
- States: active, past_due, canceled
- Actions: subscribe, cancel_subscription, change_plan
- Rules:
  - subscribe: the customer must exist and have a default payment method (or the named payment_method_id, which belongs to the customer and becomes default). The plan must be active. The customer must not already have a non-canceled subscription to the same plan (409 duplicate_subscription). Missing card gives 409 no_payment_method. Inactive plan gives 409 plan_inactive.
  - subscribe creates the subscription with period [now, now + 30d or 365d), creates invoice number INV-<seq> for the plan amount, charges it at once (kind initial) and logs a created event. It answers 201 with the subscription even when the charge fails.
  - First charge succeeds: subscription active, invoice paid. First charge fails: subscription past_due, invoice open, dunning starts.
  - Renewal (job): an active subscription whose current_period_end <= now gets a new invoice for the current plan amount covering [old end, old end + interval). The period advances at once. The charge uses kind renewal. Failure moves the subscription to past_due. Past_due and canceled subscriptions are never renewed.
  - A successful payment of the open invoice of a past_due subscription (retry or manual) moves it back to active and logs reactivated. The billing period is unchanged.
  - cancel_subscription: allowed from active and past_due only (409 invalid_state otherwise). Sets status canceled, canceled_at, cancel_reason requested. Any open invoice becomes void, with next_retry_at cleared. Paid invoices stay paid.
  - Dunning exhaustion cancels with cancel_reason dunning_exhausted.
  - change_plan: not for canceled subscriptions (409 invalid_state). The new plan must be active (409 plan_inactive) and different (409 no_change). Only plan_id changes. The current invoice is not touched and the new amount applies from the next renewal. No proration.
### invoice_dunning (invoice)
- States: open, paid, void, uncollectible
- Actions: pay_invoice
- Rules:
  - Invoice transitions: open to paid, void or uncollectible. All other states are final.
  - attempt_count counts charge attempts made by the invoice flow (initial or renewal, then retries). Manual payments never change it.
  - First failed charge: attempt_count 1, dunning_started_at = failure time, next_retry_at = dunning_started_at + 1d, last_failure_code set, subscription past_due.
  - Retry job, every hour: for open invoices of past_due subscriptions with attempt_count between 1 and 3 and next_retry_at <= now, charge the customer's current default card (kind retry). If the customer has no usable default card the attempt fails with no_payment_method.
  - Retry succeeds: invoice paid with paid_at, next_retry_at cleared, subscription active.
  - Retry fails: attempt_count increases. The 2nd attempt sets next_retry_at = dunning_started_at + 3d. The 3rd sets dunning_started_at + 7d. If the 4th attempt (the 7-day retry) fails, the invoice becomes uncollectible, next_retry_at is cleared and the subscription is cancelled with cancel_reason dunning_exhausted.
  - Retry days are measured from the first failure, not from the previous retry.
  - pay_invoice: only open invoices (409 invoice_not_open). Optional payment_method_id must belong to the invoice's customer and be active (409 payment_method_mismatch). Otherwise the default card is used. With no card, 409 no_payment_method. A declined manual charge answers 200 with the failed payment, records it with kind manual, and leaves attempt_count and next_retry_at unchanged. A successful one pays the invoice and reactivates a past_due subscription.
### default_card (customer)
- States: no_default, has_default
- Actions: set_default_payment_method
- Rules:
  - set_default_payment_method takes payment_method_id. The card must belong to the customer (409 payment_method_mismatch) and be active (409 payment_method_inactive). Unknown customer path gives 404 not_found.
  - The retry job always charges the card that is default at retry time, so replacing a declined default card before the next retry lets dunning recover the invoice.
  - This is a conceptual workflow. It is not a state field. The customer entity has no state column.

## Jobs

- `billing_cycle` runs every 1h: Renew active subscriptions whose current_period_end <= now: create the next invoice at the current plan amount, advance the period from the old end (not from now), charge the default card (kind renewal), log renewed and payment events. On failure start dunning and mark the subscription past_due. Skip past_due and canceled subscriptions.
- `dunning_retry` runs every 1h: Retry open invoices of past_due subscriptions with attempt_count 1 to 3 and next_retry_at <= now against the customer's current default card. On success pay the invoice and reactivate the subscription. On failure bump attempt_count and schedule the next retry at dunning_started_at + 3d then + 7d. When the 4th attempt fails, mark the invoice uncollectible and cancel the subscription with reason dunning_exhausted. Log payment_failed, retry_scheduled, canceled, payment_succeeded and reactivated events.

## Acceptance tests

### subscribe_success_charges_first_invoice
- Intent: Subscribing with a good card creates an active subscription and a paid first invoice with one succeeded payment.
- Actions: subscribe, set_default_payment_method
- Description: A customer with a tok_visa default card subscribes to a 4900 monthly plan. The subscription is active with a 30-day period, the invoice is paid and one succeeded initial payment exists.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  ctx.assert(ctx.now() === '2026-10-06T09:00:00.000Z', 'clock starts at 2026-10-06T09:00:00.000Z, got ' + ctx.now());
  const cus = post('/customers', { name: 'Good Card Co', email: 'ap@goodcardco.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_ok', amount: 4900, interval: 'month' });
  const pm = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  const def = post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: pm.id });
  ctx.assert(def.default_payment_method_id === pm.id, 'default card set, got ' + JSON.stringify(def));
  const r = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(r.status === 201, 'subscribe returned ' + r.status + ' ' + JSON.stringify(r.body));
  const sub = r.body;
  ctx.assert(sub.status === 'active' && sub.customer_id === cus.id && sub.plan_id === plan.id, 'active subscription, got ' + JSON.stringify(sub));
  ctx.assert(sub.current_period_start === '2026-10-06T09:00:00.000Z' && sub.current_period_end === '2026-11-05T09:00:00.000Z', 'period is 30 days from start, got ' + sub.current_period_start + ' to ' + sub.current_period_end);
  const invs = ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data;
  ctx.assert(invs.length === 1, 'one invoice, got ' + invs.length);
  ctx.assert(invs[0].status === 'paid' && invs[0].amount_due === 4900 && invs[0].attempt_count === 1 && invs[0].paid_at === '2026-10-06T09:00:00.000Z' && invs[0].next_retry_at === null, 'invoice paid for 4900, got ' + JSON.stringify(invs[0]));
  const pays = ctx.api('GET', '/invoices/' + invs[0].id + '/payments').body.data;
  ctx.assert(pays.length === 1 && pays[0].status === 'succeeded' && pays[0].kind === 'initial' && pays[0].amount === 4900 && pays[0].payment_method_id === pm.id, 'one succeeded initial payment, got ' + JSON.stringify(pays));
}
```
### declined_first_charge_starts_dunning
- Intent: A declined first charge leaves the subscription past_due with an open invoice and a retry scheduled for 1 day later.
- Actions: subscribe, set_default_payment_method
- Description: A customer whose only card fails with insufficient_funds subscribes. The call still answers 201. The subscription is past_due, the invoice is open with attempt_count 1, next_retry_at one day out and a failed payment on record.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Declined Co', email: 'ap@declinedco.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_declined', amount: 4900, interval: 'month' });
  const pm = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '0341', exp_month: 12, exp_year: 2030, token: 'tok_insufficient_funds' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: pm.id });
  const r = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(r.status === 201, 'subscribe returned ' + r.status + ' ' + JSON.stringify(r.body));
  ctx.assert(r.body.status === 'past_due', 'subscription is past_due, got ' + r.body.status);
  const invs = ctx.api('GET', '/subscriptions/' + r.body.id + '/invoices').body.data;
  ctx.assert(invs.length === 1, 'one invoice, got ' + invs.length);
  const inv = invs[0];
  ctx.assert(inv.status === 'open' && inv.attempt_count === 1 && inv.paid_at === null, 'open invoice with one attempt, got ' + JSON.stringify(inv));
  ctx.assert(inv.dunning_started_at === '2026-10-06T09:00:00.000Z' && inv.next_retry_at === '2026-10-07T09:00:00.000Z', 'first retry one day after the failure, got ' + inv.dunning_started_at + ' / ' + inv.next_retry_at);
  ctx.assert(inv.last_failure_code === 'insufficient_funds', 'failure code insufficient_funds, got ' + inv.last_failure_code);
  const pays = ctx.api('GET', '/invoices/' + inv.id + '/payments').body.data;
  ctx.assert(pays.length === 1 && pays[0].status === 'failed' && pays[0].failure_code === 'insufficient_funds' && pays[0].kind === 'initial', 'one failed initial payment, got ' + JSON.stringify(pays));
  const events = ctx.api('GET', '/subscriptions/' + r.body.id + '/events').body.data.map((e) => e.kind);
  ctx.assert(events.includes('payment_failed') && events.includes('past_due') && events.includes('retry_scheduled'), 'events record the failure, got ' + JSON.stringify(events));
}
```
### dunning_retries_at_1_3_7_days_then_cancels
- Intent: With a card that keeps failing, retries happen 1, 3 and 7 days after the first failure, then the invoice is uncollectible and the subscription cancelled.
- Actions: subscribe, set_default_payment_method
- Description: No retry fires early. At 24h the second attempt runs and the next retry is day 3. At 3d the third runs and the next retry is day 7. At 7d the fourth attempt fails and the subscription is cancelled with dunning_exhausted. Nothing more is charged afterwards.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Always Declined Co', email: 'ap@alwaysdeclined.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_dunning', amount: 4900, interval: 'month' });
  const pm = post('/payment_methods', { customer_id: cus.id, brand: 'mastercard', last4: '9995', exp_month: 12, exp_year: 2030, token: 'tok_chargeDeclined' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: pm.id });
  const sub = post('/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(sub.status === 'past_due', 'starts past_due, got ' + sub.status);
  const inv = () => ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data[0];
  const subNow = () => ctx.api('GET', '/subscriptions/' + sub.id).body;
  ctx.advance('12h');
  ctx.assert(inv().attempt_count === 1 && inv().next_retry_at === '2026-10-07T09:00:00.000Z', 'no retry before day 1, got ' + JSON.stringify(inv()));
  ctx.advance('12h');
  ctx.assert(inv().attempt_count === 2 && inv().status === 'open', 'second attempt after day 1, got ' + JSON.stringify(inv()));
  ctx.assert(inv().next_retry_at === '2026-10-09T09:00:00.000Z', 'next retry on day 3, got ' + inv().next_retry_at);
  ctx.assert(subNow().status === 'past_due', 'still past_due after retry 1, got ' + subNow().status);
  ctx.advance('2d');
  ctx.assert(inv().attempt_count === 3 && inv().status === 'open', 'third attempt after day 3, got ' + JSON.stringify(inv()));
  ctx.assert(inv().next_retry_at === '2026-10-13T09:00:00.000Z', 'next retry on day 7 after the first failure, got ' + inv().next_retry_at);
  ctx.assert(subNow().status === 'past_due', 'still past_due after retry 2, got ' + subNow().status);
  ctx.advance('4d');
  const last = inv();
  ctx.assert(last.attempt_count === 4 && last.status === 'uncollectible' && last.next_retry_at === null, 'invoice uncollectible after the day 7 retry, got ' + JSON.stringify(last));
  const s = subNow();
  ctx.assert(s.status === 'canceled' && s.cancel_reason === 'dunning_exhausted' && s.canceled_at !== null, 'subscription cancelled by dunning, got ' + JSON.stringify(s));
  const pays = ctx.api('GET', '/invoices/' + last.id + '/payments').body.data;
  ctx.assert(pays.length === 4 && pays.every((p) => p.status === 'failed'), 'four failed payments, got ' + JSON.stringify(pays.map((p) => p.status)));
  ctx.assert(pays.filter((p) => p.kind === 'retry').length === 3, 'three retry payments, got ' + JSON.stringify(pays.map((p) => p.kind)));
  ctx.advance('30d');
  ctx.assert(ctx.api('GET', '/invoices/' + last.id + '/payments').body.data.length === 4, 'no more charges after cancellation');
  ctx.assert(ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data.length === 1, 'no new invoices for a cancelled subscription');
}
```
### new_default_card_recovers_in_dunning
- Intent: Replacing the failing default card before the next retry lets the retry succeed, paying the invoice and reactivating the subscription.
- Actions: subscribe, set_default_payment_method
- Description: The first charge fails. The customer gets a good card as default. After the day 1 retry fires, the invoice is paid with attempt_count 2, the subscription is active again and the payments are one failed then one succeeded retry.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Recovering Co', email: 'ap@recoveringco.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_recover', amount: 4900, interval: 'month' });
  const bad = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '0069', exp_month: 1, exp_year: 2026, token: 'tok_expired_card' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: bad.id });
  const sub = post('/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(sub.status === 'past_due', 'starts past_due, got ' + sub.status);
  const inv0 = ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data[0];
  ctx.assert(inv0.last_failure_code === 'expired_card', 'expired card failure, got ' + inv0.last_failure_code);
  const good = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: good.id });
  ctx.advance('25h');
  const inv = ctx.api('GET', '/invoices/' + inv0.id).body;
  ctx.assert(inv.status === 'paid' && inv.attempt_count === 2 && inv.paid_at !== null && inv.next_retry_at === null, 'invoice paid by the first retry, got ' + JSON.stringify(inv));
  const s = ctx.api('GET', '/subscriptions/' + sub.id).body;
  ctx.assert(s.status === 'active' && s.canceled_at === null, 'subscription active again, got ' + JSON.stringify(s));
  const pays = ctx.api('GET', '/invoices/' + inv0.id + '/payments').body.data;
  const failed = pays.filter((p) => p.status === 'failed');
  const ok = pays.filter((p) => p.status === 'succeeded');
  ctx.assert(pays.length === 2 && failed.length === 1 && ok.length === 1, 'one failed and one succeeded payment, got ' + JSON.stringify(pays));
  ctx.assert(ok[0].kind === 'retry' && ok[0].payment_method_id === good.id, 'retry used the new default card, got ' + JSON.stringify(ok[0]));
  const events = ctx.api('GET', '/subscriptions/' + sub.id + '/events').body.data.map((e) => e.kind);
  ctx.assert(events.includes('reactivated') && events.includes('payment_succeeded'), 'events record recovery, got ' + JSON.stringify(events));
}
```
### pay_invoice_manual_collection
- Intent: pay_invoice charges an open invoice now. A decline is recorded without touching the dunning schedule, and a success pays the invoice and reactivates the subscription.
- Actions: subscribe, set_default_payment_method, pay_invoice
- Description: A past_due invoice is paid manually first with the failing default card (200 with a failed payment, dunning unchanged), then with a named good card (invoice paid, subscription active). Paying again answers 409 invoice_not_open.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Manual Pay Co', email: 'ap@manualpayco.example' });
  const other = post('/customers', { name: 'Other Co', email: 'ap@otherco.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_manual', amount: 4900, interval: 'month' });
  const bad = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '0341', exp_month: 12, exp_year: 2030, token: 'tok_insufficient_funds' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: bad.id });
  const sub = post('/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  const inv0 = ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data[0];
  const still = ctx.api('POST', '/invoices/' + inv0.id + '/pay', {});
  ctx.assert(still.status === 200 && still.body.status === 'failed' && still.body.failure_code === 'insufficient_funds' && still.body.kind === 'manual', 'declined manual charge is a 200 failed payment, got ' + still.status + ' ' + JSON.stringify(still.body));
  const afterFail = ctx.api('GET', '/invoices/' + inv0.id).body;
  ctx.assert(afterFail.status === 'open' && afterFail.attempt_count === 1 && afterFail.next_retry_at === '2026-10-07T09:00:00.000Z', 'dunning schedule untouched by a manual failure, got ' + JSON.stringify(afterFail));
  const foreign = post('/payment_methods', { customer_id: other.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  const mismatch = ctx.api('POST', '/invoices/' + inv0.id + '/pay', { payment_method_id: foreign.id });
  ctx.assert(mismatch.status === 409 && mismatch.body.error.code === 'payment_method_mismatch', 'foreign card refused, got ' + JSON.stringify(mismatch));
  const good = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '4444', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  const paid = ctx.api('POST', '/invoices/' + inv0.id + '/pay', { payment_method_id: good.id });
  ctx.assert(paid.status === 200 && paid.body.status === 'succeeded' && paid.body.payment_method_id === good.id, 'named good card succeeds, got ' + JSON.stringify(paid));
  const inv = ctx.api('GET', '/invoices/' + inv0.id).body;
  ctx.assert(inv.status === 'paid' && inv.paid_at === '2026-10-06T09:00:00.000Z' && inv.next_retry_at === null, 'invoice paid, got ' + JSON.stringify(inv));
  ctx.assert(ctx.api('GET', '/subscriptions/' + sub.id).body.status === 'active', 'subscription reactivated');
  const again = ctx.api('POST', '/invoices/' + inv0.id + '/pay', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invoice_not_open', 'paid invoice cannot be paid again, got ' + JSON.stringify(again));
  const missing = ctx.api('POST', '/invoices/inv_9999/pay', {});
  ctx.assert(missing.status === 404 && missing.body.error.code === 'not_found', 'unknown invoice is 404, got ' + JSON.stringify(missing));
}
```
### cancel_stops_dunning
- Intent: Cancelling a past_due subscription voids its open invoice and stops all retries. Cancelling twice is refused.
- Actions: subscribe, set_default_payment_method, cancel_subscription
- Description: After a failed first charge the subscription is cancelled. It becomes canceled with cancel_reason requested, the open invoice is void, and 8 days later no retry payments exist. A second cancel answers 409 invalid_state.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Cancelling Co', email: 'ap@cancellingco.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_cancel', amount: 4900, interval: 'month' });
  const pm = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '0002', exp_month: 12, exp_year: 2030, token: 'tok_chargeDeclined' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: pm.id });
  const sub = post('/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(sub.status === 'past_due', 'starts past_due');
  const r = ctx.api('POST', '/subscriptions/' + sub.id + '/cancel', {});
  ctx.assert(r.status === 200 && r.body.status === 'canceled' && r.body.cancel_reason === 'requested' && r.body.canceled_at === '2026-10-06T09:00:00.000Z', 'cancelled on request, got ' + r.status + ' ' + JSON.stringify(r.body));
  const inv = ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data[0];
  ctx.assert(inv.status === 'void' && inv.next_retry_at === null, 'open invoice voided, got ' + JSON.stringify(inv));
  ctx.advance('8d');
  const pays = ctx.api('GET', '/invoices/' + inv.id + '/payments').body.data;
  ctx.assert(pays.length === 1, 'no retries after cancellation, got ' + pays.length + ' payments');
  ctx.assert(ctx.api('GET', '/invoices/' + inv.id).body.status === 'void', 'invoice stays void, not uncollectible');
  const again = ctx.api('POST', '/subscriptions/' + sub.id + '/cancel', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel refused, got ' + JSON.stringify(again));
  const missing = ctx.api('POST', '/subscriptions/sub_9999/cancel', {});
  ctx.assert(missing.status === 404 && missing.body.error.code === 'not_found', 'unknown subscription is 404, got ' + JSON.stringify(missing));
  const good = post('/customers', { name: 'Happy Co', email: 'ap@happyco.example' });
  const gpm = post('/payment_methods', { customer_id: good.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  post('/customers/' + good.id + '/default_payment_method', { payment_method_id: gpm.id });
  const gsub = post('/subscriptions', { customer_id: good.id, plan_id: plan.id });
  const gc = ctx.api('POST', '/subscriptions/' + gsub.id + '/cancel', {});
  ctx.assert(gc.status === 200 && gc.body.status === 'canceled', 'active subscription cancels, got ' + JSON.stringify(gc));
  ctx.assert(ctx.api('GET', '/subscriptions/' + gsub.id + '/invoices').body.data[0].status === 'paid', 'paid invoice stays paid');
}
```
### renewal_creates_next_invoice
- Intent: An active subscription is renewed when its period ends: a new invoice for the next period is created and charged, and the period advances by one interval.
- Actions: subscribe, set_default_payment_method
- Description: After 31 days a 30-day subscription has a second paid invoice. Its period starts where the first ended and the subscription period now ends on 2026-12-05. A renewal against a failing card moves the subscription to past_due.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Renewing Co', email: 'ap@renewingco.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_renew', amount: 4900, interval: 'month' });
  const pm = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: pm.id });
  const sub = post('/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  const cus2 = post('/customers', { name: 'Expiring Card Co', email: 'ap@expiringcardco.example' });
  const pm2 = post('/payment_methods', { customer_id: cus2.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  post('/customers/' + cus2.id + '/default_payment_method', { payment_method_id: pm2.id });
  const sub2 = post('/subscriptions', { customer_id: cus2.id, plan_id: plan.id });
  const swap = post('/payment_methods', { customer_id: cus2.id, brand: 'visa', last4: '0069', exp_month: 1, exp_year: 2026, token: 'tok_expired_card' });
  post('/customers/' + cus2.id + '/default_payment_method', { payment_method_id: swap.id });
  ctx.advance('29d');
  ctx.assert(ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data.length === 1, 'no renewal before the period ends');
  ctx.advance('2d');
  const invs = ctx.api('GET', '/subscriptions/' + sub.id + '/invoices?sort=period_start').body.data;
  ctx.assert(invs.length === 2, 'two invoices after renewal, got ' + invs.length);
  ctx.assert(invs[0].status === 'paid' && invs[1].status === 'paid' && invs[1].amount_due === 4900, 'both paid, got ' + JSON.stringify(invs.map((i) => i.status)));
  ctx.assert(invs[1].period_start === invs[0].period_end && invs[1].period_end === '2026-12-05T09:00:00.000Z', 'second period continues the first, got ' + invs[1].period_start + ' to ' + invs[1].period_end);
  const s = ctx.api('GET', '/subscriptions/' + sub.id).body;
  ctx.assert(s.status === 'active' && s.current_period_start === '2026-11-05T09:00:00.000Z' && s.current_period_end === '2026-12-05T09:00:00.000Z', 'period advanced, got ' + JSON.stringify(s));
  const pays = ctx.api('GET', '/invoices/' + invs[1].id + '/payments').body.data;
  ctx.assert(pays.length === 1 && pays[0].kind === 'renewal' && pays[0].status === 'succeeded', 'renewal payment, got ' + JSON.stringify(pays));
  const s2 = ctx.api('GET', '/subscriptions/' + sub2.id).body;
  ctx.assert(s2.status === 'past_due', 'failed renewal starts dunning, got ' + s2.status);
  const inv2 = ctx.api('GET', '/subscriptions/' + sub2.id + '/invoices?sort=period_start').body.data;
  ctx.assert(inv2.length === 2 && inv2[1].status === 'open' && inv2[1].attempt_count === 2 && inv2[1].last_failure_code === 'expired_card' && inv2[1].next_retry_at === '2026-11-08T09:00:00.000Z', 'renewal invoice is in dunning, got ' + JSON.stringify(inv2[1]));
  ctx.assert(inv2[1].next_retry_at !== null && inv2[1].dunning_started_at !== null, 'retry scheduled');
}
```
### change_plan_applies_next_renewal
- Intent: change_plan switches the plan immediately without touching the current invoice. The new price shows up on the next renewal invoice.
- Actions: subscribe, set_default_payment_method, change_plan
- Description: A subscriber on a 900 plan moves to a 4900 plan. The first invoice stays 900 and the renewal invoice is 4900. Same plan, inactive plan and cancelled subscriptions are refused.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Upgrading Co', email: 'ap@upgradingco.example' });
  const small = post('/plans', { name: 'Starter Test', code: 'starter_test_chg', amount: 900, interval: 'month' });
  const big = post('/plans', { name: 'Pro Test', code: 'pro_test_chg', amount: 4900, interval: 'month' });
  const dead = post('/plans', { name: 'Legacy Test', code: 'legacy_test_chg', amount: 1500, interval: 'month', active: false });
  const pm = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: pm.id });
  const sub = post('/subscriptions', { customer_id: cus.id, plan_id: small.id });
  const r = ctx.api('POST', '/subscriptions/' + sub.id + '/change_plan', { plan_id: big.id });
  ctx.assert(r.status === 200 && r.body.plan_id === big.id && r.body.status === 'active', 'plan changed, got ' + r.status + ' ' + JSON.stringify(r.body));
  ctx.assert(r.body.current_period_end === sub.current_period_end, 'period untouched');
  const first = ctx.api('GET', '/subscriptions/' + sub.id + '/invoices').body.data;
  ctx.assert(first.length === 1 && first[0].amount_due === 900 && first[0].status === 'paid', 'current invoice untouched, got ' + JSON.stringify(first));
  const same = ctx.api('POST', '/subscriptions/' + sub.id + '/change_plan', { plan_id: big.id });
  ctx.assert(same.status === 409 && same.body.error.code === 'no_change', 'same plan refused, got ' + JSON.stringify(same));
  const inactive = ctx.api('POST', '/subscriptions/' + sub.id + '/change_plan', { plan_id: dead.id });
  ctx.assert(inactive.status === 409 && inactive.body.error.code === 'plan_inactive', 'inactive plan refused, got ' + JSON.stringify(inactive));
  ctx.advance('31d');
  const invs = ctx.api('GET', '/subscriptions/' + sub.id + '/invoices?sort=period_start').body.data;
  ctx.assert(invs.length === 2 && invs[1].amount_due === 4900, 'renewal bills the new plan, got ' + JSON.stringify(invs.map((i) => i.amount_due)));
  const events = ctx.api('GET', '/subscriptions/' + sub.id + '/events').body.data.map((e) => e.kind);
  ctx.assert(events.includes('plan_changed') && events.includes('renewed'), 'events recorded, got ' + JSON.stringify(events));
  ctx.assert(ctx.api('POST', '/subscriptions/' + sub.id + '/cancel', {}).status === 200, 'cancel works');
  const late = ctx.api('POST', '/subscriptions/' + sub.id + '/change_plan', { plan_id: small.id });
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'cancelled subscription cannot change plan, got ' + JSON.stringify(late));
}
```
### subscribe_and_default_card_refusals
- Intent: Subscribing and setting a default card refuse bad input with clear errors and write nothing.
- Actions: subscribe, set_default_payment_method
- Description: Unknown customer or plan answers 400 input.invalid. No card gives 409 no_payment_method. An inactive plan gives 409 plan_inactive. A duplicate active subscription to the same plan gives 409 duplicate_subscription. Setting another customer's card as default gives 409 payment_method_mismatch, and an unknown customer gives 404.

```js
(ctx) => {
  const post = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status >= 200 && r.status < 300, 'POST ' + p + ' returned ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
  const cus = post('/customers', { name: 'Refusals Co', email: 'ap@refusalsco.example' });
  const other = post('/customers', { name: 'Neighbour Co', email: 'ap@neighbourco.example' });
  const plan = post('/plans', { name: 'Pro Test', code: 'pro_test_ref', amount: 4900, interval: 'month' });
  const dead = post('/plans', { name: 'Legacy Test', code: 'legacy_test_ref', amount: 1500, interval: 'month', active: false });
  const before = ctx.api('GET', '/subscriptions').body.data.length;
  const unknownCus = ctx.api('POST', '/subscriptions', { customer_id: 'cus_9999', plan_id: plan.id });
  ctx.assert(unknownCus.status === 400 && unknownCus.body.error.code === 'input.invalid', 'unknown customer, got ' + JSON.stringify(unknownCus));
  const unknownPlan = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: 'pln_9999' });
  ctx.assert(unknownPlan.status === 400 && unknownPlan.body.error.code === 'input.invalid', 'unknown plan, got ' + JSON.stringify(unknownPlan));
  const noCard = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(noCard.status === 409 && noCard.body.error.code === 'no_payment_method', 'no card, got ' + JSON.stringify(noCard));
  const pm = post('/payment_methods', { customer_id: cus.id, brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  const foreign = post('/payment_methods', { customer_id: other.id, brand: 'visa', last4: '1111', exp_month: 12, exp_year: 2030, token: 'tok_visa' });
  const mism = ctx.api('POST', '/customers/' + cus.id + '/default_payment_method', { payment_method_id: foreign.id });
  ctx.assert(mism.status === 409 && mism.body.error.code === 'payment_method_mismatch', 'foreign card, got ' + JSON.stringify(mism));
  const noCus = ctx.api('POST', '/customers/cus_9999/default_payment_method', { payment_method_id: pm.id });
  ctx.assert(noCus.status === 404 && noCus.body.error.code === 'not_found', 'unknown customer path, got ' + JSON.stringify(noCus));
  post('/customers/' + cus.id + '/default_payment_method', { payment_method_id: pm.id });
  const inactive = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: dead.id });
  ctx.assert(inactive.status === 409 && inactive.body.error.code === 'plan_inactive', 'inactive plan, got ' + JSON.stringify(inactive));
  ctx.assert(ctx.api('GET', '/subscriptions').body.data.length === before, 'refused calls created nothing');
  const ok = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(ok.status === 201 && ok.body.status === 'active', 'subscribe works once a card exists, got ' + JSON.stringify(ok));
  const dup = ctx.api('POST', '/subscriptions', { customer_id: cus.id, plan_id: plan.id });
  ctx.assert(dup.status === 409 && dup.body.error.code === 'duplicate_subscription', 'duplicate, got ' + JSON.stringify(dup));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_plans` | GET | /plans | List plans, filter by interval and active, search by name. |
| `get_plan` | GET | /plans/{id} | Fetch one plan. |
| `create_plan` | POST | /plans | Create a plan (name, code, amount, interval, active). |
| `update_plan` | PATCH | /plans/{id} | Edit a plan, such as deactivating it. |
| `list_customers` | GET | /customers | List customers, search by name or email. |
| `get_customer` | GET | /customers/{id} | Fetch one customer. |
| `create_customer` | POST | /customers | Create a customer (name, email). |
| `update_customer` | PATCH | /customers/{id} | Edit customer name or email. The default payment method is not editable here. |
| `list_payment_methods` | GET | /payment_methods | List cards, filter by customer_id, brand, active. |
| `list_customer_payment_methods` | GET | /customers/{customer_id}/payment_methods | List the cards of one customer. |
| `get_payment_method` | GET | /payment_methods/{id} | Fetch one card. |
| `create_payment_method` | POST | /payment_methods | Attach a card with a test token to a customer. It does not become the default automatically. |
| `list_subscriptions` | GET | /subscriptions | List subscriptions, filter by status, customer_id, plan_id. Sort by current_period_end. |
| `get_subscription` | GET | /subscriptions/{id} | Fetch one subscription. |
| `subscribe` | POST | /subscriptions | Action. Subscribe a customer to a plan and charge the first invoice at once. |
| `cancel_subscription` | POST | /subscriptions/{id}/cancel | Action. Cancel a subscription now and void any open invoice. |
| `change_plan` | POST | /subscriptions/{id}/change_plan | Action. Switch the plan, effective from the next invoice. |
| `list_subscription_events` | GET | /subscriptions/{subscription_id}/events | Audit trail for one subscription. |
| `list_subscription_invoices` | GET | /subscriptions/{subscription_id}/invoices | Invoices of one subscription. |
| `list_invoices` | GET | /invoices | List invoices, filter by status, customer_id, subscription_id, attempt_count, last_failure_code. Sort by next_retry_at or created_at. |
| `get_invoice` | GET | /invoices/{id} | Fetch one invoice. |
| `pay_invoice` | POST | /invoices/{id}/pay | Action. Charge an open invoice now with the default or a named card of the customer. |
| `list_invoice_payments` | GET | /invoices/{invoice_id}/payments | Charge attempts for one invoice. |
| `list_payments` | GET | /payments | List payments, filter by status, failure_code, kind, invoice_id. |
| `get_payment` | GET | /payments/{id} | Fetch one payment. |
| `set_default_payment_method` | POST | /customers/{id}/default_payment_method | Action. Make one of the customer's own active cards the default. |

## Seed

- Rows per entity: plan: 5, customer: 70, payment_method: 110, subscription: 90, invoice: 300, payment: 380, billing_event: 520
- Mix: All history is before 2026-10-06T09:00:00Z and all scheduled times are after it. Plans: Starter (900/month), Pro (4900/month), Business (19900/month), Pro Annual (49000/year) and one inactive legacy plan. Customers: 70, each with 1 to 2 cards. About 25% of cards use a failing token (a mix of tok_insufficient_funds, tok_expired_card and tok_chargeDeclined). Of the cards that are default for a customer with an active subscription, all use tok_visa. Subscriptions: 90, with roughly 55% active, 31% past_due (28 rows, so lists page past 25) and 14% canceled (a mix of requested and dunning_exhausted). The 28 past_due subscriptions sit at dunning stages attempt_count 1 (10), 2 (9) and 3 (9). Each has one open invoice with a consistent dunning_started_at, a future next_retry_at (1d, 3d or 7d after dunning_started_at) and a failure code. Four of the attempt_count 3 rows are on the Business plan, spread across list pages, and the others are on Starter or Pro. Active subscriptions have periods ending 1 to 29 days after the clock start. Invoices: paid history for each active subscription (1 to 6 invoices), one open invoice per past_due subscription, void or uncollectible invoices for canceled subscriptions. Payments: one succeeded payment per paid invoice and failed payments matching each past_due invoice's attempt_count. Named anchors: customers 'Harbor Dental' (active Pro subscription, cancel target) and 'Harbor Dentistry' (similar name, active subscription). 'Bluefin Labs' (past_due at attempt_count 1, failing default card, plus a second tok_visa card ending 4444 on file but not default). Events are derived from the invoices and payments in time order.

## Tasks

- `cancel_harbor_dental_subscription` (easy): The customer Harbor Dental asks to cancel their subscription. Find the customer by name and cancel its one active subscription with the cancel action. The grader checks the subscription is canceled with reason requested and that nothing else changed apart from its events and invoices. Harbor Dentistry, with a near-identical name, must stay untouched.
  - Decoy idea: Cancel the subscription of the similarly named customer Harbor Dentistry, or cancel the first search hit without checking the exact name.
- `recover_bluefin_labs_with_backup_card` (medium): Bluefin Labs' subscription is past due because its default card keeps failing. They have a second card ending in 4444 already on file. Make that card the customer's default, then collect the open invoice now. The grader checks the default is the 4444 card, the invoice is paid by a succeeded payment on that card, the subscription is active again, and no other customer's rows changed. A manual payment must not create extra retry attempts.
  - Decoy idea: Pay the invoice before switching the default card, so the manual charge fails on the old card. Or switch the default card and wait for the retry job, which agents cannot trigger. Or pay with a card of a different customer, or the wrong card ending.
- `cancel_final_retry_business_subscriptions` (hard): Finance wants to stop dunning for the biggest accounts about to take their last retry. Cancel every subscription on the Business plan that is past_due and whose open invoice is on its third attempt (attempt_count 3, so only the 7-day retry is left). The past_due list spans more than one page. Other past_due subscriptions, such as Business ones at earlier stages and non-Business ones at attempt 3, must stay untouched. The grader checks each target is canceled with reason requested and its invoice is void, and that every other row is unchanged.
  - Decoy idea: Read only the first page of past_due subscriptions. Cancel every past_due Business subscription regardless of attempt_count. Cancel all attempt_count 3 invoices regardless of plan. Or pay the invoices instead of cancelling.

## Open questions

- Are the retry days 1, 3 and 7 measured from the first failure, or from the previous retry (1, then 3 days later, then 7 days later)?
  - Default answer: From the first failure. Retries happen on day 1, day 3 and day 7, so dunning lasts 7 days.
- What happens to the subscription when the last retry fails: cancelled outright, or left unpaid for manual review?
  - Default answer: Cancelled outright, with cancel_reason dunning_exhausted. The invoice becomes uncollectible.
- Should the subscription stay active (with access) while dunning runs, or become past_due?
  - Default answer: It becomes past_due on the first failed charge and returns to active on any successful payment.
- Does a manual payment attempt by an agent count as a dunning attempt?
  - Default answer: No. Manual attempts are recorded as payments but do not change attempt_count or the retry schedule.
- How should a failed first charge on a new subscription behave?
  - Default answer: The subscription is created as past_due with an open invoice, and dunning starts exactly as for a failed renewal.
- How are card declines simulated?
  - Default answer: Through a deterministic test token on each payment method (tok_visa, tok_chargeDeclined, tok_insufficient_funds, tok_expired_card).
- Are plans multi-currency, and do plan changes prorate?
  - Default answer: USD only, and no proration. A plan change applies from the next invoice.
- How long is a monthly period?
  - Default answer: 30 days, with 365 days for yearly plans.
- Can a customer hold more than one subscription?
  - Default answer: Yes, but not two non-canceled subscriptions to the same plan.

## Assumptions

- clock.start is 2026-10-06T09:00:00.000Z with tick 0s. All seeded history (created invoices, payments, events, past failures) precedes it. All next_retry_at and current_period_end values in the seed are after it.
  - Why: Time moves only on explicit advance, so dunning tests can assert exact timestamps. Scheduled retries and renewals stay in the future.
- Retry days (1, 3, 7) are counted from the first failed charge (dunning_started_at), not from the previous retry. That gives four attempts in total: day 0, 1, 3 and 7.
  - Why: The request says retries after 1, 3 and 7 days, which in Stripe-style smart retries is the offset from the original failure. Dunning ends 7 days after it started.
- If the day-7 retry fails, the invoice becomes uncollectible and the subscription is canceled with cancel_reason dunning_exhausted.
  - Why: The request says the subscription is cancelled after the retries. A distinct reason lets agents tell it from a customer-requested cancel.
- Retries and renewals run in hourly jobs. A retry is due when next_retry_at <= now and fires at the next job run, which can be up to an hour later than the due time.
  - Why: Jobs fire on a fixed schedule, and an hourly granularity is realistic for billing systems. Tests advance a little past each deadline.
- Card outcomes are deterministic through the test token on each payment_method (tok_visa succeeds, tok_chargeDeclined, tok_insufficient_funds and tok_expired_card fail with matching failure codes). No real processor or random declines.
  - Why: The world must be reproducible. Stripe test tokens are a familiar model.
- The retry job charges whichever card is the customer's default at retry time. Changing the default card between retries is how a customer recovers.
  - Why: This mirrors real dunning, and it gives agents a meaningful fix action.
- Manual pay_invoice is allowed on any open invoice. A failure is recorded as a payment of kind manual but does not change attempt_count or next_retry_at. A success pays the invoice and reactivates a past_due subscription.
  - Why: Manual collection must not accelerate cancellation, and it keeps the dunning schedule predictable.
- A failed first charge at subscribe time still creates the subscription (past_due, invoice open) and answers 201. There is no incomplete state.
  - Why: The request says a failed payment starts dunning, and a single past_due state keeps the lifecycle small.
- A month is 30 days and a year is 365 days. Renewal periods are measured from the previous period end, not from the charge time.
  - Why: The time helpers support only d/h/m/s offsets, and anchoring to the old end keeps renewal timestamps deterministic.
- Currency is USD only. Amounts are integer cents. No tax, proration, coupons, trials or invoice line items. One invoice has one total.
  - Why: These are not needed for the dunning behaviour and would multiply the surface to test.
- Plan changes take effect on the next invoice with no proration. The subscription keeps its current period.
  - Why: Simplest consistent behaviour, and it avoids refund and credit modelling.
- Cancellation is always immediate. There is no cancel_at_period_end. Cancelling voids an open invoice, and paid invoices stay paid with no refunds.
  - Why: The dunning flow needs a clear terminal state, and refunds are out of scope.
- A customer cannot hold two non-canceled subscriptions to the same plan (409 duplicate_subscription), but may hold several to different plans.
  - Why: It avoids accidental duplicate billing and gives agents a realistic guard.
- The default card is changed only through set_default_payment_method. customer.default_payment_method_id is readonly in the generic customer routes, and creating a card does not make it the default.
  - Why: It forces agents to take the explicit step that dunning recovery depends on.
- Failed pay_invoice charges answer 200 with the failed payment. Only validation or state problems answer 4xx.
  - Why: A declined card is business data that must persist. A 4xx from ctx.fail would roll the record back.
- List endpoints use the world default envelope: data and next_cursor, with limit and cursor params. Errors use {error:{code,message}}. Unknown action input refs answer 400 input.invalid and unknown path ids answer 404 not_found.
  - Why: This follows the engine defaults.

## Out of scope

- Real card networks, 3-D Secure, card tokenisation and PCI concerns
  - Why: Outcomes are simulated by a test token so the world stays deterministic.
- Taxes, discounts, coupons, credits, proration and multi-line invoices
  - Why: They are not part of the requested dunning flow.
- Free trials, paused subscriptions, cancel_at_period_end and subscription reactivation after cancellation
  - Why: They would add states and rules beyond the three-state lifecycle.
- Refunds, disputes and chargebacks
  - Why: No money moves back in this flow. Paid invoices stay paid.
- Customer-facing emails, webhooks and payment-failed notifications
  - Why: Agents act through the API. The audit trail in billing_event stands in for notifications.
- Multi-currency, bank debits and wallets
  - Why: Cards in USD are enough for the request.
- Delete routes for any entity
  - Why: Billing records are kept for audit. Cards are deactivated and subscriptions cancelled instead.
- Configurable dunning schedule
  - Why: The 1, 3 and 7 day schedule is fixed by the request.

## Changes

- workflows.default_card
