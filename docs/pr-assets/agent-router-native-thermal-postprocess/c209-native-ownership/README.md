Add an opt-in native post-import thermal repair step through a copied benchmark configuration. Freeze source/routed boards and rules, retain every attempt and fallback, and replace only an exclusively owned disposable output with an exact accepted bundle. Default configuration and live-editor behavior stay unchanged.

The engine pin now selects `4ae389a2a83dc612ef471d8d83c9630ba352c7c2`, adding a native load/save copper ownership guard and requiring rejection of an unsafe reduced axial candidate. All routing src/ files remain byte-identical to prior pin cc1bc212; its gate tools are executable-identical to the measured before version dbb20f0e.

The optional native acceptance gate could publish a submitted track on one signal net even though native loading silently assigned it to another. Both native reports could contain zero errors and zero opens, and connected-terminal checks could still pass. A new outlined, one-pad/one-segment regression fails against the prior gate because it accepts this candidate.

The gate now compares submitted and native-saved physical copper inventories for the input, candidate and optional routed board. Legacy numeric codes resolve through each board's net table before comparison with current named nets. Track/arc/via ownership, multiplicity and physical fields must match. A mismatch rejects acceptance, intermediate thermal progress and bundle publication. Caller files remain unchanged. UUIDs and native-added manufacturing/display defaults are outside this comparison; it is not a complete native-save fidelity proof.

The same guard explicitly rejects the unsafe complete-board detour discovered in the ground-connectivity diagnostic. This change does not edit routing, stall/recovery functions, frozen inputs, scoring, the checker or native rules.

Measured on hyper-ms-lin, affinity20–25, native10.0.6. Same outlined fixtures, three fresh repeats per version and fixture (12 synthetic gate checks plus six three-board checks of the retained axial candidate):

| Native regression | Before | After | Errors / opens in every check |
|---|---:|---:|---:|
| Unsafe track accepted | 3/3 | 0/3 | 0 / 0 |
| Matching-net control accepted | 3/3 | 3/3 | 0 / 0 |
| Previously published axial detour accepted | 3/3 | 0/3 | 0 / 110 |

The previously published reduced axial candidate is also unsafe: native loading changes all three detour tracks from the C1 net to the R1 net. The earlier report-only repair interpretation is withdrawn. Its old test expected publication and failed against the stronger guard; it now requires rejection, no intermediate progress, no bundle, and explicit ownership-change evidence despite clean reports and preserved source/routed pairs. No acceptance rule is relaxed. All six bounded proposals are refused: three change native ownership despite clean reports; three preserve ownership but retain the thermal.

A separate fresh native-save audit checks the SAME retained complete optional-pipeline corpus: all78 final boards, all78 original routed boards and26 distinct source boards. All182 physical/ownership inventories match, including all six existing repaired outputs. This is an added rejection guard and no audited corpus board triggers it. The audit is native-only; routing and the complete acceptance pipeline were not rerun this cycle.

Fresh re-execution of all six previously successful repair searches uses the same retained source/routed snapshots (two affected cases × three seeds). All six publish byte-identical candidates, with the same proposal counts: 38 for each two-thermal case and one for each single-thermal case. Every accepted intermediate preserves native ownership; all final boards have zero errors, zero opens and zero lost source/routed pairs. This measures native postprocessing without rerouting the corpus.

| Retained valid repairs, same inputs | Before | After guard |
|---|---:|---:|
| Successful complete-board searches | 6/6 | 6/6 |
| Candidate hashes matching prior outputs | 6/6 | 6/6 |
| Added ownership mismatches in accepted checkpoints | 0 | 0 |

Latest complete paired fab_router benchmark (retained cycle206,26cases×seeds1/2/3 per version, same machine/settings):

| Complete optional pipeline | Before axial proposals | After axial proposals |
|---|---:|---:|
| Passed runs | 45/78 | 45/78 |
| Cases passing3/3 | 15/26 | 15/26 |
| Opens | 120 | 120 |
| New thermal errors | 18 | 18 |

