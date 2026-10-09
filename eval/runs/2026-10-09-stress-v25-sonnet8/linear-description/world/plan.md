# WorldGen plan: Linear-style issue tracker (teams, members, projects, issues with a workflow status, comments)

An issue tracker where teams own issues that members work through backlog, todo, in progress, in review, done or canceled. Actions enforce who may be assigned, a per-team work-in-progress limit, completion and cancellation rules, and comment rules.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `team` | A group that owns issues. Has a unique short key and a per-member work-in-progress limit. | name, key, wip_limit |
| `member` | A person on a team. Role is admin, member or guest. Guests cannot be assigned issues. | name, email, team_id, role, active |
| `project` | A body of work within a team that groups issues. | name, team_id, status |
| `issue` | A unit of work moving through the status lifecycle. | title, team_id, project_id, assignee_id, priority, status, estimate, started_at, completed_at, canceled_reason |
| `comment` | A message on an issue written by a team member. | issue_id, author_id, body |

## Workflows

### issue_lifecycle (issue)
- States: backlog, todo, in_progress, in_review, done, canceled
- Actions: assign_issue, start_issue, complete_issue, cancel_issue, add_comment
- Rules:
  - An issue can be assigned only to an active, non-guest member of the issue's own team. Enforced by: assign_issue. Tested by: assign_member_checks
  - A done or canceled issue cannot be assigned. Enforced by: assign_issue. Tested by: assign_closed_issue
  - Starting an issue needs an assignee and a backlog or todo status; it moves to in_progress and sets started_at. Enforced by: start_issue. Tested by: start_needs_assignee
  - An assignee cannot have more in_progress issues than the team's wip_limit; starting beyond it is refused. Enforced by: start_issue. Tested by: wip_limit_enforced
  - Completing is allowed only from in_progress or in_review; it moves to done and sets completed_at. Enforced by: complete_issue. Tested by: complete_sets_completed_at
  - Canceling needs a non-blank reason, is refused for done issues, and canceled is final. Enforced by: cancel_issue. Tested by: cancel_requires_reason
  - A comment's author must be a member of the issue's team. Enforced by: add_comment. Tested by: comment_author_team
  - A canceled issue accepts no new comments. Enforced by: add_comment. Tested by: comment_closed_issue
  - A new issue always starts in backlog and only declared status transitions are allowed. Enforced by the data model: The state field has initial backlog and a transitions map the engine enforces on every write.
  - Team keys are unique. Enforced by the data model: The key field is unique.

## Jobs

None. The plan declares no job.

## Acceptance tests

### assign_member_checks
- Intent: assign_issue accepts an active same-team member and refuses other-team, inactive and guest members.
- Actions: assign_issue
- Description: Creates two teams and members of each kind, then tries to assign an issue to each.

