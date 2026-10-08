# Code structure for the engine and WorldGen

This page explains why `code/` looks the way it does. `AGENTS.md` is the operational summary. The type sketch under `code/src/` is the source of truth for shapes, and this page links to it rather than repeating it.

## Problem

We need two tools, each runnable with one command, built solo in 5 to 7 days. The first is a strict world engine that checks, serves, enforces, inspects, resets and grades worlds. The second is WorldGen, an LLM agent that turns a description, an OpenAPI spec or a CSV into a world. It plans first, repairs itself against engine feedback, stops with a reason when it cannot finish, and updates an existing world from a change request such as "add refunds".

Both tools orbit one artifact, the world format. Four readers consume it: engine validation, the model's tool schemas, check messages and docs. If they drift, every invariant leaks. Two forces pull against each other. Determinism and atomicity favor data the engine controls. Real workflow logic favors code. The time box punishes every layer that does not pay for itself.

The next contributor is a coding agent. It sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. So a rule that matters has to fail the build, and each kind of thing needs one exemplar to copy.

On this machine, Node 22 and npm 10 are installed. Python is system 3.9 with no uv. That rules out the Python 3.12, uv and SQLite stack in `research/plan.md` (its D-01). Its code-free logic (D-03 and D-04) lost in the arena. Most of its other product decisions still hold, and three of them are grafted below.

## Usage (caller's view)

A reviewer runs these from `code/`:

```sh
npm install
npm run worldplay -- check  ../prod/worlds/helpdesk
npm run worldplay -- verify ../prod/worlds/helpdesk      # each task: solution 1.000, noop 0.000, decoys below 1
npm run worldplay -- serve  ../prod/worlds/helpdesk --port 4000
curl 'localhost:4000/tickets?status=open&priority=urgent&limit=20'
curl -XPOST localhost:4001/_world/clock -d '{"advance":"4h"}'     # admin port, fires due jobs
npm run worldgen -- "A helpdesk with SLA tiers and on-call escalation" --out ../prod/worlds/gen-helpdesk
npm run worldgen -- "add refunds" --world ../prod/worlds/gen-helpdesk
```

A WorldGen run leaves `world.yaml` (only ever written from a `CheckedWorld`), `plan.yaml`, `REPORT.md` and `runs/<runId>/events.jsonl` plus one attempt dump per attempt.

A world excerpt, as the model or a human author sees it:

```yaml
entities:
  ticket:
    idPrefix: tkt
    fields:
      priority:   { type: enum, values: [low, normal, high, urgent], required: true }
      sla_due_at: { type: datetime, readonly: true }
      status:     { type: state, readonly: true, states: [open, escalated, resolved], initial: open,
                    transitions: { open: [escalated, resolved], escalated: [resolved], resolved: [open] } }
actions:
  escalate_ticket:
    method: POST
    path: "/tickets/{id}/escalate"
    input: { reason: { type: text, required: true } }
    handler: |
      (ctx) => {
        const t = ctx.db.get('ticket', ctx.params.id) ?? ctx.fail(404, 'not_found', 'ticket not found');
        return { status: 200, body: ctx.db.update('ticket', t.id, { status: 'escalated' }) };
      }
jobs:
  sla_breach:
    every: 15m
    run: |
      (ctx) => { for (const t of ctx.db.list('ticket', { where: { status: 'open' } }))
                   if (t.sla_due_at < ctx.now()) ctx.db.update('ticket', t.id, { status: 'escalated' }); }
tasks:
  escalate_breached_urgent:
    difficulty: medium
    instruction: Escalate every open urgent ticket whose SLA has already breached.
    grader: "(ctx) => { ... }"
    solution: "(ctx) => { ... pages through GET /tickets with ctx.api ... }"
    decoys:
      - { why: "escalates only the first page", script: "(ctx) => { ... }" }
```

One repair attempt in `worldgen/run.ts`:

```ts
const proposal = await deps.model.propose({ system, prompt, tool: { name: 'edit_world', description, inputSchema: editJsonSchema(writesOf(stage)) } });
const applied = applyEdit(world, proposal.input);                 // parse only
const issues = applied.ok
  ? blockingIssues(stage, checkWorld(applied.value.world), plan)   // the engine judges
  : applied.error;
const decision = decide(config, { step: stage, ledger, nowMs }, outcome(issues), issues.map((i) => ({ issue: i, owner: ownerOf(i) })));
```

