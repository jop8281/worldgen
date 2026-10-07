# Plan tasks declare what they touch

Status: proposal

## Decision row

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Spec: tasks first without reordering stages | Each plan task declares `touches` (entity fields, actions, jobs) and `uses` (route and action ids). Plan coverage checks them after the model and workflow stages, through `plan.not_covered` | Generating tasks first cuts blocked tasks sharply. The spec's stage list fixes tasks at stage 5, but stage 1 already drafts them, so their needs can gate the earlier stages | 2026-10-06 | Yes |

## Choice

- `planSchema.tasks[]` gains two fields:
  - `touches: string[]`, each one of `entity.field`, `action:<name>` or `job:<name>`.
  - `uses: string[]`, the route and action ids the reference solution is expected to call.

  Both arrays may be empty on easy tasks, and each must have at least one item on medium and hard tasks.
- `planCoverage(plan, world)` checks each item once its owning stage has run.
  - `entity.field` and route ids are checked after the model stage.
  - `action:` and `job:` items, and action ids in `uses`, are checked after the workflow stage.
  - A missing item gives the existing `plan.not_covered` with `item` such as `task escalate_unassigned touches ticket.assignee`, at path `['plan', 'tasks', i, 'touches', j]`.
- After the tasks stage, the judge warns if the solution's call log never calls an id listed in `uses`. This reuses `plan.not_covered` as a warning-level judgment in `judge.ts` and needs no new code.
- Iterate: `plan.changes` may edit `touches`, and the same coverage rules apply.

## Why

- AWM generates "tasks before the schema" and reports "11.5% blocked tasks versus 46.8% for env-first EnvScaler", with task feasibility 3.99/5 against 3.14 (Report, "Stage order and what each stage emits"; notes `env_synthesis_papers.md`, AWM). The report notes this is "one paper using its own judge".
- In Verified Synthetic Web Environments, feasible tasks rose "from 48.6% raw to 94.8% after verification" ([arXiv 2608.21898](https://arxiv.org/abs/2608.21898); Report).
- The report's stage table gates the data model on "every precondition maps to fields; no orphan tables" and the API on "every task reachable via declared routes" (Report, stage table rows 2 and 3; notes `codegen_worlds_repair.md` Q3). `touches` and `uses` make both gates checkable by code, as invariant 1 requires.
- The spec fixes the order: "1 understand input and draft plan (entities, routes, workflows, tasks) … 5 write tasks". A full reorder is rejected (see README). Declaring touches in stage 1 gets most of the feasibility benefit within that order.

## What it replaces or amends

- Amends the plan schema and plan coverage. It does not touch any A-row's text.
- Supplements A-13 and A-33. A changed `touches` item reruns its owning stage on iterate.

## Engine changes

- None in `src/engine/`. `plan.not_covered` already exists, with owner `at_path`, so `plan` paths backtrack to the plan step.
- `worldgen/plan.ts`: add the schema fields and the staged `planCoverage(plan, world, through: StageId)`.
- `worldgen/stages.ts`: `done` for `model` and `workflow` calls coverage through that stage.
- `worldgen/judge.ts`: add the `uses` warning after the tasks stage.
- No `TaskVerdict` fields.

## Proving tests

Ids are provisional. These go in `test/worldgen.test.ts` and `test/plan.test.ts`, since the red-team suite imports only `#engine`.

- `G-91 plan task touching ticket.missing_field gives plan.not_covered after the model stage`
- `G-92 action:escalate is not checked after the model stage and is checked after the workflow stage`
- `G-93 base world with a plan whose touches all exist gives no plan.not_covered`

## Cost

- About 50 lines.
- Two short fields per plan task, which costs a few hundred tokens in the plan prompt.
- Possibly one more backtrack to the plan step when the model forgets a field. That is the intended effect.
