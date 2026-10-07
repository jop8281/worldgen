#!/usr/bin/env bash
# Qualify a running WorldGen Studio (YOS-192, A-314): health, an export that unzips, and optionally one live generation
# exported afterwards. Exits 1 on the first failed check. Needs curl, jq and unzip.
#
#   scripts/studio-qualify.sh [http://127.0.0.1:8787]
#   scripts/studio-qualify.sh [url] --generate <budget-usd>     # one description run, at most $2, then export its world
set -euo pipefail

URL="${1:-http://127.0.0.1:8787}"
[[ "$URL" == --* ]] && URL=http://127.0.0.1:8787
BUDGET=""
for ((i = 1; i <= $#; i++)); do [ "${!i}" = --generate ] && { j=$((i + 1)); BUDGET="${!j:?--generate needs a budget}"; }; done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; exit 1; }

health="$(curl -fsS "$URL/api/health")" || fail "GET /api/health did not answer"
[ "$(jq -r .ok <<<"$health")" = true ] || fail "health: $health"
pass "health: build $(jq -r .build <<<"$health"), $(jq -r .runtime <<<"$health"), $(jq -r .worlds <<<"$health") worlds"

export_ok() {
  local name="$1"
  code="$(curl -sS -o "$TMP/$name.zip" -w '%{http_code}' "$URL/api/worlds/$name/export")"
  [ "$code" = 200 ] || fail "export $name answered $code: $(head -c 200 "$TMP/$name.zip")"
  unzip -tq "$TMP/$name.zip" >/dev/null || fail "export $name is not a valid zip"
  unzip -l "$TMP/$name.zip" | grep -q "runs/" && fail "export $name carries runs/"
  pass "export $name: $(unzip -Z1 "$TMP/$name.zip" | tr '\n' ' ')"
}
export_ok helpdesk

if [ -n "$BUDGET" ]; then
  awk "BEGIN{exit !($BUDGET > 0 && $BUDGET <= 2)}" || fail "--generate budget must be above 0 and at most 2 USD"
  slug="qualify-$(date +%s)"
  body="$(jq -n --arg slug "$slug" --argjson b "$BUDGET" '{kind:"description", text:"A tiny bookmarks app: bookmarks with a url and a title, tagged, and archived or active", outSlug:$slug, budgetUsd:$b, maxMinutes:15}')"
  started="$(curl -fsS -X POST "$URL/api/generate" -H 'content-type: application/json' -d "$body")" || fail "POST /api/generate"
  run="$(jq -r .runId <<<"$started")"
  [ "$run" != null ] || fail "generate refused: $started"
  pass "generate started $run"
  state=""
  for _ in $(seq 1 120); do
    sleep 10
    status="$(curl -fsS "$URL/api/generate/$run")"
    state="$(jq -r .state <<<"$status")"
    case "$state" in done|stopped|failed) break ;; esac
  done
  [ "$state" = done ] || fail "generation ended $state: $(jq -c '{reason, totals}' <<<"$status")"
  pass "generation done: $(jq -c .totals <<<"$status")"
  export_ok "gen-$slug"
fi
echo "studio-qualify: all checks passed on $URL"
