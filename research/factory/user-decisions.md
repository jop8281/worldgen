# User decisions, 2026-10-06 (relayed by session task-description-7d). These override work orders where they conflict.

U-1 Stack: TypeScript. The factory/* build stays. Python engine-v1 is retired (A-45).
U-2 Verify gates are all hard: reference solution scores 1, noop scores 0, replay gives the same state hash, the collateral gate applies, and medium/hard tasks need a decoy scoring below 1 and every strict prefix scoring below 1.
U-3 WorldGen default budget: $5 and 15 minutes per world (replaces the 30 minutes in A-37). Flags and config override it. Revisit after the D4 rehearsal.
U-4 Fidelity: routes and methods exactly as in the source, plus a per-world error envelope template (e.g. Stripe {error:{type,code,message,param}}) with per-operation status codes. No response-schema conformance layer.
U-5 Model-written logic (snippets, run bodies) is allowed in generated worlds. Declarative state machines come first.
U-6 Run mode: unattended by default. --interactive and --pause-after-plan are opt-in.
U-7 Names: `worldplay` is the engine CLI and `worldgen` is the generator CLI. The unit that owns code/package.json scripts and src/cli/ for the engine (cli-world-check, later engine-http-cli) renames the npm script `world` to `worldplay` and src/cli/world.ts to src/cli/worldplay.ts. Wherever a work order says `npm run world -- ...`, run `npm run worldplay -- ...` once that rename has landed (check code/package.json at your base).
U-8 Linear is the only task tracker. GitHub Issues sync stays off. research/tools/file_issues.py is retired. PRs link to Linear issues by branch name and "Fixes <id>".
U-9 Reference portfolio: helpdesk is the hand-built golden world. Stripe is the OpenAPI case (static conformance, a stripe-mock diff on shapes and errors, and "add refunds" as the update demo). The team's Linear backlog CSV is the CSV case. tau2 retail is the description case. Uber-like and Petstore are prompt-only rehearsals. DuckDB, LocalStack, a GraphQL facade and BigQuery are post-trial.
U-10 (superseded by U-11) Model key: LLM_KEY in /Users/yossieliaz/worldgen/.env. Never use ANTHROPIC_API_KEY, never print or commit it.
U-11 (user, direct, 2026-10-06) Use the Claude Code harness, not the API key in .env. Coding is done by Claude Code agents, and WorldGen's own model calls go through the `claude` CLI (`claude -p`, the user's logged-in subscription) by default. Do not read or source /Users/yossieliaz/worldgen/.env. The SDK transport stays as an opt-in (`--transport sdk`) only.

Research notes added after the integration base, on origin/scaffold/agents-md-and-type-sketch at c7ebd76 (read with `git show c7ebd76:research/<file>`): design-review.md, graphs-and-universes.md, linear.md, linear-world.md, portfolio.md, python-alternative.md. Findings that affect builds:
- The plan.md helpdesk has no action that leads to `open`, so that state is unreachable. Hand-built worlds must make every state reachable.
- Linear allows any-to-any state moves and has 7 state types, including duplicate.
- node:vm hardening (design-review.md section 2.8): delete builtins down to an allowlist, time out the call itself, and build ctx inside the realm.

Folding: engine-freeze and docs-design write U-1..U-10 into research/decisions.md as rows (next free A- numbers), alongside the spec-calls.
