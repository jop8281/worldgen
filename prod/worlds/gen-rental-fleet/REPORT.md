# WorldGen report: Car rental fleet management system (Enterprise/Hertz-style rental ops backend): vehicles, customers, reservations and rentals, damage claims, late fees

A stateful car rental fleet. Branches hold vehicles. Customers reserve a vehicle for a pickup and due window. Agents pick up, return, cancel and close rentals. Damage claims move through review to approved, denied or settled. A daily job assesses a late fee on rentals returned after their due time, and a second daily job cancels no-show reservations. Most changes go through actions that keep the rental, vehicle and claim state machines consistent.

## What was built

Entities (5):

- `branch`: 6 seeded rows
- `vehicle`: 60 seeded rows
- `customer`: 90 seeded rows
- `rental`: 170 seeded rows
- `damage_claim`: 60 seeded rows

Routes (17):

- `list_branches`: GET /branches
- `get_branch`: GET /branches/{id}
- `list_vehicles`: GET /vehicles
- `get_vehicle`: GET /vehicles/{id}
- `create_vehicle`: POST /vehicles
- `update_vehicle`: PATCH /vehicles/{id}
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `update_customer`: PATCH /customers/{id}
- `list_rentals`: GET /rentals
- `get_rental`: GET /rentals/{id}
- `list_customer_rentals`: GET /customers/{customer_id}/rentals
- `list_vehicle_rentals`: GET /vehicles/{vehicle_id}/rentals
- `list_damage_claims`: GET /damage_claims
- `get_damage_claim`: GET /damage_claims/{id}
- `list_rental_damage_claims`: GET /rentals/{rental_id}/damage_claims

Actions (12):

- `create_branch`: POST /branches
- `reserve_rental`: POST /rentals
- `pickup_rental`: POST /rentals/{id}/pickup
- `return_rental`: POST /rentals/{id}/return
- `cancel_rental`: POST /rentals/{id}/cancel
- `close_rental`: POST /rentals/{id}/close
- `waive_late_fee`: POST /rentals/{id}/waive_late_fee
- `file_damage_claim`: POST /damage_claims
- `review_claim`: POST /damage_claims/{id}/review
- `approve_claim`: POST /damage_claims/{id}/approve
- `deny_claim`: POST /damage_claims/{id}/deny
- `settle_claim`: POST /damage_claims/{id}/settle

Jobs (2):

- `late_fee_assessment`: every 1d
- `expire_no_shows`: every 1d

## Assumed and why

- Clock start is 2026-10-06T09:00:00.000Z with tick 1s. Historical rentals, returns and claims all precede it. Future items are reserved rentals with pickup_at after the start, and the next runs of the daily jobs.
  - Why: The clock must be explicit and deterministic, and tick 1s keeps event order visible. Jobs fire only when a test advances time, and tasks cannot advance the clock, so tasks grade seeded facts and not job output.
- Currency is USD in integer cents on every money field.
  - Why: The input names no currency. The engine requires one fixed currency per field.
- Late rule: a rental is late if returned_at is more than 60 minutes after due_at. The fee is ceil(minutes_late / 1440) days times 150% of the rental's daily_rate snapshot.
  - Why: The input says only 'a late fee'. A grace period and a daily multiplier match common rental practice and make the fee computable.
- The late_fee_assessment job runs every 1d and acts only on returned rentals with late_fee_applied false. It sets late_fee, adds the fee to the rental's charges and sets late_fee_applied true, so it never charges twice. Waived fees stay zero.
  - Why: The input says a daily job adds the fee to rentals returned after their due time. The flag makes the job idempotent.
- A second daily job, expire_no_shows, cancels reserved rentals whose pickup_at is more than 24h past, with cancel_reason no_show, and frees the vehicle.
  - Why: Reservations that never convert would block a vehicle forever. It is a natural second scheduled behavior and stays small.
- Rentals are created only through the reserve_rental action, with no plain create route. The action refuses blocked customers, vehicles not available, vehicles with an overlapping reserved or active rental, and due_at not after pickup_at. It snapshots daily_rate and sets base_charge from the whole days of the window.
  - Why: Overlap and eligibility checks cannot live in a plain create.
- Rental states are reserved, active, returned, closed and cancelled. reserved goes to active or cancelled. active goes to returned. returned goes to closed. close_rental refuses a late rental whose fee is not yet assessed (409 late_fee_pending) and a rental with an open or under_review claim.
  - Why: This gives the daily job a real window to act in and creates a cross-entity rule for agents to hit.
- Vehicle states are available, rented, maintenance and retired. pickup sets rented, return sets available, and approving a claim moves an available vehicle to maintenance. Staff move vehicles between available, maintenance and retired by PATCH, never to or from rented.
  - Why: The vehicle status must track the rental lifecycle.
