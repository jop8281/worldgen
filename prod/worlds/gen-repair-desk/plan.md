# WorldGen plan: Small equipment repair desk (a minimal Fixably/RepairShopr-style repair ticket queue)

Repair of the existing two-entity repair desk (technician, ticket). Ticket.technician_id becomes readonly to ordinary create and PATCH, so assignment goes only through a new public action POST /tickets/{id}/assign. That action refuses inactive or nonexistent technicians, and refuses tickets that are not queued, with no state change. Valid ticket creation still works: create an unassigned queued ticket, then assign an active technician. Plain and mixed PATCH cannot bypass the readonly field. The frozen clock, seed rows (including historical inactive assignments to Dana Ortiz), pagination, start and close rules, routes and the easy priority-only task are preserved. The medium and hard tasks now use assign then start. Decoys, tests and the documented API are revised to match.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-01-05T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `technician` | A repair technician who can be assigned queued tickets. Inactive technicians cannot be assigned new work. Seed contains one inactive technician, Dana Ortiz, who keeps historical assignments. Unchanged. | name, active |
| `ticket` | A repair ticket for a customer's equipment. Status moves queued, active, closed only through start_ticket and close_ticket. technician_id is now readonly to create and PATCH and is set only by the assign_ticket action (and by seed for historical rows). | subject, customer_name, priority, status, technician_id |

## Workflows

### ticket_lifecycle (ticket)
- States: queued, active, closed
- Actions: assign_ticket, start_ticket, close_ticket
- Rules:
  - Tickets are created queued and unassigned. ticket.technician_id is readonly to create and PATCH.
  - assign_ticket sets technician_id on a queued ticket only. The technician must exist and be active, or the call is refused and nothing changes.
  - Plain and mixed PATCH or create bodies containing technician_id are refused atomically, so no sibling field such as priority is written.
  - start_ticket moves queued to active only when the ticket has an assigned technician who is active. Seed rows assigned to inactive Dana therefore cannot start until reassigned.
  - close_ticket moves active to closed. closed is final.
  - Status is changed only by start_ticket and close_ticket. Refused calls change nothing.

## Jobs

