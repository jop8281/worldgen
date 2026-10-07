# Golden helpdesk world: expected behaviour

This is a hand-checked behaviour table for `prod/worlds/helpdesk`, the world for "a helpdesk with SLA tiers and on-call escalation". YOS-20 (model), YOS-21 (workflow), YOS-27 (seed and tests) and YOS-39 (tasks) read it. It is a target, not the world itself. It names entities, routes, transitions, errors, timers and tasks precisely enough that each unit can write its section and a reviewer can check the result line by line.

Sources: `research/spec.md`, `research/architecture.md`, and the engine contract on `factory/integration` at `d6326b7` (`format.ts`, `fields.ts`, `store.ts`, `ctx.ts`, `clock.ts`, `api.ts`). `origin/main` is the same engine minus `runtime()`.

## 0. What the engine gives us, and what it does not yet

Every rule below is built from four engine features: entities with typed fields, actions (JS handlers on a route), jobs (JS on a fixed interval), and the engine clock.

| Capability | Status at `d6326b7` | Consequence for this world |
|---|---|---|
| Field types, `required`, `nullable`, `unique`, `readonly`, refs | Live (`store.ts`) | Data-model errors below are exact engine codes. |
| `state` field with `transitions` map | Live. Checked on every write against the value **before the transaction**. A write that keeps the same state is never checked. | A handler can move a ticket one hop per call. `escalated -> escalated` (level 1 to level 2) needs no declared self-transition. |
| Seed writes | Privileged: may set readonly fields and any declared state, with no initial-state check | Seed can place tickets directly in `escalated`, `resolved` or `closed`. |
| Standard routes (list, get, create, update, delete), filters, search, sort, cursor paging | Live (`api.ts`) | Paging is real. A list route returns at most `pageSize` (25) rows. |
| Clock: starts at `meta.clock.start`, +`tick` (1s) per **successful** call | Live (`runtime()`) | A failed call does not move time. |
| Actions | **Not live**: every action returns `501 action.unavailable` until engine-actions-jobs lands | Rows marked **[A]** depend on it. |
| Jobs and `advance` | **Contract only**: `dueJobs` is pure and tested, `Runtime.advance` throws | Rows marked **[J]** depend on it. Jobs fire at `start + k*every` for k >= 1, in (time, job name) order, each in its own transaction. |
| `check`, `grade`, `verifyTask` | Contract only | Section 7 is written against the `tasks.ts` rules (solution 1, noop 0, decoys < 1, every strict prefix < 1). |
| Client scripts (tests, solutions, decoys) | `ctx.api`, `ctx.assert`, `ctx.now` only. **No clock control.** | World `tests` cannot exercise jobs or the `no_oncall` guard. Those need engine-level tests in `code/test` that use `Runtime.advance`. See section 9. |

Two engine facts change the design, so they are stated here once:

- **There is no composite unique.** `unique` is per field. `sla_policy` gets a unique `code` such as `enterprise_urgent`, and the seed guarantees one row per (tier, priority).
- **Stored datetimes are not normalised.** `2026-03-02T09:00:00Z` and `2026-03-02T09:00:00.000Z` both validate, but snippets compare raw strings, and `'Z' > '.'`. Every datetime this world writes must come from `ctx.now()` or `ctx.time.plus()`, which both return the canonical `.000Z` form. Graders and jobs should compare with `ctx.time.minutesBetween`, not `<`.

## 1. Entities and their states

Clock: `meta.clock.start = 2026-03-02T09:00:00.000Z` (a Monday), `tick = 1s`. Below, **S** means that instant. Ids look like `<idPrefix>_0001`. `id`, `created_at` and `updated_at` are implicit and maintained by the engine.

