# Red-team calls: edits, diffs, save and load, and the CLI

Status: proposal

These are open questions from `research/redteam-contract.md` about `applyEdit`, `diffWorlds`, `saveWorld` and `loadWorld`, and `world <command>`. WorldGen's iterate mode ("add refunds") depends on the edit and diff answers.

## Decision rows

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Strict edits (RT-91) | `worldEditSchema` is strict at the top level and inside `upsert`, `patch` and `remove`. An unknown key or section gives `ok: false` with `schema.invalid` at `['input', …]`. | A model that writes `upserts:` would otherwise get an edit that silently does nothing, and the stage would then fail in a confusing way. | 2026-10-06 | Yes |
| A-xx | Missing targets (RT-92, RT-93) | `remove` of a name that does not exist, and `patch` of an item that does not exist, both give `ref.unknown` at `['input', 'remove' or 'patch', <section>, <name>]`, and the known names are in the hint. A patch never creates an item. | A patch that creates an item would build half an item, with no type and no required keys. That is the silent guess the spec forbids. | 2026-10-06 | Yes |
| A-xx | Widening transitions (RT-94) | Split `transition_changed` into `transition_added`, which is not destructive, and `transition_removed`, which is destructive. | "Add refunds" adds `closed -> refunded`. It must not count as destructive and need a destructive change to be approved. | 2026-10-06 | Yes |
| A-xx | One YAML document (RT-95) | A `world.yaml` holding more than one document gives `ok: false` with `schema.invalid` at `['format']`. | If the engine silently used the first document, an appended edit would be ignored. | 2026-10-06 | Yes |
| A-xx | Byte-stable save (RT-96) | `saveWorld` writes sections and keys in a fixed order, with fixed YAML options and literal block scalars for snippets. Save, then load, check and save again, gives the same bytes. | Iterated worlds then diff cleanly in git, and the hand-built world gives the same bytes on every save. | 2026-10-06 | Yes |
| A-xx | CLI usage errors (RT-29, RT-97) | Exit code 2 for a bad invocation (unknown subcommand, missing args, or a missing, unparseable or wrong-shaped `--state` file), with usage or the bad input named. Exit code 1 for a world that fails. Exit code 0 for success, including a world that has only warnings (RT-32). | Scripts and the trial reviewers can tell "you called it wrong" apart from "the world is broken". | 2026-10-06 | Yes |
| A-xx | No stack traces (RT-98) | The CLI prints catalog issues and messages, never a Node stack trace. Stack traces appear only when `WORLD_DEBUG=1` is set. A missing dir is named. | The error output is read by models and by reviewers. | 2026-10-06 | Yes |
| A-xx | Verify output (RT-99) | A failing `world verify` prints one line per issue, `<task> <code> <path> — <hint>`, and exits 1. | The repair loop and humans both need to see which task failed and why. | 2026-10-06 | Yes |

## Unlocks

| RT | Tests that become firm |
|---|---|
| RT-91 | `G-52 unknown keys and sections in an edit are refused…` |
| RT-92 | `G-52 removing a key that does not exist is an issue` |
| RT-93 | `G-52 a patch on a missing item is an issue…` |
| RT-94 | `G-53 adding a state with new transitions out of it (add refunds) is not destructive` |
| RT-95 | `G-55 loadWorld refuses two documents` |
| RT-96 | `G-54 saveWorld is deterministic and a fixpoint…` |
| RT-97 | `G-56 an unknown subcommand exits non-zero…`, `G-56 no arguments and check without a dir print usage…`, `G-58 grade with a missing, unparseable or wrong-shaped state file…` |
| RT-98 | `G-56 check failures print no Node stack trace…` |
| RT-99 | `G-57 a failing verify names the task and the issue code` |
