# Studio screenshots

Screenshots of WorldGen Studio, the operator web app that `bun run studio` serves on loopback. Six follow the demo's click path, driven in headless Chrome by `code/scripts/studio-rehearse.ts`. The 27 under [e2e/](e2e/) record the served-world E2E, driven by `code/scripts/studio-e2e.ts` (see [The served-world E2E](#the-served-world-e2e)). Each one is the real app. No model was called and no sandbox was started. The agent in the episode is the free `noop` agent.

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