An engine test:

```ts
const report = checkWorld(await mustLoad('../prod/worlds/helpdesk'));
assert.ok(report.ok);
const rt = createRuntime(report.world);
const before = rt.dump();
assert.equal(rt.call({ method: 'POST', path: '/tickets/tkt_0001/escalate', query: {}, body: {} }).status, 400);
assert.deepEqual(rt.dump(), before);   // a failed call leaves no partial change
```

## Shape

### Directory tree

```
worldgen/
  AGENTS.md  CLAUDE.md (@AGENTS.md)
  research/   spec.md  plan.md  architecture.md  decisions.md  research_notes/  (markdown and JSON only)
  code/
    package.json  tsconfig.json  tsconfig.engine-core.json  worldgen.config.json
    src/engine/    fields format ctx issues error-codes check store clock api tasks diff split openapi openapi-fidelity openapi-conformance provenance rules verify ui | sandbox http index (shell)
    src/worldgen/  run stages policy judge plan plan-md input input-coverage iterate llm events report openapi-report capsule config eval eval-outcomes fidelity live
    src/costs/     basis boat-receipts ledger meter pricing
    src/boat/      client
    src/sandboxes/ backend files openshell sbx boat registry
    src/dataset/   episode solver pipeline local store schema verifier
    src/studio/    page explorer analytics runstore server
    src/cli/       worldplay worldgen eval eval-analysis-files eval-retention costs sandbox dataset episode live models verifier studio-check episode-prepare studio
    src/lib/       never
    test/          architecture engine fields ctx sandbox worlds policy worldgen (*.test.ts)
  eval/        suite.yaml  inputs/  runs/<date>-<suite>/
  prod/        README.md  design.md  world-format.md (generated)  worlds/helpdesk/  worlds/gen-<slug>/
```

The runtime picture and who owns each concern at run time is in [runtime-architecture.md](runtime-architecture.md).

### Load-bearing decisions

1. **One YAML file per world, one zod schema.** `engine/format.ts` defines the world. Types (`z.output`), runtime validation, each stage's tool schema (`editJsonSchema`), check hints (`.describe()` text) and `prod/world-format.md` all derive from it. Per encode-lessons-in-structure, adding a section to `sections` makes the compiler ask for its owner in `SECTION_OWNER`.

2. **Only what must be code is code.** Entities, field types, refs, uniqueness, `readonly` and state machines are data, so the engine enforces them on every write. Action handlers, jobs, seed generators, graders and client scripts are JS snippets in a deterministic `node:vm` context. Models write JS well. There is no expression language to design, document and debug (per model-the-domain, the state machine is a structure and not scattered checks).

3. **Every section is a record keyed by name.** A world changes only through `WorldEdit`, which removes, upserts whole items and merge-patches single items. Generation is `edit(emptyWorld)`. Iteration is `edit(existing)`. That gives one code path, and `patch` means adding a `refunded` state does not restate the whole entity.

4. **Each concern has one record, and the compiler holds the records together.**
   - `FIELD_TYPES` holds every field type's schema, validator, comparator, query parser, CSV inference, doc and examples. Store, API and input code call into it and contain no type switch.
   - Ctx registries (`HANDLER_CTX` and the others) are typed `Registry<Ctx>`, so a member in the interface without a doc, or the reverse, fails to compile. The snippet docs are rendered from them.
   - `ISSUES` holds every code with severity, owner, expected text and hint. `IssueCode` is its key type.
   - `SECTION_OWNER` gives each section exactly one owning step: the model, workflow, seed and tasks stages, the plan step for `tests`, and the input loader for `fixtures`.
   - `INPUT_KINDS` gives each input kind a loader and a digester.

