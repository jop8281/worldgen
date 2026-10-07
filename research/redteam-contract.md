# Red-team contract

The red-team suite in `code/test/redteam-*.test.ts` tests the engine against this page. Each guarantee is one testable sentence and cites its source. Each test name starts with its guarantee id, such as `G-08 failed call leaves dump unchanged`.

Sources: `AGENTS.md`, `research/architecture.md` (arch), `research/decisions.md` (A-nn), `research/spec.md` (spec), and the type sketch in `code/src/engine/*.ts`. Where the docs leave a question open, the suite makes the weakest safe assumption listed under Ambiguities, and marks a test that depends on it `{ todo: 'RT-nn' }`.

The suite runs blind. Expected values are literals (see `FACTS` in `code/test/redteam/world.ts`) or compare engine output before and after an operation. No test computes an expected value by calling engine logic.

## Guarantees

### Format and check

| Id | Guarantee | Source |
|---|---|---|
| G-00 | The red-team fixtures (`baseWorld()`, every mutation and bad task) are well formed: the base world parses with `worldSchema` to itself, and only rows meant to fail the schema fail it. | `format.ts` `worldSchema` |
| G-01 | `checkWorld` never throws, whatever the input (null, arrays, strings, deep garbage, frozen objects), and always returns a `CheckReport`. | `check.ts` `check` ("Total: never throws on a bad world") |
| G-02 | Every issue has a code in `ISSUES`, severity equal to `ISSUES[code].severity`, a non-empty path whose head is a section, `meta` or `format` and whose other segments are strings or array indexes, and non-empty `expected`, `found` and `hint`, none of them `[object Object]`. A `span`, when present, is a range inside the string at `path`. | `issues.ts` header, `IssuePath`, `CheckIssue.span` and `issue()`; AGENTS.md invariant "Check errors are precise enough for a model to fix" |
| G-03 | Every entry in `issues` of an `ok: false` report has severity `error`, warnings appear only in `warnings`, and a world with only warnings is `ok: true`. | `check.ts` header ("Warnings (quality lints) never block `ok`") |
| G-04 | Layers run in `CHECK_LAYERS` order, `reached` is the first failing layer, no issue comes from a later layer, and each skipped section gets exactly one `layer.blocked`, whose hint names the failed layer. A section is skipped at least when the layer of the same name (`seed`, `tests`, `tasks`) does not run. Lints never run after a failed layer, so a failed report has no warnings from them. | `check.ts` header; `issues.ts` `layer.blocked` hint |
| G-05 | The base world and every world in `prod/worlds/` check `ok`, with one `TaskVerdict` per task. The base world has no warnings (it meets each lint threshold in the `ISSUES` expected texts), its report's `world` keeps the base world's section keys and meta, and its `stats` match `FACTS` (rows per entity, ticket state counts, no unexercised action). | AGENTS.md "Testing rules"; A-42; `check.ts` `CheckReport` and `WorldStats`; `issues.ts` lint entries |
| G-06 | `checkWorld` is deterministic and does not mutate its input: the same input gives a deep-equal report, and the input is deep-equal before and after (a deep-frozen input works). Inputs that are deep-equal but share subtrees (YAML aliases) check the same, and checking never adds keys to host intrinsics such as `Object.prototype`. | A-20; AGENTS.md module map ("Every other engine file is core and stays pure") |
| G-07 | Each row in `mutations.ts` produces its code with a path that starts with the row's `pathPrefix`, and `reached` equals the row's layer. A warning row gives no other warning. Item names are opaque keys: a world that names an item `constructor` checks like one that uses an ordinary name, and a reference to an undeclared `constructor` is `ref.unknown`. | `issues.ts` `ISSUES`; `check.ts` `CHECK_LAYERS`; `format.ts` `Name` |

### Atomicity and enforcement

