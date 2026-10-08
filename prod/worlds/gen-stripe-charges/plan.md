# WorldGen plan: Stripe API (2024-06-20), charges and refunds subset

A deterministic replica of the Stripe REST charges and refunds surface. Customers hold a card state that decides how a new charge resolves (succeeded, failed or pending). Charges can be created uncaptured, then captured in full or in part. Refunds are issued against captured charges and move through pending to succeeded, failed or canceled. Jobs settle pending bank-debit charges, expire stale uncaptured authorizations after 7 days, and settle pending refunds. Agents list, retrieve, create, capture and refund with Stripe-style paths, a list envelope and an error body. The input keeps only three charge operations. The world adds refunds, capture and customer lookup so that writes and realistic tasks are possible.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A Stripe customer that charges are billed to. card_state is a simulation switch for the card on file and decides how a new charge for this customer resolves. | name, email, description, card_state (enum: valid, declined, expired, bank_debit), livemode |
| `charge` | A payment attempt, mirroring the Stripe Charge object. Unix timestamps become ISO datetimes in created_at. Status is a state machine. captured, paid, amount_captured, amount_refunded and refunded are maintained by actions and jobs. | amount (int, minor units, min 50), currency (enum: usd, eur, gbp), customer (ref customer, nullable), description, receipt_email, status (state: pending, succeeded, failed), paid, captured, amount_captured, amount_refunded, refunded, failure_code, failure_message, payment_intent, livemode |
| `refund` | A refund of all or part of a captured charge, mirroring the Stripe Refund object. Written by create_refund, cancel_refund and the jobs. Refunds are also listed in charge refunds via GET /v1/refunds?charge=. | charge (ref charge), amount (int), currency, reason (enum: duplicate, expired_uncaptured_charge, fraudulent, requested_by_customer; nullable), status (state: pending, succeeded, failed, canceled), failure_reason (enum, nullable), receipt_number (nullable), payment_intent |

## Workflows

### charge_lifecycle (charge)
- States: pending, succeeded, failed
- Actions: create_charge, capture_charge
- Rules:
  - Transitions: pending to succeeded or failed. succeeded and failed are final. The status is changed only by actions and jobs.
  - create_charge needs amount (int, min 50) and currency, and takes optional customer, description, receipt_email and capture (default true). An unknown customer is 422. The outcome follows customer.card_state, as in the assumptions.
  - A succeeded captured charge has paid true, captured true and amount_captured equal to amount. With capture=false the charge is succeeded, paid true, captured false and amount_captured 0, and stays authorized for 7 days. A failed charge has paid false, captured false, amount_captured 0, and failure_code and failure_message set. A pending charge has paid false and captured false.
  - capture_charge needs a succeeded, uncaptured, not refunded charge, otherwise 409. Optional amount_to_capture must be between 1 and amount, otherwise 422. It sets captured true, paid true and amount_captured. Capturing twice is 409.
  - A charge's refunded flag is true only when amount_refunded equals the captured amount (or the full amount for a released authorization). amount_refunded never exceeds amount_captured.
  - The settle_pending_charges job moves pending charges older than 48h to succeeded, and expire_uncaptured_charges releases uncaptured charges older than 7 days.
### refund_lifecycle (refund)
- States: pending, succeeded, failed, canceled
- Actions: create_refund, cancel_refund
- Rules:
  - Transitions: pending to succeeded, failed or canceled. The other states are final.
  - create_refund needs charge, and takes optional amount (default: the full refundable balance, amount_captured minus amount_refunded) and reason (duplicate, fraudulent or requested_by_customer). Unknown charge is 422. A charge that is not succeeded is 409. A charge that is already fully refunded is 409. An amount above the refundable balance, or below 1, is 422. The refund copies the charge currency.
  - A refund for a captured charge starts pending and its amount is added to charge.amount_refunded at once. When the total reaches amount_captured, the charge gets refunded true. A refund for an uncaptured charge is the full-release case from the assumptions, and starts succeeded.
  - cancel_refund works only on a pending refund, otherwise 409. It moves the refund to canceled, subtracts its amount from the charge's amount_refunded and clears refunded.
  - settle_refunds moves pending refunds older than 1h to succeeded with a receipt_number, or to failed with failure_reason expired_or_canceled_card, when the charge's customer has card_state expired. A failed refund is subtracted from amount_refunded like a canceled one.
  - expire_uncaptured_charges creates succeeded refunds with reason expired_uncaptured_charge for released authorizations.

