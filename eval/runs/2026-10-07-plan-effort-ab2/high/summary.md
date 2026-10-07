# Eval run high

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| helpdesk-sla | done | done | - | plan 1, model 1, workflow 1, seed 3, tasks 2 | 9.5 | 2.13 | pass (3 tasks) | 0.957 (68/71) | ok | yes |
| todo-projects | done | done | - | plan 1, model 1, workflow 1, seed 2, tasks 2 | 9.3 | 1.07 | pass (3 tasks) | - | ok | yes |
| clinic-appointments | done | stopped | stage_time_exhausted at seed | plan 1, model 1, workflow 1, seed 2, tasks 2 | 10.4 | 1.85 | - | - | ok | no |
| orders-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 4.0 | 0.82 | pass (3 tasks) | - | ok | yes |
| linear-backlog-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 4.3 | 1.16 | pass (3 tasks) | - | ok | yes |
| bakery-vague | done | missing | - | - | unknown | unknown | - | - | - | no |
| video-codec-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| library-holds | done | missing | - | - | unknown | unknown | - | - | - | no |
| billing-dunning | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-store | done | missing | - | - | unknown | unknown | - | - | - | no |
| helpdesk-add-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-partial-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| retail-tau2-known | done | missing | - | - | unknown | unknown | - | - | - | no |
| linear-description | done | missing | - | - | unknown | unknown | - | - | - | no |
| insurance-claims | done | missing | - | - | unknown | unknown | - | - | - | no |
| bookmarks | done | missing | - | - | unknown | unknown | - | - | - | no |
| rental-fleet | done | missing | - | - | unknown | unknown | - | - | - | no |
| warehouse-inventory | done | missing | - | - | unknown | unknown | - | - | - | no |
| hotel-booking | done | missing | - | - | unknown | unknown | - | - | - | no |
| repair-desk | done | missing | - | - | unknown | unknown | - | - | - | no |
| course-enrollments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| shipments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-customers | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-charges | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-full | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-add-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| forecast-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| live-market-feed-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |

**Totals:** 29 expected cases: 4 done, 1 stopped, 0 crashed, 24 missing, 0 invalid; 37.5 min (5 of 29 cases); $7.02 (5 of 29 cases); 0 unlogged.

**Median and p95:** 9.3 min (5 of 29 cases) and 10.4 min (5 of 29 cases); $1.16 (5 of 29 cases) and $2.13 (5 of 29 cases).

**Pass rate:** 4/29 (14%).

## Missing or invalid

- `bakery-vague`: no case.json in the run directory
- `video-codec-impossible`: no case.json in the run directory
- `library-holds`: no case.json in the run directory
- `billing-dunning`: no case.json in the run directory
- `stripe-refunds`: no case.json in the run directory
- `petstore-store`: no case.json in the run directory
- `helpdesk-add-refunds`: no case.json in the run directory
- `stripe-partial-refunds`: no case.json in the run directory
- `retail-tau2-known`: no case.json in the run directory
- `linear-description`: no case.json in the run directory
- `insurance-claims`: no case.json in the run directory
- `bookmarks`: no case.json in the run directory
- `rental-fleet`: no case.json in the run directory
- `warehouse-inventory`: no case.json in the run directory
- `hotel-booking`: no case.json in the run directory
- `repair-desk`: no case.json in the run directory
- `course-enrollments-csv`: no case.json in the run directory
- `shipments-csv`: no case.json in the run directory
- `stripe-customers`: no case.json in the run directory
- `stripe-charges`: no case.json in the run directory
- `petstore-full`: no case.json in the run directory
- `petstore-add-refunds`: no case.json in the run directory
- `forecast-impossible`: no case.json in the run directory
- `live-market-feed-impossible`: no case.json in the run directory

## Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | task.pressure_unmet | 3 | The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for cancel_hannah_meyer_eligible. |
| 2 | plan.seed_rows_short | 1 | The seed made 36. Seed the planned count, or change rowsPerEntity in the plan step. |
| 3 | seed.too_few_rows_for_paging | 1 | 24 rows fit on one page. Paging never matters. |

## Fidelity misses

- `helpdesk-sla` field.missing ticket.type (1): ticket has no field named type or ticket_type, kind
- `helpdesk-sla` state.missing ticket.status.hold (1): status has no state named hold
- `helpdesk-sla` route.missing GET /search (1): no route or action for GET /search
- `helpdesk-sla` missed 3 of 71
