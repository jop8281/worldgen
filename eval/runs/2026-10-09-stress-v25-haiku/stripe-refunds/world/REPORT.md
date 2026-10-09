# WorldGen report: Stripe API (refunds and charges subset, version 2024-06-20)

A Stripe-style refunds desk. Charges hold the money taken from a customer. Refunds draw on a charge's unrefunded balance, move through a status state machine, can be canceled while open, and can have their metadata updated. Lists use Stripe paging: newest first by created_at, with limit, starting_after, ending_before and a charge filter. All five kept operations under /v1/refunds are routes or actions, each with the spec's method and path. Charge create, list and get routes are added so the world can hold charges and tests can build their own rows.

## What was built

Entities (2):

- `charge`: 8 seeded rows
- `refund`: 12 seeded rows

Routes (4):

- `list_refunds`: GET /v1/refunds
- `get_refund`: GET /v1/refunds/{id}
- `list_charges`: GET /v1/charges
- `get_charge`: GET /v1/charges/{id}

Actions (4):

- `create_charge`: POST /v1/charges
- `create_refund`: POST /v1/refunds
- `update_refund`: POST /v1/refunds/{id}
- `cancel_refund`: POST /v1/refunds/{id}/cancel

Jobs: none.

## Assumed and why

- Request bodies are JSON objects using the spec's field names, not form-encoded.
  - Why: The engine takes JSON bodies; the form encoding carries no state the world must model.
- Refund metadata is a text field holding a JSON object string, nullable.
  - Why: The engine has no map type, so the spec's metadata map cannot be declared. Update_refund needs an input to be a real operation, and a text field keeps it so.
- Adds POST /v1/charges (create_charge), GET /v1/charges (list_charges) and GET /v1/charges/{id} (get_charge), which the kept spec operations do not include.
  - Why: Charges exist only as seed rows otherwise, so acceptance tests could not create their own charges and agents could not discover charge ids. These are deliberate extras, so openapi.operation_extra is expected.
- The five kept spec operations are routes or actions with the spec's method and path: POST /v1/refunds is create_refund, POST /v1/refunds/{id} is update_refund, POST /v1/refunds/{id}/cancel is cancel_refund, and the two GETs are list_refunds and get_refund. Path params are named {id} for the per-refund routes.
  - Why: Each planned operation must exist in the world by method and path. Naming the params {id}, as get_refund already does, keeps the routes consistent; the spec's {refund} name is only a param name.
- Refunds are never settled by a job: a pending refund stays pending until canceled, and no job moves refunds to succeeded.
  - Why: A job would change state with no agent call, which breaks the idle check and the collateral grading. Seed rows supply succeeded refunds.
- A charge's unrefunded balance is computed in the handlers from its refund rows; the charge stores no amount_refunded total.
  - Why: A stored total would have to equal the seed's refund rows, and seed order (refund refs charge) makes computing it in the charge seed a cycle. Deriving it avoids both.
- A refund counts against its charge while pending, requires_action or succeeded; canceled and failed refunds do not count.
  - Why: This is Stripe's behavior for returned money and is what makes cancel free the balance for a new refund.
- create_refund takes charge or payment_intent (both optional in the body), and refuses a body with neither (input.invalid). Without an amount the refund covers the charge's whole unrefunded balance.
  - Why: Stripe's refund body has no required field, so the spec does not require charge. The handler carries the 'one of them' rule itself.
- Charge is looked up by charge id only; payment_intent is stored on the refund as given and not resolved, since no payment intent entity is modeled.
  - Why: Keeps the model to the entities in scope. Payment intents are listed as out of scope.
- Refund error codes used by ctx.fail are resource_missing (400), amount_too_large (400), charge_already_refunded (400) and invalid_state (409).
  - Why: These follow Stripe's error vocabulary and are the codes the acceptance tests assert.
- The list envelope keeps data and has_more and drops the object and url keys.
  - Why: The engine builds the envelope from the list config; object and url carry no state.
- Refund object is an enum field with the single value refund and default refund; charge.created and refund.created are unix_time fields defaulted to now.
  - Why: The spec gives object as a constant and created as unix time, and the engine offers those types.
- Amounts are integer minor units in an int field, not money fields.
  - Why: The spec types amount as integer, and an int field matches the JSON type.
