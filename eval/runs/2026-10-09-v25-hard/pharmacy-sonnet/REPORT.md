Stopped: budget_exhausted

The run spent $2.8930 of its per-run budget maxCostUsd=$3.00 (this run only; set by --budget-usd or worldgen.config.json).

No world.yaml was written.

Last issues:

- `task.pressure_unmet` at `tasks.dispense_ready_fill_for_maria_lopez`: The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for dispense_ready_fill_for_maria_lopez.

## What was built

Nothing was handed over: the run stopped.

## Assumed and why

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

## Questions asked of the input

- Should technicians be allowed to dispense controlled fills once a pharmacist has approved them?
  - Default answer: Yes. Dispensing needs no staff input; only approval and rejection need a pharmacist.
- Do pending fills count against the refill allowance?
  - Default answer: Yes, every non-rejected fill request counts.
- Can a fill be split across lots?
  - Default answer: No. One lot must hold the whole fill quantity.
- Do expired or cancelled prescriptions auto-reject open fills?
  - Default answer: Cancelling rejects open fills. Expiry does not; a pharmacist must reject them.

## Left out

- Insurance claims, pricing and payments
  - Why: The core value is the stock and approval workflow, not billing.
- DEA/state controlled-substance reporting and drug-interaction checks
  - Why: External integrations and clinical decision support are not record workflows here.
- Authentication and user sessions
  - Why: The acting pharmacist is passed as an action input.
- Purchase orders and supplier management
  - Why: Lots arrive through the create route only.

## Proof

None. The run stopped, so this report claims no verified task.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 3.43 | 0.6848 |
| model | 1 | 0.49 | 0.3497 |
| workflow | 2 | 0.86 | 0.5468 |
| seed | 1 | 1.03 | 0.4207 |
| tasks | 2 | 3.58 | 0.8910 |
| Total | 8 | 9.40 | 2.8930 |

Run total: 9.43 minutes, $2.8930.
