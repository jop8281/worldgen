# Eval run high

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |
|---|---|---|---|---|--:|--:|---|---|---|
| library-holds | done | stopped | stage_time_exhausted at seed | plan 1, model 1, workflow 1, seed 1 | 9.8 | 1.20 + unknown | - | unlogged | no |
| stripe-refunds | done | stopped | stage_time_exhausted at tasks | plan 2, model 2, workflow 1, seed 2, tasks 3 | 11.8 | 2.14 + unknown | - | unlogged | no |
| insurance-claims | done | stopped | stage_time_exhausted at workflow | plan 2, model 1, workflow 1 | 8.4 | 0.98 + unknown | - | unlogged | no |
| helpdesk-sla | done | missing | - | - | unknown | unknown | - | - | no |
| bakery-vague | done | missing | - | - | unknown | unknown | - | - | no |
| video-codec-impossible | stopped | missing | - | - | unknown | unknown | - | - | no |
| billing-dunning | done | missing | - | - | unknown | unknown | - | - | no |
| todo-projects | done | missing | - | - | unknown | unknown | - | - | no |
| clinic-appointments | done | missing | - | - | unknown | unknown | - | - | no |
| petstore-store | done | missing | - | - | unknown | unknown | - | - | no |
| orders-csv | done | missing | - | - | unknown | unknown | - | - | no |
| linear-backlog-csv | done | missing | - | - | unknown | unknown | - | - | no |
| helpdesk-add-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-partial-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| retail-tau2-known | done | missing | - | - | unknown | unknown | - | - | no |
| linear-description | done | missing | - | - | unknown | unknown | - | - | no |
| bookmarks | done | missing | - | - | unknown | unknown | - | - | no |
| rental-fleet | done | missing | - | - | unknown | unknown | - | - | no |
| warehouse-inventory | done | missing | - | - | unknown | unknown | - | - | no |
| hotel-booking | done | missing | - | - | unknown | unknown | - | - | no |
| repair-desk | done | missing | - | - | unknown | unknown | - | - | no |
| course-enrollments-csv | done | missing | - | - | unknown | unknown | - | - | no |
| shipments-csv | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-customers | done | missing | - | - | unknown | unknown | - | - | no |
| stripe-charges | done | missing | - | - | unknown | unknown | - | - | no |
| petstore-full | done | missing | - | - | unknown | unknown | - | - | no |
| petstore-add-refunds | done | missing | - | - | unknown | unknown | - | - | no |
| forecast-impossible | stopped | missing | - | - | unknown | unknown | - | - | no |
| live-market-feed-impossible | stopped | missing | - | - | unknown | unknown | - | - | no |

**Totals:** 29 expected cases: 0 done, 3 stopped, 0 crashed, 26 missing, 0 invalid; 30.0 min (3 of 29 cases); $4.32 (3 of 29 cases) + unknown billing for 3 call(s); 3 unlogged.

**Median and p95:** 9.8 min (3 of 29 cases) and 11.8 min (3 of 29 cases); $1.20 (3 of 29 cases) and $2.14 (3 of 29 cases).

**Pass rate:** 0/29 (0%).

## Missing or invalid

- `helpdesk-sla`: no case.json in the run directory
- `bakery-vague`: no case.json in the run directory
- `video-codec-impossible`: no case.json in the run directory
- `billing-dunning`: no case.json in the run directory
- `todo-projects`: no case.json in the run directory
- `clinic-appointments`: no case.json in the run directory
- `petstore-store`: no case.json in the run directory
- `orders-csv`: no case.json in the run directory
- `linear-backlog-csv`: no case.json in the run directory
- `helpdesk-add-refunds`: no case.json in the run directory
- `stripe-partial-refunds`: no case.json in the run directory
- `retail-tau2-known`: no case.json in the run directory
- `linear-description`: no case.json in the run directory
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
| 1 | schema.invalid | 9 | Match the shape in prod/world-format.md. |
| 2 | openapi.field_enum | 3 | Make failure_reason an enum or state field with the values lost_or_stolen_card, expired_or_canceled_card, charge_for_pending_refund_disputed, insufficient_funds, declined, merchant_request, unknown. |
| 3 | task.pressure_unmet | 3 | The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for cancel_unsettled_northwind. |

## Unlogged

- `library-holds` create: 1 cancelled call(s) have unknown cost; totals include known cost only
- `stripe-refunds` create: 1 cancelled call(s) have unknown cost; totals include known cost only
- `insurance-claims` create: 1 cancelled call(s) have unknown cost; totals include known cost only
