# Graded Sonnet episodes, 2026-10-07

These are graded agent episodes on six WorldGen worlds, as JSONL (YOS-91). worldgen-27 collected them on Boat sandboxes from `stabilize/main` at engine commit `10bfe47bd170a55b1f0ee87a5b750177d2b3f67e`. The model is `claude-sonnet-5-5`, with prompt `solver-prompt-1` and config `cfg-183f17ac337b`. Each world folder holds the public export only: `dataset.jsonl`, `failures.jsonl`, `manifest.json` and the last run's `REPORT.md`. The private evidence (frozen world copies, initial and final state dumps, call logs) stays out of the repo.

## Counts

| World | Runs | Episodes | easy / medium / hard | Tool calls | Model calls | Cost (USD) | Engine re-grade |
|---|--:|--:|---|--:|--:|--:|---|
| helpdesk | 2 | 6 | 2 / 2 / 2 | 34 | 40 | 1.1901 | 6 of 6 agree |
| gen-library-loans | 2 | 6 | 2 / 2 / 2 | 62 | 68 | 4.8908 | 6 of 6 agree |
| gen-stripe-charges | 2 | 8 | 2 / 4 / 2 | 54 | 62 | 1.4935 | 8 of 8 agree |
| gen-repair-desk | 2 | 6 | 2 / 2 / 2 | 67 | 73 | 1.3206 | 6 of 6 agree |
| gen-orders | 1 | 4 | 1 / 2 / 1 | 13 | 17 | 0.2897 | 4 of 4 agree |
| gen-insurance-claims | 2 | 8 | 2 / 4 / 2 | 53 | 61 | 1.5359 | 8 of 8 agree |
| **Total** | **11** | **38** | 11 / 16 / 11 | **283** | **321** | **10.7206** | **38 of 38** |

Grade distribution: all 38 episodes in `dataset.jsonl` have engine score 1, and every `failures.jsonl` is empty. That is by construction: an export puts only complete successes in `dataset.jsonl`, meaning stopped as done, score exactly 1, a non-blank reply, both state hashes, and fully accounted spend. Anything else goes to `failures.jsonl`. Cost is the sum of the episodes' `usage.cost_usd`.

## How it was checked

worldgen-fb checked the collection on 2026-10-07, against the original output folders, which include the private evidence:

- `validateExport` (code/src/dataset/store.ts) passes for all six worlds. It checks file sizes and sha256 against each manifest, one canonical valid record per line in run, task and episode order, and counts and version lists. It also checks the frozen world hashes and the private initial and final state dumps against each accepted episode's recorded hashes. The episode schema pairs every tool call with its result in order, opens with the instruction, and ends with the final reply equal to `final_reply`.
- Engine re-grade: each accepted episode's private `final.json` was graded again with `gradeDump` on the frozen world, with its call log. All 38 match the recorded score.
- Idempotency: re-exporting helpdesk from a copy of its saved logs with `exportDataset` gives byte-identical `dataset.jsonl`, `failures.jsonl` and `manifest.json`.
- Provenance: each frozen world has the same content id (WID) as `prod/worlds/<world>/world.yaml` at `10bfe47`. The bytes differ only because the frozen copy writes default values out in full.
- Secret scan of all 262 files the collection wrote, private evidence included: no API key formats, bearer tokens, credential assignments, private keys or `BOAT_API_KEY`/`LLM_KEY`/`ANTHROPIC_API_KEY` names. The public files contain no local paths.
- The copies in this folder match the sha256, byte and record counts in each `manifest.json`. To recheck: `shasum -a 256 <world>/dataset.jsonl` and compare with `files.dataset.sha256`.

## Caveats

- The engine score certifies the final world state only, not whether the final reply's claims are true (`grading_note` in each manifest).
- gen-orders has one run, not two. Its first run (`gen-orders-w1`) crashed with ENOENT on a rename under `private/worlds/`, because two runs shared one output folder at the same time, and it left no episode. Its spend is not in these records. This was reported to the YOS-140 owner.
- Each world's `REPORT.md` describes only the run that finished last, not both runs. The `manifest.json` covers both. Two reports print the world's internal `meta.name` (`out` for gen-orders, `world` for gen-repair-desk) instead of the folder name.
- `manifest.json` names its frozen world as `private/worlds/<sha>/world.yaml`, which is not shipped. `validateExport` therefore cannot be rerun on this folder alone, but the checksums above can.
- Every episode passed, so this set has no failed or partial episodes for contrast.
