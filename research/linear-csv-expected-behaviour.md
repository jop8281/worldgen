# Linear backlog CSV world: expected behaviour

This is the hand-checked oracle for the CSV case. A-54 (user decision U-9) makes the team's own Linear backlog CSV the CSV input. YOS-48, YOS-49 and YOS-50 read it. It says what WorldGen must infer from the export, what the resulting world must do, and what must never leave the machine unredacted.

Sources:

- `research/linear.md` (T1 testbed: the metrics and the risks)
- `research/linear-world.md` (Linear facts table, the state model and the KISS verdict)
- `research/factory/backlog.json` on `factory/integration` `7ec4771`, now archived at `research/archive/factory/backlog.json` (the draft of 67 work orders; the live Linear team holds 54)
- Linear's docs ([exporting data](https://linear.app/docs/exporting-data), read 2026-10-06)
- the engine at `7ec4771` (`fields.ts` CSV inference, `worldgen/input.ts`)

How claims are marked:

- **[doc]**: Linear's docs say it.
- **[src]**: Linear's SDL or SDK says it (as recorded in `linear-world.md`).
- **[engine]**: the code at `7ec4771` does it.
- **[world]**: our decision.
- **[unsure]**: not confirmed. It needs one real export to settle. No real export was read for this note, because no Linear tool or fixture was available in this session.

## 1. What the export contains

### Columns [doc]

The CSV has these 29 columns, in this order [doc: "The export contains these exact columns"]:

`ID, Team, Title, Description, Status, Estimate, Priority, Project ID, Project, Creator, Assignee, Labels, Cycle Number, Cycle Name, Cycle Start, Cycle End, Created, Updated, Started, Triaged, Completed, Canceled, Archived, Due Date, Parent issue, Initiatives, Project Milestone ID, Project Milestone, SLA Status`

- **Limits:** members can export up to 250 issues; admins can export views of up to 2,000 [doc]. The backlog (54 issues) fits.
- **Not exported:** attachments [doc], comments and issue relations (blocks, duplicate, related). No column carries them [doc, by omission]. The CSV has no relation columns, and the docs do not mention comments.
- **[unsure], settle each on the first real export:**
  - the Labels separator (comma inside a quoted cell is likely)
  - the date format and timezone of Created, Updated, Started and the other date columns
  - whether Priority is a label ("High", "No priority") or a number (0–4)
  - whether Creator and Assignee are display names or emails
  - whether Parent issue holds an identifier (`YOS-12`) or a title
  - whether a label in a group exports as `engine` or `area/engine`

### What the YOS backlog should look like in it [world, from the sources]

| Column | Expected content for team YOS |
|---|---|
| ID | `YOS-<n>`, unique per row |
| Team | one value (the YOS team name) |
| Title | the work-order title. In `backlog.json`, 67 of 67 titles are distinct. |
| Description | long Markdown, with `## Goal`, `## Context` and `## Acceptance` sections, as in `backlog.json` `body` |
| Status | team status names. Planned set (`linear.md` section 3): Backlog, Todo, In Progress, In Review, Done, Canceled, with triage off. Linear also creates a Duplicate status by default [unsure for this team]. |
| Estimate | mostly blank (no estimates planned) |
| Priority | High for `must`, Medium for `should`, Low for `could`, Urgent only for the critical path (`linear.md` section 3). In the draft, 66 of 67 are `must`. |
| Project ID, Project | one project, "WorldGen" |
| Creator, Assignee | a handful of people. **Personal data, redact them** (section 6). |
| Labels | one `area` label (engine, worldgen, eval, docs, infra) plus one `kind` label (feature, decision, chore, test) per issue |
| Cycle Number, Cycle Name, Cycle Start, Cycle End | all blank (no cycles, per `linear.md`) |
| Created, Updated, Started, Completed, Canceled | timestamps. Triaged is blank (triage is off). |
| Archived, Due Date, Initiatives, SLA Status | expected to be all blank |
| Parent issue | mostly blank |
| Project Milestone ID, Project Milestone | D1 to D8 |

## 2. What WorldGen must infer

