# WorldGen report: Jane App / Zocdoc-style clinic appointment scheduling API

A single-clinic scheduling system. Doctors publish time slots. Patients book one open slot at a time, so a slot can never be double booked. A booked appointment can be cancelled only if the visit starts at least 24 hours from now, and cancelling frees the slot. After the visit time the front desk checks patients in and completes them, or marks them as no-show. No-shows are counted per patient, and 3 of them block further booking. Time-based jobs auto-close expired open slots and auto-mark no-shows. The clock moves only through jobs and explicit advances. Every task now declares an allows list, taken from its instruction, that names the entities, change kinds, exact update fields and target rows it may change.

## What was built

Entities (4):

- `doctor`: 8 seeded rows
- `patient`: 60 seeded rows
- `slot`: 342 seeded rows
- `appointment`: 167 seeded rows

Routes (15):

- `list_doctors`: GET /doctors
- `get_doctor`: GET /doctors/{id}
- `create_doctor`: POST /doctors
- `update_doctor`: PATCH /doctors/{id}
- `list_patients`: GET /patients
- `get_patient`: GET /patients/{id}
- `create_patient`: POST /patients
- `update_patient`: PATCH /patients/{id}
- `list_slots`: GET /slots
- `get_slot`: GET /slots/{id}
- `create_slot`: POST /slots
- `update_slot`: PATCH /slots/{id}
- `list_appointments`: GET /appointments
- `get_appointment`: GET /appointments/{id}
- `list_patient_appointments`: GET /patients/{patient_id}/appointments

Actions (5):

- `book_appointment`: POST /slots/{id}/book
- `cancel_appointment`: POST /appointments/{id}/cancel
- `check_in_appointment`: POST /appointments/{id}/check_in
- `complete_appointment`: POST /appointments/{id}/complete
- `mark_no_show`: POST /appointments/{id}/no_show

Jobs (2):

- `close_expired_slots`: every 1h
- `auto_no_show`: every 30m

## Changes

- snippet_changed `tasks.cancel_marias_far_appointment.grader`
- item_changed `tasks.cancel_marias_far_appointment.instruction`
- snippet_changed `tasks.cancel_marias_far_appointment.solution`
- snippet_changed `tasks.clear_dr_patel_calendar_for_leave.grader`
- item_changed `tasks.clear_dr_patel_calendar_for_leave.instruction`

## Assumed and why

- Single clinic, single timezone (UTC). All datetimes are UTC ISO 8601.
  - Why: The input mentions one clinic. Multi-location or timezone logic would add noise without testing the rules.
- The 24-hour cancellation cutoff is measured from engine time (ctx.now) to slot.starts_at. Exactly 24h is still allowed.
  - Why: 'Up to 24 hours before' reads as inclusive. Engine time keeps it deterministic.
- Slots are 30 minutes and are modelled as an explicit slot entity with a status, not computed from doctor availability rules.
  - Why: The input says 'time slots'. A status field makes the no-double-booking rule enforceable and visible.
- Double booking means two appointments on one slot. A patient also cannot hold two overlapping live appointments.
  - Why: Both readings are plausible, and the second protects patients with little extra cost.
- A cancelled appointment reopens its slot, and the appointment row is kept with status cancelled.
  - Why: Real systems keep history, and the freed slot can be rebooked.
- No-show is marked by staff through an action once the start time has passed, and by a job 30 minutes after the slot ends if staff never recorded an outcome.
  - Why: The input asks for no-show tracking without saying who records it. Both paths are common.
- 3 no-shows set patient.booking_blocked = true, and booking is refused for that patient.
  - Why: 'No-show tracking' implies a consequence. 3 is a common clinic policy and gives tasks a checkable threshold.
- No authentication or roles. Every caller can do every operation.
  - Why: The input has no roles, and the engine's public API is the only interface.
