# WorldGen report: Cloudbeds / Opera-style hotel property management system (PMS) reservations API

A single-property hotel booking system. Room types carry a nightly rate and capacity, rooms belong to a type, guests make reservations for a specific room over a half-open stay window [check-in 15:00, check-out 11:00). The engine refuses overlapping non-cancelled reservations on the same room (same-day turnover is allowed). Cancelling within 48 hours of check-in charges a one-night fee, posted as a folio charge, and a job marks unclaimed arrivals as no-shows. Status changes happen only through actions so the overlap and fee rules cannot be bypassed. Revision 2: every task now declares an allows list (entity, kind, exact fields for updates, and a where that picks the target rows), derived from the task instruction, so any change outside it scores 0.

## What was built

Entities (5):

- `room_type`: 5 seeded rows
- `room`: 42 seeded rows
- `guest`: 70 seeded rows
- `reservation`: 130 seeded rows
- `folio_charge`: 57 seeded rows

Routes (14):

- `list_room_types`: GET /room_types
- `get_room_type`: GET /room_types/{id}
- `list_rooms`: GET /rooms
- `get_room`: GET /rooms/{id}
- `update_room`: PATCH /rooms/{id}
- `list_guests`: GET /guests
- `get_guest`: GET /guests/{id}
- `create_guest`: POST /guests
- `update_guest`: PATCH /guests/{id}
- `list_reservations`: GET /reservations
- `get_reservation`: GET /reservations/{id}
- `update_reservation`: PATCH /reservations/{id}
- `list_reservation_charges`: GET /reservations/{reservation_id}/charges
- `list_charges`: GET /charges

Actions (6):

- `create_reservation`: POST /reservations
- `cancel_reservation`: POST /reservations/{id}/cancel
- `check_in_reservation`: POST /reservations/{id}/check_in
- `check_out_reservation`: POST /reservations/{id}/check_out
- `change_room`: POST /reservations/{id}/change_room
- `find_available_rooms`: POST /rooms/available

Jobs (1):

- `mark_no_shows`: every 1h

## Changes

- item_changed `tasks.cancel_arriving_tomorrow_with_fee.allows`
- item_changed `tasks.cancel_distant_reservation.allows`
- item_changed `tasks.move_booking_to_free_room.allows`
- item_changed `tasks.relocate_all_from_maintenance_room.allows`

## Assumed and why

- Stay times are fixed: check-in 15:00 UTC, check-out 11:00 UTC. Actions take date strings (YYYY-MM-DD) and build the datetimes.
  - Why: The field types have no date-only type. Fixed times make the 48-hour rule and same-day turnover deterministic.
- Overlap is half-open: [check_in, check_out). A reservation ending the same day another begins on the same room is allowed. Only confirmed, checked_in and checked_out reservations count; cancelled and no_show free the room.
  - Why: Standard hotel turnover behavior.
- The cancellation fee applies when minutes from now to check_in are between 0 and 48h inclusive (<= 2880 minutes). The fee is one night at the reservation's snapshot nightly_rate, recorded on the reservation (cancellation_fee) and as a folio_charge of kind cancellation_fee.
  - Why: The input says 'within 48 hours of check-in' and 'one-night fee'. Inclusive is the guest-unfriendly reading, chosen so the boundary is explicit and testable.
- Cancelling after the check-in time has passed is refused with 409. Such a reservation is checked in or becomes a no_show.
  - Why: Cancellation is a pre-arrival operation. The fee rule has no meaning after check-in.
- A no_show (set by the mark_no_shows job when a confirmed reservation is 24h past check_in) is charged one night as a no_show_fee folio charge.
  - Why: Mirrors common hotel policy and the same one-night fee as the input.
- Reservation status, room_id, dates and money fields are readonly on PATCH. Everything changes through actions.
  - Why: Otherwise a plain PATCH would bypass the overlap and fee rules.
- One reservation books exactly one room. Group bookings are several reservations by the same guest.
  - Why: Keeps the overlap rule per room and the model small.
- Rate is a snapshot from the room type at booking time, with no seasonal rates, taxes or discounts. Total = nights x nightly_rate.
  - Why: The input only requires a flat one-night fee. Pricing complexity is out of scope.
- Check-in requires the room housekeeping to be clean, and check-out sets it to dirty. update_room lets staff mark it clean.
  - Why: Gives rooms a realistic lifecycle and a plausible 409 case without a separate entity.
- Single property, a single currency (USD), no auth or users.
  - Why: Not specified in the input. Worlds are tested through the API only.
- Clock starts at 2026-10-06T09:00:00Z with a 1s tick. Seed dates are relative to the clock start.
  - Why: Today's date, so the 48-hour window can be tested from seed data.
- Each task's allows list is written from its instruction: the cancel tasks allow a reservation update of status, cancelled_at and cancellation_fee (plus one cancellation_fee folio_charge creation only where the instruction says a fee applies); the move and relocate tasks allow reservation updates of room_id only. Each where uses seed values of the target rows (guest, room, status), never ids hard-coded from the reference solution's writes. The later tasks stage writes these into the world's tasks.allows.
  - Why: The change request asks for exactly this, and the plan task schema has no allows field, so the plan records the list in each task's intent for the tasks stage to follow.
- The workflow rules stay as plain text and no acceptance tests are added. No new action is introduced, and prerequisite rows (room types, rooms) have no create route, so tests could not build their own prerequisites through ctx.api.
  - Why: The request changes only tasks. Existing tests keep running unchanged against an unchanged model and workflow.

