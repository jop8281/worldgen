# WorldGen plan: Zendesk-style helpdesk ticketing API

A helpdesk where customers open tickets about their orders, agents reply, and tickets move between open, pending and resolved. Agents assign tickets, reply, resolve and reopen them. An agent can refund an order linked to a ticket. A refund above $500 waits for a lead's approval, and a ticket cannot be resolved while one of its refunds is pending. A stale pending ticket resolves itself after 7 days without an update, unless it has a pending refund. The world holds customers, agents, orders, tickets, comments (the replies on a ticket) and refunds, with list and get routes and create routes so tests can build their own rows.

- Revision: 4
- Verdict: proceed
- Clock: starts 2026-10-01T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A person who opens tickets. Email is unique. | email, first_name, last_name |
| `agent` | A support agent who is assigned tickets and writes replies. Role is agent or lead. | email, name, role |
| `order` | A purchase by a customer that a ticket can be about. | number, customer_id, item_name, total |
| `ticket` | A support case with a status state field (open, pending, resolved), an optional order, and an optional assignee agent. | subject, customer_id, order_id, assignee_id, status, priority |
| `comment` | One reply on a ticket, written by an agent or by the customer. | ticket_id, author_kind, agent_id, body |
| `refund` | Money an agent returns to the customer for an order linked to a ticket. Status is pending, issued or rejected. Refunds above $500 (50000 minor units, USD) stay pending until a lead approves them. The row records the decision only; no money moves. | ticket_id, order_id, agent_id, approver_id, amount, status |

## Workflows

### ticket_lifecycle (ticket)
- States: open, pending, resolved
- Actions: assign_ticket, reply_to_ticket, customer_reply, resolve_ticket, reopen_ticket
- Rules:
  - A resolved ticket takes no reply from an agent or from the customer Enforced by: reply_to_ticket, customer_reply. Tested by: resolved_ticket_refuses_replies
  - Only the assigned agent can resolve a ticket, and an unassigned ticket cannot be resolved Enforced by: resolve_ticket. Tested by: resolve_needs_assignee
  - A pending ticket with no update for 7 days resolves itself Enforced by: close_stale_pending. Tested by: stale_pending_auto_resolves
  - Only a resolved ticket can be reopened Enforced by: reopen_ticket. Tested by: reopen_resolved_ticket
  - A customer reply moves a pending ticket back to open Enforced by: customer_reply. Tested by: customer_reply_reopens_pending
  - A ticket cannot be resolved while one of its refunds is pending Enforced by: resolve_ticket, close_stale_pending. Tested by: resolve_blocked_by_pending_refund
  - Every comment belongs to an existing ticket Enforced by the data model: comment.ticket_id is a required ref, so a comment cannot exist without its ticket
  - Ticket list filters return only the rows whose state or customer matches the filter
### refund_lifecycle (refund)
- States: pending, issued, rejected
- Actions: create_refund, approve_refund, reject_refund
- Rules:
  - A refund names an order linked to its ticket Enforced by: create_refund. Tested by: refund_order_must_match_ticket
  - A refund of 500 USD or less is issued at once Enforced by: create_refund. Tested by: refund_small_issues_directly
  - A refund above 500 USD stays pending until a lead approves it Enforced by: create_refund, approve_refund. Tested by: refund_over_500_needs_lead
  - Only a lead can approve or reject a refund, and only a pending refund can be decided Enforced by: approve_refund, reject_refund. Tested by: refund_decisions_need_lead
  - A rejected refund no longer blocks its ticket Enforced by: reject_refund. Tested by: refund_reject_releases_ticket

## Jobs

- `close_stale_pending` runs every 1d: For each ticket in status pending whose updated_at is at least 7 days before now, and which has no pending refund, set status to resolved.

## Acceptance tests

