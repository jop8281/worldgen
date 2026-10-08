# WorldGen: implementation plan (agent-first)

This plan assumes the trial is decided by the live run on prompts we haven't seen. The engine is kept small and strict so WorldGen can use it as a judge it can rely on. Most of the engineering effort goes into WorldGen: how it splits the work into stages, how it repairs its own errors, how it decides to stop, and how it behaves on unfamiliar domains.

---

## 1. Tech stack (decided)

| Concern | Choice | Why |
|---|---|---|
| Language | **Python 3.12** | Best LLM SDK support, Pydantic, and quick iteration |
| World format | **YAML files validated by Pydantic v2 models** | Pydantic exports JSON Schema, which becomes the structured-output schema for the LLM. The format is the contract, and the model cannot write an invalid shape. |
| Engine state | **In-process SQLite (`:memory:`)**. Each request runs in a transaction, and logic actions use a SAVEPOINT. | Rollback makes calls all-or-nothing at no cost. SQLite also enforces FKs and uniqueness, and engine-level checks are added on top. |
| HTTP | **FastAPI + uvicorn** | Gives an auto-generated OpenAPI file for each world, which also helps fidelity diffs |
| Custom logic | **Declarative actions** (preconditions, effects, emitted events) using a small, safe **expression language** (CEL-like, built on `simpleeval`). There is an escape hatch to restricted Python handlers, which the report flags. | Declarative logic can be checked statically and gives precise error paths. Arbitrary Python fails at runtime with vague tracebacks. |
| LLM access | Anthropic SDK with tool-use and structured outputs, plus prompt caching for the format spec, plan and golden examples | Each stage writes typed fragments rather than free text |
| CLI | `typer` + `rich` | One command each: `world …` and `worldgen …` |
| OpenAPI | `prance`/`jsonref` for `$ref` resolution, plus our own flattener | Kept deterministic, with no LLM involved |
| CSV | `pandas` profiling in code | The LLM only sees the profile and sample rows, never the whole file |

## 2. Repo layout

```
engine/            # never touched by WorldGen
  format/          # pydantic models -> exported JSON Schema
  check/           # static + semantic validators, error catalog
  runtime/         # sqlite store, txn, clock, id gen, router, expr eval
  grade/           # grader eval, solution replay, mutation controls
  cli.py           # world check|serve|grade|test|inspect|reset|diff
worldgen/
  ingest/          # description.py, openapi.py, csv.py -> InputBrief
  stages/          # plan, model_api, logic, seed, tasks, report
  repair/          # loop, fingerprints, oscillation, backtrack
  iterate/         # change-plan + impact analysis + migration
  llm/             # client, cost meter, transcript store
  prompts/         # per-stage system prompts + golden few-shots
  config.py        # worldgen.toml schema
  cli.py           # worldgen build|change|explain
worlds/
  helpdesk/        # hand-built golden world (also few-shot source)
  generated/<name>/
evals/prompts/*.txt  # ~30 diverse prompts; nightly harness
docs/DESIGN.md
```

## 3. World format (one directory per world)

```
world.yaml        # name, version, epoch, page_size, error_envelope, id_scheme
model.yaml        # entities: fields{type, required, enum, unique, default, ref}, keys, invariants
api.yaml          # routes: {method, path, op: list|get|create|update|delete|action:<name>, entity, filters, sort, errors}
logic.yaml        # actions: params, preconditions[], effects[], emits[], tests[]
seed.yaml         # generator spec (counts, field generators, anchor rows) -> materialized seed.jsonl
tasks/<id>.yaml   # instruction, difficulty, grader, reference_solution, decoys[]
plan.json/plan.md # WorldGen's plan (engine ignores)
REPORT.md
```

Key decisions:
- **Invariants** live in the model, for example `status == 'closed' implies closed_at != null`. They are checked against the seed and after every write, which is the "refuse writes that break the data model" requirement.
- **State machines** are first-class: `status: {type: enum, transitions: {open: [pending, escalated], ...}}`. Generic `update` cannot make an illegal transition, and only the declared actions can.
- **Effects** are typed ops: `set`, `create`, `delete`, `increment`, `append_event`, `call_action`. Expressions can read `params`, `this`, `now()`, `query(entity, where)` and `count(...)`.
- **Errors** use a per-world envelope template, so a world built from Stripe's spec returns `{error:{type,code,message}}`.

