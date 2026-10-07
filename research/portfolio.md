# Reference-target portfolio (KISS selection, 2026-10-06)

Inputs: the seven studies (stripe, linear, uber, localstack, duckdb-bigquery, mock-data, showcase) and the spec at /Users/yossieliaz/worldgen/research/spec.md.
The spec requires three input kinds (description, OpenAPI, CSV), one hand-built world, the generated worlds, and a live run on unseen prompts.
The selection follows that list directly.

## 1. Decisions in one paragraph

- Four targets get build time before D7: **helpdesk** (golden world), **Stripe** (OpenAPI), **Linear** (CSV), and **tau2 retail** (description plus a policy reference).
- **Uber** goes in as a prompt-only rehearsal case. It gets no build time: no priors pack and no checker.
- **SQS/moto**, **BQ Lite on DuckDB**, the **Uber TLC priors**, the **Linear live differential** and **rank-correlation fidelity** are post-trial ideas. DESIGN.md names them.
- The engine stays REST JSON with JSON request bodies, including for Stripe. Form encoding lives only in the test harness that talks to stripe-mock.
- DuckDB is not used in the trial. No study shows it deleting work at our data sizes (see section 3).

## 2. Decision table

Hours are build time for the target only. Engine core and the seed interpreter are counted in section 3 and the engine plan.

| Target | Role | Input | Reference | Check | Priority | Milestone | Hours |
|---|---|---|---|---|---|---|---|
| helpdesk | (a) Golden hand-built world. (b) Description rehearsal "helpdesk like Zendesk", compared with the golden world | Hand-written world, plus a 1-line description | The world's own model and state machine. The golden world is the reference for the generated one | Verify gates (ref=1, noop=0, replay hash, collateral, decoys). Seed lints. PROOF.md through `worldplay prove`. Mutation table. Failure pack | must | D2 world loads and seeds, D3 PROOF.md and prove green | 6 |
| Stripe | (b) OpenAPI rehearsal. (c) Fidelity. Update demo "add refunds" | `openapi/spec3.json` from github.com/stripe/openapi, MIT, 8,317,513 B, pinned to release v2543 by sha256. Pruned in code to customers, payment_intents and charges (v1), then refunds (update) | The spec itself. stripe-mock v0.206.0 (MIT, 5.4 MB binary) as a shape and envelope oracle only, because it is stateless | Must: static conformance. Every route maps to a spec path and method. Fields exist with compatible types. Served 2xx bodies validate against the spec schemas with `jsonschema`. Should: about 40 calls diffed against stripe-mock on status code, top-level keys, JSON types, `object` and id prefix. The report says plainly that state is not covered | must (static), should (stripe-mock diff) | D2 generic prefix pruner. D3 world passes gates. D5 static conformance green. D6 "add refunds" diff with v1 vectors unchanged. Should: D6 stripe-mock diff | 9 + 2 should |
| Linear | (b) CSV rehearsal, with real data the reviewers know | CSV export of our own WG backlog, about 50 rows, redacted (see Q2). Export rules from linear.app/docs/exporting-data | T1: the CSV itself. T2: Linear SDL (MIT, 1,335,039 B) frozen to 8 core types and enum vocabularies | Must T1: row count equal. 100% of Team, Project, Assignee, Labels and Parent cells resolve. State category matches hand labels on at least 90% of rows. Relations reported as absent, not guessed. Should T2: SDL coverage at least 0.80 and no `stricter_than_real`. The .mjs prototype gets ported to Python (one-language rule) | must (T1), should (T2) | D5 T1 green. D6 T2 | 3 + 2 should |
| tau2 retail | (b) Description rehearsal (main one). (c) Policy fidelity. Should: second CSV case | `policy.md` (6,699 B) and `db.json` (2,811,616 B) from github.com/sierra-research/tau2-bench, MIT at repo level. `db.json` converted to `orders.csv` in code | The written policy rules, plus the `db.json` entity shapes and status mix | Should: a policy probe pack of about 12 probes, each with an expected status class (2xx, 4xx validation, 4xx conflict). Report k/12. The probe-to-route adapter lives outside worldgen. Could: `db.json` field coverage, reported as coverage and not as pass or fail | must (prompt), should (probes, CSV) | D4 prompt in suite and green. D6 probe pack | 1 + 4 should + 1 should |
| Uber | (b) Description rehearsal only. It stresses clock jobs, integer-cent money, two-entity atomic accept and the 409 confirm | 1-paragraph description written by us. No download | None in trial | Suite rubric only: expected states, at least 1 job, 3 tasks, and an assumption log that lists fees and timeouts | must (prompt only) | D4 | 0.5 |
| Petstore v3 | (b) OpenAPI smoke case. Proves the pruner is not Stripe-specific | github.com/swagger-api/swagger-petstore, Apache-2.0. Size unverified | The spec | Same static conformance as Stripe | could | D5 | 0.5 |
| mock-data | Seed stack for all worlds. Not a world target | Seed spec written by the LLM in stage 4 | Engine lints plus the replay hash | Generate twice and compare hashes. Generate N+100 rows and confirm the old rows are byte-identical. CSV mode: state shares and null rates within 3 points of the source CSV | must | D2 to D3 interpreter and lints. D4 pools and repair wiring. D5 CSV profile | engine budget (about 11) |
| showcase | Narrative and evidence. Not a world target | n/a | n/a | PROOF.md, `prove`, failure pack, mutation table, stop gallery, sealed set, rehearsal summary | must | D3, D4, D7, D8 | showcase budget (about 15) |
| SQS (botocore + moto) | (d) Post-trial. Related-work paragraph | botocore `sqs/2012-11-05/service-2.json`, Apache-2.0, 157,139 B | moto 5.2.3 (Apache-2.0) | Not built | wont, plus a must paragraph in DESIGN.md | D8 paragraph | 0.5 |
| BQ Lite (DuckDB) | (d) Post-trial | BigQuery discovery doc, licence unverified | goccy/bigquery-emulator, details unverified | Not built | wont | none | 0 |
| Uber TLC priors | (d) Post-trial | TLC HVFHV parquet. City of NY terms, unread | Quantile lint | Not built | wont | none | 0 |
| Linear T3 live diff | (d) Post-trial, or D8 only if everything is green | Real Linear, team WGT | Real Linear GraphQL | 5 normalized scenarios | could, after the D7 freeze | D8 | 4 time box |

