# Web / OS / Computer-Use Agent Environments: Hosting, Reset, Grading, and Browser Automation Harnesses

Scope: infrastructure lessons (containerization, reset cost, evaluator functions, state probes) from WebArena, VisualWebArena, WebArena-Verified, OSWorld / OSWorld-Verified, AgentBench, WebShop, Mind2Web-Live, BrowserGym, REAL, WebGym / synthetic websites, SaaS clones for RL, and browser-use. Current as of Oct 2026.

Note on sourcing: items marked "(paper abstract / known design)" come from the primary arXiv paper for that benchmark. I did not re-fetch those pages in this session; the report writer may want to spot-check exact numbers.

---

## Q1. How does each environment evaluate success (programmatic DB/URL/DOM state check vs LLM judge)? Known evaluator bugs and false-positive/false-negative rates

### Takeaway
Most "hosted-world" benchmarks (WebArena, OSWorld, REAL, WebShop) grade with programmatic state probes: getter functions that read DB, URL, DOM, or file state, followed by a metric function. All of them have turned out to contain a material share of broken or mis-specified evaluators. Audits find roughly 10-22% evaluator error. Benchmarks on live websites (Mind2Web-Live, WebGym, InSTA, the browser-use benchmark) cannot probe backend state, so they use key-node/URL matching or rubric-based LLM judges instead. That makes them cheaper to scale but noisier. The direction of the field is "Verified" re-releases that tighten comparators and audit every task.

### Cited Findings

