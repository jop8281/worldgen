# WorldGen report: Stripe Billing subscriptions with invoices, card payments and dunning

A subscription billing API. Customers hold cards and subscribe to plans; each subscription bills an invoice per period. A declined charge moves the invoice and subscription to past_due and starts dunning: retries run 1, 3 and 7 days after the first failure, and when the last retry fails the subscription is cancelled and its invoice voided. Agents charge invoices, change a subscription's card, cancel subscriptions and read invoices and payments. Feasible: the core value is stateful billing records that an agent reads and changes through actions.

## What was built

Entities (6):

- `customer`: 12 seeded rows
- `plan`: 3 seeded rows
- `payment_method`: 16 seeded rows
- `subscription`: 12 seeded rows
- `invoice`: 28 seeded rows
- `payment`: 30 seeded rows

Routes (15):

- `create_customer`: POST /customers
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_plan`: POST /plans
- `list_plans`: GET /plans
- `get_plan`: GET /plans/{id}
- `create_payment_method`: POST /payment_methods
- `list_payment_methods`: GET /payment_methods
- `get_payment_method`: GET /payment_methods/{id}
- `list_subscriptions`: GET /subscriptions
- `get_subscription`: GET /subscriptions/{id}
- `list_invoices`: GET /invoices
- `get_invoice`: GET /invoices/{id}
- `list_payments`: GET /payments
- `get_payment`: GET /payments/{id}

Actions (4):

- `create_subscription`: POST /subscriptions
- `cancel_subscription`: POST /subscriptions/{id}/cancel
- `update_subscription_payment_method`: POST /subscriptions/{id}/payment_method
- `charge_invoice`: POST /invoices/{id}/charge

Jobs (1):

- `dunning_retry`: every 1h

## Assumed and why

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

## Questions asked of the input

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

## Left out

- Recurring renewal billing cycles and proration
  - Why: Requested scope is dunning and payment collection, not the period engine.
- Refunds and credit notes
  - Why: Not mentioned in the request.
- Tax, currencies other than USD, and discounts
  - Why: Not mentioned in the request.
- Webhooks and dunning emails
  - Why: Outbound notifications are not stateful records an agent reads.

## Proof

The engine check passed: 8 world tests, 3 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_449c228f4ac94d7181208f2d39fbe13158a1d01e3de46b14ce0d51dfe0f5a14e`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_ruth_subscription | easy | 1.000 | 0.000 | none | n/a | declared (2); mutants 3/8 | `tid_d714b181d1445a74e00bb5db26a2c8f3df5fe52e869aa957500d3202b62a8ce9` |
| collect_marco_with_new_card | medium | 1.000 | 0.000 | 0.000, 0.400 | 0.400 | declared (3); mutants 5/8 | `tid_0d0b545f519926c87b3c4a75c309375f4061d602d6828b961437e0bcb0bd1a28` |
| move_hana_plus_and_cancel_basic | hard | 1.000 | 0.000 | 0.300, 0.000, 0.700 | 0.700 | declared (4); mutants 4/8 | `tid_13119527e1a2a6ab293300f0dc0af8132d9d59c4d3d606874f6cc5d994f42186` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `collect_marco_with_new_card` 0.000: charges the unpaid invoice on the declined card without changing the subscription's card
- `collect_marco_with_new_card` 0.400: moves the subscription to the 4417 card but never collects the unpaid invoice, which stays past_due
- `move_hana_plus_and_cancel_basic` 0.300: skips the card change, charges the declined Plus card, then cancels the Basic subscription
- `move_hana_plus_and_cancel_basic` 0.000: cancels the past_due Plus subscription instead of the Basic one
- `move_hana_plus_and_cancel_basic` 0.700: moves the card and collects the Plus invoice but never cancels the Basic subscription

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_ruth_subscription | easy | 2 | none | none | none declared |
| collect_marco_with_new_card | medium | 3 | none | none | state: met; state: met |
| move_hana_plus_and_cancel_basic | hard | 5 | none | subscription | hard: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Stripe Billing subscriptions with invoices, card payments and dunning, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 2.75 | 0.0386 |
| model | 1 | 0.43 | 0.0073 |
| workflow | 1 | 1.10 | 0.0397 |
| seed | 1 | 1.77 | 0.0191 |
| tasks | 1 | 2.27 | 0.0850 |
| Total | 6 | 8.32 | 0.1897 |

Run total: 8.33 minutes, $0.1897.