**Build time before D7:** about 20 h must and about 9 h should, across the 4 build targets. Uber and Petstore add 1 h of prompt writing.

## 3. Mock-data decision

**Stack:**
- **A seed-spec interpreter we own.** It handles:
  - per-row RNG streams: `sha256(world_seed/entity/index)`;
  - `state_mix`;
  - history derived from the same workflow the engine enforces, so state and history cannot disagree;
  - time anchored before t0;
  - anchors and decoys;
  - lints with precise codes that feed the repair loop: `fk.*`, `inv.*`, `history.illegal`, `time.*`, `unique.*`, `dist.state_mix`, `dist.fk_concentration`, `anchor.not_unique`, `paging.too_few_rows`.
- **LLM-written pools** for domain text. They are frozen into the seed spec, so replay makes no LLM calls.
- **mimesis 22.2.0 (MIT), pinned with `==`**, for generic values only. Only whitelisted, seedable providers are allowed.

**Cut:**
- **Faker.** A second library for the same job. Its output can drift across patch versions. mimesis was about 50x faster in the benchmark (0.015 s against 0.766 s for 20k names).
- **SDV.** BUSL-1.1 licence, a torch dependency, and it knows nothing about state machines or anchors.
- **DuckDB.** CSV profiling at our sizes (50 to a few thousand rows) is a stdlib `csv` pass of about 80 lines. It covers per-column type tries, null rate, exact distinct count, top values and mixed-format flags. That is the "no silent guessing" evidence, and DuckDB's sniffer would hide it by falling back to VARCHAR. events.jsonl rollups are a few lines of Python. So DuckDB deletes no real work and would add a dependency of roughly 15 to 22 MB. Revisit only if a live CSV prompt turns out to be parquet or larger than about 100 MB.

**Simplification:**
- The CSV profile writes `choice{}` weights and null rates straight into the seed spec at plan time.
- The interpreter therefore needs no `profile:` generator kind. That is one generator fewer.

**Generator set (closed):** `mimesis:<whitelisted>`, `pool:`, `choice{}`, `range{}`, `ref{entity,skew}`, `sample{}`, `derive:`.

## 4. Showcase plan

**The one claim:** "The engine is the only judge, and we test the judge."
- The narrative answers three questions in order:
  1. Is the engine strict?
  2. Are the worlds faithful, or just convenient?
  3. Will worldgen behave on your prompt?
- Every claim in DESIGN.md links to a command.

**Story arc in the demo (about 20 min):**
1. Fresh clone: `uv sync` and `uv run pytest -q`.
2. **Strict engine.** `worldplay check` on a broken helpdesk shows a catalog error. Then `worldplay prove` on the golden helpdesk prints:
   - the verify table (ref 1.00, noop 0.00, decoys and partial runs below 1, replay hash equal);
   - the mutation table at 4/4;
   - the failure pack, with state hash and clock unchanged.
