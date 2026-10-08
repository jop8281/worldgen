# WorldGen plan: Car rental fleet management system (Enterprise/Hertz-style rental ops backend): vehicles, customers, reservations and rentals, damage claims, late fees

A stateful car rental fleet. Branches hold vehicles. Customers reserve a vehicle for a pickup and due window. Agents pick up, return, cancel and close rentals. Damage claims move through review to approved, denied or settled. A daily job assesses a late fee on rentals returned after their due time, and a second daily job cancels no-show reservations. Most changes go through actions that keep the rental, vehicle and claim state machines consistent.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `branch` | A rental location where vehicles are based and picked up. Identified by a short code. | code, name, city |
| `vehicle` | A car in the fleet with plate, class, daily rate, odometer and an availability status. A vehicle belongs to a home branch. | plate, make, model, vehicle_class, daily_rate, status, branch_id, odometer_km |
| `customer` | A driver who rents cars. Holds license details and a blocked flag that stops new reservations. | name, email, license_number, phone, blocked |
| `rental` | A reservation that becomes a rental. Has scheduled pickup_at and due_at, actual picked_up_at and returned_at, a daily rate snapshot, base charge, late fee, damage charge and odometer readings. Created only by the reserve_rental action. | customer_id, vehicle_id, pickup_branch_id, status, pickup_at, due_at, picked_up_at, returned_at, daily_rate, base_charge, late_fee, late_fee_applied, late_fee_waived, damage_charge, odometer_out, odometer_in, cancel_reason |
| `damage_claim` | A damage report against a rental and vehicle with an estimated cost, reviewed to an approved amount or denied, then settled onto the rental's damage charge. | rental_id, vehicle_id, description, estimated_cost, approved_amount, status, filed_at, resolved_at, denial_reason |

## Workflows

### rental_lifecycle (rental)
- States: reserved, active, returned, closed, cancelled
- Actions: reserve_rental, pickup_rental, return_rental, cancel_rental, close_rental, waive_late_fee
- Rules:
  - reserved can go to active or cancelled. active goes only to returned. returned goes only to closed. closed and cancelled are final.
  - reserve_rental needs a non-blocked customer, an available vehicle, due_at after pickup_at and no overlapping reserved or active rental on the vehicle. It snapshots daily_rate and sets base_charge to the daily rate times the days in the window, rounded up, minimum 1.
  - pickup_rental needs status reserved and the vehicle available. It sets picked_up_at to now, odometer_out from input (not below the vehicle odometer) and the vehicle to rented.
  - return_rental needs status active and odometer_in at or above odometer_out. It sets returned_at to now, odometer_in, updates the vehicle odometer and returns it to available at the return branch.
  - A rental is late when returned_at is more than 60 minutes after due_at. The daily late_fee_assessment job sets late_fee to ceil(minutes_late / 1440) times 1.5 times daily_rate, then sets late_fee_applied true. A job run never touches a rental twice.
  - waive_late_fee needs late_fee_applied true and a non-zero late_fee. It sets late_fee to 0, late_fee_waived to true and stores the reason. The job will not re-add it.
  - cancel_rental needs status reserved and a reason. It stores cancel_reason and keeps the vehicle as it is.
  - close_rental needs status returned. It refuses with 409 late_fee_pending when the rental was late and the fee is not assessed yet, and with 409 claim_pending when a claim is open or under_review.
  - expire_no_shows cancels reserved rentals more than 24h past pickup_at with cancel_reason no_show.
### vehicle_availability (vehicle)
- States: available, rented, maintenance, retired
- Actions: none
- Rules:
  - available can go to rented, maintenance or retired. rented can go to available or maintenance. maintenance can go to available or retired. retired is final.
  - rented is set only by pickup_rental and cleared only by return_rental. A plain PATCH cannot set or clear it.
  - approve_claim moves an available vehicle to maintenance. A rented vehicle stays rented until it is returned.
### damage_claim_review (damage_claim)
- States: open, under_review, approved, denied, settled
- Actions: file_damage_claim, review_claim, approve_claim, deny_claim, settle_claim
- Rules:
  - open goes to under_review or denied. under_review goes to approved or denied. approved goes to settled. denied and settled are final.
  - file_damage_claim needs a rental in active, returned or closed status and estimated_cost above 0. It copies vehicle_id from the rental and sets filed_at to now.
  - approve_claim needs under_review and an approved_amount between 1 and estimated_cost. It sets resolved_at.
  - deny_claim needs a non-blank reason, stores denial_reason and sets resolved_at.
  - settle_claim adds approved_amount to the rental damage_charge. It refuses with 409 if the rental is cancelled.

## Jobs

