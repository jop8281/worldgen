# WorldGen work-trial plan (delivery-first)

## 0. Approach

- **Have a thin end-to-end slice by the end of Day 2.** A one-sentence description goes into WorldGen and comes out as a world the engine accepts, serves and grades, with at least one task whose grader scores 1.0 on the reference solution and 0.0 on doing nothing. Every later day makes that path deeper. None of it is a separate track that gets wired in at the end.
- **The engine is the product's spine.** It must be strict and boring, and it must return errors a model can act on. WorldGen is only as good as the engine's error messages, so error quality counts as an engine feature with its own tests.
- **Constrain where the model can go wrong.** Declarative YAML covers the data model, routes and state machines, so the engine can check it. Generated Python is allowed only behind a narrow `ctx` API and goes through static linting.

## 1. Tech stack (decided)

| Concern | Choice | Why |
|---|---|---|
| Language | **Python 3.12** | Fastest path solo with an LLM assistant. Best ecosystem for this work (Pydantic, SQLite, Faker), and models write it reliably. |
| World schema | **YAML on disk, validated with Pydantic v2** | Humans can read it in a PR. Pydantic gives typed loc paths that we turn into model-friendly errors. |
| State store | **SQLite in-memory, one DB per session** | Real FKs, UNIQUE and CHECK constraints, transactions with `SAVEPOINT`, and fast reset (`backup()` from a pristine seed DB). Atomicity comes free. |
| HTTP | **Starlette/FastAPI + uvicorn** | Dynamic route registration from the world file; the OpenAPI export is a bonus. |
| Expressions (guards, grader checks) | **Small AST-whitelisted expression evaluator** (Python-expression subset) | Deterministic, sandboxable and checkable. No `eval`. |
| Custom logic | **Python handler functions, `def action(ctx, params)`** | Expressive enough for real workflows. An AST lint bans imports outside the allowlist and bans `datetime.now`, `random`, I/O, `open`, `__`. |
| LLM | **Anthropic SDK; model, budget and temperature set in `worldgen.toml` or CLI flags** | The spec says configurable. We use structured outputs and tool use for file edits, and log token cost per call. |
| CLI | **Typer**: `world check|serve|grade|verify`, `worldgen build|update` | One command each, as the spec requires. |
| Tests | **pytest + hypothesis** (property tests for atomicity and constraints) | |

## 2. Repo layout

```
worldgen-trial/
  engine/            # never touched by WorldGen
    schema.py        # Pydantic world format
    check.py         # static + semantic checks -> [Diagnostic]
    store.py         # SQLite build, constraints, txn, snapshot/reset, diff
    runtime.py       # routing, CRUD, list/filter/sort/paging, state machines
    sandbox.py       # handler lint + ctx API
    clock.py         # virtual time
    grade.py         # grader DSL + python graders, verify(noop/ref/mutants)
    server.py  cli.py
  worldgen/
    pipeline.py      # stages, checkpoints, budgets
    stages/{plan,model,logic,seed,tasks,report}.py
    repair.py        # error -> targeted fix loop
    ingest/{text,openapi,csv}.py
    prompts/         # versioned prompt templates
    llm.py           # client, cost accounting, transcript logging
  worlds/
    helpdesk/        # hand-built golden world
    generated/<slug>/
  stress/prompts.yaml  stress/run_all.py
  docs/DESIGN.md  docs/DECISIONS.md
  tests/
```

## 3. World format

A world is a directory. Splitting it into files makes repair and diff targeted: the model rewrites `logic.py` without seeing the seed data.

```
world.yaml        # meta, clock, entities, routes, state machines
logic.py          # custom action handlers (optional)
seed/             # generator.py + frozen seed.jsonl (the frozen file is canonical)
tasks/*.yaml      # instruction, grader, reference solution (call sequence)
plan.md  report.md  ASSUMPTIONS.md  build_log.jsonl
```

`world.yaml` sketch:

