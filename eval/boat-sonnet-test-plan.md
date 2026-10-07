# Boat and Sonnet test procedure

[Linear project](https://linear.app/yossi-zozo123/project/worldgen-f83badd4a2c7) · [Linear test issue YOS-108](https://linear.app/yossi-zozo123/issue/YOS-108)

## Goal

Test the agreed KISS path: description -> checked world -> proven tasks -> fresh Sonnet task runs and replies -> graded JSONL dataset. claude-sonnet-5-5 is the only model, through `claude -p` by default or the opt-in SDK (A-66). boat.dev is the only product sandbox provider. The TypeScript repo stays canonical.

## Procedure and gates

1. Pin the commit and use an isolated checkout. Record Node/npm/Bun versions. Never reuse another task's uncommitted state.
2. Install the current lockfile dependencies and run local checks without provider keys:
   - npm ci --ignore-scripts --no-audit --no-fund
   - npm run typecheck
   - node --import tsx --test --test-concurrency=1 test/config.test.ts test/llm.test.ts test/policy.test.ts
   - node --import tsx --test --test-concurrency=1 test/worldgen.test.ts
   - npm run worldplay -- check ../prod/worlds/helpdesk
   - npm run worldplay -- verify ../prod/worlds/helpdesk
   - npm run eval -- --dry-run
   Record command, exit code, timeout and raw log. Local engine checks may run on the host; product generation and solver environments use Boat. Run the complete repository check/e2e gates after the stabilization work, before declaring the product ready.
3. Verify provider configuration before paid work. A logged-in `claude` CLI (or `LLM_KEY` for the opt-in SDK), pinned Sonnet availability, BOAT_API_KEY authentication, SDK request compatibility, finite model and sandbox budgets. Print status and redacted errors only.
4. After YOS-107 and YOS-75 land, create one Boat sandbox with a finite TTL. Upload only the code and world inputs. Keep provider credentials in the trusted controller and keep the verifier/admin port private.
5. Run one description through generation using only Anthropic Sonnet. Initial test budget: at most $5 model spend, 15 minutes, one sandbox, separately capped Boat spend. This test cap replaces larger old stress-run allowances for this first run. Stop if pricing/cap enforcement is unavailable.
6. Run worldplay check and verify on the generated artifact inside Boat. Require at least three tasks at different difficulty levels. Each reference scores 1; no-op scores 0; decoys/near-misses score below 1. Replay the reference and require identical state hashes.
7. Reset the world and clear solver context before each Sonnet episode. Give the solver only the instruction and public API. Save the final reply and ordered tool calls/results; the deterministic engine grades task completion.
8. Export and reopen the JSONL dataset from YOS-91. Validate schema/version, world/task/run IDs, exact model, complete tool pairs, final reply, score, stop reason and usage. Keep unsuccessful episodes separate. Re-exporting must not duplicate rows. No keys, hidden graders/reference solutions, private admin URLs or hidden thinking in public records.
9. Export evidence, then stop the Boat sandbox on success, failure, timeout and cancellation. Verify the stopped state. A cleanup failure leaves the run failed and names the sandbox ID.
10. Update Linear issue YOS-108 with commit, commands, actual results, costs, artifact paths and remaining blockers. Do not mark the full path passed from local-only tests.

## Current run

Started against origin/main 49a251c11767bb3fadfe1ceeaf5402ac8e89aeae on 2026-10-06. At this snapshot, config defaults to Opus/claude-cli, Boat integration is not on main, and the dataset exporter is absent. Local checks are running; live acceptance remains pending.

## Ownership

YOS-105 stabilizes the baseline. YOS-107 owns Sonnet/API wiring. YOS-75 owns Boat lifecycle. YOS-89 owns checked generation. YOS-91 owns episodes and dataset export. YOS-99 owns command/documentation consistency. Existing owners remain on their issues.

## Recorded results

See [baseline evidence](runs/2026-10-06-boat-sonnet-baseline/README.md). The baseline failures are already owned by the master stabilization work. Follow the named issues rather than opening duplicate fixes.

## Generation deadline and billing regression, YOS-87 and YOS-107

From `code/`, with dependencies already installed, run:

```sh
bun test --timeout 120000 --test-name-pattern 'the hard run deadline' test/worldgen.test.ts
node --import tsx --test --test-name-pattern 'the hard run deadline' test/worldgen.test.ts
```

These local tests advance a synthetic clock through the 15-minute limit. They make no provider calls or Boat sandboxes. Require cancellation, a bounded two-second settlement window, inclusion of a priced reply or failure receipt, a confirmed zero only for a call that never started, and explicit unknown billing for an unpriced or non-settling call. A late proposal must not write the world or plan or append generation events. Normal completion must leave no timers.

The event, report, eval and live tests also require cancelled calls to appear in attempted-call counts and unknown cost to remain visible in saved summaries. Run those tests under both Bun and Node. Keep the real Boat generation-to-dataset gate separate; these regressions alone do not qualify it.
