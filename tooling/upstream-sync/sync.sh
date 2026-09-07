#!/usr/bin/env bash
# Daily upstream sync for the KiCad fork that FabPlane PCB depends on.
#
# Fetches upstream KiCad, rebases the fork's `web-api` patch series onto it, rebuilds the
# headless server and the QA suite, regenerates this repo's bindings, runs every suite, and on
# full success advances `web-api`/`master`, tags both repos, and writes a report. On any failure
# it stops at the first broken stage with everything left in place for a person or an agent to fix
# (the daily scheduled task runs this script and then repairs whatever stage failed).
#
# Usage: tooling/upstream-sync/sync.sh [--dry-run] [--skip-build] [--upstream-ref upstream/master]
# Env:   KICAD_SRC (default ../kicad), JOBS (default nproc-2), FP_PCB_SYNC_REPORT_DIR (docs/sync)
# Exit:  0 all green and advanced · 2 rebase conflict · 3 build failed · 4 QA failed
#        5 bindings drift/typecheck · 6 web suites failed · 7 nothing to do (already up to date)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$(cd "$HERE/../.." && pwd)"
KICAD_SRC="${KICAD_SRC:-$(cd "$WEB/../kicad" && pwd)}"
UPSTREAM_REF="upstream/master"
JOBS="${JOBS:-$(( $(sysctl -n hw.ncpu 2>/dev/null || nproc) - 2 ))}"
DRY_RUN=0; SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --upstream-ref) UPSTREAM_REF="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 64 ;;
  esac; shift
done

DATE="$(date +%Y-%m-%d)"
REPORT_DIR="${FP_PCB_SYNC_REPORT_DIR:-$WEB/docs/sync}"
REPORT="$REPORT_DIR/$DATE.md"
mkdir -p "$REPORT_DIR"
SYNC_BRANCH="web-api-sync-$DATE"
export KICAD_CLI="$KICAD_SRC/build/dev/kicad/KiCad.app/Contents/MacOS/kicad-cli"
export KICAD10_SYMBOL_DIR="${KICAD10_SYMBOL_DIR:-/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols}"
export KICAD10_FOOTPRINT_DIR="${KICAD10_FOOTPRINT_DIR:-/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints}"

stage() { echo; echo "=== $1 ==="; echo "- **$1**: $2" >> "$REPORT"; }
fail()  { echo "FAILED at: $1" | tee -a "$REPORT"; echo; echo "$2" | tee -a "$REPORT"; exit "$3"; }
kg()    { git -C "$KICAD_SRC" "$@"; }

{
  echo "# Upstream sync $DATE"
  echo
  echo "Started $(date -u +%FT%TZ) on $(hostname). Fork: \`$KICAD_SRC\`. Upstream ref: \`$UPSTREAM_REF\`."
  echo
} > "$REPORT"

# ---------------------------------------------------------------- 1. fetch and measure
stage "fetch" "git fetch upstream"
kg fetch upstream --tags --prune || fail fetch "could not fetch upstream" 3
[ -z "$(kg status --porcelain)" ] || fail fetch "the fork's working tree is dirty; commit or stash first" 2
BASE_BEFORE="$(kg merge-base web-api "$UPSTREAM_REF")"
UP_HEAD="$(kg rev-parse "$UPSTREAM_REF")"
SERIES_COUNT="$(kg rev-list --count "$BASE_BEFORE..web-api")"
NEW_COUNT="$(kg rev-list --count "$BASE_BEFORE..$UP_HEAD")"
echo "series: $SERIES_COUNT commits on $(kg rev-parse --short "$BASE_BEFORE"); upstream has $NEW_COUNT new commits up to $(kg rev-parse --short "$UP_HEAD")" | tee -a "$REPORT"
if [ "$NEW_COUNT" = "0" ]; then echo "already up to date" | tee -a "$REPORT"; exit 7; fi
echo >> "$REPORT"; echo "Upstream commits since the last base:" >> "$REPORT"; echo >> "$REPORT"
kg log --oneline "$BASE_BEFORE..$UP_HEAD" | sed 's/^/    /' >> "$REPORT"; echo >> "$REPORT"
# Which upstream commits touch the surfaces the series patches — the ones most likely to conflict.
echo "Upstream commits touching api/, common/api, pcbnew/api, eeschema/api, kicad/cli or qa/tests/api:" >> "$REPORT"; echo >> "$REPORT"
kg log --oneline "$BASE_BEFORE..$UP_HEAD" -- api common/api pcbnew/api eeschema/api kicad/cli qa/tests/api libs/kinng | sed 's/^/    /' >> "$REPORT"; echo >> "$REPORT"
[ "$DRY_RUN" = "1" ] && { echo "dry run: stopping before the rebase"; exit 0; }

# ---------------------------------------------------------------- 2. rebase the series
stage "rebase" "rebase web-api onto $UPSTREAM_REF as $SYNC_BRANCH"
kg branch -f "$SYNC_BRANCH" web-api
kg checkout -q "$SYNC_BRANCH"
if ! kg rebase "$UPSTREAM_REF" >/tmp/fp-pcb-rebase.log 2>&1; then
  {
    echo; echo "Rebase stopped with conflicts. The fork is left mid-rebase on \`$SYNC_BRANCH\`:"; echo
    kg status --porcelain | sed 's/^/    /'
    echo; echo "Resolve, \`git rebase --continue\`, then re-run this script with --skip-build to pick up from the build."
  } >> "$REPORT"
  fail rebase "rebase conflicts on $SYNC_BRANCH (see $REPORT)" 2
