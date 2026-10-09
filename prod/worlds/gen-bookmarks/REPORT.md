# WorldGen report: Raindrop.io / Pocket-style bookmark manager (bookmarks, nested folders, tags, shared collections)

A multi-user bookmark manager. Users save bookmarks into a nested folder tree and label them with per-user tags. Each bookmark moves through unread, read, archived and trashed, and trash is purged after 30 days. Users group bookmarks into collections that are private, shared with members as viewer or editor, or public with an optional expiry. Actions enforce ownership, permission and cycle rules and write an activity log. Two jobs purge old trash and expire public links.

## What was built

Entities (9):

- `user`: 6 seeded rows
- `folder`: 18 seeded rows
- `bookmark`: 60 seeded rows
- `tag`: 24 seeded rows
- `bookmark_tag`: 100 seeded rows
- `collection`: 8 seeded rows
- `collection_member`: 7 seeded rows
- `collection_item`: 30 seeded rows
- `activity`: 70 seeded rows

Routes (26):

- `list_users`: GET /users
- `get_user`: GET /users/{id}
- `create_user`: POST /users
- `list_folders`: GET /folders
- `get_folder`: GET /folders/{id}
- `create_folder`: POST /folders
- `update_folder`: PATCH /folders/{id}
- `delete_folder`: DELETE /folders/{id}
- `list_bookmarks`: GET /bookmarks
- `get_bookmark`: GET /bookmarks/{id}
- `create_bookmark`: POST /bookmarks
- `update_bookmark`: PATCH /bookmarks/{id}
- `list_tags`: GET /tags
- `get_tag`: GET /tags/{id}
- `update_tag`: PATCH /tags/{id}
- `delete_tag`: DELETE /tags/{id}
- `list_bookmark_tags`: GET /bookmark_tags
- `list_collections`: GET /collections
- `get_collection`: GET /collections/{id}
- `create_collection`: POST /collections
- `update_collection`: PATCH /collections/{id}
- `delete_collection`: DELETE /collections/{id}
- `list_collection_members`: GET /collection_members
- `list_collection_items`: GET /collection_items
- `delete_collection_item`: DELETE /collection_items/{id}
- `list_activity`: GET /activity

Actions (14):

- `mark_read`: POST /bookmarks/{id}/read
- `archive_bookmark`: POST /bookmarks/{id}/archive
- `trash_bookmark`: POST /bookmarks/{id}/trash
- `restore_bookmark`: POST /bookmarks/{id}/restore
- `move_bookmark`: POST /bookmarks/{id}/move
- `tag_bookmark`: POST /bookmarks/{id}/tag
- `untag_bookmark`: POST /bookmarks/{id}/untag
- `merge_tags`: POST /tags/{id}/merge
- `move_folder`: POST /folders/{id}/move
- `share_collection`: POST /collections/{id}/share
- `unshare_collection`: POST /collections/{id}/unshare
- `publish_collection`: POST /collections/{id}/publish
- `unpublish_collection`: POST /collections/{id}/unpublish
- `add_bookmark_to_collection`: POST /collections/{id}/add_bookmark

Jobs (2):

- `purge_trash`: every 1d
- `expire_public_shares`: every 1h

## Changes

No changes.

## Assumed and why

- clock.start is 2026-10-06T09:00:00.000Z and tick is 0s.
  - Why: All seed history (created_at, read_at, trashed_at) falls before the start. Future events are limited to a public collection's share_expires_at. Tick 0s keeps timestamps exact, so tests can compare read_at, trashed_at and share_expires_at with ctx.now(). Time moves only through advance in tests.
- There is no authentication. Actions that need a permission check take an explicit actor_id (user ref). Single-owner actions use the bookmark's or tag's owner.
  - Why: The API has no session concept. An explicit actor makes the permission rules testable.
- Permission failures return 409 not_permitted, not 403.
  - Why: The engine's ctx.fail allows only 400, 404, 409 and 422.
- status, read_at, trashed_at, parent_id, visibility, share_expires_at, tag name and all collection_member and collection_item fields are readonly. Actions, jobs and seed set them.
  - Why: This forces agents through the actions that hold the business rules, which the tasks and decoys grade on.
- Tags are unique per (owner, lowercase name), enforced by tag_bookmark. A tag has no create route.
  - Why: The engine has no composite unique key. A single find-or-create path keeps the rule.
- A folder is created at the root only and nested through move_folder.
  - Why: This keeps cycle detection in one place.
- Trashing a bookmark keeps its tags and collection items. They are removed only when the purge job deletes the bookmark after 30 days.
  - Why: This mirrors a recoverable trash. Restore brings the bookmark back intact.
- restore_bookmark always returns the bookmark to unread, whether it was archived or trashed.
  - Why: This keeps the state machine small. The previous state is not stored.
- Standard PATCH on bookmark may change folder_id and owner_id. move_bookmark is the validated path.
  - Why: The engine cannot make a field writable on create but not on update.
- Editors may add only their own bookmarks to a collection. Viewers and outsiders cannot add any.
  - Why: This matches the shared-collection behavior of mainstream bookmark apps.
- delete_collection_item removes an item with no permission check.
  - Why: Item removal is a plain REST delete for simplicity. Permission rules are covered on add.
- Bookmark url duplicates are allowed.
  - Why: Real apps warn but permit them, and it keeps create a plain route.
