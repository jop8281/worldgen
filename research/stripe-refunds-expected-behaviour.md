# Stripe refunds world: expected behaviour

This is the hand-checked oracle for the OpenAPI case. Per user decision U-9, Stripe is the OpenAPI input, and "add refunds" is the iterate demo. YOS-47, YOS-49, YOS-50 and YOS-52 read it. It fixes what a correct world does, so a generated world can be checked line by line.

Two worlds are described:

- **v1**: customers, payment_intents and charges, pruned from Stripe's OpenAPI spec (`openapi/spec3.json`, pinned in `research/portfolio.md`).
- **v2**: v1 after `worldgen "add refunds"`. It adds the Refund object and its routes.

How claims are marked:

- **[doc]**: stated in Stripe's public docs. The page is cited.
- **[unsure]**: my best reading. It was not confirmed in the docs and should be checked against stripe-mock or the spec before a grader depends on it.
- **[world]**: our decision for this world, not a Stripe fact.
- **[gap]**: the engine at `factory/integration` `19aabd5` cannot express it yet.

Pages read on 2026-10-06:

- Refunds: [create](https://docs.stripe.com/api/refunds/create), [object](https://docs.stripe.com/api/refunds/object), [list](https://docs.stripe.com/api/refunds/list)
- [Charge object](https://docs.stripe.com/api/charges/object), [list charges](https://docs.stripe.com/api/charges/list)
- [PaymentIntent object](https://docs.stripe.com/api/payment_intents/object), [capture](https://docs.stripe.com/api/payment_intents/capture)
- [Errors](https://docs.stripe.com/api/errors), [error codes](https://docs.stripe.com/error-codes), [idempotent requests](https://docs.stripe.com/api/idempotent_requests), [pagination](https://docs.stripe.com/api/pagination)
- [Refund and cancel payments guide](https://docs.stripe.com/refunds)

## 0. Engine fit: read this first

The portfolio decision (Q1 option B) is JSON request bodies plus a per-world error envelope, with no form encoding in the engine. Inside that decision, five Stripe behaviours do not fit the engine as it stands. Each needs either an engine change or a deviation written in the world's REPORT.

| # | Stripe behaviour | Engine at `19aabd5` | Recommendation |
|---|---|---|---|
| G1 | Error body `{error: {type, code, message, param}}` [doc: Errors]. **User decision U-4 requires this template, with a status code per operation.** | `meta.api.error` substitutes only `$status`, `$code` and `$message`. `ctx.fail(status, code, message)` has no `type` or `param`. | Add `$type` and `$param` to the template, and an optional `{type, param}` argument to `ctx.fail`. Until then, hard-code `"type": "invalid_request_error"` in the template and omit `param`. |
| G2 | `Idempotency-Key` request header [doc: Idempotent requests] | `ApiRequest` has `method`, `path`, `query` and `body`, and no headers | Add headers to `ApiRequest`, and give the engine (not handlers) a generic replay table. Until then, idempotency is out of scope, and a retried `POST /v1/refunds` creates a second refund, as real Stripe does without a key. |
| G3 | Lists: `{object: "list", url, has_more, data}`. `starting_after` and `ending_before` take an **object id**. Newest first. `limit` defaults to 10, maximum 100 [doc: Pagination] | Opaque base64 cursors in `next_cursor`, id-ascending by default, and `pageSize` is both the default and the maximum. An unknown query param (such as `ending_before`) is a 400 `query.unknown`. | Add a `meta.api.list.style: stripe` with id cursors, `has_more`, newest first, and separate default and maximum. This matters most. An agent that knows Stripe sends `starting_after=<last id>`, and today that returns 400 `cursor.invalid`. |
| G4 | `created` is an integer of Unix seconds | Rows carry an implicit ISO `created_at`. `ctx.time` has no epoch conversion. | Add `ctx.time.unix(iso)`, or document that `created_at` replaces `created`. |
| G5 | `charge.payment_intent` and `payment_intent.latest_charge` point at each other | The seed runs in ref order, so two refs that point at each other are a `seed.cycle` error | Make `latest_charge` a plain string (`pattern: ^ch_`), kept in step by the handlers. Only `charge.payment_intent` is a ref. |

Engine errors that a world handler does not produce carry engine codes, not Stripe codes. Examples are store validation (422 `field.type`, `field.unknown`, `field.readonly`) and routing (404 `route.not_found`, 405 `method.not_allowed`, 400 `query.unknown`). Stripe returns 400 `parameter_unknown`, `parameter_invalid_integer` and similar [doc: Error codes]. Section 4 lists the world's own errors with Stripe's codes. A per-world map from engine codes to (status, type, code) would close the rest. Until then this is a [gap].

## 1. Minimal subset

### Amounts

All amounts are integers in the smallest currency unit: 4999 is $49.99 [doc: Charge object `amount`]. A charge or PaymentIntent amount is at least $0.50 (50) and at most eight digits (99999999) [doc: PaymentIntent object `amount`]. A refund `amount` is a positive integer [doc: Create refund].

[world] There is one currency, `usd`. Amount fields use the engine's `money` type with `currency: USD`, which rejects floats, negatives and strings. Each object also carries a `currency` enum field `[usd]`, because Stripe's wire form is the lowercase code.

### Entities (v1)

| Entity | idPrefix | Fields kept from Stripe (r/o = readonly) |
|---|---|---|
| `customer` | `cus` | `object` = "customer", `email`, `name`, `description` |
| `payment_intent` | `pi` | `object` = "payment_intent", `amount` money min 50 r/o after create, `amount_capturable` money r/o, `amount_received` money r/o, `currency` r/o, `customer` ref customer nullable r/o, `description`, `capture_method` enum [automatic, manual] r/o, `payment_method` string nullable r/o, **`status` state r/o**, `latest_charge` string nullable r/o (G5), `canceled_at` datetime nullable r/o, `cancellation_reason` enum [duplicate, fraudulent, requested_by_customer, abandoned] nullable r/o |
| `charge` | `ch` | `object` = "charge", `amount` money r/o, `amount_captured` money r/o, `amount_refunded` money default 0 r/o, `captured` bool r/o, `refunded` bool default false r/o, `paid` bool r/o, `status` enum [succeeded, pending, failed] r/o, `currency` r/o, `customer` ref nullable r/o, `payment_intent` ref payment_intent r/o, `description` r/o, `disputed` bool default false r/o |

[world] These are left out:

- `metadata`, because maps are not engine values
- `expand[]`
- `client_secret`
- `payment_method_details`
- the PaymentIntent states `requires_confirmation`, `requires_action` and `processing`
- disputes
- Connect
- card declines (402 `card_error`)

`amount_refunded` and `refunded` are in v1. They are part of Stripe's Charge schema [doc: Charge object], so a faithful pruning keeps them even before refunds exist (see section 6).

### PaymentIntent status machine (v1, data)

```yaml
status: { type: state, readonly: true, initial: requires_payment_method,
          states: [requires_payment_method, requires_capture, succeeded, canceled],
          transitions: { requires_payment_method: [requires_capture, succeeded, canceled],
                         requires_capture: [succeeded, canceled], succeeded: [], canceled: [] } }
```

These are Stripe's names [doc: PaymentIntent object `status`]. The cancellable states come from the refunds guide [doc: Refund and cancel payments, "Cancel a payment"]: `requires_payment_method`, `requires_capture`, `requires_confirmation`, `requires_action`, and `processing` for US bank accounts only. "A PaymentIntent can't be canceled after it has succeeded."

### Refund (v2)

| Entity | idPrefix | Fields |
|---|---|---|
| `refund` | `re` | `object` = "refund", `amount` money min 1 r/o, `charge` ref charge r/o, `payment_intent` ref payment_intent nullable r/o, `currency` r/o, `reason` enum [duplicate, fraudulent, requested_by_customer] nullable r/o, `status` enum [pending, requires_action, succeeded, failed, canceled] r/o |

The user-settable reasons are `duplicate`, `fraudulent` and `requested_by_customer`. Stripe itself generates `expired_uncaptured_charge` [doc: Refund object `reason`], and it is excluded. The refund statuses are `pending`, `requires_action`, `succeeded`, `failed` and `canceled` [doc: Refund object `status`]. [world] Card refunds in this world always end `succeeded`. `status` is an `enum`, not a `state`: only `succeeded` is ever written, and a `state` field needs every state reachable.

## 2. Routes and methods

Stripe updates objects with `POST`, not `PATCH`. That is an API-wide convention, not read from the pages listed above. The engine accepts any method on an `update` route, and `rowIdOf` takes the last path param, so Stripe's param names (`{customer}`, `{intent}`, `{charge}`, `{refund}`) work unchanged.

| Method and path | Kind | Notes |
|---|---|---|
| `GET /v1/customers` | list | filter `email` (exact match [unsure: case-sensitive]) |
| `POST /v1/customers` | create | `email`, `name`, `description` |
| `GET /v1/customers/{customer}` | get | |
| `POST /v1/customers/{customer}` | update | |
| `GET /v1/payment_intents` | list | filter `customer` |
| `POST /v1/payment_intents` | action `create_payment_intent` | `amount`, `currency`, `customer`, `description`, `capture_method` (default `automatic`), `payment_method`, `confirm` bool |
| `GET /v1/payment_intents/{intent}` | get | |
| `POST /v1/payment_intents/{intent}/confirm` | action `confirm` | `payment_method` optional if already set |
| `POST /v1/payment_intents/{intent}/capture` | action `capture` | `amount_to_capture` optional [doc: Capture] |
| `POST /v1/payment_intents/{intent}/cancel` | action `cancel` | `cancellation_reason` optional |
| `GET /v1/charges` | list | filters `customer`, `payment_intent` [doc: List charges] |
| `GET /v1/charges/{charge}` | get | |
| **v2** `POST /v1/refunds` | action `create_refund` | `charge` or `payment_intent`, plus `amount` and `reason` [doc: Create refund] |
| **v2** `GET /v1/refunds` | list | filters `charge`, `payment_intent` [doc: List refunds] |
| **v2** `GET /v1/refunds/{refund}` | get | |

There is no `POST /v1/charges`. It is the legacy charge-creation path, and PaymentIntents replace it. No route updates or deletes a charge or a refund.

## 3. Behaviour of each action

The effects below are written so a reviewer can check numbers by hand.

| Action | Precondition | Effects |
|---|---|---|
| `create_payment_intent` without `confirm` | | `status = requires_payment_method`, `amount_capturable = 0`, `amount_received = 0` |
| `confirm` with `capture_method = automatic` | `requires_payment_method`, and a payment method is present | Creates charge `ch_n` with `amount = amount_captured = A`, `captured = true`, `paid = true`, `status = succeeded`. The PaymentIntent becomes `succeeded`, with `amount_received = A` and `latest_charge = ch_n`. |
| `confirm` with `capture_method = manual` | the same | Creates the charge with `captured = false`, `amount_captured = 0`, `paid = true` [doc: Charge `paid`: "or was successfully authorized for later capture"] and `status = succeeded` [unsure]. The PaymentIntent becomes `requires_capture` with `amount_capturable = A`. |
| `capture` | `requires_capture` [doc: Capture] | `x = amount_to_capture ?? amount_capturable`, with `x <= amount_capturable` [doc: Capture]. Charge: `captured = true`, `amount_captured = x`. PaymentIntent: `succeeded`, `amount_received = x`, `amount_capturable = 0`. The rest is released [doc: Capture `final_capture`]. |
| `cancel` | `requires_payment_method` or `requires_capture` [doc: Refunds guide] | `canceled`, `canceled_at = now`, `cancellation_reason`, `amount_capturable = 0`. [unsure] Whether real Stripe then shows the uncaptured charge as `refunded: true` with `amount_refunded = amount`. The world leaves the charge unchanged, and graders must not depend on it. |
| `create_refund` (v2) | see section 5 | Inserts refund `re_n` with `status = succeeded`. Charge: `amount_refunded += amount`, and `refunded = (amount_refunded == amount_captured)`. "If the charge is only partially refunded, this attribute will still be false" [doc: Charge `refunded`]. |

The refundable remainder is `amount_captured - amount_refunded`. [unsure] Stripe's docs say "up to the remaining, unrefunded amount of the charge" and "can't refund a total greater than the original charge amount" [doc: Create refund, Refunds guide]. It is not stated whether the base is `amount` or `amount_captured` after a partial capture. `amount_captured` is the only base that makes sense for money actually collected, but no task below depends on partial capture.

## 4. Error envelope and status codes

The envelope [doc: Errors]:

```json
{ "error": { "type": "invalid_request_error", "code": "resource_missing",
             "message": "No such charge: 'ch_9999'", "param": "charge" } }
```

- **Types:** `api_error`, `card_error`, `idempotency_error`, `invalid_request_error` [doc: Errors].
- **Statuses:** 400 missing or invalid parameter, 402 "parameters were valid but the request failed", 404 resource does not exist, 409 "conflicts with another request (perhaps due to using the same idempotent key)" [doc: Errors].
- **In this world:** every refund and PaymentIntent failure is `invalid_request_error`.

| Failure | Status | `code` | `param` | Source |
|---|---|---|---|---|
| Unknown charge, PaymentIntent, customer or refund id, in a path or a body | 404 | `resource_missing` | the param | [doc: Error codes `resource_missing`]. The status for a body param is [unsure] (404 is the common observation). |
| `POST /v1/refunds` with neither `charge` nor `payment_intent` | 400 | `parameter_missing` | | [doc: code exists]. Its use here is [unsure]. |
| `POST /v1/refunds` with both `charge` and `payment_intent` | 400 | [unsure] `parameters_exclusive`. Stripe may instead accept both when they agree. | | [unsure] |
| `amount` not a positive integer (0, -5, 12.5, "10") | 400 | `parameter_invalid_integer` | `amount` | [doc: code exists]. Its use for 0 or negatives is [unsure]. |
| **Over-refund**: `amount` greater than the remainder | 400 | [unsure] none, or `amount_too_large`. Message like "Refund amount ($X) is greater than unrefunded amount on charge ($Y)". | `amount` | Behaviour [doc: Create refund, "raise an error … when trying to refund more money than is left"]. Code [unsure]. |
| Refund of a fully refunded charge | 400 | `charge_already_refunded` | | [doc: Error codes]. Status [unsure], 400 assumed. |
| Refund of an **uncaptured** charge, or of a PaymentIntent in `requires_capture` | 400 | [unsure] `charge_not_captured` or `payment_intent_unexpected_state` | | Behaviour [doc: Refunds guide: "the charge … remains uncaptured and can't be refunded directly. You must cancel the PaymentIntent."] |
| Refund of a PaymentIntent with no charge (`requires_payment_method` or `canceled`) | 400 | `payment_intent_unexpected_state` | | Code [doc]. Its use here is [unsure]. |
| Refund of a disputed charge | 400 | `charge_disputed` / `refund_disputed_payment` | | [doc]. Out of scope here (no disputes). |
| `capture` when not in `requires_capture` | 400 | `payment_intent_unexpected_state` | | [doc: Capture "Returns an error if the PaymentIntent isn't capturable"]. Code [unsure]. |
| `capture` with `amount_to_capture` above `amount_capturable` | 400 | [unsure] `amount_too_large` | `amount_to_capture` | [doc: Capture "invalid amount to capture"] |
| `cancel` on `succeeded` or `canceled` | 400 | `payment_intent_unexpected_state` | | [doc: Refunds guide, "can't be canceled after it has succeeded"]. Code [unsure]. |
| `confirm` without a payment method | 400 | [unsure] `parameter_missing` | `payment_method` | [unsure] |
| Same `Idempotency-Key` with different parameters | 400 | (type `idempotency_error`) | | [doc: Errors, Idempotent requests]. Status [unsure]. [gap] G2 |
| Same key while the first request is still running | 409 | `idempotency_key_in_use` | | [doc]. Not applicable: the engine has no concurrency. |

Every failure leaves state unchanged and does not move the clock. The engine guarantees this, because `ctx.fail` discards the overlay.

## 5. Refund transitions

A charge's refund position is fully described by `(captured, amount_captured, amount_refunded)`. [world] The three positions are derived and are not stored as a state field:

- **unrefunded**: `amount_refunded = 0`
- **partially refunded**: `0 < amount_refunded < amount_captured`
- **fully refunded**: `amount_refunded = amount_captured`, `refunded = true`

### Legal

| # | From | Request | To | Check by hand |
|---|---|---|---|---|
| R1 | captured, unrefunded (C = 5000, R = 0) | `charge, amount: 2000` | partial (R = 2000) | the new refund amount is 2000 and `refunded` stays false |
| R2 | partial (R = 2000) | `charge, amount: 1000` | partial (R = 3000) | several partial refunds are allowed "until the entire charge has been refunded" [doc: Create refund] |
| R3 | partial (R = 3000) | `charge` (no amount) | full (R = 5000) | the refund amount is 2000, the remainder [unsure, but a default of the remainder is the standard reading] |
| R4 | captured, unrefunded | `charge` (no amount) | full | the refund amount equals `amount_captured` |
| R5 | captured, unrefunded | `payment_intent: pi_n` | full | "the same as refunding the underlying charge" [doc: Refunds guide]. The refund gets both `charge` and `payment_intent` set. |
| R6 | partial (R = 3000) | `charge, amount: 2000` (exactly the remainder) | full | `refunded` becomes true |

### Illegal (state unchanged afterwards)

| # | From | Request | Result |
|---|---|---|---|
| X1 | partial (C = 5000, R = 3000) | `amount: 2001` | 400 over-refund |
| X2 | unrefunded (C = 5000) | `amount: 5001` | 400 over-refund |
| X3 | full | anything | 400 `charge_already_refunded` |
| X4 | uncaptured (manual, `requires_capture`) | `charge` or `payment_intent` | 400 (cancel the PaymentIntent instead) |
| X5 | PaymentIntent `canceled` or `requires_payment_method` | `payment_intent` | 400 `payment_intent_unexpected_state` |
| X6 | any | `amount: 0`, `-1`, `12.5` or `"100"` | 400 `parameter_invalid_integer` (the engine's `money` type already rejects floats and strings) |
| X7 | any | `charge: ch_9999` (missing) | 404 `resource_missing` |
| X8 | any | `reason: "other"` | 400 [unsure code, likely `parameter_invalid` or similar]. The engine's enum check gives 422 `field.type` until the code map from G1 lands. |

### Idempotency [doc: Idempotent requests], [gap] G2

- Stripe "sav[es] the resulting status code and body of the first request made for any given idempotency key, regardless of whether it succeeds or fails. Subsequent requests with the same key return the same result, including `500` errors."
- Keys can be pruned "after they're at least 24 hours old". Keys are at most 255 characters. "All `POST` requests accept idempotency keys."
- Parameters are compared, and a mismatch is an error. "If incoming parameters fail validation, or the request conflicts with another request that's executing concurrently, we don't save the idempotent result".

Expected world behaviour once G2 lands:

- The second `POST /v1/refunds` with the same key and the same body returns the first response byte-for-byte and creates no second refund.
- The same key with a different `amount` returns 400 `idempotency_error`.
- A first request that failed validation (X6) is not saved, so retrying with the same key and a fixed body succeeds.

Without G2, a repeated POST creates a second refund. Task 3's decoy relies on exactly that.

## 6. What "add refunds" must preserve

The iterate run takes the checked v1 world and the request "add refunds". `diffWorlds` and `preservationIssues` (architecture decision 11) must report no unplanned change.

**Must be added:**

- The entity `refund` (idPrefix `re`).
- The action `create_refund` and the routes `GET /v1/refunds` and `GET /v1/refunds/{refund}`.
- The seed generator for `refund`.
- Tests: one per legal row R1–R6, and one per illegal row X1–X7. Each illegal test asserts the status and that state is unchanged.
- The refund tasks in section 7.

**Must be unchanged:**

1. Every v1 entity, field name, field type, `readonly` flag, enum value and idPrefix. No field is removed or renamed. `charge.amount_refunded` and `charge.refunded` keep their types and defaults.
2. The PaymentIntent status machine: the same states, the same transitions, the same initial state.
3. Every v1 route: method, path and filters. Every v1 action handler is byte-identical, because refunds need no change to `confirm`, `capture` or `cancel`.
4. **Every v1 seed row is identical, field for field and id for id.** This needs the generators for `customer`, `payment_intent` and `charge` to draw from a random stream that adding the `refund` generator does not shift. Either each entity gets its own stream seeded from `meta.seed` plus the entity name, or the refund generator uses no randomness. If the engine shares one random stream across seed generators, this rule breaks, and YOS-50 must fix that first.
5. Every v1 test and task. Each task's solution still scores 1, doing nothing scores 0, and every decoy keeps its v1 score, which must stay below 1. State hashes will differ, because the state now includes the `refund` table. That is expected, and it is why the comparison is on scores, not hashes.
6. `meta.api` (envelopes and list shape).

**Consistency between v1 seed and v2 seed (a backfill rule).** v1 is a pruned Stripe world, so its seed may already contain charges with `amount_refunded > 0`. Those are refunds made outside the subset. v2 must backfill refund rows so that, for every charge, the sum of its `succeeded` refunds equals `amount_refunded`, without editing any charge. There are two acceptable v1 shapes:

- (a) v1 has some refunded charges, and v2 backfills refund rows to match. This is preferred, because it gives the refund tasks real history.
- (b) v1 has every `amount_refunded = 0`, and v2 seeds no refunds.

Editing v1 charges to match newly invented refunds is a preservation failure.

**Planned changes the run must name** (in `plan.changes`): only the additions above. If the model also wants to add the refund statuses `pending` or `failed`, or a `refunds` sub-list on the charge, it must name them in the plan, and section 1 says they are out of scope.

## 7. Seed anchors and three graded tasks

Anchors, which v1 seeds (shape (a)) and which v2 backfills. **S** is `meta.clock.start`.

| Id | Row |
|---|---|
| `cus_0001` | Jenny Rosen, `jenny.rosen@example.com` |
| `cus_0002` | Ana Silva, `ana.silva@example.com` |
| `cus_0003` | Acme Billing, `acme-billing@example.com` |
| `cus_0004` | Acme Billing EU, `acme-billing-eu@example.com` (near-miss customer) |
| `pi_0001` / `ch_0001` | cus_0001, 4999, "Order #6735", automatic, succeeded, created S-3d |
| `pi_0002` / `ch_0002` | cus_0001, 4999, "Order #6735", automatic, succeeded, created S-3d+40s (the duplicate) |
| `pi_0003` / `ch_0003` | cus_0002, 12000, "Order #8812", succeeded, `amount_refunded` 3000. v2 backfills `re_0001`: 3000, `requested_by_customer`. |
| `pi_0004` / `ch_0004` | cus_0002, 8000, "Order #8813", succeeded, unrefunded |
| cus_0003 | 24 PaymentIntents, "Invoice INV-2026-02-01" to "-24": 14 captured and unrefunded, 3 captured and partially refunded, 3 fully refunded, 3 `requires_capture`, and 1 `canceled` with no charge. That gives 23 charges. |
| cus_0004 | 5 captured, unrefunded "Invoice INV-2026-02-…" PaymentIntents |

Other customers and payments come from the generator, which must never use cus_0001 to cus_0004. For each charge, the sum of its refunds equals `amount_refunded`.

Every grader takes its targets from `ctx.seed` and applies a collateral gate. Any change other than to the target charges and PaymentIntents, and to new `refund` rows on target charges, scores 0.

### Task 1 (easy): refund the duplicate charge

> Jenny Rosen (jenny.rosen@example.com) was charged twice for order #6735. Refund the duplicate (the later charge) in full, with the reason marked as a duplicate.

- Grader: 0.8 if there is exactly one new refund, on `ch_0002`, for 4999. Plus 0.2 if its `reason` is `duplicate`. The gate applies. Noop scores 0.
- Solution: `GET /v1/customers?email=jenny.rosen@example.com`, then `GET /v1/charges?customer=cus_0001`. Pick the later `created` of the two "Order #6735" charges. Then `POST /v1/refunds {charge: ch_0002, reason: duplicate}`.
- Decoy (a), "refunds the first charge listed instead of the later one": refunds `ch_0001`. The gate gives 0. With Stripe's newest-first order, `data[0]` would be the right one. With the engine's id order it is the wrong one. G3 changes which naive script is a decoy, so the solution must compare `created` explicitly.
- Decoy (b), "picks the right charge but uses requested_by_customer": scores 0.8.

### Task 2 (medium): refund what is left after a partial refund

> Order #8812 for ana.silva@example.com was cancelled after we had already refunded $30.00 of it. Refund whatever is left on that payment.

- Grader: 1 if the new refunds on `ch_0003` sum to exactly 9000 and `ch_0003.refunded` is true, with the gate. Otherwise 0. Refunding by `payment_intent: pi_0003`, or with no `amount`, is also correct.
- Solution: find cus_0002, then the "Order #8812" charge. Read `amount_captured - amount_refunded` (12000 - 3000 = 9000), then `POST /v1/refunds {charge: ch_0003, amount: 9000}`.
- Decoy (a), "repeats the previous refund amount": `amount: 3000` succeeds and leaves R = 6000, so it scores 0.
- Decoy (b), "refunds the customer's other order": refunds `ch_0004` in full. The gate gives 0.
- Not a valid decoy: "refunds the full original 12000". It is rejected by X1 and makes no successful write, so the engine would flag it `task.decoy_trivial`.

### Task 3 (hard): settle the February invoices

> Acme Billing (acme-billing@example.com) is closing its account. For every one of its February invoices ("INV-2026-02-…"): refund any captured payment that isn't already fully refunded, and cancel any payment that is only authorised (not captured). Don't touch anything else.

- Targets: 17 charges to refund in full (14 unrefunded and 3 partially refunded, each refunded only by its remainder) and 3 PaymentIntents to cancel. That is 20 targets.
- Grader: the gate first. Then the fraction of the 20 that are done: a target charge counts when `refunded` is true and its new refunds sum to its seed remainder; a target PaymentIntent counts when its `status` is `canceled`. Noop scores 0. Each strict prefix of the solution scores k/20, which is below 1.
- Solution: page through `GET /v1/charges?customer=cus_0003` (23 charges, so several pages at a 10-row page) and refund each charge where `captured` is true and `refunded` is false, with no `amount`. Page through `GET /v1/payment_intents?customer=cus_0003` and `POST …/cancel` each PaymentIntent in `requires_capture`.
- Decoy (a), "reads only the first page of each list": at most 10 charge targets plus 3 cancels are done, so it scores at most 13/20.
- Decoy (b), "always refunds the full original `amount`": the 3 partial refunds fail (X1) and the 3 fully refunded charges fail (X3). It does 14 refunds and 3 cancels, so it scores 17/20.
- Decoy (c), "refunds authorisations instead of cancelling them": those calls fail (X4), so it scores 17/20.
- Decoy (d), "matches customers by email prefix": it also refunds cus_0004's invoices. The gate gives 0.

## 8. Open points

1. G1 to G5 in section 0. G3 (Stripe-style paging) and G1 (`type` and `param` in the envelope) cost the most fidelity. Decide whether the engine gains them before YOS-47 generates v1, or whether REPORT.md lists them as deviations.
2. The [unsure] error codes in section 4: over-refund, uncaptured refund, both ids given, and the 400 or 404 status for a missing id in a body. Confirm them against stripe-mock v0.206.0 (portfolio: shape oracle) before a test asserts a `code`. Tests may safely assert the status and the `type` now, and should assert `code` only for the [doc] rows.
3. The refund base after a partial capture (section 3). No task depends on it. Settle it before adding a "partial capture, then refund" task.
4. Whether canceling a `requires_capture` PaymentIntent marks its charge `refunded` in real Stripe (section 3). Graders here check only the PaymentIntent status.
5. Random streams per seed entity, so that v1 rows are unchanged after "add refunds" (section 6, item 4).
