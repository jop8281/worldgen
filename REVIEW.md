# WorldGen factory review

Review the exact candidate against the issue's acceptance criteria and AGENTS.md.
Require changes for correctness defects, weakened verification, leaked credentials,
unplanned destructive world changes, or edits outside the approved scope.

Linear is the sole issue tracker. Link the Linear work order and evidence in the
PR. Do not create GitHub issues or maintain a mirrored backlog. Any temporary
intake file must preserve the Linear ID and accepted body; it is a run input,
not an independent source of priority or completion status.

The engine owns validation and grading. Generated worlds must pass engine checks
and task proofs. A passing unit suite alone does not prove live generation, Boat
execution, model behavior, or dataset acceptance.

Read the fresh JUnit evidence and command exit status for this candidate. Missing,
malformed, stale, failed, or skipped required evidence cannot count as success.
Check the complete diff, including files absent from the plan. Record concrete
blockers with paths and observable consequences; limit optional nits to three.

This target protects engine and governance files. Work requiring those changes
needs a separately reviewed operator policy. Never relax protection to finish a
world-generation task. Backend and Airflow qualification, human intent and plan
decisions, and authorized merge remain separate gates.