The default pipeline's last fresh result remains39/78 passes,13/26 cases,120opens,27new errors. Neither full result is fresh for this guard change. Complete Aquarius remains unresolved (six thermals and348lost source pairs per seed). The optional repairs have measurable cost: the earlier imported-copper fix raised the J2small median route path from23.11s to112.91s; no speed gain is claimed. Engine source under src/ is unchanged by the optional tools. This opt-in adapter depends on engine PR44; placement precision is separately reviewed in PR45/48.

Reproduce the regressions and required checks from the engine repository root:

```sh
taskset -c 20-25 nice -n 10 bun test test/native-saved-copper.test.ts test/native-copper-inventory.test.ts
taskset -c 20-25 nice -n 10 bun test test/native-aquarius-connectivity.test.ts --timeout 180000
taskset -c 20-25 nice -n 10 bun run typecheck
taskset -c 20-25 nice -n 10 bun run check:layers
taskset -c 20-25 nice -n 10 bun run test
mkdir /tmp/c209-replay
tar -xJf docs/pr-assets/agent-fab-router-native-drc-gate/c209-native-ownership/native-evidence.tar.xz -C /tmp/c209-replay
python3 /tmp/c209-replay/verify.py /tmp/c209-replay
```

The archive retains old tools, exact submitted/saved boards, sidecars, licenses, 183 saved-board reports, eighteen paired gate validations, all six valid repair traces and the refused six-proposal search, measurement/replay scripts and logs. The independently implemented Decimal inventory replay does not use the production comparison. Earlier complete scored runs and reproduction commands remain in [cycle206 evidence](https://github.com/fabPlane/fab_router/blob/agent/fab-router-native-drc-gate/docs/pr-assets/agent-fab-router-native-drc-gate/c206-axial-thermal/).

![Native ownership guard before and after](https://github.com/fabPlane/fab_pcb/blob/agent/router-native-thermal-postprocess/docs/pr-assets/agent-router-native-thermal-postprocess/c209-native-ownership/comparison.png?raw=true)

To run a new paired complete optional-pipeline benchmark (new output paths required):

```sh
cd /home/hyper/bench/wt/fr-bugs
mkdir /tmp/c209-before-engine
git archive dbb20f0e src tools package.json tsconfig.json LICENSE | tar -x -C /tmp/c209-before-engine
cd /home/hyper/bench/wt/fp-bugs
python3 packages/router/bench/native-thermal-config.py --engine /tmp/c209-before-engine --out /tmp/c209-before-config
python3 packages/router/bench/native-thermal-config.py --engine /home/hyper/bench/wt/fr-bugs --out /tmp/c209-after-config
taskset -c 20-25 nice -n 10 timeout --kill-after=10s 7200s python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --config-dir /tmp/c209-before-config --out /tmp/c209-before
taskset -c 20-25 nice -n 10 timeout --kill-after=10s 7200s python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --config-dir /tmp/c209-after-config --out /tmp/c209-after
```

Required checks pass: engine typecheck, 65 files with zero layer violations, 920 tests / 398812 assertions / zero failures (923.68s); integration typecheck, 109 passed / six existing availability skips / zero failures / 416 assertions (25.45s) after selecting the final pin. The initial engine run had 919 passes and one failure because the prior axial test expected unsafe publication; its complete failure log and the stronger corrected regression are retained. An initial pin-preparation command used the integration repository revision and failed a cross-repository diff; the pin was immediately corrected, never committed incorrectly, and stable-pin checks were repeated. No native measurement attempt was omitted.

Integration checks after pinning:

```sh
cd /home/hyper/bench/wt/fp-bugs
taskset -c 20-25 nice -n 10 env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs bun run --cwd packages/router typecheck
taskset -c 20-25 nice -n 10 env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs bun run --cwd packages/router test
```

[Engine PR44 and complete native evidence](https://github.com/fabPlane/fab_router/pull/44). No frozen input, checker, scoring or adapter behavior changes in this pin update.