- List pages hold 25 rows, with cursor paging from the world defaults. The seed has 60 bookmarks, so list_bookmarks spans 3 pages.
  - Why: Paging must matter to the main entity.

## Questions asked of the input

- Should the API authenticate users, with per-request identity?
  - Default answer: No. Callers pass user ids explicitly (owner_id, actor_id).
- Should the world crawl pages to fetch titles, favicons or link health?
  - Default answer: No. link_status is plain data, seeded and editable by PATCH. There is no crawler.
- Can a bookmark be in more than one folder?
  - Default answer: No. A bookmark has at most one folder, like Raindrop collections, and tags give the many-to-many labeling.
- Should trash be purged automatically, and after how long?
  - Default answer: Yes. A daily job deletes bookmarks trashed 30 or more days ago.
- Can public links expire?
  - Default answer: Yes. publish_collection takes an optional expires_in_days, and an hourly job reverts expired collections.
- Are imports, exports and a browser extension in scope?
  - Default answer: No. The world covers only the stateful records and actions.
- Do collaborators have more roles than viewer and editor?
  - Default answer: No. The owner is implicit and the only other roles are viewer and editor.
- Can tags be shared between users?
  - Default answer: No. Tags are per owner. merge_tags refuses cross-owner merges.

## Left out

- Page crawling, snapshots, permanent copies, favicons and automatic link checking
  - Why: This is computation over external web content, not stateful records. link_status is plain data.
- Authentication, sessions, API tokens and rate limits
  - Why: Identity is explicit input. Auth adds no stateful workflow to test.
- Import and export (HTML, CSV), browser extension and share-by-email invitations
  - Why: File and client features with no record workflow.
- Highlights, annotations, reminders and comments
  - Why: Extra entities that do not add distinct rules beyond the core.
- Full-text search of page content
  - Why: Search covers title, url and description only.

## Proof

The engine check passed: 11 world tests, 3 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_bdd0ffb7cd3a2ebee7c996187924407585da905902a7203d6964c2e014b8ee5d`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| mark_postgres_article_read | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | legacy; mutants 7/8 | `tid_f3a8dc159156be956014bd98c22723d638b612c97120cabe512c0fabbe62907f` |
| merge_maya_ml_tags | medium | 1.000 | 0.000 | 0.400, 0.000, 0.000, 0.600, 0.000 | n/a | legacy; mutants 6/8 | `tid_b83475eb15d495c39933854bac4ea71b4968b0897c8a41ddfda220486a312011` |
| trash_maya_broken_links | hard | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.500 | 0.750 | legacy; mutants 7/8 | `tid_5e9cb85d4a5a62cc3381b48ffd03792b625019e33dd236f1c29f344f083e76e2` |
| share_maya_big_private_collections | hard | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.000, 0.500 | 0.500 | legacy; mutants 7/8 | `tid_896b1ba807a11b136f163acb40726b404390d5a71327e3875b2893063c335532` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `mark_postgres_article_read` 0.000: marks the same-titled bookmark owned by Dev Patel as read instead of Maya's
- `mark_postgres_article_read` 0.000: archives Maya's bookmark instead of marking it read
- `merge_maya_ml_tags` 0.400: deletes Maya's ml tag outright, so bookmarks that only had ml lose their label instead of gaining machine-learning
- `merge_maya_ml_tags` 0.000: merges in the wrong direction, folding machine-learning into ml and deleting machine-learning
- `merge_maya_ml_tags` 0.000: merges ml into the wrong tag of Maya's, postgres
- `merge_maya_ml_tags` 0.600: re-tags every ml bookmark with machine-learning but leaves the ml tag in place
- `merge_maya_ml_tags` 0.000: merges correctly, then also recolors the machine-learning tag, an unrequested edit
- `trash_maya_broken_links` 0.000: also trashes Maya's archived broken bookmarks, treating archived as in scope
- `trash_maya_broken_links` 0.000: drops the owner filter and trashes every user's unread or read broken bookmark
- `trash_maya_broken_links` 0.000: archives the broken bookmarks instead of trashing them
- `trash_maya_broken_links` 0.500: only looks at unread bookmarks and misses the broken ones that are already read
- `share_maya_big_private_collections` 0.000: shares every private collection regardless of size, including the one with only 2 bookmarks
- `share_maya_big_private_collections` 0.000: gives Dev the viewer role instead of editor
- `share_maya_big_private_collections` 0.000: shares all of Maya's collections including the one that is already shared with others
- `share_maya_big_private_collections` 0.000: publishes the large private collections instead of sharing them with Dev
- `share_maya_big_private_collections` 0.500: uses a threshold of more than 3 bookmarks, so it shares only the biggest private collection and misses the one with exactly 3

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| mark_postgres_article_read | easy | 2 | none | bookmark | none declared |
| merge_maya_ml_tags | medium | 14 | none | tag | none declared |
| trash_maya_broken_links | hard | 8 | none | bookmark | hard: met |
| share_maya_big_private_collections | hard | 6 | none | collection | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $2.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.13 | 0.1071 |
| Total | 1 | 0.13 | 0.1071 |

Skipped:

- `model`: no planned change reaches entities, routes, fixtures
- `workflow`: no planned change reaches actions, jobs, entities, routes, tests
- `seed`: no planned change reaches seed, entities, fixtures; it keeps 1 issue(s) the world had before this iterate: plan.seed_rows_short
- `tasks`: no planned change reaches tasks, entities, routes, actions, jobs, seed

Run total: 0.22 minutes, $0.1071.