- `late_fee_assessment` runs every 1d: For every rental with status returned and late_fee_applied false: if returned_at is more than 60 minutes after due_at, set late_fee to ceil(minutes_late / 1440) times 150% of daily_rate. Set late_fee_applied true either way. Skip rentals with late_fee_waived true. A rental run twice is never charged twice.
- `expire_no_shows` runs every 1d: Cancel every reserved rental whose pickup_at is more than 24 hours before now, with cancel_reason no_show.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_branches` | GET | /branches | List branches, filter by city, search by name. |
| `get_branch` | GET | /branches/{id} | Get one branch. |
| `list_vehicles` | GET | /vehicles | List vehicles with filters status, vehicle_class, branch_id. Search plate, make and model. Sort by daily_rate and odometer_km. |
| `get_vehicle` | GET | /vehicles/{id} | Get one vehicle. |
| `create_vehicle` | POST | /vehicles | Add a vehicle to the fleet. It starts available. |
| `update_vehicle` | PATCH | /vehicles/{id} | Edit vehicle details and move it between available, maintenance and retired. rented is set only by actions. |
| `list_customers` | GET | /customers | List customers, filter by blocked, search name, email and license number. |
| `get_customer` | GET | /customers/{id} | Get one customer. |
| `create_customer` | POST | /customers | Register a customer. |
| `update_customer` | PATCH | /customers/{id} | Edit customer details or the blocked flag. |
| `list_rentals` | GET | /rentals | List rentals with filters status, customer_id, vehicle_id, pickup_branch_id, late_fee_applied. Sort by pickup_at, due_at and returned_at. |
| `get_rental` | GET | /rentals/{id} | Get one rental. |
| `list_customer_rentals` | GET | /customers/{customer_id}/rentals | Rental history of one customer. |
| `list_vehicle_rentals` | GET | /vehicles/{vehicle_id}/rentals | Rental history of one vehicle. |
| `list_damage_claims` | GET | /damage_claims | List claims with filters status, rental_id, vehicle_id. Sort by estimated_cost and filed_at. |
| `get_damage_claim` | GET | /damage_claims/{id} | Get one claim. |
| `list_rental_damage_claims` | GET | /rentals/{rental_id}/damage_claims | Claims filed against one rental. |
| `reserve_rental` | POST | /rentals | Action. Reserve an available vehicle for a customer between pickup_at and due_at. |
| `pickup_rental` | POST | /rentals/{id}/pickup | Action. Hand over the keys: reserved to active, vehicle becomes rented, records odometer_out. |
| `return_rental` | POST | /rentals/{id}/return | Action. Check the vehicle back in: active to returned, sets returned_at to now, records odometer_in, vehicle becomes available. |
| `cancel_rental` | POST | /rentals/{id}/cancel | Action. Cancel a reserved rental with a reason. |
| `close_rental` | POST | /rentals/{id}/close | Action. Close a returned rental once the late fee is assessed and no claim is pending. |
| `waive_late_fee` | POST | /rentals/{id}/waive_late_fee | Action. Zero an assessed late fee with a reason. |
| `file_damage_claim` | POST | /damage_claims | Action. File a claim against an active, returned or closed rental with an estimated cost. |
| `review_claim` | POST | /damage_claims/{id}/review | Action. Move an open claim to under_review. |
| `approve_claim` | POST | /damage_claims/{id}/approve | Action. Approve an under_review claim at an approved_amount no higher than the estimate. |
| `deny_claim` | POST | /damage_claims/{id}/deny | Action. Deny an open or under_review claim with a reason. |
| `settle_claim` | POST | /damage_claims/{id}/settle | Action. Settle an approved claim by adding its approved_amount to the rental's damage_charge. |

## Seed

- Rows per entity: branch: 6, vehicle: 60, customer: 90, rental: 170, damage_claim: 60
- Mix: Branches: 6 across different cities. Vehicles: about 50% available, 25% rented, 15% maintenance, 10% retired, over classes economy, compact, suv, luxury and van, with realistic plates, makes, models and daily rates in USD cents. Customers: 90 plausible names and emails, about 4 blocked, a few anchors (Elena Voss with one reserved rental, Tomas Reyes with an active overdue SUV rental plus an older closed rental, Priya Natarajan with two late returned rentals). Rentals: about 15% reserved with pickup in the future or less than 24h in the past, 20% active (some already past due_at), 25% returned (some late and not yet assessed because they were returned in the last day, the rest already assessed), 32% closed, 8% cancelled. Rentals returned late and older than a day have late_fee_applied true with a fee of ceil days late times 1.5 times the daily rate. Claims: 60 over returned and closed rentals, about 20% open, 40% under_review (more than 25 so listing pages, with estimated costs from $40 to $3,000, including one exactly at $150), 15% approved, 10% denied, 15% settled. All history is before clock.start. Scheduled future items are reserved pickups only.

## Tasks

- `cancel_elena_reservation` (easy): Cancel the upcoming reservation of the customer Elena Voss because her trip was called off. The reason must be given. The vehicle and every other rental stay unchanged.
  - Decoy idea: PATCH the rental status to cancelled, or cancel one of another customer's reservations, or leave out the reason.
- `return_tomas_reyes_suv` (medium): Tomas Reyes is at the counter returning his SUV after its due time. Check the rental in with an odometer reading of 48210 km. The late fee is left to the daily job. Do not touch his older closed rental.
  - Decoy idea: Return his older closed rental, record a wrong odometer, return it to the wrong state through PATCH, or try to add a late fee by hand.
- `waive_priya_late_fee` (medium): Priya Natarajan has two late returns. Waive the late fee only on the rental returned most recently, with a reason of flight delay. Leave the older one charged.
  - Decoy idea: Waive the older rental's fee, waive both, or edit the late_fee field directly without a reason.
- `triage_small_claims` (hard): Review the damage claims that are in under_review. Deny every one whose estimated cost is under $150 as minor wear and tear, with a reason. Approve every one at $150 or more at its full estimated cost. Do not settle anything or touch claims in any other status.
  - Decoy idea: Read only the first page of claims, treat $150 as below the threshold, also act on open claims, approve at less than the estimate, or settle the approved claims.

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

None. The plan changes no existing item.
