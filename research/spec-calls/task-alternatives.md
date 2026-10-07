# Alternative solutions must score 1

Status: proposal

## Decision row

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Graders must accept other correct paths | Tasks gain an optional `alternatives[]`, client scripts that must each score exactly 1. A hard task with none gets the warning `task.no_alternative`. Amends A-27 | Graders built from one reference trajectory fail correct agents. That is half of the evaluator–human disagreement problem | 2026-10-06 | Yes |

## Choice

- `taskSchema` gains `alternatives: z.array(z.object({ why: z.string().min(10), script: js('client') })).default([])`. `why` says how the path differs, for example "assigns before escalating".
- `verifyTask` runs each alternative from seed, as it runs the solution. A score other than 1 gives `task.alternative_not_full_marks`. A runtime error gives `snippet.runtime_error` at `['tasks', id, 'alternatives', i, 'script']`.
- A hard task with `alternatives: []` gets the warning `task.no_alternative`. Easy and medium tasks get no warning.
- An alternative may end in the same state as the solution. The aim is to prove the grader accepts a different path, not a different end state.
- The WorldGen tasks-stage brief asks for one alternative on each hard task.

## Why

- The report's gauntlet lists "a valid alternative solution scores 1, where one exists" (Report, "Graders must pass a gauntlet before a world counts").
- τ²-bench says its reference actions are "**one** reference trajectory … not the only correct one" (Report, "State, determinism and reset").
- The validity audit traced deterministic-grader failures to "brittle state matching, trajectory lock-in, incorrect ground truths". It found evaluator–human disagreement on 18.5% of tasks ([arXiv 2607.02577](https://arxiv.org/abs/2607.02577); Report).
- AgentRewardBench found rule-based evaluation "tends to underreport the success rate" because it rejects valid trajectories. Anthropic says code graders are "brittle to valid variations" (notes `grading_verification.md` Q1).
- GameLogicBench requires the evaluator to "accept different correct implementations" as well as reject mutants (notes `grading_verification.md` Q3). [engine-mutants.md](engine-mutants.md) covers rejection, and this proposal covers acceptance. evalmut calls the two failure kinds blind spots and brittle spots.
- plan.md V8 (an alternative valid solution must score 1.0) never reached A-27.

## What it replaces or amends

- Amends A-27 with "every alternative scores 1".
- Amends the AGENTS.md invariant row "Graders discriminate" and architecture.md decision 9.
- Red-team contract: adds a row next to G-36.

## Engine changes

- `engine/format.ts`: add the `alternatives` field to `taskSchema`.
- `engine/tasks.ts`: run alternatives in `verifyTask`. `TaskVerdict` gains `alternatives: readonly { why: string; score: 1 }[]`.
- `engine/check.ts`: alternatives count as callers for `stats.unexercisedActions`.
- `engine/issues.ts`
  - `'task.alternative_not_full_marks': def<{ why: string; score: number }>()`, with severity `error` and owner `tasks`.
    - Expected: `every alternative solution scores exactly 1`
    - Hint: `` `Alternative "${why}" scores ${score}. The grader checks the path, not the outcome. Grade the end state.` ``
  - `'task.no_alternative': def<{ difficulty: string }>()`, with severity `warning` and owner `tasks`.
    - Expected: `at least one alternative on hard tasks`
    - Hint: `Add a second correct solution that takes another path, such as a different call order or page size.`
- `worldgen/plan.ts`: tasks get an optional `alternativeIdea`. The `worldgen/stages.ts` tasks brief is updated to match.
- Iterate: A-32 reruns alternatives as regression checks.

## Proving tests

Each test goes in `test/redteam-alternatives.test.ts`. Ids are provisional.

- `G-82 hard task with alternative "assigns before escalating" verifies with alternatives [{ score: 1 }]`
- `G-83 alternative that escalates only page 1 gives task.alternative_not_full_marks`
- `G-84 hard task with no alternatives gives warning task.no_alternative and ok true`
- `G-85 easy and medium tasks with no alternatives give no task.no_alternative`
- `G-86 alternative that throws gives snippet.runtime_error at tasks.<id>.alternatives.0.script`

## Cost

- About 40 lines and 2 codes.
- One script run per alternative.
- One more model-written script per hard task. That is a few cents, and one possible repair round.
