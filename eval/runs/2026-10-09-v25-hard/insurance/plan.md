# WorldGen plan: Guidewire-style insurance claims desk (ClaimCenter-like)

Claims against policies are assigned to adjusters whose approval limits cap what they can approve. Fraud flags can put a claim on hold; approved claims are paid.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `adjuster` | Claims adjuster with an approval limit | name, approval_limit, active |
| `policy` | Insurance policy with coverage limit and status | number, holder_name, coverage_limit, status |
| `claim` | Claim against a policy moving through the desk | number, policy_id, adjuster_id, amount_claimed, approved_amount, status |
| `fraud_flag` | Fraud suspicion on a claim, open until cleared or confirmed | claim_id, severity, reason, status |

## Workflows

### claim_lifecycle (claim)
- States: submitted, assigned, approved, denied, paid
- Actions: assign_claim, approve_claim, deny_claim, pay_claim, flag_claim
- Rules:
  - Only a submitted claim can be assigned, and only to an active adjuster Enforced by: assign_claim. Tested by: t_assign
  - An adjuster can approve only up to their approval limit; the approved amount cannot exceed the amount claimed or the policy coverage limit Enforced by: approve_claim. Tested by: t_limit
  - A claim with an open fraud flag cannot be approved Enforced by: approve_claim, flag_claim. Tested by: t_fraud_block
  - A claim on a lapsed policy cannot be approved; an assigned claim can be denied once Enforced by: approve_claim, deny_claim. Tested by: t_lapsed
  - Only an approved claim can be paid, once Enforced by: pay_claim. Tested by: t_pay
### fraud_review (fraud_flag)
- States: open, cleared, confirmed
- Actions: resolve_fraud_flag
- Rules:
  - Resolving an open flag as confirmed denies its claim unless the claim is paid; cleared leaves the claim as is; a resolved flag cannot be resolved again Enforced by: resolve_fraud_flag. Tested by: t_confirm

## Jobs

None. The plan declares no job.

## Acceptance tests

### t_assign
- Intent: Assigning moves a submitted claim to assigned and refuses repeats and inactive adjusters
- Actions: assign_claim
- Description: Assign a claim, assign again, assign to an inactive adjuster

```js
(ctx) => {
const a = ctx.api('POST','/adjusters',{name:'ACC Test Adjuster A',approval_limit:100000,active:true});
ctx.assert(a.status===201,'adjuster create '+JSON.stringify(a.body));
const p = ctx.api('POST','/policies',{number:'ACC-TP-1',holder_name:'ACC Test Holder',coverage_limit:500000,status:'active'});
ctx.assert(p.status===201,'policy create');
const c = ctx.api('POST','/claims',{number:'ACC-TC-1',policy_id:p.body.id,amount_claimed:50000,description:'Water damage'});
ctx.assert(c.status===201 && c.body.status==='submitted','claim create');
const r = ctx.api('POST','/claims/'+c.body.id+'/assign',{adjuster_id:a.body.id});
ctx.assert(r.status===200 && r.body.status==='assigned' && r.body.adjuster_id===a.body.id,'assign '+JSON.stringify(r.body));
const r2 = ctx.api('POST','/claims/'+c.body.id+'/assign',{adjuster_id:a.body.id});
ctx.assert(r2.status===409 && r2.body.error.code==='invalid_state','second assign refused');
const b = ctx.api('POST','/adjusters',{name:'ACC Test Adjuster B',approval_limit:100000,active:false});
const c2 = ctx.api('POST','/claims',{number:'ACC-TC-2',policy_id:p.body.id,amount_claimed:1000,description:'Scratch'});
const r3 = ctx.api('POST','/claims/'+c2.body.id+'/assign',{adjuster_id:b.body.id});
ctx.assert(r3.status===409 && r3.body.error.code==='adjuster_inactive','inactive adjuster refused');
}
```
### t_limit
- Intent: Approval is capped by the adjuster's approval limit
- Actions: assign_claim, approve_claim
- Description: Approve above limit fails, within limit succeeds

```js
(ctx) => {
const a = ctx.api('POST','/adjusters',{name:'ACC Limit Adjuster',approval_limit:100000,active:true});
const p = ctx.api('POST','/policies',{number:'ACC-TP-2',holder_name:'ACC Limit Holder',coverage_limit:500000,status:'active'});
const c = ctx.api('POST','/claims',{number:'ACC-TC-3',policy_id:p.body.id,amount_claimed:150000,description:'Roof collapse'});
ctx.assert(ctx.api('POST','/claims/'+c.body.id+'/assign',{adjuster_id:a.body.id}).status===200,'assign');
const r = ctx.api('POST','/claims/'+c.body.id+'/approve',{approved_amount:150000});
ctx.assert(r.status===409 && r.body.error.code==='over_limit','over limit refused '+JSON.stringify(r.body));
const r2 = ctx.api('POST','/claims/'+c.body.id+'/approve',{approved_amount:90000});
ctx.assert(r2.status===200 && r2.body.status==='approved' && r2.body.approved_amount===90000,'approve within limit '+JSON.stringify(r2.body));
}
```
### t_fraud_block
- Intent: An open fraud flag blocks approval until it is cleared
- Actions: assign_claim, flag_claim, approve_claim, resolve_fraud_flag
- Description: Flag, approve refused, clear, approve succeeds

