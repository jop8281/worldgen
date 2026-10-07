# WorldGen report: Mindbody / Mariana Tek-style boutique gym class booking system (classes, members, bookings, waitlists, check-in)

A gym class booking desk built from the imported gym_bookings table. Members book scheduled classes. A full class puts the booking on a FIFO waitlist. Cancelling a seat promotes the next waitlisted member. Late cancels are flagged. Members check in shortly before class. A job marks absent members as no-shows, and members with three no-shows are blocked from booking. Front-desk staff can cancel a whole class, which cancels every active booking on it. Agents read classes, members and bookings and run these actions.

## What was built

Entities (3):

- `member`: 58 seeded rows
- `gym_class`: 16 seeded rows
- `booking`: 155 seeded rows

Routes (12):

- `list_classes`: GET /classes
- `get_class`: GET /classes/{id}
- `create_class`: POST /classes
- `update_class`: PATCH /classes/{id}
- `list_members`: GET /members
- `get_member`: GET /members/{id}
- `create_member`: POST /members
- `update_member`: PATCH /members/{id}
- `list_bookings`: GET /bookings
- `get_booking`: GET /bookings/{id}
- `list_class_bookings`: GET /classes/{class_id}/bookings
- `list_member_bookings`: GET /members/{member_id}/bookings

Actions (4):

- `book_class`: POST /bookings
- `cancel_booking`: POST /bookings/{id}/cancel
- `check_in_booking`: POST /bookings/{id}/check_in
- `cancel_class`: POST /classes/{id}/cancel

Jobs (2):

- `mark_no_shows`: every 15m
- `expire_waitlist`: every 15m

## Assumed and why

- clock.start is 2026-10-07T09:00:00Z with tick 0s.
  - Why: The newest imported booked_at is 2026-10-07T04:37Z and classes run from 2026-10-01 to 2026-10-13. Starting at 09:00 on 2026-10-07 puts all booking history in the past, classes up to 10-07 mostly in the past and later classes in the future. Time moves only through explicit advances, so tests and graders are deterministic.
- The single CSV is split into three entities: member, gym_class and booking.
  - Why: The CSV is denormalised. Class attributes repeat per class_id and member_id repeats per booking, and a booking desk needs separate classes and members to book into.
- Members have no data beyond member_id, so names and emails are generated deterministically in the seed. member_code keeps the original id.
  - Why: A member record needs a name for agents to look people up by, and the CSV has none.
- Capacity counts only bookings in status booked. A class with no free seat puts new bookings on the waitlist.
  - Why: Cancelled and waitlisted bookings hold no seat. The check applies only at booking time, and the seed may contain classes over capacity from the imported data.
- Waitlist promotion is FIFO by booked_at, with ties broken by booking id.
  - Why: This is the real-world rule, and the seed has distinct booked_at values.
- A cancel within 120 minutes before class start sets late_cancel true. An earlier cancel sets it false. Cancels after start are refused. cancel_class never sets late_cancel.
  - Why: Gyms commonly flag late cancels for fees. No fee is modelled.
- Check-in opens 30 minutes before start and closes at start + 15 minutes, when the no-show grace ends.
  - Why: This is a typical studio rule and makes the no-show job and check-in agree.
- The mark_no_shows job runs every 15m. It turns booked bookings of classes started at least 15 minutes ago into no_show and increments the member's no_show_count. A member with no_show_count of 3 or more cannot book new classes (409 member_blocked).
  - Why: This gives the data's no_show status a mechanism and makes time matter.
- The expire_waitlist job runs every 15m. It cancels waitlisted bookings of classes that have started. They are not promoted.
  - Why: A waitlist spot is useless once class starts.
- The booking stateMix is estimated: attended 38, no_show 8, cancelled 14, booked 30, waitlisted 10. The seed should keep the CSV statuses.
  - Why: Only the distinct status values are known. The estimate assumes roughly half of the classes are before 2026-10-07 and a minority of bookings are cancelled or waitlisted.
- Error codes: duplicate_booking, class_started, class_cancelled, member_blocked, check_in_not_open, check_in_closed, already_cancelled and invalid_state, all with status 409. Unknown or missing inputs answer 400 input.invalid and unknown rows answer 404 not_found.
  - Why: This follows the example world's conventions, and the acceptance tests rely on them.
- Acceptance tests create their own classes and members with TST- prefixed codes and 2026-10 dates and use fixed literal times relative to clock.start.
  - Why: Tests run before any seed exists. The TST- codes avoid collisions with seeded M0xx and C0xx codes.
- Create routes (POST /classes, POST /members) exist. Booking creation is only through the book_class action at POST /bookings, with no create route for booking.
  - Why: Bookings must pass the seat, duplicate and block rules. Classes and members are plain records that tests and agents must be able to create.

## Questions asked of the input

- Should the seed model separate member and class entities, or keep one flat booking table like the CSV?
  - Default answer: Split into member, gym_class and booking. Booking, class and member rules need real parents.
