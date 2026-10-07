# Spec calls: fix-engine-check

All six cases from the code-f4 probes (p5 C3, C4, C5, C5b, C5c, C7) reproduced as `ok` before this change, so none is left alone.

- Filterability comes from FIELD_TYPES: a type is filterable when one of its own `examples.valid` values parses through its `parseQuery`. Today only `text` fails. Why: AGENTS.md bans `switch (def.type)`, and fields.ts is outside this unit. Reversible: yes; an explicit `filterable` flag on FieldKind would be cleaner (follow-up).
- Engine fields `id`, `created_at` and `updated_at` stay valid filters. Why: api.ts gives them columns. Reversible: yes.
- A trailing slash is allowed (`/customers/`), because the router drops empty segments. It collides with `/customers`. An interior empty segment (`//`) is an error. Why: acceptance 3 asks for collision under splitSegments, which presumes the trailing-slash form is legal. Reversible: yes.
- Param names are not forced to snake_case. A param is any whole `{...}` segment without braces, whitespace, `?` or `#`. Why: U-4 keeps paths exactly as in the source, and OpenAPI uses names such as `{customerId}`. Reversible: yes.
- A repeated param name in one path is an error. Why: the router keeps params in a Map, so the second value silently wins. Reversible: yes.
- get, update and delete need at least one `{param}`; it need not be named `id`. Why: api.ts `rowIdOf` uses `{id}`, else the last param. Reversible: yes.
- A list filter named `q` or `sort` is a collision even when the route has no search or sort. Why: listOp reads `q` and `sort` from the query unconditionally, so such a filter can never work. Reversible: yes.
- A path with a `route.bad_path` issue is skipped for the id-param and duplicate checks, so it gets one issue. Why: one fixable issue per cause. Reversible: yes.
- check.ts keeps its own copy of the router's `splitSegments` and `PARAM_RE`. Why: they are private in api.ts, which is outside this unit. Follow-up: export them from api.ts and import them in check.ts.
