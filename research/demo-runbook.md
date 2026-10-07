# Demo runbook

How to show the whole system in 15 minutes with one command, [scripts/demo-all.sh](../scripts/demo-all.sh). The script runs offline: no model call and no paid call. It prints a numbered header and a PASS or FAIL line for each of 25 steps, then a summary table. It exits 1 on any FAIL. It took 31 to 51 seconds under `nice -n 15` on the shared machine on 2026-10-07, so you run it once and talk over the scrollback. In the dress rehearsal on 5b514434 it took 32 seconds. Act 1 ran 2.4 s, act 2 19.1 s, act 3 5.2 s, act 4 5.2 s and act 5 0.2 s. The one visible pause is steps 7 and 8, about 7 seconds each, because gen-library-loans seeds 300 loans.

The IDs in the tables are the rows of [spec-traceability.md](spec-traceability.md). For a prompt the team sends on the day, use [live-run-runbook.md](live-run-runbook.md) instead.

## 0. What to show on one page

### Open with five lines

1. A world is a working copy of real software, such as a helpdesk or a payments API: data, rules, an HTTP API, a clock and graded tasks.
2. WorldGen is an agent that builds a world from a description, an OpenAPI spec or CSV files, and it can change an existing world on request.
3. The engine is the only judge. It checks every world, enforces every write and grades every task, and WorldGen never grades itself.
4. A world counts only if each task's reference solution scores 1, doing nothing scores 0, and every wrong attempt scores below 1.
5. Everything you are about to see runs offline in one command, `scripts/demo-all.sh`, with no model call.

### Show it in five acts

| Act | Steps | What the audience sees | Spec IDs |
|---|---|---|---|
| 1. The engine is the judge | 1, 2 | The hand-built helpdesk passes check, then verify scores every task: solution 1.000, noop 0.000, decoys and prefixes below 1. | E8, E18, E19, G4, D1, D6 |
| 2. WorldGen from three inputs | 3 to 10 | Worlds generated from a description, a narrowed Stripe OpenAPI spec and two CSV files, plus one changed by an iterate run, pass the same two gates. | W5, W6, W7, W8, W9, M7, W16, W17 |
| 3. A world an agent can use | 11 to 21 | Helpdesk serves its API and `/openapi.json` on one port and the admin routes on another. The clock fires jobs, an illegal write is refused whole, then the log and a reset. A generated world serves the same way. | E2, E3, E4, E9 to E17, G1 |
| 4. An agent solves, the engine grades | 22 | `curl` on the world port solves a task and the admin port grades 1.000. A plausible wrong attempt grades below 1. | E17, E18, G1, G4 |
| 5. How WorldGen works and reports | 23 to 25 | The rehearsal suite parses, the CLI is one command, and one generated world shows its plan, its report and its run log with minutes and dollars. | M1, M2, M4, M8, M9, M10, W1, W4, W18, S6, D2, G3 |

### Name the gaps

These are the 13 Partial rows of [spec-traceability.md](spec-traceability.md), one line each. Its "What closes it" table gives the next step for each.

- **E7.** The format is strict, but the spec never defines "small", and the engine is 8,141 lines of TypeScript.
- **W10.** Resemblance is checked against a real spec only for OpenAPI input. For a description it is judged by eye.
- **W11.** A planned workflow can ship without a state field: gen-stripe-customers plans active and deleted, and models delete as removing the row.
- **W12.** Past events on one row are not ordered against each other, so shipped_at before placed_at still passes.
- **W14.** A skewed or missing state is mostly a warning, so a world can ship without a believable state mix.
- **W15.** The paging warning never blocks, and 10 of the 23 generated worlds carry it.
- **M2.** The plan's prose seed mix and plain-text rules are prompt-only. States, linked rules, jobs and row counts are judged.
- **M11.** The model is pinned to claude-sonnet-5-5 by the owner's decision (A-66). Budget, time and effort are settings.
- **G2.** gen-petstore adds 5 operations its spec does not have (category listing, order listing, approve and deliver), and description worlds get no fidelity check.
- **G3.** Hand-written harden scripts fixed graders after generation, and the one-assumption rule covers description input only.
- **G4.** Collateral damage, doing the task and then editing another row, is probed by a separate script, not by verify.
- **D7.** No world yet comes from the hiring team's prompts, because they have not been sent.
- **D8.** The live run on unseen prompts has not happened. The last robustness rehearsal passed 7 of 14 prompts.

