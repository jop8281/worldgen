# WorldGen plan: Field service equipment repair desk ticketing (Zendesk / Freshdesk-style service desk)

A small equipment repair desk. Technicians have a name and an active flag. Repair tickets have a subject, customer name, priority (normal or urgent), a status (queued, active, closed) and an optional assigned technician. Tickets are listed with pagination and filters, created and edited through standard routes, and moved through explicit assign, start and close actions. Starting needs a queued ticket with an active assigned technician; closing needs an active ticket; assigning needs a queued ticket and an active technician. Refused calls write nothing. The seed is deterministic: four technicians (one inactive) and twelve tickets across all statuses and both priorities, with the list page size at 5 so the hard task must page.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `technician` | A repair technician who can be assigned tickets only while active. | name, active |
| `ticket` | A repair request for one piece of equipment, with a customer, a priority, a lifecycle status and an optional assigned technician. Status and assignment change only through actions. | subject, customer_name, priority, status, assigned_technician_id |

## Workflows

### ticket_repair (ticket)
- States: queued, active, closed
- Actions: assign_ticket, start_ticket, close_ticket
- Rules:
  - start_ticket moves a ticket from queued to active only when it has an assigned technician who is active; otherwise it fails with 409 and writes nothing Enforced by: start_ticket. Tested by: start_requires_queued_active_tech
  - close_ticket moves a ticket from active to closed only; any other status fails with 409 invalid_state Enforced by: close_ticket. Tested by: close_requires_active
  - assign_ticket sets the technician only on a queued ticket and only when that technician is active; an unknown technician is refused Enforced by: assign_ticket. Tested by: assign_refuses_inactive
  - a refused assign, start or close changes no row, including the ticket status and assignment Enforced by: assign_ticket, start_ticket, close_ticket. Tested by: refused_calls_write_nothing
  - ticket status moves only queued to active and active to closed, checked by the engine on every write Enforced by the data model: the status state field declares exactly these transitions
  - a new ticket starts queued Enforced by the data model: the status state field has initial queued, so a create cannot set another state
  - a new ticket is unassigned and status and assignment cannot be set by standard routes Enforced by the data model: assigned_technician_id and status are readonly, so standard create and update refuse them
  - priority is normal or urgent Enforced by the data model: priority is an enum with exactly these two values

## Jobs

None. The plan declares no job.

## Acceptance tests

### create_edit_ticket
- Intent: A ticket is created queued and unassigned, its priority can be edited, status cannot be edited through the standard route, and starting it without a technician is refused.
- Actions: start_ticket
- Description: Create a ticket, edit its priority, refuse a status edit and a bad priority, and refuse a start with no technician.

```js
(ctx) => {
  const bad = ctx.api('POST', '/tickets', { subject: 'AT edit probe', customer_name: 'AT Customer', priority: 'severe' });
  ctx.assert(bad.status === 422, 'unknown priority is refused: ' + JSON.stringify(bad));
  const c = ctx.api('POST', '/tickets', { subject: 'AT create probe', customer_name: 'AT Customer', priority: 'normal' });
  ctx.assert(c.status === 201, 'create: ' + JSON.stringify(c.body));
  ctx.assert(c.body.status === 'queued' && c.body.assigned_technician_id === null, 'new ticket is queued and unassigned: ' + JSON.stringify(c.body));
  const id = c.body.id;
  const up = ctx.api('PATCH', '/tickets/' + id, { priority: 'urgent' });
  ctx.assert(up.status === 200 && up.body.priority === 'urgent', 'priority edit: ' + JSON.stringify(up.body));
  const st = ctx.api('PATCH', '/tickets/' + id, { status: 'active' });
  ctx.assert(st.status === 422 && st.body.error.code === 'field.readonly', 'status is not editable: ' + JSON.stringify(st));
  const got = ctx.api('GET', '/tickets/' + id);
  ctx.assert(got.status === 200 && got.body.priority === 'urgent' && got.body.status === 'queued', 'get shows the edit and the unchanged status: ' + JSON.stringify(got.body));
  const start = ctx.api('POST', '/tickets/' + id + '/start', {});
  ctx.assert(start.status === 409 && start.body.error.code === 'no_technician', 'start without technician is refused: ' + JSON.stringify(start));
}
```
### start_requires_queued_active_tech
- Intent: start_ticket works only on a queued ticket with an active assigned technician and refuses a second start.
- Actions: assign_ticket, start_ticket
- Description: Assign an active technician, start the ticket, refuse a second start and refuse an unknown ticket.

