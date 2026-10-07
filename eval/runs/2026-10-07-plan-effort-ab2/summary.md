# Plan-effort A/B on passing cases, 2026-10-07

Decision A-275, which supersedes A-272. The first A/B (`../2026-10-07-plan-effort-ab`) could not measure plan quality, because every case failed after the plan step in both arms. This one uses five cases that passed at high in stress-2 and stress-3, so a weaker medium plan would show up as a lost pass.

Both arms ran stabilize `e434784e`, which carries the A-311 reserves, A-273 and A-274. Model `claude-sonnet-5-5` over `claude -p`, $3 and 12 minutes per run. Each arm ran its cases one after another, and the two arms ran side by side. The only difference was `stepModels.plan.effort`: `high`, the old default, or `medium`.

## Results

| case | input | high: plan s | high: run s | high: $ | high: result | medium: plan s | medium: run s | medium: $ | medium: result |
|---|---|--:|--:|--:|---|--:|--:|--:|---|
| helpdesk-sla | description | 208 | 570 | 2.13 | pass | 56 | 297 | 0.85 | pass |
| todo-projects | description | 113 | 558 | 1.07 | pass | 69 | 267 | 0.88 | pass |
| clinic-appointments | description | 207 | 625 | 1.85 | stopped, stage_time_exhausted at seed | 59 | 298 | 0.75 | pass |
| orders-csv | csv | 109 | 240 | 0.82 | pass | 48 | 167 | 0.80 | pass |
| linear-backlog-csv | csv | 125 | 258 | 1.16 | pass | 45 | 174 | 0.86 | pass |
| **all** | | | median 558 | **7.03** | **4 of 5** | | median 267 | **4.15** | **5 of 5** |

Every passing run verified all 3 of its tasks. helpdesk-sla scored the same fidelity in both arms, 0.957 (68 of 71).

## Reading

- **Pass rate.** Medium passed every case that high passed, plus clinic-appointments. High ran out of time on that one at seed, after a 207 s plan.
- **Time.** Medium plans took 45 to 69 s against 109 to 208 s at high. Whole runs took 167 to 298 s against 240 to 625 s, roughly half. The 12 to 15 minute live cap gains that headroom.
- **Cost.** Medium cost $0.75 to $0.88 per run against $0.82 to $2.13 at high, 41% less in all.
- **Limits.** Five cases per arm, run once each. In the first A/B, one medium plan (insurance-claims) still took 365 s, so medium is faster on average, not on every call.