## Before the talk

1. Check out origin/main @ <SHA TBD by worldgen-27 at 10:15> in a clean tree, then run `cd code && bun install --frozen-lockfile`. Without Bun, run `npm ci`.
2. From the repo root, run `scripts/demo-all.sh > ~/demo-known-good.log 2>&1`. Expect the last line `25 passed, 0 failed, <n>s`. Keep this log. It is the fallback for every step below.
3. Close other WorldGen sessions. Under heavy load a snippet can hit its 2 s guard, and a job or a check then fails.
4. Only if you will show `--live`, export `WORLDGEN_MAX_DAILY_USD` and `WORLDGEN_MAX_TOTAL_USD`, then run `scripts/live.sh --env-only`. Expect `env ok`.

## Talk track

Start `scripts/demo-all.sh 2>&1 | tee ~/demo.log` at minute 0. It finishes before you finish the first sentence, so walk the log from the top.

| Minutes | Steps | What to say |
|---|---|---|
| 0 to 1 | | Two tools. The engine checks, serves, enforces and grades worlds. WorldGen turns a description, an OpenAPI spec or CSV files into a world the engine accepts. One command shows both. |
| 1 to 3 | 1, 2 | The hand-built helpdesk. `check` is the gate a world must pass before it runs. `verify` proves each grader: the reference solution scores 1, doing nothing scores 0, and every decoy and every partial solution scores below 1. |
| 3 to 5 | 3 to 10 | The same two gates on worlds WorldGen generated, one from each input kind: a description, a narrowed Stripe OpenAPI spec, two CSV files, and an iterate run that changed an existing world. WorldGen never grades itself. These are the engine's own verdicts. |
| 5 to 9 | 11 to 20 | One served world, two ports. The agent under test gets the world port only. The admin port reads state, moves the clock, grades, shows the call log and resets. A write that breaks a rule is refused whole. |
| 9 to 10 | 21 | Any generated world serves the same way. The script picks the list route from the world's own `/openapi.json`. |
| 10 to 12 | 22 | An agent solves tasks with `curl` on the world port, and the admin port grades: 1.000 for the solution and below 1 for a plausible wrong attempt. |
| 12 to 14 | 23 to 25 | WorldGen without spending: the rehearsal suite parses, the CLI is one command, and one generated world shows its plan, its report and its run log with time and cost. |
| 14 to 15 | summary | `25 passed, 0 failed`. Then take questions, or start `--live`. |

## What each step proves

