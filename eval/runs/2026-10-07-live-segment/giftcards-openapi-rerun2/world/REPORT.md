# WorldGen report: Shopify-style gift card API (Gift Cards with activities: create, load, redeem, refund, adjust, freeze, unfreeze, deactivate)

A gift card ledger. Cards move pending -> active -> frozen/deactivated. Every balance change is an append-only activity (load, redeem, refund, adjust), and a card's balance is always the sum of its activities. Agents look up cards and their ledgers, post activities and freeze, unfreeze or deactivate cards.

## What was built

Entities (2):

- `gift_card`: 30 seeded rows
- `gift_card_activity`: 81 seeded rows

Routes (3):

- `list_gift_cards`: GET /v1/gift_cards
- `get_gift_card`: GET /v1/gift_cards/{id}
- `list_gift_card_activities`: GET /v1/gift_cards/{gift_card_id}/activities

Actions (5):

- `create_gift_card`: POST /v1/gift_cards
- `create_gift_card_activity`: POST /v1/gift_cards/{gift_card}/activities
- `freeze_gift_card`: POST /v1/gift_cards/{gift_card}/freeze
- `unfreeze_gift_card`: POST /v1/gift_cards/{gift_card}/unfreeze
- `deactivate_gift_card`: POST /v1/gift_cards/{gift_card}/deactivate

Jobs: none.

## Assumed and why

- Clock starts 2026-10-07T09:00:00.000Z with tick 1s. All seeded cards and activities are dated before that.
  - Why: Seed history must precede clock.start, and a 1s tick gives every created activity a distinct, ordered created_at without needing explicit advances. No jobs, so no future events.
- Create gift card and create activity are built as actions with the spec's paths and answer 201. Freeze, unfreeze and deactivate are actions answering 200.
  - Why: They generate the gan, maintain the balance and move state, so a plain create route cannot do them. state, balance and gan are readonly fields.
- A new card starts pending with balance 0, and its first load activates it.
  - Why: The spec has a pending state but no activate endpoint, so the first load is the only way out of pending.
- Activity amount is signed in the ledger: redeem is stored negated and the request sends a positive amount. adjust is sent signed and stored as sent.
  - Why: The spec says the balance is the sum of the activities.
- Activity state rules: load needs pending or active; redeem and refund need active; adjust needs active or frozen; a deactivated card takes nothing. All state refusals are 409 invalid_state.
  - Why: The spec gives 409 on the activity endpoint without detail. This is a plain real-world model.
- The balance may not go below 0. A redeem or adjust that would do so is refused 409 insufficient_balance. A non-positive load, redeem or refund, or a zero adjust, is 400 invalid_amount. A missing or non-integer amount and a bad type or currency are the engine's 400 input.invalid.
  - Why: A gift card has no credit, and the spec gives 400 for bad input.
- A non-null reference is unique per card and activity type (409 duplicate_reference).
  - Why: It acts as a simple idempotency key and gives the medium and hard tasks realistic traps.
- Action handlers answer a missing card with 404 code not_found. The standard GET answers row.not_found.
  - Why: The engine's codes cover standard routes. Actions use codes the plan names.
- The gan is a 16-digit numeric string generated from a counter, with no checksum or PIN.
  - Why: It must be unique and deterministic.
- The list activities route is scoped by the {gift_card_id} path param. The action routes use {gift_card} as the spec names it. Lists use the cursor mode envelope data and next_cursor with pageSize 25.
  - Why: Scoped list params must be named like a ref field. The spec's list envelope is cursor mode.
- Test scripts create their own rows with emails ending @example.test. The seed uses only @example.com emails and ORD- references.
  - Why: This avoids test.seed_collision and keeps the tests independent of seed rows.
- Test scripts build query strings without encodeURIComponent, since the sandbox does not provide it. Emails and cursors are passed as returned.
  - Why: Revision 1 failed with 'encodeURIComponent is not defined'. The test emails contain only URL-safe characters plus @, and cursors are opaque strings used verbatim.
- No jobs: pending cards never expire and nothing is scheduled.
  - Why: The spec has no time-driven behaviour.

