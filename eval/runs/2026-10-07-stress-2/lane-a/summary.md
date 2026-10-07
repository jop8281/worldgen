# Eval run lane-a

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| helpdesk-sla | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 6.5 | 1.25 | pass (3 tasks) | 0.957 (68/71) | ok | yes |
| bakery-vague | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 2 | 8.0 | 1.61 | pass (3 tasks) | - | ok | yes |
| video-codec-impossible | stopped | stopped | input_rejected | plan 1 | 0.2 | 0.03 | - | - | ok | yes |
| library-holds | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 8.4 | 1.41 | pass (3 tasks) | - | ok | yes |
| billing-dunning | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 7.0 | 1.19 | pass (3 tasks) | - | ok | yes |
| todo-projects | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 2 | 6.1 | 1.17 | pass (4 tasks) | - | ok | yes |
| clinic-appointments | done | done | - | plan 1, model 1, workflow 2, seed 1, tasks 1 | 8.9 | 1.62 | pass (3 tasks) | - | ok | yes |

**Totals:** 7 cases: 6 done, 1 stopped, 0 crashed; 45.1 min; $8.29; 0 unlogged.

**Pass rate:** 7/7 (100%).

## Fidelity misses

- `helpdesk-sla` field.missing ticket.type (1): ticket has no field named type or ticket_type, kind
- `helpdesk-sla` state.missing ticket.status.hold (1): status has no state named hold
- `helpdesk-sla` route.missing GET /search (1): no route or action for GET /search
- `helpdesk-sla` missed 3 of 71
