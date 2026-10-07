# WorldGen design doc vs the repo

This page compares the WorldGen Design Doc (PDF, 2026-10-06) with `stabilize/main` at `7c0bbf66dc079443d968c557e3483e2fbff7c04f` (2026-10-07). The PDF states what to build. `decisions.md` changed how: TypeScript on Node 22 (A-01, A-46), in-memory maps instead of SQLite (A-14), the Python engine retired (A-45), and the engine CLI named `worldplay` (A-52). Those switches are listed once under "Superseded" and are not gaps.

Status: **built** means code and tests on `main`. **Partial** means some of it works. **Missing** means nothing runs yet.

## Superseded by a logged decision

| PDF says | Repo does instead | Decision |
|---|---|---|
| Python, `uv` project, `logic.py`, `seed.py`, `tasks/*.py`, `tests/scenarios.py` | One `world.yaml` with JS snippets for actions, jobs, seed, tests, graders and solutions, run in a deterministic `node:vm` | A-01, A-45, A-46 |
| In-memory SQLite, one savepoint per call | Immutable maps with an overlay per call (`transact()` in `store.ts`) | A-14 |
| `engine check/serve` CLI, `/_engine/*` admin routes | `worldplay check/serve/verify/grade`, `/_world/*` admin routes | A-52 |
| `engine check --stage model\|logic\|seed\|tasks\|all` | Check layers `schema, references, compile, seed, tests, tasks, lints`; WorldGen stages filter them with `blockingIssues()` | architecture.md §1, §10 |
| Four file tools `read/write/edit/check` | One typed `WorldEdit` tool per stage, schema from `editJsonSchema(section owners)` | architecture.md §3 |
| `plan.json` + `plan.md` | `plan.yaml` | architecture.md |
| TOML settings `[models] [budget]` | `code/worldgen.config.json`, strict zod schema | config.ts |
| A near-miss for hard tasks | Decoys per task (required for medium and hard) plus engine-made solution prefixes | architecture.md §9 |

## Engine

| PDF feature | Status | Where, or what is missing |
|---|---|---|
| World format: entities, fields, keys, links, transitions, routes, hooks | partial | `format.ts`, `fields.ts`; state fields carry transitions. Creation hooks are not built (`format.ts` has no hooks section); substituted by per-type `initialValue` plus privileged action, job and seed writes, recorded as A-244 (YOS-181); filed Linear issue: Record or build creation hooks |
| Check with precise errors (path, code, expected, found, hint) | built | `issues.ts`, `check.ts`; `worldplay check [--json]` |
| Check report carries `file` and `line` | missing | Issues have a path but no YAML line; the PDF's sample shows `"line": 41` |
| Quality lints layer | missing | `check.ts` `lints: passThrough` |
| Enforce: refuse bad writes, no partial change | built | `store.ts` `transact()`; dump-unchanged tests |
| Deterministic clock, ID counters, stable order | built | `clock.ts`, `store.ts` |
| Jobs fired by engine time (SLA breach) | built | `clock.ts`, `api.ts` |
| Call log, with refused calls and empty `writes` | built | `Runtime.log()` |
| State dump | built | `Runtime.dump()` |
| Dump carries a `sha256` hash | partial | `stateHash()` exists for verify; the dump itself has no `hash` field |
| Reset, clock advance | built | `Runtime` |
| Grade from end state | built | `tasks.ts` `grade`, `gradeDump` |
| Proof: reference 1.0, no-op 0.0, replay twice identical | built | `verifyTask()` |
| Proof: near-miss/decoys below 1, strict solution prefixes below 1, anti-trivial decoys | missing | `verifyTask` returns `decoys: []`, `bestPrefixScore: null` ("engine-verify-full") |
| Built-in `no_collateral` guard | built | `verifyTask` runs engine collateral mutants (`target_field`, `other_row` A-156; `retarget`, `perturb` A-199; `extra_action`, `extra_create`, `extra_delete` A-222) and a mutant that scores 1 fails verify as `task.mutant_full_marks`; `ctx.changes()` (A-28) stays the grader-side diff |
| `serve` over HTTP, world port + separate admin port | missing | no `engine/http.ts`; `worldplay serve` prints "not implemented yet" |
| Admin routes state/reset/log/clock/grade | missing | depends on `http.ts` |
| Generated `/openapi.json` for agents | missing | |
| `worldplay verify`, `grade`, `docs` | missing | stubs in `cli/worldplay.ts` |
| Folder of broken worlds, each asserting its exact issue | partial | inline fixtures in tests; no `broken/` corpus |

## WorldGen

