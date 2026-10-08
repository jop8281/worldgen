# Stress run 1 (YOS-53)

Run on 2026-10-06 (2026-10-07 UTC) from branch `research/stress-run-1` at `65bea67` (stabilize/main). Cases ran one at a time with `bun src/cli/eval.ts --only <id> --budget-usd 1.5 --max-minutes 12 --out-dir eval/runs/2026-10-06-stress1/<id>`, under `nice -n 15`, with `WORLDGEN_MAX_DAILY_USD=180 WORLDGEN_MAX_TOTAL_USD=300`. The driver checked load and the spend ledger before each case. Bun 1.4.2 worked, so no tsx fallback was needed.

## Scorecard

Merged from the 14 per-case `summary.md` files. Suite `stress`, model `claude-sonnet-5-5`, budget $1.50 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| bakery-vague | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| billing-dunning | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| clinic-appointments | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| helpdesk-add-refunds | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| helpdesk-sla | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | no world: last phase did not finish | ok | no |
| library-holds | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| linear-description | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | no world: last phase did not finish | ok | no |
| orders-csv | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| petstore-store | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| retail-tau2-known | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | no world: last phase did not finish | ok | no |
| stripe-partial-refunds | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| stripe-refunds | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| todo-projects | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| video-codec-impossible | stopped | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |

**Totals:** 14 cases: 0 done, 14 stopped, 0 crashed; 0.0 min; $0.00; 0 unlogged.

**Pass rate:** 0/14 (0%). `video-codec-impossible` expects a stop, but a `model_error` stop is not an honest stop, so it also fails.

## Triage

One generic cause covers every case.

| # | generic cause | stage | count | cases | example event |
|---|---|---|--:|---|---|
| 1 | `model_error`: claude CLI exits 127 on the first call | plan, attempt 1 | 14 | all 14 | `eval/runs/2026-10-06-stress1/helpdesk-sla/helpdesk-sla/world/runs/run_20261007T041828Z_512fd86d/events.jsonl` |

Example line from that file:

```
{"t":"attempt","step":"plan","n":1,"ms":294,"costUsd":0,"outcome":{"kind":"model_error","message":"claude -p exited 127: \"claude\" could not run, often a shell shim or wrapper that is not on PATH outside your terminal. Point WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json at the real binary (try ~/.local/bin/claude): Error: claude not found in PATH"}}
```

Each case's `events.jsonl` sits at `eval/runs/2026-10-06-stress1/<id>/<id>/world/runs/<runId>/events.jsonl`. Every one holds the same four events and stops within 400 ms.

### Root cause

The first `claude` on PATH is a cmux terminal shim (`~/.cmuxterm/cmux-cli-shims/<id>/claude`). It removes its own directory from PATH and runs `exec claude`. The real binary is `~/.local/bin/claude`, which is not on PATH, so the shim exits 127. `makeModel` in `code/src/cli/models.ts` only checked that an executable file named `claude` exists on PATH. The shim passed that check. Each case then started a run, failed its first model call, and wrote a stopped case record. One environment problem became 14 case failures.

### Fix

`makeModel` now runs `<bin> --version` after the existence check. A non-zero exit throws a one-line usage error that names the exit status, the last stderr line, and the fix (`WORLDGEN_CLAUDE_BIN`, `claudeBin`, or `--transport sdk`). The worldgen, eval and dataset CLIs all build their model through `makeModel`, so each one now stops before any run directory or ledger entry. See A-108 in `decisions.md`.

The fix does not choose a different binary on its own. Live rerun of the suite with `WORLDGEN_CLAUDE_BIN=~/.local/bin/claude` is left for a later job.

## Spend

The ledger (`~/.worldgen/costs.jsonl`, shared with other sessions) read $68.0528 all time before the first case and $71.1819 after the last. Every run in this stress run recorded `costUsd: 0` and made no model call that succeeded, so this run spent **$0.00**. The $3.13 rise came from other sessions using the same ledger.

## Run 1b

Run on 2026-10-06 (2026-10-07 UTC) from branch `research/stress-run-1b` at `cbcb7ef` (stabilize/main), the first live run. Cases ran one at a time with `bun src/cli/eval.ts --only <id> --budget-usd 1.75 --max-minutes 12 --out-dir eval/runs/stress-1b/_<id>` under `nice -n 15`, with `WORLDGEN_CLAUDE_BIN=$HOME/.local/bin/claude WORLDGEN_MAX_DAILY_USD=180 WORLDGEN_MAX_TOTAL_USD=300`. helpdesk-sla ran first as the smoke run into `eval/runs/stress-1b/` and reached the model ($1.67, done). The driver waited while load was above 80 and summed `run_finished.costUsd` from this run's events before each case, with a $25 cap for the job.

### Scorecard

