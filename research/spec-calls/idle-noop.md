# Idle noop: doing nothing while time passes scores 0

Status: proposal

## Decision row

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | A second noop that lets engine time pass | `verifyTask` also grades a fresh seed after advancing the clock by the solution's elapsed engine time (committed solution calls × `meta.clock.tick`), with due jobs firing. That score must be 0. Amends A-27 | An agent under test that does nothing still lets time pass, and jobs fire. A grader that time alone satisfies is the τ-bench "do-nothing passes" bug in a new form | 2026-10-06 | Yes |

## Choice

- Let `ticks` be the number of committed calls in the solution run. Let `by` be `ticks × meta.clock.tick`, which is the solution's end `now` minus `meta.clock.start`.
- From a fresh seed, the engine advances by `by` exactly as `Runtime.advance` does. Due jobs fire in (time, name) order, each in its own transaction. Then it grades.
- A score other than 0 gives `task.idle_not_zero`. The issue lists `ticks` and the jobs that fired, in order.
- The idle run makes no API calls, so it is not a replay of the solution. It needs no model.
- The plain noop at `meta.clock.start` stays as it is. If no job fires, the idle state differs from the noop only in `now`, and the run still happens because a grader can read `ctx.now()`.

## Why

- The ABC audit found that a do-nothing agent "passed 38% of τ-bench airline tasks" (Report, "Every grading style fails in a known way"; [Kang/ABC](https://ddkang.substack.com/p/ai-agent-benchmarks-are-broken)). The report's gauntlet says "a no-op scores 0 (this kills the τ-bench 'do-nothing passes' bug)". In this engine an agent's own calls move time (A-16, RT-02), so the realistic do-nothing agent is idle while time passes, not frozen at `start`.
- AppWorld freezes the clock per task for this reason (notes `stateful_tool_benchmarks.md` section 2: "the clock is frozen per task"). This engine does not freeze time, because A-17 jobs need it to move. So the effect of time on the grade has to be measured instead.
- plan.md V10 ("Seed noise: V1 with 20 extra ticks … catches graders sensitive to timers") proposed the matching positive check. It never reached A-27.
- A-28 protects only graders that use `ctx.changes()`. A grader that reads `ctx.db.get('ticket', id).status` after an SLA job has changed it is not protected, and nothing checks that today.

## What it replaces or amends

- Amends A-27, adding "idle noop 0" to the gauntlet.
- Amends the AGENTS.md invariant row "Graders discriminate" and architecture.md decision 9.
- Red-team contract: adds a row next to G-35.

## Engine changes

- `engine/tasks.ts`: after the noop run, `verifyTask` calls `advanceState(world, seed, by, host)`. That shared helper comes from the `Runtime.advance` code path in `api.ts` and `clock.ts`, and `verifyTask` grades the state it returns.
- `TaskVerdict`: add `idle: { readonly score: 0; readonly ticks: number; readonly jobsFired: readonly string[] }`.
- `engine/issues.ts`: add `'task.idle_not_zero': def<{ ticks: number; jobsFired: readonly string[] }>()`, with severity `error` and owner `tasks`.
  - Expected: `doing nothing for ${ticks} ticks scores exactly 0`.
  - Hint: `` `Jobs ${jobsFired.join(', ') || '(none)'} fired and the grader passed without any agent call. Grade what the agent changed, for example with ctx.changes(), or exclude job-made state.` ``
  - Found: the score.
- `world verify` prints the idle score next to the noop.

## Proving tests

Each test goes in `test/redteam-idle.test.ts`. Ids are provisional.

- `G-67 base world verdicts have idle.score 0 for every task`
- `G-68 grader that reads ctx.db for a job-made change gives task.idle_not_zero`. The world has `tick: '1h'` and a job that moves open urgent tickets to pending. The expected `jobsFired` is a literal list.
- `G-69 the same job with a ctx.changes()-based grader gives no task.idle_not_zero` (A-28 consistency)

## Cost

- About 30 lines and 1 issue code.
- One clock advance and one grade per task, at negligible runtime.
- The tasks-stage hint text grows by one line.
