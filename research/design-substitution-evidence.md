# Design-substitution evidence (YOS-161)

Four architectural substitutions the WorldGen Design Doc asks for, each with the mechanism that
stands in for it, the decision that scoped it, executed evidence, the remaining gap, and a mark:
**proven**, **explicitly substituted**, or **requiring a narrowly scoped follow-up**. No contract
is marked Met from prose review alone.

- Full SHA for every source and run below: `d75b5a0f597846dc4dafbebd4ecebf268ba44f12` (`git rev-parse HEAD`, branch `dispatch/yos-161-substitution-evidence` off `origin/stabilize/main`).
- The WorldGen Design Doc PDF (2026-10-06, attached to YOS-161) is **not in the repo**. The only
  PDF in the repo is `research/spec.pdf`, the 4-page work-trial spec (decoded: its text is
  `research/spec.md` verbatim; it asks for none of the four contracts). The repo's records of the
  design doc are `archive/design-doc-gap.md` (the claim-by-claim comparison at `b49983b`),
  `design-laws.md` (frozen from the user's review of it), `design-review.md` (the merged design)
  and `plan.md` (the product plan drafted in its era). The "PDF statement" column therefore cites
  the closest repo-recorded statement of each claim; the verbatim page text of p.2, p.3, p.11 and
  p.12 is itself a recorded gap, never paraphrased as a quote.
- Every executed command ran under `nice -n 15`, one at a time (Rule 7; consolidation order). No
  engine source, `world.yaml` or frozen demo was changed. New files: `code/test/substitution-evidence.test.ts`
  and this page; plus one decisions.md row (A-243).

## 1. Route-driven seed history (PDF p.2)

| | |
|---|---|
| PDF statement | Not in the repo verbatim. YOS-161 records the ask as "route-driven seed history (p.2)". The repo's records of the PDF's seed design: `archive/design-doc-gap.md` "Superseded" row 1 quotes its world as "Python, `uv` project, `logic.py`, `seed.py`, `tasks/*.py`, `tests/scenarios.py`" (seed as an authored file beside the logic), and `plan.md:184` records `history: { entity: TicketEvent, parent: ticket_id, kind_field: kind } # used by seed history derivation` with D-11 "v1 seeds use state-conditional generation, per-state invariants and derived history" — history derived from the seeded state, never route replay. |
| Current mechanism at SHA | `seed` is one JS generator snippet per entity, run in ref order (`seedOrder`, `store.ts:112-134`) against one privileged transaction (`seedState`, `store.ts:187-260`; `resolveDeferred`, `store.ts:263-278`). Rows are constructed directly, not through routes: `WriteMode = 'api' \| 'privileged' \| 'seed'` (`store.ts:40`), and only seed may start a row in any declared state (A-146). Cycles with no nullable ref are refused as `seed.cycle`; a nullable ref may defer to a later row and must resolve (A-125). Seeded past-event timestamps are held to the clock and to the state machine's lifecycle order (A-157, A-162). |
| Existing decision | A-146 (seed data is history, so the initial-state rule holds on every write path except seed), A-125 (seed ref cycles and deferral), A-157 and A-162 (seeded history timestamps). No new row: the substitution is already recorded. |
| Executed evidence | `nice -n 15 bun run --silent worldplay check ../prod/worlds/retail-tau2` → `ok`, EXIT=0; `nice -n 15 bun run --silent worldplay check ../prod/worlds/helpdesk` → `ok`, EXIT=0 (the seed layer runs inside `checkWorld`, `check.ts:25`, `check.ts:664`). Both seeds write history the public routes cannot express: retail-tau2's seed creates orders in `delivered`, `cancelled` and `processed` states (`world.yaml` seed section, the `at(...)` rows), and the helpdesk seed creates `open` tickets with assignees — a route or action that created them would be refused `state.initial` (422, A-146). So route-replayed seed history is impossible under the enforced live rules, not merely unimplemented. |
| Remaining gap | The verbatim p.2 statement (the PDF is not in the repo). Nothing else: the direct seed construction is the accepted substitution and is enforced (check refuses a seed the store refuses). |
| **Mark** | **Explicitly substituted.** The engine never promises route-replayed history: seed rows are constructed, and the store's live-behavior rules exempt seed on purpose (A-146). |

## 2. Task-specific setup (PDF p.3)

| | |
|---|---|
| PDF statement | Not in the repo verbatim. YOS-161 records the ask as "task-specific setup (p.3)". The repo's records of it: `plan.md` D-06 "Jumps happen only through admin or task setup" and D-13 "Clock moves belong in `setup`"; `design-review.md:307` "A task may set `start: {advance: 2h}`. The engine applies it after reset and before the agent's first call… This is the only per-task start state" (a proposed review answer, not built); `design-laws.md` L11 names a `TID = hash(WID + instruction + setup + verifier)` (not built: A-121's TID hashes the task definition only). |
| Current mechanism at SHA | One world-level seeded state per world: `runtime(world, host, start?)` (`api.ts:1083-1085`) seeds once and `reset()` returns to that seed with log and journal cleared (`api.ts:1199-1206`). `taskSchema` (`format.ts:82-89`) has no setup field (difficulty, instruction, grader, solution, decoys, alternatives, allows). Every verify run — solution, noop, decoy, alternative, prefix replay and mutant — starts from the same `seed` (`verifyTask`, `tasks.ts:867-1011`). Controlled time exists only on the operator side: `POST /_world/clock` on the admin port (`http.ts:218-232`), which no task can reach. |
| Existing decision | A-41: "Spec: task start state — Every task starts from the seed. No per-task setup yet." Also `architecture.md:153` ("No per-task start state") and the open question at `architecture.md:240`. No new row: A-41 already records the narrower contract. |
| Executed evidence | `test/substitution-evidence.test.ts` R2/R3 against a real `worldplay serve` child (both green, see §5): reset returns the seed dump (`now` `2026-03-02T09:00:00.000Z`) bit-identical after each of two different tasks' reference solutions ran over the world port (each graded 1 at its own end state, then reset → `deepEqual` the seed dump, log cleared to 0 calls); at the reset seed all three tasks, easy to hard, grade 0 (noop) — so no per-task start state distinguishes them. R3: `POST /_world/clock {"advance":"0s"}` is a no-op (A-191); `10m` fires no job (no schedule in the window, state hash unchanged); `5m` more fires exactly `['escalation_timeout','sla_breach']` in (time, name) order; `{"advance":"nope"}` → 400 `clock.invalid` moving nothing; reset erases the job effects back to the seed dump. The evaluator accepts the narrower contract: every `verifyTask` run starts at `seed` and the gates pass on all worlds (`worlds.test.ts` checks and verifies every `prod/worlds/*` world). |
| Remaining gap | Per-task setup stored in the world (e.g. `design-review.md:307`'s `start: {advance: 2h}`) is not built; the operator-side equivalent (admin clock between reset and grade) is demonstrated instead. A task that needs a time offset must get it from the seed's start time or the operator's advance. |
| **Mark** | **Explicitly substituted** (world-level seed start only; controlled time is operator-side). Cited A-41, not re-decided. |

## 3. Reference execution over HTTP (PDF p.11)

| | |
|---|---|
| PDF statement | Not in the repo verbatim. YOS-161 records the ask as "reference execution over HTTP (p.11)". The repo's records of it: `plan.md` D-13 "References use only public routes, with `capture`, `foreach` and `paginate_all`" and D-15 "Verify runs in process over ASGI and resets through the backup API" (the PDF-era plan itself accepted an in-process run over the same app); `design-review.md:398` "S0 + task start → reference x2 through api.call" beside `:40` "AGENT[agent under test] -- HTTP only --> PUB". |
| Current mechanism at SHA | References execute in-process over the same router HTTP serves: `clientCtx(rt)` (`tasks.ts:422-440`) gives a solution, decoy, alternative or mutant only `api`, `assert` and `now`, and `api` goes through `Runtime.call` → `handle()` (`api.ts:772`, dispatched at `api.ts:1142-1149`) — the same `serve()` wraps (`listen(world, createRuntime(world), opts)`, `index.ts:78-84`, `http.ts:320-345`). No socket and no port per verify run; the mutant and prefix gauntlets replay hundreds of runs per task this way (`tasks.ts:542-572`, `tasks.ts:791-818`). |
| Existing decision | None before this page (grep over `decisions.md`: no row records how references execute; the invariant lived only in AGENTS.md/architecture.md). **New row A-243** records the accepted scope. |
| Executed evidence | The literal equivalence control, `code/test/substitution-evidence.test.ts` R1 (green; command and result in §5): the helpdesk `assign_newest_acme_ticket` reference solution runs through both paths — `createRuntime` + `clientCtx` in-process, and a real `worldplay serve` child on a free localhost port with the sync curl client copied from `scripts/replay-http.ts` and the serve harness of `test/cli-world.test.ts`. Pinned literals: the seed dump is `deepEqual` across paths before any call; 4 calls each; statuses `[200, 200, 200, 200]` on both; each call's body `deepEqual`; the state hash equal after each of the 4 calls; engine time equal after each call and literally `['2026-03-02T09:00:01.000Z', '…02…', '…03…', '…04…']` on both (one 1s tick per committed call); each log entry's `jobsFired` `[]` (no job fires inside a task run). A refused write (`PATCH /tickets/tkt_0001` with a valid subject and a bad priority → 422, identical body across paths) leaves both paths' dumps identical before and after, and the two paths' dumps identical to each other, with the clock unmoved. Grading: `gradeDump` on each path's end state (each with its own trace) returns the identical verdict `{ ok: true, score: 1, goals: [], guards: [{ name: 'only assignment fields and its events changed', held: true }] }`; in-process `rt.grade` = 1 and admin `POST /_world/grade/assign_newest_acme_ticket` = `{ task, score: 1, state: <the same hash> }`. |
| Remaining gap | HTTP log entries carry request headers (including the `Host` header with the port) that in-process entries lack (the E16 remaining gap); `traceOf` excludes headers, so grading is unaffected — proven by the identical `gradeDump`. The control pins one task of one world; the full verify gauntlet (decoys, prefixes, mutants) stays in-process by design, which is exactly the scope A-243 records. |
| **Mark** | **Explicitly substituted, equivalence proven by the control** (status/body, state hash, failed-write atomicity and grade verdict are literally equal across the two paths). |

## 4. Benchmark end-state oracle agreement (PDF p.12)

| | |
|---|---|
| PDF statement | Not in the repo verbatim. YOS-161 records the ask as "agreement with the imported benchmark's own end-state check (p.12)". The repo's records of it: `benchmark-reuse.md` ("Grading: each task has one gold action list. The evaluator replays it on a fresh DB, and the agent's run passes when the DB hashes match"; the plan: "Map the 40 test-split gold action lists onto calls against the generated world, run them, and compare the end state with tau's replayed DB… Owner: YOS-51") and `tau2-retail-expected-behaviour.md` §6 ("tau2: replay the gold actions on a fresh environment, hash the agent's DB and the user's DB on both sides, and set `db_reward` to 1.0 only if both hashes match… check that `our_score == 1` exactly when `db_equal`"). |
| Current mechanism at SHA | The licensed tau2 retail subset is `prod/worlds/retail-tau2` (NOTES.md: hand-mapped from sierra-research/tau2-bench at commit `5bfa7e3`, MIT; nothing copied — the seed is hand-written; 8 tasks: 3 original plus 5 mapped from tau2 task ids 105, 36, 82, 31, 21 with invented people, orders and ids; Q1/Q3/Q4/Q5 follow tau2's code, Q2 does not, A-74–A-78). Version/license/projection preserved: `5bfa7e3` + MIT cited in NOTES.md and `meta.resembles`, the tool→route projection is the NOTES.md mapping table plus A-78 (comma-separated item ids as variant ids, integer cents, `#W` order numbers). End-state verdicts come from `verifyTask`'s gates (`tasks.ts:867-1011`): solution 1, noop 0, decoys below 1, strict prefixes below 1, engine mutants. |
| Existing decision | A-54 (tau2 retail as the description case), A-74, A-75, A-76, A-77 (keep tau2's Q1, Q3, Q4, Q5; not Q2), A-78 (id and money projection), A-198 (doing nothing while time passes must score 0, "τ-bench's do-nothing failure"). |
| Executed evidence | `nice -n 15 bun run --silent worldplay verify ../prod/worlds/retail-tau2` → EXIT=0, 8 verdict lines. Literal counts against the oracle's own semantics (`db_reward` 1.0 iff the end DB hash matches the gold replay, else 0.0): **positives** (the reference end states) — engine solution 1.000 on **8 of 8** tasks, where the oracle's gold replay gives 1.0: **8 agreements, 0 disagreements**; **negatives** (noop) — engine 0.000 on **8 of 8**, where the oracle gives 0.0: **8 agreements, 0 disagreements**; **negatives** (decoys, 15 across the 8 tasks) — engine below 1 on **15 of 15** (scores `[0.400]`, `[0.700, 0.000]`, `[0.600, 0.000]`, `[0.250, 0.250]`, `[0.350, 0.550]`, `[0.500, 0.500]`, `[0.650, 0.500]`, `[0.550, 0.350]`; max 0.700), where the oracle gives 0.0: **15 agreements, 0 disagreements** on pass/fail. Total: **31 of 31 pass/fail comparisons agree, 0 disagree**. Best prefix scores: 0.650 (`resize_shoes_and_move_address`), 0.500 (`cancel_one_order_return_from_another`), `-` on the rest. One scope difference, recorded not counted as disagreement: **13 of 15** decoys score fractional partial credit (0.250–0.700) where tau2's DB check is all-or-nothing 0.0 — deliberate per `tau2-retail-expected-behaviour.md` §5 ("Each grader is binary to match tau2's DB check, and partial credit applies only where several writes are needed"). |
| Remaining gap | **The original oracle data is not in the repo.** tau2's own evaluator (`src/tau2/evaluator/evaluator_env.py:118-129`), the gold action lists (`tasks.json`, `split_tasks.json`) and `db.json` at `5bfa7e3` exist only upstream, so the per-task `db_equal` hash comparison was **not executed against the oracle itself**; the counts above compare engine verdicts with the documented oracle semantics (the hand-checked transcription `tau2-retail-expected-behaviour.md` §6, read from the upstream repo at `5bfa7e3`) on the world's own reference/decoy end states. The full gold-replay comparison — the 40 test-split gold lists replayed against a tau2-seeded world, end states compared field by field, pass^k with tau's formula — is YOS-51's plan and stays open. Hand-built resemblance is not claimed as oracle agreement. |
| **Mark** | **Requiring a narrowly scoped follow-up** (YOS-51: import or replay tau2's own oracle data against a tau2-seeded world; until then the agreement is against the documented oracle semantics only). |

## 5. The equivalence control and every executed run

`code/test/substitution-evidence.test.ts` is the new targeted test file (no engine source changed).
R1 is the equivalence control of §3; R2/R3 are the reset and clock demonstrations of §2. The HTTP
side is a real `worldplay serve` child (`node --import tsx src/cli/worldplay.ts serve <dir>
--port 0`, the harness of `test/cli-world.test.ts`, so the same file passes the Bun gate and the
Node gate), driven with the sync curl client of `scripts/replay-http.ts` so the task's own
`solution:` script runs unchanged over the world port, exactly as `scripts/solve-demo.sh` and
`scripts/replay-http.ts` do. The in-process side is `createRuntime` + `clientCtx` — the exact path
`verifyTask` uses. Development history, for honesty: the first run failed 0/3 (a sync curl client
deadlocks against a server in the same process — fixed by serving `worldplay serve` as a child,
which is also the literal reading of the contract); the second run passed 2/3 (the `gradeDump`
literal was pinned to the observed `{ ok: true, score: 1, goals: [], guards: [...] }`); the final
runs below are green.

Executed at `d75b5a0f597846dc4dafbebd4ecebf268ba44f12`, from `code/`, under `nice -n 15`, serial:

| Command | Result |
|---|---|
| `git rev-parse HEAD` | `d75b5a0f597846dc4dafbebd4ecebf268ba44f12` |
| `nice -n 15 bun test --timeout 600000 test/substitution-evidence.test.ts` | **3 pass, 0 fail** (R1, R2, R3; 7.00 s) |
| `nice -n 15 node --import tsx --import ./test/helpers/active-handles.ts --test --test-timeout=600000 test/substitution-evidence.test.ts` | **3 pass, 0 fail** (duration 7297 ms; the Node gate's runner, proving the child spawn works there too) |
| `nice -n 15 bun run typecheck` | clean (`tsc -p tsconfig.json && tsc -p tsconfig.engine-core.json`, no output) |
| `nice -n 15 bun run --silent worldplay check ../prod/worlds/retail-tau2` | `ok`, EXIT=0 |
| `nice -n 15 bun run --silent worldplay check ../prod/worlds/helpdesk` | `ok`, EXIT=0 |
| `nice -n 15 bun run --silent worldplay verify ../prod/worlds/retail-tau2` | 8 verdict lines (quoted in §4), EXIT=0 |

## 6. Marks

| Contract | Mark |
|---|---|
| Route-driven seed history | Explicitly substituted (A-146, A-125, A-157, A-162) |
| Task-specific setup | Explicitly substituted — world-level seed start only (A-41; R2/R3 evidence) |
| Reference execution over HTTP | Explicitly substituted, equivalence proven by the control (new row A-243; R1 evidence) |
| Benchmark end-state oracle agreement | Requiring a narrowly scoped follow-up (YOS-51: tau2's own oracle data; 31/31 pass-fail agreement against the documented semantics, 0 disagreements, hash-level comparison not executed) |