fi
echo "rebased $SERIES_COUNT commits onto $(kg rev-parse --short "$UP_HEAD")" | tee -a "$REPORT"

# ---------------------------------------------------------------- 3. build server + QA
if [ "$SKIP_BUILD" != "1" ]; then
  stage "build" "ninja build/dev kicad-cli + kifaces, build/qa qa_api"
  ninja -C "$KICAD_SRC/build/dev" -j"$JOBS" kicad-cli pcbnew_kiface eeschema_kiface cvpcb_kiface >/tmp/fp-pcb-build-dev.log 2>&1 \
    || fail build "build/dev failed; last lines:\n$(tail -30 /tmp/fp-pcb-build-dev.log)" 3
  ninja -C "$KICAD_SRC/build/qa" -j"$JOBS" qa_api >/tmp/fp-pcb-build-qa.log 2>&1 \
    || fail build "build/qa qa_api failed; last lines:\n$(tail -30 /tmp/fp-pcb-build-qa.log)" 3
  echo "built $("$KICAD_CLI" version)" | tee -a "$REPORT"
fi

stage "qa_api" "KiCad QA API suite"
if ! (cd "$KICAD_SRC/build/qa/qa/tests/api" && ./qa_api >/tmp/fp-pcb-qa.log 2>&1); then
  fail qa_api "qa_api failed; last lines:\n$(tail -40 /tmp/fp-pcb-qa.log)" 4
fi
echo "$(grep -Eo '[0-9]+ test cases? out of [0-9]+ passed|No errors detected' /tmp/fp-pcb-qa.log | tail -1)" | tee -a "$REPORT"

# ---------------------------------------------------------------- 4. regenerate bindings here
stage "bindings" "regenerate proto, coverage and client wrappers"
cd "$WEB"
(cd packages/proto && bun run gen) >/tmp/fp-pcb-gen.log 2>&1 || fail bindings "proto gen failed:\n$(tail -20 /tmp/fp-pcb-gen.log)" 5
bun run coverage >/tmp/fp-pcb-cov.log 2>&1 || fail bindings "coverage failed (an unlisted command proto or a renamed handler?):\n$(tail -20 /tmp/fp-pcb-cov.log)" 5
(cd packages/client && bun run gen) >/tmp/fp-pcb-cgen.log 2>&1 || fail bindings "client gen failed:\n$(tail -20 /tmp/fp-pcb-cgen.log)" 5
bun tooling/coverage/summary.ts --badge >/dev/null 2>&1 || true
grep -h "commands (" /tmp/fp-pcb-cov.log | tail -1 | tee -a "$REPORT"
bunx tsc -b >/tmp/fp-pcb-tsc.log 2>&1 || fail bindings "typecheck failed after regeneration:\n$(head -30 /tmp/fp-pcb-tsc.log)" 5

# ---------------------------------------------------------------- 5. web suites
stage "web suites" "unit, integration (live server), conformance, mock e2e"
bun run test:unit >/tmp/fp-pcb-unit.log 2>&1 || fail "web suites" "unit tests failed:\n$(grep -E '✗|\(fail\)|^unit:' /tmp/fp-pcb-unit.log | head -30)" 6
tail -1 /tmp/fp-pcb-unit.log | tee -a "$REPORT"
bun run test:integration >/tmp/fp-pcb-int.log 2>&1 || fail "web suites" "integration suites failed:\n$(grep -E '✗|\(fail\)|KICAD-BUG|^integration:' /tmp/fp-pcb-int.log | head -40)" 6
grep -E "^integration:" /tmp/fp-pcb-int.log | tee -a "$REPORT"
head -3 packages/client/dist/conformance-summary.txt 2>/dev/null | sed -n 2p | tee -a "$REPORT"
bun run test:e2e >/tmp/fp-pcb-e2e.log 2>&1 || fail "web suites" "mock e2e failed:\n$(grep -E 'passed|failed|✘' /tmp/fp-pcb-e2e.log | head -10)" 6
grep -E "passed|failed" /tmp/fp-pcb-e2e.log | tail -1 | tee -a "$REPORT"

# ---------------------------------------------------------------- 6. advance and tag
stage "advance" "fast-forward web-api and master, tag both repos"
TAG="fp-pcb/$DATE-upstream-$(kg rev-parse --short "$UP_HEAD")"
kg checkout -q web-api && kg reset -q --hard "$SYNC_BRANCH" && kg branch -f master web-api && kg branch -D "$SYNC_BRANCH" >/dev/null
kg tag -a "$TAG" -m "web-api rebased onto $UPSTREAM_REF $(kg rev-parse --short "$UP_HEAD"); qa_api and the FabPlane PCB suites green"
(cd packages/proto && bun run gen) >/dev/null 2>&1   # records KICAD_TAG now that the tag exists
git add -A
git -c user.name="FabPlane PCB sync" commit -q -m "Sync bindings to upstream KiCad $(kg rev-parse --short "$UP_HEAD") ($TAG)

Upstream added $NEW_COUNT commits; the $SERIES_COUNT-commit API series rebased cleanly and every
suite is green. Report: docs/sync/$DATE.md" || true
git tag -a "$TAG" -m "aligned with fork $TAG" 2>/dev/null || true
echo "advanced web-api/master to $(kg rev-parse --short web-api); tagged $TAG on both repos" | tee -a "$REPORT"
echo | tee -a "$REPORT"; echo "Finished $(date -u +%FT%TZ): all green." | tee -a "$REPORT"
exit 0