None. The plan declares no job.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_technicians` | GET | /technicians | List technicians, filter by active, search by name, page size 10. Unchanged. |
| `get_technician` | GET | /technicians/{id} | Read one technician. Unchanged. |
| `list_tickets` | GET | /tickets | Paginated ticket list (page size 10), filter by status, priority and technician_id, search subject and customer_name. Unchanged. |
| `get_ticket` | GET | /tickets/{id} | Read one ticket. Unchanged. |
| `create_ticket` | POST | /tickets | Create a queued, unassigned ticket from subject, customer_name and priority. technician_id is readonly here, and sending it is refused with nothing created. Assign afterwards with POST /tickets/{id}/assign. |
| `update_ticket` | PATCH | /tickets/{id} | Edit subject, customer_name or priority. technician_id and status are readonly. A body that includes technician_id (alone or mixed with priority) is refused atomically. |
| `assign_ticket` | POST | /tickets/{id}/assign | New public action. Body {technician_id}. Assigns an active technician to a queued ticket and persists it. Refuses unknown ticket (404), nonexistent technician (400/422 or 404), inactive technician (409 technician_inactive) and non-queued ticket (409 invalid_state), changing nothing. |
| `start_ticket` | POST | /tickets/{id}/start | Queued to active. Needs an assigned active technician. Unchanged, and still guards historical inactive assignments. |
| `close_ticket` | POST | /tickets/{id}/close | Active to closed. Closed is final. Unchanged. |

## Seed

- Rows per entity: technician: 5, ticket: 32
- Mix: Unchanged frozen seed. 5 technicians: Dana Ortiz inactive, the other four active. 32 tickets: 4 anchors (queued), 12 queued Dana tickets, 9 active (2 Dana), 7 closed (1 Dana), and 2 more queued anchors from the anchor set, so that more than 10 queued tickets belong to Dana and need pagination at page size 10. Seed writes technician_id directly, so historical inactive assignments (Dana's queued, active and closed tickets) stay exactly as they are. Do not edit the seed snippets.

## Tasks

- `raise_espresso_priority` (easy): Find the leaking espresso machine pump ticket and PATCH its priority to urgent without changing anything else. Unchanged and does not touch assignment.
  - Decoy idea: Raises every normal-priority Corner Cafe ticket to urgent. Unchanged.
- `assign_and_start_laptop` (medium): Find Harbor Dental's queued 'Laptop will not boot' ticket (not Birch Law Office's), assign it to active technician Marco Silva with POST /tickets/{id}/assign, then start it with POST /tickets/{id}/start, so it ends active with Marco assigned and no other row changes. Solution switches from PATCH to the assign action.
  - Decoy idea: Assigns Marco but never starts the ticket. Assigns and starts the Birch Law Office ticket instead. Assigns and starts the right ticket but also changes another row, such as raising its priority, which the collateral guard catches. The old inactive-Dana decoy is dropped: the assign is now refused, so it would leave the seed unchanged and be trivial.
- `reassign_and_start_dana_queue` (hard): Page through every queued ticket assigned to inactive Dana Ortiz (more than 10, so there are two pages). For each one, call the public assign action to give it to active Priya Nair, then start it. Dana's active and closed tickets and every other ticket stay untouched. Solution switches from PATCH to the assign action.
  - Decoy idea: Handles only the first page. Assigns every queued ticket to Marco instead of Priya (wrong target), then starts them. Assigns to Priya but never starts. Also starts other queued tickets that already have an active technician (collateral). Tries to reassign Dana's active and closed tickets too: those assign calls are refused as invalid_state, so that decoy would match the solution and is dropped.

## Open questions

None. The plan asks no open question.

## Assumptions

- REVISED: the old assumption that any existing technician, including an inactive one, can be set on a ticket is dropped. An inactive or nonexistent technician can never be newly assigned, by any public route.
  - Why: The original brief requires inactive assignments to fail atomically at assignment time. Failing only later at start does not meet it.
- ticket.technician_id is readonly: ordinary create and PATCH refuse it, and only the assign_ticket action (and seed) may set it.
  - Why: This is the only way to stop plain PATCH, mixed PATCH and create from bypassing the active-technician check, and seed can still hold historical data.
- Refusals are atomic. A refused create, PATCH or assign writes nothing, so a mixed PATCH {technician_id, priority} leaves priority unchanged, and a refused create makes no row.
  - Why: The brief requires invalid assignments to fail atomically.
- assign_ticket is allowed only on queued tickets. Active and closed tickets answer 409 invalid_state. Re-assigning a queued ticket to the same or another active technician succeeds.
  - Why: This keeps start and close rules and the closed-is-final rule intact, and the hard task only needs reassigning queued tickets.
- Error codes: 404 not_found for an unknown ticket, 409 technician_inactive for an inactive technician, 409 invalid_state for a non-queued ticket, and a 4xx (input or unknown technician) for a nonexistent technician. A refused readonly field is the engine's standard 4xx.
  - Why: This follows the conventions of the existing world and the example world, and tests assert 4xx plus unchanged state.
- start_ticket keeps its technician_inactive and no_technician checks, and its handler is not changed.
  - Why: Seed-time historical assignments to inactive Dana still exist, so start must keep guarding them. The preserved start rules are unchanged.
- New tickets are created unassigned and queued. The documented path for a ticket with a technician is create, then assign, then start.
  - Why: The brief says valid ticket creation must stay available, while technician_id is readonly on create.
- The easy task keeps its instruction, grader, solution and decoy, because it only PATCHes priority. The medium and hard tasks keep their instructions, intents and difficulty, and their solutions and decoys use POST /tickets/{id}/assign then start. Exactly three tasks remain.
  - Why: The brief asks to keep the easy task working, make medium and hard use the public assign action, and keep exactly three discriminating tasks.
- The seed, fixtures, clock (start 2026-01-05T09:00:00.000Z, tick 0s), page sizes and unrelated fields are untouched. No jobs are added.
  - Why: This is a repair, not a redesign.

## Out of scope

- Unassigning a technician (setting technician_id to null) or reassigning active or closed tickets
  - Why: Not requested. assign_ticket is for queued tickets only, so start and close rules stay as they are.
- Creating, editing or deactivating technicians through the API
  - Why: The technician entity keeps its read-only routes and is not part of the repair.
- Changing the seed rows, fixtures, clock or page sizes
  - Why: The request requires them to be preserved, including historical inactive assignments.
- Changing start_ticket or close_ticket behaviour
  - Why: The request requires the start and close rules to be preserved.
- Adding or removing tasks
  - Why: The world must keep exactly three discriminating tasks, one each of easy, medium and hard.
- Jobs, notifications, audit events and technician workload limits
  - Why: Not part of the original requirement.

## Changes

- ticket.fields.technician_id
- routes.create_ticket
- routes.update_ticket
- tests.start_and_close_lifecycle
- tasks.assign_and_start_laptop
- tasks.reassign_and_start_dana_queue
