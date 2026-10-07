# Bun qualification and demo handoff

Implementation: YOS-154 and YOS-162, one PR (#388). Integration authority stays with YOS-105.

## Runtime decision

| Decision | Choice | Why | Date | Reversible |
|---|---|---|---|---|
| U-12 / YOS-88 reaffirmed: product and demo runtime | Require Bun 1.4.2; no automatic Node fallback; frozen install and no dotenv loading | Direct user instruction. A Node result must never masquerade as Bun qualification. | 2026-10-07 | Only by an explicit runtime decision |
| YOS-154 evidence scope | Artifact-smoke receipts, full task inventory, retain all attempts; a failed first attempt remains red | The engine is the judge. A partial transcript, stale summary or successful retry is not complete release evidence. | 2026-10-07 | Receipt versions may evolve; old versions fail closed |
| YOS-162 presentation freeze | Explicit immutable source; separate prepare and rehearse; no paid/live switch | Freeze the demo rather than halt development. Preparation is not a completed rehearsal. | 2026-10-07 | Select a new source only before a new rehearsal |

## Commands

From code/, with Bun 1.4.2 installed:

```sh
# Select the exact candidate once; retain it through preparation and rehearsal.
export WORLDGEN_DEMO_SHA="$(git rev-parse HEAD)"
bun run demo:prepare
# Later, on the presentation machine:
bun run demo

# Independent artifact smoke (fresh clone, install, typecheck, worlds, both demos):
bun run qualify --ref "$WORLDGEN_DEMO_SHA" --evidence-dir "$HOME/worldgen-smoke-new"
# Reopen its retained result (no install, clone, model or Boat call):
bun run qualify:receipt "$HOME/worldgen-smoke-new" --sha "$WORLDGEN_DEMO_SHA"
```

The new directory must not exist. An already rehearsed checkout stays frozen.
The demo uses scripts/demo-all.sh without arguments, clears world-selection overrides,
retains both pipeline exits and requires the complete 25-step summary. It checks source
and artifact hashes before/after. Individual HTTP timeouts do not bound the entire
process tree. The operator still verifies shutdown/ports and records the presentation.

Do not use --live in the presentation-critical path. Scripted reference/decoy playback
is not a fresh LLM episode. A separately recorded AI/Boat segment must name its actual
source/runtime/date. Evaluator unseen prompts remain a separate authorized run.

## Receipt version 2

metadata.json identifies the requested ref, controlling executable/version and tooling
commit/content hashes. source.json binds a full candidate SHA and package/lock/world
artifacts. Private inputs/world-N snapshots retain exact YAML and the trusted parser's
JSON output. inventory.json derives task IDs, difficulties and decoy counts from that
source, not proof stdout. Each commands/NAME directory holds invocation, timing, status,
exit, stdout and stderr. Diagnostic retries get distinct names. rows.jsonl and the final
receipt derive their result from these records. Evidence survives temporary-clone deletion.

A check must explicitly succeed through lints. Proofs must exactly cover the independent
task/decoy inventory: reference=1 with positive integer calls, noop=0, finite decoys/prefix
below 1, required medium/hard decoys, consistent near_miss, replay_identical=true and the
producer's 32-character hash128 state. Wrong, missing, duplicate, truncated or malformed
records fail. Reopening reconciles records and recomputes summaries from raw outputs;
missing evidence, mismatched SHA, path escapes and linked files fail.

Always report releaseQualification=not_run and cleanup=not_certified. This smoke does not
execute the complete test/E2E/live release contract. A failed attempt remains a failure
even after a successful diagnostic retry. No automatic attribution to machine load.

The writer and candidate are trusted: checksums are not signatures. Reopening does not
rerun the engine or independently authenticate a coordinated rewrite of all evidence.
Private snapshots contain task code and are not public solver datasets. Catchable signals
produce nonpassing evidence when storage/runtime remain usable; SIGKILL or storage loss
can prevent finalization. Missing evidence is not success. Use Git credential helpers,
not credentials embedded in repository URLs.

## CI ownership and honest status

The existing primary Bun CI job runs the added tests, including a native-Bun helper/CLI
smoke. Node compatibility is explicitly secondary; its job skips that native-only case.
No required checks are removed or weakened. Earlier local results are supplemental
Node/shell fixtures, not a Bun product or Boat qualification. Latest user instruction
delegates full validation to CI. The demo is prepared in code, not rehearsed on the
presentation machine by this PR. Do not mark release or demo acceptance Done from a merge.
