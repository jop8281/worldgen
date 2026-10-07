# LLM Code-Generation of Executable Worlds + Generate→Execute→Error-Feedback→Repair Loops

Scope: design patterns for a "WorldGen" agent that writes a world (schema, API, business logic, seed data, tasks, graders) and iterates against an engine's validation errors ("↓ world ↑ errors") until it passes. As of Oct 2026.

Sourcing note: items marked [fetched] were verified via search/fetch this session. Items marked [prior] come from well-known papers whose arXiv links are given, but whose numbers were not re-fetched this session; the report writer should treat those numbers as "as reported in the paper, recalled" and verify before quoting them as headlines.

---

## Q1. Code-generated environments / world models: what exists and what patterns do they use?

### Takeaway
The closest prior art to WorldGen is **Agent World Model (AWM, Feb 2026)**: a staged pipeline (scenario → tasks → SQLite schema → seed data → tool-interface spec → MCP tool code → verification code). Each stage runs execute-and-repair with at most 5 retries, about 1.1 iterations on average, and 86–88% per-stage success. Across Text2World, GIF-MCTS, Eureka, GenSim, OMNI-EPIC, Voyager and WorldCoder the same idea recurs: the LLM writes **code or a DSL that a deterministic engine can execute and check**, and the check results go back to the LLM. This is separate from neural "world models" such as Genie, and from the 3D-scene projects that also carry the name "WorldGen".

### Cited Findings

