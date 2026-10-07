# Eval run lane-b

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |
|---|---|---|---|---|--:|--:|---|---|---|
| bakery-vague | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 2 | 5.2 | 1.81 | pass (3 tasks) | ok | yes |
| video-codec-impossible | stopped | stopped | input_rejected | plan 1 | 0.2 | 0.03 | - | ok | yes |
| billing-dunning | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 8.0 | 1.38 | pass (4 tasks) | ok | yes |
| stripe-refunds | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 3 | 9.7 | 1.88 | pass (3 tasks) | ok | yes |
| rental-fleet | done | stopped | model_error | plan 1 | 3.5 | 0.37 | - | ok | no |
| warehouse-inventory | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | ok | no |
| hotel-booking | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | ok | no |
| course-enrollments-csv | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | ok | no |
| petstore-full | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | ok | no |
| forecast-impossible | stopped | stopped | model_error | plan 1 | 0.0 | 0.00 | - | ok | no |
| live-market-feed-impossible | stopped | stopped | model_error | plan 1 | 0.0 | 0.00 | - | ok | no |
| helpdesk-sla | done | missing | - | - | unknown | unknown | - | - | no |
| library-holds | done | missing | - | - | unknown | unknown | - | - | no |
| todo-projects | done | missing | - | - | unknown | unknown | - | - | no |
| clinic-appointments | done | missing | - | - | unknown | unknown | - | - | no |
| petstore-store | done | missing | - | - | unknown | unknown | - | - | no |
| orders-csv | done | missing | - | - | unknown | unknown | - | - | no |
| linear-backlog-csv | done | missing | - | - | unknown | unknown | - | - | no |
| helpdesk-add-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-partial-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| retail-tau2-known | done | missing | - | - | unknown | unknown | - | - | no |
| linear-description | done | missing | - | - | unknown | unknown | - | - | no |
| insurance-claims | done | missing | - | - | unknown | unknown | - | - | no |
| bookmarks | done | missing | - | - | unknown | unknown | - | - | no |
| repair-desk | done | missing | - | - | unknown | unknown | - | - | no |
| shipments-csv | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-customers | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-charges | done | missing | - | - | unknown | unknown | - | - | no |
| petstore-add-refunds | done | missing | - | - | unknown | unknown | - | - | no |

**Totals:** 29 expected cases: 3 done, 8 stopped, 0 crashed, 18 missing, 0 invalid; 26.6 min (11 of 29 cases); $5.47 (11 of 29 cases); 0 unlogged.

**Median and p95:** 0.0 min (11 of 29 cases) and 9.7 min (11 of 29 cases); $0.00 (11 of 29 cases) and $1.88 (11 of 29 cases).

**Pass rate:** 4/29 (14%).

## Missing or invalid

- `helpdesk-sla`: no case.json in the run directory
- `library-holds`: no case.json in the run directory
- `todo-projects`: no case.json in the run directory
- `clinic-appointments`: no case.json in the run directory
- `petstore-store`: no case.json in the run directory
- `orders-csv`: no case.json in the run directory
- `linear-backlog-csv`: no case.json in the run directory
- `helpdesk-add-refunds`: no case.json in the run directory
- `stripe-partial-refunds`: no case.json in the run directory
- `retail-tau2-known`: no case.json in the run directory
- `linear-description`: no case.json in the run directory
- `insurance-claims`: no case.json in the run directory
- `bookmarks`: no case.json in the run directory
- `repair-desk`: no case.json in the run directory
- `shipments-csv`: no case.json in the run directory
- `stripe-customers`: no case.json in the run directory
- `stripe-charges`: no case.json in the run directory
- `petstore-add-refunds`: no case.json in the run directory

## Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | seed.too_few_rows_for_paging | 3 | 30 rows fit on one page. Paging never matters. |
| 2 | task.decoy_trivial | 2 | Decoy "PATCHes the batch status to completed instead of using the complete action, so stock is never added and completed_at stays empty" is no_successful_write. |
