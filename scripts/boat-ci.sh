#!/usr/bin/env bash
# Run the full check on a ref in a large Boat VM: `bun run check` and `npm run check:node` in parallel.
#
#   scripts/boat-ci.sh <ref>        # e.g. origin/main; needs BOAT_API_KEY and WORLDGEN_BOAT_ORG in the environment
#
# When the ref has scripts/factory-check.sh, it runs as a third job, and its junit.xml lands in $BOAT_CI_JUNIT_DIR (default /tmp/claude-501).
# Prints each runtime's exit code, test counts and failing test names, then a PASS/FAIL line. The VM always goes down.
# The VM is metered (YOS-233): export BOAT_USD_PER_COMPUTE_HOUR and a WORLDGEN_MAX_DAILY_SANDBOX_USD that covers a large VM's
# 2-hour TTL. WORLDGEN_MAX_DAILY_USD and WORLDGEN_MAX_TOTAL_USD may stay unset (research/demo-runbook.md, Live segment).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${1:?usage: scripts/boat-ci.sh <ref>}"
[ -n "${BOAT_API_KEY:-}" ] || { echo "boat-ci.sh needs BOAT_API_KEY" >&2; exit 2; }
[ -n "${WORLDGEN_BOAT_ORG:-}" ] || { echo "boat-ci.sh needs WORLDGEN_BOAT_ORG: the one Boat organization (wallet) this machine bills to (A-247)" >&2; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SHA="$(git -C "$ROOT" rev-parse --short "$REF")"
git -C "$ROOT" archive --format=tar.gz -o "$TMP/repo.tgz" "$REF"
cd "$ROOT/code"
bun scripts/boat-ci.ts "$TMP/repo.tgz" "$REF@$SHA" "${BOAT_CI_JUNIT_DIR:-/tmp/claude-501}/factory-junit-$SHA.xml"
