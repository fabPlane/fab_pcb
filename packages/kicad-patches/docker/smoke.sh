#!/usr/bin/env bash
# Smoke-test a kicad-cli image: `kicad-cli version`, then start `api-server` on the kitchen-sink
# board inside the container and answer Ping / GetVersion / OpenDocument from tooling/m0/ping.ts
# running in a sibling `oven/bun` container that shares the socket volume. (Unix sockets do not
# cross the Docker Desktop VM boundary on macOS, so the client cannot run on the host.)
#
# Usage: smoke.sh [IMAGE] [KICAD_SRC]
#   PING_IMAGE  image with `bun` for the client side (default oven/bun:1)
set -euo pipefail
IMAGE="${1:-kicad-web/kicad-cli:latest}"
PING_IMAGE="${PING_IMAGE:-oven/bun:1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
KICAD_SRC="${2:-${KICAD_SRC:-$(cd "$REPO_ROOT/../kicad" && pwd)}}"
DATA="$KICAD_SRC/qa/data/pcbnew"
VOL="kicad-smoke-$$"
NAME="kicad-smoke-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== $IMAGE: kicad-cli version"
docker run --rm "$IMAGE" version

# Preload the .kicad_pro (project settings only, as in docs/m0-runbook.md) so that ping.ts's
# OpenDocument step really opens the board instead of answering "already open".
echo "== api-server on api_kitchen_sink.kicad_pro (no DISPLAY)"
docker volume create "$VOL" >/dev/null
docker run -d --name "$NAME" -v "$VOL:/tmp/kicad" -v "$DATA:/work:ro" "$IMAGE" \
  api-server /work/api_kitchen_sink.kicad_pro --socket /tmp/kicad/api.sock >/dev/null
for _ in $(seq 1 60); do
  if docker run --rm -v "$VOL:/tmp/kicad" "$PING_IMAGE" test -S /tmp/kicad/api.sock 2>/dev/null; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    echo "api-server exited:"; docker logs "$NAME"; exit 1
  fi
  sleep 1
done
docker run --rm -v "$VOL:/tmp/kicad" -v "$REPO_ROOT/tooling/m0:/m0:ro" "$PING_IMAGE" \
  bun /m0/ping.ts /tmp/kicad/api.sock /work/api_kitchen_sink.kicad_pcb
echo "== server log"
docker logs "$NAME" 2>&1 | tail -20