```yaml
meta: {name: helpdesk, version: 3, source: description}
clock: {start: "2026-03-02T09:00:00Z", tick: "1s"}   # per write call
entities:
  Ticket:
    key: {field: id, format: "TCK-{n:05d}"}
    fields:
      subject: {type: string, required: true, max: 200}
      priority: {type: enum, values: [low, normal, high, urgent]}
      status: {type: enum, values: [new, open, pending, escalated, resolved, closed], machine: ticket_lifecycle}
      assignee_id: {type: ref, to: Agent, nullable: true, on_delete: restrict}
      sla_due_at: {type: datetime, readonly: true}
    unique: [[external_ref]]
    invariants: ["status != 'closed' or resolved_at != None"]
state_machines:
  ticket_lifecycle:
    initial: new
    transitions:
      - {from: [new, open], to: escalated, via: action:escalate}   # only via custom action
      - {from: [open, pending, escalated], to: resolved, guard: "assignee_id != None"}
routes:
  - {method: GET,  path: /tickets, op: list, entity: Ticket, filters: [status, priority, assignee_id], sort: [created_at, sla_due_at], page: {style: cursor, default: 25, max: 100}}
  - {method: POST, path: /tickets/{id}/escalate, op: action, handler: escalate}
errors: {style: rfc7807}   # or "openapi" to mirror the source spec's error shapes
```

`tasks/escalate_breached.yaml` sketch:

```yaml
id: escalate_breached
difficulty: medium
instruction: "Escalate every urgent ticket whose SLA has already breached and assign it to the on-call agent."
reference: [ {GET: /tickets?priority=urgent&status=open}, ... ]   # or reference.py using an HTTP client
grader:
  checks:
    - {weight: 0.6, all: "Ticket where priority=='urgent' and sla_due_at < seed_now and seed.status=='open'", expect: "status=='escalated' and assignee_id==oncall('tier2')"}
    - {weight: 0.4, collateral: {allow_changed: {Ticket: "<target set>", Escalation: "*created"}}}
  gate: collateral   # a collateral failure caps the score at 0.5
```

## 4. Engine design and guarantees

1. **Check** (`world check`) runs in layered passes. It stops at the first failing layer, but within that layer it reports every error.
   - L1: schema (Pydantic).
   - L2: references (refs point to entities, routes to handlers, machines to enum fields).
   - L3: semantics (state machines: every state reachable, no transitions to undeclared values. Invariants parse and use only known fields).
   - L4: handler lint, AST-based.
   - L5: the seed loads under all constraints.
   - L6: tasks verify.

   Each diagnostic is `{code, severity, file, path: "entities.Ticket.fields.assignee_id.to", message, expected, got, hint}`. Example hint: "did you mean `Agent`? Known entities: Agent, Ticket, Customer". The diagnostic code is stable, so repair prompts can carry per-code fix advice.
2. **Serve.** Each session gets a fresh in-memory DB restored from the pristine seed snapshot. A header (`X-Session`) allows parallel sessions.
3. **Enforce.** Every request runs inside one SQLite transaction. Checks run in this order: type and shape validation, then readonly fields, then state-machine transitions, then invariants. Only then does it commit, so any exception rolls everything back. Custom handlers write only through `ctx` (`ctx.get/list/create/update/delete/now/fail(code,msg)`), which goes through the same enforcement. A property test (hypothesis) fires random call sequences and asserts that a failed call leaves `dump()` byte-identical.
4. **Determinism.**
   - IDs come from per-entity counters.
   - The clock is virtual. It starts at `clock.start` and advances a fixed tick on each write. `POST /_engine/clock/advance` exists for tasks such as "after 4h the SLA breaches" (admin only, not shown to the agent).
   - List results always get a total order, with `id` as tiebreak.
   - The handler lint bans `random`, `time` and `datetime.now`.
   - A determinism test runs the same reference solution twice and compares dump hashes.
5. **Inspect and reset.**
   - `GET /_engine/state` gives a full dump.
   - `/_engine/diff` gives the change against seed: rows created, updated (field-level) and deleted.
   - `/_engine/log` gives every call with request, response, status, virtual time and the DB writes it caused.
   - `POST /_engine/reset` returns to the seed.
   - All `/_engine/*` routes are on an admin prefix that the task-facing API does not list.
