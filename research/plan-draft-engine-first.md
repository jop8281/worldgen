# WorldGen: implementation plan (engine-first)

The thesis is that WorldGen's quality is capped by the engine's quality. If the world format is strict and typed, and its errors are precise and point at the exact location, the LLM only needs to fill in a schema while the engine acts as compiler and judge. Most of the design effort therefore goes into the engine. WorldGen then becomes a staged "write file, compile, fix" loop.

---

## 1. Tech stack (decided)

| Concern | Choice | Why |
|---|---|---|
| Language | Python 3.12 | Mature LLM SDKs, Faker, Pydantic. Models write Python-style expressions fluently. |
| Format validation | Pydantic v2 models, exported as JSON Schema | One source of truth. The same schema is the engine's validator and the LLM's tool `input_schema`. |
| Store | SQLite, in-memory, one connection per running world | Real transactions (`BEGIN IMMEDIATE`/`ROLLBACK`), indexes for search and paging, and fast reset through the backup API. |
| HTTP | Starlette + uvicorn | Small and explicit. Routes are generated at load time from the world file. |
| Expressions | Restricted Python expression subset (`ast.parse(mode="eval")` with a node whitelist), statically type-checked against the data model | Models already know the syntax. Type errors are caught at check time. No `exec`, no attributes beyond the model. |
| World files | YAML, split by stage | Diff-friendly and readable by a human. Error paths map 1:1 to YAML paths. |
| Model | Anthropic SDK. Model, effort and budget set in `worldgen.toml` or by CLI flag | Configurable, as the spec requires. |
| CLI | Typer: `wengine` and `worldgen` | One command each. |

The engine handles constraints in two layers. A Python layer validates every write first and produces precise, model-fixable errors. SQLite constraints (FK, UNIQUE, CHECK) are a backstop, so a validator bug can never corrupt state.

---

## 2. Repo layout

```
worldgen-trial/
  pyproject.toml                 # installs `wengine` and `worldgen`
  engine/
    format/      schema.py (pydantic), loader.py (multi-file merge, yaml line map)
    check/       passes.py (schema→refs→types→exprs→workflows→seed→tasks), errors.py (codes, did-you-mean)
    expr/        parser.py (AST whitelist), typecheck.py, eval.py, builtins.py (now, lookup, count, sum)
    store/       sqlite.py (DDL from model), ids.py (counters), snapshot.py
    runtime/     crud.py, workflow.py (guards/effects/timers), clock.py, txn.py, calllog.py
    seedgen/     generators.py, simulate.py, materialize.py
    grade/       grader.py, reference_runner.py, verify.py (noop/ref/prefix/overreach)
    server/      app.py (world routes), admin.py (separate port)
  worldgen/
    pipeline.py  stages/{plan,model,logic,seed,tasks,report,update}.py
    importers/   openapi.py, csv_infer.py   (deterministic, non-LLM)
    llm.py       repair.py  budget.py  telemetry.py (jsonl run log)
    prompts/     one per stage, plus format excerpts generated from the schema
  worlds/
    helpdesk/                    # hand-built reference world
    generated/<slug>/            # WorldGen outputs, each with plan.md, REPORT.md, run.jsonl
  docs/DESIGN.md
  tests/                         # engine golden tests, including error-message snapshots
```

---

## 3. World format

A world is a directory: `world.yaml` (manifest, clock, error shape), `model.yaml`, `api.yaml`, `logic.yaml`, `seed.yaml` (generator spec), `seed.lock.jsonl` (materialized rows plus a hash), `tasks.yaml`, `plan.md`, `REPORT.md`. The loader merges these into one document, and error paths use the merged path plus `file:line`.

### Custom logic: a declarative hybrid with a narrow code escape hatch