- What is the 'now' of the world relative to the data?
  - Default answer: 2026-10-07T09:00:00Z, just after the latest booked_at, so classes through 10-07 are mostly past and later ones are upcoming.
- How is a seat counted, and what happens when a class is full?
  - Default answer: Only booked bookings use seats. A booking into a full class is waitlisted and promoted FIFO by booked_at when a seat is freed by cancel_booking.
- What is the late-cancel window?
  - Default answer: 120 minutes before start, with a late_cancel flag and no fee.
- What is the check-in window and no-show grace?
  - Default answer: Check-in opens 30 minutes before start. Booked members become no_show 15 minutes after start.
- Do no-shows have consequences?
  - Default answer: Yes. Three no-shows block a member from booking new classes (409 member_blocked).
- Can a whole class be cancelled by the studio?
  - Default answer: Yes, through cancel_class. It cancels every booked and waitlisted booking without promotion or a late-cancel flag.
- Do members have names or contact details?
  - Default answer: The CSV has only member_id. Names and emails are generated deterministically, and member_code keeps the original id.
- What is the booking status mix of the CSV?
  - Default answer: Unknown beyond the five values. The plan estimates attended 38, no_show 8, cancelled 14, booked 30, waitlisted 10, and the seed keeps the CSV statuses.

## Left out

- Payments, class packs, memberships and credits
  - Why: The imported data has no pricing. The core value is the booking and waitlist workflow.
- Recurring class schedules and instructor or studio entities
  - Why: Classes are single sessions from the CSV, and instructor and studio are enum fields.
- Notifications such as emails and SMS for waitlist promotion
  - Why: No messaging layer exists, and promotion is visible through booking status.
- Automatic waitlist promotion when capacity is raised through PATCH
  - Why: Promotion happens only through cancel_booking, to keep the rules simple.
- Overlapping-class conflict checks and per-member booking limits
  - Why: The CSV shows no such rule, and duplicates on the same class are enough.
- Authentication and roles
  - Why: Agents act as front-desk staff with full access.

## Proof

The engine check passed: 10 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_8a0229797c5b8cd2277c5fa73dbe2a63c01fdbdf83e42bee4c83270edc9b3d87`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | TID |
|---|---|---|---|---|---|---|
| cancel_members_upcoming_booking | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | `tid_83e6d7a184c10beb905bae8e61140b25c887a0cb658bb4833fd8933ac15a0314` |
| promote_waitlist_for_full_class | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.000 | n/a | `tid_2ed581f268b31aa82705f3879899984611c316c56df56c9faa2f6e14e4829fe3` |
| cancel_class_for_sick_instructor | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | `tid_fc42215a5c95b4508ce7a791e2fc13021d5b035298017d4af57ffcf6f5b70d10` |
| close_cycle_room_on_a_day | hard | 1.000 | 0.000 | 0.500, 0.500, 0.000, 0.000 | n/a | `tid_08a6a6795c854b51daeef6f007ae482be6a2f8e473b8d001c71ed9a9b825da9d` |

Decoys:

- `cancel_members_upcoming_booking` 0.000: cancels another member's booked seat in the same Morning Flow Yoga class instead of M022's booking
- `cancel_members_upcoming_booking` 0.000: cancels M022's upcoming booking correctly, then also cancels another member's booking in the same class
- `promote_waitlist_for_full_class` 0.000: cancels the last waitlisted booking, which frees no seat, instead of M030's booked seat
- `promote_waitlist_for_full_class` 0.000: cancels a different member's booked seat in the same class instead of M030's
- `promote_waitlist_for_full_class` 0.000: cancels M030's booking, then also cancels the promoted waitlister, which promotes the next waitlisted member by mistake
- `promote_waitlist_for_full_class` 0.000: cancels the whole class instead of one booking, which drops every booked and waitlisted member
- `cancel_class_for_sick_instructor` 0.000: cancels each booked booking one by one, which promotes the waitlisted members into seats that stay active, and never cancels the class itself
- `cancel_class_for_sick_instructor` 0.000: cancels the class, but then edits the class capacity as well
- `cancel_class_for_sick_instructor` 0.000: cancels the Morning Flow Yoga class on 9 October by another instructor instead of Dev Malhotra's class on 11 October
- `close_cycle_room_on_a_day` 0.500: cancels the bookings of the cycle-room class one by one and never cancels the class itself
- `close_cycle_room_on_a_day` 0.500: cancels the right class but with a reason that does not mention maintenance
- `close_cycle_room_on_a_day` 0.000: cancels the cycle-room class and also the next class overall, which belongs to another studio
- `close_cycle_room_on_a_day` 0.000: cancels the nearest upcoming class in a different studio instead of the cycle-room class

## Run

Mode: create from csv. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 4.20 | 0.5965 |
| model | 1 | 0.54 | 0.2497 |
| workflow | 1 | 0.49 | 0.2631 |
| seed | 1 | 0.39 | 0.2572 |
| tasks | 1 | 2.36 | 0.4615 |
| Total | 5 | 7.99 | 1.8280 |

Run total: 8.00 minutes, $1.8280.
