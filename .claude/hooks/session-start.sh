#!/bin/bash
# Installs Bun and the code/ dependencies so typecheck and tests work in Claude Code cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

# Later commands in the session find bun on PATH.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$BUN_INSTALL/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

cd "$CLAUDE_PROJECT_DIR/code"
bun install
