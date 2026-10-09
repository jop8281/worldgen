# WorldGen plan: Zendesk Support-style helpdesk (tickets API) with SLA policies and PagerDuty-style on-call escalation

A customer-support helpdesk. Customers on standard, premium or enterprise tiers file tickets. Agents work them through a fixed lifecycle (new, open, pending, escalated, resolved, closed). Each (tier, priority) pair has an SLA resolution target that sets a due time and a breach flag. Escalation hands a ticket to the agent on call at level 1 right now, and a timeout can push urgent tickets to level 2. Background jobs flag SLA breaches, auto-escalate breached urgent tickets, time out level 1 escalations and auto-close old resolved tickets.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-03-02T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A company that files tickets. Its tier (standard, premium, enterprise) selects the SLA policy. | name, tier, email |
| `agent` | A support agent in tier1, tier2 or sre. tier2 staffs on-call level 1 and sre staffs level 2. Inactive agents cannot be assigned. | name, email, team, active |
| `sla_policy` | Resolution target in minutes for one (customer tier, ticket priority) pair. code is <tier>_<priority>, 12 rows. | code, tier, priority, resolution_minutes |
| `oncall_shift` | Half-open window [starts_at, ends_at) in which one agent is on call at level 1 or 2. Seeded from the past into the future, with one level 2 coverage gap. | agent_id, level, starts_at, ends_at |
| `ticket` | A support request worked through the status lifecycle. Holds the assignee, priority, escalation level, SLA start and due times, the breach flag and resolved_at. | subject, customer_id, assignee_id, priority, status, escalation_level, escalated_at, sla_started_at, sla_due_at, sla_breached, resolved_at |
| `ticket_comment` | A public reply or private internal note on a ticket. author_id null means the customer wrote it. | ticket_id, author_id, body, public |
| `ticket_event` | Append-only audit trail of ticket lifecycle events. Written by actions and jobs. | ticket_id, kind, note, actor_id |

## Workflows

### ticket_lifecycle (ticket)
- States: new, open, pending, escalated, resolved, closed
- Actions: assign_ticket, resolve_ticket, reopen_ticket
- Rules:
  - Declared transitions: new to open or escalated. open to pending, escalated or resolved. pending to open, escalated or resolved. escalated to resolved. resolved to open or closed. closed is final.
  - assign_ticket works on new, open and pending tickets only. The agent must exist and be active, and must differ from the current assignee. A new ticket becomes open. It writes an assigned event.
  - resolve_ticket works on open, pending and escalated tickets. A new ticket must be assigned first. It sets resolved_at and writes a resolved event with the optional note, and the escalation level is kept.
  - reopen_ticket works on resolved tickets only. It needs a non-blank reason and restarts the SLA from the policy for tier and priority. It sets status open, level 0, clears resolved_at and escalated_at, and keeps the assignee. Closed tickets answer 409.
  - Readonly fields (assignee_id, escalation_level, escalated_at, sla_*, resolved_at) are changed only by actions and jobs, never by plain PATCH or create.
### sla_and_escalation (ticket)
- States: new, open, pending, escalated
- Actions: escalate_ticket
- Rules:
  - sla_due_at = sla_started_at + the sla_policy resolution_minutes for the customer's tier and the ticket priority.
  - escalate_ticket works on new, open and pending tickets. It needs a non-blank reason. It finds the level 1 shift where starts_at <= now < ends_at and assigns that agent. It sets status escalated, level 1 and escalated_at, and writes an escalated event with the reason. With no covering shift it answers 409 no_oncall. An already escalated ticket answers 409 already_escalated.
  - Job sla_breach (every 15m): fills missing due times from the policy, flags active tickets whose due time has passed and writes sla_breach events, then auto-escalates breached urgent level 0 tickets to the level 1 on-call agent.
  - Job escalation_timeout (every 15m): an urgent escalated ticket at level 1 for 60 minutes or more moves to level 2 and the level 2 on-call agent. It is skipped while no level 2 shift covers now.
  - Job auto_close (every 1h): a resolved ticket 72 hours or more past resolved_at becomes closed with a closed event.

## Jobs

