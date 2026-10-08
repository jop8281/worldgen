# Boat, Sonnet and dataset delivery plan

Agreed on 2026-10-06. [Linear project](https://linear.app/yossi-zozo123/project/worldgen-f83badd4a2c7) · [Test procedure](../eval/boat-sonnet-test-plan.md).

## Current contract

The existing TypeScript implementation is canonical. This amendment supersedes older provider and model choices in the design PDF, A-37 and local-sandbox notes. The model path follows A-66, which extends A-56 and U-11. It does not replace the world's format, engine invariants or unrelated accepted implementation work.

| Responsibility | Required choice |
| --- | --- |
| Generation, repair, solving and final replies | Pinned `claude-sonnet-5-5`, through `claude -p` by default or the opt-in SDK (A-66) |
| Product sandbox execution | Boat only, through `@boatdev/sdk` |
| Checking, task proofs, grades and replay | Deterministic engine, no model judge |
| Credentials | The logged-in Claude Code session. `LLM_KEY` for the opt-in SDK, and `BOAT_API_KEY`. Trusted controller only. Never `ANTHROPIC_*` or `.env` |
| Dataset | Versioned JSONL, with successful and unsuccessful episodes separated |
| Initial execution | One sequential run and one sandbox with bounded time and spend |

Local engine and fake-client tests can run on the host. A local pass does not demonstrate Boat execution. No automatic fallback to Opus, Haiku, another LLM provider, OpenShell or sbx.

## Pipeline

1. The controller authenticates both providers, checks pinned model availability and applies explicit model and sandbox budgets.
2. It creates a Boat sandbox, stages only required code and inputs, and keeps credentials out of uploaded files.
3. Sonnet proposes a plan, data/API model, workflows, seed data and tasks. Each stage passes the engine gate before advancing; repairs are bounded.
4. The engine proves task quality. Reference solutions score 1, no-op scores 0, near-misses score below 1, and replay reaches the same state.
5. Each solver episode starts from the frozen task setup and a fresh Sonnet conversation. It receives only the visible instruction and public API. Graders, reference solutions and admin endpoints remain private.
6. The runner captures public messages, ordered tool calls/results and the final reply. The engine grades task completion.
7. Export and reopen the dataset, preserve evidence, then stop the Boat sandbox and verify its state on every exit.

A passing state score does not independently validate every factual claim in a final reply. Preserve that distinction in dataset metadata and reports. Do not export hidden thinking.

## Dataset contract

YOS-91 owns one schema with: schema version; episode/run/world/task IDs; world and engine versions; difficulty; provider and exact model; prompt/config version; initial and final state hashes; public messages and paired tool calls/results; final reply; score; stop reason; usage and cost.

Export `dataset.jsonl`, `failures.jsonl`, and a manifest containing artifact references, counts and checksums. Successful rows require a completed episode, engine score 1 and a complete record. Re-exporting saved runs must not duplicate rows. Keep hidden evaluation assets outside public episode records.

## Delivery sequence and owners

| Gate | Linear owner issue | Completion evidence |
| --- | --- | --- |
| Stable baseline | [YOS-105](https://linear.app/yossi-zozo123/issue/YOS-105) | Full checks at the commit promoted to main |
| Sonnet SDK enforcement | [YOS-107](https://linear.app/yossi-zozo123/issue/YOS-107) | Defaults/override tests plus bounded live request |
| Boat lifecycle | [YOS-75](https://linear.app/yossi-zozo123/issue/YOS-75) | Upload, private verifier, execution, artifact collection and verified cleanup |
| Checked generation | [YOS-89](https://linear.app/yossi-zozo123/issue/YOS-89) | Actual generated world passes check and verify |
| Episode and dataset export | [YOS-91](https://linear.app/yossi-zozo123/issue/YOS-91) | Reopened JSONL passes validation; failure path and repeated export tested |
| End-to-end test evidence | [YOS-108](https://linear.app/yossi-zozo123/issue/YOS-108) | All live gates and cleanup recorded |
| Release documentation | [YOS-99](https://linear.app/yossi-zozo123/issue/YOS-99) | Commands match the tested release commit |

The existing master coordinates runtime owners and landings. This documentation/test pass does not implement the runtime migration or supersede active stabilization work.

First milestone: one description, a checked world, three proven tasks, graded Sonnet episodes and a validated JSONL export. OpenAPI, CSV, update mode, fidelity work and rehearsal remain required follow-on release work. Advanced trace formats, multi-provider routing and parallel execution are deferred.

## Baseline implementation gaps

At `49a251c11767bb3fadfe1ceeaf5402ac8e89aeae`, the config defaulted to Opus. Since A-66 (#115) it pins Sonnet, keeps claude-cli as the default, and rejects `ANTHROPIC_*` key variable names by design. The Boat backend and dataset exporter are absent from main. These are open implementation tasks, not completed features. See the [baseline evidence](../eval/runs/2026-10-06-boat-sonnet-baseline/README.md).

## Episode writer claims and recovery

`appendEpisode` holds `logs/<run_id>.episodes.jsonl.lock` while it reads, checks, appends and flushes that run's log. The claim is created whole by link(2), so it always names the writer's PID and host, plus a random token. A writer removes the claim only if its device, inode and text are still its own. Linux gives a file re-created right after an unlink the same inode, so the token is what tells two claims apart (A-297). The log directory is resolved to its real path, so relative paths and directory symlinks share one claim. Log-file symlinks, including dangling links, are refused with `O_NOFOLLOW`; reading and appending use the same opened file descriptor. Each run needs its own log file, so a log with more than one hard link is refused too. A competing writer is refused immediately; there is no waiting, retry loop or automatic removal of an old claim. Different run logs remain independent.

The writer checks the whole log before it appends. A record of another run, or one episode ID saved with two contents, is refused. That also catches run IDs that differ only in case on a case-insensitive disk. A failed append is cut back to the log's previous length before the claim is released, so a retry adds the episode once. A `duplicate` result flushes the log too. A new log's directory entry is flushed with its directory, and so is every directory created on the way. On macOS, Node's libuv flushes with `F_FULLFSYNC`, which empties the drive's cache. Bun's `FileHandle.sync()` is a plain `fsync(2)` there, so the store calls `fcntl(F_FULLFSYNC)` itself through `bun:ffi`, and falls back to `fsync(2)` where that fails.

Normal completion, duplicate records and exceptions release the claim. A writer removes only the claim it created. If its claim was removed or replaced while it was held, it leaves the file and reports that the log needs validating. Abrupt process death leaves the claim in place. The claim records the writer's PID for diagnosis, but a PID or the claim's age is not permission to remove it.

To release the claim of a crashed run, run `bun run dataset release-claim --out <dir> --run-id <id>` from `code/`. It refuses while the claim's process is alive, when another host took the claim or the claim names no process, and when the log does not validate. It removes the claim only if it is still the file it inspected, and it never changes the log. When it refuses, recover by hand:

1. Stop every writer that can reach the canonical log, including writers using directory aliases, and confirm they have terminated. Do not remove the claim while another writer can append.
2. Preserve a byte-for-byte copy of the original episode log in the same private recovery area. Do not truncate it or discard an incomplete last line.
3. Validate the preserved log with `readEpisodeLog` and the run's redactor, then confirm each episode ID occurs exactly once. `readEpisodeLog` validates individual records; it does not detect repeated IDs. An incomplete, malformed or repeated record needs investigation before recovery; keep the original and its copy.
4. Once all writers are stopped and the intact log is validated, remove only that log's `.lock` claim. Keep the log and recovery copy.
5. Retry the interrupted episode through `appendEpisode`. An identical record already on disk is a duplicate; different content under the same episode ID is still refused.

## Runs that share one output directory

An episode id is `<run_id>__<task_id>__<n>`. Run ids and task ids cannot contain `__`, and a run id cannot end with `_`, so an episode id names one run and one task. The run's options and the world's task names are checked before a sandbox starts.

Runs with different run IDs can share one `--out` at the same time.

- A run claims its run ID by creating its empty log exclusively, after the world is checked and frozen and before the sandbox starts. A second run with the same ID is refused with `run id <id> is already used`. A run that stopped early keeps its ID, so retry under a new one.
- The frozen world is content-addressed. Each run stages its own copy under `private/worlds/.freeze-*` and renames it into place, so runs can freeze one world at once.
- Exports of one `--out` take turns on `.export.lock`, held from reading the logs to reopening the published files. A later export waits up to five minutes for it. An export only rewrites `dataset.jsonl`, `failures.jsonl` and `manifest.json` from the logs, so a `.export.lock` left by a killed export can be removed once no export is running.
- Episode artifacts are keyed by episode ID, and diagnostics by run ID. `REPORT.md` at the root describes the run that finished last.

## Issue tracking

[The WorldGen Linear project](https://linear.app/yossi-zozo123/project/worldgen-f83badd4a2c7) is the sole backlog. Keep issues, owners, dependencies, status, acceptance criteria and test results there. GitHub holds source code and pull requests only. Do not create a GitHub issue tracker or mirrored status inventory.

The full historical GitHub issue bodies and comments were preserved in a Linear project document before their GitHub tracking copies were closed. Existing Linear completion states were preserved; moving an issue does not complete the underlying implementation.

## Open pull requests at the alignment snapshot

This list records existing work, not approval to merge it. The PR numbers are from the earlier repository, jop8281/zozo123-genworld (old repo), which no longer exists. The master owns the stabilization order. Older live-run PRs using Claude CLI are historical evidence; new acceptance runs must use the current Sonnet SDK/Boat contract. PRs targeting e2e/integration need the master to resolve their landing path under YOS-92/YOS-98.

| PR | Base | Scope |
| --- | --- | --- |
| #80 | stabilize/main | Correct earliest layer for snippet.memory in the red-team catalog |
| #79 | main | Use Bun for WorldGen tooling, CI, and sandbox commands (YOS-106) |
| #76 | stabilize/main | engine-lints: stabilize #52 and add the gap lints (YOS-94) |
| #74 | stabilize/main | stab/runtime: runtime, graders and http suites |
| #70 | main | YOS-69: path params scope operations, ref inputs, tick job failures |
| #66 | main | bun-e2e: Bun 1.4.2 end to end, Node kept as a second gate (YOS-88) |
| #60 | e2e/integration | [WIP] wg-repair-full: backtracking, every stop reason, REPORT.md on every exit (YOS-44) |
| #57 | e2e/integration | [WIP] trace-grading: graders see the call trace; goals, guards and history guards (YOS-82) |
| #55 | e2e/integration | [WIP] live-gen-clinic: live WorldGen run on a clinic appointments prompt (YOS-36, YOS-55) |
| #54 | e2e/integration | [WIP] live-gen-library: live WorldGen run on a public library prompt (YOS-36, YOS-55) |
| #51 | e2e/integration | [WIP] engine-evidence: dump hash and world, per-call writes in the log, YAML lines on check issues (YOS-78, YOS-77) |
| #50 | main | [WIP] engine-clock-explicit: explicit time by default, per-action durations, determinism test (YOS-81) |
| #48 | e2e/integration | [WIP] cost-ledger-fixes: caps on by default, early account checks, per-call boat size, costs script (YOS-87) |
| #46 | main | [WIP] boat-sdk: boat.dev via @boatdev/sdk, boat CLI, architecture rule (YOS-75) |
| #39 | main | engine-followups: shared errorBody, reserved paths, reference and decoy 5xx codes |

## Sources

[Anthropic models](https://platform.claude.com/docs/en/models/overview) and [Boat SDK documentation](https://docs.boat.dev/sdks/overview). The user supplied the WorldGen Design Doc PDF as design context; the provider and dataset requirements here are the later explicit user direction.
