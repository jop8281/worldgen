# WorldGen report: Zendesk-style helpdesk (tickets, comments, agents, customers)

A helpdesk where customers open tickets about their orders, agents are assigned and reply, and tickets move open -> pending -> resolved (and back when the customer replies or the ticket is reopened). A daily job auto-resolves pending tickets that have gone quiet.

## What was built

Entities (6):

- `customer`: 8 seeded rows
- `agent`: 5 seeded rows
- `ticket`: 32 seeded rows
- `comment`: 40 seeded rows
- `order`: 24 seeded rows
- `refund`: 10 seeded rows

Routes (15):

- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `list_agents`: GET /agents
- `get_agent`: GET /agents/{id}
- `create_agent`: POST /agents
- `list_tickets`: GET /tickets
- `get_ticket`: GET /tickets/{id}
- `create_ticket`: POST /tickets
- `list_comments`: GET /comments
- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `create_order`: POST /orders
- `list_refunds`: GET /refunds
- `get_refund`: GET /refunds/{id}

Actions (8):

- `assign_ticket`: POST /tickets/{id}/assign
- `agent_reply`: POST /tickets/{id}/reply
- `customer_reply`: POST /tickets/{id}/customer-reply
- `resolve_ticket`: POST /tickets/{id}/resolve
- `reopen_ticket`: POST /tickets/{id}/reopen
- `request_refund`: POST /tickets/{id}/refunds
- `approve_refund`: POST /refunds/{id}/approve
- `reject_refund`: POST /refunds/{id}/reject

Jobs (1):

- `auto_resolve_stale_pending`: every 1d

## Changes

- field_added `entities.agent.fields.role`
- item_added `entities.order`
- item_added `entities.refund`
- item_added `routes.create_order`
- item_added `routes.get_order`
- item_added `routes.get_refund`
- item_added `routes.list_orders`
- item_added `routes.list_refunds`
- item_added `actions.approve_refund`
- item_added `actions.reject_refund`
- item_added `actions.request_refund`
- item_changed `actions.resolve_ticket.description`
- snippet_changed `actions.resolve_ticket.handler`
- snippet_changed `seed.agent`
- item_added `seed.order`
- item_added `seed.refund`
- snippet_changed `seed.ticket`
- item_added `tests.t_refund_approval`
- item_added `tests.t_refund_small`
- item_added `tests.t_resolve_blocked`
- item_added `tasks.refund_large_and_approve`

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; all seeded history is before it.
  - Why: Time moves only explicitly, so the auto-resolve job is testable and deterministic.
- Three ticket states: open, pending (awaiting customer), resolved. No closed state.
  - Why: The request names exactly these states.
- Agent reply moves open to pending; customer reply moves pending to open; resolved tickets accept no replies until reopened.
  - Why: Standard helpdesk semantics.
- Pending tickets with no activity for more than 3 days are auto-resolved by a daily job.
  - Why: Common helpdesk automation; gives the pending state a time dimension.
- Actions take agent_id in the body instead of auth; no login or roles beyond agent.active.
  - Why: The world has no authentication layer.
- Handler errors use codes agent_inactive, invalid_state, not_assigned with status 409.
  - Why: Distinguishes domain refusals from engine errors.
- Resolve requires an assignee.
  - Why: A ticket must be owned before being closed out.
- Orders are a new entity matched to tickets by order_number and customer; ticket is unchanged.
  - Why: Keeps the existing ticket model and tests intact.
- Agents get a role field (agent or supervisor, default agent); a supervisor is an agent with role supervisor.
  - Why: No auth layer exists, so approval identity is passed as agent_id.
- The $500 threshold is inclusive: 50000 minor units or less auto-approves; above needs approval.
  - Why: 'Above $500' means strictly greater.
- Refund requests are refused if non-rejected refunds would exceed the order total.
  - Why: Prevents over-refunding.
- Rejecting a pending refund also unblocks resolving; reject_refund is supervisor-only.
  - Why: Pending is the only blocking state.
