# AGENTS.md

## Current provider and dataset direction

Linear is the only issue tracker. Record work, acceptance, ownership and test results in Linear. GitHub is for code and pull requests. Never create a GitHub issue or a mirrored backlog.

The model path is A-66 as amended by A-283 in [research/decisions.md](research/decisions.md). Every generation, repair, escalation, solver and reply call uses `claude-sonnet-5-5` unless config or `--model` names another Claude model with a known price, built in or in `prices`. Config and both transports refuse any other id before a call, and no transport falls back to a different model. `claude -p` under the logged-in Claude Code session is the default transport. The Anthropic SDK is opt-in with `--transport sdk` and reads its key from `LLM_KEY`. Never read `.env` and never read `ANTHROPIC_*` variables. Boat is the only product sandbox provider, and `BOAT_API_KEY` stays at the trusted controller boundary. Never upload or log a key. Engine grading stays deterministic.

The [dataset plan](research/boat-sonnet-dataset-plan.md) and the [test plan](eval/boat-sonnet-test-plan.md) define the Boat and dataset work. YOS-75 owns Boat, YOS-91 JSONL episodes and replies, and YOS-108 evidence. The master coordinates and merges.

This repo holds two tools for a work trial. The world engine checks, serves, enforces and grades worlds, which are stateful replicas of real software such as a helpdesk or a payments API. WorldGen is an LLM agent that turns a description, an OpenAPI spec or a CSV into a world the engine accepts.

The task is in [research/spec.md](research/spec.md). The reasons behind this structure are in [research/architecture.md](research/architecture.md). Read the spec once. Do not copy it into code comments.

