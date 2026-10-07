# Related work: verification and notes

Checked on 2026-10-06 with web search and direct page fetches. "Opened" means I fetched the URL below.
Numbers are copied from abstracts or the paper HTML. Anything I could not open is marked.

## 1. Verification of the pasted summary

| # | Claim | Status | Correction | Source opened |
|---|---|---|---|---|
| 1a | C-World, arXiv 2601.06328 | Verified | v1 (2026-01-09) was titled "ToolGym: an Open-world Tool-using Environment for Scalable Agent Testing and Data Curation". v2 (2026-04-19) is "C-World: A Computer Use Agent Environment Creator". | https://arxiv.org/abs/2601.06328 , https://arxiv.org/abs/2601.06328v1 |
| 1b | Venue ACL 2026 | Partly wrong / unconfirmed | arXiv comment says "Submitted to ACL 2026". The project page and repo README say "ACL 2025". A search snippet (underline.io) mentions an ACL 2026 poster; I did not open it. | same as 1a |
| 1c | Project page ziqiao-git.github.io/C-World | Partly wrong | URL works but the page is branded "ToolGym", not C-World. It does not mention the World Engine or the 0.883 number. Repo: github.com/Ziqiao-git/ToolGym. | https://ziqiao-git.github.io/C-World/ , https://github.com/Ziqiao-git/ToolGym |
| 1d | World Engine = LLM predicts tool responses using category cards + few-shot + session log | Verified | Paper: "Conditioned on the card, tool schema, and a session-level execution log for state consistency". No database or enforced state. Synthesized eval used gemini-3.1-flash-lite-preview. | https://arxiv.org/html/2601.06328v2 |
| 1e | 5,571 tools across 204 apps | Verified | Exact. | arXiv abstract |
| 1f | Spearman rho 0.883 vs real execution | Verified, needs context | It is a rank correlation of model leaderboard order (Overall score) between synthesized and real modes, over 50 tasks. It is not per-response fidelity. | arXiv HTML v2 |
| 1g | ~1,170 trajectories beat baselines trained on 119k | Verified | Exactly 1,170 samples vs baselines on 119,000. | arXiv abstract |
| 1h | Reward = verifiable metrics + LLM judgment | Verified | Verifiable: schema compliance, order constraints, source diversity. Judge: GPT-4o, GPT-5.1, DeepSeek-V3.2, majority vote. | arXiv HTML v2 |
| 2 | SimWorld Studio / SimCoder, arXiv 2605.09423 | Verified | UE5 platform; SimCoder writes engine code, self-improves from feedback, exports Gym envs. +18 pts vs fixed-env learning, +40 vs untrained. Submitted 2026-05-10. Embodied, not software. | https://arxiv.org/abs/2605.09423 |
| 3 | Code2Worlds (ICML 2026) | Verified | "Code2Worlds: Empowering Coding LLMs for 4D World Generation", arXiv 2602.11757. ICML 2026 per repo README. 3D/4D scenes with a VLM motion critic. Do not confuse with Code2World (2602.09856, GUI world model). | https://github.com/AIGeeksGroup/Code2Worlds |
| 4a | WORLDCODER-BENCH | Verified | "WorldCoder-Bench", arXiv 2606.01869 (2026-06-01). 2,026 tasks, Three.js worlds, StateProbe checks hidden mutation-hardened contracts. Best: 27.8% (Core), 19.9% (Robust). | https://arxiv.org/abs/2606.01869 |
| 4b | WorldCoder builds a Python world model | Verified | Tang, Key, Ellis, arXiv 2402.12275, NeurIPS 2024. Gridworlds and planning. Unrelated to WorldCoder-Bench. | https://arxiv.org/abs/2402.12275 |
| 5a | Code4Scene | Not found | No paper by this name. Possible confusions: Code4D dataset (same group as Code2Worlds), SceneCode (2605.19587), SceneCraft (2403.01248). None opened. | search only |
| 5b | OpenGameEval | Partly wrong | Real name is OpenGame-Bench, inside "OpenGame: Open Agentic Coding for Games", arXiv 2604.18394. Scored by headless browser plus VLM judging. | https://arxiv.org/abs/2604.18394 |
| 5c | World Craft | Verified | arXiv 2601.09150, cs.HC. Text to AI-Town-like game world (World Scaffold + World Guild). A different "WorldCraft" exists (2502.15601, not opened). | https://arxiv.org/abs/2601.09150 |
| 6a | WorldSeed | Verified | github.com/AIScientists-Dev/WorldSeed, MIT. YAML-defined multi-agent world; deterministic DSL rules plus an LLM "Dungeon Master" for uncertain actions. | https://github.com/AIScientists-Dev/WorldSeed |
| 6b | worldsim | Ambiguous, not opened | Most likely Nous Research's WorldSim, a prompt-based Claude 3 Opus CLI "universe simulator" demo. No paper. Only secondary sources found. | search only |
| 6c | AgentWorld | Ambiguous | Two real works: Agent World Model (AWM, 2602.10090, ICML 2026) and Agent-World (2604.18292). Both opened, see section 2. | see section 2 |
| 7 | OpenDriveLab WorldEngine, arXiv 2606.19836 | Verified | "World Engine: Towards the Era of Post-Training for Autonomous Driving", technical report, 2026-06-18. Driving sim from real logs. Name clash only. | https://arxiv.org/abs/2606.19836 |

