# Release 1 qualification baseline

Decision recorded in [A-71](decisions.md#decision-log). The named baseline is `main` at `3b75bad125bb154f0258856abd463b0e6bccc626` (PR #132). This is an audit baseline, not an approved release freeze: its main-branch gate is red. Do not accept live datasets or start YOS-53's broad stress run against it.

## Gate evidence

GitHub Actions run 37559284277 (old repo) for the exact SHA completed with `check` and `e2e` failing. `npm run check` reported 2,506 tests: 2,401 passed, 3 failed, 0 skipped and 102 TODO. Typecheck passed. The remaining 13 E2E steps passed, including helpdesk check/verify, HTTP serving and admin operations, CLI help and generated-doc freshness; E2E failed because its test step failed.

| Failing test | Observed failure | Owner / next action |
|---|---|---|
| `R11 WORLDPLAY_HOST sets the bind host and --host overrides it` | Expected exit code `0`, got `null` after the CLI printed the world/admin URLs and two seed warnings. | YOS-105 qualification; determine why the child CLI's exit status is not observed. |
| `R11 WORLDPLAY_ADMIN_HOST sets the admin bind host and --admin-host overrides it` | Expected exit code `0`, got `null` after the CLI printed the world/admin URLs and two seed warnings. | YOS-105 qualification; same child-process assertion area, track separately until rerun proves both. |
| `G-23 RT-114 while(true) in a handler fails the world tests` | Child process was killed after 300,000 ms; expected the handler timeout to return a failed world test. | YOS-114, active; PR #152 is the nested-reply fix under review. Rerun this case and the full gate after integration. |

There were **no skipped tests** in this run. The two `ENGINE-BUG` TODO cases are EB-check-1: cyclic fixture/decoy values render `found` as `[object Object]`. The finding is low severity and owned by engine-check-core; it does not block valid-world execution, but remains an explicit defect in [redteam-findings.md](redteam-findings.md).

## TODO inventory

The 102 TODO tests are intentionally non-gating because their contract questions are unresolved. Each RT id below links to its question in [redteam-contract.md](redteam-contract.md); the named spec-call file records the decision needed. Counts are from this exact CI run, not the older counts in `code/test/redteam/README.md`.

| Area / decision file | TODO count | RT ids and test counts | Owner and reason |
|---|---:|---|---|
| API semantics — [redteam-api-semantics.md](spec-calls/redteam-api-semantics.md) | 25 | RT-12 (1), RT-18 (4), RT-38 (4), RT-43 (1), RT-121 (5), RT-122 (1), RT-123 (1), RT-124 (3), RT-125 (1), RT-126 (4) | YOS-73 for R2 API fidelity; YOS-93 owns release-scope tracking. The OpenAPI/CSV/API-fidelity portfolio is outside R1, and the exact edge semantics are not specified. |
| Clock and jobs — [redteam-clock-jobs.md](spec-calls/redteam-clock-jobs.md) | 10 | RT-20 (1), RT-22 (2), RT-24 (4), RT-27 (1), RT-90 (1), RT-115 (1) | YOS-93 owns the deferred contract calls. These tests ask about invalid clock inputs, zero duration, job time and catchable helper errors; the documented R1 clock path remains separately covered. |
| Grading and verification — [redteam-verification.md](spec-calls/redteam-verification.md) | 17 | RT-07 (2), RT-08 (2), RT-10 (2), RT-21 (1), RT-25 (1), RT-31 (1), RT-62 (1), RT-63 (1), RT-65 (3), RT-66 (1), RT-67 (1), RT-87 (1) | YOS-93 owns release triage. These are optional grading policies or exact edge/error/count semantics not committed in the R1 contract; do not treat them as proven. |
| Check report — [redteam-check-report.md](spec-calls/redteam-check-report.md) | 12 | RT-14 (1), RT-15 (1), RT-42 (1), RT-80 (2), RT-81 (1), RT-82 (1), RT-83 (1), RT-84 (1), RT-85 (1), RT-88 (1), RT-89 (1) | YOS-93 owns release triage; YOS-84 is the later broken-world corpus. Questions concern unknown keys, issue aggregation, bounded diagnostics, blocked layers and recursive/deep inputs, rather than acceptance of the current valid helpdesk world. |
| Sandbox — [redteam-sandbox.md](spec-calls/redteam-sandbox.md) | 25 | RT-35 (9), RT-86 (2), RT-110 (8), RT-111 (1), RT-112 (1), RT-113 (1), RT-114 (3) | YOS-114 owns runaway-handler deadlines (the firm RT-114 test is a release blocker above). YOS-65 owns broader sandbox determinism/data boundaries. Locale, stack, host-realm, microtask and cross-run guarantees remain unproven; only the explicit R1 runtime guarantees may be claimed. |
| Edit, IO and CLI — [redteam-edit-io-cli.md](spec-calls/redteam-edit-io-cli.md) | 11 | RT-91 (1), RT-92 (1), RT-93 (1), RT-94 (1), RT-95 (1), RT-96 (1), RT-97 (3), RT-98 (1), RT-99 (1) | YOS-93 owns release triage. The questions concern unknown edit keys, missing-target edits, diff classification, serialization stability and exact CLI diagnostics; current R1 CLI acceptance is covered by the passing E2E checks. |
| Confirmed engine bug — [redteam-findings.md](redteam-findings.md) | 2 | EB-check-1 (2) | engine-check-core. Cyclic values need a safe diagnostic rendering; the code/path/layer and rejection are already correct, so severity is low. |

The listed counts sum to 102. The RT-tagged tests are backed by explicit ambiguity rows, not successful proofs. Keep the TODOs visible until each owning spec call is resolved and its test is made firm or removed with a recorded decision.

## Release scope and order

1. First clear the R1 implementation and runtime evidence already tracked in Linear: YOS-88 (Bun), YOS-107 (pinned Sonnet), YOS-75 and YOS-117 (Boat lifecycle/cleanup), YOS-87 (cost caps), YOS-110/111/112 (grading and plan/test ownership), YOS-120/121 (seed memory and plan clock), and YOS-114/YOS-44 (runtime deadlines and repair exits).
2. Integrate those changes, then satisfy YOS-105's full Bun gate and YOS-89/YOS-91/YOS-108's real generation, solver, export and dataset evidence on the resulting SHA. The current Linear snapshot has these issues In Progress or In Review; their prior Done statuses are implementation history, not current release proof.
3. Only after that exact commit passes its required gate, begin YOS-53's broad stress run. Any engine change after a proof invalidates the affected test, generated-world grade, dataset result and performance measurement; rerun them on the resulting commit.
4. Keep API fidelity (YOS-73), broad sandbox guarantees (YOS-65), private verifier/handler isolation (YOS-85), benchmark import (YOS-80), provenance and factory automation in R2/later unless a specific reproduced defect blocks R1. Do not infer a security guarantee from `node:vm` or a focused sandbox test.

## Open PR snapshot

At review time, active PRs include #138 (cost meters), #141 (iteration), #145 (architecture map), #146 (collateral grading), #147 (route method/path coverage), #148 (input conformance), #150 (integration consolidation), #151 (dataset recut/cleanup) and #152 (nested sandbox replies). Several target `stabilize/main`; none changes the recorded `main` baseline until merged. Their eventual engine changes require the affected R1 proofs to be rerun before a new SHA can replace this candidate.
