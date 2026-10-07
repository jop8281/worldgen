# API Mocking, Service Virtualization, Digital Twins of APIs, and LLM-Simulated Tools ("fake but stateful software")

Research date: 2026-10-06. Sources fetched this session unless marked "[background, not re-verified]".

## Q1. Spec-driven mocking tools: which are stateful vs stateless, and how do they model state?

### Takeaway
Classic spec-driven mockers (Prism, stripe-mock, classic Postman mocks, Fern/Speakeasy SDK-test mocks) are stateless: they validate requests against OpenAPI and return examples or faker data. State shows up in three ways: (a) explicit finite state machines (WireMock Scenarios, Hoverfly `requiresState`/`transitionsState`); (b) a script plus key-value store (Microcks 1.10+ `store`, Mountebank `state`, Postman code mocks `pm.state`, WireMock Cloud Dynamic State); (c) a real in-memory data model with CRUD semantics (json-server, Mockoon CRUD routes + data buckets, @mswjs/data, and hand-built "emulators" such as moto, LocalStack-likes, Firebase emulators, vercel-labs/emulate). Only category (c) works like a "digital twin". None of these tools derives a correct business-logic state machine automatically from an OpenAPI spec. The state logic is always hand-written, or at best inferred as generic CRUD.

### Cited Findings
**Stateless / spec-only**
- Prism (Stoplight): "Life-like mock servers from any API specification document" plus a validation proxy (`prism proxy`) for contract testing. Its roadmap lists "Data Persistence (allow Prism act like a sandbox)" and "Recording/Learning Mode" as *not yet implemented*, so Prism is stateless. — [stoplightio/prism README](https://github.com/stoplightio/prism)
- stripe-mock: "stripe-mock is stateless. Data you send on a POST request will be validated, but it will be completely ignored beyond that." It is powered by Stripe's OpenAPI spec, and its fixtures "are hardcoded, and will not necessarily represent realistic responses." — [stripe/stripe-mock](https://github.com/stripe/stripe-mock)
- Postman classic mock servers pick the best-matching saved example and return it, so they are stateless. Postman "code mocks" (custom JS handlers) add `pm.state`, "a persistent store for managing data across requests." Postman's Agent Mode can "generate and modify mocks using prompts… including multi-step workflows and data that persists across requests." — [Postman docs: local/code mocks](https://learning.postman.com/latest-v-12/docs/design-apis/mock-apis/local-mock-servers); [Postman mock overview](https://learning.postman.com/docs/design-apis/mock-apis/overview)
- Speakeasy auto-generates a mock server from an OpenAPI document that "returns predefined responses according to your OpenAPI document." Fern's "wire tests" run generated SDKs against a mock server generated from the API definition, and publishing is blocked on failures. Both target SDK contract testing. I found no evidence of stateful behaviour in either. — [Speakeasy blog](https://speakeasy.com/post/how-to-generate-a-mock-server); [Fern testing docs](https://buildwithfern.com/learn/sdks/deep-dives/testing)

**Explicit finite-state-machine mocks**
- WireMock (OSS) "supports state via the notion of scenarios, which are essentially state machines whose states can be arbitrarily assigned". Stubs match on the current scenario state and can transition it. — [WireMock stateful behaviour](https://wiremock.org/docs/stateful-behaviour/)
- WireMock Cloud "Dynamic State" is described as "a more sophisticated and powerful replacement for the existing Scenarios functionality, which only offers a simple global state machine." State is keyed by Context and Key. SET/DELETE operations use Handlebars templates with access to the request and `previousValue`, which allows per-user and per-session isolation and concurrency. — [WireMock Cloud dynamic state](https://docs.wiremock.io/dynamic-state/overview)
- WireMock Cloud (announced Mar 20, 2025) auto-generates CRUD endpoints "with persistent state management" from a collection path, a sample request and a response shape (not from OpenAPI). The platform also advertises "native MCP integration and Agent Skills". — [WireMock blog](https://www.wiremock.io/post/automatically-create-stateful-mocks-for-rest-apis)
- Hoverfly: request/response pairs carry `requiresState` (match condition) and `transitionsState` (state update). A `sequence:` key prefix gives ordered sequences, and the final response repeats after the end. — [Hoverfly docs: sequences](https://docs.hoverfly.io/en/latest/pages/keyconcepts/state/sequences.html); [hoverfly-java stateful simulation](https://docs.hoverfly.io/projects/hoverfly-java/en/latest/pages/corefunctionality/state.html)

**Script + key-value store**
- Microcks added stateful mocks in 1.10.0. They use a SCRIPT dispatcher (Groovy), a `store` API (`get`/`put(key,value,ttl)`/`delete`) and a `requestContext` passed to response templates. The store has a default TTL of 10 seconds and is "scoped to an API". — [Microcks stateful mocks guide](https://microcks.io/documentation/guides/usage/stateful-mocks/)
- Mountebank injection receives a `state` object, "an initially empty object that will be shared between predicate and response injection functions." State "is shared between stubs on one imposter, but not shared between imposters." — [mountebank injection docs](https://www.mbtest.dev/docs/api/injection)

**In-memory data model (CRUD twin)**
- json-server: a full REST surface (GET/POST/PUT/PATCH/DELETE) over a `db.json` file, with filtering operators, `_sort`, `_page`/`_per_page` and `_embed`. v1 is still in beta with breaking changes. — [typicode/json-server](https://github.com/typicode/json-server)
- Mockoon CRUD routes are backed by data buckets "generated when the server start[s], their state persisting between calls". State "will not be saved in the data file" and resets when the mock restarts. — [Mockoon CRUD routes](https://mockoon.com/docs/latest/api-endpoints/crud-routes/)
- MSW + @mswjs/data: a schema-based data layer that uses Standard Schema (Zod, Valibot and others), Prisma-like querying and Drizzle-like relations, with extensions for persistence. It pairs with MSW request handlers. — [mswjs/data](https://github.com/mswjs/data)

**Hand-built stateful emulators ("digital twins" of specific SaaS/cloud)**
- LocalStack: the `localstack/localstack` repo was archived on March 23, 2026, and the Docker image now requires `LOCALSTACK_AUTH_TOKEN`, which ends the account-free community pattern. OSS stateful successors on port 4566 include MiniStack (40+ services), Floci (47; memory/persistent/hybrid/WAL modes), kumo (76; file persistence) and fakecloud (30+, AGPL). moto covers 100+ services, runs as an in-process decorator, ThreadedMotoServer or Docker server, and is Apache-2.0. — [codenote comparison](https://codenote.net/en/posts/localstack-archived-oss-alternatives-comparison/); [moto](https://github.com/getmoto/moto); [kumo](https://github.com/sivchari/kumo)
  - Note: the archive and auth-token claims come from a secondary blog. The report writer should treat the specifics as needing confirmation against [github.com/localstack/localstack](https://github.com/localstack/localstack).
- Firebase Local Emulator Suite covers Firestore, Realtime DB, Cloud Storage, Auth, Cloud Functions (beta), Pub/Sub (beta) and Extensions (beta), plus an Emulator UI for viewing and managing data. — [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite)
- vercel-labs/emulate (Apache-2.0, ~1.9k stars) is "Fully stateful, production-fidelity API emulation. Not mocks." It emulates Vercel, GitHub, Google, Apple, Microsoft, Okta, Slack, Linear, Clerk, AWS (S3/SQS/IAM/STS), Twilio, Resend, MongoDB Atlas and Stripe. It uses an in-memory typed-collection store with indexing, filtering and pagination, webhooks on state changes, OAuth token rotation and cascade deletes. State is seeded from YAML/JSON/TS, and custom emulators are defined in TypeScript. `npx emulate` starts all services on ports 4000–4013. — [vercel-labs/emulate](https://github.com/vercel-labs/emulate); [Stripe emulator skill page](https://skills.sh/vercel-labs/emulate/stripe)

### Inferences
- There is a clear spectrum: stateless spec mock → FSM mock → KV-script mock → CRUD data-model mock → hand-coded domain emulator. Each step up gives more fidelity and costs more human authoring, and that cost is the gap an LLM "world generator" would fill.
- FSM-style mocks (WireMock Scenarios, Hoverfly) only model a single global or sequence state. They cannot represent entity-level state such as "order #17 is shipped". Generic CRUD twins (json-server, Mockoon, @mswjs/data) represent entities but not business rules or side effects (cascades, derived fields, webhooks). Hand-written emulators (moto, Firebase, emulate) are the only ones with domain invariants.
- vercel-labs/emulate and WireMock's MCP/Agent Skills positioning suggest vendors now see stateful emulators as agent infrastructure, not only CI tooling.

### Gaps
- I could not fetch Speakeasy's current mock-server docs (404) or confirm whether any Speakeasy or Fern mock persists state.
- Microcks AI Copilot (LLM-generated examples) exists per [background, not re-verified]. I did not confirm whether it generates stateful scripts.
- I did not verify Firebase emulator export/import-on-exit (`--export-on-exit`) in this session [background].
- I found no tool that infers state transitions automatically from OpenAPI `links` or from the semantics of request and response schemas.

## Q2. LLM-simulated tools: what does research show about fidelity and consistency?

### Takeaway
LLM-as-API-simulator works well for *read-like, stateless* responses and for generating training signal. Simulated environments have trained agents that transfer to AppWorld, τ²-bench and BFCL. Measured *state* fidelity is poor, though. EnvSimBench finds frontier models get state updates right only 22–50% of the time for single-field changes and ≤4% for operations touching 5+ fields (the "state-change cliff"). They often produce correct-looking feedback while silently corrupting state. Papers that compare head-to-head (AWM, EnvScaler) find code-plus-database environments beat LLM-simulated ones. The field is converging on hybrids: LLMs *generate code* for environments, or simulators are grounded with explicit state, trace "worldbooks", or fine-tuned mirror models.

### Cited Findings
**Early LLM-emulated tools**
- ToolEmu (Ruan et al., ICLR 2024) uses an LM to emulate tool execution plus an LM safety evaluator, over 36 high-stakes toolkits and 144 test cases. "68.8% of failures identified with ToolEmu would be valid real-world agent failures," and the safest agent still failed 23.9% of the time. The remaining ~31% were emulator artifacts. — [arXiv 2309.15817](https://arxiv.org/abs/2309.15817)
- StableToolBench (Guo et al., ACL Findings 2024) adds a "virtual API server" with "a caching system and API simulators" (GPT-4 simulating RapidAPI/ToolBench APIs when the real API fails), plus solvable pass and win rates with a GPT-4 judge. Per the paper, human annotators could not reliably tell simulated from real API responses. — [arXiv 2403.07714](https://arxiv.org/abs/2403.07714); [ACL PDF](https://aclanthology.org/2024.findings-acl.664.pdf)
- StableToolBench-MirrorAPI (ACL Findings 2025) fine-tunes specialized LLMs with CoT on request-response pairs from 7,000+ real APIs to "mirror" them. It reports "superior accuracy and stability compared to state-of-the-art methods" on MirrorAPI-Bench, with fidelity measured as embedding cosine similarity between simulated and real responses. — [arXiv 2503.20527](https://arxiv.org/abs/2503.20527); [ACL Anthology](https://preview.aclanthology.org/setup/2025.findings-acl.273)

**LLM simulators for agent training (2025–2026)**
- "Simulating Environments with Reasoning Models for Agent Training" (Simia-SFT / Simia-RL, arXiv 2511.01824) trains without real environment implementations by using LLM-simulated feedback. Fine-tuned open models "surpass GPT-4o and approach o4-mini on τ²-Bench." The abstract does not address state consistency. — [arXiv 2511.01824](https://arxiv.org/abs/2511.01824)
- "Simulate to Generalize" (Lee et al., Apple; arXiv 2607.16900) starts from domain names only, auto-creates APIs and tasks, and has "an LLM-based simulator [that] tracks state and provides responses" while a teacher agent solves tasks, with an automated quality filter. It reports substantial gains on AppWorld and OfficeBench, both unseen in training. — [arXiv 2607.16900](https://arxiv.org/abs/2607.16900)
- UI-Simulator / UI-Simulator-Grow (Wang et al., UCLA; arXiv 2510.14969) uses an LLM to simulate UI states and transitions for web/digital agents. Agents trained on synthetic trajectories "rival or exceed" those trained on real UIs, and the Llama-3-8B agent matches Llama-3-70B-Instruct. — [arXiv 2510.14969](https://arxiv.org/abs/2510.14969)
- TRUSTEE (arXiv 2604.17739) fully simulates tasks, users, tool responses and judging with a free Qwen3-8B. It gains on BFCL v4 and τ²-bench and beats EnvScaler and AWM baselines in its setting. It does *not* measure simulator fidelity directly and acknowledges "scalability of the simulated environment is constrained due to the bounded capability of the simulation LM" for many-tool, long-horizon tasks. — [arXiv 2604.17739](https://arxiv.org/html/2604.17739v2)
- SimuRA (arXiv 2507.23773) uses an LLM world model *inside the agent* for planning via simulation. It raises flight-search success from 0% to 32.2% and gains up to 124% over autoregressive planning. This is a world model as planner, not as environment. — [arXiv 2507.23773](https://arxiv.org/abs/2507.23773v2)
- GenEnv (arXiv 2512.19682) co-evolves the agent and the environment simulator with difficulty alignment. — [arXiv 2512.19682](https://arxiv.org/pdf/2512.19682)
- Trace2Env (arXiv 2610.06100, Oct 2026) builds a "worldbook" from historical interaction traces (environment schemas, grounded evidence, induced behavioural knowledge). A world-model agent uses it together with *persistent episodic state*. Across nine environments it improves next-observation fidelity and long-horizon consistency over prompt-based LLM world models, measured by whether task-agent actions stay valid when replayed in the real environment. — [arXiv 2610.06100](https://arxiv.org/abs/2610.06100)

**Measured fidelity failures**
- EnvSimBench (arXiv 2605.07247) has 400 samples from 167 EnvScaler environments, with ground truth from Python execution (LLM-free). Two metrics: Feedback Match (FM) and Config Match (CM, the correctness of the resulting state). Results across seven frontier models:
  - State-preserving operations: CM 97–100%.
  - State-changing operations: CM 22–50% at |Δ|=1, 8.5–17.5% at |Δ|=3–6, and ≤4% at |Δ|≥5. The best overall CM is 42.3%.
  - FM stays at 27–81% even when CM is low, meaning "models generate plausible feedback without correct state transitions."
  - Failure modes: hallucination (~10–20%), logical inconsistency (~5–15%), statelessness/ignoring the provided pre-state (~10–25%), neglected side-effect updates (~30–40% of CM failures), runtime-dependent values (~20–30%), and silent state corruption with correct feedback (50–64% of |Δ|≥3 CM failures).
  - Fix: a "constraint-driven simulation" (pre-state + call + implementation code + typed state-change ops). With it, a fine-tuned 4B model reaches 45.3% CM, +3.0pp over non-thinking frontier LLMs, at >90% lower cost.
  - [arXiv 2605.07247](https://arxiv.org/html/2605.07247)
- EnvScaler (arXiv 2601.05808) argues LLM-simulated environments "suffer from hallucinations and inconsistencies" and "lack transparency and persistent state management". It synthesizes 191 Python-class environments (avg 18.58 tools, 21.38 state categories) with ~7,000 scenarios for ~$1.02 per environment. Training gives +8.38 (Qwen3-1.7B) and +13 (Qwen3-8B) on BFCL-MT. — [arXiv 2601.05808](https://arxiv.org/html/2601.05808v2)
- Agent World Model (AWM; Snowflake + UCSD; arXiv 2602.10090) runs a pipeline of scenario → tasks → SQLite schema → sample data → API spec → Python FastAPI+MCP server → verification code. It yields 1,000 environments with 35,062 tools (~35 per environment), ~18.5 tables per environment and a median of 1,944 LOC.
  - First-try success is 88.3% for schemas and 86.8% for environment code, with 1.13 self-correction iterations on average. Cost is $57.09 per 100 environments.
  - A GPT-5 "Simulator" baseline (LLM-simulated transitions) "consistently underperforms AWM" and is more expensive per step.
  - "Code-augmented LLM-as-a-Judge" (DB-state inspection plus LLM reasoning) beats code-only or LLM-only verification.
  - [arXiv 2602.10090](https://arxiv.org/html/2602.10090v2); [Snowflake blog](https://www.snowflake.com/en/engineering-blog/agent-world-model-for-agentic-reinforment-learning); [HF dataset](https://huggingface.co/datasets/Snowflake/AgentWorldModel-1K)
- ToolHazard (arXiv 2608.11878) has an "Environment Simulator" that synthesizes executable, stateful tool environments for adversarial and security evaluation. — [arXiv 2608.11878](https://arxiv.org/html/2608.11878v1)
- ToolSandbox (Apple) is a stateful, conversational tool-use benchmark that uses executable stateful tools rather than LLM simulation. — [arXiv 2408.04682](https://arxiv.org/pdf/2408.04682)
- Benchmark-validity context: an audit of BFCL v4, τ²-Bench, LiveMCPBench and MCP-Atlas found an 18.5% evaluator–human misalignment rate (92 of 496 tasks). — [arXiv 2607.02577](https://arxiv.org/pdf/2607.02577)

### Inferences
- LLM simulators are good *surface* simulators: format, plausible content, and reads where the pre-state is supplied. They are bad *state machines*: multi-field writes, side effects and runtime-computed values. That matches the asymmetry in EnvSimBench, and it is why AWM and EnvScaler prefer code.
- The most promising design for a world engine is hybrid. Use code and a database for state transitions and invariants (the source of truth). Use the LLM only for un-modelled long-tail fields, free-text content and error-message realism. Ground any LLM step in explicit pre-state plus implementation code, the "constraint-driven" pattern from EnvSimBench.
- Fidelity metrics worth adopting: EnvSimBench's FM/CM split (observation vs state correctness), Trace2Env's "replay validity in the real environment", MirrorAPI's response similarity, and ToolEmu's "% of flagged failures valid in reality".

### Gaps
- I did not fetch exact MirrorAPI vs GPT-4o numbers. Only qualitative claims were confirmed.
- The Simia (2511.01824) and "Simulate to Generalize" (2607.16900) abstracts did not report quantitative simulator-fidelity numbers. I could not extract their PDFs (no PDF tooling available).
- ToolLLM's original RapidAPI setup used real APIs. Simulation was added in StableToolBench, and I did not separately verify ToolLLM details.
- I found no study that measures long-horizon (>20 step) drift of LLM-simulated API state against ground truth, beyond Trace2Env's qualitative improvement claim.

## Q3. Generating backends from spec: OpenAPI generators, LLM backend generation, DB schema synthesis

### Takeaway
Deterministic OpenAPI→server generators produce stubs, not behaviour. LLM backend generation from specs is real but unreliable. On BaxBench the best model reaches ~60–62% functional correctness, and about half of correct backends are exploitable. In agent-environment pipelines (AWM), splitting the work into tasks → DB schema → API spec → code → verification, with self-correction, reaches ~87% first-try executable environments at about $0.57 each. That is the strongest evidence that "spec → stateful replica" is automatable when the target is a self-consistent world rather than a faithful copy of a real API.

### Cited Findings
- BaxBench (Vero et al., ICML 2025) has 392 tasks: 28 scenarios × 14 frameworks × 6 languages. Generated backends run in Docker with functional tests and security exploits. OpenAI o1 reaches "a mere 62%" correctness, and "on average, we could successfully execute security exploits on around half of the correct programs." Secondary summaries say "no model achieved more than 60%", which conflicts slightly with the abstract's 62%. — [arXiv 2502.11844](https://arxiv.org/abs/2502.11844); [PMLR](https://proceedings.mlr.press/v267/vero25a.html); [secondary summary](https://www.themoonlight.io/en/review/baxbench-can-llms-generate-correct-and-secure-backends)
- AutoBaxBuilder bootstraps more BaxBench-style security tasks automatically. — [arXiv 2512.21132](https://arxiv.org/pdf/2512.21132)
- WebApp1K has 1,000 React web-app tasks (20 apps × 50 user journeys, expanded by GPT-4o), each with success and failure test cases using *API mockups*. Open models closely trail GPT-4o and Claude 3.5, model size correlates with correctness, and no prompting technique helps universally. — [arXiv 2408.00019](https://arxiv.org/abs/2408.00019)
- RESTestBench evaluates LLMs translating NL requirements plus OpenAPI into executable REST test cases. — [arXiv 2604.25862](https://arxiv.org/pdf/2604.25862)
- AWM generates SQLite schemas and FastAPI/MCP code from LLM-written tasks, with 88.3% / 86.8% first-attempt success (see Q2). — [arXiv 2602.10090](https://arxiv.org/html/2602.10090v2)
- EnvScaler's SkelBuilder mines topics, models "state definitions, rules, tools", and uses dual-agent quality assessment. ScenGenerator then creates initial DB states, tasks and rule-based validators. — [arXiv 2601.05808](https://arxiv.org/html/2601.05808v2)
- Postman Agent Mode generates stateful code mocks from prompts (Q1). — [Postman docs](https://learning.postman.com/latest-v-12/docs/design-apis/mock-apis/local-mock-servers)

### Inferences
- For a world generator, the AWM/EnvScaler decomposition (schema first, then API, then code, then verifier) is the proven recipe. BaxBench-level error rates suggest every generated environment needs an automated test gate, such as the Q4 tools.
- Security weaknesses in generated backends matter less for sandboxed training worlds. Functional inconsistency matters more, because it corrupts reward.

### Gaps
- I did not find primary sources for FullStack Bench (ByteDance) or a dedicated "backend from PRD" benchmark this session.
- I found no published fidelity numbers for Lovable, bolt.new or v0-style backend generation (Supabase schemas). Vendor claims only, not researched.
- OpenAPI Generator / Swagger Codegen server stubs [background, not re-verified: https://openapi-generator.tech] produce only scaffolding with `NotImplemented` handlers. They carry no state logic.
- NL→DB-schema synthesis: beyond AWM (88.3% first-try), I found no dedicated benchmark this session.

## Q4. Formal and state-machine spec languages and testing tools for validating generated worlds

### Takeaway
Property-based and model-based testing are the most practical validators for generated stateful worlds. Hypothesis `RuleBasedStateMachine` provides rules, bundles, preconditions, invariants and shrinking. Schemathesis chains OpenAPI operations using real response data. Full formal methods (TLA+) are currently weak as an LLM target: up to 26.6% syntactic and 8.6% semantic correctness in a 2026 study. They work better as optional hand-checked cores than as generated artifacts.

### Cited Findings
- Hypothesis stateful testing: `@rule` functions are chained into random sequences. `Bundle`s carry generated values such as created IDs between rules. `@initialize` runs once, `@precondition` gates rules, and `@invariant` "run[s] after every step." Failing sequences are shrunk to minimal Python-like reproductions. — [Hypothesis stateful docs](https://hypothesis.readthedocs.io/en/latest/stateful.html)
- Schemathesis stateful phase: "chains operations with real response data, so `GET /users/{userId}` can test existing resources instead of mostly receiving 404." It infers producer→consumer links from schemas, learns links from `Location` headers, and supports explicit OpenAPI Links and GraphQL type graphs, generating workflows like create→get→update→delete. The current docs describe this as workflow generation. Earlier versions exposed a Hypothesis state machine (`schema.as_state_machine()`) [background, not re-verified]. — [Schemathesis stateful testing](https://schemathesis.readthedocs.io/en/stable/explanations/stateful/)
- TLA+ synthesis by LLMs (Loyola AI4FM group, 2026): 30 LLMs and 205 specs, checked with SANY and TLC. Best results were "up to 26.6% syntactic correctness but only 8.6% semantic correctness", and size did not predict quality. — [AI4FM: LLMs and TLA+](https://ai4fm.cs.luc.edu/papers/gsirs-2026-tla-llm/); [ChatTLA+](https://ai4fm.cs.luc.edu/papers/chattla-2026/); [Automating TLA+ model synthesis](https://ai4fm.cs.luc.edu/papers/gcasr-2025-tla-llm/)
- WireMock Scenarios and Hoverfly states are themselves lightweight FSM specs embedded in mocks (Q1). — [WireMock](https://wiremock.org/docs/stateful-behaviour/); [Hoverfly](https://docs.hoverfly.io/en/latest/pages/keyconcepts/state/sequences.html)
- EnvSimBench/EnvScaler/AWM use executable Python as the ground-truth transition function, and rule- or code-based validators as reward. This is effectively "the spec is code". — [EnvSimBench](https://arxiv.org/html/2605.07247); [AWM](https://arxiv.org/html/2602.10090v2)

### Inferences
- A practical validation stack for generated worlds:
  1. OpenAPI/JSON Schema contract checks, using Prism proxy-style validation.
  2. Schemathesis fuzzing and stateful chaining for crash and 5xx discovery and schema conformance.
  3. Hypothesis `RuleBasedStateMachine` with domain invariants, for example "balance never negative" or "deleted entity never returned", run against the generated server.
  4. Optional differential testing against a real API or a trace corpus (Trace2Env-style replay validity) when a real counterpart exists.
- Statecharts such as XState [background, not re-verified: https://stately.ai/docs] and Gherkin/Cucumber scenarios [background: https://cucumber.io/docs/gherkin/] fit naturally as *task and world spec* formats. Statecharts express per-entity lifecycles (order: pending→paid→shipped). Gherkin Given/When/Then maps directly onto initial DB state → agent action → verifier assertion. I found no published work this session that uses them for LLM environment generation.
- Temporal workflows [background: https://docs.temporal.io] are durable-execution runtimes, not specification languages. They are relevant only if the world needs long-running, time-driven processes such as delayed shipments or scheduled jobs.

### Gaps
- I found no paper that applies Alloy, TLA+ or XState specifically to validate LLM-generated agent environments.
- I found no evaluation of Schemathesis or Hypothesis bug-finding rates on LLM-generated backends.
- The XState, Gherkin, Temporal and Alloy points come from background knowledge and were not fetched this session.
