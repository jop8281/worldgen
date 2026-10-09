# WorldGen plan: Guidewire ClaimCenter / Lemonade-style P&C insurance claims API (policies, coverages, claims, payouts, fraud flags)

An insurance claims world. Policyholders hold policies with per-coverage limits and per-claim deductibles. Claims are filed against a coverage, reviewed by an adjuster, approved with the deductible and the remaining limit applied (reserving money on the coverage), then paid out, or denied. Adjusters raise fraud flags that block approval and payout until they are cleared or confirmed. Confirming fraud denies the claim and releases the reserve. Jobs expire policies and auto-close old paid claims.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-07T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `policyholder` | Person or business that holds one or more policies and receives payouts. | name, email, city |
| `adjuster` | Claims adjuster who reviews claims and raises fraud flags. Inactive adjusters cannot be assigned. | name, email, specialty, active |
| `policy` | Insurance policy for one line of business with a coverage period. Only active policies accept new claims. | policy_number, policyholder_id, line, status, start_date, end_date, premium |
| `coverage` | One covered peril on a policy, with a limit, a per-claim deductible, and running paid and reserved totals. | policy_id, kind, limit_amount, deductible, paid_amount, reserved_amount |
| `claim` | A loss reported against a coverage. Moves through submitted, under_review, approved, paid and closed, or denied. | policy_id, coverage_id, adjuster_id, incident_date, claimed_amount, approved_amount, deductible_applied, status, denial_reason, submitted_at, approved_at, paid_at, closed_at |
| `payment` | Payout record created when a claim is paid. One per paid claim. | claim_id, policyholder_id, amount, method, paid_at |
| `fraud_flag` | Suspicion raised against a claim. An open flag blocks approval and payout. | claim_id, raised_by_id, severity, reason, status, resolution_note, resolved_at |
| `claim_event` | Append-only audit trail of what happened to a claim. Written by actions and jobs. | claim_id, kind, note, actor_id |

## Workflows

### claim_lifecycle (claim)
- States: submitted, under_review, approved, denied, paid, closed
- Actions: file_claim, start_review, approve_claim, deny_claim, pay_claim, close_claim
- Rules:
  - Transitions: submitted to under_review or denied. under_review to approved or denied. approved to paid or denied (denied only by fraud confirmation). paid to closed. denied to closed. closed is final.
  - file_claim (201): policy must exist (404 not_found) and be active (409 policy_not_active). coverage_id must belong to the policy (422 coverage_mismatch). incident_date must be within start_date and end_date (422 incident_outside_policy_period) and not after now (422 incident_in_future). claimed_amount min 1. Creates the claim as submitted with submitted_at = now, adjuster_id, approved_amount and deductible_applied null, and a submitted event.
  - start_review (200): the claim must be submitted (409 invalid_state, 404 not_found). The adjuster must be active (409 adjuster_inactive). Sets adjuster_id, status under_review and adds a review_started event.
  - approve_claim (200): the claim must be under_review (409 invalid_state). Any open fraud flag gives 409 fraud_hold. deductible_applied = min(coverage.deductible, claimed_amount). payable = min(claimed_amount - deductible_applied, limit_amount - paid_amount - reserved_amount). payable <= 0 gives 409 nothing_payable. Sets approved_amount = payable, approved_at = now, status approved, coverage.reserved_amount += payable, and adds an approved event. Optional note.
  - deny_claim (200): the claim must be submitted or under_review (409 invalid_state). The reason is required and non-blank (400 input.invalid). Sets denial_reason and status denied, and adds a denied event.
  - pay_claim (200): the claim must be approved (409 invalid_state). An open fraud flag gives 409 fraud_hold. method is bank_transfer or check (400 input.invalid). Creates a payment (amount = approved_amount, policyholder_id from the policy, paid_at = now). coverage.reserved_amount -= approved_amount and paid_amount += approved_amount. Sets status paid and paid_at, and adds a paid event.
  - close_claim (200): the claim must be paid or denied (409 invalid_state). Sets closed_at = now and status closed, and adds a closed event.
### fraud_flag_review (fraud_flag)
- States: open, cleared, confirmed
- Actions: raise_fraud_flag, resolve_fraud_flag
- Rules:
  - Transitions: open to cleared or confirmed. Both are final.
  - raise_fraud_flag (201): the claim must be submitted, under_review or approved (409 invalid_state, 404 not_found). Input severity (low, medium or high), reason (required text) and optional raised_by_id. Creates an open flag and a fraud_flagged event.
  - resolve_fraud_flag (200): the flag must be open (409 already_resolved, 404 not_found). Input outcome (cleared or confirmed) and note (required, non-blank, else 400 input.invalid). Sets resolution_note and resolved_at = now. cleared adds a fraud_cleared event. confirmed also denies the claim when it is submitted, under_review or approved: denial_reason is 'fraud confirmed: ' + note, a claim that was approved releases its reserved_amount from the coverage, and fraud_confirmed and denied events are added.
### policy_status (policy)
- States: active, suspended, expired
- Actions: suspend_policy, reinstate_policy
- Rules:
  - Transitions: active to suspended or expired. suspended to active or expired. expired is final.
  - suspend_policy (200): the policy must be active (409 invalid_state). Input reason is required text.
  - reinstate_policy (200): the policy must be suspended (409 invalid_state).
  - Job expire_policies (daily): active or suspended policies with end_date at or before now become expired.
  - Job auto_close_paid (daily): claims in status paid with paid_at at least 30 days ago become closed, with closed_at = now and a closed event noted 'auto: 30 days after payout'.

## Jobs

