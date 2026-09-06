#!/usr/bin/env bash
# Build the Linux Docker image with kicad-cli + pcbnew/eeschema kifaces from the KiCad fork
# (branch web-api), for CI and for running the headless API server on Linux hosts.
#
# Usage: build-linux.sh [--smoke] [--push] [KICAD_REF]
#   KICAD_SRC   path to the fork checkout (default ../../../kicad relative to this script);
#               `git archive KICAD_REF` of it becomes the build context (uncommitted edits are NOT built,
#               matching how packages/proto pins KICAD_COMMIT to a commit)
#   KICAD_REPO  when set, the image clones this URL at KICAD_REF instead of using KICAD_SRC (CI)
#   KICAD_REF   branch / tag / commit (default: HEAD of KICAD_SRC, or `web-api` with KICAD_REPO)
#   IMAGE       image name (default kicad-web/kicad-cli); tagged :<short sha> and :latest
#   JOBS        ninja -j (default: nproc inside the container; see the memory note in the Dockerfile)
#   BUILD_TYPE  Release (default) | RelWithDebInfo | Debug
#   PLATFORM    e.g. linux/amd64 (default: the daemon's native platform)
#   BASE        base image for the build and runtime stages (default debian:trixie; ubuntu:24.04 also
#               carries every dependency at new-enough versions and is handy when Docker Hub pulls stall)
#   --smoke     after the build run `kicad-cli version` and an api-server Ping (needs `bun`)
#
# Examples:
#   packages/kicad-patches/build-linux.sh --smoke
#   KICAD_REPO=https://gitlab.com/<fork>/kicad.git KICAD_REF=web-api packages/kicad-patches/build-linux.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$HERE/docker"
IMAGE="${IMAGE:-kicad-web/kicad-cli}"
BUILD_TYPE="${BUILD_TYPE:-Release}"
SMOKE=0
PUSH=0
REF_ARG=""
for a in "$@"; do
  case "$a" in
    --smoke) SMOKE=1 ;;
    --push) PUSH=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) REF_ARG="$a" ;;
  esac
done

export DOCKER_BUILDKIT=1
BUILD_ARGS=(--build-arg "BUILD_TYPE=$BUILD_TYPE")
[[ -n "${JOBS:-}" ]] && BUILD_ARGS+=(--build-arg "JOBS=$JOBS")
[[ -n "${PLATFORM:-}" ]] && BUILD_ARGS+=(--platform "$PLATFORM")
[[ -n "${BASE:-}" ]] && BUILD_ARGS+=(--build-arg "BASE=$BASE")

cleanup() { [[ -n "${CTX:-}" && -d "${CTX:-}" ]] && rm -rf "$CTX"; }
trap cleanup EXIT

if [[ -n "${KICAD_REPO:-}" ]]; then
  KICAD_REF="${REF_ARG:-${KICAD_REF:-web-api}}"
  SHORT="$(echo "$KICAD_REF" | tr '/' '-' | cut -c1-12)"
  echo "Source  : $KICAD_REPO @ $KICAD_REF (cloned inside the build)"
  CTX="$DOCKER_DIR"
  BUILD_ARGS+=(--build-arg KICAD_SOURCE=git --build-arg "KICAD_REPO=$KICAD_REPO" --build-arg "KICAD_REF=$KICAD_REF")
else
  KICAD_SRC="${KICAD_SRC:-$(cd "$HERE/../../../kicad" && pwd)}"
  KICAD_REF="${REF_ARG:-${KICAD_REF:-HEAD}}"
  SHA="$(git -C "$KICAD_SRC" rev-parse "$KICAD_REF")"
  SHORT="${SHA:0:10}"
  echo "Source  : $KICAD_SRC @ $KICAD_REF ($SHA, $(git -C "$KICAD_SRC" describe --tags --always "$SHA"))"
  CTX="$(mktemp -d "${TMPDIR:-/tmp}/kicad-ctx.XXXXXX")"
  echo "Context : git archive -> $CTX (demos, translation, qa/data excluded)"
  git -C "$KICAD_SRC" archive --format=tar "$SHA" ':(exclude)demos' ':(exclude)translation' ':(exclude)qa/data' | tar -x -C "$CTX"
  # resources/CMakeLists.txt reads translation/pofiles/LINGUAS even with KICAD_BUILD_I18N=OFF
  git -C "$KICAD_SRC" archive --format=tar "$SHA" translation/pofiles/LINGUAS | tar -x -C "$CTX"
  echo "$SHA" > "$CTX/.kicad-commit"
  cp "$DOCKER_DIR/entrypoint.sh" "$CTX/entrypoint.sh"
  BUILD_ARGS+=(--build-arg KICAD_SOURCE=context --build-arg "KICAD_REF=$SHA")
fi

echo "Image   : $IMAGE:$SHORT ($BUILD_TYPE)"
docker build -f "$DOCKER_DIR/Dockerfile" "${BUILD_ARGS[@]}" \
  --label "org.opencontainers.image.revision=$KICAD_REF" \
  -t "$IMAGE:$SHORT" -t "$IMAGE:latest" "$CTX"

if [[ $SMOKE == 1 ]]; then
  echo; echo "== smoke: kicad-cli version"
  docker run --rm "$IMAGE:$SHORT" version
  echo "== smoke: api-server Ping"
  "$DOCKER_DIR/smoke.sh" "$IMAGE:$SHORT"
fi
[[ $PUSH == 1 ]] && docker push "$IMAGE:$SHORT" && docker push "$IMAGE:latest"
echo "Done: $IMAGE:$SHORT"
