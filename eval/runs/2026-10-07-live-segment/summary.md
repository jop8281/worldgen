# Eval run 2026-10-07-live-segment

Suite `live-segment`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |
|---|---|---|---|---|--:|--:|---|---|---|
| box-office | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 7.5 | 2.20 | pass (3 tasks) | ok | yes |
| giftcards-openapi | done | stopped | no_progress at workflow | plan 1, model 1, workflow 2 | 3.3 | 0.71 | - | ok | no |
| gym-bookings-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 8.0 | 1.83 | pass (4 tasks) | ok | yes |

**Totals:** 3 cases: 2 done, 1 stopped, 0 crashed; 18.8 min; $4.74; 0 unlogged.

**Pass rate:** 2/3 (67%).
