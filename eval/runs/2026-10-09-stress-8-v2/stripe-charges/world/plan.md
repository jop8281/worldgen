# WorldGen plan: Stripe API (charges and refunds), version 2024-06-20

A Stripe-style payments world. Agents create charges (captured or authorized only), capture them later, refund them partly or fully, and page through charges with Stripe's newest-first list envelope. Refunds are irreversible and bounded by the captured amount.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `charge` | A card payment. Holds amount, captured/refunded totals, customer string id, status (pending, succeeded, failed) and metadata. | amount, amount_captured, amount_refunded, captured, refunded, currency, customer, description, receipt_email, status, metadata, created |
| `refund` | A full or partial reversal of a captured charge. Cannot be undone. | charge, amount, currency, reason, status, metadata |

## Workflows

### charge_lifecycle (charge)
- States: pending, succeeded, failed
- Actions: create_charge, capture_charge
- Rules:
  - A charge created with capture true (default) is captured: amount_captured equals amount. With capture false it is authorized only, amount_captured is 0. Enforced by: create_charge. Tested by: create_charge_capture_modes
  - Only an authorized, uncaptured, succeeded charge can be captured, and only once. Enforced by: capture_charge. Tested by: capture_uncaptured_charge
  - Create requires a positive integer amount and a currency; otherwise it is refused. Enforced by: create_charge. Tested by: create_charge_validation
  - Charges list newest first with has_more and the customer filter (standard list route).
### refund_flow (refund)
- States: pending, succeeded, failed
- Actions: refund_charge
- Rules:
  - A refund needs a captured charge and cannot exceed amount_captured minus amount_refunded. It updates amount_refunded and sets refunded true when fully refunded. Refunds are irreversible. Enforced by: refund_charge. Tested by: refund_partial_then_full
  - An over-refund or a refund of an uncaptured charge is refused and changes nothing. Enforced by: refund_charge. Tested by: refund_refusals

## Jobs

None. The plan declares no job.

## Acceptance tests

### create_charge_capture_modes
- Intent: Charges are captured by default and authorized only with capture false
- Actions: create_charge
- Description: Create one default charge and one with capture false and compare captured fields.

```js
(ctx) => {
  const a = ctx.api('POST', '/v1/charges', { amount: 2500, currency: 'usd', customer: 'cus_accept1', description: 'default capture' });
  ctx.assert(a.status === 200, 'create returned ' + a.status + ' ' + JSON.stringify(a.body));
  ctx.assert(a.body.object === 'charge' && a.body.captured === true && a.body.amount_captured === 2500 && a.body.status === 'succeeded' && a.body.paid === true, 'captured charge: ' + JSON.stringify(a.body));
  ctx.assert(a.body.amount_refunded === 0 && a.body.refunded === false, 'no refunds yet');
  const b = ctx.api('POST', '/v1/charges', { amount: 900, currency: 'usd', customer: 'cus_accept1', capture: false });
  ctx.assert(b.status === 200 && b.body.captured === false && b.body.amount_captured === 0, 'authorized only: ' + JSON.stringify(b.body));
  const g = ctx.api('GET', '/v1/charges/' + b.body.id);
  ctx.assert(g.status === 200 && g.body.id === b.body.id, 'retrieve works');
}
```
### create_charge_validation
- Intent: Invalid create input is refused
- Actions: create_charge
- Description: Missing amount, missing currency and zero amount are refused.

