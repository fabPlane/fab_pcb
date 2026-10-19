# Cycle 203 native post-import evidence

| Scope | Before passes | After passes | Before new errors | After new errors | Opens before → after |
|---|---:|---:|---:|---:|---:|
| All 26 cases | 39/78 | 42/78 | 27 | 24 | 120 → 120 |
| J2small | 0/3 | 0/3 | 6 | 6 | 0 → 0 |
| J4 | 0/3 | 3/3 | 3 | 0 | 0 → 0 |
| Aquarius | 0/3 | 0/3 | 18 | 18 | 45 → 45 |


This is the complete 26-case single-engine subset, three seeds per phase, not a five-engine comparison. Candidate and control completed with exit 0 and preserved controls. Implementation: `9a780d2`; engine/tools: `9ce6f1368e1b4308c71f76d2a42e578df409c3f7`. Candidate ran before control. Required tests overlapped initial candidate attempts; observed time is not an engine-speed comparison.

`native-pipeline-evidence.tar.xz` contains both complete run directories (inputs/outputs, configuration, manifests, native reports, every generated/checked repair proposal, bundles, logs and HTML/SVG), source-board licenses, and the minimal text-only UUID proposal diagnostic. No failed search or scored attempt is omitted. `fallback-summary.json` retains all 18 fallback classifications; `j2small-uuid-audit.json` identifies the 163 reidentified authored segments and the first blocked proposal. The minimal diagnostic is not a loadable native-board fixture or a native DRC proof.

Replay from a fresh directory:

```sh
mkdir /tmp/c203-replay
tar -xJf native-pipeline-evidence.tar.xz -C /tmp/c203-replay
python3 verify.py /tmp/c203-replay
cmp comparison.json /tmp/c203-replay/comparison.json
```

The independent replay checks all 78 paired controls/outcomes, exact DSN/SES equality, unchanged warnings/fidelity/policy, unchanged copper metrics outside repairs, exact bundle hashes and published bytes, and exact original-output preservation for all fallbacks. `manifest.json` covers the public artifact files. `provenance.json` records measured source hashes and setup limitations. Initial unsupported checker override failed one existing setup test; final package/native checks pass 109 tests with six existing skips. Engine checks pass 910 tests. Original rule bytes retain their blank final line.

Fresh routing reproduction (run from integration repository, native runtime installed):

```sh
# Run from the integration repository with its native benchmark runtime installed.
# Engine checkout: 9ce6f1368e1b4308c71f76d2a42e578df409c3f7 (native-search dependency).
python3 packages/router/bench/native-thermal-config.py \
  --engine /home/hyper/bench/wt/fr-bugs --out /tmp/c203-native-config
 taskset -c 20-25 nice -n 10 python3 benchmarks/autorouter/benchmark.py \
  --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs \
  --out /tmp/c203-control
 taskset -c 20-25 nice -n 10 python3 benchmarks/autorouter/benchmark.py \
  --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs \
  --config-dir /tmp/c203-native-config --out /tmp/c203-candidate
 env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts \
  FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs \
  bun run --cwd packages/router typecheck
 env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts \
  FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs \
  bun run --cwd packages/router test
# In that exact engine checkout:
(cd /home/hyper/bench/wt/fr-bugs && bun run typecheck && bun run check:layers && bun run test)
```

The candidate preserves 120 opens and retains 24 native errors. J4 improves 0/3 → 3/3, J2-small/Aquarius remain unresolved. Median route-path time 1.125 → 8.676 s includes native validation/search. Additional total copper length is 3.808199 mm across the three repairs; via counts are unchanged. Source and current routed terminal pairs are preserved for every accepted repair. Default engine settings/pin and live-editor behavior are unchanged.
