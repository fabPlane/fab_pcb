Keep native thermal recovery opt-in and pin its engine to `0cfcfce2d601561a731a7102317f490aa8c5bf73`. The previous offline search evaluated 168 track candidates before its first connected via move; its retained 2144.2-second search exceeded the postprocessor's unchanged 600-second limit. The selected engine now probes one connected via move after six track detours. All candidate board bytes and every other candidate's relative order remain unchanged. Native DRC, source/current connectivity, ownership, fidelity and atomic checked-bundle application gates are unchanged.

| Same host, cases and rules                                            | Before                                                 | After                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------- |
| Partial power-net control: checked candidates                         | 169 (1 retained run)                                   | 7 in each of 3 fresh repeats          |
| Partial control: search seconds                                       | 2144.2 (retained)                                      | 153.1, 163.8, 186.7                   |
| Partial control: new thermals / opens / lost source and current pairs | 0 / 95 / 0 and 0 after eventual repair                 | 0 / 95 / 0 and 0 in all repeats       |
| Actual postprocessor, partial control                                 | Prior search exceeds cap; no prior adapter run claimed | Applied, exit 0, 183.5s (1 fresh run) |
| Full opt-in corpus, 26 cases × 3 seeds: passes                        | 45/78                                                  | 45/78                                 |
| Full opt-in corpus: cases passing 3/3                                 | 15/26                                                  | 15/26                                 |
| Full opt-in corpus: opens / new errors                                | 120 / 18                                               | 120 / 18                              |

Before corpus is retained cycle 218 at `7e56b09f`; after is fresh this cycle. Same machine, cores 20–25, seeds/settings/order/inputs/runtime/native checker. All 78 outcomes and physical copper match; all six optional repairs retain the same accepted checkpoints. Corpus median time increased from 8.331 to 9.459 seconds under concurrent verification on a shared host; no general routing speed gain is claimed. The partial control still has 95 opens: this is within-cap recovery evidence, not a completed task or a corpus score gain. Full Aquarius still fails; source-pad precision and full-board source connectivity remain blockers. Default routing is unchanged and was not rerun; latest retained default full result is 39/78 passes, 13/26 valid, 120 opens and 27 thermal errors.

Engine typecheck, layer check and all 933 tests pass. Integration package typecheck and 109 tests pass with six existing availability skips. The old generator fails the new native ordering assertion before implementation. Independent replay recomputes source/current pair losses, candidate/report hashes and strict progress, proves identical proposal boards and confirms the actual adapter applied the exact checked bundle while preserving source and rule snapshots.

Reproduce from the integration checkout:

```bash
cd packages/router
env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs taskset -c 20-25 nice -n 10 bash -c 'bun run typecheck && bun run test'
cd ../..
python3 packages/router/bench/native-thermal-config.py --engine /home/hyper/bench/wt/fr-bugs --out /tmp/c219-pin-configs
taskset -c 20-25 nice -n 10 timeout 7200 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --config-dir /tmp/c219-pin-configs --out /tmp/c219-pin-results
```

The candidate engine is the pinned commit. The retained before run and its exact inputs are included in [engine PR44 evidence](https://github.com/fabPlane/fab_router/tree/agent/fab-router-native-drc-gate/docs/pr-assets/agent-fab-router-native-drc-gate/c219-via-order), along with original native fixtures, complete fresh outputs, all proposals/reports/bundles, failure-first log and replay scripts. The image reuses cycle 218 native geometry because the accepted board is byte-identical; labels explain the new ordering.

![Same safe thermal repair reached within the unchanged limit](https://github.com/fabPlane/fab_pcb/blob/agent/router-native-thermal-postprocess/docs/pr-assets/agent-router-native-thermal-postprocess/c219-via-order/comparison.png?raw=true)
