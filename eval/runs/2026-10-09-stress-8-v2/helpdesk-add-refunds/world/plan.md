# WorldGen plan: Zendesk-style helpdesk for order support tickets

Customers open tickets about their orders. Agents are assigned, reply (moving the ticket to pending), and resolve. Customer replies reopen pending tickets. Resolved tickets can be reopened.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A shopper who opens tickets. | name, email |
| `agent` | A support agent who can be assigned tickets; only active agents can be assigned. Has a role: agent or supervisor (supervisors approve large refunds). | name, email, active, role |
| `order` | A customer order a ticket is about. | number, customer_id, status |
| `ticket` | A support ticket about an order, with state open, pending or resolved and an optional assignee. | subject, customer_id, order_id, assignee_id, status, resolved_at |
| `comment` | A message on a ticket from the customer or an agent. | ticket_id, author_kind, agent_id, body |
| `refund` | A refund of an order linked to a ticket, requested by the ticket's assigned agent. Amount in USD cents; above 50000 (the $500 threshold) it stays pending until a supervisor decides. | ticket_id, order_id, amount, reason, status, requested_by, decided_by, decided_at |

## Workflows

### ticket_lifecycle (ticket)
- States: open, pending, resolved
- Actions: create_ticket, assign_ticket, agent_reply, customer_reply, resolve_ticket, reopen_ticket
- Rules:
  - A ticket is created open and unassigned, with the customer's first comment; its order must belong to the same customer (422 order_mismatch). Enforced by: create_ticket. Tested by: ticket_create_checks_order_owner
  - Only an active agent can be assigned (409 agent_inactive). Enforced by: assign_ticket. Tested by: assign_requires_active_agent
  - Only the assigned agent can reply as an agent (409 not_assignee); unassigned tickets cannot be replied to by agents. Enforced by: agent_reply. Tested by: agent_reply_requires_assignee
  - An agent reply adds a comment and moves an open ticket to pending. Enforced by: agent_reply. Tested by: agent_reply_moves_open_to_pending
  - A customer reply adds a comment and moves a pending ticket back to open. Enforced by: customer_reply. Tested by: customer_reply_reopens_pending
  - Only the assigned agent can resolve, and only after at least one agent reply exists (409 no_agent_reply). Resolve works from open or pending and sets resolved_at. Enforced by: resolve_ticket. Tested by: resolve_needs_agent_reply
  - A ticket cannot be resolved while one of its refunds is pending (409 refund_pending). Enforced by: resolve_ticket. Tested by: resolve_blocked_by_pending_refund
  - A resolved ticket accepts no replies (409 invalid_state); only reopen_ticket moves it back to open, and reopen of a non-resolved ticket answers 409 invalid_state. Enforced by: agent_reply, customer_reply, reopen_ticket. Tested by: resolved_ticket_only_reopens
  - Ticket status only moves along open->pending/resolved, pending->open/resolved, resolved->open. Enforced by the data model: The state field transitions of ticket.status enforce this on every write.
### refund_lifecycle (refund)
- States: pending, approved, rejected
- Actions: request_refund, approve_refund, reject_refund
- Rules:
  - Only the ticket's assigned active agent can request a refund (409 not_assignee); the refund is for the ticket's own order and the amount is positive; a resolved ticket takes no new refunds (409 invalid_state). Enforced by: request_refund. Tested by: refund_requires_assignee
  - A refund of 50000 cents ($500) or less is approved at once; above 50000 it is created pending and needs a supervisor. Enforced by: request_refund. Tested by: refund_over_500_needs_approval
  - Only an active supervisor can approve or reject a pending refund (409 not_supervisor); a decided refund is final (409 invalid_state); decisions record decided_by and decided_at. Enforced by: approve_refund, reject_refund. Tested by: refund_decision_rules
  - Refund status only moves pending->approved/rejected. Enforced by the data model: The state field transitions of refund.status enforce this on every write.

