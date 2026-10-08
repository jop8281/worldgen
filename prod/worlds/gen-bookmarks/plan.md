# WorldGen plan: Raindrop.io / Pocket-style bookmark manager (bookmarks, nested folders, tags, shared collections)

A multi-user bookmark manager. Users save bookmarks into a nested folder tree and label them with per-user tags. Each bookmark moves through unread, read, archived and trashed, and trash is purged after 30 days. Users group bookmarks into collections that are private, shared with members as viewer or editor, or public with an optional expiry. Actions enforce ownership, permission and cycle rules and write an activity log. Two jobs purge old trash and expire public links.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `user` | A person with a bookmark library. Owns bookmarks, folders, tags and collections, and can be a collection member. | name, email |
| `folder` | A user's folder. Folders nest through parent_id, which only the move_folder action sets, so cycles are impossible. | owner_id, name, parent_id |
| `bookmark` | A saved URL owned by a user, optionally in a folder. Moves through the unread, read, archived, trashed state machine. | owner_id, folder_id, url, title, status, favorite, link_status, read_at, trashed_at |
| `tag` | A lowercase label scoped to one user. Created by tag_bookmark. The name is readonly, and merge_tags is the only way to combine tags. | owner_id, name, color |
| `bookmark_tag` | Join row linking a bookmark to a tag. Unique per pair. Cascades when either side is deleted. | bookmark_id, tag_id |
| `collection` | A named set of bookmarks with visibility private, shared or public. The public state can carry an expiry. | owner_id, name, visibility, share_expires_at |
| `collection_member` | Grants a user viewer or editor access to a collection. Written only by share_collection and unshare_collection. | collection_id, user_id, role |
| `collection_item` | A bookmark placed in a collection, with who added it and an optional note. | collection_id, bookmark_id, added_by, note |
| `activity` | Append-only audit log written by actions and jobs. subject_id is a plain string, so entries survive purges. | kind, actor_id, subject_id, note |

## Workflows

### bookmark_lifecycle (bookmark)
- States: unread, read, archived, trashed
- Actions: mark_read, archive_bookmark, trash_bookmark, restore_bookmark, move_bookmark
- Rules:
  - Initial state is unread. status, read_at and trashed_at are readonly, so no PATCH can change them.
  - mark_read works only from unread and sets read_at to now.
  - archive_bookmark works from unread or read.
  - trash_bookmark works from unread, read or archived and sets trashed_at to now. Collection items and tags are kept.
  - restore_bookmark works from archived or trashed. It goes to unread and clears trashed_at.
  - A wrong-state call returns 409 invalid_state. A missing bookmark returns 404 not_found.
  - move_bookmark needs a folder owned by the bookmark's owner (else 409 owner_mismatch) and a non-trashed bookmark (else 409 invalid_state). A null folder_id moves it to the root.
  - Job purge_trash deletes bookmarks trashed 30 or more days ago. Their bookmark_tag and collection_item rows cascade. It writes a bookmark_purged activity with subject_id set to the bookmark id.
### tagging (tag)
- States: active
- Actions: tag_bookmark, untag_bookmark, merge_tags
- Rules:
  - tag_bookmark takes a name, trims it and lowercases it. A blank name returns 400 input.invalid.
  - It reuses the owner's existing tag with that name or creates one. It returns 201 with the bookmark_tag row.
  - Tagging a bookmark twice with the same tag returns 409 already_tagged.
  - untag_bookmark takes tag_id and returns 200. A tag the bookmark lacks returns 404 not_tagged. The tag row stays.
  - merge_tags repoints the source tag's links to the target. It skips bookmarks that already have the target and deletes the source tag.
  - It returns 200 with the target tag.
  - merging a tag into itself returns 409 invalid_merge. Tags with different owners return 409 owner_mismatch.
  - merge_tags writes one tags_merged activity with subject_id set to the target tag id.
### folder_tree (folder)
- States: root, nested
- Actions: move_folder
- Rules:
  - parent_id is readonly and set only by move_folder. A null parent_id means root.
  - move_folder refuses moving a folder under itself or any of its descendants (409 folder_cycle).
  - The new parent must have the same owner (409 owner_mismatch) and exist (400 input.invalid).
  - delete_folder is refused while subfolders exist. Bookmarks in a deleted folder get folder_id null.
### collection_sharing (collection)
- States: private, shared, public
- Actions: share_collection, unshare_collection, publish_collection, unpublish_collection, add_bookmark_to_collection
- Rules:
  - A new collection is private. visibility and share_expires_at are readonly.
  - Every sharing action takes actor_id, and only the collection owner may call it (else 409 not_permitted).
  - share_collection takes user_id and role (viewer or editor). It returns 201 with the member row.
  - It refuses the owner (409 owner_cannot_be_member) and an existing member (409 already_member). A private collection becomes shared.
  - unshare_collection removes a member (404 not_member if absent). When the last member leaves a shared collection it becomes private. A public collection stays public.
  - publish_collection takes optional expires_in_days (min 1) and makes the collection public. share_expires_at is now plus the days, or null when omitted.
  - unpublish_collection works only on a public collection (else 409 invalid_state). The result is shared if members exist, else private. It clears share_expires_at.
  - Job expire_public_shares applies the same rule as unpublish to public collections whose share_expires_at has passed, and writes a share_expired activity.
  - add_bookmark_to_collection takes actor_id, bookmark_id and an optional note. The actor must be the owner or an editor (409 not_permitted).
  - The bookmark must belong to the actor (409 not_your_bookmark) and must not be trashed (409 invalid_state). A duplicate returns 409 already_in_collection.
  - It returns 201 with the collection_item, whose added_by is the actor.

