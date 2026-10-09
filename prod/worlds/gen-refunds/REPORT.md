# WorldGen report: Stripe API (Refunds and Charges), version 2024-06-20

A deterministic Stripe-style payments sandbox centred on refunds. Seeded charges can be refunded in full or in part through create_refund. Refunds follow Stripe's status lifecycle (pending, requires_action, succeeded, failed, canceled). Every refund keeps the parent charge's amount_refunded and refunded flag in step. Agents can list, retrieve, create, tag with metadata and cancel refunds, and read charges to find what to refund. Jobs settle pending refunds and expire stale requires_action ones. The world keeps Stripe's refund rules, such as the unrefunded-amount cap, the disputed-charge refusal, cancel only from requires_action, and merge-style metadata updates. It keeps Stripe's list envelope with has_more and starting_after / ending_before paging, but takes JSON bodies instead of form encoding. Revision 2: every task now declares an allows list (entity, kind, exact update fields, where) derived from its instruction, so any change outside it scores 0.

## What was built

Entities (2):

- `charge`: 80 seeded rows
- `refund`: 70 seeded rows

Routes (4):

- `list_refunds`: GET /v1/refunds
- `get_refund`: GET /v1/refunds/{id}
- `list_charges`: GET /v1/charges
- `get_charge`: GET /v1/charges/{id}

Actions (3):

- `create_refund`: POST /v1/refunds
- `update_refund`: POST /v1/refunds/{id}
- `cancel_refund`: POST /v1/refunds/{id}/cancel

Jobs (2):

- `settle_pending_refunds`: every 1h
- `expire_requires_action`: every 1d

## Changes

- item_changed `tasks.cancel_stale_requires_action_refunds.allows`
- item_changed `tasks.merge_ticket_into_refund_metadata.allows`
- item_changed `tasks.refund_annual_plan_in_full.allows`
- item_changed `tasks.refund_remaining_balance.allows`

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 7 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_24bc50e22e85e976d05355527b783413f6ee74eb84f4499d1df35c97a87e14fc`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| refund_annual_plan_in_full | easy | 1.000 | 0.000 | 0.000, 0.200, 0.000 | n/a | declared (2); mutants 1/8 | `tid_7d536c11a7d18209e3d06f13ce73e311a82999e51d52fbceb2bc87c4689ffce1` |
| refund_remaining_balance | medium | 1.000 | 0.000 | 0.200, 0.000, 0.000 | n/a | declared (2); mutants 2/8 | `tid_987354efd24fb9e05e13582d65b76fc93d2d6ab114c6eff5ee34faa5fcdc1b52` |
| merge_ticket_into_refund_metadata | medium | 1.000 | 0.000 | 0.000, 0.000, 0.500 | n/a | declared (1); mutants 2/8 | `tid_f5c3475416254311bbba282ef963e7f692daf494055dcf7d730c69dab3f3eb58` |
| cancel_stale_requires_action_refunds | hard | 1.000 | 0.000 | 0.000, 0.000, 0.200 | 0.600 | declared (2); mutants 0/8 | `tid_e60124fa117f0e16891cebe7a529c1dccdfa1ddf1507737792840d72f9163441` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `refund_annual_plan_in_full` 0.000: refunds one of the customer's monthly plan charges instead of the annual plan
- `refund_annual_plan_in_full` 0.200: refunds only part of the annual plan amount instead of the full charge
- `refund_annual_plan_in_full` 0.000: refunds the right charge in full but leaves out the reason
- `refund_remaining_balance` 0.200: computes the balance by subtracting every refund on the charge including the canceled one, so it refunds too little
- `refund_remaining_balance` 0.000: refunds the remaining balance of the sibling charge from the same customer (order 5121) instead of order 5120
- `refund_remaining_balance` 0.000: refunds the correct remaining amount but with the wrong reason
- `merge_ticket_into_refund_metadata` 0.000: tags the newest refund of the customer regardless of its status, which is still requires_action
- `merge_ticket_into_refund_metadata` 0.000: tags the newest succeeded refund of a different customer (the near-identical name Priya Nayar and others) instead of Priya Nair
- `merge_ticket_into_refund_metadata` 0.500: tags the right refund but clears its existing metadata keys, treating the update as an overwrite
- `cancel_stale_requires_action_refunds` 0.000: cancels every requires_action refund and ignores how old it is
- `cancel_stale_requires_action_refunds` 0.000: uses a 7 day cutoff instead of 10 days, so it also cancels a requires_action refund that is only about 8 days old
- `cancel_stale_requires_action_refunds` 0.200: uses a 13 day cutoff instead of 10 days, so it cancels only the oldest stale refunds and misses the rest

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| refund_annual_plan_in_full | easy | 2 | none | none | none declared |
| refund_remaining_balance | medium | 2 | none | none | none declared |
| merge_ticket_into_refund_metadata | medium | 1 | none | refund | none declared |
| cancel_stale_requires_action_refunds | hard | 13 | none | none | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $1.60.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.77 | 0.1336 |
| tasks | 1 | 0.21 | 0.1636 |
| Total | 2 | 0.98 | 0.2973 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures

Run total: 1.03 minutes, $0.2973.
