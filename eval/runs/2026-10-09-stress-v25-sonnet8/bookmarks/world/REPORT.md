# WorldGen report: Raindrop.io / Pocket-style multi-user bookmark manager with folders, tags and shareable collections

Users save bookmarks into a nested folder tree, label them with per-user tags, and move them through unread, read, archived and trashed. Trash is purged after 30 days. Collections are private, shared (viewer or editor members) or public with an optional expiry. Actions enforce ownership, permission and folder-cycle rules and write an activity log. Two daily jobs purge old trash and expire public links.

## What was built

Entities (9):

- `user`: 6 seeded rows
- `folder`: 14 seeded rows
- `tag`: 12 seeded rows
- `bookmark`: 60 seeded rows
- `bookmark_tag`: 40 seeded rows
- `collection`: 8 seeded rows
- `collection_member`: 8 seeded rows
- `collection_item`: 24 seeded rows
- `activity`: 40 seeded rows

Routes (16):

- `list_users`: GET /users
- `get_user`: GET /users/{id}
- `create_user`: POST /users
- `list_folders`: GET /folders
- `get_folder`: GET /folders/{id}
- `list_tags`: GET /tags
- `create_tag`: POST /tags
- `list_bookmarks`: GET /bookmarks
- `get_bookmark`: GET /bookmarks/{id}
- `update_bookmark`: PATCH /bookmarks/{id}
- `list_bookmark_tags`: GET /bookmark_tags
- `list_collections`: GET /collections
- `get_collection`: GET /collections/{id}
- `list_collection_members`: GET /collections/{collection_id}/members
- `list_collection_items`: GET /collections/{collection_id}/items
- `list_activity`: GET /activity

Actions (13):

- `create_bookmark`: POST /bookmarks
- `mark_read`: POST /bookmarks/{id}/read
- `archive_bookmark`: POST /bookmarks/{id}/archive
- `trash_bookmark`: POST /bookmarks/{id}/trash
- `restore_bookmark`: POST /bookmarks/{id}/restore
- `move_bookmark`: POST /bookmarks/{id}/move
- `tag_bookmark`: POST /bookmarks/{id}/tags
- `create_folder`: POST /folders
- `move_folder`: POST /folders/{id}/move
- `create_collection`: POST /collections
- `set_collection_visibility`: POST /collections/{id}/visibility
- `share_collection`: POST /collections/{id}/members
- `add_to_collection`: POST /collections/{id}/items

Jobs (2):

- `purge_trash`: every 1d
- `expire_public_links`: every 1d

## Assumed and why

- Every action takes actor_id (a user ref) as input; there is no authentication.
  - Why: The API has no sessions, so ownership and permission rules need an explicit actor.
- Ownership and permission violations answer 409 with code forbidden; invalid state answers 409 invalid_state; folder cycles answer 409 cycle_detected.
  - Why: ctx.fail allows only 400, 404, 409 and 422.
- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded history lies before it, trash ages and expiries are seeded relative to it, and future expiry dates lie after it.
  - Why: Time moves only by explicit advance so jobs and tests are deterministic.
- Both jobs run every 1d; purge_trash deletes trashed bookmarks 30 days or more past trashed_at, and expire_public_links sets public collections with an expiry at or before now back to private and clears the expiry.
  - Why: A daily cadence matches 30-day and expiry granularity.
- Purging deletes the bookmark and its tag links and collection items, and writes an activity row.
  - Why: Trash purge is a hard deletion.
- Collection visibility is a state field with transitions among private, shared and public in all directions.
  - Why: Visibility is a lifecycle the actions move through.
- Editors and owners may add only their own bookmarks to a collection; viewers and non-members may not add.
  - Why: Keeps permission rules simple and testable.
- A tag may be attached only to a bookmark owned by the tag's owner.
  - Why: Tags are per-user.
- Folders have no state machine.
  - Why: Folder workflow is only about tree structure.
- Users are created through the standard create route, not a workflow action.
  - Why: No rules attach to it.

## Questions asked of the input

- How is the acting user identified?
  - Default answer: Each action takes actor_id explicitly.
- Should purging be a hard delete?
  - Default answer: Yes, the bookmark and its links are deleted.
- Can viewers add bookmarks?
  - Default answer: No; only owner and editors, and only their own bookmarks.

## Left out

- Authentication, passwords and sessions
  - Why: Actor is passed explicitly.
- Browser extension, page scraping, link health checks and full-text page content
  - Why: Computation, not records.
- Import/export of bookmark files
  - Why: Not part of the stateful core.
- Public-link anonymous reads
  - Why: No auth model; public is a visibility state only.

## Proof

The engine check passed: 9 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_7bd9391fc03c125246d46a51ed8c10412a7e31337479020c7b2c927dc05ebdf2`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| archive_reading_item | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (2); mutants 5/8 | `tid_15a7bae5e1d896557d07002a8f6b82c510816ccb740a275f434e922c2b68fbf8` |
| restore_wrong_trash | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.500 | n/a | declared (2); mutants 5/8 | `tid_dc09aa00af0f50780da5b4227f6e7e4f16426d9d7ba036596b4d0b419f2a80ca` |
| share_and_fill_collection | hard | 1.000 | 0.000 | 0.200, 0.000, 0.000, 0.600 | 0.600 | declared (5); mutants 6/8 | `tid_a16bc0b7ffe583b3f13aa35693dbc83ef554a642e20b4325db1fa01686c12ee9` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `archive_reading_item` 0.000: archives Ana's near-duplicate bookmark titled '(draft)' instead of the exact title
- `archive_reading_item` 0.000: archives Ben's bookmark with the same title, acting as Ben, instead of Ana's
- `restore_wrong_trash` 0.000: restores Ben's near-duplicate '(old)' bookmark instead of the exact title
- `restore_wrong_trash` 0.000: restores both of Ben's trashed Rust async bookmarks instead of only the exact title
- `restore_wrong_trash` 0.000: restores the same-titled trashed bookmark of another user (Chloe Park) instead of Ben's
- `restore_wrong_trash` 0.500: restores the right bookmark but then also marks it read, so it does not end unread
- `share_and_fill_collection` 0.200: shares correctly but only handles the first page of Ben's unread bookmarks, missing the one on the second page
- `share_and_fill_collection` 0.000: shares Ben as a viewer instead of an editor, so every add is refused
- `share_and_fill_collection` 0.000: adds every bookmark in Ben's Rust folder on all pages, including read and archived ones, ignoring the unread condition
- `share_and_fill_collection` 0.600: shares and adds all unread bookmarks on every page but never marks them read

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| archive_reading_item | easy | 2 | none | bookmark | distractors: met |
| restore_wrong_trash | medium | 2 | none | bookmark | distractors: met; state: met |
| share_and_fill_collection | hard | 47 | bookmark | bookmark, collection | hard: met; paging: met; distractors: met; state: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Raindrop.io / Pocket-style multi-user bookmark manager with folders, tags and shareable collections, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 2.43 | 0.3557 |
| model | 1 | 0.51 | 0.1362 |
| workflow | 1 | 0.89 | 0.1997 |
| seed | 1 | 1.08 | 0.2239 |
| tasks | 1 | 2.50 | 0.3769 |
| Total | 6 | 7.41 | 1.2923 |

Run total: 7.45 minutes, $1.2923.
