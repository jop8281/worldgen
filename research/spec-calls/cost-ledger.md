# Spec call: every cost lands in one spend ledger (`code/src/costs/`)

**Status:** built and tested (`code/test/costs.test.ts`). Nothing calls it yet; the wiring below lands with the units that own those files.

**Requirement (user, 2026-10-06):** monitor all costs, always, in source: every Anthropic model call (SDK transport with LLM_KEY, or the claude CLI transport) and every sandbox VM (boat.dev, and the local OpenShell and sbx backends at $0 with their duration).

## Calls

- Call: one append-only JSONL file, `WORLDGEN_COSTS_FILE`, default `~/.worldgen/costs.jsonl`, shared by every process and account. Each line is a `SpendEvent` (`t`, `provider`, `account`, `kind`, optional `runId`, `step`, `model`, token counts, `sandboxId`, `size`, `seconds`, `multiplier`, `failed`, `note`; `usd`, `estimated`). Why: one place to read every dollar, outside the repo so it is never committed. Reversible: yes.
- Call: keys never reach the ledger. `account` must match `sha256:<12 hex>`, `claude-cli` or `local`; `record()` validates with zod and throws before writing anything else, so a raw key cannot be stored by mistake. `fingerprint(key)` is `sha256:` + the first 12 hex of sha256(key) via node:crypto. `accountFor(provider, key?)` picks the right account per provider. Why: spend per key without storing, printing or committing a key. Reversible: yes.
- Call: the ledger is synchronous (`appendFileSync`, `readFileSync`). One append per line (O_APPEND), and a line is preceded by a newline when the file ends mid-line, so a writer that died mid-write corrupts only its own line. Reads skip and count corrupt lines (bad JSON or schema), never crash. Why: the exit flush must run inside a process `'exit'` handler, which cannot await. Reversible: yes.
- Call: time comes from an injected clock (`openLedger(path, { now })`, epoch ms); the ledger exposes `now()` so guard() and both meters share one clock. Days are UTC calendar days. Why: tests drive time literally; src/costs is not engine core, so Date is allowed, but only the default clock uses the wall time. Reversible: yes.
- Call: caps are `{ maxDailyUsd?, maxTotalUsd? }` from `WORLDGEN_MAX_DAILY_USD` / `WORLDGEN_MAX_TOTAL_USD` and an explicit object; when both set a cap, the lower wins. A non-numeric or negative value throws, naming the variable. Why: a second source may tighten a cap but never loosen it, and a typo must not silently disable a cap. Reversible: yes.
- Call: `guard(ledger, caps, now)` throws `SpendCapError` (`kind: 'spend_cap'`, `cap`, `capUsd`, `spentUsd`) when spend >= cap, total checked before daily, with the one-line message `spend cap maxDailyUsd reached: $1.2000 spent on 2026-10-06 (UTC) >= cap $1.0000; raise WORLDGEN_MAX_DAILY_USD to continue`. Caps are global across providers and accounts. Why: the guard is about all spend, not one key. Reversible: yes.
- Call: `meteredModel(model, ledger, opts)` is structural (`Proposer<R, P>`), so it does not import llm.ts; any llm.ts `Model` fits. It guards before each call (the inner model is not called on a breach), and records `usage` and the `costUsd` the client reported, never recomputed (SDK: usage x DEFAULT_PRICES; claude CLI: total_cost_usd). A thrown error that carries numeric `usage` and `costUsd` (a billed ModelError) is recorded with `failed: true` and rethrown unchanged; an unbilled error records nothing. `step` may be a getter read per call. Model lines are `estimated: false`. Why: the spec, plus one wrapper per run. Reversible: yes.
- Call: a ledger write failure throws out of the metered call. Why: fail closed: an unrecorded billed call breaks "always monitor all costs". Reversible: yes.
- Call: `meteredSandbox(backend, ledger, opts)` wraps any object through a Proxy: `create`/`up` start a lifetime (guarded first; an async method rejects, a sync one throws, and the backend is not called), `stop`/`down`/`delete` end it once the call succeeds, recording `seconds` and `usd = hours x multiplier x usdPerComputeHour`. Sandboxes are matched by the id, sandboxId or name of create's result or argument against stop's argument; a stop with no id ends the only live sandbox; a handle with its own stop/down/delete is metered too; a second create under a live id records the old lifetime first. Other members pass through bound to the backend. `flush()` records every live sandbox with a note and is synchronous for an `'exit'` handler. Why: the backends are built concurrently on other branches, so the meter cannot name their types. Reversible: yes.
- Call: boat sizes are small 0.5x (2 vCPU / 4 GB), default 1x (4 vCPU / 8 GB), large 2x (8 vCPU / 16 GB), from boat.dev public pricing; size defaults to `default`; an unknown size without an explicit multiplier throws. The rate is `opts.usdPerComputeHour`, else `BOAT_USD_PER_COMPUTE_HOUR`, else 0 with the note `set BOAT_USD_PER_COMPUTE_HOUR`. Boat lines are `estimated: true`; OpenShell and sbx lines are usd 0, `estimated: false`, account `local`. Why: the per-hour dollar rate is account-specific and not in the public table, so it is config. Reversible: yes.
- Call: `npm run costs [-- --since 2026-10-06] [--by provider|account|day|run] [--json] [--file <ledger>]` prints grouped totals, the corrupt-line count, the caps and the budget left today and in total. Exit 2 on bad usage. Why: the spec; `--file` reads another ledger without changing the environment. Reversible: yes.

## Observed inventory exposure (2026-10-07)

`bun run sandbox track [--org <wallet>]` explicitly records Boat inventory in the local journal. It requests inventory only. It does not request usage, create or stop VMs, import dollars, or infer a lifetime. `discover` remains read-only.

