# OpenAPI conformance profile — YOS-160

Implementation owner: ChatGPT, acting for Yos Zozo. Tracking: [YOS-160](https://linear.app/yossi-zozo123/issue/YOS-160/expose-the-openapi-conformance-profile-and-reject-unsupported-fidelity). Integration: PR #436 (old repo).

## Contract

`openapiFidelity` is a static normalized comparison, not exact API equivalence. The new `openapiConformance` wrapper exposes that fact as machine evidence. It preserves the comparator and its required-input checks without changing generated worlds or the source adapter.

The profile identifier is `worldgen.openapi.normalized.v1`. Its checked features and limitations are defined in `code/src/engine/openapi-conformance.ts`, not a model prompt. `ok` means that the named projection passed and all explicit profile requirements were supported. It never means exact equivalence. `projectionPassed: null` means incomplete or invalid source coverage left parts of the comparison unproven while no failure was found; an empty issue array in that case is not a pass. Under refusals the comparator still runs, and its operation and status checks (which read only paths and response keys) can fail the projection; field, type and enum findings under unresolved schemas are dropped as unproven.

The coverage inventory records selected operations, reference-use pointers and detected limitations. It inventories nested objects/arrays, form encoding, status normalization, enum and ID projections, nullability, references and other unverified schema features. These are disclosures of what the source uses, not claims that a particular HTTP response was observed to differ. Examples, enum literals and reference URL values are not copied into the inventory. It is not a complete OpenAPI validator or credential scrubber.

Remote/missing/cyclic references, unsupported methods, ambiguous normalized source fields or operations, empty scopes, and traversal/evidence bounds refuse rather than silently producing a pass. The scanner allows 20,000 visited nodes, depth 16 and 1,000 evidence records; exceeding a bound adds an explicit refusal. It does not fetch references. Scoping reuses the existing `underPrefix` implementation.

## Evidence format

`openapiEvidence` in `#engine` turns one comparison into a JSON document of kind `worldgen.openapi.conformance-evidence`, version 1. It is pure: no IO, model, clock or HTTP. It holds every field of the `openapiConformance` result, plus these:

- `verdict` is `passed`, `failed`, `refused` or `unproven`. `failed` means the comparator found an error, and it wins over every other verdict. `refused` means a requirement is outside the profile. `unproven` means source coverage left part of the comparison unproven and no error was found. Only `passed` is acceptance, and it is acceptance of the named projection, never of exact equivalence.
- `covered` lists the profile's checks, which is what a pass establishes.
- `projected` lists the profile limitations that the selected source uses. Those parts are compared only as a projection, or not at all.
- `unsupported` lists every refused feature: refused requirements, and source parts the profile cannot compare.

Within version 1, fields are only added. A field whose meaning changes gets a new version. An invalid document or an empty scope is `unproven`, never `passed`.

`refusedConformance` returns the result for requirements that the profile refuses whatever the world and source: `exact` and any `require` feature that is not a named check. It compares nothing, so its projection is not compared and its verdict is `refused`. It returns null when every requirement is supported.

## CLI

Run from `code/`, substituting a checked world directory and source specification:

```sh
bun run worldplay openapi ../prod/worlds/helpdesk --spec /path/to/source.yaml --only /tickets --json --profile
bun run worldplay openapi ../prod/worlds/helpdesk --spec /path/to/source.yaml --only /tickets --profile
bun run worldplay openapi ../prod/worlds/helpdesk --spec /path/to/source.yaml --only /tickets --require operation-presence,required-input-projection
bun run worldplay openapi ../prod/worlds/helpdesk --spec /path/to/source.yaml --only /tickets --exact
bun run worldplay openapi ../prod/worlds/helpdesk --spec /path/to/source.yaml --only /tickets --report /path/to/new-audit/REPORT.md
```

`--exact` deliberately refuses with exit 1 because this profile cannot establish exact equivalence. `--require` accepts only the named checks in the profile. Unsupported or misspelled features refuse; repeated flags accumulate requirements rather than replacing earlier ones. Both refuse before the world is checked or the source is read, so a missing world or source does not change the answer. Empty feature names are usage errors (exit 2).

`--json` retains the existing comparator-issue array. Consumers must obey the exit status and read stderr; an empty array alone is not acceptance. `--json --profile` prints the versioned evidence document described above. It keeps every field that it printed before version 1 existed. Human output names the verdict and always says that exact API equivalence is not established. `--profile` without JSON prints the full Markdown audit.

`--report` creates a separate audit file with exclusive creation. Its parent directory must already exist. It never overwrites an existing generated `REPORT.md`, world, input file or receipt. A conformance refusal is still written to the audit; failure to create the audit returns exit 1. Source-controlled Markdown delimiters are escaped.

## Delivered scope and remaining acceptance

This PR delivers the static engine API, CLI requirement gate, standalone machine-rendered Markdown audit, and 16 regression cases. The fixtures include missing/extra requiredness, exact/unsupported requirement refusal, reference/cap handling, scoping, deterministic reporting, legacy JSON, report preservation and literal helpdesk HTTP status/error/state controls. They are committed for runners, not claimed to have passed locally.

The ordinary WorldGen `digestInput`/judge/run path does not yet carry this evidence or refuse unsupported generation requirements. Automatic inclusion in each generation run's existing `REPORT.md` remains part of YOS-160. The added helpdesk HTTP controls do not establish source-specific wire equivalence for every schema or the Stripe-specific YOS-152 work. Both runtime gates, typechecks, full affected input/judge/report suites and integration acceptance remain required before closing the issue. No full-suite, provider, model, VM, merge or release qualification is claimed here.

Suggested runner scope from `code/`:

```sh
bun run typecheck
bun test --timeout 120000 ./test/openapi-conformance.test.ts ./test/openapi-fidelity.test.ts ./test/openapi.test.ts
node --import tsx --test --test-concurrency=1 test/openapi-conformance.test.ts test/openapi-fidelity.test.ts test/openapi.test.ts
```

Run these on authorized runners under the repository's current coordination policy. Existing acceptance assertions, runtime limits and requiredness semantics are not relaxed.
