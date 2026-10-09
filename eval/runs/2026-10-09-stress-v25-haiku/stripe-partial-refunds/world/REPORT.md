# WorldGen report: Stripe API (charges and refunds subset, version 2024-06-20)

A Stripe-style payments world with charges and refunds. An agent creates charges, refunds them in part or in full, cancels pending refunds, and reads paged Stripe-style lists. Refund status moves through a state machine, a job settles old pending refunds, and charge amount_refunded always tracks live refunds. Customers are a plain string on the charge, because no customer operation is among the kept eight.

## What was built

Entities (2):

- `charge`: 12 seeded rows
- `refund`: 10 seeded rows

Routes (5):

- `list_charges`: GET /v1/charges
- `get_charge`: GET /v1/charges/{id}
- `list_refunds`: GET /v1/refunds
- `get_refund`: GET /v1/refunds/{id}
- `update_refund`: POST /v1/refunds/{id}

Actions (3):

- `create_charge`: POST /v1/charges
- `create_refund`: POST /v1/refunds
- `cancel_refund`: POST /v1/refunds/{id}/cancel

Jobs (1):

- `settle_refunds`: every 1h

## Changes

- item_changed `tests.refund_over_amount_refused.description`
- snippet_changed `tests.refund_over_amount_refused.script`

## Assumed and why

- Bodies are JSON with the spec's field names; the spec's form-encoded bodies are not modelled.
  - Why: The engine takes JSON request bodies; the field names are unchanged, so the agent sends the same keys.
- No customer entity. charge.customer is a nullable string, and no customer routes exist.
  - Why: The kept operations are charges and refunds only; a customer entity with no route would be unreachable to an agent.
- metadata is a text field holding a JSON string on charge and refund.
  - Why: The field types have no map type, so the Metadata map is stored as text.
- charge.status is an enum (succeeded, pending, failed), not a state field; the charge workflow declares a descriptive lifecycle.
  - Why: No action moves a charge after creation (no capture or failure path), so a state machine would have no transitions to enforce.
- refund.status is a state field with all five spec values; requires_action and failed are reachable through declared transitions but no action creates them.
  - Why: The openapi field_enum check needs every spec value; the transitions still follow the spec's lifecycle.
- create_charge answers 200 and create_refund answers 200, both as actions with explicit status, not the standard 201.
  - Why: The spec declares 200 for these operations, and an action's handler may return its own status.
- create_charge sets captured and paid to the capture input (default true) and amount_captured to amount when captured. No capture route exists.
  - Why: The spec's capture boolean is kept; the capture operation itself is not in the kept set.
- create_refund: charge is an optional input; a request without charge is refused 400 parameter_missing, and payment_intent is accepted but refused without a charge.
  - Why: The spec makes charge and payment_intent both optional; there is no payment_intent entity, so a charge is required in practice.
- Omitted amount on create_refund refunds the remainder (amount minus amount_refunded).
  - Why: This is the spec's default when amount is absent, and it makes full-refund behaviour testable.
- Stripe paging: list.mode stripe, limit 1 to 100 with pageSize 10 as the route default, newest first by created_at, no sort on lists.
  - Why: The input is a Stripe list envelope with has_more and starting_after/ending_before.
- Clock starts 2026-10-09T12:00:00.000Z with tick 1s; seeded history precedes it.
  - Why: The start is after today's date and after all seeded rows; a 1s tick gives every call a distinct created_at, so newest-first paging is deterministic.
- description is a filter on list_charges and charge is a filter on list_refunds; description is not a spec parameter.
  - Why: Tasks identify charges by their description, which the agent is told; without a filter the agent would have to page through every charge.
- Error bodies follow the spec's shared error shape: error with type fixed to invalid_request_error, code and message.
  - Why: The spec's Error schema is the only error shape the input declares.
- The world needs no auth; the spec's basic auth is not modelled.
  - Why: Auth is not a stateful record behaviour, and the engine has no auth layer in this world.
- Refund cancel and charge refund rules are enforced in the handlers with fixed ctx.fail codes: invalid_state (409), parameter_missing (400), resource_missing (404).
  - Why: The engine lacks a state-based refusal for the cancel-only-pending rule, so the handler checks it before writing.
- Several partial refunds per charge are allowed; the refunded total may reach the charge amount exactly, which sets refunded to true.
  - Why: The request says a charge can be refunded several times until the refunded total reaches the charge amount. The existing refund rules already express this, so no entity, route or workflow rule changes.
