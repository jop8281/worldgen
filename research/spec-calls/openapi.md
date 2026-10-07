# Engine-generated OpenAPI

Status: proposal

## Decision row

| # | Decision | Choice | Why | Date | Reversible? |
|---|---|---|---|---|---|
| A-xx | Canonical API description | A pure `openApiOf(world)` is served at `GET /openapi.json` on the world port and printed by `world openapi <dir>`. Routes and actions may not use reserved paths. Worlds built from OpenAPI input are checked against their input by a round trip | The agent under test and tooling need a machine-readable surface. OpenAPI-derived worlds must be shown to follow their input. MCP and Schemathesis can be derived from this one document | 2026-10-06 | Yes |

## Choice

- `openApiOf(world: CheckedWorld)` returns an OpenAPI 3.1.0 document. It is derived only from `meta`, `entities`, `routes` and `actions`, and never from `tasks`, `jobs`, `seed`, `tests` or `fixtures`.
  - `info.title` is `meta.name`. `info.description` is `meta.description` plus `meta.resembles`.
  - Each route and action becomes one operation, and its `operationId` is the item key.
  - Create bodies list the writable fields and their `required` fields. Update bodies list the writable fields, all optional. Action bodies come from `input`.
  - The row schema is the fields plus `id`, `created_at` and `updated_at`.
  - The list response is `{ [dataKey]: Row[], [cursorKey]: string|null }`, built from `meta.api.list`. Its query parameters are `limitParam`, `cursorParam`, the filters and the search.
  - Error responses 400, 404, 409 and 422 use the schema of the `meta.api.error` template.
- `http.ts` serves `GET /openapi.json` on the world port. This does not go through `Runtime.call`, so it is not logged, does not tick and does not change state. The admin port does not serve it.
- `world openapi <dir>` prints the same JSON, with 2-space indent and stable key order.
- A route or action whose path is `/openapi.json`, or starts with `/_world`, gives `route.reserved_path` at the references layer.
- Round trip, for WorldGen OpenAPI input only. `judge.ts` compares the input document, narrowed by `--only`, with `openApiOf(world)`. Each input (method, path template) must exist. Each required request property of the input must exist in the world's request schema. Each 4xx status the input declares for an operation must be one that the world's error responses list. A failure gives `input.openapi_not_followed`. No model is involved.

## Why

- The report's recommendation is to make "REST with an engine-generated `/openapi.json` the canonical surface, because it replicates 'real software' and lets Schemathesis-style tooling test it. An MCP server … should be derived from it automatically" (Report, "API exposure: HTTP with OpenAPI first, MCP generated from it").
- The spec says OpenAPI input must "follow its paths, shapes and errors, optionally narrowed to part of it". Today nothing proves a generated world did. The round trip turns that into a check made by code.
- AWM's pipeline has a tool-interface spec stage whose gate is "every task is reachable through the declared operations" (notes `codegen_worlds_repair.md` Q3). Contract-test tools such as Speakeasy and Fern generate mocks and tests from the OpenAPI document (notes `api_mocking_simulation.md` Q1). That needs one document to exist.
- The frameworks converge on "actions exposed as tools", and OpenEnv has a tool-discoverability RFC (notes `env_frameworks_hubs.md`). A discoverable surface on the world port serves the agent under test. The admin plane stays separate, as A-31 requires and as METR's finding of hacking "43 times more common" with a visible scorer supports (Report). So the document holds no grader or task text.

## What it replaces or amends

- Extends A-31: the world port serves exactly one non-world path, `/openapi.json`.
- Extends A-30, since envelopes appear in the document.
- RT-03 is unchanged for every other unknown path.

## Engine changes

- New core file `engine/openapi.ts` with a pure `openApiOf`. It is exported from `index.ts`.
- `engine/fields.ts`: add a `jsonSchema(def)` member to each `FIELD_TYPES` entry, following the A-23 pattern. `test/fields.test.ts` checks every `examples.valid` value for its JSON type.
- `engine/http.ts` serves the route. `cli/world.ts` adds the `openapi` subcommand.
- `engine/check.ts`: the references layer emits `route.reserved_path`.
- `engine/issues.ts`
  - `'route.reserved_path': def<{ path: string; reserved: readonly string[] }>()`, with severity `error` and owner `at_path`.
    - Expected: `a path outside the engine's reserved paths`
    - Hint: `` `${path} is reserved (${reserved.join(', ')}). Choose another path.` ``
  - `'input.openapi_not_followed': def<{ method: string; path: string; problem: 'missing_operation' | 'missing_field' | 'missing_status' }>()`, with severity `error` and owner `routes`.
    - Expected: `` `${method} ${path} as the input OpenAPI declares it` ``
    - Hint: `` `The input declares ${method} ${path} but the world ${problem.replace('_', 's ')}. Add it, or narrow with --only.` ``

## Proving tests

Each test goes in `test/redteam-openapi.test.ts` and drives the CLI. Ids are provisional.

- `G-76 GET /openapi.json on the world port returns openapi 3.1.0 with exactly the paths /agents, /agents/{id}, /tickets, /tickets/{id}, /tickets/{id}/escalate and 10 operations`
- `G-77 openapi.json has no /_world path and contains no task instruction, grader or solution text`
- `G-78 GET /openapi.json leaves the admin state and log unchanged`
- `G-79 world openapi <dir> prints a document deep-equal to the served one, and two runs are byte-identical`
- `G-80 a route at /openapi.json or /_world/x gives route.reserved_path`
- `G-81 list operations use the meta.api.list keys data and next_cursor`

## Cost

- About 200 lines for `openapi.ts`, about 30 for http and the CLI, one member per field type, and 2 codes.
- The round trip is about 80 lines in `judge.ts` and is useful only for OpenAPI input.
- MCP is out of scope (see README).