5. **The engine is the only judge, and the types say so.** Three brands each have one minter: `CheckedWorld` (`check.ts`), `CheckIssue` (`issues.ts`) and `TaskVerdict` (`tasks.ts`). `saveWorld`, `createRuntime` and `serve` accept only `CheckedWorld`. `REPORT.md` renders only `TaskVerdict`s. WorldGen's acceptance (`judge.ts`, `stages.ts` `done`, `policy.ts`) takes no `Model`. Model commentary, if any, goes to an `advice` event that acceptance never reads.

6. **The boundary is a compile boundary plus one test.** `package.json` maps `#engine` to `src/engine/index.ts`. `tsconfig.engine-core.json` compiles engine core with `types: []`, so `process`, `Buffer`, timers and `node:*` imports fail. Core reaches the vm only through the `SnippetHost` interface that `index.ts` passes in, which keeps `sandbox.ts` out of core. `lib: ES2023` still declares `Date` and `Math.random`, so `test/architecture.test.ts` resolves symbols with the TypeScript compiler API and bans them, along with forged brands, deep engine imports and `default:` branches without `assertNever`.

7. **Determinism is checked per world.** The sandbox starts from an empty global object plus an allowlist, and a test snapshots the globals the context exposes. Verdicts depend on a ctx call quota, not on wall time. The wall-clock guard only stops runaway code. `verifyTask` runs each solution twice from seed and compares state hashes. Time starts at `meta.clock.start`, moves one `tick` per committed call and by explicit advances, and jobs fire in (time, name) order.

8. **Atomicity comes from an immutable state and an overlay.** `transact()` runs a call against an overlay. Each write enforces the data model at once. Any throw discards the overlay. There is no SQLite, because its DDL would be a second copy of the data model.

9. **Graders prove they discriminate.** A task passes when the solution scores 1, doing nothing scores 0, and every decoy scores below 1. Medium and hard tasks need a model-written decoy. A decoy that makes no successful write, or ends in the noop or solution state, is `task.decoy_trivial`. The engine also replays every strict prefix of the solution's successful writes, and each must score below 1, so partial work never earns full marks. `ctx.changes()` gives graders a seed-to-end diff over every entity, tagged by origin, so collateral checks cover entities added later and ignore rows that jobs changed.

10. **The WorldGen loop is a table, a pure policy and one loop.** `STAGES` lists model, workflow, seed and tasks. `decide()` maps a ledger and an outcome to retry, advance, backtrack or stop, and an issue's owner picks the backtrack target. One `Ledger` carries cost, attempts, backtracks and seen issue sets, so `no_progress` and budget stops read one source. This avoids temporal decomposition, because no module per stage re-encodes the format.

11. **Iteration keeps what it does not mean to change.** `diffWorlds()` lists removed fields, states, transitions, idPrefix changes and removed items. `preservationIssues()` blocks each one that `edit.remove` and `plan.changes` do not name. Old tests and decoys rerun as regression checks. The plan step runs first on iterate and owns `tests`: a plan can rewrite or drop a test only when `changes` names it, and a stage edit that touches a test is out of scope. A stage reruns only if a section it owns or reads changed, so a route change does not regenerate the seed. On a stop, `world.yaml` is not touched.

12. **Inputs share one schema and never leak secrets.** `inputSchema` is parsed by the CLI and by `eval/suite.yaml`. Digest functions take only `Redacted<...>`, minted by `redact()`. Events and attempt dumps see only `InputDigest`. A digest can propose `meta.api` envelopes and `observations`, so OpenAPI worlds keep real list and error shapes.

### Interface depth

`#engine` exports about ten functions (`checkWorld`, `applyEdit`, `createRuntime`, `serve`, `loadWorld`, `saveWorld`, `diffWorlds`, `editJsonSchema`, `formatReference`, `issue`) plus schemas and types. Behind it sit YAML, zod-to-issue mapping, ref-ordered seeding, the sandbox, the overlay store, enforcement, routing, paging, the clock, jobs, verification and replay. WorldGen exposes `runWorldGen(job, config, deps)`. The `Model` interface has three implementations: the claude CLI, the Anthropic SDK and the scripted fake. `SnippetHost` has one production implementation and exists to keep engine core free of Node types.

### What the system does not do

No auth, multi-tenancy or concurrency. No persistence across restarts. No security sandbox, since `vm` is for determinism. No per-task start state. No model-written report prose beyond the plan's assumptions. No model-scored quality.

