# Studio demo runbook

How to show WorldGen Studio in a browser in 15 minutes, on one seeded repository, signed in, with no terminal after setup. This is the YOS-193 click path. The offline terminal demo stays in [demo-runbook.md](demo-runbook.md) and is the fallback for every step here.

`code/scripts/studio-rehearse.ts` drives the same path in headless Chrome and prints one line per step. It starts its own signed-in studio and signs in through the page's token field. It ran clean 3 times in a row on jop8281/worldgen `cc06db5e`: 17 of 17 steps `ok`, 0 page errors each time. That covers the sign-in, the engine proof, the noop episode, a retried request, and a second tenant's view.

## Setup (terminal, before the talk)

1. Check out the release sha, then run `cd code && bun install --frozen-lockfile`.
2. Make the users file once, outside the repository. It holds three people, one token each: `ada`, an admin of tenant `ops`, and two operators, `ana` of `acme` and `bob` of `globex`. The studio keeps only each token's sha256. The tokens stay in mode-600 files, so you never type one into the terminal:

   ```sh
   umask 077 && mkdir -p ~/.worldgen/studio && cd ~/.worldgen/studio
   for who in ada ana bob; do openssl rand -hex 24 | tr -d '\n' > $who.token; done
   h() { shasum -a 256 < $1.token | cut -d' ' -f1; }
   printf '{"users":[{"name":"ada","role":"admin","tenant":"ops","token_sha256":"%s"},{"name":"ana","role":"operator","tenant":"acme","token_sha256":"%s"},{"name":"bob","role":"operator","tenant":"globex","token_sha256":"%s"}]}\n' $(h ada) $(h ana) $(h bob) > users.json
   ```

3. Start the studio from `code/` with `bun run studio --users ~/.worldgen/studio/users.json`. It prints `studio on http://127.0.0.1:8787`. Without `--users`, a loopback studio runs with sign-in off, and the talk would show no sign-in. The container, `scripts/studio-deploy.sh up`, binds 0.0.0.0 and signs in one admin: export `WORLDGEN_STUDIO_TOKEN`, or put it in `STUDIO_ENV_FILE`, an env file outside the repository. `up` refuses to start without it. It has no second tenant, so skip step 13 there.
4. Check readiness: `curl -s 127.0.0.1:8787/api/health` shows the sha you checked out, `bun 1.4.2`, and the world count (25 today). Health needs no token.
5. Rehearse once: `bun scripts/studio-rehearse.ts`. It starts its own studio on a free loopback port, from a scratch users file with its own random tokens, so it never sees yours. Every line should read `ok`, then `page errors total: 0`. It serves and stops helpdesk, so it leaves nothing running. It also runs two free noop episodes into `eval/episodes/`, which git ignores. Its tenants have the same names as yours, so ada sees both episodes during the talk and ana sees hers.
6. Open http://127.0.0.1:8787 in the browser. The page says `not signed in`, shows the `studio token` field, and reads `HTTP 401 auth.required`. To put a token on the clipboard, run `pbcopy < ~/.worldgen/studio/ada.token`.

## Click path

Times are the rehearsal's measured page times. The minutes are talk time. Each step names the `studio-rehearse.ts` step that checks it.