3. **Faithful, not convenient.** One slide-free terminal table that shows:
   - Stripe static conformance, plus the stripe-mock envelope diff if it is done;
   - tau2 policy probes as k/12;
   - Linear T1, plus T2 coverage if it is done.

   We claim "shape and rule conformance" and never "behaves like real Stripe".
4. **Their prompt, live.** `worldgen "<prompt>"` with a budget cap. `plan.yaml` and its assumptions are written first. Then `worldplay prove` runs on the output independently.
5. **Iterate.** "add refunds" on the Stripe world, or their own change. The plan delta is shown and the v1 verify vectors are preserved.
6. **Honest stop**, if one happens. Open `.STOPPED/REPORT.md` next to the matching stop in the gallery.

**Fallbacks:**
- `worldgen replay` from the LLM cache.
- The D8 sealed-set worlds.

**Evidence files:**
- `eval/runs/<date>/summary.md`: about 12 cases, each run twice. It reports pass rate, pass^2, time, cost, repairs per stage next to AWM's 1.13, and stops by reason.
- The sealed prompt hashes, committed on D4 and opened on D8.
- `eval/stops/`.

**Rehearsal suite by input kind (D4 onwards):**

| Kind | Cases |
|---|---|
| Description | tau2 retail `policy.md`, helpdesk, Uber ride-hailing, plus 2 to 3 of our own. The stop-gallery prompts are separate |
| OpenAPI | Stripe narrowed, Stripe "add refunds" update, Petstore (could) |
| CSV | Linear backlog, tau2 `orders.csv` (should), mock-data `tickets.csv` fixture (smoke) |

## 5. What was cut and why

- **LocalStack as a reference.** The repo was archived on 2026-03-23. It now needs an account, an auth token and Docker. Docker is absent here, and the free plan is non-commercial.
- **SQS through botocore.** Not OpenAPI, so it needs a converter. It also needs an X-Amz-Target adapter, and the moto clock differential depends on freezegun, which is unverified. That is 12 h for a fourth protocol story.
- **DynamoDB and S3.** S3 is rest-xml with binary payloads. DynamoDB brings a large expression language.
- **BQ Lite.** A new "SQL-backed entity" kind widens an engine the spec says to keep small and strict. Dialect gaps (backticks, `SAFE_CAST`, `EXCEPT`, `STRUCT AS`) would penalise agents for our choices. Effort is 10 to 16 h.
- **Uber TLC priors and the distribution lint.** The data terms are unread. The prior hook risks overfitting one domain. A description world does not need real quantiles to pass the gates.
- **A hand-written Linear world.** It duplicates the golden helpdesk: issue tracker against ticket tracker. Linear's value is the CSV input path and the SDL check, not a second hand world.
- **Form-encoded requests and the Stripe error envelope in the engine.** These keep the engine pure REST JSON. The stripe-mock harness form-encodes only its own side. The deviation is logged as a `Spec:` decision (see Q1).
- **GraphQL ingest or facade, AWS wire protocols, Linear T3 before the freeze, rank correlation, failure injection, the agent difficulty ladder (unless D7 has slack), and stripe-mock `expand[]` and idempotency.** All are scope with low trust value per hour.
- **Faker, SDV and DuckDB.** See section 3.

## 6. Questions for the user (no experiment settles these)

**Q1. How closely must a world copy the real API's wire format?**
- Options:
  - (A) Engine-uniform JSON bodies and error envelope. Real status codes and a documented code map to the real error types.
  - (B) Per-world envelope templates, for example Stripe's `{"error":{type,code,param}}`, with JSON requests.
  - (C) Full mimicry, including form-encoded requests.
- **Recommendation: B.** It is cheap (a template in the world format) and visibly "follows its errors". C pushes protocol code into the engine.

**Q2. May a redacted export of our own Linear backlog be committed to the repo the hiring team receives?**
- Options:
  - (A) Commit it redacted: names, emails and free-text descriptions scrubbed.
  - (B) Commit a synthetic look-alike with the same columns and quirks, and keep the real file local.
  - (C) Ship only the export script and the instructions.
- **Recommendation: A** if company policy allows. The fallback is B. Real data the reviewers recognise is the point of this case.

**Q3. What per-run cost and time ceiling is acceptable for the live worldgen run?**
- Options:
  - (A) Tight: about $2 and 10 minutes. Higher stop risk.
  - (B) Medium: about $5 and 15 minutes.
  - (C) No hard cap: report cost after the run.
- **Recommendation: B**, as a hard cap in config, revised after real costs are measured on D4. Stops on the cap are shown as designed outcomes.