| PDF feature | Status | Where, or what is missing |
|---|---|---|
| Plan schema and stage table | built | `plan.ts`, `stages.ts`, `SECTION_OWNER` |
| Stage acceptance from engine output only | built | `judge.ts` `blockingIssues()` |
| Repair policy: retry, advance, backtrack, stop | built | `policy.ts` `decide()` |
| Stop rules: same codes 3x restart, budget stop with report and non-zero exit | partial | `decide()` covers no-progress and budget; nothing runs it |
| Run log events with time, tokens, USD | built (types) | `events.ts`; nothing emits them yet |
| Settings: model, budget, minutes | built | `config.ts` |
| Model client | partial | Anthropic SDK client in `llm.ts` needs `ANTHROPIC_API_KEY`; the `claude -p` transport in `models.json` has no code |
| The run loop itself (digest, plan, stages, save or stop) | missing | `run.ts` `runWorldGen` throws `not implemented` |
| Description input | built | `input.ts` |
| OpenAPI input with path filter | missing | `INPUT_KINDS.openapi` loader is `notImplemented` |
| CSV input | missing | `INPUT_KINDS.csv` loader is `notImplemented` |
| Update mode ("add refunds"), every old task must still prove | missing | `judge.ts` `preservationIssues()` throws |
| `REPORT.md` assembled from logs and verdicts | missing | no `worldgen/report.ts` |
| `worldgen` and `eval` CLIs | missing | no `cli/worldgen.ts`, `cli/eval.ts` |

## Deliverables

| PDF deliverable | Status | Notes |
|---|---|---|
| Repo, one command per tool | partial | `worldplay check` works; `worldgen` has no CLI |
| Short design doc in the repo | missing | `research/design-draft.md` is a draft; `prod/design.md` absent |
| Hand-built helpdesk with SLA tiers and on-call escalation | partial | entities and routes only; `actions`, `jobs`, `seed`, `tests`, `tasks` are `{}` |
| Optional tau-bench domain import | missing | notes only (`research/tau2-retail-expected-behaviour.md`) |
| Generated worlds with `REPORT.md` | missing | needs the run loop |
| Eval set of 12+ prompts, rehearsed live run | missing | `eval/` holds only a README; prompts are drafted in `research/rehearsal-prompts.md` |
| `prod/world-format.md` generated | missing | `npm run docs` is a stub |

## Beyond the PDF

- boat.dev sandboxes through `@boatdev/sdk`: requested 2026-10-06. Not in the PDF. Planned as one module that is the only importer of the SDK, so a world can be served, or a solver run, inside a boat VM.
- `test/input.test.ts` "a 100KB snake_case run finishes fast" fails on a 4-CPU container (about 232 ms against its threshold).

## Linear issues for each gap

On 2026-10-06 several of these issues were already In Progress in the agent factory (YOS-21, YOS-26, YOS-34, YOS-37, YOS-43). This PR leaves them alone, so the work is not duplicated.

| Gap | Issue |
|---|---|
| HTTP serve, admin port, `worldplay serve/verify/grade` | YOS-26 (In Progress) |
| Decoys, anti-trivial decoys, solution prefixes | YOS-37 (In Progress) |
| Lints layer | YOS-40 |
| Helpdesk actions and SLA job | YOS-21 (In Progress) |
| Helpdesk seed and workflow tests | YOS-27 |
| Helpdesk tasks with decoys | YOS-39 |
| Engine acceptance suite and freeze | YOS-42 |
| Run loop | YOS-34 (In Progress), YOS-44 |
| `REPORT.md` | YOS-43 (In Progress) |
| `worldgen` CLI | YOS-35 |
| `claude -p` model client | YOS-74 (new) |
| Live smoke run, stage prompts | YOS-36, YOS-45 |
| OpenAPI and CSV inputs, input conformance | YOS-47, YOS-48, YOS-49 |
| Iterate mode and preservation gate | YOS-52, YOS-46 |
| `prod/world-format.md`, `prod/design.md`, README | YOS-41, YOS-56, YOS-57 |
| Eval inputs, runner, stress runs, rehearsal, generated worlds | YOS-50, YOS-51, YOS-53, YOS-54, YOS-58, YOS-55 |
| boat.dev via `@boatdev/sdk` | YOS-75 (new) |
| `/openapi.json` for the agent under test | YOS-76 (new) |
| YAML line numbers on check issues | YOS-77 (new) |
| Dump carries its hash and world name | YOS-78 (new) |
| Redact perf test fails on 4-CPU machines | YOS-79 (new) |
| τ-bench retail import | YOS-80 (new) |

## Critical path to end to end

1. Engine: `http.ts` serve with admin port, `worldplay serve/verify/grade/docs`, full verify (decoys, prefixes).
2. Helpdesk: actions (escalate, resolve), SLA job, seed, tests, three tasks with decoys. `worldplay verify` passes.
3. WorldGen: `claude -p` model client, `runWorldGen` loop, `REPORT.md`, `cli/worldgen.ts`. One description prompt produces a world that passes check and verify.
4. OpenAPI and CSV inputs, then iterate mode.
5. `eval/suite.yaml` with 12+ prompts, `cli/eval.ts`, `prod/design.md`, generated `prod/world-format.md`.
