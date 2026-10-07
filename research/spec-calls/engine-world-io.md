# Spec calls: engine-world-io

- All world-IO issues use code `schema.invalid` with path `['format']` (load failures) or the item path (patch failures). Why: the catalog has no IO code and the issue forbids new ones outside scope. Reversible: yes.
- `loadWorld` treats any read failure (missing file, a directory, permissions) as one `['format']` issue; `found` names the path. Why: one shape for a caller to handle. Reversible: yes.
- YAML parsing uses `uniqueKeys: true`, so a duplicate key is a syntax error with line and column; only the first YAML error is reported. Why: a silently overwritten duplicate would drop a model's section. Reversible: yes.
- `applyEdit` removing an absent key is a no-op, while patching an absent key is an issue. Why: remove is idempotent and the goal state holds; patch needs a target. Reversible: yes.
- `applyEdit` patches are validated by re-parsing the merged world with `worldSchema` and returning `fromZod` issues; unknown keys added by a patch are stripped by zod. Why: a patch can break the shape and the output must be a `World`. Reversible: yes.
- `meta` in an edit is merge-patched (RFC 7386), so `{ clock: ... }` replaces nested objects key by key and null deletes a key. Why: A-11 names merge patch as the one patch semantic. Reversible: yes.
- `saveWorld` writes `world.yaml.tmp` then renames it. `renderWorldYaml` sets `lineWidth: 0` so long strings never fold. Why: a crash must not leave a half-written world; stable diffs. Reversible: yes.

- `saveWorld` has no direct test until engine-check-core can mint a `CheckedWorld` (no cast outside check.ts). Why: AGENTS.md brand invariant; Acceptance 5 is covered by `renderWorldYaml` plus `loadWorld`. Reversible: yes.

- `applyEdit` treats `meta.api.error` (the error body template, free-form JSON) as one opaque unit: a meta edit replaces it whole and keeps nulls inside it, while every other meta key merge-patches. Why: merging into a template can never remove a key except with null, and null is a legal template value (Stripe `param: null`). Reversible: yes.
- An edit parse issue under `upsert|patch|remove.<section>` is reported at `[section, ...]`, `meta` paths stay, and anything else is `['format']`. Why: `IssuePath` roots, so `ownerOf` in policy.ts resolves. Reversible: yes.
