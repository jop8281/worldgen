# J-fn sweep, 2026-10-09: the Sonnet column of the difficulty matrix, completed

This run finishes what the J175 sweep left open: its Sonnet column ran out of budget on the four hard worlds, so `book_earliest_cardiology_slot`, `record_yesterdays_no_shows`, `clear_dr_patel_calendar_for_leave`, `triage_small_claims`, `cancel_arriving_tomorrow_with_fee` and `restock_pick_bins` were unmeasured or single-trial for Sonnet. Each world ran once more on its own small Boat VM, Sonnet for the four, and warehouse once more on Haiku for the flaky task.

How it ran:

- The engine and the solver code are the hand-in tag, v2.5.0 `aa553a91`, recorded as each run's `engine-commit`.
- Each run is one `bun run dataset` per world, each world on its own small Boat VM. Every teardown was confirmed by the CLI. Boat time was $0.18 across 5 VMs, at the recorded $1.00 per compute-hour rate (A-200).
- Settings: `--max-turns 30`; the Sonnet runs `--budget-usd 3`, the Haiku run `--budget-usd 1`; `--max-minutes 60`. The cost ledger was isolated (`WORLDGEN_COSTS_FILE`), capped at $150 a day, $100 a day for sandboxes and $300 in all, with `TMPDIR` set to an empty directory per run (J188).
- Model spend was $2.58 in all: Sonnet $2.50, Haiku $0.08.

| Run | World | Model | Episodes | Verdicts |
|---|---|---|---|---|
| [fin-c1](fin-c1/) | clinic-appointments | Sonnet | 4 | 2 success, 2 partial |
| [fin-r1](fin-r1/) | rental-fleet | Sonnet | 4 | 3 success, 1 partial |
| [fin-h1](fin-h1/) | hotel-booking | Sonnet | 4 | 3 success, 1 failure |
| [fin-w1](fin-w1/) | warehouse-inventory | Sonnet | 4 | 3 success, 1 partial |
| [fin-w2](fin-w2/) | warehouse-inventory | Haiku | 4 | 4 success |

The tasks this run adds a Sonnet trial for, with the earlier sweep's numbers:

| Task | J175 Sonnet | This run |
|---|---|---|
| book_earliest_cardiology_slot | 4 of 5 | 1 of 1 (score 1) → 5 of 6 |
| record_yesterdays_no_shows | 0 of 1 (partial 0.83) | 0.83 again → 0 of 2, two partials |
| clear_dr_patel_calendar_for_leave | unmeasured (budget) | 0.85 partial → measured, 0 of 1 |
| triage_small_claims | 0 of 1 (turn limit) | score 1 at the turn limit → partial; 0 of 2 by stop, both reached the goal state |
| cancel_arriving_tomorrow_with_fee | 0 of 3 | 0 → 0 of 4 |
| restock_pick_bins | unmeasured for Sonnet | 0.38 partial → measured, 0 of 1 |

Haiku on restock_pick_bins is now 2 of 4 (1 of 3 in J175, plus 1 of 1 here at 28 turns for $0.06).

The difficulty picture does not change: the six hard tasks stay hard for Sonnet (three of them only reach the goal state at the 30-turn cap), and restock_pick_bins remains the one flaky task for Haiku, now with a fourth trial. No verdict changed class.

Each `<run>/` holds the schema-2 export (`dataset.jsonl`, failures included), its `manifest.json` and `REPORT.md`. Private diagnostics stay out of the repository.
