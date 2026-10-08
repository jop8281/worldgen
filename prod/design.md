# Design

WorldGen is two tools. The world engine runs and grades worlds. A world is a stateful replica of real software, such as a helpdesk or a payments API. WorldGen is an agent that turns a description, an OpenAPI spec or a CSV into a world the engine accepts. This page covers the world format, what the engine guarantees, and the WorldGen loop.

The reasons behind each choice are in `research/architecture.md`. Each decision has a row (A-nn) in `research/decisions.md`. Where something is not built yet, this page says so.

```sh
cd code && bun install
bun run worldplay check  ../prod/worlds/helpdesk     # issues with path, expected, found and hint
bun run worldplay verify ../prod/worlds/helpdesk     # per task: solution 1, noop 0, decoys below 1
bun run worldplay serve  ../prod/worlds/helpdesk --port 4000   # admin routes on 4001
bun run worldgen "A helpdesk with SLA tiers and on-call escalation" --out ../prod/worlds/gen-helpdesk
```

## 1. The world format

A world is one file, `world.yaml`. It holds `format: 1`, a `meta` block and eight keyed sections (A-08, A-11). Every section maps a snake_case name to an item. So a world changes only through a `WorldEdit`, which removes items, upserts whole items, then merge-patches single items. Generating a world is `edit(emptyWorld)`. Iterating on one is `edit(existing)`. One zod schema in `code/src/engine/format.ts` defines the format. The types, the runtime validation, each WorldGen stage's tool schema and `prod/world-format.md` all derive from it.

| Section | Holds | Written by |
|---|---|---|
| `meta` | name, description, `resembles`, `source`, rng `seed`, `clock` {start, tick}, `api` {list keys, paging params, error body template} | plan and input |
| `entities` | `idPrefix` and typed `fields` | model stage |
| `routes` | standard operations: list (filters, search, sort, page size), get, create, update, delete | model stage |
| `actions` | custom routes: method, path, validated `input` and a JS `handler` | workflow stage |
| `jobs` | time-driven logic: `every` (such as `15m`) and a JS `run` | workflow stage |
| `tests` | client scripts that call the public API and assert | plan step: code writes the approved plan's acceptance tests, and no stage edits them |
| `seed` | one JS generator per entity, run in ref order | seed stage |
| `fixtures` | imported tables, such as CSV rows. Code writes them and seed reads them. | input code |
| `tasks` | `difficulty`, `instruction`, `grader`, `solution`, and `decoys` with a reason each | tasks stage |

**Field types.** One record, `FIELD_TYPES`, holds every type: string, text, int, number, money, bool, datetime, unix_time, enum, ref and state (A-23). Each entry carries its schema, validator, sort order, query parser, CSV inference, docs and examples. Any field can be `required`, `nullable`, `unique` or `readonly`. A `ref` names its target entity and an `onDelete` rule (restrict, cascade or nullify). A `state` field declares its states, its initial state and its allowed transitions as data (A-10). `money` is integer minor units with a fixed currency (A-24).

**Code only where it must be code.** Handlers, jobs, seed generators, graders and client scripts are JS snippets (A-09). Each kind gets a typed `ctx`, and its docs are rendered from a registry, so the docs cannot drift from what the sandbox provides (A-19). Handlers get `db`, where every write is enforced, plus `params`, `query`, `body`, `now()`, `time` and `fail()`. Graders get read-only `db` and `seed` views and `changes()`, a diff from seed to end state. Client scripts reach state only through `api`, the same path HTTP takes. Everything the engine must enforce on every write is data, not code. That covers types, refs, uniqueness, readonly fields and state machines.

## 2. Engine guarantees

Each guarantee names the mechanism that fails when it breaks. `AGENTS.md` lists the same invariants with their tests.

