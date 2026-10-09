# WorldGen report: Stripe API (charges, refunds, customers), version 2024-06-20

A Stripe-style payments world. Agents list and retrieve charges with Stripe's paging, create charges (captured at once or held pending), capture held charges and refund captured ones. Customers group charges. Refunds are stored as their own rows and returned by the refund action.

## What was built

Entities (3):

- `customer`: 8 seeded rows
- `charge`: 60 seeded rows
- `refund`: 10 seeded rows

Routes (6):

- `list_charges`: GET /v1/charges
- `get_charge`: GET /v1/charges/{id}
- `list_customers`: GET /v1/customers
- `get_customer`: GET /v1/customers/{id}
- `list_refunds`: GET /v1/refunds
- `get_refund`: GET /v1/refunds/{id}

Actions (4):

- `create_customer`: POST /v1/customers
- `create_charge`: POST /v1/charges
- `capture_charge`: POST /v1/charges/{id}/capture
- `refund_charge`: POST /v1/charges/{id}/refund

Jobs: none.

## Assumed and why

- Only charges are in scope as the spec's kept operations. Customers and refunds are supporting entities.
  - Why: The three kept operations all return Charge, which refers to a customer and a refund list.
- Extra operations are added on purpose: POST /v1/charges/{id}/capture, POST /v1/charges/{id}/refund, GET/POST /v1/customers and GET /v1/customers/{id}.
  - Why: With only list, create and get there is no workflow beyond creation. Tasks and acceptance tests need capture and refund, and customers to group charges. Stripe offers all of these.
- Route paths use {id} for the row id where the spec says {charge}.
  - Why: The engine requires {id} on a get route. The spec path matches segment by segment.
- meta.api uses list mode stripe (data, has_more, starting_after, ending_before, limit) and the error body {error:{type:invalid_request_error, code, message}}.
  - Why: This is what the spec proposes.
- Request bodies are JSON, not form-encoded.
  - Why: The engine's API takes JSON bodies.
- The created field is a unix_time in seconds, named as the spec names it. Charge ids use the prefix ch (ch_0001).
  - Why: This keeps the spec's field names and Stripe-style output.
- capture=false creates a charge with status pending, captured false, paid false, amount_captured 0. Otherwise status is succeeded, captured true, paid true, amount_captured equal to amount.
  - Why: The spec's status enum is succeeded|pending|failed, so a held authorization maps to pending.
- Failed charges exist in the seed only (failure_code and failure_message set). They cannot be captured or refunded. The API cannot create a failed charge.
  - Why: No card network is simulated.
- Refund amount defaults to the remaining captured amount. A refund cannot exceed amount_captured minus amount_refunded. Once amount_refunded equals amount_captured, refunded is true. The charge stays succeeded.
  - Why: This is Stripe's behaviour and the spec's status enum has no refunded status.
- The embedded refunds list on a charge is optional in the spec and is not an acceptance requirement. Refunds are stored as rows and returned by refund_charge; the charge's amount_refunded and refunded fields reflect them.
  - Why: The spec does not require refunds on Charge, and the previous acceptance test could not rely on an embedded list.
- Action errors: 400 amount_invalid, 400 resource_missing (unknown customer), 400 amount_too_large, 409 charge_already_captured, 409 charge_not_capturable, 409 charge_not_refundable. Engine codes (input.invalid, row.not_found) apply to missing inputs and unknown ids.
  - Why: Stripe-like errors on the shared error body.
- Clock starts 2026-10-09T09:00:00Z with tick 0s. All seeded history lies before the start. There are no jobs.
  - Why: Time stays explicit and tasks stay deterministic. Expiry of uncaptured charges is out of scope.
- Metadata is a string-to-string map stored as JSON text and returned as an object. It is optional on create.
  - Why: The spec requires metadata on Charge but not on create.

## Fields not in the input

3 fields match no column or property name in the input. WorldGen invented each one, or renamed an input field.

- `customer.name`
- `customer.email`
- `customer.phone`

## Questions asked of the input

- Should the capture and refund endpoints be added beyond the three kept operations?
  - Default answer: Yes, as declared extra operations, so tasks can change state.
- Should a refund create a separate Refund object returned to the caller?
  - Default answer: Yes. refund_charge returns the Refund object and stores it as a refund row.
- Is an uncaptured charge paid?
  - Default answer: No. Uncaptured means status pending, paid false.

## Left out

- Payment intents, payment methods, cards, disputes, balance transactions, payouts, webhooks, idempotency keys, expand[] parameters
  - Why: Dropped from the subset. The 10 other operations are not in scope.
- Real card processing, 3-D Secure and auto-expiry of uncaptured charges
  - Why: This is a computation or integration concern, not stateful records.
- Basic auth enforcement and livemode behaviour
  - Why: The world is a single test-mode account. livemode is always false.

## Proof

The engine check passed: 7 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_416655ed26bbdb16cc534e22665761b109d9c11755391d4df0c84455e12b3f9e`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| capture_northwind_hold | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 3/8 | `tid_330b47072565139373881348c16a103e4b893e24fd3e110b9a90fc8abe5dbdaf` |
| refund_duplicate_charge | medium | 1.000 | 0.000 | 0.000, 0.300, 0.000 | n/a | declared (2); mutants 2/8 | `tid_8f8dc4cd667f1846411b36f20bd3096afffc18bd6fe7f22b9d6aa4a2a09ad6ff` |
| settle_acme_holds_and_refund_dupes | hard | 1.000 | 0.000 | 0.600, 0.250, 0.000 | 0.650 | declared (3); mutants 2/8 | `tid_da9d798f1ab6d8e2748b17b103cb3aa82f77f4cd7e0391391f6f4ad1831332e3` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `capture_northwind_hold` 0.000: captures every pending charge of every customer instead of only the Northwind hold
- `refund_duplicate_charge` 0.000: refunds the original 'Order #4471 annual plan' charge, which has the same amount, instead of the duplicate
- `refund_duplicate_charge` 0.300: refunds only part of the duplicate (100.00 of 499.00) instead of the full amount
- `refund_duplicate_charge` 0.000: refunds every succeeded Acme charge whose description mentions Order #4471 annual plan, so the original is refunded too
- `settle_acme_holds_and_refund_dupes` 0.600: refunds the DUP charges before capturing the holds, so the held DUP charges are refused and never refunded
- `settle_acme_holds_and_refund_dupes` 0.250: captures all the holds but never refunds the DUP charges
- `settle_acme_holds_and_refund_dupes` 0.000: matches 'dup' anywhere in the description, case-insensitively, so it also refunds the 'Order #4471 annual plan (duplicate)' charge

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| capture_northwind_hold | easy | 1 | none | charge | distractors: met; state: met |
| refund_duplicate_charge | medium | 2 | charge | charge | paging: met; distractors: met; state: met |
| settle_acme_holds_and_refund_dupes | hard | 15 | charge | charge | hard: met; paging: met; distractors: met; state: met; state: met; state: met |

## Fidelity

Checked against the OpenAPI source spec. The last step rejected any route, field type or enum that departs from it.

## Run

Mode: create from openapi. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 1.96 | 0.3072 |
| model | 3 | 0.86 | 0.2706 |
| workflow | 3 | 1.09 | 0.3217 |
| seed | 1 | 0.71 | 0.1360 |
| tasks | 2 | 3.54 | 0.5324 |
| Total | 11 | 8.17 | 1.5679 |

Backtracks:

- `workflow` to `plan`: 1 issue

Run total: 8.18 minutes, $1.5679.
