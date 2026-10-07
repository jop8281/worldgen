# Spec calls: cli-world-check

- U-7 applied: renamed `code/src/cli/world.ts` to `worldplay.ts` and the npm script `world` to `worldplay` (the `docs` script now points at worldplay.ts); usage text reads `usage: worldplay <command>`. U-7 outranks the work order's file list (order 16). Follow-up: AGENTS.md and research/architecture.md still say `npm run world`; those are outside this unit's scope.
- Usage and "not implemented yet" messages go to stderr, stdout stays empty. Why: keeps `--json` and pipes clean; acceptance only fixes the exit code 2. Reversible: yes.
- A valid world with no issues prints `ok` (readable mode) or `[]` (`--json`). Why: acceptance specifies only issue lines; an empty success output is ambiguous to a human. Reversible: yes.
- The printed and JSON list is errors followed by warnings (`report.issues` then `report.warnings`); exit 1 only when an `error` severity issue exists, so warnings alone exit 0. Why: matches "exits 1 on errors and 0 on ok". Reversible: yes.
- `loadWorld` failures (missing file, bad YAML) print as ordinary issues and exit 1, not 2. Why: they are world problems the engine reports as `schema.invalid`, not usage errors. Reversible: yes.
- `layer.blocked` issues are printed too, one line each. Why: the CLI prints every issue the engine returns and filters nothing. Reversible: yes.
- Unknown options (`--x`) and extra or missing positional args exit 2 with usage. Why: usage errors. Reversible: yes.
- `default:` in a switch is banned by test/architecture-symbols.test.ts without assertNever, and command names are an open string set, so main() dispatches with if-statements. Reversible: yes.
