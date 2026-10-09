# WorldGen plan: Pocket/Raindrop.io-style multi-user bookmark manager with folders, tags and shareable collections

Users save bookmarks into a nested folder tree and label them with per-user tags. Bookmarks move through unread, read, archived and trashed, and trash is purged after 30 days. Collections are private, shared with viewer/editor members, or public with an optional expiry. Actions enforce ownership, permission and folder-cycle rules and write an activity log. Two jobs purge old trash and expire public links.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `user` | A person who owns bookmarks, folders, tags and collections. | name, email |
| `folder` | Node in a user's nested folder tree; parent_id is null for a root folder. | owner_id, name, parent_id |
| `bookmark` | A saved URL owned by one user, optionally in one folder, with a read-state. | owner_id, folder_id, url, title, status, trashed_at |
| `tag` | A per-user label. | owner_id, name |
| `bookmark_tag` | Link of a bookmark to one of its owner's tags. | bookmark_id, tag_id |
| `collection` | A group of bookmarks with visibility private, shared or public (optional expiry). | owner_id, name, visibility, public_expires_at |
| `collection_member` | A user granted viewer or editor access to a collection. | collection_id, user_id, role |
| `collection_item` | A bookmark placed in a collection by a user. | collection_id, bookmark_id, added_by |
| `activity` | Log of actions and job runs; actor_id is null for jobs. | actor_id, action, bookmark_id, collection_id, folder_id |

## Workflows

### bookmark_lifecycle (bookmark)
- States: unread, read, archived, trashed
- Actions: create_bookmark, mark_read, archive_bookmark, trash_bookmark, restore_bookmark, move_bookmark, tag_bookmark
- Rules:
  - Transitions: mark_read only from unread; archive from unread or read; trash from unread, read or archived (sets trashed_at); restore only from trashed, back to unread, clearing trashed_at. Anything else is 409 invalid_state. Enforced by: mark_read, archive_bookmark, trash_bookmark, restore_bookmark. Tested by: t_bookmark_lifecycle
  - Only the owner may act on a bookmark, and a bookmark may only be placed in a folder the actor owns; otherwise 409 not_owner. Enforced by: create_bookmark, trash_bookmark, move_bookmark. Tested by: t_ownership
  - A bookmark can only be given tags owned by the bookmark's owner (409 tag_not_owned) and the same tag only once (409 already_tagged). Enforced by: tag_bookmark. Tested by: t_tag_ownership
  - Every successful bookmark action writes one activity row (actor, action name, bookmark); refused calls write none. Enforced by: create_bookmark, mark_read, trash_bookmark. Tested by: t_activity_log
  - Bookmarks trashed 30 or more days ago are deleted by the daily purge_trash job, which removes their collection items and detaches their activity rows. Enforced by: purge_trash. Tested by: t_purge_trash
  - User emails are unique. Enforced by the data model: user.email is declared unique, so the engine answers field.unique.
### folder_tree (folder)
- States: active
- Actions: create_folder, move_folder
- Rules:
  - A folder cannot be moved under itself or any of its descendants (409 folder_cycle); parent and folder must belong to the actor (409 not_owner). Enforced by: move_folder. Tested by: t_folder_cycle
### collection_sharing (collection)
- States: private, shared, public
- Actions: create_collection, add_collection_member, add_collection_item, make_public, make_private
- Rules:
  - Only the owner adds members (409 not_owner); adding a member to a private collection makes it shared; viewers and outsiders cannot add items (409 permission_denied); editors and the owner can, but only with bookmarks they own (409 not_owner); duplicate item 409 already_in_collection, duplicate member 409 already_member. Enforced by: add_collection_item, add_collection_member. Tested by: t_collection_permissions
  - make_public (owner only) takes optional expires_in_hours; make_private (owner only) removes all members and clears the expiry. Enforced by: make_public, make_private. Tested by: t_visibility_toggle
  - The hourly expire_public_links job turns a public collection whose public_expires_at has passed back to shared if it has members, else private, and clears the expiry; public collections without expiry stay public. Enforced by: expire_public_links. Tested by: t_public_expiry

