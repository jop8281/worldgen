# Public bundle and verifier threat model (YOS-208)

Status: an audit of stabilize/main `ab512b17`, plus the two fixes in this PR (A-374). It maps the boundary as built.
[private-verifier-boundary.md](private-verifier-boundary.md) is the earlier YOS-125 design that led to it.

## Assets

- **Task-private source:** each task's `grader`, `solution`, `decoys` (script and why) and `alternatives`, as
  `engine/split.ts` defines them. Anything that quotes them counts too.
- **Keys:** `LLM_KEY`, `BOAT_API_KEY` and `WORLDGEN_STUDIO_TOKEN`. They live in the controller, the Studio and the
  model-calling children.

## Actors

- **A, the agent under test.** In a Boat sandbox it reaches the world port only. In the playground it reaches the
  world port on loopback.
- **B, a Studio viewer or operator.** Below admin, possibly in another tenant.
- **C, an operator or Studio admin.** Trusted with the private world.
- **D, anyone who reads published artifacts:** the public repository, dataset JSONL and episode exports.

## Paths and their guards

| # | Path | Who could cross | Guarded by |
|---|---|---|---|
| 1 | Public bundle, world (`collectBundle` `publicOnly`) | A | `verifier-boundary` "the rendered public form and the uploaded public bundle carry no window of any private source"; `sandboxes` "publicOnly uploads the public form alone" |
| 2 | Public bundle, code package (`src/**` only, no `prod/`, `eval/` or `test/`) | A | `verifier-boundary`, the same bundle scan |
| 3 | World port routes, error bodies, `GET /openapi.json` | A | `private-boundary` "world port leaks nothing" (canaries over every prod world); `private-output` R3 and R4; `verifier-boundary` "every /_world path on the world port is an ordinary 404" |
| 4 | Admin port in a sandbox | A | `upworld-public` "exposes only the world port"; `verifier-boundary` "the admin port is the controller channel on loopback" |
| 5 | Verifier verdict, stderr and ledger | A, D | `verifier-boundary` "no verdict or rejection carries grader source", "a malformed request is one bounded rejection", "bad usage … are authored failures" |
| 6 | Episode records and dataset JSONL | D | `dataset-private-errors` (private errors stay in private evidence, keys absent everywhere); `dataset-episode` "renders the task … and nothing hidden" |
| 7 | Dataset diagnostics (`private/`, mode 0700/0600, never exported) | D | `dataset-private-errors` |
| 8 | Studio explorer and tasks | B | `studio` explorer canaries; `studio-playground` "lists a world's tasks with the public fields only" |
| 9 | Studio console relay and reset | B | `studio` "never calls the admin port"; `studio-sensitive` relay masking |
| 10 | Studio episodes and analytics | B | `studio-sensitive` episode masking (A-367) |
| 11 | Studio cross-tenant reads | B | `studio-route-policy` (the foreign column); `studio-tenancy` |
| 12 | Studio audit, eval and costs | B | `studio-route-policy` (admin-only rows) |
| 13 | Studio report and plan, quoting whole source | B | `studio` "refuses a REPORT.md that embeds private task source" (403 `report.private_source`); `studio-builder` |
| 14 | Child stderr: studio-check (codes only), verifier (authored lines), episode (private errors) | B, D | `studio-isolation`, `verifier-boundary`, `dataset-private-errors` |
| 15 | `plan.yaml`, `plan.md`, `capsule.json` | B, D | By schema: neither the plan schema nor the capsule schema has a source field. Acceptance-test scripts are public world tests (`split.ts`). |
| 16 | Keys in children (`isolatedEnv`), the audit log and episode records | A, B, D | `verifier-boundary` env tests; `studio-isolation` "builds both children from an allowlisted environment"; `boat-key-boundary`; `studio-auth` "without tokens" |
| 17 | **Studio world export** (`GET /api/worlds/:name/export`) | B | **New in this PR:** `studio-export` "refuses every role below admin, on a tenant shelf world and on a library world"; the `studio-route-policy` row is now admin-only (A-374) |
| 18 | **Studio generation run events** (`GET /api/generate/:runId/events`) | B | **New in this PR:** `studio-sensitive` "withholds every text that can quote task source below admin" (A-374) |

Rows 17 and 18 were real leaks.
- **17.** The export zips the private `world.yaml`, and it was open to viewers. A viewer of a world with no sensitive field
  got every grader and solution, including a library world reached from another tenant.
- **18.** For a world with no sensitive field, run events showed viewers the tasks step's issue `found` and `hint`
  (snippet excerpts), its advice, its error messages and its repeated issue set.

Both are now admin-only. Each has a test that failed first.

## Stated limits

These are known and left open, each with the reason.

- **Decoy reasons in reports and plans.** `REPORT.md` "Decoys:" and `plan.md` "Decoy idea" show viewers a decoy's
  why. `split.ts` counts that as private, but A-280 accepted it for reports. Hiding them means gating reports and plans
  by role, a follow-up for the user to decide.
- **The public repository publishes private worlds.** `prod/worlds/*/world.yaml`, the tracked `runs/` files and
  `eval/runs/*/world.yaml` all hold graders and solutions. The dataset's MANIFEST ties each published world to its
  `prod/worlds` WID. No canary GUID marks task source: adding one would change every `world.yaml` and so every WID.
  Making the repository public was the user's call, so this is a user decision for later.
- **Episode failure output and `serve.failed`.** A world that fails its check can put an issue `found` into an
  episode child's failure lines (gated by sensitivity) or into the last line of a serve failure (operators only). This
  is the same class as row 18. It needs a world in the Studio that does not check.
- **The production `publicOnly` wiring.** `cli/dataset.ts` passes `collectBundle(..., { publicOnly: true })`, which is
  correct, but every test injects its own `makeBundle`, so no test pins the production default.

Theoretical limits. Each needs an extra assumption, such as a vm escape, host access or operator error.

- The playground serves the private frozen world in its serve child, so graders sit in that process (needs a vm escape).
- Handler and grader snippets share the snippet process pool (needs a vm escape).
- Studio generation and episode children receive `BOAT_API_KEY`, which they never use (needs a vm escape and a
  same-user read of the parent's environment).
- `GET /api/services` shows viewers each served world's admin port, which only the Studio host's loopback can reach.
- `bun run sandbox up --backend boat` uploads the private world without `publicOnly` (the demo path; needs a
  compromised world process).
- `verifySubmission` replays and grades without a catch. A throw lands only in private `errors.json`.
- The report and plan guard matches whole source strings, not alternatives or partial quotes. `report.ts` never
  writes source today.
- `private/` evidence is not gitignored, so an operator could commit it by mistake.
- The Explorer's TID and the proof's end-state hash can confirm a guessed grader. They leak no source.
- The public `world.yaml` on a Boat disk holds seed and handler source, whose comments could hint at a grader. The
  solver has no shell or tools.
