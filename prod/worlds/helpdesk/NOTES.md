# Helpdesk (golden world)

Hand-built, not generated. It is the engine's end-to-end fixture and one of WorldGen's few-shot examples (A-17, A-42, U-9, A-390).
It resembles the Zendesk Support tickets API: tickets from requesters, worked by agents, with SLA policies.
The target behaviour is research/helpdesk-expected-behaviour.md. Where this world differs, see
research/spec-calls/world-helpdesk-model.md and research/spec-calls/world-helpdesk.md.
Clock starts 2026-03-02T09:00:00.000Z (a Monday, S below), 1s per successful call.

## Entities
- customer: a company that files tickets. tier (standard, premium, enterprise) picks the SLA target.
- agent: a support agent, team tier1, tier2 or sre. Inactive agents stay listed.
- sla_policy: resolution_minutes for one (tier, priority) pair. code `<tier>_<priority>` is unique.
- oncall_shift: one agent on call at level 1 (tier2) or level 2 (sre) for [starts_at, ends_at).
- ticket: subject, description, customer_id, priority, status, plus readonly workflow fields:
  assignee_id, escalation_level, escalated_at, sla_started_at, sla_due_at, sla_breached, resolved_at.
- ticket_comment: a public reply or private note on a ticket, by an agent or (author_id null) the customer.
- ticket_event: append-only audit trail (created, assigned, escalated, sla_breach, ...), written by actions and jobs.

## Ticket state machine
```
new -> open | escalated
open -> pending | escalated | resolved
pending -> open | escalated | resolved
escalated -> resolved          (no de-escalation)
resolved -> open (reopen) | closed
closed                         (final)
```
Status stays writable, so a plain PATCH can make any declared move, but only the actions below set the
readonly workflow fields. pending is "waiting on the customer" (Zendesk's pending).

## API
- /tickets: list (filters status, priority, customer_id, assignee_id, sla_breached, escalation_level; search subject;
  sort created_at, sla_due_at; 25 per page), get, create, update. No delete (405).
- /tickets/{ticket_id}/events and /comments: lists scoped to one ticket.
- /customers: list, get, create, update. /agents, /oncall, /sla_policies: list.
- Errors use { error: { code, message } }. Actions refuse with 404 not_found, 409 invalid_state, then the specific code.

## Workflow
- assign_ticket (POST /tickets/{id}/assign): new, open or pending to an active agent; new becomes open.
  409 agent_inactive, 409 no_change, 400 input.invalid for an unknown agent (the engine resolves ref inputs); escalated tickets belong to on-call (409 invalid_state).
- escalate_ticket (POST /tickets/{id}/escalate, reason): new, open or pending to escalated level 1, reassigned to the
  level 1 on-call agent at ctx.now(). 409 already_escalated when already escalated, 409 no_oncall with no shift.
- resolve_ticket (POST /tickets/{id}/resolve, note): open, pending or escalated to resolved; sets resolved_at.
- reopen_ticket (POST /tickets/{id}/reopen, reason): resolved to open, assignee kept, level 0, SLA restarted
  from the tier policy. Closed tickets cannot be reopened.
- Job sla_breach (15m) exists because the SLA is time-driven and no call happens when it runs out: it fills
  sla_due_at for API-created tickets, flags tickets past sla_due_at, and escalates breached urgent tickets
  with the escalate_ticket on-call rule. escalation_timeout (15m) pages level 2 after 60 minutes at level 1
  (urgent only). auto_close (1h) closes tickets resolved 72h ago.
- On-call runs in 12h blocks from S-7d to S+3d. At S level 1 is agt_0003 Marcus Bell, level 2 agt_0004 Dana
  Okafor. Level 2 has a gap from S+12h to S+24h.

## Seed
60 customers, 12 agents, 12 sla_policy rows, 39 shifts, 320 tickets (new 30, open 90, pending 30, escalated 40,
resolved 85, closed 45), with events and comments derived from each ticket's timeline. Anchors: cus_0001 Acme
Logistics and cus_0002 Acme Paper Co.; agt_0001 Priya Raman and agt_0002 Priya Shah; tkt_0001..tkt_0005.

## Tasks
- easy assign_newest_acme_ticket: assign Acme Logistics' newest unassigned ticket (tkt_0004) to Priya Raman.
  Decoys: assigns the first new ticket in id order (tkt_0003); PATCHes status to open with no assignee;
  assigns correctly then overwrites the target's subject and priority; assigns correctly then edits another ticket.
  ctx.guardChanges permits only the target's status and assignee_id changes and its new assignment events with the expected agent note and null actor.
- medium escalate_breached_printer_ticket: escalate the breached label printer ticket (tkt_0001) with an SLA reason.
  Decoys: escalates the newest printer ticket (tkt_0002); right ticket, reason without SLA (0.7); PATCHes status;
  assigns it to the on-call agent by hand first (same end state, caught by the ctx.trace() history guard).
- hard escalate_breached_enterprise_tickets: escalate the 7 open, high, breached enterprise tickets. The 35-row
  list spans two pages and three targets sit on page 2. Decoys: first page only (4/7); ignores the tier;
  reads open as not resolved; drops the breach filter; PATCHes status so nobody on call is assigned.
- Graders take targets from ctx.seed, score 0 on any other change in ctx.changes(), and check the on-call
  assignee at escalated_at, so a plain status PATCH never scores.