**Tool-use / business-app world synthesis (most directly relevant)**
- AWM (UNC Chapel Hill + Snowflake) is an "open-source pipeline that synthesizes executable tool-use environments at scale… analogous to learned world models in model-based RL but realized via code-driven environments rather than neural dynamics" [fetched] — [AWM arXiv 2602.10090](https://arxiv.org/html/2602.10090v3)
- AWM stages, in order [fetched] — [AWM](https://arxiv.org/html/2602.10090v3):
  1. Scenarios: 100 seed domains lead to 1,000 scenarios. Filters are an LLM classifier (must involve core CRUD operations), embedding dedup and category balancing.
  2. Tasks: 10 per environment, 10,000 in total. They must be API-solvable (no UI clicks) and assume the user is already logged in.
  3. DB schema (SQLite): the model infers the entities, attributes and relations "to make every task feasible". Tables are created only when a task needs them, and auth fields are excluded. First-attempt success is 88.3%.
  4. Sample/seed data: the model analyzes each task's preconditions and inserts the records it needs. 88.2% success, 1.12 average iterations.
  5. Toolset/interface schema: the minimal set of operations, with typed params and response schemas. Mean 35.1 tools per environment.
  6. Environment code: Python MCP tools that implement state transitions on the DB. 86.8% success, mean about 1,985 LOC.
  7. Verification code: per-task checks that diff DB state before and after the agent runs.
- Notably, AWM generates **tasks before the schema**. Tasks drive which tables are needed, which avoids schema bloat and guarantees feasibility [fetched] — [AWM](https://arxiv.org/html/2602.10090v3)
- AWM self-correction: "up to 5 iterations per component"; "runtime exceptions are captured and fed back to the LLM with problematic code snippets"; average 1.13 iterations to repair; each stage may drop up to 10% failures to control cost [fetched] — [AWM](https://arxiv.org/html/2602.10090v3)
- AWM residual bug taxonomy: 44% unhandled edge cases (missing null/boundary validation) and 14% DB constraint conflicts (foreign key, uniqueness). The environment error rate during RL is about 4%. The stated limitation is that "self-correction primarily addresses runtime errors, not logical inconsistencies" [fetched] — [AWM](https://arxiv.org/html/2602.10090v3)
- AWM grading uses a **code-augmented LLM-as-judge**: a structured DB state diff plus LLM reasoning, with outcome labels {Completed, Partially Completed, Agent Error, Environment Error}. It beat both code-only and LLM-only verification. With GPT-5.1 as judge, Fleiss κ = 0.891 [fetched] — [AWM](https://arxiv.org/html/2602.10090v3)
- AWM payoff: Qwen3-8B trained with RL only on AWM environments went from 53.83 to 65.94 overall on BFCLv3, τ²-bench and MCP-Universe. An LLM-"simulator" environment baseline scored 52.53. Performance scaled monotonically with the number of environments (10 → 100 → 526) [fetched] — [AWM](https://arxiv.org/html/2602.10090v3)
- EnvScaler (Renmin Univ.) has two stages. SkelBuilder builds environment skeletons through "topic mining, logic modeling, and quality evaluation". ScenGenerator produces task scenarios plus **rule-based trajectory validation functions**. Output is 191 environments and about 7,000 scenarios, used for SFT and RL of Qwen3 [fetched] — [EnvScaler arXiv 2601.05808](https://arxiv.org/abs/2601.05808)
- Other 2026 environment-synthesis frameworks turned up in search but were not read in detail: EnvFactory ("explores and verifies stateful, executable tool environments") — [arXiv 2605.18703](https://arxiv.org/html/2605.18703v1); Agent-World — [arXiv 2604.18292](https://arxiv.org/html/2604.18292v1); EnvCraft — [arXiv 2609.05576](https://arxiv.org/pdf/2609.05576)

**Symbolic / planning worlds**
- Text2World is a benchmark of hundreds of PDDL domains generated from text. It scores executability (does a PDDL validator parse and accept it), structural similarity, and component F1 over predicates, parameters, preconditions and effects. Even the best reasoning models show "limited capabilities in world modeling" [fetched] — [Text2World arXiv 2502.13092](https://arxiv.org/abs/2502.13092)
- Text2World error correction: DeepSeek-R1 executability rose from 72.3% (EC0) to 89.1% after 3 validator-feedback correction rounds (EC3), +16.8 pp (F=27.48, p=0.00012). **Syntax errors drop with correction rounds, but semantic errors persist.** The semantic classes are DisobeyDescription, IncompleteModeling, RedundantSpecifications and SurfaceDivergence, and most failures were "inability to include essential preconditions or effects" [fetched] — [Text2World](https://arxiv.org/html/2502.13092v1)
- Guan et al. (2023): GPT-4 builds PDDL domain models and corrects them using natural-language feedback from PDDL validators and humans, then uses them with classical planners [prior] — [arXiv 2305.14909](https://arxiv.org/abs/2305.14909)

**Code world models for RL / planning**
- GIF-MCTS (Dainese et al., NeurIPS 2024) generates Python "Code World Models". Its MCTS has three action types: **Generate, Improve, Fix**. Fix uses runtime errors, and Improve uses unit-test and trajectory mismatches. The task "requires… [the ability] to self-debug a long program with feedback from unit tests and environment trajectories". The CWMB benchmark has 18 RL environments with text descriptions and curated trajectories. GIF-MCTS beats the baselines, and the resulting models make planning far more sample-efficient and faster [fetched] — [arXiv 2405.15383](https://arxiv.org/abs/2405.15383); [project](https://sites.google.com/view/code-world-models)
- Name disambiguation: Meta FAIR's "CWM: Code World Model" (Sept 2025) is a 32B open-weights LLM mid-trained on Python execution traces and agentic Docker trajectories. It is not a world generator [prior] — [arXiv 2510.02387](https://arxiv.org/abs/2510.02387)
- WorldCoder (Tang, Key, Ellis) has an agent write a Python world model (transition and reward) from interactions, refines it through program synthesis against observed transitions, and uses an "optimism under uncertainty" objective to drive exploration. It is reported to be more sample-efficient than deep RL and cheaper in compute than ReAct-style agents [prior] — [arXiv 2402.12275](https://arxiv.org/abs/2402.12275)
- AutoManual has Planner, Builder and Formulator agents that build a rule "manual" from interaction. The Builder updates rules with case-conditioned prompting, and the Formulator compiles the manual into Markdown. Reported 97.4% on ALFWorld with GPT-4-turbo [prior] — [arXiv 2405.16247](https://arxiv.org/abs/2405.16247)

**Reward / task / environment code for embodied agents**
- Eureka (NVIDIA) has an LLM write reward-function code from the environment source code used as context. Its **"reward reflection"** feeds back per-component training statistics, which is a textual summary of policy training. Reported to beat expert-human rewards on 83% of 29 tasks [prior] — [arXiv 2310.12931](https://arxiv.org/abs/2310.12931)
- GenSim has an LLM generate new robot simulation tasks as code (goal-directed or exploratory) and accumulates a task library. Generated tasks are filtered by execution: syntax/runtime checks, then whether a scripted expert can solve the task [prior] — [arXiv 2310.01361](https://arxiv.org/abs/2310.01361). GenSim2 extends this to articulated, long-horizon tasks using multimodal/reasoning LLMs, with solver-based verification of generated tasks [prior] — [arXiv 2410.03645](https://arxiv.org/abs/2410.03645)
- OMNI-EPIC has an LLM write both **environment code and success-detection code** (reward/termination) for new tasks. A "model of interestingness" picks novel tasks, and an archive of tasks seeds new generations. Code that fails to compile or run goes back to the LLM to fix [prior] — [arXiv 2405.15568](https://arxiv.org/abs/2405.15568)
- Voyager (Minecraft) loops through an automatic curriculum, a skill library of executable JS functions, and iterative prompting. Its three feedback types are environment feedback, **execution errors**, and **self-verification** by a critic LLM. A skill enters the library only after verification [prior] — [arXiv 2305.16291](https://arxiv.org/abs/2305.16291)

**Game generation**
- gg-bench: an LLM writes natural-language descriptions of novel games, implements each as a **Gym environment in code**, and RL agents train via self-play to serve as opponents. GPT-4o and Claude 3.7 Sonnet win 7–9% of games; o1, o3-mini and R1 win 31–36% [fetched] — [arXiv 2505.07215](https://arxiv.org/abs/2505.07215)
- GameCraft-Bench (2026) has 140 Godot tasks across 15 game families, going from an NL spec to a playable game. Evaluation uses "replayed demonstrations and rubric-guided multimodal judging". The best agent scores 41.46%. Failures are incomplete content, missing visual feedback and incoherent presentation [fetched] — [arXiv 2606.17861](https://arxiv.org/abs/2606.17861)
- I found no paper literally titled "Code2Games". gg-bench and GameCraft-Bench are the closest verifiable sources.

**Genie-style neural worlds vs code worlds; name disambiguation**
- Genie (DeepMind) is a learned, action-controllable video world model trained from unlabeled video. Its state is implicit pixels/latents, with no symbolic schema to validate [prior] — [arXiv 2402.15391](https://arxiv.org/abs/2402.15391)
- Meta "WorldGen" (Reality Labs, Nov 2025) does text → traversable 3D scenes (up to about 50×50 m) with navmeshes, exportable to Unity/Unreal. It combines procedural reasoning, diffusion 3D generation and object decomposition. It has **nothing to do with business-logic worlds** [fetched] — [arXiv 2511.16825](https://arxiv.org/abs/2511.16825); [Meta blog](https://www.meta.com/blog/worldgen-3d-world-generation-reality-labs-generative-ai-research/)
- ZiYang-xie/WorldGen is a text- or image-to-3D-scene pipeline (FLUX.1-dev, depth estimation, Gaussian splatting or mesh output), with about 1.9k stars. It is also unrelated [fetched] — [GitHub](https://github.com/ZiYang-xie/WorldGen)
- LatticeWorld (2025) generates 3D worlds by pairing a lightweight LLM (LLaMA-2-7B) with Unreal Engine 5. It takes multimodal input and supports multi-agent interaction. It is a 3D/rendering world system, not a business-logic engine [fetched] — [arXiv 2509.05263](https://arxiv.org/abs/2509.05263)

### Inferences
- AWM's empirical numbers suggest that **per-stage generation with per-stage execution gates** keeps each step cheap: about 87–88% first-pass success, and about 1.1 repair rounds when a step fails. The leftover risk is semantic, not crash-level.
- Generating tasks first and deriving schema and seed data from task preconditions is a useful ordering for WorldGen. It makes every table and seed row traceable to a task and gives a natural feasibility check: can a reference solution solve each task against the seed data?
- Every successful system pairs the generated world with **generated or derived checkers**: success detectors in OMNI-EPIC, verification code in AWM, validation functions in EnvScaler, and expert-solvability in GenSim. WorldGen should emit graders with the world and validate the graders too, for example that a reference trajectory passes and a null trajectory fails.

### Gaps
- No public per-stage ablation compares staged against one-shot world generation on the same specs. AWM reports per-stage success rates only, not a one-shot baseline.
- EnvFactory, Agent-World and EnvCraft were only seen in search results. Their repair-loop details were not read.
- GenSim2, OMNI-EPIC and Eureka numbers come from memory and were not re-fetched.

---

## Q2. Self-repair evidence: which feedback signals work best?

### Takeaway
Self-repair works when the feedback is **grounded and specific**: validator or compiler errors, failing unit tests with actual-vs-expected output, runtime traces with intermediate values, or DB-state diffs. It works poorly when the model has to diagnose the bug from its own critique. Gains are front-loaded in the first 1–3 rounds. Syntax and crash errors are fixed reliably. Semantic or spec-violation errors are not fixed reliably, so they need explicit oracles such as tasks, reference solutions and invariants.

### Cited Findings
- "Is Self-Repair a Silver Bullet?" (Olausson et al., ICLR 2024): once the cost of repair is counted, gains are "often modest, vary between and within datasets, and rely on achieving sufficient diversity in the initial programs". Models are "held back by their inability to reliably produce accurate and useful feedback". Swapping in a stronger model's feedback helps a lot, and expert-human feedback raised the number of repaired GPT-4 programs 1.58× [fetched] — [arXiv 2306.09896](https://arxiv.org/abs/2306.09896)
- Text2World: validator-error feedback raised executability 72.3% → 89.1% over 3 rounds, but semantic errors such as missing preconditions and effects persisted [fetched] — [Text2World](https://arxiv.org/html/2502.13092v1)
- AWM: runtime-exception feedback plus the offending code snippet gives about 1.13 average repair iterations under a cap of 5. Logical inconsistencies are not addressed [fetched] — [AWM](https://arxiv.org/html/2602.10090v3)
- Self-Debugging (Chen et al.) teaches the model to debug with "rubber-duck" explanations of its own code plus execution results or unit-test feedback. The largest gains come when unit tests are available, and gains are smaller with explanation-only feedback [prior] — [arXiv 2304.05128](https://arxiv.org/abs/2304.05128)
- Reflexion stores verbal self-reflections on failed trials in episodic memory and uses self-generated tests for code. Reported HumanEval pass@1 of 91%. Later analyses note that false-positive self-generated tests are a risk [prior] — [arXiv 2303.11366](https://arxiv.org/abs/2303.11366)
- LDB (Large Language Model Debugger) splits a program into basic blocks and gives the LLM **intermediate variable values at runtime** for each block to verify against the task. It is reported to improve on Self-Debugging-style feedback by up to about 9.8% on HumanEval, MBPP and TransCoder [prior] — [arXiv 2402.16906](https://arxiv.org/abs/2402.16906)
- AlphaCodium uses a "flow", not a single prompt: problem self-reflection, then reasoning over public tests, then several candidate solutions, then **AI-generated additional tests**, then iterative fix against public tests followed by AI tests. Tests that already passed become "anchors" so fixes do not regress. It favors **YAML structured output** and modular code. Reported GPT-4 pass@5 on CodeContests of 19% → 44% [prior] — [arXiv 2401.08500](https://arxiv.org/abs/2401.08500)
- SWE-agent's Agent-Computer Interface includes an edit command with a **built-in linter that rejects syntactically invalid edits** and shows the error immediately, so bad states never land in the codebase. The interface design changed resolution rates substantially [prior] — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)
- OpenHands is an open platform for coding agents (sandboxed execution, CodeAct-style action space) where the agent iterates on code against real runtime output [prior] — [arXiv 2407.16741](https://arxiv.org/abs/2407.16741)
- MetaGPT encodes SOPs as roles (PM, then Architect, then Engineer, then QA) that exchange **structured artifacts** (PRD, system design, API spec). It reports that an executable-feedback loop, where the engineer runs and fixes code, improves results [prior] — [arXiv 2308.00352](https://arxiv.org/abs/2308.00352)
- ChatDev uses a waterfall "chat chain" (design, then coding, then testing) with paired agents and "communicative dehallucination", where the agent asks for specifics before answering [prior] — [arXiv 2307.07924](https://arxiv.org/abs/2307.07924)
- GPT-Engineer is an early open-source spec-to-codebase CLI that clarifies the spec, then generates the whole repo [prior] — [GitHub](https://github.com/AntonOsika/gpt-engineer)
- Full-app benchmarks:
  - DevBench covers the lifecycle: design, environment setup, implementation, acceptance tests and unit tests [prior] — [arXiv 2403.08604](https://arxiv.org/abs/2403.08604)
  - Web-Bench (ByteDance) has 50 full-stack projects, each with 20 sequentially dependent tasks [fetched] — [alphaXiv](https://www.alphaxiv.org/benchmarks/bytedance/web-bench)
  - WebGen-Bench measures multi-file websites built from scratch [fetched] — [arXiv 2505.03733](https://arxiv.org/abs/2505.03733)
  - WebCoderBench has 1,572 real user requirements and 24 metrics, with "no dominant model across all metrics" [fetched] — [ACL 2026](https://preview.aclanthology.org/ingest-acl/2026.acl-long.535/)
  - FullStack-Agent (Next.js/NestJS) combines coding, execution and **GUI-agent-based testing** [fetched] — [arXiv 2602.03798](https://arxiv.org/html/2602.03798)
  - "From Prompt to Product" is a human-centered comparison of Replit, Bolt and Firebase Studio [fetched] — [arXiv 2512.18080](https://arxiv.org/pdf/2512.18080v2)
- Game-generation evidence shows how much "it runs" overstates "it works": GameCraft-Bench's best agent reaches 41.46% under gameplay replay plus rubric judging [fetched] — [arXiv 2606.17861](https://arxiv.org/abs/2606.17861)

### Inferences: ranking of feedback signals for a WorldGen engine
From most to least reliable and actionable, synthesized from the sources above:
1. **Schema/parse/validator errors with exact paths**: pydantic/JSON-Schema locations, SQL constraint names, PDDL validator codes. These are cheap and deterministic and nearly always fixed within 1–3 rounds (Text2World, AWM).
2. **Referential-integrity and constraint violations** on seed data (FK, uniqueness, enums). AWM's second-largest bug class (14%), and machine-checkable.
3. **Runtime exceptions with stack trace plus the offending snippet** (AWM, GIF-MCTS "Fix").
4. **Failing task oracles**, meaning a reference or scripted solution cannot complete task X against the seed data, together with a **state diff** (expected vs actual). This is the only signal that reliably catches semantic errors such as missing preconditions or effects (Text2World, AWM verification, GenSim expert-solvability).
5. **Intermediate-value traces** (LDB style) for logic bugs in business rules.
6. **LLM-critic / self-generated feedback**: the weakest on its own (Olausson). Use it only to explain or localize a grounded failure, not as the pass/fail signal.
- Design implications:
  - Cap retries at about 3–5 per stage. AWM uses 5, with mean about 1.1.
  - Keep "anchor" checks that previously passed so fixes do not regress (AlphaCodium).
  - Reject invalid writes at the interface rather than after the fact (SWE-agent linter).
  - Sample several initial candidates, because repair depends on initial diversity (Olausson; GIF-MCTS's tree search over Generate/Improve/Fix is the principled version).
  - Return errors as structured, minimal and localized messages (stage, file/path, error code, expected vs actual), not raw logs.

### Gaps
- No found study directly compares error *formats* (structured JSON error objects vs raw stack traces) for repair efficiency in world or app generation.
- No head-to-head comparison of "static type errors vs schema validation vs runtime traces vs task oracles" on the same world-generation task. The ranking above is synthesized.

---

## Q3. Staged generation and intermediate representations (YAML/JSON DSLs, Pydantic)

### Takeaway
The evidence favors **staged generation with a typed intermediate representation (IR) at each boundary**. AWM's chain is scenario → tasks → schema → seed → interface spec → code → verifier. MetaGPT's chain is PRD → design → API → code. AlphaCodium uses YAML-structured reasoning steps. Declarative world engines (WorldSeed's YAML plus rule DSL, with Pydantic/Instructor-validated LLM outputs) show that a validator-friendly IR lets the engine own correctness while the LLM fills in content.

### Cited Findings
- AWM writes an explicit **interface/toolset schema** (typed params, response schemas) *before* code generation, and code is generated against that spec [fetched] — [AWM](https://arxiv.org/html/2602.10090v3)
- MetaGPT's structured intermediate documents (PRD, design, API interface) reduce cascading hallucination compared with free-form chat between agents [prior] — [arXiv 2308.00352](https://arxiv.org/abs/2308.00352)
- AlphaCodium recommends YAML structured outputs and "soft decisions" for each flow stage [prior] — [arXiv 2401.08500](https://arxiv.org/abs/2401.08500)
- Text2World's metrics are a model for **layered validation of an IR**: parse/validate, then structural similarity, then component-level F1 (predicates, params, preconditions, effects) [fetched] — [Text2World](https://arxiv.org/html/2502.13092v1)
- WorldSeed (AIScientists-Dev, MIT, about 0.9k stars) defines worlds "entirely in YAML (entities, rules, physics, per-character perception)" with "zero hardcoded domain knowledge" [fetched] — [GitHub](https://github.com/AIScientists-Dev/WorldSeed); [summary](https://pyshine.com/WorldSeed-Emergent-Multi-Agent-World-Engine/). How it works:
  - It runs a tick loop: agents perceive asymmetric slices of the world, then propose actions, then the engine resolves them.
  - Rules use a DSL. Preconditions are DSL expressions and effects run deterministically through a dispatcher. `$param` references go through a PathResolver.
  - Uncertain actions go to an **LLM "Dungeon Master"**, called through LiteLLM + Instructor (Pydantic-structured outputs). The DM "judges physical outcomes ONLY", and each call is stateless, with persistent information kept in entity state.
  - Config is validated at scene load.
  - No NL→world generator is documented.

  [fetched] — [ARCHITECTURE.md](https://raw.githubusercontent.com/AIScientists-Dev/WorldSeed/main/docs/ARCHITECTURE.md)
- Argus Labs World Engine / Cardinal: Cardinal is a "game shard" framework built on an **Entity Component System (ECS)**, and the World Engine is a sharded L2 with a loop-driven (tick) runtime for on-chain games. It is relevant as an example of a deterministic tick engine with typed components and systems, not as an LLM generator [fetched] — [world.dev Cardinal](https://world.dev/cardinal/introduction); [GitHub](https://github.com/argus-Labs/world-engine)
- "worldsim": I found no reliable primary source for a project by that name that is a multi-agent YAML world engine. Search returned WorldSeed and code-based simulators such as ChronoAgentic ([arXiv 2605.14398](https://arxiv.org/pdf/2605.14398)) instead.
- "Lattice World Engine": the only match found was LatticeWorld (LLM + UE5 3D worlds, [arXiv 2509.05263](https://arxiv.org/abs/2509.05263)). "Cardinal" most plausibly refers to Argus's Cardinal, above. The pairing in the brief could not be confirmed as a single product.

### Inferences: recommended WorldGen stage plan
- **Stage 0, spec normalize**: NL spec → a structured spec (entities, actors, flows, invariants). Gate: schema-valid, and every flow references known entities.
- **Stage 1, tasks first** (AWM ordering): NL tasks plus structured preconditions and expected effects. Gate: schema-valid.
- **Stage 2, data schema** (Pydantic/SQL DDL): Gate: DDL compiles; every task precondition maps to fields; no orphan tables.
- **Stage 3, API/interface spec** (typed OpenAPI/MCP tool schema): Gate: every task is reachable through the declared operations; types resolve against the schema.
- **Stage 4, business logic code**: Gate: type check, lint (SWE-agent-style rejection on write), unit tests for invariants.
- **Stage 5, seed data**: Gate: FK, uniqueness and enum constraints pass; preconditions for every task are satisfied.
- **Stage 6, graders/verifiers**: Gate: a reference trajectory passes, a no-op trajectory fails, and an invalid trajectory fails (graders validated against the world).
- **Stage 7, end-to-end oracle**: a scripted or LLM solver runs every task. Failures are routed back to the earliest implicated stage, using a DB state diff plus trace.
- Keep the IR declarative wherever possible (YAML/JSON plus a small expression DSL, as in WorldSeed), so the engine, not generated code, enforces semantics. Generate imperative code only where the DSL cannot express the logic.
- Separate deterministic resolution from LLM adjudication, as WorldSeed separates its rule engine from the DM. Graders should be code-first with an LLM judge as a supplement, as AWM's hybrid judge does.

### Gaps
- No controlled study was found comparing YAML DSL vs Python code as the generation target for the same worlds.
- WorldSeed's SCENE_CONFIG.md and SCENE_DSL.md (full schema and DSL syntax) were not fetched, so the exact validation error format is unknown.
- Whether any 2026 system feeds **engine validation errors** back to an NL→YAML world generator (the exact WorldGen loop) is unconfirmed. AWM and Text2World are the nearest analogues.