| Entity | idPrefix | Fields (r/o = readonly) | States |
|---|---|---|---|
| `customer` | `cus` | `name` string required, `tier` enum [standard, premium, enterprise] required, `email` string unique | none |
| `agent` | `agt` | `name` string required, `email` string required unique, `team` enum [tier1, tier2, sre] required, `active` bool default true | none |
| `sla_policy` | `sla` | `code` string required unique (`<tier>_<priority>`), `tier` enum (same values as customer.tier), `priority` enum (same values as ticket.priority), `resolution_minutes` int min 5 | none |
| `oncall_shift` | `onc` | `agent_id` ref agent (restrict), `level` int min 1 max 2, `starts_at` datetime required, `ends_at` datetime required | none |
| `ticket` | `tkt` | `subject` string required, `description` text, `customer_id` ref customer r/o, `assignee_id` ref agent nullable r/o (onDelete nullify), `priority` enum [low, normal, high, urgent] required r/o, **`status` state r/o**, `escalation_level` int 0..2 default 0 r/o, `escalated_at` datetime nullable r/o, `sla_started_at` datetime r/o, `sla_due_at` datetime r/o, `sla_breached` bool default false r/o, `resolved_at` datetime nullable r/o | `new`, `open`, `escalated`, `resolved`, `closed` |
| `ticket_event` | `evt` | `ticket_id` ref ticket (restrict), `kind` enum [created, assigned, escalated, sla_breach, priority_changed, resolved, reopened, closed], `note` text nullable, `actor_id` ref agent nullable | none (append-only) |

Only `subject` and `description` can be written by `PATCH /tickets/{id}`. Every other ticket field is readonly, so it changes only through an action, a job or seed. `assignee_id` and `priority` are readonly on purpose. A plain write to them would skip the state change (`new -> open`) or the SLA recomputation that must happen with them.

### Ticket status machine (data, enforced by the store)

```yaml
status: { type: state, readonly: true, initial: new,
          states: [new, open, escalated, resolved, closed],
          transitions: { new: [open, escalated], open: [escalated, resolved],
                         escalated: [resolved], resolved: [open, closed], closed: [] } }
```

### Per-state invariants (also what seed must satisfy)

| State | Invariant |
|---|---|
| `new` | `assignee_id` null, `escalation_level` 0, `escalated_at` null, `resolved_at` null |
| `open` | `assignee_id` set, `escalation_level` 0, `escalated_at` null, `resolved_at` null |
| `escalated` | `escalation_level` in {1, 2}. `assignee_id` is the agent of the `oncall_shift` at that level that covered `escalated_at`. `resolved_at` null. |
| `resolved` | `assignee_id` set, `resolved_at` set, `resolved_at > now - 72h` (otherwise `auto_close` would already have closed it) |
| `closed` | `resolved_at` set and `<= closing time - 72h`. Final. |

## 2. Routes

| Route | Kind | Notes |
|---|---|---|
| `GET /customers` | list | filters `tier`, search `name`, sort `name` |
| `GET /customers/{id}` | get | |
| `GET /agents` | list | filters `team`, `active`, search `name`, `email` |
| `GET /oncall` | list `oncall_shift` | filters `level`, `agent_id`, sort `starts_at` |
| `GET /sla_policies` | list | filters `tier`, `priority` |
| `GET /tickets` | list | filters `status`, `priority`, `customer_id`, `assignee_id`, `sla_breached`, `escalation_level`; search `subject`; sort `created_at`, `sla_due_at`; pageSize 25 |
| `GET /tickets/{id}` | get | |
| `PATCH /tickets/{id}` | update | only `subject`, `description` succeed |
| `GET /tickets/{ticket_id}/events` | list `ticket_event` | the path param names the column, so it filters by ticket |
| `POST /tickets` | action `create_ticket` **[A]** | input `customer_id` ref required, `subject` required, `description`, `priority` required |
| `POST /tickets/{id}/assign` | action `assign` **[A]** | input `agent_id` ref required |
| `POST /tickets/{id}/escalate` | action `escalate` **[A]** | input `reason` text required |
| `POST /tickets/{id}/resolve` | action `resolve` **[A]** | input `note` text optional |
| `POST /tickets/{id}/reopen` | action `reopen` **[A]** | input `reason` text required |
| `POST /tickets/{id}/priority` | action `change_priority` **[A]** | input `priority` enum required |

There is no ticket `DELETE` and no ticket create route other than the action, because creating a ticket must compute the SLA (readonly fields). `DELETE /tickets/{id}` returns `405 method.not_allowed`, because other methods match that path.

## 3. Legal state transitions

"On-call(L, t)" means the single `oncall_shift` with `level = L` and `starts_at <= t < ends_at`. The interval is half-open, so exactly one shift matches at a boundary. "Target(tier, prio)" is `sla_policy.resolution_minutes` for the customer's tier and the ticket's priority.

