# Private task verifier boundary — YOS-125

Status: proposed first stage, based on main `3b75bad125bb154f0258856abd463b0e6bccc626`.
Tracking: [YOS-125](https://linear.app/yossi-zozo123/issue/YOS-125/define-a-private-task-verifier-process-boundary), under YOS-85.
This change adds a design and HTTP regression coverage. It does **not** separate processes,
strip deployment bundles, add authentication, or certify a secure release. The existing world
format stays unchanged. All runtime and deployment gates below remain open.

## Current behavior and the gap

`serve()` in [engine/index.ts](../code/src/engine/index.ts) gives the same `CheckedWorld`
and `Runtime` to both listeners in [engine/http.ts](../code/src/engine/http.ts). The public
listener refuses `/_world/*` and projects OpenAPI through `openApiOf()`. The admin listener
can grade and enumerate task names. `Runtime.grade()` in
[engine/api.ts](../code/src/engine/api.ts) reaches the grader through the full world.
Separate ports are an HTTP routing boundary, not a memory or filesystem boundary.

[sandboxes/files.ts](../code/src/sandboxes/files.ts) currently packages every file beneath
the world directory, including `world.yaml` with graders, solutions and decoys. Hiding
admin routes or binding them to loopback cannot prevent a compromised serving process
from reading those files. A solver with shell access in that same sandbox can also reach
loopback. [architecture.md](architecture.md) already says `node:vm` is for determinism,
not security. A worker thread would share the same OS authority.

The new [private-output tests](../code/test/private-output.test.ts) mark every grader,
solution, decoy script and decoy explanation in the checked golden helpdesk world.
They prove those markers stay out of the exercised OpenAPI, successful/error HTTP replies,
and rejected admin probes. Positive private-admin controls prove grading/task lookup is
still loaded. These are serializer/router regression checks, **not** a proof against
arbitrary handlers, VM escapes, process compromise, or private text intentionally copied
into public descriptions or seed data. Publication review must reject that copying.

## Threat model

| Component | Authority and assets | Treat as hostile | Required boundary |
|---|---|---|---|
| API agent | Receives only its assigned instruction, public API URL and public schema | Requests, timing, guesses at admin paths, claimed final state or score; no trusted identity from request fields | No world/verifier filesystem, process, admin network or controller credentials |
| Public world process | Serves the admitted data model, public routes/actions, deterministic state and jobs | Generated handlers and all HTTP input; assume compromise can read its entire filesystem/memory | A public-only deployment artifact, restricted identity and network, no private task material |
| Admin controller | Admits a checked world, pins its revision, owns task/run assignment and records the episode | Solver-provided artifacts and public-server claims | Trusted service outside the agent sandbox; authenticated private control channels; owns completion/cancellation |
| Private verifier | Holds the admitted private world and task definitions; independently replays and grades | Trace/snapshot input and generated snippets, even after schema checking | Separate isolated verifier execution environment with no controller credentials, outbound network or public listener |

This proposal protects task-private source and grade integrity against an API agent and a
compromised public world process. A compromised controller, host kernel or admitted verifier
engine is outside this threat model. Grader correctness and benchmark contamination remain
separate checks; deterministic replay does not prove a grader matches the task's intent.

## Artifact and process ownership

Admission happens in the trusted controller before the solver runs. It checks and verifies the
complete world and binds one immutable revision to the run. It produces two artifacts using
an allowlist, without modifying the saved world format:

* **Public execution artifact:** the data model, API metadata, routes, handlers, jobs, seed
  representation and runtime dependencies necessary to serve. No `tasks`, graders,
  solutions, decoys, test scripts, plans, reports or source-world directory. Deliver the
  single assigned task instruction directly to the solver through the controller.
* **Private verification artifact:** the complete admitted world, task definitions and
  deterministic seed/replay configuration, available only inside the verifier environment.

Do not serialize the whole `World` and delete a few known fields. Validate the public
artifact's strict schema and inspect every uploaded file before starting a process.
Never load the private world in the public process and then erase it: memory, startup
logs and temporary files would already have received the private code. The current
`collectBundle()` and `serve(CheckedWorld)` interfaces must change in a later stage.
Do not cast an incomplete object into `CheckedWorld` or weaken `checkWorld()` to obtain
a serving capability; introduce an explicitly validated public execution type instead.

The verifier must replay with the same public logic plus its private task definitions.
Pin artifact content digests and engine/config versions in a controller-owned session;
world names are not unique identities. Nothing in a public request may select a world
path, filesystem location, provider, model, verifier revision or another run's task.

## Proposed private protocol

The following types describe a future wire contract; they are not implemented exports.
The controller authenticates a session and binds its world digest, engine/config digest,
run identity, assigned task and limits out of band. The single request has exactly three
fields: `taskId`, `trace`, `finalState`. Unknown fields are rejected.

```ts
type VerifyRequest = {
  readonly taskId: string;
  readonly trace: readonly EpisodeEvent[];
  readonly finalState: StateDump;
};

type EpisodeEvent =
  | { readonly kind: 'call'; readonly seq: number; readonly call: CallRecord }
  | { readonly kind: 'advance'; readonly seq: number; readonly by: string };

type VerifySuccess = number; // finite, within [0, 1]; only the trusted controller receives it
```

`StateDump` and `CallRecord` refer to [engine/api.ts](../code/src/engine/api.ts), not
arbitrary executable values. On the wire these are bounded JSON validated by new strict
schemas; TypeScript `readonly` and `Object.freeze()` are not authentication. All nested
rows, request/response bodies, counters, times, write records and job results need validation.
The outer event sequence orders calls and controller-only clock advances; `call.seq`
retains the runtime's independent call numbering. New episodes start at the admitted seed;
reset ends the old episode and starts a new identity, never splices or erases recorded history.

The controller captures events through its private gateway, serializes them into immutable
storage, and binds their canonical byte digest to the session. Direct agent-to-server access
that bypasses capture is forbidden. The gateway owns the HTTP transport checks currently
performed before `Runtime.call()` in `onWorld()`: malformed JSON, unsupported methods,
reserved admin paths and OpenAPI delivery never invoke the runtime. Record these in a
separate bounded immutable transport audit (method, target, disposition and response digest),
bound to the same session at sealing. They are not `CallRecord`s and do not enter the
grading trace, matching existing `ctx.trace()` semantics. An HTTP request admitted to
runtime routing produces a call event even when the runtime refuses it, such as an unknown
route or missing row. Gateway/adapter parity tests must cover encoded paths and prove that
transport refusals cannot mutate the world. Do not attempt to reconstruct malformed JSON
from a parsed `ApiRequest`, or coerce OPTIONS into a supported runtime method.

An `advance` event requires controller authorization;
the agent cannot inject it. Close and drain the request gateway before atomically sealing
the trace and final snapshot. No subsequent write, clock change or reset belongs to that
episode. Duplicate completion with the same digest is idempotent; a different digest for
the same completed run is an error. Cancellation produces no successful verdict.

Neither controller capture nor a matching hash makes a compromised public server honest.
The verifier uses its private pinned artifact and independently replays the trace from the
canonical seed, preserving failed calls, deterministic clock ticks and scheduled jobs.
For each call it compares the recorded request's replay response, committed writes, job
results and runtime sequence; controller advances are replayed in event order. A mismatch
is invalid evidence, not score zero. It derives its own `OriginJournal` and call log from
replay, then compares final tables, counters **and `now`**. The existing `StateDump.hash`
excludes `now`, and is not an authenticity proof. Recompute and check any supplied hash;
also bind and compare the world identity from the session.

This replay is necessary for existing semantics: `CallRecord.writes` excludes job writes,
`Runtime.log()` omits admin advances/resets, and `gradeDump()` in
[engine/tasks.ts](../code/src/engine/tasks.ts) warns when a journal or trace is absent.
The verifier must pass its replay-derived journal and log to grading. Never accept a
client-supplied journal or silently fall back to snapshot-only grading. Fail closed if
replay, schema, task ownership, snapshot comparison, grading, or evidence completeness
fails. Unknown task IDs use a generic private protocol error, without task enumeration.

Success returns only a finite scalar in `[0, 1]`, after all comparisons. Transport failures
use a fixed error category with no score, source, stack trace, assertion text, goal/guard
details or grader output. Rich diagnostics remain in restricted controller records with
secrets excluded. The public API exposes no grade endpoint; return a score to the API agent
only after its episode closes and only if the product explicitly permits that feedback.
Do not create an interactive oracle for hidden graders.

Before implementation admission, set concrete limits for request bytes/depth, event count,
individual body sizes, replay CPU/memory/wall time, output bytes and concurrent verifier
jobs. Reject overflow and abort work on deadline/cancellation. Limits cannot silently
truncate an episode into an apparently valid grade. No model or network call is needed
for verification; paid Boat use remains subject to controller budgets and confirmed teardown.

## Required OS and deployment controls

Separate processes alone are insufficient. The public runtime, API agent, verifier and
controller require separate security principals and isolated filesystem/process/network
namespaces or separate VMs. Use Boat for product sandbox execution, in accordance with the
current provider decision. Qualify its actual isolation configuration before claiming the
boundary; this document does not assert that a particular Boat configuration enforces it.

The public runtime and agent must have no mount, inherited descriptor, shared temporary
directory, debug/inspector port, process-inspection/ptrace privilege, container socket,
host credential, or readable log/core dump leading to verifier/controller data. Run
unprivileged with read-only code and narrowly scoped writable state. Disable core dumps
and unsafe debugging; restrict syscall/namespace capabilities where the platform supports
them. An agent sandbox must not share a loopback namespace with an admin service.

The verifier receives a read-only private artifact and bounded input, has a disposable
writable directory, no network egress, and no Boat, model or GitHub credentials. Its
trusted replay, comparison and grading coordinator must also be isolated from all
generated-code execution. Use separate security principals, execution pools and mounts
for public handlers/jobs/seeds and for private graders; never let a public snippet worker
load a task-private artifact, inherit its descriptors, inspect its process, or reuse a
worker that cached private grader/solution/decoy source. Reference solutions and decoys
need private admission workers, not the public serving/replay pool. The existing
[sandbox.ts](../code/src/engine/sandbox.ts) process pool shares OS authority and workers
across snippet kinds, so reusing it unchanged does not establish this boundary.

The trusted coordinator mediates bounded typed ctx operations and validates every worker
reply; workers cannot select another task, mint a trusted verdict, or bypass replay and
snapshot comparisons. Grader outputs are finite scalar candidates until coordinator
validation succeeds. The admitted grader's scoring intent remains a task-correctness
assumption; isolation cannot make an intentionally permissive grader discriminate.
Apply the same separation during admission: `checkWorld()` and task verification execute
generated code before an episode starts. Isolating only the final grading call is too late.
All snippet workers must also be isolated from the controller and from other runs. The
controller alone holds provider credentials and private-channel credentials. Channels
must authenticate peers and bind run/revision/epoch, enforce authorization, encrypt when
crossing hosts, and remain inaccessible from public/agent networks. A bare loopback
listener without authentication does not meet these requirements.

## Implementation gates, still open

| Stage | Required evidence before claiming completion |
|---|---|
| Public artifact | An allowlisted serializer/loader, schema tests, and upload inspection showing all task-private sources and adjacent artifacts absent; malicious/extra files rejected |
| Split runtime | A public process started without private assets; separate trusted replay orchestration, public-snippet and private-grader/admission workers with disjoint OS authority/pools; narrow protocols; no `CheckedWorld` brand forgery or task-aware runtime reachable from public serving |
| Replay verifier | Literal positive/negative grades; refused calls; job-origin collateral attribution; clock changes; missing/reordered/duplicated/tampered events; wrong task/run/world; changed `now`; schema/size limits; timeout and cancellation all fail correctly |
| Public privacy | Retain the HTTP canary regressions in this PR; add coverage for any new public error, debug and export surface |
| Isolation | OS-level adversarial filesystem, process inspection, inherited-FD, loopback, egress, public/private worker reuse and cross-run checks in both admission and replay in the actual Boat deployment; cleanup success, failure and cancellation evidence |
| Qualification | Full Bun gate, explicit Node compatibility where retained, authenticated deployment review and exact-head CI; skipped or failed isolation evidence blocks the security claim |

YOS-125 stays WIP after this design-first PR. The next implementation must coordinate with
YOS-75 (Boat), YOS-91 (episodes) and the current YOS-85 owner. Existing privacy and replay
tests cannot substitute for these remaining gates.