| Guarantee | Mechanism |
|---|---|
| **Check.** A world is validated before it runs, with errors a model can fix. | `checkWorld` runs layers in order: schema, references, compile, seed, tests, tasks, lints. The first failing layer stops, and each skipped section gets one `layer.blocked` issue. Every issue comes from the `ISSUES` catalog with a path, the expected value, the found value and a hint, and only `issue()` creates one (A-25). Only `checkWorld` produces a `CheckedWorld`, and only a `CheckedWorld` can be saved or served (A-29). The `lints` layer is built; its one error is `world.too_few_tasks`. |
| **Enforce.** No write breaks the data model. | `store.ts` checks every write for type, required, null, unique, ref resolution, `onDelete`, readonly, and state transitions measured from the value before the transaction. The public API cannot set readonly fields. Actions, jobs and seed can. |
| **Atomic.** A failed call changes nothing. | `transact()` runs each call against an overlay over immutable state. Any throw discards the overlay, whether it comes from enforcement, `ctx.fail` or a runtime error, and the clock does not move (A-14). |
| **Deterministic.** The same world and task always start from the same state. | Time starts at `meta.clock.start` and moves one `tick` per successful call or by an explicit admin advance (A-16). Snippets run in a `node:vm` context with a global allowlist and a call quota (A-20, A-21). Engine core compiles without Node types, and a symbol-resolving test bans `Date`, `Math.random` and `globalThis` outside `clock.ts` (A-06). Each task's solution runs twice from seed, and the state hashes must match (A-22). |
| **Time passes.** | `jobs` fire at `start + k × every`, in (time, name) order, each in its own transaction, when the clock advances (A-17). |
| **Serve.** | `worldplay serve` answers the world's API over HTTP from a fresh copy of the seed. Admin routes (`/_world/state`, `reset`, `log`, `clock`, `grade/<task>`) live on a separate port, so the agent under test cannot use them (A-31). |
| **Inspect and reset.** | Dump the current state, reset to seed, and read the log of calls. Each log entry records the time, route, request and response. |
| **Grade.** | A grader scores the end state from 0 to 1. A task passes verification only when the solution scores exactly 1 with no 5xx, doing nothing scores 0, every decoy scores below 1 without being trivial, every strict prefix of the solution's successful writes scores below 1, the solution plus one collateral write (a field it did not write on a row it wrote, or the same write on a row it never touched) scores below 1, and the replay matches (A-27, A-47, A-156). Medium and hard tasks need at least one decoy. |
| **Real shapes.** | Per-world `meta.api` sets the list keys, paging params and error body template (A-30, A-49). |

**Out of scope.** Authentication, multi-tenancy, concurrency, persistence across restarts, and a security sandbox (`vm` is there for determinism, not isolation). There is no per-task start state either: every task starts from the seed (A-41).

## 3. The WorldGen loop

One command turns an input into a checked world (A-38). The input passes through `redact()` before any model or log sees it. Every call uses `claude-sonnet-5-5` unless config or `--model` names another priced Claude model, and an unknown or unpriced model is refused before a call (A-283). Calls go through `claude -p` under the logged-in session by default, and the SDK transport is opt-in with `LLM_KEY` (A-56, A-66).

```
digest input
  -> plan.yaml (saved, human-readable; acceptance test scripts are approved here before implementation)
  -> for each stage in [model, workflow, seed, tasks]:
       the model proposes a WorldEdit limited to the sections the stage owns
       applyEdit (parse only) -> checkWorld (the engine judges) -> judge.ts (engine issues + plan coverage)
       decide(): advance | retry with the issues fed back | backtrack to the issue's owner | stop with a reason
  -> saveWorld(CheckedWorld) and REPORT.md, or stop with world.yaml untouched
```

