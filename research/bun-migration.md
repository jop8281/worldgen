# Bun migration: spike results

The user asked on 2026-10-06 for the stack to run on Bun end to end: the package manager, the script runner, the test runner and the runtime. This note records a spike against `factory/integration` at `bcedcfe` (819 tests), run with Bun 1.4.2 fetched through npm into a scratch directory. Nothing in the repo was changed for the spike.

## Measurements

Both runs used the same machine, which was under factory load, with the same commit.

| Step | npm and Node 22 | Bun 1.4.2 |
|---|---|---|
| Install (`npm ci` / `bun install`, 16 packages) | 1.33 s | 0.09 s |
| Typecheck (`tsc`, both configs) | passes | passes (`bun run typecheck`) |
| Tests (`npm test` / `bun test`) | 73.8 s, 0 fail | 4.9 s, 9 fail |

`bun test` runs the existing `node:test` files with no changes: 755 pass, 9 fail, 4 skipped, 51 todo. It also writes `bun.lock`.

## The 9 failures

Eight are in the snippet sandbox (`test/sandbox.test.ts`, the `run faults` and `compile` blocks), where Bun's JavaScriptCore differs from V8:

| Test | What happens on Bun |
|---|---|
| reports a plain throw as `snippet.runtime_error` | Passes the code check but pins V8's message text. JavaScriptCore says `null is not an object (evaluating 'null.x')`, while V8 says `Cannot read properties of null (reading 'x')` |
| stops `while(true){}` with `snippet.timeout_guard` | Classified as `snippet.runtime_error`. A bare `vm.runInNewContext` timeout on Bun does throw `ERR_SCRIPT_EXECUTION_TIMEOUT`, so the difference is in how `sandbox.ts` runs the guarded call in a reused context |
| stops a runaway source at compile time | Same timeout classification |
| turns a returned Promise into `snippet.promise_returned` | Promise detection differs |
| faults a snippet that starts async work without returning it | Async tracking differs |
| rejects at compile time a source that starts async work before its function | Async tracking differs |
| does not run a `Symbol.hasInstance` the snippet puts on Promise | Realm and intrinsics handling differs |
| keeps the host alive when a snippet breaks the Promise it rejects | Unhandled-rejection handling differs |

One is in the check layer: `check: references layer > allows the same path with a different method` returns `ok: false` on Bun. The root cause hasn't been found yet. It probably comes from the compile layer, which runs through the sandbox.

## Snippet memory bound (YOS-59)

YOS-59 bounds snippet heap with `new Worker(..., { resourceLimits })`. Bun ignores `resourceLimits`. A probe that allocates without limit in a worker with `maxOldGenerationSizeMb: 32` is stopped by Node with `ERR_WORKER_OUT_OF_MEMORY`, but is still running on Bun after 4 s. Under Bun the bound needs another mechanism, such as a child process with an OS memory limit or an allocation budget enforced in the ctx.

## Proposed units

1. **bun-tooling.**
   - Replace `package-lock.json` with `bun.lock`.
   - Scripts: `test` becomes `bun test`, `worldplay`, `worldgen` and `eval` become `bun src/cli/<name>.ts`, `typecheck` stays `tsc` through `bunx`.
   - Set `engines` to Bun.
   - Update the CI workflow to `oven-sh/setup-bun`.
   - Update the AGENTS.md and README commands and the factory standing order that clones `node_modules`.
   - Acceptance: `bun install && bun run check` is green in CI.
2. **bun-sandbox-compat.**
   - Make the 9 failing tests pass on Bun without weakening what they guard. Assert issue codes and the presence of the failing expression, not V8 message text.
   - Fix timeout classification for guarded calls and async and Promise detection under JavaScriptCore.
   - Root-cause the references-layer failure.
   - Determinism stays per runtime: the replay check (`task.nondeterministic`) still runs under one runtime.
3. **YOS-59 re-plan.** Choose a Bun-compatible memory bound and record the choice as a decision row.

Until unit 2 lands, `npm test` on Node stays the gate. CI can run Bun as a second, non-blocking job so the remaining failures stay visible.