```js
(ctx) => {
  const tech = ctx.api('POST', '/technicians', { name: 'AT Starter', active: true });
  ctx.assert(tech.status === 201, 'create technician: ' + JSON.stringify(tech.body));
  const t = ctx.api('POST', '/tickets', { subject: 'AT start probe', customer_name: 'AT Customer', priority: 'normal' });
  ctx.assert(t.status === 201, 'create ticket: ' + JSON.stringify(t.body));
  const id = t.body.id;
  const asg = ctx.api('POST', '/tickets/' + id + '/assign', { technician_id: tech.body.id });
  ctx.assert(asg.status === 200 && asg.body.assigned_technician_id === tech.body.id, 'assign: ' + JSON.stringify(asg.body));
  const s = ctx.api('POST', '/tickets/' + id + '/start', {});
  ctx.assert(s.status === 200 && s.body.status === 'active', 'start: ' + JSON.stringify(s.body));
  const again = ctx.api('POST', '/tickets/' + id + '/start', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second start: ' + JSON.stringify(again));
  const ghost = ctx.api('POST', '/tickets/tkt_9999/start', {});
  ctx.assert(ghost.status >= 400 && ghost.status < 500, 'unknown ticket: ' + JSON.stringify(ghost));
}
```
### close_requires_active
- Intent: close_ticket works only on an active ticket and refuses a queued or already closed ticket.
- Actions: assign_ticket, start_ticket, close_ticket
- Description: Refuse closing a queued ticket, close an active one, and refuse closing it again.

```js
(ctx) => {
  const tech = ctx.api('POST', '/technicians', { name: 'AT Closer', active: true });
  ctx.assert(tech.status === 201, 'create technician: ' + JSON.stringify(tech.body));
  const t = ctx.api('POST', '/tickets', { subject: 'AT close probe', customer_name: 'AT Customer', priority: 'urgent' });
  ctx.assert(t.status === 201, 'create ticket: ' + JSON.stringify(t.body));
  const id = t.body.id;
  const early = ctx.api('POST', '/tickets/' + id + '/close', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'queued ticket cannot close: ' + JSON.stringify(early));
  ctx.assert(ctx.api('POST', '/tickets/' + id + '/assign', { technician_id: tech.body.id }).status === 200, 'assign');
  ctx.assert(ctx.api('POST', '/tickets/' + id + '/start', {}).status === 200, 'start');
  const c = ctx.api('POST', '/tickets/' + id + '/close', {});
  ctx.assert(c.status === 200 && c.body.status === 'closed', 'close active ticket: ' + JSON.stringify(c.body));
  const twice = ctx.api('POST', '/tickets/' + id + '/close', {});
  ctx.assert(twice.status === 409 && twice.body.error.code === 'invalid_state', 'closed ticket cannot close again: ' + JSON.stringify(twice));
}
```
### assign_refuses_inactive
- Intent: assign_ticket refuses an inactive technician and an unknown technician, and accepts an active one.
- Actions: assign_ticket
- Description: Assign to an inactive technician (refused), to an unknown id (refused), then to an active technician (accepted).