## Questions asked of the input

- Is the 48-hour window inclusive at exactly 48:00 before check-in, and is it measured against the check-in time or the check-in date?
  - Default answer: Inclusive, measured against the check-in datetime (15:00 UTC on the arrival day).
- How big is the cancellation fee: first night only, or the first night at the booked rate regardless of the total?
  - Default answer: One night at the reservation's snapshot nightly_rate.
- Do no-shows incur the fee as well?
  - Default answer: Yes, a one-night no_show_fee posted by an hourly job 24h after check-in.
- Can two reservations touch on the same room when one checks out the day the next checks in?
  - Default answer: Yes. Intervals are half-open, with check-out 11:00 and check-in 15:00.
- Can one reservation contain several rooms?
  - Default answer: No. One reservation, one room. Group bookings are multiple reservations.
- Are there rate plans, taxes, deposits or payments?
  - Default answer: No. Flat room-type rate, USD, no payments.
- Should clients be able to PATCH reservation status or dates directly?
  - Default answer: No. Those fields are readonly and change only through actions so the rules cannot be bypassed.
- What timezone and clock should the world use?
  - Default answer: UTC, clock start 2026-10-06T09:00:00Z, 1s tick.
- Is there authentication or per-user permissions?
  - Default answer: No. Out of scope.
- Should an allows list be a strict whitelist of fields, even for fields the engine sets as a side effect of an action (such as cancelled_at)?
  - Default answer: Yes, but the list includes the fields the named action necessarily writes (status, cancelled_at, cancellation_fee for cancel; room_id for change_room). Engine timestamps and job changes are exempt.

## Left out

- Payments, deposits, refunds and card handling
  - Why: The fee is a ledger charge only. Payment processing adds no value to the tests.
- Seasonal or dynamic pricing, taxes, promo codes
  - Why: Flat room-type rates are enough for the one-night fee rule.
- Multi-property chains, channel managers, OTA sync
  - Why: Single-property scope.
- Authentication, staff users and roles
  - Why: The input has no permission model.
- Date modification and early-departure or extension of stays
  - Why: Overlap logic is already exercised by create_reservation and change_room.
- Email notifications and housekeeping task assignment
  - Why: No outbound integrations. Housekeeping is a single status field.
- Changes to the model, routes, actions, jobs, seed or tests
  - Why: The change request only asks for allows lists on tasks.

## Proof

The engine check passed: 7 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_651b175b652a265cba7d9859dab882e8bcb5869c759c52f148a04058bce5f712`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_distant_reservation | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 1/7 | `tid_b1eff6e5e6406cca6a376091c01eed4509faa3ba8312de75a0daff9de5532edb` |
| cancel_arriving_tomorrow_with_fee | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | declared (2); mutants 1/7 | `tid_d8590664dc963bcda3fa3b5d2cb1fd97a1fd9a66946b9b5c781bec5dae3d1da8` |
| move_booking_to_free_room | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | declared (1); mutants 3/7 | `tid_90eca8272f5c234f23c2632d429bcceaa280d54f20c570f346db556885e5cd53` |
| relocate_all_from_maintenance_room | hard | 1.000 | 0.000 | 0.500, 0.000, 0.000 | 0.833 | declared (1); mutants 3/7 | `tid_03eabfa0e5b01a3f8221b9f790b20b05bafb8793160bbe8a3928afda0c95359c` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_distant_reservation` 0.000: searches for the surname Whitfield and cancels the confirmed reservation of Daniel Whitfield instead of Eleanor
- `cancel_distant_reservation` 0.000: cancels the correct reservation, then also changes its adults count
- `cancel_arriving_tomorrow_with_fee` 0.000: cancels Marcus Okafor's later confirmed reservation (more than 48 hours out) instead of the one starting tomorrow
- `cancel_arriving_tomorrow_with_fee` 0.000: cancels every confirmed reservation of Marcus Okafor, including the later one that should stay
- `cancel_arriving_tomorrow_with_fee` 0.000: cancels the correct reservation, then also changes its adults count
- `move_booking_to_free_room` 0.000: moves the reservation to a free room of a different room type instead of the same type
- `move_booking_to_free_room` 0.000: cancels the reservation and books a new one in another room, which changes the reservation id and leaves a cancelled booking behind
- `move_booking_to_free_room` 0.000: moves the reservation correctly but also overwrites its special_requests, an unrequested change
- `relocate_all_from_maintenance_room` 0.500: reads only the first page of confirmed reservations, so it misses the room 214 bookings that start later
- `relocate_all_from_maintenance_room` 0.000: cancels the confirmed reservations on room 214 instead of relocating them
- `relocate_all_from_maintenance_room` 0.000: moves each reservation to any free room without checking that it has the same room type as 214

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_distant_reservation | easy | 1 | none | none | none declared |
| cancel_arriving_tomorrow_with_fee | medium | 2 | none | reservation | none declared |
| move_booking_to_free_room | medium | 1 | none | none | none declared |
| relocate_all_from_maintenance_room | hard | 6 | none | none | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $1.60.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.82 | 0.0972 |
| tasks | 1 | 0.21 | 0.3782 |
| Total | 2 | 1.03 | 0.4753 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures; it keeps 1 issue(s) the world had before this iterate: plan.seed_rows_short

Run total: 1.28 minutes, $0.4753.
