# 07 — Staying current with upstream KiCad

The fork carries an API patch series on branch `web-api` (see [upstream.md](upstream.md)).
Upstream KiCad moves daily, so the series is rebased onto it daily, rebuilt, retested, and
tagged. Nothing here changes what the series does; it only keeps it applying and passing.

## What runs

`tooling/upstream-sync/sync.sh`, in stages; it stops at the first broken one and leaves the
state in place for repair:

| Stage | Does | On failure |
|---|---|---|
| fetch | `git fetch upstream`; counts new upstream commits; lists those that touch `api/`, `common/api`, `pcbnew/api`, `eeschema/api`, `kicad/cli`, `qa/tests/api`, `libs/kinng` | exit 7 when nothing is new |
| rebase | rebases `web-api` onto `upstream/master` on a `web-api-sync-<date>` branch | exit 2, rebase left mid-way with the conflicted files listed in the report |
| build | `build/dev` kicad-cli + kifaces, `build/qa` qa_api | exit 3 with the compiler's last lines |
| qa_api | the fork's API QA suite (154+ cases) | exit 4 |
| bindings | `bun run gen` (proto), `bun run coverage`, client wrappers, typecheck | exit 5: an unlisted command proto, a renamed handler, or a type break |
| web suites | unit, integration against the live server (bridge, conformance, round trip, router), mock e2e | exit 6 |
| advance | fast-forwards `web-api` and `master`, tags both repos `fp-pcb/<date>-upstream-<sha>`, commits the regenerated bindings with the report | — |

Reports land in `docs/sync/<date>.md`. The tag follows the alignment rule in
[01-architecture.md](01-architecture.md).

## The daily task

A scheduled Claude task runs the script every morning and repairs whatever stage fails:

- **rebase conflicts**: resolve them in the spirit of the original commit (the series is
  documented commit by commit in `upstream.md`), `git rebase --continue`, re-run with
  `--skip-build` off so the build stage runs.
- **build or QA failures**: usually an upstream API change under our handlers (a renamed
  method, a new required argument, a proto message moved); fix the series commit that owns the
  file, keep the fix in that commit when it is small (`git commit --fixup` then autosquash),
  else add a `Sync: ...` commit on top and note it in the report.
- **bindings or web-suite failures**: a proto rename or a changed default shows up as a
  coverage warning, a typecheck error, or a conformance diff; fix the client and, when KiCad's
  behaviour changed on purpose, update the conformance expectation and say why in the report.
- **anything it cannot fix in one session**: leave the sync branch and the report in place and
  say exactly which stage and why; the next run starts from the same point.

The task must never force-push, rewrite tags, or edit `docs/upstream.md`'s history; it may add
a dated section to the report and commit regenerated bindings.

## Running it by hand

```bash
tooling/upstream-sync/sync.sh --dry-run      # fetch and list what changed, no rebase
tooling/upstream-sync/sync.sh                # the whole thing
tooling/upstream-sync/sync.sh --skip-build   # after fixing a rebase by hand
```

Prerequisites: the fork at `../kicad` with remotes `origin` and `upstream`, configured build
dirs `build/dev` and `build/qa` (see [m0-runbook.md](m0-runbook.md) and `build-macos.sh`; the QA
dir needs `-DKICAD_BUILD_QA_TESTS=ON`), Bun, and the KiCad library env variables the suites use.