```js
(ctx) => {
const a = ctx.api('POST','/adjusters',{name:'ACC Fraud Adjuster',approval_limit:100000,active:true});
const p = ctx.api('POST','/policies',{number:'ACC-TP-3',holder_name:'ACC Fraud Holder',coverage_limit:500000,status:'active'});
const c = ctx.api('POST','/claims',{number:'ACC-TC-4',policy_id:p.body.id,amount_claimed:20000,description:'Theft'});
ctx.api('POST','/claims/'+c.body.id+'/assign',{adjuster_id:a.body.id});
const f = ctx.api('POST','/claims/'+c.body.id+'/flag',{severity:'high',reason:'Duplicate submission'});
ctx.assert(f.status===201 && f.body.status==='open' && f.body.claim_id===c.body.id,'flag '+JSON.stringify(f.body));
const r = ctx.api('POST','/claims/'+c.body.id+'/approve',{approved_amount:20000});
ctx.assert(r.status===409 && r.body.error.code==='fraud_hold','approve blocked '+JSON.stringify(r.body));
const cl = ctx.api('POST','/fraud_flags/'+f.body.id+'/resolve',{outcome:'cleared'});
ctx.assert(cl.status===200 && cl.body.status==='cleared','cleared');
const r2 = ctx.api('POST','/claims/'+c.body.id+'/approve',{approved_amount:20000});
ctx.assert(r2.status===200 && r2.body.status==='approved','approve after clearing');
}
```
### t_lapsed
- Intent: A lapsed policy blocks approval; an assigned claim can be denied once
- Actions: assign_claim, approve_claim, deny_claim
- Description: Approve on lapsed policy refused, deny works once

```js
(ctx) => {
const a = ctx.api('POST','/adjusters',{name:'ACC Lapsed Adjuster',approval_limit:100000,active:true});
const p = ctx.api('POST','/policies',{number:'ACC-TP-4',holder_name:'ACC Lapsed Holder',coverage_limit:500000,status:'lapsed'});
const c = ctx.api('POST','/claims',{number:'ACC-TC-5',policy_id:p.body.id,amount_claimed:10000,description:'Collision'});
ctx.api('POST','/claims/'+c.body.id+'/assign',{adjuster_id:a.body.id});
const r = ctx.api('POST','/claims/'+c.body.id+'/approve',{approved_amount:10000});
ctx.assert(r.status===409 && r.body.error.code==='policy_lapsed','lapsed refused '+JSON.stringify(r.body));
const d = ctx.api('POST','/claims/'+c.body.id+'/deny',{reason:'Policy lapsed'});
ctx.assert(d.status===200 && d.body.status==='denied' && d.body.deny_reason==='Policy lapsed','deny '+JSON.stringify(d.body));
const d2 = ctx.api('POST','/claims/'+c.body.id+'/deny',{reason:'Again'});
ctx.assert(d2.status===409 && d2.body.error.code==='invalid_state','second deny refused');
}
```
### t_pay
- Intent: Only approved claims can be paid, once
- Actions: assign_claim, approve_claim, pay_claim
- Description: Pay before approval fails, after approval succeeds, repeat fails

```js
(ctx) => {
const a = ctx.api('POST','/adjusters',{name:'ACC Pay Adjuster',approval_limit:100000,active:true});
const p = ctx.api('POST','/policies',{number:'ACC-TP-5',holder_name:'ACC Pay Holder',coverage_limit:500000,status:'active'});
const c = ctx.api('POST','/claims',{number:'ACC-TC-6',policy_id:p.body.id,amount_claimed:30000,description:'Fire'});
ctx.api('POST','/claims/'+c.body.id+'/assign',{adjuster_id:a.body.id});
const e = ctx.api('POST','/claims/'+c.body.id+'/pay',{});
ctx.assert(e.status===409 && e.body.error.code==='invalid_state','pay before approval refused');
ctx.api('POST','/claims/'+c.body.id+'/approve',{approved_amount:30000});
const r = ctx.api('POST','/claims/'+c.body.id+'/pay',{});
ctx.assert(r.status===200 && r.body.status==='paid','paid '+JSON.stringify(r.body));
const r2 = ctx.api('POST','/claims/'+c.body.id+'/pay',{});
ctx.assert(r2.status===409 && r2.body.error.code==='invalid_state','second pay refused');
}
```
### t_confirm
- Intent: Confirming a fraud flag denies the claim and cannot be repeated
- Actions: assign_claim, flag_claim, resolve_fraud_flag
- Description: Flag, confirm, claim denied, resolve again refused

