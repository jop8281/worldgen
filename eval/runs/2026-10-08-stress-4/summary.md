# Eval run stress-4, 2026-10-08

The 29-case `stress` suite ran once on the hand-in candidate, main `4b3d2be4`. Model `claude-sonnet-5-5` over `claude-cli`, with $3 and 12 min per run. It started with one probe case, `video-codec-impossible`. Then two lanes of 14 cases ran in parallel, each a separate `bun run eval --only` process writing into this one run directory, so the generated scorecard at the bottom has all 29 rows. Each case directory keeps `case.json` and `events.jsonl`, plus `change/events.jsonl` for a change case. Worlds, plans and attempt dumps stay out of the repo.

The scorecard was rendered by the eval code at `4b3d2be4`. After the tag, #37 put one classifier on main, with the pass rate over all expected cases. This run has no not-run case, so both rates are 23/29 here. Other runs need the same check before their rates are compared.

## Headline

**23 of 29 pass (79%).** 20 success, 3 expected refusal, 6 product failure, 0 infra failure and 0 not run.

- **Validation.** `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-08-stress-4` at `4b3d2be4` reports 29 expected, 29 observed, 29 valid, 0 invalid, 0 missing, `completeSuite: true` and 23 passed.
- **Time.** 140.2 min summed over 31 runs: 29 creates plus 2 changes. p50 5.1 min, p95 10.3 min, max 11.5 min (library-holds). Wall clock was 82.5 min, from 03:32:53Z to 04:55:22Z.
- **Spend.** $26.71 settled, from the `run_finished` events. One more call was cancelled at its step share, bookmarks seed attempt 3. Its final billing is unknown, and its observed partial usage was $0.20. The shared ledger does not tag `claude-cli` rows with a run id, so `bun run costs --by run` lists them under `(no run)` and cannot isolate this run.
- **Infrastructure.** No session-limit cut, no cost-admission refusal and no crash.

## Against the targets

| issue | target | stress-4 | met |
|---|---|---|---|
| YOS-53 | at least 70% of the fixed full suite | 23/29, 79% | yes |
| YOS-54 | at least 85%, or an explicit reason for each failure | 79%, and each of the 6 failures has a root cause and an issue below | reasons given, 85% not reached |
| YOS-54 | median run at most 10 min | p50 5.1 min | yes |
| YOS-54 | every run within 15 min | max 11.5 min | yes |

## Product failures by root cause

Each failure was first root-caused from its events and attempt dumps. A second read-only pass then tried to refute the root cause against the code at `4b3d2be4`. The table keeps only what survived that pass.

| case | stop | root cause | issue |
|---|---|---|---|
| stripe-charges | no_progress at workflow | The model step declared a placeholder route on POST /v1/charges to clear `plan.not_covered`. The workflow action `create_charge` then failed `route.duplicate_path` twice. | YOS-244 |
| stripe-customers | no_progress at model | The plan routes list only `list_customers`. The model left create, retrieve, update and delete to workflow actions, so 4 × `plan.not_covered` landed on the model step, which cannot build actions. Attempts 1 and 3 failed on that, and attempt 2 on an `openapi.field_enum` miss, so the issue set repeated. | YOS-244 |
| petstore-add-refunds | no_progress at model (create) | The plan routes omit three /store operations and plan PUT /pet as PUT /pet/{id}, so the same `plan.not_covered` landed on the model step. Mixed in is a second defect: a frozen test reads `body.error.code`, but the Petstore error template is `{code, type, message}`, so the test threw. | YOS-244 |
| billing-dunning | backtrack_limit at tasks | Two frozen tests threw at the model step because workflow builds the routes they call. `snippet.runtime_error` is not a test-run code, so it went back to plan (backtrack 1). A real test bug, `new Date`, cost backtrack 2. At tasks, a first-page `GET /customers?limit=25` lookup counted as paging, so `seed.too_few_rows_for_paging` blocked with no backtrack left. | YOS-248, YOS-249 |
| bookmarks | stage_time_exhausted at seed | Seed attempt 1 was one `activity_log` row short (39 of 40). Attempt 2 answered only that snippet. It was judged on the world from before the step, so all 9 entities came out empty, and seed escalated to high effort. Attempt 3's prompt no longer held attempt 1's seed, and it spent its whole 265 s share thinking with no answer bytes. | YOS-246 |
| course-enrollments-csv | no_progress at seed | The model typed the date-only CSV column `enrolled_on` as datetime. The seed wrote `T09:00`, which failed CSV fidelity on 208 rows. It then wrote the date-only form, which failed the engine, then `T09:00` again, because the retry prompt held only the last issue. Seed issues never route back to the model step's field type. | YOS-247, YOS-246 |

