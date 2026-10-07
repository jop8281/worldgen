# Linear world: design and verdict

# Linear world: engine, wire facade and fidelity test

Recommendation: build the REST world on the engine first. Add the GraphQL facade only if time allows. The facade is the stronger demo, because the real `@linear/sdk` runs against our world without changes. But it costs about 2.5 to 3 more days.

Evidence lives in `/private/tmp/claude-501/-Users-yossieliaz-task-description/1bd09f7b-4ced-47e3-b9a0-d6d36e504627/scratchpad/linear-mimic/linear-world/`:
- `src/` holds the SDK source and `schema.graphql` from github.com/linear/linear master.
- `tool/surface.mjs` and `tool/nn.mjs` measure which schema fields the SDK actually asks for.

Labels used below:
- **[V-doc]**: verified in official docs.
- **[V-src]**: verified in SDK source or the SDL.
- **[V-probe]**: verified by my own unauthenticated curl to api.linear.app.
- **[U]**: unverified.

## 1. Facts

| Topic | Fact | Evidence |
|---|---|---|
| Endpoint | `https://api.linear.app/graphql`, POST JSON | [V-doc] graphql page. [V-src] `client.ts:45` |
| Auth | Personal key: `Authorization: <API_KEY>`, with no Bearer. OAuth: `Authorization: Bearer <token>` | [V-doc]. [V-src] `client.ts:51-55` |
| Introspection | Supported, and works with no auth | [V-doc]. [V-probe] HTTP 200 with no auth |
| SDL downloadable | Yes. `packages/sdk/src/schema.graphql` (52,706 lines, 1,254 types, inputs and enums) and `schema.json`, in the linear/linear repo | [V-src] |
| SDK custom URL | Yes. `LinearClientOptions.apiUrl?: string`. `validateApiUrl` allows `https:` anywhere and `http:` only for `localhost`, `127.0.0.1` and `[::1]`. It uses `globalThis.fetch` with POST `{query, variables}` | [V-src] `client.ts:7-24`, `types.ts:4-11`, `graphql-client.ts:66-78` |
| SDK on any error | It throws if the response is not ok, or has any `errors`, or has no `data`. So partial data still becomes a thrown `LinearError` | [V-src] `graphql-client.ts:83` |
| SDK error typing | It maps `errors[0].extensions.type` (for example "invalid input", "authentication error", "ratelimited", "forbidden", "graphql error", "lock timeout", "usage limit exceeded") to 14 `LinearErrorType` subclasses. It reads `extensions.userError` and `extensions.userPresentableMessage`. If there is no type, it falls back to HTTP status: 403 Forbidden, 429 Ratelimited, other 4xx Authentication, 500 Internal, other 5xx Network | [V-src] `error.ts:7-22, 246-275` |
| Auth error shape | HTTP 401, `{"errors":[{"message":"Authentication required, not authenticated","extensions":{"type":"authentication error","code":"AUTHENTICATION_ERROR","statusCode":401,"userError":true,"userPresentableMessage":"You need to authenticate to access this operation.","meta":{},"http":{"status":401}}}]}` | [V-probe] |
| Validation error shape | HTTP 400, `message: "Cannot query field \"nope\" on type \"User\". Did you mean \"name\"?"`, `locations`, `extensions:{code:"GRAPHQL_VALIDATION_FAILED", type:"graphql error", userError:true, http:{status:400}}` | [V-probe] |
| Not-found and bad-input shapes | Reported as `type:"invalid input"`, `code:"INPUT_ERROR"` or `"INVALID_INPUT"`, plus `userPresentableMessage` (for example "Could not find referenced Issue." and "Priority cannot be higher than 4.") | [U] third-party reports only, see the sources. Probe with a key |
| Partial success | "GraphQL queries can partially succeed with a 200 HTTP status" | [V-doc] |
| Rate limits | Requests per hour: API key 2,500. OAuth 5,000 per user. Unauthenticated 600 | [V-doc] |
| Complexity limits | Points per hour: 3,000,000, 2,000,000 and 100,000 for the same three. 10,000 points per query. 0.1 per property, 1 per object. A connection multiplies by `first`, default 50 | [V-doc] |
| Rate limit errors | HTTP 400 with `RATELIMITED` | [V-doc] |
| Rate limit headers | `X-RateLimit-Requests-{Limit,Remaining,Reset}`, `X-Complexity`, `X-RateLimit-Complexity-{Limit,Remaining,Reset}`. The SDK also reads `retry-after` | [V-doc]. [V-src] `error.ts:124-131` |
| Anonymous limit mismatch | My anonymous probe returned `x-ratelimit-requests-limit: 1200`, not the documented 600 | [V-probe] |
| Pagination | Relay arguments `first/after`, `last/before`. Default 50. `nodes` or `edges{node cursor}`. `PageInfo{startCursor endCursor hasNextPage hasPreviousPage}`. `orderBy: PaginationOrderBy = createdAt\|updatedAt`. `includeArchived` default false. The max page size is not documented | [V-doc]. [V-src] |
| Filters | `eq neq in nin lt lte gt gte`, `eqIgnoreCase`, `contains*`, `startsWith*`, `endsWith*`, `null`. `and`/`or`. Relation filters (`assignee:{email:{eq}}`, `labels:{name:{eq}}`), `every`. Relative ISO durations such as `"P2W"` | [V-doc] filtering |

