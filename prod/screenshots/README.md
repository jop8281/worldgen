# Studio screenshots

Screenshots of WorldGen Studio, the operator web app that `bun run studio` serves on loopback. The 29 under [demo/](demo/) are the recorded 15-minute demo walkthrough (see [The demo walkthrough](#the-demo-walkthrough)). Six more follow an earlier click path, driven in headless Chrome by `code/scripts/studio-rehearse.ts`. The 27 under [e2e/](e2e/) record the served-world E2E, driven by `code/scripts/studio-e2e.ts` (see [The served-world E2E](#the-served-world-e2e)). Each one is the real app. No model was called and no sandbox was started. The agent in the episode is the free `noop` agent.

## How they were taken

Two captures are from the signed-in studio. The other four are from an earlier pass, which drove a studio on loopback with no sign-in. The sign-in bar sits above each of their viewports, so a fresh capture of those four shows no visible change and they were kept.

| | 01 and 11 | 04, 05, 07 and 10 |
|---|---|---|
| Code | `dispatch/yos193-signed-in-rehearsal` at `2c36e0da` in jop8281/worldgen. That is `stabilize/main` `f68953cb` plus this change to `code/scripts/studio-rehearse.ts`. No Studio or engine file differed. | `stabilize/main` at `b2b980f9`. Only `code/scripts/studio-rehearse.ts` differed, by the change that added these steps and `--viewport`. |
| Captured | 2026-10-08 04:39 UTC | 2026-10-08 00:50 UTC |
| Studio | Signed in as `ada`, an admin, from a scratch users file that the rehearsal writes. | Loopback, no sign-in. |
| Rehearsal | 17 of 17 steps `ok`, 0 page errors, in 3 runs in a row | 14 of 14 steps `ok`, 0 page errors |

Both passes ran Bun 1.4.2 on macOS 26.6 and headless Google Chrome 154.0.8037.98. The viewport was 1400 × 913 CSS pixels at device scale 1, inside a 1400 × 1000 headless window. The signed-in pass pins the light color scheme, so a capture does not follow the machine's appearance.

From `code/`:

```sh
bun scripts/studio-rehearse.ts <out-dir> --viewport
```

The rehearsal starts its own studio on a free loopback port, from a users file with an admin and two operator tenants, and signs in through the page. It writes one PNG per step into `<out-dir>`. These six keep their step names. It serves and stops helpdesk, and it leaves two noop episodes under `eval/episodes/`: one for the admin, and one for the tenant that retries a request. Clear `eval/episodes/` and `prod/worlds/.studio-runs.json` first, so 11 lists one episode. Both are ignored by git.

## The screenshots

| File | What it shows | sha256 |
|---|---|---|
| [01-dashboard.png](01-dashboard.png) | The sign-in bar reads `ada (admin)` with `Sign out`. Below it, the Worlds table lists 25 worlds, 0 served. Each row has kind, task count, wid, model, cost, attempts, and `serve`, `report` and `export`. | `f51762ad64de8ade8ed7dd199b22d69a2e330dc557f858f602033364375c0284` |
| [04-console-get.png](04-console-get.png) | The API console on served helpdesk. `GET /tickets?status=open&limit=3` reaches the world port and answers HTTP 200 with `tkt_0001` first. | `0b9a728acf0fc6bb086b9216cb03debfbe74b435ad1ce30e9c0f9cf8a291baf4` |
| [05-console-illegal-write.png](05-console-illegal-write.png) | A wrong write. `PATCH /tickets/tkt_0001` with `{"status":"new","priority":"low"}` answers HTTP 422 `state.transition`, "ticket tkt_0001 status cannot move from open to new". The engine refuses the whole write, so the legal priority change is not applied either. | `f735e0c0205383c43948c0203a8a28d32e733f1c5d0ba559afd82f5c8f7c4535` |
| [07-report.png](07-report.png) | `REPORT.md` of gen-library-loans, a world WorldGen built from two CSV files, above its Explorer view, with 3 entities and 16 routes and actions. | `1cc59d52df7eed5b34975e42f4d3edd0c6a8dd795d04831084759b813d03d5f2` |
| [10-proof.png](10-proof.png) | The engine proof for helpdesk reads "every task verified". For each of the 3 tasks the reference solution scores 1 and doing nothing scores 0. The near miss and the decoys score below 1, and the replay is identical. | `7d1857b6555ef26c0f81235970e76736576014ddcad7bcd6448c2ae9e3dc5830` |
| [11-noop-episode.png](11-noop-episode.png) | One Agent Playground episode on `assign_newest_acme_ticket`. The noop agent replies "No action taken.", and the engine scores the end state 0 at $0.0000. The seed and end state hashes match (`caf18edc357f`). Its agent model reads `noop (no model)`, and Analytics files it under that model. | `128d64c842de80830b029d4de902c98bdea8e15f5df23fc5e7d715407b103b9c` |

The worlds shown:

- helpdesk is `wid_e833c3b8d51fabafb42aff407ec68e6ce7a060289162ee6bef9e3ead755bb521`, the hand-built world.
- gen-library-loans is `wid_14b93ec57fdb9839d5023a5aa1069ed87f3c187d8afbe2c27e563fb3bd664297` in both 01 and 07. Its `REPORT.md` and `capsule.json` have cited this id since PR #13.

## What to read with care

- In 01, a generated world without a `capsule.json` shows `none` for wid, model, cost and attempts, because the dashboard reads those values from that file. 9 of the 23 generated worlds have none.
- In 10 and 11, the Spend panel shows the spend ledger of the machine that took the screenshots, at that moment. It is not a measured result of this repository.

## The demo walkthrough

This is the recorded run of the 15-minute operator demo, YOS-193, following the click path in [research/studio-demo-runbook.md](../../research/studio-demo-runbook.md).
- **The talk:** steps 01 to 27.
- **Two checks the talk does not click:** 28, one job per Idempotency-Key, and 29, a team that sees no other team's runs.

No model was called and no sandbox was started.

| | |
|---|---|
| Code | Promotion 11: `main` at `50cec32fd365d10a2692975e4d5f6c77743b709d` (#121) in jop8281/worldgen. It has the tree of `stabilize/main` `e7b181f5`, which holds the page's error states (#106) and the past-runs and reset fixes (#110). The run was taken in a clean detached worktree at that SHA, with one file laid over from this change: `code/scripts/studio-rehearse.ts`, which walks the storyline. No Studio, engine or WorldGen file differed. The laid-over file is this change's script as of commit `0d30be55`. The merged file in this PR also has the trunk's 4-line `--help` exit (`31015ab9`, YOS-201), which a run without `--help` never reaches. |
| Captured | 2026-10-08, three runs in a row starting 2026-10-08T09:47:09Z. The recorded run is the third, started at 2026-10-08T09:48:02Z. |
| Runtime | Bun 1.4.2 on macOS 26.6, headless Google Chrome 154.0.8037.98, light color scheme |
| Frames | 1400 CSS pixels wide at device scale 1. Most frames are the viewport, 1400 × 913, scrolled to the step's element. 04, 05, 07, 14 and 22 show their element whole, beyond the viewport, because what the step shows is taller than one screen: the Worlds section, the Explorer, the console result and the plan. |
| Runs | 3 of 3 runs `ok` on all 29 steps, with 0 page errors each. These frames are the third run. |
| Log | [demo/log.txt](demo/log.txt), sha256 `6bcbcef1459b0f5221e6e5f6f77a9f31670f6dd0c277a770ffc6ab6dbc2d546f`. It holds one line per step with its page time, then the episode ids that steps 28 and 29 compare. |

From `code/`:

```sh
bun scripts/studio-rehearse.ts <out-dir> --record --viewport
```

What the rehearsal sets up and cleans up:
- It starts its own studio on a free loopback port, on a scratch copy of `prod/worlds`.
- The users file is a scratch one with four people and random tokens: ada, ana, vic and bob. Each signs in through the page's token field.
- It uses its own Chrome on a port Chrome picks.
- Every exit stops Chrome and the studio, stops every world the studio serves, and deletes the scratch worlds.
- `--record` also writes `walkthrough.html`, one captioned frame per step. It is not kept here, because its frames repeat these PNGs.

| File | Signed in | What it shows | Frame | Page time | sha256 |
|---|---|---|---|--:|---|
| [01-sign-in.png](demo/01-sign-in.png) | ada (admin, ops) | Sign in: the studio asks for a token, then names who is signed in and offers Sign out | viewport | 170 ms | `1981b8534c988d609067bc66ed13caa116c8dc41e801f2d234146aec265fe9f7` |
| [02-dashboard.png](demo/02-dashboard.png) | ada (admin, ops) | Worlds: every world with its kind, tasks, wid, model, cost and attempts, and serve, report, plan, export and iterate | viewport | 174 ms | `67ab4badfefc5a1e69157b3689dfc0d722201948d34ea77b2a351cae16827443` |
| [03-filter.png](demo/03-filter.png) | ada (admin, ops) | Filter: typing gen-stripe keeps the two Stripe worlds and the count reads 2 of all | viewport | 2 ms | `abacd35e011e9bda4464d03314186b7afa1830e79652b48d781b8f2821dbae5f` |
| [04-serve-helpdesk.png](demo/04-serve-helpdesk.png) | ada (admin, ops) | Serve helpdesk: the count reads 1 served, and its row offers stop, world api and console; the world runs on its own port | its element, whole | 1678 ms | `1c40c259bfe43c6a74e7c20f4615f4bab0cba39cf5852abac5c5ced3c25da7e4` |
| [05-explorer.png](demo/05-explorer.png) | ada (admin, ops) | Explorer: entities and references, the ticket workflow with its moves, seed rows by state, routes and actions with try buttons, jobs, and tasks as an agent is told them | its element, whole | 1373 ms | `0429736d551ba149ab6eb40856cb82b242bfe0a26c8876543d878af836a92348` |
| [06-openapi.png](demo/06-openapi.png) | ada (admin, ops) | OpenAPI: the served world answers its own GET /openapi.json, an OpenAPI 3.1.0 document; the frame shows its start | viewport | 154 ms | `3e6b628b81367f5d9f31a75fd284e3cd57f106b247dbae683ae936a6bd42b4b4` |
| [07-console-get.png](demo/07-console-get.png) | ada (admin, ops) | API console: a real GET on the world port, answered 200 with three open tickets | its element, whole | 155 ms | `00993379d11888a1909205ed0e6b864d6337a085afcebc243095dd0906583383` |
| [08-console-422.png](demo/08-console-422.png) | ada (admin, ops) | A wrong write: an illegal status move with a legal priority change is refused whole, 422 state.transition | viewport | 153 ms | `cfc63f87b8755a92edd7979b8449e540cd92be8f6a6c1474e29997d799e51e09` |
| [09-read-after-422.png](demo/09-read-after-422.png) | ada (admin, ops) | The same ticket read back: its priority is still high, so the legal half was not applied either | viewport | 154 ms | `555a2749a72b5aa6ee4c788cf015ae67d3358022f8d1bf6cd5a44d5d532c3d68` |
| [10-reset-refused.png](demo/10-reset-refused.png) | ada (admin, ops) | Reset with the name box empty: refused, and nothing changes | viewport | 155 ms | `65d67dbc4d779f3bc66dabad5b57a37ecf958cc85a92aeb6adeae9fa34db238a` |
| [11-reset.png](demo/11-reset.png) | ada (admin, ops) | Reset with the typed name: the world is back at its seed | viewport | 152 ms | `e21056e8a81a5982a07d002d0877c55307f3e2f764df64618c91027719e52e13` |
| [12-builder-kind.png](demo/12-builder-kind.png) | ada (admin, ops) | World Builder, the page's Generation runs section: kind openapi lists the specs under eval/inputs and offers an upload | viewport | 155 ms | `765f8cafaf5b252ff79e41d34beaf42f40b2f6933002577fc9b203d5fc1ed30b` |
| [13-builder-upload.png](demo/13-builder-upload.png) | ada (admin, ops) | Upload a spec: it is checked, kept for this tenant, picked, and its paths offered for --only; generate is not pressed | viewport | 154 ms | `5832e12d5f97be7e83b24e9f86835d5fce231956081ce5f8643ef0f309c0d474` |
| [14-plan.png](demo/14-plan.png) | ada (admin, ops) | A generated world's plan: its assumptions, open questions, what is out of scope, and plan.md | its element, whole | 155 ms | `2e80d627f7c1f596d6467a5e1abd844619e426e3945df6a18dbe709c0d2e46e7` |
| [15-iterate-form.png](demo/15-iterate-form.png) | ada (admin, ops) | Iterate: a change request for a world runs on a copy; the form is shown and cancelled here, since sending it starts a paid run | viewport | 3 ms | `b460d1bafabe6446dc1baf766399ce31dedb50217743ddc7d8a7ce6888c41b79` |
| [16-iterate-result.png](demo/16-iterate-result.png) | ada (admin, ops) | A finished iterate: gen-stripe-customers' REPORT.md lists what its change request changed. The world's capsule.json names that run, run_20261007T165640Z_1022e845 | viewport | 155 ms | `aa648ee609dfe464e435f369038d418f705eaa9bd3b5ec2160573ab6ee343002` |
| [17-proof.png](demo/17-proof.png) | ada (admin, ops) | Engine proof: per helpdesk task, the reference solution scores 1, doing nothing 0, near misses and decoys below 1, and the replay is identical | viewport | 1377 ms | `483fd1e81b64cdde4ac03e07b426650ffa9a1ab75a285a7e06e16c006c695a6f` |
| [18-noop-episode.png](demo/18-noop-episode.png) | ada (admin, ops) | Agent Playground: a free noop agent on the first helpdesk task, graded by the engine from the end state | viewport | 6086 ms | `8cf88c133b0e60b659894eab6bcdfb6539e8143fc6ffaef77f16d0c38caba749` |
| [19-spend.png](demo/19-spend.png) | ada (admin, ops) | Spend: today and all-time LLM and sandbox cost, by day, and the caps; only an admin sees it | viewport | 1 ms | `cde123bb529b14b170126e610fb62a32be0da2e800db19a75c2c820be2338738` |
| [20-stop-helpdesk.png](demo/20-stop-helpdesk.png) | ada (admin, ops) | ada stops her served helpdesk | viewport | 152 ms | `28e9c4afa8de3ae2e5a6f5e88b94b5e2a21f55e0f521b1e099f8b60284bbc239` |
| [21-operator-sign-in.png](demo/21-operator-sign-in.png) | ana (operator, acme) | ana signs in: the bar reads ana (operator), and the section links have no Spend or Eval, which need an admin | viewport | 2 ms | `4fe0a517a16251068228b5457214d6d04905cd82976888f3884a05f757801525` |
| [22-operator-serve.png](demo/22-operator-serve.png) | ana (operator, acme) | She serves helpdesk for her team: the count reads 1 served, and its row offers stop | its element, whole | 1522 ms | `1c40c259bfe43c6a74e7c20f4615f4bab0cba39cf5852abac5c5ced3c25da7e4` |
| [23-operator-masked.png](demo/23-operator-masked.png) | ana (operator, acme) | Her console GET /customers: each customer's email reads [sensitive], since email is a sensitive field and she is no admin | viewport | 1525 ms | `90b8b3e8639cd0d7254a7fd8e52e075edc812be5d054f16928a1d4eef9938630` |
| [24-operator-stop.png](demo/24-operator-stop.png) | ana (operator, acme) | ana stops her served helpdesk | viewport | 154 ms | `5fc8fe07d83c2683c5cc2e2eafd6b08f2d69d750654d3f941676845272379454` |
| [25-viewer-sign-in.png](demo/25-viewer-sign-in.png) | vic (viewer, acme) | vic signs in: the bar reads vic (viewer), and there is no Spend or Eval | viewport | 2 ms | `b187e5fb0bb8a7f4e3687fdf40ed027d17b15552b12b367499a6d22616176737` |
| [26-viewer-report.png](demo/26-viewer-report.png) | vic (viewer, acme) | He opens helpdesk's report: hidden, because the world has sensitive fields | viewport | 155 ms | `1167549a88bd3b4fab07270263e83a806469e189e2774d8a55ec2cb22f947d1b` |
| [27-viewer-serve.png](demo/27-viewer-serve.png) | vic (viewer, acme) | He presses serve: refused for his role, and the page says "Your role can't see this. Ask an admin for access." | viewport | 153 ms | `799dd9657172dba8345a6c816c98e94b450aae4dae4d9dd7c6b7daae96b348a8` |
| [28-idempotent-retry.png](demo/28-idempotent-retry.png) | ana (operator, acme) | ana (acme) retries one job request: two POSTs with one Idempotency-Key, the second answer replays the first, and after a reload her Episodes list holds one run | viewport | 5661 ms | `fe558e2ad37cf52e75e8826415cb822c62d092de9d8c6bd4c8733d691fe09cff` |
| [29-other-tenant.png](demo/29-other-tenant.png) | bob (operator, globex) | bob (globex) signs in: his Episodes list holds neither ana's acme run nor ada's ops run | viewport | 0 ms | `41ec7a1855451299a96d01b753cfef20671dde7682d7b0ebef1189f24e0eede8` |

What to read with care:

- **The console result in 07.** The page shows a response in a pane that scrolls at 24rem. For this frame the rehearsal shows the pane at full height, so all three tickets are in it. Nothing else on the page is changed.
- **Spend (19).** The Spend panel shows the spend ledger of the machine that took the run, at that moment. It is not a measured result of this repository.
- **The two unsent actions (13, 15).** In 13 the spec is uploaded into the scratch copy, and `generate` is not pressed. In 15 the iterate form is filled, then cancelled. Either button would start a Sonnet run.
- **The finished iterate (16).** It is gen-stripe-customers' committed REPORT.md, from its change-request run `run_20261007T165640Z_1022e845`. It is not a run made during this recording.
- **The masked email (23).** ana's page shows `[sensitive]` for helpdesk's customer emails because she is not an admin. ada's console answers in 07 to 09 are an admin's, so they show every field.
- **The viewer's refusal (27).** These frames were recorded before J113. At the time the page had one role line, "Your role can't see this. Ask an admin for access.", and showed it for a refused serve as well as a refused read. Since J113 a refused action (serve, stop, reset, generate, iterate, upload, an episode) reads "Your role can't do this. Ask an admin for access.", and a refused read keeps the see line. The runbook and the rehearsal now expect the do line for step 27.
- **Two identical frames (04 and 22).** They are the same PNG, byte for byte. Once ada or ana serves helpdesk, the Worlds section reads the same for both, and the section does not name who is signed in. 21, the frame just before 22, shows that page is ana's.
- **Episodes.** The noop episodes of 18 and 28 are written under `eval/episodes/` of the worktree that ran them, which git ignores.

## The served-world E2E

This is the recorded browser run of a served world's controls (YOS-189, YOS-193). It runs on helpdesk and on gen-billing-dunning, a world WorldGen generated. Sign-in and roles are in force (#8). `ana`, an operator of tenant `acme`, does the work. `vic`, a viewer of `acme`, and `bob`, an operator of tenant `globex`, try what their roles must refuse. For each world, the run shows:

1. A legal API call through the console, with the world's real status and body: a read, then a write.
2. An illegal write that mixes a legal half with an illegal one. The engine refuses the whole write with 422, so the legal half is not applied either. The state hash on the world's admin console is the same before and after.
3. A reset without the typed name, which is refused and changes nothing. Then a reset with the name, which brings the world back to its seed hash.
4. vic's reset is refused with 403 `auth.forbidden`. bob's page says the world is not running for him. When his token asks the studio to reset ana's service id, the answer is 404 `service.unknown`. Neither one moves the hash.

| | |
|---|---|
| Code | `dispatch/yos189-e2e` at `e347a7c1` in jop8281/worldgen: `stabilize/main` `abf54b63` merged with this change. Only `code/scripts/studio-e2e.ts` and these records differed from `stabilize/main`. |
| Captured | 2026-10-08 05:42 UTC |
| Runtime | Bun 1.4.2 on macOS 26.6, headless Google Chrome 154.0.8037.98, light color scheme |
| Frames | 1400 CSS pixels wide at device scale 1, each clipped to its section, 260 to 560 pixels high |
| Run | 27 of 27 steps `ok`, 0 page errors, the third of three runs in a row on this head, each 27 of 27. Four earlier runs on `9c5fae48` were also 27 of 27. |
| Log | [e2e/steps.json](e2e/steps.json), sha256 `22fbeb8ea4d5c82b5344fb857f951faffc239a271a86f914903642f5ed2d29fe`. For every step it holds the request the page sent (method, path and body), the studio's status, the world's own status for a console call, and the state hash the admin console showed. |

From `code/`:

```sh
bun scripts/studio-e2e.ts <out-dir>
```

The script starts its own studio on a free loopback port. It uses a scratch copy of the two worlds and a scratch users file with random tokens, and signs each person in through the page. It uses its own Chrome on a port Chrome picks. It refuses to connect unless that Chrome's pid is the only listener on the port. Every exit stops both, and the studio stops every world it serves.

The state hashes, from the world's admin console (`hash` in `GET /_world/state`):

| World | Seed | After the legal write | After the 422 | After the refused reset | After the reset | After the 403 and the 404 |
|---|---|---|---|---|---|---|
| helpdesk | `4a92e68ff2df751541ba0f40f916f28c` | `b8eba3cd80c116ce3180a698a11f66d8` | same | same | `4a92e68ff2df751541ba0f40f916f28c` | same |
| gen-billing-dunning | `518b2f962695137e7b9a2d96f14f22e1` | `160fd7e2202610df54bcf6d54864c8fa` | same | same | `518b2f962695137e7b9a2d96f14f22e1` | same |

06 and 08 are the same PNG, byte for byte, and so are 19 and 21. The admin console showed the same engine time and the same hash before and after the 422.

| File | Who | What it shows | Requests the page sent, with their status | State hash | sha256 |
|---|---|---|---|---|---|
| [01-sign-in.png](e2e/01-sign-in.png) | ana (operator, acme) | ana signs in through the token field; the bar names her and her role | none |  | `99ff6b3714b966a5ade7da8702bd180f95c7eed4017b6f41bb37e6971bd3efc6` |
| [02-helpdesk-serve.png](e2e/02-helpdesk-serve.png) | ana (operator, acme) | ana serves helpdesk; it runs on its own world port, and its admin port stays on loopback | POST /api/worlds/helpdesk/serve → 200 |  | `f744e7416de3f6c2aab29d5fe30b61dab3bb68e8bfb98f8a658d3b833e07cbe9` |
| [03-helpdesk-seed-hash.png](e2e/03-helpdesk-seed-hash.png) | ana (operator, acme) | the world's admin console reads the seed state hash | none | `4a92e68ff2df` | `b88866e5e1ed04f9a32e8feea1b967603e5fa10558fd2c4de36af2360264d9c4` |
| [04-helpdesk-legal-read.png](e2e/04-helpdesk-legal-read.png) | ana (operator, acme) | a legal read through the API console: GET /tickets?status=open&limit=3, the world's real 200 and body | POST /api/services/svc-03ec7dd3/call → 200 (world 200) |  | `4b27ca6c8d1ab808c0b765a9b4f0a857aa65c5dd5b58490c4dc280f53350cb48` |
| [05-helpdesk-legal-write.png](e2e/05-helpdesk-legal-write.png) | ana (operator, acme) | a legal write: PATCH /tickets/tkt_0001 {"priority":"low"}, answered 200 with the changed record | POST /api/services/svc-03ec7dd3/call → 200 (world 200) |  | `487c220ec4c0bf177a23992cf60a904fefcaf46c6352de86a6214feb6bd303be` |
| [06-helpdesk-hash-after-write.png](e2e/06-helpdesk-hash-after-write.png) | ana (operator, acme) | the state hash moved with the legal write | none | `b8eba3cd80c1` | `f4ac052c34662234ef544308e2d05935e9ff7e5b3e65eab524a958ed97cdefc8` |
| [07-helpdesk-illegal-write.png](e2e/07-helpdesk-illegal-write.png) | ana (operator, acme) | an illegal write: PATCH /tickets/tkt_0001 {"status":"new","priority":"urgent"}. Its legal half is not applied either: 422 state.transition | POST /api/services/svc-03ec7dd3/call → 200 (world 422) |  | `2a9fe66658d8bc906ff931769b586cf4f180eda43e1728898ce0dac7bbc00108` |
| [08-helpdesk-hash-unchanged.png](e2e/08-helpdesk-hash-unchanged.png) | ana (operator, acme) | the state hash after the 422 is the hash before it | none | `b8eba3cd80c1` | `f4ac052c34662234ef544308e2d05935e9ff7e5b3e65eab524a958ed97cdefc8` |
| [09-helpdesk-read-after-422.png](e2e/09-helpdesk-read-after-422.png) | ana (operator, acme) | GET /tickets/tkt_0001: the record holds the legal write and nothing of the refused one | POST /api/services/svc-03ec7dd3/call → 200 (world 200) |  | `9da143f93a6b22f7d4dba74e7dda0a27d8cd9b803065a505dd9b6ecbb3cac1e5` |
| [10-helpdesk-reset-refused.png](e2e/10-helpdesk-reset-refused.png) | ana (operator, acme) | reset without the typed name: refused, and nothing changes | POST /api/services/svc-03ec7dd3/reset → 400 `reset.confirm` | `b8eba3cd80c1` | `ba6935cf848be3d796fdc380c8191ccdff91de020219a3a9662056b76807e698` |
| [11-helpdesk-reset.png](e2e/11-helpdesk-reset.png) | ana (operator, acme) | reset with the typed name: the world is back at its seed hash | POST /api/services/svc-03ec7dd3/reset → 200 | `4a92e68ff2df` | `dca44e9bf2fb3232df6a0ebac2a0465df21dbbe4dc207bec4edaaf5a99d83e4a` |
| [12-helpdesk-viewer-refused.png](e2e/12-helpdesk-viewer-refused.png) | vic (viewer, acme) | vic, a viewer in the same tenant, types the name and presses reset: 403 | POST /api/services/svc-03ec7dd3/reset → 403 `auth.forbidden` | `4a92e68ff2df` | `5ec03913669af0ceda6504b68c9157311009cf90c2345b4d46c632d245de4e15` |
| [13-helpdesk-other-tenant.png](e2e/13-helpdesk-other-tenant.png) | bob (operator, globex) | bob, an operator in another tenant: helpdesk is not running for him, and a reset of ana's service id answers 404 | POST /api/services/svc-03ec7dd3/reset → 404 `service.unknown` | `4a92e68ff2df` | `9566469827cc3b9d5c9a6915f5e2ada61c26b0673afea2b9e2e677297b3c688b` |
| [14-helpdesk-stop.png](e2e/14-helpdesk-stop.png) | ana (operator, acme) | ana stops helpdesk | POST /api/services/svc-03ec7dd3/stop → 200 |  | `d86ca64972b8ce04083f63986c631a0230667b12b1818d18f8e53cf5e88a7297` |
| [15-gen-billing-dunning-serve.png](e2e/15-gen-billing-dunning-serve.png) | ana (operator, acme) | ana serves gen-billing-dunning; it runs on its own world port, and its admin port stays on loopback | POST /api/worlds/gen-billing-dunning/serve → 200 |  | `972d8386d1152d860352b8b312533443a601c2f39642fbb36705373fdf4438df` |
| [16-gen-billing-dunning-seed-hash.png](e2e/16-gen-billing-dunning-seed-hash.png) | ana (operator, acme) | the world's admin console reads the seed state hash | none | `518b2f962695` | `c184a22d88aafbac0d6f3e0d9a727fe4f88d4766b28c0ae3721558f5909749e4` |
| [17-gen-billing-dunning-legal-read.png](e2e/17-gen-billing-dunning-legal-read.png) | ana (operator, acme) | a legal read through the API console: GET /customers?limit=2, the world's real 200 and body | POST /api/services/svc-e448c910/call → 200 (world 200) |  | `2410c503b757b0f6307b6227cf6fd69230f2b7d6303c57d53486eaf1b9c0b98a` |
| [18-gen-billing-dunning-legal-write.png](e2e/18-gen-billing-dunning-legal-write.png) | ana (operator, acme) | a legal write: PATCH /customers/cus_0001 {"name":"Renamed in the E2E cus_0001"}, answered 200 with the changed record | POST /api/services/svc-e448c910/call → 200 (world 200) |  | `ff3cc205e50d3699a742d133c4094ef1fb4eb699e3ce55511195688950814484` |
| [19-gen-billing-dunning-hash-after-write.png](e2e/19-gen-billing-dunning-hash-after-write.png) | ana (operator, acme) | the state hash moved with the legal write | none | `160fd7e22026` | `b12480197f7d17a7c3e069c5861916c052a47ee426d2a7d2826e2f3373787f86` |
| [20-gen-billing-dunning-illegal-write.png](e2e/20-gen-billing-dunning-illegal-write.png) | ana (operator, acme) | an illegal write: PATCH /customers/cus_0001 {"name":"Never applied","email":"not-an-email"}. Its legal half is not applied either: 422 field.type | POST /api/services/svc-e448c910/call → 200 (world 422) |  | `6b0bb26a0e4a21021a5202cbc773e2a49805349d40d027ecad0835ded715bada` |
| [21-gen-billing-dunning-hash-unchanged.png](e2e/21-gen-billing-dunning-hash-unchanged.png) | ana (operator, acme) | the state hash after the 422 is the hash before it | none | `160fd7e22026` | `b12480197f7d17a7c3e069c5861916c052a47ee426d2a7d2826e2f3373787f86` |
| [22-gen-billing-dunning-read-after-422.png](e2e/22-gen-billing-dunning-read-after-422.png) | ana (operator, acme) | GET /customers/cus_0001: the record holds the legal write and nothing of the refused one | POST /api/services/svc-e448c910/call → 200 (world 200) |  | `62246dffbe4fd8acad9fc2aff00dde49a809c97df2e7c0fb7597736707c09023` |
| [23-gen-billing-dunning-reset-refused.png](e2e/23-gen-billing-dunning-reset-refused.png) | ana (operator, acme) | reset without the typed name: refused, and nothing changes | POST /api/services/svc-e448c910/reset → 400 `reset.confirm` | `160fd7e22026` | `34ada63ef1e5c06adcb94df3c8b8ba477a251c42143817554db0a767d4c4caf0` |
| [24-gen-billing-dunning-reset.png](e2e/24-gen-billing-dunning-reset.png) | ana (operator, acme) | reset with the typed name: the world is back at its seed hash | POST /api/services/svc-e448c910/reset → 200 | `518b2f962695` | `5366b8ad024b8d712a064905ee81516a54c0abb03ab63bf77b20cdb6112a84df` |
| [25-gen-billing-dunning-viewer-refused.png](e2e/25-gen-billing-dunning-viewer-refused.png) | vic (viewer, acme) | vic, a viewer in the same tenant, types the name and presses reset: 403 | POST /api/services/svc-e448c910/reset → 403 `auth.forbidden` | `518b2f962695` | `ff93397d29ff14d03b4666010a76235e8eb1e280ae736ce7897a495618a9ee47` |
| [26-gen-billing-dunning-other-tenant.png](e2e/26-gen-billing-dunning-other-tenant.png) | bob (operator, globex) | bob, an operator in another tenant: gen-billing-dunning is not running for him, and a reset of ana's service id answers 404 | POST /api/services/svc-e448c910/reset → 404 `service.unknown` | `518b2f962695` | `a011ddae475f6e1f8099a12f9ecf3b7bca0f67f266bf30ab8adefc3b80afc210` |
| [27-gen-billing-dunning-stop.png](e2e/27-gen-billing-dunning-stop.png) | ana (operator, acme) | ana stops gen-billing-dunning | POST /api/services/svc-e448c910/stop → 200 |  | `d1b6c16e9725e24e1c7c79e0ef7f436796ee8f459206e0e16d08ef9553b2cd66` |

What to read with care:

- The state hash is the engine's own hash of the world's state. The studio's reset answers the same value.
- bob's 404 is the studio's answer to a request his page never makes: his page does not show ana's service at all. The run sends that request from his signed-in page, with his token, and logs it. It does not appear on screen.
- Sensitive-field masking is not in this run. It lands in a separate change, J57.
