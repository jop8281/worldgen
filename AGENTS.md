# AGENTS.md

## Current provider and dataset direction

Linear is the only issue tracker. Record work, acceptance, ownership and test results in Linear. GitHub is for code and pull requests. Never create a GitHub issue or a mirrored backlog.

The model path is A-66 as amended by A-283 in [research/decisions.md](research/decisions.md). Every generation, repair, escalation, solver and reply call uses `claude-sonnet-5-5` unless config or `--model` names another Claude model with a known price, built in or in `prices`. Config and both transports refuse any other id before a call, and no transport falls back to a different model. `claude -p` under the logged-in Claude Code session is the default transport. The Anthropic SDK is opt-in with `--transport sdk` and reads its key from `LLM_KEY`. Never read `.env` and never read `ANTHROPIC_*` variables. Boat is the only product sandbox provider, and `BOAT_API_KEY` stays at the trusted controller boundary. Never upload or log a key. Engine grading stays deterministic.

The [dataset plan](research/boat-sonnet-dataset-plan.md) and the [test plan](eval/boat-sonnet-test-plan.md) define the Boat and dataset work. YOS-75 owns Boat, YOS-91 JSONL episodes and replies, and YOS-108 evidence. The master coordinates and merges.

This repo holds two tools for a work trial. The world engine checks, serves, enforces and grades worlds, which are stateful replicas of real software such as a helpdesk or a payments API. WorldGen is an LLM agent that turns a description, an OpenAPI spec or a CSV into a world the engine accepts.

The task is in [research/spec.md](research/spec.md). The reasons behind this structure are in [research/architecture.md](research/architecture.md). Read the spec once. Do not copy it into code comments.

Status on 2026-10-07, on stabilize/main: everything this file describes is built. The engine checks a world in all seven layers including lints, serves it with the admin port and `GET /openapi.json`, verifies, grades, writes docs, and compares a world with its source spec (`worldplay openapi`). WorldGen has the run loop, the `worldgen` CLI, the description, OpenAPI and CSV inputs, the iterate run (`--world`), the judge, the repair policy, the preservation gate and `REPORT.md`. Also built: the rehearsal runner, the live runner (`bun run live`, `scripts/live.sh`), the spend ledger (`bun run costs`), the OpenShell, sbx and Boat sandbox backends, the dataset export (`bun run dataset`), the demos (`scripts/demo.sh`, `scripts/solve-demo.sh`) and the fresh-clone gate (`scripts/qualify-main.sh`). Bun is the default runtime and Node 22 the second gate. `prod/worlds/` holds 2 hand-built worlds and 23 generated ones. The README status table links the PR behind each item. Every path this file names in backticks exists.

## How work lands

This is the workflow as of 2026-10-07. Linear and GitHub split the work, and one master session (worldgen-27) merges everything.

- **Linear tracks the work.** Team YOS, project WorldGen. An issue holds the acceptance, the owner, the status and the test results. Cite issues as YOS-n in branch names, PR text and decisions. Never open a GitHub issue.
- **GitHub holds code and pull requests.** The repository is public. Never commit a secret, a key, a `.env` file or a log that holds one.
- **Two branches.** `stabilize/main` is the integration branch, and every PR targets it. `main` moves only by a promotion PR from the master, after `scripts/qualify-main.sh` passes on the candidate. Examples are #383, #403 and #410.
- **One job per session.** A session takes a job from the master, works in a fresh worktree under ~/wt/<job> cut from the latest `origin/stabilize/main`, and pushes a branch such as `dispatch/<job>`. It opens a PR to `stabilize/main` and replies to the master with "PR #n <sha>". Sessions never merge, and never push to `stabilize/main` or `main`.
- **The master owns order.** It assigns decision numbers for `research/decisions.md`, so parallel PRs do not collide. It announces freezes. During a freeze, only fixes it asks for may land, and other PRs open as drafts.
- **Rule 7, machine load.** Never run the full suite on the shared machine. Run only the test files that call what you changed, found by grep, under `nice -n 15` at concurrency 1 or 2.
- **Rule 9, CI before merge.** Every PR needs a green `check` run of GitHub Actions on its head commit before the master merges it.
- **Rule 10, CI only.** Verification runs in CI, not on the shared machine.
- **When GitHub writes fail.** Base work on the local branch `stabilize-next` in the main checkout. Commit it to a local `dispatch/<job>` branch, and tell the master "LOCAL dispatch/<job> <sha>". The master merges locally and pushes when GitHub recovers.
- **Consolidation mode, user order of 2026-10-07.** While it is on, it overrides rules 9 and 10. Sessions write code and docs and open PRs without unit-test runs or CI waits, and the master merges at once. The master announces when it ends.