## Jobs

- `settle_pending_charges` runs every 1h: For each pending charge created at least 48 hours ago, set status succeeded, paid true, captured true and amount_captured equal to amount, clearing nothing else. Leave younger pending charges alone.
- `expire_uncaptured_charges` runs every 1h: For each succeeded charge with captured false, refunded false and created at least 7 days ago, create a succeeded refund for the full amount with reason expired_uncaptured_charge and a receipt_number, and set the charge to refunded true with amount_refunded equal to amount.
- `settle_refunds` runs every 15m: For each pending refund created at least 1 hour ago, look up its charge and the charge's customer. If the customer's card_state is expired, set the refund to failed with failure_reason expired_or_canceled_card, subtract its amount from the charge's amount_refunded and set refunded false. Otherwise set it to succeeded with a receipt_number (a deterministic number built from the refund id).

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_charges` | GET | /v1/charges | List charges. Filters: customer, status, captured, paid, refunded. Search: description, receipt_email. Sort by created_at. Page size 10, as in Stripe's default. Cursor param is starting_after and the limit param is limit. |
| `get_charge` | GET | /v1/charges/{id} | Retrieve one charge. The id is the charge id, written {id} instead of Stripe's {charge}, because the engine's get route requires {id}. |
| `create_charge` | POST | /v1/charges | Create a charge. Built as an action with the same id, because it derives status, paid, captured and failure fields from the customer's card state and the capture flag. See workflows.charge_lifecycle. |
| `capture_charge` | POST | /v1/charges/{id}/capture | Capture an uncaptured charge, in full or in part. Action. |
| `list_refunds` | GET | /v1/refunds | List refunds. Filters: charge, status, reason. Sort by created_at. Replaces Stripe's nested charge refund list. |
| `get_refund` | GET | /v1/refunds/{id} | Retrieve one refund. |
| `create_refund` | POST | /v1/refunds | Create a refund for a charge. Action. |
| `cancel_refund` | POST | /v1/refunds/{id}/cancel | Cancel a pending refund. Action. |
| `list_customers` | GET | /v1/customers | List customers. Filter: card_state. Search: name, email. Agents use this to find a customer id by name or email. |
| `get_customer` | GET | /v1/customers/{id} | Retrieve one customer. |

## Seed

- Rows per entity: customer: 40, charge: 140, refund: 55
- Mix: All history is dated before 2026-10-06T09:00Z, spread over the previous 6 months. Customers: 40 with company names, about 70% card_state valid, 10% declined, 8% expired and 12% bank_debit, plus a few named anchor customers for the tasks. Charges: about 62% succeeded, 20% failed (declined or expired card, with failure_code and failure_message), 18% pending (bank_debit, created under 48h ago). Among succeeded charges, about 10% are uncaptured authorizations under 7 days old (a few are 5 to 6 days old), about 20% are partially refunded and about 15% fully refunded. A few customers have 20 or more charges so that results pass 10 per page. One planted duplicate-charge pair (same customer, amount and description, minutes apart) for the medium task. Refunds: about 50% succeeded, 15% pending (created under 1h before the clock start), 15% failed (failure_reason set), 10% canceled, 10% from expired_uncaptured_charge. A refund exists for every charge with amount_refunded above 0, and the sum of non-failed, non-canceled refund amounts equals charge.amount_refunded. Pending refunds and pending charges are young enough that no job fires on them at clock start.

## Tasks

- `capture_pending_authorization` (easy): The customer 'Harbor Freight Co' has one uncaptured charge, an authorization made with capture=false. Find that charge and capture it in full. Change nothing else. The agent must look up the customer by name, filter charges by customer, and pick the uncaptured one among that customer's succeeded charges. The grader checks that the charge is captured with amount_captured equal to amount, and that no other charge or refund changed.
  - Decoy idea: Captures the first charge listed for the customer, which is already captured (409), or captures an uncaptured charge of another customer with a similar name. Another decoy creates a new charge for the same amount, so the authorization stays open and a duplicate charge exists.
- `refund_duplicate_charge` (medium): Cedar Analytics says it was billed twice for the same order. Find the two succeeded charges of the same amount and description minutes apart, and refund the later one in full with reason duplicate. Do not touch the earlier charge. The agent must read the customer's charges, compare amounts, descriptions and created_at, and call the refund action with the later charge id. The grader checks one new refund on the later charge for its full amount with reason duplicate, amount_refunded updated, and no other changes. The earlier charge, and Cedar's other charges that share an amount with an unrelated description, are left alone.
  - Decoy idea: Refunds the earlier charge instead of the later one. Another decoy refunds the later charge in full but with reason requested_by_customer. A third refunds only half the amount. A fourth refunds a different Cedar charge with the same amount but another description.
- `cancel_mistaken_pending_refund` (medium): A support agent refunded the wrong charge for Northwind Health, a 'Annual plan renewal' charge, and the refund is still pending. Cancel that pending refund so the customer keeps the charge. The agent must find the customer's charge by description, list refunds filtered by charge, and cancel only the pending one. The grader checks the refund is canceled, the charge's amount_refunded is back to 0 and refunded is false, and the same customer's other pending refund and succeeded refund are untouched.
  - Decoy idea: Cancels the other pending refund for the customer, a different charge. Another decoy tries to cancel the succeeded refund on the same charge family and gets 409, then PATCHes nothing. A third creates a new charge to replace it, which does not undo the refund.
- `refund_remaining_balance_for_customer` (hard): Redwood Labs is closing its account. For every charge of Redwood Labs that is succeeded and captured and not fully refunded, refund the remaining balance (amount_captured minus amount_refunded) with reason requested_by_customer. Skip charges that are failed, pending, uncaptured or already fully refunded. The customer has more than 10 charges, so the list spans several pages. Some charges are partially refunded, so the refund amount is the remainder, not the full amount. The grader checks, per target charge, that amount_refunded now equals amount_captured and a refund with the correct amount and reason exists, scores the share of targets done, and fails on any refund against a non-target charge.
  - Decoy idea: Reads only the first page of the customer's charges and misses the targets on later pages. Another decoy refunds the full charge amount on partially refunded charges, which is refused with 422, so those are left unfinished. Another also refunds uncaptured authorizations, releasing holds that should stay. Another refunds with no reason or the wrong reason. Another includes charges from a customer with a similar name, for example Redwood Logistics.

## Open questions

- Should the world cover refunds, capture and customers, given that the input keeps only list, create and retrieve for charges?
  - Default answer: Yes. The summary says charges and refunds, and without them the world has no worthwhile tasks. They are recorded as an expansion in the assumptions.
- The proposed meta.api uses cursorKey has_more. Should list responses carry a boolean has_more as in Stripe?
  - Default answer: Yes, through meta.api.list mode stripe. Lists come newest first, and agents page with starting_after the last row id while has_more is true.
- Should a declined card return Stripe's 402 card_error?
  - Default answer: No. The engine cannot return 402 and rolls back on failure. create_charge returns 200 with a charge of status failed and failure_code set.
- Should request bodies be form-encoded as in Stripe?
  - Default answer: No. The engine accepts JSON bodies. Form encoding is out of scope.
- How should the world decide whether a charge succeeds, fails or stays pending, since no card or source is in the subset?
  - Default answer: A customer card_state field (valid, declined, expired, bank_debit) decides it. A charge with no customer succeeds.
- Should timestamps be unix integers like Stripe?
  - Default answer: No. They are ISO 8601 datetimes from the engine's created_at.
- What clock should the world use?
  - Default answer: Start 2026-10-06T09:00:00.000Z, after all seeded history, with a tick of 1s so every write gets a distinct time.
- Should metadata and livemode be modeled?
  - Default answer: No metadata. livemode is a constant false field.

## Assumptions

- clock.start is 2026-10-06T09:00:00.000Z with tick 1s. All seeded rows are dated before the start. Jobs fire after the start.
  - Why: Seeded charges and refunds are history and must precede the clock. A 1s tick gives every committed write a distinct created_at, so list order and graders are deterministic. Agents cannot move time, so jobs only run in world tests.
- The world covers refunds, capture and customers, which go beyond the three kept operations. The refund and capture routes are built as actions, and customers are read-only routes.
  - Why: The summary calls the subset 'charges and refunds', and the Refund schema is in the input. With only three operations the world has no write beyond create_charge and no realistic task. Capture and refund are the most common follow-ups in Stripe use.
- The list envelope uses meta.api.list mode stripe, with dataKey data, a boolean has_more, limitParam limit, and starting_after / ending_before id cursors.
  - Why: The engine's stripe paging mode emits has_more as a boolean, as Stripe does. Agents page by passing the last row id to starting_after while has_more is true. The rest of the proposed meta.api is kept: the error body keeps type invalid_request_error with $code and $message.
- Request bodies are JSON, not application/x-www-form-urlencoded. Expandable fields and the 'object' and 'url' envelope fields are not reproduced.
  - Why: The engine accepts JSON input only. expand adds little for rehearsal tasks.
- Timestamps are ISO 8601 datetimes (created_at) instead of Stripe unix integers.
  - Why: The engine fixes created_at as an ISO datetime and schemas have no unix type.
- Field names follow Stripe: a charge has customer, a refund has charge, and routes filter by those names, such as GET /v1/charges?customer=cus_0001. Ids look like ch_0001, re_0001 and cus_0001, not Stripe's random strings.
  - Why: This keeps query params compatible with the input. The engine's id format is fixed as <prefix>_<number>.
- amount is an int in minor units with a separate currency enum (usd, eur, gbp), not a money field. Minimum amount is 50.
  - Why: A money field fixes one currency, but each charge carries its own. 50 is Stripe's minimum charge.
- Customer.card_state decides a new charge: valid gives succeeded, paid and captured (or succeeded, paid and uncaptured when capture is false). declined gives status failed with failure_code card_declined. expired gives failed with expired_card. bank_debit gives pending with paid false until the settle job. A charge with no customer behaves as valid. capture=false with bank_debit returns 422.
  - Why: Stripe's behavior depends on the payment method, which the subset does not model. A card_state switch gives deterministic success, failure and pending outcomes for tasks.
- A failed charge is saved and create_charge returns 200 with status failed, not Stripe's 402 card_error.
  - Why: ctx.fail supports only 400, 404, 409 and 422 and rolls back all writes, so a 402 would not leave a failed charge behind.
- create_charge, capture_charge and create_refund validate input and return 4xx errors for bad requests, such as a refund over the refundable balance (422) or a refund of a failed charge (409).
  - Why: Agents should learn from clear errors. The engine only allows 400, 404, 409 and 422.
- Refunds start pending for captured charges, and count against amount_refunded at creation. Canceling a pending refund, or the job failing it, subtracts it from amount_refunded and clears refunded. Refunding an uncaptured charge releases the whole authorization: the amount must be omitted or equal the charge amount, the refund is created succeeded at once, and the charge becomes refunded with amount_refunded equal to amount while captured stays false.
  - Why: This matches Stripe's accounting closely enough that the refundable balance is amount_captured minus amount_refunded.
- Partial capture (amount_to_capture below amount) captures that amount and releases the rest, and the charge cannot be captured again.
  - Why: This is how Stripe handles partial capture, and it keeps the capture rule simple.
- Jobs: settle_pending_charges (every 1h) moves bank_debit charges older than 48h to succeeded with paid and captured. expire_uncaptured_charges (every 1h) releases uncaptured succeeded charges older than 7 days by creating a succeeded refund with reason expired_uncaptured_charge. settle_refunds (every 15m) turns pending refunds older than 1h into succeeded with a receipt_number, or into failed with failure_reason expired_or_canceled_card when the charge's customer has card_state expired.
  - Why: These are the time-driven behaviors of Stripe's refunds and authorizations. Seed ages are chosen so no job fires on seed rows at clock start.
- Auth, livemode, metadata and payment_intent are simplified. There is no auth check, livemode is always false, and metadata is not modeled. payment_intent is a nullable string set by create_charge and not a separate entity.
  - Why: Auth and metadata add nothing to the tasks. The engine has no basic auth, and a map type is not available.
- Lists come newest first by created_at, ties by id descending, as Stripe does. Stripe mode refuses ?sort, so no list route declares sort fields.
  - Why: Stripe returns newest first. Graders and decoys rely on a predictable order.

## Out of scope

- Charge update (POST /v1/charges/{charge}), payment intents, sources, tokens and card entry
  - Why: Dropped from the input. They need card data modeling the world does not have. Customer card_state replaces them.
- Form-encoded bodies, expand[], idempotency keys, Stripe-Version headers and webhooks
  - Why: The engine accepts JSON bodies only, and these do not change what tasks grade.
- Disputes, payouts, balance transactions, fees and multi-currency conversion
  - Why: Not in the subset. Refunds work within the charge currency.
- Basic auth and rate limits
  - Why: The engine has no auth layer. Every call is accepted.
- Customer creation and update routes
  - Why: Customers are seeded reference data, so no task needs to write them.

## Changes

None. The plan changes no existing item.
