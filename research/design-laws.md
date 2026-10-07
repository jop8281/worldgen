# Design laws: Proof-Carrying Worlds

Frozen on 2026-10-06 from the user's review of the WorldGen Design Doc. Each law names the mechanism that enforces it today, or the issue that will. When a change would break a law, change the law first and log it in `decisions.md`.

North star: WorldGen is an untrusted compiler frontend. The engine is a small deterministic reference monitor. Tasks are proof-carrying experiments. Runs are replayable scientific artifacts.

## The model

A world is `W = (S, A, T, O, I, C)`: state, actions (API calls), transitions, observations (responses), invariants, clock. Every API call is one atomic transition. If validation fails, the state is unchanged and the call's writes are empty. Every committed state satisfies the invariants.

Determinism: the same world, seed and action sequence give identical responses, writes, clock, IDs, final state hash and grade.

## Laws

| # | Law | Enforced today by | Gap and issue |
|---|---|---|---|
| L1 | Generate semantics, not infrastructure. Every input (description, OpenAPI, CSV, τ-bench, production traces) compiles to one canonical World IR, `world.yaml` | `format.ts` zod schema; WorldGen writes only through `WorldEdit`; `saveWorld(CheckedWorld)` | τ-bench import (YOS-80); trace reconstruction (later) |
| L2 | The engine, not the model, defines truth. The engine alone owns state, transactions, clock, IDs, reset, canonical serialization, hashing, call ledger, grading and the served API | `#engine` boundary, brands on `CheckedWorld`, `CheckIssue` and `TaskVerdict`; `judge.ts` takes no model | `/openapi.json` (YOS-76) |
| L3 | Every transition is atomic and replayable | `transact()` overlay; failed calls leave state, clock and counters unchanged (A-16); replay hash check `task.nondeterministic` | Call log records writes per call, empty on refusal (see below) |
| L4 | Every task proves its own validity. Admit a task only if the reference over the public API scores 1.0, no-op 0.0, plausible near-misses below 1.0, every strict prefix below 1.0, and replay is identical | `verifyTask` (solution, no-op, replay); decoys and prefixes (YOS-37) | Adversarial reward-hacker attempt (later) |
| L5 | Separate world correctness from task correctness. Scenario tests prove the world behaves; task proofs prove the benchmark measures | `tests` check layer vs `tasks` check layer | none |
| L6 | Stage-local ownership: an implementation cannot weaken its own tests | `SECTION_OWNER`; the model stage cannot write `tests`; `edit.out_of_scope` | none |
| L7 | Grade trajectories, not only final state: `V(s0, trace, sT)` with goals, state guards (no collateral) and history guards ("never refund a disputed invoice", "A before B") | Graders see `seed`, end state and `ctx.changes()` | Trace-aware grading (new issue) |
| L8 | Time is explicit. No per-call drift by default, so exploratory agents inhabit the same world. Failed calls consume neither time nor IDs | Failed calls already consume neither (A-16) | Default `tick` becomes `0`, time moves only by explicit advance or declared action durations (new issue) |
| L9 | Generated logic runs behind a capability boundary: `ctx.get/list/insert/update/delete/now/fail` only | `node:vm` with an empty global object plus an allowlist, a call quota, and a snapshot test of the globals | `node:vm` is determinism, not isolation. Roadmap: declarative rules first, then a restricted DSL, Starlark or WASM (new issue) |
| L10 | Graders and gold solutions live on a private authority plane | The agent under test gets only the world port; admin and grade routes are on a separate port (A-31) | Physically separate the verifier from the served world (new issue) |
| L11 | Every reported number comes from immutable evidence. Provenance is content-addressed: `WID = hash(IR + handlers + seed + engine version)`, `TID = hash(WID + instruction + setup + verifier)`, `AID = hash(model + prompt + harness + tools + budgets)`, `RID = hash(WID + TID + AID + run seed)`. A run is a replay capsule of immutable IDs, ledger, terminal state hash, grade, cost and timing | `REPORT.md` renders only engine `TaskVerdict`s; the run log records cost and time | Content-addressed IDs and run capsules (new issue); the dump hash (YOS-78) |
| L12 | One machine-readable source of truth per artifact; human views are rendered from it | `world.yaml` → `world-format.md` and `REPORT.md`; `plan.yaml` → `plan.md` (`worldgen/plan-md.ts`) | Closed 2026-10-07: `plan.md` is rendered from `plan.yaml` and written beside it on every create and iterate exit that writes `plan.yaml` (A-247, YOS-182) |

## Build order

1. Hand-authored helpdesk world.
2. Engine: checker, transactions, determinism, reset.
3. Grading with state and trace guards, plus proof runs.
4. Repeat-run determinism and a broken-world conformance corpus.
5. WorldGen as a six-stage compiler.
6. τ-bench differential import.
7. Production-trace reconstruction.
8. Only then: more domains, curricula, branching, RL.

## Open decisions

World IR versioning. Handler isolation. Clock semantics. Trace-aware grading. Physical verifier separation. Canonical serialization and hash contents. Failed-call time and ID semantics (decided: neither is consumed). Independent verifier generation. Promotion criteria from a candidate world to a verified one.
