# WorldGen plan: Koha-style public library circulation API

A public library circulation desk: patrons borrow copies of books, return them, renew them, place and fulfil holds on a title, and pay or waive the overdue and lost-item fines that returns and losses create. Copies are items, titles are books, and each loan, hold and fine has its own status workflow.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `patron` | A library cardholder who borrows items and owes fines. | card_number, email |
| `book` | A title in the catalogue. Copies of a title are items. | title |
| `item` | One physical copy of a book, with a barcode, a replacement cost and a circulation status (available, on_loan, lost). | barcode, book_id, status |
| `loan` | A checkout of one item by one patron, with loaned_at, due_at, returned_at, renewals and a status (active, returned, lost). | item_id, patron_id, status, due_at |
| `hold` | A patron's request for the next available copy of a book, with placed_at and a status (waiting, fulfilled, cancelled). | patron_id, book_id, status, placed_at |
| `fine` | A charge on a patron: an overdue fine or a lost-item charge, with an amount in cents and a status (open, paid, waived). | patron_id, loan_id, kind, status |

## Workflows

### loan_circulation (loan)
- States: active, returned, lost
- Actions: checkout_item, return_item, report_lost, renew_loan
- Rules:
  - return_item opens an overdue fine of 25 cents per full day past due, and marks the loan returned Enforced by: return_item. Tested by: t_return_overdue_fine
  - report_lost marks the loan and its item lost and opens a lost_item fine for the item's replacement cost Enforced by: report_lost. Tested by: t_lost_charge
  - renew_loan refuses while another patron holds a waiting hold on the book, and allows one renewal Enforced by: renew_loan. Tested by: t_renew_policy
  - Loans run 14 days from loaned_at, the due date an overdue fine is measured against
  - a loan's item and patron must exist Enforced by the data model: ref fields item_id and patron_id resolve on every write
### copy_status (item)
- States: available, on_loan, lost
- Actions: none
- Rules:
  - an item on loan cannot be checked out again Enforced by: checkout_item. Tested by: t_checkout_unavailable
  - barcode is unique per item Enforced by the data model: unique field item.barcode
### hold_queue (hold)
- States: waiting, fulfilled, cancelled
- Actions: place_hold, cancel_hold, fulfill_hold
- Rules:
  - a patron has at most one waiting hold per book Enforced by: place_hold. Tested by: t_hold_duplicate
  - fulfill_hold moves a waiting hold to fulfilled with a copy of its book that is available, and opens a loan for the hold's patron Enforced by: fulfill_hold. Tested by: t_hold_fulfill
  - cancel_hold moves a waiting hold to cancelled and refuses any other status Enforced by: cancel_hold. Tested by: t_cancel_hold
### fine_settlement (fine)
- States: open, paid, waived
- Actions: pay_fine, waive_fine
- Rules:
  - pay_fine moves an open fine to paid, once Enforced by: pay_fine. Tested by: t_pay_fine
  - waive_fine moves an open fine to waived, once Enforced by: waive_fine. Tested by: t_waive_fine

## Jobs

None. The plan declares no job.

## Acceptance tests

### t_checkout_and_return
- Intent: A checkout puts the copy on loan and a return puts it back on the shelf.
- Actions: checkout_item, return_item
- Description: Create a patron, book and copy, check the copy out, then return it.

```js
(ctx) => { const p = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.a1@example.org', card_number: 'TST-A-0001', category: 'adult' }); ctx.assert(p.status === 201, 'create patron: ' + JSON.stringify(p.body)); const b = ctx.api('POST', '/books', { title: 'Test Book A', author: 'Test Author', isbn: null }); ctx.assert(b.status === 201, 'create book: ' + JSON.stringify(b.body)); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-A-ITEM', replacement_cost: 4500 }); ctx.assert(i.status === 201, 'create item: ' + JSON.stringify(i.body)); const c = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: p.body.id }); ctx.assert(c.status === 201 && c.body.status === 'active', 'checkout: ' + JSON.stringify(c.body)); ctx.assert(typeof c.body.due_at === 'string' && c.body.due_at > c.body.loaned_at, 'due date after loan date'); ctx.assert(ctx.api('GET', '/items/' + i.body.id).body.status === 'on_loan', 'item should be on_loan'); const r = ctx.api('POST', '/items/' + i.body.id + '/return', {}); ctx.assert(r.status === 200 && r.body.status === 'returned', 'return: ' + JSON.stringify(r.body)); ctx.assert(ctx.api('GET', '/items/' + i.body.id).body.status === 'available', 'item should be available'); }
```
### t_checkout_unavailable
- Intent: A copy already on loan cannot be checked out to a second patron.
- Actions: checkout_item
- Description: Check a copy out to one patron, then try to check the same copy out to another; the second answers 409 item.unavailable.

