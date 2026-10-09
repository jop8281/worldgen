# WorldGen report: Linear-style issue tracker (teams, members, projects, issues with a workflow status, comments)

An issue tracker where teams own issues that members work through backlog, todo, in progress, in review, done or canceled. Actions enforce who may be assigned, a per-team work-in-progress limit, completion and cancellation rules, and comment rules.

## What was built

Entities (8):

- `team`: 3 seeded rows
- `member`: 9 seeded rows
- `project`: 4 seeded rows
- `issue`: 40 seeded rows
- `comment`: 30 seeded rows
- `workflow_state`: 0 seeded rows
- `issue_label`: 0 seeded rows
- `cycle`: 0 seeded rows

Routes (22):

- `list_issues`: GET /issues
- `get_issue`: GET /issues/{id}
- `create_issue`: POST /issues
- `update_issue`: PATCH /issues/{id}
- `list_comments`: GET /issues/{issue_id}/comments
- `list_teams`: GET /teams
- `get_team`: GET /teams/{id}
- `create_team`: POST /teams
- `list_members`: GET /members
- `get_member`: GET /members/{id}
- `create_member`: POST /members
- `list_projects`: GET /projects
- `create_project`: POST /projects
- `list_users`: GET /users
- `list_labels`: GET /labels
- `create_label`: POST /labels
- `list_workflow_states`: GET /workflow_states
- `create_workflow_state`: POST /workflow_states
- `list_cycles`: GET /cycles
- `get_cycle`: GET /cycles/{id}
- `create_cycle`: POST /cycles
- `create_issue_comment`: POST /issues/{issue_id}/comments

Actions (5):

- `assign_issue`: POST /issues/{id}/assign
- `start_issue`: POST /issues/{id}/start
- `complete_issue`: POST /issues/{id}/complete
- `cancel_issue`: POST /issues/{id}/cancel
- `add_comment`: POST /issues/{id}/comment

Jobs: none.

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded history lies before it.
  - Why: Deterministic time that is explicit; the seed has no future scheduled events.
- No jobs; all rules are enforced by actions.
  - Why: The core value is record changes by an agent, not background processing.
- Status is changed through actions (assign, start, complete, cancel); plain PATCH can only move along declared transitions.
  - Why: Actions carry the business rules; the state machine guards the rest.
- The WIP limit is per assignee, taken from team.wip_limit (default 3), and counts the assignee's in_progress issues.
  - Why: Gives a scarce-resource rule without extra entities.
- Issue identifiers like ENG-12 are out of scope; issues are addressed by row id.
  - Why: Keeps the model small.
- Guests and inactive members cannot be assigned; assignee must be on the issue's team.
  - Why: Models the permission check.
- Acceptance tests use emails at test.example and team keys beginning with Z; the seed avoids both.
  - Why: Avoids seed collisions.

## Questions asked of the input

- Should issues have team-prefixed identifiers like ENG-12?
  - Default answer: No; ids like iss_0001 are enough.
- Should status be changeable by plain PATCH?
  - Default answer: Only along declared transitions; actions carry the business rules.
- Is there a current user for permissions?
  - Default answer: No; the assignee or author is passed explicitly and checked against role and team.

## Left out

- Cycles, labels, subscriptions, notifications, attachments, webhooks
  - Why: Not needed for the core workflow.
- Authentication and a current-user concept
  - Why: Actors are passed explicitly in inputs.
- GraphQL API, real-time sync, UI
  - Why: The world is a REST replica.

## Proof

The engine check passed: 8 world tests, 6 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_08a3f2c64ff03142c2e29f3d702749721ce8e91717dadaaea6a314ff0427492c`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| assign_urgent_platform_issue | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 7/8 | `tid_9e4405738224326d5c0304e5cf83f52a5bb6181d656c5e6e304f7a9f5daff458` |
| cancel_duplicate_dark_mode | medium | 1.000 | 0.000 | 0.000, 0.600 | n/a | declared (1); mutants 5/8 | `tid_3828274ecf30067d3f893c81899eba1b5e13aa257d16a79ab3927316bd553b5e` |
| free_wip_and_start_next | hard | 1.000 | 0.000 | 0.250, 0.750, 0.000 | 0.500 | declared (3); mutants 5/8 | `tid_058bc37b29fd06bd2c446562a6abfddb824adc98e9833524efb92592f5b7a6ef` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `assign_urgent_platform_issue` 0.000: assigns the unassigned urgent issue of the Web team to the Web team's Dana Whitfield instead of the Platform one
- `cancel_duplicate_dark_mode` 0.000: cancels the identically titled backlog issue of the Web team instead of the Mobile one
- `cancel_duplicate_dark_mode` 0.600: cancels the right Mobile issue but gives a reason that does not say it is a duplicate
- `free_wip_and_start_next` 0.250: completes only the in-review rate limiter issue and believes that frees a slot, so starting the webhook issue is refused by the WIP limit
- `free_wip_and_start_next` 0.750: completes the job queue issue and starts the webhook issue but leaves the in-review rate limiter issue open
- `free_wip_and_start_next` 0.000: frees the slot by completing a different in-progress issue of Ravi (the deploy pipeline one) instead of the job queue migration

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| assign_urgent_platform_issue | easy | 1 | none | issue | distractors: met |
| cancel_duplicate_dark_mode | medium | 1 | none | issue | distractors: met; state: met |
| free_wip_and_start_next | hard | 3 | issue | issue | hard: met; paging: met; distractors: met; state: met; state: met; state: met |

## Fidelity

Scored 1.000 against the frozen reference `linear-description`. The last step required at least 0.800.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.18 | 0.1340 |
| model | 2 | 0.86 | 0.2827 |
| workflow | 2 | 0.50 | 0.2261 |
| seed | 2 | 1.07 | 0.2831 |
| tasks | 2 | 2.91 | 0.5345 |
| Total | 9 | 6.52 | 1.4604 |

Backtracks:

- `tasks` to `model`: 8 issues

Run total: 6.53 minutes, $1.4604.