### open_then_reply
- Intent: An agent reply moves an open ticket to pending and is stored as an agent comment.
- Actions: reply_to_ticket
- Description: Open a ticket, reply as an agent, check the status is pending and the comment list holds one agent comment.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Quinn',last_name:'Reply',email:'quinn.reply@example.test'}); ctx.assert(cus.status===201,'customer create failed: '+JSON.stringify(cus.body)); const ag = ctx.api('POST','/agents',{name:'Quinn Agent',email:'quinn.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed: '+JSON.stringify(ag.body)); const t = ctx.api('POST','/tickets',{subject:'QA reply check',description:'Where is my order?',customer_id:cus.body.id,priority:'normal'}); ctx.assert(t.status===201 && t.body.status==='open','ticket should open: '+JSON.stringify(t.body)); const r = ctx.api('POST','/tickets/'+t.body.id+'/reply',{agent_id:ag.body.id,message:'We are checking with the carrier.'}); ctx.assert(r.status===200 && r.body.status==='pending','reply should move open to pending: '+JSON.stringify(r.body)); const c = ctx.api('GET','/comments?ticket_id='+t.body.id); ctx.assert(c.status===200 && c.body.data.length===1 && c.body.data[0].author_kind==='agent','expected one agent comment: '+JSON.stringify(c.body)); }
```
### resolved_ticket_refuses_replies
- Intent: A resolved ticket accepts no agent reply and no customer reply, and both answer 409 invalid_state.
- Actions: reply_to_ticket, customer_reply, resolve_ticket, assign_ticket
- Description: Assign and resolve a ticket, then try an agent reply and a customer reply. Both answer 409 with code invalid_state.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Rhea',last_name:'Closed',email:'rhea.closed@example.test'}); ctx.assert(cus.status===201,'customer create failed'); const ag = ctx.api('POST','/agents',{name:'Rhea Agent',email:'rhea.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed'); const t = ctx.api('POST','/tickets',{subject:'QA closed check',description:'Closed case',customer_id:cus.body.id}); ctx.assert(t.status===201,'ticket create failed'); const a = ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:ag.body.id}); ctx.assert(a.status===200,'assign failed: '+JSON.stringify(a.body)); const res = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:ag.body.id}); ctx.assert(res.status===200 && res.body.status==='resolved','resolve failed: '+JSON.stringify(res.body)); const r1 = ctx.api('POST','/tickets/'+t.body.id+'/reply',{agent_id:ag.body.id,message:'Too late'}); ctx.assert(r1.status===409 && r1.body.error.code==='invalid_state','agent reply to resolved should answer 409 invalid_state, got '+r1.status); const r2 = ctx.api('POST','/tickets/'+t.body.id+'/customer_reply',{message:'Still broken'}); ctx.assert(r2.status===409 && r2.body.error.code==='invalid_state','customer reply to resolved should answer 409 invalid_state, got '+r2.status); }
```
### resolve_needs_assignee
- Intent: Resolve needs an assignee and only the assigned agent may resolve.
- Actions: assign_ticket, resolve_ticket
- Description: Resolve an unassigned ticket (409 unassigned), resolve as a non-assignee (409 not_assignee), assign to an unknown agent (422 ref.unresolved), then resolve as the assignee (200).

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Rowan',last_name:'Assign',email:'rowan.assign@example.test'}); ctx.assert(cus.status===201,'customer create failed'); const a = ctx.api('POST','/agents',{name:'Rowan A',email:'rowan.a@example.test',role:'agent'}); const b = ctx.api('POST','/agents',{name:'Rowan B',email:'rowan.b@example.test',role:'agent'}); ctx.assert(a.status===201 && b.status===201,'agent create failed'); const t = ctx.api('POST','/tickets',{subject:'QA assign check',description:'Needs an owner',customer_id:cus.body.id}); ctx.assert(t.status===201,'ticket create failed'); const r0 = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:a.body.id}); ctx.assert(r0.status===409 && r0.body.error.code==='unassigned','unassigned ticket should answer 409 unassigned, got '+r0.status); ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:a.body.id}).status===200,'assign to A failed'); const r1 = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:b.body.id}); ctx.assert(r1.status===409 && r1.body.error.code==='not_assignee','non-assignee should answer 409 not_assignee, got '+r1.status); const r2 = ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:'agt_9999'}); ctx.assert(r2.status===422 && r2.body.error.code==='ref.unresolved','unknown agent should answer 422 ref.unresolved, got '+r2.status); const r3 = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:a.body.id}); ctx.assert(r3.status===200 && r3.body.status==='resolved','assignee resolve failed: '+JSON.stringify(r3.body)); }
```
### stale_pending_auto_resolves
- Intent: A pending ticket with no update for 7 days resolves itself through the daily job.
- Actions: reply_to_ticket
- Description: Reply to a ticket so it is pending, advance the clock 8 days, and check the ticket is resolved.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Stale',last_name:'Queue',email:'stale.queue@example.test'}); ctx.assert(cus.status===201,'customer create failed'); const ag = ctx.api('POST','/agents',{name:'Stale Agent',email:'stale.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed'); const t = ctx.api('POST','/tickets',{subject:'QA stale check',description:'Waiting on customer',customer_id:cus.body.id}); ctx.assert(t.status===201,'ticket create failed'); const r = ctx.api('POST','/tickets/'+t.body.id+'/reply',{agent_id:ag.body.id,message:'Please confirm.'}); ctx.assert(r.status===200 && r.body.status==='pending','reply should set pending'); ctx.advance('8d'); const after = ctx.api('GET','/tickets/'+t.body.id); ctx.assert(after.status===200 && after.body.status==='resolved','stale pending ticket should be resolved, got '+after.body.status); }
```
### reopen_resolved_ticket
- Intent: Only a resolved ticket can be reopened, and reopening sets it back to open.
- Actions: reopen_ticket, resolve_ticket, assign_ticket
- Description: Assign and resolve a ticket, reopen it to open, then reopen again and get 409 invalid_state.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Reena',last_name:'Open',email:'reena.open@example.test'}); ctx.assert(cus.status===201,'customer create failed'); const ag = ctx.api('POST','/agents',{name:'Reena Agent',email:'reena.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed'); const t = ctx.api('POST','/tickets',{subject:'QA reopen check',description:'Came back',customer_id:cus.body.id}); ctx.assert(t.status===201,'ticket create failed'); ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:ag.body.id}).status===200,'assign failed'); ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:ag.body.id}).status===200,'resolve failed'); const r = ctx.api('POST','/tickets/'+t.body.id+'/reopen',{}); ctx.assert(r.status===200 && r.body.status==='open','reopen should set open: '+JSON.stringify(r.body)); const again = ctx.api('POST','/tickets/'+t.body.id+'/reopen',{}); ctx.assert(again.status===409 && again.body.error.code==='invalid_state','reopening an open ticket should answer 409 invalid_state, got '+again.status); }
```
### customer_reply_reopens_pending
- Intent: A customer reply moves a pending ticket back to open and is stored as a customer comment.
- Actions: customer_reply, reply_to_ticket
- Description: Reply as an agent so the ticket is pending, then send a customer reply, and check the status is open and a customer comment exists.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Cara',last_name:'Return',email:'cara.return@example.test'}); ctx.assert(cus.status===201,'customer create failed'); const ag = ctx.api('POST','/agents',{name:'Cara Agent',email:'cara.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed'); const t = ctx.api('POST','/tickets',{subject:'QA customer reply',description:'Any update?',customer_id:cus.body.id}); ctx.assert(t.status===201,'ticket create failed'); ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/reply',{agent_id:ag.body.id,message:'Checking.'}).status===200,'agent reply failed'); const r = ctx.api('POST','/tickets/'+t.body.id+'/customer_reply',{message:'Any news?'}); ctx.assert(r.status===200 && r.body.status==='open','customer reply should move pending to open: '+JSON.stringify(r.body)); const c = ctx.api('GET','/comments?ticket_id='+t.body.id); ctx.assert(c.status===200 && c.body.data.some((x)=>x.author_kind==='customer'),'expected a customer comment'); }
```
### filtered_list_separates_states
- Intent: A ticket list filtered by status returns only the tickets in that state, and a list filtered by customer returns only that customer's tickets.
- Actions: reply_to_ticket
- Description: Open two tickets for one customer, move one to pending, then check the status filter and the customer filter return the right rows.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Ivy',last_name:'Filter',email:'ivy.filter@example.test'}); ctx.assert(cus.status===201,'customer create failed'); const ag = ctx.api('POST','/agents',{name:'Ivy Agent',email:'ivy.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed'); const a = ctx.api('POST','/tickets',{subject:'QA filter A',description:'First',customer_id:cus.body.id}); const b = ctx.api('POST','/tickets',{subject:'QA filter B',description:'Second',customer_id:cus.body.id}); ctx.assert(a.status===201 && b.status===201,'ticket create failed'); ctx.assert(ctx.api('POST','/tickets/'+a.body.id+'/reply',{agent_id:ag.body.id,message:'Looking'}).status===200,'reply failed'); const pending = ctx.api('GET','/tickets?customer_id='+cus.body.id+'&status=pending'); ctx.assert(pending.status===200 && pending.body.data.length===1 && pending.body.data[0].id===a.body.id,'pending filter should return only ticket A: '+JSON.stringify(pending.body)); const all = ctx.api('GET','/tickets?customer_id='+cus.body.id); ctx.assert(all.status===200 && all.body.data.length===2,'customer filter should return both tickets'); }
```
### refund_order_must_match_ticket
- Intent: A refund must name an order linked to its ticket, and a refund on another order is refused with 422 order_not_on_ticket and stores nothing.
- Actions: create_refund
- Description: Create a customer, an agent, two orders and a ticket linked to the first order. Refund the second order on the ticket: 422 order_not_on_ticket, and the refund list for the ticket is empty.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Ada',last_name:'Refund',email:'ada.refund@example.test'}); ctx.assert(cus.status===201,'customer create failed: '+JSON.stringify(cus.body)); const ag = ctx.api('POST','/agents',{name:'Ada Agent',email:'ada.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed: '+JSON.stringify(ag.body)); const ord = ctx.api('POST','/orders',{customer_id:cus.body.id,number:'#W9000001',item_name:'Desk lamp',total:4000}); ctx.assert(ord.status===201,'order create failed: '+JSON.stringify(ord.body)); const other = ctx.api('POST','/orders',{customer_id:cus.body.id,number:'#W9000002',item_name:'Chair',total:9000}); ctx.assert(other.status===201,'second order create failed: '+JSON.stringify(other.body)); const t = ctx.api('POST','/tickets',{subject:'QA refund link check',description:'Lamp is faulty',customer_id:cus.body.id,order_id:ord.body.id,priority:'normal'}); ctx.assert(t.status===201,'ticket create failed: '+JSON.stringify(t.body)); const bad = ctx.api('POST','/tickets/'+t.body.id+'/refunds',{order_id:other.body.id,amount:4000,agent_id:ag.body.id}); ctx.assert(bad.status===422 && bad.body.error.code==='order_not_on_ticket','refund on an order the ticket does not name should answer 422 order_not_on_ticket, got '+bad.status+' '+JSON.stringify(bad.body)); const list = ctx.api('GET','/refunds?ticket_id='+t.body.id); ctx.assert(list.status===200 && list.body.data.length===0,'refused refund must not be stored: '+JSON.stringify(list.body)); }
```
### refund_small_issues_directly
- Intent: A refund of 500 USD or less is issued at once, and an issued refund does not block resolve.
- Actions: create_refund, assign_ticket, resolve_ticket
- Description: Refund 4000 minor units on the ticket's order: the refund answers issued, is stored issued, and the ticket still resolves.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Bea',last_name:'Small',email:'bea.small@example.test'}); ctx.assert(cus.status===201,'customer create failed: '+JSON.stringify(cus.body)); const ag = ctx.api('POST','/agents',{name:'Bea Agent',email:'bea.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed: '+JSON.stringify(ag.body)); const ord = ctx.api('POST','/orders',{customer_id:cus.body.id,number:'#W9000003',item_name:'Kettle',total:4000}); ctx.assert(ord.status===201,'order create failed: '+JSON.stringify(ord.body)); const t = ctx.api('POST','/tickets',{subject:'QA small refund',description:'Kettle leaks',customer_id:cus.body.id,order_id:ord.body.id,priority:'normal'}); ctx.assert(t.status===201,'ticket create failed: '+JSON.stringify(t.body)); ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:ag.body.id}).status===200,'assign failed'); const r = ctx.api('POST','/tickets/'+t.body.id+'/refunds',{order_id:ord.body.id,amount:4000,agent_id:ag.body.id}); ctx.assert(r.status<300 && r.body.status==='issued','a refund of 4000 minor units should be issued at once: '+JSON.stringify(r.body)); const got = ctx.api('GET','/refunds/'+r.body.id); ctx.assert(got.status===200 && got.body.ticket_id===t.body.id && got.body.status==='issued','refund row should be stored as issued: '+JSON.stringify(got.body)); const res = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:ag.body.id}); ctx.assert(res.status===200 && res.body.status==='resolved','an issued refund must not block resolve: '+JSON.stringify(res.body)); }
```
### refund_over_500_needs_lead
- Intent: A refund above 500 USD is created pending and a lead's approval issues it.
- Actions: create_refund, approve_refund
- Description: Refund 60000 minor units ($600.00): pending on creation. A lead approves it: issued, with the lead as approver.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Cy',last_name:'Over',email:'cy.over@example.test'}); ctx.assert(cus.status===201,'customer create failed: '+JSON.stringify(cus.body)); const ag = ctx.api('POST','/agents',{name:'Cy Agent',email:'cy.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed: '+JSON.stringify(ag.body)); const ld = ctx.api('POST','/agents',{name:'Cy Lead',email:'cy.lead@example.test',role:'lead'}); ctx.assert(ld.status===201,'lead create failed: '+JSON.stringify(ld.body)); const ord = ctx.api('POST','/orders',{customer_id:cus.body.id,number:'#W9000004',item_name:'Sofa',total:80000}); ctx.assert(ord.status===201,'order create failed: '+JSON.stringify(ord.body)); const t = ctx.api('POST','/tickets',{subject:'QA large refund',description:'Sofa arrived broken',customer_id:cus.body.id,order_id:ord.body.id,priority:'high'}); ctx.assert(t.status===201,'ticket create failed: '+JSON.stringify(t.body)); const r = ctx.api('POST','/tickets/'+t.body.id+'/refunds',{order_id:ord.body.id,amount:60000,agent_id:ag.body.id}); ctx.assert(r.status<300 && r.body.status==='pending','a refund above 50000 minor units should be pending: '+JSON.stringify(r.body)); const ap = ctx.api('POST','/refunds/'+r.body.id+'/approve',{supervisor_id:ld.body.id}); ctx.assert(ap.status===200 && ap.body.status==='issued' && ap.body.approver_id===ld.body.id,'lead approval should issue the refund: '+JSON.stringify(ap.body)); }
```
### refund_decisions_need_lead
- Intent: Only a lead can approve a refund, and a refund that is already decided cannot be decided again.
- Actions: approve_refund, reject_refund, create_refund
- Description: On a pending refund: an agent's approval answers 409 not_supervisor, a lead's approval issues it, and a reject after that answers 409 invalid_state.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Dee',last_name:'Decide',email:'dee.decide@example.test'}); ctx.assert(cus.status===201,'customer create failed: '+JSON.stringify(cus.body)); const ag = ctx.api('POST','/agents',{name:'Dee Agent',email:'dee.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed: '+JSON.stringify(ag.body)); const ld = ctx.api('POST','/agents',{name:'Dee Lead',email:'dee.lead@example.test',role:'lead'}); ctx.assert(ld.status===201,'lead create failed: '+JSON.stringify(ld.body)); const ord = ctx.api('POST','/orders',{customer_id:cus.body.id,number:'#W9000005',item_name:'Bike',total:70000}); ctx.assert(ord.status===201,'order create failed: '+JSON.stringify(ord.body)); const t = ctx.api('POST','/tickets',{subject:'QA decision check',description:'Bike frame cracked',customer_id:cus.body.id,order_id:ord.body.id,priority:'normal'}); ctx.assert(t.status===201,'ticket create failed: '+JSON.stringify(t.body)); const r = ctx.api('POST','/tickets/'+t.body.id+'/refunds',{order_id:ord.body.id,amount:60000,agent_id:ag.body.id}); ctx.assert(r.status<300 && r.body.status==='pending','refund should be pending: '+JSON.stringify(r.body)); const byAgent = ctx.api('POST','/refunds/'+r.body.id+'/approve',{supervisor_id:ag.body.id}); ctx.assert(byAgent.status===409 && byAgent.body.error.code==='not_supervisor','an agent approval should answer 409 not_supervisor, got '+byAgent.status+' '+JSON.stringify(byAgent.body)); const ok = ctx.api('POST','/refunds/'+r.body.id+'/approve',{supervisor_id:ld.body.id}); ctx.assert(ok.status===200 && ok.body.status==='issued','lead approval should issue the refund: '+JSON.stringify(ok.body)); const again = ctx.api('POST','/refunds/'+r.body.id+'/reject',{supervisor_id:ld.body.id}); ctx.assert(again.status===409 && again.body.error.code==='invalid_state','rejecting a decided refund should answer 409 invalid_state, got '+again.status+' '+JSON.stringify(again.body)); }
```
### resolve_blocked_by_pending_refund
- Intent: A ticket cannot be resolved while one of its refunds is pending, and the refused resolve leaves the ticket unresolved.
- Actions: resolve_ticket, assign_ticket, create_refund
- Description: Assign a ticket, create a pending refund on it, then resolve as the assignee: 409 refund_pending, and the ticket is not resolved.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Eli',last_name:'Block',email:'eli.block@example.test'}); ctx.assert(cus.status===201,'customer create failed: '+JSON.stringify(cus.body)); const ag = ctx.api('POST','/agents',{name:'Eli Agent',email:'eli.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed: '+JSON.stringify(ag.body)); const ord = ctx.api('POST','/orders',{customer_id:cus.body.id,number:'#W9000006',item_name:'Sofa',total:80000}); ctx.assert(ord.status===201,'order create failed: '+JSON.stringify(ord.body)); const t = ctx.api('POST','/tickets',{subject:'QA pending refund block',description:'Sofa arrived broken',customer_id:cus.body.id,order_id:ord.body.id,priority:'high'}); ctx.assert(t.status===201,'ticket create failed: '+JSON.stringify(t.body)); ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:ag.body.id}).status===200,'assign failed'); const r = ctx.api('POST','/tickets/'+t.body.id+'/refunds',{order_id:ord.body.id,amount:60000,agent_id:ag.body.id}); ctx.assert(r.status<300 && r.body.status==='pending','refund should be pending: '+JSON.stringify(r.body)); const res = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:ag.body.id}); ctx.assert(res.status===409 && res.body.error.code==='refund_pending','resolve with a pending refund should answer 409 refund_pending, got '+res.status+' '+JSON.stringify(res.body)); const got = ctx.api('GET','/tickets/'+t.body.id); ctx.assert(got.status===200 && got.body.status!=='resolved','the refused resolve must leave the ticket unresolved: '+JSON.stringify(got.body)); }
```
### refund_reject_releases_ticket
- Intent: A lead rejects a pending refund, which releases the ticket so it can be resolved, and an agent cannot reject.
- Actions: reject_refund, resolve_ticket, assign_ticket, create_refund
- Description: With a pending refund the ticket cannot resolve. An agent's reject answers 409 not_supervisor. A lead's reject answers rejected, and then the ticket resolves.

