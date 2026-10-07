#!/usr/bin/env bash
# Solve demo: an agent under test solves a task through the world port alone, then the admin port grades it.
#
#   scripts/solve-demo.sh [port]        # default 4200 (admin 4201)
#
# Each attempt serves a fresh copy of the world, so no admin write (reset or clock) sits between attempts.
# The only admin call is the read-only grade at the end of each attempt. Needs curl and jq, and one `cd code && bun install` (or `npm install` without Bun).
# The helpdesk attempts use hand-written calls. The petstore attempts replay the task's own `solution:` and first `decoys:`
# script over the world port (code/scripts/replay-http.ts), so the routes come from world.yaml, not from this file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-4200}"
ADMIN=$((PORT + 1))
WORLD_URL="http://127.0.0.1:$PORT"
ADMIN_URL="http://127.0.0.1:$ADMIN"

command -v jq >/dev/null 2>&1 || { echo "solve-demo.sh needs jq" >&2; exit 2; }
cd "$ROOT/code"
source "$ROOT/scripts/runner.sh"

PID=""
LOG="$(mktemp)"
stop() { [ -n "$PID" ] && { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }; return 0; }
trap 'stop; rm -f "$LOG"' EXIT

step() { printf '\n== %s\n' "$*"; }
serve() {
  stop
  ts src/cli/worldplay.ts serve "$1" --port "$PORT" >"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "$ADMIN_URL/_world/state" >/dev/null 2>&1 && return 0
    kill -0 "$PID" 2>/dev/null || { cat "$LOG"; echo "serve exited early" >&2; exit 1; }
    sleep 0.5
  done
  echo "serve did not come up" >&2; exit 1
}

# api METHOD PATH [JSON]: one call on the world port. Prints the body, fails on a non-2xx status.
api() {
  local method="$1" path="$2" body="${3:-}" out status
  out="$(mktemp)"
  if [ -n "$body" ]; then
    status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H 'content-type: application/json' -d "$body" "$WORLD_URL$path")"
  else
    status="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" "$WORLD_URL$path")"
  fi
  printf '  %s %s -> %s\n' "$method" "$path" "$status" >&2
  [ "${status#2}" != "$status" ] || { cat "$out" >&2; rm -f "$out"; echo "call failed" >&2; exit 1; }
  cat "$out"; rm -f "$out"
}

# grade TASK EXPECT: the admin port, read-only. Fails when the score text differs from EXPECT (1 or "<1").
grade() {
  local score
  score="$(curl -sS -X POST "$ADMIN_URL/_world/grade/$1" | jq -r '.score')"
  printf '  grade %s: score %s\n' "$1" "$(printf '%.3f' "$score")"
  case "$2" in
    1) [ "$(printf '%.3f' "$score")" = "1.000" ] || { echo "expected score 1.000" >&2; exit 1; } ;;
    *) awk -v s="$score" 'BEGIN { exit !(s < 1) }' || { echo "expected score below 1" >&2; exit 1; } ;;
  esac
}

HELPDESK="$ROOT/prod/worlds/helpdesk"
PETSTORE="$ROOT/prod/worlds/gen-petstore"

helpdesk_customer() { api GET '/customers?q=Acme' | jq -r '.data[] | select(.name == "Acme Logistics") | .id'; }
helpdesk_priya() { api GET '/agents?q=Priya+Raman' | jq -r '.data[] | select(.name == "Priya Raman") | .id'; }

step "helpdesk assign_newest_acme_ticket: reference solution, world port only"
serve "$HELPDESK"
acme="$(helpdesk_customer)"
newest="$(api GET "/tickets?customer_id=$acme&status=new&sort=-created_at&limit=1" | jq -r '.data[0].id')"
priya="$(helpdesk_priya)"
api POST "/tickets/$newest/assign" "{\"agent_id\":\"$priya\"}" >/dev/null
grade assign_newest_acme_ticket 1

step "helpdesk assign_newest_acme_ticket: decoy, PATCH status to open instead of assigning"
serve "$HELPDESK"
acme="$(helpdesk_customer)"
newest="$(api GET "/tickets?customer_id=$acme&status=new&sort=-created_at&limit=1" | jq -r '.data[0].id')"
api PATCH "/tickets/$newest" '{"status":"open"}' >/dev/null
grade assign_newest_acme_ticket below1

replay() { tsrun scripts/replay-http.ts "$PETSTORE" "$1" "$2" "$WORLD_URL"; }

step "gen-petstore: reference solution replayed from world.yaml, world port only"
serve "$PETSTORE"
TASK="$(replay auto solution)"
[ -n "$TASK" ] || { echo "replayer picked no task" >&2; exit 1; }
echo "  task $TASK"
grade "$TASK" 1

step "gen-petstore $TASK: first decoy replayed from world.yaml"
serve "$PETSTORE"
replay "$TASK" decoy >/dev/null
grade "$TASK" below1

step "stop"
