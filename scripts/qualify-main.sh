#!/usr/bin/env bash
# Artifact smoke only: an immutable candidate, check/proof inventory, and retained attempts.
# Full Bun/Node/E2E and live Boat acceptance remain separate release gates.
# Usage: scripts/qualify-main.sh [--ref origin/main] [--repo path-or-url] [--evidence-dir NEW-DIR]
# Reopen: scripts/qualify-main.sh --validate DIR --sha FULL-SHA
set -euo pipefail
umask 077
exec 3>&1 4>&2
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF=origin/main
REPO="$ROOT"
EVIDENCE=''
VALIDATE=''
EXPECTED_SHA=''
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --evidence-dir) EVIDENCE="${2:?--evidence-dir needs a value}"; shift 2 ;;
    --validate) VALIDATE="${2:?--validate needs a directory}"; shift 2 ;;
    --sha) EXPECTED_SHA="${2:?--sha needs a full commit SHA}"; shift 2 ;;
    *) echo 'usage: qualify-main.sh [--ref REF] [--repo REPO] [--evidence-dir NEW-DIR] or --validate DIR --sha FULL-SHA' >&2; exit 2 ;;
  esac
done
export WORLDGEN_NICE="${WORLDGEN_NICE:-15}"
# shellcheck source=runner.sh
source "$ROOT/scripts/runner.sh"
receipt() {
  js 'import(require("node:url").pathToFileURL(process.argv[1]).href)
    .then(m => m.main(process.argv.slice(2)))
    .then(code => { process.exitCode = code; })
    .catch(e => { console.error(e.message); process.exitCode = 1; });' \
    "$ROOT/code/scripts/qualification-receipt.mjs" "$1" "$EVIDENCE" "${@:2}"
}
if [ -n "$VALIDATE" ]; then
  [ -z "$EVIDENCE" ] || { echo '--validate and --evidence-dir are exclusive' >&2; exit 2; }
  EVIDENCE="$VALIDATE"
  receipt validate "$EXPECTED_SHA"
  exit $?
fi
[ -z "$EXPECTED_SHA" ] || { echo '--sha requires --validate' >&2; exit 2; }
if [ -n "$EVIDENCE" ]; then
  mkdir "$EVIDENCE" || { echo 'evidence directory must be new' >&2; exit 2; }
else
  EVIDENCE="$(mktemp -d "${TMPDIR:-/tmp}/worldgen-qualification.XXXXXX")"
fi
EVIDENCE="$(cd "$EVIDENCE" && pwd)"
receipt init "$ROOT" "$REF" "$RUNTIME"
echo "artifact-smoke evidence: $EVIDENCE" >&2
TMP=''
CLONE=''
SIGNAL=''
PIDS="$EVIDENCE/pids"
: >"$PIDS"
cleanup() {
  local code=$? receipt_code
  trap - EXIT INT TERM
  set +e
  receipt finish "$code" "$SIGNAL" "$ROOT" "$CLONE" >&3 2>&4
  receipt_code=$?
  while read -r p; do kill "$p" 2>/dev/null || true; done <"$PIDS"
  wait 2>/dev/null || true
  [ -z "$TMP" ] || rm -rf "$TMP"
  if [ -n "$SIGNAL" ]; then exit "$code"; else exit "$receipt_code"; fi
}
trap cleanup EXIT
trap 'SIGNAL=SIGINT; exit 130' INT
trap 'SIGNAL=SIGTERM; exit 143' TERM
TMP="$(mktemp -d)"
CLONE="$TMP/repo"
: >"$EVIDENCE/rows.jsonl"
capture() {
  local name="$1" code=0; shift
  receipt begin "$name" "$@" || return 1
  "$@" >"$EVIDENCE/commands/$name/stdout" 2>"$EVIDENCE/commands/$name/stderr" || code=$?
  receipt end "$name" "$code" || return 1
  if [ "$code" != 0 ]; then
    echo "$name failed (exit $code)" >&2
    tail -n 20 "$EVIDENCE/commands/$name/stderr" >&2 || true
  fi
  return "$code"
}
capture clone git clone -q --no-local "$REPO" "$CLONE"
UPSTREAM="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
case "$REF" in
  origin/*)
    if [ -n "$UPSTREAM" ]; then capture fetch git -C "$CLONE" fetch -q "$UPSTREAM" "${REF#origin/}"
    else capture fetch git -C "$CLONE" fetch -q origin "${REF#origin/}"; fi ;;
  *) capture fetch git -C "$CLONE" fetch -q origin "$REF" ;;
esac
capture checkout git -C "$CLONE" -c advice.detachedHead=false checkout -q FETCH_HEAD
receipt source "$CLONE"
cd "$CLONE/code"
capture install install_deps
# Uses the candidate's installed YAML parser on saved source bytes, not check/verify output.
capture inventory receipt inventory "$CLONE"
capture typecheck run typecheck || true
export LC_ALL=C
index=0
# Iterate world names in the order the receipt sorts them (plain names, byte order). Globbing "*/"
# sorts "gen-orders-customers/" before "gen-orders/" because '-' < '/', which paired each world
# with its neighbour's proofs.
for world_name in $(cd "$CLONE/prod/worlds" && for d in */; do printf '%s\n' "${d%/}"; done | sort); do
  dir="$CLONE/prod/worlds/$world_name"
  [ -d "$dir" ] || continue
  index=$((index + 1))
  name="world-$index"
  capture "$name-check" run worldplay check "$dir" --json || true
  vexit=0
  verify="$name-verify-1"
  capture "$verify" run worldplay verify "$dir" --json || vexit=$?
  if [ "$vexit" != 0 ]; then
    echo "verify failed for $(basename "$dir"); retaining failure and running one diagnostic retry" >&2
    tail -n 20 "$EVIDENCE/commands/$verify/stderr" "$EVIDENCE/commands/$verify/stdout" >&2 || true
    verify="$name-verify-2"
    capture "$verify" run worldplay verify "$dir" --json || true
  fi
  receipt world "$index" "$verify" >>"$EVIDENCE/rows.jsonl"
done
free_port() {
  js '
    const net = require("net");
    const listen = p => new Promise((ok, no) => { const s = net.createServer(); s.once("error", no); s.listen(p, "127.0.0.1", () => ok(s)); });
    (async () => {
      for (let i = 0; i < 100; i++) {
        const a = await listen(0), p = a.address().port;
        try { const b = await listen(p + 1); console.log(p); b.close(); a.close(); return; } catch { a.close(); }
      }
      throw new Error("no free adjacent ports");
    })().catch(e => { console.error(e.message); process.exitCode = 1; });'
}
demo() {
  local name="$1"; shift
  local port pid code=0
  if [ ! -x "$CLONE/scripts/$name" ]; then echo "missing or not executable scripts/$name" >&2; return 1; fi
  port="$(free_port)" || return 1
  nice -n 15 bash "$CLONE/scripts/$name" "$@" "$port" &
  pid=$!
  echo "$pid" >>"$PIDS"
  wait "$pid" || code=$?
  : >"$PIDS" # Never kill a reaped PID that the OS might reuse.
  return "$code"
}
capture solve-demo demo solve-demo.sh || true
capture demo demo demo.sh "$CLONE/prod/worlds/helpdesk" || true
# EXIT derives the terminal result from all retained attempts, never from the last retry alone.