```js
(ctx) => {
  const t1 = ctx.api('POST', '/teams', { name: 'Zeta One', key: 'ZAA', wip_limit: 3 }).body;
  const t2 = ctx.api('POST', '/teams', { name: 'Zeta Two', key: 'ZAB', wip_limit: 3 }).body;
  const mk = (n, team, extra) => ctx.api('POST', '/members', Object.assign({ name: n, email: n.toLowerCase().replace(' ', '.') + '@test.example', team_id: team.id, role: 'member' }, extra || {})).body;
  const ok = mk('Alex Okay', t1);
  const other = mk('Olga Other', t2);
  const gone = mk('Ian Inactive', t1, { active: false });
  const guest = mk('Gus Guest', t1, { role: 'guest' });
  const issue = ctx.api('POST', '/issues', { title: 'Assign check', team_id: t1.id, priority: 'medium' }).body;
  ctx.assert(issue.status === 'backlog', 'new issue is backlog, got ' + issue.status);
  const a = ctx.api('POST', '/issues/' + issue.id + '/assign', { assignee_id: other.id });
  ctx.assert(a.status === 409 && a.body.error.code === 'wrong_team', 'other team: ' + JSON.stringify(a));
  const b = ctx.api('POST', '/issues/' + issue.id + '/assign', { assignee_id: gone.id });
  ctx.assert(b.status === 409 && b.body.error.code === 'member_inactive', 'inactive: ' + JSON.stringify(b));
  const c = ctx.api('POST', '/issues/' + issue.id + '/assign', { assignee_id: guest.id });
  ctx.assert(c.status === 409 && c.body.error.code === 'guest_not_assignable', 'guest: ' + JSON.stringify(c));
  const d = ctx.api('POST', '/issues/' + issue.id + '/assign', { assignee_id: ok.id });
  ctx.assert(d.status === 200 && d.body.assignee_id === ok.id, 'assign ok: ' + JSON.stringify(d));
}
```
### assign_closed_issue
- Intent: A done or canceled issue cannot be assigned.
- Actions: assign_issue, cancel_issue
- Description: Cancels an issue and then tries to assign it.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Zeta Three', key: 'ZAC', wip_limit: 3 }).body;
  const m = ctx.api('POST', '/members', { name: 'Cleo Closed', email: 'cleo.closed@test.example', team_id: t.id, role: 'member' }).body;
  const i = ctx.api('POST', '/issues', { title: 'Closed assign', team_id: t.id, priority: 'low' }).body;
  const x = ctx.api('POST', '/issues/' + i.id + '/cancel', { reason: 'Not needed' });
  ctx.assert(x.status === 200 && x.body.status === 'canceled', 'cancel: ' + JSON.stringify(x));
  const a = ctx.api('POST', '/issues/' + i.id + '/assign', { assignee_id: m.id });
  ctx.assert(a.status === 409 && a.body.error.code === 'invalid_state', 'assign canceled: ' + JSON.stringify(a));
  const after = ctx.api('GET', '/issues/' + i.id).body;
  ctx.assert(after.assignee_id === null, 'assignee unchanged');
}
```
### start_needs_assignee
- Intent: start_issue refuses an unassigned issue and moves an assigned one to in_progress with started_at.
- Actions: assign_issue, start_issue
- Description: Tries to start an unassigned issue, then assigns and starts it.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Zeta Four', key: 'ZAD', wip_limit: 3 }).body;
  const m = ctx.api('POST', '/members', { name: 'Sam Starter', email: 'sam.starter@test.example', team_id: t.id, role: 'member' }).body;
  const i = ctx.api('POST', '/issues', { title: 'Start check', team_id: t.id, priority: 'high' }).body;
  const no = ctx.api('POST', '/issues/' + i.id + '/start', {});
  ctx.assert(no.status === 409 && no.body.error.code === 'not_assigned', 'unassigned start: ' + JSON.stringify(no));
  ctx.assert(ctx.api('POST', '/issues/' + i.id + '/assign', { assignee_id: m.id }).status === 200, 'assign');
  const at = ctx.now();
  const r = ctx.api('POST', '/issues/' + i.id + '/start', {});
  ctx.assert(r.status === 200 && r.body.status === 'in_progress' && r.body.started_at === at, 'start: ' + JSON.stringify(r));
  const again = ctx.api('POST', '/issues/' + i.id + '/start', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second start: ' + JSON.stringify(again));
}
```
### wip_limit_enforced
- Intent: start_issue refuses to start more issues than the team's wip_limit for one assignee, and allows it again after completing one.
- Actions: assign_issue, start_issue, complete_issue
- Description: Team with wip_limit 1: second start is refused until the first is completed.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Zeta Five', key: 'ZAE', wip_limit: 1 }).body;
  const m = ctx.api('POST', '/members', { name: 'Wendy Limit', email: 'wendy.limit@test.example', team_id: t.id, role: 'member' }).body;
  const a = ctx.api('POST', '/issues', { title: 'WIP A', team_id: t.id, priority: 'medium' }).body;
  const b = ctx.api('POST', '/issues', { title: 'WIP B', team_id: t.id, priority: 'medium' }).body;
  for (const x of [a, b]) ctx.assert(ctx.api('POST', '/issues/' + x.id + '/assign', { assignee_id: m.id }).status === 200, 'assign ' + x.id);
  ctx.assert(ctx.api('POST', '/issues/' + a.id + '/start', {}).status === 200, 'start A');
  const blocked = ctx.api('POST', '/issues/' + b.id + '/start', {});
  ctx.assert(blocked.status === 409 && blocked.body.error.code === 'wip_limit_reached', 'blocked: ' + JSON.stringify(blocked));
  ctx.assert(ctx.api('GET', '/issues/' + b.id).body.status === 'backlog', 'B unchanged');
  ctx.assert(ctx.api('POST', '/issues/' + a.id + '/complete', {}).status === 200, 'complete A');
  const ok = ctx.api('POST', '/issues/' + b.id + '/start', {});
  ctx.assert(ok.status === 200 && ok.body.status === 'in_progress', 'B starts after A is done: ' + JSON.stringify(ok));
}
```
### complete_sets_completed_at
- Intent: complete_issue moves in_progress to done with completed_at and refuses other statuses.
- Actions: assign_issue, start_issue, complete_issue
- Description: Completes a started issue; refuses a backlog issue and a second completion.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Zeta Six', key: 'ZAF', wip_limit: 3 }).body;
  const m = ctx.api('POST', '/members', { name: 'Dora Done', email: 'dora.done@test.example', team_id: t.id, role: 'admin' }).body;
  const i = ctx.api('POST', '/issues', { title: 'Complete check', team_id: t.id, priority: 'urgent' }).body;
  const early = ctx.api('POST', '/issues/' + i.id + '/complete', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'backlog complete: ' + JSON.stringify(early));
  ctx.api('POST', '/issues/' + i.id + '/assign', { assignee_id: m.id });
  ctx.api('POST', '/issues/' + i.id + '/start', {});
  const at = ctx.now();
  const r = ctx.api('POST', '/issues/' + i.id + '/complete', {});
  ctx.assert(r.status === 200 && r.body.status === 'done' && r.body.completed_at === at, 'complete: ' + JSON.stringify(r));
  const again = ctx.api('POST', '/issues/' + i.id + '/complete', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'again: ' + JSON.stringify(again));
}
```
### cancel_requires_reason
- Intent: cancel_issue needs a non-blank reason, stores it, and refuses done issues.
- Actions: assign_issue, start_issue, complete_issue, cancel_issue
- Description: Missing and blank reason are refused; a valid cancel stores the reason; done issues cannot be canceled.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Zeta Seven', key: 'ZAG', wip_limit: 3 }).body;
  const m = ctx.api('POST', '/members', { name: 'Carl Cancel', email: 'carl.cancel@test.example', team_id: t.id, role: 'member' }).body;
  const i = ctx.api('POST', '/issues', { title: 'Cancel check', team_id: t.id, priority: 'low' }).body;
  const miss = ctx.api('POST', '/issues/' + i.id + '/cancel', {});
  ctx.assert(miss.status === 400 && miss.body.error.code === 'input.invalid', 'missing reason: ' + JSON.stringify(miss));
  const blank = ctx.api('POST', '/issues/' + i.id + '/cancel', { reason: '   ' });
  ctx.assert(blank.status === 400 && blank.body.error.code === 'input.invalid', 'blank reason: ' + JSON.stringify(blank));
  const r = ctx.api('POST', '/issues/' + i.id + '/cancel', { reason: 'Duplicate of another issue' });
  ctx.assert(r.status === 200 && r.body.status === 'canceled' && r.body.canceled_reason === 'Duplicate of another issue', 'cancel: ' + JSON.stringify(r));
  const j = ctx.api('POST', '/issues', { title: 'Cancel done', team_id: t.id, priority: 'low' }).body;
  ctx.api('POST', '/issues/' + j.id + '/assign', { assignee_id: m.id });
  ctx.api('POST', '/issues/' + j.id + '/start', {});
  ctx.api('POST', '/issues/' + j.id + '/complete', {});
  const late = ctx.api('POST', '/issues/' + j.id + '/cancel', { reason: 'Too late' });
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'cancel done: ' + JSON.stringify(late));
}
```
### comment_author_team
- Intent: add_comment accepts a member of the issue's team and refuses a member of another team.
- Actions: add_comment
- Description: Posts comments from an own-team and an other-team member and lists them.

```js
(ctx) => {
  const t1 = ctx.api('POST', '/teams', { name: 'Zeta Eight', key: 'ZAH', wip_limit: 3 }).body;
  const t2 = ctx.api('POST', '/teams', { name: 'Zeta Nine', key: 'ZAI', wip_limit: 3 }).body;
  const own = ctx.api('POST', '/members', { name: 'Owen Own', email: 'owen.own@test.example', team_id: t1.id, role: 'member' }).body;
  const out = ctx.api('POST', '/members', { name: 'Otto Outside', email: 'otto.outside@test.example', team_id: t2.id, role: 'member' }).body;
  const i = ctx.api('POST', '/issues', { title: 'Comment check', team_id: t1.id, priority: 'medium' }).body;
  const bad = ctx.api('POST', '/issues/' + i.id + '/comment', { author_id: out.id, body: 'Drive-by' });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'author_not_in_team', 'other team: ' + JSON.stringify(bad));
  const good = ctx.api('POST', '/issues/' + i.id + '/comment', { author_id: own.id, body: 'Looking into it' });
  ctx.assert(good.status === 201 && good.body.issue_id === i.id && good.body.author_id === own.id, 'comment: ' + JSON.stringify(good));
  const list = ctx.api('GET', '/issues/' + i.id + '/comments').body.data;
  ctx.assert(list.length === 1 && list[0].body === 'Looking into it', 'one comment listed');
}
```
### comment_closed_issue
- Intent: A canceled issue refuses new comments.
- Actions: add_comment, cancel_issue
- Description: Cancels an issue then tries to comment.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Zeta Ten', key: 'ZAJ', wip_limit: 3 }).body;
  const m = ctx.api('POST', '/members', { name: 'Cory Comment', email: 'cory.comment@test.example', team_id: t.id, role: 'member' }).body;
  const i = ctx.api('POST', '/issues', { title: 'Closed comment', team_id: t.id, priority: 'low' }).body;
  ctx.assert(ctx.api('POST', '/issues/' + i.id + '/cancel', { reason: 'Obsolete' }).status === 200, 'cancel');
  const r = ctx.api('POST', '/issues/' + i.id + '/comment', { author_id: m.id, body: 'Anyone here?' });
  ctx.assert(r.status === 409 && r.body.error.code === 'issue_canceled', 'comment on canceled: ' + JSON.stringify(r));
  ctx.assert(ctx.api('GET', '/issues/' + i.id + '/comments').body.data.length === 0, 'no comment stored');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_issues` | GET | /issues | List issues; filter by status, priority, team_id, project_id, assignee_id; search title; sort by created_at, priority. |
