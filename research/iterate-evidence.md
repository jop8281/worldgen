# Iterate evidence: 20 change requests on gen-todo-projects

Run on 2026-10-06 (UTC 2026-10-07) for YOS-52. Base world `prod/worlds/gen-todo-projects` (3 tasks), build 65bea67 of stabilize/main. Model claude-sonnet-5-5 over `claude -p`. Each run is an independent copy of the base, with `--world <copy> "<change>" --budget-usd 2 --max-minutes 10`, one at a time under `nice -n 15`. Check and verify ran after each run on the copy (check retried once on failure).

Result: 17 of 19 valid runs changed the world and finished with check and verify passing; 2 stopped without changing it. Run 10 is invalid: the Mac went into clamshell sleep on battery and both timers fired on wake, so it says nothing about WorldGen. The preservation gate held in every valid run: each run that finished kept all 3 base tasks passing (solution 1.0), and the 2 that stopped left the base world as it was.

| # | Change request | Stop | Stages run | $ | Wall | Preserved | Check / verify | Tasks after |
|---|---|---|---|---|---|---|---|---|
| 01 | labels on tasks | done | plan, model, workflow, seed, tasks | 0.90 | 214s | yes | pass / pass | 6 |
| 02 | task comments | done | all five | 0.74 | 121s | yes | pass / pass | 4 |
| 03 | subtasks, parent blocked by open subtasks | done | all five | 0.90 | 199s | yes | pass / pass | 5 |
| 04 | weekly recurring-task job | done | all five | 1.06 | 222s | yes | pass / pass | 4 |
| 05 | rename priority urgent to critical | no_progress | plan, model | 0.54 | 68s | yes (unchanged) | pass / pass | 3 |
| 06 | estimate_hours field | done | all five | 0.88 | 137s | yes | pass / pass | 3 |
| 07 | WIP limit of 3 in_progress | done | all five | 0.80 | 136s | yes | pass / pass | 4 |
| 08 | reassign_task action | done | all five | 0.85 | 152s | yes | pass / pass | 4 |
| 09 | project membership | done | all five | 0.85 | 181s | yes | pass / pass | 4 |
| 10 | daily archive job | invalid (host slept) | none | 0.00 | 1410s | n/a | n/a | 3 |
| 11 | bulk complete_all_in_project | done | plan, workflow, seed, tasks | 1.13 | 247s | yes | pass / pass | 5 |
| 12 | due-reminder job | done | all five | 0.72 | 110s | yes | pass / pass | 3 |
| 13 | task dependencies | done | all five | 1.16 | 260s | yes | pass / pass | 6 |
| 14 | 50-task project constraint | done | plan, workflow, seed, tasks | 0.62 | 111s | yes | pass / pass | 3 |
| 15 | cancelled status | done | all five | 0.88 | 189s | yes | pass / pass | 4 |
| 16 | time entries | done | all five | 0.99 | 251s | yes | pass / pass | 5 |
| 17 | sprints | done | all five | 1.15 | 244s | yes | pass / pass | 6 |
| 18 | rename member to user | no_progress | plan, model | 0.67 | 193s | yes (unchanged) | pass / pass | 3 |
| 19 | watchers | done | all five | 0.83 | 179s | yes | pass / pass | 5 |
| 20 | approval step for urgent tasks | done | all five | 1.36 | 294s | yes | pass / pass | 4 |

Total spend: about $17.3 for the 20 runs.

## Findings

- Additive changes (new entity, action, job, field, constraint, status) succeed: 17 of 17.
- Both renames fail: 05 (a value rename) and 18 (an entity rename) stop with `no_progress` because the workflow stage keeps returning `layer.blocked`. Neither damaged the world. A rename touches every section at once, which the stage-ownership model (`SECTION_OWNER`) does not allow in one stage edit.
- Run 10 is invalid. The host slept (pmset logs show clamshell sleep on battery), and the run and wall timers fired on wake. Not a WorldGen hang.
- "Preserved" is taken from the outcome: `preservationIssues()` blocks unplanned destructive changes, and every run that finished still passes the 3 original tasks. The runs do not log the gate's verdict as a separate event, so a gate block would show up as a stopped run, and neither stop names it.
