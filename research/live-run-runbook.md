# Live-run runbook

The checklist for the day the hiring team sends prompts: "They run WorldGen live on unseen prompts at the end", and the deliverable includes "the worlds WorldGen generated from prompts they send" ([spec.md](spec.md)). Each step names its command. Every command here exists on the trunk: `worldplay` (check, verify, serve), `worldgen`, `bun run live`, which runs sections 3 and 4 and writes the section 7 table for every prompt in `prod/prompts/`, and `scripts/live.sh`, the one-command version for a single prompt (§3).

**Known issues until they are fixed.** (1) Until worldgen-44's hang fix merges, a description run can hang: a step starts, no `claude` child process is alive, and the log stays silent. If a step is silent for 3 minutes, press Ctrl-C and record a stop (§3, §5). (2) Iterate mode is not implemented (`not implemented: iterate mode (wg-iterate)`), so a `<NN>-<slug>.change.txt` file and `--world` fail after the create run. Do not promise a change-request demo.

The day runs in this order: preflight → intake → run each prompt → check and verify → commit → score → report. Rollback (§8) can happen at any point.

All commands run from `~/worldgen/code` unless they say otherwise.

## 0. Roles

- **Operator**: types the commands and touches nothing else while a run is going.
- **Scorer**: fills in the rubric from the artifacts. This can be the same person afterwards, or a separate model session, but never the WorldGen run itself.
- One prompt runs at a time. Runs are sequential, as in the eval runner (YOS-51), so cost and time are attributed cleanly.

## 1. Preflight (about 15 minutes, before any prompt)

| # | Check | Command | Pass when |
|---|---|---|---|
| P1 | On the release commit | `git fetch && git switch main && git pull --ff-only && git rev-parse HEAD` | The SHA equals the release tag (`git rev-parse live-ready^{}`). Write the SHA in the session log |
| P2 | Release tag exists | `git ls-remote --tags origin live-ready` | The tag is printed. It does not exist yet on a new clone: tag the last green main **before** the session (`git tag -a live-ready -m "live run" <sha> && git push origin live-ready`). Rollback (§8) depends on this tag |
| P3 | Clean tree | `git status --porcelain` | No output |
| P4 | Install | `bun install --frozen-lockfile` | exit 0. Without Bun, `npm ci` |
| P5 | Repo green | `bun run check`, then `npm ci && npm run check:node` | Both exit 0. The default gate typechecks and runs every test under Bun; the second runs the same files under node:test on Node 22 and is the only one that enforces the snippet heap bound (A-87, A-134). Both include `worlds.test.ts`, which checks and verifies every world already in `prod/worlds` (A-42) |
| P6 | The real `claude` binary | `export WORLDGEN_CLAUDE_BIN="$HOME/.local/bin/claude" && "$WORLDGEN_CLAUDE_BIN" --version` | Prints a version. `WORLDGEN_CLAUDE_BIN` must be the absolute path of the real binary, not the cmux shim: with the shim `claude -p` exits 127 inside WorldGen ([claude-cli-transport.md](claude-cli-transport.md) §5) |
| P7 | Logged in | `claude auth status` | exit 0, and `authMethod` is `claude.ai` or `oauth_token`. Never set `ANTHROPIC_API_KEY` or `LLM_KEY` for the default transport (A-56) |
| P8 | Budget per A-48, and the spend caps | `grep -E '"maxCostUsd"\|"maxMinutes"' worldgen.config.json`, then `export WORLDGEN_MAX_DAILY_USD=25 WORLDGEN_MAX_TOTAL_USD=100` | `maxCostUsd` 5 and `maxMinutes` 15, and both ledger caps exported (they are env only; the ledger is `~/.worldgen/costs.jsonl`, read with `bun run costs`). A Boat step (`sandbox up`, `dataset`, `scripts/boat-ci.sh`) also needs `WORLDGEN_BOAT_ORG`, the one Boat organization this machine bills to (A-247). Without it Boat provisioning refuses with `WORLDGEN_BOAT_ORG is not set: ...`, and `scripts/live.sh` only reports it, since the live run itself starts no VM. Run any Boat step in a shell where `WORLDGEN_MAX_DAILY_USD` and `WORLDGEN_MAX_TOTAL_USD` are not exported, or skip Boat. With those caps set and `BOAT_USD_PER_COMPUTE_HOUR` unset, `meteredSandbox` refuses to start before it creates a VM (`code/src/costs/meter.ts:290-293`, tested in `code/test/costs.test.ts`), with `WORLDGEN_MAX_DAILY_USD is set but boat sandbox time is unpriced: set BOAT_USD_PER_COMPUTE_HOUR so the cap can be enforced`. |
| P8b | A quiet machine | `scripts/live.sh --env-only` | The load average is at most twice the CPU count. A live run is timed: each step gets a share of the 15 minutes, and a loaded machine slows every call and can trip the 2 s snippet guard (the example world then fails its own check at startup: `example world ... does not check: snippet.runtime_error`, exit 2, and a rerun passes once the load drops) |
| P9 | Engine smoke | `bun run worldplay verify ../prod/worlds/helpdesk` | Every task prints `solution 1.000 noop 0.000`, exit 0 |
| P10 | Env and CLI dry runs | `scripts/live.sh --env-only`, `bun run worldgen --help`, `bun run live ../prod/prompts --dry-run` | The env check prints `env ok` (binary, login, no `ANTHROPIC_API_KEY`, both caps). The help lists `--out`, `--model`, `--budget-usd`, `--max-minutes`, `--openapi`, `--csv`, `--world`. Before intake (§2), the intake dry run prints `No prompts in .../prod/prompts` and exits 2, which is expected. After intake it lists every prompt and no problem. None of them calls the model |
| P11 | One live warm-up | `scripts/live.sh warmup "A todo app with projects, tasks and due dates"` | Ends `done`, and check, verify and the served demo pass on `prod/worlds/gen-warmup`. It costs up to $5, so do it once, then `git clean -fd prod/worlds/gen-warmup` or `rm -rf` it before intake |

