# WorldGen plan: Snipe-IT style IT asset management (laptops, checkouts, maintenance, audits)

An IT asset tracker. Laptops move between in-stock, assigned, in-repair, lost and retired. Employees check laptops out and back in. Repair tickets take a laptop out of service until complete. Quarterly audits snapshot the laptops at a location, record whether each was found, and close by flagging missing laptops as lost.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-07T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `employee` | A person who can hold laptops; inactive means offboarded. | name, email, department, active |
| `laptop` | A tracked asset with a lifecycle state and a location. | asset_tag, serial, model, location, purchased_on, status |
| `assignment` | A checkout of a laptop to an employee; active until returned. | laptop_id, employee_id, assigned_at, returned_at, active |
| `repair_ticket` | A repair job on a laptop. | laptop_id, issue, status, stale, cost, resolution |
| `audit` | A quarterly audit of the laptops at one location. | quarter, location, status, found_count, missing_count |
| `audit_item` | One laptop line in an audit with its expected holder and verification result. | audit_id, laptop_id, expected_holder_id, result |

## Workflows

### laptop_lifecycle (laptop)
- States: in_stock, assigned, in_repair, lost, retired
- Actions: assign_laptop, return_laptop, retire_laptop
- Rules:
  - assign_laptop only works on an in_stock laptop and an existing employee: it creates an active assignment and moves the laptop to assigned. Otherwise it answers 409 invalid_state. Enforced by: assign_laptop. Tested by: t_assign
  - return_laptop only works on an assigned laptop: it closes the active assignment (active false, returned_at set) and moves the laptop to in_stock. Enforced by: return_laptop. Tested by: t_return
  - retire_laptop retires an in_stock or lost laptop and nothing else. retired is final and a retired laptop cannot be assigned. Enforced by: retire_laptop. Tested by: t_retire
  - Laptop asset_tag and serial are unique. Enforced by the data model: unique constraints on the fields
### repair_flow (repair_ticket)
- States: open, completed
- Actions: open_repair, complete_repair
- Rules:
  - open_repair works on an in_stock or assigned laptop: it creates an open ticket, ends any active assignment and moves the laptop to in_repair. Enforced by: open_repair. Tested by: t_open_repair
  - complete_repair completes an open ticket, records the resolution and cost, and returns the laptop to in_stock. A completed ticket cannot be completed again. Enforced by: complete_repair. Tested by: t_complete_repair
  - An open ticket older than 7 days is flagged stale by the daily job. Enforced by: flag_stale_repairs. Tested by: t_stale
### quarterly_audit (audit)
- States: planned, in_progress, closed
- Actions: start_audit, verify_audit_item, close_audit
- Rules:
  - start_audit works on a planned audit: it creates one pending audit_item per non-retired, non-lost laptop at the audit's location, recording the current holder, and moves the audit to in_progress. Enforced by: start_audit. Tested by: t_audit_start
  - verify_audit_item records found, missing or mismatch on a pending item of an in_progress audit. An item cannot be verified twice. Enforced by: verify_audit_item. Tested by: t_audit_verify
  - close_audit needs every item verified (else 409 audit_incomplete). It stores found_count and missing_count, marks missing laptops lost, ends their active assignment and closes the audit. Enforced by: close_audit. Tested by: t_audit_close

## Jobs

- `flag_stale_repairs` runs every 1d: Set stale to true on every open repair ticket created at least 7 days ago.

## Acceptance tests

### t_assign
- Intent: Assigning an in-stock laptop creates an assignment and refuses repeats and unknown employees
- Actions: assign_laptop
- Description: Create an employee and a laptop, assign it, check state and assignment, then check the refusals.