Net: the summary is mostly accurate on numbers. Its main errors are naming (ToolGym vs C-World, OpenGame-Bench, Code4Scene).
Its bigger problem is relevance: most items are 3D, game or driving worlds. It missed the closest work (section 2).

## 2. Closest real systems

**Agent World Model (AWM)**, Snowflake. arXiv 2602.10090, ICML 2026. https://arxiv.org/abs/2602.10090 (HTML v3 opened)
- Six LLM stages: scenario, tasks (10 per scenario), SQLite schema, sample data, Python tools over MCP, verification code.
- 1,000 envs, 35,062 tools (35.1 per env), mean 18.5 tables and 1,984.7 lines of code per env.
- Self-correction: run each component, feed errors back, up to 5 iterations (avg 1.13 trials). Stage success 86.8 to 88.3%.
- Verification diffs DB state before and after, but "the ultimate decision is made by an LLM-as-a-Judge". Their ablation says hybrid beat code-only.
- Lesson for us: this is our nearest neighbour and validates the staged, DB-backed, repair-loop design. We differ on purpose: no LLM in grading, and graders must pass reference=1 / noop=0 / mutant checks. We should say clearly why their code-only verifier underperformed (no grader validation) and that ours does not have that gap.

**EnvScaler**, arXiv 2601.05808. https://arxiv.org/abs/2601.05808 (HTML v2 opened)
- Envs are Python classes (attributes = state, methods = tools). 191 envs, about 7,000 scenarios.
- Env quality: a testing agent fires positive and negative calls, a checking LLM judges. 100 rounds, threshold 0.85.
- Task reward: LLM-written terminal-state check functions per checkpoint; reward = fraction passed.
- Lesson for us: borrow the checkpoint-style partial credit and the positive/negative probe idea. But their probe is judged by an LLM; ours should be judged by the engine's own constraint and error codes.

**C-World (ToolGym)**, arXiv 2601.06328. https://arxiv.org/html/2601.06328v2
- Realistic mode calls live MCP tools. Synthesized mode: an LLM predicts each tool response from a category card, schema, few-shots and the session log.
- Task generation uses a check-then-revise loop on tool coverage and constraint quality. A state controller injects timeouts, rate limits and corrupted responses.
- Lesson for us: borrow (a) the rank-correlation fidelity test and (b) failure injection. Reject the LLM-simulated engine: state lives only in a prompt log, so two runs can disagree, nothing enforces the data model, and end state cannot be read by a grader.

