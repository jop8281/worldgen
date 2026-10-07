# Monotone repair: keep the best world so far

Status: proposal. Implement only after the `wg-policy` and `events` work has landed on integration.

## Decision row

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | What a repair attempt may replace | The run keeps a best-so-far world per step. A proposal replaces it only if `progress()` strictly improves, and otherwise it is discarded with an `attempt_discarded` event. Amends A-34 | Self-repair often makes things worse. Reverting regressions is the standard control, and the plan already asked for it | 2026-10-06 | Yes |

## Choice

- `progress(report: CheckReport, coverage: readonly CheckIssue[]): readonly [number, number, number]` returns `[-layerReached, errors, planCoverageMisses]`. Lower is better, compared element by element.
  - `layerReached` is the index of `report.reached` in `CHECK_LAYERS`, or `CHECK_LAYERS.length` when `ok`.
  - `errors` is the count of blocking issues, which are engine issues plus the stage's `done` issues.
  - `planCoverageMisses` is the count of `plan.not_covered`.
- `run.ts` keeps `best = { world, progress }` per step. It is set from the world that enters the step, and it resets on advance and on backtrack.
- If a proposal's tuple is strictly less than `best.progress`, the proposal becomes `best`. Otherwise it is discarded, the world reverts to `best.world`, and `attempt_discarded` is emitted.
- The next prompt shows the best world's issues and the discarded attempt's issues, labelled as such.
- A discarded attempt still counts toward `attempts`, cost and `seenIssueSets`. So `attempts_exhausted` and `no_progress` still end the loop.
- The layer comes first in the tuple, so a fix that unblocks a later layer and exposes more issues there still counts as progress.

## Why

- The report's repair controls say "Revert patches that increase the error count" and "Keep previously passing checks as regression 'anchors,' as AlphaCodium does" (Report, "The repair loop and which feedback signals work"; notes `codegen_worlds_repair.md` Q2).
- In "Is Self-Repair a Silver Bullet?", gains are "often modest" once cost is counted, and models are "held back by their inability to reliably produce accurate and useful feedback" ([arXiv 2306.09896](https://arxiv.org/abs/2306.09896); Report). Under those conditions a regression is likely, and keeping one costs every later attempt.
- GIF-MCTS's Generate/Improve/Fix search is "the principled version" of keeping the best candidate and expanding from it (Report; [arXiv 2405.15383](https://arxiv.org/abs/2405.15383)).
- plan.md's repair design already had "a patch that adds errors is reverted" and "Regression revert … counts as an attempt" (plan.md sections 2 and 6). A-34 kept `no_progress` but dropped the revert.

## What it replaces or amends

- Amends A-34, adding a revert rule to the policy.
- The engine is unchanged. `CHECK_LAYERS` (and the `probe` layer, if that proposal lands) only feed `layerReached`.

## Engine changes

- None in `src/engine/`.
- `worldgen/policy.ts`: add pure `progress()` and `improves(a, b)`.
- `worldgen/run.ts`: hold `best` per step.
- `worldgen/events.ts`: add the `RunEvent` variant `{ t: 'attempt_discarded'; step: StepId; n: number; best: readonly [number, number, number]; proposal: readonly [number, number, number] }`. Every `switch` over `RunEvent` gains a case, and the architecture test enforces `assertNever`.
- `worldgen/report.ts`: count discarded attempts per stage.
- No new issue codes and no `TaskVerdict` fields.

## Proving tests

Ids are provisional. The red-team suite may import only `#engine`, so these go in `test/policy.test.ts` and `test/worldgen.test.ts`, using the scripted fake model. The alternative is widening the red-team import rule to `src/worldgen/policy.ts`.

- `G-87 progress of an ok report beats every failing report`
- `G-88 a proposal that reaches a later layer with more errors is accepted` (`[-5, 9, 0]` beats `[-3, 1, 0]`)
- `G-89 a proposal with an equal tuple is discarded, emits attempt_discarded, and the next attempt starts from the best world`
- `G-90 discarded attempts count toward attempts_exhausted and no_progress`

## Cost

- About 60 lines and one event variant.
- Risk: a sideways move (same tuple, different issues) is never kept. `no_progress` and backtracking already handle plateaus. If eval runs show stalls, relax the rule to "not worse" plus a fingerprint check.