| # | From | To | Trigger | Guard (in check order) | Effects |
|---|---|---|---|---|---|
| T1 | (none) | `new` | action `create_ticket` | customer exists | `sla_started_at = now`, `sla_due_at = now + Target`, event `created` |
| T2 | `new` | `open` | action `assign` | agent exists, agent `active` | `assignee_id`, event `assigned` |
| T3 | `open` | `open` | action `assign` (reassign) | agent exists and active, agent differs from the current assignee | `assignee_id`, event `assigned` |
| T4 | `new` | `escalated` | action `escalate` | level < 2, On-call(1, now) exists | level 1, `escalated_at = now`, `assignee_id` = on-call agent, event `escalated` with note = reason |
| T5 | `open` | `escalated` | action `escalate` | same as T4 | same as T4 |
| T6 | `escalated` | `escalated` | action `escalate` (L1 to L2) | level = 1, On-call(2, now) exists | level 2, `escalated_at = now`, `assignee_id` = L2 agent, event `escalated` |
| T7 | `new` / `open` | `escalated` | job `sla_breach`, auto-escalation pass **[J]** | priority `urgent`, `sla_breached`, level 0, On-call(1, now) exists | as T4, note `auto: SLA breach` |
| T8 | `escalated` | `escalated` | job `escalation_timeout` **[J]** | priority `urgent`, level 1, `escalated_at <= now - 60m`, On-call(2, now) exists | as T6, note `auto: L1 timeout` |
| T9 | `open` | `resolved` | action `resolve` | none | `resolved_at = now`, event `resolved` |
| T10 | `escalated` | `resolved` | action `resolve` | none | same as T9. The level is kept, for history. |
| T11 | `resolved` | `open` | action `reopen` | none | `resolved_at = null`, level 0, `escalated_at = null`, `sla_started_at = now`, `sla_due_at = now + Target`, `sla_breached = false`, assignee kept, event `reopened` |
| T12 | `resolved` | `closed` | job `auto_close` **[J]** | `resolved_at <= now - 72h` | event `closed` |

Writes that keep the state (the store does not check them):

| Trigger | Allowed in | Effect |
|---|---|---|
| action `change_priority` | `new`, `open`, `escalated` | `sla_due_at = sla_started_at + Target(new priority)`, `sla_breached = sla_breached OR sla_due_at <= now`. Emits `priority_changed`, plus `sla_breach` if the flag flipped. |
| job `sla_breach`, flag pass **[J]** | `new`, `open`, `escalated` | `sla_breached = true` when `sla_due_at <= now`. Emits event `sla_breach` once. |
| `PATCH /tickets/{id}` | every state, including `closed` | `subject`, `description` |

Jobs must never throw. A job firing is one transaction, so one throw would roll back every breach in that firing. Jobs check their guards and skip rows that fail them, and a skipped row is retried at the next firing.

## 4. Illegal transitions and expected errors

Every failed call returns the world's error envelope `{ error: { code, message } }`, writes nothing, and does not move the clock. Handlers check guards in this order: `not_found`, `invalid_state`, specific guard. The store's `422 state.transition` is a backstop that only a handler bug can reach.

### Through actions [A]

| Call | From state | Status | Code | Message must say |
|---|---|---|---|---|
| any action on a missing ticket | | 404 | `not_found` | `ticket <id> not found` |
| `assign` | `escalated` | 409 | `invalid_state` | escalated tickets belong to on-call. Escalate or resolve. |
| `assign` | `resolved`, `closed` | 409 | `invalid_state` | the current state, and that only `new` and `open` can be assigned |
| `assign` to an inactive agent | `new`, `open` | 409 | `agent_inactive` | agent id |
| `assign` to the current assignee | `open` | 409 | `no_change` | |
| `assign` to a missing agent | | 422 | input validation (code from engine-actions-jobs; store analogue `ref.unresolved`) | |
| `escalate` | `resolved`, `closed` | 409 | `invalid_state` | |
| `escalate` | `escalated` at level 2 | 409 | `max_escalation` | `already at level 2` |
| `escalate` with no shift at the next level | `new`, `open`, `escalated` L1 | 409 | `no_oncall` | the level and the time |
| `escalate` without `reason` | | 422 | input validation (store analogue `field.required`) | |
| `resolve` | `new` | 409 | `invalid_state` | assign before resolving |
| `resolve` | `resolved`, `closed` | 409 | `invalid_state` | |
| `reopen` | `new`, `open`, `escalated` | 409 | `invalid_state` | |
| `reopen` | `closed` | 409 | `invalid_state` | closed tickets cannot be reopened |
| `change_priority` | `resolved`, `closed` | 409 | `invalid_state` | |
| `change_priority` to the same value | | 409 | `no_change` | |
| `create_ticket` with an unknown `customer_id` | | 422 | `unknown_customer` (the handler must read the tier first) | |
| `create_ticket` with `status` in the body | | 422 | input validation: `status` is not an input field | |

