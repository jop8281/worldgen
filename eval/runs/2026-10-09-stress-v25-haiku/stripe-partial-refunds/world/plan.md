# WorldGen plan: Stripe API (charges and refunds subset, version 2024-06-20)

A Stripe-style payments world with charges and refunds. An agent creates charges, refunds them in part or in full, cancels pending refunds, and reads paged Stripe-style lists. Refund status moves through a state machine, a job settles old pending refunds, and charge amount_refunded always tracks live refunds. Customers are a plain string on the charge, because no customer operation is among the kept eight.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T12:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `charge` | A payment of amount minor units in a currency. Created by create_charge; amount_refunded and refunded move only through refund actions. | id, amount, currency, customer, description, amount_refunded, refunded, status |
| `refund` | A refund of part or all of one charge. Status is a state field with the spec's five values; only create_refund, cancel_refund and the settle_refunds job move it. metadata is the only editable field. | id, charge, amount, currency, status, reason, metadata |

## Workflows

### charge (charge)
- States: succeeded, pending, failed
- Actions: create_charge
- Rules:
  - a created charge is succeeded, captured and paid unless capture is false, with nothing refunded Enforced by: create_charge. Tested by: charge_create_and_get
  - amount_refunded equals the sum of a charge's live refunds, and refunded turns true once it equals amount Enforced by: create_refund, cancel_refund. Tested by: full_refund_marks_charge
  - amount is a positive integer in minor units and currency is three lowercase letters Enforced by the data model: amount is an int with min 1 and currency a string with a three-letter lowercase pattern; the data model refuses other values.
### refund (refund)
- States: pending, requires_action, succeeded, failed, canceled
- Actions: create_refund, cancel_refund
- Rules:
  - a refund names a charge; its amount cannot exceed the charge's remaining refundable amount; a refund without an amount refunds the remainder Enforced by: create_refund. Tested by: refund_over_amount_refused
  - only a pending refund can be cancelled, and cancelling returns its amount to the charge Enforced by: cancel_refund. Tested by: cancel_refund_rules
  - a pending refund at least 24 hours old is settled to succeeded Enforced by: settle_refunds. Tested by: refund_settles_after_24h
  - charge, currency, amount, status and creation time are fixed on a refund; only metadata is editable Enforced by the data model: those fields are readonly, so a standard update refuses them with field.readonly
  - status moves only along the declared transitions Enforced by the data model: refund.status is a state field whose transitions the engine enforces on every write

## Jobs

- `settle_refunds` runs every 1h: every pending refund whose created_at is at least 1440 minutes before now becomes succeeded

## Acceptance tests

### charge_create_and_get
- Intent: create_charge stores the charge as succeeded, captured and paid, returns it by id, and refuses a zero amount
- Actions: create_charge
- Description: Create a charge, read it back, refuse amount 0 with 400, and refuse an unknown charge with row.not_found.

```js
(ctx) => { const c = ctx.api('POST', '/v1/charges', { amount: 1234, currency: 'usd', customer: 'acc_cus_t1', description: 'acceptance charge one' }); ctx.assert(c.status === 200, 'create charge: ' + JSON.stringify(c.body)); ctx.assert(c.body.amount === 1234 && c.body.currency === 'usd', 'amount and currency kept'); ctx.assert(c.body.status === 'succeeded' && c.body.captured === true && c.body.paid === true, 'succeeded, captured and paid by default'); ctx.assert(c.body.amount_refunded === 0 && c.body.refunded === false, 'nothing refunded yet'); const g = ctx.api('GET', '/v1/charges/' + c.body.id); ctx.assert(g.status === 200 && g.body.id === c.body.id, 'get returns the charge'); const bad = ctx.api('POST', '/v1/charges', { amount: 0, currency: 'usd' }); ctx.assert(bad.status === 400, 'zero amount refused, got ' + bad.status); const miss = ctx.api('GET', '/v1/charges/ch_9999'); ctx.assert(miss.status === 404 && miss.body.error.code === 'row.not_found', 'unknown charge: ' + JSON.stringify(miss.body)); }
```
### charge_list_paging
- Intent: list_charges pages in Stripe style, newest first, with has_more, starting_after and ending_before
- Actions: create_charge
- Description: Create three charges for one customer, then page them with limit 2 using starting_after and ending_before.

