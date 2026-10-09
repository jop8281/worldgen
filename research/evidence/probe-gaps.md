# The 24 grader checks no probe flips

[probe-coverage.md](probe-coverage.md) at v2.0.0 (`5600d0f3`) lists 24 grader checks that no verify probe flipped (A-393). Each one is classified here as one of these:

- **(a)** reachable by a probe kind we don't have yet;
- **(b)** redundant with another check;
- **(c)** a weak grader check that accepts wrong states;
- **(d)** unreachable by design.

Each verdict was checked against the grader source, the world's routes, actions and readonly fields, and replays from seed. No world was edited. Since A-401, `omit_write` flips the three checks marked for it below, so [probe-coverage.md](probe-coverage.md) now lists 21: 278 of 299 are flipped.

| Class | Checks |
|---|--:|
| (a) a probe kind we don't have | 13 |
| (b) redundant with another check | 4 |
| (c) a weak check that accepts wrong states | 0 |
| (d) unreachable by design | 7 |
| **Total** | 24 |

## Each check

| World | Task | Check | Class | Evidence |
|---|---|---|---|---|
| gen-billing-dunning | cancel_harbor_dental_subscription | return | d | The subscription's status, canceled_at and cancel_reason are readonly with no update route, `cancel_subscription` takes no input, and `change_plan` or `pay_invoice` in its place is refused (400, 404). So with the guard held, only doing nothing fails the return, and that is the noop gate. |
| gen-billing-dunning | recover_bluefin_labs_with_backup_card | guard manual payment did not change the dunning attempt count | d | `invoice.attempt_count` is readonly with no update route. Only `subscribe` and the `billing_cycle` and `dunning_retry` jobs write it, and no probe advances the clock past the solution's own time. |
| gen-bookmarks | merge_maya_ml_tags | guard Dev ml tag and its links are intact | b | "Only the merge rows changed" rejects every tag change except deleting Maya's ml tag, and every bookmark_tag change outside her ml and machine-learning links. Any state that breaks Dev's tag or links fails that guard too. |
| gen-course-enrollments | drop_student_from_course | return | d | The enrollment's status and grade are readonly with no update route. `complete_enrollment` in place of the drop is refused without a grade (400), and with one it writes grade, which `allows` rejects. Only the noop gate fails the return with the guard held. |
| gen-hotel-booking | cancel_arriving_tomorrow_with_fee | goal one cancellation_fee of one night | b | The grader reaches this goal only after `end.cancellation_fee === target.nightly_rate`. `cancel_reservation` writes the fee charge's amount and the reservation's cancellation_fee from one value, and every folio_charge field is readonly with no update route. |
| gen-library-loans | return_longest_overdue_loan | return | d | The loan has no update route. `renew_loan` and `pay_fine` in place of the return are refused (409), and either one after it writes a field the guard rejects (extra_action flipped the guard). |
| gen-orders | pay_oldest_pending_for_customer | return | d | `order.status` is readonly. `ship_order` and `deliver_order` refuse a pending order (409), and `cancel_order` or `refund_order` need a reason (400) and write a non-paid event the guard rejects. |
| gen-petstore | release_stale_placed_orders | goal order ord_0001 deleted and its pet available | a | Prefixes, the retarget swap and the first decoy all leave out the **last** delete, ord_0002. Nothing leaves out ord_0001 alone. The prototype `omit_write` flips it. |
| gen-petstore-refunds | release_stale_placed_orders | goal order ord_0001 deleted and its pet available | a | The same task and grader as gen-petstore. The prototype `omit_write` flips it. |
| gen-refunds | cancel_stale_requires_action_refunds | guard engine: only the changes tasks.cancel_stale_requires_action_refunds.allows declares | a | Only a non-status change to a target refund (or a non-amount charge field) fails `allows` while the grader's own guard holds. Refunds have no update route, and `update_refund(metadata)` with the empty body extra_action sends commits nothing. A probe that fills the action's input would reach it. |
| gen-rental-fleet | cancel_elena_reservation | guard only cancel_rental wrote the target | a | Every other action with the solution's body is refused (400, 409). `pickup_rental` is legal on a reserved rental but needs `odometer_out`, so only a probe that fills an action's input would reach it. |
| gen-rental-fleet | return_tomas_reyes_suv | guard only return_rental wrote the target rental | a | On an active rental, pickup and cancel need `reserved` and close needs `returned`. Only an action after the return with its own input (`waive_late_fee` with a reason) writes the target again, and extra_action sends an empty body (400). |
| retail-tau2 | exchange_lamp_with_gift_card | guard only the target order, its lines and its new payment rows changed | a | There are no create, update or delete routes, so every engine mutant has nothing to probe. The exchange's item ids bind it to the target order, so retarget and other_row are refused. Only an action on another order with that order's own valid input fails the guard. |
| retail-tau2 | resize_shoes_and_move_address | goal the shoes line is size 10 at its price | a | Both decoys still change the shoes, and the single perturb run swapped the payment method. The prototype `omit_write` (the address change without the item change) flips it. |
| retail-tau2 | exchange_two_units_of_one_item | guard only the target order, its lines and its new payment rows changed | a | As in exchange_lamp_with_gift_card: only an action on another order with its own valid input fails the guard. |
| retail-tau2 | exchange_two_units_of_one_item | guard an exchange moves no money | d | Payment entries come only from cancel, modify payment and modify items, which all require a pending order. The target is delivered, and exchange and return create none. |
| retail-tau2 | modify_three_items_in_one_call | goal T-Shirt line is color: blue, size: L at its own price | a | Both decoys change the T-shirt correctly. `new_item_ids` is a comma-joined list, which perturb never splits. The prototype `perturb_each` (one element swapped) flips it. |
| retail-tau2 | modify_three_items_in_one_call | goal the order is pending_item_modified | b | Only a committed `modify_pending_order_items` changes a line, and it always sets this status. So it holds whenever any line goal does, and fails only when no item change committed: the noop gate. |
| retail-tau2 | modify_three_items_in_one_call | guard only the target order, its lines and its new payment rows changed | a | As in exchange_lamp_with_gift_card. |
| retail-tau2 | return_four_items_to_gift_card | guard only the target order, its lines and its new payment rows changed | a | As in exchange_lamp_with_gift_card. |
| retail-tau2 | return_four_items_to_gift_card | guard a return moves no money | d | As in exchange_two_units_of_one_item: no call can add a payment entry to a delivered order. |
| retail-tau2 | modify_two_items_exact_gift_balance | goal Water Bottle line is capacity: 1000ml, material: steel at its own price | a | The only partial decoy skips the T-shirt, never the bottle. The prototype `perturb_each` (one element of `new_item_ids` swapped) flips it. |
| retail-tau2 | modify_two_items_exact_gift_balance | goal the order is pending_item_modified | b | As in modify_three_items_in_one_call: it is implied by any line goal and fails only for the noop gate. |
| retail-tau2 | modify_two_items_exact_gift_balance | guard only the target order, its lines and its new payment rows changed | a | As in exchange_lamp_with_gift_card. |

