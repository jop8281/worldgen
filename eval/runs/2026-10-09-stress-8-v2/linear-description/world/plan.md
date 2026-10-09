# WorldGen plan: Linear-style issue tracker (teams, issues, cycles, comments)

An issue tracker where teams own issues that move through a status lifecycle (backlog to done or canceled), get assigned to team members, and are scheduled into capacity-limited cycles (sprints).

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `team` | A group that owns issues and cycles; has a short unique key such as ENG | name, key |
| `member` | A user belonging to one team, with a role | name, email, team_id, role |
| `cycle` | A time-boxed sprint of a team with a limited issue capacity | team_id, name, capacity, starts_at, ends_at |
| `issue` | A unit of work with priority and status lifecycle, assignee and optional cycle | title, team_id, creator_id, assignee_id, priority, status, cycle_id, started_at, completed_at, canceled_at |
| `comment` | A message on an issue | issue_id, author_id, body |

## Workflows

### issue_lifecycle (issue)
- States: backlog, todo, in_progress, in_review, done, canceled
- Actions: assign_issue, start_issue, complete_issue, cancel_issue, add_to_cycle
- Rules:
  - An issue can only be assigned to a member of the issue's own team (409 not_team_member otherwise) Enforced by: assign_issue. Tested by: assign_requires_team_member
  - An issue can only be started from backlog or todo and only when it has an assignee (409 no_assignee); start sets status in_progress and started_at Enforced by: start_issue. Tested by: start_requires_assignee
  - An issue can only be completed from in_progress or in_review (409 invalid_state); completing sets done and completed_at Enforced by: complete_issue. Tested by: complete_requires_started
  - An issue can only join a cycle of its own team (409 cycle_team_mismatch) that still has free capacity (409 cycle_full) Enforced by: add_to_cycle. Tested by: cycle_capacity_enforced
  - Cancel is irreversible: done and canceled issues cannot be canceled (409 invalid_state), and a canceled issue cannot be started or completed Enforced by: cancel_issue, start_issue. Tested by: cancel_is_final
  - Team key is unique Enforced by the data model: team.key is declared unique so the data model rejects duplicates

## Jobs

None. The plan declares no job.

## Acceptance tests

### assign_requires_team_member
- Intent: assign works for a team member and is refused for a member of another team
- Actions: assign_issue
- Description: Create two teams, a member in each and an issue in team A. Assigning the team B member returns 409 not_team_member; assigning the team A member succeeds.