## Jobs

- `purge_trash` runs every 1d: Delete every bookmark with status trashed and trashed_at at least 30 days before now; cascade its collection items and nullify its activity bookmark_id.
- `expire_public_links` runs every 1h: For each public collection with public_expires_at <= now, set visibility to shared if it has members else private, and clear public_expires_at.

## Acceptance tests

### t_bookmark_lifecycle
- Intent: Bookmark states follow the allowed transitions and refuse the rest.
- Actions: create_bookmark, mark_read, archive_bookmark, trash_bookmark, restore_bookmark
- Description: Create a bookmark, read, archive, trash, restore, and check invalid transitions answer 409 invalid_state.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'Lifecycle User', email: 'lifecycle.user@test.invalid' });
  ctx.assert(u.status === 201, 'user: ' + JSON.stringify(u.body));
  const uid = u.body.id;
  const b = ctx.api('POST', '/bookmarks', { actor_id: uid, url: 'https://example.com/life', title: 'Lifecycle' });
  ctx.assert(b.status === 201 && b.body.status === 'unread' && b.body.owner_id === uid, 'create: ' + JSON.stringify(b.body));
  const id = b.body.id;
  const act = (v) => ctx.api('POST', '/bookmarks/' + id + '/' + v, { actor_id: uid });
  const r = act('read');
  ctx.assert(r.status === 200 && r.body.status === 'read', 'read: ' + JSON.stringify(r.body));
  const rr = act('read');
  ctx.assert(rr.status === 409 && rr.body.error.code === 'invalid_state', 'read twice: ' + JSON.stringify(rr.body));
  const a = act('archive');
  ctx.assert(a.status === 200 && a.body.status === 'archived', 'archive: ' + JSON.stringify(a.body));
  const t = act('trash');
  ctx.assert(t.status === 200 && t.body.status === 'trashed' && t.body.trashed_at !== null, 'trash: ' + JSON.stringify(t.body));
  const a2 = act('archive');
  ctx.assert(a2.status === 409 && a2.body.error.code === 'invalid_state', 'archive trashed: ' + JSON.stringify(a2.body));
  const rs = act('restore');
  ctx.assert(rs.status === 200 && rs.body.status === 'unread' && rs.body.trashed_at === null, 'restore: ' + JSON.stringify(rs.body));
  const rs2 = act('restore');
  ctx.assert(rs2.status === 409 && rs2.body.error.code === 'invalid_state', 'restore unread: ' + JSON.stringify(rs2.body));
  const g = ctx.api('GET', '/bookmarks/' + id);
  ctx.assert(g.status === 200 && g.body.status === 'unread', 'final: ' + JSON.stringify(g.body));
}
```
### t_ownership
- Intent: Only owners act on their bookmarks and folders.
- Actions: create_bookmark, trash_bookmark, move_bookmark, create_folder
- Description: A second user cannot trash, move or file bookmarks into someone else's folder; failures change nothing.

```js
(ctx) => {
  const u1 = ctx.api('POST', '/users', { name: 'Owner One', email: 'owner.one@test.invalid' }).body.id;
  const u2 = ctx.api('POST', '/users', { name: 'Owner Two', email: 'owner.two@test.invalid' }).body.id;
  const f1 = ctx.api('POST', '/folders', { actor_id: u1, name: 'Owned' });
  ctx.assert(f1.status === 201, 'folder: ' + JSON.stringify(f1.body));
  const f2 = ctx.api('POST', '/folders', { actor_id: u2, name: 'Theirs' });
  ctx.assert(f2.status === 201, 'folder2: ' + JSON.stringify(f2.body));
  const b = ctx.api('POST', '/bookmarks', { actor_id: u1, url: 'https://example.com/own', title: 'Own' });
  ctx.assert(b.status === 201, 'create: ' + JSON.stringify(b.body));
  const id = b.body.id;
  const t = ctx.api('POST', '/bookmarks/' + id + '/trash', { actor_id: u2 });
  ctx.assert(t.status === 409 && t.body.error.code === 'not_owner', 'foreign trash: ' + JSON.stringify(t.body));
  const m = ctx.api('POST', '/bookmarks/' + id + '/move', { actor_id: u2, folder_id: null });
  ctx.assert(m.status === 409 && m.body.error.code === 'not_owner', 'foreign move: ' + JSON.stringify(m.body));
  const c = ctx.api('POST', '/bookmarks', { actor_id: u2, url: 'https://example.com/x', title: 'X', folder_id: f1.body.id });
  ctx.assert(c.status === 409 && c.body.error.code === 'not_owner', 'foreign folder create: ' + JSON.stringify(c.body));
  const m2 = ctx.api('POST', '/bookmarks/' + id + '/move', { actor_id: u1, folder_id: f2.body.id });
  ctx.assert(m2.status === 409 && m2.body.error.code === 'not_owner', 'into foreign folder: ' + JSON.stringify(m2.body));
  const ok = ctx.api('POST', '/bookmarks/' + id + '/move', { actor_id: u1, folder_id: f1.body.id });
  ctx.assert(ok.status === 200 && ok.body.folder_id === f1.body.id, 'own move: ' + JSON.stringify(ok.body));
  const g = ctx.api('GET', '/bookmarks/' + id).body;
  ctx.assert(g.status === 'unread' && g.folder_id === f1.body.id, 'unchanged otherwise: ' + JSON.stringify(g));
}
```
### t_tag_ownership
- Intent: Tags are per user and attach once.
- Actions: tag_bookmark, create_bookmark
- Description: Tagging with another user's tag is refused; own tag works once.

```js
(ctx) => {
  const u1 = ctx.api('POST', '/users', { name: 'Tagger One', email: 'tagger.one@test.invalid' }).body.id;
  const u2 = ctx.api('POST', '/users', { name: 'Tagger Two', email: 'tagger.two@test.invalid' }).body.id;
  const t1 = ctx.api('POST', '/tags', { owner_id: u1, name: 'research' });
  ctx.assert(t1.status === 201, 'tag1: ' + JSON.stringify(t1.body));
  const t2 = ctx.api('POST', '/tags', { owner_id: u2, name: 'research' });
  ctx.assert(t2.status === 201, 'tag2: ' + JSON.stringify(t2.body));
  const b = ctx.api('POST', '/bookmarks', { actor_id: u1, url: 'https://example.com/tag', title: 'Tag me' });
  ctx.assert(b.status === 201, 'create: ' + JSON.stringify(b.body));
  const id = b.body.id;
  const bad = ctx.api('POST', '/bookmarks/' + id + '/tag', { actor_id: u1, tag_id: t2.body.id });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'tag_not_owned', 'foreign tag: ' + JSON.stringify(bad.body));
  const ok = ctx.api('POST', '/bookmarks/' + id + '/tag', { actor_id: u1, tag_id: t1.body.id });
  ctx.assert(ok.status === 201, 'own tag: ' + JSON.stringify(ok.body));
  const dup = ctx.api('POST', '/bookmarks/' + id + '/tag', { actor_id: u1, tag_id: t1.body.id });
  ctx.assert(dup.status === 409 && dup.body.error.code === 'already_tagged', 'dup: ' + JSON.stringify(dup.body));
  const other = ctx.api('POST', '/bookmarks/' + id + '/tag', { actor_id: u2, tag_id: t2.body.id });
  ctx.assert(other.status === 409 && other.body.error.code === 'not_owner', 'non-owner tagging: ' + JSON.stringify(other.body));
  const l = ctx.api('GET', '/bookmark_tags?bookmark_id=' + id);
  ctx.assert(l.status === 200 && l.body.data.length === 1 && l.body.data[0].tag_id === t1.body.id, 'links: ' + JSON.stringify(l.body));
}
```
### t_folder_cycle
- Intent: Folders cannot be moved into their own subtree.
- Actions: create_folder, move_folder
- Description: Build a chain of folders; moving an ancestor under a descendant or itself is 409 folder_cycle; legal moves work.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'Folder User', email: 'folder.user@test.invalid' }).body.id;
  const o = ctx.api('POST', '/users', { name: 'Folder Other', email: 'folder.other@test.invalid' }).body.id;
  const f1 = ctx.api('POST', '/folders', { actor_id: u, name: 'A' });
  ctx.assert(f1.status === 201 && f1.body.parent_id === null, 'f1: ' + JSON.stringify(f1.body));
  const f2 = ctx.api('POST', '/folders', { actor_id: u, name: 'B', parent_id: f1.body.id });
  ctx.assert(f2.status === 201 && f2.body.parent_id === f1.body.id, 'f2: ' + JSON.stringify(f2.body));
  const f3 = ctx.api('POST', '/folders', { actor_id: u, name: 'C', parent_id: f2.body.id });
  ctx.assert(f3.status === 201, 'f3: ' + JSON.stringify(f3.body));
  const mv = (id, actor, parent) => ctx.api('POST', '/folders/' + id + '/move', { actor_id: actor, parent_id: parent });
  const c1 = mv(f1.body.id, u, f3.body.id);
  ctx.assert(c1.status === 409 && c1.body.error.code === 'folder_cycle', 'descendant: ' + JSON.stringify(c1.body));
  const c2 = mv(f1.body.id, u, f1.body.id);
  ctx.assert(c2.status === 409 && c2.body.error.code === 'folder_cycle', 'self: ' + JSON.stringify(c2.body));
  const c3 = mv(f1.body.id, o, null);
  ctx.assert(c3.status === 409 && c3.body.error.code === 'not_owner', 'foreign actor: ' + JSON.stringify(c3.body));
  const ok1 = mv(f3.body.id, u, null);
  ctx.assert(ok1.status === 200 && ok1.body.parent_id === null, 'to root: ' + JSON.stringify(ok1.body));
  const ok2 = mv(f1.body.id, u, f3.body.id);
  ctx.assert(ok2.status === 200 && ok2.body.parent_id === f3.body.id, 'now legal: ' + JSON.stringify(ok2.body));
}
```
### t_collection_permissions
- Intent: Collection access depends on owner, editor and viewer roles.
- Actions: create_collection, add_collection_member, add_collection_item, create_bookmark
- Description: Owner adds an editor and a viewer; viewer/outsider cannot add items; editor can add own bookmarks only; duplicates refused.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: 'Perm ' + n, email: 'perm.' + n + '@test.invalid' }).body.id;
  const o = mk('owner'); const e = mk('editor'); const v = mk('viewer'); const x = mk('outsider');
  const bk = (uid, t) => ctx.api('POST', '/bookmarks', { actor_id: uid, url: 'https://example.com/' + t, title: t }).body.id;
  const bo = bk(o, 'bo'); const be = bk(e, 'be'); const bv = bk(v, 'bv'); const bx = bk(x, 'bx');
  const c = ctx.api('POST', '/collections', { actor_id: o, name: 'Team' });
  ctx.assert(c.status === 201 && c.body.visibility === 'private', 'collection: ' + JSON.stringify(c.body));
  const cid = c.body.id;
  const addM = (actor, uid, role) => ctx.api('POST', '/collections/' + cid + '/add_member', { actor_id: actor, user_id: uid, role });
  const na = addM(e, e, 'editor');
  ctx.assert(na.status === 409 && na.body.error.code === 'not_owner', 'non-owner add member: ' + JSON.stringify(na.body));
  const m1 = addM(o, e, 'editor');
  ctx.assert(m1.status === 201, 'editor: ' + JSON.stringify(m1.body));
  const m2 = addM(o, v, 'viewer');
  ctx.assert(m2.status === 201, 'viewer: ' + JSON.stringify(m2.body));
  const dm = addM(o, v, 'viewer');
  ctx.assert(dm.status === 409 && dm.body.error.code === 'already_member', 'dup member: ' + JSON.stringify(dm.body));
  ctx.assert(ctx.api('GET', '/collections/' + cid).body.visibility === 'shared', 'becomes shared');
  const addI = (actor, bid) => ctx.api('POST', '/collections/' + cid + '/add_item', { actor_id: actor, bookmark_id: bid });
  const iv = addI(v, bv);
  ctx.assert(iv.status === 409 && iv.body.error.code === 'permission_denied', 'viewer: ' + JSON.stringify(iv.body));
  const ix = addI(x, bx);
  ctx.assert(ix.status === 409 && ix.body.error.code === 'permission_denied', 'outsider: ' + JSON.stringify(ix.body));
  const ie = addI(e, be);
  ctx.assert(ie.status === 201, 'editor adds own: ' + JSON.stringify(ie.body));
  const ib = addI(e, bo);
  ctx.assert(ib.status === 409 && ib.body.error.code === 'not_owner', 'editor adds foreign bookmark: ' + JSON.stringify(ib.body));
  const idp = addI(e, be);
  ctx.assert(idp.status === 409 && idp.body.error.code === 'already_in_collection', 'dup item: ' + JSON.stringify(idp.body));
  const io = addI(o, bo);
  ctx.assert(io.status === 201, 'owner adds: ' + JSON.stringify(io.body));
  ctx.assert(ctx.api('GET', '/collections/' + cid + '/members').body.data.length === 2, 'two members');
  ctx.assert(ctx.api('GET', '/collections/' + cid + '/items').body.data.length === 2, 'two items');
}
```
### t_visibility_toggle
- Intent: Only the owner makes a collection public or private; make_private removes members and clears expiry.
- Actions: create_collection, add_collection_member, make_public, make_private
- Description: Outsider cannot change visibility; owner makes it public with expiry then private, which drops members and the expiry.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: 'Vis ' + n, email: 'vis.' + n + '@test.invalid' }).body.id;
  const o = mk('owner'); const m = mk('member'); const x = mk('outsider');
  const c = ctx.api('POST', '/collections', { actor_id: o, name: 'Toggle' });
  ctx.assert(c.status === 201 && c.body.visibility === 'private', 'collection: ' + JSON.stringify(c.body));
  const cid = c.body.id;
  ctx.assert(ctx.api('POST', '/collections/' + cid + '/add_member', { actor_id: o, user_id: m, role: 'viewer' }).status === 201, 'member');
  const bad = ctx.api('POST', '/collections/' + cid + '/make_public', { actor_id: x, expires_in_hours: 5 });
  ctx.assert(bad.status === 409 && bad.body.error.code === 'not_owner', 'outsider public: ' + JSON.stringify(bad.body));
  const p = ctx.api('POST', '/collections/' + cid + '/make_public', { actor_id: o, expires_in_hours: 5 });
  ctx.assert(p.status === 200 && p.body.visibility === 'public' && p.body.public_expires_at !== null, 'public: ' + JSON.stringify(p.body));
  const px = ctx.api('POST', '/collections/' + cid + '/make_private', { actor_id: x });
  ctx.assert(px.status === 409 && px.body.error.code === 'not_owner', 'outsider private: ' + JSON.stringify(px.body));
  const q = ctx.api('POST', '/collections/' + cid + '/make_private', { actor_id: o });
  ctx.assert(q.status === 200 && q.body.visibility === 'private' && q.body.public_expires_at === null, 'private: ' + JSON.stringify(q.body));
  ctx.assert(ctx.api('GET', '/collections/' + cid + '/members').body.data.length === 0, 'members removed');
  const p2 = ctx.api('POST', '/collections/' + cid + '/make_public', { actor_id: o });
  ctx.assert(p2.status === 200 && p2.body.visibility === 'public' && p2.body.public_expires_at === null, 'public without expiry: ' + JSON.stringify(p2.body));
}
```
### t_public_expiry
- Intent: Public collections expire back to shared or private; no-expiry stays public.
- Actions: create_collection, add_collection_member, make_public
- Description: Set public with expiry, advance the clock, and check the expire_public_links job outcome.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/users', { name: 'Exp ' + n, email: 'exp.' + n + '@test.invalid' }).body.id;
  const o = mk('owner'); const e = mk('editor'); const x = mk('outsider');
  const col = (n) => ctx.api('POST', '/collections', { actor_id: o, name: n }).body.id;
  const c1 = col('Plain'); const c2 = col('WithMember'); const c3 = col('Forever');
  ctx.assert(ctx.api('POST', '/collections/' + c2 + '/add_member', { actor_id: o, user_id: e, role: 'viewer' }).status === 201, 'member');
  const pub = (id, actor, h) => ctx.api('POST', '/collections/' + id + '/make_public', h === undefined ? { actor_id: actor } : { actor_id: actor, expires_in_hours: h });
  const bad = pub(c1, x, 2);
  ctx.assert(bad.status === 409 && bad.body.error.code === 'not_owner', 'non-owner public: ' + JSON.stringify(bad.body));
  const p1 = pub(c1, o, 2);
  ctx.assert(p1.status === 200 && p1.body.visibility === 'public' && p1.body.public_expires_at !== null, 'public: ' + JSON.stringify(p1.body));
  ctx.assert(pub(c2, o, 3).status === 200, 'public with member');
  const p3 = pub(c3, o);
  ctx.assert(p3.status === 200 && p3.body.visibility === 'public' && p3.body.public_expires_at === null, 'no expiry: ' + JSON.stringify(p3.body));
  const r1 = ctx.advance('1h');
  ctx.assert(r1.jobsFailed.length === 0, 'jobs ok');
  ctx.assert(ctx.api('GET', '/collections/' + c1).body.visibility === 'public', 'still public at 1h');
  ctx.assert(ctx.api('GET', '/collections/' + c2).body.visibility === 'public', 'c2 public at 1h');
  ctx.advance('2h');
  const a = ctx.api('GET', '/collections/' + c1).body;
  ctx.assert(a.visibility === 'private' && a.public_expires_at === null, 'expired to private: ' + JSON.stringify(a));
  const b = ctx.api('GET', '/collections/' + c2).body;
  ctx.assert(b.visibility === 'shared' && b.public_expires_at === null, 'expired to shared: ' + JSON.stringify(b));
  ctx.advance('5d');
  ctx.assert(ctx.api('GET', '/collections/' + c3).body.visibility === 'public', 'no-expiry stays public');
}
```
### t_purge_trash
- Intent: Trash older than 30 days is purged with its collection items.
- Actions: create_bookmark, add_collection_item, trash_bookmark, create_collection, archive_bookmark
- Description: Trash a bookmark, advance 29 days (kept), then 2 more (deleted); other bookmarks stay.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'Purge User', email: 'purge.user@test.invalid' }).body.id;
  const bk = (t) => ctx.api('POST', '/bookmarks', { actor_id: u, url: 'https://example.com/' + t, title: t }).body.id;
  const b1 = bk('purge1'); const b2 = bk('purge2'); const b3 = bk('purge3');
  const c = ctx.api('POST', '/collections', { actor_id: u, name: 'Purge coll' }).body.id;
  ctx.assert(ctx.api('POST', '/collections/' + c + '/add_item', { actor_id: u, bookmark_id: b1 }).status === 201, 'add item');
  ctx.assert(ctx.api('POST', '/bookmarks/' + b1 + '/trash', { actor_id: u }).status === 200, 'trash b1');
  ctx.assert(ctx.api('POST', '/bookmarks/' + b3 + '/archive', { actor_id: u }).status === 200, 'archive b3');
  ctx.advance('29d');
  ctx.assert(ctx.api('GET', '/bookmarks/' + b1).status === 200, 'kept at 29 days');
  const r = ctx.advance('2d');
  ctx.assert(r.jobsFailed.length === 0, 'jobs ok: ' + JSON.stringify(r.jobsFailed));
  const g = ctx.api('GET', '/bookmarks/' + b1);
  ctx.assert(g.status === 404 && g.body.error.code === 'row.not_found', 'purged: ' + JSON.stringify(g));
  ctx.assert(ctx.api('GET', '/bookmarks/' + b2).status === 200, 'unread kept');
  ctx.assert(ctx.api('GET', '/bookmarks/' + b3).body.status === 'archived', 'archived kept');
  ctx.assert(ctx.api('GET', '/collections/' + c + '/items').body.data.length === 0, 'collection item removed');
  ctx.assert(ctx.api('GET', '/activity?bookmark_id=' + b1).body.data.length === 0, 'activity detached');
}
```
### t_activity_log
- Intent: Successful bookmark actions are logged in order; refused calls are not.
- Actions: create_bookmark, mark_read, trash_bookmark
- Description: Create, read and trash a bookmark and check the activity rows; a refused trash adds none.

