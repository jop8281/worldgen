#!/usr/bin/env bash
# Engine demo: check and verify a world, serve it, call the world port and the admin port, stop.
#
#   scripts/demo.sh [world-dir] [port]        # defaults: prod/worlds/helpdesk, 4000 (admin 4001)
#
# Run from anywhere after one `cd code && bun install` (or `npm install` without Bun). Needs curl; jq is used when present.
# LIST (default /tickets) is the list route to call, TASK the task to grade.
# LIST=auto picks the first GET route without a path parameter from /openapi.json; TASK=auto grades the first task.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORLD="$(cd "${1:-$ROOT/prod/worlds/helpdesk}" && pwd)"
PORT="${2:-4000}"
ADMIN=$((PORT + 1))
LIST="${LIST:-/tickets}"
TASK="${TASK:-assign_newest_acme_ticket}"
WORLD_URL="http://127.0.0.1:$PORT"
ADMIN_URL="http://127.0.0.1:$ADMIN"

cd "$ROOT/code"
source "$ROOT/scripts/runner.sh"

step() { printf '\n== %s\n' "$*"; }
# Prints JSON from stdin through an optional jq filter (when jq exists), capped at 1500 chars.
show() {
  local out
  out="$(cat)"
  if command -v jq >/dev/null 2>&1; then out="$(printf '%s' "$out" | jq -c "${1:-.}")"; fi
  printf '%.1500s\n' "$out"
}

step "check $WORLD"
run worldplay check "$WORLD"

step "verify: per task, solution 1, noop 0, decoys below 1"
run worldplay verify "$WORLD"

step "serve on $PORT (admin $ADMIN), runtime $RUNTIME"
LOG="$(mktemp)"
# The entry directly, not a package script, so the PID below is the server itself and the trap stops it.
ts src/cli/worldplay.ts serve "$WORLD" --port "$PORT" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -f "$LOG"' EXIT

for _ in $(seq 1 60); do
  curl -fsS "$ADMIN_URL/_world/state" >/dev/null 2>&1 && break
  if ! kill -0 "$PID" 2>/dev/null; then cat "$LOG"; echo "serve exited early" >&2; exit 1; fi
  sleep 0.5
done
cat "$LOG"
echo "console: $ADMIN_URL/"

if [ "$LIST" = auto ]; then
  LIST="$(curl -sS "$WORLD_URL/openapi.json" | js 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).paths;console.log(Object.keys(p).find(k=>p[k].get&&!k.includes("{"))??"/")})')"
fi
if [ "$TASK" = auto ]; then
  TASK="$(run worldplay verify "$WORLD" --json | head -1 | js 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).task))')"
fi

step "GET $LIST (world port, what the agent under test sees)"
curl -sS "$WORLD_URL$LIST" | show 'if type == "object" and has("data") then {count: (.data | length), first: .data[0]} else . end'

step "GET /openapi.json (world port)"
curl -sS "$WORLD_URL/openapi.json" | show '{openapi, title: .info.title, paths: (.paths | keys)}'

step "GET /_world/state (admin port)"
curl -sS "$ADMIN_URL/_world/state" | show '{now, rows: (.tables | map_values(length))}'

step "POST /_world/grade/$TASK (admin port; nothing was done, so expect 0)"
curl -sS -X POST "$ADMIN_URL/_world/grade/$TASK" | show

step "GET /_world/state on the world port is hidden from the agent (expect 404)"
curl -sS -o /dev/null -w '%{http_code}\n' "$WORLD_URL/_world/state"

step "stop"
