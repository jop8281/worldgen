# Eval run stress-5, 2026-10-08

This run reruns the six stress-4 product failures on `stabilize/main` `acb23bbb`, to measure the fixes made since stress-4. The settings are the same as stress-4: model `claude-sonnet-5-5` over `claude-cli`, $3 and 12 min per run, and the `stress` suite file.

- **Wave 1 (this commit):** the four cases whose fixes are on the trunk. They ran in two lanes, each a separate `bun run eval --only <cases> --out-dir ../eval/runs/2026-10-08-stress-5` process.
  - Lane 1: stripe-customers, stripe-charges, petstore-add-refunds.
  - Lane 2: billing-dunning.
- **Wave 2:** bookmarks and course-enrollments-csv. It waits for the YOS-246 PR.

Each case directory keeps `case.json` and `events.jsonl`, plus `change/events.jsonl` for a change case. Worlds, plans and attempt dumps stay out of the repo.

## Headline, wave 1

**3 of 4 pass, and all 4 got past the step where they stopped in stress-4.**

- **Validation.** `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-08-stress-5` reports 29 expected, 4 observed, 4 valid, 0 invalid and 25 missing. The 25 missing cases are not part of this rerun. Outcomes: 3 success and 1 product failure.
- **Time.** 19.7 min summed over 5 runs, 4 creates plus 1 change. Wall clock was 14.3 min, from 06:18:03Z to 06:32:19Z.
- **Spend.** $3.97 settled, from the `run_finished` events. There were no cancelled calls, no cost-admission refusals and no crashes.
- **Ledger against capsule.** Since YOS-250 (#82), `bun run costs --by run` files each `claude-cli` call under its run id, so the ledger now isolates each run.
  - For every run below, the ledger's total and event count equal the run's own figures.
  - For the stripe-customers, billing-dunning and stripe-charges runs, and the petstore-add-refunds change run, those figures are `capsule.json`'s `costUsd` and attempt count.
  - The petstore-add-refunds create run has no capsule left to compare. The change run rewrites `capsule.json` in the same world directory, so the create is checked against its `run_finished` event instead.

## Against stress-4

| case | issue and fix | stress-4 at `4b3d2be4` | stress-5 at `acb23bbb` | min | $ | ledger by run |
|---|---|---|---|--:|--:|---|
| billing-dunning | YOS-248, YOS-249 (#73) | stopped, backtrack_limit at tasks; plan 4, model 3, workflow 2, seed 1, tasks 1; 8.7 min, $1.82 | **done**, verify pass (3 tasks). Plan 2 (attempt 1 was invalid_output: `plan/seed/stateMix/payment` missing), then each step passed first try, with no backtrack. `run_20261008T061930Z_5fdef87e` | 5.5 | 0.91 | $0.9134, 6 calls, matches |
| stripe-charges | YOS-244 (#45) | stopped, no_progress at workflow (`route.duplicate_path`); 2.2 min, $0.51 | **done**, verify pass (3 tasks). Model 3: `plan.not_covered` GET /v1/charges/{id}, then `openapi.field_enum` on `object`, each fixed on retry. No backtrack. `run_20261008T062313Z_4f58aa5c` | 4.1 | 0.73 | $0.7282, 7 calls, matches |
| petstore-add-refunds | YOS-244 (#45), YOS-241 (#84) | stopped, no_progress at model (create); 1.4 min, $0.25 | **done**, verify pass (4 tasks). Create took 3.4 min and $0.60, with workflow 2 (`openapi.required_field_missing` quantity, fixed on retry). Change took 1.6 min and $0.71, each step first try. `run_20261008T062720Z_8b9f52c1`, `run_20261008T063043Z_c01e79d9` | 5.0 | 1.31 | create $0.6013, 6 calls; change $0.7069, 5 calls; both match |
| stripe-customers | YOS-244 (#45) | stopped, no_progress at model (4 × `plan.not_covered`); 1.7 min, $0.35 | stopped, **backtrack_limit at tasks**. Plan, model, workflow and seed each passed first try, so the YOS-244 stop is gone. It then hit a new defect, YOS-253, below. `run_20261008T061803Z_6ed5e1d9` | 5.2 | 1.02 | $1.0188, 10 calls, matches |

## The one failure: stripe-customers, YOS-253

The plan gave task `mark_delinquent_exempt` the pressure `states: [customer.active]`. The same plan says customer has no state field (`lifecycle.representation: removal`), so no seed can ever hold an `active` customer row. Tasks attempts 2, 3 and 4 raised `task.pressure_unmet` at `seed/customer` ("0 customer rows in active"). The run went back to seed twice, which used up its 2 backtracks, and then stopped.

Two defects let this happen. Both were checked against the code at `acb23bbb`.

- **A. The seed step of a create run never checks what the planned tasks need.** At that step the world has no tasks yet, so the engine report is never ok: its one error is `world.too_few_tasks`, which the judge defers to the tasks step. `blockingIssues` therefore judges the seed through `failedDone('seed')`, which leaves out `seedNeedIssues` (A-271). On create, those needs only shape the seed prompt. I re-checked the seed-time world offline from the tasks-1 prompt dump. `checkWorld` reports only `world.too_few_tasks`, and `seedNeedIssues` on that world returns the same `task.pressure_unmet` the tasks step later raised.
- **B. A pressure state that no seed can meet is never sent back to the plan.** The issue is filed under the seed step, so at tasks `decide()` backtracks to seed while backtracks remain. The A-285 rule that sends a repeated pressure miss to the plan is in a later branch, which this path never reaches. No plan check refuses a pressed state that no state field can hold.

## Next

Wave 2 runs bookmarks and course-enrollments-csv (YOS-246, YOS-247) once the YOS-246 PR is on the trunk. Spend so far is $3.97 of the roughly $12 approved for J73.

## Scorecard

Generated by `bun run eval` at `acb23bbb` after the last wave-1 case. It appears below unchanged, except that its headings now sit under this section.

### Eval run 2026-10-08-stress-5

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |
|---|---|---|---|---|--:|--:|---|---|---|
| billing-dunning | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 5.5 | 0.91 | pass (3 tasks) | ok | yes |
| stripe-customers | done | stopped | backtrack_limit at tasks | plan 1, model 1, workflow 1, seed 3, tasks 4 | 5.2 | 1.02 | - | ok | no |
| stripe-charges | done | done | - | plan 1, model 3, workflow 1, seed 1, tasks 1 | 4.1 | 0.73 | pass (3 tasks) | ok | yes |
| petstore-add-refunds | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1; change: plan 1, model 1, workflow 1, seed 1, tasks 1 | 5.0 | 1.31 | pass (4 tasks) | ok | yes |
| helpdesk-sla | done | missing | - | - | unknown | unknown | - | - | no |
| bakery-vague | done | missing | - | - | unknown | unknown | - | - | no |
| video-codec-impossible | stopped | missing | - | - | unknown | unknown | - | - | no |
| library-holds | done | missing | - | - | unknown | unknown | - | - | no |
| todo-projects | done | missing | - | - | unknown | unknown | - | - | no |
| clinic-appointments | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| petstore-store | done | missing | - | - | unknown | unknown | - | - | no |
| orders-csv | done | missing | - | - | unknown | unknown | - | - | no |
| linear-backlog-csv | done | missing | - | - | unknown | unknown | - | - | no |
| helpdesk-add-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-partial-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| retail-tau2-known | done | missing | - | - | unknown | unknown | - | - | no |
| linear-description | done | missing | - | - | unknown | unknown | - | - | no |
| insurance-claims | done | missing | - | - | unknown | unknown | - | - | no |
| bookmarks | done | missing | - | - | unknown | unknown | - | - | no |
| rental-fleet | done | missing | - | - | unknown | unknown | - | - | no |
| warehouse-inventory | done | missing | - | - | unknown | unknown | - | - | no |
| hotel-booking | done | missing | - | - | unknown | unknown | - | - | no |
| repair-desk | done | missing | - | - | unknown | unknown | - | - | no |
| course-enrollments-csv | done | missing | - | - | unknown | unknown | - | - | no |
| shipments-csv | done | missing | - | - | unknown | unknown | - | - | no |
| petstore-full | done | missing | - | - | unknown | unknown | - | - | no |
| forecast-impossible | stopped | missing | - | - | unknown | unknown | - | - | no |
| live-market-feed-impossible | stopped | missing | - | - | unknown | unknown | - | - | no |

**Totals:** 29 expected cases: 3 success, 0 expected refusal, 1 product failure, 0 infra failure, 25 not run; 19.7 min (4 of 29 cases); $3.97 (4 of 29 cases); 0 unlogged.

**Median and p95:** 5.0 min (4 of 29 cases) and 5.5 min (4 of 29 cases); $0.91 (4 of 29 cases) and $1.31 (4 of 29 cases).

**Pass rate:** 3/29 (10%), success and expected refusal over all 29 expected cases (25 not run).

### Missing or invalid

- `helpdesk-sla`: no case.json in the run directory
- `bakery-vague`: no case.json in the run directory
- `video-codec-impossible`: no case.json in the run directory
- `library-holds`: no case.json in the run directory
- `todo-projects`: no case.json in the run directory
- `clinic-appointments`: no case.json in the run directory
- `stripe-refunds`: no case.json in the run directory
- `petstore-store`: no case.json in the run directory
- `orders-csv`: no case.json in the run directory
- `linear-backlog-csv`: no case.json in the run directory
- `helpdesk-add-refunds`: no case.json in the run directory
- `stripe-partial-refunds`: no case.json in the run directory
- `retail-tau2-known`: no case.json in the run directory
- `linear-description`: no case.json in the run directory
- `insurance-claims`: no case.json in the run directory
- `bookmarks`: no case.json in the run directory
- `rental-fleet`: no case.json in the run directory
- `warehouse-inventory`: no case.json in the run directory
- `hotel-booking`: no case.json in the run directory
- `repair-desk`: no case.json in the run directory
- `course-enrollments-csv`: no case.json in the run directory
- `shipments-csv`: no case.json in the run directory
- `petstore-full`: no case.json in the run directory
- `forecast-impossible`: no case.json in the run directory
- `live-market-feed-impossible`: no case.json in the run directory

### Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | task.pressure_unmet | 3 | The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for mark_delinquent_exempt. |
| 2 | openapi.field_enum | 1 | Make object an enum or state field with the values charge. |
| 3 | openapi.required_field_missing | 1 | Add quantity to the entity or action input behind POST /store/orders, under the spec's name, and make it required with no default: a field with a default may be left out of a request. |
| 4 | plan.not_covered | 1 | Build what the plan says, or change the plan in the plan step. |
| 5 | schema.invalid | 1 | Match the shape in prod/world-format.md. |