The (d) checks and the two status goals in (b) are not dead weight. Each guards a state that the world's own API can't reach today: a job firing, a refund through a new action, an action outside its contract. They encode the task's contract, and the noop gate already shows their `return`s discriminate. No (c) check was found: none of the 24 accepts a wrong state.

## The (a) checks, by the probe that would reach them

| Probe kind | Checks | Sound as a gate | Proposal |
|---|--:|---|---|
| `omit_write`: the solution's successful calls replayed with one write left out (every write but the last, which prefixes already cut) | 3 | Yes. Over all 95 prod tasks it graded no full marks, and it is the prefix gate (every write matters) applied to any single write | **Implemented (A-401):** a verify gate next to the prefixes; a score of 1 is `task.omission_full_marks` |
| `perturb_each`: every seed-id value in a write's body, each element of a comma-joined id list included, swapped for another row of that entity | 2 | **No.** It gave full marks to gen-warehouse-inventory `restock_pick_bins` for a different source bin, and that instruction lets any bulk bin that holds the SKU be the source. That is a correct answer, the reason A-199 keeps perturb to one swap | Kept out (A-199): never a verify gate |
| Action with filled input: an action the solution did not call, on a target or another row, with each required input filled from seed values of its declared type | 8 | Not measured. It needs input synthesis (ids of the right entity, choices, plausible strings) | A future decision |

The prototype was a scratch script outside the engine. It replayed each task's solution from seed and graded every candidate that committed and ended unlike the solution, 384 runs in all. It flipped the 5 checks marked `omit_write` and `perturb_each` above. One probe kind, `omit_write`, covers 3 checks at no verify cost, and A-401 implements it in `verifyTask`.

Measured with `bun scripts/probe-coverage.ts ../prod/worlds` at `5600d0f3`; the per-check dossiers and the prototype were scratch scripts, not committed.
