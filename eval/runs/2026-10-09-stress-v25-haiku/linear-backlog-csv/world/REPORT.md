# WorldGen report: Linear issue tracker API (issues and comments), as in the imported WorldGen backlog

A Linear-style issue tracker seeded from the 123-row linear_backlog CSV. Agents read issues, create and update them, comment on them, and move them through a status machine (backlog, in_progress, in_review, done, canceled, duplicate) with actions that guard each transition. Feasible: the core value is stateful issue records changed through an API, not computation.

## What was built

Entities (2):

- `issue`: 123 seeded rows
- `comment`: 6 seeded rows

Routes (6):

- `list_issues`: GET /issues
- `get_issue`: GET /issues/{id}
- `create_issue`: POST /issues
- `update_issue`: PATCH /issues/{id}
- `list_comments`: GET /comments
- `create_comment`: POST /issues/{issue_id}/comments

Actions (6):

- `start_issue`: POST /issues/{id}/start
- `request_review`: POST /issues/{id}/review
- `complete_issue`: POST /issues/{id}/complete
- `cancel_issue`: POST /issues/{id}/cancel
- `mark_duplicate`: POST /issues/{id}/duplicate
- `reopen_issue`: POST /issues/{id}/reopen

Jobs: none.

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s.
  - Why: The latest imported created or updated timestamp is 2026-10-07T02:07Z, so the start is after all history, and time moves only by explicit advance, which keeps grading deterministic.
- Status values are snake_cased into backlog, in_progress, in_review, done, canceled, duplicate; the CSV's six distinct values map one to one.
  - Why: State names must match a snake_case pattern, and the fixture rule requires every status value to be a workflow state.
- The CSV id column becomes identifier (unique, pattern ^[A-Z]+-[0-9]+$); engine ids are issue ids such as iss_0001.
  - Why: Engine ids are prefix plus number, but the backlog identifiers such as YOS-1 are what agents read and search by.
- parent is stored as the parent's identifier string, not a ref.
  - Why: Parent values name YOS-91, YOS-105 or YOS-114, which may not be among the 123 rows; a ref would fail to resolve and would create a seed cycle.
- labels, project and milestone are plain strings, not entities.
  - Why: Labels are semicolon-joined lists in the CSV, and project and milestone have one or twelve values; separate entities add no behaviour the tasks need.
- source_created_at, source_updated_at and completed_at are fields, because created_at and updated_at are engine-maintained and cannot take the CSV dates.
  - Why: Seeded history must keep the CSV timestamps, all before the clock start, so the time-order check holds.
- canceled and done are terminal; duplicate may be reopened to backlog; no action reopens a canceled issue.
  - Why: Cancelling is the irreversible step the medium task needs, so its precondition check matters.
- status is readonly and changes only through workflow actions; PATCH on status answers field.readonly.
  - Why: Every status change must pass the action's guard, not a generic update.
- No authentication and no assignee field; the two-actor task is modelled by call order (request review, then complete), checked through the trace.
  - Why: The world has no actor identity, so a separate reviewer role would be invented rather than read from the request.
- stateMix for issue is a planning estimate of 30/15/10/35/5/5 across the six states, summing to 100, with every state present and none above 70%.
  - Why: The input gives the six distinct status values but not their counts; the seed stage must measure the CSV's own status counts and match this mix within 10 points, and the plan must not claim more precision than that.
- Pressure states are written as entity.state (issue.backlog, issue.in_progress), the form the plan schema requires.
  - Why: The previous pressure entries named bare states, which are not entity.state of a planned workflow.
- Acceptance tests create every row they use with QA-9xxx identifiers, which the seed never uses.
  - Why: Tests run before the seed exists and again after it, so they must not depend on seed rows or collide with them.

## Fields not in the input

7 fields match no column or property name in the input. WorldGen invented each one, or renamed an input field.

- `issue.identifier`
- `issue.completed_at`
- `issue.source_created_at`
- `issue.source_updated_at`
- `comment.issue_id`
- `comment.body`
- `comment.author`

## Questions asked of the input

- Should the world mirror Linear's GraphQL API or its REST-style issue resource?
  - Default answer: REST-style issue and comment routes, since the tasks are single-resource status changes.
- What are the actual counts of each status in the CSV, to fix the seed mix?
  - Default answer: Use the planning estimate 30/15/10/35/5/5 and let the seed stage measure the CSV; the mix must land within 10 points of the built seed.

## Left out

- GraphQL API and Linear's exact response envelope
  - Why: The world mirrors the issue resource through REST routes; the GraphQL surface adds no state the tasks need.
- Authentication, teams, users and assignees
  - Why: The input carries no actor data, and inventing roles would add behaviour the CSV cannot support.
- Labels, projects and milestones as their own entities
  - Why: They are flat strings in the CSV and tasks do not change them.
- Cycles, attachments, notifications, webhooks and archiving
  - Why: None appear in the input and none is needed for the status workflow.
- Issue deletion
  - Why: Linear archives rather than deletes, and no task needs deletion.

## Proof

The engine check passed: 7 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_b5633de8ad72b2ded7983563e52f6f39a180eb6b1def1ec2f7758150395652d2`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| create_and_start_issue | easy | 1.000 | 0.000 | none | 0.500 | declared (2); mutants 2/8 | `tid_c6bd2e607c70dd4a13dbbd6fc5a20cb5ba71983b2db3464f2434d5d432896fbc` |
| cancel_unneeded_issue | medium | 1.000 | 0.000 | 0.400, 0.000 | n/a | declared (1); mutants 2/8 | `tid_3d66be4ec17a7a2d4dbcd874ab03f26690d1b5e49c54f1e85304ca967bcf126a` |
| request_review_then_complete | hard | 1.000 | 0.000 | 0.400, 0.000 | 0.400 | declared (1); mutants 2/8 | `tid_efe42d703c6c564a012bb2680f9a8a2c3c96243f1453394043705b0bf23be927` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_unneeded_issue` 0.400: marks the issue as a duplicate of YOS-102 instead of cancelling it, so it ends in duplicate and not canceled
- `cancel_unneeded_issue` 0.000: cancels the first backlog issue on the list without finding the one the team named, so it cancels a different issue
- `request_review_then_complete` 0.400: the engineer requests review and stops, so the reviewer's completion never happens and only the review part scores
- `request_review_then_complete` 0.000: completes the issue straight from in_progress, skipping the review request, so no request_review precedes complete_issue

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| create_and_start_issue | easy | 1 | none | none | none declared |
| cancel_unneeded_issue | medium | 1 | none | issue | distractors: met; state: met |
| request_review_then_complete | hard | 1 | issue | issue | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Linear issue tracker API (issues and comments), as in the imported WorldGen backlog, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from csv. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 2.57 | 0.0236 |
| model | 1 | 0.47 | 0.0522 |
| workflow | 1 | 0.40 | 0.0642 |
| seed | 1 | 0.47 | 0.0556 |
| tasks | 1 | 2.59 | 0.1793 |
| Total | 6 | 6.51 | 0.3749 |

Run total: 6.52 minutes, $0.3749.
