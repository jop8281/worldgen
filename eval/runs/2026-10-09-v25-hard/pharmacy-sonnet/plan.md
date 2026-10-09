# WorldGen plan: Retail pharmacy management system (PioneerRx / QS/1-style): prescriptions, refills, fills, controlled-substance pharmacist verification and lot-level stock with expiry

A pharmacy world. Patients hold prescriptions for medications. Each fill or refill is a fill record. Fills of controlled medications wait in pharmacist review before they can be dispensed. Dispensing draws stock from the earliest-expiring usable lot. Daily jobs expire stock lots and prescriptions that are past their dates. A lot can be quarantined for a recall.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `patient` | A person the pharmacy dispenses to. | name, date_of_birth |
| `medication` | A drug product with strength and schedule (otc, rx, controlled). | name, strength, schedule |
| `pharmacist` | Staff member; only role pharmacist may verify controlled fills. | name, license_number, role |
| `stock_lot` | A received batch of one medication with quantity on hand and an expiry date. | medication_id, lot_number, quantity, expires_on, status |
| `prescription` | A prescriber's order for a patient and medication with a refill allowance and expiry. | patient_id, medication_id, refills_allowed, fills_made, expires_on, status |
| `fill` | One dispensing event (first fill or refill) of a prescription. | prescription_id, fill_number, status, approved_by, lot_id |

## Workflows

### prescription_lifecycle (prescription)
- States: active, completed, cancelled, expired
- Actions: request_fill, cancel_prescription
- Rules:
  - A prescription allows at most refills_allowed + 1 fills; the next request answers 409 refill_limit_reached. Enforced by: request_fill. Tested by: t_refill_limit
  - Cancelling an active prescription rejects its open fills; cancelled or expired prescriptions accept no new fills (409 prescription_not_active). Enforced by: cancel_prescription, request_fill. Tested by: t_cancel_rx
  - The expire_prescriptions job marks active prescriptions past expires_on as expired. Enforced by: expire_prescriptions. Tested by: t_expire_rx_job
  - Dispensing the last allowed fill completes the prescription.
### fill_lifecycle (fill)
- States: pending_review, ready, dispensed, rejected
- Actions: approve_fill, reject_fill, dispense_fill
- Rules:
  - Controlled fills start in pending_review, need approval by a pharmacist-role staff member before they can be dispensed (409 fill_not_ready, 422 not_pharmacist). Enforced by: approve_fill, dispense_fill. Tested by: t_controlled_approval
  - A fill cannot be approved once its prescription has passed expires_on (409 prescription_expired), whatever the prescription status says. Enforced by: approve_fill. Tested by: t_expired_rx_approval
  - Rejecting an open fill needs a pharmacist and a reason, and gives the fill back to the prescription's refill count; dispensed or rejected fills cannot be rejected. Enforced by: reject_fill. Tested by: t_reject_fill
  - Dispensing takes stock from the earliest-expiring available lot that is not expired and holds enough quantity; otherwise 409 insufficient_stock. Enforced by: dispense_fill. Tested by: t_fefo_dispense
### stock_lot_lifecycle (stock_lot)
- States: available, quarantined, expired
- Actions: quarantine_lot
- Rules:
  - Quarantined lots are never used for dispensing; only available lots can be quarantined. Enforced by: quarantine_lot, dispense_fill. Tested by: t_quarantine
  - The expire_lots job marks lots past expires_on as expired, and an expired lot cannot supply a fill. Enforced by: expire_lots. Tested by: t_expire_lots
  - Lot quantity cannot go below zero. Enforced by the data model: stock_lot.quantity has min 0, so the engine refuses any write below it.

## Jobs

- `expire_lots` runs every 1d: Mark every available or quarantined stock lot whose expires_on is at or before now as expired.
- `expire_prescriptions` runs every 1d: Mark every active prescription whose expires_on is at or before now as expired.

## Acceptance tests

