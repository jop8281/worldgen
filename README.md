# WorldGen

Two tools for building **worlds**. A world is a stateful, deterministic replica of real software, such as a helpdesk or a payments API, that an agent can be tested against.

- **worldplay** is the world engine. It checks a world, serves it over HTTP, enforces its data model and workflows on every write, and grades a task from the final state.
- **worldgen** is an LLM agent. It turns a description, an OpenAPI spec or a CSV into a world that worldplay accepts. The engine is the only judge. WorldGen never edits the engine and never grades with a model.

The task is in [research/spec.md](research/spec.md). [prod/README.md](prod/README.md) maps every spec item to the file that implements it and the command that shows it. The design doc is [prod/design.md](prod/design.md).

**[How the system fits together, with diagrams and the commands to run it](prod/system.md).**

## How it works

- **One artifact.** A world is one checked `world.yaml`: data model, API, workflow logic, seed data and tasks. [prod/world-format.md](prod/world-format.md) documents every section.
- **The engine is strict.** It checks a world in seven layers, from schema to lints, with errors a model can fix. It refuses any write that breaks the data model, and a failed call changes nothing. Time is engine time, never the wall clock.
- **Graders must discriminate.** A task counts only when its reference solution scores 1, doing nothing scores 0, and every decoy scores below 1.
- **WorldGen builds in stages.** It plans first, then models the data and API, the workflow, the seed and the tasks, checking after each stage. The engine's issues drive bounded repair. A run that cannot pass stops and writes why, and never hands over a broken world.
- **Iteration is a diff.** `--world` reruns only the stages a change request reaches, behind a gate that blocks unplanned destructive changes.

## Run it

You need Bun 1.4.2 (`npm i -g bun@1.4.2`). WorldGen also needs the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), logged in. Commands run from `code/`.

```sh
cd code && bun install --frozen-lockfile

bun run worldplay serve ../prod/worlds/helpdesk --port 4000    # the world's API on 4000, admin routes on 4001
bun run worldplay verify ../prod/worlds/helpdesk                # per task: solution 1, no-op 0, decoys below 1

bun run worldgen "an IT asset tracker with laptops, assignments, repair tickets and a quarterly audit"
bun run worldgen --openapi <spec.yaml> --only /v1/refunds       # follow part of an OpenAPI spec
bun run worldgen --csv <orders.csv> <customers.csv>              # infer the model from sample data
bun run worldgen "add refunds" --world ../prod/worlds/gen-<slug> # change an existing world

bun run live ../prod/prompts                                     # every prompt in prod/prompts, one at a time
```

- The agent under test gets only the world port, with `GET /openapi.json`. The admin port serves `GET /_world/state`, `POST /_world/reset`, `GET /_world/log`, `POST /_world/clock` and `POST /_world/grade/<task>`.
- A WorldGen run writes `world.yaml`, `plan.yaml`, `plan.md`, `REPORT.md` and `runs/<runId>/events.jsonl`, which logs every stage, repair attempt, duration and model cost.
- Model and budget are settings. The default is `claude-sonnet-5-5` through `claude -p`, at $5 and 15 minutes per run. `--model` takes any Claude model with a known price, and `--budget-usd` and `--max-minutes` change the limits. No call falls back to another model. `--transport sdk` uses the Anthropic SDK with the key in `LLM_KEY`.
- `scripts/demo-all.sh` runs the whole system in 25 PASS-or-FAIL steps, with no model call, in about a minute. `bun run studio` opens a local operator web app at http://127.0.0.1:8787.

## Status of main

