#!/usr/bin/env bash
# Presentation-only wrapper. Uses the existing, pinned demo; it never adds --live.
# prepare: new detached worktree + locked dependency installation (network may be used).
# rehearse: no fetch, installation, model request, or Boat provisioning.
# This is not a full test suite, release qualifier, or process-tree cleanup certificate.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA="${WORLDGEN_DEMO_SHA:-}"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Set WORLDGEN_DEMO_SHA to the immutable full 40-character commit SHA chosen for this demo." >&2
  exit 2
fi
DEMO="${WORLDGEN_DEMO_DIR:-$HOME/worldgen-demo-${SHA:0:8}}"
MODE="${1:-}"
case "$MODE" in
  prepare|rehearse) ;;
  *) echo "Usage: WORLDGEN_DEMO_SHA=FULL_SHA bash scripts/demo-rehearsal.sh prepare|rehearse" >&2; exit 2 ;;
esac

export WORLDGEN_RUNTIME=bun
# The shared runner owns the mandatory Bun pin. This wrapper never opts into Node.
source "$ROOT/scripts/runner.sh"

for tool in git curl jq shasum tee; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Missing prerequisite: $tool. Stop; do not upgrade during the presentation." >&2
    exit 2
  }
done
EVIDENCE="$(mktemp -d "$HOME/worldgen-demo-${MODE}-${SHA:0:8}.XXXXXX")"
printf 'Evidence: %s\n' "$EVIDENCE"
printf '%s\n' "$SHA" >"$EVIDENCE/expected-source.txt"
shasum -a 256 "$ROOT/scripts/demo-rehearsal.sh" "$ROOT/scripts/runner.sh" >"$EVIDENCE/tooling.sha256"
{
  printf 'Bun executable: '; command -v bun
  printf 'Bun version: '; bun --version
  printf 'Bash version: %s\n' "$BASH_VERSION"
  printf 'Worktree: %s\n' "$DEMO"
  printf 'Mode: %s\n' "$MODE"
  date -u '+Recorded: %Y-%m-%dT%H:%M:%SZ'
} >"$EVIDENCE/runtime.txt"
printf '%s\n' 'PREPARED/REHEARSED are separate from release qualification. Screen recording and local cleanup require operator review.' >"$EVIDENCE/scope.txt"

if [ "$MODE" = prepare ]; then
  if [ -e "$DEMO" ] || [ -L "$DEMO" ]; then
    echo "Refusing to overwrite $DEMO. Preserve an existing rehearsal." >&2
    exit 2
  fi
  git -C "$ROOT" fetch origin "$SHA" >"$EVIDENCE/fetch.log" 2>&1 || {
    echo "Fetch failed. See $EVIDENCE/fetch.log" >&2; exit 1;
  }
  git -C "$ROOT" cat-file -e "${SHA}^{commit}"
  git -C "$ROOT" worktree add --detach "$DEMO" "$SHA" >"$EVIDENCE/worktree.log" 2>&1
  [ "$(git -C "$DEMO" rev-parse HEAD)" = "$SHA" ]
  if (cd "$DEMO/code" && install_deps) >"$EVIDENCE/install.log" 2>&1; then
    printf '0\n' >"$EVIDENCE/install-exit.txt"
  else
    code=$?
    printf '%s\n' "$code" >"$EVIDENCE/install-exit.txt"
    echo "Installation failed; worktree and private log are retained. No demo ran." >&2
    exit 1
  fi
  [ -z "$(git -C "$DEMO" status --porcelain --untracked-files=no)" ] || {
    echo "Preparation changed tracked source. Inspect it before rehearsing." >&2; exit 1;
  }
  git -C "$DEMO" rev-parse HEAD >"$EVIDENCE/source.txt"
  echo "PREPARED, NOT REHEARSED: $DEMO"
  echo "Next: run this wrapper with rehearse. No model or Boat work was requested."
  exit 0
fi

[ -d "$DEMO/code/node_modules" ] || {
  echo "Prepared dependencies are missing. Run prepare for a new checkout first." >&2; exit 2;
}
[ "$(git -C "$DEMO" rev-parse HEAD)" = "$SHA" ] || {
  echo "Worktree SHA mismatch; refusing the demo." >&2; exit 2;
}
git -C "$DEMO" status --porcelain --untracked-files=no >"$EVIDENCE/source-status-before.txt"
[ ! -s "$EVIDENCE/source-status-before.txt" ] || {
  echo "Tracked source is modified; refusing the demo." >&2; exit 2;
}
git -C "$DEMO" rev-parse HEAD >"$EVIDENCE/source.txt"
(
  cd "$DEMO"
  shasum -a 256 scripts/demo-all.sh scripts/runner.sh scripts/solve-demo.sh code/package.json code/bun.lock
  for world in helpdesk gen-rental-fleet gen-stripe-charges gen-library-loans gen-repair-desk gen-petstore; do
    shasum -a 256 "prod/worlds/$world/world.yaml"
  done
) >"$EVIDENCE/source-artifacts.sha256"

export WORLDGEN_RUNTIME=bun
# Keep this rehearsed profile independent of inherited world-selection overrides.
unset DESCRIPTION_WORLD OPENAPI_WORLD CSV_WORLD ITERATE_WORLD SHOW_WORLD
# Not an OS security boundary: the reviewed no-argument demo has no provider call.
unset BOAT_API_KEY LLM_KEY
curl() {
  command curl --disable --noproxy '*' --connect-timeout 3 --max-time 15 "$@"
}
export -f curl
printf '%s\n' 'bash scripts/demo-all.sh (no arguments; no --live)' >"$EVIDENCE/command.txt"
printf '%s\n' 'Full-process timeout and descendant cleanup are not certified by this wrapper.' >"$EVIDENCE/scope.txt"

set +e
(cd "$DEMO" && bash scripts/demo-all.sh) 2>&1 | tee "$EVIDENCE/demo.log"
statuses=("${PIPESTATUS[@]}")
set -e
printf 'demo=%s\ntee=%s\n' "${statuses[0]}" "${statuses[1]}" >"$EVIDENCE/exits.txt"
git -C "$DEMO" status --porcelain --untracked-files=no >"$EVIDENCE/source-status-after.txt"

[ "${statuses[0]}" -eq 0 ] && [ "${statuses[1]}" -eq 0 ] || {
  echo "REHEARSAL FAILED: retain this attempt; do not silently retry until green." >&2
  exit 1
}
grep -Eq '^25 passed, 0 failed, [0-9]+s$' "$EVIDENCE/demo.log" || {
  echo "REHEARSAL FAILED: expected complete 25-step summary is absent." >&2; exit 1;
}
[ "$(git -C "$DEMO" rev-parse HEAD)" = "$SHA" ] && [ ! -s "$EVIDENCE/source-status-after.txt" ] || {
  echo "REHEARSAL FAILED: source changed during execution." >&2; exit 1;
}
(cd "$DEMO" && shasum -a 256 -c "$EVIDENCE/source-artifacts.sha256") >"$EVIDENCE/source-recheck.txt" 2>&1 || {
  echo "REHEARSAL FAILED: source/artifact hashes changed." >&2; exit 1;
}
shasum -a 256 "$EVIDENCE/demo.log" >"$EVIDENCE/demo-log.sha256"
echo "OFFLINE REHEARSAL PASSED: $SHA"
echo "This is not release qualification, fresh generation, or a Boat/LLM solver run."
echo "Evidence: $EVIDENCE"