| Id | Guarantee | Source |
|---|---|---|
| G-08 | A failed call leaves `dump()` deep-equal to the dump before it, including `now`. | AGENTS.md invariant "A failed call leaves no partial change"; `api.ts` header; `store.ts` `transact` |
| G-09 | A handler that writes and then calls `ctx.fail` returns the fail status with the fail code in the error envelope, and writes nothing. | `ctx.ts` `HANDLER_CTX.fail` ("Nothing is written"); `store.ts` header |
| G-10 | A failed create does not use up an id: the next successful create gets the next counter id. | `store.ts` `State.counters` with G-08; A-15 |
| G-11 | Every write is checked for type, required, unique, ref resolution, readonly and state transition, and a violation is refused with a status in {400, 404, 409, 422}. | `store.ts` header and `EnforceError`; spec "Enforce" |
| G-12 | A plain PATCH cannot make an undeclared transition: open to closed is refused, and open to pending to closed is accepted. Inside one call a transition is measured from the value before the transaction, so a handler that moves open to pending to closed is refused. | A-10; `fields.ts` `state` doc; `store.ts` header |
| G-13 | Standard create and update refuse readonly fields, and actions may set them. | `fields.ts` `common.readonly`; `store.ts` `WriteMode` |
| G-14 | Money accepts only integers at or above `min`. Floats, strings and values below `min` are refused. | `fields.ts` `money`; A-24 |
| G-15 | A ref must resolve on every write, and deleting a row that a `restrict` ref points at is refused with no change. | `fields.ts` `ref`; `store.ts` header |
| G-16 | Error bodies follow `meta.api.error`, with `$code` and `$message` replaced. | `format.ts` `apiShapeSchema`; A-30 |
| G-17 | Row ids are `<idPrefix>_NNNN` per-entity counters from `0001` in seed order, so the base world holds `tkt_0001` to `tkt_0011` and `agt_0001` to `agt_0003`. | A-15; `store.ts` header |

### Determinism and sandbox

| Id | Guarantee | Source |
|---|---|---|
| G-18 | Two runtimes from the same checked world have deep-equal dumps, and the same call sequence gives deep-equal responses, dumps and logs. | spec "Deterministic"; `api.ts` `handle` is pure |
| G-19 | `reset()` restores the seeded dump, sets the clock to `meta.clock.start` and clears the log. Afterwards the runtime behaves like a fresh one. | `api.ts` `Runtime.reset` |
| G-20 | Engine time never comes from the wall clock: a fresh dump's `now` is `meta.clock.start`, and dumps taken at different wall times are equal. | AGENTS.md invariant "Engine core never reads the wall clock"; A-16 |
| G-21 | Snippets see only `SANDBOX_GLOBALS`. `Date`, `process`, `require`, timers and `fetch` are absent, `Math.random` throws, and `Function` or `eval` from strings fails. Each one ends in `snippet.runtime_error`. | `sandbox.ts` header; A-21 |
| G-22 | A snippet that returns a Promise gives `snippet.promise_returned`. | `ctx.ts` header; `issues.ts` |
| G-23 | A runaway snippet that keeps calling ctx gives `snippet.call_quota`, whatever the machine speed. | A-20; `ctx.ts` `SNIPPET_LIMITS` |
| G-24 | State cannot leak between snippet runs unnoticed: a leak is impossible, or verification reports `task.nondeterministic`. | A-22; `tasks.ts` header |

### Clock and jobs

| Id | Guarantee | Source |
|---|---|---|
| G-25 | A committed write advances `now` by exactly `meta.clock.tick`, and a failed call advances it by 0. | A-16; `clock.ts` header |
| G-26 | `advance(d)` moves `now` by exactly `d`. | `api.ts` `Runtime.advance`; `clock.ts` header |
| G-27 | `advance` fires due jobs in (time, name) order and returns them in that order in `jobsFired`. On the base world, `advance('1h')` right after creation fires `a_late, a, a_late, b`. | `clock.ts` `dueJobs`; A-17 |
| G-28 | Jobs fire at `start + k * every` for k ≥ 1, inside (from, to]. Two `advance('30m')` calls give the same jobs and the same state as one `advance('1h')`. | `format.ts` `jobSchema` describe; `clock.ts` `dueJobs` |
| G-29 | Each job runs in its own transaction, so a failing job does not undo jobs that fired before it. | A-17; `clock.ts` header |
| G-30 | `ctx.changes()` leaves out job changes by default, so jobs firing during a run do not change a grade. | A-28; `ctx.ts` `GRADER_CTX.changes` |

### Grading and verification