### Column types, through FIELD_TYPES [engine]

`input.ts` must take column types from `FIELD_TYPES[t].inferFromCsv` and never from a local switch [engine: `input.ts` invariant]. The types are tried in `FIELD_TYPE_ORDER`: bool, int, money (never inferred), number, datetime, enum, string, text. The first type that accepts the column wins.

The inference rules:

- **int, number, bool:** every non-blank cell must match. A blank cell makes the field `nullable`.
- **datetime:** every non-blank cell must be ISO 8601 **UTC with `Z`**. `2026-10-06 12:00:00` and `+02:00` offsets are rejected [engine: `fields.ts` datetime examples]. If Linear's export is not in Z form, the loader must normalise dates to UTC Z before inference. Otherwise the date columns fall through to `string`.
- **enum:** at least 30 rows and at most 20 distinct non-blank values (`ENUM_MIN_ROWS = 30`, `ENUM_MAX_DISTINCT = 20`).
- **string:** every cell is 200 characters or fewer (`STRING_MAX_CHARS`). Otherwise the column is `text`.

There is no multi-value field type, and `ref` is never inferred by FIELD_TYPES ("A column of ids cannot name its target entity") [engine]. The digester infers refs (below).

Expected result on a 54-row export:

| Column | Raw inference | Final field after normalisation |
|---|---|---|
| ID | string (54 distinct, too many for enum) | `issue.identifier`, string, unique, candidate key |
| Team | enum with one value | becomes the entity `team`. `issue.team` ref. |
| Title | string, or text if any title is over 200 characters | `issue.title`, string, required |
| Description | text | `issue.description`, text, nullable |
| Status | enum (6–7 names) | becomes the entity `workflow_state`. `issue.state` ref plus `issue.state_type` state field (section 3). |
| Estimate | int, nullable (or dropped if all blank) | `issue.estimate`, int, nullable |
| Priority | enum of labels, or int 0–4 | `issue.priority`, int 0–4: 0 none, 1 urgent, 2 high, 3 medium, 4 low [src]. If exported as labels, map them to numbers. |
| Project ID + Project | enum with one value each | the entity `project`. `issue.project` ref. |
| Creator, Assignee | enum (few people) | the entity `user`. `issue.creator` and `issue.assignee` refs, nullable. |
| Labels | an enum of label *combinations*, which is wrong | split on the separator: the entity `label` plus a join entity `issue_label` (issue ref, label ref, unique pair enforced by the handler). The engine has no list-of-refs type. The `refs` type in `linear-world.md` does not exist in FIELD_TYPES. |
| Cycle Number, Cycle Name, Cycle Start, Cycle End | all blank | dropped, and the report lists them |
| Created, Updated | datetime (after normalisation) | the engine's `created_at` and `updated_at`, set explicitly by seed (privileged writes may set them) [engine: `store.ts`] |
| Started, Completed, Canceled | datetime, nullable | `issue.started_at`, `completed_at`, `canceled_at`, readonly |
| Triaged, Archived, Due Date, Initiatives, SLA Status | all blank | dropped, and the report lists them |
| Parent issue | string, nullable | `issue.parent` ref to issue (self-reference, matched on identifier) |
| Project Milestone ID + Project Milestone | enum (8 values) | the entity `milestone` (name, project ref). `issue.milestone` ref. |

### Entities and candidate keys

A candidate key is a column whose non-blank values are 100% distinct across the rows that represent one entity.

| Entity | Comes from | Candidate key | Other fields |
|---|---|---|---|
| `issue` | each CSV row | `identifier` (ID). `title` is distinct in the draft but is not a key, because Linear allows duplicate titles. | see above |
| `team` | distinct Team | `name`. `key` is the ID prefix (`YOS`). | |
| `project` | distinct (Project ID, Project) | `source_id` (Project ID, a UUID) | `name` |
| `milestone` | distinct (Project Milestone ID, Project Milestone) | `source_id` | `name` (D1 to D8), `project` ref |
| `label` | split Labels cells | `name` | `group` (area or kind) if the export prefixes it |
| `user` | Creator ∪ Assignee | the redacted `name` (section 6) | |
| `workflow_state` | distinct Status | `name` | `type` (one of 7), `position` |

