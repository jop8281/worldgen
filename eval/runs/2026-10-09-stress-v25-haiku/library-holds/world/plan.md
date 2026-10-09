# WorldGen plan: Library circulation system (Koha-style branches, copies, holds and fines)

A public library circulation API. Branches hold book copies of titles. Members borrow copies as checkouts with a due date. A holds queue per title serves waiting members in order when a copy comes back. Overdue checkouts accrue fines that block new loans until paid. The world has four workflows (copy, loan, hold queue, fine settlement), six actions, two jobs, list and get routes for every entity, and a seed with one list page of copies and a few scenarios the tasks need.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `branch` | A library branch that holds copies and is the home branch of members. | code |
| `title` | A bibliographic title. Copies are physical instances of a title. | title, author |
| `book_copy` | One physical copy at a branch. Its status is the copy lifecycle: available, checked_out, on_hold or withdrawn. | barcode, title_id, branch_id, status |
| `member` | A library patron who borrows copies and places holds. | email, home_branch_id |
| `checkout` | A loan of one copy to one member with a due date. Created only by checkout_copy and closed by return_copy. | member_id, copy_id, due_at, status |
| `hold` | A member's place in the queue for a title. Becomes ready when a copy comes back, names that copy and expires after a window. | title_id, member_id, queued_at, status |
| `fine` | Money a member owes for one overdue checkout. One fine per checkout, amount grows daily until paid. | member_id, checkout_id, amount, status |

## Workflows

### copy_lifecycle (book_copy)
- States: available, checked_out, on_hold, withdrawn
- Actions: checkout_copy, return_copy, withdraw_copy
- Rules:
  - a copy is lent only when it is available, or on hold for the member whose ready hold names it
  - only an available copy can be withdrawn; withdrawn is final
  - a copy on loan cannot be lent again while checked out Enforced by: checkout_copy. Tested by: acc_refuses_lent_copy
### loan (checkout)
- States: active, returned
- Actions: checkout_copy, return_copy
- Rules:
  - a loan is due 14 days after checkout
  - a returned loan stays returned
### hold_queue (hold)
- States: waiting, ready, fulfilled, cancelled
- Actions: place_hold, cancel_hold, checkout_copy, return_copy
- Rules:
  - a returned copy goes to the earliest waiting hold for its title, ties broken by id Enforced by: return_copy. Tested by: acc_return_serves_first_hold
  - a member holds a title at most once while the hold is waiting or ready Enforced by: place_hold. Tested by: acc_one_hold_per_member
  - a ready hold expires 3 days after it becomes ready and frees its copy Enforced by: expire_ready_holds. Tested by: acc_ready_hold_expires
### fine_settlement (fine)
- States: open, paid
- Actions: pay_fine
- Rules:
  - an overdue checkout accrues one open fine of 25 minor units per full day overdue Enforced by: accrue_overdue_fines. Tested by: acc_overdue_accrues_fine
  - a member with an open fine cannot check out a copy Enforced by: checkout_copy. Tested by: acc_fines_block_checkout
  - a paid fine cannot be paid again

## Jobs

- `expire_ready_holds` runs every 1h: Every hour. A ready hold whose ready_until has passed is cancelled and its copy becomes available.
- `accrue_overdue_fines` runs every 1d: Every day. For each active checkout past its due_at, create its fine if none exists, then set the open fine amount to 25 times the full days overdue.

## Acceptance tests

### acc_checkout_lends_copy
- Intent: A member borrows an available copy and the copy is checked out.
- Actions: checkout_copy
- Description: Create branch, title, copy and member through the API, check the copy out, and confirm an active loan with a future due date and a checked_out copy.

