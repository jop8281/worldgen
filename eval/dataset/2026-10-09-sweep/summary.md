# J175 sweep, 2026-10-09: Haiku ×3 on every task, Sonnet ×3 where Haiku missed

How it ran (J175, P-YOS-6 points 2 and 3):

- The engine and the solver code are trunk `23520120` for every pass. #181 (J172, append-only turns) had not merged.
- Each run is one `bun run dataset` per world, with each world on its own small Boat VM. Every teardown was confirmed by the CLI. Boat list usage was $0.19 across 87 VMs.
- Settings: `--max-turns 30`, `--budget-usd 1` per world run, `--max-minutes 60`. The cost ledger was isolated, with `WORLDGEN_MAX_DAILY_LLM_USD=15`. `TMPDIR` was set to an empty directory per run (see J188).
- Passes:
  - `p1`, `p2`, `p3`: `claude-haiku-5-5` once on every task of all 25 worlds. `p1/gen-bookmarks` was the one-world probe that ran first.
  - `s1`, `s2`, `s3` (and `t1`–`t3` below): `claude-sonnet-5-5` once on every task of the 4 worlds where Haiku missed a task.
- `bun run dataset` has no per-task filter, so passes cover whole worlds.
- Each `<pass>/<world>/` holds the schema-2 export (`dataset.jsonl`), its `manifest.json` and `REPORT.md`. Failures are included.
- The three Haiku passes are also the J180 teacher export: 285 Haiku episodes with failures, at no new spend.

Read the Sonnet column with care:

- Sonnet episodes on the hard clinic, rental-fleet and warehouse tasks cost up to $0.82 each. The $1 per-world run budget ran out before those tasks, so they are recorded as infra (`run_budget_limit`, or a `model_error` at the budget).
- Those tasks are unmeasured for Sonnet, not failed by it.

Follow-up `t1`, `t2`, `t3` (J175b):

- What ran: Sonnet ×3 on clinic-appointments and rental-fleet with `--budget-usd 3` per world run, on a separate ledger capped at $9 from the v2.5 reserve.
- The hard tasks still don't measure cleanly for Sonnet. One episode of `record_yesterdays_no_shows` cost $1.99 and another $2.98.
- The ledger admits each call at its bound, so the 6 concurrent runs hit the $9 cap at $7.21 actually spent. Later calls were refused as `model_error` (infra).
- Graded Sonnet trials now: `record_yesterdays_no_shows` 0/1, `triage_small_claims` 0/1 (turn limit), `book_earliest_cardiology_slot` 4/5. `clear_dr_patel_calendar_for_leave` is still unmeasured.
- Spend: total model spend across both ledgers is $21.76 (Haiku $4.81, Sonnet $16.95).

95 tasks in 25 prod worlds. Haiku: 267/284 episodes succeeded. Sonnet: 41/47.

| Measured | Tasks |
|---|---|
| easy | 89 |
| flaky-for-haiku | 1 |
| hard-for-everyone | 3 |
| hard-for-haiku (sonnet unmeasured: budget) | 1 |
| hard-for-haiku, flaky-for-sonnet | 1 |

| Verdicts | success | partial | failure | infra |
|---|---|---|---|---|
| Haiku | 267 | 11 | 6 | 1 |
| Sonnet | 41 | 2 | 4 | 25 |

Model spend: Haiku $4.81 (2567 calls), Sonnet $16.95 (509 calls), total $21.76.

## Tasks Haiku missed at least once

The input for J179 and J182. k/n counts graded episodes; an infra episode (a run budget, a model error) is not a trial and is shown apart.

| World | Task | Labeled | Haiku | Sonnet | Measured | Failure causes |
|---|---|---|---|---|---|---|
| gen-clinic-appointments | book_earliest_cardiology_slot | medium | 0/3 | 4/5 (+1 infra) | hard-for-haiku, flaky-for-sonnet | failure: guard broken ×4; infra: model_error ×1 |
| gen-clinic-appointments | clear_dr_patel_calendar_for_leave | hard | 0/3 | 0/0 (+6 infra) | hard-for-haiku (sonnet unmeasured: budget) | partial: scored 0.8333333333333334 ×1; partial: scored 0.8431372549019608 ×1; partial: scored 0.823529411764706 ×1; infra: run budget ×4; infra: model_error ×2 |
| gen-clinic-appointments | record_yesterdays_no_shows | hard | 0/3 | 0/1 (+5 infra) | hard-for-everyone | partial: scored 0.7666666666666667 ×1; partial: scored 0.7333333333333333 ×1; partial: turn_limit ×1; infra: model_error ×5; partial: scored 0.8333333333333334 ×1 |
| gen-hotel-booking | cancel_arriving_tomorrow_with_fee | medium | 0/3 | 0/3 | hard-for-everyone | failure: scored 0 ×6 |
| gen-rental-fleet | triage_small_claims | hard | 0/3 | 0/1 (+5 infra) | hard-for-everyone | partial: turn_limit ×3; partial: scored 0.9642857142857143 ×1; infra: model_error ×5 |
| gen-shipments | claim_for_late_delivered_shipments | hard | 2/2 (+1 infra) | - | easy | infra: grade_error ×1 |
| gen-warehouse-inventory | restock_pick_bins | hard | 1/3 | 0/0 (+3 infra) | flaky-for-haiku | partial: scored 0.6923076923076923 ×2; infra: model_error ×2; infra: world_error ×1 |

