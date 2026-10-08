# WorldGen report: Snipe-IT style IT asset management (laptops, checkouts, maintenance, audits)

An IT asset tracker. Laptops move between in-stock, assigned, in-repair, lost and retired. Employees check laptops out and back in. Repair tickets take a laptop out of service until complete. Quarterly audits snapshot the laptops at a location, record whether each was found, and close by flagging missing laptops as lost.

## What was built

Entities (6):

- `employee`: 30 seeded rows
- `laptop`: 60 seeded rows
- `assignment`: 50 seeded rows
- `repair_ticket`: 30 seeded rows
- `audit`: 4 seeded rows
- `audit_item`: 60 seeded rows

Routes (17):

- `list_employees`: GET /employees
- `get_employee`: GET /employees/{id}
- `create_employee`: POST /employees
- `update_employee`: PATCH /employees/{id}
- `list_laptops`: GET /laptops
- `get_laptop`: GET /laptops/{id}
- `create_laptop`: POST /laptops
- `update_laptop`: PATCH /laptops/{id}
- `list_assignments`: GET /assignments
- `get_assignment`: GET /assignments/{id}
- `list_repair_tickets`: GET /repair_tickets
- `get_repair_ticket`: GET /repair_tickets/{id}
- `list_audits`: GET /audits
- `get_audit`: GET /audits/{id}
- `create_audit`: POST /audits
- `list_audit_items`: GET /audit_items
- `get_audit_item`: GET /audit_items/{id}

Actions (8):

- `assign_laptop`: POST /laptops/{id}/assign
- `return_laptop`: POST /laptops/{id}/return
- `retire_laptop`: POST /laptops/{id}/retire
- `open_repair`: POST /laptops/{id}/repair
- `complete_repair`: POST /repair_tickets/{id}/complete
- `start_audit`: POST /audits/{id}/start
- `verify_audit_item`: POST /audit_items/{id}/verify
- `close_audit`: POST /audits/{id}/close

Jobs (1):

- `flag_stale_repairs`: every 1d

## Assumed and why

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

## Questions asked of the input

- Should audits cover all locations or one location each?
  - Default answer: One location per audit.
- Should a missing laptop become lost automatically?
  - Default answer: Yes, on audit close.
- Do repairs have intermediate states?
  - Default answer: No, only open and completed.

## Left out

- Purchasing, depreciation and warranty accounting
  - Why: The request covers tracking, assignment, repair and audit only.
- Non-laptop asset types, barcode scanning, file attachments, notifications
  - Why: Not needed for the stateful workflows.
- Authentication and roles
  - Why: The world is a single-tenant API.

## Proof

The engine check passed: 9 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_5469f0fd8e596c18a7f1a78c2fd73d3165d5e015bec98463aaf7db6c267ad445`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| assign_spare_laptop | easy | 1.000 | 0.000 | 0.000, 0.400 | n/a | declared (2); mutants 6/7 | `tid_b2e7a2ed48c0e52d93169e0603118bf19426e10f5053b8e41814edbe933e1fef` |
| send_assigned_laptop_to_repair | medium | 1.000 | 0.000 | 0.000, 0.700, 0.000 | n/a | declared (3); mutants 4/7 | `tid_dcc91d138087bfa363c5d832b80e3a9af6bdda64a50b2585b6014078de589e61` |
| close_in_progress_audit | hard | 1.000 | 0.000 | 0.000, 0.250, 0.500 | 0.500 | declared (4); mutants 2/7 | `tid_3308813d9a2041f89fb3dee49be088d2162059fa4395fa9fa0b11cff2c46b4c0` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `assign_spare_laptop` 0.000: assigns the in-stock laptop with the highest asset tag instead of the lowest
- `assign_spare_laptop` 0.400: PATCHes the laptop status to assigned instead of calling assign, so no assignment exists for the employee
- `send_assigned_laptop_to_repair` 0.000: opens the repair on the employee's earlier, already returned laptop (or any stock laptop if that one cannot go to repair)
- `send_assigned_laptop_to_repair` 0.700: opens the repair on the right laptop but with a different issue text than requested
- `send_assigned_laptop_to_repair` 0.000: PATCHes the laptop status to in_repair instead of opening a repair ticket, leaving the assignment active and no ticket
- `close_in_progress_audit` 0.000: reads only the first page of pending items, verifies those, and tries to close, so the rest stay pending and the close is refused
- `close_in_progress_audit` 0.250: marks every pending item found without checking whether the expected holder is inactive, then closes
- `close_in_progress_audit` 0.500: verifies every pending item correctly across all pages but never closes the audit

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| assign_spare_laptop | easy | 2 | none | none | none declared |
| send_assigned_laptop_to_repair | medium | 3 | none | none | none declared |
| close_in_progress_audit | hard | 42 | audit_item | none | hard: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Snipe-IT style IT asset management (laptops, checkouts, maintenance, audits), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $5.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 3 | 3.14 | 0.5324 |
| model | 2 | 0.69 | 0.2413 |
| workflow | 1 | 0.44 | 0.1402 |
| seed | 1 | 1.26 | 0.2103 |
| tasks | 1 | 2.34 | 0.3279 |
| Total | 8 | 7.86 | 1.4520 |

Backtracks:

- `model` to `plan`: 1 issue

Run total: 7.89 minutes, $1.4520.
