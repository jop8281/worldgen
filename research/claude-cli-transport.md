# Fact sheet: the `claude -p` transport (A-56)

For the unit that builds `claudeCliModel`, WorldGen's default model transport. A-56 says WorldGen's model calls go through the `claude` CLI under the user's logged-in session, never read `.env`, and keep the SDK only as `--transport sdk`.

Sources: `claude --help` from Claude Code **2.1.292** on this machine (2026-10-06), https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/cli-reference and https://code.claude.com/docs/en/agent-sdk/typescript. No real prompt was run. Every claim is tagged:

- **[help]**: read from local `claude --help`.
- **[docs]**: read from the docs pages above.
- **[unverified]**: inferred, or the sources disagree. Confirm with one real call before relying on it.

## 1. The invocation

Spawn with an argument array (`child_process.spawn(bin, args)`), never through a shell. Pass the prompt on stdin.

```sh
export PATH="$HOME/.local/bin:$PATH"     # see section 5
claude -p \
  --output-format stream-json --verbose --include-partial-messages \
  --json-schema "$TOOL_INPUT_SCHEMA_JSON" \
  --model claude-opus-5-5 \
  --effort high \
  --system-prompt-file "$RUN_DIR/system.txt" \
  --tools "" \
  --strict-mcp-config \
  --safe-mode \
  --disable-slash-commands \
  --no-session-persistence \
  --permission-mode dontAsk \
  --permission-prompts none \
  --max-turns 3 \
  --max-budget-usd "$REMAINING_BUDGET" \
  < "$RUN_DIR/prompt.txt"
```

| Flag | Why | Source |
|---|---|---|
| `-p` / `--print` | Non-interactive: print the result and exit. Skips the workspace trust dialog, and settings files that fail validation are silently ignored | [help] |
| `--output-format stream-json --verbose --include-partial-messages` | NDJSON events, one line every few seconds even while the model thinks, so a silent stdout means a stalled call (A-123). The last line is the result object of section 2, the same one `--output-format json` prints alone. `text` is the default | [help] [docs] |
| `--json-schema <schema>` | Structured output validated against a JSON Schema. The value is the schema text, not a path. Pass the same `inputSchema` that `ProposeRequest.tool` already carries (from `editJsonSchema` or `planSchema`). An invalid schema exits with `Error: --json-schema is not a valid JSON Schema`. `format` is accepted but not enforced | [help] [docs] |
| `--model <model>` | Alias (`opus`, `sonnet`, `fable`) or full name. Use the full id from `models.json` so cost lines up with `DEFAULT_PRICES` | [help] [docs] |
| `--effort <level>` | `low`, `medium`, `high`, `xhigh`, `max` (help). The docs add `ultracode`, so never pass that. The available levels depend on the model. This covers every value `models.json` uses | [help] [docs] |
| `--system-prompt-file <path>` | Replaces Claude Code's whole default prompt (coding-agent identity, tool guidance). That is what we want: WorldGen's stage brief is the system prompt. `--system-prompt <text>` is the inline form | [docs] |
| `--tools ""` | Disables every built-in tool. It "doesn't affect MCP tools" | [help] [docs] |
| `--strict-mcp-config` (with no `--mcp-config`) | Uses only MCP servers from `--mcp-config`. With none given, no MCP server loads, so no MCP tools exist | [help] [docs] |
| `--safe-mode` | Turns off CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents, output styles and auto memory, while "Auth, model selection, built-in tools and permissions work normally". This keeps the user's `~/.claude/CLAUDE.md` and hooks out of WorldGen prompts **without** losing the logged-in session | [help] [docs] |
| `--disable-slash-commands` | Turns off all skills, so a stage brief that happens to start with `/` is not expanded | [help] |
| `--no-session-persistence` | No transcript is written to `~/.claude/projects`, and the session cannot be resumed. Print mode only | [help] [docs] |
| `--permission-mode dontAsk` + `--permission-prompts none` | Belt and braces with no tools: anything that would prompt is denied, and Claude is told not to retry | [help] [docs] |
| `--max-turns N` | Caps agentic turns, and exits with an error when it is reached. Print mode only. **Not listed in `--help`**, only in the docs ("`--help` does not list every flag") | [docs] |
| `--max-budget-usd <amount>` | Stops when the client-side cost estimate reaches the cap. Print mode only. Pass the ledger's remaining budget, so one stuck call cannot overrun `maxCostUsd` | [help] [docs] |

**Do not use `--bare`.** It is the docs' recommended scripted mode, but "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper ... (OAuth and keychain are never read)" [help]. That breaks A-56 (no API key, use the logged-in session). `--safe-mode` is the substitute that keeps auth.

**Run it from a scratch working directory** (for example `<runDir>/.claude-cwd/`), not the repo. Without `--bare`, a `-p` run loads project `.claude/settings.json` and `.mcp.json` from its cwd, even untrusted ones [docs]. `--safe-mode` disables most of that, but managed (policy) settings still apply [help].

**`--exclude-dynamic-system-prompt-sections` does nothing here**: it is ignored when `--system-prompt` or `--system-prompt-file` is set [docs].

