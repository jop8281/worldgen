# WorldGen report: Small equipment repair desk (a minimal Fixably/RepairShopr-style repair ticket queue)

## Current world and verification

This report's generation narrative and costs below describe the original Sonnet repair on `654269e`. The current `world.yaml` is the hardened version from stabilization `50dcf10`, with SHA-256 `8b20fded76ad5bec68ec25c3882f1f06ad325aeedc75dded13ecbada2e9e099d`. Its public behavior, fixtures, task instructions and reference solutions are unchanged; the medium and hard graders now allow only the intended ticket fields and each has an additional subject-edit decoy.

On source `b00bab5`, Bun 1.4.2 and Node 22.23.3 each pass all six repair-conformance cases and three task proofs. Both new collateral decoys score 0. Replaying the saved live dataset reproduces all 34 API response status/body values, three complete final states and hashes, three grades of 1 and the exact final replies. No paid calls, VMs or installations were used for this replay.

See `verification-current.json` for current proof. `verification.json` and the generation journal remain historical evidence for the earlier world hash `cbdaf17807d8365daac96ba1712b1267b42106c4e86c9731fa857b8022577f37`. The original dataset retains that historical world version and is not relabeled as a new live run. Full release and fresh Boat/Bun qualification remain open.

## Original generation report

Repair of the existing two-entity repair desk (technician, ticket). Ticket.technician_id becomes readonly to ordinary create and PATCH, so assignment goes only through a new public action POST /tickets/{id}/assign. That action refuses inactive or nonexistent technicians, and refuses tickets that are not queued, with no state change. Valid ticket creation still works: create an unassigned queued ticket, then assign an active technician. Plain and mixed PATCH cannot bypass the readonly field. The frozen clock, seed rows (including historical inactive assignments to Dana Ortiz), pagination, start and close rules, routes and the easy priority-only task are preserved. The medium and hard tasks now use assign then start. Decoys, tests and the documented API are revised to match.

## What was built

Entities (2):

- `technician`: 5 seeded rows
- `ticket`: 32 seeded rows

Routes (6):

- `list_technicians`: GET /technicians
- `get_technician`: GET /technicians/{id}
- `list_tickets`: GET /tickets
- `get_ticket`: GET /tickets/{id}
- `create_ticket`: POST /tickets
- `update_ticket`: PATCH /tickets/{id}

Actions (3):

- `start_ticket`: POST /tickets/{id}/start
- `close_ticket`: POST /tickets/{id}/close
- `assign_ticket`: POST /tickets/{id}/assign

Jobs: none.

## Changes

- field_changed `entities.ticket.fields.technician_id.description`
- field_changed `entities.ticket.fields.technician_id.readonly`
- item_changed `routes.create_ticket.description`
- item_changed `routes.update_ticket.description`
- item_added `actions.assign_ticket`
- item_added `tests.assign_only_queued_tickets`
- item_added `tests.assign_refusals_are_atomic`
- item_added `tests.reassign_dana_queued_ticket`
- item_changed `tests.start_and_close_lifecycle.description`
- snippet_changed `tests.start_and_close_lifecycle.script`
- snippet_changed `tasks.assign_and_start_laptop.decoys.0.script`
- item_changed `tasks.assign_and_start_laptop.decoys.0.why`
- snippet_changed `tasks.assign_and_start_laptop.decoys.1.script`
- item_changed `tasks.assign_and_start_laptop.decoys.1.why`
- snippet_changed `tasks.assign_and_start_laptop.decoys.2.script`
- item_changed `tasks.assign_and_start_laptop.decoys.2.why`
- snippet_changed `tasks.assign_and_start_laptop.solution`
- snippet_changed `tasks.reassign_and_start_dana_queue.decoys.0.script`
- snippet_changed `tasks.reassign_and_start_dana_queue.decoys.1.script`
- item_changed `tasks.reassign_and_start_dana_queue.decoys.1.why`
- snippet_changed `tasks.reassign_and_start_dana_queue.decoys.2.script`
- snippet_changed `tasks.reassign_and_start_dana_queue.decoys.3.script`
- snippet_changed `tasks.reassign_and_start_dana_queue.solution`

## Assumed and why

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

## Left out

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

## Proof

The engine check passed: 5 world tests, 0 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| raise_espresso_priority | easy | 1.000 | 0.000 | 0.000 | n/a |
| assign_and_start_laptop | medium | 1.000 | 0.000 | 0.400, 0.000, 0.000 | 0.400 |
| reassign_and_start_dana_queue | hard | 1.000 | 0.000 | 0.000, 0.000, 0.500, 0.000 | 0.500 |

Decoys:

- `raise_espresso_priority` 0.000: raises every normal-priority Corner Cafe ticket to urgent instead of only the pump ticket
- `assign_and_start_laptop` 0.400: assigns Marco with the assign action but never starts the ticket, leaving it queued
- `assign_and_start_laptop` 0.000: picks the other 'Laptop will not boot' ticket (Birch Law Office) without checking the customer, then assigns and starts it
- `assign_and_start_laptop` 0.000: assigns and starts the right ticket but also edits the Birch Law Office laptop ticket's priority, a collateral change
- `reassign_and_start_dana_queue` 0.000: handles only the first page of Dana's queued tickets and misses the rest
- `reassign_and_start_dana_queue` 0.000: reassigns all of Dana's queued tickets to the wrong technician, Marco Silva, instead of Priya Nair, and starts them
- `reassign_and_start_dana_queue` 0.500: reassigns all of Dana's queued tickets to Priya but never starts them
- `reassign_and_start_dana_queue` 0.000: also starts other queued tickets that already have an active technician, which were not Dana's

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.73 | 0.2587 |
| model | 1 | 0.10 | 0.0768 |
| workflow | 1 | 0.59 | 0.1307 |
| seed | 1 | 0.04 | 0.0840 |
| tasks | 1 | 0.43 | 0.1263 |
| Total | 5 | 1.88 | 0.6765 |

Run total: 1.89 minutes, $0.6765.
