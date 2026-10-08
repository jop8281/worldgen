# WorldGen plan: Linear-style issue tracker (Linear issues, projects, milestones and labels, exposed as a REST API)

A single-team issue tracker seeded from a real 123-issue Linear backlog (team key YOS, project WorldGen). Issues move through Backlog, In Progress, In Review, Done, Canceled and Duplicate. They carry a priority, a project, a milestone, labels, an optional parent and a completion time. Agents triage, move, relabel, re-milestone, close out and de-duplicate issues. Status changes go through actions that enforce the workflow rules and write an audit history. Two jobs auto-close parents and archive old done issues.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-07T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `team` | The workspace team that owns issues and issue numbering. One row, key YOS. next_number is the counter create_issue uses. | key, name, next_number |
| `project` | A project issues belong to. The CSV has one, WorldGen. Issues with no project are allowed. | name, status, description |
| `milestone` | A named delivery stage (D1 .. D8, R1, R2, Later). Many issues share one milestone and a milestone may have none. Two milestones share the code R1, so code is not unique. sort_order keeps the roadmap order. | name, code, sort_order, project_id |
| `label` | A tag such as factory, kind:decision or area:infra. Built by splitting the CSV labels column on '; '. group is the part before ':' when there is one. | name, group |
| `issue` | The core record. identifier is TEAM-number (YOS-1) and the engine id is iss_NNNN. Fields: title, description, status (state), priority (nullable, no priority allowed), team_id, project_id, milestone_id, parent_id (sub-issue), duplicate_of_id, completed_at, archived_at. identifier, number, status, parent_id, duplicate_of_id, completed_at and archived_at are readonly and set only by actions, jobs and seed. | identifier, number, title, status, priority, project_id, milestone_id, parent_id, duplicate_of_id, completed_at, archived_at |
| `issue_label` | Join row attaching a label to an issue. Unique per (issue, label), enforced by the add_label action. | issue_id, label_id |
| `comment` | A discussion note on an issue. Linear's CSV export has none, so the seed writes a small believable set of them. | issue_id, body |
| `issue_event` | Append-only history of what happened to an issue (created, status_changed, priority_changed, milestone_changed, label_added, label_removed, parent_changed, commented, archived). Written by actions and jobs. | issue_id, kind, from_value, to_value |

## Workflows

### issue_lifecycle (issue)
- States: backlog, in_progress, in_review, done, canceled, duplicate
- Actions: create_issue, start_issue, request_review, complete_issue, cancel_issue, mark_duplicate, reopen_issue, set_parent, add_label, remove_label
- Rules:
  - New issues start in backlog with completed_at null, via create_issue only. The action takes number = team.next_number, builds identifier = key + '-' + number, bumps next_number and writes a created event.
  - Transitions: backlog to in_progress, canceled, duplicate. in_progress to backlog, in_review, done, canceled, duplicate. in_review to in_progress, done, canceled, duplicate. done to in_progress. canceled and duplicate to backlog. The engine enforces this on every write.
  - start_issue works only from backlog. request_review only from in_progress. complete_issue from in_progress or in_review. A wrong source status gives 409 invalid_state.
  - complete_issue, cancel_issue and mark_duplicate set completed_at to the call time. reopen_issue clears completed_at and duplicate_of_id.
  - complete_issue is refused with 409 open_sub_issues if any sub-issue is still backlog, in_progress or in_review. Close the children first.
  - mark_duplicate needs duplicate_of_id naming a different issue that is not itself a duplicate, else 409 or 422. The original is not changed.
  - cancel_issue takes an optional reason, which becomes a comment on the issue.
  - reopen_issue sends done back to in_progress, and canceled and duplicate back to backlog. A backlog, in_progress or in_review issue cannot be reopened.
  - set_parent rejects self-parenting and cycles with 409. Clearing the parent is allowed. Moving a child under a parent that is already done is refused.
  - add_label returns 409 if the label is already attached. remove_label returns 404 if it is not.
  - Every status, priority, milestone, parent and label change writes one issue_event with from_value and to_value. PATCH changes to priority and milestone_id write their events through update_issue's own logic, which the model stage must cover by making priority and milestone changes go through the event-writing action or accepting plain PATCH without history (the model stage decides and records it).
  - Jobs: auto_close_parents (every 1h) marks a parent in in_progress or in_review as done when it has sub-issues, all closed, and at least one done. auto_archive_done (every 1d) sets archived_at on done issues completed over 30 days ago.