Only rows with `access: owner` and a state other than `archived` are tracked. Error and cancelled rows remain unresolved because their state alone does not prove billing has ended. The inspection key fingerprint records provenance; it does not identify the payer. Observations carry `origin: inventory`, `accountBasis: inspection_key`, and unknown exposure. The costs CLI shows the observation time and leaves the VM start time unknown.

Journal replay deduplicates an active Boat VM by provider and sandbox ID across keys and concurrent controllers. An existing admitted hold keeps its account, price and remaining amount; observation only tightens its caps. New unknown holds survive restarts and midnight and block applicable sandbox or combined admission. An LLM-only cap remains independent.

Receipt import and reconciliation for these observations are not implemented in this change. Generic release, configured-rate settlement and lifetime adoption cannot clear an inventory hold. Neither another inventory snapshot nor an archived row clears past unknown billing. Verified identity, exact receipt windows and receipt deduplication must be implemented before observations can be reconciled.

`sandbox down <id>` can still archive an observed VM, including without a local handoff record or valid cost configuration. It waits for provider archival and retains the unknown exposure. Stopping future usage does not establish the past bill.

## UTC-day receipt capture (2026-10-07)

`bun run sandbox capture-usage --day YYYY-MM-DD [--org <wallet>]` saves owner usage evidence beside the spend ledger, in `<ledger>.boat-receipts.jsonl`. It requests inventory and exact UTC-day usage only. The spend journal and pending holds are unchanged. Provider failures remain unavailable, and non-owner rows remain ownership-unverified.

The installed SDK documents `SandboxUsageResponse.seconds` as billable machine-seconds with the size multiplier already applied. Its `dollars` are list price, regardless of the plan, trial or gift that actually paid. Capture stores these values as `billableSeconds` and `listPriceUsd`, with `priceBasis: provider_list_usage`; it never applies the multiplier again or calls the estimate an invoice.

The receipt journal validates identities, finite numbers, price consistency and returned bounds. It retains requested and returned windows separately and reports full-day or partial-day coverage. A paused meter (`running: false`) is not evidence of archival. Repeated and concurrent captures have one canonical snapshot per VM and requested UTC day, with the newest observation winning; raw snapshots remain auditable. Inspection-key provenance accumulates across keys. Conflicting organization IDs stay visible. Organization names, creator identities and private URLs are discarded.

The costs CLI displays all stored receipt days separately from settled spending, including coverage, billable units and incomplete evidence. Capture refuses to append to corrupt receipt evidence. Verified reconciliation of whole lifetimes and replacement of overlapping estimates remain required before receipt evidence may clear an unknown hold or change cap exposure.

## Verified usage reconciliation and model finality (2026-10-07)

`sandbox down` records a nonfinancial closure cutoff for an inventory hold only after `waitStopped` confirms archival. Billing stays unknown. A new live inventory observation invalidates that cutoff.

`sandbox reconcile-usage <observed-reservation-uuid> [--org <wallet>]` requires owner access, current archived state, provider creation time and consistent wallet metadata. It requests exact slices from creation through the verified cutoff, splitting at UTC midnight. Every returned bound must match its request; partial coverage, paused VMs, changed identity, newer observations and corrupt evidence leave exposure unresolved. The command neither creates nor stops a VM.

One append-only journal transaction replaces covered VM estimates across inspection keys with one list-price estimate per UTC slice and resolves the specific observed hold. Events outside that lifetime and other active claims naming the VM block replacement. Unrelated VMs and unknown model billing are preserved. Raw estimates remain auditable; replay does not charge twice. Billable seconds remain in receipt metadata and are never added to wall-time seconds or multiplied again. Canonical account groups identify inspection keys, not payers. Invoice verification and full-wallet coverage remain open requirements.

Interrupted model usage is lower-bound evidence. Explicit unknown billing, share expiry, stalls, cancellation and AbortError retain the model claim even when numeric usage and price are attached. `partialModelUsage` records the observed amount separately from final `usd: null`; costs output labels it as a lower bound and does not add it to settled dollars. Terminal billed responses still settle; authoritative not-started proof releases a claim. No automatic replay is added.

## Wiring owned by other units (needs_outside)

- `code/src/cli/worldgen.ts` and `code/src/cli/eval.ts`: wrap the model with `meteredModel(model, openLedger(ledgerPath(process.env)), { provider: transport === 'cli' ? 'claude-cli' : 'anthropic', account: accountFor(provider, LLM_KEY), model: config.model, caps: capsFromEnv(process.env, config caps), runId, step: () => currentStage })`.
- `code/src/worldgen/run.ts`: treat `SpendCapError` (`kind: 'spend_cap'`) as a budget stop, not a model error.
- The boat/sandbox CLI (`code/src/boat/*`, `code/src/sandboxes/*`): wrap each backend with `meteredSandbox(backend, ledger, { provider, account: accountFor(provider, BOAT key), size, caps })` and call `flush()` from `process.on('exit')` and the SIGINT/SIGTERM handlers.
- `code/worldgen.config.json` and `code/src/worldgen/config.ts`: optional `spendCaps: { maxDailyUsd?, maxTotalUsd? }`, passed as the explicit caps.
- `code/package.json`: script `"costs": "tsx src/cli/costs.ts"`.
- `AGENTS.md`: module-map rows for `costs/ledger.ts` (the spend ledger, caps and guard), `costs/meter.ts` (metering decorators), `costs/pricing.ts` (fingerprints, boat sizes and rates), `cli/costs.ts` (the spend CLI); a commands row for `npm run costs`.
- `.gitignore`: `costs.jsonl`, in case WORLDGEN_COSTS_FILE points into the repo.
- `research/decisions.md`: a row for "all spend goes through src/costs; keys only as fingerprints".
