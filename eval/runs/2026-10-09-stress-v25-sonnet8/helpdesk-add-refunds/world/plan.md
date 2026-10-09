# WorldGen plan: Zendesk-style helpdesk (tickets, comments, agents, customers)

A helpdesk where customers open tickets about their orders, agents are assigned and reply, and tickets move open -> pending -> resolved (and back when the customer replies or the ticket is reopened). A daily job auto-resolves pending tickets that have gone quiet.

- Revision: 4
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A shopper who opens tickets. | name, email |
| `agent` | A support agent. New field role (agent or supervisor, default agent); only an active supervisor may approve or reject a refund. | name, email, active, role |
| `ticket` | A support request about an order, with a state, an optional assignee and last activity time. | subject, customer_id, order_number, status, assignee_id, priority, last_activity_at |
| `comment` | A reply on a ticket, from an agent or the customer. | ticket_id, author_kind, agent_id, body |
| `order` | A customer's purchase, identified by order_number, with a total in USD. Tickets link to it by matching order_number. | order_number, customer_id, total |
| `refund` | A refund of part or all of an order, requested by an agent against a ticket. Above $500 it stays pending until a supervisor decides. | ticket_id, order_id, amount, status, requested_by, approved_by, reason |

## Workflows

### ticket_lifecycle (ticket)
- States: open, pending, resolved
- Actions: assign_ticket, agent_reply, customer_reply, resolve_ticket, reopen_ticket
- Rules:
  - A ticket may be assigned only to an active agent and only while not resolved. Enforced by: assign_ticket. Tested by: t_assign
  - An agent reply must come from an active agent, adds an agent comment, moves an open ticket to pending, and is refused on a resolved ticket. Enforced by: agent_reply. Tested by: t_agent_reply
  - A customer reply adds a customer comment, moves a pending ticket back to open, and is refused on a resolved ticket. Enforced by: customer_reply. Tested by: t_customer_reply
  - A ticket can be resolved only when it has an assignee and is not already resolved. Enforced by: resolve_ticket. Tested by: t_resolve
  - A ticket cannot be resolved while any of its refunds is pending; resolve is refused with 409 refund_pending until the refund is approved or rejected. Enforced by: resolve_ticket. Tested by: t_resolve_blocked
  - Only a resolved ticket can be reopened; it returns to open. Enforced by: reopen_ticket. Tested by: t_reopen
  - Pending tickets with no activity for more than 3 days are resolved automatically. Enforced by: auto_resolve_stale_pending. Tested by: t_auto_resolve
  - A new ticket starts open and unassigned. Enforced by the data model: The ticket status field is a state machine with initial open and assignee_id is nullable.
### refund_lifecycle (refund)
- States: pending, approved, rejected
- Actions: request_refund, approve_refund, reject_refund
- Rules:
  - An active agent can request a refund on a ticket for an order whose order_number and customer match the ticket. Amount must be positive and, with other non-rejected refunds of that order, within the order total (409 amount_exceeds_order); wrong order 409 order_mismatch; inactive agent 409 agent_inactive. A refund of $500 (50000 minor units) or less is approved immediately. Enforced by: request_refund. Tested by: t_refund_small
  - A refund above $500 stays pending and needs an active supervisor to approve or reject it; a non-supervisor is refused with 409 not_supervisor; only a pending refund can be decided (409 invalid_state otherwise). Approval records approved_by. Enforced by: approve_refund, reject_refund, request_refund. Tested by: t_refund_approval
  - A refund moves only pending to approved or rejected; approved and rejected are final. Enforced by the data model: The refund status state machine declares only those transitions.

## Jobs

- `auto_resolve_stale_pending` runs every 1d: Resolve every pending ticket whose last_activity_at is more than 3 days before now.

## Acceptance tests