If any check fails, stop and fix it, or roll back (§8) **before** you accept prompts.

## 2. Intake

Their prompts go into `prod/prompts/`, one file per prompt, committed exactly as received. [prod/prompts/README.md](../prod/prompts/README.md) is the format, and `bun run live ../prod/prompts --dry-run` lists what it found and names every file it cannot read, with no model call.

```
prod/prompts/
  <NN>-<slug>.txt          # description: the exact text, unedited
  <NN>-<slug>.openapi.yaml # OpenAPI input, plus <NN>-<slug>.args with e.g. "--only /v1/refunds"
  <NN>-<slug>/*.csv        # CSV input: every file as sent
  <NN>-<slug>.change.txt   # a change request on a world already generated
```

- `NN` is the order received. The slug is lowercase kebab-case and names the software (prod/README.md), for example `03-dental-clinic`.
- Commit the intake before running anything: `git add ../prod/prompts && git commit -m "Intake: hiring-team prompts as received"`. This is the evidence that nothing was tuned to the prompts.
- **Never** edit a prompt. If it is ambiguous, that is WorldGen's job: it makes a call and writes it down. If the team clarifies a prompt, add the clarification as a new file `<NN>-<slug>.v2.txt`, and record both runs.
- Secrets in an input: WorldGen redacts them (`redact`). The operator still checks the input by eye before committing it. If there is a real credential, ask the team for a scrubbed copy.

## 3. Run each prompt

Run one prompt at a time, with the default config and the A-48 limits. Do not touch anything while it runs.

For one prompt, `scripts/live.sh <slug> "<description>"` (or `<slug> --openapi <spec> [--only <prefix>]`, or `<slug> --csv <file>...`) does the env check, the run into `prod/worlds/gen-<slug>/`, then check, verify and a served demo that GETs a list route and grades the first task on the admin port. `scripts/live.sh --dry-run <slug> ...` stops before the model call. `scripts/solve-demo.sh` is not part of it: it drives the helpdesk world with hand-written calls and replays one gen-petstore task's own solution and first decoy over the world port, and `verify` already runs every generated task's own reference solution.

