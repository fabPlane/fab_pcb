# 07 — Staying current with upstream KiCad

The fork carries an API patch series on branch `web-api` (see [upstream.md](upstream.md)).
Upstream KiCad moves daily, so upstream is merged into `web-api` daily, rebuilt, retested, and
proposed as two pull requests. Nothing lands on `web-api`, `master` or `main` without a merge
click; nothing here changes what the series does, it only keeps it building and passing.

## What runs

`tooling/upstream-sync/sync.sh`, in stages; it stops at the first broken one and leaves the
state in place for repair:

| Stage      | Does                                                                                                                                                                                  | On failure                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| fetch      | `git fetch upstream`; counts new upstream commits; lists those that touch `api/`, `common/api`, `pcbnew/api`, `eeschema/api`, `kicad/cli`, `qa/tests/api`, `libs/kinng`               | exit 7 when nothing is new                                                |
| merge      | merges `upstream/master` into `web-api` on a `web-api-sync-<date>` branch (a merge commit, never a rebase)                                                                            | exit 2, merge left mid-way with the conflicted files listed in the report |
| build      | `build/dev` kicad-cli + kifaces, `build/qa` qa_api                                                                                                                                    | exit 3 with the compiler's last lines                                     |
| qa_api     | the fork's API QA suite (154+ cases)                                                                                                                                                  | exit 4                                                                    |
| worktree   | a git worktree of this repo at `.worktrees/sync-<date>` on branch `sync/<date>` from `main`, `bun install`                                                                            | exit 5                                                                    |
| bindings   | `bun run gen` (proto), `bun run coverage`, client wrappers, typecheck; writes the planned tag to `packages/proto/KICAD_TAG`                                                           | exit 5: an unlisted command proto, a renamed handler, or a type break     |
| web suites | unit, integration against the live server (bridge, conformance, round trip, router), mock e2e                                                                                         | exit 6                                                                    |
| publish    | pushes `web-api-sync-<date>` and `sync/<date>`, opens (or updates) a PR on each repo with the report as the body; the report is committed as `docs/sync/<date>.md` on the sync branch | exit 8                                                                    |

The report is written to `.worktrees/<date>.md` while the run is in progress (the main checkout is
never touched) and ends up in the bindings PR. The fork checkout is switched back to `web-api` at
the end of a green run; after a failure it stays on the sync branch.

## Landing a sync

1. Review and merge the fork PR (`web-api-sync-<date>` → `web-api`, **Create a merge commit**).
2. Review and merge the bindings PR (`sync/<date>` → `main`).
3. Run `tooling/upstream-sync/land.sh <date>`. It checks both PRs are merged, tags the fork at
   the commit the bindings pin and this repo at the bindings commit with the
   `fp-pcb/<date>-upstream-<sha>` tag the PR recorded, pushes the tags, fast-forwards the local
   branches, keeps the fork's `master` mirroring `web-api`, and removes the sync branches and the
   worktree. The tag follows the alignment rule in [01-architecture.md](01-architecture.md).

## The daily task

A scheduled Claude task runs the script every morning and repairs whatever stage fails, then
re-runs it with `--resume` (which keeps the sync branch, the worktree and any fix commits):

- **merge conflicts**: resolve them in the spirit of the series commit that owns the file (the
  series is documented commit by commit in `upstream.md`), `git merge --continue`, re-run with
  `--resume`.
- **build or QA failures**: usually an upstream API change under our handlers (a renamed
  method, a new required argument, a proto message moved); add a `Sync: ...` commit on the fork's
  sync branch and note it in the report.
- **bindings or web-suite failures**: a proto rename, a new command without a conformance case,
  or a changed default shows up as a coverage warning, a typecheck error, or a conformance diff;
  fix it on `sync/<date>` in the worktree and, when KiCad's behaviour changed on purpose, update
  the conformance expectation and say why in the report.
- **anything it cannot fix in one session**: leave the branches, the worktree and the report in
  place and say exactly which stage and why; the next run starts from the same point.

The task never pushes `web-api`, `master` or `main`, never force-pushes anything but its own
sync branches, never creates or rewrites tags, and never edits `docs/upstream.md`'s history.

## Running it by hand

```bash
tooling/upstream-sync/sync.sh --dry-run               # fetch and list what changed, no merge
tooling/upstream-sync/sync.sh                         # the whole thing, ending in two PRs
tooling/upstream-sync/sync.sh --resume --skip-build   # after fixing a merge or a test by hand
tooling/upstream-sync/sync.sh --force --skip-build    # mechanics check when upstream has nothing new
tooling/upstream-sync/land.sh 2026-09-07              # after both PRs are merged
```

Prerequisites: the fork at `../kicad` with remotes `origin` and `upstream`, configured build
dirs `build/dev` and `build/qa` (see [m0-runbook.md](m0-runbook.md) and `build-macos.sh`; the QA
dir needs `-DKICAD_BUILD_QA_TESTS=ON`), Bun, the `gh` CLI logged in with push rights on both
repos, and the KiCad library env variables the suites use. `KICAD_SRC` overrides the fork path
everywhere (generator, coverage, fixtures, bridge), which is what lets the suites run from a
worktree.

## Publishing the fork by hand

`web-api` only ever moves by merging a sync PR, so its history is append-only and a plain
`git push origin web-api` always fast-forwards. The one exception was 2026-09-07, when the series
was still rebased daily and its first publish needed a leased force push; every published state
stays reachable through its `fp-pcb/<date>-<name>` tag.