```js
(ctx) => {
  const e = ctx.api('POST','/employees',{name:'Assign Tester',email:'assign.tester@test.example',department:'Engineering'});
  ctx.assert(e.status===201,'employee create '+JSON.stringify(e.body));
  const l = ctx.api('POST','/laptops',{asset_tag:'TST-A-001',serial:'TSTSN-A-001',model:'ThinkPad T14',location:'Test Lab A'});
  ctx.assert(l.status===201 && l.body.status==='in_stock','laptop create '+JSON.stringify(l.body));
  const r = ctx.api('POST','/laptops/'+l.body.id+'/assign',{employee_id:e.body.id});
  ctx.assert(r.status===200 && r.body.status==='assigned','assign '+JSON.stringify(r.body));
  const as = ctx.api('GET','/assignments?laptop_id='+l.body.id+'&active=true').body.data;
  ctx.assert(as.length===1 && as[0].employee_id===e.body.id,'one active assignment for the employee');
  const again = ctx.api('POST','/laptops/'+l.body.id+'/assign',{employee_id:e.body.id});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','second assign '+JSON.stringify(again.body));
  const l2 = ctx.api('POST','/laptops',{asset_tag:'TST-A-002',serial:'TSTSN-A-002',model:'ThinkPad T14',location:'Test Lab A'});
  const bad = ctx.api('POST','/laptops/'+l2.body.id+'/assign',{employee_id:'emp_9999'});
  ctx.assert(bad.status===400 && bad.body.error.code==='input.invalid','unknown employee '+JSON.stringify(bad.body));
  ctx.assert(ctx.api('GET','/laptops/'+l2.body.id).body.status==='in_stock','laptop unchanged after refusal');
}
```
### t_return
- Intent: Returning a laptop closes the assignment and restocks it
- Actions: assign_laptop, return_laptop
- Description: Assign then return a laptop, check assignment and laptop, and that a second return is refused.

```js
(ctx) => {
  const e = ctx.api('POST','/employees',{name:'Return Tester',email:'return.tester@test.example',department:'Sales'});
  const l = ctx.api('POST','/laptops',{asset_tag:'TST-R-001',serial:'TSTSN-R-001',model:'MacBook Air',location:'Test Lab R'});
  ctx.assert(ctx.api('POST','/laptops/'+l.body.id+'/assign',{employee_id:e.body.id}).status===200,'assign');
  const r = ctx.api('POST','/laptops/'+l.body.id+'/return',{});
  ctx.assert(r.status===200 && r.body.status==='in_stock','return '+JSON.stringify(r.body));
  const as = ctx.api('GET','/assignments?laptop_id='+l.body.id).body.data;
  ctx.assert(as.length===1 && as[0].active===false && as[0].returned_at!==null,'assignment closed '+JSON.stringify(as));
  const again = ctx.api('POST','/laptops/'+l.body.id+'/return',{});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','second return '+JSON.stringify(again.body));
}
```
### t_retire
- Intent: Retiring works only on in-stock or lost laptops and is final
- Actions: retire_laptop, assign_laptop
- Description: Retire an in-stock laptop, then check it cannot be retired or assigned again, and an assigned laptop cannot be retired.

```js
(ctx) => {
  const e = ctx.api('POST','/employees',{name:'Retire Tester',email:'retire.tester@test.example',department:'Finance'});
  const l = ctx.api('POST','/laptops',{asset_tag:'TST-T-001',serial:'TSTSN-T-001',model:'Dell XPS 13',location:'Test Lab T'});
  const r = ctx.api('POST','/laptops/'+l.body.id+'/retire',{});
  ctx.assert(r.status===200 && r.body.status==='retired','retire '+JSON.stringify(r.body));
  const again = ctx.api('POST','/laptops/'+l.body.id+'/retire',{});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','retire twice '+JSON.stringify(again.body));
  const as = ctx.api('POST','/laptops/'+l.body.id+'/assign',{employee_id:e.body.id});
  ctx.assert(as.status===409 && as.body.error.code==='invalid_state','assign retired '+JSON.stringify(as.body));
  const l2 = ctx.api('POST','/laptops',{asset_tag:'TST-T-002',serial:'TSTSN-T-002',model:'Dell XPS 13',location:'Test Lab T'});
  ctx.api('POST','/laptops/'+l2.body.id+'/assign',{employee_id:e.body.id});
  const busy = ctx.api('POST','/laptops/'+l2.body.id+'/retire',{});
  ctx.assert(busy.status===409 && busy.body.error.code==='invalid_state','retire assigned '+JSON.stringify(busy.body));
}
```
### t_open_repair
- Intent: Opening a repair takes the laptop out of service and ends its assignment
- Actions: assign_laptop, open_repair
- Description: Assign a laptop, open a repair, check ticket, laptop and assignment, and that a second repair is refused.

