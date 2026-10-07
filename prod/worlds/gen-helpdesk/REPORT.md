# WorldGen report: Zendesk Support-style helpdesk (tickets API) with SLA policies and PagerDuty-style on-call escalation

A customer-support helpdesk. Customers on standard, premium or enterprise tiers file tickets. Agents work them through a fixed lifecycle (new, open, pending, escalated, resolved, closed). Each (tier, priority) pair has an SLA resolution target that sets a due time and a breach flag. Escalation hands a ticket to the agent on call at level 1 right now, and a timeout can push urgent tickets to level 2. Background jobs flag SLA breaches, auto-escalate breached urgent tickets, time out level 1 escalations and auto-close old resolved tickets.

## What was built

Entities (7):

- `customer`: 57 seeded rows
- `agent`: 12 seeded rows
- `sla_policy`: 12 seeded rows
- `oncall_shift`: 39 seeded rows
- `ticket`: 323 seeded rows
- `ticket_comment`: 243 seeded rows
- `ticket_event`: 1034 seeded rows

Routes (15):

- `list_tickets`: GET /tickets
- `get_ticket`: GET /tickets/{id}
- `create_ticket`: POST /tickets
- `update_ticket`: PATCH /tickets/{id}
- `list_ticket_events`: GET /tickets/{ticket_id}/events
- `list_ticket_comments`: GET /tickets/{ticket_id}/comments
- `create_ticket_comment`: POST /tickets/{ticket_id}/comments
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `update_customer`: PATCH /customers/{id}
- `list_agents`: GET /agents
- `get_agent`: GET /agents/{id}
- `list_oncall`: GET /oncall
- `list_sla_policies`: GET /sla_policies

Actions (4):

- `assign_ticket`: POST /tickets/{id}/assign
- `escalate_ticket`: POST /tickets/{id}/escalate
- `resolve_ticket`: POST /tickets/{id}/resolve
- `reopen_ticket`: POST /tickets/{id}/reopen

Jobs (3):

- `sla_breach`: every 15m
- `escalation_timeout`: every 15m
- `auto_close`: every 1h

## Assumed and why

- Mirror Zendesk Support's ticket API shape (tickets, requesters as customers, agents, comments, audit events) with a simplified REST surface, not its real field names or auth.
  - Why: The input names no product, so the closest well-known helpdesk is the best reference for agents to generalize from.
- Clock starts at 2026-03-02T09:00:00.000Z with tick 1s. All seeded history (tickets, comments, events, past shifts) precedes this. Later on-call shifts are future scheduled events.
  - Why: A fixed explicit start keeps runs deterministic. A 1s tick gives each committed write a distinct timestamp while keeping due-time maths stable. Jobs only fire when a test advances the clock.
- Auth, multi-tenancy and per-user permissions are not modeled. Every caller is a trusted API client.
  - Why: The input is about SLA and escalation behaviour, and auth would add noise to tasks.
- SLA targets are in calendar minutes per (customer tier, priority) pair. There are no business-hours calendars, holidays or pausing while pending.
  - Why: Keeps breach logic deterministic and checkable. Business calendars are a separate large feature.
- A ticket is breached when now >= sla_due_at while it is active (new, open, pending, escalated), or when it was resolved after the due time. The sla_breach job sets the flag every 15m. Seed rows set it consistently.
  - Why: A single clear rule lets graders and tasks filter on sla_breached reliably.
- Escalation has two levels. The escalate action goes to level 1 and assigns the level 1 on-call agent covering now. Only the escalation_timeout job reaches level 2 (urgent tickets after 60 minutes at level 1). The sla_breach job auto-escalates breached urgent tickets at level 0.
  - Why: Gives a clear manual path versus automatic path, and a place where wrong agents (non on-call) can be picked.
- Status transitions: new to open or escalated, open to pending, escalated or resolved, pending to open, escalated or resolved, escalated to resolved, resolved to open or closed, closed final. Assignee, escalation fields, SLA fields and resolved_at are readonly and set only by actions and jobs.
  - Why: Forces agents to use the workflow actions and not plain PATCH, so tasks can tell the correct path from shortcuts.
- Tickets are never deleted and there are no delete routes. Comments and events are append-only through the API (comments can be created, events cannot).
  - Why: Preserves the audit trail and avoids ambiguous collateral damage in graders.
- Money, billing and customer satisfaction are out. Only the SLA and escalation domain is modeled.
  - Why: Scope control.
- List endpoints use cursor paging with data and next_cursor, a page size of 25 and q search across the listed search fields.
  - Why: Matches the engine's default list envelope. Seed volumes exceed 25 rows so paging matters.

## Questions asked of the input

- Which real helpdesk should the API resemble?
  - Default answer: Zendesk Support tickets API, simplified.
- Should SLA targets respect business hours and pause while a ticket is pending?
  - Default answer: No. Targets are calendar minutes and never pause.