- `sla_breach` runs every 15m: Fill missing sla_due_at from the tier and priority policy. Flag active tickets (new, open, pending, escalated) whose due time has passed as sla_breached and write an sla_breach event. Then escalate breached urgent tickets at level 0 in new, open or pending status to the level 1 on-call agent (the same rule as escalate_ticket), writing an escalated event noted auto: SLA breach. Skip the escalation pass while no level 1 shift covers now.
- `escalation_timeout` runs every 15m: Move escalated urgent tickets that have been at level 1 for 60 minutes or more to level 2, assign the level 2 on-call agent covering now, update escalated_at and write an escalated event noted auto: level 1 timeout. Skip while no level 2 shift covers now.
- `auto_close` runs every 1h: Close each resolved ticket whose resolved_at is 72 hours or more before now and write a closed event noted auto: 72h after resolution.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_tickets` | GET | /tickets | List tickets with filters (status, priority, customer_id, assignee_id, sla_breached, escalation_level), search on subject, sort by created_at or sla_due_at, cursor paging. |
| `get_ticket` | GET | /tickets/{id} | Fetch one ticket. |
| `create_ticket` | POST | /tickets | File a ticket. It starts in status new. |
| `update_ticket` | PATCH | /tickets/{id} | Edit writable fields such as subject, description, priority, or follow declared status transitions. Readonly fields are refused. |
| `list_ticket_events` | GET | /tickets/{ticket_id}/events | The audit trail of one ticket. |
| `list_ticket_comments` | GET | /tickets/{ticket_id}/comments | Comments on one ticket. |
| `create_ticket_comment` | POST | /tickets/{ticket_id}/comments | Add a public reply or private note. |
| `list_customers` | GET | /customers | List customers, filter by tier, search by name. |
| `get_customer` | GET | /customers/{id} | Fetch one customer. |
| `create_customer` | POST | /customers | Create a customer. |
| `update_customer` | PATCH | /customers/{id} | Edit a customer, including its tier. |
| `list_agents` | GET | /agents | List agents, filter by team and active, search by name or email. |
| `get_agent` | GET | /agents/{id} | Fetch one agent. |
| `list_oncall` | GET | /oncall | List on-call shifts, filter by level and agent_id, sort by starts_at. |
| `list_sla_policies` | GET | /sla_policies | List the SLA targets, filter by tier and priority. |
| `assign_ticket` | POST | /tickets/{id}/assign | Action: assign a new, open or pending ticket to an active agent. A new ticket moves to open. |
| `escalate_ticket` | POST | /tickets/{id}/escalate | Action: escalate a new, open or pending ticket to level 1 and reassign it to the agent on call at level 1 now. Needs a reason. |
| `resolve_ticket` | POST | /tickets/{id}/resolve | Action: resolve an open, pending or escalated ticket. Sets resolved_at, stops the SLA clock. |
| `reopen_ticket` | POST | /tickets/{id}/reopen | Action: reopen a resolved ticket to open with a fresh SLA clock from the tier policy. Closed tickets cannot be reopened. |

## Seed

- Rows per entity: customer: 57, agent: 12, sla_policy: 12, oncall_shift: 39, ticket: 320, ticket_comment: 260, ticket_event: 900
- Mix: Customers: about 10% enterprise, 26% premium, 64% standard, plus three named anchors (Acme Logistics enterprise, Acme Paper Co. premium, Northwind Health enterprise). Agents: tier1, tier2 and sre, one inactive. Tickets: roughly new 9%, open 27%, pending 9%, escalated 12%, resolved 27%, closed 14%, with priorities about 25% low, 40% normal, 25% high, 10% urgent. A sizeable set of open, high-priority, breached tickets spans two pages, with a handful belonging to enterprise customers (some on page 2). Also near-miss decoy rows: enterprise high tickets that are open but not breached, and breached enterprise high tickets in new or pending status. Five anchor tickets include two Acme Logistics label-printer tickets (one breached, one not) and two new unassigned Acme tickets. On-call shifts run in 12h blocks from a week before clock.start to days after it. Level 1 is continuous and level 2 has one gap, so future shifts are scheduled and not yet happened. Every seeded row has created_at <= updated_at <= clock.start. Events and comments are derived from ticket fields so they stay consistent.

## Tasks

- `assign_newest_acme_ticket` (easy): Assign the most recently created unassigned (new) ticket from the customer Acme Logistics to the agent Priya Raman using the assign action. The agent must discover both ids by search. Nothing else may change except that ticket and its new events.
  - Decoy idea: Takes the oldest new Acme ticket, or the first in id order, instead of the newest. Another decoy PATCHes status to open, so the ticket has no assignee.
- `escalate_breached_printer_ticket` (medium): Acme Logistics has several label-printer tickets and only one has breached its SLA. Find it, escalate it with the escalate action and a reason that mentions the SLA, and do not touch or edit it by hand before the escalation. Success means status escalated at level 1, the assignee is the level 1 on-call agent at escalation time, and the new escalated event mentions the SLA. Score 0 on any collateral change.
  - Decoy idea: Escalates the newest printer ticket without checking the breach flag, gives a reason with no SLA mention, PATCHes the status instead of calling the action, or assigns the on-call agent by hand before escalating.
- `escalate_breached_enterprise_tickets` (hard): Escalate every ticket that is open, high priority, belongs to an enterprise customer and has breached its SLA, each with a reason that contains the word SLA (stored as the escalated ticket_event note), and change nothing else. The matching tickets are spread across two pages of the list, and near-miss tickets (not breached, other tiers, other statuses) are in the seed. The agent must page through, join tickets to customer tier and use the escalate action. Score is the share of targets correctly escalated to the on-call agent with a reason mentioning SLA, and any collateral change scores 0.
  - Decoy idea: Reads only page 1, ignores customer tier, treats open as new, open or pending, skips the breach filter, PATCHes the status to escalated so no on-call agent is assigned, or escalates correctly with a reason that does not mention the SLA.
- `resolve_and_reopen_stale_ticket` (medium): Reopen the one recently resolved ticket (resolved within the last 72 hours) from Northwind Health whose customer replied after resolution, with a reason that contains the word replied (stored as the reopened ticket_event note). Then check that the ticket is open, keeps its assignee and has the SLA restarted from the enterprise policy for its priority. Do not touch closed tickets.
  - Decoy idea: Picks an older closed ticket (which answers 409), reopens a different Northwind ticket, PATCHes status to open leaving the SLA clock stale, or reopens the right ticket with a reason that does not mention the customer reply.

## Open questions

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
- Which keywords must the reasons contain?
  - Default answer: SLA for the escalation reason and replied for the reopen reason.

## Assumptions

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
- Required keywords are SLA for the enterprise escalation reason and replied for the reopen reason, matched case-insensitively on ticket_event.note.
  - Why: The keywords come from the task wording already given, so the instruction can state them without leaking ids.

## Out of scope

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

## Changes

- tasks.escalate_breached_enterprise_tickets
- tasks.resolve_and_reopen_stale_ticket
