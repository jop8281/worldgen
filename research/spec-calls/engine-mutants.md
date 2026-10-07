# Engine-built mutants replace required decoys

Status: proposal

## Decision row

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Grader discrimination: who writes the wrong solutions | `verifyTask` builds up to 12 mutants from the solution's committed writes. Every mutant that is not equivalent must score below 1. Model-written decoys become optional extras. Amends A-27 | A model that writes both the grader and its decoys is grading itself. Mutation gates catch wrong solutions that would otherwise pass | 2026-10-06 | Yes |

## Choice

`verifyTask` records the solution run's committed writes `W = [w0 .. wn-1]`. These are the 2xx non-GET requests, in order, taken from the call log. It then replays request lists built from `W` through `handle()` from seed. Mutants replay requests, not the script, so they need no model and give the same result every time. A replayed call that fails is just a failed call.

| Kind | Requests | Label example |
|---|---|---|
| `prefix` | `w0 .. wk-1` for k = n-1 down to 1 | `prefix[2/3]` |
| `drop` | `W` without `wi` | `drop[1] PATCH /tickets/tkt_0004` |
| `retarget` | `wi` with its `{id}` path param swapped for a sibling: the first row of the same entity, in id order, that no solution write touches. Skipped if there is none | `retarget[0] tkt_0005->tkt_0001` |
| `perturb` | `wi` with its first discrete body field (enum, state, bool, int, money or ref) set to a different valid value: the next declared value, the negated bool, +1, or the sibling row. Text and string fields are never perturbed | `perturb[0] status=closed` |
| `collateral` | `W`, plus the last write that has an `{id}` param applied once more to the sibling | `collateral PATCH /tickets/tkt_0001` |

- **Equivalence.** A mutant whose end state hash equals the solution's or the noop's is skipped and counted in `mutantsSkipped`. The hash used here leaves out `created_at`, `updated_at` and the clock (see RT-10), so a mutant is not kept just because it ran at a different time.
- **Order and cap.** Candidates are taken round-robin over the kinds in the table order. Within a kind, `prefix` runs longest first and the rest by ascending `i`. Duplicate request lists are dropped (for example, `drop[n-1]` is the same as `prefix[n-1]`). The first 12 mutants that are not equivalent are kept.
- **Gate.** Every kept mutant must score below 1. For each kind, the first mutant that scores 1 gives `task.mutant_full_marks`. Partial credit is allowed.
- **Decoys.** Decoys are still run and scored, and `task.decoy_full_marks` and `task.decoy_trivial` still apply. No difficulty requires them.

## Why

- The research report's gauntlet lists "engine-generated mutants fail (wrong target entity, an extra destructive write, a policy-violating shortcut, a confident no-op)". It adds: "Mutants must come from the engine, not the LLM, because a model writing both the grader and its 'decoys' is grading itself." (Report, "Graders must pass a gauntlet before a world counts".)
- GameLogicBench rejects "implementations with one required capability removed" and reports that "without this validation, incorrect agent submissions passed" ([arXiv 2609.21562](https://arxiv.org/abs/2609.21562); notes `grading_verification.md` Q3). This is `drop` and `prefix`.
- Without such gates, wrong patches pass 25 to 28.5% of the time. A gold-sanity gate flagged 61.9% of LLM-written tests, and an LLM judge missed them ([arXiv 2606.16062](https://arxiv.org/pdf/2606.16062)). Model-written checks need checking by code.
- τ²-bench checks that composite tasks "stay unsolved until every solution step runs" ([arXiv 2506.07982](https://arxiv.org/html/2506.07982)). `prefix` and `drop` generalize this.
- AppWorld's "checking for unexpected changes, i.e., collateral damage" ([arXiv 2407.18901](https://arxiv.org/abs/2407.18901)) motivates `collateral`. The notes' recipe lists "the oracle minus one step, wrong entity, an extra destructive write" (`grading_verification.md` Q3 Inferences).
- The open question in `architecture.md` asks whether a model can satisfy the decoy rules with decoys that are distinct but still easy. Engine mutants remove that question. plan.md D-14 and V3 to V5 asked for the same thing before A-27 relaxed it.

## What it replaces or amends

- Amends A-27. "Model-written decoys … required on medium and hard" becomes "engine mutants required, decoys optional". "Every strict prefix below 1" becomes the `prefix` kind.
- Amends architecture.md decision 9 and the AGENTS.md invariant row "Graders discriminate".
- Retires `task.decoy_required` and `task.prefix_full_marks`.
- Red-team contract: G-33 (`bestPrefixScore`), G-37 and G-38 (`decoy_required`) are rewritten to the new fields and codes.

## Engine changes

- `engine/tasks.ts`
  - Add `export type MutantKind = 'prefix' | 'drop' | 'retarget' | 'perturb' | 'collateral'`.
  - Add a pure `buildMutants(world, seed, writes: readonly ApiRequest[]): readonly Mutant[]`.
  - Add `replayRequests(world, seed, reqs, host)`.
  - `verifyTask` runs mutants after the solution and noop.
- `TaskVerdict`
  - Remove `bestPrefixScore`.
  - Add `mutants: readonly { kind: MutantKind; label: string; score: number }[]`.
  - Add `mutantsSkipped: number`.
- `engine/issues.ts`
  - Add `'task.mutant_full_marks': def<{ kind: MutantKind; label: string }>()`, with severity `error` and owner `tasks`.
  - Expected: `every engine-built mutant of the solution scores below 1`.
  - Hint by kind:
    - prefix and drop: `Mutant ${label} skips a solution write and still scores 1. Grade the effect of that write.`
    - retarget: `… changes a different row and still scores 1. Check which row changed.`
    - perturb: `… writes a different value and still scores 1. Check the value.`
    - collateral: `… also changes an untouched row and still scores 1. Add a ctx.changes() collateral check.`
  - Delete `task.decoy_required` and `task.prefix_full_marks`.
- `engine/format.ts`: the `taskSchema.decoys` describe text becomes "optional wrong solutions that must score below 1".
- `worldgen/stages.ts`: the tasks-stage brief stops demanding decoys. `plan.ts` makes `decoyIdea` optional.

## Proving tests

Each test goes in `test/redteam-mutants.test.ts`. Ids are provisional.

- `G-59 base world verdicts have every mutant below 1 and no task.mutant_full_marks`
- `G-60 hard grader without its changes() gate gives task.mutant_full_marks kind collateral`
- `G-61 hard grader that ignores the PATCH gives task.mutant_full_marks kind drop or prefix`
- `G-62 easy grader that checks "some ticket pending" gives task.mutant_full_marks kind retarget`
- `G-63 mutant count is at most 12 for a 20-write solution`
- `G-64 verify twice gives deep-equal mutant labels and scores`
- `G-65 medium task with no decoys checks ok` (no `task.decoy_required`)
- `G-66 mutant that replays to the solution state is skipped and counted in mutantsSkipped` (`{ todo: 'RT-10' }`)

## Cost

- About 150 lines in `tasks.ts` and 1 issue code.
- Up to 12 request replays per task. These are in-memory `handle()` calls with no script runs, so they add milliseconds.
- One extra repair signal for the tasks stage.
- Risk: a grader that is correct for the instruction but ignores a stored field the mutant perturbs. Perturbing only discrete fields and skipping equivalent mutants limits this. If eval runs show false positives, `perturb` is the first kind to drop.