```js
(ctx) => {
  const u = ctx.api('POST', '/users', { name: 'Log User', email: 'log.user@test.invalid' }).body.id;
  const o = ctx.api('POST', '/users', { name: 'Log Other', email: 'log.other@test.invalid' }).body.id;
  const b = ctx.api('POST', '/bookmarks', { actor_id: u, url: 'https://example.com/log', title: 'Log' }).body.id;
  ctx.assert(ctx.api('POST', '/bookmarks/' + b + '/read', { actor_id: u }).status === 200, 'read');
  const bad = ctx.api('POST', '/bookmarks/' + b + '/trash', { actor_id: o });
  ctx.assert(bad.status === 409, 'refused trash');
  ctx.assert(ctx.api('POST', '/bookmarks/' + b + '/trash', { actor_id: u }).status === 200, 'trash');
  const l = ctx.api('GET', '/activity?bookmark_id=' + b);
  ctx.assert(l.status === 200, 'list');
  const acts = l.body.data.map((a) => a.action);
  ctx.assert(JSON.stringify(acts) === JSON.stringify(['create_bookmark', 'mark_read', 'trash_bookmark']), 'actions: ' + JSON.stringify(acts));
  ctx.assert(l.body.data.every((a) => a.actor_id === u), 'actor recorded');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_users` | GET | /users | List users |
