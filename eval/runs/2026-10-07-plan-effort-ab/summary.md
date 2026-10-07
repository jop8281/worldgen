# Plan-effort A/B, 2026-10-07

Does planning at medium effort keep WorldGen's pass rate while cutting the plan call's time? Decision A-272.

Both arms ran #495's head `b1d648b5` (the A-311 reserves), `claude-sonnet-5-5` over `claude -p`, at $3 and 12 minutes per run. Each arm ran its three cases one after another, and the two arms ran side by side. The only difference was `stepModels.plan.effort` in `code/worldgen.config.json`: `high` (the default) or `medium`. Each case directory keeps `case.json` and `events.jsonl`. The `*.console.log` files are the runners' output.

## Results

| case | input | high: plan calls (s) | high: result | medium: plan calls (s) | medium: result |
|---|---|---|---|---|---|
| library-holds | description | 272 | stopped, stage_time_exhausted at seed: the seed call was cut at its 224 s share | 70, and 54 on a backtrack | stopped, stage_time_exhausted at seed: the seed call was cut at its 360 s share |
| stripe-refunds | openapi | 211 invalid_output, then 59 | stopped, stage_time_exhausted at tasks: `task.pressure_unmet` twice, then the third tasks call was cut at its 62 s share | 83 | stopped, no_progress at tasks: `seed.too_few_rows_for_paging` twice |
| insurance-claims | description | 269 invalid_output, then 92 | stopped, stage_time_exhausted at workflow: cut at its 109 s share | 365 | stopped, stage_time_exhausted at tasks: `snippet.runtime_error`, then cut at its 67 s share |
| **pass** | | | **0 of 3, $4.32** | | **0 of 3, $3.86** |

Costs are the known costs from each `run_finished`. Each run also had one cut call of unknown cost.

## Reading

- **Plan time.** The medium arm's plans took 70, 83 and 365 s (54 s more on library-holds' backtrack). The high arm's took 272 s, 270 s and 361 s, and both of its two-call plans started with a 211 s or 269 s `invalid_output`. So medium was usually much faster, but not always: insurance-claims planned for 365 s at medium.
- **Pass rate.** Neither arm passed a case, and every stop came after the plan step: a slow seed call, the tasks gates from #451 (now YOS-219), or a later call cut by the time left. With 0 of 3 against 0 of 3, this A/B cannot show whether a medium plan is as good as a high one. One medium plan did need repair: library-holds' workflow hit `snippet.runtime_error` and the run backtracked to plan.
- **Verdict (A-272).** Keep plan effort `high`. Rerun the A/B on cases that pass at high today, so a quality loss from a medium plan would show as a lost pass.
