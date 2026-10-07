# YOS-156 acceptance 6: WorldGen adopts `allows` through iterate runs

**Run by:** worldgen-79 on 2026-10-07, about 14:22–14:34 PDT, on `stabilize/main` at `04c84c30`, under worldgen-27's job: at most 3 iterate runs, `--budget-usd 8` each, $25 total.
**Model:** `claude-sonnet-5-5` through the default `claude -p` transport (`WORLDGEN_CLAUDE_BIN=~/.local/bin/claude`), with the ledger caps at 1000/1000.
**Scope:** each run went on a scratch copy of a non-demo world, outside `prod/`. No world in `prod/worlds` changed, and the demo worlds stay frozen.

Change request. Run 1 used the first sentence alone; runs 2 and 3 added the second, after run 1:

> Declare an allows list on every task, taken from that task's instruction and not from what its solution happens to write: each entity the task may change, the kind (created, updated or deleted), the exact fields for updates, and a where of field values that picks the target rows. Change nothing else: do not add or change any plan pressure claims, seed, routes, solutions, graders or decoys.

| World copy | Result | Cost | Time | Tasks with `allows` | Other changes the run made | Check / verify of the result |
|---|---|--:|--:|---|---|---|
| gen-todo-projects | stopped, `no_progress` at tasks | $0.7704 | 78 s | none written (the run stopped) | The plan step added a YOS-157 pressure claim (later-page rows) to `archive_all_finished_projects`. The tasks stage could not meet it without seeding, so the same `task.pressure_unmet` came back twice. | — |
| gen-hotel-booking | done | $0.7313 | 120 s | 4 of 4 | `seed.reservation`: two state quotas raised (checked_out 40→52, no_show 9→11), one fee count 8→12, the retry limit 400→1500 | check `ok`; verify passes on all 4 tasks, REPORT shows `declared (1)`, `declared (2)`, `declared (1)`, `declared (1)` |
| gen-bookmarks | done | $1.2742 | 193 s | 4 of 4 | new fields `folder.placement` and `tag.lifecycle`, and `seed.bookmark_tag` changed | check `ok` (one paging warning); verify passes on all 4 tasks |

**Total spend: $2.78** of the $25 budget. No cost gate refused.

## Findings

1. **The model writes sound contracts.** Each `allows` scopes the target rows by values the instruction names, such as the guest, the owner, the status or the maintenance room. Each also declares the side effects the actions really create, such as `folio_charge` for a cancellation fee and `activity` rows in bookmarks. The engine guard then holds on the reference solution of all 8 adopted tasks.
2. **Iterate does not honour "change nothing else".** Both successful runs changed more than the request allowed, and bookmarks even changed its schema. The preservation gate let it through because the plan named those changes, and REPORT.md lists them, so provenance holds. Still, an `allows`-only adoption cannot be guaranteed to touch only tasks. A follow-up should make an iterate refuse plan changes outside the sections the request names.
3. **New gates block iterates on older worlds.** On gen-todo-projects the plan step volunteered a pressure claim (YOS-157) that the existing seed cannot satisfy, and the tasks stage may not edit the seed, so the run stopped `no_progress`. Run 2's request forbade pressure changes, and that did not recur.
4. **The probe gap is real.** gen-hotel-booking probes only 1–3 of 7 mutant kinds per task, the same as before this change, because its actions refuse most mutant writes. For those tasks the declared contract is the only engine-enforced collateral check.

Files: per world, `REPORT.md`, `events.jsonl` (this run only) and `run.log`, plus for the two successful runs the resulting `world.yaml` and `plan.yaml`. A secret scan for keys and bearer tokens found none.

## Acceptance 6 in place on prod: hotel run stopped (2026-10-07, worldgen-79)

Run in place on `prod/worlds/gen-hotel-booking` with the allows-only request and `--budget-usd 1.6`. worldgen-27 paused it after one run, at $1.17 of the $8 approved for these runs. The world and its REPORT.md were restored with `git checkout`, so nothing in `prod/` changed. The run is in `acceptance-6-prod-hotel-stopped/`: `REPORT-stopped.md`, `run/` (events and each attempt), `capsule.json` and `run.log`. A secret scan found nothing.

What happened: the plan reached only `tasks`, so `model` and `workflow` were skipped. Then the seed stage's skip probe failed on debt the world already had: `plan.seed_rows_short` (the plan promises 75 folio_charge rows and the seed makes 57). `worldplay check` passes, because that rule belongs to WorldGen's judge, not the engine. The seed stage ran with that issue as feedback. It added rows (`plan.seed_rows_short` again), then changed `seed.reservation`, which A-289 refused as `iterate.out_of_scope`. The run could not satisfy both rules, so it was stopped. A-290 fixes this: a stage that is reached by none of the plan's changes and fails only on debt the world already had is skipped, and the skip names that debt.

