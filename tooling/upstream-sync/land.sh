#!/usr/bin/env bash
# Land a merged upstream sync: once the two pull requests sync.sh opened are merged, tag both repos
# with the alignment tag the bindings PR recorded, fast-forward the local branches, keep the fork's
# `master` mirroring `web-api`, and clean up the sync branches and worktree.
#
# Usage: tooling/upstream-sync/land.sh [YYYY-MM-DD]   (default: today)
# Exit:  0 tagged · 1 a PR is not merged yet · 2 bad state
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$(cd "$HERE/../.." && pwd)"
KICAD_SRC="${KICAD_SRC:-$(cd "$WEB/../kicad" && pwd)}"
DATE="${1:-$(date +%Y-%m-%d)}"
SYNC_BRANCH="web-api-sync-$DATE"
WEB_BRANCH="sync/$DATE"
WT="$WEB/.worktrees/sync-$DATE"
kg() { git -C "$KICAD_SRC" "$@"; }
wg() { git -C "$WEB" "$@"; }
die() { echo "land: $1" >&2; exit "${2:-2}"; }

kg fetch -q origin --prune && wg fetch -q origin --prune || die "fetch failed"
[ -z "$(kg status --porcelain)" ] || die "the fork's working tree is dirty"
[ -z "$(wg status --porcelain)" ] || die "the web working tree is dirty"

# The bindings PR is the source of truth for what was synced.
wg rev-parse -q --verify "origin/$WEB_BRANCH" >/dev/null || die "origin/$WEB_BRANCH does not exist; was sync.sh run on $DATE?"
WEB_HEAD="$(wg rev-parse "origin/$WEB_BRANCH")"
wg merge-base --is-ancestor "$WEB_HEAD" origin/main || die "the bindings PR ($WEB_BRANCH) is not merged into main yet" 1
TAG="$(wg show "$WEB_HEAD:packages/proto/KICAD_TAG" | tr -d '[:space:]')"
FORK_COMMIT="$(wg show "$WEB_HEAD:packages/proto/KICAD_COMMIT" | tr -d '[:space:]')"
case "$TAG" in fp-pcb/*) ;; *) die "KICAD_TAG on $WEB_BRANCH is '$TAG', not an fp-pcb/ tag" ;; esac

kg cat-file -e "$FORK_COMMIT^{commit}" 2>/dev/null || die "fork commit $FORK_COMMIT (from KICAD_COMMIT) is not in the fork checkout"
if kg rev-parse -q --verify "origin/$SYNC_BRANCH" >/dev/null; then
  kg merge-base --is-ancestor "origin/$SYNC_BRANCH" origin/web-api || die "the fork PR ($SYNC_BRANCH) is not merged into web-api yet" 1
fi
kg merge-base --is-ancestor "$FORK_COMMIT" origin/web-api || die "fork commit $FORK_COMMIT is not on origin/web-api" 1

# Tags go on the exact commits that were tested: the fork commit the bindings pin, and the bindings commit.
kg tag -a "$TAG" "$FORK_COMMIT" -m "web-api synced with upstream KiCad ($DATE); qa_api and the FabPlane PCB suites green" 2>/dev/null || echo "fork already has $TAG"
wg tag -a "$TAG" "$WEB_HEAD" -m "aligned with fork $TAG ($FORK_COMMIT)" 2>/dev/null || echo "web already has $TAG"
kg push -q origin "refs/tags/$TAG" && wg push -q origin "refs/tags/$TAG" || die "could not push the tags"

# Fast-forward local branches; keep the fork's master mirroring web-api.
kg checkout -q web-api && kg merge -q --ff-only origin/web-api || die "local web-api did not fast-forward"
kg branch -f master web-api && kg push -q origin master || echo "land: could not fast-forward origin/master (left as is)"
CUR="$(wg branch --show-current)"
if [ "$CUR" = "main" ]; then wg merge -q --ff-only origin/main || die "local main did not fast-forward"; else wg fetch -q origin main:main || true; fi

# Clean up the sync branches and worktree.
[ -e "$WT" ] && wg worktree remove --force "$WT"; wg worktree prune
wg branch -q -D "$WEB_BRANCH" 2>/dev/null; wg push -q origin --delete "$WEB_BRANCH" 2>/dev/null || true
kg branch -q -D "$SYNC_BRANCH" 2>/dev/null; kg push -q origin --delete "$SYNC_BRANCH" 2>/dev/null || true
echo "landed $DATE: tagged $TAG on fork $FORK_COMMIT and web $(wg rev-parse --short "$WEB_HEAD"); web-api/master and main are current"