```js
(ctx) => { const b = ctx.api('POST','/branches',{name:'QA Harbor 1',code:'QA-B1',city:'Testville'}); ctx.assert(b.status===201,'branch create returned '+b.status); const t = ctx.api('POST','/titles',{title:'QA Lend Title',author:'QA Author'}); ctx.assert(t.status===201,'title create returned '+t.status); const c = ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-LEND-1'}); ctx.assert(c.status===201 && c.body.status==='available','new copy is available, got '+JSON.stringify(c.body)); const m = ctx.api('POST','/members',{name:'QA Lend Member',email:'qa.lend@library.example',home_branch_id:b.body.id}); ctx.assert(m.status===201,'member create returned '+m.status); const r = ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:m.body.id}); ctx.assert(r.status===201,'checkout returned '+r.status+' '+JSON.stringify(r.body)); ctx.assert(r.body.status==='active' && r.body.member_id===m.body.id && r.body.copy_id===c.body.id,'checkout is active for this member and copy, got '+JSON.stringify(r.body)); ctx.assert(r.body.due_at > ctx.now(),'due date is after now, got '+r.body.due_at); const after = ctx.api('GET','/copies/'+c.body.id); ctx.assert(after.status===200 && after.body.status==='checked_out','copy is checked_out, got '+after.body.status); }
```
### acc_refuses_lent_copy
- Intent: A copy already on loan cannot be lent to a second member.
- Actions: checkout_copy
- Description: Check a copy out to one member, then try to check it out to another and expect copy_unavailable while the first loan stays active.

```js
(ctx) => { const b=ctx.api('POST','/branches',{name:'QA Ridge 2',code:'QA-B2',city:'Testville'}); const t=ctx.api('POST','/titles',{title:'QA Lend Title 2',author:'QA Author'}); const c=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-2'}); const a=ctx.api('POST','/members',{name:'QA Member 2A',email:'qa.2a@library.example',home_branch_id:b.body.id}); const z=ctx.api('POST','/members',{name:'QA Member 2B',email:'qa.2b@library.example',home_branch_id:b.body.id}); ctx.assert(b.status===201&&t.status===201&&c.status===201&&a.status===201&&z.status===201,'setup rows created'); const first=ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:a.body.id}); ctx.assert(first.status===201,'first checkout returned '+first.status); const second=ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:z.body.id}); ctx.assert(second.status===409 && second.body.error.code==='copy_unavailable','second checkout refused with copy_unavailable, got '+second.status+' '+JSON.stringify(second.body)); const still=ctx.api('GET','/checkouts/'+first.body.id); ctx.assert(still.status===200 && still.body.member_id===a.body.id && still.body.status==='active','the first loan is untouched, got '+JSON.stringify(still.body)); }
```
### acc_return_serves_first_hold
- Intent: Returning a copy puts it on hold for the first waiting member; only that member can collect it.
- Actions: return_copy, place_hold, checkout_copy
- Description: Member A borrows a copy; B then C place holds; A returns the copy. B's hold becomes ready on that copy, C is refused with copy_reserved, and B collects it and the hold is fulfilled.

```js
(ctx) => { const b=ctx.api('POST','/branches',{name:'QA Mill 3',code:'QA-B3',city:'Testville'}); const t=ctx.api('POST','/titles',{title:'QA Queue Title',author:'QA Author'}); const c=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-3'}); const a=ctx.api('POST','/members',{name:'QA Member 3A',email:'qa.3a@library.example',home_branch_id:b.body.id}); const q=ctx.api('POST','/members',{name:'QA Member 3B',email:'qa.3b@library.example',home_branch_id:b.body.id}); const w=ctx.api('POST','/members',{name:'QA Member 3C',email:'qa.3c@library.example',home_branch_id:b.body.id}); ctx.assert(b.status===201&&t.status===201&&c.status===201&&a.status===201&&q.status===201&&w.status===201,'setup rows created'); const out=ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:a.body.id}); ctx.assert(out.status===201,'A checks out, got '+out.status); const hb=ctx.api('POST','/titles/'+t.body.id+'/holds',{member_id:q.body.id}); ctx.assert(hb.status===201&&hb.body.status==='waiting','B holds and waits, got '+JSON.stringify(hb.body)); const hc=ctx.api('POST','/titles/'+t.body.id+'/holds',{member_id:w.body.id}); ctx.assert(hc.status===201&&hc.body.status==='waiting','C holds and waits, got '+hc.status); const back=ctx.api('POST','/checkouts/'+out.body.id+'/return',{}); ctx.assert(back.status===200&&back.body.status==='returned','return returned '+back.status+' '+JSON.stringify(back.body)); const copy=ctx.api('GET','/copies/'+c.body.id).body; ctx.assert(copy.status==='on_hold','copy is on_hold after return, got '+copy.status); const bReady=ctx.api('GET','/holds/'+hb.body.id).body; ctx.assert(bReady.status==='ready' && bReady.copy_id===c.body.id,'first hold B is ready on the copy, got '+JSON.stringify(bReady)); const cWait=ctx.api('GET','/holds/'+hc.body.id).body; ctx.assert(cWait.status==='waiting','second hold C still waits, got '+cWait.status); const early=ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:w.body.id}); ctx.assert(early.status===409 && early.body.error.code==='copy_reserved','C refused with copy_reserved, got '+early.status+' '+JSON.stringify(early.body)); const got=ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:q.body.id}); ctx.assert(got.status===201,'B collects, got '+got.status+' '+JSON.stringify(got.body)); const done=ctx.api('GET','/holds/'+hb.body.id).body; ctx.assert(done.status==='fulfilled','B hold fulfilled, got '+done.status); ctx.assert(ctx.api('GET','/copies/'+c.body.id).body.status==='checked_out','copy is checked_out again'); }
```
### acc_one_hold_per_member
- Intent: A member cannot hold the same title twice, and a waiting hold can be cancelled.
- Actions: place_hold, cancel_hold
- Description: Place a hold, place a second hold on the same title by the same member and expect duplicate_hold; cancel the first and see it cancelled.