```js
(ctx) => {
  const noAmount = ctx.api('POST', '/v1/charges', { currency: 'usd' });
  ctx.assert(noAmount.status === 400 && noAmount.body.error.code === 'input.invalid', 'missing amount: ' + JSON.stringify(noAmount));
  const noCur = ctx.api('POST', '/v1/charges', { amount: 500 });
  ctx.assert(noCur.status === 400 && noCur.body.error.code === 'input.invalid', 'missing currency: ' + JSON.stringify(noCur));
  const zero = ctx.api('POST', '/v1/charges', { amount: 0, currency: 'usd' });
  ctx.assert(zero.status === 400 || zero.status === 422, 'zero amount refused, got ' + zero.status);
  const missing = ctx.api('GET', '/v1/charges/ch_doesnotexist');
  ctx.assert(missing.status === 404 && missing.body.error.code === 'row.not_found', 'missing charge: ' + JSON.stringify(missing));
}
```
### capture_uncaptured_charge
- Intent: An authorized charge can be captured once
- Actions: create_charge, capture_charge
- Description: Create an uncaptured charge, capture it, then a second capture is refused with 409 invalid_state.

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/charges', { amount: 4000, currency: 'usd', customer: 'cus_accept2', capture: false });
  ctx.assert(c.status === 200 && c.body.captured === false, 'created uncaptured');
  const cap = ctx.api('POST', '/v1/charges/' + c.body.id + '/capture', {});
  ctx.assert(cap.status === 200 && cap.body.captured === true && cap.body.amount_captured === 4000, 'captured: ' + JSON.stringify(cap));
  const again = ctx.api('POST', '/v1/charges/' + c.body.id + '/capture', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second capture: ' + JSON.stringify(again));
  const none = ctx.api('POST', '/v1/charges/ch_doesnotexist/capture', {});
  ctx.assert(none.status === 404 && none.body.error.code === 'not_found', 'missing charge: ' + JSON.stringify(none));
}
```
### refund_partial_then_full
- Intent: Refunds accumulate on the charge up to the captured amount
- Actions: create_charge, refund_charge
- Description: Refund 1000 of 3000, then the remainder by default; the charge becomes refunded.

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/charges', { amount: 3000, currency: 'usd', customer: 'cus_accept3' }).body;
  const r1 = ctx.api('POST', '/v1/charges/' + c.id + '/refunds', { amount: 1000, reason: 'requested_by_customer' });
  ctx.assert(r1.status === 200 && r1.body.object === 'refund' && r1.body.amount === 1000 && r1.body.charge === c.id && r1.body.status === 'succeeded', 'partial refund: ' + JSON.stringify(r1));
  const mid = ctx.api('GET', '/v1/charges/' + c.id).body;
  ctx.assert(mid.amount_refunded === 1000 && mid.refunded === false, 'partly refunded: ' + JSON.stringify(mid));
  const r2 = ctx.api('POST', '/v1/charges/' + c.id + '/refunds', {});
  ctx.assert(r2.status === 200 && r2.body.amount === 2000, 'default refunds the remainder: ' + JSON.stringify(r2));
  const end = ctx.api('GET', '/v1/charges/' + c.id).body;
  ctx.assert(end.amount_refunded === 3000 && end.refunded === true, 'fully refunded: ' + JSON.stringify(end));
  const list = ctx.api('GET', '/v1/charges/' + c.id + '/refunds').body;
  ctx.assert(list.data.length === 2 && list.has_more === false, 'two refunds listed');
}
```
### refund_refusals
- Intent: Over-refunds and refunds of uncaptured charges are refused and change nothing
- Actions: create_charge, refund_charge
- Description: Refund more than captured, refund an uncaptured charge, refund a fully refunded charge.

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/charges', { amount: 1500, currency: 'usd', customer: 'cus_accept4' }).body;
  const over = ctx.api('POST', '/v1/charges/' + c.id + '/refunds', { amount: 1501 });
  ctx.assert(over.status === 409 && over.body.error.code === 'amount_too_large', 'over-refund: ' + JSON.stringify(over));
  ctx.assert(ctx.api('GET', '/v1/charges/' + c.id).body.amount_refunded === 0, 'nothing changed');
  ctx.assert(ctx.api('POST', '/v1/charges/' + c.id + '/refunds', {}).status === 200, 'full refund');
  const again = ctx.api('POST', '/v1/charges/' + c.id + '/refunds', { amount: 1 });
  ctx.assert(again.status === 409 && again.body.error.code === 'amount_too_large', 'refund after full refund: ' + JSON.stringify(again));
  const u = ctx.api('POST', '/v1/charges', { amount: 700, currency: 'usd', customer: 'cus_accept4', capture: false }).body;
  const unc = ctx.api('POST', '/v1/charges/' + u.id + '/refunds', {});
  ctx.assert(unc.status === 409 && unc.body.error.code === 'invalid_state', 'uncaptured refund: ' + JSON.stringify(unc));
}
```
### list_charges_paging_and_filter
- Intent: Charges list newest first with Stripe paging and a customer filter
- Actions: create_charge
- Description: Create three charges for a unique customer, page through them with limit and starting_after, and check the filter.

```js
(ctx) => {
  const ids = [];
  for (const amt of [101, 202, 303]) ids.push(ctx.api('POST', '/v1/charges', { amount: amt, currency: 'usd', customer: 'cus_pagetest9' }).body.id);
  const p1 = ctx.api('GET', '/v1/charges?customer=cus_pagetest9&limit=2');
  ctx.assert(p1.status === 200 && p1.body.data.length === 2 && p1.body.has_more === true, 'page 1: ' + JSON.stringify(p1.body));
  ctx.assert(p1.body.data[0].id === ids[2] && p1.body.data[1].id === ids[1], 'newest first');
  const p2 = ctx.api('GET', '/v1/charges?customer=cus_pagetest9&limit=2&starting_after=' + p1.body.data[1].id);
  ctx.assert(p2.body.data.length === 1 && p2.body.data[0].id === ids[0] && p2.body.has_more === false, 'page 2: ' + JSON.stringify(p2.body));
  const other = ctx.api('GET', '/v1/charges?customer=cus_nobodyhere');
  ctx.assert(other.status === 200 && other.body.data.length === 0, 'unknown customer lists empty');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_charges` | GET | /v1/charges | List charges newest first with starting_after, ending_before, limit and customer filter. |
| `create_charge` | POST | /v1/charges | Create a charge. Built as the create_charge action. capture=false leaves it authorized only. |
| `get_charge` | GET | /v1/charges/{charge} | Retrieve a charge by id. |
| `capture_charge` | POST | /v1/charges/{charge}/capture | Added on purpose: capture an authorized charge. |
| `refund_charge` | POST | /v1/charges/{charge}/refunds | Added on purpose: refund part or all of a captured charge. |
| `list_charge_refunds` | GET | /v1/charges/{charge}/refunds | Added on purpose: list refunds of one charge, standing for the refunds list on Charge. |

## Seed

- Rows per entity: charge: 40, refund: 10
- Mix: Charges across 6 customers, mostly USD with some EUR and GBP. About 60% succeeded (most captured, a few authorized-only), 20% pending, 20% failed. Some succeeded charges are partly or fully refunded. Several charges share similar descriptions to act as distractors.
- State mix: charge: succeeded 60%, pending 20%, failed 20%

## Tasks

- `refund_duplicate_charge` (easy, irreversible): Customer cus_northwind was charged twice for the same 'Annual plan' invoice: refund fully the later of the two identical captured charges, and leave the other alone.
  - Actions: `refund_charge`
  - Decoy idea: Refunds the earlier charge, or refunds both.
- `capture_pending_authorizations` (medium, scarce_resource): For one customer, capture the authorized-only charges that are succeeded and uncaptured, and partially refund a given amount of one named captured charge without exceeding what is still refundable.
  - Actions: `capture_charge`, `refund_charge`
  - Decoy idea: Refunds more than the remaining refundable amount or uses a similar charge of another customer.
  - Pressure: distractor rows of charge
- `close_out_customer_account` (hard, irreversible): For customer cus_harbor, find every charge across all list pages that is captured, succeeded and not yet refunded, with amount under 5000 minor units, and refund it fully; first capture any authorized-only succeeded charge of that customer that is under 5000. Skip failed and pending charges.
  - Actions: `capture_charge`, `refund_charge`
  - Decoy idea: Reads only the first page, refunds failed or pending charges, or refunds without capturing first.
  - Pressure: paging past the first page of charge; seeded rows in charge.succeeded, charge.pending, charge.failed; distractor rows of charge

## Open questions

- Should the world accept form-encoded bodies like real Stripe?
  - Default answer: No, JSON only.
- Should customers be their own entity?
  - Default answer: No, customer is a string id on the charge.
- Should capture and refund actions be added beyond the three kept operations?
  - Default answer: Yes, they are needed for stateful tasks.

## Assumptions

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

## Out of scope

- Customers, payment intents, disputes, balance transactions, expandable fields, idempotency keys
  - Why: Dropped from the spec subset.
- Real card networks, 3-D Secure, fees, webhooks
  - Why: Computation or external behavior, not records.
- Basic auth enforcement
  - Why: The world has no users to authorize.

## Changes

None. The plan changes no existing item.
