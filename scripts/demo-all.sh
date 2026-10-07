#!/usr/bin/env bash
# The whole system end to end, as one numbered demo with a PASS/FAIL line per step and a summary table.
#
#   scripts/demo-all.sh                     # offline: no model call, no paid call
#   scripts/demo-all.sh --live ["<prompt>"] # also one WorldGen run ($3 budget) into a temp dir, then check, verify, serve it
#
# Needs curl and jq, and one `cd code && bun install` (or `npm install` without Bun). Exits 1 when any step fails.
# Every server it starts is stopped on exit. The talk track is research/demo-runbook.md.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORLDS="$ROOT/prod/worlds"
HELPDESK="$WORLDS/helpdesk"
# One generated world per input kind, plus one changed by an iterate run. Override with DESCRIPTION_WORLD and so on.
GENERATED="description:${DESCRIPTION_WORLD:-gen-rental-fleet} openapi:${OPENAPI_WORLD:-gen-stripe-charges} csv:${CSV_WORLD:-gen-library-loans} iterate:${ITERATE_WORLD:-gen-repair-desk}"
SHOW_WORLD="$WORLDS/${SHOW_WORLD:-gen-library-loans}"
LIVE=0
PROMPT="A dental clinic front desk: patients, appointments that are booked, checked in, completed or marked no-show, and a nightly job that cancels unconfirmed appointments"

case "${1:-}" in
  --live) LIVE=1; [ -n "${2:-}" ] && PROMPT="$2" ;;
  -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
  "") ;;
  *) echo "demo-all.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
esac

command -v curl >/dev/null 2>&1 || { echo "demo-all.sh needs curl" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "demo-all.sh needs jq" >&2; exit 2; }
cd "$ROOT/code"
source "$ROOT/scripts/runner.sh"

PID=""
LOG="$(mktemp)"
OUT="$(mktemp)"
RESULTS="$(mktemp)"
stop_server() { [ -n "$PID" ] && { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }; return 0; }
trap 'stop_server; rm -f "$LOG" "$OUT" "$RESULTS"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

N=0
step() { N=$((N + 1)); printf '\n== [%d] %s\n' "$N" "$*"; }
# record STATUS DETAIL: the PASS/FAIL line for the current step, kept for the summary.
record() {
  printf '%s %s\n' "$1" "$2"
  printf '%s|%s|%s\n' "$N" "$1" "$2" >>"$RESULTS"
}
pass() { record PASS "$*"; }
fail() { record FAIL "$*"; }
# expect DETAIL COMMAND...: PASS when the command exits 0. Its output streams to the screen.
expect() {
  local detail="$1"; shift
  if "$@"; then pass "$detail"; else fail "$detail (exit $?)"; fi
}

free_port() {
  js 'const n=require("node:net");const take=()=>new Promise(r=>{const s=n.createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>r(p))})});const free=p=>new Promise(r=>{const s=n.createServer().once("error",()=>r(false)).listen(p,"127.0.0.1",()=>s.close(()=>r(true)))});(async()=>{for(;;){const p=await take();if(p<65535&&await free(p+1)){console.log(p);return}}})()'
}

# serve WORLD: starts the world on a free port pair and sets WORLD_URL and ADMIN_URL. Returns 1 if it never answers.
serve() {
  stop_server
  local port
  port="$(free_port)"
  WORLD_URL="http://127.0.0.1:$port"
  ADMIN_URL="http://127.0.0.1:$((port + 1))"
  # The entry directly, not a package script, so $! is the server itself and stop_server stops it.
  ts src/cli/worldplay.ts serve "$1" --port "$port" >"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "$ADMIN_URL/_world/state" >/dev/null 2>&1 && { cat "$LOG"; return 0; }
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  cat "$LOG"
  return 1
}

# call METHOD URL [JSON]: the body goes to $OUT, the status code to stdout.
call() {
  if [ -n "${3:-}" ]; then
    curl -sS -o "$OUT" -w '%{http_code}' -X "$1" -H 'content-type: application/json' -d "$3" "$2"
  else
    curl -sS -o "$OUT" -w '%{http_code}' -X "$1" "$2"
  fi
}
body() { jq -c "$1" "$OUT" 2>/dev/null | cut -c1-600; }

# section TITLE LINES: the first LINES lines of one REPORT.md section of SHOW_WORLD.
section() {
  awk -v t="## $1" '$0 == t {on=1} on && /^## / && $0 != t {exit} on' "$SHOW_WORLD/REPORT.md" | head -"$2" | cut -c1-220
}

check_and_verify() {
  local world="$1" label="$2"
  step "worldplay check $label"
  expect "check $(basename "$world")" run worldplay check "$world"
  step "worldplay verify $label: per task, solution 1, noop 0, decoys and prefixes below 1"
  expect "verify $(basename "$world")" run worldplay verify "$world"
}