## The four top-level directories

| Dir | Put here | Never put here |
|---|---|---|
| `research/` | The spec, plans, `decisions.md`, `architecture.md`, domain notes. Markdown and JSON only. | Code or spikes. Nothing in `code/` reads it. |
| `code/` | The one npm package: engine, WorldGen, CLIs, tests. | Worlds, eval inputs, deliverables. |
| `eval/` | The rehearsal suite (`suite.yaml`), its inputs, and run output, which `bun run eval` writes under eval/runs on its first run. | Code, or worlds meant for submission. |
| `prod/` | What gets handed in: `design.md`, the generated `world-format.md`, the hand-built world, generated worlds. | Drafts and rehearsal runs. Tests check every world here, so a broken world fails `bun run test`. |

`code/` reads `prod/worlds/*` by path, in tests and as the few-shot example (`exampleWorld` in `code/worldgen.config.json`). It never imports from `research/`, `eval/` or `prod/`.

## Module map

Paths are under `code/src/`. Each module owns one piece of knowledge.

The engine lives in `engine/`. `index.ts`, `sandbox.ts` and `http.ts` are shell files that may touch Node. Every other engine file is core and stays pure. `costs/`, `sandboxes/`, `dataset/` and `cli/` are shell code outside the engine; `sandboxes/` never imports the engine. `dataset/` reaches the engine only through `#engine` and the model only as an injected `Model` (a type-only import of llm.ts).