```js
(ctx) => { const ids = []; for (const n of [1, 2, 3]) { const c = ctx.api('POST', '/v1/charges', { amount: 100 * n, currency: 'usd', customer: 'acc_cus_t2' }); ctx.assert(c.status === 200, 'create: ' + JSON.stringify(c.body)); ids.push(c.body.id); } const p1 = ctx.api('GET', '/v1/charges?customer=acc_cus_t2&limit=2'); ctx.assert(p1.status === 200 && p1.body.data.length === 2, 'first page of two: ' + JSON.stringify(p1.body)); ctx.assert(p1.body.data[0].id === ids[2] && p1.body.data[1].id === ids[1], 'newest first'); ctx.assert(p1.body.has_more === true, 'more rows past page one'); const p2 = ctx.api('GET', '/v1/charges?customer=acc_cus_t2&limit=2&starting_after=' + ids[1]); ctx.assert(p2.body.data.length === 1 && p2.body.data[0].id === ids[0] && p2.body.has_more === false, 'second page holds the oldest: ' + JSON.stringify(p2.body)); const back = ctx.api('GET', '/v1/charges?customer=acc_cus_t2&limit=2&ending_before=' + ids[0]); ctx.assert(back.body.data.length === 2 && back.body.data[0].id === ids[2] && back.body.has_more === false, 'ending_before returns the newer rows: ' + JSON.stringify(back.body)); }
```
### refund_over_amount_refused
- Intent: a charge takes several partial refunds until its refunded total reaches the amount; a refund that would exceed it is refused with no change to the charge or the refund rows
- Actions: create_refund
- Description: Charge 1000, refund 600, refuse 500 with 400 and check the charge and its refund list are unchanged, refuse a refund with no charge, refund the remaining 400 so the total reaches 1000 and the charge is refunded, then refuse any further refund.

```js
(ctx) => { const c = ctx.api('POST', '/v1/charges', { amount: 1000, currency: 'usd', customer: 'acc_cus_t3' }); ctx.assert(c.status === 200, 'charge: ' + JSON.stringify(c.body)); const r1 = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 600 }); ctx.assert(r1.status === 200 && r1.body.status === 'pending', 'first partial refund pending: ' + JSON.stringify(r1.body)); const over = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 500 }); ctx.assert(over.status === 400, 'refund above the remaining 400 refused, got ' + over.status); const mid = ctx.api('GET', '/v1/charges/' + c.body.id).body; ctx.assert(mid.amount_refunded === 600 && mid.refunded === false, 'refused refund changed nothing on the charge: ' + JSON.stringify(mid)); const rows = ctx.api('GET', '/v1/refunds?charge=' + c.body.id).body.data; ctx.assert(rows.length === 1 && rows[0].id === r1.body.id, 'refused refund wrote no row: ' + JSON.stringify(rows)); const none = ctx.api('POST', '/v1/refunds', { amount: 100 }); ctx.assert(none.status === 400, 'refund without a charge refused, got ' + none.status); const r2 = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 400 }); ctx.assert(r2.status === 200, 'refund of exactly the remainder: ' + JSON.stringify(r2.body)); const full = ctx.api('GET', '/v1/charges/' + c.body.id).body; ctx.assert(full.amount_refunded === 1000 && full.refunded === true, 'total reached the amount, charge refunded: ' + JSON.stringify(full)); const more = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 1 }); ctx.assert(more.status === 400, 'nothing left to refund, got ' + more.status); }
```
### cancel_refund_rules
- Intent: cancel_refund cancels only a pending refund, returns its amount to the charge, and refuses a second cancel
- Actions: create_refund, cancel_refund
- Description: Refund 700, cancel it, check the charge is back to 0 refunded, refuse a second cancel with invalid_state, and refuse an unknown refund with 404.

