# Red-team findings

Engine bugs found by the red-team suite (`code/test/redteam-*.test.ts`) in units that have landed. Each failing test is marked `{ todo: 'ENGINE-BUG <id>: ...' }`, so it keeps running and passes once the bug is fixed. Failures from units that have not landed are not listed here. They skip with `unit <unit> not landed: ...` (see `code/test/redteam/README.md`).

Run on 2026-10-06, branch `redteam/suite`, merged with `origin/factory/integration`. The landed units are engine-check-core, engine-runtime and the api.

## Summary

| Id | Test | Guarantee | Owning unit | Severity | Status |
|---|---|---|---|---|---|
| EB-check-1 | `G-01 a cyclic fixture cell gives schema.invalid under fixtures`; `G-01 a decoys array that contains itself gives schema.invalid under its decoys` | G-02 | engine-check-core (`code/src/engine/issues.ts`, `renderFound`) | low | CONFIRMED |

Severity:
- **high** means a wrong verdict, or a world that is accepted or refused when it should not be.
- **med** means a wrong or unusable issue on input that occurs in normal use.
- **low** means a wrong or unusable issue only on rare input, where the code, path and layer are still right.

## Details

### EB-check-1: a cyclic value renders as `[object Object]` in `found`

- **Tests** (`code/test/redteam-check.test.ts`):
  - `G-01 a cyclic fixture cell gives schema.invalid under fixtures`
  - `G-01 a decoys array that contains itself gives schema.invalid under its decoys`
- **Failing assertion**: `reportProblems` expects no G-02 problem, that is, `found` must not contain `[object Object]`. The engine gives these instead:
  - `issues schema.invalid @ [fixtures.people.0.name] found=[object Object]: found contains [object Object]`
  - `issues schema.invalid @ [tasks.pend_open_urgent.decoys.1] found=[object Object],: found contains [object Object]`

  The code, path, layer and `ok: false` are all correct. Only `found` is wrong.
- **Minimal repro**:
  ```ts
  const w = baseWorld();
  const cell: Record<string, unknown> = { first: 'A' };
  cell['me'] = cell;
  (w.fixtures as Record<string, unknown>)['people'] = [{ name: cell }];
  checkWorld(w).issues[0].found; // '[object Object]'
  // Same for: const d = w.tasks.pend_open_urgent.decoys as unknown[]; d.push(d);  -> '[object Object],'
  ```
- **Guarantee**: G-02 in `research/redteam-contract.md` says `expected`, `found` and `hint` are non-empty and none of them is `[object Object]`. Its sources:
  - the `issues.ts` header: "every issue carries path, expected, found and hint, so a model can fix it"
  - the AGENTS.md invariant: "Check errors are precise enough for a model to fix"
- **Suspected owner**: engine-check-core, in `renderFound` in `code/src/engine/issues.ts`. `JSON.stringify` throws on the cycle, and the `catch { s = String(value); }` branch then falls back to `String(value)`. A cycle-safe render would fix it, for example `<cyclic object>`, or a JSON render that replaces repeated references.
- **Verification**: an adversarial re-check confirmed it.
  - Both fixtures are invalid only at the cyclic value. In `format.ts`, fixture cells are `Scalar` and decoys are `decoySchema` objects, so `schema.invalid` at that path is right.
  - Re-running the repro on the landed engine still gives `found` values of `[object Object]` and `[object Object],`.
  - An acyclic object in the same cell renders as `{"first":"A"}`, so the cycle alone causes the bad render.
- **Related**: RT-88 is a cyclic `meta.api.error`, which `z.json()` accepts. It is a spec question, not this bug.