```js
(ctx) => {
  const off = ctx.api('POST', '/technicians', { name: 'AT Off Shift', active: false });
  ctx.assert(off.status === 201 && off.body.active === false, 'create inactive technician: ' + JSON.stringify(off.body));
  const on = ctx.api('POST', '/technicians', { name: 'AT On Shift', active: true });
  ctx.assert(on.status === 201, 'create active technician: ' + JSON.stringify(on.body));
  const t = ctx.api('POST', '/tickets', { subject: 'AT assign probe', customer_name: 'AT Customer', priority: 'normal' });
  ctx.assert(t.status === 201, 'create ticket: ' + JSON.stringify(t.body));
  const id = t.body.id;
  const bad = ctx.api('POST', '/tickets/' + id + '/assign', { technician_id: off.body.id });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'technician_inactive', 'inactive technician refused: ' + JSON.stringify(bad));
  const unknown = ctx.api('POST', '/tickets/' + id + '/assign', { technician_id: 'tec_9999' });
  ctx.assert(unknown.status >= 400 && unknown.status < 500, 'unknown technician refused: ' + JSON.stringify(unknown));
  const ok = ctx.api('POST', '/tickets/' + id + '/assign', { technician_id: on.body.id });
  ctx.assert(ok.status === 200 && ok.body.assigned_technician_id === on.body.id, 'active technician assigned: ' + JSON.stringify(ok.body));
}
```
### refused_calls_write_nothing
- Intent: A refused assign, start or close leaves the ticket status and assignment exactly as they were.
- Actions: assign_ticket, start_ticket, close_ticket
- Description: Refuse assign to an inactive technician, start with no technician, and close a queued ticket, checking the ticket after each; then refuse a start after the assigned technician is deactivated.

```js
(ctx) => {
  const benched = ctx.api('POST', '/technicians', { name: 'AT Benched', active: true });
  ctx.assert(benched.status === 201, 'create technician: ' + JSON.stringify(benched.body));
  ctx.assert(ctx.api('PATCH', '/technicians/' + benched.body.id, { active: false }).status === 200, 'deactivate');
  const t = ctx.api('POST', '/tickets', { subject: 'AT atomic probe', customer_name: 'AT Customer', priority: 'normal' });
  ctx.assert(t.status === 201, 'create ticket: ' + JSON.stringify(t.body));
  const id = t.body.id;
  const a1 = ctx.api('POST', '/tickets/' + id + '/assign', { technician_id: benched.body.id });
  ctx.assert(a1.status === 409 && a1.body.error.code === 'technician_inactive', 'assign refused: ' + JSON.stringify(a1));
  const g1 = ctx.api('GET', '/tickets/' + id).body;
  ctx.assert(g1.status === 'queued' && g1.assigned_technician_id === null, 'refused assign wrote nothing: ' + JSON.stringify(g1));
  const s1 = ctx.api('POST', '/tickets/' + id + '/start', {});
  ctx.assert(s1.status === 409 && s1.body.error.code === 'no_technician', 'start refused: ' + JSON.stringify(s1));
  const c1 = ctx.api('POST', '/tickets/' + id + '/close', {});
  ctx.assert(c1.status === 409 && c1.body.error.code === 'invalid_state', 'close refused: ' + JSON.stringify(c1));
  const g2 = ctx.api('GET', '/tickets/' + id).body;
  ctx.assert(g2.status === 'queued' && g2.assigned_technician_id === null, 'refused start and close wrote nothing: ' + JSON.stringify(g2));
  const live = ctx.api('POST', '/technicians', { name: 'AT Later Off', active: true });
  ctx.assert(live.status === 201, 'create second technician: ' + JSON.stringify(live.body));
  ctx.assert(ctx.api('POST', '/tickets/' + id + '/assign', { technician_id: live.body.id }).status === 200, 'assign active technician');
  ctx.assert(ctx.api('PATCH', '/technicians/' + live.body.id, { active: false }).status === 200, 'deactivate after assign');
  const s2 = ctx.api('POST', '/tickets/' + id + '/start', {});
  ctx.assert(s2.status === 409 && s2.body.error.code === 'technician_inactive', 'start with inactive technician refused: ' + JSON.stringify(s2));
  const g3 = ctx.api('GET', '/tickets/' + id).body;
  ctx.assert(g3.status === 'queued' && g3.assigned_technician_id === live.body.id, 'refused start left the ticket queued and assigned: ' + JSON.stringify(g3));
}
```
### list_search_and_paging
- Intent: Listing with a search term pages through exactly the rows the test created, and status and priority filters narrow them.
- Actions: assign_ticket, start_ticket
- Description: Create three tickets with a unique subject token, start one, then page the search two rows at a time and check filters.