### t_assign
- Intent: Assigning requires an active agent and an unresolved ticket.
- Actions: assign_ticket
- Description: Inactive agent refused with agent_inactive, active agent accepted, resolved ticket refused.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Assign Cust',email:'assign.cust@accept.invalid'});
ctx.assert(c.status===201,'customer create '+JSON.stringify(c.body));
const a = ctx.api('POST','/agents',{name:'Assign Active',email:'assign.active@accept.invalid',active:true}).body;
const i = ctx.api('POST','/agents',{name:'Assign Inactive',email:'assign.inactive@accept.invalid',active:false}).body;
const t = ctx.api('POST','/tickets',{subject:'Where is my parcel',description:'Late',customer_id:c.body.id,order_number:'#A1001'});
ctx.assert(t.status===201 && t.body.status==='open' && t.body.assignee_id===null,'ticket create '+JSON.stringify(t.body));
const bad = ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:i.id});
ctx.assert(bad.status===409 && bad.body.error.code==='agent_inactive','inactive agent: '+JSON.stringify(bad.body));
const ok = ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:a.id});
ctx.assert(ok.status===200 && ok.body.assignee_id===a.id && ok.body.status==='open','assign: '+JSON.stringify(ok.body));
ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/resolve',{}).status===200,'resolve');
const late = ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:a.id});
ctx.assert(late.status===409 && late.body.error.code==='invalid_state','assign resolved: '+JSON.stringify(late.body));
}
```
### t_agent_reply
- Intent: Agent reply records a comment and moves open to pending.
- Actions: agent_reply
- Description: Active agent reply creates a comment and sets pending; inactive agent refused; resolved ticket refused.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Reply Cust',email:'reply.cust@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'Reply Active',email:'reply.active@accept.invalid',active:true}).body;
const i = ctx.api('POST','/agents',{name:'Reply Inactive',email:'reply.inactive@accept.invalid',active:false}).body;
const t = ctx.api('POST','/tickets',{subject:'Damaged item',description:'Broken',customer_id:c.id,order_number:'#A2001'}).body;
const bad = ctx.api('POST','/tickets/'+t.id+'/reply',{agent_id:i.id,body:'hi'});
ctx.assert(bad.status===409 && bad.body.error.code==='agent_inactive','inactive: '+JSON.stringify(bad.body));
const r = ctx.api('POST','/tickets/'+t.id+'/reply',{agent_id:a.id,body:'We are sending a replacement.'});
ctx.assert(r.status===200 && r.body.status==='pending','reply: '+JSON.stringify(r.body));
const cm = ctx.api('GET','/comments?ticket_id='+t.id).body.data;
ctx.assert(cm.length===1 && cm[0].author_kind==='agent' && cm[0].agent_id===a.id && cm[0].body==='We are sending a replacement.','comment: '+JSON.stringify(cm));
ctx.api('POST','/tickets/'+t.id+'/assign',{agent_id:a.id});
ctx.api('POST','/tickets/'+t.id+'/resolve',{});
const late = ctx.api('POST','/tickets/'+t.id+'/reply',{agent_id:a.id,body:'again'});
ctx.assert(late.status===409 && late.body.error.code==='invalid_state','resolved reply: '+JSON.stringify(late.body));
}
```
### t_customer_reply
- Intent: Customer reply moves pending back to open.
- Actions: agent_reply, customer_reply
- Description: After an agent reply the customer replies and the ticket returns to open; a resolved ticket refuses the reply.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Cust Reply',email:'custreply.cust@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'CR Agent',email:'custreply.agent@accept.invalid',active:true}).body;
const t = ctx.api('POST','/tickets',{subject:'Wrong size',description:'Too small',customer_id:c.id,order_number:'#A3001'}).body;
ctx.assert(ctx.api('POST','/tickets/'+t.id+'/reply',{agent_id:a.id,body:'Which size?'}).body.status==='pending','pending');
const r = ctx.api('POST','/tickets/'+t.id+'/customer-reply',{body:'Size M please.'});
ctx.assert(r.status===200 && r.body.status==='open','customer reply: '+JSON.stringify(r.body));
const cm = ctx.api('GET','/comments?ticket_id='+t.id+'&author_kind=customer').body.data;
ctx.assert(cm.length===1 && cm[0].body==='Size M please.','customer comment');
ctx.api('POST','/tickets/'+t.id+'/assign',{agent_id:a.id});
ctx.api('POST','/tickets/'+t.id+'/resolve',{});
const late = ctx.api('POST','/tickets/'+t.id+'/customer-reply',{body:'hello?'});
ctx.assert(late.status===409 && late.body.error.code==='invalid_state','resolved: '+JSON.stringify(late.body));
}
```
### t_resolve
- Intent: Resolving needs an assignee and an unresolved ticket.
- Actions: assign_ticket, resolve_ticket
- Description: Unassigned ticket refused with not_assigned; assigned ticket resolves; second resolve refused.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Resolve Cust',email:'resolve.cust@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'Resolve Agent',email:'resolve.agent@accept.invalid',active:true}).body;
const t = ctx.api('POST','/tickets',{subject:'Refund status',description:'Where is it',customer_id:c.id,order_number:'#A4001'}).body;
const bad = ctx.api('POST','/tickets/'+t.id+'/resolve',{});
ctx.assert(bad.status===409 && bad.body.error.code==='not_assigned','unassigned: '+JSON.stringify(bad.body));
ctx.api('POST','/tickets/'+t.id+'/assign',{agent_id:a.id});
const ok = ctx.api('POST','/tickets/'+t.id+'/resolve',{});
ctx.assert(ok.status===200 && ok.body.status==='resolved','resolve: '+JSON.stringify(ok.body));
const again = ctx.api('POST','/tickets/'+t.id+'/resolve',{});
ctx.assert(again.status===409 && again.body.error.code==='invalid_state','again: '+JSON.stringify(again.body));
}
```
### t_reopen
- Intent: Only resolved tickets can be reopened.
- Actions: assign_ticket, resolve_ticket, reopen_ticket
- Description: Reopen on open ticket refused; reopen on resolved ticket returns it to open.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Reopen Cust',email:'reopen.cust@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'Reopen Agent',email:'reopen.agent@accept.invalid',active:true}).body;
const t = ctx.api('POST','/tickets',{subject:'Missing item',description:'Box empty',customer_id:c.id,order_number:'#A5001'}).body;
const bad = ctx.api('POST','/tickets/'+t.id+'/reopen',{});
ctx.assert(bad.status===409 && bad.body.error.code==='invalid_state','open reopen: '+JSON.stringify(bad.body));
ctx.api('POST','/tickets/'+t.id+'/assign',{agent_id:a.id});
ctx.api('POST','/tickets/'+t.id+'/resolve',{});
const ok = ctx.api('POST','/tickets/'+t.id+'/reopen',{});
ctx.assert(ok.status===200 && ok.body.status==='open','reopen: '+JSON.stringify(ok.body));
}
```
### t_auto_resolve
- Intent: The daily job resolves pending tickets quiet for more than 3 days and leaves open ones.
- Actions: assign_ticket, agent_reply
- Description: A pending ticket stays pending at 2 days and becomes resolved after 4; an open ticket is untouched.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Auto Cust',email:'auto.cust@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'Auto Agent',email:'auto.agent@accept.invalid',active:true}).body;
const p = ctx.api('POST','/tickets',{subject:'Auto pending',description:'x',customer_id:c.id,order_number:'#A6001'}).body;
const o = ctx.api('POST','/tickets',{subject:'Auto open',description:'x',customer_id:c.id,order_number:'#A6002'}).body;
ctx.api('POST','/tickets/'+p.id+'/assign',{agent_id:a.id});
ctx.assert(ctx.api('POST','/tickets/'+p.id+'/reply',{agent_id:a.id,body:'Any update?'}).body.status==='pending','pending');
ctx.advance('2d');
ctx.assert(ctx.api('GET','/tickets/'+p.id).body.status==='pending','still pending at 2d');
ctx.advance('2d');
ctx.assert(ctx.api('GET','/tickets/'+p.id).body.status==='resolved','resolved at 4d');
ctx.assert(ctx.api('GET','/tickets/'+o.id).body.status==='open','open untouched');
}
```
### t_refund_small
- Intent: Refunds up to $500 are approved immediately and validated against the ticket and order.
- Actions: request_refund
- Description: Small refunds approve at once (including exactly $500); mismatched order, inactive agent and over-total amounts are refused.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Refund Cust',email:'refund.cust@accept.invalid'}).body;
const c2 = ctx.api('POST','/customers',{name:'Refund Other',email:'refund.other@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'Refund Agent',email:'refund.agent@accept.invalid',active:true}).body;
const i = ctx.api('POST','/agents',{name:'Refund Inactive',email:'refund.inactive@accept.invalid',active:false}).body;
const t = ctx.api('POST','/tickets',{subject:'Item broken',description:'x',customer_id:c.id,order_number:'#R1001'}).body;
const o = ctx.api('POST','/orders',{order_number:'#R1001',customer_id:c.id,total:80000});
ctx.assert(o.status===201,'order create '+JSON.stringify(o.body));
const other = ctx.api('POST','/orders',{order_number:'#R1002',customer_id:c2.id,total:80000}).body;
const r1 = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:a.id,order_id:o.body.id,amount:20000,reason:'Damaged'});
ctx.assert(r1.status===201 && r1.body.status==='approved' && r1.body.amount===20000 && r1.body.requested_by===a.id,'small: '+JSON.stringify(r1.body));
const r2 = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:a.id,order_id:o.body.id,amount:50000,reason:'Boundary'});
ctx.assert(r2.status===201 && r2.body.status==='approved','boundary 500: '+JSON.stringify(r2.body));
const over = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:a.id,order_id:o.body.id,amount:20000,reason:'Too much'});
ctx.assert(over.status===409 && over.body.error.code==='amount_exceeds_order','over: '+JSON.stringify(over.body));
const mm = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:a.id,order_id:other.id,amount:1000,reason:'Wrong'});
ctx.assert(mm.status===409 && mm.body.error.code==='order_mismatch','mismatch: '+JSON.stringify(mm.body));
const ia = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:i.id,order_id:o.body.id,amount:1000,reason:'x'});
ctx.assert(ia.status===409 && ia.body.error.code==='agent_inactive','inactive: '+JSON.stringify(ia.body));
}
```
### t_refund_approval
- Intent: Refunds above $500 stay pending until an active supervisor approves or rejects them.
- Actions: request_refund, approve_refund, reject_refund
- Description: A $600 refund is pending; a plain agent cannot approve; a supervisor approves one and rejects another; decided refunds cannot be decided again.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Approve Cust',email:'approve.cust@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'Approve Agent',email:'approve.agent@accept.invalid',active:true}).body;
const s = ctx.api('POST','/agents',{name:'Approve Sup',email:'approve.sup@accept.invalid',active:true,role:'supervisor'});
ctx.assert(s.status===201 && s.body.role==='supervisor','supervisor create '+JSON.stringify(s.body));
const t = ctx.api('POST','/tickets',{subject:'Big refund',description:'x',customer_id:c.id,order_number:'#R2001'}).body;
const o = ctx.api('POST','/orders',{order_number:'#R2001',customer_id:c.id,total:200000}).body;
const r1 = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:a.id,order_id:o.id,amount:60000,reason:'Defective'});
ctx.assert(r1.status===201 && r1.body.status==='pending' && r1.body.approved_by===null,'pending: '+JSON.stringify(r1.body));
const no = ctx.api('POST','/refunds/'+r1.body.id+'/approve',{agent_id:a.id});
ctx.assert(no.status===409 && no.body.error.code==='not_supervisor','non supervisor: '+JSON.stringify(no.body));
const ok = ctx.api('POST','/refunds/'+r1.body.id+'/approve',{agent_id:s.body.id});
ctx.assert(ok.status===200 && ok.body.status==='approved' && ok.body.approved_by===s.body.id,'approve: '+JSON.stringify(ok.body));
const again = ctx.api('POST','/refunds/'+r1.body.id+'/approve',{agent_id:s.body.id});
ctx.assert(again.status===409 && again.body.error.code==='invalid_state','again: '+JSON.stringify(again.body));
const r2 = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:a.id,order_id:o.id,amount:60000,reason:'Second'}).body;
const rej = ctx.api('POST','/refunds/'+r2.id+'/reject',{agent_id:s.body.id});
ctx.assert(rej.status===200 && rej.body.status==='rejected','reject: '+JSON.stringify(rej.body));
const nr = ctx.api('POST','/refunds/'+r2.id+'/reject',{agent_id:a.id});
ctx.assert(nr.status===409,'agent reject refused');
}
```
### t_resolve_blocked
- Intent: A ticket with a pending refund cannot be resolved until the refund is decided.
- Actions: assign_ticket, request_refund, approve_refund, resolve_ticket
- Description: Resolve is refused with refund_pending while a refund is pending, and succeeds after a supervisor approves it.

