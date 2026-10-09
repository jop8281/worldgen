# WorldGen plan: Expensify/Concur-style expense reporting tool

Employees file expense reports of itemised expenses with receipts. Each category has a receipt threshold and an approval limit. Managers approve reports within limits, finance approves over-limit reports, and finance reimburses approved reports.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `employee` | Person who files or approves expenses; role employee, manager or finance; optional manager_id | name, email, role, manager_id |
| `category` | Expense category with receipt threshold and per-expense approval limit | name, approval_limit, receipt_threshold |
| `expense_report` | A report of expenses with a status machine draft/submitted/approved/rejected/reimbursed | employee_id, title, status, total, approver_id, rejection_reason |
| `expense` | One line of a report | report_id, category_id, amount, merchant, incurred_on, receipt_attached |
| `receipt` | Receipt file attached to an expense | expense_id, filename |
| `reimbursement` | Payout record created when finance reimburses an approved report | report_id, amount, paid_by_id |

## Workflows

### expense_report_lifecycle (expense_report)
- States: draft, submitted, approved, rejected, reimbursed
- Actions: add_expense, attach_receipt, submit_report, approve_report, reject_report, reimburse_report
- Rules:
  - Expenses can be added only to a draft report and the report total is the sum of its expenses Enforced by: add_expense. Tested by: draft_only_expenses
  - Submitting needs at least one expense and a receipt on every expense above its category receipt threshold Enforced by: submit_report, attach_receipt. Tested by: submit_requires_receipts
  - Only the submitter's manager or a finance employee may approve, never the submitter; an expense above its category approval limit needs a finance approver Enforced by: approve_report. Tested by: approval_authority
  - A finance employee can approve an over-limit report that a manager could not Enforced by: approve_report. Tested by: over_limit_needs_finance
  - Rejecting needs a reason and an approver with authority, and a rejected report is final Enforced by: reject_report. Tested by: reject_needs_reason
  - Only finance reimburses, only approved reports, once; this creates a reimbursement for the report total Enforced by: reimburse_report. Tested by: reimburse_once_by_finance
  - Report status moves only along draft->submitted->approved|rejected, approved->reimbursed Enforced by the data model: state machine on expense_report.status

## Jobs

None. The plan declares no job.

## Acceptance tests

### draft_only_expenses
- Intent: Expenses can only be added to draft reports and totals accumulate
- Actions: add_expense, submit_report, attach_receipt
- Description: Add two expenses, check total, submit, then adding is refused

```js
(ctx) => {
const post = (p, b) => ctx.api('POST', p, b);
const m = post('/employees', { name: 'Dee Draft', email: 'dee.draft@acc.example', role: 'employee' }).body;
const c = post('/categories', { name: 'Meals-A1', approval_limit: 10000, receipt_threshold: 5000 }).body;
const r = post('/expense_reports', { employee_id: m.id, title: 'Trip A1' });
ctx.assert(r.status === 201 && r.body.status === 'draft', 'report create: ' + JSON.stringify(r.body));
const e1 = post('/expense_reports/' + r.body.id + '/expenses', { category_id: c.id, amount: 1200, merchant: 'Cafe', incurred_on: '2026-10-01T00:00:00Z' });
ctx.assert(e1.status === 200 || e1.status === 201, 'add expense 1: ' + JSON.stringify(e1.body));
const e2 = post('/expense_reports/' + r.body.id + '/expenses', { category_id: c.id, amount: 800, merchant: 'Diner', incurred_on: '2026-10-02T00:00:00Z' });
ctx.assert(e2.status === 200 || e2.status === 201, 'add expense 2');
ctx.assert(ctx.api('GET', '/expense_reports/' + r.body.id).body.total === 2000, 'total should be 2000');
ctx.assert(post('/expense_reports/' + r.body.id + '/submit', {}).status === 200, 'submit should work');
ctx.assert(post('/expense_reports/' + r.body.id + '/expenses', { category_id: c.id, amount: 100, merchant: 'Late', incurred_on: '2026-10-03T00:00:00Z' }).status === 409, 'adding to submitted report refused');
}
```
### submit_requires_receipts
- Intent: Submit is refused without required receipts and works after attaching one
- Actions: add_expense, attach_receipt, submit_report
- Description: Empty report and missing receipt both refuse submit; receipt unblocks it

