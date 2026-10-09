# WorldGen report: Acuity Scheduling-style clinic appointments API

A clinic scheduling API. Doctors publish bookable time slots, patients book a slot (no double booking), cancel up to 24 hours before the visit, and staff record no-shows and completed visits. The core value is stateful records (slots and appointments) that an agent reads and changes through actions, so the request is feasible.

## What was built

Entities (4):

- `doctor`: 6 seeded rows
- `patient`: 30 seeded rows
- `slot`: 30 seeded rows
- `appointment`: 20 seeded rows

Routes (11):

- `list_doctors`: GET /doctors
- `get_doctor`: GET /doctors/{id}
- `create_doctor`: POST /doctors
- `list_patients`: GET /patients
- `get_patient`: GET /patients/{id}
- `create_patient`: POST /patients
- `list_slots`: GET /slots
- `get_slot`: GET /slots/{id}
- `create_slot`: POST /slots
- `list_appointments`: GET /appointments
- `get_appointment`: GET /appointments/{id}

Actions (4):

- `book_appointment`: POST /appointments
- `cancel_appointment`: POST /appointments/{id}/cancel
- `mark_no_show`: POST /appointments/{id}/no-show
- `complete_appointment`: POST /appointments/{id}/complete

Jobs: none.

## Assumed and why

- Clock starts at 2026-10-09T08:00:00Z with tick 0s, so time moves only by explicit advance.
  - Why: Deterministic time keeps the 24-hour rule and visit-start checks reproducible; the input gives no timezone, so UTC is used.
- A slot holds at most one booked appointment. The slot state moves open to booked on book and booked to open on cancel; a second booking of a booked slot is refused by book_appointment with 409 slot_taken.
  - Why: The input requires no double booking; a state field makes the slot's occupancy explicit and checkable.
- cancel_appointment refuses when the slot starts less than 24 hours from now, with 409 cancel_too_late. The limit is measured to slot start.
  - Why: The input says cancellation is allowed up to 24 hours before the visit.
- book_appointment refuses a slot whose start has already passed with 409 slot_in_past, and allows a slot starting exactly now.
  - Why: A booking for a visit that has started is meaningless; allowing equality lets tests create a visit that starts at engine time without any time arithmetic.
- mark_no_show and complete_appointment refuse a visit that has not started (now before starts_at) with 409 visit_not_started. mark_no_show adds one to patient.no_show_count.
  - Why: No-show tracking needs a per-patient count, and an outcome can only be recorded after the visit time.
- cancel, no-show and complete act only on booked appointments; otherwise they refuse with 409 invalid_state. cancelled, no_show and completed are final, declared by the status state with no outgoing transitions.
  - Why: Final outcomes must not be overwritten; the state machine enforces it at the data level.
- Action success statuses: book_appointment 201; cancel_appointment, mark_no_show and complete_appointment 200.
  - Why: Creating a booking is a create; the other actions update an existing appointment.
- Test and seed times are fixed: tests create slots in 2030 for visits in the future, and use starts_at equal to ctx.now() for visits that have started. No test relies on ctx.advance.
  - Why: The tests must hold from any engine time and must not depend on arithmetic on ISO strings; the two cases need only now or a far-future time.
- No authentication or roles: any caller may book, cancel or record outcomes for any patient.
  - Why: The input names no roles; permission modelling would be an invented feature.
- Slots are published manually through POST /slots, not generated from doctor schedules.
  - Why: The input names time slots, not working hours or recurrence.
- Seed names listed in tasks (Ruth Adeyemi, Daniel Kowalski, Mei Tanaka, Grant Holloway, Ines Castillo and the six doctors) must exist in the seed.
  - Why: Task instructions name people by name, not by id, so the seed must hold those rows.
- patient.email is unique and nullable; doctor.specialty is a fixed enum of four values.
  - Why: Unique emails let agents find a patient; the enum keeps the schema small.
- Test-created names use the prefix 'QA ' and emails end in example.test, and test slots use 2030 or starts_at equal to ctx.now().
  - Why: Keeps test values clear of seed values, so the seed-collision check passes.

## Questions asked of the input

- Who may cancel or record an outcome: the patient, the clinic staff, or anyone?
  - Default answer: Anyone; there is no authentication in this world.
- Is the 24-hour cancellation limit measured to slot start or to slot end?
  - Default answer: To slot start.
- Does a no-show block the patient from booking again?
  - Default answer: No; no_show_count is tracked but booking is not restricted.
- Which time zone do clinic times use?
  - Default answer: UTC, since the input names no zone.
- Are slots created by hand or generated from doctor working hours?
  - Default answer: Created by hand through POST /slots.
- Can a patient hold several appointments with the same doctor at once?
  - Default answer: Yes, as long as the slots differ.

## Left out

- Authentication, roles and per-clinic permissions
  - Why: The input names no roles, and inventing them would add behavior the request does not ask for.
- Reminders, notifications and email or SMS delivery
  - Why: Messaging is not stateful records an agent changes through the API.
- Billing, copays and insurance
  - Why: The input covers scheduling and no-shows only.
- Rescheduling a booked appointment to a new slot
  - Why: The input does not ask for it; cancel and rebook cover the case.
- Recurring schedules, doctor leave and slot generation from working hours
  - Why: The input names time slots directly.
- Clinical notes and medical records
  - Why: Outside scheduling and no-show tracking.

## Proof

The engine check passed: 8 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_28c50397e9a436d048e4d96d6416bdf71ec911154502e3032b169fd253e464d1`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| book_earliest_open_slot | easy | 1.000 | 0.000 | 0.000 | n/a | declared (2); mutants 2/8 | `tid_43d2fbd69294651714aa8db667e9984d1623df650219f6d2e1705a9126b44120` |
| record_missed_visit | medium | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (2); mutants 3/8 | `tid_0feb17ff451cf3f4ad53519c1563c0c5946dcb0fb81d1caa63f5f2e945ce7a65` |
| swap_freed_slot | hard | 1.000 | 0.000 | 0.500, 0.000 | 0.500 | declared (3); mutants 4/8 | `tid_627e5b0c7d3e90fcb15c640e2d7548e9abb8bf4c1d15a7e9bc915e9f9b60a36d` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `book_earliest_open_slot` 0.000: books the latest open slot of Dr Hannah Lind instead of the earliest one that has not started
- `record_missed_visit` 0.000: marks Mei Tanaka's missed visit with the same doctor the same day instead of Daniel's visit
- `record_missed_visit` 0.000: marks both Daniel's and Mei's missed visits, changing a visit the instruction does not name
- `swap_freed_slot` 0.500: tries to book Ines into the slot before cancelling Grant, is refused with slot_taken, then cancels Grant and stops, so Ines stays unbooked
- `swap_freed_slot` 0.000: cancels Grant's visit and books Ines into a different open slot of Dr Sayed instead of the freed one

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| book_earliest_open_slot | easy | 2 | none | slot | state: met |
| record_missed_visit | medium | 2 | none | appointment | distractors: met; state: met |
| swap_freed_slot | hard | 3 | none | slot | hard: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Acuity Scheduling-style clinic appointments API, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 4.94 | 0.0526 |
| model | 1 | 0.46 | 0.0194 |
| workflow | 1 | 0.49 | 0.0080 |
| seed | 1 | 1.44 | 0.0154 |
| tasks | 1 | 2.56 | 0.0259 |
| Total | 6 | 9.89 | 0.1212 |

Run total: 9.90 minutes, $0.1212.
