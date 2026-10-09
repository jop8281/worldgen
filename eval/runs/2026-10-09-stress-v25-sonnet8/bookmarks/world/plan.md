# WorldGen plan: Raindrop.io / Pocket-style multi-user bookmark manager with folders, tags and shareable collections

Users save bookmarks into a nested folder tree, label them with per-user tags, and move them through unread, read, archived and trashed. Trash is purged after 30 days. Collections are private, shared (viewer or editor members) or public with an optional expiry. Actions enforce ownership, permission and folder-cycle rules and write an activity log. Two daily jobs purge old trash and expire public links.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `user` | Account that owns bookmarks, folders, tags and collections. | name, email |
| `folder` | Node in a user's nested folder tree; parent_id is null for a root folder. | owner_id, name, parent_id |
| `tag` | Per-user label. | owner_id, name |
| `bookmark` | Saved URL with a status state machine, optional folder and trashed_at. | owner_id, url, title, folder_id, status, trashed_at |
| `bookmark_tag` | Join row linking a bookmark to a tag. | bookmark_id, tag_id |
| `collection` | Group of bookmarks with visibility state private, shared or public and an optional public expiry. | owner_id, name, visibility, public_expires_at |
| `collection_member` | Membership of a user in a shared collection as viewer or editor. | collection_id, user_id, role |
| `collection_item` | Bookmark placed in a collection by a user. | collection_id, bookmark_id, added_by |
| `activity` | Activity log row written by every action and job. | actor_id, action, subject_type, subject_id |

## Workflows

### bookmark_lifecycle (bookmark)
- States: unread, read, archived, trashed
- Actions: create_bookmark, mark_read, archive_bookmark, trash_bookmark, restore_bookmark, move_bookmark, tag_bookmark
- Rules:
  - Bookmark status starts unread and follows declared transitions; a trashed bookmark can only return to unread. Enforced by the data model: The bookmark status state machine enforces the initial state and allowed transitions.
  - Only the owner may change, trash, move or tag a bookmark; others get 409 forbidden. Enforced by: trash_bookmark. Tested by: t_owner_only
  - A trashed bookmark can only be restored (to unread, clearing trashed_at); other status actions on it answer 409 invalid_state, and restoring a non-trashed bookmark answers 409 invalid_state. Enforced by: restore_bookmark. Tested by: t_restore_rules
  - Trashed bookmarks 30 days or more past trashed_at are purged by a daily job; younger ones stay. Enforced by: purge_trash. Tested by: t_purge
  - Every action writes an activity row with actor, action name, subject type and subject id. Enforced by: archive_bookmark. Tested by: t_activity
  - A tag can be attached only by its owner to a bookmark of the same owner, once per pair. Enforced by: tag_bookmark. Tested by: t_tag
### folder_tree (folder)
- States: none
- Actions: create_folder, move_folder
- Rules:
  - A folder cannot be moved into itself or any of its descendants (409 cycle_detected), and only the owner may move it into a folder they own. Enforced by: move_folder. Tested by: t_cycle
### collection_sharing (collection)
- States: private, shared, public
- Actions: create_collection, set_collection_visibility, share_collection, add_to_collection
- Rules:
  - Only the collection owner or an editor member may add bookmarks, and only the actor's own bookmarks; viewers and non-members get 409 forbidden. Enforced by: add_to_collection. Tested by: t_permission
  - A public collection with an expiry at or before now is set back to private by a daily job; its expiry is cleared. Enforced by: expire_public_links. Tested by: t_expire

## Jobs

- `purge_trash` runs every 1d: Delete bookmarks with status trashed whose trashed_at is 30 days or more before now, along with their tag links and collection items, and log activity.
- `expire_public_links` runs every 1d: Set public collections whose public_expires_at is at or before now to private, clear public_expires_at, and log activity.

## Acceptance tests