**Preflight once per run, not per call:** `claude auth status` prints JSON and exits 0 if logged in, 1 if not [docs]. Map exit 1 to a `model_error` before any stage runs, worded like "run `claude auth login`". `claude --version` gives the version to record in `run_started` events.

## 2. What the JSON result contains

The result object is the last stdout line with `type` `"result"` (with `--output-format json` it is the whole of stdout). Fields per the docs [docs]:

| Field | Type | Use in `Proposal` |
|---|---|---|
| `type` | `"result"` | sanity check |
| `subtype` | `"success"`, or an error kind (below) | outcome **[unverified: the TS type page shows this as `error` on error variants; the CLI emits `subtype`. Check one real result]** |
| `is_error` | boolean | outcome |
| `result` | string | the model's text. Put it in `advice` (never parsed), as the SDK path does |
| `structured_output` | unknown, present when `--json-schema` was given and succeeded | → `Proposal.input` (still untrusted; the caller parses it) |
| `session_id` | string | log it in the attempt event. With `--no-session-persistence` it cannot be resumed |
| `num_turns` | number | log. More than 1 means structured-output retries happened |
| `duration_ms`, `duration_api_ms` | number | `Proposal.ms`: measure wall time around the spawn ourselves, and log `duration_api_ms` too |
| `total_cost_usd` | number | `Proposal.costUsd` (see the cost note) |
| `usage` | `{ input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?, cache_creation?: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens } }` | `Proposal.usage`: `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, and `cacheWrite1hTokens` from `cache_creation.ephemeral_1h_input_tokens` (default 0). The CLI writes 1-hour cache entries, billed at 2x input (A-138) |
| `modelUsage` | `{ [modelId]: usage }`. The headless page calls it "a per-model cost breakdown" | log as-is. **[unverified: whether each entry carries a `costUSD`]** |
| `permission_denials` | array, optional | should always be empty with no tools. Log a warning if not |
| `stop_reason` | string (success) | log |
| `errors` | string[] (some error kinds) | `ModelError` message |

**Error kinds** [docs]: `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, `error_max_structured_output_retries`. Every variant still carries `total_cost_usd`, `usage` and `duration_ms`, so charge the ledger on errors too, as `ModelError`'s `billed` already does for the SDK path.

**Cost note.** `total_cost_usd` is a **client-side estimate** and can differ from the bill [docs]. Under a subscription login, nothing is billed per token, but the estimate is still the right number for WorldGen's `maxCostUsd` budget and for REPORT.md. Recommendation: take `costUsd = total_cost_usd`, and also compute `costOf(usage, model, prices)` and log both. A large gap means `DEFAULT_PRICES` is stale. If a caller resumes a session, `total_cost_usd` covers the whole conversation [docs]. We never resume, so each call's figure is its own cost.

## 3. A tool-free, as-deterministic-as-possible reply

- **Tool-free** is fully achievable: `--tools ""` + `--strict-mcp-config` (no `--mcp-config`) + `--safe-mode`. Confirm by checking that `permission_denials` is empty and `num_turns` is small.
- **Deterministic is not achievable from the CLI.** Neither `--help` nor the CLI reference has a temperature, top-p or seed flag [help] [docs]. Two identical calls can return different worlds. Determinism lives elsewhere, as plan.md §9 already says: tests replay recorded responses (section 6), and the engine, not the model, decides acceptance.
- **Reduce drift:** use a fixed `--model` id (not an alias, since aliases move to newer models), a fixed `--effort`, `--system-prompt-file` (so the default prompt, which embeds cwd, git status and date, is not sent), and `--safe-mode` (so no CLAUDE.md or memory leaks in).
- **[unverified] `--json-schema` with `--tools ""`.** The `error_max_structured_output_retries` kind suggests the CLI gets structured output through an internal step that it retries. It is not confirmed that this still works when every tool is disabled. **First real call the unit makes:** a tiny schema with `--tools ""`. Check that `structured_output` is present and `num_turns` is what `--max-turns` allows. If it fails, drop `--tools ""` and rely on `--disallowedTools` plus `dontAsk` instead.

## 4. Timeouts and exit codes

