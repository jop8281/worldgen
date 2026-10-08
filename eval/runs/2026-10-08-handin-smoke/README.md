# Hand-in smoke run, 2026-10-08

One WorldGen run on the spec's own example description, on `stabilize/main` `8ce44508`. Its code is identical to the hand-in commit `2825d29a`; the two differ only in `README.md`.

```sh
cd code
WORLDGEN_CLAUDE_BIN=~/.local/bin/claude bun run worldgen "an IT asset tracker with laptops, assignments, repair tickets and a quarterly audit" --out <dir>
bun run worldplay check <dir>
bun run worldplay verify <dir>
```

- Model `claude-sonnet-5-5` through `claude -p`, with the default $5 and 15-minute budget.
- Result: done in 473.3 s for $1.4520 (a client-side estimate), with 3 verified tasks.
- `worldplay check` exits 0, with one warning: the audit table has 4 seed rows, so paging does not matter for it.
- `worldplay verify` exits 0:

| Task | Difficulty | Solution | No-op | Decoys |
|---|---|---|---|---|
| `assign_spare_laptop` | easy | 1.000 | 0.000 | 0.000, 0.400 |
| `send_assigned_laptop_to_repair` | medium | 1.000 | 0.000 | 0.000, 0.700, 0.000 |
| `close_in_progress_audit` | hard | 1.000 | 0.000 | 0.000, 0.250, 0.500 |

The run wrote to a scratch directory. Its absolute path in `events.jsonl` was replaced with this directory's path; nothing else was edited.