| Module | Owns |
|---|---|
| `engine/fields.ts` | Every field type in `FIELD_TYPES`, with schema, validation, ordering, query parsing, CSV inference, doc and examples. |
| `engine/format.ts` | The world format and `WorldEdit`. Types, tool schemas and docs derive from it. |
| `engine/ctx.ts` | What each snippet kind receives (`HANDLER_CTX`, `JOB_CTX`, `SEED_CTX`, `GRADER_CTX`, `CLIENT_CTX`) and the `SnippetHost` interface. |
| `engine/issues.ts` | Every issue code with severity, owner, expected text and hint. The only minter of `CheckIssue`. |
| `engine/error-codes.ts` | The closed catalog of runtime HTTP error codes (`RUNTIME_ERROR_CODES`): status and meaning per code. The single source for engine refusals in api.ts/http.ts and for `x-error-codes` in `openApiOf`. Pure. |
| `engine/check.ts` | Whether a world is acceptable, layer by layer. The only minter of `CheckedWorld`. |
| `engine/store.ts` | State, transactions, and data-model enforcement on every write. |
| `engine/clock.ts` | Engine time, durations, and the order in which jobs fire. |
| `engine/api.ts` | Requests to operations: path matching, standard ops, paging, envelopes, actions, `Runtime`. |
| `engine/tasks.ts` | Grading and task verification. The only minter of `TaskVerdict`. Refuses a bare task with `task.instruction_only`. |
| `engine/diff.ts` | The semantic diff between two worlds (`WorldDelta`). |
| `engine/split.ts` | The public/private split (YOS-159): which task material is private (`grader`, `solution`, decoys, alternatives), `taskPrivacy`, and `publicWorldOf`, the public form a public bundle serves. Pure. |
| `engine/verify.ts` | The verifier protocol (YOS-159): the request schema, the trace hash chain (`chainOf`), and `verifySubmission`, which replays a recorded trace from seed and grades the state it reaches, answering only the bounded verdict. Pure. |
| `engine/sandbox.ts` | The deterministic `node:vm` host for snippets. The only importer of `node:vm`. |
| `engine/ui.ts` | The operator console page served on the admin port. Pure. |
| `engine/http.ts` | The `node:http` adapter: the world port with `GET /openapi.json`, and the admin routes on their own port. |
| `engine/rules.ts` | Declarative workflow rules on an action or job (A-167): their schema, the bounded-JSON guard, and `lowerRules`, which gives the handler or run source. Pure. |
| `engine/openapi.ts` | The OpenAPI 3.1 document for a world's public API (`openApiOf`). Pure; graders, solutions and admin routes never reach it. |
| `engine/openapi-fidelity.ts` | Whether a world's public OpenAPI conforms to its source spec under `--only` (`openapiFidelity`), and the `--only` prefix rule. Pure. |
| `engine/openapi-conformance.ts` | The named OpenAPI conformance profile around `openapiFidelity` (`openapiConformance`): what it checks, what it cannot, source coverage and refusals. Pure. |
| `engine/provenance.ts` | The canonical text of a world and a task. Pure; `#engine` hashes it into the WID and TID. |
| `engine/index.ts` | The public surface, imported as `#engine`. YAML file IO and sha256 content ids. |
| `worldgen/run.ts` | One run: digest, plan, stages, then save or stop. The only module that holds a `Model`. |
| `worldgen/iterate.ts` | Iterate-only prompts, `iteratePlanSchema` (what a change plan owes the old world), and `changedSections`: which sections a change plan reaches. Pure, no model. |
| `worldgen/stages.ts` | The stage table, `SECTION_OWNER`, and what each stage reads and writes. Acceptance tests are fixed in the approved plan before implementation. |
| `worldgen/policy.ts` | `decide()`: retry, advance, backtrack or stop. Pure. |
| `worldgen/judge.ts` | Acceptance from engine output and the plan. Takes no model. |
| `worldgen/plan.ts` | The plan schema, plan coverage, and `plan.yaml`. |
| `worldgen/plan-md.ts` | `plan.md`, the human view of the plan: `renderPlanMd(plan)` from the same Plan as `plan.yaml`, in its key order. Pure, no IO; `run.ts` writes it beside `plan.yaml` on create and iterate. |
| `worldgen/input.ts` | Input kinds (`INPUT_KINDS`), redaction, digests. |
| `worldgen/input-coverage.ts` | Whether a world covers the original input: OpenAPI operations, the error template, CSV fixtures. Pure. |
| `worldgen/llm.ts` | The model transports and cost: `claude -p` under the logged-in session by default, the SDK opt-in with `--transport sdk`. The only importer of `@anthropic-ai/sdk` and the only spawner of the claude CLI under `worldgen/`. |
| `worldgen/events.ts` | `RunEvent`, `StopReason` and the JSONL emitter. |
| `worldgen/report.ts` | `REPORT.md` from plan, verdicts, delta, events, the WID and each TID. No model. |
| `worldgen/openapi-report.ts` | The Markdown audit of an `openapiConformance` result for `worldplay openapi --profile` and `--report`. No model, no IO. |
| `worldgen/capsule.ts` | `capsule.json` beside `REPORT.md` on every exit: input digest, world id, model, transport, attempts, costs. No model, no file IO. |
| `worldgen/fidelity.ts` | Fidelity to a frozen reference of the real software: the reference schema, `fidelityScore()`, and `fidelityGate()`, the last step's 0.80 floor for a description that names a reference (A-258). Pure. |
| `worldgen/eval-outcomes.ts` | Offline eval analysis against an explicit expected case set. No model, no file IO. |
| `worldgen/eval.ts` | The rehearsal suite schema, case sequencing, the `summary.md` scorecard and `fidelityScore()` against `eval/fidelity/*.yaml`. No model, no file IO. |
| `worldgen/live.ts` | The live run: plans cases from the files in `prod/prompts/`, and renders the `prod/LIVE-RUN.md` table. No model, no file IO. |
| `worldgen/config.ts` | Settings and defaults, parsed strictly. |
| `costs/basis.ts` | The schema for model cost estimate sources, shared by transports and ledger entries. |
| `costs/boat-receipts.ts` | Separate append-only Boat usage evidence, canonical snapshots by VM and requested UTC day, with inspection provenance and explicit list-price units. It never settles spend. |
| `costs/ledger.ts` | The append-only spend ledger, the USD caps and `guard()`. Keys never reach it, only fingerprints. |
| `costs/meter.ts` | Decorators that meter a model or a sandbox backend into the ledger and check the caps first. |
| `costs/pricing.ts` | Key fingerprints, ledger accounts, boat.dev sizes and rates. Model prices stay in config. |
| `boat/client.ts` | The boat.dev client behind the narrow `BoatClient` interface. The only importer of `@boatdev/sdk`. Reads `BOAT_API_KEY` and `BOAT_BASE_URL` from the process environment only, and keeps the key out of every error. |
| `dataset/*.ts` | YOS-91 episodes: `episode.ts` runs one solver episode, `solver.ts` turns an injected `Model` into turns, `pipeline.ts` runs one sandboxed dataset run, `local.ts` runs one episode on loopback for the studio's Agent Playground, `store.ts` and `schema.ts` own the JSONL export, and `verifier.ts` builds the verifier request and grades through `engineGrader` (in-process) or `childGrader` (one `cli/verifier.ts` process per submission). |
| `sandboxes/backend.ts` | The `SandboxBackend` interface, the 2-CPU default size, the injected `Runner` and long-running `Spawner` (`nodeRunner`, `nodeSpawn`), and `upWorld()`. For a public sandbox `upWorld()` serves on `0.0.0.0`, exposes only the world port, and checks the exposed URL from outside (`reachWorld`). |
| `sandboxes/boat.ts` | The Boat backend, the only product sandbox: create a small VM, wait, ensure Node 22, upload, run, and stop with a verified archive. Takes a `BoatClient`. |
| `sandboxes/registry.ts` | `backendFor()`: a metered backend of one kind and size. Sandboxes the CLI leaves running are handed over through a record file. `discoverBoat()` inspects inventory; `trackBoat()` persists unresolved owner exposure; `captureBoatUsage()` saves separate UTC-day usage evidence. |
| `sandboxes/openshell.ts` | The NVIDIA OpenShell backend over the `openshell` CLI. |
| `sandboxes/sbx.ts` | The Docker Sandboxes backend over the `sbx` CLI. |
| `sandboxes/files.ts` | The bundle of code package plus one world, and its host workspace. `collectBundle` `publicOnly` uploads only `<worldDir>/public/world.yaml`, the public form of the world (YOS-159), so no grader, solution or decoy source reaches a sandbox. |
| `studio/analytics.ts` | Agent Playground analytics: exported episodes grouped by world, task and model, with success rate, failure causes and cost per success. Pure. |
| `studio/page.ts` | The studio page: one offline operator app. Pure. |
| `studio/runstore.ts` | The studio's generation runs on disk (`.studio-runs.json` in the worlds dir): saved on start and exit, reloaded on start, where a live process is adopted and a dead unfinished one is interrupted (A-329). Process checks are injected. |
| `studio/explorer.ts` | The World Explorer's view of a checked world: wid, entities and references, routes, jobs, and tasks as an agent is told them. Pure; no snippet or task source. |
| `studio/server.ts` | The studio server: worlds, explorer, rollout, the API console, generation runs, eval and spend, and the Agent Playground (episode children, the engine proof). Owns sign-in: the roles each route needs (viewer, operator, admin), bearer-token checks, and the audit line every POST writes (A-322..A-325). Loopback unless users are configured. |
| `cli/sandbox.ts` | Argument parsing for `bun run sandbox`: up, exec, down, discover, track, capture-usage, reconcile-create, reconcile-usage. No logic. |
| `cli/worldplay.ts` | Argument parsing for the engine CLI: check, serve, verify, grade, docs. No logic. |
| `cli/eval-analysis-files.ts` | Reads the current eval case paths for analysis, never hidden history as another case. |
| `cli/eval-retention.ts` | `withEvalAttempt`: a per-case lock, and the previous case run renamed into `.attempts` before a new one writes its path. |
| `cli/eval.ts` | Argument parsing and file IO for `bun run eval`. No logic. |
| `cli/costs.ts` | Argument parsing and printing for the spend CLI. |
| `cli/dataset.ts` | `bun run dataset`: argument parsing and wiring for one sequential dataset run. The work is in `dataset/pipeline.ts`. No logic. |
| `cli/verifier.ts` | The trusted verifier child process (YOS-159): spawned once per submission, it loads and checks the private world, verifies one protocol request, records the submission in the run's ledger, and prints one bounded verdict. No listener, no credential, no world or grader content on stderr. |
| `cli/studio-check.ts` | The Studio's check child (A-338): spawned once per Explorer request with an environment of only TZ, PATH and the guard scale, it loads and checks one world and prints the Explorer view as one JSON object. Exit 3 means the world does not load or check, with one authored line on stderr. |
| `cli/live.ts` | `bun run live`: lists the prompts, runs WorldGen on each one at a time, checks and verifies, moves a verified world to `prod/worlds`, writes the table. |
| `cli/models.ts` | The shared wiring for CLIs: transport choice, metering into the ledger, the example world, and writing `REPORT.md`. |
| `cli/episode.ts` | Argument parsing and wiring for `bun run episode`: one local agent episode for the studio's Agent Playground. The work is in `dataset/local.ts`. No logic. |
| `cli/studio.ts` | Argument parsing and wiring for `bun run studio`: the operator web app, and its users from `--users <file>` or `WORLDGEN_STUDIO_TOKEN`. No logic. |
| `lib/never.ts` | `assertNever` for exhaustive switches. |