### t_refill_limit
- Intent: Fills stop after refills_allowed + 1 requests.
- Actions: request_fill
- Description: A prescription with 1 refill allows two fills and refuses the third.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT Refill Patient', date_of_birth: '1980-01-01' });
  const med = mk('/medications', { name: 'ZZT Refill Med', strength: '10mg', schedule: 'rx' });
  mk('/lots', { medication_id: med.id, lot_number: 'ZZT-RF-1', quantity: 100, expires_on: '2027-06-01T00:00:00.000Z' });
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 1, expires_on: '2027-09-01T00:00:00.000Z' });
  ctx.assert(rx.status === 'active' && rx.fills_made === 0, 'new rx active with 0 fills: ' + JSON.stringify(rx));
  const f1 = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f1.status === 201 && f1.body.status === 'ready' && f1.body.fill_number === 1, 'first fill ready: ' + JSON.stringify(f1));
  const f2 = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f2.status === 201 && f2.body.fill_number === 2, 'refill: ' + JSON.stringify(f2));
  const f3 = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f3.status === 409 && f3.body.error.code === 'refill_limit_reached', 'third fill refused: ' + JSON.stringify(f3));
  const g = ctx.api('GET', '/prescriptions/' + rx.id);
  ctx.assert(g.body.fills_made === 2, 'fills_made is 2, got ' + g.body.fills_made);
}
```
### t_cancel_rx
- Intent: Cancelling rejects open fills and blocks new ones.
- Actions: cancel_prescription, request_fill
- Description: Cancel an active prescription with a ready fill; the fill is rejected and new fills are refused.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT Cancel Patient', date_of_birth: '1975-05-05' });
  const med = mk('/medications', { name: 'ZZT Cancel Med', strength: '20mg', schedule: 'rx' });
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 2, expires_on: '2027-09-01T00:00:00.000Z' });
  const f = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f.status === 201 && f.body.status === 'ready', 'fill ready: ' + JSON.stringify(f));
  const c = ctx.api('POST', '/prescriptions/' + rx.id + '/cancel', {});
  ctx.assert(c.status === 200 && c.body.status === 'cancelled', 'cancel: ' + JSON.stringify(c));
  const g = ctx.api('GET', '/fills/' + f.body.id);
  ctx.assert(g.body.status === 'rejected', 'open fill rejected, got ' + g.body.status);
  const n = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(n.status === 409 && n.body.error.code === 'prescription_not_active', 'no fill on cancelled rx: ' + JSON.stringify(n));
  const again = ctx.api('POST', '/prescriptions/' + rx.id + '/cancel', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second cancel: ' + JSON.stringify(again));
}
```
### t_expire_rx_job
- Intent: The daily job expires prescriptions past their date and blocks new fills.
- Actions: request_fill
- Description: After two days, an rx expiring tomorrow is expired and refuses fills; a long-dated rx stays active.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT ExpRx Patient', date_of_birth: '1990-02-02' });
  const med = mk('/medications', { name: 'ZZT ExpRx Med', strength: '5mg', schedule: 'rx' });
  const soon = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 1, expires_on: '2026-10-10T00:00:00.000Z' });
  const later = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 1, expires_on: '2027-10-01T00:00:00.000Z' });
  const run = ctx.advance('2d');
  ctx.assert(run.jobsFired.includes('expire_prescriptions'), 'job fired: ' + JSON.stringify(run));
  ctx.assert(ctx.api('GET', '/prescriptions/' + soon.id).body.status === 'expired', 'soon rx expired');
  ctx.assert(ctx.api('GET', '/prescriptions/' + later.id).body.status === 'active', 'later rx still active');
  const f = ctx.api('POST', '/prescriptions/' + soon.id + '/fills', {});
  ctx.assert(f.status === 409 && f.body.error.code === 'prescription_not_active', 'expired rx refuses fill: ' + JSON.stringify(f));
}
```
### t_controlled_approval
- Intent: Controlled fills need a pharmacist's approval before dispensing.
- Actions: request_fill, approve_fill, dispense_fill
- Description: A controlled fill starts pending_review, cannot be dispensed, a technician cannot approve, a pharmacist can, then it dispenses.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT Ctrl Patient', date_of_birth: '1968-08-08' });
  const med = mk('/medications', { name: 'ZZT Ctrl Med', strength: '5mg', schedule: 'controlled' });
  mk('/lots', { medication_id: med.id, lot_number: 'ZZT-CT-1', quantity: 100, expires_on: '2027-06-01T00:00:00.000Z' });
  const tech = mk('/pharmacists', { name: 'ZZT Tech', license_number: 'ZZT-T-1', role: 'technician' });
  const ph = mk('/pharmacists', { name: 'ZZT Pharmacist', license_number: 'ZZT-P-1', role: 'pharmacist' });
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 0, expires_on: '2027-09-01T00:00:00.000Z' });
  const f = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f.status === 201 && f.body.status === 'pending_review', 'controlled fill pending_review: ' + JSON.stringify(f));
  const d0 = ctx.api('POST', '/fills/' + f.body.id + '/dispense', {});
  ctx.assert(d0.status === 409 && d0.body.error.code === 'fill_not_ready', 'unapproved dispense refused: ' + JSON.stringify(d0));
  const a0 = ctx.api('POST', '/fills/' + f.body.id + '/approve', { pharmacist_id: tech.id });
  ctx.assert(a0.status === 422 && a0.body.error.code === 'not_pharmacist', 'technician cannot approve: ' + JSON.stringify(a0));
  const a1 = ctx.api('POST', '/fills/' + f.body.id + '/approve', { pharmacist_id: ph.id });
  ctx.assert(a1.status === 200 && a1.body.status === 'ready' && a1.body.approved_by === ph.id, 'pharmacist approves: ' + JSON.stringify(a1));
  const d1 = ctx.api('POST', '/fills/' + f.body.id + '/dispense', {});
  ctx.assert(d1.status === 200 && d1.body.status === 'dispensed', 'dispense: ' + JSON.stringify(d1));
  const a2 = ctx.api('POST', '/fills/' + f.body.id + '/approve', { pharmacist_id: ph.id });
  ctx.assert(a2.status === 409 && a2.body.error.code === 'invalid_state', 'approve again: ' + JSON.stringify(a2));
}
```
### t_expired_rx_approval
- Intent: A fill cannot be approved after its prescription's expiry date.
- Actions: request_fill, approve_fill
- Description: A pending controlled fill whose prescription passes its expiry date cannot be approved.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT ExpAp Patient', date_of_birth: '1971-01-01' });
  const med = mk('/medications', { name: 'ZZT ExpAp Med', strength: '5mg', schedule: 'controlled' });
  mk('/lots', { medication_id: med.id, lot_number: 'ZZT-EA-1', quantity: 100, expires_on: '2027-06-01T00:00:00.000Z' });
  const ph = mk('/pharmacists', { name: 'ZZT ExpAp Pharmacist', license_number: 'ZZT-P-2', role: 'pharmacist' });
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 0, expires_on: '2026-10-20T00:00:00.000Z' });
  const f = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f.status === 201 && f.body.status === 'pending_review', 'pending: ' + JSON.stringify(f));
  ctx.advance('15d');
  const a = ctx.api('POST', '/fills/' + f.body.id + '/approve', { pharmacist_id: ph.id });
  ctx.assert(a.status === 409 && a.body.error.code === 'prescription_expired', 'expired rx approval refused: ' + JSON.stringify(a));
  ctx.assert(ctx.api('GET', '/fills/' + f.body.id).body.status === 'pending_review', 'fill unchanged');
}
```
### t_reject_fill
- Intent: Rejecting an open fill needs a pharmacist and restores the refill count.
- Actions: request_fill, reject_fill
- Description: A pharmacist rejects a pending fill with a reason; fills_made drops back; a second reject is refused.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT Rej Patient', date_of_birth: '1985-09-09' });
  const med = mk('/medications', { name: 'ZZT Rej Med', strength: '5mg', schedule: 'controlled' });
  const tech = mk('/pharmacists', { name: 'ZZT Rej Tech', license_number: 'ZZT-T-3', role: 'technician' });
  const ph = mk('/pharmacists', { name: 'ZZT Rej Pharmacist', license_number: 'ZZT-P-3', role: 'pharmacist' });
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 1, expires_on: '2027-09-01T00:00:00.000Z' });
  const f = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f.status === 201, 'fill: ' + JSON.stringify(f));
  ctx.assert(ctx.api('GET', '/prescriptions/' + rx.id).body.fills_made === 1, 'fills_made 1');
  const t = ctx.api('POST', '/fills/' + f.body.id + '/reject', { pharmacist_id: tech.id, reason: 'Technician attempt' });
  ctx.assert(t.status === 422 && t.body.error.code === 'not_pharmacist', 'technician cannot reject: ' + JSON.stringify(t));
  const r = ctx.api('POST', '/fills/' + f.body.id + '/reject', { pharmacist_id: ph.id, reason: 'Suspected forged prescription' });
  ctx.assert(r.status === 200 && r.body.status === 'rejected' && r.body.rejection_reason === 'Suspected forged prescription', 'rejected: ' + JSON.stringify(r));
  ctx.assert(ctx.api('GET', '/prescriptions/' + rx.id).body.fills_made === 0, 'fills_made restored');
  const again = ctx.api('POST', '/fills/' + f.body.id + '/reject', { pharmacist_id: ph.id, reason: 'again' });
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second reject: ' + JSON.stringify(again));
}
```
### t_fefo_dispense
- Intent: Dispensing uses the earliest-expiring usable lot with enough stock.
- Actions: request_fill, dispense_fill
- Description: Skips a date-expired lot and a too-small lot, uses lots in expiry order, and refuses when no lot has enough stock.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT Fefo Patient', date_of_birth: '1992-04-04' });
  const med = mk('/medications', { name: 'ZZT Fefo Med', strength: '50mg', schedule: 'rx' });
  const lotC = mk('/lots', { medication_id: med.id, lot_number: 'ZZT-FF-C', quantity: 100, expires_on: '2026-10-01T00:00:00.000Z' });
  const lotB = mk('/lots', { medication_id: med.id, lot_number: 'ZZT-FF-B', quantity: 100, expires_on: '2027-06-01T00:00:00.000Z' });
  const lotA = mk('/lots', { medication_id: med.id, lot_number: 'ZZT-FF-A', quantity: 40, expires_on: '2026-12-01T00:00:00.000Z' });
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 30, refills_allowed: 3, expires_on: '2027-09-01T00:00:00.000Z' });
  const f1 = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  const d1 = ctx.api('POST', '/fills/' + f1.body.id + '/dispense', {});
  ctx.assert(d1.status === 200 && d1.body.status === 'dispensed' && d1.body.lot_id === lotA.id, 'first fill from lot A: ' + JSON.stringify(d1));
  ctx.assert(ctx.api('GET', '/lots/' + lotA.id).body.quantity === 10, 'lot A down to 10');
  const f2 = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  const d2 = ctx.api('POST', '/fills/' + f2.body.id + '/dispense', {});
  ctx.assert(d2.status === 200 && d2.body.lot_id === lotB.id, 'second fill from lot B: ' + JSON.stringify(d2));
  ctx.assert(ctx.api('GET', '/lots/' + lotB.id).body.quantity === 70, 'lot B down to 70');
  ctx.assert(ctx.api('GET', '/lots/' + lotC.id).body.quantity === 100, 'date-expired lot untouched');
  const big = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 500, refills_allowed: 0, expires_on: '2027-09-01T00:00:00.000Z' });
  const f3 = ctx.api('POST', '/prescriptions/' + big.id + '/fills', {});
  const d3 = ctx.api('POST', '/fills/' + f3.body.id + '/dispense', {});
  ctx.assert(d3.status === 409 && d3.body.error.code === 'insufficient_stock', 'no lot big enough: ' + JSON.stringify(d3));
  ctx.assert(ctx.api('GET', '/fills/' + f3.body.id).body.status === 'ready', 'fill still ready');
}
```
### t_quarantine
- Intent: Quarantined lots are excluded from dispensing.
- Actions: quarantine_lot, request_fill, dispense_fill
- Description: Quarantine a lot; a second quarantine is refused and a fill cannot be dispensed from it.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT Quar Patient', date_of_birth: '1960-06-06' });
  const med = mk('/medications', { name: 'ZZT Quar Med', strength: '25mg', schedule: 'rx' });
  const lot = mk('/lots', { medication_id: med.id, lot_number: 'ZZT-QR-1', quantity: 100, expires_on: '2027-06-01T00:00:00.000Z' });
  const q = ctx.api('POST', '/lots/' + lot.id + '/quarantine', {});
  ctx.assert(q.status === 200 && q.body.status === 'quarantined', 'quarantine: ' + JSON.stringify(q));
  const q2 = ctx.api('POST', '/lots/' + lot.id + '/quarantine', {});
  ctx.assert(q2.status === 409 && q2.body.error.code === 'invalid_state', 'second quarantine: ' + JSON.stringify(q2));
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 0, expires_on: '2027-09-01T00:00:00.000Z' });
  const f = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  const d = ctx.api('POST', '/fills/' + f.body.id + '/dispense', {});
  ctx.assert(d.status === 409 && d.body.error.code === 'insufficient_stock', 'quarantined lot not used: ' + JSON.stringify(d));
  ctx.assert(ctx.api('GET', '/lots/' + lot.id).body.quantity === 100, 'quantity unchanged');
}
```
### t_expire_lots
- Intent: The daily job expires lots past their date and expired lots cannot supply fills.
- Actions: request_fill, dispense_fill
- Description: A lot expiring tomorrow is marked expired after two days, a long-dated lot stays available, and the expired lot cannot supply a fill.

