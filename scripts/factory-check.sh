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
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Factory verification requires Node 22 or newer."); process.exit(1); }'

cd code
bun install --frozen-lockfile
bun run typecheck
bun run node --import tsx --test --test-concurrency=1 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination="$root/.factory/junit.xml" \
  test/*.test.ts
test -s "$root/.factory/junit.xml"