`main` is `6e28ba99`, promotion 13 ([#135](https://github.com/jop8281/worldgen/pull/135)), and `stabilize/main` is the same commit. Its verdict runs are green twice: [37767399613](https://github.com/jop8281/worldgen/actions/runs/37767399613) and [37767403670](https://github.com/jop8281/worldgen/actions/runs/37767403670). CI runs Bun only, with the full test suite and the end-to-end check ([#124](https://github.com/jop8281/worldgen/pull/124), [#134](https://github.com/jop8281/worldgen/pull/134); A-379, A-381). Each row links the PRs in this repository that built it. [research/readme-reference.md](research/readme-reference.md#status) keeps the table of what was built before this repository's snapshot.

| What | Where | PRs |
|---|---|---|
| Studio World Builder: upload an OpenAPI spec or CSV files to build from, and read a world's plan: its assumptions, open questions and what it leaves out | `code/src/studio/uploads.ts`, `code/src/studio/page.ts` | [#79](https://github.com/jop8281/worldgen/pull/79) |
| Iterate a world from the browser on the tenant's own copy, published only when the run ends done | `code/src/studio/server.ts`, `code/src/cli/worldgen.ts` | [#77](https://github.com/jop8281/worldgen/pull/77) |
| Explorer: reset a served world only after its name is typed, and show its workflows and seed counts | `code/src/studio/explorer.ts`, `code/src/studio/server.ts` | [#70](https://github.com/jop8281/worldgen/pull/70), [#81](https://github.com/jop8281/worldgen/pull/81) |
| Recorded browser E2E: helpdesk and gen-billing-dunning under an operator, a viewer and another tenant, 27 frames and a step log with each state hash; the signed-in rehearsal, 17 steps | `code/scripts/studio-e2e.ts`, `code/scripts/studio-rehearse.ts`, `prod/screenshots/` | [#80](https://github.com/jop8281/worldgen/pull/80), [#68](https://github.com/jop8281/worldgen/pull/68) |
| Studio shutdown: SIGTERM or SIGINT stops every served world and check before exit; `reconcile-jobs` stops jobs whose owner is gone | `code/src/cli/studio.ts`, `code/src/studio/reconcile.ts` | [#75](https://github.com/jop8281/worldgen/pull/75), [#64](https://github.com/jop8281/worldgen/pull/64), [#74](https://github.com/jop8281/worldgen/pull/74) |
| The page resumes its view after a refresh, and every control has a label | `code/src/studio/page.ts`, `code/scripts/studio-a11y-probe.ts` | [#69](https://github.com/jop8281/worldgen/pull/69) |
| Dataset controller: check, prepare and grading run in child processes, which do not get the controller's keys | `code/src/dataset/pipeline.ts`, `code/src/cli/episode-prepare.ts` | [#67](https://github.com/jop8281/worldgen/pull/67), [#76](https://github.com/jop8281/worldgen/pull/76) |
| Sensitive fields: below admin, a `sensitive: true` field reads `[sensitive]` in the API console and in episode transcripts, and a sensitive world's run issue text, report and plan are withheld. A world the studio cannot read fails closed | `code/src/engine/fields.ts`, `code/src/studio/explorer.ts`, `code/src/studio/server.ts` | [#78](https://github.com/jop8281/worldgen/pull/78), [#89](https://github.com/jop8281/worldgen/pull/89), [#93](https://github.com/jop8281/worldgen/pull/93) |
| An episode or proof an admin starts with `?tenant=` belongs to that tenant, as serve and iterate already did | `code/src/studio/server.ts` | [#88](https://github.com/jop8281/worldgen/pull/88) |
| Studio limits: 1 MiB request bodies (3,149,824 B for uploads), 8 served worlds per tenant and 32 in all, 4 checks or proofs at once with 16 queued, 200 worlds per shelf, 500 episode folders, and finished jobs archived past 200. A full shelf or episode folder refuses new work instead of deleting, and the audit log rotates at 64 MiB, keeping two files at most | `code/src/studio/server.ts`, `code/src/studio/runstore.ts` | [#108](https://github.com/jop8281/worldgen/pull/108), [#109](https://github.com/jop8281/worldgen/pull/109) |
| Only an admin exports a world, or sees task source in run events and in a child's failure output. `sandbox up` uploads the public world, so grading on the VM needs `--private` | `code/src/studio/server.ts`, `code/src/studio/explorer.ts`, `code/src/sandboxes/registry.ts`, `code/src/sandboxes/files.ts`, `code/src/cli/sandbox.ts` | [#107](https://github.com/jop8281/worldgen/pull/107), [#112](https://github.com/jop8281/worldgen/pull/112), [#114](https://github.com/jop8281/worldgen/pull/114) |
| Panels say what failed and what to do, the page fits a 400 px screen, past runs show what their own events logged, and a refused reset says what to type | `code/src/studio/page.ts`, `code/src/studio/server.ts` | [#106](https://github.com/jop8281/worldgen/pull/106), [#110](https://github.com/jop8281/worldgen/pull/110) |
| Repair: a retry builds on the step's best full attempt and sees the earlier ones; a seed that misses one field twice, the second time on its type, goes back to the model step; a create's seed must cover what the planned tasks need; a plan owes a stateMix only for an entity with a state field | `code/src/worldgen/run.ts`, `code/src/worldgen/policy.ts`, `code/src/worldgen/judge.ts`, `code/src/worldgen/plan.ts` | [#92](https://github.com/jop8281/worldgen/pull/92), [#94](https://github.com/jop8281/worldgen/pull/94), [#97](https://github.com/jop8281/worldgen/pull/97), [#98](https://github.com/jop8281/worldgen/pull/98) |
| The spend ledger files each WorldGen model call and each solver call under its run and step, so `costs --by run` attributes new spend to its run | `code/src/costs/meter.ts`, `code/src/cli/models.ts`, `code/src/dataset/solver.ts` | [#82](https://github.com/jop8281/worldgen/pull/82), [#87](https://github.com/jop8281/worldgen/pull/87) |
| Linux runs no longer fail with `spawn E2BIG`: the `claude -p` transport passes the system prompt, about 130 KB, as a private temp file instead of an argument, and refuses any argument of 128 KiB or more before spawning | `code/src/worldgen/llm.ts` | [#117](https://github.com/jop8281/worldgen/pull/117) |
| stress-4, 23 of 29 (see [Results](#the-full-suite)), and two fixes for defects it found: a `?limit=` lookup is not paging, and a frozen test that throws goes to the workflow step first | `eval/runs/2026-10-08-stress-4/`, `code/src/engine/tasks.ts`, `code/src/worldgen/stages.ts` | [#71](https://github.com/jop8281/worldgen/pull/71), [#73](https://github.com/jop8281/worldgen/pull/73) |
| OpenAPI `--only`: the plan must name every input operation. The `--only /store` live run on main `e034036c` ended done in 248 s for $0.82, with 3 verified tasks, and `worldplay check` and `verify` exit 0 | `code/src/worldgen/input-coverage.ts`, `code/src/worldgen/stages.ts` | [#45](https://github.com/jop8281/worldgen/pull/45) |

## Results

### On this repository

One `bun run worldgen` on the spec's own example description, "an IT asset tracker with laptops, assignments, repair tickets and a quarterly audit". It ran on `8ce44508`, with the default model and budget. The hand-in commit adds only a studio shutdown fix, test fixes and this README, nothing on the generation path. Its source is [eval/runs/2026-10-08-handin-smoke/](eval/runs/2026-10-08-handin-smoke/).

| Measure | Result |
|---|---|
| Outcome | done, with 3 verified tasks: easy, medium and hard |
| Time | 473.3 s |
| Cost | $1.45, a client-side estimate |
| `worldplay verify` | solution 1.000 and no-op 0.000 on each task, every decoy below 1 |

### The full suite

stress-4 ran the 29-case `stress` suite once on main `4b3d2be4`, at $3 and 12 minutes per run. Its source is [eval/runs/2026-10-08-stress-4/summary.md](eval/runs/2026-10-08-stress-4/summary.md).

| Measure | stress-4 |
|---|---|
| Cases that ended as expected | 23 of 29 (79%): 20 succeeded, and 3 impossible inputs were refused as expected |
| Product failures | 6, each with a root cause and an issue |
| Time per run, over 31 runs | p50 5.1 min, p95 10.3 min, max 11.5 min |
| Spend | $26.71 settled, plus one cancelled call whose final billing is unknown |

stress-5 reran the six stress-4 product failures on `acb23bbb` and `d761c213` ([#91](https://github.com/jop8281/worldgen/pull/91)): 5 of 6 now pass, and all 6 got past the step where they had stopped. The 7 runs, 6 creates and 1 change, took 29.9 min summed and $6.96. stripe-customers stopped at the tasks step on a new defect, YOS-253, which [#97](https://github.com/jop8281/worldgen/pull/97) fixes. Its source is [eval/runs/2026-10-08-stress-5/summary.md](eval/runs/2026-10-08-stress-5/summary.md).

stress-6 reran the whole 29-case suite on `42ab9ca9` with the same settings ([#129](https://github.com/jop8281/worldgen/pull/129)): 27 of 29 (93%), 24 succeeded and 3 impossible inputs were refused. Per case, p50 was 4.5 min, p95 8.2 min and the max 8.8 min, and the suite cost $25.32. stripe-customers now finishes. The two stops, bookmarks and stripe-charges, are tracked as YOS-257 and YOS-258. Its source is [eval/runs/2026-10-08-stress-6/summary.md](eval/runs/2026-10-08-stress-6/summary.md).

### The live-run dress rehearsal

On main `e034036c`, `bun run live` ran three stand-in prompts: a description, an OpenAPI spec with `--only /pet`, and two CSV files. All 3 were delivered in 13.2 minutes for $3.55, a client-side estimate. Each world passed `worldplay check`, and every task scored 1 for the reference and 0 for doing nothing. The receipt is on [YOS-100](https://linear.app/yossi-zozo123/issue/YOS-100).

## Worlds

`prod/worlds/` holds 25 worlds and 95 tasks. Two were built by hand: [helpdesk](prod/worlds/helpdesk/) and [retail-tau2](prod/worlds/retail-tau2/), the second mapped from τ²-bench retail. WorldGen generated the other 23, `prod/worlds/gen-*`: 11 from a description, 4 from an OpenAPI spec, 6 from CSVs and 2 from iterate runs. Each one carries its `plan.yaml` and `REPORT.md`. `bun run test` checks and verifies every world.

## Studio screenshots

Taken from the real app with no model call: the dashboard and the episode on `2c36e0da`, signed in as an admin, and the other four on `b2b980f9`. [prod/screenshots/README.md](prod/screenshots/README.md) gives the command, viewport, runtime and digest of each one. It also records the browser E2E's 27 frames, in [prod/screenshots/e2e/](prod/screenshots/e2e/).

| | |
|---|---|
| ![The Worlds dashboard](prod/screenshots/01-dashboard.png) Signed in as `ada (admin)`, the Worlds table lists 25 worlds with kind, tasks, wid, model and cost. | ![An API call on the world port](prod/screenshots/04-console-get.png) A real GET on helpdesk's world port, answered 200. |
| ![A refused write](prod/screenshots/05-console-illegal-write.png) An illegal status move, refused whole with 422 `state.transition`. | ![A generated world's report](prod/screenshots/07-report.png) `REPORT.md` of gen-library-loans, built from two CSV files. |
| ![The engine proof](prod/screenshots/10-proof.png) The engine proof scores each reference 1, doing nothing 0, and decoys below 1. | ![A noop agent episode](prod/screenshots/11-noop-episode.png) A free noop agent episode, scored 0 from its end state and filed under `noop (no model)`. |

## More

- [research/readme-reference.md](research/readme-reference.md) holds the longer reference this README used to carry: every world with its task scores, the engine and Docker details, other CLIs, checks and costs, Boat recovery, and the historical PR table.
- `bun run check` is the gate: typecheck, then every test, with no real model call.
- [research/architecture.md](research/architecture.md) gives the reasoning, [research/decisions.md](research/decisions.md) logs every design call, and [AGENTS.md](AGENTS.md) holds the working rules.
- Work is tracked in the [WorldGen Linear project](https://linear.app/yossi-zozo123/project/worldgen-f83badd4a2c7).