```js
(ctx) => {
  const token = 'ATLIST7731';
  const made = [];
  const specs = [['A', 'normal'], ['B', 'urgent'], ['C', 'normal']];
  for (let i = 0; i < specs.length; i++) {
    const c = ctx.api('POST', '/tickets', { subject: token + ' ' + specs[i][0], customer_name: 'AT Lister', priority: specs[i][1] });
    ctx.assert(c.status === 201, 'create: ' + JSON.stringify(c.body));
    made.push(c.body);
  }
  const tech = ctx.api('POST', '/technicians', { name: 'AT Lister Tech', active: true });
  ctx.assert(tech.status === 201, 'create technician: ' + JSON.stringify(tech.body));
  ctx.assert(ctx.api('POST', '/tickets/' + made[0].id + '/assign', { technician_id: tech.body.id }).status === 200, 'assign A');
  ctx.assert(ctx.api('POST', '/tickets/' + made[0].id + '/start', {}).status === 200, 'start A');
  const rows = [];
  let cursor = null;
  let pages = 0;
  do {
    const path = '/tickets?q=' + token + '&limit=2' + (cursor === null ? '' : '&cursor=' + cursor);
    const page = ctx.api('GET', path);
    ctx.assert(page.status === 200, 'page: ' + JSON.stringify(page.body));
    for (const r of page.body.data) rows.push(r);
    cursor = page.body.next_cursor;
    pages += 1;
    ctx.assert(pages <= 5, 'paging does not end');
  } while (cursor !== null && cursor !== undefined);
  ctx.assert(pages === 2, 'three rows at two per page take two pages, got ' + pages);
  ctx.assert(rows.length === 3, 'search returns the three created rows, got ' + rows.length);
  ctx.assert(made.every((m) => rows.some((r) => r.id === m.id)), 'every created row is listed');
  const active = ctx.api('GET', '/tickets?q=' + token + '&status=active');
  ctx.assert(active.status === 200 && active.body.data.length === 1 && active.body.data[0].id === made[0].id, 'status filter returns only the started row: ' + JSON.stringify(active.body));
  const urgent = ctx.api('GET', '/tickets?q=' + token + '&priority=urgent');
  ctx.assert(urgent.status === 200 && urgent.body.data.length === 1 && urgent.body.data[0].id === made[1].id, 'priority filter returns only the urgent row: ' + JSON.stringify(urgent.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_technicians` | GET | /technicians | List technicians, filter by active, search by name. |
| `get_technician` | GET | /technicians/{id} | Fetch one technician. |
| `create_technician` | POST | /technicians | Register a technician; active defaults to true. |
| `update_technician` | PATCH | /technicians/{id} | Rename a technician or set active to false or true. |
| `list_tickets` | GET | /tickets | List tickets with cursor paging of 5 rows, filter by status, priority and assigned technician, search by subject and customer name, sort by priority or created_at. |
| `get_ticket` | GET | /tickets/{id} | Fetch one ticket. |
| `create_ticket` | POST | /tickets | Create a queued, unassigned ticket with subject, customer name and priority. |
| `update_ticket` | PATCH | /tickets/{id} | Edit subject, customer name or priority. Status and assignment are refused here. |

## Seed

- Rows per entity: technician: 4, ticket: 12
- Mix: Fixed hand-written rows, no randomness. Four technicians: Lena Ortiz, Samir Haddad and Mei Tanaka active, Darnell Price inactive. Twelve tickets, ids tkt_0001 to tkt_0012, with 7 queued, 3 active and 2 closed, both priorities, and three urgent queued Northgate Logistics tickets (tkt_0004 on page 1 of the queued list, tkt_0011 and tkt_0012 on page 2). Active tickets are assigned only to active technicians.
- State mix: ticket: queued 58%, active 25%, closed 17%

## Tasks

- `raise_urgent_priority` (easy): The queued ticket 'Projector bulb flickering' from Harbor Dental is now blocking a class. Raise its priority to urgent and change nothing else.
  - Decoy idea: Raises the priority of Harbor Dental's other ticket 'Printer jams on tray 2', which is active, instead of the queued one.
  - Pressure: seeded rows in ticket.queued; distractor rows of ticket
- `assign_and_start_espresso` (medium, permissions): The unassigned queued ticket 'Espresso machine leaking' from Corner Bakery must be taken by the active technician Lena Ortiz: assign it to her and start it. Change nothing else.
  - Actions: `assign_ticket`, `start_ticket`
  - Decoy idea: Assigns the ticket to the inactive technician Darnell Price, which is refused, or assigns Lena and never starts the ticket.
  - Pressure: seeded rows in ticket.queued; distractor rows of ticket
