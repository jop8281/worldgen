# Model and transport: the evidence for YOS-107

YOS-107 asks for three things to hold: every model call uses the pinned `claude-sonnet-5-5`, the calls go through `claude -p` by default with the SDK only when chosen, and nothing falls back silently from one to the other. The decision is A-66 in [decisions.md](../decisions.md), which extends A-56. This note checks it against the code at `origin/stabilize/main` `05f5e63` and against the run events and spend ledger of 2026-10-07. Line numbers are in `code/src/`.

## The model is pinned

- `worldgen/config.ts:40` defines `PINNED_MODEL = 'claude-sonnet-5-5'`. Line 42 refines every model field to it, so config, `stepModels`, `escalate` and `--model` fail to parse with any other id (line 77 is `model`).
- `worldgen/llm.ts:192-195` has `requireAllowed`, which throws a `ModelError` before any request unless the model is the pinned one. Both transports call it: the SDK `propose` at `llm.ts:272` and the claude CLI `propose` at `llm.ts:656`. This covers a hand-built config that skipped parsing.
- The CLI transport passes the model explicitly, as `'--model', model` at `llm.ts:514`, so the logged-in session's own default model never applies.
- The dataset records the model as a literal: `dataset/schema.ts:192` and `:255` are `z.literal(PINNED_MODEL)`, and `dataset/episode.ts:387` and `dataset/store.ts:242` write it.

## The claude CLI is the default, and the SDK is opt-in

- `worldgen/config.ts:57` lists the transports, `claude-cli` and `sdk`. Line 60 sets `DEFAULT_TRANSPORT = 'claude-cli'`, and `transportOf` at line 95 uses it when the config names no transport. The shipped `worldgen.config.json` also sets `"transport": "claude-cli"` explicitly, at line 4.
- `cli/worldgen.ts:45` documents `--transport <t>` as "claude-cli (default: the logged-in claude CLI) or sdk (reads LLM_KEY from the environment)", and line 102 parses it.
- Only the `sdk` branch reads a key. `cli/models.ts:62-66` reads `config.apiKeyEnv`, default `LLM_KEY` (`config.ts:62`), and throws `--transport sdk needs LLM_KEY set in the environment` when it is unset. The SDK client pins `baseURL` to `https://api.anthropic.com` (`llm.ts:247-261`), so a stray `ANTHROPIC_BASE_URL` cannot redirect the key.
- Every entry point builds its model through `makeModel` in `cli/models.ts:44`: the worldgen CLI (`cli/worldgen.ts:161`), eval (`cli/eval.ts:229`), the live runner (`cli/live.ts:275`), and the dataset solver behind the final replies (`cli/dataset.ts:192`, unless a test injects a proposer). `claudeCliModel` and `anthropicModel` are constructed nowhere else (`cli/models.ts:60` and `:66`).

## There is no silent fallback

`makeModel` switches on the transport (`cli/models.ts:48-70`), and each branch either returns its own model or throws.

- If the claude binary is not on PATH, the `claude-cli` branch throws (lines 51-54). The message names `--transport sdk` as something the operator can choose, and the code never switches transport.
- If the binary does not run `--version`, it throws as well (lines 56-59). That is the shell-shim case.
- The `sdk` branch never tries the CLI.
- The `default` branch is `assertNever(transport)`, so a third transport cannot be added without a branch of its own.

A failed call inside a run is a `ModelError`. The run stops with `model_error` (or `transport_stalled` after one stall retry, A-123) and writes REPORT.md. It does not retry on the other transport.

## What the runs show

- **Stress-2 (2026-10-07, 30 runs).** Every `run_started` event in `eval/runs/2026-10-07-stress-2/lane-*/*/events.jsonl` has `model: claude-sonnet-5-5` and `transport: claude-cli`.
- **The spend ledger** (`~/.worldgen/costs.jsonl`, read at 17:15Z on 2026-10-07). It holds 862 `model_call` rows, all with provider `claude-cli`. None has provider `anthropic`, so no SDK call has been made on this machine.
  - 849 rows are `claude-sonnet-5-5`. The other 13 are `claude-opus-5-5`, from 2026-10-06T23:29:55Z to 2026-10-07T00:30:27Z, which is before the pin landed in 07002de1 at 2026-10-07T01:02:42Z.
  - There are 0 non-Sonnet calls after that commit.

## What this does not cover

- The SDK transport is only exercised by the fake-model and parse tests, not by a live call. No `anthropic` row exists in the ledger. A live SDK check needs `LLM_KEY` and spend approval.
- The dataset's solver and reply path builds its model the same way, but this note did not check a live dataset run's events. That is YOS-91 and YOS-108.
