# WorldGen factory recipe (adapted from zozo123/ariflow-swfactory prompts and REVIEW.md)

One unit = one Linear issue = one branch `factory/<KEY>`. Stages run in order. Each ends in a check.

## 1. Spec (read-only)
Write `spec.md` for the unit: numbered requirements R1..Rn, each testable in one assertion and traceable to the issue's Acceptance; API (exported names, signatures, errors); concerns with mitigations; open questions with the assumption taken. No scope beyond the issue. Read the repo; never guess what it does.

## 2. Plan (read-only)
JSON: files (subset of the issue's scope), steps (tests first, then implementation), tests (each prefixed with the R it proves), risks. Every R is covered by a step and a test.

## 3. Build
Tests first, then implement until `npm run check` (from code/) is green. Touch only planned files. Leave evidence: spec.md and plan.json in `<scratchpad>/orchestrate/worldgen/evidence/<KEY>/`, not in the repo.

## 4. Fix loop (max 3 rounds)
On red, fix the CODE, not the tests. Re-run Verify after each round. Three red rounds = stop and report blocked with the failing output.

## 5. Review (separate agents, three lanes, read-only)
- correctness: broken requirements or AGENTS.md invariants, logic and edge cases, API/contract breakage.
- verification: behavior with no meaningful test, tests that pass without exercising behavior, weakened tests, plan fidelity (`git diff --name-only` vs plan.files).
- risk: secrets, injection, path traversal, network egress, nondeterminism leaks into engine core (wall clock, Math.random), unbounded cost.
Output per lane: {"verdict":"approve"|"request_changes","findings":[{"severity":"blocker|major|minor|nit","file","line","title","detail"}]}. Max 3 nits.
Fan-in is done by the coordinator's script: dedupe by (file,line,title), stronger severity wins. blocker or major = one bounded repair round, then re-verify and re-review. Candidate is done ("crystal") only when Verify is green and zero blocker/major remain.

## 6. Deliver
Commit on the unit branch. The coordinator pushes, opens the PR (body: `Fixes <LINEAR-KEY>`, spec requirements, Verify output, review summary) and moves the Linear issue.
