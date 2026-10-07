# WorldGen report: Rover/Wag-style dog-walking marketplace (owners, dogs, walkers, walk bookings and payments)

A dog-walking service. Owners register dogs and book a walker for a time slot. A booking carries up to 4 dogs, and a walker can't be double-booked. Walkers start and complete walks, and a job flags walks not started 30 minutes after the slot begins as missed. Cancellation is free until 2 hours before the slot and costs half the price after that. Owners pay after the walk, or pay the cancellation fee.

## What was built

Entities (6):

- `owner`: 12 seeded rows
- `dog`: 20 seeded rows
- `walker`: 5 seeded rows
- `booking`: 30 seeded rows
- `booking_dog`: 57 seeded rows
- `payment`: 12 seeded rows

Routes (17):

- `list_owners`: GET /owners
- `get_owner`: GET /owners/{id}
- `create_owner`: POST /owners
- `update_owner`: PATCH /owners/{id}
- `list_dogs`: GET /dogs
- `get_dog`: GET /dogs/{id}
- `create_dog`: POST /dogs
- `update_dog`: PATCH /dogs/{id}
- `list_walkers`: GET /walkers
- `get_walker`: GET /walkers/{id}
- `create_walker`: POST /walkers
- `update_walker`: PATCH /walkers/{id}
- `list_bookings`: GET /bookings
- `get_booking`: GET /bookings/{id}
- `list_booking_dogs`: GET /bookings/{booking_id}/dogs
- `list_payments`: GET /payments
- `get_payment`: GET /payments/{id}

Actions (6):

- `book_walk`: POST /bookings
- `add_dog`: POST /bookings/{id}/add_dog
- `cancel_booking`: POST /bookings/{id}/cancel
- `start_walk`: POST /bookings/{id}/start
- `complete_walk`: POST /bookings/{id}/complete
- `pay_booking`: POST /bookings/{id}/pay

Jobs (1):

- `flag_missed_walks`: every 5m

## Assumed and why

- Clock starts at 2026-10-07T09:00:00.000Z with tick 0s. Seeded history lies before it. Booked and in-progress-ending slots lie after it, and time moves only through explicit advance or jobs.
  - Why: Today is 2026-10-07. Deterministic time makes the 2-hour cancellation window, the 30-minute missed rule and the acceptance-test timestamps exact.
- A booking is a walk with one owner, one walker and 1 to 4 dogs of that owner. It is created with one dog and add_dog adds more, held as booking_dog rows with a denormalized dog_count.
  - Why: The input says a walker takes at most 4 dogs on one walk yet can't have overlapping slots. So several dogs must share one booking.
- Price is walker.rate_per_dog * dog_count * duration_minutes / 30. Durations are multiples of 30 from 30 to 120, and rates are multiples of 100 minor units so half of the price is exact.
  - Why: The input gives a price and half-price cancellation but no pricing model. This is the simplest rule that depends on dogs and duration.
- Late cancellation means fewer than 120 minutes remain before starts_at, so exactly 120 minutes is free. A cancellation after the slot began still comes from booked and costs half the price.
  - Why: The input says free until 2 hours before. Boundary inclusive is the natural reading.
- A walk may be started from starts_at on (not earlier) until it is flagged missed. The job flags a booked walk missed once now >= starts_at + 30m and runs every 5 minutes. Missed walks are final, not chargeable and not cancellable.
  - Why: The input says a walk not started 30 minutes after its slot begins is flagged. Charging for no-shows and un-missing are unspecified, so the plan keeps it simple.
- Payment is one full payment per booking, recorded as a payment row. It is the walk price for completed bookings or the cancellation fee for late-cancelled ones, with method card or cash. There is no payment gateway.
  - Why: The input says owners pay after the walk. A single settled payment keeps the model small.
- Overlap blocking counts booked, in_progress and completed bookings of the same walker. Cancelled and missed ones release the slot. A dog or owner may have overlapping bookings with different walkers.
  - Why: The input constrains only walkers.