```js
(ctx) => {
  const mk = (p, b) => { const r = ctx.api('POST', p, b); ctx.assert(r.status === 201, p + ': ' + JSON.stringify(r.body)); return r.body; };
  const pt = mk('/patients', { name: 'ZZT ExpLot Patient', date_of_birth: '1999-09-19' });
  const med = mk('/medications', { name: 'ZZT ExpLot Med', strength: '15mg', schedule: 'rx' });
  const soon = mk('/lots', { medication_id: med.id, lot_number: 'ZZT-EL-1', quantity: 100, expires_on: '2026-10-10T00:00:00.000Z' });
  const med2 = mk('/medications', { name: 'ZZT ExpLot Med Two', strength: '15mg', schedule: 'rx' });
  const far = mk('/lots', { medication_id: med2.id, lot_number: 'ZZT-EL-2', quantity: 100, expires_on: '2027-06-01T00:00:00.000Z' });
  const rx = mk('/prescriptions', { patient_id: pt.id, medication_id: med.id, prescriber_name: 'Dr. ZZT', quantity: 10, refills_allowed: 0, expires_on: '2027-09-01T00:00:00.000Z' });
  const f = ctx.api('POST', '/prescriptions/' + rx.id + '/fills', {});
  ctx.assert(f.status === 201, 'fill: ' + JSON.stringify(f));
  const run = ctx.advance('2d');
  ctx.assert(run.jobsFired.includes('expire_lots'), 'job fired: ' + JSON.stringify(run));
  ctx.assert(ctx.api('GET', '/lots/' + soon.id).body.status === 'expired', 'soon lot expired');
  ctx.assert(ctx.api('GET', '/lots/' + far.id).body.status === 'available', 'far lot available');
  const d = ctx.api('POST', '/fills/' + f.body.id + '/dispense', {});
  ctx.assert(d.status === 409 && d.body.error.code === 'insufficient_stock', 'expired lot cannot supply: ' + JSON.stringify(d));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_patients` | GET | /patients | List patients, search by name. |
