# Open-source RL/eval environment frameworks and environment hubs: interface designs for "worlds"

Research date: 2026-10-06. Sources are mostly primary (GitHub READMEs and source, official docs). Several projects changed a lot in 2026 (verifiers v1, the Harbor Hub and multi-step tasks, the HUD protocol rewrite, OpenEnv's move to the huggingface org), so the notes describe the current `main`/docs, not the 2025 launch versions.

## Q1. What interface does each framework define (reset/step/state/reward, tool exposure, sandboxing, packaging)?

### Takeaway
The field has split into two interface styles. **Gym-style step loops** (OpenEnv, GEM, SkyRL-Gym, rLLM, TextArena, AgentGym) have the trainer call `reset/step` and get back `(obs, reward, done)`. **Task + harness + verifier** systems (Harbor, verifiers v1, HUD, NeMo Gym, Inspect, OpenReward/ORS) let an agent harness work freely inside a sandbox or tool server, then a separate grader returns a reward. Agentic and terminal tasks are moving clearly toward the second style. MCP has become the default way to expose tools, and Docker images are the default way to package a world.

### Cited Findings

**OpenEnv (Meta/PyTorch + Hugging Face)**
- Launched Oct 23, 2025 as a Meta x Hugging Face partnership, together with an "OpenEnv Hub" on HF: "a shared space where developers can build, share, and explore OpenEnv-compatible environments". The 0.1 spec centers on `step()`, `reset()`, `close()`. Integrations: TRL, TorchForge, verl, SkyRL, Unsloth — [HF blog](https://huggingface.co/blog/openenv)
- Current README: Gymnasium-style `step()`, `reset()`, `state()`. Server-side `Environment.reset()` returns an `Observation`, `step(action)` returns an `Observation`, and `state()` returns a `State` (episode_id, step_count, ...). Typed models are `Action`, `Observation`, `State`, and `StepResult` (observation, reward, done) — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv) (repo badges now point to [huggingface/OpenEnv](https://github.com/huggingface/OpenEnv))
- Transport: each env is a FastAPI server inside an isolated Docker container. The client `EnvClient` is async by default (`.sync()` wrapper) and talks to it over WebSocket (reset/step/state) — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv)
- Container/runtime providers: LocalDocker, UVProvider (no Docker), Docker Swarm, Daytona, Modal, Novita, Azure Container Apps, HF sandboxes — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv); [Runtime providers docs](https://huggingface.co/docs/openenv/guides/runtime-providers)
- RFCs: 000 principles, 001 baseline API, 002 tool discoverability, 003 MCP support, 004 delayed rewards for trajectory-based scoring, 005 agentic harness integration, 010 "Env-token World Modeling (ECHO)" — [OpenEnv README RFC list](https://github.com/meta-pytorch/OpenEnv); [RFC 003 PR](https://github.com/huggingface/OpenEnv/pull/224); [RFC 004 PR](https://github.com/huggingface/OpenEnv/pull/337); [RFC 005 PR](https://github.com/huggingface/OpenEnv/pull/387); [RFC 010 PR](https://github.com/huggingface/OpenEnv/pull/819)
- Packaging CLI: `openenv init | build | validate | push [--repo-id] [--private]` (deploys to HF Spaces), `fork <space-id>`, `import` (wraps ORS/OpenReward and Verifiers envs as OpenEnv), `harbor` (serve/run Harbor tasks with token-level capture), `collect`, `catalog/discover`. Clients install straight from a Space with `pip install git+https://huggingface.co/spaces/openenv/echo_env`. Per-env manifest: `openenv.yaml` — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv)
- Built-in web UI (`ENABLE_WEB_INTERFACE=true`) auto-generates action forms from the Action type so a human can act as the agent — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv)
- The project describes itself as experimental: "expect bugs, incomplete features, and APIs that may change" — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv)

