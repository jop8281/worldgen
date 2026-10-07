# Red-team calls: API semantics (create, actions, lists and responses)

Status: proposal

These are open questions from `research/redteam-contract.md` that change what an agent sees from the world API. In each table, "Unlocks" names the red-team tests that are marked `{ todo }` today and would become firm once the call is accepted.

## Decision rows

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | API create and states (RT-12) | Standard create accepts a state field only at its `initial` value, and an omitted state field gets `initial` (RT-13). Seeds and actions may set any state. | A-10 says a plain call cannot skip the workflow. Creating a ticket straight into `closed` skips it. | 2026-10-06 | Yes |
| A-xx | Unchanged state values (RT-125) | A write that sets a state field to the value it already has is not a transition, and it is accepted. | Agents often send back the whole row, and refusing such a write would punish a correct agent for something the real software allows. | 2026-10-06 | Yes |
| A-xx | Actions on a missing id (RT-43) | For an action whose path has `{id}`, the engine looks up the row before the handler runs. A missing row gives 404 in `meta.api.error`, and the handler never runs. | Generated handlers do not each need to check for a missing row, and every action fails the same way. | 2026-10-06 | Yes |
| A-xx | List queries (RT-121, RT-122, RT-123) | Declared filters combine with AND. On a nullable field that is not a string, `?f=null` selects null. A query key that is not a declared filter, `limitParam` or `cursorParam` gives 400 naming the known params. | If an unknown filter were silently ignored, an agent would get unfiltered rows and then write to the wrong ones. Refusing it follows "no silent guessing". | 2026-10-06 | Yes |
| A-xx | Cursors (RT-18, RT-120, RT-124) | A cursor is an opaque URL-safe string (`[A-Za-z0-9_-]+`) that encodes the last id returned and a hash of the filter. Paging is keyset: the next page holds the rows with `id >` that last id. | Client snippets have no `encodeURIComponent`. With keyset paging, a walk skips no row and repeats no row while rows are created, deleted or change filter in the middle of the walk. Offset paging fails both. | 2026-10-06 | Yes |
| A-xx | Sorting (RT-38) | v1 has no sort parameter, and lists are in id order. `?sort=` is an undeclared key, so it gives 400 under RT-123. | It keeps the engine small. A world that needs sorting can add a declared `sorts` list later without breaking anything. | 2026-10-06 | Yes |
| A-xx | Response headers (RT-126) | Every response from either port carries `content-type: application/json; charset=utf-8`. | HTTP clients and agent SDKs branch on this header. | 2026-10-06 | Yes |
| A-xx | Reads and the clock (RT-02) | A GET, and any call that commits nothing, does not move `now`. | A-16 ticks per committed call, and plan.md D-06 says reads do not tick. With this rule, `now` after a solution counts its committed writes exactly. | 2026-10-06 | Yes |

## Unlocks

| RT | Tests that become firm | Change to the test |
|---|---|---|
| RT-12 | `G-12 RT-12 create with a non-initial state is refused` | None |
| RT-125 | `G-12 RT-125 PATCH to the current state (undeclared self-transition) is refused` | Reverse it: the write is accepted, and nothing changes except `updated_at` |
| RT-43 | `G-09 an action on a missing id reaches the handler, whose ctx.fail(404) body is returned` | Replace it: 404 in the error envelope, and the handler does not run (a handler that would write runs no write) |
| RT-121 | `G-48 RT-121 every pair of filters intersects exactly…`, `G-48 RT-121 base pair and triple filters intersect at every limit` | None |
| RT-122 | `G-48 RT-122 assignee=null selects the unassigned tickets` | None |
| RT-123 | `G-48 RT-123 a query on an undeclared filter field is refused…` | None |
| RT-18, RT-124 | `G-47 RT-18 cursors are URL-safe…` and the three `RT-124` mid-walk tests | None |
| RT-38 | `G-47 RT-38 sorted walks visit every row once…` | Replace it with "`?sort=` gives 400" |
| RT-126 | `G-16 RT-126 an error body carries a JSON content-type` | None |
| RT-02 | none today (the exact-tick tests use writes only) | Tighten `G-49`: a GET moves `now` by 0 |

## Engine changes

- `store.ts`: in `WriteMode` `standard`, a create must use the initial state, and a field whose value is unchanged is not checked as a transition.
- `api.ts`: before an action whose path has `{id}` runs, look the row up, and return the 404 envelope if it is missing. Refuse an unknown query key with 400. Encode the cursor as base64url of `{ after, filterHash }`.
- `http.ts`: set `content-type` on every response.
