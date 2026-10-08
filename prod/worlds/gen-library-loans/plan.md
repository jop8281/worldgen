# WorldGen plan: Koha/Evergreen-style public library circulation desk (catalog, patrons, loans, renewals, overdue fines)

A library circulation system built from the books and loans CSVs. Staff look up books and members, check books out, renew them, return them and collect overdue fines. A job marks late loans overdue and accrues fines. Checkout rules cover copy availability, a loan limit, unpaid fines and member suspension.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-07T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `book` | A catalog title held at one branch, with the number of physical copies. Imported from the books CSV. Availability is copies minus open loans, so it is not stored. | isbn, title, author, genre, branch, copies |
| `member` | A library patron. The CSV has only member codes (M0005 style), so the seed derives one member per distinct loan member_id and adds names. A member is active or suspended. | code, name, email, status |
| `loan` | One copy of a book borrowed by a member. Imported from the loans CSV. It runs from borrowed_at to due_at, and returned_at is set when the book comes back. It carries the fine and whether the fine was paid. | loan_ref, book_id, member_id, borrowed_at, due_at, returned_at, status, renewals, fine_cents, fine_paid |

## Workflows

### loan_lifecycle (loan)
- States: active, overdue, returned
- Actions: checkout_book, return_loan, renew_loan, pay_fine
- Rules:
  - Loans are created only by checkout_book. There is no generic create or update route for loans.
  - checkout_book takes book_id and member_id. Refused with 409 member_suspended if the member is suspended. Refused with 409 loan_limit if the member already has 5 open loans (active or overdue). Refused with 409 unpaid_fines if the member's unpaid fines are 1000 cents or more. Refused with 409 no_copies_available if the book's open loans already equal its copies. An unknown book or member is a 4xx input error.
  - A new loan is active. borrowed_at is the engine time, due_at is borrowed_at plus 21 days, renewals is 0, fine_cents is 0 and fine_paid is false. loan_ref is L plus a 5-digit sequence continuing after the CSV (L00301 first).
  - Unpaid fines for a member are the sum of fine_cents over their loans that are returned or overdue and have fine_paid false.
  - return_loan accepts an active or overdue loan. It sets returned_at to the engine time and the status to returned. The fine is 25 cents per full 24 hours past due_at, capped at 2000, and 0 if returned on time. Returning an already returned loan is 409 invalid_state.
  - renew_loan accepts only an active loan whose member is active. It adds 14 days to due_at and increments renewals. A third renewal is 409 renewal_limit. An overdue loan is 409 loan_overdue. A returned loan is 409 invalid_state. A suspended member is 409 member_suspended.
  - pay_fine accepts a returned loan with fine_cents > 0 and fine_paid false. It sets fine_paid true. Anything else is 409 no_fine_due. Fines on an overdue (unreturned) loan cannot be paid before the book is returned.
  - The accrue_overdue job moves active loans past due_at to overdue and keeps fine_cents at 25 cents per full day overdue (capped at 2000) for every overdue loan.
### member_standing (member)
- States: active, suspended
- Actions: none
- Rules:
  - A new member is active. Staff move a member between active and suspended with a plain PATCH.
  - A suspended member cannot check out or renew, but can still return books and pay fines.
  - Members are never deleted.

## Jobs

- `accrue_overdue` runs every 1h: For every active loan with due_at before now, set the status to overdue. For every overdue loan, set fine_cents to 25 times the number of full 24-hour periods past due_at, capped at 2000. Returned loans are never touched.

## Acceptance tests

