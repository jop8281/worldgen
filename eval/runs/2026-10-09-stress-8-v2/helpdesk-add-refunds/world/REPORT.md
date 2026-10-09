# WorldGen report: Zendesk-style helpdesk for order support tickets

Customers open tickets about their orders. Agents are assigned, reply (moving the ticket to pending), and resolve. Customer replies reopen pending tickets. Resolved tickets can be reopened.

## What was built

Entities (6):

- `customer`: 12 seeded rows
- `agent`: 7 seeded rows
- `order`: 28 seeded rows
- `ticket`: 32 seeded rows
- `comment`: 78 seeded rows
- `refund`: 10 seeded rows

Routes (14):

- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `list_agents`: GET /agents
- `get_agent`: GET /agents/{id}
- `create_agent`: POST /agents
- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `create_order`: POST /orders
- `list_tickets`: GET /tickets
- `get_ticket`: GET /tickets/{id}
- `list_comments`: GET /comments
- `list_refunds`: GET /refunds
- `get_refund`: GET /refunds/{id}

Actions (9):

- `create_ticket`: POST /tickets
- `assign_ticket`: POST /tickets/{id}/assign
- `agent_reply`: POST /tickets/{id}/agent_reply
- `customer_reply`: POST /tickets/{id}/customer_reply
- `resolve_ticket`: POST /tickets/{id}/resolve
- `reopen_ticket`: POST /tickets/{id}/reopen
- `request_refund`: POST /tickets/{id}/refunds
- `approve_refund`: POST /refunds/{id}/approve
- `reject_refund`: POST /refunds/{id}/reject

Jobs: none.

## Changes

- field_added `entities.agent.fields.role`
- item_added `entities.refund`
- item_added `routes.get_refund`
- item_added `routes.list_refunds`
- item_added `actions.approve_refund`
- item_added `actions.reject_refund`
- item_added `actions.request_refund`
- snippet_changed `actions.resolve_ticket.handler`
- snippet_changed `seed.agent`
- item_added `seed.refund`
- item_added `tests.refund_decision_rules`
- item_added `tests.refund_over_500_needs_approval`
- item_added `tests.refund_requires_assignee`
- item_added `tests.resolve_blocked_by_pending_refund`
- item_added `tasks.approve_large_refund_and_resolve`

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; all seeded history is before this.
  - Why: Deterministic time after historical events; no future scheduled events needed.
- Ticket status changes only through actions; tickets are created via the create_ticket action at POST /tickets.
  - Why: Rules about assignee, replies and order ownership need enforcement.
- Single customer-facing and agent-facing API without authentication; the acting agent is passed as agent_id.
  - Why: Keeps the world simple while still modelling who may act.
- Agent reply moves open to pending; customer reply moves pending to open; replies on an already pending ticket by an agent keep it pending.
  - Why: Matches Zendesk-like open/pending semantics.
- Error codes: order_mismatch (422), agent_inactive, not_assignee, no_agent_reply, invalid_state (409).
  - Why: Action-specific failures need stable codes for tests.
- Refund actions: request_refund at POST /tickets/{id}/refunds (agent_id, amount in cents, reason), approve_refund and reject_refund at POST /refunds/{id}/approve|reject (supervisor_id). Refund is created pending then moved to approved in the same call when amount <= 50000.
  - Why: Keeps refund status changes inside actions and the state machine's initial state.
- Agent gains a role enum (agent, supervisor) defaulting to agent.
  - Why: Needed to tell who may approve large refunds.
- The earlier out-of-scope note on refunds is superseded by this request; order records themselves are not changed by a refund.
  - Why: The change request explicitly adds refunds.
- Error codes: not_assignee, invalid_state, not_supervisor, refund_pending (409).
  - Why: Stable codes for tests.

## Questions asked of the input

- Should there be a closed state after resolved?
  - Default answer: No; only open, pending and resolved, with reopen.
- Do customers also authenticate or can anyone reply on a ticket?
  - Default answer: No auth; customer_reply is made on behalf of the ticket's customer.
- Can agents resolve tickets they are not assigned to?
  - Default answer: No; only the assignee may reply or resolve.
