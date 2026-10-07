# Changelog, 2026-10-07

What landed on `stabilize/main` after the last main promotion base `15c7001`, up to `5b51443` (#389): 142 pull requests. Each line gives the PR, what it changed, and the evidence its merge recorded in `~/worldgen-ops/merges.jsonl`. "batch" means the merger tested several PRs merged together, and "author" means the PR's author ran the check. A PR sits under the area most of its source files belong to.

## Highlights

- **Bun end to end, Node as the second gate.** #164 moved the repo to Bun 1.4.2, and #359 made `bun run check` the default gate. The Node job still gates the snippet heap bound that Bun ignores.
- **Iterate is real.** `worldgen --world <dir> "<change>"` edits a world through gated edits (#205), and gen-petstore-refunds came from a live iterate run (#264).
- **OpenAPI worlds follow their spec.** The fidelity check (#184), Stripe list paging (#343) and enforced original operations (#261) mean all three Stripe worlds pass `worldplay openapi`.
- **The plan is judged, not just prompted.** Planned jobs and seed row counts (#364), then workflow states, rule links and the state mix (#380).
- **Graders discriminate harder.** Grading rejects undeclared collateral changes (#256), and graders the collateral probe flagged now pin exact fields (#289).
- **A refused request runs nothing on both runtimes.** An over-long body (#368) and a short Content-Length (#389) are refused with nothing executed under Node and Bun.
- **New live worlds.** gen-stripe-customers from the Stripe spec (#356), gen-insurance-claims from a description (#331), and gen-library-loans from two CSV files through a gated run (#366). There are 25 worlds now.
- **One-command proof.** `scripts/demo-all.sh` runs 25 checks offline (#374), and `scripts/qualify-main.sh` qualifies a fresh clone (#324, #362).
- **Traceability.** The spec matrix (#341), re-audited at the current head: 54 Met, 13 Partial (#384).

## Engine (29)

- **#389** Refuse a short Content-Length under Bun too. Evidence: typecheck; http+architecture(+symbols) node 76/0; bun test http.test 35/0; author: redteam-http 616/616 on both runtimes.
- **#370** Hold seeded past events to the clock in seed.time_order. Evidence: typecheck; check+seed+stages+worlds+lints+redteam-check/foundation/gaps+docs+architecture 512/0; author: worldplay check exits 0 on all 25 prod worlds.
- **#368** A refused over-long body runs nothing (G-45). Evidence: new http.test case fails before (0/1) and passes after; http+architecture 62/0; architecture-symbols 14/0; redteam-http stripe-customers+helpdesk serial 69/0; typecheck.
- **#363** A-154: keep hashing the parsed world for content ids. Evidence: typecheck; provenance+architecture+docs fail 0; decision row + header comment only.
- **#361** Wait for snippet replies with a doubling nap. Evidence: typecheck; sandbox+wedge+deadline+starved+redteam-determinism+architecture+worlds fail 0; check outputs byte-identical (author).
- **#357** YOS-132: reject cycles in JSON error templates (recut of #204). Evidence: batch 352+357+358: typecheck; 14 files fail 0.
- **#353** Enforce the initial state on handler and job writes; seed may start anywhere (A-146, spec E10). Evidence: batch 351+352+353: typecheck; 17 files fail 0.
- **#351** YOS-65: reject BigInt, symbols and cycles at the snippet boundary (recut of #192). Evidence: batch 351+352+353: typecheck; 17 files fail 0.
- **#349** Log requests refused before the world as failed calls (A-145). Evidence: batch 345+346+237+349: typecheck; 18 files fail 0.
- **#343** Add stripe list paging mode (YOS-127). Evidence: typecheck; api+check+openapi+docs+world-io+redteam-paging+openapi-fidelity+architecture+worlds+cli-world+redteam-check fail 0; has_more errors 0.
- **#340** YOS-49: required-input contract that shipped worlds pass (recut of #257). Evidence: batch 340+290: typecheck; openapi-fidelity+worlds+redteam-check+architecture x2+eval-inputs+eval fail 0.
- **#310** Route precedence: literal segments win across methods. Evidence: batch 310+311+303+306: typecheck; redteam-http serial 524/0 (fully green); route+api+actions+runtime+http+worlds+provenance+report+worldgen+architecture+docs 415/0.
- **#305** Fix deep-body stack overflow from the idempotency fingerprint. Evidence: redteam-http serial 499/2 (deep-body G-45 now passes on every world; 2 = pre-existing gen-petstore route precedence); api-fidelity+api+provenance+report+worldgen+worlds+docs+architecture 255/0.
- **#296** A failing create that collides with a seed row is test.seed_collision. Evidence: batch 261+294+296+308+309+288: typecheck; 21 test groups 1300 pass; only fail = #261's def.type rule (excluded).
- **#293** Keep POST idempotency keys in State (YOS-139). Evidence: batch 293+297: typecheck; api+runtime+store+http+tasks+openapi-fidelity+redteam-determinism+architecture x2+stages+worldgen+iterate+docs+worlds+issues 645/0.
- **#292** Allow zero offsets in ctx.time.plus and add ctx.time.minus (A-126). Evidence: batch 289+292: 391/0; ctx.time.plus zero + minus.
- **#291** Seeds may defer a nullable ref to a later row; seed.cycle names its refs (A-125). Evidence: typecheck; seed*+check+worldgen+worlds+redteam-check+policy+architecture+store+docs 685/0.
- **#288** YOS-144: repair Bun CPU metering and independent supervisor bounds. Evidence: batch 261+294+296+308+309+288: typecheck; 21 test groups 1300 pass; only fail = #261's def.type rule (excluded).
- **#279** Accept compound durations such as 1d12h and a zero WorldEdit tick (A-117). Evidence: batch 280+279+276: 452/0; compound durations.
- **#278** Route field type branches through FIELD_TYPES (A-113). Evidence: author 320/0 (store+fields+architecture-symbols+docs+worlds+seed+api), 19 worlds verify; landed first per plan.
- **#273** Snippet guard meters worker CPU time, with a wall backstop (A-89). Evidence: batch 261+268..273: typecheck; 22 files 803 pass, only fail = #268's architecture rule (excluded); worlds verify gen-petstore 4, gen-linear-backlog 4, gen-repair-desk 3.
- **#265** API fidelity primitives: error type and param, idempotency keys, unix_time (YOS-73). Evidence: batch 262+264+265+267: 446/0; api-fidelity tests.
- **#256** Reject undeclared collateral changes in grading (YOS-110). Evidence: typecheck; collateral-grading 11/11 (0/11 on trunk), ctx+tasks+worlds+architecture 121/0; all 15 worlds verify.
- **#248** Seed.totals_mismatch sums only line items (A-94). Evidence: typecheck; lints+check+worlds+docs+openapi-fidelity+cli-world+architecture 228/0.
- **#200** Listen for the signal before printing the URLs (R11 flake). Evidence: 198+200 together: typecheck, sandbox+wedge+redteam-determinism+redteam-check+cli-world+http+architecture 544 pass.
- **#198** Load-independent quota verdicts (guard counts only time with no ctx call). Evidence: 198+200 together: typecheck, sandbox+wedge+redteam-determinism+redteam-check+cli-world+http+architecture 544 pass.
- **#189** A snippet process kills itself when its main is gone (A-86). Evidence: batch 206+189+205+151+183: typecheck, 16 files (iterate, worldgen, cli-worldgen, openapi, dataset x7, worlds, docs, architecture x2, broken-worlds, sandbox-wedge) 363/363.
- **#184** OpenAPI fidelity check (design review item 19). Evidence: typecheck; openapi-fidelity+worldgen+cli+iterate+policy+report+events+architecture+worlds+docs 360/0; worldplay openapi on gen-petstore: 1 error (PUT /pet), warnings.
- **#183** Report a snippet start timeout as snippet.host_unavailable. Evidence: batch 3 tested 363/363; re-synced decisions.md union + typecheck before merge.

## WorldGen (41)

- **#380** Judge planned workflow states, rule links and state mix. Evidence: typecheck; judge*+stages+plan+policy+worldgen*+check+worlds+report+redteam-wg-*+redteam-foundation/gaps/check+docs+architecture+input* 1191/0 on merge with stabilize.
- **#364** Judge planned jobs and seed row counts (A-148). Evidence: typecheck; judge+stages+plan+worldgen+iterate+docs+architecture 275/0 merged onto f3198ee.
- **#355** Land a tasks-step share kill before the run deadline; price 1-hour cache writes (A-138). Evidence: typecheck; worldgen+deadline+llm+policy+costs+config+eval+plan+stages+judge+check+iterate+architecture+docs+worlds fail 0 (797).
- **#352** Require open questions; close W1 and W6 in the matrix. Evidence: batch 352+357+358: typecheck; 14 files fail 0.
- **#346** YOS-49: judge CSV seed values and counts at the seed step. Evidence: typecheck; check+check-tests-layer+judge x3+worldgen+iterate+architecture x2+worlds+lints fail 0.
- **#337** Tighten the plan's feasibility rule. Evidence: batch 335+336+337: typecheck; policy+worldgen+iterate+redteam-wg-policy+stages+plan+eval+fidelity+eval-inputs+architecture+docs fail 0.
- **#336** Add 14 suite cases and --tag groups (29 cases). Evidence: batch 335+336+337: typecheck; policy+worldgen+iterate+redteam-wg-policy+stages+plan+eval+fidelity+eval-inputs+architecture+docs fail 0.
- **#335** Give a backtrack's re-entered step a share (A-139). Evidence: batch 335+336+337: typecheck; policy+worldgen+iterate+redteam-wg-policy+stages+plan+eval+fidelity+eval-inputs+architecture+docs fail 0.
- **#334** A-118 follow-up: iterate's old-world check no longer reads the injected clock. Evidence: typecheck; lints+worldgen-iterate 71/0 with #334 alone; iterate 'time_exhausted before first call' fixed (A-118 follow-up).
- **#333** Block create-mode workflow on unexercised actions (A-136). Evidence: typecheck; lints+check+check-tests-layer+worldgen+stages+judge+iterate+worlds+redteam-wg-policy fail 0.
- **#329** Require iterate acceptance tests to create prerequisite rows. Evidence: typecheck; stages+worldgen+redteam-wg-plan-stages+architecture+docs 191/0; renumbered to A-140 by gate.
- **#327** Stress run 1b: live scorecard and OpenAPI field checks at the model step. Evidence: batch 324+328+330+327: typecheck; 19 files 643/0 (# fail 0); solve-demo: solution 1.000, decoys 0.000/0.300.
- **#326** Bill and report what a share-killed claude -p call streamed (A-135). Evidence: typecheck; llm+report+policy+worldgen+costs+meters+redteam-wg-config-events+architecture+eval fail 0.
- **#319** Plan brief: acceptance tests never rely on seed rows (A-133). Evidence: batch 261+319: 620/0; plan tests self-contained (A-133).
- **#317** A-118: the run deadline bounds engine judging. Evidence: typecheck; worldgen*+sandbox*+policy+redteam-wg*+report+cli-worldgen+architecture+stages+events verified by gate.
- **#315** First-call estimates per step from live data (A-131). Evidence: typecheck; worldgen+iterate+report+cli+events+stages+policy+judge+architecture+redteam-wg x2 verified by gate.
- **#314** RunDeps.fs seam so iterate IO-failure tests pass on Bun. Evidence: typecheck; worldgen-iterate+provenance+worldgen+architecture+report verified by gate.
- **#313** Bound each model call by its step share and retry a stalled claude -p once (A-123). Evidence: batch 312+313: 982/0; stall kill + retry (A-123).
- **#303** YOS-83: content ids (WID, TID) and a run capsule beside REPORT.md (A-121). Evidence: batch 310+311+303+306: typecheck; redteam-http serial 524/0 (fully green); route+api+actions+runtime+http+worlds+provenance+report+worldgen+architecture+docs 415/0.
- **#302** Seed state mix is advisory unless a task needs it; small seeds in the briefs (A-129). Evidence: typecheck; stages+judge+worldgen+policy+redteam-wg-plan-stages+architecture+lints+worlds verified by gate.
- **#300** A-124 no_progress keys on normalized found; backtrack starts a new stretch and carries the last rejection. Evidence: typecheck; policy+redteam-wg-policy+worldgen+iterate+stages+report+architecture 305/0.
- **#299** Keep the seed brief within 6 sentences. Evidence: stages+worldgen+seed-cycles 88/88 (author); fixes trunk 'seed brief has 2-6 sentences'.
- **#297** Route action.unexercised to the workflow step (A-127). Evidence: batch 293+297: 645/0; action.unexercised owner (A-127).
- **#294** A test that fails at the seed step is the seed's to repair (A-122). Evidence: batch 261+294+296+308+309+288: typecheck; 21 test groups 1300 pass; only fail = #261's def.type rule (excluded).
- **#290** Add seeded library books and loans CSVs (YOS-55). Evidence: batch 340+290: typecheck; openapi-fidelity+worlds+redteam-check+architecture x2+eval-inputs+eval fail 0.
- **#287** /v1/customers operations in the Stripe spec subset (YOS-55). Evidence: batch 285+284+287: 707/0; eval dry-run 15/15; spec-only.
- **#285** Freeze acceptance tests before workflow repairs (YOS-112). Evidence: batch 285+284+287: typecheck; judge+stages+worldgen+iterate+policy+ctx+docs+openapi+input+eval+architecture+worlds+redteam-wg-plan-stages 707/0.
- **#284** Seed first attempt: name the top two rejection causes in the time-math doc and the seed brief. Evidence: batch 285+284+287: 707/0; seed brief + time doc.
- **#277** Tasks reserve never below the tasks call estimate; time refusal names the next call (A-114). Evidence: typecheck; worldgen+iterate+policy+report+cli+events+redteam-wg x2+architecture verified by gate.
- **#269** Refuse an infeasible request at plan. Evidence: batch 261+268..273: typecheck; 22 files 803 pass, only fail = #268's architecture rule (excluded); worlds verify gen-petstore 4, gen-linear-backlog 4, gen-repair-desk 3.
- **#268** Stress run 1: scorecard, triage, claude-cli preflight probe. Evidence: typecheck; architecture+cli-worldgen+dataset-cli+llm+policy+worldgen+iterate+report+events+redteam-wg x2 360/0; probe moved into llm.ts.
- **#261** YOS-49: enforce original OpenAPI operations and CSV fixture coverage. Evidence: batch 261+319: typecheck; architecture x2+judge x3+plan+input+worlds+worldgen x2+openapi-fidelity+fields+provenance+stages+redteam-wg-plan-stages 620/0; d5 verified library-loans flagged.
- **#254** YOS-111: enforce planned route methods and paths. Evidence: batch 253+254+261+259+260: 547/0 (+ decisions.md text fix).
- **#252** Estimate a retry from repair history so the step share does not refuse it. Evidence: 250+252: typecheck; 298/0 targeted.
- **#245** YOS-88: use Bun in live-run instructions. Evidence: batch 238+241+242+243+245: typecheck; all 15 prod worlds check ok + verify; worlds+docs+architecture 107/0.
- **#230** YOS-44: full repair loop: REPORT.md on every exit, spend cap stops as budget, backtrack feedback. Evidence: typecheck; worldgen+policy+report+events+iterate+cli+architecture 248/0.
- **#220** YOS-96: fidelity scorecard for description-input worlds. Evidence: batch 184+212+220: 536 run, the 1 fail is #184-only (iterate clock), #220 clean: fidelity tests + eval dry-run 14/14.
- **#217** Step-share kill is stage_time_exhausted, not model_error (A-91). Evidence: typecheck; infra-retry/policy/events/redteam-wg/report/eval/docs/worldgen/cli/iterate/llm/judge/architecture/registry/worlds 535/0 with #217.
- **#212** Rerun a host_unavailable check, then stop as infra_unavailable. Evidence: typecheck; 338/0 targeted; gate removed a malformed duplicate A-92 row.
- **#210** Workflow stage effort medium. Evidence: batch 215+210+216: typecheck, worlds+docs+costs+meters+registry+sandboxes+boat+config+architecture+worldgen 311/0; retail-tau2 verify 8/8.
- **#205** Worldgen --world through gated edits (YOS-52, supersedes #141). Evidence: batch 3 tested 363/363; re-synced decisions.md union + typecheck before merge.

## Worlds (27)

- **#366** Ship gen-library-loans from a gated CSV run (YOS-55, A-153). Evidence: typecheck; worldplay verify gen-library-loans: 3 tasks solution 1, noop 0, decoys<1, prefix 0.667/0.917; worlds+docs+architecture 124/0.
- **#356** Gen-stripe-customers, live OpenAPI world from the Stripe spec (YOS-55). Evidence: gen-stripe-customers check ok, verify 3/3, openapi --only /v1/customers 0 errors (author), worlds.test fail 0.
- **#350** Cut host round trips in gen-billing-dunning hourly jobs. Evidence: redteam-http + worlds serial fail 0 (billing-dunning serves); verify byte-identical (author).
- **#331** Gen-insurance-claims, live world from a description. Evidence: gen-insurance-claims check ok (advisory warnings), verify 4/4, worlds.test fail 0.
- **#330** Gen-clinic-appointments: clock at 2026-10-06T09:00Z (supersedes #232). Evidence: batch 324+328+330+327: typecheck; 19 files 643/0 (# fail 0); solve-demo: solution 1.000, decoys 0.000/0.300.
- **#318** Fix billing dunning retries at exact deadlines. Evidence: gen-billing-dunning check ok + verify; worlds.test pass.
- **#312** Add generated world gen-billing-dunning. Evidence: batch 312+313: typecheck; judge+input+fields+llm+worldgen+policy+report+eval+meters+cli+redteam-wg+architecture+worlds+docs 982/0; gen-billing-dunning.
- **#311** Gen-bookmarks, live world from a description (A-129 rerun). Evidence: batch 310+311+303+306: typecheck; redteam-http serial 524/0 (fully green); route+api+actions+runtime+http+worlds+provenance+report+worldgen+architecture+docs 415/0.
- **#309** Every saved plan.yaml parses; land the plan clock fixes. Evidence: batch 261+294+296+308+309+288: typecheck; 21 test groups 1300 pass; only fail = #261's def.type rule (excluded).
- **#304** Gen-warehouse-inventory, live rerun after A-126 (#292). Evidence: worlds+docs 255/0 batch; gen-warehouse-inventory verify 4 tasks (author).
- **#289** Pin exact fields on target rows in every grader the collateral probe flagged. Evidence: batch 289+292: typecheck; clock+store+ctx+api+worlds+docs+architecture+redteam-clock+tasks+collateral 391/0; all 19 worlds verify (solution 1, noop 0).
- **#276** Gen-course-enrollments, stress-round world from two CSVs (Sonnet). Evidence: batch 280+279+276: 452/0; gen-course-enrollments (two CSVs, 3 tasks) via worlds.test.
- **#272** YOS-95: Linear backlog CSV eval case and gen-linear-backlog. Evidence: batch 261+268..273: typecheck; 22 files 803 pass, only fail = #268's architecture rule (excluded); worlds verify gen-petstore 4, gen-linear-backlog 4, gen-repair-desk 3.
- **#271** Pin gen-petstore target-pet changes with exact-field guardChanges. Evidence: batch 261+268..273: typecheck; 22 files 803 pass, only fail = #268's architecture rule (excluded); worlds verify gen-petstore 4, gen-linear-backlog 4, gen-repair-desk 3.
- **#270** Add gen-repair-desk that rejects inactive technician assignments (YOS-129). Evidence: batch 261+268..273: typecheck; 22 files 803 pass, only fail = #268's architecture rule (excluded); worlds verify gen-petstore 4, gen-linear-backlog 4, gen-repair-desk 3.
- **#264** Gen-petstore-refunds, live iterate; §5 iterate Met. Evidence: batch 262+264+265+267: 446/0; gen-petstore-refunds verify 7/7 (live iterate).
- **#250** Regenerate gen-petstore against the fidelity gate. Evidence: 250+252: typecheck; worlds+docs+openapi-fidelity+policy+worldgen+redteam-wg x2+architecture 298/0; gen-petstore openapi 0 errors.
- **#243** Gen-shipments, sealed-prompt rehearsal world (Sonnet). Evidence: batch 238+241+242+243+245: typecheck; all 15 prod worlds check ok + verify; worlds+docs+architecture 107/0.
- **#242** Gen-stripe-charges, sealed-prompt rehearsal world (Sonnet). Evidence: batch 238+241+242+243+245: typecheck; all 15 prod worlds check ok + verify; worlds+docs+architecture 107/0.
- **#241** Gen-rental-fleet, sealed-prompt rehearsal world (Sonnet). Evidence: batch 238+241+242+243+245: typecheck; all 15 prod worlds check ok + verify; worlds+docs+architecture 107/0.
- **#238** Add generated world gen-retail-tau2-known. Evidence: batch 238+241+242+243+245: typecheck; all 15 prod worlds check ok + verify; worlds+docs+architecture 107/0.
- **#215** Add five tau2-mapped tasks to retail-tau2. Evidence: batch 215+210+216: typecheck, worlds+docs+costs+meters+registry+sandboxes+boat+config+architecture+worldgen 311/0; retail-tau2 verify 8/8.
- **#206** Add generated world gen-bakery-vague. Evidence: batch 206+189+205+151+183: typecheck, 16 files (iterate, worldgen, cli-worldgen, openapi, dataset x7, worlds, docs, architecture x2, broken-worlds, sandbox-wedge) 363/363.
- **#196** Gen-helpdesk, generated from the SLA prompt (Sonnet). Evidence: batch 177+191+196+187+186+199: typecheck, worlds+docs+broken-worlds+architecture 113 pass; retail-tau2 and gen-hotel-booking check ok on recheck (first check hit start timeout at load 170+), verify 3/4/4/3 tasks.
- **#191** Add generated world gen-hotel-booking. Evidence: batch 177+191+196+187+186+199: typecheck, worlds+docs+broken-worlds+architecture 113 pass; retail-tau2 and gen-hotel-booking check ok on recheck (first check hit start timeout at load 170+), verify 3/4/4/3 tasks.
- **#187** Align imported orders clock and shipping chronology. Evidence: batch 177+191+196+187+186+199: typecheck, worlds+docs+broken-worlds+architecture 113 pass; retail-tau2 and gen-hotel-booking check ok on recheck (first check hit start timeout at load 170+), verify 3/4/4/3 tasks.
- **#177** Add retail-tau2, a hand-mapped tau2 retail world. Evidence: batch 177+191+196+187+186+199: typecheck, worlds+docs+broken-worlds+architecture 113 pass; retail-tau2 and gen-hotel-booking check ok on recheck (first check hit start timeout at load 170+), verify 3/4/4/3 tasks.

## Sandboxes and costs (8)

- **#379** Delete the sandbox when create fails after making it. Evidence: typecheck; sandboxes*+sandbox-registry+architecture 77/0 on merge with stabilize; 2b QA: found live on sbx/openshell, Boat helpdesk re-verified.
- **#378** Serve with npx tsx so Node-only images can run the world. Evidence: typecheck; sandboxes+sandbox-registry+upworld-public+architecture 89/0 on merge with stabilize; author: Boat helpdesk up/GET/down on final head.
- **#377** Upload to /sandbox/work and run in the nested directory. Evidence: typecheck; sandboxes*+sandbox-registry+architecture 76/0 on merge with stabilize; 2b QA: found live on sbx/openshell, Boat helpdesk re-verified.
- **#376** Force rm on down so teardown works without a TTY. Evidence: typecheck; sandboxes*+sandbox-registry+architecture 76/0 on merge with stabilize; 2b QA: found live on sbx/openshell, Boat helpdesk re-verified.
- **#375** Print sandbox usage on any subcommand --help; document the empty live dry run. Evidence: typecheck; sandbox-registry+docs+architecture pass; new --help test failed first (author).
- **#267** Close a detached sandbox once, keep start-failed rows closed, name the cap in spend stops. Evidence: batch 262+264+265+267: 446/0; ledger lock + cap text.
- **#216** Bill a failed sandbox teardown once across restarts (supersedes #185). Evidence: batch 215+210+216: typecheck, worlds+docs+costs+meters+registry+sandboxes+boat+config+architecture+worldgen 311/0; retail-tau2 verify 8/8.
- **#151** Re-cut YOS-91 dataset onto stabilize without SDK commits, plus #128 teardown. Evidence: batch 3 tested 363/363; re-synced decisions.md union + typecheck before merge.

## Docs (17)

- **#385** One-page section 0 for the demo runbook. Evidence: docs+architecture pass on merge with stabilize; runbook section 0 only.
- **#384** Re-audit the spec matrix at the current head. Evidence: docs+architecture 89/0 on local merge with stabilize; spec-traceability.md only; merged server-side because git push returned 500.
- **#382** Add the live segment with three unseen inputs. Evidence: typecheck; docs+architecture+eval+eval-inputs 160/0; eval --suite live-segment.yaml --dry-run 3/3 ready.
- **#381** Refresh counts, the world table and Boat evidence. Evidence: docs+worlds+architecture pass on merge with stabilize; design.md + research/evidence boat sweep (no key).
- **#369** Add a status table with PR links and list all 25 worlds. Evidence: docs+architecture+worlds pass after merge onto stabilize; README/AGENTS docs only; author ran each documented command's --help/dry-run.
- **#342** Match worlds tables to trunk (23 worlds, 90 tasks). Evidence: docs-only; docs+architecture fail 0; 23 worlds verify (author).
- **#341** Add the spec traceability matrix. Evidence: docs-only; docs+architecture fail 0.
- **#338** Iterate evidence (#264, #298, stage skipping). Evidence: docs-only; docs+architecture 79/0 (author).
- **#321** Bun row, no Bun-only failures left (#308, #314). Evidence: docs-only Bun row; docs.test 52/0 (author).
- **#306** Bun runtime row (U-12) with full-suite evidence. Evidence: batch 310+311+303+306: typecheck; redteam-http serial 524/0 (fully green); route+api+actions+runtime+http+worlds+provenance+report+worldgen+architecture+docs 415/0.
- **#301** Mark iterate run 10 invalid: host slept. Evidence: docs-only: i10 marked invalid (host slept).
- **#298** Add iterate evidence for 20 change requests (YOS-52). Evidence: docs-only: iterate evidence 17/20.
- **#266** YOS-143: reconcile design.md targets and README deliverables with trunk. Evidence: author: check+verify 16 worlds, docs.test 52/52, opus spot-check; docs-only.
- **#263** Align module maps and runtime ownership (YOS-118). Evidence: batch: 803/0 excluding #268; module-map test lands last.
- **#262** Log the zero-task spec call as A-110 (YOS-113). Evidence: batch 262+264+265+267: typecheck, 446/0.
- **#260** Decide verifier and handler isolation roadmap (YOS-85). Evidence: batch: 547/0; docs-only A-102/A-109.
- **#253** Record release qualification baseline (YOS-93). Evidence: batch 253+254+261+259+260: typecheck, 16 files 547/0.

## Tests and tooling (20)

- **#374** Add scripts/demo-all.sh and the demo runbook. Evidence: demo-all.sh 25 passed 0 failed (bash 3.2, nice 15) on the merge with stabilize; docs+architecture 89/0; README conflict with #369 resolved keeping both rows.
- **#371** List plan.seed_rows_short as WorldGen-only. Evidence: redteam-foundation+gaps+check 230/0; the only 2 failures of the 33f158a full suite (4197 tests).
- **#365** Repair malformed tables and test them. Evidence: docs.test 55/0 after merging stabilize (dropped union-duplicated 5-cell A-150); decisions.md only.
- **#362** Bun when present, node otherwise, via scripts/runner.sh. Evidence: bash -n runner.sh+qualify-main.sh; sourced under bash set -u; author: qualify-main BUN QUALIFIED c77f0a0 and NODE QUALIFIED 9c7bf41, 24/24 worlds.
- **#360** Refresh provenance id literals after #343 paging defaults (YOS-83). Evidence: typecheck; provenance+worlds+architecture fail 0; WID literals moved by #343's list defaults (intended).
- **#359** A-134: bun run check is the default gate, Node the second; scripts prefer bun. Evidence: docs+architecture fail 0; demo/solve-demo both runtimes (author); Bun default gate per U-12 (A-134).
- **#358** YOS-124: require deterministic quota verdicts in G-23 (recut of #240). Evidence: batch 352+357+358: typecheck; 14 files fail 0.
- **#345** Worldgen command from a description to a verified world (M1). Evidence: batch 345+346+237+349: typecheck; 18 files fail 0.
- **#328** Replay gen-petstore's own task scripts over the world port, not hardcoded routes. Evidence: batch 324+328+330+327: typecheck; 19 files 643/0 (# fail 0); solve-demo: solution 1.000, decoys 0.000/0.300.
- **#324** YOS-89: scripts/qualify-main.sh, the E2E gate on a fresh clone of main. Evidence: batch 324+328+330+327: typecheck; 19 files 643/0 (# fail 0); solve-demo: solution 1.000, decoys 0.000/0.300.
- **#323** Pin the helpdesk hard task's sixth decoy (PR #289 follow-up). Evidence: cli-world+helpdesk+worlds pass; helpdesk verify literals updated for #289's intended decoy.
- **#308** The orphan test ignores zombies and processes macOS has not started yet. Evidence: batch 261+294+296+308+309+288: typecheck; 21 test groups 1300 pass; only fail = #261's def.type rule (excluded).
- **#295** YOS-125: prove the world port never shows grader, solution or decoy text. Evidence: batch: private-boundary 233/0 (author); test+docs only; batch 1374 pass, failures not from #295.
- **#280** Fix trunk test R7: name every field type, including unix_time. Evidence: batch 280+279+276: typecheck; format+fields+docs+store+architecture x2+clock+redteam-clock+http+check-tests-layer+redteam-edit+worlds 452/0; R7 trunk failure fixed.
- **#274** Classify spec- and host-only issue codes; fix stale L08 (A-112). Evidence: typecheck; redteam-foundation+gaps+check+openapi-fidelity+sandbox 301/1 (1 = snippet.memory load case, fixed by #273): G-00 promotion blocker cleared.
- **#259** Bound child processes and HTTP reads with deadlines (YOS-105, YOS-130). Evidence: batch: 547/0; e2e deadlines R2 server-never-answers.
- **#237** Restore actual Node execution in the Node gate (YOS-88). Evidence: batch 345+346+237+349: typecheck; 18 files fail 0.
- **#199** Live run 1: library description stopped on a step-share timeout; live.sh load warning, runbook notes. Evidence: batch 177+191+196+187+186+199: typecheck, worlds+docs+broken-worlds+architecture 113 pass; retail-tau2 and gen-hotel-booking check ok on recheck (first check hit start timeout at load 170+), verify 3/4/4/3 tasks.
- **#186** YOS-84: Fix merged corpus first-issue expectations. Evidence: batch 177+191+196+187+186+199: typecheck, worlds+docs+broken-worlds+architecture 113 pass; retail-tau2 and gen-hotel-booking check ok on recheck (first check hit start timeout at load 170+), verify 3/4/4/3 tasks.
- **#164** Bun-e2e: Bun 1.4.2 end to end, Node kept as a second gate (YOS-88, U-12). Evidence: design.md conflict resolved by gate (kept #184 fidelity row, bun eval command); typecheck both configs; docs+architecture 76/0; Bun sandbox.test 57/0 x2 (author).
