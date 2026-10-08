# Design (draft for prod/design.md)

A draft for docs-design (YOS-56). docs-design owns `prod/design.md` and starts from this file.

- **Built** means it is on `factory/integration` at `8f6453d`.
- **Planned (unit-key)** means it is not built yet, and names the backlog unit that builds it.
- The reasons behind each choice are in `research/architecture.md`, and the decision rows (A-nn) are in `research/decisions.md`. This page states only what holds.
- The appendix answers the 22-item design review. docs-design must carry each answer into `prod/design.md`.

## 1. The world format

A world is one file, `world.yaml`. It holds `format: 1`, a `meta` block, and eight keyed sections (A-08, A-11). Every section maps a snake_case name to an item, so any change to a world is a `WorldEdit` (`remove`, then `upsert`, then `patch`). Generating a world is `edit(emptyWorld)`, and iterating is `edit(existing)`. One zod schema in `engine/format.ts` defines the format. The TypeScript types, runtime validation, each WorldGen stage's tool schema and the format reference all derive from it. Built.

| Section | Holds | Who writes it (`SECTION_OWNER`) |
|---|---|---|
| `meta` | name, description, `resembles`, `source` (hand or worldgen), rng `seed`, `clock` {start, tick}, `api` {list keys and paging params, error-body template} | plan and input |
| `entities` | `idPrefix`, plus typed `fields` | model stage |
| `routes` | standard operations: list (filters, search, sort, pageSize), get, create, update, delete | model stage |
| `actions` | custom routes: method, path, validated `input`, and a JS `handler` | workflow stage |
| `jobs` | time-driven logic: `every` (such as `15m`) and a JS `run` | workflow stage |
| `tests` | client scripts that call the public API and assert | workflow stage |
| `seed` | one JS generator per entity, run in ref order | seed stage |
| `fixtures` | imported tables, such as CSV rows. Code writes them and seed reads them. | input code |
| `tasks` | `difficulty`, `instruction`, `grader`, `solution`, and `decoys` [{why, script}] | tasks stage |

**Field types** live in one record, `FIELD_TYPES`: string, text, int, number, money, bool, datetime, enum, ref, state. Each entry carries its schema, validator, sort order, query parser, CSV inference, docs and examples (A-23). Every field can be `required`, `nullable`, `unique` and `readonly`. A `ref` names its target entity and an `onDelete` of restrict, cascade or nullify. A `state` field declares its states, its initial state and its allowed transitions as data (A-10). `money` is an integer number of minor units with a fixed currency (A-24). Built.

**Logic is a JS snippet** whenever it must be code (A-09). There are five snippet kinds: handler, job, seed, grader and client. Each kind receives a typed ctx whose docs are rendered from a registry, so the docs cannot drift from what the sandbox gives (A-19).

- Handlers get `db` (where every write is enforced), `params`, `query`, `body`, `now()`, `time` and `fail()`.
- Graders get read-only `db` and `seed` views, plus `changes()`, a diff from seed to end state.
- Client scripts reach state only through `api`, the same path HTTP uses.

Everything the engine must enforce on every write is data, not code: types, refs, unique, readonly and state machines. Built.

## 2. Engine guarantees

Each guarantee names the mechanism that fails when it breaks (the AGENTS.md invariants table).

