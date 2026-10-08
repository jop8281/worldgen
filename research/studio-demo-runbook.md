# Studio demo runbook

How to show WorldGen Studio in a browser in 15 minutes, on one seeded repository, signed in, with no terminal after setup. This is the YOS-193 click path. The offline terminal demo stays in [demo-runbook.md](demo-runbook.md) and is the fallback for every step here.

`code/scripts/studio-rehearse.ts` drives the same path in headless Chrome and prints one line per step. It starts its own signed-in studio and signs each person in through the page's token field. On promotion 11, `main` `50cec32f`, it ran clean 3 times in a row: 29 of 29 steps `ok` and 0 page errors each time. The recorded run is in [prod/screenshots/demo/](../prod/screenshots/demo/): one numbered PNG per step and the step log. The code SHA and the sha256 of each file are in [prod/screenshots/README.md](../prod/screenshots/README.md). The talk spends nothing: it calls no model. The two places that would spend are shown without being sent: World Builder's `generate` and the iterate form's `iterate`.

## Setup (terminal, before the talk)

1. Check out the release sha, then run `cd code && bun install --frozen-lockfile`.
2. Make the users file once, outside the repository. It holds four people, one token each:
   - `ada`, an admin of tenant `ops`, who walks the talk;
   - `ana`, an operator of `acme`;
   - `vic`, a viewer of `acme`;
   - `bob`, an operator of `globex`, for the optional tenant check.

   The studio keeps only each token's sha256. The tokens stay in mode-600 files, so you never type one into the terminal:

   ```sh
   umask 077 && mkdir -p ~/.worldgen/studio && cd ~/.worldgen/studio
   for who in ada ana vic bob; do openssl rand -hex 24 | tr -d '\n' > $who.token; done
   h() { shasum -a 256 < $1.token | cut -d' ' -f1; }
   printf '{"users":[{"name":"ada","role":"admin","tenant":"ops","token_sha256":"%s"},{"name":"ana","role":"operator","tenant":"acme","token_sha256":"%s"},{"name":"vic","role":"viewer","tenant":"acme","token_sha256":"%s"},{"name":"bob","role":"operator","tenant":"globex","token_sha256":"%s"}]}\n' $(h ada) $(h ana) $(h vic) $(h bob) > users.json
   ```

3. Start the studio from `code/` with `bun run studio --users ~/.worldgen/studio/users.json`. It prints `studio on http://127.0.0.1:8787`.
   - Without `--users`, a loopback studio runs with sign-in off, and the talk would show no sign-in.
   - The container, `scripts/studio-deploy.sh up`, binds 0.0.0.0 and signs in one admin: export `WORLDGEN_STUDIO_TOKEN`, or put it in `STUDIO_ENV_FILE`, an env file outside the repository. `up` refuses to start without it. It has no operator or viewer, so skip steps 20 to 24 there.
4. Check readiness: `curl -s 127.0.0.1:8787/api/health` shows the sha you checked out, `bun 1.4.2`, and the world count (25 today). Health needs no token.
5. Rehearse once: `bun scripts/studio-rehearse.ts`.
   - It starts its own studio on a free loopback port, on a scratch copy of `prod/worlds`, from a scratch users file with its own random tokens, so it never sees yours.
   - Every line should read `ok`, then `page errors total: 0`.
   - It serves and stops helpdesk, so it leaves nothing running. Its upload lands in the scratch copy, which it deletes.
   - It runs two free noop episodes into `eval/episodes/`, which git ignores.
6. Open http://127.0.0.1:8787 in the browser. The page says `not signed in`, shows the `studio token` field, and reads "You are signed out. Sign in again with your studio token." To put a token on the clipboard, run `pbcopy < ~/.worldgen/studio/ada.token`.
7. Your studio serves the real `prod/worlds`, so two steps leave something there:
   - **The upload in step 12** is kept for ada's tenant, in `prod/worlds/ops/.uploads/`, which git ignores. A second talk lists `uploaded: petstore.openapi.yaml` already, and uploading it again picks the same upload. Delete `prod/worlds/ops/` after the talk.
   - **The reset in steps 10 and 11** resets only the served world's state in memory, never its files.

## Click path

The minutes are talk time. The "Measured" column is the page time for the step, the range over the 3 recorded runs on promotion 11 (`50cec32f`). Each step names its rehearsal step, which is also its screenshot under `prod/screenshots/demo/`. The talk runs as `ada` until step 19.

