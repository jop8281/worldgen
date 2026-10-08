# Rehearsal rubric

This is the scoring sheet for each world that WorldGen generates in the stress runs (YOS-53, YOS-54) and in the timed live rehearsal (YOS-58). It is based on [spec.md](spec.md), [spec-traceability.md](spec-traceability.md) and [rehearsal-prompts.md](rehearsal-prompts.md).

The rubric has two layers:

- **Gates.** Pass or fail facts that the engine and the run artifacts prove. If any gate fails, the run fails, whatever its scores.
- **Scores.** Five dimensions, each scored 0, 1 or 2, by someone reading the artifacts. They cover the "Good world" qualities that no code check enforces yet: traceability gaps 3–6 are scored here until a lint covers them.

**Who scores.** A person, or a model session separate from the WorldGen run under test, reading the artifacts only. WorldGen never scores itself, as the spec says: "never grades its own work by asking the model". The scorer does not rerun or edit anything. If the scorer is torn between two anchors, they take the lower one and give the reason in the note.

**Artifacts read.** For each run directory: `plan.yaml`, `REPORT.md` (or `FAILURE.md` on a stop), `world.yaml`, `runs/<runId>/events.jsonl`, and the output of the two engine commands below. The engine CLI is `worldplay` (A-52).

```sh
bun run worldplay check  <dir> --json
bun run worldplay verify <dir>
```

## 1. Gates

These apply to every prompt that is expected to produce a world (kind `normal` or `vague`). Section 4 covers the gates for `impossible` prompts.

| Gate | Passes when | Proven by |
|---|---|---|
| **R: run done** | The run ended `done`, exited 0, and wrote `world.yaml`. A stop fails this gate | exit code; `run_finished` event with `worldWritten: true` |
| **C: check clean** | `worldplay check` exits 0 with zero errors. Record the warnings, but they do not fail the gate | check output |
| **V: verify green** | `worldplay verify` exits 0, and every task meets the A-47 hard gates: solution 1, noop 0, same state hash on replay, collateral gate, and for medium and hard tasks a decoy below 1 with every strict prefix below 1 | verify output, one line per task |
| **T: three tiers** | At least 3 tasks, with at least one each of easy, medium and hard | `world.yaml` tasks; `world.too_few_tasks` and `tasks.difficulty_not_spread` absent from check |
| **B: budget** | Total cost ≤ **$5** and wall time ≤ **15 min**, the A-48 defaults, both read from `events.jsonl`. Use the default config, with no overrides | sum of `costUsd`; first to last event timestamps |
| **A: artifacts** | `plan.yaml`, `REPORT.md` and `events.jsonl` exist, and every step that ran has an attempt event with `ms` and `costUsd` | files on disk |
| **O: OpenAPI coverage** (OpenAPI inputs only) | Every kept operation has a route or action with the same method and path, and `meta.api.error` matches the source envelope (A-49). In other words, no `plan.not_covered` from `inputCoverage` | check output |

The cost in gate B is the CLI's client-side estimate (see [claude-cli-transport.md](claude-cli-transport.md) §2), not the bill. If the transport did not record a cost, gate B fails, because without a recorded cost the budget is unproven.

## 2. Scored dimensions (0–2 each, total 0–10)

Each dimension is judged against the software named in `plan.yaml` `software`. For OpenAPI and CSV inputs, it is judged against the source file.

### F: Fidelity to the named software

| Score | Anchor |
|---|---|
| 0 | Generic CRUD that could be any app, or the plan names an analog the world does not resemble. Or the world contains shortcuts that suit the agent, not the product, such as a `PATCH status` that skips the workflow the real product enforces, or a `/do_task` action. |
| 1 | The analog is recognisable, with real resource names and the core entity present. At least one notable divergence is not recorded as an assumption: a missing core entity, made-up states, wrong status codes, or transitions much looser or stricter than the real product. |
| 2 | Resource names, states, status codes and the error envelope match the real product, or every divergence is listed in `assumptions` with a reason. For OpenAPI, paths, methods and error bodies follow the source (gate O plus spot checks of 3 operations). |

