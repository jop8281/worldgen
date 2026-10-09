# WorldGen plan: Asana-style projects and tasks API

A to-do app where members work tasks grouped into projects. Tasks have an assignee and an optional due date and move through todo, in_progress and done. A project can be archived only when every one of its tasks is done. Feasible: the core value is stateful records that an agent reads and changes through an API with actions on them.

- Revision: 3
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `member` | A person who can be assigned tasks. Inactive members cannot take new assignments. | email |
| `project` | A named group of tasks. Its status is a state field that only archive_project moves to archived. | name, status |
| `task` | A unit of work inside one project, with an optional assignee and due date. Its status moves only through start_task and complete_task. | project_id, status, assignee_id, due_at |

## Workflows

### Project archive (project)
- States: active, archived
- Actions: archive_project
- Rules:
  - A project is archived only when every one of its tasks is done Enforced by: archive_project. Tested by: archive_refuses_open_tasks
  - Archived is final: the status transitions have no move out of archived Enforced by the data model: project.status is a state field whose transitions map gives archived no outgoing move
### Task progress (task)
- States: todo, in_progress, done
- Actions: start_task, assign_task, complete_task
- Rules:
  - A task can be assigned only to an active member Enforced by: assign_task. Tested by: assign_requires_active_member
  - Completing a task sets completed_at, and done is final Enforced by: complete_task. Tested by: complete_sets_completed_at
  - A task status changes only through start_task and complete_task Enforced by the data model: task.status is readonly, so update_task cannot set it, and the transitions map allows only todo to in_progress or done and in_progress to done
  - Starting a task moves it from todo to in_progress and a second start is refused Enforced by: start_task. Tested by: start_moves_task_to_in_progress

## Jobs

None. The plan declares no job.

## Acceptance tests

### archive_refuses_open_tasks
- Intent: archive_project refuses while a task is open and succeeds once every task is done
- Actions: archive_project, complete_task
- Description: Create a project and an open task. Archiving is refused with tasks_open. After completing the task, archiving succeeds, and a second archive is refused with already_archived.

```js
(ctx) => {
  const p = ctx.api('POST', '/projects', { name: 'Plan check archive gate' });
  ctx.assert(p.status === 201, 'create project returned ' + p.status);
  const t = ctx.api('POST', '/tasks', { project_id: p.body.id, title: 'Plan check open task' });
  ctx.assert(t.status === 201, 'create task returned ' + t.status);
  const early = ctx.api('POST', '/projects/' + p.body.id + '/archive');
  ctx.assert(early.status === 409 && early.body.error.code === 'tasks_open', 'archive with an open task: ' + early.status + ' ' + JSON.stringify(early.body));
  const done = ctx.api('POST', '/tasks/' + t.body.id + '/complete');
  ctx.assert(done.status === 200, 'complete returned ' + done.status);
  const ok = ctx.api('POST', '/projects/' + p.body.id + '/archive');
  ctx.assert(ok.status === 200 && ok.body.status === 'archived', 'archive after completion: ' + ok.status + ' ' + JSON.stringify(ok.body));
  const again = ctx.api('POST', '/projects/' + p.body.id + '/archive');
  ctx.assert(again.status === 409 && again.body.error.code === 'already_archived', 'second archive: ' + again.status + ' ' + JSON.stringify(again.body));
}
```
### assign_requires_active_member
- Intent: assign_task refuses an inactive member and accepts an active one
- Actions: assign_task
- Description: Create two members, deactivate one, then assign a task to each. The inactive one is refused with member_inactive and the active one succeeds.

