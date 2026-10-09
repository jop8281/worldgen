# WorldGen plan: Acuity Scheduling-style clinic appointments API

A clinic scheduling API. Doctors publish bookable time slots, patients book a slot (no double booking), cancel up to 24 hours before the visit, and staff record no-shows and completed visits. The core value is stateful records (slots and appointments) that an agent reads and changes through actions, so the request is feasible.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T08:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `doctor` | A clinician who offers slots. Specialty is a fixed enum. | name, specialty, active |
| `patient` | A person who books visits. no_show_count is kept by mark_no_show. | name, email, no_show_count |
| `slot` | A bookable time window with one doctor. Its state says whether a patient holds it. | doctor_id, starts_at, ends_at, status |
| `appointment` | A patient's booking of one slot, with its outcome. | patient_id, slot_id, status, cancelled_at |

## Workflows

### appointment_outcome (appointment)
- States: booked, cancelled, no_show, completed
- Actions: book_appointment, cancel_appointment, mark_no_show, complete_appointment
- Rules:
  - cancel_appointment refuses when the slot starts less than 24 hours from now (409 cancel_too_late) Enforced by: cancel_appointment. Tested by: cancel_within_24h_refused
  - mark_no_show refuses before the visit starts (409 visit_not_started) and otherwise adds one to the patient's no_show_count Enforced by: mark_no_show. Tested by: no_show_after_visit_start
  - complete_appointment refuses before the visit starts (409 visit_not_started) Enforced by: complete_appointment. Tested by: complete_only_after_visit
  - cancel, no-show and complete act only on booked appointments, otherwise 409 invalid_state Enforced by: cancel_appointment, mark_no_show, complete_appointment. Tested by: final_states_refuse
  - cancelled, no_show and completed are final: the status state declares no transition out of them, so any later move is refused with state.transition Enforced by the data model: The status state field lists the transitions; cancelled, no_show and completed map to empty lists, so the data model refuses any later write to them.
  - book_appointment refuses a slot whose start has passed (409 slot_in_past) and a patient_id or slot_id that does not resolve (422 ref.unresolved)
### slot_occupancy (slot)
- States: open, booked
- Actions: book_appointment, cancel_appointment
- Rules:
  - a slot holds at most one booked appointment: a second booking of a booked slot is refused with 409 slot_taken Enforced by: book_appointment. Tested by: no_double_booking
  - cancelling a booked appointment reopens its slot Enforced by: cancel_appointment. Tested by: cancel_frees_slot

## Jobs

None. The plan declares no job.

## Acceptance tests

