# Acceptance bundle, 2026-10-07

This file ties each released SHA to the evidence recorded for it on 2026-10-07 (YOS-108). Each row names its source. Files under `~/worldgen-ops/evidence/` live on the release machine and hold no keys. They are not in the repo, so the numbers below are copied from them. A row marked "reported" has no log file. Its numbers come from the session that ran it.

## Released SHAs

Each promotion merges one `stabilize/main` head into `main`. The PR numbers are from the earlier repository, jop8281/zozo123-genworld (old repo), which no longer exists.

| main | stabilize head | PR | Merged (UTC) |
|---|---|---|---|
| `1bb94583` | `fc39ef8` | #383 | 14:51 |
| `3ff2c3a3` | `9e51479` | #403 | 15:52 |
| `21dd0039` | `12e10fe` | #410 | 16:21 |

`21dd0039` is the demo main. It adds only #408 to `3ff2c3a3`.

## Full test suite

Node 22, `node --import tsx --test`, run locally on the stabilize head before each promotion. 190 tests are marked todo.

| stabilize head | main | Tests | Pass | Fail | Todo | Source |
|---|---|--:|--:|--:|--:|---|
| `fc39ef8` | `1bb94583` | 4209 | 4019 | 0 | 190 | `full-fc39ef8.log` |
| `9e51479` | `3ff2c3a3` | 4244 | 4054 | 0 | 190 | `full-9e51479.log`. Bun `http.test.ts`: 35 pass, 0 fail, `bun-http-9e51479.log` |
| `12e10fe` | `21dd0039` | 4246 | 4056 | 0 | 190 | `full-12e10fe.log`. Bun `http.test.ts` and `openapi.test.ts`: 71 pass, 0 fail, `bun-12e10fe.log` |

## qualify-main

`scripts/qualify-main.sh` on a fresh clone of `origin/main`. A QUALIFIED verdict covers typecheck, check and verify on every world (25 of 25 `verifyOk`), and both demos. It does not run the test suite.

| main | Qualifier | Bun | Node | Source |
|---|---|---|---|---|
| `1bb94583` | with #373 | QUALIFIED, exit 0 | QUALIFIED, exit 0 | `qualify2-bun.log`, `qualify2-node.log` |
| `3ff2c3a3` | with #373 and #397 | QUALIFIED, exit 0 | QUALIFIED, exit 0 | `qualify3-bun.log`, `qualify3-node.log` |
| `21dd0039` | not run | - | - | - |

An earlier QUALIFIED on `1bb94583` used the qualifier from before #373, which could pass a failed check. It is not counted here.

## demo-all in Boat

`scripts/demo-all.sh` inside one Boat sandbox. Reported by worldgen-2b, with no log file.

| main | Result | Time | Sandbox |
|---|---|--:|---|
| `1bb94583` | 25 of 25 passed | 50.5 s | `bx_rm2na3ja` |
| `3ff2c3a3` | 25 of 25 passed | 49 s | `bx_4qrvnu7p`, teardown confirmed |

## Boat sandbox sweep

On `stabilize/main` `33f158a7`, every one of the 25 worlds came up in a Boat sandbox and answered `/openapi.json` and a list route with 200. `gen-shipments` and `gen-library-loans` needed a retry when they ran in 3 parallel lanes. On `gen-orders` the admin-route probe on the world port got no HTTP response in 20 seconds (`000`), not the 404 the other worlds returned. The log is in [evidence/boat-sweep-2026-10-07.md](evidence/boat-sweep-2026-10-07.md).

## Live WorldGen runs (L1 to L3)

Each case of [eval/live-segment.yaml](../eval/live-segment.yaml) ran with `claude-sonnet-5-5` over `claude -p`, `--budget-usd 3 --max-minutes 12`. Scores use [rehearsal-rubric.md](rehearsal-rubric.md). The runs used stabilize heads. `12e10fe` is the same tree as main `21dd0039`.

| Case | stabilize head | Result | $ | Min | Score | Source |
|---|---|---|--:|--:|---|---|
| L1 box-office (description) | `862a3927` | done, verify 3 of 3 | 2.20 | 7.5 | 8/10 | [summary](../eval/runs/2026-10-07-live-segment/summary.md) |
| L2 giftcards (OpenAPI) | `862a3927` | stopped, `no_progress` at workflow | 0.71 | 3.3 | fail | same summary. Fixed by #398 |
| L2 giftcards, rerun 1 | `9e514791` | stopped, `backtrack_limit` at tasks | 2.43 | 8.9 | fail | not committed. Fixed by #408 |
| L2 giftcards, rerun 2 | `12e10fe` | done, verify 3 of 3, `worldplay openapi` conforms | 1.88 | 7.6 | 10/10 | [summary](../eval/runs/2026-10-07-live-segment/giftcards-openapi-rerun2/summary.md) |
| L3 gym-bookings (CSV) | `862a3927` | done, verify 4 of 4 | 1.83 | 8.0 | 8/10 | [summary](../eval/runs/2026-10-07-live-segment/summary.md) |

## Stress run 2

On main `3ff2c3a3`, 22 of 29 cases passed (75.9%), over 30 runs, 177.7 minutes and $34.65. The scorecard is [eval/runs/2026-10-07-stress-2/summary.md](../eval/runs/2026-10-07-stress-2/summary.md).

## GitHub Actions on main 21dd0039

As read at about 17:15 UTC. Push run `37651398363`: `node` failed, `e2e` failed, and `check` was still in progress. Dispatch run `37651460024` was cancelled. The e2e failure was the 10-minute step cap, which #411 raises. The cause of the `node` failure is not recorded.

## Gaps

- The demo main `21dd0039` has no qualify-main run and no green Actions run. Its evidence is the full suite on `12e10fe` and the L2 rerun on the same tree.
- demo-all in Boat has no log file.
- L1 and L3 ran on `862a3927`, a stabilize head that was never promoted as such. Main `3ff2c3a3` and `21dd0039` contain it, and `1bb94583` does not.