```js
(ctx) => { const b=ctx.api('POST','/branches',{name:'QA Central 4',code:'QA-B4',city:'Testville'}); const t=ctx.api('POST','/titles',{title:'QA Hold Title',author:'QA Author'}); const m=ctx.api('POST','/members',{name:'QA Member 4',email:'qa.4@library.example',home_branch_id:b.body.id}); ctx.assert(b.status===201&&t.status===201&&m.status===201,'setup rows created'); const first=ctx.api('POST','/titles/'+t.body.id+'/holds',{member_id:m.body.id}); ctx.assert(first.status===201&&first.body.status==='waiting','first hold waiting, got '+JSON.stringify(first.body)); const again=ctx.api('POST','/titles/'+t.body.id+'/holds',{member_id:m.body.id}); ctx.assert(again.status===409 && again.body.error.code==='duplicate_hold','second hold refused with duplicate_hold, got '+again.status+' '+JSON.stringify(again.body)); const cancel=ctx.api('POST','/holds/'+first.body.id+'/cancel',{}); ctx.assert(cancel.status===200 && cancel.body.status==='cancelled','cancel returned '+cancel.status+' '+JSON.stringify(cancel.body)); }
```
### acc_overdue_accrues_fine
- Intent: An overdue checkout accrues an open fine for its member.
- Actions: checkout_copy
- Description: Check a copy out, advance the clock 15 days past its 14-day due date, and expect one open fine with a positive amount for that member; the loan is still active.

```js
(ctx) => { const b=ctx.api('POST','/branches',{name:'QA Harbor 5',code:'QA-B5',city:'Testville'}); const t=ctx.api('POST','/titles',{title:'QA Overdue Title',author:'QA Author'}); const c=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-5'}); const m=ctx.api('POST','/members',{name:'QA Member 5',email:'qa.5@library.example',home_branch_id:b.body.id}); ctx.assert(b.status===201&&t.status===201&&c.status===201&&m.status===201,'setup rows created'); const out=ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:m.body.id}); ctx.assert(out.status===201,'checkout returned '+out.status); ctx.advance('15d'); const fines=ctx.api('GET','/fines?member_id='+m.body.id).body.data; ctx.assert(fines.length===1,'one fine for this member, got '+fines.length); ctx.assert(fines[0].status==='open' && fines[0].amount>0 && fines[0].checkout_id===out.body.id,'open fine on this loan, got '+JSON.stringify(fines[0])); const loan=ctx.api('GET','/checkouts/'+out.body.id).body; ctx.assert(loan.status==='active','loan is still active, got '+loan.status); }
```
### acc_fines_block_checkout
- Intent: A member with an open fine cannot borrow until the fine is paid.
- Actions: checkout_copy, pay_fine
- Description: Borrow one copy, go 15 days past due, try to borrow a second copy and expect fines_owed; pay the fine, then the second checkout succeeds.

