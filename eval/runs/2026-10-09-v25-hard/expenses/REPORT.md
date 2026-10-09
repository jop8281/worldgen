# WorldGen report: Expensify/Concur-style expense reporting tool

Employees file expense reports of itemised expenses with receipts. Each category has a receipt threshold and an approval limit. Managers approve reports within limits, finance approves over-limit reports, and finance reimburses approved reports.

## What was built

Entities (6):

- `employee`: 9 seeded rows
- `category`: 5 seeded rows
- `expense_report`: 30 seeded rows
- `expense`: 70 seeded rows
- `receipt`: 53 seeded rows
- `reimbursement`: 6 seeded rows

Routes (13):

- `list_employees`: GET /employees
- `get_employee`: GET /employees/{id}
- `create_employee`: POST /employees
- `list_categories`: GET /categories
- `get_category`: GET /categories/{id}
- `create_category`: POST /categories
- `list_reports`: GET /expense_reports
- `get_report`: GET /expense_reports/{id}
- `create_report`: POST /expense_reports
- `list_expenses`: GET /expenses
- `get_expense`: GET /expenses/{id}
- `list_receipts`: GET /receipts
- `list_reimbursements`: GET /reimbursements

Actions (6):

- `add_expense`: POST /expense_reports/{id}/expenses
- `attach_receipt`: POST /expenses/{id}/receipt
- `submit_report`: POST /expense_reports/{id}/submit
- `approve_report`: POST /expense_reports/{id}/approve
- `reject_report`: POST /expense_reports/{id}/reject
- `reimburse_report`: POST /expense_reports/{id}/reimburse

Jobs: none.

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; all seeded history is before it
  - Why: Deterministic time after historical events; no task needs future events
- Approval limit is per expense, not per report total
  - Why: Per-category limits are naturally per line
- Over-limit reports must be approved by a finance-role employee; others by the submitter's direct manager (or finance)
  - Why: Manager sign-off plus escalation
- Finance may approve any report except their own; nobody approves own report
  - Why: Segregation of duties
- Expense amounts above the category receipt_threshold need an attached receipt to submit
  - Why: Typical policy
- Rejected reports are terminal; employee files a new report
  - Why: Keeps the state machine small
- Single currency USD, receipts are metadata only
  - Why: Simplicity
- Report total is maintained by add_expense
  - Why: Avoids stale totals
- No jobs
  - Why: No time-driven rule requested

## Questions asked of the input

- Is the approval limit per expense or per report total?
  - Default answer: Per expense.
- Who approves over-limit reports?
  - Default answer: A finance-role employee.
- Can rejected reports be resubmitted?
  - Default answer: No, rejected is final.

## Left out

- File upload, OCR, multi-currency, mileage/per-diem, accounting export, notifications
  - Why: Not records-and-actions core

## Proof

The engine check passed: 6 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_3abdd46b6164d6dbf0f8fbd9434c2142dc64b243357fb1485a5e525b28a18e34`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| approve_team_report | easy | 1.000 | 0.000 | 0.500, 0.000 | n/a | declared (1); mutants 4/8 | `tid_050e1ed9072f5e10f267f2531f6b47e1f418a04fb28640f26cc90788d8e29d31` |
| fix_and_submit_draft | medium | 1.000 | 0.000 | 0.600, 0.000, 0.000 | 0.600 | declared (3); mutants 3/8 | `tid_8559426fbff6dcabd7a2943953b11060bbc0793195d1f54c11a9cbf1668ed018` |
| finance_clear_over_limit_queue | hard | 1.000 | 0.000 | 0.750, 0.000, 0.000 | 0.750 | declared (5); mutants 4/8 | `tid_3a2b94fc633349abc211632a3bddda85b40b79eb286d9fbeb7b6923083861800` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `approve_team_report` 0.500: approves Erin's report as the finance employee Priya instead of as Maria, so the approver is wrong
- `approve_team_report` 0.000: approves Alice's submitted report titled APPROVED - do not review instead of Erin's report
- `fix_and_submit_draft` 0.600: attaches the receipt to the Lunch Bistro expense but never submits the report
- `fix_and_submit_draft` 0.000: fixes and submits Carla's other draft report (the Amtrak expense) instead of the Lunch Bistro one
- `fix_and_submit_draft` 0.000: attaches a receipt with the wrong filename (not the one asked for) to the Lunch Bistro expense and submits the report
- `finance_clear_over_limit_queue` 0.750: reads only the first page of reports, so the over-limit report on the second page is never approved or reimbursed
- `finance_clear_over_limit_queue` 0.000: approves and reimburses every submitted report of the team without checking expense amounts against category limits, including within-limit reports
- `finance_clear_over_limit_queue` 0.000: approves the over-limit team reports across all pages but never reimburses them

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| approve_team_report | easy | 1 | none | none | state: met |
| fix_and_submit_draft | medium | 3 | none | expense, expense_report | distractors: met; state: met |
| finance_clear_over_limit_queue | hard | 8 | expense_report | expense_report | hard: met; paging: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Expensify/Concur-style expense reporting tool, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.02 | 0.3707 |
| model | 1 | 0.38 | 0.3440 |
| workflow | 1 | 0.41 | 0.3608 |
| seed | 1 | 1.00 | 0.4184 |
| tasks | 2 | 3.10 | 0.7853 |
| Total | 6 | 5.91 | 2.2792 |

Run total: 5.93 minutes, $2.2792.