| `get_issue` | GET | /issues/{id} | Get one issue. |
| `create_issue` | POST | /issues | Create an issue in backlog. |
| `update_issue` | PATCH | /issues/{id} | Edit title, description, priority, estimate, project. |
| `list_comments` | GET | /issues/{issue_id}/comments | List comments of an issue. |
| `list_teams` | GET | /teams | List teams. |
| `get_team` | GET | /teams/{id} | Get a team. |
| `create_team` | POST | /teams | Create a team. |
| `list_members` | GET | /members | List members; filter by team_id, role, active; search name. |
| `get_member` | GET | /members/{id} | Get a member. |
| `create_member` | POST | /members | Create a member. |
| `list_projects` | GET | /projects | List projects; filter by team_id, status. |
| `create_project` | POST | /projects | Create a project. |

## Seed

- Rows per entity: team: 3, member: 9, project: 4, issue: 40, comment: 30
- Mix: Issues spread over all six statuses and three teams, with urgent, high, medium and low priorities. Each team has active members and one guest. One member sits at the WIP limit. Several near-duplicate titles exist across teams.
- State mix: issue: backlog 20%, todo 18%, in_progress 20%, in_review 14%, done 20%, canceled 8%

## Tasks

- `assign_urgent_platform_issue` (easy, permissions): Assign the unassigned urgent issue of the Platform team to the active member Dana Whitfield, who is on that team.
  - Actions: `assign_issue`
  - Decoy idea: Assigns a different unassigned urgent or high-priority issue from another team, or assigns to a same-named member of another team.
  - Pressure: distractor rows of issue