| Min | Step | Click | What the audience sees | Measured |
|---|---|---|---|---|
| 0 to 1 | 0. Sign in (`00-sign-in`) | Paste ada's token into `studio token`, then `Sign in` | The page reloads, and the bar reads `ada (admin)` with `Sign out`. The token stays in this tab's sessionStorage, never in a cookie. | 0.2 s |
| 0 to 1 | 1. Dashboard (`01-dashboard`) | None, it loads on sign-in | Worlds table: 25 worlds, each with kind (hand-built or generated), task count, wid, model, cost and attempts. Generated worlds show the Sonnet run's dollar cost. | 0.2 s |
| 1 to 2 | 2. Serve (`02-serve-helpdesk`) | `serve` on the **helpdesk** row | The row turns to `stop`, `world` and `api console`, and the header says `1 served`. The world runs on its own port with its admin port kept private. | 1.7 to 2.7 s |
| 2 to 4 | 3. Explorer (`03-explorer-helpdesk`) | World `helpdesk`, then `explore` | The definition wid and clock, 7 entities with fields and references, 17 routes and actions, 3 jobs, and 3 tasks with difficulty and tid. No grader source is shown. | 1.4 to 2.3 s |
| 4 to 5 | 4. API call (`04-console-get`) | Console `GET /tickets?status=open&limit=3`, then `send` | The world's real HTTP 200 with three `tkt_` rows. The console only ever reaches the world port. | 0.15 s |
| 5 to 6 | 5. A wrong write (`05-console-illegal-write`) | Console `PATCH /tickets/tkt_0001` with body `{"status":"new","priority":"low"}`, then `send` | HTTP 422 `state.transition`, "ticket tkt_0001 status cannot move from open to new". The legal half (priority) was not applied either. | 0.15 s |
| 6 to 7 | 6. A generated world (`06-explorer-generated`) | World `gen-library-loans`, then `explore` | A world WorldGen built from two CSV files: books, members and loans, with its routes, jobs and tasks. | **5.5 to 6.7 s**, the one visible pause, so talk over it |
| 7 to 9 | 7. Its report (`07-report`) | `report` on the **gen-library-loans** row | REPORT.md: what was built, what was assumed and why, what was left out, plus the run's cost and minutes. | 0.15 s |
| 9 to 10 | 8. Eval (`09-eval`) | Scroll to Eval | 13 eval runs with their pass rates (live-segment 2/3, stress-1b 7/14). `view` opens a summary. | instant |
| 10 to 11 | 9. Engine proof (`10-proof`) | Agent Playground: world `helpdesk`, then `engine proof` | "engine proof: every task verified". For each of the 3 tasks, the reference solution scores 1 and doing nothing scores 0. The near miss and the decoys score below 1, and the replay is identical. | 1.4 to 1.7 s |
| 11 to 12 | 10. A noop episode (`11-noop-episode`) | Agent `noop`, then `run episode` | One episode on `assign_newest_acme_ticket`. The free noop agent replies "No action taken.", and the engine scores the end state 0 at $0.0000. The seed and end state hashes match, because nothing changed. The engine grades the end state, not the reply. The episode records no model, and Analytics files it under `noop (no model)`. | 6.1 s |
| 12 to 13 | 11. Spend (`12-spend`) | `refresh` under Spend | Today's LLM and sandbox spend, by day, and the caps (each says when it is unset). Spend needs the admin role. | instant |
| 13 to 14 | 12. Clean up (`13-stop-helpdesk`, `14-reload`) | `stop` on helpdesk, then reload the page | The served count returns to 0, and the reload shows the same state, still signed in. | 0.3 s |
| 14 to 15 | 13. Another tenant (`16-other-tenant`) | `Sign out`, then paste bob's token and `Sign in` | The bar reads `bob (operator)`. His Episodes list reads `0 episode run(s)`: ada's run and the rehearsal's acme run are absent, because each tenant sees only its own jobs. The worlds stay shared, and Spend is gone from his page: it needs the admin role. | instant |

The rehearsal also checks one thing the talk does not click, as step `15-idempotent-retry`. Signed in as ana, it posts the same noop episode request twice with one `Idempotency-Key`. Both answers carry the same run id, and the second says `replayed: true`, so the studio started one episode. Generation runs share that code path, but a generation calls Sonnet, so the rehearsal retries the free episode instead. Measured 5.9 to 6.8 s, most of it the episode itself.

## Fresh generation (optional, labeled live)

Generation runs → kind `description`, a one-line prompt, out slug, budget `3`, max minutes `12`, then `generate`. This calls Sonnet through `claude -p` and spends up to the budget, so do it only with the day's spend approved, and say on screen that it is live. The run table polls its events.jsonl, and `stop` on a running row cancels it. Not rehearsed in this pass: rehearsals made no model calls.

## Fixes this rehearsal found and made (A-278)

- **Eval table.** Every pass rate showed `null`, and the view button never rendered: the rows used keys `pass` and `view` while `grid()` reads the header labels. Pass rates and `view` now show.
- **Past runs.** Every run id showed `null` (key `run` against header `run id`). They show now.
- **Spend caps.** A `day` row of `unknown` appeared (the date field was read as a cap), and unset caps showed `null`. Both fixed.
- **Serve, then an immediate API call.** It could answer 502 `call.unreachable`, because Serve returns when the child spawns, before the world listens. A refused connection is now retried for up to 10 s after Serve; a refused connection never delivered the request, so POST is safe too.

## Known gaps

- Opening a big generated world in the Explorer takes about 6 s.
- Generation and cancellation were not rehearsed live: no model calls in this pass.
