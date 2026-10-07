# Spec calls: engine-api-fidelity

YOS-73, G1 to G5 from research/stripe-refunds-expected-behaviour.md section 0.

- G1: the error template gains `$type` and `$param`. A string that is exactly `"$type"` or `"$param"` becomes `null` when the error set none, so a Stripe body keeps `param: null`; inside a longer string an unset one becomes an empty string. `ctx.fail(status, code, message, { type?, param? })` sets them. The engine's own errors (store, routing, validation) set neither, except the idempotency mismatch, which sets type `idempotency_error`. A per-operation status needs no new key: the handler picks it with `ctx.fail` or by returning `{ status, body }`. Reversible: yes.
- G2: `ApiRequest.headers` is optional, names lower-cased by the runtime and by http.ts. Only `idempotency-key` on POST is read. The first successful response is stored under the key with a fingerprint of path, query and body (object keys sorted); an identical request returns that response with no write, no tick and no job; a different one is 400 `idempotency_error`. Only successful (below 400) calls are remembered, so a refused call can be retried with the same key; Stripe also replays failures, which is deferred. The table lives in the Runtime next to the call log, is cleared by `reset()`, and is not part of `dump()` or `stateHash()`, so graders and the state hash are unchanged. Keys never expire. Reversible: yes.
- G3: `meta.api.list.mode: "stripe"` (default absent, meaning cursor). It takes `starting_after` and `ending_before` row ids, answers `{ [dataKey]: rows, [hasMoreKey]: bool }` (`hasMoreKey` defaults to `has_more`), orders newest first by a `created` field when the entity has one and else by `created_at`, ties by id descending, and takes `limit` from 1 to 100, default 10. The route's `pageSize` is ignored in this mode, and `sort`, `cursor` and `next_cursor` do not exist. An unknown cursor id is 400 `cursor.invalid`; both cursors together is 400 `query.invalid`. `object: "list"` and `url` are not produced. The OpenAPI document describes the mode. Reversible: yes.
- G4: `unix_time` is an integer of whole seconds from 0, `default: "now"` is the engine clock floored to seconds. It is never inferred from a CSV column, because epoch seconds look like any large int. Reversible: yes.
- G5: a nullable (not required) ref may point at an entity seeded later. The seed snippet writes the id it will have (`idPrefix_0001`, row order); the engine stores null at first and fills the field in one privileged transaction after every entity is seeded, and a value that then resolves to no row is a `constraint.violation` at `seed.<entity>`. `seed.cycle` already fired only for cycles of non-nullable refs, and a test now pins that. Reversible: yes.

## Deferred

- Form-encoded request bodies (`application/x-www-form-urlencoded`), the `expand[]` query parameter and webhooks (out of scope for YOS-73).
- Replaying failed calls under an idempotency key, key expiry and a 409 for a key still in flight.
- A per-error `type` map for engine errors (store and routing errors always give `$type` null).
- `object: "list"` and `url` in the Stripe list envelope; a Stripe `sort`.