The core operations used most, as they appear in the SDL [V-src]:
- `issues(after before filter:IssueFilter first includeArchived last orderBy sort): IssueConnection!`
- `issue(id: String!): Issue!`. The docs show `issueUpdate(id: "BLA-123")`, so an identifier is accepted as the id.
- `teams(...)`, `workflowStates(...)`, `issueLabels(...)`, `projects(...)`, `cycles(...)`, `users(...)`, `viewer: User!`, `searchIssues(term: String! ...)`. `issueSearch` is deprecated.
- `issueCreate(input: IssueCreateInput!): IssuePayload!`. `IssueCreateInput` requires only `teamId: String!`. Other fields include `title description assigneeId stateId priority estimate labelIds cycleId projectId parentId dueDate subscriberIds`.
- `issueUpdate(id: String!, input: IssueUpdateInput!)`. It adds `addedLabelIds`, `removedLabelIds`, `trashed` and `teamId`.
- `IssuePayload { success lastSyncId issue }`.
- `commentCreate(input: CommentCreateInput!): CommentPayload!`, with `body` and `issueId`. Both are optional in the type.
- `issueRelationCreate(input: {issueId!, relatedIssueId!, type: IssueRelationType!})`, where `IssueRelationType = blocks | duplicate | related | similar`.
- `issueAddLabel(id, labelId)`, `issueBatchUpdate(ids: [UUID!]!, input)`, `issueArchive`, `issueDelete`.

Key field facts [V-src]:
- `WorkflowState.type: String!` has 7 values, not 6: "triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate".
- `Issue.priority: Float!`: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
- `Issue.number: Float!` is per team. `identifier` is team key plus number.
- `WorkflowState.position: Float!` sets order within a type.
- `Team.key`, `Team.triageEnabled` and `Team.defaultIssueState` exist.

Workflow rules [V-doc]:
- Every category needs at least one status.
- Marking an issue as a duplicate moves it to the Duplicate status automatically.

Any-to-any state moves over the API: [U]. I believe Linear does not enforce a transition graph. The fidelity run settles this.

## 2. Domain-level world (REST on the engine)

**Entities:** `user`, `team`, `workflow_state`, `issue_label`, `cycle`, `project`, `issue`, `comment`, `issue_relation`. The field names keep Linear's names in snake_case, so the facade maps them 1:1.

**The state machine.** Linear states are per-team rows, but the engine's `state` type is a fixed set. So I split it in two:
- `issue.state` is a ref to a `workflow_state` row of the same team.
- `issue.state_type` is a readonly `state` field over the 7 types. The machine enforces it.

The handler sets `state_type` from the chosen row. It also stamps `started_at`, `completed_at`, `canceled_at` and `triaged_at` the way the SDL fields suggest.

