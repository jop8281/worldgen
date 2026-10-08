# Rehearsal prompts, not the hiring team's

These three prompts are rehearsal inputs that worldgen-dc wrote for the YOS-100 live-run rehearsal (evidence for YOS-226). They are **not** the hiring team's prompts. Those go in [prod/prompts/](../../../prod/prompts/README.md) and nowhere else.

Each file is byte-for-byte as received, from the old-repository commit `c1cc5ddc`. Never edit them.

## The only command to use

Run from `code/`. Replace `<scratch>` with a directory outside the repository, and `<date>` with the run date:

```sh
bun run live ../eval/inputs/rehearsal-yos100 --worlds-dir <scratch> --report ../eval/runs/<date>-yos100-rehearsal/LIVE-RUN.md --out-dir ../eval/runs/<date>-yos100-rehearsal
```

Without `--worlds-dir` and `--report`, `bun run live` moves delivered worlds into `prod/worlds/` and writes `prod/LIVE-RUN.md`. Both are hand-in deliverables, so a rehearsal would then pass as the real live run. `--dry-run` lists each prompt with the world folder it would write, and the report path when `--report` is given, without a model call.
