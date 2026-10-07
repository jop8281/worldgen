Stopped: no_progress

The tasks step made no progress: the same issues came back.

No world.yaml was written.

Last issues:

- `task.pressure_unmet` at `tasks.archive_all_finished_projects`: The reference trace or the seed does not show it. Seed what the task needs, make the reference reach it, or drop the claim from the plan's pressure for archive_all_finished_projects.

## What was built

Nothing was handed over: the run stopped.

## Changes

No changes.

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
- Each task's allows list is derived from its instruction, not from its solution. Engine timestamps and job changes are exempt from allows. Fields in allows are the ones the permitted actions (assign_task, complete_task, archive_project) can write: assignee_id for assign_task; status, completed_at and is_overdue for complete_task; status and archived_at for archive_project.
  - Why: The change request asks for allows on every task, grounded in what the instruction permits, so any other write scores 0.
- Only tasks and workflows' wording changes in this revision: the three task intents now state their allows entries. No entity, route, action, job, seed or test changes.
  - Why: The request says to change nothing else in the world.

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
- For the medium task, should the allows list for tasks be limited to the one open task?
  - Default answer: The allows entry covers task rows of that project and the fields complete_task writes. The grader's own guard narrows the change to the single open task.

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
- Changes to entities, routes, actions, jobs, seed rows or acceptance tests
  - Why: The request only adds allows lists to the tasks.

## Proof

None. The run stopped, so this report claims no verified task.

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $8.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.57 | 0.2924 |
| tasks | 2 | 0.65 | 0.4779 |
| Total | 3 | 1.22 | 0.7704 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures

Run total: 1.30 minutes, $0.7704.
