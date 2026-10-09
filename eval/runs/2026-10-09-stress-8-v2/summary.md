# Eval run stress-8-v2, 2026-10-09

A targeted run on tag **v2.0.0 at `5600d0f3`**, to measure v2.0's generation changes:
- A-390: the few-shot example rotates by input, and a plan's tasks carry a kind and a hard multi-action task;
- A-388: the free-text gate;
- A-395: iterate admits an old world that fails only at the tasks layer.

Eight cases from the `stress` suite ran one at a time, one `bun run eval --only <case>` process each, into this one run directory. The settings were the same as stress-6 and stress-7: model `claude-sonnet-5-5` over the logged-in `claude-cli`, with $3 and 12 min per run. Spend went to an isolated ledger capped at $25 (`WORLDGEN_MAX_TOTAL_USD` and `WORLDGEN_MAX_DAILY_USD`). orders-csv ran first as the probe. After each case the run checked for a `spend_cap` or `cost_unenforceable` stop, and none came.

Each case directory keeps `case.json` and `events.jsonl`, plus `change/events.jsonl` for the iterate case. Each done case also keeps its `world/` (world.yaml, plan.yaml, plan.md, REPORT.md and capsule.json, without the attempt dumps under `runs/`), so a clone can check the measures below. `analyze-eval.json` is the output of `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-09-stress-8-v2`.

**Read these numbers with two limits in mind:**
- **There is no control arm.** No case ran the same day on a pre-v2 build. The comparisons below are with stress-6 (`42ab9ca9`) and stress-7 (`2da7dd17`), which ran on other days and builds, with one run per case. One run cannot separate v2's effect from run-to-run variation.
- **No suite case exercises A-395.** helpdesk-add-refunds iterates on a world this run had just created, which checks clean, so the admission path never ran.

## Headline

**6 of 8 pass.**
- bookmarks and stripe-charges, which stopped in stress-6, pass, as they did in stress-7.
- helpdesk-sla and petstore-store passed in stress-6 and stress-7, and stop here. Their causes are below.
- **Spend:** $14.03 over 9 runs (8 creates and 1 iterate). The same eight cases cost $8.27 in stress-6.
- **Time:** 50.9 min in all, against 38.1 min in stress-6. The p50 is 6.8 min per case and the max 8.4 min.
- **Validation:** analyze-eval reports 29 expected, 8 observed, 8 valid, 0 invalid and 6 passed. The 21 missing cases were left out by design, so `completeSuite` is false and the script exits 1.

| case | result | verify | min | $ | few-shot example (A-390) | stress-6 | stress-7 |
|---|---|---|--:|--:|---|---|---|
| orders-csv (probe) | done | pass (3 tasks) | 3.5 | 1.81 | helpdesk | done, 2.7 min, $0.63 | done, 3.0 min, $1.72 |
| helpdesk-sla | **stopped: budget_exhausted** | - | 8.4 | 2.86 | gen-hotel-booking | done, 4.8 min, $0.85 | done, 7.1 min, $1.50 |
| bookmarks | done | pass (3 tasks) | 8.3 | 1.49 | gen-hotel-booking | stopped: no_progress | done, 5.7 min, $1.03 |
| stripe-charges | done | pass (3 tasks) | 6.8 | 1.33 | helpdesk | stopped: attempts_exhausted | done, 5.1 min, $0.86 |
| petstore-store | **stopped: no_progress at workflow** | - | 3.7 | 0.81 | helpdesk | done, 5.1 min, $1.12 | done, 3.7 min, $0.63 |
| bakery-vague | done | pass (3 tasks) | 3.8 | 0.63 | gen-hotel-booking | done, 3.2 min, $1.26 | - |
| linear-description | done | pass (4 tasks), fidelity 1.000 (82/82) | 8.3 | 1.65 | helpdesk | done, 8.2 min, $1.31, fidelity 0.963 | - |
| helpdesk-add-refunds (iterate) | done, then change done | pass (4 tasks) | 8.1 | 3.46 | helpdesk | done, 7.7 min, $1.79 | - |

