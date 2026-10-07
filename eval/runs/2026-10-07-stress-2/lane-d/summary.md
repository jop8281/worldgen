# Eval run lane-d

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |
|---|---|---|---|---|--:|--:|---|---|---|
| course-enrollments-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 5.5 | 1.26 | pass (3 tasks) | ok | yes |
| shipments-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 4.6 | 1.03 | pass (3 tasks) | ok | yes |
| stripe-customers | done | stopped | no_progress at workflow | plan 3, model 2, workflow 2 | 3.5 | 0.82 | - | ok | no |
| stripe-charges | done | done | - | plan 2, model 1, workflow 2, seed 1, tasks 2 | 8.4 | 1.77 | pass (3 tasks) | ok | yes |
| petstore-full | done | stopped | no_progress at workflow | plan 2, model 1, workflow 2 | 5.7 | 0.90 | - | ok | no |
| petstore-add-refunds | done | stopped | no_progress at workflow | plan 1, model 1, workflow 2 | 5.2 | 0.95 | - | ok | no |
| forecast-impossible | stopped | stopped | input_rejected | plan 1 | 0.2 | 0.03 | - | ok | yes |
| live-market-feed-impossible | stopped | stopped | input_rejected | plan 1 | 0.2 | 0.03 | - | ok | yes |

**Totals:** 8 cases: 3 done, 5 stopped, 0 crashed; 33.2 min; $6.79; 0 unlogged.

**Pass rate:** 5/8 (63%).
