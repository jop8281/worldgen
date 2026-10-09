# WorldGen report: Field service equipment repair desk ticketing (Zendesk / Freshdesk-style service desk)

A small equipment repair desk. Technicians have a name and an active flag. Repair tickets have a subject, customer name, priority (normal or urgent), a status (queued, active, closed) and an optional assigned technician. Tickets are listed with pagination and filters, created and edited through standard routes, and moved through explicit assign, start and close actions. Starting needs a queued ticket with an active assigned technician; closing needs an active ticket; assigning needs a queued ticket and an active technician. Refused calls write nothing. The seed is deterministic: four technicians (one inactive) and twelve tickets across all statuses and both priorities, with the list page size at 5 so the hard task must page.

## What was built

Entities (2):

- `technician`: 4 seeded rows
- `ticket`: 12 seeded rows

Routes (8):

- `list_technicians`: GET /technicians
- `get_technician`: GET /technicians/{id}
- `create_technician`: POST /technicians
- `update_technician`: PATCH /technicians/{id}
- `list_tickets`: GET /tickets
- `get_ticket`: GET /tickets/{id}
- `create_ticket`: POST /tickets
- `update_ticket`: PATCH /tickets/{id}

Actions (3):

- `assign_ticket`: POST /tickets/{id}/assign
- `start_ticket`: POST /tickets/{id}/start
- `close_ticket`: POST /tickets/{id}/close

Jobs: none.

## Assumed and why

- Assignment is allowed only while the ticket is queued; reassigning an active or closed ticket is refused with 409 invalid_state.
  - Why: The request defines assignment as part of starting a queued ticket and does not describe reassignment, so the narrowest state rule is used.
- Closing requires active status; a queued ticket cannot be closed without being started.
  - Why: The request says closing requires active status.
- Deactivating a technician does not change their tickets. start_ticket refuses an inactive assigned technician with 409 technician_inactive, and assign_ticket refuses an inactive technician with 409 technician_inactive.
  - Why: The request says inactive assignments must fail; it does not say deactivation reassigns or closes work.
- Technicians can be created and updated through standard routes (create_technician, update_technician).
  - Why: Acceptance tests must create their own rows through the API before any seed exists, and the inactive path needs a way to deactivate a technician.
- Ticket status and assigned_technician_id are readonly on standard create and update, and change only through assign_ticket, start_ticket and close_ticket.
  - Why: Otherwise a standard PATCH would bypass the assignment and start checks that the request requires to fail atomically.
- Handler error codes: invalid_state (409) for a wrong status, no_technician (409) when starting an unassigned ticket, technician_inactive (409) for an inactive technician, not_found (404) for an unknown ticket or technician.
  - Why: The request names the refusals but not their codes; the codes are fixed here so tests and tasks can assert them.
- Ticket priority can be edited in any status, including closed.
  - Why: The request does not restrict edits to open tickets.
- Tickets have no delete route.
  - Why: The request does not ask for deletion.
- Ticket list page size is 5 and the seed holds 12 tickets, which is more than one page, so the hard task must page.
  - Why: The guidance is just over one page, but the hard task needs paging to reach page-2 rows; 5 is the smallest size that keeps the queued list (7 rows) spanning two pages.
- Clock starts at 2026-10-09T09:00:00.000Z with a 1s tick.
  - Why: Today's date is 2026-10-09, and the start is after every seeded historical event; the tick keeps engine time moving deterministically.
- Search on tickets matches subject and customer_name through the q parameter.
  - Why: Tasks and tests need to find tickets by customer name and subject, which the request's filtering implies.
- Customer is a plain text name on the ticket, not its own entity.
  - Why: The request gives the customer as a name only, and a customer entity would add rows no task needs.

## Questions asked of the input

- Can a ticket be reassigned after it has been assigned or started?
  - Default answer: No. assign_ticket works only on queued tickets.
- Can a queued ticket be closed directly without being started?
  - Default answer: No. close_ticket requires active status.
- Does deactivating a technician release or close their active tickets?
  - Default answer: No. Their tickets stay as they are; only starting or assigning with them is refused.
- Should technicians be creatable through the API or only seeded?
  - Default answer: Through the API, with create_technician and update_technician.
- What page size should the ticket list use?
  - Default answer: 5, so the 12 seeded tickets span several pages.
- Should ticket priority be editable once a ticket is closed?
  - Default answer: Yes. The request does not restrict edits.

## Left out

- A separate customer entity or contact details
  - Why: The request stores a customer name on the ticket only.
- Parts, labour, invoices or time tracking
  - Why: The request covers tickets, technicians and their status only.
- Notifications, SLA timers or scheduled jobs
  - Why: The request names no timed behaviour, so no jobs are declared.
- Authentication, roles and permissions beyond the active flag
  - Why: The request says no credentials or external integrations.
- Deleting tickets or technicians
  - Why: The request does not ask for deletion.
- Attachments and ticket comments
  - Why: Not in the request.

## Proof

The engine check passed: 6 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_e7c363a935990fe63ed76ab28c3041a95baac55e641addf6587ad3a9c17c59c5`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| raise_urgent_priority | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 5/8 | `tid_c2eecfb9f03bffdbd26e59324e09a87d15c2da45f4885e5d35579640b07129bd` |
| assign_and_start_espresso | medium | 1.000 | 0.000 | 0.500, 0.500 | 0.500 | declared (1); mutants 7/8 | `tid_8dccb07e9d41053c98644c9eae8c2275e92c57e2b3495b38d1f66d320d9c09b3` |
| start_northgate_urgent_queue | hard | 1.000 | 0.000 | 0.333, 0.333 | 0.667 | declared (1); mutants 7/8 | `tid_c9a31e95db646af0e4c4dabbe94723cf6e8eff4f6852da25e25b3fbef7013de7` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `raise_urgent_priority` 0.000: raises the priority of Harbor Dental's active ticket 'Printer jams on tray 2' instead of the queued projector ticket
- `assign_and_start_espresso` 0.500: assigns Lena Ortiz to the ticket and never starts it, so the ticket stays queued
- `assign_and_start_espresso` 0.500: assigns and starts the ticket to Mei Tanaka, an active technician who is not the one the instruction names
- `start_northgate_urgent_queue` 0.333: reads only the first page of queued tickets, so it starts the Northgate ticket on page 1 and misses the two on page 2
- `start_northgate_urgent_queue` 0.333: pages through every page and assigns all three to Samir, but starts only the first one it reaches, leaving two assigned and still queued

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| raise_urgent_priority | easy | 1 | none | ticket | distractors: met; state: met |
| assign_and_start_espresso | medium | 1 | none | ticket | distractors: met; state: met |
| start_northgate_urgent_queue | hard | 3 | ticket | ticket | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Field service equipment repair desk ticketing (Zendesk / Freshdesk-style service desk), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 3.10 | 0.0291 |
| model | 1 | 0.21 | 0.0051 |
| workflow | 1 | 0.36 | 0.0086 |
| seed | 1 | 0.48 | 0.0102 |
| tasks | 1 | 1.76 | 0.0580 |
| Total | 6 | 5.90 | 0.1110 |

Run total: 5.91 minutes, $0.1110.
