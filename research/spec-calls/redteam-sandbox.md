# Red-team calls: snippet sandbox and leaks between runs

Status: proposal

These are open questions from `research/redteam-contract.md` about `sandbox.ts` and `ctx.ts`. RT-86 matters most. If ctx objects are host objects, a snippet can follow `ctx.db.get.constructor.constructor` to the host `Function`, which breaks G-21 and makes check results depend on the host.

## Decision rows

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | ctx lives inside the context (RT-86) | Every object and function a snippet can reach is created inside its vm context. ctx methods are wrappers compiled in the context that call a host bridge, which is never exposed. Rows cross the boundary as structured clones. | Otherwise the prototype chain of a ctx object leads to host intrinsics: a snippet can add keys to the host `Object.prototype` or reach the host `Function`. | 2026-10-06 | Yes |
| A-xx | No state carried between runs (RT-35) | Each snippet run gets a fresh context. If that costs too much, the shared context is built once with every intrinsic and prototype deep-frozen, and the global object is sealed. | It makes a leak between runs impossible by construction. `task.nondeterministic` stays as a backstop (A-22). | 2026-10-06 | Yes |
| A-xx | Nothing runs after a snippet returns (RT-110) | Contexts use `microtaskMode: 'afterEvaluate'`. A ctx is revoked when its run ends, so any later call throws and writes nothing. A returned value is serialized inside the context, under the same guard, before the host reads it. Results whose getters, `then`, `valueOf` or `toJSON` loop therefore end in `snippet.timeout_guard` or `snippet.call_quota`. `import()` is disabled with `importModuleDynamically` set to throw. | Host code must never run snippet code without the guard around it. | 2026-10-06 | Yes |
| A-xx | Exact globals (RT-111) | The context's own global names are exactly `SANDBOX_GLOBALS` plus `globalThis`. | A-21 snapshots the allowlist, and the snapshot should match it exactly. | 2026-10-06 | Yes |
| A-xx | No host locale (RT-112) | Inside the context, `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString`, `toLocaleUpperCase`, `toLocaleLowerCase` and `localeCompare` are replaced with locale-free versions (`toString`, `toUpperCase`, `toLowerCase`, and a code-unit compare). | Seeds that sort names with `localeCompare` would otherwise seed different rows on machines with different `LC_ALL` or `TZ`. | 2026-10-06 | Yes |
| A-xx | Stack depth (RT-113) | Won't fix. A stack overflow inside a snippet is `snippet.runtime_error`. The test that expects the same rows at every host stack depth is removed. | The engine cannot fix the host stack depth. Measuring it is an abuse, not a world. | 2026-10-06 | Yes |
| A-xx | Runaway budget (RT-114) | After a run of a task's snippet ends in `snippet.timeout_guard`, verification stops running that task's other scripts and reports the one issue. A runaway snippet adds at most `guardMs` + 1000 ms to a check. | Today a runaway grader could cost `guardMs` for each decoy and each prefix, which is tens of seconds in the repair loop. | 2026-10-06 | Yes |

## Unlocks

| RT | Tests that become firm |
|---|---|
| RT-86 | `G-06 RT-86 snippets cannot plant keys on host intrinsics through ctx objects`, `G-21 seed cannot pollute host prototypes through ctx objects` |
| RT-35 | the seven `G-24 RT-35 … is refused, reported, or has no effect` tests, and `G-24 GR-nondeterministic-proto`. With a fresh context per run, the `GR-nondeterministic-proto` row should give `task.nondeterministic` or nothing at all. Its expected code stays an "accept" list. |
| RT-110 | the eight `RT-110` tests in `redteam-determinism.test.ts` |
| RT-111 | `G-21 RT-111 the global object holds exactly SANDBOX_GLOBALS` |
| RT-112 | `G-18 RT-112 seeds that read the locale give the same dump under different LC_ALL and TZ` |
| RT-113 | `G-18 RT-113 a seed that measures its own stack depth…`. This test is removed (won't fix). |
| RT-114 | the three `G-23 RT-114 while(true) in a grader / handler / solution…` tests |