| Guarantee | Mechanism | Status |
|---|---|---|
| **Check**: a world is validated before it runs, with errors a model can fix | `check()` runs layers in order: schema, references, compile, seed, tests, tasks, lints. The first failing layer stops the run, and each skipped section gets one `layer.blocked` issue. Every issue comes from the `ISSUES` catalog, with path, expected, found and hint, and only `issue()` creates one (A-25). Only `check()` produces a `CheckedWorld`, and only a `CheckedWorld` can be saved or served (A-29). | Built through the `tests` layer. The `tasks` layer is planned (engine-grade-verify-basic, engine-verify-full). The `lints` layer is planned (engine-lints). |
| **Enforce**: no write breaks the data model | `store.ts` validates every write: type, required, null, unique, ref resolution, onDelete, readonly (the API cannot set it; actions, jobs and seed can), and state transitions measured from the value before the transaction | Built |
| **Atomic**: a failed call changes nothing | `transact()` runs a call against an overlay over immutable state. Any throw (enforcement, `ctx.fail`, a runtime error) discards the overlay, and the clock does not move (A-14) | Built |
| **Deterministic**: the same world and task always start from the same state | Time starts at `meta.clock.start` and moves one `tick` per successful call, or by an explicit admin advance (A-16). Snippets run in `node:vm` with a global allowlist and a ctx call quota (A-20, A-21). Engine core compiles without Node types, and a symbol-resolving test bans `Date`, `Math.random` and `globalThis` outside `clock.ts` (A-06). | Built. The per-task replay with a state-hash comparison is planned (engine-verify-full). |
| **Time-driven logic** | `jobs` fire at `start + k*every` in (time, name) order, each in its own transaction, when the clock is advanced (A-17) | Built |
| **Serve** | The world's API is served over HTTP from a fresh copy of the seed. Admin routes (state, reset, log, clock, grade) are on a separate port, so the agent under test cannot use them (A-31). | `Runtime` (call, dump, reset, log, advance) is built. HTTP serving and the admin port are planned (engine-http-cli). |
| **Inspect and reset** | `dump()`, `reset()` and `log()` on the runtime. Each log entry records the time, the route, the request and the response. | Built |
| **Grade** | A grader returns a score in [0, 1] from the end state. A task passes verification only if: the solution scores 1; doing nothing scores 0; every decoy scores below 1 without being trivial; every strict prefix of the solution's successful writes scores below 1; and two runs end with the same state hash (A-27, A-47). | Planned (engine-grade-verify-basic, engine-verify-full) |
| **Fidelity of shapes** | per-world `meta.api` envelopes for lists and errors (A-30, A-49) | Built for `$status`, `$code` and `$message`. Stripe's `type` and `param` need more (see the Stripe oracle). |

**What the engine does not do:** authentication, multi-tenancy, concurrency, persistence across restarts, a security sandbox (`vm` is there for determinism), or a per-task start state (every task starts from seed, A-41).

## 3. The WorldGen loop

One command turns a description, an OpenAPI spec or a CSV into a checked world (A-38). Inputs pass through `redact()` before any model or log sees them. WorldGen's model calls go through the `claude` CLI by default, and the SDK transport is opt-in (A-56).

```
digest input -> plan (plan.yaml, saved, human-readable)
  -> for stage in [model, workflow, seed, tasks]:
       model proposes a WorldEdit limited to the sections the stage owns
       applyEdit (parse only) -> checkWorld (the engine judges) -> judge.ts (engine issues + plan coverage)
       decide(): advance | retry with the issues fed back | backtrack to the issue's owner | stop with a reason
  -> saveWorld(CheckedWorld) and REPORT.md, or stop with world.yaml untouched
```

- **Plan first.** The plan names entities, routes, workflows, tasks and assumptions. Later stages must cover it (`plan.not_covered`). Built (wg-plan-stages-judge).
- **The engine is the only judge.** `judge.ts`, `stages.ts`, `policy.ts` and `report.ts` take no model. An architecture test lets only `run.ts` and `cli/` import the model client (A-35). Built.
- **Self-repair with a stopping rule.** `decide()` is pure and works over one ledger of cost, attempts, backtracks and seen issue sets. It stops on budget, time, `no_progress` (the same issue set seen twice on one step), the attempt limit or the backtrack limit (A-34). Built (wg-policy). The full loop with backtracking is planned (wg-run-slice, wg-repair-full).
- **Knows when to stop.** On any stop, `world.yaml` is not written. REPORT.md states the reason and the last issues, and the exit code is non-zero (A-39). `saveWorld` writes a temporary file and then renames it. Planned in the run loop (wg-repair-full).
- **Iterates.** A change request edits the existing world. `diffWorlds()` lists destructive changes (removed fields, states, transitions, items, idPrefix changes), and the preservation gate blocks each one the plan does not name. Old tests and decoys rerun, and only stages whose sections changed rerun (A-32, A-33). `diffWorlds` is built. `preservationIssues` is planned (wg-preservation-gate), and so is iterate mode (wg-iterate).
- **Observable and configurable.** Every stage, attempt, issue set, duration and cost is a `RunEvent` in `runs/<id>/events.jsonl`. Model and budget come from a strict `worldgen.config.json` (default $5 and 15 minutes, A-48), and CLI flags override them. Built (wg-config-events-llm).
- **Report.** REPORT.md is rendered by code from the plan, the engine verdicts, the world delta and the events. It covers what was built, what was assumed and why, what was left out, and the proof that the checks and graders pass (A-40). Planned (wg-report).
- **Inputs.** Description: planned (wg-input-description). OpenAPI with `--only` narrowing: planned (wg-input-openapi, wg-input-conformance). CSV into `fixtures`: planned (wg-input-csv).

