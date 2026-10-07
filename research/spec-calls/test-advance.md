# Spec calls: test-advance

One bullet per call: call, why, reversible. To be folded into research/decisions.md.

Proposed decisions row:

| A-57 | Clock control in client scripts | World tests get `ctx.advance(duration)`. Task solutions and decoys do not | Job-driven behaviour (SLA breach, timeouts, auto-close) can only be tested by moving time. A task is what an agent does through the public API, and the agent cannot move the clock (A-31). Its time-dependent facts come from seed (A-41). | 2026-10-06 | Yes |

- World tests are their own snippet kind, `test`, with `TestCtx extends ClientCtx` and a `TEST_CTX` registry. Solutions and decoys stay `client`. Why: the format docs, the ctx contract test and the type checker then all say which scripts can move time. A runtime flag on one shared ctx would say it nowhere. Reversible: yes.
- `ctx.advance(by)` calls `Runtime.advance`, which is the same path as `POST /_world/clock`, and returns `{ jobsFired, jobsFailed }`. The duration is validated by `parseDuration` in clock.ts, and a non-string throws. Both are reported as `snippet.runtime_error` at the test's path. Why: there is one clock parser and one advance path. A test asserts on `jobsFailed` itself. Reversible: yes.
- The compile layer refuses a solution or decoy whose source calls `.advance(` with `task.clock_control` (owner tasks). The client ctx has no `advance` either, so a script that gets past the scan fails at run time. Why: the tasks layer does not run solutions yet. The scan gives a model a precise, fixable issue before any run. A client script has no other object with an `advance` method, so a false positive is not realistic. Reversible: yes.
- An action counts as exercised only when its handler actually ran, during a test or during the first run of a task's reference solution. Decoy runs never count. `recordingHost` in tasks.ts wraps the snippet host so that each handler run records its action. The tests layer and `verifyTask` (which returns `exercised`) both use it. A call refused by routing or by input validation (`400 input.invalid`) no longer counts. A `ctx.fail` refusal such as 409 still counts. Why: before this, a junk-body call marked the action covered without running a line of it. This supersedes the engine-tests-layer call "exercised when the router matched, whatever the status". Reversible: yes.
