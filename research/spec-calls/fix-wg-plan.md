# Spec calls: fix-wg-plan

- **Verdict kind stays `proceed`, not `build`.** Why: stages.ts, judge and every fixture use `proceed`; renaming is outside scope. Reversible: yes.
- **Assumption field stays `decision`, not `what`.** Why: the plan brief in stages.ts and redteam WG-S07 / fixtures use `decision`, all outside scope. Follow-up: rename across files if wanted. Reversible: yes.
- **`open_questions` is optional, and renders only when present.** Why: typed fixtures outside scope omit it; a default would break their compile and the WG-S07 round trip. Reversible: yes.
- **A refusal's workflows and tasks are unconstrained arrays.** Why: WG-S07 parses a refuse plan that carries both. Only the min(1)/min(3) rules are dropped for refuse. Reversible: yes.
- **The description-assumption rule lives in `planSchemaFor(inputKind)`.** Why: planSchema does not know the input kind, and a new issue code would touch engine/issues.ts. Callers (run.ts) should parse with it. Reversible: yes.
- **Plan jobs are now covered by `planCoverage`.** Reverses the earlier wg-plan-stages-judge call; Acceptance of YOS-62 asks for it.
- **planSchema is one object root, not a union.** Why: a tool input_schema needs `type: object` at the root; verdict is a discriminatedUnion on `kind` and superRefine enforces workflows.min(1)/tasks.min(3) for proceed. Pinned by a toJSONSchema test. Reversible: yes.
- **Follow-up outside scope:** judge.ts PLAN_LIST_STAGE needs `jobs: 'workflow'` and stages.ts STAGES.workflow.done needs `coverage(report, plan, ['workflows','jobs'])`, or job gaps never block.