- A refund that would push the refunded total past the charge amount is refused with 400 and writes no refund row and no change to the charge.
  - Why: The request says such a refund is refused with no change. The rewritten test checks the charge and the refund list before and after the refused call, not only the status.
- Only tests.refund_over_amount_refused is rewritten. Its rule binding (create_refund) and the other tests stay as they are.
  - Why: The request touches only the over-amount refusal and the partial-refund path, which this test already exercises.

## Questions asked of the input

- Should Customer rows exist as an entity?
  - Default answer: No. The kept operations do not reach customers; charge.customer stays a string.
- Should form-encoded bodies be accepted?
  - Default answer: No. JSON with the same field names only.
- Should metadata be a map?
  - Default answer: No. It is a JSON text string, since the field types have no map.
- Should refunds move to failed or requires_action?
  - Default answer: No action drives them; they exist as declared states to match the spec's enum.
- Does the spec's basic auth need enforcing?
  - Default answer: No. The world takes any caller.
- Should a refused over-amount refund be recorded as a failed refund row instead of a 400 with no row?
  - Default answer: No. It is refused with 400 and writes nothing, as the request says 'refused with no change'. refund.failed stays unused.

## Left out

- Customer entity and customer routes
  - Why: No customer operation is in the kept eight; the spec describes customers only in the About text, so no entity or route is built.
- Form-encoded request bodies
  - Why: The engine takes JSON bodies; field names are unchanged.
- Payment intents and the payment_intent field's behaviour
  - Why: There is no payment_intent entity; the field is accepted and refused without a charge.
- Capture of uncaptured charges and charge update
  - Why: The capture and update operations are outside the kept set.
- The Stripe object, url and refunds-expansion keys in responses
  - Why: Constant envelope keys and expandable lists add no stateful behaviour; charge.refunds is not built as a nested list.
- Webhooks, failure simulation and processor-side failure_code/failure_message values
  - Why: Failure paths produce no state transitions an agent can drive, so they stay null.
- The five operations dropped from the 13 in the subset
  - Why: The input does not list them; they cannot be built from the given spec.

## Proof

The engine check passed: 8 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_b29996f0e0f5ba32f0d70e465216cee3aeb7c930dda32d1de32cd4616844a9d4`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| refund_team_plan_in_full | easy | 1.000 | 0.000 | none | n/a | declared (2); mutants 2/8 | `tid_ed55417e3a77a99da638a7b98fbee677835de6d251026bd7139b0a8ec1abc368` |
| cancel_mistaken_refund | medium | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (2); mutants 2/8 | `tid_656ddc6fe4b0c1ca0e5673a8debddb443fa63c31de84ec32a44e42a715902dee` |
| resize_studio_refund | hard | 1.000 | 0.000 | 0.400, 0.400, 0.000 | 0.400 | declared (3); mutants 3/8 | `tid_6b3aae50e4a916f6e415d57415c98898d7ef126362bc689b34491ea57206c1fa` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_mistaken_refund` 0.000: cancels the pending refund on Design review hours, a different charge with a pending refund, instead of the Conference tickets one
- `cancel_mistaken_refund` 0.000: cancels the right pending refund, then refunds the charge's remaining amount again, so the charge ends up refunded in full
- `resize_studio_refund` 0.400: cancels the wrong 1500 refund and stops, never issuing the replacement 1200 refund
- `resize_studio_refund` 0.400: tries the 1200 refund before cancelling, which the remaining 500 refuses, then cancels the 1500 refund and stops
- `resize_studio_refund` 0.000: cancels the 1500 refund, then refunds 1500 again on the same charge instead of the 1200 that was asked for

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| refund_team_plan_in_full | easy | 2 | none | charge | none declared |
| cancel_mistaken_refund | medium | 2 | none | charge | distractors: met; state: met |
| resize_studio_refund | hard | 3 | charge | none | hard: met; state: met |

## Run

Mode: iterate from change_request. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.30 | 0.0172 |
| workflow | 1 | 0.11 | 0.0367 |
| Total | 2 | 0.40 | 0.0539 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `seed`: no planned change reaches seed, entities, fixtures
- `tasks`: no planned change reaches tasks, entities, routes, actions, jobs, seed

Run total: 0.41 minutes, $0.0539.
