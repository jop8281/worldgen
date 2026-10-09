# Red-team suite

This folder holds the helpers for `code/test/redteam-*.test.ts`, a black-box test suite that attacks the world engine through its public surface: `#engine` and the `world` CLI. Its job is to find engine bugs before the trial reviewers do. Each test checks one guarantee from [`research/redteam-contract.md`](../../../research/redteam-contract.md), and its name starts with that guarantee's id (`G-08 failed call leaves dump unchanged`).

| File | What it holds |
|---|---|
| `world.ts` | `baseWorld()`, the hand-built fixture world, and `FACTS`, the literal values derived from it by hand |
| `mutations.ts` | One row per way to break the base world, covering every world-triggerable `ISSUES` code |
| `graders.ts` | The bad tasks (`BAD_TASKS`) that the task rows in `mutations.ts` are built from |
| `harness.ts` | The capability probe and `cap()`, the seeded PRNG, `ddmin`, `deepFreeze`, the CLI runner and the HTTP server harness |

## The blind rule

The suite is written without looking at the engine's implementation.

- Never read implementation bodies on any `factory/*` branch. You may read their test files, but only for style.
- Tests import only `#engine`, `node:*` and `./redteam/*.ts`, never deep engine paths.
- Expected values are literals (`FACTS`, codes, statuses) or invariance comparisons, where engine output before an operation is compared with engine output after it. Never compute an expected value by calling the engine's own logic.
- When the docs leave a question open, the test makes the weakest safe assumption and is marked `{ todo: 'RT-nn' }`. The `RT-nn` ids are listed in the contract's Ambiguities table.

## Running it

```sh
cd code
bun run test                                      # whole suite. Stubbed capabilities skip, todo tests do not fail the run
bun run check                                     # typecheck + tests. Must stay green on the stubbed engine
REDTEAM_STRICT=1 bun run test                     # nothing skips. Every stubbed capability fails loudly
REDTEAM_SEED=42 REDTEAM_ITER=300 bun run test     # another seed, and more iterations for the fuzz and property tests
bun test -t 'G-07' test/redteam-*.test.ts                                    # one guarantee
bun test test/redteam-atomic.test.ts                                         # one file
```

- `REDTEAM_SEED` is the PRNG seed (default 1), and `REDTEAM_ITER` the iteration count (default 25).
- A fuzz failure prints the seed and the minimized call list (`ddmin`), so it can be replayed exactly.
- The harness probes each capability once, at import. `CAPABILITY_UNITS` in `harness.ts` lists every capability and the factory unit that lands it: `checkWorld` and one `check.<layer>` per layer (plus `check.tasks.discriminating` for decoys and prefixes), `sandbox`, `createRuntime` and the `runtime.*` methods (plus `runtime.seed` and `runtime.actions`), the world IO and format functions, and `cli`, `cli.verify`, `cli.grade` and `cli.serve`. A capability that throws `Error('not implemented')`, or shows another stub marker (a check layer that lets its own mutation row through and leaves its report fields empty, an empty seeded state, a 501 `action.unavailable`), makes its tests skip with `unit <unit> not landed: <name> <evidence>`. A capability the probe cannot reach because the base world fails for another reason skips with `blocked: …`. `baseOk()` gives the same `blocked: …` skip to tests that only need a base world that checks. CLI capabilities are probed only by files that `await probeCli()`.
- Gate a test only through `cap(...)`, `baseOk()` or `opts(...)`, never with a hand-written env or file check. The WorldGen files (`redteam-wg-*.test.ts`) gate with `notBuilt(unit, what, probe)` from `test/redteam-wg/fixtures.ts`. It gives the same `unit <unit> not landed: …` reason and also never skips under `REDTEAM_STRICT=1`.

The baseline on the first stubbed engine (2026-10-06): `npm run check` gave 545 tests, 19 pass, 526 skip and 0 fail.

The baseline after merging `origin/factory/integration` (2026-10-06). The landed units are engine-check-core, engine-runtime and the api.

