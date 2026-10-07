# Eval run stress-3, 2026-10-07

The 29-case `stress` suite ran on `stabilize/main` `10bfe47` as three parallel lanes. Model `claude-sonnet-5-5` over `claude-cli`, $3 and 12 min per run. The run was meant to measure today's fixes: A-165 (frozen tests back to plan), #412 (spec field names and engine statuses), #398 (error codes), A-185 (the plan share floor), and #426's stricter verify. Each `lane-*/summary.md` is that lane's own scorecard. A lane's summary lists the other lanes' cases as `missing`, so the tables below take each case only from the lane that ran it. Each case directory keeps `case.json` and `events.jsonl`.

## Headline

**10 of 11 valid cases pass. The other 18 cases were not run**, because the Claude account's session limit stopped them ("You've hit your session limit · resets 12:10pm", from `claude -p`). Those 18 say nothing about WorldGen, and they're rerun after the demo as one sequential lane on the same head. Spend over all 29 runs was $17.02, from the `run_finished` events.

- **The one valid failure.** library-holds stopped `stage_time_exhausted` at seed. Its plan took 206 s, and its workflow step took three attempts: a `test.failed`, then invalid output, then accepted. Preflight then refused the seed call, whose estimate didn't fit the 189 s left in its share. It's a time-budget stop at the 12-minute limit after workflow retries. The plan call fit even the old 288 s share, so A-185's floor wasn't a factor.
- **Against stress-2, on these 11 cases.** 10 cases score the same. petstore-store moves from fail to pass, and library-holds from pass to fail.
- **#426's stricter verify.** No valid case failed a verify gate: no `task.mutant_full_marks`, `task.idle_not_zero` or `task.alternative_not_full_marks`. Every finished world verified. So on these cases #426 changed no outcome.
- **An earlier interruption.** A first attempt on `50f3eff` was cut off at 18:25:57Z when #430's new `reprice` ledger line made the older code read the ledger as corrupt. Its 13 valid cases are in the appendix, for comparison only. That's where billing-dunning and stripe-refunds failed and now pass.

### Valid cases on 10bfe47

| case | lane | expect | result | stop reason | min | $ | pass | stress-2 |
|---|---|---|---|---|--:|--:|---|---|
| bakery-vague | B | done | done | - | 5.2 | 1.81 | yes | done, yes |
| billing-dunning | B | done | done | - | 8.0 | 1.38 | yes | done, yes |
| clinic-appointments | C | done | done | - | 8.1 | 1.44 | yes | done, yes |
| helpdesk-sla | A | done | done | - | 7.2 | 1.59 | yes | done, yes |
| library-holds | C | done | stopped | stage_time_exhausted at seed | 6.2 | 1.36 | no | done, yes |
| linear-backlog-csv | C | done | done | - | 5.7 | 1.35 | yes | done, yes |
| orders-csv | A | done | done | - | 5.1 | 1.10 | yes | done, yes |
| petstore-store | A | done | done | - | 5.6 | 1.28 | yes | stopped, no |
| stripe-refunds | B | done | done | - | 9.7 | 1.88 | yes | done, yes |
| todo-projects | A | done | done | - | 4.4 | 0.84 | yes | done, yes |
| video-codec-impossible | B | stopped | stopped | input_rejected | 0.2 | 0.03 | yes | stopped, yes |

### Not run: stopped by the account session limit

| case | lane | spent before the limit |
|---|---|--:|
| bookmarks | A | 0.00 |
| course-enrollments-csv | B | 0.00 |
| forecast-impossible | B | 0.00 |
| helpdesk-add-refunds | A | 0.99 |
| hotel-booking | B | 0.00 |
| insurance-claims | C | 0.00 |
| linear-description | A | 0.00 |
| live-market-feed-impossible | B | 0.00 |
| petstore-add-refunds | C | 0.00 |
| petstore-full | B | 0.00 |
| rental-fleet | B | 0.37 |
| repair-desk | C | 0.00 |
| retail-tau2-known | C | 0.00 |
| shipments-csv | A | 0.00 |
| stripe-charges | A | 0.00 |
| stripe-customers | C | 0.00 |
| stripe-partial-refunds | C | 1.59 |
| warehouse-inventory | B | 0.00 |

### Appendix: the 13 valid cases of the interrupted 50f3eff run

| case | result | stop reason | min | $ | pass |
|---|---|---|--:|--:|---|
| helpdesk-sla | done | - | 8.6 | 1.58 | yes |
| orders-csv | done | - | 5.4 | 1.32 | yes |
| petstore-store | stopped | stage_time_exhausted | 7.1 | 1.58 | no |
| todo-projects | done | - | 5.2 | 1.11 | yes |
| bakery-vague | done | - | 5.7 | 1.71 | yes |
| billing-dunning | stopped | stage_time_exhausted | 6.6 | 1.15 | no |
| rental-fleet | done | - | 9.4 | 1.90 | yes |
| stripe-refunds | stopped | model_error | 6.3 | 1.11 | no |
| video-codec-impossible | stopped | input_rejected | 0.2 | 0.03 | yes |
| clinic-appointments | done | - | 9.3 | 1.68 | yes |
| library-holds | done | - | 11.3 | 1.76 | yes |
| linear-backlog-csv | done | - | 4.6 | 1.16 | yes |
| stripe-partial-refunds | stopped | stage_time_exhausted | 8.4 | 1.63 | no |
