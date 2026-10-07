# WorldGen report: Todoist/Asana-style to-do app (projects, tasks, assignees, due dates)

A small team to-do app. Members own tasks inside projects. Tasks move todo, in_progress, done, and each has an optional assignee and due date. A job flags overdue tasks as time passes. A project is active or archived. It can be archived only when every task in it is done, and an archived project is frozen until it is unarchived.

## What was built

Entities (3):

- `member`: 8 seeded rows
- `project`: 14 seeded rows
- `task`: 130 seeded rows

Routes (11):

- `list_projects`: GET /projects
- `get_project`: GET /projects/{id}
- `create_project`: POST /projects
- `update_project`: PATCH /projects/{id}
- `list_members`: GET /members
- `get_member`: GET /members/{id}
- `create_member`: POST /members
- `update_member`: PATCH /members/{id}
- `list_tasks`: GET /tasks
- `get_task`: GET /tasks/{id}
- `list_project_tasks`: GET /projects/{project_id}/tasks

Actions (8):

- `create_task`: POST /tasks
- `update_task`: PATCH /tasks/{id}
- `assign_task`: POST /tasks/{id}/assign
- `start_task`: POST /tasks/{id}/start
- `complete_task`: POST /tasks/{id}/complete
- `reopen_task`: POST /tasks/{id}/reopen
- `archive_project`: POST /projects/{id}/archive
- `unarchive_project`: POST /projects/{id}/unarchive

Jobs (1):

- `flag_overdue`: every 1h

## Assumed and why

- Only a task in status done counts as done for archiving. There is no cancelled state, and in_progress and todo block archiving.
  - Why: The input says 'all of its tasks are done'. A single completion state keeps the rule unambiguous.
- A project with zero tasks can be archived.
  - Why: The rule 'all tasks done' is vacuously true. The refusal message for a blocked archive tells the caller how many tasks are not done.
- Project status and task status are readonly on PATCH. Status moves only through the archive_project, unarchive_project, start_task, complete_task and reopen_task actions.
  - Why: A plain PATCH cannot check another entity, so archive-only-when-done must live in a handler. The same applies to the archived-project freeze on tasks.
- An archived project is frozen: create_task, update_task, assign_task, start_task, complete_task and reopen_task all return 409 project_archived for its tasks. Unarchiving makes the project writable again.
  - Why: This is the usual meaning of archive. It also keeps the invariant that an archived project has only done tasks.
- The assignee is a single member. Only active members can be assigned. Deactivating a member does not unassign their existing tasks.
  - Why: Single assignee matches the input. Cascading unassignment would add scope the input does not ask for.
- due_at is a datetime, stored as a UTC timestamp, with no separate date type.
  - Why: The world format has only datetime. Due dates are seeded at end-of-day UTC.
- The hourly job flag_overdue sets is_overdue=true on tasks that are not done and past due_at, and sets it back to false when a task is done or its due date moves to the future. A done task is never overdue.
  - Why: It gives due dates a time-driven effect. Tasks can only read the seeded state because they cannot advance the clock.
- Single workspace, no authentication, no current-user concept. The caller is told who to assign through ids.
  - Why: The input mentions none, and it keeps the API surface small.
- No delete routes for projects, tasks or members. Archive and deactivation are the ways to retire them.
  - Why: The input has archive as the retirement path, and deletion would bypass the archive invariant.
- The clock starts at 2026-10-06T09:00:00Z with tick 0s unless an action sets a duration.
  - Why: Explicit time keeps due dates, overdue flags and graders deterministic.

## Questions asked of the input

- Can a project with no tasks be archived?
  - Default answer: Yes. 'All tasks done' is vacuously true for an empty project.
- Do cancelled or deleted tasks count as done for the archive rule?
  - Default answer: There is no cancelled state. Only status done counts.
- Can an archived project be restored, and may its tasks change while archived?
  - Default answer: It can be restored with unarchive_project. Its tasks are frozen while it is archived.
- Can a task have more than one assignee?
  - Default answer: No. One nullable assignee.
- Should the app have users, logins or a 'my tasks' view?
  - Default answer: No. A single workspace with no authentication.
- Are due dates dates or timestamps, and is there overdue behaviour?
  - Default answer: UTC timestamps. An hourly job flags open tasks past due as is_overdue.
- Can projects, tasks or members be deleted?
  - Default answer: No. Retirement is archive for projects and active=false for members.

## Left out

- Authentication, permissions and per-user views such as 'my tasks'
  - Why: The input defines no users or roles.
- Subtasks, dependencies, labels, comments, attachments and recurring tasks
  - Why: The input names only projects, tasks, assignees and due dates.
- Notifications, reminders and email
  - Why: The overdue job only flags tasks. Delivery is outside the world's API.
- Deleting projects, tasks or members
  - Why: Archive and unarchive cover retirement. Deletion would bypass the archive rule.
- Multiple assignees, teams and workspaces
  - Why: The input has one assignee per task and a single workspace.
- Time zones and recurring due dates
  - Why: All times are UTC.

## Proof

The engine check passed: 5 world tests, 2 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| assign_team_lunch_task | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a |
| archive_q3_launch_project | medium | 1.000 | 0.000 | 0.400, 0.000, 0.000 | 0.400 |
| archive_all_finished_projects | hard | 1.000 | 0.000 | 0.750, 0.000, 0.000, 0.250 | 0.750 |

Decoys:

- `assign_team_lunch_task` 0.000: assigns the task to the other member who shares the first name, Priya Shah
- `assign_team_lunch_task` 0.000: assigns the right member but also starts the task, changing its status beyond what was asked
- `archive_q3_launch_project` 0.400: completes the open task but never archives the project
- `archive_q3_launch_project` 0.000: archives the similarly named Q3 Marketing Planning project, which is already finished, instead of Q3 Marketing Launch
- `archive_q3_launch_project` 0.000: finishes and archives Q3 Marketing Launch but also completes the open tasks of Office Operations, touching another project
- `archive_all_finished_projects` 0.750: skips active projects with no tasks, treating 'no done tasks' as not finished
- `archive_all_finished_projects` 0.000: completes every open task in every active project so that all of them can be archived
- `archive_all_finished_projects` 0.000: archives the finished projects but also completes the single open task of Q3 Marketing Launch to archive it too
- `archive_all_finished_projects` 0.250: only archives the first finished project it finds and stops

## Run

Mode: create from description. Model: claude-sonnet-5-5 over the claude -p transport. Budget: $3.50.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.82 | 0.0785 |
| model | 1 | 0.26 | 0.0560 |
| workflow | 1 | 1.86 | 0.2290 |
| seed | 2 | 1.25 | 0.2867 |
| tasks | 2 | 1.51 | 0.3468 |
| Total | 7 | 5.70 | 0.9969 |

Run total: 5.74 minutes, $0.9969.

## Post-generation timeline correction

The original artifact used January 5, 2026 while its plan and report declared October 6, 2026. The world now honors the declared clock. Seed timestamp anchors moved forward by 274 days so row identities, state mix, relative ages, due-date distances and overdue flags remain the same. A seed chronology test checks creation, update, completion and archive ordering. Existing generation events, model time and costs remain historical evidence; this correction is not a new model generation.
