# WorldGen plan: Stripe API (refunds and charges subset, version 2024-06-20)

A Stripe-style refunds desk. Charges hold the money taken from a customer. Refunds draw on a charge's unrefunded balance, move through a status state machine, can be canceled while open, and can have their metadata updated. Lists use Stripe paging: newest first by created_at, with limit, starting_after, ending_before and a charge filter. All five kept operations under /v1/refunds are routes or actions, each with the spec's method and path. Charge create, list and get routes are added so the world can hold charges and tests can build their own rows.

- Revision: 3
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `charge` | A card payment that money can be refunded from. Its unrefunded balance is its amount minus the refunds still open or succeeded against it. | id, amount, currency, description |
| `refund` | A refund of part or all of a charge. Its status is a state field that moves only along Stripe's refund transitions. | id, charge, status, amount |

## Workflows

### refund (refund)
- States: pending, requires_action, succeeded, failed, canceled
- Actions: create_refund, update_refund, cancel_refund
- Rules:
  - a refund may not exceed the unrefunded balance of its charge Enforced by: create_refund. Tested by: refund_within_balance
  - a charge with no unrefunded balance accepts no further refund Enforced by: create_refund. Tested by: fully_refunded_refused
  - only a pending or requires_action refund can be canceled; a second cancel answers 409 Enforced by: cancel_refund. Tested by: cancel_only_open_refunds
  - a canceled refund stops counting against its charge, so its amount can be refunded again Enforced by: cancel_refund. Tested by: cancel_frees_balance
  - a refund must name an existing charge Enforced by: create_refund. Tested by: unknown_charge_refused
  - a refund names a charge or a payment intent Enforced by: create_refund. Tested by: refund_needs_charge_or_intent
  - update changes metadata only and leaves status and amount unchanged Enforced by: update_refund. Tested by: update_changes_metadata_only
  - a refund's status moves only along the declared refund transitions Enforced by the data model: status is a state field whose transitions the engine enforces on every write
  - amount is a whole number of at least 1 Enforced by the data model: amount is an int field with min 1, which input validation enforces
  - list_refunds returns rows newest first by created_at, ties by id descending, with starting_after and ending_before paging
### charge (charge)
- States: none
- Actions: create_charge
- Rules:
  - a created charge is captured in full: amount_captured equals amount and paid is true

## Jobs

None. The plan declares no job.

## Acceptance tests

### refund_within_balance
- Intent: A refund may not exceed the charge's unrefunded balance.
- Actions: create_charge, create_refund
- Description: Refund 3000 of a 5000 charge succeeds as pending; a further 2001 is refused with amount_too_large.

```js
(ctx) => { const ch = ctx.api('POST', '/v1/charges', { amount: 5000, currency: 'usd', description: 'plan test within balance' }).body; const first = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 3000 }); ctx.assert(first.status === 200 && first.body.status === 'pending' && first.body.amount === 3000, 'refund within balance failed: ' + JSON.stringify(first.body)); const over = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 2001 }); ctx.assert(over.status === 400 && over.body.error.code === 'amount_too_large', 'expected amount_too_large, got ' + JSON.stringify(over.body)); }
```
### fully_refunded_refused
- Intent: A charge with no unrefunded balance accepts no further refund.
- Actions: create_charge, create_refund
- Description: After a full refund of a 1000 charge, one more unit is refused with charge_already_refunded.

```js
(ctx) => { const ch = ctx.api('POST', '/v1/charges', { amount: 1000, currency: 'usd', description: 'plan test fully refunded' }).body; const full = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 1000 }); ctx.assert(full.status === 200, 'full refund failed: ' + JSON.stringify(full.body)); const again = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 1 }); ctx.assert(again.status === 400 && again.body.error.code === 'charge_already_refunded', 'expected charge_already_refunded, got ' + JSON.stringify(again.body)); }
```
### cancel_only_open_refunds
- Intent: Only an open refund can be canceled, and only once.
- Actions: create_charge, create_refund, cancel_refund
- Description: A pending refund cancels to canceled; canceling it again answers 409 invalid_state.