| `get_patient` | GET | /patients/{id} | Fetch a patient. |
| `create_patient` | POST | /patients | Register a patient. |
| `list_medications` | GET | /medications | List medications, filter by schedule. |
| `get_medication` | GET | /medications/{id} | Fetch a medication. |
| `create_medication` | POST | /medications | Add a medication. |
| `list_pharmacists` | GET | /pharmacists | List staff, filter by role. |
| `get_pharmacist` | GET | /pharmacists/{id} | Fetch a staff member. |
| `create_pharmacist` | POST | /pharmacists | Add a staff member. |
| `list_lots` | GET | /lots | List stock lots, filter by medication_id and status, sort by expires_on. |
| `get_lot` | GET | /lots/{id} | Fetch a lot. |
| `create_lot` | POST | /lots | Receive a new lot into stock. |
| `list_prescriptions` | GET | /prescriptions | List prescriptions, filter by patient_id, medication_id, status. |
| `get_prescription` | GET | /prescriptions/{id} | Fetch a prescription. |
| `create_prescription` | POST | /prescriptions | Enter a new prescription (status starts active). |
| `list_fills` | GET | /fills | List fills, filter by status, prescription_id, medication_id, patient_id; sort by created_at. |
| `get_fill` | GET | /fills/{id} | Fetch a fill. |
| `request_fill` | POST | /prescriptions/{id}/fills | Action: request a fill or refill. |
| `cancel_prescription` | POST | /prescriptions/{id}/cancel | Action: cancel a prescription. |
| `approve_fill` | POST | /fills/{id}/approve | Action: pharmacist verifies a controlled fill. |
| `reject_fill` | POST | /fills/{id}/reject | Action: reject an open fill. |
| `dispense_fill` | POST | /fills/{id}/dispense | Action: dispense a ready fill from stock. |
| `quarantine_lot` | POST | /lots/{id}/quarantine | Action: quarantine a lot for recall. |