### t_owner_only
- Intent: Only the owner can trash a bookmark.
- Actions: create_bookmark, trash_bookmark
- Description: A non-owner trash attempt is refused with 409 forbidden and changes nothing; the owner's succeeds and stamps trashed_at.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: n, email: n.toLowerCase() + '@owner.test.invalid' }).body.id;
  const a = mk('OwnerA'); const b = mk('OwnerB');
  const bm = ctx.api('POST', '/bookmarks', { actor_id: a, url: 'https://example.com/owner-test', title: 'Owner test' });
  ctx.assert(bm.status === 201, 'create ' + JSON.stringify(bm.body));
  const bad = ctx.api('POST', '/bookmarks/' + bm.body.id + '/trash', { actor_id: b });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'forbidden', 'non-owner ' + JSON.stringify(bad.body));
  ctx.assert(ctx.api('GET', '/bookmarks/' + bm.body.id).body.status === 'unread', 'still unread');
  const ok = ctx.api('POST', '/bookmarks/' + bm.body.id + '/trash', { actor_id: a });
  ctx.assert(ok.status === 200 && ok.body.status === 'trashed' && ok.body.trashed_at, 'owner trash ' + JSON.stringify(ok.body));
}
```
### t_restore_rules
- Intent: Trashed bookmarks can only be restored.
- Actions: create_bookmark, trash_bookmark, restore_bookmark, archive_bookmark
- Description: Archive on a trashed bookmark and restore on a live one answer 409 invalid_state; restore returns unread and clears trashed_at.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'RestoreU', email: 'restore@restore.test.invalid' }).body.id;
  const bm = ctx.api('POST', '/bookmarks', { actor_id: u, url: 'https://example.com/restore', title: 'Restore test' }).body;
  const early = ctx.api('POST', '/bookmarks/' + bm.id + '/restore', { actor_id: u });
  ctx.assert(early.status === 409 && early.body.error.code === 'invalid_state', 'restore live ' + JSON.stringify(early.body));
  ctx.assert(ctx.api('POST', '/bookmarks/' + bm.id + '/trash', { actor_id: u }).status === 200, 'trash');
  const arch = ctx.api('POST', '/bookmarks/' + bm.id + '/archive', { actor_id: u });
  ctx.assert(arch.status === 409 && arch.body.error.code === 'invalid_state', 'archive trashed ' + JSON.stringify(arch.body));
  const r = ctx.api('POST', '/bookmarks/' + bm.id + '/restore', { actor_id: u });
  ctx.assert(r.status === 200 && r.body.status === 'unread' && r.body.trashed_at === null, 'restore ' + JSON.stringify(r.body));
}
```
### t_purge
- Intent: Daily job purges trash older than 30 days only.
- Actions: create_bookmark, trash_bookmark
- Description: After 29 days the trashed bookmark remains; after 31 it is gone (404 row.not_found); an untrashed bookmark stays.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'PurgeU', email: 'purge@purge.test.invalid' }).body.id;
  const keep = ctx.api('POST', '/bookmarks', { actor_id: u, url: 'https://example.com/keep', title: 'Keep' }).body;
  const gone = ctx.api('POST', '/bookmarks', { actor_id: u, url: 'https://example.com/gone', title: 'Gone' }).body;
  ctx.assert(ctx.api('POST', '/bookmarks/' + gone.id + '/trash', { actor_id: u }).status === 200, 'trash');
  const r1 = ctx.advance('29d');
  ctx.assert(r1.jobsFailed.length === 0, 'job failed');
  ctx.assert(ctx.api('GET', '/bookmarks/' + gone.id).status === 200, 'still present at 29d');
  const r2 = ctx.advance('2d');
  ctx.assert(r2.jobsFired.includes('purge_trash') || r1.jobsFired.includes('purge_trash'), 'job fired');
  const g = ctx.api('GET', '/bookmarks/' + gone.id);
  ctx.assert(g.status === 404 && g.body.error.code === 'row.not_found', 'purged ' + JSON.stringify(g.body));
  ctx.assert(ctx.api('GET', '/bookmarks/' + keep.id).status === 200, 'untrashed stays');
}
```
### t_activity
- Intent: Actions write an activity log row.
- Actions: create_bookmark, archive_bookmark
- Description: Archiving a bookmark creates an activity row for the actor naming the action and the bookmark.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'ActivityU', email: 'activity@activity.test.invalid' }).body.id;
  const bm = ctx.api('POST', '/bookmarks', { actor_id: u, url: 'https://example.com/act', title: 'Activity test' }).body;
  const ar = ctx.api('POST', '/bookmarks/' + bm.id + '/archive', { actor_id: u });
  ctx.assert(ar.status === 200 && ar.body.status === 'archived', 'archive ' + JSON.stringify(ar.body));
  const log = ctx.api('GET', '/activity?subject_id=' + bm.id).body.data;
  const hit = log.find((x) => x.action === 'archive_bookmark');
  ctx.assert(hit && hit.actor_id === u && hit.subject_type === 'bookmark', 'activity row ' + JSON.stringify(log));
}
```
### t_tag
- Intent: Tags are per-user.
- Actions: create_bookmark, tag_bookmark
- Description: A user can tag their bookmark with their tag once; another user's tag is refused with 409 forbidden and a duplicate with 409 duplicate_tag.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: n, email: n.toLowerCase() + '@tag.test.invalid' }).body.id;
  const a = mk('TagA'); const b = mk('TagB');
  const ta = ctx.api('POST', '/tags', { owner_id: a, name: 'tag-a-only' }).body;
  const tb = ctx.api('POST', '/tags', { owner_id: b, name: 'tag-b-only' }).body;
  const bm = ctx.api('POST', '/bookmarks', { actor_id: a, url: 'https://example.com/tag', title: 'Tag test' }).body;
  const ok = ctx.api('POST', '/bookmarks/' + bm.id + '/tags', { actor_id: a, tag_id: ta.id });
  ctx.assert(ok.status === 201 || ok.status === 200, 'tag ' + JSON.stringify(ok.body));
  const other = ctx.api('POST', '/bookmarks/' + bm.id + '/tags', { actor_id: a, tag_id: tb.id });
  ctx.assert(other.status === 409 && other.body.error.code === 'forbidden', 'foreign tag ' + JSON.stringify(other.body));
  const dup = ctx.api('POST', '/bookmarks/' + bm.id + '/tags', { actor_id: a, tag_id: ta.id });
  ctx.assert(dup.status === 409 && dup.body.error.code === 'duplicate_tag', 'duplicate ' + JSON.stringify(dup.body));
  ctx.assert(ctx.api('GET', '/bookmark_tags?bookmark_id=' + bm.id).body.data.length === 1, 'one link');
}
```
### t_read_move
- Intent: A bookmark can be marked read and moved into a folder by its owner.
- Actions: create_bookmark, create_folder, mark_read, move_bookmark
- Description: Owner marks a bookmark read and moves it into a folder; a non-owner move is refused with 409 forbidden and the folder is unchanged.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: n, email: n.toLowerCase() + '@readmove.test.invalid' }).body.id;
  const a = mk('RmA'); const b = mk('RmB');
  const f = ctx.api('POST', '/folders', { actor_id: a, name: 'RmFolder' });
  ctx.assert(f.status === 201, 'folder ' + JSON.stringify(f.body));
  const bm = ctx.api('POST', '/bookmarks', { actor_id: a, url: 'https://example.com/readmove', title: 'Read move' }).body;
  const rd = ctx.api('POST', '/bookmarks/' + bm.id + '/read', { actor_id: a });
  ctx.assert(rd.status === 200 && rd.body.status === 'read', 'read ' + JSON.stringify(rd.body));
  const bad = ctx.api('POST', '/bookmarks/' + bm.id + '/move', { actor_id: b, folder_id: f.body.id });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'forbidden', 'non-owner move ' + JSON.stringify(bad.body));
  ctx.assert(ctx.api('GET', '/bookmarks/' + bm.id).body.folder_id === null, 'folder unchanged');
  const mv = ctx.api('POST', '/bookmarks/' + bm.id + '/move', { actor_id: a, folder_id: f.body.id });
  ctx.assert(mv.status === 200 && mv.body.folder_id === f.body.id, 'move ' + JSON.stringify(mv.body));
}
```
### t_cycle
- Intent: Folder moves cannot create cycles.
- Actions: create_folder, move_folder
- Description: Moving a folder into itself or a descendant answers 409 cycle_detected; moving to root or a sibling works; another user's folder is refused.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: n, email: n.toLowerCase() + '@cycle.test.invalid' }).body.id;
  const u = mk('CycleU'); const o = mk('CycleO');
  const a = ctx.api('POST', '/folders', { actor_id: u, name: 'A' });
  ctx.assert(a.status === 201, 'create A ' + JSON.stringify(a.body));
  const b = ctx.api('POST', '/folders', { actor_id: u, name: 'B', parent_id: a.body.id }).body;
  const c = ctx.api('POST', '/folders', { actor_id: u, name: 'C', parent_id: b.id }).body;
  const self = ctx.api('POST', '/folders/' + a.body.id + '/move', { actor_id: u, parent_id: a.body.id });
  ctx.assert(self.status === 409 && self.body.error.code === 'cycle_detected', 'self ' + JSON.stringify(self.body));
  const deep = ctx.api('POST', '/folders/' + a.body.id + '/move', { actor_id: u, parent_id: c.id });
  ctx.assert(deep.status === 409 && deep.body.error.code === 'cycle_detected', 'descendant ' + JSON.stringify(deep.body));
  const root = ctx.api('POST', '/folders/' + c.id + '/move', { actor_id: u, parent_id: null });
  ctx.assert(root.status === 200 && root.body.parent_id === null, 'to root ' + JSON.stringify(root.body));
  const of = ctx.api('POST', '/folders', { actor_id: o, name: 'Other' }).body;
  const foreign = ctx.api('POST', '/folders/' + b.id + '/move', { actor_id: u, parent_id: of.id });
  ctx.assert(foreign.status === 409 && foreign.body.error.code === 'forbidden', 'foreign ' + JSON.stringify(foreign.body));
}
```
### t_permission
- Intent: Only owner or editor can add bookmarks to a collection.
- Actions: create_bookmark, create_collection, set_collection_visibility, share_collection, add_to_collection
- Description: Viewers and outsiders are refused with 409 forbidden; editor and owner succeed; sharing makes a private collection shared.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: n, email: n.toLowerCase() + '@perm.test.invalid' }).body.id;
  const o = mk('PermOwner'); const v = mk('PermViewer'); const e = mk('PermEditor'); const x = mk('PermOutsider');
  const bk = (u, n) => ctx.api('POST', '/bookmarks', { actor_id: u, url: 'https://example.com/perm-' + n, title: 'Perm ' + n }).body;
  const col = ctx.api('POST', '/collections', { actor_id: o, name: 'Perm collection' });
  ctx.assert(col.status === 201 && col.body.visibility === 'private', 'create ' + JSON.stringify(col.body));
  const s1 = ctx.api('POST', '/collections/' + col.body.id + '/members', { actor_id: o, user_id: v, role: 'viewer' });
  ctx.assert(s1.status === 201 || s1.status === 200, 'share viewer ' + JSON.stringify(s1.body));
  ctx.assert(ctx.api('POST', '/collections/' + col.body.id + '/members', { actor_id: o, user_id: e, role: 'editor' }).status < 300, 'share editor');
  ctx.assert(ctx.api('GET', '/collections/' + col.body.id).body.visibility === 'shared', 'now shared');
  const add = (u, b) => ctx.api('POST', '/collections/' + col.body.id + '/items', { actor_id: u, bookmark_id: b.id });
  const rv = add(v, bk(v, 'v'));
  ctx.assert(rv.status === 409 && rv.body.error.code === 'forbidden', 'viewer ' + JSON.stringify(rv.body));
  const rx = add(x, bk(x, 'x'));
  ctx.assert(rx.status === 409 && rx.body.error.code === 'forbidden', 'outsider ' + JSON.stringify(rx.body));
  const re = add(e, bk(e, 'e'));
  ctx.assert(re.status === 201, 'editor ' + JSON.stringify(re.body));
  const ro = add(o, bk(o, 'o'));
  ctx.assert(ro.status === 201, 'owner ' + JSON.stringify(ro.body));
  ctx.assert(ctx.api('GET', '/collections/' + col.body.id + '/items').body.data.length === 2, 'two items');
}
```
### t_expire
- Intent: Public links expire.
- Actions: create_collection, set_collection_visibility
- Description: A public collection with an expiry becomes private with cleared expiry after the daily job passes it; one without expiry stays public; a past expiry is refused.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'ExpireU', email: 'expire@expire.test.invalid' }).body.id;
  const now = ctx.now();
  const later = (Number(now.slice(0, 4)) + 1) + now.slice(4);
  const c1 = ctx.api('POST', '/collections', { actor_id: u, name: 'Expiring' }).body;
  const c2 = ctx.api('POST', '/collections', { actor_id: u, name: 'Forever' }).body;
  const p1 = ctx.api('POST', '/collections/' + c1.id + '/visibility', { actor_id: u, visibility: 'public', public_expires_at: later });
  ctx.assert(p1.status === 200 && p1.body.visibility === 'public', 'public ' + JSON.stringify(p1.body));
  ctx.assert(ctx.api('POST', '/collections/' + c2.id + '/visibility', { actor_id: u, visibility: 'public' }).status === 200, 'public no expiry');
  const past = ctx.api('POST', '/collections/' + c2.id + '/visibility', { actor_id: u, visibility: 'public', public_expires_at: '2000-01-01T00:00:00.000Z' });
  ctx.assert(past.status === 400 || past.status === 422 || past.status === 409, 'past expiry refused ' + JSON.stringify(past.body));
  const r = ctx.advance('400d');
  ctx.assert(r.jobsFired.includes('expire_public_links') && r.jobsFailed.length === 0, 'job ' + JSON.stringify(r));
  const g1 = ctx.api('GET', '/collections/' + c1.id).body;
  ctx.assert(g1.visibility === 'private' && g1.public_expires_at === null, 'expired ' + JSON.stringify(g1));
  ctx.assert(ctx.api('GET', '/collections/' + c2.id).body.visibility === 'public', 'no-expiry stays public');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_users` | GET | /users | List users. |
| `get_user` | GET | /users/{id} | Fetch a user. |
| `create_user` | POST | /users | Register a user. |
| `list_folders` | GET | /folders | List folders, filter by owner_id and parent_id. |
| `get_folder` | GET | /folders/{id} | Fetch a folder. |
| `list_tags` | GET | /tags | List tags, filter by owner_id. |
| `create_tag` | POST | /tags | Create a tag for an owner. |
| `list_bookmarks` | GET | /bookmarks | List bookmarks, filter by owner_id, folder_id, status; search title and url. |
| `get_bookmark` | GET | /bookmarks/{id} | Fetch a bookmark. |
| `list_bookmark_tags` | GET | /bookmark_tags | List bookmark-tag links, filter by bookmark_id and tag_id. |
| `list_collections` | GET | /collections | List collections, filter by owner_id and visibility. |
| `get_collection` | GET | /collections/{id} | Fetch a collection. |
| `list_collection_members` | GET | /collections/{collection_id}/members | List members of a collection. |
| `list_collection_items` | GET | /collections/{collection_id}/items | List items of a collection. |
| `list_activity` | GET | /activity | List activity log, filter by actor_id, action, subject_id. |
| `create_bookmark` | POST | /bookmarks | Action: save a bookmark. |
| `mark_read` | POST | /bookmarks/{id}/read | Action: mark read. |
| `archive_bookmark` | POST | /bookmarks/{id}/archive | Action: archive. |
| `trash_bookmark` | POST | /bookmarks/{id}/trash | Action: move to trash. |
| `restore_bookmark` | POST | /bookmarks/{id}/restore | Action: restore from trash to unread. |
| `move_bookmark` | POST | /bookmarks/{id}/move | Action: move to a folder. |
| `tag_bookmark` | POST | /bookmarks/{id}/tags | Action: attach a tag. |
| `create_folder` | POST | /folders | Action: create folder. |
| `move_folder` | POST | /folders/{id}/move | Action: reparent folder, refusing cycles. |
| `create_collection` | POST | /collections | Action: create a private collection. |
| `set_collection_visibility` | POST | /collections/{id}/visibility | Action: set visibility and expiry. |
| `share_collection` | POST | /collections/{id}/members | Action: add or update a member. |
| `add_to_collection` | POST | /collections/{id}/items | Action: add a bookmark to a collection. |

## Seed

- Rows per entity: user: 6, folder: 14, tag: 12, bookmark: 60, bookmark_tag: 40, collection: 8, collection_member: 8, collection_item: 24, activity: 40
- Mix: Bookmarks spread over 6 users, nested folders up to 3 deep, all four statuses, trashed rows with trashed_at 1 to 28 days before the clock start. Collections spread over private, shared and public; some public ones carry an expiry in the future. One owner has a shared collection with an editor and a viewer, and another user owns several bookmarks in one folder for the hard task.
- State mix: bookmark: unread 35%, read 30%, archived 20%, trashed 15%; collection: private 40%, shared 35%, public 25%

## Tasks

- `archive_reading_item` (easy, permissions): As user Ana Rossi, archive her bookmark titled 'Designing Data-Intensive Applications notes'. Change nothing else.
  - Actions: `archive_bookmark`
  - Decoy idea: Archives a similarly titled bookmark owned by another user or a near-duplicate title of Ana's.
  - Pressure: distractor rows of bookmark
- `restore_wrong_trash` (medium, irreversible): Ben Okoye trashed bookmarks 'Rust async book' and 'Rust async book (old)' by mistake; the first was trashed 27 days ago and will be purged soon. Restore only the one titled exactly 'Rust async book' and leave the other trashed.
  - Actions: `restore_bookmark`
  - Decoy idea: Restores the near-duplicate '(old)' bookmark or both, or restores the wrong user's bookmark with the same title.
  - Pressure: seeded rows in bookmark.trashed; distractor rows of bookmark
- `share_and_fill_collection` (hard, two_actors): Ana Rossi owns the private collection 'Team Reading'. Share it with Ben Okoye as an editor, then, acting as Ben, add every one of Ben's unread bookmarks in his folder 'Rust' to that collection. Ben has more bookmarks than fit on one page, so check all pages. Do not add bookmarks that are not unread or not in that folder.
  - Actions: `share_collection`, `add_to_collection`
  - Decoy idea: Adds Ben's bookmarks without sharing first (refused), shares as viewer, only adds the first page, or adds read/archived ones from the folder.
  - Pressure: paging past the first page of bookmark; seeded rows in bookmark.unread, bookmark.read, collection.private; distractor rows of bookmark

## Open questions

- How is the acting user identified?
  - Default answer: Each action takes actor_id explicitly.
- Should purging be a hard delete?
  - Default answer: Yes, the bookmark and its links are deleted.
- Can viewers add bookmarks?
  - Default answer: No; only owner and editors, and only their own bookmarks.

## Assumptions

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

## Out of scope

- Authentication, passwords and sessions
  - Why: Actor is passed explicitly.
- Browser extension, page scraping, link health checks and full-text page content
  - Why: Computation, not records.
- Import/export of bookmark files
  - Why: Not part of the stateful core.
- Public-link anonymous reads
  - Why: No auth model; public is a visibility state only.

## Changes

None. The plan changes no existing item.
