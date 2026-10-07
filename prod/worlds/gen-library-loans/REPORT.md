# WorldGen report: Koha/Evergreen-style public library circulation desk (catalog, patrons, loans, renewals, overdue fines)

A library circulation system built from the books and loans CSVs. Staff look up books and members, check books out, renew them, return them and collect overdue fines. A job marks late loans overdue and accrues fines. Checkout rules cover copy availability, a loan limit, unpaid fines and member suspension.

## What was built

Entities (3):

- `book`: 200 seeded rows
- `member`: 107 seeded rows
- `loan`: 300 seeded rows

Routes (12):

- `list_books`: GET /books
- `get_book`: GET /books/{id}
- `create_book`: POST /books
- `update_book`: PATCH /books/{id}
- `list_members`: GET /members
- `get_member`: GET /members/{id}
- `create_member`: POST /members
- `update_member`: PATCH /members/{id}
- `list_loans`: GET /loans
- `get_loan`: GET /loans/{id}
- `list_member_loans`: GET /members/{member_id}/loans
- `list_book_loans`: GET /books/{book_id}/loans

Actions (4):

- `checkout_book`: POST /loans/checkout
- `return_loan`: POST /loans/{id}/return
- `renew_loan`: POST /loans/{id}/renew
- `pay_fine`: POST /loans/{id}/pay_fine

Jobs (1):

- `accrue_overdue`: every 1h

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 8 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_ef4057042f754ae3c63939a0287a6ecb17602c3e4e2c42beb785defec6ba1f6a`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | TID |
|---|---|---|---|---|---|---|
| return_longest_overdue_loan | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | `tid_3e0366fdda4c91cc7db58a299dc5166aac8604d96a467a309d3565d27ae95679` |
| collect_top_fines_member | medium | 1.000 | 0.000 | 0.333, 0.000, 0.000, 0.000 | 0.667 | `tid_c30636f1143fb7506d817f351c9f77b2edb53f274d5edd389bdb0fb46b356a9d` |
| clear_riverside_overdue | hard | 1.000 | 0.000 | 0.833, 0.500, 0.000, 0.000 | 0.917 | `tid_63b9f90fb99488a52a8e2c2fb74b6295e5f220871b9925f3f4a4e0e4af32d474` |

Decoys:

- `return_longest_overdue_loan` 0.000: returns the overdue loan with the latest due date instead of the earliest
- `return_longest_overdue_loan` 0.000: returns the correct loan but also returns the next overdue loan, changing an unrelated record
- `collect_top_fines_member` 0.333: pays only the single largest unpaid fine of the top member and leaves the rest unpaid
- `collect_top_fines_member` 0.000: picks the member with the most loans instead of the largest unpaid fine total and pays that member's fines
- `collect_top_fines_member` 0.000: pays only the one largest unpaid fine in the whole library, whoever owes it
- `collect_top_fines_member` 0.000: pays every unpaid fine in the library instead of only the top member's fines
- `clear_riverside_overdue` 0.833: reads only the first page of overdue loans, so the riverside loans on page 2 stay overdue
- `clear_riverside_overdue` 0.500: returns every overdue riverside loan but never pays the fines the returns created
- `clear_riverside_overdue` 0.000: returns and pays every open riverside loan, including active ones that are not overdue
- `clear_riverside_overdue` 0.000: ignores the branch and returns and pays every overdue loan in the library

## Run

Mode: create from csv. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 3.11 | 0.4272 |
| model | 1 | 0.33 | 0.3088 |
| workflow | 1 | 0.39 | 0.3200 |
| seed | 2 | 0.57 | 0.6363 |
| tasks | 1 | 1.86 | 0.4805 |
| Total | 6 | 6.25 | 2.1728 |

Run total: 7.26 minutes, $2.1728.