| Step | Shows | Spec IDs | Expected line | If it fails live |
|---|---|---|---|---|
| 1 | `worldplay check` on helpdesk | E8, D1, D6 | `PASS check helpdesk` | Show step 1 in the known-good log. A check failure on main is a regression, so say so. |
| 2 | `worldplay verify` on helpdesk, 3 tasks | E6, E18, E19, G4 | `escalate_breached_enterprise_tickets hard solution 1.000 noop 0.000 ... prefix 0.857` | Run `bun run worldplay verify ../prod/worlds/helpdesk` from `code/` once. A load timeout passes on the rerun. |
| 3, 4 | gen-rental-fleet, from a description | W5, W11, W16, W17, S5 | `triage_small_claims hard solution 1.000 noop 0.000 decoys [0.893, ...] prefix 0.964` | Same as step 2, with that world. |
| 5, 6 | gen-stripe-charges, from Stripe OpenAPI narrowed to charges | W6, W7 | `refund_remaining_balance_for_customer hard solution 1.000 ... prefix 0.933` | Same as step 2. |
| 7, 8 | gen-library-loans, from two CSV files | W8, W9 | `clear_riverside_overdue hard solution 1.000 ... prefix 0.917` | The two `seed.state_mix_skewed` warnings, printed under both step 7 and step 8, are expected (W14 is Partial). Each step pauses about 7 seconds. |
| 9, 10 | gen-repair-desk, changed by an iterate run | M7 | `reassign_and_start_dana_queue hard solution 1.000 ... prefix 0.500` | Same as step 2. |
| 11 | `worldplay serve` on two free ports | E9, D1 | `PASS world http://127.0.0.1:<port>, admin http://127.0.0.1:<port+1>` | Run `scripts/demo.sh`. It serves helpdesk on 4000 and 4001. |
| 12 | `GET /tickets`, the first page | E2, G1 | `-> 200 {"count":25,"first":{"id":"tkt_0001",...}}` | Show the known-good log. |
| 13 | `GET /openapi.json` | E2, E3 | `-> 200 {"openapi":"3.1.0","title":"helpdesk","paths":13}` | Same. |
| 14 | `GET /_world/state` | E14, E12 | `"rows":{"customer":60,...,"ticket":320,...}` | Same. |
| 15 | `POST /_world/clock {"advance":"4h"}` | E13, E4 | `"jobsFired":{"auto_close":4,"escalation_timeout":16,"sla_breach":16},"jobsFailed":[]` | A `jobsFailed` entry with `snippet process exited` means the machine is overloaded. Say so and show the known-good line. |
| 16 | `POST /_world/grade/assign_newest_acme_ticket` before any work | E17, E19 | `"score":0` | Same. |
| 17 | `PATCH /tickets/tkt_0001` with a legal priority and an illegal status | E10, E11 | `-> 422 {"code":"state.transition",...}`, then `{"status":"open","priority":"high"}` | Same. The point is that the legal half was not applied either. |
| 18 | `GET /_world/log` | E16 | `PASS 3 calls logged` | Same. |
| 19 | `POST /_world/reset` | E15, E12 | `-> 200 {"ok":true,"now":"2026-03-02T09:00:00.000Z"}` | Same. |
| 20 | `GET /_world/state` on the world port | E9 | `-> 404 {"code":"route.not_found",...}` | Same. The agent cannot read or grade its own state. |
| 21 | gen-rental-fleet served, list route from its `/openapi.json`, first task graded | E9, G1 | `PASS GET /branches 200, untouched cancel_elena_reservation grades 0` | Same. |
| 22 | `scripts/solve-demo.sh` | E17, E18, G1, G4 | `grade assign_newest_acme_ticket: score 1.000`, then a decoy at `0.000`, `order_available_pet` at `1.000`, then a decoy at `0.300` | Run `scripts/solve-demo.sh` alone. It needs `jq`. |
| 23 | `eval --dry-run` | M4, D8 | `29 of 29 cases ready` | Show `eval/suite.yaml`. The `*-impossible` cases expect a stop with a reason. |
| 24 | `worldgen --help` | D2, M1, M11 | `usage:` and the four input forms. The usage lines say `npm run worldgen --`, and `bun run worldgen` works the same. | Show the README section "Run WorldGen". |
| 25 | gen-library-loans `plan.yaml`, `REPORT.md` and `events.jsonl` | M2, W1, W4, W18, S6, M8, M9, M10, G3 | `{"result":"done","worldWritten":true,"costUsd":2.1728414,"ms":435872}` | Open `prod/worlds/gen-library-loans/REPORT.md` in an editor. |

## Run WorldGen live

`scripts/demo-all.sh --live "<prompt>"` runs the 25 steps, then the live steps. First it runs `scripts/live.sh --env-only`. If that fails, it makes no model call. Then it runs `bun run worldgen "<prompt>" --budget-usd 3 --out <temp dir>`, and then check, verify and the step 21 serve on the new world. With no prompt it uses a dental clinic front desk.

- It spends up to $3. Run it only when the owner has approved the spend for the day.
- The gen-library-loans run took 7.3 minutes. Start it at minute 1 in a second terminal, then come back to it after step 25.
- A stopped run is still a result (M4). Open `<temp dir>.partial/REPORT.md` and read the reason aloud.
- To keep a live world, copy it to `prod/worlds/gen-<slug>` and follow section 4 of [live-run-runbook.md](live-run-runbook.md).

## Live segment

Three unseen inputs, one per input kind. No world in `prod/worlds`, no case in `eval/suite.yaml` and no prompt in [rehearsal-prompts.md](rehearsal-prompts.md) uses their domains. They are the cases of a second suite, [eval/live-segment.yaml](../eval/live-segment.yaml), so a full `bun run eval` never runs them. Each run spends up to $3, so start one only after the owner has approved the spend for the day. A run takes up to 12 minutes, so a 15-minute talk has room for one. Start it at minute 1 in a second terminal.

