# WorldGen plan: Todoist/Asana-style to-do app (projects, tasks, assignees, due dates)

A small team to-do app. Members own tasks inside projects. Tasks move todo, in_progress, done, and each has an optional assignee and due date. A job flags overdue tasks as time passes. A project is active or archived. It can be archived only when every task in it is done, and an archived project is frozen until it is unarchived.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `member` | A person who can be assigned tasks. | name, email (unique), active (bool) |
| `project` | A container of tasks. Status is active or archived and is changed only by the archive and unarchive actions. | name, description, status (state: active\|archived, readonly), archived_at (readonly, nullable), owner_id (ref member, nullable) |
| `task` | A unit of work in one project. It has an optional assignee and due date, and moves through todo, in_progress and done. | project_id (ref project), title, description, priority (low\|normal\|high\|urgent), status (state: todo\|in_progress\|done, readonly), assignee_id (ref member, nullable, readonly), due_at (datetime, nullable), is_overdue (bool, readonly), completed_at (readonly, nullable) |

## Workflows

### project_lifecycle (project)
- States: active, archived
- Actions: archive_project, unarchive_project
- Rules:
  - A project starts active.
  - archive_project works only on an active project and only if every task in it has status done. Otherwise it returns 409 with code open_tasks and the number of tasks not done. A project with no tasks may be archived.
  - archive_project sets archived_at to now. unarchive_project clears it.
  - unarchive_project works only on an archived project and returns it to active.
  - Archiving an archived project, or unarchiving an active one, returns 409 invalid_state.
  - Status is readonly, so a PATCH cannot change it.
### task_lifecycle (task)
- States: todo, in_progress, done
- Actions: create_task, update_task, assign_task, start_task, complete_task, reopen_task
- Rules:
  - A task starts todo in an active project.
  - Allowed moves: todo to in_progress, todo to done, in_progress to todo (not exposed), in_progress to done, and done to todo through reopen_task.
  - Every task action returns 409 project_archived when the task's project is archived.
  - complete_task sets completed_at to now and is_overdue to false.
  - reopen_task clears completed_at and recomputes is_overdue from due_at and the current time.
  - assign_task takes a nullable member_id. It refuses an inactive or unknown member with 409 or 422. It refuses a done task with 409 invalid_state. It refuses an assignee equal to the current one with 409 no_change.
  - update_task edits title, description, priority and due_at. It is refused for a done task.
  - create_task requires project_id and title, and refuses an archived project. It also takes optional assignee_id, due_at and priority.

## Jobs

- `flag_overdue` runs every 1h: For every task whose status is not done and whose due_at is set and earlier than now, set is_overdue true. For every task that is done, or has no due_at, or has a due_at not yet passed, set is_overdue false. Write only rows whose value changes. It does not touch tasks of archived projects, which are all done anyway.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_projects` | GET | /projects | List projects. Filter by status or owner_id, search by name, sort by name or created_at. |
| `get_project` | GET | /projects/{id} | Fetch one project. |
| `create_project` | POST | /projects | Create a project. It starts active. |
| `update_project` | PATCH | /projects/{id} | Edit name, description or owner. Status stays readonly. |
| `list_members` | GET | /members | List members. Filter by active, search by name or email. |
| `get_member` | GET | /members/{id} | Fetch one member. |
| `create_member` | POST | /members | Create a member. |
| `list_tasks` | GET | /tasks | List tasks. Filter by project_id, assignee_id, status, priority or is_overdue, search by title, sort by due_at or created_at. pageSize 25. |
| `get_task` | GET | /tasks/{id} | Fetch one task. |
| `list_project_tasks` | GET | /projects/{project_id}/tasks | List the tasks of one project, with the same filters as list_tasks. |
| `create_task` | POST | /tasks | Action. Create a task in an active project. It starts as todo. |
| `update_task` | PATCH | /tasks/{id} | Action. Edit title, description, priority or due_at while the project is active. |
| `assign_task` | POST | /tasks/{id}/assign | Action. Set or clear the assignee. The member must be active. |
| `start_task` | POST | /tasks/{id}/start | Action. Move a todo task to in_progress. |
| `complete_task` | POST | /tasks/{id}/complete | Action. Mark a todo or in_progress task done. |
| `reopen_task` | POST | /tasks/{id}/reopen | Action. Move a done task back to todo. It is refused if the project is archived. |
| `archive_project` | POST | /projects/{id}/archive | Action. Archive an active project only if every task in it is done. |
| `unarchive_project` | POST | /projects/{id}/unarchive | Action. Make an archived project active again. |

## Seed

- Rows per entity: member: 8, project: 14, task: 130
- Mix: Members: 7 active and 1 inactive. Projects: about 55% active and 45% archived. Among the active ones, 3 are fully done and so archivable, 1 has no tasks, and the rest have between 1 and 6 open tasks. Every task of an archived project is done. Tasks: about 35% todo, 30% in_progress and 35% done. About 70% of tasks have an assignee. About 80% have a due date, and open tasks with a past due date have is_overdue true. Priorities are spread low 25%, normal 45%, high 22%, urgent 8%. Some tasks have near-duplicate titles across projects. At least one active project has more than 25 tasks, so listing needs paging. Anchor rows: a project 'Q3 Marketing Launch' that has exactly one open task, and a task 'Order team lunch' that is unassigned. Member names include two members who share a first name.

## Tasks

- `assign_team_lunch_task` (easy): Assign the unassigned task 'Order team lunch' to the member Priya Raman. Two members share the first name Priya, so the agent must look up the right one. Success is that task's assignee_id equal to the right member and nothing else changed.
  - Decoy idea: Assign it to the other Priya, or to the first member returned by a search for 'Priya'.
- `archive_q3_launch_project` (medium): Archive the project 'Q3 Marketing Launch'. It has exactly one open task, so the agent must find it and complete it first, then archive. The end state is the project archived, that one task done, and no other task or project touched.
  - Decoy idea: Complete every task of a similarly named project, or try to PATCH the status to archived, which fails. Another wrong path is to complete all of the project's tasks including ones already done, or to complete the task and never archive.
- `archive_all_finished_projects` (hard): Archive every active project whose tasks are all done, including the project with no tasks. Leave projects with any open task alone and do not complete any task. The agent must page through tasks, since one active project has more than 25 of them. The grader checks that exactly the right set of projects is archived and that no task changed.
  - Decoy idea: Read only the first page of tasks per project and wrongly judge a large project finished. Or complete the open tasks first so every project can be archived. Or skip the empty project. Or archive only the projects that have at least one done task.

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

None. The plan changes no existing item.
