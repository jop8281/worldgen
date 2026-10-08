# WorldGen plan: Parcel shipment-tracking and carrier-operations API (EasyPost / AfterShip / Shippo-style tracking and dispatch backend)

A multi-carrier shipment tracker. The 120 imported shipments become shipment rows that link to carrier and hub rows. Operators dispatch, delay, resume, deliver, return and re-carrier shipments through lifecycle actions. Every step writes an append-only tracking event. Late or damaged parcels get claims that are reviewed and resolved. An hourly job flags in-transit shipments that pass their ETA. Tasks cover filtering, paging, state rules and collateral checks.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-15T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `carrier` | A shipping carrier (UPS, PostNL, DHL, FedEx, DPD). The fixture only has the carrier name. The code, service-level transit days and active flag are invented by the seed. | name, code (unique), transit_days (int, SLA used to compute expected_delivery_at), active (bool) |
| `hub` | A city hub that parcels leave from or arrive at. The 10 origin and destination cities are the same set, so one table serves both. | name (unique), country, active (bool) |
| `shipment` | One parcel in transit between two hubs with one carrier. It is imported from the shipments CSV. Status moves only through lifecycle actions. | reference (unique, e.g. SH-1001), carrier_id (ref carrier), origin_id (ref hub), destination_id (ref hub), weight_kg (number), status (state: created, in_transit, delayed, delivered, returned), shipped_at, expected_delivery_at, delivered_at (nullable), delay_reason (nullable), return_reason (nullable) |
| `shipment_event` | Append-only tracking history per shipment. It is written by the seed, the actions and the job. | shipment_id (ref shipment), kind (enum: created, dispatched, delayed, resumed, delivered, returned, carrier_changed, claim_opened), hub_id (ref hub, nullable), note (nullable) |
| `claim` | A compensation claim on a shipment, for a late, damaged or lost parcel. A claim is open until it is resolved. | shipment_id (ref shipment), kind (enum: late, damaged, lost), status (state: open, approved, rejected), amount (money EUR), resolution_note (nullable), resolved_at (nullable) |

## Workflows

### shipment_lifecycle (shipment)
- States: created, in_transit, delayed, delivered, returned
- Actions: dispatch_shipment, delay_shipment, resume_shipment, deliver_shipment, return_shipment, reassign_carrier
- Rules:
  - Initial state is created. Allowed transitions: created→in_transit|returned; in_transit→delayed|delivered|returned; delayed→in_transit|delivered|returned; delivered→returned; returned is final.
  - dispatch_shipment needs status created and an active carrier. It sets shipped_at to now, expected_delivery_at to now plus the carrier's transit_days, and writes a dispatched event.
  - delay_shipment needs status in_transit. The reason is required and non-blank, and the new expected_delivery_at must be after the current one. It stores delay_reason and writes a delayed event.
  - resume_shipment needs status delayed. It clears delay_reason and writes a resumed event.
  - deliver_shipment needs status in_transit or delayed. It sets delivered_at to now and writes a delivered event.
  - return_shipment needs a non-blank reason. A delivered shipment can be returned only within 14 days of delivered_at, otherwise it answers 409. It stores return_reason and writes a returned event.
  - reassign_carrier needs status created, a new active carrier that differs from the current one, and a carrier_changed event naming both carriers. It never touches a dispatched shipment.
  - The job flag_overdue_shipments (every 1h) moves in_transit shipments with expected_delivery_at at or before now to delayed, with delay_reason 'auto: past ETA' and a delayed event.
  - Every action answers 404 for an unknown id and 409 invalid_state for a disallowed status, with a message naming the current status. A failed action writes nothing.
### claim_review (claim)
- States: open, approved, rejected
- Actions: open_claim, resolve_claim
- Rules:
  - Initial state is open. Allowed transitions: open→approved|rejected. Approved and rejected are final.
  - open_claim needs shipment status delayed, delivered or returned. The kind is late, damaged or lost, and the amount is greater than 0. A 'late' claim also needs delayed_at or delivered_at later than expected_delivery_at. A second open claim of the same kind on a shipment answers 409 duplicate_claim. It writes a claim_opened event.
  - resolve_claim takes decision (approved or rejected) and a non-blank note. It sets resolved_at to now and resolution_note. Approving a claim with an amount over 50000 (EUR 500.00) answers 409 needs_manager_review, so large claims can only be rejected in this world.
  - Resolving an already resolved claim answers 409 invalid_state.

## Jobs