`cli/worldgen.ts` sits with the other CLIs and imports `cli/models.ts`. Its iterate mode (`--world`) loads a checked existing world, plans the change, reruns affected stages through the preservation gate, and saves a semantic Changes report. Stops preserve the previous world and plan.

## Invariants and what enforces them

Each row names the mechanism that fails when you break the rule. Do not route around it with a cast, a `default:` branch or a relative import. If a rule blocks a correct change, change the rule in the same commit and log it in `research/decisions.md`.

| Invariant | Enforced by |
|---|---|
| The engine is the only judge. WorldGen never edits the engine and never grades with a model. | `#engine` in `package.json` `imports`. `test/architecture.test.ts` allows worldgen to import only `src/engine/index.ts`, and allows only `run.ts` and `cli/` to import `llm.ts`. Brands on `CheckedWorld`, `CheckIssue` and `TaskVerdict`, each castable in one file only. |
| One world format drives validation, tool schemas, errors and docs. | zod in `format.ts` and `FIELD_TYPES`. Ctx registries typed `Registry<Ctx>`. `test/ctx.test.ts` compiles each `sig` against its interface. `test/docs.test.ts` fails when `prod/world-format.md` is stale. |
| World logic is deterministic. | The global allowlist in `sandbox.ts` and its snapshot in `test/sandbox.test.ts`. The ctx call quota (`SNIPPET_LIMITS`). The replay check (`task.nondeterministic`). |
| Engine core never reads the wall clock, randomness, network or fs. | `tsconfig.engine-core.json` (`types: []`). The symbol rule in `test/architecture.test.ts` bans `Math.random`, `globalThis`, `performance`, and `Date` outside `clock.ts`. Time flows in as `State.now`. |
| A failed call leaves no partial change. | `transact()` in `store.ts`. `test/runtime.test.ts` and `test/actions.test.ts` assert the dump is unchanged after a failed call. |
| Check errors are precise enough for a model to fix. | `issue()` needs a catalog code and fills path, expected, found and hint. |
| Reference solutions use the public API. | `ClientCtx` has only `api`, `assert` and `now`. `api` goes through `handle()` in `api.ts`. |
| Graders discriminate. | `verifyTask()`. The solution scores 1, doing nothing scores 0, every decoy scores below 1 without being trivial, every strict prefix of the solution's writes scores below 1, and the solution plus one collateral write scores below 1 (A-156). |
| Iteration is a diff. | Worlds change only through `WorldEdit`. `preservationIssues()` in `judge.ts` blocks unplanned destructive changes found by `diffWorlds()`. |
| Each section has one owning step. | `SECTION_OWNER satisfies Record<Section, ...>` in `stages.ts`. The plan step owns the acceptance tests, so a stage edit that touches `tests` is `edit.out_of_scope`, and `judgeEdit()` sends it back to the plan, which must raise its revision to change a test. On iterate, `iteratePlanSchema()` in `iterate.ts` lets a plan rewrite or drop an existing test only when `changes` names `tests.<id>`. |
| boat.dev is reached only through `BoatClient`, a world served there exposes only its world port, and `BOAT_API_KEY` comes from the process environment. | `test/architecture.test.ts` allows only `src/boat/client.ts` to import `@boatdev/sdk`. `test/boat.test.ts` and `test/sandbox-registry.test.ts` use a fake `BoatClient`, assert that only the world port is exposed, and never read the key from the process. |
| Every stage, attempt, time and cost is logged. Model and budget are config. | The `RunEvent` union. `configSchema` is strict. The architecture test bans a `default:` branch without `assertNever` in switches over closed unions. |
| A public bundle carries no grader, solution, decoy or alternative source, and grading happens only in the trusted verifier, which holds the private world. | `engine/split.ts` (what is private), `check.ts` (`tasks.private_mixed`; the tasks layer accepts only an all-bare world as public), `sandboxes/files.ts` `publicOnly`, `engine/verify.ts` (the bounded verdict, the only answer a verifier gives), and `test/verifier-boundary.test.ts`, which scans the bundle, the public port, every verdict and the child's answers for private-source windows. |