### W: Workflow depth

| Score | Anchor |
|---|---|
| 0 | Plain reads and writes only, or the only action sets one field with no guard. |
| 1 | One workflow with at least 3 states and at least 1 guard. A world test exercises it, and the guard refuses an invalid move with 409 or 422. |
| 2 | Everything for 1, and the rules the prompt names are implemented (for example "return to depot after three failed attempts", or "needs both approvals"). There is also a cross-entity effect or a time-driven job. Every action has a test, so `action.unexercised` is empty. |

### S: Seed realism

Check three things. **Mix:** every declared state has rows and no state holds more than 70%. **Paging:** every entity with a list route has at least 3 × pageSize rows. **Consistency:** sample 10 rows of the main entity. Timestamps must be ordered (created ≤ updated ≤ resolved), derived fields must agree (totals, balances, counts), references must make sense (an agent is assigned only to tickets in their queue), and the text must be plausible, not lorem or `item 1`.

| Score | Anchor |
|---|---|
| 0 | Two or three of the checks fail. |
| 1 | Exactly one check fails. |
| 2 | All three pass, with zero `seed.*` warnings from check. |

### T: Task quality

| Score | Anchor |
|---|---|
| 0 | Every solution writes to a known id with no read first. Or an instruction leaks ids or internal field names. Or a grader checks the order of calls rather than the end state. |
| 1 | At least one task needs a read (search, filter or paging) before its write. Decoys are plausible mistakes, and instructions read like a user's request. |
| 2 | The medium and hard tasks both need reads, and the hard one spans more than one page or more than one entity. Decoys model realistic agent errors (partial work, wrong target, a skipped workflow step). Graders check outcomes only, and include a collateral check. |

### H: Report honesty

| Score | Anchor |
|---|---|
| 0 | A REPORT.md section is missing (built, assumed, left out, proof, run). Or the report claims something the world lacks. Or the world clearly guessed something (enum values, rules, limits not in the prompt) and `assumptions` is empty. |
| 1 | All sections are present, but at least one obvious guess is missing from `assumptions`, or the reasons are boilerplate. |
| 2 | Every non-trivial guess is listed with its reason. Items left out are named. The proof numbers equal the `verify` output, and the cost and minutes equal `events.jsonl`. |

## 3. Vague prompts

Vague prompts are prompts 14–18 in the bank, plus `bakery-vague`. They are gated and scored like normal prompts, with three additions.

- **Analog named.** `plan.yaml` `software` must name one concrete product or category, such as "fleet maintenance tracker". A grab-bag of every possibility fails this check.
- **Assumptions.** `plan.assumptions` has at least 3 entries, and the same list appears in REPORT.md (the YOS-45 bar).
- **H is at least 1.** A vague prompt with H = 0 fails, even with every gate green. Silent guessing on a vague prompt is exactly what the spec rules out ("no silent guessing").

Fidelity (F) is judged against the analog the plan picked, not against the prompt's wording.

## 4. Impossible prompts

Impossible prompts are prompts 19 and 20 in the bank, plus `video-codec-impossible`. Gates C, V and T do not apply. The outcome is classified as one of four classes:

| Outcome | Definition | Result |
|---|---|---|
| **STOP-HONEST** | The run stopped (`input_rejected`, or another stop) with a non-zero exit and no `world.yaml`. The stop report (`REPORT.md` "Stopped:" or `FAILURE.md`) names the actual blocker, for example "forecast accuracy is not world state a deterministic engine can grade", or "needs a live external feed and wall-clock time". It also suggests a narrower request. Within budget (gate B). | **pass** |
| **REFRAME-HONEST** | The run finished a world for a narrower analog (for example a paper-trading brokerage). The reframe is the **first** assumption, the impossible part is in `outOfScope`, and gates C, V, T and B pass. | **pass**, flagged `reframe` |
| **STOP-UNRELATED** | The run stopped for another reason (`attempts_exhausted`, `budget_exhausted`, `no_progress`) and never names the real blocker. | **fail** |
| **DISHONEST** | The world claims the impossible capability, such as a `predict` route that returns made-up prices with no assumption saying so, or a "live feed" that is really seed data presented as live. | **fail**, whatever the gates say |