- **Declarative first.** Logic is a state machine per stateful entity, plus actions (guards, then effects) and timers. Guards and effect values are typed expressions. This covers about 90% of real workflows (escalation, approval, refunds, audits), is fully statically checkable (unknown fields, wrong enum literals, unreachable states, transitions not declared in the machine), and always runs inside the engine's transaction.
- **Escape hatch.** `handler: py:<fn>` points to a function in `logic.py`. It receives a `ctx` with only `ctx.get/list/create/update/delete/now/fail`. The module is AST-scanned (no imports beyond `math`/`decimal`, no dunder access, no `open`/`eval`), executed with a step limit, and every write still passes through the enforce layer inside the same transaction. The checker flags handler use in the report, because it is less checkable.
- **Why not pure code:** the checker cannot give type-level errors on arbitrary Python, and LLM-written code fails at runtime rather than at check time. **Why not pure DSL:** real APIs sometimes need a loop or arithmetic that a DSL handles badly. Hybrid, defaulting to declarative, is the right trade.

### Concrete snippet: helpdesk with SLA escalation

```yaml
# world.yaml
world: helpdesk
format_version: 1
clock: { start: "2026-03-02T09:00:00Z", step_per_write: "PT1S" }
rng_seed: 1337
errors:   # response shape, so worlds can mimic the real product
  body: { error: { code: "$code", message: "$message", field: "$field" } }

# model.yaml
entities:
  Customer:
    id: { prefix: "CUS-", start: 1 }
    fields:
      name:  { type: string, required: true, max: 120, searchable: true }
      tier:  { type: enum, values: [standard, premium, enterprise], required: true }
  Agent:
    id: { prefix: "AGT-", start: 1 }
    fields:
      email: { type: email, required: true, unique: true }
      team:  { type: enum, values: [tier1, tier2, sre] }
  SlaPolicy:
    id: { prefix: "SLA-", start: 1 }
    unique: [[tier, priority]]
    fields:
      tier:     { type: enum, ref_values: Customer.tier }
      priority: { type: enum, ref_values: Ticket.priority }
      response_minutes: { type: int, min: 5 }
  OnCallShift:
    id: { prefix: "ONC-", start: 1 }
    fields:
      agent_id:  { type: ref, to: Agent, on_delete: restrict }
      level:     { type: int, min: 1, max: 2 }
      starts_at: { type: datetime }
      ends_at:   { type: datetime, check: "ends_at > starts_at" }
  Ticket:
    id: { prefix: "TCK-", start: 1001 }
    fields:
      subject:          { type: string, required: true, max: 200, searchable: true }
      customer_id:      { type: ref, to: Customer, on_delete: restrict }
      assignee_id:      { type: ref, to: Agent, nullable: true }
      priority:         { type: enum, values: [low, normal, high, urgent], default: normal }
      status:           { type: enum, values: [new, open, pending, escalated, resolved, closed],
                          managed_by: ticket_lifecycle }      # plain PATCH cannot set it
      escalation_level: { type: int, default: 0, min: 0, max: 2, readonly: true }
      sla_due_at:       { type: datetime, readonly: true }
      sla_breached:     { type: bool, default: false, readonly: true }
      created_at:       { type: datetime, auto: create }
      updated_at:       { type: datetime, auto: update }
  TicketEvent:
    id: { prefix: "EVT-", start: 1 }
    fields:
      ticket_id: { type: ref, to: Ticket, on_delete: cascade }
      kind:      { type: enum, values: [created, assigned, escalated, resolved, sla_breach, comment] }
      note:      { type: string, nullable: true }
      at:        { type: datetime, auto: create }

# api.yaml
routes:
  - { method: GET,    path: /tickets,       op: list, entity: Ticket,
      filters: [status, priority, assignee_id, customer_id, customer.tier], search: [subject],
      sort: [created_at, sla_due_at, priority], page: { style: cursor, default: 25, max: 100 } }
  - { method: GET,    path: /tickets/{id},  op: get,    entity: Ticket, expand: [customer, assignee] }
  - { method: POST,   path: /tickets,       op: create, entity: Ticket, then: ticket_lifecycle.on_create }
  - { method: PATCH,  path: /tickets/{id},  op: update, entity: Ticket, writable: [subject, priority] }
  - { method: POST,   path: /tickets/{id}/assign,   action: ticket_lifecycle.assign }
  - { method: POST,   path: /tickets/{id}/escalate, action: ticket_lifecycle.escalate }
  - { method: POST,   path: /tickets/{id}/resolve,  action: ticket_lifecycle.resolve }
  - { method: GET,    path: /agents,        op: list, entity: Agent, filters: [team] }
  - { method: GET,    path: /oncall,        op: list, entity: OnCallShift, filters: [level] }

# logic.yaml
workflows:
  ticket_lifecycle:
    entity: Ticket
    state_field: status
    initial: new
    transitions:
      - { from: [new, open, pending], to: open,      via: assign }
      - { from: [new, open, pending], to: escalated, via: escalate }
      - { from: [escalated],          to: escalated, via: escalate }
      - { from: [open, pending, escalated], to: resolved, via: resolve }
    on_create:
      effects:
        - set:
            sla_due_at: >
              now() + minutes(lookup(SlaPolicy,
                tier == self.customer.tier and priority == self.priority).response_minutes)
        - create: { entity: TicketEvent, values: { ticket_id: self.id, kind: created } }
    actions:
      assign:
        input: { agent_id: { type: ref, to: Agent, required: true } }
        effects:
          - set: { assignee_id: input.agent_id }
          - create: { entity: TicketEvent, values: { ticket_id: self.id, kind: assigned } }
      escalate:
        input: { reason: { type: string, required: true, max: 500 } }
        guards:
          - expr: "self.escalation_level < 2"
            error: { status: 409, code: max_escalation, message: "Ticket already at level 2" }
          - expr: "exists(OnCallShift, level == self.escalation_level + 1 and starts_at <= now() and ends_at > now())"
            error: { status: 409, code: no_oncall, message: "No on-call agent for next level" }
        effects:
          - set:
              escalation_level: "self.escalation_level + 1"
              assignee_id: >
                lookup(OnCallShift, level == self.escalation_level + 1
                  and starts_at <= now() and ends_at > now()).agent_id
          - create: { entity: TicketEvent, values: { ticket_id: self.id, kind: escalated, note: input.reason } }
      resolve:
        guards:
          - expr: "self.assignee_id != null"
            error: { status: 422, code: unassigned, message: "Assign before resolving" }
        effects:
          - create: { entity: TicketEvent, values: { ticket_id: self.id, kind: resolved } }
    timers:
      sla_breach:   # evaluated whenever the virtual clock moves
        when: "self.status in ['new','open'] and not self.sla_breached and now() >= self.sla_due_at"
        effects:
          - set: { sla_breached: true }
          - create: { entity: TicketEvent, values: { ticket_id: self.id, kind: sla_breach } }

# tasks.yaml
tasks:
  - id: escalate_breached_enterprise
    difficulty: medium
    instruction: >
      Acme Logistics (enterprise) says their urgent ticket about "label printer offline"
      blew its SLA. Escalate it to on-call with a reason mentioning the SLA. Don't touch
      any other tickets.
    grader:
      checks:                                   # weighted; every one must be false at seed
        - { weight: 0.6, expr: "get(Ticket,'TCK-2207').status == 'escalated'" }
        - { weight: 0.2, expr: "get(Ticket,'TCK-2207').assignee_id == 'AGT-0031'" }
        - { weight: 0.2, expr: "exists(TicketEvent, ticket_id=='TCK-2207' and kind=='escalated' and 'sla' in lower(note))" }
      gates:                                    # multiplicative: any failure makes the score 0
        - unchanged: { entity: Ticket, except: "id == 'TCK-2207'" }
        - unchanged: { entity: [Customer, Agent, OnCallShift, SlaPolicy] }
    reference:
      - call: GET /tickets?customer.tier=enterprise&q=label+printer&status=open
        capture: { tid: "body.items[0].id" }
      - call: POST /tickets/{tid}/escalate
        body: { reason: "SLA breached on urgent enterprise ticket" }
        expect_status: 200
```

