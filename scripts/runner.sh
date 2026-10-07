# Sourced by demo and qualification scripts. Bun is required by default (U-12, YOS-88).
#
# run SCRIPT [args...] executes a package script from code/.
# ts FILE [args...] execs TypeScript (background it so $! is the actual process).
# tsrun FILE [args...] runs TypeScript in the foreground; js CODE evaluates JavaScript.
# install_deps installs only locked dependencies.
# WORLDGEN_RUNTIME=node is an explicit compatibility-only opt-in, never a fallback.
# WORLDGEN_NICE=N applies nice to commands. This file must also work on Bash 3.2.

WORLDGEN_BUN_VERSION=1.4.2
export WORLDGEN_RUNTIME="${WORLDGEN_RUNTIME:-bun}"
_niced() { if [ -n "${WORLDGEN_NICE:-}" ]; then nice -n "$WORLDGEN_NICE" "$@"; else "$@"; fi; }
_exec_niced() { if [ -n "${WORLDGEN_NICE:-}" ]; then exec nice -n "$WORLDGEN_NICE" "$@"; else exec "$@"; fi; }

case "$WORLDGEN_RUNTIME" in
  bun)
    command -v bun >/dev/null 2>&1 || {
      echo "WorldGen requires Bun $WORLDGEN_BUN_VERSION. Bun is missing; Node fallback is disabled." >&2
      exit 2
    }
    _bun_version="$(bun --version)" || {
      echo 'Cannot verify the Bun executable; refusing to run.' >&2; exit 2;
    }
    [ "$_bun_version" = "$WORLDGEN_BUN_VERSION" ] || {
      echo "WorldGen requires Bun $WORLDGEN_BUN_VERSION; found $_bun_version. No automatic runtime substitution." >&2
      exit 2
    }
    unset _bun_version
    RUNTIME=bun
    run() { local script="$1"; shift; _niced bun run --no-env-file --silent "$script" "$@"; }
    ts() { _exec_niced bun --no-env-file "$@"; }
    tsrun() { _niced bun --no-env-file "$@"; }
    js() { local code="$1"; shift; _niced bun --no-env-file -e "$code" "$@"; }
    install_deps() { _niced bun install --no-env-file --frozen-lockfile; }
    ;;
  node)
    command -v node >/dev/null 2>&1 || { echo 'Explicit Node compatibility runtime is missing.' >&2; exit 2; }
    RUNTIME=node
    # Product package scripts name Bun: compatibility must not delegate back to them.
    run() {
      local script="$1"; shift
      case "$script" in
        worldplay|worldgen|eval|live|sandbox|costs|dataset) tsrun "src/cli/$script.ts" "$@" ;;
        docs) tsrun src/cli/worldplay.ts docs "$@" ;;
        *) _niced npm run --silent "$script" -- "$@" ;;
      esac
    }
    ts() { _exec_niced node --import tsx "$@"; }
    tsrun() { _niced node --import tsx "$@"; }
    js() { local code="$1"; shift; _niced node -e "$code" "$@"; }
    install_deps() { _niced npm ci; }
    ;;
  *) echo "Unknown WORLDGEN_RUNTIME: $WORLDGEN_RUNTIME. Use bun; node is compatibility-only." >&2; exit 2 ;;
esac