```js
(ctx) => { const p1 = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.b1@example.org', card_number: 'TST-B-0001', category: 'adult' }); const p2 = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Other', email: 'test.reader.b2@example.org', card_number: 'TST-B-0002', category: 'adult' }); ctx.assert(p1.status === 201 && p2.status === 201, 'create patrons'); const b = ctx.api('POST', '/books', { title: 'Test Book B', author: 'Test Author', isbn: null }); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-B-ITEM', replacement_cost: 4500 }); ctx.assert(i.status === 201, 'create item'); const first = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: p1.body.id }); ctx.assert(first.status === 201, 'first checkout'); const second = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: p2.body.id }); ctx.assert(second.status === 409 && second.body.error.code === 'item.unavailable', 'second checkout: ' + JSON.stringify(second.body)); }
```
### t_return_overdue_fine
- Intent: Returning a loan past its due date opens an overdue fine of 25 cents per full day.
- Actions: checkout_item, return_item
- Description: Check a copy out, let 16 days pass, return it, and find one open overdue fine of 50 cents.

```js
(ctx) => { const p = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.c1@example.org', card_number: 'TST-C-0001', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book C', author: 'Test Author', isbn: null }); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-C-ITEM', replacement_cost: 4500 }); ctx.assert(p.status === 201 && i.status === 201, 'create rows'); const c = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: p.body.id }); ctx.assert(c.status === 201, 'checkout'); ctx.advance('16d'); const r = ctx.api('POST', '/items/' + i.body.id + '/return', {}); ctx.assert(r.status === 200, 'return: ' + JSON.stringify(r.body)); const f = ctx.api('GET', '/fines?patron_id=' + p.body.id).body.data; ctx.assert(f.length === 1 && f[0].kind === 'overdue' && f[0].amount === 50 && f[0].status === 'open', 'expected one open overdue fine of 50: ' + JSON.stringify(f)); }
```
### t_lost_charge
- Intent: Reporting a loan lost marks the loan and copy lost and charges the replacement cost.
- Actions: checkout_item, report_lost
- Description: Check a copy out, report the loan lost, and find a lost_item fine for the replacement cost.

```js
(ctx) => { const p = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.d1@example.org', card_number: 'TST-D-0001', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book D', author: 'Test Author', isbn: null }); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-D-ITEM', replacement_cost: 4500 }); ctx.assert(p.status === 201 && i.status === 201, 'create rows'); const c = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: p.body.id }); ctx.assert(c.status === 201, 'checkout'); const r = ctx.api('POST', '/loans/' + c.body.id + '/report_lost', {}); ctx.assert(r.status === 200 && r.body.status === 'lost', 'report lost: ' + JSON.stringify(r.body)); ctx.assert(ctx.api('GET', '/items/' + i.body.id).body.status === 'lost', 'item should be lost'); const f = ctx.api('GET', '/fines?patron_id=' + p.body.id + '&kind=lost_item').body.data; ctx.assert(f.length === 1 && f[0].amount === 4500 && f[0].status === 'open' && f[0].loan_id === c.body.id, 'expected one open lost_item fine of 4500: ' + JSON.stringify(f)); }
```
### t_waive_fine
- Intent: An open fine can be waived once; a waived fine cannot be waived again.
- Actions: checkout_item, report_lost, waive_fine
- Description: Create a lost-item fine, waive it to status waived, then try to waive it again and get 409 fine.not_open.

```js
(ctx) => { const p = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.e1@example.org', card_number: 'TST-E-0001', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book E', author: 'Test Author', isbn: null }); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-E-ITEM', replacement_cost: 4500 }); const c = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: p.body.id }); ctx.assert(c.status === 201, 'checkout'); ctx.api('POST', '/loans/' + c.body.id + '/report_lost', {}); const f = ctx.api('GET', '/fines?patron_id=' + p.body.id).body.data[0]; const w = ctx.api('POST', '/fines/' + f.id + '/waive', {}); ctx.assert(w.status === 200 && w.body.status === 'waived', 'waive: ' + JSON.stringify(w.body)); const again = ctx.api('POST', '/fines/' + f.id + '/waive', {}); ctx.assert(again.status === 409 && again.body.error.code === 'fine.not_open', 'second waive: ' + JSON.stringify(again.body)); }
```
### t_pay_fine
- Intent: An open fine can be paid once; a paid fine cannot be paid again.
- Actions: checkout_item, return_item, pay_fine
- Description: Return a copy one day late to get a 25-cent overdue fine, pay it to status paid, then pay again and get 409 fine.not_open.