## Jobs

- `purge_trash` runs every 1d: Delete every bookmark with status trashed whose trashed_at is at least 30 days before now. Cascade removes its bookmark_tag rows and collection_item rows. Write a bookmark_purged activity for each, with subject_id set to the bookmark id.
- `expire_public_shares` runs every 1h: For each public collection whose share_expires_at is not after now, set share_expires_at to null and visibility to shared if it has members, else private. Write a share_expired activity.

## Acceptance tests

### bookmark_lifecycle_transitions
- Intent: A new bookmark starts unread. Archive, restore and trash follow the state machine, trash sets trashed_at, and wrong-state or missing calls are refused.
- Actions: archive_bookmark, trash_bookmark, restore_bookmark, mark_read
- Description: Creates a bookmark, then archives, restores and trashes it, checking defaults, trashed_at, restore clearing trashed_at, 409 invalid_state for wrong states and 404 for a missing bookmark.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const uu=ctx.api('POST','/users',{name:'Lia Lifecycle',email:'lia.lifecycle@tests.example'});ok(uu,'user');const c=ctx.api('POST','/bookmarks',{owner_id:uu.body.id,url:'https://example.com/lifecycle',title:'Lifecycle page'});ok(c,'create');const id=c.body.id;ctx.assert(c.body.status==='unread'&&c.body.favorite===false&&c.body.link_status==='unchecked'&&c.body.trashed_at===null,'defaults: '+JSON.stringify(c.body));const a=ctx.api('POST','/bookmarks/'+id+'/archive',{});ctx.assert(a.status===200&&a.body.status==='archived','archive: '+JSON.stringify(a.body));is(ctx.api('POST','/bookmarks/'+id+'/archive',{}),409,'invalid_state','archive twice');const r=ctx.api('POST','/bookmarks/'+id+'/restore',{});ctx.assert(r.status===200&&r.body.status==='unread','restore archived: '+JSON.stringify(r.body));const at=ctx.now();const t=ctx.api('POST','/bookmarks/'+id+'/trash',{});ctx.assert(t.status===200&&t.body.status==='trashed'&&t.body.trashed_at===at,'trash: '+JSON.stringify(t.body));is(ctx.api('POST','/bookmarks/'+id+'/archive',{}),409,'invalid_state','archive trashed');is(ctx.api('POST','/bookmarks/'+id+'/read',{}),409,'invalid_state','read trashed');const b=ctx.api('POST','/bookmarks/'+id+'/restore',{});ctx.assert(b.status===200&&b.body.status==='unread'&&b.body.trashed_at===null,'restore trashed: '+JSON.stringify(b.body));is(ctx.api('POST','/bookmarks/'+id+'/restore',{}),409,'invalid_state','restore unread');is(ctx.api('POST','/bookmarks/bkm_9999/trash',{}),404,'not_found','missing bookmark');}
```
### mark_read_sets_read_at
- Intent: mark_read moves unread to read, stamps read_at with the call time, logs activity and refuses a second call.
- Actions: mark_read, archive_bookmark
- Description: Reads a new bookmark, checks read_at equals the engine time and one bookmark_read activity exists, refuses a repeat, and allows archiving a read bookmark.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const uu=ctx.api('POST','/users',{name:'Rae Reader',email:'rae.reader@tests.example'});ok(uu,'user');const c=ctx.api('POST','/bookmarks',{owner_id:uu.body.id,url:'https://example.com/read',title:'Read me'});ok(c,'create');const id=c.body.id;const at=ctx.now();const r=ctx.api('POST','/bookmarks/'+id+'/read',{});ctx.assert(r.status===200&&r.body.status==='read'&&r.body.read_at===at,'read: '+JSON.stringify(r.body));is(ctx.api('POST','/bookmarks/'+id+'/read',{}),409,'invalid_state','read twice');const ev=ctx.api('GET','/activity?kind=bookmark_read&subject_id='+id);ctx.assert(ev.status===200&&ev.body.data.length===1,'one bookmark_read activity: '+JSON.stringify(ev.body));const a=ctx.api('POST','/bookmarks/'+id+'/archive',{});ctx.assert(a.status===200&&a.body.status==='archived','archive a read bookmark: '+JSON.stringify(a.body));}
```
### tag_and_untag_bookmark
- Intent: Tagging normalizes the name, reuses the owner's tag instead of duplicating it, refuses repeats and blank names, and untag removes only the link.
- Actions: tag_bookmark, untag_bookmark
- Description: Tags two bookmarks with 'Recipes' in different cases, checks one lowercase tag exists, 409 already_tagged, 400 for a blank name, then untags and checks 404 not_tagged and that the tag survives.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const uu=ctx.api('POST','/users',{name:'Tina Tagger',email:'tina.tagger@tests.example'});ok(uu,'user');const u=uu.body.id;const mk=(n)=>{const r=ctx.api('POST','/bookmarks',{owner_id:u,url:'https://example.com/'+n,title:'Page '+n});ok(r,'bookmark '+n);return r.body.id;};const b1=mk('one');const b2=mk('two');const t1=ctx.api('POST','/bookmarks/'+b1+'/tag',{name:'  Recipes '});ctx.assert(t1.status===201&&t1.body.bookmark_id===b1&&t1.body.tag_id,'tag: '+t1.status+' '+JSON.stringify(t1.body));const tags=ctx.api('GET','/tags?owner_id='+u);ctx.assert(tags.status===200&&tags.body.data.length===1&&tags.body.data[0].name==='recipes','one lowercase tag: '+JSON.stringify(tags.body));is(ctx.api('POST','/bookmarks/'+b1+'/tag',{name:'RECIPES'}),409,'already_tagged','tag twice');const t2=ctx.api('POST','/bookmarks/'+b2+'/tag',{name:'recipes'});ctx.assert(t2.status===201&&t2.body.tag_id===t1.body.tag_id,'second bookmark reuses the tag: '+JSON.stringify(t2.body));ctx.assert(ctx.api('GET','/tags?owner_id='+u).body.data.length===1,'still one tag');const blank=ctx.api('POST','/bookmarks/'+b1+'/tag',{name:'   '});ctx.assert(blank.status===400&&blank.body.error.code==='input.invalid','blank name: '+JSON.stringify(blank));const un=ctx.api('POST','/bookmarks/'+b1+'/untag',{tag_id:t1.body.tag_id});ctx.assert(un.status===200,'untag: '+un.status+' '+JSON.stringify(un.body));ctx.assert(ctx.api('GET','/bookmark_tags?bookmark_id='+b1).body.data.length===0,'b1 has no links');is(ctx.api('POST','/bookmarks/'+b1+'/untag',{tag_id:t1.body.tag_id}),404,'not_tagged','untag twice');ctx.assert(ctx.api('GET','/tags/'+t1.body.tag_id).status===200,'tag still exists for b2');}
```
### merge_tags_dedupes_links
- Intent: merge_tags moves every link to the target tag without duplicates, deletes the source, logs activity, and refuses self and cross-owner merges.
- Actions: tag_bookmark, merge_tags
- Description: Tags b1 with js and javascript and b2 with js, merges js into javascript, and checks each bookmark has exactly one javascript link, the source is gone and tags_merged was logged. Self-merge and a cross-owner merge are refused with 409.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const user=(n)=>{const r=ctx.api('POST','/users',{name:n,email:n.toLowerCase().replace(/ /g,'.')+'@tests.example'});ok(r,'user '+n);return r.body.id;};const bm=(o,n)=>{const r=ctx.api('POST','/bookmarks',{owner_id:o,url:'https://example.com/'+n,title:'Page '+n});ok(r,'bookmark '+n);return r.body.id;};const tag=(b,n)=>{const r=ctx.api('POST','/bookmarks/'+b+'/tag',{name:n});ctx.assert(r.status===201,'tag '+n+': '+r.status+' '+JSON.stringify(r.body));return r.body.tag_id;};const u=user('Mel Merger');const b1=bm(u,'m1');const b2=bm(u,'m2');const js=tag(b1,'js');const jsc=tag(b1,'javascript');tag(b2,'js');is(ctx.api('POST','/tags/'+js+'/merge',{into_tag_id:js}),409,'invalid_merge','self merge');const o=user('Otto Other');const bo=bm(o,'o1');const ot=tag(bo,'misc');is(ctx.api('POST','/tags/'+jsc+'/merge',{into_tag_id:ot}),409,'owner_mismatch','cross-owner merge');const m=ctx.api('POST','/tags/'+js+'/merge',{into_tag_id:jsc});ctx.assert(m.status===200&&m.body.id===jsc,'merge: '+m.status+' '+JSON.stringify(m.body));ctx.assert(ctx.api('GET','/tags/'+js).status===404,'source tag deleted');for(const b of [b1,b2]){const l=ctx.api('GET','/bookmark_tags?bookmark_id='+b);ctx.assert(l.status===200&&l.body.data.length===1&&l.body.data[0].tag_id===jsc,'bookmark '+b+' has exactly the javascript link: '+JSON.stringify(l.body));}const ev=ctx.api('GET','/activity?kind=tags_merged&subject_id='+jsc);ctx.assert(ev.status===200&&ev.body.data.length===1,'one tags_merged activity: '+JSON.stringify(ev.body));}
```
### move_folder_prevents_cycles
- Intent: move_folder re-parents folders, refuses cycles, cross-owner and unknown parents, and allows moving back to the root.
- Actions: move_folder
- Description: Builds A, B and C, nests B under A and C under B, then checks that moving A under C or A under A is a 409 folder_cycle, a foreign-owner parent is a 409 owner_mismatch, an unknown parent is a 400, and a null parent returns to the root.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const user=(n)=>{const r=ctx.api('POST','/users',{name:n,email:n.toLowerCase().replace(/ /g,'.')+'@tests.example'});ok(r,'user '+n);return r.body.id;};const u=user('Fay Folder');const o=user('Ona Outsider');const mk=(owner,n)=>{const r=ctx.api('POST','/folders',{owner_id:owner,name:n});ok(r,'folder '+n);ctx.assert(r.body.parent_id===null,'new folder is a root');return r.body.id;};const A=mk(u,'A');const B=mk(u,'B');const C=mk(u,'C');const F=mk(o,'Foreign');const mv=(id,p)=>ctx.api('POST','/folders/'+id+'/move',{parent_id:p});const r1=mv(B,A);ctx.assert(r1.status===200&&r1.body.parent_id===A,'B under A: '+JSON.stringify(r1.body));const r2=mv(C,B);ctx.assert(r2.status===200&&r2.body.parent_id===B,'C under B: '+JSON.stringify(r2.body));is(mv(A,C),409,'folder_cycle','A under its descendant C');is(mv(A,A),409,'folder_cycle','A under itself');is(mv(A,F),409,'owner_mismatch','foreign parent');const unk=mv(A,'fld_9999');ctx.assert(unk.status===400&&unk.body.error.code==='input.invalid','unknown parent: '+JSON.stringify(unk));is(mv('fld_9999',A),404,'not_found','missing folder');const r3=mv(C,null);ctx.assert(r3.status===200&&r3.body.parent_id===null,'C back to root: '+JSON.stringify(r3.body));ctx.assert(ctx.api('GET','/folders/'+A).body.parent_id===null,'A is unchanged');}
```
### move_bookmark_between_folders
- Intent: move_bookmark puts a bookmark in the owner's folder or at the root, and refuses another user's folder and trashed bookmarks.
- Actions: move_bookmark, trash_bookmark
- Description: Moves a bookmark into its owner's folder, to the root, then tries a foreign folder (409 owner_mismatch) and a trashed bookmark (409 invalid_state).

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const user=(n)=>{const r=ctx.api('POST','/users',{name:n,email:n.toLowerCase().replace(/ /g,'.')+'@tests.example'});ok(r,'user '+n);return r.body.id;};const u=user('Moe Mover');const o=user('Ola Other');const f1=ctx.api('POST','/folders',{owner_id:u,name:'Reading'});ok(f1,'folder');const f2=ctx.api('POST','/folders',{owner_id:o,name:'Theirs'});ok(f2,'folder 2');const b=ctx.api('POST','/bookmarks',{owner_id:u,url:'https://example.com/mv',title:'Movable'});ok(b,'bookmark');const id=b.body.id;ctx.assert(b.body.folder_id===null,'new bookmark has no folder');const m1=ctx.api('POST','/bookmarks/'+id+'/move',{folder_id:f1.body.id});ctx.assert(m1.status===200&&m1.body.folder_id===f1.body.id,'move: '+JSON.stringify(m1.body));is(ctx.api('POST','/bookmarks/'+id+'/move',{folder_id:f2.body.id}),409,'owner_mismatch','foreign folder');ctx.assert(ctx.api('GET','/bookmarks/'+id).body.folder_id===f1.body.id,'refused move changed nothing');const m2=ctx.api('POST','/bookmarks/'+id+'/move',{folder_id:null});ctx.assert(m2.status===200&&m2.body.folder_id===null,'move to root: '+JSON.stringify(m2.body));ok(ctx.api('POST','/bookmarks/'+id+'/trash',{}),'trash');is(ctx.api('POST','/bookmarks/'+id+'/move',{folder_id:f1.body.id}),409,'invalid_state','move trashed');}
```
### delete_folder_rules
- Intent: A folder with subfolders cannot be deleted. Deleting a leaf folder leaves its bookmarks with no folder.
- Actions: move_folder
- Description: Nests a folder under a parent, checks the parent cannot be deleted, deletes the leaf and sees the bookmark's folder_id become null, then deletes the now-empty parent.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const uu=ctx.api('POST','/users',{name:'Dee Deleter',email:'dee.deleter@tests.example'});ok(uu,'user');const u=uu.body.id;const p=ctx.api('POST','/folders',{owner_id:u,name:'Parent'});ok(p,'parent');const l=ctx.api('POST','/folders',{owner_id:u,name:'Leaf'});ok(l,'leaf');ok(ctx.api('POST','/folders/'+l.body.id+'/move',{parent_id:p.body.id}),'nest');const b=ctx.api('POST','/bookmarks',{owner_id:u,folder_id:l.body.id,url:'https://example.com/in-leaf',title:'In leaf'});ok(b,'bookmark');ctx.assert(b.body.folder_id===l.body.id,'bookmark starts in the leaf');const bad=ctx.api('DELETE','/folders/'+p.body.id);ctx.assert(bad.status>=400&&bad.status<500,'deleting a parent with a subfolder is refused: '+bad.status);ctx.assert(ctx.api('GET','/folders/'+p.body.id).status===200,'parent still exists');ok(ctx.api('DELETE','/folders/'+l.body.id),'delete leaf');ctx.assert(ctx.api('GET','/folders/'+l.body.id).status===404,'leaf is gone');ctx.assert(ctx.api('GET','/bookmarks/'+b.body.id).body.folder_id===null,'bookmark folder_id is null');ok(ctx.api('DELETE','/folders/'+p.body.id),'delete empty parent');}
```
### share_and_unshare_collection
- Intent: Only the owner can share. Sharing creates a member and makes the collection shared, and unsharing the last member returns it to private.
- Actions: share_collection, unshare_collection
- Description: Shares a private collection with a viewer, checks visibility shared, then tries a duplicate, the owner, a non-owner actor and a bad role. Unshares the viewer, checks the collection is private again, and refuses an unknown member.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const user=(n)=>{const r=ctx.api('POST','/users',{name:n,email:n.toLowerCase().replace(/ /g,'.')+'@tests.example'});ok(r,'user '+n);return r.body.id;};const owner=user('Cora Owner');const viewer=user('Vic Viewer');const out=user('Otis Outsider');const c=ctx.api('POST','/collections',{owner_id:owner,name:'Design links',description:'Inspiration'});ok(c,'collection');const id=c.body.id;ctx.assert(c.body.visibility==='private'&&c.body.share_expires_at===null,'new collection is private: '+JSON.stringify(c.body));const s=ctx.api('POST','/collections/'+id+'/share',{actor_id:owner,user_id:viewer,role:'viewer'});ctx.assert(s.status===201&&s.body.collection_id===id&&s.body.user_id===viewer&&s.body.role==='viewer','share: '+s.status+' '+JSON.stringify(s.body));ctx.assert(ctx.api('GET','/collections/'+id).body.visibility==='shared','collection is shared');is(ctx.api('POST','/collections/'+id+'/share',{actor_id:owner,user_id:viewer,role:'editor'}),409,'already_member','duplicate member');is(ctx.api('POST','/collections/'+id+'/share',{actor_id:owner,user_id:owner,role:'editor'}),409,'owner_cannot_be_member','owner as member');is(ctx.api('POST','/collections/'+id+'/share',{actor_id:out,user_id:out,role:'editor'}),409,'not_permitted','non-owner shares');const bad=ctx.api('POST','/collections/'+id+'/share',{actor_id:owner,user_id:out,role:'admin'});ctx.assert(bad.status===400&&bad.body.error.code==='input.invalid','bad role: '+JSON.stringify(bad));is(ctx.api('POST','/collections/'+id+'/unshare',{actor_id:out,user_id:viewer}),409,'not_permitted','non-owner unshares');is(ctx.api('POST','/collections/'+id+'/unshare',{actor_id:owner,user_id:out}),404,'not_member','unknown member');const u=ctx.api('POST','/collections/'+id+'/unshare',{actor_id:owner,user_id:viewer});ctx.assert(u.status===200,'unshare: '+u.status+' '+JSON.stringify(u.body));ctx.assert(ctx.api('GET','/collections/'+id).body.visibility==='private','last member removed, so private');ctx.assert(ctx.api('GET','/collection_members?collection_id='+id).body.data.length===0,'no members left');}
```
### add_bookmark_permissions
- Intent: Only the owner or an editor can add, and only their own non-trashed bookmarks, once each. Items can be removed.
- Actions: share_collection, add_bookmark_to_collection, trash_bookmark
- Description: Adds bookmarks as an outsider (409 not_permitted), a viewer (409), an editor (201, but 409 not_your_bookmark for another's bookmark), a duplicate (409 already_in_collection), the owner with a note (201) and a trashed bookmark (409). Then lists the items and deletes one.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const user=(n)=>{const r=ctx.api('POST','/users',{name:n,email:n.toLowerCase().replace(/ /g,'.')+'@tests.example'});ok(r,'user '+n);return r.body.id;};const bm=(o,n)=>{const r=ctx.api('POST','/bookmarks',{owner_id:o,url:'https://example.com/'+n,title:'Page '+n});ok(r,'bookmark '+n);return r.body.id;};const owner=user('Gus Owner');const editor=user('Edie Editor');const viewer=user('Vera Viewer');const out=user('Oz Outsider');const c=ctx.api('POST','/collections',{owner_id:owner,name:'Team reading'});ok(c,'collection');const id=c.body.id;ctx.assert(ctx.api('POST','/collections/'+id+'/share',{actor_id:owner,user_id:editor,role:'editor'}).status===201,'share editor');ctx.assert(ctx.api('POST','/collections/'+id+'/share',{actor_id:owner,user_id:viewer,role:'viewer'}).status===201,'share viewer');const bo=bm(owner,'bo');const be=bm(editor,'be');const bv=bm(viewer,'bv');const bx=bm(out,'bx');const add=(a,b,note)=>ctx.api('POST','/collections/'+id+'/add_bookmark',note===undefined?{actor_id:a,bookmark_id:b}:{actor_id:a,bookmark_id:b,note});is(add(out,bx),409,'not_permitted','outsider');is(add(viewer,bv),409,'not_permitted','viewer');const e1=add(editor,be);ctx.assert(e1.status===201&&e1.body.collection_id===id&&e1.body.bookmark_id===be&&e1.body.added_by===editor,'editor adds own: '+e1.status+' '+JSON.stringify(e1.body));is(add(editor,bo),409,'not_your_bookmark','editor adds the owner bookmark');is(add(editor,be),409,'already_in_collection','duplicate');const o1=add(owner,bo,'start here');ctx.assert(o1.status===201&&o1.body.note==='start here','owner adds with a note: '+JSON.stringify(o1.body));const bt=bm(owner,'bt');ok(ctx.api('POST','/bookmarks/'+bt+'/trash',{}),'trash');is(add(owner,bt),409,'invalid_state','trashed bookmark');const items=ctx.api('GET','/collection_items?collection_id='+id);ctx.assert(items.status===200&&items.body.data.length===2,'two items: '+JSON.stringify(items.body));ok(ctx.api('DELETE','/collection_items/'+e1.body.id),'remove item');ctx.assert(ctx.api('GET','/collection_items?collection_id='+id).body.data.length===1,'one item left');}
```
### publish_and_expire_collection
- Intent: Publishing makes a collection public with an optional expiry. The hourly job reverts expired links to shared or private, and unpublish is owner-only and state-checked.
- Actions: share_collection, publish_collection, unpublish_collection
- Description: Publishes a collection with 7 days of expiry and checks it stays public at 6 days. After 2 more days the job returns it to shared (it has a member) with the expiry cleared. A collection published without expiry stays public for 30 days, then unpublish returns it to private. Non-owner, zero-day and repeat unpublish calls are refused.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const is=(r,s,c,m)=>ctx.assert(r.status===s&&r.body.error&&r.body.error.code===c,m+': expected '+s+' '+c+', got '+r.status+' '+JSON.stringify(r.body));const user=(n)=>{const r=ctx.api('POST','/users',{name:n,email:n.toLowerCase().replace(/ /g,'.')+'@tests.example'});ok(r,'user '+n);return r.body.id;};const owner=user('Pia Publisher');const member=user('Max Member');const col=(n)=>{const r=ctx.api('POST','/collections',{owner_id:owner,name:n});ok(r,'collection '+n);return r.body.id;};const c1=col('Launch notes');const c2=col('Evergreen');ctx.assert(ctx.api('POST','/collections/'+c1+'/share',{actor_id:owner,user_id:member,role:'viewer'}).status===201,'share');is(ctx.api('POST','/collections/'+c1+'/publish',{actor_id:member,expires_in_days:7}),409,'not_permitted','non-owner publish');const zero=ctx.api('POST','/collections/'+c1+'/publish',{actor_id:owner,expires_in_days:0});ctx.assert(zero.status===400&&zero.body.error.code==='input.invalid','zero days: '+JSON.stringify(zero));const p=ctx.api('POST','/collections/'+c1+'/publish',{actor_id:owner,expires_in_days:7});ctx.assert(p.status===200&&p.body.visibility==='public'&&typeof p.body.share_expires_at==='string'&&p.body.share_expires_at>ctx.now(),'publish: '+JSON.stringify(p.body));const a1=ctx.advance('6d');ctx.assert(a1.jobsFailed.length===0,'jobs failed: '+JSON.stringify(a1.jobsFailed));ctx.assert(ctx.api('GET','/collections/'+c1).body.visibility==='public','still public after 6 days');const a2=ctx.advance('2d');ctx.assert(a2.jobsFailed.length===0,'jobs failed: '+JSON.stringify(a2.jobsFailed));const e=ctx.api('GET','/collections/'+c1).body;ctx.assert(e.visibility==='shared'&&e.share_expires_at===null,'expired, back to shared: '+JSON.stringify(e));const ev=ctx.api('GET','/activity?kind=share_expired&subject_id='+c1);ctx.assert(ev.status===200&&ev.body.data.length===1,'one share_expired activity: '+JSON.stringify(ev.body));const p2=ctx.api('POST','/collections/'+c2+'/publish',{actor_id:owner});ctx.assert(p2.status===200&&p2.body.visibility==='public'&&p2.body.share_expires_at===null,'publish with no expiry: '+JSON.stringify(p2.body));ctx.advance('30d');ctx.assert(ctx.api('GET','/collections/'+c2).body.visibility==='public','no expiry, still public');const u=ctx.api('POST','/collections/'+c2+'/unpublish',{actor_id:owner});ctx.assert(u.status===200&&u.body.visibility==='private','unpublish to private: '+JSON.stringify(u.body));is(ctx.api('POST','/collections/'+c2+'/unpublish',{actor_id:owner}),409,'invalid_state','unpublish a private collection');}
```
### purge_trash_job
- Intent: Trashed bookmarks are deleted by the daily job after 30 days, with their tag links and collection items. Restored and untrashed bookmarks survive.
- Actions: trash_bookmark, restore_bookmark, tag_bookmark, share_collection, add_bookmark_to_collection
- Description: Trashes two bookmarks, restores one after 10 days and checks the other survives until day 29. After day 31 it is gone with its links, items and a bookmark_purged activity, while the restored and the untouched bookmark remain.

```js
(ctx)=>{const ok=(r,m)=>ctx.assert(r.status>=200&&r.status<300,m+': '+r.status+' '+JSON.stringify(r.body));const uu=ctx.api('POST','/users',{name:'Pat Purger',email:'pat.purger@tests.example'});ok(uu,'user');const u=uu.body.id;const mk=(n)=>{const r=ctx.api('POST','/bookmarks',{owner_id:u,url:'https://example.com/'+n,title:'Page '+n});ok(r,'bookmark '+n);return r.body.id;};const b1=mk('doomed');const b2=mk('untouched');const b3=mk('restored');const col=ctx.api('POST','/collections',{owner_id:u,name:'Keepers'});ok(col,'collection');ctx.assert(ctx.api('POST','/bookmarks/'+b1+'/tag',{name:'temp'}).status===201,'tag b1');ctx.assert(ctx.api('POST','/collections/'+col.body.id+'/add_bookmark',{actor_id:u,bookmark_id:b1}).status===201,'add b1 to collection');ok(ctx.api('POST','/bookmarks/'+b1+'/trash',{}),'trash b1');ok(ctx.api('POST','/bookmarks/'+b3+'/trash',{}),'trash b3');const a1=ctx.advance('10d');ctx.assert(a1.jobsFailed.length===0,'jobs failed: '+JSON.stringify(a1.jobsFailed));ok(ctx.api('POST','/bookmarks/'+b3+'/restore',{}),'restore b3');const a2=ctx.advance('19d');ctx.assert(a2.jobsFailed.length===0,'jobs failed: '+JSON.stringify(a2.jobsFailed));const still=ctx.api('GET','/bookmarks/'+b1);ctx.assert(still.status===200&&still.body.status==='trashed','b1 still trashed at day 29: '+still.status);const a3=ctx.advance('2d');ctx.assert(a3.jobsFailed.length===0,'jobs failed: '+JSON.stringify(a3.jobsFailed));ctx.assert(ctx.api('GET','/bookmarks/'+b1).status===404,'b1 purged at day 31');ctx.assert(ctx.api('GET','/bookmark_tags?bookmark_id='+b1).body.data.length===0,'b1 tag links gone');ctx.assert(ctx.api('GET','/collection_items?collection_id='+col.body.id).body.data.length===0,'b1 collection item gone');const ev=ctx.api('GET','/activity?kind=bookmark_purged&subject_id='+b1);ctx.assert(ev.status===200&&ev.body.data.length===1,'one bookmark_purged activity: '+JSON.stringify(ev.body));ctx.assert(ctx.api('GET','/bookmarks/'+b2).status===200,'untouched bookmark survives');const r=ctx.api('GET','/bookmarks/'+b3);ctx.assert(r.status===200&&r.body.status==='unread','restored bookmark survives');}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_users` | GET | /users | List users. Filter by nothing, search name and email. |
| `get_user` | GET | /users/{id} | Get one user. |
| `create_user` | POST | /users | Create a user (name, email). |
| `list_folders` | GET | /folders | List folders. Filter by owner_id and parent_id, search name. |
| `get_folder` | GET | /folders/{id} | Get one folder. |
| `create_folder` | POST | /folders | Create a root folder (owner_id, name). Nesting goes through move_folder. |
| `update_folder` | PATCH | /folders/{id} | Rename a folder. |
| `delete_folder` | DELETE | /folders/{id} | Delete a folder. Refused while it has subfolders (restrict). Bookmarks inside move to no folder (nullify). |
| `list_bookmarks` | GET | /bookmarks | List bookmarks. Filter by owner_id, folder_id, status, favorite and link_status, search title, url and description, sort by created_at and title. Page size 25. |
| `get_bookmark` | GET | /bookmarks/{id} | Get one bookmark. |
| `create_bookmark` | POST | /bookmarks | Save a bookmark (owner_id, url, title, optional folder_id, description, favorite). Starts unread. |
| `update_bookmark` | PATCH | /bookmarks/{id} | Edit title, description, url, favorite and link_status. status, read_at and trashed_at are readonly and change only through actions. |
| `list_tags` | GET | /tags | List tags. Filter by owner_id, search name. |
| `get_tag` | GET | /tags/{id} | Get one tag. |
| `update_tag` | PATCH | /tags/{id} | Change a tag's color. The name is readonly. |
| `delete_tag` | DELETE | /tags/{id} | Delete a tag. Its bookmark_tag rows cascade. |
| `list_bookmark_tags` | GET | /bookmark_tags | List bookmark-tag links. Filter by bookmark_id and tag_id. |
| `list_collections` | GET | /collections | List collections. Filter by owner_id and visibility, search name. |
| `get_collection` | GET | /collections/{id} | Get one collection. |
| `create_collection` | POST | /collections | Create a private collection (owner_id, name, description). |
| `update_collection` | PATCH | /collections/{id} | Edit name and description. visibility and share_expires_at are readonly. |
| `delete_collection` | DELETE | /collections/{id} | Delete a collection. Its members and items cascade. |
| `list_collection_members` | GET | /collection_members | List members. Filter by collection_id, user_id and role. |
| `list_collection_items` | GET | /collection_items | List collection items. Filter by collection_id and bookmark_id. |
| `delete_collection_item` | DELETE | /collection_items/{id} | Remove a bookmark from a collection. |
| `list_activity` | GET | /activity | List the audit log. Filter by kind, actor_id and subject_id, sort by created_at. |
| `mark_read` | POST | /bookmarks/{id}/read | unread to read. Sets read_at. |
| `archive_bookmark` | POST | /bookmarks/{id}/archive | unread or read to archived. |
| `trash_bookmark` | POST | /bookmarks/{id}/trash | unread, read or archived to trashed. Sets trashed_at. |
| `restore_bookmark` | POST | /bookmarks/{id}/restore | archived or trashed to unread. Clears trashed_at. |
| `move_bookmark` | POST | /bookmarks/{id}/move | Move a bookmark into one of its owner's folders, or to the root with a null folder_id. |
| `tag_bookmark` | POST | /bookmarks/{id}/tag | Tag a bookmark by name. Normalizes the name, then finds or creates the owner's tag. |
| `untag_bookmark` | POST | /bookmarks/{id}/untag | Remove a tag from a bookmark. |
| `merge_tags` | POST | /tags/{id}/merge | Merge the source tag into another tag of the same owner, then delete the source. |
| `move_folder` | POST | /folders/{id}/move | Re-parent a folder. Refuses cycles and cross-owner parents. |
| `share_collection` | POST | /collections/{id}/share | The owner adds a member as viewer or editor. |
| `unshare_collection` | POST | /collections/{id}/unshare | The owner removes a member. |
| `publish_collection` | POST | /collections/{id}/publish | The owner makes the collection public, with an optional expiry in days. |
| `unpublish_collection` | POST | /collections/{id}/unpublish | The owner makes a public collection shared (if it has members) or private. |
| `add_bookmark_to_collection` | POST | /collections/{id}/add_bookmark | An owner or editor adds one of their own non-trashed bookmarks to the collection. |

## Seed

- Rows per entity: user: 6, folder: 18, bookmark: 60, tag: 24, bookmark_tag: 110, collection: 8, collection_member: 7, collection_item: 30, activity: 70
- Mix: Bookmark status: unread 22, read 18, archived 12, trashed 8, so none is above 40%. link_status is about 70% ok, 18% unchecked and 12% broken. Collection visibility: 3 private, 3 shared, 2 public. One public collection expires in the future, after clock.start. Folders are 8 roots and 10 nested, 2 levels deep at most. Trashed bookmarks have trashed_at 1 to 27 days before clock.start, so none is purgeable at the start. Anchors the tasks use: user Maya Chen is usr_0001 and Dev Patel is usr_0002. Maya owns about 24 bookmarks. Her unread bookmark 'Postgres Index-Only Scans Explained' has a same-titled twin owned by Dev. Maya has tags 'ml' and 'machine-learning', with some bookmarks tagged both. Dev also has an 'ml' tag. Maya has 6 broken-link bookmarks: 4 unread or read, 2 archived. Dev and others have broken ones too. Maya owns 3 private collections with 4, 3 and 2 items, and one shared collection with 5 items already shared with Omar Haddad. All other users and text are plausible, with no lorem ipsum.

## Tasks

- `mark_postgres_article_read` (easy): Mark Maya Chen's unread bookmark 'Postgres Index-Only Scans Explained' as read. Dev Patel owns a bookmark with the same title, which must stay unread. Graded on the end state of the target and no collateral change.
  - Decoy idea: Marks Dev Patel's same-titled bookmark as read, or archives Maya's bookmark instead of marking it read.
- `merge_maya_ml_tags` (medium): Maya Chen has two tags, 'ml' and 'machine-learning'. Merge ml into machine-learning so every bookmark that had ml now has machine-learning, with no duplicate links, and the ml tag is gone. Dev Patel's own ml tag must be untouched. Graded on links, tag rows and collateral.
  - Decoy idea: Deletes Maya's ml tag and loses its links. Merges in the wrong direction. Merges Dev's ml tag, or re-tags only the first page of bookmarks.
- `trash_maya_broken_links` (hard): Trash every bookmark owned by Maya Chen whose link_status is broken and whose status is unread or read. Her archived broken bookmarks stay archived, and other users' bookmarks are untouched. Maya's library spans several list pages. Graded on the exact set trashed and no collateral change.
  - Decoy idea: Reads only the first page of bookmarks, includes archived broken bookmarks, trashes every user's broken bookmarks, or archives them instead.
- `share_maya_big_private_collections` (hard): Share each private collection owned by Maya Chen that holds at least 3 bookmarks with Dev Patel as an editor. Leave her smaller private collection and her already-shared collection alone. Graded on the exact members created and no other change.
  - Decoy idea: Shares every private collection regardless of size, adds Dev as a viewer, also shares the already-shared collection, or publishes the collections instead of sharing.

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

- workflows.tagging because workflow tagging (entity tag) gets a lifecycle with representation removal
- workflows.folder_tree because workflow folder_tree (entity folder) gets a lifecycle with representation descriptive
