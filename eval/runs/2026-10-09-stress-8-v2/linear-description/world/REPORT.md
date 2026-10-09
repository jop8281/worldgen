# WorldGen report: Linear-style issue tracker (teams, issues, cycles, comments)

An issue tracker where teams own issues that move through a status lifecycle (backlog to done or canceled), get assigned to team members, and are scheduled into capacity-limited cycles (sprints).

## What was built

Entities (8):

- `team`: 3 seeded rows
- `member`: 12 seeded rows
- `cycle`: 7 seeded rows
- `issue`: 64 seeded rows
- `comment`: 40 seeded rows
- `project`: 0 seeded rows
- `issue_label`: 0 seeded rows
- `workflow_state`: 0 seeded rows

Routes (26):

- `list_teams`: GET /teams
- `get_team`: GET /teams/{id}
- `create_team`: POST /teams
- `list_members`: GET /members
- `create_member`: POST /members
- `list_cycles`: GET /cycles
- `get_cycle`: GET /cycles/{id}
- `create_cycle`: POST /cycles
- `list_issues`: GET /issues
- `get_issue`: GET /issues/{id}
- `create_issue`: POST /issues
- `update_issue`: PATCH /issues/{id}
- `list_comments`: GET /issues/{issue_id}/comments
- `create_comment`: POST /comments
- `list_projects`: GET /projects
- `get_project`: GET /projects/{id}
- `create_project`: POST /projects
- `update_project`: PATCH /projects/{id}
- `list_users`: GET /users
- `get_user`: GET /users/{id}
- `list_labels`: GET /labels
- `get_label`: GET /labels/{id}
- `create_label`: POST /labels
- `list_workflow_states`: GET /workflow_states
- `get_workflow_state`: GET /workflow_states/{id}
- `create_workflow_state`: POST /workflow_states

Actions (5):

- `assign_issue`: POST /issues/{id}/assign
- `start_issue`: POST /issues/{id}/start
- `complete_issue`: POST /issues/{id}/complete
- `cancel_issue`: POST /issues/{id}/cancel
- `add_to_cycle`: POST /issues/{id}/cycle

Jobs: none.

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s so time moves only explicitly
  - Why: Deterministic tests; seeded history precedes this date, cycles may be in the future
- A member belongs to exactly one team; role is admin or member
  - Why: Keeps permission checks simple
- Cycle capacity counts issues with that cycle_id regardless of status
  - Why: Simple scarce-resource model
- assignee_id, cycle_id, started_at, completed_at, canceled_at are readonly and set only by actions
  - Why: Ensures workflow actions are the only path
- No projects, labels, workspaces or auth in the model
  - Why: Scope kept small

## Questions asked of the input

- Should issues have labels and projects?
  - Default answer: No, out of scope.
- Can a member belong to several teams?
  - Default answer: No, exactly one team.
- Does canceled count toward cycle capacity?
  - Default answer: Yes, any issue with the cycle_id counts.

## Left out

- Projects, roadmaps, labels, sub-issues, GraphQL API, integrations
  - Why: Not needed for core issue workflow
- Authentication and notifications
  - Why: Not stateful records agents act on here

## Proof

The engine check passed: 5 world tests, 6 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_207eb819e0beaed27aec29b2d62f68e027459d4e4d0d5714bd7ecc39406b45cd`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| assign_login_bug | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 7/8 | `tid_054ff8e990e5a9dbcdcf93e5680ebe4b9c7bebc3e8452cf6c6dcfab7dc5dbaab` |
| start_urgent_billing | medium | 1.000 | 0.000 | 0.500, 0.500, 0.000 | 0.500 | declared (1); mutants 7/8 | `tid_fdaa1e38adea5e960d8214d3e717ac21316989827832ad9685851416f0fddce8` |
| fill_platform_cycle | hard | 1.000 | 0.000 | 0.650, 0.000, 0.300 | 0.700 | declared (2); mutants 6/8 | `tid_fff29d14746a3736f43ba1efbe0cfc8276cf423fab2ad2208fb17f3e78387b84` |
| cancel_duplicate_mobile | medium | 1.000 | 0.000 | 0.250, 0.000, 0.000 | 0.750 | declared (1); mutants 5/8 | `tid_d550e04cea71593620441060062047ef661df39c3c54d584fa2e5ebdb62396c6` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `assign_login_bug` 0.000: assigns the correct issue to Marta Lindqvist, another Platform member, instead of Dana Okafor
- `start_urgent_billing` 0.500: assigns a non-admin Billing member and starts the issue, so the assignee is not the named admin
- `start_urgent_billing` 0.500: assigns the other Billing admin, Hannah Sato, instead of Rahul Menon, then starts the issue
- `start_urgent_billing` 0.000: starts the urgent Billing backlog issue that already has an assignee instead of the unassigned one
- `fill_platform_cycle` 0.650: reads only the first page of issues, so it finds one urgent issue and leaves a free slot unfilled; the other urgent issue sits on a later page
- `fill_platform_cycle` 0.000: fills the free slots with the first todo Platform issues in id order instead of the highest priority ones
- `fill_platform_cycle` 0.300: schedules the right urgent issues into Platform Sprint 43, the later empty cycle, instead of the next cycle Platform Sprint 42
- `cancel_duplicate_mobile` 0.250: reads only a page of two Mobile backlog issues, so it cancels only the first dup issue and misses the others
- `cancel_duplicate_mobile` 0.000: ignores the team and cancels every backlog issue whose title starts with [dup], including the Platform one
- `cancel_duplicate_mobile` 0.000: ignores the status and cancels every Mobile [dup] issue it can, including the one that is in progress

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| assign_login_bug | easy | 1 | none | none | none declared |
| start_urgent_billing | medium | 1 | none | issue | distractors: met; state: met |
| fill_platform_cycle | hard | 3 | issue | cycle | hard: met; paging: met; distractors: met; state: met |
| cancel_duplicate_mobile | medium | 4 | none | issue | distractors: met; state: met; state: met |

## Fidelity

Scored 1.000 against the frozen reference `linear-description`. The last step required at least 0.800.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.92 | 0.1104 |
| model | 2 | 0.84 | 0.2258 |
| workflow | 2 | 0.39 | 0.1969 |
| seed | 2 | 1.25 | 0.2688 |
| tasks | 3 | 4.85 | 0.8432 |
| Total | 10 | 8.26 | 1.6451 |

Backtracks:

- `tasks` to `model`: 9 issues

Run total: 8.27 minutes, $1.6451.