## 4. Engine: the contract WorldGen depends on

These guarantees are tested in the engine's own suite:
1. **Check** returns machine-readable errors. Each one has `code` (from a stable catalog, e.g. `E_REF_UNKNOWN_FIELD`), `path` (a JSON pointer into the file), `message`, `expected`, `actual`, `hint`, and `owner_stage` (`model|api|logic|seed|tasks`). `owner_stage` drives backtracking.
2. **Stage-scoped check**: `world check --upto logic` validates only what exists so far.
3. **Atomic writes**: every request runs in one transaction. On any constraint, invariant or precondition failure the engine rolls back fully and returns 4xx using the envelope.
4. **Determinism**:
   - The clock is frozen at `world.epoch`. Each mutating call advances it by a fixed tick (1s), and it can also be moved explicitly with `POST /_engine/clock {advance:"P3D"}`.
   - IDs are `prefix_` followed by a per-entity counter.
   - Seed materialization uses a seeded PRNG keyed by (world hash, entity, row index).
   - Nothing reads wall time or global randomness.
   - The same world hash and task always give the same start state, and a byte-identical state dump verifies it.
5. **Inspect/reset/log**: `/_engine/state`, `/_engine/reset`, `/_engine/log` (request, response, diff per call) and `/_engine/diff` (current state vs. seed).
6. **Logic tests**: `world test` runs the `tests:` blocks in logic.yaml. Each block is a list of calls with expected status and expected state assertions, run on a fresh seed.
7. **Grade**: `world grade --task T --solution ref|noop|decoys|file` replays solutions on a fresh copy and returns the score plus per-assertion breakdown.
8. **Verify** (`world verify`) runs everything: check, test, a seed invariant sweep, and for each task ref=1, noop=0 and decoys<1. It is the single judge WorldGen uses.

## 5. Graders that discriminate

A grader is a weighted list of assertions over the end state. The engine never asks an LLM to grade.

- `exists/where`: a row matching a predicate exists, e.g. a ticket with id=X, status=escalated, assignee=on-call engineer.
- `field_equals`, `count_where`, `event_emitted`.
- **`unchanged_except`** (the collateral-damage check): the diff vs. seed must touch only the declared entity/row/field patterns. Any other change caps the score at 0.5 or zeroes it, as configured. **Every grader must include it or explicitly declare `collateral: ignore` with a reason**, and the checker enforces this.
- `no_violation`: for example, no enterprise ticket left with a breached SLA.

Discrimination is proven by **mutation controls** that the engine runs automatically:
- **noop** must score 0. The noop-zero check also catches assertions the seed already satisfies.
- **reference** must score 1.
- **Truncated references**: every strict prefix of the reference must score below 1.
- **Collateral mutant**: the reference plus one extra destructive call on an unrelated row must score below 1.
- **Decoys** written by WorldGen in the tasks stage must score below 1. Examples are escalating the wrong ticket, using the generic `update` to force the status instead of the action, and handling only the first page of results.

Reference solutions are lists of HTTP calls with captures (`save: {tid: "$.data[0].id"}`) and clock moves, so they work as real replays.

**Difficulty ladder** (the checker enforces at least one task per tier):
- **Easy**: one search plus one write.
- **Medium**: a filter across pages (the target row is guaranteed beyond page 1), then several writes.
- **Hard**: a workflow with rules and time, such as advancing the clock past the SLA, escalating only breached tickets for enterprise customers, and leaving the others alone.

## 6. WorldGen pipeline

### Stage 0: Ingest (deterministic code, no LLM)
This stage normalizes any input into an `InputBrief`: request text, source kind, structured extracts, and a size budget.

