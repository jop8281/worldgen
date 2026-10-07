# Spec call: model selection lives in `code/models.json` (version 1)

**Status:** proposal. Data only for now; nothing reads it yet.

**Choice:** one data file, `code/models.json`, says which model and effort each WorldGen step uses:
- `steps.<plan|model|workflow|seed|tasks>`: the model and effort for each step.
- `escalate`: the model used after a stall.
- `default`: used for anything not listed.
- `transport`: `claude-cli` by default, with `sdk` as the opt-in. `transports.sdk.apiKeyEnv` is `LLM_KEY`.
- `prices`: in the same shape as `configSchema.prices`.

Version 1 uses `claude-opus-5-5` everywhere and varies only `effort`. On current models, lower effort on the strongest model usually matches a cheaper model at higher effort, and a single model keeps one prompt-cache namespace. Prices are first-party API rates as of 2026-09-25.

**Transport:** the default is `claude-cli`: model calls go through the Claude Code harness (`claude -p --json-schema`), so no API key is read. The SDK transport is opt-in with `--transport sdk`; only then is the key read from the env var named in `transports.sdk.apiKeyEnv`, which is `LLM_KEY` (repo-root `.env`, gitignored; never commit, print or log it). Red-team and eval scripts call the model only through `npm run worldgen`.

**Open (decide later):**
- Merge this into `worldgen.config.json` under `configSchema` (strict: add `steps.<id>.model/effort` and `escalate`), or keep it as a separate file that `loadConfig` reads?
- Should a CLI `--model` flag override every step, or only `default`?
- Is it worth measuring Sonnet 5.5 for `seed` once the eval suite exists?

**Replaces:** nothing yet. It would extend A-36 and A-37.