| `get_user` | GET | /users/{id} | Get a user |
| `create_user` | POST | /users | Register a user |
| `list_folders` | GET | /folders | List folders, filter by owner_id and parent_id |
| `get_folder` | GET | /folders/{id} | Get a folder |
| `list_bookmarks` | GET | /bookmarks | List bookmarks, filter by owner_id, folder_id, status |
| `get_bookmark` | GET | /bookmarks/{id} | Get a bookmark |
| `update_bookmark` | PATCH | /bookmarks/{id} | Edit title and notes only |
| `list_tags` | GET | /tags | List tags, filter by owner_id |
| `get_tag` | GET | /tags/{id} | Get a tag |
| `create_tag` | POST | /tags | Create a per-user tag |
| `list_bookmark_tags` | GET | /bookmark_tags | List bookmark-tag links, filter by bookmark_id and tag_id |
| `list_collections` | GET | /collections | List collections, filter by owner_id and visibility |
| `get_collection` | GET | /collections/{id} | Get a collection |
| `list_collection_members` | GET | /collections/{collection_id}/members | List members of a collection |
| `list_collection_items` | GET | /collections/{collection_id}/items | List items of a collection |
| `list_activity` | GET | /activity | List activity, filter by actor_id, action, bookmark_id, collection_id |
| `create_bookmark` | POST | /bookmarks | Built as the create_bookmark action |
| `mark_read` | POST | /bookmarks/{id}/read | Built as the mark_read action |
| `archive_bookmark` | POST | /bookmarks/{id}/archive | Built as the archive_bookmark action |
| `trash_bookmark` | POST | /bookmarks/{id}/trash | Built as the trash_bookmark action |
| `restore_bookmark` | POST | /bookmarks/{id}/restore | Built as the restore_bookmark action |
| `move_bookmark` | POST | /bookmarks/{id}/move | Built as the move_bookmark action |
| `tag_bookmark` | POST | /bookmarks/{id}/tag | Built as the tag_bookmark action |
| `create_folder` | POST | /folders | Built as the create_folder action |
| `move_folder` | POST | /folders/{id}/move | Built as the move_folder action |
| `create_collection` | POST | /collections | Built as the create_collection action |
| `add_collection_member` | POST | /collections/{id}/add_member | Built as the add_collection_member action |
| `add_collection_item` | POST | /collections/{id}/add_item | Built as the add_collection_item action |
| `make_public` | POST | /collections/{id}/make_public | Built as the make_public action |
| `make_private` | POST | /collections/{id}/make_private | Built as the make_private action |

