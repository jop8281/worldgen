# WorldGen report: Koha-style public library circulation API

A public library circulation desk: patrons borrow copies of books, return them, renew them, place and fulfil holds on a title, and pay or waive the overdue and lost-item fines that returns and losses create. Copies are items, titles are books, and each loan, hold and fine has its own status workflow.

## What was built

Entities (6):

- `patron`: 28 seeded rows
- `book`: 8 seeded rows
- `item`: 40 seeded rows
- `loan`: 30 seeded rows
- `hold`: 10 seeded rows
- `fine`: 12 seeded rows

Routes (15):

- `list_patrons`: GET /patrons
- `get_patron`: GET /patrons/{id}
- `create_patron`: POST /patrons
- `list_books`: GET /books
- `get_book`: GET /books/{id}
- `create_book`: POST /books
- `list_items`: GET /items
- `get_item`: GET /items/{id}
- `create_item`: POST /items
- `list_loans`: GET /loans
- `get_loan`: GET /loans/{id}
- `list_holds`: GET /holds
- `get_hold`: GET /holds/{id}
- `list_fines`: GET /fines
- `get_fine`: GET /fines/{id}

Actions (9):

- `checkout_item`: POST /checkouts
- `return_item`: POST /items/{id}/return
- `report_lost`: POST /loans/{id}/report_lost
- `renew_loan`: POST /loans/{id}/renew
- `place_hold`: POST /holds
- `cancel_hold`: POST /holds/{id}/cancel
- `fulfill_hold`: POST /holds/{id}/fulfill
- `pay_fine`: POST /fines/{id}/pay
- `waive_fine`: POST /fines/{id}/waive

Jobs: none.

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 10 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_80dbf9b5d21800bb449654615ed2ab878beebb75201bee87b9110e5ba5d64e5c`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| pay_patron_open_fine | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 3/8 | `tid_923292d4c8990bee3ffe4db3b53181e61ada20493b886028a97797b06c40635d` |
| renew_only_unheld_loans | medium | 1.000 | 0.000 | 0.500 | 0.500 | declared (1); mutants 4/8 | `tid_5d5e638103db945a743870af24ac32ec2bf62e974155d10e286c5d96c4165ea8` |
| fulfil_earliest_hold | medium | 1.000 | 0.000 | 0.400 | 0.400 | declared (3); mutants 3/8 | `tid_930bd80403d52577dca760ff885ec1859b39564e15a34c8b3bf859e6ebcabb84` |
| waive_lost_charge_of_returned_title | hard | 1.000 | 0.000 | 0.550, 0.000 | 0.550 | declared (4); mutants 3/8 | `tid_7677914a8738088262ebb0cd2fe58bad5d737cfb2a0ba80e44fe7bebee945a93` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `pay_patron_open_fine` 0.000: waives the open fine instead of paying it, so the status is waived, not paid
- `renew_only_unheld_loans` 0.500: renews only the loan due soonest and stops, so the other renewable loan keeps its old due date
- `fulfil_earliest_hold` 0.400: tries the newest hold first, which the engine refuses, then fulfils only the earliest hold with the second copy and stops
- `waive_lost_charge_of_returned_title` 0.550: reports the right loan lost and stops, leaving its lost-item charge open
- `waive_lost_charge_of_returned_title` 0.000: reports the first loan the patron has, the Lantern Keeper copy, lost and waives the charge it creates

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| pay_patron_open_fine | easy | 1 | none | none | state: met |
| renew_only_unheld_loans | medium | 2 | none | loan | distractors: met; state: met; state: met |
| fulfil_earliest_hold | medium | 6 | none | hold, item | distractors: met; state: met |
| waive_lost_charge_of_returned_title | hard | 3 | none | loan | hard: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Koha-style public library circulation API, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 2.23 | 0.0300 |
| model | 1 | 0.55 | 0.0220 |
| workflow | 1 | 0.81 | 0.0249 |
| seed | 1 | 1.07 | 0.0261 |
| tasks | 1 | 4.35 | 0.1341 |
| Total | 5 | 9.00 | 0.2371 |

Run total: 9.00 minutes, $0.2371.
