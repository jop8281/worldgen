# Spec calls: engine-runtime

- A call succeeds, commits and moves the clock by one `meta.clock.tick` when its status is below 400. Any 4xx or 5xx (including 501 for actions not yet served) keeps the previous state and clock. Why: A-16 says failed calls do not move time; status is the one signal every route and action shares. Reversible: yes.
- `CallRecord.at` is the engine time the call ran at, before its tick, so it equals the `created_at`/`updated_at` the call stamps. Two consecutive failed calls share an `at`. Why: one call reads one instant; ordering comes from `seq`. Reversible: yes.
- Failed calls are logged (with `routeId` null when no route matched). Only state and clock ignore them. Why: the spec's "log of calls" is for inspecting what the agent did, mistakes included. Reversible: yes.
- `CallRecord` keeps the sketched `{ seq, at, routeId, req, res }` shape; acceptance 2's method, path and status are `req.method`, `req.path` and `res.status`. `seq` starts at 1 and restarts at 1 after `reset()`. The recorded request is a shallow copy (method, path, a copy of `query`, the body by reference). Reversible: yes.
- `StateDump` gains `counters` (acceptance 3 names them). `tables` lists every declared entity in declaration order, each an id-ordered array of row copies. `now` is ISO. Reversible: yes.
- `reset()` rebuilds from `initialState(world, host)` and then forces `now` to `meta.clock.start`, so seeding can never shift the start clock. Reversible: yes.
- `advance()` and `grade()` throw `not implemented` until engine-actions-jobs and engine-grade-verify-basic. Reversible: yes (those units replace them).