- **Description**: passed through.
- **OpenAPI**:
  1. Parse and resolve all `$ref`s, including remote and circular ones. Circular refs are cut at depth 2 with a marker.
  2. Flatten `allOf`. Keep `oneOf` with a discriminator note.
  3. Build an **operation index**: tag, method, path, summary, request/response schema names and error codes. For specs above a threshold (about 40 operations or 60k tokens), the LLM sees **only the index**.
  4. Narrowing: use `--include "tag:Refunds,path:/v1/charges*"` if given. Otherwise a cheap LLM call picks the operations that serve the request, capped at about 25.
  5. Compute the transitive closure of the schemas the chosen operations use.
  6. Infer the CRUD mapping by pattern: `GET /x` → list, `POST /x/{id}/cancel` → action. Only ambiguous cases go to the LLM.
  7. Write `spec_slice.json` and log which operations were dropped and why.
- **CSV** (one or more files):
  1. Profile each column: inferred type, datetime format, null rate, cardinality, uniqueness (key candidates), regex shape, and min/max/quantiles.
  2. Find FK candidates by value overlap across files (overlap ≥ 0.95 and parent unique).
  3. Mark enum candidates (cardinality ≤ 20, covering ≥ 99% of rows).
  4. Flag likely PII.
  5. The LLM receives the profile plus 15 stratified sample rows.

### Stage 1: Plan (strong model)
- **Input**: the InputBrief, the golden helpdesk plan as a few-shot example, and a planning checklist.
- **Output**, as `plan.json` (typed) and `plan.md` (rendered):
  - `real_world_analog`: for example "Zendesk Support API". Naming the analog makes the model draw on what it knows about the real software's conventions, which helps fidelity.
  - Entities with one-line rationale each; routes; workflows as state machines with rules.
  - 3–5 candidate tasks with difficulty levels.
  - Seed scale, e.g. tickets 600 and orgs 80.
  - `assumptions[]` (each with a reason) and `out_of_scope[]`.
  - `open_questions[]`. In non-interactive mode each one gets a default answer plus rationale. With `--interactive`, up to 5 are asked of a human.
- **Gate**: a plan linter in code. It requires at least one workflow with at least 3 states and at least one guarded transition, every task to reference planned routes, read and write routes both present, and fidelity to the spec slice when the input is OpenAPI.
- Later stages receive `plan.json` and must reference its IDs. An engine check confirms that every planned entity, route, workflow and task exists in the result, so drift from the plan is caught.

### Stage 2: Model + API
- **Input**: the plan, the format JSON Schema and the spec slice/profile.
- **Output**: `model.yaml` and `api.yaml`, produced through structured output.
- **Gate**: `world check --upto api`. For OpenAPI input, a conformance diff also runs, covering paths, methods, required fields and error codes.

### Stage 3: Logic + tests
- **Output**: `logic.yaml` actions, each with **at least 2 tests**: one happy path and one precondition failure that asserts a rollback with no partial state.
- **Gate**: `check --upto logic` and `world test`, run against a tiny auto-generated fixture seed (5 rows per entity, from defaults) so this stage does not depend on Stage 4.

### Stage 4: Seed
- The LLM writes a **generator spec, not rows**. This keeps token cost flat whether the world has 50 or 5000 rows. The spec contains:
  - per-entity `count`
  - field generators (`faker:company`, `choice{weights}`, `ref:orgs(skew=zipf)`, `date_between`, `derived: expr`)
  - **state-conditional fields** (`when status=='closed': closed_at = created_at + lognormal(...)`)
  - **anchor rows** with literal values that tasks will target.
- For CSV input, the real rows are imported (cleaned and keyed), then extended with generators fitted to the profile.
- **Default scale**: at least 10× page_size for the main entity, typically 300–1500 rows. Page size is 25.
- **Gate**: materialize the seed, then run the FK, uniqueness and invariant sweeps. A **plausibility linter** also runs:
  - every enum state represented, with no state above 70%
  - temporal ordering respected
  - no duplicate display names among people
  - some rows already in each workflow state, including edge cases like an already-breached SLA

### Stage 5: Tasks
- **Input**: the plan's task candidates, a summary of `api.yaml` and logic, a seed **sample**, and an anchor index. The model never sees the full seed. A `query_seed(entity, where)` tool lets it check facts against the actual data, so tasks don't depend on invented facts.
- **Output**: per task an instruction, a grader, a reference solution and 2+ decoys.
- **Gate**: `world verify` with ref=1, noop=0, decoys<1, truncations<1, the collateral mutant below 1, and all three tiers present. A task that can't be repaired is dropped if at least 3 remain, and the drop is recorded in the report.