### Ref inference: the 95% rule

Column C becomes a ref to entity E on key K when at least 95% of C's non-blank cells equal some value of E.K, after trimming. The other 5% at most go to the report as unresolved, and are never silently dropped.

| Ref | Expected match | Note |
|---|---|---|
| `issue.team` to `team.name` | 100% | |
| `issue.project` to `project.source_id` | 100% of non-blank | Project and Project ID must agree row by row. A mismatch is a load error. |
| `issue.milestone` to `milestone.source_id` | 100% of non-blank | the same pairing rule |
| `issue.assignee` and `issue.creator` to `user.name` | 100% (the user table is built from these columns) | |
| `issue_label.label` to `label.name` | 100% after the split | Without a split it is about 0%, and that is the test that the split happened. |
| `issue.parent` to `issue.identifier` | at least 95% | A parent outside the export (another team, or beyond the limit) is the expected miss. Keep it as an unresolved note, never as a dangling ref. |
| Text `Blocked by: YOS-n` lines in Description | **not inferred** | Relations are not in the CSV. WorldGen must not invent `issue_relation` rows. It may report that some descriptions contain dependency text. |

This matches the metric in `linear.md` (T1): "100% of non-empty Team, Project, Assignee, Labels, Parent cells resolve to refs". The 95% threshold is the inference trigger. The T1 pass bar is still 100% for every column except Parent.

## 3. Workflow states

The facts:

- `WorkflowState.type` has **7** values: triage, backlog, unstarted, started, completed, canceled, duplicate [src].
- States are per-team rows with a `position` [src]. Every category needs at least one status [doc: configuring workflows].
- Marking an issue as a duplicate moves it to the Duplicate status automatically [doc].
- Linear documents **no transition rules**. Any-to-any moves over the API are believed allowed [unsure, `linear-world.md` section 1].
- The CSV gives the **status name only, not its type**.

### A faithful machine [world]

```yaml
workflow_state:            # rows: one per status of the team
  fields: { name: string unique, type: enum [triage, backlog, unstarted, started, completed, canceled, duplicate], position: number }
issue:
  fields:
    state:      { type: ref, entity: workflow_state, required: true }     # what the API sets
    state_type: { type: state, readonly: true, initial: backlog,
                  states: [triage, backlog, unstarted, started, completed, canceled, duplicate],
                  transitions: { <each of the 7>: <the other 6> } }       # complete graph
```

- **The complete graph is the faithful choice.** Each type may move to each of the other six, and a move within the same type is never checked by the store [engine]. A world that invents stricter rules is wrong. T2 in `linear.md` flags it as `transitions.stricter_than_real`. The machine still earns its place: it rejects a type name that does not exist, and it keeps the moves declared as data.
- `state_type` is derived. The issue update handler sets it from the chosen `workflow_state` row in the same write, and the API cannot write it.
- **Timestamps on entering a type:** entering started stamps `started_at` if it is empty. Entering completed stamps `completed_at`, and entering canceled stamps `canceled_at`. [unsure] Whether leaving completed clears `completed_at` in real Linear. The world clears it, so that "completed_at set exactly when the type is completed" holds as an invariant.
- **All 7 types exist as rows,** even ones the export never shows. Linear guarantees at least one status per category [doc]. Unseen types get Linear's default names (Triage, Duplicate) [unsure for names], and the report marks them as defaults.
- `initial` is `backlog`, because YOS has triage off. A create with no state gets the team's default backlog-type status.

### Mapping status names to types (hand label, used as the "at least 90% right" check in `linear.md` T1)

| Status name | Type |
|---|---|
| Triage | triage |
| Backlog | backlog |
| Todo | unstarted |
| In Progress | started |
| In Review | started |
| Done | completed |
| Canceled | canceled |
| Duplicate | duplicate |

WorldGen infers these types from names, with the timestamp columns as evidence:

- a row with Completed set is completed
- Canceled set is canceled or duplicate
- Started set and neither Completed nor Canceled is started
- otherwise unstarted or backlog