```js
(ctx) => {
  const e = ctx.api('POST','/employees',{name:'Repair Tester',email:'repair.tester@test.example',department:'Support'});
  const l = ctx.api('POST','/laptops',{asset_tag:'TST-P-001',serial:'TSTSN-P-001',model:'ThinkPad X1',location:'Test Lab P'});
  ctx.api('POST','/laptops/'+l.body.id+'/assign',{employee_id:e.body.id});
  const r = ctx.api('POST','/laptops/'+l.body.id+'/repair',{issue:'Cracked screen'});
  ctx.assert(r.status===200 && r.body.status==='open' && r.body.laptop_id===l.body.id && r.body.issue==='Cracked screen','open repair '+JSON.stringify(r.body));
  ctx.assert(ctx.api('GET','/laptops/'+l.body.id).body.status==='in_repair','laptop in_repair');
  const as = ctx.api('GET','/assignments?laptop_id='+l.body.id).body.data;
  ctx.assert(as.length===1 && as[0].active===false,'assignment ended');
  const again = ctx.api('POST','/laptops/'+l.body.id+'/repair',{issue:'Another'});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','repair while in repair '+JSON.stringify(again.body));
}
```
### t_complete_repair
- Intent: Completing a repair records the outcome and restocks the laptop
- Actions: open_repair, complete_repair
- Description: Open and complete a repair, check ticket and laptop, and that a second completion is refused.

```js
(ctx) => {
  const l = ctx.api('POST','/laptops',{asset_tag:'TST-C-001',serial:'TSTSN-C-001',model:'ThinkPad X1',location:'Test Lab C'});
  const t = ctx.api('POST','/laptops/'+l.body.id+'/repair',{issue:'Keyboard dead'});
  ctx.assert(t.status===200,'open repair '+JSON.stringify(t.body));
  const r = ctx.api('POST','/repair_tickets/'+t.body.id+'/complete',{resolution:'Replaced keyboard',cost:12000});
  ctx.assert(r.status===200 && r.body.status==='completed' && r.body.cost===12000 && r.body.resolution==='Replaced keyboard','complete '+JSON.stringify(r.body));
  ctx.assert(ctx.api('GET','/laptops/'+l.body.id).body.status==='in_stock','laptop back in stock');
  const again = ctx.api('POST','/repair_tickets/'+t.body.id+'/complete',{resolution:'x',cost:1});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','complete twice '+JSON.stringify(again.body));
}
```
### t_stale
- Intent: The daily job flags open repair tickets older than 7 days as stale
- Actions: open_repair
- Description: Open a repair, confirm it is fresh, advance 8 days, confirm it is stale.

```js
(ctx) => {
  const l = ctx.api('POST','/laptops',{asset_tag:'TST-S-001',serial:'TSTSN-S-001',model:'ThinkPad T14',location:'Test Lab S'});
  const t = ctx.api('POST','/laptops/'+l.body.id+'/repair',{issue:'Battery drains fast'});
  ctx.assert(t.status===200 && t.body.stale===false,'new ticket not stale '+JSON.stringify(t.body));
  ctx.advance('8d');
  const after = ctx.api('GET','/repair_tickets/'+t.body.id).body;
  ctx.assert(after.stale===true && after.status==='open','stale after 8 days '+JSON.stringify(after));
}
```
### t_audit_start
- Intent: Starting an audit snapshots the laptops at its location with current holders
- Actions: assign_laptop, start_audit
- Description: Build two laptops in one location, one assigned, start the audit and check the items.

```js
(ctx) => {
  const e = ctx.api('POST','/employees',{name:'Audit Start Tester',email:'auditstart.tester@test.example',department:'IT'});
  const a = ctx.api('POST','/laptops',{asset_tag:'TST-U-001',serial:'TSTSN-U-001',model:'ThinkPad T14',location:'Audit Lab 1'});
  const b = ctx.api('POST','/laptops',{asset_tag:'TST-U-002',serial:'TSTSN-U-002',model:'ThinkPad T14',location:'Audit Lab 1'});
  ctx.api('POST','/laptops/'+a.body.id+'/assign',{employee_id:e.body.id});
  const au = ctx.api('POST','/audits',{quarter:'2026-Q4',location:'Audit Lab 1'});
  ctx.assert(au.status===201 && au.body.status==='planned','audit create '+JSON.stringify(au.body));
  const s = ctx.api('POST','/audits/'+au.body.id+'/start',{});
  ctx.assert(s.status===200 && s.body.status==='in_progress','start '+JSON.stringify(s.body));
  const items = ctx.api('GET','/audit_items?audit_id='+au.body.id).body.data;
  ctx.assert(items.length===2 && items.every((i)=>i.result==='pending'),'two pending items');
  const ia = items.find((i)=>i.laptop_id===a.body.id);
  const ib = items.find((i)=>i.laptop_id===b.body.id);
  ctx.assert(ia && ia.expected_holder_id===e.body.id,'assigned laptop records holder');
  ctx.assert(ib && ib.expected_holder_id===null,'stock laptop has no holder');
  const again = ctx.api('POST','/audits/'+au.body.id+'/start',{});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','start twice '+JSON.stringify(again.body));
}
```
### t_audit_verify
- Intent: Items can be verified once, and only in an in-progress audit
- Actions: start_audit, verify_audit_item
- Description: Verify before start is refused, verify once after start, then repeat and bad results are refused.