```js
(ctx) => {
const post = (p, b) => ctx.api('POST', p, b);
const m = post('/employees', { name: 'Rex Receipt', email: 'rex.receipt@acc.example', role: 'employee' }).body;
const c = post('/categories', { name: 'Hotel-A2', approval_limit: 50000, receipt_threshold: 2500 }).body;
const r = post('/expense_reports', { employee_id: m.id, title: 'Conf A2' }).body;
ctx.assert(post('/expense_reports/' + r.id + '/submit', {}).status === 409, 'empty report cannot be submitted');
const e = post('/expense_reports/' + r.id + '/expenses', { category_id: c.id, amount: 9000, merchant: 'Inn', incurred_on: '2026-10-01T00:00:00Z' }).body;
ctx.assert(post('/expense_reports/' + r.id + '/submit', {}).status === 409, 'missing receipt refuses submit');
const a = post('/expenses/' + e.id + '/receipt', { filename: 'inn.pdf' });
ctx.assert(a.status === 200 || a.status === 201, 'attach receipt: ' + JSON.stringify(a.body));
ctx.assert(ctx.api('GET', '/expenses/' + e.id).body.receipt_attached === true, 'receipt_attached true');
const s = post('/expense_reports/' + r.id + '/submit', {});
ctx.assert(s.status === 200 && s.body.status === 'submitted', 'submit after receipt: ' + JSON.stringify(s.body));
}
```
### approval_authority
- Intent: Only the submitter's manager or finance can approve; not self, not another employee
- Actions: add_expense, submit_report, approve_report
- Description: Self, stranger refused; manager approves

```js
(ctx) => {
const post = (p, b) => ctx.api('POST', p, b);
const mg = post('/employees', { name: 'Mia Manager', email: 'mia.manager@acc.example', role: 'manager' }).body;
const emp = post('/employees', { name: 'Eli Employee', email: 'eli.employee@acc.example', role: 'employee', manager_id: mg.id }).body;
const other = post('/employees', { name: 'Oz Other', email: 'oz.other@acc.example', role: 'manager' }).body;
const c = post('/categories', { name: 'Taxi-A3', approval_limit: 10000, receipt_threshold: 5000 }).body;
const r = post('/expense_reports', { employee_id: emp.id, title: 'Taxi A3' }).body;
post('/expense_reports/' + r.id + '/expenses', { category_id: c.id, amount: 3000, merchant: 'Cab', incurred_on: '2026-10-01T00:00:00Z' });
post('/expense_reports/' + r.id + '/submit', {});
ctx.assert(post('/expense_reports/' + r.id + '/approve', { approver_id: emp.id }).status === 409, 'self approval refused');
ctx.assert(post('/expense_reports/' + r.id + '/approve', { approver_id: other.id }).status === 409, 'non-manager refused');
const ok = post('/expense_reports/' + r.id + '/approve', { approver_id: mg.id });
ctx.assert(ok.status === 200 && ok.body.status === 'approved' && ok.body.approver_id === mg.id, 'manager approves: ' + JSON.stringify(ok.body));
ctx.assert(post('/expense_reports/' + r.id + '/approve', { approver_id: mg.id }).status === 409, 'approve twice refused');
}
```
### over_limit_needs_finance
- Intent: A report with an over-limit expense is refused for a manager but approved by finance
- Actions: add_expense, attach_receipt, submit_report, approve_report
- Description: Manager refused, finance approves

