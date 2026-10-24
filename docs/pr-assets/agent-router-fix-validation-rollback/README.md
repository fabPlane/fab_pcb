# Tentative route rollback when native validation fails

The routing job applies fab_router copper as one undoable commit, then requests native DRC
without refilling zones to prune dangling items. Previously, a rejected DRC request escaped
the job with the route still applied. On a cleanup retry, an existing scoped stub could also
remain deleted. The job reported failure without completing validation or saving that state.

The adapter now undoes the tentative commit when this DRC request rejects. The adapter first checks that the tentative commit ID is still at the top of the native
undo stack; an unrelated newer commit is left untouched. A successful undo
restores the pre-apply state and reports that the route commit was undone. An undo exception
or an applied count other than one reports both the validation failure and rollback failure,
including that tentative copper may remain in KiCad memory. A valid DRC response continues
through the existing cleanup and save path.

`audit.json` contains three repeats of six stateful adapter fault-injection scenarios per
version, all source/test hashes, job outcomes, final item IDs and ordered calls. The exact same
six regression tests ran three times per version: baseline 1 pass / 5 fail each time, candidate
6 pass / 0 fail each time. Both rollback-success scenarios restore every original item and
remove the generated route on the candidate. The cleanup-retry scenario restores a deleted
scoped stub as well. Locked copper and copper on another net remain present. Both versions
retain the valid control route. The two undo-failure controls remain failed jobs and retain
their tentative copper; the candidate explicitly reports failure to restore it. An unrelated
newer-edit control preserves both commits and reports why rollback could not proceed.

These are API fault-injection diagnostics using an in-memory commit/undo stand-in, not a
live KiCad validation of undo or a native DRC benchmark. `rollback.png` plots measured final
item counts. The production change does not add post-refill DRC comparison or thermal
protection. Native thermal starvation remains unresolved. The standalone native harness
bypasses this job adapter, so its result table is engine context only.

From the repository root, with Bun dependencies installed:

```bash
bun install --frozen-lockfile
(cd packages/router && bun run typecheck)
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts \
  taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
taskset -c 20-25 nice -n 10 python3 \
  docs/pr-assets/agent-router-fix-validation-rollback/audit.py \
  --baseline 12b7edb --out /tmp/router-validation-audit
python3 docs/pr-assets/agent-router-fix-validation-rollback/render.py
```

The audit exports baseline router source into a disposable snapshot, copies candidate source
into a separate snapshot, installs identical fixtures/tests in both and links their local
package dependencies. It never starts a bridge or contacts a routing service. Use a fresh
output directory each time. The source hashes identify the measured bytes independently of
the recorded pre-evidence candidate HEAD.

Full native engine context, using an unchanged engine checkout:

```bash
timeout 2400 taskset -c 20-25 nice -n 10 python3 \
  benchmarks/autorouter/benchmark.py --router fab-router \
  --fab-router-source /home/hyper/bench/wt/fr-bugs \
  --out /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c56-native-full
python3 docs/pr-assets/agent-router-fix-validation-rollback/summarize-native.py \
  --before /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c1-before-full \
  --after /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c56-native-full \
  --engine-source /home/hyper/bench/wt/fr-bugs \
  --out docs/pr-assets/agent-router-fix-validation-rollback/native.json
```

The historical reference used engine 69cf598 on the same host and cores with three repeats
per frozen case. The candidate engine checkout is the evidence branch at 08f5fdf; its engine
source is identical. `summarize-native.py` requires complete sweeps, compares source and frozen
control hashes, and verifies every outcome, via count and track length before producing JSON.

Follow-up ownership coverage: [ownership/README.md](ownership/README.md) records a separate
three-repeat comparison against c332543 for dangling-copper cleanup and commit-message
relabeling. Both now share the validation-error path's commit-ID check. The earlier audit
above retains its original measured source hashes; ownership/audit.json identifies the
follow-up source bytes and new regression tests.