The example column is `pickExample` applied to each input digest in `capsule.json` (A-390: the first eight hex digits modulo 3). Five inputs got helpdesk, three got gen-hotel-booking, and none got retail-tau2.

## v2.0 generation measures (done worlds)

| world | plan has a hard task naming ≥ 2 actions | task kinds in the plan | references with at most one write (`prefix -`) |
|---|---|---|--:|
| orders-csv | yes | irreversible, two_actors | 1 of 3 |
| bookmarks | yes | irreversible, permissions | 1 of 3 |
| stripe-charges | yes | irreversible, scarce_resource | 1 of 3 |
| bakery-vague | yes | irreversible, scarce_resource, two_actors | 2 of 3 |
| linear-description | yes | irreversible, permissions, scarce_resource | 1 of 4 |
| helpdesk-add-refunds (after the change) | yes | permissions, two_actors | 2 of 4 |
| **total** | **6 of 6** | every plan has 2 or 3 kinds | **8 of 20 (40%)** |

- **Single writes:** a7's method counts the `prefix -` lines in `bun run worldplay verify <world>`, a reference with at most one successful write. On these six worlds it gives **8 of 20, or 40%**. At `5600d0f3`, the committed worlds give 52 of 95 (54.7%), and the generated worlds alone 44 of 84 (52.4%). The engine's `solutionWrites <= 1` from `checkWorld`'s verdicts gives the same 8 of 20.
- **Plans:** every done plan carries A-390's multi-action hard task and at least two kinds. No plan step was rejected for task variety. The 6 plan rejections in this run were all `schema.invalid` from older plan checks, each repaired on a later attempt:
  - an unbound rule test (bookmarks);
  - a missing `seed.stateMix` (orders-csv);
  - two actions with no acceptance test (petstore-store);
  - an undeclared action (stripe-charges).
- **A-388:** no tasks step was rejected with `task.freetext_unchecked`, so the free-text gate never fired in this run.

## The two stops, by root cause

| case | stop | root cause |
|---|---|---|
| helpdesk-sla | budget_exhausted, 8.4 min, $2.86 | The plan gave `assign_ticket_to_named_agent` a distractor pressure: a filtered agent list must return a row the reference leaves unchanged. The tasks step failed `task.pressure_unmet` twice, and the run backtracked to the plan. By then it had spent $2.15, against $1.50 for the whole stress-7 run. The replanned plan and model passed, and then the workflow call was refused under the $3 run budget. |
| petstore-store | no_progress at workflow, 3.7 min, $0.81 | The workflow step went back and forth. With `petId` and `quantity` required on `POST /store/orders`, as the source spec says, the plan's frozen acceptance tests failed (`snippet.runtime_error`), because they place orders without them. With them optional, `openapi.required_field_missing` failed. The issue set repeated on workflow attempts 2 and 4. The run stopped there and did not send the conflict back to the plan step that owns the tests. That check predates v2 (it is at stress-7's `2da7dd17` too), so the plan's tests are what differ from stress-7. |

Both are single runs, so neither shows by itself whether v2 made these cases worse. A control arm would.

## Scorecard

Generated by `bun run eval` at `5600d0f3` and written into this run directory after the last case. It appears below unchanged, except that its headings now sit under this section. Its 21 "not run" rows are the suite cases this targeted run left out.