| Run | Tests | Pass | Skip | Todo | Fail |
|---|---|---|---|---|---|
| `npm run check`, whole repo | 1228 | 753 | 440 | 35 | 0 |
| `npm run check`, `redteam-*` only | 710 | 235 | 440 | 35 | 0 |
| `REDTEAM_STRICT=1 npm test`, whole repo | 1228 | 757 | 0 | 94 | 377 |

Every one of the 377 strict failures comes from a unit that has not landed:

| Unit | Strict failures |
|---|---|
| engine-seed | 139 |
| engine-grade-verify-basic | 93 |
| engine-actions-jobs | 56 |
| cli-world-check | 55 |
| engine-tests-layer | 29 |
| wg-input-* | 4 |
| engine-lints | 1 |

Of those, 8 tests run normally and gate only part of their body. They are the six G-01 multi-mutation fuzz batches, which drop the task rows while `check.tasks` is a stub, and the two G-21 controls, which skip the job step while `runtime.advance` is a stub.

A strict-mode failure that does not trace to one of these stubs is a finding. Confirmed engine bugs in landed units are listed in [`research/redteam-findings.md`](../../../research/redteam-findings.md). Their tests carry `{ todo: 'ENGINE-BUG <id>: …' }`.

## Triage

Every red test is exactly one of the five kinds below.

| Kind | How to tell | What to do |
|---|---|---|
| **Unbuilt** | The failure comes from a unit that has not landed: a stub, a missing export, a pass-through layer, or a missing CLI | Gate the test with `cap(...)` on the capability whose unit owns the failure, so it skips with `unit <unit> not landed: …`. Add a capability to `CAPABILITY_UNITS` and the probe if none fits. |
| **Engine bug** | The test's assertion follows from a contract row, and a landed unit breaks it | Mark the test `{ todo: 'ENGINE-BUG EB-<file>-<n>: <short>' }`, so it still runs. Add an entry to `research/redteam-findings.md`, with the test name, the failing assertion, the minimal repro, the guarantee and its doc citation, and the suspected owning unit. Do not weaken the assertion. |
| **Test bug** | The assertion is not backed by any contract source, or the expected literal is wrong by hand derivation | Fix the test only when the contract supports the fix, and cite the row in the change. If the contract is silent, the question is a spec gap, not a test bug. |
| **Spec gap** | The contract and its sources do not decide what the right answer is | Write it up in `research/spec-calls/redteam-<topic>.md`, giving the question, the options, a recommendation and the tests it unlocks. Mark the test `{ todo: 'RT-nn' }` and add the RT row to the contract. Never edit `research/decisions.md` from the suite. |
| **Flake** | The same seed passes and fails on different runs | Treat it as a determinism bug (G-06, G-18, G-20) until shown otherwise. Rerun the same seed 20 times with `for i in $(seq 20); do REDTEAM_SEED=<s> bun test -t '<id>' test/redteam-<file>.test.ts || break; done`. If it is still intermittent, report it as an engine bug together with the run count. Never paper over it with retries. |

## Coverage matrix

### Guarantees

Columns:
- **Tests** counts the tests whose name mentions the id, in the output of a `REDTEAM_STRICT=1` run, so every generated test counts.
- **Firm** counts the ones that are not `todo`. An `ENGINE-BUG` todo is not firm.
- **Files** names the `redteam-<file>.test.ts` files that mention the id.

Every guarantee from G-00 to G-58 has at least one firm test. Counts as of 2026-10-06, after the integration merge.

