# retail-tau2

Hand-mapped from the tau2-bench retail domain (sierra-research/tau2-bench, commit 5bfa7e3, MIT). Nothing is copied: the seed is written by hand, and the mapping is `research/tau2-retail-expected-behaviour.md`.
`code/scripts/build-retail-tau2.ts` builds `world.yaml` through `checkWorld` and `saveWorld`. Edit the script, rerun it, and commit both.

## Mapping
| tau2 tool | Route |
|---|---|
| `find_user_id_by_email`, `find_user_id_by_name_zip`, `get_user_details` | `GET /customers?email=`, `GET /customers?last_name=&zip=`, `GET /customers/{id}`, `GET /payment_methods?customer_id=` |
| `get_order_details` | `GET /orders/{id}`, `GET /order_items?order_id=`, `GET /payment_entries?order_id=` |
| `get_product_details`, `get_item_details`, `list_all_product_types` | `GET /products`, `GET /variants?product_id=`, `GET /variants/{id}` |
| `cancel_pending_order` | `POST /orders/{id}/cancel` |
| `modify_pending_order_address`, `_payment`, `_items` | `POST /orders/{id}/address`, `/payment`, `/items/modify` |
| `return_delivered_order_items`, `exchange_delivered_order_items` | `POST /orders/{id}/return`, `/exchange` |
| `modify_user_address` | `POST /customers/{id}/address` |

`calculate` and `transfer_to_human_agents` have no route. Authentication, one user per conversation and the explicit yes are conversational policy that no tau2 tool enforces, so the world does not either.

## Deviations
Q1, Q3, Q4 and Q5 follow tau2's code. Q2 does not. See A-74 to A-78 in `research/decisions.md`.
Item ids in calls are variant ids, sent as comma-separated strings. Money is integer cents.

## Tasks
Three tasks are original. Five are hand-mapped from the shape of tau2 retail tasks (ids from `data/tau2/domains/retail/tasks.json` at commit 5bfa7e3). The people, orders and ids are invented, and no instruction text is copied.

| Task | Difficulty | tau2 task | Policy edge |
|---|---|---|---|
| `cancel_mistaken_order` | easy | none | cancel reason and refund to the original method |
| `exchange_lamp_with_gift_card` | medium | none | exchange paid with a gift card, no money moves (Q4) |
| `resize_shoes_and_move_address` | hard | none | address change after an item change (Q1) |
| `exchange_two_units_of_one_item` | medium | 105 | one exchange lists the same item id twice, so each unit is matched on its own |
| `modify_three_items_in_one_call` | hard | 36 | items change once per order, and each line takes its own new variant (the Q2 deviation, A-75) |
| `return_four_items_to_gift_card` | medium | 82 | one return per order, refunded to a gift card instead of the original method (Q4) |
| `cancel_one_order_return_from_another` | medium | 31 | a cancel on one order and a return on another, with no collateral |
| `modify_two_items_exact_gift_balance` | hard | 21 | a gift card whose balance equals the price difference exactly |

`npm run worldplay -- verify ../prod/worlds/retail-tau2` scores each solution 1, doing nothing 0 and each decoy below 1.