- `expire_policies` runs every 1d: Policies in status active or suspended whose end_date is at or before now move to expired.
- `auto_close_paid` runs every 1d: Claims in status paid with paid_at at least 30 days before now move to closed. Set closed_at = now and add a closed event noted 'auto: 30 days after payout'.

## Acceptance tests

### file_claim_validates_and_creates
- Intent: Filing creates a submitted claim and refuses bad dates, a foreign coverage, a zero amount and a missing policy
- Actions: file_claim
- Description: file_claim returns 201 with a submitted claim and a submitted event. It refuses an incident before the policy period, a future incident, a coverage from another policy, a zero amount and an unknown policy, and creates no claim for refused calls.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const setup = (tag, limit, ded) => { const h = post('/policyholders', { name: 'Test ' + tag, email: tag + '@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-' + tag, policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: limit, deductible: ded }).body; ctx.assert(h && h.id && p && p.id && c && c.id, 'setup failed for ' + tag); return { h, p, c }; }; const s = setup('fc1', 1000000, 50000); const other = setup('fc2', 500000, 10000); const r = post('/policies/' + s.p.id + '/claims', { coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Rear-ended at a junction', claimed_amount: 300000 }); ctx.assert(r.status === 201, 'file_claim returned ' + r.status + ' ' + JSON.stringify(r.body)); ctx.assert(r.body.status === 'submitted' && r.body.policy_id === s.p.id && r.body.coverage_id === s.c.id && r.body.claimed_amount === 300000, 'claim fields: ' + JSON.stringify(r.body)); ctx.assert(r.body.submitted_at === ctx.now() && r.body.adjuster_id === null && r.body.approved_amount === null, 'submitted_at is now, no adjuster, no approved amount: ' + JSON.stringify(r.body)); const ev = get('/claims/' + r.body.id + '/events').body.data; ctx.assert(ev.length === 1 && ev[0].kind === 'submitted', 'one submitted event, got ' + JSON.stringify(ev)); const path = '/policies/' + s.p.id + '/claims'; const body = (o) => ({ coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Hail damage', claimed_amount: 100000, ...o }); const early = post(path, body({ incident_date: '2025-06-01T00:00:00.000Z' })); ctx.assert(early.status === 422 && early.body.error.code === 'incident_outside_policy_period', 'early incident: ' + JSON.stringify(early)); const future = post(path, body({ incident_date: '2026-12-01T00:00:00.000Z' })); ctx.assert(future.status === 422 && future.body.error.code === 'incident_in_future', 'future incident: ' + JSON.stringify(future)); const mismatch = post(path, body({ coverage_id: other.c.id })); ctx.assert(mismatch.status === 422 && mismatch.body.error.code === 'coverage_mismatch', 'foreign coverage: ' + JSON.stringify(mismatch)); const zero = post(path, body({ claimed_amount: 0 })); ctx.assert(zero.status === 400 && zero.body.error.code === 'input.invalid', 'zero amount: ' + JSON.stringify(zero)); const missing = post('/policies/pol_9999/claims', body({})); ctx.assert(missing.status === 404 && missing.body.error.code === 'not_found', 'unknown policy: ' + JSON.stringify(missing)); const mine = get('/claims?policy_id=' + s.p.id).body.data; ctx.assert(mine.length === 1, 'refused filings created no claim, got ' + mine.length); }
```
### start_review_assigns_adjuster
- Intent: Review assigns an active adjuster and moves the claim to under_review. It refuses repeats, inactive adjusters and unknown claims
- Actions: file_claim, start_review
- Description: start_review moves a submitted claim to under_review with the adjuster. A second review gives 409 invalid_state, an inactive adjuster gives 409 adjuster_inactive and leaves the claim submitted, and an unknown claim gives 404.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const setup = (tag, limit, ded) => { const h = post('/policyholders', { name: 'Test ' + tag, email: tag + '@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-' + tag, policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: limit, deductible: ded }).body; ctx.assert(h && h.id && p && p.id && c && c.id, 'setup failed for ' + tag); return { h, p, c }; }; const adjuster = (tag, active) => post('/adjusters', { name: 'Adjuster ' + tag, email: 'adj.' + tag + '@acceptance.test', specialty: 'auto', active }).body; const file = (s, amt) => post('/policies/' + s.p.id + '/claims', { coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Rear-ended at a junction', claimed_amount: amt }); const s = setup('rv1', 1000000, 50000); const a = adjuster('rv1', true); const idle = adjuster('rv2', false); ctx.assert(a.id && idle.id, 'adjusters created'); const c = file(s, 300000).body; const r = post('/claims/' + c.id + '/review', { adjuster_id: a.id }); ctx.assert(r.status === 200, 'review returned ' + r.status + ' ' + JSON.stringify(r.body)); ctx.assert(r.body.status === 'under_review' && r.body.adjuster_id === a.id, 'under_review with adjuster, got ' + JSON.stringify(r.body)); const again = post('/claims/' + c.id + '/review', { adjuster_id: a.id }); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second review: ' + JSON.stringify(again)); const c2 = file(s, 100000).body; const bad = post('/claims/' + c2.id + '/review', { adjuster_id: idle.id }); ctx.assert(bad.status === 409 && bad.body.error.code === 'adjuster_inactive', 'inactive adjuster: ' + JSON.stringify(bad)); ctx.assert(get('/claims/' + c2.id).body.status === 'submitted' && get('/claims/' + c2.id).body.adjuster_id === null, 'refused review changed nothing'); const missing = post('/claims/clm_9999/review', { adjuster_id: a.id }); ctx.assert(missing.status === 404 && missing.body.error.code === 'not_found', 'unknown claim: ' + JSON.stringify(missing)); const kinds = get('/claims/' + c.id + '/events').body.data.map((e) => e.kind); ctx.assert(kinds.includes('review_started'), 'review_started event, got ' + JSON.stringify(kinds)); }
```
### approve_applies_deductible_and_reserves
- Intent: Approval subtracts the deductible, stores the approved amount and reserves it on the coverage
- Actions: file_claim, start_review, approve_claim
- Description: Claimed 300000 with a 50000 deductible approves 250000, sets deductible_applied and approved_at, and raises coverage.reserved_amount to 250000. Approving a claim that is not under review gives 409 invalid_state.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const setup = (tag, limit, ded) => { const h = post('/policyholders', { name: 'Test ' + tag, email: tag + '@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-' + tag, policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: limit, deductible: ded }).body; ctx.assert(h && h.id && p && p.id && c && c.id, 'setup failed for ' + tag); return { h, p, c }; }; const adjuster = (tag, active) => post('/adjusters', { name: 'Adjuster ' + tag, email: 'adj.' + tag + '@acceptance.test', specialty: 'auto', active }).body; const file = (s, amt) => post('/policies/' + s.p.id + '/claims', { coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Rear-ended at a junction', claimed_amount: amt }); const s = setup('ap1', 1000000, 50000); const a = adjuster('ap1', true); const c = file(s, 300000).body; const early = post('/claims/' + c.id + '/approve', {}); ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'approve while submitted: ' + JSON.stringify(early)); ctx.assert(post('/claims/' + c.id + '/review', { adjuster_id: a.id }).status === 200, 'review'); const r = post('/claims/' + c.id + '/approve', {}); ctx.assert(r.status === 200, 'approve returned ' + r.status + ' ' + JSON.stringify(r.body)); ctx.assert(r.body.status === 'approved' && r.body.approved_amount === 250000 && r.body.deductible_applied === 50000, 'approved 250000 after 50000 deductible, got ' + JSON.stringify(r.body)); ctx.assert(r.body.approved_at === ctx.now(), 'approved_at is now'); const cov = get('/coverages/' + s.c.id).body; ctx.assert(cov.reserved_amount === 250000 && cov.paid_amount === 0, 'reserved 250000, paid 0, got ' + JSON.stringify(cov)); const again = post('/claims/' + c.id + '/approve', {}); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second approve: ' + JSON.stringify(again)); const kinds = get('/claims/' + c.id + '/events').body.data.map((e) => e.kind); ctx.assert(kinds.includes('approved'), 'approved event, got ' + JSON.stringify(kinds)); }
```
### approve_caps_at_remaining_limit
- Intent: Approval is capped at the remaining coverage limit and refused when nothing is payable
- Actions: file_claim, start_review, approve_claim
- Description: With limit 100000 and deductible 20000, a 90000 claim approves 70000, a second 90000 claim approves only the remaining 30000, and a third gets 409 nothing_payable and stays under_review.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const setup = (tag, limit, ded) => { const h = post('/policyholders', { name: 'Test ' + tag, email: tag + '@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-' + tag, policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: limit, deductible: ded }).body; ctx.assert(h && h.id && p && p.id && c && c.id, 'setup failed for ' + tag); return { h, p, c }; }; const adjuster = (tag, active) => post('/adjusters', { name: 'Adjuster ' + tag, email: 'adj.' + tag + '@acceptance.test', specialty: 'auto', active }).body; const file = (s, amt) => post('/policies/' + s.p.id + '/claims', { coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Rear-ended at a junction', claimed_amount: amt }); const s = setup('cap1', 100000, 20000); const a = adjuster('cap1', true); const mk = (amt) => { const c = file(s, amt).body; ctx.assert(post('/claims/' + c.id + '/review', { adjuster_id: a.id }).status === 200, 'review ' + c.id); return c; }; const c1 = mk(90000); const c2 = mk(90000); const c3 = mk(50000); const r1 = post('/claims/' + c1.id + '/approve', {}); ctx.assert(r1.status === 200 && r1.body.approved_amount === 70000, 'first approves 70000, got ' + JSON.stringify(r1)); const r2 = post('/claims/' + c2.id + '/approve', {}); ctx.assert(r2.status === 200 && r2.body.approved_amount === 30000 && r2.body.deductible_applied === 20000, 'second capped at remaining 30000, got ' + JSON.stringify(r2)); ctx.assert(get('/coverages/' + s.c.id).body.reserved_amount === 100000, 'reserved equals the limit'); const r3 = post('/claims/' + c3.id + '/approve', {}); ctx.assert(r3.status === 409 && r3.body.error.code === 'nothing_payable', 'exhausted limit: ' + JSON.stringify(r3)); ctx.assert(get('/claims/' + c3.id).body.status === 'under_review', 'third claim stays under_review'); ctx.assert(get('/coverages/' + s.c.id).body.reserved_amount === 100000, 'refused approval reserved nothing'); }
```
### pay_claim_records_payment
- Intent: Paying an approved claim records a payment and moves the reserve to paid
- Actions: file_claim, start_review, approve_claim, pay_claim
- Description: pay_claim sets status paid and paid_at, creates one payment of 250000, moves coverage reserved_amount to paid_amount, and refuses a second payment, an unapproved claim and an unknown method.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const setup = (tag, limit, ded) => { const h = post('/policyholders', { name: 'Test ' + tag, email: tag + '@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-' + tag, policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: limit, deductible: ded }).body; ctx.assert(h && h.id && p && p.id && c && c.id, 'setup failed for ' + tag); return { h, p, c }; }; const adjuster = (tag, active) => post('/adjusters', { name: 'Adjuster ' + tag, email: 'adj.' + tag + '@acceptance.test', specialty: 'auto', active }).body; const file = (s, amt) => post('/policies/' + s.p.id + '/claims', { coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Rear-ended at a junction', claimed_amount: amt }); const s = setup('pay1', 1000000, 50000); const a = adjuster('pay1', true); const c = file(s, 300000).body; const unapproved = post('/claims/' + c.id + '/pay', { method: 'bank_transfer' }); ctx.assert(unapproved.status === 409 && unapproved.body.error.code === 'invalid_state', 'pay while submitted: ' + JSON.stringify(unapproved)); ctx.assert(post('/claims/' + c.id + '/review', { adjuster_id: a.id }).status === 200, 'review'); ctx.assert(post('/claims/' + c.id + '/approve', {}).status === 200, 'approve'); const badMethod = post('/claims/' + c.id + '/pay', { method: 'cash' }); ctx.assert(badMethod.status === 400 && badMethod.body.error.code === 'input.invalid', 'unknown method: ' + JSON.stringify(badMethod)); ctx.assert(get('/claims/' + c.id).body.status === 'approved', 'refused payment left the claim approved'); const r = post('/claims/' + c.id + '/pay', { method: 'bank_transfer' }); ctx.assert(r.status === 200, 'pay returned ' + r.status + ' ' + JSON.stringify(r.body)); ctx.assert(r.body.status === 'paid' && r.body.paid_at === ctx.now(), 'paid at now, got ' + JSON.stringify(r.body)); const pays = get('/payments?claim_id=' + c.id).body.data; ctx.assert(pays.length === 1 && pays[0].amount === 250000 && pays[0].method === 'bank_transfer' && pays[0].policyholder_id === s.h.id, 'one payment of 250000 to the policyholder, got ' + JSON.stringify(pays)); const cov = get('/coverages/' + s.c.id).body; ctx.assert(cov.reserved_amount === 0 && cov.paid_amount === 250000, 'reserve moved to paid, got ' + JSON.stringify(cov)); const twice = post('/claims/' + c.id + '/pay', { method: 'check' }); ctx.assert(twice.status === 409 && twice.body.error.code === 'invalid_state', 'second payment: ' + JSON.stringify(twice)); ctx.assert(get('/payments?claim_id=' + c.id).body.data.length === 1, 'still one payment'); }
```
### fraud_flag_blocks_then_confirms
- Intent: An open fraud flag blocks approval and payout. Clearing releases the block. Confirming denies the claim and frees the reserve
- Actions: file_claim, start_review, approve_claim, pay_claim, raise_fraud_flag, resolve_fraud_flag
- Description: An open flag gives 409 fraud_hold on approve. After clearing, approve works. A second flag blocks pay. Confirming it denies the claim with a 'fraud confirmed' reason and releases the coverage reserve. Resolving again gives 409 already_resolved, and a flag on a denied claim gives 409 invalid_state.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const setup = (tag, limit, ded) => { const h = post('/policyholders', { name: 'Test ' + tag, email: tag + '@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-' + tag, policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: limit, deductible: ded }).body; ctx.assert(h && h.id && p && p.id && c && c.id, 'setup failed for ' + tag); return { h, p, c }; }; const adjuster = (tag, active) => post('/adjusters', { name: 'Adjuster ' + tag, email: 'adj.' + tag + '@acceptance.test', specialty: 'auto', active }).body; const file = (s, amt) => post('/policies/' + s.p.id + '/claims', { coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Rear-ended at a junction', claimed_amount: amt }); const s = setup('fr1', 1000000, 50000); const a = adjuster('fr1', true); const c = file(s, 300000).body; ctx.assert(post('/claims/' + c.id + '/review', { adjuster_id: a.id }).status === 200, 'review'); const f1 = post('/claims/' + c.id + '/fraud_flags', { severity: 'high', reason: 'Invoice date predates the incident', raised_by_id: a.id }); ctx.assert(f1.status === 201 && f1.body.status === 'open' && f1.body.claim_id === c.id && f1.body.severity === 'high', 'flag raised open: ' + JSON.stringify(f1)); const blocked = post('/claims/' + c.id + '/approve', {}); ctx.assert(blocked.status === 409 && blocked.body.error.code === 'fraud_hold', 'approve with open flag: ' + JSON.stringify(blocked)); ctx.assert(get('/fraud_flags?claim_id=' + c.id + '&status=open').body.data.length === 1, 'one open flag listed'); const cleared = post('/fraud_flags/' + f1.body.id + '/resolve', { outcome: 'cleared', note: 'Invoice verified with the repair shop' }); ctx.assert(cleared.status === 200 && cleared.body.status === 'cleared' && cleared.body.resolved_at === ctx.now() && cleared.body.resolution_note === 'Invoice verified with the repair shop', 'cleared: ' + JSON.stringify(cleared)); const approved = post('/claims/' + c.id + '/approve', {}); ctx.assert(approved.status === 200 && approved.body.status === 'approved', 'approve after clearing: ' + JSON.stringify(approved)); ctx.assert(get('/coverages/' + s.c.id).body.reserved_amount === 250000, 'reserved after approval'); const f2 = post('/claims/' + c.id + '/fraud_flags', { severity: 'medium', reason: 'Duplicate photos across two claims' }); ctx.assert(f2.status === 201 && f2.body.status === 'open', 'second flag on approved claim: ' + JSON.stringify(f2)); const noPay = post('/claims/' + c.id + '/pay', { method: 'check' }); ctx.assert(noPay.status === 409 && noPay.body.error.code === 'fraud_hold', 'pay with open flag: ' + JSON.stringify(noPay)); const conf = post('/fraud_flags/' + f2.body.id + '/resolve', { outcome: 'confirmed', note: 'forged photos' }); ctx.assert(conf.status === 200 && conf.body.status === 'confirmed', 'confirmed: ' + JSON.stringify(conf)); const after = get('/claims/' + c.id).body; ctx.assert(after.status === 'denied' && typeof after.denial_reason === 'string' && after.denial_reason.startsWith('fraud confirmed: '), 'claim denied for fraud, got ' + JSON.stringify(after)); const cov = get('/coverages/' + s.c.id).body; ctx.assert(cov.reserved_amount === 0 && cov.paid_amount === 0, 'reserve released, got ' + JSON.stringify(cov)); const twice = post('/fraud_flags/' + f2.body.id + '/resolve', { outcome: 'cleared', note: 'changed my mind' }); ctx.assert(twice.status === 409 && twice.body.error.code === 'already_resolved', 'resolve twice: ' + JSON.stringify(twice)); const late = post('/claims/' + c.id + '/fraud_flags', { severity: 'low', reason: 'Late concern' }); ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'flag on denied claim: ' + JSON.stringify(late)); const kinds = get('/claims/' + c.id + '/events').body.data.map((e) => e.kind); ctx.assert(kinds.includes('fraud_flagged') && kinds.includes('fraud_cleared') && kinds.includes('fraud_confirmed'), 'fraud events, got ' + JSON.stringify(kinds)); }
```
### deny_and_close_claim
- Intent: Denial needs a reason, close is only for paid or denied claims, and closed is final
- Actions: file_claim, start_review, approve_claim, pay_claim, deny_claim, close_claim
- Description: deny_claim refuses a blank reason and stores a real one. close_claim closes a denied claim and a paid claim, refuses a submitted claim, and a closed claim can be neither closed nor denied again.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const setup = (tag, limit, ded) => { const h = post('/policyholders', { name: 'Test ' + tag, email: tag + '@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-' + tag, policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: limit, deductible: ded }).body; ctx.assert(h && h.id && p && p.id && c && c.id, 'setup failed for ' + tag); return { h, p, c }; }; const adjuster = (tag, active) => post('/adjusters', { name: 'Adjuster ' + tag, email: 'adj.' + tag + '@acceptance.test', specialty: 'auto', active }).body; const file = (s, amt) => post('/policies/' + s.p.id + '/claims', { coverage_id: s.c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Rear-ended at a junction', claimed_amount: amt }); const s = setup('dc1', 1000000, 50000); const a = adjuster('dc1', true); const c1 = file(s, 200000).body; const blank = post('/claims/' + c1.id + '/deny', { reason: '   ' }); ctx.assert(blank.status === 400 && blank.body.error.code === 'input.invalid', 'blank reason: ' + JSON.stringify(blank)); const d = post('/claims/' + c1.id + '/deny', { reason: 'Loss not covered: pre-existing damage' }); ctx.assert(d.status === 200 && d.body.status === 'denied' && d.body.denial_reason === 'Loss not covered: pre-existing damage', 'denied with reason: ' + JSON.stringify(d)); const closed1 = post('/claims/' + c1.id + '/close', {}); ctx.assert(closed1.status === 200 && closed1.body.status === 'closed' && closed1.body.closed_at === ctx.now(), 'close denied claim: ' + JSON.stringify(closed1)); const again = post('/claims/' + c1.id + '/close', {}); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'close twice: ' + JSON.stringify(again)); const redo = post('/claims/' + c1.id + '/deny', { reason: 'again' }); ctx.assert(redo.status === 409 && redo.body.error.code === 'invalid_state', 'deny closed claim: ' + JSON.stringify(redo)); const c2 = file(s, 100000).body; const early = post('/claims/' + c2.id + '/close', {}); ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'close submitted claim: ' + JSON.stringify(early)); ctx.assert(post('/claims/' + c2.id + '/review', { adjuster_id: a.id }).status === 200, 'review'); ctx.assert(post('/claims/' + c2.id + '/approve', {}).status === 200, 'approve'); ctx.assert(post('/claims/' + c2.id + '/pay', { method: 'check' }).status === 200, 'pay'); const closed2 = post('/claims/' + c2.id + '/close', {}); ctx.assert(closed2.status === 200 && closed2.body.status === 'closed', 'close paid claim: ' + JSON.stringify(closed2)); const c3 = file(s, 100000).body; ctx.assert(post('/claims/' + c3.id + '/review', { adjuster_id: a.id }).status === 200, 'review c3'); const d3 = post('/claims/' + c3.id + '/deny', { reason: 'Policy exclusion applies' }); ctx.assert(d3.status === 200 && d3.body.status === 'denied', 'deny under_review claim: ' + JSON.stringify(d3)); }
```
### policy_suspend_and_reinstate
- Intent: A suspended policy refuses new claims until reinstated
- Actions: suspend_policy, reinstate_policy, file_claim
- Description: suspend_policy moves an active policy to suspended and refuses repeats. While suspended, filing gives 409 policy_not_active. reinstate_policy restores it, refuses repeats, and filing works again.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const h = post('/policyholders', { name: 'Test ps1', email: 'ps1@acceptance.test', city: 'Austin' }).body; const p = post('/policies', { policy_number: 'ACC-ps1', policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const c = post('/coverages', { policy_id: p.id, kind: 'collision', limit_amount: 500000, deductible: 25000 }).body; ctx.assert(h.id && p.id && c.id, 'setup'); ctx.assert(p.status === 'active', 'new policy is active, got ' + p.status); const claim = { coverage_id: c.id, incident_date: '2026-09-15T00:00:00.000Z', description: 'Parking lot scrape', claimed_amount: 80000 }; const s = post('/policies/' + p.id + '/suspend', { reason: 'Premium unpaid for 60 days' }); ctx.assert(s.status === 200 && s.body.status === 'suspended', 'suspend: ' + JSON.stringify(s)); const s2 = post('/policies/' + p.id + '/suspend', { reason: 'again' }); ctx.assert(s2.status === 409 && s2.body.error.code === 'invalid_state', 'suspend twice: ' + JSON.stringify(s2)); const blocked = post('/policies/' + p.id + '/claims', claim); ctx.assert(blocked.status === 409 && blocked.body.error.code === 'policy_not_active', 'file on suspended policy: ' + JSON.stringify(blocked)); const r = post('/policies/' + p.id + '/reinstate', {}); ctx.assert(r.status === 200 && r.body.status === 'active', 'reinstate: ' + JSON.stringify(r)); const r2 = post('/policies/' + p.id + '/reinstate', {}); ctx.assert(r2.status === 409 && r2.body.error.code === 'invalid_state', 'reinstate twice: ' + JSON.stringify(r2)); const ok = post('/policies/' + p.id + '/claims', claim); ctx.assert(ok.status === 201 && ok.body.status === 'submitted', 'file after reinstatement: ' + JSON.stringify(ok)); const patch = ctx.api('PATCH', '/policies/' + p.id, { status: 'expired' }); ctx.assert(patch.status >= 400 && patch.status < 500, 'status cannot be set by PATCH, got ' + patch.status); ctx.assert(get('/policies/' + p.id).body.status === 'active', 'policy still active'); }
```
### expire_policies_job
- Intent: The daily expiry job expires active and suspended policies past their end date and leaves current ones alone
- Actions: suspend_policy
- Description: After advancing two days, an active and a suspended policy ending 2026-10-08 are expired, and a policy ending in 2027 is still active.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const h = post('/policyholders', { name: 'Test ex1', email: 'ex1@acceptance.test', city: 'Dallas' }).body; ctx.assert(h.id, 'holder'); const mk = (n, end) => { const p = post('/policies', { policy_number: 'ACC-' + n, policyholder_id: h.id, line: 'home', start_date: '2025-10-09T00:00:00.000Z', end_date: end, premium: 90000 }).body; ctx.assert(p.id, 'policy ' + n); return p; }; const short1 = mk('ex1', '2026-10-08T00:00:00.000Z'); const short2 = mk('ex2', '2026-10-08T00:00:00.000Z'); const long1 = mk('ex3', '2027-10-08T00:00:00.000Z'); ctx.assert(post('/policies/' + short2.id + '/suspend', { reason: 'Nonpayment' }).status === 200, 'suspend short2'); ctx.assert(get('/policies/' + short1.id).body.status === 'active', 'still active before the job'); const run = ctx.advance('2d'); ctx.assert(run.jobsFailed.length === 0, 'no job failed: ' + JSON.stringify(run.jobsFailed)); ctx.assert(get('/policies/' + short1.id).body.status === 'expired', 'active policy expired'); ctx.assert(get('/policies/' + short2.id).body.status === 'expired', 'suspended policy expired'); ctx.assert(get('/policies/' + long1.id).body.status === 'active', 'current policy untouched'); const re = post('/policies/' + short1.id + '/reinstate', {}); ctx.assert(re.status === 409 && re.body.error.code === 'invalid_state', 'expired policy cannot be reinstated: ' + JSON.stringify(re)); }
```
### auto_close_paid_job
- Intent: Paid claims close themselves 30 days after payout
- Actions: file_claim, start_review, approve_claim, pay_claim, close_claim
- Description: A paid claim is still paid after 10 days and closed after 31 days, with closed_at set and a closed event.

```js
(ctx) => { const post = (p, b) => ctx.api('POST', p, b); const get = (p) => ctx.api('GET', p); const h = post('/policyholders', { name: 'Test ac1', email: 'ac1@acceptance.test', city: 'Denver' }).body; const p = post('/policies', { policy_number: 'ACC-ac1', policyholder_id: h.id, line: 'auto', start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z', premium: 120000 }).body; const cov = post('/coverages', { policy_id: p.id, kind: 'theft', limit_amount: 400000, deductible: 10000 }).body; const a = post('/adjusters', { name: 'Adjuster ac1', email: 'adj.ac1@acceptance.test', specialty: 'auto', active: true }).body; ctx.assert(h.id && p.id && cov.id && a.id, 'setup'); const c = post('/policies/' + p.id + '/claims', { coverage_id: cov.id, incident_date: '2026-09-20T00:00:00.000Z', description: 'Stolen catalytic converter', claimed_amount: 150000 }).body; ctx.assert(c.id, 'claim filed'); ctx.assert(post('/claims/' + c.id + '/review', { adjuster_id: a.id }).status === 200, 'review'); ctx.assert(post('/claims/' + c.id + '/approve', {}).status === 200, 'approve'); ctx.assert(post('/claims/' + c.id + '/pay', { method: 'bank_transfer' }).status === 200, 'pay'); const first = ctx.advance('10d'); ctx.assert(first.jobsFailed.length === 0, 'no job failed'); ctx.assert(get('/claims/' + c.id).body.status === 'paid', 'still paid after 10 days'); const second = ctx.advance('21d'); ctx.assert(second.jobsFailed.length === 0, 'no job failed: ' + JSON.stringify(second.jobsFailed)); const end = get('/claims/' + c.id).body; ctx.assert(end.status === 'closed' && end.closed_at !== null, 'closed after 31 days, got ' + JSON.stringify(end)); const kinds = get('/claims/' + c.id + '/events').body.data.map((e) => e.kind); ctx.assert(kinds.includes('closed'), 'closed event, got ' + JSON.stringify(kinds)); const again = post('/claims/' + c.id + '/close', {}); ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'already closed: ' + JSON.stringify(again)); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_claims` | GET | /claims | List claims. Filters: status, policy_id, coverage_id, adjuster_id. Search description. Sort created_at, claimed_amount, submitted_at. |
| `get_claim` | GET | /claims/{id} | Read one claim. |
| `list_claim_events` | GET | /claims/{claim_id}/events | Audit trail of one claim, sortable by created_at. |
| `file_claim` | POST | /policies/{id}/claims | Action: file a claim against a policy coverage. |
| `start_review` | POST | /claims/{id}/review | Action: assign an adjuster and move a submitted claim to under_review. |
| `approve_claim` | POST | /claims/{id}/approve | Action: approve a claim in review, applying deductible and remaining limit. |
| `deny_claim` | POST | /claims/{id}/deny | Action: deny a submitted or under-review claim with a reason. |
| `pay_claim` | POST | /claims/{id}/pay | Action: pay out an approved claim and record the payment. |
| `close_claim` | POST | /claims/{id}/close | Action: close a paid or denied claim. |
| `raise_fraud_flag` | POST | /claims/{id}/fraud_flags | Action: raise a fraud flag on a live claim. |
| `resolve_fraud_flag` | POST | /fraud_flags/{id}/resolve | Action: clear or confirm an open fraud flag. Confirming denies the claim. |
| `list_fraud_flags` | GET | /fraud_flags | List flags. Filters: status, severity, claim_id, raised_by_id. Sort created_at. |
| `get_fraud_flag` | GET | /fraud_flags/{id} | Read one flag. |
| `list_policies` | GET | /policies | List policies. Filters: status, line, policyholder_id. Search policy_number. Sort end_date, created_at. |
| `get_policy` | GET | /policies/{id} | Read one policy. |
| `create_policy` | POST | /policies | Create a policy. Status starts active. |
| `update_policy` | PATCH | /policies/{id} | Edit policy number, dates, premium. Status is readonly. |
| `suspend_policy` | POST | /policies/{id}/suspend | Action: suspend an active policy. |
| `reinstate_policy` | POST | /policies/{id}/reinstate | Action: reinstate a suspended policy. |
| `list_coverages` | GET | /coverages | List coverages. Filters: policy_id, kind. Sort limit_amount. |
| `get_coverage` | GET | /coverages/{id} | Read one coverage with paid and reserved totals. |
| `create_coverage` | POST | /coverages | Add a coverage to a policy. |
| `update_coverage` | PATCH | /coverages/{id} | Edit limit and deductible. Paid and reserved totals are readonly. |
| `list_policyholders` | GET | /policyholders | List policyholders. Search name, email. Filter city. |
| `get_policyholder` | GET | /policyholders/{id} | Read one policyholder. |
| `create_policyholder` | POST | /policyholders | Create a policyholder. |
| `update_policyholder` | PATCH | /policyholders/{id} | Edit a policyholder. |
| `list_adjusters` | GET | /adjusters | List adjusters. Filters: specialty, active. Search name. |
| `get_adjuster` | GET | /adjusters/{id} | Read one adjuster. |
| `create_adjuster` | POST | /adjusters | Create an adjuster. |
| `update_adjuster` | PATCH | /adjusters/{id} | Edit an adjuster, such as deactivating. |
| `list_payments` | GET | /payments | List payouts. Filters: claim_id, policyholder_id, method. Sort paid_at, amount. |
| `get_payment` | GET | /payments/{id} | Read one payment. |

## Seed

- Rows per entity: policyholder: 30, adjuster: 8, policy: 40, coverage: 80, claim: 60, payment: 15, fraud_flag: 14, claim_event: 190
- Mix: Claims (60): submitted 12, under_review 16, approved 10, denied 8, paid 10, closed 4 (some closed after payment, some after denial). Policies (40): active about 30, suspended 5, expired 5. Coverages: 2 per policy, kinds spread over collision, liability, theft, fire, water_damage, medical, baggage, matching the policy line. Fraud flags (14): open 6 (several high severity, on under_review and approved claims), cleared 5, confirmed 3 (their claims are denied). Payments: one per paid claim and per paid-then-closed claim. Coverage paid_amount and reserved_amount equal the sums over seeded paid and approved claims, never above the limit. Several water_damage claims in under_review, some with open flags, each on a distinct coverage. Adjusters: 7 active, 1 inactive. All seed timestamps precede the clock start.

## Tasks

- `start_review_newest_submitted_claim` (easy): Assign adjuster Priya Nair to the most recently submitted claim, still in submitted status, on a named policyholder's policy, moving it to under_review.
  - Decoy idea: Reviews the oldest submitted claim of that policyholder, or uses a claim on another policy.
- `confirm_high_severity_fraud_flag` (medium): One policyholder has an under-review claim carrying an open high-severity fraud flag, alongside a medium-severity open flag on another of their claims. Confirm the high-severity flag with a resolution note that contains the word 'forged', so that claim is denied for fraud and the other claim is left alone. The grader checks that fraud_flag.resolution_note contains 'forged'.
  - Decoy idea: Denies the claim directly with deny_claim, which leaves the flag open. Or confirms the medium flag, or clears the high flag. Or confirms the right flag with a note that lacks the keyword.
- `approve_and_pay_clean_claim` (medium): A named policyholder's under-review collision claim has no fraud flags. Approve it, then pay it by bank transfer, so the deductible is applied and the coverage paid_amount rises by the approved amount.
  - Decoy idea: Approves but never pays. Or pays a different under-review claim of the same policyholder on another coverage.
- `approve_unflagged_water_damage_claims` (hard): Approve every under-review claim on a water_damage coverage that has no open fraud flag. The matching claims span several policies and more than one page of coverages and claims. Flagged claims must stay under review, and nothing else may change.
  - Decoy idea: Reads only the first page. Or approves flagged claims too, or approves under-review claims on other coverage kinds, or approves submitted claims instead of under-review ones.

## Open questions

- Is the deductible charged per claim or per policy term?
  - Default answer: Per claim. It is applied once to each claim before the limit cap.
- Is the coverage limit per claim or an aggregate for the policy term?
  - Default answer: An aggregate for the policy term, tracked through paid_amount plus reserved_amount.
- Should claims be editable by plain PATCH?
  - Default answer: No. Claims change only through actions so deductible, limit and fraud rules cannot be bypassed.
- Do partial payments or multiple payments per claim exist?
  - Default answer: No. One payment for the full approved amount.
- What does a confirmed fraud flag do?
  - Default answer: It denies the claim, releases any reserve, and denies it even from approved. A cleared flag simply removes the hold.
- Can suspended policies still pay already approved claims?
  - Default answer: Yes. Suspension blocks only new filings.
- What currency and time model apply?
  - Default answer: USD in cents. Time is fixed at 2026-10-07T09:00:00Z and moves only by explicit advance.

## Assumptions

- Clock starts 2026-10-07T09:00:00.000Z with tick 0s. Time moves only by explicit advance. Seed history lies before it. Policy end dates and the daily jobs lie after it.
  - Why: Fixed time makes timestamps such as submitted_at and paid_at exactly assertable. Historical events must precede the start.
- All money is USD in integer minor units (cents).
  - Why: Single currency keeps limits, deductibles and payouts unambiguous.
- The deductible applies once per claim: payable = max(0, claimed_amount - deductible). It is then capped at the coverage's remaining limit, limit_amount - paid_amount - reserved_amount. The limit is an aggregate for the policy term.
  - Why: This is the common property and casualty model and gives a deterministic payout formula.
- Approval reserves approved_amount on the coverage (reserved_amount up). Payment moves it from reserved_amount to paid_amount. Denial after approval, only through fraud confirmation, releases the reserve.
  - Why: Concurrent approved claims must not together exceed the limit.
- Approval is refused with 409 nothing_payable when the payable amount is zero. The claim stays under_review so the adjuster can deny it.
  - Why: A zero approval would be a silent no-op.
- There is no PATCH route for claims, payments, fraud flags or events. Claims, flags and payments change only through actions. Status fields are readonly everywhere.
  - Why: Money and state integrity: a plain PATCH must not bypass deductible, limit or fraud rules.
- Filing a claim is an action on /policies/{id}/claims, not a plain create route. The policy must be active, the coverage must belong to it, and the incident date must lie within the policy period and not after now.
  - Why: The checks need cross-entity rules a plain create cannot enforce. Errors are 409 policy_not_active and 422 coverage_mismatch, incident_outside_policy_period and incident_in_future.
- A suspended policy blocks new filings only. Claims already approved can still be paid.
  - Why: Keeps the rule small. A loss that happened under active cover stays payable.
- A claim has at most one payment, for the full approved_amount. There are no partial payments.
  - Why: Simplifies totals and grading.
- Fraud flags can be raised on submitted, under_review and approved claims. An open flag blocks approve_claim and pay_claim with 409 fraud_hold. Clearing releases the block. Confirming denies the claim with denial_reason starting 'fraud confirmed: '.
  - Why: Models real special-investigations holds and gives fraud flags observable consequences.
- The expire_policies job runs daily and expires active or suspended policies whose end_date has passed. The auto_close_paid job runs daily and closes claims paid at least 30 days ago.
  - Why: Gives time-driven behavior that tests can exercise with advance.
- Acceptance tests create every row through the API with unique values (@acceptance.test emails, ACC- policy numbers). Seed data must avoid these values.
  - Why: Tests run before any seed exists and must not collide with it.
- Standard create routes return 200 or 201. Actions file_claim and raise_fraud_flag return 201. All other actions return 200.
  - Why: Fixes the contract the acceptance tests assert.
- Error bodies use the default world template {error:{code,message}}. An unknown ref in an action input is refused by input validation with 400 input.invalid.
  - Why: Matches the engine defaults.
- The confirm_high_severity_fraud_flag instruction will require the resolution note to contain the keyword 'forged', and the grader checks fraud_flag.resolution_note for it, case-insensitively.
  - Why: A-388 free-text gate: the grader must read the text the solution writes, so nonsense scores below 1.

## Out of scope

- Underwriting, quoting, premium billing and renewals
  - Why: The world is about the claims lifecycle, not policy sales.
- Document, photo and attachment upload
  - Why: Not stateful records an agent edits through simple API calls.
- Partial payments, supplemental payments, subrogation and reinsurance
  - Why: Too much accounting for a small deterministic world.
- Claim reopening and appeals after denial
  - Why: Closed is final. This keeps the state machine small.
- Multi-currency, taxes and exchange rates
  - Why: Single-currency USD only.
- Authentication, user roles and permissions
  - Why: All calls are made as one trusted caller.
- Fraud scoring models and external data checks
  - Why: Fraud flags are human-raised records, not computation.

## Changes

- tasks.confirm_high_severity_fraud_flag