| Min | Step | Click | What the audience sees | Measured |
|---|---|---|---|---|
| 0:00 | 1. Sign in (`01-sign-in`) | Paste ada's token into `studio token`, then press Enter | The page reloads, and the bar reads `ada (admin)` with `Sign out`. The token stays in this tab's sessionStorage, never in a cookie. | 0.2 s |
| 0:45 | 2. Worlds (`02-dashboard`) | None, it loads on sign-in | The Worlds table: 25 worlds, 0 served. Each row shows kind (hand-built or generated), task count, wid, model, cost and attempts. Its actions are `serve`, `report`, `export` and `iterate`, plus `plan` on a generated world. | 0.2 s |
| 1:30 | 3. Filter (`03-filter`) | Type `gen-stripe` into `filter` | Only gen-stripe-charges and gen-stripe-customers stay, and the count reads `2 of 25`. Clear the box. | instant |
| 2:00 | 4. Serve (`04-serve-helpdesk`) | `serve` on the **helpdesk** row | The row turns to `stop`, `world api` and `console`, and the count reads `1 served`. The world runs on its own port with its admin port kept private. | 1.5 to 1.7 s |
| 2:30 | 5. Explorer (`05-explorer`) | World `helpdesk`, then `explore` | The definition's wid and clock, then each section in turn: 7 entities with fields and references; the `ticket.status` workflow with its states and moves; seed rows per entity and by state; routes and actions, each with a `try` button; jobs; and the 3 tasks as an agent is told them. No grader source is shown. | 1.2 to 1.4 s |
| 3:45 | 6. OpenAPI (`06-openapi`) | `OpenAPI` under the console | HTTP 200 from helpdesk: its own `GET /openapi.json`, an OpenAPI 3.1.0 document of the world's routes and actions. | 0.15 s |
| 4:15 | 7. A legal call (`07-console-get`) | Console `GET /tickets?status=open&limit=3`, then `send` | The world's real HTTP 200 with three `tkt_` rows. The console only ever reaches the world port. Note tkt_0001's priority, `high`. | 0.15 s |
| 5:00 | 8. A wrong write (`08-console-422`) | Console `PATCH /tickets/tkt_0001` with body `{"status":"new","priority":"urgent"}`, then `send` | HTTP 422 `state.transition`: an open ticket cannot move to new. | 0.15 s |
| 5:30 | 9. Nothing applied (`09-read-after-422`) | Console `GET /tickets/tkt_0001`, then `send` | The ticket's priority is still `high`. The engine refused the whole write, so the legal half was not applied either. | 0.15 s |
| 6:00 | 10. Reset refused (`10-reset-refused`) | `reset` with the name box empty | Refused: "Type the world name exactly to confirm the reset." Nothing changes. | 0.15 s |
| 6:30 | 11. Reset (`11-reset`) | Type `helpdesk` into the box, then `reset` | "helpdesk reset to its seed at …, state …": the world is back at its seed. | 0.15 s |
| 7:00 | 12. World Builder (`12-builder-kind`, `13-builder-upload`) | The Generation runs section: kind `openapi`. Then `upload a spec` → choose `eval/inputs/petstore.openapi.yaml` → `upload` | "uploaded petstore.openapi.yaml (7737 bytes)". The spec list now picks `uploaded: petstore.openapi.yaml`, and its 6 paths are offered as `--only` checkboxes. **Do not press `generate`**: that runs Sonnet and spends (see Fresh generation below). | 0.15 s each |
| 8:15 | 13. A plan (`14-plan`) | `plan` on the **gen-library-loans** row | The plan WorldGen wrote before building: its 14 assumptions, each with why, its open questions with the defaults taken, what is out of scope and why, and plan.md. | 0.15 s |
| 9:15 | 14. Iterate on a copy (`15-iterate-form`) | `plan` again to close it, then `iterate` on **gen-stripe-customers**; type a change such as "Give each customer a status of active or archived" | The form reads "change for gen-stripe-customers". Sending it would run WorldGen on a copy, gen-stripe-customers-2, and publish the copy only if the run ends done; the source stays as it is. **Press `cancel`**: the run spends. | instant |
| 9:45 | 15. A finished iterate (`16-iterate-result`) | `report` on **gen-stripe-customers** | Its REPORT.md from a change request WorldGen already ran; the world's capsule.json names that run, run_20261007T165640Z_1022e845. `## Changes` lists what moved: the `status` field added, `get_customer` turned from a route into an action, and a test added for a missing customer. | 0.15 s |
| 10:45 | 16. Engine proof (`17-proof`) | Agent Playground: world `helpdesk`, then `engine proof` | "engine proof: every task verified". For each of the 3 tasks, the reference solution scores 1 and doing nothing scores 0. The near miss and the decoys score below 1, and the replay is identical. | 1.2 to 1.4 s |
| 11:30 | 17. A noop episode (`18-noop-episode`) | Agent `noop`, then `run episode` | One episode on `assign_newest_acme_ticket`. The free noop agent replies "No action taken.", and the engine scores the end state 0 at $0.0000. The seed and end state hashes match, because nothing changed. The engine grades the end state, not the reply. | 6.1 s, talk over it |
| 12:15 | 18. Spend (`19-spend`) | `refresh` under Spend | Today's LLM and sandbox spend, by day, and the caps (each says when it is unset). Only an admin's page has Spend and Eval. | instant |
| 12:45 | 19. Clean up (`20-stop-helpdesk`) | `stop` on helpdesk | The served count returns to 0. | 0.15 s |
| 13:00 | 20. An operator (`21-operator-sign-in`, `22-operator-serve`) | `Sign out`, paste ana's token, `Sign in`; then `serve` on **helpdesk** | The bar reads `ana (operator)`. Spend and Eval are not on her page. She serves helpdesk for her team, since a served world belongs to its tenant. | 1.5 to 1.7 s |
| 13:30 | 21. A masked field (`23-operator-masked`) | Explorer `helpdesk`, `explore`, then console `GET /customers?limit=2`, `send` | HTTP 200, and each customer's `email` reads `[sensitive]`. Email is a sensitive field of helpdesk, and ana is no admin. An admin sees the value. | 1.5 to 1.7 s |
| 14:00 | 22. Her clean up (`24-operator-stop`) | `stop` on helpdesk | The served count returns to 0. | 0.15 s |
| 14:15 | 23. A viewer (`25-viewer-sign-in`, `26-viewer-report`) | `Sign out`, paste vic's token, `Sign in`; then `report` on **helpdesk** | The bar reads `vic (viewer)`. The report pane reads "Hidden because this world has sensitive fields. Ask an admin to open it." | 0.15 s |
| 14:40 | 24. A role refusal (`27-viewer-serve`) | `serve` on **helpdesk** | Under the filter: "Your role can't do this. Ask an admin for access." A viewer looks; an operator serves. | 0.15 s |