```js
(ctx) => {
const post = (p, b) => ctx.api('POST', p, b);
const mg = post('/employees', { name: 'Max Manager', email: 'max.manager@acc.example', role: 'manager' }).body;
const fin = post('/employees', { name: 'Fay Finance', email: 'fay.finance@acc.example', role: 'finance' }).body;
const emp = post('/employees', { name: 'Ian Intern', email: 'ian.intern@acc.example', role: 'employee', manager_id: mg.id }).body;
const c = post('/categories', { name: 'Gear-A4', approval_limit: 20000, receipt_threshold: 5000 }).body;
const r = post('/expense_reports', { employee_id: emp.id, title: 'Laptop A4' }).body;
const e = post('/expense_reports/' + r.id + '/expenses', { category_id: c.id, amount: 25000, merchant: 'ShopCo', incurred_on: '2026-10-01T00:00:00Z' }).body;
post('/expenses/' + e.id + '/receipt', { filename: 'laptop.pdf' });
ctx.assert(post('/expense_reports/' + r.id + '/submit', {}).status === 200, 'submit');
ctx.assert(post('/expense_reports/' + r.id + '/approve', { approver_id: mg.id }).status === 409, 'manager cannot approve over limit');
ctx.assert(ctx.api('GET', '/expense_reports/' + r.id).body.status === 'submitted', 'still submitted');
const ok = post('/expense_reports/' + r.id + '/approve', { approver_id: fin.id });
ctx.assert(ok.status === 200 && ok.body.status === 'approved', 'finance approves: ' + JSON.stringify(ok.body));
}
```
### reject_needs_reason
- Intent: Reject needs a reason and authority and is final
- Actions: add_expense, submit_report, reject_report, approve_report
- Description: Reject without reason refused; with reason ok; then cannot approve

```js
(ctx) => {
const post = (p, b) => ctx.api('POST', p, b);
const mg = post('/employees', { name: 'Rho Manager', email: 'rho.manager@acc.example', role: 'manager' }).body;
const emp = post('/employees', { name: 'Ula Employee', email: 'ula.employee@acc.example', role: 'employee', manager_id: mg.id }).body;
const c = post('/categories', { name: 'Misc-A5', approval_limit: 10000, receipt_threshold: 5000 }).body;
const r = post('/expense_reports', { employee_id: emp.id, title: 'Misc A5' }).body;
post('/expense_reports/' + r.id + '/expenses', { category_id: c.id, amount: 1500, merchant: 'Kiosk', incurred_on: '2026-10-01T00:00:00Z' });
ctx.assert(post('/expense_reports/' + r.id + '/reject', { approver_id: mg.id, reason: 'not yet' }).status === 409, 'draft cannot be rejected');
post('/expense_reports/' + r.id + '/submit', {});
ctx.assert(post('/expense_reports/' + r.id + '/reject', { approver_id: mg.id, reason: '' }).status >= 400, 'empty reason refused');
const ok = post('/expense_reports/' + r.id + '/reject', { approver_id: mg.id, reason: 'Personal purchase' });
ctx.assert(ok.status === 200 && ok.body.status === 'rejected' && ok.body.rejection_reason === 'Personal purchase', 'reject: ' + JSON.stringify(ok.body));
ctx.assert(post('/expense_reports/' + r.id + '/approve', { approver_id: mg.id }).status === 409, 'rejected is final');
}
```
### reimburse_once_by_finance
- Intent: Only finance reimburses an approved report, once, creating a reimbursement
- Actions: add_expense, submit_report, approve_report, reimburse_report
- Description: Draft/non-finance refused; finance reimburses; second refused