## Jobs

None. The plan declares no job.

## Acceptance tests

### ticket_create_checks_order_owner
- Intent: create_ticket makes an open unassigned ticket with a first customer comment and refuses another customer's order
- Actions: create_ticket
- Description: Create ticket for own order succeeds; for another customer's order answers 422 order_mismatch.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Ann Test', email: 'tc-create-1@example.com' });
const c2 = mk('/customers', { name: 'Bob Test', email: 'tc-create-2@example.com' });
const o = mk('/orders', { number: 'TC-CREATE-1', customer_id: c.id, status: 'shipped' });
const r = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Late parcel', body: 'Where is my order?' });
ctx.assert(r.status === 201, 'create should answer 201, got ' + r.status + JSON.stringify(r.body));
ctx.assert(r.body.status === 'open' && r.body.assignee_id === null, 'ticket should be open and unassigned');
const cm = ctx.api('GET', '/comments?ticket_id=' + r.body.id).body.data;
ctx.assert(cm.length === 1 && cm[0].author_kind === 'customer' && cm[0].body === 'Where is my order?', 'first comment missing');
const bad = ctx.api('POST', '/tickets', { customer_id: c2.id, order_id: o.id, subject: 'Not mine', body: 'x' });
ctx.assert(bad.status === 422 && bad.body.error.code === 'order_mismatch', 'foreign order should answer 422 order_mismatch, got ' + JSON.stringify(bad.body));
}
```
### assign_requires_active_agent
- Intent: assign_ticket sets the assignee only for active agents
- Actions: create_ticket, assign_ticket
- Description: Assigning an inactive agent answers 409 agent_inactive; an active agent is assigned.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Cy Test', email: 'tc-assign-c@example.com' });
const o = mk('/orders', { number: 'TC-ASSIGN-1', customer_id: c.id, status: 'shipped' });
const a1 = mk('/agents', { name: 'Active Agent', email: 'tc-assign-a1@example.com', active: true });
const a2 = mk('/agents', { name: 'Gone Agent', email: 'tc-assign-a2@example.com', active: false });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Help', body: 'Please help' }).body;
const bad = ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a2.id });
ctx.assert(bad.status === 409 && bad.body.error.code === 'agent_inactive', 'inactive agent should answer 409 agent_inactive, got ' + JSON.stringify(bad.body));
const ok = ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a1.id });
ctx.assert(ok.status === 200 && ok.body.assignee_id === a1.id, 'assign failed: ' + JSON.stringify(ok.body));
}
```
### agent_reply_requires_assignee
- Intent: only the assigned agent can reply
- Actions: create_ticket, assign_ticket, agent_reply
- Description: Reply on an unassigned ticket or by another agent answers 409 not_assignee; the assignee succeeds.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Di Test', email: 'tc-perm-c@example.com' });
const o = mk('/orders', { number: 'TC-PERM-1', customer_id: c.id, status: 'shipped' });
const a1 = mk('/agents', { name: 'Owner Agent', email: 'tc-perm-a1@example.com', active: true });
const a2 = mk('/agents', { name: 'Other Agent', email: 'tc-perm-a2@example.com', active: true });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Broken', body: 'It arrived broken' }).body;
const un = ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a1.id, body: 'Hi' });
ctx.assert(un.status === 409 && un.body.error.code === 'not_assignee', 'unassigned reply should answer 409 not_assignee, got ' + JSON.stringify(un.body));
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a1.id });
const bad = ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a2.id, body: 'Hi' });
ctx.assert(bad.status === 409 && bad.body.error.code === 'not_assignee', 'other agent should answer 409 not_assignee');
const ok = ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a1.id, body: 'Sorry about that' });
ctx.assert(ok.status === 200, 'assignee reply failed: ' + JSON.stringify(ok.body));
}
```
### agent_reply_moves_open_to_pending
- Intent: an agent reply adds an agent comment and makes the ticket pending
- Actions: create_ticket, assign_ticket, agent_reply
- Description: After the assignee replies the ticket is pending and has an agent comment.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Eve Test', email: 'tc-pend-c@example.com' });
const o = mk('/orders', { number: 'TC-PEND-1', customer_id: c.id, status: 'processing' });
const a = mk('/agents', { name: 'Pend Agent', email: 'tc-pend-a@example.com', active: true });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Change address', body: 'Need to change address' }).body;
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a.id });
const r = ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a.id, body: 'What is the new address?' });
ctx.assert(r.status === 200 && r.body.status === 'pending', 'ticket should be pending: ' + JSON.stringify(r.body));
const cm = ctx.api('GET', '/comments?ticket_id=' + t.id + '&author_kind=agent').body.data;
ctx.assert(cm.length === 1 && cm[0].agent_id === a.id && cm[0].body === 'What is the new address?', 'agent comment missing');
}
```
### customer_reply_reopens_pending
- Intent: a customer reply moves a pending ticket back to open
- Actions: create_ticket, assign_ticket, agent_reply, customer_reply
- Description: Customer reply on pending ticket makes it open and adds a customer comment.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Fay Test', email: 'tc-cr-c@example.com' });
const o = mk('/orders', { number: 'TC-CR-1', customer_id: c.id, status: 'shipped' });
const a = mk('/agents', { name: 'CR Agent', email: 'tc-cr-a@example.com', active: true });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Refund', body: 'Refund please' }).body;
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a.id });
ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a.id, body: 'Which item?' });
const r = ctx.api('POST', '/tickets/' + t.id + '/customer_reply', { body: 'The blue mug' });
ctx.assert(r.status === 200 && r.body.status === 'open', 'ticket should be open again: ' + JSON.stringify(r.body));
const cm = ctx.api('GET', '/comments?ticket_id=' + t.id + '&author_kind=customer').body.data;
ctx.assert(cm.length === 2, 'expected two customer comments, got ' + cm.length);
}
```
### resolve_needs_agent_reply
- Intent: resolve requires the assignee and a prior agent reply
- Actions: create_ticket, assign_ticket, agent_reply, resolve_ticket
- Description: Resolve before any agent reply answers 409 no_agent_reply; other agent gets not_assignee; assignee resolves from pending and resolved_at is set.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Gus Test', email: 'tc-res-c@example.com' });
const o = mk('/orders', { number: 'TC-RES-1', customer_id: c.id, status: 'delivered' });
const a = mk('/agents', { name: 'Res Agent', email: 'tc-res-a@example.com', active: true });
const b = mk('/agents', { name: 'Res Other', email: 'tc-res-b@example.com', active: true });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Question', body: 'Quick question' }).body;
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a.id });
const early = ctx.api('POST', '/tickets/' + t.id + '/resolve', { agent_id: a.id });
ctx.assert(early.status === 409 && early.body.error.code === 'no_agent_reply', 'early resolve should answer 409 no_agent_reply, got ' + JSON.stringify(early.body));
ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a.id, body: 'Answered' });
const other = ctx.api('POST', '/tickets/' + t.id + '/resolve', { agent_id: b.id });
ctx.assert(other.status === 409 && other.body.error.code === 'not_assignee', 'other agent cannot resolve');
const ok = ctx.api('POST', '/tickets/' + t.id + '/resolve', { agent_id: a.id });
ctx.assert(ok.status === 200 && ok.body.status === 'resolved' && ok.body.resolved_at, 'resolve failed: ' + JSON.stringify(ok.body));
}
```
### resolved_ticket_only_reopens
- Intent: resolved tickets refuse replies and can only be reopened
- Actions: create_ticket, assign_ticket, agent_reply, resolve_ticket, customer_reply, reopen_ticket
- Description: Replies on a resolved ticket answer 409 invalid_state; reopen returns it to open; reopening an open ticket answers 409.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Hal Test', email: 'tc-reo-c@example.com' });
const o = mk('/orders', { number: 'TC-REO-1', customer_id: c.id, status: 'delivered' });
const a = mk('/agents', { name: 'Reo Agent', email: 'tc-reo-a@example.com', active: true });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Wrong size', body: 'Wrong size' }).body;
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a.id });
ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a.id, body: 'Exchange sent' });
ctx.api('POST', '/tickets/' + t.id + '/resolve', { agent_id: a.id });
const r1 = ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a.id, body: 'More' });
ctx.assert(r1.status === 409 && r1.body.error.code === 'invalid_state', 'agent reply on resolved should answer 409 invalid_state');
const r2 = ctx.api('POST', '/tickets/' + t.id + '/customer_reply', { body: 'Thanks' });
ctx.assert(r2.status === 409 && r2.body.error.code === 'invalid_state', 'customer reply on resolved should answer 409 invalid_state');
const re = ctx.api('POST', '/tickets/' + t.id + '/reopen', {});
ctx.assert(re.status === 200 && re.body.status === 'open', 'reopen failed: ' + JSON.stringify(re.body));
const again = ctx.api('POST', '/tickets/' + t.id + '/reopen', {});
ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'reopening an open ticket should answer 409');
}
```
### refund_requires_assignee
- Intent: only the assigned agent can request a refund on a ticket's order
- Actions: create_ticket, assign_ticket, request_refund
- Description: Unassigned or other agent gets 409 not_assignee; assignee gets an approved small refund for the ticket's order.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Ivy Test', email: 'tc-rf1-c@example.com' });
const o = mk('/orders', { number: 'TC-RF-1', customer_id: c.id, status: 'delivered' });
const a1 = mk('/agents', { name: 'Rf Owner', email: 'tc-rf1-a1@example.com', active: true });
const a2 = mk('/agents', { name: 'Rf Other', email: 'tc-rf1-a2@example.com', active: true });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Damaged', body: 'Item damaged' }).body;
const un = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a1.id, amount: 1000, reason: 'Damaged' });
ctx.assert(un.status === 409 && un.body.error.code === 'not_assignee', 'unassigned should answer 409 not_assignee, got ' + JSON.stringify(un.body));
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a1.id });
const bad = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a2.id, amount: 1000, reason: 'Damaged' });
ctx.assert(bad.status === 409 && bad.body.error.code === 'not_assignee', 'other agent should answer 409 not_assignee');
const ok = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a1.id, amount: 1000, reason: 'Damaged' });
ctx.assert(ok.status < 300 && ok.body.order_id === o.id && ok.body.ticket_id === t.id && ok.body.requested_by === a1.id, 'refund failed: ' + JSON.stringify(ok.body));
}
```
### refund_over_500_needs_approval
- Intent: refunds above $500 stay pending, $500 or less are approved at once
- Actions: create_ticket, assign_ticket, request_refund
- Description: 50000 cents is approved immediately; 50001 is pending.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Jo Test', email: 'tc-rf2-c@example.com' });
const o = mk('/orders', { number: 'TC-RF-2', customer_id: c.id, status: 'delivered' });
const a = mk('/agents', { name: 'Rf Two', email: 'tc-rf2-a@example.com', active: true });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Wrong item', body: 'Wrong item sent' }).body;
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a.id });
const small = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a.id, amount: 50000, reason: 'Limit' });
ctx.assert(small.status < 300 && small.body.status === 'approved', '$500 should be approved: ' + JSON.stringify(small.body));
const big = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a.id, amount: 50001, reason: 'Over limit' });
ctx.assert(big.status < 300 && big.body.status === 'pending', 'above $500 should be pending: ' + JSON.stringify(big.body));
const l = ctx.api('GET', '/refunds?ticket_id=' + t.id + '&status=pending').body.data;
ctx.assert(l.length === 1 && l[0].id === big.body.id, 'pending list should hold the big refund');
}
```
### refund_decision_rules
- Intent: only supervisors decide pending refunds, and decisions are final
- Actions: create_ticket, assign_ticket, request_refund, approve_refund, reject_refund
- Description: Non-supervisor gets 409 not_supervisor; supervisor approves or rejects; a second decision answers 409 invalid_state.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Kit Test', email: 'tc-rf3-c@example.com' });
const o = mk('/orders', { number: 'TC-RF-3', customer_id: c.id, status: 'delivered' });
const a = mk('/agents', { name: 'Rf Three', email: 'tc-rf3-a@example.com', active: true });
const s = mk('/agents', { name: 'Rf Boss', email: 'tc-rf3-s@example.com', active: true, role: 'supervisor' });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Big loss', body: 'Lost parcel' }).body;
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a.id });
const r1 = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a.id, amount: 75000, reason: 'Lost' }).body;
const r2 = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a.id, amount: 60000, reason: 'Lost 2' }).body;
const no = ctx.api('POST', '/refunds/' + r1.id + '/approve', { supervisor_id: a.id });
ctx.assert(no.status === 409 && no.body.error.code === 'not_supervisor', 'non supervisor should answer 409 not_supervisor, got ' + JSON.stringify(no.body));
const ok = ctx.api('POST', '/refunds/' + r1.id + '/approve', { supervisor_id: s.id });
ctx.assert(ok.status === 200 && ok.body.status === 'approved' && ok.body.decided_by === s.id && ok.body.decided_at, 'approve failed: ' + JSON.stringify(ok.body));
const again = ctx.api('POST', '/refunds/' + r1.id + '/reject', { supervisor_id: s.id });
ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'decided refund is final');
const rej = ctx.api('POST', '/refunds/' + r2.id + '/reject', { supervisor_id: s.id });
ctx.assert(rej.status === 200 && rej.body.status === 'rejected', 'reject failed: ' + JSON.stringify(rej.body));
}
```
### resolve_blocked_by_pending_refund
- Intent: a ticket with a pending refund cannot be resolved
- Actions: create_ticket, assign_ticket, agent_reply, request_refund, reject_refund, resolve_ticket
- Description: Resolve answers 409 refund_pending while a refund is pending, and succeeds once it is decided.

