# Spec calls: engine-tests-layer

One bullet per call: call, why, reversible. To be folded into research/decisions.md by engine-freeze, eval-stress-run-2 or docs-design.

- World tests run through `runtime(world).call`, reset before each test, rather than calling `handle()` on the seeded state directly. Why: `call` goes through `handle()` and also applies the clock tick and due jobs after each committed call, so a test sees exactly what an agent sees (spec: Enforce). Reversible: yes.
- An action counts as exercised when the router matched a test's call to it, whatever the status (a 409 refusal counts). Why: a test of a refusal path exercises the handler, and helpdesk AC3 expects the double-escalation 409 test to count. Reversible: yes.
- `action.unexercised` warnings and `stats.unexercisedActions` are computed once, when the ok report is built, from a set every client-script layer adds to. Why: the catalog says "no test or solution", and engine-grade-verify-basic only needs to add solution calls to `Run.exercised`. A failed report carries no `action.unexercised` warnings (judge.ts already skips that rule on failed reports). Reversible: yes.
- The warning's path is `['actions', name]` (owner stays `tests`). Why: it names the item a model would look up; the fix goes in tests, which the owner says. Reversible: yes.
- Every failing test is reported, one issue each, in declaration order; the layer does not stop at the first. Why: a model fixes all of them in one turn. Reversible: yes.
- A failed `ctx.assert` is recorded before it throws, so a script that catches the throw still fails with `test.failed`, and the first failed assert's message is the hint. Why: a try/catch in a test must not hide a failure. Reversible: yes.
- `ctx.api` takes the method exactly as GET, POST, PUT, PATCH or DELETE; anything else, or a non-string path, throws, which the layer reports as `snippet.runtime_error` at the script path. Why: a 405 from a misspelled method would look like a world bug; this is a script bug. Reversible: yes.
- `ctx.now()` in a test reads the runtime's current engine time, which moves by `meta.clock.tick` per committed call. Reversible: yes.
- test/check.test.ts pinned `unexercisedActions: []` for bareWorld, the output of the old stub layer. bareWorld has `resolve_ticket` and no tests, so the literal is now `['resolve_ticket']` (standing order 15). Reversible: n/a.