The merged table is `eval/runs/stress-1b/summary.md`.

| case | expect | result | stop reason | attempts per step | min | $ | verify | pass |
|---|---|---|---|---|--:|--:|---|---|
| bakery-vague | done | stopped | time_exhausted | plan 1 | 23.7 | 0.08 | - | no |
| billing-dunning | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1 | 9.8 | 1.28 | pass (3 tasks) | yes |
| clinic-appointments | done | done | - | plan 1, model 1, workflow 1, seed 2, tasks 1 | 7.7 | 1.08 | pass (3 tasks) | yes |
| helpdesk-add-refunds | done | stopped | change: budget_exhausted | create: 1 each; change: plan 1, model 1, workflow 2, seed 1 | 15.8 | 2.57 | - | no |
| helpdesk-sla | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1 | 4.5 | 1.67 | pass (3 tasks) | yes |
| library-holds | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 11.3 | 1.36 | pass (3 tasks) | yes |
| linear-description | done | stopped | no_progress at seed | plan 1, model 1, workflow 3, seed 3 | 10.0 | 1.73 | - | no |
| orders-csv | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1 | 3.6 | 0.80 | pass (3 tasks) | yes |
| petstore-store | done | stopped | stage_time_exhausted at model | plan 1, model 1, workflow 2, seed 2, tasks 1 | 6.6 | 1.10 | - | no |
| retail-tau2-known | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 9.7 | 1.25 | pass (4 tasks) | yes |
| stripe-partial-refunds | done | stopped | stage_time_exhausted at model | plan 1, model 1, workflow 2, seed 2, tasks 1 | 10.7 | 1.44 | - | no |
| stripe-refunds | done | stopped | stage_time_exhausted at model | plan 1, model 1, workflow 1, seed 1, tasks 1 | 8.4 | 1.06 | - | no |
| todo-projects | done | done | - | plan 1, model 1, workflow 2, seed 3, tasks 1 | 6.6 | 1.04 | pass (3 tasks) | yes |
| video-codec-impossible | stopped | done | - | plan 1, model 1, workflow 1, seed 2, tasks 1 | 10.5 | 1.33 | pass (3 tasks) | no |

**Totals:** 14 cases, 8 done, 6 stopped, 0 crashed. **Pass rate:** 7/14. Every world that finished passed verify.

### Triage of the 7 failures

| # | generic cause | stage | count | cases | $ | example events.jsonl |
|---|---|---|--:|---|--:|---|
| 1 | `openapi.field_type` / `openapi.field_enum` found only at the last step, backtrack to model, then `stage_time_exhausted` with share 0 | tasks -> model | 3 | stripe-refunds, stripe-partial-refunds, petstore-store | 3.60 | `eval/runs/stress-1b/_stripe-refunds/stripe-refunds/world/runs/run_20261007T055305Z_f9a4ba5c/events.jsonl` |
| 2 | `no_progress` at seed: `snippet.runtime_error` (a zero duration such as `"0d"`) alternating with `test.failed` (seed rows clash with test keys) | seed | 1 | linear-description | 1.73 | `eval/runs/stress-1b/_linear-description/linear-description/world/runs/run_20261007T063218Z_d631e304/events.jsonl` |
| 3 | Impossible prompt not refused: the plan reframed it as an encoder control plane with `verdict: proceed` | plan | 1 | video-codec-impossible | 1.33 | `eval/runs/stress-1b/_video-codec-impossible/video-codec-impossible/world/runs/run_20261007T050626Z_57c7ddaf/events.jsonl` |
| 4 | `budget_exhausted` on the change run: iterate reran every stage for "add refunds" and spent $1.67 of $1.75 before tasks | seed -> tasks | 1 | helpdesk-add-refunds | 2.57 | `eval/runs/stress-1b/_helpdesk-add-refunds/helpdesk-add-refunds/world/runs/run_20261007T064907Z_359b0dc8/events.jsonl` |
| 5 | Environment: `time_exhausted` after 23.7 min on a 12 min limit, one model call in flight while the laptop slept (pmset shows sleep until 22:06 local) | model | 1 | bakery-vague | 0.08 | `eval/runs/stress-1b/_bakery-vague/bakery-vague/world/runs/run_20261007T044243Z_e93ac6dc/events.jsonl` |

Example lines, cut to the fields that matter:

