# WorldGen

Two tools for building **worlds**. A world is a stateful, deterministic replica of real software, such as a helpdesk or a payments API, that an agent can be tested against.

- **worldplay** is the world engine. It checks a world, serves it over HTTP, enforces its data model and workflows on every write, and grades a task from the final state.
- **worldgen** is an LLM agent. It turns a description, an OpenAPI spec or a CSV into a world that worldplay accepts. The engine is the only judge. WorldGen never edits the engine and never grades with a model.

The task is in [research/spec.md](research/spec.md). [prod/README.md](prod/README.md) maps every spec item to the file that implements it and the command that shows it. The design doc is [prod/design.md](prod/design.md).

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

## Results

### On this repository

One `bun run worldgen` on the spec's own example description, "an IT asset tracker with laptops, assignments, repair tickets and a quarterly audit". It ran on `8ce44508`, with the default model and budget. The hand-in commit adds only a studio shutdown fix, test fixes and this README, nothing on the generation path. Its source is [eval/runs/2026-10-08-handin-smoke/](eval/runs/2026-10-08-handin-smoke/).

| Measure | Result |
|---|---|
| Outcome | done, with 3 verified tasks: easy, medium and hard |
| Time | 473.3 s |
| Cost | $1.45, a client-side estimate |
| `worldplay verify` | solution 1.000 and no-op 0.000 on each task, every decoy below 1 |

### Earlier, historical

These ran before this repository's one-commit snapshot, so the SHA names a commit of the earlier repository. stress-2 ran the whole 29-case `stress` suite on `3ff2c3a`, at $3 and 12 minutes per run. Its source is [eval/runs/2026-10-07-stress-2/summary.md](eval/runs/2026-10-07-stress-2/summary.md).

| Measure | stress-2 |
|---|---|
| Cases that ended as expected | 22 of 29, including 3 impossible inputs refused as expected |
| Time per run, over 30 runs | p50 6.4 min, p90 8.9 min, max 9.8 min |
| Cost per run, over 30 runs | p50 $1.27, p90 $1.64, max $1.88 |

The 7 misses have three root causes, each explained in the summary.

## Worlds

`prod/worlds/` holds 25 worlds and 95 tasks. Two were built by hand: [helpdesk](prod/worlds/helpdesk/) and [retail-tau2](prod/worlds/retail-tau2/), the second mapped from τ²-bench retail. WorldGen generated the other 23, `prod/worlds/gen-*`: 11 from a description, 4 from an OpenAPI spec, 6 from CSVs and 2 from iterate runs. Each one carries its `plan.yaml` and `REPORT.md`. `bun run test` checks and verifies every world.

## Studio screenshots

Taken from the real app on `b2b980f9`, with no model call. [prod/screenshots/README.md](prod/screenshots/README.md) gives the command, viewport, runtime and digest of each one.

| | |
|---|---|
| ![The Worlds dashboard](prod/screenshots/01-dashboard.png) The Worlds table lists 25 worlds with kind, tasks, wid, model and cost. | ![An API call on the world port](prod/screenshots/04-console-get.png) A real GET on helpdesk's world port, answered 200. |
| ![A refused write](prod/screenshots/05-console-illegal-write.png) An illegal status move, refused whole with 422 `state.transition`. | ![A generated world's report](prod/screenshots/07-report.png) `REPORT.md` of gen-library-loans, built from two CSV files. |
| ![The engine proof](prod/screenshots/10-proof.png) The engine proof scores each reference 1, doing nothing 0, and decoys below 1. | ![A noop agent episode](prod/screenshots/11-noop-episode.png) A free noop agent episode, scored 0 from its end state. |

## More

- [research/readme-reference.md](research/readme-reference.md) holds the longer reference this README used to carry: every world with its task scores, the engine and Docker details, other CLIs, checks and costs, Boat recovery, and the historical PR table.
- `bun run check` is the gate: typecheck, then every test, with no real model call. Node 22 runs the second gate with `npm ci && npm run check:node`.
- [research/architecture.md](research/architecture.md) gives the reasoning, [research/decisions.md](research/decisions.md) logs every design call, and [AGENTS.md](AGENTS.md) holds the working rules.
- Work is tracked in the [WorldGen Linear project](https://linear.app/yossi-zozo123/project/worldgen-f83badd4a2c7).