```yaml
meta:
  clock: { start: "2026-09-01T09:00:00Z", tick: 1s }
entities:
  team:
    idPrefix: team
    fields:
      key:            { type: text, required: true, unique: true }        # "ENG", "OPS"
      name:           { type: text, required: true }
      triage_enabled: { type: boolean, required: true }
      issue_counter:  { type: integer, readonly: true }                   # backs Issue.number
      default_state:  { type: ref, to: workflow_state }
  workflow_state:
    idPrefix: wfs
    fields:
      team:     { type: ref, to: team, required: true }
      name:     { type: text, required: true }                            # "In Review"
      type:     { type: enum, values: [triage, backlog, unstarted, started, completed, canceled, duplicate], required: true }
      position: { type: number, required: true }
  issue:
    idPrefix: iss
    fields:
      team:        { type: ref, to: team, required: true }
      number:      { type: integer, readonly: true }
      identifier:  { type: text, readonly: true, unique: true }           # ENG-42
      title:       { type: text, required: true }
      description: { type: text }
      priority:    { type: integer, min: 0, max: 4, required: true }      # 0 none .. 4 low
      estimate:    { type: number }
      assignee:    { type: ref, to: user }
      state:       { type: ref, to: workflow_state, required: true }
      state_type:  { type: state, readonly: true,
                     states: [triage, backlog, unstarted, started, completed, canceled, duplicate],
                     initial: backlog,
                     transitions:                                          # [U] confirm via fidelity run
                       { triage: [backlog, unstarted, started, completed, canceled, duplicate],
                         backlog: [unstarted, started, completed, canceled, duplicate],
                         unstarted: [backlog, started, completed, canceled, duplicate],
                         started: [backlog, unstarted, completed, canceled, duplicate],
                         completed: [backlog, unstarted, started, canceled],
                         canceled: [backlog, unstarted, started, completed],
                         duplicate: [backlog, unstarted, started, canceled] } }
      labels:      { type: refs, to: issue_label }
      cycle:       { type: ref, to: cycle }
      project:     { type: ref, to: project }
      parent:      { type: ref, to: issue }
      started_at:  { type: datetime, readonly: true }
      completed_at:{ type: datetime, readonly: true }
      canceled_at: { type: datetime, readonly: true }
      archived_at: { type: datetime, readonly: true }
  issue_relation:
    idPrefix: rel
    fields:
      issue:         { type: ref, to: issue, required: true }
      related_issue: { type: ref, to: issue, required: true }
      type:          { type: enum, values: [blocks, duplicate, related, similar], required: true }
  comment:
    idPrefix: cmt
    fields:
      issue: { type: ref, to: issue, required: true }
      user:  { type: ref, to: user, required: true }
      body:  { type: text, required: true }
actions:
  create_issue:
    method: POST
    path: "/issues"
    handler: |
      (ctx) => {
        const b = ctx.body;
        const team = ctx.db.get('team', b.team) ?? ctx.fail(400, 'invalid_input', 'Could not find referenced Team.');
        const st = b.state ? ctx.db.get('workflow_state', b.state) : ctx.db.get('workflow_state', team.default_state);
        if (!st || st.team !== team.id) ctx.fail(400, 'invalid_input', 'State does not belong to team.');
        const n = team.issue_counter + 1;
        ctx.db.update('team', team.id, { issue_counter: n });
        return { status: 201, body: ctx.db.create('issue', { ...b, team: team.id, number: n,
          identifier: `${team.key}-${n}`, state: st.id, state_type: st.type, priority: b.priority ?? 0 }) };
      }
  update_issue:            # PATCH /issues/{id}: re-derives state_type and stamps *_at
  create_relation:         # POST /issue_relations: type=duplicate moves issue to the team's duplicate state
```

Format gaps this exposes for the engine:
- A cross-ref constraint: `state.team == issue.team`.
- A per-parent counter for `number`.
- Actions that replace standard POST and PATCH for one entity.

Today these live in handlers. Each needs a decision row.

**Seed shape:**
- 5 users.
- 2 teams, ENG and OPS. ENG has triage enabled.
- 8 states per team: Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate. The names are [U] defaults. The types are [V-src].
- 6 labels: Bug, Feature, Improvement, customer, regression, security.
- 3 cycles per team (past, active, next).
- 2 projects.
- About 130 issues. ENG has 85, so lists pass the default page of 50.
- About 40 relations, mostly `blocks` and some cross-team.
- About 150 comments.
- Two pairs of near-duplicate titles.

**Tasks (rising difficulty):**

