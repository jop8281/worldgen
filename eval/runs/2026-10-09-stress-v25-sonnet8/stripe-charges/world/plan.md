# WorldGen plan: Stripe API (charges, refunds, customers), version 2024-06-20

A Stripe-style payments world. Agents list and retrieve charges with Stripe's paging, create charges (captured at once or held pending), capture held charges and refund captured ones. Customers group charges. Refunds are stored as their own rows and returned by the refund action.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A Stripe customer that charges can reference. | name, email, description |
| `charge` | A payment attempt. Holds amount, currency, capture state, refunded totals and status. Field names follow the spec (amount_captured, amount_refunded, receipt_email, failure_code, metadata, created). | amount, currency, customer, description, captured, paid, refunded, status, amount_captured, amount_refunded, created |
| `refund` | A refund against a charge, created by the refund action. | charge, amount, currency, reason, status |

## Workflows

### charge_lifecycle (charge)
- States: pending, succeeded, failed
- Actions: create_charge, capture_charge, refund_charge, create_customer
- Rules:
  - A charge needs an integer amount of at least 1, a 3-letter lowercase currency, and an existing customer if one is given. Otherwise the create is refused. Enforced by: create_charge. Tested by: create_charge_validation
  - A charge created without capture=false is captured at once: status succeeded, paid and captured true, amount_captured equal to amount, amount_refunded 0, refunded false. Enforced by: create_charge. Tested by: create_charge_captured
  - A charge created with capture=false is held: status pending, captured false, paid false, amount_captured 0. Enforced by: create_charge. Tested by: create_charge_uncaptured
  - Only a pending charge can be captured. Capturing moves it to succeeded with amount_captured equal to amount. Capturing again is refused with 409 charge_already_captured. Enforced by: capture_charge. Tested by: capture_charge_flow
  - A refund can only be made on a succeeded charge, and its amount cannot exceed amount_captured minus amount_refunded. The refund adds to amount_refunded and refunded becomes true when the whole captured amount is refunded. Enforced by: refund_charge. Tested by: refund_partial_then_full
  - An over-refund or a refund on a pending charge changes nothing and is refused (400 amount_too_large, 409 charge_not_refundable). Enforced by: refund_charge. Tested by: refund_refusals
  - Charges list newest first with has_more, starting_after and ending_before paging, and the customer filter returns only that customer's charges. Enforced by: create_charge. Tested by: list_charges_paging
  - The charge's customer must exist. Enforced by the data model: customer is a ref field, so the data model refuses an unknown customer.

## Jobs

None. The plan declares no job.

## Acceptance tests

### create_charge_captured
- Intent: A default charge is captured at once
- Actions: create_charge
- Description: Create a charge without capture. It is succeeded, paid, captured, fully captured and not refunded, and GET returns the same.

```js
(ctx) => {
  const r = ctx.api('POST', '/v1/charges', { amount: 2000, currency: 'usd', description: 'acceptance coffee beans' });
  ctx.assert(r.status === 200, 'create returned ' + r.status + ' ' + JSON.stringify(r.body));
  const c = r.body;
  ctx.assert(c.object === 'charge' && String(c.id).startsWith('ch_'), 'charge object with ch_ id, got ' + JSON.stringify(c));
  ctx.assert(c.status === 'succeeded' && c.paid === true && c.captured === true, 'captured at once, got ' + c.status);
  ctx.assert(c.amount === 2000 && c.amount_captured === 2000 && c.amount_refunded === 0 && c.refunded === false, 'amounts wrong ' + JSON.stringify(c));
  ctx.assert(c.currency === 'usd' && c.description === 'acceptance coffee beans', 'currency and description kept');
  const g = ctx.api('GET', '/v1/charges/' + c.id);
  ctx.assert(g.status === 200 && g.body.id === c.id && g.body.status === 'succeeded', 'get returned ' + g.status);
}
```
### create_charge_uncaptured
- Intent: capture=false holds the charge as pending
- Actions: create_charge
- Description: Create a charge with capture false. It is pending, not captured, not paid and has amount_captured 0.

```js
(ctx) => {
  const r = ctx.api('POST', '/v1/charges', { amount: 4500, currency: 'eur', capture: false, receipt_email: 'hold@example.com' });
  ctx.assert(r.status === 200, 'create returned ' + r.status + ' ' + JSON.stringify(r.body));
  const c = r.body;
  ctx.assert(c.status === 'pending' && c.captured === false && c.paid === false, 'held, got ' + JSON.stringify(c));
  ctx.assert(c.amount === 4500 && c.amount_captured === 0 && c.amount_refunded === 0 && c.refunded === false, 'amounts wrong ' + JSON.stringify(c));
  ctx.assert(c.receipt_email === 'hold@example.com', 'receipt_email kept');
}
```
### create_charge_validation
- Intent: Bad input is refused and writes nothing
- Actions: create_charge
- Description: Missing amount, missing currency, zero amount and an unknown customer are refused.