## Every task

| World | Task | Labeled | Haiku | Sonnet | Measured |
|---|---|---|---|---|---|
| gen-bakery-vague | bake_croissants_after_restock | medium | 3/3 | - | easy |
| gen-bakery-vague | cancel_tomorrows_orders_for_discontinued_product | hard | 3/3 | - | easy |
| gen-bakery-vague | mark_marias_order_ready | easy | 3/3 | - | easy |
| gen-billing-dunning | cancel_final_retry_business_subscriptions | hard | 3/3 | - | easy |
| gen-billing-dunning | cancel_harbor_dental_subscription | easy | 3/3 | - | easy |
| gen-billing-dunning | recover_bluefin_labs_with_backup_card | medium | 3/3 | - | easy |
| gen-bookmarks | mark_postgres_article_read | easy | 3/3 | - | easy |
| gen-bookmarks | merge_maya_ml_tags | medium | 3/3 | - | easy |
| gen-bookmarks | share_maya_big_private_collections | hard | 3/3 | - | easy |
| gen-bookmarks | trash_maya_broken_links | hard | 3/3 | - | easy |
| gen-clinic-appointments | book_earliest_cardiology_slot | medium | 0/3 | 4/5 (+1 infra) | hard-for-haiku, flaky-for-sonnet |
| gen-clinic-appointments | cancel_marias_far_appointment | easy | 3/3 | 5/5 (+1 infra) | easy |
| gen-clinic-appointments | clear_dr_patel_calendar_for_leave | hard | 0/3 | 0/0 (+6 infra) | hard-for-haiku (sonnet unmeasured: budget) |
| gen-clinic-appointments | record_yesterdays_no_shows | hard | 0/3 | 0/1 (+5 infra) | hard-for-everyone |
| gen-course-enrollments | drop_student_from_course | easy | 3/3 | - | easy |
| gen-course-enrollments | enroll_into_full_course | medium | 3/3 | - | easy |
| gen-course-enrollments | grade_completed_department_courses | hard | 3/3 | - | easy |
| gen-helpdesk | assign_newest_acme_ticket | easy | 3/3 | - | easy |
| gen-helpdesk | escalate_breached_enterprise_tickets | hard | 3/3 | - | easy |
| gen-helpdesk | escalate_breached_printer_ticket | medium | 3/3 | - | easy |
| gen-helpdesk | resolve_and_reopen_stale_ticket | medium | 3/3 | - | easy |
| gen-hotel-booking | cancel_arriving_tomorrow_with_fee | medium | 0/3 | 0/3 | hard-for-everyone |
| gen-hotel-booking | cancel_distant_reservation | easy | 3/3 | 3/3 | easy |
| gen-hotel-booking | move_booking_to_free_room | medium | 3/3 | 3/3 | easy |
| gen-hotel-booking | relocate_all_from_maintenance_room | hard | 3/3 | 3/3 | easy |
| gen-insurance-claims | approve_and_pay_clean_claim | medium | 3/3 | - | easy |
| gen-insurance-claims | approve_unflagged_water_damage_claims | hard | 3/3 | - | easy |
| gen-insurance-claims | confirm_high_severity_fraud_flag | medium | 3/3 | - | easy |
| gen-insurance-claims | start_review_newest_submitted_claim | easy | 3/3 | - | easy |
| gen-library-loans | clear_riverside_overdue | hard | 3/3 | - | easy |
| gen-library-loans | collect_top_fines_member | medium | 3/3 | - | easy |
| gen-library-loans | return_longest_overdue_loan | easy | 3/3 | - | easy |
| gen-linear-backlog | cancel_stale_backlog_in_milestone | medium | 3/3 | - | easy |
| gen-linear-backlog | close_out_epic_with_sub_issues | hard | 3/3 | - | easy |
| gen-linear-backlog | merge_duplicate_issues | hard | 3/3 | - | easy |
| gen-linear-backlog | start_the_welcome_issue | easy | 3/3 | - | easy |
| gen-orders | cancel_stale_pending_with_gift_note | medium | 3/3 | - | easy |
| gen-orders | pay_oldest_pending_for_customer | easy | 3/3 | - | easy |
| gen-orders | refund_delivered_big_orders_for_customer | medium | 3/3 | - | easy |
| gen-orders | ship_all_paid_large_orders | hard | 3/3 | - | easy |
| gen-orders-customers | cancel_customer_unpaid_orders | medium | 3/3 | - | easy |
| gen-orders-customers | refund_large_gb_pro_orders | hard | 3/3 | - | easy |
| gen-orders-customers | ship_ada_paid_order | easy | 3/3 | - | easy |
| gen-petstore | deliver_cat_juniper | medium | 3/3 | - | easy |
| gen-petstore | order_biscuit | easy | 3/3 | - | easy |
| gen-petstore | release_stale_placed_orders | hard | 3/3 | - | easy |
| gen-petstore-refunds | deliver_cat_juniper | medium | 3/3 | - | easy |
| gen-petstore-refunds | order_biscuit | easy | 3/3 | - | easy |
| gen-petstore-refunds | release_stale_placed_orders | hard | 3/3 | - | easy |
| gen-petstore-refunds | request_refund_mochi | easy | 3/3 | - | easy |
| gen-petstore-refunds | restock_pepper_refund | medium | 3/3 | - | easy |
| gen-petstore-refunds | settle_requested_refunds | hard | 3/3 | - | easy |
| gen-refunds | cancel_stale_requires_action_refunds | hard | 3/3 | - | easy |
| gen-refunds | merge_ticket_into_refund_metadata | medium | 3/3 | - | easy |
| gen-refunds | refund_annual_plan_in_full | easy | 3/3 | - | easy |
| gen-refunds | refund_remaining_balance | medium | 3/3 | - | easy |
| gen-rental-fleet | cancel_elena_reservation | easy | 3/3 | 4/4 (+2 infra) | easy |
| gen-rental-fleet | return_tomas_reyes_suv | medium | 3/3 | 6/6 | easy |
| gen-rental-fleet | triage_small_claims | hard | 0/3 | 0/1 (+5 infra) | hard-for-everyone |
| gen-rental-fleet | waive_priya_late_fee | medium | 3/3 | 5/5 (+1 infra) | easy |
| gen-repair-desk | assign_and_start_laptop | medium | 3/3 | - | easy |
| gen-repair-desk | raise_espresso_priority | easy | 3/3 | - | easy |
| gen-repair-desk | reassign_and_start_dana_queue | hard | 3/3 | - | easy |
| gen-retail-tau2-known | cancel_pending_order_mistake | easy | 3/3 | - | easy |
| gen-retail-tau2-known | exchange_delivered_jacket_to_gift_card_diff | medium | 3/3 | - | easy |
| gen-retail-tau2-known | modify_pending_items_once | medium | 3/3 | - | easy |
| gen-retail-tau2-known | return_and_cancel_across_orders | hard | 3/3 | - | easy |
| gen-shipments | claim_for_late_delivered_shipments | hard | 2/2 (+1 infra) | - | easy |
| gen-shipments | dispatch_heaviest_created_shipment | easy | 3/3 | - | easy |
| gen-shipments | move_postnl_created_to_dpd | medium | 3/3 | - | easy |
| gen-stripe-charges | cancel_mistaken_pending_refund | medium | 3/3 | - | easy |
| gen-stripe-charges | capture_pending_authorization | easy | 3/3 | - | easy |
| gen-stripe-charges | refund_duplicate_charge | medium | 3/3 | - | easy |
| gen-stripe-charges | refund_remaining_balance_for_customer | hard | 3/3 | - | easy |
| gen-stripe-customers | delete_older_duplicate_acme | medium | 3/3 | - | easy |
| gen-stripe-customers | mark_registered_nonprofits_exempt | hard | 3/3 | - | easy |
| gen-stripe-customers | update_northwind_contact | easy | 3/3 | - | easy |
| gen-todo-projects | archive_all_finished_projects | hard | 3/3 | - | easy |
| gen-todo-projects | archive_q3_launch_project | medium | 3/3 | - | easy |
| gen-todo-projects | assign_team_lunch_task | easy | 3/3 | - | easy |
| gen-warehouse-inventory | cancel_unstarted_northgate_pos | medium | 3/3 | 2/2 (+1 infra) | easy |
| gen-warehouse-inventory | cycle_count_adjustment | easy | 3/3 | 3/3 | easy |
| gen-warehouse-inventory | receive_rest_of_harbor_po | medium | 3/3 | 3/3 | easy |
| gen-warehouse-inventory | restock_pick_bins | hard | 1/3 | 0/0 (+3 infra) | flaky-for-haiku |
| helpdesk | assign_newest_acme_ticket | easy | 3/3 | - | easy |
| helpdesk | escalate_breached_enterprise_tickets | hard | 3/3 | - | easy |
| helpdesk | escalate_breached_printer_ticket | medium | 3/3 | - | easy |
| retail-tau2 | cancel_mistaken_order | easy | 3/3 | - | easy |
| retail-tau2 | cancel_one_order_return_from_another | medium | 3/3 | - | easy |
| retail-tau2 | exchange_lamp_with_gift_card | medium | 3/3 | - | easy |
| retail-tau2 | exchange_two_units_of_one_item | medium | 3/3 | - | easy |
| retail-tau2 | modify_three_items_in_one_call | hard | 3/3 | - | easy |
| retail-tau2 | modify_two_items_exact_gift_balance | hard | 3/3 | - | easy |
| retail-tau2 | resize_shoes_and_move_address | hard | 3/3 | - | easy |
| retail-tau2 | return_four_items_to_gift_card | medium | 3/3 | - | easy |