None. The plan declares no job.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_shipments` | GET | /shipments | List shipments (page size 25). Filters: carrier_id, origin_id, destination_id, status. Search: reference. Sort: shipped_at, expected_delivery_at, weight_kg, created_at. |
| `get_shipment` | GET | /shipments/{id} | Fetch one shipment. |
| `create_shipment` | POST | /shipments | Register a new shipment. It starts in status created. |
| `update_shipment` | PATCH | /shipments/{id} | Edit plain fields such as weight_kg and carrier_id. Lifecycle fields (status and timestamps) are readonly and move only through actions. |
| `list_shipment_events` | GET | /shipments/{shipment_id}/events | Tracking history of one shipment. Sort: created_at. |
| `list_shipment_claims` | GET | /shipments/{shipment_id}/claims | Claims on one shipment. |
| `list_carriers` | GET | /carriers | List carriers. Filter: active. Search: name. |
| `get_carrier` | GET | /carriers/{id} | Fetch one carrier. |
| `update_carrier` | PATCH | /carriers/{id} | Toggle active or edit transit_days. |
| `list_hubs` | GET | /hubs | List hubs. Filter: country, active. Search: name. |
| `get_hub` | GET | /hubs/{id} | Fetch one hub. |
| `list_claims` | GET | /claims | List all claims (page size 25). Filters: shipment_id, kind, status. |
| `get_claim` | GET | /claims/{id} | Fetch one claim. |
| `dispatch_shipment` | POST | /shipments/{id}/dispatch | Action. Move a created shipment to in_transit. It sets shipped_at and expected_delivery_at from the carrier's transit_days. |
| `delay_shipment` | POST | /shipments/{id}/delay | Action. Move an in_transit shipment to delayed with a required reason and a later expected_delivery_at. |
| `resume_shipment` | POST | /shipments/{id}/resume | Action. Move a delayed shipment back to in_transit. |
| `deliver_shipment` | POST | /shipments/{id}/deliver | Action. Mark an in_transit or delayed shipment as delivered and set delivered_at to now. |
| `return_shipment` | POST | /shipments/{id}/return | Action. Return a created, in_transit, delayed or delivered shipment, with a required reason. |
| `reassign_carrier` | POST | /shipments/{id}/reassign_carrier | Action. Switch the carrier of a shipment that is still in status created. The new carrier must be active. |
| `open_claim` | POST | /shipments/{id}/claim | Action. Open a claim of kind late, damaged or lost on a delayed, delivered or returned shipment. Only one open claim of the same kind per shipment. |
| `resolve_claim` | POST | /claims/{id}/resolve | Action. Approve or reject an open claim with a note. |

## Seed

- Rows per entity: carrier: 5, hub: 10, shipment: 120, shipment_event: 420, claim: 18
- Mix: Shipments are read from fixtures.shipments, one row each, keeping the imported carrier, origin, destination, weight, status and timestamps. The CSV status mix is kept (about 20% each of created, in_transit, delayed, delivered and returned). It is normalised only where it is incoherent: a delivered row always has delivered_at, and non-delivered rows have none unless returned. Naive timestamps are read as UTC and clamped to at or before the clock start. Active shipments get ETAs consistent with the clock, so in_transit ETAs are in the future and delayed ETAs are in the past. At least 6 delivered shipments were delivered over 48h after their ETA and have no claim, spread across all pages of the id-ordered list. About 18 claims exist (about 60% open, the rest approved or rejected). Events are derived from each shipment's fields in time order. Carriers: UPS, PostNL, DHL, FedEx and DPD with transit_days 2 to 5, all active except one inactive carrier. Hubs: the 10 cities with real countries. A seeded mix reaches at least 5 shipments in created status with PostNL.

## Tasks

- `dispatch_heaviest_created_shipment` (easy): Dispatch the heaviest shipment that is still in status created, using dispatch_shipment. The grader checks that this shipment is in_transit with shipped_at and expected_delivery_at set and a dispatched event written. It also checks that no other shipment changed. The agent must read the filtered list sorted by weight, not use the heaviest overall.
  - Decoy idea: Dispatches the heaviest shipment of any status (it fails with 409 or hits the wrong row), or the lightest created shipment, or the first created shipment in id order.
- `move_postnl_created_to_dpd` (medium): PostNL has suspended pickups. Move every shipment that is still in status created and has carrier PostNL to the carrier DPD, using reassign_carrier. Shipments already dispatched, delayed or delivered with PostNL must not change. The grader checks the carrier of every target, one carrier_changed event per target, and no collateral change. Page 2 of the list may hold targets.
  - Decoy idea: PATCHes carrier_id on every PostNL shipment regardless of status, so the in_transit ones change too (a collateral write). Or it reassigns only the first page of results. Or it reassigns to DHL by mistake.
- `claim_for_late_delivered_shipments` (hard): Open a 'late' claim for every delivered shipment that was delivered more than 48 hours after its expected delivery time and has no claim of kind late yet. Use an amount of 2500 (EUR 25.00) each. The agent must page through all delivered shipments, compare delivered_at to expected_delivery_at, and check the claims list so it does not duplicate. The grader checks exactly one new open late claim per target, no claim on non-targets, no duplicate on the shipments that already had one, and no other collateral change.
  - Decoy idea: Reads only page 1 of delivered shipments. Or it uses shipped_at instead of expected_delivery_at to measure lateness. Or it ignores existing claims and double-claims some shipments. Or it also claims on delayed (not delivered) shipments. Or it uses a 24h threshold, so it claims on extra near-miss rows.

## Open questions

- What reference time should the world start at, given that the CSV has no explicit 'now'?
  - Default answer: 2026-10-15T09:00:00.000Z, safely after the latest imported shipped_at, with a 1s tick.
- Are the CSV timestamps UTC?
  - Default answer: Yes, naive ISO strings are read as UTC.
- Should carriers and hubs be separate entities or stay as enum columns on shipment?
  - Default answer: Separate entities, built from the distinct CSV values, so refs, filters and carrier rules are possible.
- The CSV has no ETA, carrier SLA, claims or tracking events. Should the world invent them?
  - Default answer: Yes. The seed derives them deterministically with the seeded rng, and the imported columns are never overwritten except for status/timestamp normalisation.
- Can an agent set status directly with PATCH?
  - Default answer: No. Status and lifecycle timestamps are readonly and change only through the lifecycle actions.
- What happens to rows where the CSV status and delivered_at disagree?
  - Default answer: The seed normalises them: delivered always has delivered_at, and non-delivered rows have none, except returned rows that keep theirs.
- Which currency and amounts do claims use?
  - Default answer: EUR in integer minor units. Claims over EUR 500 cannot be approved in this world.

## Assumptions

- Clock starts at 2026-10-15T09:00:00.000Z with tick 1s.
  - Why: The CSV shows shipped_at up to at least 2026-09-28, and the real maximum is unknown. Starting about two weeks later puts every imported event in the past. The 1s tick keeps event ordering deterministic. Active-shipment ETAs and the hourly job are the only future-scheduled events.
- Naive timestamps such as 2026-09-28T09:00:00 are read as UTC. Any timestamp after clock start is clamped to clock start minus a small offset.
  - Why: The CSV has no timezone, and the seed rule requires created_at <= updated_at <= clock.start.
- Carrier and hub are separate entities, built from the distinct enum values in the CSV, and the seed maps the shipment columns to their ids.
  - Why: Refs let agents join across entities and filter by id. Hubs serve both origin and destination, since both columns use the same 10 cities.
- The invented attributes (carrier code and transit_days, hub country, claims, events, expected_delivery_at) come from the seed using the seeded rng, and nothing in the CSV is overwritten except for the normalisation listed in the seed mix.
  - Why: The CSV carries only shipment columns, but the workflows need ETAs, history and claims.
- delivered_at is null for every non-delivered shipment. Returned shipments keep delivered_at only if the CSV has one.
  - Why: About 51% of delivered_at values are null, which matches the share of undelivered rows. A delivered status with no timestamp would be incoherent.
- status, shipped_at, expected_delivery_at, delivered_at, delay_reason, return_reason and the claim lifecycle fields are readonly. Only the lifecycle actions change them.
  - Why: This keeps the state machine and its side effects (events, timestamps) consistent. Agents must find and use the action routes, as in a real carrier API.
- Shipment transitions: created→in_transit|returned; in_transit→delayed|delivered|returned; delayed→in_transit|delivered|returned; delivered→returned; returned is final.
  - Why: This models forward flow plus an undeliverable or customer return, with no way back from returned.
- The job flag_overdue_shipments runs every 1h. It moves in_transit shipments whose expected_delivery_at has passed to delayed, with the delay_reason 'auto: past ETA' and a delayed event.
  - Why: It gives time-driven behaviour that agents must reason about. The seed sets no in_transit ETA in the past, so the untouched seed has no pending job work.
- A claim is allowed only on delayed, delivered or returned shipments. open_claim returns 409 if an open claim of the same kind exists. Claim amounts are in EUR minor units.
  - Why: The rule gives hard tasks a duplicate-claim trap. EUR fits the European cities.
- List page size is 25 with cursor paging (data, next_cursor, limit and cursor) and the error envelope {error:{code,message}}.
  - Why: With 120 shipments, paging matters, and these are the engine defaults.
- Tasks are phrased by business attributes (carrier, status, weight, lateness) and never by ids.
  - Why: Agents must discover ids, and every task must use rows the imported data really contains.

## Out of scope

- Real carrier integrations, label purchase, rate shopping and tracking-number generation
  - Why: They need external services. The world is a deterministic state machine over imported data.
- Customs, duties, address validation and multi-leg routing
  - Why: The CSV has only origin and destination cities, so these add nothing testable.
- Authentication, users, roles and multi-tenant accounts
  - Why: The input has no such data, and the tasks gain nothing from it.
- Claim payouts, invoicing and carrier billing
  - Why: Claims stop at approved or rejected. Payment flows need a finance model that is not in the input.
- Webhooks and push notifications
  - Why: A synchronous, deterministic engine cannot deliver outbound HTTP.

## Changes

None. The plan changes no existing item.
