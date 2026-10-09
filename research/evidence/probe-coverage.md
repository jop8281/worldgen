# Grader probe coverage

Measured, not proven (A-393). `worldplay verify` runs probes against every task's grader: each strict prefix of the solution's writes, the solution with each of its writes but the last left out (`omit_write`, A-401), each decoy, the engine mutants, and a swap of each free-text string the solution writes for nonsense (A-388). This page counts what those probes reached on the prod worlds. Doing nothing is a gate (it must score 0), not a probe, so it is left out.

- **Grader checks flipped.** A grader's checks are the goals and guards it records when it grades the solution: `ctx.goal`, `ctx.guard`, `ctx.guardChanges` and the engine's guard over a task's `allows`. A grader that records no goal returns its own number, so that return value is a check too. A check counts as flipped when some probe's run records it unmet or failed. A check no probe flipped is unprobed, not proven.
- **Mutant slots probed.** Each task gets 8 engine mutant kinds, `undone_write` among them since A-387. A slot is probed when its kind found a request that committed a change; otherwise it has nothing to probe. The review on PR #147 counted these slots when there were 7 kinds: "364 of 665 checks were never probed".
- **Unattributed probes.** A probe that scored below 1 without flipping any goal of a goal-scored grader, such as one an early `return 0` caught. Those `return 0` lines are not counted as checks, because finding them needs a parse of the grader.
- **Error rate.** Every probe run that verify counts must score below 1, or the world fails verification, so "0 full marks" below is a gate, not a measurement of how often an agent fools a grader. What the probes miss is the checks listed last with no flip, the slots with nothing to probe, and exploit classes no probe tries. The two classes review point 1 on #147 found, an edit undone before the end and free text no grader reads, now have probes (A-387, A-388): `undone_write` and `free_text` below.

Measured on the prod worlds of v2.0.0 (`5600d0f3`), with this branch's engine (A-401's `omit_write`), by:

```sh
cd code && bun scripts/probe-coverage.ts ../prod/worlds
```

| World | Tasks | Grader checks flipped | Mutant slots probed | Unattributed probes |
|---|--:|--:|--:|--:|
| gen-bakery-vague | 3 | 5/5 (100.0%) | 15/24 (62.5%) | 0 |
| gen-billing-dunning | 3 | 9/11 (81.8%) | 12/24 (50.0%) | 0 |
| gen-bookmarks | 4 | 14/15 (93.3%) | 27/32 (84.4%) | 0 |
| gen-clinic-appointments | 4 | 12/12 (100.0%) | 16/32 (50.0%) | 0 |
| gen-course-enrollments | 3 | 10/11 (90.9%) | 11/24 (45.8%) | 0 |
| gen-helpdesk | 4 | 13/13 (100.0%) | 25/32 (78.1%) | 0 |
| gen-hotel-booking | 4 | 9/10 (90.0%) | 12/32 (37.5%) | 0 |
| gen-insurance-claims | 4 | 11/11 (100.0%) | 22/32 (68.8%) | 0 |
| gen-library-loans | 3 | 5/6 (83.3%) | 8/24 (33.3%) | 0 |
| gen-linear-backlog | 4 | 13/13 (100.0%) | 15/32 (46.9%) | 0 |
| gen-orders | 4 | 8/9 (88.9%) | 22/32 (68.8%) | 0 |
| gen-orders-customers | 3 | 7/7 (100.0%) | 16/24 (66.7%) | 0 |
| gen-petstore | 3 | 10/10 (100.0%) | 13/24 (54.2%) | 0 |
| gen-petstore-refunds | 6 | 27/27 (100.0%) | 22/48 (45.8%) | 0 |
| gen-refunds | 4 | 23/24 (95.8%) | 5/32 (15.6%) | 0 |
| gen-rental-fleet | 4 | 13/15 (86.7%) | 13/32 (40.6%) | 0 |
| gen-repair-desk | 3 | 8/8 (100.0%) | 20/24 (83.3%) | 0 |
| gen-retail-tau2-known | 4 | 4/4 (100.0%) | 3/32 (9.4%) | 0 |
| gen-shipments | 3 | 7/7 (100.0%) | 14/24 (58.3%) | 0 |
| gen-stripe-charges | 4 | 11/11 (100.0%) | 4/32 (12.5%) | 0 |
| gen-stripe-customers | 3 | 8/8 (100.0%) | 8/24 (33.3%) | 0 |
| gen-todo-projects | 3 | 5/5 (100.0%) | 16/24 (66.7%) | 0 |
| gen-warehouse-inventory | 4 | 11/11 (100.0%) | 14/32 (43.8%) | 0 |
| helpdesk | 3 | 8/8 (100.0%) | 19/24 (79.2%) | 0 |
| retail-tau2 | 8 | 27/38 (71.1%) | 12/64 (18.8%) | 0 |
| **Total** | 95 | 278/299 (93.0%) | 364/760 (47.9%) | 0 |

Probe runs graded, free-text swaps and one-write omissions aside: 956 (328 decoys, 264 prefixes, 364 mutants). Full marks among them: 0; verify allows one only for a mutant inside its task's declared `allows`.

| Probe | Checks it flipped |
|---|--:|
| decoy | 257 |
| retarget | 118 |
| undone_write | 70 |
| omit_write | 70 |
| other_row | 64 |
| extra_action | 62 |
| prefix | 62 |
| extra_create | 61 |
| perturb | 59 |
| target_field | 52 |
| free_text | 25 |
| extra_delete | 23 |

Checks no probe flipped:

- gen-billing-dunning cancel_harbor_dental_subscription: return
- gen-billing-dunning recover_bluefin_labs_with_backup_card: guard manual payment did not change the dunning attempt count
- gen-bookmarks merge_maya_ml_tags: guard Dev ml tag and its links are intact
- gen-course-enrollments drop_student_from_course: return
- gen-hotel-booking cancel_arriving_tomorrow_with_fee: goal one cancellation_fee of one night
- gen-library-loans return_longest_overdue_loan: return
- gen-orders pay_oldest_pending_for_customer: return
- gen-refunds cancel_stale_requires_action_refunds: guard engine: only the changes tasks.cancel_stale_requires_action_refunds.allows declares
- gen-rental-fleet cancel_elena_reservation: guard only cancel_rental wrote the target
- gen-rental-fleet return_tomas_reyes_suv: guard only return_rental wrote the target rental
- retail-tau2 exchange_lamp_with_gift_card: guard only the target order, its lines and its new payment rows changed
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

Each of these is classified in [probe-gaps.md](probe-gaps.md): a probe kind we don't have, redundant, weak or unreachable by design.
