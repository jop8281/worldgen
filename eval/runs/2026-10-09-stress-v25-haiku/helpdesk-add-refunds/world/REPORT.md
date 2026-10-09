# WorldGen report: Zendesk-style helpdesk ticketing API

A helpdesk where customers open tickets about their orders, agents reply, and tickets move between open, pending and resolved. Agents assign tickets, reply, resolve and reopen them. An agent can refund an order linked to a ticket. A refund above $500 waits for a lead's approval, and a ticket cannot be resolved while one of its refunds is pending. A stale pending ticket resolves itself after 7 days without an update, unless it has a pending refund. The world holds customers, agents, orders, tickets, comments (the replies on a ticket) and refunds, with list and get routes and create routes so tests can build their own rows.

## What was built

Entities (6):

- `customer`: 12 seeded rows
- `agent`: 4 seeded rows
- `order`: 16 seeded rows
- `ticket`: 28 seeded rows
- `comment`: 40 seeded rows
- `refund`: 0 seeded rows

Routes (15):

- `create_customer`: POST /customers
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_agent`: POST /agents
- `list_agents`: GET /agents
- `get_agent`: GET /agents/{id}
- `create_order`: POST /orders
- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `create_ticket`: POST /tickets
- `list_tickets`: GET /tickets
- `get_ticket`: GET /tickets/{id}
- `list_comments`: GET /comments
- `list_refunds`: GET /refunds
- `get_refund`: GET /refunds/{id}

Actions (8):

- `assign_ticket`: POST /tickets/{id}/assign
- `reply_to_ticket`: POST /tickets/{id}/reply
- `customer_reply`: POST /tickets/{id}/customer_reply
- `resolve_ticket`: POST /tickets/{id}/resolve
- `reopen_ticket`: POST /tickets/{id}/reopen
- `create_refund`: POST /tickets/{id}/refunds
- `approve_refund`: POST /refunds/{id}/approve
- `reject_refund`: POST /refunds/{id}/reject

Jobs (1):

- `close_stale_pending`: every 1d

## Changes

- item_added `entities.refund`
- item_added `routes.get_refund`
- item_added `routes.list_refunds`
- item_added `actions.approve_refund`
- item_added `actions.create_refund`
- item_added `actions.reject_refund`
- item_changed `actions.resolve_ticket.description`
- snippet_changed `actions.resolve_ticket.handler`
- item_changed `jobs.close_stale_pending.description`
- snippet_changed `jobs.close_stale_pending.run`
- item_added `tests.refund_decisions_need_lead`
- item_added `tests.refund_order_must_match_ticket`
- item_added `tests.refund_over_500_needs_lead`
- item_added `tests.refund_reject_releases_ticket`
- item_added `tests.refund_small_issues_directly`
- item_added `tests.resolve_blocked_by_pending_refund`

## Assumed and why

- Clock starts at 2026-10-01T09:00:00.000Z with tick 0s, so time moves only by explicit advance.
  - Why: Deterministic time after all seeded history; the 8-day stale-pending test advances explicitly.
- There is no authentication. An agent acts by sending agent_id in the request body.
  - Why: The input names no auth model, and the grader needs a way to tell which agent acts on a ticket.
- An order link on a ticket is optional (order_id nullable).
  - Why: Some tickets are general questions, and the input says tickets are about orders, not that every one must name one.
- An agent reply moves open to pending. A customer reply moves pending to open. Resolved takes no replies. Only resolved can be reopened.
  - Why: The input gives the three states and the moves between them, but not which action causes each move.
- A pending ticket with no update for 7 days resolves itself through the daily job close_stale_pending.
  - Why: The input does not say what happens to stale tickets. The 7-day window is a common helpdesk default.
- Only the assigned agent can resolve a ticket, and an unassigned ticket cannot be resolved. Both answer 409.
  - Why: The input does not state a resolve rule. Making it a permission check gives the permissions task a real rule to test.
- Entity and field names follow Zendesk: ticket with subject and description, comment for replies, requester as customer_id.
  - Why: Fidelity to the real software, which uses these names.
- Tests create their own customers, agents, orders and tickets through the create routes, and use the example.test domain and QA subjects.
  - Why: Acceptance tests may not rely on seed rows, and this keeps them clear of seed values (test.seed_collision).
- Create routes exist for customer, agent, order and ticket, and the list routes are cursor mode with pageSize 25.
  - Why: Tests need to create rows through the API, and 28 seeded tickets with pageSize 25 make paging matter just over one page.
- Refunds and money movement are out of scope. The world holds no payment rows.
  - Why: The input is about tickets and replies, and no money moves in them.
- Refunds are recorded as refund rows with a status of pending, issued or rejected. No money moves and no payment rows exist.
  - Why: The request asks for refund decisions, not payment processing. This supersedes the earlier assumption that refunds are out of scope; the outOfScope entry on payments still holds.
- The approval threshold is 50000 minor units in USD ($500.00). A refund above it is pending. A refund of exactly $500.00 or less is issued at once.
  - Why: Money is stored in integer minor units, and the request says above $500, so equal to $500 does not need approval.
- Every refund is created pending, and a refund at or under the threshold is moved to issued within the same create call.
  - Why: A state field's create must start at its initial state, so the create cannot store issued directly.
- A supervisor is an agent whose role is lead. approve_refund and reject_refund take supervisor_id in the body and answer 409 not_supervisor for any other agent.
  - Why: The agent role already has agent and lead values, and the world has no auth model, so the acting agent is passed in the body as the earlier plan does.
- A refund must name the order its ticket is linked to. Any other order answers 422 order_not_on_ticket.
  - Why: The request says an order linked to a ticket. A ticket with no order therefore cannot be refunded.
- A ticket with a pending refund cannot be resolved (409 refund_pending). The stale-pending job skips such tickets.
  - Why: The request says resolve is blocked while a refund is pending. The job also resolves tickets, so it must respect the same rule.
- A rejected or issued refund no longer blocks its ticket. A refund has no amount cap, and a ticket may have several refunds.
  - Why: The request sets no cap, and a rejected refund must not block a ticket forever.
- Seed creates no refund rows. Tests create their own refunds through the API.
  - Why: The request does not ask for seeded refunds, and no task depends on them. The seed stage is unchanged.
- Test order numbers use the #W9xxxxxx form, such as #W9000001, which matches the seed order pattern #W[0-9]{7} and stays clear of the seed's #W1xxxxxx numbers.
  - Why: The engine rejects order numbers that do not match /^#W[0-9]{7}$/, and test.seed_collision forbids test values the seed already uses.

## Questions asked of the input

- Can customers open tickets through the API themselves, or only agents?
  - Default answer: Anyone calling the API can open a ticket. There is no caller check.
- Must every ticket be about an order?
  - Default answer: No. order_id is optional.
- Should a stale pending ticket resolve itself, and after how long?
  - Default answer: Yes, after 7 days without an update, through the daily job close_stale_pending.
- Which agent may resolve a ticket?
  - Default answer: Only the assigned agent. An unassigned ticket cannot be resolved.
- Does an agent reply change the status?
  - Default answer: Yes. Open becomes pending. A customer reply moves pending back to open.
- Is the $500 threshold in USD, and is exactly $500.00 approved automatically?
  - Default answer: Yes, USD. A refund above 50000 minor units needs a lead. Exactly $500.00 is issued at once.
- Who counts as a supervisor?
  - Default answer: An agent whose role is lead.
- Can a refund be made on a ticket with no order, or on an order the ticket does not name?
  - Default answer: No. The order must be the ticket's own order_id, else 422 order_not_on_ticket.
- Is there a cap on refunds per order or per ticket?
  - Default answer: No cap. Several refunds may exist on one ticket.
- Does a rejected refund still block the ticket from resolving?
  - Default answer: No. A rejected refund no longer blocks its ticket.
- Should the stale-pending job resolve a ticket that has a pending refund?
  - Default answer: No. The job skips tickets with a pending refund, because the request says resolve is blocked while a refund is pending.

## Left out

- Refunds, payments and money movement on orders
  - Why: The input is about support tickets and replies, not payments.
- Authentication, roles and sessions
  - Why: The input names no auth model; the acting agent is passed in the body.
- Email, chat or attachment channels
  - Why: The input describes ticket and reply handling only.
- SLA timers and escalations beyond the 7-day stale auto-resolve
  - Why: Not in the input; one job is enough to show time-driven behavior.
- Ticket merge, macros, groups and internal notes
  - Why: Not in the input.

## Proof

The engine check passed: 13 world tests, 3 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_1e4423246a2df0ceab44ee1fbbb0c5b694b0281bbc91ba17acbf280f567774db`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| reply_to_damaged_order | easy | 1.000 | 0.000 | 0.500 | n/a | declared (2); mutants 4/8 | `tid_6a044ba973cc341ce1098317a7c46d510fa0e15b121b5ffc3b9a7f5fc232a65e` |
| resolve_assigned_late_delivery | medium | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 4/8 | `tid_1d31f1edfc10dfa13e333c5c96e6add02278bac1c2661835bc301ec53973ce29` |
| assign_reply_resolve_refund | hard | 1.000 | 0.000 | 0.250, 0.000 | 0.450 | declared (2); mutants 5/8 | `tid_cc88cab17be3d7c3de60e87c8adffb6277325b30fbb84258d91e81b2847fe476` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `reply_to_damaged_order` 0.500: replies as Ben Carter instead of Ava Brooks, so the reply carries the wrong agent
- `resolve_assigned_late_delivery` 0.000: replies as Ava Brooks, the lead who is not the assignee, then tries to resolve; the resolve is refused but the extra reply is a write the instruction does not ask for
- `resolve_assigned_late_delivery` 0.000: reassigns the ticket to Ava Brooks and resolves it as Ava, changing the assignee, which the instruction does not ask for
- `assign_reply_resolve_refund` 0.250: replies and resolves without assigning first, so resolve answers 409 unassigned and the ticket is never closed
- `assign_reply_resolve_refund` 0.000: reads only the first page, finds Priya's Refund timing ticket there and works that ticket instead of the open Refund not received ticket on page 2

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| reply_to_damaged_order | easy | 2 | none | ticket | distractors: met; state: met |
| resolve_assigned_late_delivery | medium | 1 | none | ticket | distractors: met; state: met |
| assign_reply_resolve_refund | hard | 2 | ticket | ticket | hard: met; paging: met; distractors: met; state: met |

## Run

Mode: iterate from change_request. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 2.22 | 0.0389 |
| model | 1 | 0.28 | 0.0623 |
| workflow | 3 | 1.33 | 0.2232 |
| tasks | 1 | 1.18 | 0.1081 |
| Total | 7 | 5.00 | 0.4325 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `seed`: no planned change reaches seed, entities, fixtures

Backtracks:

- `workflow` to `plan`: 6 issues

Run total: 5.02 minutes, $0.4325.
