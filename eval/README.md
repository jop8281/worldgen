# eval

Rehearsal for the live run on unseen prompts. It scores WorldGen, not the worlds' agents.

## The suite

`suite.yaml` has a `name` (it names the run directory) and `cases`. Each case is `{ id, input, change?, expect?, tags?, note? }`:

- `id` is lowercase kebab-case, such as `helpdesk-sla`, and unique in the suite.
- `input` uses the same schema as the `worldgen` CLI (`inputSchema` in `code/src/worldgen/input.ts`): `{ kind: description, text }`, `{ kind: openapi, path, only }` or `{ kind: csv, paths }`. File paths resolve against the suite file's directory, so `inputs/orders.csv` is `eval/inputs/orders.csv`.
- `change` is a change request. After the create run saves a world, the runner iterates on it with this request.
- `expect: stopped` marks a prompt WorldGen should refuse, such as `video-codec-impossible`. The default is `done`.
- `tags` group cases for `--tag`: the input kind (`description`, `openapi`, `csv`), `iterate`, `vague`, `impossible`, `known`, and `cheap`, which means a small input or an expected early stop. No cost was measured for the tag.
- `note` says what a good result looks like. Only people read it.

`inputs/` holds the files cases point at: `stripe.openapi.yaml`, `petstore.openapi.yaml`, `orders.csv`, `customers.csv` and `linear-backlog.csv`. The last is the team YOS backlog frozen on 2026-10-06: 123 issues with title, status, priority, project, milestone, labels, parent and dates, no assignee, no descriptions and no email. `linear-backlog.labels.csv` hand-labels each Status with its state category and is not a case input.

The unseen bank in `research/rehearsal-prompts.md` stays out of `suite.yaml` so it stays unseen. To run it, put it in a second suite file and pass `--suite`. `live-segment.yaml` is such a file: the three inputs of the demo's live segment, with its files in `inputs/live/`. `research/demo-runbook.md` says how to run and score them.

## Running

From `code/`:

```sh
npm run eval -- --dry-run                       # validate the suite and every input file; no model call, nothing written
npm run eval -- --only helpdesk-sla,orders-csv,linear-backlog-csv  # run some cases
npm run eval -- --tag cheap                     # run every case with that tag (--tag a,b takes either)
npm run eval                                    # run every case
```

Other flags: `--suite <file>`, `--model <id>`, `--budget-usd <n>` and `--max-minutes <n>` (per run, over `worldgen.config.json`), `--out-dir <dir>`, and `--transport claude-cli|sdk` (`claude-cli` is the default; `sdk` reads `LLM_KEY` from the environment). `--backend local|boat` and `--parallel <n>` are parsed and checked, but only `local` with `--parallel 1` runs today. Boat fan-out lands with the sandbox backends.

Cases run one at a time: create, then the change request if there is one, then verify. Verify loads the saved world and checks it. The check's tasks layer requires each task's solution to score 1 and doing nothing to score 0. Exit code: 0 when every selected case passed, 1 otherwise, 2 on bad usage.

## Run layout

```
runs/<YYYY-MM-DD>-<suite>/          one directory per run (UTC date); --out-dir overrides it
  summary.md                        the scorecard, rewritten after each case
  <case-id>/
    world/                          the world the create run saved (the change run iterates on it)
    events.jsonl                    RunEvents from the create run
    change/events.jsonl             RunEvents from the change run
    case.json                       what each runWorldGen returned or threw, and the verify result
```

Running a case again deletes its `<case-id>/` directory first. `summary.md` lists every case that has a `case.json`, so a rerun with `--only` keeps the other rows.

## summary.md

There is one row per case, with these columns: case, expect, result (`done`, `stopped` or `crashed`), stop reason, attempts per step (attempts in the change run are prefixed `change:`), minutes, $, verify, fidelity (only when a case has a reference), log and pass. Below the table come totals and the pass rate, followed by why each case is unlogged or crashed.

- A case marked `expect: done` passes when it ends `done` and verify passes.
- A case marked `expect: stopped` passes on any stop except `model_error`.
- A case is `unlogged` when a step ran without an `attempt` event that carries `ms` and `costUsd`, when any attempt lacks either value, when a line in `events.jsonl` is broken, or when the run returned without a `run_finished` event. This enforces the AGENTS.md invariant that every stage, attempt, time and cost is logged.

## Fidelity

`fidelity/<case>.yaml` is a frozen reference of the real software for `helpdesk-sla`, `retail-tau2-known` and `linear-description`: entities with key fields and types, state sets with the transitions the real product allows, routes, and failure cases with the real status, each with an integer weight and name synonyms. The reference is written from `research/` notes and the real product, never from a generated world, and cites its source in the file. `fidelityScore(reference, world)` in `code/src/worldgen/eval.ts` returns earned weight over total weight (0 to 1) and a list of misses (`entity.missing`, `field.missing`, `field.type_mismatch`, `state.missing`, `transitions.stricter_than_real`, `route.missing`).

- **Cell.** The fidelity column shows the score floored to 3 decimals plus the weights, such as `0.957 (68/71)`, so 0.7995 never reads as 0.800. A case that has a reference but no usable world shows `no world: <why>`. A case without a reference shows `-`. The column appears only when some case has a reference.
- **Misses.** `## Fidelity misses` in `summary.md` lists every miss as ``- `<case>` <kind> <path> (<weight>): <detail>``, then `missed <n> of <total>` per scored case.
- **What is scored.** The saved world parsed by the world schema, only when the last phase finished. Check and verify results do not matter, so a world that fails them still scores. The score is recomputed from `world.yaml` on every summary and never stored, and it never feeds `pass`.
- **Matching.** A name matches after lowercasing and dropping non-alphanumerics, canonical spelling first, then synonyms in listed order. Normalized names never repeat within a scope, so one world key satisfies at most one item, and the parser rejects a clash. A field matches when its engine type is in `types`, and every `types` entry must be an engine field type.
- **State sets.** The first location that resolves to a state or enum field is used: the primary `entity.field`, then each entry of `alternatives`. The transitions item needs at least two matched states. Otherwise it is lost as `state.missing` at `<entity>.<field>.transitions`.
- **Errors.** An error with `via: route` must name a listed route and reuses that route's synonyms. An error with `via: state` must name a listed state set and a `from` and `to` state of it, and earns its weight only when the world matches both states and forbids that move. Error items measure producibility only: the status is never compared.
- **Bad references.** A reference that does not parse, or whose `case` is not its file stem, fails `--dry-run` with the item path. A real run refuses to start (exit 2) before any model call.

The target is 0.80 on each referenced case by stress run 2 (YOS-54). See `research/spec-calls/eval-fidelity.md`.

When a case fails, fix the generic cause (prompts, hints, issue texts), never the one prompt. Move a world to `prod/` only when it is a deliverable.

`eval/` holds no code. The runner is `code/src/cli/eval.ts`, and its logic is in `code/src/worldgen/eval.ts`. Engine acceptance lives in `code/test` (node:test, run through npm from `code/`), so the engine and WorldGen are each runnable with one command, through npm only. Decision A-45 in `research/decisions.md` records why the Python acceptance harness was retired.