## Commands

Run these from `code/`, after one `bun install` on Bun 1.4. Bun is the package manager, script runner, test runner and runtime. `package-lock.json` stays for the Node CI job, which runs the same tests under node:test on Node 22 and gates the snippet heap bound that Bun ignores (A-87).

```sh
bun run typecheck                                    # whole package, then engine core without Node types
bun run test                                         # bun test runs the node:test files
bun run check                                        # the default gate: typecheck, then every test under Bun (A-134)
npm run check:node                                   # the second gate: typecheck, then node:test on Node 22; enforces the heap bound
bun run docs                                         # regenerate ../prod/world-format.md
bun run e2e                                          # acceptance: typecheck, helpdesk checked, verified and over HTTP, CLI help, fresh docs

bun run worldplay check  ../prod/worlds/helpdesk      # issues with path, expected, found, hint
bun run worldplay verify ../prod/worlds/helpdesk      # per task: solution 1, noop 0, decoys below 1
bun run worldplay serve  ../prod/worlds/helpdesk --port 4000   # world on 4000 with /openapi.json, admin routes on 4001
bun run worldplay grade  ../prod/worlds/helpdesk <task> --state end.json
bun run worldplay openapi ../prod/worlds/gen-petstore --spec ../eval/inputs/petstore.openapi.yaml   # compare the public API with its source spec
../scripts/demo.sh                                   # check, verify, serve, curl world and admin routes, stop
../scripts/solve-demo.sh                             # solve a task over the world port alone, grade it on the admin port
../scripts/qualify-main.sh --ref origin/main         # fresh clone: install, typecheck, check and verify every world, both demos

bun run eval --dry-run                            # validate ../eval/suite.yaml; no model call
bun run eval --only helpdesk-sla --model claude-sonnet-5-5 --budget-usd 2   # run cases into ../eval/runs/
bun run live ../prod/prompts --dry-run             # list the live-run prompts, no model call; exits 2 "No prompts" until the team's prompts are in; drop --dry-run to run them
bun run costs --by run                            # llm and sandbox meters, spend by provider|kind|account|day|run, caps
bun run sandbox --help                            # up <worldDir> --backend openshell|sbx|boat, exec <id>, down <id>; world port only
bun run dataset --help                            # one graded solver episode per task in a Boat sandbox; needs BOAT_API_KEY.
                                                  # The sandbox serves the public bundle only; a separate verifier child process
                                                  # (cli/verifier.ts) grades each recorded trace against the private world.
bun run studio [--port 8787] [--users <file>] [--worlds-dir <dir>] [--repo-root <dir>]   # the operator web app: worlds dashboard, rollout, generation runs, eval, spend and the Agent Playground; sign-in when users are given
../scripts/live.sh --env-only                        # the live-run env check; drop --env-only and pass <slug> "<description>" to run

bun run worldgen "A helpdesk with SLA tiers and on-call escalation" --out ../prod/worlds/gen-<slug>
bun run worldgen --openapi <spec.yaml> --only /v1/refunds --out ../prod/worlds/gen-<slug>
bun run worldgen --csv <orders.csv> <customers.csv> --out ../prod/worlds/gen-<slug>
bun run worldgen "add refunds" --world ../prod/worlds/gen-<slug>   # iterate an existing world through preserved edits
```

