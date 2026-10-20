Adds an opt-in native thermal-repair postprocessor after session import, with copied benchmark configuration. The default benchmark, live editor and native acceptance/scoring remain unchanged. Checked snapshots replace disposable output atomically; declined or failed searches retain the original output and all failure evidence. Source/current terminal pairs, ownership, copper, pads, zones, rules and open budgets remain protected.

This update selects engine commit `7e56b09f221dff426670547c6e0390891be4c1d8` from https://github.com/fabPlane/fab_router/pull/44. Its bounded offline generator can now move generated vias together with their incident track endpoints, after all prior track proposals and within the same 304-proposal stage budget. It refuses protected incident copper, foreign-net/stacked-via/arc contacts, and excludes authored/reidentified vias. The native gate still decides acceptance.

Three fresh comparisons on the retained complete-power control produce the same safe generated repair: one thermal error becomes zero, with 95 opens and zero lost source/current pairs. The complete standalone automatic search checks 169 proposals and publishes the exact accepted bundle. This partial control is not a completed route. Its standalone snapshot-to-result interval was 2144.2 seconds under concurrent verification, exceeding the adapter's unchanged 600-second cap; no within-cap recovery is claimed. The full Aquarius board still fails the frozen benchmark; its automatic search stops at the existing source-pad precision preflight failure. Separate retained diagnostics also show source-connectivity losses, which must be fixed without weakening either guard.

| Same host, cases, rules, 26 cases × 3 seeds per version | Previous pin | New pin |
| --- | --- | --- |
| Passing runs | 45/78 | 45/78 |
| Cases passing 3/3 | 15/26 | 15/26 |
| Total opens | 120 | 120 |
| New native thermal errors | 18 | 18 |

Both opt-in corpus runs are fresh on hyper-ms-lin, cores 20–25, with the frozen native 10.0.6 checker, identical inputs/runtime/settings/order/seeds and configurations differing only by engine checkout. The before engine's executable src/tools exactly match previous pin `a8f7762467b97863032a55e3b924dfd199456dac`. All 78 outcomes/fidelity/physical copper/DSN/session comparisons and postprocess dispositions match. The six prior optional repairs retain their successful check sequences and checkpoint geometry. No speed or scored routing gain is claimed. The latest retained default run remains 39/78 passing, 13/26 valid, 120 opens and 27 thermals; default routing was not rerun for this update.

Validation: package typecheck and all 109 package tests pass, with six existing native-server/jar availability skips. The engine's typecheck, layer check and 933 tests pass. Two initial candidate benchmark launches were refused by the exclusive run lock before any routing attempt; logs are retained. Both final corpus runs exit zero with all 78 attempts checked. The image shows the partial power-net control, not a repaired full Aquarius board.

Reproduce from this integration checkout with engine checkouts at the old/new pins and fresh output paths:

```bash
python3 packages/router/bench/native-thermal-config.py --engine /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c218/before-control --out /tmp/c218-pin-before-configs
taskset -c 20-25 nice -n 10 timeout 7200 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c218/before-control --config-dir /tmp/c218-pin-before-configs --out /tmp/c218-pin-before
python3 packages/router/bench/native-thermal-config.py --engine /home/hyper/bench/wt/fr-bugs --out /tmp/c218-pin-after-configs
taskset -c 20-25 nice -n 10 timeout 7200 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --config-dir /tmp/c218-pin-after-configs --out /tmp/c218-pin-after
cd packages/router
env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs taskset -c 20-25 nice -n 10 bash -c 'bun run typecheck && bun run test'
```

Run the before/after benchmark commands sequentially due to the harness lock, using fresh config/output paths. The before control at a6da80a1 is executable-identical to the previous pin; the engine evidence records its worktree creation command. Exact before/after commands, all raw corpus/native evidence, source hashes, original rules/licenses and independent replay are in the [engine evidence](https://github.com/fabPlane/fab_router/tree/agent/fab-router-native-drc-gate/docs/pr-assets/agent-fab-router-native-drc-gate/c218-generated-via). This update's compact integration evidence is under `docs/pr-assets/agent-router-native-thermal-postprocess/c218-generated-via/`.

![Generated via repair on the partial power-net control](https://github.com/fabPlane/fab_pcb/blob/agent/router-native-thermal-postprocess/docs/pr-assets/agent-router-native-thermal-postprocess/c218-generated-via/comparison.png?raw=true)