- Is the $500 threshold inclusive?
  - Default answer: A refund of exactly $500 is approved at once; only amounts above $500 need approval.
- Can refunds exceed the order value or be partial?
  - Default answer: Orders carry no amount, so any positive amount is accepted; multiple refunds per order are allowed.
- Who is a supervisor?
  - Default answer: An agent with role supervisor; no authentication, the acting supervisor is passed as supervisor_id.

## Left out

- Authentication, SLAs, priorities, tags, attachments, email channels
  - Why: Not needed for the core ticket reply/resolve flow.
- Order management actions (cancel, refund)
  - Why: Orders are reference data for tickets only.

## Proof

The engine check passed: 11 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_46f5f9fdbc1e37bc75ab36875cdcb609c719ee8bc27fe581e504a505a5e355e3`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| assign_unassigned_ticket | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 3/8 | `tid_541f022095b5528dac0e22b04977f08633717ebe553ff9fd516146d819b16451` |
| reply_as_assignee_on_right_ticket | medium | 1.000 | 0.000 | 0.000, 0.500 | n/a | declared (2); mutants 2/8 | `tid_f61a48a9c2cb8b86f63c82ac8449a3ad2a830f3fda2d643bcf79c92a83dbc5c4` |
| customer_confirms_then_resolve | hard | 1.000 | 0.000 | 0.500, 0.500, 0.000 | 0.500 | declared (2); mutants 3/8 | `tid_b538e5e3a62524e9588e547a39b13952464a8eff9914b018350a935155e87020` |
| approve_large_refund_and_resolve | medium | 1.000 | 0.000 | 0.300, 0.400, 0.000, 0.700 | 0.600 | declared (2); mutants 4/8 | `tid_93e27b5b94b4c5f9b048b8ae53e6b7367319c5bc8efc76e7aad89dbac947c731` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `assign_unassigned_ticket` 0.000: assigns Dana Whitaker to the customer's other open unassigned ticket, about a different order, instead of the one about ORD-10231
- `assign_unassigned_ticket` 0.000: assigns the right ticket to a different active agent, Marcus Lee, instead of Dana Whitaker
- `reply_as_assignee_on_right_ticket` 0.000: replies as the assignee on Liam's other open ticket, about a different order, leaving the target ticket open
- `reply_as_assignee_on_right_ticket` 0.500: replies on the right ticket as its assignee but with different wording than the message asked for
- `customer_confirms_then_resolve` 0.500: resolves the ticket as its assignee without recording the customer's reply
- `customer_confirms_then_resolve` 0.500: posts only the customer's reply and never resolves, leaving the ticket open
- `customer_confirms_then_resolve` 0.000: records the reply and resolves Noor's other pending ticket, about a different order, instead of the one about ORD-10245
- `approve_large_refund_and_resolve` 0.300: requests the refund as the assignee but never has a supervisor approve it, so the refund stays pending and the ticket stays unresolved
- `approve_large_refund_and_resolve` 0.400: requests only $500 so it is approved at once without a supervisor, then resolves the ticket; the refund is not the $750 asked for
- `approve_large_refund_and_resolve` 0.000: does the refund and supervisor approval on Jack's other ticket, about a different order, instead of the ticket about ORD-10350
- `approve_large_refund_and_resolve` 0.700: does the whole flow on the right ticket but has the other supervisor, Rafael Quinn, approve instead of Helen Overton

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| assign_unassigned_ticket | easy | 1 | none | ticket | distractors: met; state: met |
| reply_as_assignee_on_right_ticket | medium | 2 | ticket | ticket | paging: met; distractors: met; state: met |
| customer_confirms_then_resolve | hard | 2 | ticket | ticket | hard: met; paging: met; distractors: met; state: met |
| approve_large_refund_and_resolve | medium | 2 | none | ticket | none declared |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.85 | 0.3362 |
| model | 1 | 0.17 | 0.1566 |
| workflow | 1 | 0.27 | 0.1739 |
| seed | 1 | 0.29 | 0.1757 |
| tasks | 2 | 1.39 | 0.4606 |
| Total | 6 | 2.97 | 1.3030 |

Run total: 2.99 minutes, $1.3030.