```js
(ctx) => { const b=ctx.api('POST','/branches',{name:'QA Harbor 6',code:'QA-B6',city:'Testville'}); const t=ctx.api('POST','/titles',{title:'QA Fine Title',author:'QA Author'}); const c1=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-6A'}); const c2=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-6B'}); const m=ctx.api('POST','/members',{name:'QA Member 6',email:'qa.6@library.example',home_branch_id:b.body.id}); ctx.assert(b.status===201&&t.status===201&&c1.status===201&&c2.status===201&&m.status===201,'setup rows created'); ctx.assert(ctx.api('POST','/copies/'+c1.body.id+'/checkout',{member_id:m.body.id}).status===201,'first loan made'); ctx.advance('15d'); const blocked=ctx.api('POST','/copies/'+c2.body.id+'/checkout',{member_id:m.body.id}); ctx.assert(blocked.status===409 && blocked.body.error.code==='fines_owed','loan refused with fines_owed, got '+blocked.status+' '+JSON.stringify(blocked.body)); const open=ctx.api('GET','/fines?member_id='+m.body.id+'&status=open').body.data; ctx.assert(open.length===1,'one open fine, got '+open.length); const paid=ctx.api('POST','/fines/'+open[0].id+'/pay',{}); ctx.assert(paid.status===200 && paid.body.status==='paid','pay returned '+paid.status+' '+JSON.stringify(paid.body)); const ok=ctx.api('POST','/copies/'+c2.body.id+'/checkout',{member_id:m.body.id}); ctx.assert(ok.status===201,'loan allowed after payment, got '+ok.status+' '+JSON.stringify(ok.body)); }
```
### acc_ready_hold_expires
- Intent: A ready hold that is not collected in 3 days expires and frees its copy.
- Actions: place_hold, return_copy
- Description: Return a copy with a waiting hold so the hold becomes ready, advance 4 days, and expect the hold cancelled and the copy available.

```js
(ctx) => { const b=ctx.api('POST','/branches',{name:'QA Mill 7',code:'QA-B7',city:'Testville'}); const t=ctx.api('POST','/titles',{title:'QA Expire Title',author:'QA Author'}); const c=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-7'}); const a=ctx.api('POST','/members',{name:'QA Member 7A',email:'qa.7a@library.example',home_branch_id:b.body.id}); const q=ctx.api('POST','/members',{name:'QA Member 7B',email:'qa.7b@library.example',home_branch_id:b.body.id}); ctx.assert(b.status===201&&t.status===201&&c.status===201&&a.status===201&&q.status===201,'setup rows created'); const out=ctx.api('POST','/copies/'+c.body.id+'/checkout',{member_id:a.body.id}); ctx.assert(out.status===201,'A checks out'); const h=ctx.api('POST','/titles/'+t.body.id+'/holds',{member_id:q.body.id}); ctx.assert(h.status===201,'B holds'); ctx.assert(ctx.api('POST','/checkouts/'+out.body.id+'/return',{}).status===200,'A returns'); ctx.assert(ctx.api('GET','/holds/'+h.body.id).body.status==='ready','B hold is ready'); ctx.advance('4d'); const expired=ctx.api('GET','/holds/'+h.body.id).body; ctx.assert(expired.status==='cancelled','hold expired to cancelled, got '+expired.status); ctx.assert(ctx.api('GET','/copies/'+c.body.id).body.status==='available','copy is available again'); }
```
### acc_withdraw_only_available
- Intent: Only an available copy can be withdrawn, and a withdrawn copy cannot be lent.
- Actions: withdraw_copy, checkout_copy
- Description: Refuse withdrawal of a checked-out copy with copy_unavailable, withdraw an available copy, and refuse to lend it.

