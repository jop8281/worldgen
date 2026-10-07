# Response to the external audit of 2026-10-07

The audit's snapshot is 07:40 PDT (14:40Z) on 2026-10-07. It inspected main at `15c7001` and stabilize at `33f158a`. This response was checked at 08:40 PDT against main `1bb9458` and stabilize/main `d1111e7`. Each row takes one claim from the audit and gives a verdict.

- **FIXED.** The claim was true at the snapshot and a landed change closes it.
- **STALE.** The claim no longer matches the repo, whether a later change closed it or the audit misread it.
- **DISPUTED.** The evidence contradicts the claim.
- **AGREED-OPEN.** The claim stands, and the last column names the issue and the next step.

"On main" means the merge commit is an ancestor of `1bb9458`. "Stabilize only" means it waits for the next promotion. Every test and command named here was run for this response from `code/` under `nice -n 15`, unless the row says it was not re-checked.

## Headline and immediate findings

| # | Audit claim | Verdict | Evidence | Owner and next step |
|---|---|---|---|---|
| 1 | Main is `15c7001`, and it lacks behaviour marked Done elsewhere. | STALE | #383 promoted stabilize `fc39ef8` to main at 14:51Z. Main is `1bb9458`, and `15c7001` is its ancestor. | YOS-105. The next promotion carries the stabilize-only fixes below. |
| 2 | Main's `worldgen --world` returns exit 2 for iteration. | STALE | `git show origin/main:code/src/cli/worldgen.ts`: iterate mode parses at :115. Exit 2 comes only from usage errors at :136, :149 and :153: a bad flag, an existing world.yaml on create, or a missing world.yaml on iterate. Running `bun run worldgen --world /tmp/nonexistent-c1 "add refunds"` printed `has no world.yaml: --world iterates on an existing world`. | None. |
| 3 | Main's package scripts are Node/npm, and its source tree has no dataset module. | STALE | On main, `code/package.json` runs `bun src/cli/*.ts`, `test` is `bun test`, and `check` is `bun run typecheck && bun run test`. `code/src/dataset/` exists on main. | None. |
| 4 | Linear holds 142 issues, 32 of them unfinished. | STALE | The WorldGen project at 08:40 PDT, including archived issues, has 146 issues: YOS-5 to YOS-153 without 113, 115 and 116. There are 109 Done, 20 In Progress, 5 In Review, 5 Backlog and 7 Duplicate, so 30 are open. YOS-150 to YOS-153 are new since the snapshot. | worldgen-27 keeps Linear in step with landings. |
| 5 | Qualification can falsely succeed (YOS-149, #373). | FIXED | #373 merged at 15:25Z, stabilize only. YOS-149 is Done. | YOS-105. Promote it. |
| 6 | Reports can lose judging-exception evidence (YOS-44, #372). | FIXED | #372 merged at 15:35Z, stabilize only. The audit's own caveat, that this is not a CPU-watchdog root-cause fix, stays with row 6 of the next table (YOS-114). | YOS-44 is still In Progress in Linear. Its owner closes it or names the remaining stop path. |
| 7 | Cost and cancellation composition is not released (#367). | AGREED-OPEN | `gh pr view 367` shows OPEN, draft, base stabilize/main. | YOS-87. Rebase #367 on stabilize, qualify it, then land it. |
| 8 | stress-1b is internally inconsistent: 8/14 in the headline, 7 yes rows in the table. | FIXED | #395 merged at 15:37Z. The headline is now 8 done, 6 stopped, 0 crashed, and the pass rate 7/14 (50%). The 15 `run_finished` events sum to 138.8 min and $17.78. See the stress-1b section. | YOS-137 still owns rebuilding the summaries from the expected manifest (#236). |
| 9 | Preserved source values are not full fidelity (#366): fine rules, as-of dates and invented fields are not reported. | AGREED-OPEN | #366 is on main. Its REPORT.md records the fine rules and the clock as assumptions, but the audit's point about undeclared invented fields was not re-checked field by field. | YOS-55 and G3. Declare invented fields in plan.yaml and REPORT.md for every input kind. |
| 10 | Privacy tests are not process isolation (#295). | AGREED-OPEN | #295 is on main and claims output privacy only. The isolation roadmap is A-102 and A-109 (#260). | YOS-85 and YOS-125. Keep the scopes explicit. Process isolation stays roadmap work. |
| 11 | Native factory code is not a deployed factory (factory PR #2362). | AGREED-OPEN | Not re-checked here: it is in another repo. | YOS-102, YOS-104, YOS-134 and YOS-103 on the factory side. |

## Unfinished issues, in the audit's order

| # | Issue | Verdict | Evidence | Owner and next step |
|---|---|---|---|---|
| 1 | YOS-119 GitHub Actions billing | AGREED-OPEN | The latest run (`check`, 15:38Z, head `3b93944`) has jobs `check`, `node` and `e2e`, each with `runner_id=0` and 0 steps. That is a billing refusal, not a code verdict. | The account owner restores Actions billing. Until then worldgen-27 merges on local evidence. |
| 2 | YOS-149 qualification false positives | FIXED | #373, stabilize only. | Promote it. |
| 3 | YOS-105 qualify promoted main | AGREED-OPEN | One promotion has landed (#383, main `1bb9458`). Fixes since then are stabilize only: #372, #373, #380, #389 and #395. | worldgen-27. Run the next qualified promotion with a named candidate SHA. |
| 4 | YOS-98 consolidate overlapping PRs | AGREED-OPEN | #372 and #373 landed. #367, #233, #236, #222, #227, #275 and #234 are open drafts. #152 is closed unmerged. | worldgen-27. Map each open draft to landed, pending or retired. |
| 5 | YOS-88 Bun adoption | STALE in part, AGREED-OPEN in part | Bun tooling is on main (row 3 of the first table). Supported-Bun serving on Boat is not: #275 is an open draft, and #378 serves with `npx tsx` so that Node-only images can run the world. | YOS-88. Land a Bun bootstrap for Boat, then re-run the sweep. |
| 6 | YOS-114 cyclic requests, nested deadlines, quota | AGREED-OPEN | Linear: In Review. Per worldgen-27, the guard budgets were widened rather than each failure class being root-caused. That was not re-checked here. | YOS-114. Reproduce each fault class minimally and fix the cause. |
| 7 | YOS-123 nested sandbox timeout deadlock | FIXED | Fixed by #173 (A-72), on main, not by #152, which closed unmerged. A-72: "every request carries an id the worker echoes, and an answer to another request retires the lane." YOS-123 is Done. | None. |
| 8 | YOS-146 deeply nested JSON bodies | FIXED | #305 (deep-body stack overflow, on main). The related HTTP refusals are #368 (on main) and #389 (stabilize only). `bun test ./test/http.test.ts` gives 35 pass, 0 fail. `node --import tsx --test test/http.test.ts` gives 35 pass, 0 fail. | None. |
| 9 | YOS-87 spend metering and cost caps | AGREED-OPEN | #367 is an open draft. | YOS-87. Same as row 7 of the first table. |
| 10 | YOS-44 full repair loop | FIXED for judge_error | #372, stabilize only. | YOS-44's owner closes the issue or names the remaining stop path. |
| 11 | YOS-75 Boat sandbox lifecycle | AGREED-OPEN | #275 (draft) and #348 (open) are unlanded. The Boat sweep of 2026-10-07 served all 25 worlds (research/evidence/boat-sweep-2026-10-07.md). The runtime inside each sandbox is not recorded there. | YOS-75. Land the Bun bootstrap, re-run the sweep with teardown evidence. |
| 12 | YOS-107 pinned Sonnet client | AGREED-OPEN | Not re-checked here. | YOS-107. |
| 13 | YOS-91 JSONL episodes | AGREED-OPEN | Not re-checked here. | YOS-91. Depends on YOS-140 and #367. |
| 14 | YOS-108 Boat and Sonnet evidence bundle | AGREED-OPEN | Not re-checked here. | YOS-108. |
| 15 | YOS-140 serialize episode-log writers | AGREED-OPEN | `code/src/dataset/store.ts` takes no file lock: a grep for lock, O_EXCL, flock and exclusive found none. | YOS-140. Add exclusive append with crash recovery. |
| 16 | YOS-120 linear-space seed-cycle check | FIXED | #136, on main. The cycle walk is iterative, with an explicit stack at `code/src/engine/check.ts:408`. YOS-120 is Done. | None. |
| 17 | YOS-121 plan clock in world metadata | AGREED-OPEN | #309, on main, lands the plan clock fixes, and `worlds.test.ts` parses every saved plan.yaml. Not every plan and world clock pair was re-audited here. | YOS-121. |
| 18 | YOS-147 seeded-data acceptance tests | FIXED | A-133 (#319, on main): plan acceptance tests create their own rows and never rely on seed rows. Linear still shows In Review. | YOS-147's reviewer closes it. |
| 19 | YOS-55 generated worlds | AGREED-OPEN | Same as row 9 of the first table. All 25 worlds pass `worldplay check` at 862a392 (#384). | YOS-55. |
| 20 | YOS-135 error type and param | FIXED | #265, on main. YOS-135 is Done. Draft #222 is superseded. | worldgen-27 retires #222. |
| 21 | YOS-138 nullable reference cycles | FIXED | #291 (A-125), on main. YOS-138 is Done. Draft #227 is superseded. | worldgen-27 retires #227. |
| 22 | YOS-131 false seed.totals_mismatch | FIXED | A-94 (#248, on main): the lint sums only line-item children. `bun test ./test/lints.test.ts` gives 44 pass, 0 fail, including the A-94 block at `code/test/lints.test.ts:475`: a refund child is not summed into order.total, and a wrong total against its lines still warns. A cancellation fee is the same non-line case. | None. |
| 23 | YOS-136 eval artifact retention | AGREED-OPEN | #233 is an open draft, based on main. | YOS-136. |
| 24 | YOS-137 eval outcome coverage | AGREED-OPEN | #236 is an open draft. The stress-1b headline part is fixed by #395. | YOS-137. |
| 25 | YOS-53 stress run 1 | AGREED-OPEN | The headline is fixed by #395. The fixed-denominator rerun has not happened. | YOS-53. |
| 26 | YOS-54 stress run 2 | AGREED-OPEN | Not started. | YOS-54. |
| 27 | YOS-101 Linear-only tracking docs | AGREED-OPEN | Not re-checked here. | YOS-101. |
| 28 | YOS-102 factory deployment | AGREED-OPEN | Not re-checked here (other repo). | YOS-102. |
| 29 | YOS-104 factory intake | AGREED-OPEN | Not re-checked here (other repo). | YOS-104. |
| 30 | YOS-134 factory status projection | AGREED-OPEN | Not re-checked here (other repo). | YOS-134. |
| 31 | YOS-103 factory pilot | AGREED-OPEN | Not re-checked here (other repo). | YOS-103. |
| 32 | YOS-126 declarative workflow prototype | AGREED-OPEN | #234 is an open draft, based on main. | YOS-126, after the release. |

## Register assessments beyond "not individually revalidated"

| # | Issue | Verdict | Evidence | Owner and next step |
|---|---|---|---|---|
| 1 | YOS-40 and YOS-94: lints are a mechanism, not a quality gate | AGREED-OPEN | The spec matrix keeps W12, W14 and W15 Partial for this reason (#384). | W12, W14 and W15 rows in research/spec-traceability.md. |
| 2 | YOS-52: main returns exit 2 for `--world` | STALE | Same as row 2 of the first table. | None. |
| 3 | YOS-57: main docs are Node/npm | STALE | Main's README has 23 `bun run` lines and 1 `npm run` line, the Node gate. | None. |
| 4 | YOS-58: a sealed rehearsal is not the external live run | AGREED-OPEN | D7 and D8 are Partial for this reason. | YOS-100. |
| 5 | YOS-73: the parent is Done while YOS-135 and YOS-138 are active | STALE | YOS-135 and YOS-138 are both Done (#265, #291). | None. |
| 6 | YOS-83: provenance identity literals mismatch | FIXED | 5a83cc00 refreshed the literals after #343. `bun test ./test/provenance.test.ts` gives 10 pass, 0 fail. The insurance capsule's WID drift is intended: A-154 keeps hashing the parsed world with defaults, so a new defaulted field moves every WID. | None. |
| 7 | YOS-85: roadmap is not delivery | AGREED-OPEN | Same as row 10 of the first table. | YOS-125. |
| 8 | YOS-89: the E2E gate needs a qualified main, CLI-default and Boat run | AGREED-OPEN | No such run is recorded on `1bb9458`. | YOS-105 then YOS-89. |
| 9 | YOS-97: assumptions are required only for description input | AGREED-OPEN | `code/src/worldgen/plan.ts:132` and `:139` apply the open-question and assumption rules when `inputKind === 'description'`. Linear moved YOS-97 back to In Progress. | YOS-97 and G3. |
| 10 | YOS-99: README advertises iteration that main refuses | STALE | Same as rows 2 and 3 of the first table. Main's README documents `bun run worldgen "add partial refunds" --world ../prod/worlds/gen-refunds` at line 143. | None. |
| 11 | YOS-100: tooling alone is not the hiring-team intake | AGREED-OPEN | `prod/prompts/` holds only README.md. | YOS-100, when the prompts arrive. |
| 12 | YOS-125: #295 proves output privacy, not process isolation | AGREED-OPEN | Same as row 10 of the first table. | YOS-125. |
| 13 | YOS-129: Done | AGREED | Linear: Done. | None. |
| 14 | YOS-148: Bun's 201-then-400 is a parser difference, not a proven Bun mutation bug | DISPUTED | #389 found a real write: under Bun a POST whose Content-Length is shorter than the bytes sent got a 400 while the handler still created the row. That breaks the reply-matches-state rule #368 fixed for Node. `readBody` now re-checks the socket one turn after 'end'. `http.test.ts` passes 35 of 35 on both runtimes (was 34/1 on Bun before the fix). | Promote #389. |

## Requirement matrix

| # | Audit claim | Verdict | Evidence | Owner and next step |
|---|---|---|---|---|
| 1 | 54 Met / 13 Partial spans historical revisions. | FIXED | #384 re-audited every row except S3, M2, G4 and W12 at `862a392`. It relocated each cited line, reran each cited test file, and restamped the snapshot. | None. |
| 2 | S3: Partial remains. | STALE | #380 judges planned workflow states and rule links (`plan.state_missing`, `plan.rule_unanswered`), and the matrix has S3 Met. | None. |
| 3 | The 13 Partial rows are E7, W10, W12, W14, W15, S3, M2, M11, G2, G3, G4, D7 and D8. | STALE | S3 is Met. W11 is the 13th Partial: gen-stripe-customers plans states active and deleted and ships no state field, and `plan.state_missing` skips a workflow with no state machine by design. | W11 owner decision, in the matrix's "What closes it" table. |
| 4 | M2: jobs and row counts partly closed by #364. | AGREED-OPEN | #364 and #380 now also judge the state mix within 10 points (`seedPlanIssues`). The prose `seed.mix` and plain-text rules are still prompt-only. | M2 row. |
| 5 | G2: older artifacts need an exact-current audit. | STALE in part | `worldplay openapi` exits 0 on gen-stripe-charges, gen-refunds and gen-stripe-customers, since f50ad3cb. gen-petstore exits 0 with 9 `openapi.operation_extra` warnings. Description worlds get no fidelity check. | G2 row. |
| 6 | E7, W10, W12, W14, W15, M11, G3, G4, D7 and D8 stay Partial for the reasons given. | AGREED-OPEN | The matrix gives each row's gap and closing step. | Each row's entry in "What closes it". |

## stress-1b

| # | Audit claim | Verdict | Evidence | Owner and next step |
|---|---|---|---|---|
| 1 | The headline disagrees with the table. | FIXED | #395. The table recount is 8 done, 6 stopped, 7 yes, 2 unlogged. | None. |
| 2 | $17.79 from the rows against $17.78 reported is rounding, not a billing defect. | AGREED | The 15 `run_finished` events sum to $17.780170. The table's cells are rounded per row. | None. |
| 3 | bakery-vague ran 23.7 min against a 12-min budget, so the deadline semantics need investigating. | DISPUTED | The host slept. `pmset -g log` shows clamshell sleep at 21:43:29 PDT (04:43:29Z) and the lid wake at 22:06:08 PDT (05:06:08Z), with dark wakes of 45 s and 2 s between. The run started at 04:42:43Z and finished at 05:06:24Z, 16 s after the wake, when the 12-minute timer fired. #395 adds this as a footnote. | None. |

## Sources the audit read

| # | Audit claim | Verdict | Evidence | Owner and next step |
|---|---|---|---|---|
| 1 | #372 is open. | STALE | Merged at 15:35Z. | None. |
| 2 | #373 is an open draft. | STALE | Merged at 15:25Z. | None. |
| 3 | #367 is an open draft. | AGREED-OPEN | Still open and draft. | YOS-87. |
| 4 | The hosted jobs had `runner_id=0` and no steps. | AGREED-OPEN | Still true at 15:38Z. | YOS-119. |