---

## 4. Engine design and guarantees

**Check (`wengine check <dir> [--stage model|logic|seed|tasks] --json`)**, ordered passes that stop at the first failing layer:
1. Schema: Pydantic, using YAML-path-aware errors.
2. Name resolution: entities, refs, `ref_values`, route-to-entity, action names, `managed_by`.
3. Expression parse and type-check: field existence through ref traversal, enum literal membership, bool guards, datetime arithmetic.
4. Workflow soundness: every state is reachable from `initial`, every `via` is a defined action, no PATCH route makes a managed field writable, timers are side-effect-bounded (no cycles between timers).
5. Seed: materialize, insert through the enforce layer, check that the lock hash reproduces, and evaluate world `invariants`.
6. Logic scenarios: run them (see §5).
7. Task verification (§6).

Errors are emitted as JSON, capped at 20 and deduplicated:
```json
{"code":"UNKNOWN_ENUM_VALUE","path":"logic.workflows.ticket_lifecycle.timers.sla_breach.when",
 "loc":"logic.yaml:71:9","message":"'opened' is not a value of Ticket.status",
 "hint":"did you mean 'open'? allowed: new, open, pending, escalated, resolved, closed"}
```
Every error code has a fixed message template and a hint. Error-message snapshots are part of the engine's test suite, because they are the engine's interface to the model.