### book_creates_booked_appointment
- Intent: A booking creates a booked appointment and marks its slot booked.
- Actions: book_appointment
- Description: Create a doctor, a patient and a slot through the API, book the slot, and check the appointment, the slot state and an unknown appointment id.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Alder', specialty: 'general' }); ctx.assert(doc.status === 201, 'create doctor ' + doc.status); const pat = ctx.api('POST', '/patients', { name: 'QA Patient Alder', email: 'qa.alder@example.test' }); ctx.assert(pat.status === 201, 'create patient ' + pat.status); const slot = ctx.api('POST', '/slots', { doctor_id: doc.body.id, starts_at: '2030-01-15T10:00:00.000Z', ends_at: '2030-01-15T10:30:00.000Z' }); ctx.assert(slot.status === 201 && slot.body.status === 'open', 'new slot is open: ' + JSON.stringify(slot.body)); const r = ctx.api('POST', '/appointments', { patient_id: pat.body.id, slot_id: slot.body.id }); ctx.assert(r.status === 201, 'book: ' + r.status + ' ' + JSON.stringify(r.body)); ctx.assert(r.body.status === 'booked' && r.body.patient_id === pat.body.id && r.body.slot_id === slot.body.id, 'booked appointment: ' + JSON.stringify(r.body)); const s = ctx.api('GET', '/slots/' + slot.body.id); ctx.assert(s.status === 200 && s.body.status === 'booked', 'slot is booked: ' + JSON.stringify(s.body)); const missing = ctx.api('GET', '/appointments/apt_9999'); ctx.assert(missing.status === 404 && missing.body.error.code === 'row.not_found', 'missing appointment: ' + JSON.stringify(missing.body)); }
```
### no_double_booking
- Intent: A slot already held by a booking cannot be booked again.
- Actions: book_appointment
- Description: Book a slot for one patient, then refuse a second patient for the same slot with 409 slot_taken and leave the slot booked.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Birch', specialty: 'cardiology' }).body; const a = ctx.api('POST', '/patients', { name: 'QA Patient Birch A', email: 'qa.birch.a@example.test' }).body; const b = ctx.api('POST', '/patients', { name: 'QA Patient Birch B', email: 'qa.birch.b@example.test' }).body; const slot = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: '2030-01-16T10:00:00.000Z', ends_at: '2030-01-16T10:30:00.000Z' }).body; ctx.assert(ctx.api('POST', '/appointments', { patient_id: a.id, slot_id: slot.id }).status === 201, 'first booking'); const second = ctx.api('POST', '/appointments', { patient_id: b.id, slot_id: slot.id }); ctx.assert(second.status === 409 && second.body.error.code === 'slot_taken', 'second booking refused: ' + JSON.stringify(second.body)); ctx.assert(ctx.api('GET', '/slots/' + slot.id).body.status === 'booked', 'slot still booked'); }
```
### slot_list_reflects_booking
- Intent: The slot list filters show a booked slot as booked, and the patient's appointment list shows the booking.
- Actions: book_appointment
- Description: Create a doctor, a patient and a slot, check the slot is listed as open, book it, then check the booked filter and the patient's appointment list.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Cedar', specialty: 'pediatrics' }).body; const pat = ctx.api('POST', '/patients', { name: 'QA Patient Cedar', email: 'qa.cedar@example.test' }).body; const slot = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: '2030-01-17T10:00:00.000Z', ends_at: '2030-01-17T10:30:00.000Z' }).body; const open = ctx.api('GET', '/slots?doctor_id=' + doc.id + '&status=open'); ctx.assert(open.status === 200 && open.body.data.some((s) => s.id === slot.id), 'new slot listed as open'); ctx.assert(ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: slot.id }).status === 201, 'book'); const booked = ctx.api('GET', '/slots?doctor_id=' + doc.id + '&status=booked'); ctx.assert(booked.status === 200 && booked.body.data.length === 1 && booked.body.data[0].id === slot.id, 'only our slot is booked for this doctor'); const appts = ctx.api('GET', '/appointments?patient_id=' + pat.id); ctx.assert(appts.status === 200 && appts.body.data.length === 1 && appts.body.data[0].status === 'booked', 'patient list shows the booking'); }
```
### cancel_frees_slot
- Intent: Cancelling a visit at least 24 hours ahead frees its slot for rebooking, and a cancelled appointment cannot be cancelled again.
- Actions: cancel_appointment, book_appointment
- Description: Book a slot starting in 2030, cancel it and check the cancelled_at time and the reopened slot, refuse a second cancel with 409 invalid_state, and rebook the freed slot for another patient.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Dogwood', specialty: 'dermatology' }).body; const p1 = ctx.api('POST', '/patients', { name: 'QA Patient Dogwood 1', email: 'qa.dogwood.1@example.test' }).body; const p2 = ctx.api('POST', '/patients', { name: 'QA Patient Dogwood 2', email: 'qa.dogwood.2@example.test' }).body; const slot = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: '2030-01-18T10:00:00.000Z', ends_at: '2030-01-18T10:30:00.000Z' }).body; const appt = ctx.api('POST', '/appointments', { patient_id: p1.id, slot_id: slot.id }).body; const at = ctx.now(); const c = ctx.api('POST', '/appointments/' + appt.id + '/cancel'); ctx.assert(c.status === 200 && c.body.status === 'cancelled' && c.body.cancelled_at === at, 'cancelled at ' + at + ': ' + JSON.stringify(c.body)); ctx.assert(ctx.api('GET', '/slots/' + slot.id).body.status === 'open', 'slot open again'); const again = ctx.api('POST', '/appointments/' + appt.id + '/cancel'); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel: ' + JSON.stringify(again.body)); const rebook = ctx.api('POST', '/appointments', { patient_id: p2.id, slot_id: slot.id }); ctx.assert(rebook.status === 201, 'freed slot rebooked: ' + JSON.stringify(rebook.body)); }
```
### cancel_within_24h_refused
- Intent: A visit that starts within 24 hours cannot be cancelled, and the booking stays as it was.
- Actions: cancel_appointment, book_appointment
- Description: Book a slot that starts now, try to cancel it, and check the refusal with 409 cancel_too_late and that the appointment and slot are unchanged.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Elder', specialty: 'general' }).body; const pat = ctx.api('POST', '/patients', { name: 'QA Patient Elder', email: 'qa.elder@example.test' }).body; const now = ctx.now(); const slot = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: now, ends_at: now }); ctx.assert(slot.status === 201, 'create slot: ' + JSON.stringify(slot.body)); const appt = ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: slot.body.id }); ctx.assert(appt.status === 201, 'book: ' + JSON.stringify(appt.body)); const c = ctx.api('POST', '/appointments/' + appt.body.id + '/cancel'); ctx.assert(c.status === 409 && c.body.error.code === 'cancel_too_late', 'late cancel refused: ' + JSON.stringify(c.body)); ctx.assert(ctx.api('GET', '/appointments/' + appt.body.id).body.status === 'booked', 'still booked'); ctx.assert(ctx.api('GET', '/slots/' + slot.body.id).body.status === 'booked', 'slot still booked'); }
```
### no_show_after_visit_start
- Intent: A no-show is refused before the visit starts and, once it has started, is recorded and counted on the patient.
- Actions: mark_no_show, book_appointment
- Description: Refuse a no-show for a visit starting in 2030 with 409 visit_not_started, then book a slot starting now, mark it no-show, and check the status, the patient's no_show_count of 1 and that the slot stays booked.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Fern', specialty: 'general' }).body; const pat = ctx.api('POST', '/patients', { name: 'QA Patient Fern', email: 'qa.fern@example.test' }).body; const future = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: '2030-01-19T10:00:00.000Z', ends_at: '2030-01-19T10:30:00.000Z' }).body; const early = ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: future.id }).body; const tooEarly = ctx.api('POST', '/appointments/' + early.id + '/no-show'); ctx.assert(tooEarly.status === 409 && tooEarly.body.error.code === 'visit_not_started', 'no-show before the visit: ' + JSON.stringify(tooEarly.body)); ctx.assert(ctx.api('GET', '/appointments/' + early.id).body.status === 'booked', 'still booked after refusal'); const now = ctx.now(); const slot = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: now, ends_at: now }).body; const appt = ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: slot.id }); ctx.assert(appt.status === 201, 'book the slot starting now: ' + JSON.stringify(appt.body)); const ns = ctx.api('POST', '/appointments/' + appt.body.id + '/no-show'); ctx.assert(ns.status === 200 && ns.body.status === 'no_show', 'no-show recorded: ' + JSON.stringify(ns.body)); ctx.assert(ctx.api('GET', '/patients/' + pat.id).body.no_show_count === 1, 'patient no_show_count is 1'); ctx.assert(ctx.api('GET', '/slots/' + slot.id).body.status === 'booked', 'slot stays booked after a no-show'); }
```
### complete_only_after_visit
- Intent: A visit can be completed only once it has started.
- Actions: complete_appointment, book_appointment
- Description: Refuse completion of a visit starting in 2030 with 409 visit_not_started, then complete a visit that starts now and check its status.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Gorse', specialty: 'pediatrics' }).body; const pat = ctx.api('POST', '/patients', { name: 'QA Patient Gorse', email: 'qa.gorse@example.test' }).body; const future = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: '2030-01-20T10:00:00.000Z', ends_at: '2030-01-20T10:30:00.000Z' }).body; const early = ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: future.id }).body; const tooEarly = ctx.api('POST', '/appointments/' + early.id + '/complete'); ctx.assert(tooEarly.status === 409 && tooEarly.body.error.code === 'visit_not_started', 'complete before the visit: ' + JSON.stringify(tooEarly.body)); const now = ctx.now(); const slot = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: now, ends_at: now }).body; const appt = ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: slot.id }).body; const done = ctx.api('POST', '/appointments/' + appt.id + '/complete'); ctx.assert(done.status === 200 && done.body.status === 'completed', 'completed: ' + JSON.stringify(done.body)); }
```
### final_states_refuse
- Intent: Cancelled, no-show and completed appointments cannot move to another outcome.
- Actions: cancel_appointment, complete_appointment, mark_no_show, book_appointment
- Description: Cancel a visit in 2030 and try to complete it, record a no-show on a visit that starts now and try to cancel it; both moves are refused and the statuses stay final.

```js
(ctx) => { const doc = ctx.api('POST', '/doctors', { name: 'QA Dr Hazel', specialty: 'cardiology' }).body; const pat = ctx.api('POST', '/patients', { name: 'QA Patient Hazel', email: 'qa.hazel@example.test' }).body; const future = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: '2030-01-21T10:00:00.000Z', ends_at: '2030-01-21T10:30:00.000Z' }).body; const a = ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: future.id }).body; ctx.assert(ctx.api('POST', '/appointments/' + a.id + '/cancel').status === 200, 'cancel the future visit'); const done = ctx.api('POST', '/appointments/' + a.id + '/complete'); ctx.assert(done.status === 409 && done.body.error.code === 'invalid_state', 'cancelled visit cannot be completed: ' + JSON.stringify(done.body)); const now = ctx.now(); const slot = ctx.api('POST', '/slots', { doctor_id: doc.id, starts_at: now, ends_at: now }).body; const b = ctx.api('POST', '/appointments', { patient_id: pat.id, slot_id: slot.id }).body; ctx.assert(ctx.api('POST', '/appointments/' + b.id + '/no-show').status === 200, 'no-show the visit that started'); const late = ctx.api('POST', '/appointments/' + b.id + '/cancel'); ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'no-show visit cannot be cancelled: ' + JSON.stringify(late.body)); ctx.assert(ctx.api('GET', '/appointments/' + b.id).body.status === 'no_show', 'status stays no_show'); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_doctors` | GET | /doctors | List doctors, filter by specialty and active, search by name. |
| `get_doctor` | GET | /doctors/{id} | Read one doctor. |
| `create_doctor` | POST | /doctors | Add a doctor. |
| `list_patients` | GET | /patients | List patients, search by name and email. |
| `get_patient` | GET | /patients/{id} | Read one patient, including no_show_count. |
| `create_patient` | POST | /patients | Register a patient. |
| `list_slots` | GET | /slots | List slots, filter by doctor_id and status, sort by starts_at. |
| `get_slot` | GET | /slots/{id} | Read one slot. |
| `create_slot` | POST | /slots | Publish a bookable slot for a doctor. |
| `list_appointments` | GET | /appointments | List appointments, filter by status, patient_id and slot_id. |
| `get_appointment` | GET | /appointments/{id} | Read one appointment. |

## Seed

- Rows per entity: doctor: 6, patient: 30, slot: 30, appointment: 20
- Mix: Doctors: Hannah Lind (general), Omar Sayed (cardiology), Priya Nair (pediatrics), Tomas Berg (dermatology), Lucia Ferraro (general), Kwame Mensah (cardiology). Patients include Ruth Adeyemi (no appointments), Daniel Kowalski and Mei Tanaka (booked visits yesterday with Dr Lucia Ferraro, same day, different slots), Grant Holloway (booked visit three days out with Dr Omar Sayed), Ines Castillo (no appointments). Slots start at :30 past the hour, spread from five days before clock.start to five days after, so no seeded slot starts exactly at clock.start. The 16 booked slots match the 16 non-cancelled appointments one to one (6 booked, 6 completed, 4 no_show); the 4 cancelled appointments sit on open slots. Patient no_show_count sums to 4 across patients.
- State mix: slot: open 45%, booked 55%; appointment: booked 30%, completed 30%, no_show 20%, cancelled 20%

## Tasks

- `book_earliest_open_slot` (easy, scarce_resource): Book Ruth Adeyemi into the earliest open slot of Dr Hannah Lind that starts after the current time.
  - Actions: `book_appointment`
  - Decoy idea: Books the latest open slot instead of the earliest one.
  - Pressure: seeded rows in slot.open
- `record_missed_visit` (medium, irreversible): Daniel Kowalski missed his visit yesterday with Dr Lucia Ferraro. Record that visit as a no-show.
  - Actions: `mark_no_show`
  - Decoy idea: Marks Mei Tanaka's missed visit with the same doctor the same day, or marks both missed visits.
  - Pressure: seeded rows in appointment.booked; distractor rows of appointment
- `swap_freed_slot` (hard, scarce_resource): Grant Holloway needs to cancel his appointment with Dr Omar Sayed. Cancel it, then book Ines Castillo into the slot that frees up.
  - Actions: `cancel_appointment`, `book_appointment`
  - Decoy idea: Books Ines into the slot before cancelling Grant, gets slot_taken and leaves Ines unbooked; or cancels Grant and books Ines into a different open slot.
  - Pressure: seeded rows in slot.booked, appointment.booked; distractor rows of slot

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

None. The plan changes no existing item.