**tau-bench / tau2-bench**, arXiv 2406.12045 and 2506.07982. https://arxiv.org/abs/2406.12045 , https://arxiv.org/abs/2506.07982
- Hand-built domains with policy rules and an LLM user simulator. Grading compares final DB state. tau-bench introduced pass^k (gpt-4o pass^8 under 25% in retail).
- tau2 adds a telecom dual-control domain and a compositional task generator.
- Lesson for us: DB end-state grading is the accepted standard. Report pass^k from repeated runs, which our deterministic engine makes cheap.

**AppWorld**, arXiv 2407.18901, ACL 2024. https://arxiv.org/abs/2407.18901
- Hand-built engine: 9 apps, 457 APIs, about 60k lines, about 100 fictional users, 750 tasks.
- State-based unit tests allow any valid path and also catch unintended side effects.
- Lesson for us: this is the quality bar for a hand-built world. Their "collateral damage" tests match our `unchanged_except` gate.

**MirrorAPI (StableToolBench)**, arXiv 2503.20527. https://arxiv.org/abs/2503.20527
- Fine-tuned LLMs that mimic responses of 7,000+ RapidAPI endpoints.
- Lesson for us: the strongest form of the LLM-simulated approach. Still stateless in the sense that matters to us: no enforced invariants.

Also opened, less close: EnvFactory (2605.18703, 85 verified envs, 2,500+ trajectories), Agent-World (2604.18292, 23 benchmarks), AutoEnv (2511.19304, 36 envs, $4.12 per env), EnvGen (2403.12014, COLM 2024, game configs), AgentGym (2406.04151). MCP-Persona (2606.02470, ICML 2026) simulates personal-app MCP tools; the abstract does not say how, so I did not use it.
Vendor RL-environment generators (OpenAI, Anthropic): I found no primary publication and cite none.

## 3. LLM-simulated engines vs our engine

| Property | LLM-simulated (C-World synthesized, MirrorAPI) | Hybrid (AWM, EnvScaler) | Ours (plan.md sections 1-2) |
|---|---|---|---|
| Who computes the response | LLM per call | Generated code + DB | Engine interprets declarative YAML, SQLite |
| State consistency | Prompt log only | DB, but code is LLM-written Python | Transactional, constraint-checked, no LLM-written Python |
| Determinism | No | Mostly | Required; state hash tested on reset and rerun |
| Grading | LLM judge (plus schema checks) | Code checks, final call by LLM (AWM) | Programmatic only; Σ w·check × Π gates |
| Grader validation | None reported | None reported | Reference = 1, noop = 0, prefixes, mutants |
| Fidelity evidence | Rank corr. 0.883 vs real | Downstream benchmark gains | Not yet measured |

Our spec says WorldGen "never grades its own work by asking the model". None of the closest systems meet that bar.
That is our main claim of difference and we should state it in DESIGN.md.

## 4. What to borrow

1. **Fidelity metric.** For one world with a real counterpart, run several agents on real and on our world. Report Spearman rho of the model ranking, as C-World does. Also report a per-call conformance diff from our `/openapi.json`.
2. **Grader validation is our edge.** Neither AWM nor EnvScaler checks that graders reject noop or wrong solutions. Keep our verify suite and report its rejection rates.
3. **Pipeline stats.** Report per-stage pass rate and mean repair rounds like AWM Table 1 (86.8 to 88.3%, 1.13 trials). It gives us a direct baseline.
4. **Task generation.** Borrow check-then-revise for task diversity (C-World) and per-checkpoint partial credit (EnvScaler). Keep checks false at seed.
5. **Failure injection.** C-World's state controller injects timeouts and rate limits. A seeded, deterministic version fits our engine as a COULD.
6. **pass^k.** Cheap for us because runs are deterministic on the engine side.

## 5. Not verified

- C-World acceptance at ACL 2026 (snippet only).
- Code4Scene (no source found). worldsim (secondary sources only).
- MCP-Persona simulation method (abstract silent).
