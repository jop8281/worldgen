# Evidence

Each public claim in [README.md](../../README.md), with the files behind it and the command that re-checks it from a clone. Commands run from `code/` after `bun install --frozen-lockfile` on Bun 1.4.2. None calls a model or needs a key (A-392).

## Re-check from the repository

| Claim | Evidence | Command, from `code/` | You should see |
|---|---|---|---|
| 25 worlds and 95 tasks. Each world checks, and per task the reference solution scores 1, doing nothing scores 0 and every decoy scores below 1 | [prod/worlds/](../worlds/) | `bun run worldplay verify ../prod/worlds/helpdesk`, and the same for every other folder in `prod/worlds/` | per task `solution 1.000 noop 0.000`, every decoy below 1 |
| The public form of every world holds no grader, solution or decoy | `prod/worlds/<world>/public/world.yaml` | `bun scripts/render-public-worlds.ts` | `unchanged` for all 25: the committed public files are exactly what the engine derives |
| The 38 exported dataset episodes replay on the worlds they ran on, to their recorded scores | [eval/dataset/2026-10-07/](../../eval/dataset/2026-10-07/) | `bun run evidence` | `38 of 38 episodes replay to their recorded score; 6 of 6 folders agree` |
| One run on a new description ended done with 3 verified tasks | [eval/runs/2026-10-08-handin-smoke/](../../eval/runs/2026-10-08-handin-smoke/) | `bun run worldplay verify ../eval/runs/2026-10-08-handin-smoke/gen-it-asset-tracker` | 3 tasks, each `solution 1.000 noop 0.000` |
| stress-4 passed 23 of 29 | [summary](../../eval/runs/2026-10-08-stress-4/summary.md) | `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-08-stress-4` | `"passed": 23`: 20 success, 3 expected refusal, 6 product failure |
| stress-5 reran those 6 failures, and 5 passed | [summary](../../eval/runs/2026-10-08-stress-5/summary.md) | `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-08-stress-5` | `"passed": 5`, 1 product failure, 23 not run |
| stress-6 passed 27 of 29 | [summary](../../eval/runs/2026-10-08-stress-6/summary.md) | `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-08-stress-6` | `"passed": 27`: 24 success, 3 expected refusal, 2 product failure |
| stress-7 passed its 5 cases on the v1.1.1 code | [summary](../../eval/runs/2026-10-08-stress-7-targeted/summary.md) | `bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/2026-10-08-stress-7-targeted` | `"passed": 5`, 5 success, 24 not run |
| The whole system runs offline | [scripts/demo-all.sh](../../scripts/demo-all.sh) | `../scripts/demo-all.sh` | `25 passed, 0 failed` |

- `analyze-eval` recomputes each scorecard from the committed `events.jsonl` files. It exits 0 only when a run covers the whole suite and every case passed, so read the numbers, not the exit code. Times and costs in those events are client-side estimates, not invoices.
- `bun run evidence` replays each episode on this checkout's engine. The episodes declare the engine commit of an earlier repository, so agreement shows that today's engine reproduces the recorded run. For each episode it checks the seed state hash, the status and body of every call, the end-state hash and the score, which it gets by grading the replay through the verifier.
- Each export folder keeps the world its episodes ran on, in `world/world.yaml`. `bun scripts/freeze-export-world.ts ../prod/worlds/gen-orders ../eval/dataset/2026-10-07/gen-orders` writes one, and refuses unless its hash is the version the manifest names. Five came from `prod/worlds`. helpdesk came from the root commit (`git show 733538fd:prod/worlds/helpdesk/world.yaml`), because A-356 changed helpdesk after the export.

## Check on GitHub

- v1.1.1's code, `71f84d45`, passed CI twice. `gh run view 37860510831 --repo jop8281/worldgen` and `gh run view 37860513520 --repo jop8281/worldgen` each show `success`. The [GitHub Release page](https://github.com/jop8281/worldgen/releases/tag/v1.1.1) links both.

## Not re-checkable from a clone

- The live `--only /store` acceptance run: 248 s and $0.82 on `e034036c`, done, with `check` and `verify` passing. Its output stays outside the repository. The receipt is a comment on [YOS-244](https://linear.app/yossi-zozo123/issue/YOS-244).
- The live-run dress rehearsal: 3 of 3 delivered in 13.2 minutes for $3.55. The receipt is on [YOS-100](https://linear.app/yossi-zozo123/issue/YOS-100).

## Answers in the committed worlds

The committed worlds are a development set, and they include the answers: each `prod/worlds/<world>/world.yaml` holds its graders, reference solutions and decoys. An agent under test reaches only a world's API, on the world port, and a sandboxed run uploads only the public form, `public/world.yaml`. A clean test set is generated fresh by WorldGen from prompts nobody has seen, as the live run does with `bun run live`.