```js
(ctx) => {
const post = (p, b) => ctx.api('POST', p, b);
const mg = post('/employees', { name: 'Sol Manager', email: 'sol.manager@acc.example', role: 'manager' }).body;
const fin = post('/employees', { name: 'Gil Finance', email: 'gil.finance@acc.example', role: 'finance' }).body;
const emp = post('/employees', { name: 'Tia Employee', email: 'tia.employee@acc.example', role: 'employee', manager_id: mg.id }).body;
const c = post('/categories', { name: 'Travel-A6', approval_limit: 30000, receipt_threshold: 5000 }).body;
const r = post('/expense_reports', { employee_id: emp.id, title: 'Trip A6' }).body;
post('/expense_reports/' + r.id + '/expenses', { category_id: c.id, amount: 4000, merchant: 'Train', incurred_on: '2026-10-01T00:00:00Z' });
ctx.assert(post('/expense_reports/' + r.id + '/reimburse', { finance_id: fin.id }).status === 409, 'draft cannot be reimbursed');
post('/expense_reports/' + r.id + '/submit', {});
post('/expense_reports/' + r.id + '/approve', { approver_id: mg.id });
ctx.assert(post('/expense_reports/' + r.id + '/reimburse', { finance_id: mg.id }).status === 409, 'non-finance refused');
const ok = post('/expense_reports/' + r.id + '/reimburse', { finance_id: fin.id });
ctx.assert(ok.status === 200 && ok.body.status === 'reimbursed', 'reimburse: ' + JSON.stringify(ok.body));
const list = ctx.api('GET', '/reimbursements?report_id=' + r.id).body.data;
ctx.assert(list.length === 1 && list[0].amount === 4000 && list[0].paid_by_id === fin.id, 'reimbursement row');
ctx.assert(post('/expense_reports/' + r.id + '/reimburse', { finance_id: fin.id }).status === 409, 'second reimburse refused');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_employees` | GET | /employees | List employees, filter by role, manager_id, email |
| `get_employee` | GET | /employees/{id} | Get employee |
| `create_employee` | POST | /employees | Create employee |
| `list_categories` | GET | /categories | List categories |
| `get_category` | GET | /categories/{id} | Get category |
| `create_category` | POST | /categories | Create category |
| `list_reports` | GET | /expense_reports | List reports, filter by employee_id, status, approver_id |
| `get_report` | GET | /expense_reports/{id} | Get report |
| `create_report` | POST | /expense_reports | Create draft report |
| `list_expenses` | GET | /expenses | List expenses, filter by report_id, category_id |
| `get_expense` | GET | /expenses/{id} | Get expense |
| `list_receipts` | GET | /receipts | List receipts, filter by expense_id |
| `list_reimbursements` | GET | /reimbursements | List reimbursements, filter by report_id |
| `add_expense` | POST | /expense_reports/{id}/expenses | Action: add expense to draft report |
| `attach_receipt` | POST | /expenses/{id}/receipt | Action: attach receipt |
| `submit_report` | POST | /expense_reports/{id}/submit | Action: submit |
| `approve_report` | POST | /expense_reports/{id}/approve | Action: approve |
| `reject_report` | POST | /expense_reports/{id}/reject | Action: reject |
| `reimburse_report` | POST | /expense_reports/{id}/reimburse | Action: reimburse |

## Seed

- Rows per entity: employee: 9, category: 5, expense_report: 30, expense: 70, receipt: 50, reimbursement: 6
- Mix: 30 reports across all statuses with some submitted reports containing an expense above its category approval limit (needing finance) and near-miss reports just under the limit; drafts with expenses lacking required receipts; misleading report titles such as 'APPROVED - do not review' on submitted reports; one employee with several reports so listing must page past 25.
- State mix: expense_report: draft 20%, submitted 35%, approved 15%, rejected 10%, reimbursed 20%

## Tasks

- `approve_team_report` (easy, permissions): As a named manager, approve the one submitted report of a named direct report that is within limits.
  - Actions: `approve_report`
  - Decoy idea: Approves a different submitted report with a similar title or one from another team.
  - Pressure: seeded rows in expense_report.submitted
- `fix_and_submit_draft` (medium, misleading_text): An employee's draft has an expense above the receipt threshold with no receipt (a note says 'receipt attached'); attach the receipt filename given and submit the report.
  - Actions: `attach_receipt`, `submit_report`
  - Decoy idea: Trusts the note and submits without attaching, or attaches to the wrong expense.
  - Pressure: seeded rows in expense_report.draft; distractor rows of expense
- `finance_clear_over_limit_queue` (hard, irreversible): As the named finance employee, find the submitted reports of one department's employees that contain an over-limit expense (reading past the first page of reports), approve them, and reimburse them; leave under-limit and other-department reports untouched.
  - Actions: `approve_report`, `reimburse_report`
  - Decoy idea: Stops at first page, reimburses the near-miss report just under the limit, or approves everything submitted.
  - Pressure: paging past the first page of expense_report; seeded rows in expense_report.submitted, expense_report.approved; distractor rows of expense_report

## Open questions

- Is the approval limit per expense or per report total?
  - Default answer: Per expense.
- Who approves over-limit reports?
  - Default answer: A finance-role employee.
- Can rejected reports be resubmitted?
  - Default answer: No, rejected is final.

## Assumptions

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

## Out of scope

- File upload, OCR, multi-currency, mileage/per-diem, accounting export, notifications
  - Why: Not records-and-actions core

## Changes

None. The plan changes no existing item.