```js
(ctx) => {
  const m = ctx.api('POST', '/members', { name: 'Plan Check Active', email: 'plan.check.active@probe.example' });
  ctx.assert(m.status === 201, 'create active member returned ' + m.status);
  const gone = ctx.api('POST', '/members', { name: 'Plan Check Inactive', email: 'plan.check.inactive@probe.example' });
  ctx.assert(gone.status === 201, 'create second member returned ' + gone.status);
  const off = ctx.api('PATCH', '/members/' + gone.body.id, { active: false });
  ctx.assert(off.status === 200 && off.body.active === false, 'deactivate returned ' + off.status);
  const p = ctx.api('POST', '/projects', { name: 'Plan check assignment' });
  const t = ctx.api('POST', '/tasks', { project_id: p.body.id, title: 'Plan check assign task' });
  ctx.assert(t.status === 201, 'create task returned ' + t.status);
  const bad = ctx.api('POST', '/tasks/' + t.body.id + '/assign', { assignee_id: gone.body.id });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'member_inactive', 'inactive member: ' + bad.status + ' ' + JSON.stringify(bad.body));
  const good = ctx.api('POST', '/tasks/' + t.body.id + '/assign', { assignee_id: m.body.id });
  ctx.assert(good.status === 200 && good.body.assignee_id === m.body.id, 'active member: ' + good.status + ' ' + JSON.stringify(good.body));
}
```
### complete_sets_completed_at
- Intent: complete_task marks a task done with a completion time and refuses a second completion
- Actions: complete_task
- Description: Create a task and complete it. The result is done with a completed_at string. A second completion is refused with already_done, and a read shows done.

```js
(ctx) => {
  const p = ctx.api('POST', '/projects', { name: 'Plan check completion' });
  const t = ctx.api('POST', '/tasks', { project_id: p.body.id, title: 'Plan check complete task' });
  ctx.assert(t.status === 201, 'create task returned ' + t.status);
  const r = ctx.api('POST', '/tasks/' + t.body.id + '/complete');
  ctx.assert(r.status === 200 && r.body.status === 'done', 'complete: ' + r.status + ' ' + JSON.stringify(r.body));
  ctx.assert(typeof r.body.completed_at === 'string', 'completed_at set, got ' + JSON.stringify(r.body.completed_at));
  const again = ctx.api('POST', '/tasks/' + t.body.id + '/complete');
  ctx.assert(again.status === 409 && again.body.error.code === 'already_done', 'second complete: ' + again.status + ' ' + JSON.stringify(again.body));
  const read = ctx.api('GET', '/tasks/' + t.body.id);
  ctx.assert(read.status === 200 && read.body.status === 'done', 'read after complete: ' + read.status + ' ' + JSON.stringify(read.body));
}
```
### project_tasks_filter_by_assignee
- Intent: the project task list filters by assignee and returns only that member's tasks from this project
- Actions: assign_task
- Description: Create a project with two tasks, assign one to a member, and list the project's tasks. Unfiltered returns both, and filtering by the assignee returns only the assigned task.

```js
(ctx) => {
  const m = ctx.api('POST', '/members', { name: 'Plan Check Filter', email: 'plan.check.filter@probe.example' });
  ctx.assert(m.status === 201, 'create member returned ' + m.status);
  const p = ctx.api('POST', '/projects', { name: 'Plan check filter' });
  const t1 = ctx.api('POST', '/tasks', { project_id: p.body.id, title: 'Plan check first' });
  const t2 = ctx.api('POST', '/tasks', { project_id: p.body.id, title: 'Plan check second' });
  ctx.assert(t1.status === 201 && t2.status === 201, 'create tasks');
  const a = ctx.api('POST', '/tasks/' + t1.body.id + '/assign', { assignee_id: m.body.id });
  ctx.assert(a.status === 200, 'assign returned ' + a.status);
  const all = ctx.api('GET', '/projects/' + p.body.id + '/tasks');
  ctx.assert(all.status === 200 && all.body.data.length === 2, 'unfiltered list: ' + all.status + ' ' + JSON.stringify(all.body));
  const mine = ctx.api('GET', '/projects/' + p.body.id + '/tasks?assignee_id=' + m.body.id);
  ctx.assert(mine.status === 200 && mine.body.data.length === 1 && mine.body.data[0].id === t1.body.id, 'filtered list: ' + JSON.stringify(mine.body));
}
```
### start_moves_task_to_in_progress
- Intent: start_task moves a todo task to in_progress and refuses to start it again
- Actions: start_task
- Description: Create a task, start it, and check in_progress. A second start is refused with invalid_state.