### Through plain writes (live today)

| Call | Status | Code (engine) |
|---|---|---|
| `PATCH /tickets/{id}` with `status`, `priority`, `assignee_id`, `sla_*`, `escalation_*`, `resolved_at` or `customer_id` | 422 | `field.readonly` |
| `PATCH /tickets/{id}` with `id`, `created_at` or `updated_at` | 422 | `field.readonly` |
| `PATCH /tickets/{id}` with an unknown field | 422 | `field.unknown` |
| `PATCH /tickets/{id}` on a missing id | 404 | `row.not_found` |
| `DELETE /tickets/{id}` | 405 | `method.not_allowed` |
| `POST /tickets/{id}/escalate` before engine-actions-jobs lands | 501 | `action.unavailable` |

### Every pair the machine forbids, and what stops it

| From \ To | new | open | escalated | resolved | closed |
|---|---|---|---|---|---|
| **new** | | T2 | T4, T7 | `resolve`: 409 `invalid_state` | no action. Store: 422 `state.transition` |
| **open** | no action. Store: 422 | T3 | T5, T7 | T9 | no action. Store: 422 |
| **escalated** | no action. Store: 422 | `assign`: 409 `invalid_state` (no de-escalation) | T6, T8 | T10 | no action. Store: 422 |
| **resolved** | no action. Store: 422 | T11 | `escalate`: 409 `invalid_state` | `resolve`: 409 | T12 |
| **closed** | Store: 422 (`closed is final`) | `reopen`: 409 `invalid_state` | `escalate`: 409 | `resolve`: 409 | |

## 5. SLA timers per tier

The SLA is a resolution target. It starts at creation, or at the last reopen (`sla_started_at`), and stops when the ticket is resolved. Assignment and escalation do not pause it. Twelve `sla_policy` rows:

| tier \ priority | urgent | high | normal | low |
|---|---|---|---|---|
| enterprise | 60 min | 240 min | 480 min | 1440 min |
| premium | 120 min | 480 min | 1440 min | 2880 min |
| standard | 240 min | 1440 min | 2880 min | 4320 min |

Every column gets stricter from standard to enterprise, and every row gets stricter from low to urgent. YOS-27 should assert this.

### Jobs [J]

| Job | `every` | What it does |
|---|---|---|
| `auto_close` | `1h` | `resolved` and `resolved_at <= now - 72h`: move to `closed` |
| `escalation_timeout` | `15m` | T8 |
| `sla_breach` | `15m` | Pass 1 (flag): active, not yet breached, and `sla_due_at <= now`: set `sla_breached`, event `sla_breach`. Pass 2 (T7): urgent, breached, level 0, `new` or `open`, On-call(1, now) exists: escalate. |

**When the breach job fires.** Firings happen at `S + k*15m`. A ticket is flagged at the first firing at or after its `sla_due_at`, so detection lags by 0 to 15 minutes. The comparison is `<=`, not the `<` in the `architecture.md` excerpt, so a due time that falls exactly on a firing is caught at that firing. When several jobs are due at the same instant they run in name order: `auto_close`, then `escalation_timeout`, then `sla_breach`. So a ticket auto-escalated at T is first eligible for the L2 timeout at T+60m, never at T.

Worked examples, which make good engine tests (all use `Runtime.advance`):

