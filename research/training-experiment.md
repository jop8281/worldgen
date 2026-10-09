# Does training on WorldGen worlds help? One small experiment

Nobody has shown yet that training on these worlds helps. The engine proves that each task's grader discriminates, but that only means the worlds are well-formed. It is not evidence that a model which practises in them gets better at real tool use. This note designs the smallest experiment that could show it, or show that it does not (A-394). Nothing here has been run.

## The question

Does a small open model, fine-tuned on graded episodes from WorldGen worlds, score higher on an outside tool-use benchmark that no world was built from than the same model without that training?

## Steps

1. **Worlds.** Use the 25 worlds in `prod/worlds/`, which hold 95 tasks. Leave out `retail-tau2` and `gen-retail-tau2-known`, the two worlds built from τ² retail, because the outside benchmark below is τ²-bench. Hold out 5 further worlds as an in-distribution check. That check is not the claim.
2. **Measured difficulty (J155).** Run the teacher on every task first, and keep the tasks it solves sometimes but not always. The committed export shows why: all 38 Sonnet episodes in `eval/dataset/2026-10-07/` scored 1. A set that the teacher always solves teaches a student little about recovering from mistakes.
3. **Episodes, failures included (J152).** Run 8 teacher episodes per kept task with `bun run dataset` on Boat sandboxes. Export the successes and the failed or partial episodes too. J152 ([#161](https://github.com/jop8281/worldgen/pull/161)) added the failures to the export; the committed export in `eval/dataset/2026-10-07/` predates it and keeps only complete successes (see its `MANIFEST.md`).
4. **Train.** Base model: one 7 to 8B open-weight instruct model with native tool calling. Three arms, each run with 3 seeds:
   - **A, base:** no training.
   - **B, successes:** supervised fine-tuning (LoRA) on the successful episodes only.
   - **C, contrast:** B, then one round of preference training (DPO), pairing a success with a failure on the same task.
5. **Score outside.** Run τ²-bench airline and telecom, which no world was built from, in τ²'s own harness. Report pass^1 and pass^4 per arm, and run the held-out worlds as a sanity check.

## Size, compute and budget

These figures are estimates. Step 3 starts with a 20-episode probe, and the spend ledger replaces each estimate with a measured one before the full run.

| Item | Estimate | Basis |
|---|---|---|
| Kept tasks | about 50 of 95 | depends on J155; tasks the teacher always or never solves are dropped |
| Teacher episodes | about 400 (50 × 8) | 8 per task gives a spread of successes and failures |
| Teacher spend | about $110, up to $330 | $10.72 for 38 episodes in the 2026-10-07 export (about $0.28 each, $0.07 to $0.82 per world) |
| Boat sandbox time | unpriced | recorded with `usd: null` unless `BOAT_USD_PER_COMPUTE_HOUR` is set |
| Training | about 6 GPU-hours, about $30 | about 6M tokens; LoRA on one 80 GB GPU; 2 arms × 3 seeds |
| Outside eval | about $100 | τ² airline 50 tasks and telecom tasks × 4 trials × 3 arms × 3 seeds, plus τ²'s simulated-user model calls |
| **Total** | **about $250, under $500** | the run needs the user's budget approval |

## Success criterion

This is fixed before the run:

- **The benefit is shown** if arm B or C beats arm A on τ² airline pass^1 by at least 5 points, and the 95% bootstrap interval over tasks and seeds excludes 0.
- **Arm C must also beat arm B by the same rule** before anyone claims that the failures help.
- **The held-out worlds** must move in the same direction. If they do and τ² does not, that shows fit to WorldGen's style, not a skill that transfers.
- **Any other outcome counts as no benefit shown,** and the README says so.

## What this repo cannot do today

- **No training code and no GPU.** Steps 4 and 5 run outside the repo, and nothing in `code/` trains a model.
- **The solver runs Claude only** (A-66). The student model cannot go through `bun run dataset`, so the outside benchmark scores it in τ²'s own harness, and the held-out worlds need an open-model solver that does not exist yet.
- **Difficulty is measured at n = 3.** J152 and J155 are merged ([#161](https://github.com/jop8281/worldgen/pull/161), [#158](https://github.com/jop8281/worldgen/pull/158)). The pilot ([#171](https://github.com/jop8281/worldgen/pull/171)) ran Sonnet 5.5 three times on 6 tasks and passed all 18. The J175 sweep ([#190](https://github.com/jop8281/worldgen/pull/190), `eval/dataset/2026-10-09-sweep/`) ran Haiku 5.5 three times on all 95 tasks: 89 measure easy, and 6 were missed at least once, one of them flaky (1 of 3). Sonnet ran only on the 4 worlds where Haiku missed, and 2 of those tasks stayed unmeasured for it on the run budget. The sweep is a schema-2 export with failures; the 2026-10-07 export predates it.
- **Using the teacher's outputs as training data** must be checked against the model provider's terms before the run. That is the user's decision.
- **The engine grades the final state only, not the final reply** (the `grading_note`). A success label can therefore reward a correct end state reached with a wrong explanation.
- **The budget above needs the user's approval.** No paid run is part of this note.
- **v2.5 runs none of it** (A-414): no training run and no GPU host, by the user's decision on 2026-10-09. This note stays the design.
