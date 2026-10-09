# WorldGen report: Stripe Billing-style subscription billing (customers, plans, subscriptions, invoices, card payments, and smart-retry dunning)

A subscription billing system. Customers hold card payment methods and subscribe to plans. Each billing period produces an invoice that is charged to the customer's default card. A failed charge puts the subscription in past_due and starts dunning. The invoice is retried 1, 3 and 7 days after the first failure. If the 7-day retry also fails, the invoice becomes uncollectible and the subscription is cancelled. Agents can subscribe customers, switch their default card, collect invoices manually, change plans and cancel subscriptions. Hourly jobs renew subscriptions and run the dunning retries. Card outcomes are deterministic: each payment method carries a test token that decides whether charges succeed or how they fail.

## What was built

Entities (7):

- `plan`: 5 seeded rows
- `customer`: 70 seeded rows
- `payment_method`: 110 seeded rows
- `subscription`: 90 seeded rows
- `invoice`: 105 seeded rows
- `payment`: 141 seeded rows
- `billing_event`: 364 seeded rows

Routes (21):

- `list_plans`: GET /plans
- `get_plan`: GET /plans/{id}
- `create_plan`: POST /plans
- `update_plan`: PATCH /plans/{id}
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `update_customer`: PATCH /customers/{id}
- `list_payment_methods`: GET /payment_methods
- `list_customer_payment_methods`: GET /customers/{customer_id}/payment_methods
- `get_payment_method`: GET /payment_methods/{id}
- `create_payment_method`: POST /payment_methods
- `list_subscriptions`: GET /subscriptions
- `get_subscription`: GET /subscriptions/{id}
- `list_subscription_events`: GET /subscriptions/{subscription_id}/events
- `list_subscription_invoices`: GET /subscriptions/{subscription_id}/invoices
- `list_invoices`: GET /invoices
- `get_invoice`: GET /invoices/{id}
- `list_invoice_payments`: GET /invoices/{invoice_id}/payments
- `list_payments`: GET /payments
- `get_payment`: GET /payments/{id}

Actions (5):

- `set_default_payment_method`: POST /customers/{id}/default_payment_method
- `subscribe`: POST /subscriptions
- `cancel_subscription`: POST /subscriptions/{id}/cancel
- `change_plan`: POST /subscriptions/{id}/change_plan
- `pay_invoice`: POST /invoices/{id}/pay

Jobs (2):

- `billing_cycle`: every 1h
- `dunning_retry`: every 1h

## Changes

No changes.

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 9 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_f1ab4b835b50b73aacdea8192b6e7ff0b2e1ac745ba09a5086621dbb0fc818c1`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_harbor_dental_subscription | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | legacy; mutants 4/8 | `tid_9fb55867c2764862e2831b5f2f3fe30e3bebfdde8e1dfc3dd63ebbb0147fa3f0` |
| recover_bluefin_labs_with_backup_card | medium | 1.000 | 0.000 | 0.000, 0.300, 0.000, 0.000 | 0.300 | legacy; mutants 4/8 | `tid_e7d7247850627631246ad12bb1342a0bb1073897a6a1d6e92e6e18519e24fee7` |
| cancel_final_retry_business_subscriptions | hard | 1.000 | 0.000 | 0.750, 0.000, 0.000, 0.000, 0.000 | 0.750 | legacy; mutants 4/8 | `tid_7cb3b0529af197657ad6623172e75413a173bf5cd82f8e1e83876050e9a1bc34` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_harbor_dental_subscription` 0.000: cancels the subscription of the similarly named customer Harbor Dentistry instead of Harbor Dental
- `cancel_harbor_dental_subscription` 0.000: cancels the subscriptions of every customer whose name starts with Harbor, so the look-alike account is cancelled too
- `recover_bluefin_labs_with_backup_card` 0.000: collects the invoice first with the old default card, which is declined, and only then switches the default card and pays again
- `recover_bluefin_labs_with_backup_card` 0.300: switches the default card but never collects the invoice, waiting for a retry job that agents cannot trigger
- `recover_bluefin_labs_with_backup_card` 0.000: pays the invoice with the 4444 card by naming it, but never makes it the default card
- `recover_bluefin_labs_with_backup_card` 0.000: attaches a brand new tok_visa card instead of using the backup card already on file, then makes it default and pays
- `cancel_final_retry_business_subscriptions` 0.750: reads only the first page of past due subscriptions, so it misses the Business subscriptions on page 2
- `cancel_final_retry_business_subscriptions` 0.000: cancels every past due Business subscription regardless of which attempt its invoice is on
- `cancel_final_retry_business_subscriptions` 0.000: cancels every subscription whose open invoice is on its third attempt regardless of plan
- `cancel_final_retry_business_subscriptions` 0.000: tries to collect the target invoices by paying them instead of cancelling the subscriptions
- `cancel_final_retry_business_subscriptions` 0.000: cancels every correct target and then also cancels one Business subscription that is still at an earlier dunning stage

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_harbor_dental_subscription | easy | 2 | none | none | none declared |
| recover_bluefin_labs_with_backup_card | medium | 6 | none | none | none declared |
| cancel_final_retry_business_subscriptions | hard | 12 | none | invoice, subscription | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $2.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.11 | 0.3077 |
| Total | 1 | 0.11 | 0.3077 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures; it keeps 3 issue(s) the world had before this iterate: plan.seed_rows_short
- `tasks`: no planned change reaches tasks, entities, routes, actions, jobs, seed

Run total: 0.39 minutes, $0.3077.
