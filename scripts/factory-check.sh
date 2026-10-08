#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mkdir -p .factory
rm -f .factory/junit.xml

if [[ "$(bun --version)" != "1.4.2" ]]; then
  echo 'Factory verification requires Bun 1.4.2.' >&2
  exit 1
fi

cd code
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 480000 --max-concurrency 1 --reporter=junit --reporter-outfile="$root/.factory/junit.xml" ./test
test -s "$root/.factory/junit.xml"