```js
(ctx) => {
  const a = ctx.api('POST','/laptops',{asset_tag:'TST-V-001',serial:'TSTSN-V-001',model:'MacBook Pro',location:'Audit Lab 2'});
  const au = ctx.api('POST','/audits',{quarter:'2026-Q4',location:'Audit Lab 2'});
  ctx.assert(ctx.api('GET','/audit_items?audit_id='+au.body.id).body.data.length===0,'no items before start');
  ctx.api('POST','/audits/'+au.body.id+'/start',{});
  const item = ctx.api('GET','/audit_items?audit_id='+au.body.id).body.data[0];
  ctx.assert(item && item.laptop_id===a.body.id,'item for laptop');
  const bad = ctx.api('POST','/audit_items/'+item.id+'/verify',{result:'bogus'});
  ctx.assert(bad.status===400 && bad.body.error.code==='input.invalid','bad result '+JSON.stringify(bad.body));
  const r = ctx.api('POST','/audit_items/'+item.id+'/verify',{result:'found'});
  ctx.assert(r.status===200 && r.body.result==='found','verify '+JSON.stringify(r.body));
  const again = ctx.api('POST','/audit_items/'+item.id+'/verify',{result:'missing'});
  ctx.assert(again.status===409 && again.body.error.code==='invalid_state','verify twice '+JSON.stringify(again.body));
}
```
### t_audit_close
- Intent: Closing needs every item verified, counts results and marks missing laptops lost
- Actions: assign_laptop, start_audit, verify_audit_item, close_audit
- Description: Audit two laptops, one found and one missing and assigned. Check the refusal, counts, lost laptop and ended assignment.

```js
(ctx) => {
  const e = ctx.api('POST','/employees',{name:'Audit Close Tester',email:'auditclose.tester@test.example',department:'IT'});
  const a = ctx.api('POST','/laptops',{asset_tag:'TST-X-001',serial:'TSTSN-X-001',model:'ThinkPad T14',location:'Audit Lab 3'});
  const b = ctx.api('POST','/laptops',{asset_tag:'TST-X-002',serial:'TSTSN-X-002',model:'ThinkPad T14',location:'Audit Lab 3'});
  ctx.assert(a.status===201 && b.status===201,'laptops created');
  ctx.api('POST','/laptops/'+b.body.id+'/assign',{employee_id:e.body.id});
  const au = ctx.api('POST','/audits',{quarter:'2026-Q4',location:'Audit Lab 3'});
  ctx.assert(au.status===201,'audit created '+JSON.stringify(au.body));
  const st = ctx.api('POST','/audits/'+au.body.id+'/start',{});
  ctx.assert(st.status===200,'audit started '+JSON.stringify(st.body));
  const items = ctx.api('GET','/audit_items?audit_id='+au.body.id).body.data || [];
  const ia = items.find((i)=>i.laptop_id===a.body.id);
  const ib = items.find((i)=>i.laptop_id===b.body.id);
  ctx.assert(ia && ib,'audit has an item for each laptop '+JSON.stringify(items));
  ctx.api('POST','/audit_items/'+ia.id+'/verify',{result:'found'});
  const early = ctx.api('POST','/audits/'+au.body.id+'/close',{});
  ctx.assert(early.status===409 && early.body.error.code==='audit_incomplete','close early '+JSON.stringify(early.body));
  ctx.api('POST','/audit_items/'+ib.id+'/verify',{result:'missing'});
  const c = ctx.api('POST','/audits/'+au.body.id+'/close',{});
  ctx.assert(c.status===200 && c.body.status==='closed' && c.body.found_count===1 && c.body.missing_count===1,'close '+JSON.stringify(c.body));
  ctx.assert(ctx.api('GET','/laptops/'+b.body.id).body.status==='lost','missing laptop lost');
  ctx.assert(ctx.api('GET','/laptops/'+a.body.id).body.status==='in_stock','found laptop unchanged');
  const as = ctx.api('GET','/assignments?laptop_id='+b.body.id).body.data;
  ctx.assert(as.length===1 && as[0].active===false,'assignment ended');
  const verify = ctx.api('POST','/audit_items/'+ia.id+'/verify',{result:'found'});
  ctx.assert(verify.status===409,'closed audit refuses verify');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_employees` | GET | /employees | List employees, filter by active and department |
