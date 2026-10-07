# Spec calls: stab-docs (YOS-99)

- Call: `worldgen` without `--out` writes to `prod/worlds/gen-<slug>`, not `prod/worlds/generated/<slug>`. Why: decision A-44 names `gen-<slug>`; the old default contradicted it. `genDirName(input)` in `worldgen/input.ts` is `gen-` plus `inputSlug`. Reversible: yes.
- Call: keep the existing `inputSlug` rule unchanged (lowercase ASCII words joined by `-`, at most 40 characters cut at a word boundary; OpenAPI uses file stem plus `--only` prefixes, CSV the first file's stem; fallback `world`), so "A helpdesk with SLA tiers" maps to `gen-a-helpdesk-with-sla-tiers`. Why: already tested, and dropping stop words would make slugs less predictable. Reversible: yes.
- Call: `worldplay <command> --help` now prints the usage and exits 0 (it exited 2). Why: documented commands must answer `--help` with 0; this was missing wiring only. Reversible: yes.
- Call: the docs test checks `npm run` lines against package.json scripts and runs `--help` for CLI scripts only; `typecheck`, `test` and `check` are checked for existence only. Why: `--help` on them would run the build or the suite. Reversible: yes.
- Call: `test/worlds.test.ts` still accepts the legacy `generated/` subdirectory. Why: harmless, and no world lives there now. Reversible: yes.