| Id | Guarantee | Source |
|---|---|---|
| G-31 | `grade(task)` on a fresh runtime is exactly 0 for every task, and exactly 1 after the reference solution's calls. After any other call sequence it is the task grader's value on the current state, which the tests derive by hand. | spec "Grade"; `tasks.ts` header and `grade` ("Score one end state") |
| G-32 | Grading is read-only: the dump is deep-equal before and after `grade`. | `ctx.ts` `GraderCtx.db` ("End state, read-only") |
| G-33 | Every `TaskVerdict` of a checked world has `solution` 1, `noop` 0, every decoy below 1, and `bestPrefixScore` below 1, or null when the solution makes one write. For the base world, decoy scores equal `FACTS.scores`, matched by `why`. `endStateHash` is a hash of the solution's end state: the same on every check of the same world, and different for end states whose row values differ. | `tasks.ts` `TaskVerdict` and header ("the same state hash") |
| G-34 | A grader result that is not a number in [0, 1] (NaN, a boolean, a string, undefined, null, above 1, below 0, Infinity, an object) on the noop or solution state gives `task.grader_out_of_range`. | `issues.ts`; `ctx.ts` `RETURNS.grader` |
| G-35 | A noop score other than 0 gives `task.noop_not_zero`. | `issues.ts`; A-27 |
| G-36 | A solution score other than 1 gives `task.solution_not_full_marks`. | `issues.ts`; A-27 |
| G-37 | A strict prefix of the solution's successful writes that scores 1 gives `task.prefix_full_marks`. | A-27; arch decision 9 |
| G-38 | A decoy that scores 1 gives `task.decoy_full_marks`. A medium or hard task with no decoys gives `task.decoy_required`. An easy task with no decoys is fine. | A-27; `format.ts` `taskSchema.decoys` |
| G-39 | A decoy with no successful write, or one that ends in the noop or solution state, gives `task.decoy_trivial` with that reason. | `issues.ts`; arch decision 9 |
| G-40 | A world with fewer than 3 tasks gives `world.too_few_tasks`. | `issues.ts` |

### HTTP and admin

| Id | Guarantee | Source |
|---|---|---|
| G-41 | `world serve <dir> --port P` serves the world API on P from a fresh seed, and the admin routes on P+1. | AGENTS.md "Commands"; A-31 |
| G-42 | The world port never serves `/_world/*`. Such requests get 404 or 405 and change nothing. | A-31; arch "Grafted from research/plan.md" |
| G-43 | On the admin port, `GET /_world/state` equals the dump, `POST /_world/reset` resets, `GET /_world/log` lists calls, `POST /_world/clock {"advance":"4h"}` advances time and fires jobs, and `POST /_world/grade/<task>` returns the score. | AGENTS.md "Commands" |
| G-44 | HTTP and the in-process `Runtime` agree: the same calls give the same statuses, bodies and final state. | `api.ts` header ("Runtime, client scripts and http.ts all go through it") |
| G-45 | Malformed requests (bad JSON, unknown route, oversized body) get a 4xx, change nothing and do not crash the server. | spec "Enforce"; weakest-assumption robustness, see RT-03 and RT-04 |

### Paging and list

| Id | Guarantee | Source |
|---|---|---|
| G-46 | A list returns `{ <dataKey>: [...], <cursorKey>: ... }` with the `meta.api.list` keys, and its default page size is the route's `pageSize`. | A-30; `format.ts` `routeSchema` and `apiShapeSchema` |
| G-47 | Following `next_cursor` from the first page visits every row exactly once, in id order, and ends with a null or missing cursor. For the base world that gives the pages in `FACTS.ticketPages`. | A-15 ("lists ordered by id"); `store.ts` header |
| G-48 | A filter on a declared filter field returns exactly the matching rows across all pages. | `format.ts` list `filters`; `fields.ts` `parseQuery` |
| G-49 | List and get calls never change state, apart from the tick question in RT-02. | spec "Enforce"; `api.ts` header |

### Edit, diff and save