The usual way is one command for the whole intake. It runs each prompt in order, checks and verifies each world (section 4), moves a verified world to `prod/worlds/gen-<slug>/`, keeps a stop or an invalid world under `eval/runs/<date>-live/`, and writes `prod/LIVE-RUN.md`. A prompt whose world is already in `prod/worlds` is skipped, so it can be run again after a fix:

```sh
export WORLDGEN_CLAUDE_BIN="$HOME/.local/bin/claude" WORLDGEN_MAX_DAILY_USD=25 WORLDGEN_MAX_TOTAL_USD=100
bun run live ../prod/prompts --commit $(git rev-parse --short HEAD)
# one prompt: add --only 03-dental-clinic
```

It exits 0 when every prompt was delivered and 1 otherwise. The commands below are what it does for each prompt, for running one by hand. Export `WORLDGEN_CLAUDE_BIN` and the two spend caps first (P6, P8).

```sh
export WORLDGEN_CLAUDE_BIN="$HOME/.local/bin/claude"
SLUG=03-dental-clinic; OUT=../prod/worlds/gen-${SLUG#*-}
# description
bun run worldgen "$(cat ../prod/prompts/$SLUG.txt)" --out $OUT --budget-usd 5 --max-minutes 15
# OpenAPI
bun run worldgen --openapi ../prod/prompts/$SLUG.openapi.yaml $(cat ../prod/prompts/$SLUG.args) --out $OUT --budget-usd 5 --max-minutes 15
# CSV
bun run worldgen --csv ../prod/prompts/$SLUG/*.csv --out $OUT --budget-usd 5 --max-minutes 15
# change request on an existing generated world: iterate mode is not implemented yet, so this fails today
bun run worldgen "$(cat ../prod/prompts/$SLUG.change.txt)" --world $OUT --budget-usd 5 --max-minutes 15
```

- Write the start time in the session log. The run streams one line per step and attempt (step, attempt n, ms, $). Leave it alone.
- Exit 0 means `done`. Go to §4.
- Exit 1 means a stop: the reason prints on one line. Go to §5.
- Exit 2 means a setup error, such as the CLI not being logged in. Fix it, then rerun the same prompt. This does not count as a WorldGen attempt.
- If a step prints nothing for 3 minutes and no `claude` child process is alive (`pgrep -P <worldgen pid>`), that is the known description-run hang (see the top of this file): press Ctrl-C, record it as a stop with reason `hang (operator)`, and note the stage that was running. A hard ceiling of 15 minutes plus a 2-minute grace period. If the process is still running after that, press Ctrl-C once (SIGINT ends the turn cleanly) and wait 10 seconds before killing it. Record it as a stop with reason `time_exhausted (operator)`.

## 4. Check and verify before committing

A world goes into `prod/worlds/gen-<slug>/` only if all of these pass. This mirrors rubric gates R, C, V, T, B and A.

```sh
bun run worldplay check  $OUT          # exit 0, no errors
bun run worldplay verify $OUT          # every task "solution 1.000 noop 0.000", decoys and prefixes < 1
bun run test                              # worlds.test.ts re-checks and re-verifies every prod world (A-42)
ls $OUT/world.yaml $OUT/plan.yaml $OUT/REPORT.md $OUT/runs/*/events.jsonl
```

- **Do not hand-edit** any file WorldGen wrote. Only `saveWorld` writes `world.yaml` (prod/README.md, A-29). If a world needs a fix, the fix is a rerun or a change request, which is recorded too.
- If all of this passes: `git add ../prod/prompts/$SLUG* $OUT && git commit -m "gen-<slug>: generated from hiring-team prompt NN"`.
- If check or verify fails on a world that WorldGen reported as `done`, that is a WorldGen bug: the judge accepted a world the engine rejects (fix-wg-judge). Do not commit it to `prod/worlds`. Move it to `../eval/runs/<date>-live/<slug>/` and treat it as §5 with the reason `accepted-but-invalid`.

## 5. On a stop (FAILED)

A stop is a legitimate outcome. The spec asks WorldGen to "know when to stop" and to say why rather than hand over a broken world.

