#!/usr/bin/env bash
# Daily upstream sync for the KiCad fork that FabPlane PCB depends on.
#
# Fetches upstream KiCad, merges it into the fork's `main` branch on a sync branch, rebuilds the
# headless server and the QA suite, regenerates this repo's bindings in a git worktree on a sync
# branch, runs every suite, and on full success pushes both sync branches and opens a pull request
# on each repo. It never pushes `main` on either repo and never creates tags: review and
# merge the PRs, then run land.sh to tag both repos. On any failure it stops at the first broken
# stage with everything left in place for a person or an agent to fix (the daily scheduled task
# runs this script and then repairs whatever stage failed, re-running with --resume).
#
# Usage: tooling/upstream-sync/sync.sh [--dry-run] [--skip-build] [--resume] [--force]
#                                      [--upstream-ref upstream/master]
#   --resume     keep the existing sync branches and worktree (after a hand-fixed merge or test)
#   --skip-build reuse build/dev and build/qa as they are
#   --force      go on even when upstream has nothing new (mechanics check; nothing gets published)
# Env:   KICAD_SRC (default ../kicad), JOBS (default nproc-2), FP_PCB_SYNC_REPORT_DIR (.worktrees),
#        FP_PCB_FORK_REPO / FP_PCB_WEB_REPO (owner/name for gh; default from each origin URL)
# Exit:  0 PRs opened (or nothing to publish) · 2 merge conflict · 3 build failed · 4 QA failed
#        5 bindings drift/typecheck · 6 web suites failed · 7 nothing to do · 8 publish failed
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$(cd "$HERE/../.." && pwd)"
KICAD_SRC="${KICAD_SRC:-$(cd "$WEB/../kicad" && pwd)}"
export KICAD_SRC
UPSTREAM_REF="upstream/master"
JOBS="${JOBS:-$(( $(sysctl -n hw.ncpu 2>/dev/null || nproc) - 2 ))}"
DRY_RUN=0; SKIP_BUILD=0; RESUME=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --resume) RESUME=1 ;;
    --force) FORCE=1 ;;
    --upstream-ref) UPSTREAM_REF="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 64 ;;
  esac; shift
done

DATE="$(date +%Y-%m-%d)"
REPORT_DIR="${FP_PCB_SYNC_REPORT_DIR:-$WEB/.worktrees}"
REPORT="$REPORT_DIR/$DATE.md"
mkdir -p "$REPORT_DIR"
SYNC_BRANCH="upstream-sync-$DATE"          # on the fork
WEB_BRANCH="sync/$DATE"                    # on this repo
WT="$WEB/.worktrees/sync-$DATE"            # worktree for WEB_BRANCH
export KICAD_CLI="$KICAD_SRC/build/dev/kicad/KiCad.app/Contents/MacOS/kicad-cli"
export KICAD10_SYMBOL_DIR="${KICAD10_SYMBOL_DIR:-/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols}"
export KICAD10_FOOTPRINT_DIR="${KICAD10_FOOTPRINT_DIR:-/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints}"
export KICAD10_3DMODEL_DIR="${KICAD10_3DMODEL_DIR:-/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels}"
# Freerouting lives untracked under the main checkout's vendor dir; point the worktree's suites at it.
[ -f "$WEB/packages/router/vendor/freerouting-2.4.1.jar" ] && export FREEROUTING_JAR="${FREEROUTING_JAR:-$WEB/packages/router/vendor/freerouting-2.4.1.jar}"
[ -x "$WEB/packages/router/vendor/jdk/Contents/Home/bin/java" ] && export FP_PCB_JAVA="${FP_PCB_JAVA:-$WEB/packages/router/vendor/jdk/Contents/Home/bin/java}"
# The router corpus needs the private fab_router module; CI passes it the same way (FAB_ROUTER_MODULE).
[ -f "$WEB/../fab_router/src/api.ts" ] && export FAB_ROUTER_MODULE="${FAB_ROUTER_MODULE:-$(cd "$WEB/../fab_router" && pwd)/src/api.ts}"