| Id | Guarantee | Source |
|---|---|---|
| G-50 | `applyEdit` does not mutate its input world, its input edit or any global such as `Object.prototype`, and the same edit gives the same result. Generation is `applyEdit(emptyWorld(...))`. | `index.ts` `applyEdit`; A-11; AGENTS.md module map ("Every other engine file is core and stays pure") |
| G-51 | `applyEdit` applies remove, then upsert, then patch, and patch is an RFC 7386 merge patch in which null deletes a key. | `format.ts` `worldEditSchema` doc and `mergePatch` |
| G-52 | `applyEdit` never judges semantics: an edit that breaks a reference still applies with `ok: true`. An edit that `worldEditSchema` rejects (not an object, no note, a bad item, a non-snake_case key) gives `ok: false` with catalog issues, and never throws. Unknown keys and sections are RT-91. | `index.ts` `applyEdit` ("Parses an untrusted edit", "It never judges semantics"); `format.ts` `worldEditSchema`; `issues.ts` `IssuePath` |
| G-53 | `diffWorlds(w, w)` has no changes. Removing an item, field or state, or changing transitions or an idPrefix, gives the matching `ChangeKind` in `DESTRUCTIVE`. Additions give `item_added` or `field_added`, which are not destructive. | `diff.ts` |
| G-54 | `saveWorld` followed by `loadWorld` gives a world that checks `ok` and deep-equals the checked world, with byte-identical snippets. | `index.ts`; A-08 |
| G-55 | `loadWorld` returns the parsed YAML of `<dir>/world.yaml`, unchecked. On a missing dir or bad YAML it returns `ok: false` with issues, and does not throw. | `index.ts` `loadWorld` ("Returns parsed YAML, unchecked") and its `Result` type |

### CLI

| Id | Guarantee | Source |
|---|---|---|
| G-56 | `npm run worldplay -- check <dir>` exits 0 on an ok world, and exits non-zero on a broken one, printing each issue's code, path, expected, found and hint. | AGENTS.md "Commands" |
| G-57 | `npm run worldplay -- verify <dir>` exits 0 and prints solution 1, noop 0 and decoys below 1 for each task, and exits non-zero when a task fails. | AGENTS.md "Commands" |
| G-58 | `npm run worldplay -- grade <dir> <task> --state end.json` prints the score of a dumped state. | AGENTS.md "Commands" |

## Ambiguities

Each entry gives the open question and the weakest safe assumption the tests make. A test that needs more than that assumption is marked `{ todo: 'RT-nn' }`.

> **Decided 2026-10-07 (A-211, YOS-166).** Every row below that read *todo* for RT-07, RT-08, RT-10, RT-12, RT-15, RT-18, RT-20, RT-21, RT-24, RT-25, RT-27, RT-31, RT-42, RT-43, RT-62, RT-63, RT-80, RT-81 to RT-88, RT-90, RT-91, RT-93 to RT-99, RT-110, RT-112 to RT-115, RT-123, RT-124 and RT-126 is decided as its test asserts, and the test is firm on Node and Bun. RT-14, RT-22, RT-35, RT-89 and RT-111 were decided in A-191 to A-195. Still todo: RT-38, RT-65, RT-66, RT-67, RT-92, RT-121, RT-122 and RT-125.