| # | Difficulty | Instruction | Grader core | Decoy |
|---|---|---|---|---|
| T1 | easy | File a bug in ENG: title "Login fails on Safari 18", priority High, label Bug, assign Dana. | One new issue in team ENG. priority==2, labels include Bug, assignee Dana, `state_type` = the team default type. No other writes (`ctx.changes()`). | Uses priority 1. |
| T2 | medium | Triage ENG: every Triage issue labeled `customer` becomes Urgent and moves to Todo. Every other Triage issue moves to Backlog. | All 62 seeded triage issues are resolved correctly. Non-triage rows are untouched. | Handles only the first page of 50. |
| T3 | hard | Close the active ENG cycle. Move each unfinished issue (type not completed, canceled or duplicate) to the next cycle. If an issue is blocked by an open OPS issue, move it to Backlog with no cycle, and comment "Blocked by OPS-n". | Per-issue expected cycle, state, comment body regex, relation-aware. | Ignores relation direction (it treats `related` as blocks, or flips issue and related). |
| T4 | hard | Dedupe ENG: for each pair with the same normalized title, mark the newer as a duplicate of the older and copy its open comments onto the older. | For each pair: a `duplicate` relation with the correct direction, the newer issue's `state_type==duplicate`, and the comments copied. No other relations. | Marks the older one as the duplicate. |

T2 grader sketch:

```yaml
grader: |
  (ctx) => {
    const tri = ctx.seed.list('issue', { where: { team: 'team_0001', state_type: 'triage' } });
    let ok = 0;
    for (const s of tri) {
      const i = ctx.db.get('issue', s.id), st = ctx.db.get('workflow_state', i.state);
      const cust = s.labels.includes('lbl_0004');
      if (cust ? (i.priority === 1 && st.name === 'Todo') : st.type === 'backlog') ok++;
    }
    const collateral = ctx.changes().filter(c => !tri.some(t => t.id === c.id)).length;
    return collateral ? 0 : ok / tri.length;
  }
```

`ctx.seed` is assumed here. If the engine lacks it, `ctx.changes()` before-values serve.

## 3. Wire-level option: a GraphQL facade

**The key finding.** The SDK's generated documents ask for far more than "a subset". The SDK `issues` query pulls 11 fragments and 159 fields. `issue` pulls 151 fields and `teams` pulls 85. The union over 14 common operations is 398 fields on 37 types. In the `Issue` fragment, 22 fields are non-null; in `Team`, 42 are.

Mutations are cheap. `createIssue`, `updateIssue` and `createComment` each select 6 fields (`success lastSyncId issue{id}`). SDK models then lazy-load by id. For example, `issue.state` calls `workflowState(id)`. So the singular lookups `workflowState`, `team`, `user` and `issueLabel` are needed too.

The narrowing rule is therefore "keep what the client's documents select". It is not "keep what we model". Modeled fields resolve from the store. Unmodeled non-null fields get deterministic zero defaults (`""`, `0`, `false`, `[]`, `{}`, clock start). Unmodeled nullable fields return `null`.

**Design.** `src/engine/graphql/` stays engine-side and has one dep, `graphql` (graphql-js). npm latest is 17.0.2 and needs Node >=22. Pin 16.x if 17 churn bites.
1. `prune.ts` builds a narrowed SDL from Linear's `schema.graphql`. It keeps the chosen root fields plus every type and field reachable from a set of `.graphql` documents (the SDK's `_generated_documents.graphql`, filtered to the operations we support). `IssueFilter` is cut to supported keys. Validation then rejects unsupported filters with a real `GRAPHQL_VALIDATION_FAILED`.
2. `meta.api.graphql` in world.yaml maps root fields to engine operations. For example `issues → list issue`, `issue → get issue (id or identifier)` and `issueCreate → action create_issue, payload IssuePayload`. It also maps field names (`assigneeId → assignee`) and error codes (`not_found → invalid input / INPUT_ERROR`).
3. Resolvers are sync and call `rt.call()`. graphql-js `executeSync` keeps it deterministic: no promises, ordered fields, the clock comes from the engine. Each top-level mutation field is one engine call, so it gets one overlay transaction and one tick. A failed field leaves no partial change. Mutation fields run serially, per the GraphQL spec. Whether real Linear commits across fields atomically is [U].
4. Relay: the cursor is base64 of the engine row id. Default `first` is 50. `nodes` and `edges` are both served. `orderBy` is createdAt or updatedAt. `includeArchived` filters on `archived_at`.
5. Errors use the shapes probed above: 401 auth, 400 `GRAPHQL_VALIDATION_FAILED`, and 200 or 400 for `invalid input` (status [U]). Rate limits are counter-based. Each call costs the documented complexity formula. Headers carry engine-clock resets. The limit is set low so a task can exercise `RATELIMITED`.
6. Auth: any non-empty `Authorization` header maps to a seeded user, giving `viewer`. A `Bearer lin_api_...` header returns the 401 shape.