## Seed

- Rows per entity: patient: 14, medication: 14, pharmacist: 5, stock_lot: 32, prescription: 40, fill: 48
- Mix: Controlled medications are about a third of the catalogue. Fills in pending_review are for controlled prescriptions, 12 of them. Of those prescriptions, 4 have expires_on just before the clock start (2026-10-08 to 2026-10-09T08:00) but are still status active because the daily job has not run, and 4 expire just after (2026-10-10 or later); the rest are far in the future. Two near-duplicate patients, Maria Lopez and Maria Lopes with different dates of birth, each have a ready fill. Pharmacists include 3 pharmacists and 2 technicians. Stock lots include several available lots of the same medication with different expiry dates, 3 quarantined and 10 expired lots. Prescription notes include misleading text such as 'already approved by phone' on rows whose fill status says otherwise. Prescriptions include completed ones with all refills used and cancelled ones.
- State mix: prescription: active 60%, completed 15%, cancelled 15%, expired 10%; fill: pending_review 25%, ready 30%, dispensed 35%, rejected 10%; stock_lot: available 59%, quarantined 9%, expired 32%

## Tasks

- `approve_pending_controlled_fill` (easy, permissions): Approve the pending-review controlled fill for one named patient using a named pharmacist.
  - Decoy idea: Approves a pending fill for a different patient, or uses a technician's id.