1. **Keep everything.** WorldGen writes no `world.yaml` on a stop. Move the output directory to `../eval/runs/<date>-live/<slug>/`, outside `prod/worlds`, so `worlds.test.ts` stays green. Commit it, so the stop report is part of the record.
2. **Read the stop report.** It is `REPORT.md` in `<output directory>.partial/`, because a stopped create leaves the output directory untouched. It starts with `Stopped: <kind>` and ends with `No world.yaml was written.`, and it names the last issues and a suggested narrower request. There is no `FAILURE.md`.
3. **Classify the stop** with [rehearsal-rubric.md](rehearsal-rubric.md) §4: `STOP-HONEST` for an impossible or out-of-scope prompt, otherwise `STOP-UNRELATED`.
4. **Retry at most once, and only for a non-prompt cause:**
   - `model_error` (a network or CLI hiccup), or exit 2: rerun the same command once.
   - `stage_time_exhausted` after a `share_expired` attempt, or `transport_stalled`, is the transport ending a call, not a hiccup: a call ran past its step's share of the time left, or `claude -p` wrote nothing for 120 s twice on one step (one stall is retried in the run, with a `stall_retry` event). Give it the same single rerun on a quieter machine.
   - `budget_exhausted` or `time_exhausted` on a prompt that should be buildable: one rerun with **the same limits**. Record both runs. Do not raise the budget to rescue a run unless the team asks; if they do, record that it was a budget override.
   - `input_rejected`, or an honest stop on an impossible prompt: **no retry**. That stop is the deliverable.
   - `no_progress`, `attempts_exhausted` or `backtrack_limit`: no live retry. Record it, and list it as a generic fix after the session.
5. **Never** change code, prompts, briefs or config between the prompts of one session. Fixes come after the session, and must be generic (YOS-53 rule).

## 6. Score

Fill in one [rehearsal-rubric.md](rehearsal-rubric.md) row per prompt, from the artifacts only, after each run is committed or archived:

```
| id | kind | outcome | gates | F W S T H | /10 | bank | $ | min | note |
```

- `bank` is `-`, because their prompts are not in our bank. Instead, the scorer writes one sentence on what a good result would be, before opening the world, so the score is not anchored on what was built.
- Add the totals block (rubric §7): pass rate, mean score, median and p95 for $ and minutes, and gate failures by letter. Also add minutes to the first passing `verify` for each prompt.
- Save it as `../eval/runs/<date>-live/summary.md` and commit it.

## 7. The report back to the team

Send one message with the following, or commit `prod/LIVE-RUN.md`, which `bun run live` writes with the outcome, minutes, dollars and engine verdict for each prompt (the blocks below add what only a person can write):

1. **Commit**: the release SHA from P1, and the commit that holds the generated worlds.
2. **For each prompt, one block:**
   - the prompt as received (or a link to its `prod/prompts/` file)
   - the outcome (`done` or stop kind), minutes, and $ (a client-side estimate)
   - for `done`: the path `prod/worlds/gen-<slug>/`, the entities, routes and workflow in one line, the tasks with their difficulty, and the `verify` line for each task
   - **Assumed and why**: copied from the world's REPORT.md, unedited
   - **Left out**: copied from REPORT.md
   - for a stop: the stop report's reason and its suggested narrower request, unedited
3. **How to try it**: `bun run worldplay serve ../prod/worlds/gen-<slug> --port 4000` and the README demo script.
4. **Honest summary**: pass rate, and any operator action taken (a retry, a Ctrl-C), each with its reason. Do not include the rubric scores unless they ask. Those are for our triage.

Never paraphrase REPORT.md content in a way that makes it stronger than the report itself.

## 8. Rollback if main breaks mid-session

**Trigger:** P5 (`bun run check`) fails on main after the session started, or a commit lands on main during the session that changes `code/`. Nobody should merge into main during the live session, so tell the coordinator (task-description-41) and worldgen-b3 to hold syncs before you start.

1. **Stop between prompts**, never mid-run. Let the current run finish or time out.
2. **Pin to the release tag** in a separate worktree, so main's history is not rewritten:
   ```sh
   git -C ~/worldgen worktree add ~/worldgen-live live-ready
   cd ~/worldgen-live/code && npm ci && bun run check
   ```