- Damage claim states are open, under_review, approved, denied and settled. approve needs under_review and an approved_amount no greater than estimated_cost. deny works from open or under_review and needs a reason. settle needs approved and adds approved_amount to rental.damage_charge.
  - Why: The input names damage claims only. A short review pipeline gives claims a meaningful lifecycle.
- All timestamps are UTC. return_rental stamps returned_at with engine time. Callers cannot choose it.
  - Why: Prevents agents from backdating a return, and keeps tasks deterministic.
- Only one active branch model: a rental is picked up at pickup_branch_id and may be returned to any branch, which becomes the vehicle's branch_id.
  - Why: The input does not describe one-way rentals. This is the simplest model that keeps fleet location current.
- Routes use no auth, in a REST style with cursor pagination and a page size of 25.
  - Why: Matches the engine conventions. Authentication is not in the input.

## Questions asked of the input

- Which currency and unit should money use?
  - Default answer: USD in integer cents.
- What is the late fee formula and is there a grace period?
  - Default answer: 60 minute grace. After that, each started 24h day late costs 150% of the daily rate.
- Should the late fee be charged when the vehicle is returned, or by the daily job?
  - Default answer: By the daily job, as the input says. The return itself charges nothing extra.
- Can a vehicle be returned to a different branch from where it was picked up?
  - Default answer: Yes. The vehicle's branch becomes the return branch.
- Can a late rental be closed before its late fee is assessed?
  - Default answer: No. close_rental refuses with late_fee_pending.
- Is a deductible or insurance applied to damage claims?
  - Default answer: No. The approved amount is charged to the rental as is.
- What happens to a reservation the customer never picks up?
  - Default answer: A daily job cancels it as a no_show 24h after pickup_at.
- Which time zone are timestamps in?
  - Default answer: UTC.
- What is the clock start and does time move on its own?
  - Default answer: 2026-10-06T09:00:00.000Z with a 1s tick per committed call. Jobs fire only when time advances past their next run.

## Left out

- Payments, deposits, card holds, refunds and invoices
  - Why: The input needs charges recorded on the rental, not a payment processor.
- Insurance products, deductibles and third-party insurer claims
  - Why: Claims are modeled as a simple internal review pipeline.
- Dynamic pricing, promotions, taxes and fees other than the late fee
  - Why: Daily rates are a fixed field on each vehicle.
- Telematics, GPS, fuel level and mileage overage charges
  - Why: Odometer readings are recorded but not billed.
- Authentication, staff roles and permissions
  - Why: Not in the input. Every caller acts as a rental agent.
- Notifications by email or SMS
  - Why: No outbound channel exists in the engine.
- Extending or modifying a rental after reservation
  - Why: Keeps the rental state machine small. Agents cancel and rebook.

## Proof

The engine check passed: 7 world tests, 0 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| cancel_elena_reservation | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a |
| return_tomas_reyes_suv | medium | 1.000 | 0.000 | 0.400, 0.000 | n/a |
| waive_priya_late_fee | medium | 1.000 | 0.000 | 0.000, 0.000, 0.600 | n/a |
| triage_small_claims | hard | 1.000 | 0.000 | 0.893, 0.964, 0.321, 0.000, 0.000 | 0.964 |

Decoys:

- `cancel_elena_reservation` 0.000: cancels the first reserved rental in the list, which belongs to another customer, instead of Elena Voss's
- `cancel_elena_reservation` 0.000: cancels Elena's reservation but also cancels another customer's reservation as collateral
- `return_tomas_reyes_suv` 0.400: returns the right rental but records the wrong odometer reading
- `return_tomas_reyes_suv` 0.000: PATCHes the vehicle back to available with the new odometer instead of checking the rental in, so the rental stays active
- `waive_priya_late_fee` 0.000: waives the fee on the older late rental instead of the most recently returned one
- `waive_priya_late_fee` 0.000: waives the late fee on both of her late rentals
- `waive_priya_late_fee` 0.600: waives the right rental but gives a reason other than flight delay
- `triage_small_claims` 0.893: reads only the first page of under_review claims, so the claims on page 2 are never triaged
- `triage_small_claims` 0.964: treats exactly $150 as below the threshold and denies that claim instead of approving it
- `triage_small_claims` 0.321: approves at 80% of the estimate instead of the full estimated cost
- `triage_small_claims` 0.000: also denies the small open claims, which are not under review
- `triage_small_claims` 0.000: triages correctly but then settles the approved claims, which charges the rentals

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.49 | 0.1325 |
| model | 1 | 0.43 | 0.0878 |
| workflow | 1 | 2.89 | 0.3601 |
| seed | 1 | 2.36 | 0.3224 |
| tasks | 1 | 1.41 | 0.2789 |
| Total | 5 | 8.58 | 1.1817 |

Run total: 8.62 minutes, $1.1817.
