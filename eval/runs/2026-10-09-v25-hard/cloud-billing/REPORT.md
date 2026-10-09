# WorldGen report: Stripe Billing / AWS Billing-style cloud billing console (subscriptions, invoices, credits, refunds, dunning)

A billing console where customers hold subscriptions to plans, invoices are paid, voided or written off, account credits are granted and applied, refunds go through a request and decision step, and a daily dunning job escalates overdue invoices and the subscriptions behind them.

## What was built

Entities (7):

- `customer`: 12 seeded rows
- `plan`: 4 seeded rows
- `subscription`: 14 seeded rows
- `invoice`: 32 seeded rows
- `payment_attempt`: 20 seeded rows
- `credit_entry`: 8 seeded rows
- `refund`: 8 seeded rows

Routes (16):

- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `list_plans`: GET /plans
- `get_plan`: GET /plans/{id}
- `create_plan`: POST /plans
- `list_subscriptions`: GET /subscriptions
- `get_subscription`: GET /subscriptions/{id}
- `create_subscription`: POST /subscriptions
- `list_invoices`: GET /invoices
- `get_invoice`: GET /invoices/{id}
- `create_invoice`: POST /invoices
- `list_payment_attempts`: GET /payment_attempts
- `list_credit_entries`: GET /credit_entries
- `list_refunds`: GET /refunds
- `get_refund`: GET /refunds/{id}

Actions (10):

- `pay_invoice`: POST /invoices/{id}/pay
- `void_invoice`: POST /invoices/{id}/void
- `apply_credit`: POST /invoices/{id}/apply_credit
- `write_off_invoice`: POST /invoices/{id}/write_off
- `cancel_subscription`: POST /subscriptions/{id}/cancel
- `reactivate_subscription`: POST /subscriptions/{id}/reactivate
- `request_refund`: POST /invoices/{id}/refunds
- `approve_refund`: POST /refunds/{id}/approve
- `reject_refund`: POST /refunds/{id}/reject
- `grant_credit`: POST /customers/{id}/credits

Jobs (1):

- `dunning_sweep`: every 1d

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded due dates straddle that instant, and time moves only by explicit advance or job sweeps
  - Why: Deterministic time with past history and future due dates
- Single currency USD, amounts in integer cents, no taxes, proration or usage metering
  - Why: Keeps the model focused on collections
- Card charges are simulated: pay_invoice takes card_result succeeded or failed; a failed charge answers 200 with the invoice still open
  - Why: No real payment processor in a world
- Dunning is one daily sweep with two levels (under 14 days, 14+ days) rather than configurable retry schedules
  - Why: Simple deterministic automation
- Refunds are two-step (request then approve or reject); only requested and approved refunds count toward the paid cap
  - Why: Gives a requester and reviewer pair of actors
- Invoices, subscriptions, customers and plans are created through standard create routes with initial states only
  - Why: Lets acceptance tests build their own rows
- Action error codes: invalid_state, insufficient_credit, refund_exceeds_paid, not_overdue, overdue_invoices, all 409
  - Why: Named codes for tests to assert

## Questions asked of the input

- Should dunning automatically retry cards?
  - Default answer: No; the sweep only escalates levels and subscription status
- Can paid invoices be refunded multiple times?
  - Default answer: Yes, until requested plus approved refunds reach amount_paid
- Does cancelling refund anything?
  - Default answer: No; it only voids unpaid open invoices

## Left out

- Real payment gateways, taxes, proration, usage metering, PDF invoices
  - Why: Not needed for stateful record tasks
- Authentication and roles
  - Why: Reviewer role is represented only by calling approve or reject

## Proof

The engine check passed: 10 world tests, 3 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_906a87521c9d18d6737a142da47f667140f86004a76b83fd84e23946f2955a91`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| void_mistaken_invoice | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 3/8 | `tid_9777538e812363bb489c76241429b85bd77bf1680adee004f82959f9509833cb` |
| refund_outage_to_credit | medium | 1.000 | 0.000 | 0.250, 0.500, 0.000 | 0.250 | declared (4); mutants 3/8 | `tid_2a64def7aa4b472fabecd0052e3369e0d2dfcc0e112272122b91dbee43b954a1` |
| review_requested_refunds_by_policy | medium | 1.000 | 0.000 | 0.000, 0.800, 0.200 | 0.600 | declared (5); mutants 1/8 | `tid_6384ac85296bc713c8c40830179dbc906b320613bb92bdee4af9b90c22143272` |
| clean_up_long_overdue_enterprise | hard | 1.000 | 0.000 | 0.670, 0.670, 0.000 | 0.670 | declared (7); mutants 3/8 | `tid_757d0149f35e9c2a5f906ac8d643b5d4a235209219eebb8239fccb5847677b31` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `void_mistaken_invoice` 0.000: voids the customer's other open invoice INV-1020 instead of the mistaken INV-1026
- `refund_outage_to_credit` 0.250: requests the refund but never approves it, so no money or credit moves
- `refund_outage_to_credit` 0.500: sends the refund to the original payment instead of account credit, so the credit balance never rises
- `refund_outage_to_credit` 0.000: approves the already requested service outage refund of a different customer instead of raising one for Juniper Health
- `review_requested_refunds_by_policy` 0.000: approves every requested refund, trusting the pre-approved text and ignoring the 5000 cent limit
- `review_requested_refunds_by_policy` 0.800: approves the refunds within the limit but never rejects the one above 5000
- `review_requested_refunds_by_policy` 0.200: rejects every requested refund, so only the over-limit one is handled correctly
- `clean_up_long_overdue_enterprise` 0.670: settles the two covered invoices with credit but never cancels the subscription whose customer is a cent short
- `clean_up_long_overdue_enterprise` 0.670: believes the 'paid offline, ignore' memo on INV-1031 and skips it, handling only the other two
- `clean_up_long_overdue_enterprise` 0.000: also settles INV-1030 with credit although it is exactly 30 days overdue, not more than 30

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| void_mistaken_invoice | easy | 1 | none | none | none declared |
| refund_outage_to_credit | medium | 4 | none | invoice | distractors: met; state: met |
| review_requested_refunds_by_policy | medium | 7 | none | refund | distractors: met; state: met |
| clean_up_long_overdue_enterprise | hard | 8 | invoice | invoice, subscription | hard: met; paging: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Stripe Billing / AWS Billing-style cloud billing console (subscriptions, invoices, credits, refunds, dunning), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 2.56 | 0.2688 |
| model | 1 | 0.44 | 0.1566 |
| workflow | 1 | 0.55 | 0.1858 |
| seed | 1 | 0.88 | 0.2164 |
| tasks | 1 | 3.96 | 0.5317 |
| Total | 5 | 8.40 | 1.3594 |

Run total: 8.41 minutes, $1.3594.
