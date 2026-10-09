# WorldGen report: Pocket/Raindrop.io-style multi-user bookmark manager with folders, tags and shareable collections

Users save bookmarks into a nested folder tree and label them with per-user tags. Bookmarks move through unread, read, archived and trashed, and trash is purged after 30 days. Collections are private, shared with viewer/editor members, or public with an optional expiry. Actions enforce ownership, permission and folder-cycle rules and write an activity log. Two jobs purge old trash and expire public links.

## What was built

Entities (9):

- `user`: 6 seeded rows
- `folder`: 16 seeded rows
- `bookmark`: 60 seeded rows
- `tag`: 12 seeded rows
- `bookmark_tag`: 40 seeded rows
- `collection`: 8 seeded rows
- `collection_member`: 10 seeded rows
- `collection_item`: 20 seeded rows
- `activity`: 40 seeded rows

Routes (17):

- `list_users`: GET /users
- `get_user`: GET /users/{id}
- `create_user`: POST /users
- `list_folders`: GET /folders
- `get_folder`: GET /folders/{id}
- `list_bookmarks`: GET /bookmarks
- `get_bookmark`: GET /bookmarks/{id}
- `update_bookmark`: PATCH /bookmarks/{id}
- `list_tags`: GET /tags
- `get_tag`: GET /tags/{id}
- `create_tag`: POST /tags
- `list_bookmark_tags`: GET /bookmark_tags
- `list_collections`: GET /collections
- `get_collection`: GET /collections/{id}
- `list_collection_members`: GET /collections/{collection_id}/members
- `list_collection_items`: GET /collections/{collection_id}/items
- `list_activity`: GET /activity

Actions (14):

- `create_bookmark`: POST /bookmarks
- `mark_read`: POST /bookmarks/{id}/read
- `archive_bookmark`: POST /bookmarks/{id}/archive
- `trash_bookmark`: POST /bookmarks/{id}/trash
- `restore_bookmark`: POST /bookmarks/{id}/restore
- `move_bookmark`: POST /bookmarks/{id}/move
- `tag_bookmark`: POST /bookmarks/{id}/tag
- `create_folder`: POST /folders
- `move_folder`: POST /folders/{id}/move
- `create_collection`: POST /collections
- `add_collection_member`: POST /collections/{id}/add_member
- `add_collection_item`: POST /collections/{id}/add_item
- `make_public`: POST /collections/{id}/make_public
- `make_private`: POST /collections/{id}/make_private

Jobs (2):

- `purge_trash`: every 1d
- `expire_public_links`: every 1h

## Assumed and why

- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded history precedes it, public expiries seeded after it.
  - Why: Deterministic time; jobs run only on explicit advance.
- Acting user is passed as actor_id in each action body; there is no authentication.
  - Why: The world has no sessions; ownership and permission rules need an explicit actor.
- Permission failures use 409 with codes not_owner, permission_denied, tag_not_owned; state errors use 409 invalid_state.
  - Why: ctx.fail only allows 400/404/409/422.
- Actions create bookmarks, folders, collections, members, items and tag links (201); users and tags use standard create routes.
  - Why: Rules and activity logging must not be bypassable.
- Restore moves a trashed bookmark to unread; mark_read only from unread.
  - Why: Original read state is not retained.
- Expired public collections revert to shared if they have members, otherwise private.
  - Why: Preserves existing member access.
- Folder workflow is descriptive with a single active state.
  - Why: Folders have no state field.
- Purge deletes the bookmark, cascades its collection items and nullifies activity.bookmark_id.
  - Why: Keeps the audit log without dangling refs.

## Questions asked of the input

- Can a bookmark be in several collections?
  - Default answer: Yes, once per collection.
- Do viewers see private bookmarks of others?
  - Default answer: Out of scope; access is only enforced on adding items and members.
- Should purge also keep trashed bookmarks' tag links?
  - Default answer: Tag links are removed with the bookmark (cascade).

## Left out

- Authentication, sessions and API tokens
  - Why: The actor is passed explicitly; auth is not the core value.
- Fetching page metadata, screenshots or full-text search of page content
  - Why: Computation, not stateful records.
- Import/export of bookmark files and browser extensions
  - Why: Not needed for the record workflows.

## Proof

The engine check passed: 9 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_87f764dcdf5a0f61c27251c966687bc4da4fe3dfff7a711e3e943003b115a931`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| archive_dana_rust_bookmark | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (2); mutants 5/8 | `tid_a35eb37df5aae90b8e94d320f35ae494694388baa3ef297785f14a613d1942fa` |
| add_leo_bookmark_to_team_reading | medium | 1.000 | 0.000 | 0.500, 0.500, 0.000 | 0.500 | declared (4); mutants 5/8 | `tid_2d0e413aecc75d88f08956c29809774a944dc0f78e99f231de3f372a0324c2d5` |
| reorganize_recipes_and_trash_archived | hard | 1.000 | 0.000 | 0.625, 0.750, 0.000, 0.000 | 0.813 | declared (4); mutants 5/8 | `tid_012d1209aaeb3a0c0d000903c1a2afd5f90e8d84dd84b7bb0fce0193e68d8089` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `archive_dana_rust_bookmark` 0.000: archives Dana's already-read bookmark with the same title instead of the unread one
- `archive_dana_rust_bookmark` 0.000: archives the unread bookmark with the same title that belongs to another user (Tom Reyes)
- `add_leo_bookmark_to_team_reading` 0.500: adds Leo's bookmark to the collection but forgets to mark it as read
- `add_leo_bookmark_to_team_reading` 0.500: marks Leo's bookmark as read but never adds it to the collection
- `add_leo_bookmark_to_team_reading` 0.000: acts as the collection owner Maya and adds her own same-titled bookmark instead of Leo's
- `reorganize_recipes_and_trash_archived` 0.625: moves the folder correctly but reads only the first page of bookmarks, so it misses archived Recipes bookmarks on later pages
- `reorganize_recipes_and_trash_archived` 0.750: trashes the right bookmarks across all pages but moves Recipes under Sam's Work folder instead of Home
- `reorganize_recipes_and_trash_archived` 0.000: trashes every archived bookmark of Sam in any folder, not only those in Recipes
- `reorganize_recipes_and_trash_archived` 0.000: trashes the read bookmarks in Recipes as well as the archived ones

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| archive_dana_rust_bookmark | easy | 2 | none | bookmark | distractors: met; state: met |
| add_leo_bookmark_to_team_reading | medium | 4 | none | bookmark | distractors: met; state: met |
| reorganize_recipes_and_trash_archived | hard | 10 | bookmark | folder | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Pocket/Raindrop.io-style multi-user bookmark manager with folders, tags and shareable collections, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 3.37 | 0.4714 |
| model | 1 | 0.52 | 0.1561 |
| workflow | 1 | 0.80 | 0.2130 |
| seed | 1 | 1.36 | 0.2557 |
| tasks | 1 | 2.27 | 0.3913 |
| Total | 6 | 8.32 | 1.4876 |

Run total: 8.35 minutes, $1.4876.
