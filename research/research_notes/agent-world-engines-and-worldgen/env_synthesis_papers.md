# Research papers that automatically synthesize agent environments / tool worlds with LLMs (academic analogs to "WorldGen")

Method note: arXiv IDs, titles, dates and abstracts were checked against the arXiv API (export.arxiv.org) on 2026-10-06. Deep details (pipeline stages, numbers) for AWM, EnvScaler, AutoEnv, AgentScaler, DeepSeek-V3.2, Kimi K2, GLM-4.5, MiniMax-M2 and Simia come from full-text arXiv HTML read via a summarizing fetch tool. Treat exact figures as "as reported by the fetch summary"; spot-check them against the PDFs before quoting them in anything public. Details for every other paper come from the arXiv abstract only and are marked [abstract-only].

---

## Q1. Per-work catalog: input -> output, validation/self-repair, scale, quality metrics, open-source status, lessons

### Takeaway
The field moved quickly. In 2024 the work was "LLM writes configs or PDDL-like worlds" (EnvGen, AgentGen) or "LLM writes verified function-call data" (APIGen, ToolACE). By 2025–2026 it was "LLM or coding agent writes a whole executable, DB-backed, MCP-exposed world plus tasks plus verifiers, with execution-driven self-repair" (AWM, EnvScaler, AutoEnv, AgentScaler, DeepSeek-V3.2, AutoForge, CompoWorld, ClawEnvKit, InfiniteWeb, SETA, SkillGym, WorkForge, VERA). The closest analog to WorldGen (an NL description becoming a runnable stateful world with tasks and graders) is **Agent World Model (AWM, arXiv 2602.10090)**. **ClawEnvKit (2604.18543)** is the closest to "a user types an NL description and gets a verified env on demand."

### Cited Findings

#### A. Code-generating (executable) environment synthesizers. The closest WorldGen analogs.

**Agent World Model (AWM): "Infinity Synthetic Environments for Agentic RL"**, arXiv 2602.10090 (Feb 2026, Snowflake)
- Input: 100 popular domain names as seeds. An LLM writes scenario descriptions, a classifier keeps the CRUD/stateful ones, and embedding dedup plus category caps keep them diverse. Result: 1,000 scenarios — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Pipeline: scenario, then 10 tasks per scenario (10,000 tasks; tasks must be API-solvable and assume a logged-in user), then a **SQLite schema inferred from the tasks** (mean 18.5 tables), then seed data (mean 129.3 records, derived from task preconditions), then a toolset schema, then **MCP tool code in Python** (mean 35.1 tools and about 1,985 LOC per env; 35,062 tools total), then verification code — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Self-repair: each component runs in isolation, and runtime errors go back to the LLM for up to 5 iterations. Up to 10% failure per stage is tolerated to save cost. First-attempt success was 88.3% (DB), 88.2% (sample data) and 86.8% (env code), at about 1.12–1.13 average iterations — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Grader: a "code-augmented LLM-as-a-Judge". It compares the DB state before and after and outputs {Completed, Partially Completed, Agent Error, Environment Error}. Reward is 1.0 for completed, 0.1 for partial, 0 otherwise, and -1 with early termination for a malformed tool call. In the ablation (Qwen3-8B), code-augmented reached 65.94 on BFCLv3, LLM-only 55.46 and code-only 60.00. Judge self-consistency was 90.8%, Fleiss' κ 0.891, and reward flip rate 9.2% — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Cost: generated with GPT-5 at about $57.09 per 100 environments, of which toolset schema $23.74 is the largest item — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- RL: GRPO on Qwen3 4B/8B/14B, using 526 envs and 3,315 tasks with 1,024 parallel env instances. About 4% environment errors occurred during RL — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Results for 8B: BFCLv3 went from 53.83 to 65.94, against 52.53 for an LLM-simulator baseline and 36.83 for EnvScaler. τ²-Bench pass@1 went from 26.44 to 33.45; EnvScaler scored higher here at 39.39. MCP-Universe went from 6.70 to 11.17 — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Quality audit on a 100-env sample: task feasibility 3.99/5 (EnvScaler 3.14), 11.5% blocked tasks (EnvScaler 46.8%), and 2.70 bugs per env (EnvScaler 1.82). **74% of environments contain at least one bug**; about 44% of bugs are unhandled edge cases and 14% are DB-constraint conflicts. Performance rises monotonically with environment count, and training on 10 envs overfits badly — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Difficulty: 69% of "very hard" tasks (11 or more tool calls) were unsolved by both Claude and GPT-5.1 — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Open source: the code and the 1,000 envs are at github.com/Snowflake-Labs/agent-world-model — [arXiv abstract](https://arxiv.org/abs/2602.10090)

