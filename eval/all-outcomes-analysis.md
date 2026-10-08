# Analyze every expected eval outcome

From `code/`, run the offline reader against the suite used for the run:

```sh
bun scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/<run-directory>
# Node alternative:
node --import tsx scripts/analyze-eval.ts ../eval/suite.yaml ../eval/runs/<run-directory>
```

The JSON report keeps one slot for every manifest case, in manifest order. The success
denominator is always the number of expected cases. Invalid, missing and duplicate slots
cannot pass. Unexpected records are listed separately and prevent a complete-suite verdict.
The manifest must be nonempty with unique lowercase kebab-case IDs. An expected stopped
case passes only with a recorded known stop reason other than `model_error`.

The reader reads the existing `<case>/case.json`, `<case>/events.jsonl` and
`<case>/change/events.jsonl` layout. It never executes a world, invokes a provider, reads
credentials, or writes evidence. It ignores hidden directories, including `.attempts`;
history is not a second set of current cases. Case paths derive from validated directory
names and the manifest, never record payload IDs. Symlinked case directories, files and
change directories are rejected. Analyze a quiescent copy of a run; this is an offline
reader, not an atomic snapshot of a concurrently written directory.

Each metric reports `measured`, `expected`, `coverage`, `measuredTotal`, `total`, `p50`
and `p95`. Time (`ms`) and cost (`costUsd`) come from terminal phase events; missing,
negative, nonfinite or nonnumeric values remain `null`. Partial attempt sums never replace
missing terminal totals. Case totals require every recorded phase's measurement. A measured
zero stays zero. `measuredTotal` is the sum over measured expected cases, or null if none;
`total` is null unless all expected cases are measured. Unexpected cases never contribute.
Percentiles use nearest-rank over measured case totals: sort ascending and select
`ceil(p × n)` with one-based indexing, without interpolation; no samples means null.

Attempts count logged completed `attempt` events, not unlogged or abandoned provider calls.
Coverage requires a single identified run bounded by start and finish, matching active step
invocations, consecutive per-step attempt numbers and consistency with step completion counts.
Backtracking resets the target step's attempt number, and since YOS-258 (A-383) every step it reruns restarts at 1;
a rerun step may also continue its count, as runs recorded before that do. Completion counts belong to one invocation.
Create/change logs must have their respective create/iterate modes and distinct run identities.
A preflight refusal may have zero
attempts. A started step with neither attempt nor refusal has unknown attempt coverage.
Unknown event tags, mixed run IDs, duplicate boundaries, invalid JSON, phase-order changes
or contradictions with `case.json` invalidate the case. Diagnostics omit raw payloads.

`completeSuite` requires valid evidence for all expected cases, no unexpected records, and
complete coverage of all three metrics. It can be true for a fully measured failure.
`allPassed` describes expected outcomes independently of metric coverage. Exit status is
0 only when both are true, 1 for a failed or incomplete report, and 2 for usage, suite or run
directory errors. The existing eval runner and `summary.md` are unchanged.

These are descriptive measurements, not a before/after comparison or a claim of improvement.
Missingness and selected measured subsets can bias percentiles. Effort tuning, model choice,
budget changes and paid reruns remain separate work under YOS-54.