```js
(ctx) => { const cus = ctx.api('POST','/customers',{first_name:'Fay',last_name:'Reject',email:'fay.reject@example.test'}); ctx.assert(cus.status===201,'customer create failed: '+JSON.stringify(cus.body)); const ag = ctx.api('POST','/agents',{name:'Fay Agent',email:'fay.agent@example.test',role:'agent'}); ctx.assert(ag.status===201,'agent create failed: '+JSON.stringify(ag.body)); const ld = ctx.api('POST','/agents',{name:'Fay Lead',email:'fay.lead@example.test',role:'lead'}); ctx.assert(ld.status===201,'lead create failed: '+JSON.stringify(ld.body)); const ord = ctx.api('POST','/orders',{customer_id:cus.body.id,number:'#W9000007',item_name:'Sofa',total:80000}); ctx.assert(ord.status===201,'order create failed: '+JSON.stringify(ord.body)); const t = ctx.api('POST','/tickets',{subject:'QA reject release',description:'Sofa refund disputed',customer_id:cus.body.id,order_id:ord.body.id,priority:'high'}); ctx.assert(t.status===201,'ticket create failed: '+JSON.stringify(t.body)); ctx.assert(ctx.api('POST','/tickets/'+t.body.id+'/assign',{agent_id:ag.body.id}).status===200,'assign failed'); const r = ctx.api('POST','/tickets/'+t.body.id+'/refunds',{order_id:ord.body.id,amount:60000,agent_id:ag.body.id}); ctx.assert(r.status<300 && r.body.status==='pending','refund should be pending: '+JSON.stringify(r.body)); const blocked = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:ag.body.id}); ctx.assert(blocked.status===409 && blocked.body.error.code==='refund_pending','resolve should be blocked by the pending refund, got '+blocked.status); const byAgent = ctx.api('POST','/refunds/'+r.body.id+'/reject',{supervisor_id:ag.body.id}); ctx.assert(byAgent.status===409 && byAgent.body.error.code==='not_supervisor','an agent rejection should answer 409 not_supervisor, got '+byAgent.status+' '+JSON.stringify(byAgent.body)); const rej = ctx.api('POST','/refunds/'+r.body.id+'/reject',{supervisor_id:ld.body.id}); ctx.assert(rej.status===200 && rej.body.status==='rejected','lead rejection should reject the refund: '+JSON.stringify(rej.body)); const res = ctx.api('POST','/tickets/'+t.body.id+'/resolve',{agent_id:ag.body.id}); ctx.assert(res.status===200 && res.body.status==='resolved','a rejected refund must no longer block resolve: '+JSON.stringify(res.body)); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `create_customer` | POST | /customers | Create a customer. |
| `list_customers` | GET | /customers | List customers, filter by email. |
| `get_customer` | GET | /customers/{id} | Get one customer. |
| `create_agent` | POST | /agents | Create an agent. |
| `list_agents` | GET | /agents | List agents, filter by role. |
| `get_agent` | GET | /agents/{id} | Get one agent. |
| `create_order` | POST | /orders | Create an order for a customer. |
| `list_orders` | GET | /orders | List orders, filter by customer_id and number. |
| `get_order` | GET | /orders/{id} | Get one order. |
| `create_ticket` | POST | /tickets | Open a ticket. Status starts open. |
| `list_tickets` | GET | /tickets | List tickets, filter by status, customer_id, assignee_id, priority and order_id, sorted by created_at. |
| `get_ticket` | GET | /tickets/{id} | Get one ticket. |
| `list_comments` | GET | /comments | List the comments of a ticket, filter by ticket_id and author_kind. |
| `list_refunds` | GET | /refunds | List refunds, filter by ticket_id and status. |
| `get_refund` | GET | /refunds/{id} | Get one refund. |
| `create_refund` | POST | /tickets/{id}/refunds | Agent refunds an order linked to the ticket. Body: order_id, amount (minor units, USD), agent_id. Answers the refund row, issued at once when amount is 50000 or less, otherwise pending. |
| `approve_refund` | POST | /refunds/{id}/approve | A lead approves a pending refund. Body: supervisor_id. Refund becomes issued. |
| `reject_refund` | POST | /refunds/{id}/reject | A lead rejects a pending refund. Body: supervisor_id. Refund becomes rejected. |

## Seed

- Rows per entity: agent: 4, customer: 12, order: 16, ticket: 28, comment: 40
- Mix: Agents: Ava Brooks (lead), Ben Carter, Chloe Diaz, Dev Evans. Customers include Sofia Li (sofia.li4822@example.com), Noah Patel, Mia Garcia, Priya Nair. Seed emails use the example.com domain only; seed order numbers use #W1xxxxxx. Fixed rows the tasks depend on: (1) ticket 'Order arrived damaged' from Sofia Li, status open, no assignee, priority high; (2) ticket 'Late delivery' from Noah Patel, status pending, assigned to Chloe Diaz, linked to one of Noah's orders; (3) ticket 'Late delivery' from Mia Garcia, status pending, assigned to Ben Carter (a near-duplicate distractor); (4) ticket 'Refund not received' from Priya Nair, status open, no assignee, and it is the 27th ticket by id so it sits on page 2 of a 25-row list. Other tickets vary subject, priority and assignment. Seeded comments sit on tickets and have authors that match their ticket. Every seeded updated_at is at or before the clock start.
- State mix: ticket: open 40%, pending 30%, resolved 30%

## Tasks

- `reply_to_damaged_order` (easy): Reply on Sofia Li's open ticket about her damaged order, signed by agent Ava Brooks, saying a replacement is on its way. The reply moves the ticket to pending.
  - Actions: `reply_to_ticket`
  - Decoy idea: Replies on the wrong ticket, such as the Noah Patel late-delivery ticket, or replies with the wrong agent name.
  - Pressure: seeded rows in ticket.open; distractor rows of ticket
- `resolve_assigned_late_delivery` (medium, permissions): Resolve the pending 'Late delivery' ticket from Noah Patel, acting as Chloe Diaz, the agent it is assigned to. Only the assignee may resolve.
  - Actions: `resolve_ticket`
  - Decoy idea: Resolves as Ava Brooks (lead, not the assignee), or reassigns the ticket to Ava and then resolves it. The second changes the assignee, which the instruction does not ask for.
  - Pressure: seeded rows in ticket.pending; distractor rows of ticket
- `assign_reply_resolve_refund` (hard): Priya Nair's 'Refund not received' ticket is open and unassigned, on page 2 of the ticket list. Assign it to Dev Evans, reply that the refund was issued, then resolve it as Dev Evans. The three calls must run in that order.
  - Actions: `assign_ticket`, `reply_to_ticket`, `resolve_ticket`
  - Decoy idea: Replies and resolves without assigning first, so resolve answers 409 unassigned and the ticket is never closed. A second decoy resolves page 1 only and never finds the ticket on page 2.
  - Pressure: paging past the first page of ticket; seeded rows in ticket.open; distractor rows of ticket

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

- tests.refund_order_must_match_ticket
- tests.refund_small_issues_directly
- tests.refund_over_500_needs_lead
- tests.refund_decisions_need_lead
- tests.resolve_blocked_by_pending_refund
- tests.refund_reject_releases_ticket
