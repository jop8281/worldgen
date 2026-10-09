# WorldGen report: Jane App / Athenahealth-style clinic scheduling system (doctors, appointments, no-show fees)

A clinic scheduler. Doctors have working hours and a no-show fee, patients book appointments with them, and the engine refuses double-booking of a doctor or a patient. Appointments move through scheduled, checked_in, completed, cancelled and no_show. A no-show posts a fee charge, either from a staff action or from an hourly job that sweeps stale unattended appointments.

## What was built

Entities (4):

- `doctor`: 6 seeded rows
- `patient`: 30 seeded rows
- `appointment`: 40 seeded rows
- `fee`: 5 seeded rows

Routes (12):

- `list_doctors`: GET /doctors
- `get_doctor`: GET /doctors/{id}
- `create_doctor`: POST /doctors
- `update_doctor`: PATCH /doctors/{id}
- `list_patients`: GET /patients
- `get_patient`: GET /patients/{id}
- `create_patient`: POST /patients
- `update_patient`: PATCH /patients/{id}
- `list_appointments`: GET /appointments
- `get_appointment`: GET /appointments/{id}
- `list_fees`: GET /fees
- `get_fee`: GET /fees/{id}

Actions (6):

- `book_appointment`: POST /appointments
- `reschedule_appointment`: POST /appointments/{id}/reschedule
- `cancel_appointment`: POST /appointments/{id}/cancel
- `check_in_appointment`: POST /appointments/{id}/check_in
- `complete_appointment`: POST /appointments/{id}/complete
- `mark_no_show`: POST /appointments/{id}/mark_no_show

Jobs (1):

- `auto_no_show`: every 1h

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded history is before it, planned appointments after it.
  - Why: Time moves only explicitly, so past-start vs future cutoffs are deterministic.
- Working hours are whole UTC hours (start_hour, end_hour) and an appointment must fit within one day's hours.
  - Why: Keeps the scheduling check simple and deterministic.
- Appointments are 15 to 120 minutes; ends_at is computed from starts_at and duration_minutes.
  - Why: Avoids client-computed inconsistent windows.
- Double-booking means any overlap with a scheduled or checked_in appointment for the same doctor or the same patient; completed, cancelled and no_show do not block. Adjacent windows are allowed.
  - Why: Standard half-open interval semantics.
- The no-show fee equals the doctor's no_show_fee at the time of marking; late cancellation is free.
  - Why: Single fee rule keeps the model simple.
- mark_no_show is allowed once the start time has passed; the job auto-marks scheduled appointments 24h after their end.
  - Why: Staff can act promptly while the job catches missed ones.
- Acceptance tests cannot advance the clock, so time-dependent no-show fee creation is exercised by tasks on seeded past rows and only refusals are tested.
  - Why: Tests only use ctx.api and ctx.assert and cannot create past appointments.
- Dates in acceptance tests are in 2027 and use freshly created doctors and patients.
  - Why: Avoid collisions with the seed.
- Standard routes cover doctors, patients and read access to appointments and fees; appointment writes go only through actions.
  - Why: Status and window rules cannot be bypassed.
- The easy task cancel_patient_upcoming declares no pressure claim; its near-duplicate-named patient remains a decoy only.
  - Why: The patient list distractor claim was not shown by the reference trace, so it is dropped.

## Questions asked of the input

- Should a late cancellation (under 24h) also be charged a fee?
  - Default answer: No; only no-shows are charged.
- Should a patient be allowed overlapping appointments with different doctors?
  - Default answer: No; patients cannot be double-booked.
- Do clinic hours vary by weekday?
  - Default answer: No; each doctor has one daily start and end hour in UTC.

## Left out

- Insurance, billing payments, prescriptions and medical records
  - Why: Not needed for scheduling and fee rules.
- Recurring appointments, waitlists, rooms and time zones
  - Why: Adds complexity without changing the core booking and no-show rules.
- Authentication and staff roles
  - Why: The API is used by a single trusted staff client.

## Proof

The engine check passed: 5 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_90f5d07ab9ef187eb7cc9bb4b0c98eb492a9b8991ed555f729a8ee10467b26a6`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_patient_upcoming | easy | 1.000 | 0.000 | 0.000, 0.600 | 0.600 | declared (2); mutants 5/8 | `tid_8d40b28c931a528ca74d1ad0ba4359e979888fd83fb4eae431cddecdb7f27409` |
| move_to_other_doctor | medium | 1.000 | 0.000 | 0.400, 0.400, 0.000 | n/a | declared (1); mutants 5/8 | `tid_81568cd12e375ff3104cd0f1bb71665208c2a17c5adfec0d2d11da254d25a2d5` |
| settle_backlog | hard | 1.000 | 0.000 | 0.500, 0.500, 0.500, 0.000 | 0.500 | declared (2); mutants 4/8 | `tid_a3f654e1d1063e7bba9c29789db32b7010b9c8bb21d7ed33c65d65fced15f76a` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_patient_upcoming` 0.000: acts on the near-duplicate patient Maria Gonzales: cancels her appointment and changes her phone instead of Maria Gonzalez
- `cancel_patient_upcoming` 0.600: cancels the correct appointment but forgets to update the phone number
- `move_to_other_doctor` 0.400: moves the appointment to the new time but keeps Dr. Fischer, ignoring the requirement to change doctor
- `move_to_other_doctor` 0.400: picks a free active doctor of a different specialty (dermatology) instead of another general-practice doctor
- `move_to_other_doctor` 0.000: follows the misleading note 'Patient phoned to cancel' and the cancel flag by cancelling the appointment instead of moving it
- `settle_backlog` 0.500: reads only the first page of the by-start list, so it marks the past no-shows but never reaches the later future cancel_requested appointments
- `settle_backlog` 0.500: trusts the misleading note 'patient called, arrived' and skips those past scheduled appointments instead of marking them no_show
- `settle_backlog` 0.500: ignores the time cutoff for flagged rows: tries to cancel every cancel_requested appointment, so flagged past rows are refused and never marked no_show
- `settle_backlog` 0.000: cancels every future scheduled appointment instead of only the cancel_requested ones, causing collateral cancellations

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_patient_upcoming | easy | 2 | none | none | none declared |
| move_to_other_doctor | medium | 1 | none | appointment | distractors: met; state: met |
| settle_backlog | hard | 24 | appointment | appointment | hard: met; paging: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Jane App / Athenahealth-style clinic scheduling system (doctors, appointments, no-show fees), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 2.64 | 0.4797 |
| model | 2 | 0.42 | 0.2112 |
| workflow | 2 | 0.62 | 0.2461 |
| seed | 2 | 1.04 | 0.2814 |
| tasks | 3 | 4.89 | 0.8835 |
| Total | 11 | 9.62 | 2.1019 |

Backtracks:

- `tasks` to `plan`: 1 issue

Run total: 9.64 minutes, $2.1019.