- **The engine is the only judge.** `judge.ts`, `stages.ts`, `policy.ts` and the report take no model. An architecture test lets only the run loop and the CLIs import the model client (A-35).
- **One table drives the stages.** `SECTION_OWNER` gives each section exactly one owning step (A-13). A stage's tool schema allows edits to its own sections only, and an issue's owner picks the step to backtrack to. The approved plan holds every acceptance test's id, intent, description and script before implementation starts, and code writes them into `tests`. Workflow edits own actions and jobs only, and an edit that touches a test backtracks to the plan. A corrected contract needs a higher `revision`, and the plan proposal and `plan.yaml` record it (A-99).
- **Self-repair with a stopping rule.** `decide()` is pure and works over one ledger of cost, attempts, backtracks and seen issue sets. It stops on budget, time, the attempt limit, the backtrack limit, or `no_progress`, which is the same issue set seen twice on one step (A-34).
- **Knows when to stop.** On any stop, `world.yaml` is not written. REPORT.md states the reason and the last issues, and the exit code is non-zero (A-39). `saveWorld` writes a temporary file, then renames it.
- **Iterates.** A change request such as "add refunds" edits the existing world. `diffWorlds()` finds destructive changes: removed fields, states, transitions and items, and changed id prefixes. `preservationIssues()` blocks each one the plan does not name, and old tests and decoys rerun. The change plan's revision must exceed the one in `plan.yaml`, and it may rewrite or drop an existing test only when `changes` names `tests.<id>` (A-99). Only stages whose sections changed rerun (A-32, A-33).
- **Observable and configurable.** Every stage, attempt, issue set, duration and cost is a `RunEvent` in `runs/<runId>/events.jsonl`. Model and budget come from a strict `worldgen.config.json` (default $5 and 15 minutes per world, A-48), and CLI flags override them. Before each call, a preflight refuses it when its estimated cost or duration will not fit in what is left. Each step keeps time for the steps after it, the estimate of each one's next call, and a call's hard timeout is the time left minus those reserves (A-STAGE-TIME, A-311).
- **The report.** Code renders REPORT.md from the plan, the engine verdicts, the world delta and the events. It says what was built, what was assumed and why, what was left out, and that the checks and graders pass (A-40).

