# WorldGen report: Shopify-style order management API (orders and customers)

An orders API where agents read customers and orders, and move orders through a fixed fulfilment lifecycle (pending, paid, shipped, delivered, with cancelled and refunded as end states). Core value is stateful order records changed through actions, so the world is feasible. Both CSV tables are imported exactly: 18 customers and 72 orders. Only the five order actions and the standard CRUD and list routes are built.

## What was built

Entities (2):

- `customer`: 18 seeded rows
- `order`: 72 seeded rows

Routes (9):

- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `create_order`: POST /orders
- `update_order`: PATCH /orders/{id}
- `list_customer_orders`: GET /customers/{customer_id}/orders
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `update_customer`: PATCH /customers/{id}

Actions (5):

- `pay_order`: POST /orders/{id}/pay
- `ship_order`: POST /orders/{id}/ship
- `deliver_order`: POST /orders/{id}/deliver
- `cancel_order`: POST /orders/{id}/cancel
- `refund_order`: POST /orders/{id}/refund

Jobs: none.

## Assumed and why

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

## Fields not in the input

None. The input names every field.

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 5 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_b0f72f756a79d87beb3a7e6579ec8c8b656be3160471afd65d39f5e095c752bb`.

Paging exemptions:

- `customer` fits on one page (18 rows), but its rows come from the input's fixtures, so the input sets its size and no task is held to paging on it.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| ship_latest_paid_order | easy | 1.000 | 0.000 | none | n/a | declared (1); mutants 6/8 | `tid_115794534d1bc723b77b6a0db24a9c510e798109dc45ba6fddf8ac5d2a59512e` |
| refund_damaged_delivery | medium | 1.000 | 0.000 | 0.000, 0.700 | n/a | declared (1); mutants 5/8 | `tid_bdf65f8dfa630cf4d289af5b010a9fba94cc867d2485b771dc6c9687129b2eae` |
| pay_and_ship_early_pending | hard | 1.000 | 0.000 | 0.250, 0.500, 0.000 | 0.875 | declared (1); mutants 6/8 | `tid_c66fc6d56468c95c3a318fb5f44222bb51203599705955449c131881b85b7eb0` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `refund_damaged_delivery` 0.000: refunds the oldest delivered order instead of the most recent one, and also cancels her paid order as collateral
- `refund_damaged_delivery` 0.700: refunds the right order by its id, typed from memory, without looking up the customer's orders first, so the delivered check is never made
- `pay_and_ship_early_pending` 0.250: reads only the first two pages of orders, newest first, so it pays and ships the early pending order on page two and misses the early pending orders on page three
- `pay_and_ship_early_pending` 0.500: pays every early pending order across all three pages but never ships them, so the payments land and the shipments do not
- `pay_and_ship_early_pending` 0.000: pays and ships every pending order on all pages, ignoring the 1 March 2026 cut-off, so it changes orders the instruction does not name

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| ship_latest_paid_order | easy | 1 | none | order | distractors: met; state: met |
| refund_damaged_delivery | medium | 1 | none | order | distractors: met; state: met |
| pay_and_ship_early_pending | hard | 4 | order | order | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Shopify-style order management API (orders and customers), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from csv. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 2.83 | 0.0330 |
| model | 1 | 0.47 | 0.0082 |
| workflow | 1 | 0.22 | 0.0068 |
| seed | 1 | 0.27 | 0.0072 |
| tasks | 2 | 4.27 | 0.0437 |
| Total | 7 | 8.05 | 0.0989 |

Run total: 8.06 minutes, $0.0989.