repo_slug() { git -C "$1" remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##'; }
FORK_REPO="${FP_PCB_FORK_REPO:-$(repo_slug "$KICAD_SRC")}"
WEB_REPO="${FP_PCB_WEB_REPO:-$(repo_slug "$WEB")}"

stage() { echo; echo "=== $1 ==="; echo "- **$1**: $2" >> "$REPORT"; }
fail()  { echo "FAILED at: $1" | tee -a "$REPORT"; echo; printf '%b\n' "$2" | tee -a "$REPORT"; exit "$3"; }
kg()    { git -C "$KICAD_SRC" "$@"; }
wg()    { git -C "$WT" "$@"; }

if [ "$RESUME" = "1" ] && [ -f "$REPORT" ]; then
  { echo; echo "## Resumed $(date -u +%FT%TZ)"; echo; } >> "$REPORT"
else
  {
    echo "# Upstream sync $DATE"
    echo
    echo "Started $(date -u +%FT%TZ) on $(hostname). Fork: \`$KICAD_SRC\`. Upstream ref: \`$UPSTREAM_REF\`."
    echo
  } > "$REPORT"
fi

# ---------------------------------------------------------------- 1. fetch and measure
stage "fetch" "git fetch upstream"
kg fetch upstream --tags --prune || fail fetch "could not fetch upstream" 3
[ -z "$(kg status --porcelain)" ] || fail fetch "the fork's working tree is dirty; commit or stash first" 2
BASE_BEFORE="$(kg merge-base main "$UPSTREAM_REF")"
UP_HEAD="$(kg rev-parse "$UPSTREAM_REF")"
UP_SHORT="$(kg rev-parse --short "$UP_HEAD")"
SERIES_COUNT="$(kg rev-list --count --no-merges "$UP_HEAD..main")"
NEW_COUNT="$(kg rev-list --count "$BASE_BEFORE..$UP_HEAD")"
echo "series: $SERIES_COUNT commits over $(kg rev-parse --short "$BASE_BEFORE"); upstream has $NEW_COUNT new commits up to $UP_SHORT" | tee -a "$REPORT"
if [ "$NEW_COUNT" = "0" ] && [ "$FORCE" != "1" ]; then echo "already up to date" | tee -a "$REPORT"; exit 7; fi
echo >> "$REPORT"; echo "Upstream commits since the last base:" >> "$REPORT"; echo >> "$REPORT"
kg log --oneline "$BASE_BEFORE..$UP_HEAD" | sed 's/^/    /' >> "$REPORT"; echo >> "$REPORT"
# Which upstream commits touch the surfaces the series patches — the ones most likely to conflict.
echo "Upstream commits touching api/, common/api, pcbnew/api, eeschema/api, kicad/cli or qa/tests/api:" >> "$REPORT"; echo >> "$REPORT"
kg log --oneline "$BASE_BEFORE..$UP_HEAD" -- api common/api pcbnew/api eeschema/api kicad/cli qa/tests/api libs/kinng | sed 's/^/    /' >> "$REPORT"; echo >> "$REPORT"
[ "$DRY_RUN" = "1" ] && { echo "dry run: stopping before the merge"; exit 0; }

# ---------------------------------------------------------------- 2. merge upstream on a sync branch
stage "merge" "merge $UPSTREAM_REF into main as $SYNC_BRANCH"
if [ "$RESUME" = "1" ] && kg rev-parse -q --verify "$SYNC_BRANCH" >/dev/null && kg merge-base --is-ancestor "$UP_HEAD" "$SYNC_BRANCH"; then
  kg checkout -q "$SYNC_BRANCH"
  echo "resuming $SYNC_BRANCH at $(kg rev-parse --short HEAD)" | tee -a "$REPORT"
else
  [ -f "$KICAD_SRC/.git/MERGE_HEAD" ] && fail merge "the fork is mid-merge; finish it (git merge --continue) and re-run with --resume" 2
  kg checkout -q -B "$SYNC_BRANCH" main
  if ! kg merge --no-ff --no-edit -m "Merge upstream KiCad $UP_SHORT into main ($DATE)" "$UPSTREAM_REF" >/tmp/fp-pcb-merge.log 2>&1; then
    {
      echo; echo "Merge stopped with conflicts. The fork is left mid-merge on \`$SYNC_BRANCH\`:"; echo
      kg status --porcelain | sed 's/^/    /'
      echo; echo "Resolve, \`git merge --continue\`, then re-run this script with --resume."
    } >> "$REPORT"
    fail merge "merge conflicts on $SYNC_BRANCH (see $REPORT)" 2
  fi
  echo "merged $NEW_COUNT upstream commits into $SYNC_BRANCH ($(kg rev-parse --short HEAD))" | tee -a "$REPORT"
fi
FORK_HEAD="$(kg rev-parse HEAD)"

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

# ---------------------------------------------------------------- 4. worktree for this repo's sync branch
stage "worktree" "$WEB_BRANCH in $WT"
git -C "$WEB" worktree prune
if [ "$RESUME" = "1" ] && [ -e "$WT/.git" ]; then
  echo "resuming worktree $WT on $(wg branch --show-current)" | tee -a "$REPORT"
else
  [ -e "$WT" ] && git -C "$WEB" worktree remove --force "$WT"
  git -C "$WEB" worktree add -q -B "$WEB_BRANCH" "$WT" main || fail worktree "could not create the worktree $WT on $WEB_BRANCH" 5
  (cd "$WT" && bun install --frozen-lockfile >/tmp/fp-pcb-install.log 2>&1) || fail worktree "bun install failed in the worktree:\n$(tail -20 /tmp/fp-pcb-install.log)" 5
  echo "created $WT on $WEB_BRANCH from main $(wg rev-parse --short main)" | tee -a "$REPORT"
fi
cd "$WT"
TAG="fp-pcb/$DATE-upstream-$UP_SHORT"

# ---------------------------------------------------------------- 5. regenerate bindings there
stage "bindings" "regenerate proto, coverage and client wrappers"
(cd packages/proto && bun run gen) >/tmp/fp-pcb-gen.log 2>&1 || fail bindings "proto gen failed:\n$(tail -20 /tmp/fp-pcb-gen.log)" 5
bun run coverage >/tmp/fp-pcb-cov.log 2>&1 || fail bindings "coverage failed (an unlisted command proto or a renamed handler?):\n$(tail -20 /tmp/fp-pcb-cov.log)" 5
(cd packages/client && bun run gen) >/tmp/fp-pcb-cgen.log 2>&1 || fail bindings "client gen failed:\n$(tail -20 /tmp/fp-pcb-cgen.log)" 5
bun tooling/coverage/summary.ts --badge >/dev/null 2>&1 || true
echo "$TAG" > packages/proto/KICAD_TAG   # the tag itself is created by land.sh once both PRs are merged
grep -h "commands (" /tmp/fp-pcb-cov.log | tail -1 | tee -a "$REPORT"
bunx tsc -b >/tmp/fp-pcb-tsc.log 2>&1 || fail bindings "typecheck failed after regeneration:\n$(head -30 /tmp/fp-pcb-tsc.log)" 5

# ---------------------------------------------------------------- 6. web suites
stage "web suites" "unit, integration (live server), conformance, mock e2e"
bun run test:unit >/tmp/fp-pcb-unit.log 2>&1 || fail "web suites" "unit tests failed:\n$(grep -E '✗|\(fail\)|^unit:' /tmp/fp-pcb-unit.log | head -30)" 6
tail -1 /tmp/fp-pcb-unit.log | tee -a "$REPORT"
bun run test:integration >/tmp/fp-pcb-int.log 2>&1 || fail "web suites" "integration suites failed:\n$(grep -E '✗|\(fail\)|KICAD-BUG|^integration:' /tmp/fp-pcb-int.log | head -40)" 6
grep -E "^integration:" /tmp/fp-pcb-int.log | tee -a "$REPORT"
head -3 packages/client/dist/conformance-summary.txt 2>/dev/null | sed -n 2p | tee -a "$REPORT"
bun run test:e2e >/tmp/fp-pcb-e2e.log 2>&1 || fail "web suites" "mock e2e failed:\n$(grep -E 'passed|failed|✘' /tmp/fp-pcb-e2e.log | head -10)" 6
grep -E "passed|failed" /tmp/fp-pcb-e2e.log | tail -1 | tee -a "$REPORT"

# ---------------------------------------------------------------- 7. publish: branches + pull requests, never main on either repo
stage "publish" "push $SYNC_BRANCH and $WEB_BRANCH, open pull requests"
echo | tee -a "$REPORT"; echo "All suites green $(date -u +%FT%TZ)." | tee -a "$REPORT"
PR_BODY=/tmp/fp-pcb-pr-body.md
FORK_PR=""; WEB_PR=""

if [ "$(kg rev-parse "$SYNC_BRANCH")" = "$(kg rev-parse main)" ]; then
  echo "fork: $SYNC_BRANCH is identical to main; nothing to publish" | tee -a "$REPORT"
else
  kg push -q -u origin "$SYNC_BRANCH" --force-with-lease || fail publish "could not push $SYNC_BRANCH to $FORK_REPO" 8
  {
    echo "Merges upstream KiCad \`$UP_SHORT\` ($NEW_COUNT commits) into \`main\`; the $SERIES_COUNT-commit API series, qa_api and every FabPlane PCB suite are green on the result."
    echo
    echo "Merge with **Create a merge commit** (the branch is a merge, never rebase it). The bindings PR on \`$WEB_REPO\` pins \`$(kg rev-parse --short "$FORK_HEAD")\`; after merging both, run \`tooling/upstream-sync/land.sh $DATE\` to tag both repos \`$TAG\`."
    echo
    echo "---"
    echo
    cat "$REPORT"
  } > "$PR_BODY"
  FORK_PR="$(gh pr list -R "$FORK_REPO" --head "$SYNC_BRANCH" --base main --state open --json url -q '.[0].url')"
  if [ -n "$FORK_PR" ]; then
    gh pr edit "$FORK_PR" -R "$FORK_REPO" --body-file "$PR_BODY" >/dev/null || fail publish "could not update $FORK_PR" 8
  else
    FORK_PR="$(gh pr create -R "$FORK_REPO" --base main --head "$SYNC_BRANCH" --title "Sync main with upstream KiCad $UP_SHORT ($DATE)" --body-file "$PR_BODY")" \
      || fail publish "gh pr create failed on $FORK_REPO" 8
  fi
  echo "fork PR: $FORK_PR" | tee -a "$REPORT"
fi

mkdir -p docs/sync && cp "$REPORT" "docs/sync/$DATE.md"
wg add -A
wg -c user.name="FabPlane PCB sync" -c user.email="sync@fabplane.invalid" commit -q -m "Sync bindings to upstream KiCad $UP_SHORT ($TAG)

Upstream added $NEW_COUNT commits; the fork's sync branch merged them into main and every
suite is green. Report: docs/sync/$DATE.md" || true
if [ "$(wg rev-parse HEAD)" = "$(wg rev-parse main)" ]; then
  echo "web: no binding or report changes; nothing to publish" | tee -a "$REPORT"
else
  wg push -q -u origin "$WEB_BRANCH" --force-with-lease || fail publish "could not push $WEB_BRANCH to $WEB_REPO" 8
  {
    echo "Bindings regenerated from the fork at \`$(kg rev-parse --short "$FORK_HEAD")\` (upstream KiCad \`$UP_SHORT\`, $NEW_COUNT new commits); unit, integration, conformance and mock e2e are green."
    echo
    if [ -n "$FORK_PR" ]; then echo "Merge after the fork PR $FORK_PR, then run \`tooling/upstream-sync/land.sh $DATE\` to tag both repos \`$TAG\`."; else echo "The fork had nothing to publish; run \`tooling/upstream-sync/land.sh $DATE\` after merging to tag."; fi
    echo
    echo "---"
    echo
    cat "docs/sync/$DATE.md"
  } > "$PR_BODY"
  WEB_PR="$(gh pr list -R "$WEB_REPO" --head "$WEB_BRANCH" --base main --state open --json url -q '.[0].url')"
  if [ -n "$WEB_PR" ]; then
    gh pr edit "$WEB_PR" -R "$WEB_REPO" --body-file "$PR_BODY" >/dev/null || fail publish "could not update $WEB_PR" 8
  else
    WEB_PR="$(gh pr create -R "$WEB_REPO" --base main --head "$WEB_BRANCH" --title "Sync bindings to upstream KiCad $UP_SHORT ($DATE)" --body-file "$PR_BODY")" \
      || fail publish "gh pr create failed on $WEB_REPO" 8
  fi
  echo "web PR: $WEB_PR" | tee -a "$REPORT"
fi

kg checkout -q main
echo | tee -a "$REPORT"; echo "Finished $(date -u +%FT%TZ): ${FORK_PR:-no fork PR}; ${WEB_PR:-no web PR}. Land with tooling/upstream-sync/land.sh $DATE after merging." | tee -a "$REPORT"
exit 0