- Currency is USD in minor units.
  - Why: Request uses dollars.

## Questions asked of the input

- Should there be a closed state after resolved?
  - Default answer: No; only open, pending, resolved.
- Can any agent reply or only the assignee?
  - Default answer: Any active agent may reply; assignment is required only to resolve.
- Should stale pending tickets auto-resolve?
  - Default answer: Yes, after 3 days without activity.
- Can a supervisor approve a refund they requested themselves?
  - Default answer: Yes; no separation-of-duties rule.
- Does the order need to match the ticket's order_number?
  - Default answer: Yes, and the same customer.

## Left out

- Email ingestion, attachments, SLAs, macros, satisfaction ratings
  - Why: Not needed for core ticket state workflow.
- Authentication and permissions per user
  - Why: Agent identity is passed explicitly in the action body.
- Ticket deletion
  - Why: Tickets are never removed.
- Actual payment processing, partial reversals, refund deletion
  - Why: Only the approval workflow and ticket-resolution guard are requested.

## Proof

The engine check passed: 9 world tests, 3 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_6b3d50671c9b55f678ab9aa51268b0af15eb13d9b9c08c18a1438bd261c166ef`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| assign_open_ticket | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 5/8 | `tid_9c216f12c00297066a3a8f69ae5b6ae77fa213ca0247c80f47d38625f71a034c` |
| reply_to_customer_ticket | medium | 1.000 | 0.000 | 0.700, 0.000 | n/a | declared (2); mutants 4/8 | `tid_50450e04145109470f67e4c581a6404d19e8796e4aef27f0f9faed321ffb0758` |
| triage_and_resolve | hard | 1.000 | 0.000 | 0.650, 0.350 | 0.650 | declared (2); mutants 5/8 | `tid_57c519ae7788e01a6ab53e77112a6647bba68a4c6c0cc84b16ff344f43aba9ea` |
| refund_large_and_approve | medium | 1.000 | 0.000 | 0.400, 0.000, 0.000 | 0.400 | declared (2); mutants 2/8 | `tid_fe1f4f0d37497bda0905c7816da3a9cfbb51f06da614bef73307881890dd88d6` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `assign_open_ticket` 0.000: assigns Dana Reyes to Maya's other open, unassigned ticket (order #W2000116) instead of the one about #W2000108
- `reply_to_customer_ticket` 0.700: replies on the right ticket with the right text but as Priya Menon instead of Tom Hendricks
- `reply_to_customer_ticket` 0.000: replies as Tom Hendricks on Ethan's other ticket with the near-identical subject (order #W2000103)
- `triage_and_resolve` 0.650: assigns Priya and sends the reply but never resolves the ticket
- `triage_and_resolve` 0.350: does the whole assign, reply and resolve flow on the right ticket but as Dana Reyes instead of Priya Menon
- `refund_large_and_approve` 0.400: requests the $750 refund correctly but never has the supervisor approve it, leaving it pending
- `refund_large_and_approve` 0.000: refunds and approves on Noor's other open ticket (order #W2000105) instead of the one about #W2000121
- `refund_large_and_approve` 0.000: requests only $500 on the right order, which auto-approves without any supervisor, instead of the $750 refund asked for

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| assign_open_ticket | easy | 1 | none | ticket | distractors: met |
| reply_to_customer_ticket | medium | 2 | none | ticket | distractors: met; state: met |
| triage_and_resolve | hard | 2 | ticket | ticket | hard: met; paging: met; distractors: met; state: met; state: met |
| refund_large_and_approve | medium | 1 | none | none | none declared |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 5 | 1.71 | 0.7547 |
| model | 3 | 0.67 | 0.4521 |
| workflow | 1 | 0.29 | 0.1615 |
| seed | 1 | 0.45 | 0.1766 |
| tasks | 2 | 1.20 | 0.4148 |
| Total | 12 | 4.32 | 1.9598 |

Backtracks:

- `model` to `plan`: 1 issue
- `model` to `plan`: 1 issue

Run total: 4.34 minutes, $1.9598.