The admin port serves `GET /_world/state`, `POST /_world/reset`, `GET /_world/log`, `GET /_world/openapi`, `POST /_world/clock` with `{"advance":"4h"}`, and `POST /_world/grade/<task>`. `serve` also prints the console URL, the self-contained operator page the admin port serves at `GET /`. The agent under test only gets the world port. `--model`, `--budget-usd` and `--max-minutes` override `worldgen.config.json`. The model runs through `claude -p` by default; `--transport sdk` reads the key from `LLM_KEY`. The spend ledger is the file in `WORLDGEN_COSTS_FILE`, default costs.jsonl under ~/.worldgen, capped by `WORLDGEN_MAX_DAILY_USD` and `WORLDGEN_MAX_TOTAL_USD` across both meters, and per meter by `WORLDGEN_MAX_DAILY_LLM_USD` and `WORLDGEN_MAX_DAILY_SANDBOX_USD`. Boat time without `BOAT_USD_PER_COMPUTE_HOUR` is recorded unpriced (usd null), never as $0.

The studio (`bun run studio`) is the operator's loopback web app: one offline page (`studio/page.ts`, no absolute URL, textContent only) over the `studio/server.ts` routes. It spawns `worldplay serve` and `worldgen` children through the injected `Spawner` (`nodeSpawn` in `sandboxes/backend.ts`) with the environment passed through untouched, so no key is stored or logged, and it never imports `worldgen/llm.ts`. The studio port carries no `/_world` route; a served world keeps its own world and admin ports. The Explorer's API console (`POST /api/services/:id/call`) forwards one request to the world port of a service the studio started and answers the world's real status and body. It refuses `/_world` paths and any other origin, so it never reaches an admin port (A-268). With `--users <file>` or `WORLDGEN_STUDIO_TOKEN`, every route but the page and `GET /api/health` needs a bearer token: a viewer reads, an operator also runs every POST, and an admin also reads `GET /api/audit`, the log of every POST. The page holds the token per tab and never in a cookie, because a served world logs every request header. Without users the studio binds only loopback (A-322..A-325). The Explorer check (`cli/studio-check.ts`) and the proof run in a one-shot child with an allowlisted environment (TZ, PATH, WORLDGEN_GUARD_SCALE), and the web process never runs a snippet (A-338).

