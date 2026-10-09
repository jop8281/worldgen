# WorldGen report: Cloudbeds/Opera-style hotel property management booking desk

A hotel front desk where guests hold reservations for room types. The desk enforces an overbooking limit per room type, charges a late-cancellation fee inside 48h of arrival (waived for VIPs), automatically marks no-shows and charges a no-show fee, and checks guests into and out of physical rooms.

## What was built

Entities (5):

- `guest`: 24 seeded rows
- `room_type`: 4 seeded rows
- `room`: 24 seeded rows
- `reservation`: 40 seeded rows
- `charge`: 9 seeded rows

Routes (13):

- `list_guests`: GET /guests
- `get_guest`: GET /guests/{id}
- `create_guest`: POST /guests
- `list_room_types`: GET /room_types
- `get_room_type`: GET /room_types/{id}
- `create_room_type`: POST /room_types
- `list_rooms`: GET /rooms
- `get_room`: GET /rooms/{id}
- `create_room`: POST /rooms
- `list_reservations`: GET /reservations
- `get_reservation`: GET /reservations/{id}
- `list_charges`: GET /charges
- `get_charge`: GET /charges/{id}

Actions (4):

- `create_reservation`: POST /reservations
- `cancel_reservation`: POST /reservations/{id}/cancel
- `check_in_reservation`: POST /reservations/{id}/check_in
- `check_out_reservation`: POST /reservations/{id}/check_out

Jobs (1):

- `no_show_sweep`: every 1h

## Assumed and why

- Clock starts 2026-10-09T12:00:00Z with tick 0s; arrivals today at 15:00 and later are planned future events.
  - Why: Explicit deterministic time; seeded history is before start.
- Overbooking limit per room type = capacity + floor(capacity*overbook_percent/100), counted over booked and checked_in reservations whose stay overlaps (departure day equals next arrival is not overlap).
  - Why: Common hotel practice; request gives no formula.
- Late cancellation = cancel less than 48h before arrival_date; fee = one night at the reservation's nightly_rate snapshot; vip guests waived.
  - Why: Typical policy; request names only late cancellations.
- No-show fee = one night; the hourly no_show_sweep job marks booked reservations no_show once now >= arrival_date + 12h.
  - Why: No-shows are detected by time, so a job.
- Reservations are created only by the create_reservation action (POST /reservations), not a standard create route; status changes happen via actions.
  - Why: So the overbooking rule cannot be bypassed.
- check_in requires arrival date (UTC day) on or before today, a booked reservation and an available room of the booked type; room chosen is lowest id.
  - Why: Simple deterministic room assignment.
- Money is USD in minor units.
  - Why: Single currency.

## Questions asked of the input

- How is the overbooking limit defined?
  - Default answer: capacity plus overbook_percent of capacity (rounded down) per room type, over overlapping active stays.
- What is the late cancellation window and fee?
  - Default answer: Under 48 hours before arrival; one night's rate; waived for vip guests.
- When is a guest a no-show and what is the fee?
  - Default answer: 12 hours after the arrival time without check-in; one night's rate.
- Can staff create reservations through a plain create route?
  - Default answer: No; only the create_reservation action, to enforce overbooking.

## Left out

- Payments, deposits, taxes, invoicing
  - Why: Only fees recorded as charge rows matter for the desk workflow.
- Room upgrades/moves, multi-room group bookings, rate plans and seasonal pricing
  - Why: Keeps the world focused on overbooking, cancellation and no-show rules.
- Modification of an existing reservation's dates
  - Why: Cancel and rebook instead.

## Proof

The engine check passed: 5 world tests, 4 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_23a412ded360bf4a7f16e972ff5c7823865fb68bd8fabbad047f9ce84a60fb7b`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_elena_december_stay | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 2/8 | `tid_348613dcae09878a31a553d0a9eb2b96e994db0b692c8a4b05bf0c539bc22e30` |
| cancel_tomas_tomorrow_stay | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | declared (2); mutants 2/8 | `tid_9d5c3047e7ce4cebb121269e1502be75d3c07ce59d9ec67530dc08e2df674c74` |
| suite_turnover_today | hard | 1.000 | 0.000 | 0.400, 0.400, 0.000 | 0.400 | declared (3); mutants 0/8 | `tid_b1666f2833015114e7bb556275ba00a264c93e67f1e190cd465994b3f14cf905` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_elena_december_stay` 0.000: cancels her January 2027 reservation instead of the December one
- `cancel_elena_december_stay` 0.000: cancels both of her reservations instead of only the December one
- `cancel_tomas_tomorrow_stay` 0.000: cancels the December booking instead of the one arriving tomorrow
- `cancel_tomas_tomorrow_stay` 0.000: cancels the right stay but also cancels his December booking
- `cancel_tomas_tomorrow_stay` 0.000: follows the 'fee waived' note by searching the notes and cancelling only the December booking, leaving the tomorrow stay booked
- `suite_turnover_today` 0.400: checks in first and checks out afterwards, so only one arrival finds a free suite and the rest are refused
- `suite_turnover_today` 0.400: only checks out the departing suite stays and never checks in the arrivals
- `suite_turnover_today` 0.000: goes by status alone: checks out every checked-in suite including the one departing tomorrow, then tries every booked suite

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_elena_december_stay | easy | 1 | none | reservation | none declared |
| cancel_tomas_tomorrow_stay | medium | 2 | none | reservation | distractors: met; state: met |
| suite_turnover_today | hard | 8 | none | reservation | hard: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Cloudbeds/Opera-style hotel property management booking desk, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.58 | 0.1584 |
| model | 1 | 0.38 | 0.1015 |
| workflow | 1 | 0.43 | 0.1149 |
| seed | 1 | 0.88 | 0.1643 |
| tasks | 1 | 1.83 | 0.2729 |
| Total | 5 | 5.10 | 0.8119 |

Run total: 5.11 minutes, $0.8119.
