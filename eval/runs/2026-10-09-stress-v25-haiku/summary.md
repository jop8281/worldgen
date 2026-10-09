# v2.5 stress, Haiku arm: the 29-case suite on `claude-haiku-5-5`, 2026-10-09

This arm asks whether `claude-haiku-5-5` can be the cheap default generator. It ran on trunk `f2a6f0ed`, the v2.5 candidate. That build is v2.0.0 plus #170 to #178, #180 and #183. It does not hold #179 (stress-8's two stops) or #181 (append-only solver turns), both still open, or #182 (one shared system prompt), merged after this run started.

The settings were those of the stress runs: the logged-in `claude-cli`, with $3 and 12 min per run. This arm shares one isolated ledger, capped at $30, with the Sonnet arm (`../2026-10-09-stress-v25-sonnet8/`). Two lanes took cases from one queue, the Sonnet arm's 8 first. Each lane had its own empty `TMPDIR`. The Haiku arm started first on one lane, with `video-codec-impossible` as the probe, and joined the shared queue at 15:59Z. No new case started after 17:48Z, so that the paid evidence ended by 18:00Z.

Each run case keeps `case.json` and `events.jsonl` (plus `change/events.jsonl` for the iterate case). Each done case also keeps `world/` (world.yaml, plan.yaml, plan.md, REPORT.md and capsule.json, without the attempt dumps). `analyze-eval.json` is the output of `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-09-stress-v25-haiku`.

## Headline

**13 of 21 cases run pass, for $5.20 and 186.3 min of runs.** 8 of the 29 were still queued at the 17:48Z cut-off and did not run: course-enrollments-csv, shipments-csv, stripe-customers, stripe-charges, petstore-full, petstore-add-refunds, forecast-impossible, live-market-feed-impossible.

- **Against stress-6 (Sonnet, `42ab9ca9`) on the same 21 cases:** 20 passed there, for $20.59 and 108.5 min. Haiku passes 13, for $5.20 and 186.3 min.
- **Against this run's Sonnet arm on the 7 cases both ran:** Sonnet passes 6, for $11.30. Haiku passes 4, for $1.77.
- **Haiku's stops:** 4 × stage_time_exhausted at model; 1 × stage_time_exhausted at tasks; 1 × stage_time_exhausted at workflow; 1 × time_exhausted; 1 × stage_time_exhausted at seed.
- **Validation:** analyze-eval reports 29 expected, 21 observed, 21 valid, 0 invalid and 13 passed. The cases not run show as missing, so `completeSuite` is false.

