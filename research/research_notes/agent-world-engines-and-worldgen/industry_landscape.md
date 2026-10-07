# Industry Landscape: Companies Building RL Environments / "Worlds" / Simulated Enterprise Software for AI Agents (as of Oct 2026)

Notes on sourcing: Several vendor facts come from **rl-list.com**, a third-party directory/aggregator (not primary). Those are marked **[aggregator, unverified]**. Funding and M&A facts reported only by secondary news aggregators are marked **[secondary]**. Anything I could not confirm at all is in Gaps.

---

## 1. Market size, lab spend, and investor commentary

### Takeaway
RL environments became a recognized, well-funded procurement category in 2025–2026: Anthropic reportedly discussed >$1B/yr on environments, contracts run six-to-seven figures per quarter, and consolidation began in 2026 (Mercor bought Deeptune and Sepal; Google did a >$1.5B talent/licensing deal with Mechanize). Skeptics (OpenAI's Sherwin Wu, Ross Taylor, some VCs) question vendor durability and gameability.

### Cited Findings
- Leaders at Anthropic discussed spending >$1B on RL environments over the next year (originally The Information; relayed by TechCrunch, Sept 2025) — [TechCrunch, Maxwell Zeff, 2025-09-16/21](https://techcrunch.com/2025/09/21/silicon-valley-bets-big-on-environments-to-train-ai-agents/). Primary Information article not accessed (paywalled).
- TechCrunch: Mechanize offering SWEs $500k to build environments, "few robust environments rather than many simple ones," reportedly working with Anthropic (two sources; both declined comment). Surge (~$1.2B 2024 revenue) created a new internal RL-environments org; Mercor ($10B valuation, $450M run rate) CEO Brendan Foody: "few understand how large the opportunity around RL environments truly is." Scale's Head of Product for Agents & RL: Chetan Rane. a16z's Jennifer Li: all major labs build environments in-house but also seek third-party vendors — [TechCrunch](https://techcrunch.com/2025/09/21/silicon-valley-bets-big-on-environments-to-train-ai-agents/)
- Skeptics in the same piece: OpenAI's Sherwin Wu is "short" RL-environment startups (too competitive, research moves too fast); Ross Taylor (General Reasoning): "people are underestimating how difficult it is to scale environments… even the best publicly available [environments] typically don't work without serious modification"; Karpathy is bullish on environments, bearish on RL itself — [TechCrunch](https://techcrunch.com/2025/09/21/silicon-valley-bets-big-on-environments-to-train-ai-agents/)
- Epoch AI FAQ (Jan 12, 2026; Denain & Barber; 18 interviewees): tasks typically **$200–$2,000 each**, complex SWE tasks up to **$20,000**; exclusive deals ~4–5x non-exclusive; **website replicas ("UI gyms") ~$20k each; complex product replicas (e.g., Slack clone) ~$300k**; contracts six–seven figures/quarter; benchmarking demand ~10–20x less than RL demand; enterprise workflows (expense reports, pivot tables, CRM navigation, slides) named as the major growth area; in-house builders include Anthropic, xAI, Cursor; product partnerships (Benchling–Anthropic; OpenAI–Shopify/Stripe) — [Epoch AI](https://epoch.ai/gradient-updates/state-of-rl-envs)
- "July 2026 tally": >50 companies selling data and RL environments to labs, ~$8.5B combined annual revenue, ~$100B combined valuation, >75% concentrated in Scale, Surge, Mercor, Handshake — [Yahoo Finance (search snippet; original source of tally not confirmed)](https://finance.yahoo.com/news/silicon-valley-bets-big-environments-190048029.html) **[unverified — snippet only]**
- rl-list.com tracks 42 RL-environment vendors (27 commercial, 3 open source, 6 incumbents, 6 infra); 33 HQ'd in SF Bay Area; median funding $10–50M — [rl-list.com](https://www.rl-list.com/) **[aggregator]**
- Mercor acquired Deeptune (announced ~July 9, 2026), an a16z-backed startup building Excel/Salesforce/Slack replica environments; Foody was an angel in Deeptune's $43M Series A (a16z-led, March 2026) three months earlier and told Fortune the acquisition was "in a lot of ways the main motivation" for investing; Mercor at ~$2B annualized revenue — [AI Weekly](https://aiweekly.co/alerts/mercor-buys-deeptune-in-its-first-major-acquisition-a16z-backed-rl-environments); [Staffing Industry Analysts](https://www.staffingindustry.com/editorial/it-staffing-report/mercor-to-acquire-deeptune-creator-of-environments-for-reinforcement-learning); [Futurum](https://futurumgroup.com/insights/mercor-bets-on-real-world-ai-training-will-environments-decide-the-next-ai-leaders/) **[secondary]**. Mercor also acquired Sepal AI (Feb 2026) — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**
- Google deal with Mechanize reported at >$1.5B (Sept 2026): co-founder/CEO Tamay Besiroglu joined DeepMind as research scientist with a dozen+ employees (many on "midtraining"); Mechanize **not acquired outright** — continues with former chief of staff Guive Assadi as CEO; terms undisclosed — [NewsBytes](https://www.newsbytesapp.com/news/business/google-acquires-ai-start-up-mechanize-for-1-5b/story); [AI Weekly (FR)](https://aiweekly.co/fr/alerts/google-boucle-le-deal-de-talents-mechanize-plus-de-15-md-une-douzaine) **[secondary; framing conflicts: "acquired" vs "talent deal"]**
- Mercor's Foody (Sequoia "Own Your Intelligence" talk/podcast): environments = **worlds** (realistic documents/data rooms) + **high-fidelity app clones** (Salesforce, ServiceNow, Microsoft 365) + **tasks with verification**; experts outline, models help populate data rooms; rubrics need humans because "models cannot reliably identify their own mistakes"; QA by trajectory review against human judgment; pricing per task **$50–$10,000**, frontier labs buying ~**50,000 tasks/month**; also off-the-shelf datasets and hourly expert staffing; "Only humans can measure the frontier in most domains." — [Sequoia podcast](https://sequoiacap.com/podcast/how-rl-environments-are-built-and-why-they-re-your-ai-moat) (page dated Oct 6, 2026 by fetch tool; date not independently confirmed)
- Prime Intellect: Environments Hub ("Hugging Face/GitHub for RL environments"), 2,500+ environments, $150M raised, $100M+ ARR per rl-list — [Sequoia podcast w/ Will Brown & Johannes Hagemann](https://sequoiacap.com/podcast/building-the-github-for-rl-environments-prime-intellects-will-brown-johannes-hagemann); [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator for figures]**
- VC skeptic view: Brian Zhan (listed as partner at Striker Venture Partners) ICML 2026 invited talk "The RL Environment Land Grab": against simulator environments built on human feedback — "humans form opinions, not measurements, and environments they create are gameable by construction"; favors real-world-verified rewards (Periodic Labs, Skild) — [ICML 2026](https://icml.cc/virtual/2026/78363)
- YC: multiple env startups — Halluminate (S25), HUD (W25), Datacurve (W24), Idler (S25), Bellman AI, Cua (X25) — [Pinggy YC 2026 breakdown](https://pinggy.io/amp/blog/what_yc_is_funding_in_2026/); [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**

### Inferences
- The market is bifurcating: (a) expert-labor incumbents (Scale, Surge, Mercor, Turing, Snorkel, micro1, Handshake) bolting on environments, buying startups (Deeptune, Sepal); (b) pure-play env builders (Fleet, Halluminate, Plato, Matrices, Veris, Collinear, Bespoke, HUD) competing on fidelity; (c) labs absorbing talent directly (Google–Mechanize). The acquisitions suggest labs/incumbents value replica-building teams more than any standalone env catalog.
- The $20k (website) vs $300k (Slack-class product) price gap implies large margin pressure for anyone who can cheaply automate replica construction.

### Gaps
- Original The Information article (Anthropic $1B) not accessed; OpenAI-specific environment-spend figures not found.
- No a16z long-form thesis post on RL environments located; a16z's view is via Jennifer Li quote and the Deeptune lead.
- No official YC "Request for Startups" item specifically naming RL environments was found.

---

## 2. Company-by-company: approach, fidelity, graders, business signals

### Takeaway
Nearly all commercial vendors describe **hand-built or expert-built** high-fidelity replicas (Salesforce, Slack, Excel, Jira, Zendesk, Gmail, Airbnb-likes) packaged as Docker/state-resettable sandboxes with programmatic state checks plus expert rubrics. Generative/auto-scaling claims come mainly from Patronus (Generative Simulators), Collinear (simulated NPC users), Veris (mocked SaaS + simulated users), and Halluminate (procedurally generated data inside hand-built apps).

### Cited Findings

**Mechanize** (SF; founded 2025 by Tamay Besiroglu, Matthew Barnett, Ege Erdil)
- Mission "full automation of the economy"; builds RL environments simulating real work, first target software engineering (refactoring, debugging, feature-building) graded for reward — [Mechanize announcement](https://www.mechanize.work/announcing-mechanize-inc/); [mechanize.work](https://mechanize.work)
- Raised ~$9M angel round April 2025 — [search summary citing TechCrunch/Bespoke coverage](https://techcrunch.com/2025/09/16/silicon-valley-bets-big-on-environments-to-train-ai-agents/) **[unverified exact figure]**; Google talent deal Sept 2026 (see §1).

**Matrices** — computer-use/browser env vendor; $5M raised, founded 2023, backed by AI Grant & Index — [rl-list](https://www.rl-list.com/) **[aggregator, unverified]**. No technical writeup found.

**Scale AI** — "Scale RL Environments": simulated high-fidelity systems, "realistic data universes" + structured trajectories + **process-level verification**; inspect simulated apps, run via Docker; GA product; dedicated Agents Data & RL Environments team, including healthcare-software replicas — [Scale blog: RL environments](https://scale.com/blog/rl-environments); [Scale job post](https://jobs.accel.com/companies/scale-ai/jobs/84436763-senior-ai-product-manager-healthcare-agents). Lost Google/OpenAI as data customers after Meta's $14B investment — [TechCrunch](https://techcrunch.com/2025/09/21/silicon-valley-bets-big-on-environments-to-train-ai-agents/). Benchmarks: SWE-Bench Pro, MCP Atlas (via SEAL) — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**

**Surge AI** — bootstrapped; ~$1.2B 2024 revenue; new RL environments org (2025) — [TechCrunch](https://techcrunch.com/2025/09/21/silicon-valley-bets-big-on-environments-to-train-ai-agents/); hiring "RL Environments Architect" — [Built In job post](https://www.builtinboston.com/job/rl-environments-architect/11178982); in-house benchmarks (DAYJOB, GDP.pdf, Chartography) — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**

**Mercor** — expert marketplace; APEX benchmarks; acquired Sepal (Feb 2026) and Deeptune (July 2026) to get enterprise-app gyms; per-task pricing $50–$10k — see §1 sources.

**Deeptune** — a16z-led $43M Series A (Mar 2026); managed RL "training gyms" for computer-use and code; Excel/Salesforce/Slack replicas; now part of Mercor — [AI Weekly](https://aiweekly.co/alerts/mercor-buys-deeptune-in-its-first-major-acquisition-a16z-backed-rl-environments) **[secondary]**

**Turing** — "UI clones" = interactive replicas of enterprise/consumer apps (Jira, Salesforce, Zendesk); backend MCP environments with APIs, SME-built policies, schemas, realistic seed data; each env a **Docker container with APIs for task retrieval, reset, and verifier-based scoring** — [Turing RL environments](https://www.turing.com/frontier-ai/rl-environments); [Turing RL gyms](https://turing.com/advance/rl-gyms); [agentic.turing.com](https://agentic.turing.com/)

**Halluminate** (YC S25; Jerry Wu CEO, Wyatt Marshall CTO) — "Westworld": fully simulated internet of synthetic consumer/enterprise apps (Salesforce-, Slack-, ticketing-, storefront-, booking-shaped); **procedurally generated data**, deterministic, offline, resettable; Yutori agent scored 86.0% on 100 Westworld tasks — [Starlog](https://starlog.is/articles/developer-tools/halluminate-westworld); [Launch HN](https://hn.svelte.dev/item/44865290). Now focused on financial services knowledge work (Westworld Finance Diligence Bench); claims work with 4 of 5 leading closed US labs and mid-eight-figure revenue run rate; Series A led by Oak HC/FT, Oct 2026 — [rl-list](https://www.rl-list.com/rl-environments-for-computer-use) **[aggregator; funding conflicts: $30M Series A (search snippet) vs $38.5M total (rl-list)]**

**Habitat Inc** — very early; RL environments for code and computer use with "programmatically verifiable problems"; possible repositioning toward "autonomous firms" — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator, minimal public info]**; site [habitat.inc](https://habitat.inc)

**Plato** (founded 2025; CTO Pranav Putta, ex-MultiOn) — simulated worlds for browser/computer-use agents: Amazon/Airbnb/Gmail-style replicas with structured APIs, state tracking, scoring; full Linux desktop — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**; [plato.so](https://plato.so) (site did not render for fetch).

**Veris AI** — emerged from stealth June 2025 with $8.5M seed (Decibel, Acrew); "high-fidelity simulated experiences" to train/test agents — [BusinessWire](https://www.businesswire.com/news/home/20250603868539/en/Veris-AI-Emerges-from-Stealth-with-$8.5M-to-Train-AI-Agents-Using-Simulated-Experience-Removing-Roadblocks-to-Enterprise-Adoption). Mocked SaaS tools + seeded databases + simulated users; voice-agent benchmarks (VAmoS); self-serve tier "Veris Plus" — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**

**Collinear AI** — "Simulation Lab": sandboxed stateful enterprise environments with enterprise APIs, LLM-powered simulated coworkers/users ("NPCs") that push back and change minds, tasks with ambiguity, and verifiers — [AWS case study](https://aws.amazon.com/solutions/case-studies/collinear-sagemaker/); [Together AI blog](https://together.ai/blog/collinear-simulations-together-evals). TraitMix/TraitBasis = controllable persona traits for simulated users — [Together AI](https://together.ai/blog/collinear-simulations-together-evals); [NeurIPS 2025](https://neurips.cc/virtual/2025/132588). $10M raised — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**

**Fleet AI** (2024; $15M; Sequoia, Menlo, SV Angel) — "training gyms for agents"; Salesforce replica "where every dropdown is faithful, every quirk is preserved"; Python SDK, platform API, open-source Harbor tooling; human supervision — [Sacra](https://sacra.com/c/fleet); [rl-list](https://www.rl-list.com/vendors/fleet-ai) **[aggregator]**

**Bespoke Labs** (ex-DeepMind/Berkeley) — $40M (Wing VC, 8VC; angels from Anthropic, OpenAI, Meta); environments that resemble real companies: large codebases, microservices, realistic logs, tickets, email, Slack, for long-horizon work — [The Next Web](https://thenextweb.com/news/bespoke-labs-40m-ai-agent-training-environments); [Pulse 2.0](https://pulse2.com/bespoke-labs-raises-40-million-to-build-reliable-ai-agent-training-environments/)

**Kaizen** — described only as building RL environments letting AI "train from its own experience" — search snippet, no primary source found **[unverified]**.

**Applied Compute** — not an env vendor per se: trains proprietary agents on enterprise data (in-company RL). $80M at $1.3B (Kleiner Perkins lead), $160M total; talks at ~$3B led by Elad Gil — [KuCoin news](https://kucoin.com/news/flash/applied-compute-completes-80m-funding-round-valued-at-1-3b); [AI Weekly](https://aiweekly.co/alerts/applied-compute-in-talks-for-3b-round-led-by-elad-gil) **[secondary]**

**Patronus AI — Generative Simulators** (Dec 2025): environments that **jointly co-generate tasks, world dynamics (toolsets), and reward functions** from minimal specification; multi-agent pipeline (task generator → tool selection scaled to complexity → curriculum filter → agent rollouts → co-generated rewards); difficulty adjustable per component to avoid saturation, reward hacking, contamination; can swap toolsets (e.g., add browser tools to SWE-Bench tasks); claims 15x revenue growth — [Patronus blog](https://patronus.ai/blog/introducing-generative-simulators); [paper PDF](https://cdn.patronus.ai/Generative_Simulators.pdf); [SiliconANGLE](https://siliconangle.com/2025/12/17/patronus-ais-debuts-generative-simulators-support-continuous-evolution-improvement-ai-agents); [VentureBeat](https://venturebeat.com/technology/ai-agents-fail-63-of-the-time-on-complex-tasks-patronus-ai-says-its-new)

**Sierra — τ-bench / τ²-bench**: tool-agent-user benchmark; LLM-simulated user + domain API tools + policy docs; airline & retail (τ²-bench adds telecom, "dual control"); grading compares **final database state to expected state** — [Sierra blog](https://sierra.ai/blog/benchmarking-ai-agents); [GitHub](https://github.com/sierra-research/tau-bench); [τ²-bench arXiv 2506.07982](https://www.opentrain.ai/papers/2-bench-evaluating-conversational-agents-in-a-dual-control-environment--arxiv-2506.07982/)

**Salesforce AI Research — CRMArena / CRMArena-Pro / eVerse**: CRMArena-Pro = synthetic-data simulated enterprise (multi-turn, multi-agent; sales forecasting, case triage, CPQ) — [Salesforce news](https://www.salesforce.com/news/stories/ai-research-advances-enterprise-agentic-readiness/); [heise](https://heise.de/-10622706). eVerse = enterprise simulation for voice/text agents in three phases: Synthesize (via CRMArena-Pro) → Measure (stress-test) → Train (RLHF from domain experts); claimed task success 19%→88%; used for Agentforce Voice, piloted at UCSF Health — [SalesforceBen](https://www.salesforceben.com/salesforce-launches-everse-an-agent-simulation-platform-for-text-and-voice/); [SalesforceDevops](https://new.salesforcedevops.net/posts/salesforce-ai-research-unveils-everse-enterprise-simulation-framework-for-agent-training)

**AGI Inc — REAL Bench**: "mini-Internet" of 11 deterministic replica sites (Omnizon/Amazon, DashDish/DoorDash, FlyUnified, Staynb/Airbnb, GoCalendar, GoMail, OpenDining, NetworkIn, Udriver, TopWork, Zilloft), 112 tasks, React+Next.js with mock data, public leaderboard, open AGI SDK — [AGI Inc blog](https://www.theagi.company/blog/introducing-real-bench); [agisdk GitHub](https://github.com/agi-inc/agisdk)

**Others noted**: AfterQuery ($30.5M; reported raising at $3.2B per Forbes, Sept 2026), HUD ($16M A; MIT SDK + DataVendor marketplace), Datacurve, Proximal, Huzzle Labs, Idler (ShelfLife e-commerce digital twin), BenchFlow, micro1 (Realm gyms), Snorkel — [rl-list](https://www.rl-list.com/rl-environments-for-computer-use) **[aggregator]**. Sandbox infra: Modal, Daytona, E2B, Runloop, Cua.

### Inferences
- "Fidelity" is the main marketing axis (Fleet's "every quirk preserved"; Turing "UI clones"); generation is used mostly for **data/content inside** replicas (Halluminate procedural data; Mercor models populating data rooms), not for the app itself.
- Grading converges on a hybrid: deterministic end-state DB checks (τ-bench style; Turing verifier APIs) + expert rubrics for open-ended outputs (Mercor, Surge, AfterQuery).

### Gaps
- No public per-environment price lists from any vendor; pricing only via Epoch/Mercor talk.
- Matrices, Plato, Kaizen, Habitat: no primary technical writeups found.
- Scale SEAL-specific environment details not fetched beyond blog summary.

---

## 3. Does anyone ship an automated "description → world" generator? Is there a "WorldGen" company?

### Takeaway
No commercial vendor was found publicly shipping a general "natural-language description → stateful replica of enterprise software" product. The closest commercial offering is Patronus Generative Simulators (co-generating tasks/tools/rewards, not full app replicas). The closest technical demonstrations are academic/open source: Snowflake's Agent World Model (1,000 generated code+DB environments), ClawEnvKit, and Forge. I found **no company matching "we test AI agents against worlds: stateful replicas of real software… WorldGen"**; "WorldGen" search results point to Meta's 3D world generator.

### Cited Findings
- Snowflake Labs + UCSD **Agent World Model (AWM)**: fully synthetic pipeline scaling to 1,000 environments; each a generated Python file (FastAPI + SQLAlchemy + MCP), ~2,000 LOC, ~35 tools; code+database-backed (more reliable state than LLM-simulated environments); 1,024 parallel instances per training step; OOD generalization on 3 benchmarks; ICML 2026 — [arXiv 2602.10090](https://arxiv.org/html/2602.10090v2); [Snowflake blog](https://www.snowflake.com/en/blog/engineering/agent-world-model-for-agentic-reinforment-learning/); [GitHub](https://github.com/Snowflake-Labs/agent-world-model)
- **ClawEnvKit**: NL spec → parser into typed intent units (actions, objects, constraints) → verified environments; 1,040 environments for ~$80 API cost with claude-sonnet-4.6 — [arXiv 2604.18543](https://arxiv.org/pdf/2604.18543)
- **Forge** (open source): Gmail-/Slack-like apps, and "custom LLM-generated FastAPI apps" simulating any business app "from a plain-English description" — [GitHub](https://github.com/mostofashakib/Forge)
- **Agent-World** (Apr 2026): scalable real-world environment synthesis + self-evolving training — [arXiv 2604.18292](https://arxiv.org/html/2604.18292v1)
- **Trace2Env / Agentic Language World Models** (Oct 2026): reconstruct traces into an environment "worldbook" (schemas, evidence, behavior) consulted by an LLM world-model agent for stateful simulation — [arXiv 2610.06100](https://arxiv.org/abs/2610.06100)
- Patronus Generative Simulators generates tasks, toolsets and rewards "with minimal specification" — [Patronus](https://patronus.ai/blog/introducing-generative-simulators)
- "WorldGen" searches surface Meta Reality Labs' text-to-3D world system, not an agent-env company — [Meta blog](https://www.meta.com/blog/worldgen-3d-world-generation-reality-labs-generative-ai-research/)
- rl-list's own summary: "Most ranked vendors use hand-built or expert-generated environments" — [rl-list](https://www.rl-list.com/rl-environments-for-enterprise) **[aggregator]**
- Epoch interviewee: "a large amount of useless bad environments" from hastily coded website clones — [Epoch AI](https://epoch.ai/gradient-updates/state-of-rl-envs)

### Inferences
- Whitespace: a commercial product that turns a description/spec of a SaaS app into a code+DB-backed, resettable, graded replica (AWM-style) with fidelity QA does not appear to be publicly marketed. Incumbent counter-argument (Foody, Zhan, Epoch) is that quality control and graders — not app code — are the bottleneck, so a generator must ship verifiers/anti-reward-hacking checks to be credible.
- The described "WorldGen" job post/landing may be stealth or very new; it is not indexed.

### Gaps
- Could not identify the company behind the "worlds: stateful replicas of real software… WorldGen" wording; may be stealth/unindexed.
- Unknown whether Fleet, Plato, Deeptune, or Turing use LLM codegen internally to build replicas (plausible, not stated publicly).

---

## 4. Notable writeups on what makes a good RL environment

### Takeaway
Consensus criteria: resistance to reward hacking, verifiable/state-based graders, calibrated difficulty (non-zero pass rate), diversity/compositionality, and reproducibility (deterministic, resettable). Anthropic showed reward hacking in production environments can generalize into broad misalignment, raising the stakes for grader quality.

### Cited Findings
- Epoch: "reward hacking is a big issue," needing "many many iterations"; target minimum pass rate ~2–3% (≥1 success per 64–128 attempts) and a smooth difficulty gradient; tasks should leverage common skills; scaling without quality loss is the "number one bottleneck"; "finding the experts isn't that hard, but managing them and doing quality control is hard" — [Epoch AI](https://epoch.ai/gradient-updates/state-of-rl-envs)
- Anthropic/Redwood (Nov 2025): models that learn to reward hack in **real Anthropic production coding environments** generalized to alignment faking, sabotage (incl. in Claude Code), cooperation with malicious actors; mitigations: prevent hacking, diversify RLHF safety training, "inoculation prompting" — [arXiv 2511.18397](https://arxiv.org/abs/2511.18397)
- Patronus: static benchmarks/environments are "susceptible to reward-hacking, contamination, leakage, and saturation" → argument for generative, adaptive environments — [Patronus](https://patronus.ai/blog/introducing-generative-simulators)
- Ross Taylor on gameability and difficulty of scaling — [TechCrunch](https://techcrunch.com/2025/09/21/silicon-valley-bets-big-on-environments-to-train-ai-agents/); Brian Zhan: human-built simulators "gameable by construction" — [ICML 2026](https://icml.cc/virtual/2026/78363)
- τ-bench: grade by final DB state vs. goal state, plus pass^k reliability across repeated trials — [Sierra](https://sierra.ai/blog/benchmarking-ai-agents)
- Six components of an RL env: task prompt, initial state/setup, substrate, configuration, reward/verifier, agent harness — [RL Envs 101 (GitHub)](https://github.com/adithya-s-k/RL_Envs_101) (via search snippet)
- Buyer checklists from vendors: [Invisible Tech](https://invisibletech.ai/blog/rl-environments-enterprise-workflows-buyers-checklist); [Prolific 2026 guide](https://www.prolific.com/resources/rl-environments-for-agentic-ai-the-2026-guide-to-building-and-deploying-enterprise-rl-environments) (not fetched; vendor marketing)

### Inferences
- A generated-world product's differentiator would need to be grader robustness (adversarial red-teaming of verifiers) and difficulty calibration, not only app fidelity.

### Gaps
- Did not locate a Surge-authored primary blog on environment quality; OpenAI has no comparable public post found in this pass.