### Eval run 2026-10-09-stress-8-v2

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| helpdesk-sla | done | stopped | budget_exhausted | plan 2, model 2, workflow 1, seed 1, tasks 2 | 8.4 | 2.86 | - | no world: last phase did not finish | ok | no |
| bakery-vague | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 3.8 | 0.63 | pass (3 tasks) | - | ok | yes |
| petstore-store | done | stopped | no_progress at workflow | plan 2, model 1, workflow 4 | 3.7 | 0.81 | - | - | ok | no |
| orders-csv | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 3.5 | 1.81 | pass (3 tasks) | - | ok | yes |
| helpdesk-add-refunds | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 2; change: plan 1, model 1, workflow 1, seed 1, tasks 2 | 8.1 | 3.46 | pass (4 tasks) | - | ok | yes |
| linear-description | done | done | - | plan 1, model 2, workflow 2, seed 2, tasks 3 | 8.3 | 1.65 | pass (4 tasks) | 1.000 (82/82) | ok | yes |
| bookmarks | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 8.3 | 1.49 | pass (3 tasks) | - | ok | yes |
| stripe-charges | done | done | - | plan 3, model 3, workflow 3, seed 1, tasks 1 | 6.8 | 1.33 | pass (3 tasks) | - | ok | yes |
| video-codec-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| library-holds | done | missing | - | - | unknown | unknown | - | - | - | no |
| billing-dunning | done | missing | - | - | unknown | unknown | - | - | - | no |
| todo-projects | done | missing | - | - | unknown | unknown | - | - | - | no |
| clinic-appointments | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| linear-backlog-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-partial-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| retail-tau2-known | done | missing | - | - | unknown | unknown | - | - | - | no |
| insurance-claims | done | missing | - | - | unknown | unknown | - | - | - | no |
| rental-fleet | done | missing | - | - | unknown | unknown | - | - | - | no |
| warehouse-inventory | done | missing | - | - | unknown | unknown | - | - | - | no |
| hotel-booking | done | missing | - | - | unknown | unknown | - | - | - | no |
| repair-desk | done | missing | - | - | unknown | unknown | - | - | - | no |
| course-enrollments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| shipments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-customers | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-full | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-add-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| forecast-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| live-market-feed-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |

**Totals:** 29 expected cases: 6 success, 0 expected refusal, 2 product failure, 0 infra failure, 21 not run; 50.9 min (8 of 29 cases); $14.03 (8 of 29 cases); 0 unlogged.

**Median and p95:** 6.8 min (8 of 29 cases) and 8.4 min (8 of 29 cases); $1.49 (8 of 29 cases) and $3.46 (8 of 29 cases).

**Pass rate:** 6/29 (21%), success and expected refusal over all 29 expected cases (21 not run).

**Outcomes:** success = an `expect: done` case that ended done and passed verify; expected refusal = an input_rejected stop on an impossible case (A-384); product failure = the wrong verdict on the prompt: any other verdict stop, an impossible case that ended done, or a failed verify; infra failure = a crash, a machinery stop, a stop with no logged reason, an unverified done world or an unreadable case.json; not run = a suite case with no case output.

### Missing or invalid

- `video-codec-impossible`: no case.json in the run directory
- `library-holds`: no case.json in the run directory
- `billing-dunning`: no case.json in the run directory
- `todo-projects`: no case.json in the run directory
- `clinic-appointments`: no case.json in the run directory
- `stripe-refunds`: no case.json in the run directory
- `linear-backlog-csv`: no case.json in the run directory
- `stripe-partial-refunds`: no case.json in the run directory
- `retail-tau2-known`: no case.json in the run directory
- `insurance-claims`: no case.json in the run directory
- `rental-fleet`: no case.json in the run directory
- `warehouse-inventory`: no case.json in the run directory
- `hotel-booking`: no case.json in the run directory
- `repair-desk`: no case.json in the run directory
- `course-enrollments-csv`: no case.json in the run directory
- `shipments-csv`: no case.json in the run directory
- `stripe-customers`: no case.json in the run directory
- `petstore-full`: no case.json in the run directory
- `petstore-add-refunds`: no case.json in the run directory
- `forecast-impossible`: no case.json in the run directory
- `live-market-feed-impossible`: no case.json in the run directory

### Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | fidelity.below_floor | 9 | Model the real software this world names: add the missing entity, field, state or route, under its real name or a listed synonym. |
| 2 | schema.invalid | 6 | Match the shape in prod/world-format.md. |
| 3 | openapi.required_field_missing | 4 | Add petId to the entity or action input behind POST /store/orders, under the spec's name, and make it required with no default: a field with a default may be left out of a request. |
| 4 | snippet.runtime_error | 4 | undefined is not an object (evaluating 'big.body.error.type') |
| 5 | task.pressure_unmet | 4 | The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for assign_ticket_to_named_agent. |

### Fidelity misses

- `linear-description` missed 0 of 82