```js
(ctx) => { const ch = ctx.api('POST', '/v1/charges', { amount: 1000, currency: 'usd', description: 'plan test cancel once' }).body; const r = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 1000 }).body; const c1 = ctx.api('POST', '/v1/refunds/' + r.id + '/cancel'); ctx.assert(c1.status === 200 && c1.body.status === 'canceled', 'cancel failed: ' + JSON.stringify(c1.body)); const c2 = ctx.api('POST', '/v1/refunds/' + r.id + '/cancel'); ctx.assert(c2.status === 409 && c2.body.error.code === 'invalid_state', 'expected invalid_state on second cancel, got ' + JSON.stringify(c2.body)); }
```
### cancel_frees_balance
- Intent: A canceled refund no longer counts against its charge.
- Actions: create_charge, create_refund, cancel_refund
- Description: After canceling a 2000 refund of a 2000 charge, refunding 2000 again succeeds.

```js
(ctx) => { const ch = ctx.api('POST', '/v1/charges', { amount: 2000, currency: 'usd', description: 'plan test frees balance' }).body; const r = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 2000 }).body; const c = ctx.api('POST', '/v1/refunds/' + r.id + '/cancel'); ctx.assert(c.status === 200, 'cancel failed: ' + JSON.stringify(c.body)); const again = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 2000 }); ctx.assert(again.status === 200 && again.body.amount === 2000, 'balance not freed: ' + JSON.stringify(again.body)); }
```
### unknown_charge_refused
- Intent: A refund must name an existing charge.
- Actions: create_refund
- Description: A refund naming charge ch_9999 is refused with resource_missing.

```js
(ctx) => { const r = ctx.api('POST', '/v1/refunds', { charge: 'ch_9999', amount: 100 }); ctx.assert(r.status === 400 && r.body.error.code === 'resource_missing', 'expected resource_missing, got ' + JSON.stringify(r.body)); }
```
### refund_needs_charge_or_intent
- Intent: A refund names a charge or a payment intent.
- Actions: create_refund
- Description: A refund body with an amount but neither charge nor payment_intent is refused with input.invalid.

```js
(ctx) => { const r = ctx.api('POST', '/v1/refunds', { amount: 100 }); ctx.assert(r.status === 400 && r.body.error.code === 'input.invalid', 'expected input.invalid, got ' + JSON.stringify(r.body)); }
```
### update_changes_metadata_only
- Intent: Updating a refund changes its metadata and nothing else.
- Actions: create_charge, create_refund, update_refund
- Description: Setting metadata on a pending 500 refund keeps status pending and amount 500.

```js
(ctx) => { const ch = ctx.api('POST', '/v1/charges', { amount: 1500, currency: 'usd', description: 'plan test metadata' }).body; const r = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 500 }).body; const u = ctx.api('POST', '/v1/refunds/' + r.id, { metadata: '{"order":"1042"}' }); ctx.assert(u.status === 200 && u.body.metadata === '{"order":"1042"}', 'metadata not set: ' + JSON.stringify(u.body)); ctx.assert(u.body.status === 'pending' && u.body.amount === 500, 'update changed status or amount: ' + JSON.stringify(u.body)); }
```
### list_refunds_pages_newest_first
- Intent: Stripe paging returns newest first with has_more and starting_after.
- Actions: create_charge, create_refund
- Description: Three refunds on one charge list newest first; limit 2 returns two with has_more true, and starting_after the second returns the oldest with has_more false.