# serve_auto WORLD LABEL: serve any world, read its first list route from /openapi.json and grade its first task.
serve_auto() {
  local world="$1" label="$2" list task status
  step "serve $label, list its first collection route, grade its first task"
  if ! serve "$world"; then fail "serve $(basename "$world") never answered"; return; fi
  call GET "$WORLD_URL/openapi.json" >/dev/null
  list="$(jq -r '.paths | to_entries | map(select(.value.get and (.key | contains("{") | not))) | .[0].key // empty' "$OUT")"
  task="$(run worldplay verify "$world" --json | head -1 | jq -r '.task // empty')"
  status="$(call GET "$WORLD_URL$list")"
  echo "GET $list -> $status $(body '{count: (.data | length)}')"
  if [ -z "$list" ] || [ "$status" != 200 ]; then fail "GET ${list:-<no list route>} answered $status"; stop_server; return; fi
  if [ -z "$task" ]; then fail "verify --json named no task"; stop_server; return; fi
  status="$(call POST "$ADMIN_URL/_world/grade/$task")"
  echo "POST /_world/grade/$task -> $status $(body .)"
  if [ "$status" = 200 ] && [ "$(jq -r '.score' "$OUT")" = 0 ]; then
    pass "GET $list 200, untouched $task grades 0"
  else
    fail "grade $task answered $status"
  fi
  stop_server
}

run_live() {
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/demo-live.XXXXXX")"
  step "live: env check (claude login, spend caps), no model call"
  if bash "$ROOT/scripts/live.sh" --env-only; then
    pass "live.sh --env-only"
  else
    fail "live.sh --env-only (exit $?), so no model call was made"
    return
  fi
  step "live: worldgen \"$PROMPT\" --budget-usd 3 --out $dir"
  if ! run worldgen "$PROMPT" --budget-usd 3 --out "$dir"; then
    fail "worldgen stopped; see $dir/REPORT.md"
    return
  fi
  pass "worldgen wrote $dir"
  check_and_verify "$dir" "the live world"
  serve_auto "$dir" "the live world"
  echo "live world kept at $dir"
}

echo "demo-all: runtime $RUNTIME, root $ROOT$([ "$LIVE" = 1 ] && echo ', --live')"

check_and_verify "$HELPDESK" "helpdesk (hand-built golden world)"

for entry in $GENERATED; do
  kind="${entry%%:*}"
  if [ "$kind" = iterate ]; then how="changed by an iterate run"; else how="generated from $kind input"; fi
  check_and_verify "$WORLDS/${entry#*:}" "${entry#*:} ($how)"
done

step "serve helpdesk: the world port and the admin port"
if serve "$HELPDESK"; then
  pass "world $WORLD_URL, admin $ADMIN_URL"

  step "GET /tickets on the world port (what the agent under test sees)"
  status="$(call GET "$WORLD_URL/tickets")"
  echo "-> $status $(body '{count: (.data | length), first: .data[0] | {id, subject, status, priority}}')"
  if [ "$status" = 200 ] && [ "$(jq '.data | length' "$OUT" 2>/dev/null || echo 0)" -gt 0 ]; then pass "GET /tickets 200 with rows"; else fail "GET /tickets answered $status"; fi

  step "GET /openapi.json on the world port"
  status="$(call GET "$WORLD_URL/openapi.json")"
  echo "-> $status $(body '{openapi, title: .info.title, paths: (.paths | keys | length)}')"
  if [ "$status" = 200 ] && [ "$(jq -r '.openapi' "$OUT")" = 3.1.0 ]; then pass "OpenAPI 3.1.0 document"; else fail "/openapi.json answered $status"; fi

  step "GET /_world/state on the admin port"
  status="$(call GET "$ADMIN_URL/_world/state")"
  before="$(jq -r '.now' "$OUT")"
  echo "-> $status $(body '{now, rows: (.tables | map_values(length))}')"
  if [ "$status" = 200 ] && [ -n "$before" ]; then pass "state at $before"; else fail "/_world/state answered $status"; fi

  step "POST /_world/clock {\"advance\":\"4h\"}: time moves and scheduled jobs fire"
  status="$(call POST "$ADMIN_URL/_world/clock" '{"advance":"4h"}')"
  after="$(jq -r '.now' "$OUT")"
  echo "-> $status $(body '{now, jobsFired: (.jobsFired | group_by(.) | map({(.[0]): length}) | add), jobsFailed}')"
  if [ "$status" = 200 ] && [ "$after" != "$before" ] && [ "$(jq '.jobsFailed | length' "$OUT")" = 0 ]; then
    pass "clock $before -> $after, $(jq '.jobsFired | length' "$OUT") job runs, none failed"
  else
    fail "clock advance answered $status"
  fi

  step "POST /_world/grade/assign_newest_acme_ticket: nothing was done, so expect 0"
  status="$(call POST "$ADMIN_URL/_world/grade/assign_newest_acme_ticket")"
  echo "-> $status $(body .)"
  if [ "$status" = 200 ] && [ "$(jq -r '.score' "$OUT")" = 0 ]; then pass "score 0"; else fail "grade answered $status"; fi

  step "PATCH /tickets/tkt_0001 {priority: low, status: new}: an illegal move is refused whole"
  status="$(call PATCH "$WORLD_URL/tickets/tkt_0001" '{"priority":"low","status":"new"}')"
  echo "-> $status $(body .error)"
  code="$(jq -r '.error.code' "$OUT" 2>/dev/null)"
  call GET "$WORLD_URL/tickets/tkt_0001" >/dev/null
  echo "GET /tickets/tkt_0001 -> $(body '{status, priority}')"
  if [ "$status" = 422 ] && [ "$code" = state.transition ] && [ "$(jq -r '.priority' "$OUT")" = high ]; then
    pass "422 $code, priority still high"
  else
    fail "PATCH answered $status $code"
  fi

  step "GET /_world/log on the admin port: every call with its writes"
  status="$(call GET "$ADMIN_URL/_world/log")"
  echo "-> $status $(body '{calls: (.calls | length), last: (.calls[-1] | {seq, req: (.req.method + " " + .req.path), status: .res.status, writes: (.writes | length)})}')"
  if [ "$status" = 200 ] && [ "$(jq '.calls | length' "$OUT" 2>/dev/null || echo 0)" -gt 0 ]; then pass "$(jq '.calls | length' "$OUT") calls logged"; else fail "/_world/log answered $status"; fi

  step "POST /_world/reset: back to the seed and the start clock"
  status="$(call POST "$ADMIN_URL/_world/reset")"
  echo "-> $status $(body .)"
  if [ "$status" = 200 ] && [ "$(jq -r '.now' "$OUT")" \< "$after" ]; then pass "reset to $(jq -r '.now' "$OUT")"; else fail "reset answered $status"; fi

  step "GET /_world/state on the world port: the admin routes are hidden from the agent"
  status="$(call GET "$WORLD_URL/_world/state")"
  echo "-> $status $(body .error)"
  if [ "$status" = 404 ]; then pass "404 on the world port"; else fail "world port answered $status"; fi
else
  fail "serve helpdesk never answered"
fi
stop_server

serve_auto "$WORLDS/${DESCRIPTION_WORLD:-gen-rental-fleet}" "${DESCRIPTION_WORLD:-gen-rental-fleet}"

step "scripts/solve-demo.sh: solve over the world port alone, grade on the admin port, decoys below 1"
expect "solve-demo.sh" bash "$ROOT/scripts/solve-demo.sh" "$(free_port)"

step "eval --dry-run: the rehearsal suite parses and every input resolves, no model call"
if run eval --dry-run >"$LOG" 2>&1; then
  tail -4 "$LOG"
  pass "$(tail -1 "$LOG")"
else
  cat "$LOG"
  fail "eval --dry-run failed"
fi

step "worldgen --help"
if run worldgen --help >"$LOG" 2>&1 && grep -q '^usage:' "$LOG"; then
  sed -n '1,6p' "$LOG"
  pass "usage printed"
else
  cat "$LOG"
  fail "worldgen --help failed"
fi

step "$(basename "$SHOW_WORLD"): plan.yaml, REPORT.md and run events"
events="$(ls "$SHOW_WORLD"/runs/*/events.jsonl 2>/dev/null | tail -1)"
if [ -f "$SHOW_WORLD/plan.yaml" ] && [ -f "$SHOW_WORLD/REPORT.md" ] && [ -n "$events" ]; then
  echo "-- plan.yaml (software, summary, assumptions)"
  grep -E '^(software|summary):' "$SHOW_WORLD/plan.yaml" | cut -c1-300
  awk '/^assumptions:/ {on=1; print; next} on && /^[a-zA-Z_]+:/ {exit} on' "$SHOW_WORLD/plan.yaml" | head -7 | cut -c1-200
  echo "-- REPORT.md sections"
  grep '^## ' "$SHOW_WORLD/REPORT.md"
  section "Questions asked of the input" 7
  section "Proof" 12
  section "Run" 12
  echo "-- $events"
  jq -c 'select(.t == "run_started") | {mode, input, model, transport, budgetUsd}' "$events"
  jq -r '.t' "$events" | sort | uniq -c | sort -rn | head -8
  finished="$(jq -c 'select(.t == "run_finished") | {result: .result.kind, worldWritten, costUsd, ms}' "$events" | tail -1)"
  echo "$finished"
  if [ -n "$finished" ]; then pass "plan, report and events present; finished $finished"; else fail "no run_finished event in $events"; fi
else
  fail "missing plan.yaml, REPORT.md or runs/*/events.jsonl in $SHOW_WORLD"
fi

[ "$LIVE" = 1 ] && run_live

printf '\n== summary\n'
printf '%-4s %-5s %s\n' step state detail
while IFS='|' read -r n state detail; do printf '%-4s %-5s %s\n' "$n" "$state" "$detail"; done <"$RESULTS"
passed="$(grep -c '|PASS|' "$RESULTS")"
failed="$(grep -c '|FAIL|' "$RESULTS")"
printf '%s passed, %s failed, %ss\n' "$passed" "$failed" "$SECONDS"
[ "$failed" = 0 ]