## Seed

- Rows per entity: user: 6, folder: 16, bookmark: 60, tag: 12, bookmark_tag: 40, collection: 8, collection_member: 10, collection_item: 20, activity: 40
- Mix: Bookmarks are spread across 6 users and 16 nested folders (three levels deep). Some titles repeat across users to act as distractors. Trashed bookmarks were trashed 1-25 days before the clock start so none are due for purge. Collections mix private, shared (with viewer and editor members) and public (some with a future expiry).
- State mix: bookmark: unread 35%, read 25%, archived 25%, trashed 15%; collection: private 40%, shared 35%, public 25%

## Tasks

- `archive_dana_rust_bookmark` (easy): Archive Dana Whitaker's unread bookmark titled 'Rust Ownership Explained'.
  - Actions: `archive_bookmark`
  - Decoy idea: Another user owns a bookmark with the same title; the decoy archives that one.
  - Pressure: seeded rows in bookmark.unread; distractor rows of bookmark
- `add_leo_bookmark_to_team_reading` (medium, permissions): Add Leo Marsh's bookmark 'SQLite Internals' to the shared collection 'Team Reading', where Leo is an editor, acting as Leo.
  - Actions: `add_collection_item`
  - Decoy idea: Acts as the viewer Ira, whose same-titled bookmark is refused, or adds the collection owner's bookmark with the same title.
  - Pressure: seeded rows in collection.shared; distractor rows of bookmark
- `reorganize_recipes_and_trash_archived` (hard, irreversible): For Sam Ortiz: move the folder 'Recipes' under his folder 'Home', then trash every archived bookmark in 'Recipes' (more than one page of bookmarks exist for Sam).
  - Actions: `move_folder`, `trash_bookmark`
  - Decoy idea: Reads only the first page of bookmarks, or trashes archived bookmarks of other folders or users, or trashes read bookmarks too.
  - Pressure: paging past the first page of bookmark; seeded rows in bookmark.archived; distractor rows of folder

## Open questions

- Can a bookmark be in several collections?
  - Default answer: Yes, once per collection.
- Do viewers see private bookmarks of others?
  - Default answer: Out of scope; access is only enforced on adding items and members.
- Should purge also keep trashed bookmarks' tag links?
  - Default answer: Tag links are removed with the bookmark (cascade).

## Assumptions

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

## Out of scope

- Authentication, sessions and API tokens
  - Why: The actor is passed explicitly; auth is not the core value.
- Fetching page metadata, screenshots or full-text search of page content
  - Why: Computation, not stateful records.
- Import/export of bookmark files and browser extensions
  - Why: Not needed for the record workflows.

## Changes

None. The plan changes no existing item.