**Enforce.** Every HTTP request runs as exactly one SQLite transaction under a global lock (serialized, so ordering is deterministic). The order is: validate input, check guards, apply effects, validate every touched row (types, required, unique, FK, `check`, readonly/managed), cascade, fire timers, commit. Any failure means ROLLBACK and a 4xx in the world's error shape. A failed call therefore leaves no partial changes, and the clock does not advance. Property test: fuzz random calls, and for each failure assert the state hash is unchanged.

**Determinism.**
- The virtual clock starts at `clock.start`. Each committed write advances it by `step_per_write` (default 1s), which keeps `created_at` strictly ordered. Reads never advance it. Only the admin surface (`POST /_admin/clock/advance {"by":"PT4H"}`) jumps time, and it fires timers in chronological order, each in its own transaction.
- IDs come from per-entity counters stored in the DB (`TCK-1001`, ...). They are restored on reset and are never UUIDs.
- Default list order is id ascending. Every sort gets id appended as a tiebreaker. Cursors are opaque base64 of (sort key, id).
- One RNG, seeded from `rng_seed`, used only by seedgen. Runtime logic has no randomness at all (no `random()` builtin).
- State hash: SHA-256 over canonical JSON of all tables. A test asserts that `serve → reset → state_hash` equals the seed hash.

**Admin surface**, on a separate port so the agent under test cannot reach it: `GET /_admin/state[?entity=]`, `POST /_admin/reset`, `GET /_admin/log` (seq, virtual time, method, path, body, status, diff summary), `GET/POST /_admin/clock`, `POST /_admin/grade?task=`, `GET /_admin/hash`. Reset restores the pristine in-memory DB snapshot through the SQLite backup API, which takes milliseconds.

---

## 5. Logic scenarios (stage-3 tests)

`logic.yaml` carries `scenarios` that the engine runs. These are sequences of calls with `expect_status`, `expect` expressions and `expect_unchanged`. A minimum set is enforced per action: one happy path, one guard-failure path per guard (asserting the status code and that the state hash is unchanged), and one timer test with a clock advance. The checker refuses a world whose actions lack these. This lets "implement logic, then check and test" be verified mechanically.

---

## 6. Graders that discriminate (beyond ref=1 and noop=0)

Graders are declarative expressions over end state. LLM judging is never used, and they are never code. Score = `Σ weight·check × Π gates`. The `wengine verify` harness runs these on a fresh reset each time:

1. **Reference = 1.0.** Captures are resolved by JSONPath, so references can search and page rather than only hardcode IDs.
2. **Noop = 0.0**, under a stricter rule: *each individual check* must be false at seed. This kills graders like "ticket is assigned" where the ticket was already assigned.
3. **Prefix runs < 1.0.** Each strict prefix of the reference's write steps must score below 1. This proves every write matters. Steps marked `optional: true` are exempt.
4. **Overreach mutant = 0.0.** The engine replays the reference, then applies the same action to one extra entity that matches the reference's search filter, picked by the seeded RNG. The gates must zero it. This forces collateral-damage checks into every task.
5. **Wrong-target mutant < 1.0.** The engine re-runs the reference with the captured ID swapped for a sibling of the same entity.
6. **Gate coverage lint.** Every entity the reference writes must appear in an `unchanged ... except` gate, or the task must declare `collateral: allowed` with a reason.

Difficulty rubric (enforced by lint): **easy** means one write and an ID derivable from the instruction. **medium** means search plus a workflow action. **hard** means one of three things: more than 2 entities with paging needed (target outside page 1), clock or timer reasoning, or a bulk operation over N≥5 records where exactly the right set must change (graded by set equality, e.g. `set(ids(Ticket, sla_breached and status=='escalated')) == set(…)`).

---

## 7. Seed data at scale

The LLM writes a seed generator spec, not rows. The engine materializes it deterministically.

```yaml
seed:
  counts: { Customer: 300, Agent: 40, OnCallShift: 56, Ticket: 2500 }
  anchors:   # named rows that tasks reference; fixed IDs
    - { entity: Customer, id: CUS-0042, name: "Acme Logistics", tier: enterprise }
  fields:
    Customer.tier: { weights: { standard: 70, premium: 22, enterprise: 8 } }
    Ticket.subject: { template_pool: helpdesk_subjects, vary: [product, symptom] }
  simulate:   # workflow entities are evolved through real actions
    entity: Ticket
    window: { from: "-P60D", to: "now" }
    arrivals: { per_day: 40, weekday_factor: 1.4 }
    policy: { assign: 0.9, escalate: 0.12, resolve: 0.75 }
```

Key decision: **seed by simulation.** Workflow entities are created in their initial state and then evolved by calling real actions on the engine while the virtual clock runs over a 60-day history. Every row's state is therefore legal *by construction*: events exist, timestamps are monotonic, and breached SLAs really were breached. The world clock then starts at the simulation end. Static entities use Faker (seeded) plus weighted choices plus ref sampling. The result is frozen into `seed.lock.jsonl` with a hash. Scale target is 1k–10k rows for core entities, with a default page size of 25, so paging always matters. For CSV input, the CSV rows become anchors and value pools, and distributions are fitted from them.

---

## 8. WorldGen pipeline

`worldgen build "<prompt>|spec.yaml|data.csv" -o worlds/generated/x [--model ... --budget-usd 5 --max-repairs 4]`

| Stage | Output | Judge |
|---|---|---|
| 0 Ingest | OpenAPI goes through a *deterministic* importer to model/api skeletons (paths, shapes, error codes preserved, `--narrow tag/path`). CSV goes through type/key/FK inference. | None (code) |
| 1 Plan | `plan.yaml` (entities, routes, workflows, candidate tasks, **assumptions[] with rationale**, **out_of_scope[]**) and a rendered `plan.md` | Schema check, plus a lint that ≥1 workflow has ≥3 states |
| 2 Model+API | `model.yaml`, `api.yaml` | `check --stage model` |
| 3 Logic | `logic.yaml` (+ optional `logic.py`), with scenarios | `check --stage logic`, which runs the scenarios |
| 4 Seed | `seed.yaml`, materialized lock | `check --stage seed` |
| 5 Tasks | `tasks.yaml` with ≥3 tasks across difficulties | `verify` (all six checks in §6) |
| 6 Report | `REPORT.md`, assembled mostly from data: the plan's assumptions, the final check/verify JSON output, per-task scores table, repair history, cost | None (template plus a short LLM summary) |

