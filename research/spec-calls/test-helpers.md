# Spec calls: test-helpers

- `minimalWorld(overrides)` returns the merged result without re-parsing it with `worldSchema`, and its return type stays `World`. Why: `minimalWorld({ tasks: null })` must have no `tasks` key, which the schema would reject, and tests that trigger one issue code need to build near-valid worlds. Reversible: yes.
- Merge rules: plain objects merge recursively, scalars and arrays replace, `null` deletes the key. Why: the issue says deep merge with null deleting, and replacing arrays (such as enum `values`) is the only unambiguous array rule. Reversible: yes.
- `Overrides<T>` is a deep partial type where any key may be `null`. Why: it lets `{ tasks: null }` and `{ routes: { delete_ticket: null } }` type check without casts. Reversible: yes.
- `sla_due_at` is `readonly` and `nullable`, not `required`. Why: standard create refuses readonly fields, so a required readonly field would make `POST /tickets` impossible. Seed and the job set it. Reversible: yes.
- Seed rows carry any declared status (open, pending or resolved), not only the initial state. Why: a realistic mix needs it, and the store rule on transitions is measured from the value before the transaction, which a new row does not have. Engine-store owners must allow it for seed. Reversible: yes.
- `resolve_ticket` accepts only a pending ticket and answers 409 `ticket.not_pending` otherwise. Why: open to resolved is not a declared transition, so the handler cannot do it in one write. This makes tasks need the pending step, which suits the medium and hard tasks. Reversible: yes.
- Update routes use PATCH, and list bodies are read as `body.data` (the `meta.api` default). Why: the runtime is not implemented yet, so these follow the defaults in format.ts. engine-grade-verify-basic corrects them if the runtime differs. Reversible: yes.
- `time.minutesBetween(a, b)` is assumed to be `b - a` in the escalation job. Why: the registry doc does not say which way the sign goes. Reversible: yes.
- Graders return partial scores (a half goal, or a goal plus collateral changes gives goal/2 or 0.5) and 0 on the untouched seed. Why: A-27 needs decoys that score below 1 without being trivial. Reversible: yes.
- Subjects avoid the words `import` and the like, because the snippet test greps for forbidden globals. Why: the grep is cheap and a false hit on data is noise. Reversible: yes.