| Id | Tests | Firm | Files |
|---|---|---|---|
| G-00 | 18 | 18 | check, foundation, gaps, graders |
| G-01 | 30 | 26 | check, foundation, graders |
| G-02 | 6 | 3 | check, graders |
| G-03 | 2 | 2 | check, cli |
| G-04 | 11 | 7 | check |
| G-05 | 9 | 8 | check, foundation |
| G-06 | 20 | 19 | check, determinism, gaps |
| G-07 | 146 | 137 | check, edit |
| G-08 | 8 | 7 | atomic, clock, determinism |
| G-09 | 4 | 3 | atomic, http |
| G-10 | 6 | 6 | atomic, clock, http |
| G-11 | 8 | 8 | atomic, http |
| G-12 | 6 | 4 | atomic, http |
| G-13 | 2 | 2 | atomic, http |
| G-14 | 2 | 2 | atomic, http |
| G-15 | 3 | 3 | atomic, http |
| G-16 | 2 | 1 | http |
| G-17 | 6 | 6 | atomic, clock, http |
| G-18 | 10 | 7 | atomic, determinism, gaps |
| G-19 | 2 | 2 | atomic, clock |
| G-20 | 4 | 4 | determinism, gaps |
| G-21 | 149 | 142 | check, determinism |
| G-22 | 11 | 10 | determinism |
| G-23 | 18 | 15 | atomic, determinism |
| G-24 | 16 | 8 | determinism, graders |
| G-25 | 8 | 8 | atomic, clock |
| G-26 | 8 | 3 | clock |
| G-27 | 5 | 4 | clock |
| G-28 | 8 | 6 | clock |
| G-29 | 7 | 6 | clock, determinism |
| G-30 | 3 | 3 | clock, graders |
| G-31 | 4 | 3 | graders |
| G-32 | 5 | 4 | graders |
| G-33 | 7 | 4 | check, graders |
| G-34 | 5 | 3 | determinism, graders |
| G-35 | 3 | 2 | graders |
| G-36 | 3 | 2 | graders |
| G-37 | 2 | 2 | graders |
| G-38 | 2 | 2 | graders |
| G-39 | 4 | 2 | graders |
| G-40 | 1 | 1 | graders |
| G-41 | 1 | 1 | http |
| G-42 | 6 | 6 | http |
| G-43 | 6 | 6 | clock, graders, http |
| G-44 | 1 | 1 | http |
| G-45 | 19 | 19 | http |
| G-46 | 2 | 2 | paging |
| G-47 | 9 | 5 | paging |
| G-48 | 8 | 3 | paging |
| G-49 | 2 | 2 | paging |
| G-50 | 5 | 5 | edit |
| G-51 | 9 | 9 | edit |
| G-52 | 7 | 4 | edit |
| G-53 | 17 | 16 | edit |
| G-54 | 6 | 5 | edit |
| G-55 | 7 | 6 | cli, edit |
| G-56 | 10 | 7 | cli |
| G-57 | 3 | 2 | cli |
| G-58 | 4 | 2 | cli |

These guarantees have few firm tests, because they need the CLI or a full server:
- G-03, G-14, G-38, G-40, G-41, G-44 and G-49 have one or two each.
- G-41 and G-44 run only over HTTP (`bun run worldplay serve`, `src/cli/worldplay.ts`).

The spec-call proposals (`research/spec-calls/*.md`) reserve the ids G-59 to G-93. These have no tests until a proposal is accepted. The tests already written against a proposal are the `todo` tests RT-65, RT-66 and RT-67.

### Issue codes

The `mutations.ts` rows run through `G-07` in `redteam-check.test.ts`, and the task rows also run through the G-34 to G-40 groups in `redteam-graders.test.ts`. Two tests guard this table:
- `G-00 mutation table covers every world-triggerable ISSUES code` in foundation.
- `G-00 every world-triggerable code has a firm mutation row, apart from the known gaps` in gaps.