| `get_employee` | GET | /employees/{id} | Get an employee |
| `create_employee` | POST | /employees | Create an employee |
| `update_employee` | PATCH | /employees/{id} | Update an employee, such as deactivating |
| `list_laptops` | GET | /laptops | List laptops, filter by status, location, model; search asset_tag and serial |
| `get_laptop` | GET | /laptops/{id} | Get a laptop |
| `create_laptop` | POST | /laptops | Register a laptop (starts in_stock) |
| `update_laptop` | PATCH | /laptops/{id} | Edit laptop details |
| `list_assignments` | GET | /assignments | List assignments, filter by laptop_id, employee_id, active |
| `get_assignment` | GET | /assignments/{id} | Get an assignment |
| `list_repair_tickets` | GET | /repair_tickets | List repair tickets, filter by status, laptop_id, stale |
| `get_repair_ticket` | GET | /repair_tickets/{id} | Get a repair ticket |
| `list_audits` | GET | /audits | List audits, filter by status, quarter, location |
| `get_audit` | GET | /audits/{id} | Get an audit |
| `create_audit` | POST | /audits | Plan an audit for a quarter and location |
| `list_audit_items` | GET | /audit_items | List audit items, filter by audit_id, result, laptop_id |
| `get_audit_item` | GET | /audit_items/{id} | Get an audit item |

## Seed

- Rows per entity: employee: 30, laptop: 60, assignment: 50, repair_ticket: 30, audit: 4, audit_item: 60
- Mix: Laptops spread across five states with assigned the largest. Repair tickets include several open ones older than 7 days, flagged stale, and near-duplicates that are fresh or completed. One audit is in progress with about 60 items, about half pending, and some expected holders are inactive employees.
- State mix: laptop: in_stock 25%, assigned 43%, in_repair 12%, lost 8%, retired 12%; repair_ticket: open 40%, completed 60%; audit: planned 25%, in_progress 25%, closed 50%

## Tasks

- `assign_spare_laptop` (easy): Assign the in-stock laptop with a given asset tag to a named employee.
  - Decoy idea: Assigns a different in-stock laptop of the same model, or PATCHes the laptop status instead of calling assign.
- `send_assigned_laptop_to_repair` (medium): Open a repair ticket with a given issue for the laptop currently assigned to a named employee, who has two laptops in history. Do not touch other laptops.
  - Decoy idea: Picks the employee's earlier, already returned laptop, or opens the repair on a similar model.
- `close_in_progress_audit` (hard): In the in-progress audit, mark every pending item found, except items whose expected holder is an inactive employee, which are marked missing, then close the audit.
  - Decoy idea: Reads only the first page of pending items, marks everything found, or closes without checking holder status.

## Open questions

- Should audits cover all locations or one location each?
  - Default answer: One location per audit.
- Should a missing laptop become lost automatically?
  - Default answer: Yes, on audit close.
- Do repairs have intermediate states?
  - Default answer: No, only open and completed.

## Assumptions

- Clock starts 2026-10-07T09:00:00Z with tick 0s
  - Why: Seeded history all precedes this; time moves only through explicit advance, so tests are deterministic.
- Audits are scoped by location; start_audit snapshots non-retired, non-lost laptops at that location
  - Why: Lets tests build isolated audits without touching seeded laptops.
- Laptop status changes happen through actions; acceptance tests use only actions for transitions
  - Why: The business rules live in actions.
- Action calls return 200 with the affected row; refusals use 409 invalid_state
  - Why: Matches the engine conventions.
- Closing an audit marks laptops with a missing result as lost and ends their active assignment
  - Why: Gives the audit a real consequence.
- Repair tickets have only open and completed states
  - Why: Keeps the workflow small and enough for the tasks.
- A job flags open repair tickets older than 7 days as stale
  - Why: Gives a time-driven rule and a filterable field for a hard task.
- Test data uses @test.example emails, TST- tags and 'Test Lab'/'Audit Lab' locations
  - Why: Avoids collisions with seed rows.
- audit_item result (pending/found/missing/mismatch) is a plain enum, not a workflow state machine
  - Why: The audit workflow is the audit entity; items are verified once by an action.
- t_audit_close asserts that the laptops, audit start and audit items exist before using them
  - Why: The test must fail with a clear message rather than throw when an earlier step did not produce a row.

## Out of scope

- Purchasing, depreciation and warranty accounting
  - Why: The request covers tracking, assignment, repair and audit only.
- Non-laptop asset types, barcode scanning, file attachments, notifications
  - Why: Not needed for the stateful workflows.
- Authentication and roles
  - Why: The world is a single-tenant API.

## Changes

- acceptanceTests.t_audit_close because the test threw on ia.id when the audit had no items
