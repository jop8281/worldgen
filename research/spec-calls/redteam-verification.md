# Red-team calls: grading and task verification

Status: proposal

These are open questions from `research/redteam-contract.md` about `verifyTask`, `Runtime.grade` and the verdicts. Where a question touches decoys or prefixes, it assumes A-27 as written today. If `engine-mutants.md` is accepted, RT-08 and RT-10 carry over to mutants unchanged.

## Decision rows

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Negative zero (RT-07) | A grader result is compared with `===` and range checks, so `-0` counts as 0 and is in range. | `Math.max(0, x - y)` can give `-0`. Refusing it would be pedantic and would confuse a model. | 2026-10-06 | Yes |
| A-xx | What counts as a write (RT-08, RT-09) | A write is a call that is not a GET and that returns 2xx. A decoy whose writes all fail is `task.decoy_trivial` with reason `no_successful_write`. | Refused calls change nothing (G-08), so such a decoy tests nothing. | 2026-10-06 | Yes |
| A-xx | Comparing end states (RT-10) | `same_as_noop`, `same_as_solution` and `endStateHash` all use one canonical hash. The hash covers every row value except `created_at` and `updated_at`, and leaves out `now`. | A decoy that moves a ticket to pending and back has done nothing to the data. A hash that included timestamps would call it different. `engine-mutants.md` already proposes a hash that ignores timestamps, so this shares it. | 2026-10-06 | Yes |
| A-xx | Difficulty spread (RT-31) | `world.too_few_tasks` is about the count only (fewer than 3). Three or more tasks that do not cover easy, medium and hard give the warning `tasks.difficulty_not_spread`. Change the `expected` text of `world.too_few_tasks` to "at least 3 tasks". | Today one sentence mixes two rules, and that makes one of the codes impossible to reach. The spec asks for "at least three graded tasks at different difficulty levels". The count is a hard rule. The spread is a quality lint. | 2026-10-06 | Yes |
| A-xx | Grader error path (RT-62) | A throwing grader gives `snippet.runtime_error` at `['tasks', <id>, 'grader']`. The same pattern holds for `solution` and for `decoys[i].script`. | A precise path lets the repair loop rewrite only the broken snippet. | 2026-10-06 | Yes |
| A-xx | Unknown task (RT-25, RT-63) | `Runtime.grade` throws `Error('unknown task <id>; known: a, b, c')`. The admin route answers 404 in the envelope. `world grade` exits non-zero and names the known tasks. | It is a deliberate error that a model can act on, never a `TypeError` from looking up a missing task. | 2026-10-06 | Yes |
| A-xx | Log contents (RT-21) | `log()` holds only the world API calls made by the agent or a script. Grades and admin calls are not logged. | The log is evidence of what the agent did, and grading must be read-only (G-32). | 2026-10-06 | Yes |
| A-xx | `CheckReport.tests` (RT-87) | It is the number of entries in the world's `tests` section that ran and passed. | Today the number has no stated meaning. | 2026-10-06 | Yes |

## Unlocks

| RT | Tests that become firm |
|---|---|
| RT-07 | `G-34 GR-range-negzero…`, `G-07 GR-range-negzero…` |
| RT-08 | `G-39 GR-decoy-trivial-failed-writes…`, `G-07 GR-decoy-trivial-failed-writes…` |
| RT-10 | `G-39 GR-decoy-trivial-noop…`, `G-07 GR-decoy-trivial-noop…` |
| RT-31 | `G-07 L04 hard task relabelled medium -> tasks.difficulty_not_spread`. This also removes `tasks.difficulty_not_spread` from `KNOWN_GAPS` in `redteam-gaps.test.ts`. |
| RT-62 | `G-02 a throwing grader's snippet.runtime_error points at tasks.<id>.grader` |
| RT-63, RT-25 | `G-31 grade of an unknown task id throws a deliberate Error…`, `G-58 grade of an unknown task exits non-zero` |
| RT-21 | `G-32 grading leaves the call log unchanged` |
| RT-87 | `G-05 base report counts every world test` |
