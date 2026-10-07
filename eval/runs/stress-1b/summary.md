# Eval run stress-1b

Suite `stress`, model `claude-sonnet-5-5`, budget $1.75 and 12 min per run. Merged from the 14 per-case `summary.md` files (helpdesk-sla from the smoke run in this directory, the rest from `_<id>/summary.md`).

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| bakery-vague | done | stopped | time_exhausted | plan 1 | 23.7 | 0.08 | - | - | unlogged | no |
| billing-dunning | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1 | 9.8 | 1.28 | pass (3 tasks) | - | ok | yes |
| clinic-appointments | done | done | - | plan 1, model 1, workflow 1, seed 2, tasks 1 | 7.7 | 1.08 | pass (3 tasks) | - | ok | yes |
| helpdesk-add-refunds | done | stopped | change: budget_exhausted | plan 1, model 1, workflow 1, seed 1, tasks 1; change: plan 1, model 1, workflow 2, seed 1 | 15.8 | 2.57 | - | - | unlogged | no |
| helpdesk-sla | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1 | 4.5 | 1.67 | pass (3 tasks) | 0.957 (68/71) | ok | yes |
| library-holds | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 11.3 | 1.36 | pass (3 tasks) | - | ok | yes |
| linear-description | done | stopped | no_progress at seed | plan 1, model 1, workflow 3, seed 3 | 10.0 | 1.73 | - | no world: last phase did not finish | ok | no |
| orders-csv | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1 | 3.6 | 0.80 | pass (3 tasks) | - | ok | yes |
| petstore-store | done | stopped | stage_time_exhausted at model | plan 1, model 1, workflow 2, seed 2, tasks 1 | 6.6 | 1.10 | - | - | ok | no |
| retail-tau2-known | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 9.7 | 1.25 | pass (4 tasks) | 0.972 (72/74) | ok | yes |
| stripe-partial-refunds | done | stopped | stage_time_exhausted at model | plan 1, model 1, workflow 2, seed 2, tasks 1 | 10.7 | 1.44 | - | - | ok | no |
| stripe-refunds | done | stopped | stage_time_exhausted at model | plan 1, model 1, workflow 1, seed 1, tasks 1 | 8.4 | 1.06 | - | - | ok | no |
| todo-projects | done | done | - | plan 1, model 1, workflow 2, seed 3, tasks 1 | 6.6 | 1.04 | pass (3 tasks) | - | ok | yes |
| video-codec-impossible | stopped | done | - | plan 1, model 1, workflow 1, seed 2, tasks 1 | 10.5 | 1.33 | pass (3 tasks) | - | ok | no |

**Totals:** 14 cases: 8 done, 6 stopped, 0 crashed; 138.8 min; $17.78 from run events (15 runs, helpdesk-add-refunds is a create plus a change); 2 unlogged.

**Pass rate:** 7/14 (50%). video-codec-impossible finished a world but expects a stop, so it fails.

bakery-vague 23.7 min: the host was asleep 04:43:29Z-05:06:08Z (pmset: clamshell sleep until the lid wake, with dark wakes of 45 s and 2 s); the 12-min timer fired on wake, and the run finished at 05:06:24Z.
