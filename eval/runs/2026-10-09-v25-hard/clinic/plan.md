# WorldGen plan: Jane App / Athenahealth-style clinic scheduling system (doctors, appointments, no-show fees)

A clinic scheduler. Doctors have working hours and a no-show fee, patients book appointments with them, and the engine refuses double-booking of a doctor or a patient. Appointments move through scheduled, checked_in, completed, cancelled and no_show. A no-show posts a fee charge, either from a staff action or from an hourly job that sweeps stale unattended appointments.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `doctor` | A clinician with specialty, working hours (UTC hours) and the no-show fee they charge. | name, specialty, start_hour, end_hour, no_show_fee, active |
| `patient` | A person who books appointments; email is unique. | name, email, phone |
| `appointment` | A booking of one doctor by one patient for a time window; status moves only through actions and the job. | doctor_id, patient_id, starts_at, ends_at, duration_minutes, status, reason, cancel_requested, notes |
| `fee` | A no-show fee charged to a patient for an appointment, written by mark_no_show and the auto_no_show job only. | appointment_id, patient_id, amount, kind |

## Workflows

### appointment_lifecycle (appointment)
- States: scheduled, checked_in, completed, cancelled, no_show
- Actions: book_appointment, reschedule_appointment, cancel_appointment, check_in_appointment, complete_appointment, mark_no_show
- Rules:
  - A doctor or patient cannot have two overlapping scheduled or checked_in appointments; adjacent windows are allowed and cancelled, completed and no_show appointments do not block. Enforced by: book_appointment, reschedule_appointment. Tested by: double_booking_rules
  - Booking requires a future start, an active doctor, and a window inside the doctor's working hours on one day. Enforced by: book_appointment. Tested by: booking_validation
  - Only scheduled appointments can be cancelled, and only before the start time; check-in is allowed only on the start day; completion only from checked_in. Enforced by: cancel_appointment, check_in_appointment, complete_appointment. Tested by: lifecycle_transitions
  - Reschedule works only on scheduled appointments, keeps the duration, may change doctor, and rechecks overlaps and hours. Enforced by: reschedule_appointment. Tested by: reschedule_rules
  - mark_no_show is allowed only on scheduled appointments whose start has passed, sets no_show and posts a fee equal to the doctor's no_show_fee. Enforced by: mark_no_show. Tested by: no_show_refusals
  - The auto_no_show job marks scheduled appointments that ended over 24 hours ago as no_show and posts a fee, once.
  - Patient email is unique. Enforced by the data model: unique constraint on patient.email

## Jobs

- `auto_no_show` runs every 1h: Every scheduled appointment whose ends_at is at least 24 hours before now becomes no_show and gets exactly one fee of the doctor's no_show_fee, unless a fee already exists for it.

## Acceptance tests

### double_booking_rules
- Intent: Overlapping bookings for the same doctor or patient are refused; adjacent and cancelled-freed slots are allowed.
- Actions: book_appointment, cancel_appointment
- Description: Create two doctors and two patients, book, then check doctor and patient overlap refusals, adjacency and slot freeing after cancel.

```js
(ctx) => {
  const mkDoc = (n) => ctx.api('POST', '/doctors', { name: n, specialty: 'general', start_hour: 8, end_hour: 17, no_show_fee: 5000, active: true });
  const d1 = mkDoc('Dr Test One'); const d2 = mkDoc('Dr Test Two');
  ctx.assert(d1.status === 201 && d2.status === 201, 'create doctors: ' + JSON.stringify(d1.body));
  const p1 = ctx.api('POST', '/patients', { name: 'Pat One', email: 'pat.one.dbl@example.com', phone: '555-0101' });
  const p2 = ctx.api('POST', '/patients', { name: 'Pat Two', email: 'pat.two.dbl@example.com', phone: '555-0102' });
  ctx.assert(p1.status === 201 && p2.status === 201, 'create patients: ' + JSON.stringify(p1.body));
  const book = (d, p, t, m) => ctx.api('POST', '/appointments', { doctor_id: d.body.id, patient_id: p.body.id, starts_at: t, duration_minutes: m, reason: 'checkup' });
  const a = book(d1, p1, '2027-03-01T10:00:00.000Z', 30);
  ctx.assert(a.status === 201 && a.body.status === 'scheduled', 'book: ' + JSON.stringify(a.body));
  ctx.assert(a.body.ends_at === '2027-03-01T10:30:00.000Z', 'ends_at computed, got ' + a.body.ends_at);
  const clash = book(d1, p2, '2027-03-01T10:15:00.000Z', 30);
  ctx.assert(clash.status === 409 && clash.body.error.code === 'doctor_unavailable', 'doctor overlap: ' + JSON.stringify(clash.body));
  const pclash = book(d2, p1, '2027-03-01T10:00:00.000Z', 30);
  ctx.assert(pclash.status === 409 && pclash.body.error.code === 'patient_unavailable', 'patient overlap: ' + JSON.stringify(pclash.body));
  const adj = book(d1, p2, '2027-03-01T10:30:00.000Z', 30);
  ctx.assert(adj.status === 201, 'adjacent allowed: ' + JSON.stringify(adj.body));
  const c = ctx.api('POST', '/appointments/' + a.body.id + '/cancel', {});
  ctx.assert(c.status === 200 && c.body.status === 'cancelled', 'cancel: ' + JSON.stringify(c.body));
  const again = book(d1, p2, '2027-03-01T10:00:00.000Z', 30);
  ctx.assert(again.status === 201, 'cancelled frees slot: ' + JSON.stringify(again.body));
}
```
### booking_validation
- Intent: Booking refuses past starts, out-of-hours, inactive doctors, bad durations and unknown rows.
- Actions: book_appointment
- Description: Validation refusals of book_appointment.

