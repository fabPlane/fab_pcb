# Matching thermal-tools pin and measured pipeline

Pin: `69cf598db98c136bff16bbe02bccdded95674b18` → `e411a8ae7612bce9b20a0d65b89da4b3204d70d2`. All routing `src/` bytes are identical. The optional helper explicitly selects the matching tool directory. Default routing does not invoke thermal search.

Fresh matched runs on `hyper-ms-lin`, cores 20–25, all 26 cases × seeds 1/2/3 per phase, native version 10.0.6. Both use the optional post-import adapter from [integration PR #50](https://github.com/fabPlane/fab_pcb/pull/50). Before selects tools from `9ce6f136`; after selects `e411a8ae`. Only the proposal-generator implementation differs. All routing source, frozen inputs/settings/checker/runtime, and all 78 DSN/SES outputs match byte-for-byte. Candidate ran first, then the fresh control.

| Scope | Before passes | After passes | Before new errors | After new errors | Opens before → after |
|---|---:|---:|---:|---:|---:|
| All 26 cases | 42/78 | 45/78 | 24 | 18 | 120 → 120 |
| J2small | 0/3 | 3/3 | 6 | 0 | 0 → 0 |
| J4 | 3/3 | 3/3 | 0 | 0 | 0 → 0 |
| Aquarius | 0/3 | 0/3 | 18 | 18 | 45 → 45 |

Valid cases (3/3): **14 → 15**. The three J2-small seeds each remove two thermal errors with zero opens and zero lost source or routed terminal pairs. Existing J4 repairs remain successful. No other case outcome, fidelity check, warning or native policy regresses.

Observed median total route-path time: **7.737 → 8.127 s**. Search/validation is included. J2-small median route-path time rises 23.114 → 112.915 s; each repair checks 38 proposals. Required checks overlapped the initial candidate attempts, so these observations do not establish an engine-speed comparison. Aggregate track length changes 58813.130 → 58825.733 mm; vias 2826 → 2826.

This is an opt-in pipeline gain. Default routing does not invoke the search. Its last retained complete run remains 39/78 passes, 13 valid cases, 120 opens and 27 new thermal errors; no fresh default-routing gain is claimed. The optional candidate still has 120 opens and 18 new thermal errors, all on Aquarius. Twelve strict pad-inventory failures and three source-connectivity rejections retain their exact original outputs. No frozen case, checker, scoring, clearance rule, stall or recovery function changes.

Validation: engine typecheck/layer checks and 911 tests pass (398,720 assertions); integration typecheck and 109 tests pass, six existing availability skips. The prototype initially parsed every net as numeric and failed on quoted native net names. Its benchmark and test runs were stopped with exit 143, retained in the archive, corrected, and restarted in fresh directories; final checks and both complete scored runs exit 0. No measured attempt is omitted. Candidate started on dirty parent 9ce6f136; its measured executable hashes match committed e411a8ae throughout. Committing unchanged bytes during the run changes metadata only; source-hash equality is independently checked.

```sh
# Engine checkout contains e411a8ae7612bce9b20a0d65b89da4b3204d70d2.
# Integration checkout contains PR #50 and its private native benchmark runtime.
mkdir /tmp/c204-before-engine
(cd /home/hyper/bench/wt/fr-bugs && git archive 9ce6f136 src tools package.json tsconfig.json LICENSE) | tar -x -C /tmp/c204-before-engine
cd /home/hyper/bench/wt/fp-bugs
python3 packages/router/bench/native-thermal-config.py --engine /tmp/c204-before-engine --out /tmp/c204-before-config
python3 packages/router/bench/native-thermal-config.py --engine /home/hyper/bench/wt/fr-bugs --out /tmp/c204-after-config
 taskset -c 20-25 nice -n 10 timeout --kill-after=10s 10800s python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --config-dir /tmp/c204-before-config --out /tmp/c204-before
 taskset -c 20-25 nice -n 10 timeout --kill-after=10s 10800s python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --config-dir /tmp/c204-after-config --out /tmp/c204-after
cd /home/hyper/bench/wt/fr-bugs
bun run typecheck
bun run check:layers
bun run test
# Integration package, using that same implementation:
cd /home/hyper/bench/wt/fp-bugs
env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs bun run --cwd packages/router typecheck
env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs bun run --cwd packages/router test
```

Complete boards/rules/native reports/proposals/bundles, licenses, old tools snapshot and interrupted attempts: [engine evidence](https://github.com/fabPlane/fab_router/blob/agent/fab-router-native-drc-gate/docs/pr-assets/agent-fab-router-native-drc-gate/c204-imported-copper/README.md).