| Situation | Behaviour | Source |
|---|---|---|
| Success | exit 0, result JSON on stdout | [docs] |
| Failure inside the run (auth missing, max turns, budget, structured-output retries) | non-zero exit, **and the failure is printed as the result on stdout**. Always try to parse stdout before reading stderr | [docs] |
| Invalid flag or invalid `--json-schema` | error on stderr before the run starts, non-zero exit | [docs] |
| SIGTERM | exit **143**. The in-progress turn is left unfinished and no result is recorded, so stdout may hold no JSON | [docs] |
| SIGINT | ends the turn instead (the docs' advice before stopping a process) | [docs] |
| Piped stdin over 10 MB | exits with an error, non-zero | [docs] |
| Exact non-zero codes for each in-run error kind | not documented | **[unverified]** |

**There is no per-call timeout flag** [help]. The caller owns timeouts:

1. Per call: start a timer for `min(stepTimeoutMs, timeLeftInRunBudget)`. On expiry send **SIGINT**. After a 10-second grace period with no exit, send SIGTERM (expect 143). Map either to `ModelError('claude -p timed out after Ns')` with the measured `ms`. Cost is unknown on a kill, so charge the ledger with the last known estimate or 0, and say so in the event. As built (A-123, A-135), a killed call has no result line, so `streamProgress` reads what the stream had reported (messages, input and cache tokens, output tokens as a lower bound, the CLI's schema retries) and the call is billed for those tokens.
2. Within a call: `--max-turns` and `--max-budget-usd` bound work and spend.
3. API retries happen inside the CLI. In `stream-json` mode they appear as `system/api_retry` events [docs]. In `json` mode they are invisible and only show up as a longer `duration_ms`. Use `stream-json` + `--verbose` only if retry visibility becomes worth the parsing.
4. With no tools, the 10-minute background-subagent wait (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`) cannot trigger [docs].

**Map to `ModelError`:** a non-zero exit with a parseable result → `ModelError(errors.join('; ') || subtype, undefined, billed)`. A non-zero exit with no JSON → `ModelError('claude -p exited <code>: <first stderr line>')`. `is_error: false` with no `structured_output` → `ModelError('no structured output')`, mirroring the SDK path's "model did not call tool". Run every message through `scrub()` as the SDK path does.

## 5. PATH: the cmux shim

On this machine, `which -a claude` lists the cmux shim **before** the real binary:

```
/Users/yossieliaz/.cmuxterm/cmux-cli-shims/<uuid>/claude   # bash wrapper → cmux-claude-wrapper
/Users/yossieliaz/.local/bin/claude                         # → ~/.local/share/claude/versions/2.1.292 (Mach-O arm64)
```

The shim is a bash script that hands off to `/Applications/cmux.app/.../cmux-claude-wrapper`. The report that it **fails non-interactively** came from worldgen-27 and was not reproduced here **[unverified]**. Either way, do not depend on whatever `claude` resolves to first:

- Shell usage (README, demo, eval scripts): `export PATH="$HOME/.local/bin:$PATH"` before `npm run worldgen`.
- In code: resolve the binary once at startup. Use `config.transports["claude-cli"].bin` if set, otherwise `$HOME/.local/bin/claude` if it exists, otherwise `claude` from PATH. Log the resolved absolute path and `--version` in `run_started`. Spawn that absolute path.
- `models.json` currently has `"command": "claude -p --json-schema"`, a single shell string. Replace it with `{ "bin": "claude", "args": [...] }`, or let code own the flag list and keep only `bin` in config, so nothing goes through a shell.

## 6. Faking it in tests

The architecture test (with fix-arch-tests) bans `node:child_process` and any spawn of `claude` outside `llm.ts`. So `claudeCliModel` lives in `llm.ts` and takes an injectable spawn, matching the YOS-35 note `claudeCliModel(config, spawn?)`.

**Seam:** `type RunClaude = (bin: string, args: readonly string[], stdin: string, timeoutMs: number) => Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>`. The default implementation wraps `spawn`. Tests pass a fake that returns canned output and records `args` and `stdin`.

**Fixture results** (hand-written from section 2, so mark them as shape-assumed until one real result is captured and checked in as `test/fixtures/claude-cli/*.json`):

- `success.json`: `subtype: "success"`, `structured_output` an object, `total_cost_usd`, `usage`, `duration_ms`.
- `error_max_turns.json` and `error_max_structured_output_retries.json`: `is_error: true`, with cost and usage present.
- `garbage`: stdout not JSON, code 1, stderr text.
- a killed process: `code: null`, `signal: "SIGTERM"`, empty stdout.

**Test cases to write** (literal expectations):

1. The args contain `-p`, `--output-format stream-json --verbose --include-partial-messages`, `--json-schema <exact JSON.stringify(req.tool.inputSchema)>`, `--model <config model>`, `--effort <step effort>`, `--tools ""`, `--safe-mode`, `--no-session-persistence`. They never contain `--bare`, and nothing reads `ANTHROPIC_API_KEY` or `LLM_KEY`.
2. The prompt arrives on stdin, not in argv. The system prompt arrives through a file whose contents equal `req.system`.
3. success → `Proposal.input` deep-equals `structured_output`, `costUsd === total_cost_usd`, usage fields are mapped, and `advice` is `[result]`.
4. each error fixture → `ModelError`, with `billed.costUsd` equal to the fixture's `total_cost_usd`.
5. non-JSON stdout → `ModelError` naming the exit code. A killed process → timeout `ModelError`.
6. timeout: a fake that never resolves, plus an injected clock, gets SIGINT then SIGTERM, and `propose` rejects within the grace period.
7. an end-to-end smoke test through the **real** spawn path with a fake binary: write a tiny node script to a temp dir as `claude` (it prints a fixture and appends argv to a file), set `bin` to it, and assert the round trip. No network, no model.

**Live check (needs the user's OK, since it spends from the logged-in session):** one call with a 1-field schema, to pin down the `subtype` field name, the `modelUsage` shape, `--json-schema` under `--tools ""`, and the exit code for `error_max_turns`. Save the raw result as the first real fixture and drop the "shape-assumed" note.