The name decides between unstarted and backlog. YOS-49 scores the inferred mapping against this table.

### Errors the world returns (copying Linear's messages, REST shape per the `linear-world.md` KISS verdict)

| Bad call | Status | Body `message` |
|---|---|---|
| Unknown issue id or identifier | 404 | "Could not find referenced Issue." [unsure: Linear reports this as `invalid input`] |
| `state` that is not a workflow_state row | 400 | "Could not find referenced WorkflowState." |
| Priority outside 0–4 | 400 | "Priority cannot be higher than 4." [unsure, third-party report] |
| Writing `state_type`, `identifier`, `created_at`, or any `*_at` stamp directly | 422 | engine `field.readonly` |
| Adding the same label twice | 409 | engine `field.unique`, or the handler refuses |

## 4. A believable seed

The seed **is the export**, loaded from `world.fixtures` (written by code, never by the model [engine: `input.ts`]). It is not synthesised. Being believable means being faithful and internally consistent:

1. **Row count.** Issue rows = CSV rows (54 at 2026-10-06), the `linear.md` T1 metric. No invented issues, users, labels or milestones.
2. **Identity.** `identifier` is kept verbatim (`YOS-n`). The engine row id (`iss_0001`) is separate, assigned in identifier-number order, so `iss_000n` and `YOS-m` map monotonically.
3. **Timestamp consistency** on every row:
   - `created_at <= started_at <= completed_at`
   - `created_at <= updated_at`
   - `completed_at` set exactly when `state_type` is completed
   - `canceled_at` set exactly when the type is canceled or duplicate
   - `started_at` set for every started row (and allowed on completed rows)

   A row that breaks one of these is reported, not "fixed" silently.
4. **The clock:** `meta.clock.start` = the export time. Use the latest `Updated` timestamp, rounded up to the next hour, so every seeded time is at or before the start.
5. **State mix:** the real one, whatever it is on export day. `seed.state_mix_skewed` is a warning only, and a real backlog early in a project is skewed toward Todo. The report states the mix and does not rebalance it.
6. **Paging:** 54 issues against `pageSize` 25 gives 3 pages. That is above the paging lint, so "search and paging matter" holds without padding.
7. **Labels:** every issue has exactly one `area` label and one `kind` label, if the team kept to `linear.md`. Any exception is a fact about the data, reported.
8. **Columns that are blank in every row are dropped,** and the report lists them. A column that is blank in only some rows is kept as nullable.

## 5. Three graded tasks, each with decoys

The anchors are titles from `backlog.json`. YOS-49 must check that each anchor exists in the real export, and swap in an issue of the same shape if not. Graders take targets from `ctx.seed` and apply a collateral gate with `ctx.changes()`: a change to anything that is not a target scores 0. User names are the redacted pseudonyms (section 6).

### Task 1 (easy): start a named issue

> Move the issue "Decide: retire the Python engine (engine-v1) and the Python acceptance harness" to In Progress and assign it to user_02.

- Grader: 1 if that issue's `state` is the "In Progress" row and its `assignee` is user_02, with the gate. Otherwise 0. Noop: 0, unless the seed already matches, in which case pick another anchor.
- Solution: `GET /issues?q=retire the Python engine`, then `GET /workflow_states`, then `PATCH /issues/{id} {state: <In Progress id>, assignee: <user_02 id>}`.
- Decoy (a), "picks In Review, the other started-type status": `state_type` is the same, but the grader checks the status row, so it scores 0. This proves the grader reads the status, not just its type.
- Decoy (b), "assigns the right status to the wrong user": scores 0.

### Task 2 (medium): assign unowned engine work in D2

> Assign every unassigned issue in milestone D2 that has the label "engine" and is in Todo to user_01. Change nothing else.

- Targets: the seed issues with milestone D2, label engine, status Todo and no assignee. There are 2 or more of them [check on export]. The label join forces a second lookup.
- Grader: gate first, then the fraction of targets with `assignee = user_01`.
- Solution: `GET /milestones?name=D2`, `GET /labels?name=engine`, then page through `GET /issues?milestone=<D2>&state=<Todo>`. For each issue, check `GET /issues/{id}/labels` and that `assignee` is null, then `PATCH`.
- Decoy (a), "ignores the label filter": it assigns D2 Todo issues that are not engine issues. The gate gives 0.
- Decoy (b), "overwrites issues that already have an assignee": the gate gives 0.

