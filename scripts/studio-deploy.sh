#!/usr/bin/env bash
# One-command local deploy of WorldGen Studio in Docker (YOS-192, A-313). Loopback only until sign-in lands (YOS-187).
#
#   scripts/studio-deploy.sh up                 # build the image for this checkout's sha, run it, wait until healthy
#   scripts/studio-deploy.sh down               # stop and remove the container; the volumes stay
#   scripts/studio-deploy.sh health             # GET /api/health
#   scripts/studio-deploy.sh logs [n]           # the last n container log lines (default 100)
#   scripts/studio-deploy.sh backup <file.tgz>  # worlds (with their runs/) and the spend ledger, from the volumes
#   scripts/studio-deploy.sh restore <file.tgz> # replace both volumes' contents with a backup; the container must be down
#
# Generation in the container uses the SDK: export LLM_KEY, or set STUDIO_ENV_FILE to an env file outside the repo.
# STUDIO_PORT (default 8787) picks the host port, always on 127.0.0.1. STUDIO_VOLUME_PREFIX (default worldgen-studio)
# names the volumes <prefix>-worlds and <prefix>-ledger, so a restore drill can target scratch volumes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=worldgen-studio
NAME="${STUDIO_CONTAINER:-worldgen-studio}"
PORT="${STUDIO_PORT:-8787}"
PREFIX="${STUDIO_VOLUME_PREFIX:-worldgen-studio}"
WORLDS="$PREFIX-worlds"
LEDGER="$PREFIX-ledger"
URL="http://127.0.0.1:$PORT"

die() { echo "studio-deploy: $*" >&2; exit 1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = true ]; }
# tar inside the studio image itself, as root so it can write into volumes owned by the image's bun user.
in_image() { docker run --rm --user root --entrypoint "$1" "${@:2}"; }

case "${1:-}" in
  up)
    sha="$(git -C "$ROOT" rev-parse HEAD)"
    docker build -q -f "$ROOT/Dockerfile.studio" --build-arg "WORLDGEN_BUILD_SHA=$sha" -t "$IMAGE:$sha" -t "$IMAGE:latest" "$ROOT" >/dev/null
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # The studio runs as bun and writes worlds and the ledger, so the volumes are bun's; this also repairs older volumes.
    in_image chown -v "$WORLDS:/app/prod/worlds" -v "$LEDGER:/home/bun/.worldgen" "$IMAGE:$sha" -R bun:bun /app/prod/worlds /home/bun/.worldgen >/dev/null
    # A new named volume starts as a copy of the image's /app/prod/worlds, so the first run has the shipped worlds.
    # The model key reaches the container at run time only (A-326): -e LLM_KEY forwards the caller's value by name, so it
    # never appears on a command line, and STUDIO_ENV_FILE must live outside the repo, so it cannot be committed.
    keys=()
    [ -n "${LLM_KEY:-}" ] && keys+=(-e LLM_KEY)
    if [ -n "${STUDIO_ENV_FILE:-}" ]; then
      envfile="$(cd "$(dirname "$STUDIO_ENV_FILE")" && pwd)/$(basename "$STUDIO_ENV_FILE")"
      case "$envfile" in "$ROOT"/*) die "STUDIO_ENV_FILE must live outside the repository, not $envfile" ;; esac
      [ -f "$envfile" ] || die "no env file at $envfile"
      keys+=(--env-file "$envfile")
    fi
    docker run -d --name "$NAME" --restart unless-stopped -p "127.0.0.1:$PORT:8787" ${keys[@]+"${keys[@]}"} \
      -v "$WORLDS:/app/prod/worlds" -v "$LEDGER:/home/bun/.worldgen" "$IMAGE:$sha" >/dev/null
    for _ in $(seq 1 60); do
      [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && { echo "studio $sha healthy on $URL"; exit 0; }
      sleep 1
    done
    docker logs --tail 30 "$NAME" >&2
    die "not healthy after 60 s"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "studio down; volumes $WORLDS and $LEDGER kept"
    ;;
  health)
    curl -fsS "$URL/api/health" && echo
    ;;
  logs)
    docker logs --tail "${2:-100}" "$NAME"
    ;;
  backup)
    out="${2:?usage: studio-deploy.sh backup <file.tgz>}"
    dir="$(cd "$(dirname "$out")" && pwd)"
    file="$(basename "$out")"
    in_image tar -v "$WORLDS:/backup/worlds:ro" -v "$LEDGER:/backup/ledger:ro" -v "$dir:/out" "$IMAGE:latest" \
      czf "/out/$file" -C /backup worlds ledger
    echo "backup $dir/$file ($(du -h "$dir/$file" | cut -f1)) of $WORLDS and $LEDGER"
    ;;
  restore)
    in="${2:?usage: studio-deploy.sh restore <file.tgz>}"
    [ -f "$in" ] || die "no backup at $in"
    running && die "container $NAME is running; run down first, so nothing writes while the volumes are replaced"
    dir="$(cd "$(dirname "$in")" && pwd)"
    file="$(basename "$in")"
    in_image sh -v "$WORLDS:/backup/worlds" -v "$LEDGER:/backup/ledger" -v "$dir:/in:ro" "$IMAGE:latest" \
      -c "find /backup/worlds /backup/ledger -mindepth 1 -delete && tar xzpf /in/$file -C /backup"
    echo "restored $WORLDS and $LEDGER from $dir/$file"
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 2
    ;;
esac
