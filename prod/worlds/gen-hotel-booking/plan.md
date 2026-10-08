# WorldGen plan: Cloudbeds / Opera-style hotel property management system (PMS) reservations API

A single-property hotel booking system. Room types carry a nightly rate and capacity, rooms belong to a type, guests make reservations for a specific room over a half-open stay window [check-in 15:00, check-out 11:00). The engine refuses overlapping non-cancelled reservations on the same room (same-day turnover is allowed). Cancelling within 48 hours of check-in charges a one-night fee, posted as a folio charge, and a job marks unclaimed arrivals as no-shows. Status changes happen only through actions so the overlap and fee rules cannot be bypassed. Revision 2: every task now declares an allows list (entity, kind, exact fields for updates, and a where that picks the target rows), derived from the task instruction, so any change outside it scores 0.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `room_type` | A category of room with a base nightly rate and capacity, such as Standard Queen or Executive Suite. | name (unique), description, capacity (int), nightly_rate (money USD), bed_config (enum: single, double, queen, king, twin) |
| `room` | A physical room that can be booked. Housekeeping state gates check-in and bookability. | number (unique string), floor (int), room_type_id (ref room_type), housekeeping (enum: clean, dirty, out_of_service) |
| `guest` | A person who books and stays. | name, email (unique, email), phone, loyalty_tier (enum: none, silver, gold) |
| `reservation` | A booking of one room by one guest for a stay window. Status is readonly and moved only by actions. Overlap and cancellation-fee rules live here. | guest_id (ref guest), room_id (ref room), check_in (datetime, 15:00 UTC), check_out (datetime, 11:00 UTC), nights (int), adults (int), nightly_rate (money, snapshot of the room type rate at booking), total (money = nights x nightly_rate), status (state: confirmed, checked_in, checked_out, cancelled, no_show), cancelled_at (datetime, nullable), cancellation_fee (money, readonly, default 0), special_requests (text, nullable) |
| `folio_charge` | A charge posted against a reservation: room revenue at check-out, or a cancellation or no-show fee. Written by actions and jobs only. | reservation_id (ref reservation), kind (enum: room, cancellation_fee, no_show_fee), amount (money USD), description (string) |

## Workflows

### reservation_lifecycle (reservation)
- States: confirmed, checked_in, checked_out, cancelled, no_show
- Actions: create_reservation, cancel_reservation, check_in_reservation, check_out_reservation, change_room, find_available_rooms
- Rules:
  - create_reservation: guest and room must exist, room housekeeping must not be out_of_service, check_out_date must be after check_in_date, adults <= room type capacity, check_in must not be in the past (day granularity). nights, nightly_rate (from room type) and total are computed. Status starts confirmed.
  - No overlap: refuse with 409 room_unavailable if any confirmed, checked_in or checked_out reservation on the same room has check_in < new check_out and check_out > new check_in. Cancelled and no_show are ignored. The error names the conflicting reservation id.
  - cancel_reservation: only confirmed. If now >= check_in, 409. If minutes from now to check_in <= 48h (2880 min), set cancellation_fee to nightly_rate, create a folio_charge cancellation_fee for one night; otherwise fee 0 and no charge. Set cancelled_at to now.
  - check_in_reservation: only confirmed, now must be at or after the 00:00 of the check-in day, room housekeeping must be clean (409 room_not_ready otherwise).
  - check_out_reservation: only checked_in. Creates a folio_charge of kind room for total and sets the room housekeeping to dirty.
  - change_room: only confirmed. New room must differ, not be out_of_service, have capacity >= adults and have no overlap for the same dates. Total and nightly_rate stay as booked.
  - mark_no_shows job: confirmed reservations whose check_in is at least 24h in the past become no_show, with a one-night no_show_fee folio_charge and cancellation_fee unchanged.
  - cancelled, checked_out and no_show are final.
  - find_available_rooms: returns clean or dirty rooms (not out_of_service) with no overlapping active reservation for the range, filtered by optional room_type_id. Writes nothing.

## Jobs

- `mark_no_shows` runs every 1h: Every hour, each confirmed reservation whose check_in is at least 24 hours before now moves to no_show and gets a one-night no_show_fee folio_charge at the reservation's nightly_rate. Frees the room for new overlapping bookings.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_room_types` | GET | /room_types | List room types, filter by bed_config, sort by nightly_rate. |
| `get_room_type` | GET | /room_types/{id} | Fetch one room type. |
| `list_rooms` | GET | /rooms | List rooms, filter by room_type_id, floor, housekeeping; search by number. |
| `get_room` | GET | /rooms/{id} | Fetch one room. |
| `update_room` | PATCH | /rooms/{id} | Update housekeeping status (clean, dirty, out_of_service) and floor. |
| `list_guests` | GET | /guests | List guests, filter by loyalty_tier, search by name and email. |
| `get_guest` | GET | /guests/{id} | Fetch one guest. |
| `create_guest` | POST | /guests | Register a new guest. |
| `update_guest` | PATCH | /guests/{id} | Edit guest contact details or loyalty tier. |
| `list_reservations` | GET | /reservations | List reservations, filter by status, room_id, guest_id; sort by check_in and created_at; paged at 25. |
| `get_reservation` | GET | /reservations/{id} | Fetch one reservation. |
| `update_reservation` | PATCH | /reservations/{id} | Edit special_requests and adults only. Status, room and dates are readonly and change only through actions. |
| `list_reservation_charges` | GET | /reservations/{reservation_id}/charges | List folio charges for a reservation. |
| `list_charges` | GET | /charges | List all folio charges, filter by kind and reservation_id. |
| `create_reservation` | POST | /reservations | Action: book a room for a guest. Refuses overlap (409 room_unavailable), out_of_service rooms, over-capacity, bad dates. |
| `cancel_reservation` | POST | /reservations/{id}/cancel | Action: cancel a confirmed reservation. Charges a one-night fee when check-in is 48 hours or less away. |
| `check_in_reservation` | POST | /reservations/{id}/check_in | Action: check in a confirmed reservation on or after its check-in day if the room is clean. |
| `check_out_reservation` | POST | /reservations/{id}/check_out | Action: check out a checked-in guest, post the room charge, mark the room dirty. |
| `change_room` | POST | /reservations/{id}/change_room | Action: move a confirmed reservation to another room for the same dates, re-checking overlap and capacity; rate stays the original snapshot. |
| `find_available_rooms` | POST | /rooms/available | Action (read only): rooms free for a date range, optionally of one room type. |

