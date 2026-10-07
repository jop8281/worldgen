# Standing orders (paste verbatim into every spawn)

1. Target repo ~/worldgen. Never edit the main checkout or the engine-v1 worktree. Each unit works only in its own worktree at <scratchpad>/wt/<KEY>, created with `git -C ~/worldgen worktree add <path> -b factory/<KEY> <base>`.
2. Base: the local branch factory/integration (verified units land there in dependency order). Create your worktree from its current tip. If `git worktree add` hits a lock, wait 5s and retry (other agents add worktrees concurrently). Then `cp -cR <scratchpad>/wt/_integration/code/node_modules <wt>/code/` (APFS clone, instant).
3. Stack is TypeScript per research/decisions.md A-01. Do not write Python in code/.
4. Follow ~/worldgen/AGENTS.md: module map, invariants, testing rules (literal expected values, node:test inside describe()).
5. Touch only the files in the unit's scope. A needed change outside scope goes in the report as a follow-up, not into the diff.
6. Never weaken, skip or delete a test to get green. Fix the code.
7. Verify = run the unit's Verify commands from code/ and paste the exit codes and tail of output into the report. "It compiles" is not verified.
8. Commit on the unit branch with a clear message ending with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Do not push, do not open PRs, do not merge. The coordinator publishes.
9. Do not write to GitHub. In Linear, a builder may only move its own unit's issue to In Progress at start (key map: <scratchpad>/backlog/linear-map.json). Landers own Done, comments, pushes and the PR.
10. Models: code work runs on sonnet, judgment and review on opus.
11. Live model (U-11): real WorldGen runs use the Claude Code CLI transport. Run `export PATH=$HOME/.local/bin:$PATH` first so `claude` is the real binary (the cmux shim fails non-interactively). Never read or source /Users/yossieliaz/worldgen/.env and never use LLM_KEY or ANTHROPIC_API_KEY. Commands longer than 8 minutes run in the background (Bash run_in_background) and you poll their output file; never let a tool call time out silently.
12. Never modify the engine to make a generated world pass (spec: WorldGen never edits the engine). A failing generated world is fixed in WorldGen prompts, stages or policy, or reported honestly as a FAILED run.
13. Run outputs that are deliverables go to prod/worlds/gen-<slug>/ only when the unit says so; rehearsals go to eval/runs/.
14. Read <scratchpad>/orchestrate/worldgen/user-decisions.md. The user's decisions U-1..U-11 override any work order they conflict with. Name the U-id in your spec when one applies.
15. Scope escape for brittle tests: if a Verify command fails only because a test OUTSIDE your file scope pins implementation details (an exact import list, private names, internal call order) rather than behavior, you may make the minimal edit to that test so it asserts behavior (e.g. point a helper test at a virtual fixture instead of a real file). Name the file and the reason in the commit message and in follow_ups. Never weaken or delete a behavioral assertion; that stays forbidden.
16. Precedence when sources disagree: user-decisions.md (U-*) > research/decisions.md (A-*) > the work order > research notes (design-review.md, plan.md, others). Where a research note contradicts a decision row, follow the row and record the conflict as one bullet in your spec-calls file. Never cite a research note to override a decision.