Status on 2026-10-08, on stabilize/main: everything this file describes is built. The hand-in is tag v1.1.1. Its code is `71f84d45` (#149), green twice (37860510831, 37860513520), and the tag adds only docs and eval evidence over it. Tags never move (YOS-158); the hand-in message carries the tag, the SHA and both run links (YOS-216). The engine checks a world in all seven layers including lints, serves it with the admin port and `GET /openapi.json`, verifies, grades, writes docs, and compares a world with its source spec (`worldplay openapi`). WorldGen has the run loop, the `worldgen` CLI, the description, OpenAPI and CSV inputs, the iterate run (`--world`), the judge, the repair policy, the preservation gate and `REPORT.md`. Also built: the rehearsal runner, the live runner (`bun run live`, `scripts/live.sh`), the spend ledger (`bun run costs`), the OpenShell, sbx and Boat sandbox backends, the dataset export (`bun run dataset`), the Studio (`bun run studio`) with sign-in, jobs that run once, isolated check children and web hardening, its Docker deploy (`scripts/studio-deploy.sh`), its qualification (`scripts/studio-qualify.sh`) and its alert check (`bun run studio-watch`), the demos (`scripts/demo.sh`, `scripts/solve-demo.sh`, `scripts/demo-all.sh`) and the fresh-clone gate (`scripts/qualify-main.sh`). Bun is the only runtime and test runner, and CI runs no Node job (A-379). `prod/worlds/` holds 2 hand-built worlds (helpdesk and retail-tau2) and 23 generated ones. Every path this file names in backticks exists.

## How work lands

This is the workflow as of 2026-10-08. Linear and GitHub split the work, and one master session merges everything.

- **Linear tracks the work.** Team YOS, project WorldGen. An issue holds the acceptance, the owner, the status and the test results. Cite issues as YOS-n in branch names, PR text and decisions. Never open a GitHub issue. An issue moves to In Review when its PR merges. It moves to Done only after a promotion that contains the PR gets two green verdicts.
- **GitHub holds code and pull requests.** The repository is jop8281/worldgen, and its root commit is 733538fd. It is public, so never commit a secret, a key, a `.env` file or a log that holds one. The earlier repository, jop8281/zozo123-genworld, was deleted on 2026-10-07. Its history survives only as refs/archive/old-origin/* in the main clone (YOS-230), and its PR numbers no longer resolve.
- **One master.** The master is worldgen-f8, by the user's word on 2026-10-08. It alone merges into `stabilize/main` and promotes `main`. It assigns decision numbers for `research/decisions.md`, so parallel PRs do not collide. It announces freezes. During a freeze, only fixes it asks for may land, and other PRs open as drafts.
- **One job per session.** A session takes one job from the master, works in a fresh worktree under ~/wt/<job> cut from the latest `origin/stabilize/main`, and pushes a branch such as `dispatch/<job>`. It opens a PR to `stabilize/main` titled "Part of YOS-n: ..." and replies to the master with "PR #n <sha>". A PR title never carries a bare id or a closing word. Sessions never merge, and never push to `stabilize/main` or `main`.
- **Merge bar.** The master reviews the diff and the touched-test receipts. A high-blast-radius change also gets an independent verifier on another model before it merges. That covers auth and tenancy, Boat and spend, and anything that archives or deletes.
- **Batches and promotion.** The master may land several verified PRs in order. `research/decisions.md` merges with git's union driver, set in the main clone's .git/info/attributes. After each batch, a promotion PR moves `main`. Two pinned verdict runs check it, on `verdict/<sha8>` and `verdict/<sha8>-b`, both started by workflow_dispatch. A promotion is accepted when both are green.
- **The hand-in.** The hand-in is tag v1.1.1. Its code is `71f84d45` (#149), green twice (37860510831, 37860513520), and the tag adds only docs and eval evidence over it. Tags never move; the hand-in message carries the tag, the SHA and both run links (YOS-216, YOS-158). The earlier tags v1.1.0 on 6e28ba99 and v1.0-handin on 4b3d2be4 stay in place as history. Consolidation mode ended on 2026-10-08.
- **Rule 7, machine load.** Never run the full suite on the shared machine. Run only the test files that call what you changed, found by grep, under `nice -n 15` at concurrency 1 or 2. A bare `bun test` command passes `--timeout 120000`, as `bun run test` does. Bun's 5 s default fails slow CLI tests and leaves their signal handlers behind.

## The four top-level directories

| Dir | Put here | Never put here |
|---|---|---|
| `research/` | The spec, plans, `decisions.md`, `architecture.md`, domain notes. Markdown and JSON only. | Code or spikes. Nothing in `code/` reads it. |
| `code/` | The one npm package: engine, WorldGen, CLIs, tests. | Worlds, eval inputs, deliverables. |
| `eval/` | The rehearsal suite (`suite.yaml`), its inputs, and run output, which `bun run eval` writes under eval/runs on its first run. | Code, or worlds meant for submission. |
| `prod/` | What gets handed in: `design.md`, the generated `world-format.md`, the hand-built world, generated worlds, and scenarios in `prod/scenarios/`. | Drafts and rehearsal runs. Tests check every world here, so a broken world fails `bun run test`. |

`code/` reads `prod/worlds/*` by path, in tests and as the few-shot examples (`exampleWorld` in `code/worldgen.config.json`, one picked per input, A-390). It never imports from `research/`, `eval/` or `prod/`.

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
| `worldgen/input-coverage.ts` | Whether a world covers the original input: OpenAPI operations, the error template, CSV fixtures. `operationPlanIssues()` names each input OpenAPI operation the plan's routes leave out, so the plan step routes it before a stage meets it unowned (YOS-244). Pure. |
| `worldgen/llm.ts` | The model transports and cost: `claude -p` under the logged-in session by default, the SDK opt-in with `--transport sdk`. The only importer of `@anthropic-ai/sdk` and the only spawner of the claude CLI under `worldgen/`. |
| `worldgen/events.ts` | `RunEvent`, `StopReason` and the JSONL emitter. |
| `worldgen/report.ts` | `REPORT.md` from plan, verdicts, delta, events, the WID and each TID. No model. |
| `worldgen/openapi-report.ts` | The Markdown audit of an `openapiConformance` result for `worldplay openapi --profile` and `--report`. No model, no IO. |
| `worldgen/capsule.ts` | `capsule.json` beside `REPORT.md` on every exit: input digest and source (A-351), world id, model, transport, attempts, costs. No model, no file IO. |
| `worldgen/fidelity.ts` | Fidelity to a frozen reference of the real software: the reference schema, `fidelityScore()`, and `fidelityGate()`, the last step's 0.80 floor for a description that names a reference (A-258). Pure. |
| `worldgen/eval-outcomes.ts` | Offline eval analysis against an explicit expected case set, each case classed by `outcomeOf()` in `eval.ts`. No model, no file IO. |
| `worldgen/eval.ts` | The rehearsal suite schema, case sequencing, the `summary.md` scorecard and `fidelityScore()` against `eval/fidelity/*.yaml`. `outcomeOf()` is the one classifier of a case into the five outcome classes, for `summary.md` and `eval-outcomes.ts` alike (A-340), and the pass rate counts every expected case (A-341). No model, no file IO. |
| `worldgen/live.ts` | The live run: plans cases from the files in `prod/prompts/`, and renders the live-run table that `bun run live` writes as prod/LIVE-RUN.md, a file that exists only after the first live run. No model, no file IO. |
| `worldgen/config.ts` | Settings and defaults, parsed strictly. |
| `costs/basis.ts` | The schema for model cost estimate sources, shared by transports and ledger entries. |
| `costs/boat-receipts.ts` | Separate append-only Boat usage evidence, canonical snapshots by VM and requested UTC day, with inspection provenance and explicit list-price units. It never settles spend. |
| `costs/ledger.ts` | The append-only spend ledger, the USD caps and `guard()`. Keys never reach it, only fingerprints. |
| `costs/meter.ts` | Decorators that meter a model or a sandbox backend into the ledger and check the caps first. A model call is filed under the run and step its request names (`ProposeRequest.runId`, `.step`), so one model shared by many runs splits its spend by run (A-365). |
| `costs/pricing.ts` | Key fingerprints, ledger accounts, boat.dev sizes and rates. Model prices stay in config. |
| `boat/client.ts` | The boat.dev client behind the narrow `BoatClient` interface. The only importer of `@boatdev/sdk`. Reads `BOAT_API_KEY` and `BOAT_BASE_URL` from the process environment only, and keeps the key out of every error. `boatBaseUrl()` accepts only https on boat.dev itself, with no credentials, query or fragment, or loopback http with `WORLDGEN_BOAT_LOOPBACK=1`, and returns the parsed origin and path, so the key goes nowhere else. `boatKey()` refuses in a process started with `--env-file` or `--config`, or in a Bun process started outside `code/` without `--no-env-file` (A-350). |
| `dataset/*.ts` | YOS-91 episodes: `episode.ts` runs one solver episode, `solver.ts` turns an injected `Model` into turns, `pipeline.ts` runs one sandboxed dataset run (it checks and prepares the world through `checkInChild` and `prepareInChild`, and takes its grader as a required dep, so no world code runs in the controller, A-353), `local.ts` runs one episode on loopback for the studio's Agent Playground (the world is checked, served and graded in allowlisted children, A-347), `store.ts` and `schema.ts` own the JSONL export, and `verifier.ts` builds the verifier request and grades through `engineGrader` (in-process, the test seam) or `childGrader` (one `cli/verifier.ts` process per submission). An episode's `model` is null when its agent called none, as the noop agent does. Each solver call names its dataset or episode run and the step `solver`, so `costs --by run` files model spend beside the run's sandbox spend (A-365, YOS-251). |
| `sandboxes/backend.ts` | The `SandboxBackend` interface, the 2-CPU default size, the injected `Runner` and long-running `Spawner` (`nodeRunner`, `nodeSpawn`; a spawned child inherits this environment unless `env` replaces it), `isolatedEnv()` (the one allowlist for a child that runs a world's snippets), `listeningPorts()` (the ports `worldplay serve --port 0` reports), `processStartOf()` (what a pid started as, from /proc or `ps`, so the studio never adopts or signals a reused pid), and `upWorld()`. For a public sandbox `upWorld()` serves on `0.0.0.0`, exposes only the world port, and checks the exposed URL from outside (`reachWorld`). |
| `sandboxes/boat.ts` | The Boat backend, the only product sandbox: create a small VM, wait, upload, run, and stop with a verified archive. Takes a `BoatClient`. The VM runs only the pinned Bun that `upWorld()` installs (A-385). |
| `sandboxes/registry.ts` | `backendFor()`: a metered backend of one kind and size. Sandboxes the CLI leaves running are handed over through a record file. `upDetached()` uploads the public form of the world by default, built in the episode-prepare child (A-377); `private: true` uploads the private world. `discoverBoat()` inspects inventory; `trackBoat()` persists unresolved owner exposure; `captureBoatUsage()` saves separate UTC-day usage evidence. |
| `sandboxes/openshell.ts` | The NVIDIA OpenShell backend over the `openshell` CLI. |
| `sandboxes/sbx.ts` | The Docker Sandboxes backend over the `sbx` CLI. |
| `sandboxes/files.ts` | The bundle of code package plus one world, and its host workspace. `collectBundle` `publicOnly` uploads only `<worldDir>/public/world.yaml`, the public form of the world (YOS-159), so no grader, solution or decoy source reaches a sandbox. |
| `scenario/manifest.ts` | What a scenario is (J140): N existing worlds by alias, gates (per-world tasks) and gateway faults, and `loadScenario()`, which checks every world through `#engine` and reports every cross-check failure at once. |
| `scenario/gateway.ts` | `serveScenario()`: every world in process, the one gateway the agent gets (`/<alias>/<rest>`, the fault table, the boundary trace) and the operator's admin port (`GET /_scenario/trace`, `POST /_scenario/grade`, all-or-nothing verdict over the gates). Shell code. |
| `studio/analytics.ts` | Agent Playground analytics: exported episodes grouped by world, task and model, with success rate, failure causes and cost per success. Episodes that called no model group under `noop (no model)`. Pure. |
| `studio/page.ts` | The studio page: one offline operator app. Pure. |
| `studio/runstore.ts` | The studio's jobs on disk (`.studio-runs.json` in the worlds dir, finished jobs past 200 moved to the append-only `.studio-runs.archive.jsonl`, A-376): each generation run and agent episode with its idempotency key, request fingerprint, phase (intent, running, finished), lease and recovery, written whole through a temp file and a rename (A-329, A-335). An A-329 record still loads. `recoveryOf()` is the one lease rule (A-335): leave, resume or stop an unfinished job, for the studio and for reconcile-jobs alike. Process checks are injected. |
| `studio/reconcile.ts` | `reconcileJobs()` for `bun run studio -- reconcile-jobs` (A-355): unfinished jobs whose lease ran out and whose process is gone, by `recoveryOf()`, without starting a studio. A dry run reads only. `--apply` stops each as a studio would, re-reading the registry before each write, with an intent and an outcome receipt in `.studio-reconcile.jsonl` beside it. A job with a live lease or process is never touched. |
| `studio/explorer.ts` | The World Explorer's view of a checked world: wid, entities and references, each state field's machine, the seed's row and state counts (never row values), routes, jobs, and tasks as an agent is told them. Pure; no snippet or task source. Also `sensitiveOf`, `maskSensitive`, `bodyBelowAdmin` and `episodeBelowAdmin`, which mask a world's sensitive field values for any role below admin in the API console relay and in episode transcripts, and withhold them when the world cannot be read (A-356), with a refusal that names a sensitive field; and `runEventsBelowAdmin`, which withholds a generation run's issue text unless its saved world has no sensitive field (A-367). |
| `studio/server.ts` | The studio server: worlds, explorer, rollout, the API console, generation runs, eval and spend, and the Agent Playground (episode children, the engine proof. Stores OpenAPI and CSV uploads in the caller's tenant (`POST /api/uploads`, `GET /api/uploads`, `GET /api/uploads/:id/paths`) and generates from them, and serves a generated world's plan (`GET /api/worlds/:name/plan`: assumptions, open questions, out of scope and plan.md), refused like the report when it embeds task source (YOS-188). Owns sign-in: the roles each route needs (viewer, operator, admin), bearer-token checks, and the audit line every POST writes (A-322..A-325). Loopback unless users are configured. Records each generation and episode as an intent with its key and a lease before spawning it, so a retry or a crash never starts a second run (A-335). Sends security headers, limits each client per POST route, throttles failed sign-ins and caps unfinished jobs (A-339). Runs no world snippet itself: the Explorer check, the proof and a served world are children with an allowlisted environment (A-338, A-343). |
| `studio/uploads.ts` | Studio uploads (YOS-188): what an uploaded OpenAPI spec or CSV table must be (bare name and extension, at most 512 KiB of UTF-8, no NUL, a spec with a version string and a paths object, a CSV with a header), its id `<sha12>-<name>`, and its file `<shelf root>/.uploads/<sha12>/<name>`, keeping the original name the CSV adapter names a table from. Pure. |
| `studio/watch.ts` | Studio health signals (YOS-237): the traffic counter behind `GET /api/health` (answers since start and in the last 300 s, health polls not counted, bounded memory), the parts of `/api/health` and `/api/costs` the watcher reads, and `studioAlerts()`: `studio.down`, `studio.5xx_rate`, `spend.cap_share` and `spend.unchecked`. Unknown spend never reads as $0. Pure. |
| `cli/sandbox.ts` | Argument parsing for `bun run sandbox`: up (public world by default, which has no graders, so grading on the VM's admin port needs `--private`, which opts out with a warning), exec, down, discover, track, capture-usage, reconcile-create, reconcile-usage. No logic. |
| `cli/worldplay.ts` | Argument parsing for the engine CLI: check, serve, verify, grade, docs. No logic. |
| `cli/eval-analysis-files.ts` | Reads the current eval case paths for analysis, never hidden history as another case. |
| `cli/eval-retention.ts` | `withEvalAttempt`: a per-case lock, and the previous case run renamed into `.attempts` before a new one writes its path. |
| `cli/eval.ts` | File IO and wiring for `bun run eval`. No logic. |
| `cli/eval-args.ts` | `bun run eval`'s options: `parseEvalArgs`, its usage and refusals, and `evalConfig`, the one config and transport an eval run builds its model from. `--transport` is a config override, like `--model`, so the model, `run_started` and `capsule.json` agree (YOS-255). |
| `cli/costs.ts` | Argument parsing and printing for the spend CLI. |
| `cli/dataset.ts` | `bun run dataset`: argument parsing and wiring for one sequential dataset run. The work is in `dataset/pipeline.ts`. No logic. |
| `cli/verifier.ts` | The trusted verifier child process (YOS-159): spawned once per submission, it loads and checks the private world, verifies one protocol request, records the submission in the run's ledger, and prints one bounded verdict. No listener, no credential, no world or grader content on stderr. |
| `cli/studio-check.ts` | The Studio's check child (A-338): spawned once per Explorer request with an environment of only TZ, PATH and the guard scale, it loads and checks one world and prints the Explorer view as one JSON object. Exit 3 means the world does not load or check, with one authored line on stderr. |
| `cli/episode-prepare.ts` | The prepare child (A-347, A-353): spawned by `dataset/local.ts` once per episode and by `dataset/pipeline.ts` for a dataset run's check and prepare, with an environment of only TZ, PATH and the guard scale, it checks and freezes one world and prints the prepared world, without the CheckedWorld, as one JSON object. `--check <worldDir>` only checks and prints `{ tasks, source }`. Exit 3 means the world does not check, with the message on stderr. |
| `cli/live.ts` | `bun run live`: lists the prompts, runs WorldGen on each one at a time, checks and verifies, moves a verified world to `prod/worlds`, writes the table. The dry run prints each world's real destination, and the results file when it is not the default. |
| `cli/models.ts` | The shared wiring for CLIs: transport choice, metering into the ledger, the example worlds, and writing `REPORT.md`. |
| `cli/options.ts` | The options the model-calling CLIs repeat (YOS-203): `--model`, `--transport`, `--budget-usd` and `--max-minutes` read into config overrides, the rule for an option's value, `CONFIG_FILE` and `UsageError`. Parsing only; each CLI keeps its own walk over argv. `test/cli-options-golden.test.ts` pins every CLI's results and refusals. |
| `cli/episode.ts` | Argument parsing and wiring for `bun run episode`: one local agent episode for the studio's Agent Playground. The work is in `dataset/local.ts`. No logic. |
| `cli/scenario.ts` | Argument parsing and printing for `bun run scenario`: `check <dir>` and `serve <dir> [--port] [--admin-port]`. The work is in `scenario/manifest.ts` and `scenario/gateway.ts`. No logic. |
| `cli/studio.ts` | Argument parsing and wiring for `bun run studio`: the operator web app, and its users from `--users <file>` or `WORLDGEN_STUDIO_TOKEN`, and the `reconcile-jobs` subcommand. No logic. |
| `cli/studio-watch.ts` | Argument parsing, the two GETs and the exit status for `bun run studio-watch`: one check of a running Studio, OK lines and exit 0, or one `ALERT <code>: <why>` line per problem and exit 1. The token comes only from `WORLDGEN_STUDIO_TOKEN`, goes only to `GET /api/costs` as a bearer header, and is never printed. The rules are in `studio/watch.ts`. No logic. |
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
| A scenario agent reaches only the gateway: admin routes are 404 there, and grading happens on the scenario admin port. | `test/scenario.test.ts` asserts `/<alias>/_world/*` and `/_scenario/*` are 404 on the gateway port and that grade and trace answer only on the admin port. |
| Iteration is a diff. | Worlds change only through `WorldEdit`. `preservationIssues()` in `judge.ts` blocks unplanned destructive changes found by `diffWorlds()`. |
| Each section has one owning step. | `SECTION_OWNER satisfies Record<Section, ...>` in `stages.ts`. The plan step owns the acceptance tests, so a stage edit that touches `tests` is `edit.out_of_scope`, and `judgeEdit()` sends it back to the plan, which must raise its revision to change a test. On iterate, `iteratePlanSchema()` in `iterate.ts` lets a plan rewrite or drop an existing test only when `changes` names `tests.<id>`. |
| boat.dev is reached only through `BoatClient`, every Boat VM is made through `backendFor` and its spend meter, a world served there exposes only its world port, and `BOAT_API_KEY` comes from the process environment, never a .env file, and goes only to https on boat.dev. | `code/bunfig.toml` (`env = false`) stops Bun loading .env for every process started in `code/`, and `boatKey()` refuses in any other Bun process without `--no-env-file`, and in any process started with `--env-file` or `--config`. `test/boat-key-boundary.test.ts` fails when an off-boat.dev `BOAT_BASE_URL` gets a request or the key, when loopback works without `WORLDGEN_BOAT_LOOPBACK=1`, or when a .env canary reaches Bun. `test/architecture.test.ts` allows only `src/boat/client.ts` to import `@boatdev/sdk`, and only `src/sandboxes/registry.ts` to import the raw `boatBackend` factory, scanning `src/`, `code/scripts/` and the repo-root `scripts/`. `test/boat.test.ts` and `test/sandbox-registry.test.ts` use a fake `BoatClient`, assert that only the world port is exposed, and never read the key from the process. |
| Every stage, attempt, time and cost is logged. Model and budget are config. | The `RunEvent` union. `configSchema` is strict. The architecture test bans a `default:` branch without `assertNever` in switches over closed unions. |
| A Studio child that runs a world's snippets gets only an allowlisted environment, and the web process runs no snippet. | The Explorer check (`cli/studio-check.ts`), the proof and `worldplay serve` children get TZ, PATH and WORLDGEN_GUARD_SCALE only (A-338, A-343). `test/studio-isolation.test.ts` fails, in "builds both children from an allowlisted environment" and "gives a served world the allowlist and an episode the whole environment", when a key reaches one. |
| With users configured, every Studio route but the page and `GET /api/health` needs a bearer token of the right role, and the Studio answers only to its own names. | `test/studio-auth.test.ts`: "answers 401 with a challenge to a POST with no token or a wrong one, and spawns nothing", "lets a viewer read but not post or read the audit", "refuses a forged Origin on a POST and spawns nothing", "refuses a rebinding Host on a POST and on a GET" and "exits 1 with the refusal when bound to 0.0.0.0 with no sign-in". |
| A Studio job runs once: a retried POST, a double click or a crash never starts a second paid run. | The intent, key and lease in `studio/runstore.ts`, written before the child is spawned (A-335). `test/studio-jobs.test.ts` fails, in "answers a retried POST with the same Idempotency-Key from the first job, and refuses the key for another request" and "stops an intent whose start was never confirmed, and never starts it". |
| Every Studio answer carries the security headers; POST routes and failed sign-ins are rate-limited per client, and unfinished jobs are capped. | `SECURITY_HEADERS` and the token buckets in `studio/server.ts` (A-339). `test/studio-hardening.test.ts` fails, in "sends all four on the page, JSON, a 404 and a 401, and keeps the sign-in challenge", "limits each client and route, refills on the injected clock, and never draws for a GET", "throttles bearers after failed sign-ins, whether right or wrong, and not public routes or a missing bearer" and "refuses a second run past the cap, never a replay, and accepts one after the first finishes". |
| A public bundle carries no grader, solution, decoy or alternative source, and grading happens only in the trusted verifier, which holds the private world. | `engine/split.ts` (what is private), `check.ts` (`tasks.private_mixed`; the tasks layer accepts only an all-bare world as public), `sandboxes/files.ts` `publicOnly`, `engine/verify.ts` (the bounded verdict, the only answer a verifier gives), and `test/verifier-boundary.test.ts`, which scans the bundle, the public port, every verdict and the child's answers for private-source windows. |
| Every studio route states the role it needs, whose data it serves, and the gate on any row value or issue text it can carry, and no sensitive value reaches a role below admin. | `test/studio-route-policy.test.ts` reads every route from the router (`StudioServer.routes`) and fails on one its table does not name or names with another role. It runs each row against a real studio on a copy of the helpdesk as viewer, operator and admin of one tenant and an operator of another, and asserts each status and that no customer email from the world's seed reaches a role below admin (A-356, A-367, A-370). |

## Commands

Run these from `code/`, after one `bun install` on Bun 1.4. Bun is the package manager, script runner, test runner and runtime. Bun is the only runtime, by user order (A-379, A-381). There is no `package-lock.json`, no `tsx` and no Node test path, and a test starts its child processes with `process.execPath`, the Bun running it. The snippet heap bound that Bun ignores (A-87) is not enforced in CI. Sandboxes, the Boat VM included, run the pinned Bun too (A-385).

```sh
bun run typecheck                                    # whole package, then engine core without Node types
bun run test                                         # bun test runs the node:test files
bun run check                                        # the default gate: typecheck, then every test under Bun (A-134)
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
bun run sandbox --help                            # up <worldDir> --backend openshell|sbx|boat, exec <id>, down <id>; world port only.
                                                  # up uploads the public form, which has no graders: grading on the VM
                                                  # (POST /_world/grade/<task> on its admin port) needs --private.
bun run dataset --help                            # one graded solver episode per task in a Boat sandbox; needs BOAT_API_KEY.
                                                  # The sandbox serves the public bundle only; a separate verifier child process
                                                  # (cli/verifier.ts) grades each recorded trace against the private world.
bun run scenario check ../prod/scenarios/support-payments               # load a scenario: every world checked, gates and faults cross-checked
bun run scenario serve ../prod/scenarios/support-payments --port 4100   # N worlds behind one gateway on 4100; the operator's trace and grade on 4101
bun run studio [--port 8787] [--host 127.0.0.1] [--transport claude-cli|sdk] [--users <file>] [--origin <url>] [--worlds-dir <dir>] [--repo-root <dir>]   # the operator web app: worlds dashboard, rollout, generation runs, eval, spend and the Agent Playground; sign-in when users are given
bun run studio-watch -- <url> [--spend-share 0.8] [--max-5xx-rate 0.05] [--attempts 2]   # one check of a running Studio: OK lines and exit 0, or ALERT lines and exit 1; schedule it every 5 minutes
bun run studio -- reconcile-jobs [--tenant <t>] [--apply]  # Studio jobs whose lease ran out and whose process is gone; a dry run unless --apply
../scripts/studio-deploy.sh up                      # the Studio in Docker on 127.0.0.1:8787, signed in; also down, health, logs, backup and restore
../scripts/studio-qualify.sh http://127.0.0.1:8787  # health, sign-in and an export that unzips, on a running Studio
../scripts/live.sh --env-only                        # the live-run env check; drop --env-only and pass <slug> "<description>" to run

bun run worldgen "A helpdesk with SLA tiers and on-call escalation" --out ../prod/worlds/gen-<slug>
bun run worldgen --openapi <spec.yaml> --only /v1/refunds --out ../prod/worlds/gen-<slug>
bun run worldgen --csv <orders.csv> <customers.csv> --out ../prod/worlds/gen-<slug>
bun run worldgen "add refunds" --world ../prod/worlds/gen-<slug>   # iterate an existing world through preserved edits
```

The admin port serves `GET /_world/state`, `POST /_world/reset`, `GET /_world/log`, `GET /_world/openapi`, `POST /_world/clock` with `{"advance":"4h"}`, and `POST /_world/grade/<task>`. `serve` also prints the console URL, the self-contained operator page the admin port serves at `GET /`. The agent under test only gets the world port. `--model`, `--budget-usd` and `--max-minutes` override `worldgen.config.json`. The model runs through `claude -p` by default; `--transport sdk` reads the key from `LLM_KEY`. The spend ledger is the file in `WORLDGEN_COSTS_FILE`, default costs.jsonl under ~/.worldgen, capped by `WORLDGEN_MAX_DAILY_USD` and `WORLDGEN_MAX_TOTAL_USD` across both meters, and per meter by `WORLDGEN_MAX_DAILY_LLM_USD` and `WORLDGEN_MAX_DAILY_SANDBOX_USD`. Boat time without `BOAT_USD_PER_COMPUTE_HOUR` is recorded unpriced (usd null), never as $0.

The studio (`bun run studio`) is the operator's loopback web app: one offline page (`studio/page.ts`, no absolute URL, textContent only) over the `studio/server.ts` routes. It spawns `worldgen` and episode children through the injected `Spawner` (`nodeSpawn` in `sandboxes/backend.ts`), so no key is stored or logged, and it never imports `worldgen/llm.ts`. A generate or iterate child runs candidate-world snippets, so it gets only `GENERATION_ENV` in `studio/server.ts`. That holds what worldgen and the claude CLI read, plus `LLM_KEY` for `--transport sdk`, and never `BOAT_*` or `ANTHROPIC_*` (A-372). An episode child is the model caller and gets the whole environment (A-347). The studio bounds what it accepts and spends (A-375): request bodies are cut at once, names, budgets and run times have caps, served worlds are capped per tenant and in all, check and proof children share a pool of 4 with a 16-deep queue, and the audit log rotates at 64 MiB. The studio port carries no `/_world` route; a served world keeps its own world and admin ports. The Explorer's API console (`POST /api/services/:id/call`) forwards one request to the world port of a service the studio started and answers the world's real status and body. It refuses `/_world` paths and any other origin, so it never reaches an admin port (A-268). The one exception is reset (`POST /api/services/:id/reset`, A-357). The caller sends the world's name as `{"confirm": "<name>"}`, a guard against a mis-click on the page and no barrier to a client, since the 400 says what to send. The studio itself then sends that service's admin port `POST /_world/reset` and `GET /_world/state`, and answers only the time and the state hash, read after the reset and not atomically with it. A second reset of the same service while one runs is 409 `reset.busy`. With `--users <file>` or `WORLDGEN_STUDIO_TOKEN`, every route but the page and `GET /api/health` needs a bearer token: a viewer reads, an operator also runs every POST, and an admin also reads `GET /api/audit`, the log of every POST. The page holds the token per tab and never in a cookie, because a served world logs every request header. Without users the studio binds only loopback (A-322..A-325). The builder reads an OpenAPI spec or CSV tables from eval/inputs or from an upload: the page reads the file as text and posts it to `POST /api/uploads`, which stores it 0600 under the caller's tenant's `.uploads` dir, and an upload id resolves only there, so no tenant sees or generates from another's (YOS-188). Every walker of the worlds dir skips dot dirs, so `.uploads` is never a world, a run source or a shelf. The Explorer check (`cli/studio-check.ts`) and the proof run in a one-shot child, and a served world in a `worldplay serve` child, each with an allowlisted environment (TZ, PATH, WORLDGEN_GUARD_SCALE), so no snippet runs in the web process or beside its keys (A-338, A-343).

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
- Run receipts in CI's environment: `WORLDGEN_GUARD_SCALE=4`, which every job in `.github/workflows/check.yml` sets, for example `WORLDGEN_GUARD_SCALE=4 nice -n 15 bun test --timeout 120000 --max-concurrency 1 <files>`. Unset, the snippet guard is 2000 ms, as a developer machine keeps it (A-169). Set to 4, it is the guard CI tests against, and a child built from `process.env` carries it.
- A test that asserts a child's environment passes its own env source (`env` on `childGrader`, `runLocalEpisode`, `runPipeline` or `studioServer`) and never reads `process.env` into the expectation, so CI's variables cannot change it.

## Decisions and assumptions

- Log every design call as a row in `research/decisions.md`: decision, choice, why, date, reversible.
- Log spec ambiguities in the same table. Start the decision text with `Spec:`.
- An assumption WorldGen makes for one world goes in that world's `plan.yaml` under `assumptions` and in its `REPORT.md`. It does not go in `research/`.
- Never edit `prod/world-format.md` by hand. Never write a `world.yaml` except through `saveWorld()`.