```js
(ctx) => { const p = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.f1@example.org', card_number: 'TST-F-0001', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book F', author: 'Test Author', isbn: null }); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-F-ITEM', replacement_cost: 4500 }); const c = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: p.body.id }); ctx.assert(c.status === 201, 'checkout'); ctx.advance('15d'); ctx.api('POST', '/items/' + i.body.id + '/return', {}); const f = ctx.api('GET', '/fines?patron_id=' + p.body.id).body.data[0]; ctx.assert(f && f.amount === 25, 'expected a 25 cent fine: ' + JSON.stringify(f)); const pay = ctx.api('POST', '/fines/' + f.id + '/pay', {}); ctx.assert(pay.status === 200 && pay.body.status === 'paid', 'pay: ' + JSON.stringify(pay.body)); const again = ctx.api('POST', '/fines/' + f.id + '/pay', {}); ctx.assert(again.status === 409 && again.body.error.code === 'fine.not_open', 'second pay: ' + JSON.stringify(again.body)); }
```
### t_hold_duplicate
- Intent: A patron cannot hold the same book twice while the first hold is waiting.
- Actions: place_hold
- Description: Place a hold, then place a second hold on the same book for the same patron; the second answers 409 hold.duplicate.

```js
(ctx) => { const p = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.g1@example.org', card_number: 'TST-G-0001', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book G', author: 'Test Author', isbn: null }); ctx.assert(p.status === 201 && b.status === 201, 'create rows'); const h = ctx.api('POST', '/holds', { patron_id: p.body.id, book_id: b.body.id }); ctx.assert(h.status === 201 && h.body.status === 'waiting', 'place hold: ' + JSON.stringify(h.body)); const dup = ctx.api('POST', '/holds', { patron_id: p.body.id, book_id: b.body.id }); ctx.assert(dup.status === 409 && dup.body.error.code === 'hold.duplicate', 'duplicate hold: ' + JSON.stringify(dup.body)); }
```
### t_hold_fulfill
- Intent: A returned copy goes to the waiting hold of another patron, which becomes fulfilled and opens a loan for that patron.
- Actions: checkout_item, place_hold, return_item, fulfill_hold
- Description: Patron A borrows a copy; patron B places a hold on the title; A returns the copy; fulfil B's hold with that copy and check B now has an active loan of it.

```js
(ctx) => { const a = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.h1@example.org', card_number: 'TST-H-0001', category: 'adult' }); const bp = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Waiter', email: 'test.reader.h2@example.org', card_number: 'TST-H-0002', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book H', author: 'Test Author', isbn: null }); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-H-ITEM', replacement_cost: 4500 }); ctx.assert(a.status === 201 && bp.status === 201 && i.status === 201, 'create rows'); const c = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: a.body.id }); ctx.assert(c.status === 201, 'checkout'); const h = ctx.api('POST', '/holds', { patron_id: bp.body.id, book_id: b.body.id }); ctx.assert(h.status === 201, 'hold'); ctx.assert(ctx.api('POST', '/items/' + i.body.id + '/return', {}).status === 200, 'return'); const f = ctx.api('POST', '/holds/' + h.body.id + '/fulfill', { item_id: i.body.id }); ctx.assert(f.status === 200 && f.body.status === 'fulfilled', 'fulfill: ' + JSON.stringify(f.body)); const loans = ctx.api('GET', '/loans?patron_id=' + bp.body.id).body.data; ctx.assert(loans.length === 1 && loans[0].item_id === i.body.id && loans[0].status === 'active', 'expected an active loan for the waiter: ' + JSON.stringify(loans)); ctx.assert(ctx.api('GET', '/items/' + i.body.id).body.status === 'on_loan', 'item should be on_loan'); }
```
### t_renew_policy
- Intent: A loan cannot be renewed while another patron waits for the book, and renews once.
- Actions: checkout_item, place_hold, cancel_hold, renew_loan
- Description: With a waiting hold by another patron the renewal answers 409 loan.renewal_blocked; after the hold is cancelled the renewal moves due_at later; a second renewal answers 409 loan.renew_limit.