1. An enterprise urgent ticket is created by the 6th successful call, at `09:00:05`. It is due `10:00:05`. Firings at 10:00 do nothing. At `10:15:00` it is flagged, and pass 2 escalates it to L1 (`agt_0003`, whose shift runs 09:00–21:00). `escalated_at = 10:15:00`. At `11:15:00` `escalation_timeout` moves it to L2 (`agt_0004`).
2. A premium normal ticket created at `09:00:05` is due `2026-03-03T09:00:05`. It is flagged at the `09:15:00` firing that day. It is not urgent, so it is only flagged.
3. An urgent L1 ticket escalated at `20:30` is eligible for L2 at `21:30`, but L2 has a gap from `21:00` to `09:00` (section 6). Each firing skips it. At `2026-03-03T09:00:00` the L2 shift starts (`starts_at <= now`), and that firing promotes it.
4. A ticket resolved at `2026-03-02T10:00:00` is closed at the `2026-03-05T10:00:00` firing of `auto_close` (exactly 72h, so `<=` holds).

**Clock limits within one agent run.** Time moves 1s per successful call. A task run of a few hundred calls moves time by minutes, so no job fires during a normal run, provided engine-actions-jobs fires jobs only on explicit advances (see section 9). Every task therefore reads its time-dependent facts from seed.

## 6. On-call escalation rules

- E1. There are two levels. L1 is staffed by `tier2` agents and L2 by `sre` agents. One shift covers each (level, instant), half-open `[starts_at, ends_at)`.
- E2. Coverage runs in 12h blocks (09:00–21:00 and 21:00–09:00 UTC) from `S - 7d` to `S + 3d`. L1 is continuous. L2 is continuous except one gap, `2026-03-02T21:00Z` to `2026-03-03T09:00Z` (S+12h to S+24h). The gap makes `no_oncall` testable by advancing the clock, while L2 is available at S for tasks.
- E3. At S: L1 is `agt_0003` (Marcus Bell, tier2). L2 is `agt_0004` (Dana Okafor, sre).
- E4. Manual escalation (`escalate`) works on any priority: `new` or `open` to L1, then L1 to L2. It always reassigns to the on-call agent of the new level at call time. There is no level 3 (`max_escalation`).
- E5. Automatic escalation applies to `urgent` tickets only: breach to L1 (T7), then 60 minutes at L1 to L2 (T8). High, normal and low tickets are only flagged on breach. A human decides, and tasks 2 and 3 test exactly that decision.
- E6. If no shift covers the time, the action fails with `409 no_oncall`, and the job skips the ticket and retries at every later firing.
- E7. Resolving keeps the level. Reopening resets the level to 0 and keeps the assignee.

## 7. Reachability proof

### Structural: the transitions map, from the initial state `new`

`new -> open`, `new -> escalated`, `open -> resolved`, `resolved -> closed`. All five states are reachable, so `state.bad_machine` ("every state reachable") passes.

That check is necessary but not enough. The rejected `plan.md` draft (section 4) passed it and still had an unreachable `open`: its `initial` was `new`, its only actions were `escalate` (`new|open|escalated -> escalated`) and `resolve` (`open|escalated -> resolved`), and nothing ever wrote `open`. A ticket created through the API could never become `open`, and could not be resolved without being escalated first. `open` existed only in seed rows. **Every state must have a behavioural witness: a concrete sequence of actions, jobs or clock advances that writes it.** `assign` (T2) is the fix.

### Behavioural: a witness for every state, starting from seed at S

| State | Present in seed | Witness from seed (agent API) | Witness that needs the clock (admin or engine test) |
|---|---|---|---|
| `new` | 24 rows | `POST /tickets {customer_id: cus_0001, subject, priority: normal}` gives a new ticket, `tkt_0241` | |
| `open` | 72 rows | `POST /tickets/tkt_0241/assign {agent_id: agt_0001}` | |
| `escalated` (L1) | yes | `POST /tickets/tkt_0001/escalate {reason}`, which succeeds because On-call(1, S) is `agt_0003` | T7: create an urgent enterprise ticket, then `advance 75m` |
| `escalated` (L2) | yes | then `POST /tickets/tkt_0001/escalate` again, which succeeds because On-call(2, S) is `agt_0004` | T8: the same as T7, then `advance 60m` |
| `resolved` | 78 rows | `POST /tickets/tkt_0002/resolve` (`open` to `resolved`) | |
| `open` via reopen | | `POST /tickets/tkt_0002/reopen {reason}` | |
| `closed` | 36 rows | **not reachable by the agent within a run.** It needs 72h of engine time. | resolve, then `advance 73h`, and `auto_close` fires |
| `sla_breached = true` | yes | `change_priority` low to urgent on an old ticket, so the recomputed due time is in the past | `advance` past any `sla_due_at` |
| `409 no_oncall` | | **not reachable at S** (both levels are staffed) | `advance 12h`, then escalate an L1 ticket |