- `dispense_ready_fill_for_maria_lopez` (medium, misleading_text): Dispense the ready fill for Maria Lopez (identified by date of birth) without touching the near-duplicate patient Maria Lopes.
  - Actions: `dispense_fill`
  - Decoy idea: Dispenses Maria Lopes' ready fill, or both fills.
  - Pressure: seeded rows in fill.ready; distractor rows of patient
- `process_controlled_review_queue` (hard, time_sensitive): Process the controlled-substance review queue at the current date. Approve and dispense each pending_review fill whose prescription has not passed expires_on. Reject, with a reason, those whose prescription expiry date has passed, even though their status is still active.
  - Actions: `approve_fill`, `dispense_fill`, `reject_fill`
  - Decoy idea: Approves and dispenses every pending fill, trusting status active, or only approves without dispensing.
  - Pressure: seeded rows in fill.pending_review, prescription.active; distractor rows of prescription

## Open questions

- Should technicians be allowed to dispense controlled fills once a pharmacist has approved them?
  - Default answer: Yes. Dispensing needs no staff input; only approval and rejection need a pharmacist.
- Do pending fills count against the refill allowance?
  - Default answer: Yes, every non-rejected fill request counts.
- Can a fill be split across lots?
  - Default answer: No. One lot must hold the whole fill quantity.
- Do expired or cancelled prescriptions auto-reject open fills?
  - Default answer: Cancelling rejects open fills. Expiry does not; a pharmacist must reject them.

## Assumptions

- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded history is before this and prescription and lot expiry dates lie on both sides of it.
  - Why: Time is explicit and deterministic; expiry-sensitive tasks need rows just before and after the cutoff.
- A prescription allows refills_allowed + 1 fills in total. fills_made counts non-rejected fill requests, and rejecting a fill gives the count back.
  - Why: Matches the real first-fill-plus-refills model and keeps the rule checkable.
- Controlled fills start as pending_review; otc and rx fills start as ready. Approval moves pending_review to ready and records approved_by.
  - Why: Keeps a single fill state machine with the pharmacist gate on controlled substances only.
- Only a pharmacist with role pharmacist and active=true may approve or reject. Technicians get 422 not_pharmacist.
  - Why: Models the permission rule for controlled substances.
- Dispensing picks the available lot with the earliest expires_on that is still in the future and has enough quantity, takes the fill quantity from it, and records lot_id. Otherwise it answers 409 insufficient_stock.
  - Why: First-expiring-first-out is the standard pharmacy practice, and it keeps expired stock from reaching patients.
- Daily jobs mark lots and prescriptions expired once past expires_on. The approve and dispense actions check the dates themselves and do not trust the status flag.
  - Why: Status can lag by up to a day, which creates the near-cutoff traps.
- Dispensing the last allowed fill of a prescription moves it to completed.
  - Why: Gives prescriptions a natural end state.
- Standard create routes may create lots with past expiry dates.
  - Why: This lets receiving and test flows work; dispense and the job guard against expired stock.
- State mix: prescriptions 60% active, 15% completed, 15% cancelled, 10% expired; fills 25% pending_review, 30% ready, 35% dispensed, 10% rejected; lots 59% available, 9% quarantined, 32% expired.
  - Why: Spreads every state with none above 70% while matching the seed counts described.

## Out of scope

- Insurance claims, pricing and payments
  - Why: The core value is the stock and approval workflow, not billing.
- DEA/state controlled-substance reporting and drug-interaction checks
  - Why: External integrations and clinical decision support are not record workflows here.
- Authentication and user sessions
  - Why: The acting pharmacist is passed as an action input.
- Purchase orders and supplier management
  - Why: Lots arrive through the create route only.

## Changes

None. The plan changes no existing item.
