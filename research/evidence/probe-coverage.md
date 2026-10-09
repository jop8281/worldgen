# Grader probe coverage

Measured, not proven (A-393). `worldplay verify` runs probes against every task's grader: each strict prefix of the solution's writes, each decoy, and the engine mutants. This page counts what those probes reached on the prod worlds. Doing nothing is a gate (it must score 0), not a probe, so it is left out.

- **Grader checks flipped.** A grader's checks are the goals and guards it records when it grades the solution: `ctx.goal`, `ctx.guard`, `ctx.guardChanges` and the engine's guard over a task's `allows`. A grader that records no goal returns its own number, so that return value is a check too. A check counts as flipped when some probe's run records it unmet or failed. A check no probe flipped is unprobed, not proven.
- **Mutant slots probed.** Each task gets 7 engine mutant kinds. A slot is probed when its kind found a request that committed a change; otherwise it has nothing to probe. The review on PR #147 counted these slots: "364 of 665 checks were never probed".
- **Unattributed probes.** A probe that scored below 1 without flipping any goal of a goal-scored grader, such as one an early `return 0` caught. Those `return 0` lines are not counted as checks, because finding them needs a parse of the grader.
- **Error rate.** Every probe run that verify counts must score below 1, or the world fails verification, so "0 full marks" below is a gate, not a measurement of how often an agent fools a grader. What the probes miss is the rows below with no flip, the slots with nothing to probe, and exploit classes no probe tries.

Measured on `stabilize/main` at `1308cb7c` with:

```sh
cd code && bun scripts/probe-coverage.ts ../prod/worlds
```

| World | Tasks | Grader checks flipped | Mutant slots probed | Unattributed probes |
|---|--:|--:|--:|--:|
| gen-bakery-vague | 3 | 5/5 (100.0%) | 12/21 (57.1%) | 0 |
| gen-billing-dunning | 3 | 9/11 (81.8%) | 9/21 (42.9%) | 0 |
| gen-bookmarks | 4 | 14/15 (93.3%) | 23/28 (82.1%) | 0 |
| gen-clinic-appointments | 4 | 11/12 (91.7%) | 12/28 (42.9%) | 0 |
| gen-course-enrollments | 3 | 10/11 (90.9%) | 8/21 (38.1%) | 0 |
| gen-helpdesk | 4 | 13/13 (100.0%) | 21/28 (75.0%) | 0 |
| gen-hotel-booking | 4 | 9/10 (90.0%) | 8/28 (28.6%) | 0 |
| gen-insurance-claims | 4 | 11/11 (100.0%) | 18/28 (64.3%) | 0 |
| gen-library-loans | 3 | 5/6 (83.3%) | 5/21 (23.8%) | 0 |
| gen-linear-backlog | 4 | 13/13 (100.0%) | 11/28 (39.3%) | 0 |
| gen-orders | 4 | 8/9 (88.9%) | 18/28 (64.3%) | 0 |
| gen-orders-customers | 3 | 6/6 (100.0%) | 13/21 (61.9%) | 0 |
| gen-petstore | 3 | 9/10 (90.0%) | 13/21 (61.9%) | 0 |
| gen-petstore-refunds | 6 | 25/27 (92.6%) | 22/42 (52.4%) | 0 |
| gen-refunds | 4 | 23/24 (95.8%) | 5/28 (17.9%) | 0 |
| gen-rental-fleet | 4 | 13/15 (86.7%) | 9/28 (32.1%) | 0 |
| gen-repair-desk | 3 | 8/8 (100.0%) | 17/21 (81.0%) | 0 |
| gen-retail-tau2-known | 4 | 4/4 (100.0%) | 3/28 (10.7%) | 0 |
| gen-shipments | 3 | 7/7 (100.0%) | 11/21 (52.4%) | 0 |
| gen-stripe-charges | 4 | 11/11 (100.0%) | 4/28 (14.3%) | 0 |
| gen-stripe-customers | 3 | 8/8 (100.0%) | 8/21 (38.1%) | 0 |
| gen-todo-projects | 3 | 5/5 (100.0%) | 13/21 (61.9%) | 0 |
| gen-warehouse-inventory | 4 | 11/11 (100.0%) | 10/28 (35.7%) | 0 |
| helpdesk | 3 | 8/8 (100.0%) | 16/21 (76.2%) | 0 |
| retail-tau2 | 8 | 26/38 (68.4%) | 12/56 (21.4%) | 0 |
| **Total** | 95 | 272/298 (91.3%) | 301/665 (45.3%) | 0 |

Probe runs graded: 893 (328 decoys, 264 prefixes, 301 mutants). Full marks among them: 0; verify allows one only for a mutant inside its task's declared `allows`.

| Probe | Checks it flipped |
|---|--:|
| decoy | 255 |
| retarget | 116 |
| other_row | 64 |
| extra_action | 62 |
| extra_create | 61 |
| prefix | 61 |
| perturb | 59 |
| target_field | 52 |
| extra_delete | 23 |

Checks no probe flipped:

- gen-billing-dunning cancel_harbor_dental_subscription: return
- gen-billing-dunning recover_bluefin_labs_with_backup_card: guard manual payment did not change the dunning attempt count
- gen-bookmarks merge_maya_ml_tags: guard Dev ml tag and its links are intact
- gen-clinic-appointments cancel_marias_far_appointment: return
- gen-course-enrollments drop_student_from_course: return
- gen-hotel-booking cancel_arriving_tomorrow_with_fee: goal one cancellation_fee of one night
- gen-library-loans return_longest_overdue_loan: return
- gen-orders pay_oldest_pending_for_customer: return
- gen-petstore release_stale_placed_orders: goal order ord_0001 deleted and its pet available
- gen-petstore-refunds release_stale_placed_orders: goal order ord_0001 deleted and its pet available
- gen-petstore-refunds request_refund_mochi: goal reason is given
- gen-refunds cancel_stale_requires_action_refunds: guard engine: only the changes tasks.cancel_stale_requires_action_refunds.allows declares
- gen-rental-fleet cancel_elena_reservation: guard only cancel_rental wrote the target
- gen-rental-fleet return_tomas_reyes_suv: guard only return_rental wrote the target rental
- retail-tau2 exchange_lamp_with_gift_card: guard only the target order, its lines and its new payment rows changed
- retail-tau2 resize_shoes_and_move_address: goal the shoes line is size 10 at its price
- retail-tau2 exchange_two_units_of_one_item: guard only the target order, its lines and its new payment rows changed
- retail-tau2 exchange_two_units_of_one_item: guard an exchange moves no money
- retail-tau2 modify_three_items_in_one_call: goal T-Shirt line is color: blue, size: L at its own price
- retail-tau2 modify_three_items_in_one_call: goal the order is pending_item_modified
- retail-tau2 modify_three_items_in_one_call: guard only the target order, its lines and its new payment rows changed
- retail-tau2 return_four_items_to_gift_card: guard only the target order, its lines and its new payment rows changed
- retail-tau2 return_four_items_to_gift_card: guard a return moves no money
- retail-tau2 modify_two_items_exact_gift_balance: goal Water Bottle line is capacity: 1000ml, material: steel at its own price
- retail-tau2 modify_two_items_exact_gift_balance: goal the order is pending_item_modified
- retail-tau2 modify_two_items_exact_gift_balance: guard only the target order, its lines and its new payment rows changed