| # | Input | Domain | Kind | Good result |
|---|---|---|---|---|
| L1 | A concert box office: events with seated sections, seat holds that expire after 15 minutes unless paid, orders capped at 6 tickets per customer per event, and refunds allowed until 48 hours before the show. | ticketing | normal | A job on the engine clock expires an unpaid hold and frees its seats. A seventh ticket for one customer and event is refused with no change. A refund inside 48 hours of the show is refused, and one outside it releases the seats. |
| L2 | [eval/inputs/live/giftcards.openapi.yaml](../eval/inputs/live/giftcards.openapi.yaml) with `--only /v1/gift_cards`: a hand-written gift card API with 10 operations, 8 of them under that path. | stored value | openapi | The 8 card operations keep their methods, paths and `{"error":{"code","message"}}` envelope (gate O). A redeem above the balance, or any redeem on a frozen card, is a 409 and the balance never goes negative. Merchants and payouts are left out. |
| L3 | [eval/inputs/live/gym-bookings.csv](../eval/inputs/live/gym-bookings.csv): 155 bookings in 16 fitness classes, one denormalized table. `code/scripts/gen-gym-csv.ts` writes it from a seed. | fitness studio | csv | Classes and bookings become two entities with a reference between them. A booking past capacity is waitlisted, a cancellation promotes the oldest waitlisted booking, and the seed keeps the CSV's rows and statuses. |

### Before the segment

From `code/`, check the three inputs with no model call. Expect `3 of 3 cases ready`.

```sh
bun run eval --suite ../eval/live-segment.yaml --dry-run
```

Then export `WORLDGEN_MAX_DAILY_USD` and `WORLDGEN_MAX_TOTAL_USD`, and run `scripts/live.sh --env-only` from the repo root. Expect `env ok`.

Run any Boat step (`sandbox up`, `dataset`) in a shell where `WORLDGEN_MAX_DAILY_USD` and `WORLDGEN_MAX_TOTAL_USD` are not exported, or skip Boat. With those caps set and `BOAT_USD_PER_COMPUTE_HOUR` unset, `meteredSandbox` refuses to start before it creates a VM (`code/src/costs/meter.ts:290-293`, tested in `code/test/costs.test.ts`), with `WORLDGEN_MAX_DAILY_USD is set but boat sandbox time is unpriced: set BOAT_USD_PER_COMPUTE_HOUR so the cap can be enforced`.

### Run one

From `code/`, run the line for the chosen input. `--budget-usd 3 --max-minutes 12` makes the A-48 limits of $5 and 15 minutes tighter.

```sh
bun run worldgen "A concert box office: events with seated sections, seat holds that expire after 15 minutes unless paid, orders capped at 6 tickets per customer per event, and refunds allowed until 48 hours before the show." --budget-usd 3 --max-minutes 12 --out /tmp/live-segment/gen-box-office
bun run worldgen --openapi ../eval/inputs/live/giftcards.openapi.yaml --only /v1/gift_cards --budget-usd 3 --max-minutes 12 --out /tmp/live-segment/gen-giftcards
bun run worldgen --csv ../eval/inputs/live/gym-bookings.csv --budget-usd 3 --max-minutes 12 --out /tmp/live-segment/gen-gym-bookings
```

The run exits 0 when it wrote `world.yaml`, and 1 on a stop. A stop is still a result (M4). Read the reason in `REPORT.md` aloud. A stop leaves its REPORT.md in `/tmp/live-segment/gen-<name>.partial/`.

### What success looks like

Run these from `code/` on the new directory, shown here for L1.

```sh
bun run worldplay check  /tmp/live-segment/gen-box-office                # exit 0 and zero errors; warnings are listed, not failures
bun run worldplay verify /tmp/live-segment/gen-box-office                # every task: solution 1.000, noop 0.000, decoys and prefixes below 1
bun run worldplay serve  /tmp/live-segment/gen-box-office --port 4500    # then curl localhost:4500/openapi.json, and grade a task on 4501
```

For L2, also compare the world with its source spec. Expect exit 0.

```sh
bun run worldplay openapi /tmp/live-segment/gen-giftcards --spec ../eval/inputs/live/giftcards.openapi.yaml --only /v1/gift_cards
```

### Score it

After the talk, score each run against [rehearsal-rubric.md](rehearsal-rubric.md) and write one line per run in its section 6 format. Fill in the outcome, the gates, the five scores and the total. Read `$` and `min` from the run's `events.jsonl`. Gate B still reads the A-48 limits of $5 and 15 minutes. Bank is `-` because these inputs are not in the bank. The note carries what YOS-58 asks for: the minutes to the first passing `verify`, and `touched: no`.

