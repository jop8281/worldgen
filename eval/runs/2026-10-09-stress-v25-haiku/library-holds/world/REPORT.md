# WorldGen report: Library circulation system (Koha-style branches, copies, holds and fines)

A public library circulation API. Branches hold book copies of titles. Members borrow copies as checkouts with a due date. A holds queue per title serves waiting members in order when a copy comes back. Overdue checkouts accrue fines that block new loans until paid. The world has four workflows (copy, loan, hold queue, fine settlement), six actions, two jobs, list and get routes for every entity, and a seed with one list page of copies and a few scenarios the tasks need.

## What was built

Entities (7):

- `branch`: 4 seeded rows
- `title`: 20 seeded rows
- `book_copy`: 30 seeded rows
- `member`: 24 seeded rows
- `checkout`: 20 seeded rows
- `hold`: 10 seeded rows
- `fine`: 8 seeded rows

Routes (17):

- `list_branches`: GET /branches
- `create_branch`: POST /branches
- `list_titles`: GET /titles
- `create_title`: POST /titles
- `get_title`: GET /titles/{id}
- `list_copies`: GET /copies
- `create_copy`: POST /copies
- `get_copy`: GET /copies/{id}
- `list_members`: GET /members
- `create_member`: POST /members
- `get_member`: GET /members/{id}
- `list_checkouts`: GET /checkouts
- `get_checkout`: GET /checkouts/{id}
- `list_holds`: GET /holds
- `get_hold`: GET /holds/{id}
- `list_fines`: GET /fines
- `get_fine`: GET /fines/{id}

Actions (6):

- `checkout_copy`: POST /copies/{id}/checkout
- `return_copy`: POST /checkouts/{id}/return
- `withdraw_copy`: POST /copies/{id}/withdraw
- `place_hold`: POST /titles/{id}/holds
- `cancel_hold`: POST /holds/{id}/cancel
- `pay_fine`: POST /fines/{id}/pay

Jobs (2):

- `expire_ready_holds`: every 1h
- `accrue_overdue_fines`: every 1d

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 8 world tests, 3 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_f79c4e88a2f5f5984a6691b4a6f3606438a10e3b8cf4c85130086eb4bd2e41ff`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| checkout_available_copy | easy | 1.000 | 0.000 | none | n/a | declared (2); mutants 5/8 | `tid_2e278e8c10ace79dcb88f36b1beb37de613f662eb3b7813f8adeee468eed380d` |
| return_and_serve_hold | medium | 1.000 | 0.000 | 0.500, 0.000 | n/a | declared (3); mutants 4/8 | `tid_af17a0821a548956c0a36e242e9559f9d2d4eaefca5577ffa3a77208bb148775` |
| settle_and_collect_hold | hard | 1.000 | 0.000 | 0.400, 0.000 | 0.400 | declared (4); mutants 4/8 | `tid_38db1f6acb14b185522352860e3675e867645a7621de5590d3d0e42fdbd3fc61` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `return_and_serve_hold` 0.500: checks the loan in, then cancels the hold it just made ready, so the copy goes back to the shelf and the longest-waiting patron gets nothing
- `return_and_serve_hold` 0.000: cancels the longest-waiting hold and leaves Ben's loan active, so the copy is never checked in
- `settle_and_collect_hold` 0.400: settles the fine and stops there, so the held copy is never collected and the hold stays ready
- `settle_and_collect_hold` 0.000: settles the fine, then checks out the copy sitting available on the shelf instead of the one held for her

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| checkout_available_copy | easy | 2 | none | none | none declared |
| return_and_serve_hold | medium | 3 | none | hold | distractors: met; state: met; state: met |
| settle_and_collect_hold | hard | 4 | none | book_copy | hard: met; distractors: met; state: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Library circulation system (Koha-style branches, copies, holds and fines), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 3.53 | 0.0318 |
| model | 1 | 0.80 | 0.0195 |
| workflow | 1 | 1.24 | 0.0239 |
| seed | 1 | 2.44 | 0.0329 |
| tasks | 1 | 2.71 | 0.0919 |
| Total | 6 | 10.71 | 0.2000 |

Run total: 10.72 minutes, $0.2000.