6. **Grade.** `world grade <task> --state dump.json`. `world verify` runs, for each task: noop gives 0.0, reference gives 1.0, and every mutant gives less than 1.0 (see section 6).

## 5. WorldGen pipeline and repair loop

```
ingest -> 1 PLAN -> 2 MODEL+API -> 3 LOGIC -> 4 SEED -> 5 TASKS -> 6 REPORT
             |          |             |          |          |
          human-     check L1-3   check L4 +  check L5 +  verify
          readable               scenario    distribution (noop/ref/
          plan.md                tests       checks       mutants)
```

- **Ingest.** Text is passed through as-is. OpenAPI is parsed with `prance` and narrowed by a tag or path glob, and the extracted entities, paths and error schemas go into the prompt as facts the world must follow. A CSV is profiled in code, not by the model: column types, cardinality, candidate keys, FK-looking columns and enum candidates. The model receives the profile plus 20 sample rows.
- **Stage 1, plan.** Produces `plan.md` plus `plan.json`: entities, routes, workflows (states and rules), the 3-5 tasks, and an assumptions list. Later stages receive `plan.json` as a contract. A cheap code check confirms each stage's output covers every plan item, and a mismatch counts as a diagnostic. A `--pause-after-plan` flag lets a human edit it.
- **Stage 3** also has the model write 3-6 scenario tests (call sequences plus expected status and state) that cover both legal and illegal transitions. The engine runs them. A test failure is a diagnostic, but whether the test or the code is wrong is resolved in the repair prompt, which must justify its choice against the plan.
- **Stage 4, seed.** The model writes `seed/generator.py` against a helper library we supply: seeded `rng`, a fixed-locale Faker, `pick_weighted`, and `timeline(start, end)`. The engine runs it once and freezes the output to `seed.jsonl`. Checks:
  - all constraints hold
  - FKs resolve
  - main entities have at least 150 rows (at least 6 pages at size 25)
  - no enum value covers more than 70% of rows, and every machine state appears at least once
  - timestamps are causal (`created <= updated <= clock.start`)
  - plan-mandated scenarios exist (for example, at least 5 tickets already in breach)
- **Stage 5.** Tasks are written at easy (one write), medium (search, page and filter, then several writes) and hard (a multi-entity workflow that needs a custom action and paging). Each comes with a reference solution and a grader, and goes through verification including mutants.
- **Repair loop** (`repair.py`):
  - The input is the stage's diagnostics, the offending files only, the plan excerpt and the per-code fix hints.
  - The model returns edits as whole-file replacements for small files and search/replace blocks for large ones.
  - The engine re-checks after each attempt.
  - Budget per stage is 4 attempts, with a global USD cap and a wall-clock cap.
  - If the error count does not fall for 2 attempts in a row, the loop escalates once: it regenerates the stage from scratch with all diagnostics so far, and can optionally switch to a stronger model set in the config.
  - When the budget runs out, the output is `FAILED.md` with the stage, the remaining diagnostics, what was tried and the last good checkpoint. No world is marked as passing.
- **Never self-grading.** All pass/fail comes from engine exit codes and JSON. The model's output is never parsed for "looks good".
- **Iterate** (`worldgen update <world> "add refunds"`):
  - Load the world and plan, and ask the model for a **plan delta**.
  - Re-run only the affected stages. The schema changes, then a seed migration step (the generator is patched and regenerated with the same RNG seed, so unchanged entities stay identical), then new tasks.
  - **All existing tasks must still verify**, which acts as a regression gate.
  - Bump `meta.version` and add a changelog section to the report.
- **Observability.** `build_log.jsonl` records stage start and end, each model call (model, tokens in and out, cost, latency), each repair attempt with its diagnostics count, and the final summary. The CLI prints a live stage table.
- **Checkpointing.** Each stage writes to `.stages/N/`, and a rerun resumes from the last passing stage. This saves a great deal of money during development.

## 6. Graders that discriminate

The spec's minimum (noop gives 0, reference gives 1) is weak, because a grader that checks "anything changed" passes it. We add the following:

1. **Collateral-damage check.** The engine's diff compares seed to end state. The grader declares the allowed change set, and any row change outside it lowers the score, by gating or by weight. This catches "close all tickets" passing a task that asks to close the overdue ones.
2. **Mutant solutions** (generated by code, not by the model) must score below 1.0:
   - the reference with its last write dropped (partial)
   - the reference applied to a wrong but similar row (an adjacent ID, or the first page only, which catches graders that ignore paging)
   - an over-broad write (the action applied to every row in the filtered list)
   - the reference executed twice (idempotence, e.g. a refund issued twice)

   Fault-injection is done at the call-sequence level, so it works for any world.
3. **Relative-to-seed predicates.** Checks refer to `seed.*` and `seed_now`, so targets are computed from the seed and not hard-coded IDs. This also makes graders robust when the seed is regenerated during `update`.
4. **Partial credit is allowed but bounded.** Weights sum to 1. Noop must be exactly 0 (no check may be trivially true on the seed; verify flags any check that is already satisfied at seed as `GRADER_TRIVIAL`).
5. **Process checks are allowed in moderation.** Example: "used the escalate action, not a raw PATCH of status", read from the call log. The engine prevents the PATCH anyway if the machine declares `via: action`.

## 7. Seed data at scale

- Volume tiers: core entities 150-500 rows, child entities 2-5 per parent, lookup entities 5-30.
- State mix comes from the plan, for example tickets at 40% open, 15% pending, 10% escalated and 35% resolved/closed. History is derived from timelines, so a closed ticket has `resolved_at`.
- "Needle" rows are planted on purpose for tasks: specific breached tickets and near-duplicate customer names that are hard to search. They are recorded in `seed/needles.json` so task writers reference them by role.
- For a CSV input, real rows are used as-is or lightly perturbed and then extended with the generator up to volume. Distributions are matched from the profile.
- Size guard: the seed stays below roughly 5 MB, and generation runs in under 10 seconds.

## 8. Day-by-day milestones (7 days; Day 6-7 doubles as buffer if needed)

| Day | Goal | Exit criterion |
|---|---|---|
| **D1** | Engine core: schema, check L1-L3 with good diagnostics, SQLite store, CRUD with paging and filtering, transactions, clock, dump/reset/log. Start the hand-built helpdesk (entities and routes). Send the Slack questions (section 12). | `world serve worlds/helpdesk` works; atomicity property test is green. |
| **D2** | State machines, invariants, `logic.py` sandbox, grader DSL and verify (noop/ref). Helpdesk gets an escalation workflow and 3 tasks. **Thin WorldGen slice**: plan, then a single model+API stage, a template seed and one task, with the repair loop. | **E2E slice: `worldgen build "a todo app with projects"` produces a verified world.** |
| **D3** | Full WorldGen stages 3-5: scenario tests, seed generator plus distribution checks, task stage, mutant verification, collateral checks. Observability and cost logging. | 3 description prompts build green end to end. |
| **D4** | Ingest for OpenAPI (narrowing, error shapes) and CSV (profiling). Report stage. `FAILED.md` path. Stress suite runner. | 2 OpenAPI and 2 CSV inputs green; the stress suite reports a pass rate. |
| **D5** | `worldgen update` with plan delta, seed migration and regression gate. Tune the repair loop against stress-suite failures (add per-code hints). | `update "add refunds"` passes on 2 worlds; stress pass rate at least 70%. |
| **D6** | Hardening: run the full stress suite twice, fix the top failure clusters, check cost and time per world (target under $3 and under 10 min). DESIGN.md, DECISIONS.md, README. Build the hiring team's worlds. | Stress pass rate at least 85%; all their prompts green. |
| **D7** | Buffer and polish: live-run rehearsal on 3 prompts never seen before, under timed conditions. Demo script. | Rehearsal done; tagged release. |

## 9. Cut lines