## Appendix: answers to the 22-item design review

The review came from the "WorldGen design doc" session on 2026-10-06. These are proposed answers. docs-design confirms each one as implemented, deferred or rejected.

| # | Item | Proposed answer |
|---|---|---|
| 1 | Gates check consistency, not validity (no blind solve) | **Deferred**, routed to eval-suite as report-only. A blind `claude -p` solve is reported in REPORT, never used as a verdict. |
| 2 | The instruction does not pin the grader | **Deferred**, routed to eval-suite as report-only (convergent-failure flag). The task brief already asks instructions to name selection criteria (wg-stage-briefs). |
| 3 | No prompt coverage | **Implemented in part.** Plan coverage blocks a stage (`plan.not_covered`). The coverage ratio in REPORT is planned (wg-report). |
| 4 | System rules mixed up with agent policy | **Implemented** for system rules: readonly fields plus state machines are enforced on every write, so a PATCH cannot bypass them (A-10). Policy rule ids are **deferred**. |
| 5 | Invariants have no syntax | **Implemented in part:** field rules plus `onDelete` on refs. Row and cross-row invariants are **deferred**. Handlers and tests cover them for now. |
| 6 | Stage 3 can weaken its own tests | **Deferred.** The workflow stage owns both `actions` and `tests` (A-13). Mitigation: verify reruns every test, and decoys come from the tasks stage. Locking tests after their first pass is a candidate for wg-repair-full. |
| 7 | The pipeline runs forward, but dependencies run backward | **Implemented:** backtracking to the stage that owns an issue (A-34). Task-local fixtures are **rejected** (A-41, every task starts from seed). |
| 8 | A shared seed couples tasks | **Implemented in part:** the preservation gate and old-task reverification (A-32). Seed stability under iterate needs per-entity random streams, **planned** in wg-iterate. |
| 9 | The error codes contradict each other | **Rejected as a contradiction.** `ISSUES` is the catalog of check issues. Handler error codes are world data passed to `ctx.fail`. Declaring codes per route is **deferred**. |
| 10 | A required body field is never used | **Planned** (engine-lints) |
| 11 | The collateral guard misfires | **Implemented in the contract:** `changes()` excludes engine timestamps and changes made by jobs (A-28). Hook-derived fields are planned in engine-verify-full. |
| 12 | Grader naming | **Rejected.** `ctx.seed` really is the start state, because there is no per-task setup (A-41), and `now()` is a function everywhere (A-18). |
| 13 | Weak proofs | **Planned** (engine-verify-full): solution-prefix mutants, and replay with a state hash. Drop-one mutants and tick invariance are candidates in that unit. |
| 14 | Determinism hazards in TypeScript | **Implemented:** the symbol ban, the sandbox allowlist, code-unit ordering instead of `localeCompare` in the clock and the store, and the call quota. Replay in a fresh process is **deferred**. |
| 15 | Nothing happens when time passes | **Implemented:** `jobs` on clock advance (A-17) |
| 16 | Stall detection | **Implemented** as `no_progress` (the same issue set twice). A best-so-far measure is **deferred**. |
| 17 | Budget settings versus the stop rule | **Implemented:** a strict config with per-step budgets, and CLI overrides (A-36, A-48). Cost from `claude -p` JSON is **planned** in the claude CLI transport units. |
| 18 | No atomic output | **Implemented differently:** a stop never writes `world.yaml` (A-39), and `saveWorld` is temporary file plus rename. The `.partial/` directory is **rejected** as redundant. The check that it holds on every exit is **planned** (wg-repair-full). |
| 19 | OpenAPI fidelity is unchecked | **Planned** (wg-input-conformance). Known engine gaps for Stripe are listed in `research/stripe-refunds-expected-behaviour.md`. |
| 20 | Seeding CSV through public routes is brittle | **Implemented by design:** CSV rows enter `fixtures`, and seed reads them through privileged writes, not public routes. The loader is **planned** (wg-input-csv). |
| 21 | Unverified citations | Applies to the reviewed doc. `prod/design.md` should cite only sources it checked. This draft cites none outside the repo. |
| 22 | Small doc errors | Applies to the reviewed doc. docs-design checks paths and file lists against the tree (the architecture test checks AGENTS.md paths). |

Still to fold in: `research/world-system-design.md` from the same session, once it lands on integration.
