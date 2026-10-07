# Studio demo runbook

How to show WorldGen Studio in a browser in 15 minutes, on one seeded repository, with no terminal after setup. This is the YOS-193 click path. The offline terminal demo stays in [demo-runbook.md](demo-runbook.md) and is the fallback for every step here.

`code/scripts/studio-rehearse.ts` drives the same path in headless Chrome and prints one line per step. It ran clean 3 times in a row on stabilize 0b00d191 plus this change, with 0 page errors.

## Setup (terminal, before the talk)

1. Check out the release sha, then run `cd code && bun install --frozen-lockfile`.
2. Start the studio with `bun run studio`. It prints `studio on http://127.0.0.1:8787`. Or use the container: `docker build -f Dockerfile.studio --build-arg WORLDGEN_BUILD_SHA=$(git rev-parse HEAD) -t worldgen-studio .`, then `docker run -d -p 127.0.0.1:8787:8787 worldgen-studio`.
3. Check readiness: `curl -s 127.0.0.1:8787/api/health` shows the sha you checked out, `bun 1.4.2`, and the world count (25 today).
4. Rehearse once: `bun scripts/studio-rehearse.ts`. Every line should read `ok`, then `page errors total: 0`. It serves and stops helpdesk, so it leaves nothing running.
5. Open http://127.0.0.1:8787 in the browser. The studio has no login yet, so keep it on loopback (YOS-187 adds sign-in).

## Click path

Times are the rehearsal's measured page times. The minutes are talk time.

| Min | Step | Click | What the audience sees | Measured |
|---|---|---|---|---|
| 0 to 1 | 1. Dashboard | Load the page | Worlds table: 25 worlds, each with kind (hand-built or generated), task count, wid, model, cost and attempts. Generated worlds show the Sonnet run's dollar cost. | 0.2 s |
| 1 to 3 | 2. Serve | `serve` on the **helpdesk** row | The row turns to `stop`, `world` and `api console`, and the header says `1 served`. The world runs on its own port with its admin port kept private. | 0.15 s |
| 3 to 5 | 3. Explorer | World `helpdesk`, then `explore` | The definition wid and clock, 7 entities with fields and references, 17 routes and actions, 3 jobs, and 3 tasks with difficulty and tid. No grader source is shown. | 1.8 s |
| 5 to 7 | 4. API call | Console `GET /tickets?status=open&limit=3`, then `send` | The world's real HTTP 200 with three `tkt_` rows. The console only ever reaches the world port. | 0.15 s |
| 7 to 8 | 5. A wrong write | Console `PATCH /tickets/tkt_0001` with body `{"status":"new","priority":"low"}`, then `send` | HTTP 422 `state.transition`, "ticket tkt_0001 status cannot move from open to new". The legal half (priority) was not applied either. | 0.15 s |
| 8 to 10 | 6. A generated world | World `gen-library-loans`, then `explore` | A world WorldGen built from two CSV files: books, members and loans, with its routes, jobs and tasks. | instant |
| 10 to 12 | 7. Its report | `report` on the **gen-library-loans** row | REPORT.md: what was built, what was assumed and why, what was left out, plus the run's cost and minutes. | **8.5 s**, the one visible pause, so talk over it |
| 12 to 13 | 8. Eval | Scroll to Eval | Seven rehearsal runs with their pass rates (live-segment 2/3, stress-1b 7/14). `view` opens a summary. | instant |
| 13 to 14 | 9. Spend | `refresh` under Spend | Today's LLM and sandbox spend, by day, and the caps (each says when it is unset). | instant |
| 14 to 15 | 10. Clean up | `stop` on helpdesk, then reload the page | The served count returns to 0, and the reload shows the same state. | 0.2 s |

## Fresh generation (optional, labeled live)

Generation runs → kind `description`, a one-line prompt, out slug, budget `3`, max minutes `12`, then `generate`. This calls Sonnet through `claude -p` and spends up to the budget, so do it only with the day's spend approved, and say on screen that it is live. The run table polls its events.jsonl, and `stop` on a running row cancels it. Not rehearsed in this pass: rehearsals made no model calls.

## Fixes this rehearsal found and made (A-278)

- **Eval table.** Every pass rate showed `null`, and the view button never rendered: the rows used keys `pass` and `view` while `grid()` reads the header labels. Pass rates and `view` now show.
- **Past runs.** Every run id showed `null` (key `run` against header `run id`). They show now.
- **Spend caps.** A `day` row of `unknown` appeared (the date field was read as a cap), and unset caps showed `null`. Both fixed.
- **Serve, then an immediate API call.** It could answer 502 `call.unreachable`, because Serve returns when the child spawns, before the world listens. A refused connection is now retried for up to 10 s after Serve; a refused connection never delivered the request, so POST is safe too.

## Known gaps

- No sign-in (YOS-187). The studio must stay on loopback until then.
- Opening a big world's report takes about 8.5 s.
- Generation, cancellation and export were not rehearsed live: no model calls in this pass.
