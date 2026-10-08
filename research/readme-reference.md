# README reference

The detail the top-level [README](../README.md) used to carry, kept verbatim when the README was shortened on 2026-10-08. PR numbers below name PRs of the earlier repository, jop8281/zozo123-genworld, which is offline.

## Quickstart

From a fresh clone and the one install above, cheapest demo first. All of it runs from `code/`:

```sh
../scripts/demo.sh                                             # check, verify, serve, curl both ports, grade, stop
../scripts/solve-demo.sh                                       # an agent-side solve on the world port, graded on the admin port
bun run worldplay serve ../prod/worlds/helpdesk --port 4000    # world on 4000, admin on 4001
```

- [scripts/demo.sh](../scripts/demo.sh) runs the engine end to end. [scripts/solve-demo.sh](../scripts/solve-demo.sh) solves a task through the world port alone, then grades through the admin port: 1.000 for the solve, below 1 for the decoy attempt.
- `serve` gives the agent under test only the world port, with `GET /openapi.json`. The admin port serves `GET /_world/state`, `POST /_world/reset`, `GET /_world/log`, `POST /_world/clock` and `POST /_world/grade/<task>`.
- One world on a Boat VM, with `BOAT_API_KEY`, a finite `WORLDGEN_MAX_DAILY_SANDBOX_USD` and `BOAT_USD_PER_COMPUTE_HOUR` exported. Only the world port is exposed. `up` uploads the public form of the world, which has no graders, so grading on the VM (`POST /_world/grade/<task>` on its admin port) needs `--private`:

```sh
bun run sandbox up ../prod/worlds/helpdesk --backend boat --port 4317 --ttl 1800
```