```js
(ctx) => {
const mk = (p, b) => ctx.api('POST', p, b).body;
const c = mk('/customers', { name: 'Lou Test', email: 'tc-rf4-c@example.com' });
const o = mk('/orders', { number: 'TC-RF-4', customer_id: c.id, status: 'delivered' });
const a = mk('/agents', { name: 'Rf Four', email: 'tc-rf4-a@example.com', active: true });
const s = mk('/agents', { name: 'Rf Chief', email: 'tc-rf4-s@example.com', active: true, role: 'supervisor' });
const t = ctx.api('POST', '/tickets', { customer_id: c.id, order_id: o.id, subject: 'Refund me', body: 'Refund please' }).body;
ctx.api('POST', '/tickets/' + t.id + '/assign', { agent_id: a.id });
ctx.api('POST', '/tickets/' + t.id + '/agent_reply', { agent_id: a.id, body: 'Looking into it' });
const r = ctx.api('POST', '/tickets/' + t.id + '/refunds', { agent_id: a.id, amount: 90000, reason: 'Big order' }).body;
const blocked = ctx.api('POST', '/tickets/' + t.id + '/resolve', { agent_id: a.id });
ctx.assert(blocked.status === 409 && blocked.body.error.code === 'refund_pending', 'should answer 409 refund_pending, got ' + JSON.stringify(blocked.body));
ctx.api('POST', '/refunds/' + r.id + '/reject', { supervisor_id: s.id });
const ok = ctx.api('POST', '/tickets/' + t.id + '/resolve', { agent_id: a.id });
ctx.assert(ok.status === 200 && ok.body.status === 'resolved', 'resolve after decision failed: ' + JSON.stringify(ok.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_customers` | GET | /customers | List customers, filter by email. |
| `get_customer` | GET | /customers/{id} | Get a customer. |
| `create_customer` | POST | /customers | Create a customer. |
| `list_agents` | GET | /agents | List agents, filter by active or email. |
| `get_agent` | GET | /agents/{id} | Get an agent. |
| `create_agent` | POST | /agents | Create an agent. |
| `list_orders` | GET | /orders | List orders, filter by number, customer_id, status. |
| `get_order` | GET | /orders/{id} | Get an order. |
| `create_order` | POST | /orders | Create an order. |
| `list_tickets` | GET | /tickets | List tickets, filter by status, assignee_id, customer_id, order_id. |
| `get_ticket` | GET | /tickets/{id} | Get a ticket. |
| `list_comments` | GET | /comments | List comments, filter by ticket_id and author_kind. |
| `list_refunds` | GET | /refunds | List refunds, filter by ticket_id, order_id, status. |
| `get_refund` | GET | /refunds/{id} | Get a refund. |