Every state and every guard has a witness. `closed` and `no_oncall` have witnesses only through the clock. That is faithful to the real product, but it means YOS-27 must cover them in `code/test` and cannot cover them in world `tests`.

## 8. Seed shape (for YOS-27)

Counts: customer 60 (enterprise 8, premium 16, standard 36), agent 12, sla_policy 12, oncall_shift 39 (20 L1 + 19 L2), ticket 240, ticket_event derived from history.

Ticket status mix (exact): `new` 24, `open` 72, `escalated` 30, `resolved` 78, `closed` 36.

Anchors with fixed ids, which the tasks depend on:

| Id | Row |
|---|---|
| `cus_0001` | Acme Logistics, enterprise |
| `cus_0002` | Acme Paper Co., premium (so a search for "Acme" returns two customers) |
| `agt_0001` | Priya Raman, tier1, active |
| `agt_0002` | Priya Shah, tier1, active |
| `agt_0003` | Marcus Bell, tier2 (L1 at S) |
| `agt_0004` | Dana Okafor, sre (L2 at S) |
| `agt_0012` | Tom Reyes, tier1, `active: false` |
| `tkt_0001` | cus_0001, "Label printer offline in DC-3", high, `open`, assignee agt_0001, created S-5h, due S-1h, breached, level 0 |
| `tkt_0002` | cus_0001, "Label printer jams on 4x6 stock", normal, `open`, assignee agt_0001, created S-2h, due S+6h, not breached |
| `tkt_0003` | cus_0001, "Can't export manifest CSV", low, `new`, created S-3h |
| `tkt_0004` | cus_0001, "Driver portal login loop", normal, `new`, created S-40m |

Generator rules:

- G1. Generated tickets never use `cus_0001`. Acme has exactly the four anchor tickets.
- G2. Every ticket has `created_at <= S`. All datetimes come from `ctx.time.plus(ctx.now(), '-Nm')`.
- G3. `sla_started_at = created_at` (seed tickets were never reopened), and `sla_due_at = created_at + Target`.
- G4. For `new`, `open` and `escalated`: `sla_breached` exactly when `sla_due_at <= S`. For `resolved` and `closed`: `sla_breached` exactly when `sla_due_at < resolved_at`.
- G5. No `urgent` ticket is `new` or `open` with `sla_breached` (auto-escalation already ran). Every `urgent` escalated ticket at L1 has `escalated_at` in `(S-60m, S]`, otherwise it would be at L2.
- G6. `resolved` exactly when `resolved_at` is in `(S-72h, S]`. `closed` exactly when `resolved_at <= S-72h`.
- G7. The per-state invariants in section 1 hold for every row.
- G8. Events: one `created` per ticket, one `assigned` per non-new ticket, one `escalated` per level reached, one `sla_breach` per breached ticket, one `resolved` for resolved and closed tickets, one `closed` for closed tickets. Each event time is inside the ticket's lifetime.
- G9. Task 3 needs these. Let **S3** be the set of tickets that are `open`, `high`, `sla_breached` and from an enterprise customer. S3 has 6 to 8 rows, and `tkt_0001` is one of them. There are at least 30 `open` breached tickets, and at least 2 members of S3 sort after the 25th of them in id order, so page 1 alone is not enough. These near-misses must also exist: at least 3 open, high, breached premium tickets; at least 2 new, high, breached enterprise tickets; at least 2 escalated, high, breached enterprise tickets; and at least 2 open, high, enterprise tickets that are not breached.
- G10. The lints pass: tickets have more than 25 rows, and the state mix is not skewed.

## 9. Three graded tasks, each with decoys (for YOS-39)

Every grader computes its targets from `ctx.seed`, not from the end state. It applies a collateral gate with `ctx.changes()` (job changes excluded by default): any change other than to the target tickets, or to `ticket_event` rows whose `ticket_id` is a target, scores 0.

### Task 1 (easy): assign the newest unassigned Acme ticket

> Assign the most recently created unassigned ticket from Acme Logistics to Priya Raman.

