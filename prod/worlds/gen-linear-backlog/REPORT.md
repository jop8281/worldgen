# WorldGen report: Linear-style issue tracker (Linear issues, projects, milestones and labels, exposed as a REST API)

A single-team issue tracker seeded from a real 123-issue Linear backlog (team key YOS, project WorldGen). Issues move through Backlog, In Progress, In Review, Done, Canceled and Duplicate. They carry a priority, a project, a milestone, labels, an optional parent and a completion time. Agents triage, move, relabel, re-milestone, close out and de-duplicate issues. Status changes go through actions that enforce the workflow rules and write an audit history. Two jobs auto-close parents and archive old done issues.

## What was built

Entities (8):

- `team`: 1 seeded row
- `project`: 1 seeded row
- `milestone`: 12 seeded rows
- `label`: 11 seeded rows
- `issue`: 123 seeded rows
- `issue_label`: 261 seeded rows
- `comment`: 52 seeded rows
- `issue_event`: 597 seeded rows

Routes (19):

- `list_issues`: GET /issues
- `get_issue`: GET /issues/{id}
- `update_issue`: PATCH /issues/{id}
- `list_sub_issues`: GET /issues/{parent_id}/children
- `list_issue_labels`: GET /issues/{issue_id}/labels
- `list_issue_comments`: GET /issues/{issue_id}/comments
- `create_comment`: POST /issues/{issue_id}/comments
- `update_comment`: PATCH /comments/{id}
- `delete_comment`: DELETE /comments/{id}
- `list_issue_events`: GET /issues/{issue_id}/history
- `list_projects`: GET /projects
- `get_project`: GET /projects/{id}
- `list_milestones`: GET /milestones
- `get_milestone`: GET /milestones/{id}
- `update_milestone`: PATCH /milestones/{id}
- `list_labels`: GET /labels
- `get_label`: GET /labels/{id}
- `create_label`: POST /labels
- `list_teams`: GET /teams

Actions (10):

- `create_issue`: POST /issues
- `start_issue`: POST /issues/{id}/start
- `request_review`: POST /issues/{id}/review
- `complete_issue`: POST /issues/{id}/complete
- `cancel_issue`: POST /issues/{id}/cancel
- `mark_duplicate`: POST /issues/{id}/duplicate
- `reopen_issue`: POST /issues/{id}/reopen
- `set_parent`: POST /issues/{id}/parent
- `add_label`: POST /issues/{id}/labels
- `remove_label`: DELETE /issues/{id}/labels/{label_id}

Jobs (2):

- `auto_close_parents`: every 1h
- `auto_archive_done`: every 1d

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 9 world tests, 1 warning. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| start_the_welcome_issue | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a |
| cancel_stale_backlog_in_milestone | medium | 1.000 | 0.000 | 0.000, 0.000, 0.700, 0.000 | 0.000 |
| close_out_epic_with_sub_issues | hard | 1.000 | 0.000 | 0.000, 0.000, 0.340, 0.000 | 0.670 |
| merge_duplicate_issues | hard | 1.000 | 0.000 | 0.500, 0.000, 0.000, 0.000 | 0.500 |

Decoys:

- `start_the_welcome_issue` 0.000: starts the Stress run 1 backlog issue, a different backlog issue, instead of the rehearsal one
- `start_the_welcome_issue` 0.000: starts the right issue but then also sends it to review, so it ends in review instead of in progress
- `cancel_stale_backlog_in_milestone` 0.000: cancels every backlog issue in the milestone and ignores the label, so it also cancels the area:eval and area:infra ones
- `cancel_stale_backlog_in_milestone` 0.000: cancels every backlog issue with the area:engine label in any milestone, ignoring the milestone
- `cancel_stale_backlog_in_milestone` 0.700: cancels the right issues but gives no reason, so no explanatory comment is left on them
- `cancel_stale_backlog_in_milestone` 0.000: filters by milestone and label but ignores status, so it also cancels the in-progress issues that carry area:engine
- `close_out_epic_with_sub_issues` 0.000: completes the open sub-issues but never completes the epics themselves
- `close_out_epic_with_sub_issues` 0.000: cancels the sub-issues to unblock the epics, which loses the in-flight work, then completes the epics
- `close_out_epic_with_sub_issues` 0.340: closes out only the first epic it finds and stops, leaving the other two epics open
- `close_out_epic_with_sub_issues` 0.000: tries to complete each epic first, gets 409 open_sub_issues and then completes only the sub-issues without retrying the epics
- `merge_duplicate_issues` 0.500: copies only the Bug label and misses area:worldgen, so the merge is incomplete
- `merge_duplicate_issues` 0.000: moves the labels instead of copying them: attaches them to the original and removes them from the duplicate
- `merge_duplicate_issues` 0.000: attaches the labels to the original of a different duplicate pair (YOS-121, the original of YOS-122) instead of the real original
- `merge_duplicate_issues` 0.000: attaches the labels to the original but also reopens the duplicate, changing an issue it should leave closed

## Run

Mode: create from csv. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.54 | 0.1421 |
| model | 1 | 0.49 | 0.1740 |
| workflow | 2 | 2.19 | 0.5992 |
| seed | 3 | 1.36 | 0.7191 |
| tasks | 1 | 2.70 | 0.4568 |
| Total | 8 | 8.28 | 2.0912 |

Run total: 8.58 minutes, $2.0912.
