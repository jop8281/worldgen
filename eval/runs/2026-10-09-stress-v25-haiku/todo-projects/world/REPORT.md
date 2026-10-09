# WorldGen report: Asana-style projects and tasks API

A to-do app where members work tasks grouped into projects. Tasks have an assignee and an optional due date and move through todo, in_progress and done. A project can be archived only when every one of its tasks is done. Feasible: the core value is stateful records that an agent reads and changes through an API with actions on them.

## What was built

Entities (3):

- `member`: 6 seeded rows
- `project`: 6 seeded rows
- `task`: 30 seeded rows

Routes (13):

- `list_projects`: GET /projects
- `get_project`: GET /projects/{id}
- `create_project`: POST /projects
- `update_project`: PATCH /projects/{id}
- `list_project_tasks`: GET /projects/{project_id}/tasks
- `list_tasks`: GET /tasks
- `get_task`: GET /tasks/{id}
- `create_task`: POST /tasks
- `update_task`: PATCH /tasks/{id}
- `list_members`: GET /members
- `get_member`: GET /members/{id}
- `create_member`: POST /members
- `update_member`: PATCH /members/{id}

Actions (4):

- `archive_project`: POST /projects/{id}/archive
- `start_task`: POST /tasks/{id}/start
- `assign_task`: POST /tasks/{id}/assign
- `complete_task`: POST /tasks/{id}/complete

Jobs: none.

## Assumed and why

- Mirror an Asana-style projects and tasks API.
  - Why: The input names projects and tasks with assignees and due dates, which matches that product shape without a separate sections or subtasks model.
- clock.start is 2026-10-09T09:00:00.000Z with tick 1s.
  - Why: Today's date is the latest known fact, the world has no imported history, and a 1s tick keeps timestamps distinct.
- Archiving needs every task in the project to be done, and a project with no tasks may be archived.
  - Why: The input says archive only when all tasks are done. Zero tasks has nothing open, so it passes.
- status is readonly on project and task. Only archive_project, start_task and complete_task move it.
  - Why: Without this a PATCH could archive a project or finish a task and skip the rule.
- assignee_id is readonly on task and set only by assign_task.
  - Why: Keeps the assignment rule on the action, so create and update cannot bypass the active-member check.
- Archived projects hold only done tasks in the seed, and no action unarchives them.
  - Why: Keeps the seed consistent with the archive rule and the archived state final.
- due_at is an optional datetime on task, and no job raises reminders.
  - Why: Due dates are asked for as data. Overdue notifications would need a job with no request backing it.
- Member email is unique, and create_member and update_member enforce it through the data model.
  - Why: Matches how members are identified and keeps the seed and tests from colliding on emails.
- The medium task's pressure claims only task.todo; the distractors claim on member is dropped, and the inactive similar-named member (Ana Roiz) is seeded so the decoy is plausible.
  - Why: The reference solution reads no filtered member list that returns a row it leaves unchanged, so the distractors claim could not be shown. The decoy still works on the seeded inactive duplicate.

## Questions asked of the input

- Which real product should the world mirror?
  - Default answer: An Asana-style projects and tasks API.
- Can a project be archived while some tasks are still open?
  - Default answer: No. Every task must be done. A project with no tasks may be archived.
- Can an archived project be unarchived, or receive new tasks?
  - Default answer: Archived is final and no unarchive action exists. Adding tasks to an archived project is left unguarded and listed as out of scope.
- Do members log in, and who may complete or assign tasks?
  - Default answer: No. Members are records, and any caller may act on any task.
- Should overdue tasks trigger reminders?
  - Default answer: No. Due dates are stored data only.

## Left out

- Unarchiving a project
  - Why: The request says archived is the end of the archive step and gives no way back.
- Refusing new tasks in an archived project
  - Why: No action enforces it, and create_task is a plain route, so the rule would be unchecked. Left as a known gap.
- Overdue reminders and due-date notifications
  - Why: The request mentions due dates but no alerting, and a job with no request behind it would add untested behavior.
- Accounts, login and permissions per member
  - Why: Members are plain records here. The request does not ask who may act.
- Subtasks, sections, comments and attachments
  - Why: Not in the request. Adding them would widen the world beyond the core value.

## Proof

The engine check passed: 5 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_e3d9d54fe71f7383a8ac51b5c2f5041843a50a3df739410a8341de57b3b1d708`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| complete_named_task | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 5/8 | `tid_c76b18f6d01459b8cd02b719e2dce5e69374d5021e7d6da0c3a2e1daa1e9f40c` |
| assign_active_member_in_project | medium | 1.000 | 0.000 | 0.500 | n/a | declared (1); mutants 7/8 | `tid_774ec89000ca0cf217ac6ffc29005c861fb204f60253754995306be0d5ffdefc` |
| close_out_project | hard | 1.000 | 0.000 | 0.500, 0.000, 0.000 | 0.500 | declared (2); mutants 5/8 | `tid_39a7ac84fced4e92f2f4db0a314796a6ce679721de1ddfa04add600b8d42a5c3` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `complete_named_task` 0.000: completes the same-titled task in Mobile app v3, the near-duplicate the seed plants, and leaves the Website relaunch task open
- `assign_active_member_in_project` 0.500: tries the inactive duplicate Ana Roiz, which is refused with member_inactive, then assigns the last active member on the list, Elena Ruiz, instead of Ana Ruiz
- `close_out_project` 0.500: completes the open tasks of Website relaunch but never archives the project
- `close_out_project` 0.000: completes only the in_progress tasks, then tries to archive, which is refused while the todo tasks stay open
- `close_out_project` 0.000: closes out Website relaunch but also completes the open tasks of Operations, which it was not asked to touch

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| complete_named_task | easy | 1 | none | task | distractors: met; state: met |
| assign_active_member_in_project | medium | 1 | none | task | state: met |
| close_out_project | hard | 5 | none | project | hard: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Asana-style projects and tasks API, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 3 | 2.29 | 0.0244 |
| model | 3 | 0.85 | 0.0163 |
| workflow | 2 | 0.42 | 0.0094 |
| seed | 2 | 1.41 | 0.0155 |
| tasks | 3 | 3.06 | 0.0365 |
| Total | 13 | 8.04 | 0.1022 |

Backtracks:

- `tasks` to `plan`: 1 issue

Run total: 8.05 minutes, $0.1022.
