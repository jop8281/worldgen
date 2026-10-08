# Studio screenshots

Six screenshots of WorldGen Studio, the operator web app that `bun run studio` serves on loopback. Each one is the real app, driven in headless Chrome by `code/scripts/studio-rehearse.ts`. No model was called and no sandbox was started. The agent in the episode is the free `noop` agent.

## How they were taken

| | |
|---|---|
| Code | `stabilize/main` at `b2b980f9` in jop8281/worldgen. Only `code/scripts/studio-rehearse.ts` differed, by the change that added these steps and `--viewport`. No Studio or engine file differed. |
| Captured | 2026-10-08 00:50 UTC |
| Runtime | Bun 1.4.2 on macOS 26.6, headless Google Chrome 154.0.8037.98 |
| Viewport | 1400 × 913 CSS pixels at device scale 1, inside a 1400 × 1000 headless window |
| Rehearsal | 14 of 14 steps `ok`, 0 page errors |

From `code/`:

```sh
bun run studio --port 8797
bun scripts/studio-rehearse.ts http://127.0.0.1:8797 <out-dir> --viewport
```

The rehearsal writes one PNG per step into `<out-dir>`. These six keep their step names. The rehearsal serves and stops helpdesk, and it leaves one noop episode under `eval/episodes/`.

## The screenshots

| File | What it shows | sha256 |
|---|---|---|
| [01-dashboard.png](01-dashboard.png) | The Worlds table lists 25 worlds, 0 served. Each row has kind, task count, wid, model, cost, attempts, and `serve`, `report` and `export`. | `584083a1db06a895fdc6788c67a69b89c0513a914e0aa12fb4a1053f2a11fa27` |
| [04-console-get.png](04-console-get.png) | The API console on served helpdesk. `GET /tickets?status=open&limit=3` reaches the world port and answers HTTP 200 with `tkt_0001` first. | `0b9a728acf0fc6bb086b9216cb03debfbe74b435ad1ce30e9c0f9cf8a291baf4` |
| [05-console-illegal-write.png](05-console-illegal-write.png) | A wrong write. `PATCH /tickets/tkt_0001` with `{"status":"new","priority":"low"}` answers HTTP 422 `state.transition`, "ticket tkt_0001 status cannot move from open to new". The engine refuses the whole write, so the legal priority change is not applied either. | `f735e0c0205383c43948c0203a8a28d32e733f1c5d0ba559afd82f5c8f7c4535` |
| [07-report.png](07-report.png) | `REPORT.md` of gen-library-loans, a world WorldGen built from two CSV files, above its Explorer view, with 3 entities and 16 routes and actions. | `1cc59d52df7eed5b34975e42f4d3edd0c6a8dd795d04831084759b813d03d5f2` |
| [10-proof.png](10-proof.png) | The engine proof for helpdesk reads "every task verified". For each of the 3 tasks the reference solution scores 1 and doing nothing scores 0. The near miss and the decoys score below 1, and the replay is identical. | `7d1857b6555ef26c0f81235970e76736576014ddcad7bcd6448c2ae9e3dc5830` |
| [11-noop-episode.png](11-noop-episode.png) | One Agent Playground episode on `assign_newest_acme_ticket`. The noop agent replies "No action taken.", and the engine scores the end state 0 at $0.0000. The seed and end state hashes match (`caf18edc357f`). | `e546fcc24e39623ebfd07f6d2c52fa50ca5ebaeb8759ff20fda9ddc8970e74bf` |

The worlds shown:

- helpdesk is `wid_e833c3b8d51fabafb42aff407ec68e6ce7a060289162ee6bef9e3ead755bb521`, the hand-built world.
- gen-library-loans is `wid_14b93ec57fdb9839d5023a5aa1069ed87f3c187d8afbe2c27e563fb3bd664297` in the Explorer of 07, computed from its `world.yaml` as it is now. Its `REPORT.md` and `capsule.json`, and so the dashboard in 01, give `wid_ef4057042f754ae3c63939a0287a6ecb17602c3e4e2c42beb785defec6ba1f6a`, the id recorded when WorldGen generated it. The world changed after generation.

## What to read with care

- In 01, a generated world without a `capsule.json` shows `none` for wid, model, cost and attempts, because the dashboard reads those values from that file. 13 of the 23 generated worlds have none.
- In 11, the noop episode's `agent model` reads `claude-sonnet-5-5`, and Analytics counts it under that model. The noop agent called no model. This label is a known gap.
- In 10 and 11, the Spend panel shows the spend ledger of the machine that took the screenshots, at that moment. It is not a measured result of this repository.
