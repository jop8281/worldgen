# Stateful API/Tool-Use Agent Benchmarks ("Worlds" Graded by End State)

Scope: how existing benchmarks implement a stateful replica of software (data model, API surface, state store, reset/snapshot, determinism), how tasks are authored, how grading works, and what each world cost to build. These are design precedents for a lightweight world engine that runs and grades worlds such as helpdesk, CRM, and payments API replicas. Research date: 2026-10-06.

---

## 1. tau-bench and tau2/tau3-bench (Sierra): domain structure, DB-hash grading, pass^k, user simulator, dual control, code layout

### Takeaway
tau-bench is the cleanest template for a lightweight world engine. Each domain is a Pydantic DB loaded from `db.json`, a Python toolkit that reads and mutates it, a `policy.md`, and a `tasks.json`. Grading replays a reference action list on a fresh "gold" copy of the world and compares a hash of the whole DB with the agent's end state. The final reward multiplies that DB check with a substring check on what the agent must tell the user. The weak point is the task data, not the engine: several rounds of fixes (75+ in tau3, plus the Amazon "Verified" fork) were needed because tasks were wrong, ambiguous, or impossible under the policy.

### Cited Findings
**Original tau-bench (2024)**
- An LLM-simulated user talks with an agent that has domain API tools and policy guidelines. Evaluation "compares the final database state against annotated goal states" — [arXiv 2406.12045](https://arxiv.org/abs/2406.12045)
- The paper introduces **pass^k**, which measures whether an agent succeeds consistently across repeated trials of the same task. GPT-4o succeeded on <50% of tasks, and its pass^8 in retail was <25% — [arXiv 2406.12045](https://arxiv.org/abs/2406.12045)

**tau2-bench (June 2025)**
- Adds a **telecom dual-control domain** "modeled as a Dec-POMDP, where both agent and user make use of tools" in a shared environment. The user simulator is "tightly coupled with the environment, whose behavior is constrained by tools and observable states" — [arXiv 2506.07982](https://arxiv.org/abs/2506.07982)
- A **compositional task generator** "programmatically creates diverse, verifiable tasks from atomic components." Performance drops significantly when going from no-user mode to dual-control mode. Ablations separate reasoning errors from communication and coordination errors — [arXiv 2506.07982](https://arxiv.org/abs/2506.07982)

**Code layout (GitHub, main branch, read Oct 2026)**
- Domains are `mock`, `airline`, `retail`, `telecom`, and `banking_knowledge` (new in v1.0.0, "tau3-bench"). Each domain has a data model, tools, policy, and tasks under `src/tau2/domains/` — [tau2-bench repo](https://github.com/sierra-research/tau2-bench)
- Data files per domain: `data/tau2/domains/<domain>/{db.json, policy.md, tasks.json, split_tasks.json}`. Airline also has `tasks_voice.json` and `audio_difficulty.json`, and `banking_knowledge` ships a `documents/` corpus of JSON docs for RAG — [repo tree](https://github.com/sierra-research/tau2-bench/tree/main/data/tau2/domains)
- **State store:** `class DB(BaseModelNoExtra)` loads from JSON/YAML/TOML via `model_validate`. `get_hash()` returns `get_pydantic_hash(self)`, a hash over the whole Pydantic model — [db.py](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/environment/db.py)
- **Environment API:** `get_policy`, `get_tools`, `get_user_tools`, `make_tool_call`, `_is_mutating_tool`, `run_env_assertion`, `get_db_hash`, `get_user_db_hash`, and `set_state(initialization_data, initialization_actions, message_history)`. The agent and user toolkits have **separate DBs** (agent DB and user DB), which is how dual control is modelled — [environment.py](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/environment/environment.py)
- **Grading by replay (event sourcing):** the evaluator rebuilds a *predicted* environment by replaying the full trajectory's tool calls through `set_state(... message_history=full_trajectory)`. It builds a *gold* environment from the same initial state and replays `evaluation_criteria.actions` on it. It then compares both agent-DB and user-DB hashes, giving `db_reward` = 1 or 0. `env_assertions` are run on the predicted environment and multiplied in — [evaluator_env.py](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/evaluator/evaluator_env.py)
- **Reward = product of the components in `reward_basis`.** The default for airline, retail and telecom is `["DB", "COMMUNICATE"]`. The available components are:
  - `DB`: hash match.
  - `ENV_ASSERTION`: Python predicate functions on the environment.
  - `COMMUNICATE`: substring match of required strings in the agent's messages.
  - `NL_ASSERTION`: LLM judge, marked experimental/WIP.
  - `ACTION`: trajectory match, used only in a subset of `banking_knowledge` tasks.

  [docs/evaluation.md](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md)
- `evaluation_criteria.actions` is "**one** reference trajectory … not the only correct one". It exists because "the target DB state is easier to express as 'play these actions on a fresh env' than to spell out by hand". Any path that produces an equivalent end state passes, including no tool calls at all when the right answer is to refuse — [docs/evaluation.md](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md); design discussion in [issue #224](https://github.com/sierra-research/tau2-bench/issues/224) and [RFC #129](https://github.com/sierra-research/tau2-bench/issues/129)
- Task schema (`tasks.py`): `UserScenario` / `StructuredUserInstructions`, `InitialState{initialization_data, initialization_actions, message_history}`, `EvaluationCriteria`, and a `TaskIssue` model for tracking known task bugs — [tasks.py](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/data_model/tasks.py)
- **tau3 updates (v1.0.0+):**
  - A knowledge/RAG domain (`banking_knowledge`).
  - Full-duplex voice via realtime providers (OpenAI, Gemini, xAI).
  - "75+ fixes" for incorrect actions, ambiguous instructions, and impossible constraints.
  - A gymnasium-compatible RL environment with train/test splits.
  - A leaderboard at taubench.com.

  [tau2-bench README](https://github.com/sierra-research/tau2-bench); [taubench.com](https://taubench.com)
- **tau2-Bench-Verified (Amazon AGI)** corrects tasks whose "task definitions, expected actions, and evaluation criteria did not properly align with the stated policies or database contents". The categories are policy-compliance, DB-accuracy (wrong item IDs, passenger info, payment references), logical-consistency, and evaluation-ambiguity errors — [amazon-agi/tau2-bench-verified](https://github.com/amazon-agi/tau2-bench-verified)

### Inferences
- The minimum viable "world" pattern from tau2 is:
  - a typed JSON DB (Pydantic) with a canonical hash;
  - pure-Python tool functions that are flagged as mutating or read-only;
  - a markdown policy;
  - tasks given as initial-state patch + user persona/instructions + reference actions + required communications.

  Deriving the target state by replaying gold actions avoids hand-writing expected DB states, and that keeps the cost of authoring a task low.
- Whole-DB hash equality is all-or-nothing. It catches collateral damage for free, because any extra write changes the hash. It also fails a run on benign differences (timestamps, auto-generated IDs, harmless extra records) unless the world is fully deterministic. That is presumably why tau worlds avoid wall-clock time and random IDs inside tools.
- Keeping separate agent and user DBs is a cheap way to model "the customer's device or account state" in helpdesk worlds.

### Gaps
- Exact task counts per domain were not re-verified this session. From memory, the original retail and airline sets were about 115 and 50 test tasks, and telecom had about 114 tasks. Check these against the papers' PDFs.
- The exact pass^k formula was not retrieved. The original paper defines it as an unbiased estimator over n trials with c successes, analogous to pass@k; verify this in the PDF.
- A search snippet claimed that "29 of 50 airline tasks were substantively changed between tau2 and tau3". It could not be confirmed from a primary source, so do not cite it.
- The build effort (person-hours) for the tau domains is not published in the sources reviewed.

---

## 2. AppWorld (Stony Brook, ACL 2024): 9 apps, 457 APIs, state-based unit tests with collateral-damage checks

### Takeaway
AppWorld is the heavyweight end of the "simulated apps" approach. It took more than 100K lines of custom code: a 60K LOC engine plus a 40K LOC benchmark. The world is 9 apps and 457 APIs backed by SQLite and populated with about 100 fictitious people. Grading uses programmatic unit tests on the DB state that also check that nothing unexpected changed (collateral damage).

### Cited Findings
- The world has 9 day-to-day apps (for example Amazon, Spotify, Venmo) exposing 457 APIs, populated with "realistic digital activities simulating the lives of ~100 fictitious users". It contains 750 tasks that require "rich and interactive code generation" — [arXiv 2407.18901](https://arxiv.org/abs/2407.18901)
- Engineering size: the AppWorld Engine is 60,000 LOC and the AppWorld Benchmark is 40,000 LOC — [arXiv 2407.18901](https://arxiv.org/abs/2407.18901)
- Grading is "robust programmatic evaluation with state-based unit tests, allowing for different ways of completing a task while also checking for unexpected changes, i.e., collateral damage" — [arXiv 2407.18901](https://arxiv.org/abs/2407.18901)
- Results: GPT-4o solved about 49% of normal tasks and about 30% of challenge tasks — [arXiv 2407.18901](https://arxiv.org/abs/2407.18901)
- **State store and reset:**
  - State lives in SQLite DBs. There are base DBs plus task-specific variations, and only the diffs are stored to save disk space.
  - `AppWorld(task_id)` resets the DBs and the task-specific timestamp, so the clock is frozen per task.
  - `world.save_state()` / `world.load_state(state_id)` provide checkpoints. The README cautions that arbitrary reverts are "not possible in real life (e.g., if an agent sends someone money on Venmo)".

  [AppWorld repo](https://github.com/StonyBrookNLP/appworld)
- Agent code runs in a restricted Python executor that allows the standard library and `pendulum` "except destructive modules and functions" — [AppWorld repo](https://github.com/StonyBrookNLP/appworld)
- **Metrics:** TGC (Task Goal Completion) and SGC (Scenario Goal Completion, all tasks in a scenario pass). Evaluation reports list which assertions passed or failed, with stack traces — [AppWorld repo](https://github.com/StonyBrookNLP/appworld)
- **Authoring:** tasks come from "task generators". Train and dev sets ship full ground truth (required apps, APIs, solution code); the test set exposes only difficulty — [AppWorld repo](https://github.com/StonyBrookNLP/appworld)
- **2025–26 updates:** all APIs are exposed over **MCP** (HTTP and STDIO), with agent integrations for OpenAI-Agents and SmolAgents and a leaderboard at appworld.dev — [AppWorld repo](https://github.com/StonyBrookNLP/appworld); [leaderboard](https://appworld.dev/appworld/leaderboard)

### Inferences
- AppWorld's pattern of "assert required changes plus assert nothing else changed" is a more forgiving, diagnosable alternative to tau's whole-DB hash. It is a state diff with an allow-list of expected mutations, and it yields per-assertion failure reports.
- Freezing the clock per task and storing per-task diffs over a base DB are cheap, high-value determinism and snapshot tricks for any engine.
- The 100K LOC cost is the counter-example: hand-building realistic multi-app worlds does not scale. That motivates generating worlds (schema plus tools) rather than hand-coding them.

### Gaps
- The person-hours or calendar time to build AppWorld are not stated in the sources reviewed; only LOC is given.
- The exact mechanism of the collateral-damage check (for example, diffing all tables apart from whitelisted ones) was not confirmed from code this session.

---

## 3. ToolSandbox (Apple), BFCL v3/v4 multi-turn, NESTFUL, ComplexFuncBench, ACEBench

### Takeaway
ToolSandbox gives partial credit by matching "milestones" (an ordered set of target DB snapshots, scored by similarity) and penalizes "minefields" (forbidden states or actions). BFCL v3 uses Python class backends (file system, trading, travel, and others) and grades on both final backend state and a subset match of the call trajectory. NESTFUL, ComplexFuncBench and ACEBench are mostly about calling functions correctly, with lighter or no persistent world state.

### Cited Findings
**ToolSandbox (Apple, 2024)**
- It features "stateful tool execution, implicit state dependencies between tools", a built-in LLM user simulator for on-policy conversational evaluation, and "a dynamic evaluation strategy for intermediate and final milestones over an arbitrary trajectory". The hardest categories are State Dependency, Canonicalization, and Insufficient Information — [arXiv 2408.04682](https://arxiv.org/abs/2408.04682)
- **World state:** an "execution context" holds the complete sandbox state as DB tables: settings (cellular/WiFi), contacts, messages, and reminders. Tools are composable Python functions with visibility controlled per role — [apple/ToolSandbox](https://github.com/apple/ToolSandbox)
- **Grading:**
  - Milestones are critical checkpoints that must occur in order, each holding snapshot constraints. Similarity types are snapshot, addition/removal/update, tool-trace, and guardrail (strict identity; 0 on mismatch).
  - "Milestone similarity is derived by calculating the geometric mean of all its similarity measures."
  - The user simulator ends the episode with an `end_conversation` tool.

  [apple/ToolSandbox](https://github.com/apple/ToolSandbox)

**BFCL v3 multi-turn (Berkeley)**
- There are 8 API backends: GorillaFileSystem, VehicleControl, TradingBot, TravelAPI, plus cross-cutting Twitter, Message, Ticket, and Math — [BFCL v3 blog](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)
- **State-based evaluation** checks that the backend reaches the correct final state, capturing writes and deletes. **Response-based evaluation** uses subset matching: the ground-truth calls must appear, but extra exploratory calls are allowed — [BFCL v3 blog](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)
- **Authoring:** human experts hand-labelled trajectories, with "11 filtering rounds" covering clarity, executability, completeness of the initial config, and unit tests of the API backends. The categories are base, missing-params, missing-functions, long-context, and composite — [BFCL v3 blog](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)
- **Failure modes observed:** models fail to check current state before acting, misread existing conditions, and over-authenticate when already logged in. "Even top-performing LLMs fail to explore current state before non-reversible actions" — [BFCL v3 blog](https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html)

**NESTFUL (IBM, EMNLP 2025)**
- It contains 1,800+ nested sequences in which one call's output feeds the next, and all calls are executable. Best result: GPT-4o at 28% full-sequence match and 60% win rate — [arXiv 2409.03797](https://arxiv.org/pdf/2409.03797v3); [IBM/NESTFUL](https://github.com/IBM/NESTFUL)

**ComplexFuncBench (2025)**
- It has 1,000 samples across 5 scenarios, covering multi-step, constrained calls and long-context parameter filling. It is graded with the ComplexEval framework — [arXiv 2501.10132](https://arxiv.org/pdf/2501.10132)

**ACEBench (2025)**
- It has Normal, Special (ambiguous or incomplete instructions), and Agent (multi-agent, multi-turn simulated dialogue) categories. It is designed to avoid relying on "LLMs or real API executions for evaluation" — [arXiv 2501.12851](https://arxiv.org/abs/2501.12851)

### Inferences
- ToolSandbox's milestones/minefields pattern is a strong design for graded partial credit and explicit "forbidden state" checks, for example "never refund twice" or "never delete the customer". It suits a helpdesk or payments world well.
- In BFCL, "state check + subset trajectory check" amounts to belt-and-braces grading. The trajectory component brings back some lock-in risk (see section 5).

### Gaps
- ToolSandbox tool and scenario counts were not retrieved; from memory they are about 34 tools and about 1K scenarios, which needs verification.
- BFCL v4 (agentic web search and memory) details were not fetched. ACEBench's Agent-category grading details (end state vs. process) were not confirmed from the abstract.

---

## 4. MCP-era and enterprise worlds: MCPMark, Toolathlon, MCP-Universe, MCP-Bench, CRMArena-Pro, WorkArena/++, TheAgentCompany, EnterpriseBench

### Takeaway
Since 2025 the field has split in two:
1. **"Real software in containers or sandboxes"**: TheAgentCompany's self-hosted GitLab/Plane/OwnCloud/RocketChat, WorkArena's ServiceNow instances, CRMArena's Salesforce orgs, MCPMark's Notion/GitHub/Postgres, and Toolathlon's 32 apps. These use curated initial states plus per-task Python verification scripts.
2. **"Live MCP servers"**: MCP-Universe and MCP-Bench, which lean on dynamic or LLM-judge evaluation.

Building cost is dominated by expert task-plus-verifier authoring: 3–5 hours per task for MCPMark, and about 3,000 person-hours for 175 tasks in TheAgentCompany.

### Cited Findings
**MCPMark (ICLR 2026)**
- 127 tasks over 5 environments (Notion, GitHub, Filesystem, PostgreSQL, Playwright). Each task = instruction + curated initial state + programmatic verification script, with heavy CRUD — [arXiv 2509.24002](https://arxiv.org/html/2509.24002v1); [ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/hash/8138d211ce8790fdfbeeeb9781838a37-Abstract-Conference.html)
- **Initial states:**
  - Notion: from 9 marketplace templates.
  - GitHub: from repos with realistic histories.
  - Postgres: from template DBs.
  - Playwright: from pages adapted from WebArena.

  "States reset after verification to prevent side effects" — [arXiv 2509.24002](https://arxiv.org/html/2509.24002v1)
- Verifiers are programmatic, not LLM-based, and average about 209.8 LOC each. Authoring is human–agent collaborative with 10 experts going through explore → evolve → verify → iterate. "Each task takes 3∼5 hours of focused expert effort", followed by a month-long community validation — [arXiv 2509.24002](https://arxiv.org/html/2509.24002v1)
- **Metrics:** pass@1, pass@4, and pass^4. GPT-5-medium scored 52.56% / 68.50% / 33.86%. Other leading models scored <30% pass@1. Runs average 16.2 turns and 17.4 tool calls, and "higher cost does not lead to higher accuracy" — [arXiv 2509.24002](https://arxiv.org/html/2509.24002v1)

**Toolathlon (ICLR 2026)**
- 32 apps and 604 tools, mostly through MCP servers that the authors revised or implemented. Apps range from Google Calendar and Notion to WooCommerce, Kubernetes, and BigQuery. Initial states are realistic, "such as Canvas courses with dozens of students or real financial spreadsheets" — [arXiv 2510.25726](https://arxiv.org/abs/2510.25726)
- 108 tasks, about 20 turns on average, each "strictly verifiable" with dedicated evaluation scripts. Best: Claude-4.5-Sonnet at 38.6% (20.2 turns). Best open-weights: DeepSeek-V3.2-Exp at 20.1% — [arXiv 2510.25726](https://arxiv.org/abs/2510.25726). (One search aggregator misreported the best model as "Claude-3-Sonnet 29.9%"; the arXiv abstract is authoritative.)

**MCP-Universe (Salesforce, 2025)**
- 6 domains over 11 real MCP servers. Evaluators come in three kinds:
  - format;
  - static (time-invariant matching);
  - dynamic (they "automatically retrieve real-time ground truth" for temporally sensitive tasks).

  Results: GPT-5 43.72%, Grok-4 33.33%, Claude-4.0-Sonnet 29.44% — [arXiv 2508.14704](https://arxiv.org/abs/2508.14704)

**MCP-Bench (2025)**
- 28 live MCP servers and 250 tools. It is evaluated on tool-level schema use, trajectory-level planning, and task completion, combining rule-based checks with an LLM-judge rubric — [arXiv 2508.20453](https://arxiv.org/abs/2508.20453)

**CRMArena-Pro (Salesforce, 2025)**
- **World:**
  - Two real Salesforce orgs: B2B with 29,101 records and B2C with 54,569 records.
  - A merged schema from Service Cloud, Sales Cloud, and CPQ covering 25 interconnected objects (Account, Contact, Case, Opportunity, Quote, Product, Knowledge, …).
  - Agents act through SOQL/SOSL "Execute" plus "Respond".

  [arXiv 2505.18878](https://arxiv.org/html/2505.18878)
- **Data generation:** GPT-4o generates records grounded in the schema, using "21 latent variables" to induce realistic causal distributions. The data is then deduplicated, format-checked, and checked by an LLM for plausibility. CRM experts rated the B2B data 66.7% realistic and the B2C data 62.3% — [arXiv 2505.18878](https://arxiv.org/html/2505.18878)
- **Tasks:** 4,280 queries in total, made of 19 tasks × 100 instances × 2 orgs plus 240 confidentiality queries.
- **Grading:**
  - Exact match for IDs and other precise answers.
  - Token F1 for text answers.
  - An LLM (gpt-4o) extracts answers from multi-turn dialogue.
  - An LLM judge (gpt-4o) evaluates confidentiality refusals.

  Results: about 58% single-turn, about 35% multi-turn, >83% on workflow execution, and "near-zero" confidentiality awareness. The simulated user's error rate was 1/20 in an audit — [arXiv 2505.18878](https://arxiv.org/html/2505.18878)

**WorkArena / WorkArena++ (ServiceNow)**
- L1 (WorkArena) has 33 tasks and 19,912 instances. L2 (WorkArena++) has 682 compositional tasks, plus an L3 tier. Every task implements **`setup` / `validate` / `cheat`**, where `cheat` is a scripted Playwright oracle that completes the task. Interaction with the instance goes through the ServiceNow REST API, instances are seeded, and access to a hosted instance is gated through HuggingFace — [ServiceNow/WorkArena](https://github.com/ServiceNow/WorkArena); [arXiv 2407.05291](https://arxiv.org/abs/2407.05291)
- WorkArena++ can "effortlessly generate thousands of ground-truth observation/action traces" for fine-tuning, made possible by the oracle `cheat` functions — [arXiv 2407.05291](https://arxiv.org/abs/2407.05291)

**TheAgentCompany (CMU, 2024–25)**
- **World:** self-hosted GitLab, OwnCloud, Plane, and RocketChat, with LLM-driven NPC colleagues that have profiles (name, role, responsibilities, projects) and live in RocketChat — [arXiv 2412.14161](https://arxiv.org/html/2412.14161)
- **Tasks and grading:** 175 tasks across SWE, PM, data science, admin, HR, and finance. Each task has checkpoints with point values. Most are graded by deterministic Python functions on environment state, and about 51 tasks (29%) use LLM evaluators. Partial credit is `S_partial = 0.5·Result/Total + 0.5·S_full` — [arXiv 2412.14161](https://arxiv.org/html/2412.14161)
- **Cost:** "approximately 3,000 person-hours" across 20 contributors over about two months, with complex tasks taking >10 h each. Best: Gemini 2.5 Pro at 30.3% full / 39.3% partial, about 27 steps, and $4.2 per task — [arXiv 2412.14161](https://arxiv.org/html/2412.14161)

**EnterpriseBench (EMNLP 2025)**
- 500 tasks across SWE, HR, finance, and admin. The sandbox holds 50K+ data points (emails, code repos, CRM records, policies, IT tickets, chats) across 5 departments. It models access-control hierarchies and data fragmentation. Best completion is 41.8% — [ACL Anthology 2025.emnlp-main.466](https://aclanthology.org/2025.emnlp-main.466/); [arXiv 2510.27287](https://alphaxiv.org/abs/2510.27287)

### Inferences
- Three costs recur across these benchmarks: **curating the initial state**, **writing a per-task verifier**, and **resetting**. They are expensive with real SaaS (Notion, Salesforce, ServiceNow): there are rate limits, shared mutable instances, and slow resets via template duplication. With self-hosted containers (TheAgentCompany) resets are cheap, but setup is heavy. A lightweight engine with in-process typed state (tau-style) makes reset essentially free (reload JSON) and fully deterministic.
- WorkArena's `setup/validate/cheat` triad is a valuable contract. `cheat` (an oracle solver) proves that each task is solvable and lets generated tasks be self-validated. It also yields training traces, mirroring how tau uses gold actions to derive target state.
- CRMArena-Pro shows that LLM-generated, schema-grounded seed data with latent variables can be good enough to pass expert realism checks (about 2/3 rated it realistic). This is a direct precedent for generating a CRM or helpdesk world's data.
- The trend in MCP benchmarks toward pass^k-style consistency metrics (MCPMark pass^4, tau pass^k) indicates that worlds must be cheap to run many times. This is another argument for in-memory state.

### Gaps
- No primary source this session gave reset times or per-run cost for the Notion/GitHub-based MCPMark environments, or for Salesforce-org resets in CRMArena.
- WorkArena's instance reset mechanism and the 2025–26 updates to WorkArena (for example, ServiceNow hosted instances) were not confirmed.
- Not fetched this session: EnterpriseBench grading details, original CRMArena (v1, 9 tasks), and other MCP benchmarks (LiveMCPBench, MCP-Atlas, MCPVerse).

---

## 5. Recurring grading patterns and their failure modes

### Takeaway
Five grading patterns recur:
1. Final-state equality, either a whole-DB hash (tau) or a state diff with collateral checks (AppWorld).
2. Per-task assertion scripts and verifiers (MCPMark, Toolathlon, TheAgentCompany, WorkArena `validate`).
3. Milestone/minefield similarity with partial credit (ToolSandbox).
4. Output matching: exact, F1, or substring "communicate" (CRMArena-Pro, tau).
5. LLM-judge rubrics (MCP-Bench, part of TheAgentCompany, CRMArena confidentiality, tau `NL_ASSERTION`).

A 2026 audit found that the evaluator disagreed with human experts on 18.5% of tasks in BFCL v4, tau2, and the MCP benchmarks. The failures differ by type: deterministic graders are brittle and lock in one trajectory, while LLM judges drift and vary from run to run.

### Cited Findings
- **Audit:** *Benchmarking the Benchmarks: A Validity Audit of Tool-Calling Evaluation* (Bhat, Vaghasiya, Mohsin, Aali, 2026) reviewed 496 tasks from BFCL v4, tau2-Bench, LiveMCPBench, and MCP-Atlas. It found "92 evaluator-human disagreements, corresponding to an 18.5% misalignment rate" — [arXiv 2607.02577](https://arxiv.org/abs/2607.02577)
  - Deterministic-grader failures: "brittle state matching, trajectory lock-in, incorrect ground truths, substring-based communication failures, reward-basis misalignment".
  - LLM-judge failures: "rubric drift, hallucinated completion, answer-only scoring, substantial run-to-run variance".
  - In LiveMCPBench, 23 repeated evaluations of the same setup ranged from 57.9% to 76.8%, an 18.9-point spread.

  [arXiv 2607.02577](https://arxiv.org/abs/2607.02577)
- **Task-data errors dominate tau-style benchmarks:**
  - tau3 needed "75+ fixes" for incorrect actions, ambiguous instructions, and impossible constraints — [tau2-bench README](https://github.com/sierra-research/tau2-bench)
  - Amazon's Verified fork fixed policy-violating gold actions, wrong IDs in the DB, impossible scenarios, and vague instructions — [tau2-bench-verified](https://github.com/amazon-agi/tau2-bench-verified)
  - Further 2026 critiques appear as related work: on policy ambiguity being scored as agent error, [arXiv 2609.14400](https://arxiv.org/pdf/2609.14400); on log analysis, [arXiv 2605.08545](https://arxiv.org/pdf/2605.08545). Both were found via search and not read in full.
- **Trajectory matching penalizes valid alternative paths.** Sierra therefore keeps `ACTION` out of the reward for airline, retail and telecom, and documents it as "a strong assumption" — [tau2 docs/evaluation.md](https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md)
- **Substring "communicate" checks** are a known source of false negatives and are named as a failure class in the audit — [arXiv 2607.02577](https://arxiv.org/abs/2607.02577)
- **Live or real-time worlds** need dynamic ground truth (MCP-Universe's dynamic evaluators), which brings non-determinism — [arXiv 2508.14704](https://arxiv.org/abs/2508.14704)
- **Collateral-damage checks:** AppWorld checks explicitly for "unexpected changes", and tau's whole-DB hash covers them implicitly — [arXiv 2407.18901](https://arxiv.org/abs/2407.18901); [evaluator_env.py](https://github.com/sierra-research/tau2-bench/blob/main/src/tau2/evaluator/evaluator_env.py)
- **Forbidden-state and guardrail checks:**
  - ToolSandbox's guardrail similarity returns 0 on mismatch — [apple/ToolSandbox](https://github.com/apple/ToolSandbox)
  - CRMArena-Pro's confidentiality refusals are scored by an LLM judge — [arXiv 2505.18878](https://arxiv.org/html/2505.18878)
- **Partial credit vs. binary:**
  - TheAgentCompany: checkpoints with 0.5/0.5 weighting — [arXiv 2412.14161](https://arxiv.org/html/2412.14161)
  - ToolSandbox: geometric mean of similarities — [apple/ToolSandbox](https://github.com/apple/ToolSandbox)
  - tau, MCPMark, Toolathlon: binary.

### Inferences
- Recommended layered grader for a lightweight world engine:
  1. A typed state diff against a gold end state derived by replaying oracle actions (tau). Diff rather than hash, normalising volatile fields (IDs, timestamps).
  2. Explicit allow-lists of expected mutations plus forbidden-state assertions (AppWorld collateral checks, ToolSandbox minefields).
  3. Output checks on required communications, preferably structured or semantic rather than substring.
  4. An LLM judge only for unstructured deliverables, run multiple times or with a fixed rubric, and reported as a separate metric (per the audit's "decomposed metrics" recommendation).
- Build an oracle "cheat" solver per task (WorkArena) and run it in CI. Every task should verify as solvable and its grader as passing on the oracle and failing on a no-op agent. This directly targets the task-data-error class that forced tau's 75+ fixes.
- Determinism is a property of the engine: freeze the clock per task (AppWorld), seed ID generation, and keep in-process state with JSON snapshots. These are what make pass^k measurements meaningful and cheap.

### Gaps
- Not fetched this session: quantitative false-positive and false-negative rates for specific graders in specific benchmarks, beyond the audit's aggregate 18.5%.
- No source compared the build cost of a "generated world" against a "hand-built world" head to head. The cost anchors available are AppWorld (100K+ LOC), TheAgentCompany (3,000 person-hours / 175 tasks ≈ 17 h per task including environment), and MCPMark (3–5 expert-hours per task plus about 210 LOC of verifier).
