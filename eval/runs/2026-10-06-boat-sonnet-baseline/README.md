# Baseline test results

[Linear YOS-108](https://linear.app/yossi-zozo123/issue/YOS-108) · [Linear project](https://linear.app/yossi-zozo123/project/worldgen-f83badd4a2c7)

## Baseline evidence, 2026-10-06

Commit: 49a251c11767bb3fadfe1ceeaf5402ac8e89aeae, a clean isolated checkout of origin/main with its own npm ci. Node v22.23.3, npm 10.9.9. Bun 1.4.2 is installed but was not used for these checks.

| Check | Result |
| --- | --- |
| npm run typecheck | FAIL, 3 TypeScript diagnostics in test/redteam-check.test.ts. The issue-layer catalog lacks field.values_duplicate, snippet.memory and task.clock_control. |
| config.test.ts + llm.test.ts + policy.test.ts | PASS, 148 tests, 0 failures. These are fake-client/local tests of the existing code, not proof of the new provider contract. |
| worldgen.test.ts | FAIL, 21 pass and 1 failure. The dump/event test expects warnings 0 but receives 2. |
| Helpdesk check | PASS with 4 seed paging warnings. |
| Helpdesk verify | PASS, 3 tasks: all references 1, no-ops 0, decoys below 1; hard-task prefix 0.857. |
| Eval dry run | PASS, 13 of 13 cases parsed, no model call. |
| Anthropic read-only model preflight | HTTP 200; claude-sonnet-5-5 is available. |
| Boat read-only sandbox-list preflight | HTTP 200. No VM was created or changed. |

No generation calls were made and no sandbox was provisioned. The full check/e2e suite was not run in this pass because the baseline typecheck already fails and the master owns stabilization. The local failures are linked to YOS-105 and existing stabilization PRs #73 and #75; do not create competing fixes from this evidence.

Live generation, Boat execution/cleanup and JSONL dataset validation remain NOT RUN. Blockers: YOS-107, YOS-75 and YOS-91, plus baseline stabilization. The existing config also explicitly rejects ANTHROPIC_* variable names, so the new environment convention requires a code change rather than an exported key alone.

Raw command logs are stored beside this file. `results.json` records exits/timeouts/durations; provider preflight JSON contains status only. Repository paths replace private absolute checkout paths in the logs. The test runner removed Anthropic/Boat credentials from the local test processes. Dependencies were installed in this checkout, not shared by symlink.