## How to add common things

Start at the entry file and copy the exemplar. Then run `bun run typecheck`. The compiler names every other file that needs a change. Fix each error. Do not silence one with a cast.

**A field type.**
1. Add a `kind(...)` entry to `KINDS` in `engine/fields.ts`. Copy the `money` entry.
2. Fill `examples` with valid and invalid values. `test/fields.test.ts` runs them for every type.
3. If CSV columns should infer it, add it to `FIELD_TYPE_ORDER`.
4. Run `bun run docs`.

Never branch on `def.type`, with a `switch` or an `===`, outside `fields.ts`. Call `FIELD_TYPES[def.type]`, or read a capability through `refOf`, `machineOf`, `choicesOf` or `initialOf`. A behavior only some types have is an optional member of the `KINDS` entry. `test/architecture-symbols.test.ts` fails on a branch.

**A grader assertion helper, or any ctx member.**
1. Add the member to `GraderCtx` and to `GRADER_CTX` in `engine/ctx.ts`. Copy `changes`.
2. Implement it in the grader ctx builder in `engine/tasks.ts`. The compiler points there.
3. Add a test with a literal expected value, then run `bun run docs`.

**An input adapter.**
1. Add a variant to `inputSchema` and an entry to `INPUT_KINDS` in `worldgen/input.ts`. Copy `csv`.
2. Strip its secrets in `redact()`. Add a test that a token in the input never reaches the digest.
3. Add a case to `eval/suite.yaml`. The CLI flag and the suite both parse `inputSchema`.