```js
(ctx) => { const c = ctx.api('POST', '/v1/charges', { amount: 1000, currency: 'usd', customer: 'acc_cus_t4' }); ctx.assert(c.status === 200, 'charge: ' + JSON.stringify(c.body)); const r = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 700 }); ctx.assert(r.status === 200, 'refund: ' + JSON.stringify(r.body)); const x = ctx.api('POST', '/v1/refunds/' + r.body.id + '/cancel', {}); ctx.assert(x.status === 200 && x.body.status === 'canceled', 'cancel pending: ' + JSON.stringify(x.body)); const ch = ctx.api('GET', '/v1/charges/' + c.body.id).body; ctx.assert(ch.amount_refunded === 0 && ch.refunded === false, 'amount returned to the charge: ' + JSON.stringify(ch)); const again = ctx.api('POST', '/v1/refunds/' + r.body.id + '/cancel', {}); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel: ' + JSON.stringify(again.body)); const none = ctx.api('POST', '/v1/refunds/re_9999/cancel', {}); ctx.assert(none.status === 404, 'unknown refund: ' + none.status); }
```
### refund_settles_after_24h
- Intent: the settle_refunds job turns a pending refund into succeeded only once it is at least a day old
- Actions: create_refund
- Description: Create a pending refund, advance 2 hours and see it still pending, then advance 24 hours and see settle_refunds fire and the refund succeed.

```js
(ctx) => { const c = ctx.api('POST', '/v1/charges', { amount: 500, currency: 'usd', customer: 'acc_cus_t5' }); const r = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 500 }); ctx.assert(r.status === 200 && r.body.status === 'pending', 'pending refund: ' + JSON.stringify(r.body)); ctx.advance('2h'); ctx.assert(ctx.api('GET', '/v1/refunds/' + r.body.id).body.status === 'pending', 'still pending after two hours'); const run = ctx.advance('24h'); ctx.assert(run.jobsFired.includes('settle_refunds'), 'settle_refunds fired: ' + JSON.stringify(run)); ctx.assert(run.jobsFailed.length === 0, 'no job failed: ' + JSON.stringify(run.jobsFailed)); ctx.assert(ctx.api('GET', '/v1/refunds/' + r.body.id).body.status === 'succeeded', 'settled after a day'); }
```
### refund_update_metadata_only
- Intent: update_refund edits metadata and refuses every readonly field
- Actions: create_refund
- Description: Create a refund with metadata, update its metadata, refuse an amount change with field.readonly, and check the refund is unchanged.

```js
(ctx) => { const c = ctx.api('POST', '/v1/charges', { amount: 300, currency: 'usd', customer: 'acc_cus_t6' }); const r = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 300, metadata: 'acc note' }); ctx.assert(r.status === 200, 'refund: ' + JSON.stringify(r.body)); const up = ctx.api('POST', '/v1/refunds/' + r.body.id, { metadata: 'acc reviewed' }); ctx.assert(up.status === 200 && up.body.metadata === 'acc reviewed', 'metadata updated: ' + JSON.stringify(up.body)); const bad = ctx.api('POST', '/v1/refunds/' + r.body.id, { amount: 5 }); ctx.assert(bad.status === 422 && bad.body.error.code === 'field.readonly', 'amount is fixed: ' + JSON.stringify(bad.body)); const same = ctx.api('GET', '/v1/refunds/' + r.body.id).body; ctx.assert(same.amount === 300 && same.status === 'pending', 'refund unchanged by the refused update'); }
```
### full_refund_marks_charge
- Intent: a full refund sets the charge's amount_refunded and refunded, and cancelling it reopens the charge
- Actions: create_refund, cancel_refund
- Description: Refund a charge with no amount, check it is fully refunded, refuse more, cancel the refund, and check the charge is reopened.

```js
(ctx) => { const c = ctx.api('POST', '/v1/charges', { amount: 800, currency: 'usd', customer: 'acc_cus_t7' }); const r = ctx.api('POST', '/v1/refunds', { charge: c.body.id }); ctx.assert(r.status === 200 && r.body.amount === 800, 'no amount refunds the remainder: ' + JSON.stringify(r.body)); const full = ctx.api('GET', '/v1/charges/' + c.body.id).body; ctx.assert(full.amount_refunded === 800 && full.refunded === true, 'fully refunded: ' + JSON.stringify(full)); const more = ctx.api('POST', '/v1/refunds', { charge: c.body.id, amount: 1 }); ctx.assert(more.status === 400, 'no more refunds, got ' + more.status); const x = ctx.api('POST', '/v1/refunds/' + r.body.id + '/cancel', {}); ctx.assert(x.status === 200, 'cancel: ' + JSON.stringify(x.body)); const back = ctx.api('GET', '/v1/charges/' + c.body.id).body; ctx.assert(back.amount_refunded === 0 && back.refunded === false, 'charge reopened: ' + JSON.stringify(back)); }
```
### refund_list_by_charge
- Intent: list_refunds filtered by charge returns only that charge's refunds
- Actions: create_refund
- Description: Refund two charges, list refunds filtered to the first charge, and check only its refund is returned.

