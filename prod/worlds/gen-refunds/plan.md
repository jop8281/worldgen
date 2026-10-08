# WorldGen plan: Stripe API (Refunds and Charges), version 2024-06-20

A deterministic Stripe-style payments sandbox centred on refunds. Seeded charges can be refunded in full or in part through create_refund. Refunds follow Stripe's status lifecycle (pending, requires_action, succeeded, failed, canceled). Every refund keeps the parent charge's amount_refunded and refunded flag in step. Agents can list, retrieve, create, tag with metadata and cancel refunds, and read charges to find what to refund. Jobs settle pending refunds and expire stale requires_action ones. The world keeps Stripe's refund rules, such as the unrefunded-amount cap, the disputed-charge refusal, cancel only from requires_action, and merge-style metadata updates. It keeps Stripe's list envelope with has_more and starting_after / ending_before paging, but takes JSON bodies instead of form encoding. Revision 2: every task now declares an allows list (entity, kind, exact update fields, where) derived from its instruction, so any change outside it scores 0.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-01-05T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `charge` | A card, wallet or bank payment that can be refunded. Seed-only, with read routes so an agent can find it. Tracks how much has been refunded. | amount (money USD, > 0), amount_captured (money, 0 when captured is false), amount_refunded (money, readonly, equals the sum of the charge's pending, requires_action and succeeded refunds), refunded (bool, readonly, true when amount_refunded equals amount_captured and is above 0), captured (bool), paid (bool), status (enum succeeded\|pending\|failed), payment_method_type (enum card\|wallet\|bank_transfer, decides the status a new refund starts in), disputed (bool, blocks new refunds), customer (string, nullable, e.g. cus_ id text), receipt_email (string, nullable, email), description (string, nullable), payment_intent (string, nullable, unique, pi_ text), currency (enum usd), livemode (bool, default false), failure_code / failure_message (nullable), metadata (text, JSON object string) |
| `refund` | A full or partial return of money on one charge, walking Stripe's refund lifecycle. Created by create_refund, cancelled by cancel_refund, settled or expired by jobs. | charge (ref charge, required, readonly), payment_intent (string, nullable, copied from the charge), amount (money USD, readonly, > 0, never above the charge's unrefunded amount), currency (enum usd, readonly), reason (enum duplicate\|expired_uncaptured_charge\|fraudulent\|requested_by_customer, nullable, readonly), status (state: pending, requires_action, succeeded, failed, canceled; readonly; initial pending), failure_reason (enum lost_or_stolen_card\|expired_or_canceled_card\|charge_for_pending_refund_disputed\|insufficient_funds\|declined\|merchant_request\|unknown, nullable, readonly), receipt_number (string, nullable, readonly, set when status becomes succeeded), metadata (text, JSON object string, written only by create_refund and update_refund) |

## Workflows

### refund_lifecycle (refund)
- States: pending, requires_action, succeeded, failed, canceled
- Actions: create_refund, update_refund, cancel_refund
- Rules:
  - Initial status is set by create_refund from the charge's payment_method_type: card is succeeded at once (with a receipt_number), wallet is pending, bank_transfer is requires_action. The row is first written in the initial state pending and moved to its final state in the same call.
  - Allowed transitions: pending to succeeded, failed, requires_action or canceled. requires_action to succeeded, failed or canceled. succeeded, failed and canceled are final.
  - create_refund needs a charge or a payment_intent. When only a payment_intent is given, it resolves to the charge with that payment_intent. If both are given they must match. Neither or an unknown value returns 400 invalid_request_error, with code resource_missing for an unknown charge.
  - The charge must be captured with status succeeded. Otherwise 400 charge_not_refundable. A disputed charge returns 400 charge_disputed.
  - amount defaults to the charge's unrefunded balance (amount_captured minus amount_refunded). It must be an integer of at least 1. An amount above the unrefunded balance returns 400 amount_too_large, saying the refund amount is greater than the unrefunded amount on the charge. A fully refunded charge returns 400 charge_already_refunded.
  - Only pending, requires_action and succeeded refunds count towards charge.amount_refunded. A new refund adds its amount to the charge. A refund that becomes failed or canceled gives its amount back. charge.refunded is recomputed on every change.
  - cancel_refund works only while the status is requires_action. Any other status returns 400 with the current status in the message. It sets canceled and subtracts the amount from the charge.
  - update_refund merges the given metadata keys into the existing JSON object. A key set to an empty string is removed. A non-object or non-string value returns 400. It changes nothing else, and it works on a refund in any status.
  - The settle_pending_refunds job moves wallet refunds from pending to succeeded after 6 hours. If the charge has become disputed by then, the refund fails with failure_reason charge_for_pending_refund_disputed. The expire_requires_action job fails bank_transfer refunds left in requires_action for more than 14 days, with failure_reason expired_or_canceled_card.
  - Unknown refund ids return 404 resource_missing with the message No such refund: '<id>'. Errors use Stripe's body {error:{type,code,message}}.

