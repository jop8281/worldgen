# Red-team calls: clock and jobs

Status: proposal

These are open questions from `research/redteam-contract.md` about engine time. Each one blocks firm tests in `code/test/redteam-clock.test.ts` or `redteam-cli.test.ts`.

## Decision rows

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Job time (RT-24) | Job transactions add no tick. Inside a job, `ctx.now()` is the job's scheduled time. After `advance(d)`, `now` is exactly the previous `now` plus `d`. | With this rule, `advance('30m')` twice equals `advance('1h')` once, at every split. Job rows also carry their scheduled times, which the tests can derive by hand. | 2026-10-06 | Yes |
| A-xx | Zero advance (RT-22) | `advance('0s')` is accepted and is a no-op: no job fires and `now` does not change. | The interval `(from, to]` is empty, so nothing is due. | 2026-10-06 | Yes |
| A-xx | Failing jobs (RT-27) | A job that throws or fails rolls back only its own transaction. Later due jobs still fire. `advance` returns normally with `jobsFailed: [{ job, at, code, message }]`, and the failure goes in the log. | A-17 gives each job its own transaction. If `advance` threw, the agent's clock call would fail halfway, after some jobs had already committed. | 2026-10-06 | Yes |
| A-xx | Bad durations (RT-20, RT-90) | `Runtime.advance` throws `Error('bad duration: <value>')` before it changes anything. The admin clock answers 400 in `meta.api.error`. | A precise refusal, with no partial change. | 2026-10-06 | Yes |
| A-xx | `ctx.time` on bad input (RT-115) | `ctx.time.plus` and `ctx.time.minutesBetween` throw a catchable `Error` on input that is not an ISO time or a `Duration`. An uncaught one becomes `snippet.runtime_error` at the snippet's path. | Otherwise `Invalid Date` or `NaN` would flow quietly into rows. | 2026-10-06 | Yes |
| A-xx | Job epoch (RT-23) | Job times are `meta.clock.start + k × every`. | It matches the `jobSchema` describe text, and does not depend on the epoch. | 2026-10-06 | Yes |

## Unlocks

| RT | Tests that become firm |
|---|---|
| RT-24 | `G-26 now after advance(2h)… no extra ticks for jobs`, `G-27 a job sees its scheduled time in ctx.now()`, `G-28 after a_late fires, 1799s fires nothing…`, `G-28 fuzz: splitting an advance at arbitrary seconds…` |
| RT-22 | `G-26 advance(0s) fires nothing…`, `G-26 the admin clock with 0s changes nothing` |
| RT-27 | `G-29 jobs after a throwing job at the same time still fire` |
| RT-20 | `G-26 the admin clock answers exactly 400 for bad durations` |
| RT-90 | `G-26 negative, malformed and non-string durations leave now, rows and jobs unchanged`. Throwing before any change satisfies it. |
| RT-115 | `G-21 RT-115 control: a ctx call throws a catchable error…` |