```js
(ctx) => {
  const noAmount = ctx.api('POST', '/v1/charges', { currency: 'usd' });
  ctx.assert(noAmount.status === 400 && noAmount.body.error.code === 'input.invalid', 'missing amount: ' + JSON.stringify(noAmount));
  const noCurrency = ctx.api('POST', '/v1/charges', { amount: 500 });
  ctx.assert(noCurrency.status === 400 && noCurrency.body.error.code === 'input.invalid', 'missing currency: ' + JSON.stringify(noCurrency));
  const zero = ctx.api('POST', '/v1/charges', { amount: 0, currency: 'usd' });
  ctx.assert(zero.status === 400 && zero.body.error.code === 'amount_invalid', 'zero amount: ' + JSON.stringify(zero));
  const unknown = ctx.api('POST', '/v1/charges', { amount: 500, currency: 'usd', customer: 'cus_9999' });
  ctx.assert(unknown.status === 400 && unknown.body.error.code === 'resource_missing', 'unknown customer: ' + JSON.stringify(unknown));
}
```
### capture_charge_flow
- Intent: A pending charge is captured once
- Actions: create_charge, capture_charge
- Description: Capture a held charge. It becomes succeeded and fully captured. A second capture is refused with 409 charge_already_captured.

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/charges', { amount: 7000, currency: 'usd', capture: false }).body;
  ctx.assert(c.status === 'pending', 'created pending');
  const r = ctx.api('POST', '/v1/charges/' + c.id + '/capture', {});
  ctx.assert(r.status === 200, 'capture returned ' + r.status + ' ' + JSON.stringify(r.body));
  ctx.assert(r.body.status === 'succeeded' && r.body.captured === true && r.body.paid === true && r.body.amount_captured === 7000, 'captured, got ' + JSON.stringify(r.body));
  const again = ctx.api('POST', '/v1/charges/' + c.id + '/capture', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'charge_already_captured', 'second capture: ' + JSON.stringify(again));
  const missing = ctx.api('POST', '/v1/charges/ch_9999/capture', {});
  ctx.assert(missing.status === 404 && missing.body.error.code === 'row.not_found', 'missing: ' + JSON.stringify(missing));
}
```
### refund_partial_then_full
- Intent: Refunds accumulate until the charge is refunded
- Actions: create_charge, refund_charge
- Description: Refund 1000 of 3000, then the remainder by default. refunded turns true only after the second refund.

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/charges', { amount: 3000, currency: 'usd' }).body;
  const r1 = ctx.api('POST', '/v1/charges/' + c.id + '/refund', { amount: 1000, reason: 'requested_by_customer' });
  ctx.assert(r1.status === 200, 'refund returned ' + r1.status + ' ' + JSON.stringify(r1.body));
  ctx.assert(r1.body.object === 'refund' && r1.body.amount === 1000 && r1.body.charge === c.id && r1.body.status === 'succeeded' && r1.body.reason === 'requested_by_customer', 'refund object, got ' + JSON.stringify(r1.body));
  const mid = ctx.api('GET', '/v1/charges/' + c.id).body;
  ctx.assert(mid.amount_refunded === 1000 && mid.refunded === false && mid.status === 'succeeded', 'partly refunded, got ' + JSON.stringify(mid));
  const r2 = ctx.api('POST', '/v1/charges/' + c.id + '/refund', {});
  ctx.assert(r2.status === 200 && r2.body.amount === 2000, 'remainder refunded, got ' + JSON.stringify(r2.body));
  ctx.assert(r2.body.id !== r1.body.id, 'second refund is a new refund');
  const end = ctx.api('GET', '/v1/charges/' + c.id).body;
  ctx.assert(end.amount_refunded === 3000 && end.refunded === true, 'fully refunded, got ' + JSON.stringify(end));
}
```
### refund_refusals
- Intent: Over-refunds and refunds of held charges change nothing
- Actions: create_charge, refund_charge
- Description: Refunding more than is left is 400 amount_too_large. Refunding a pending charge is 409 charge_not_refundable. The charges stay unchanged.

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/charges', { amount: 1500, currency: 'usd' }).body;
  const over = ctx.api('POST', '/v1/charges/' + c.id + '/refund', { amount: 1501 });
  ctx.assert(over.status === 400 && over.body.error.code === 'amount_too_large', 'over-refund: ' + JSON.stringify(over));
  ctx.assert(ctx.api('GET', '/v1/charges/' + c.id).body.amount_refunded === 0, 'nothing refunded');
  const held = ctx.api('POST', '/v1/charges', { amount: 900, currency: 'usd', capture: false }).body;
  const r = ctx.api('POST', '/v1/charges/' + held.id + '/refund', {});
  ctx.assert(r.status === 409 && r.body.error.code === 'charge_not_refundable', 'pending refund: ' + JSON.stringify(r));
  ctx.assert(ctx.api('GET', '/v1/charges/' + held.id).body.status === 'pending', 'still pending');
}
```
### list_charges_paging
- Intent: Stripe list paging and the customer filter work
- Actions: create_customer, create_charge
- Description: Create a customer and three charges. The customer filter with limit 2 returns the newest two with has_more true, and starting_after returns the oldest one with has_more false.

```js
(ctx) => {
  const cu = ctx.api('POST', '/v1/customers', { name: 'Paging Test Co', email: 'paging@example.com' });
  ctx.assert(cu.status === 201, 'customer create returned ' + cu.status + ' ' + JSON.stringify(cu.body));
  const id = cu.body.id;
  const ids = [];
  for (const amount of [100, 200, 300]) {
    const r = ctx.api('POST', '/v1/charges', { amount, currency: 'usd', customer: id });
    ctx.assert(r.status === 200 && r.body.customer === id, 'charge create: ' + JSON.stringify(r.body));
    ids.push(r.body.id);
  }
  const p1 = ctx.api('GET', '/v1/charges?customer=' + id + '&limit=2');
  ctx.assert(p1.status === 200 && p1.body.data.length === 2 && p1.body.has_more === true, 'page 1: ' + JSON.stringify(p1.body));
  ctx.assert(p1.body.data[0].id === ids[2] && p1.body.data[1].id === ids[1], 'newest first');
  const p2 = ctx.api('GET', '/v1/charges?customer=' + id + '&limit=2&starting_after=' + p1.body.data[1].id);
  ctx.assert(p2.status === 200 && p2.body.data.length === 1 && p2.body.has_more === false && p2.body.data[0].id === ids[0], 'page 2: ' + JSON.stringify(p2.body));
  const missing = ctx.api('GET', '/v1/charges/ch_9999');
  ctx.assert(missing.status === 404 && missing.body.error.code === 'row.not_found', 'missing charge: ' + JSON.stringify(missing));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_charges` | GET | /v1/charges | List charges, newest first, with limit, starting_after, ending_before and a customer filter (Stripe list paging). |
| `create_charge` | POST | /v1/charges | Create a charge. Built as the create_charge action. |
| `get_charge` | GET | /v1/charges/{id} | Retrieve a charge (the spec names the param {charge}). |
| `capture_charge` | POST | /v1/charges/{id}/capture | Extra action: capture a pending charge. |
| `refund_charge` | POST | /v1/charges/{id}/refund | Extra action: refund all or part of a captured charge. |
| `list_customers` | GET | /v1/customers | List customers, so an agent can find a customer id by name. |
| `get_customer` | GET | /v1/customers/{id} | Retrieve a customer. |
| `create_customer` | POST | /v1/customers | Create a customer (needed so tests and agents can make customers). |

## Seed

- Rows per entity: customer: 8, charge: 60, refund: 10
- Mix: Charges spread over 8 customers, with one customer (Acme Corp) holding more than 25 charges so its list needs a second page. Mostly succeeded, some pending (uncaptured), a few failed. Some succeeded charges are partly or fully refunded. Near-duplicate charges share an amount and customer but differ in description.
- State mix: charge: pending 20%, succeeded 65%, failed 15%

## Tasks

- `capture_northwind_hold` (easy, two_actors): Customer Northwind Traders has exactly one held (pending) charge. Capture it and change nothing else.
  - Actions: `capture_charge`
  - Decoy idea: Captures a pending charge belonging to another customer, or captures every pending charge.
  - Pressure: seeded rows in charge.pending; distractor rows of charge
- `refund_duplicate_charge` (medium, irreversible): Acme Corp was billed twice for 'Order #4471 annual plan'. Two succeeded charges have the same amount, and one has the description 'Order #4471 annual plan (duplicate)'. Refund that duplicate in full and leave the original alone.
  - Actions: `refund_charge`
  - Decoy idea: Refunds the original charge with the same amount, or refunds a pending or already refunded look-alike.
  - Pressure: paging past the first page of charge; seeded rows in charge.succeeded; distractor rows of charge
- `settle_acme_holds_and_refund_dupes` (hard, irreversible): For Acme Corp, capture every held (pending) charge, then fully refund every charge whose description starts with 'DUP' that is succeeded (including those just captured). Skip failed charges. Acme's charges span more than one page.
  - Actions: `capture_charge`, `refund_charge`
  - Decoy idea: Reads only the first page, refunds before capturing so held DUP charges are missed, or refunds failed or non-DUP charges.
  - Pressure: paging past the first page of charge; seeded rows in charge.pending, charge.succeeded, charge.failed; distractor rows of charge

## Open questions

- Should the capture and refund endpoints be added beyond the three kept operations?
  - Default answer: Yes, as declared extra operations, so tasks can change state.
- Should a refund create a separate Refund object returned to the caller?
  - Default answer: Yes. refund_charge returns the Refund object and stores it as a refund row.
- Is an uncaptured charge paid?
  - Default answer: No. Uncaptured means status pending, paid false.

## Assumptions

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

## Out of scope

- Payment intents, payment methods, cards, disputes, balance transactions, payouts, webhooks, idempotency keys, expand[] parameters
  - Why: Dropped from the subset. The 10 other operations are not in scope.
- Real card processing, 3-D Secure and auto-expiry of uncaptured charges
  - Why: This is a computation or integration concern, not stateful records.
- Basic auth enforcement and livemode behaviour
  - Why: The world is a single test-mode account. livemode is always false.

## Changes

None. The plan changes no existing item.
