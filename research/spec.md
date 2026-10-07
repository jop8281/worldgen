# Work trial spec (verbatim)

WORK TRIAL — WorldGen: an agent that builds simulated worlds

The problem: We test AI agents against worlds: stateful replicas of real software (a helpdesk, a CRM, a payments API). An agent calls the world's API, the world's state changes, and a grader reads the end state to score the run. Building a good world by hand takes days. Build two things that make it take minutes:
1. A lightweight world engine — runs and grades worlds.
2. WorldGen — an agent that turns a description of some software into a world for that engine.
AFTER: "A helpdesk with SLA tiers and on-call escalation" -> WorldGen <-(world down / errors up)-> World engine -> a working, graded world.
Language, libraries and design are your choice.

THE WORLD ENGINE. Keep it small and strict. You design the format.
A world contains: a data model (entities, fields, types, keys, relationships); an API (routes mapped to standard operations list/get/create/update/delete or to custom logic); custom logic for workflows beyond plain reads and writes (e.g. escalating a ticket); seed data (starting state); tasks (an instruction for an agent plus a grader that scores the end state 0 to 1).
Minimum features: Check (validate a world before running it, errors precise enough for a model to fix them). Serve (answer the world's API over HTTP from a fresh copy of the seed data). Enforce (refuse any write that breaks the data model; a failed call leaves no partial changes). Deterministic (same world and task always start from the same state; time controlled by the engine, not the wall clock). Inspect and reset (dump current state, reset to seed, log of calls). Grade (score a task from the end state, and confirm the grader gives full marks to a reference solution and zero to doing nothing).

WORLDGEN. An agent that turns a request into a working world, like handing the job to a careful engineer: asks the right questions of the input, builds in stages, checks its own work, tells you what it did.
Inputs (any one of): a description (fills gaps with sensible choices and writes them down); an API spec e.g. OpenAPI (follow its paths, shapes and errors, optionally narrowed to part of it); sample data e.g. CSV (infer the data model, shape the seed data).
Outputs: data model and API resembling the real software; custom logic for at least one real workflow (states and rules); realistic internally consistent seed data (plausible values, relationships resolve, believable mix of states, enough rows that searching and paging matter); at least three graded tasks at different difficulty levels each with a reference solution; a short report (what was built, assumed and why, left out, proof checks and graders pass).
Stages: 1 understand input and draft plan (entities, routes, workflows, tasks); 2 model data and API, check; 3 implement workflow logic, check and test; 4 generate seed data, check; 5 write tasks, graders, reference solutions, confirm full marks for solution and zero for doing nothing; 6 report.
Minimum features: one command input to finished world; plan first (saved, human-readable, later stages follow it); self-repair loop (engine failure fed back to model, retry within budget); knows when to stop (says why instead of handing over a broken world); uses the engine as its judge (never edits the engine, never grades its own work by asking the model); iterates (existing world + change request like 'add refunds' updates rather than restarts); observable (logs each stage, every repair attempt, time, model cost); configurable (model and budget are settings).
Good world: reads and writes; faithful to the real software not to what is convenient for the agent; no silent guessing; graders that discriminate.
Deliverables: repository with engine and WorldGen each runnable with one command; short design doc (world format, engine guarantees, WorldGen loop); one hand-built world plus the worlds WorldGen generated from prompts they send. They run WorldGen live on unseen prompts at the end. Where ambiguous, make a call, write it down, keep going.