**YOS-244** has its fix on `stabilize/main` and `main` as `af01b691` (#45, A-342), which is not in `4b3d2be4`. The fix rejects, at the plan step, an OpenAPI plan whose routes leave out an input operation. Four other OpenAPI cases passed in this run: petstore-store, petstore-full, stripe-refunds and stripe-partial-refunds.

**YOS-246 to 249** are new children of YOS-53, filed from this run. Each defect is still present on `stabilize/main` `d0b85a8a`.

**Paging backtracks in passing cases.** Five passing cases also paid a tasks-to-seed backtrack on `seed.too_few_rows_for_paging`: helpdesk-sla, library-holds, rental-fleet, stripe-refunds and todo-projects. helpdesk-sla's came from first-page `?limit=25` lookups, so YOS-249 would save that seed rerun.

## Against stress-2

Stress-2 ran on main `3ff2c3a` and passed 22 of 29. Stress-4 passes 23. Each case ran once in each run.

| change | cases |
|---|---|
| fail to pass (5) | petstore-store, stripe-partial-refunds, hotel-booking, rental-fleet, petstore-full |
| pass to fail (4) | billing-dunning, bookmarks, course-enrollments-csv, stripe-charges |
| fail in both (2) | petstore-add-refunds, stripe-customers, both YOS-244 |

Each of the 4 new failures passed in stress-2, and billing-dunning also passed in stress-3. In each one, the stop path depends on what the model chose in that sample: a placeholder route, a datetime type, a partial seed answer, or a lookup with `limit`. They are intermittent, not new deterministic breaks. The issues above remove those paths, so the same choice can no longer stop a run.

## Infra failures, not-run cases and the rerun plan

There are no infra failures and no not-run cases. Rerun plan for the product failures:

1. On a SHA that has `af01b691`, rerun the three YOS-244 cases with `bun run eval --only stripe-charges,stripe-customers,petstore-add-refunds --budget-usd 3 --max-minutes 12`. This is YOS-244's acceptance.
2. Rerun billing-dunning, bookmarks and course-enrollments-csv once YOS-246 to 249 land.
3. Run the full suite again as stress-5 on the next promoted main, with the same settings and at most 2 lanes.

## Scorecard

Generated by `bun run eval` at `4b3d2be4` and written into this run directory after the last case. It appears below unchanged, except that its headings now sit under this section.

### Eval run 2026-10-08-stress-4

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| helpdesk-sla | done | done | - | plan 1, model 1, workflow 1, seed 2, tasks 2 | 6.3 | 1.21 | pass (3 tasks) | 0.957 (68/71) | ok | yes |
| bakery-vague | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 3.1 | 0.58 | pass (3 tasks) | - | ok | yes |
| video-codec-impossible | stopped | stopped | input_rejected | plan 1 | 0.1 | 0.03 | - | - | ok | yes |
| library-holds | done | done | - | plan 1, model 1, workflow 1, seed 2, tasks 2 | 11.5 | 1.98 | pass (3 tasks) | - | ok | yes |
| billing-dunning | done | stopped | backtrack_limit at tasks | plan 4, model 3, workflow 2, seed 1, tasks 1 | 8.7 | 1.82 | - | - | ok | no |
| todo-projects | done | done | - | plan 1, model 1, workflow 1, seed 2, tasks 2 | 6.0 | 0.91 | pass (3 tasks) | - | ok | yes |
| clinic-appointments | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 4.8 | 0.75 | pass (3 tasks) | - | ok | yes |
| stripe-refunds | done | done | - | plan 1, model 2, workflow 1, seed 2, tasks 3 | 6.6 | 1.37 | pass (3 tasks) | - | ok | yes |
| petstore-store | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 3.6 | 0.55 | pass (3 tasks) | - | ok | yes |
| orders-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 2.5 | 0.63 | pass (3 tasks) | - | ok | yes |
| linear-backlog-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 2 | 4.1 | 1.15 | pass (3 tasks) | - | ok | yes |
| helpdesk-add-refunds | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1; change: plan 1, model 1, workflow 1, seed 1, tasks 2 | 10.3 | 2.03 | pass (4 tasks) | - | ok | yes |
| stripe-partial-refunds | done | done | - | plan 1, model 2, workflow 1, seed 1, tasks 1; change: plan 1, workflow 1 | 5.8 | 1.01 | pass (3 tasks) | - | ok | yes |
| retail-tau2-known | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 5.8 | 0.91 | pass (3 tasks) | 0.891 (66/74) | ok | yes |
| linear-description | done | done | - | plan 1, model 2, workflow 2, seed 2, tasks 2 | 5.2 | 1.30 | pass (3 tasks) | 0.963 (79/82) | ok | yes |
| insurance-claims | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 6.6 | 1.10 | pass (3 tasks) | - | ok | yes |
| bookmarks | done | stopped | stage_time_exhausted at seed | plan 2, model 1, workflow 1, seed 3 | 9.8 | 1.10 + unknown | - | - | unlogged | no |
| rental-fleet | done | done | - | plan 1, model 1, workflow 1, seed 2, tasks 3 | 8.1 | 1.86 | pass (3 tasks) | - | ok | yes |
| warehouse-inventory | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 6.5 | 1.16 | pass (3 tasks) | - | ok | yes |
| hotel-booking | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 2 | 5.2 | 1.02 | pass (3 tasks) | - | ok | yes |
| repair-desk | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 2 | 3.6 | 0.66 | pass (3 tasks) | - | ok | yes |
| course-enrollments-csv | done | stopped | no_progress at seed | plan 1, model 1, workflow 1, seed 3 | 1.6 | 0.74 | - | - | ok | no |
| shipments-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 3.5 | 0.80 | pass (3 tasks) | - | ok | yes |
| stripe-customers | done | stopped | no_progress at model | plan 1, model 3 | 1.7 | 0.35 | - | - | ok | no |
| stripe-charges | done | stopped | no_progress at workflow | plan 1, model 2, workflow 2 | 2.2 | 0.51 | - | - | ok | no |
| petstore-full | done | done | - | plan 2, model 2, workflow 3, seed 1, tasks 1 | 5.1 | 0.89 | pass (3 tasks) | - | ok | yes |
| petstore-add-refunds | done | stopped | no_progress at model | plan 1, model 2 | 1.4 | 0.25 | - | - | ok | no |
| forecast-impossible | stopped | stopped | input_rejected | plan 1 | 0.1 | 0.03 | - | - | ok | yes |
| live-market-feed-impossible | stopped | stopped | input_rejected | plan 1 | 0.2 | 0.03 | - | - | ok | yes |

**Totals:** 29 expected cases: 20 success, 3 expected refusal, 6 product failure, 0 infra failure, 0 not run; 140.2 min (29 of 29 cases); $26.71 (29 of 29 cases) + unknown billing for 1 call(s); 1 unlogged.

**Median and p95:** 5.1 min (29 of 29 cases) and 10.3 min (29 of 29 cases); $0.91 (29 of 29 cases) and $1.98 (29 of 29 cases).

**Pass rate:** 23/29 (79%), success and expected refusal over the 29 cases that ran (0 not run).

### Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | plan.not_covered | 19 | Build what the plan says, or change the plan in the plan step. |
| 2 | plan.seed_rows_short | 10 | The seed made 0. Seed the planned count, or change rowsPerEntity in the plan step. |
| 3 | layer.blocked | 9 | Not checked because the references layer failed. Fix those issues first. |
| 4 | snippet.runtime_error | 9 | undefined is not an object (evaluating 'bad.body.error.code') |
| 5 | fidelity.below_floor | 7 | Model the real software this world names: add the missing entity, field, state or route, under its real name or a listed synonym. |

### Unlogged

- `bookmarks` create: 1 cancelled call(s) have unknown cost; totals include known cost only

### Fidelity misses

- `helpdesk-sla` field.missing ticket.type (1): ticket has no field named type or ticket_type, kind
- `helpdesk-sla` state.missing ticket.status.hold (1): status has no state named hold
- `helpdesk-sla` route.missing GET /search (1): no route or action for GET /search
- `helpdesk-sla` missed 3 of 71
- `retail-tau2-known` field.missing user.zip (1): user has no field named zip or zip_code, postal_code
- `retail-tau2-known` state.missing order.status.processed (1): status has no state named processed
- `retail-tau2-known` state.missing order.status.pending_item_modified (1): status has no state named pending_item_modified
- `retail-tau2-known` state.missing order.status.return_requested (2): status has no state named return_requested
- `retail-tau2-known` state.missing order.status.exchange_requested (2): status has no state named exchange_requested
- `retail-tau2-known` route.missing GET /products/{id} (1): no route or action for GET /products/{id}
- `retail-tau2-known` missed 8 of 74
- `linear-description` field.missing issue_label.name (2): issue_label has no field named name
- `linear-description` field.missing issue_label.color (1): issue_label has no field named color or colour
- `linear-description` missed 3 of 82