```js
(ctx) => { const a = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.i1@example.org', card_number: 'TST-I-0001', category: 'adult' }); const bp = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Waiter', email: 'test.reader.i2@example.org', card_number: 'TST-I-0002', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book I', author: 'Test Author', isbn: null }); const i = ctx.api('POST', '/items', { book_id: b.body.id, barcode: 'TST-I-ITEM', replacement_cost: 4500 }); const c = ctx.api('POST', '/checkouts', { item_id: i.body.id, patron_id: a.body.id }); ctx.assert(c.status === 201, 'checkout'); const h = ctx.api('POST', '/holds', { patron_id: bp.body.id, book_id: b.body.id }); ctx.assert(h.status === 201, 'hold'); const blocked = ctx.api('POST', '/loans/' + c.body.id + '/renew', {}); ctx.assert(blocked.status === 409 && blocked.body.error.code === 'loan.renewal_blocked', 'renew while held: ' + JSON.stringify(blocked.body)); ctx.assert(ctx.api('POST', '/holds/' + h.body.id + '/cancel', {}).status === 200, 'cancel hold'); const ok = ctx.api('POST', '/loans/' + c.body.id + '/renew', {}); ctx.assert(ok.status === 200 && ok.body.due_at > c.body.due_at, 'renew: ' + JSON.stringify(ok.body)); const again = ctx.api('POST', '/loans/' + c.body.id + '/renew', {}); ctx.assert(again.status === 409 && again.body.error.code === 'loan.renew_limit', 'second renew: ' + JSON.stringify(again.body)); }
```
### t_cancel_hold
- Intent: A waiting hold can be cancelled once; a cancelled hold cannot be cancelled again.
- Actions: place_hold, cancel_hold
- Description: Place a hold, cancel it to status cancelled, then cancel again and get 409 hold.not_waiting.

```js
(ctx) => { const p = ctx.api('POST', '/patrons', { first_name: 'Test', last_name: 'Reader', email: 'test.reader.j1@example.org', card_number: 'TST-J-0001', category: 'adult' }); const b = ctx.api('POST', '/books', { title: 'Test Book J', author: 'Test Author', isbn: null }); const h = ctx.api('POST', '/holds', { patron_id: p.body.id, book_id: b.body.id }); ctx.assert(h.status === 201, 'place hold'); const c = ctx.api('POST', '/holds/' + h.body.id + '/cancel', {}); ctx.assert(c.status === 200 && c.body.status === 'cancelled', 'cancel: ' + JSON.stringify(c.body)); const again = ctx.api('POST', '/holds/' + h.body.id + '/cancel', {}); ctx.assert(again.status === 409 && again.body.error.code === 'hold.not_waiting', 'second cancel: ' + JSON.stringify(again.body)); }
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_patrons` | GET | /patrons | Find a patron by card number or email. |
| `get_patron` | GET | /patrons/{id} | Read one patron. |
| `create_patron` | POST | /patrons | Register a patron. |
| `list_books` | GET | /books | Search the catalogue by title. |
| `get_book` | GET | /books/{id} | Read one book. |
| `create_book` | POST | /books | Add a title to the catalogue. |
| `list_items` | GET | /items | List the copies of a book, filtered by status. |
| `get_item` | GET | /items/{id} | Read one copy and its circulation status. |
| `create_item` | POST | /items | Add a copy of a book. |
| `list_loans` | GET | /loans | List loans by patron, item, book or status, soonest due first. |
| `get_loan` | GET | /loans/{id} | Read one loan. |
| `list_holds` | GET | /holds | List holds by patron, book or status. |
| `get_hold` | GET | /holds/{id} | Read one hold. |
| `list_fines` | GET | /fines | List fines by patron, kind or status. |
| `get_fine` | GET | /fines/{id} | Read one fine. |

## Seed

- Rows per entity: patron: 28, book: 8, item: 40, loan: 30, hold: 10, fine: 12
- Mix: Patrons just over one 25-row page. Items spread over the books, with lost copies and on-loan copies. Loans: active ones, some already past due, returned ones and a few lost ones, spread over patrons so one patron has several loans. Holds: waiting holds on titles whose copies are out, fulfilled and cancelled ones. Fines: open overdue fines, paid and waived ones and a few open lost-item charges. Seeded history is dated before the clock start. Plausible titles, names and emails, never lorem ipsum.
- State mix: item: available 50%, on_loan 40%, lost 10%; loan: active 50%, returned 40%, lost 10%; hold: waiting 50%, fulfilled 30%, cancelled 20%; fine: open 50%, paid 33%, waived 17%

