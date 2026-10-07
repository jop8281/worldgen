# Spec calls

These are amendment proposals to `research/decisions.md`, backed by the research report (`research-report:research/reports/Agent world engines and WorldGen.md`) and its notes. Each one carries a placeholder row `A-xx`. When a proposal is accepted, its row is appended to `decisions.md` with the next free id, its status here becomes `accepted (A-nn)`, and its test ids join `research/redteam-contract.md`. The test ids G-59 to G-93 are provisional.

## Proposals

| File | Amends | One line |
|---|---|---|
| [engine-mutants.md](engine-mutants.md) | A-27 | The engine builds up to 12 mutants from the solution's writes (prefix, drop, retarget, perturb, collateral), and each must score below 1. Decoys become optional. Adds `task.mutant_full_marks` and retires `task.decoy_required` and `task.prefix_full_marks`. |
| [idle-noop.md](idle-noop.md) | A-27 | A second noop advances the clock by the solution's elapsed time with jobs firing, and must score 0. Adds `task.idle_not_zero`. |
| [probe-and-audit.md](probe-and-audit.md) | check layers, `transact` | A `probe` layer sends 5 deterministic requests per write route or action, and each must answer below 500. `auditState()` rescans the whole state after every committed call. Adds `probe.server_error` and `engine.state_invalid`. |
| [openapi.md](openapi.md) | A-30, A-31 | A pure `openApiOf(world)` is served at `GET /openapi.json` on the world port and by `world openapi`. Adds `route.reserved_path` and an OpenAPI-input round trip (`input.openapi_not_followed`). |
| [task-alternatives.md](task-alternatives.md) | A-27 | Optional `alternatives[]` must each score 1. Adds `task.alternative_not_full_marks`, and the warning `task.no_alternative` on hard tasks. |
| [repair-monotone.md](repair-monotone.md) | A-34 | Keep the best world so far. Accept a proposal only if `[-layerReached, errors, planCoverageMisses]` strictly improves, and emit `attempt_discarded` otherwise. Waits for `wg-policy` and events. |
| [plan-task-touches.md](plan-task-touches.md) | plan schema | Plan tasks declare `touches` and `uses`, which are checked through `plan.not_covered` after the model and workflow stages. This gets the tasks-first benefit without a stage reorder. |

Suggested order: idle-noop and task-alternatives (small and independent), then engine-mutants, probe-and-audit, plan-task-touches, openapi, and last repair-monotone.

## Red-team calls

These files resolve the `{ todo: 'RT-nn' }` ambiguities in `research/redteam-contract.md`. Each row's "Unlocks" table names the tests that become firm once it is accepted.

| File | RT ids | One line |
|---|---|---|
| [redteam-api-semantics.md](redteam-api-semantics.md) | 02, 12, 13, 18, 38, 43, 120–126 | Create only at the initial state. Unchanged state values are not transitions. Missing ids for actions are looked up first. Filters combine with AND. Unknown query keys give 400. Paging is by keyset with URL-safe cursors. There is no sort in v1. Responses carry a JSON content-type. |
| [redteam-clock-jobs.md](redteam-clock-jobs.md) | 20, 22, 23, 24, 27, 90, 115 | Jobs add no tick and see their scheduled time. `0s` is a no-op. A failing job rolls back only itself. Bad durations are refused before any change. |
| [redteam-verification.md](redteam-verification.md) | 07, 08, 09, 10, 21, 25, 31, 62, 63, 87 | `-0` counts as 0. A write is a 2xx call that is not a GET. End states are compared by a hash that ignores timestamps. `too_few_tasks` is about the count only. Paths are precise. An unknown task gives a deliberate error. |
| [redteam-check-report.md](redteam-check-report.md) | 14, 15, 42, 80–85 | Schemas are strict. Unknown row fields are refused. Each layer reports every issue. Seed failures do not cascade. Text is bounded, and issues are not repeated. |
| [redteam-sandbox.md](redteam-sandbox.md) | 35, 86, 110–114 | ctx objects are built inside the context. Each run gets a fresh or frozen context. Nothing runs after a snippet returns. Locale methods are replaced. Runaway snippets have a budget. |
| [redteam-edit-io-cli.md](redteam-edit-io-cli.md) | 29, 32, 91–99 | Edits are strict, and missing targets are issues. Widening a transition is not destructive. Saves are byte-stable. The CLI uses exit 2 for usage errors and prints no stack traces. |

## Rejected

| Idea | Why not |
|---|---|
| SQLite store | A-14 keeps the in-memory overlay, because DDL would be a second copy of the data model. A-45 dropped the SQLite rules with the Python engine. `auditState()` gives the constraint backstop instead. |
| Declarative expression language | Cost, which A-09 puts at about 800 lines of parser and checker. A live unseen prompt can also hit the language's ceiling and stop as blocked. |
| Per-task start state | A-41 stays. Seed snippets can already create rows that are past their SLA (a due time before `meta.clock.start`), so time-dependent tasks need no setup. idle-noop covers time sensitivity. |
| MCP server | It can be derived from `/openapi.json` (one tool per operation) by any adapter, so the engine needs no code for it. |
| pass^k | It needs an agent under test, and the engine has none. Eval can add it later. |
| Full task-first stage reorder | It conflicts with the spec's stage list, in which tasks are stage 5. Use plan-task-touches instead. |
