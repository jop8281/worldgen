#!/usr/bin/env bash
# One command for a live WorldGen demo on an unseen prompt: env check, the run, then check, verify and a served demo of the result.
#
#   scripts/live.sh <slug> "<description>"
#   scripts/live.sh <slug> --openapi <spec> [--only /v1/refunds]
#   scripts/live.sh <slug> --csv <file>...
#   scripts/live.sh --env-only            # just the env check: no model call, nothing written
#   scripts/live.sh --dry-run <slug> ...  # env check, then print the run command and stop
#
# The world lands in prod/worlds/gen-<slug>/. A stopped run writes no world.yaml; its REPORT.md in that folder says why.
# Limits are the A-48 defaults: $5 and 15 minutes. Export WORLDGEN_MAX_DAILY_USD and WORLDGEN_MAX_TOTAL_USD first.
# Until worldgen-44's hang fix merges, a description run can hang: if one step shows no output for 3 minutes, Ctrl-C it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE=run
case "${1:-}" in
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  --env-only) MODE=env; shift ;;
  --dry-run) MODE=dry; shift ;;
esac

source "$ROOT/scripts/runner.sh"
step() { printf '\n== %s\n' "$*"; }
die() { printf 'live.sh: %s\n' "$*" >&2; exit 2; }

step "env check"
BIN="${WORLDGEN_CLAUDE_BIN:-$HOME/.local/bin/claude}"
[ -x "$BIN" ] || die "claude binary not found at $BIN: install Claude Code, or set WORLDGEN_CLAUDE_BIN to the absolute path of the real binary, not a shell shim"
echo "claude: $BIN ($("$BIN" --version 2>&1 | head -1))"
"$BIN" auth status >/dev/null 2>&1 || die "claude is not logged in: run \`$BIN auth login\`"
echo "claude auth: logged in"
[ -z "${ANTHROPIC_API_KEY:-}" ] || die "ANTHROPIC_API_KEY is set: unset it, the default transport uses your logged-in session"
for cap in WORLDGEN_MAX_DAILY_USD WORLDGEN_MAX_TOTAL_USD; do
  [ -n "${!cap:-}" ] || die "$cap is not set: export it (USD, for example 25) so the spend ledger can refuse overspend"
  echo "$cap=${!cap}"
done
grep -E '"maxCostUsd"|"maxMinutes"' "$ROOT/code/worldgen.config.json" | tr -d ' \n'; echo
# Boat steps only (sandbox up, dataset, boat-ci) need the pinned organization (A-247); this run has none, so it is reported, not required.
echo "WORLDGEN_BOAT_ORG=${WORLDGEN_BOAT_ORG:-(unset; needed only for Boat steps)}"
LOAD="$(js 'const os=require("node:os");console.log(os.loadavg()[0].toFixed(0)+" "+os.cpus().length)')"
echo "load average (1 min) / cpus: ${LOAD% *} / ${LOAD#* }"
[ "${LOAD% *}" -le $(( 2 * ${LOAD#* } )) ] || echo "live.sh: warning: the machine is heavily loaded; a run can lose its model-call time share, and snippets can hit their 2 s guard. Stop other WorldGen sessions first." >&2
export WORLDGEN_CLAUDE_BIN="$BIN"
[ "$MODE" = env ] && { echo "env ok"; exit 0; }

[ "$#" -ge 2 ] || die "usage: scripts/live.sh [--dry-run] <slug> \"<description>\" | --openapi <spec> [--only <prefix>] | --csv <file>..."
SLUG="$1"; shift
[[ "$SLUG" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "slug must be lowercase kebab-case, got $SLUG"
OUT="$ROOT/prod/worlds/gen-$SLUG"
[ ! -e "$OUT" ] || die "$OUT already exists: pick another slug"

cd "$ROOT/code"
step "run ($RUNTIME): worldgen $* --out $OUT --budget-usd 5 --max-minutes 15"
[ "$MODE" = dry ] && { echo "dry run: stopping before the model call"; exit 0; }
date +%T
run worldgen "$@" --out "$OUT" --budget-usd 5 --max-minutes 15 || { rc=$?; echo "worldgen exited $rc: read $OUT/REPORT.md (a stop writes no world.yaml)" >&2; exit "$rc"; }

step "check"
run worldplay check "$OUT"
step "verify"
run worldplay verify "$OUT"

step "artifacts"
ls "$OUT/world.yaml" "$OUT/plan.yaml" "$OUT/REPORT.md" "$OUT"/runs/*/events.jsonl

step "served demo (world port, then admin grade)"
LIST=auto TASK=auto "$ROOT/scripts/demo.sh" "$OUT" 4300
echo
echo "done: $OUT. Serve it with: cd code && bun run worldplay serve $OUT --port 4000"
