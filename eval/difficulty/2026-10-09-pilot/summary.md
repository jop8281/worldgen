# Difficulty pilot, 2026-10-09

This is the first measured difficulty run, for v2.0 point 2 (P-YOS-6, J163, A-391). It used `bun run difficulty` at tag v2.0.0 (`5600d0f3`). The full matrix is in [difficulty.md](difficulty.md) and [difficulty.json](difficulty.json).

## Headline

**2 of 6 labeled tiers agree with the measurement.** Sonnet 5.5 passed all 18 episodes: 3 of 3 on each of the 6 tasks. Every task therefore measures easy, so only the two tasks labeled easy agree. The pilot cost **$2.19**, and the probe before it $1.03, for **$3.22** of the $15 cap. The cap was held in an isolated ledger.

| world | task | labeled | measured | passes / trials | 95% interval | calls per episode | cost per episode (USD) |
|---|---|---|---|---|---|---|---|
| helpdesk | assign_newest_acme_ticket | easy | easy | 3 / 3 | 0.439 to 1 | 5, 5, 5 | 0.146, 0.048, 0.061 |
| helpdesk | escalate_breached_printer_ticket | medium | easy | 3 / 3 | 0.439 to 1 | 4, 4, 4 | 0.044, 0.034, 0.033 |
| helpdesk | escalate_breached_enterprise_tickets | hard | easy | 3 / 3 | 0.439 to 1 | 11, 11, 11 | 0.490, 0.455, 0.401 |
| gen-orders-customers | ship_ada_paid_order | easy | easy | 3 / 3 | 0.439 to 1 | 4, 4, 4 | 0.093, 0.028, 0.027 |
| gen-orders-customers | cancel_customer_unpaid_orders | medium | easy | 3 / 3 | 0.439 to 1 | 5, 5, 5 | 0.052, 0.030, 0.039 |
| gen-orders-customers | refund_large_gb_pro_orders | hard | easy | 3 / 3 | 0.439 to 1 | 6, 6, 6 | 0.103, 0.052, 0.050 |

The calls come from the spend ledger, one model call per agent turn. Each episode stopped `done` with an engine score of 1. No call had unknown billing, and the ledger refused nothing.

## What it shows

- **The labels do not predict whether Sonnet 5.5 succeeds.** Every "medium" and "hard" task here is solved every time.
- **The labels partly track effort.** helpdesk's hard task, which pages through enterprise customers and tickets, needs 11 calls and about 12 times the cost of its medium task. gen-orders-customers' hard task needs only 6 calls.
- **No task is hard for this model.** For every task, the Wilson interval for 3 of 3 lies above 1/3, so a true pass rate below 1/3 is ruled out at 95%.

## Honest limits

- **n = 3 per cell is small.** Three of three cannot tell easy from medium: the interval runs from 0.439 to 1. A lower bound of 2/3 or more would take 8 passes out of 8.
- **One model.** The Opus arm comes next under a separate cap. The $1.03 probe ran Opus on helpdesk's hard task with a $1 budget. The engine scored the state 1, but the episode ran out of budget before Opus sent its final reply: 10 requests were sent, and the 11th call hit the claude CLI's `error_max_budget_usd`. It is not in the matrix.
- **6 of the 95 published tasks, in 2 worlds.** The second world was chosen because it has exactly one task at each tier.
- **Repeats vary only through model sampling.** Each episode starts from the same frozen seed. Each also has the same solver prompt (config effort `high`), at most 12 turns, a $0.75 episode budget and a 5-minute limit.
- **The engine score certifies the final world state only.** The final reply is not graded.
- **The cost of episode 1 includes the cold 1-hour prompt-cache writes,** 2 to 3 times what a warm episode of the same task cost.
- **Most of each turn's cost is the solver's prompt shape.** Every call rewrites the whole history into the 1-hour cache, and that dominates the cost of a turn. The master is scheduling this as its own job.

## Rerun

From `code/`, at `5600d0f3`, with an isolated ledger:

```sh
WORLDGEN_COSTS_FILE=<file> WORLDGEN_MAX_TOTAL_USD=15 WORLDGEN_CLAUDE_BIN=~/.local/bin/claude \
  bun run difficulty ../prod/worlds/helpdesk ../prod/worlds/gen-orders-customers --models claude-sonnet-5-5 --episodes 3 \
  --budget-usd 13.96 --episode-budget-usd 0.75 --out ../eval/difficulty/<id> --run-id <id> --engine-commit 5600d0f3b61210f1da2d8600b209c6767130a6c2
```

The episodes' own exports, under `episodes/`, stay local.