| case | Haiku (this arm) | min | $ | stress-6, Sonnet | v2.5 Sonnet arm |
|---|---|--:|--:|---|---|
| helpdesk-sla | **stopped: stage_time_exhausted at model** | 10.3 | 0.25 | pass, 4.8 min, $0.85 | stopped: attempts_exhausted |
| bakery-vague | done, verify pass (3 tasks) | 7.3 | 0.16 | pass, 3.2 min, $1.26 | pass, 3.9 min, $0.76 |
| video-codec-impossible | refused (expected) | 0.1 | 0.01 | pass, 0.1 min, $0.03 | - |
| library-holds | done, verify pass (3 tasks) | 10.7 | 0.20 | pass, 7.1 min, $1.17 | - |
| billing-dunning | done, verify pass (3 tasks) | 8.3 | 0.19 | pass, 6.5 min, $1.01 | - |
| todo-projects | done, verify pass (3 tasks) | 8.0 | 0.10 | pass, 3.8 min, $0.60 | - |
| clinic-appointments | done, verify pass (3 tasks) | 9.9 | 0.12 | pass, 4.6 min, $0.73 | - |
| stripe-refunds | done, verify pass (3 tasks) | 8.3 | 0.18 | pass, 4.5 min, $0.77 | - |
| petstore-store | done, verify pass (3 tasks) | 7.9 | 0.09 | pass, 5.1 min, $1.12 | pass, 4.5 min, $0.69 |
| orders-csv | done, verify pass (3 tasks) | 8.1 | 0.10 | pass, 2.7 min, $0.63 | pass, 4.5 min, $1.79 |
| linear-backlog-csv | done, verify pass (3 tasks) | 6.5 | 0.37 | pass, 3.9 min, $0.95 | - |
| helpdesk-add-refunds | done, then change done, verify pass (3 tasks) | 13.4 | 0.73 | pass, 7.7 min, $1.79 | pass, 8.3 min, $3.11 |
| stripe-partial-refunds | done, then change done, verify pass (3 tasks) | 9.6 | 0.24 | pass, 7.3 min, $1.19 | - |
| retail-tau2-known | **stopped: stage_time_exhausted at tasks** | 11.8 | 0.31 | pass, 8.8 min, $1.71 | - |
| linear-description | **stopped: stage_time_exhausted at workflow** | 11.0 | 0.21 | pass, 8.2 min, $1.31 | pass, 6.5 min, $1.46 |
| insurance-claims | **stopped: stage_time_exhausted at model** | 8.2 | 0.19 | pass, 7.4 min, $1.36 | - |
| bookmarks | **stopped: stage_time_exhausted at model** | 8.7 | 0.23 | stopped: no_progress at workflow | pass, 7.4 min, $1.29 |
| rental-fleet | **stopped: time_exhausted** | 10.6 | 0.54 | pass, 5.1 min, $1.01 | - |
| warehouse-inventory | **stopped: stage_time_exhausted at seed** | 9.8 | 0.42 | pass, 5.8 min, $1.02 | - |
| hotel-booking | **stopped: stage_time_exhausted at model** | 11.9 | 0.45 | pass, 5.5 min, $0.88 | - |
| repair-desk | done, verify pass (3 tasks) | 5.9 | 0.11 | pass, 2.5 min, $0.45 | - |
| course-enrollments-csv | not run | - | - | pass, 3.5 min, $0.84 | - |
| shipments-csv | not run | - | - | pass, 3.3 min, $0.74 | - |
| stripe-customers | not run | - | - | pass, 3.4 min, $0.57 | - |
| stripe-charges | not run | - | - | stopped: attempts_exhausted at model | pass, 8.2 min, $1.57 |
| petstore-full | not run | - | - | pass, 4.4 min, $0.69 | - |
| petstore-add-refunds | not run | - | - | pass, 5.6 min, $1.27 | - |
| forecast-impossible | not run | - | - | pass, 0.1 min, $0.03 | - |
| live-market-feed-impossible | not run | - | - | pass, 0.2 min, $0.03 | - |

## v2.0 generation measures on Haiku's done worlds

- **A-390 plans:** 12 of 12 have a hard task naming two or more distinct actions. These kinds appear: irreversible, permissions, scarce_resource, two_actors.
- **Single writes:** 21 of 36 references make at most one write (`prefix -` in `worldplay verify`). The Sonnet arm counted 13 of 22. At `5600d0f3` the committed worlds give 52 of 95.

**Limits:**
- Each case ran once, so a single stop is not a rate.
- The comparison with stress-6 crosses builds and days.
- Cases that did not run are not counted either way.
- No case exercises A-395.

## Scorecard

Generated by `bun run eval` at `f2a6f0ed` and written into this run directory after the last case. It appears below unchanged, except that its headings now sit under this section. Its rows for cases this arm did not run read "missing".

### Eval run 2026-10-09-stress-v25-haiku