## Tasks

- `pay_patron_open_fine` (easy): Pay the one open fine on a named patron's account.
  - Actions: `pay_fine`
  - Decoy idea: Waives the fine instead of paying it, which leaves the status wrong.
  - Pressure: seeded rows in fine.open
- `renew_only_unheld_loans` (medium, policy_conflict): Renew each active loan of a named patron that the library allows to renew, and leave the rest unchanged.
  - Actions: `renew_loan`
  - Decoy idea: Renews every active loan, including the one whose book another patron is waiting for.
  - Pressure: seeded rows in loan.active, hold.waiting; distractor rows of loan
- `fulfil_earliest_hold` (medium, scarce_resource): A returned copy of a title goes to the hold placed first for that title, and that hold is fulfilled with it.
  - Actions: `fulfill_hold`
  - Decoy idea: Fulfils the most recently placed hold, which is the newest row on the first page.
  - Pressure: seeded rows in hold.waiting; distractor rows of hold
- `waive_lost_charge_of_returned_title` (hard, investigation): Find the loan of a named title that a named patron still holds, report it lost, and waive the lost-item charge it creates.
  - Actions: `report_lost`, `waive_fine`
  - Decoy idea: Reports the first loan the patron has, or a loan of the same title held by another patron, or a loan already returned.
  - Pressure: seeded rows in loan.active, loan.returned; distractor rows of loan

## Open questions

- How long is a loan period?
  - Default answer: 14 days from checkout, and a renewal adds 14 days to due_at.
- What is the overdue fine rate, and is it capped?
  - Default answer: 25 cents per full day past due, with no cap.
- Can a patron with open fines still borrow or place holds?
  - Default answer: Yes; no block is named in the request.
- Can a fine be paid or waived in part?
  - Default answer: No; each fine is paid or waived whole, once.
- How many times can a loan be renewed, and is a renewal blocked by holds?
  - Default answer: Once, and not while another patron has a waiting hold on the book.
- How are copies allocated to holds?
  - Default answer: Earliest placed hold first, fulfilled by an available copy of the same book.

## Assumptions

- Loans run 14 days from loaned_at, and checkout sets due_at to 14 days after now.
  - Why: The request names due dates but not a loan period, and 14 days is the common public-library default.
- Overdue fine is 25 cents per full day past due, charged on return as an open overdue fine. No cap.
  - Why: The request names overdue fines without a rate, so a flat daily rate in cents is the smallest deterministic rule.
- A loan can be renewed once, for another 14 days from its current due_at. Renewal is refused while another patron has a waiting hold on the book.
  - Why: The request names renewals only implicitly; one renewal and a hold block are the usual library policy and make a policy conflict testable.
- report_lost sets the loan to lost and the item to lost and opens a lost_item fine for the item replacement_cost in cents.
  - Why: The request names lost-item charges without an amount; the item's replacement cost is the natural source.
- A hold is fulfilled by fulfill_hold with a copy of the same book that is available, and the hold's patron gets a new active loan. Holds are served in placed_at order.
  - Why: The request names holds but not how copies are allocated; first-placed-first-served matches the scarce resource.
- pay_fine and waive_fine act on a whole fine and cannot be partly applied.
  - Why: No partial payment is named, so each fine moves once from open to paid or waived.
- Patrons with open fines may still borrow.
  - Why: No borrowing block is named in the request; keeping it out avoids inventing a policy.
- clock.start is 2026-10-09T09:00:00.000Z with tick 0s, so time moves only by explicit advances; seeded loans, holds and fines are dated before it.
  - Why: Deterministic time after imported history, as the clock rule requires; overdue status depends on the clock, so explicit time keeps it testable.
- Each item is one copy of one book; barcode is unique.
  - Why: A copy-level barcode is how libraries identify items; uniqueness is a data-model rule.

## Out of scope

- Reservations for pickup at a branch, shelf locations and transit between branches
  - Why: The request is about loans, holds, due dates and fines, not branch logistics.
- Notices, reminders and email to patrons
  - Why: Messaging is not stateful records an agent changes through the API.
- Membership renewal, patron categories and fee schedules per category
  - Why: The request names no membership rules.
- Partial fine payments, payment methods and receipts
  - Why: The request names no payment handling.
- Recalling a loan early and blocking patrons with fines
  - Why: No such policy is named; both would invent behaviour.

## Changes

None. The plan changes no existing item.