### Stage 6: Report (template plus a short LLM narrative)
- `REPORT.md` covers: what was built (generated tables of entities, routes and workflows), assumptions with reasons (copied from the plan and amendments), what was left out, and the **verify output pasted verbatim**, including the per-task score table and the engine version/hash.
- It also includes cost and time per stage and the repair history.

## 7. Repair loop, backtracking, stopping

**The repair step:**
1. Group engine errors by file and object.
2. Send the model the **failing fragment only**, plus the errors (code, path, expected/actual, hint), relevant format-schema excerpts and a catalog entry explaining that error code.
3. The model returns either an **RFC 6902 JSON patch** against the fragment (default: cheap and local) or a full fragment rewrite (the escalation mode).
4. Patches are applied in code, and the stage-scoped check runs again.

**Budgets** (configurable; defaults):

| Stage | max attempts | escalation |
|---|---|---|
| plan | 2 | — |
| model_api | 4 | full rewrite at 3 |
| logic | 5 | full rewrite at 3, stronger model at 4 |
| seed | 4 | full rewrite at 3 |
| tasks | 4 per task | drop task at exhaustion |
| global | `max_usd=8`, `max_minutes=15`, `max_backtracks=2` | — |

**Detecting oscillation and stalls:**
- **Fingerprint**: an attempt's fingerprint is the sorted set of (code, path) pairs.
- **Oscillation**: a fingerprint repeats. On oscillation, switch to full-rewrite mode and add the history of past fingerprints to the prompt ("you previously tried X, which caused Y").
- **Stall**: the error count fails to drop for 2 attempts. A stall triggers escalation to a stronger model.
- **Regression**: a patch that adds errors in untouched paths is reverted automatically.

**Backtracking:**
- If at least half of a stage's errors have `owner_stage` upstream, the error is upstream. Example: logic references `tickets.sla_due_at`, which doesn't exist (`E_REF_UNKNOWN_FIELD`, owner=model). Another: the seed can't satisfy an invariant that contradicts a workflow.
- In that case the downstream stage may call a typed `amend(stage, patch, reason)` tool.
- The amendment is applied upstream. The upstream check runs again, followed by every downstream stage already built (cached artifacts stay unless the check invalidates them).
- The reason is appended to `assumptions` so nothing is changed silently.
- The budget is `max_backtracks` in total.

**Knowing when to stop:**
- If budgets run out, the world is written to `generated/<name>.FAILED/` and is never marked valid.
- The CLI exits non-zero and prints a failure report covering the failing checks, the last error set, what was tried, the stage where it got stuck, and a suggested human fix or narrower request.
- **Scope shedding** is allowed only within plan-declared optional items (extra workflows, a 4th or 5th task), and it is reported. The core minimum is never shed: one real workflow, 3 tiered tasks and a passing verify.

## 8. Iteration mode (`worldgen change worlds/x "add refunds"`)

1. Load the world, `plan.json` and the generation log, then run `world verify` to establish the baseline.
2. **Change-plan stage**: the LLM writes a `plan_delta` listing added and modified entities, routes, workflows and tasks, plus new assumptions. It is shown as a diff in `plan.md`.
3. **Impact analysis** (code) uses a dependency graph over IDs to find exactly which fragments must be regenerated. Everything else is frozen and read-only in the prompts.
4. Stages run **only for affected fragments**, using patch mode against the existing files.
5. **Seed migration**:
   - Existing rows and IDs are preserved byte-for-byte.
   - New fields get backfill generators.
   - New entities are generated, with FK targets drawn from existing rows.
   - A refunds workflow, for example, gets refunds in a mix of states seeded against existing charges.
6. **Regression gate**: every previous task must still verify. If the change intentionally alters one, the delta must name it, and the model updates the grader and reference.
7. The report gets a "Changes in v2" section, and the world version is bumped. Rebuilding from scratch is not allowed.

## 9. Robustness on unseen prompts