- **MUST.** All six engine minimum features. Description input. The 6-stage pipeline with checkpoints, repair loop, budget and honest failure. Noop/ref verification. One hand-built world. Report. One-command CLIs. Config file. Cost and time logs. `update`, at least a basic version. The hiring team's worlds.
- **SHOULD.** OpenAPI ingest with narrowing and error shapes. CSV ingest. Mutant verification. Collateral checks. Scenario tests in stage 3. Stress suite at 10+ prompts. `--pause-after-plan`.
- **COULD.** Parallel sessions. OpenAPI export of the generated world. A small web inspector UI for state, diff and log. Model escalation tiering. Seed-migration preservation of row identity across updates. A "play" mode where an LLM agent attempts tasks to estimate difficulty, used for reporting only and never as a grader.
- **WON'T.** Auth/RBAC simulation beyond a static API key. Webhooks and async jobs, which are approximated through clock advance. Multi-tenant hosting.

## 10. Risk register

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Repair loop oscillates or never converges | High / High | Per-code fix hints; minimal file context; a no-progress detector leading to one regenerate-from-scratch; stress-suite-driven tuning on D5-6. |
| Generated Python is non-deterministic or unsafe | Med / High | AST allowlist; the `ctx` API is the only door to state; determinism double-run test inside verify. |
| Graders are weak (pass noop/ref but don't discriminate) | High / Med | Mutants, collateral diff, and the `GRADER_TRIVIAL` check, all run by code. |
| The live run hits an unusual domain (e.g. "airline crew scheduling") | Med / High | A stress suite covering many domains; generic fallbacks (state machine templates such as approval and lifecycle); honest failure with a partial report. |
| Large OpenAPI specs blow the context | Med / Med | Narrowing by tag or path; send a schema digest, not the raw spec; `$ref` resolution done in code. |
| Seed generation is slow or invalid at scale | Med / Med | The generator runs in code (milliseconds) and the model writes only the generator. Distribution checks give numeric feedback. |
| Cost or time overrun live | Med / Med | Budgets in config; checkpoints; a cheaper model for the seed and report stages. |
| Engine scope creep eats WorldGen time | High / High | Engine feature-freeze at end of D2 except for fixes that the stress suite exposes. |

## 11. Testing strategy

- **Engine unit and property tests.** One test per diagnostic code (a broken fixture produces the expected code and path). CRUD, paging edges and filter types. A Hypothesis test asserting that a random failing call leaves the dump unchanged. State-machine legality. Clock determinism. Reset equals seed hash.
- **Golden world (helpdesk, hand-built).** SLA tiers, on-call escalation, about 300 tickets and 3 tasks. It is in CI, so `world verify` must stay green, and it serves as the few-shot exemplar in WorldGen prompts. Snapshot tests on its dump and diff output.
- **WorldGen tests.** Stages run against a recorded-LLM fixture (cached responses keyed by prompt hash) for fast CI. Separately, a nightly-style manual live run of the stress suite.
- **Stress suite (12 prompts)** in `stress/prompts.yaml`, run by `stress/run_all.py`. It records a pass/fail matrix with cost, time and repair count per stage.
  1. IT asset tracker with laptops, assignments, repair tickets and a quarterly audit (from the spec)
  2. Helpdesk with SLA tiers and on-call escalation (compare against the golden world)
  3. A payments API with charges, refunds and disputes (from a Stripe-like OpenAPI subset)
  4. A CRM with leads, opportunities and pipeline stages
  5. Library lending with holds, waitlists and fines
  6. Clinic appointment booking with double-booking rules
  7. Warehouse inventory with purchase orders and stock reservations
  8. HR leave requests with approval chains and balances
  9. CSV input: a Shopify-like orders export
  10. CSV input: a Jira issue export
  11. OpenAPI input: the Petstore spec narrowed to `/store`
  12. A deliberately vague prompt ("an app for a bakery"), to test assumptions
  13. An adversarial or impossible prompt ("a real-time video codec"), which must fail honestly

  `update` cases are run on #3 ("add partial refunds") and #5 ("add renewals").

## 12. Slack channel use

On **Day 1 morning**, send these questions as one batched message:

1. Will the live-run prompts be descriptions only, or also OpenAPI and CSV? Roughly how big are the specs?
2. Is there a time or cost budget per world during the live run?
3. Do the agents being tested call the world over plain HTTP/JSON? Do they get an OpenAPI doc of the world, which we can export?
4. How much fidelity do you expect on error shapes and status codes for description inputs: RFC 7807 or the real product's style?
5. Is partial credit acceptable (graders that are not binary), as long as noop gives 0 and the reference gives 1?
6. Which model or models can we use, and are there rate limits?
7. Are there constraints on languages or dependencies in your environment, e.g. Docker required?

On **Day 3**, share the E2E demo and ask for feedback on the world format before it gets locked. Ask them to send the trial prompts early.

On **Day 5**, share stress-suite results and ask whether the failure-mode report is what they want.

Keep a pinned "decisions so far" message mirroring DECISIONS.md.

## 13. Decisions and assumptions (seed for DECISIONS.md)

- **D1.** Python with SQLite in-memory. Atomicity comes from DB transactions, not hand-rolled undo.
- **D2.** The world is YAML plus a restricted `logic.py`. Declarative where the engine can check it, code where it needs to be expressive.
- **D3.** State-machine transitions can be restricted to `via: action`, so raw PATCH cannot bypass a workflow. This keeps the world faithful to the real software.
- **D4.** Virtual clock: a fixed start, +1 s per write, and an admin-only advance endpoint. Reads do not advance time.
- **D5.** Deterministic IDs (`PREFIX-00001`). Lists have a stable total order. Cursor paging with default 25 and max 100, unless the OpenAPI source says otherwise.
- **D6.** The seed comes from a model-written generator, is run once by the engine and is frozen. The frozen JSONL is the source of truth.
- **D7.** Graders are a declarative DSL with an optional Python escape hatch. Verification includes mutants and collateral checks on top of the spec minimum.
- **D8.** Admin endpoints are under `/_engine/` and hidden from the task-facing API listing.
- **D9.** For description inputs, errors use RFC 7807 with stable `code` strings. For OpenAPI inputs, errors follow the spec's declared error schema.
- **D10.** Failure is a first-class output. `FAILED.md` is written and no passing world is claimed.
- **D11.** WorldGen never writes to `engine/`. This is enforced by path allowlisting in the edit tool.
- **D12.** Authentication: a static bearer token is accepted and identity is not modeled, unless the prompt makes identity part of the workflow (e.g. approvals by role). In that case an `X-Actor` header selects a seeded user.

## 14. Deliverables checklist

| Spec item | Where |
|---|---|
| Engine, one command | `world serve|check|grade|verify` |
| Check with precise errors | `engine/check.py`, diagnostic code catalog in DESIGN.md |
| Serve from a fresh seed / Enforce / atomic | `store.py`, property tests |
| Deterministic and engine-controlled time | `clock.py`, determinism test |
| Inspect, reset and log | `/_engine/state|diff|log|reset` |
| Grade, with noop=0 and ref=1 | `world verify`, plus mutants |
| WorldGen, one command | `worldgen build <input>` |
| Plan saved and followed | `plan.md`/`plan.json`, coverage check |
| Self-repair within budget, knows when to stop | `repair.py`, `FAILED.md` |
| Engine is the judge | Exit codes only; edits restricted by path allowlist |
| Iterates on change requests | `worldgen update` with regression gate |
| Observable, configurable | `build_log.jsonl`, `worldgen.toml` |
| Three input kinds | `ingest/` |
| At least 3 tasks with references, a workflow, realistic seed | Stage 4-5 checks |
| Report | `report.md` with assumptions, omissions and verify output pasted in |
| Design doc | `docs/DESIGN.md` |
| Hand-built world, plus generated worlds | `worlds/helpdesk`, `worlds/generated/*` |

## 15. Open questions for the hiring team (beyond section 12)

- Should worlds carry a "difficulty calibration" in which a reference agent attempts tasks, or is reference-solution verification enough?
- For OpenAPI narrowing, which takes precedence when the real API behaviour is undocumented: stay silent, or make a documented assumption?
- Do you want seed data to resemble production volumes (thousands of rows), or is "paging matters" (hundreds) enough?
- During the live run, may we inspect `plan.md` before stages 2-6 continue, or must it be fully unattended?