| Id | Question | Weakest safe assumption |
|---|---|---|
| RT-01 | Is a failed call recorded in `log()`? | No assertion either way. Successful calls appear in order, and `seq` strictly increases. |
| RT-02 | Does a GET advance the clock by a tick? A-16 says "per committed call", and plan.md D-06 says reads do not. | A GET advances `now` by 0 or by one tick. Exact tick tests use writes only. |
| RT-03 | Unknown path, or known path with the wrong method: 404 or 405? | Status in {404, 405}, the state is unchanged, and the body is JSON. |
| RT-04 | Is there a body size limit, and what status does it give? | A 2 MB body gets a 4xx or is processed normally. The server stays up, and state is unchanged on a 4xx. |
| RT-05 | `limit` above `pageSize` or above 200: clamp or 400? | Either a 400, or a page of at most 200 rows. Never a 5xx. |
| RT-06 | `limit` of 0, below 0 or not an integer, or a garbage cursor? | A 4xx, or a valid page. Never a 5xx, and never a state change. |
| RT-07 | Can a grader return `-0`? | Treated as 0, with no `task.grader_out_of_range`. Marked todo. |
| RT-08 | How do decoys and prefixes treat GETs and failed writes? | Only successful non-GET calls count as writes. A decoy whose writes all fail counts as `no_successful_write` (todo). |
| RT-09 | What counts as a write: any 2xx non-GET call, or only a call that changed state? | Any 2xx non-GET. No test separates the two. |
| RT-10 | How are `same_as_noop` and `same_as_solution` compared: the full state hash (including `updated_at` and the clock), or row values? | Only the exact copy of the solution is asserted without todo. A write that is then reverted is todo. |
| RT-11 | Does `unique` allow several nulls? | Not asserted. |
| RT-12 | Can API create set a state field to a non-initial state? | Not asserted without todo. Creating with the initial state is accepted. |
| RT-13 | Does a create that omits a state field get `initial`, and do omitted fields with a `default` get it? | Todo. Tests always send required fields. |
| RT-14 | Are unknown keys in world.yaml an error? zod strips them by default. | Not asserted. |
| RT-15 | Are unknown fields in a create or update body, or in a seed row, refused or ignored? | Never a 5xx. On a 2xx, the unknown field is not stored. The seed row case is todo. |
| RT-16 | Which status does each violation give: 400, 409 or 422? | Status in {400, 409, 422} for type, required, unique, transition and readonly. Exact codes are todo. |
| RT-17 | Get, update or delete of a missing id? | 404 in the error envelope, with state unchanged. |
| RT-18 | Is the cursor URL-safe? Client snippets have no `encodeURIComponent`. | Fixture snippets pass the cursor unencoded. HTTP tests encode it. |
| RT-19 | On the last page, is `next_cursor` null or absent? | `== null`. |
| RT-20 | What does the admin clock return for a bad body (`{"advance":"soon"}`)? | A 4xx, with time unchanged. |
| RT-21 | Do admin calls or grades appear in the log? | Not asserted. |
| RT-22 | Does `advance('0s')` fire anything? | Nothing fires, and `now` is unchanged. Todo, since `0s` may be refused. |
| RT-23 | Are job times multiples of `every` counted from `meta.clock.start` or from the epoch? | The fixture's start is on the hour, so both agree. Tests advance straight after create or reset. |
| RT-24 | Does a job's transaction add a tick? Is `ctx.now()` inside a job its scheduled time? | `now` after `advance(d)` is start plus d (todo). A job's `at` equals its scheduled time (todo). |
| RT-25 | `grade` of an unknown task? | Throws, or HTTP 404. Never returns a number. |
| RT-26 | Does `Runtime.call` parse a query string in `path`, or only the `query` object? | In-process tests use the `query` object and a bare path. |
| RT-27 | What happens when a job throws? | Earlier jobs' writes stay. Whether `advance` throws is not asserted. |
| RT-28 | Is `$status` substituted as a number or a string? | The fixture's template does not use `$status`. |
| RT-29 | Which non-zero CLI exit code? | Any non-zero. |
| RT-30 | Is PUT accepted on a route declared as PATCH? | Not asserted. Status in {404, 405} is accepted. |
| RT-31 | Three tasks without a hard one: `world.too_few_tasks` (an error) or `tasks.difficulty_not_spread` (a warning)? | Either code satisfies the row. |
| RT-32 | Do warnings change the `world check` exit code? | Exit 0. Warnings may be printed. |
| RT-33 | Does an entity with no seed entry get zero rows? | The fixture gives `job_run` an explicit `(ctx) => []`. |
| RT-34 | Can API create or update set `id`, `created_at` or `updated_at`? | Refused or ignored, never honored. |
| RT-35 | One vm context is shared across runs (`createVmHost`). Can a snippet keep state on `Array.prototype`? | Intrinsics are frozen (`snippet.runtime_error`), each run gets a fresh context (no difference), or `task.nondeterministic` is reported. Todo. |
| RT-36 | Trailing slash and letter case in paths? | Not asserted. |
| RT-37 | Does DELETE return 200 or 204? | A 2xx. Body not asserted. |
| RT-38 | What is the syntax of the sort query parameter? | Not specified. Only the default id order is asserted. |
| RT-39 | Does a filter value of the wrong type (`?on_call=maybe`) give 400 or an empty page? | A 4xx or an empty page. Never a 5xx. |
| RT-40 | Does create return 201 or 200? | A 2xx whose body has the new `id`. |
| RT-41 | Are concurrent HTTP requests serialized? | The final state equals the state after some serial order of the same calls. Only order-independent sets are asserted. |
| RT-42 | Which code does a seed snippet that returns a non-array give? | Any of `snippet.runtime_error`, `constraint.violation` or `schema.invalid`. |
| RT-43 | For an action whose path has `{id}`, does the engine look the row up before the handler runs, or does the handler see the missing id? | A 404 in the error envelope, with state unchanged. That the body is the handler's own `ctx.fail` body is todo. |
| RT-46 | Which status does a handler that throws, or that runs out of ctx calls, give? `ctx.fail` names only 400, 404, 409 and 422. | Any 4xx or 5xx in the error envelope, with state unchanged. |
| RT-47 | Does `seq` in `log()` restart after `reset()`? | Not asserted. Reset comparisons drop `seq` and compare the rest of each record in order. |
| RT-60 | A decoy that is a copy of the solution both scores 1 and is trivial. Does verification report `task.decoy_trivial`, `task.decoy_full_marks`, or both? | Either code satisfies the row. The reason `same_as_solution` is checked only when `task.decoy_trivial` is reported. |
| RT-61 | A grader that returns an exotic value (Symbol, boxed number, frozen array, an object whose `toString` and `toJSON` throw) may fail while its result leaves the sandbox. `task.grader_out_of_range` or `snippet.runtime_error`? | Either code, and `checkWorld` does not throw. BigInt and -Infinity are plain non-numbers or below 0, so they give `task.grader_out_of_range` (G-34). |
| RT-62 | Does the `snippet.runtime_error` of a throwing grader point at `['tasks', <id>, 'grader']`, or only at the task? | The path starts with `['tasks', <id>]`. The `grader` segment is todo. |
| RT-63 | What does `Runtime.grade` throw for an unknown task id? | Anything (RT-25). A deliberate `Error` with a message, not a `TypeError`, `RangeError`, `ReferenceError` or `SyntaxError` from a prototype lookup, is todo. |
| RT-64 | What body does `POST /_world/grade/<task>` return? | A bare number, or an object with a `score` number. |
| RT-65 | Will the engine build mutants of the solution (spec call `engine-mutants.md`)? | Partly decided by A-156: verifyTask builds the two collateral mutants (`task.mutant_full_marks`, rows in G-60), and the collateral mutant test is firm. The retarget and perturb mutant tests stay todo and accept today's codes too. |
| RT-66 | Will the engine run an idle noop that only advances the clock (spec call `idle-noop.md`)? | Not decided. The idle-noop test is todo. |
| RT-67 | Will tasks get `alternatives[]` that must each score 1 (spec call `task-alternatives.md`)? | Not decided. The alternatives test is todo. |
| RT-68 | Can verification report a code whose rule the world does not break, or an issue on a task other than the broken one? | No. Where a task breaks one rule by hand derivation, the tests accept only that rule's codes on that task, plus `layer.blocked`. Where one bad value breaks two rules (a bad noop value is also not 0, a bad solution value is also not 1, a copy of the solution also scores 1), both codes are accepted. |
| RT-80 | Does a failed layer report every issue it finds, or may it stop at the first? | Not asserted. One issue per row is enough. That every references issue, and one schema issue per broken section, is reported is todo. |
| RT-81 | When the seed of one entity fails, do entities seeded from it (by ref order) get their own issues, or only `layer.blocked`? | Not asserted. That the ticket seed gets no issue but `layer.blocked` after a failed agent seed is todo. |
| RT-82 | Is issue text bounded when the input holds a huge string? | Not asserted. That `expected`, `found` and `hint` stay at most 4096 characters for a 5 MB input is todo. |
| RT-83 | Are two routes with the same method and a path that differs only in param names (`/tickets/{id}` and `/tickets/{ticket_id}`) a `route.duplicate_path`? | Not asserted. Todo. |
| RT-84 | Can a report list the same issue (code, path, expected, found and hint) twice? | Not asserted. That no report does is todo. |
| RT-85 | A tasks failure skips only lints, which own no section. Does it add `layer.blocked`? | Not asserted. That it adds none is todo. Warnings are still absent (G-04). |
| RT-86 | A snippet can walk the prototype chain of a ctx object. Can it add keys to host intrinsics such as `Object.prototype`? The docs say `vm` is no security boundary. | Not asserted. That it cannot is todo. Reaching host `Function` from a string is G-21. |
| RT-87 | What does `CheckReport.tests` count? | A non-negative integer. That it equals the number of world tests is todo. |
| RT-88 | `meta.api.error` is `z.json()`, which accepts a cyclic value (a YAML alias loop). Is such a world refused with `schema.invalid` under `meta`, or accepted? `format.ts` types the field as JSON, and a cycle is not JSON, but no doc says the engine checks for it. | Not asserted beyond G-01 and G-02 (never throws, sound report). That it gives `schema.invalid` under `meta` is todo. |
| RT-89 | Input nested deeper than the parser's stack (100k levels) makes zod overflow. The engine then reports one `schema.invalid` at `['format']`, with found `unknown` and expected "Maximum call stack size exceeded". Must it refuse at the deep value instead (`['fixtures', ...]` for a fixture cell), or check a valid deep JSON value (`meta.api.error`) like a shallow one? | Never throws, and the report is sound (G-01, G-02). A non-scalar fixture cell is refused at the schema layer at any depth. That the refusal sits under the deep value, and that a deep `meta.api.error` checks like a shallow one or is refused under `meta`, is todo. |
| RT-90 | What does `Runtime.advance` do with a value that is not a `Duration` (negative, fractional, unknown unit, spaced, non-string)? It is typed `Duration`, so such a call is outside the contract. | Not asserted. That it fires nothing and leaves the dump unchanged is todo. The admin clock over HTTP is RT-20. |
| RT-91 | `worldEditSchema` is a plain `z.object`, which strips unknown keys. Are unknown top-level keys of an edit, and unknown sections inside `upsert`, `patch` or `remove`, refused or silently dropped? | Not asserted. That they give `ok: false` with catalog issues is todo. |
| RT-92 | Is removing a key that does not exist an issue, or a no-op? | Not asserted. That it is an issue naming the key is todo. |
| RT-93 | `patch` "merge-patches existing items". Is a patch on a missing item an issue, or does it create the item? | Not asserted. That it is an issue is todo. |
| RT-94 | Is a widening transition change (an added out-edge, such as `closed: []` to `closed: ['refunded']`) a `transition_changed`, which is destructive? | Not asserted. That adding a state with new transitions gives no destructive change is todo. |
| RT-95 | Is a `world.yaml` holding several YAML documents refused, or is the first one used? | Not asserted. That it is refused is todo. |
| RT-96 | Is `saveWorld` byte-stable: the same world gives the same bytes, and save, load, check, save is a fixpoint? | Not asserted. Todo. G-54 asserts only the round trip. |
| RT-97 | How does the CLI fail on a bad invocation: unknown subcommand, missing arguments, or a missing, unparseable or wrong-shaped `--state` file? | Not asserted. That it exits non-zero on its own with a message (usage, or the bad input) is todo. |
| RT-98 | Is a CLI failure a clean message, or may it print a Node stack trace? | Not asserted. That `world check` failures print no Node stack frame and name a missing dir is todo. |
| RT-99 | What does `world verify` print for a failing task? | It exits non-zero (G-57). That it names the task and the issue code is todo. |
| RT-110 | What happens to work a snippet leaves behind or hands to host code: a microtask or `import()` that runs after the snippet returns, a ctx kept and used after its run, or a getter, `then`, `valueOf` or `toJSON` on a returned value that loops? The docs say only that snippets are synchronous and that a returned Promise is `snippet.promise_returned`. | A returned Promise gives `snippet.promise_returned` (G-22). The rest is todo: no write lands after a call returns, a stale ctx cannot write into a runtime, the process neither hangs nor leaves an unhandled rejection, and the check fails within the guard. |
| RT-111 | Is `globalThis` reachable inside the sandbox, and are the global's own names exactly `SANDBOX_GLOBALS`? `SANDBOX_GLOBALS` does not list `globalThis`, yet `sandbox.ts` snapshots `Object.getOwnPropertyNames(globalThis)` inside the context. | Tests probe globals with `typeof Name` and never need `globalThis`. That the own names are exactly `SANDBOX_GLOBALS` plus `globalThis` is todo. |
| RT-112 | Do allowed methods that read the host locale or time zone (`Number.prototype.toLocaleString`, `String.prototype.localeCompare`) give the same result on every host? `sandbox.ts` removes `Intl`, but these methods remain. | Todo. |
| RT-113 | Can a snippet observe the host stack depth, for example by counting frames until a caught stack overflow? The count depends on how deep the engine calls the snippet. | Such a seed may fail with `snippet.runtime_error`. That it seeds the same rows at every host stack depth is todo. |
| RT-114 | A loop with no ctx calls is stopped by the wall-clock guard, which reports `snippet.timeout_guard` (`ctx.ts` `SNIPPET_LIMITS`). How long may `checkWorld` or `advance` take when a snippet runs away? `guardMs` bounds one run, and the docs do not say how many runs a check makes after one times out. | The run ends in `snippet.timeout_guard` at its path. A runaway seed, or a runaway job during `advance`, runs once and ends within `guardMs` + 1000 ms. For graders, solutions and handlers the time bound is todo. A 30 s kill timer turns a hang into a failure. |
| RT-115 | Does `ctx.time.plus` or `ctx.time.minutesBetween` throw on input that is not an ISO time or a Duration (`'not a date'`, `'soon'`)? `ctx.ts` gives only the signatures. | Not asserted. That such a call throws a catchable error in seed, handler, job and grader is todo. |
| RT-120 | Is `next_cursor` always a string, or can it be a number? The docs name the key, not its type. | A non-empty string or a finite number. Tests send it back as its string form. |
| RT-121 | Do several filters in one request combine with AND? G-48 speaks of one filter. | Not asserted without todo. Single-filter walks are G-48. Pair and triple filters (`status=open&priority=urgent`) are todo. |
| RT-122 | Can a filter select null (`?assignee=null`)? | Not asserted. Walks leave null values out. That `assignee=null` gives `FACTS.unassigned` is todo. |
| RT-123 | Is a query key that is not a declared filter, limit or cursor param refused, or ignored? | A 4xx or a valid page. Never a 5xx, and never a state change. That it is refused is todo. |
| RT-124 | Does a cursor stay correct when rows are created, deleted or leave the filter in the middle of a walk? | Not asserted. That a walk skips nothing and repeats nothing is todo. |
| RT-125 | Is a PATCH that sets a state field to its current value (a self-transition that `transitions` does not list) refused? | Not asserted. That it is refused is todo. |
| RT-126 | Do JSON responses carry `content-type: application/json`? | Not asserted. Bodies are parsed as JSON whatever the header. That error bodies carry the header is todo. |
| RT-127 | Which status does a successful get or update give: 200, or any 2xx? | Any 2xx. Lists stay 200, since the fixture snippets assert it and G-05 needs them to pass. An action answers with its handler's own `status` (`ctx.ts` `RETURNS.handler`). The body of a get is not asserted, only compared by invariance. |

