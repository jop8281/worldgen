# WorldGen report: Stripe API (charges and refunds), version 2024-06-20

A Stripe-style payments world. Agents create charges (captured or authorized only), capture them later, refund them partly or fully, and page through charges with Stripe's newest-first list envelope. Refunds are irreversible and bounded by the captured amount.

## What was built

Entities (2):

- `charge`: 40 seeded rows
- `refund`: 11 seeded rows

Routes (3):

- `list_charges`: GET /v1/charges
- `get_charge`: GET /v1/charges/{id}
- `list_charge_refunds`: GET /v1/charges/{charge}/refunds

Actions (3):

- `create_charge`: POST /v1/charges
- `capture_charge`: POST /v1/charges/{id}/capture
- `refund_charge`: POST /v1/charges/{id}/refunds

Jobs: none.

## Assumed and why

- Requests and responses are JSON through ctx.api, not form-encoded
  - Why: The engine API speaks JSON; field names stay as in the spec.
- customer is a plain string field on charge, with no customer entity or routes
  - Why: The kept operations only take customer as a string and filter by it.
- Added capture_charge, refund_charge and list_charge_refunds beyond the three kept operations
  - Why: Charges need stateful actions to be useful for tasks; refunds are the Charge.refunds list in the spec.
- create_charge is an action answering 200, as the spec says, not the engine 201
  - Why: It must apply capture semantics and sets amount_captured, so it cannot be a plain create.
- Charge status is a state field with initial pending; create_charge moves it to succeeded (or failed when the currency is unsupported) within the same call
  - Why: The engine requires creates to start in the initial state.
- metadata is stored as text holding JSON because the field types have no map
  - Why: No map type exists; limitation noted.
- Clock starts 2026-10-09T09:00:00Z, tick 0s; seeded charges have created times before start
  - Why: Deterministic time after all seeded history; nothing is scheduled in the future.
- meta.api uses stripe list mode with the error body shape type/code/message
  - Why: As proposed by the spec analysis.
- Amounts are integer minor units, a refund defaults to the full remaining refundable amount
  - Why: Matches Stripe.
- List responses carry only the data array and has_more, with no object:'list' or url keys; acceptance tests do not assert them
  - Why: The engine's stripe list mode produces exactly that envelope.

## Fields not in the input

None. The input names every field.

## Questions asked of the input

- Should the world accept form-encoded bodies like real Stripe?
  - Default answer: No, JSON only.
- Should customers be their own entity?
  - Default answer: No, customer is a string id on the charge.
- Should capture and refund actions be added beyond the three kept operations?
  - Default answer: Yes, they are needed for stateful tasks.

## Left out

- Customers, payment intents, disputes, balance transactions, expandable fields, idempotency keys
  - Why: Dropped from the spec subset.
- Real card networks, 3-D Secure, fees, webhooks
  - Why: Computation or external behavior, not records.
- Basic auth enforcement
  - Why: The world has no users to authorize.

## Proof

The engine check passed: 6 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_9ef5303fbb376c3cd137f98c7aab74041751fcac2a2dd16a891ca71750434a4c`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| refund_duplicate_charge | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (2); mutants 2/8 | `tid_8d3a9bea0eb9d27ac93025d0cd4ea9dd160dea885d7ed6b446ca1e8b9026eaf3` |
| capture_pending_authorizations | medium | 1.000 | 0.000 | 0.500, 0.000, 0.500, 0.000 | 0.500 | declared (2); mutants 2/8 | `tid_acaea1bb37e1a6feb71c50697295c1a6bd15e1df37eae27bbe4a935635b55bae` |
| close_out_customer_account | hard | 1.000 | 0.000 | 0.600, 0.600, 0.000, 0.000 | 0.800 | declared (2); mutants 2/8 | `tid_1003f1a8fa576e426a2becebb95227fc9f95ad1c751a0dfc46fe29eeeec4cb71` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `refund_duplicate_charge` 0.000: refunds the earlier of the two duplicate charges instead of the later one
- `refund_duplicate_charge` 0.000: refunds both duplicate charges, so the customer ends up with no Annual plan payment at all
- `capture_pending_authorizations` 0.500: captures the authorizations but asks to refund 3000, more than the 2500 still refundable, so the refund is refused
- `capture_pending_authorizations` 0.000: refunds 2000 on the newer Monthly plan charge instead of the older one
- `capture_pending_authorizations` 0.500: refunds the right charge but never captures the authorized-only charges
- `capture_pending_authorizations` 0.000: does the whole job for cus_acme but also captures the authorized-only charges of cus_birch
- `close_out_customer_account` 0.600: reads only the first page of the cus_harbor list, so it misses the two older charges on page 2
- `close_out_customer_account` 0.600: pages through everything but refunds without capturing first, so the authorized-only charges are refused and stay unrefunded
- `close_out_customer_account` 0.000: closes out the right charges and also refunds the remainder of the already partly refunded 4999 charge
- `close_out_customer_account` 0.000: pages through everything and refunds every succeeded cus_harbor charge under 5000 half way only, never in full

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| refund_duplicate_charge | easy | 2 | none | charge | none declared |
| capture_pending_authorizations | medium | 4 | none | charge | distractors: met |
| close_out_customer_account | hard | 10 | charge | charge | hard: met; paging: met; distractors: met; state: met; state: met; state: met |

## Fidelity

Checked against the OpenAPI source spec. The last step rejected any route, field type or enum that departs from it.

## Run

Mode: create from openapi. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 3 | 1.91 | 0.3552 |
| model | 3 | 0.81 | 0.2357 |
| workflow | 3 | 1.18 | 0.3337 |
| seed | 1 | 0.57 | 0.1097 |
| tasks | 1 | 2.30 | 0.2989 |
| Total | 11 | 6.77 | 1.3332 |

Backtracks:

- `workflow` to `plan`: 1 issue

Run total: 6.77 minutes, $1.3332.