```js
(ctx) => { const b=ctx.api('POST','/branches',{name:'QA Central 8',code:'QA-B8',city:'Testville'}); const t=ctx.api('POST','/titles',{title:'QA Withdraw Title',author:'QA Author'}); const c1=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-8A'}); const c2=ctx.api('POST','/copies',{title_id:t.body.id,branch_id:b.body.id,barcode:'QA-CP-8B'}); const m=ctx.api('POST','/members',{name:'QA Member 8',email:'qa.8@library.example',home_branch_id:b.body.id}); ctx.assert(b.status===201&&t.status===201&&c1.status===201&&c2.status===201&&m.status===201,'setup rows created'); ctx.assert(ctx.api('POST','/copies/'+c1.body.id+'/checkout',{member_id:m.body.id}).status===201,'copy 1 lent'); const wrong=ctx.api('POST','/copies/'+c1.body.id+'/withdraw',{}); ctx.assert(wrong.status===409 && wrong.body.error.code==='copy_unavailable','withdraw of a lent copy refused, got '+wrong.status+' '+JSON.stringify(wrong.body)); const ok=ctx.api('POST','/copies/'+c2.body.id+'/withdraw',{}); ctx.assert(ok.status===200 && ok.body.status==='withdrawn','withdraw returned '+ok.status+' '+JSON.stringify(ok.body)); const lend=ctx.api('POST','/copies/'+c2.body.id+'/checkout',{member_id:m.body.id}); ctx.assert(lend.status===409 && lend.body.error.code==='copy_unavailable','withdrawn copy not lent, got '+lend.status); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_branches` | GET | /branches | List branches, first page of 25. |
| `create_branch` | POST | /branches | Create a branch with name, code and city. |
| `list_titles` | GET | /titles | List titles, searchable by title and author, sortable by title. |
| `create_title` | POST | /titles | Create a title. |
| `get_title` | GET | /titles/{id} | Get one title. |
| `list_copies` | GET | /copies | List copies, filterable by status, branch_id and title_id. Main list of the world, with 30 seeded rows. |
| `create_copy` | POST | /copies | Add a copy of a title at a branch. Starts available. |
| `get_copy` | GET | /copies/{id} | Get one copy. |
| `list_members` | GET | /members | List members, filterable by home_branch_id and active, searchable by name and email. |
| `create_member` | POST | /members | Register a member. |
| `get_member` | GET | /members/{id} | Get one member. |
| `list_checkouts` | GET | /checkouts | List loans, filterable by member_id, copy_id and status. |
| `get_checkout` | GET | /checkouts/{id} | Get one loan. |
| `list_holds` | GET | /holds | List holds, filterable by title_id, member_id and status, sortable by queued_at. |
| `get_hold` | GET | /holds/{id} | Get one hold. |
| `list_fines` | GET | /fines | List fines, filterable by member_id and status. |
| `get_fine` | GET | /fines/{id} | Get one fine. |
| `checkout_copy` | POST | /copies/{id}/checkout | Lend a copy to a member. Action: refused when the copy is out, reserved for another member, or the member owes fines. Fulfils the member's ready hold on that copy. |
| `return_copy` | POST | /checkouts/{id}/return | Action: check in an active loan. Serves the earliest waiting hold for the title by making the copy on_hold and that hold ready, or makes the copy available. |
| `withdraw_copy` | POST | /copies/{id}/withdraw | Action: withdraw an available copy from circulation. Refused for any other status. |
| `place_hold` | POST | /titles/{id}/holds | Action: queue a member for a title. Refused when the member already has a waiting or ready hold for that title. |
| `cancel_hold` | POST | /holds/{id}/cancel | Action: cancel a waiting or ready hold. A ready hold frees its copy to available. |
| `pay_fine` | POST | /fines/{id}/pay | Action: settle an open fine in full. |

## Seed

- Rows per entity: branch: 4, title: 20, book_copy: 30, member: 24, checkout: 20, hold: 10, fine: 8
- Mix: Four branches (Harbor, Ridge, Mill, Central). Twenty titles, thirty copies. Twenty-four members with generic names and emails at library.example. Barcodes use the LIB- prefix. Scenario rows the tasks need: title The Overstory has three copies: one available at Harbor (member Maya Chen has no fines), one on_hold for member Lena Park whose ready hold names it, and one out on an active loan to Ben Ortiz. Two members wait on The Overstory in queued order, Sam Ruiz first. Lena Park has one open fine on a returned checkout and no other fine. Ten active checkouts match the ten checked_out copies one to one. Two ready holds match the two on_hold copies. Dates before clock.start for all history; no fine on a copy that is still due.
- State mix: book_copy: available 50%, checked_out 33%, on_hold 7%, withdrawn 10%; checkout: active 50%, returned 50%; hold: waiting 40%, ready 20%, fulfilled 20%, cancelled 20%; fine: open 60%, paid 40%

## Tasks

- `checkout_available_copy` (easy, permissions): Lend the one available copy of The Overstory held at the Harbor branch to member Maya Chen, who has no fines.
  - Actions: `checkout_copy`
  - Decoy idea: checks out the copy that is on hold for Lena Park, which fails or steals her hold
