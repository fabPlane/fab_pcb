Exposes optional boolean `extra.localRecovery` and advances the proposed engine pin to `a3a2d38ddea104e4dff4fec8551d27260710a718`. Recovery remains **off by default**. The latest engine increment reuses the existing allocation-free rim traversal, preserving exact predicates, probe order, physical rules, widths, lattice and search settings. Engine review: https://github.com/fabPlane/fab_router/pull/37 .

This latest measurement compares the previous proposed pin `b65bcf03945ca2aa9704b2e196e089f0aaa60a8d` against the new pin. The measured control at `49bfc72a` has identical production/spec/test/tool/package/config files to that previous pin; the source parity audit is retained. Only rim traversal changes in production, with its differential test added.

Same frozen **26 cases × 3 repeats**, same host, cores 12–19/nice 10, candidate sweep then control sweep, identical enabled recovery settings, no overlapping own heavy jobs. All 78 paired sessions, statistics and reports except wall time match. Quality does not regress: **48/78 pass, 90 opens and 27 known native thermal errors in both**. Those errors remain unresolved. Observed total route time falls **10.44%**, overall median 1.63%, p95 1.58% and sweep wall 8.77%. Only 12/26 case medians and 18/26 case p95 improve. Shared-host timing is observational, not a universal or causal speed guarantee.

| Full native metric (26 cases × 3 repeats) | Current control | Allocation-free rim traversal |
| ----------------------------------------- | --------------: | ----------------------------: |
| Passed / 78                               |              48 |                            48 |
| Valid cases / 26                          |              16 |                            16 |
| Opens                                     |              90 |                            90 |
| New native errors (known, unresolved)     |              27 |                            27 |
| Median route seconds                      |        1.220020 |                      1.200097 |
| p95 route seconds                         |       16.129187 |                     15.875130 |
| Sum route seconds                         |      427.290283 |                    382.683507 |
| Sweep wall seconds                        |      544.211810 |                    496.500959 |
| Sum case medians seconds                  |      140.071084 |                    127.479959 |
| Sum case p95 seconds                      |      151.150245 |                    135.065826 |
| Sum vias                                  |            2826 |                          2826 |
| Sum length mm                             |    60450.378202 |                  60450.378202 |

![Per-case timing, including regressions](https://github.com/fabPlane/fab_pcb/blob/agent/router-perf-public-recovery/docs/pr-assets/agent-router-perf-public-recovery/rim-composition/timings.png?raw=true)

Dense6 uses three alternating pairs: identical geometry, 181 opens and zero new native errors each; median 179.118→171.912s, p95 182.034→173.470s. L2/L3 use one engine-only pair each, with identical sessions/statistics/reports except wall and no added represented-rule violations. L2 improves 18.213→17.185s; **L3 regresses 157.884→170.824s (+8.20%)**. These custom checks are outside the frozen-suite score.

Engine typecheck/layers and 914 tests pass. Consumer package typecheck and the focused unit suite pass (97 tests, one optional-runtime skip), using the local engine through `FAB_ROUTER_MODULE`; native editor integration is excluded. The initial attempt without the override failed because the router package was not installed locally; that setup log is retained. The source-override benchmark measures the standalone export/import and engine API. It does not prove this package's exporter or live-editor latency improves.

Prior limitations remain: standalone cache speed benefit is unsupported, earlier ring stress timings were adverse, and a historical 300-second slow case increased 18→19 incompletes before six fresh isolated checks returned 18 throughout. The cause is unproven; the whole 63-case slow suite is not rerun in this cycle. Prior negative evidence remains linked in the engine report.

Reproduce the native pair, engine gates, profiles and dense/ladder checks with the prepared private benchmark runtime:

```bash
ENGINE=/home/hyper/bench/wt/fr-perf
ASSET="$ENGINE/docs/pr-assets/agent-fab-router-perf-local-rescue/rim-composition"
RUN=/home/hyper/bench/agents/codex-fabpcb-perf/scratch/rim-composition-repro
python3 "$ASSET/prepare-repro.py" "$ENGINE" "$RUN" 49bfc72a a3a2d38ddea104e4dff4fec8551d27260710a718
python3 "$RUN/native.py"
python3 "$RUN/checks.py"
python3 "$RUN/stress.py"
python3 "$ASSET/verify.py"
python3 "$ASSET/verify-dense.py"
```

Consumer checks:

```bash
cd /home/hyper/bench/wt/fp-perf/packages/router
python3 /home/hyper/bench/wt/fp-perf/docs/pr-assets/agent-router-perf-public-recovery/rim-composition/check-package.py --engine-source /home/hyper/bench/wt/fr-perf
```

[Per-case median/p95 table](https://github.com/fabPlane/fab_pcb/blob/agent/router-perf-public-recovery/docs/pr-assets/agent-router-perf-public-recovery/rim-composition/table.md). [Complete source inventories, native records, profiles, stress outputs, exact reproduction and prior caveats](https://github.com/fabPlane/fab_router/blob/agent/fab-router-perf-local-rescue/docs/pr-assets/agent-fab-router-perf-local-rescue/rim-composition/README.md).