**EnvScaler**, arXiv 2601.05808 (Jan 2026, RUC NLPIR)
- Input: no NL spec from a user. Env "topics" are mined from existing task sets (API-Bank, ToolACE), an LLM infers env descriptions from them, and the descriptions are deduplicated by clustering — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- SkelBuilder: logic planning (states, domain rules, tool ops), then program modeling (a **Python class whose attributes are the state and whose methods are the tools**), then assembly, then an AST syntax check — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- Validation is a dual-agent loop. A testing agent issues random positive and negative tool calls, and a checking agent reads the source code and the state diffs. It runs 100 rounds per env and discards envs below a 0.85 pass rate. This cut 266 envs to 191 (28% rejected) — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- ScenGenerator: an LLM writes the initial DB state, then tasks, then **rule-based terminal-state validation functions**. Reward is the fraction of checks passed, which gives partial credit and allows multiple solution paths — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- Scale: 191 envs (avg 18.6 tools, 21.4 state categories, 4.6 rules), about 7K scenarios and about 9K SFT trajectories. Synthesis used GPT-4.1 and Qwen3-235B. Cost was about $1.02 per env (mostly the 100-round test) and $0.06 per scenario — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- Results: on BFCL-v3 multi-turn, Qwen3-8B went from 28.88 to 41.88. On ACEBench-Agent it went from 38.19 to 72.50. τ-bench gained only 3–6 points. Most gains come from the first 0–20 envs, with diminishing returns after that — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- Open source: github.com/RUC-NLPIR/EnvScaler — [arXiv abstract](https://arxiv.org/abs/2601.05808)

**AutoEnv**, arXiv 2511.19304 (Nov 2025, FoundationAgents/MetaGPT group)
- Input: NL "environment themes" (game-like rule worlds). These become a design, then a YAML DSL with three layers (BaseEnv for dynamics and reward, ObsEnv for observability, SkinEnv for rendering), and then coding agents generate the classes plus a level generator and a validator — [arXiv 2511.19304](https://arxiv.org/html/2511.19304)
- Self-repair runs for up to 40 iterations. Verification has three stages: execution (90.0% pass), level generation (96.7%), and a reliability "differential model test" (74.7%). The differential test rejects an env if the weaker model (GPT-4o-mini) consistently beats the stronger one (DeepSeek-V3.1), on the logic that the reward should reflect skill — [arXiv 2511.19304](https://arxiv.org/html/2511.19304)
- 65% end-to-end success (100 themes gave 65 envs). Human theme review raised success from 60% to 80%. Cost averaged $4.12 per env. AutoEnv-36 has 36 envs and 358 levels, on which 7 LLMs reach only 12–49% normalized reward — [arXiv 2511.19304](https://arxiv.org/html/2511.19304)
- Lesson: no single learning method scales across heterogeneous envs, and gains shrink as the number of envs grows. Code is at github.com/FoundationAgents/AutoEnv — [arXiv abstract](https://arxiv.org/abs/2511.19304)

**AgentScaler, "Towards General Agentic Intelligence via Environment Scaling"**, arXiv 2509.13311 (Sep 2025, Alibaba Tongyi; Qwen3-based)
- Input: 30K+ APIs from ToolBench, APIGen and internal sources. A tool-dependency graph (parameter similarity) is partitioned with Louvain communities into **1,000+ domains**. Each domain gets a DB schema covering the tools' read/write patterns, and the tools become Python code that operates on that DB — [arXiv 2509.13311](https://arxiv.org/html/2509.13311)
- Trajectories come from sampling coherent tool sequences on the domain graph and executing them. Three filters follow: validity, final-DB-state match against the golden target, and exact tool-sequence match — [arXiv 2509.13311](https://arxiv.org/html/2509.13311)
- Models: AgentScaler-4B/8B/30B-A3B, reported SOTA for their size on τ-bench, τ²-Bench and ACEBench-en. Limitation: SFT only, no RL — [arXiv 2509.13311](https://arxiv.org/html/2509.13311)
- Open-source status: not verified.

**AutoForge**, arXiv 2512.22857 (Dec 2025) [abstract-only]
- A unified, automated pipeline that synthesizes simulated environments with "high-difficulty but easily verifiable tasks", plus an environment-level RL algorithm. That algorithm addresses simulated-user instability and estimates advantage per environment. Evaluated on τ-bench, τ²-Bench and VitaBench — [arXiv 2512.22857](https://arxiv.org/abs/2512.22857)

**CompoWorld**, arXiv 2609.33665 (Sep 2026) [abstract-only]
- Coding agents turn tool specs into **verified services with typed state and shared interfaces**, and a world model (LLM) handles tools that cannot be implemented reliably. This is an explicit **hybrid of code and simulation**. A random walk over service dependency graphs composes cross-service tasks. Scale: 448 services and 10,130 tools, with 3K SFT trajectories and 1K RL tasks. It reports +9.17 average over 8 benchmarks on Qwen3.6-35B-A3B — [arXiv 2609.33665](https://arxiv.org/abs/2609.33665)

**ClawEnvKit**, arXiv 2604.18543 (Apr 2026) [abstract-only]
- Takes **natural-language descriptions** as input. A parser extracts structured parameters, a generator produces the task spec, tool interface and scoring config, and a validator checks feasibility, diversity, structural validity and internal consistency. Auto-ClawEval has 1,040 envs in 24 categories and "matches or exceeds human-curated environments on coherence and clarity at 13,800x lower cost". It supports "live" on-demand env generation from a user's NL request — [arXiv 2604.18543](https://arxiv.org/abs/2604.18543)

**InfiniteWeb**, arXiv 2601.04126 (Jan 2026) [abstract-only]
- Generates functional multi-page websites for GUI agents using a unified specification, **task-centric test-driven development**, and website seeds plus reference design images. It also generates verifiable task evaluators that give dense rewards, and reports gains on OSWorld and Online-Mind2Web — [arXiv 2601.04126](https://arxiv.org/abs/2601.04126)

**SWE-Playground: "Training Versatile Coding Agents in Synthetic Environments"**, arXiv 2512.12216 [abstract-only]
- Synthesizes whole projects and tasks from scratch (no GitHub dependency), including tasks such as writing unit tests and implementing libraries — [arXiv 2512.12216](https://arxiv.org/abs/2512.12216)

**SETA: Scaling Environments for Terminal Agents**, arXiv 2607.10891 (Jul 2026) [abstract-only]
- SETA-Synth converts sources into standardized RL envs, and SETA-Evol expands them with adaptive control of difficulty and diversity. Both share one verification mechanism. Output is 4,500+ open terminal envs. Qwen3-8B with GRPO reaches 12% on Terminal-Bench 2.0 — [arXiv 2607.10891](https://arxiv.org/abs/2607.10891)

**SkillGym**, arXiv 2609.37539 (Sep 2026) [abstract-only]
- Crawls skills, keeps those that run reproducibly offline, and uses a **builder–reviewer pipeline** to make difficulty-controlled tasks, each with a **reference solution and an executable verifier**. Output: 6.8K envs and 19K verified trajectories — [arXiv 2609.37539](https://arxiv.org/abs/2609.37539)

**Skill2Env**, arXiv 2609.33772 (Sep 2026) [abstract-only]
- Turns skills into "task blueprints" (objectives, env facts, information boundaries, acceptance criteria), then into instructions, execution substrates, workspaces and rubric evaluators. **Iterative Task Hardening** uses solver execution evidence to make tasks that are too easy harder — [arXiv 2609.33772](https://arxiv.org/abs/2609.33772)

**WorkForge, "Scaling Verifiable Environments for Long-horizon Work Agents"**, arXiv 2610.04906 (Oct 2026) [abstract-only]
- Starts from expert workflows and retrieves real files into a workspace. It then extracts "factual anchors" (checkable facts) and derives instructions, a solution plan, and programmatic plus semantic verifiers from those anchors. Output: 16.7K envs across 40 domains. GDPVal improves from 45.5 to 73.6 for Qwen3.5-35B-A3B-Base — [arXiv 2610.04906](https://arxiv.org/abs/2610.04906)

**VERA**, arXiv 2610.05923 (Oct 2026) [abstract-only]
- Builds envs from initial trajectories. An agent writes rubrics and executable checks, a judge verifies each sandbox, and only envs that pass enter the training bank. The open corpus has 9,000+ long-horizon envs — [arXiv 2610.05923](https://arxiv.org/abs/2610.05923)

**daVinci-Env**, arXiv 2603.13023 (Mar 2026). Open SWE env synthesis at scale. Title-only check, not read — [arXiv 2603.13023](https://arxiv.org/abs/2603.13023)

**SWE-Universe**, arXiv 2602.02361 (Feb 2026). "Scale Real-World Verifiable Environments to Millions". Title-only check — [arXiv 2602.02361](https://arxiv.org/abs/2602.02361)

**RecreationWorld**, arXiv 2609.22000 (Sep 2026). Scalable verifiable environments for hybrid computer-use agents. Title-only check — [arXiv 2609.22000](https://arxiv.org/abs/2609.22000)

#### B. Earlier or narrower generators (2024–2025)

**EnvGen**, arXiv 2403.12014 (Mar 2024, UNC) [abstract-only]
- An LLM is given the task description and simulator objectives and generates **environment configurations** (terrain, starting items) for Crafter and Heist. It then adapts them using feedback on the agent's weak skills. The LLM writes configs for an existing simulator, not new worlds. It uses only about 4 LLM calls in total, and a small RL agent trained this way beats a GPT-4 agent and curriculum baselines — [arXiv 2403.12014](https://arxiv.org/abs/2403.12014)

**AgentGen**, arXiv 2408.00764 (Aug 2024, Microsoft/HKU) [abstract-only]
- An LLM generates environments, then planning tasks conditioned on those environments, using an "inspiration corpus" of domain text for diversity. **Bi-Evol** evolves tasks toward both easier and harder variants to smooth the difficulty curve. Instruction-tuned Llama-3.1-8B beats GPT-3.5 on AgentBoard. Project page: agent-gen.github.io — [arXiv 2408.00764](https://arxiv.org/abs/2408.00764)
- From memory, not verified: the environments are PDDL domains and text-game code.

**RandomWorld: "Procedural Environment Generation for Tool-Use Agents"**, arXiv 2506.11045 (May 2025) [abstract-only]
- Procedurally generates **interactive tools** and compositional tool-use data for SFT and online RL. Reports a new SoTA on two NESTFUL metrics, and **downstream performance scales with the amount of generated data** — [arXiv 2506.11045](https://arxiv.org/abs/2506.11045)

**Environment Tuning: "Don't Just Fine-tune the Agent, Tune the Environment"**, arXiv 2510.10197 (Oct 2025, inclusionAI/Ant) [abstract-only]
- Does not synthesize new worlds. It **augments existing envs** with "actionable" corrective feedback, adds a structured curriculum and fine-grained progress rewards, and learns from only 400 BFCL instances with better OOD generalization than SFT. Code: github.com/inclusionAI/AWorld-RL/tree/main/EnvTuning — [arXiv 2510.10197](https://arxiv.org/abs/2510.10197)

#### C. Data-pipeline generators: verified function-call data, not persistent worlds

**APIGen**, arXiv 2406.18518 (Jun 2024, Salesforce) [abstract-only]
- Uses 3,673 real executable APIs across 21 categories. Verification is **3-stage: format check, then real execution, then semantic check**. Released xlam-function-calling-60k, and the 7B model reaches SOTA on BFCL — [arXiv 2406.18518](https://arxiv.org/abs/2406.18518)

**APIGen-MT**, arXiv 2504.03601 (Apr 2025, Salesforce) [abstract-only]
- Phase 1 produces **task blueprints with ground-truth actions**, using an LLM reviewer committee and iterative feedback. Phase 2 runs simulated human–agent interplay to get full trajectories. Trains the xLAM-2-fc-r models (1B–70B), which beat GPT-4o and Claude 3.5 on τ-bench and BFCL. Open: APIGen-MT-5k dataset and the models — [arXiv 2504.03601](https://arxiv.org/abs/2504.03601)
- From memory, not verified: blueprints are executed against τ-bench environments for validation.

**ToolACE**, arXiv 2409.00920 (Sep 2024, Huawei/USTC) [abstract-only]
- Self-evolving synthesis of an API pool of **26,507 APIs**, multi-agent dialog generation, and dual-layer rule-based plus model-based verification. The 8B model rivals GPT-4 on BFCL. Model and a data subset at huggingface.co/Team-ACE — [arXiv 2409.00920](https://arxiv.org/abs/2409.00920)
- Follow-ups: ToolACE-R ([2504.01400](https://arxiv.org/abs/2504.01400)), ToolACE-DEV ([2505.07512](https://arxiv.org/abs/2505.07512)), ToolACE-MT ([2508.12685](https://arxiv.org/abs/2508.12685)). Titles only.

**Toucan**, arXiv 2510.01179 (Oct 2025) [abstract-only]
- 1.5M trajectories from **nearly 500 real MCP servers** with real tool execution. Queries come from 5 models with model-based filtering, and trajectories from 3 teacher models in 2 agent frameworks, followed by rule-based and model-based validation. Billed as the "largest publicly available tool-agentic dataset". Improves BFCL v3 and MCP-Universe results — [arXiv 2510.01179](https://arxiv.org/abs/2510.01179)
- This is a "real env, synthetic task" approach, not env synthesis.

**TaskCraft**, arXiv 2506.10055 (Jun 2025) [abstract-only]
- Expands atomic tasks by **depth-based and width-based extensions** into multi-tool, verifiable, difficulty-scalable tasks with trajectories. Output: about 36K tasks. It generates tasks over existing tools, not environments — [arXiv 2506.10055](https://arxiv.org/abs/2506.10055)

**SynthAgent**, arXiv 2511.06101 (Nov 2025) [abstract-only]
- For web agents on a fixed target site. It synthesizes tasks by categorized exploration of web elements, refines a task only when it conflicts with observations, then refines the trajectory with global context. Code: github.com/aiming-lab/SynthAgent — [arXiv 2511.06101](https://arxiv.org/abs/2511.06101)

#### D. Platforms

**ARE (Meta Agents Research Environments) + Gaia2**, arXiv 2509.17158 (Sep 2025); Gaia2 paper arXiv 2602.11964 (Feb 2026) [abstract-only]
- ARE is a platform with abstractions for building envs, "each with their own rules, tools, content, and verifiers". It runs **asynchronously**, so the env evolves independently of the agent — [arXiv 2509.17158](https://arxiv.org/abs/2509.17158)
- Gaia2 pairs each scenario with a **write-action verifier** for action-level evaluation that can serve as an RLVR signal. GPT-5 (high) reaches 42% pass@1 and Kimi-K2 21% (best open model) — [arXiv 2602.11964](https://arxiv.org/abs/2602.11964)
- ARE is mostly hand-authored apps plus a platform, not LLM-driven world generation.

#### E. Frontier-model tech reports: sections on environment synthesis

**DeepSeek-V3.2**, arXiv 2512.02556 (Dec 2025)
- An "environment-synthesis agent" with bash and search tools: (1) **builds a sandbox DB** from generated or Internet-retrieved data, (2) **writes task-specific tools as functions**, (3) proposes a task plus a Python solution function plus a verification function, where "the solution function is restricted to invoking tool functions ... cannot ... directly access the database", and (4) raises difficulty step by step. If the solution fails the verifier, it edits the solution or verifier until they agree — [arXiv 2512.02556](https://arxiv.org/html/2512.02556)
- It keeps only tasks with non-zero pass@100 under DeepSeek-V3.2 RL. Scale: **1,827 environments, about 85K prompts** in total, including 4,417 general-agent tasks on synthesized envs. RL on synthetic general-agent data alone improves Tau2Bench, MCP-Mark and MCP-Universe, while "restricting RL to code and search scenarios does not" — [arXiv 2512.02556](https://arxiv.org/html/2512.02556)

**Kimi K2**, arXiv 2507.20534 (Jul 2025)
- Uses 3,000+ real MCP tools from GitHub plus **20,000+ synthetic tools** from hierarchical domain evolution. It builds thousands of agents (system prompt plus tool combinations) and gives them tasks with rubrics — [arXiv 2507.20534](https://arxiv.org/html/2507.20534)
- The **tool simulator is an LLM world model** that "maintains and updates state after each tool execution" with "controlled stochasticity". An LLM user simulator drives the dialog, and an LLM judge does rejection sampling against the rubrics. Real execution sandboxes are used for coding — [arXiv 2507.20534](https://arxiv.org/html/2507.20534)

**GLM-4.5**, arXiv 2508.06471 (Aug 2025)
- LLMs "automatically construct and simulate a batch of tools" alongside real APIs and MCP servers, with an LLM user simulator and multiple judge agents (only successful trajectories are kept). Multi-turn function-calling RL uses "complex tasks automatically synthesized based on MCP servers" plus runnable open-source envs such as AgentGym — [arXiv 2508.06471](https://arxiv.org/html/2508.06471)

**MiniMax-M2 series**, arXiv 2605.26494 (May 2026)
- Agent-synthesized multi-language Docker environments built with an execution-feedback repair loop.
- Terminal-Gym, built from Stack Overflow: "an agent generates a Dockerfile and a corresponding test script ... If the test fails, structured diagnostic feedback is returned ... for iterative repair".
- AppDev uses "Agent-as-a-Verifier" with Playwright.
- Difficulty filter: tasks with lower zero-shot pass rates are preferred.
- The emphasis is real execution over LLM simulation; env counts are not given — [arXiv 2605.26494](https://arxiv.org/html/2605.26494)

#### F. LLM-as-environment / world-model simulators

**Simia (Simia-SFT / Simia-RL)**, arXiv 2511.01824 (Nov 2025, Microsoft et al.)
- An LLM (GPT-5 or o4-mini) **simulates tool outputs and rewards** using only tool specs, policies and seed trajectories. No env code is written — [arXiv 2511.01824](https://arxiv.org/html/2511.01824)
- Scale: 90K trajectories from the APIGen-MT seed, plus 15K from AgentTuning and 30K from OfficeBench — [arXiv 2511.01824](https://arxiv.org/html/2511.01824)
- Results: Qwen2.5-32B reaches 56.0/61.7 on τ² Airline/Retail versus GPT-4o's 48.0/60.4. At equal size, simulated data is comparable to real-env data, and it does better when scaled. Risks listed: distributional bias, implausible transitions, and errors accumulating over long horizons — [arXiv 2511.01824](https://arxiv.org/html/2511.01824)

**DreamGym, "Scaling Agent Learning via Experience Synthesis"**, arXiv 2511.03773 (Nov 2025, Meta et al.) [abstract-only]
- A reasoning-based "experience model" synthesizes state transitions and rewards, grounded by a replay buffer seeded with real offline data. It adaptively generates new tasks. On WebArena it beats baselines by more than 30%. It matches GRPO/PPO using only synthetic interactions and serves as a sim-to-real warm start — [arXiv 2511.03773](https://arxiv.org/abs/2511.03773)

**GenEnv**, arXiv 2512.19682 (Dec 2025) [abstract-only]
- A **co-evolution game between an agent and a generative env simulator**, using an α-Curriculum Reward that targets the agent's "zone of proximal development". Up to +40.3% over 7B baselines across API-Bank, ALFWorld, BFCL, Bamboogle and TravelPlanner, and it beats Gemini-2.5-Pro offline augmentation with 3.3× less data — [arXiv 2512.19682](https://arxiv.org/abs/2512.19682)

**WebDreamer, "Is Your LLM Secretly a World Model of the Internet?"**, arXiv 2411.06559 (Nov 2024, OSU) [abstract-only]
- The LLM is both world model and value function for planning: it simulates the outcomes of candidate web actions. Dreamer-7B is comparable to GPT-4o as a world model, and the approach is 4–5× more efficient than tree search in VisualWebArena. This is test-time simulation, not a training env — [arXiv 2411.06559](https://arxiv.org/abs/2411.06559)

**SimuRA, now titled "General Agentic Planning Through Simulative Reasoning with World Models" (SiRA)**, arXiv 2507.23773 [abstract-only]
- The current arXiv version names the architecture **SiRA**, not SimuRA. It uses an LLM world model with natural-language belief states and reports up to 124% higher completion than a reactive baseline. Like WebDreamer, it is planning-time simulation — [arXiv 2507.23773](https://arxiv.org/abs/2507.23773)

#### G. Surveys worth citing
- "Environment Scaling for Interactive Agentic Experience Collection: A Survey", arXiv 2511.09586 — [arXiv](https://arxiv.org/abs/2511.09586)
- "The Landscape of Agentic RL for LLMs: A Survey", arXiv 2509.02547 — [arXiv](https://arxiv.org/abs/2509.02547)
- "Beyond Simply Environment Scaling: Designing Effective Environment Distributions for Multimodal Agent Learning", arXiv 2608.03571 (title only) — [arXiv](https://arxiv.org/abs/2608.03571)

### Inferences
- The modal 2026 recipe has converged: **seed (domain name, skill, task corpus or API pool) -> scenario -> tasks -> DB schema and seed data -> tool code (often MCP) -> verifier code or judge -> execution self-repair -> solvability and difficulty filter -> RL**. AWM, EnvScaler, AgentScaler and DeepSeek-V3.2 all instantiate it, so WorldGen would be productizing a design the research community already agrees on.
- Two orderings exist: **tasks-first** (AWM and DeepSeek infer the DB and tools from tasks, so tasks are solvable by construction) and **env-first** (EnvScaler and AgentScaler build the env, then generate tasks). AWM's audit (11.5% blocked tasks versus EnvScaler's 46.8%) suggests that deriving the schema from tasks reduces unsolvable tasks. It is a single paper's comparison on its own judge, so it needs replication.
- Bugs are the norm, not the exception: 74% of AWM envs have at least one bug, yet RL still improves results. The useful bar seems to be "low env-error rate during rollouts" (about 4% in AWM) rather than "bug-free".
- Most papers cite gains on BFCL, τ²-Bench, ACEBench and MCP-Universe, and the cross-paper numbers conflict. EnvScaler beats AWM on τ² while AWM beats EnvScaler on BFCL and MCP-Universe in AWM's own runs. Treat leaderboard comparisons across papers as weak evidence.
- Open-source releases that WorldGen could study or benchmark against: AWM (Snowflake-Labs), EnvScaler (RUC-NLPIR), AutoEnv, Environment Tuning (inclusionAI), SynthAgent, APIGen/APIGen-MT datasets, ToolACE data, Toucan, ARE/Gaia2, and the SETA and VERA corpora (their abstracts say they are released).

### Gaps
- Kimi K2's synthetic-tool pipeline was not checked against any public code release, and is presumed closed.
- **Qwen synthetic tool-env pipelines:** the Qwen3 Technical Report (arXiv 2505.09388) was found but not read, so I cannot confirm any env-synthesis section in it. The Qwen-adjacent evidence is AgentScaler (Alibaba Tongyi) and the Qwen3-trained EnvScaler, AWM, CompoWorld and WorkForge. Qwen3.5/3.6 tech reports were not checked.
- Not verified: AgentGen's exact env format, APIGen-MT's execution of blueprints against τ-bench, open-source status of TaskCraft, AgentScaler, AutoForge and ClawEnvKit, and EnvGen's GitHub repo.
- The SimuRA/SiRA rename is inferred from the current arXiv title. The original v1 title was not retrieved.
- Not found as titled: a paper literally called "Scaling environments for agents". The closest titles are "Towards General Agentic Intelligence via Environment Scaling" (AgentScaler), "SETA: Scaling Environments for Terminal Agents", and "ARE: Scaling Up Agent Environments and Evaluations".
- Many 2026 papers (CompoWorld, ClawEnvKit, Skill2Env, SkillGym, WorkForge, VERA, SETA, InfiniteWeb, AutoForge) were read at abstract level only. Their repair-loop details, pass rates and costs are not captured.

---

## Q2. Code-generated (executable) vs LLM-simulated environments: fidelity, determinism, cost trade-offs

### Takeaway
Executable code worlds give deterministic, consistent state and cheap rollouts, and they make programmatic rewards possible. In head-to-head RL they beat LLM-simulated envs (AWM: BFCLv3 65.94 versus 52.53 for the simulator). They cost a one-time synthesis spend, and most of them contain bugs. LLM simulation (Kimi K2, Simia, DreamGym, GenEnv) needs no engineering and adapts tasks and curricula easily. It pays per-step inference cost, though, and risks hallucinated or inconsistent transitions. Hybrids are emerging: CompoWorld uses code services plus a world-model fallback, and DreamGym grounds its simulator with real-data replay.

### Cited Findings
- Code-first rationale: AWM says its envs are "code-driven and backed by databases, providing more reliable and consistent state transitions than environments simulated by LLMs" and "more efficient agent interaction" — [arXiv 2602.10090](https://arxiv.org/abs/2602.10090)
- EnvScaler names the three options: real systems are restricted, "LLM-simulated environments are prone to hallucinations and inconsistencies", and manual sandboxes do not scale. It claims consistency, controllability, stability and explainability for programmatic envs — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- Head-to-head on Qwen3-8B with GRPO: AWM scored BFCLv3 65.94 and MCP-Universe 11.17, against 52.53 and 6.15 for an LLM-simulator env. On τ²-Bench the simulator was competitive at 31.30 versus AWM's 33.45 — [arXiv 2602.10090](https://arxiv.org/html/2602.10090)
- Cost and throughput: AWM's synthesis costs about $0.57 per env with GPT-5, one time, and supports 1,024 parallel env instances per RL step. A simulator pays an LLM call at every step — [arXiv 2602.10090](https://arxiv.org/html/2602.10090). EnvScaler costs about $1.02 per env — [arXiv 2601.05808](https://arxiv.org/html/2601.05808). AutoEnv costs about $4.12 per env — [arXiv 2511.19304](https://arxiv.org/html/2511.19304)
- Simulation advocates: Simia says LLMs "can simulate realistic environment feedback without access to actual testbed data or APIs". At equal size, simulated trajectories perform like real-env ones, and they do better when scaled because of diversity. A case study suggests the simulator sometimes gives *richer* feedback than real implementations. Acknowledged risks are distribution bias, implausible transitions, and multi-turn error accumulation — [arXiv 2511.01824](https://arxiv.org/html/2511.01824)
- Kimi K2's simulator is an explicitly stateful LLM world model with "controlled stochasticity", used at scale for SFT data across 20K+ synthetic tools — [arXiv 2507.20534](https://arxiv.org/html/2507.20534)
- DreamGym distills dynamics into a reasoning-based experience model and uses a replay buffer of real offline data for stability. It matches GRPO/PPO with only synthetic interactions and helps sim-to-real transfer — [arXiv 2511.03773](https://arxiv.org/abs/2511.03773)
- GenEnv's simulator doubles as an adaptive curriculum generator (α-Curriculum Reward), which is easy to do in simulation and hard to do in code — [arXiv 2512.19682](https://arxiv.org/abs/2512.19682)
- Hybrid: CompoWorld implements most tools as verified typed-state services and falls back to "a world model [for] tools that cannot be reliably implemented" — [arXiv 2609.33665](https://arxiv.org/abs/2609.33665)
- Production labs lean on real execution where it is available. MiniMax-M2 uses real Docker, Playwright and spreadsheets — [arXiv 2605.26494](https://arxiv.org/html/2605.26494). DeepSeek-V3.2 uses code-synthesized DBs and tools with Python verifiers — [arXiv 2512.02556](https://arxiv.org/html/2512.02556). Kimi K2 and GLM-4.5 used LLM-simulated tools mainly for SFT trajectory generation — [Kimi K2](https://arxiv.org/html/2507.20534); [GLM-4.5](https://arxiv.org/html/2508.06471)
- Planning-time world models (WebDreamer, SiRA) use LLM simulation at inference to evaluate candidate actions, not as a training env — [arXiv 2411.06559](https://arxiv.org/abs/2411.06559); [arXiv 2507.23773](https://arxiv.org/abs/2507.23773)

### Inferences
- Rough pattern: **simulation for SFT data and breadth, code for RL**. RL rewards need deterministic, inspectable state, and policies exploit simulator inconsistencies. This pattern is my synthesis across Kimi K2, GLM-4.5, DeepSeek-V3.2 and AWM, not a claim any single paper makes.
- For a WorldGen product, executable worlds are the defensible core: they are reproducible, resettable and gradeable by DB diff. LLM simulation is a useful fallback for long-tail tools (the CompoWorld pattern) and for a user simulator.
- Determinism caveat: even code worlds often use LLM judges for grading (AWM's code-augmented judge has a 9.2% reward flip rate), so end-to-end determinism is still not fully achieved.

### Gaps
- No paper found gave a clean per-rollout dollar cost comparison of simulated versus executable envs. Only synthesis cost and qualitative efficiency claims were available.
- No systematic study was found of reward hacking specific to simulated envs. Related: "Hack-Verifiable Environments" (arXiv 2605.20744) measures reward hacking in TextArena, but not in simulators versus code — [arXiv 2605.20744](https://arxiv.org/abs/2605.20744)

---

## Q3. How generated environments are verified

### Takeaway
There are five recurring layers. (1) Static and execution checks with an LLM self-repair loop (bounded retries: 5 in AWM, 40 in AutoEnv). (2) Behavioral env testing, with random or targeted tool calls checked against the code (EnvScaler's dual agent, 0.85 threshold). (3) Task–verifier consistency, where a reference solution must pass the verifier (DeepSeek-V3.2, SkillGym, ClawEnvKit's validator). (4) Solvability and difficulty filtering by a reference agent (DeepSeek: non-zero pass@100; MiniMax: prefer low zero-shot pass; Skill2Env's hardening; AutoEnv's strong-beats-weak differential test). (5) Reward design that mixes programmatic state checks with LLM judgment (AWM, Gaia2 write-action verifiers, EnvScaler partial-credit checks).

### Cited Findings
- **Execution plus self-repair:** AWM tests each component in isolation and feeds errors back for up to 5 iterations, at about 87–88% first-pass success — [arXiv 2602.10090](https://arxiv.org/html/2602.10090). AutoEnv allows up to 40 repair iterations, then checks execution (90%), level generation (96.7%) and reliability (74.7%), for 65% end-to-end — [arXiv 2511.19304](https://arxiv.org/html/2511.19304). MiniMax Terminal-Gym regenerates the Dockerfile and test from structured diagnostics until the test passes or retries run out — [arXiv 2605.26494](https://arxiv.org/html/2605.26494)
- **Behavioral env QA:** EnvScaler runs 100 rounds per env of testing-agent calls with a checking agent that reads code and state, discards envs under a 0.85 pass rate, and removed 28% of envs — [arXiv 2601.05808](https://arxiv.org/html/2601.05808)
- **Task–verifier consistency:** DeepSeek-V3.2 requires the solution function to pass the verification function, and the solution may only call tools, not the DB. Otherwise the agent edits the solution or verifier — [arXiv 2512.02556](https://arxiv.org/html/2512.02556). SkillGym requires a reference solution plus an executable verifier for every task — [arXiv 2609.37539](https://arxiv.org/abs/2609.37539). ClawEnvKit's validator checks feasibility and internal consistency — [arXiv 2604.18543](https://arxiv.org/abs/2604.18543). WorkForge derives the verifiers from extracted "factual anchors" — [arXiv 2610.04906](https://arxiv.org/abs/2610.04906)
- **Solvability and difficulty by reference agent:** DeepSeek-V3.2 keeps only tasks with non-zero pass@100 — [arXiv 2512.02556](https://arxiv.org/html/2512.02556). MiniMax prefers variants with fewer hints and lower zero-shot pass rates — [arXiv 2605.26494](https://arxiv.org/html/2605.26494). AutoEnv rejects envs where the weaker model reliably beats the stronger one — [arXiv 2511.19304](https://arxiv.org/html/2511.19304). Skill2Env's Iterative Task Hardening uses solver evidence — [arXiv 2609.33772](https://arxiv.org/abs/2609.33772). AWM stratifies difficulty by required tool-call count and finds 69% of very-hard tasks unsolved by frontier models — [arXiv 2602.10090](https://arxiv.org/html/2602.10090). AgentGen's Bi-Evol evolves tasks toward easier and harder — [arXiv 2408.00764](https://arxiv.org/abs/2408.00764)
- **Trajectory-level filters (data pipelines):** APIGen uses format, then execution, then semantic checks — [arXiv 2406.18518](https://arxiv.org/abs/2406.18518). ToolACE uses rule plus model dual-layer checks — [arXiv 2409.00920](https://arxiv.org/abs/2409.00920). APIGen-MT uses an LLM reviewer committee with feedback loops on blueprints — [arXiv 2504.03601](https://arxiv.org/abs/2504.03601). AgentScaler requires final-DB-state alignment and an exact tool-sequence match — [arXiv 2509.13311](https://arxiv.org/html/2509.13311). Kimi K2 and GLM-4.5 use LLM-judge rejection sampling against rubrics — [Kimi K2](https://arxiv.org/html/2507.20534); [GLM-4.5](https://arxiv.org/html/2508.06471). Toucan uses rule-based plus model-based validation — [arXiv 2510.01179](https://arxiv.org/abs/2510.01179)
- **Reward and grader design:** AWM found a code-augmented LLM judge beats both code-only and LLM-only rewards (BFCLv3 65.94 versus 60.00 versus 55.46). Its reasoning is that "pure code-based verification is brittle" — [arXiv 2602.10090](https://arxiv.org/html/2602.10090). EnvScaler gives partial credit as the fraction of state checks passed — [arXiv 2601.05808](https://arxiv.org/html/2601.05808). Gaia2 uses write-action verifiers for action-level RLVR — [arXiv 2602.11964](https://arxiv.org/abs/2602.11964). VERA uses agent-written rubrics and executable checks plus a judge that gates each sandbox — [arXiv 2610.05923](https://arxiv.org/abs/2610.05923)
- **Quality metrics reported:** AWM reports human/LLM-rated feasibility, data alignment and toolset completeness, bugs per env, % blocked tasks, embedding diversity and AST duplicate rate (0.0%) — [arXiv 2602.10090](https://arxiv.org/html/2602.10090). ClawEnvKit compares coherence and clarity against human-curated envs — [arXiv 2604.18543](https://arxiv.org/abs/2604.18543). AutoEnv reports per-stage pass rates — [arXiv 2511.19304](https://arxiv.org/html/2511.19304)

### Inferences
- A WorldGen validation stack following the literature would be:
  1. Schema and tool compile and run with bounded self-repair.
  2. A fuzz/behavioral test agent against the tools.
  3. Seed data that satisfies task preconditions.
  4. A reference solution that may use only the public tools and must pass the grader.
  5. Reference-agent pass@k used for solvability (k > 0) and difficulty banding (drop trivially easy tasks).
  6. A differential check that stronger agents score higher.
  7. A sampled LLM/human audit for feasibility, blocked tasks and bugs.
- Failure modes to design against:
  - Unhandled edge cases and DB-constraint conflicts (the AWM bug taxonomy).
  - Blocked or unsolvable tasks (up to 47% in EnvScaler's sample, by AWM's audit).
  - Abstract or contradictory NL specs (AutoEnv's human review raised success from 60% to 80%).
  - Judge noise (AWM's 9.2% flip rate).
  - Diminishing returns beyond a modest number of envs for some benchmarks (EnvScaler: most gains within about 20 envs). AWM instead reports continued gains up to 526, so diversity at scale seems to matter more for OOD.
  - Rewards hackable through verifiers that read DB state directly. DeepSeek's "solution can't access the DB" rule addresses this.

### Gaps
- Verification pass rates and repair-loop statistics for most 2026 papers (CompoWorld, ClawEnvKit, InfiniteWeb, SETA, SkillGym, WorkForge, VERA, AutoForge) were not extracted because only abstracts were read.
- No paper found measured how many "verified" synthetic envs were later found faulty during RL, beyond AWM's roughly 4% env-error rate during rollouts.
