# Probe layer and full-state audit

Status: proposal

## Decision row

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Behavioral gate and constraint backstop | A new `probe` check layer sends about 5 deterministic requests to every write route and action, and every status must be below 500. Separately, `auditState()` rescans types, required, unique, refs and state values after every committed call, including in verify replays | Most residual bugs in generated worlds are unhandled edge cases and constraint conflicts. These need a backstop that does not reverse A-14 | 2026-10-06 | Yes |

## Choice

**Probe layer.** `CHECK_LAYERS` becomes `schema, references, compile, seed, tests, probe, tasks, lints`. For every `create`, `update` and `delete` route and every action, the engine builds these requests from the seed. Each one runs from a fresh seed, and its state is thrown away.

| Probe | Request |
|---|---|
| `seed_id` | `{id}` set to the first seed row of the route's entity. For an action, the entity comes from the standard route with the longest matching path prefix |
| `missing_id` | `{id}` set to `<idPrefix>_9999` |
| `empty_body` | body `{}` on the seed id |
| `valid_body` | each writable field (entity fields, or the action's `input`) gets a value. Enum and state fields use the first declared value or `initial`. Ref fields use the first seed row of the target. Other types use `FIELD_TYPES[type].examples.valid[0]` |
| `wrong_type` | `valid_body` with its first field set to `FIELD_TYPES[type].examples.invalid[0]` |

- Every probe status must be below 500. A refusal (4xx) is fine, since guards may refuse.
- Probes do not count toward `action.unexercised` and never appear in a runtime log.

**State audit.** A pure `auditState(world, state)` rescans every row. It checks:

- type (`FIELD_TYPES[t].validate`)
- required is not null
- unique across rows
- each ref resolves, or is null where that is allowed
- each state value is in `states`

`transact()` runs the audit as its last step before commit. A violation discards the overlay, like any other throw, and the call answers 500 with code `engine.state_invalid`. During check (seed, tests, probes, verify and mutant replays) the same violation becomes an issue. The audit also runs once after seeding.

## Why

- The AWM residual bug taxonomy:
  - "44% unhandled edge cases (missing null/boundary validation) and 14% DB constraint conflicts".
  - "74% of environments contain at least one bug".
  - "self-correction primarily addresses runtime errors, not logical inconsistencies".

  Sources: notes `codegen_worlds_repair.md` Q1 and `env_synthesis_papers.md` (AWM); [arXiv 2602.10090](https://arxiv.org/html/2602.10090v3). The `empty_body`, `missing_id` and `wrong_type` probes target exactly the first class.
- EnvScaler's gate sends "random positive and negative tool calls … 100 rounds per env and discards envs below a 0.85 pass rate", which "cut 266 envs to 191 (28% rejected)" (notes `env_synthesis_papers.md`, EnvScaler; [arXiv 2601.05808](https://arxiv.org/html/2601.05808)). Probes are a cheap, deterministic, model-free version of that gate.
- The report recommends behavioral fuzzing after generation: Schemathesis "for crash and 5xx discovery", and Hypothesis invariants that "run after every step" (Report, "Budget and post-generation testing"; notes `api_mocking_simulation.md` Q4). `auditState` is the invariant that runs after every step.
- The report credits SQLite with "FK/UNIQUE/CHECK constraints as a backstop", because constraint conflicts were 14% of AWM's bugs (Report, "State, determinism and reset"). A-14 and A-45 rejected SQLite. The audit gives the same backstop over the in-memory store without keeping a second copy of the data model.

## What it replaces or amends

- Amends the `check.ts` layer list. G-04 reads `CHECK_LAYERS`, so it still holds.
- Adds to the AGENTS.md invariant "A failed call leaves no partial change" a second enforcer: `auditState` in `transact()`.
- Does not touch A-14.

## Engine changes

- `engine/check.ts`: add `'probe'` to `CHECK_LAYERS` and a `probeWorld(world, seed, host)` layer.
- `engine/store.ts`: add an exported, pure `auditState(world, state): readonly StateViolation[]`, and call it inside `transact`.
- `engine/api.ts`: map an audit failure to a 500 in the world's error envelope with code `engine.state_invalid`.
- `engine/issues.ts`
  - `'probe.server_error': def<{ route: string; probe: 'seed_id' | 'missing_id' | 'empty_body' | 'valid_body' | 'wrong_type'; status: number }>()`, with severity `error` and owner `at_path` (path `['actions', name, 'handler']` or `['routes', name]`).
    - Expected: `` `a status below 500 for the ${probe} probe` ``
    - Hint: `` `${route} answered ${status} to a ${probe} request. Guard missing or optional fields and unknown ids with ctx.fail(4xx).` ``
    - Found: the request and the error message.
  - `'engine.state_invalid': def<{ entity: string; id: string; field: string; rule: string }>()`, with severity `error` and owner `at_path` (path `['entities', entity, 'fields', field]`).
    - Expected: `` `${entity}.${field} to satisfy ${rule} in every committed state` ``
    - Hint: `` `A committed write left ${id} breaking ${rule}. Check onDelete rules against required, or report an engine bug with the call log.` ``

## Proving tests

Each test goes in `test/redteam-probe.test.ts`. Ids are provisional.

- `G-70 base world checks ok with no probe.server_error`
- `G-71 handler that reads ctx.body.note.length with note optional gives probe.server_error probe empty_body`
- `G-72 a probe failure stops at layer probe with one layer.blocked for tasks`
- `G-73 handler that throws on an unknown id gives probe.server_error probe missing_id`
- `G-74 200 random calls on the base world never return 5xx, and every dump satisfies the fixture's literal invariants`. The invariants are: status in {open, pending, closed}, every assignee is null or an agent id, and ids are unique.
- `G-75 engine.state_invalid and probe.server_error are in ISSUES with severity error`

## Cost

- About 120 lines for probes and 60 for the audit, plus 2 codes and one layer.
- Probes take about 5 × (write routes + actions) `handle()` calls per check, which is milliseconds.
- The audit is O(rows × fields) per committed call. At hundreds of rows that is microseconds. If profiling disagrees, run it in check and verify only and keep it off in `serve`.