## Facts for test writers

- `#engine` exports these values: `checkWorld(input: unknown): CheckReport`, `createRuntime(w: CheckedWorld): Runtime`, `applyEdit(world: World, edit: unknown): Result<{ world; edit }, NonEmpty<CheckIssue>>`, `diffWorlds(before: World, after: World): WorldDelta`, `loadWorld(dir): Promise<Result<unknown, NonEmpty<CheckIssue>>>`, `saveWorld(dir, w: CheckedWorld): Promise<void>`, `emptyWorld(name, source)`, `editJsonSchema(sections)`, `formatReference()`, `issue`, `ISSUES`, `CHECK_LAYERS`, `DESTRUCTIVE`, `FIELD_TYPES`, `FIELD_TYPE_ORDER`, `SECTIONS`, `worldSchema` and `worldEditSchema`.
- `verifyTask`, `serve`, `grade` and `handle` are not exported. Verdicts come only from `CheckReport.verdicts` when `ok` is true. HTTP comes only through the CLI.
- `Runtime` has `call({ method, path, query, body }): { status, body }`, `dump(): { now, tables }` (tables map an entity to rows in id order), `reset()`, `log(): CallRecord[]` (`seq`, `at`, `routeId`, `req`, `res`), `advance(by: Duration): { jobsFired }` and `grade(taskId): number`.
- `CheckReport` with `ok: true` has `world`, `verdicts`, `stats` (`rows`, `states`, `unexercisedActions`), `tests` and `warnings`. With `ok: false` it has `reached`, `issues` and `warnings`.
- `Duration` matches `/^\d+(s|m|h|d)$/`. Client snippets get only `ctx.api`, `ctx.assert` and `ctx.now()`.