- List pageSize is 10 for list_refunds and list_charges, matching Stripe's default limit, with 12 refunds seeded.
  - Why: Two pages is the smallest seed that makes paging matter, consistent with 'just over one list page'.
- Clock starts at 2026-10-09T09:00:00.000Z with tick 0s, after all seeded history. Ties in created_at resolve by id descending, as Stripe does.
  - Why: Deterministic time with no drift. Refunds created in one test at the same engine time have a fixed newest-first order, which the paging test depends on.

## Fields not in the input

None. The input names every field.

## Questions asked of the input

- Should request bodies be form-encoded as in the Stripe spec, or JSON?
  - Default answer: JSON objects using the spec's field names, since the engine takes JSON bodies.
- Should charge create/list/get routes be added even though the kept spec operations omit them?
  - Default answer: Yes, as deliberate extras so tests can create charges and agents can find charge ids; recorded as openapi.operation_extra.
- Should pending refunds settle to succeeded on their own over time?
  - Default answer: No. A job would change state without an agent call; pending refunds stay pending until canceled, and seed rows supply succeeded refunds.
- Is payment_intent resolved to a real entity?
  - Default answer: No. It is stored as an opaque string on the refund, since payment intents are out of scope.
- Is metadata a real map?
  - Default answer: No. The engine has no map type, so metadata is a nullable text field holding a JSON object string.

## Left out

- Customer entity and its routes
  - Why: The spec's customer schema is not among the kept operations; charge.customer is kept as a plain string.
- Payment intents and their entity
  - Why: Not in the kept operations; payment_intent is stored as an opaque string.
- Expandable fields (charge expanded inside refund, refunds list expanded inside charge)
  - Why: Expansion is a Stripe-wide convention that needs nested responses; ids are returned instead.
- Metadata as a real map
  - Why: The engine has no map field type; a JSON text field stands in.
- Form-encoded request bodies, idempotency keys, livemode, doc_url and webhooks
  - Why: Transport and platform features with no stored state of their own.
- Background settlement of pending refunds
  - Why: Would change state without an agent call; see assumptions.
- Disputes, failure_code and receipt fields beyond the refund fields listed, and charge capture flows
  - Why: Outside the charges and refunds subset the request keeps; charges are created already captured.
- The eight dropped spec operations
  - Why: The request keeps five operations under /v1/refunds; the other operations were dropped on purpose.

## Proof

The engine check passed: 8 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_58a30a29a512c22f5ece586349bc84cc99ef6770a515036658cdda0f723d0cbd`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_pending_refund | easy | 1.000 | 0.000 | none | n/a | declared (1); mutants 2/8 | `tid_4261c83631531841031eb6bc1fe351bbf7da7ca32e06d65a867ccad15525ecb7` |
| refund_remaining_balance | medium | 1.000 | 0.000 | 0.500 | n/a | declared (1); mutants 2/8 | `tid_6b3de047e5c373b523149569796f30876cc58c6fca56427718acb4c8eaefeb2a` |
| cancel_and_reissue_refund | hard | 1.000 | 0.000 | 0.500, 0.500 | 0.500 | declared (2); mutants 3/8 | `tid_569dcdb9f71197574b0242e1837c74f66fcdc61426f0a450c66568d05a120870` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `refund_remaining_balance` 0.500: refunds 1000, the amount of the pending refund, instead of all 2000 still left on the charge
- `cancel_and_reissue_refund` 0.500: refunds the same amount again without canceling the stuck refund, so two refunds for that amount stay open
- `cancel_and_reissue_refund` 0.500: cancels the stuck refund and never refunds the amount again

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_pending_refund | easy | 1 | none | refund | distractors: met; state: met |
| refund_remaining_balance | medium | 1 | none | refund | distractors: met; state: met |
| cancel_and_reissue_refund | hard | 2 | refund | refund | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Checked against the OpenAPI source spec. The last step rejected any route, field type or enum that departs from it.

## Run

Mode: create from openapi. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 3 | 3.84 | 0.1016 |
| model | 1 | 0.39 | 0.0180 |
| workflow | 1 | 0.47 | 0.0071 |
| seed | 1 | 0.53 | 0.0210 |
| tasks | 2 | 3.04 | 0.0322 |
| Total | 8 | 8.29 | 0.1799 |

Run total: 8.29 minutes, $0.1799.