## Private task boundary

Private: every task's `grader`, `solution`, decoys (`script` and `why`) and alternatives. The instruction is public; the agent is told it. Public: everything outside `tasks`, including the world's own `tests`, which are acceptance scenarios the author wrote.

The world port serves the world's routes and actions and `GET /openapi.json`. `openApiOf()` never reads `tasks`. `/_world/*` on the world port is an ordinary 404 in the world's error envelope. Handler ctx (`HANDLER_CTX`) has no member that reaches `world.tasks`, and `test/private-boundary.test.ts` runs a handler that walks `ctx` and `globalThis` for task material and finds none.

Only the admin port serves `state`, `log`, `reset`, `clock` and `grade/<task>`. `grade` and the unknown-task error (which lists task names) live there.

The loopback studio (`src/studio/`) is operator-only: its page holds no absolute URL and fetches same-origin, its routes never serve `world.yaml` task source (a REPORT.md that embeds any is refused), and `test/studio.test.ts` proves both with canaries. The explorer route shows a world's definition with tasks as an agent is told them, and the API console reaches a served world's world port only, never its admin port (A-268).

Enforced by `code/test/private-boundary.test.ts`. For every directory under `prod/worlds/` it puts a unique canary in each grader, solution, decoy script and decoy why, collects 40-character windows of the original private source that the world does not legitimately serve, serves the world, and probes only the world port: OpenAPI, valid and unknown-id calls for every operation, malformed JSON, wrong types, unknown paths and methods, admin paths and their encodings, task-like paths, HEAD and OPTIONS. It scans the status line, every header and the body. Admin probes on the world port must not reset state or move the clock. A positive control grades through the admin port, and a self-check proves the scanner reports a planted canary.

### The public bundle and the verifier process (YOS-159)

The world a public deployment serves never holds the private material, and the process that grades never serves the public API. `engine/split.ts` (`publicWorldOf`) produces the public form of a checked world: every task keeps its id, difficulty and instruction and drops its grader, solution, decoys and alternatives, and every other section is untouched, so the public form checks as a world, serves the same OpenAPI and seeds the same rows. A world that mixes complete and bare tasks is refused (`tasks.private_mixed`), so a "public" bundle can never carry half-private source, and grading or verifying a bare task is refused (`task.instruction_only`). `dataset/pipeline.ts` (`prepareWorld`) freezes both forms under `private/worlds/<sha>/`: the full private world at `world.yaml`, the public form at `public/world.yaml`, both written through `saveWorld`, so each is a world the engine checked. `collectBundle` `publicOnly` uploads the public form alone, so an agent with a shell in the sandbox reads no grader source. The WID (`worldIdOf` of the full world) binds the public bundle to the private one by identity, never by content.

Grading happens in the trusted verifier. `engine/verify.ts` (`verifySubmission`) takes one protocol message per episode — the submission id, the task id, the WID, the world version, the engine revision, the ordered trace with its deterministic hash chain, and the final state snapshot — replays the trace from seed through the same `handle()` path HTTP uses, requires the replay to reach exactly that snapshot (clock included), and grades through `gradeDump` with the replay's own journal and log. The only answer is the bounded verdict `{task, wid, score, stop}`: `graded`, or a literal rejection (`request.too_large`, `request.invalid`, `trace.chain`, `world.mismatch`, `engine.mismatch`, `trace.replayed`, `task.unknown`, `trace.mismatch`, `grade.failed`), so no grader source can leave through an error string, a log line or a rejected request's echo. A request that parsed consumed its submission id, recorded in the run's ledger, so a trace cannot be graded twice. In `bun run dataset` the verifier is `cli/verifier.ts`: a separate host process per submission, with the private world by path, no listener, an environment of only `TZ` and `PATH` (no controller credential), and stderr lines that are authored one-liners only. `dataset/verifier.ts` also offers `engineGrader`, the same protocol verified in-process through `#engine`, as the offline and test path.

