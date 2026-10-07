# WorldGen report: Parcel shipment-tracking and carrier-operations API (EasyPost / AfterShip / Shippo-style tracking and dispatch backend)

A multi-carrier shipment tracker. The 120 imported shipments become shipment rows that link to carrier and hub rows. Operators dispatch, delay, resume, deliver, return and re-carrier shipments through lifecycle actions. Every step writes an append-only tracking event. Late or damaged parcels get claims that are reviewed and resolved. An hourly job flags in-transit shipments that pass their ETA. Tasks cover filtering, paging, state rules and collateral checks.

## What was built

Entities (5):

- `carrier`: 5 seeded rows
- `hub`: 10 seeded rows
- `shipment`: 120 seeded rows
- `shipment_event`: 301 seeded rows
- `claim`: 18 seeded rows

Routes (13):

- `list_shipments`: GET /shipments
- `get_shipment`: GET /shipments/{id}
- `create_shipment`: POST /shipments
- `update_shipment`: PATCH /shipments/{id}
- `list_shipment_events`: GET /shipments/{shipment_id}/events
- `list_shipment_claims`: GET /shipments/{shipment_id}/claims
- `list_carriers`: GET /carriers
- `get_carrier`: GET /carriers/{id}
- `update_carrier`: PATCH /carriers/{id}
- `list_hubs`: GET /hubs
- `get_hub`: GET /hubs/{id}
- `list_claims`: GET /claims
- `get_claim`: GET /claims/{id}

Actions (8):

- `dispatch_shipment`: POST /shipments/{id}/dispatch
- `delay_shipment`: POST /shipments/{id}/delay
- `resume_shipment`: POST /shipments/{id}/resume
- `deliver_shipment`: POST /shipments/{id}/deliver
- `return_shipment`: POST /shipments/{id}/return
- `reassign_carrier`: POST /shipments/{id}/reassign_carrier
- `open_claim`: POST /shipments/{id}/claim
- `resolve_claim`: POST /claims/{id}/resolve

Jobs (1):

- `flag_overdue_shipments`: every 1h

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 6 world tests, 0 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| dispatch_heaviest_created_shipment | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a |
| move_postnl_created_to_dpd | medium | 1.000 | 0.000 | 0.000, 0.800, 0.000, 0.000 | 0.800 |
| claim_for_late_delivered_shipments | hard | 1.000 | 0.000 | 0.308, 0.000, 0.000, 0.000, 0.000 | 0.923 |

Decoys:

- `dispatch_heaviest_created_shipment` 0.000: dispatches the lightest created shipment instead of the heaviest
- `dispatch_heaviest_created_shipment` 0.000: dispatches the two heaviest created shipments, so one extra shipment changes
- `move_postnl_created_to_dpd` 0.000: PATCHes carrier_id to DPD on every PostNL shipment whatever its status, so dispatched, delayed and delivered shipments change too
- `move_postnl_created_to_dpd` 0.800: reads only the first page of PostNL shipments, so created shipments on page 2 are missed
- `move_postnl_created_to_dpd` 0.000: reassigns the right shipments but to DHL instead of DPD
- `move_postnl_created_to_dpd` 0.000: PATCHes carrier_id on the right shipments instead of using the reassignment action, so no carrier_changed event is recorded
- `claim_for_late_delivered_shipments` 0.308: reads only the first page of delivered shipments, so late deliveries on later pages get no claim
- `claim_for_late_delivered_shipments` 0.000: measures lateness from shipped_at instead of expected_delivery_at, so it claims on shipments that were slow but not late
- `claim_for_late_delivered_shipments` 0.000: ignores existing claims and double-claims shipments that already have a resolved late claim
- `claim_for_late_delivered_shipments` 0.000: also opens late claims on delayed shipments that have not been delivered
- `claim_for_late_delivered_shipments` 0.000: uses a 24 hour threshold instead of 48 hours, so it claims on near-miss shipments too

## Run

Mode: create from csv. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.34 | 0.1260 |
| model | 1 | 0.33 | 0.1178 |
| workflow | 1 | 2.17 | 0.3283 |
| seed | 1 | 1.18 | 0.2508 |
| tasks | 1 | 3.01 | 0.4320 |
| Total | 5 | 8.04 | 1.2550 |

Run total: 8.10 minutes, $1.2550.