## Seed

- Rows per entity: customer: 12, agent: 7, order: 28, ticket: 32, comment: 70, refund: 10
- Mix: Tickets spread over open, pending and resolved; about two thirds assigned to active agents, several open ones unassigned; customers with two or more tickets on different orders so near-duplicate tickets exist; pending and resolved tickets carry an agent comment; one inactive agent; two active supervisors among the agents. Refunds are on the ticket's own order, mostly approved with a few rejected and two pending above $500; no pending refund sits on the tickets the existing tasks resolve.
- State mix: ticket: open 40%, pending 35%, resolved 25%; refund: pending 20%, approved 60%, rejected 20%

## Tasks

- `assign_unassigned_ticket` (easy, permissions): Find the open unassigned ticket about a given order number and assign it to a named active agent.
  - Actions: `assign_ticket`
  - Decoy idea: Assigns the customer's other open ticket (about a different order), or assigns the inactive agent with a similar name.
  - Pressure: seeded rows in ticket.open; distractor rows of ticket
- `reply_as_assignee_on_right_ticket` (medium, permissions): A customer has two open tickets about different orders; reply to the one about the named order as its assigned agent with a given message, so it becomes pending.
  - Actions: `agent_reply`
  - Decoy idea: Replies on the customer's other open ticket, leaving the target open.
  - Pressure: paging past the first page of ticket; seeded rows in ticket.open; distractor rows of ticket