The stage prompt contains the JSON Schema for that stage's file, the plan, the prior stages' files, and a few-shot excerpt from the hand-built helpdesk. The model writes the file with a tool call whose `input_schema` is the stage schema, so structure is enforced at decode time.

**Repair loop:** run the engine check. On failure, send the error JSON plus the offending file region back to the model. The model returns either a full file rewrite (for files under ~300 lines) or a list of `{path, op, value}` patches. Re-check. Budget is per stage (attempts) and global (USD/tokens). If the same error code repeats at the same path 3 times, escalate once: re-plan that stage with the higher-effort model. If a stage fails because of an upstream stage (e.g. a task needs a field that doesn't exist), the loop may reopen the upstream stage once.

**Stopping:** when the budget is exhausted, the output is written to `<out>.failed/`, never to `<out>`, along with `FAILURE.md` listing the remaining errors, what was tried, and the suspected cause. The exit code is non-zero.

**Guardrails:** WorldGen only writes inside its output dir. The engine is an installed dependency invoked through a subprocess or library call, with the version pinned in `world.yaml`. Pass/fail is only ever decided by the engine's exit code.

**Iterate:** `worldgen update worlds/x "add refunds"` loads the world, and the model produces a *plan delta* (added, changed or removed entities, routes, workflows and tasks). Only affected stages re-run. Seed re-materializes deterministically: unchanged entities keep identical rows (per-entity RNG streams are seeded from `rng_seed + entity name`), so existing tasks keep passing. Every existing task is re-verified, and regressions are a failure.

**Observability:** `run.jsonl` holds one event per stage start/end, LLM call (model, tokens in/out, $, latency), check result and repair attempt. A live console summary is shown, and the totals go into `REPORT.md`.

---

## 9. Milestones (assuming about 10 working days)

1. **D1–3 Engine core:** format schema, check passes 1–4 with error snapshots, SQLite store, CRUD and paging, workflows, transactions, clock, admin.
2. **D3–4 Hand-built helpdesk** (the snippet above, full): seedgen with simulation, scenarios, grader and verify harness including the mutants.
3. **D5–7 WorldGen** stages 1–6, repair loop, budget, telemetry. Three internal test prompts (IT asset tracker, CRM, payments).
4. **D8 Importers** (OpenAPI, CSV) and `update`.
5. **D9 Hardening:** run about 15 unseen-style prompts and tune prompts and error hints on the failure clusters. Measure first-pass vs post-repair success rate.
6. **D10** DESIGN.md, generated worlds, demo script.

---

## 10. Risks

- **DSL expressiveness gaps** (e.g. proration math, multi-row aggregates). Mitigation: rich builtins (`sum/count/min/max/lookup/exists`) and the `py:` escape hatch.
- **Grader overfitting**, where the reference passes but brittle checks penalize valid alternative solutions. Mitigation: checks assert outcomes, not paths, and the lint rejects checks on event `note` text unless the instruction requires it.
- **Simulation slowness** at about 10k rows. Mitigation: batch the simulation inside one transaction per simulated day and cache the lock file.
- **Repair oscillation.** Mitigation: the repeated-error escalation rule and a hard budget.
- **Fidelity vs checkability:** real APIs have quirks (e.g. Stripe's expandable objects). Mitigation: support `expand` and custom error shapes early.

---

## 11. Open questions for the hiring team

1. Should the agent under test ever be graded on its *answer* (e.g. "how many tickets breached?"), or only on end state? If answers count, I'd add a `POST /_task/answer` channel graded by expressions.
2. Does auth or multi-tenancy matter? I plan to support a single API key with no roles unless you say otherwise.
3. Should virtual time advance on its own during an agent run (per call), or only via an explicit harness? My default is +1s per write, with jumps only from the admin.
4. What scale and latency do you expect: is 10k rows per world and under 2 minutes per WorldGen run reasonable for the live session?
5. For OpenAPI inputs, should undocumented behaviour (status transitions not in the spec) be invented and logged as assumptions, or left out?
6. Which models and credit ceiling should the live run assume?