Enforced by `code/test/verifier-boundary.test.ts`: the public form and the uploaded bundle scanned for private-source windows; a trace recorded over the public world's own port grades against the private world; every rejection a literal stop; the replay ledger; the child's verdict line, exit codes and clean spawn environment; `/_world/*` on the world port inert; no verifier route on the admin port; a crashed or overrunning verifier a failed grade with an authored reason.

What this is and is not (A-224): the split, the protocol, the public-only bundle and the separate verifier process are built and enforced as above. Not claimed: OS-level isolation. The verifier child is a separate host process under the same OS user; a container, a separate VM or a separate OS user, with the filesystem and network policy that comes with it, is the separately qualified untrusted-execution follow-up. Port separation alone does not prove process isolation, and `node:vm` and worker threads remain for determinism, not security. Also not claimed: `bun run sandbox up` uploads the full world directory — a trusted-machine demo tool (`scripts/solve-demo.sh` grades on the sandbox's admin port); the dataset pipeline is the deployment path and uploads the public form only. And review must still catch private text a world author copies into public descriptions, seed data or handler messages: the tests exclude text the world legitimately serves, so they cannot flag it.

## Synthesis decision

Three candidates ran. A cross-judge scored them on six rubric criteria, R1 to R6, and a stress test walked six concrete changes through the base.

| Candidate | R1 | R2 | R3 | R4 | R5 | R6 |
|---|---|---|---|---|---|---|
| format-centric (declarative DSL, four packages) | 9 | 8 | 8 | 5 | 6 | 4 |
| code-worlds (worlds as TS modules, kernel in a vm realm) | 7 | 6 | 5 | 6 | 9 | 3 |
| minimal-flat (one package, YAML plus JS snippets) | 7 | 7 | 9 | 8 | 7 | 9 |

**Base: minimal-flat.** It scores best on R3, R4 and R6 and stays competitive elsewhere. An agent finds anything in three files or fewer. Generation and iteration are one code path. The model writes JS inside a schema-derived `WorldEdit`. Its weaknesses were each fixable in place. The other two candidates' weaknesses were their shape. All three converged on TypeScript on Node 22 with zod as the single schema, which we take as agreement.

**Grafted from format-centric:**
- The engine-core compile boundary (`tsconfig.engine-core.json`) and the `#engine` import map, replacing the regex boundary.
- The issue catalog with owners, minting through `issue()`, optional spans, and the quality lints.
- One ctx registry per snippet kind, so docs and types cannot drift.
- Determinism replay per task, and per-world `meta.api` envelopes.

**Grafted from code-worlds:**
- The `jobs` section for time-driven logic such as SLA breach.
- Decoys per task, and the `TaskVerdict` brand.
- Leaving the old world in place when a change run stops.

**From the stress test:** `FIELD_TYPES` with a conformance test, `ctx.changes()`, `now()` as a function everywhere, the sandbox global allowlist with a snapshot test, the call quota, `action.unexercised`, the symbol-resolving architecture rule, `judge.ts` without a model and the `advice` event, anti-trivial decoys, the iterate preservation gate with `patch` and `WorldDelta`, single section ownership, the pure `decide()` with one ledger, strict per-step config, and the shared input union with `Redacted`.

**Grafted from `research/plan.md`:**
- Admin routes on a separate port (its D-09). The agent under test cannot reset, inspect or move the clock.
- Change origin tags (its D-07). `ctx.changes()` skips job changes by default, so a job that fires during a run cannot zero a correct solution.
- Engine-built mutants (its D-14), reduced to solution prefixes. Its "no model-written decoys" rule is relaxed. Decoys are test inputs that the engine runs and scores, never verdicts.

**Changes versus the judge:**
- Custom routes moved from `routes` into their own `actions` section. Single ownership needs it. The model stage owns `entities` and `routes`, the workflow stage owns `actions` and `jobs`, and the plan step owns `tests`. The judge asked only to remove the overlap.
- Engine core also excludes `sandbox.ts`, and reaches it through `SnippetHost`. The judge's graft excluded only `index.ts` and `http.ts`, which would not compile because `sandbox.ts` imports `node:vm`.
- "Restore the pre-run snapshot" became "never write until checked". The base already never writes `world.yaml` on a stop, so `run_finished.worldWritten` records it.
- WorldGen-side codes (`plan.*`, `edit.*`, `iterate.*`) live in the same catalog, so worldgen mints issues through `issue()` too.
- TypeScript is pinned to 6.0, because the architecture and ctx tests use the JS compiler API.

**Rejected:**
- format-centric's expression language and "no code in worlds". About 800 lines of parser and type checker, and a live unseen prompt can hit the ceiling and stop as blocked.
- format-centric's four workspace packages and dependency-cruiser. The tsconfig and import map give the boundary for less plumbing.
- format-centric's split `parseWorld` and `prove`. One `checkWorld` mints the brand, so serve and WorldGen share one judge.
- code-worlds' TS-source worlds, kernel-in-realm, faker per realm and free-form file tools. Too many moving parts for the time box, and file edits are weaker than a typed `WorldEdit`.
- code-worlds' exception that lets seed write machine-owned fields. Seed rows pass explicit state values, validated as states.
- minimal-flat's overlapping stage writes.

## Tradeoffs accepted

- We accept untyped JS strings in YAML in exchange for one self-contained, diffable world file a model can write. Compile, tests, verification and replay stand in for a type checker.
- We accept `node:vm` not being a security boundary in exchange for no native dependencies and errors in the model's own language.
- We accept a `SnippetHost` parameter on core functions in exchange for an engine core that compiles without Node types.
- We accept a package boundary built from a tsconfig, an import map and a test, instead of separate packages, in exchange for one `npm install` and no build order.
- We accept hand-written `sig` strings in the ctx registries, checked by `test/ctx.test.ts`, in exchange for docs a model reads easily.
- We accept WorldGen codes in the engine's issue catalog in exchange for one minter and one place to look up any code.
- We accept extra model round trips from the iterate gate and required decoys in exchange for iteration that preserves meaning and graders that discriminate.
- We accept twice the verification cost from replay in exchange for determinism shown per world rather than assumed.
- We accept that every task starts from seed in exchange for a smaller format. Time-dependent tasks rely on the seed's start time.
- We accept in-memory state with no persistence in exchange for trivial atomicity, dump and reset.
- We accept that `prod/worlds/*` are test fixtures. A deliverable cannot rot, and a broken generated world breaks `npm test` on purpose.

## Alternatives considered

- **A declarative format with a typed expression language.** Fully checkable, with no sandbox. It hides little. Authors and the model must learn a new language whose limits appear at the workflow logic the spec asks for, and every gap becomes a language feature.
- **Worlds as TypeScript modules run in a realm.** Most expressive and typed for hand authors. Functions cannot be structured tool output or a keyed diff, and checking needs a bundler, the TS program and source maps on every repair attempt.
- **A SQLite store with each world compiled to DDL.** Real transactions, but the data model would exist twice, and enforcement would split between SQL constraints and JS.
- **One module per WorldGen stage.** Temporal decomposition. Each module would re-encode the format and its own repair loop, and acceptance rules would drift apart.

## Open questions and risks

- Do tasks need a per-task start, such as a clock offset or extra rows, or is "every task starts from seed" faithful enough for SLA tasks?
- Is a 1-second tick per committed call right, or should time move only through the admin clock?
- Should `input.ts` take `@apidevtools/json-schema-ref-parser` for OpenAPI `$ref` and `allOf`, or do we risk a day writing it?
- Does a CPU-only loop with no ctx calls make the wall-clock guard fire on a slow reviewer machine? If so, should we add a loop counter by source transform?
- Can a model satisfy decoy rules with decoys that are distinct but still easy? Should the eval suite track decoy scores?
- Should observed request and response pairs from OpenAPI examples become tests automatically, or only feed the plan?
- Should final live-run worlds land in `prod/worlds/` and rehearsals in `eval/runs/`? This design assumes yes.
- When does TypeScript 7 expose a stable JS compiler API, so we can drop the 6.0 pin?

## Next implementation step

Hand-write `prod/worlds/helpdesk/world.yaml` against `format.ts`, then implement the schema and references layers of `check.ts` until `npm run worldplay -- check ../prod/worlds/helpdesk` first reports precise issues and then reports `ok`.
