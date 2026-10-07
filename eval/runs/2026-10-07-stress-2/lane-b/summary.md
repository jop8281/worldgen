# Eval run lane-b

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| stripe-refunds | done | done | - | plan 1, model 2, workflow 1, seed 1, tasks 1 | 7.5 | 1.45 | pass (3 tasks) | - | ok | yes |
| petstore-store | done | stopped | no_progress at workflow | plan 2, model 1, workflow 2 | 3.3 | 0.66 | - | - | ok | no |
| orders-csv | done | done | - | plan 1, model 1, workflow 1, seed 3, tasks 1 | 5.2 | 1.27 | pass (4 tasks) | - | ok | yes |
| linear-backlog-csv | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 7.1 | 1.54 | pass (4 tasks) | - | ok | yes |
| helpdesk-add-refunds | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1; change: plan 1, model 1, workflow 1, seed 1, tasks 2 | 11.0 | 2.73 | pass (6 tasks) | - | ok | yes |
| stripe-partial-refunds | done | stopped | no_progress at workflow | plan 1, model 2, workflow 2 | 6.4 | 1.30 | - | - | ok | no |
| retail-tau2-known | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 7.7 | 1.41 | pass (3 tasks) | 0.878 (65/74) | ok | yes |

**Totals:** 7 cases: 5 done, 2 stopped, 0 crashed; 48.2 min; $10.36; 0 unlogged.

**Pass rate:** 5/7 (71%).

## Fidelity misses

- `retail-tau2-known` field.missing user.zip (1): user has no field named zip or zip_code, postal_code
- `retail-tau2-known` state.missing order.status.processed (1): status has no state named processed
- `retail-tau2-known` state.missing order.status.pending_item_modified (1): status has no state named pending_item_modified
- `retail-tau2-known` state.missing order.status.return_requested (2): status has no state named return_requested
- `retail-tau2-known` state.missing order.status.exchange_requested (2): status has no state named exchange_requested
- `retail-tau2-known` route.missing POST /orders/{id}/modify-items (2): no route or action for POST /orders/{id}/modify-items
- `retail-tau2-known` missed 9 of 74
