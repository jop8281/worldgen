# WorldGen

Two tools for building **worlds**. A world is a stateful, deterministic replica of real software, such as a helpdesk or a payments API, that an agent can be tested against.

- **worldplay** is the world engine. It checks a world, serves it over HTTP, enforces its data model and workflows on every write, and grades a task from the final state.
- **worldgen** is an LLM agent. It turns a description, an OpenAPI spec or a CSV into a world that worldplay accepts. The engine is the only judge. WorldGen never edits the engine and never grades with a model.

The task is in [research/spec.md](research/spec.md). [prod/README.md](prod/README.md) maps every spec item to the file that implements it and the command that shows it. The design doc is [prod/design.md](prod/design.md), and [prod/system.md](prod/system.md) shows how the parts fit together, with diagrams.

[prod/evidence/README.md](prod/evidence/README.md) gives the command that re-checks each number below from a clone, with no model call. It also names the few numbers that rest on a Linear receipt or a GitHub CI run instead.

## Run it

You need Bun 1.4.2 (`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2`). WorldGen also needs the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), logged in. Commands run from `code/`.

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

- To see the whole system work with no model call, run `scripts/demo-all.sh` from the repo root. It needs curl and jq, and runs 25 PASS-or-FAIL steps in about a minute.
- `bun run studio` serves a local operator web app at http://127.0.0.1:8787.
- `bun run check` typechecks, then runs every test, with no real model call.

The agent under test gets only the world port, which also serves `GET /openapi.json`. The admin port serves `GET /_world/state`, `POST /_world/reset`, `GET /_world/log`, `POST /_world/clock`, `POST /_world/grade/<task>` and `GET /_world/openapi`, and the operator console at `GET /`.

A WorldGen run writes into `prod/worlds/gen-<slug>/` unless `--out` names a directory. It writes `world.yaml`, `plan.yaml`, `plan.md`, `REPORT.md` and `runs/<runId>/events.jsonl`. The events file logs every stage, repair attempt, duration and model cost. The default model is `claude-sonnet-5-5` through `claude -p`, with a budget of $5 and 15 minutes per run. `--model`, `--budget-usd` and `--max-minutes` change them, and no call falls back to another model. `--transport sdk` uses the Anthropic SDK with the key in `LLM_KEY`.

## How it works

- **One artifact.** A world is one checked `world.yaml` with its data model, API, workflow logic, seed data and tasks. [prod/world-format.md](prod/world-format.md) documents every section.
- **The engine is strict.** It checks a world in seven layers, from schema to lints, with errors a model can fix. It refuses any write that breaks the data model, and a failed call changes nothing. Time is engine time, never the wall clock.
- **Graders must discriminate.** A task counts only when its reference solution scores 1, doing nothing scores 0, and every decoy scores below 1.
- **WorldGen builds in stages.** It plans first, then builds the data model and API, the workflow, the seed and the tasks, and checks after each stage. The engine's issues drive a bounded repair. A run that cannot pass stops and says why. It never hands over a broken world.
- **Iteration is a diff.** `--world` reruns only the stages a change request reaches. A gate blocks any destructive change the plan did not name.

## Release

