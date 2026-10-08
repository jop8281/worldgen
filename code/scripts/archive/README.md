# Archived one-off scripts

These scripts each made a one-time edit that is now committed: the post-generation hardening of a prod world (`harden-*.ts`, `tune-gen-billing-dunning.ts`, `set-gen-clinic-appointments-clock.ts`) or a measurement (`probe-collateral.ts`, A-116, which the A-156 collateral gate in verifyTask replaced). The edits they made are pinned in `prod/worlds/`, and the tests check those worlds, not these scripts.

They are kept for provenance only. Nothing runs them: no package.json script, CI job or evaluator doc names them, and they are outside the tsconfig include, so `bun run typecheck` does not compile them; test/architecture.test.ts still scans their imports under the Boat rule. Their relative paths resolve from this directory, so one can still be rerun by hand from `code/`, for example `bun scripts/archive/harden-helpdesk.ts`. See research/cleanup-manifest.md rows 12 and 13 (YOS-210).