**Agent-under-test experience:**

```ts
new LinearClient({ apiKey: "lin_api_world", apiUrl: "http://localhost:4000/graphql" })
```

This passes `validateApiUrl` because the host is localhost over http. `await client.issues({ filter: { state: { type: { eq: "triage" } } } })`, `issue.update()` and `createComment()` then behave as they do against real Linear, typed errors included. Raw GraphQL clients and hand-written queries work too.

**LOC:**

| Part | LOC |
|---|---|
| prune.ts | 150 |
| http endpoint and auth | 60 |
| connection and cursors | 80 |
| filter translator | 150 |
| resolvers and default resolver | 350 |
| error mapper | 80 |
| rate-limit and complexity | 70 |
| Total source | about 950 |
| Tests | about 400 |

**WorldGen's 4th input kind, `graphql_sdl`.** The input is `{ sdl: path|introspection-url, roots: [issues, issue, teams, workflowStates, issueCreate, issueUpdate, commentCreate], documents?: path }`.

The loader runs `buildSchema`. The digester prunes the schema and turns it into a model:
- Node types with an `id` become entities.
- Scalars map to FIELD_TYPES: String→text, Float/Int→number or integer, DateTime→datetime, TimelessDate→date, Boolean→boolean, JSON→json.
- Enums become enums.
- `String` fields whose description says "One of ..." become candidate enums. This catches `WorkflowState.type` and `IssueRelation.type` [V-src].
- Connections become inverse refs.
- `*Payload` types become mutation envelopes in `meta.api.graphql`.

Descriptions feed the plan. They hint at the state machine and the side effects. The model still writes the handlers and the transitions. The facade itself stays generic, with no Linear-specific code. That is about 300 LOC in `input.ts` plus a digest test.

## 4. Fidelity test

Write one scenario script against `@linear/sdk` and run it twice: once with `apiUrl` unset and a test-team key from env, once with `apiUrl` pointing at localhost.
- **Prelude.** The script creates its own fixtures through the SDK on both sides: issues, labels and relations, with a run tag in titles. Real Linear cannot be reset, so the engine seed for this scenario is "empty test team plus states".
- **Steps.** The script runs T1 to T3 style moves.
- **Bad calls.** Then it makes deliberate bad calls: an unknown stateId, a state from another team, priority 7, an unknown field, `first: 0`, an archived issue, and no auth.
- **Normalize.** Ids become symbols by creation order. Identifiers become `KEY-#rel`. Timestamps become order only. Labels and states become names and types. Unmodeled fields are dropped.
- **Compare.** Compare the end-state graphs and the per-call error class `(LinearError subclass, extensions.type, extensions.code, HTTP status)`.
- **Output.** The diff is a fidelity report with per-field and per-error match rates. Each mismatch either becomes an engine fix or is logged as a known deviation.

This also answers the [U] items: transition freedom, the not-found status, mutation atomicity and the identifier counter.

Cost on the real side is about 40 to 80 requests per run, well under 2,500 per hour. Cleanup archives tagged issues. It needs a key and a throwaway team in `yossi-zozo123`, created by the user.

## Effort

| Piece | Hours |
|---|---|
| Linear REST world.yaml: model, actions, seed generator | 6-8 |
| 4 tasks with solutions, decoys and graders passing `verify` | 5-7 |
| Engine gaps: cross-ref team constraint, per-team counter, action overriding a standard route | 3-5 |
| GraphQL facade core (endpoint, resolvers, Relay, filters) | 10-14 |
| SDL prune tool, SDK-document-driven | 3-4 |
| Linear error and rate-limit mapping | 2-3 |
| Facade tests (SDK end to end against localhost) | 4-6 |
| WorldGen `graphql_sdl` input kind and digest | 6-8 |
| Fidelity harness and normalizer, test team setup, first report | 7-9 |
| **Total** | **46-64** (REST-only path: 14-20) |