- Unknown refs on action inputs answer the engine's 400 input.invalid, and action-specific failures use 409/422 codes named in the workflow rules. book_walk and pay_booking answer 201 and the other actions 200.
  - Why: Follows the engine error convention. Actions that create a row answer 201.
- Bookings have no standard create or update route. Only actions change them. Owners, dogs and walkers have standard create, get, list and update routes and no delete.
  - Why: Prevents bypassing the state machine and the pricing and overlap rules. Delete is not needed for any task.

## Questions asked of the input

- Is a missed walk charged to the owner?
  - Default answer: No. A missed walk is final, costs nothing and can't be paid.
- Can a walk be started before its slot begins?
  - Default answer: No. Starting before starts_at answers 409 too_early.
- Is the 2-hour boundary inclusive?
  - Default answer: Yes. Cancelling exactly 120 minutes before the slot is free.
- How is the price determined?
  - Default answer: The walker's rate_per_dog per 30 minutes, times the number of dogs and the number of 30 minute blocks.
- Does the 4-dog limit and walker overlap rule apply across owners?
  - Default answer: A booking belongs to one owner and holds up to 4 of that owner's dogs. The walker overlap rule applies across all owners.
- Who can cancel, start or complete a booking?
  - Default answer: There is no authentication. Any caller can act, and the rules depend only on state and time.

## Left out

- Real payment processing, refunds, tips and invoices
  - Why: The core value is the booking and cancellation workflow. Payment is a simple settle-once record.
- Walker availability schedules, recurring walks, GPS tracking, ratings and reviews
  - Why: Not in the input and they would grow the model without adding core rules.
- Dog-level overlap checks and notifications to owners or walkers
  - Why: The input constrains only walkers' slots, and notifications have no stateful record to test.
- Rescheduling a booking
  - Why: The input offers only cancel and rebook.

## Proof

The engine check passed: 8 world tests, 3 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_1de1ef73a99ff6863b4a56f79627fabeda27093084e6400bf8ca9e49c0b0617c`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | TID |
|---|---|---|---|---|---|---|
| cancel_rocky_walk_free | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | `tid_b8939c92a0aa647adae48f9a3e9ba6f756ca975f1791f0d7d806bb50d71432ae` |
| pay_tom_completed_walks | medium | 1.000 | 0.000 | 0.000, 0.667, 0.000 | 0.667 | `tid_b3cdbf728343fee76f08e774b35e40ee467a3d539bbd78bc038a70ec2112e19f` |
| book_priya_three_dogs | hard | 1.000 | 0.000 | 0.500, 0.600, 0.700, 0.000 | 0.600 | `tid_4031f70cd99c48755f14eb10aa3d20c8d13dfc262c0b31e273d00387242f47d7` |

Decoys:

- `cancel_rocky_walk_free` 0.000: cancels the booked walk of Maria's other dog Daisy instead of Rocky's
- `cancel_rocky_walk_free` 0.000: cancels every booked walk of Maria, including the one for Daisy
- `pay_tom_completed_walks` 0.000: pays every payable unpaid booking of Tom, including the late-cancellation fee booking
- `pay_tom_completed_walks` 0.667: reads only the first two unpaid completed walks (a short page) and misses the rest
- `pay_tom_completed_walks` 0.000: pays all the right walks but with cash instead of card
- `book_priya_three_dogs` 0.500: takes a free active walker who is not the cheapest (Ana Ruiz) and books all three dogs with her
- `book_priya_three_dogs` 0.600: books the right walker and slot but only for Luna, never calling add_dog for Max and Pepper
- `book_priya_three_dogs` 0.700: books the right walker with all three dogs but at 15:30, the slot that fits the busy cheaper walker, instead of 15:00
- `book_priya_three_dogs` 0.000: books the right walker and slot with all three dogs, then books an extra walk for Luna with another walker

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 4.76 | 0.8165 |
| model | 1 | 0.44 | 0.3681 |
| workflow | 1 | 0.49 | 0.3643 |
| seed | 1 | 2.33 | 0.5304 |
| tasks | 1 | 1.75 | 0.5134 |
| Total | 5 | 9.76 | 2.5927 |

Run total: 9.78 minutes, $2.5927.
