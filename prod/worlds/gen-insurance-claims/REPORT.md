# WorldGen report: Guidewire ClaimCenter / Lemonade-style P&C insurance claims API (policies, coverages, claims, payouts, fraud flags)

An insurance claims world. Policyholders hold policies with per-coverage limits and per-claim deductibles. Claims are filed against a coverage, reviewed by an adjuster, approved with the deductible and the remaining limit applied (reserving money on the coverage), then paid out, or denied. Adjusters raise fraud flags that block approval and payout until they are cleared or confirmed. Confirming fraud denies the claim and releases the reserve. Jobs expire policies and auto-close old paid claims.

## What was built

Entities (8):

- `policyholder`: 30 seeded rows
- `adjuster`: 8 seeded rows
- `policy`: 40 seeded rows
- `coverage`: 80 seeded rows
- `claim`: 60 seeded rows
- `payment`: 12 seeded rows
- `fraud_flag`: 14 seeded rows
- `claim_event`: 178 seeded rows

Routes (23):

- `list_claims`: GET /claims
- `get_claim`: GET /claims/{id}
- `list_claim_events`: GET /claims/{claim_id}/events
- `list_fraud_flags`: GET /fraud_flags
- `get_fraud_flag`: GET /fraud_flags/{id}
- `list_policies`: GET /policies
- `get_policy`: GET /policies/{id}
- `create_policy`: POST /policies
- `update_policy`: PATCH /policies/{id}
- `list_coverages`: GET /coverages
- `get_coverage`: GET /coverages/{id}
- `create_coverage`: POST /coverages
- `update_coverage`: PATCH /coverages/{id}
- `list_policyholders`: GET /policyholders
- `get_policyholder`: GET /policyholders/{id}
- `create_policyholder`: POST /policyholders
- `update_policyholder`: PATCH /policyholders/{id}
- `list_adjusters`: GET /adjusters
- `get_adjuster`: GET /adjusters/{id}
- `create_adjuster`: POST /adjusters
- `update_adjuster`: PATCH /adjusters/{id}
- `list_payments`: GET /payments
- `get_payment`: GET /payments/{id}

Actions (10):

- `file_claim`: POST /policies/{id}/claims
- `start_review`: POST /claims/{id}/review
- `approve_claim`: POST /claims/{id}/approve
- `deny_claim`: POST /claims/{id}/deny
- `pay_claim`: POST /claims/{id}/pay
- `close_claim`: POST /claims/{id}/close
- `raise_fraud_flag`: POST /claims/{id}/fraud_flags
- `resolve_fraud_flag`: POST /fraud_flags/{id}/resolve
- `suspend_policy`: POST /policies/{id}/suspend
- `reinstate_policy`: POST /policies/{id}/reinstate

Jobs (2):

- `expire_policies`: every 1d
- `auto_close_paid`: every 1d

## Changes

- snippet_changed `tasks.confirm_high_severity_fraud_flag.grader`
- item_changed `tasks.confirm_high_severity_fraud_flag.instruction`
- snippet_changed `tasks.confirm_high_severity_fraud_flag.solution`

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 10 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_44e89e39667b44433bf15661a8ecf2c5511308317ec3f7bd6c23862743cd5693`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| start_review_newest_submitted_claim | easy | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | legacy; mutants 6/8 | `tid_b528a823c2768b5d51694e64ab4b9758b52ac229e5a5f1ac8a11506ff4a47c39` |
| confirm_high_severity_fraud_flag | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.000 | n/a | legacy; mutants 5/8 | `tid_d30cf5eba7938ff9849a66c0ff34255498638c33cbf50bed06cb5934dc9985de` |
| approve_and_pay_clean_claim | medium | 1.000 | 0.000 | 0.300, 0.000, 0.300, 0.000 | 0.300 | legacy; mutants 6/8 | `tid_b67d5d49a82f8d73b3e1bc153d6dbfe373feff9c482d26e5f940656293939bdb` |
| approve_unflagged_water_damage_claims | hard | 1.000 | 0.000 | 0.800, 0.000, 0.000, 0.000 | 0.800 | legacy; mutants 5/8 | `tid_95e84d7a2497c679ac5378691e90ba29bb706ea9a28b0cdbcdad072bf9636790` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `start_review_newest_submitted_claim` 0.000: reviews the oldest submitted claim of the policyholder instead of the most recently submitted one
- `start_review_newest_submitted_claim` 0.000: assigns the wrong adjuster, the first active adjuster in the list, to the right claim
- `start_review_newest_submitted_claim` 0.000: reviews the right claim, then also starts review of an unrelated submitted claim from another policyholder
- `confirm_high_severity_fraud_flag` 0.000: denies the claim directly with deny_claim, so the high flag stays open and is never confirmed
- `confirm_high_severity_fraud_flag` 0.000: confirms the medium severity flag on her other claim instead of the high one
- `confirm_high_severity_fraud_flag` 0.000: clears the high severity flag instead of confirming it, so the claim is not denied
- `confirm_high_severity_fraud_flag` 0.000: confirms every open flag on both of her claims, denying the other claim too
- `approve_and_pay_clean_claim` 0.300: approves the claim but never pays it
- `approve_and_pay_clean_claim` 0.000: approves and pays his other under-review claim, on the liability coverage, instead of the collision claim
- `approve_and_pay_clean_claim` 0.300: approves and pays the right claim by check instead of bank transfer
- `approve_and_pay_clean_claim` 0.000: approves and pays every under-review claim of the policyholder, not only the collision claim
- `approve_unflagged_water_damage_claims` 0.800: treats any fraud flag, even a cleared one, as blocking and so skips an approvable claim
- `approve_unflagged_water_damage_claims` 0.000: clears the open fraud flags to get around the fraud hold and approves the flagged claims too
- `approve_unflagged_water_damage_claims` 0.000: ignores the coverage kind and approves every under-review claim that can be approved
- `approve_unflagged_water_damage_claims` 0.000: also starts review and approves submitted water damage claims, reading under review as not yet approved

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| start_review_newest_submitted_claim | easy | 2 | none | claim | none declared |
| confirm_high_severity_fraud_flag | medium | 4 | none | claim | none declared |
| approve_and_pay_clean_claim | medium | 5 | none | claim | none declared |
| approve_unflagged_water_damage_claims | hard | 15 | none | claim, coverage | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.08 | 0.1043 |
| tasks | 1 | 0.22 | 0.2814 |
| Total | 2 | 0.30 | 0.3857 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures; it keeps 2 issue(s) the world had before this iterate: plan.seed_rows_short

Run total: 0.36 minutes, $0.3857.