```js
(ctx) => {
  const p = ctx.api('POST', '/projects', { name: 'Plan check start' });
  const t = ctx.api('POST', '/tasks', { project_id: p.body.id, title: 'Plan check start task' });
  ctx.assert(t.status === 201 && t.body.status === 'todo', 'new task is todo: ' + JSON.stringify(t.body));
  const r = ctx.api('POST', '/tasks/' + t.body.id + '/start');
  ctx.assert(r.status === 200 && r.body.status === 'in_progress', 'start: ' + r.status + ' ' + JSON.stringify(r.body));
  const again = ctx.api('POST', '/tasks/' + t.body.id + '/start');
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second start: ' + again.status + ' ' + JSON.stringify(again.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_projects` | GET | /projects | Page through projects, filtered by status, searched by name. |
| `get_project` | GET | /projects/{id} | Read one project. |
| `create_project` | POST | /projects | Create an active project. |
| `update_project` | PATCH | /projects/{id} | Rename a project. Status is not writable here. |
| `list_project_tasks` | GET | /projects/{project_id}/tasks | Page through one project's tasks, filtered by status and assignee, sorted by due date. |
| `list_tasks` | GET | /tasks | Page through all tasks, filtered by project, status and assignee, searched by title. |
| `get_task` | GET | /tasks/{id} | Read one task. |
| `create_task` | POST | /tasks | Create a task in a project. It starts todo and unassigned. |
| `update_task` | PATCH | /tasks/{id} | Edit the title, notes or due date of a task. |
| `list_members` | GET | /members | Page through members, filtered by active, searched by name and email. |
| `get_member` | GET | /members/{id} | Read one member. |
| `create_member` | POST | /members | Create an active member. |
| `update_member` | PATCH | /members/{id} | Change a member's name or active flag. |

## Seed

- Rows per entity: member: 6, project: 6, task: 30
- Mix: Six members, four of them active, including Ana Ruiz (active) and one inactive member with a similar name (Ana Roiz) for the medium task's decoy. Six projects, four active and two archived, the archived two holding only done tasks. Thirty tasks, just over one list page, spread over the projects with due dates both before and after clock.start. Titles are plausible to-do items such as 'Renew SSL certificate' and 'Draft Q4 onboarding checklist'. The easy task's title also appears once in another project as a near-duplicate.
- State mix: project: active 67%, archived 33%; task: todo 35%, in_progress 30%, done 35%

## Tasks

- `complete_named_task` (easy): Mark done the open task 'Renew SSL certificate' in project 'Website relaunch'.
  - Actions: `complete_task`
  - Decoy idea: Completes the same-titled task in another project, the near-duplicate the seed plants.
  - Pressure: seeded rows in task.todo; distractor rows of task
- `assign_active_member_in_project` (medium, permissions): Assign the todo task 'Draft Q4 onboarding checklist' in project 'Operations' to the active member Ana Ruiz, not the inactive duplicate with a similar name.
  - Actions: `assign_task`
  - Decoy idea: Assigns the inactive duplicate (Ana Roiz) or the first member in the list without checking that the member is active.
  - Pressure: seeded rows in task.todo
- `close_out_project` (hard, irreversible): Close out project 'Website relaunch': complete every task in it that is not done, then archive the project. Change nothing in other projects.
  - Actions: `complete_task`, `archive_project`
  - Decoy idea: Archives the project before completing its open tasks, or marks the project archived by PATCH and skips the completion of its tasks.
  - Pressure: seeded rows in project.active, task.in_progress

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

None. The plan changes no existing item.