## Jobs

- `settle_pending_refunds` runs every 1h: For each refund in pending status created 6 or more hours ago: if its charge is disputed, move it to failed with failure_reason charge_for_pending_refund_disputed and subtract its amount from charge.amount_refunded. Otherwise move it to succeeded and set receipt_number. Recompute charge.refunded for any charge it touches.
- `expire_requires_action` runs every 1d: For each refund in requires_action status created more than 14 days ago, move it to failed with failure_reason expired_or_canceled_card, give its amount back to charge.amount_refunded and recompute charge.refunded. Seed data keeps every requires_action refund under 14 days old, so this only fires after the clock is advanced in tests.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_refunds` | GET | /v1/refunds | List refunds, newest first, with the charge filter, limit (default 10, max 100) and starting_after cursor. Mirrors Stripe's list refunds. |
| `get_refund` | GET | /v1/refunds/{id} | Retrieve one refund. An unknown id returns 404 resource_missing: No such refund. |
| `create_refund` | POST | /v1/refunds | Create a refund, built as an action. It takes charge or payment_intent, an optional amount that defaults to the whole unrefunded balance, a reason and metadata. |
| `update_refund` | POST | /v1/refunds/{id} | Update a refund's metadata, built as an action. Keys are merged into the existing metadata, and an empty-string value removes a key. No other field can change. |
| `cancel_refund` | POST | /v1/refunds/{id}/cancel | Cancel a refund, built as an action. Only allowed while the status is requires_action. It gives the amount back to the charge. |
| `list_charges` | GET | /v1/charges | List charges, newest first, so an agent can find what to refund. Read-only helper added beyond the kept operations. Filters are customer, payment_intent and status, search covers receipt_email and description. |
| `get_charge` | GET | /v1/charges/{id} | Retrieve one charge with its amount_captured, amount_refunded and refunded values. Read-only helper. |

## Seed

- Rows per entity: charge: 80, refund: 70
- Mix: Charges: about 82% succeeded and captured, 8% pending (uncaptured), 10% failed. Payment method types are about 60% card, 20% wallet and 20% bank_transfer. Amounts run from 500 to 50000 cents, all USD. About 5% of the charges that carry refunds are disputed. Customers, receipt_emails and descriptions are plausible and repeat across a few charges, with deliberate near-duplicates such as similar order numbers. Charges are spread over 150 days before clock.start. Refund status mix across 70 rows: about 54% succeeded (38), 13% pending (9, mostly wallet, including one on a disputed charge), 16% requires_action (11, all bank_transfer, 7 older than 10 days and 4 newer, none older than 14 days), 9% failed (6) and 8% canceled (6). About 25 charges carry several refunds, including partial refunds, a failed or canceled refund beside a succeeded one, and one charge with two refunds of the same amount. Some refunds carry metadata such as {order_id: ...} so a merge differs from an overwrite. Failed charges never have refunds. charge.amount_refunded and charge.refunded are computed from the refunds (pending, requires_action and succeeded only). created_at is spread over the 150 days before clock.start, and a refund is never earlier than its charge. Anchor rows have stable ids for the tasks, and the tasks name them by customer, email or description, never by id.
- State mix: refund: succeeded 54%, pending 13%, requires_action 16%, failed 9%, canceled 8%

## Tasks

- `refund_annual_plan_in_full` (easy): Refund in full the charge for the 'Annual plan' made by the customer with a given receipt email, with reason requested_by_customer. The charge is succeeded, captured, not disputed and has no refunds yet. The customer's other charges have a monthly plan description. The grader checks for one new refund on that charge for the full amount, with that reason, and that charge.refunded is true. Allows (from the instruction): refund created, where reason is requested_by_customer; charge updated, fields amount_refunded and refunded only, where the seed row is that receipt_email's 'Annual plan' charge. Nothing else may change.
  - Decoy idea: Refunds the customer's other charge, a monthly-plan one with a similar description. Or refunds only part of the amount by passing a smaller number, or leaves out the reason.
- `refund_remaining_balance` (medium): One charge (found by customer name and an order description) has already been partly refunded. A succeeded refund and a canceled refund sit beside the earlier ones. The agent must create one more refund for exactly what remains refundable, with reason duplicate. The remaining amount is the charge's amount_captured minus its amount_refunded, which excludes the canceled refund. The grader checks the new refund amount, that the charge ends with refunded true and amount_refunded equal to amount_captured, and that nothing else changed. Allows (from the instruction): refund created, where reason is duplicate; charge updated, fields amount_refunded and refunded only, where the seed row is that customer's charge with that order description. Nothing else may change.
  - Decoy idea: Adds up every refund on the charge including the canceled one and refunds too little. Or sends no amount in the wrong way and refunds the full original amount, which the API rejects. Or refunds the right amount on a sibling charge with the same customer.
- `merge_ticket_into_refund_metadata` (medium): Add the support ticket reference ticket_id = ZD-4821 to the metadata of the most recent succeeded refund on a named customer's charges, keeping the keys already stored there (order_id and others). The customer has several refunds in different statuses and the newest overall is not succeeded, so the agent has to read statuses and created_at across the customer's charges. The grader checks the target's metadata JSON for the new key plus the old keys intact, and that no other refund changed. Allows (from the instruction): refund updated, fields metadata only, where status is succeeded and the refund belongs to that customer's charges (the target row is picked by the newest created_at). No other entity or field may change.
  - Decoy idea: Tags the newest refund regardless of status, or the first one in the list. Or replaces the whole metadata object so the earlier order_id is lost. Or tags the refund of a different customer with a similar name.
- `cancel_stale_requires_action_refunds` (hard): Cancel every refund that is still in requires_action and was created more than 10 days before the clock start, across all pages of the refund list. Leave the newer requires_action refunds, and every refund in another status, alone. Of the 11 requires_action refunds, 7 are older than 10 days, and they are spread so that some fall beyond the first page of 10 rows. The agent must read all pages and check created_at, because the list has no status filter. The grader scores the share of targets canceled and requires that charge.amount_refunded dropped by each canceled amount, that no non-target refund changed, and that no other row changed. Allows (from the instruction): refund updated, fields status only, where the seed status is requires_action (and older than 10 days); charge updated, fields amount_refunded and refunded only, where the charge carries one of those refunds. Nothing else may change.
  - Decoy idea: Reads only the first page of refunds, so it misses the targets on later pages. Or cancels every requires_action refund and ignores age. Or tries to cancel pending refunds too (rejected by the API), or uses update_refund to rewrite metadata instead of cancelling.

## Open questions

- Should read-only charge routes be added when only the refund operations were kept?
  - Default answer: Yes. Add GET /v1/charges and GET /v1/charges/{id} so agents can find charges and read amount_refunded.
- Should the list envelope use Stripe's has_more or the engine's next_cursor?
  - Default answer: Use Stripe's boolean has_more, through meta.api.list mode stripe, with starting_after and ending_before as id cursors.
- Should bodies be form-encoded like Stripe or JSON?
  - Default answer: JSON. The engine takes JSON for every action and route.
- How is the metadata map represented?
  - Default answer: As a JSON object string in a text field, merged key by key by update_refund, with an empty string deleting a key.
- Should the path parameter be {refund} as in the OpenAPI document?
  - Default answer: No. Use {id}, because the engine addresses rows by {id}.
- Which currencies are supported?
  - Default answer: USD only, with amounts in cents.
- Can create_refund accept payment_intent without charge?
  - Default answer: Yes. It resolves to the charge with that payment_intent. If both are sent they must match.
- Which refund statuses can be cancelled?
  - Default answer: Only requires_action, as in Stripe. Every other status returns 400 with its current status in the message.
- Do pending refunds ever settle, and how long do requires_action refunds live?
  - Default answer: Wallet refunds settle after 6 hours through a job, or fail if the charge is now disputed. A requires_action refund fails after 14 days. Both jobs run only when the clock advances.
- Is Basic auth or the Idempotency-Key header modelled?
  - Default answer: No. Any request is accepted and a repeated create is a new request.
- Should the allows list of a refund task include the parent charge's amount_refunded and refunded fields?
  - Default answer: Yes. Creating or cancelling a refund moves those two fields on the charge, so each task allows an update of exactly those fields on the target charge(s).

## Assumptions

- Add read-only GET /v1/charges and GET /v1/charges/{id} although only the 5 refund operations were kept
  - Why: Refunds point at charges, and an agent needs to find a charge and read its unrefunded balance. Without these routes the refund tasks cannot be discovered through the API.
- Use the path parameter {id} instead of Stripe's {refund}
  - Why: The world engine addresses rows with {id}. The URL shape is otherwise identical.
- Use Stripe's list envelope {data, has_more} through meta.api.list mode stripe, with limit, starting_after and ending_before
  - Why: The engine's stripe paging mode returns has_more as a boolean, lists newest first and pages by row id with starting_after or ending_before, as Stripe does. limit is 1 to 100. The default page size is 10, as in Stripe.
- Take the proposed error template: {error:{type:invalid_request_error, code, message}}
  - Why: It matches Stripe's shared error body. All errors use type invalid_request_error, including 404 resource_missing.
- Request and response bodies are JSON, not application/x-www-form-urlencoded
  - Why: The engine's actions and routes take JSON. Field names and meaning are unchanged.
- Store metadata as a text field holding a JSON object string, and make update_refund an action that merges keys
  - Why: The field types have no map type. Merge behaviour, with an empty string deleting a key, is a real Stripe trait that tasks can test.
- Create, update and cancel refund are actions. Their route ids repeat the action keys
  - Why: They change several rows at once (refund and charge totals). The plan's route entries with these ids are built as the actions.
- All money is USD integer minor units in money fields, with currency fixed to usd
  - Why: A money field has one fixed currency, so a mixed-currency world is not possible.
- created_at is an ISO timestamp instead of Stripe's unix-time created integer. The id prefixes are re_ and ch_ with numeric suffixes
  - Why: The engine maintains created_at and ids itself.
- The refund's initial status depends on the charge's payment_method_type: card succeeds at once, wallet is pending, bank_transfer is requires_action
  - Why: This gives a realistic spread of statuses, so cancel (only from requires_action) and settlement have something to act on.
- Refunds in status pending, requires_action and succeeded count towards charge.amount_refunded
  - Why: This matches Stripe's accounting, where failed and canceled refunds return the money to the unrefunded balance.
- Charges have no create, update or delete route and are changed only by refund actions and jobs
  - Why: Charge operations were outside the kept subset. Charges are fixed seed data except for refund totals.
- The tasks cannot advance the clock, so the age-based hard task reads created_at values fixed in the seed
  - Why: Tasks run through the public API with no clock control. Ages are measured against clock.start, so the instruction states the cutoff in days.
- Basic auth is not modelled and any request is accepted
  - Why: Auth adds nothing to the refund behaviour being rehearsed.
- Each task's allows list is derived from its instruction: the entities and kinds the instruction implies, the exact fields for updates, and a where of seed field values naming the target rows. Charge totals (amount_refunded, refunded) are allowed as the necessary side effect of a refund or cancel, since the instruction asks for the refund outcome that moves them
  - Why: The change request asks that allows come from the instruction, not from what the solution writes. The charge totals are part of what refunding or cancelling means in this world, so the instruction implies them.
- Workflow rules stay as plain text and no acceptance tests are added
  - Why: No new actions are introduced. Charges have no create route, so a test cannot build its own prerequisite charge through ctx.api, and the request does not ask for new tests. Only the four tasks change.

## Out of scope

- The 3 dropped operations and charge create, capture, update or cancel
  - Why: Outside the kept subset. Charges are seed data with read routes only.
- Expandable fields such as expand[]=charge and expanding refunds on a charge
  - Why: The engine returns plain field values. A refund's charge is an id string, and refunds of a charge are listed with GET /v1/refunds?charge=.
- The list object/url fields
  - Why: The engine's list envelope holds only data and has_more.
- Idempotency-Key headers and idempotency_error
  - Why: Header replay is not part of the engine. A repeated create_refund is an ordinary new request, limited by the unrefunded balance.
- Form-encoded bodies, the bracket syntax for metadata[key]=value, and Basic auth
  - Why: The world uses JSON bodies and accepts any caller.
- Disputes, payment intents and customers as their own resources, plus webhooks and events
  - Why: They are only referenced by id strings or a static disputed flag. They are not needed for the refund workflow.
- Multi-currency charges, livemode switching, the object field and unix-time created integers
  - Why: The engine has a fixed currency per money field and maintains ids and timestamps itself.
- Real card-network processing, failure randomness and the refund reasons expired_uncaptured_charge and the card-related failure_reason values beyond the job outcomes
  - Why: The world must be deterministic. These values can appear in seed rows but no endpoint produces them.
- Any change to entities, routes, actions, jobs, seed or tests
  - Why: The request only asks for allows lists on the tasks.

## Changes

- tasks.refund_annual_plan_in_full
- tasks.refund_remaining_balance
- tasks.merge_ticket_into_refund_metadata
- tasks.cancel_stale_requires_action_refunds
