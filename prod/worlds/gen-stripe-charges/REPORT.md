# WorldGen report: Stripe API (2024-06-20), charges and refunds subset

A deterministic replica of the Stripe REST charges and refunds surface. Customers hold a card state that decides how a new charge resolves (succeeded, failed or pending). Charges can be created uncaptured, then captured in full or in part. Refunds are issued against captured charges and move through pending to succeeded, failed or canceled. Jobs settle pending bank-debit charges, expire stale uncaptured authorizations after 7 days, and settle pending refunds. Agents list, retrieve, create, capture and refund with Stripe-style paths, a list envelope and an error body. The input keeps only three charge operations. The world adds refunds, capture and customer lookup so that writes and realistic tasks are possible.

## What was built

Entities (3):

- `customer`: 40 seeded rows
- `charge`: 140 seeded rows
- `refund`: 50 seeded rows

Routes (6):

- `list_charges`: GET /v1/charges
- `get_charge`: GET /v1/charges/{id}
- `list_refunds`: GET /v1/refunds
- `get_refund`: GET /v1/refunds/{id}
- `list_customers`: GET /v1/customers
- `get_customer`: GET /v1/customers/{id}

Actions (4):

- `create_charge`: POST /v1/charges
- `capture_charge`: POST /v1/charges/{id}/capture
- `create_refund`: POST /v1/refunds
- `cancel_refund`: POST /v1/refunds/{id}/cancel

Jobs (3):

- `settle_pending_charges`: every 1h
- `expire_uncaptured_charges`: every 1h
- `settle_refunds`: every 15m

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 9 world tests, 0 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| capture_pending_authorization | easy | 1.000 | 0.000 | 0.500, 0.000, 0.000 | n/a |
| refund_duplicate_charge | medium | 1.000 | 0.000 | 0.000, 0.700, 0.300, 0.000 | n/a |
| cancel_mistaken_pending_refund | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a |
| refund_remaining_balance_for_customer | hard | 1.000 | 0.000 | 0.667, 0.600, 0.000, 0.000, 0.000 | 0.933 |

Decoys:

- `capture_pending_authorization` 0.500: captures only part of the authorization, so the rest is released and amount_captured is below the charge amount
- `capture_pending_authorization` 0.000: captures the open authorization of the similarly named customer Harbor Freight Supply instead of Harbor Freight Co
- `capture_pending_authorization` 0.000: creates a new captured charge for the same amount instead of capturing, so the authorization stays open and the customer is billed twice
- `refund_duplicate_charge` 0.000: refunds the earlier of the two duplicate charges instead of the later one
- `refund_duplicate_charge` 0.700: refunds the later duplicate in full but with the reason requested_by_customer instead of duplicate
- `refund_duplicate_charge` 0.300: refunds only half of the later duplicate charge
- `refund_duplicate_charge` 0.000: refunds the Cedar charge that has the same amount but a different description, which is not the duplicate
- `cancel_mistaken_pending_refund` 0.000: cancels the pending refund of the Support plan charge, a different Northwind charge, instead of the Annual plan renewal one
- `cancel_mistaken_pending_refund` 0.000: cancels every pending refund of Northwind Health charges, which also cancels the unrelated Support plan refund
- `cancel_mistaken_pending_refund` 0.000: creates a new charge for the same amount to replace the refunded one, which does not undo the refund
- `refund_remaining_balance_for_customer` 0.667: reads only the first page of the customer's charges, so it misses the targets on later pages
- `refund_remaining_balance_for_customer` 0.600: refunds the full charge amount instead of the remaining balance, which is refused on partially refunded or partially captured charges so those stay unfinished
- `refund_remaining_balance_for_customer` 0.000: also releases the uncaptured authorizations of the customer, which should stay open
- `refund_remaining_balance_for_customer` 0.000: refunds the right amounts on every page but leaves out the reason, so no refund has requested_by_customer
- `refund_remaining_balance_for_customer` 0.000: also refunds the remaining balances of the similarly named customer Redwood Logistics

## Run

Mode: create from openapi. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.66 | 0.1523 |
| model | 1 | 0.31 | 0.0737 |
| workflow | 1 | 1.98 | 0.2556 |
| seed | 1 | 2.24 | 0.2930 |
| tasks | 1 | 2.08 | 0.3227 |
| Total | 5 | 8.26 | 1.0973 |

Run total: 8.41 minutes, $1.0973.