## Sources

Official:
- https://linear.app/developers/graphql
- https://linear.app/developers/rate-limiting
- https://linear.app/developers/pagination
- https://linear.app/developers/filtering
- https://linear.app/docs/configuring-workflows
- https://linear.app/docs/mcp (MCP: `https://mcp.linear.app/mcp`, streamable HTTP, OAuth 2.1. Tool names are not listed.)
- https://github.com/linear/linear/tree/master/packages/sdk/src (`client.ts`, `types.ts`, `error.ts`, `graphql-client.ts`, `schema.graphql`, `_generated_documents.graphql`)
- npm registry: `@linear/sdk` 97.0.0 (MIT, one dependency `@graphql-typed-document-node/core`, node >=22.12); `graphql` 17.0.2
- My own probes of `https://api.linear.app/graphql`, with no key

Third-party, not official, for the [U] error shapes only:
- https://github.com/brekkylab/backlot/issues/372
- https://github.com/brekkylab/backlot/issues/370
- https://github.com/elviskahoro/sdk-python-linear/issues/89

These appear to be prior art for a Linear mimic.
## KISS verdict

**KISS verdict: Linear world under the 8-day box**

I read `spec.md`, `decisions.md` and the tail of `architecture.md`. Nothing is built yet. The next step is still the hand-built helpdesk (A-42). The milestones below assume this rough plan: D1-D3 engine plus helpdesk, D4-D6 WorldGen stages, D7 eval on unseen prompts, D8 polish and live-run rehearsal.

**Core judgment.** The hiring team scores three things: engine guarantees, WorldGen on unseen prompts, and a live run. A GraphQL facade and an SDK showcase help none of the three. They cost 35 to 45 percent of the box (46-64h). The spec says "keep it small and strict". The facade's zero defaults for unmodeled non-null fields also go against "no silent guessing".

**Per piece**

| Piece | Verdict | When | Reason |
|---|---|---|---|
| Hand-built helpdesk as the golden world and few-shot | MUST | D2-D3 | It is already decided (A-42) and it is the spec's own example. Swapping now churns the plan for nothing. |
| Linear as a second world | SHOULD | D6-D7 | It is a good stress test: per-team states, counters, relations. Use it as a WorldGen eval prompt, not as a second golden world. |
| Who builds the Linear world | SHOULD | D6-D7 | WorldGen generates it from a description. A hand review against the facts table follows. Fixes go back to WorldGen. Hand-build only the gaps WorldGen cannot close, and log each one. |
| Linear facts table as a review checklist | SHOULD | D1 | It is cheap and well sourced. Keep it as a scratchpad file, or copy it into `research/` as Markdown under A-43 if you want it in the repo. |
| REST shape for Linear, logged as a `Spec:` decision row | MUST, if Linear is built | D6 | Linear has no REST API. The world copies Linear's domain, field names and error messages, not its wire format. Say so instead of hiding it. |
| Entities: user, team, workflow_state, issue_label, cycle, project, issue, comment, issue_relation | SHOULD | D6 | They match the SDL and are the minimum the tasks need. |
| Field names | COULD | D6 | Linear's camelCase (`triageEnabled`, `startedAt`) is closer to the real API than snake_case. The snake_case argument rested on the facade, and the facade is now WONT. |
| `state` ref plus readonly `state_type` machine | SHOULD | D6 | It fits A-10. Whether moves are any-to-any is [U]. A near-total transition graph enforces little, so keep it, but do not claim a real rule from it. |
| Per-team counter, `identifier` and the state.team == issue.team check | SHOULD, in handlers | D6 | Handler code is enough. Do not add engine format features for one world. |
| Engine gap: action replacing the standard POST/PATCH | WONT | n/a | Routes are explicit, so leave out the standard issue POST/PATCH and declare actions. Check that `check` allows that. |
| Engine gaps: cross-ref constraint and per-parent counter as format features | WONT | n/a | Only one world needs them. Add them only if a second generated world needs them too. |
| GET by identifier (`ENG-42`) | SHOULD | D6 | It is real Linear behavior [V-doc]. It costs one action or a unique-field lookup. |
| `ctx.seed` in graders | COULD | D4 | Before-values from `ctx.changes()` (A-28) already cover it. Add `ctx.seed` only if graders keep needing it. |
| T1 file a bug | MUST | D6 | Clean easy task with a discriminating decoy. |
| T2 triage | SHOULD, fixed | D6 | 62 triage issues out of 85 is a skewed state mix and will trip `seed.state_mix_skewed`. With about 15 triage rows, a triage filter returns one page, so the "first 50 only" decoy is moot. Use a decoy that leaves out the `customer` check instead. |
| T3 close the active cycle, relation-aware | SHOULD | D6 | A real hard task. The direction-flip decoy discriminates well. |
| T4 dedupe | COULD | D7 | Four tasks are more than the three required. "Open comments" is undefined, so define it or cut it. |
| Seed: 2 teams, 8 states, about 130 issues, relations, comments | SHOULD | D6 | Right size for paging. The state names are [U]. Confirm them read-only through the Linear MCP (question 3). |
| GraphQL facade in the engine | COULD, D8 only if all else is green; realistically WONT | D8 | About 950 source LOC plus 400 test LOC, and a second API surface to keep strict. It helps none of the judged axes. |
| SDL prune tool driven by SDK documents | WONT | n/a | Only needed for the facade. |
| Error mapping, rate limits, complexity | WONT | n/a | A Linear-only wire feature. Keep the Linear error messages in REST bodies. That costs nothing. |
| `@linear/sdk` showcase against the world | WONT for the trial | post-trial | Strong demo, but about 2.5-3 days on a path no judged criterion uses. Mention it in the design doc as the natural next step. |
| WorldGen `graphql_sdl` input kind | WONT | n/a | The spec needs description, OpenAPI or CSV. A fourth kind spreads effort thin before the live run. |
| Fidelity test against the real Linear API | WONT | post-trial | It needs a key and writes to the user's real workspace. It only checks wire behavior, which we are not building. |
| Fidelity spot check through the connected Linear MCP, read-only | COULD | D7 | 30 minutes. It settles the state names and the seed realism. No writes. |