**A workflow construct, meaning a new keyed section like `jobs`.**
1. Add the section to `sections` in `engine/format.ts`. Copy `jobs`.
2. Give it one owner in `SECTION_OWNER` in `worldgen/stages.ts`. The compiler asks for it.
3. If it holds code, add a snippet kind to `engine/ctx.ts`. Copy `JobCtx` and `JOB_CTX`.
4. Run it from `engine/api.ts` or `engine/clock.ts`, and add its issue codes to `engine/issues.ts`.
5. Use it in `prod/worlds/helpdesk/world.yaml`, so the golden world covers it.

**An issue code.** Add it to `ISSUES` in `engine/issues.ts` with owner, expected and hint. Create it only with `issue()`.

## Testing rules

- Test behavior through public functions. Assert literal values, such as `assert.equal(res.status, 409)`. Never compute the expected value with the code under test.
- `prod/worlds/helpdesk/world.yaml` is the golden world, built by hand. `test/worlds.test.ts` checks and verifies it and every other world in `prod/worlds/`. A format change updates it in the same commit.
- To get a world for a test, copy the helpdesk world. Write a small inline world only to trigger one issue code.
- `now()` is a function in every ctx. Write `ctx.now()`, never `ctx.now`.
- WorldGen tests use the scripted fake `Model` in `test/worldgen.test.ts`. `bun run test` never calls the real API.
- Test `policy.ts` with tables that map state and outcome to a decision. Do not route them through the fake model.
- If a change in call order breaks the fake model script, fix the script. Do not loosen the assertion.
- `test/architecture.test.ts` also checks that every path this file names exists.

## Decisions and assumptions

- Log every design call as a row in `research/decisions.md`: decision, choice, why, date, reversible.
- Log spec ambiguities in the same table. Start the decision text with `Spec:`.
- An assumption WorldGen makes for one world goes in that world's `plan.yaml` under `assumptions` and in its `REPORT.md`. It does not go in `research/`.
- Never edit `prod/world-format.md` by hand. Never write a `world.yaml` except through `saveWorld()`.