```js
(ctx) => {
const c = ctx.api('POST','/customers',{name:'Block Cust',email:'block.cust@accept.invalid'}).body;
const a = ctx.api('POST','/agents',{name:'Block Agent',email:'block.agent@accept.invalid',active:true}).body;
const s = ctx.api('POST','/agents',{name:'Block Sup',email:'block.sup@accept.invalid',active:true,role:'supervisor'}).body;
const t = ctx.api('POST','/tickets',{subject:'Refund then resolve',description:'x',customer_id:c.id,order_number:'#R3001'}).body;
const o = ctx.api('POST','/orders',{order_number:'#R3001',customer_id:c.id,total:100000}).body;
ctx.api('POST','/tickets/'+t.id+'/assign',{agent_id:a.id});
const r = ctx.api('POST','/tickets/'+t.id+'/refunds',{agent_id:a.id,order_id:o.id,amount:70000,reason:'Lost parcel'}).body;
ctx.assert(r.status==='pending','refund pending '+JSON.stringify(r));
const bad = ctx.api('POST','/tickets/'+t.id+'/resolve',{});
ctx.assert(bad.status===409 && bad.body.error.code==='refund_pending','blocked: '+JSON.stringify(bad.body));
ctx.assert(ctx.api('GET','/tickets/'+t.id).body.status==='open','ticket unchanged');
ctx.assert(ctx.api('POST','/refunds/'+r.id+'/approve',{agent_id:s.id}).status===200,'approve');
const ok = ctx.api('POST','/tickets/'+t.id+'/resolve',{});
ctx.assert(ok.status===200 && ok.body.status==='resolved','resolve after approval: '+JSON.stringify(ok.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_customers` | GET | /customers | List/filter customers by email or name. |
| `get_customer` | GET | /customers/{id} | Read a customer. |
| `create_customer` | POST | /customers | Create a customer. |
| `list_agents` | GET | /agents | List/filter agents by name, email, active. |
| `get_agent` | GET | /agents/{id} | Read an agent. |
| `create_agent` | POST | /agents | Create an agent. |
| `list_tickets` | GET | /tickets | List tickets filtered by status, assignee, customer, order number, priority. |
| `get_ticket` | GET | /tickets/{id} | Read a ticket. |
| `create_ticket` | POST | /tickets | Open a ticket (starts open, unassigned). |
| `list_comments` | GET | /comments | List comments filtered by ticket_id and author_kind. |
| `list_orders` | GET | /orders | List/filter orders by order_number and customer_id. |
| `get_order` | GET | /orders/{id} | Read an order. |
| `create_order` | POST | /orders | Create an order (order_number unique, total in USD minor units). |
| `list_refunds` | GET | /refunds | List refunds filtered by ticket_id, order_id, status, requested_by. |
| `get_refund` | GET | /refunds/{id} | Read a refund. |