```js
(ctx) => { const a = ctx.api('POST', '/v1/charges', { amount: 900, currency: 'usd', customer: 'acc_cus_t8' }); const b = ctx.api('POST', '/v1/charges', { amount: 900, currency: 'usd', customer: 'acc_cus_t8' }); const ra = ctx.api('POST', '/v1/refunds', { charge: a.body.id, amount: 100 }); const rb = ctx.api('POST', '/v1/refunds', { charge: b.body.id, amount: 200 }); ctx.assert(ra.status === 200 && rb.status === 200, 'two refunds'); const list = ctx.api('GET', '/v1/refunds?charge=' + a.body.id); ctx.assert(list.status === 200, 'list: ' + JSON.stringify(list.body)); ctx.assert(list.body.data.length === 1 && list.body.data[0].id === ra.body.id, 'only the refund of charge a: ' + JSON.stringify(list.body)); ctx.assert(list.body.data.every((r) => r.charge === a.body.id), 'every row names charge a'); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `create_charge` | POST | /v1/charges | Create a charge (action create_charge, answers 200 as the spec does). |
| `list_charges` | GET | /v1/charges | Stripe-mode list of charges, newest first; filters customer and description. |
| `get_charge` | GET | /v1/charges/{id} | Retrieve one charge. |
| `create_refund` | POST | /v1/refunds | Create a refund against a charge (action create_refund, answers 200). |
| `list_refunds` | GET | /v1/refunds | Stripe-mode list of refunds, newest first; filter charge. |
| `get_refund` | GET | /v1/refunds/{id} | Retrieve one refund. |
| `update_refund` | POST | /v1/refunds/{id} | Update a refund's metadata; any other field is refused as readonly. |
| `cancel_refund` | POST | /v1/refunds/{id}/cancel | Cancel a pending refund (action cancel_refund). |

## Seed

- Rows per entity: charge: 12, refund: 10
- Mix: 12 charges, just over one page of 10, so paging matters: 3 task targets (Team plan, March renewal with no refund; Conference tickets, October with a pending full refund; Studio rental, deposit with a pending refund of 1500 out of 2000), 1 near-duplicate Conference tickets, October (resend) with a succeeded refund, and 8 generic charges. 10 refunds: 3 pending, 5 succeeded, 2 canceled, all created within the 2 days before clock start. The Studio charge is the oldest, so it sits on page 2 of newest-first lists.
- State mix: refund: pending 30%, requires_action 0%, succeeded 50%, failed 0%, canceled 20%

## Tasks

- `refund_team_plan_in_full` (easy): Refund the full amount of the charge described 'Team plan, March renewal'; change nothing else. The agent must find the charge by its description and create one refund with no amount.
  - Decoy idea: refunds the charge in part (a fixed amount of 100) instead of the full remainder
- `cancel_mistaken_refund` (medium, irreversible): Cancel the still-pending refund on the charge described 'Conference tickets, October'. The near-duplicate charge 'Conference tickets, October (resend)' and its succeeded refund must stay untouched.
  - Actions: `cancel_refund`
  - Decoy idea: cancels the succeeded refund on the resend charge, which the rules refuse, or refunds a second time on the wrong charge
  - Pressure: seeded rows in refund.pending; distractor rows of charge
- `resize_studio_refund` (hard, scarce_resource): The pending refund of 1500 on the charge described 'Studio rental, deposit' was wrong. Cancel it, then issue a refund of 1200 on the same charge. The charge has 2000, so 1200 fits only after the cancel. Change nothing else.
  - Actions: `cancel_refund`, `create_refund`
  - Decoy idea: issues the 1200 refund before cancelling, which the remaining 500 refuses, then cancels; or cancels and refunds the old 1500 again
  - Pressure: seeded rows in refund.pending

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

- tests.refund_over_amount_refused