The release is **v1.1.1**. Its code is `71f84d45` ([#149](https://github.com/jop8281/worldgen/pull/149)), and the tag adds no code over it. Its verdict runs are [37860510831](https://github.com/jop8281/worldgen/actions/runs/37860510831) and [37860513520](https://github.com/jop8281/worldgen/actions/runs/37860513520), also linked from the [GitHub Release page](https://github.com/jop8281/worldgen/releases/tag/v1.1.1). Both passed the test suite and the end-to-end check. CI runs on Bun only: typecheck, every test and the end-to-end check, with no model call.

| v1.1.1 carries fixes for the four tracked limits of v1.1.0 | PRs |
|---|---|
| A planned job is never a workflow action (YOS-257). A backtrack gives its target and every later step a fresh attempt budget, and plan coverage ignores path-param names (YOS-258). The Boat VM, OpenShell and sbx run only the pinned Bun (YOS-259). An `expect: stopped` eval case is a refusal only on `input_rejected` (YOS-260). The docs give Bun commands, not npm. | [#145](https://github.com/jop8281/worldgen/pull/145), [#144](https://github.com/jop8281/worldgen/pull/144), [#143](https://github.com/jop8281/worldgen/pull/143), [#148](https://github.com/jop8281/worldgen/pull/148), [#141](https://github.com/jop8281/worldgen/pull/141), [#142](https://github.com/jop8281/worldgen/pull/142), [#146](https://github.com/jop8281/worldgen/pull/146) |

Two known limits remain. OpenAPI fidelity is a normalized comparison of paths, request shapes and error codes within the chosen scope, not exact equivalence with the source API. The snippet heap bound is not enforced in CI, because Bun ignores it (A-87, A-379). Every change lands through a [pull request](https://github.com/jop8281/worldgen/pulls?q=is%3Apr+is%3Amerged) to `stabilize/main`, and `main` moves only by a promotion pull request. [research/readme-reference.md](research/readme-reference.md#status) lists what an earlier repository built. Its PR numbers refer to that repository.

Training benefit has not been shown yet: no model has been trained on these worlds and scored on an outside benchmark. See [research/training-experiment.md](research/training-experiment.md) for the experiment that would test it.

## Results

### One run on a new description

One `bun run worldgen` on "an IT asset tracker with laptops, assignments, repair tickets and a quarterly audit", on `8ce44508`, with the default model and budget. Its source is [eval/runs/2026-10-08-handin-smoke/](eval/runs/2026-10-08-handin-smoke/).

| Measure | Result |
|---|---|
| Outcome | done, with 3 verified tasks: easy, medium and hard |
| Time | 473.3 s |
| Cost | $1.45, a client-side estimate |
| `worldplay verify` | solution 1.000 and no-op 0.000 on each task, every decoy below 1 |

### The full suite

The `stress` suite has 29 cases: descriptions, OpenAPI specs, CSV files, change requests, and impossible inputs that WorldGen must refuse. Each run gets $3 and 12 minutes, stricter than the default.

[stress-4](eval/runs/2026-10-08-stress-4/summary.md) passed 23 of 29 (79%) for $26.71 settled. [stress-5](eval/runs/2026-10-08-stress-5/summary.md) reran its 6 product failures after their fixes, and 5 of 6 passed. stripe-customers still stopped.

stress-6 reran the whole 29-case suite on `42ab9ca9` with the same settings ([#129](https://github.com/jop8281/worldgen/pull/129)): 27 of 29 (93%), 24 succeeded and 3 impossible inputs were refused. Per case, p50 was 4.5 min, p95 8.2 min and the max 8.8 min, and the suite cost $25.32. stripe-customers now finishes. Its source is [eval/runs/2026-10-08-stress-6/summary.md](eval/runs/2026-10-08-stress-6/summary.md). Its two stops, bookmarks and stripe-charges, have fixes in v1.1.1 (YOS-257 [#145](https://github.com/jop8281/worldgen/pull/145), YOS-258 [#144](https://github.com/jop8281/worldgen/pull/144)).

stress-7 reran those two cases and three stress-6 passes as controls on `2da7dd17`, the v1.1.1 code, with the same settings ([#152](https://github.com/jop8281/worldgen/pull/152)). All 5 ended done with verify passing, in 24.7 min for $5.74. bookmarks now builds its scheduled jobs as jobs, and stripe-charges passed the model step on its first attempt. No case backtracked, so YOS-258's fresh attempt budget after a backtrack rests on its unit tests. Its source is [eval/runs/2026-10-08-stress-7-targeted/summary.md](eval/runs/2026-10-08-stress-7-targeted/summary.md).

### The live-run dress rehearsal

On main `e034036c`, `bun run live` ran three stand-in prompts: a description, an OpenAPI spec with `--only /pet`, and two CSV files. All 3 were delivered in 13.2 minutes for $3.55, a client-side estimate. Each world passed `worldplay check`, and every task scored 1 for the reference and 0 for doing nothing. The receipt is on [YOS-100](https://linear.app/yossi-zozo123/issue/YOS-100).

## Worlds

`prod/worlds/` holds 25 worlds and 95 tasks. Two were built by hand: [helpdesk](prod/worlds/helpdesk/) and [retail-tau2](prod/worlds/retail-tau2/), the second mapped from τ²-bench retail. WorldGen generated the other 23, `prod/worlds/gen-*`: 11 from a description, 4 from an OpenAPI spec, 6 from CSVs and 2 from iterate runs. Each one carries its `plan.yaml` and `REPORT.md`. `bun run test` checks and verifies every world.

These worlds are a development set, and they include the answers: each `world.yaml` holds its graders, reference solutions and decoys. Each folder also keeps `public/world.yaml`, the public form a sandboxed agent gets, with none of them. A clean test set is generated fresh by WorldGen from prompts nobody has seen, as the live run does.

## Studio screenshots

These screenshots come from the real app, with no model call. [prod/screenshots/README.md](prod/screenshots/README.md) gives the command, viewport, runtime and digest of each one, and keeps the 27 frames of the browser E2E.

| | |
|---|---|
| ![The Worlds dashboard](prod/screenshots/01-dashboard.png) Signed in as `ada (admin)`, the Worlds table lists 25 worlds with kind, tasks, wid, model and cost. | ![An API call on the world port](prod/screenshots/04-console-get.png) A real GET on helpdesk's world port, answered 200. |
| ![A refused write](prod/screenshots/05-console-illegal-write.png) An illegal status move, refused whole with 422 `state.transition`. | ![A generated world's report](prod/screenshots/07-report.png) `REPORT.md` of gen-library-loans, built from two CSV files. |
| ![The engine proof](prod/screenshots/10-proof.png) The engine proof scores each reference 1, doing nothing 0, and decoys below 1. | ![A noop agent episode](prod/screenshots/11-noop-episode.png) A noop agent episode with no model call, scored 0 from its end state and filed under `noop (no model)`. |

## More

- [research/readme-reference.md](research/readme-reference.md) holds the longer reference: every world with its task scores, the engine and Docker details, the other CLIs, checks and costs, and Boat recovery.
- [research/architecture.md](research/architecture.md) gives the reasoning, [research/decisions.md](research/decisions.md) logs every design call, and [AGENTS.md](AGENTS.md) holds the working rules.
- Work is tracked in the [WorldGen Linear project](https://linear.app/yossi-zozo123/project/worldgen-f83badd4a2c7).
- WorldGen is MIT licensed: see [LICENSE](LICENSE).