### checkout_creates_active_loan
- Intent: Checking out a book creates an active loan with a 21-day due date and records the borrower and the book.
- Actions: checkout_book
- Description: Create a book and a member through the API, check the book out, and verify status, borrowed_at, due_at, renewals, fine fields, and that the loan appears in the member's loan list. An unknown book is refused.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const b = ctx.api('POST', '/books', { isbn: '9790000000011', title: 'Acceptance Atlas of Rivers', author: 'T. Writer', genre: 'travel', branch: 'central', copies: 2 });
  ctx.assert(ok(b), 'create book: ' + JSON.stringify(b));
  const m = ctx.api('POST', '/members', { code: 'ACC-M01', name: 'Acceptance Member One' });
  ctx.assert(ok(m) && m.body.status === 'active', 'create member active: ' + JSON.stringify(m));
  const start = ctx.now();
  const r = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
  ctx.assert(ok(r), 'checkout: ' + JSON.stringify(r));
  ctx.assert(r.body.status === 'active' && r.body.book_id === b.body.id && r.body.member_id === m.body.id, 'active loan for the book and member: ' + JSON.stringify(r.body));
  ctx.assert(r.body.borrowed_at === start, 'borrowed_at is now ' + start + ', got ' + r.body.borrowed_at);
  ctx.assert(r.body.due_at === '2026-10-28T09:00:00.000Z', 'due 21 days later, got ' + r.body.due_at);
  ctx.assert(r.body.returned_at === null && r.body.renewals === 0 && r.body.fine_cents === 0 && r.body.fine_paid === false, 'fresh loan fields: ' + JSON.stringify(r.body));
  const list = ctx.api('GET', '/members/' + m.body.id + '/loans');
  ctx.assert(list.status === 200 && list.body.data.length === 1 && list.body.data[0].id === r.body.id, 'member loan list: ' + JSON.stringify(list.body));
  const bad = ctx.api('POST', '/loans/checkout', { book_id: 'book_9999', member_id: m.body.id });
  ctx.assert(bad.status >= 400 && bad.status < 500, 'unknown book refused, got ' + bad.status);
}
```
### checkout_respects_copies
- Intent: A book cannot be checked out beyond its copy count, and a return frees the copy.
- Actions: checkout_book, return_loan
- Description: A one-copy book goes to member A. Member B is refused with no_copies_available. After A returns it, B can borrow it.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const b = ctx.api('POST', '/books', { isbn: '9790000000012', title: 'Acceptance Single Copy', author: 'T. Writer', genre: 'fiction', branch: 'northgate', copies: 1 });
  const a = ctx.api('POST', '/members', { code: 'ACC-M02A', name: 'Acceptance Member A' });
  const c = ctx.api('POST', '/members', { code: 'ACC-M02B', name: 'Acceptance Member B' });
  ctx.assert(ok(b) && ok(a) && ok(c), 'setup failed');
  const first = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: a.body.id });
  ctx.assert(ok(first), 'first checkout: ' + JSON.stringify(first));
  const second = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: c.body.id });
  ctx.assert(second.status === 409 && second.body.error.code === 'no_copies_available', 'second checkout refused: ' + JSON.stringify(second));
  const ret = ctx.api('POST', '/loans/' + first.body.id + '/return', {});
  ctx.assert(ok(ret) && ret.body.status === 'returned', 'return: ' + JSON.stringify(ret));
  const third = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: c.body.id });
  ctx.assert(ok(third), 'checkout after return: ' + JSON.stringify(third));
  const loans = ctx.api('GET', '/loans?book_id=' + b.body.id);
  ctx.assert(loans.status === 200 && loans.body.data.length === 2, 'two loans on the book, got ' + JSON.stringify(loans.body));
}
```
### return_on_time_no_fine
- Intent: Returning a loan on time sets returned_at and no fine, and a second return is refused.
- Actions: checkout_book, return_loan, pay_fine
- Description: Check out and return immediately. The status is returned, returned_at is the call time, and the fine is 0. A repeat return is 409 invalid_state, and paying a zero fine is 409 no_fine_due.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const b = ctx.api('POST', '/books', { isbn: '9790000000013', title: 'Acceptance On Time', author: 'T. Writer', genre: 'science', branch: 'eastfield', copies: 1 });
  const m = ctx.api('POST', '/members', { code: 'ACC-M03', name: 'Acceptance Member Three' });
  const l = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
  ctx.assert(ok(l), 'checkout: ' + JSON.stringify(l));
  const at = ctx.now();
  const r = ctx.api('POST', '/loans/' + l.body.id + '/return', {});
  ctx.assert(ok(r), 'return: ' + JSON.stringify(r));
  ctx.assert(r.body.status === 'returned' && r.body.returned_at === at && r.body.fine_cents === 0, 'returned without fine: ' + JSON.stringify(r.body));
  const again = ctx.api('POST', '/loans/' + l.body.id + '/return', {});
  ctx.assert(again.status === 409 && again.body.error.code === 'invalid_state', 'second return: ' + JSON.stringify(again));
  const pay = ctx.api('POST', '/loans/' + l.body.id + '/pay_fine', {});
  ctx.assert(pay.status === 409 && pay.body.error.code === 'no_fine_due', 'pay zero fine: ' + JSON.stringify(pay));
  const missing = ctx.api('POST', '/loans/loan_9999/return', {});
  ctx.assert(missing.status === 404, 'missing loan 404, got ' + missing.status);
}
```
### renewals_extend_due_date
- Intent: A loan can be renewed twice for 14 days each, then renewals are refused.
- Actions: checkout_book, renew_loan, return_loan
- Description: Check out, renew twice and verify due_at and the renewals count, then verify the third renewal is refused with renewal_limit. A returned loan cannot be renewed.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const b = ctx.api('POST', '/books', { isbn: '9790000000014', title: 'Acceptance Renewals', author: 'T. Writer', genre: 'history', branch: 'riverside', copies: 1 });
  const m = ctx.api('POST', '/members', { code: 'ACC-M04', name: 'Acceptance Member Four' });
  const l = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
  ctx.assert(ok(l) && l.body.due_at === '2026-10-28T09:00:00.000Z', 'checkout: ' + JSON.stringify(l));
  const r1 = ctx.api('POST', '/loans/' + l.body.id + '/renew', {});
  ctx.assert(ok(r1) && r1.body.renewals === 1 && r1.body.due_at === '2026-11-11T09:00:00.000Z', 'first renewal: ' + JSON.stringify(r1));
  const r2 = ctx.api('POST', '/loans/' + l.body.id + '/renew', {});
  ctx.assert(ok(r2) && r2.body.renewals === 2 && r2.body.due_at === '2026-11-25T09:00:00.000Z', 'second renewal: ' + JSON.stringify(r2));
  const r3 = ctx.api('POST', '/loans/' + l.body.id + '/renew', {});
  ctx.assert(r3.status === 409 && r3.body.error.code === 'renewal_limit', 'third renewal: ' + JSON.stringify(r3));
  const after = ctx.api('GET', '/loans/' + l.body.id).body;
  ctx.assert(after.renewals === 2 && after.due_at === '2026-11-25T09:00:00.000Z', 'refused renewal changed nothing: ' + JSON.stringify(after));
  ctx.assert(ok(ctx.api('POST', '/loans/' + l.body.id + '/return', {})), 'return');
  const late = ctx.api('POST', '/loans/' + l.body.id + '/renew', {});
  ctx.assert(late.status === 409 && late.body.error.code === 'invalid_state', 'renew returned loan: ' + JSON.stringify(late));
}
```
### overdue_job_and_fine_payment
- Intent: Late loans become overdue, accrue 25 cents per full day, cannot be renewed, and the fine is fixed on return and can be paid once.
- Actions: checkout_book, renew_loan, return_loan, pay_fine
- Description: Check out, advance 24 days 12 hours (3 full days past the due date), verify overdue with a 75 cent fine, refuse renewal, return, verify the fine stays 75 and is unpaid, pay it, and refuse a second payment.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const b = ctx.api('POST', '/books', { isbn: '9790000000015', title: 'Acceptance Overdue', author: 'T. Writer', genre: 'mystery', branch: 'central', copies: 1 });
  const m = ctx.api('POST', '/members', { code: 'ACC-M05', name: 'Acceptance Member Five' });
  const l = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
  ctx.assert(ok(l), 'checkout: ' + JSON.stringify(l));
  const adv = ctx.advance('24d12h');
  ctx.assert(adv.jobsFailed.length === 0, 'jobs failed: ' + JSON.stringify(adv.jobsFailed));
  const mid = ctx.api('GET', '/loans/' + l.body.id).body;
  ctx.assert(mid.status === 'overdue' && mid.fine_cents === 75 && mid.returned_at === null, 'overdue with 75 cents: ' + JSON.stringify(mid));
  const renew = ctx.api('POST', '/loans/' + l.body.id + '/renew', {});
  ctx.assert(renew.status === 409 && renew.body.error.code === 'loan_overdue', 'renew overdue: ' + JSON.stringify(renew));
  const early = ctx.api('POST', '/loans/' + l.body.id + '/pay_fine', {});
  ctx.assert(early.status === 409 && early.body.error.code === 'no_fine_due', 'pay before return: ' + JSON.stringify(early));
  const ret = ctx.api('POST', '/loans/' + l.body.id + '/return', {});
  ctx.assert(ok(ret) && ret.body.status === 'returned' && ret.body.fine_cents === 75 && ret.body.fine_paid === false, 'return with fine: ' + JSON.stringify(ret));
  const overdueList = ctx.api('GET', '/loans?status=overdue&member_id=' + m.body.id);
  ctx.assert(overdueList.status === 200 && overdueList.body.data.length === 0, 'no overdue loans remain');
  const pay = ctx.api('POST', '/loans/' + l.body.id + '/pay_fine', {});
  ctx.assert(ok(pay) && pay.body.fine_paid === true && pay.body.fine_cents === 75, 'pay fine: ' + JSON.stringify(pay));
  const twice = ctx.api('POST', '/loans/' + l.body.id + '/pay_fine', {});
  ctx.assert(twice.status === 409 && twice.body.error.code === 'no_fine_due', 'pay twice: ' + JSON.stringify(twice));
}
```
### unpaid_fines_block_checkout
- Intent: A member with 1000 cents or more of unpaid fines cannot borrow until they pay.
- Actions: checkout_book, return_loan, pay_fine
- Description: Check out a book, advance 61 days 12 hours (40 full days overdue, 1000 cents), return it, verify a new checkout is refused with unpaid_fines, pay the fine, and verify the checkout now works.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const b1 = ctx.api('POST', '/books', { isbn: '9790000000016', title: 'Acceptance Fines One', author: 'T. Writer', genre: 'fantasy', branch: 'northgate', copies: 1 });
  const b2 = ctx.api('POST', '/books', { isbn: '9790000000017', title: 'Acceptance Fines Two', author: 'T. Writer', genre: 'poetry', branch: 'northgate', copies: 1 });
  const m = ctx.api('POST', '/members', { code: 'ACC-M06', name: 'Acceptance Member Six' });
  const l = ctx.api('POST', '/loans/checkout', { book_id: b1.body.id, member_id: m.body.id });
  ctx.assert(ok(l), 'checkout: ' + JSON.stringify(l));
  ctx.advance('61d12h');
  const ret = ctx.api('POST', '/loans/' + l.body.id + '/return', {});
  ctx.assert(ok(ret) && ret.body.fine_cents === 1000, 'fine of 1000 cents: ' + JSON.stringify(ret));
  const blocked = ctx.api('POST', '/loans/checkout', { book_id: b2.body.id, member_id: m.body.id });
  ctx.assert(blocked.status === 409 && blocked.body.error.code === 'unpaid_fines', 'blocked by fines: ' + JSON.stringify(blocked));
  ctx.assert(ok(ctx.api('POST', '/loans/' + l.body.id + '/pay_fine', {})), 'pay fine');
  const allowed = ctx.api('POST', '/loans/checkout', { book_id: b2.body.id, member_id: m.body.id });
  ctx.assert(ok(allowed), 'checkout after paying: ' + JSON.stringify(allowed));
}
```
### member_limits_and_suspension
- Intent: Checkout and renewal are refused for suspended members, and a member cannot hold more than 5 open loans.
- Actions: checkout_book, renew_loan, return_loan
- Description: A member borrows 5 copies of a 6-copy book. The sixth is refused with loan_limit. After suspending the member through PATCH, checkout and renewal are refused with member_suspended, and returning still works.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const b = ctx.api('POST', '/books', { isbn: '9790000000018', title: 'Acceptance Many Copies', author: 'T. Writer', genre: 'children', branch: 'eastfield', copies: 6 });
  const m = ctx.api('POST', '/members', { code: 'ACC-M07', name: 'Acceptance Member Seven' });
  ctx.assert(ok(b) && ok(m), 'setup failed');
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
    ctx.assert(ok(r), 'checkout ' + i + ': ' + JSON.stringify(r));
    ids.push(r.body.id);
  }
  const sixth = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
  ctx.assert(sixth.status === 409 && sixth.body.error.code === 'loan_limit', 'sixth checkout: ' + JSON.stringify(sixth));
  const sus = ctx.api('PATCH', '/members/' + m.body.id, { status: 'suspended' });
  ctx.assert(ok(sus) && sus.body.status === 'suspended', 'suspend: ' + JSON.stringify(sus));
  const renew = ctx.api('POST', '/loans/' + ids[0] + '/renew', {});
  ctx.assert(renew.status === 409 && renew.body.error.code === 'member_suspended', 'renew suspended: ' + JSON.stringify(renew));
  const ret = ctx.api('POST', '/loans/' + ids[0] + '/return', {});
  ctx.assert(ok(ret) && ret.body.status === 'returned', 'suspended member can still return: ' + JSON.stringify(ret));
  const co = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
  ctx.assert(co.status === 409 && co.body.error.code === 'member_suspended', 'checkout suspended: ' + JSON.stringify(co));
}
```
### catalog_filters_and_search
- Intent: Books can be created, filtered by genre and branch, searched by title and author, and edited. A book with zero copies cannot be borrowed.
- Actions: checkout_book
- Description: Create two books with distinctive titles and verify the genre and branch filters, text search, a PATCH of the copy count, a refused duplicate ISBN, and a refused checkout once copies is patched to 0.

```js
(ctx) => {
  const ok = (r) => r.status >= 200 && r.status < 300;
  const a = ctx.api('POST', '/books', { isbn: '9790000000019', title: 'Zyxwv Quantum Gardens', author: 'Quillon Ferrante', genre: 'poetry', branch: 'riverside', copies: 3 });
  const b = ctx.api('POST', '/books', { isbn: '9790000000020', title: 'Zyxwv Ocean Letters', author: 'Marta Vosk', genre: 'travel', branch: 'central', copies: 1 });
  ctx.assert(ok(a) && ok(b), 'create books');
  const byTitle = ctx.api('GET', '/books?q=Zyxwv');
  ctx.assert(byTitle.status === 200 && byTitle.body.data.length === 2, 'title search finds both: ' + JSON.stringify(byTitle.body));
  const byAuthor = ctx.api('GET', '/books?q=Ferrante');
  ctx.assert(byAuthor.body.data.length === 1 && byAuthor.body.data[0].id === a.body.id, 'author search: ' + JSON.stringify(byAuthor.body));
  const byGenre = ctx.api('GET', '/books?q=Zyxwv&genre=travel');
  ctx.assert(byGenre.body.data.length === 1 && byGenre.body.data[0].id === b.body.id, 'genre filter: ' + JSON.stringify(byGenre.body));
  const byBranch = ctx.api('GET', '/books?q=Zyxwv&branch=riverside');
  ctx.assert(byBranch.body.data.length === 1 && byBranch.body.data[0].id === a.body.id, 'branch filter: ' + JSON.stringify(byBranch.body));
  const up = ctx.api('PATCH', '/books/' + a.body.id, { copies: 5 });
  ctx.assert(ok(up) && up.body.copies === 5, 'patch copies: ' + JSON.stringify(up));
  const dup = ctx.api('POST', '/books', { isbn: '9790000000019', title: 'Duplicate ISBN', author: 'X', genre: 'poetry', branch: 'central', copies: 1 });
  ctx.assert(dup.status >= 400 && dup.status < 500, 'duplicate isbn refused, got ' + dup.status);
  const m = ctx.api('POST', '/members', { code: 'ACC-M08', name: 'Acceptance Member Eight' });
  ctx.assert(ok(m), 'create member');
  ctx.assert(ok(ctx.api('PATCH', '/books/' + b.body.id, { copies: 0 })), 'patch copies to 0');
  const none = ctx.api('POST', '/loans/checkout', { book_id: b.body.id, member_id: m.body.id });
  ctx.assert(none.status === 409 && none.body.error.code === 'no_copies_available', 'zero copies: ' + JSON.stringify(none));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_books` | GET | /books | List books. Filters: genre, branch. Search: title, author. Sort: title, author. Page size 25. |
| `get_book` | GET | /books/{id} | Fetch one book. |
| `create_book` | POST | /books | Add a catalog title. |
| `update_book` | PATCH | /books/{id} | Edit book details, such as the copy count or branch. |
| `list_members` | GET | /members | List members. Filter: status. Search: name, code. Sort: name. |
| `get_member` | GET | /members/{id} | Fetch one member. |
| `create_member` | POST | /members | Register a member. The status starts as active. |
| `update_member` | PATCH | /members/{id} | Edit a member, including active to suspended and back. |
| `list_loans` | GET | /loans | List loans. Filters: status, member_id, book_id, fine_paid. Sort: due_at, borrowed_at. Page size 25. |
| `get_loan` | GET | /loans/{id} | Fetch one loan. |
| `list_member_loans` | GET | /members/{member_id}/loans | List one member's loans. |
| `list_book_loans` | GET | /books/{book_id}/loans | List the loans of one book. |
| `checkout_book` | POST | /loans/checkout | Built as the checkout_book action. |
| `return_loan` | POST | /loans/{id}/return | Built as the return_loan action. |
| `renew_loan` | POST | /loans/{id}/renew | Built as the renew_loan action. |
| `pay_fine` | POST | /loans/{id}/pay_fine | Built as the pay_fine action. |

## Seed

- Rows per entity: book: 200, member: 107, loan: 300
- Mix: Books: all 200 CSV rows, with the 10 genres and 4 branches as in the file. Members: one per distinct member_id in the loans CSV (107), with generated plausible names and emails. About 10 are suspended and the rest active. Loans: all 300 CSV rows with isbn mapped to book_id and member_id to the member row. loan_ref is the CSV loan_id. Rows with returned_at set (about 77%) are returned. The unreturned rows (about 23%) are overdue if due_at is before clock.start and active otherwise, since due dates run to 2026-10-19. fine_cents comes from the CSV, and fine_paid is a mix of paid and unpaid on returned loans with a fine. Renewals are 0 to 2. The returned share may exceed 70%, because the CSV fixes it. A few anchor loans give the tasks one unambiguous target each.

## Tasks

- `return_longest_overdue_loan` (easy): The library reports that the book on the unreturned loan with the earliest due date was handed back. Find that loan (unreturned, earliest due_at) and record its return. Nothing else may change, and the fine is whatever the return computes. The seed makes the earliest due_at unique.
  - Decoy idea: Returns the unreturned loan with the latest due date, or the first unreturned loan in id order, or edits the loan with PATCH-style calls instead of using the return action.
- `collect_top_fines_member` (medium): Find the member with the largest total of unpaid fines on returned loans and pay every unpaid fine on their returned loans. Do not pay any other member's fines and do not touch their overdue loans. The seed makes the top member unique and spreads their fines over several loans, with fine_paid already true on some rows.
  - Decoy idea: Pays only the single largest fine, pays fines of the member with the most loans instead of the largest unpaid total, or pays every unpaid fine in the library.
- `clear_riverside_overdue` (hard): Every loan that is overdue (unreturned and past its due date) for a book held at the riverside branch should be returned, and every fine created by those returns should then be paid. Overdue loans at other branches, and active loans, stay untouched. Overdue loans span more than one page of results, so the agent must page and join loans to books by branch.
  - Decoy idea: Reads only the first page of overdue loans, returns overdue loans at all branches, returns the loans but never pays the fines, or filters on book genre or member status instead of branch.

## Open questions

- Should members be separate records, given the CSV only has member_id strings on loans?
  - Default answer: Yes. One member row per distinct loan member_id, with the CSV code kept in member.code and generated names.
- What are the loan period, renewal rules and loan limit?
  - Default answer: 21 days, 14 days per renewal, at most 2 renewals, and 5 open loans per member.
- How are overdue fines calculated?
  - Default answer: 25 cents per full 24 hours past due, capped at 2000 cents. Fines are charged when the book is returned and accrue on the loan while it is overdue.
- What happens when a member has unpaid fines?
  - Default answer: At 1000 cents or more, checkout is refused until the fines are paid. Returns and fine payments always work.
- Should a loan's unreturned state be stored, or computed from dates?
  - Default answer: Stored as a state (active, overdue, returned). A job moves active loans to overdue once due_at has passed.
- Can book copies be over-committed by the existing data?
  - Default answer: The seed keeps the CSV loans as given. Where open loans already reach the copy count, new checkouts are refused.
- What is the clock start, and does time tick on every call?
  - Default answer: 2026-10-07T09:00:00Z, with tick 0s. Time moves only through an explicit advance.

## Assumptions

- clock.start is 2026-10-07T09:00:00Z and tick is 0s.
  - Why: Every historical event in the CSV ends by 2026-09-30T21:00:00Z, so the world starts after them. 2026-10-07 is today's date. Some unreturned loans are due after the start (due dates run to 2026-10-19), so the seed holds both overdue and still-active unreturned loans. Time moves only through tests or the clock endpoint, which keeps tests exact.
- Books use the CSV isbn as a unique string field, and loans reference the book by its row id (book_id). The seed maps loan.isbn to the book row.
  - Why: The ISBN is the natural key, but the engine's ref fields point at row ids. The 13-digit ISBN would lose any leading zeros as an int, so it is stored as a string.
- The CSV copies column becomes book.copies. Availability is not stored. Checkout counts a book's open loans (active or overdue) against copies. If the seed already has more open loans than copies, availability is simply 0 and no seed row is changed.
  - Why: A stored availability counter could drift from the loans and complicates plain book create and update.
- Members are not in the CSV. The seed creates one member per distinct loan member_id (107), with the CSV code kept in member.code, generated names and emails, and about 10 suspended.
  - Why: Loans need a member row to reference. A member state gives the suspension rule something to work on.
- Loan period is 21 days, a renewal adds 14 days, there are at most 2 renewals, and the loan limit is 5 open loans.
  - Why: The CSV due_at is exactly 21 days after borrowed_at. The renewal figures are common library defaults.
- Fine is 25 cents per full 24 hours overdue, capped at 2000 cents. Checkout is blocked at 1000 cents or more of unpaid fines. Fines are paid in full through pay_fine and only after the return.
  - Why: The CSV fine_cents values (e.g. 450 = 18 days) fit 25 cents a day. The cap and the block threshold are the simplest consistent policy, since the CSV carries no rules. Seed fines stay as given.
- Loans are never created or edited through generic routes. Only checkout_book, return_loan, renew_loan and pay_fine write them, and the accrue_overdue job moves them to overdue. Book and member records have plain create, get, update and list routes. There is no delete route for books, members or loans.
  - Why: This forces agents to use the real circulation workflow, so rules such as fines and copy availability cannot be bypassed, and history is kept.
- List routes use cursor mode with the default envelope (data, next_cursor). Searches use ?q=. The default error shape is {error:{code,message}}.
  - Why: These are the engine defaults, so agents see one consistent convention.
- Acceptance tests use ISBNs 97900000000xx and member codes ACC-Mxx, which the CSV never uses. The ISBNs in the CSV start 9781.
  - Why: The tests create their rows through the API and must not collide with seed data. They run before any seed exists.
- The routes checkout_book, return_loan, renew_loan and pay_fine in the route list share ids with workflow actions and are built as those actions, not as routes.
  - Why: The plan lists the public paths. The actions own the real behavior.
- fine_paid is not a CSV column. The seed marks a returned loan's fine as paid when its row index i has i % 5 < 2, so 36 of the 82 returned loans with a fine (44%) start paid.
  - Why: The CSV records fines but not payments. A mix of paid and unpaid fines gives the fine tasks rows to find. The split is invented, not imported.
- renewals is not a CSV column. The seed sets it from the row index: 2 when i % 7 is 0, else 1 when i % 3 is 0, else 0. That gives 172 loans with 0 renewals, 85 with 1 and 43 with 2.
  - Why: The CSV has no renewal history, but the renewal rule needs loans that have used some or all of their 2 renewals. The counts are invented, not imported.
- The CSV and the world round fines differently. The CSV charges 25 cents per started day, rounding up: all 230 returned-loan fines match that rule, and only 155 match whole days. return_loan and accrue_overdue charge 25 cents per full 24 hours, rounding down. The seed keeps the CSV values.
  - Why: The seed keeps imported history as given, and new returns follow the world's own rule. So L00001 (due 2026-07-06T10:00Z, returned 2026-07-23T15:00Z) holds 450 cents in the seed, but the same return made through return_loan would charge 425 cents.
- Open-loan fines in the CSV are counted to 2026-10-01. All 70 unreturned loans match that date, and only 36 match the clock start of 2026-10-07T09:00Z. The seed keeps the CSV values. loan.status is not a CSV column: the seed derives returned, overdue or active from returned_at and due_at.
  - Why: The CSV was exported before the world's clock start. accrue_overdue recomputes every overdue fine with the world's rule each time it fires, so the seeded open-loan fines change on the first clock advance.

## Out of scope

- Holds and reservations for books
  - Why: The CSV has no reservations. They need a queue and notifications beyond the loan lifecycle this world covers.
- Staff accounts, authentication and branch permissions
  - Why: Nothing in the CSV models them, and the tasks need only the public records API.
- Real payments and refunds (card gateways, partial payments, fine waivers)
  - Why: A fine is either paid in full or not. A payment system would be a separate world.
- Inter-branch transfers and per-branch inventory counts
  - Why: Each book belongs to one branch in the CSV. Moving copies adds a model the data does not support.
- Email or SMS overdue notices, reports and dashboards
  - Why: They are outputs, not state an agent changes.
- Lost or damaged items and replacement charges
  - Why: The CSV has no such state, and it would add a fourth loan state with its own money rules.

## Changes

None. The plan changes no existing item.
