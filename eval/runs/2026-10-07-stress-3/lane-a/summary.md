# Eval run lane-a

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| helpdesk-sla | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 7.2 | 1.59 | pass (4 tasks) | 0.957 (68/71) | ok | yes |
| todo-projects | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 4.4 | 0.84 | pass (4 tasks) | - | ok | yes |
| petstore-store | done | done | - | plan 2, model 1, workflow 2, seed 2, tasks 3 | 5.6 | 1.28 | pass (3 tasks) | - | ok | yes |
| orders-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 5.1 | 1.10 | pass (4 tasks) | - | ok | yes |
| helpdesk-add-refunds | done | stopped | model_error | plan 1, model 1, workflow 1, seed 1, tasks 1 | 5.2 | 0.99 | - | - | ok | no |
| linear-description | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | no world: last phase did not finish | ok | no |
| bookmarks | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| shipments-csv | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| stripe-charges | done | stopped | model_error | plan 1 | 0.0 | 0.00 | - | - | ok | no |
| bakery-vague | done | missing | - | - | unknown | unknown | - | - | - | no |
| video-codec-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| library-holds | done | missing | - | - | unknown | unknown | - | - | - | no |
| billing-dunning | done | missing | - | - | unknown | unknown | - | - | - | no |
| clinic-appointments | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| linear-backlog-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-partial-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| retail-tau2-known | done | missing | - | - | unknown | unknown | - | - | - | no |
| insurance-claims | done | missing | - | - | unknown | unknown | - | - | - | no |
| rental-fleet | done | missing | - | - | unknown | unknown | - | - | - | no |
| warehouse-inventory | done | missing | - | - | unknown | unknown | - | - | - | no |
| hotel-booking | done | missing | - | - | unknown | unknown | - | - | - | no |
| repair-desk | done | missing | - | - | unknown | unknown | - | - | - | no |
| course-enrollments-csv | done | missing | - | - | unknown | unknown | - | - | - | no |
| stripe-customers | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-full | done | missing | - | - | unknown | unknown | - | - | - | no |
| petstore-add-refunds | done | missing | - | - | unknown | unknown | - | - | - | no |
| forecast-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |
| live-market-feed-impossible | stopped | missing | - | - | unknown | unknown | - | - | - | no |

**Totals:** 29 expected cases: 4 done, 5 stopped, 0 crashed, 20 missing, 0 invalid; 27.5 min (9 of 29 cases); $5.81 (9 of 29 cases); 0 unlogged.

**Median and p95:** 4.4 min (9 of 29 cases) and 7.2 min (9 of 29 cases); $0.84 (9 of 29 cases) and $1.59 (9 of 29 cases).

**Pass rate:** 4/29 (14%).

## Missing or invalid

- `bakery-vague`: no case.json in the run directory
- `video-codec-impossible`: no case.json in the run directory
- `library-holds`: no case.json in the run directory
- `billing-dunning`: no case.json in the run directory
- `clinic-appointments`: no case.json in the run directory
- `stripe-refunds`: no case.json in the run directory
- `linear-backlog-csv`: no case.json in the run directory
- `stripe-partial-refunds`: no case.json in the run directory
- `retail-tau2-known`: no case.json in the run directory
- `insurance-claims`: no case.json in the run directory
- `rental-fleet`: no case.json in the run directory
- `warehouse-inventory`: no case.json in the run directory
- `hotel-booking`: no case.json in the run directory
- `repair-desk`: no case.json in the run directory
- `course-enrollments-csv`: no case.json in the run directory
- `stripe-customers`: no case.json in the run directory
- `petstore-full`: no case.json in the run directory
- `petstore-add-refunds`: no case.json in the run directory
- `forecast-impossible`: no case.json in the run directory
- `live-market-feed-impossible`: no case.json in the run directory

## Triage

| rank | issue code | count | generic fix |
|--:|---|--:|---|
| 1 | schema.invalid | 9 | Match the shape in prod/world-format.md. |
| 2 | openapi.field_enum | 1 | Make status an enum or state field with the values placed, approved, delivered. |
| 3 | task.noop_not_zero | 1 | The grader passes on the seed. Grade the change, not the start state. |

## Fidelity misses

- `helpdesk-sla` field.missing ticket.type (1): ticket has no field named type or ticket_type, kind
- `helpdesk-sla` state.missing ticket.status.hold (1): status has no state named hold
- `helpdesk-sla` route.missing GET /search (1): no route or action for GET /search
- `helpdesk-sla` missed 3 of 71