## Seed

- Rows per entity: room_type: 5, room: 42, guest: 70, reservation: 130, folio_charge: 75
- Mix: Reservations: ~35% confirmed (mostly future, a handful arriving within 48h and a few just over 48h), ~10% checked_in, ~30% checked_out, ~18% cancelled (about a third with a one-night fee because they cancelled inside 48h), ~7% no_show. No two non-cancelled, non-no_show reservations overlap on one room; the seed is built room by room along a timeline so same-day turnovers exist. Rooms: ~80% clean, ~15% dirty, 2 out_of_service. Room types: five tiers with rates from 119.00 to 489.00. Guests: 60% no loyalty, 28% silver, 12% gold; a few guests share a surname and one guest has several future reservations. Charges: one room charge per checked_out reservation, one fee per fee-bearing cancellation and per no_show. Over 25 reservations so listing is paged.

## Tasks

- `cancel_distant_reservation` (easy): Cancel the confirmed reservation of the guest Eleanor Whitfield, whose stay starts well over 48 hours from now. The agent must find the guest, find their only confirmed reservation and call cancel. The grader checks status cancelled, cancellation_fee 0, no fee charge, and no other changes. Allows (from the instruction only): one reservation update, limited to the fields status, cancelled_at and cancellation_fee, where the row is Eleanor Whitfield's confirmed reservation (seed values guest_id = Eleanor Whitfield's guest id, status = confirmed). No folio_charge is created or changed, and no guest, room or other reservation changes.
  - Decoy idea: Cancels the confirmed reservation of a different guest sharing the surname Whitfield (Daniel Whitfield).
- `cancel_arriving_tomorrow_with_fee` (medium): A guest named Marcus Okafor phoned to cancel his booking that starts tomorrow. Cancel it. The fee rule applies automatically; the grader checks the reservation is cancelled with a cancellation_fee equal to exactly one night's snapshot rate and exactly one cancellation_fee folio_charge exists, and that his other, later confirmed reservation is untouched. Allows (from the instruction only): (1) one reservation update, limited to status, cancelled_at and cancellation_fee, where the row is Marcus Okafor's confirmed reservation starting tomorrow (seed values guest_id = Marcus Okafor's guest id, status = confirmed, and its own check_in); (2) one folio_charge created, where kind = cancellation_fee. Nothing else changes, in particular not his later confirmed reservation.
  - Decoy idea: Cancels Marcus Okafor's later confirmed reservation (more than 48h out, no fee) instead of the one starting tomorrow; or cancels both.
- `move_booking_to_free_room` (medium): The guest in room 305 for next weekend's reservation (reservation of guest Priya Nair) needs a different room because of a plumbing issue. Move that reservation to any free room of the same room type for the same dates. The grader checks room_id changed to a room of the same room_type with no overlap, dates, total and status unchanged, and no other rows changed. Allows (from the instruction only): one reservation update, limited to the field room_id, where the row is Priya Nair's confirmed reservation in room 305 (seed values guest_id = Priya Nair's guest id, room_id = room 305's id, status = confirmed). No other field, reservation, room or folio_charge changes.
  - Decoy idea: Moves the reservation to a free room of a different (cheaper) room type, or to a room that is free but out_of_service, or cancels and recreates the booking, which changes the id and may trigger a fee.
- `relocate_all_from_maintenance_room` (hard): Room 214 was just marked out_of_service for repairs. Move every future confirmed reservation currently on room 214 to another room of the same room type with no conflict, keeping dates, without cancelling anything, and without moving reservations that are already checked_in, checked_out or cancelled. Some targets need different replacement rooms because free rooms differ by date, and the reservation list needs paging to see all of them. The grader returns the fraction of target reservations correctly relocated, 0 if any non-target reservation changed or any cancellation or fee charge was created. Allows (from the instruction only): reservation updates, limited to the field room_id, where the rows are the confirmed reservations on room 214 (seed values room_id = room 214's id, status = confirmed). No reservation created or deleted, no other field or reservation changes, and no folio_charge or room changes.
  - Decoy idea: Reads only the first page of /reservations, or relocates every reservation on room 214 including the checked_in and past ones, or puts two targets into the same replacement room with overlapping dates, which the engine refuses, or cancels the reservations (incurring fees for those inside 48h).

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

- tasks.cancel_distant_reservation
- tasks.cancel_arriving_tomorrow_with_fee
- tasks.move_booking_to_free_room
- tasks.relocate_all_from_maintenance_room