```js
(ctx) => {
  const d = ctx.api('POST', '/doctors', { name: 'Dr Valid', specialty: 'dermatology', start_hour: 9, end_hour: 12, no_show_fee: 4000, active: true });
  const off = ctx.api('POST', '/doctors', { name: 'Dr Inactive', specialty: 'dermatology', start_hour: 9, end_hour: 12, no_show_fee: 4000, active: false });
  const p = ctx.api('POST', '/patients', { name: 'Val Patient', email: 'val.patient@example.com', phone: '555-0103' });
  ctx.assert(d.status === 201 && off.status === 201 && p.status === 201, 'setup');
  const book = (did, t, m) => ctx.api('POST', '/appointments', { doctor_id: did, patient_id: p.body.id, starts_at: t, duration_minutes: m, reason: 'visit' });
  const past = book(d.body.id, '2020-01-06T10:00:00.000Z', 30);
  ctx.assert(past.status === 422 && past.body.error.code === 'in_past', 'past: ' + JSON.stringify(past.body));
  const early = book(d.body.id, '2027-03-02T07:00:00.000Z', 30);
  ctx.assert(early.status === 422 && early.body.error.code === 'outside_hours', 'before hours: ' + JSON.stringify(early.body));
  const late = book(d.body.id, '2027-03-02T11:45:00.000Z', 30);
  ctx.assert(late.status === 422 && late.body.error.code === 'outside_hours', 'runs past end: ' + JSON.stringify(late.body));
  const inact = book(off.body.id, '2027-03-02T10:00:00.000Z', 30);
  ctx.assert(inact.status === 409 && inact.body.error.code === 'doctor_inactive', 'inactive: ' + JSON.stringify(inact.body));
  const dur = book(d.body.id, '2027-03-02T10:00:00.000Z', 5);
  ctx.assert(dur.status === 400 && dur.body.error.code === 'input.invalid', 'duration: ' + JSON.stringify(dur.body));
  const unk = book('doc_9999', '2027-03-02T10:00:00.000Z', 30);
  ctx.assert(unk.status >= 400 && unk.status < 500, 'unknown doctor: ' + JSON.stringify(unk.body));
  const ok = book(d.body.id, '2027-03-02T10:00:00.000Z', 60);
  ctx.assert(ok.status === 201, 'valid booking: ' + JSON.stringify(ok.body));
}
```
### lifecycle_transitions
- Intent: Cancel, check-in and complete follow the allowed transitions and timing.
- Actions: book_appointment, cancel_appointment, check_in_appointment, complete_appointment
- Description: Check refusals of out-of-order transitions and double cancel.