- `cancel_duplicate_dark_mode` (medium, irreversible): Cancel the backlog issue titled 'Dark mode support' in the Mobile team with a reason that says it is a duplicate; near-identical issues in other teams and statuses must stay untouched.
  - Actions: `cancel_issue`
  - Decoy idea: Cancels the same-titled issue in the Web team, or cancels with a reason that does not mention duplicate.
  - Pressure: seeded rows in issue.backlog; distractor rows of issue
- `free_wip_and_start_next` (hard, scarce_resource): Ravi Menon is at his team's WIP limit. Complete his in_review issue about the rate limiter, then start his todo issue about webhook retries, so that he ends with no more in_progress issues than the limit.
  - Actions: `complete_issue`, `start_issue`
  - Decoy idea: Tries to start the webhook issue first (refused), or completes a different issue of Ravi's, or cancels instead of completing.
  - Pressure: paging past the first page of issue; seeded rows in issue.in_progress, issue.in_review, issue.todo; distractor rows of issue

## Open questions

- Should issues have team-prefixed identifiers like ENG-12?
  - Default answer: No; ids like iss_0001 are enough.
- Should status be changeable by plain PATCH?
  - Default answer: Only along declared transitions; actions carry the business rules.
- Is there a current user for permissions?
  - Default answer: No; the assignee or author is passed explicitly and checked against role and team.

## Assumptions

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

## Out of scope

- Cycles, labels, subscriptions, notifications, attachments, webhooks
  - Why: Not needed for the core workflow.
- Authentication and a current-user concept
  - Why: Actors are passed explicitly in inputs.
- GraphQL API, real-time sync, UI
  - Why: The world is a REST replica.

## Changes

None. The plan changes no existing item.