- The software factory that targets this repo has its own replay demo, in [zozo123/ariflow-swfactory](https://github.com/zozo123/ariflow-swfactory): clone it, `uv sync --locked`, then `uv run swfactory demo`. It needs no model and no Airflow.

## Run WorldGen

```sh
bun run worldgen "A helpdesk with SLA tiers and on-call escalation"
```

The world lands in `../prod/worlds/gen-<slug>/` with `world.yaml`, `plan.yaml`, `REPORT.md` and `runs/<runId>/events.jsonl`. The run builds in `gen-<slug>.partial/` and renames it to `gen-<slug>/` only on success, which exits 0. On a stop or crash it exits 1 and leaves `gen-<slug>/` untouched. `REPORT.md` in `gen-<slug>.partial/` gives the reason, beside the run's capsule and logs. Other inputs and iteration use the same command:

```sh
bun run worldgen --openapi ../eval/inputs/petstore.openapi.yaml --out ../prod/worlds/gen-petstore
bun run worldgen --csv ../eval/inputs/orders.csv --out ../prod/worlds/gen-orders
bun run worldgen "add partial refunds" --world ../prod/worlds/gen-refunds
```

`--world` edits an existing world in place. Only the stages the change reaches rerun, and the rest are logged as `step_skipped`. Every stage passes the preservation gate, so a run that stops leaves `world.yaml` and `plan.yaml` as they were. Evidence: the live `gen-petstore-refunds` run (#264, $1.42, 5.5 minutes, 4 old tasks kept and 3 refund tasks added), and 20 change requests on `gen-todo-projects` (#298, [research/iterate-evidence.md](iterate-evidence.md)). 17 of the 19 valid runs passed check and verify with every base task kept. The 2 renames stopped and left the world unchanged.

**Model path (A-66, A-283).** Every call uses `claude-sonnet-5-5` by default. `model`, `stepModels` and `escalate` in `code/worldgen.config.json`, or `--model`, may name another Claude model that has a known price, built in or in `prices`; anything else is refused before a call, and no call falls back to a different model. Calls go through `claude -p` under your logged-in Claude Code session by default. The Anthropic SDK is opt-in with `--transport sdk` and reads its key from `LLM_KEY`. `.env` is never read. Each run uses a $5 cost estimate budget and 15-minute time budget by default, and `--budget-usd` and `--max-minutes` override that. A call whose estimated cost or allotted time won't fit is refused before it starts. Client pricing estimates do not guarantee the provider's invoice amount.

If `claude` on your PATH is a shell shim or wrapper, `claude -p` exits 127 inside WorldGen. Set `WORLDGEN_CLAUDE_BIN` to the real binary, for example `WORLDGEN_CLAUDE_BIN=$HOME/.local/bin/claude` (read at `code/src/cli/models.ts:49`).

## Status

Everything below is built and merged into the trunk. Each row names the PRs that built it. This repository starts from a one-commit snapshot of `stabilize/main` at c2528607 in the earlier repository, jop8281/zozo123-genworld, which no longer exists. So the PR numbers below are a historical record from that repository, kept as plain text. They are not PRs of this one.

| What | Where | PRs |
|---|---|---|
| Engine check in seven layers, from schema to lints | `code/src/engine/check.ts` | #15, #18, #26, #52, #76 |
| Engine serve with the admin port, verify, grade and docs | `code/src/engine/http.ts`, `code/src/cli/worldplay.ts` | #25, #26, #111 |
| OpenAPI document of a world, and the fidelity check `worldplay openapi` | `code/src/engine/openapi.ts`, `code/src/engine/openapi-fidelity.ts` | #29, #184 |
| Docker image with a health check | `Dockerfile` | #101, #134, #142 |
| Hand-built worlds | `prod/worlds/helpdesk/`, `prod/worlds/retail-tau2/` | #17, #32, #177, #215 |
| WorldGen run loop, judge, repair policy and `REPORT.md` | `code/src/worldgen/run.ts` | #31, #33, #230 |
| The `worldgen` CLI | `code/src/cli/worldgen.ts` | #67, #71, #345 |
| Description, OpenAPI and CSV inputs, with input coverage checks | `code/src/worldgen/input.ts`, `code/src/worldgen/input-coverage.ts` | #21, #72, #261, #346 |
| Iterate with `--world`, behind the preservation gate | `code/src/worldgen/iterate.ts` | #27, #205, #264, #298 |
| Rehearsal suite and `bun run eval` | `eval/suite.yaml`, `code/src/cli/eval.ts` | #30 |
| Spend ledger, separate LLM and sandbox meters, `bun run costs` | `code/src/costs/` | #34, #138 |
| Sandbox backends: OpenShell, sbx and Boat | `code/src/sandboxes/` | #35, #94, #97, #110 |
| Bun as the only runtime (A-379, A-381) | `code/bun.lock`, `scripts/runner.sh` | #164, #237, #359 |
| Live runner | `code/src/cli/live.ts`, `scripts/live.sh` | #107, #182 |
| `qualify-main.sh`, the gate on a fresh clone | `scripts/qualify-main.sh` | #324, #362 |
| Engine demo and solve demo | `scripts/demo.sh`, `scripts/solve-demo.sh` | #38, #149, #328 |
| Graded dataset export on Boat | `code/src/cli/dataset.ts` | #151 |
| Design doc | `prod/design.md` | #42, #135, #266 |
| Factory target contract: `factory.toml`, `factory-check.sh`, `REVIEW.md` and JUnit evidence (A-186); the retired `factory/integration` branch no longer triggers CI (YOS-210) | `factory.toml`, `scripts/factory-check.sh`, `REVIEW.md` | #419, #434 |
| Generated worlds | `prod/worlds/gen-*` | one per world, in [All worlds](#all-worlds) |

## 60-second demo

[scripts/demo-all.sh](../scripts/demo-all.sh) runs the whole system in 25 numbered steps with a PASS or FAIL line each. It covers helpdesk and four generated worlds through check and verify, every admin route, `solve-demo.sh`, the eval dry run, the WorldGen CLI, and one world's plan, report and run log. It makes no model call. `--live "<prompt>"` adds one WorldGen run with a $3 budget. [research/demo-runbook.md](demo-runbook.md) is the 15-minute talk track.

```sh
scripts/demo-all.sh                          # about a minute; exits 1 on any FAIL
```

[scripts/demo.sh](../scripts/demo.sh) runs the engine end to end: check, verify, serve, one call on each port, a grade, then stop. Run it from the repo root.

```sh
scripts/demo.sh                              # helpdesk on 4000, admin on 4001
LIST=auto TASK=auto scripts/demo.sh prod/worlds/gen-petstore 4100   # any world, any port
```

Expected output, trimmed:

```text
== check .../prod/worlds/helpdesk
ok
== verify: per task, solution 1, noop 0, decoys below 1
assign_newest_acme_ticket easy solution 1.000 noop 0.000 decoys [0.000, 0.000] prefix -
...
== GET /tickets (world port, what the agent under test sees)
{"count":25,"first":{"id":"tkt_0001", ...
== POST /_world/grade/assign_newest_acme_ticket (admin port; nothing was done, so expect 0)
{"task":"assign_newest_acme_ticket","score":0,"state":"4a92e68ff2df751541ba0f40f916f28c"}
== GET /_world/state on the world port is hidden from the agent (expect 404)
404
```

[scripts/solve-demo.sh](../scripts/solve-demo.sh) shows an agent solving a task on the world port alone, with `curl`. It grades through the admin port and prints score 1.000 for a helpdesk task and a gen-petstore task, then shows a decoy attempt on each scoring below 1. Needs `jq`.

```sh
scripts/solve-demo.sh                        # worlds on 4200 and 4201, one fresh server per attempt
```

## Run the engine

```sh
bun run worldplay serve ../prod/worlds/helpdesk --port 4000
```

The world's API is on port 4000, with `GET /openapi.json`. That is the only port the agent under test gets. The admin routes are on port 4001, bound to 127.0.0.1 unless `serve --admin-host` (or `WORLDPLAY_ADMIN_HOST`) says otherwise, even when `--host` makes the world port public.

| Route | Does |
|---|---|
| `GET /_world/state` | The full state dump: `now`, every table, counters |
| `POST /_world/reset` | Back to the seeded starting state |
| `GET /_world/log` | Every call the agent made |
| `POST /_world/clock` with `{"advance":"4h"}` | Moves engine time and fires due jobs |
| `POST /_world/grade/<task>` | Scores the current state for one task, 0 to 1 |

```sh
bun run worldplay check  ../prod/worlds/helpdesk                # every issue with path, expected, found and hint
bun run worldplay verify ../prod/worlds/helpdesk                # per task: solution 1, noop 0, decoys and prefixes below 1
bun run worldplay grade  ../prod/worlds/helpdesk <task> --state end.json   # score a saved GET /_world/state dump
```

With Docker, from the repo root:

```sh
docker build -t worldplay .
docker run -d --rm --name worldplay -p 4000:4000 worldplay serve /worlds/helpdesk --port 4000
until [ "$(docker inspect -f '{{.State.Health.Status}}' worldplay)" = healthy ]; do sleep 1; done
curl localhost:4000/openapi.json
docker stop worldplay
```

The container takes a few seconds to start. The image's `HEALTHCHECK` probes `GET /openapi.json` on port 4000, so the `until` line returns when the world is ready (it expects the default `--port 4000`). The image binds the world port on `0.0.0.0` and keeps the admin port on container loopback (`WORLDPLAY_ADMIN_HOST=127.0.0.1`), so only 4000 is published. To reach reset, state, clock and grade from the host, bind admin inside the container on purpose and publish it on host loopback only:

```sh
docker run -d --rm --name worldplay -p 4000:4000 -p 127.0.0.1:4001:4001 worldplay serve /worlds/helpdesk --port 4000 --admin-host 0.0.0.0
```

## Verified worlds

`bun run worldplay verify` on each world. A task passes when its reference solution scores 1, doing nothing scores 0, and every decoy and every strict prefix of the solution scores below 1.

### All worlds

Every directory in `prod/worlds/`. `test/worlds.test.ts` checks and verifies each one on every test run.

| World | Input | Tasks | PR |
|---|---|---|---|
| [helpdesk](../prod/worlds/helpdesk/) | hand-built | 3 | #17, #32 |
| [retail-tau2](../prod/worlds/retail-tau2/) | hand-built from τ²-bench retail | 8 | #177, #215 |
| [gen-bakery-vague](../prod/worlds/gen-bakery-vague/) | description | 3 | #206 |
| [gen-billing-dunning](../prod/worlds/gen-billing-dunning/) | description | 3 | #312 |
| [gen-bookmarks](../prod/worlds/gen-bookmarks/) | description | 4 | #311 |
| [gen-clinic-appointments](../prod/worlds/gen-clinic-appointments/) | description | 4 | #159 |
| [gen-course-enrollments](../prod/worlds/gen-course-enrollments/) | CSV | 3 | #276 |
| [gen-helpdesk](../prod/worlds/gen-helpdesk/) | description | 4 | #196 |
| [gen-hotel-booking](../prod/worlds/gen-hotel-booking/) | description | 4 | #191 |
| [gen-insurance-claims](../prod/worlds/gen-insurance-claims/) | description | 4 | #331 |
| [gen-library-loans](../prod/worlds/gen-library-loans/) | CSV | 3 | #366 |
| [gen-linear-backlog](../prod/worlds/gen-linear-backlog/) | CSV | 4 | #272 |
| [gen-orders](../prod/worlds/gen-orders/) | CSV | 4 | #386 |
| [gen-orders-customers](../prod/worlds/gen-orders-customers/) | CSV | 3 | #139 |
| [gen-petstore](../prod/worlds/gen-petstore/) | OpenAPI | 3 | #117, #433 |
| [gen-petstore-refunds](../prod/worlds/gen-petstore-refunds/) | iterate on `gen-petstore` | 6 | #264, #440 |
| [gen-refunds](../prod/worlds/gen-refunds/) | OpenAPI | 4 | #157 |
| [gen-rental-fleet](../prod/worlds/gen-rental-fleet/) | description | 4 | #241 |
| [gen-repair-desk](../prod/worlds/gen-repair-desk/) | iterate | 3 | #270 |
| [gen-retail-tau2-known](../prod/worlds/gen-retail-tau2-known/) | description | 4 | #238 |
| [gen-shipments](../prod/worlds/gen-shipments/) | CSV | 3 | #243 |
| [gen-stripe-charges](../prod/worlds/gen-stripe-charges/) | OpenAPI | 4 | #242 |
| [gen-stripe-customers](../prod/worlds/gen-stripe-customers/) | OpenAPI | 3 | #356 |
| [gen-todo-projects](../prod/worlds/gen-todo-projects/) | description | 3 | #154 |
| [gen-warehouse-inventory](../prod/worlds/gen-warehouse-inventory/) | description | 4 | #304 |

### Task scores

**helpdesk** (hand-built):

| Task | Level | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| assign_newest_acme_ticket | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a |
| escalate_breached_printer_ticket | medium | 1.000 | 0.000 | 0.000, 0.700, 0.000, 0.000 | n/a |
| escalate_breached_enterprise_tickets | hard | 1.000 | 0.000 | 0.571, 0.000, 0.000, 0.000, 0.000 | 0.857 |

**gen-petstore** (WorldGen from the Petstore OpenAPI spec, regenerated over `claude -p`, 9 attempts, 7.43 minutes, $2.72; scores from its [REPORT.md](../prod/worlds/gen-petstore/REPORT.md)):

| Task | Level | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| order_biscuit | easy | 1.000 | 0.000 | 0.000, 0.700 | n/a |
| deliver_cat_juniper | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.500 | n/a |
| release_stale_placed_orders | hard | 1.000 | 0.000 | 0.500, 0.000, 0.000 | 0.500 |

**gen-orders** (WorldGen from `orders.csv`, Sonnet over `claude -p`, 6 attempts, 5.9 minutes, $1.27):

| Task | Level | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| pay_oldest_pending_for_customer | easy | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a |
| refund_delivered_big_orders_for_customer | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a |
| cancel_stale_pending_with_gift_note | medium | 1.000 | 0.000 | 0.000, 0.000, 0.500 | 0.500 |
| ship_all_paid_large_orders | hard | 1.000 | 0.000 | 0.333, 0.000, 0.000, 0.333, 0.000, 0.000 | 0.667 |

## Other CLIs and scripts

Each command prints its usage with `--help`. The `bun run` commands run from `code/`, and the scripts run from the repo root. `scripts/live.sh` exits 2 unless `WORLDGEN_MAX_DAILY_USD` and `WORLDGEN_MAX_TOTAL_USD` are exported.

```sh
bun run eval --dry-run                      # validate the rehearsal suite and its inputs; no model call
bun run live --help                         # run WorldGen on every prompt in ../prod/prompts, then check and verify each world
bun run sandbox --help                      # up <worldDir> --backend openshell|sbx|boat, exec <id>, down <id>; only the world port is exposed;
                                            # the public form has no graders, so grading on the VM needs --private
bun run dataset --help                      # one graded solver episode per task in a Boat sandbox
```

```sh
scripts/live.sh --env-only                  # the live-run env check; no model call, nothing written; needs the two caps named above
scripts/qualify-main.sh --ref origin/main   # fresh clone: install, typecheck, check and verify every world, both demos
```

`bun run dataset` always needs `BOAT_API_KEY` and `WORLDGEN_BOAT_ORG`, and `bun run sandbox` needs both for the Boat backend. `WORLDGEN_BOAT_ORG` names the one Boat organization (wallet) this machine bills to (A-247). Every Boat create, inventory and usage call sends it, every Boat ledger line records it as `walletId`, `bun run costs -- --by wallet` groups spend by it, and Boat provisioning refuses without it. Stopping existing VMs never needs it. It is Boat's organization metadata, not a verified invoice. `bun run live` reads the prompt files described in [prod/prompts/README.md](../prod/prompts/README.md). The live runbook, [research/live-run-runbook.md](live-run-runbook.md), covers `bun run live` and `scripts/live.sh`.

## Checks and costs

```sh
bun run check                               # typecheck, then every test; no test calls a real model
bun run costs                               # spend so far across every run, with the daily and total caps
```

Every billed call is appended to one spend ledger, `~/.worldgen/costs.jsonl`. The ledger holds key fingerprints, never keys.

Boat provisioning requires `BOAT_USD_PER_COMPUTE_HOUR` and a finite `WORLDGEN_MAX_DAILY_SANDBOX_USD`, `WORLDGEN_MAX_DAILY_USD` or `WORLDGEN_MAX_TOTAL_USD`. The controller reserves the requested size's full provider TTL cost before creation. Missing caps or unknown pricing refuse creation. Delayed cleanup estimates at most that TTL, including after restart. Stopping an existing VM remains available without a cap or rate and when the cap is exhausted; unknown billing remains explicit in the ledger.

Model metering records a durable pending claim before starting a request. Applicable daily or total spending caps block other calls while that claim's cost is unknown, including after a crash or across midnight. A client-priced response settles the claim; a confirmed failure before the request started releases it. A started request without confirmed billing remains unresolved. This prevents concurrent admission against the same ledger but does not bound a single request's invoice amount. SDK configured prices, CLI reported costs and CLI fallback prices retain their basis as ledger estimates.

The admitted CLI estimate allowance uses the tightest applicable daily, total or LLM cap after subtracting settled spending and active VM reservations. It is computed from the journal prefix that admitted the request. The production CLI receives the smaller of that allowance and the run's remaining estimate budget as `--max-budget-usd`; a sandbox-only cap does not limit model calls. This requires the matching CLI transport implementation. Provider invoices can differ from client estimates.

`bun run costs` lists pending obligations separately from settled spending, even when no spending caps are configured. `bun run costs --json` includes a `pending` array with each claim's ID, provider/account, start time, run/model/stage, VM ID and known remaining reservation or unknown billing. `--since` filters settled spending; it does not hide current obligations. Model stage identity is captured before the request starts. An old pending claim is not evidence that no request started; reconciliation requires evidence of the actual provider outcome.

## Boat recovery and inventory

For an admitted Boat create whose response was lost, use `bun run costs --json` to find its pending reservation UUID, then run `bun run sandbox -- reconcile-create <reservation-uuid>`. The command replays the original account/key/payload within Boat's documented 24-hour key retention and immediately archives the returned VM. A failed original create may provision on replay; the retained admission covers its TTL. Recovery requires the new persisted idempotent-create marker, so older reservations cannot be replayed by assumption. A verified provider creation timestamp and confirmed archive replace unknown canonical billing with a configured-rate lifetime estimate; the raw unknown row stays in the journal. Missing creation time still triggers cleanup but retains unknown billing. Failed or in-progress recovery keeps exposure; an already bound verified VM can be archived after the replay window without another create. Concurrent recovery is exclusive per claim, and repeated completed recovery returns the settled identity. These are client estimates, not provider invoices. See the [Boat create contract](https://docs.boat.dev/api/reference/sandboxes/create-sandbox).


`bun run sandbox -- discover [--org <wallet>] [--day YYYY-MM-DD]` prints a read-only JSON comparison of Boat inventory with pending reservations and historical ledger entries. It follows every pagination cursor and rejects incomplete pagination instead of claiming a complete scan. Each safe row contains its identity, state, size, ownership, creation time and ledger presence; machine addresses and signed desktop URLs are excluded. Explicit owner rows include provider billable machine-seconds and list-price dollars. By default these are cumulative. --day requests a single UTC calendar window using the SDK since/until fields; the report names that requested window and refuses receipts that extend beyond it. A provider-clamped partial window remains visible in the receipt and is not treated as a complete day. Missing usage stays unavailable, and teammate or unattributed rows are not assigned to the current key. A historical row without a pending hold does not prove that a currently live VM is accounted for. This report does not import receipts, change caps, stop VMs or resolve old unknown claims. List-price usage is not a paid invoice. See [Boat inventory](https://docs.boat.dev/api/reference/sandboxes/list-sandboxes) and [usage](https://docs.boat.dev/api/reference/sandboxes/get-sandbox-usage).