```
1  {"t":"backtracked","from":"tasks","to":"model","because":[{"code":"openapi.field_type","path":["input","openapi","GET /v1/refunds","response","has_more"],"found":"string"},{"code":"openapi.field_enum","path":["input","openapi","GET /v1/refunds/{refund}","response","failure_reason"]}]}
   {"t":"call_refused","step":"model","reason":{"kind":"stage_time_exhausted","step":"model","shareMs":0},"estimateMs":4950.5,"remainingMs":218749}
2  {"t":"attempt","step":"seed","n":3,"outcome":{"kind":"rejected","issues":[{"code":"snippet.runtime_error","path":["seed","project"],"found":"threw Duration \"0d\" is zero; use at least 1s"}]}}
3  plan.yaml: verdict: { kind: proceed }; summary: "A video codec is not an HTTP API, so this world models the control plane of a real-time video encoding service."
4  {"t":"call_refused","step":"tasks","reason":{"kind":"budget_exhausted","spentUsd":1.6743064,"limitUsd":1.75}}
5  {"t":"run_finished","ms":1420911,"costUsd":0.0773166,"result":{"kind":"stopped","reason":{"kind":"time_exhausted","minutes":12}}}
```

Repairs that did not stop a run: the same zero-duration seed error cost a seed retry in 5 cases (clinic-appointments, petstore-store, todo-projects, video-codec-impossible, linear-description), and `test.failed` at workflow cost a retry in 3.

### Root cause of cause 1

`judgeCandidate` in `code/src/worldgen/run.ts` ran `openapiFidelity` only on a checked world at the last step. A create run has no checked world before tasks, because the engine reports `world.too_few_tasks` until the tasks step writes them. So a departure in a route field the model step built waited for the end of the run. The policy then backtracked to model, and `stepShareMs` reserved the later steps' shares (46% of `maxMinutes`) out of 3.6 to 5.4 minutes left, which gave model a share of 0.

### Fix (A-110)

`openapiFidelity` takes a `World`, since `openApiOf` already did. The model step runs it on its candidate once its own sections pass and rejects on `openapi.field_type` and `openapi.field_enum`. Missing operations, statuses and request fields still wait for the last step, because workflow actions can supply them. The test `runWorldGen create: OpenAPI fidelity at the model step` in `code/test/worldgen.test.ts` fails on stabilize/main and passes with the fix.

The fix does not by itself turn the three cases green, and no live rerun was made. Inferred from the issue paths above:
- `failure_reason` (an entity field) now surfaces in the model step's first minute.
- `has_more` is the list envelope's cursor key, which code writes into `meta`. No step can fix it until Stripe paging lands (PR #190, open). Both Stripe cases now stop at model, cheaper, instead of after a full pass.
- petstore's `POST /store/orders` request `status` is the input of the `place_order` action, which the workflow step builds. It still surfaces at the last step, and the issue's owner (`routes`, so model) is the wrong stage for an action input.
- The share-0 backtrack is a separate policy gap: a backtrack target's share should count only the steps that rerun.

### Spend

**$17.78** from this run's 15 `run_finished` events (helpdesk-add-refunds has a create and a change run). The bakery-vague call that was in flight during sleep logged no attempt, so its cost, if any, is not in that number. The shared ledger is not used here because other sessions spend on it and its entries carry no run id.

## Stress run 2

On 2026-10-07 the full 29-case `stress` suite ran on main `3ff2c3a`, which had been promoted and qualified on Bun and Node. Four parallel lanes ran with $3 and 12 minutes per run. The scorecard, the comparison and every case's events are in [eval/runs/2026-10-07-stress-2/summary.md](../../eval/runs/2026-10-07-stress-2/summary.md).

**Totals:** 29 cases, 19 done, 10 stopped (3 of them expected refusals), 0 crashed. **Pass rate:** 22/29 (75.9%). 30 runs, 177.7 min and $34.65 from the `run_finished` events. Per run, the time p50 is 6.4 min and the p90 8.9 min, with a maximum of 9.8. The cost p50 is $1.27 and the p90 $1.64.

On the 14 cases stress-1b also ran, the pass count went from 7 to 12, and no case regressed. bakery-vague, helpdesk-add-refunds, linear-description and stripe-refunds now finish. video-codec-impossible is now refused at plan.

YOS-53's 70% target is met. YOS-54's time targets are met: the median is under 10 min, and every run is under 15 min. Its 85% pass target is not, and each failure has a reason below.

| cause | cases | next step |
|---|---|---|
| The frozen acceptance tests contradict the built API: camelCase versus snake_case fields, 201 versus 200, envelope shape. | petstore-store, petstore-full, petstore-add-refunds, stripe-customers, stripe-partial-refunds | Make the model step build the field names and status codes that the frozen tests use, or send the workflow's repeated test failure back to plan, as 7f4e156d now does for the seed. |
| A frozen test assumes empty tables, which the seed breaks. | hotel-booking | The plan brief already says tests create their own rows (A-133). It should also say tests must never assume other rows are absent. 7f4e156d sends a test the seed keeps failing back to plan. It landed after this run and is not measured here. |
| The plan step's time share is too short for one long plan call (288 s). | rental-fleet | Give the plan step a floor for its share, or let a first plan call run past its share when later steps have not started. |