For an impossible prompt, only H is scored, as 0–2. The bank's "good result" column is the reference: the scorer quotes its key phrase in the note and marks whether the stop report or reframe matches it.

## 5. Matching the bank

For every prompt from [rehearsal-prompts.md](rehearsal-prompts.md), the scorer also records **bank: Y / P / N**, meaning whether the world delivers the specific behaviour in that prompt's "good result" column: Y fully, P partly, N not at all. This catches worlds that score well in general but miss the point of the prompt. For example, a delivery world with no third-attempt rule would get bank N even with W = 1.

## 6. One-line summary per run

Each run is one row in `summary.md`. The columns match the eval-suite summary (YOS-51), plus the scores.

```
| id | kind | outcome | gates | F W S T H | /10 | bank | $ | min | note |
```

- **id**: suite case id or bank number (`b07-or-scheduling`).
- **kind**: `normal`, `vague`, `impossible`, `openapi`, `csv` or `change`.
- **outcome**: `PASS`, `FAIL`, `STOP-HONEST`, `REFRAME-HONEST`, `STOP-UNRELATED` or `DISHONEST`.
- **gates**: `ok`, or `fail:` followed by the failed gate letters (`fail:V,B`). Use `n/a` for an impossible stop.
- **F W S T H**: five digits separated by spaces. Use `-` for a dimension not scored.
- **bank**: `Y`, `P`, `N` or `-`.
- **$** and **min**: from `events.jsonl`, with 2 decimals for $ and 1 decimal for minutes.
- **note**: no more than 80 characters, naming the single biggest problem, or the stop reason for a stop.

Example rows:

```
| b01-expenses      | normal     | PASS           | ok       | 2 2 1 2 2 | 9  | Y | 3.12 | 11.4 | seed: approved_at before submitted_at on 3/10 rows          |
| b11-registration  | normal     | FAIL           | fail:V   | 2 1 2 1 1 | 7  | P | 4.80 | 14.9 | hard task prefix scores 1; waitlist promote untested        |
| b14-trucks        | vague      | PASS           | ok       | 1 1 2 1 2 | 7  | Y | 2.95 |  9.8 | fleet-maintenance analog, 5 assumptions                     |
| b19-stock-predict | impossible | STOP-HONEST    | n/a      | - - - - 2 | -  | Y | 0.41 |  1.2 | input_rejected: forecasts not gradable; suggests paper-trading |
| b20-atc-live      | impossible | STOP-UNRELATED | n/a      | - - - - 0 | -  | N | 5.00 | 15.0 | budget_exhausted at workflow; never names live feed         |
```

For a FAIL, the scores are still filled in. They show what to fix even when a gate decided the result.

## 7. Totals at the bottom of `summary.md`

- **Pass rate** = (PASS + STOP-HONEST + REFRAME-HONEST) / runs. Targets: at least 70% in stress run 1 (YOS-53) and at least 85% in stress run 2 (YOS-54).
- **Mean score** over PASS rows only, and the count of PASS rows with any dimension at 0.
- **Median and p95** for $ and minutes. The p95 minutes is what tells us whether A-48's 15 minutes is the right cap (traceability gap 2).
- **Gate failure counts** by letter, and the **top 3 notes** grouped by cause. These feed the generic fixes YOS-53 asks for, and no fix may target a single prompt.
- **Live rehearsal (YOS-58) only:** minutes to the first passing `verify` for each prompt, and whether anyone touched anything during the run (it must be "no").
