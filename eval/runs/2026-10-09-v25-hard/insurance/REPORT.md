# WorldGen report: Guidewire-style insurance claims desk (ClaimCenter-like)

Claims against policies are assigned to adjusters whose approval limits cap what they can approve. Fraud flags can put a claim on hold; approved claims are paid.

## What was built

Entities (4):

- `adjuster`: 6 seeded rows
- `policy`: 12 seeded rows
- `claim`: 30 seeded rows
- `fraud_flag`: 10 seeded rows

Routes (11):

- `list_adjusters`: GET /adjusters
- `create_adjuster`: POST /adjusters
- `get_adjuster`: GET /adjusters/{id}
- `list_policies`: GET /policies
- `create_policy`: POST /policies
- `get_policy`: GET /policies/{id}
- `list_claims`: GET /claims
- `create_claim`: POST /claims
- `get_claim`: GET /claims/{id}
- `list_fraud_flags`: GET /fraud_flags
- `get_fraud_flag`: GET /fraud_flags/{id}

Actions (6):

- `assign_claim`: POST /claims/{id}/assign
- `approve_claim`: POST /claims/{id}/approve
- `deny_claim`: POST /claims/{id}/deny
- `pay_claim`: POST /claims/{id}/pay
- `flag_claim`: POST /claims/{id}/flag
- `resolve_fraud_flag`: POST /fraud_flags/{id}/resolve

Jobs: none.

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; all seeded history is before it
  - Why: Deterministic time; no time-based rules
- Money is USD in cents
  - Why: Single currency simplifies limits
- Policy status is an enum (active, lapsed), not a workflow
  - Why: Lapsing is data, not an action in scope
- Claims are assigned once, from submitted only; no reassignment
  - Why: Keeps the state machine simple
- Claim states: submitted, assigned, approved, denied, paid; fraud flag states: open, cleared, confirmed
  - Why: Minimal realistic desk lifecycle
- Approval is blocked by an open fraud flag, a lapsed policy, an amount above the adjuster's limit, or an amount above the claimed amount or coverage limit
  - Why: Core business rules
- Confirming a fraud flag denies the claim unless it is paid; clearing leaves the claim unchanged
  - Why: Fraud outcome drives the claim
- Action errors use codes invalid_state, over_limit, fraud_hold, policy_lapsed, adjuster_inactive, all with status 409
  - Why: Distinct refusal reasons
- No jobs
  - Why: No time-driven behavior requested

## Questions asked of the input

- Can a claim be reassigned to another adjuster?
  - Default answer: No, assignment happens once from submitted.
- Is a partial payment allowed?
  - Default answer: No, pay pays the full approved amount once.
- Does a deductible reduce the approved amount?
  - Default answer: No, the adjuster sets the approved amount directly.

## Left out

- Payments to bank accounts, reserves and subrogation
  - Why: The desk only records approval and paid status
- Premium billing and policy renewals
  - Why: Not part of the claims desk
- Document attachments and notes
  - Why: Not needed for the stated behaviors

## Proof

The engine check passed: 6 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_88260ced5f7663eff61ef4ee4fd2721ddd669c17e6fd90fa419954806c3146d1`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| assign_submitted_claim | easy | 1.000 | 0.000 | 0.500 | n/a | declared (1); mutants 4/8 | `tid_e81cada09df951bfd6fcd85189d802733f50f12b02103954520fcae90648c146` |
| approve_within_limit | medium | 1.000 | 0.000 | 0.300, 0.600 | 0.600 | declared (2); mutants 4/8 | `tid_a91d3c4d47a925b39b7ea33d948cf8ecc3fb664639b26dd7cb7db59eb0af94b4` |
| review_holder_claims | hard | 1.000 | 0.000 | 0.400, 0.700 | 0.700 | declared (5); mutants 4/8 | `tid_6272dfa394bff8ca1dcb643cc4ec94286d83609da8fbdd853ee83165ee9bd0ec` |
| find_and_confirm_fraud | hard | 1.000 | 0.000 | 0.500, 0.000 | 0.500 | declared (3); mutants 3/8 | `tid_2dbf801eaa92798f1fddfd86b7768c8c02e004add4fc789c81ce0f74d7378c1e` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `assign_submitted_claim` 0.500: assigns the claim to Marcus Webster, the adjuster with the similar name, instead of Marcus Webb
- `approve_within_limit` 0.300: registers Sam Idris with a $50,000.00 limit, below the claimed amount, so the full approval is refused and the claim stays assigned
- `approve_within_limit` 0.600: registers Sam Idris correctly and assigns the claim but approves only $50,000.00 instead of the full claimed amount
- `review_holder_claims` 0.400: tries to approve every assigned claim of the holder, ignoring fraud holds, limits and the lapsed policy; the desk refuses the blocked ones, so only the clean claims are approved
- `review_holder_claims` 0.700: approves the clean claims and denies the lapsed one but never clears the false alarm flag, so the living room claim stays unapproved
- `find_and_confirm_fraud` 0.500: confirms the right high-severity flag but forgets to pay the holder's approved claim
- `find_and_confirm_fraud` 0.000: pays the holder's approved claim but confirms the open flag on a near-miss claim of another holder instead of the high-severity flag

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| assign_submitted_claim | easy | 1 | none | none | none declared |
| approve_within_limit | medium | 2 | none | adjuster | distractors: met; state: met |
| review_holder_claims | hard | 5 | none | claim | hard: met; distractors: met; state: met; state: met |
| find_and_confirm_fraud | hard | 3 | claim | claim | hard: met; paging: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Guidewire-style insurance claims desk (ClaimCenter-like), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.03 | 0.1242 |
| model | 1 | 0.35 | 0.0886 |
| workflow | 1 | 0.28 | 0.0977 |
| seed | 1 | 0.72 | 0.1359 |
| tasks | 2 | 3.86 | 0.5809 |
| Total | 6 | 6.23 | 1.0272 |

Run total: 6.24 minutes, $1.0272.