**Prime Intellect verifiers + Environments Hub**
- verifiers v1 (`import verifiers.v1 as vf`) replaces the old v0 stack, which "has been removed". v0 concepts (`load_environment`, SingleTurnEnv/MultiTurnEnv/ToolEnv, Rubric) are deprecated, and the Hub lists v0 envs under "Legacy" — [verifiers docs overview](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/overview.md); [Prime docs: create env](https://docs.primeintellect.ai/tutorials-environments/create.md)
- v1 concepts: **Taskset** (`load()` yields Tasks and may be an infinite generator with `INFINITE = True`), **Task** (scoring, stop conditions, setup, judging, tools), **TaskData** (immutable row: prompt, files, references, resources, timeouts), **Harness** (the program the model runs in, e.g. Claude Code, Codex, mini-swe-agent), **Agent** = harness x model x runtime policy, which produces a **Trace**, **Env** (multi-agent control flow), and **Toolset** (taskset-defined tools "installed as MCP servers into the harnesses") — [v1 overview](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/overview.md)
- Rewards are decorated methods on the task, e.g. `@vf.reward async def exact_match(self, trace: vf.Trace) -> float`. There is also `@vf.metric`. Reward fns can take a `runtime: vf.Runtime` parameter to run commands in a box — [v1 tasksets](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/tasksets.md); [v1 env](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/env.md)
- Env signature: `async def run(self, task: Task, agents: Agents) -> None`. Built-ins: `IsolatedVerifierEnv` (moves only declared artifacts into a fresh runtime for deterministic scoring), `AgenticJudgeEnv` (Shared/Isolated variants), `UserSimEnv`, `BestOfNEnv` (pass@n) — [v1 env](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/env.md)
- Runtimes: subprocess (debug), docker, podman, apptainer (HPC), and remote sandboxes `prime`, `modal`, `e2b` for production. Model traffic from the harness goes through an **interception server**, which builds traces live, injects sampling params, and can rewrite tool responses "to block reward hacks" — [v1 architecture](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/architecture.md)
- Task identity: `idx`, an optional durable `id`/`name`, and a content `hash`/`key`, all recorded on traces. Task selection: `include/exclude/shuffle/skip/limit` — [v1 tasksets](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/tasksets.md)
- First-class Harbor interop: `HarborTaskset` loads any Harbor-registry dataset, e.g. `terminal-bench/terminal-bench-2` — [v1 harbor](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/harbor.md)
- Packaging/versioning: each env is a Python package with `pyproject.toml` (deps, version, tags, description). `prime env push` uploads it, and `prime env install owner/environment-name` installs it. Bumping the version in pyproject and pushing "will automatically create a new version while keeping previous versions available", `--auto-bump` increments automatically, and `--visibility=PRIVATE` is supported — [Prime docs: create & upload](https://docs.primeintellect.ai/tutorials-environments/create.md)
- Scaffolding: `uv run vf-init <name>` (`-T` adds an MCP tool server, `-H` adds a custom harness). Evals run with `vf-eval` — [verifiers AGENTS.md](https://github.com/PrimeIntellect-ai/verifiers/blob/main/AGENTS.md); [Hub](https://app.primeintellect.ai/dashboard/environments)

**GEM (General Experience Maker, axon-rl)**
- Follows OpenAI Gym conventions exactly: `reset()` returns `(observation, info)` and `step(action)` returns `(next_obs, reward, terminated, truncated, info)`. Env IDs are namespaced, e.g. `game:GuessTheNumber-v0`. Tools (Python, Search, MCP) are added through **environment wrappers**. Supports async vectorized execution. Framework-agnostic, with examples for Oat, Tinker, verl, RL2, ROLL, OpenRLHF — [GEM GitHub](https://github.com/axon-rl/gem)

**Reasoning Gym**
- A library of procedural dataset generators plus algorithmic verifiers, not a step-loop env: `reasoning_gym.create_dataset('leg_counting', size=10, seed=42, **params)` and `data.score_answer(answer=..., entry=...) -> float`. Supports composite datasets and `get_score_answer_fn(source_dataset)` for scoring offline. An optional "cascade scorer" falls back from string to numeric to symbolic matching. The project recommends running it via verifiers — [Reasoning Gym README](https://github.com/open-thought/reasoning-gym)

**NeMo Gym (NVIDIA)**
- Three kinds of HTTP microservice: **Resource servers** (tasks, tools, verification), **Agent servers** (harnesses such as OpenHands, mini-SWE-agent, Claude Code, Harbor agent, verifiers agent), and **Model servers** (OpenAI/Responses-API-compatible: vLLM, Azure, etc.). The README frames an environment as dataset + agent harness + verifier + state — [NeMo Gym README](https://github.com/NVIDIA-NeMo/Gym)
- Resource-server contract (from the example source): subclass `SimpleResourcesServer`, register tool endpoints with FastAPI `app.post("/get_weather")`, implement `seed_session(...)` and `close_resources_session(...)`, and implement `async def verify(self, body: BaseVerifyRequest) -> BaseVerifyResponse` that returns the request plus `reward` — [example_single_tool_call/app.py](https://github.com/NVIDIA-NeMo/Gym/blob/main/resources_servers/example_single_tool_call/app.py)
- Wraps outside ecosystems as resource servers or agents: Aviary, Harbor, OpenEnv (including an OpenEnv-over-MCP echo env), Reasoning Gym, verifiers. Has `gym eval reverify` to recompute rewards from stored rollouts. YAML config per environment, with datasets on HF — [NeMo Gym README](https://github.com/NVIDIA-NeMo/Gym)

**Gymnasium / TextArena**
- TextArena: `env = ta.make(env_id="TicTacToe-v0")`, `env.reset(num_players=N)`, `done, step_info = env.step(action=action)` (multi-player and turn-based, with observation wrappers). v0.6.9 shipped 100 games. There is an online leaderboard at textarena.ai and a companion RL library, UnstableBaselines — [TextArena README](https://github.com/LeonGuertler/TextArena)
- Gymnasium remains the lineage that GEM, SkyRL-Gym, rLLM and OpenEnv all name explicitly — [Gymnasium docs](https://gymnasium.farama.org/api/env/)

**Inspect AI (UK AISI)**
- The `SandboxEnvironment` API has `exec()` (with timeouts, user, env, cwd, a 10MB output cap), `exec_remote()` (streaming), `write_file()`, `read_file()` (100MB cap), and `connection()`. Providers: docker (built-in), k8s, daytona, modal, ec2, proxmox, vagrant, NVIDIA openshell, local. Configured with `Dockerfile`/`compose.yaml` (`network_mode: none` for isolation). Each `Sample` can set its own `sandbox`, `files` and `setup` script. Concurrency is controlled with `max_sandboxes` and `max_samples` — [Inspect sandboxing docs](https://inspect.aisi.org.uk/sandboxing.html)
- Scorers: built-ins `includes()`, `match()`, `exact()`, `pattern()`, `answer()`, `choice()`, `model_graded_qa()`, `model_graded_fact()`. Custom `@scorer` functions return a `Score` checked against a `Target`, with `metrics=[...]` for aggregation — [Inspect scorers docs](https://inspect.aisi.org.uk/scorers.html)

**HUD (hud.ai, formerly hud.so)**
- "Protocol-first": the agent and environment exchange a **manifest** (capabilities and tasks), **`tasks.start`** (returns the prompt) and **`tasks.grade`** (returns the reward), and the agent drives the capabilities in between. Capabilities: `ssh` (shell + files), `mcp` (tools), `cdp` (browser), `rfb` (VNC computer-use), `robot` (beta, WebSocket obs/action) — [hud-python README](https://github.com/hud-evals/hud-python)
- A task template is an async generator: `@env.template()` / `answer = yield prompt` / `yield reward`. Calling a template mints a Task. `hud deploy` builds an image that "packs every task from a single definition", and `hud eval <taskset> --remote` runs it. Rollouts return a `Run` with `trace_id` and `reward` that can be passed to `TrainingClient.step()` — [hud-python README](https://github.com/hud-evals/hud-python)
- The PyPI package was renamed from `hud-python` to `hud` — [PyPI hud](https://pypi.org/project/hud/)

**Harbor / Terminal-Bench**
- A task is a directory: `instruction.md`, `task.toml`, `environment/` (Dockerfile, docker-compose.yaml, or Apptainer.def), `solution/solve.sh`, `tests/test.sh`. The verifier must write `/logs/verifier/reward.txt` (a single number) or `reward.json` (labeled multi-metric, preferred if present). Tasks have "no dependency on the Harbor framework" and are meant to be "self-contained, versioned" like software packages — [Harbor tasks overview](https://docs.harborframework.com/tasks/overview.md); [Harbor verifier](https://docs.harborframework.com/tasks/verifier.md)
- Newer features: multi-step tasks (`steps/step-N/` each with its own instruction, tests and solution), a separate verifier sandbox (`[verifier] environment_mode = "separate"` with declared `[artifacts]` handed off), regrading, network policies, multi-container, a simulated user, and RewardKit (programmatic criteria + weights + an optional LLM or agent judge configured in TOML) — [Harbor docs index](https://docs.harborframework.com/llms.txt); [Harbor verifier](https://docs.harborframework.com/tasks/verifier.md)
- Agent and sandbox protocols: agents via ACP (Agent Client Protocol registry) and custom agents, trajectories in the **ATIF** JSON format, and sandboxes via **ASP** (Agent Sandbox Protocol, "run any agent harness's tools in a remote sandbox over SSH") or custom providers — [Harbor docs index](https://docs.harborframework.com/llms.txt)
- Registry/versioning: `registry.json` entries are `{name, version, description, tasks:[{name, git_url, git_commit_id, path}], metrics}`, and the docs advise pinning commit SHAs. Harbor Hub is the default registry, with publish/download, hosted jobs and leaderboards — [Harbor registries](https://docs.harborframework.com/datasets/registries.md); [Harbor Hub](https://hub.harborframework.com)
- Terminal-Bench 2.0 is distributed as the Harbor dataset `terminal-bench/terminal-bench-2` — [verifiers harbor doc](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/harbor.md)
- Downstream adoption: SkyRL is integrated with Harbor (2026-02-17), verifiers ships HarborTaskset, NeMo Gym has a Harbor agent, and OpenEnv has `openenv harbor` — [SkyRL README](https://github.com/NovaSky-AI/SkyRL); [NeMo Gym README](https://github.com/NVIDIA-NeMo/Gym); [OpenEnv README](https://github.com/meta-pytorch/OpenEnv)

**OpenAI Evals / graders**
- Declarative JSON graders: `string_check`, `text_similarity`, `score_model` (LLM judge), plus label-model and python graders. They compose via a `multi` grader with a `calculate_output` formula, use `{{ sample.output_tools[0].function.name }}`-style templating, and are reused for reinforcement fine-tuning — [OpenAI graders guide](https://developers.openai.com/api/docs/guides/graders.md)

**rLLM**
- `BaseEnv` (Gymnasium-style): `reset() -> (obs, info)`, `step(action) -> (obs, reward, done, info)`, `close()`, plus an `idx` property for batching — [rLLM BaseEnv docs](https://rllm-project.readthedocs.io/en/latest/api/environments/base/)

**SkyRL-Gym**
- `BaseTextEnv` "exposes only `step`, `init` and `close`". `init(prompt) -> (conversation, metadata)` and `step(action: str) -> {observations: [OpenAI-format messages], reward, done, metadata, postprocessed_action}`. Tools are reusable `ToolGroup`s that are written once and used across envs. Ships math, code, search and SQL environments. Install with `pip install skyrl-gym` — [base_text_env.py](https://github.com/NovaSky-AI/SkyRL/blob/main/skyrl-gym/skyrl_gym/envs/base_text_env.py); [SkyRL-Gym README](https://github.com/NovaSky-AI/SkyRL/tree/main/skyrl-gym)

**AgentGym / AgentGym-RL**
- Environments are servers with a "standardized server–client architecture with unified HTTP protocols". `EnvClient` exposes `observation()`, `available_actions()`, `step()`, `reset()`. Covers WebArena, Search-R1-style deep search, TextCraft, BabyAI, and more. ScalingInter-RL gradually lengthens the interaction horizon (`RoundScheduler`) — [AgentGym-RL README](https://github.com/WooooDyy/AgentGym-RL)

**OpenReward / ORS (Open Reward Standard), an MCP-like env server standard**
- ORS servers are "passive FastAPI-style servers" that provide Tasks (initial prompts), Tools (actions), Splits (train/validation/test), stateful sessions, and Tool Results (feedback + `reward` + termination). Sandboxes are optional, usually created per session, and provider-agnostic (Daytona, E2B, Modal, or OpenReward's own) — [OpenReward architecture](https://docs.openreward.ai/concepts/architecture.md); [ORS spec site](https://openrewardstandard.io)
- Client loop: `list_splits()`, `list_tasks(split)`, `session.get_prompt()`, `session.call_tool("answer", {...})`, which returns `ToolOutput(blocks=[TextBlock(...)], reward=1.0, finished=True)`. Envs subclass `Environment` and use an `@tool` decorator. The platform claims 380+ hosted environments — [OpenReward first env tutorial](https://docs.openreward.ai/environments/your-first-environment.md); [openreward.ai](https://openreward.ai)
- Also documents rubrics, LLM graders, preference rewards, toolsets, backdated web tools (no leakage past a cutoff date), placeholder secret injection, and environment cards — [OpenReward docs index](https://docs.openreward.ai/llms.txt)

**Sandboxes (Docker/E2B/Daytona/Modal)**
- These act as interchangeable backends behind each framework's runtime abstraction. verifiers: docker/podman/apptainer/prime/modal/e2b ([v1 architecture](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/architecture.md)). Inspect: docker/k8s/daytona/modal/ec2/... ([Inspect sandboxing](https://inspect.aisi.org.uk/sandboxing.html)). OpenEnv: Docker/Daytona/Modal/HF/Azure ([OpenEnv README](https://github.com/meta-pytorch/OpenEnv)). OpenReward: Daytona/E2B/Modal ([OpenReward architecture](https://docs.openreward.ai/concepts/architecture.md)). Harbor: pre-integrated + custom sandboxes, ASP over SSH ([Harbor docs index](https://docs.harborframework.com/llms.txt)). NeMo Gym Harbor configs include Docker, Daytona, OpenSandbox ([NeMo Gym README](https://github.com/NVIDIA-NeMo/Gym)).

### Inferences
- The minimal surface that sandbox-backed frameworks need from a sandbox is Inspect's: `exec`, `read_file`, `write_file` (+ optional `connection`). verifiers' `runtime.run`/`runtime.write` has the same shape.
- Interop is becoming adapter-based rather than one-standard-wins. OpenEnv imports ORS and verifiers, verifiers and SkyRL import Harbor, and NeMo Gym wraps all of them. The Harbor task directory is the most widely consumed portable artifact for agentic and terminal tasks.

### Gaps
- I did not fetch the full text of OpenEnv RFC 003/004/005, so how MCP tools map onto `step()` (for example, whether `step` takes a `CallToolAction`) is unverified.
- I found no reliable primary source on the "OpenAI Agents SDK evals" interface specifically (beyond the graders API). It's unclear whether a separate Agents-SDK env contract exists.
- The GEM paper (arXiv) and the AgentGym-RL paper were not fetched. Details on GEM's reward shaping and env registry beyond the README are unverified.
- Exact HTTP route names for OpenEnv (beyond WebSocket reset/step/state) and for the ORS wire protocol were not checked against the spec text.

## Q2. How do they express graders (rubrics, reward functions, state checks), and how are environments versioned and published?

### Takeaway
Graders fall into four patterns: (1) a Python function over the final answer or trace (verifiers `@vf.reward`, Reasoning Gym `score_answer`, Inspect `@scorer`); (2) a script that checks the end state of the sandbox and writes a reward file (Harbor `tests/test.sh` writing `/logs/verifier/reward.txt|json`); (3) a reward returned with tool results or a grade call (ORS `ToolOutput.reward`, HUD `tasks.grade`, NeMo Gym `/verify`, Gym `step()` reward); (4) declarative or LLM-judge composites (OpenAI `multi`/`score_model`, Harbor RewardKit, Inspect `model_graded_*`). Running the verifier in a separate sandbox, with explicit artifact handoff, is a 2026 convergence point. Publishing works through git+version (Harbor registry), Python package semver (Prime Hub), HF Spaces (OpenEnv), or a built image (HUD).

### Cited Findings
- verifiers: rewards and metrics are decorated async methods on a Task that receive a `Trace` or a `Runtime`. `IsolatedVerifierEnv` runs scoring in a fresh runtime with only declared `TaskData.artifacts` copied over. Agentic judges are envs in their own right (`AgenticJudgeEnv`) — [v1 env](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/env.md); [v1 tasksets](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/tasksets.md)
- Harbor: the reward is a file written by the test script. `reward.json` holds labeled multi-dim metrics, the separate-verifier mode stops agent filesystem changes from leaking into verification, and "Regrade" re-runs an updated verifier on recorded outputs. RewardKit adds weighted criteria and LLM or agent judges in TOML — [Harbor verifier](https://docs.harborframework.com/tasks/verifier.md); [Harbor docs index](https://docs.harborframework.com/llms.txt)
- Harbor dataset-level metrics: `sum | min | max | mean | uv-script` in registry.json — [Harbor registries](https://docs.harborframework.com/datasets/registries.md)
- NeMo Gym: `verify()` on the resource server returns a `reward`. Verifiers can be binary, multi-component, LLM-judge with rubrics, execution-based, or rule-based. Rewards can be recomputed offline (`gym eval reverify`) — [NeMo Gym README](https://github.com/NVIDIA-NeMo/Gym); [example app.py](https://github.com/NVIDIA-NeMo/Gym/blob/main/resources_servers/example_single_tool_call/app.py)
- HUD: the grader is the second `yield` of the template generator, exposed over the protocol as `tasks.grade` — [hud-python README](https://github.com/hud-evals/hud-python)
- ORS: the reward and `finished` flag arrive on tool outputs (e.g. from a terminal `answer` tool). Rubric, LLM-grader and preference-reward guides exist — [OpenReward tutorial](https://docs.openreward.ai/environments/your-first-environment.md); [OpenReward docs index](https://docs.openreward.ai/llms.txt)
- OpenEnv: the reward rides on `StepResult`, and RFC 004 adds delayed, trajectory-level rewards — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv)
- Reasoning Gym: each generator ships its own `score_answer`, plus a cascade string/numeric/symbolic scorer — [Reasoning Gym README](https://github.com/open-thought/reasoning-gym)
- Inspect: `Score`/`Target`/`Value` types, built-in and model-graded scorers, custom metrics — [Inspect scorers](https://inspect.aisi.org.uk/scorers.html)
- OpenAI: JSON grader objects that compose via `multi` + `calculate_output` — [OpenAI graders](https://developers.openai.com/api/docs/guides/graders.md)
- Versioning and publishing:
  - Prime Hub: pyproject version, `prime env push` (`--auto-bump`), old versions kept — [Prime docs](https://docs.primeintellect.ai/tutorials-environments/create.md)
  - Harbor: registry entries keyed by `name` + `version`, tasks pinned by git commit, publish to Harbor Hub — [Harbor registries](https://docs.harborframework.com/datasets/registries.md); [Harbor publish](https://docs.harborframework.com/harbor-hub/publish.md)
  - OpenEnv: `openenv push` to HF Spaces, installable via `pip install git+https://huggingface.co/spaces/...` — [OpenEnv README](https://github.com/meta-pytorch/OpenEnv)
  - HUD: `hud deploy` builds and registers an image — [hud-python README](https://github.com/hud-evals/hud-python)
  - GEM / TextArena: versioned env IDs (`-v0`) in a registry, Gym style — [GEM](https://github.com/axon-rl/gem); [TextArena](https://github.com/LeonGuertler/TextArena)
  - verifiers: content hash + durable key per task, recorded on traces — [v1 tasksets](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/tasksets.md)

### Inferences
- Reward hacking is now designed for at the interface level. verifiers' interception server rewrites tool responses, Harbor and verifiers isolate the verifier sandbox, and OpenReward offers backdated web tools. A world-engine spec should make verifier isolation and declared artifacts first-class.
- Multi-dimensional labeled rewards (`reward.json`, multi-component NeMo verifiers, OpenAI `multi`) are standard. A spec should allow a dict of named scores, with a declared aggregate.

### Gaps
- I didn't verify whether OpenEnv's HF-Spaces publishing pins image digests or only Space revisions.
- I didn't verify whether HUD tasksets/images carry explicit semantic versions.

## Q3. What is the minimal viable "env contract" that multiple frameworks converge on?

### Takeaway
Across Harbor, verifiers v1, HUD, ORS, NeMo Gym, OpenEnv and Inspect, the common core is: **a task spec** (id + prompt/instruction + metadata/split) + **a world runtime** (a container image, or a stateful server/session) + **actions exposed as tools** (MCP, HTTP/FastAPI, or shell over SSH/exec) + **a grade/verify hook** that returns a scalar reward and optional named sub-scores, run after the episode or per tool call + **lifecycle hooks** (setup/seed_session, teardown/close) + **a trace/trajectory record**. Gym-style `reset/step` is a thin adapter on top of this, and Harbor, verifiers, OpenEnv and NeMo Gym all ship such adapters.

### Cited Findings
- Session lifecycle shows up everywhere:
  - NeMo Gym: `seed_session` / tool endpoints / `verify` / `close_resources_session` — [NeMo example](https://github.com/NVIDIA-NeMo/Gym/blob/main/resources_servers/example_single_tool_call/app.py)
  - ORS: session `get_prompt` / `call_tool` returning reward and finished — [OpenReward](https://docs.openreward.ai/environments/your-first-environment.md)
  - HUD: manifest / `tasks.start` / `tasks.grade` — [HUD](https://github.com/hud-evals/hud-python)
  - OpenEnv: reset / step / state / close — [OpenEnv](https://github.com/meta-pytorch/OpenEnv)
- Task discovery: ORS `list_splits`/`list_tasks`, HUD manifest, verifiers `Taskset.load()`, Harbor `registry.json`/dataset — [ORS](https://docs.openreward.ai/concepts/architecture.md); [HUD](https://github.com/hud-evals/hud-python); [verifiers](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/tasksets.md); [Harbor](https://docs.harborframework.com/datasets/registries.md)
- Tool exposure through MCP: verifiers Toolsets install as MCP servers, HUD has an `mcp` capability, GEM has an MCP wrapper, OpenEnv has RFC 003, and NeMo Gym runs OpenEnv via MCP — [verifiers](https://github.com/PrimeIntellect-ai/verifiers/blob/main/docs/v1/overview.md); [HUD](https://github.com/hud-evals/hud-python); [GEM](https://github.com/axon-rl/gem); [OpenEnv](https://github.com/meta-pytorch/OpenEnv); [NeMo Gym](https://github.com/NVIDIA-NeMo/Gym)
- The harness is kept separate from the environment: verifiers (Harness ≠ Taskset), Harbor (agent ≠ task, ACP), HUD ("any model or harness plugs into any environment"), NeMo Gym (agent servers ≠ resource servers), ORS ("strict separation of concerns between the agent and the environment") — sources above
- Text-env step outputs converge on OpenAI-format messages + reward + done + metadata (SkyRL-Gym `BaseTextEnvStepOutput`), or Gym 5-tuples (GEM) / 4-tuples (rLLM) — [SkyRL](https://github.com/NovaSky-AI/SkyRL/blob/main/skyrl-gym/skyrl_gym/envs/base_text_env.py); [GEM](https://github.com/axon-rl/gem); [rLLM](https://rllm-project.readthedocs.io/en/latest/api/environments/base/)

### Inferences
- A lightweight world-engine spec could define:
  1. a `world.toml`/manifest (id, version, image or entrypoint, resources, network policy, splits, tool list, capabilities: mcp/shell/browser/vnc);
  2. `instruction` + task data;
  3. `start(task, seed) -> session` and `close(session)`;
  4. tools as MCP over HTTP;
  5. `grade(session | artifacts) -> {reward: float, scores: {name: float}, info}`, optionally run in a separate verifier box;
  6. a trace format (ATIF or similar).

  It should also ship a Gym `reset/step` adapter and a Harbor-task export, since those two get the widest training-framework reach (verl/SkyRL/TRL via OpenEnv/GEM, and verifiers/SkyRL/NeMo/OpenEnv via Harbor).
- Do not make per-step rewards mandatory. Most agentic frameworks grade at episode end (Harbor, HUD, verifiers), and OpenEnv needed an RFC to add delayed rewards.

### Gaps
- No cross-framework formal standard has clear majority adoption. ORS, the HUD protocol and OpenEnv's spec all compete, and I found no neutral survey or adoption numbers comparing them.
- I found no source comparing throughput or cost across the E2B, Daytona and Modal backends in these frameworks.
