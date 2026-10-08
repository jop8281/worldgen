# research

Thinking that shapes the code. Markdown and JSON only. Nothing in `code/` reads this directory, so never put code or spikes here.

Name files in lowercase kebab-case. Record each design call as a row in `decisions.md`, not as a new file.

## Start here

- `spec.md` is the work-trial spec, verbatim. `spec.pdf` is the original.
- `architecture.md` explains the code structure. `decisions.md` is the append-only decision log.
- `design-review.md` is the merged design we agreed on before building.
- `spec-traceability.md` maps each spec requirement to the unit and test that deliver it.
- `design-laws.md` freezes the Proof-Carrying Worlds design laws (L1 to L12) and maps each one to the mechanism or issue that enforces it.
- `cleanup-manifest.md` is the post-delivery cleanup baseline and inventory (YOS-200). It holds the baseline refs, world and fixture digests, the sensitive-content audit of `prod/`, 40 candidates with consumers, decisions and owners, and the contract tests for each refactor class.

## Plans

- `plan.md` is the product plan, partly superseded by `decisions.md`. `archive/plan-draft-<angle>.md` and `archive/plan-critique-<reviewer>.json` are the drafts and critiques it came from.
- `graphs-and-universes.md`, `portfolio.md` and `python-alternative.md` record larger calls: the two-stage design, the reference targets, and the Python replan we did not choose.
- `linear.md` covers how we use Linear. `linear-world.md` covers Linear as a world to build.

## Oracles for the input cases

Hand-checked behaviour tables that units and eval runs check worlds against.

- `helpdesk-expected-behaviour.md`: the golden hand-built world.
- `tau2-retail-expected-behaviour.md`: the description case.
- `stripe-refunds-expected-behaviour.md`: the OpenAPI case and the iterate demo.
- `linear-csv-expected-behaviour.md`: the CSV case.

## Rehearsal and live run

- `rehearsal-prompts.md` is the bank of unseen prompts. `rehearsal-rubric.md` is the scoring sheet.
- `live-run-runbook.md` is the checklist for the day the hiring team sends prompts.

## Background

- `related-work.md` verifies prior work. `benchmark-reuse.md` says what we take from public benchmarks.
- `claude-cli-transport.md` is the fact sheet for the `claude -p` model transport.
- `reports/` holds long write-ups. `research_notes/<topic>/` holds the notes behind them.

## Archive

`archive/` holds dated records kept for evidence and moved out of the way (cleanup manifest rows 5 to 10, YOS-210): the 2026-10-07 handoff notes, the release-1 freeze record, the resolved YOS-87 payer memo, the pre-build plan drafts and critiques, and the factory ledger copy below.

- `archive/design-draft.md` was the draft of the design doc; `prod/design.md` replaced it (YOS-56).
- `archive/design-doc-gap.md` compared the WorldGen Design Doc PDF with `main` at the time it was written, before `prod/design.md` existed.

## Factory

- `archive/factory/` mirrors the factory coordinator's ledger: the unit recipe, standing orders, backlog and user decisions. See `archive/factory/README.md`.
- `spec-calls/<unit>.md` holds the spec calls each factory unit made. Engine-freeze and docs units fold them into `decisions.md`.