- Appointment status, patient counters and the block flag are readonly. They change only through actions and jobs.
  - Why: This keeps the rules from being bypassed with a plain PATCH. The decoys will try exactly that.
- Money, billing, insurance and visit notes are not modelled.
  - Why: The input asks only about scheduling, cancellation and no-shows.
- The clock starts 2026-10-06T09:00Z, not 08:00Z.
  - Why: Slots begin at 09:00 and check-in opens 30 minutes before a visit, so at 08:00 no slot is inside the window and the seed has no checked_in appointment. At 09:00 the nine checked_in appointments exist. The seed is relative to the clock, so no slot or appointment changes its offset from now.
- Seed slots follow ISO weekdays and 09:00-17:00 business hours. Maria's near cancellation anchor is on the same working day; the far anchor is on a later working day.
  - Why: The clock-only correction left 105 weekend slots and one outside business hours. Restore the previously qualified calendar seed without changing the current clock, actions or graders.
- The plan has no field for allows, so each task's intent states its allows list (entity, kind, exact fields, where). The tasks stage writes it as the allows property on every task, with no change to tasks' graders, solutions or decoys.
  - Why: The request asks only for allows declared from each instruction. The seed, entities, routes, actions and jobs stay as they are.
- Allows 'where' values use seed values of the target rows (status, patient_id, doctor_id), and a solution's own side effects such as the slot reopening on cancel are listed as separate allowed changes.
  - Why: The engine matches where against seed values for updates and end values for creates, and the allowed set must come from the instruction, not from what the solution writes.
- cancel_marias_far_appointment requires cancel_reason to contain 'rescheduling'; clear_dr_patel_calendar_for_leave requires it to contain 'doctor on leave'. Both are stated in the instruction and checked case-insensitively by the grader.
  - Why: The free-text gate needs the graders to read appointment.cancel_reason against text the instruction gives.

## Questions asked of the input

- Which timezone do slots and the 24-hour cancellation window use?
  - Default answer: UTC everywhere.
- Is a cancellation exactly 24 hours before the visit allowed?
  - Default answer: Yes. At least 24 hours is allowed, and anything less is refused with 409.
- Who can cancel and mark no-shows, patients or staff?
  - Default answer: No roles. Anyone calling the API can. The cancel rule is the same for everyone.
- What happens to a no-show patient?
  - Default answer: The count goes up, and at 3 no-shows booking_blocked becomes true and new bookings are refused.
- Can a blocked patient be unblocked?
  - Default answer: Not in this world. It is out of scope, and a blocked patient stays blocked.
- Should the system auto-mark no-shows, or only staff?
  - Default answer: Both. Staff can mark one after the start time, and a job marks any unrecorded booking 30 minutes after the slot ends.
- Is rescheduling supported?
  - Default answer: No. A patient cancels, if allowed, and books another slot.
- Do slots have a fixed length, and can doctors have overlapping slots?
  - Default answer: Seed slots are 30 minutes and do not overlap. create_slot refuses an overlap for the same doctor.
- Can one patient hold overlapping appointments with different doctors?
  - Default answer: No. Booking is refused with 409 patient_conflict.
- How narrow should each allows where be, since a where matches field values and not row ids?
  - Default answer: Use the narrowest seed field values the instruction implies (status, patient_id, doctor_id). The grader's own guards pin the exact rows, and the allows guard only rules out changes outside the instruction.

## Left out

- Rescheduling as a single operation
  - Why: It is cancel plus book. Doing it in one call would hide the 24h rule the tasks test.
- Unblocking patients and waiting lists
  - Why: They need roles or policy not in the input.
- Authentication, roles and audit of who acted
  - Why: The input names no users or permissions.
- Billing, insurance, visit notes and prescriptions
  - Why: Not scheduling, and not asked for.
- Reminders, email and SMS delivery
  - Why: The engine has no outbound channel, and notifications are not graded state.
- Multiple clinics, rooms, recurring availability rules and timezones
  - Why: They add complexity without testing booking, cancellation or no-shows.