```js
(ctx) => { const ch = ctx.api('POST', '/v1/charges', { amount: 1000, currency: 'usd', description: 'plan test paging' }).body; const a = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 100 }).body; const b = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 100 }).body; const c = ctx.api('POST', '/v1/refunds', { charge: ch.id, amount: 100 }).body; const p1 = ctx.api('GET', '/v1/refunds?charge=' + ch.id + '&limit=2'); ctx.assert(p1.status === 200 && p1.body.data.length === 2 && p1.body.has_more === true, 'page 1 wrong: ' + JSON.stringify(p1.body)); ctx.assert(p1.body.data[0].id === c.id && p1.body.data[1].id === b.id, 'page 1 not newest first: ' + JSON.stringify(p1.body.data.map((r) => r.id))); const p2 = ctx.api('GET', '/v1/refunds?charge=' + ch.id + '&limit=2&starting_after=' + b.id); ctx.assert(p2.status === 200 && p2.body.data.length === 1 && p2.body.data[0].id === a.id && p2.body.has_more === false, 'page 2 wrong: ' + JSON.stringify(p2.body)); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_refunds` | GET | /v1/refunds | List refunds newest first with Stripe paging, filterable by charge (spec operation GET /v1/refunds). |
| `create_refund` | POST | /v1/refunds | Create a refund against a charge (spec operation POST /v1/refunds). Built as the create_refund action. |
| `get_refund` | GET | /v1/refunds/{id} | Retrieve one refund (spec operation GET /v1/refunds/{refund}). |
| `update_refund` | POST | /v1/refunds/{id} | Update a refund's metadata (spec operation POST /v1/refunds/{refund}). Built as the update_refund action. |
| `cancel_refund` | POST | /v1/refunds/{id}/cancel | Cancel an open refund (spec operation POST /v1/refunds/{refund}/cancel). Built as the cancel_refund action. |
| `create_charge` | POST | /v1/charges | Added, not in the kept spec operations: creates a charge already captured in full, so tests and agents can hold charges. Built as the create_charge action. Listed in assumptions. |
| `list_charges` | GET | /v1/charges | Added, not in the kept spec operations: lets an agent find a charge id. Listed in assumptions. |
| `get_charge` | GET | /v1/charges/{id} | Added, not in the kept spec operations: reads one charge. Listed in assumptions. |

## Seed

- Rows per entity: charge: 8, refund: 12
- Mix: Eight charges in usd, each described as an order number (order 1003, 1005, 1008, 1011, 1014, 1017, 1020, 1026). Twelve refunds spread over them so that the list needs two pages at pageSize 10. The requires_action refund on order 1003 is the oldest refund, so it sits on page 2 of the unfiltered list. Order 1011 has a pending refund and order 1020 has a succeeded refund, so each still has balance. All created_at values lie before the clock start, and every charge's active refunds fit within its amount.
- State mix: refund: pending 25%, requires_action 8%, succeeded 42%, failed 8%, canceled 17%

## Tasks

- `cancel_pending_refund` (easy, irreversible): The customer on the charge for order 1011 changed their mind about the refund still pending on that charge. Cancel that pending refund. The charge also has a succeeded refund that must stay as it is.
  - Actions: `cancel_refund`
  - Decoy idea: Files a second refund for the pending amount instead of canceling it; the remaining balance is too small, so it is refused or leaves the pending refund open.
  - Pressure: seeded rows in refund.pending; distractor rows of refund
- `refund_remaining_balance` (medium, scarce_resource): Refund everything still refundable on the charge for order 1020, as requested by the customer. The succeeded refund already on that charge stays.
  - Actions: `create_refund`
  - Decoy idea: Refunds the full charge amount, which overbooks the balance already refunded and is refused with amount_too_large.
  - Pressure: seeded rows in refund.succeeded; distractor rows of refund
- `cancel_and_reissue_refund` (hard): A refund on the charge for order 1003 is stuck waiting for action. Cancel that stuck refund, then refund the same amount on that charge as requested by the customer. The succeeded refund on the same charge stays.
  - Actions: `cancel_refund`, `create_refund`
  - Decoy idea: Refunds the amount again without canceling the stuck refund, leaving it open so two refunds for the amount now exist.
  - Pressure: paging past the first page of refund; seeded rows in refund.requires_action; distractor rows of refund

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

None. The plan changes no existing item.