```js
(ctx) => {
const a = ctx.api('POST','/adjusters',{name:'ACC Confirm Adjuster',approval_limit:100000,active:true});
const p = ctx.api('POST','/policies',{number:'ACC-TP-6',holder_name:'ACC Confirm Holder',coverage_limit:500000,status:'active'});
const c = ctx.api('POST','/claims',{number:'ACC-TC-7',policy_id:p.body.id,amount_claimed:40000,description:'Jewelry loss'});
ctx.api('POST','/claims/'+c.body.id+'/assign',{adjuster_id:a.body.id});
const f = ctx.api('POST','/claims/'+c.body.id+'/flag',{severity:'medium',reason:'Inconsistent statements'});
ctx.assert(f.status===201,'flag');
const r = ctx.api('POST','/fraud_flags/'+f.body.id+'/resolve',{outcome:'confirmed'});
ctx.assert(r.status===200 && r.body.status==='confirmed','confirmed '+JSON.stringify(r.body));
const cl = ctx.api('GET','/claims/'+c.body.id);
ctx.assert(cl.body.status==='denied','claim denied after confirmation');
const r2 = ctx.api('POST','/fraud_flags/'+f.body.id+'/resolve',{outcome:'cleared'});
ctx.assert(r2.status===409 && r2.body.error.code==='invalid_state','resolved flag cannot be resolved again');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_adjusters` | GET | /adjusters | List adjusters |
| `create_adjuster` | POST | /adjusters | Create an adjuster |
| `get_adjuster` | GET | /adjusters/{id} | Get an adjuster |
| `list_policies` | GET | /policies | List policies filtered by number, holder_name, status |
| `create_policy` | POST | /policies | Create a policy |
| `get_policy` | GET | /policies/{id} | Get a policy |
| `list_claims` | GET | /claims | List claims filtered by status, policy_id, adjuster_id, number |
| `create_claim` | POST | /claims | File a claim (status submitted) |
| `get_claim` | GET | /claims/{id} | Get a claim |
| `list_fraud_flags` | GET | /fraud_flags | List fraud flags filtered by claim_id, status, severity |
| `get_fraud_flag` | GET | /fraud_flags/{id} | Get a fraud flag |

## Seed

- Rows per entity: adjuster: 6, policy: 12, claim: 30, fraud_flag: 10
- Mix: Claims across all states; adjusters with limits from 5000 to 250000 USD; one lapsed policy or two; open flags on assigned claims, confirmed flags on denied claims; near-miss claims with the same holder, a claim just over an adjuster's limit and one just under; past page one of claims for the investigation target.
- State mix: claim: submitted 25%, assigned 30%, approved 20%, denied 10%, paid 15%; fraud_flag: open 40%, cleared 35%, confirmed 25%

## Tasks

- `assign_submitted_claim` (easy): Assign a named submitted claim to a named active adjuster
  - Actions: `assign_claim`
  - Decoy idea: Assigns a different submitted claim with a similar number or the wrong adjuster with the same first name
- `approve_within_limit` (medium, permissions): A submitted claim of known amount must be assigned to an active adjuster whose approval limit covers it, then approved for the full amount
  - Actions: `assign_claim`, `approve_claim`
  - Decoy idea: Assigns to the first adjuster listed whose limit is too low, so approval is refused, or to an inactive adjuster with a high limit
  - Pressure: seeded rows in claim.submitted; distractor rows of adjuster
- `review_holder_claims` (hard, policy_conflict): For one policyholder's assigned claims: approve those with no open fraud flag, within limit and on an active policy, clear a flag the instruction says is a false alarm then approve, and deny the claim under a lapsed policy; leave over-limit claims untouched
  - Actions: `approve_claim`, `resolve_fraud_flag`, `deny_claim`
  - Decoy idea: Approves every claim, ignoring fraud holds and limits, or skips the cleared-flag claim
  - Pressure: seeded rows in claim.assigned, fraud_flag.open; distractor rows of claim
- `find_and_confirm_fraud` (hard, investigation): Find the claim past the first page by combining holder name, amount and an open high-severity flag, confirm that flag, and pay the same holder's other approved claim
  - Actions: `resolve_fraud_flag`, `pay_claim`
  - Decoy idea: Stops at the first page of claims or confirms the flag on a near-miss claim with the same amount but a different holder
  - Pressure: paging past the first page of claim; seeded rows in fraud_flag.open, claim.approved; distractor rows of claim

## Open questions

- Can a claim be reassigned to another adjuster?
  - Default answer: No, assignment happens once from submitted.
- Is a partial payment allowed?
  - Default answer: No, pay pays the full approved amount once.
- Does a deductible reduce the approved amount?
  - Default answer: No, the adjuster sets the approved amount directly.

## Assumptions

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

## Out of scope

- Payments to bank accounts, reserves and subrogation
  - Why: The desk only records approval and paid status
- Premium billing and policy renewals
  - Why: Not part of the claims desk
- Document attachments and notes
  - Why: Not needed for the stated behaviors

## Changes

None. The plan changes no existing item.
