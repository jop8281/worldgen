# v2.5 workstream B: hard task kinds, measured (J179, A-405)

The pilot (#171) measured every task at 3 of 3 for Sonnet 5.5, the hard ones included. A-405 adds five hard task kinds: time_sensitive, policy_conflict, investigation, misleading_text and irreversible. A create plan's every hard task must name one. This run checks two things: whether WorldGen builds such worlds, and whether their hard tasks are hard. The gate is that every hard task fails Claude Haiku 5.5 at least once in 3 episodes.

## Headline

- **Generation:** 8 of 10 runs ended done, and every finished world passes `worldplay verify`. Of the 2 that stopped, one used Haiku as the generator and one used Sonnet.
- **Generator on Haiku 5.5:** 1 of 2 runs ended done. The pharmacy plan failed the plan schema three times. The library world was built for $0.24.
- **Gate: not met.** Haiku 5.5 passed every generated hard task 3 of 3 at 30 turns: 8 of 8 so far, with clinic's sweep pending. At difficulty's default 12 turns, two looked hard only because of the turn cap.
- **Spend:** $13.37 for the 10 generation runs on the isolated ledger, with no open claim. d3's Haiku sweeps ran on their own ledger and cost about $0.47.

## Generation runs

All runs share one isolated ledger (`WORLDGEN_MAX_TOTAL_USD=40`), use `--budget-usd 3` each, get an empty `TMPDIR` each, and use the claude CLI transport. The code is this branch, with the A-405 prompts and plan rule. Runs went one at a time, then in two lanes after 16:05Z.

| run | generator | outcome | min | $ | attempts | verify |
|---|---|---|---|---|---|---|
| library | Haiku 5.5 | done | 9.0 | 0.24 | 5 | 4 tasks, checks 17/17 flipped |
| pharmacy | Haiku 5.5 | stopped: attempts_exhausted at plan | 5.7 | 0.13 | 3 | none |
| pharmacy-sonnet | Sonnet 5.5 | stopped: budget_exhausted at tasks | 9.4 | 2.89 | 8 | none |
| expenses | Sonnet 5.5 | done | 5.9 | 2.28 | 6 | 3 tasks, checks 15/15 flipped |
| courses | Sonnet 5.5 | done | 7.4 | 1.41 | 5 | 3 tasks, checks 16/16 flipped |
| hotel | Sonnet 5.5 | done | 5.1 | 0.81 | 5 | 3 tasks, checks 11/11 flipped |
| insurance | Sonnet 5.5 | done | 6.2 | 1.03 | 6 | 4 tasks, checks 21/21 flipped |
| cloud-billing | Sonnet 5.5 | done | 8.4 | 1.36 | 5 | 4 tasks, checks 24/24 flipped |
| warehouse | Sonnet 5.5 | done | 6.6 | 1.13 | 6 | 3 tasks, checks 19/20 flipped |
| clinic | Sonnet 5.5 | done, after one tasks→plan backtrack | 9.6 | 2.10 | 11 | 3 tasks, checks 12/13 flipped |

Why Haiku's pharmacy plan stopped: a different schema mistake on each of its three attempts.
1. Free text where `pressure.distractors` names an entity.
2. A rule's `by` naming undeclared actions or jobs.
3. `pressure.states` and `stateMix` values outside the planned states.

Its first attempt also wrote 63k output tokens in 233 s. Sonnet's pharmacy plan was accepted on its second attempt. Its tasks step was then rejected twice, and the run stopped when the next call would not fit the $3 run budget.

Every hard task named a hard kind and at least two distinct workflow actions, so the A-405 rule held in every plan. No hard task chose misleading_text; it appeared only on a medium task (hotel).

## Haiku gate

d3 ran `bun run difficulty --models claude-haiku-5-5 --episodes 3 --max-turns 30` on each world's hard tasks, locally with an isolated ledger. Its outputs (`difficulty.json`, `difficulty.md`) are under `eval/difficulty/2026-10-09-v25-hard/`; the `-t30` directories are the 30-turn reruns. They name each world by its scratch path; `worlds/` here holds byte-identical copies. A pass is score 1, including a score of 1 at the turn limit. The gate is met when a task passes at most 2 of 3.

| world | hard task | kind | Haiku, 12 turns | Haiku, 30 turns | gate |
|---|---|---|---|---|---|
| library | waive_lost_charge_of_returned_title | investigation | 3/3 | 3/3 | not met |
| expenses | finance_clear_over_limit_queue | irreversible | 0/3 (turn cap ×2) | 3/3 | not met |
| courses | cancel_cs120_section_01 | policy_conflict | 1/3 (turn cap ×3) | 3/3 | not met |
| hotel | suite_turnover_today | time_sensitive | 3/3 | 3/3 | not met |
| insurance | review_holder_claims | policy_conflict | not run | 3/3 | not met |
| insurance | find_and_confirm_fraud | investigation | not run | 3/3 | not met |
| cloud-billing | clean_up_long_overdue_enterprise | time_sensitive | not run | 3/3 | not met |
| warehouse | reconcile_zone_counts | policy_conflict | not run | 3/3 | not met |
| clinic | settle_backlog | time_sensitive | not run | pending (d3) | |

**Result: no hard task met the gate.**

| kind | hard tasks that met the gate |
|---|---|
| time_sensitive | 0 of 2, clinic pending |
| policy_conflict | 0 of 3 |
| investigation | 0 of 2 |
| irreversible | 0 of 1 |
| misleading_text | none; no plan gave it to a hard task |

At 30 turns, every one of Haiku's 24 episodes ended done with score 1, for $0.38 in all. Two tasks looked hard at difficulty's default 12 turns, but only because of the cap: Haiku needed 2 to 3 times the turns, and then solved them. This matches J175, where Haiku solved 27 of 31 of the committed hard tasks.

**What it means.** Naming a kind in the plan and telling the tasks step what it means does not make a task hard for Haiku 5.5. The tasks come out longer, not harder to judge. A-405's kinds stay useful as variety, but they are not a difficulty lever.

**Next levers, by evidence:**
1. **Measure difficulty in the loop.** A Haiku sweep costs about $0.03 per hard task. Run it at the tasks step and reject a hard task Haiku passes 3 of 3. That is the only lever this run shows is measurable.
2. **Seed for the kind.** The seed brief keeps seeds small, so an investigation has few pages and few near misses to get wrong. A hard kind could raise rowsPerEntity and the number of near misses.
3. **Option B for time.** Both time_sensitive tasks were 3 of 3. A-405 parked letting time pass through the world port until this condition held, and it now holds.
4. **Report turn budgets.** A task that needs more than 12 turns is hard under a 12-turn budget. A difficulty label should name its turn cap.

## Descriptions

| run | description |
|---|---|
| library | A public library with loans, holds, due dates, overdue fines and lost-item charges |
| pharmacy, pharmacy-sonnet | A pharmacy with prescriptions, refills, controlled substances that need pharmacist approval, and expiring stock |
| expenses | An expense reporting tool with receipts, per-category approval limits, manager sign-off and reimbursements |
| courses | A university course registration system with prerequisites, waitlists, seat caps and add/drop deadlines |
| hotel | A hotel booking desk with rooms, reservations, overbooking rules, late cancellations and no-show fees |
| insurance | An insurance claims desk with policies, claims, fraud flags and adjuster approval limits |
| cloud-billing | A cloud billing console with subscriptions, invoices, account credits, refunds and dunning for failed payments |
| warehouse | A warehouse with inventory, purchase orders, cycle counts and write-offs for damaged goods |
| clinic | A clinic scheduler with doctors, appointments, double-booking rules and no-show fees |

## Reproduce

From `code/`:
- A world: `bun run worldgen "<description>" --out <dir> --budget-usd 3 --model <model>`, with the description below.
- A gate row: `bun run difficulty <world-dir> --task <id> --models claude-haiku-5-5 --episodes 3 --max-turns 30 --budget-usd 2 --out <dir> --run-id <id> --engine-commit <sha>`.

Each run directory holds `events.jsonl`, `capsule.json`, `REPORT.md`, `plan.yaml`, `plan.md` and `verify.txt`. Each finished world's `world.yaml` is in `worlds/`. The attempt dumps are left out.