3. **Carry the artifacts across:** copy `prod/prompts/` and every `prod/worlds/gen-*` and `eval/runs/<date>-live/` already committed this session into `~/worldgen-live`. Rerun §4 on each world against the pinned engine, because a world must verify under the engine that ships.
4. **Continue** the remaining prompts from `~/worldgen-live/code`, from P6 onwards.
5. **Afterwards:** put the live session's commits on a branch `live/<date>` from `live-ready` and push it. Do not force-push main. Merge `live/<date>` into main only after main is green again, and record the rollback in the §7 report as an operator action.

If the tag itself turns out to be broken (P5 fails at preflight), choose the previous green tag. If there is none, cancel the session rather than run on a red build.

## 9. Rehearsal on stabilize, 2026-10-07

worldgen-fb ran `bun run live` end to end on `stabilize/main` at `6162178f`, from 11:09:42 to 11:24:28 PDT, on two synthetic prompts that appear in no world, suite case or prompt bank. Model `claude-sonnet-5-5` over `claude -p`, $5 and 15 minutes per prompt. The user approved running without `WORLDGEN_MAX_*` because the day's ledger was already past its cap, and the per-prompt budget kept the job inside its $12 limit. The intake is `eval/inputs/rehearsal-stabilize/`, and the run output and results table are `eval/runs/2026-10-07-rehearsal-stabilize/`, with no `world.yaml`. The rehearsal kept clear of `prod/`: worlds went to a scratch `--worlds-dir`, so the results table's artifact path for the delivered world points at that scratch folder, and its `prompts/` link assumes the report sits next to `prod/prompts`.

```sh
cd code
export WORLDGEN_CLAUDE_BIN=$HOME/.local/bin/claude
bun run live ../eval/inputs/rehearsal-stabilize --dry-run          # 2 prompts ready, no model call
bun src/cli/live.ts ../eval/inputs/rehearsal-stabilize --commit 6162178f \
  --report ../eval/runs/2026-10-07-rehearsal-stabilize/LIVE-RUN.md \
  --worlds-dir <scratch>/rehearsal-worlds --out-dir ../eval/runs/2026-10-07-rehearsal-stabilize \
  --budget-usd 5 --max-minutes 15                                  # exit 1: one prompt stopped
bun run live ../eval/inputs/rehearsal-malformed                    # exit 2, nothing run
```

| Prompt | Input | Outcome | Minutes | USD | check, verify, serve |
|---|---|---|--:|--:|---|
| 01-dog-walking | description | done, 1 attempt per step | 9.8 | 2.59 | check passes with 3 paging warnings; verify: 3 tasks, solution 1.000 and noop 0.000, best decoy 0.700, best prefix 0.667; serve: 16 paths, GET /owners 200, `/_world/state` 404 on the world port and 200 on the admin port |
| 02-plant-nursery | csv, 12 rows | stopped, attempts_exhausted at seed after 4 attempts | 4.9 | 1.20 | not run: no world |
| Total | | 1 of 2 delivered | 14.7 | 3.80 | |

The malformed intake (`03 Bakery Orders.TXT`, `04-orchard.docx`) is refused cleanly: exit 2, each file named as "not part of the intake format", no file written, and no model call, since `live.ts` returns before it builds a model.

**Why 02 stopped.** The plan mapped the CSV's statuses (placed, potted, shipped, cancelled) onto its own four states (pending, paid, shipped, cancelled), and padded the 12 imported orders with 18 generated ones so the list spans two pages. The input-fidelity gate requires imported values unchanged, so seeds 1, 3 and 4 failed `plan.not_covered` on `seed.plant_order` (qty 3 found 2, potted found paid), and seed 2 hit the 2 s snippet CPU guard. The conflict is in the plan, but the issue is owned by seed, so the run retried seed instead of backtracking to plan. The plan brief's "just over one list page on the main entity" invites padding an imported table, which A-182 already exempts from paging. That is a follow-up for WorldGen, not for the runbook.