## Acceptance 3: action-only worlds report `target_field` unprobed

With no update route, the `target_field` mutant has no request to replay, so the verdict reports `{ kind: 'target_field', call: null, score: null }`. That means unprobed, not passed. A test in `test/tasks-verify.test.ts` pins this. Across `prod/worlds`, the 7 action-only worlds hold 32 tasks, and every one reports `target_field` unprobed: gen-petstore-refunds, gen-petstore, gen-refunds, gen-retail-tau2-known, gen-stripe-charges, gen-stripe-customers and retail-tau2. The 18 worlds with a generic update route probe it on their 63 tasks.

## Acceptance 5, Node half

On Node 22 (`node --import tsx --test`, one file at a time, `nice -n 15`), these all pass with 0 failures: tasks-verify 41, tasks 37, worlds 42, cli-world 34, report 27, redteam-graders 38, redteam-check 238, judge-preservation 27, trace-grading 16, architecture 27 and worldgen-iterate 41.

## Acceptance 6 in place on prod: five worlds adopt `allows` (2026-10-07, worldgen-79)

Each run iterated a non-demo world in place, on `stabilize/main` at `e434784e`, which includes A-290 (#514). The request was the allows-only one above, ending in "Change nothing else". Each run used `--budget-usd 1.6`, ledger caps of 1000/1000, and `claude-sonnet-5-5` through `claude -p`. The demo worlds (helpdesk, gen-library-loans, gen-rental-fleet, gen-repair-desk, gen-stripe-charges) were left alone. So were the worlds that carry `plan.state_field_missing` debt (gen-bookmarks, gen-warehouse-inventory), which the 6e W11 work owns. Every world was picked from a no-spend survey that judged each world against its own plan.yaml.

| World | Result | Cost | Time | Tasks with `allows` | Stages | Changes | check / verify |
|---|---|--:|--:|---|---|---|---|
| gen-hotel-booking | done | $0.4753 | 77 s | 4 of 4 | model, workflow and seed skipped; seed keeps its `plan.seed_rows_short` debt (A-290) | `tasks.*.allows` only | ok / exit 0 |
| gen-refunds | done | $0.2973 | 62 s | 4 of 4 | model, workflow and seed skipped | `tasks.*.allows` only | ok / exit 0 |
| gen-petstore-refunds | done | $0.5831 | 125 s | 6 of 6 | model, workflow and seed skipped | `tasks.*.allows` only | ok, one earlier paging warning / exit 0 |
| gen-clinic-appointments | done | $0.3293 | 70 s | 4 of 4 | model, workflow and seed skipped | `tasks.*.allows` only | ok, one earlier paging warning / exit 0 |
| gen-course-enrollments | done | $0.4474 | 71 s | 3 of 3 | model, workflow and seed skipped | `tasks.*.allows`, plus the solution of `grade_completed_department_courses` | ok / exit 0 |

**Total: $2.1324**, within the $6.83 left of the $8 approved for these runs (hotel's stopped run took $1.17 before). Every run's plan was accepted on its first attempt. The tasks stage was too, except on gen-course-enrollments, which took two attempts (see finding 2). No cost gate refused.

Findings:

1. **A-289 and A-290 hold scope.** Four of the five runs changed only `tasks.*.allows`. The earlier scratch-copy runs had added fields and seed changes.
2. **The plan step still adds plan-only claims that nobody asked for.** On gen-course-enrollments, the plan added a YOS-157 `pressure` claim (`paging: enrollment`, three states) to `grade_completed_department_courses`. It also added a descriptive `lifecycle` to one workflow. The first tasks attempt then failed `task.pressure_unmet`, because the old reference never changed a row past the first page. The second attempt rewrote that task's solution to list all `/enrollments?status=enrolled` and filter by course. The new solution changes the same rows and verify scores it 1, but the request asked for neither change. Two gaps let this through. A-289 traces only world changes, not plan-only additions such as `pressure`. Its stem match also accepts `tasks.<id>.solution`, because the request says "every task". This is the same pattern as the gen-todo-projects pressure finding above.
3. **Some contracts name seeded ids, not instruction values.** For example, `course_id: crs_0013` stands for the course the instruction names as 'Physics Lab 13'. The guard is still exact, because seeds are deterministic.

Each world's new `runs/<runId>/` holds the run's events and attempts, and `capsule.json` is updated. A secret scan of the new run files found nothing.