## Jobs

None. The plan declares no job.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_issues` | GET | /issues | List issues. Filters: status, priority, project_id, milestone_id, parent_id, duplicate_of_id. Search: title and description. Sort: created_at, updated_at, completed_at, number. Cursor paging, 25 per page. |
| `get_issue` | GET | /issues/{id} | Fetch one issue by engine id. |
| `create_issue` | POST | /issues | Built as an action, not a plain create. Allocates the next YOS-number from team.next_number, starts the issue in backlog and writes a created event. |
| `update_issue` | PATCH | /issues/{id} | Edit title, description, priority, project_id and milestone_id. Readonly fields (status, parent, completion) are refused. |
| `list_sub_issues` | GET | /issues/{parent_id}/children | List the sub-issues of a parent issue. |
| `list_issue_labels` | GET | /issues/{issue_id}/labels | List the label attachments of an issue. |
| `list_issue_comments` | GET | /issues/{issue_id}/comments | List the comments on an issue. |
| `create_comment` | POST | /issues/{issue_id}/comments | Add a comment to an issue. |
| `update_comment` | PATCH | /comments/{id} | Edit a comment body. |
| `delete_comment` | DELETE | /comments/{id} | Delete a comment. |
| `list_issue_events` | GET | /issues/{issue_id}/history | List the audit history of an issue, oldest first or by created_at sort. |
| `list_projects` | GET | /projects | List projects. |
| `get_project` | GET | /projects/{id} | Fetch one project. |
| `list_milestones` | GET | /milestones | List milestones. Filter: project_id. Sort: sort_order. |
| `get_milestone` | GET | /milestones/{id} | Fetch one milestone. |
| `update_milestone` | PATCH | /milestones/{id} | Rename or reorder a milestone. |
| `list_labels` | GET | /labels | List labels. Filter: group. Search: name. |
| `get_label` | GET | /labels/{id} | Fetch one label. |
| `create_label` | POST | /labels | Create a label. The name must be unique. |
| `list_teams` | GET | /teams | List teams (one). |
| `start_issue` | POST | /issues/{id}/start | Action. backlog to in_progress. |
| `request_review` | POST | /issues/{id}/review | Action. in_progress to in_review. |
| `complete_issue` | POST | /issues/{id}/complete | Action. in_progress or in_review to done. Sets completed_at. Refused while a sub-issue is still open. |
| `cancel_issue` | POST | /issues/{id}/cancel | Action. Any open status to canceled. Sets completed_at. Optional reason becomes a comment. |
| `mark_duplicate` | POST | /issues/{id}/duplicate | Action. Any open status to duplicate. Needs duplicate_of_id, which must be another issue that is not itself a duplicate. Sets completed_at. |
| `reopen_issue` | POST | /issues/{id}/reopen | Action. done goes back to in_progress. canceled and duplicate go back to backlog. Clears completed_at and duplicate_of_id. |
| `set_parent` | POST | /issues/{id}/parent | Action. Set or clear parent_id, with no self-parent and no cycles. |
| `add_label` | POST | /issues/{id}/labels | Action. Attach an existing label to an issue. 409 if already attached. |
| `remove_label` | DELETE | /issues/{id}/labels/{label_id} | Action. Detach a label from an issue. |

## Seed

- Rows per entity: team: 1, project: 1, milestone: 12, label: 16, issue: 123, issue_label: 170, comment: 60, issue_event: 420
- Mix: Issues come from the imported linear_backlog fixture and keep its status, priority, milestone, label and parent mix as is. Status counts are not forced. Done is the largest group, and 33% of rows have no completed time, which matches the open ones. Priority has about 3% empty values. 7% have no project and 18% no milestone. Three parents (YOS-91, YOS-105, YOS-114) have the only sub-issues, about 2% of rows. Comments, history events and ids are derived from the fixture rows with the seeded rng. Every row has created_at <= updated_at < 2026-10-07T09:00:00Z, because the imported rows end on 2026-10-06 23:18 UTC.

## Tasks

- `start_the_welcome_issue` (easy): Find the one backlog issue titled 'Get familiar with Linear' (or the seed's equivalent single backlog onboarding issue the seed stage pins) and move it to In Progress. Nothing else may change. The grader checks status = in_progress and that only that issue and its own history events changed.
  - Decoy idea: Moves a different issue with a similar 'Get familiar' style title, or PATCHes status (refused) and then cancels it instead of starting it.
- `cancel_stale_backlog_in_milestone` (medium): Cancel every Backlog issue in the milestone named in the instruction (a seeded later-stage milestone such as 'Later: Fidelity and factory operations') that carries the label named in the instruction (such as 'factory'). Give a reason. Leave issues in other milestones, issues with other statuses and issues with a different label alone. The list spans more than one page, so the agent has to read milestones and labels first and then page issues and issue_labels.
  - Decoy idea: Cancels every backlog issue in that milestone and ignores the label, or filters by label but reads only page 1, or cancels the issues in all milestones with that label.
- `close_out_epic_with_sub_issues` (hard): Close out the parent issue YOS-91 (a seeded parent that has open sub-issues): complete each sub-issue that is in_review or in_progress, cancel each sub-issue still in backlog with a reason, then complete the parent. complete_issue on the parent is refused until every child is closed, so order matters. The grader checks the ending statuses, that no unrelated issue changed, and through ctx.trace that every child was closed before the parent was completed.
  - Decoy idea: Tries to complete the parent first and gives up after the 409, completes the children but skips the backlog ones so the parent stays open, or cancels all the children, which loses the done work.
- `merge_duplicate_issues` (hard): Two non-closed issues that the seed pins carry near-identical titles. Mark the newer one as a duplicate of the older one, and copy its labels onto the older one that are not there yet. The older issue keeps its status and priority. The grader checks status = duplicate with duplicate_of_id equal to the older issue, the label union on the older issue, and that no other issue changed.
  - Decoy idea: Marks the older issue as the duplicate of the newer one, cancels the newer issue instead of using mark_duplicate, or marks the duplicate and forgets to merge labels.

## Open questions

- Should the world model users and assignees even though the CSV has none?
  - Default answer: No. The world has no user entity and issues have no assignee.
- What is the clock start, given that the data ends on 2026-10-06T23:18Z?
  - Default answer: 2026-10-07T09:00:00Z with a 1s tick.
- Do canceled and duplicate issues get a completed time?
  - Default answer: Yes. Done, canceled and duplicate all set completed_at, which fits the 33% null rate.
- How should an empty priority be stored?
  - Default answer: As null, meaning 'No priority'. It is not invented as a fifth enum value.
- Is the labels column a list of tags or one tag per issue?
  - Default answer: A list split on ';'. Each tag becomes a label row with a join row, and the part before ':' is the group.
- May a parent be completed while sub-issues are still open?
  - Default answer: No. complete_issue returns 409 open_sub_issues. The auto_close_parents job closes parents once their children are closed.
- Can the status be changed by a plain PATCH?
  - Default answer: No. Status is readonly, so only the lifecycle actions can change it.
- Should issue history be written for plain PATCH edits to priority and milestone?
  - Default answer: Yes where possible. The model stage may route priority and milestone edits through actions if PATCH cannot write history, and records the choice.
- Is there a source OpenAPI spec to match?
  - Default answer: No. Only the CSV was given, so the REST shape is designed here.

## Assumptions

- clock.start is 2026-10-07T09:00:00.000Z and clock.tick is 1s.
  - Why: The latest imported timestamp is 2026-10-06T23:18:05Z, so the world starts the next morning, after all historical events. A 1s tick gives each committed call a distinct, deterministic timestamp. The jobs have no future scheduled events before the start.
- The world is a REST mirror of Linear, not GraphQL. Engine ids are iss_0001 style, and the Linear identifier (YOS-1) is kept in issue.identifier plus issue.number.
  - Why: The engine builds REST routes with idPrefix ids. The identifier is unique and filterable via search.
- Issue ids are assigned by identifier number order, so YOS-1 is iss_0001 where the numbers are dense. The seed resolves parent_id by looking up the identifier, not by guessing the id.
  - Why: Parents must be seeded before their children, and a child may have a lower number than its parent. The seed stage orders self-referencing rows with parents first.
- Status values map to snake_case states: Backlog=backlog, In Progress=in_progress, In Review=in_review, Done=done, Canceled=canceled, Duplicate=duplicate.
  - Why: State names must match ^[a-z][a-z0-9_]*$. The CSV values map one to one.
- Status transitions: backlog to in_progress, canceled or duplicate. in_progress to backlog, in_review, done, canceled or duplicate. in_review to in_progress, done, canceled or duplicate. done to in_progress. canceled and duplicate to backlog.
  - Why: The CSV carries no transition history, so this is the usual Linear flow. Reopening needs a legal path back.
- completed_at is set for done, canceled and duplicate issues, and cleared on reopen.
  - Why: About 33% of CSV rows have no completed time. Those would be the active statuses (backlog, in_progress, in_review), so all three terminal statuses must carry one.
- Empty priority is stored as null and means 'No priority'. The priority enum values are urgent, high, medium and low.
  - Why: 3% of CSV priorities are null. Linear's 'No priority' is a real state, so it is not invented as a value.
- Empty project and empty milestone stay null. The one project is WorldGen, and the 12 distinct milestone strings become 12 milestone rows, including the two separate R1 entries. code is the text before ':' and is not unique.
  - Why: 7% and 18% of the rows are empty in the CSV. Two milestones really are both called R1.
- labels is split on ';' and trimmed. Each token becomes a label row, and each (issue, label) pair becomes an issue_label row. A token like area:infra gets group area, and a plain token like factory has no group.
  - Why: The 23 distinct values are combos of tags. Treating them as flat labels would lose the filtering agents expect.
- Parent links form a depth-one tree in the seed. set_parent allows deeper nesting but rejects self-parenting and cycles. The create_issue action allows an optional parent_id.
  - Why: The CSV shows 3 parents. Linear permits nesting, and cycle protection is the rule an agent could break.
- complete_issue is refused with 409 open_sub_issues while any sub-issue is not done, canceled or duplicate. The auto_close_parents job completes a parent once every sub-issue is closed and at least one is done.
  - Why: This models Linear's 'close parent when sub-issues are closed' behaviour and gives hard tasks an ordering constraint.
- Status, parent, duplicate and completion fields are readonly, so a plain PATCH cannot change them. Only actions, jobs and seed do.
  - Why: Rules like completed_at and the history write live in the actions. A PATCH that skipped them would corrupt state, so it is refused.
- There are no users, assignees or authors. Comments and history events have no actor.
  - Why: The CSV has no assignee or user column. Adding an invented user table would give the agent facts the source never held.
- Comments and issue_event rows are synthesised in the seed from the fixture. They are not in the CSV.
  - Why: Comments and history are needed for lookups and audit checks. The seed derives them from each issue's timestamps and status so the data stays consistent.
- auto_archive_done runs every 1d and sets archived_at on done issues completed more than 30 days before now. Archived issues stay listable and filterable. The seed has none that old, so the job does nothing until the clock advances.
  - Why: Linear auto-archives closed issues. The imported data spans only one day, so the job is quiet at the start and only tests move the clock.
- The list envelope uses the engine defaults: data, next_cursor, limit and cursor. The error body is {error:{code,message}}.
  - Why: No source API spec was given, so nothing contradicts the defaults.

## Out of scope

- Users, assignees, authentication, permissions and workspace membership
  - Why: The CSV has no people columns. Inventing them would be unsourced.
- Cycles/sprints, estimates, due dates, roadmaps, initiatives and custom views
  - Why: None of them appear in the imported backlog. They would add surface with no task value.
- Attachments, file uploads, rich-text markdown rendering and @mentions
  - Why: The world stores plain text bodies only.
- Webhooks, notifications, integrations (GitHub, Slack) and the GraphQL endpoint
  - Why: The engine exposes REST routes and actions only, and none of these affect the graded state.
- Bulk import and export, templates, and multiple teams
  - Why: The CSV holds a single team. Fixtures are loaded by code, not by an API.
- Hard delete of issues
  - Why: Linear archives or cancels instead of deleting, so there is no delete route for issue. Only comments can be deleted.

## Changes

None. The plan changes no existing item.