- `start_northgate_urgent_queue` (hard): Samir Haddad is taking over the urgent Northgate Logistics work. Every queued urgent ticket for Northgate Logistics must be assigned to him and started. The ticket list is paged and these tickets are spread across pages. Leave every other ticket unchanged.
  - Actions: `assign_ticket`, `start_ticket`
  - Decoy idea: Reads only the first page of queued tickets, so it starts the Northgate ticket on page 1 and misses the two on page 2.
  - Pressure: paging past the first page of ticket; seeded rows in ticket.queued; distractor rows of ticket

## Open questions

- Can a ticket be reassigned after it has been assigned or started?
  - Default answer: No. assign_ticket works only on queued tickets.
- Can a queued ticket be closed directly without being started?
  - Default answer: No. close_ticket requires active status.
- Does deactivating a technician release or close their active tickets?
  - Default answer: No. Their tickets stay as they are; only starting or assigning with them is refused.
- Should technicians be creatable through the API or only seeded?
  - Default answer: Through the API, with create_technician and update_technician.
- What page size should the ticket list use?
  - Default answer: 5, so the 12 seeded tickets span several pages.
- Should ticket priority be editable once a ticket is closed?
  - Default answer: Yes. The request does not restrict edits.

## Assumptions

- Assignment is allowed only while the ticket is queued; reassigning an active or closed ticket is refused with 409 invalid_state.
  - Why: The request defines assignment as part of starting a queued ticket and does not describe reassignment, so the narrowest state rule is used.
- Closing requires active status; a queued ticket cannot be closed without being started.
  - Why: The request says closing requires active status.
- Deactivating a technician does not change their tickets. start_ticket refuses an inactive assigned technician with 409 technician_inactive, and assign_ticket refuses an inactive technician with 409 technician_inactive.
  - Why: The request says inactive assignments must fail; it does not say deactivation reassigns or closes work.
- Technicians can be created and updated through standard routes (create_technician, update_technician).
  - Why: Acceptance tests must create their own rows through the API before any seed exists, and the inactive path needs a way to deactivate a technician.
- Ticket status and assigned_technician_id are readonly on standard create and update, and change only through assign_ticket, start_ticket and close_ticket.
  - Why: Otherwise a standard PATCH would bypass the assignment and start checks that the request requires to fail atomically.
- Handler error codes: invalid_state (409) for a wrong status, no_technician (409) when starting an unassigned ticket, technician_inactive (409) for an inactive technician, not_found (404) for an unknown ticket or technician.
  - Why: The request names the refusals but not their codes; the codes are fixed here so tests and tasks can assert them.
- Ticket priority can be edited in any status, including closed.
  - Why: The request does not restrict edits to open tickets.
- Tickets have no delete route.
  - Why: The request does not ask for deletion.
- Ticket list page size is 5 and the seed holds 12 tickets, which is more than one page, so the hard task must page.
  - Why: The guidance is just over one page, but the hard task needs paging to reach page-2 rows; 5 is the smallest size that keeps the queued list (7 rows) spanning two pages.
- Clock starts at 2026-10-09T09:00:00.000Z with a 1s tick.
  - Why: Today's date is 2026-10-09, and the start is after every seeded historical event; the tick keeps engine time moving deterministically.
- Search on tickets matches subject and customer_name through the q parameter.
  - Why: Tasks and tests need to find tickets by customer name and subject, which the request's filtering implies.
- Customer is a plain text name on the ticket, not its own entity.
  - Why: The request gives the customer as a name only, and a customer entity would add rows no task needs.

## Out of scope

- A separate customer entity or contact details
  - Why: The request stores a customer name on the ticket only.
- Parts, labour, invoices or time tracking
  - Why: The request covers tickets, technicians and their status only.
- Notifications, SLA timers or scheduled jobs
  - Why: The request names no timed behaviour, so no jobs are declared.
- Authentication, roles and permissions beyond the active flag
  - Why: The request says no credentials or external integrations.
- Deleting tickets or technicians
  - Why: The request does not ask for deletion.
- Attachments and ticket comments
  - Why: Not in the request.

## Changes

None. The plan changes no existing item.