**WebArena (original)**
- 812 tasks across self-hosted replicas of e-commerce (OneStopShop/Magento), a CMS admin, Reddit (Postmill), GitLab, a map (OpenStreetMap) and a wiki. Evaluators are `exact_match`, `must_include`, `fuzzy_match` (an LLM judge) for information-seeking answers, plus `url_match` and `program_html` (DOM/state probes run after the episode) for state-changing tasks. The original GPT-4 agent scored about 14% against about 78% for humans (paper abstract / known design). — [WebArena, arXiv 2307.13854](https://arxiv.org/abs/2307.13854)
- Known evaluator errors. In Reddit task 584 the evaluator opens the wrong page. In shopping task 261 `url_match` accepts only one URL and misses the same page reached by a different URL. Custom evaluators also passed some tasks despite formatting errors and agent hallucinations, which only full HAR-trace inspection caught (false positives). — [AgentOccam, arXiv 2410.13825](https://arxiv.org/pdf/2410.13825); [Self-Grounded Verification, arXiv 2507.11662](https://arxiv.org/pdf/2507.11662) (aggregated in search snippets)
- WebArena's answer matching rejects acceptable behavior at a 21.7% false-negative rate. — [search snippet citing WebArena Verified / related audit, via NeurIPS 2025 listing](https://neurips.cc/virtual/2025/loc/san-diego/124576) (exact originating paper not confirmed)

**WebArena-Verified (ServiceNow, NeurIPS 2025)**
- Audits all 812 tasks and manually reviews "every task, reference answer, and evaluator". It repairs misaligned evaluations and clarifies ambiguous instructions. It replaces substring matching and LLM-as-judge with "type-aware normalization and structural comparison". — [GitHub ServiceNow/webarena-verified](https://github.com/ServiceNow/webarena-verified); [NeurIPS 2025 page](https://neurips.cc/virtual/2025/loc/san-diego/124576)
- Supports offline evaluation by replaying network traces (HAR files). The grader inspects recorded HTTP traffic rather than live state, so scoring can be decoupled from the running environment. — [GitHub](https://github.com/ServiceNow/webarena-verified)
- Reports roughly 11% fewer false negatives than the original. Ships "WebArena Verified Hard", a 258-task subset for cheaper evaluation. — [NeurIPS 2025 listing](https://neurips.cc/virtual/2025/loc/san-diego/124576); [GitHub](https://github.com/ServiceNow/webarena-verified)
- Docs: [servicenow.github.io/webarena-verified](https://servicenow.github.io/webarena-verified/). Dataset: [HF AmineHA/WebArena-Verified](https://huggingface.co/datasets/AmineHA/WebArena-Verified)

**VisualWebArena**
- 910 visually grounded tasks over Classifieds, Shopping and Reddit. Evaluators add visual checks on top of WebArena's (VQA-style LLM/VLM queries on the final page and image-similarity comparisons such as SSIM) (paper abstract / known design). — [VisualWebArena, arXiv 2401.13649](https://arxiv.org/abs/2401.13649)

**OSWorld / OSWorld-Verified**
- OSWorld: 369 real-computer tasks in full Ubuntu (plus some Windows) VMs. Each task has a setup config, a "getter" that pulls state (files, app config, accessibility tree, VM command output), and a "metric" function that compares it. The paper reports 134 distinct evaluation functions (paper abstract / known design). — [OSWorld, arXiv 2404.07972](https://arxiv.org/abs/2404.07972)
- OSWorld-Verified (28 July 2025) addressed "300+ pieces of feedback". The problem categories were web-structure changes, anti-crawling, ambiguous instructions, timing-sensitive dependencies, and fragile evaluation functions. Fixes include fuzzy document matching, perceptual hashing for images, spreadsheet and color tolerances, and some 0-1 graded scoring instead of pure binary. At the time the leader was CoACT-1 at 60.76%, against an estimated 72% human baseline. — [xlang.ai blog: OSWorld-Verified](https://xlang.ai/blog/osworld-verified)
- Lesson: tasks that touch live web content (Chrome tasks) decay as sites change, so OS-level benchmarks inherit web non-stationarity. — [xlang.ai blog](https://xlang.ai/blog/osworld-verified)

**Cross-benchmark audits**
- **ABC: Agentic Benchmark Checklist** (Zhu et al., NeurIPS 2025 D&B, arXiv 2507.02825). Many agentic benchmarks have flaws in task setup or reward design. Examples are SWE-bench-Verified's insufficient tests and τ-bench counting empty responses as successes. Such flaws can mis-estimate performance by up to 100% in relative terms. Applying ABC to CVE-Bench cut performance overestimation by 33%. — [arXiv 2507.02825](https://arxiv.org/abs/2507.02825); [NeurIPS proceedings](https://proceedings.neurips.cc/paper_files/paper/2025/hash/f316275b44ee2de533102913828a8107-Abstract-Datasets_and_Benchmarks_Track.html)
- **"How Benchmarks Mis-Score Computer-Use Agents"** (Dong et al., 30 July 2026). Audited 150 FAIL-scored public trajectories across five web, enterprise-workflow and desktop benchmarks. 15.3% of FAIL verdicts were wrong: 10.7% were evaluator false negatives and 4.7% were broken tasks. The four failure points are stale tasks, trajectories that omit visual evidence, evaluators that reject valid alternatives, and aggregate scores that hide where failures come from. — [arXiv 2607.28367](https://arxiv.org/abs/2607.28367)

**REAL (AGI Inc / "The AGI Company")**
- Deterministic, high-fidelity replicas of 11 sites: Omnizon (Amazon), DashDish (DoorDash), FlyUnified (United), Staynb (Airbnb), GoCalendar, GoMail, OpenDining (OpenTable), NetworkIn (LinkedIn), Udriver (Uber), TopWork (Upwork) and Zilloft (Zillow). There are 112 tasks. — [REAL, arXiv 2504.11543](https://arxiv.org/abs/2504.11543); [AGI blog](https://www.theagi.company/blog/introducing-real-bench)
- Hybrid grading. Programmatic checks of website state handle action tasks. Rubric-guided LLM judgments handle information-retrieval tasks. Episodes end with a state submission to a `/finish` endpoint on the clone. — [arXiv 2504.11543](https://arxiv.org/pdf/2504.11543v1)
- Tooling: [agi-inc/agisdk](https://github.com/agi-inc/agisdk) ([PyPI](https://pypi.org/project/agisdk)); [agi-inc/REAL](https://github.com/agi-inc/REAL)

**AgentBench**
- Eight environments: OS shell, database (SQL), knowledge graph, digital card game, lateral thinking puzzles, house-holding (ALFWorld), web shopping (WebShop) and web browsing (Mind2Web). The OS and DB environments run in Docker containers and are graded by checking command output or answers. Each environment is a separate server behind a common task/worker API (paper abstract / known design). — [AgentBench, arXiv 2308.03688](https://arxiv.org/abs/2308.03688); [GitHub THUDM/AgentBench](https://github.com/THUDM/AgentBench)

**WebShop**
- A simulated e-commerce site with about 1.18M scraped products and about 12k crowd-sourced instructions. Reward is computed programmatically from how well the purchased product's attributes, options, type and price match the target. This dense, state-based reward made WebShop an early RL-friendly web environment (paper abstract / known design). — [WebShop, arXiv 2207.01206](https://arxiv.org/abs/2207.01206)

**Mind2Web-Live / WebCanvas**
- Runs on live websites with 542 tasks and 2,439 annotated intermediate "key node" states. Success means hitting the key nodes, checked by URL, element-path or value matches, while ignoring noise from changed page elements. Best agent: 23.1% task success and 48.8% completion rate. — [WebCanvas, arXiv 2406.12373](https://arxiv.org/abs/2406.12373); [summary](https://powerdrill.ai/discover/discover-WebCanvas-Benchmarking-Web-clxmbhra05j530191jf2b6q9t)

**BrowserGym / AgentLab (ServiceNow)**
- A gym-style unified interface (observation = DOM/AXTree/screenshot, actions = a high-level action set over Playwright). It wraps MiniWoB++, WebArena, VisualWebArena, WorkArena, AssistantBench and WebLINX, and each task keeps its own validator. AgentLab adds parallel experiments and leaderboard reporting (paper abstract / known design). — [BrowserGym, arXiv 2412.05467](https://arxiv.org/abs/2412.05467); [AgentLab GitHub](https://github.com/ServiceNow/AgentLab)
- WorkArena runs on a real ServiceNow developer instance. Validators query the instance's backend records through its API, so the "clone" is the real SaaS product in a sandbox (paper abstract / known design). — [WorkArena, arXiv 2403.07718](https://arxiv.org/abs/2403.07718)

**LLM-judge-based environments**
- InSTA: an LLM judges trajectory success with 82.6% accuracy relative to human labels across 150k live sites. — [InSTA, arXiv 2502.06776](https://arxiv.org/abs/2502.06776)
- WebGym: about 300k tasks with rubric-based evaluation on real websites. — [WebGym, arXiv 2601.02439](https://arxiv.org/abs/2601.02439)
- browser-use benchmark: success is scored by an LLM "findings judge" using a weighted rubric with partial credit, given the trajectory, deliverables and per-action screenshots. — [browser-use/benchmark](https://github.com/browser-use/benchmark)

### Inferences
- There are three grading regimes:
  - Backend state probes (DB, files, app config) are the most reliable but need white-box access to the world.
  - URL/DOM/key-node matching is cheap, but it is brittle to equivalent paths. This is WebArena's `url_match` failure.
  - LLM/VLM rubric judges are scalable but carry roughly 15-20% error (InSTA 82.6% judge accuracy).
- A world engine that owns its state can expose a canonical state API and grade with structural diffs. That avoids the main failure modes documented by WebArena-Verified and the July 2026 mis-scoring audit.
- Reported evaluator error (10-22%) is the same size as the gaps between leading agents. Grader quality is therefore a first-order concern for any RL-environment product, consistent with Epoch's point that reward-hacking robustness is the top quality criterion (see Q3).

### Gaps
- I could not confirm the exact paper behind the "21.7% false negatives" figure. It appeared in search snippets near WebArena-Verified material.
- I found no published false-positive rate specific to OSWorld-Verified, and no precise count of how many WebArena-Verified tasks were changed. The GitHub page says only "every task" was reviewed.

---

## Q2. Reset/snapshot cost; lightweight replicas (SQLite, in-memory, localStorage) vs full Docker apps

### Takeaway
Full-stack Docker replicas (WebArena, VWA) and full VMs (OSWorld) are heavy: GBs of storage, about a minute to start, and resets that often mean restarting containers. Reset cost is the main bottleneck for RL rollouts. Mitigations are smaller images (WebArena-Verified, up to 92% smaller), copy-on-write containers (WebServ, about 5x faster launch, about 240x less storage, 200+ environments per host), cloud fan-out (OSWorld-Verified on AWS, 50x parallel), and very light client-side clones (REAL keeps state in browser localStorage, so reset is effectively free).

### Cited Findings
- A single WebArena shopping container needs about 6 GB of storage and about 1 minute to start. The paper notes that server-side Docker setups are too resource-intensive for massive parallel rollouts. — [WebServ, arXiv 2510.16252](https://arxiv.org/abs/2510.16252); [NeurIPS 2025 workshop page](https://neurips.cc/virtual/2025/128012)
- WebServ uses Incus containers with block-level copy-on-write. This gives about 5x lower launch latency, about 240x lower storage, and 200+ concurrent isolated environments on one host. — [arXiv 2510.16252](https://arxiv.org/abs/2510.16252)
- The WebArena README tells users to reset the environment to its initial state after a full evaluation run. State-changing tasks therefore contaminate later tasks unless sites are reset in between (README guidance / known design). — [web-arena-x/webarena](https://github.com/web-arena-x/webarena)
- WebArena-Verified ships Docker images "up to 92% smaller than originals", auto-login headers, and a consolidated Map container. — [ServiceNow/webarena-verified](https://github.com/ServiceNow/webarena-verified)
- OSWorld-Verified moved from local VMware/Docker to AWS for 50x parallelization, cutting full evaluation from "10+ hours to minutes". It halved VM image size from 50 GB to 25 GB, tuned IOPS for lazy loading, and moved task files from Google Drive to Hugging Face for reliable distribution. — [xlang.ai blog](https://xlang.ai/blog/osworld-verified)
- REAL clones are static web apps hosted on Vercel (for example `evals-omnizon.vercel.app`, `evals-staynb.vercel.app`). Application state lives in browser localStorage with a deterministic reset, so clearing the browser context resets the world and no backend container is needed. — [REAL, arXiv 2504.11543](https://arxiv.org/pdf/2504.11543v1)
- WebGym adds a high-throughput asynchronous rollout system with a 4-5x rollout speedup over naive implementations. Because it runs on real websites, there is no reset of server state. — [WebGym, arXiv 2601.02439](https://arxiv.org/abs/2601.02439)
- Weblica combines HTTP-level caching of real websites with LLM-synthesized interactive environments to avoid live-web instability. It reserves 2,560 web environments with 44,227 tasks for training. — [Weblica, arXiv 2605.06761](https://arxiv.org/abs/2605.06761)
- The "Verified Synthetic Web Environments" paper uses event-driven simulation: most steps are navigation, and persistent backend writes happen only at marker-triggered events. This keeps state small and deterministic. — [arXiv 2608.21898](https://arxiv.org/html/2608.21898)
- Epoch frames the trade-off as clones being "cheap and stable" while wrapped real apps in a sandbox give better transfer. — [Epoch AI, "An FAQ on RL Environments" (Jan 2026)](https://epoch.ai/gradient-updates/state-of-rl-envs); framing also in [Medium playbook](https://medium.com/@abhilashagulhane111/the-rl-environment-playbook-worlds-curriculum-vendors-and-product-kpis-e6dbdaf7afd6)
- AgentLab/BrowserGym added parallel experiment support across WebArena and VisualWebArena. — [ServiceNow/AgentLab](https://github.com/ServiceNow/AgentLab)

### Inferences
- There is a clear cost ladder, from most to least expensive:
  1. Full VM (OSWorld, about 25 GB image, cloud fan-out).
  2. Multi-service Docker app (WebArena; GB-scale per site, minute-scale start, real DB such as MySQL).
  3. Copy-on-write snapshotted containers (WebServ).
  4. Single-process app with SQLite or in-memory state (reset by copying the file or re-seeding).
  5. Client-only SPA with localStorage (REAL; reset by clearing storage).
  RL throughput improves by orders of magnitude moving down the ladder. Fidelity and transfer degrade as you move down.
- For a world engine, an in-memory or SQLite state store with snapshot/fork semantics gets close to REAL-level reset cost while keeping a backend that can be probed for grading. REAL's localStorage design leaves state client-side, which complicates server-side grading and multi-user scenarios; the `/finish` submission works around this.
- I found no published per-reset wall-clock benchmark comparing SQLite-backed clones to Docker apps. The ordering above is inferred from the WebServ, REAL and OSWorld numbers.

### Gaps
- I found no published per-episode reset latency for WebArena (beyond about 1 minute to start a container) or for OSWorld VM snapshot revert.
- I found no public benchmark of SQLite or in-memory clone reset time.

---

## Q3. Work on generating synthetic websites/apps for agent training; vendor clones for RL

### Takeaway
There are two lines of work.
- Trajectory synthesis on real sites (AgentTrek, Explorer, InSTA, WebGym). This scales tasks but not controllable worlds.
- Environment synthesis, where LLMs generate executable clones with verifiable backend state (VeriEnv, Verified Synthetic Web Environments, Weblica, and world-model approaches like DynaWeb). Commercially, frontier labs buy hundreds to thousands of SaaS and website clones ("UI gyms") from vendors at about $20k (simple) to about $300k (complex, e.g. Slack) each. Quality and reward-hackability are the main problems.

### Cited Findings

**Trajectory synthesis on real sites**
- **InSTA** (Amazon / CMU, ICLR 2025): LLM-generated tasks for 150k websites, then LLM agents produce trajectories, then an LLM judge filters them. Reported figures: 97% harmful-content filtering accuracy, 89% feasible-task rate, and 82.6% judge accuracy. Llama-3.1-70B agents solve 16.7% of tasks. — [arXiv 2502.06776](https://arxiv.org/abs/2502.06776); [Amazon Science](https://www.amazon.science/publications/towards-internet-scale-training-for-agents)
- **AgentTrek** (HKU / xlang, ICLR 2025): mines web tutorials, converts them into goals with step-by-step guidance, replays them with a VLM agent in a real browser, and filters with a VLM evaluator. It is cheaper than human annotation. — [arXiv 2412.09605](https://arxiv.org/abs/2412.09605); [HF collection](https://huggingface.co/collections/ranpox/agenttrek-browser-use-agent-data-synthesis)
- **Explorer**: a multi-agent, exploration-driven, bottom-up synthesis pipeline that produced 94K+ multimodal web trajectories. — [arXiv 2502.11357](https://arxiv.org/abs/2502.11357)
- **WebGym** (CVPR 2026): about 300k rubric-graded tasks on real websites. Qwen3-VL-8B trained with RL improved from 26.2% to 42.9% on unseen-site tasks, ahead of GPT-4o (27.1%) and GPT-5-Thinking (29.8%). — [arXiv 2601.02439](https://arxiv.org/abs/2601.02439); [CVF](https://openaccess.thecvf.com/content/CVPR2026/html/Bai_WebGym_Scaling_Training_Environments_for_Long-Horizon_Visual_Web_Agents_with_CVPR_2026_paper.html)
- **WebAgent-R1**: end-to-end multi-turn RL for web agents on WebArena-Lite. — [arXiv 2505.16421](https://arxiv.org/abs/2505.16421)
- **BrowserForge** (2026): parallel browser sandboxes to scale web episodes. I saw only the title. — [arXiv 2608.24848](https://arxiv.org/pdf/2608.24848)

**Environment synthesis (generated or cloned worlds)**
- **VeriEnv** (Mar 2026): uses LLMs as environment creators that clone real-world websites into executable, verifiable synthetic environments. Agents self-generate tasks with deterministic, programmatically verifiable rewards. — [arXiv 2603.10505](https://arxiv.org/abs/2603.10505)
- **Training Needs Trustworthy Worlds: Verified Synthetic Web Environments** (Zhang, Cheng, Hu, Xiao, Mao, Roth; Aug 2026):
  - Generates 500 environments across six domains, represented as pages, links, DB records, state-change markers and task constraints.
  - Verification catches four defect classes: structural (broken links, orphan pages), semantic (placeholders, invalid values), consistency (contradictory entity attributes) and feasibility (missing controls). It uses symbolic checks plus four LLM verifier agents.
  - Feasible-task rate rises from 48.6% (raw) to 94.8% (verified). Curation takes about 18 minutes per environment versus 28-35 minutes for baselines.
  - PPO policies transfer to WebArena, WebShop and MiniWoB++.
  - [arXiv 2608.21898](https://arxiv.org/abs/2608.21898)
- **Weblica** (May 2026): HTTP-level caching of real sites plus LLM-synthesized interactive environments, with 2,560 training environments and 44,227 tasks. — [arXiv 2605.06761](https://arxiv.org/abs/2605.06761)
- **DynaWeb** (Jan 2026): a learned web world model predicts page representations, and the agent "dreams" rollouts for online RL. The world engine is replaced by a model. — [arXiv 2601.22149](https://arxiv.org/abs/2601.22149)
- **REAL** clones (11 sites) are hand-built, deterministic replicas. They show the "clone" approach as a public benchmark. — [arXiv 2504.11543](https://arxiv.org/abs/2504.11543)

**Industry: RL environment vendors and SaaS clones**
- TechCrunch (21 Sept 2025): labs are investing heavily in "environments". Turing has built 1,000+ such environments, from Airbnb and Zendesk clones to Excel. Mechanize and Prime Intellect target the space, and Mercor and Surge are investing too. — [TechCrunch](https://techcrunch.com/2025/09/21/silicon-valley-bets-big-on-environments-to-train-ai-agents/)
- Reports say Anthropic discussed spending about $1B over a year on RL environments, and OpenAI projected about $1B for data and environments in 2025, rising to about $8B by 2030. Labs train in simulated Salesforce, LinkedIn, Gmail and similar apps. These are secondary sources (an X post summarizing a paywalled article, and ForkLog), so treat them as reported, not confirmed. — [X / Kol Tregaskes](https://x.com/koltregaskes/status/1970312663411372069); [ForkLog](https://forklog.com/en/office-ai-inside-the-new-race-between-anthropic-and-openai/)
- Epoch AI (Denain & Barber, 12 Jan 2026): simple website replicas ("UI gyms") cost about $20k each, and complex product clones like Slack about $300k. Contracts run six to seven figures per quarter. Builders include startups, data vendors (Mercor, Surge, Handshake, Turing), in-house lab teams, and product companies partnering with labs. Quote: "what everyone does is vibe code a buggy website which isn't useful. There's a large amount of useless bad environments out there." Robustness to reward hacking is the top quality criterion. — [Epoch AI](https://epoch.ai/gradient-updates/state-of-rl-envs)
- Vendor directory: [rl-list.com](https://www.rl-list.com/) (unvetted aggregator).

### Inferences
- The bottleneck has moved from task generation to trustworthy world generation, meaning environments that are feasible, consistent and gradeable. The jump from 48.6% to 94.8% feasibility in arXiv 2608.21898 suggests about half of naively LLM-generated environments are unusable without verification. This matches Epoch's "vibe-coded buggy websites" complaint.
- A world engine that generates apps from a spec, with a canonical backend state and built-in verifiers (link and feasibility checks, state-diff graders), targets exactly this pain point.

### Gaps
- I could not access "WebSynthesis" (world-model-guided MCTS for web trajectory synthesis) or "AgentSynth" in this session. They are likely relevant but unverified here.
- I could not obtain specifics on OpenAI's or Anthropic's internal clone stack (tech, reset method). Public information is limited to press reports.

---

## Q4. browser-use: what it is, architecture, eval harness, and fit with a world engine

### Takeaway
browser-use is an MIT-licensed Python agent harness (about 117k GitHub stars) that lets any LLM drive a real Chromium browser through the Chrome DevTools Protocol. It serializes the DOM into an indexed element list plus screenshots and exposes about 31 browser actions. It is not an environment. It is the "agent side" that could drive any UI a world engine serves at a URL. Its own evaluation uses live-web tasks graded by an LLM judge, not state probes.

### Cited Findings
- Open-source framework that "enables language models to control and interact with web browsers autonomously". It connects to browsers via CDP, performs DOM serialization, and implements 31 browser actions. It uses both visual and HTML inputs. — [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use)
- About 117.3k stars, 12.9k forks, MIT license, Python 3.12. Three deployment paths: hosted cloud API, CLI, and Python library. — [GitHub](https://github.com/browser-use/browser-use)
- Model-agnostic: its own "BU2" model, OpenAI, Anthropic, Gemini, and local models via Ollama. — [GitHub](https://github.com/browser-use/browser-use)
- Browser Use Cloud adds stealth browsers, residential proxies, CAPTCHA solving, profiles and recordings, at about $0.02 per browser-hour (as stated on the repo). — [GitHub](https://github.com/browser-use/browser-use)
- Eval harness, [browser-use/benchmark](https://github.com/browser-use/benchmark), v2.1:
  - 200 tasks, 20 each from custom challenges, WebBench, Mind2Web 2, GAIA (validation split) and BrowseComp. v1 had 100 tasks.
  - Tasks are encrypted to prevent contamination.
  - Graded by an LLM findings judge with a continuous weighted rubric (partial credit), using trajectories, deliverables and per-action screenshots.
  - Reports accuracy and cost per task across models and browser providers.
  - The repo page names the judge and compared models as "GPT-5.6-Luna" and "GPT-6 Astra". I could not independently verify these model names; treat them as as-stated.

### Inferences
- **Fit with a world engine.**
  - browser-use needs only a CDP-reachable browser and a URL. Any engine that renders its world as a web UI (a cloned SaaS app on localhost) can be driven unchanged. The engine supplies the environment, reset and grader. browser-use supplies the agent loop, observation serialization (DOM index plus screenshot) and actions.
  - It does not provide reset, state probes, or programmatic reward. Those must come from the engine, for example a REST endpoint for snapshot/restore/state-diff, as REAL does with `/finish`. An integration would wrap browser-use's `Agent` run as one episode and call the engine's grader afterward.
  - Its benchmark uses an LLM judge on live sites. It is a useful external yardstick but does not model state-based grading. A world engine could provide browser-use with deterministic, state-graded tasks, which its live-web benchmark lacks.
- For RL training (not just evaluation), BrowserGym's gym API (step/reset/reward) is a closer structural match than browser-use's high-level agent loop. browser-use is better as a strong baseline harness and a source of DOM-serialization and action-space design.

### Gaps
- I did not verify how browser-use's internal DOM serializer handles canvas-rendered or non-DOM UIs, or whether it has a gym-style step API for RL. Neither was documented on the pages fetched.
- I found no published browser-use scores on WebArena-Verified or REAL in this session. The project has historically reported WebVoyager results, but I did not verify current numbers.