- **Golden few-shots**: the hand-built helpdesk plus 2 small worlds from other domains (payments with refunds, and inventory), so the model learns the format rather than one domain.
- **Generic workflow prompts**: prompts ask for "the state machine a real operator of X would recognize", and planning includes a "what actually goes wrong" check covering SLAs, approvals, reversals, quotas and audits.
- **Structured output everywhere**: this removes YAML syntax errors as a class of failure.
- **Error catalog with hints**: written by hand for roughly 40 codes, then tuned against eval failures.
- **Eval harness**: `evals/run.py` runs about 30 prompts across domains, including weird ones (a "submarine maintenance log"), large OpenAPI files (Stripe and GitHub, narrowed) and messy CSVs. It tracks pass rate, cost, time, repairs per stage and top error codes, and runs nightly. The live-run target is a pass rate of at least 90% within the default budget.
- **Timeouts and retries** on LLM calls (with backoff), and **checkpointing** after each stage, so `worldgen build --resume` continues an interrupted run.

## 10. Observability and config

- `runs/<ts>-<name>/events.jsonl` records stage start/end, every LLM call (model, input/output/cached tokens, $ cost, latency, transcript path), every repair attempt (fingerprint, error count, mode, outcome) and backtracks.
- Every prompt and response is saved under `transcripts/`.
- A live `rich` panel shows the stage, attempt number, running $ and elapsed time.
- The final table in REPORT.md breaks down time, cost and repairs per stage.
- `worldgen.toml` (overridable by env vars and CLI flags) holds:
  - models per role (`planner`, `builder`, `repair_escalation`, `cheap` for narrowing and seed text)
  - per-stage attempts
  - global $/time caps, seed scale and page size
  - interactive on/off and the temperature (0 by default, for reproducibility).

## 11. Milestones (about 10 working days)

1. **Days 1–2**: engine format, check with the error catalog, SQLite runtime, transactions, clock, and serve/inspect/reset/log.
2. **Day 3**: grader assertions, solution replay, mutation controls and `verify`. Finish the hand-built helpdesk world.
3. **Days 4–5**: the WorldGen pipeline end to end for description input, with structured outputs and stage gates.
4. **Day 6**: repair loop, fingerprints, escalation, backtracking via `amend`, stopping and failure reports.
5. **Day 7**: OpenAPI ingest (refs, narrowing, conformance) and CSV ingest (profiling, FK inference, seed import).
6. **Day 8**: iteration mode with impact analysis and seed migration.
7. **Day 9**: the 30-prompt eval harness. Tune prompts and hints, and fix the top failure codes.
8. **Day 10**: DESIGN.md, the generated worlds for the team's prompts, and a dry run with timed live prompts.

## 12. Risks and mitigations

- **The declarative logic is too weak for a workflow** → the Python escape hatch runs inside the same transaction with a narrow `ctx` API, gets an extra test requirement and is flagged in the report.
- **Huge or broken OpenAPI** (circular refs, missing schemas) → ingest is deterministic and degrades gracefully, with unresolvable parts listed as "left out".
- **Graders pass the checks but miss the intent** (ref=1 and noop=0 hold, yet the grader checks the wrong thing) → decoys, truncations, the collateral mutant and the mandatory `unchanged_except`.
- **Tasks rely on facts that aren't in the seed** → anchor rows plus the `query_seed` tool, and noop=0 catches tasks that are already satisfied.
- **Live-run latency or cost** → caching, the cheap model for bulk work, a hard cap with an honest stop, and `--resume`.
- **Non-determinism leaking in** (dict ordering, float time) → a state-hash test on repeated runs in CI.

## 13. Questions for the hiring team

1. Live run: how much wall-clock time and model budget per prompt, and is there a human in the loop to answer clarifying questions, or is the run non-interactive?
2. Which models and rate limits will the live run use?
3. How will your agents call the worlds: plain HTTP, MCP or tool schemas? Should the engine also expose the world as tools? Is auth required?
4. For OpenAPI input, how strict should fidelity be: exact error codes and bodies, pagination style (cursor vs. offset), idempotency keys?
5. Is partial credit in graders wanted, or binary scores with the 0/1 checks?
6. What seed size is "enough rows that paging matters" for you (hundreds vs. tens of thousands)?
7. Is executable custom logic (sandboxed Python) acceptable, or do you prefer purely declarative worlds?
8. Should a world model multiple actors or permissions (agent vs. admin), or is a single-actor API enough?
9. Will change requests in the live run target worlds generated live, or the delivered worlds?