- Changes to entities, routes, actions, jobs, seed or the clock
  - Why: The request only adds allows lists to tasks.

## Proof

The engine check passed: 6 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_b23e23658a8e42438c46f4a4a3790577ad5194902e0e87c144b1b8c00c1e136e`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_marias_far_appointment | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (2); mutants 3/8 | `tid_b4e1a5bb09b62729c6bf60cdc200f3087ecafe07eece7213b8949e250d3fc7ea` |
| book_earliest_cardiology_slot | medium | 1.000 | 0.000 | 0.000, 0.000, 0.500, 0.000 | n/a | declared (2); mutants 7/8 | `tid_199c243f462fa0f3cbb0a3075bb9e422511f56878de8a3d1b0b61e88b5eda4a4` |
| record_yesterdays_no_shows | hard | 1.000 | 0.000 | 0.700, 0.000, 0.000 | 0.967 | declared (2); mutants 3/8 | `tid_2ef5d61ee9b684e329d4bfd24e2fd7d61e4ff7115c2acd8862968dcbc191d56e` |
| clear_dr_patel_calendar_for_leave | hard | 1.000 | 0.000 | 0.667, 0.578, 0.912, 0.000, 0.690, 0.000 | 0.990 | declared (3); mutants 3/8 | `tid_9d02d7002371a2c4e5e9e1fde1f8e5877857650641c883dfae4fe5effb33c865` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_marias_far_appointment` 0.000: cancels Maria's far appointment, then also cancels the latest booked appointment in the whole clinic, which belongs to someone else
- `cancel_marias_far_appointment` 0.000: cancels Maria's far appointment correctly, then also shifts that slot's start by one minute
- `book_earliest_cardiology_slot` 0.000: ignores the specialty and books the earliest open slot of the first active doctor in the list
- `book_earliest_cardiology_slot` 0.000: takes the last row of an unsorted first page of the cardiologist's open slots instead of the earliest by starts_at
- `book_earliest_cardiology_slot` 0.500: books the correct slot for the right patient but with a different reason than the one requested
- `book_earliest_cardiology_slot` 0.000: books the earliest cardiology slot correctly, then also shifts that slot start by one minute
- `record_yesterdays_no_shows` 0.700: reads only the first page of booked appointments, so it misses part of yesterday's list
- `record_yesterdays_no_shows` 0.000: marks every booked appointment whose start has passed, including the older ones that are not from yesterday
- `record_yesterdays_no_shows` 0.000: records yesterday's no-shows correctly, then also renames one of the affected patients
- `clear_dr_patel_calendar_for_leave` 0.667: deactivates the doctor and cancels the cancellable appointments but leaves her open slots bookable
- `clear_dr_patel_calendar_for_leave` 0.578: cancels and closes slots but never deactivates the doctor
- `clear_dr_patel_calendar_for_leave` 0.912: closes her open slots before cancelling, so the slots freed by the cancellations stay open and bookable
- `clear_dr_patel_calendar_for_leave` 0.000: does everything for Dr. Patel but also closes the open slots of the other general practice doctor
- `clear_dr_patel_calendar_for_leave` 0.690: reads only a short first page of her booked appointments, so most cancellable ones are never cancelled
- `clear_dr_patel_calendar_for_leave` 0.000: clears Dr. Patel's calendar correctly, then also renames her

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_marias_far_appointment | easy | 2 | none | appointment | none declared |
| book_earliest_cardiology_slot | medium | 2 | none | slot | none declared |
| record_yesterdays_no_shows | hard | 53 | appointment | appointment | hard: met |
| clear_dr_patel_calendar_for_leave | hard | 41 | slot | appointment | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.13 | 0.0547 |
| tasks | 1 | 0.34 | 0.2250 |
| Total | 2 | 0.47 | 0.2797 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures

Run total: 0.68 minutes, $0.2797.