**Status on `stabilize/main`.** Built: the plan, the stage table, the judge, the repair policy with retry and backtracking, the preservation gate, config and events, the run loop, the `worldgen` CLI, REPORT.md, the description, OpenAPI and CSV inputs, and iterate mode with `--world` (#205). The first live iterate run is recorded: #264 shipped `prod/worlds/gen-petstore-refunds` from it, as section 5 says.

## 4. Response to the design review

The "WorldGen design doc" session filed a 22-item review on 2026-10-06. Each item is implemented, deferred or rejected here.

| # | Item | Answer |
|---|---|---|
| 1 | The gates check consistency, not validity | **Deferred.** A blind solve by a fresh model is reported by the eval suite, never used as a verdict. |
| 2 | The instruction does not pin the grader | **Deferred.** The eval suite reports convergent failures. Task briefs ask instructions to name their selection criteria. |
| 3 | No prompt coverage | **Implemented in part.** Plan coverage blocks a stage (`plan.not_covered`). The coverage ratio in REPORT.md is not built. |
| 4 | System rules mixed up with agent policy | **Implemented** for system rules. Readonly fields and state machines hold on every write, so a PATCH cannot bypass them. Policy rule ids are deferred. |
| 5 | Invariants have no syntax | **Implemented in part.** Field rules and `onDelete` on refs exist. Row and cross-row invariants are deferred, and handlers and tests cover them for now. |
| 6 | Stage 3 can weaken its own tests | **Implemented** (A-99). The approved plan stores acceptance test scripts before implementation. Workflow edits own only `actions` and `jobs`. An edit that removes or changes a test backtracks to the plan, which must raise `revision` to change it. On iterate, an existing test changes only when the plan's `changes` names it. |
| 7 | The pipeline runs forward, but dependencies run backward | **Implemented** as backtracking to the stage that owns an issue. Task-local fixtures are rejected, because every task starts from seed. |
| 8 | A shared seed couples tasks | **Implemented in part.** The preservation gate and reverification of old tasks exist. Iterate rejects a new seed that loses rows a kept test or task names by id, through `preservationIssues()` in `judge.ts`. |
| 9 | The error codes contradict each other | **Rejected.** `ISSUES` catalogs check issues. Handler error codes are world data passed to `ctx.fail`. |
| 10 | A required body field is never read | **Implemented** as the warning `route.unused_required_input` (#76): a required action input whose name never appears in its handler. It is a warning, so it does not block a world. |
| 11 | The collateral guard misfires | **Implemented.** `changes()` ignores engine timestamps and changes made by jobs (A-28). |
| 12 | Grader naming | **Rejected.** `ctx.seed` really is the start state, because tasks start from seed, and `now()` is a function everywhere (A-18). |
| 13 | Weak proofs | **Implemented.** Solution-prefix mutants, collateral mutants (A-156), non-trivial decoys and replay all run in `verifyTask`. |
| 14 | Determinism hazards in TypeScript | **Implemented.** The symbol ban, the sandbox allowlist, code-unit ordering instead of `localeCompare`, and the call quota. Replay in a fresh process is deferred. |
| 15 | Nothing happens when time passes | **Implemented.** `jobs` fire on clock advance (A-17). |
| 16 | Stall detection | **Implemented** as `no_progress`. A best-so-far measure is deferred. |
| 17 | Budget settings versus the stop rule | **Implemented.** A strict config with per-step budgets and CLI overrides (A-36, A-48). |
| 18 | No atomic output | **Implemented differently.** A stop never writes `world.yaml`, and `saveWorld` writes a temporary file and renames it. A `.partial/` directory is rejected as redundant. |
| 19 | OpenAPI fidelity is unchecked | **Built (A-79).** `engine/openapi-fidelity.ts`, run by WorldGen at the last step and by `worldplay openapi`. The regenerated `gen-petstore` passes it with no errors. |
| 20 | Seeding CSV through public routes is brittle | **Implemented by design.** CSV rows enter `fixtures`, and seed reads them with privileged writes, not public routes. The CSV input loads them. |
| 21 | Unverified citations | **Implemented.** This page cites only files in this repo. |
| 22 | Small doc errors | **Implemented.** Paths and commands here match the tree, and the architecture test checks the paths named in AGENTS.md. |

## 5. Design-doc targets and evidence

The requirement-by-requirement matrix for `research/spec.md` is `research/spec-traceability.md`. On `fc39ef8e`, after #364 and #370, it counts 54 Met, 13 Partial and 0 Open, and a second reviewer reopened each Met row. A-156 then closed G4, so it counts 55 Met and 12 Partial. A second reviewer has not reopened G4 yet. The table below tracks the design-doc targets, not the spec.

Each target from the design doc, with the evidence for its status. The numbers come from the files named, the PRs named, or rerunning the commands on `stabilize/main` at `a1350cb`. The world counts and the per-world table were rerun at `a12b7038`.

| Target | Status | Evidence |
|---|---|---|
| Engine runnable with one command | Met | `bun run worldplay serve ../prod/worlds/helpdesk --port 4000`. `scripts/demo.sh` runs check, verify, serve, both ports, a grade and stop. |
| Bun as runtime and toolchain (U-12) | Partial | Bun 1.4.2 is the package manager, script runner, test runner and runtime. From a fresh worktree, `bun install --frozen-lockfile` takes 149 ms, `bun run worldplay check` prints ok, `bun run worldplay verify` gives every helpdesk task solution 1 and noop 0, and `bun run worldgen --help` exits 0. The full suite under Bun on `stabilize/main` 65bea67 (`nice -n 15 bun test --max-concurrency=2`, load 24 to 27) has 3012 pass, 9 fail, 2 skip and 150 todo of 3173 tests in 81 files. Two failures, the G-00 mutation-table coverage tests, also fail under Node. Three are load: the dataset logger test, gen-shipments and petstore G-45 pass or fail only with machine load when their file runs alone. The L08 mutation row was not rerun. Three failed only under Bun on 65bea67, and none do now. The two `worldgen-iterate` restore-after-IO-failure tests pass on Bun (31/0) since `RunDeps.fs` replaced module mocking (#314). `sandbox-orphans` passes on Bun 4 of 4 runs since #308 counts a spawned process that has used no CPU as unstarted. Known gap: Bun ignores Worker `resourceLimits`, so the snippet heap bound is not enforced under Bun. The heap-bound tests skip on Bun, and the Node CI job (`npm run check:node`) gates them (A-87, YOS-88). |
| Precise check errors with file and line | Met | `worldplay check` prints `world.yaml:55: error schema.invalid entities.ticket.idPrefix: expected ..., found "9bad". <hint>`, and `--json` carries `file` and `line`. |
| Lints layer | Met | `check.ts`. Its one blocking rule is `world.too_few_tasks` (3). The other lints, such as `seed.too_few_rows_for_paging`, are warnings. |
| Enforce, atomic, deterministic, jobs on time | Met | `store.ts` `transact()`, `clock.ts`, the sandbox allowlist and replay. See section 2. |
| Serve with a separate admin port and `/openapi.json` | Met | `engine/http.ts`. Admin binds loopback unless `--admin-host` is set (A-67). |
| Dump with a hash, reset, log, clock, grade | Met | `GET /_world/state` returns `world` and `hash`, plus `POST /_world/reset`, `GET /_world/log`, `POST /_world/clock` and `POST /_world/grade/<task>`. |
| Graders discriminate | Met | `worldplay verify`. Solution 1, noop 0, every decoy, strict prefix and collateral mutant below 1, and identical replay. Medium and hard tasks need decoys. |
| Hand-built helpdesk with SLA tiers and on-call escalation | Met | `prod/worlds/helpdesk/`. Verify: easy, medium and hard tasks at solution 1.000 and noop 0.000. Best decoy 0.700, best prefix 0.857. |
| WorldGen runnable with one command | Met | `bun run worldgen "<prompt>"`. Exit 0 with `world.yaml`, or exit 1 with no world and the reason in REPORT.md (A-39). |
| Description, OpenAPI and CSV inputs | Met | `worldgen/input.ts`. The `run_started` event in each world's `runs/*/events.jsonl` records the input. Of the 23 generated worlds, 11 came from a description, 4 from an OpenAPI spec, 6 from CSV and 2 from an iterate run on an existing world. `gen-linear-backlog` has no `runs/`, so its CSV input comes from its REPORT.md. The table below lists each world. |
| Generated worlds that pass check and verify | Met | `prod/worlds/` holds 23 `gen-*` worlds and 2 hand-built worlds. `worldplay check` and `worldplay verify` exit 0 on all 25. Every task scores solution 1.000 and noop 0.000, and every decoy scores below 1. The highest decoy seen is 0.912 and the highest strict-prefix score is 0.990, both on `gen-clinic-appointments`. The table below lists each world with its input, task count, best decoy and best prefix. |
| Stops within budget and time, with a reason | Met | The cost and time preflight and the per-step time shares. The Opus reference run stopped `time_exhausted` at 16.3 minutes and $4.00, before seed (A-66). That overrun is why calls now carry a hard timeout. A `claude -p` call killed at its step share stops `stage_time_exhausted`, not `model_error` (#217, A-91). A snippet host that is still down when the engine check is rerun once stops `infra_unavailable` (#212, A-92). Every stop writes REPORT.md, and a spend cap stops `budget_exhausted` (#230, A-93). #173 fixed a live-run hang in the snippet host, and `run.ts` now holds a hard run deadline. |
| Observable runs | Met | `runs/<runId>/events.jsonl` (every attempt, cost and duration), `call_refused` events, and REPORT.md per run. `bun run costs` reads the spend ledger. |
| Iterate on an existing world ("add refunds") | Met | #205 built `worldgen "<change>" --world <dir>` in `worldgen/iterate.ts` (A-82 to A-85). The plan names every changed item in `changes`, only the stages it reaches rerun, and `preservationIssues()` in `judge.ts` gates every stage, so `world.yaml` and `plan.yaml` are written only when the whole run is accepted. #264 is the live run: `worldgen "add refunds for orders" --world ../prod/worlds/gen-petstore-refunds` on a copy of `gen-petstore` finished `done` with `worldWritten` true in 5.52 minutes (331 s) and $1.42 (`runs/*/events.jsonl`). REPORT.md `## Changes` lists 18 entries and no removals. The 4 original tasks are unchanged and 3 refund tasks are new. `worldplay check` exits 0 with 2 paging warnings, and `worldplay verify` exits 0 on all 7 tasks with every solution at 1.000 and every noop at 0.000. The artifact is `prod/worlds/gen-petstore-refunds/` and its REPORT.md. #298 is the breadth evidence (`research/iterate-evidence.md`). It ran 20 independent change requests on copies of `gen-todo-projects` at $2 and 10 minutes each. 17 of the 19 valid runs finished with check and verify passing and the 3 base tasks still at 1.0. Every additive change (new entity, action, job, field, constraint or status) succeeded. The 2 renames stopped with `no_progress` and left the world unchanged. Run 10 is invalid because the host slept. Total spend was about $17.3. Stages the change does not reach are skipped with a `step_skipped` event that gives the reason (`run.ts:685`, `stagesToRun(changedSections(plan, world))`). The fake-Model test `worldgen-iterate.test.ts:413` shows an add-one-action change running only plan, workflow and tasks. Runs 11 and 14 in #298 skipped the model stage live. Open: renames, which touch every section at once. |
| OpenAPI fidelity check (review item 19) | Met | #184 built `engine/openapi-fidelity.ts` and `worldplay openapi` (A-79). Missing operations, statuses and required fields, and type or enum mismatches, are errors. Extra operations are warnings. WorldGen rejects a last-step candidate with errors. #250 regenerated `gen-petstore` against the gate in one live run, with 5 attempts, 5.23 minutes and $1.45. `worldplay openapi prod/worlds/gen-petstore --spec eval/inputs/petstore.openapi.yaml` lists 0 errors and 9 extra-operation warnings. |
| Eval set of 12+ prompts and a rehearsed live run | Partial | `eval/suite.yaml` has 14 cases, and `bun run eval --dry-run` validates it. #220 adds a weighted fidelity score for description cases against `eval/fidelity/*.yaml`. The runbook is `research/live-run-runbook.md`. A sealed rehearsal ran 3 unseen prompts with `claude-sonnet-5-5` over `claude -p` (YOS-58). They produced `gen-rental-fleet` (description, #241), `gen-stripe-charges` (OpenAPI, #242) and `gen-shipments` (CSV, #243). All 3 reached done on the first attempt of every stage. Their REPORT.md files sum to 15 attempts, $3.53 and 25.1 minutes of run time, added across the three runs. The first run started at load 225, so its wall time is not representative. Not produced yet: the fourth and fifth prompts (one an iterate request), `eval/rehearsal-prompts.yaml`, and a `summary.md` under `eval/runs/` (YOS-58). |
| τ-bench domain import (optional) | Partial | `prod/worlds/retail-tau2/` is a hand-mapped τ²-bench retail world: 7 entities, 7 actions for the write tools, tau2's guards and its code-versus-policy quirks (A-74 to A-78), a hand-written seed and 8 verified tasks, 5 of them mapped from tau2 tasks 21, 31, 36, 82 and 105. Built by `code/scripts/build-retail-tau2.ts` through `saveWorld`. The 40-task gold replay, pass^k and the WorldGen run on `policy.md` are not built. |
| Every prod world serves from a Boat sandbox | Met | `research/evidence/boat-sweep-2026-10-07.md` is the log of a run by worldgen-27 at 07:40 PDT on 2026-10-07, from `33f158a7`. For each of the 25 worlds it ran `npx tsx src/cli/sandbox.ts up ../prod/worlds/<world> --backend boat --size small --ttl 900`, read `/openapi.json`, sent the first list GET, probed `/_world/state` on the world port, and ran `sandbox.ts down`. All 25 came up and tore down cleanly, and all but `gen-library-loans` logged a 200 on their first list GET. `gen-library-loans` logged a 200 on `/openapi.json` instead. 22 worlds logged a 404 for `/_world/state` on the world port. `gen-orders` got no HTTP response within 20 seconds, and the two retries did not run that probe. `gen-shipments` and `gen-library-loans` failed to come up under 3 parallel lanes and came up when rerun alone. |
| Graded JSONL dataset and Boat sandboxes | Partial | #151 built `src/dataset/` and `bun run dataset`. The solver takes its model from `makeModel` in `cli/models.ts`. `src/boat/client.ts` (A-63) and `src/sandboxes/boat.ts` exist. No dataset file is checked in. The plan is `research/boat-sonnet-dataset-plan.md`. |

These numbers come from `worldplay check` and `worldplay verify` on every directory in `prod/worlds/`, run on `stabilize/main` at `a12b7038`. The input comes from the `run_started` event in `runs/*/events.jsonl`, or from the commit and REPORT.md where a world has no `runs/`. Best decoy is the highest score any decoy reached on any task of that world. Best prefix is the highest score a strict prefix of a solution's writes reached. Both must stay below 1, and `-` means the world has no such attempt. Warnings are lint warnings from `worldplay check`, and no world has a check error. Every task of every world scores solution 1.000 and noop 0.000.

| World | Input | Tasks | Best decoy | Best prefix | Check warnings |
|---|---|---|---|---|---|
| `helpdesk` | hand-built | 3 | 0.700 | 0.857 | none |
| `retail-tau2` | hand-mapped from τ²-bench retail | 8 | 0.700 | 0.650 | none |
| `gen-bakery-vague` | description | 3 | 0.750 | 0.750 | none |
| `gen-billing-dunning` | description | 3 | 0.750 | 0.750 | 1, `seed.too_few_rows_for_paging` |
| `gen-bookmarks` | description | 4 | 0.600 | 0.750 | 3, `seed.too_few_rows_for_paging` |
| `gen-clinic-appointments` | description | 4 | 0.912 | 0.990 | 1, `seed.too_few_rows_for_paging` |
| `gen-course-enrollments` | CSV | 3 | 0.750 | 0.929 | none |
| `gen-helpdesk` | description | 4 | 0.700 | 0.857 | none |
| `gen-hotel-booking` | description | 4 | 0.500 | 0.833 | none |
| `gen-insurance-claims` | description | 4 | 0.800 | 0.800 | 2, `seed.state_mix_skewed`, `seed.too_few_rows_for_paging` |
| `gen-library-loans` | CSV | 3 | 0.833 | 0.917 | 2, `seed.state_mix_skewed` |
| `gen-linear-backlog` | CSV, from REPORT.md (no `runs/`) | 4 | 0.700 | 0.670 | 1, `seed.too_few_rows_for_paging` |
| `gen-orders` | CSV | 4 | 0.500 | 0.667 | 1, `seed.too_few_rows_for_paging` |
| `gen-orders-customers` | CSV | 3 | 0.500 | 0.667 | none |
| `gen-petstore` | OpenAPI | 3 | 0.700 | 0.500 | 1, `seed.too_few_rows_for_paging` |
| `gen-petstore-refunds` | iterate on `gen-petstore`: "add refunds for orders" | 6 | 0.700 | 0.500 | 1, `seed.too_few_rows_for_paging` |
| `gen-refunds` | OpenAPI | 4 | 0.800 | 0.600 | none |
| `gen-rental-fleet` | description | 4 | 0.893 | 0.964 | none |
| `gen-repair-desk` | iterate, a change request | 3 | 0.500 | 0.500 | none |
| `gen-retail-tau2-known` | description | 4 | 0.667 | 0.833 | 1, `seed.state_mix_skewed` |
| `gen-shipments` | CSV | 3 | 0.800 | 0.923 | none |
| `gen-stripe-charges` | OpenAPI | 4 | 0.700 | 0.933 | none |
| `gen-stripe-customers` | OpenAPI | 3 | 0.500 | 0.800 | 1, `seed.state_mix_skewed` |
| `gen-todo-projects` | description | 3 | 0.750 | 0.750 | 2, `seed.too_few_rows_for_paging` |
| `gen-warehouse-inventory` | description | 4 | 0.400 | 0.923 | 1, `seed.too_few_rows_for_paging` |

The 25 worlds hold 95 tasks. To recount, run `worldplay verify` on each directory in `prod/worlds/`.