| Code | Firm rows | Todo rows |
|---|---|---|
| `schema.invalid` | S01–S25 | — |
| `ref.unknown` | R01–R06 | — |
| `route.duplicate_path` | R07, R08 | X23 (RT-83, in check) |
| `state.bad_machine` | R09–R12 | — |
| `seed.cycle` | R13 | — |
| `layer.blocked` | R14 | — |
| `snippet.compile_error` | C01–C07 | — |
| `snippet.runtime_error` | D01–D05, GR-grader-throws, GR-grader-writes | D19 (RT-42) |
| `snippet.promise_returned` | D06 | — |
| `snippet.call_quota` | D07 | — |
| `snippet.timeout_guard` | D08 (slow) | — |
| `constraint.violation` | D09–D17 | D18 (RT-15) |
| `test.failed` | T01–T04 | — |
| `action.unexercised` | L05 | — |
| `seed.too_few_rows_for_paging` | L01 | — |
| `seed.state_mix_skewed` | L02, L03 | — |
| `tasks.difficulty_not_spread` | L04 (RT-31 closed) | — |
| `task.grader_out_of_range` | 24 GR-range rows (12 values × noop and solution) | GR-range-negzero, which must be absent (RT-07) |
| `task.solution_not_full_marks` | GR-solution-first-page, GR-solution-noop | — |
| `task.noop_not_zero` | GR-noop-half, GR-noop-one | — |
| `task.idle_not_zero` | GR-idle-clock (A-198) | — |
| `task.alternative_not_full_marks` | GR-alternative-strict (A-199) | — |
| `task.decoy_required` | GR-decoy-required-medium, GR-decoy-required-hard | — |
| `task.decoy_full_marks` | GR-decoy-full | — |
| `task.decoy_trivial` | GR-decoy-trivial-reads, GR-decoy-trivial-solution | GR-decoy-trivial-failed-writes (RT-08), GR-decoy-trivial-noop (RT-10) |
| `task.prefix_full_marks` | GR-prefix-any, GR-prefix-medium | — |
| `task.freetext_unchecked` | GR-freetext-unchecked (G-61, A-388) | — |
| `task.omission_full_marks` | GR-omission-last-only (G-62, A-401) | — |
| `task.nondeterministic` | GR-nondeterministic-proto (G-24 in redteam-determinism.test.ts, RT-35 closed) | — |
| `world.too_few_tasks` | GR-too-few-one, GR-too-few-zero | — |
| `plan.not_covered`, `plan.fixture_changed`, `edit.out_of_scope`, `iterate.unplanned_change`, `iterate.regression` | WorldGen only. `checkWorld` must never emit them (checked in G-07) | — |
| `openapi.operation_missing`, `openapi.operation_extra`, `openapi.status_missing`, `openapi.required_field_missing`, `openapi.field_type`, `openapi.field_enum` | None. `openapiFidelity` emits them against a source spec, and `checkWorld` must never emit them (checked in G-07). `openapi-fidelity.test.ts` covers them | — |
| `snippet.host_unavailable` | None. Only the host's start timeout triggers it, never world content. `sandbox.test.ts` asserts it with `startMs: 0` | — |

No gaps remain: `KNOWN_GAPS` in `redteam-gaps.test.ts` is empty, and every world-triggerable code has a firm row.

### Open ambiguities

There are 88 RT `todo` tests across 55 RT ids, plus 2 `ENGINE-BUG` todos (EB-check-1). The spec calls that would resolve them:

| File | RT ids |
|---|---|
| `research/spec-calls/redteam-api-semantics.md` | RT-02, RT-12, RT-13, RT-18, RT-38, RT-43, RT-120 to RT-126 |
| `research/spec-calls/redteam-clock-jobs.md` | RT-20, RT-22, RT-23, RT-24, RT-27, RT-90, RT-115 |
| `research/spec-calls/redteam-verification.md` | RT-07, RT-08, RT-09, RT-10, RT-21, RT-25, RT-31, RT-62, RT-63, RT-87 |
| `research/spec-calls/redteam-check-report.md` | RT-14, RT-15, RT-42, RT-80 to RT-85, RT-88, RT-89 |
| `research/spec-calls/redteam-sandbox.md` | RT-35, RT-86, RT-110 to RT-114 |
| `research/spec-calls/redteam-edit-io-cli.md` | RT-29, RT-32, RT-91 to RT-99 |
| `engine-mutants.md`, `idle-noop.md` and `task-alternatives.md` (already filed) | RT-65, RT-66, RT-67 |