### Task 3 (hard): roll over the slipped D1 milestone

> Milestone D1 slipped. Move every unfinished D1 issue (any status that is not completed, canceled or duplicate) to milestone D2, keeping its status. Then set priority to Urgent on the moved issues labelled "decision". Change nothing else.

- Targets: let T be the D1 issues whose `state_type` is not completed, canceled or duplicate, and Tdec the members of T with the label decision.
- Grader: gate first. Then the score per issue in T, averaged: 1 if the milestone is D2, the state is unchanged, and the priority is 1 when the issue is in Tdec (unchanged otherwise). Every strict prefix of the solution scores below 1.
- Solution: page through `GET /issues?milestone=<D1>` (D1 holds 14 of the 67 draft issues). Resolve each status row's `type`, `PATCH` the milestone, then `PATCH` the priority for decision-labelled issues.
- Decoy (a), "decides unfinished by status name (Todo, In Progress) and misses Backlog and In Review": it scores below 1.
- Decoy (b), "also moves Canceled issues": the gate gives 0.
- Decoy (c), "sets Urgent on every moved issue": the non-decision issues score 0, so the total is below 1.
- Decoy (d), "reads only the first page": it scores below 1, if T spills past 25 rows when listed unfiltered. If D1 fits in one page under the milestone filter, drop this decoy, because it would be trivial.

## 6. Redaction (must happen in `redact()`, before `digest`)

`input.ts` makes `redact()` the only minter of `Redacted<...>`, and digesters, events and attempt dumps see only redacted data [engine]. For CSV, `redact()` must:

| Column | Treatment | Why |
|---|---|---|
| Creator, Assignee | replace each distinct person with a stable pseudonym (`user_01`, `user_02`, …), numbered in order of first appearance. Never derived from the name or email. | names and emails are personal data |
| Description | remove email addresses. Replace local home paths (`/Users/<name>/…`, `~/…` with a user part) with `<home>/…`. Replace GitHub handles and repo URLs (`github.com/<owner>/…`) and the Linear workspace URL (`linear.app/<workspace>`) with placeholders. Drop any line that looks like a credential assignment (`*_KEY=`, `token:`). | the backlog bodies contain machine paths and repo and workspace names |
| Title | unchanged, except emails and URLs are stripped the same way | |
| Project ID, Project Milestone ID | keep (random UUIDs, no personal data) | they are needed for ref pairing |
| Every other column | unchanged | |

Rules:

- The pseudonym map stays in memory. It is never written to `events.jsonl`, attempt dumps, `world.yaml` or the report.
- Redaction is deterministic, so two runs over the same CSV give identical fixtures (architecture decision 7: determinism is checked per world).
- The committed fixture (`eval/inputs/linear-backlog.csv`) is the **redacted** file only. Whether even that may be committed is open (`linear.md` question 5, `portfolio.md` Q2). Until the user answers, keep the raw export outside the repo and commit nothing.
- Check: after `redact()`, a scan of the fixture for `@`, `/Users/`, `github.com/` and the workspace slug finds nothing. YOS-48 should make this a test.

## 7. Open points

1. The [unsure] export details in section 1 (separator, date format, priority form, person columns, parent format, label groups). One real export settles all of them. The loader must normalise dates to UTC Z before inference, or the date columns become strings.
2. The world is REST, while Linear is GraphQL-only. Write that down as a `Spec:` decision, per the KISS verdict in `linear-world.md`.
3. Permission to commit the redacted fixture (section 6).
4. Whether a Duplicate status exists in team YOS, and which default names to use for the unseen types (section 3).
5. Engine format: there is no list-of-refs type, so labels need the join entity. If more CSV worlds need multi-value cells, consider a `refs` field type in FIELD_TYPES, with `inferFromCsv` taking a separator. Until then the digester splits the cells.