```js
(ctx) => {
  const ta = ctx.api('POST', '/teams', { name: 'Alpha Assign', key: 'ASA' });
  ctx.assert(ta.status === 201, 'team a ' + JSON.stringify(ta.body));
  const tb = ctx.api('POST', '/teams', { name: 'Beta Assign', key: 'ASB' });
  ctx.assert(tb.status === 201, 'team b');
  const ma = ctx.api('POST', '/members', { name: 'Ann Assign', email: 'ann.assign@acceptance.example', team_id: ta.body.id, role: 'member' });
  ctx.assert(ma.status === 201, 'member a ' + JSON.stringify(ma.body));
  const mb = ctx.api('POST', '/members', { name: 'Ben Assign', email: 'ben.assign@acceptance.example', team_id: tb.body.id, role: 'member' });
  ctx.assert(mb.status === 201, 'member b');
  const i = ctx.api('POST', '/issues', { title: 'Acceptance assign issue', team_id: ta.body.id, creator_id: ma.body.id, priority: 'high' });
  ctx.assert(i.status === 201 && i.body.status === 'backlog', 'issue ' + JSON.stringify(i.body));
  const bad = ctx.api('POST', '/issues/' + i.body.id + '/assign', { assignee_id: mb.body.id });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'not_team_member', 'bad ' + JSON.stringify(bad.body));
  const ok = ctx.api('POST', '/issues/' + i.body.id + '/assign', { assignee_id: ma.body.id });
  ctx.assert(ok.status === 200 && ok.body.assignee_id === ma.body.id, 'ok ' + JSON.stringify(ok.body));
}
```
### start_requires_assignee
- Intent: start needs an assignee and moves the issue to in_progress
- Actions: assign_issue, start_issue
- Description: Starting an unassigned issue gives 409 no_assignee; after assignment start sets in_progress and started_at.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Start Team', key: 'STT' });
  const m = ctx.api('POST', '/members', { name: 'Sam Start', email: 'sam.start@acceptance.example', team_id: t.body.id, role: 'member' });
  const i = ctx.api('POST', '/issues', { title: 'Acceptance start issue', team_id: t.body.id, creator_id: m.body.id, priority: 'normal' });
  ctx.assert(i.status === 201, 'issue ' + JSON.stringify(i.body));
  const no = ctx.api('POST', '/issues/' + i.body.id + '/start', {});
  ctx.assert(no.status === 409 && no.body.error.code === 'no_assignee', 'no assignee ' + JSON.stringify(no.body));
  ctx.assert(ctx.api('POST', '/issues/' + i.body.id + '/assign', { assignee_id: m.body.id }).status === 200, 'assign');
  const s = ctx.api('POST', '/issues/' + i.body.id + '/start', {});
  ctx.assert(s.status === 200 && s.body.status === 'in_progress' && s.body.started_at !== null, 'start ' + JSON.stringify(s.body));
  const again = ctx.api('POST', '/issues/' + i.body.id + '/start', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'again ' + JSON.stringify(again.body));
}
```
### complete_requires_started
- Intent: complete only works from in_progress or in_review
- Actions: assign_issue, start_issue, complete_issue
- Description: Completing a backlog issue is refused; after start, complete sets done and completed_at.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Complete Team', key: 'CMT' });
  const m = ctx.api('POST', '/members', { name: 'Cleo Complete', email: 'cleo.complete@acceptance.example', team_id: t.body.id, role: 'admin' });
  const i = ctx.api('POST', '/issues', { title: 'Acceptance complete issue', team_id: t.body.id, creator_id: m.body.id, priority: 'low' });
  const early = ctx.api('POST', '/issues/' + i.body.id + '/complete', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'early ' + JSON.stringify(early.body));
  ctx.api('POST', '/issues/' + i.body.id + '/assign', { assignee_id: m.body.id });
  ctx.assert(ctx.api('POST', '/issues/' + i.body.id + '/start', {}).status === 200, 'start');
  const d = ctx.api('POST', '/issues/' + i.body.id + '/complete', {});
  ctx.assert(d.status === 200 && d.body.status === 'done' && d.body.completed_at !== null, 'done ' + JSON.stringify(d.body));
}
```
### cycle_capacity_enforced
- Intent: add_to_cycle respects team match and cycle capacity
- Actions: add_to_cycle
- Description: A cycle with capacity 1 accepts one issue; a second gets 409 cycle_full; an issue of another team gets 409 cycle_team_mismatch.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Cycle Team', key: 'CYT' });
  const o = ctx.api('POST', '/teams', { name: 'Other Cycle Team', key: 'CYO' });
  const m = ctx.api('POST', '/members', { name: 'Cy Cycle', email: 'cy.cycle@acceptance.example', team_id: t.body.id, role: 'member' });
  const c = ctx.api('POST', '/cycles', { team_id: t.body.id, name: 'Acceptance Sprint', capacity: 1, starts_at: '2026-10-12T00:00:00.000Z', ends_at: '2026-10-26T00:00:00.000Z' });
  ctx.assert(c.status === 201, 'cycle ' + JSON.stringify(c.body));
  const mk = (title, team) => ctx.api('POST', '/issues', { title, team_id: team, creator_id: m.body.id, priority: 'normal' }).body.id;
  const i1 = mk('Cycle issue one', t.body.id);
  const i2 = mk('Cycle issue two', t.body.id);
  const i3 = mk('Cycle issue foreign', o.body.id);
  const r1 = ctx.api('POST', '/issues/' + i1 + '/cycle', { cycle_id: c.body.id });
  ctx.assert(r1.status === 200 && r1.body.cycle_id === c.body.id, 'first ' + JSON.stringify(r1.body));
  const r2 = ctx.api('POST', '/issues/' + i2 + '/cycle', { cycle_id: c.body.id });
  ctx.assert(r2.status === 409 && r2.body.error.code === 'cycle_full', 'full ' + JSON.stringify(r2.body));
  const r3 = ctx.api('POST', '/issues/' + i3 + '/cycle', { cycle_id: c.body.id });
  ctx.assert(r3.status === 409 && r3.body.error.code === 'cycle_team_mismatch', 'mismatch ' + JSON.stringify(r3.body));
}
```
### cancel_is_final
- Intent: cancel is irreversible and refused for finished issues
- Actions: assign_issue, start_issue, complete_issue, cancel_issue
- Description: Cancel sets canceled and canceled_at; a canceled issue cannot be canceled, started again; a done issue cannot be canceled.

```js
(ctx) => {
  const t = ctx.api('POST', '/teams', { name: 'Cancel Team', key: 'CNT' });
  const m = ctx.api('POST', '/members', { name: 'Cam Cancel', email: 'cam.cancel@acceptance.example', team_id: t.body.id, role: 'member' });
  const mk = (title) => ctx.api('POST', '/issues', { title, team_id: t.body.id, creator_id: m.body.id, priority: 'urgent' }).body.id;
  const a = mk('Cancel me');
  const c = ctx.api('POST', '/issues/' + a + '/cancel', {});
  ctx.assert(c.status === 200 && c.body.status === 'canceled' && c.body.canceled_at !== null, 'cancel ' + JSON.stringify(c.body));
  const c2 = ctx.api('POST', '/issues/' + a + '/cancel', {});
  ctx.assert(c2.status === 409 && c2.body.error.code === 'invalid_state', 'twice ' + JSON.stringify(c2.body));
  ctx.api('POST', '/issues/' + a + '/assign', { assignee_id: m.body.id });
  const s = ctx.api('POST', '/issues/' + a + '/start', {});
  ctx.assert(s.status === 409, 'start canceled ' + s.status);
  const b = mk('Finish me');
  ctx.api('POST', '/issues/' + b + '/assign', { assignee_id: m.body.id });
  ctx.api('POST', '/issues/' + b + '/start', {});
  ctx.assert(ctx.api('POST', '/issues/' + b + '/complete', {}).status === 200, 'complete');
  const c3 = ctx.api('POST', '/issues/' + b + '/cancel', {});
  ctx.assert(c3.status === 409 && c3.body.error.code === 'invalid_state', 'cancel done ' + JSON.stringify(c3.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_teams` | GET | /teams | List teams |
| `get_team` | GET | /teams/{id} | Get a team |
| `create_team` | POST | /teams | Create a team |
| `list_members` | GET | /members | List members, filter by team_id and role |
| `create_member` | POST | /members | Create a member |
| `list_cycles` | GET | /cycles | List cycles, filter by team_id |
| `get_cycle` | GET | /cycles/{id} | Get a cycle |
| `create_cycle` | POST | /cycles | Create a cycle |
| `list_issues` | GET | /issues | List issues; filter by status, priority, team_id, assignee_id, cycle_id; search title |
| `get_issue` | GET | /issues/{id} | Get an issue |
| `create_issue` | POST | /issues | Create an issue in backlog |
| `update_issue` | PATCH | /issues/{id} | Edit title, description, priority, estimate |
| `list_comments` | GET | /issues/{issue_id}/comments | List comments of an issue |
| `create_comment` | POST | /comments | Add a comment |
| `assign_issue` | POST | /issues/{id}/assign | Assign an issue to a member of its team |
| `start_issue` | POST | /issues/{id}/start | Start work |
| `complete_issue` | POST | /issues/{id}/complete | Mark done |
| `cancel_issue` | POST | /issues/{id}/cancel | Cancel permanently |
| `add_to_cycle` | POST | /issues/{id}/cycle | Schedule an issue into a cycle with free capacity |

## Seed

- Rows per entity: team: 3, member: 12, cycle: 6, issue: 60, comment: 40
- Mix: Issues spread over three teams (Platform, Billing, Mobile) and all six statuses, mixed priorities, some unassigned; several cycles per team, one nearly full; some near-duplicate titles such as '[dup]' prefixes.
- State mix: issue: backlog 25%, todo 20%, in_progress 25%, in_review 10%, done 15%, canceled 5%

## Tasks

- `assign_login_bug` (easy): Assign the issue titled 'Login redirect loops on Safari' to the member Dana Okafor of its team.
  - Actions: `assign_issue`
  - Decoy idea: Assigns a similarly titled issue of another team, or PATCHes without using assign.
- `start_urgent_billing` (medium, permissions): Take the unassigned urgent backlog issue of the Billing team, assign it to a Billing team admin and start it.
  - Actions: `assign_issue`, `start_issue`
  - Decoy idea: Assigns an admin from another team (refused) or a non-admin Billing member.
  - Pressure: seeded rows in issue.backlog; distractor rows of issue
- `fill_platform_cycle` (hard, scarce_resource): The Platform team's upcoming cycle has only a few free slots. Schedule the highest-priority unscheduled todo Platform issues into it until it is full, and start none that did not fit.
  - Actions: `add_to_cycle`, `assign_issue`
  - Decoy idea: Schedules lowest-priority issues first or overbooks into another team's cycle; only reads page one.
  - Pressure: paging past the first page of issue; seeded rows in issue.todo; distractor rows of cycle
- `cancel_duplicate_mobile` (medium, irreversible): Cancel every Mobile team backlog issue whose title starts with '[dup]', leaving all other issues, including done ones with similar titles, untouched.
  - Actions: `cancel_issue`
  - Decoy idea: Cancels issues of other teams or non-backlog issues with the [dup] prefix.
  - Pressure: seeded rows in issue.backlog, issue.done; distractor rows of issue

## Open questions

- Should issues have labels and projects?
  - Default answer: No, out of scope.
- Can a member belong to several teams?
  - Default answer: No, exactly one team.
- Does canceled count toward cycle capacity?
  - Default answer: Yes, any issue with the cycle_id counts.

## Assumptions

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

## Out of scope

- Projects, roadmaps, labels, sub-issues, GraphQL API, integrations
  - Why: Not needed for core issue workflow
- Authentication and notifications
  - Why: Not stateful records agents act on here

## Changes

None. The plan changes no existing item.
