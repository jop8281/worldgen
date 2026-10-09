# Difficulty: j163-pilot

Models: claude-sonnet-5-5. Episodes per task per model: 3, each with a $0.75 budget.

Charged $2.187461 of the $13.96 budget over 18 episodes. An episode with a call of unknown billing is charged its whole budget; there were 0 such calls.

Stop: complete.

A pass is an engine score of 1. A trial is a graded episode that stopped done or at its turn, budget or time limit; a model error, a refusal, a world or grade error and an interruption are not trials. The interval is Wilson 95%. The measured tier is easy at a pass rate of 2/3 or more, medium at 1/3 or more, and hard below.

The engine score certifies the final world state only. It does not independently certify that the final reply is factually correct.

## By task

| world | task | labeled | measured | agrees | passes / trials | pass rate | 95% interval |
|---|---|---|---|---|---|---|---|
| helpdesk | assign_newest_acme_ticket | easy | easy | yes | 3 / 3 | 1 | 0.439 to 1 |
| helpdesk | escalate_breached_printer_ticket | medium | easy | no | 3 / 3 | 1 | 0.439 to 1 |
| helpdesk | escalate_breached_enterprise_tickets | hard | easy | no | 3 / 3 | 1 | 0.439 to 1 |
| gen-orders-customers | ship_ada_paid_order | easy | easy | yes | 3 / 3 | 1 | 0.439 to 1 |
| gen-orders-customers | cancel_customer_unpaid_orders | medium | easy | no | 3 / 3 | 1 | 0.439 to 1 |
| gen-orders-customers | refund_large_gb_pro_orders | hard | easy | no | 3 / 3 | 1 | 0.439 to 1 |

## By task and model

| world | task | labeled | model | measured | passes / trials | pass rate | 95% interval | episodes | stops | cost USD | USD per pass |
|---|---|---|---|---|---|---|---|---|---|---|---|
| helpdesk | assign_newest_acme_ticket | easy | claude-sonnet-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 0.254977 | 0.084992 |
| helpdesk | escalate_breached_printer_ticket | medium | claude-sonnet-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 0.110846 | 0.036949 |
| helpdesk | escalate_breached_enterprise_tickets | hard | claude-sonnet-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 1.346338 | 0.448779 |
| gen-orders-customers | ship_ada_paid_order | easy | claude-sonnet-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 0.148812 | 0.049604 |
| gen-orders-customers | cancel_customer_unpaid_orders | medium | claude-sonnet-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 0.120916 | 0.040305 |
| gen-orders-customers | refund_large_gb_pro_orders | hard | claude-sonnet-5-5 | easy | 3 / 3 | 1 | 0.439 to 1 | 3 | done 3 | 0.205573 | 0.068524 |
