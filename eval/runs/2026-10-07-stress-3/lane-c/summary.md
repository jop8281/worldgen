# Eval run lane-c

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| library-holds | done | stopped | stage_time_exhausted at seed | plan 1, model 1, workflow 3 | 6.2 | 1.36 | - | - | unlogged | no |
| clinic-appointments | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 8.1 | 1.44 | pass (3 tasks) | - | ok | yes |
| linear-backlog-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 5.7 | 1.35 | pass (3 tasks) | - | ok | yes |
| stripe-partial-refunds | done | stopped | model_error | plan 1, model 2, workflow 2, seed 1, tasks 1 | 8.2 | 1.59 | - | - | ok | no |
| retail-tau2-known | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | no world: last phase did not finish | ok | no |
| insurance-claims | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| repair-desk | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| stripe-customers | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| petstore-add-refunds | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| helpdesk-sla | done | missing | - | - | unknown | unknown | - | - | - | no |
| bakery-vague | done | missing | - | - | unknown | unknown | - | - | - | no |
| video-codec-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| billing-dunning | done | missing | - | - | unknown | unknown | - | - | - | no |
| todo-projects | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-store | done | missing | - | - | unknown | unknown | - | - | - | no |
| orders-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| helpdesk-add-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| linear-description | done | missing | - | - | unknown | unknown | - | - | - | no |
| bookmarks | done | missing | - | - | unknown | unknown | - | - | - | no |
| rental-fleet | done | missing | - | - | unknown | unknown | - | - | - | no |
| warehouse-inventory | done | missing | - | - | unknown | unknown | - | - | - | no |
| hotel-booking | done | missing | - | - | unknown | unknown | - | - | - | no |
| course-enrollments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| shipments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-charges | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-full | done | missing | - | - | unknown | unknown | - | - | - | no |
| forecast-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| live-market-feed-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |

**Totals:** 29 expected cases: 2 done, 7 stopped, 0 crashed, 20 missing, 0 invalid; 28.3 min (9 of 29 cases); $5.74 (9 of 29 cases); 1 unlogged.

**Median and p95:** 0.0 min (9 of 29 cases) and 8.2 min (9 of 29 cases); $0.00 (9 of 29 cases) and $1.59 (9 of 29 cases).

**Pass rate:** 2/29 (7%).

## Missing or invalid

- `helpdesk-sla`: no case.json in the run directory
- `bakery-vague`: no case.json in the run directory
- `video-codec-impossible`: no case.json in the run directory
- `billing-dunning`: no case.json in the run directory
- `todo-projects`: no case.json in the run directory
- `stripe-refunds`: no case.json in the run directory
- `petstore-store`: no case.json in the run directory
- `orders-csv`: no case.json in the run directory
- `helpdesk-add-refunds`: no case.json in the run directory
- `linear-description`: no case.json in the run directory
- `bookmarks`: no case.json in the run directory
- `rental-fleet`: no case.json in the run directory
- `warehouse-inventory`: no case.json in the run directory
- `hotel-booking`: no case.json in the run directory
- `course-enrollments-csv`: no case.json in the run directory
- `shipments-csv`: no case.json in the run directory
- `stripe-charges`: no case.json in the run directory
- `petstore-full`: no case.json in the run directory
- `forecast-impossible`: no case.json in the run directory
- `live-market-feed-impossible`: no case.json in the run directory

## Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | test.failed | 12 | bank charge: {"error":{"type":"invalid_request_error","code":"state.initial","message":"Invalid write to new charge: status expected pending (the initial state), found \"succeeded\""}} |
| 2 | openapi.field_enum | 3 | Make failure_reason an enum or state field with the values lost_or_stolen_card, expired_or_canceled_card, charge_for_pending_refund_disputed, insufficient_funds, declined, merchant_request, unknown. |
| 3 | schema.invalid | 1 | Match the shape in prod/world-format.md. |

## Unlogged

- `library-holds` create: seed ran but logged no attempt
