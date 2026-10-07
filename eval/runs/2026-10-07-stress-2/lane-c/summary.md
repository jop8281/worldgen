# Eval run lane-c

Suite `stress`, model `claude-sonnet-5-5`, budget $3.00 and 12 min per run.

| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |
|---|---|---|---|---|--:|--:|---|--:|---|---|
| linear-description | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 7.4 | 1.39 | pass (3 tasks) | 0.829 (68/82) | ok | yes |
| insurance-claims | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 8.9 | 1.58 | pass (4 tasks) | - | ok | yes |
| bookmarks | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 7.7 | 1.46 | pass (3 tasks) | - | ok | yes |
| rental-fleet | done | stopped | stage_time_exhausted at plan | plan 1 | 4.8 | 0.54 | - | - | ok | no |
| warehouse-inventory | done | done | - | plan 1, model 1, workflow 1, seed 1, tasks 1 | 9.8 | 1.60 | pass (4 tasks) | - | ok | yes |
| hotel-booking | done | stopped | stage_time_exhausted at seed | plan 1, model 1, workflow 1, seed 3 | 8.9 | 1.85 | - | - | ok | no |
| repair-desk | done | done | - | plan 2, model 1, workflow 1, seed 1, tasks 1 | 3.7 | 0.80 | pass (3 tasks) | - | ok | yes |

**Totals:** 7 cases: 5 done, 2 stopped, 0 crashed; 51.2 min; $9.21; 0 unlogged.

**Pass rate:** 5/7 (71%).

## Fidelity misses

- `linear-description` entity.missing workflow_state (8): no entity named workflow_state or state, status, issue_status
- `linear-description` transitions.stricter_than_real workflow_state.type (4): the world forbids backlog -> completed, unstarted -> completed, started -> backlog, completed -> backlog, completed -> started, completed -> canceled, canceled -> unstarted, canceled -> started, canceled -> completed
- `linear-description` route.missing GET /users (1): no route or action for GET /users
- `linear-description` route.missing POST /issues/{id}/comments (1): no route or action for POST /issues/{id}/comments
- `linear-description` missed 14 of 82