The rehearsal also checks two things the talk does not click:
- **`28-idempotent-retry`.** Signed in as ana, it posts the same noop episode request twice with one `Idempotency-Key`. Both answers carry the same run id, and the second says `replayed: true`, so the studio started one episode. After a reload, her Episodes list holds that one run. Generation runs share that code path, but a generation calls Sonnet, so the rehearsal retries the free episode instead.
- **`29-other-tenant`.** Signed in as bob of `globex`, his Episodes list reads `0 episode run(s)`. Neither ada's run nor ana's shows, because each tenant sees only its own jobs.

## Fresh generation (optional, labeled live)

Generation runs → kind `description`, a one-line prompt, out slug, budget `3`, max minutes `12`, then `generate`. This calls Sonnet through `claude -p` and spends up to the budget, so do it only with the day's spend approved, and say on screen that it is live. The run table polls its events.jsonl, and `stop` on a running row cancels it. Not rehearsed in this pass: rehearsals made no model calls.

## Fixes this rehearsal found and made (A-278)

- **Eval table.** Every pass rate showed `null`, and the view button never rendered: the rows used keys `pass` and `view` while `grid()` reads the header labels. Pass rates and `view` now show.
- **Past runs.** Every run id showed `null` (key `run` against header `run id`). They show now.
- **Spend caps.** A `day` row of `unknown` appeared (the date field was read as a cap), and unset caps showed `null`. Both fixed.
- **Serve, then an immediate API call.** It could answer 502 `call.unreachable`, because Serve returns when the child spawns, before the world listens. A refused connection is now retried for up to 10 s after Serve; a refused connection never delivered the request, so POST is safe too.

## Known gaps

- **Big generated worlds.** Opening one in the Explorer takes about 6 s. This talk explores only helpdesk.
- **Not rehearsed live.** Generation, iterate and cancellation all call Sonnet, so the talk shows a finished iterate instead, and this pass made no model calls.