Suite `stress`, model `claude-haiku-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| helpdesk-sla | done | stopped | stage_time_exhausted at model | plan 3, model 1, workflow 1, seed 1, tasks 2 | 10.3 | 0.25 | - | no world: last phase did not finish | ok | no |
| bakery-vague | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 2 | 7.3 | 0.16 | pass (3 tasks) | - | ok | yes |
| video-codec-impossible | stopped | stopped | input_rejected | plan 1 | 0.1 | 0.01 | - | - | ok | yes |
| library-holds | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 10.7 | 0.20 | pass (3 tasks) | - | ok | yes |
| billing-dunning | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 8.3 | 0.19 | pass (3 tasks) | - | ok | yes |
| todo-projects | done | done | - | plan 3, model 3, workflow 2, seed 2, tasks 3 | 8.0 | 0.10 | pass (3 tasks) | - | ok | yes |
| clinic-appointments | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 9.9 | 0.12 | pass (3 tasks) | - | ok | yes |
| stripe-refunds | done | done | - | plan 3, model 1, workflow 1, seed 1, tasks 2 | 8.3 | 0.18 | pass (3 tasks) | - | ok | yes |
| petstore-store | done | done | - | plan 2, model 1, workflow 1, seed 2, tasks 2 | 7.9 | 0.09 | pass (3 tasks) | - | ok | yes |
| orders-csv | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 2 | 8.1 | 0.10 | pass (3 tasks) | - | ok | yes |
| linear-backlog-csv | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 6.5 | 0.37 | pass (3 tasks) | - | ok | yes |
| helpdesk-add-refunds | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1; change: plan 2, model 1, workflow 3, tasks 1 | 13.4 | 0.73 | pass (3 tasks) | - | ok | yes |
| stripe-partial-refunds | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1; change: plan 1, workflow 1 | 9.6 | 0.24 | pass (3 tasks) | - | ok | yes |
| retail-tau2-known | done | stopped | stage_time_exhausted at tasks | plan 2, model 1, workflow 1, seed 1, tasks 2 | 11.8 | 0.31 + unknown | - | no world: last phase did not finish | unlogged | no |
| linear-description | done | stopped | stage_time_exhausted at workflow | plan 2, model 2, workflow 3, seed 1, tasks 1 | 11.0 | 0.21 + unknown | - | no world: last phase did not finish | unlogged | no |
| insurance-claims | done | stopped | stage_time_exhausted at model | plan 3, model 2, workflow 2 | 8.2 | 0.19 | - | - | ok | no |
| bookmarks | done | stopped | stage_time_exhausted at model | plan 3, model 1, workflow 2 | 8.7 | 0.23 | - | - | ok | no |
| rental-fleet | done | stopped | time_exhausted | plan 1, model 1, workflow 1, seed 2, tasks 2 | 10.6 | 0.54 | - | - | ok | no |
| warehouse-inventory | done | stopped | stage_time_exhausted at seed | plan 3, model 2, workflow 3, seed 1 | 9.8 | 0.42 + unknown | - | - | unlogged | no |
| hotel-booking | done | stopped | stage_time_exhausted at model | plan 3, model 1, workflow 1, seed 1, tasks 2 | 11.9 | 0.45 | - | - | ok | no |
| repair-desk | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 5.9 | 0.11 | pass (3 tasks) | - | ok | yes |
| course-enrollments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| shipments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-customers | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-charges | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-full | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-add-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| forecast-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| live-market-feed-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |

**Totals:** 29 expected cases: 12 success, 1 expected refusal, 8 product failure, 0 infra failure, 8 not run; 186.4 min (21 of 29 cases); $5.21 (21 of 29 cases) + unknown billing for 3 call(s); 3 unlogged.

**Median and p95:** 8.7 min (21 of 29 cases) and 11.9 min (21 of 29 cases); $0.20 (21 of 29 cases) and $0.54 (21 of 29 cases).

**Pass rate:** 13/29 (45%), success and expected refusal over all 29 expected cases (8 not run).

**Outcomes:** success = an `expect: done` case that ended done and passed verify; expected refusal = an input_rejected stop on an impossible case (A-384); product failure = the wrong verdict on the prompt: any other verdict stop, an impossible case that ended done, or a failed verify; infra failure = a crash, a machinery stop, a stop with no logged reason, an unverified done world or an unreadable case.json; not run = a suite case with no case output.

### Missing or invalid

- `course-enrollments-csv`: no case.json in the run directory
- `shipments-csv`: no case.json in the run directory
- `stripe-customers`: no case.json in the run directory
- `stripe-charges`: no case.json in the run directory
- `petstore-full`: no case.json in the run directory
- `petstore-add-refunds`: no case.json in the run directory
- `forecast-impossible`: no case.json in the run directory
- `live-market-feed-impossible`: no case.json in the run directory

### Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | schema.invalid | 54 | Match the shape in prod/world-format.md. |
| 2 | snippet.runtime_error | 44 | undefined is not an object (evaluating 'ctx.time.plus') |
| 3 | fidelity.below_floor | 12 | Model the real software this world names: add the missing entity, field, state or route, under its real name or a listed synonym. |
| 4 | task.pressure_unmet | 12 | The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for assign_active_member_in_project. |
| 5 | test.failed | 12 | order create failed: {"error":{"code":"field.type","message":"Invalid write to new order: number expected a string matching /^#W[0-9]{7}$/, found \"QA-REF-A1\""}} |

### Unlogged

- `retail-tau2-known` create: 1 cancelled call(s) have unknown cost; totals include known cost only
- `linear-description` create: 1 cancelled call(s) have unknown cost; totals include known cost only
- `warehouse-inventory` create: 1 cancelled call(s) have unknown cost; totals include known cost only
