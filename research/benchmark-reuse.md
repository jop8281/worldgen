# Reusing public benchmarks

Checked on 2026-10-06 against repo source, LICENSE files and papers. A skeptic pass re-opened each source: 12 claims confirmed and 1 corrected (the tau2 retail grading, see below). This note adds to `related-work.md` and does not repeat it.

A-54 already makes tau2 retail our description case. This note says what to take from it and from four other benchmarks, and what not to take.

## What each source offers

| Source | Licence | What we reuse | What we do not take |
|---|---|---|---|
| tau2 / tau3-bench (Sierra) | MIT | Retail `policy.md` as a description input. Gold action lists to check the generated world's end state. pass^k as `comb(successes, k) / comb(trials, k)` per task (`src/tau2/metrics/agent_metrics.py:113-126`). | The original tau-bench repo, which its README marks as outdated. |
| AppWorld | Code Apache-2.0. The protected part (APIs, tasks, solutions, tests) adds a rule: public copies of it or anything derived from it must be encrypted. | The grading rule `C_expect ⊆ Δ ⊆ C_expect ∪ C_allow` over a row-hash diff, and "every variant of a scenario passes" (SGC). | Any test, data or API text. Nothing from it goes into `prod/`. |
| SWE-bench | MIT | FAIL_TO_PASS / PASS_TO_PASS. A task is solved only when both are 1. A skipped F2P test counts as a failure (`swebench/harness/grading.py`). | — |
| Terminal-Bench 2 / Harbor | Apache-2.0 | The task directory format: `instruction.md`, `task.toml`, `environment/`, `solution/solve.sh`, and `tests/test.sh` writing `reward.txt`. The tau3 adapter as a template for exporting a world. A canary GUID in solution files. | — |
| AutomationBench (Zapier, arXiv 2604.18934) | MIT. The repo disclaims rights in third-party API schemas. | The 100 support tasks (Zendesk, Freshdesk, Gorgias, Help Scout) as prompt ideas. Its negative assertions (`*_not_exists`, `*_not_has_tag`) as grader helper names. | Its API schemas. |

## tau2 retail in numbers

- 114 tasks, split 74 train and 40 test. The DB holds 500 users, 1,000 orders and 50 products. `policy.md` is about 1,150 words.
- Grading: each task has one gold action list. The evaluator replays it on a fresh DB, and the agent's run passes when the DB hashes match.
- Correction to the first briefing: retail is not graded on the DB alone. 112 tasks list `[DB, NL_ASSERTION]` and 40 have non-empty `nl_assertions`, such as "Agent should tell the user that there are 10 t-shirt options available". Our engine grades end state only, so those 40 assertions have no equivalent. Compare on the DB part only, and say so in the report.
- Harbor ships a tau3 adapter: 375 tasks, the domain served as an MCP sidecar, the official tau2 evaluator as verifier. The oracle scored 1.0 on all 375. On gpt-5.2, Harbor scored 64.09% against 65.42% upstream.

## Recommendations

1. **tau2 retail as a fidelity yardstick (the A-54 description case).** Give WorldGen `policy.md` as a description. Map the 40 test-split gold action lists onto calls against the generated world, run them, and compare the end state with tau's replayed DB on the fields both have. Report how many tasks the world can express at all, how many match, and pass^k with tau's formula. Mark the case `known` in `eval/suite.yaml`, never `held_out`: the domain has been public since 2024 and models have probably seen it. Owner: YOS-51.
2. **Grading vocabulary.** Every grader assertion must be false at seed and true after the solution (F2P), and every invariant must be true at both (P2P). Add AppWorld's expect/allow diff as one gate over `ctx.changes()`, which is our `unchanged_except`. Name the negative helpers after AutomationBench's. This is the stricter bar AutomationBench lacks: it ships no oracle solutions, and its changelog keeps fixing unfair tasks. Owner: YOS-37.
3. **Harbor export (stretch, not in the spec).** Copy the tau3 adapter's layout. Serve the world as an HTTP or MCP sidecar. `test.sh` calls `POST /_world/grade/<task>` and writes `reward.txt`, and `solve.sh` runs the reference solution, so `-a oracle` must score 1. Log it as a decision before anyone builds it.

## Contamination and publishing

- A tau-derived input mostly tests whether the model remembers tau. Use it for development and comparison, never as evidence of how WorldGen does on unseen input. Unseen evidence comes from the sealed prompts in `rehearsal-prompts.md` (YOS-58).
- If we publish generated worlds, add a canary GUID to task solutions, as Terminal-Bench and AppWorld do.
- One audit found 16% of 1,968 terminal-benchmark tasks hackable from the description alone (arXiv 2606.08960). That supports keeping decoys and prefix checks in `verifyTask`.

## Sources

- https://github.com/sierra-research/tau2-bench (LICENSE, `src/tau2/metrics/agent_metrics.py`, `src/tau2/evaluator/`, `data/tau2/domains/retail/`)
- https://github.com/harbor-framework/harbor/blob/main/adapters/tau3-bench/README.md
- https://github.com/StonyBrookNLP/appworld (README, License section) and https://arxiv.org/abs/2407.18901
- https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/grading.py
- https://github.com/harbor-framework/terminal-bench-2
- https://github.com/zapier/AutomationBench
- https://arxiv.org/abs/2606.08960

Not opened: the AutomationBench paper itself (read through the repo), and the licences of ToolSandbox, Toolathlon, BFCL and TheAgentCompany.
