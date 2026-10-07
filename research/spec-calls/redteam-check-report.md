# Red-team calls: what a check report contains

Status: proposal

These are open questions from `research/redteam-contract.md` about `checkWorld` output. They matter because the repair loop feeds each report back to the model. A report that is incomplete, repeats itself or is too large costs extra repair rounds.

## Decision rows

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Unknown keys in world.yaml (RT-14) | Every object schema in `format.ts` is strict (`z.strictObject`). An unknown key, an own `__proto__` key among them, gives `schema.invalid` at its path, and the hint names the allowed keys. | A typo such as `requried: true` would otherwise be dropped, and the field would silently become optional. That breaks "no silent guessing". | 2026-10-06 | Yes |
| A-xx | Unknown fields in rows (RT-15) | A seed row with an undeclared field gives `constraint.violation` at `['seed', <entity>]`. An API create or update with an undeclared field gives 422, and the error names the field. | Silently dropping it hides a model error in seeds. Over the API, the agent would believe a write succeeded when it did not. | 2026-10-06 | Yes |
| A-xx | Seed returns a non-array (RT-42) | `snippet.runtime_error` at `['seed', <entity>]`, with found `returned <type>` and expected text "an array of rows". | It is one code, and its message tells the model exactly what to fix. | 2026-10-06 | Yes |
| A-xx | Completeness (RT-80) | A failed layer reports every issue it finds: one or more per broken item in the schema layer, and every unresolved name in the references layer. | Each repair round can then fix everything, instead of one issue per round. | 2026-10-06 | Yes |
| A-xx | No cascade inside seed (RT-81) | When an entity's seed fails, every entity that refs it is not seeded and gets one `layer.blocked` (with layer `seed`), not issues of its own. | Ref failures that cascade from one bad seed are noise that points the model at the wrong snippet. | 2026-10-06 | Yes |
| A-xx | Bounded text (RT-82) | `expected`, `found` and `hint` are each cut to 4096 characters. A cut value ends with `… (<n> chars)`. | A 5 MB string must not flood the model's context or the terminal. | 2026-10-06 | Yes |
| A-xx | Route identity (RT-83) | Two routes with the same method, whose paths are equal once each `{param}` becomes `{}`, give `route.duplicate_path`. | `/tickets/{id}` and `/tickets/{ticket_id}` can never both be matched. | 2026-10-06 | Yes |
| A-xx | No duplicates (RT-84) | A report never holds two issues with the same code, path, expected, found and hint. | Duplicates waste the repair budget. | 2026-10-06 | Yes |
| A-xx | Failed tasks layer (RT-85) | A failed tasks layer skips only the lints and adds no `layer.blocked`, because lints own no section. | `layer.blocked` means "a section was not checked". No section was skipped. | 2026-10-06 | Yes |
| A-xx | Cyclic JSON values (RT-88) | A cycle anywhere in the input is `schema.invalid` at the first path where a value repeats an ancestor, with found `<cyclic>`. That includes `meta.api.error`, which `z.json()` would accept. | A cycle is not JSON. A cyclic error template cannot be rendered as a response body or saved as plain JSON, so accepting it moves the failure to serve time. | 2026-10-06 | Yes |
| A-xx | Very deep input (RT-89) | Input nested deeper than a fixed limit (for example 256 levels) is `schema.invalid` at the path where the limit is crossed, before zod runs. found names the depth, and the hint names the limit. | A stack overflow becomes a precise issue at the deep value, not a generic issue at `['format']` that a model cannot act on. A 100k-deep value is never meant to be valid. | 2026-10-06 | Yes |

## Unlocks

| RT | Tests that become firm |
|---|---|
| RT-14 | `G-07 X10 own __proto__ key in entities -> schema.invalid` |
| RT-15 | `G-07 D18 seed sets an unknown field -> constraint.violation` |
| RT-42 | `G-07 D19 seed returns an object, not an array -> snippet.runtime_error` |
| RT-80 | `G-04 every references issue is reported…`, `G-04 every schema issue is reported, one per broken section` |
| RT-81 | `G-04 a failed agent seed does not cascade into ticket seed issues` |
| RT-82 | `G-02 issue text stays bounded when the input holds a 5MB string` |
| RT-83 | `G-07 X23 GET /tickets/{ticket_id} next to GET /tickets/{id} -> route.duplicate_path` |
| RT-84 | `G-02 a report lists no issue twice` |
| RT-85 | `G-04 a task failure, which skips only lints, adds no layer.blocked` |
| RT-88 | `G-01 a cyclic meta.api.error (YAML alias loop) gives schema.invalid under meta` |
| RT-89 | `G-01 100k-deep nesting is refused at the deep value or checks like shallow nesting` |
