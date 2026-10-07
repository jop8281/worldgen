# Live run

Run on 2026-10-07 at commit `6162178f`, model `claude-sonnet-5-5`, with a budget of $5 and 15 minutes per prompt. The prompts are in [prompts/](prompts/), exactly as received. Each row is what happened; a stop is a result, and no world was edited by hand.

| Prompt | Input | Outcome | Engine check and verify | Minutes | USD | Artifacts |
|---|---|---|---|---|---|---|
| 01-dog-walking | description | done | pass, 3 tasks | 9.8 | 2.59 | `../../../../private/tmp/claude-501/-Users-yossieliaz-worldgen/fd6868f2-7344-4376-9437-cf4b210e452b/scratchpad/rehearsal-worlds/gen-dog-walking` |
| 02-plant-nursery | csv | stopped: attempts_exhausted: seed still rejected after 4 attempts (last issues: plan.not_covered) | not run | 4.9 | 1.20 | `eval/runs/2026-10-07-rehearsal-stabilize/gen-plant-nursery` |

Delivered 1 of 2 prompts that ran, 0 skipped because a world was already there. Total 14.7 minutes and $3.80 (a client-side estimate).

A delivered world is in `prod/worlds/gen-<slug>/` with its `plan.yaml` and `REPORT.md`, which lists what was assumed and what was left out. A stopped or invalid run stays in the artifacts folder, outside `prod/worlds`, with its stop report.
