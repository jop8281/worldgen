# WorldGen report: Mindbody-style gym management (members, class schedule, bookings)

A gym front-desk world. Members hold class credits. Classes have a capacity and a waitlist. Agents book members into classes, cancel bookings (early cancels refund the credit, late ones forfeit it), check members in, and cancel whole classes. A job closes finished classes and marks no-shows.

## What was built

Entities (3):

- `member`: 40 seeded rows
- `class_session`: 30 seeded rows
- `booking`: 70 seeded rows

Routes (10):

- `list_members`: GET /members
- `get_member`: GET /members/{id}
- `create_member`: POST /members
- `update_member`: PATCH /members/{id}
- `list_sessions`: GET /sessions
- `get_session`: GET /sessions/{id}
- `create_session`: POST /sessions
- `update_session`: PATCH /sessions/{id}
- `list_bookings`: GET /bookings
- `get_booking`: GET /bookings/{id}

Actions (4):

- `book_class`: POST /sessions/{id}/book
- `cancel_booking`: POST /bookings/{id}/cancel
- `check_in`: POST /bookings/{id}/check_in
- `cancel_class`: POST /sessions/{id}/cancel

Jobs (1):

- `auto_complete_classes`: every 1h

## Assumed and why

- Clock starts 2026-10-07T09:00:00Z with tick 0s. Seeded history lies before it and upcoming classes after it.
  - Why: Tests use fixed ISO times relative to the start, so time must be explicit.
- Each class costs one credit. Confirmed bookings are charged when made; waitlisted bookings are charged only on promotion.
  - Why: Mindbody-style class packs work this way. The request does not specify it.
- A cancel at least 120 minutes before start refunds the credit. A later cancel forfeits it.
  - Why: A late-cancel window is standard in gym software.
- Check-in opens 60 minutes before start and runs until the class ends.
  - Why: Agents check members in at the front desk.
- Joining the waitlist needs at least 1 credit. A promotion skips waitlisted members who have none.
  - Why: A promotion must be able to charge the member.
- Booking is refused once a class has started or been cancelled.
  - Why: Keeps the state machine simple.
- No separate trainer, location or payment entities. Instructor is a string.
  - Why: The core is members, classes and bookings.
- Action codes: no_credits, already_booked, class_not_open, too_early, invalid_state, member_inactive, all 409.
  - Why: Distinct codes let agents recover.
- book_class answers 201 with the booking. The other actions answer 200.
  - Why: book_class creates a row.

## Questions asked of the input

- Do members pay per class with credits, or have unlimited memberships?
  - Default answer: Credits per class. The plan field is informational.
- What is the late-cancel window?
  - Default answer: 120 minutes before start.
- Is there a waitlist?
  - Default answer: Yes, first come first served, charged on promotion.
- Which standard routes should exist for bookings?
  - Default answer: Read-only list and get. Bookings are made and changed only through the book, cancel and check-in actions.

## Left out

- Payments, invoicing, memberships billing
  - Why: Credits stand in for payments.
- Recurring class series, rooms, trainers as entities
  - Why: The core is the booking workflow.
- Member-facing UI and notifications
  - Why: Agents act through the API only.

## Proof

The engine check passed: 10 world tests, 0 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_2984917fc87102f87d0cbb738809a724c8f1e0b902d8d968ede75d311e42149b`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| book_member_into_class | easy | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | declared (3); mutants 5/7 | `tid_3610c6d83cc95c19055ce362e316999ee15d85d95fb75655ed7cae5f60c734e7` |
| cancel_late_booking_promote | medium | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (4); mutants 5/7 | `tid_39aea2356fa0b3ab4ea83d21e143c15e55fbc3c40f551264d57d6abbfc127ffe` |
| cancel_instructor_classes | hard | 1.000 | 0.000 | 0.800, 0.000 | 0.800 | declared (4); mutants 4/7 | `tid_70d958087375ce985842da09f56b8a9ca81651dcfd0a741f9845ae0b9536f929` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `book_member_into_class` 0.000: books Dana into the Yoga class by Priya Nair a week later (17 October) instead of this Saturday
- `book_member_into_class` 0.000: books the lookalike member Dana Whitford into the right class
- `book_member_into_class` 0.000: books Dana into the Saturday Yoga class taught by Priya Shah instead of Priya Nair
- `cancel_late_booking_promote` 0.000: cancels a different member's booking (Jamie Nguyen) in the same full class
- `cancel_late_booking_promote` 0.000: cancels the first waitlisted booking (Quinn Nguyen) instead of Taylor's confirmed booking, so nobody is promoted
- `cancel_instructor_classes` 0.800: reads only the first page of sessions, so it misses the Marco Reyes class on page 2
- `cancel_instructor_classes` 0.000: matches the instructor by the prefix 'Marc' and also cancels the scheduled classes of the lookalike Marcus Reyes

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| book_member_into_class | easy | 3 | none | class_session | distractors: met |
| cancel_late_booking_promote | medium | 5 | none | booking, class_session | distractors: met; state: met; state: met |
| cancel_instructor_classes | hard | 32 | class_session | class_session | hard: met; paging: met; distractors: met; state: met; state: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Mindbody-style gym management (members, class schedule, bookings), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.27 | 0.3415 |
| model | 1 | 0.37 | 0.3149 |
| workflow | 1 | 0.83 | 0.4065 |
| seed | 1 | 1.09 | 0.3759 |
| tasks | 1 | 3.67 | 0.6361 |
| Total | 5 | 7.22 | 2.0750 |

Run total: 7.23 minutes, $2.0750.