```js
(ctx) => {
  const d = ctx.api('POST', '/doctors', { name: 'Dr Life', specialty: 'cardiology', start_hour: 8, end_hour: 17, no_show_fee: 6000, active: true });
  const p = ctx.api('POST', '/patients', { name: 'Life Patient', email: 'life.patient@example.com', phone: '555-0104' });
  const a = ctx.api('POST', '/appointments', { doctor_id: d.body.id, patient_id: p.body.id, starts_at: '2027-04-05T09:00:00.000Z', duration_minutes: 30, reason: 'review' });
  ctx.assert(a.status === 201, 'book: ' + JSON.stringify(a.body));
  const id = a.body.id;
  const ci = ctx.api('POST', '/appointments/' + id + '/check_in', {});
  ctx.assert(ci.status === 409 && ci.body.error.code === 'too_early', 'early check-in: ' + JSON.stringify(ci.body));
  const co = ctx.api('POST', '/appointments/' + id + '/complete', {});
  ctx.assert(co.status === 409 && co.body.error.code === 'invalid_state', 'complete scheduled: ' + JSON.stringify(co.body));
  const c = ctx.api('POST', '/appointments/' + id + '/cancel', {});
  ctx.assert(c.status === 200 && c.body.status === 'cancelled', 'cancel: ' + JSON.stringify(c.body));
  const c2 = ctx.api('POST', '/appointments/' + id + '/cancel', {});
  ctx.assert(c2.status === 409 && c2.body.error.code === 'invalid_state', 'double cancel: ' + JSON.stringify(c2.body));
  const ci2 = ctx.api('POST', '/appointments/' + id + '/check_in', {});
  ctx.assert(ci2.status === 409 && ci2.body.error.code === 'invalid_state', 'check in cancelled: ' + JSON.stringify(ci2.body));
  const nf = ctx.api('POST', '/appointments/apt_9999/cancel', {});
  ctx.assert(nf.status === 404, 'unknown appointment: ' + JSON.stringify(nf.body));
}
```
### reschedule_rules
- Intent: Reschedule moves a scheduled appointment, rechecks conflicts and can change doctor.
- Actions: book_appointment, reschedule_appointment, cancel_appointment
- Description: Move to a free time, refuse conflict, switch doctor, refuse for cancelled.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/doctors', { name: n, specialty: 'pediatrics', start_hour: 8, end_hour: 17, no_show_fee: 3000, active: true });
  const d1 = mk('Dr Move One'); const d2 = mk('Dr Move Two');
  const p1 = ctx.api('POST', '/patients', { name: 'Move One', email: 'move.one@example.com', phone: '555-0105' });
  const p2 = ctx.api('POST', '/patients', { name: 'Move Two', email: 'move.two@example.com', phone: '555-0106' });
  const book = (d, p, t) => ctx.api('POST', '/appointments', { doctor_id: d.body.id, patient_id: p.body.id, starts_at: t, duration_minutes: 30, reason: 'visit' });
  const a = book(d1, p1, '2027-05-03T09:00:00.000Z');
  const b = book(d1, p2, '2027-05-03T11:00:00.000Z');
  ctx.assert(a.status === 201 && b.status === 201, 'setup');
  const mv = ctx.api('POST', '/appointments/' + a.body.id + '/reschedule', { starts_at: '2027-05-03T14:00:00.000Z' });
  ctx.assert(mv.status === 200 && mv.body.starts_at === '2027-05-03T14:00:00.000Z' && mv.body.ends_at === '2027-05-03T14:30:00.000Z' && mv.body.status === 'scheduled', 'move: ' + JSON.stringify(mv.body));
  const cl = ctx.api('POST', '/appointments/' + a.body.id + '/reschedule', { starts_at: '2027-05-03T11:15:00.000Z' });
  ctx.assert(cl.status === 409 && cl.body.error.code === 'doctor_unavailable', 'conflict: ' + JSON.stringify(cl.body));
  const sw = ctx.api('POST', '/appointments/' + a.body.id + '/reschedule', { starts_at: '2027-05-03T11:00:00.000Z', doctor_id: d2.body.id });
  ctx.assert(sw.status === 200 && sw.body.doctor_id === d2.body.id, 'switch doctor: ' + JSON.stringify(sw.body));
  ctx.assert(ctx.api('POST', '/appointments/' + b.body.id + '/cancel', {}).status === 200, 'cancel');
  const dead = ctx.api('POST', '/appointments/' + b.body.id + '/reschedule', { starts_at: '2027-05-03T15:00:00.000Z' });
  ctx.assert(dead.status === 409 && dead.body.error.code === 'invalid_state', 'cancelled: ' + JSON.stringify(dead.body));
}
```
### no_show_refusals
- Intent: mark_no_show refuses future and non-scheduled appointments and writes nothing.
- Actions: book_appointment, cancel_appointment, mark_no_show
- Description: Marking a future appointment or a cancelled one as no-show is refused and no fee is created.

```js
(ctx) => {
  const d = ctx.api('POST', '/doctors', { name: 'Dr NoShow', specialty: 'general', start_hour: 8, end_hour: 17, no_show_fee: 7500, active: true });
  const p = ctx.api('POST', '/patients', { name: 'NoShow Patient', email: 'noshow.patient@example.com', phone: '555-0107' });
  const a = ctx.api('POST', '/appointments', { doctor_id: d.body.id, patient_id: p.body.id, starts_at: '2027-06-07T09:00:00.000Z', duration_minutes: 30, reason: 'visit' });
  ctx.assert(a.status === 201, 'book: ' + JSON.stringify(a.body));
  const early = ctx.api('POST', '/appointments/' + a.body.id + '/mark_no_show', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'too_early', 'future: ' + JSON.stringify(early.body));
  ctx.assert(ctx.api('POST', '/appointments/' + a.body.id + '/cancel', {}).status === 200, 'cancel');
  const dead = ctx.api('POST', '/appointments/' + a.body.id + '/mark_no_show', {});
  ctx.assert(dead.status === 409 && dead.body.error.code === 'invalid_state', 'cancelled: ' + JSON.stringify(dead.body));
  const fees = ctx.api('GET', '/fees?patient_id=' + p.body.id);
  ctx.assert(fees.status === 200 && fees.body.data.length === 0, 'no fee written');
  const nf = ctx.api('POST', '/appointments/apt_9999/mark_no_show', {});
  ctx.assert(nf.status === 404, 'unknown: ' + JSON.stringify(nf.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_doctors` | GET | /doctors | List doctors, filter by specialty and active, search by name. |
| `get_doctor` | GET | /doctors/{id} | Fetch one doctor. |
| `create_doctor` | POST | /doctors | Add a doctor. |
| `update_doctor` | PATCH | /doctors/{id} | Edit hours, fee or active flag. |
| `list_patients` | GET | /patients | List patients, search by name or email. |
| `get_patient` | GET | /patients/{id} | Fetch one patient. |
| `create_patient` | POST | /patients | Register a patient. |
| `update_patient` | PATCH | /patients/{id} | Edit patient contact details. |
| `list_appointments` | GET | /appointments | List appointments, filter by doctor_id, patient_id, status, cancel_requested; sort by starts_at. |
| `get_appointment` | GET | /appointments/{id} | Fetch one appointment. |
| `list_fees` | GET | /fees | List fees, filter by patient_id, appointment_id. |
| `get_fee` | GET | /fees/{id} | Fetch one fee. |

## Seed

- Rows per entity: doctor: 6, patient: 30, appointment: 40, fee: 5
- Mix: Appointments span about two weeks around the clock start. 20 are scheduled: 9 started earlier today or yesterday and are still scheduled, within 24h so the job has not swept them, of which 3 have cancel_requested true. 8 are future scheduled with 3 of those cancel_requested true. 3 are future cancel_requested rows on near-miss patients. Some notes carry misleading text such as 'patient called, arrived' on a scheduled past row. Two patients share near-duplicate names. One doctor is inactive. One doctor's schedule has free slots for reschedule tasks. A fee row exists for each seeded no_show row.
- State mix: appointment: scheduled 50%, checked_in 5%, completed 20%, cancelled 15%, no_show 10%

## Tasks

- `cancel_patient_upcoming` (easy, irreversible): Cancel the single upcoming scheduled appointment of a named patient (a near-duplicate-named patient also exists), changing nothing else.
  - Actions: `cancel_appointment`
  - Decoy idea: Cancels the upcoming appointment of the near-duplicate-named patient.
- `move_to_other_doctor` (medium, misleading_text): A named doctor's patient's scheduled appointment must move to a stated new time with a different, active doctor of the same specialty who is free then. Notes on rows are misleading and must be ignored; go by fields.
  - Actions: `reschedule_appointment`
  - Decoy idea: Picks a doctor of another specialty or an inactive or busy doctor, or follows a note, or books anew and cancels the old.
  - Pressure: seeded rows in appointment.scheduled; distractor rows of appointment
- `settle_backlog` (hard, time_sensitive): Using the current time: mark as no_show every still-scheduled appointment whose start has passed, and cancel every future scheduled appointment with cancel_requested true. Leave checked_in, future non-flagged rows and past rows with misleading notes like 'patient called, arrived' decided by the fields. Past rows that are cancel_requested still become no_show. The rows span more than one list page.
  - Actions: `mark_no_show`, `cancel_appointment`
  - Decoy idea: Reads only the first page, cancels cancel_requested rows whose start has already passed or ignores the cutoff, or follows the notes.
  - Pressure: paging past the first page of appointment; seeded rows in appointment.scheduled, appointment.checked_in; distractor rows of appointment

## Open questions

- Should a late cancellation (under 24h) also be charged a fee?
  - Default answer: No; only no-shows are charged.
- Should a patient be allowed overlapping appointments with different doctors?
  - Default answer: No; patients cannot be double-booked.
- Do clinic hours vary by weekday?
  - Default answer: No; each doctor has one daily start and end hour in UTC.

## Assumptions

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

## Out of scope

- Insurance, billing payments, prescriptions and medical records
  - Why: Not needed for scheduling and fee rules.
- Recurring appointments, waitlists, rooms and time zones
  - Why: Adds complexity without changing the core booking and no-show rules.
- Authentication and staff roles
  - Why: The API is used by a single trusted staff client.

## Changes

None. The plan changes no existing item.