**Final recommendation**
- Keep the helpdesk as the one hand-built golden world and few-shot (A-42). Do not replace it with Linear.
- Make Linear the second world. Build it with WorldGen from a description on D6-D7, and treat it as a rehearsal for the unseen-prompt live run.
- Review the generated Linear world against the facts table. Hand-fix only what WorldGen cannot repair, and log each fix as a WorldGen gap.
- Serve it as REST only. Write a `Spec:` decision row saying Linear is GraphQL-only and the world copies its domain, fields and error messages.
- Keep Linear's special logic (per-team counter, identifier, state belongs to team, duplicate moves state) in handlers. Add no engine format features for one world.
- Ship T1 to T3 with the fixes above (realistic triage count, a working T2 decoy). Move T4 to COULD.
- Drop the GraphQL facade, the prune tool, the `graphql_sdl` input, rate limits and the real-API fidelity harness for the trial. Name the facade and the SDK demo in the design doc as next steps.
- Spend the saved 30-45 hours on engine strictness (enforce, atomicity, determinism replay) and on WorldGen eval runs across description, OpenAPI and CSV prompts.

**Questions for the user**
1. **What should the Linear world prove?**
   - A: domain fidelity over REST, on the engine.
   - B: wire fidelity, with the real `@linear/sdk` running unchanged through a GraphQL facade.
   - C: both.
   - Recommendation: A. B costs about 3 days and helps no judged criterion. Keep B as a post-trial note.
2. **Who builds the Linear world?**
   - A: hand-built, as a second golden world.
   - B: generated by WorldGen from a description, then hand-reviewed.
   - C: hand-built, replacing the helpdesk as the golden world.
   - Recommendation: B. It tests the generator on a hard domain and keeps the helpdesk as the one few-shot.
3. **May I use your Linear workspace (yossi-zozo123) as a reference?**
   - A: no access.
   - B: read-only through the connected Linear MCP, to confirm state names, labels and a realistic state mix.
   - C: B plus an API key and a throwaway team for write-side fidelity runs.
   - Recommendation: B. It is cheap and settles the [U] seed names without writing to your real workspace.