```
| id               | kind    | outcome | gates | F W S T H | /10 | bank | $ | min | note |
| l1-box-office    | normal  |         |       |           |     | -    |   |     |      |
| l2-giftcards     | openapi |         |       |           |     | -    |   |     |      |
| l3-gym-bookings  | csv     |         |       |           |     | -    |   |     |      |
```

### Rehearsal on 2026-10-07

Each case ran through `bun run eval --suite ../eval/live-segment.yaml --only <id>`, with the commands above. The scorecard and each case's `events.jsonl` and `REPORT.md` are in [eval/runs/2026-10-07-live-segment/](../eval/runs/2026-10-07-live-segment/summary.md). The L2 run that passed is in [giftcards-openapi-rerun2/](../eval/runs/2026-10-07-live-segment/giftcards-openapi-rerun2/summary.md). The worlds were not committed.

```
| id               | kind    | outcome | gates  | F W S T H | /10 | bank | $    | min | note                                                          |
| l1-box-office    | normal  | PASS    | ok     | 2 2 0 2 2 | 8   | -    | 2.20 | 7.5 | seed: 3 entities too few to page, 2 skewed; touched: no       |
| l2-giftcards     | openapi | FAIL    | fail:R | - - - - 2 | -   | -    | 0.71 | 3.3 | no_progress at workflow: tests expect not_found, engine says row.not_found |
| l3-gym-bookings  | csv     | PASS    | ok     | 2 2 1 1 2 | 8   | -    | 1.83 | 8.0 | hard task has a one-write solution; touched: no               |
| l2-giftcards r1  | openapi | FAIL    | fail:R | - - - - 2 | -   | -    | 2.43 | 8.9 | backtrack_limit at tasks: scoped list declared no 404 (#408)  |
| l2-giftcards r2  | openapi | PASS    | ok     | 2 2 2 2 2 | 10  | -    | 1.88 | 7.6 | check ok with 0 warnings; openapi conforms; touched: no       |
```

L1, L2 and L3 have each passed on `12e10fe` or later. Each passing world served on its own ports: `/openapi.json` answered, a list route returned 200, an untouched task graded 0, and `GET /_world/state` on the world port returned 404.

L2 needed two fixes. [#398](https://github.com/jop8281/zozo123-genworld/pull/398) gives the plan step the engine's error codes, so its tests expect `row.not_found` for an unknown id. [#408](https://github.com/jop8281/zozo123-genworld/pull/408) makes a list under a parent, such as `GET /v1/gift_cards/{gift_card}/activities`, declare the 404 the engine already answers, so the OpenAPI fidelity check finds it.

In a repeat run on `3ff2c3a`, L3 stopped once: `no_progress` at workflow after 3.5 minutes and $0.85. The plan froze a test that contradicts itself. After one clock advance it asserts a member's no-show count is 1, then 2, with no call in between, while the job correctly marks both bookings at once. The workflow step cannot edit tests. [#405](https://github.com/jop8281/zozo123-genworld/pull/405) sends this shape back to the plan step, which then has to write a consistent test. It is not a guaranteed fix.

### If a run stops

Any of the three can run on stage. L2 is the strongest result: 10/10, zero check warnings, and an OpenAPI world that conforms to its spec.

If a run stops on stage, take these steps:

1. Open the run's `REPORT.md`, in the output directory's `.partial/` sibling. Read the first line, `Stopped: <reason>`, and the issues under "Last issues" aloud. A stop with a stated reason is a result (M4). WorldGen wrote no `world.yaml` rather than ship a world that fails its own checks.
2. Show a committed world of the same input kind that passed. Steps 3 to 8 of `scripts/demo-all.sh` check and verify one per kind: `gen-rental-fleet` for a description, `gen-stripe-charges` for OpenAPI and `gen-library-loans` for CSV.
3. To finish on a live pass, start another of the three. Each took about 8 minutes in rehearsal.

## Override a world

The script takes environment variables for the worlds it shows: `DESCRIPTION_WORLD`, `OPENAPI_WORLD`, `CSV_WORLD`, `ITERATE_WORLD` and `SHOW_WORLD`. Each is a directory name under `prod/worlds`. For example, `CSV_WORLD=gen-shipments scripts/demo-all.sh`.