## Questions asked of the input

- How does a card leave the pending state, since there is no activate endpoint?
  - Default answer: The first successful load activates it.
- Is the redeem amount stored positive or negative in the activity, given the balance is the sum of the activities?
  - Default answer: Stored negative. The request amount is positive.
- Which states allow which activity types?
  - Default answer: Load on pending and active, redeem and refund on active, adjust on active and frozen, nothing on deactivated.
- Can a card be overdrawn?
  - Default answer: No. 409 insufficient_balance, and nothing is written.
- Can a pending card be deactivated, and does deactivation keep the balance?
  - Default answer: Yes to both. Deactivate works on pending, active and frozen cards and keeps the balance.
- Is the reference an idempotency key?
  - Default answer: Only as 'unique per card and type when non-null', refused 409 duplicate_reference.

## Left out

- The 2 operations the filtered spec dropped under /v1/gift_cards (for example update and delete of a card)
  - Why: The input kept only 8 of 10 operations, so cards cannot be edited or deleted. Deactivate is the only way to retire one.
- Authentication, API keys and idempotency-key headers
  - Why: The spec declares none, and reference covers idempotency per card.
- Currency conversion, multi-currency redemption and gan checksums or PINs
  - Why: Each card keeps one currency, and these add rules the spec does not describe.
- Card expiry, auto-deactivation of drained cards and email notifications
  - Why: The spec has no time-driven or outbound behaviour.
- Customer, order and merchant entities
  - Why: The spec models only customer_email as a plain string on the card.

## Proof

The engine check passed: 8 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_ec22afef0d98a4b0d78b0340f2d328c0ae90a031145d20cc537c8014ad534075`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | TID |
|---|---|---|---|---|---|---|
| freeze_marias_active_card | easy | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | `tid_2e20dde83a9cd6a4ac4599f082776317b3c34ba530e9f56319c3609dc0a685ea` |
| refund_duplicate_redemption | medium | 1.000 | 0.000 | 0.000, 0.300, 0.000, 0.700 | n/a | `tid_13e1881d529df69f05d6ba12c07a07e9a4438479251817b492c5cf930b3c65e9` |
| deactivate_drained_cards | hard | 1.000 | 0.000 | 0.714, 0.000, 0.571, 0.000 | 0.857 | `tid_18555118d6de341f9044be89bb89078cff347a249ffdbb96f4b44627b2cbcb50` |

Decoys:

- `freeze_marias_active_card` 0.000: deactivates the active card instead of freezing it
- `freeze_marias_active_card` 0.000: freezes the active card of a customer with a similar email (maria.lopes) instead of Maria Lopez
- `freeze_marias_active_card` 0.000: freezes the right card, then also freezes the similarly named customer's card
- `refund_duplicate_redemption` 0.000: refunds the same-last-four card in the wrong currency (GBP) instead of the EUR card
- `refund_duplicate_redemption` 0.300: refunds the sum of both redemptions instead of only the duplicate
- `refund_duplicate_redemption` 0.000: posts an adjust instead of a refund activity
- `refund_duplicate_redemption` 0.700: refunds the right amount on the right card but leaves out the required reference
- `deactivate_drained_cards` 0.714: reads only the first page of cards, so it misses the drained cards on page 2
- `deactivate_drained_cards` 0.000: also deactivates pending cards with balance 0
- `deactivate_drained_cards` 0.571: only filters active cards, so frozen drained cards are skipped
- `deactivate_drained_cards` 0.000: treats a small non-zero balance as drained and also deactivates cards under 100 minor units

## Run

Mode: create from openapi. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 4.35 | 0.7549 |
| model | 2 | 0.45 | 0.2537 |
| workflow | 3 | 0.96 | 0.4560 |
| seed | 1 | 0.74 | 0.1778 |
| tasks | 1 | 1.06 | 0.2362 |
| Total | 9 | 7.56 | 1.8787 |

Backtracks:

- `workflow` to `plan`: 1 issue

Run total: 7.57 minutes, $1.8787.