- How many escalation levels and who staffs them?
  - Default answer: Two. Level 1 is staffed by tier2 agents and level 2 by sre agents, in 12-hour on-call shifts.
- Can a client set assignee, escalation or SLA fields directly with PATCH?
  - Default answer: No. Those fields are readonly and changed only by the assign, escalate, resolve and reopen actions and by jobs.
- Is authentication or per-user permission modeled?
  - Default answer: No. Every caller is a trusted API client.
- What is the world's current time and does it move on its own?
  - Default answer: 2026-03-02T09:00:00.000Z, with a 1s tick per committed call. Jobs fire only when the clock is advanced.
- Can on-call shifts, SLA policies or tickets be deleted or edited through the API?
  - Default answer: Shifts and policies are read-only. Tickets cannot be deleted. Customers can be created and edited.

## Left out

- Authentication, roles and per-agent permissions
  - Why: Not needed for SLA and escalation behaviour, and it adds failure modes unrelated to the tasks.
- Business-hours SLA calendars, holidays, pause-on-pending
  - Why: Large separate feature. Calendar-minute targets are enough.
- Email, chat, phone channels, attachments, macros, triggers, views and automations UI
  - Why: The world models only the ticket, SLA and on-call core.
- Paging or notification delivery to on-call agents (PagerDuty integration)
  - Why: Escalation is modeled as reassignment and an audit event only.
- Customer satisfaction ratings, billing and reporting analytics
  - Why: Not related to the lifecycle under test.
- Creating, editing or deleting on-call shifts and SLA policies through the API
  - Why: They are reference data. Read-only routes keep escalation targets stable for graders.

## Proof

The engine check passed: 7 world tests, 0 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| assign_newest_acme_ticket | easy | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.000 | n/a |
| escalate_breached_printer_ticket | medium | 1.000 | 0.000 | 0.000, 0.700, 0.000, 0.000 | n/a |
| escalate_breached_enterprise_tickets | hard | 1.000 | 0.000 | 0.571, 0.000, 0.000, 0.000, 0.000, 0.000 | 0.857 |
| resolve_and_reopen_stale_ticket | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a |

Decoys:

- `assign_newest_acme_ticket` 0.000: takes the first new Acme Logistics ticket in id order (the oldest) instead of the most recently created one
- `assign_newest_acme_ticket` 0.000: PATCHes the status to open instead of assigning, so the ticket has no assignee
- `assign_newest_acme_ticket` 0.000: assigns the right ticket to Priya Shah, the agent with a similar name, instead of Priya Raman
- `assign_newest_acme_ticket` 0.000: assigns the right ticket to Priya Raman, then also edits its subject
- `escalate_breached_printer_ticket` 0.000: escalates the newest label printer ticket without checking which one breached its SLA
- `escalate_breached_printer_ticket` 0.700: escalates the right ticket but gives a reason that does not mention the SLA
- `escalate_breached_printer_ticket` 0.000: PATCHes the status to escalated instead of calling the escalate action, so no on-call agent is assigned
- `escalate_breached_printer_ticket` 0.000: assigns the ticket to the on-call agent by hand before escalating it, so its end state passes but its history has a hand edit
- `escalate_breached_enterprise_tickets` 0.571: reads only the first page of open, high, breached tickets, so it misses the enterprise tickets on page 2
- `escalate_breached_enterprise_tickets` 0.000: ignores the customer tier and escalates every open, high-priority ticket that breached its SLA
- `escalate_breached_enterprise_tickets` 0.000: reads 'open' as 'not resolved yet' and also escalates new and pending enterprise tickets that breached
- `escalate_breached_enterprise_tickets` 0.000: forgets the SLA filter and escalates every open, high-priority enterprise ticket
- `escalate_breached_enterprise_tickets` 0.000: PATCHes each target's status to escalated instead of calling the escalate action, so nobody on call is assigned
- `escalate_breached_enterprise_tickets` 0.000: escalates every target correctly, then also edits the subject of one of them
- `resolve_and_reopen_stale_ticket` 0.000: reopens the other resolved Northwind ticket that has no customer reply
- `resolve_and_reopen_stale_ticket` 0.000: PATCHes the status back to open instead of using the reopen action, so the SLA clock and event trail are not updated
- `resolve_and_reopen_stale_ticket` 0.000: reopens every resolved Northwind ticket without checking which one the customer replied on

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.77 | 0.0789 |
| model | 1 | 0.31 | 0.0739 |
| workflow | 2 | 3.26 | 0.4699 |
| seed | 2 | 2.48 | 0.4856 |
| tasks | 1 | 1.16 | 0.2715 |
| Total | 7 | 7.98 | 1.3798 |

Backtracks:

- `seed` to `workflow`: 1 issue

Run total: 8.31 minutes, $1.3798.