- Target: `tkt_0004` should end `open` with `assignee_id = agt_0001`.
- Grader: 1 if that holds and the collateral gate passes, otherwise 0. Noop: `tkt_0004` is `new`, so 0.
- Solution: `GET /customers?q=Acme Logistics` (two results, take the exact name), then `GET /tickets?customer_id=cus_0001&status=new&sort=-created_at&limit=1`, then `GET /agents?q=Priya Raman`, then `POST /tickets/tkt_0004/assign {agent_id: agt_0001}`.
- Decoy (a), "takes the first new Acme ticket in id order instead of sorting by created_at": assigns `tkt_0003`, scores 0.
- Decoy (b), "matches the first agent named Priya": assigns to `agt_0002`, scores 0.

### Task 2 (medium): escalate the breached printer ticket with a reason

> Acme Logistics says their ticket about the label printer being offline has blown its SLA. Escalate it to on-call, and give a reason that mentions the SLA.

- Target: `tkt_0001`.
- Grader, behind the collateral gate: 0.7 if the ticket is `escalated` at level exactly 1, plus 0.3 if one of its `escalated` events has a note containing `sla` (case-insensitive). The assignee needs no check, because `escalate` always sets it to the on-call agent. Noop: 0.
- Solution: find `cus_0001`, then `GET /tickets?customer_id=cus_0001&q=label printer` (two hits). Pick the one with `sla_breached: true`, then `POST /tickets/tkt_0001/escalate {reason: "SLA breached on high-priority enterprise ticket"}`. It has one write, so the prefix check does not apply.
- Decoy (a), "escalates the first label-printer hit without checking which one breached": escalates `tkt_0002`. The collateral gate gives 0.
- Decoy (b), "escalates the right ticket but the reason does not mention the SLA": `{reason: "customer asked"}` scores 0.7.

### Task 3 (hard): escalate every breached high-priority enterprise ticket

> Escalate every ticket that is in status open, has high priority, belongs to an enterprise customer, and has breached its SLA. Change nothing else.

- Target: S3 from seed (G9).
- Grader: if the collateral gate fails, 0. Otherwise the fraction of S3 that ends `escalated` at level exactly 1. Noop: 0. Every strict prefix scores k/|S3|, which is below 1.
- Solution: page through `GET /customers?tier=enterprise`. For each customer, page through `GET /tickets?customer_id=<c>&status=open&priority=high&sla_breached=true`, then escalate each hit with a reason.
- Decoy (a), "reads only the first page of `GET /tickets?status=open&sla_breached=true`, then filters client-side": misses at least 2 targets (G9), so it scores at most (|S3|-2)/|S3|.
- Decoy (b), "ignores the customer tier": it also escalates premium tickets. The collateral gate gives 0.
- Decoy (c), "reads 'open' as 'not resolved'": it also escalates `new` tickets. The collateral gate gives 0.
- Decoy (d), "forgets the breach filter": it escalates open, high, enterprise tickets that have not breached. The collateral gate gives 0.

Every decoy makes at least one successful write, and none ends in the noop or solution state, so none is `task.decoy_trivial`.

## 10. Open points for the engine units

1. **Whether ticks fire jobs.** `clock.ts` says due jobs fire when time passes `start + k*every`, but `runtime().call` only adds `tick`. If engine-actions-jobs fires jobs on ticks, a run of 900 or more successful calls crosses S+15m and `sla_breach` runs mid-task. The graders above already tolerate this: targets come from seed, and changes made by jobs are excluded. Still, the rule should be decided and written in `clock.ts`.
2. **Client scripts cannot control the clock.** World `tests` cannot reach `closed`, `no_oncall`, T7 or T8. Either `ClientCtx` gets a test-only `advance` (tests only, never solutions or decoys), or those cases stay as engine tests in `code/test`. This doc assumes the second.
3. **Input validation codes.** The status and code for an action body that fails `input` (missing, unknown or unresolved fields) are not in the contract yet. Section 4 assumes 422 with the store's codes.
4. **Composite keys.** `sla_policy.code` stands in for a unique (tier, priority) pair. If the engine gains composite unique, switch to it.
5. **Datetime canonical form.** Consider making the datetime `validate` normalise the stored value to `.000Z`, so snippet string comparisons cannot go wrong.