- `customer_confirms_then_resolve` (hard, two_actors): For a pending ticket about a named order, record the customer's reply saying the issue is fixed, then resolve it as its assigned agent (both sides act in order).
  - Actions: `customer_reply`, `resolve_ticket`
  - Decoy idea: Resolves without the customer's reply, or posts only the customer reply and leaves the ticket open, or resolves a different pending ticket of the same customer.
  - Pressure: paging past the first page of ticket; seeded rows in ticket.pending; distractor rows of ticket
- `approve_large_refund_and_resolve` (medium, two_actors): For the ticket about a named order, as its assigned agent request a $750 refund, then as a supervisor approve it, then resolve the ticket (resolve is blocked until the refund is decided).
  - Actions: `request_refund`, `approve_refund`, `resolve_ticket`
  - Decoy idea: Requests the refund but never has a supervisor approve it, leaving the ticket unresolved, or approves with a non-supervisor agent.

## Open questions

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

## Assumptions

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

## Out of scope

- Authentication, SLAs, priorities, tags, attachments, email channels
  - Why: Not needed for the core ticket reply/resolve flow.
- Order management actions (cancel, refund)
  - Why: Orders are reference data for tickets only.

## Changes

- agent.fields.role because agent can refund and a supervisor's approval
- workflows.ticket_lifecycle because a ticket cannot be resolved while one of its refunds is pending
- seed because refunds and a supervisor agent need seeded rows
- seed.agent because a supervisor's approval needs supervisor agents
