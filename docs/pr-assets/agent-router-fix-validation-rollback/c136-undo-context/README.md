# Report uncertain route state after undo transport failures

The existing ownership guard already refused another commit. Its direct cleanup
and relabel paths surfaced raw history/undo transport failures, omitting that
tentative route copper could remain in live memory. Add that recovery context to
every helper failure while retaining the original message and Error cause. The
same ownership check, undo count, stopping behavior and copper remain unchanged.

Eight simulated job scenarios cover cleanup/relabel with matching ownership,
a foreign edit, history transport failure, and undo transport failure. The last
four cases fail the new reporting assertion on base 59d5893; no unsafe undo or
routing improvement is claimed. Three repeats/source on hyper-ms-lin, cores20–25:

| Measurement | Before | After |
| --- | ---: | ---: |
| Ownership/context scenarios passing each repeat | 4/8 | 8/8 |
| Full engine native passes (26 cases × 3) | 39/78 | 39/78 |
| Cases passing all three native repeats | 13/26 | 13/26 |
| Native opens / new errors | 120 / 27 | 120 / 27 |

The native comparison uses c133 and c136 engine runs, both on cores20–25. All
78 outcome, DRC type, fidelity, via and length fields match. The standalone
harness does not exercise this adapter or its diagnostic change. All27 errors
remain starved thermals. Read+undo remain separate commands; no atomic native
refill/rollback or live editor validation is established.

Configured unit validation:155pass,1skip,0fail. Package typecheck passes.
Unchanged engine:typecheck/layers/859tests pass. Initial main-only duplicate
ownership implementation was rejected after discovering this existing PR; its
14-case measurements are not published as new work. An initial unconfigured
all-file test attempt failed missing runtime and local API-server requirements;
configured unit tests pass, live editor tests remain unverified.

Reproduce from this PR in a disposable checkout with dependencies installed:

```bash
for repeat in 1 2 3; do
  taskset -c 20-25 bun test packages/router/test/bridge-undo-ownership.test.ts
done
git show 59d5893:packages/router/src/bridge-job.ts > packages/router/src/bridge-job.ts
for repeat in 1 2 3; do
  taskset -c 20-25 bun test packages/router/test/bridge-undo-ownership.test.ts
done
# The base should fail four reporting assertions each repeat.
git restore packages/router/src/bridge-job.ts
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
(cd packages/router && taskset -c 20-25 bun run typecheck)
taskset -c 20-25 nice -n 10 timeout 1800 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --out /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c136/native-full
python3 docs/pr-assets/agent-router-fix-validation-rollback/c136-undo-context/unpack-native.py /tmp/route-context-native
python3 docs/pr-assets/agent-router-fix-validation-rollback/c136-undo-context/compare-native.py --before /tmp/route-context-native/before --after /tmp/route-context-native/after --out /tmp/route-context-native/comparison.json
```

The compressed files retain exact results/summary/controls/config bytes. Source
and test hashes are in regression-provenance.json; raw native boards/checks remain
in the cycle scratch directory. No frozen cases/checker/scoring/pin changed.