- `return_and_serve_hold` (medium, two_actors): Check in Ben Ortiz's loan of The Overstory so the copy goes to the patron who has waited longest for that title, not the newest.
  - Actions: `return_copy`
  - Decoy idea: checks in the loan but serves the most recent waiting hold instead of the earliest, or cancels the waiting hold
  - Pressure: seeded rows in checkout.active, hold.waiting; distractor rows of hold
- `settle_and_collect_hold` (hard, scarce_resource): Settle Lena Park's open fine, then check out to her the copy of The Overstory that is held for her, not the available copy.
  - Actions: `pay_fine`, `checkout_copy`
  - Decoy idea: checks out the available copy of The Overstory to Lena instead of the held one, so her hold stays ready, or collects before settling the fine
  - Pressure: seeded rows in fine.open, hold.ready, book_copy.on_hold; distractor rows of book_copy

## Open questions

- How long is a loan?
  - Default answer: 14 days from checkout.
- How long does a ready hold wait for collection?
  - Default answer: 3 days, then it expires and the copy becomes available.
- What is the overdue fine rate and currency?
  - Default answer: 25 minor units of USD per full day overdue, one fine per checkout.
- Does an open fine block new loans?
  - Default answer: Yes, until it is paid in full.
- Must a member borrow only from their home branch?
  - Default answer: No, any branch's copy may be lent to any member.
- Should cancelling or expiring a ready hold re-offer the copy to the next waiting member?
  - Default answer: No, the copy becomes available and is offered again only when it is next returned.

## Assumptions

- Clock is explicit: start 2026-10-09T09:00:00.000Z, tick 0s. Time moves only by ctx.advance in tests.
  - Why: Deterministic loan due dates, hold windows and fine accrual need engine time that the agent cannot drift.
- A loan lasts 14 days: due_at is checkout time plus 14 days.
  - Why: A common public library loan period; the request names due dates but no length.
- A ready hold expires 3 days after it becomes ready, and expiry frees its copy to available without re-offering it.
  - Why: The request gives a holds queue but no collection window; the simple rule keeps the job one step.
- Overdue fines accrue 25 minor units (USD 0.25) per full day overdue, one open fine per checkout, updated daily by accrue_overdue_fines.
  - Why: The request names overdue fines but no rate or currency; USD keeps the money field fixed.
- A member with any open fine cannot check out a copy (fines_owed). Paying settles the whole fine.
  - Why: The request says fines are overdue fines; blocking loans is the usual consequence and gives the hard task its precondition.
- Holds are served in queued_at order, ties broken by id. A returned copy goes to the first waiting hold for its title, and only that member may check it out until the hold expires or is cancelled.
  - Why: The request says the holds queue serves members in order.
- Error codes for action refusals are copy_unavailable (409), copy_reserved (409), duplicate_hold (409) and fines_owed (409), named here so tests and tasks can assert them.
  - Why: Action handlers may use only codes the plan names.
- Creates by action answer 201 (checkout_copy, place_hold); other actions answer 200.
  - Why: Engine convention for a new row is 201; actions that change a row answer 200.
- Tests create every row they need with unique QA- barcodes, emails at qa.*@library.example and QA- branch codes, so they never collide with seed rows.
  - Why: Tests run before the seed exists and again after it; seed values must not match test-created values.
- Checkout does not restrict by branch: a member may borrow a copy from any branch.
  - Why: The request names branches but no per-branch lending rule.
- No renewals, lost items, inter-branch transfers, ISBN lookup, notifications or payment processing.
  - Why: The request does not ask for them; they are listed in outOfScope.

## Out of scope

- Renewals of loans
  - Why: The request asks for checkouts and due dates, not extensions.
- Lost or damaged copy states and replacement fees
  - Why: Not in the request; withdrawal covers copies removed from circulation.
- Inter-branch transfers of copies
  - Why: The request names branches but no transfer workflow.
- ISBN, catalogue metadata beyond title and author, and cover images
  - Why: Not part of circulation.
- Notifications when holds become ready
  - Why: Outbound messaging is not a stateful record the agent reads and changes.
- Payment processing and receipts for fines
  - Why: pay_fine records settlement in the world; no external payment flow exists.
- Authentication and staff roles
  - Why: The world serves the public API without auth, as other worlds here do.

## Changes

None. The plan changes no existing item.