## Seed

- Rows per entity: customer: 8, agent: 5, ticket: 32, comment: 40, order: 24, refund: 10
- Mix: Existing mix, plus one active supervisor among the agents. Orders cover the tickets' order numbers (same customer, totals $40-$2000, order numbers never starting with #R). About 10 refunds on tickets: small ones approved, a few above $500 pending (only on unresolved tickets), some approved by the supervisor, a couple rejected.
- State mix: ticket: open 40%, pending 35%, resolved 25%; refund: pending 30%, approved 50%, rejected 20%

## Tasks

- `assign_open_ticket` (easy, permissions): Assign the open ticket about a given order number to a named active agent (not the inactive agent with a similar name).
  - Actions: `assign_ticket`
  - Decoy idea: Assigns a different ticket of the same customer, or assigns to the inactive agent.
  - Pressure: distractor rows of ticket
- `reply_to_customer_ticket` (medium, two_actors): A customer has replied on a pending ticket about one of several orders; find the ticket and reply as a named agent so it moves to pending again, after the customer's reply reopened it.
  - Actions: `agent_reply`
  - Decoy idea: Replies on the customer's other ticket with a similar subject, or skips finding the open ticket.
  - Pressure: seeded rows in ticket.open; distractor rows of ticket
- `triage_and_resolve` (hard, irreversible): For a customer's several tickets, find the open unassigned one about a named order (beyond the first list page), assign it to a named agent, send the reply with specified text, then resolve it.
  - Actions: `assign_ticket`, `agent_reply`, `resolve_ticket`
  - Decoy idea: Resolves the wrong ticket for another order or skips assignment/reply, leaving collateral changes.
  - Pressure: paging past the first page of ticket; seeded rows in ticket.open, ticket.pending; distractor rows of ticket
- `refund_large_and_approve` (medium, two_actors): For the open ticket about a named order, request a $750 refund as a named active agent, then approve it as the active supervisor so the refund ends approved.
  - Actions: `request_refund`, `approve_refund`
  - Decoy idea: Requests the refund but never approves it, leaving it pending, or refunds the customer's other order.

## Open questions

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

## Assumptions

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

## Out of scope

- Email ingestion, attachments, SLAs, macros, satisfaction ratings
  - Why: Not needed for core ticket state workflow.
- Authentication and permissions per user
  - Why: Agent identity is passed explicitly in the action body.
- Ticket deletion
  - Why: Tickets are never removed.
- Actual payment processing, partial reversals, refund deletion
  - Why: Only the approval workflow and ticket-resolution guard are requested.

## Changes

- workflows.ticket_lifecycle
- agent.fields.role
- seed
- tests.t_resolve_blocked because a ticket cannot be resolved while one of its refunds is pending
